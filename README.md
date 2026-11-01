# PinePods Lite

An **offline-first web client** for [PinePods](https://pinepods.online/), built to add the
things the official apps are missing:

> **Unofficial third-party client.** This project is not affiliated with, endorsed by, or
> associated with the [PinePods](https://github.com/madeofpendletonwool/PinePods) project.
> It's an independent client that talks to a PinePods server's HTTP API; it shares no code
> with the upstream project and follows its own license (MIT).

- **Multiple accounts & instant switching** — connect any number of PinePods servers/users;
  each account keeps its own cache, playback positions and downloads. Switching is instant
  and works offline.
- **Offline-first navigation** — every screen renders from IndexedDB immediately and
  revalidates in the background. No spinner walls on screen changes, and the whole app
  (shell + data + downloaded audio) works with no connection at all.
- **The basics, done simply** — find a podcast, subscribe, play/resume (position synced with
  the server), download episodes for offline listening, favorite episodes. No queue, no
  fancy extras.
- **Pick-up-and-play** — on launch the player cues your last-played episode, paused at its
  resume point: one tap on Play continues. Episode rows open a detail page with full show
  notes; tapping the player bar expands a full-screen player.

## Running it

```bash
npm install
npm run dev        # dev server
npm run build      # production build (dist/), includes the PWA service worker
npm run preview    # serve the production build locally
```

Deploy `dist/` to any static host (the service worker requires HTTPS or localhost). Sign in
with your PinePods server URL + username/password — the app exchanges them for an API key
(`GET /api/data/get_key`) and never stores the password. PinePods instances serve the API
behind nginx with `Access-Control-Allow-Origin: *`, so the client can be hosted anywhere.

## Deploying

The repo ships a multi-stage `Dockerfile` (Node build → nginx serving `dist/` with SPA
fallback and correct service-worker cache headers, listening on port 80). No environment
variables are needed — the PinePods server URL is entered at login.

**Dokploy** (or any Dockerfile-based PaaS): create an Application from this repo/branch,
build type *Dockerfile*, container port *80*, and attach a domain **with HTTPS enabled** —
a secure context is required for the service worker, i.e. for everything offline.

**Plain Docker:**

```bash
docker compose up -d --build   # serves on host port 8090 (see docker-compose.yml)
```

**No Docker:** `npm ci && npm run build`, then serve `dist/` with the config in
`deploy/nginx.conf` (SPA fallback + `no-cache` on `index.html`/`sw.js` so updates roll out).

### Smoke test

```bash
npm run build
npm run preview &   # serves on :4173
node scripts/smoke.mjs
```

Drives the built app in headless Chromium against a fully mocked PinePods API: login, feed,
podcast detail, search, saved list, favoriting — then reloads with the network disabled and
asserts the app still renders from cache.

## How it works

| Layer | File(s) | Notes |
| --- | --- | --- |
| API client | `src/lib/api.ts` | Typed wrapper over the PinePods HTTP API (`Api-Key` header auth). Normalizes the API's inconsistent episode key casing. |
| Storage | `src/lib/db.ts` | IndexedDB (via `idb`): accounts, per-account response cache, playback positions, downloaded audio blobs, pending offline ops. |
| Offline-first reads | `src/lib/useCached.ts` | Cache-then-network hook: renders cached data instantly, refreshes in the background. |
| Offline writes | `src/lib/sync.ts` | Favorites/positions that fail while offline are queued and replayed on reconnect/focus. |
| Multi-account | `src/lib/accounts.tsx` | All storage is namespaced by account id; the active account is a context switch, not a re-login. |
| Player | `src/player/PlayerContext.tsx` | Resume = max(local position, server `listenduration`); position saved locally every 3s and synced to the server (`record_listen_duration`) every 15s, on pause, and on tab hide. |
| Downloads | `src/lib/downloads.ts` | Fetches the enclosure URL directly when the CDN allows CORS; otherwise asks the server to download the file and pulls the bytes from its `stream` endpoint. Audio is stored in IndexedDB and played from a blob URL. |
| App shell | `vite.config.ts` (vite-plugin-pwa) | Workbox precaches the shell; artwork is cached cache-first at runtime. |

## Playback source priority

1. Local downloaded blob (fully offline)
2. Server-side downloaded copy via `/api/data/stream/{id}` (survives dead CDN links)
3. The episode's enclosure URL

## Android app

PinePods Lite also ships as a sideloaded Android app.

**Why it exists.** In the browser or PWA on Android, Chrome drops the media session after you
pause in the background, so headphone play stops working. The app plays through a native
Media3 service instead: headphone and lock-screen controls keep working while paused, and a
headphone press resumes the last episode even after Android has killed the app. On Android 13
and later, the system turns a paused player into a "resume" card after about 10 minutes.

### Building

A GitHub Actions workflow (`.github/workflows/android.yml`) builds a signed APK on every push:

- Pushes to `main` publish a release tagged `android-v0.1.<run>`, marked latest.
- Pushes to other branches publish a pre-release tagged `android-test-0.1.<run>`.
- Every run also uploads the APK as a workflow artifact named `pinepods-lite-apk`.
- The newest 10 releases and the newest 5 test pre-releases are kept.

Local builds are optional. The JS side is `npm run build:android` (runs `npm run build`, then
`cap sync android`). Compiling the APK locally needs JDK 21 and the Android SDK; CI is the
normal path.

The launcher icon and splash are generated from the web icons in `public/`. After changing
those, run `python3 scripts/android-icons.py` (needs Pillow) and commit the result.

### Installing

1. On the phone, open the repo's [Releases page](https://github.com/bretzel-app/pinepods-lite/releases).
2. Download the latest `android-v*` APK and open it.
3. The first time, allow the browser to install unknown apps.
4. Later APKs install over the existing app and keep its data.

The app's storage is separate from Chrome's, so on a fresh install log in again and
re-download your episodes.

### Updates

[Obtainium](https://github.com/ImranR98/Obtainium) can track the
`github.com/bretzel-app/pinepods-lite` releases. Leave "include prereleases" off so only
`main` builds arrive. Test builds can be installed by hand from the pre-release.

### Signing

All builds are signed with one release key. It lives outside the repo, in
`~/pinepods-lite-signing/` (`release.p12` + `password.txt`) on the maintainer's machine, and
in three repo secrets: `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`. **Back it up and never commit it.** If it is lost, new builds can't
update the installed app: you would have to uninstall it and lose logins and downloads.

### Downloads and Google Play

On Android, downloads are saved as files in app-specific storage via Android's download
manager, so they continue in the background, with a system download notification while they
run.

The app is not on Google Play. Google's "personal library" for private apps (Oct 2026)
currently only accepts AI Studio-built apps in the US.

## Known limitations

- Accounts with **MFA enabled** are not supported yet (the login flow surfaces a clear error).
- YouTube-channel "podcasts" are untested; audio-only regular feeds are the target.
- Search uses the server's `proxy_search` (Podcast Index), so searching needs a connection —
  everything else degrades gracefully offline.
