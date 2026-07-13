window.App = window.App || {};

App.Optimizer = {
  // Optimizer execution state
  state: {
    isRunning: false,
    phase: 1, // 1 to 7
    testsCompletedInPhase: 0,
    testsCompletedTotal: 0,
    currentPhaseTestsNeeded: 30, // Phase 1 starts with 30 random tests
    symbol: '',
    timeframe: '',
    bounds: {
      leverage: { min: 2, max: 50 },
      cooldownMin: { min: 5, max: 60 },
      tpPercent: { min: 5, max: 150 },
      slPercent: { min: 5, max: 100 },
      maxOpen: { min: 1, max: 20 }
    }
  },

  calculateScore(res) {
    // 1. Profit Score: 0% -> 0, 50%+ -> 100
    const profitScore = Math.min(100, Math.max(0, res.totalReturnPercent * 2));
    
    // 2. Profit Factor Score: PF=1 -> 0, PF=2 -> 50, PF=3+ -> 100
    const pfScore = Math.min(100, Math.max(0, (res.profitFactor - 1) * 50));
    
    // 3. Drawdown Penalty: Max Drawdown of 0% -> 100, 30%+ -> 0
    const ddScore = Math.max(0, 100 - (res.maxDrawdownPercent * 3.33));
    
    // 4. Winrate Score: winrate% directly
    const winrateScore = res.winRatePercent;
    
    // 5. Sharpe Proxy: (Return / Drawdown) normalized
    const sharpeScore = Math.min(100, res.maxDrawdownPercent > 0 ? (res.totalReturnPercent / res.maxDrawdownPercent) * 20 : 100);
    
    // 6. Trade Frequency Penalty: penalize too few trades (< 5) or noise (> 100)
    let tradeCountScore = 100;
    if (res.totalTrades === 0) tradeCountScore = 0;
    else if (res.totalTrades < 5) tradeCountScore = 30;
    else if (res.totalTrades < 10) tradeCountScore = 70;
    else if (res.totalTrades > 120) tradeCountScore = 60;

    const score = (profitScore * 0.40) + (pfScore * 0.20) + (ddScore * 0.20) + (winrateScore * 0.10) + (sharpeScore * 0.05) + (tradeCountScore * 0.05);
    return Math.round(score * 10) / 10;
  },

  getUniqueKey(symbol, rules, params) {
    // Unique key to prevent double testing
    const rulesStr = JSON.stringify(rules.long) + JSON.stringify(rules.short);
    return `${symbol.toUpperCase()}_${rulesStr}_${params.leverage}_${params.cooldownMin}_${params.tpPercent}_${params.slPercent}_${params.maxOpen}`;
  },

  checkCache(symbol, rules, params) {
    const key = this.getUniqueKey(symbol, rules, params);
    return App.state.optimizerDb[key] || null;
  },

  saveToDb(symbol, timeframe, rules, params, res, marketClass) {
    const key = this.getUniqueKey(symbol, rules, params);
    
    // Check if DB is getting too large (compaction if size > 400 entries)
    const entries = Object.keys(App.state.optimizerDb);
    if (entries.length > 400) {
      // Sort and keep top 200 strategies, delete rest to prevent localStorage overflow
      const sorted = Object.entries(App.state.optimizerDb)
        .sort((a, b) => b[1].score - a[1].score);
      App.state.optimizerDb = {};
      sorted.slice(0, 200).forEach(([k, v]) => {
        App.state.optimizerDb[k] = v;
      });
    }

    const score = this.calculateScore(res);
    App.state.optimizerDb[key] = {
      testId: 'opt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      timestamp: Date.now(),
      market: symbol.toUpperCase(),
      timeframe: timeframe,
      params: {
        leverage: params.leverage,
        cooldownMin: params.cooldownMin,
        tpPercent: params.tpPercent,
        slPercent: params.slPercent,
        maxOpen: params.maxOpen,
        rules: JSON.parse(JSON.stringify(rules))
      },
      results: {
        totalReturnPercent: res.totalReturnPercent,
        winRatePercent: res.winRatePercent,
        maxDrawdownPercent: res.maxDrawdownPercent,
        profitFactor: res.profitFactor,
        totalTrades: res.totalTrades,
        avgTradePercent: res.avgTradePercent || 0,
        maxLosingStreak: res.maxLosingStreak || 0,
        longTrades: res.longTrades || 0,
        shortTrades: res.shortTrades || 0
      },
      counts: {
        count369Long: res.count369Long || 0,
        count369Short: res.count369Short || 0
      },
      marketClass: marketClass,
      score: score
    };
    App.saveToLocalStorage();
  },

  classifyMarket(candles) {
    if (!candles || candles.length === 0) {
      return { regime: 'sideways', volatility: 'low', avgVolume: 0 };
    }
    const firstClose = candles[0].close;
    const lastClose = candles[candles.length - 1].close;
    const priceChangePct = ((lastClose - firstClose) / firstClose) * 100;
    
    let regime = 'sideways';
    if (priceChangePct > 1.5) regime = 'bullish_trend';
    else if (priceChangePct < -1.5) regime = 'bearish_trend';
    
    let rangeSum = 0;
    let volSum = 0;
    candles.forEach(c => {
      const high = c.high ?? c.close;
      const low = c.low ?? c.close;
      rangeSum += (high - low) / c.close;
      volSum += c.value ?? 0;
    });
    const avgRangePct = (rangeSum / candles.length) * 100;
    const volatility = avgRangePct > 0.08 ? 'high' : 'low';
    const avgVolume = Math.round(volSum / candles.length);
    
    return { regime, volatility, avgVolume };
  },

  analyzeParameters() {
    const db = Object.values(App.state.optimizerDb);
    if (db.length === 0) {
      return {
        weights: { leverage: 20, cooldownMin: 20, tpPercent: 20, slPercent: 20, maxOpen: 20 },
        ratings: { leverage: {}, cooldownMin: {}, tpPercent: {}, slPercent: {}, maxOpen: {} }
      };
    }
    
    const paramsKeys = ['leverage', 'cooldownMin', 'tpPercent', 'slPercent', 'maxOpen'];
    const weights = {};
    const ratings = {};
    
    paramsKeys.forEach(key => {
      const grouped = {};
      db.forEach(entry => {
        const val = entry.params[key];
        if (val !== undefined) {
          if (!grouped[val]) grouped[val] = [];
          grouped[val].push(entry.score);
        }
      });
      
      const averages = [];
      ratings[key] = {};
      for (let [val, scores] of Object.entries(grouped)) {
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        averages.push(avg);
        ratings[key][val] = Math.round(avg * 10) / 10;
      }
      
      if (averages.length > 1) {
        const max = Math.max(...averages);
        const min = Math.min(...averages);
        weights[key] = max - min;
      } else {
        weights[key] = 0;
      }
    });
    
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
    for (let key of paramsKeys) {
      weights[key] = Math.round((weights[key] / totalWeight) * 100);
    }
    
    return { weights, ratings };
  },

  getClusterBounds() {
    const db = Object.values(App.state.optimizerDb);
    const goodRuns = db.filter(x => x.score >= 70);
    if (goodRuns.length < 5) return null;
    
    const bounds = {
      leverage: { min: Infinity, max: -Infinity },
      cooldownMin: { min: Infinity, max: -Infinity },
      tpPercent: { min: Infinity, max: -Infinity },
      slPercent: { min: Infinity, max: -Infinity },
      maxOpen: { min: Infinity, max: -Infinity }
    };
    
    goodRuns.forEach(r => {
      const p = r.params;
      if (p.leverage < bounds.leverage.min) bounds.leverage.min = p.leverage;
      if (p.leverage > bounds.leverage.max) bounds.leverage.max = p.leverage;
      
      if (p.cooldownMin < bounds.cooldownMin.min) bounds.cooldownMin.min = p.cooldownMin;
      if (p.cooldownMin > bounds.cooldownMin.max) bounds.cooldownMin.max = p.cooldownMin;
      
      if (p.tpPercent < bounds.tpPercent.min) bounds.tpPercent.min = p.tpPercent;
      if (p.tpPercent > bounds.tpPercent.max) bounds.tpPercent.max = p.tpPercent;
      
      if (p.slPercent < bounds.slPercent.min) bounds.slPercent.min = p.slPercent;
      if (p.slPercent > bounds.slPercent.max) bounds.slPercent.max = p.slPercent;

      if (p.maxOpen !== undefined) {
        if (p.maxOpen < bounds.maxOpen.min) bounds.maxOpen.min = p.maxOpen;
        if (p.maxOpen > bounds.maxOpen.max) bounds.maxOpen.max = p.maxOpen;
      }
    });
    
    bounds.leverage.min = Math.max(2, bounds.leverage.min - 1);
    bounds.leverage.max = Math.min(50, bounds.leverage.max + 1);
    
    bounds.cooldownMin.min = Math.max(5, bounds.cooldownMin.min - 1);
    bounds.cooldownMin.max = Math.min(60, bounds.cooldownMin.max + 1);
    
    bounds.tpPercent.min = Math.max(5, bounds.tpPercent.min - 5);
    bounds.tpPercent.max = Math.min(150, bounds.tpPercent.max + 5);
    
    bounds.slPercent.min = Math.max(5, bounds.slPercent.min - 5);
    bounds.slPercent.max = Math.min(100, bounds.slPercent.max + 5);

    if (bounds.maxOpen.min === Infinity) {
      bounds.maxOpen = { min: 1, max: 20 };
    } else {
      bounds.maxOpen.min = Math.max(1, bounds.maxOpen.min - 1);
      bounds.maxOpen.max = Math.min(20, bounds.maxOpen.max + 1);
    }
    
    return bounds;
  },

  generateCandidate(bounds) {
    const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const randomFloat = (min, max, step) => {
      const val = Math.random() * (max - min) + min;
      return Math.round(val / step) * step;
    };
    
    return {
      leverage: randomInt(bounds.leverage.min, bounds.leverage.max),
      cooldownMin: randomInt(bounds.cooldownMin.min, bounds.cooldownMin.max),
      tpPercent: randomFloat(bounds.tpPercent.min, bounds.tpPercent.max, 5),
      slPercent: randomFloat(bounds.slPercent.min, bounds.slPercent.max, 5),
      maxOpen: randomInt(bounds.maxOpen.min, bounds.maxOpen.max)
    };
  },

  getWissensstand() {
    const db = Object.values(App.state.optimizerDb);
    const totalRuns = db.length;
    
    let goodClusters = 0;
    const bounds = this.getClusterBounds();
    if (bounds) goodClusters = 1;
    
    // Estimate bounds exclusion percentage relative to default bounds space
    let exclusionPercent = 0;
    if (bounds) {
      const defaultSpace = (48) * (55) * (145) * (95) * (20); // default search space including maxOpen (20 possible states)
      const currentSpace = (bounds.leverage.max - bounds.leverage.min + 1) *
                           (bounds.cooldownMin.max - bounds.cooldownMin.min + 1) *
                           ((bounds.tpPercent.max - bounds.tpPercent.min)/5 + 1) *
                           ((bounds.slPercent.max - bounds.slPercent.min)/5 + 1) *
                           (bounds.maxOpen.max - bounds.maxOpen.min + 1);
      exclusionPercent = Math.min(95, Math.round((1 - currentSpace / defaultSpace) * 100));
    }

    const bestStrategy = db.length > 0 ? db.sort((a, b) => b.score - a.score)[0] : null;

    // Most recent write to the learning memory, so the UI can show freshness/persistence clearly
    const lastUpdated = db.length > 0 ? Math.max(...db.map(e => e.timestamp || 0)) : null;

    return {
      totalRuns,
      goodClusters,
      exclusionPercent,
      bestScore: bestStrategy ? bestStrategy.score : 0,
      bestParams: bestStrategy ? bestStrategy.params : null,
      lastUpdated
    };
  },

  getLeaderboard(filterRegime = 'all') {
    let db = Object.values(App.state.optimizerDb);
    if (filterRegime !== 'all') {
      db = db.filter(x => x.marketClass && x.marketClass.regime === filterRegime);
    }
    return db.sort((a, b) => b.score - a.score).slice(0, 100);
  }
};
