import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useActiveAccount } from '../lib/accounts';
import { getPodcastEpisodes, getSubscribedPodcasts, removePodcast } from '../lib/api';
import { useCached } from '../lib/useCached';
import { cacheSet } from '../lib/db';
import { stripHtml } from '../lib/format';
import { isEffectivelyFinished } from '../lib/continueListening';
import EpisodeRow from '../components/EpisodeRow';

const HIDE_PLAYED_KEY = 'pinepods.hidePlayed';

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

  const eps = useCached(account.id, `podcast-episodes:${id}`, async () => {
    const { episodes } = await getPodcastEpisodes(account, id, 200);
    return episodes;
  });

  const [hidePlayed, setHidePlayedState] = useState(
    () => localStorage.getItem(HIDE_PLAYED_KEY) === '1',
  );
  const setHidePlayed = (value: boolean) => {
    localStorage.setItem(HIDE_PLAYED_KEY, value ? '1' : '0');
    setHidePlayedState(value);
  };

  // Same "effectively finished" rule as Continue listening: completed flag,
  // under a minute remaining, or >= 98% played.
  const visibleEpisodes = useMemo(() => {
    const all = eps.data ?? [];
    if (!hidePlayed) return all;
    return all.filter(
      (e) => !isEffectivelyFinished(e, e.listenduration ?? 0, e.episodeduration || 0),
    );
  }, [eps.data, hidePlayed]);

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
        <div className="segmented">
          <button className={!hidePlayed ? 'on' : ''} onClick={() => setHidePlayed(false)}>
            All
          </button>
          <button className={hidePlayed ? 'on' : ''} onClick={() => setHidePlayed(true)}>
            Unplayed
          </button>
        </div>
      </div>

      {eps.refreshing && <div className="notice">Refreshing episodes…</div>}
      {eps.loading && !eps.data && <div className="notice">Loading episodes…</div>}
      {eps.error && !eps.data && (
        <div className="error-box">Couldn't load episodes: {eps.error.message}</div>
      )}
      {visibleEpisodes.map((e) => (
        <EpisodeRow
          key={e.episodeid}
          episode={{ ...e, podcastid: id, podcastname: e.podcastname || podcast?.podcastname || '' }}
          hidePodcast
        />
      ))}
      {hidePlayed && eps.data && visibleEpisodes.length < eps.data.length && (
        <div className="notice">
          {eps.data.length - visibleEpisodes.length} played episode
          {eps.data.length - visibleEpisodes.length === 1 ? '' : 's'} hidden.
        </div>
      )}
    </div>
  );
}
