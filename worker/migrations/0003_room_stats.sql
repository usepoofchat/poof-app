-- Quant-rooms created, for the public stats page. Counters only: no room id, no time finer than the
-- UTC day, nothing about who opened a room or who was in it.
-- kind: classic (free) | super (Super Quant-Room) | ai (Super Quant-Room with the AI model)

-- Per UTC day (days since 1970-01-01).
CREATE TABLE room_stats (
  day INTEGER NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, kind)
);

-- All time, so the stats page never sums the whole history.
CREATE TABLE room_totals (
  kind TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
