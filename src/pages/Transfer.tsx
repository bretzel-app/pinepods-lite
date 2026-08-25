import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAccounts, useActiveAccount } from '../lib/accounts';
import { getSubscribedPodcasts } from '../lib/api';
import { useCached } from '../lib/useCached';
import { transferPodcast, refreshSubscriptionCaches, type TransferResult } from '../lib/transfer';
import { useOnline } from '../components/Layout';
import { CheckIcon } from '../components/icons';

type Phase = 'select' | 'running' | 'done';

export default function Transfer() {
  const { accounts } = useAccounts();
  const source = useActiveAccount();
  const navigate = useNavigate();
  const online = useOnline();
  const targets = accounts.filter((a) => a.id !== source.id);

  const pods = useCached(source.id, 'podcasts', () => getSubscribedPodcasts(source));
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [targetId, setTargetId] = useState<string>(targets[0]?.id ?? '');
  const [removeAfter, setRemoveAfter] = useState(false);
  const [phase, setPhase] = useState<Phase>('select');
  const [progress, setProgress] = useState('');
  const [results, setResults] = useState<TransferResult[]>([]);

  if (targets.length === 0) return <Navigate to="/accounts" replace />;

  const selectable = (pods.data ?? []).filter((p) => !p.is_video);
  const target = accounts.find((a) => a.id === targetId) ?? targets[0];

  const toggle = (podcastId: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(podcastId)) next.delete(podcastId);
      else next.add(podcastId);
      return next;
    });
  };

  const run = async () => {
    setPhase('running');
    const out: TransferResult[] = [];
    for (const pod of selectable.filter((p) => selected.has(p.podcastid))) {
      out.push(await transferPodcast(source, target, pod, removeAfter, setProgress));
      setResults([...out]);
    }
    await refreshSubscriptionCaches(source, target);
    setResults(out);
    setPhase('done');
  };

  if (phase === 'running' || phase === 'done') {
    return (
      <div>
        <h1 className="page-title">
          {phase === 'running' ? 'Transferring…' : 'Transfer complete'}
          {phase === 'running' && <span className="spinner" />}
        </h1>
        {phase === 'running' && <div className="notice">{progress}</div>}
        {results.map((r) => (
          <div className="account-row" key={r.podcastName}>
            <div className="account-main">
              <div className="name">
                {r.podcastName}
                {r.status === 'error' && (
                  <span className="pill" style={{ marginLeft: 8, color: 'var(--danger)' }}>
                    failed
                  </span>
                )}
              </div>
              <div className="server">
                {r.status === 'error'
                  ? r.error
                  : `${r.copiedPositions} positions, ${r.copiedCompleted} completed, ` +
                    `${r.copiedSaved} saved copied` +
                    (r.skippedHistory > 0
                      ? ` — ${r.skippedHistory} history entries had no matching episode and were kept on the source`
                      : '') +
                    (r.removedFromSource ? ' — removed from source' : '')}
              </div>
            </div>
          </div>
        ))}
        {phase === 'done' && (
          <button className="btn" onClick={() => navigate('/accounts')}>
            Done
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <h1 className="page-title">Transfer podcasts</h1>
      <p className="notice" style={{ marginTop: -6 }}>
        Copies subscriptions and listening activity (positions, played flags, saved episodes) from{' '}
        <strong>{source.username}</strong> to another account. Listen dates aren't preserved —
        history will show as of today on the target account.
      </p>

      {!online && <div className="error-box">Transferring needs a connection.</div>}

      <div className="field" style={{ maxWidth: 420, marginBottom: 14 }}>
        <label htmlFor="target">Transfer to</label>
        <select id="target" value={target?.id} onChange={(e) => setTargetId(e.target.value)}>
          {targets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.fullname || a.username} — {a.serverUrl.replace(/^https?:\/\//, '')}
            </option>
          ))}
        </select>
      </div>

      {pods.loading && !pods.data && <div className="notice">Loading subscriptions…</div>}
      {selectable.map((p) => (
        <label className="account-row" key={p.podcastid} style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={selected.has(p.podcastid)}
            onChange={() => toggle(p.podcastid)}
          />
          {p.artworkurl ? (
            <img src={p.artworkurl} alt="" style={{ width: 40, height: 40, borderRadius: 8 }} />
          ) : (
            <div className="avatar" style={{ borderRadius: 8 }} />
          )}
          <div className="account-main">
            <div className="name">{p.podcastname}</div>
            <div className="server">{p.episodecount ?? '?'} episodes</div>
          </div>
        </label>
      ))}
      {selectable.length === 0 && !pods.loading && (
        <div className="notice">No subscriptions to transfer.</div>
      )}

      <label
        style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0', fontSize: 13.5 }}
      >
        <input
          type="checkbox"
          checked={removeAfter}
          onChange={(e) => setRemoveAfter(e.target.checked)}
        />
        Remove from {source.username}'s account after a fully successful copy
      </label>

      <div style={{ display: 'flex', gap: 10 }}>
        <button className="btn" onClick={run} disabled={selected.size === 0 || !online}>
          <CheckIcon />
          Transfer {selected.size || ''} podcast{selected.size === 1 ? '' : 's'}
        </button>
        <button className="btn secondary" onClick={() => navigate('/accounts')}>
          Cancel
        </button>
      </div>
    </div>
  );
}
