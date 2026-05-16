import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as svc from '../services/backtestService';
import { STRATEGY_CATALOG } from '../services/strategyDefinitions';
import { validateCustomStrategyDsl, type CustomStrategyDSL } from '../services/customStrategyInterpreter';

export const INSTRUMENT_TYPES = ['FOREX', 'STOCKS', 'FUTURES', 'CRYPTO', 'CFD'] as const;
const instrumentTypeSchema = z.enum(INSTRUMENT_TYPES);

const createSessionSchema = z.object({
  name:            z.string().min(1).max(120),
  symbol:          z.string().min(1).max(20),
  instrumentType:  instrumentTypeSchema.optional(),
  startDate:       z.string().datetime(),
  endDate:         z.string().datetime(),
  startingBalance: z.number().positive().optional(),
  notes:           z.string().max(500).optional(),
  mode:            z.enum(['MANUAL', 'AUTO']).optional(),
  timeframe:       z.string().optional(),
  strategyType:    z.string().optional(),
  strategyConfig:  z.record(z.unknown()).optional(),
});

const updateSessionSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  status: z.enum(['ACTIVE', 'COMPLETED', 'PAUSED']).optional(),
  notes: z.string().max(500).optional(),
});

const addTradeSchema = z.object({
  symbol: z.string().min(1).max(20),
  side: z.enum(['BUY', 'SELL']),
  entryPrice: z.number().positive(),
  exitPrice: z.number().positive().optional(),
  volume: z.number().positive().optional(),
  stopLoss: z.number().positive().optional(),
  takeProfit: z.number().positive().optional(),
  entryAt: z.string().datetime(),
  exitAt: z.string().datetime().optional(),
  notes: z.string().max(500).optional(),
});

const updateTradeSchema = z.object({
  exitPrice: z.number().positive().optional(),
  exitAt: z.string().datetime().optional(),
  stopLoss: z.number().positive().optional(),
  takeProfit: z.number().positive().optional(),
  notes: z.string().max(500).optional(),
  status: z.enum(['OPEN', 'CLOSED']).optional(),
});

export async function listSessions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await svc.getSessions(req.currentUser!.userId);
    res.json({ status: 'success', data });
  } catch (e) { next(e); }
}

export async function getSessionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await svc.getSession(req.currentUser!.userId, String(req.params.id));
    res.json({ status: 'success', data });
  } catch (e) { next(e); }
}

export async function createSessionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = createSessionSchema.parse(req.body);
    const data = await svc.createSession(req.currentUser!.userId, {
      ...body,
      startDate:      new Date(body.startDate),
      endDate:        new Date(body.endDate),
      strategyConfig: body.strategyConfig as Record<string, unknown> | undefined,
    });
    res.status(201).json({ status: 'success', data });
  } catch (e) { next(e); }
}

export async function updateSessionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = updateSessionSchema.parse(req.body);
    const data = await svc.updateSession(req.currentUser!.userId, String(req.params.id), body);
    res.json({ status: 'success', data });
  } catch (e) { next(e); }
}

export async function deleteSessionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await svc.deleteSession(req.currentUser!.userId, String(req.params.id));
    res.json({ status: 'success', message: 'Session deleted' });
  } catch (e) { next(e); }
}

export async function getAnalyticsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await svc.getSessionAnalytics(req.currentUser!.userId, String(req.params.id));
    res.json({ status: 'success', data });
  } catch (e) { next(e); }
}

export async function addTradeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = addTradeSchema.parse(req.body);
    const data = await svc.addTrade(req.currentUser!.userId, String(req.params.id), {
      ...body,
      entryAt: new Date(body.entryAt),
      exitAt: body.exitAt ? new Date(body.exitAt) : undefined,
    });
    res.status(201).json({ status: 'success', data });
  } catch (e) { next(e); }
}

const bulkAddTradesSchema = z.object({
  trades: z.array(addTradeSchema).min(1).max(500),
});

export async function bulkAddTradesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { trades } = bulkAddTradesSchema.parse(req.body);
    const data = await svc.bulkAddTrades(
      req.currentUser!.userId,
      String(req.params.id),
      trades.map(t => ({
        ...t,
        entryAt: new Date(t.entryAt),
        exitAt: t.exitAt ? new Date(t.exitAt) : undefined,
      })),
    );
    res.status(201).json({ status: 'success', data });
  } catch (e) { next(e); }
}

export async function updateTradeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = updateTradeSchema.parse(req.body);
    const data = await svc.updateTrade(
      req.currentUser!.userId,
      String(req.params.id),
      String(req.params.tradeId),
      { ...body, exitAt: body.exitAt ? new Date(body.exitAt) : undefined },
    );
    res.json({ status: 'success', data });
  } catch (e) { next(e); }
}

export async function deleteTradeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await svc.deleteTrade(req.currentUser!.userId, String(req.params.id), String(req.params.tradeId));
    res.json({ status: 'success', message: 'Trade deleted' });
  } catch (e) { next(e); }
}

// ── Automated backtest handlers ───────────────────────────────────────────────

// GET /api/v1/backtesting/strategies
// Returns the full strategy catalog — no DB calls.
export async function getStrategyCatalogHandler(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ status: 'success', data: STRATEGY_CATALOG });
  } catch (e) { next(e); }
}

