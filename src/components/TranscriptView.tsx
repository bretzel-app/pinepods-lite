import { useMemo } from 'react';
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
export default function TranscriptView({ episode }: { episode: Episode }) {
  const account = useActiveAccount();
  const player = usePlayer();

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
    if (segment.start == null) return;
    void player.play(episode, segment.start);
  };

  return (
    <div className="transcript">
      {segments.map((segment, i) => (
        <div
          key={i}
          className={`transcript-line${i === activeIndex ? ' active' : ''}${segment.start != null ? ' seekable' : ''}`}
          onClick={() => onLineClick(segment)}
        >
          {segment.start != null && (
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
