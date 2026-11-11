import type { AdRange, SavedEpisode, Seg } from './types';

export class InvalidOutput extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOutput';
  }
}

export function parseClaudeResult(stdout: string): unknown {
  let res: any;
  try {
    res = JSON.parse(stdout);
  } catch {
    throw new InvalidOutput('Claude output is not JSON');
  }
  if (!res || typeof res !== 'object') throw new InvalidOutput('Claude output is not an object');
  if (res.is_error) throw new InvalidOutput(`Claude reported an error${res.subtype ? `: ${res.subtype}` : ''}`);
  if (res.structured_output !== undefined && res.structured_output !== null) return res.structured_output;
  if (typeof res.result === 'string') {
    try {
      return JSON.parse(res.result);
    } catch {
      throw new InvalidOutput('Claude result is not JSON');
    }
  }
  throw new InvalidOutput('Claude result has no structured_output');
}

export function validateRanges(raw: unknown, lengthSec: number): AdRange[] {
  const ads = (raw as any)?.ads;
  if (!Array.isArray(ads)) throw new InvalidOutput('missing ads array');
  const ranges: AdRange[] = ads.map((a: any) => {
    const { start, end, label } = a ?? {};
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) {
      throw new InvalidOutput('range start/end must be numbers');
    }
    if (start < 0 || start >= end) throw new InvalidOutput(`bad range ${start}-${end}`);
    if (end > lengthSec) throw new InvalidOutput(`range ${start}-${end} exceeds episode length ${lengthSec}`);
    if (end - start > lengthSec / 2) throw new InvalidOutput(`range ${start}-${end} exceeds 50% of the episode`);
    return { start, end, label: typeof label === 'string' ? label : '' };
  });
  ranges.sort((a, b) => a.start - b.start);
  const merged: AdRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

export function episodeLength(ep: SavedEpisode, segments: Seg[]): number {
  if (ep.durationSec > 0) return ep.durationSec;
  return segments.length ? segments[segments.length - 1].end : 0;
}
