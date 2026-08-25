import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import type { Episode } from '../lib/types';
import { useActiveAccount } from '../lib/accounts';
import { getEpisodeMetadata, saveEpisode, unsaveEpisode } from '../lib/api';
import { useCached } from '../lib/useCached';
import { usePlayer } from '../player/PlayerContext';
import { formatDate, formatDuration } from '../lib/format';
import { looksLikeHtml, sanitizeHtml } from '../lib/sanitize';
import { getDownload, getLocalPosition } from '../lib/db';
import {
  downloadEpisode,
  getDownloadProgress,
  removeDownloadedEpisode,
  subscribeDownloads,
} from '../lib/downloads';
import { runOrQueue } from '../lib/sync';
import { markCompleted, markUncompleted } from '../lib/episodeActions';
import { CheckIcon, DownloadIcon, PauseIcon, PlayIcon, StarIcon, TrashIcon } from '../components/icons';

export default function EpisodeDetail() {
  const account = useActiveAccount();
  const { episodeId } = useParams();
  const id = Number(episodeId);
  const location = useLocation();
  const player = usePlayer();

  // Instant render from navigation state; cache + server refresh behind it.
  const stateEpisode = (location.state as { episode?: Episode } | null)?.episode;
  const cached = useCached(account.id, `episode:${id}`, () => getEpisodeMetadata(account, id));
  const episode = cached.data ?? (stateEpisode?.episodeid === id ? stateEpisode : undefined);

  const [saved, setSaved] = useState<boolean | null>(null);
  const [completed, setCompleted] = useState<boolean | null>(null);
  const [localDownload, setLocalDownload] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [localSeconds, setLocalSeconds] = useState(0);

  useEffect(() => {
    if (episode && saved === null) setSaved(episode.saved);
  }, [episode, saved]);

  useEffect(() => {
    if (episode && completed === null) setCompleted(episode.completed);
  }, [episode, completed]);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      getDownload(account.id, id).then((d) => {
        if (!cancelled) setLocalDownload(Boolean(d));
      });
      const p = getDownloadProgress(id);
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
  }, [account.id, id]);

  useEffect(() => {
    getLocalPosition(account.id, id).then((p) => {
      if (p) setLocalSeconds(p.seconds);
    });
  }, [account.id, id]);

  const isCurrent = player.episode?.episodeid === id;
  const isPlaying = isCurrent && player.playing;
  const isCompleted = completed ?? episode?.completed ?? false;

  // When playback of this episode finishes while the page is open, the player
  // flips its copy to completed before any cache refresh — mirror that here.
  useEffect(() => {
    if (isCurrent && player.episode?.completed) setCompleted(true);
  }, [isCurrent, player.episode?.completed]);
  const listened = isCurrent ? player.position : Math.max(localSeconds, episode?.listenduration ?? 0);
  const total = episode?.episodeduration ?? 0;
  const started = listened > 5 && !isCompleted;

  const onPlay = () => {
    if (!episode) return;
    if (isCurrent) player.toggle();
    else void player.play(episode);
  };

  const onToggleSave = useCallback(() => {
    if (!episode) return;
    const next = !saved;
    setSaved(next);
    void runOrQueue(
      account,
      next ? { kind: 'save_episode', episodeId: id } : { kind: 'unsave_episode', episodeId: id },
      () => (next ? saveEpisode(account, id) : unsaveEpisode(account, id)),
    );
  }, [account, episode, id, saved]);

  const onDownload = () => {
    if (!episode) return;
    if (localDownload) void removeDownloadedEpisode(account, id);
    else
      void downloadEpisode(account, episode).catch((e) =>
        alert(`Download failed: ${(e as Error).message}`),
      );
  };

  const onToggleCompleted = () => {
    if (!episode) return;
    const next = !isCompleted;
    setCompleted(next);
    void (next ? markCompleted(account, episode) : markUncompleted(account, episode));
  };

  if (!episode) {
    return (
      <div>
        {cached.loading && <div className="notice">Loading episode…</div>}
        {cached.error && (
          <div className="error-box">
            Couldn't load this episode{navigator.onLine ? '' : ' (offline and not cached)'}:{' '}
            {cached.error.message}
          </div>
        )}
      </div>
    );
  }

  const description = episode.episodedescription ?? '';

  return (
    <div className="episode-detail">
      <div className="pod-header">
        {episode.episodeartwork ? <img src={episode.episodeartwork} alt="" /> : <div />}
        <div className="info">
          <h1>{episode.episodetitle}</h1>
          {episode.podcastid ? (
            <Link to={`/podcasts/${episode.podcastid}`} className="detail-podcast-link">
              {episode.podcastname}
            </Link>
          ) : (
            <div className="muted" style={{ fontSize: 13 }}>{episode.podcastname}</div>
          )}
          <div className="episode-meta" style={{ marginTop: 6 }}>
            <span>{formatDate(episode.episodepubdate)}</span>
            <span>
              {started ? `${formatDuration(Math.max(0, total - listened))} left` : formatDuration(total)}
            </span>
            {isCompleted && <span className="pill">played</span>}
            {localDownload && <span className="pill offline">offline</span>}
          </div>
          {started && total > 0 && (
            <div className="progress-track" style={{ marginTop: 10 }}>
              <div className="progress-fill" style={{ width: `${Math.min(1, listened / total) * 100}%` }} />
            </div>
          )}
        </div>
      </div>

      <div className="detail-actions">
        <button className="btn" onClick={onPlay}>
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
          {isPlaying ? 'Pause' : started ? 'Resume' : 'Play'}
        </button>
        <button className={`btn secondary${saved ? ' saved' : ''}`} onClick={onToggleSave}>
          <StarIcon filled={Boolean(saved)} />
          {saved ? 'Saved' : 'Save'}
        </button>
        <button className="btn secondary" onClick={onToggleCompleted}>
          <CheckIcon />
          {isCompleted ? 'Mark unplayed' : 'Mark played'}
        </button>
        <button className="btn secondary" onClick={onDownload} disabled={downloading}>
          {downloading ? (
            <>
              <span className="spinner" />
              {progress !== undefined ? ` ${Math.round(progress * 100)}%` : ' Downloading…'}
            </>
          ) : localDownload ? (
            <>
              <TrashIcon /> Remove download
            </>
          ) : (
            <>
              <DownloadIcon /> Download
            </>
          )}
        </button>
      </div>

      <h2 style={{ fontSize: 15, margin: '20px 0 8px' }}>Description</h2>
      {looksLikeHtml(description) ? (
        <div className="shownotes" dangerouslySetInnerHTML={{ __html: sanitizeHtml(description) }} />
      ) : (
        <div className="shownotes">
          {description.split(/\n{2,}/).map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>
      )}
    </div>
  );
}
