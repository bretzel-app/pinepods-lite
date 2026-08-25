import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useActiveAccount } from '../lib/accounts';
import { getPodcastEpisodes, getSubscribedPodcasts, removePodcast } from '../lib/api';
import { useCached } from '../lib/useCached';
import { cacheSet } from '../lib/db';
import { stripHtml } from '../lib/format';
import EpisodeRow from '../components/EpisodeRow';

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

      {eps.refreshing && <div className="notice">Refreshing episodes…</div>}
      {eps.loading && !eps.data && <div className="notice">Loading episodes…</div>}
      {eps.error && !eps.data && (
        <div className="error-box">Couldn't load episodes: {eps.error.message}</div>
      )}
      {(eps.data ?? []).map((e) => (
        <EpisodeRow
          key={e.episodeid}
          episode={{ ...e, podcastid: id, podcastname: e.podcastname || podcast?.podcastname || '' }}
          hidePodcast
        />
      ))}
    </div>
  );
}
