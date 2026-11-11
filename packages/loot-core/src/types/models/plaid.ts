export type SyncServerPlaidAccount = {
  account_id: string;
  item_id: string;
  name: string;
  official_name: string | null;
  institution: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  /** Integer cents, signed (credit and loan balances are negative). */
  balance: number;
};

export type PlaidItemSummary = {
  item_id: string;
  institution: string;
  error?: { error_type: string; error_code: string; reason: string };
};

export type PlaidLinkStatus =
  | 'pending'
  | 'importing'
  | 'complete'
  | 'exited'
  | 'error'
  | 'expired';
