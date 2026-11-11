# Ad-skip job

A claudeclaw job that finds ads in the transcripts of starred PinePods episodes and writes them
into PinePods' `EpisodeSkipSegments` table. The sources are bundled into one file, `adskip.js`.

## PinePods settings

- An API key for the user, created in PinePods' settings; it goes in `PINEPODS_API_KEY`.
- For every podcast whose starred episodes the job handles: PinePods' own **ad detection off**
  and **skip auto-activate on** (the default), so ranges the job writes are skipped at once and
  PinePods' local model never overwrites them.
- PinePods still runs its own detector after it re-transcribes an episode on a different copy.
  Make that fail fast and harmlessly: in PinePods' AI settings, point the ad-detection LLM at
  something that refuses at once (for example an endpoint nobody listens on, such as
  `http://127.0.0.1:9`), then check PinePods' log that a detection attempt fails immediately and
  writes no ranges. Note here what was set.

## Deployment (Dokploy, claudeclaw app)

0. Check the container's Bun: `bun --version`. The job talks to the database with `Bun.SQL`,
   which needs Bun ≥ 1.2 for Postgres and **≥ 1.2.21 for MySQL**.
1. Build the bundle: `npm run build:adskip` (writes `claudeclaw/adskip/dist/adskip.js`, gitignored).
2. In the claudeclaw app's Mounts tab, add two file mounts:
   - `../files/adskip.js:/root/adskip/adskip.js:ro` (contents of `dist/adskip.js`)
   - `../files/adskip.md:/root/.claude/claudeclaw/jobs/adskip.md:ro` (contents of `adskip.md`)
3. Environment variables on the claudeclaw service:

   | Variable | Value |
   | --- | --- |
   | `PINEPODS_URL` | internal address, `http://<pinepods-service>:<port>` |
   | `PINEPODS_API_KEY` | PinePods API key of the user |
   | `PINEPODS_USER_ID` | PinePods user id |
   | `PINEPODS_DB_URL` | `postgres://<user>:<password>@<db-service>:5432/<database>` (or `mysql://...`) |
   | `TELEGRAM_TOKEN` | Telegram bot token |
   | `ADSKIP_ALERT_CHAT_ID` | Telegram chat id for alerts |
   | `ADSKIP_NOTIFY_SUCCESS` | `true` to also get a message per finished episode |
   | `ENABLE_CLAUDEAI_MCP_SERVERS` | `false` (required: the job's Claude must not load account connectors) |

4. Add PinePods' compose network to the claudeclaw service as an `external` network, so the
   database and PinePods are reachable.
5. Redeploy.

## Dry run

In the claudeclaw container terminal:

```
bun /root/adskip/adskip.js; echo "exit $?"
```

Expected with nothing starred: no output, `exit 0`. A missing variable prints the list of
names and exits 1. Schema or connection problems raise a Telegram alert.

The terminal dry run doesn't exercise what the scheduled job does: there `claude -p` runs
nested inside the job's own Claude, through its Bash tool. Check the log of the first
scheduled run that had an episode to analyze (and the Telegram chat) before relying on it.

The output names episodes by id only (`episode 12: 7 ads, 11 min`,
`episode 12: copy mismatch, re-transcribing`), never by title: the job's Claude reads it, and
titles come from publishers. Telegram messages carry the titles.

## Alerts and retries

Each alert repeats at most once a day. Keys, as stored under `alerts` in `state.json`:

- `schema`: the database lacks a table or column (nothing is written until fixed), or a write
  didn't show up in PinePods (wrong `PINEPODS_DB_URL`?; the run stops there).
- `pinepods`: PinePods unreachable or answering something that isn't PinePods (wrong
  `PINEPODS_URL`?).
- `claude`: the `claude` CLI failed (usage limit, expired login, outage, timeout). That run
  stops calling Claude; it doesn't count against any episode.
- `invalid:<id>`: Claude's answer or the database write failed for that episode. After 3 such
  attempts the episode is given up (`gave-up:<id>`) for 24 hours, then tried again.
- `transcription-failed:<id>`, `empty-transcript:<id>`: sent once; the job never retries these.
- `unexpected`: the job crashed; its stack trace is on stderr in the job log.

## Resetting an episode by hand

State lives in `/root/.claude/adskip/state.json`. Edit it only while no run is going (no
`/root/.claude/adskip/lock`), since a run rewrites the file when it ends.

- **Given up** (or failing): under `attempts`, delete `"<id>"` and `"gave-up:<id>"`; under
  `alerts`, delete `"invalid:<id>"` and `"gave-up:<id>"` so a new failure alerts at once. The
  next run tries it again. (A given-up episode is also retried by itself after 24 hours.)
- **Transcription failed** or **empty transcript**: the job doesn't retry these. Ask PinePods
  for a new transcript, then under `attempts` delete `"transcription-failed:<id>"` /
  `"empty-transcript:<id>"` so a new failure alerts again:

  ```
  curl -X POST "$PINEPODS_URL/api/data/transcribe_episode" -H "Api-Key: $PINEPODS_API_KEY" \
    -H 'Content-Type: application/json' -d '{"episode_id": <id>, "user_id": '"$PINEPODS_USER_ID"', "force": true}'
  ```

## Names found at deploy time

- Database engine: `<postgres | mysql>`
- Database service and credentials: `<service>`, `<user>`
- PinePods compose network: `<network name>`
- PinePods internal service and port: `<service>:<port>`

State (`state.json`) and the lock live in `/root/.claude/adskip/`, the only persistent path.
