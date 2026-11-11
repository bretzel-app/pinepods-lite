import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readConfig } from './config';
import { bunDb } from './db';
import { telegramNotifier } from './notify';
import { pinepodsApi } from './pinepods';
import { claudeArgs } from './prompt';
import { runOnce } from './run';
import { lockIsFree } from './state';
import type { RunState, StateStore } from './state';
import { ClaudeUnavailable, claudeStdout } from './validate';

const DIR = '/root/.claude/adskip';
const STATE_FILE = `${DIR}/state.json`;
const LOCK_FILE = `${DIR}/lock`;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function fileStore(): StateStore {
  return {
    load(): RunState {
      try {
        const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
        return { alerts: raw.alerts ?? {}, attempts: raw.attempts ?? {} };
      } catch {
        return { alerts: {}, attempts: {} };
      }
    },
    save(s) {
      writeFileSync(STATE_FILE, JSON.stringify(s));
    },
  };
}

function lockMtime(): number | null {
  try {
    return statSync(LOCK_FILE).mtimeMs;
  } catch {
    return null;
  }
}

/** Takes the lock; false when another run holds it. */
function takeLock(now: number): boolean {
  const mtime = lockMtime();
  if (!lockIsFree(mtime, now)) return false;
  // Stale: its run died without cleaning up.
  if (mtime !== null) rmSync(LOCK_FILE, { force: true });
  try {
    writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
    return true;
  } catch (e) {
    // Another run took it in between.
    if ((e as { code?: string }).code === 'EEXIST') return false;
    throw e;
  }
}

/** The `claude` process running now, if any; it goes with the job. */
let child: { kill(): void } | null = null;

/** Only once this run holds the lock: a run that doesn't must never remove it. */
function releaseLockOnSignals(): void {
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
    process.on(signal, () => {
      child?.kill();
      rmSync(LOCK_FILE, { force: true });
      process.exit(code);
    });
  }
}

async function claude(prompt: string, timeoutMs: number): Promise<string> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(['claude', ...claudeArgs()], {
      stdin: new TextEncoder().encode(prompt),
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (e) {
    throw new ClaudeUnavailable(`claude could not be started: ${msg(e)}`);
  }
  child = proc;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    return claudeStdout({ code, timedOut, stdout, stderr, timeoutMs });
  } finally {
    clearTimeout(timer);
    child = null;
  }
}

async function main(): Promise<number> {
  let cfg;
  try {
    cfg = readConfig(process.env);
  } catch (e) {
    console.error(msg(e));
    return 1;
  }

  const now = Date.now;
  const store = fileStore();
  const notifier = telegramNotifier({
    token: cfg.telegramToken, chatId: cfg.chatId, notifySuccess: cfg.notifySuccess, store, now,
  });
  const lines: string[] = [];
  try {
    mkdirSync(DIR, { recursive: true });
    if (!takeLock(now())) return 0;
    releaseLockOnSignals();
    try {
      await runOnce({
        api: pinepodsApi(cfg.pinepodsUrl, cfg.apiKey, cfg.userId),
        db: bunDb(cfg.dbUrl),
        claude,
        notifier,
        store,
        now,
        log: (line) => lines.push(line),
      });
    } finally {
      rmSync(LOCK_FILE, { force: true });
    }
  } catch (e) {
    console.error(e instanceof Error ? e.stack ?? e.message : String(e));
    // Nobody reads stderr (the job runs with notify: false).
    try {
      await notifier.error('unexpected', `unexpected error: ${msg(e)}`);
    } catch {
      // best effort
    }
    return 1;
  }
  if (lines.length > 0) console.log(lines.join('\n'));
  return 0;
}

process.exit(await main());
