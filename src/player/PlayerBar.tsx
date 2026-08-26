import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePlayer } from './PlayerContext';
import { formatDuration } from '../lib/format';
import { useBackDismiss } from '../lib/useBackDismiss';
import { PauseIcon, PlayIcon, SkipBackIcon, SkipFwdIcon } from '../components/icons';
import FullPlayer from './FullPlayer';

export default function PlayerBar() {
  const { episode, playing, position, duration, offlineSource, toggle, seek, skip } = usePlayer();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const { openWithHistory, close } = useBackDismiss(expanded, setExpanded);

  if (!episode) return null;

  const total = duration || episode.episodeduration || 0;
  const fraction = total > 0 ? Math.min(1, position / total) : 0;

  const onSeekClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    if (total > 0) seek(x * total);
  };

  return (
    <>
      {expanded && (
        <FullPlayer
          onClose={() => close()}
          onNavigate={(path, state) => close(() => navigate(path, { state }))}
        />
      )}
      <div className="player-bar">
        <div className="player-seek" onClick={onSeekClick}>
          <div className="track" />
          <div className="fill" style={{ width: `${fraction * 100}%` }} />
        </div>
        {episode.episodeartwork ? (
          <img className="artwork" src={episode.episodeartwork} alt="" onClick={openWithHistory} />
        ) : (
          <div className="artwork" onClick={openWithHistory} />
        )}
        <div className="player-info" onClick={openWithHistory} title="Open player">
          <div className="title">{episode.episodetitle}</div>
          <div className="sub">
            {episode.podcastname}
            {offlineSource ? ' · offline copy' : ''}
          </div>
        </div>
        <div className="player-time" title="Time remaining">
          -{formatDuration(Math.max(0, total - position))}
        </div>
        <div className="player-controls">
          <button className="icon-btn" onClick={() => skip(-15)} title="Back 15s">
            <SkipBackIcon />
          </button>
          <button className="play" onClick={toggle} title={playing ? 'Pause' : 'Play'}>
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button className="icon-btn" onClick={() => skip(30)} title="Forward 30s">
            <SkipFwdIcon />
          </button>
        </div>
      </div>
    </>
  );
}
