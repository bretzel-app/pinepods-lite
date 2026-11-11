import type { AdRange, SavedEpisode, Seg } from './types';

/** Claude answered, but not with valid ad ranges: counts as a failed attempt for the episode. */
export class InvalidOutput extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOutput';
  }
}

/** The `claude` CLI itself failed (exit code, timeout, error result): says nothing about the episode. */
export class ClaudeUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeUnavailable';
  }
}

/** A finished `claude -p` run's stdout, or ClaudeUnavailable when the CLI failed. */
export function claudeStdout(run: { code: number | null; timedOut: boolean; stdout: string; stderr: string; timeoutMs: number }): string {
  if (run.timedOut) throw new ClaudeUnavailable(`claude timed out after ${Math.round(run.timeoutMs / 1000)} s`);
  if (run.code === 0) return run.stdout;
  // A run that failed still prints its error result; parseClaudeResult tells why it failed.
  let res: any;
  try {
    res = JSON.parse(run.stdout);
  } catch {
    res = null;
  }
  if (res?.type === 'result' && res.is_error === true) return run.stdout;
  throw new ClaudeUnavailable(`claude exited with code ${run.code}: ${run.stderr.slice(-500)}`);
}

export function parseClaudeResult(stdout: string): unknown {
  let res: any;
  try {
    res = JSON.parse(stdout);
  } catch {
    throw new InvalidOutput('Claude output is not JSON');
  }
  if (!res || typeof res !== 'object') throw new InvalidOutput('Claude output is not an object');
  if (res.is_error) {
    const what = `Claude reported an error${res.subtype ? `: ${res.subtype}` : ''}${typeof res.result === 'string' ? `: ${res.result.slice(0, 300)}` : ''}`;
    // Claude kept answering outside the schema: a bad answer for this transcript, not an outage.
    if (res.subtype === 'error_max_structured_output_retries') throw new InvalidOutput(what);
    throw new ClaudeUnavailable(what);
  }
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
    return { start, end, label: typeof label === 'string' ? label : '' };
  });
  ranges.sort((a, b) => a.start - b.start);
  const merged: AdRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  // On the merged ranges: overlapping ranges can add up to more than any one of them.
  for (const r of merged) {
    if (r.end - r.start > lengthSec / 2) throw new InvalidOutput(`range ${r.start}-${r.end} exceeds 50% of the episode`);
  }
  return merged;
}

/** The transcript is of the server's copy, which can run longer than the feed's duration (inserted ads). */
export function episodeLength(ep: SavedEpisode, segments: Seg[]): number {
  const transcriptEnd = segments.reduce((max, s) => Math.max(max, s.end), 0);
  return Math.max(ep.durationSec, transcriptEnd);
}
