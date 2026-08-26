import { useState } from 'react';
import { usePlayer } from './PlayerContext';
import { useAccounts } from '../lib/accounts';
import { cacheSet } from '../lib/db';
import { formatDuration } from '../lib/format';
import { MoonIcon, PauseIcon, PlayIcon, SkipBackIcon, SkipFwdIcon } from '../components/icons';
import TranscriptView from '../components/TranscriptView';

const RATES = [1, 1.25, 1.5, 1.75, 2, 0.75];
const SLEEP_MINUTES = [5, 15, 30, 45, 60];

interface Props {
  onClose: () => void;
  /** Close the overlay (consuming its history entry) and then navigate. */
  onNavigate: (path: string, state?: unknown) => void;
}

export default function FullPlayer({ onClose, onNavigate }: Props) {
  const {
    episode,
    playing,
    position,
    duration,
    rate,
    offlineSource,
    sleepRemaining,
    sleepMinutes,
    sleepRepeat,
    toggle,
    seek,
    skip,
    setRate,
    setSleepTimer,
    setSleepRepeat,
  } = usePlayer();
  const { active } = useAccounts();
  const [sleepOpen, setSleepOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  if (!episode) return null;

  const total = duration || episode.episodeduration || 0;

  const cycleRate = () => {
    const idx = RATES.indexOf(rate);
    setRate(RATES[(idx + 1) % RATES.length]);
  };

  const openDetail = () => {
    // Prime the cache so the detail page renders offline / on hard refresh.
    if (active) void cacheSet(active.id, `episode:${episode.episodeid}`, episode);
    onNavigate(`/episodes/${episode.episodeid}`, { episode });
  };

  return (
    <div className="full-player">
      <div className="full-player-top">
        <button className="icon-btn" onClick={onClose} title="Minimize player">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="m5 9 7 7 7-7" />
          </svg>
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {offlineSource && <span className="pill offline">playing offline copy</span>}
          <button
            className={`icon-btn${transcriptOpen ? ' active' : ''}`}
            onClick={() => setTranscriptOpen((o) => !o)}
            title="Transcript"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M5 6h14M5 10h14M5 14h10M5 18h7" />
            </svg>
          </button>
        </div>
      </div>

      {transcriptOpen ? (
        <div className="fp-transcript">
          <TranscriptView episode={episode} autoScroll readOnly />
        </div>
      ) : (
        <div className="full-player-art">
          {episode.episodeartwork ? <img src={episode.episodeartwork} alt="" /> : <div className="art-placeholder" />}
        </div>
      )}

      <div className="full-player-meta">
        <button className="fp-title" onClick={openDetail} title="Show details">
          {episode.episodetitle}
        </button>
        <div className="fp-podcast">{episode.podcastname}</div>
      </div>

      <div className="full-player-seek">
        <input
          type="range"
          min={0}
          max={Math.max(1, Math.floor(total))}
          value={Math.floor(position)}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <div className="fp-times">
          <span>{formatDuration(position)}</span>
          <span>-{formatDuration(Math.max(0, total - position))}</span>
        </div>
      </div>

      <div className="full-player-controls">
        <button className="icon-btn" onClick={cycleRate} title="Playback speed">
          <span style={{ fontSize: 13, fontWeight: 700 }}>{rate}x</span>
        </button>
        <button className="icon-btn big" onClick={() => skip(-15)} title="Back 15s">
          <SkipBackIcon />
        </button>
        <button className="fp-play" onClick={toggle} title={playing ? 'Pause' : 'Play'}>
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button className="icon-btn big" onClick={() => skip(30)} title="Forward 30s">
          <SkipFwdIcon />
        </button>
        <button
          className={`icon-btn${sleepMinutes != null ? ' active' : ''}`}
          onClick={() => setSleepOpen((o) => !o)}
          title="Sleep timer"
        >
          {sleepRemaining != null ? (
            <span style={{ fontSize: 11, fontWeight: 700 }}>
              {Math.max(1, Math.ceil(sleepRemaining / 60))}m
            </span>
          ) : (
            <MoonIcon />
          )}
        </button>
      </div>

      {sleepOpen && (
        <div className="sleep-panel">
          <div className="sleep-options">
            <span className="muted" style={{ fontSize: 12.5 }}>
              Sleep in
            </span>
            {SLEEP_MINUTES.map((m) => (
              <button
                key={m}
                className="btn secondary sleep-pill"
                onClick={() => {
                  setSleepTimer(m);
                  setSleepOpen(false);
                }}
              >
                {m}m
              </button>
            ))}
            {sleepMinutes != null && (
              <button
                className="btn secondary sleep-pill"
                onClick={() => {
                  setSleepTimer(null);
                  setSleepOpen(false);
                }}
              >
                Off
              </button>
            )}
          </div>
          <label className="sleep-repeat">
            <input
              type="checkbox"
              checked={sleepRepeat}
              onChange={(e) => setSleepRepeat(e.target.checked)}
            />
            Check-in mode: pressing play restarts the timer, so dozing off only costs one interval
          </label>
        </div>
      )}
      {!sleepOpen && sleepMinutes != null && sleepRemaining == null && !playing && (
        <div className="notice" style={{ textAlign: 'center' }}>
          Sleep check-in: press play to keep listening for another {sleepMinutes} min
        </div>
      )}

      <button className="btn secondary fp-notes" onClick={openDetail}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ width: 16, height: 16 }}>
          <path d="M5 5h14M5 10h14M5 15h9" />
        </svg>
        Show details
      </button>
    </div>
  );
}
