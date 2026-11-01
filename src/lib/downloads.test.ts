import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Episode } from './types';

const backend = vi.hoisted(() => ({ fetchAndStore: vi.fn(), attach: vi.fn(), running: vi.fn() }));
vi.mock('./db', () => ({ getDownload: vi.fn(async () => undefined), listDownloads: vi.fn(async () => []) }));
vi.mock('./api', () => ({
  getEpisodeMetadata: vi.fn(),
  requestServerDownload: vi.fn(async () => {}),
  serverStreamUrl: vi.fn(() => 'https://s/stream'),
}));
vi.mock('./downloadBackend', async (orig) => ({
  ...(await orig<typeof import('./downloadBackend')>()),
  getDownloadBackend: () => backend,
}));

import { requestServerDownload } from './api';
import { DownloadCancelledError, DownloadFetchError } from './downloadBackend';
import { downloadEpisode, getDownloadProgress, resumeDownloads } from './downloads';

const account = { id: 'a' } as Account;
const episode = { episodeid: 7, episodeurl: 'https://x/y.mp3' } as Episode;

describe('downloadEpisode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns quietly on a cancel, without the server fallback, and cleans up', async () => {
    backend.fetchAndStore.mockRejectedValueOnce(new DownloadCancelledError());
    await expect(downloadEpisode(account, episode)).resolves.toBeUndefined();
    expect(backend.fetchAndStore).toHaveBeenCalledTimes(1);
    expect(requestServerDownload).not.toHaveBeenCalled();
    expect(getDownloadProgress(7)).toBeUndefined();
  });

  it('still falls back to the server on a fetch failure', async () => {
    backend.fetchAndStore.mockRejectedValueOnce(new DownloadFetchError('x'));
    backend.fetchAndStore.mockResolvedValueOnce({});
    await downloadEpisode(account, { ...episode, downloaded: true } as Episode);
    expect(backend.fetchAndStore).toHaveBeenCalledTimes(2);
  });
});

describe('resumeDownloads', () => {
  beforeEach(() => vi.clearAllMocks());

  const pendingFor = (accountId: string, episodeid: number, downloaded = false) => ({
    key: `${accountId}:${episodeid}`,
    accountId,
    episode: { episodeid, episodeurl: `https://x/${episodeid}.mp3`, downloaded } as Episode,
  });

  it('follows each running download of a known account, showing progress until stored', async () => {
    let finish!: () => void;
    backend.running.mockResolvedValue([pendingFor('a', 21), pendingFor('gone', 22)]);
    backend.attach.mockImplementation(async (_p, onProgress: (f?: number) => void) => {
      onProgress(0.4);
      await new Promise<void>((r) => (finish = r));
      return {};
    });

    await resumeDownloads([account]);
    await vi.waitFor(() => expect(backend.attach).toHaveBeenCalledTimes(1));
    expect(backend.attach).toHaveBeenCalledWith(pendingFor('a', 21), expect.any(Function));
    expect(backend.fetchAndStore).not.toHaveBeenCalled();
    expect(getDownloadProgress(21)).toMatchObject({ phase: 'fetching', fraction: 0.4 });
    expect(getDownloadProgress(22)).toBeUndefined();

    // Asked again (back in the foreground) while it is still followed: no second poller.
    await resumeDownloads([account]);
    expect(backend.attach).toHaveBeenCalledTimes(1);

    finish();
    await vi.waitFor(() => expect(getDownloadProgress(21)).toBeUndefined());
  });

  it('falls back to the server copy when the followed download fails', async () => {
    // Already on the server, so the fallback streams it from there at once.
    const pending = pendingFor('a', 23, true);
    backend.running.mockResolvedValue([pending]);
    backend.attach.mockRejectedValueOnce(new DownloadFetchError('failed'));
    backend.fetchAndStore.mockResolvedValueOnce({});
    await resumeDownloads([account]);
    await vi.waitFor(() => expect(backend.fetchAndStore).toHaveBeenCalledTimes(1));
    expect(backend.fetchAndStore).toHaveBeenCalledWith('https://s/stream', pending, expect.any(Function));
    await vi.waitFor(() => expect(getDownloadProgress(23)).toBeUndefined());
  });
});
