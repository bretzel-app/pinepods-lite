import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readConfig } from './config';
import { bunDb } from './db';
import { telegramNotifier } from './notify';
import { pinepodsApi } from './pinepods';
import { claudeArgs } from './prompt';
import { runOnce } from './run';
import { lockIsFree } from './state';
import type { RunState, StateStore } from './state';

const DIR = '/root/.claude/adskip';
const STATE_FILE = `${DIR}/state.json`;
const LOCK_FILE = `${DIR}/lock`;
const CLAUDE_TIMEOUT_MS = 5 * 60_000;

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

async function claude(prompt: string): Promise<string> {
  const proc = Bun.spawn(['claude', ...claudeArgs()], {
    stdin: new TextEncoder().encode(prompt),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, CLAUDE_TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) throw new Error('claude timed out after 5 minutes');
    if (code !== 0) throw new Error(`claude exited with code ${code}: ${err.slice(-500)}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<number> {
  let cfg;
  try {
    cfg = readConfig(process.env);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }

  mkdirSync(DIR, { recursive: true });
  const now = Date.now;
  if (!lockIsFree(lockMtime(), now())) return 0;
  writeFileSync(LOCK_FILE, String(process.pid));

  const lines: string[] = [];
  try {
    const store = fileStore();
    await runOnce({
      api: pinepodsApi(cfg.pinepodsUrl, cfg.apiKey, cfg.userId),
      db: bunDb(cfg.dbUrl),
      claude,
      notifier: telegramNotifier({
        token: cfg.telegramToken, chatId: cfg.chatId, notifySuccess: cfg.notifySuccess, store, now,
      }),
      store,
      now,
      log: (line) => lines.push(line),
    });
  } catch (e) {
    console.error(e instanceof Error ? e.stack ?? e.message : String(e));
    return 1;
  } finally {
    rmSync(LOCK_FILE, { force: true });
  }
  if (lines.length > 0) console.log(lines.join('\n'));
  return 0;
}

process.exit(await main());
