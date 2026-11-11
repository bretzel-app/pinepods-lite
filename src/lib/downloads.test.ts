import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { getEpisodeMetadata, requestServerDownload, serverStreamUrl } from './api';
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

describe('downloadEpisode copy choice', () => {
  beforeEach(() => vi.clearAllMocks());

  it('takes the server copy first when the server has the episode', async () => {
    backend.fetchAndStore.mockResolvedValueOnce({});
    await downloadEpisode(account, { ...episode, downloaded: true } as Episode);
    expect(backend.fetchAndStore).toHaveBeenCalledTimes(1);
    expect(backend.fetchAndStore).toHaveBeenCalledWith(
      serverStreamUrl(account, 7),
      expect.objectContaining({ fromServer: true }),
      expect.any(Function),
    );
  });

  it('takes the publisher copy when the server has none, without fromServer', async () => {
    backend.fetchAndStore.mockResolvedValueOnce({});
    await downloadEpisode(account, episode);
    const [url, pending] = backend.fetchAndStore.mock.calls[0];
    expect(url).toBe('https://x/y.mp3');
    expect(pending.fromServer).toBeUndefined();
  });

  it('marks the server fallback as fromServer', async () => {
    backend.fetchAndStore.mockRejectedValueOnce(new DownloadFetchError('x'));
    backend.fetchAndStore.mockResolvedValueOnce({});
    await downloadEpisode(account, { ...episode, downloaded: true } as Episode);
    expect(backend.fetchAndStore.mock.calls[1][1]).toMatchObject({ fromServer: true });
  });
});

describe('downloadEpisode of a starred episode', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('takes the server copy when the server has it', async () => {
    backend.fetchAndStore.mockResolvedValueOnce({});
    await downloadEpisode(account, { ...episode, saved: true, downloaded: true } as Episode);
    expect(backend.fetchAndStore).toHaveBeenCalledTimes(1);
    expect(backend.fetchAndStore).toHaveBeenCalledWith('https://s/stream', expect.objectContaining({ fromServer: true }), expect.any(Function));
    expect(requestServerDownload).not.toHaveBeenCalled();
  });

  it('never takes the publisher copy: has the server download it, waits, then takes the server copy', async () => {
    // Just starred: the list still says the server doesn't have it.
    vi.useFakeTimers();
    vi.mocked(getEpisodeMetadata)
      .mockResolvedValueOnce({ downloaded: false } as Episode)
      .mockResolvedValueOnce({ downloaded: true } as Episode);
    backend.fetchAndStore.mockResolvedValueOnce({});
    const done = downloadEpisode(account, { ...episode, saved: true, downloaded: false } as Episode);
    await vi.advanceTimersByTimeAsync(3000);
    expect(getDownloadProgress(7)?.phase).toBe('server_downloading');
    expect(backend.fetchAndStore).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    await done;

    expect(requestServerDownload).toHaveBeenCalledWith(account, 7);
    expect(getEpisodeMetadata).toHaveBeenCalledTimes(2);
    expect(backend.fetchAndStore).toHaveBeenCalledTimes(1);
    const [url, pending] = backend.fetchAndStore.mock.calls[0];
    expect(url).toBe('https://s/stream');
    expect(pending.fromServer).toBe(true);
  });

  it('fails rather than fall back to the publisher when the server cannot be asked', async () => {
    vi.mocked(requestServerDownload).mockRejectedValueOnce(new Error('offline'));
    await expect(downloadEpisode(account, { ...episode, saved: true, downloaded: false } as Episode)).rejects.toThrow('offline');
    expect(backend.fetchAndStore).not.toHaveBeenCalled();
    expect(getDownloadProgress(7)).toBeUndefined();
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
    expect(backend.fetchAndStore).toHaveBeenCalledWith(
      'https://s/stream',
      { ...pending, fromServer: true },
      expect.any(Function),
    );
    await vi.waitFor(() => expect(getDownloadProgress(23)).toBeUndefined());
  });
});
