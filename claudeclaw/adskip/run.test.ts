import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS, runOnce, type Deps } from './run';
import { buildPrompt } from './prompt';
import type { RunState } from './state';
import type { SavedEpisode, SkipView, TranscriptInfo } from './types';

const mk = (id: number, p: Partial<SavedEpisode> = {}): SavedEpisode =>
  ({ episodeId: id, title: 'Ep', podcast: 'Huberman Lab', downloaded: true, isYoutube: false, durationSec: 3600, ...p });
const seg = [{ start: 0, end: 5, text: 'hello' }, { start: 10, end: 40, text: 'AG1 offer' }];
const complete: TranscriptInfo = { status: 'complete', segments: seg };
const sv = (p: Partial<SkipView> = {}): SkipView => ({ ads: [], scanned: false, download: null, ...p });
const result = (ads: unknown[]) => JSON.stringify({ structured_output: { ads } });
const ad = { start: 10, end: 40, label: 'AG1' };

function setup(o: {
  episodes?: SavedEpisode[];
  transcripts?: Record<number, TranscriptInfo | null>;
  skips?: Record<number, SkipView>;
  readBack?: SkipView;
  claude?: (prompt: string) => Promise<string>;
  state?: Partial<RunState>;
  now?: () => number;
} = {}) {
  const episodes = o.episodes ?? [mk(12)];
  let state: RunState = { alerts: {}, attempts: {}, ...o.state };
  const api = {
    saved: vi.fn(async () => episodes),
    download: vi.fn(async () => {}),
    transcribe: vi.fn(async () => {}),
    transcript: vi.fn(async (id: number) => (o.transcripts && id in o.transcripts ? o.transcripts[id] : complete)),
    skips: vi.fn(async (id: number) => {
      const initial = o.skips?.[id] ?? sv();
      return o.readBack && db.writeAds.mock.calls.some((c) => c[0] === id) ? o.readBack : initial;
    }),
  };
  const db = { checkSchema: vi.fn(async () => {}), writeAds: vi.fn(async () => {}), clearAds: vi.fn(async () => {}) };
  const notifier = { success: vi.fn(async () => {}), error: vi.fn(async () => {}) };
  const claude = vi.fn(o.claude ?? (async () => result([ad])));
  const log = vi.fn();
  const store = { load: () => state, save: (s: RunState) => { state = s; } };
  const deps: Deps = { api, db, claude, notifier, store, now: o.now ?? (() => 0), log };
  return { deps, api, db, notifier, claude, log, state: () => state };
}

