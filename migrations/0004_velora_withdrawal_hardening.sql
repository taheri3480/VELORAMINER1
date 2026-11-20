-- Defense-in-depth hardening for the withdrawal workflow.
-- The application still computes fees, but PostgreSQL independently enforces
-- the documented 5% fee and makes forfeiture + account ban one atomic change.

CREATE OR REPLACE FUNCTION velora_request_withdrawal(
  p_id TEXT, p_telegram_id TEXT, p_amount BIGINT, p_fee BIGINT,
  p_destination TEXT, p_idempotency_key TEXT
) RETURNS TABLE(withdrawal_id TEXT, balance_micro_vlr BIGINT, duplicate BOOLEAN) LANGUAGE plpgsql AS $$
DECLARE
  v_balance BIGINT;
  v_existing TEXT;
  v_existing_amount BIGINT;
  v_existing_fee BIGINT;
  v_existing_destination TEXT;
  v_expected_fee BIGINT;
BEGIN
  IF p_amount IS NULL OR p_amount < 10000000000
     OR p_amount > 10000000000000
     OR p_fee IS NULL
     OR length(p_idempotency_key) < 8
     OR length(p_destination) < 20 THEN
    RAISE EXCEPTION 'invalid withdrawal request';
  END IF;

  -- 500 basis points = 5%; calculate with NUMERIC to avoid BIGINT overflow.
  v_expected_fee := floor((p_amount::numeric * 500) / 10000)::bigint;
  IF p_fee <> v_expected_fee THEN
    RAISE EXCEPTION 'invalid withdrawal fee';
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
    FROM velora_withdrawals
    WHERE telegram_id = p_telegram_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing_amount <> p_amount OR v_existing_fee <> p_fee OR v_existing_destination <> p_destination THEN
      RAISE EXCEPTION 'idempotency key reused with different withdrawal';
    END IF;
    SELECT available_micro_vlr INTO v_balance FROM velora_accounts WHERE telegram_id = p_telegram_id;
    RETURN QUERY SELECT v_existing, v_balance, TRUE;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM velora_withdrawals WHERE telegram_id = p_telegram_id AND status IN ('pending','approved')) THEN
    RAISE EXCEPTION 'withdrawal already pending';
  END IF;

  UPDATE velora_accounts
    SET available_micro_vlr = available_micro_vlr - p_amount, updated_at = now()
    WHERE telegram_id = p_telegram_id AND available_micro_vlr >= p_amount
    RETURNING available_micro_vlr INTO v_balance;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient balance'; END IF;

  INSERT INTO velora_withdrawals(id, telegram_id, amount_micro_vlr, fee_micro_vlr, destination_address, idempotency_key)
    VALUES (p_id, p_telegram_id, p_amount, p_fee, p_destination, p_idempotency_key);
  INSERT INTO velora_ledger(telegram_id, amount_micro_vlr, available_after, entry_type, idempotency_key, reference)
    VALUES (p_telegram_id, -p_amount, v_balance, 'withdrawal', 'withdraw:' || p_idempotency_key, p_id);
  RETURN QUERY SELECT p_id, v_balance, FALSE;
END;
$$;

-- Remove the older five-argument overload so callers cannot accidentally use
-- the version that lacks atomic ban semantics.
DROP FUNCTION IF EXISTS velora_resolve_withdrawal(TEXT, TEXT, TEXT, TEXT, TEXT);

CREATE FUNCTION velora_resolve_withdrawal(
  p_id TEXT,
  p_action TEXT,
  p_reviewer TEXT,
  p_note TEXT DEFAULT NULL,
  p_tx_hash TEXT DEFAULT NULL,
  p_ban_user BOOLEAN DEFAULT FALSE
) RETURNS TABLE(result_status TEXT, new_balance BIGINT) LANGUAGE plpgsql AS $$
DECLARE
  w velora_withdrawals%ROWTYPE;
  v_balance BIGINT;
BEGIN
  SELECT * INTO w FROM velora_withdrawals WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'withdrawal not found'; END IF;
  PERFORM 1 FROM velora_accounts WHERE telegram_id = w.telegram_id FOR UPDATE;

  IF p_action = 'approve' THEN
    IF p_ban_user OR w.status <> 'pending' THEN RAISE EXCEPTION 'invalid state'; END IF;
    UPDATE velora_withdrawals
      SET status = 'approved', reviewed_by = p_reviewer, review_note = p_note, updated_at = now()
      WHERE id = p_id;
  ELSIF p_action = 'complete' THEN
    IF p_ban_user OR w.status <> 'approved' OR p_tx_hash IS NULL OR length(p_tx_hash) < 20 THEN
      RAISE EXCEPTION 'invalid state';
    END IF;
    UPDATE velora_withdrawals
      SET status = 'completed', tx_hash = p_tx_hash, reviewed_by = p_reviewer,
          review_note = COALESCE(p_note, review_note), updated_at = now()
      WHERE id = p_id;
  ELSIF p_action = 'reject' THEN
    IF p_ban_user OR w.status NOT IN ('pending','approved') THEN RAISE EXCEPTION 'invalid state'; END IF;
    UPDATE velora_accounts
      SET available_micro_vlr = available_micro_vlr + w.amount_micro_vlr, updated_at = now()
      WHERE telegram_id = w.telegram_id RETURNING available_micro_vlr INTO v_balance;
    INSERT INTO velora_ledger(telegram_id, amount_micro_vlr, available_after, entry_type, idempotency_key, reference)
      VALUES (w.telegram_id, w.amount_micro_vlr, v_balance, 'credit', 'refund:' || p_id, p_id);
    UPDATE velora_withdrawals
      SET status = 'rejected', reviewed_by = p_reviewer, review_note = p_note, updated_at = now()
      WHERE id = p_id;
  ELSIF p_action = 'forfeit' THEN
    IF NOT p_ban_user OR w.status NOT IN ('pending','approved') OR NULLIF(trim(p_note), '') IS NULL THEN
      RAISE EXCEPTION 'invalid state';
    END IF;
    -- Both operations commit or roll back together.
    UPDATE velora_users
      SET banned_at = COALESCE(banned_at, now()),
          banned_reason = COALESCE(banned_reason, p_note), updated_at = now()
      WHERE telegram_id = w.telegram_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'withdrawal user not found'; END IF;
    UPDATE velora_withdrawals
      SET status = 'forfeited', reviewed_by = p_reviewer, review_note = p_note, updated_at = now()
      WHERE id = p_id;
  ELSE
    RAISE EXCEPTION 'invalid action';
  END IF;

  SELECT available_micro_vlr INTO v_balance FROM velora_accounts WHERE telegram_id = w.telegram_id;
  RETURN QUERY SELECT (SELECT status FROM velora_withdrawals WHERE id = p_id), v_balance;
END;
$$;
