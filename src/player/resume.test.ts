import { describe, it, expect } from 'vitest';
import type { Account, DownloadEntry, Episode } from '../lib/types';
import { serverStreamUrl } from '../lib/api';
import type { EngineSnapshot, PlaybackItem } from './engine/types';
import { buildPlaybackItems, decideStartup, playlistWindow, resolveSource, resumePoint } from './resume';

const acct = { id: 'a1', serverUrl: 'https://pods.example.com', apiKey: 'k', userId: 3 } as Account;

function ep(overrides: Partial<Episode> = {}): Episode {
  return {
    episodeid: 1,
    episodetitle: 't',
    podcastname: 'p',
    episodepubdate: '',
    episodedescription: '',
    episodeartwork: '',
    episodeurl: 'http://cdn/default.mp3',
    episodeduration: 0,
    completed: false,
    saved: false,
    queued: false,
    downloaded: false,
    is_youtube: false,
    ...overrides,
  };
}

describe('resolveSource', () => {
  it('prefers a local download', () =>
    expect(resolveSource(acct, ep({ episodeid: 7, downloaded: true }), { filePath: '/x/a1_7' } as DownloadEntry)).toEqual({
      kind: 'download',
      filePath: '/x/a1_7',
    }));
  it('uses the server copy when the server downloaded it', () =>
    expect(resolveSource(acct, ep({ episodeid: 7, downloaded: true }), undefined)).toEqual({
      kind: 'stream',
      url: serverStreamUrl(acct, 7),
    }));
  it('falls back to the enclosure URL', () =>
    expect(resolveSource(acct, ep({ episodeurl: 'http://cdn/x.mp3' }), undefined)).toEqual({
      kind: 'stream',
      url: 'http://cdn/x.mp3',
    }));
});

describe('resumePoint', () => {
  it('explicit start wins', () => expect(resumePoint(ep({ listenduration: 50 }), 80, 42)).toBe(42));
  it('takes the freshest of local and server', () => expect(resumePoint(ep({ listenduration: 50 }), 80)).toBe(80));
  it('restarts completed episodes', () => expect(resumePoint(ep({ completed: true }), 80)).toBe(0));
  it('restarts within 15 s of the end', () => expect(resumePoint(ep({ episodeduration: 1000 }), 990)).toBe(0));
});

describe('playlistWindow', () => {
  const long = Array.from({ length: 450 }, (_, i) => ep({ episodeid: i }));
  it('keeps one before and 25 after', () =>
    expect(playlistWindow(long, 200)).toEqual({ episodes: long.slice(199, 226), index: 1 }));
  it('clamps at the start', () => expect(playlistWindow(long, 0)).toEqual({ episodes: long.slice(0, 26), index: 0 }));
  it('clamps at the end', () => expect(playlistWindow(long, 449)).toEqual({ episodes: long.slice(448), index: 1 }));
});

describe('buildPlaybackItems', () => {
  const a2 = { id: 'a2', serverUrl: 'https://other.example.com', apiKey: 'k', userId: 4 } as Account;
  const e1 = ep({ episodeid: 1 });
  const e2 = ep({ episodeid: 2 });
  const dl = { filePath: '/x/a2_2' } as DownloadEntry;
  it('builds items for the playback account with sources and start points', () => {
    const items = buildPlaybackItems(a2, [e1, e2], 0, { downloads: new Map([[2, dl]]), localSeconds: new Map([[1, 80]]) }, 42);
    expect(items.map((i) => i.accountId)).toEqual(['a2', 'a2']);
    expect(items[0]).toMatchObject({ key: 'a2:1', startAt: 42 });
    expect(items[1].source).toEqual({ kind: 'download', filePath: dl.filePath });
  });
  it('applies the startAt override to the indexed episode only', () => {
    const ctx = { downloads: new Map<number, DownloadEntry>(), localSeconds: new Map([[1, 80], [2, 90]]) };
    const items = buildPlaybackItems(a2, [e1, e2], 1, ctx, 5);
    expect(items.map((i) => i.startAt)).toEqual([80, 5]);
  });
});

describe('decideStartup', () => {
  const snap = (currentKey: string | null): EngineSnapshot => ({
    currentKey, playing: currentKey != null, position: 0, duration: 0, rate: 1, sleepRemaining: null, sleepMinutes: null,
  });
  const item = (accountId: string): PlaybackItem => ({
    key: `${accountId}:9`, accountId, episode: ep({ episodeid: 9 }), source: { kind: 'stream', url: 'u' }, startAt: 0,
  });
  const last = ep({ episodeid: 7 });
  it('adopts native playback of a known account', () =>
    expect(decideStartup(snap('a1:9'), item('a1'), last, [acct])).toEqual({ kind: 'adopt', item: item('a1'), account: acct }));
  it('restores when the playing account was removed', () =>
    expect(decideStartup(snap('a9:9'), item('a9'), last, [acct])).toEqual({ kind: 'restore', episode: last }));
  it('restores the last played episode when idle', () =>
    expect(decideStartup(snap(null), null, last, [acct])).toEqual({ kind: 'restore', episode: last }));
  it('does nothing without anything to resume', () =>
    expect(decideStartup(snap(null), null, undefined, [acct])).toEqual({ kind: 'none' }));
});
