-- CreateEnum
CREATE TYPE "BacktestMode" AS ENUM ('MANUAL', 'AUTO');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('IDLE', 'RUNNING', 'COMPLETED', 'FAILED');

-- AlterTable: extend BacktestSession with auto-run fields
ALTER TABLE "backtest_sessions"
    ADD COLUMN "mode"           "BacktestMode" NOT NULL DEFAULT 'MANUAL',
    ADD COLUMN "timeframe"      TEXT,
    ADD COLUMN "strategyType"   TEXT,
    ADD COLUMN "strategyConfig" JSONB,
    ADD COLUMN "runStatus"      "RunStatus" NOT NULL DEFAULT 'IDLE',
    ADD COLUMN "runProgress"    INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "runError"       TEXT,
    ADD COLUMN "runStartedAt"   TIMESTAMP(3),
    ADD COLUMN "runCompletedAt" TIMESTAMP(3);

-- AlterTable: extend BacktestTrade with commission, slippage, ambiguous
ALTER TABLE "backtest_trades"
    ADD COLUMN "commission" DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN "slippage"   DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN "ambiguous"  BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: OHLCV candle cache
CREATE TABLE "candles" (
    "id"        TEXT NOT NULL,
    "symbol"    TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "openTime"  TIMESTAMP(3) NOT NULL,
    "open"      DOUBLE PRECISION NOT NULL,
    "high"      DOUBLE PRECISION NOT NULL,
    "low"       DOUBLE PRECISION NOT NULL,
    "close"     DOUBLE PRECISION NOT NULL,
    "volume"    DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "candles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: composite unique prevents duplicate candles
CREATE UNIQUE INDEX "candles_symbol_timeframe_openTime_key"
    ON "candles"("symbol", "timeframe", "openTime");

-- CreateIndex: primary query pattern — fetch by symbol+timeframe+time range
CREATE INDEX "candles_symbol_timeframe_openTime_idx"
    ON "candles"("symbol", "timeframe", "openTime");
