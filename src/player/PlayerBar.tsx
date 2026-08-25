import { useState } from 'react';
import { usePlayer } from './PlayerContext';
import { formatDuration } from '../lib/format';
import { PauseIcon, PlayIcon, SkipBackIcon, SkipFwdIcon } from '../components/icons';
import FullPlayer from './FullPlayer';

export default function PlayerBar() {
  const { episode, playing, position, duration, offlineSource, toggle, seek, skip } = usePlayer();
  const [expanded, setExpanded] = useState(false);

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
      {expanded && <FullPlayer onClose={() => setExpanded(false)} />}
      <div className="player-bar">
        <div className="player-seek" onClick={onSeekClick}>
          <div className="track" />
          <div className="fill" style={{ width: `${fraction * 100}%` }} />
        </div>
        {episode.episodeartwork ? (
          <img className="artwork" src={episode.episodeartwork} alt="" onClick={() => setExpanded(true)} />
        ) : (
          <div className="artwork" onClick={() => setExpanded(true)} />
        )}
        <div className="player-info" onClick={() => setExpanded(true)} title="Open player">
          <div className="title">{episode.episodetitle}</div>
          <div className="sub">
            {episode.podcastname}
            {offlineSource ? ' · offline copy' : ''}
          </div>
        </div>
        <div className="player-time">
          {formatDuration(position)} / {formatDuration(total)}
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
