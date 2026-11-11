import { describe, expect, it } from 'vitest';
import { normalizeEpisode } from './api';

describe('normalizeEpisode', () => {
  it('reads the flags of list rows', () => {
    const ep = normalizeEpisode({ episodeid: 7, saved: 1, queued: 1, downloaded: 1 });
    expect(ep).toMatchObject({ saved: true, queued: true, downloaded: true });
  });

  // get_episode_metadata names them is_saved / is_queued / is_downloaded.
  it('reads the flags of episode metadata', () => {
    const ep = normalizeEpisode({ episodeid: 7, is_saved: true, is_queued: true, is_downloaded: true });
    expect(ep).toMatchObject({ saved: true, queued: true, downloaded: true });
  });

  it('defaults missing flags to false', () => {
    expect(normalizeEpisode({ episodeid: 7 })).toMatchObject({ saved: false, queued: false, downloaded: false });
  });
});
