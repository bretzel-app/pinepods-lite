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
import { cacheGet, cacheSet, getDownloadBlob, getLocalPosition, putLocalPosition } from '../lib/db';
import { getAllPodcastEpisodes, recordListenDuration, serverStreamUrl } from '../lib/api';
import { runOrQueue } from '../lib/sync';
import { markCompleted } from '../lib/episodeActions';
import { useAccounts } from '../lib/accounts';
import { chronological, type PlayQueue } from '../lib/playQueue';

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

export function PlayerProvider({ children }: { children: ReactNode }) {
  const { active } = useAccounts();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  // The account an episode was started under; position syncs must go to that
  // account even if the user switches accounts mid-playback.
  const playbackAccountRef = useRef<Account | null>(null);
  const [episode, setEpisode] = useState<Episode | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRateState] = useState(1);
  const [offlineSource, setOfflineSource] = useState(false);
  const [sleepUntil, setSleepUntil] = useState<number | null>(null);
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
  const autoplayNextRef = useRef(autoplayNext);
  autoplayNextRef.current = autoplayNext;
  const [queue, setQueue] = useState<PlayQueue | null>(null);
  const queueRef = useRef<PlayQueue | null>(null);
  queueRef.current = queue;
  const [upNextSource, setUpNextSource] = useState<string | null>(null);
  const nextEpisodeRef = useRef<Episode | null>(null);
  nextEpisodeRef.current = nextEpisode;
  // Set while auto-advancing so the play it causes isn't taken for a press.
  const autoAdvancingRef = useRef(false);
  const playRef = useRef<(ep: Episode, startAt?: number, queue?: PlayQueue) => Promise<void>>();
  const sleepMinutesRef = useRef<number | null>(null);
  const sleepRepeatRef = useRef(sleepRepeat);
  sleepRepeatRef.current = sleepRepeat;

  if (!audioRef.current && typeof Audio !== 'undefined') {
    audioRef.current = new Audio();
    audioRef.current.preload = 'metadata';
  }

  const episodeRef = useRef<Episode | null>(null);
  episodeRef.current = episode;

  const persistPosition = useCallback(async (seconds: number, markSynced: boolean) => {
    const account = playbackAccountRef.current;
    const ep = episodeRef.current;
    if (!account || !ep || seconds <= 0) return;
    await putLocalPosition({
      key: `${account.id}:${ep.episodeid}`,
      accountId: account.id,
      episodeId: ep.episodeid,
      seconds,
      duration: audioRef.current?.duration || ep.episodeduration,
      updatedAt: Date.now(),
      synced: markSynced,
    });
  }, []);

  const syncToServer = useCallback(
    async (seconds: number) => {
      const account = playbackAccountRef.current;
      const ep = episodeRef.current;
      if (!account || !ep || seconds <= 0) return;
      // Preview episodes (negative synthetic ids) don't exist on the server:
      // keep resume local-only.
      if (ep.episodeid < 0) {
        await persistPosition(seconds, false);
        return;
      }
      await persistPosition(seconds, true);
      await runOrQueue(account, { kind: 'record_position', episodeId: ep.episodeid, seconds }, () =>
        recordListenDuration(account, ep.episodeid, seconds),
      );
    },
    [persistPosition],
  );

  // Wire up the audio element once.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setPosition(audio.currentTime);
    const onDuration = () => setDuration(audio.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      void syncToServer(audio.currentTime);
    };
    const onEnded = () => {
      setPlaying(false);
      void syncToServer(audio.duration || audio.currentTime);
      // Playback reached the end: mark completed on the server and drop the
      // local offline copy — it's no longer needed on the device.
      const account = playbackAccountRef.current;
      const ep = episodeRef.current;
      if (account && ep && !ep.completed && ep.episodeid > 0) {
        setEpisode({ ...ep, completed: true });
        void markCompleted(account, ep);
      }
      const next = nextEpisodeRef.current;
      if (autoplayNextRef.current && next && playRef.current) {
        autoAdvancingRef.current = true;
        void playRef.current(next, undefined, queueRef.current ?? undefined).finally(() => {
          autoAdvancingRef.current = false;
        });
      }
    };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('durationchange', onDuration);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('durationchange', onDuration);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
    };
  }, [syncToServer]);

  // Periodic position sync while playing, plus a local save every tick so a
  // crash never loses more than a few seconds.
  useEffect(() => {
    if (!playing) return;
    const local = window.setInterval(() => {
      const audio = audioRef.current;
      if (audio) void persistPosition(audio.currentTime, false);
    }, 3000);
    const server = window.setInterval(() => {
      const audio = audioRef.current;
      if (audio) void syncToServer(audio.currentTime);
    }, SYNC_INTERVAL_MS);
    return () => {
      window.clearInterval(local);
      window.clearInterval(server);
    };
  }, [playing, persistPosition, syncToServer]);

  // Flush position when the tab is hidden or closed.
  useEffect(() => {
    const onHide = () => {
      const audio = audioRef.current;
      if (audio && episodeRef.current && !audio.paused) void syncToServer(audio.currentTime);
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    };
  }, [syncToServer]);

  /** Point the audio element at an episode and cue it at its resume point.
   * With autoplay=false this only loads (used to restore the last-played
   * episode on app start, so one tap on Play resumes). */
  const loadEpisode = useCallback(
    async (ep: Episode, account: Account, autoplay: boolean, startAt?: number) => {
      const audio = audioRef.current;
      if (!audio) return;

      // Flush the outgoing episode's position before switching.
      if (episodeRef.current && episodeRef.current.episodeid !== ep.episodeid && audio.currentTime > 0) {
        void syncToServer(audio.currentTime);
      }

      playbackAccountRef.current = account;
      setEpisode(ep);
      setDuration(ep.episodeduration || 0);

      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }

      // Source priority: local download → server-side copy → enclosure URL.
      const blob = await getDownloadBlob(account.id, ep.episodeid);
      if (blob) {
        blobUrlRef.current = URL.createObjectURL(blob);
        audio.src = blobUrlRef.current;
        setOfflineSource(true);
      } else if (ep.downloaded) {
        audio.src = serverStreamUrl(account, ep.episodeid);
        setOfflineSource(false);
      } else {
        audio.src = ep.episodeurl;
        setOfflineSource(false);
      }

      // Resume point: an explicit start (e.g. tapped transcript line) wins,
      // else the freshest of local (offline-safe) and server-known position.
      let resumeAt: number;
      if (startAt != null) {
        resumeAt = startAt;
      } else {
        const local = await getLocalPosition(account.id, ep.episodeid);
        const serverSeconds = ep.listenduration ?? 0;
        resumeAt = Math.max(local?.seconds ?? 0, serverSeconds);
        const total = ep.episodeduration || 0;
        if (ep.completed || (total > 0 && resumeAt > total - 15)) resumeAt = 0;
      }
      setPosition(resumeAt);

      audio.playbackRate = rate;
      if (resumeAt > 3) {
        // Apply after metadata loads; setting currentTime too early is ignored.
        const apply = () => {
          audio.currentTime = resumeAt;
          audio.removeEventListener('loadedmetadata', apply);
        };
        audio.addEventListener('loadedmetadata', apply);
      }
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: ep.episodetitle,
          artist: ep.podcastname,
          artwork: ep.episodeartwork ? [{ src: ep.episodeartwork }] : [],
        });
      }

      // Resolves once playback starts (after the 'play' event), or on failure.
      if (autoplay) await audio.play().catch(() => {});
    },
    [rate, syncToServer],
  );

  const play = useCallback(
    async (ep: Episode, startAt?: number, fromQueue?: PlayQueue) => {
      const audio = audioRef.current;
      if (!audio || !active) return;

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

      // Same episode already cued and healthy: just resume (or jump).
      if (isCurrent && audio.src && !audio.error) {
        if (startAt != null) {
          audio.currentTime = startAt;
          setPosition(startAt);
        }
        void audio.play();
        return;
      }

      await loadEpisode(ep, active, true, startAt);
      // Remember for next launch so one tap resumes where you left off.
      void cacheSet(active.id, LAST_PLAYED_KEY, ep);
    },
    [active, loadEpisode],
  );
  playRef.current = play;

  // On app start (or when switching to an account while idle), cue up that
  // account's last-played episode, paused at its resume point.
  const restoredForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!active || episodeRef.current) return;
    if (restoredForRef.current === active.id) return;
    restoredForRef.current = active.id;
    let cancelled = false;
    Promise.all([
      cacheGet<Episode>(active.id, LAST_PLAYED_KEY),
      cacheGet<PlayQueue | null>(active.id, LAST_QUEUE_KEY),
    ]).then(([ep, savedQueue]) => {
      if (cancelled || !ep || episodeRef.current) return;
      queueRef.current = savedQueue ?? null;
      setQueue(savedQueue ?? null);
      void loadEpisode(ep, active, false);
    });
    return () => {
      cancelled = true;
    };
  }, [active, loadEpisode]);

  // Find the current episode's neighbours: in the list it was played from
  // when there is one, else in its podcast by publication date, so "next"
  // continues a serialized story. For the latter, prefer the list cached by
  // the podcast page (works offline); fetch it once when the page was never
  // opened.
  const currentId = episode?.episodeid;
  const currentPodcastId = episode?.podcastid;
  useEffect(() => {
    const idx = queue ? queue.episodes.findIndex((e) => e.episodeid === currentId) : -1;
    if (queue && idx >= 0) {
      setPreviousEpisode(queue.episodes[idx - 1] ?? null);
      setNextEpisode(queue.episodes[idx + 1] ?? null);
      setUpNextSource(queue.source);
      return;
    }
    setPreviousEpisode(null);
    setNextEpisode(null);
    setUpNextSource(episodeRef.current?.podcastname || null);
    const account = playbackAccountRef.current;
    if (!account || currentId == null || currentId < 0 || currentPodcastId == null) return;
    let cancelled = false;
    const key = `podcast-episodes:${currentPodcastId}`;
    const pick = (fetched: Episode[] | undefined): boolean => {
      if (!fetched?.some((e) => e.episodeid === currentId)) return false;
      const list = chronological(fetched);
      const idx = list.findIndex((e) => e.episodeid === currentId);
      const ep = episodeRef.current;
      // Rows from the podcast endpoint can omit the podcast fields.
      const fill = (e: Episode | undefined) =>
        e
          ? { ...e, podcastid: currentPodcastId, podcastname: e.podcastname || ep?.podcastname || '' }
          : null;
      if (!cancelled) {
        setPreviousEpisode(fill(list[idx - 1]));
        setNextEpisode(fill(list[idx + 1]));
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
    };
  }, [currentId, currentPodcastId, queue]);

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

  const setSleepTimer = useCallback((minutes: number | null) => {
    sleepMinutesRef.current = minutes;
    setSleepMinutes(minutes);
    if (minutes == null) {
      setSleepUntil(null);
      setSleepRemaining(null);
    } else {
      setSleepUntil(Date.now() + minutes * 60_000);
      setSleepRemaining(minutes * 60);
    }
  }, []);

  const setSleepRepeat = useCallback((repeat: boolean) => {
    setSleepRepeatState(repeat);
    localStorage.setItem(SLEEP_REPEAT_KEY, repeat ? '1' : '0');
  }, []);

  // Check-in mode: every press of play re-arms the timer to its full
  // duration, so falling asleep costs at most one interval.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onPlay = () => {
      // Auto-advance isn't a check-in: the timer keeps counting down.
      if (autoAdvancingRef.current) return;
      const minutes = sleepMinutesRef.current;
      if (sleepRepeatRef.current && minutes != null) {
        setSleepUntil(Date.now() + minutes * 60_000);
        setSleepRemaining(minutes * 60);
      }
    };
    audio.addEventListener('play', onPlay);
    return () => audio.removeEventListener('play', onPlay);
  }, []);

  // Sleep timer: count down, then fade out over ~5s and pause.
  useEffect(() => {
    if (sleepUntil == null) return;
    const tick = window.setInterval(() => {
      const remaining = Math.ceil((sleepUntil - Date.now()) / 1000);
      if (remaining > 0) {
        setSleepRemaining(remaining);
        return;
      }
      window.clearInterval(tick);
      setSleepUntil(null);
      setSleepRemaining(null);
      // One-shot timers disarm on expiry; check-in timers stay armed and
      // re-start the countdown on the next play.
      if (!sleepRepeatRef.current) {
        sleepMinutesRef.current = null;
        setSleepMinutes(null);
      }
      const audio = audioRef.current;
      if (!audio || audio.paused) return; // expired while already paused
      const startVolume = audio.volume;
      const steps = 25;
      let step = 0;
      const fade = window.setInterval(() => {
        step++;
        try {
          // Some platforms (iOS) expose a read-only volume; fading is
          // best-effort there and we still pause at the end.
          audio.volume = Math.max(0, startVolume * (1 - step / steps));
        } catch {
          /* ignore */
        }
        if (step >= steps) {
          window.clearInterval(fade);
          audio.pause();
          try {
            audio.volume = startVolume;
          } catch {
            /* ignore */
          }
        }
      }, 200);
    }, 1000);
    return () => window.clearInterval(tick);
  }, [sleepUntil]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !episodeRef.current) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  }, []);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = seconds;
    setPosition(seconds);
  }, []);

  const skip = useCallback(
    (delta: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      seek(Math.max(0, Math.min(audio.duration || Infinity, audio.currentTime + delta)));
    },
    [seek],
  );

  const setRate = useCallback((r: number) => {
    setRateState(r);
    if (audioRef.current) audioRef.current.playbackRate = r;
  }, []);

  // Media session transport controls (lock screen / hardware keys).
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    // Explicit play/pause (not toggle): the notification's idea of the state
    // can drift from ours after the tab was frozen in the background.
    navigator.mediaSession.setActionHandler('play', () => void audioRef.current?.play());
    navigator.mediaSession.setActionHandler('pause', () => audioRef.current?.pause());
    navigator.mediaSession.setActionHandler('seekbackward', () => skip(-15));
    navigator.mediaSession.setActionHandler('seekforward', () => skip(30));
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime != null) seek(details.seekTime);
    });
  }, [seek, skip]);

  // Lock-screen previous/next; a null handler hides the button at list ends.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('previoustrack', previousEpisode ? playPrevious : null);
      navigator.mediaSession.setActionHandler('nexttrack', nextEpisode ? playNext : null);
    } catch {
      // Older browsers reject unknown actions.
    }
  }, [previousEpisode, nextEpisode, playPrevious, playNext]);

  // Keep the media session's bookkeeping current. Android uses this to decide
  // how long a paused session's notification survives in the background, and
  // it powers the notification's progress bar.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = episode ? (playing ? 'playing' : 'paused') : 'none';
  }, [playing, episode]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) {
      return;
    }
    const update = () => {
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
      try {
        navigator.mediaSession.setPositionState({
          duration: audio.duration,
          position: Math.min(audio.currentTime, audio.duration),
          playbackRate: audio.playbackRate,
        });
      } catch {
        // Invalid transient values (e.g. mid-load) — skip this update.
      }
    };
    audio.addEventListener('durationchange', update);
    audio.addEventListener('seeked', update);
    audio.addEventListener('ratechange', update);
    audio.addEventListener('play', update);
    audio.addEventListener('pause', update);
    const interval = window.setInterval(update, 5000);
    return () => {
      audio.removeEventListener('durationchange', update);
      audio.removeEventListener('seeked', update);
      audio.removeEventListener('ratechange', update);
      audio.removeEventListener('play', update);
      audio.removeEventListener('pause', update);
      window.clearInterval(interval);
    };
  }, []);

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
