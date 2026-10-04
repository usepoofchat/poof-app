-- Super Quant-Room payments. Nothing here links a payment to a quant-room: passes are blind-signed,
-- and a spent pass is stored only as a hash of its message.

-- One RSA key per variant ("3600-4", "86400-10"). The private key is sealed with PASS_MASTER_KEY.
CREATE TABLE pass_keys (
  variant TEXT PRIMARY KEY,
  key_id TEXT NOT NULL UNIQUE,
  spki TEXT NOT NULL,
  sealed_private TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Every stablecoin transfer to Poof that someone redeemed (or tried to): what it should have been
-- and what arrived. For reconciliation and complaints.
CREATE TABLE payments (
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  token TEXT NOT NULL,
  variant TEXT NOT NULL,
  required_micros INTEGER NOT NULL,
  received_micros INTEGER NOT NULL,
  -- issued | underpaid
  status TEXT NOT NULL,
  -- SHA-256 of the blinded pass that was signed: a retry with the same one gets the same answer.
  blinded_hash TEXT,
  -- A second pass for the same payment (the first was lost). At most one.
  reissued INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chain, tx_hash)
);

-- Spent passes: SHA-256 of the pass message only.
CREATE TABLE spent_passes (
  msg_hash TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  spent_at INTEGER NOT NULL
);
