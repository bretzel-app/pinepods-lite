export type Dialect = 'postgres' | 'mysql';

export function dialectOf(url: string): Dialect {
  if (/^postgres(ql)?:\/\//.test(url)) return 'postgres';
  if (/^mysql:\/\//.test(url)) return 'mysql';
  throw new Error('PINEPODS_DB_URL must start with postgres://, postgresql:// or mysql://');
}

export function statements(d: Dialect) {
  if (d === 'postgres') {
    return {
      columns: `SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('EpisodeSkipSegments', 'Episodes')`,
      deleteAutoAd: 'DELETE FROM "EpisodeSkipSegments" WHERE episodeid = $1 AND source = $2',
      insertSegment: 'INSERT INTO "EpisodeSkipSegments" (episodeid, kind, starttime, endtime, source) VALUES ($1, $2, $3, $4, $5)',
      setDetected: 'UPDATE "Episodes" SET adsdetected = TRUE WHERE episodeid = $1',
      clearDetected: 'UPDATE "Episodes" SET adsdetected = FALSE WHERE episodeid = $1',
    };
  }
  return {
    columns: `SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('EpisodeSkipSegments', 'Episodes') AND table_schema = DATABASE()`,
    deleteAutoAd: 'DELETE FROM EpisodeSkipSegments WHERE EpisodeID = ? AND Source = ?',
    insertSegment: 'INSERT INTO EpisodeSkipSegments (EpisodeID, Kind, StartTime, EndTime, Source) VALUES (?, ?, ?, ?, ?)',
    setDetected: 'UPDATE Episodes SET AdsDetected = TRUE WHERE EpisodeID = ?',
    clearDetected: 'UPDATE Episodes SET AdsDetected = FALSE WHERE EpisodeID = ?',
  };
}

export const REQUIRED_COLUMNS: Record<'EpisodeSkipSegments' | 'Episodes', string[]> = {
  EpisodeSkipSegments: ['episodeid', 'kind', 'starttime', 'endtime', 'source'],
  Episodes: ['episodeid', 'adsdetected'],
};

export function missingColumns(rows: { table_name: string; column_name: string }[]): string[] {
  const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`.toLowerCase()));
  const missing: string[] = [];
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    for (const col of cols) if (!have.has(`${table}.${col}`.toLowerCase())) missing.push(`${table}.${col}`);
  }
  return missing;
}
