import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { PlaidClient, PlaidEnvironment, PlaidError } from 'plaid';
import type { Plaid } from 'plaid';

import { createMutex } from '#util/mutex';

import * as store from './plaid-store';
import type { PlaidItemRow, StoredAccount } from './plaid-store';

/**
 * Keys and environment come only from the server environment
 * (PLAID_CLIENT_ID / PLAID_SECRET / PLAID_ENV). PLAID_ENV also picks the API
 * base URL, so keys and environment can never disagree.
 */
type PlaidEnvName = 'sandbox' | 'production';

// Local dev convenience: `plaid keys write --env sandbox` puts keys in
// packages/sync-server/.env (the dev server's cwd). Production gets real env
// vars from the container instead (docker --env-file).
if (process.env.NODE_ENV === 'development') {
  const devEnv = resolve(process.cwd(), '.env');
  if (existsSync(devEnv)) process.loadEnvFile(devEnv);
}

function getEnvName(): PlaidEnvName | null {
  const env = (process.env.PLAID_ENV ?? 'sandbox').toLowerCase();
  return env === 'sandbox' || env === 'production' ? env : null;
}

export function isConfigured(): boolean {
  return Boolean(
    process.env.PLAID_CLIENT_ID &&
    process.env.PLAID_SECRET &&
    getEnvName() &&
    store.hasTokenKey(),
  );
}

export function getEnv(): PlaidEnvName | null {
  return getEnvName();
}

let client: PlaidClient | null = null;

export function getClient(): PlaidClient {
  if (client) return client;
  const env = getEnvName();
  if (!isConfigured() || !env) {
    throw new PlaidNotConfiguredError();
  }
  client = new PlaidClient({
    environment:
      env === 'production'
        ? PlaidEnvironment.Production
        : PlaidEnvironment.Sandbox,
    clientId: process.env.PLAID_CLIENT_ID,
    secret: process.env.PLAID_SECRET,
    // exponential backoff with jitter on 408/429/5xx
    maxRetries: 3,
    timeoutInSeconds: 120,
  });
  return client;
}

export class PlaidNotConfiguredError extends Error {
  constructor() {
    super('Plaid is not configured on the server');
  }
}

export type NormalizedPlaidError = {
  error_type: string;
  error_code: string;
  reason: string;
  request_id?: string;
};

/**
 * Turn any thrown error into the {error_type, error_code} shape Actual's
 * bank-sync UI understands. Only Plaid's error body is read - never the
 * request config, which carries the secret.
 */
export function normalizeError(err: unknown): NormalizedPlaidError {
  if (err instanceof PlaidNotConfiguredError) {
    return {
      error_type: 'PLAID_NOT_CONFIGURED',
      error_code: 'PLAID_NOT_CONFIGURED',
      reason: err.message,
    };
  }
  if (err instanceof PlaidError) {
    const body = (err.body ?? {}) as Partial<Plaid.PlaidError>;
    return {
      error_type: body.error_type ?? 'API_ERROR',
      error_code: body.error_code ?? 'INTERNAL_SERVER_ERROR',
      reason:
        body.display_message ??
        body.error_message ??
        'Plaid request failed. Please try again.',
      request_id: body.request_id ?? err.requestId,
    };
  }
  return {
    error_type: 'API_ERROR',
    error_code: 'INTERNAL_SERVER_ERROR',
    reason: err instanceof Error ? err.message : String(err),
  };
}

export function logPlaidError(context: string, err: NormalizedPlaidError) {
  // request_id is what Plaid support needs; tokens are never logged
  console.log(
    `Plaid ${context} failed: ${err.error_type}/${err.error_code}` +
      (err.request_id ? ` (request_id ${err.request_id})` : ''),
  );
}

export function toStoredAccounts(
  accounts: Plaid.AccountBase[],
): StoredAccount[] {
  return accounts.map(a => ({
    account_id: a.account_id,
    name: a.name,
    mask: a.mask,
    type: a.type,
    subtype: a.subtype,
    persistent_account_id: a.persistent_account_id,
  }));
}

/**
 * /accounts/get is the authoritative account list and balance source (free;
 * not the billed real-time Balance product). account_ids can change, so the
 * stored copy is refreshed every time.
 */
export async function getAccounts(
  item: PlaidItemRow,
): Promise<Plaid.AccountBase[]> {
  const res = await getClient().accounts.get({
    access_token: item.access_token,
  });
  store.updateItemAccounts(item.item_id, toStoredAccounts(res.accounts));
  return res.accounts;
}

const syncLocks = new Map<string, ReturnType<typeof createMutex>>();

function lockFor(itemId: string) {
  let lock = syncLocks.get(itemId);
  if (!lock) {
    lock = createMutex();
    syncLocks.set(itemId, lock);
  }
  return lock;
}

/**
 * Pull every pending update for an Item with /transactions/sync.
 *
 * All pages are buffered and written together with the final cursor. If
 * Plaid reports TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION the whole loop
 * restarts from the cursor it started with. Calls are serialized per Item.
 */
export function syncItem(
  item: PlaidItemRow,
): Promise<Plaid.TransactionsUpdateStatus> {
  return lockFor(item.item_id)(async () => {
    const fresh = store.getItem(item.item_id) ?? item;
    const startCursor = fresh.cursor ?? '';

    for (let attempt = 0; attempt < 3; attempt++) {
      const upserts = new Map<string, Plaid.Transaction>();
      const removed = new Set<string>();
      let cursor = startCursor;
      let status: Plaid.TransactionsUpdateStatus =
        'TRANSACTIONS_UPDATE_STATUS_UNKNOWN';

      try {
        let hasMore = true;
        while (hasMore) {
          const res = await getClient().transactions.sync(
            {
              access_token: fresh.access_token,
              cursor: cursor || undefined,
              count: 500,
              options: { include_original_description: true },
            },
            // the first sync after the historical pull can be much slower
            { timeoutInSeconds: 300 },
          );
          for (const t of [...res.added, ...res.modified]) {
            removed.delete(t.transaction_id);
            upserts.set(t.transaction_id, t);
          }
          for (const r of res.removed) {
            if (r.transaction_id) {
              upserts.delete(r.transaction_id);
              removed.add(r.transaction_id);
            }
          }
          cursor = res.next_cursor;
          hasMore = res.has_more;
          status = res.transactions_update_status;
        }
      } catch (err) {
        const n = normalizeError(err);
        if (n.error_code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') {
          continue;
        }
        throw err;
      }

      store.applySync(fresh.item_id, {
        upserts: [...upserts.values()],
        removedIds: [...removed],
        nextCursor: cursor,
      });
      return status;
    }

    throw new Error('Transactions changed repeatedly during sync; try again');
  });
}

/**
 * Remove an Item at Plaid (ends billing) and locally. ITEM_NOT_FOUND means
 * it's already gone at Plaid, so only the local row is purged.
 */
export async function removeItem(item: PlaidItemRow): Promise<void> {
  try {
    await getClient().item.remove({ access_token: item.access_token });
  } catch (err) {
    const n = normalizeError(err);
    if (n.error_code !== 'ITEM_NOT_FOUND') throw err;
  }
  store.deleteItem(item.item_id);
}
