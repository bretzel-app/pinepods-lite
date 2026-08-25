import { useActiveAccount } from '../lib/accounts';
import { getRecentEpisodes, getUserHistory } from '../lib/api';
import { useCached } from '../lib/useCached';
import EpisodeRow from '../components/EpisodeRow';

export default function Home() {
  const account = useActiveAccount();

  const history = useCached(account.id, 'history', () => getUserHistory(account, 20));
  const recent = useCached(account.id, 'recent-episodes', async () => {
    const { episodes } = await getRecentEpisodes(account, 50);
    return episodes;
  });

  const inProgress = (history.data ?? [])
    .filter((e) => !e.completed && (e.listenduration ?? 0) > 30)
    .slice(0, 5);

  return (
    <div>
      <h1 className="page-title">
        Home
        {recent.refreshing && <span className="spinner" />}
      </h1>

      {inProgress.length > 0 && (
        <>
          <h2 style={{ fontSize: 15, margin: '4px 0' }}>Continue listening</h2>
          {inProgress.map((e) => (
            <EpisodeRow key={`h${e.episodeid}`} episode={e} />
          ))}
          <h2 style={{ fontSize: 15, margin: '18px 0 4px' }}>Latest episodes</h2>
        </>
      )}

      {recent.loading && !recent.data && (
        <div className="notice">Loading your feed…</div>
      )}
      {recent.error && !recent.data && (
        <div className="error-box">Couldn't load episodes: {recent.error.message}</div>
      )}
      {(recent.data ?? []).map((e) => (
        <EpisodeRow key={e.episodeid} episode={e} />
      ))}
      {recent.data?.length === 0 && (
        <div className="notice">
          No episodes yet — subscribe to some podcasts from the Search tab.
        </div>
      )}
    </div>
  );
}
