-- Extends the ledger foundation (0002) with: verified wallets, bans, referrals,
-- GRAM deposits -> VLR buys -> automatic payouts, and the withdrawal review workflow.
-- All user ids are Telegram ids stored as TEXT (same as 0002).

ALTER TABLE velora_users ADD COLUMN IF NOT EXISTS wallet_verified_at TIMESTAMPTZ;
ALTER TABLE velora_users ADD COLUMN IF NOT EXISTS referrer_telegram_id TEXT REFERENCES velora_users(telegram_id);
ALTER TABLE velora_users ADD COLUMN IF NOT EXISTS banned_reason TEXT;
ALTER TABLE velora_users ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ;
-- wallet_address holds the normalised raw form "0:hex" and is set ONLY after ton_proof succeeds.
CREATE UNIQUE INDEX IF NOT EXISTS velora_users_wallet_uidx ON velora_users(wallet_address) WHERE wallet_address IS NOT NULL;
ALTER TABLE velora_users DROP CONSTRAINT IF EXISTS velora_users_wallet_verified_chk;
ALTER TABLE velora_users ADD CONSTRAINT velora_users_wallet_verified_chk
  CHECK (wallet_address IS NULL OR wallet_verified_at IS NOT NULL);

ALTER TABLE velora_withdrawals DROP CONSTRAINT IF EXISTS velora_withdrawals_status_check;
ALTER TABLE velora_withdrawals ADD CONSTRAINT velora_withdrawals_status_check
  CHECK (status IN ('pending','approved','broadcast','completed','rejected','failed','forfeited'));

-- GRAM deposits seen on the treasury. tx_hash is the idempotency key.
CREATE TABLE IF NOT EXISTS velora_deposits (
  tx_hash     TEXT PRIMARY KEY,
  telegram_id TEXT,                          -- from the signed memo; NO foreign key (a forged memo may name a non-user)
  value_nano  NUMERIC(40,0) NOT NULL,
  gram        NUMERIC(30,9) NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('credited','held')),
  held_reason TEXT,
  at          TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS velora_deposits_status_idx ON velora_deposits (status, at);

-- One buy per credited deposit; paid out on-chain by the hot wallet.
-- 'sending' is claimed by exactly one worker and is never retried once a message may be on the wire.
CREATE TABLE IF NOT EXISTS velora_buys (
  id                  TEXT PRIMARY KEY,      -- 'buy:' || deposit tx hash
  telegram_id         TEXT NOT NULL REFERENCES velora_users(telegram_id),
  deposit_tx          TEXT NOT NULL UNIQUE REFERENCES velora_deposits(tx_hash),
  gram_in             NUMERIC(30,9) NOT NULL,
  vlr_out             NUMERIC(30,6) NOT NULL,
  gram_per_vlr        NUMERIC(30,12) NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending_payout','sending','paid','failed','review')),
  payout_msg_hash     TEXT,
  payout_tx           TEXT,
  payout_attempted_at TIMESTAMPTZ,
  review_note         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at             TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS velora_buys_user_idx ON velora_buys (telegram_id, created_at);
CREATE INDEX IF NOT EXISTS velora_buys_status_idx ON velora_buys (status, created_at);

-- Replaces the 0002 version: also requires a verified, non-banned account and allows one open
-- withdrawal at a time. The fee is supplied by the SERVER (never the client).
CREATE OR REPLACE FUNCTION velora_request_withdrawal(
  p_id TEXT, p_telegram_id TEXT, p_amount BIGINT, p_fee BIGINT,
  p_destination TEXT, p_idempotency_key TEXT
) RETURNS TABLE(withdrawal_id TEXT, balance_micro_vlr BIGINT, duplicate BOOLEAN) LANGUAGE plpgsql AS $$
DECLARE v_balance BIGINT; v_existing TEXT; v_existing_amount BIGINT; v_existing_fee BIGINT; v_existing_destination TEXT;
BEGIN
  IF p_amount < 10000000000 OR p_fee < 0 OR p_fee >= p_amount OR length(p_idempotency_key) < 8 OR length(p_destination) < 20 THEN
    RAISE EXCEPTION 'invalid withdrawal request';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM velora_users
    WHERE telegram_id = p_telegram_id AND wallet_address = p_destination
      AND wallet_verified_at IS NOT NULL AND banned_at IS NULL
  ) THEN
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
  IF EXISTS (SELECT 1 FROM velora_withdrawals WHERE telegram_id = p_telegram_id AND status IN ('pending','approved')) THEN
    RAISE EXCEPTION 'withdrawal already pending';
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

