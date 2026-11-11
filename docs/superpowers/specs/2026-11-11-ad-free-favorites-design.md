# Ad-free favorites: Claude finds the ads, PinePods stores them, the Lite app skips them

Date: 2026-11-11
Status: approved 2026-11-11

## Why

Podcasts the user listens to on their phone (PinePods Lite, Android) are full of ads:

- **Huberman Lab** (English) gets French ads injected every couple of minutes. They are
  dynamically inserted by the show's ad server, chosen by where the request comes from, so
  the same episode fetched from elsewhere carries different ads at different times.
- **DAOC**: the host reads product plugs himself.
- **Rodolphe & Gala**: a French series the user plays for their daughter, on the same phone
  and account.

PinePods 0.9 (upstream, released 2026-11-04) already has an ad-skip pipeline: its optional
`pinepods-ai` service transcribes episodes with whisper, an LLM marks the ad ranges,
PinePods stores them per episode, and players can ask for them. The user runs that
service and transcription works. The LLM step does not: the local model fails on the VPS
CPU. An Anthropic API key is **not an option**. The LLM step has to run through the
user's claudeclaw instance (Claude Code on their subscription, deployed on the same
Dokploy server as PinePods).

So: claudeclaw does the one step PinePods can't, writes the result where PinePods keeps its
own, and PinePods Lite skips the ranges during playback.

## How it works

1. The user favorites (stars) an episode in PinePods Lite. (Favorite = PinePods "saved
   episode".) The app immediately asks the server to download it.
2. A claudeclaw job, every 10 minutes, walks the user's saved episodes and moves each one
   forward a step: server download (only if the app's request didn't happen) → transcript,
   started once the download has finished → ad ranges, once the transcript is complete.
   Transcription waits for the download because PinePods ties a transcript to the copy it
   was made from. Transcribing the publisher's copy first would be redone once the server
   copy lands. PinePods' per-show auto-transcribe isn't used: it would also transcribe
   every new episode of the show from the publisher's copy.
3. For the ad ranges it runs a fresh `claude -p` on the transcript, gets back JSON, checks
   it, and writes the ranges into PinePods' database exactly as PinePods' own detector
   would.
4. PinePods Lite streams the server's copy of the episode (it already does whenever the
   server has downloaded it), fetches the ranges, and jumps over each one. Phone downloads
   of such episodes are taken from the server's copy so the jumps still line up offline.

Ads are skipped, never cut out of the file, so timestamps and resume positions stay
the same.

## Goals

1. A favorited episode plays without its ads within about 30 minutes, with no further
   action from the user.
2. Works for injected ads in any language and for host-read sponsor segments.
3. Skipping works with the screen off and the app backgrounded (native Android player),
   and offline for episodes downloaded to the phone.

The "about 30 minutes" in goal 1 is the designer's guess, not stated by the user.

## Non-goals

- Processing episodes that aren't favorited. Per-show automation is a later option.
- Re-encoding or cutting audio files.
- An Anthropic API key, a local LLM, or any LLM other than Claude via claudeclaw.
- Changing PinePods upstream (a "write ad ranges" endpoint would be welcome later, see
  Risks).
- Accounts other than the user's own. One account, one phone.
- The PinePods web UI or other PinePods clients. They may benefit, but nothing is built
  for them.

## Anti-goals (failure even if it "works")

- **Cutting real content.** Skipping part of the show is worse than letting an ad
  through. When Claude isn't sure, the range stays in.
- **Skipping on the wrong copy.** Ad times only fit the copy they were found on. Jumping
  on a different copy skips random content. The app skips only when it knows the copy
  matches.
- **The transcript drives anything but the ad list.** Transcripts are untrusted content
  (anyone can buy an ad). The Claude run that reads them has no tools and no connectors.
  It only returns JSON, and the script validates that JSON.
- **Silent rot.** A schema change in a PinePods upgrade that makes the job write garbage
  or nothing, without anyone noticing.

## Decided by the user

- Trigger: favoriting (starring) an episode. Starring alone sets off server download,
  transcription and ad detection.
- Results go into PinePods' existing ad-skip storage. PinePods Lite plays the server's
  copy and skips the marked ranges.
