import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import PlayerBar from '../player/PlayerBar';
import {
  CloudOffIcon,
  DownloadIcon,
  GridIcon,
  HomeIcon,
  SearchIcon,
  StarIcon,
  UserIcon,
} from './icons';

const links = [
  { to: '/', label: 'Home', icon: HomeIcon, end: true },
  { to: '/podcasts', label: 'Podcasts', icon: GridIcon },
  { to: '/search', label: 'Search', icon: SearchIcon },
  { to: '/saved', label: 'Saved', icon: StarIcon },
  { to: '/downloads', label: 'Downloads', icon: DownloadIcon },
  { to: '/accounts', label: 'Accounts', icon: UserIcon },
];

export function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

export default function Layout() {
  const online = useOnline();

  const nav = links.map(({ to, label, icon: Icon, end }) => (
    <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')}>
      <Icon />
      <span>{label}</span>
    </NavLink>
  ));

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">PinePods</div>
        {nav}
      </nav>
      <main className="content">
        {!online && (
          <div className="offline-banner">
            <CloudOffIcon /> Offline — showing cached data. Changes will sync when you reconnect.
          </div>
        )}
        <Outlet />
      </main>
      <PlayerBar />
      <nav className="bottom-nav">{nav}</nav>
    </div>
  );
}
