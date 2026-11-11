import { formatSuccess } from './notify';
import { buildPrompt } from './prompt';
import { InvalidOutput, episodeLength, parseClaudeResult, validateRanges } from './validate';
import { nextStep } from './plan';
import type { AdskipDb, Notifier, PinepodsApi, RunState, SavedEpisode, SkipView, StateStore, TranscriptInfo } from './types';

export interface Deps {
  api: PinepodsApi;
  db: AdskipDb;
  claude: (prompt: string) => Promise<string>;
  notifier: Notifier;
  store: StateStore;
  now: () => number;
  log: (line: string) => void;
}

export const DEFAULT_LIMITS = { downloads: 2, transcriptions: 1, detections: 3, claudeBudgetMs: 8 * 60_000, maxAttempts: 3 };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Item { ep: SavedEpisode; transcript: TranscriptInfo | null; skips: SkipView }

export async function runOnce(deps: Deps, limits: typeof DEFAULT_LIMITS = DEFAULT_LIMITS): Promise<void> {
  const { api, db, notifier } = deps;
  const start = deps.now();
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

    // Gather first so the transcription limit sees every episode's state.
    const items: Item[] = [];
    for (const ep of saved) {
      if (ep.isYoutube) continue;
      try {
        const transcript = await api.transcript(ep.episodeId);
        const skips = await api.skips(ep.episodeId);
        items.push({ ep, transcript, skips });
      } catch (e) {
        await notifier.error('pinepods', `${ep.podcast} – ${ep.title}: ${msg(e)}`);
      }
    }

    let downloads = 0;
    let transcriptions = items.filter((i) => nextStep(i.ep, i.transcript, i.skips).kind === 'wait').length;
    let detections = 0;

    for (const { ep, transcript, skips } of items) {
      const id = ep.episodeId;
      const name = `${ep.podcast} – ${ep.title}`;
      const step = nextStep(ep, transcript, skips);
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
      if (step.kind === 'failed') {
        const marker = `transcription-failed:${id}`;
        if (!state.attempts[marker]) {
          state.attempts[marker] = 1;
          await notifier.error(marker, `${name}: transcription failed`);
        }
        continue;
      }
      if (step.kind !== 'detect' || !transcript) continue;

      if ((state.attempts[String(id)] ?? 0) >= limits.maxAttempts) {
        const marker = `gave-up:${id}`;
        if (!state.attempts[marker]) {
          state.attempts[marker] = 1;
          await notifier.error(marker, `${name}: giving up after ${limits.maxAttempts} failed attempts`);
        }
        continue;
      }
      if (detections >= limits.detections || deps.now() - start >= limits.claudeBudgetMs) continue;
      detections++;

      let ranges;
      try {
        const out = await deps.claude(buildPrompt(ep, transcript.segments));
        ranges = validateRanges(parseClaudeResult(out), episodeLength(ep, transcript.segments));
        await db.writeAds(id, ranges);
      } catch (e) {
        state.attempts[String(id)] = (state.attempts[String(id)] ?? 0) + 1;
        const what = e instanceof InvalidOutput ? `invalid Claude output: ${e.message}` : msg(e);
        await notifier.error(`invalid:${id}`, `${name}: ${what}`);
        continue;
      }

      if (ranges.length > 0) {
        let readBack: SkipView;
        try {
          readBack = await api.skips(id);
        } catch (e) {
          await notifier.error('pinepods', `${name}: ${msg(e)}`);
          continue;
        }
        if (readBack.download !== 'match') {
          deps.log(`${name}: copy mismatch, re-transcribing`);
          state.attempts[String(id)] = (state.attempts[String(id)] ?? 0) + 1;
          try {
            await db.clearAds(id);
            await api.transcribe(id, true);
          } catch (e) {
            await notifier.error('pinepods', `${name}: ${msg(e)}`);
          }
          continue;
        }
        delete state.attempts[String(id)];
      } else {
        delete state.attempts[String(id)];
      }
      const text = formatSuccess(ep, ranges);
      await notifier.success(text);
      deps.log(text);
    }
  } finally {
    // The notifier keeps its own alert timestamps in the same store; keep them.
    const fresh = deps.store.load();
    fresh.attempts = state.attempts;
    deps.store.save(fresh);
  }
}
