import { fetchTranscriptContent, getEpisodeTranscriptSources, getGeneratedTranscript } from './api';
import { parseTranscript, type TranscriptSegment } from './transcript';
import type { Account } from './types';

/**
 * The episode's transcript: PinePods' own when it has a complete one (its times fit the server's
 * copy, which is what starred episodes play), else one the podcast's feed publishes (Podcasting
 * 2.0). Null when there is neither.
 */
export async function loadEpisodeTranscript(
  account: Account,
  episodeId: number,
): Promise<TranscriptSegment[] | null> {
  try {
    const own = await getGeneratedTranscript(account, episodeId);
    if (own) return own;
  } catch {
    // Older servers, or no access: the feed's transcript may still exist.
  }
  return loadFeedTranscript(account, episodeId);
}

async function loadFeedTranscript(account: Account, episodeId: number): Promise<TranscriptSegment[] | null> {
  const sources = await getEpisodeTranscriptSources(account, episodeId);
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
}
