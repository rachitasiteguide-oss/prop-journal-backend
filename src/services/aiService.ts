import { prisma } from '../config/db';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { AiInsightKind } from '@prisma/client';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PatternStat {
  setup: string;
  tradeCount: number;
  winRate: number; // 0-100
  avgPnL: number;
  profitFactor: number; // Infinity-safe (capped)
  expectancy: number;
  grossProfit: number;
  grossLoss: number;
  bestTrade: number;
  worstTrade: number;
}

export interface TradeStats {
  totalClosed: number;
  totalPnL: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  bestPattern: PatternStat | null;
  worstPattern: PatternStat | null;
  patterns: PatternStat[];
}

export interface AiInsightResult {
  kind: AiInsightKind;
  model: string; // "anthropic" | "groq" | "rule-based"
  summary: string;
  stats: TradeStats;
  tradeCount: number;
  generatedAt: string;
}

interface ClosedTrade {
  setup: string | null;
  pnl: number | null;
  exitAt: Date | null;
}

// ── Stats computation ─────────────────────────────────────────────────────────

const MIN_TRADES_PER_PATTERN = 3;

function safePF(grossProfit: number, grossLoss: number): number {
  if (grossLoss === 0) return grossProfit > 0 ? 99 : 0;
  return Math.min(99, grossProfit / grossLoss);
}

