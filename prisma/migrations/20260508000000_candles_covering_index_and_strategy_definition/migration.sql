-- ── Strategy.definition column (added in Sprint of 2026-05-08) ────────────────
-- Optional executable CustomStrategyDSL JSON. When present, the dashboard
-- strategy can be selected directly from the backtesting wizard.
ALTER TABLE "strategies"
    ADD COLUMN IF NOT EXISTS "definition" JSONB;

-- ── Covering index for candle reads ───────────────────────────────────────────
-- The hot read pattern is "fetch candles for (symbol, timeframe) inside a
-- date range" via getCachedCandles / getCandles. Postgres can satisfy that
-- entirely from a B-tree index that INCLUDEs the OHLCV columns — no heap
-- fetch, much fewer pages touched.
--
-- We DROP the redundant non-unique idx (the unique constraint already
-- creates an index on the same columns) and replace it with the covering
-- variant. The unique constraint stays so upserts remain safe.
DROP INDEX IF EXISTS "candles_symbol_timeframe_openTime_idx";

CREATE INDEX "candles_symbol_timeframe_openTime_covering_idx"
    ON "candles" ("symbol", "timeframe", "openTime")
    INCLUDE ("open", "high", "low", "close", "volume");
