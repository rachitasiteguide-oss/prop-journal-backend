// Prop-firm challenge rule simulation.
//
// Each scenario builds a deterministic candle sequence and a hand-rolled
// signal array, then runs runEventLoopPure with a PropFirmRulesConfig and
// asserts the resulting challengeResult. Position sizing is calibrated so
// price moves register as proportional equity moves:
//   volume=100, entry≈$100 → $10k notional, matches the $10k startingBalance.
//   So a 5% price drop ≈ 5% equity drop, mirroring real prop-firm leverage.

import { describe, it, expect } from 'vitest';
import {
  runEventLoopPure,
  type PureCandle,
  type PureEngineConfig,
  type Signal,
} from '../backtestEngineCore';

interface CandleSpec {
  day: number;
  open: number;
  high?: number;
  low?: number;
  close: number;
}

function candles(specs: CandleSpec[]): PureCandle[] {
  return specs.map((s) => ({
    openTime: new Date(Date.UTC(2024, 0, s.day)),
    open:   s.open,
    high:   s.high  ?? Math.max(s.open, s.close),
    low:    s.low   ?? Math.min(s.open, s.close),
    close:  s.close,
    volume: 1000,
  }));
}

const baseConfig: PureEngineConfig = {
  strategyType:     'CUSTOM',
  strategyConfig:   {},
  startingBalance:  10_000,
  volume:           100,           // 100 shares × $100 = $10k notional
  stopLossPct:      0.50,          // wide so SL doesn't pre-empt rule breach
  takeProfitRatio:  10,            // wide TP for same reason
  slippagePct:      0,
  commission:       0,
  maxOpenPositions: 1,
  instrumentType:   'STOCKS',
};

// ── Scenarios ────────────────────────────────────────────────────────────────

describe('PropFirmRules: daily loss limit', () => {
  it('FAILS with DAILY_LOSS when single-day drawdown exceeds limit', () => {
    // Volume 100, BUY enters day 2 at $100. Day 2 close $94 → PnL -$600 →
    // -6% from start-of-day. With 5% daily limit, breach on day 2.
    const c = candles([
      { day: 1, open: 100, close: 100 },                       // signal bar
      { day: 2, open: 100, high: 100, low: 94, close: 94 },    // entry + drop
      { day: 3, open: 94,  close: 95 },
    ]);
    const signals: Signal[] = ['BUY', null, null];

    const cfg: PureEngineConfig = {
      ...baseConfig,
      propFirmRules: { enabled: true, dailyLossLimitPct: 0.05 },
    };

    const { diagnostics } = runEventLoopPure(c, signals, cfg, 'TEST');
    expect(diagnostics.challengeResult).toBeDefined();
    expect(diagnostics.challengeResult!.status).toBe('FAILED');
    expect(diagnostics.challengeResult!.breachedRule).toBe('DAILY_LOSS');
  });

  it('does not fail when daily losses stay below limit', () => {
    const c = candles([
      { day: 1, open: 100, close: 100 },
      { day: 2, open: 100, close: 101 },
      { day: 3, open: 101, close: 102 },
      { day: 4, open: 102, close: 103 },
    ]);
    const signals: Signal[] = ['BUY', null, null, null];

    const cfg: PureEngineConfig = {
      ...baseConfig,
      propFirmRules: { enabled: true, dailyLossLimitPct: 0.05 },
    };

    const { diagnostics } = runEventLoopPure(c, signals, cfg, 'TEST');
    expect(diagnostics.challengeResult!.status).not.toBe('FAILED');
    expect(diagnostics.challengeResult!.breachedRule).toBeUndefined();
  });
});

describe('PropFirmRules: maxLoss (static from start)', () => {
  it('FAILS with MAX_LOSS when equity drops 10% below startingBalance', () => {
    // BUY at $100 (day 2). Day 2 close $88 → PnL = (88-100)×100 = -$1200 →
    // equity $8800 → 12% below start. 10% maxLoss → breach.
    const c = candles([
      { day: 1, open: 100, close: 100 },
      { day: 2, open: 100, high: 100, low: 88, close: 88 },
      { day: 3, open: 88,  close: 90 },
    ]);
    const signals: Signal[] = ['BUY', null, null];

    const cfg: PureEngineConfig = {
      ...baseConfig,
      propFirmRules: { enabled: true, maxLossPct: 0.10 },
    };

    const { diagnostics } = runEventLoopPure(c, signals, cfg, 'TEST');
    expect(diagnostics.challengeResult!.status).toBe('FAILED');
    expect(diagnostics.challengeResult!.breachedRule).toBe('MAX_LOSS');
    expect(diagnostics.challengeResult!.breachEquity!).toBeLessThan(9000);
  });
});

describe('PropFirmRules: trailing max DD', () => {
  it('FAILS with TRAILING_DD when equity drops X% from HWM', () => {
    // BUY at $100, peak close $112 → equity $11,200 (HWM). Drop to close
    // $103 → equity $10,300 → -8% from HWM. 5% trailing limit → breach.
    const c = candles([
      { day: 1, open: 100, close: 100 },
      { day: 2, open: 100, close: 100 },  // entry
      { day: 3, open: 100, close: 108 },
      { day: 4, open: 108, close: 112 },  // HWM
      { day: 5, open: 112, high: 112, low: 103, close: 103 },
    ]);
    const signals: Signal[] = ['BUY', null, null, null, null];

    const cfg: PureEngineConfig = {
      ...baseConfig,
      propFirmRules: { enabled: true, trailingMaxDDPct: 0.05 },
    };

    const { diagnostics } = runEventLoopPure(c, signals, cfg, 'TEST');
    expect(diagnostics.challengeResult!.status).toBe('FAILED');
    expect(diagnostics.challengeResult!.breachedRule).toBe('TRAILING_DD');
    expect(diagnostics.challengeResult!.highWaterMark).toBeGreaterThanOrEqual(11_000);
  });
});

