import { useEffect, useState } from 'react';

import { send } from '@actual-app/core/platform/client/connection';

import { useSyncServerStatus } from './useSyncServerStatus';

/** Whether the sync-server has Plaid keys configured (env vars). */
export function usePlaidStatus() {
  const [configuredPlaid, setConfiguredPlaid] = useState<boolean | null>(null);
  const status = useSyncServerStatus();

  useEffect(() => {
    async function fetch() {
      const results = await send('plaid-status');
      setConfiguredPlaid(
        Boolean(results && 'configured' in results && results.configured),
      );
    }

    if (status === 'online') {
      void fetch();
    }
  }, [status]);

  return { configuredPlaid };
}
