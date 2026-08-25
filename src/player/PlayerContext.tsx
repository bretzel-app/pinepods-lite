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
import { getDownloadBlob, getLocalPosition, putLocalPosition } from '../lib/db';
import { recordListenDuration, serverStreamUrl } from '../lib/api';
import { runOrQueue } from '../lib/sync';
import { useAccounts } from '../lib/accounts';

const SYNC_INTERVAL_MS = 15_000;

interface PlayerState {
  episode: Episode | null;
  playing: boolean;
  position: number;
  duration: number;
  rate: number;
  /** True when playing from a locally downloaded blob. */
  offlineSource: boolean;
  play: (episode: Episode) => Promise<void>;
  toggle: () => void;
  seek: (seconds: number) => void;
  skip: (deltaSeconds: number) => void;
  setRate: (rate: number) => void;
}

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

  if (!audioRef.current && typeof Audio !== 'undefined') {
    audioRef.current = new Audio();
    audioRef.current.preload = 'metadata';
  }

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

  const episodeRef = useRef<Episode | null>(null);
  episodeRef.current = episode;

  const syncToServer = useCallback(async (seconds: number) => {
    const account = playbackAccountRef.current;
    const ep = episodeRef.current;
    if (!account || !ep || seconds <= 0) return;
    await persistPosition(seconds, true);
    await runOrQueue(account, { kind: 'record_position', episodeId: ep.episodeid, seconds }, () =>
      recordListenDuration(account, ep.episodeid, seconds),
    );
  }, [persistPosition]);

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

  const play = useCallback(
    async (ep: Episode) => {
      const audio = audioRef.current;
      if (!audio || !active) return;

      // Same episode: just resume.
      if (episodeRef.current?.episodeid === ep.episodeid && audio.src) {
        void audio.play();
        return;
      }

      // Flush the outgoing episode's position before switching.
      if (episodeRef.current && audio.currentTime > 0) {
        void syncToServer(audio.currentTime);
      }

      playbackAccountRef.current = active;
      setEpisode(ep);
      setPosition(0);
      setDuration(ep.episodeduration || 0);

      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }

      // Source priority: local download → enclosure URL → server stream.
      const blob = await getDownloadBlob(active.id, ep.episodeid);
      if (blob) {
        blobUrlRef.current = URL.createObjectURL(blob);
        audio.src = blobUrlRef.current;
        setOfflineSource(true);
      } else if (ep.downloaded) {
        // Downloaded on the server — stream from there (also avoids dead CDN links).
        audio.src = serverStreamUrl(active, ep.episodeid);
        setOfflineSource(false);
      } else {
        audio.src = ep.episodeurl;
        setOfflineSource(false);
      }

      // Resume point: freshest of local (offline-safe) and server-known position.
      const local = await getLocalPosition(active.id, ep.episodeid);
      const serverSeconds = ep.listenduration ?? 0;
      let resumeAt = Math.max(local?.seconds ?? 0, serverSeconds);
      const total = ep.episodeduration || 0;
      if (ep.completed || (total > 0 && resumeAt > total - 15)) resumeAt = 0;

      audio.playbackRate = rate;
      if (resumeAt > 3) {
        // Apply after metadata loads; setting currentTime too early is ignored.
        const apply = () => {
          audio.currentTime = resumeAt;
          audio.removeEventListener('loadedmetadata', apply);
        };
        audio.addEventListener('loadedmetadata', apply);
      }
      void audio.play();

      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: ep.episodetitle,
          artist: ep.podcastname,
          artwork: ep.episodeartwork ? [{ src: ep.episodeartwork }] : [],
        });
      }
    },
    [active, rate, syncToServer],
  );

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
    navigator.mediaSession.setActionHandler('play', () => toggle());
    navigator.mediaSession.setActionHandler('pause', () => toggle());
    navigator.mediaSession.setActionHandler('seekbackward', () => skip(-15));
    navigator.mediaSession.setActionHandler('seekforward', () => skip(30));
  }, [toggle, skip]);

  const value = useMemo(
    () => ({
      episode,
      playing,
      position,
      duration,
      rate,
      offlineSource,
      play,
      toggle,
      seek,
      skip,
      setRate,
    }),
    [episode, playing, position, duration, rate, offlineSource, play, toggle, seek, skip, setRate],
  );

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer(): PlayerState {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used inside PlayerProvider');
  return ctx;
}
