import { describe, it, expect } from 'vitest';
import { computeStats } from '../aiService';

function t(setup: string | null, pnl: number | null) {
  return { setup, pnl, exitAt: new Date() };
}

describe('aiService.computeStats', () => {
  it('returns empty stats when no closed trades', () => {
    const s = computeStats([]);
    expect(s.totalClosed).toBe(0);
    expect(s.patterns).toHaveLength(0);
    expect(s.bestPattern).toBeNull();
    expect(s.winRate).toBe(0);
  });

  it('ignores trades with null pnl', () => {
    const s = computeStats([t('A', null), t('A', 10), t('A', 20)]);
    expect(s.totalClosed).toBe(2);
  });

  it('groups by setup and drops patterns below the minimum sample', () => {
    const s = computeStats([
      t('Breakout', 10),
      t('Breakout', -5),
      t('Breakout', 15),
      t('OneOff', 50),
      t('OneOff', 50),
    ]);
    // Breakout has 3 (>= min), OneOff has 2 (< min) → only Breakout kept
    expect(s.patterns.map((p) => p.setup)).toEqual(['Breakout']);
    expect(s.totalClosed).toBe(5);
  });

  it('computes win rate, profit factor and expectancy correctly', () => {
    const s = computeStats([
      t('Edge', 100),
      t('Edge', 100),
      t('Edge', -50),
    ]);
    const p = s.patterns[0];
    expect(p.tradeCount).toBe(3);
    expect(p.winRate).toBeCloseTo((2 / 3) * 100, 5);
    expect(p.profitFactor).toBeCloseTo(200 / 50, 5);
    expect(p.expectancy).toBeCloseTo(150 / 3, 5);
    expect(p.bestTrade).toBe(100);
    expect(p.worstTrade).toBe(-50);
  });

  it('caps profit factor when there are no losses', () => {
    const s = computeStats([t('Clean', 10), t('Clean', 20), t('Clean', 30)]);
    expect(s.patterns[0].profitFactor).toBe(99);
  });

  it('identifies best and worst patterns by expectancy', () => {
    const s = computeStats([
      t('Winner', 100),
      t('Winner', 100),
      t('Winner', 100),
      t('Loser', -40),
      t('Loser', -40),
      t('Loser', -40),
    ]);
    expect(s.bestPattern?.setup).toBe('Winner');
    expect(s.worstPattern?.setup).toBe('Loser');
  });

  it('buckets blank/whitespace setups under Unlabelled', () => {
    const s = computeStats([t(null, 5), t('  ', 5), t('', 5)]);
    expect(s.patterns[0].setup).toBe('Unlabelled');
    expect(s.patterns[0].tradeCount).toBe(3);
  });
});
