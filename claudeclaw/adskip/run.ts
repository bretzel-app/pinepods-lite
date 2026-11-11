import { formatLogLine, formatSuccess } from './notify';
import { buildPrompt } from './prompt';
import { InvalidOutput, episodeLength, parseClaudeResult, validateRanges } from './validate';
import { needsTranscript, nextStep } from './plan';
import type { AdRange, AdskipDb, Notifier, PinepodsApi, SavedEpisode, SkipView, TranscriptInfo } from './types';
import type { RunState, StateStore } from './state';

export interface Deps {
  api: PinepodsApi;
  db: AdskipDb;
  /** Runs `claude -p` on the prompt, killed after timeoutMs. Resolves its stdout; rejects when the
   * CLI fails (exit code, timeout, cannot start), ideally with ClaudeUnavailable. */
  claude: (prompt: string, timeoutMs: number) => Promise<string>;
  notifier: Notifier;
  store: StateStore;
  now: () => number;
  /** A line for the job log. The job's own Claude reads it: ids and counts only, no titles. */
  log: (line: string) => void;
}

export const DEFAULT_LIMITS = {
  downloads: 2,
  transcriptions: 1,
  detections: 3,
  maxAttempts: 3,
  // Claude Code's Bash tool stops the job after 10 minutes: no Claude run may last past this
  // point of the run, and one is only started with enough time left to finish.
  deadlineMs: 9.5 * 60_000,
  minClaudeMs: 2 * 60_000,
  claudeTimeoutMs: 5 * 60_000,
  // A given-up episode is tried again after this.
  giveUpMs: 24 * 60 * 60_000,
};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Item { ep: SavedEpisode; skips: SkipView; transcript: TranscriptInfo | null }

