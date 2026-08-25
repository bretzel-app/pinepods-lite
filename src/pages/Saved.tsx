import { useActiveAccount } from '../lib/accounts';
import { getSavedEpisodes } from '../lib/api';
import { useCached } from '../lib/useCached';
import EpisodeRow from '../components/EpisodeRow';

export default function Saved() {
  const account = useActiveAccount();
  const saved = useCached(account.id, 'saved-episodes', () => getSavedEpisodes(account));

  return (
    <div>
      <h1 className="page-title">
        Saved
        {saved.refreshing && <span className="spinner" />}
      </h1>
      {saved.loading && !saved.data && <div className="notice">Loading saved episodes…</div>}
      {saved.error && !saved.data && (
        <div className="error-box">Couldn't load saved episodes: {saved.error.message}</div>
      )}
      {(saved.data ?? []).map((e) => (
        <EpisodeRow key={e.episodeid} episode={e} onChanged={saved.refresh} />
      ))}
      {saved.data?.length === 0 && (
        <div className="notice">Nothing saved yet. Tap the star on any episode.</div>
      )}
    </div>
  );
}
