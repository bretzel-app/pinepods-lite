import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Account, Episode } from '../lib/types';
import { cacheGet, cacheSet, listDownloads, listLocalPositions } from '../lib/db';
import { getAllPodcastEpisodes } from '../lib/api';
import { markCompleted } from '../lib/episodeActions';
import { subscribeDownloads } from '../lib/downloads';
import { useAccounts } from '../lib/accounts';
import { buildPlaybackItems, decideStartup, playlistWindow } from './resume';
import { applyReports } from './reports';
import { savePositionLocally, syncEpisodePosition } from './positions';
import { chronological, type PlayQueue } from '../lib/playQueue';
import { createEngine } from './engine';
import type { EngineSnapshot, PlaybackItem } from './engine/types';

const SYNC_INTERVAL_MS = 15_000;
const LAST_PLAYED_KEY = 'last-played';
const LAST_QUEUE_KEY = 'last-queue';

interface PlayerState {
  episode: Episode | null;
  playing: boolean;
  position: number;
  duration: number;
  rate: number;
  /** True when playing from a locally downloaded blob. */
  offlineSource: boolean;
  /** Seconds until the sleep timer pauses playback; null when off. */
  sleepRemaining: number | null;
  /** The armed sleep duration in minutes; null when the timer is off. */
  sleepMinutes: number | null;
  /** Check-in mode: pressing play re-arms the timer to its full duration. */
  sleepRepeat: boolean;
  /** Pass the list the episode was started from so previous/next walk it;
   * without one, a new episode falls back to its podcast by publication date. */
  play: (episode: Episode, startAt?: number, queue?: PlayQueue) => Promise<void>;
  toggle: () => void;
  seek: (seconds: number) => void;
  skip: (deltaSeconds: number) => void;
  setRate: (rate: number) => void;
  /** Start a sleep timer for the given minutes, or null to cancel. */
  setSleepTimer: (minutes: number | null) => void;
  setSleepRepeat: (repeat: boolean) => void;
  /** Neighbours of the current episode in the list it was started from, or
   * else in its podcast by publication date; null at either end or when
   * unknown. */
  previousEpisode: Episode | null;
  nextEpisode: Episode | null;
  /** What previous/next walk through, e.g. "Downloads" or a podcast name. */
  upNextSource: string | null;
  playPrevious: () => void;
  playNext: () => void;
  /** Start the next episode in the list when the current one ends. */
  autoplayNext: boolean;
  setAutoplayNext: (on: boolean) => void;
}

const SLEEP_REPEAT_KEY = 'pinepods.sleepRepeat';
const AUTOPLAY_NEXT_KEY = 'pinepods.autoplayNext';

const PlayerContext = createContext<PlayerState | null>(null);

/** Engine items for `ep` and a window of `list` around it (just `ep` when the
 * list doesn't contain it), with sources and resume points for `account`. */
