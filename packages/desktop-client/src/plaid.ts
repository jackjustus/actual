import { send } from '@actual-app/core/platform/client/connection';
import type { AccountEntity } from '@actual-app/core/types/models';
import { t } from 'i18next';

import { pushModal } from './modals/modalsSlice';
import {
  addNotification,
  removeNotification,
} from './notifications/notificationsSlice';
import type { AppDispatch } from './redux/store';

const WAITING_NOTIFICATION_ID = 'plaid-link-waiting';

function notifyError(dispatch: AppDispatch, message: string) {
  dispatch(
    addNotification({
      notification: {
        type: 'error',
        title: t('Plaid'),
        message,
        timeout: 8000,
      },
    }),
  );
}

/**
 * Plaid Link can't run inside Actual's page (it is cross-origin isolated),
 * so the server hosts it in its own tab. This opens that tab, waits for it
 * to finish, and returns how it ended.
 */
async function runLinkTab(dispatch: AppDispatch, opts: { accountId?: string }) {
  const started = await send('plaid-link-start', opts);
  if (!started || !('url' in started)) {
    const reason =
      (started && 'reason' in started && started.reason) ||
      (started && 'error_code' in started && started.error_code) ||
      t('Could not start Plaid.');
    notifyError(dispatch, String(reason));
    return null;
  }

  const { url, sessionId } = started;
  window.Actual.openURLInBrowser(url);

  dispatch(
    addNotification({
      notification: {
        id: WAITING_NOTIFICATION_ID,
        type: 'message',
        title: t('Finish in the Plaid tab'),
        message: t(
          'A new tab opened to connect your bank. Come back here when it says Done.',
        ),
        sticky: true,
        button: {
          title: t('Open Plaid'),
          action: () => window.Actual.openURLInBrowser(url),
        },
        onClose: () => void send('plaid-link-poll-stop'),
      },
    }),
  );

  const result = await send('plaid-link-poll', { sessionId });
  dispatch(removeNotification({ id: WAITING_NOTIFICATION_ID }));
  return result;
}

/**
 * Add a bank via Plaid, then show the account picker with every Plaid
 * account. Closing Link without adding a bank still shows the picker, so
 * already-connected banks can be mapped to more Actual accounts.
 */
export async function linkPlaidBank(
  dispatch: AppDispatch,
  upgradingAccountId?: AccountEntity['id'],
) {
  const result = await runLinkTab(dispatch, {});
  if (!result || result.status === 'stopped') return;

  if (result.status === 'error') {
    notifyError(
      dispatch,
      result.error?.reason ?? t('Connecting the bank failed.'),
    );
    return;
  }
  if (result.status === 'timeout' || result.status === 'expired') {
    notifyError(dispatch, t('The Plaid session expired. Please try again.'));
    return;
  }

  const res = await send('plaid-accounts');
  if (!res || 'error' in res || 'error_code' in res) {
    notifyError(dispatch, t('Could not load accounts from Plaid.'));
    return;
  }

  const { accounts, items } = res;
  for (const item of items) {
    if (item.error) {
      notifyError(
        dispatch,
        t('{{bank}} needs attention: {{reason}}', {
          bank: item.institution,
          reason: item.error.reason,
        }),
      );
    }
  }

  if (accounts.length === 0) {
    if (result.status === 'exited') return;
    notifyError(dispatch, t('Plaid did not return any accounts.'));
    return;
  }

  dispatch(
    pushModal({
      modal: {
        name: 'select-linked-accounts',
        options: {
          externalAccounts: accounts,
          syncSource: 'plaid',
          upgradingAccountId,
        },
      },
    }),
  );
}

/**
 * Reconnect the bank behind an account whose login broke (Plaid "update
 * mode"). The existing connection is kept, so nothing is re-imported or
 * billed twice.
 */
export async function reconnectPlaidAccount(
  dispatch: AppDispatch,
  account: AccountEntity,
) {
  if (!account.account_id) return;
  const result = await runLinkTab(dispatch, { accountId: account.account_id });
  if (!result) return;

  if (result.status === 'complete') {
    dispatch(
      addNotification({
        notification: {
          type: 'message',
          message: t('Bank reconnected. Sync the account to catch up.'),
          timeout: 5000,
        },
      }),
    );
  } else if (result.status === 'error') {
    notifyError(
      dispatch,
      result.error?.reason ?? t('Reconnecting the bank failed.'),
    );
  }
}
