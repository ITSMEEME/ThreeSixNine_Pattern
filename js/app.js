window.App = window.App || {};

App.init = () => {
  App.initState();
  App.Chart.initChart();
  App.UI.wireEvents();
  App.Backtest.wireBacktestEvents();
  App.loadFromLocalStorage();
  if (App.Backtest && App.Backtest.loadCachedCandles) {
    App.Backtest.loadCachedCandles().then(() => {
      if (App.UI && App.UI.syncResultsVisibility) {
        App.UI.syncResultsVisibility();
      }
    });
  }
  App.API.loadActiveIntervalsHistory();
  App.UI.switchTimeframe(App.state.timeframe || '15m');
  App.API.load1mHistory();
  App.API.load10mHistory();
  App.API.initWatchdog();
  App.UI.renderAll();
  App.UI.syncUIFromState();
  App.UI.renderLeaderboard('all');
  App.UI.renderHeatmaps();
  App.UI.renderWissensstand();
  
  setInterval(() => App.UI.updateHeaderStats(), 1000);
  setInterval(() => App.Bot.updateBotCooldownDisplay(), 1000);
};

// Run initialization once the DOM is fully parsed
window.addEventListener('DOMContentLoaded', () => {
  App.init();
});