async function playlistItems(
  account: Account,
  list: Episode[],
  ep: Episode,
  startAt?: number,
): Promise<{ items: PlaybackItem[]; index: number }> {
  const inList = list.some((e) => e.episodeid === ep.episodeid);
  const { episodes, index } = playlistWindow(inList ? list : [ep], ep.episodeid);
  const [downloads, positions] = await Promise.all([
    listDownloads(account.id),
    listLocalPositions(account.id),
  ]);
  const ctx = {
    downloads: new Map(downloads.map((d) => [d.episode.episodeid, d])),
    localSeconds: new Map(positions.map((p) => [p.episodeId, p.seconds])),
  };
  const cued = episodes.map((e, i) => (i === index ? ep : e));
  return { items: buildPlaybackItems(account, cued, index, ctx, startAt), index };
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const { accounts, active, ready } = useAccounts();
  const [engine] = useState(createEngine);
  // The account an episode was started under; position syncs must go to that
  // account even if the user switches accounts mid-playback.
  const playbackAccountRef = useRef<Account | null>(null);
  const [episode, setEpisode] = useState<Episode | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRateState] = useState(1);
  const [offlineSource, setOfflineSource] = useState(false);
  const [sleepRemaining, setSleepRemaining] = useState<number | null>(null);
  const [sleepMinutes, setSleepMinutes] = useState<number | null>(null);
  const [sleepRepeat, setSleepRepeatState] = useState<boolean>(
    () => localStorage.getItem(SLEEP_REPEAT_KEY) === '1',
  );
  const [previousEpisode, setPreviousEpisode] = useState<Episode | null>(null);
  const [nextEpisode, setNextEpisode] = useState<Episode | null>(null);
  const [autoplayNext, setAutoplayNextState] = useState<boolean>(
    () => localStorage.getItem(AUTOPLAY_NEXT_KEY) === '1',
  );
  const [queue, setQueue] = useState<PlayQueue | null>(null);
  const queueRef = useRef<PlayQueue | null>(null);
  queueRef.current = queue;
  const [upNextSource, setUpNextSource] = useState<string | null>(null);
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  const readyRef = useRef(ready);
  readyRef.current = ready;

  // The episode on screen and its engine key. Set together with the state,
  // not on render, so engine events right after a switch already see it.
  const episodeRef = useRef<Episode | null>(null);
  const keyRef = useRef<string | null>(null);
  // Last known playback of the on-screen episode, to flush it on a switch.
  const lastRef = useRef({ playing: false, position: 0, duration: 0 });
  // Native playback outlives the UI, so engine state can arrive before the
  // startup effect has read the saved list. Adopting it then would skip that
  // restore and fall back to podcast order; until the startup decision (or a
  // play from the user) state only updates what's shown.
  const startupDecidedRef = useRef(false);

  const showEpisode = useCallback((ep: Episode) => {
    episodeRef.current = ep;
    setEpisode(ep);
  }, []);

  /** An engine item's account: its own, even if removed while it plays. */
  const accountFor = useCallback(
    (accountId: string): Account | null =>
      accountsRef.current.find((a) => a.id === accountId) ??
      (playbackAccountRef.current?.id === accountId ? playbackAccountRef.current : null),
    [],
  );

  /** Make the engine's current item the on-screen episode. */
  const adopt = useCallback(
    (item: PlaybackItem, account: Account) => {
      keyRef.current = item.key;
      playbackAccountRef.current = account;
      showEpisode(item.episode);
      setOfflineSource(item.source.kind === 'download');
      // Remember for next launch so one tap resumes where you left off.
      void cacheSet(account.id, LAST_PLAYED_KEY, item.episode);
    },
    [showEpisode],
  );

  const onState = useCallback(
    (snap: EngineSnapshot) => {
      const last = lastRef.current;
      let switched = false;
      if (startupDecidedRef.current && snap.currentKey != null && snap.currentKey !== keyRef.current) {
        const item = engine.current();
        const account = item?.key === snap.currentKey ? accountFor(item.accountId) : null;
        if (item && account) {
          // Flush the outgoing episode's position before switching.
          const outAccount = playbackAccountRef.current;
          const outEp = episodeRef.current;
          if (outAccount && outEp) {
            void syncEpisodePosition(outAccount, outEp, last.position, last.duration);
          }
          adopt(item, account);
          switched = true;
        }
      }
      if (!switched && last.playing && !snap.playing) {
        const account = playbackAccountRef.current;
        const ep = episodeRef.current;
        if (account && ep) void syncEpisodePosition(account, ep, snap.position, snap.duration);
      }
      if (snap.currentKey === keyRef.current) {
        lastRef.current = { playing: snap.playing, position: snap.position, duration: snap.duration };
      }
      setPlaying(snap.playing);
      setPosition(snap.position);
      setDuration(snap.duration);
      setRateState(snap.rate);
      setSleepRemaining(snap.sleepRemaining);
      setSleepMinutes(snap.sleepMinutes);
    },
    [engine, accountFor, adopt],
  );

  // Playback reached the end: mark completed on the server and drop the
  // local offline copy — it's no longer needed on the device.
  const completeEpisode = useCallback(
    async (account: Account, ep: Episode) => {
      const shown = episodeRef.current;
      if (shown && playbackAccountRef.current?.id === account.id && shown.episodeid === ep.episodeid) {
        // Already marked when it finished before; once is enough.
        if (shown.completed) return;
        showEpisode({ ...shown, completed: true });
      }
      await markCompleted(account, ep);
    },
    [showEpisode],
  );

  // Apply what the engine reported (episodes played to the end), one drain at
  // a time; a report that fails stays unacked and comes back next drain.
  const drainingRef = useRef(false);
  const drainAgainRef = useRef(false);
  const drainReports = useCallback(async () => {
    // Before the accounts are loaded every report would look orphaned.
    if (!readyRef.current) return;
    if (drainingRef.current) {
      drainAgainRef.current = true;
      return;
    }
    drainingRef.current = true;
    try {
      do {
        drainAgainRef.current = false;
        const reports = await engine.readReports();
        if (!reports.length) continue;
        const through = await applyReports(reports, {
          accounts: accountsRef.current,
          syncPosition: syncEpisodePosition,
          markCompleted: completeEpisode,
        });
        if (through > 0) await engine.ackReports(through);
      } while (drainAgainRef.current);
    } catch (err) {
      console.warn('Could not apply playback reports', err);
    } finally {
      drainingRef.current = false;
    }
  }, [engine, completeEpisode]);

  useEffect(
    () =>
      engine.subscribe((e) => {
        if (e.type === 'reports') void drainReports();
        else onState(e.snapshot);
      }),
    [engine, onState, drainReports],
  );

  const initRef = useRef<Promise<EngineSnapshot> | null>(null);
  const initEngine = useCallback(() => (initRef.current ??= engine.init()), [engine]);
  useEffect(() => {
    void initEngine();
  }, [initEngine]);

  // Reports recorded before the accounts were known are applied once they are.
  useEffect(() => {
    if (ready) void drainReports();
  }, [ready, drainReports]);

  useEffect(() => {
    engine.setAutoAdvance(autoplayNext);
  }, [engine, autoplayNext]);

  useEffect(() => {
    engine.setSleepRepeat(sleepRepeat);
  }, [engine, sleepRepeat]);

  /** Save where the engine's current item is: locally, or also to the server. */
  const savePlayback = useCallback(
    (toServer: boolean) => {
      const item = engine.current();
      const account = item && accountFor(item.accountId);
      if (!item || !account) return;
      const { position: seconds, duration: total } = engine.snapshot();
      if (toServer) void syncEpisodePosition(account, item.episode, seconds, total);
      else if (seconds > 0) void savePositionLocally(account, item.episode, seconds, total, false);
    },
    [engine, accountFor],
  );

  // Periodic position sync while playing, plus a local save every tick so a
  // crash never loses more than a few seconds.
  useEffect(() => {
    if (!playing) return;
    const local = window.setInterval(() => savePlayback(false), 3000);
    const server = window.setInterval(() => savePlayback(true), SYNC_INTERVAL_MS);
    return () => {
      window.clearInterval(local);
      window.clearInterval(server);
    };
  }, [playing, savePlayback]);

  // Flush position when the tab is hidden or closed; on return, apply what
  // the engine reported meanwhile.
  useEffect(() => {
    const onHide = () => {
      if (engine.snapshot().playing) savePlayback(true);
    };
    const onVisibility = () => {
      onHide();
      if (document.visibilityState === 'visible') void drainReports();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
    };
  }, [engine, savePlayback, drainReports]);

  /** Hand the engine `ep` within its queue (or alone), cued at its resume
   * point. With autoplay=false this only loads. */
  const loadSeqRef = useRef(0);
  const loadEpisode = useCallback(
    async (account: Account, ep: Episode, fromQueue: PlayQueue | null, autoplay: boolean, startAt?: number) => {
      const seq = ++loadSeqRef.current;
      const { items, index } = await playlistItems(account, fromQueue?.episodes ?? [], ep, startAt);
      // A later play (or a first tap racing the startup restore) wins.
      if (seq !== loadSeqRef.current) return;
      await engine.load(items, index, autoplay);
    },
    [engine],
  );

  const play = useCallback(
    async (ep: Episode, startAt?: number, fromQueue?: PlayQueue) => {
      if (!active) return;
      // The user's choice: adopt what it loads as soon as the engine says so.
      startupDecidedRef.current = true;

      // A list replaces the queue; a new episode started from elsewhere
      // (detail page, transcript) drops it. Resuming the current one keeps it.
      const isCurrent = episodeRef.current?.episodeid === ep.episodeid;
      const nextQueue = fromQueue ?? (isCurrent ? queueRef.current : null);
      if (nextQueue !== queueRef.current) {
        queueRef.current = nextQueue;
        setQueue(nextQueue);
        // Kept with last-played so previous/next survive an app restart.
        void cacheSet(active.id, LAST_QUEUE_KEY, nextQueue);
      }

      // Same episode already cued: just resume (or jump). The engine reloads
      // a source that failed to load.
      if (isCurrent && engine.current()?.key === keyRef.current) {
        if (startAt != null) engine.seek(startAt);
        void engine.play();
        return;
      }

      await loadEpisode(active, ep, nextQueue, true, startAt);
    },
    [active, engine, loadEpisode],
  );

  // On app start (or when switching to an account while idle), adopt what the
  // engine is already playing, else cue up that account's last-played
  // episode, paused at its resume point.
  const restoredForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!active || episodeRef.current) return;
    if (restoredForRef.current === active.id) return;
    restoredForRef.current = active.id;
    let cancelled = false;
    let decided = false;
    void (async () => {
      try {
        const [, lastPlayed, savedQueue] = await Promise.all([
          initEngine(),
          cacheGet<Episode>(active.id, LAST_PLAYED_KEY),
          cacheGet<PlayQueue | null>(active.id, LAST_QUEUE_KEY),
        ]);
        if (cancelled || episodeRef.current) return;
        const startup = decideStartup(engine.snapshot(), engine.current(), lastPlayed, accountsRef.current);
        if (startup.kind === 'adopt') {
          const adoptedQueue =
            startup.account.id === active.id
              ? savedQueue
              : await cacheGet<PlayQueue | null>(startup.account.id, LAST_QUEUE_KEY);
          if (cancelled || episodeRef.current) return;
          queueRef.current = adoptedQueue ?? null;
          setQueue(adoptedQueue ?? null);
        } else if (startup.kind === 'restore') {
          queueRef.current = savedQueue ?? null;
          setQueue(savedQueue ?? null);
          void loadEpisode(active, startup.episode, savedQueue ?? null, false);
        }
      } finally {
        // Also when a read failed: never leave engine state held back.
        if (!cancelled) {
          decided = true;
          startupDecidedRef.current = true;
          // Adopt what the engine has now; its next state may be a while
          // (no ticks while paused).
          onState(engine.snapshot());
        }
      }
    })();
    return () => {
      cancelled = true;
      // Interrupted before deciding: let the next run for this account decide.
      if (!decided && restoredForRef.current === active.id) restoredForRef.current = null;
    };
  }, [active, engine, initEngine, loadEpisode, onState]);

  // The list the engine's playlist is a window of, under the playback
  // account; null until the current episode's neighbours are known.
  const playlistRef = useRef<{ account: Account; list: Episode[] } | null>(null);
  const sendSeqRef = useRef(0);
  /** (Re)send the engine a window of that list around the current episode,
   * with sources and resume points as they are now. */
  const sendPlaylist = useCallback(async () => {
    const target = playlistRef.current;
    const ep = episodeRef.current;
    if (!target || !ep) return;
    const seq = ++sendSeqRef.current;
    const { items } = await playlistItems(target.account, target.list, ep);
    // Superseded by a newer send, or by another episode or list, meanwhile.
    if (seq === sendSeqRef.current && playlistRef.current === target) engine.updatePlaylist(items);
  }, [engine]);

  // Find the current episode's neighbours: in the list it was played from
  // when there is one, else in its podcast by publication date, so "next"
  // continues a serialized story. For the latter, prefer the list cached by
  // the podcast page (works offline); fetch it once when the page was never
  // opened. The engine gets a window of that list for its own previous/next
  // and auto-advance.
  const currentId = episode?.episodeid;
  const currentPodcastId = episode?.podcastid;
  useEffect(() => {
    let cancelled = false;
    const account = playbackAccountRef.current;
    const send = (list: Episode[]) => {
      if (!account) return;
      playlistRef.current = { account, list };
      void sendPlaylist();
    };
    const idx = queue ? queue.episodes.findIndex((e) => e.episodeid === currentId) : -1;
    if (queue && idx >= 0) {
      setPreviousEpisode(queue.episodes[idx - 1] ?? null);
      setNextEpisode(queue.episodes[idx + 1] ?? null);
      setUpNextSource(queue.source);
      send(queue.episodes);
      return () => {
        cancelled = true;
        playlistRef.current = null;
      };
    }
    setPreviousEpisode(null);
    setNextEpisode(null);
    setUpNextSource(episodeRef.current?.podcastname || null);
    if (!account || currentId == null || currentId < 0 || currentPodcastId == null) return;
    const key = `podcast-episodes:${currentPodcastId}`;
    const pick = (fetched: Episode[] | undefined): boolean => {
      if (!fetched?.some((e) => e.episodeid === currentId)) return false;
      const ep = episodeRef.current;
      // Rows from the podcast endpoint can omit the podcast fields.
      const list = chronological(fetched).map((e) => ({
        ...e,
        podcastid: currentPodcastId,
        podcastname: e.podcastname || ep?.podcastname || '',
      }));
      const idx = list.findIndex((e) => e.episodeid === currentId);
      if (!cancelled) {
        setPreviousEpisode(list[idx - 1] ?? null);
        setNextEpisode(list[idx + 1] ?? null);
        send(list);
      }
      return true;
    };
    void (async () => {
      if (pick(await cacheGet<Episode[]>(account.id, key))) return;
      try {
        const list = await getAllPodcastEpisodes(account, currentPodcastId);
        void cacheSet(account.id, key, list);
        pick(list);
      } catch {
        // Offline with no cached list: no previous/next for this episode.
      }
    })();
    return () => {
      cancelled = true;
      playlistRef.current = null;
    };
  }, [currentId, currentPodcastId, queue, sendPlaylist]);

  // A download finished or was removed: rebuild the queued items' sources
  // (and resume points), so auto-advance and lock-screen next play what is
  // on the device now.
  useEffect(() => {
    const unsubscribe = subscribeDownloads(() => void sendPlaylist());
    return () => {
      unsubscribe();
    };
  }, [sendPlaylist]);

  const playPrevious = useCallback(() => {
    if (previousEpisode) void play(previousEpisode, undefined, queueRef.current ?? undefined);
  }, [previousEpisode, play]);

  const playNext = useCallback(() => {
    if (nextEpisode) void play(nextEpisode, undefined, queueRef.current ?? undefined);
  }, [nextEpisode, play]);

  const setAutoplayNext = useCallback((on: boolean) => {
    setAutoplayNextState(on);
    localStorage.setItem(AUTOPLAY_NEXT_KEY, on ? '1' : '0');
  }, []);

  const setSleepTimer = useCallback((minutes: number | null) => engine.setSleepTimer(minutes), [engine]);

  const setSleepRepeat = useCallback((repeat: boolean) => {
    setSleepRepeatState(repeat);
    localStorage.setItem(SLEEP_REPEAT_KEY, repeat ? '1' : '0');
  }, []);

  const toggle = useCallback(() => {
    if (!episodeRef.current) return;
    if (engine.snapshot().playing) engine.pause();
    else void engine.play();
  }, [engine]);

  const seek = useCallback((seconds: number) => engine.seek(seconds), [engine]);

  const skip = useCallback(
    (delta: number) => {
      const { position: at, duration: total } = engine.snapshot();
      engine.seek(Math.max(0, Math.min(total || Infinity, at + delta)));
    },
    [engine],
  );

  const setRate = useCallback((r: number) => engine.setRate(r), [engine]);

  const value = useMemo(
    () => ({
      episode,
      playing,
      position,
      duration,
      rate,
      offlineSource,
      sleepRemaining,
      sleepMinutes,
      sleepRepeat,
      play,
      toggle,
      seek,
      skip,
      setRate,
      setSleepTimer,
      setSleepRepeat,
      previousEpisode,
      nextEpisode,
      upNextSource,
      playPrevious,
      playNext,
      autoplayNext,
      setAutoplayNext,
    }),
    [
      episode,
      playing,
      position,
      duration,
      rate,
      offlineSource,
      sleepRemaining,
      sleepMinutes,
      sleepRepeat,
      play,
      toggle,
      seek,
      skip,
      setRate,
      setSleepTimer,
      setSleepRepeat,
      previousEpisode,
      nextEpisode,
      upNextSource,
      playPrevious,
      playNext,
      autoplayNext,
      setAutoplayNext,
    ],
  );

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer(): PlayerState {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used inside PlayerProvider');
  return ctx;
}
