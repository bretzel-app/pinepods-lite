import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useActiveAccount } from '../lib/accounts';
import { getAllPodcastEpisodes, getSubscribedPodcasts, removePodcast } from '../lib/api';
import { useCached } from '../lib/useCached';
import { cacheSet } from '../lib/db';
import { stripHtml } from '../lib/format';
import { isEffectivelyFinished } from '../lib/continueListening';
import { buildSearchIndex, filterEpisodes } from '../lib/episodeSearch';
import { chronological } from '../lib/playQueue';
import type { Episode } from '../lib/types';
import EpisodeRow from '../components/EpisodeRow';
import { PlayedFilter, useHidePlayed } from '../components/PlayedFilter';

const PAGE = 200;

export default function PodcastDetail() {
  const account = useActiveAccount();
  const { podcastId } = useParams();
  const id = Number(podcastId);
  const navigate = useNavigate();
  const [removing, setRemoving] = useState(false);

  // Reuse the cached subscription list for the header (works offline too).
  const pods = useCached(account.id, 'podcasts', () => getSubscribedPodcasts(account));
  const podcast = useMemo(
    () => (pods.data ?? []).find((p) => p.podcastid === id),
    [pods.data, id],
  );

  const eps = useCached(account.id, `podcast-episodes:${id}`, () =>
    getAllPodcastEpisodes(account, id),
  );

  const [hidePlayed, setHidePlayed] = useHidePlayed();
  const [query, setQuery] = useState('');

  // Same "effectively finished" rule as Continue listening: completed flag,
  // under a minute remaining, or >= 98% played.
  const unplayedEpisodes = useMemo(() => {
    const all = eps.data ?? [];
    if (!hidePlayed) return all;
    return all.filter(
      (e) => !isEffectivelyFinished(e, e.listenduration ?? 0, e.episodeduration || 0),
    );
  }, [eps.data, hidePlayed]);

  const searchIndex = useMemo(() => buildSearchIndex(eps.data ?? []), [eps.data]);
  const visibleEpisodes = useMemo(
    () => filterEpisodes(unplayedEpisodes, searchIndex, query),
    [unplayedEpisodes, searchIndex, query],
  );
  const searching = query.trim() !== '';

  // Rows from this endpoint can omit the podcast fields.
  const withPodcast = useMemo(() => {
    const name = podcast?.podcastname || '';
    return (e: Episode): Episode => ({ ...e, podcastid: id, podcastname: e.podcastname || name });
  }, [id, podcast?.podcastname]);
  // Previous/next follow publication order over what's shown (respecting the
  // Unplayed filter and search), so a serialized story plays in order.
  const queue = useMemo(
    () => ({
      source: podcast?.podcastname || 'Podcast',
      episodes: chronological(visibleEpisodes.map(withPodcast)),
    }),
    [visibleEpisodes, withPodcast, podcast?.podcastname],
  );

  // Long-running shows can have thousands of episodes; render them in chunks.
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [query, hidePlayed, id]);

  const onUnsubscribe = async () => {
    if (!podcast) return;
    if (!confirm(`Unsubscribe from “${podcast.podcastname}”?`)) return;
    setRemoving(true);
    try {
      await removePodcast(account, id);
      // Update the cached list immediately so the grid reflects it offline.
      const next = (pods.data ?? []).filter((p) => p.podcastid !== id);
      await cacheSet(account.id, 'podcasts', next);
      navigate('/podcasts');
    } catch (e) {
      alert(`Couldn't unsubscribe: ${(e as Error).message}`);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div>
      <div className="pod-header">
        {podcast?.artworkurl ? <img src={podcast.artworkurl} alt="" /> : <div />}
        <div className="info">
          <h1>{podcast?.podcastname ?? 'Podcast'}</h1>
          {podcast?.author && <div className="muted" style={{ fontSize: 13 }}>{podcast.author}</div>}
          {podcast?.description && <div className="desc">{stripHtml(podcast.description)}</div>}
          <button className="btn danger" onClick={onUnsubscribe} disabled={removing || !podcast}>
            {removing ? 'Removing…' : 'Unsubscribe'}
          </button>
        </div>
      </div>

      <div className="list-toolbar">
        <h2>Episodes</h2>
        <PlayedFilter value={hidePlayed} onChange={setHidePlayed} />
      </div>
      {eps.data && eps.data.length > 0 && (
        <input
          className="episode-search"
          type="search"
          placeholder="Search episodes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      {eps.refreshing && <div className="notice">Refreshing episodes…</div>}
      {eps.loading && !eps.data && <div className="notice">Loading episodes…</div>}
      {eps.error && !eps.data && (
        <div className="error-box">Couldn't load episodes: {eps.error.message}</div>
      )}
      {visibleEpisodes.slice(0, shown).map((e) => (
        <EpisodeRow key={e.episodeid} episode={withPodcast(e)} hidePodcast queue={queue} />
      ))}
      {visibleEpisodes.length > shown && (
        <button className="btn show-more" onClick={() => setShown((n) => n + PAGE)}>
          Show more ({visibleEpisodes.length - shown} left)
        </button>
      )}
      {searching && eps.data && visibleEpisodes.length === 0 && (
        <div className="notice">No episodes match “{query.trim()}”.</div>
      )}
      {!searching && hidePlayed && eps.data && visibleEpisodes.length < eps.data.length && (
        <div className="notice">
          {eps.data.length - visibleEpisodes.length} played episode
          {eps.data.length - visibleEpisodes.length === 1 ? '' : 's'} hidden.
        </div>
      )}
    </div>
  );
}
