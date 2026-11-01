# PinePods Lite Android App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship PinePods Lite as a sideloaded Android APK whose playback runs in a native Media3 service, so headphone play resumes a paused episode reliably, built and released by GitHub Actions.

**Architecture:** The React UI talks to a `PlayerEngine` interface. In the browser it is `WebEngine` (today's `<audio>` logic, moved). In the Capacitor Android app it is `NativeEngine`, a thin adapter over a Kotlin plugin that drives a Media3 `MediaLibraryService`. The native side owns transport, media session, auto-advance, sleep timer and a report journal. The web code keeps choosing sources and resume points, building the playlist, and syncing to the server, draining the native journal on every wake. On Android, downloads are native (DownloadManager → files); the IndexedDB `downloads` store remains the index.

**Tech Stack:** React 18 + Vite 5 + TypeScript, Vitest 5.0.5, Capacitor 8.6.0, Android Gradle Plugin 8.13.0 / Gradle 8.14.3 (from the Capacitor template), Kotlin 2.4.21, AndroidX Media3 1.11.1, JUnit 4.13.2 + `org.json:json:20260814` (unit tests only), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-01-android-native-player-design.md`

## Global Constraints

- The browser/Docker version must behave exactly as today; `npm run smoke` must pass after every task that touches `src/`.
- App id `app.bretzel.pinepodslite`, app name `PinePods Lite`.
- `minSdkVersion` 24 (template default, ≤ 33 as required for the Pixel 4a on Android 13); `compileSdk`/`targetSdk` 36.
- Pin exact versions: `@capacitor/core`, `@capacitor/android`, `@capacitor/cli` `8.6.0`; `@capacitor/assets` `4.0.0`; `vitest` `5.0.5`; Media3 `1.11.1`; Kotlin Gradle plugin `2.4.21` (if AGP 8.13.0 rejects it, use the newest `2.3.x`).
- Cleartext HTTP allowed (`usesCleartextTraffic="true"`), WebView mixed content allowed.
- The native side never talks to the PinePods server. Server sync stays in the web code, and positions may arrive late but must never be dropped.
- Media buttons copy today's web app: play, pause, back 15 s, forward 30 s, seek-to, previous/next episode.
- Playback speed is not persisted across restarts.
- Secrets live only in GitHub Actions secrets: `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`. Nothing signing-related is ever committed.
- `versionCode` = workflow run number; `versionName` = `0.1.<run number>`.
- Full releases (`android-v0.1.<run>`, marked latest) only from `main`. Other branches publish a GitHub **pre-release** `android-test-0.1.<run>`, which Obtainium ignores by default. Every run also uploads the workflow artifact. APKs are installed on the phone by downloading them from the repo's Releases page, never over USB/adb.
- CI is the only Android build loop. Do not install a JDK, the Android SDK or Docker images on the Mac. Kotlin verification steps mean "commit, push the branch and watch the run": `git push -u origin HEAD && gh run watch --exit-status $(gh run list --branch "$(git branch --show-current)" --limit 1 --json databaseId --jq '.[0].databaseId')`. A step that pushes commits what it has first.
- Test files import from `vitest` explicitly (`import { describe, it, expect, vi } from 'vitest'`). No globals.
- Work happens on branch `android-native-player`. Merging to `main` (which publishes the first release) needs the user's go-ahead.

## Review Focus

1. **App opened while the native player already plays something the UI didn't start** (after a headphone resume from a dead process, or auto-advance while the UI slept): the UI must adopt that item and must not reload, restart or pause it. Pinned by `decideStartup` tests in Task 2.
2. **Journal reports for an account that was removed, or for an episode already completed:** they must be skipped and acknowledged without throwing, and the others in the batch must still be applied. Pinned by `applyReports` tests in Task 2.
3. **Switching accounts mid-playback:** positions and completions must go to the account the episode was started under, not the active account. Pinned by the `buildPlaybackItems` and `applyReports` account tests in Task 2.
4. **Very long podcasts (450+ episodes) as the previous/next source:** only a window of items crosses the bridge, and moving through it keeps previous/next correct. Pinned by `playlistWindow` tests in Task 2.
5. **Enclosure URLs that redirect between http and https** (tracking prefixes): native playback and native downloads must follow them. Pinned by the on-device check in Task 9 (step 3, check R5), with `setAllowCrossProtocolRedirects(true)` required in Task 7.

---

### Task 1: Test harness and extracted playback helpers

**Files:**
- Modify: `package.json` (add `vitest@5.0.5` dev dependency, script `"test": "vitest run"`)
- Create: `src/player/engine/types.ts` (only `PlaybackSource` for now)
- Create: `src/player/resume.ts`
- Create: `src/player/positions.ts`
- Modify: `src/player/PlayerContext.tsx:113-145, 245-270` (use the helpers; behaviour unchanged)
- Test: `src/player/resume.test.ts`, `src/player/positions.test.ts`

**Interfaces:**
- Produces:
  - `type PlaybackSource = { kind: 'download'; filePath?: string } | { kind: 'stream'; url: string }`
  - `resolveSource(account: Account, ep: Episode, download: DownloadEntry | undefined): PlaybackSource` (download entry → `download` with its `filePath`; else `ep.downloaded` → `stream` at `serverStreamUrl`; else `stream` at `ep.episodeurl`)
  - `resumePoint(ep: Episode, localSeconds: number | undefined, startAt?: number): number` (today's rule from `PlayerContext.tsx:259-270`)
  - `savePositionLocally(account: Account, ep: Episode, seconds: number, duration: number, synced: boolean): Promise<void>`
  - `syncEpisodePosition(account: Account, ep: Episode, seconds: number, duration: number): Promise<void>` (today's `syncToServer` with explicit account and episode: no-op for `seconds <= 0`, local-only unsynced for `episodeid < 0`, otherwise local synced + `runOrQueue(record_position)`)

- [ ] **Step 1: Write the failing tests**

```ts
// src/player/resume.test.ts
const acct = { id: 'a1', serverUrl: 'https://pods.example.com', apiKey: 'k', userId: 3 } as Account;
it('prefers a local download', () =>
  expect(resolveSource(acct, ep({ episodeid: 7, downloaded: true }), { filePath: '/x/a1_7' } as DownloadEntry))
    .toEqual({ kind: 'download', filePath: '/x/a1_7' }));
it('uses the server copy when the server downloaded it', () =>
  expect(resolveSource(acct, ep({ episodeid: 7, downloaded: true }), undefined))
    .toEqual({ kind: 'stream', url: serverStreamUrl(acct, 7) }));
it('falls back to the enclosure URL', () =>
  expect(resolveSource(acct, ep({ episodeurl: 'http://cdn/x.mp3' }), undefined))
    .toEqual({ kind: 'stream', url: 'http://cdn/x.mp3' }));
it('explicit start wins', () => expect(resumePoint(ep({ listenduration: 50 }), 80, 42)).toBe(42));
it('takes the freshest of local and server', () => expect(resumePoint(ep({ listenduration: 50 }), 80)).toBe(80));
it('restarts completed episodes', () => expect(resumePoint(ep({ completed: true }), 80)).toBe(0));
it('restarts within 15 s of the end', () => expect(resumePoint(ep({ episodeduration: 1000 }), 990)).toBe(0));

// src/player/positions.test.ts  (vi.mock '../lib/db', '../lib/api', '../lib/sync')
it('ignores zero seconds', ...);                    // putLocalPosition not called
it('keeps preview episodes local', ...);            // episodeid -5 → putLocalPosition({synced:false}), runOrQueue not called
it('saves locally then queues record_position', ...); // putLocalPosition({synced:true, key:'a1:7'}), runOrQueue(acct, {kind:'record_position', episodeId:7, seconds:120}, fn)
```
(`ep(overrides)` is a local factory returning a complete `Episode` with defaults.)

- [ ] **Step 2: Run `npx vitest run src/player` and confirm it fails** (modules not found)

- [ ] **Step 3: Implement `resume.ts`, `positions.ts` and the `PlaybackSource` type**

- [ ] **Step 4: Switch `PlayerContext` to the helpers.** `persistPosition`/`syncToServer` call `savePositionLocally`/`syncEpisodePosition` with `playbackAccountRef.current` and `episodeRef.current`. `loadEpisode` uses `resumePoint`. The source choice keeps calling `getDownloadBlob` (switched to `resolveSource` in Task 3).

- [ ] **Step 5: Verify.** Run `npx vitest run`: all pass. Run `npm run build`, then `npm run preview` in the background, then `npm run smoke`: every check prints `PASS` and the script exits 0. Stop the preview server.

- [ ] **Step 6: Commit** — `git commit -m "Extract playback source, resume and position helpers; add vitest"`

---

### Task 2: Engine contract, playlist building and report handling

**Files:**
- Modify: `src/player/engine/types.ts`
- Modify: `src/player/resume.ts` (add `playlistWindow`, `buildPlaybackItems`, `decideStartup`)
- Create: `src/player/reports.ts`
- Test: `src/player/resume.test.ts`, `src/player/reports.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers.
- Produces (in `engine/types.ts`):

```ts
export interface PlaybackItem { key: string /* `${accountId}:${episodeId}` */; accountId: string; episode: Episode; source: PlaybackSource; startAt: number }
export interface EngineSnapshot { currentKey: string | null; playing: boolean; position: number; duration: number; rate: number; sleepRemaining: number | null; sleepMinutes: number | null }
export interface PlaybackReport { seq: number; kind: 'position' | 'ended'; key: string; accountId: string; episode: Episode; seconds: number; at: number }
export type EngineEvent = { type: 'state'; snapshot: EngineSnapshot } | { type: 'reports' };
export interface PlayerEngine {
  readonly kind: 'web' | 'native';
  init(): Promise<EngineSnapshot>;                       // web: idle snapshot; native: current native state
  load(items: PlaybackItem[], index: number, autoplay: boolean): Promise<void>;
  updatePlaylist(items: PlaybackItem[]): void;           // current key must be in items; never interrupts playback
  current(): PlaybackItem | null;
  play(): Promise<void>; pause(): void; seek(seconds: number): void; setRate(rate: number): void;
  setAutoAdvance(on: boolean): void; setSleepTimer(minutes: number | null): void; setSleepRepeat(repeat: boolean): void;
  snapshot(): EngineSnapshot;
  readReports(): Promise<PlaybackReport[]>;
  ackReports(throughSeq: number): Promise<void>;
  subscribe(listener: (e: EngineEvent) => void): () => void;
}
```
- Produces (in `resume.ts`):
  - `playlistWindow(list: Episode[], currentId: number, before = 1, after = 25): { episodes: Episode[]; index: number }`
  - `buildPlaybackItems(account: Account, episodes: Episode[], index: number, ctx: { downloads: Map<number, DownloadEntry>; localSeconds: Map<number, number> }, startAt?: number): PlaybackItem[]` (`startAt` override applies to `episodes[index]` only)
  - `decideStartup(snap: EngineSnapshot, current: PlaybackItem | null, lastPlayed: Episode | undefined, accounts: Account[]): { kind: 'adopt'; item: PlaybackItem; account: Account } | { kind: 'restore'; episode: Episode } | { kind: 'none' }`
- Produces (in `reports.ts`):
  - `applyReports(reports: PlaybackReport[], deps: { accounts: Account[]; syncPosition(a: Account, ep: Episode, seconds: number, duration: number): Promise<void>; markCompleted(a: Account, ep: Episode): Promise<void> }): Promise<number>` returns the highest `seq` seen, or 0 for an empty batch.

- [ ] **Step 1: Write the failing tests**

```ts
// playlistWindow — Review Focus 4
const long = Array.from({ length: 450 }, (_, i) => ep({ episodeid: i }));
expect(playlistWindow(long, 200)).toEqual({ episodes: long.slice(199, 226), index: 1 });
expect(playlistWindow(long, 0)).toEqual({ episodes: long.slice(0, 26), index: 0 });
expect(playlistWindow(long, 449)).toEqual({ episodes: long.slice(448), index: 1 });

// buildPlaybackItems — Review Focus 3
const items = buildPlaybackItems(playbackAcct /* id 'a2', not the active one */, [e1, e2], 0, { downloads: new Map([[e2.episodeid, dl]]), localSeconds: new Map([[e1.episodeid, 80]]) }, 42);
expect(items.map((i) => i.accountId)).toEqual(['a2', 'a2']);
expect(items[0]).toMatchObject({ key: `a2:${e1.episodeid}`, startAt: 42 });
expect(items[1].source).toEqual({ kind: 'download', filePath: dl.filePath });

// decideStartup — Review Focus 1
expect(decideStartup(playingSnap('a1:9'), item9, lastPlayed7, [acct1])).toEqual({ kind: 'adopt', item: item9, account: acct1 });
expect(decideStartup(playingSnap('a9:9'), itemOfRemovedAccount, lastPlayed7, [acct1])).toEqual({ kind: 'restore', episode: lastPlayed7 });
expect(decideStartup(idleSnap, null, undefined, [acct1])).toEqual({ kind: 'none' });

// applyReports — Review Focus 2 and 3
it('ended syncs the full duration then marks completed', ...);           // syncPosition(acct, ep, 1800, 1800) before markCompleted(acct, ep)
it('does not re-complete completed or preview episodes', ...);            // ep.completed or episodeid < 0 → markCompleted not called
it('position reports sync to the report account', ...);                 // accountId 'a2' → syncPosition called with account a2 although a1 exists
it('skips a position superseded by a later ended for the same key', ...);
it('skips reports of unknown accounts but still acks them', ...);        // returns max seq, deps not called for it
it('keeps going when one report fails', ...);                           // markCompleted rejects for #1 → #2 still applied
```

- [ ] **Step 2: Run `npx vitest run src/player` and confirm the new tests fail**

- [ ] **Step 3: Implement the types, `playlistWindow`, `buildPlaybackItems`, `decideStartup` and `applyReports`.** `applyReports` processes in `seq` order and catches errors per report.

- [ ] **Step 4: Run `npx vitest run`: all pass**

- [ ] **Step 5: Commit** — `git commit -m "Add player engine contract, playlist window and journal report handling"`

---

### Task 3: WebEngine, and PlayerContext on the engine

**Files:**
- Create: `src/player/engine/webEngine.ts`
- Create: `src/player/engine/index.ts`
- Modify: `src/player/PlayerContext.tsx` (substantial rewrite of internals; `PlayerState` and `usePlayer()` unchanged)

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces:
  - `class WebEngine implements PlayerEngine` (`kind = 'web'`), constructor `(audio: HTMLAudioElement = new Audio(), loadBlob = getDownloadBlob)`
  - `createEngine(): PlayerEngine` in `engine/index.ts` (returns `new WebEngine()` for now; Task 7 adds the native branch)

**WebEngine owns, moved verbatim in behaviour from today's `PlayerContext`:**
- The `<audio>` element. A `download` source loads its blob through `loadBlob(accountId, episodeId)` into an object URL, revoked when replaced. Seeking to `startAt` happens on `loadedmetadata`, as today.
- Media Session metadata, action handlers (play, pause, seekbackward −15, seekforward +30, seekto, previoustrack/nexttrack from its own playlist, null at the ends), `playbackState` and `setPositionState`.
- The sleep timer: countdown even while paused; fade over 25 steps × 200 ms, then pause and restore volume; a one-shot timer disarms on expiry; check-in mode re-arms on every play except auto-advance.
- Auto-advance: on `ended`, append an `ended` report (`seconds` = duration) and emit `{type:'reports'}`. Then, if auto-advance is on and a next item exists, load it and play.
- `state` events on play, pause, `timeupdate`, `durationchange`, `ratechange`, item change and sleep ticks.

**PlayerContext keeps:** account and queue state, `previousEpisode`/`nextEpisode`/`upNextSource` (same rules as today), localStorage for `autoplayNext` and `sleepRepeat` (pushed to the engine on mount and on change), and the 3 s local and 15 s server position intervals (reading `engine.snapshot().position` and `engine.current()`).
- **`play(ep, startAt?, queue?)`:** builds the item list with `playlistWindow` over the queue (or `[ep]` until the neighbours are known), then `buildPlaybackItems` with the downloads and `listLocalPositions` of the playback account, then `engine.load`.
- **When the neighbours effect resolves:** call `engine.updatePlaylist` with the windowed list.
- **On a `state` event whose `currentKey` differs from the current episode's key:** sync the outgoing episode's last known position, adopt `engine.current()` (set the episode, the playback account, `offlineSource` = source kind is `download`, and the `LAST_PLAYED` cache).
- **On `playing` changing from true to false:** `syncEpisodePosition`.
- **On a `reports` event, and on `visibilitychange` to visible:** `readReports` → `applyReports` (with `markCompleted` from `episodeActions`, which also sets the on-screen episode to completed when its key is current) → `ackReports`.
- **Startup:** `await engine.init()`, then `decideStartup` with `LAST_PLAYED`. `adopt` sets state without calling `load`. `restore` loads with `autoplay=false`, as today.

- [ ] **Step 1: Implement `WebEngine` and `createEngine`**

- [ ] **Step 2: Rewire `PlayerContext` to `createEngine()` as described.** Remove `audioRef`, `blobUrlRef`, the sleep-timer effects and the media-session effects from it.

- [ ] **Step 3: Run `npx tsc -b --noEmit` and `npx vitest run`: no errors, all pass**

- [ ] **Step 4: Run the smoke test** (`npm run build`, then `npm run preview` in the background, then `npm run smoke`). Expected: every check prints `PASS`, including `auto-complete + auto-remove download on finish`, `sleep timer set, check-in toggle, cancel`, `previous/next episode in full player`, `autoplay next episode when enabled` and `transcript view with tap-to-seek`; exit code 0.

- [ ] **Step 5: Commit** — `git commit -m "Move browser playback behind a WebEngine; PlayerContext drives the engine"`

---

### Task 4: Download backend abstraction (browser implementation)

**Files:**
- Create: `src/lib/downloadBackend.ts`
- Modify: `src/lib/types.ts:81-89` (`DownloadEntry.filePath?: string`)
- Modify: `src/lib/db.ts` (add `putDownloadEntry(entry: DownloadEntry): Promise<void>`, metadata only)
- Modify: `src/lib/downloads.ts` (use the backend for fetch+store and removal; export `recoverDownloads()`)
- Modify: `src/lib/accounts.tsx:88-90` (call `getDownloadBackend().removeAccount(id)` after `dbRemoveAccount`)
- Modify: `src/App.tsx:35` (call `recoverDownloads()` before `sweepCompletedDownloads(active)`)

**Interfaces:**
- Produces:

```ts
export type PendingDownload = Pick<DownloadEntry, 'key' | 'accountId' | 'episode'>;
export interface DownloadBackend {
  fetchAndStore(url: string, pending: PendingDownload, onProgress: (fraction?: number) => void): Promise<DownloadEntry>;
  remove(accountId: string, episodeId: number): Promise<void>;
  removeAccount(accountId: string): Promise<void>;
  recoverFinished(): Promise<number>;   // downloads completed while the UI wasn't running
}
export const webDownloadBackend: DownloadBackend;      // today's fetchWithProgress + putDownload(entry, blob); remove = deleteDownload; removeAccount/recoverFinished no-ops
export function getDownloadBackend(): DownloadBackend;  // webDownloadBackend until Task 8
export function recoverDownloads(): Promise<void>;     // in downloads.ts: backend.recoverFinished(), notify() if > 0
```
`downloadEpisode` keeps its two strategies, concurrency cap and progress throttling. Only the "fetch bytes and store" and "delete" steps go through the backend. `removeDownloadedEpisode` and `sweepCompletedDownloads` call `backend.remove`.

- [ ] **Step 1: Write the failing test** `src/lib/downloadBackend.test.ts`: `webDownloadBackend.fetchAndStore` with a mocked `fetch` (body `new Uint8Array(10)`, `Content-Type: audio/mpeg`) and a mocked `putDownload` resolves to an entry with `size: 10`, `mimeType: 'audio/mpeg'` and `key` from `pending`, and calls `putDownload(entry, blob)`.
- [ ] **Step 2: Run `npx vitest run src/lib` and confirm it fails**
- [ ] **Step 3: Implement the backend and rewire `downloads.ts`, `db.ts`, `types.ts`, `accounts.tsx` and `App.tsx`**
- [ ] **Step 4: Run `npx vitest run` (all pass) and the smoke test (all `PASS`, exit 0)**
- [ ] **Step 5: Commit** — `git commit -m "Route download storage through a backend interface"`

---

### Task 5: Capacitor Android shell, signing and CI

**Files:**
- Modify: `package.json` (deps `@capacitor/core@8.6.0`, `@capacitor/android@8.6.0`; dev `@capacitor/cli@8.6.0`, `@capacitor/assets@4.0.0`; script `"build:android": "npm run build && cap sync android"`)
- Create: `capacitor.config.ts` (`appId: 'app.bretzel.pinepodslite'`, `appName: 'PinePods Lite'`, `webDir: 'dist'`, `android: { allowMixedContent: true }`)
- Create: `android/` (via `npx cap add android`, committed)
- Create: `assets/icon-only.png` (copy of `public/icon-512.png`) plus the generated Android icon resources
- Modify: `android/build.gradle` (classpath `org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21`)
- Modify: `android/app/build.gradle` (apply `kotlin-android`; Java and Kotlin target 21; `versionCode`/`versionName` from Gradle properties `versionCode`/`versionName`, defaulting to `1`/`0.1.0`; `signingConfigs.release` from env vars `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` with `storeType "pkcs12"` and `keyPassword` = store password, applied to `release`; deps `androidx.media3:media3-exoplayer:1.11.1`, `androidx.media3:media3-session:1.11.1`; test deps `junit:junit:4.13.2`, `org.json:json:20260814`)
- Modify: `android/app/src/main/AndroidManifest.xml` (`android:usesCleartextTraffic="true"` on `<application>`)
- Modify: `android/app/src/main/java/app/bretzel/pinepodslite/MainActivity.java` (route service-worker requests through Capacitor's local server)
- Modify: `.gitignore` (`*.p12`, `*.keystore`, `android/app/release/`)
- Create: `.github/workflows/android.yml`

**Interfaces:**
- Produces: a signed APK artifact named `pinepods-lite-apk` per run. Later tasks add Kotlin under `android/app/src/main/java/app/bretzel/pinepodslite/` and tests under `android/app/src/test/java/app/bretzel/pinepodslite/`, which this workflow runs.

- [ ] **Step 1: Install the Capacitor packages and write `capacitor.config.ts`.** Run `npx cap add android`, then `npm run build:android`. Expected: `android/app/src/main/assets/public/index.html` exists.

- [ ] **Step 2: Icon.** Run `npx @capacitor/assets generate --android --iconBackgroundColor '#f0e6d3' --splashBackgroundColor '#f0e6d3'`. Expected: `android/app/src/main/res/mipmap-*/ic_launcher*.png` updated.

- [ ] **Step 3: Gradle, manifest and MainActivity changes as listed.** In `MainActivity.onCreate` after `super.onCreate`, set:
  `ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() { public WebResourceResponse shouldInterceptRequest(WebResourceRequest r) { return bridge.getLocalServer().shouldInterceptRequest(r); } });`

- [ ] **Step 4: Write `.github/workflows/android.yml`**
  - **Triggers and runner:** `on: push` (all branches) and `workflow_dispatch`; `permissions: contents: write`; `concurrency: android-${{ github.ref }}` with `cancel-in-progress: true`; runner `ubuntu-24.04`.
  - **Steps:**
    - `actions/checkout@v7`
    - `actions/setup-node@v7` (Node 22, npm cache), then `npm ci`, `npx vitest run`, `npm run build:android`
    - `actions/setup-java@v6` (temurin 21, gradle cache)
    - Decode `secrets.ANDROID_KEYSTORE_B64` to `$RUNNER_TEMP/release.p12`
    - In `android/`: `./gradlew :app:testReleaseUnitTest :app:assembleRelease -PversionCode=${{ github.run_number }} -PversionName=0.1.${{ github.run_number }}`, with the three env vars set
    - `apksigner verify --print-certs` on the APK, using the newest `$ANDROID_HOME/build-tools/*`
    - Rename the APK to `pinepods-lite-0.1.<run>.apk` and upload it with `actions/upload-artifact@v7` as `pinepods-lite-apk`
  - **Publishing** (with `GH_TOKEN: ${{ github.token }}`):
    - On `refs/heads/main`: `gh release create android-v0.1.<run> <apk> --title "PinePods Lite 0.1.<run>" --notes "<head commit message>" --latest`
    - On any other branch: `gh release create android-test-0.1.<run> <apk> --prerelease --target <sha> --title "PinePods Lite 0.1.<run> (test, <branch>)" --notes "<head commit message>"`
    - Delete all but the newest 10 `android-v*` and the newest 5 `android-test-*` releases: `gh release delete <tag> --cleanup-tag --yes`.

- [ ] **Step 5: Signing key — ask the user first.** Tell the user the key will be generated in `~/pinepods-lite-signing/`, outside the repo, and that four repo secrets will be set. Wait for their OK.
  - **Generate the key:** `openssl rand -base64 24` for the password, then `openssl req -x509 -newkey rsa:4096 -nodes -days 10000 -subj "/CN=PinePods Lite"`, then `openssl pkcs12 -export -name pinepods` → `release.p12`. Save the password in `password.txt` next to it.
  - **Set the secrets:** `gh secret set ANDROID_KEYSTORE_B64 < <(base64 -i release.p12)`, `gh secret set ANDROID_KEYSTORE_PASSWORD`, `gh secret set ANDROID_KEY_ALIAS --body pinepods`.
  - **Remind the user** to back up the folder.

- [ ] **Step 6: Run `npx vitest run` and the smoke test** (all `PASS`, exit 0)

- [ ] **Step 7: Commit** — `git commit -m "Add Capacitor Android shell and APK build workflow"`

- [ ] **Step 8: Push the branch and watch the run** (Global Constraints command). Expected: the run succeeds, the `apksigner` output shows `CN=PinePods Lite`, and `gh release view android-test-0.1.<run>` shows a pre-release with one `.apk` asset (no `android-v*` release is created from a branch).

---

### Task 6: Native pure logic (sleep timer, report journal, resume state)

**Files:**
- Create: `android/app/src/main/java/app/bretzel/pinepodslite/player/SleepTimer.kt`
- Create: `android/app/src/main/java/app/bretzel/pinepodslite/player/ReportJournal.kt`
- Create: `android/app/src/main/java/app/bretzel/pinepodslite/player/ResumeState.kt`
- Test: `android/app/src/test/java/app/bretzel/pinepodslite/player/{SleepTimerTest,ReportJournalTest,ResumeStateTest}.kt`

**Interfaces:**
- Produces:

```kotlin
class SleepTimer(private val now: () -> Long) {
  var minutes: Int?; var repeat: Boolean
  fun arm(minutes: Int?)                 // null cancels
  fun onUserPlay()                       // check-in: re-arms to full duration when repeat && minutes != null
  fun remainingSeconds(): Int?           // ceil; null when not counting
  fun tick(isPlaying: Boolean): Boolean  // true exactly once when it expires while playing (caller fades + pauses); on expiry clears the deadline, and clears minutes unless repeat
}
enum class ReportKind { POSITION, ENDED }
data class Report(val seq: Long, val kind: ReportKind, val key: String, val payload: String, val seconds: Double, val at: Long)
class ReportJournal(reports: List<Report> = emptyList(), nextSeq: Long = 1) {
  fun recordPosition(key: String, payload: String, seconds: Double, at: Long): Report  // replaces an earlier POSITION for key
  fun recordEnded(key: String, payload: String, seconds: Double, at: Long): Report     // drops pending POSITION for key
  fun pending(): List<Report>                                                         // seq order
  fun ack(throughSeq: Long)
  fun toJson(): String
  companion object { fun fromJson(json: String?): ReportJournal }                     // null/garbage → empty journal
}
data class ResumeState(val key: String, val uri: String, val title: String, val artist: String, val artworkUrl: String,
                       val positionMs: Long, val durationMs: Long, val payload: String) {
  fun toJson(): String
  companion object { fun fromJson(json: String?): ResumeState? }                      // null/garbage → null
}
```

- [ ] **Step 1: Write the failing tests**
  - **`SleepTimerTest`:**
    - `arm(10)` at t=0 → `remainingSeconds()` is 600; at t=1_000 it is 599.
    - `tick(true)` at t=600_000 returns true once, then false.
    - After expiry `minutes` is null when `repeat` is false, and 10 when it is true.
    - Expiry while paused (`tick(false)`) returns false but still clears the deadline.
    - `onUserPlay()` with `repeat` re-arms to 600 s; without `repeat` it changes nothing.
    - `arm(null)` cancels.
  - **`ReportJournalTest`:**
    - Two `recordPosition` calls for the same key leave one report, carrying the second seq and the second seconds.
    - `recordEnded` removes the key's pending position.
    - `ack(2)` keeps only reports with `seq > 2`.
    - The `toJson`/`fromJson` round-trip keeps reports and continues the seq numbering (the next seq after reload is greater than every previous one).
    - `fromJson("{")` gives an empty journal.
  - **`ResumeStateTest`:** the round-trip is equal; `fromJson(null)` and `fromJson("nope")` give null.

- [ ] **Step 2: Commit the tests** (`git commit -m "Add native player logic tests"`), **push, and confirm CI fails at `:app:testReleaseUnitTest`** (unresolved references)
- [ ] **Step 3: Implement the three classes** (JSON via `org.json`)
- [ ] **Step 4: Commit** — `git commit -m "Add native sleep timer, report journal and resume state"`
- [ ] **Step 5: Push and confirm CI passes**, with the three test classes in the Gradle test report

---

### Task 7: Media3 playback service, NativePlayer plugin and NativeEngine

**Files:**
- Create: `android/app/src/main/java/app/bretzel/pinepodslite/player/PlayerStore.kt` (SharedPreferences `player`: journal JSON, resume JSON, `sleepMinutes`, `sleepRepeat`, `autoAdvance`)
- Create: `android/app/src/main/java/app/bretzel/pinepodslite/player/PlaybackService.kt`
- Create: `android/app/src/main/java/app/bretzel/pinepodslite/player/NativePlayerPlugin.kt`
- Modify: `android/app/src/main/AndroidManifest.xml` (permissions `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`; `<service android:name=".player.PlaybackService" android:foregroundServiceType="mediaPlayback" android:exported="true">` with actions `androidx.media3.session.MediaLibraryService` and `android.media.browse.MediaBrowserService`; `<receiver android:name="androidx.media3.session.MediaButtonReceiver" android:exported="true">` for `android.intent.action.MEDIA_BUTTON`)
- Modify: `MainActivity.java` (`registerPlugin(NativePlayerPlugin.class)` before `super.onCreate`)
- Create: `src/native/plugins.ts`
- Create: `src/player/engine/nativeEngine.ts`
- Modify: `src/player/engine/index.ts`
- Test: `src/player/engine/nativeEngine.test.ts`

**Interfaces:**
- Consumes: Task 2 `PlayerEngine`/`PlaybackItem`/`PlaybackReport`; Task 6 classes.
- Produces (`src/native/plugins.ts`, registered as `registerPlugin<NativePlayerPlugin>('NativePlayer')`):

```ts
export interface NativeItem { key: string; uri: string; title: string; artist: string; artworkUrl: string; startAt: number; duration: number; payload: string /* JSON {accountId, episode} */ }
export interface NativeState { currentKey: string | null; currentPayload: string | null; playing: boolean; position: number; duration: number; rate: number; sleepRemaining: number | null; sleepMinutes: number | null }
export interface NativeReport { seq: number; kind: 'position' | 'ended'; key: string; payload: string; seconds: number; at: number }
export interface NativePlayerPlugin {
  load(o: { items: NativeItem[]; index: number; autoplay: boolean }): Promise<void>;
  updatePlaylist(o: { items: NativeItem[] }): Promise<void>;
  play(): Promise<void>; pause(): Promise<void>; seek(o: { seconds: number }): Promise<void>; setRate(o: { rate: number }): Promise<void>;
  setAutoAdvance(o: { on: boolean }): Promise<void>; setSleepTimer(o: { minutes: number | null }): Promise<void>; setSleepRepeat(o: { repeat: boolean }): Promise<void>;
  getState(): Promise<NativeState>;
  readReports(): Promise<{ reports: NativeReport[] }>; ackReports(o: { throughSeq: number }): Promise<void>;
  addListener(e: 'state', fn: (s: NativeState) => void): Promise<PluginListenerHandle>;
  addListener(e: 'reports', fn: () => void): Promise<PluginListenerHandle>;
}
export const isNative: () => boolean;  // Capacitor.isNativePlatform()
```
- Produces: `class NativeEngine implements PlayerEngine` (`kind = 'native'`), constructor `(plugin: NativePlayerPlugin)`. `createEngine()` returns `new NativeEngine(NativePlayer)` when `isNative()`.

**Native behaviour (`PlaybackService : MediaLibraryService`):**
- **Player setup:**
  - ExoPlayer with `AudioAttributes(USAGE_MEDIA, AUDIO_CONTENT_TYPE_SPEECH)` and `handleAudioFocus = true`.
  - `setHandleAudioBecomingNoisy(true)`.
  - Seek back 15 000 ms, forward 30 000 ms.
  - `setMaxSeekToPreviousPositionMs(Long.MAX_VALUE)`, so "previous" always means the previous episode when one exists.
  - Media source factory over `DefaultDataSource.Factory(context, DefaultHttpDataSource.Factory().setAllowCrossProtocolRedirects(true).setUserAgent("PinePodsLite/" + versionName))`.
- **Notification buttons:** in `onConnect`, give the media-notification controller the media button preferences `[CommandButton(ICON_SKIP_BACK_15, COMMAND_SEEK_BACK), CommandButton(ICON_SKIP_FORWARD_30, COMMAND_SEEK_FORWARD)]`. Previous/next item commands stay available; Media3 hides them at the ends of the playlist.
- **Library:**
  - `onGetLibraryRoot` returns a browsable root (and honours `params.isRecent`).
  - `onGetChildren` of the root returns the `ResumeState` item, if any.
  - `onPlaybackResumption` returns `ResumeState` as a single item at `positionMs`, with metadata from stored fields (no network when `isForPlayback == false`).
- **Items:** `MediaItem` with `mediaId = key`, URI, `MediaMetadata` (title, artist, artwork URI), and `payload`/`durationMs` in metadata extras. Load at the item's `startAt`. `updatePlaylist` keeps the current item and replaces the items before and after it, without interrupting playback; a list without the current key is ignored.
- **Auto-advance off:** `setPauseAtEndOfMediaItems(true)`.
- **Checkpoints:** every 10 s while playing, on pause, and on every item transition (for the outgoing item, using its last tracked position), call `journal.recordPosition`. Also persist `ResumeState` for the current item.
- **"Played to the end" → `journal.recordEnded(key, payload, durationSeconds)`, detected as:**
  - `onMediaItemTransition` with reason `AUTO` (the previous item ended), or
  - `onPlayWhenReadyChanged` with reason `END_OF_MEDIA_ITEM`, or
  - `onPlaybackStateChanged(STATE_ENDED)`.
- **Sleep timer:**
  - A 1 s main-thread tick while armed.
  - When `tick` returns true: fade the volume over 25 steps × 200 ms, then pause and restore the volume.
  - `onIsPlayingChanged(true)` calls `sleepTimer.onUserPlay()`. Auto-advance never flips `isPlaying`, so it doesn't re-arm.
- **Persistence and events:**
  - Every journal or resume change is persisted through `PlayerStore` (`apply()`).
  - The plugin listener receives `state` on every player change and every 1 s while playing, and `reports` after each journal append.
- **Service lifetime:** `onTaskRemoved` keeps the Media3 default (keep running while playing, stop otherwise). Resumption brings it back.

**Plugin (`NativePlayerPlugin`):**
- Holds a `MediaController` built from the `SessionToken` of `PlaybackService`; connecting starts and binds the service.
- Each method waits for the connection, then calls the service's Kotlin API on the main thread through `PlaybackService.instance` (a companion reference set in `onCreate`, cleared in `onDestroy`).
- `getState`/`readReports` return what is in `PlayerStore` when the service is not running.

**NativeEngine:**
- `load`/`updatePlaylist` map `PlaybackItem` → `NativeItem`:
  - `uri` is `file://` + `filePath` for `download`, else the stream URL.
  - `payload` is `JSON.stringify({ accountId, episode })`.
  - `artist` is `podcastname`, `artworkUrl` is `episodeartwork`, `duration` is `episodeduration`.
- `current()` rebuilds a `PlaybackItem` from the latest state's `currentKey` and `currentPayload`, with the source taken from the loaded items when known, else `stream` with an empty url.
- `init()` calls `getState()` and subscribes to both events.
- `readReports` parses each payload into `accountId` + `episode`. The plugin serializes `ReportKind` as lowercase `'position'`/`'ended'`.

- [ ] **Step 1: Write the failing test** `nativeEngine.test.ts` with a fake plugin recording calls:
  - `load` maps a download item to `uri: 'file:///x/a1_7'` and a stream item to its URL.
  - The payload round-trips: after a fake `state` event with that payload, `current()` returns `{ key, accountId, episode }`.
  - `readReports` returns `PlaybackReport`s with `accountId` and `episode` parsed.
  - A `reports` plugin event emits `{ type: 'reports' }` to subscribers.
- [ ] **Step 2: Run `npx vitest run src/player/engine` and confirm it fails**
- [ ] **Step 3: Implement `plugins.ts`, `NativeEngine` and the `createEngine` branch.** Run `npx vitest run`: all pass. Run the smoke test: all `PASS` (the browser still gets `WebEngine`).
- [ ] **Step 4: Implement `PlayerStore`, `PlaybackService` and `NativePlayerPlugin`, plus the manifest and `MainActivity` changes**
- [ ] **Step 5: Commit** — `git commit -m "Add Media3 playback service, NativePlayer plugin and NativeEngine"`
- [ ] **Step 6: Push and confirm CI passes** (Kotlin compiles, unit tests pass, signed APK uploaded)

---

### Task 8: Native downloads

**Files:**
- Create: `android/app/src/main/java/app/bretzel/pinepodslite/downloads/NativeDownloadsPlugin.kt`
- Modify: `MainActivity.java` (`registerPlugin(NativeDownloadsPlugin.class)`)
- Modify: `src/native/plugins.ts` (add `NativeDownloads`)
- Modify: `src/lib/downloadBackend.ts` (add `nativeDownloadBackend`; `getDownloadBackend()` returns it when `isNative()`)
- Test: `src/lib/downloadBackend.test.ts`

**Interfaces:**
- Consumes: Task 4 `DownloadBackend`, `putDownloadEntry`, `deleteDownload`.
- Produces (`registerPlugin<NativeDownloadsPlugin>('NativeDownloads')`):

```ts
export interface NativeDownloadsPlugin {
  start(o: { key: string; url: string; title: string; entry: string /* JSON PendingDownload */ }): Promise<void>;
  status(o: { key: string }): Promise<{ state: 'running' | 'done' | 'failed' | 'unknown'; fraction?: number; filePath?: string; mimeType?: string; size?: number }>;
  finished(): Promise<{ downloads: { key: string; entry: string; filePath: string; mimeType: string; size: number }[] }>;
  forget(o: { key: string }): Promise<void>;
  remove(o: { key: string }): Promise<void>;
  removeByPrefix(o: { prefix: string }): Promise<void>;
}
```

**Native behaviour:**
- **Downloading:** Android `DownloadManager`, destination `getExternalFilesDir("episodes")/<key with ':' replaced by '_'>`, notification visible while running, metered networks allowed.
- **Tracking:** SharedPreferences `downloads` maps key → `{ downloadId, entry }`.
- **`status`:** reads `COLUMN_STATUS`, `COLUMN_BYTES_DOWNLOADED_SO_FAR`/`COLUMN_TOTAL_SIZE_BYTES` and `COLUMN_MEDIA_TYPE`. On failure it deletes the partial file.
- **`finished`:** lists the tracked keys whose status is successful.
- **`forget`:** drops the mapping only.
- **`remove`/`removeByPrefix`:** delete the files and drop the mappings.

**`nativeDownloadBackend`:**
- **`fetchAndStore`:** `start`, then poll `status` every 500 ms, reporting `fraction`.
  - On `done`: `putDownloadEntry({ ...pending, filePath, mimeType, size, downloadedAt: Date.now() })`, then `forget`, then return the entry.
  - On `failed`: `forget`, then throw `Error('Download failed')`, so `downloadEpisode` falls through to the server-side strategy as today.
- **`remove`:** `deleteDownload`, plus `remove({ key })`.
- **`removeAccount`:** `removeByPrefix({ prefix: accountId + '_' })`.
- **`recoverFinished`:** for each `finished()` entry, `putDownloadEntry`, then `forget`; returns the count.

- [ ] **Step 1: Write the failing tests** against a fake plugin, with `putDownloadEntry`/`deleteDownload` mocked:
  - `fetchAndStore` resolves after `running(0.5)` then `done`, stores `{ filePath, mimeType, size }`, calls `forget`, and reports progress `0.5`.
  - `failed` rejects with `Download failed` and calls `forget`.
  - `recoverFinished` stores two finished downloads and returns 2.
  - `removeAccount('a1')` calls `removeByPrefix({ prefix: 'a1_' })`.
- [ ] **Step 2: Run `npx vitest run src/lib` and confirm the new tests fail**
- [ ] **Step 3: Implement the TS backend.** Run `npx vitest run` (all pass) and the smoke test (all `PASS`).
- [ ] **Step 4: Implement `NativeDownloadsPlugin` and register it**
- [ ] **Step 5: Commit** — `git commit -m "Add native downloads on Android"`
- [ ] **Step 6: Push and confirm CI passes**

---

### Task 9: README and on-device acceptance

**Files:**
- Modify: `README.md` (new "Android app" section: on the phone, open the repo's Releases page, download the latest `android-v*` APK and allow the browser to install unknown apps; Obtainium setup pointing at `github.com/bretzel-app/pinepods-lite` with pre-releases left off; branch builds appear as `android-test-*` pre-releases; the signing key in `~/pinepods-lite-signing/` must be backed up, and losing it means uninstall/reinstall)

- [ ] **Step 1: Write the README section and commit** — `git commit -m "Document the Android app"`

- [ ] **Step 2: Install on the phone.** Give the user the URL of the newest `android-test-0.1.<run>` pre-release (`gh release view android-test-0.1.<run> --json url --jq .url`). They open it on the Pixel 4a, download the APK and install it (first time: allow the browser to install unknown apps). Expected: PinePods Lite opens and the login screen shows.

- [ ] **Step 3: Run the acceptance scenarios with the user.** These are scenarios 1–9 from the spec plus the Review Focus checks:
  - **R1:** after scenario 3, open the app. It shows the resumed episode, and playback is not interrupted.
  - **R2:** remove an account that has pending reports. No error, and the other accounts still sync.
  - **R3:** start an episode on account A, switch to account B, listen. The position shows on A in the web version.
  - **R4:** start an episode from a 450+ episode podcast. Previous/next work across 30+ episodes of auto-advance.
  - **R5:** play and download an episode whose enclosure URL redirects http→https (e.g. a `podtrac`/`chtbl` prefixed feed).
  - **Artwork:** previously seen artwork shows in airplane mode.
  - **Deep links:** reloading on a podcast page keeps the page.

  For scenario 3 there is no adb: let the system reclaim the app by leaving it paused for several hours while using other apps. The user reports what they saw. Fix any failure in the owning task's files and push. The user installs the new pre-release over the old one, and the failed scenario is re-run.

- [ ] **Step 4: Merge.** Ask the user for the go-ahead, then merge `android-native-player` into `main` and push. Watch the run. Expected: release `android-v0.1.<n>` exists with one `.apk` asset (`gh release view android-v0.1.<n>`).
