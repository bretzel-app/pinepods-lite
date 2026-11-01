# PinePods Lite for Android, with a native player

Date: 2026-11-01
Status: draft, awaiting approval

## Why

PinePods Lite runs today as a web app installed from Chrome on an Android phone.
The recurring failure: **after pausing from the headphones, pressing play on the
headphones again often does nothing.**

The web code is not at fault: `src/player/PlayerContext.tsx` already registers
play/pause/seek/previous/next with the Media Session API and keeps
`playbackState` and position up to date. The limit is the platform. Chrome only
holds a page's media session while it is playing. Once paused and backgrounded,
the notification lapses, the page is frozen or discarded, and headphone buttons
stop reaching the app. No web code can prevent that.

A native Android media service can: it keeps its media session while paused, and
Android keeps routing media buttons to the last active player — even after the
process was killed, via Media3 playback resumption.

### Route not taken: Google Play "personal library"

Google launched a private Play Store library for personal apps on 2026-10-13. It
does not fit today: it is a US-only beta, it only accepts apps built in Google AI
Studio, and AI Studio only produces native Kotlin/Compose projects (it cannot
import this codebase). Using it would mean rewriting the app inside AI Studio.
Revisit if it opens to the user's country and to apps built elsewhere.
Sources: [Play Console Help](https://support.google.com/googleplay/android-developer/answer/18765789?hl=en),
[AI Studio Android docs](https://ai.google.dev/gemini-api/docs/aistudio-android).

## Goals

1. Headphone play resumes a paused episode reliably — after minutes or hours,
   with the screen off, after the app was swiped away, and after Android killed
   the process.
2. While paused, the media controls stay in the notification shade, on the lock
   screen, and (Android 13+) in the quick-settings media player, as long as
   Android allows. Android 13+ itself turns a paused player into a "resume" card
   after about 10 minutes; tapping it (or a headphone press) resumes the last
   episode. That is the standard behaviour of every Android media app and is
   accepted — no custom always-on notification.
3. Everything that must keep working with the screen off keeps working: sleep
   timer with fade-out, auto-advance to the next episode, position saving.
4. Downloaded episodes play offline, as today.
5. Each push to `main` produces a signed APK, downloadable from a GitHub Release
   and installable over the previous version without losing data.

## Non-goals

- Google Play distribution of any kind (personal library, internal testing,
  public listing).
- iOS.
- Android Auto, Wear OS, home-screen widgets.
- Moving data from the Chrome-installed web app into the Android app. The
  Android app starts fresh: log in again, re-download episodes.
- UI updates without a new APK. The UI is bundled in the APK.

## Anti-goals (failure even if it "works")

- Any regression in the browser/Docker version. It must keep working exactly as
  it does now, from the same codebase.
- Losing listening positions. (Positions may reach the PinePods server late —
  see "Decided by the user" — but must never be dropped.)
- An update that cannot install over the previous version (forces uninstall and
  wipes logins and downloads).
- Credentials or signing material committed to the repo — the repo is public.

## Decided by the user

- Distribution is a **sideloaded APK**.
- Approach is a **native shell around the existing web UI, with playback moved
  to a native player** (not a rewrite, not a plain web-app wrapper).
- The APK is **built by a GitHub Actions workflow** and downloaded from GitHub,
  not built on the Mac.
- **Server sync may be late.** The user listens on the phone and does not pick
  up episodes on another device right after. Positions recorded while the web
  code is not running (e.g. playback restarted by a headphone press after the
  process died) reach the server the next time the app's UI runs. The native
  side does not talk to the PinePods server.
- **Target device: Google Pixel 4a, Android 13** (stock Android, API 33).

## Design

### Shape

- **Shell:** [Capacitor](https://capacitorjs.com/) wraps the existing Vite/React
  build. The built web assets are bundled in the APK, so the app opens with no
  network. The `android/` project is committed to the repo.
- **Native player:** a small Capacitor plugin written in Kotlin, living in the
  `android/` project, built on **AndroidX Media3** (ExoPlayer + `MediaSessionService`).
- **One player interface in the web code:** `PlayerContext` stops talking to
  `HTMLAudioElement` directly and talks to a player engine. In the browser the
  engine is the current `<audio>` behaviour; in the Android app it is the native
  plugin. Detection via `Capacitor.isNativePlatform()`. Components consuming
  `usePlayer()` do not change.

### What runs natively vs in the web code

The rule: anything that must keep happening while the UI is asleep runs
natively. Decisions about *what* to play and syncing with the server stay in
the web code.

**Native (Media3 service):**
- Audio playback, audio focus (pause for calls/other apps), pause when
  headphones disconnect.
- Media session, notification, lock-screen and quick-settings controls,
  headphone/Bluetooth buttons. Button mapping matches today's web app:
  play, pause, seek back 15 s, seek forward 30 s, seek-to, previous/next
  episode (hidden at the ends of the list).
- Playback speed.
- The playlist handed over by the web code, and auto-advance through it. When
  auto-advance is off, playback stops at the end of the current episode
  (previous/next buttons still work).
- Sleep timer: countdown, ~5 s fade-out, pause; one-shot and check-in modes
  with today's semantics (check-in re-arms on a user play, not on auto-advance).
- Persisting the current episode, its playable source, and position on the
  device, so playback resumption works after process death.
- A journal of events the web code has not yet acknowledged: position updates,
  episode transitions, episodes played to the end.

**Web code (unchanged responsibilities):**
- Choosing the source (local download → server copy → enclosure URL) and the
  resume point, exactly as `loadEpisode` does today.
- Building the playlist: the list the episode was started from, or else the
  podcast's episodes in chronological order (today's previous/next logic). It
  hands the native player the playlist with resolved sources.
- Server sync (`recordListenDuration` via `runOrQueue`), marking episodes
  completed (`markCompleted`, which also deletes the local download), the
  offline mutation queue.
- On every wake (app start, return to foreground) and on live events while
  running, it drains the native event journal and applies it through the
  existing sync paths. Nothing listened while the UI slept is lost; at worst it
  reaches the server late.

### Downloads on Android

Today downloads are blobs in IndexedDB (`downloadBlobs` store). A native player
cannot read those, and pushing large audio blobs across the Capacitor bridge is
not viable. On Android:

- Downloading is done natively, writing files to app-private storage. Native
  HTTP has no CORS limits, so strategy 1 (fetch the enclosure URL directly)
  works for every feed; strategy 2 (server-side download, then
  `/api/data/stream`) stays as the fallback, orchestrated by the web code as
  today.
- A download continues if the app goes to the background.
- The `downloads` metadata store in IndexedDB stays the index of what is
  downloaded; on Android an entry points at a file instead of a blob.
  Listing, deleting, the completed-episode sweep and account removal all work
  as today.
- Progress still reaches the UI through `subscribeDownloads`.

The browser keeps the IndexedDB blob path unchanged.

### What the user will see (acceptance scenarios)

Run on the user's phone with Bluetooth or wired headphones:

1. Play an episode, pause with the headphones, lock the phone, wait 30+ min,
   press play on the headphones → resumes at the same spot.
2. Same, but swipe the app away from recents before waiting → resumes.
3. Same, but let the system reclaim the process (paused for several hours while
   using other apps) → resumes the last episode at its saved position.
4. While paused, the notification and lock-screen controls stay; once Android
   turns them into a "resume" card (after ~10 min on 13+), tapping play on the
   card resumes the episode at its position.
5. Sleep timer set, screen off → fades and pauses on time.
6. Auto-advance on, screen off → next episode in the list starts.
7. Pause, swipe the app away, resume with the headphones, listen 20 min with
   the screen off, then open the app → within a few seconds the position is on
   the server (check in the web version). No minutes are lost.
8. Download an episode, enable airplane mode, play it → plays.
9. Browser/Docker version: `npm run smoke` passes and behaviour is unchanged.

### Shell details

- App id `app.bretzel.pinepodslite`, name "PinePods Lite", icon from the
  existing `public/icon-maskable.png` as an adaptive icon.
- Cleartext HTTP allowed (many podcast enclosure URLs are `http://`, and a
  PinePods server may be on a LAN over HTTP); mixed content allowed in the
  WebView for the same reason.
- API calls keep using `fetch` from the WebView: the PinePods server already
  sends permissive CORS headers, as the browser version relies on it.
- The PWA service worker is not needed for the app shell in the APK (assets are
  local). Artwork offline caching must still work in the app (see "Left to the
  builder").

### Build and release

- Workflow `.github/workflows/android.yml`, triggered on push to `main` and
  manually (`workflow_dispatch`).
- Steps: install deps, build the web assets, `cap sync android`, Gradle release
  build, sign, publish.
- `versionCode` = workflow run number, `versionName` = `0.1.<run number>`, so
  every build installs as an update.
- Output: a **GitHub Release** with the signed `.apk` attached (direct download
  link on the phone, and the source for
  [Obtainium](https://github.com/ImranR98/Obtainium) auto-updates), plus the APK
  as a workflow artifact.
- **Signing:** one release keystore, generated once, stored as repo secrets
  (keystore base64, store password, key alias, key password). Never committed.
  The user keeps an offline backup: losing it means the next build cannot update
  the installed app.
- Pushes to other branches (and manual runs on them) publish the APK as a GitHub
  **pre-release** (`android-test-…`). The user installs test builds by
  downloading them from the repo on the phone; Obtainium ignores pre-releases by
  default, so work-in-progress never reaches the phone unless fetched by hand.
  No USB/adb installs.
- No local Android toolchain is required, and the builder does not install one
  on the Mac unless the user agrees. CI is the build loop.

## Constraints

- The repo is public: the APK and releases are publicly downloadable. That is
  acceptable because the APK contains no credentials (accounts are entered at
  runtime). Secrets live only in GitHub Actions secrets.
- Google's developer verification for sideloaded apps is enforced in Brazil,
  Indonesia, Singapore and Thailand since 2026-09-30, and globally from 2027. When
  it reaches the user's country, the signing key may need registering under the
  free limited-distribution account (up to 20 devices). No rebuild needed.
- The target phone is a Pixel 4a on Android 13 (API 33), so `minSdkVersion`
  must be ≤ 33. Stock Android: no maker-specific background killing, so no
  battery-optimisation exemption prompt or setup steps are needed. The quick
  settings media player and resume card exist on 13.
- Android 13's runtime notification permission does not apply to media-session
  notifications, so no permission prompt is needed for the player controls.
- Android 15 edge-to-edge enforcement does not apply on the target phone; no
  safe-area changes to the shared web UI are in scope.

## Left to the builder

- Exact Capacitor and Media3 versions (current stable, pinned exactly).
- The plugin's API surface and event format, and how the playlist is windowed
  for very long podcasts.
- How native downloads are implemented (WorkManager, a service, etc.), as long as
  they survive backgrounding and report progress.
- Where the native side persists its state and journal.
- How artwork offline caching works in the app (service worker in the WebView if
  it works under Capacitor, otherwise another approach).
- Client-side routing under Capacitor (`BrowserRouter` deep paths on reload).
- Release housekeeping (release tag naming, pruning old releases).
- Test approach for the engine abstraction; the acceptance scenarios above are
  run by hand on the phone.

## Calls made without the user (check these)

- The browser/Docker version stays supported from the same codebase.
- Builds publish on every push to `main`, not only on version tags.
- The notification button layout and the headphone previous/next mapping copy
  today's web app.
- Playback speed is not persisted across restarts (same as today).
- App id `app.bretzel.pinepodslite`.
- Cleartext HTTP and mixed content allowed.
- Native downloads (rather than routing bytes through the WebView).
- Android's ~10-minute "resume card" behaviour for paused players is accepted
  (Goal 2); no custom always-on notification.
- CI is the only build loop; non-`main` branches publish pre-releases (installed
  from GitHub on the phone), `main` publishes full releases; nothing gets
  installed on the Mac without asking.
