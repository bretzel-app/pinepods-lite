import type { AdRange, Notifier, SavedEpisode } from './types';
import type { StateStore } from './state';

const DAY_MS = 24 * 60 * 60_000;

export function formatSuccess(ep: SavedEpisode, ranges: AdRange[]): string {
  const head = `${ep.podcast} – ${ep.title}`;
  if (ranges.length === 0) return `${head}: no ads found`;
  const seconds = ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
  return `${head}: ${ranges.length} ads · ${Math.max(1, Math.round(seconds / 60))} min removed`;
}

export function telegramNotifier(o: {
  token: string; chatId: string; notifySuccess: boolean; store: StateStore; now: () => number; fetchImpl?: typeof fetch;
}): Notifier {
  const doFetch = o.fetchImpl ?? fetch;
  async function send(text: string): Promise<void> {
    try {
      const res = await doFetch(`https://api.telegram.org/bot${o.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: o.chatId, text }),
      });
      if (!res.ok) console.error(`adskip: Telegram answered ${res.status}`);
    } catch (e) {
      console.error(`adskip: Telegram send failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return {
    async success(text) {
      if (o.notifySuccess) await send(text);
    },
    async error(key, text) {
      const state = o.store.load();
      const now = o.now();
      const last = state.alerts[key];
      if (last !== undefined && now - last < DAY_MS) return;
      state.alerts[key] = now;
      o.store.save(state);
      await send(`⚠️ adskip: ${text}`);
    },
  };
}
