import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccounts } from '../lib/accounts';

export default function Login() {
  const { addAccount, accounts } = useAccounts();
  const navigate = useNavigate();
  const [serverUrl, setServerUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await addAccount(serverUrl, username, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="login-card" onSubmit={onSubmit}>
      <h1>{accounts.length ? 'Add account' : 'PinePods'}</h1>
      <div className="muted" style={{ fontSize: 13.5 }}>
        Connect to a PinePods server. Your API key is stored on this device only.
      </div>
      <div className="field">
        <label htmlFor="server">Server URL</label>
        <input
          id="server"
          type="text"
          placeholder="https://pods.example.com"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          required
          autoCapitalize="off"
          autoCorrect="off"
        />
      </div>
      <div className="field">
        <label htmlFor="username">Username</label>
        <input
          id="username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          autoCapitalize="off"
          autoComplete="username"
        />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
        />
      </div>
      {error && <div className="error-box">{error}</div>}
      <button className="btn" type="submit" disabled={busy}>
        {busy ? 'Connecting…' : 'Sign in'}
      </button>
      {accounts.length > 0 && (
        <button type="button" className="btn secondary" onClick={() => navigate(-1)}>
          Cancel
        </button>
      )}
    </form>
  );
}
