import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Account, Episode } from '../lib/types';

vi.mock('../lib/db', () => ({ putLocalPosition: vi.fn(async () => {}) }));
vi.mock('../lib/api', () => ({ recordListenDuration: vi.fn(async () => {}) }));
vi.mock('../lib/sync', () => ({ runOrQueue: vi.fn(async () => {}) }));

import { putLocalPosition } from '../lib/db';
import { recordListenDuration } from '../lib/api';
import { runOrQueue } from '../lib/sync';
import { syncEpisodePosition } from './positions';

const acct = { id: 'a1', serverUrl: 'https://pods.example.com', apiKey: 'k', userId: 3 } as Account;
const ep = (episodeid: number) => ({ episodeid, episodeduration: 600 }) as Episode;

beforeEach(() => vi.clearAllMocks());

describe('syncEpisodePosition', () => {
  it('ignores zero seconds', async () => {
    await syncEpisodePosition(acct, ep(7), 0, 600);
    expect(putLocalPosition).not.toHaveBeenCalled();
    expect(runOrQueue).not.toHaveBeenCalled();
  });
  it('keeps preview episodes local', async () => {
    await syncEpisodePosition(acct, ep(-5), 30, 600);
    expect(putLocalPosition).toHaveBeenCalledWith(expect.objectContaining({ episodeId: -5, synced: false }));
    expect(runOrQueue).not.toHaveBeenCalled();
  });
  it('saves locally then queues record_position', async () => {
    await syncEpisodePosition(acct, ep(7), 120, 600);
    expect(putLocalPosition).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'a1:7', accountId: 'a1', episodeId: 7, seconds: 120, duration: 600, synced: true }),
    );
    expect(runOrQueue).toHaveBeenCalledWith(acct, { kind: 'record_position', episodeId: 7, seconds: 120 }, expect.any(Function));
    const fn = vi.mocked(runOrQueue).mock.calls[0][2] as () => Promise<void>;
    await fn();
    expect(recordListenDuration).toHaveBeenCalledWith(acct, 7, 120);
  });
});
