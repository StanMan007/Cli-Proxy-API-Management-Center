import { useEffect, useState } from 'react';
import { apiCreditsApi, type ApiCreditAccount } from '@/services/api';
import { useAuthStore } from '@/stores';

/**
 * Each Ultra account's monthly API-credit estimate, keyed by lowercased email so the
 * overview can match it to that account's Claude row. Empty when the collector isn't running.
 */
export function useApiCredits(): ReadonlyMap<string, ApiCreditAccount> {
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [accounts, setAccounts] = useState<ReadonlyMap<string, ApiCreditAccount>>(new Map());

  useEffect(() => {
    if (!connected) return;
    let current = true;
    apiCreditsApi.fetch().then(
      (next) =>
        current &&
        setAccounts(new Map((next ?? []).map((account) => [account.email.toLowerCase(), account]))),
      () => current && setAccounts(new Map())
    );
    return () => {
      current = false;
    };
  }, [connected]);

  return accounts;
}
