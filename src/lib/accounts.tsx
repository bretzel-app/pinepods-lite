import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Account } from './types';
import { listAccounts, putAccount, removeAccount as dbRemoveAccount } from './db';
import { getUserDetails, login } from './api';

const ACTIVE_KEY = 'pinepods.activeAccountId';

interface AccountsContextValue {
  /** All known accounts, oldest first. */
  accounts: Account[];
  /** The account everything currently renders for; null = logged out. */
  active: Account | null;
  /** True until the account list has been loaded from IndexedDB. */
  ready: boolean;
  addAccount: (serverUrl: string, username: string, password: string) => Promise<Account>;
  switchAccount: (id: string) => void;
  removeAccount: (id: string) => Promise<void>;
}

const AccountsContext = createContext<AccountsContextValue | null>(null);

export function AccountsProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() =>
    localStorage.getItem(ACTIVE_KEY),
  );
  const [ready, setReady] = useState(false);

  useEffect(() => {
    listAccounts().then((list) => {
      setAccounts(list);
      setReady(true);
    });
  }, []);

  const addAccount = useCallback(
    async (serverUrl: string, username: string, password: string): Promise<Account> => {
      const result = await login(serverUrl, username, password);
      if (result.mfaRequired) {
        throw new Error(
          'This account has MFA enabled, which this client does not support yet. ' +
            'Create an API-key-only login or disable MFA for this user.',
        );
      }
      let details = { username, fullname: username };
      try {
        details = await getUserDetails(result, result.userId);
      } catch {
        // Non-fatal: some servers restrict this endpoint; fall back to the typed username.
      }
      const existing = accounts.find(
        (a) => a.serverUrl === result.serverUrl && a.userId === result.userId,
      );
      const account: Account = {
        id: existing?.id ?? crypto.randomUUID(),
        serverUrl: result.serverUrl,
        apiKey: result.apiKey,
        userId: result.userId,
        username: details.username || username,
        fullname: details.fullname || username,
        addedAt: existing?.addedAt ?? Date.now(),
      };
      await putAccount(account);
      setAccounts((prev) => {
        const rest = prev.filter((a) => a.id !== account.id);
        return [...rest, account].sort((a, b) => a.addedAt - b.addedAt);
      });
      localStorage.setItem(ACTIVE_KEY, account.id);
      setActiveId(account.id);
      return account;
    },
    [accounts],
  );

  const switchAccount = useCallback((id: string) => {
    localStorage.setItem(ACTIVE_KEY, id);
    setActiveId(id);
  }, []);

  const removeAccount = useCallback(
    async (id: string) => {
      await dbRemoveAccount(id);
      setAccounts((prev) => {
        const next = prev.filter((a) => a.id !== id);
        if (localStorage.getItem(ACTIVE_KEY) === id) {
          const fallback = next[0]?.id ?? null;
          if (fallback) localStorage.setItem(ACTIVE_KEY, fallback);
          else localStorage.removeItem(ACTIVE_KEY);
          setActiveId(fallback);
        }
        return next;
      });
    },
    [],
  );

  const active = useMemo(
    () => accounts.find((a) => a.id === activeId) ?? (accounts.length ? accounts[0] : null),
    [accounts, activeId],
  );

  const value = useMemo(
    () => ({ accounts, active, ready, addAccount, switchAccount, removeAccount }),
    [accounts, active, ready, addAccount, switchAccount, removeAccount],
  );

  return <AccountsContext.Provider value={value}>{children}</AccountsContext.Provider>;
}

export function useAccounts(): AccountsContextValue {
  const ctx = useContext(AccountsContext);
  if (!ctx) throw new Error('useAccounts must be used inside AccountsProvider');
  return ctx;
}

/** Like useAccounts().active but non-null; only for routes behind the auth gate. */
export function useActiveAccount(): Account {
  const { active } = useAccounts();
  if (!active) throw new Error('No active account');
  return active;
}
