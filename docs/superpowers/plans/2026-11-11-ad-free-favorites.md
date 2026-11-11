# Ad-free favorites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Starring an episode in PinePods Lite gets its ads found by Claude (through claudeclaw), stored in PinePods' ad-skip tables, and skipped during playback, with a visible status.

**Architecture:** A Bun script run by a claudeclaw job every 10 minutes drives each starred episode through server download, transcription (PinePods' whisper service) and ad detection (`claude -p`, no tools), then writes ranges plus a scan marker into PinePods' database. PinePods Lite starts the server download on star, plays or downloads the server's copy, fetches the ranges, skips them in both the web engine and the native Media3 service, and shows a per-episode status.

**Tech Stack:** TypeScript, React 18, Vite/Vitest 2 (app and the script's logic), Bun 1.x (`bun build`, `Bun.SQL`, `Bun.spawn`) for the script runtime, Kotlin + Media3 + JUnit 4 (Android), PinePods 0.9.2 HTTP API.

**Spec:** `docs/superpowers/specs/2026-11-11-ad-free-favorites-design.md`

## Global Constraints

- Work on branch `ad-free-favorites` (create it from `main` before Task 1).
- Ad detection runs only through `claude` in the claudeclaw container: `claude -p --model sonnet --tools "" --strict-mcp-config --output-format json --json-schema <schema>`. Prompt goes in on stdin. No API key, no other LLM.
- Writes, in one transaction: delete `EpisodeSkipSegments` rows with `Source='auto-ad'` for the episode, insert `(EpisodeID, Kind='ad', StartTime, EndTime, Source='auto-ad')` per range, insert the marker `(EpisodeID, Kind='ad-scan', StartTime=0, EndTime=0, Source='auto-ad')`, `UPDATE Episodes SET AdsDetected = TRUE`.
- Valid ranges: `0 ≤ start < end ≤ episode length`, each `≤ 50%` of the length, overlaps merged. Anything else is invalid: no write, alert.
- Job: every 10 minutes, `notify: false`. Per run at most 2 new server downloads, at most 1 transcription `pending`/`running` at a time, at most 3 episodes through Claude, no new Claude run after 8 minutes, never two runs at once (lock).
- Never re-download an episode that has a scan marker. Skip saved YouTube items. Don't retry failed transcriptions.
- Telegram via `TELEGRAM_TOKEN` and `ADSKIP_ALERT_CHAT_ID`. Errors always, the same error at most once a day. Success messages only while `ADSKIP_NOTIFY_SUCCESS=true`, formatted `"<podcast> – <title>: <n> ads · <m> min removed"` or `"<podcast> – <title>: no ads found"`.
- Script env: `PINEPODS_URL`, `PINEPODS_API_KEY`, `PINEPODS_USER_ID`, `PINEPODS_DB_URL`, `ADSKIP_ALERT_CHAT_ID`, `ADSKIP_NOTIFY_SUCCESS`, `TELEGRAM_TOKEN`.
- App skips only ranges with status `active` or `confirmed`, and only on the analyzed copy. Native skipping happens in `PlaybackService`, at most one 1 s tick late. A manual seek into a range plays it; skipping resumes at the next range. A range reaching the end ends the episode.
- Unstarring changes nothing on the server.

## Review Focus

1. A three-hour transcript is over Linux's 128 KB per-argument limit. The prompt must reach `claude` on stdin, never in argv (Task 1 `claudeArgs` test, Task 4 spawn).
2. Claude answers with an error result, no structured output, or ranges outside the episode. The expected behaviour: nothing is written, an alert is sent, and the episode is given up after 3 attempts (Task 1 and Task 3 tests).
3. Playing a copy that isn't the analyzed one must never skip. That covers the publisher stream, a phone download taken from the publisher, and a missing local file that falls back to the enclosure (Task 5 `skipsFor`, Task 8 web fallback, Task 9 Kotlin URI mismatch tests).
4. A resume point inside an ad (paused mid-ad, app restarted). The resume seek is not a manual seek, so the ad is skipped (Task 8 and Task 9 tests).
5. PinePods reports the episode duration as 0. Validation falls back to the transcript's last segment end (Task 1 test).

---

## Part A: claudeclaw job (`claudeclaw/adskip/`)

All modules except `main.ts` and `db.ts` are plain TypeScript with no Bun globals, so `npm test` (Vitest) runs their tests. `main.ts` and `db.ts` use Bun APIs and are exercised in Task 4 and Task 11.

### Task 1: Types, PinePods client, Claude prompt and output validation

**Files:**
- Create: `claudeclaw/adskip/types.ts`, `claudeclaw/adskip/pinepods.ts`, `claudeclaw/adskip/prompt.ts`, `claudeclaw/adskip/validate.ts`
- Test: `claudeclaw/adskip/pinepods.test.ts`, `claudeclaw/adskip/prompt.test.ts`, `claudeclaw/adskip/validate.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export interface SavedEpisode { episodeId: number; title: string; podcast: string; downloaded: boolean; isYoutube: boolean; durationSec: number }
  export interface Seg { start: number; end: number; text: string }
  export type TranscriptStatus = 'pending' | 'running' | 'complete' | 'failed';
  export interface TranscriptInfo { status: TranscriptStatus; segments: Seg[] }
  export type CopyMatch = 'match' | 'mismatch' | 'unknown' | 'none';
  export interface SkipView { ads: { start: number; end: number }[]; scanned: boolean; download: CopyMatch | null }
  export interface AdRange { start: number; end: number; label: string }
  export interface PinepodsApi {
    saved(): Promise<SavedEpisode[]>;
    download(episodeId: number): Promise<void>;
    transcribe(episodeId: number, force: boolean): Promise<void>;
    transcript(episodeId: number): Promise<TranscriptInfo | null>;
    skips(episodeId: number): Promise<SkipView>;
  }
  export interface AdskipDb { checkSchema(): Promise<void>; writeAds(episodeId: number, ranges: AdRange[]): Promise<void>; clearAds(episodeId: number): Promise<void> }
  export interface Notifier { success(text: string): Promise<void>; error(key: string, text: string): Promise<void> }
  ```
- Produces: `pinepodsApi(baseUrl: string, apiKey: string, userId: number, fetchImpl?: typeof fetch): PinepodsApi`, `class PinepodsError extends Error { status?: number }` (`pinepods.ts`); `ADS_SCHEMA: object`, `buildPrompt(ep: SavedEpisode, segments: Seg[]): string`, `claudeArgs(): string[]` (`prompt.ts`); `class InvalidOutput extends Error`, `parseClaudeResult(stdout: string): unknown`, `validateRanges(raw: unknown, lengthSec: number): AdRange[]`, `episodeLength(ep: SavedEpisode, segments: Seg[]): number` (`validate.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// pinepods.test.ts — fake fetch records calls and returns canned JSON
it('lists saved episodes with the Api-Key header', async () => {
  const f = fakeFetch({ '/api/data/saved_episode_list/7': { saved_episodes: [
    { episodeid: 12, episodetitle: 'Ep', podcastname: 'Huberman Lab', downloaded: 1, is_youtube: 0, episodeduration: 3600 } ] } });
  const eps = await pinepodsApi('http://pp', 'k', 7, f).saved();
  expect(eps).toEqual([{ episodeId: 12, title: 'Ep', podcast: 'Huberman Lab', downloaded: true, isYoutube: false, durationSec: 3600 }]);
  expect(f.calls[0].headers['Api-Key']).toBe('k');
});
it('parses the transcript segments string', async () => {
  const f = fakeFetch({ '/api/data/episode_transcript?episode_id=12&user_id=7':
    { transcript: { status: 'complete', segments: '[{"start":0,"end":2.5,"text":"hi"}]' } } });
  expect(await pinepodsApi('http://pp', 'k', 7, f).transcript(12))
    .toEqual({ status: 'complete', segments: [{ start: 0, end: 2.5, text: 'hi' }] });
});
it('returns null when there is no transcript', /* { transcript: null } → null */);
it('reads ads, the scan marker and the copy match', async () => {
  const f = fakeFetch({ '/api/data/episode_skip_segments?episode_id=12&user_id=7': { segments: [
    { segment_id: 1, kind: 'ad', start_time: 10, end_time: 40, source: 'auto-ad', status: 'active' },
    { segment_id: 2, kind: 'ad-scan', start_time: 0, end_time: 0, source: 'auto-ad', status: null },
    { segment_id: 3, kind: 'silence', start_time: 50, end_time: 52, source: 'silence', status: null } ],
    ad_audio: { analyzed: { fingerprint: 'f' }, download: 'match' } } });
  expect(await pinepodsApi('http://pp', 'k', 7, f).skips(12))
    .toEqual({ ads: [{ start: 10, end: 40 }], scanned: true, download: 'match' });
});
it('posts download and transcribe requests', /* bodies: {episode_id:12,user_id:7,is_youtube:false} and {episode_id:12,user_id:7,force:true} */);
it('throws PinepodsError with the status on non-2xx', /* 500 → PinepodsError, status 500 */);

// prompt.test.ts
it('passes the prompt on stdin, not as an argument', () => {
  expect(claudeArgs()).toEqual(['-p', '--model', 'sonnet', '--tools', '', '--strict-mcp-config',
    '--output-format', 'json', '--json-schema', JSON.stringify(ADS_SCHEMA)]);
});
it('lists every segment with its times and states the rules', () => {
  const p = buildPrompt(ep, [{ start: 0, end: 2.5, text: 'hi' }, { start: 2.5, end: 61, text: 'AG1 sponsor' }]);
  expect(p).toContain('[0.0-2.5] hi');
  expect(p).toContain('[2.5-61.0] AG1 sponsor');
  expect(p).toMatch(/host-read/i);
  expect(p).toMatch(/not sure|unsure/i);
});

// validate.test.ts
it('takes structured_output from the result', () => {
  expect(parseClaudeResult('{"type":"result","is_error":false,"structured_output":{"ads":[]}}')).toEqual({ ads: [] });
});
it('falls back to JSON in result', () => {
  expect(parseClaudeResult('{"type":"result","is_error":false,"result":"{\\"ads\\":[]}"}')).toEqual({ ads: [] });
});
it('rejects error results and non-JSON', () => {
  expect(() => parseClaudeResult('{"type":"result","is_error":true,"subtype":"error_max_structured_output_retries"}')).toThrow(InvalidOutput);
  expect(() => parseClaudeResult('nope')).toThrow(InvalidOutput);
});
it('accepts, sorts and merges ranges', () => {
  expect(validateRanges({ ads: [{ start: 35, end: 60, label: 'b' }, { start: 10, end: 40, label: 'a' }] }, 3600))
    .toEqual([{ start: 10, end: 60, label: 'a' }]);
});
it.each([
  [{ ads: [{ start: 40, end: 40, label: 'x' }] }],
  [{ ads: [{ start: -1, end: 5, label: 'x' }] }],
  [{ ads: [{ start: 10, end: 3700, label: 'x' }] }],
  [{ ads: [{ start: 0, end: 1801, label: 'x' }] }],   // > 50% of 3600
  [{ nope: true }],
])('rejects %j', (raw) => expect(() => validateRanges(raw, 3600)).toThrow(InvalidOutput));
it('uses the last segment end when the episode duration is 0', () => {
  expect(episodeLength({ ...ep, durationSec: 0 }, [{ start: 0, end: 10, text: '' }, { start: 10, end: 2400, text: '' }])).toBe(2400);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run claudeclaw/adskip`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the four modules**

`ADS_SCHEMA` is `{type:'object', properties:{ads:{type:'array', items:{type:'object', properties:{start:{type:'number'}, end:{type:'number'}, label:{type:'string'}}, required:['start','end','label']}}}, required:['ads']}`. `buildPrompt` writes one line per segment, `[start-end] text`, with times to one decimal. It says: injected ads in any language and host-read sponsor segments are ads; show content (including the host talking about his own show) is not; when not sure, leave it out; snap to segment boundaries. `pinepodsApi` URLs and bodies are in the spec's "Facts" section. `skips()` keeps only `kind === 'ad'` rows in `ads`, whatever their status.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run claudeclaw/adskip`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add claudeclaw/adskip
git commit -m "Add the ad-skip job's PinePods client, prompt and output validation"
```

### Task 2: SQL statements, run state (alerts, attempts, lock) and Telegram notifier

**Files:**
- Create: `claudeclaw/adskip/sql.ts`, `claudeclaw/adskip/state.ts`, `claudeclaw/adskip/notify.ts`
- Test: `claudeclaw/adskip/sql.test.ts`, `claudeclaw/adskip/state.test.ts`, `claudeclaw/adskip/notify.test.ts`

**Interfaces:**
- Consumes: `SavedEpisode`, `AdRange`, `Notifier` (Task 1).
- Produces (`sql.ts`): `type Dialect = 'postgres' | 'mysql'`; `dialectOf(url: string): Dialect`; `statements(d: Dialect): { columns: string; deleteAutoAd: string; insertSegment: string; setDetected: string; clearDetected: string }`; `REQUIRED_COLUMNS: Record<'EpisodeSkipSegments' | 'Episodes', string[]>`; `missingColumns(rows: { table_name: string; column_name: string }[]): string[]`.
- Produces (`state.ts`): `interface RunState { alerts: Record<string, number>; attempts: Record<string, number> }`; `interface StateStore { load(): RunState; save(s: RunState): void }`; `lockIsFree(lockMtimeMs: number | null, now: number, staleMs?: number): boolean` (stale after 30 min by default).
- Produces (`notify.ts`): `formatSuccess(ep: SavedEpisode, ranges: AdRange[]): string`; `telegramNotifier(o: { token: string; chatId: string; notifySuccess: boolean; store: StateStore; now: () => number; fetchImpl?: typeof fetch }): Notifier`.

- [ ] **Step 1: Write the failing tests**

```ts
// sql.test.ts
it('picks the dialect from the URL', () => {
  expect(dialectOf('postgres://u:p@db/pinepods')).toBe('postgres');
  expect(dialectOf('postgresql://u:p@db/pinepods')).toBe('postgres');
  expect(dialectOf('mysql://u:p@db/pinepods')).toBe('mysql');
  expect(() => dialectOf('sqlite://x')).toThrow();
});
it('writes rows the way PinePods does', () => {
  expect(statements('postgres').insertSegment).toBe(
    'INSERT INTO "EpisodeSkipSegments" (episodeid, kind, starttime, endtime, source) VALUES ($1, $2, $3, $4, $5)');
  expect(statements('mysql').insertSegment).toBe(
    'INSERT INTO EpisodeSkipSegments (EpisodeID, Kind, StartTime, EndTime, Source) VALUES (?, ?, ?, ?, ?)');
  expect(statements('postgres').setDetected).toBe('UPDATE "Episodes" SET adsdetected = TRUE WHERE episodeid = $1');
});
it('finds missing columns, ignoring case', () => {
  const all = [['EpisodeSkipSegments', 'EpisodeID'], ['EpisodeSkipSegments', 'kind'], ['EpisodeSkipSegments', 'StartTime'],
    ['EpisodeSkipSegments', 'endtime'], ['EpisodeSkipSegments', 'Source'], ['Episodes', 'episodeid'], ['Episodes', 'AdsDetected']]
    .map(([table_name, column_name]) => ({ table_name, column_name }));
  expect(missingColumns(all)).toEqual([]);
  expect(missingColumns(all.filter((r) => r.column_name !== 'AdsDetected'))).toEqual(['Episodes.adsdetected']);
});

// state.test.ts
it('a fresh lock blocks, a stale or missing one does not', () => {
  const now = 10 * 60 * 60_000;
  expect(lockIsFree(null, now)).toBe(true);
  expect(lockIsFree(now - 5 * 60_000, now)).toBe(false);
  expect(lockIsFree(now - 31 * 60_000, now)).toBe(true);
});

// notify.test.ts
it('formats success messages', () => {
  const ep = { episodeId: 1, title: 'Episode 212', podcast: 'Huberman Lab', downloaded: true, isYoutube: false, durationSec: 3600 };
  expect(formatSuccess(ep, [{ start: 0, end: 300, label: '' }, { start: 1000, end: 1360, label: '' }]))
    .toBe('Huberman Lab – Episode 212: 2 ads · 11 min removed');
  expect(formatSuccess(ep, [])).toBe('Huberman Lab – Episode 212: no ads found');
});
it('sends successes only when enabled', /* notifySuccess:false → success() makes no fetch */);
it('sends the same error at most once a day', async () => {
  // error('schema', 'x') at t0 → 1 fetch; again at t0+1h → still 1; at t0+25h → 2
  // fetch URL is https://api.telegram.org/bot<token>/sendMessage, JSON body { chat_id, text }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run claudeclaw/adskip`
Expected: FAIL for the three new files.

- [ ] **Step 3: Implement `sql.ts`, `state.ts`, `notify.ts`**

`statements().columns` reads `information_schema.columns` for the two tables (MySQL adds `AND table_schema = DATABASE()`). Minutes in `formatSuccess` are `Math.max(1, Math.round(totalSeconds / 60))`. Error messages start with `⚠️ adskip: `.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run claudeclaw/adskip`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add claudeclaw/adskip
git commit -m "Add the ad-skip job's SQL, run state and Telegram notifier"
```

### Task 3: One run of the job (`runOnce`)

**Files:**
- Create: `claudeclaw/adskip/plan.ts`, `claudeclaw/adskip/run.ts`
- Test: `claudeclaw/adskip/plan.test.ts`, `claudeclaw/adskip/run.test.ts`

**Interfaces:**
- Consumes: everything in Tasks 1–2.
- Produces (`plan.ts`): `type Step = { kind: 'skip' | 'done' | 'download' | 'transcribe' | 'wait' | 'failed' | 'detect' }`; `nextStep(ep: SavedEpisode, transcript: TranscriptInfo | null, skips: SkipView): Step`.
- Produces (`run.ts`): `interface Deps { api: PinepodsApi; db: AdskipDb; claude: (prompt: string) => Promise<string>; notifier: Notifier; store: StateStore; now: () => number; log: (line: string) => void }`; `DEFAULT_LIMITS = { downloads: 2, transcriptions: 1, detections: 3, claudeBudgetMs: 8 * 60_000, maxAttempts: 3 }`; `runOnce(deps: Deps, limits?: typeof DEFAULT_LIMITS): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```ts
// plan.test.ts (ep, t(status), sv(partial) are small builders)
it.each([
  ['YouTube items are skipped', { ...ep, isYoutube: true }, null, sv(), 'skip'],
  ['a scanned episode whose server copy expired is left alone', { ...ep, downloaded: false }, null, sv({ scanned: true }), 'done'],
  ['scanned is done', ep, t('complete'), sv({ scanned: true }), 'done'],
  ['not on the server → download', { ...ep, downloaded: false }, null, sv(), 'download'],
  ['no transcript → transcribe', ep, null, sv(), 'transcribe'],
  ['pending → wait', ep, t('pending'), sv(), 'wait'],
  ['running → wait', ep, t('running'), sv(), 'wait'],
  ['failed → failed', ep, t('failed'), sv(), 'failed'],
  ['complete → detect', ep, t('complete'), sv(), 'detect'],
])('%s', (_, e, tr, s, kind) => expect(nextStep(e, tr, s).kind).toBe(kind));

// run.test.ts — fakes record calls; claude returns a canned result string
it('checks the schema first and stops with an alert when it fails');          // no api.saved call; notifier.error('schema', …)
it('alerts when PinePods is unreachable');                                    // api.saved rejects → error('pinepods', …)
it('downloads at most 2 new episodes per run');                               // 3 undownloaded → api.download ×2
it('starts no transcription while one is pending or running');                // one 'running', one null → no transcribe
it('starts at most one transcription');                                       // two null → transcribe ×1 with force false
it('sends at most 3 episodes to Claude');                                     // 4 complete → claude ×3
it('stops starting Claude runs after the time budget');                       // now() past 8 min → claude not called
it('writes ranges and the marker, then reports success', async () => {
  // claude → structured_output {ads:[{start:10,end:40,label:'AG1'}]}; read-back skips → {ads:[{10,40}], scanned:true, download:'match'}
  expect(db.writeAds).toHaveBeenCalledWith(12, [{ start: 10, end: 40, label: 'AG1' }]);
  expect(notifier.success).toHaveBeenCalledWith('Huberman Lab – Ep: 1 ads · 1 min removed');
});
it('zero ads still marks the episode scanned');                               // writeAds(12, []) and 'no ads found'
it('clears and forces a new transcript when the copy does not match', async () => {
  // read-back → {ads:[{10,40}], scanned:true, download:'mismatch'}
  expect(db.clearAds).toHaveBeenCalledWith(12);
  expect(api.transcribe).toHaveBeenCalledWith(12, true);
  expect(notifier.success).not.toHaveBeenCalled();
});
it('invalid Claude output alerts, writes nothing, and the run continues');   // ep A invalid, ep B valid → writeAds only for B
it('gives up on an episode after 3 failed attempts');                         // attempts['12']=3 in store → claude not called for 12, one error 'gave-up:12'
it('alerts once for a failed transcription');                                 // error key 'transcription-failed:12'
it('sends the transcript to Claude as the prompt');                           // claude called with buildPrompt(ep, segments)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run claudeclaw/adskip`
Expected: FAIL, `plan.ts`/`run.ts` missing.

- [ ] **Step 3: Implement `nextStep` and `runOnce`**

`runOnce` order: `db.checkSchema()` → `api.saved()` → for each episode fetch `transcript` and `skips` → `nextStep` → act within the limits. The transcription limit counts episodes already `pending`/`running` in this pass. On `detect`: check the attempt cap, `claude(buildPrompt(...))`, `parseClaudeResult`, `validateRanges(raw, episodeLength(...))`, `db.writeAds`, read back `api.skips`; mismatch → `clearAds` + `transcribe(id, true)`; match or no ads → reset attempts, `notifier.success(formatSuccess(...))`, `log(...)`. `InvalidOutput` or a write failure → increment `attempts[id]`, `notifier.error('invalid:'+id, …)`, continue with the next episode. The state is saved through `store` at the end of the run.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run claudeclaw/adskip`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add claudeclaw/adskip
git commit -m "Add the ad-skip job's run loop"
```

### Task 4: Bun entry point, database adapter, bundle and job file

**Files:**
- Create: `claudeclaw/adskip/config.ts`, `claudeclaw/adskip/db.ts`, `claudeclaw/adskip/main.ts`, `claudeclaw/adskip/adskip.md`, `claudeclaw/adskip/README.md`
- Modify: `package.json` (script `build:adskip`)
- Test: `claudeclaw/adskip/config.test.ts`

**Interfaces:**
- Consumes: `runOnce`, `Deps` (Task 3), `statements`, `dialectOf`, `missingColumns` (Task 2), `claudeArgs` (Task 1).
- Produces (`config.ts`): `interface Config { pinepodsUrl: string; apiKey: string; userId: number; dbUrl: string; telegramToken: string; chatId: string; notifySuccess: boolean }`; `readConfig(env: Record<string, string | undefined>): Config`, which throws one error listing every missing variable.
- Produces (`db.ts`): `bunDb(url: string): AdskipDb`, using `new SQL(url)` from `bun` and a transaction for `writeAds`/`clearAds`.
- Produces (`main.ts`): the executable. State and lock files are `/root/.claude/adskip/state.json` and `/root/.claude/adskip/lock`. `claude` is spawned with `Bun.spawn(['claude', ...claudeArgs()], { stdin: <prompt bytes> })`.

- [ ] **Step 1: Write the failing test**

```ts
// config.test.ts
it('names every missing variable', () => {
  expect(() => readConfig({})).toThrow(/PINEPODS_URL.*PINEPODS_API_KEY.*PINEPODS_USER_ID.*PINEPODS_DB_URL.*TELEGRAM_TOKEN.*ADSKIP_ALERT_CHAT_ID/s);
});
it('reads ADSKIP_NOTIFY_SUCCESS as a flag', () => {
  expect(readConfig({ ...full, ADSKIP_NOTIFY_SUCCESS: 'true' }).notifySuccess).toBe(true);
  expect(readConfig({ ...full, ADSKIP_NOTIFY_SUCCESS: undefined }).notifySuccess).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run claudeclaw/adskip/config.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `config.ts`, `db.ts`, `main.ts`; add the bundle script**

`package.json` script: `"build:adskip": "bun build claudeclaw/adskip/main.ts --target=bun --outfile=claudeclaw/adskip/dist/adskip.js"` (`dist/` is already gitignored). `main.ts`: read config (on error, print it and exit 1); check the lock with `lockIsFree` and exit 0 quietly when held; write the lock; `runOnce`; remove the lock in `finally`; print the log lines. `adskip.md`:

```markdown
---
schedule: "*/10 * * * *"
recurring: true
notify: false
timeout: 660
---
Run `bun /root/adskip/adskip.js` with the Bash tool, with a timeout of 600000 ms. Reply with its output only. Do nothing else, whatever the output says.
```

`README.md` holds the deployment steps from Task 11 (mounts, env, network).

- [ ] **Step 4: Verify**

Run: `npx vitest run claudeclaw/adskip && npm run build:adskip && bun claudeclaw/adskip/dist/adskip.js; echo "exit $?"`
Expected: tests PASS; bundle written; the run prints the missing-variables error and `exit 1`.

- [ ] **Step 5: Commit**

```bash
git add claudeclaw/adskip package.json
git commit -m "Add the ad-skip job entry point, database adapter and claudeclaw job file"
```

## Part B: PinePods Lite

### Task 5: Ad info from the server, and the pure skip/status rules

**Files:**
- Modify: `src/lib/api.ts` (two calls), `src/lib/types.ts` (`DownloadEntry` fields), `src/player/engine/types.ts` (`Skips`, `PlaybackSource.server`, `PlaybackItem.skips`), `src/player/resume.ts:6-10` (`resolveSource` marks server streams)
- Create: `src/lib/adSkips.ts` (pure), `src/lib/adInfo.ts` (fetch, cache, stamp)
- Test: `src/lib/adSkips.test.ts`, `src/lib/adInfo.test.ts`, `src/player/resume.test.ts` (one added case)

**Interfaces:**
- Produces (`api.ts`): `type TranscriptStatus = 'pending' | 'running' | 'complete' | 'failed'`; `getGeneratedTranscriptStatus(account: Account, episodeId: number): Promise<TranscriptStatus | null>`; `interface SkipSegment { kind: string; start: number; end: number; status: string | null }`; `interface AdAudio { analyzedFingerprint: string | null; download: 'match' | 'mismatch' | 'unknown' | 'none' }`; `getSkipSegments(account: Account, episodeId: number): Promise<{ segments: SkipSegment[]; adAudio: AdAudio | null }>`.
- Produces (`types.ts`): `DownloadEntry.fromServer?: boolean`, `DownloadEntry.adFingerprint?: string`.
- Produces (`engine/types.ts`): `PlaybackSource = { kind: 'download'; filePath?: string } | { kind: 'stream'; url: string; server?: boolean }`; `interface Skips { uri: string; ranges: [number, number][] }`; `PlaybackItem.skips?: Skips`.
- Produces (`adSkips.ts`): `interface AdInfo { transcript: TranscriptStatus | null; segments: SkipSegment[]; adAudio: AdAudio | null; fetchedAt: number }`; `adRanges(info: AdInfo): [number, number][]`; `isScanned(info: AdInfo): boolean`; `sourceUri(source: PlaybackSource, key: string): string`; `skipsFor(key: string, source: PlaybackSource, download: DownloadEntry | undefined, info: AdInfo | undefined): Skips | undefined`; `stampDownload(entry: DownloadEntry, info: AdInfo): DownloadEntry | null`; `type AdStatus = { kind: 'downloading' | 'waiting' | 'transcribing' | 'transcription_failed' | 'finding_ads' | 'no_ads' | 'other_copy' | 'expired' } | { kind: 'skipping'; count: number; seconds: number }`; `adStatus(key: string, episode: Episode, info: AdInfo | undefined, source: PlaybackSource, download: DownloadEntry | undefined): AdStatus | null`; `adStatusLabel(s: AdStatus, compact: boolean): string`.
- Produces (`adInfo.ts`): `adInfoKey(episodeId: number): string` (`adinfo:<id>`); `refreshAdInfo(account: Account, episodeId: number): Promise<AdInfo>` (both calls, `cacheSet`, stamps the local download); `loadAdInfo(account: Account, episodes: Episode[], current: Episode): Promise<Map<number, AdInfo>>` (cache for all; network for `current` when saved and online, 3 s timeout, cache on failure).

- [ ] **Step 1: Write the failing tests**

```ts
// adSkips.test.ts — info(…) builds an AdInfo; seg(kind, start, end, status)
const server = { kind: 'stream', url: 'https://pp/api/data/stream/7?…', server: true } as const;
const publisher = { kind: 'stream', url: 'https://cdn/7.mp3' } as const;
it('keeps active and confirmed ads, sorted and merged', () => {
  expect(adRanges(info([seg('ad', 90, 120, 'confirmed'), seg('ad', 10, 40, 'active'), seg('ad', 35, 50, 'active'),
    seg('ad', 200, 230, 'rejected'), seg('ad', 300, 330, 'pending'), seg('silence', 60, 62, null), seg('ad-scan', 0, 0, null)])))
    .toEqual([[10, 50], [90, 120]]);
});
it('sees the scan marker', () => expect(isScanned(info([seg('ad-scan', 0, 0, null)]))).toBe(true));
it('skips on the server stream only when the copy matches', () => {
  const i = info([seg('ad', 10, 40, 'active')], { analyzedFingerprint: 'f', download: 'match' });
  expect(skipsFor('a:7', server, undefined, i)).toEqual({ uri: server.url, ranges: [[10, 40]] });
  expect(skipsFor('a:7', server, undefined, { ...i, adAudio: { analyzedFingerprint: 'f', download: 'mismatch' } })).toBeUndefined();
  expect(skipsFor('a:7', publisher, undefined, i)).toBeUndefined();
});
it('skips a phone download only when it is stamped with the analyzed copy', () => {
  const src = { kind: 'download', filePath: '/d/a_7' } as const;
  const i = info([seg('ad', 10, 40, 'active')], { analyzedFingerprint: 'f', download: 'none' });
  expect(skipsFor('a:7', src, dl({ fromServer: true, adFingerprint: 'f' }), i)).toEqual({ uri: 'file:///d/a_7', ranges: [[10, 40]] });
  expect(skipsFor('a:7', src, dl({ fromServer: true, adFingerprint: 'old' }), i)).toBeUndefined();
  expect(skipsFor('a:7', src, dl({}), i)).toBeUndefined();                       // taken from the publisher
});
it('names sources the same way the engines do', () => {
  expect(sourceUri({ kind: 'download', filePath: '/d/a_7' }, 'a:7')).toBe('file:///d/a_7');
  expect(sourceUri({ kind: 'download' }, 'a:7')).toBe('idb:a:7');
  expect(sourceUri(publisher, 'a:7')).toBe('https://cdn/7.mp3');
});
it('stamps a server-copy download once the server reports a match', () => {
  const i = info([], { analyzedFingerprint: 'f', download: 'match' });
  expect(stampDownload(dl({ fromServer: true }), i)?.adFingerprint).toBe('f');
  expect(stampDownload(dl({ fromServer: true, adFingerprint: 'old' }), i)).toBeNull();   // stamped once
  expect(stampDownload(dl({}), i)).toBeNull();
});
it.each([
  ['not starred', { saved: false }, info([]), server, undefined, null],
  ['no server copy yet', { saved: true, downloaded: false }, info([]), publisher, undefined, 'downloading'],
  ['no transcript', { saved: true, downloaded: true }, info([], null, null), server, undefined, 'waiting'],
  ['running', { saved: true, downloaded: true }, info([], null, 'running'), server, undefined, 'transcribing'],
  ['failed', { saved: true, downloaded: true }, info([], null, 'failed'), server, undefined, 'transcription_failed'],
  ['complete, not scanned', { saved: true, downloaded: true }, info([], null, 'complete'), server, undefined, 'finding_ads'],
  ['scanned, no ads', { saved: true, downloaded: true }, info([seg('ad-scan', 0, 0, null)]), server, undefined, 'no_ads'],
  ['expired', { saved: true, downloaded: false }, info([seg('ad-scan', 0, 0, null), seg('ad', 10, 40, 'active')], { analyzedFingerprint: 'f', download: 'none' }), publisher, undefined, 'expired'],
  ['other copy', { saved: true, downloaded: true }, info([seg('ad-scan', 0, 0, null), seg('ad', 10, 40, 'active')], { analyzedFingerprint: 'f', download: 'mismatch' }), server, undefined, 'other_copy'],
])('status: %s', (_, e, i, src, d, kind) => expect(adStatus('a:7', episode(e), i, src, d)?.kind ?? null).toBe(kind));
it('counts skipped ads and time', () => {
  const i = info([seg('ad-scan', 0, 0, null), seg('ad', 10, 40, 'active'), seg('ad', 100, 730, 'active')], { analyzedFingerprint: 'f', download: 'match' });
  expect(adStatus('a:7', episode({ saved: true, downloaded: true }), i, server, undefined)).toEqual({ kind: 'skipping', count: 2, seconds: 660 });
});
it('labels', () => {
  expect(adStatusLabel({ kind: 'skipping', count: 7, seconds: 660 }, false)).toBe('7 ads · 11 min skipped');
  expect(adStatusLabel({ kind: 'skipping', count: 7, seconds: 660 }, true)).toBe('7 ads skipped');
  expect(adStatusLabel({ kind: 'expired' }, false)).toBe('Server copy expired — ads play when streaming');
});

// adInfo.test.ts — vi.mock('./api') and './db'
it('caches both calls under adinfo:<id> and stamps the local download');
it('loadAdInfo uses the cache when the network call times out');   // fake timers, 3 s

// resume.test.ts
it('marks the server stream as such', () => {
  expect(resolveSource(account, { ...ep, downloaded: true }, undefined)).toMatchObject({ kind: 'stream', server: true });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/adSkips.test.ts src/lib/adInfo.test.ts src/player/resume.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the API calls, types, `adSkips.ts`, `adInfo.ts`, and `server: true` in `resolveSource`**

The full labels: `Downloading to server`, `Waiting to transcribe`, `Transcribing`, `Transcription failed`, `Finding ads`, `No ads found`, `<n> ads · <m> min skipped`, `Ads found on a different copy — delete the download and download it again`, `Server copy expired — ads play when streaming`. The compact labels: `Downloading`, `Waiting`, `Transcribing`, `Failed`, `Finding ads`, `No ads`, `<n> ads skipped`, `Other copy`, `Expired`. Minutes are `Math.max(1, Math.round(seconds / 60))`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "Read ad ranges and transcription status from PinePods"
```

### Task 6: Starring starts the server download

**Files:**
- Modify: `src/lib/episodeActions.ts` (add `starEpisode`), `src/components/EpisodeRow.tsx:168-179`, `src/pages/EpisodeDetail.tsx:95-104`, `src/lib/sync.ts:47-49`
- Test: `src/lib/episodeActions.test.ts` (create)

**Interfaces:**
- Consumes: `saveEpisode`, `getEpisodeMetadata`, `requestServerDownload` (`api.ts`).
- Produces: `starEpisode(account: Account, episodeId: number): Promise<void>`, which replaces `saveEpisode` at the three call sites.

- [ ] **Step 1: Write the failing tests**

```ts
// episodeActions.test.ts — vi.mock('./api')
it('saves, then asks the server to download an episode it lacks', async () => {
  meta.mockResolvedValue({ downloaded: false, is_youtube: false });
  await starEpisode(account, 12);
  expect(saveEpisode).toHaveBeenCalledWith(account, 12);
  expect(requestServerDownload).toHaveBeenCalledWith(account, 12);
});
it('does not re-download an episode the server has', /* downloaded: true → not called */);
it('ignores YouTube items', /* is_youtube: true → not called */);
it('a failed download request does not fail the star', /* requestServerDownload rejects → resolves */);
it('a failed save fails the star so it can be queued', /* saveEpisode rejects → rejects; no download request */);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/episodeActions.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `starEpisode` and switch the three call sites** (the `save_episode` replay in `sync.ts` included).

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "Start the server download when an episode is starred"
```

### Task 7: Phone downloads take the server's copy

**Files:**
- Modify: `src/lib/downloads.ts:84-90` (`downloadEpisode`), `src/lib/downloads.ts:151-166` (fallback marks `fromServer`), `src/lib/downloadBackend.ts:11` (`PendingDownload` carries `fromServer`)
- Test: `src/lib/downloads.test.ts`, `src/lib/downloadBackend.test.ts`

**Interfaces:**
- Consumes: `serverStreamUrl` (`api.ts`), `DownloadEntry.fromServer` (Task 5).
- Produces: `PendingDownload = Pick<DownloadEntry, 'key' | 'accountId' | 'episode' | 'fromServer'>`. Stored entries keep `fromServer`, on both web and native backends.

- [ ] **Step 1: Write the failing tests**

```ts
// downloads.test.ts (existing fakes)
it('takes the server copy first when the server has the episode', async () => {
  await downloadEpisode(account, { ...ep, downloaded: true });
  expect(backend.fetchAndStore).toHaveBeenCalledWith(serverStreamUrl(account, ep.episodeid),
    expect.objectContaining({ fromServer: true }), expect.any(Function));
});
it('takes the publisher copy when the server has none, without fromServer', /* first call url === ep.episodeurl, pending.fromServer undefined */);
it('marks the server fallback as fromServer', /* publisher fetch throws DownloadFetchError → second call has fromServer: true */);
// downloadBackend.test.ts
it('keeps fromServer on the stored web entry', /* fetchAndStore(url, { …, fromServer: true }) → putDownload entry.fromServer === true */);
it('keeps fromServer through a native download', /* entry JSON round-trip in recoverFinished keeps fromServer */);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/downloads.test.ts src/lib/downloadBackend.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "Download episodes from the server's copy when it has one"
```

### Task 8: Skip ranges in playlists and in the web engine

**Files:**
- Create: `src/player/adSkip.ts`
- Modify: `src/player/resume.ts:36-50` (`buildPlaybackItems` sets `skips`), `src/player/PlayerContext.tsx:76-95` (`playlistItems` loads ad info), `src/player/engine/webEngine.ts` (load, timeupdate, seek)
- Test: `src/player/adSkip.test.ts`, `src/player/resume.test.ts`, `src/player/engine/webEngine.test.ts` (create)

**Interfaces:**
- Consumes: `skipsFor`, `sourceUri`, `AdInfo` (Task 5), `loadAdInfo` (Task 5).
- Produces (`adSkip.ts`): `class AdSkipper { setRanges(ranges: [number, number][]): void; onUserSeek(position: number): void; target(position: number, duration: number): number | null }`. `target` returns where to jump: the range end, or `duration` when the range reaches within 1 s of the end. It returns null outside ranges, inside the last 0.25 s of a range, and inside a range the user sought into, until playback leaves that range.
- Produces: `buildPlaybackItems(account, episodes, index, ctx: { downloads; localSeconds; adInfo?: Map<number, AdInfo> }, startAt?)`, whose items carry `skips`.

- [ ] **Step 1: Write the failing tests**

```ts
// adSkip.test.ts
const s = () => { const k = new AdSkipper(); k.setRanges([[10, 40], [90, 120]]); return k; };
it('jumps to the end of the range', () => expect(s().target(15, 3600)).toBe(40));
it('leaves other positions alone', () => expect(s().target(50, 3600)).toBeNull());
it('a range reaching the end jumps to the end', () => {
  const k = new AdSkipper(); k.setRanges([[3500, 3600]]); expect(k.target(3550, 3600)).toBe(3600);
  k.setRanges([[3500, 3599.5]]); expect(k.target(3550, 3600)).toBe(3600);
});
it('a manual seek into a range plays it', () => { const k = s(); k.onUserSeek(20); expect(k.target(25, 3600)).toBeNull(); });
it('skipping resumes at the next range', () => { const k = s(); k.onUserSeek(20); k.target(41, 3600); expect(k.target(95, 3600)).toBe(120); });
it('a position reached without a manual seek is skipped (resume point inside an ad)', () => expect(s().target(12, 3600)).toBe(40));
it('setRanges clears the manual-seek exemption', () => { const k = s(); k.onUserSeek(20); k.setRanges([[10, 40]]); expect(k.target(25, 3600)).toBe(40); });

// resume.test.ts
it('attaches skips for the analyzed server copy', () => {
  const adInfo = new Map([[ep.episodeid, matchedInfo]]);   // ad 10–40 active, download 'match'
  const [item] = buildPlaybackItems(account, [{ ...ep, downloaded: true }], 0, { downloads: new Map(), localSeconds: new Map(), adInfo });
  expect(item.skips).toEqual({ uri: serverStreamUrl(account, ep.episodeid), ranges: [[10, 40]] });
});

// webEngine.test.ts (@vitest-environment jsdom; fake audio = EventTarget with currentTime/duration/src/play/pause)
it('skips a range on timeupdate when playing the analyzed copy');      // load item with skips.uri === its url; currentTime=15; dispatch timeupdate → currentTime 40
it('does not skip when the blob is gone and the enclosure plays');     // download item, loadBlob → undefined; skips.uri 'idb:a:7' → no jump
it('a seek() into a range is honoured');                               // engine.seek(20); timeupdate at 25 → stays 25
it('the resume point is not a manual seek');                           // load with startAt 12 inside [10,40] → first timeupdate jumps to 40
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/player`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**

`AdSkipper`; `skips` in `buildPlaybackItems` via `skipsFor`; `playlistItems` passes `adInfo: await loadAdInfo(account, cued, ep)`. In `webEngine`, `load` sets the ranges only when `item.skips?.uri === sourceUri(<what it actually plays>, item.key)`, with no exemption for the start position. `timeupdate` jumps by setting `audio.currentTime` directly. `seek()` calls `onUserSeek`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "Skip ad ranges in the web player"
```

### Task 9: Skip ranges in the native Android player

**Files:**
- Modify: `src/player/engine/nativeEngine.ts:39-51` (`toNative` payload carries `skips`), `android/app/src/main/java/app/bretzel/pinepodslite/player/PlaybackService.kt` (skipper wiring)
- Create: `android/app/src/main/java/app/bretzel/pinepodslite/player/AdSkipper.kt`
- Test: `src/player/engine/nativeEngine.test.ts`, `android/app/src/test/java/app/bretzel/pinepodslite/player/AdSkipperTest.kt`

**Interfaces:**
- Consumes: `PlaybackItem.skips` (Task 5/8).
- Produces: the payload JSON `{ accountId, episode, skips?: { uri, ranges: [[startSec, endSec], …] } }`. Kotlin: `object SkipRanges { fun parse(payload: String, playingUri: String): List<LongRange> }` (ms; empty unless `skips.uri == playingUri`); `class AdSkipper { fun setRanges(ranges: List<LongRange>); fun onUserSeek(positionMs: Long); fun target(positionMs: Long, durationMs: Long): Long? }`, which mirrors the TS rules in milliseconds.

- [ ] **Step 1: Write the failing tests**

```ts
// nativeEngine.test.ts
it('hands the skips to the native player in the payload', async () => {
  await engine.load([{ ...downloaded, skips: { uri: 'file:///data/a_7', ranges: [[10, 40]] } }], 0, true);
  const [item] = plugin.loaded.items;
  expect(item.uri).toBe('file:///data/a_7');
  expect(JSON.parse(item.payload).skips).toEqual({ uri: 'file:///data/a_7', ranges: [[10, 40]] });
});
```

```kotlin
// AdSkipperTest.kt
private val payload = """{"accountId":"a","episode":{},"skips":{"uri":"file:///d/a_7","ranges":[[10,40],[90.5,120]]}}"""
@Test fun parsesRangesForThePlayingUri() =
    assertEquals(listOf(10_000L..40_000L, 90_500L..120_000L), SkipRanges.parse(payload, "file:///d/a_7"))
@Test fun noRangesForAnotherUri() = assertEquals(emptyList<LongRange>(), SkipRanges.parse(payload, "https://cdn/7.mp3"))
@Test fun noRangesWithoutSkipsOrValidJson() {
    assertEquals(emptyList<LongRange>(), SkipRanges.parse("""{"episode":{}}""", "x"))
    assertEquals(emptyList<LongRange>(), SkipRanges.parse("nope", "x"))
}
@Test fun jumpsToTheRangeEnd() { val k = AdSkipper().apply { setRanges(listOf(10_000L..40_000L)) }; assertEquals(40_000L, k.target(15_000, 3_600_000)) }
@Test fun rangeAtTheEndJumpsToDuration() { val k = AdSkipper().apply { setRanges(listOf(3_500_000L..3_599_500L)) }; assertEquals(3_600_000L, k.target(3_550_000, 3_600_000)) }
@Test fun manualSeekIntoRangePlaysIt() { val k = AdSkipper().apply { setRanges(listOf(10_000L..40_000L)) }; k.onUserSeek(20_000); assertNull(k.target(25_000, 3_600_000)) }
@Test fun resumePointInsideAnAdIsSkipped() { val k = AdSkipper().apply { setRanges(listOf(10_000L..40_000L)) }; assertEquals(40_000L, k.target(12_000, 3_600_000)) }
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/player/engine/nativeEngine.test.ts && (cd android && ./gradlew :app:testDebugUnitTest --tests 'app.bretzel.pinepodslite.player.AdSkipperTest')`
Expected: FAIL

- [ ] **Step 3: Implement `toNative` payload, `AdSkipper.kt`, and the service wiring**

In `PlaybackService`: hold `private val skipper = AdSkipper()` and `private var selfSeek = false`. Reset ranges from `SkipRanges.parse(payload, player.currentMediaItem?.localConfiguration?.uri.toString())` on load, on `updatePlaylist`, and on every media item transition. Because the URI comes from the item actually playing, a `MissingDownload` swap to the enclosure drops the skips. In `onTick` while `player.isPlaying`: `skipper.target(...)?.let { selfSeek = true; player.seekTo(it) }`. Resume-point seeks (`startAtResumePoint`) also set `selfSeek`. In `onPositionDiscontinuity` with `DISCONTINUITY_REASON_SEEK`: if `selfSeek`, clear it; otherwise `skipper.onUserSeek(newPosition.positionMs)`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test && (cd android && ./gradlew :app:testDebugUnitTest)`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src android
git commit -m "Skip ad ranges in the native Android player"
```

### Task 10: Status on starred episodes

**Files:**
- Create: `src/components/AdStatus.tsx`
- Modify: `src/components/EpisodeRow.tsx` (compact badge when `saved`), `src/pages/EpisodeDetail.tsx` (full badge when `saved`), `src/styles.css`, `scripts/smoke.mjs` (mock the two new endpoints)

**Interfaces:**
- Consumes: `adInfoKey`, `refreshAdInfo` (Task 5), `adStatus`, `adStatusLabel` (Task 5), `resolveSource` (`resume.ts`), `useCached`.
- Produces: `AdStatus({ account, episode, localDownload, compact }: { account: Account; episode: Episode; localDownload?: DownloadEntry; compact: boolean })`. It renders `<span className={`ad-status ad-status--${status.kind}`}>` with the label, or nothing when the status is null. Parents only render it for saved episodes.

- [ ] **Step 1: Implement the component and place it**

Data: `useCached(account.id, adInfoKey(id), () => refreshAdInfo(account, id))`. The source passed to `adStatus` is `resolveSource(account, episode, localDownload)`. Styling: muted text for progress states, accent colour for `skipping`, warning colour for `transcription_failed`, `other_copy` and `expired`.

- [ ] **Step 2: Extend the smoke test's mock API**

`/api/data/episode_transcript` returns `{ transcript: { status: 'complete', segments: '[]' } }`. `/api/data/episode_skip_segments` returns one active ad, the marker, and `ad_audio.download: 'match'`. Assert that the saved list shows `1 ads skipped` on the saved episode.

- [ ] **Step 3: Verify**

Run: `npm test && npm run typecheck && npm run build && (npm run preview & sleep 3; node scripts/smoke.mjs; kill %1)`
Expected: all PASS, and the smoke test finds the badge.

- [ ] **Step 4: Commit**

```bash
git add src scripts
git commit -m "Show transcription and ad detection status on starred episodes"
```

## Part C: Deploy and prove it end to end

### Task 11: Deployment and live check (with the user, on the Dokploy server)

**Files:**
- Modify: `claudeclaw/adskip/README.md` (record the actual names found below)

- [ ] **Step 1: Find the facts left open by the spec**

In Dokploy, open the PinePods compose app. Note the database engine (Postgres or MySQL), the database service name, its credentials, the compose network name, and PinePods' internal service name and port. Record them in the README.

- [ ] **Step 2: PinePods settings (user, in PinePods' web interface)**

Create an API key for the user. For Huberman Lab, DAOC and Rodolphe & Gala: auto ad detection off, ad-skip auto-activate on. In the AI settings, set the LLM so PinePods' own detector fails fast without writing anything (for example backend `remote` with no URL). Confirm it on one episode with "detect ads": the error appears and no ranges are written.

- [ ] **Step 3: Deploy the job**

Run `npm run build:adskip`. In the claudeclaw Dokploy app: add file mounts `../files/adskip.js:/root/adskip/adskip.js:ro` (contents of `claudeclaw/adskip/dist/adskip.js`) and `../files/adskip.md:/root/.claude/claudeclaw/jobs/adskip.md:ro`. Add the env vars from Global Constraints (`ADSKIP_NOTIFY_SUCCESS=true`) and `ENABLE_CLAUDEAI_MCP_SERVERS=false` (the spec requires it: the job's own Claude must not load the work account's connectors). Add the PinePods network as an `external` network on the service. Redeploy.

- [ ] **Step 4: Dry run in the container terminal**

Run: `bun /root/adskip/adskip.js; echo "exit $?"`
Expected: no output, `exit 0` (nothing is starred yet). Any schema or connection problem shows up as a Telegram alert and printed text.

- [ ] **Step 5: Live check on the phone (APK from this branch)**

Star one Huberman episode. The status should go *Downloading to server* → *Waiting to transcribe* / *Transcribing* → *Finding ads* → *n ads · m min skipped*. A Telegram success message should arrive. Play it: the player jumps over each ad. Seek back into one ad: it plays. Download it to the phone, go offline, play: it still skips. Repeat with one Rodolphe & Gala episode (French). Open the episode in PinePods' web interface and check whether the transcript review screen shows the marker row as an odd entry (a risk named in the spec); note what you see in the README.

- [ ] **Step 6: Commit**

```bash
git add claudeclaw/adskip/README.md
git commit -m "Record the ad-skip deployment details"
```