- No API key. The LLM step runs through the claudeclaw instance.
- What counts as an ad: injected ads in any language, and host-read sponsor plugs.
- Only episodes starred from now on. Nothing is starred today.
- Server download auto-delete is off today and may be turned on at 30 days.
- A Telegram message for every successfully processed episode, to begin with, so it's
  visible that it works.
- A status for transcription and ad detection, visible in the app.

## Facts this design rests on (verified in source)

PinePods upstream at 0.9.2 (`madeofpendletonwool/PinePods`, `rust-api/`):

- Saved episodes: `GET /api/data/saved_episode_list/{user_id}` (header `Api-Key`).
- Server download: `POST /api/data/download_podcast` `{episode_id, user_id, is_youtube:false}`;
  episode lists carry a `downloaded` flag.
- Transcription: `POST /api/data/transcribe_episode` `{episode_id, user_id, force}`.
  It prefers a server download, records which copy it used (fingerprint + duration), and
  redoes the transcript when a later server download turns out to be a different copy.
- Transcript: `GET /api/data/episode_transcript?episode_id&user_id` →
  `{transcript: {status, language, segments}}`, where `status` is `complete` when done and
  `segments` is a JSON *string* of `[{start, end, text}]`.
- Ad ranges, per user: `GET /api/data/episode_skip_segments?episode_id&user_id` →
  `{segments: [{segment_id, kind, start_time, end_time, source, status}], ad_audio}`.
  `status` for ads: `active`/`confirmed` = skip, `pending`/`rejected` = don't.
  `ad_audio.download` is `match` only when the user's server download is the copy the
  transcript was made from (`mismatch`, `unknown`, `none` otherwise). `ad_audio` is
  only present when ad rows exist.
- Server copy stream: `GET /api/data/stream/{episode_id}?api_key&user_id`.
- Storage (`services/ad_detection.rs` `store_ad_segments`): delete the episode's rows in
  `EpisodeSkipSegments` with `Source='auto-ad'`, insert one row per range
  `(EpisodeID, Kind='ad', StartTime, EndTime, Source='auto-ad')`, then
  `UPDATE Episodes SET AdsDetected = TRUE`. Postgres uses quoted CamelCase table names and
  lowercase columns (`"EpisodeSkipSegments".episodeid`), MySQL uses CamelCase for both.
- PinePods drops ranges longer than 50% of the episode as misreads (`MAX_AD_SHARE`).
- Skip auto-activate is per podcast and defaults to on. New ranges are `active` without
  user review.
- When PinePods re-transcribes an episode on a different copy, it deletes the
  `auto-ad` rows, sets `AdsDetected = FALSE`, and re-runs **its own** detector
  (`maybe_detect_ads_after_transcript(redetect=true)`).
- There is **no API to write ad ranges**. Only PinePods' own detector writes them. Hence
  the direct database write.
- No endpoint exposes `AdsDetected`. `episode_skip_segments` returns rows of every kind.
  PinePods' web player acts only on `silence` and `ad` and ignores other kinds
  (`web/src/components/audio.rs`).
- Server downloads can be auto-deleted after N days or once finished, per podcast or per
  user (`database/downloads.rs`: `auto_delete_old_downloads`,
  `auto_delete_finished_downloads`). The N days count from the download date, and saved
  episodes are not exempt. Deleting removes the file and the `DownloadedEpisodes` row
  only: transcript, ad ranges and the analyzed-copy record stay. A later server download
  of an episode that had ads makes PinePods re-transcribe it and clear the ranges
  (`transcription::after_download`).
- Transcript statuses: `pending`, `running`, `complete`, `failed`.

PinePods Lite (this repo):

- `src/player/resume.ts` `resolveSource`: local download → server stream (when
  `ep.downloaded`) → enclosure URL. Streaming the server's copy already works.
- `src/lib/downloads.ts`: phone downloads try the enclosure URL first and use the server's
  copy only as a fallback. **That has to flip for episodes with ad ranges.**
- Native playback runs in `android/.../player/PlaybackService.kt` (Media3), with a 1 s
  tick while playing. The JS layer may be suspended when the screen is off, so skipping on
  Android must happen in the service.

claudeclaw (`paulmeier/claudeclaw-container` 1.15.4, upstream `moazbuilds/claudeclaw`):

- Jobs are Markdown files in `/root/.claude/claudeclaw/jobs/` with frontmatter
  (`schedule` cron, `recurring`, `notify: true|false|error`, `model`, `timeout`) and the
  prompt as body. claudeclaw runs the prompt through Claude Code on schedule and can
  forward the result to Telegram.
