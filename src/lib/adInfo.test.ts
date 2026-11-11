import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, DownloadEntry, Episode } from './types';

vi.mock('./api', () => ({ getGeneratedTranscriptStatus: vi.fn(), getSkipSegments: vi.fn() }));
vi.mock('./db', () => ({ cacheGet: vi.fn(), cacheSet: vi.fn(async () => {}), getDownload: vi.fn(), putDownloadEntry: vi.fn(async () => {}) }));

import { getGeneratedTranscriptStatus, getSkipSegments } from './api';
import { cacheGet, cacheSet, getDownload, putDownloadEntry } from './db';
import { adInfoKey, loadAdInfo, refreshAdInfo } from './adInfo';

const account = { id: 'a' } as Account;
const ep = (id: number, saved = false) => ({ episodeid: id, saved }) as Episode;
const match = { analyzedFingerprint: 'f', download: 'match' as const };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(cacheSet).mockResolvedValue(undefined);
  vi.mocked(putDownloadEntry).mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});
afterEach(() => vi.useRealTimers());

describe('refreshAdInfo', () => {
  it('caches both calls under adinfo:<id> and stamps the local download', async () => {
    vi.mocked(getGeneratedTranscriptStatus).mockResolvedValue('complete');
    vi.mocked(getSkipSegments).mockResolvedValue({ segments: [{ kind: 'ad', start: 1, end: 2, status: 'active' }], adAudio: match });
    const entry = { key: 'a:7', fromServer: true } as DownloadEntry;
    vi.mocked(getDownload).mockResolvedValue(entry);

    const info = await refreshAdInfo(account, 7);

    expect(adInfoKey(7)).toBe('adinfo:7');
    expect(info).toMatchObject({ transcript: 'complete', adAudio: match });
    expect(info.segments).toHaveLength(1);
    expect(info.fetchedAt).toBeGreaterThan(0);
    expect(cacheSet).toHaveBeenCalledWith('a', 'adinfo:7', info);
    expect(putDownloadEntry).toHaveBeenCalledWith({ ...entry, adFingerprint: 'f' });
  });

  it('leaves a download that needs no stamp alone', async () => {
    vi.mocked(getGeneratedTranscriptStatus).mockResolvedValue(null);
    vi.mocked(getSkipSegments).mockResolvedValue({ segments: [], adAudio: match });
    vi.mocked(getDownload).mockResolvedValue({ key: 'a:7' } as DownloadEntry);
    await refreshAdInfo(account, 7);
    expect(putDownloadEntry).not.toHaveBeenCalled();
  });
});

describe('loadAdInfo', () => {
  const cached = { transcript: null, segments: [], adAudio: null, fetchedAt: 1 };

  it('reads the cache for every episode; uncached ones are absent', async () => {
    vi.mocked(cacheGet).mockImplementation(async (_a, k) => (k === 'adinfo:1' ? cached : undefined));
    const map = await loadAdInfo(account, [ep(1), ep(2)], ep(2));
    expect(map.get(1)).toBe(cached);
    expect(map.has(2)).toBe(false);
    expect(getSkipSegments).not.toHaveBeenCalled();
  });

  it('refreshes the current episode when saved and online', async () => {
    vi.mocked(cacheGet).mockResolvedValue(cached);
    vi.mocked(getGeneratedTranscriptStatus).mockResolvedValue('running');
    vi.mocked(getSkipSegments).mockResolvedValue({ segments: [], adAudio: null });
    const map = await loadAdInfo(account, [ep(1, true)], ep(1, true));
    expect(map.get(1)?.transcript).toBe('running');
  });

  it('uses the cache when the network call times out', async () => {
    vi.useFakeTimers();
    vi.mocked(cacheGet).mockResolvedValue(cached);
    vi.mocked(getGeneratedTranscriptStatus).mockReturnValue(new Promise(() => {}));
    vi.mocked(getSkipSegments).mockReturnValue(new Promise(() => {}));
    const p = loadAdInfo(account, [ep(1, true)], ep(1, true));
    await vi.advanceTimersByTimeAsync(3000);
    expect((await p).get(1)).toBe(cached);
  });

  it('uses the cache on error', async () => {
    vi.mocked(cacheGet).mockResolvedValue(cached);
    vi.mocked(getGeneratedTranscriptStatus).mockRejectedValue(new Error('x'));
    vi.mocked(getSkipSegments).mockResolvedValue({ segments: [], adAudio: null });
    expect((await loadAdInfo(account, [ep(1, true)], ep(1, true))).get(1)).toBe(cached);
  });

  it('does not touch the network when offline or not saved', async () => {
    vi.mocked(cacheGet).mockResolvedValue(cached);
    await loadAdInfo(account, [ep(1)], ep(1));
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await loadAdInfo(account, [ep(1, true)], ep(1, true));
    expect(getSkipSegments).not.toHaveBeenCalled();
  });
});
