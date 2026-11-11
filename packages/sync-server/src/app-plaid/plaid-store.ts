import crypto from 'node:crypto';
import { join, resolve } from 'node:path';

import type { Plaid } from 'plaid';

import { openDatabase } from '#db';
import type { WrappedDatabase } from '#db';
import { config } from '#load-config';

/**
 * Server-side Plaid state (one row per Item). Access tokens are encrypted at
 * rest with PLAID_TOKEN_KEY, which lives in the server environment and not in
 * the data directory (so data-dir backups don't carry usable tokens).
 *
 * The transactions table is a local mirror of /transactions/sync: Actual asks
 * "everything for account X since date Y", so we keep what sync has told us
 * and answer from it.
 */

export type StoredAccount = Pick<
  Plaid.AccountBase,
  'account_id' | 'name' | 'mask' | 'type' | 'subtype'
> & { persistent_account_id?: string };

export type PlaidItemRow = {
  item_id: string;
  access_token: string;
  institution_id: string | null;
  institution_name: string | null;
  cursor: string | null;
  accounts: StoredAccount[];
  link_session_id: string | null;
};

type RawItemRow = Omit<PlaidItemRow, 'access_token' | 'accounts'> & {
  access_token_enc: string;
  accounts_json: string;
};

let db: WrappedDatabase | null = null;

function getDb(): WrappedDatabase {
  if (db) return db;
  const path = join(resolve(config.get('serverFiles')), 'plaid.sqlite');
  db = openDatabase(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS plaid_items (
      item_id TEXT PRIMARY KEY,
      access_token_enc TEXT NOT NULL,
      institution_id TEXT,
      institution_name TEXT,
      cursor TEXT,
      accounts_json TEXT NOT NULL DEFAULT '[]',
      link_session_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plaid_transactions (
      transaction_id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      date TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS plaid_transactions_account
      ON plaid_transactions (account_id, date);
  `);
  return db;
}

function getKey(): Buffer {
  const hex = process.env.PLAID_TOKEN_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'PLAID_TOKEN_KEY must be set to 64 hex characters (openssl rand -hex 32)',
    );
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data]
    .map(b => b.toString('base64'))
    .join('.');
}

function decrypt(enc: string): string {
  const [iv, tag, data] = enc.split('.').map(p => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    'utf8',
  );
}

function fromRaw(row: RawItemRow): PlaidItemRow {
  const { access_token_enc, accounts_json, ...rest } = row;
  return {
    ...rest,
    access_token: decrypt(access_token_enc),
    accounts: JSON.parse(accounts_json) as StoredAccount[],
  };
}

export function hasTokenKey(): boolean {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

export function listItems(): PlaidItemRow[] {
  return (
    getDb().all('SELECT * FROM plaid_items ORDER BY created_at') as RawItemRow[]
  ).map(fromRaw);
}

export function getItem(itemId: string): PlaidItemRow | null {
  const row = getDb().first('SELECT * FROM plaid_items WHERE item_id = ?', [
    itemId,
  ]) as RawItemRow | null;
  return row ? fromRaw(row) : null;
}

export function findItemByAccount(accountId: string): PlaidItemRow | null {
  return (
    listItems().find(item =>
      item.accounts.some(a => a.account_id === accountId),
    ) ?? null
  );
}

export function insertItem(item: Omit<PlaidItemRow, 'cursor'>): void {
  getDb().mutate(
    `INSERT INTO plaid_items
       (item_id, access_token_enc, institution_id, institution_name,
        accounts_json, link_session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      item.item_id,
      encrypt(item.access_token),
      item.institution_id,
      item.institution_name,
      JSON.stringify(item.accounts),
      item.link_session_id,
      new Date().toISOString(),
    ],
  );
}

export function updateItemAccounts(
  itemId: string,
  accounts: StoredAccount[],
): void {
  getDb().mutate('UPDATE plaid_items SET accounts_json = ? WHERE item_id = ?', [
    JSON.stringify(accounts),
    itemId,
  ]);
}

export function deleteItem(itemId: string): void {
  const d = getDb();
  d.transaction(() => {
    d.mutate('DELETE FROM plaid_transactions WHERE item_id = ?', [itemId]);
    d.mutate('DELETE FROM plaid_items WHERE item_id = ?', [itemId]);
  });
}

/**
 * Apply one complete /transactions/sync update (all pages) and its final
 * cursor in a single sqlite transaction, so a crash can never leave a cursor
 * that points past data we didn't store.
 */
export function applySync(
  itemId: string,
  update: {
    upserts: Plaid.Transaction[];
    removedIds: string[];
    nextCursor: string;
  },
): void {
  const d = getDb();
  d.transaction(() => {
    for (const id of update.removedIds) {
      d.mutate('DELETE FROM plaid_transactions WHERE transaction_id = ?', [id]);
    }
    for (const t of update.upserts) {
      d.mutate(
        `INSERT OR REPLACE INTO plaid_transactions
           (transaction_id, item_id, account_id, date, data)
         VALUES (?, ?, ?, ?, ?)`,
        [t.transaction_id, itemId, t.account_id, t.date, JSON.stringify(t)],
      );
    }
    d.mutate('UPDATE plaid_items SET cursor = ? WHERE item_id = ?', [
      update.nextCursor,
      itemId,
    ]);
  });
}

export function getTransactions(
  accountId: string,
  sinceDate: string,
): Plaid.Transaction[] {
  return (
    getDb().all(
      `SELECT data FROM plaid_transactions
       WHERE account_id = ? AND date >= ?
       ORDER BY date DESC`,
      [accountId, sinceDate],
    ) as { data: string }[]
  ).map(row => JSON.parse(row.data) as Plaid.Transaction);
}