- The container has `bun`, `python3`, `uv` and a logged-in `claude` CLI. Work directory
  `/root`, and only `/root/.claude` is persistent.
- `notify: error` only fires when the job's Claude process exits non-zero
  (`src/commands/start.ts`). `notify: true` sends every result, empty ones included.

## Part 1: PinePods server (settings only)

- PinePods' own ad detection stays **off** for the podcasts involved, so the failing
  local model never runs and never overwrites Claude's ranges.
- Skip auto-activate stays **on** (the default) for those podcasts.
- Server download auto-delete is off today. The user may turn it on at 30 days. The design
  copes with that (see Part 2 step 1 and the "Server copy expired" status), as long as the
  job never re-downloads an episode it has already handled. A re-downloaded copy carries
  different ads: new transcription, new Claude run, and phone downloads that stop
  skipping.
- Create a PinePods API key for the user, for the job.

## Part 2: claudeclaw job

**Shape.** A job file `adskip.md` (schedule every 10 minutes, `notify: false`) whose prompt
runs one script, `adskip.ts` (Bun), and repeats its one-line summary. The script does all
the plumbing. Claude in the job does nothing but run it, so the job's own conversation
stays small.

**Which episodes.** Every saved episode of the user, finished or not. Nothing is starred
today, so that means only episodes starred from rollout on (the user's choice). There is
no backlog to drain.

**Per run**, for each saved episode, decide the next step from PinePods' state alone (no
local state, so a re-run is always safe):

1. Not downloaded on the server:
   - no scan marker → `download_podcast` (normally the app already asked when the episode
     was starred. This catches stars made offline or from another client). Done for this
     run.
   - scan marker present → the server copy was handled and has since been auto-deleted.
     Leave it alone: no re-download.
2. No `complete` transcript → `transcribe_episode` (`force: false`), unless one is already
   `pending` or `running`. Done for this run. Because the job only asks for a transcript
   once the server download exists, the transcript is made from that download.
3. `AdsDetected` is true → nothing to do.
4. Otherwise find the ads:
   - Run `claude -p` with the transcript segments (start, end, text) and a fixed prompt,
     model `sonnet`, **no tools, no MCP servers** (`--tools ""`, `--strict-mcp-config`
     without `--mcp-config`), structured output enforced with `--output-format json` and
     `--json-schema` (a list of `{start, end, label}`). The prompt says:
     injected ads in any language and host-read sponsor segments are ads; show content,
     including the host talking about his own show, is not; when unsure, leave it out;
     ranges should snap to transcript segment boundaries.
   - Validate: well-formed JSON, `0 ≤ start < end ≤ episode length`, each range ≤ 50% of
     the episode, merge overlaps. Invalid output → no write, report error.
   - Write in one transaction: delete `auto-ad` rows for the episode, insert the ranges,
     insert one **scan marker** row (`Kind='ad-scan'`, `Source='auto-ad'`, `StartTime=0`,
     `EndTime=0`), set `AdsDetected = TRUE`. Zero ads is a valid result: marker only, flag
     set. The marker is how the app tells "no ads found" from "not scanned yet", because
     PinePods doesn't expose `AdsDetected` to clients. PinePods' web player ignores kinds
     other than `ad` and `silence`. PinePods' own clearing deletes by `Source`, so the
     marker goes away with the ranges.
   - Read back `episode_skip_segments`. If ranges exist and `ad_audio.download` isn't
     `match`, delete the rows, reset the flag, and call `transcribe_episode` with
     `force: true`. PinePods only redoes a transcript by itself when auto-transcribe is on
     or the episode already had ads. Without the forced call, Claude would run on a
     mismatched transcript every 10 minutes. This uses PinePods' own match check instead
     of reading fingerprints from its tables.
5. Summary line on stdout, for the job log: episodes processed, ads found, minutes skipped,
   per episode (e.g. `Huberman #212: 7 ads, 11 min`).

YouTube items in the saved list are skipped.

