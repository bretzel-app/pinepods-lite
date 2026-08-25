import { useCallback, useEffect, useRef, useState } from 'react';
import { cacheGet, cacheSet } from './db';

export interface CachedState<T> {
  data: T | undefined;
  /** True only while there is no cached data yet AND a fetch is in flight. */
  loading: boolean;
  /** True while a background revalidation is running. */
  refreshing: boolean;
  /** Set when the last fetch failed (cached data, if any, is still shown). */
  error: Error | null;
  /** True when data came from cache and the network refresh failed or is pending. */
  fromCache: boolean;
  refresh: () => void;
}

/**
 * Offline-first data hook: render whatever IndexedDB has instantly, then
 * revalidate over the network in the background. Screens never block on the
 * network when a cached copy exists — this is what makes navigation instant.
 *
 * Cache entries are namespaced by account id, so switching accounts swaps the
 * entire data set without any flushes.
 */
export function useCached<T>(
  accountId: string,
  key: string,
  fetcher: () => Promise<T>,
): CachedState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [nonce, setNonce] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    let sawCache = false;
    cacheGet<T>(accountId, key).then((cached) => {
      if (cancelled) return;
      if (cached !== undefined) {
        sawCache = true;
        setData(cached);
        setFromCache(true);
        setLoading(false);
      }
      if (!navigator.onLine && cached !== undefined) return;
      setRefreshing(true);
      fetcherRef
        .current()
        .then(async (fresh) => {
          if (cancelled) return;
          setData(fresh);
          setFromCache(false);
          setError(null);
          await cacheSet(accountId, key, fresh);
        })
        .catch((e: Error) => {
          if (cancelled) return;
          setError(e);
        })
        .finally(() => {
          if (cancelled) return;
          setRefreshing(false);
          setLoading(false);
          if (!sawCache) setLoading(false);
        });
    });

    return () => {
      cancelled = true;
    };
  }, [accountId, key, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, refreshing, error, fromCache, refresh };
}