// POST /api/v1/backtesting/sessions/:id/run
// Validates body, stores config on the session, then queues the backtest.
// Returns 202 immediately — frontend polls /run/status for progress.
const ALL_STRATEGY_TYPES = [
  'MA_CROSS', 'RSI_REVERSAL', 'MACD_SIGNAL', 'BB_BREAKOUT',
  'STOCHASTIC_CROSS', 'ADX_TREND', 'DONCHIAN_BREAKOUT',
  'CCI_REVERSAL', 'WILLIAMS_R', 'RSI_MA_COMBO', 'CUSTOM',
] as const;

// Strict shape for the CUSTOM DSL — same rules as the saved-strategy
// endpoint. Validating at the run boundary prevents empty/malformed DSLs
// from sneaking through and silently producing zero-trade "successful" runs.
const customConditionSchema = z.object({
  left:  z.string().min(1),
  op:    z.enum(['GT', 'LT', 'GTE', 'LTE', 'EQ', 'CROSSES_ABOVE', 'CROSSES_BELOW']),
  right: z.union([z.string(), z.number()]),
});
const customRuleGroupSchema = z.object({
  logic:      z.enum(['AND', 'OR']),
  conditions: z.array(customConditionSchema).max(10),
});
const customStrategySchema = z.object({
  version:     z.number().int().positive().optional(),
  name:        z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  indicators:  z.array(z.object({
    id:     z.string().min(1).max(50),
    type:   z.string().min(1),
    params: z.record(z.union([z.number(), z.string()])).optional(),
  })).max(20),
  buy:  customRuleGroupSchema,
  sell: customRuleGroupSchema,
}).refine(
  (d) => d.buy.conditions.length + d.sell.conditions.length > 0,
  { message: 'Custom strategy must have at least one buy or sell condition.' },
).superRefine((d, ctx) => {
  const errors = validateCustomStrategyDsl(d as unknown as CustomStrategyDSL);
  for (const message of errors) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
});

// Prop-firm-challenge rule set (FTMO / MFF / FundedNext style). All fields
// are optional — the trader supplies only the rules their challenge enforces.
// Percent values are FRACTIONS (0.05 = 5%, not 5).
// Position-sizing config. FIXED uses the top-level `volume`; PCT_EQUITY and
// RISK_BASED derive volume per-entry. Limits are deliberately loose — the
// engine handles bad inputs by falling back to FIXED or 0.
const sizingSchema = z.object({
  mode:          z.enum(['FIXED', 'PCT_EQUITY', 'RISK_BASED']),
  pctEquity:     z.number().min(0).max(1.0).optional(),
  riskPerTrade:  z.number().min(0).max(0.5).optional(),
  stopSource:    z.enum(['PCT', 'ATR']).optional(),
  atrPeriod:     z.number().int().min(2).max(200).optional(),
  atrMultiplier: z.number().min(0.1).max(20).optional(),
});

const propFirmRulesSchema = z.object({
  enabled:           z.boolean(),
  dailyLossLimitPct: z.number().min(0).max(0.5).optional(),
  maxLossPct:        z.number().min(0).max(0.5).optional(),
  trailingMaxDDPct:  z.number().min(0).max(0.5).optional(),
  trailingDDEodOnly: z.boolean().optional(),
  profitTargetPct:   z.number().min(0).max(1.0).optional(),
  minTradingDays:    z.number().int().min(0).max(365).optional(),
  maxTradingDays:    z.number().int().min(0).max(365).optional(),
});

const runSchema = z.object({
  timeframe:        z.enum(['D1', 'W1', 'H1', 'M30', 'M15']),
  strategyType:     z.enum(ALL_STRATEGY_TYPES),
  strategyConfig:   z.record(z.union([z.number(), z.string()])),
  customStrategy:   customStrategySchema.optional(),
  volume:           z.number().positive().default(1),
  stopLossPct:      z.number().min(0.001).max(0.20).default(0.02),
  takeProfitRatio:  z.number().min(0.5).max(10).default(2),
  slippagePct:      z.number().min(0).max(0.05).default(0),
  commission:       z.number().min(0).max(100).default(0),
  maxOpenPositions: z.number().int().min(1).max(5).default(1),
  propFirmRules:    propFirmRulesSchema.optional(),
  sizing:           sizingSchema.optional(),
});
// Note: when strategyType is CUSTOM, customStrategy may be omitted in the
// body — the service falls back to the DSL persisted on the session from a
// previous run. Validation of "missing in both places" lives in the
// service so it can read the session row.

export async function runSessionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = runSchema.parse(req.body);
    await svc.triggerRun(req.currentUser!.userId, String(req.params.id), body);
    res.status(202).json({ status: 'success', message: 'Backtest queued' });
  } catch (e) { next(e); }
}

// GET /api/v1/backtesting/sessions/:id/run/status
export async function getRunStatusHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await svc.getRunStatus(req.currentUser!.userId, String(req.params.id));
    res.json({ status: 'success', data });
  } catch (e) { next(e); }
}

// GET /api/v1/backtesting/sessions/:id/candles
export async function getSessionCandlesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await svc.getSessionCandles(req.currentUser!.userId, String(req.params.id));
    res.json({ status: 'success', data });
  } catch (e) { next(e); }
}
