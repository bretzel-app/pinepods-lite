import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { Episode, SearchResult } from '../lib/types';
import { useActiveAccount } from '../lib/accounts';
import { addPodcast, fetchPodcastFeed, getSubscribedPodcasts, previewEpisodeId } from '../lib/api';
import { useCached } from '../lib/useCached';
import { cacheGet, cacheSet } from '../lib/db';
import { usePlayer } from '../player/PlayerContext';
import { formatDate, formatDuration, stripHtml } from '../lib/format';
import { PauseIcon, PlayIcon, PlusIcon } from '../components/icons';

/**
 * Episodes of a podcast the user hasn't subscribed to, straight from its RSS
 * feed (parsed server-side). Episodes are playable — resume is tracked
 * locally under synthetic ids — but saving/downloading needs a subscription.
 */
export default function PodcastPreview() {
  const account = useActiveAccount();
  const player = usePlayer();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const feedUrl = params.get('feed') ?? '';

  // Podcast metadata arrives via navigation state; cached for hard refreshes.
  const stateResult = (location.state as { result?: SearchResult } | null)?.result;
  const [meta, setMeta] = useState<SearchResult | null>(stateResult ?? null);
  useEffect(() => {
    if (meta || !feedUrl) return;
    cacheGet<SearchResult>(account.id, `feedmeta:${feedUrl}`).then((m) => {
      if (m) setMeta(m);
    });
  }, [account.id, feedUrl, meta]);

  const feed = useCached(account.id, `feed:${feedUrl}`, () => fetchPodcastFeed(account, feedUrl));
  const [subscribing, setSubscribing] = useState(false);

  const episodes: Episode[] = useMemo(
    () =>
      (feed.data ?? [])
        .filter((e) => e.enclosure_url)
        .map((e) => ({
          episodeid: previewEpisodeId(e.guid || e.enclosure_url || e.title || ''),
          episodetitle: e.title ?? '',
          podcastname: meta?.title ?? '',
          episodepubdate: e.pub_date,
          episodedescription: e.description ?? e.content ?? '',
          episodeartwork: e.artwork || meta?.artwork || '',
          episodeurl: e.enclosure_url!,
          episodeduration: e.duration,
          listenduration: null,
          completed: false,
          saved: false,
          queued: false,
          downloaded: false,
          is_youtube: false,
        })),
    [feed.data, meta],
  );

  const onSubscribe = async () => {
    if (!meta) return;
    setSubscribing(true);
    try {
      const added = await addPodcast(account, {
        title: meta.title,
        artwork: meta.artwork,
        author: meta.author,
        categories: meta.categories,
        description: meta.description,
        episodeCount: meta.episodeCount,
        feedUrl: meta.feedUrl,
        website: meta.website,
        explicit: meta.explicit,
        indexId: meta.indexId,
      });
      const pods = await getSubscribedPodcasts(account);
      await cacheSet(account.id, 'podcasts', pods);
      navigate(`/podcasts/${added.podcast_id}`, { replace: true });
    } catch (e) {
      alert(`Couldn't subscribe: ${(e as Error).message}`);
    } finally {
      setSubscribing(false);
    }
  };

  return (
    <div>
      <div className="pod-header">
        {meta?.artwork ? <img src={meta.artwork} alt="" /> : <div />}
        <div className="info">
          <h1>{meta?.title ?? 'Podcast preview'}</h1>
          {meta?.author && <div className="muted" style={{ fontSize: 13 }}>{meta.author}</div>}
          {meta?.description && <div className="desc">{stripHtml(meta.description)}</div>}
          <button className="btn" onClick={onSubscribe} disabled={!meta || subscribing}>
            <PlusIcon />
            {subscribing ? 'Subscribing…' : 'Subscribe'}
          </button>
        </div>
      </div>

      <div className="notice">
        Previewing this feed — subscribe to save episodes, download them, and sync progress across
        devices.
      </div>

      {feed.loading && !feed.data && <div className="notice">Loading feed…</div>}
      {feed.error && !feed.data && (
        <div className="error-box">Couldn't load this feed: {feed.error.message}</div>
      )}

      {episodes.map((e) => {
        const isCurrent = player.episode?.episodeid === e.episodeid;
        const isPlaying = isCurrent && player.playing;
        const onPlay = () => {
          if (isCurrent) player.toggle();
          else void player.play(e);
        };
        return (
          <div className="episode-row" key={e.episodeid}>
            {e.episodeartwork ? (
              <img className="artwork" src={e.episodeartwork} alt="" onClick={onPlay} loading="lazy" />
            ) : (
              <div className="artwork" onClick={onPlay} />
            )}
            <div className="episode-main" onClick={onPlay}>
              <div className="episode-title">{e.episodetitle}</div>
              <div className="episode-meta">
                <span>{formatDate(e.episodepubdate)}</span>
                <span>{formatDuration(e.episodeduration)}</span>
              </div>
              {e.episodedescription && (
                <div className="episode-meta" style={{ marginTop: 4 }}>
                  <span
                    style={{
                      display: '-webkit-box',
                      WebkitLineClamp: 1,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    {stripHtml(e.episodedescription)}
                  </span>
                </div>
              )}
            </div>
            <div className="episode-actions">
              <button className="icon-btn" onClick={onPlay} title={isPlaying ? 'Pause' : 'Play'}>
                {isPlaying ? <PauseIcon /> : <PlayIcon />}
              </button>
            </div>
          </div>
        );
      })}
      {feed.data && episodes.length === 0 && (
        <div className="notice">No playable episodes found in this feed.</div>
      )}
    </div>
  );
}
