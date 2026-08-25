import { useEffect, useMemo, useState } from 'react';
import { useActiveAccount } from '../lib/accounts';
import { getRecentEpisodes, getUserHistory } from '../lib/api';
import { useCached } from '../lib/useCached';
import { buildContinueListening, isEffectivelyFinished } from '../lib/continueListening';
import type { Episode } from '../lib/types';
import EpisodeRow from '../components/EpisodeRow';
import { PlayedFilter, useHidePlayed } from '../components/PlayedFilter';

export default function Home() {
  const account = useActiveAccount();

  const history = useCached(account.id, 'history', () => getUserHistory(account, 30));
  const recent = useCached(account.id, 'recent-episodes', async () => {
    const { episodes } = await getRecentEpisodes(account, 50);
    return episodes;
  });

  // Server history merged with local (offline) progress, finished ones dropped.
  const [inProgress, setInProgress] = useState<Episode[]>([]);
  useEffect(() => {
    let cancelled = false;
    buildContinueListening(account, history.data ?? []).then((list) => {
      if (!cancelled) setInProgress(list);
    });
    return () => {
      cancelled = true;
    };
  }, [account, history.data]);

  const [hidePlayed, setHidePlayed] = useHidePlayed();
  const latest = useMemo(() => {
    const all = recent.data ?? [];
    if (!hidePlayed) return all;
    return all.filter(
      (e) => !isEffectivelyFinished(e, e.listenduration ?? 0, e.episodeduration || 0),
    );
  }, [recent.data, hidePlayed]);

  return (
    <div>
      <h1 className="page-title">
        Home
        {recent.refreshing && <span className="spinner" />}
      </h1>

      {inProgress.length > 0 && (
        <section className="continue-listening">
          <h2 style={{ fontSize: 15, margin: '4px 0' }}>Continue listening</h2>
          {inProgress.map((e) => (
            <EpisodeRow key={`h${e.episodeid}`} episode={e} />
          ))}
        </section>
      )}

      <div className="list-toolbar" style={{ marginTop: inProgress.length > 0 ? 18 : 0 }}>
        <h2>Latest episodes</h2>
        <PlayedFilter value={hidePlayed} onChange={setHidePlayed} />
      </div>

      {recent.loading && !recent.data && (
        <div className="notice">Loading your feed…</div>
      )}
      {recent.error && !recent.data && (
        <div className="error-box">Couldn't load episodes: {recent.error.message}</div>
      )}
      {latest.map((e) => (
        <EpisodeRow key={e.episodeid} episode={e} />
      ))}
      {hidePlayed && recent.data && latest.length < recent.data.length && (
        <div className="notice">
          {recent.data.length - latest.length} played episode
          {recent.data.length - latest.length === 1 ? '' : 's'} hidden.
        </div>
      )}
      {recent.data?.length === 0 && (
        <div className="notice">
          No episodes yet — subscribe to some podcasts from the Search tab.
        </div>
      )}
    </div>
  );
}