export async function runOnce(deps: Deps, limits: typeof DEFAULT_LIMITS = DEFAULT_LIMITS): Promise<void> {
  const { api, db, notifier } = deps;
  const deadline = deps.now() + limits.deadlineMs;
  const state: RunState = deps.store.load();
  try {
    try {
      await db.checkSchema();
    } catch (e) {
      await notifier.error('schema', `schema check failed: ${msg(e)}`);
      return;
    }
    let saved: SavedEpisode[];
    try {
      saved = await api.saved();
    } catch (e) {
      await notifier.error('pinepods', `PinePods is unreachable: ${msg(e)}`);
      return;
    }

    // Gather first so the transcription limit sees every episode's state. The transcript (it
    // can be large) only for the episodes whose next step depends on it.
    const items: Item[] = [];
    for (const ep of saved) {
      if (ep.isYoutube) continue;
      try {
        const skips = await api.skips(ep.episodeId);
        const transcript = needsTranscript(ep, skips) ? await api.transcript(ep.episodeId) : null;
        items.push({ ep, skips, transcript });
      } catch (e) {
        await notifier.error('pinepods', `${ep.podcast} – ${ep.title}: ${msg(e)}`);
      }
    }

    let downloads = 0;
    let transcriptions = items.filter((i) => nextStep(i.ep, i.skips, i.transcript).kind === 'wait').length;
    let detections = 0;
    let claudeDown = false;

    for (const { ep, skips, transcript } of items) {
      const id = ep.episodeId;
      const key = String(id);
      const name = `${ep.podcast} – ${ep.title}`;
      const step = nextStep(ep, skips, transcript);
      try {
        if (step.kind === 'download') {
          if (downloads >= limits.downloads) continue;
          downloads++;
          await api.download(id);
        } else if (step.kind === 'transcribe') {
          if (transcriptions >= limits.transcriptions) continue;
          transcriptions++;
          await api.transcribe(id, false);
        }
      } catch (e) {
        await notifier.error('pinepods', `${name}: ${msg(e)}`);
        continue;
      }
      if (step.kind === 'failed' || step.kind === 'empty') {
        // Once ever: the job doesn't retry these (README: how to reset by hand).
        const marker = `${step.kind === 'failed' ? 'transcription-failed' : 'empty-transcript'}:${id}`;
        if (!state.attempts[marker]) {
          state.attempts[marker] = 1;
          await notifier.error(marker, `${name}: ${step.kind === 'failed' ? 'transcription failed' : 'the transcript is complete but has no segments'}`);
        }
        continue;
      }
      if (step.kind !== 'detect' || !transcript) continue;

      // Giving up lasts a day; then the episode starts over with fresh attempts (and alerts again).
      const gaveUp = `gave-up:${id}`;
      const gaveUpAt = state.attempts[gaveUp];
      if (gaveUpAt !== undefined && deps.now() - gaveUpAt >= limits.giveUpMs) {
        delete state.attempts[gaveUp];
        delete state.attempts[key];
      }
      if ((state.attempts[key] ?? 0) >= limits.maxAttempts) {
        if (state.attempts[gaveUp] === undefined) {
          state.attempts[gaveUp] = deps.now();
          await notifier.error(gaveUp, `${name}: giving up for a day after ${limits.maxAttempts} failed attempts`);
        }
        continue;
      }
      if (claudeDown || detections >= limits.detections) continue;
      const left = deadline - deps.now();
      if (left < limits.minClaudeMs) continue;
      detections++;

      const failedAttempt = async (e: unknown) => {
        state.attempts[key] = (state.attempts[key] ?? 0) + 1;
        const what = e instanceof InvalidOutput ? `invalid Claude output: ${e.message}` : msg(e);
        await notifier.error(`invalid:${id}`, `${name}: ${what}`);
      };

      let raw: unknown;
      try {
        raw = parseClaudeResult(await deps.claude(buildPrompt(ep, transcript.segments), Math.min(limits.claudeTimeoutMs, left)));
      } catch (e) {
        if (e instanceof InvalidOutput) {
          await failedAttempt(e);
          continue;
        }
        // The CLI failed (limit, login, outage): nothing to hold against the episode, and the
        // next episodes would fail the same way.
        claudeDown = true;
        await notifier.error('claude', `Claude is unavailable, no ad detection until a later run: ${msg(e)}`);
        continue;
      }
      let ranges: AdRange[];
      try {
        ranges = validateRanges(raw, episodeLength(ep, transcript.segments));
        await db.writeAds(id, ranges);
      } catch (e) {
        await failedAttempt(e);
        continue;
      }

      let readBack: SkipView;
      try {
        readBack = await api.skips(id);
      } catch (e) {
        await notifier.error('pinepods', `${name}: ${msg(e)}`);
        continue;
      }
      if (!readBack.scanned) {
        // The write didn't land where PinePods reads (wrong PINEPODS_DB_URL, or PinePods changed).
        // Counted like a failed write, so it can't cost a Claude run every 10 minutes.
        state.attempts[key] = (state.attempts[key] ?? 0) + 1;
        await notifier.error('schema', `${name}: wrote the ads, but PinePods doesn't show the scan marker; check PINEPODS_DB_URL and the PinePods version`);
        return;
      }
      if (ranges.length > 0 && readBack.download !== 'match') {
        deps.log(`episode ${id}: copy mismatch, re-transcribing`);
        state.attempts[key] = (state.attempts[key] ?? 0) + 1;
        try {
          await db.clearAds(id);
          await api.transcribe(id, true);
        } catch (e) {
          await notifier.error('pinepods', `${name}: ${msg(e)}`);
        }
        continue;
      }
      delete state.attempts[key];
      await notifier.success(formatSuccess(ep, ranges));
      deps.log(formatLogLine(id, ranges));
    }
  } finally {
    // The notifier keeps its own alert timestamps in the same store; keep them.
    const fresh = deps.store.load();
    fresh.attempts = state.attempts;
    deps.store.save(fresh);
  }
}