describe('runOnce', () => {
  it('checks the schema first and stops with an alert when it fails', async () => {
    const s = setup();
    s.db.checkSchema.mockRejectedValue(new Error('no column'));
    await runOnce(s.deps);
    expect(s.api.saved).not.toHaveBeenCalled();
    expect(s.notifier.error).toHaveBeenCalledWith('schema', expect.stringContaining('no column'));
  });

  it('alerts when PinePods is unreachable', async () => {
    const s = setup();
    s.api.saved.mockRejectedValue(new Error('ECONNREFUSED'));
    await runOnce(s.deps);
    expect(s.notifier.error).toHaveBeenCalledWith('pinepods', expect.stringContaining('ECONNREFUSED'));
    expect(s.api.download).not.toHaveBeenCalled();
  });

  it('continues with the next episode when one PinePods call fails', async () => {
    const s = setup({ episodes: [mk(1), mk(2)] });
    s.api.transcript.mockRejectedValueOnce(new Error('boom'));
    await runOnce(s.deps);
    expect(s.notifier.error).toHaveBeenCalledWith('pinepods', expect.stringContaining('boom'));
    expect(s.db.writeAds).toHaveBeenCalledTimes(1);
    expect(s.db.writeAds).toHaveBeenCalledWith(2, [ad]);
  });

  it('downloads at most 2 new episodes per run', async () => {
    const eps = [1, 2, 3].map((i) => mk(i, { downloaded: false }));
    const s = setup({ episodes: eps, transcripts: { 1: null, 2: null, 3: null } });
    await runOnce(s.deps);
    expect(s.api.download.mock.calls.map((c) => c[0])).toEqual([1, 2]);
  });

  it('starts no transcription while one is pending or running', async () => {
    const s = setup({
      episodes: [mk(1), mk(2)],
      transcripts: { 1: { status: 'running', segments: [] }, 2: null },
    });
    await runOnce(s.deps);
    expect(s.api.transcribe).not.toHaveBeenCalled();
  });

  it('counts a pending transcription that comes after the untranscribed episode', async () => {
    const s = setup({
      episodes: [mk(1), mk(2)],
      transcripts: { 1: null, 2: { status: 'pending', segments: [] } },
    });
    await runOnce(s.deps);
    expect(s.api.transcribe).not.toHaveBeenCalled();
  });

  it('starts at most one transcription', async () => {
    const s = setup({ episodes: [mk(1), mk(2)], transcripts: { 1: null, 2: null } });
    await runOnce(s.deps);
    expect(s.api.transcribe).toHaveBeenCalledTimes(1);
    expect(s.api.transcribe).toHaveBeenCalledWith(1, false);
  });

  it('sends at most 3 episodes to Claude', async () => {
    const s = setup({ episodes: [1, 2, 3, 4].map((i) => mk(i)) });
    await runOnce(s.deps);
    expect(s.claude).toHaveBeenCalledTimes(3);
  });

  it('stops starting Claude runs after the time budget', async () => {
    let t = 0;
    const s = setup({ episodes: [mk(1), mk(2)], now: () => t });
    s.claude.mockImplementation(async () => { t += 8 * 60_000; return result([ad]); });
    await runOnce(s.deps);
    expect(s.claude).toHaveBeenCalledTimes(1);
  });

  it('writes ranges and the marker, then reports success', async () => {
    const s = setup({ readBack: sv({ ads: [{ start: 10, end: 40 }], scanned: true, download: 'match' }) });
    await runOnce(s.deps);
    expect(s.db.writeAds).toHaveBeenCalledWith(12, [{ start: 10, end: 40, label: 'AG1' }]);
    expect(s.notifier.success).toHaveBeenCalledWith('Huberman Lab – Ep: 1 ads · 1 min removed');
    expect(s.log).toHaveBeenCalledWith('Huberman Lab – Ep: 1 ads · 1 min removed');
  });

  it('zero ads still marks the episode scanned', async () => {
    const s = setup({ claude: async () => result([]), state: { attempts: { '12': 1 } } });
    await runOnce(s.deps);
    expect(s.db.writeAds).toHaveBeenCalledWith(12, []);
    expect(s.notifier.success).toHaveBeenCalledWith('Huberman Lab – Ep: no ads found');
    expect(s.state().attempts['12']).toBeUndefined();
  });

  it('clears and forces a new transcript when the copy does not match', async () => {
    const s = setup({ readBack: sv({ ads: [{ start: 10, end: 40 }], scanned: true, download: 'mismatch' }) });
    await runOnce(s.deps);
    expect(s.db.clearAds).toHaveBeenCalledWith(12);
    expect(s.api.transcribe).toHaveBeenCalledWith(12, true);
    expect(s.notifier.success).not.toHaveBeenCalled();
    expect(s.log).toHaveBeenCalledWith('Huberman Lab – Ep: copy mismatch, re-transcribing');
  });

  it.each([['unknown'], ['none'], [null]] as const)('re-transcribes when the read-back copy status is %s', async (download) => {
    const s = setup({ readBack: sv({ ads: [{ start: 10, end: 40 }], scanned: true, download }) });
    await runOnce(s.deps);
    expect(s.db.clearAds).toHaveBeenCalledWith(12);
    expect(s.api.transcribe).toHaveBeenCalledWith(12, true);
    expect(s.notifier.success).not.toHaveBeenCalled();
    expect(s.log).toHaveBeenCalledWith('Huberman Lab – Ep: copy mismatch, re-transcribing');
  });

  it('counts a non-match read-back as an attempt, without an invalid alert', async () => {
    const s = setup({
      state: { attempts: { '12': DEFAULT_LIMITS.maxAttempts - 1 } },
      readBack: sv({ ads: [{ start: 10, end: 40 }], scanned: true, download: 'mismatch' }),
    });
    await runOnce(s.deps);
    expect(s.state().attempts['12']).toBe(DEFAULT_LIMITS.maxAttempts);
    expect(s.notifier.error).not.toHaveBeenCalled();
  });

  it('invalid Claude output alerts, writes nothing, and the run continues', async () => {
    const outputs = ['not json', result([ad])];
    const s = setup({ episodes: [mk(1), mk(2)], claude: async () => outputs.shift()! });
    await runOnce(s.deps);
    expect(s.notifier.error).toHaveBeenCalledWith('invalid:1', expect.any(String));
    expect(s.db.writeAds).toHaveBeenCalledTimes(1);
    expect(s.db.writeAds).toHaveBeenCalledWith(2, [ad]);
    expect(s.state().attempts['1']).toBe(1);
  });

  it('counts a failed write as a failed attempt', async () => {
    const s = setup();
    s.db.writeAds.mockRejectedValue(new Error('db down'));
    await runOnce(s.deps);
    expect(s.notifier.error).toHaveBeenCalledWith('invalid:12', expect.stringContaining('db down'));
    expect(s.state().attempts['12']).toBe(1);
  });

  it('counts a rejected Claude call as a failed attempt', async () => {
    const s = setup({ claude: async () => { throw new Error('timeout'); } });
    await runOnce(s.deps);
    expect(s.notifier.error).toHaveBeenCalledWith('invalid:12', expect.stringContaining('timeout'));
    expect(s.state().attempts['12']).toBe(1);
  });

  it('gives up on an episode after 3 failed attempts', async () => {
    const s = setup({ state: { attempts: { '12': 3 } } });
    await runOnce(s.deps);
    await runOnce(s.deps);
    expect(s.claude).not.toHaveBeenCalled();
    const gaveUp = s.notifier.error.mock.calls.filter((c) => c[0] === 'gave-up:12');
    expect(gaveUp).toHaveLength(1);
  });

  it('alerts once for a failed transcription', async () => {
    const s = setup({ transcripts: { 12: { status: 'failed', segments: [] } } });
    await runOnce(s.deps);
    await runOnce(s.deps);
    const failed = s.notifier.error.mock.calls.filter((c) => c[0] === 'transcription-failed:12');
    expect(failed).toHaveLength(1);
    expect(s.api.transcribe).not.toHaveBeenCalled();
  });

  it('sends the transcript to Claude as the prompt', async () => {
    const s = setup();
    await runOnce(s.deps);
    expect(s.claude).toHaveBeenCalledWith(buildPrompt(mk(12), seg));
  });

  it('keeps the alert timestamps the notifier saved during the run', async () => {
    const s = setup({ claude: async () => 'not json' });
    s.notifier.error.mockImplementation(async (key: string) => {
      const st = s.deps.store.load();
      st.alerts[key] = 5;
      s.deps.store.save(st);
    });
    await runOnce(s.deps);
    expect(s.state().alerts['invalid:12']).toBe(5);
    expect(s.state().attempts['12']).toBe(1);
  });

  it('exports the default limits', () => {
    expect(DEFAULT_LIMITS).toEqual({ downloads: 2, transcriptions: 1, detections: 3, claudeBudgetMs: 8 * 60_000, maxAttempts: 3 });
  });
});
