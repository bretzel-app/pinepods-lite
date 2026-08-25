import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { AccountsProvider } from './lib/accounts';
import { PlayerProvider } from './player/PlayerContext';
import './styles.css';

registerSW({ immediate: true });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AccountsProvider>
        <PlayerProvider>
          <App />
        </PlayerProvider>
      </AccountsProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
