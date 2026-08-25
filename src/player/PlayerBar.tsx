import { usePlayer } from './PlayerContext';
import { formatDuration } from '../lib/format';
import { PauseIcon, PlayIcon, SkipBackIcon, SkipFwdIcon } from '../components/icons';

const RATES = [1, 1.25, 1.5, 1.75, 2, 0.75];

export default function PlayerBar() {
  const { episode, playing, position, duration, rate, offlineSource, toggle, seek, skip, setRate } =
    usePlayer();

  if (!episode) return null;

  const total = duration || episode.episodeduration || 0;
  const fraction = total > 0 ? Math.min(1, position / total) : 0;

  const onSeekClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    if (total > 0) seek(x * total);
  };

  const cycleRate = () => {
    const idx = RATES.indexOf(rate);
    setRate(RATES[(idx + 1) % RATES.length]);
  };

  return (
    <div className="player-bar">
      <div className="player-seek" onClick={onSeekClick}>
        <div className="track" />
        <div className="fill" style={{ width: `${fraction * 100}%` }} />
      </div>
      {episode.episodeartwork ? (
        <img className="artwork" src={episode.episodeartwork} alt="" />
      ) : (
        <div className="artwork" />
      )}
      <div className="player-info">
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
        <button className="icon-btn" onClick={cycleRate} title="Playback speed">
          <span style={{ fontSize: 11, fontWeight: 700 }}>{rate}x</span>
        </button>
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
  );
}
