export interface RunState { alerts: Record<string, number>; attempts: Record<string, number> }
export interface StateStore { load(): RunState; save(s: RunState): void }

export function lockIsFree(lockMtimeMs: number | null, now: number, staleMs = 30 * 60_000): boolean {
  return lockMtimeMs === null || now - lockMtimeMs > staleMs;
}
