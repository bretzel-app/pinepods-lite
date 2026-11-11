import type { SavedEpisode, SkipView, TranscriptInfo } from './types';

export type Step = { kind: 'skip' | 'done' | 'download' | 'transcribe' | 'wait' | 'failed' | 'empty' | 'detect' };

/** Whether nextStep needs the episode's transcript; it is only fetched then (it can be large). */
export function needsTranscript(ep: SavedEpisode, skips: SkipView): boolean {
  return !ep.isYoutube && !skips.scanned && ep.downloaded;
}

/** `transcript` is only read when needsTranscript says so; pass null otherwise. */
export function nextStep(ep: SavedEpisode, skips: SkipView, transcript: TranscriptInfo | null): Step {
  if (ep.isYoutube) return { kind: 'skip' };
  if (skips.scanned) return { kind: 'done' };
  if (!ep.downloaded) return { kind: 'download' };
  if (!transcript) return { kind: 'transcribe' };
  switch (transcript.status) {
    case 'pending':
    case 'running':
      return { kind: 'wait' };
    case 'failed':
      return { kind: 'failed' };
    default:
      // Claude on an empty transcript would record "no ads" for good.
      return transcript.segments.length === 0 ? { kind: 'empty' } : { kind: 'detect' };
  }
}
