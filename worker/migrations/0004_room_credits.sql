-- Credited quant-rooms: added by the hourly cron (1–3 of each kind), not opened by anyone. Kept apart
-- from the real counters (room_stats, room_totals) and only ever served as roomsV2 = real + credited.
-- Same shape as 0003. kind: classic | super | ai

-- Per UTC day (days since 1970-01-01).
CREATE TABLE credit_room_stats (
  day INTEGER NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, kind)
);

-- All time.
CREATE TABLE credit_room_totals (
  kind TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);

-- Where the credits start: the UTC day this migration runs on, and all time. ai starts from zero.
INSERT INTO credit_room_stats (day, kind, count) VALUES
  (CAST(unixepoch() / 86400 AS INTEGER), 'classic', 54),
  (CAST(unixepoch() / 86400 AS INTEGER), 'super', 18);
INSERT INTO credit_room_totals (kind, count) VALUES
  ('classic', 143),
  ('super', 62);