**Telegram messages come from the script itself.** claudeclaw's `notify: error` only
fires when the job's Claude process exits non-zero, and a failing command inside it
doesn't make it do that (`src/commands/start.ts`). So the job uses `notify: false`, and
the script sends its own messages through the Telegram bot API, using the
`TELEGRAM_TOKEN` already in claudeclaw's environment and a new `ADSKIP_ALERT_CHAT_ID`:
- **Errors**, always: schema check failed, invalid Claude output, write failed,
  PinePods unreachable. Repeats of the same error are sent at most once a day.
- **Each finished episode**, while `ADSKIP_NOTIFY_SUCCESS=true`: podcast, episode title,
  and either "7 ads · 11 min removed" or "no ads found". On at the start so the user can
  see it working. They turn it off later by changing the variable.

**Schema check.** Before writing, the script checks that the tables and columns it touches
exist with the expected names. If not, it writes nothing and alerts.

**Limits.** Per run: at most 2 new server downloads, at most one transcription pending or
running at a time (whisper is CPU-bound), at most 3 episodes through Claude. A big
favoriting session drains gradually instead of loading the VPS and the subscription at
once.

**Deployment (Dokploy, claudeclaw app).**
- The sources live in this repo under `claudeclaw/adskip/`. They are bundled into one file,
  `adskip.js` (`bun build`), which is pasted with `adskip.md` into Dokploy's Mounts tab as
  file mounts: `../files/adskip.js:/root/adskip/adskip.js:ro` and
  `../files/adskip.md:/root/.claude/claudeclaw/jobs/adskip.md:ro`.
- Claude Code's Bash tool stops a command after at most 10 minutes. So the job runs the
  script with that maximum timeout. The script holds a lock file so that two runs never
  overlap. It works to a 9.5-minute deadline: a Claude run starts only with at least 2
  minutes left, with a timeout of 5 minutes or the time left, whichever is shorter.
- A Claude outage (non-zero exit, timeout, error result) stops Claude calls for the rest of
  the run and sends one alert, without counting against the episode. Only invalid output,
  failed writes and copy mismatches count toward giving up, and a give-up expires after
  24 hours.
- Environment: `PINEPODS_URL` (internal address on the Dokploy network), `PINEPODS_API_KEY`,
  `PINEPODS_USER_ID`, `PINEPODS_DB_URL`, `ADSKIP_ALERT_CHAT_ID`,
  `ADSKIP_NOTIFY_SUCCESS=true`.
- The claudeclaw service joins PinePods' compose network (declared `external`) so it can
  reach the database.
- `ENABLE_CLAUDEAI_MCP_SERVERS=false` on the claudeclaw service (already advised, required
  here).

## Part 3: PinePods Lite

**Starring starts the server download.** When the user stars an episode the server
doesn't have yet, the app calls `download_podcast` right after `save_episode`. This
applies everywhere a star happens (episode row, episode page) and when a star queued
offline is replayed (`src/lib/sync.ts`). A failure is ignored, because the job catches up.
Unstarring changes nothing on the server.

**Ad ranges in the app.**
- Fetch `episode_skip_segments` for an episode when building its playback item, and cache
  it per account and episode like other responses (offline-first).
- An episode is *skippable* when it has ad ranges with status `active` or `confirmed`,
  and the audio about to play is the analyzed copy:
  - server stream: `ad_audio.download === 'match'`;
  - phone download: the download was taken from the server's copy, and the analyzed
    fingerprint stamped onto it (see Downloads) equals the current
    `ad_audio.analyzed` fingerprint.
- `PlaybackItem` carries the ranges to skip (`skips: [{start, end}]`, seconds), empty when
  not skippable.

**Skipping.**
- Web engine: on `timeupdate`, if the position is inside a range, seek to its end.
- Native engine: ranges travel in the item payload to `PlaybackService` and survive
  playlist restore after process death. In the service, when the position enters a range,
  seek to its end. Lateness of up to one tick (1 s) is acceptable.
- A range that reaches the end of the episode ends the episode (completed, auto-advance)
  instead of seeking.
- Seeking by hand into a range is respected: the user meant it. Skipping resumes at the
  next range.

