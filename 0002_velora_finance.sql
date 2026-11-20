-- Server-authoritative Velora financial foundation.
-- Amounts are integer micro-VLR (1 VLR = 1,000,000 units); never use floats for money.
CREATE TABLE IF NOT EXISTS velora_users (
  telegram_id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT NOT NULL DEFAULT '',
  wallet_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS velora_accounts (
  telegram_id TEXT PRIMARY KEY REFERENCES velora_users(telegram_id) ON DELETE RESTRICT,
  available_micro_vlr BIGINT NOT NULL DEFAULT 0 CHECK (available_micro_vlr >= 0),
  held_micro_vlr BIGINT NOT NULL DEFAULT 0 CHECK (held_micro_vlr >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS velora_ledger (
  id BIGSERIAL PRIMARY KEY,
  telegram_id TEXT NOT NULL REFERENCES velora_users(telegram_id) ON DELETE RESTRICT,
  amount_micro_vlr BIGINT NOT NULL CHECK (amount_micro_vlr <> 0),
  available_after BIGINT NOT NULL CHECK (available_after >= 0),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('credit','debit','hold','release','deposit','withdrawal','reward','adjustment')),
  idempotency_key TEXT NOT NULL,
  reference TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (telegram_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS velora_ledger_user_created_idx ON velora_ledger(telegram_id, created_at DESC);

CREATE TABLE IF NOT EXISTS velora_withdrawals (
  id TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL REFERENCES velora_users(telegram_id) ON DELETE RESTRICT,
  amount_micro_vlr BIGINT NOT NULL CHECK (amount_micro_vlr > 0),
  fee_micro_vlr BIGINT NOT NULL CHECK (fee_micro_vlr >= 0),
  destination_address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','broadcast','completed','rejected','failed')),
  idempotency_key TEXT NOT NULL,
  tx_hash TEXT,
  reviewed_by TEXT,
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (telegram_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS velora_withdrawals_queue_idx ON velora_withdrawals(status, created_at);

CREATE TABLE IF NOT EXISTS velora_jetton_events (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  tx_hash TEXT NOT NULL,
  telegram_id TEXT REFERENCES velora_users(telegram_id) ON DELETE RESTRICT,
  jetton_master TEXT NOT NULL,
  amount_atomic NUMERIC(78,0) NOT NULL CHECK (amount_atomic > 0),
  status TEXT NOT NULL DEFAULT 'observed' CHECK (status IN ('observed','confirmed','credited','rejected')),
  raw_event JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);

-- Atomic, idempotent balance change. A negative delta is a debit.
CREATE OR REPLACE FUNCTION velora_apply_delta(
  p_telegram_id TEXT,
  p_delta BIGINT,
  p_entry_type TEXT,
  p_idempotency_key TEXT,
  p_reference TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS TABLE(balance_micro_vlr BIGINT, duplicate BOOLEAN) LANGUAGE plpgsql AS $$
DECLARE v_balance BIGINT; v_existing BIGINT; v_existing_delta BIGINT; v_existing_type TEXT;
BEGIN
  IF p_delta = 0 OR length(p_idempotency_key) < 8 THEN
    RAISE EXCEPTION 'invalid ledger mutation';
  END IF;
  INSERT INTO velora_accounts(telegram_id) VALUES (p_telegram_id) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM velora_accounts WHERE telegram_id = p_telegram_id FOR UPDATE;
  SELECT available_after, amount_micro_vlr, entry_type
    INTO v_existing, v_existing_delta, v_existing_type
    FROM velora_ledger
    WHERE telegram_id = p_telegram_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing_delta <> p_delta OR v_existing_type <> p_entry_type THEN
      RAISE EXCEPTION 'idempotency key reused with different mutation';
    END IF;
    SELECT available_micro_vlr INTO v_balance FROM velora_accounts WHERE telegram_id = p_telegram_id;
    RETURN QUERY SELECT v_balance, TRUE; RETURN;
  END IF;
  UPDATE velora_accounts SET available_micro_vlr = available_micro_vlr + p_delta, updated_at = now()
    WHERE telegram_id = p_telegram_id AND available_micro_vlr + p_delta >= 0
    RETURNING available_micro_vlr INTO v_balance;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient balance'; END IF;
  INSERT INTO velora_ledger(telegram_id, amount_micro_vlr, available_after, entry_type, idempotency_key, reference, metadata)
    VALUES (p_telegram_id, p_delta, v_balance, p_entry_type, p_idempotency_key, p_reference, COALESCE(p_metadata, '{}'::jsonb));
  RETURN QUERY SELECT v_balance, FALSE;
END; $$;

-- Queue a withdrawal and debit the available balance in one database transaction.
-- No blockchain transfer is performed here; an operator must approve and broadcast separately.
CREATE OR REPLACE FUNCTION velora_request_withdrawal(
  p_id TEXT, p_telegram_id TEXT, p_amount BIGINT, p_fee BIGINT,
  p_destination TEXT, p_idempotency_key TEXT
) RETURNS TABLE(withdrawal_id TEXT, balance_micro_vlr BIGINT, duplicate BOOLEAN) LANGUAGE plpgsql AS $$
DECLARE v_balance BIGINT; v_existing TEXT; v_existing_amount BIGINT; v_existing_fee BIGINT; v_existing_destination TEXT;
BEGIN
  IF p_amount < 10000000000 OR p_fee < 0 OR p_fee >= p_amount OR length(p_idempotency_key) < 8 OR length(p_destination) < 20 THEN
    RAISE EXCEPTION 'invalid withdrawal request';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM velora_users WHERE telegram_id = p_telegram_id AND wallet_address = p_destination) THEN
    RAISE EXCEPTION 'destination wallet is not verified';
  END IF;
  INSERT INTO velora_accounts(telegram_id) VALUES (p_telegram_id) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM velora_accounts WHERE telegram_id = p_telegram_id FOR UPDATE;
  SELECT id, amount_micro_vlr, fee_micro_vlr, destination_address
    INTO v_existing, v_existing_amount, v_existing_fee, v_existing_destination
    FROM velora_withdrawals WHERE telegram_id = p_telegram_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing_amount <> p_amount OR v_existing_fee <> p_fee OR v_existing_destination <> p_destination THEN
      RAISE EXCEPTION 'idempotency key reused with different withdrawal';
    END IF;
    SELECT available_micro_vlr INTO v_balance FROM velora_accounts WHERE telegram_id = p_telegram_id;
    RETURN QUERY SELECT v_existing, v_balance, TRUE; RETURN;
  END IF;
  UPDATE velora_accounts SET available_micro_vlr = available_micro_vlr - p_amount, updated_at = now()
    WHERE telegram_id = p_telegram_id AND available_micro_vlr >= p_amount
    RETURNING available_micro_vlr INTO v_balance;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient balance'; END IF;
  INSERT INTO velora_withdrawals(id, telegram_id, amount_micro_vlr, fee_micro_vlr, destination_address, idempotency_key)
    VALUES (p_id, p_telegram_id, p_amount, p_fee, p_destination, p_idempotency_key);
  INSERT INTO velora_ledger(telegram_id, amount_micro_vlr, available_after, entry_type, idempotency_key, reference)
    VALUES (p_telegram_id, -p_amount, v_balance, 'withdrawal', 'withdraw:' || p_idempotency_key, p_id);
  RETURN QUERY SELECT p_id, v_balance, FALSE;
END; $$;

-- Keep the accounting journal append-only for the normal application role.
CREATE OR REPLACE FUNCTION velora_reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'velora ledger is append-only';
END; $$;
DROP TRIGGER IF EXISTS velora_ledger_no_update ON velora_ledger;
CREATE TRIGGER velora_ledger_no_update BEFORE UPDATE OR DELETE ON velora_ledger
  FOR EACH ROW EXECUTE FUNCTION velora_reject_ledger_mutation();
