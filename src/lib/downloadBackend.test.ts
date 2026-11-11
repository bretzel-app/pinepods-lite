import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Episode } from './types';

vi.mock('./db', () => ({
  putDownload: vi.fn(async () => {}),
  putDownloadEntry: vi.fn(async () => {}),
  deleteDownload: vi.fn(async () => {}),
}));

const plugin = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  status: vi.fn(),
  finished: vi.fn(),
  running: vi.fn(),
  forget: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  removeByPrefix: vi.fn(async () => {}),
}));
vi.mock('../native/plugins', () => ({ NativeDownloads: plugin, isNative: () => false }));

import { deleteDownload, putDownload, putDownloadEntry } from './db';
import { DownloadCancelledError, DownloadFetchError, nativeDownloadBackend, webDownloadBackend } from './downloadBackend';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('webDownloadBackend.fetchAndStore', () => {
  it('fetches the bytes, stores entry + blob and returns the entry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(10), { headers: { 'Content-Type': 'audio/mpeg' } })),
    );
    const pending = { key: 'a:7', accountId: 'a', episode: { episodeid: 7 } as Episode };
    const onProgress = vi.fn();
    const entry = await webDownloadBackend.fetchAndStore('https://x/y.mp3', pending, onProgress);
    expect(entry).toMatchObject({ key: 'a:7', accountId: 'a', size: 10, mimeType: 'audio/mpeg' });
    expect(putDownload).toHaveBeenCalledWith(entry, expect.any(Blob));
    expect(onProgress).toHaveBeenCalled();
  });

  it('keeps fromServer on the stored web entry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(10))));
    const pending = { key: 'a:7', accountId: 'a', episode: { episodeid: 7 } as Episode, fromServer: true };
    const entry = await webDownloadBackend.fetchAndStore('https://x/y.mp3', pending, vi.fn());
    expect(entry.fromServer).toBe(true);
    expect(vi.mocked(putDownload).mock.calls[0][0].fromServer).toBe(true);
  });

  it('rejects with DownloadFetchError on an HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const pending = { key: 'a:7', accountId: 'a', episode: { episodeid: 7 } as Episode };
    await expect(webDownloadBackend.fetchAndStore('https://x/y.mp3', pending, vi.fn())).rejects.toBeInstanceOf(
      DownloadFetchError,
    );
  });

  it('lets a storage failure propagate unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(10))));
    const quota = new Error('quota');
    vi.mocked(putDownload).mockRejectedValueOnce(quota);
    const pending = { key: 'a:7', accountId: 'a', episode: { episodeid: 7 } as Episode };
    const err = await webDownloadBackend.fetchAndStore('https://x/y.mp3', pending, vi.fn()).catch((e) => e);
    expect(err).toBe(quota);
    expect(err).not.toBeInstanceOf(DownloadFetchError);
  });
});

