import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Account, Episode } from '../lib/types';
import type { PlaybackReport } from './engine/types';
import { applyReports } from './reports';

const a1 = { id: 'a1' } as Account;
const a2 = { id: 'a2' } as Account;

function ep(overrides: Partial<Episode> = {}): Episode {
  return {
    episodeid: 1, episodetitle: 't', podcastname: 'p', episodepubdate: '', episodedescription: '', episodeartwork: '',
    episodeurl: 'http://cdn/x.mp3', episodeduration: 1800, completed: false, saved: false, queued: false,
    downloaded: false, is_youtube: false, ...overrides,
  };
}

function report(seq: number, kind: 'position' | 'ended', o: Partial<PlaybackReport> = {}): PlaybackReport {
  const episode = o.episode ?? ep();
  return { seq, kind, key: `a1:${episode.episodeid}`, accountId: 'a1', episode, seconds: 100, at: 0, ...o };
}

function deps() {
  const calls: string[] = [];
  return {
    calls,
    accounts: [a1, a2],
    syncPosition: vi.fn(async (a: Account, e: Episode, s: number, d: number) => {
      calls.push(`sync:${a.id}:${e.episodeid}:${s}:${d}`);
    }),
    markCompleted: vi.fn(async (a: Account, e: Episode) => {
      calls.push(`done:${a.id}:${e.episodeid}`);
    }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('applyReports', () => {
  it('returns 0 for an empty batch', async () => expect(await applyReports([], deps())).toBe(0));

  it('ended syncs the full duration then marks completed', async () => {
    const d = deps();
    expect(await applyReports([report(1, 'ended', { seconds: 1800 })], d)).toBe(1);
    expect(d.calls).toEqual(['sync:a1:1:1800:1800', 'done:a1:1']);
  });

  it('does not re-complete completed or preview episodes', async () => {
    const d = deps();
    await applyReports(
      [report(1, 'ended', { episode: ep({ completed: true }) }), report(2, 'ended', { episode: ep({ episodeid: -3 }) })],
      d,
    );
    expect(d.markCompleted).not.toHaveBeenCalled();
    expect(d.syncPosition).toHaveBeenCalledTimes(2);
  });

  it('position reports sync to the report account', async () => {
    const d = deps();
    await applyReports([report(1, 'position', { accountId: 'a2', key: 'a2:1', seconds: 50 })], d);
    expect(d.calls).toEqual(['sync:a2:1:50:1800']);
  });

  it('skips a position superseded by a later ended for the same key', async () => {
    const d = deps();
    await applyReports([report(1, 'position'), report(2, 'ended', { seconds: 1800 })], d);
    expect(d.calls).toEqual(['sync:a1:1:1800:1800', 'done:a1:1']);
  });

  it('skips reports of unknown accounts but still acks them', async () => {
    const d = deps();
    expect(await applyReports([report(1, 'position'), report(5, 'position', { accountId: 'zz' })], d)).toBe(5);
    expect(d.syncPosition).toHaveBeenCalledTimes(1);
  });

  it('keeps going when one report fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps();
    d.markCompleted.mockRejectedValueOnce(new Error('boom'));
    const second = ep({ episodeid: 2 });
    expect(await applyReports([report(1, 'ended'), report(2, 'ended', { episode: second, key: 'a1:2' })], d)).toBe(2);
    expect(d.calls).toContain('done:a1:2');
  });
});