-- Admin decision on a withdrawal, atomically with any refund.
--   approve : pending  -> approved           (admin then pays manually)
--   complete: approved -> completed (+ tx hash)
--   reject  : pending/approved -> rejected   (full refund to the user)
--   forfeit : pending/approved -> forfeited  (NO refund: rule violation)
CREATE OR REPLACE FUNCTION velora_resolve_withdrawal(
  p_id TEXT, p_action TEXT, p_reviewer TEXT, p_note TEXT DEFAULT NULL, p_tx_hash TEXT DEFAULT NULL
) RETURNS TABLE(result_status TEXT, new_balance BIGINT) LANGUAGE plpgsql AS $$
DECLARE w velora_withdrawals%ROWTYPE; v_balance BIGINT;
BEGIN
  SELECT * INTO w FROM velora_withdrawals WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'withdrawal not found'; END IF;
  PERFORM 1 FROM velora_accounts WHERE telegram_id = w.telegram_id FOR UPDATE;
  IF p_action = 'approve' THEN
    IF w.status <> 'pending' THEN RAISE EXCEPTION 'invalid state'; END IF;
    UPDATE velora_withdrawals SET status = 'approved', reviewed_by = p_reviewer, review_note = p_note, updated_at = now() WHERE id = p_id;
  ELSIF p_action = 'complete' THEN
    IF w.status <> 'approved' OR p_tx_hash IS NULL OR length(p_tx_hash) < 20 THEN RAISE EXCEPTION 'invalid state'; END IF;
    UPDATE velora_withdrawals SET status = 'completed', tx_hash = p_tx_hash, reviewed_by = p_reviewer, review_note = COALESCE(p_note, review_note), updated_at = now() WHERE id = p_id;
  ELSIF p_action = 'reject' THEN
    IF w.status NOT IN ('pending','approved') THEN RAISE EXCEPTION 'invalid state'; END IF;
    UPDATE velora_accounts SET available_micro_vlr = available_micro_vlr + w.amount_micro_vlr, updated_at = now()
      WHERE telegram_id = w.telegram_id RETURNING available_micro_vlr INTO v_balance;
    INSERT INTO velora_ledger(telegram_id, amount_micro_vlr, available_after, entry_type, idempotency_key, reference)
      VALUES (w.telegram_id, w.amount_micro_vlr, v_balance, 'credit', 'refund:' || p_id, p_id);
    UPDATE velora_withdrawals SET status = 'rejected', reviewed_by = p_reviewer, review_note = p_note, updated_at = now() WHERE id = p_id;
  ELSIF p_action = 'forfeit' THEN
    IF w.status NOT IN ('pending','approved') THEN RAISE EXCEPTION 'invalid state'; END IF;
    UPDATE velora_withdrawals SET status = 'forfeited', reviewed_by = p_reviewer, review_note = p_note, updated_at = now() WHERE id = p_id;
  ELSE
    RAISE EXCEPTION 'invalid action';
  END IF;
  SELECT available_micro_vlr INTO v_balance FROM velora_accounts WHERE telegram_id = w.telegram_id;
  RETURN QUERY SELECT (SELECT status FROM velora_withdrawals WHERE id = p_id), v_balance;
END; $$;
