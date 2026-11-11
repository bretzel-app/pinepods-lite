// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Account, DownloadEntry, Episode } from '../lib/types';
import type { PlayQueue } from '../lib/playQueue';
import type { EngineEvent, EngineSnapshot, PlaybackItem, PlayerEngine } from './engine/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Newer Node versions define their own (unconfigured) localStorage global,
// which shadows jsdom's; the provider only reads two flags from it.
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
});

const account = { id: 'a' } as Account;

const mocks = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  listDownloads: vi.fn(),
  getAllPodcastEpisodes: vi.fn(),
  getEpisodeMetadata: vi.fn(),
  loadAdInfo: vi.fn(),
  downloadListeners: new Set<() => void>(),
  engine: null as unknown,
}));

vi.mock('../lib/db', () => ({
  cacheGet: mocks.cacheGet,
  cacheSet: vi.fn(async () => {}),
  listDownloads: mocks.listDownloads,
  listLocalPositions: vi.fn(async () => []),
}));
vi.mock('../lib/api', () => ({
  getAllPodcastEpisodes: mocks.getAllPodcastEpisodes,
  getEpisodeMetadata: mocks.getEpisodeMetadata,
  serverStreamUrl: (_account: Account, id: number) => `https://pp/stream/${id}`,
}));
vi.mock('../lib/adInfo', () => ({ loadAdInfo: mocks.loadAdInfo }));
vi.mock('../lib/episodeActions', () => ({ markCompleted: vi.fn(async () => {}) }));
vi.mock('../lib/downloads', () => ({
  subscribeDownloads: (fn: () => void) => {
    mocks.downloadListeners.add(fn);
    return () => mocks.downloadListeners.delete(fn);
  },
}));
vi.mock('../lib/accounts', () => ({
  useAccounts: () => ({ accounts: [account], active: account, ready: true }),
}));
vi.mock('./positions', () => ({
  savePositionLocally: vi.fn(async () => {}),
  syncEpisodePosition: vi.fn(async () => {}),
}));
vi.mock('./engine', () => ({ createEngine: () => mocks.engine }));

import { PlayerProvider, usePlayer } from './PlayerContext';

