import { SQL } from 'bun';
import { dialectOf, missingColumns, statements } from './sql';
import type { AdRange, AdskipDb } from './types';

export function bunDb(url: string): AdskipDb {
  const st = statements(dialectOf(url));
  const sql = new SQL(url);

  return {
    async checkSchema() {
      const rows = (await sql.unsafe(st.columns)) as Record<string, unknown>[];
      // MySQL may return the column names upper-case.
      const normalized = rows.map((r) => {
        const lower: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) lower[k.toLowerCase()] = v;
        return { table_name: String(lower.table_name), column_name: String(lower.column_name) };
      });
      const missing = missingColumns(normalized);
      if (missing.length > 0) throw new Error(`PinePods database lacks ${missing.join(', ')}`);
    },

    async writeAds(episodeId, ranges: AdRange[]) {
      await sql.begin(async (tx) => {
        await tx.unsafe(st.deleteAutoAd, [episodeId, 'auto-ad']);
        for (const r of ranges) await tx.unsafe(st.insertSegment, [episodeId, 'ad', r.start, r.end, 'auto-ad']);
        await tx.unsafe(st.insertSegment, [episodeId, 'ad-scan', 0, 0, 'auto-ad']);
        await tx.unsafe(st.setDetected, [episodeId]);
      });
    },

    async clearAds(episodeId) {
      await sql.begin(async (tx) => {
        await tx.unsafe(st.deleteAutoAd, [episodeId, 'auto-ad']);
        await tx.unsafe(st.clearDetected, [episodeId]);
      });
    },
  };
}
