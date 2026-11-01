import { describe, it, expect } from 'vitest';
import type { Account, DownloadEntry, Episode } from '../lib/types';
import { serverStreamUrl } from '../lib/api';
import { resolveSource, resumePoint } from './resume';

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
