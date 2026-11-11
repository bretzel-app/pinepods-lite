import type { SavedEpisode, SkipView, TranscriptInfo } from './types';

export type Step = { kind: 'skip' | 'done' | 'download' | 'transcribe' | 'wait' | 'failed' | 'detect' };

export function nextStep(ep: SavedEpisode, transcript: TranscriptInfo | null, skips: SkipView): Step {
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
      return { kind: 'detect' };
  }
}
