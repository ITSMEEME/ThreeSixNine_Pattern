window.App = window.App || {};

// Analyzes why trades closed at a loss and turns recurring patterns into concrete "veto rules"
// that can block future trades resembling those conditions — the "Fine-Tune" layer the base
// strategy's signal has to pass through before a trade is actually opened.
App.TradeAnalyzer = {

  REASON_LABELS: {
    counter_trend: 'Gegen den übergeordneten Trend eröffnet',
    high_volatility: 'Hohe Marktvolatilität zum Einstiegszeitpunkt',
    against_momentum: 'Einstieg gegen die unmittelbare Kursbewegung',
    liquidation_cascade: 'Möglicher Flash-Move / Liquidationskaskade kurz vor Einstieg',
    choppy_market: 'Seitwärts / instabiler Markt (Whipsaw-Gefahr)',
    unclear: 'Keine eindeutige Erklärung gefunden (evtl. normales Trade-Risiko)'
  },

  // --- Analysis: given a finished backtest's candles + tradeLog, explain every losing trade ---

  analyzeLosses(candles1m, tradeLog) {
    const losses = (tradeLog || []).filter(t => t.pnlSats < 0);
    const explained = losses.map(t => this.explainTrade(candles1m, t));
    const summary = this.summarize(explained, losses.length);
    return {
      totalTrades: tradeLog ? tradeLog.length : 0,
      totalLosses: losses.length,
      explained,
      summary
    };
  },

  explainTrade(candles1m, trade) {
    const direction = trade.side;
    const reasons = [];
    let regime = { regime: 'sideways', volatility: 'low', avgVolume: 0 };

    if (trade.features) {
      const f = trade.features;
      const isBull = f.trendAlignment > 1.5;
      const isBear = f.trendAlignment < -1.5;
      const vol = f.volatilityPct > 0.08 ? 'high' : 'low';
      
      regime = {
        regime: isBull ? 'bullish_trend' : (isBear ? 'bearish_trend' : 'sideways'),
        volatility: vol,
        avgVolume: 0
      };

      if (isBear && direction === 'long') reasons.push('counter_trend');
      if (isBull && direction === 'short') reasons.push('counter_trend');
      if (vol === 'high') reasons.push('high_volatility');
      if (!isBull && !isBear && vol === 'high') reasons.push('choppy_market');

      if (f.momentumAlignment < -0.5) reasons.push('against_momentum');
      if (f.volumeSpikeRatio > 3 && f.cascadeMovePct > 0.8) reasons.push('liquidation_cascade');
    } else if (candles1m) {
      const idx = this.findCandleIndex(candles1m, Math.floor(trade.entryTime / 1000));

      // 1. Market regime over the preceding ~4h (240 * 1m candles)
      const regimeWindow = candles1m.slice(Math.max(0, idx - 240), idx + 1);
      regime = App.Optimizer.classifyMarket(regimeWindow);
      if (regime.regime === 'bearish_trend' && direction === 'long') reasons.push('counter_trend');
      if (regime.regime === 'bullish_trend' && direction === 'short') reasons.push('counter_trend');
      if (regime.volatility === 'high') reasons.push('high_volatility');
      if (regime.regime === 'sideways' && regime.volatility === 'high') reasons.push('choppy_market');

      // 2. Immediate momentum against the trade direction (last 15 candles before entry)
      const momentumWindow = candles1m.slice(Math.max(0, idx - 15), idx + 1);
      if (momentumWindow.length >= 2) {
        const priceChange = (momentumWindow[momentumWindow.length - 1].close - momentumWindow[0].open) / momentumWindow[0].open;
        if (direction === 'long' && priceChange < -0.005) reasons.push('against_momentum');
        if (direction === 'short' && priceChange > 0.005) reasons.push('against_momentum');
      }

      // 3. Volume-spike + abnormal move proxy for a flash-move / liquidation cascade
      if (this.detectCascade(candles1m, idx)) reasons.push('liquidation_cascade');
    }

    if (reasons.length === 0) reasons.push('unclear');

    return {
      trade,
      regime,
      reasons: reasons.map(code => ({ code, label: this.REASON_LABELS[code] }))
    };
  },

  detectCascade(candles1m, idx) {
    const cascadeWindow = candles1m.slice(Math.max(0, idx - 5), idx + 1);
    if (cascadeWindow.length < 2) return false;
    const priorWindow = candles1m.slice(Math.max(0, idx - 100), Math.max(0, idx - 5));
    const avgVolume = this.averageVolume(priorWindow);
    const recentMaxVolume = Math.max(...cascadeWindow.map(c => c.volume || 0), 0);
    const cascadeMove = Math.abs((cascadeWindow[cascadeWindow.length - 1].close - cascadeWindow[0].open) / cascadeWindow[0].open);
    return avgVolume > 0 && recentMaxVolume > avgVolume * 3 && cascadeMove > 0.008;
  },

  // --- Epochen & Marktgesetze-Bibliothek ---
  //
  // Ziel: nicht bei jeder einzelnen Analyse sofort das Live-Verhalten ändern (Oszillations-
  // gefahr), sondern erst wenn sich ein Muster über mehrere unabhängige Trainings-Epochen UND
  // verschiedene Marktphasen hinweg wiederholt bestätigt. Einzelne "Ausreißer-Epochen" können
  // ein bestätigtes Gesetz auch nicht sofort wieder kippen — Auf/Abstufung braucht mehrere
  // aufeinanderfolgende Bestätigungen bzw. Widerlegungen.

  LIBRARY_MIN_CONFIRMATIONS: 3,
  LIBRARY_MIN_PHASES: 2,
  LIBRARY_LOOKBACK_EPOCHS: 10,
  LIBRARY_DEMOTE_STREAK: 3,

  // Records one completed analysis run (rule-based or ML) as a new "epoch" in the library.
  // Does NOT itself change any live-active filter — only recomputeLibrary() + an explicit
  // "auf Live-Bot anwenden"-Klick tun das.
  recordEpoch(epoch) {
    App.state.mlLibrary.epochs.push({
      epochId: 'epoch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      timestamp: Date.now(),
      ...epoch
    });
    // Keep a generous but bounded history (200 epochs) so localStorage doesn't grow unbounded
    if (App.state.mlLibrary.epochs.length > 200) {
      App.state.mlLibrary.epochs = App.state.mlLibrary.epochs.slice(-200);
    }
    this.recomputeLibrary();
    App.saveToLocalStorage();
  },

  recomputeLibrary() {
    const allEpochs = App.state.mlLibrary.epochs;

    // --- Regelbasierte Muster ---
    const ruleCodes = Object.keys(this.REASON_LABELS).filter(c => c !== 'unclear');
    const rules = {};
    ruleCodes.forEach(code => {
      const relevant = allEpochs.filter(e => e.type === 'rule' && e.ruleFindings && e.ruleFindings[code]).slice(-this.LIBRARY_LOOKBACK_EPOCHS);
      const prior = App.state.mlLibrary.rules[code];
      rules[code] = this.computeEntryStatus(relevant, e => e.ruleFindings[code].significant, prior);
    });

    // --- ML-Feature-Konsistenz ---
    const mlFeatures = {};
    this.ML_FEATURE_NAMES.forEach(name => {
      const relevant = allEpochs.filter(e => e.type === 'ml' && e.mlFindings && e.mlFindings[name]).slice(-this.LIBRARY_LOOKBACK_EPOCHS);
      const prior = App.state.mlLibrary.mlFeatures[name];
      // "significant" for an ML feature = its weight sign matches the majority sign among
      // relevant epochs so far (consistency), and the weight is non-trivial in size
      const majoritySign = this.majoritySign(relevant.map(e => e.mlFindings[name].weight));
      const isConsistent = (e) => Math.sign(e.mlFindings[name].weight) === majoritySign && Math.abs(e.mlFindings[name].weight) > 0.15;
      mlFeatures[name] = { ...this.computeEntryStatus(relevant, isConsistent, prior), majoritySign };
    });

    App.state.mlLibrary.rules = rules;
    App.state.mlLibrary.mlFeatures = mlFeatures;
  },

  majoritySign(weights) {
    const pos = weights.filter(w => w > 0).length;
    const neg = weights.filter(w => w < 0).length;
    return pos >= neg ? 1 : -1;
  },

  // Shared promotion/demotion state machine for both rule codes and ML features
  computeEntryStatus(relevantEpochs, isSignificantFn, prior) {
    const total = relevantEpochs.length;
    const significantEpochs = relevantEpochs.filter(isSignificantFn);
    const significantCount = significantEpochs.length;
    const distinctPhases = new Set(significantEpochs.map(e => e.datasetRangeLabel || 'unbekannt')).size;

    // Trailing streak of the most recent epochs, for gradual demotion
    const recentStreak = relevantEpochs.slice(-this.LIBRARY_DEMOTE_STREAK);
    const recentAllMiss = recentStreak.length >= this.LIBRARY_DEMOTE_STREAK && recentStreak.every(e => !isSignificantFn(e));

    let status = prior && prior.status === 'confirmed' ? 'confirmed' : 'candidate';

    if (status === 'confirmed' && recentAllMiss) {
      status = 'candidate'; // graduelle Abstufung nach mehreren Fehlschlägen in Folge, nicht sofort
    } else if (status !== 'confirmed' && significantCount >= this.LIBRARY_MIN_CONFIRMATIONS && distinctPhases >= this.LIBRARY_MIN_PHASES) {
      status = 'confirmed';
    } else if (total < this.LIBRARY_MIN_CONFIRMATIONS) {
      status = 'insufficient_data';
    }

    return {
      status,
      totalEpochs: total,
      significantCount,
      distinctPhases,
      lastUpdated: Date.now()
    };
  },

  getConfirmedRuleCodes() {
    return Object.entries(App.state.mlLibrary.rules)
      .filter(([, v]) => v.status === 'confirmed')
      .map(([code]) => code);
  },

  averageVolume(candles) {
    if (!candles || candles.length === 0) return 0;
    return candles.reduce((s, c) => s + (c.volume || 0), 0) / candles.length;
  },

  // Binary search: index of the 1m candle at/just after the given unix-second timestamp
  findCandleIndex(candles1m, unixSec) {
    if (!candles1m || candles1m.length === 0) return 0;
    let lo = 0, hi = candles1m.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candles1m[mid].time < unixSec) lo = mid + 1; else hi = mid;
    }
    return lo;
  },

  summarize(explainedLosses, totalLosses) {
    const counts = {};
    explainedLosses.forEach(e => {
      e.reasons.forEach(r => {
        counts[r.code] = counts[r.code] || { code: r.code, label: r.label, count: 0 };
        counts[r.code].count++;
      });
    });
    const base = totalLosses || 1;
    return Object.values(counts)
      .map(c => ({ ...c, percent: Math.round((c.count / base) * 1000) / 10 }))
      .sort((a, b) => b.count - a.count);
  },

  // --- ML variant: logistic regression trained on continuous features instead of fixed rules ---

  ML_FEATURE_NAMES: ['trendAlignment', 'volatilityPct', 'momentumAlignment', 'volumeSpikeRatio', 'cascadeMovePct'],

  ML_FEATURE_LABELS: {
    trendAlignment: 'Ausrichtung zum Trend (negativ = Gegentrend)',
    volatilityPct: 'Marktvolatilität',
    momentumAlignment: 'Ausrichtung zum kurzfristigen Momentum (negativ = dagegen)',
    volumeSpikeRatio: 'Volumen-Spike-Verhältnis',
    cascadeMovePct: 'Kursbewegung kurz vor Einstieg (%)'
  },

  // Continuous, signed versions of the same signals the rule-based analysis uses — signed so
  // that "negative" always means "unfavorable for this trade direction", regardless of long/short.
  extractFeatures(candles1m, idx, direction) {
    const regimeWindow = candles1m.slice(Math.max(0, idx - 240), idx + 1);
    const firstClose = regimeWindow.length > 0 ? regimeWindow[0].close : candles1m[idx].close;
    const lastClose = candles1m[idx].close;
    const trendPct = firstClose ? ((lastClose - firstClose) / firstClose) * 100 : 0;
    const trendAlignment = direction === 'long' ? trendPct : -trendPct;

    let rangeSum = 0;
    regimeWindow.forEach(c => { rangeSum += ((c.high ?? c.close) - (c.low ?? c.close)) / c.close; });
    const volatilityPct = regimeWindow.length > 0 ? (rangeSum / regimeWindow.length) * 100 : 0;

    const momentumWindow = candles1m.slice(Math.max(0, idx - 15), idx + 1);
    let momentumPct = 0;
    if (momentumWindow.length >= 2) {
      momentumPct = ((momentumWindow[momentumWindow.length - 1].close - momentumWindow[0].open) / momentumWindow[0].open) * 100;
    }
    const momentumAlignment = direction === 'long' ? momentumPct : -momentumPct;

    const cascadeWindow = candles1m.slice(Math.max(0, idx - 5), idx + 1);
    const priorWindow = candles1m.slice(Math.max(0, idx - 100), Math.max(0, idx - 5));
    const avgVolume = this.averageVolume(priorWindow);
    const recentMaxVolume = cascadeWindow.length > 0 ? Math.max(...cascadeWindow.map(c => c.volume || 0)) : 0;
    const volumeSpikeRatio = avgVolume > 0 ? recentMaxVolume / avgVolume : 1;
    const cascadeMovePct = cascadeWindow.length >= 2
      ? Math.abs((cascadeWindow[cascadeWindow.length - 1].close - cascadeWindow[0].open) / cascadeWindow[0].open) * 100
      : 0;

    return { trendAlignment, volatilityPct, momentumAlignment, volumeSpikeRatio, cascadeMovePct };
  },

  // Trains a small logistic regression (via TF.js) predicting P(this trade will lose) from the
  // continuous features above. Runs entirely client-side; the trained model is reduced to plain
  // numbers afterwards (weights/bias/normalization) so it can be stored in localStorage and used
  // for inference without keeping TF.js tensors/model objects alive.
  // Chronological train/test split of trades (never shuffled — training must never "see" trades
  // that happened after the test window). Needs a reasonable minimum sample on both sides;
  // below that, ML training falls back to using all trades (flagged as in-sample only by the caller).
  splitTradesForValidation(tradeLog, trainRatio = 0.7, minTotal = 30) {
    const sorted = [...tradeLog].sort((a, b) => a.entryTime - b.entryTime);
    if (sorted.length < minTotal) return { trainTrades: sorted, testTrades: [], splitAvailable: false };
    const splitIdx = Math.floor(sorted.length * trainRatio);
    return { trainTrades: sorted.slice(0, splitIdx), testTrades: sorted.slice(splitIdx), splitAvailable: true };
  },

  // Evaluates a trained model on trades it never saw during training: how well does the
  // predicted loss-probability actually separate real winners from real losers?
  evaluateOOS(mlModel, candles1m, testTrades, threshold = 0.6) {
    if (!testTrades || testTrades.length === 0) return null;

    const predictions = testTrades.map(t => {
      const idx = candles1m ? this.findCandleIndex(candles1m, Math.floor(t.entryTime / 1000)) : 0;
      const p = this.predictLossProbability(mlModel, candles1m, idx, t.side, t.features);
      return { p, actualLoss: t.pnlSats < 0 };
    });

    const correct = predictions.filter(pr => (pr.p >= threshold) === pr.actualLoss).length;
    const accuracy = correct / predictions.length;

    const losers = predictions.filter(pr => pr.actualLoss);
    const winners = predictions.filter(pr => !pr.actualLoss);
    const avgPLosers = losers.length > 0 ? losers.reduce((s, pr) => s + pr.p, 0) / losers.length : null;
    const avgPWinners = winners.length > 0 ? winners.reduce((s, pr) => s + pr.p, 0) / winners.length : null;
    // How much higher the model rates actual losers vs actual winners — the real signal of
    // whether it learned something generalizable, independent of the fixed threshold
    const separation = (avgPLosers !== null && avgPWinners !== null) ? avgPLosers - avgPWinners : null;

    return { sampleSize: predictions.length, accuracy, avgPLosers, avgPWinners, separation };
  },

  async trainLossModel(candles1m, tradeLog, options = {}) {
    if (typeof tf === 'undefined') {
      throw new Error('TensorFlow.js konnte nicht geladen werden (Netzwerk/CDN-Problem).');
    }
    if (!tradeLog || tradeLog.length < 10) {
      throw new Error('Zu wenige Trades für ein sinnvolles Training (mindestens 10 nötig).');
    }

    const usePCA = options.usePCA !== false && typeof App.MLHelper?.pca === 'function';

    const rows = tradeLog.map(t => {
      let f = t.features;
      if (!f && candles1m) {
        const idx = this.findCandleIndex(candles1m, Math.floor(t.entryTime / 1000));
        f = this.extractFeatures(candles1m, idx, t.side);
      }
      if (!f) {
        throw new Error('Keine Features für den Trade vorhanden und keine Kerzendaten übergeben.');
      }
      return { features: this.ML_FEATURE_NAMES.map(n => f[n]), label: t.pnlSats < 0 ? 1 : 0 };
    });

    const lossCount = rows.filter(r => r.label === 1).length;
    const winCount = rows.length - lossCount;
    if (lossCount < 5 || winCount < 5) {
      throw new Error('Zu wenig Varianz zwischen Gewinn- und Verlust-Trades für ein Training (brauche beide Klassen mit ausreichend Beispielen).');
    }

    // PCA or Standard Z-Score Normalization
    let processedFeatures = [];
    let pcaModel = null;
    let normalization = null;
    let inputDim = this.ML_FEATURE_NAMES.length;

    if (usePCA) {
      const rawMatrix = rows.map(r => r.features);
      // Reduce from 5 features to 3 Principal Components
      pcaModel = App.MLHelper.pca(rawMatrix, 3);
      processedFeatures = pcaModel.transformed;
      inputDim = pcaModel.eigenvectors[0].length;
    } else {
      normalization = this.ML_FEATURE_NAMES.map((_, i) => {
        const vals = rows.map(r => r.features[i]);
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
        const std = Math.sqrt(variance) || 1;
        return { mean, std };
      });
      const normalizeRow = (features) => features.map((v, i) => (v - normalization[i].mean) / normalization[i].std);
      processedFeatures = rows.map(r => normalizeRow(r.features));
    }

    const xs = tf.tensor2d(processedFeatures);
    const ys = tf.tensor2d(rows.map(r => [r.label]));

    const total = rows.length;
    const classWeight = {
      0: total / (2 * winCount),   // Gewinn-Klasse (Label 0)
      1: total / (2 * lossCount)   // Verlust-Klasse (Label 1)
    };

    const model = tf.sequential();
    model.add(tf.layers.dense({
      units: 1,
      inputShape: [inputDim],
      activation: 'sigmoid',
      kernelRegularizer: tf.regularizers.l2({ l2: 0.01 })
    }));
    model.compile({ optimizer: tf.train.adam(0.05), loss: 'binaryCrossentropy', metrics: ['accuracy'] });

    const history = await model.fit(xs, ys, { epochs: 100, verbose: 0, classWeight });

    const weightsTensor = model.getWeights()[0];
    const biasTensor = model.getWeights()[1];
    const weights = Array.from(await weightsTensor.data());
    const bias = (await biasTensor.data())[0];
    const finalAccuracy = history.history.acc ? history.history.acc[history.history.acc.length - 1] : null;

    xs.dispose();
    ys.dispose();
    model.dispose();

    return {
      featureNames: this.ML_FEATURE_NAMES,
      weights,
      bias,
      normalization: normalization || null,
      pca: pcaModel || null,
      trainedOn: rows.length,
      trainedOnLosses: lossCount,
      trainingAccuracy: finalAccuracy,
      trainedAt: Date.now(),
      regularization: 'l2',
      l2Lambda: 0.01,
      classWeights: classWeight
    };
  },

  // Pure-JS inference (dot product + sigmoid)
  predictLossProbability(mlModel, candles1m, idx, direction, preCalculatedFeatures = null) {
    const f = preCalculatedFeatures || this.extractFeatures(candles1m, idx, direction);
    const raw = mlModel.featureNames.map(n => f[n]);

    let inputVector;
    if (mlModel.pca && typeof App.MLHelper?.projectPCA === 'function') {
      // Unsupervised PCA projection
      inputVector = App.MLHelper.projectPCA(raw, mlModel.pca);
    } else if (mlModel.normalization) {
      // Legacy supervised z-score normalization fallback
      inputVector = raw.map((v, i) => (v - mlModel.normalization[i].mean) / mlModel.normalization[i].std);
    } else {
      inputVector = raw;
    }

    let z = mlModel.bias;
    for (let i = 0; i < inputVector.length; i++) {
      z += inputVector[i] * mlModel.weights[i];
    }
    return 1 / (1 + Math.exp(-z));
  },

  shouldVetoML(mlModel, candles1m, idx, direction, threshold = 0.6) {
    if (!mlModel) return null;
    const p = this.predictLossProbability(mlModel, candles1m, idx, direction);
    return p >= threshold ? p : null;
  },

  // --- Feedback loop: turn frequent-enough loss patterns into concrete veto rules ---

  // Only patterns explaining a large enough share of losses (and a minimum sample size) become
  // an actual filter — guards against overfitting the veto layer to a handful of trades.
  deriveVetoRules(summary, totalLosses, minShare = 0.25, minCount = 5) {
    return summary.filter(s => s.code !== 'unclear' && s.count >= minCount && (totalLosses > 0 && (s.count / totalLosses) >= minShare));
  },

  // Real-time / backtest-time check: does the current candle context match one of the active
  // learned veto patterns for a potential trade in this direction? Returns the matching code, or null.
  shouldVeto(candles1m, idx, direction, activeVetoCodes, preCalculatedFeatures = null) {
    if (!activeVetoCodes || activeVetoCodes.length === 0) return null;

    if (preCalculatedFeatures) {
      const f = preCalculatedFeatures;
      const isBull = f.trendAlignment > 1.5;
      const isBear = f.trendAlignment < -1.5;
      const vol = f.volatilityPct > 0.08 ? 'high' : 'low';
      const regimeStr = isBull ? 'bullish_trend' : (isBear ? 'bearish_trend' : 'sideways');

      if (activeVetoCodes.includes('counter_trend')) {
        if (regimeStr === 'bearish_trend' && direction === 'long') return 'counter_trend';
        if (regimeStr === 'bullish_trend' && direction === 'short') return 'counter_trend';
      }
      if (activeVetoCodes.includes('high_volatility') && vol === 'high') return 'high_volatility';
      if (activeVetoCodes.includes('choppy_market') && regimeStr === 'sideways' && vol === 'high') return 'choppy_market';

      if (activeVetoCodes.includes('against_momentum')) {
        if (f.momentumAlignment < -0.5) return 'against_momentum';
      }

      if (activeVetoCodes.includes('liquidation_cascade')) {
        if (f.volumeSpikeRatio > 3 && f.cascadeMovePct > 0.8) return 'liquidation_cascade';
      }

      return null;
    }

    const needsRegime = activeVetoCodes.some(c => ['counter_trend', 'high_volatility', 'choppy_market'].includes(c));
    let regime = null;
    if (needsRegime) {
      const regimeWindow = candles1m.slice(Math.max(0, idx - 240), idx + 1);
      regime = App.Optimizer.classifyMarket(regimeWindow);
    }

    if (activeVetoCodes.includes('counter_trend')) {
      if (regime.regime === 'bearish_trend' && direction === 'long') return 'counter_trend';
      if (regime.regime === 'bullish_trend' && direction === 'short') return 'counter_trend';
    }
    if (activeVetoCodes.includes('high_volatility') && regime.volatility === 'high') return 'high_volatility';
    if (activeVetoCodes.includes('choppy_market') && regime.regime === 'sideways' && regime.volatility === 'high') return 'choppy_market';

    if (activeVetoCodes.includes('against_momentum')) {
      const momentumWindow = candles1m.slice(Math.max(0, idx - 15), idx + 1);
      if (momentumWindow.length >= 2) {
        const priceChange = (momentumWindow[momentumWindow.length - 1].close - momentumWindow[0].open) / momentumWindow[0].open;
        if (direction === 'long' && priceChange < -0.005) return 'against_momentum';
        if (direction === 'short' && priceChange > 0.005) return 'against_momentum';
      }
    }

    if (activeVetoCodes.includes('liquidation_cascade') && this.detectCascade(candles1m, idx)) {
      return 'liquidation_cascade';
    }

    return null;
  }
};