describe('nativeDownloadBackend', () => {
  const pending = { key: 'a:7', accountId: 'a', episode: { episodeid: 7 } as Episode };

  it('polls status, reports progress, stores the entry and forgets the mapping', async () => {
    vi.useFakeTimers();
    plugin.status
      .mockResolvedValueOnce({ state: 'running', fraction: 0.5 })
      .mockResolvedValueOnce({ state: 'done', filePath: '/f/a_7', mimeType: 'audio/mpeg', size: 99 });
    const onProgress = vi.fn();
    const p = nativeDownloadBackend.fetchAndStore('https://x/y.mp3', pending, onProgress);
    await vi.advanceTimersByTimeAsync(1500);
    const entry = await p;
    expect(plugin.start).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'a:7', url: 'https://x/y.mp3', entry: JSON.stringify(pending) }),
    );
    expect(onProgress).toHaveBeenCalledWith(0.5);
    expect(entry).toMatchObject({ key: 'a:7', filePath: '/f/a_7', mimeType: 'audio/mpeg', size: 99 });
    expect(putDownloadEntry).toHaveBeenCalledWith(entry);
    expect(plugin.forget).toHaveBeenCalledWith({ key: 'a:7' });
  });

  it('rejects with DownloadFetchError on failure and forgets the mapping', async () => {
    vi.useFakeTimers();
    plugin.status.mockResolvedValue({ state: 'failed' });
    const p = nativeDownloadBackend.fetchAndStore('https://x/y.mp3', pending, vi.fn());
    const assertion = expect(p).rejects.toThrow('Download failed');
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    await expect(p).rejects.toBeInstanceOf(DownloadFetchError);
    expect(plugin.forget).toHaveBeenCalledWith({ key: 'a:7' });
    expect(putDownloadEntry).not.toHaveBeenCalled();
  });

  it('recoverFinished stores every finished download and returns the count', async () => {
    const d = (n: number) => ({
      key: `a:${n}`,
      entry: JSON.stringify({ key: `a:${n}`, accountId: 'a', episode: { episodeid: n } }),
      filePath: `/f/a_${n}`,
      mimeType: 'audio/mpeg',
      size: n,
    });
    plugin.finished.mockResolvedValue({ downloads: [d(1), d(2)] });
    expect(await nativeDownloadBackend.recoverFinished()).toBe(2);
    expect(putDownloadEntry).toHaveBeenCalledTimes(2);
    expect(putDownloadEntry).toHaveBeenCalledWith(expect.objectContaining({ key: 'a:1', filePath: '/f/a_1', size: 1 }));
    expect(plugin.forget).toHaveBeenCalledTimes(2);
  });

  it('keeps fromServer through a native download, recovery and running', async () => {
    vi.useFakeTimers();
    const fs = { ...pending, fromServer: true };
    plugin.status.mockResolvedValueOnce({ state: 'done', filePath: '/f/a_7', size: 1 });
    const p = nativeDownloadBackend.fetchAndStore('https://x/y.mp3', fs, vi.fn());
    await vi.advanceTimersByTimeAsync(600);
    expect((await p).fromServer).toBe(true);

    const entry = JSON.stringify(fs);
    plugin.finished.mockResolvedValue({
      downloads: [{ key: 'a:7', entry, filePath: '/f/a_7', mimeType: 'audio/mpeg', size: 1 }],
    });
    vi.mocked(putDownloadEntry).mockClear();
    await nativeDownloadBackend.recoverFinished();
    expect(putDownloadEntry).toHaveBeenCalledWith(expect.objectContaining({ fromServer: true }));

    plugin.running.mockResolvedValue({ downloads: [{ key: 'a:7', entry }] });
    expect((await nativeDownloadBackend.running())[0].fromServer).toBe(true);
  });

  it('removeAccount removes by account prefix', async () => {
    await nativeDownloadBackend.removeAccount('a1');
    expect(plugin.removeByPrefix).toHaveBeenCalledWith({ prefix: 'a1_' });
  });

  it('remove deletes the entry and the native file', async () => {
    await nativeDownloadBackend.remove('a', 7);
    expect(deleteDownload).toHaveBeenCalledWith('a', 7);
    expect(plugin.remove).toHaveBeenCalledWith({ key: 'a:7' });
  });

  it('rejects with DownloadCancelledError when the key disappears', async () => {
    vi.useFakeTimers();
    plugin.status.mockResolvedValue({ state: 'unknown' });
    const p = nativeDownloadBackend.fetchAndStore('https://x/y.mp3', pending, vi.fn());
    const assertion = expect(p).rejects.toBeInstanceOf(DownloadCancelledError);
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
    expect(plugin.forget).toHaveBeenCalledWith({ key: 'a:7' });
  });

  const fin = (key: string, entry: string) => ({ key, entry, filePath: `/f/${key}`, mimeType: 'audio/mpeg', size: 1 });
  const good = (n: number) =>
    fin(`a:${n}`, JSON.stringify({ key: `a:${n}`, accountId: 'a', episode: { episodeid: n } }));

  it('recoverFinished forgets a garbage entry and still recovers a valid one', async () => {
    plugin.finished.mockResolvedValue({ downloads: [fin('a:1', '{nope'), good(2)] });
    expect(await nativeDownloadBackend.recoverFinished()).toBe(1);
    expect(plugin.forget).toHaveBeenCalledWith({ key: 'a:1' });
    expect(putDownloadEntry).toHaveBeenCalledTimes(1);
  });

  it('recoverFinished keeps an entry whose storage failed and recovers the others', async () => {
    plugin.finished.mockResolvedValue({ downloads: [good(1), good(2)] });
    vi.mocked(putDownloadEntry).mockRejectedValueOnce(new Error('quota'));
    expect(await nativeDownloadBackend.recoverFinished()).toBe(1);
    expect(plugin.forget).toHaveBeenCalledTimes(1);
    expect(plugin.forget).toHaveBeenCalledWith({ key: 'a:2' });
  });

  it('attach follows a running download without starting another one', async () => {
    vi.useFakeTimers();
    plugin.status
      .mockResolvedValueOnce({ state: 'running', fraction: 0.25 })
      .mockResolvedValueOnce({ state: 'done', filePath: '/f/a_7', mimeType: 'audio/mpeg', size: 99 });
    const onProgress = vi.fn();
    const p = nativeDownloadBackend.attach(pending, onProgress);
    await vi.advanceTimersByTimeAsync(1500);
    const entry = await p;
    expect(plugin.start).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith(0.25);
    expect(entry).toMatchObject({ key: 'a:7', accountId: 'a', filePath: '/f/a_7', size: 99 });
    expect(putDownloadEntry).toHaveBeenCalledWith(entry);
    expect(plugin.forget).toHaveBeenCalledWith({ key: 'a:7' });
  });

  it('running lists the downloads still in progress, skipping unreadable entries', async () => {
    plugin.running.mockResolvedValue({
      downloads: [
        { key: 'a:1', entry: '{nope' },
        { key: 'a:3', entry: '{"accountId":"a"}' },
        { key: 'a:2', entry: JSON.stringify({ key: 'a:2', accountId: 'a', episode: { episodeid: 2 } }) },
      ],
    });
    expect(await nativeDownloadBackend.running()).toEqual([
      { key: 'a:2', accountId: 'a', episode: { episodeid: 2 } },
    ]);
    expect(plugin.forget).not.toHaveBeenCalled();
  });
});

describe('webDownloadBackend background downloads', () => {
  it('has none to follow', async () => {
    expect(await webDownloadBackend.running()).toEqual([]);
    const pending = { key: 'a:7', accountId: 'a', episode: { episodeid: 7 } as Episode };
    await expect(webDownloadBackend.attach(pending, vi.fn())).rejects.toBeInstanceOf(DownloadCancelledError);
  });
});
