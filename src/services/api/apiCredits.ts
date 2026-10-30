/**
 * Monthly API-credit estimates from the box-local `cliproxy-api-credits` collector,
 * fetched through the gateway's /api-call so the panel needs no route to it.
 * Spend is counted from proxy traffic at list price; Console > Billing holds the
 * exact balance.
 */

import { apiCallApi } from './apiCall';
import { isRecord } from '@/utils/helpers';

const CREDITS_URL = 'http://127.0.0.1:8318/credits';

export interface ApiCreditAccount {
  name: string;
  email: string;
  org: string;
  cycleEnd: string;
  allowanceUsd: number;
  spentUsd: number;
  remainingUsd: number;
  requests: number;
  failedRequests: number;
  lastError: string | null;
}

const isAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const parseAccount = (raw: unknown): ApiCreditAccount | null => {
  if (!isRecord(raw)) return null;
  const { name, email, org, cycle_end, allowance_usd, spent_usd, remaining_usd } = raw;
  const { requests, failed_requests, last_error } = raw;
  if (
    typeof name !== 'string' ||
    typeof email !== 'string' ||
    typeof org !== 'string' ||
    typeof cycle_end !== 'string' ||
    !isAmount(allowance_usd) ||
    !isAmount(spent_usd) ||
    !isAmount(remaining_usd) ||
    !isAmount(requests) ||
    !isAmount(failed_requests)
  ) {
    return null;
  }
  return {
    name,
    email,
    org,
    cycleEnd: cycle_end,
    allowanceUsd: allowance_usd,
    spentUsd: spent_usd,
    remainingUsd: remaining_usd,
    requests,
    failedRequests: failed_requests,
    lastError: typeof last_error === 'string' ? last_error : null,
  };
};

export const apiCreditsApi = {
  /** Null when the collector isn't running beside this gateway. */
  fetch: async (): Promise<ApiCreditAccount[] | null> => {
    const result = await apiCallApi.request({ method: 'GET', url: CREDITS_URL });
    if (result.statusCode !== 200 || !isRecord(result.body)) return null;
    const accounts = result.body.accounts;
    if (!Array.isArray(accounts)) return null;
    return accounts.map(parseAccount).filter((account) => account !== null);
  },
};
