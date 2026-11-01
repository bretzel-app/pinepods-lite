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
  forget: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  removeByPrefix: vi.fn(async () => {}),
}));
vi.mock('../native/plugins', () => ({ NativeDownloads: plugin, isNative: () => false }));

import { deleteDownload, putDownload, putDownloadEntry } from './db';
import { DownloadFetchError, nativeDownloadBackend, webDownloadBackend } from './downloadBackend';

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

  it('removeAccount removes by account prefix', async () => {
    await nativeDownloadBackend.removeAccount('a1');
    expect(plugin.removeByPrefix).toHaveBeenCalledWith({ prefix: 'a1_' });
  });

  it('remove deletes the entry and the native file', async () => {
    await nativeDownloadBackend.remove('a', 7);
    expect(deleteDownload).toHaveBeenCalledWith('a', 7);
    expect(plugin.remove).toHaveBeenCalledWith({ key: 'a:7' });
  });
});