function ep(id: number): Episode {
  return {
    episodeid: id,
    episodetitle: `Episode ${id}`,
    podcastid: 1,
    podcastname: 'Cast',
    episodepubdate: '',
    episodedescription: '',
    episodeartwork: '',
    episodeurl: `http://cdn/${id}.mp3`,
    episodeduration: 600,
    completed: false,
    saved: false,
    queued: false,
    downloaded: false,
    is_youtube: false,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** An engine playing `item` (native playback that outlived the UI), or idle. */
function fakeEngine(initial: PlaybackItem | null, playing = initial != null) {
  const listeners = new Set<(e: EngineEvent) => void>();
  let item = initial;
  let snap: EngineSnapshot = {
    currentKey: item?.key ?? null,
    playing,
    position: 42,
    duration: 600,
    rate: 1,
    sleepRemaining: null,
    sleepMinutes: null,
  };
  const emit = () => {
    for (const fn of listeners) fn({ type: 'state', snapshot: snap });
  };
  const engine: PlayerEngine = {
    kind: 'native',
    init: async () => snap,
    load: vi.fn(async (items: PlaybackItem[], index: number) => {
      item = items[index];
      snap = { ...snap, currentKey: item.key, playing: true, position: 0 };
      emit();
    }),
    updatePlaylist: vi.fn(),
    current: () => item,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    seek: vi.fn(),
    setRate: vi.fn(),
    setAutoAdvance: vi.fn(),
    setSleepTimer: vi.fn(),
    setSleepRepeat: vi.fn(),
    snapshot: () => snap,
    readReports: async () => [],
    ackReports: async () => {},
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const tick = (position: number) => {
    snap = { ...snap, position };
    emit();
  };
  return { engine, tick };
}

/** cacheGet with the startup reads (last-played, last-queue) held until resolved. */
function holdStartupReads() {
  const lastPlayed = deferred<Episode | undefined>();
  const lastQueue = deferred<PlayQueue | null | undefined>();
  mocks.cacheGet.mockImplementation(async (_account: string, key: string) => {
    if (key === 'last-played') return lastPlayed.promise;
    if (key === 'last-queue') return lastQueue.promise;
    return undefined;
  });
  return { lastPlayed, lastQueue };
}

/** Renders the provider; the returned getter reads its latest value. */
async function renderPlayer() {
  let player: ReturnType<typeof usePlayer> | null = null;
  function Probe() {
    player = usePlayer();
    return null;
  }
  await act(async () => {
    root = createRoot(document.createElement('div'));
    root.render(
      <PlayerProvider>
        <Probe />
      </PlayerProvider>,
    );
  });
  return () => player!;
}

let root: Root | null = null;
beforeEach(() => {
  mocks.listDownloads.mockResolvedValue([]);
  mocks.loadAdInfo.mockResolvedValue(new Map());
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.clearAllMocks();
  vi.useRealTimers();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('PlayerProvider startup', () => {
  it('restores the saved list when engine state arrives before the startup reads', async () => {
    const current = ep(2);
    const queue: PlayQueue = { source: 'Downloads', episodes: [ep(1), current, ep(3)] };
    const { engine, tick } = fakeEngine({
      key: 'a:2',
      accountId: 'a',
      episode: current,
      source: { kind: 'stream', url: current.episodeurl },
      startAt: 0,
    });
    mocks.engine = engine;
    mocks.getAllPodcastEpisodes.mockResolvedValue([ep(1), current, ep(3), ep(4)]);
    const { lastPlayed, lastQueue } = holdStartupReads();
    const player = await renderPlayer();

    // A 1 Hz state tick lands while the startup cache reads are still pending.
    await act(async () => tick(43));
    await act(async () => {
      lastPlayed.resolve(current);
      lastQueue.resolve(queue);
    });

    expect(player().episode?.episodeid).toBe(2);
    expect(player().upNextSource).toBe('Downloads');
    expect(player().nextEpisode?.episodeid).toBe(3);
    expect(mocks.getAllPodcastEpisodes).not.toHaveBeenCalled();
    const sent = vi.mocked(engine.updatePlaylist).mock.calls.map((c) => c[0].map((i) => i.key));
    expect(sent.length).toBeGreaterThan(0);
    for (const keys of sent) expect(keys).toEqual(['a:1', 'a:2', 'a:3']);
  });

  it('still adopts at once what the user plays before the startup reads finish', async () => {
    const { engine } = fakeEngine(null);
    mocks.engine = engine;
    const { lastPlayed, lastQueue } = holdStartupReads();
    const player = await renderPlayer();

    const tapped: PlayQueue = { source: 'Saved', episodes: [ep(5), ep(6)] };
    await act(async () => player().play(ep(5), undefined, tapped));
    expect(player().episode?.episodeid).toBe(5);

    await act(async () => {
      lastPlayed.resolve(ep(2));
      lastQueue.resolve({ source: 'Downloads', episodes: [ep(1), ep(2), ep(3)] });
    });
    expect(player().episode?.episodeid).toBe(5);
    expect(player().upNextSource).toBe('Saved');
    expect(player().nextEpisode?.episodeid).toBe(6);
    expect(engine.load).toHaveBeenCalledTimes(1);
  });
});

describe('PlayerProvider and downloads', () => {
  it('re-sends the playlist only when the downloaded set changes, not on progress', async () => {
    const current = ep(2);
    const { engine } = fakeEngine({
      key: 'a:2',
      accountId: 'a',
      episode: current,
      source: { kind: 'stream', url: current.episodeurl },
      startAt: 0,
    });
    mocks.engine = engine;
    const queue: PlayQueue = { source: 'Downloads', episodes: [ep(1), current, ep(3)] };
    mocks.cacheGet.mockImplementation(async (_account: string, key: string) =>
      key === 'last-played' ? current : key === 'last-queue' ? queue : undefined,
    );
    await renderPlayer();
    const notify = () => act(async () => mocks.downloadListeners.forEach((fn) => fn()));
    const sends = () => vi.mocked(engine.updatePlaylist).mock.calls.length;
    const before = sends();
    expect(before).toBeGreaterThan(0);

    // Progress ticks of a download in flight: nothing on the device changed.
    await notify();
    await notify();
    expect(sends()).toBe(before);

    // It finished: the next episode now plays from its file.
    mocks.listDownloads.mockResolvedValue([
      { key: 'a:3', accountId: 'a', episode: ep(3), filePath: '/f/a_3' } as DownloadEntry,
    ]);
    await notify();
    expect(sends()).toBe(before + 1);
    const last = vi.mocked(engine.updatePlaylist).mock.lastCall![0];
    expect(last.find((i) => i.key === 'a:3')?.source).toEqual({ kind: 'download', filePath: '/f/a_3' });
  });
});

describe('PlayerProvider resuming the current episode', () => {
  const serverUrl = 'https://pp/stream/2';
  const starred = { ...ep(2), saved: true, downloaded: true };
  /** The engine holds episode 2 of its podcast paused at 42 s, cued before its ads were found. */
  async function pausedOn(source: PlaybackItem['source'], episode = starred) {
    const { engine } = fakeEngine({ key: 'a:2', accountId: 'a', episode, source, startAt: 0 }, false);
    mocks.engine = engine;
    mocks.cacheGet.mockImplementation(async () => undefined);
    mocks.getAllPodcastEpisodes.mockResolvedValue([ep(1), episode, ep(3)]);
    const player = await renderPlayer();
    expect(player().episode?.episodeid).toBe(2);
    await vi.waitFor(() => expect(engine.updatePlaylist).toHaveBeenCalled());
    // Only what the play press does counts below.
    mocks.loadAdInfo.mockClear();
    mocks.getEpisodeMetadata.mockClear();
    return { engine, player };
  }
  const scanned = (download: 'match' | 'mismatch') =>
    new Map([
      [
        2,
        {
          transcript: 'complete' as const,
          segments: [
            { kind: 'ad-scan', start: 0, end: 0, status: null },
            { kind: 'ad', start: 10, end: 40, status: 'active' },
          ],
          adAudio: { analyzedFingerprint: 'f', download },
          fetchedAt: 1,
        },
      ],
    ]);

  it('just resumes when nothing changed', async () => {
    const { engine, player } = await pausedOn({ kind: 'stream', url: serverUrl, server: true });
    mocks.getEpisodeMetadata.mockResolvedValue(starred);
    mocks.loadAdInfo.mockResolvedValue(scanned('mismatch'));
    await act(async () => player().play(starred));
    expect(mocks.getEpisodeMetadata).toHaveBeenCalledWith(account, 2);
    expect(engine.load).not.toHaveBeenCalled();
    expect(engine.play).toHaveBeenCalledTimes(1);
  });

  it('reloads it where it is, with its ranges, when they arrived since it was cued', async () => {
    const { engine, player } = await pausedOn({ kind: 'stream', url: serverUrl, server: true });
    mocks.getEpisodeMetadata.mockResolvedValue(starred);
    mocks.loadAdInfo.mockResolvedValue(scanned('match'));
    await act(async () => player().play(starred));
    expect(engine.play).not.toHaveBeenCalled();
    expect(engine.load).toHaveBeenCalledTimes(1);
    const [items, index, autoplay] = vi.mocked(engine.load).mock.calls[0];
    expect(autoplay).toBe(true);
    // The same window the engine had, so previous/next and auto-advance still work.
    const sent = vi.mocked(engine.updatePlaylist).mock.lastCall![0];
    expect(items.map((i) => i.key)).toEqual(sent.map((i) => i.key));
    expect(items).toHaveLength(3);
    expect(items[index]).toMatchObject({
      key: 'a:2',
      startAt: 42,
      source: { kind: 'stream', url: serverUrl, server: true },
      skips: { uri: serverUrl, ranges: [[10, 40]] },
    });
  });

  it('reloads onto the server copy the server got since, as the fresh metadata says', async () => {
    // Cued from the publisher right after starring, from a list that still said "not on the server".
    const stale = { ...starred, downloaded: false };
    const { engine, player } = await pausedOn({ kind: 'stream', url: stale.episodeurl }, stale);
    mocks.getEpisodeMetadata.mockResolvedValue({ ...stale, downloaded: true });
    await act(async () => player().play(stale));
    expect(engine.load).toHaveBeenCalledTimes(1);
    const [items, index] = vi.mocked(engine.load).mock.calls[0];
    expect(items[index]).toMatchObject({ startAt: 42, source: { kind: 'stream', url: serverUrl, server: true } });
  });

  it('does the same from the player bar (toggle)', async () => {
    const { engine, player } = await pausedOn({ kind: 'stream', url: serverUrl, server: true });
    mocks.getEpisodeMetadata.mockResolvedValue(starred);
    mocks.loadAdInfo.mockResolvedValue(scanned('match'));
    await act(async () => player().toggle());
    await vi.waitFor(() => expect(engine.load).toHaveBeenCalledTimes(1));
    expect(engine.play).not.toHaveBeenCalled();
    const [items, index] = vi.mocked(engine.load).mock.calls[0];
    expect(items[index]).toMatchObject({ key: 'a:2', startAt: 42, skips: { uri: serverUrl } });
  });

  it('offline, resumes from what is cached, without asking the server', async () => {
    const { engine, player } = await pausedOn({ kind: 'stream', url: serverUrl, server: true });
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await act(async () => player().play(starred));
    expect(mocks.getEpisodeMetadata).not.toHaveBeenCalled();
    expect(mocks.loadAdInfo).toHaveBeenCalledTimes(1);
    expect(engine.load).not.toHaveBeenCalled();
    expect(engine.play).toHaveBeenCalledTimes(1);
  });

  it('still resumes when the item cannot be rebuilt (storage error)', async () => {
    const { engine, player } = await pausedOn({ kind: 'stream', url: serverUrl, server: true });
    mocks.getEpisodeMetadata.mockResolvedValue(starred);
    mocks.listDownloads.mockRejectedValue(new Error('IndexedDB is gone'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await act(async () => player().play(starred));
    expect(engine.load).not.toHaveBeenCalled();
    expect(engine.play).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('waits at most 3 s for a server that does not answer, then resumes', async () => {
    const { engine, player } = await pausedOn({ kind: 'stream', url: serverUrl, server: true });
    vi.useFakeTimers();
    mocks.getEpisodeMetadata.mockReturnValue(new Promise(() => {}));
    await act(async () => {
      const pressed = player().play(starred);
      await vi.advanceTimersByTimeAsync(2999);
      expect(engine.play).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pressed;
    });
    expect(engine.load).not.toHaveBeenCalled();
    expect(engine.play).toHaveBeenCalledTimes(1);
  });
});
