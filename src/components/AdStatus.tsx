import { useEffect, useState } from 'react';
import type { Account, DownloadEntry, Episode } from '../lib/types';
import { adInfoKey, refreshAdInfo } from '../lib/adInfo';
import { adStatus, adStatusLabel } from '../lib/adSkips';
import { getDownload } from '../lib/db';
import { resolveSource } from '../player/resume';
import { useCached } from '../lib/useCached';

interface Props {
  account: Account;
  episode: Episode;
  localDownload?: DownloadEntry;
  compact: boolean;
}

/** Transcription / ad detection status of a starred episode. Parents render it only when saved. */
export default function AdStatus({ account, episode, localDownload, compact }: Props) {
  const id = episode.episodeid;
  const info = useCached(account.id, adInfoKey(id), () => refreshAdInfo(account, id));
  const [loaded, setLoaded] = useState<DownloadEntry | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    if (localDownload) return;
    void getDownload(account.id, id).then((d) => {
      if (!cancelled) setLoaded(d);
    });
    return () => {
      cancelled = true;
    };
  }, [account.id, id, localDownload]);
  const download = localDownload ?? loaded;
  const status = adStatus(
    `${account.id}:${id}`,
    { ...episode, saved: true },
    info.data,
    resolveSource(account, episode, download),
    download,
  );
  if (!status) return null;
  return <span className={`ad-status ad-status--${status.kind}`}>{adStatusLabel(status, compact)}</span>;
}
