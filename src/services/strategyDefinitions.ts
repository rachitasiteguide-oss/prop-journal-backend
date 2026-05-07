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
  STOCHASTIC_CROSS: {
    label: 'Stochastic Oscillator',
    description: 'Buy when %K crosses above %D below 20 (oversold). Sell when %K crosses below %D above 80.',
    params: [
      { key: 'period',       label: 'K Period',      type: 'number', default: 14, min: 5,  max: 30 },
      { key: 'signalPeriod', label: 'D Period',       type: 'number', default: 3,  min: 2,  max: 10 },
      { key: 'oversold',     label: 'Oversold Zone',  type: 'number', default: 20, min: 10, max: 35 },
      { key: 'overbought',   label: 'Overbought Zone',type: 'number', default: 80, min: 65, max: 90 },
    ],
  },
  ADX_TREND: {
    label: 'ADX Trend Filter',
    description: 'Enter in the direction of trend (DI+ vs DI−) when ADX confirms trend strength above threshold.',
    params: [
      { key: 'period',    label: 'ADX Period',     type: 'number', default: 14, min: 7,  max: 30 },
      { key: 'threshold', label: 'ADX Threshold',  type: 'number', default: 25, min: 15, max: 50 },
    ],
  },
  DONCHIAN_BREAKOUT: {
    label: 'Donchian Channel Breakout',
    description: 'Buy when close exceeds the N-period highest high. Sell when close falls below the N-period lowest low.',
    params: [
      { key: 'period', label: 'Channel Period', type: 'number', default: 20, min: 5, max: 100 },
    ],
  },
  CCI_REVERSAL: {
    label: 'CCI Reversal',
    description: 'Buy when CCI crosses above -100 (oversold recovery). Sell when CCI crosses below +100.',
    params: [
      { key: 'period',     label: 'CCI Period',        type: 'number', default: 20,  min: 5,   max: 50  },
      { key: 'oversold',   label: 'Oversold Level',    type: 'number', default: -100, min: -200, max: -50 },
      { key: 'overbought', label: 'Overbought Level',  type: 'number', default: 100,  min: 50,  max: 200 },
    ],
  },
  WILLIAMS_R: {
    label: 'Williams %R Reversal',
    description: 'Buy when Williams %R crosses above -80 (oversold). Sell when it crosses below -20 (overbought).',
    params: [
      { key: 'period',     label: 'Lookback Period', type: 'number', default: 14, min: 5,  max: 50  },
      { key: 'oversold',   label: 'Oversold Level',  type: 'number', default: -80, min: -95, max: -60 },
      { key: 'overbought', label: 'Overbought Level',type: 'number', default: -20, min: -40, max: -5  },
    ],
  },
  RSI_MA_COMBO: {
    label: 'RSI + MA Trend Filter',
    description: 'Buy when RSI is oversold AND price is above the trend MA. Sell when RSI is overbought AND price is below the trend MA.',
    params: [
      { key: 'rsiPeriod',   label: 'RSI Period',     type: 'number', default: 14,  min: 5,  max: 30  },
      { key: 'oversold',    label: 'RSI Oversold',   type: 'number', default: 30,  min: 15, max: 45  },
      { key: 'overbought',  label: 'RSI Overbought', type: 'number', default: 70,  min: 55, max: 85  },
      { key: 'maPeriod',    label: 'Trend MA Period',type: 'number', default: 50,  min: 10, max: 200 },
      { key: 'maType',      label: 'MA Type',        type: 'select', default: 'EMA', options: ['EMA', 'SMA'] },
    ],
  },
  CUSTOM: {
    label: 'Custom Strategy',
    description: 'Define your own strategy using the visual strategy builder with any combination of indicators and conditions.',
    params: [],
  },
} as const;

export type StrategyType = keyof typeof STRATEGY_CATALOG;
