/**
 * Parses podcast transcript files (Podcasting 2.0) into timestamped segments.
 * Supported: SRT, WebVTT, Podcast Index JSON; anything else falls back to
 * plain text paragraphs without timestamps.
 */

export interface TranscriptSegment {
  /** seconds; null when the source has no timing (plain text) */
  start: number | null;
  text: string;
  speaker?: string;
}

/** "01:02:03,500", "02:03.5" or "63.2" → seconds */
function parseTimestamp(raw: string): number | null {
  const ts = raw.trim().replace(',', '.');
  const parts = ts.split(':');
  if (parts.some((p) => p === '' || Number.isNaN(Number(p)))) return null;
  const nums = parts.map(Number);
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  if (nums.length === 1) return nums[0];
  return null;
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, '').trim();
}

/** SRT and WebVTT share the "ts --> ts" cue shape. */
function parseCues(content: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const blocks = content.replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx === -1) continue;
    const start = parseTimestamp(lines[timeIdx].split('-->')[0]);
    const text = stripTags(lines.slice(timeIdx + 1).join(' '));
    if (text) segments.push({ start, text });
  }
  return segments;
}

interface JsonSegment {
  startTime?: number;
  start?: number;
  body?: string;
  text?: string;
  speaker?: string;
}

/** Word-level JSON transcripts get grouped into readable lines. */
function groupWordLevel(segments: TranscriptSegment[]): TranscriptSegment[] {
  const avgLen =
    segments.reduce((sum, s) => sum + s.text.length, 0) / Math.max(1, segments.length);
  if (avgLen > 20) return segments;

  const grouped: TranscriptSegment[] = [];
  let current: TranscriptSegment | null = null;
  for (const seg of segments) {
    const speakerChanged = current && seg.speaker !== current.speaker;
    const full = current && current.text.length > 160;
    const sentenceEnd = current && /[.!?]$/.test(current.text) && current.text.length > 60;
    if (!current || speakerChanged || full || sentenceEnd) {
      if (current) grouped.push(current);
      current = { ...seg };
    } else {
      current.text += ` ${seg.text}`;
    }
  }
  if (current) grouped.push(current);
  return grouped;
}

function parseJson(content: string): TranscriptSegment[] {
  const data = JSON.parse(content) as { segments?: JsonSegment[] } | JsonSegment[];
  const raw = Array.isArray(data) ? data : (data.segments ?? []);
  const segments = raw
    .map((s) => ({
      start: typeof s.startTime === 'number' ? s.startTime : (s.start ?? null),
      text: stripTags(String(s.body ?? s.text ?? '')),
      speaker: s.speaker || undefined,
    }))
    .filter((s) => s.text);
  return groupWordLevel(segments);
}

function parsePlainText(content: string): TranscriptSegment[] {
  return stripTags(content)
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((text) => ({ start: null, text }));
}

export function parseTranscript(content: string, mimeType?: string | null): TranscriptSegment[] {
  const trimmed = content.trim();
  const mime = (mimeType ?? '').toLowerCase();
  try {
    if (mime.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return parseJson(trimmed);
    }
  } catch {
    // Mislabeled JSON — fall through to the other formats.
  }
  if (trimmed.includes('-->')) return parseCues(trimmed);
  return parsePlainText(trimmed);
}