**Downloads.** Whenever the server has a copy of an episode, the phone download comes from
that copy (today's fallback becomes the first choice). Starred episodes reach the server
right after starring, so their phone downloads match the analyzed copy even when taken
before the scan finishes. The download entry records that it came from the server. Once
the server reports `match`, the analyzed fingerprint is stamped onto it, once, so it keeps
skipping after the server copy expires. Native downloads (`NativeDownloadsPlugin`) follow
the same rule.

**Status on starred episodes** (requested by the user). The episode page shows where a
starred episode is. Episode rows show a compact version. States, in order:
- *Downloading to server*: starred, the server doesn't have it yet.
- *Waiting to transcribe* / *Transcribing*: no transcript yet, or `episode_transcript`
  status `pending` / `running`.
- *Transcription failed*: status `failed`.
- *Finding ads*: transcript `complete`, no scan marker yet.
- *No ads found*: scan marker, no ad ranges.
- *7 ads · 11 min skipped*: skippable on this device (see above).
- *Ads found on a different copy*: ranges exist but the audio this device would play
  isn't the analyzed copy, e.g. a phone download taken from the publisher. Deleting it and
  downloading again fixes that.
- *Server copy expired*: the episode was handled, its server copy has been auto-deleted,
  and the phone has no matching download. Streaming now plays the publisher's version
  with its ads. Unstarring and starring again redoes the episode on a fresh copy.

Unstarred episodes show nothing new. Status comes with the episode data and is cached like
the rest, so offline it shows the last known state.

## My calls (the builder may revisit, the user may overrule)

- Database write despite the coupling, guarded by the schema check (no write API exists).
- Bun script with Bun's built-in SQL client, so nothing has to be installed in the
  claudeclaw image.
- Fresh `claude -p` per episode with no tools, model `sonnet`; job every 10 minutes; at
  most 3 episodes per run.
- Telegram messages sent by the script itself. Success messages can be switched off with
  `ADSKIP_NOTIFY_SUCCESS`, error messages can't.
- The job never re-downloads an episode whose server copy expired. Unstar and star again
  to redo it.
- Per-run limits on downloads and transcription as well as on Claude.
- YouTube items are skipped.
- A failed transcription isn't retried by the job. It sends one Telegram alert, and the
  app shows *Transcription failed*.
- Forced re-transcription when the transcript's copy isn't the user's server download.
- The scan marker row as the "scanned" signal, and the status states listed in Part 3.
- Script sources in this repo, deployed as Dokploy file mounts.
- Skipping in the native service with 1 s tick precision.
- Manual seeks into an ad range are honoured.
- Unstarring leaves the server download, transcript and ad ranges in place.
- The schema check that stops the job and alerts on Telegram, against silent rot.

## Left to the builder

- Whether PinePods uses Postgres or MySQL here (read the PinePods compose in Dokploy), and
  the exact network and service names.
- The exact Claude prompt and how transcript segments are formatted for it. If a
  transcript is too long for one run, splitting it into windows.
- How the native service detects range entry (tick vs. Media3 player messages), as long as
  it works with the screen off.
- Cache invalidation for skip segments in the app.
- Tests: the app's existing unit tests cover engines and resume logic; skipping and source
  choice get the same treatment. The script gets tests for its state machine and its JSON
  validation.

## Risks and known limitations

- **PinePods' own detector can run anyway.** After a re-transcription on a different copy,
  PinePods re-runs its configured detector. With the local model failing, that leaves no
  rows and the job redoes the episode. If the local model ever "succeeds" with poor
  results, it overwrites Claude's. Mitigation: configure PinePods' LLM so its own
  detector can't run. Check in the AI settings what fails fast without side effects.
- **PinePods upgrades** may change the tables. The schema check stops the job; the real
  fix is a small upstream endpoint for writing ad ranges, which would remove database
  access entirely.
- **Listening before it's ready.** Starting an episode before the job has handled it
  plays the publisher's copy with its ads. Once the server has its own copy, resuming at
  the same second can land at a slightly different point in the show, because the two
  copies carry different ads.
- **Episodes already on the phone.** A phone download taken from the publisher before
  ranges existed isn't skippable. Deleting it and downloading again fixes that.
- **After auto-delete (if turned on).** Once a favorite's server copy is gone, streaming it
  plays the publisher's version with ads. A phone download taken from the server copy
  before then keeps skipping, because the transcript and ranges stay.
- **Subscription limits.** Three-hour episodes are long transcripts. The per-run cap keeps
  usage spread out.
- **The scan marker in PinePods' own screens.** PinePods' web player ignores it. Whether
  PinePods' transcript review screen lists it as an odd row hasn't been checked.
