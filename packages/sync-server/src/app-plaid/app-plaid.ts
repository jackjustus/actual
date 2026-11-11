import crypto from 'node:crypto';

import express from 'express';
import type { Plaid } from 'plaid';

import { handleError } from '#app-gocardless/util/handle-error';
import {
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from '#util/middlewares';

import { renderLinkPage } from './link-page';
import * as plaid from './plaid-service';
import type { NormalizedPlaidError } from './plaid-service';
import * as store from './plaid-store';
import type { PlaidItemRow } from './plaid-store';

/**
 * Plaid bank sync for this fork. Personal-use design:
 *  - keys come from the server env (see plaid-service.ts)
 *  - no webhooks: the server isn't publicly reachable, so data is pulled with
 *    /transactions/sync whenever Actual syncs an account
 *  - Link runs on a page served from here (see link-page.ts)
 */

const app = express();
export { app as handlers };
app.use(express.json());
app.use(requestLoggerMiddleware);

type LinkSessionStatus =
  | 'pending'
  | 'importing'
  | 'complete'
  | 'exited'
  | 'error';

type LinkSession = {
  id: string;
  linkToken: string;
  mode: 'create' | 'update';
  itemId?: string;
  institutionName?: string | null;
  expiresAt: number;
  status: LinkSessionStatus;
  duplicate?: boolean;
  error?: NormalizedPlaidError | null;
  linkSessionId?: string;
};

const sessions = new Map<string, LinkSession>();

function getSession(id: string): LinkSession | null {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(key);
  }
  return sessions.get(id) ?? null;
}

function sendError(res: express.Response, err: unknown, context: string) {
  const n = plaid.normalizeError(err);
  plaid.logPlaidError(context, n);
  res.send({ status: 'ok', data: n });
}

// How long to wait at link time for Plaid's historical pull before telling
// Actual the bank is ready. Without webhooks this is a bounded wait with
// backoff, only right after linking - never a standing poll.
const HISTORY_WAIT_MS = 5 * 60 * 1000;

async function importHistory(session: LinkSession, item: PlaidItemRow) {
  const deadline = Date.now() + HISTORY_WAIT_MS;
  let delay = 2000;
  try {
    for (;;) {
      const status = await plaid.syncItem(item);
      if (status === 'HISTORICAL_UPDATE_COMPLETE' || Date.now() > deadline) {
        break;
      }
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30000);
    }
    session.status = 'complete';
  } catch (err) {
    const n = plaid.normalizeError(err);
    plaid.logPlaidError('history import', n);
    // PRODUCT_NOT_READY just means Plaid is still fetching; the next sync in
    // Actual will pick everything up.
    if (n.error_code === 'PRODUCT_NOT_READY') {
      session.status = 'complete';
    } else {
      session.status = 'error';
      session.error = n;
    }
  }
}

type LinkMetadata = {
  link_session_id?: string;
  institution?: { institution_id?: string; name?: string } | null;
  accounts?: { mask?: string | null; subtype?: string | null }[];
};

/**
 * Plaid never dedupes Items. Before exchanging, check whether every account
 * picked in Link already belongs to an Item at the same institution
 * (persistent_account_id isn't in Link metadata, so mask + subtype).
 */
