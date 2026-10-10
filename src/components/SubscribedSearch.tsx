import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useActiveAccount } from '../lib/accounts';
import { searchSubscribedEpisodes } from '../lib/api';
import type { Episode } from '../lib/types';
import { cacheGet, cacheSet } from '../lib/db';
import { searchCachedEpisodes } from '../lib/episodeSearch';
import { SearchIcon } from './icons';
import { useOnline } from './Layout';
import EpisodeRow from './EpisodeRow';

interface LastSearch {
  query: string;
  episodes: Episode[];
  /** true when the results came from this device's cache, not the server */
  local: boolean;
}

/**
 * Search episodes across every subscription. Online it asks the server, which
 * sees every episode; offline (or if the server fails) it searches the episode
 * lists already cached on this device.
 */
export default function SubscribedSearch() {
  const account = useActiveAccount();
  const online = useOnline();
  const [query, setQuery] = useState('');
  const [last, setLast] = useState<LastSearch | null>(null);
  const [busy, setBusy] = useState(false);
  const queue = useMemo(
    () => ({ source: 'Search results', episodes: last?.episodes ?? [] }),
    [last],
  );

  useEffect(() => {
    cacheGet<LastSearch>(account.id, 'last-episode-search').then((s) => {
      if (s) {
        setQuery(s.query);
        setLast(s);
      }
    });
  }, [account.id]);

  const onSearch = async (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    try {
      let found: Episode[] | null = null;
      if (online) {
        try {
          found = await searchSubscribedEpisodes(account, q);
        } catch {
          // Fall through to the on-device search below.
        }
      }
      const result: LastSearch = found
        ? { query: q, episodes: found, local: false }
        : { query: q, episodes: await searchCachedEpisodes(account.id, q), local: true };
      setLast(result);
      void cacheSet(account.id, 'last-episode-search', result);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <form className="searchbar" onSubmit={onSearch}>
        <input
          type="search"
          placeholder="Search episodes in your podcasts…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn" type="submit" disabled={busy}>
          {busy ? (
            <span className="spinner" />
          ) : (
            <>
              <SearchIcon />
              Search
            </>
          )}
        </button>
      </form>
      {last?.local && (
        <div className="notice">
          Couldn't reach the server — showing matches from episodes saved on this device.
        </div>
      )}
      {last && last.episodes.length === 0 && (
        <div className="notice">No episodes match “{last.query}”.</div>
      )}
      {(last?.episodes ?? []).map((e) => (
        <EpisodeRow key={e.episodeid} episode={e} queue={queue} />
      ))}
    </div>
  );
}
