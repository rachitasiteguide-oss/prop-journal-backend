export const STRATEGY_CATALOG = {
  MA_CROSS: {
    label: 'Moving Average Crossover',
    description: 'Buy when fast MA crosses above slow MA. Sell when it crosses below.',
    params: [
      { key: 'fastPeriod', label: 'Fast MA Period', type: 'number', default: 10, min: 3,  max: 50  },
      { key: 'slowPeriod', label: 'Slow MA Period', type: 'number', default: 30, min: 10, max: 200 },
      { key: 'maType',     label: 'MA Type',        type: 'select', default: 'EMA', options: ['EMA', 'SMA'] },
    ],
  },
  RSI_REVERSAL: {
    label: 'RSI Mean Reversion',
    description: 'Buy when RSI rises above oversold. Sell when RSI rises above overbought.',
    params: [
      { key: 'period',     label: 'RSI Period',       type: 'number', default: 14, min: 5,  max: 30 },
      { key: 'oversold',   label: 'Oversold Level',   type: 'number', default: 30, min: 10, max: 45 },
      { key: 'overbought', label: 'Overbought Level', type: 'number', default: 70, min: 55, max: 90 },
    ],
  },
  MACD_SIGNAL: {
    label: 'MACD Signal Cross',
    description: 'Buy on MACD crossing above signal line. Sell on crossing below.',
    params: [
      { key: 'fastPeriod',   label: 'Fast Period',   type: 'number', default: 12, min: 5,  max: 30 },
      { key: 'slowPeriod',   label: 'Slow Period',   type: 'number', default: 26, min: 15, max: 60 },
      { key: 'signalPeriod', label: 'Signal Period', type: 'number', default: 9,  min: 5,  max: 20 },
    ],
  },
  BB_BREAKOUT: {
    label: 'Bollinger Band Breakout',
    description: 'Buy when price closes above upper band. Sell when it closes below lower band.',
    params: [
      { key: 'period', label: 'Period',  type: 'number', default: 20, min: 10, max: 50 },
      { key: 'stdDev', label: 'Std Dev', type: 'number', default: 2,  min: 1,  max: 4  },
    ],
  },
} as const;

export type StrategyType = keyof typeof STRATEGY_CATALOG;
