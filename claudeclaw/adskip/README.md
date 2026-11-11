# Ad-skip job

A claudeclaw job that finds ads in the transcripts of starred PinePods episodes and writes them
into PinePods' `EpisodeSkipSegments` table. The sources are bundled into one file, `adskip.js`.

## Deployment (Dokploy, claudeclaw app)

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

## Names found at deploy time

- Database engine: `<postgres | mysql>`
- Database service and credentials: `<service>`, `<user>`
- PinePods compose network: `<network name>`
- PinePods internal service and port: `<service>:<port>`

State (`state.json`) and the lock live in `/root/.claude/adskip/`, the only persistent path.
