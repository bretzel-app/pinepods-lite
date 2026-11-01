import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Episode } from './types';

const backend = vi.hoisted(() => ({ fetchAndStore: vi.fn() }));
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
import { downloadEpisode, getDownloadProgress } from './downloads';

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
