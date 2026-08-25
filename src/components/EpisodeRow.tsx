import { useCallback, useEffect, useState } from 'react';
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
import { CheckIcon, DownloadIcon, PauseIcon, PlayIcon, StarIcon, TrashIcon } from './icons';

interface Props {
  episode: Episode;
  /** Hide the podcast name (e.g. on the podcast's own page). */
  hidePodcast?: boolean;
  /** Called after a save/unsave so list pages can refresh their cache. */
  onChanged?: () => void;
}

export default function EpisodeRow({ episode, hidePodcast, onChanged }: Props) {
  const account = useActiveAccount();
  const player = usePlayer();
  const navigate = useNavigate();
  const [saved, setSaved] = useState(episode.saved);
  const [localDownload, setLocalDownload] = useState(false);
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [downloading, setDownloading] = useState(false);
  const [localSeconds, setLocalSeconds] = useState<number | null>(null);

  useEffect(() => setSaved(episode.saved), [episode.saved]);

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
  const fraction = total > 0 ? Math.min(1, listened / total) : 0;
  const started = listened > 5 && !episode.completed;

  const onPlay = () => {
    if (isCurrent) player.toggle();
    else void player.play(episode);
  };

  const openDetail = () => {
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

  return (
    <div className="episode-row">
      {episode.episodeartwork ? (
        <img className="artwork" src={episode.episodeartwork} alt="" onClick={openDetail} loading="lazy" />
      ) : (
        <div className="artwork" onClick={openDetail} />
      )}
      <div className="episode-main" onClick={openDetail}>
        <div className={`episode-title${episode.completed ? ' played' : ''}`}>
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
          {episode.completed && (
            <span className="pill">
              <CheckIcon /> played
            </span>
          )}
          {localDownload && <span className="pill offline">offline</span>}
          {downloading && (
            <span className="pill">
              {progress !== undefined ? `${Math.round(progress * 100)}%` : 'downloading…'}
            </span>
          )}
        </div>
        {started && total > 0 && (
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
          className={`icon-btn${saved ? ' active' : ''}`}
          onClick={onToggleSave}
          title={saved ? 'Remove from favorites' : 'Add to favorites'}
        >
          <StarIcon filled={saved} />
        </button>
        <button
          className={`icon-btn${localDownload ? ' active' : ''}`}
          onClick={onDownload}
          disabled={downloading}
          title={localDownload ? 'Remove download' : 'Download for offline'}
        >
          {downloading ? (
            <span className="spinner" />
          ) : localDownload ? (
            <TrashIcon />
          ) : (
            <DownloadIcon />
          )}
        </button>
        <button className="icon-btn" onClick={onPlay} title={isPlaying ? 'Pause' : 'Play'}>
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
      </div>
    </div>
  );
}
