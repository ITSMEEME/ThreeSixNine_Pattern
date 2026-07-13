window.App = window.App || {};

App.SATS_PER_BTC = 1e8;

App.CONFIG = {
  symbol: 'btcusdt',
  feeRate: 0.001,          // 0.1% Opening/Closing Fee, wie LN Markets
  spread: 0.0005,          // 0.05% synthetischer Spread für Market Orders
  startBalanceSats: 1000000, // 0.01 BTC Startkapital
  klineLimit: 500,
  restBase: 'https://api.binance.com/api/v3/klines',
  wsBase: 'wss://stream.binance.com:9443/ws/'
};