export function computeStats(trades: ClosedTrade[]): TradeStats {
  const closed = trades.filter(
    (t): t is ClosedTrade & { pnl: number } => typeof t.pnl === 'number',
  );

  const bySetup = new Map<string, (ClosedTrade & { pnl: number })[]>();
  for (const t of closed) {
    const key = (t.setup ?? '').trim() || 'Unlabelled';
    const arr = bySetup.get(key) ?? [];
    arr.push(t);
    bySetup.set(key, arr);
  }

  const patterns: PatternStat[] = [];
  for (const [setup, group] of bySetup) {
    if (group.length < MIN_TRADES_PER_PATTERN) continue;
    const wins = group.filter((t) => t.pnl > 0);
    const losses = group.filter((t) => t.pnl < 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const total = group.reduce((s, t) => s + t.pnl, 0);
    patterns.push({
      setup,
      tradeCount: group.length,
      winRate: (wins.length / group.length) * 100,
      avgPnL: total / group.length,
      profitFactor: safePF(grossProfit, grossLoss),
      expectancy: total / group.length,
      grossProfit,
      grossLoss,
      bestTrade: Math.max(...group.map((t) => t.pnl)),
      worstTrade: Math.min(...group.map((t) => t.pnl)),
    });
  }

  patterns.sort((a, b) => b.expectancy - a.expectancy);

  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  return {
    totalClosed: closed.length,
    totalPnL: closed.reduce((s, t) => s + t.pnl, 0),
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    profitFactor: safePF(grossProfit, grossLoss),
    avgWin: wins.length ? grossProfit / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    bestPattern: patterns.length ? patterns[0] : null,
    worstPattern: patterns.length ? patterns[patterns.length - 1] : null,
    patterns,
  };
}

// ── Deterministic fallback narrative ──────────────────────────────────────────
// Used when no LLM key is configured, in tests, or when a provider errors.
// Plain, factual, no fabrication — derived purely from the computed numbers.

function ruleBasedSummary(stats: TradeStats, kind: AiInsightKind): string {
  if (stats.totalClosed === 0) {
    return 'Not enough closed trades yet to surface reliable patterns. Log and label more trades, then run the scan again.';
  }
  const lines: string[] = [];
  const scope = kind === 'WEEKLY_REVIEW' ? 'This week you' : 'Across your history you';
  lines.push(
    `${scope} closed ${stats.totalClosed} trades for a net of ${fmt(stats.totalPnL)}, a ${stats.winRate.toFixed(0)}% win rate and a ${stats.profitFactor.toFixed(2)} profit factor.`,
  );
  if (stats.bestPattern) {
    const p = stats.bestPattern;
    lines.push(
      `Your strongest setup is "${p.setup}" — ${p.tradeCount} trades, ${p.winRate.toFixed(0)}% wins, ${fmt(p.avgPnL)} average. Lean into this edge and size it consistently.`,
    );
  }
  if (stats.worstPattern && stats.worstPattern !== stats.bestPattern && stats.worstPattern.expectancy < 0) {
    const p = stats.worstPattern;
    lines.push(
      `"${p.setup}" is bleeding edge — ${p.tradeCount} trades at ${fmt(p.avgPnL)} average expectancy. Consider pausing it or tightening entry criteria until it proves out.`,
    );
  }
  if (stats.avgLoss > stats.avgWin && stats.avgWin > 0) {
    lines.push(
      `Your average loss (${fmt(stats.avgLoss)}) is larger than your average win (${fmt(stats.avgWin)}) — a risk-management issue. Cut losers faster or let winners run further.`,
    );
  }
  return lines.join(' ');
}

function fmt(v: number): string {
  const sign = v >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

// ── LLM provider abstraction ──────────────────────────────────────────────────
// Anthropic (production / Claude Haiku) → Groq (free testing tier) →
// null (caller uses the deterministic fallback). Implemented with global
// fetch so no SDK dependency is added and the build stays lean.

const LLM_TIMEOUT_MS = 20_000;

async function withTimeout(input: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(system: string, user: string): Promise<string | null> {
  if (!env.ANTHROPIC_API_KEY) return null;
  try {
    const res = await withTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL,
        max_tokens: 600,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) {
      logger.warn(`Anthropic AI call failed: ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { content?: { text?: string }[] };
    return data.content?.[0]?.text?.trim() || null;
  } catch (err) {
    logger.warn(`Anthropic AI call errored: ${(err as Error).message}`);
    return null;
  }
}

async function callGroq(system: string, user: string): Promise<string | null> {
  if (!env.GROQ_API_KEY) return null;
  try {
    const res = await withTimeout('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.GROQ_MODEL,
        max_tokens: 600,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      logger.warn(`Groq AI call failed: ${res.status}`);
      return null;
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    logger.warn(`Groq AI call errored: ${(err as Error).message}`);
    return null;
  }
}

interface Generated {
  summary: string;
  model: string;
}

async function generateNarrative(
  stats: TradeStats,
  kind: AiInsightKind,
): Promise<Generated> {
  if (stats.totalClosed === 0) {
    return { summary: ruleBasedSummary(stats, kind), model: 'rule-based' };
  }

  const system =
    'You are a concise, no-nonsense trading performance coach. Given a JSON ' +
    'summary of a trader\'s closed trades and per-setup pattern stats, write a ' +
    'short (max 5 sentences) actionable review. Reference specific setup names ' +
    'and numbers from the data. Never invent trades or numbers not present. No ' +
    'markdown, no preamble — just the review.';
  const user = `${kind === 'WEEKLY_REVIEW' ? 'Weekly review' : 'Full-history pattern scan'} data:\n${JSON.stringify(
    {
      totalClosed: stats.totalClosed,
      totalPnL: Number(stats.totalPnL.toFixed(2)),
      winRate: Number(stats.winRate.toFixed(1)),
      profitFactor: Number(stats.profitFactor.toFixed(2)),
      avgWin: Number(stats.avgWin.toFixed(2)),
      avgLoss: Number(stats.avgLoss.toFixed(2)),
      patterns: stats.patterns.slice(0, 10).map((p) => ({
        setup: p.setup,
        trades: p.tradeCount,
        winRate: Number(p.winRate.toFixed(1)),
        avgPnL: Number(p.avgPnL.toFixed(2)),
        profitFactor: Number(p.profitFactor.toFixed(2)),
      })),
    },
  )}`;

  const anthropic = await callAnthropic(system, user);
  if (anthropic) return { summary: anthropic, model: 'anthropic' };

  const groq = await callGroq(system, user);
  if (groq) return { summary: groq, model: 'groq' };

  return { summary: ruleBasedSummary(stats, kind), model: 'rule-based' };
}

// ── Public service API ────────────────────────────────────────────────────────

async function fetchClosedTrades(userId: string, since?: Date): Promise<ClosedTrade[]> {
  return prisma.trade.findMany({
    where: {
      account: { userId },
      status: 'CLOSED',
      pnl: { not: null },
      ...(since ? { exitAt: { gte: since } } : {}),
    },
    select: { setup: true, pnl: true, exitAt: true },
    orderBy: { exitAt: 'desc' },
  });
}

async function persist(
  userId: string,
  result: AiInsightResult,
): Promise<void> {
  await prisma.aiInsight.create({
    data: {
      userId,
      kind: result.kind,
      model: result.model,
      tradeCount: result.tradeCount,
      payload: result as unknown as object,
    },
  });
}

export async function runPatternScan(userId: string): Promise<AiInsightResult> {
  const trades = await fetchClosedTrades(userId);
  const stats = computeStats(trades);
  const { summary, model } = await generateNarrative(stats, 'PATTERN_SCAN');
  const result: AiInsightResult = {
    kind: 'PATTERN_SCAN',
    model,
    summary,
    stats,
    tradeCount: stats.totalClosed,
    generatedAt: new Date().toISOString(),
  };
  await persist(userId, result);
  return result;
}

export async function runWeeklyReview(userId: string): Promise<AiInsightResult> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const trades = await fetchClosedTrades(userId, since);
  const stats = computeStats(trades);
  const { summary, model } = await generateNarrative(stats, 'WEEKLY_REVIEW');
  const result: AiInsightResult = {
    kind: 'WEEKLY_REVIEW',
    model,
    summary,
    stats,
    tradeCount: stats.totalClosed,
    generatedAt: new Date().toISOString(),
  };
  await persist(userId, result);
  return result;
}

export async function getLatestInsight(
  userId: string,
  kind: AiInsightKind,
): Promise<AiInsightResult | null> {
  const row = await prisma.aiInsight.findFirst({
    where: { userId, kind },
    orderBy: { createdAt: 'desc' },
  });
  return row ? (row.payload as unknown as AiInsightResult) : null;
}
