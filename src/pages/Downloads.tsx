import { useEffect, useState } from 'react';
import { useActiveAccount } from '../lib/accounts';
import { listDownloads } from '../lib/db';
import { subscribeDownloads } from '../lib/downloads';
import type { DownloadEntry } from '../lib/types';
import { formatBytes } from '../lib/format';
import EpisodeRow from '../components/EpisodeRow';

export default function Downloads() {
  const account = useActiveAccount();
  const [entries, setEntries] = useState<DownloadEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      listDownloads(account.id).then((rows) => {
        if (!cancelled) setEntries(rows);
      });
    load();
    const unsub = subscribeDownloads(load);
    return () => {
      cancelled = true;
      unsub();
    };
  }, [account.id]);

  const totalSize = (entries ?? []).reduce((sum, e) => sum + e.size, 0);

  return (
    <div>
      <h1 className="page-title">Downloads</h1>
      {entries && entries.length > 0 && (
        <div className="notice">
          {entries.length} episode{entries.length === 1 ? '' : 's'} · {formatBytes(totalSize)} on
          this device
        </div>
      )}
      {entries?.length === 0 && (
        <div className="notice">
          No downloads yet. Use the download button on any episode to keep it for offline
          listening.
        </div>
      )}
      {(entries ?? []).map((d) => (
        <EpisodeRow key={d.key} episode={d.episode} />
      ))}
    </div>
  );
}
