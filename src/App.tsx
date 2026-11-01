import { useEffect, useRef } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAccounts } from './lib/accounts';
import { installSyncTriggers } from './lib/sync';
import { recoverDownloads, resumeDownloads, sweepCompletedDownloads } from './lib/downloads';
import Layout from './components/Layout';
import Login from './pages/Login';
import Home from './pages/Home';
import Podcasts from './pages/Podcasts';
import PodcastDetail from './pages/PodcastDetail';
import EpisodeDetail from './pages/EpisodeDetail';
import Search from './pages/Search';
import PodcastPreview from './pages/PodcastPreview';
import Saved from './pages/Saved';
import Downloads from './pages/Downloads';
import Accounts from './pages/Accounts';
import Transfer from './pages/Transfer';

export default function App() {
  const { accounts, active, ready } = useAccounts();
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;

  // Replay queued offline mutations whenever we come back online.
  useEffect(() => {
    const activeRef = { current: active };
    activeRef.current = active;
    return installSyncTriggers(() => activeRef.current);
  }, [active]);

  // Once per account per session: drop local downloads the server says are
  // completed (finished on another device).
  const sweptRef = useRef(new Set<string>());
  useEffect(() => {
    if (!active || sweptRef.current.has(active.id)) return;
    sweptRef.current.add(active.id);
    void recoverDownloads()
      .catch(() => {})
      .then(() => sweepCompletedDownloads(active));
  }, [active]);

  // Native downloads still running with nothing following them (started
  // before the app was restarted, or whose poller stopped): follow them
  // again, so their progress shows and they get stored. On launch and on
  // every return to the foreground; the browser has none.
  useEffect(() => {
    if (!ready) return;
    const follow = () => void resumeDownloads(accountsRef.current).catch(() => {});
    follow();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') follow();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [ready]);

  if (!ready) return null;

  if (!active) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/podcasts" element={<Podcasts />} />
        <Route path="/podcasts/:podcastId" element={<PodcastDetail />} />
        <Route path="/episodes/:episodeId" element={<EpisodeDetail />} />
        <Route path="/search" element={<Search />} />
        <Route path="/preview" element={<PodcastPreview />} />
        <Route path="/saved" element={<Saved />} />
        <Route path="/downloads" element={<Downloads />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/transfer" element={<Transfer />} />
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