describe('PropFirmRules: profit target', () => {
  it('PASSES when profit target hit and minTradingDays satisfied', () => {
    // Need +6% = +$600. Entry $100 → $107 close = +$700 PnL with volume 100.
    // Force-close at end-of-data realises the gain. minTradingDays=1 is met.
    const c = candles([
      { day: 1, open: 100, close: 100 },
      { day: 2, open: 100, close: 100 },  // entry day
      { day: 3, open: 100, close: 107 },  // target hit (equity ~10,700)
      { day: 4, open: 107, close: 107 },
    ]);
    const signals: Signal[] = ['BUY', null, null, null];

    const cfg: PureEngineConfig = {
      ...baseConfig,
      propFirmRules: {
        enabled:         true,
        profitTargetPct: 0.06,
        minTradingDays:  1,
      },
    };

    const { diagnostics } = runEventLoopPure(c, signals, cfg, 'TEST');
    expect(diagnostics.challengeResult!.profitTargetHitDate).toBeDefined();
    expect(diagnostics.challengeResult!.status).toBe('PASSED');
  });

  it('stays IN_PROGRESS when target hit but minTradingDays NOT met', () => {
    // Hit target on day 3 but minTradingDays=10 is unreachable.
    const c = candles([
      { day: 1, open: 100, close: 100 },
      { day: 2, open: 100, close: 100 },
      { day: 3, open: 100, close: 107 },
      { day: 4, open: 107, close: 107 },
    ]);
    const signals: Signal[] = ['BUY', null, null, null];

    const cfg: PureEngineConfig = {
      ...baseConfig,
      propFirmRules: {
        enabled:         true,
        profitTargetPct: 0.06,
        minTradingDays:  10,
      },
    };

    const { diagnostics } = runEventLoopPure(c, signals, cfg, 'TEST');
    expect(diagnostics.challengeResult!.profitTargetHitDate).toBeDefined();
    expect(diagnostics.challengeResult!.status).toBe('IN_PROGRESS');
    expect(diagnostics.challengeResult!.tradingDaysCount).toBeLessThan(10);
  });
});

describe('PropFirmRules: maxTradingDays expiry', () => {
  it('EXPIRES when calendar days exceed maxTradingDays', () => {
    const specs: CandleSpec[] = [];
    for (let d = 1; d <= 10; d++) {
      specs.push({ day: d, open: 100 + d, close: 100 + d });
    }
    const c = candles(specs);
    const signals: Signal[] = c.map(() => null);
    signals[0] = 'BUY';

    const cfg: PureEngineConfig = {
      ...baseConfig,
      propFirmRules: { enabled: true, maxTradingDays: 3 },
    };

    const { diagnostics } = runEventLoopPure(c, signals, cfg, 'TEST');
    expect(diagnostics.challengeResult!.status).toBe('EXPIRED');
    expect(diagnostics.challengeResult!.breachedRule).toBe('TIME_EXPIRED');
  });
});

describe('PropFirmRules: disabled', () => {
  it('emits no challengeResult when rules.enabled is false', () => {
    const c = candles([
      { day: 1, open: 100, close: 100 },
      { day: 2, open: 100, close: 88 },
    ]);
    const signals: Signal[] = ['BUY', null];

    const cfg: PureEngineConfig = {
      ...baseConfig,
      propFirmRules: { enabled: false, maxLossPct: 0.05 },
    };

    const { diagnostics } = runEventLoopPure(c, signals, cfg, 'TEST');
    expect(diagnostics.challengeResult).toBeUndefined();
  });

  it('emits no challengeResult when propFirmRules omitted entirely', () => {
    const c = candles([
      { day: 1, open: 100, close: 100 },
      { day: 2, open: 100, close: 88 },
    ]);
    const signals: Signal[] = ['BUY', null];

    const { diagnostics } = runEventLoopPure(c, signals, baseConfig, 'TEST');
    expect(diagnostics.challengeResult).toBeUndefined();
  });
});

describe('PropFirmRules: breach metadata', () => {
  it('records breach date, equity, and trade count on FAILED', () => {
    const c = candles([
      { day: 1, open: 100, close: 100 },
      { day: 2, open: 100, high: 100, low: 88, close: 88 },
    ]);
    const signals: Signal[] = ['BUY', null];

    const cfg: PureEngineConfig = {
      ...baseConfig,
      propFirmRules: { enabled: true, maxLossPct: 0.10 },
    };

    const { diagnostics, closedTrades } = runEventLoopPure(c, signals, cfg, 'TEST');
    const r = diagnostics.challengeResult!;
    expect(r.breachDate).toBeDefined();
    expect(r.breachEquity).toBeLessThan(10_000);
    // Force-closed by the breach handler — one trade in the closedTrades array.
    expect(closedTrades.length).toBe(1);
    expect(closedTrades[0].forceClosed).toBe(true);
  });
});
