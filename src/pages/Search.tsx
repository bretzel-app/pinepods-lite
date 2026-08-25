import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useActiveAccount } from '../lib/accounts';
import { addPodcast, getSubscribedPodcasts, searchPodcasts } from '../lib/api';
import type { SearchResult } from '../lib/types';
import { useCached } from '../lib/useCached';
import { cacheGet, cacheSet } from '../lib/db';
import { CheckIcon, PlusIcon, SearchIcon } from '../components/icons';
import { useOnline } from '../components/Layout';

export default function Search() {
  const account = useActiveAccount();
  const online = useOnline();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAdd, setPendingAdd] = useState<number | null>(null);

  const subs = useCached(account.id, 'podcasts', () => getSubscribedPodcasts(account));
  const subscribedFeeds = new Set((subs.data ?? []).map((p) => p.feedurl));

  // Restore the last search so navigating into a podcast and back (or an
  // app restart) doesn't lose the results.
  useEffect(() => {
    cacheGet<{ query: string; results: SearchResult[] }>(account.id, 'last-search').then((s) => {
      if (s) {
        setQuery(s.query);
        setResults(s.results);
      }
    });
  }, [account.id]);

  const onSearch = async (e: FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const q = query.trim();
      const found = await searchPodcasts(account, q);
      setResults(found);
      void cacheSet(account.id, 'last-search', { query: q, results: found });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openPodcast = (r: SearchResult) => {
    // Already subscribed → the real podcast page; otherwise a feed preview.
    const sub = (subs.data ?? []).find((p) => p.feedurl === r.feedUrl);
    if (sub) {
      navigate(`/podcasts/${sub.podcastid}`);
      return;
    }
    void cacheSet(account.id, `feedmeta:${r.feedUrl}`, r);
    navigate(`/preview?feed=${encodeURIComponent(r.feedUrl)}`, { state: { result: r } });
  };

  const onSubscribe = async (r: SearchResult) => {
    setPendingAdd(r.indexId);
    try {
      await addPodcast(account, {
        title: r.title,
        artwork: r.artwork,
        author: r.author,
        categories: r.categories,
        description: r.description,
        episodeCount: r.episodeCount,
        feedUrl: r.feedUrl,
        website: r.website,
        explicit: r.explicit,
        indexId: r.indexId,
      });
      // Refresh the cached subscription list so Podcasts shows it immediately.
      const pods = await getSubscribedPodcasts(account);
      await cacheSet(account.id, 'podcasts', pods);
      subs.refresh();
    } catch (err) {
      alert(`Couldn't subscribe: ${(err as Error).message}`);
    } finally {
      setPendingAdd(null);
    }
  };

  return (
    <div>
      <h1 className="page-title">Search</h1>
      <form className="searchbar" onSubmit={onSearch}>
        <input
          type="search"
          placeholder="Find podcasts…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={!online}
        />
        <button className="btn" type="submit" disabled={busy || !online}>
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
      {!online && <div className="notice">Search needs a connection.</div>}
      {error && <div className="error-box">{error}</div>}
      {results?.length === 0 && <div className="notice">No results.</div>}
      {(results ?? []).map((r) => {
        const isSubscribed = subscribedFeeds.has(r.feedUrl);
        return (
          <div className="episode-row" key={`${r.indexId}:${r.feedUrl}`}>
            {r.artwork ? (
              <img className="artwork" src={r.artwork} alt="" loading="lazy" onClick={() => openPodcast(r)} />
            ) : (
              <div className="artwork" onClick={() => openPodcast(r)} />
            )}
            <div className="episode-main" onClick={() => openPodcast(r)}>
              <div className="episode-title">{r.title}</div>
              <div className="episode-meta">
                <span>{r.author}</span>
                {r.episodeCount > 0 && <span>{r.episodeCount} episodes</span>}
              </div>
              <div className="episode-meta" style={{ marginTop: 4 }}>
                <span
                  style={{
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {r.description}
                </span>
              </div>
            </div>
            <div className="episode-actions">
              {isSubscribed ? (
                <span className="pill offline">
                  <CheckIcon /> subscribed
                </span>
              ) : (
                <button
                  className="icon-btn"
                  title="Subscribe"
                  disabled={pendingAdd === r.indexId}
                  onClick={() => onSubscribe(r)}
                >
                  {pendingAdd === r.indexId ? <span className="spinner" /> : <PlusIcon />}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