function findDuplicateItem(metadata: LinkMetadata): PlaidItemRow | null {
  const institutionId = metadata.institution?.institution_id;
  const picked = metadata.accounts ?? [];
  if (!institutionId || picked.length === 0) return null;
  return (
    store
      .listItems()
      .find(
        item =>
          item.institution_id === institutionId &&
          picked.every(p =>
            item.accounts.some(
              a => a.mask === p.mask && (a.subtype ?? null) === p.subtype,
            ),
          ),
      ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Link page routes. No Actual session (the page runs in its own tab); the
// random session id authorizes them and dies with the link token.
// ---------------------------------------------------------------------------

app.get('/link/:sessionId', (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    res.status(404).send('This link has expired. Start again from Actual.');
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.type('html').send(
    renderLinkPage({
      linkToken: session.linkToken,
      mode: session.mode,
      institutionName: session.institutionName,
    }),
  );
});

app.post('/link/:sessionId/status', (req, res) => {
  const session = getSession(req.params.sessionId);
  res.send({
    status: 'ok',
    data: session
      ? {
          status: session.status,
          duplicate: session.duplicate,
          error: session.error,
        }
      : { status: 'expired' },
  });
});

app.post(
  '/link/:sessionId/complete',
  handleError(async (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) {
      res.status(404).send({ status: 'error', reason: 'expired' });
      return;
    }
    const { public_token: publicToken, metadata = {} } = (req.body ?? {}) as {
      public_token?: string;
      metadata?: LinkMetadata;
    };
    session.linkSessionId = metadata.link_session_id;
    console.log(
      `Plaid Link success (link_session_id ${metadata.link_session_id ?? 'n/a'}, ` +
        `institution ${metadata.institution?.institution_id ?? 'n/a'})`,
    );

    if (session.mode === 'update' && session.itemId) {
      // Update mode: the existing access_token keeps working. Do NOT
      // exchange the public_token again.
      const item = store.getItem(session.itemId);
      session.status = 'importing';
      res.send({ status: 'ok', data: { status: session.status } });
      if (item) {
        try {
          await plaid.getAccounts(item);
        } catch {
          // surfaced by importHistory below if it persists
        }
        await importHistory(session, item);
      } else {
        session.status = 'complete';
      }
      return;
    }

    const duplicate = findDuplicateItem(metadata);
    if (duplicate) {
      session.status = 'complete';
      session.duplicate = true;
      res.send({ status: 'ok', data: { status: session.status } });
      return;
    }

    if (!publicToken) {
      res.status(400).send({ status: 'error', reason: 'missing-token' });
      return;
    }

    let item: PlaidItemRow;
    try {
      // public_token is single-use and short-lived: exchange right away and
      // persist before answering.
      const exchanged = await plaid.getClient().item.exchangePublicToken({
        public_token: publicToken,
      });
      item = {
        item_id: exchanged.item_id,
        access_token: exchanged.access_token,
        institution_id: metadata.institution?.institution_id ?? null,
        institution_name: metadata.institution?.name ?? null,
        accounts: [],
        cursor: null,
        link_session_id: metadata.link_session_id ?? null,
      };
      store.insertItem(item);
      await plaid.getAccounts(item);
    } catch (err) {
      const n = plaid.normalizeError(err);
      plaid.logPlaidError('public token exchange', n);
      session.status = 'error';
      session.error = n;
      res.send({ status: 'ok', data: { status: session.status } });
      return;
    }

    session.status = 'importing';
    res.send({ status: 'ok', data: { status: session.status } });
    // Sync once at link time and wait (bounded) for the history pull.
    await importHistory(session, item);
  }),
);

app.post('/link/:sessionId/exit', (req, res) => {
  const session = getSession(req.params.sessionId);
  const { error, metadata = {} } = (req.body ?? {}) as {
    error?: { error_type?: string; error_code?: string } | null;
    metadata?: LinkMetadata & { request_id?: string };
  };
  console.log(
    `Plaid Link exit (link_session_id ${metadata.link_session_id ?? 'n/a'}` +
      (error ? `, ${error.error_type}/${error.error_code}` : ', abandoned') +
      ')',
  );
  // Only an exit before success ends the session; Link's success screen can
  // also fire onExit later.
  if (session && session.status === 'pending') {
    session.status = 'exited';
    session.linkSessionId = metadata.link_session_id;
    session.error = error
      ? {
          error_type: error.error_type ?? 'LINK_ERROR',
          error_code: error.error_code ?? 'LINK_ERROR',
          reason: 'Plaid Link exited with an error',
        }
      : null;
  }
  res.send({ status: 'ok' });
});

app.post('/link/:sessionId/event', (req, res) => {
  const e = (req.body ?? {}) as Record<string, string | undefined>;
  // Funnel events (OPEN, SELECT_INSTITUTION, OPEN_OAUTH, HANDOFF, EXIT, ...)
  if (getSession(req.params.sessionId) && e.eventName) {
    console.log(
      `Plaid Link event ${e.eventName}` +
        ` (link_session_id ${e.link_session_id ?? 'n/a'}` +
        (e.institution_id ? `, institution ${e.institution_id}` : '') +
        (e.view_name ? `, view ${e.view_name}` : '') +
        (e.error_code ? `, ${e.error_type}/${e.error_code}` : '') +
        ')',
    );
  }
  res.send({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// Routes for Actual (require a signed-in Actual session).
// ---------------------------------------------------------------------------

app.use(validateSessionMiddleware);

app.post('/status', (_req, res) => {
  res.send({
    status: 'ok',
    data: { configured: plaid.isConfigured(), env: plaid.getEnv() },
  });
});

app.post(
  '/link-session',
  handleError(async (req, res) => {
    const { itemId, accountId } = (req.body ?? {}) as {
      itemId?: string;
      accountId?: string;
    };
    const existing = itemId
      ? store.getItem(itemId)
      : accountId
        ? store.findItemByAccount(accountId)
        : null;
    if ((itemId || accountId) && !existing) {
      res.send({
        status: 'ok',
        data: {
          error_type: 'ITEM_ERROR',
          error_code: 'ITEM_NOT_FOUND',
          reason: 'That bank connection no longer exists. Link it again.',
        },
      });
      return;
    }

    try {
      const userId = String(res.locals.user_id ?? 'actual-user');
      const base: Plaid.LinkTokenCreateRequest = {
        client_name: 'Actual Budget',
        language: 'en',
        country_codes: ['US'],
        user: { client_user_id: userId },
      };
      // Update mode: existing access_token and NO products.
      const request: Plaid.LinkTokenCreateRequest = existing
        ? { ...base, access_token: existing.access_token }
        : {
            ...base,
            products: ['transactions'],
            // consented now, billed only if ever called
            additional_consented_products: ['investments', 'liabilities'],
            transactions: { days_requested: 730 },
          };
      const created = await plaid.getClient().link.createToken(request);

      const id = crypto.randomBytes(24).toString('hex');
      sessions.set(id, {
        id,
        linkToken: created.link_token,
        mode: existing ? 'update' : 'create',
        itemId: existing?.item_id,
        institutionName: existing?.institution_name,
        expiresAt: Math.min(
          Date.parse(created.expiration),
          Date.now() + (existing ? 30 : 4 * 60) * 60 * 1000,
        ),
        status: 'pending',
      });
      res.send({ status: 'ok', data: { sessionId: id } });
    } catch (err) {
      sendError(res, err, 'link token create');
    }
  }),
);

app.post('/link-session/poll', (req, res) => {
  const { sessionId } = (req.body ?? {}) as { sessionId?: string };
  const session = sessionId ? getSession(sessionId) : null;
  res.send({
    status: 'ok',
    data: session
      ? {
          status: session.status,
          duplicate: session.duplicate,
          error: session.error,
        }
      : { status: 'expired' },
  });
});

export type PlaidActualAccount = {
  account_id: string;
  item_id: string;
  name: string;
  official_name: string | null;
  institution: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  balance: number;
};

function signedBalance(a: Plaid.AccountBase): number {
  const current = a.balances.current ?? a.balances.available ?? 0;
  // Plaid reports credit/loan balances as the amount owed (positive)
  return a.type === 'credit' || a.type === 'loan' ? -current : current;
}

app.post(
  '/accounts',
  handleError(async (_req, res) => {
    const accounts: PlaidActualAccount[] = [];
    const items: {
      item_id: string;
      institution: string;
      error?: NormalizedPlaidError;
    }[] = [];

    for (const item of store.listItems()) {
      const institution = item.institution_name ?? 'Bank';
      try {
        for (const a of await plaid.getAccounts(item)) {
          accounts.push({
            account_id: a.account_id,
            item_id: item.item_id,
            name: a.name,
            official_name: a.official_name,
            institution,
            mask: a.mask,
            type: a.type,
            subtype: a.subtype,
            // Integer cents: the link modal formats this as an IntegerAmount.
            balance: Math.round(signedBalance(a) * 100),
          });
        }
        items.push({ item_id: item.item_id, institution });
      } catch (err) {
        const n = plaid.normalizeError(err);
        plaid.logPlaidError('accounts get', n);
        if (n.error_code === 'ITEM_NOT_FOUND') {
          store.deleteItem(item.item_id);
          continue;
        }
        items.push({ item_id: item.item_id, institution, error: n });
      }
    }

    res.send({ status: 'ok', data: { accounts, items } });
  }),
);

app.post(
  '/transactions',
  handleError(async (req, res) => {
    const { accountId, startDate } = (req.body ?? {}) as {
      accountId?: string;
      startDate?: string;
    };
    if (!accountId || !startDate) {
      res.send({
        status: 'ok',
        data: { error: 'accountId and startDate are required' },
      });
      return;
    }

    try {
      let item = store.findItemByAccount(accountId);
      if (!item) {
        // account_ids can change; refresh the account lists once
        for (const i of store.listItems()) {
          await plaid.getAccounts(i).catch(() => undefined);
        }
        item = store.findItemByAccount(accountId);
      }
      if (!item) {
        res.send({
          status: 'ok',
          data: {
            error_type: 'ITEM_ERROR',
            error_code: 'NO_ACCOUNTS',
            reason: 'This account is no longer available from Plaid.',
          },
        });
        return;
      }

      await plaid.syncItem(item);
      const account = (await plaid.getAccounts(item)).find(
        a => a.account_id === accountId,
      );
      if (!account) {
        res.send({
          status: 'ok',
          data: {
            error_type: 'ITEM_ERROR',
            error_code: 'NO_ACCOUNTS',
            reason: 'This account is no longer available from Plaid.',
          },
        });
        return;
      }

      const currency =
        account.balances.iso_currency_code ??
        account.balances.unofficial_currency_code ??
        'USD';
      const balanceCents = Math.round(signedBalance(account) * 100);
      const all = store
        .getTransactions(accountId, startDate)
        .map(t => toActualTransaction(t, currency));

      res.send({
        status: 'ok',
        data: {
          balances: [
            {
              balanceAmount: { amount: balanceCents, currency },
              balanceType: 'expected',
              referenceDate: new Date().toISOString().slice(0, 10),
            },
          ],
          startingBalance: balanceCents,
          transactions: {
            all,
            booked: all.filter(t => t.booked),
            pending: all.filter(t => !t.booked),
          },
        },
      });
    } catch (err) {
      sendError(res, err, 'transactions sync');
    }
  }),
);

app.post(
  '/remove-items',
  handleError(async (_req, res) => {
    const failed: string[] = [];
    for (const item of store.listItems()) {
      try {
        await plaid.removeItem(item);
      } catch (err) {
        plaid.logPlaidError('item remove', plaid.normalizeError(err));
        failed.push(item.institution_name ?? item.item_id);
      }
    }
    res.send({
      status: 'ok',
      data: failed.length
        ? {
            error: 'remove-failed',
            reason: `Could not disconnect: ${failed.join(', ')}`,
          }
        : { removed: true },
    });
  }),
);

function toActualTransaction(t: Plaid.Transaction, accountCurrency: string) {
  const payeeName =
    t.merchant_name ??
    t.counterparties?.[0]?.name ??
    t.original_description ??
    'Unknown';
  return {
    // A posted transaction carries its pending twin's id so Actual updates
    // the pending row (keeping user edits) instead of adding a duplicate.
    transactionId:
      !t.pending && t.pending_transaction_id
        ? t.pending_transaction_id
        : t.transaction_id,
    booked: !t.pending,
    date: t.date,
    payeeName,
    notes: t.original_description ?? undefined,
    // Plaid: positive = money out. Actual: positive = money in.
    transactionAmount: {
      amount: (-t.amount).toFixed(2),
      currency:
        t.iso_currency_code ?? t.unofficial_currency_code ?? accountCurrency,
    },
  };
}
