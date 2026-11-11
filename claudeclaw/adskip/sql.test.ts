import { describe, expect, it } from 'vitest';
import { dialectOf, missingColumns, statements } from './sql';

describe('sql', () => {
  it('picks the dialect from the URL', () => {
    expect(dialectOf('postgres://u:p@db/pinepods')).toBe('postgres');
    expect(dialectOf('postgresql://u:p@db/pinepods')).toBe('postgres');
    expect(dialectOf('mysql://u:p@db/pinepods')).toBe('mysql');
    expect(() => dialectOf('sqlite://x')).toThrow();
  });
  it('writes rows the way PinePods does', () => {
    expect(statements('postgres').insertSegment).toBe(
      'INSERT INTO "EpisodeSkipSegments" (episodeid, kind, starttime, endtime, source) VALUES ($1, $2, $3, $4, $5)');
    expect(statements('mysql').insertSegment).toBe(
      'INSERT INTO EpisodeSkipSegments (EpisodeID, Kind, StartTime, EndTime, Source) VALUES (?, ?, ?, ?, ?)');
    expect(statements('postgres').setDetected).toBe('UPDATE "Episodes" SET adsdetected = TRUE WHERE episodeid = $1');
    expect(statements('mysql').clearDetected).toBe('UPDATE Episodes SET AdsDetected = FALSE WHERE EpisodeID = ?');
    expect(statements('postgres').deleteAutoAd).toBe('DELETE FROM "EpisodeSkipSegments" WHERE episodeid = $1 AND source = $2');
    expect(statements('mysql').deleteAutoAd).toBe('DELETE FROM EpisodeSkipSegments WHERE EpisodeID = ? AND Source = ?');
  });
  it('reads the schema, scoping MySQL to the current database', () => {
    expect(statements('postgres').columns).toContain('information_schema.columns');
    expect(statements('postgres').columns).not.toContain('DATABASE()');
    expect(statements('mysql').columns).toContain('table_schema = DATABASE()');
  });
  it('finds missing columns, ignoring case', () => {
    const all = [['EpisodeSkipSegments', 'EpisodeID'], ['EpisodeSkipSegments', 'kind'], ['EpisodeSkipSegments', 'StartTime'],
      ['EpisodeSkipSegments', 'endtime'], ['EpisodeSkipSegments', 'Source'], ['Episodes', 'episodeid'], ['Episodes', 'AdsDetected']]
      .map(([table_name, column_name]) => ({ table_name, column_name }));
    expect(missingColumns(all)).toEqual([]);
    expect(missingColumns(all.filter((r) => r.column_name !== 'AdsDetected'))).toEqual(['Episodes.adsdetected']);
  });
});
