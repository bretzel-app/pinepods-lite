import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Episode } from './types';

vi.mock('./db', () => ({ putDownload: vi.fn(async () => {}), deleteDownload: vi.fn(async () => {}) }));

import { putDownload } from './db';
import { DownloadFetchError, webDownloadBackend } from './downloadBackend';

afterEach(() => vi.unstubAllGlobals());

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
