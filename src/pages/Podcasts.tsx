import { Link } from 'react-router-dom';
import { useActiveAccount } from '../lib/accounts';
import { getSubscribedPodcasts } from '../lib/api';
import { useCached } from '../lib/useCached';

export default function Podcasts() {
  const account = useActiveAccount();
  const pods = useCached(account.id, 'podcasts', () => getSubscribedPodcasts(account));

  return (
    <div>
      <h1 className="page-title">
        Podcasts
        {pods.refreshing && <span className="spinner" />}
      </h1>
      {pods.loading && !pods.data && <div className="notice">Loading subscriptions…</div>}
      {pods.error && !pods.data && (
        <div className="error-box">Couldn't load podcasts: {pods.error.message}</div>
      )}
      <div className="pod-grid">
        {(pods.data ?? []).map((p) => (
          <Link className="pod-card" key={p.podcastid} to={`/podcasts/${p.podcastid}`}>
            {p.artworkurl ? <img src={p.artworkurl} alt="" loading="lazy" /> : <div />}
            <div className="name">{p.podcastname}</div>
          </Link>
        ))}
      </div>
      {pods.data?.length === 0 && (
        <div className="notice">No subscriptions yet. Find podcasts in the Search tab.</div>
      )}
    </div>
  );
}
