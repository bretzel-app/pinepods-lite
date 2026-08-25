import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAccounts } from './lib/accounts';
import { installSyncTriggers } from './lib/sync';
import Layout from './components/Layout';
import Login from './pages/Login';
import Home from './pages/Home';
import Podcasts from './pages/Podcasts';
import PodcastDetail from './pages/PodcastDetail';
import Search from './pages/Search';
import Saved from './pages/Saved';
import Downloads from './pages/Downloads';
import Accounts from './pages/Accounts';

export default function App() {
  const { active, ready } = useAccounts();

  // Replay queued offline mutations whenever we come back online.
  useEffect(() => {
    const activeRef = { current: active };
    activeRef.current = active;
    return installSyncTriggers(() => activeRef.current);
  }, [active]);

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
        <Route path="/search" element={<Search />} />
        <Route path="/saved" element={<Saved />} />
        <Route path="/downloads" element={<Downloads />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
