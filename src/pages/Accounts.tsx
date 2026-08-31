import { useNavigate } from 'react-router-dom';
import { useAccounts } from '../lib/accounts';
import { CheckIcon, PlusIcon, SwapIcon, TrashIcon } from '../components/icons';
import { ThemeToggle } from '../components/ThemeToggle';

export default function Accounts() {
  const { accounts, active, switchAccount, removeAccount } = useAccounts();
  const navigate = useNavigate();

  const onRemove = async (id: string, label: string) => {
    if (
      !confirm(
        `Remove account “${label}” from this device? Its cached data and downloads here will be deleted. Nothing changes on the server.`,
      )
    )
      return;
    await removeAccount(id);
  };

  return (
    <div>
      <h1 className="page-title">Accounts</h1>
      <div className="settings-section">
        <div className="list-toolbar" style={{ margin: 0 }}>
          <h2>Appearance</h2>
          <ThemeToggle />
        </div>
      </div>
      {accounts.map((a) => {
        const isActive = a.id === active?.id;
        return (
          <div className={`account-row${isActive ? ' active-account' : ''}`} key={a.id}>
            <div className="avatar">{(a.fullname || a.username).slice(0, 1).toUpperCase()}</div>
            <div
              className="account-main"
              style={{ cursor: isActive ? 'default' : 'pointer' }}
              onClick={() => !isActive && switchAccount(a.id)}
            >
              <div className="name">
                {a.fullname || a.username}
                {isActive && (
                  <span className="pill offline" style={{ marginLeft: 8 }}>
                    <CheckIcon /> active
                  </span>
                )}
              </div>
              <div className="server">
                {a.username} @ {a.serverUrl.replace(/^https?:\/\//, '')}
              </div>
            </div>
            {!isActive && (
              <button className="btn secondary" onClick={() => switchAccount(a.id)}>
                Switch
              </button>
            )}
            <button
              className="icon-btn"
              title="Remove from this device"
              onClick={() => onRemove(a.id, a.username)}
            >
              <TrashIcon />
            </button>
          </div>
        );
      })}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button className="btn secondary" onClick={() => navigate('/login')}>
          <PlusIcon /> Add account
        </button>
        {accounts.length > 1 && (
          <button className="btn secondary" onClick={() => navigate('/transfer')}>
            <SwapIcon /> Transfer podcasts…
          </button>
        )}
      </div>
      <p className="notice" style={{ marginTop: 16 }}>
        Each account keeps its own cache, playback positions and offline downloads. Switching is
        instant and works offline.
      </p>
    </div>
  );
}
