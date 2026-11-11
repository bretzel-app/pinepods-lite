import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from './types';

vi.mock('./api', () => ({
  markEpisodeCompleted: vi.fn(),
  markEpisodeUncompleted: vi.fn(),
  saveEpisode: vi.fn(async () => {}),
  getEpisodeMetadata: vi.fn(),
  requestServerDownload: vi.fn(async () => {}),
}));
vi.mock('./db', () => ({ cacheSet: vi.fn() }));
vi.mock('./downloads', () => ({ removeDownloadedEpisode: vi.fn() }));
vi.mock('./sync', () => ({ runOrQueue: vi.fn() }));

import { getEpisodeMetadata, requestServerDownload, saveEpisode } from './api';
import { starEpisode } from './episodeActions';

const account = { id: 'a' } as Account;
const meta = vi.mocked(getEpisodeMetadata);

describe('starEpisode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('saves, then asks the server to download an episode it lacks', async () => {
    meta.mockResolvedValue({ downloaded: false, is_youtube: false } as never);
    await starEpisode(account, 12);
    expect(saveEpisode).toHaveBeenCalledWith(account, 12);
    expect(requestServerDownload).toHaveBeenCalledWith(account, 12);
  });

  it('does not re-download an episode the server has', async () => {
    meta.mockResolvedValue({ downloaded: true, is_youtube: false } as never);
    await starEpisode(account, 12);
    expect(requestServerDownload).not.toHaveBeenCalled();
  });

  it('ignores YouTube items', async () => {
    meta.mockResolvedValue({ downloaded: false, is_youtube: true } as never);
    await starEpisode(account, 12);
    expect(requestServerDownload).not.toHaveBeenCalled();
  });

  it('a failed download request does not fail the star', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    meta.mockResolvedValue({ downloaded: false, is_youtube: false } as never);
    vi.mocked(requestServerDownload).mockRejectedValueOnce(new Error('boom'));
    await expect(starEpisode(account, 12)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a failed save fails the star so it can be queued', async () => {
    vi.mocked(saveEpisode).mockRejectedValueOnce(new Error('offline'));
    await expect(starEpisode(account, 12)).rejects.toThrow('offline');
    expect(requestServerDownload).not.toHaveBeenCalled();
  });
});
