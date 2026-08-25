import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Episode } from '../lib/types';
import { useActiveAccount } from '../lib/accounts';
import { usePlayer } from '../player/PlayerContext';
import { formatDate, formatDuration, stripHtml } from '../lib/format';
import { cacheSet, getDownload, getLocalPosition } from '../lib/db';
import {
  downloadEpisode,
  getDownloadProgress,
  removeDownloadedEpisode,
  subscribeDownloads,
} from '../lib/downloads';
import { saveEpisode, unsaveEpisode } from '../lib/api';
import { runOrQueue } from '../lib/sync';
import { markCompleted, markUncompleted } from '../lib/episodeActions';
import {
  CheckIcon,
  DownloadIcon,
  GridIcon,
  MoreIcon,
  PauseIcon,
  PlayIcon,
  StarIcon,
  TrashIcon,
} from './icons';

interface Props {
  episode: Episode;
  /** Hide the podcast name (e.g. on the podcast's own page). */
  hidePodcast?: boolean;
  /** Called after a save/unsave so list pages can refresh their cache. */
  onChanged?: () => void;
}

const LONG_PRESS_MS = 500;

export default function EpisodeRow({ episode, hidePodcast, onChanged }: Props) {
  const account = useActiveAccount();
  const player = usePlayer();
  const navigate = useNavigate();
  const [saved, setSaved] = useState(episode.saved);
  const [completed, setCompleted] = useState(episode.completed);
  const [localDownload, setLocalDownload] = useState(false);
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [downloading, setDownloading] = useState(false);
  const [localSeconds, setLocalSeconds] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => setSaved(episode.saved), [episode.saved]);
  useEffect(() => setCompleted(episode.completed), [episode.completed]);

  // Track local download presence + in-flight progress.
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      getDownload(account.id, episode.episodeid).then((d) => {
        if (!cancelled) setLocalDownload(Boolean(d));
      });
      const p = getDownloadProgress(episode.episodeid);
      if (!cancelled) {
        setDownloading(Boolean(p));
        setProgress(p?.fraction);
      }
    };
    check();
    const unsub = subscribeDownloads(check);
    return () => {
      cancelled = true;
      unsub();
    };
  }, [account.id, episode.episodeid]);

  // Local resume position beats server listenduration when fresher.
  useEffect(() => {
    getLocalPosition(account.id, episode.episodeid).then((p) => {
      if (p) setLocalSeconds(p.seconds);
    });
  }, [account.id, episode.episodeid]);

  const isCurrent = player.episode?.episodeid === episode.episodeid;
  const isPlaying = isCurrent && player.playing;

  const listened = isCurrent
    ? player.position
    : Math.max(localSeconds ?? 0, episode.listenduration ?? 0);
  const total = episode.episodeduration || 0;
  // A completed episode shows a full bar — that's its "played" indicator.
  const fraction = completed ? 1 : total > 0 ? Math.min(1, listened / total) : 0;
  const started = listened > 5 && !completed;

  // Long-press (iOS) / contextmenu (Android, desktop right-click) opens the
  // action sheet; the flag stops the release from also firing the row click.
  const pressTimerRef = useRef<number | null>(null);
  const pressStartRef = useRef<{ x: number; y: number } | null>(null);
  const longPressFiredRef = useRef(false);

  const clearPressTimer = () => {
    if (pressTimerRef.current != null) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    longPressFiredRef.current = false;
    pressStartRef.current = { x: e.clientX, y: e.clientY };
    clearPressTimer();
    pressTimerRef.current = window.setTimeout(() => {
      longPressFiredRef.current = true;
      setSheetOpen(true);
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const start = pressStartRef.current;
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) clearPressTimer();
  };

  const guardLongPress = (): boolean => {
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return true;
    }
    return false;
  };

  const onPlay = () => {
    if (guardLongPress()) return;
    if (isCurrent) player.toggle();
    else void player.play(episode);
  };

  const openDetail = () => {
    if (guardLongPress()) return;
    // Prime the cache so the detail page renders offline / on hard refresh.
    void cacheSet(account.id, `episode:${episode.episodeid}`, episode);
    navigate(`/episodes/${episode.episodeid}`, { state: { episode } });
  };

  const onToggleSave = useCallback(() => {
    const next = !saved;
    setSaved(next);
    void runOrQueue(
      account,
      next
        ? { kind: 'save_episode', episodeId: episode.episodeid }
        : { kind: 'unsave_episode', episodeId: episode.episodeid },
      () =>
        next ? saveEpisode(account, episode.episodeid) : unsaveEpisode(account, episode.episodeid),
    ).then(() => onChanged?.());
  }, [account, episode.episodeid, saved, onChanged]);

  const onDownload = () => {
    if (localDownload) {
      void removeDownloadedEpisode(account, episode.episodeid);
    } else {
      void downloadEpisode(account, episode).catch((e) => {
        console.error('Download failed', e);
        alert(`Download failed: ${(e as Error).message}`);
      });
    }
  };

  const onToggleCompleted = () => {
    const next = !completed;
    setCompleted(next);
    void (next ? markCompleted(account, episode) : markUncompleted(account, episode)).then(() =>
      onChanged?.(),
    );
  };

  const sheetAction = (fn: () => void) => () => {
    setSheetOpen(false);
    fn();
  };

  return (
    <>
      <div
        className="episode-row"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={clearPressTimer}
        onPointerLeave={clearPressTimer}
        onPointerCancel={clearPressTimer}
        onContextMenu={(e) => {
          e.preventDefault();
          longPressFiredRef.current = true;
          setSheetOpen(true);
        }}
      >
        {episode.episodeartwork ? (
          <img className="artwork" src={episode.episodeartwork} alt="" onClick={openDetail} loading="lazy" />
        ) : (
          <div className="artwork" onClick={openDetail} />
        )}
        <div className="episode-main" onClick={openDetail}>
          <div className={`episode-title${completed ? ' played' : ''}`}>
            {episode.episodetitle}
          </div>
          <div className="episode-meta">
            {!hidePodcast && episode.podcastname && <span>{episode.podcastname}</span>}
            <span>{formatDate(episode.episodepubdate)}</span>
            <span>
              {started
                ? `${formatDuration(Math.max(0, total - listened))} left`
                : formatDuration(total)}
            </span>
            {saved && <StarIcon filled className="meta-star" />}
            {downloading && (
              <span className="pill">
                {progress !== undefined ? `${Math.round(progress * 100)}%` : 'downloading…'}
              </span>
            )}
          </div>
          {(started || completed) && total > 0 && (
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${fraction * 100}%` }} />
            </div>
          )}
          {episode.episodedescription && (
            <div className="episode-meta" style={{ marginTop: 4 }}>
              <span
                style={{
                  display: '-webkit-box',
                  WebkitLineClamp: 1,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {stripHtml(episode.episodedescription)}
              </span>
            </div>
          )}
        </div>
        <div className="episode-actions">
          <button
            className="icon-btn"
            onClick={() => {
              if (!guardLongPress()) setSheetOpen(true);
            }}
            title="More"
          >
            <MoreIcon />
          </button>
          <button
            className={`icon-btn${localDownload ? ' active' : ''}`}
            onClick={() => {
              if (guardLongPress()) return;
              // Downloaded: the check is a status; removal lives in the
              // sheet behind an explicit label, never one accidental tap.
              if (localDownload) setSheetOpen(true);
              else onDownload();
            }}
            disabled={downloading}
            title={localDownload ? 'Downloaded' : 'Download episode'}
          >
            {downloading ? <span className="spinner" /> : localDownload ? <CheckIcon /> : <DownloadIcon />}
          </button>
          <button className="icon-btn" onClick={onPlay} title={isPlaying ? 'Pause' : 'Play'}>
            {isPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>
        </div>
      </div>

      {sheetOpen && (
        <div className="sheet-backdrop" onClick={() => setSheetOpen(false)}>
          <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">{episode.episodetitle}</div>
            <button onClick={sheetAction(onPlay)}>
              {isPlaying ? <PauseIcon /> : <PlayIcon />}
              {isPlaying ? 'Pause' : started ? 'Resume' : 'Play'}
            </button>
            <button onClick={sheetAction(onToggleCompleted)}>
              <CheckIcon />
              {completed ? 'Mark unplayed' : 'Mark played'}
            </button>
            <button onClick={sheetAction(onToggleSave)}>
              <StarIcon filled={saved} />
              {saved ? 'Unsave' : 'Save'}
            </button>
            <button onClick={sheetAction(onDownload)} disabled={downloading}>
              {localDownload ? <TrashIcon /> : <DownloadIcon />}
              {downloading
                ? 'Downloading…'
                : localDownload
                  ? 'Remove download'
                  : 'Download for offline'}
            </button>
            {episode.podcastid != null && (
              <button onClick={sheetAction(() => navigate(`/podcasts/${episode.podcastid}`))}>
                <GridIcon />
                Go to podcast
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
