import { useEffect, useMemo, useRef } from 'react';
import type { Episode } from '../lib/types';
import { useActiveAccount } from '../lib/accounts';
import { fetchTranscriptContent, getEpisodeTranscriptSources } from '../lib/api';
import { parseTranscript, type TranscriptSegment } from '../lib/transcript';
import { useCached } from '../lib/useCached';
import { usePlayer } from '../player/PlayerContext';
import { formatDuration } from '../lib/format';

/**
 * Podcasting 2.0 feed transcript for an episode: timestamped lines, tap to
 * jump, with the current line highlighted while this episode plays. Parsed
 * segments are cached per account so the transcript reads fine offline.
 */
interface Props {
  episode: Episode;
  /** Keep the active line in view inside the nearest scroll container.
   * Only safe when the view has its own scroll pane (the full player). */
  autoScroll?: boolean;
  /** Plain reading view: no timestamps, no tap-to-seek (the full player). */
  readOnly?: boolean;
}

export default function TranscriptView({ episode, autoScroll, readOnly }: Props) {
  const account = useActiveAccount();
  const player = usePlayer();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastUserScrollRef = useRef(0);

  const transcript = useCached<TranscriptSegment[] | null>(
    account.id,
    `transcript:${episode.episodeid}`,
    async () => {
      const sources = await getEpisodeTranscriptSources(account, episode.episodeid);
      if (sources.length === 0) return null;
      // Prefer machine-friendly formats: JSON, then SRT, then VTT/anything.
      const score = (mime: string | null) => {
        const m = (mime ?? '').toLowerCase();
        if (m.includes('json')) return 0;
        if (m.includes('srt') || m.includes('subrip')) return 1;
        if (m.includes('vtt')) return 2;
        return 3;
      };
      const sorted = [...sources].sort((a, b) => score(a.mime_type) - score(b.mime_type));
      for (const source of sorted) {
        const content = await fetchTranscriptContent(account, source.url!);
        if (!content) continue;
        const segments = parseTranscript(content, source.mime_type);
        if (segments.length > 0) return segments;
      }
      return null;
    },
  );

  const isCurrent = player.episode?.episodeid === episode.episodeid;
  const segments = transcript.data ?? [];

  // Index of the line currently being spoken (last one at or before position).
  const activeIndex = useMemo(() => {
    if (!isCurrent) return -1;
    let idx = -1;
    for (let i = 0; i < segments.length; i++) {
      const start = segments[i].start;
      if (start != null && start <= player.position) idx = i;
      else if (start != null && start > player.position) break;
    }
    return idx;
  }, [segments, isCurrent, player.position]);

  // Follow the audio, but yield to the reader: a manual scroll pauses
  // auto-follow for a few seconds.
  useEffect(() => {
    if (!autoScroll || activeIndex < 0) return;
    if (Date.now() - lastUserScrollRef.current < 5000) return;
    const container = containerRef.current?.parentElement;
    const line = containerRef.current?.children[activeIndex] as HTMLElement | undefined;
    if (!container || !line) return;
    const target = line.offsetTop - container.clientHeight / 3;
    container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }, [autoScroll, activeIndex]);

  useEffect(() => {
    if (!autoScroll) return;
    const container = containerRef.current?.parentElement;
    if (!container) return;
    const onWheel = () => {
      lastUserScrollRef.current = Date.now();
    };
    container.addEventListener('wheel', onWheel, { passive: true });
    container.addEventListener('touchmove', onWheel, { passive: true });
    return () => {
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('touchmove', onWheel);
    };
  }, [autoScroll, transcript.data]);

  if (transcript.loading && !transcript.data) {
    return <div className="notice">Looking for a transcript…</div>;
  }
  if (transcript.error && transcript.data === undefined) {
    return <div className="error-box">Couldn't load the transcript: {transcript.error.message}</div>;
  }
  if (transcript.data === null || segments.length === 0) {
    return <div className="notice">This podcast doesn't publish a transcript for this episode.</div>;
  }

  const onLineClick = (segment: TranscriptSegment) => {
    if (readOnly || segment.start == null) return;
    void player.play(episode, segment.start);
  };

  return (
    <div className="transcript" ref={containerRef}>
      {segments.map((segment, i) => (
        <div
          key={i}
          className={`transcript-line${i === activeIndex ? ' active' : ''}${!readOnly && segment.start != null ? ' seekable' : ''}`}
          onClick={() => onLineClick(segment)}
        >
          {!readOnly && segment.start != null && (
            <span className="transcript-time">{formatDuration(segment.start)}</span>
          )}
          <span className="transcript-text">
            {segment.speaker && <strong>{segment.speaker}: </strong>}
            {segment.text}
          </span>
        </div>
      ))}
    </div>
  );
}
