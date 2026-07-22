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
    
    // 4. Winrate Score: Wilson score interval lower bound instead of the raw winrate, so a
    // 70% winrate from 5 trades is scored far more cautiously than 70% from 100 trades —
    // small samples no longer look as trustworthy as large ones.
    const winrateScore = this.wilsonLowerBound(res.winRatePercent / 100, res.totalTrades) * 100;
    
    // 5. Sharpe Proxy: (Return / Drawdown) normalized
    const sharpeScore = Math.min(100, res.maxDrawdownPercent > 0 ? (res.totalReturnPercent / res.maxDrawdownPercent) * 20 : 100);
    
    // 6. Trade Frequency Penalty: penalize too few trades (< 5) or noise (> 100)
    let tradeCountScore = 100;
    if (res.totalTrades === 0) tradeCountScore = 0;
    else if (res.totalTrades < 5) tradeCountScore = 30;
    else if (res.totalTrades < 10) tradeCountScore = 70;
    else if (res.totalTrades > 120) tradeCountScore = 60;

    // 7. Concentration Penalty: how much of total profit comes from the single best trade.
    // A strategy where one lucky trade makes the whole result looks good in-sample but is
    // not something you can rely on going forward.
    const concentrationScore = this.calculateConcentrationScore(res);

    const score = (profitScore * 0.30) + (pfScore * 0.15) + (ddScore * 0.15) + (winrateScore * 0.10) +
                  (sharpeScore * 0.05) + (tradeCountScore * 0.10) + (concentrationScore * 0.15);
    return Math.round(score * 10) / 10;
  },

  // Wilson score interval lower bound for a proportion — a statistically sound way to say
  // "how confident can I be in this winrate given how few/many trades it's based on"
  wilsonLowerBound(p, n, z = 1.645) {
    if (!n || n <= 0) return 0;
    const denom = 1 + (z * z) / n;
    const centre = p + (z * z) / (2 * n);
    const adj = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    return Math.max(0, (centre - adj) / denom);
  },

  calculateConcentrationScore(res) {
    const trades = res.tradeLog;
    if (!trades || trades.length === 0) return 100;
    const wins = trades.filter(t => t.pnlSats > 0);
    const grossProfit = wins.reduce((sum, t) => sum + t.pnlSats, 0);
    if (grossProfit <= 0) return 100;
    const maxWin = Math.max(...wins.map(t => t.pnlSats));
    const concentration = maxWin / grossProfit; // 0..1, share of profit from the single best trade
    // Up to 30% from one trade is normal and not penalized; beyond that it scales down to 0
    return Math.max(0, Math.min(100, 100 - Math.max(0, concentration - 0.3) * 140));
  },

  // Deflated-Sharpe-artige Korrektur: je mehr Parameterkombinationen getestet wurden, desto
  // wahrscheinlicher ist es, dass die beste rein zufällig gut aussieht. Diese Penalty
  // schrumpft den Score logarithmisch mit der Anzahl Trials, ähnlich der Deflated-Sharpe-
  // Ratio von Bailey & López de Prado.
  //
  // penalty = 1 − 1/(1 + α·ln(N)),  α=0.08
  // Bei N=1: ~0% Abschlag, N=100: ~27%, N=400: ~38%
  DEFLATED_ALPHA: 0.08,

  deflatedScorePenalty(totalTrials) {
    if (totalTrials <= 1) return 0;
    return 1 - 1 / (1 + this.DEFLATED_ALPHA * Math.log(totalTrials));
  },

  applyDeflatedScore(rawScore, totalTrials) {
    const penalty = this.deflatedScorePenalty(totalTrials);
    return Math.round(rawScore * (1 - penalty) * 10) / 10;
  },

  // Chronological train/test split so validation never "sees the future" (no shuffling).
  // Datasets shorter than ~3.5 days (5000 1m-candles) are too small to split meaningfully.
  splitCandlesForValidation(candles, trainRatio = 0.7) {
    if (!candles || candles.length < 5000) return { train: candles, test: null };
    const splitIdx = Math.floor(candles.length * trainRatio);
    return { train: candles.slice(0, splitIdx), test: candles.slice(splitIdx) };
  },

  // Combines in-sample (train) and out-of-sample (test) scores, weighting the unseen test
  // segment heavily so overfit combos (great in-sample, poor out-of-sample) rank lower.
  calculateCombinedScore(trainRes, testRes) {
    const trainScore = this.calculateScore(trainRes);
    if (!testRes || testRes.totalTrades === 0) {
      return { trainScore, testScore: null, finalScore: trainScore, validated: false };
    }
    const testScore = this.calculateScore(testRes);
    const finalScore = Math.round((trainScore * 0.3 + testScore * 0.7) * 10) / 10;
    return { trainScore, testScore, finalScore, validated: true };
  },

  // Small random perturbation of a candidate's parameters, clipped to the search bounds —
  // used to probe whether a good score is a robust plateau or a fragile one-off spike.
  perturbCandidate(base, bounds) {
    const clip = (v, min, max) => Math.max(min, Math.min(max, v));
    const roundStep = (v, step) => Math.round(v / step) * step;
    return {
      leverage: clip(base.leverage + (Math.random() < 0.5 ? -1 : 1) * (Math.random() < 0.7 ? 1 : 2), bounds.leverage.min, bounds.leverage.max),
      cooldownMin: clip(base.cooldownMin + (Math.random() < 0.5 ? -1 : 1) * (Math.random() < 0.7 ? 2 : 5), bounds.cooldownMin.min, bounds.cooldownMin.max),
      tpPercent: clip(roundStep(base.tpPercent + (Math.random() < 0.5 ? -1 : 1) * 5, 5), bounds.tpPercent.min, bounds.tpPercent.max),
      slPercent: clip(roundStep(base.slPercent + (Math.random() < 0.5 ? -1 : 1) * 5, 5), bounds.slPercent.min, bounds.slPercent.max),
      maxOpen: clip(base.maxOpen + (Math.random() < 0.5 ? -1 : 1), bounds.maxOpen.min, bounds.maxOpen.max)
    };
  },

  // Stability score: how much the score degrades under small parameter perturbations.
  // A big drop means the "good" result was a fragile spike rather than a robust plateau.
  computeStabilityScore(centerScore, neighborScores) {
    if (!neighborScores || neighborScores.length === 0) return null;
    const avgDrop = neighborScores.reduce((sum, s) => sum + Math.max(0, centerScore - s), 0) / neighborScores.length;
    return Math.round(Math.max(0, 100 - avgDrop * 2.5) * 10) / 10;
  },

  // Intervals the optimizer is allowed to combine when searching for entry-rule combinations.
  // Kept deliberately bounded (not the full UI list up to 1d) so the search space stays tractable.
  // Full range of timeframes from 1m up to 12h available for pattern & multi-timeframe rules
  RULE_SEARCH_INTERVALS: ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h'],

  generateRuleSetCandidates() {
    const intervals = this.RULE_SEARCH_INTERVALS;
    const mirror = (s) => s === 'bull' ? 'bear' : 'bull';
    const candidates = [];
    const states = ['bull', 'bear'];

    // 1. Single-interval combinations (Trend + Contra)
    intervals.forEach(iv => {
      candidates.push({
        long:  [{ interval: iv, state: 'bull' }],
        short: [{ interval: iv, state: 'bear' }],
        label: iv
      });
      candidates.push({
        long:  [{ interval: iv, state: 'bear' }],
        short: [{ interval: iv, state: 'bull' }],
        label: iv + '-contra'
      });
    });

    // 2. Dual-interval combinations (All 4 state permutations across all timeframe pairs from 1m to 12h)
    for (let i = 0; i < intervals.length; i++) {
      for (let j = i + 1; j < intervals.length; j++) {
        const tf1 = intervals[i];
        const tf2 = intervals[j];
        for (const s1 of states) {
          for (const s2 of states) {
            candidates.push({
              long:  [{ interval: tf1, state: s1 },        { interval: tf2, state: s2 }],
              short: [{ interval: tf1, state: mirror(s1) }, { interval: tf2, state: mirror(s2) }],
              label: `${tf1}(${s1[0].toUpperCase()})+${tf2}(${s2[0].toUpperCase()})`
            });
          }
        }
      }
    }

    // 3. Triple-interval combinations (3-Timeframe AND logic, e.g. 1m Bull + 3m Bear + 1h Bull)
    const trios = [
      ['1m', '3m', '1h'],
      ['1m', '5m', '1h'],
      ['1m', '15m', '4h'],
      ['3m', '15m', '1h'],
      ['3m', '30m', '4h'],
      ['5m', '15m', '1h'],
      ['5m', '30m', '4h'],
      ['15m', '1h', '4h'],
      ['15m', '4h', '12h'],
      ['1h', '4h', '12h']
    ];

    trios.forEach(([tf1, tf2, tf3]) => {
      for (const s1 of states) {
        for (const s2 of states) {
          for (const s3 of states) {
            candidates.push({
              long:  [{ interval: tf1, state: s1 },        { interval: tf2, state: s2 },        { interval: tf3, state: s3 }],
              short: [{ interval: tf1, state: mirror(s1) }, { interval: tf2, state: mirror(s2) }, { interval: tf3, state: mirror(s3) }],
              label: `${tf1}(${s1[0].toUpperCase()})+${tf2}(${s2[0].toUpperCase()})+${tf3}(${s3[0].toUpperCase()})`
            });
          }
        }
      }
    });

    return candidates;
  },

  getRulesSignature(rules) {
    if (!rules) return '';
    return JSON.stringify(rules.long || []) + '|' + JSON.stringify(rules.short || []);
  },

  // Shows interval + state initial (B=bull, b=bear) so contra patterns are clearly visible
  // e.g. "1m(B)+4h(b)" instead of just "1m+4h" which was ambiguous
  getRuleLabel(rules) {
    if (!rules || !rules.long || rules.long.length === 0) return '–';
    return rules.long.map(r => `${r.interval}(${r.state === 'bull' ? 'B' : r.state === 'bear' ? 'b' : 'n'})`).join('+');
  },

  // Random rule set for exploration. Always gives the user's own manually configured rules a
  // chance too, so the search never fully abandons what they set up in the UI.
  pickRandomRuleSet(includeCurrent = true) {
    const candidates = this.generateRuleSetCandidates();
    if (includeCurrent && App.state.rules && App.state.rules.long && App.state.rules.long.length > 0) {
      candidates.push({
        long: App.state.rules.long,
        short: App.state.rules.short,
        label: this.getRuleLabel(App.state.rules) + ' (eigene)'
      });
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
  },

  // Groups all saved test results by their rule combination and returns the best-scoring
  // combinations, so later optimizer phases can concentrate on rule sets that already proved
  // themselves instead of only exploring randomly.
  getTopRuleSets(topN = 3) {
    const groups = {};
    Object.values(App.state.optimizerDb).forEach(entry => {
      if (!entry.params || !entry.params.rules) return;
      const sig = this.getRulesSignature(entry.params.rules);
      if (!groups[sig] || groups[sig].score < entry.score) {
        groups[sig] = { rules: entry.params.rules, score: entry.score, label: this.getRuleLabel(entry.params.rules), signature: sig };
      }
    });
    return Object.values(groups).sort((a, b) => b.score - a.score).slice(0, topN);
  },

  getUniqueKey(symbol, rules, params, datasetRange) {
    // Unique key to prevent double testing. Includes the dataset's time range so the same
    // parameter combo tested against different historical windows (market phases) is stored
    // as distinct results instead of overwriting each other.
    const rulesStr = JSON.stringify(rules.long) + JSON.stringify(rules.short);
    const phasePart = datasetRange ? `_${datasetRange.fromTime}-${datasetRange.toTime}` : '';
    return `${symbol.toUpperCase()}_${rulesStr}_${params.leverage}_${params.cooldownMin}_${params.tpPercent}_${params.slPercent}_${params.maxOpen}${phasePart}`;
  },

  checkCache(symbol, rules, params, datasetRange) {
    const key = this.getUniqueKey(symbol, rules, params, datasetRange);
    return App.state.optimizerDb[key] || null;
  },

  saveToDb(symbol, timeframe, rules, params, evalBundle, marketClass, datasetRange) {
    const key = this.getUniqueKey(symbol, rules, params, datasetRange);
    
    // Check if DB is getting too large (compaction if size > 400 entries)
    const entries = Object.keys(App.state.optimizerDb);
    if (entries.length > 400) {
      // Sort and keep top 200 strategies, delete rest to prevent localStorage overflow
      // Using the dynamic deflated score for sorting during compaction.
      const totalTrials = entries.length;
      const sorted = Object.entries(App.state.optimizerDb)
        .sort((a, b) => {
          const scoreA = this.applyDeflatedScore(a[1].rawScore !== undefined ? a[1].rawScore : a[1].score, totalTrials);
          const scoreB = this.applyDeflatedScore(b[1].rawScore !== undefined ? b[1].rawScore : b[1].score, totalTrials);
          return scoreB - scoreA;
        });
      App.state.optimizerDb = {};
      sorted.slice(0, 200).forEach(([k, v]) => {
        // Also update the static score on compaction to match the new database size (200)
        v.score = this.applyDeflatedScore(v.rawScore !== undefined ? v.rawScore : v.score, 200);
        App.state.optimizerDb[k] = v;
      });
    }

    const { trainRes, testRes, scores, stability, crossPhase, veto, mlVeto, postMlScore } = evalBundle;

    // Combine the base (train/test-validated) score with the optional robustness checks.
    // Each optional component takes over part of the weight only when it was actually computed,
    // so cheap early-exploration candidates (base score only) aren't penalized for lacking checks
    // that are deliberately only run on already-promising candidates.
    let weightBase = 1;
    let extra = 0;
    if (stability !== null && stability !== undefined) { extra += stability * 0.15; weightBase -= 0.15; }
    if (crossPhase !== null && crossPhase !== undefined) { extra += crossPhase.score * 0.20; weightBase -= 0.20; }
    const rawScore = Math.round((scores.finalScore * weightBase + extra) * 10) / 10;

    // Deflated-Sharpe-artige Korrektur: der Score sinkt logarithmisch mit der Anzahl bisher
    // getesteter Kombinationen, damit die "beste von 400" nicht allein durch Multiple-Testing-
    // Zufall so aussieht, als wäre sie deutlich besser als der Rest.
    const totalTrials = Object.keys(App.state.optimizerDb).length + 1; // +1 weil dieser Test noch nicht drin ist
    const deflatedScore = this.applyDeflatedScore(rawScore, totalTrials);

    // Use the test-segment results as the "headline" numbers shown in the leaderboard when
    // available (more representative of future performance); fall back to train results otherwise
    const headlineRes = testRes || trainRes;

    App.state.optimizerDb[key] = {
      testId: 'opt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      timestamp: Date.now(),
      market: symbol.toUpperCase(),
      timeframe: timeframe,
      veto: veto || null,
      mlVeto: mlVeto || null,
      postMlScore: postMlScore || null,
      // Which historical window (market phase) this test ran against, so the leaderboard
      // and future multi-phase training can distinguish "works in 2022 bear market" from
      // "works in the last 7 days"
      datasetRange: datasetRange || null,
      params: {
        leverage: params.leverage,
        cooldownMin: params.cooldownMin,
        tpPercent: params.tpPercent,
        slPercent: params.slPercent,
        maxOpen: params.maxOpen,
        rules: JSON.parse(JSON.stringify(rules))
      },
      results: {
        totalReturnPercent: headlineRes.totalReturnPercent,
        winRatePercent: headlineRes.winRatePercent,
        maxDrawdownPercent: headlineRes.maxDrawdownPercent,
        profitFactor: headlineRes.profitFactor,
        totalTrades: headlineRes.totalTrades,
        avgTradePercent: headlineRes.avgTradePercent || 0,
        maxLosingStreak: headlineRes.maxLosingStreak || 0,
        longTrades: headlineRes.longTrades || 0,
        shortTrades: headlineRes.shortTrades || 0
      },
      counts: {
        count369Long: headlineRes.count369Long || 0,
        count369Short: headlineRes.count369Short || 0
      },
      // Full validation breakdown, kept for transparency and future filtering/analysis
      validation: {
        trainScore: scores.trainScore,
        testScore: scores.testScore,
        validated: scores.validated,
        stabilityScore: stability !== null && stability !== undefined ? stability : null,
        crossPhaseScore: crossPhase ? crossPhase.score : null,
        crossPhaseDetails: crossPhase ? crossPhase.phases : null
      },
      marketClass: marketClass,
      rawScore: rawScore,
      score: deflatedScore
    };
    App.saveToLocalStorage();
  },

  trainKMeansRegimes(candles) {
    if (!candles || candles.length < 300 || !App.MLHelper) return null;

    const windowSize = 240; // 4h
    const step = 30; // 30m step for rolling windows
    const samples = [];

    for (let i = 0; i <= candles.length - windowSize; i += step) {
      const window = candles.slice(i, i + windowSize);
      const firstClose = window[0].close;
      const lastClose = window[window.length - 1].close;
      const priceChangePct = ((lastClose - firstClose) / firstClose) * 100;

      let rangeSum = 0;
      let volSum = 0;
      window.forEach(c => {
        const high = c.high ?? c.close;
        const low = c.low ?? c.close;
        rangeSum += (high - low) / c.close;
        volSum += c.volume ?? 0;
      });

      const avgRangePct = (rangeSum / window.length) * 100;
      const avgVolume = Math.round(volSum / window.length);

      samples.push([priceChangePct, avgRangePct, avgVolume]);
    }

    if (samples.length < 5) return null;

    // Standardize features for K-Means
    const d = samples[0].length;
    const means = new Array(d).fill(0);
    const stds = new Array(d).fill(0);

    for (let j = 0; j < d; j++) {
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i][j];
      means[j] = sum / samples.length;
    }

    for (let j = 0; j < d; j++) {
      let varSum = 0;
      for (let i = 0; i < samples.length; i++) varSum += (samples[i][j] - means[j]) ** 2;
      stds[j] = Math.sqrt(varSum / samples.length) || 1;
    }

    const normalizedSamples = samples.map(row => row.map((v, j) => (v - means[j]) / stds[j]));

    // Run K-Means with K = 3
    const kmeansRes = App.MLHelper.kmeans(normalizedSamples, 3, 100);

    // Profile centroids based on raw priceChangePct
    const centroidsRaw = kmeansRes.centroids.map(cNorm => cNorm.map((v, j) => v * stds[j] + means[j]));
    const centroidProfiles = centroidsRaw.map((cRaw, idx) => ({
      idx,
      priceChangePct: cRaw[0],
      avgRangePct: cRaw[1],
      avgVolume: cRaw[2],
      centroidNorm: kmeansRes.centroids[idx]
    }));

    centroidProfiles.sort((a, b) => a.priceChangePct - b.priceChangePct);

    // Lowest -> bearish_trend, Highest -> bullish_trend, Middle -> sideways
    const regimeMapping = {};
    regimeMapping[centroidProfiles[0].idx] = 'bearish_trend';
    regimeMapping[centroidProfiles[1].idx] = 'sideways';
    regimeMapping[centroidProfiles[2].idx] = 'bullish_trend';

    const kmeansRegimes = {
      centroidsNorm: kmeansRes.centroids,
      regimeMapping,
      means,
      stds,
      trainedAt: Date.now(),
      samplesCount: samples.length
    };

    App.state.mlLibrary.kmeansRegimes = kmeansRegimes;
    App.saveToLocalStorage();
    return kmeansRegimes;
  },

  classifyMarket(candles) {
    if (!candles || candles.length === 0) {
      return { regime: 'sideways', volatility: 'low', avgVolume: 0, isKMeans: false };
    }

    const firstClose = candles[0].close;
    const lastClose = candles[candles.length - 1].close;
    const priceChangePct = ((lastClose - firstClose) / firstClose) * 100;

    let rangeSum = 0;
    let volSum = 0;
    candles.forEach(c => {
      const high = c.high ?? c.close;
      const low = c.low ?? c.close;
      rangeSum += (high - low) / c.close;
      volSum += c.volume ?? 0;
    });

    const avgRangePct = (rangeSum / candles.length) * 100;
    const volatility = avgRangePct > 0.08 ? 'high' : 'low';
    const avgVolume = Math.round(volSum / candles.length);

    // K-Means Classification (Unsupervised)
    const kmModel = App.state.mlLibrary?.kmeansRegimes;
    if (kmModel && kmModel.centroidsNorm && App.MLHelper) {
      const sample = [priceChangePct, avgRangePct, avgVolume];
      const normSample = sample.map((v, j) => (v - kmModel.means[j]) / kmModel.stds[j]);

      let minDist = Infinity;
      let bestCentroidIdx = 0;

      kmModel.centroidsNorm.forEach((cNorm, idx) => {
        let dist = 0;
        for (let j = 0; j < cNorm.length; j++) {
          dist += (normSample[j] - cNorm[j]) ** 2;
        }
        if (dist < minDist) {
          minDist = dist;
          bestCentroidIdx = idx;
        }
      });

      const regime = kmModel.regimeMapping[bestCentroidIdx] || 'sideways';
      return { regime, volatility, avgVolume, isKMeans: true };
    }

    // Heuristic Fallback
    let regime = 'sideways';
    if (priceChangePct > 1.5) regime = 'bullish_trend';
    else if (priceChangePct < -1.5) regime = 'bearish_trend';

    return { regime, volatility, avgVolume, isKMeans: false };
  },

  analyzeParameters() {
    const db = this.getDbWithDynamicScores();
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

  getClusterBounds(rulesSignature) {
    const db = this.getDbWithDynamicScores();
    let goodRuns = db.filter(x => x.score >= 70);

    if (rulesSignature) {
      const sameRules = goodRuns.filter(x => this.getRulesSignature(x.params.rules) === rulesSignature);
      if (sameRules.length >= 5) goodRuns = sameRules;
    }

    if (goodRuns.length < 5) return null;

    // DBSCAN Density Parameter Clustering
    let targetRuns = goodRuns;
    if (App.MLHelper && App.MLHelper.dbscan && goodRuns.length >= 6) {
      const normVectors = goodRuns.map(r => {
        const p = r.params;
        return [
          (p.leverage - 1) / 99,
          (p.cooldownMin || 0) / 120,
          (p.tpPercent - 2.5) / 197.5,
          (p.slPercent - 2.5) / 97.5,
          ((p.maxOpen || 5) - 1) / 19
        ];
      });

      const { clusters } = App.MLHelper.dbscan(normVectors, 0.20, 3);
      if (clusters && clusters.length > 0) {
        // Select the cluster with the highest average score
        let bestClusterIdx = 0;
        let bestAvgScore = -Infinity;

        clusters.forEach((clsIndices, cIdx) => {
          const avgScore = clsIndices.reduce((sum, idx) => sum + goodRuns[idx].score, 0) / clsIndices.length;
          if (avgScore > bestAvgScore) {
            bestAvgScore = avgScore;
            bestClusterIdx = cIdx;
          }
        });

        const selectedClusterIndices = clusters[bestClusterIdx];
        if (selectedClusterIndices.length >= 3) {
          targetRuns = selectedClusterIndices.map(idx => goodRuns[idx]);
        }
      }
    }

    const bounds = {
      leverage: { min: Infinity, max: -Infinity },
      cooldownMin: { min: Infinity, max: -Infinity },
      tpPercent: { min: Infinity, max: -Infinity },
      slPercent: { min: Infinity, max: -Infinity },
      maxOpen: { min: Infinity, max: -Infinity }
    };

    targetRuns.forEach(r => {
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

    bounds.leverage.min = Math.max(1, bounds.leverage.min - 1);
    bounds.leverage.max = Math.min(100, bounds.leverage.max + 1);

    bounds.cooldownMin.min = Math.max(0, bounds.cooldownMin.min - 1);
    bounds.cooldownMin.max = Math.min(120, bounds.cooldownMin.max + 1);

    bounds.tpPercent.min = Math.max(2.5, bounds.tpPercent.min - 2.5);
    bounds.tpPercent.max = Math.min(200, bounds.tpPercent.max + 2.5);

    bounds.slPercent.min = Math.max(2.5, bounds.slPercent.min - 2.5);
    bounds.slPercent.max = Math.min(100, bounds.slPercent.max + 2.5);

    if (bounds.maxOpen.min === Infinity) {
      bounds.maxOpen = { min: 1, max: 20 };
    } else {
      bounds.maxOpen.min = Math.max(1, bounds.maxOpen.min - 1);
      bounds.maxOpen.max = Math.min(20, bounds.maxOpen.max + 1);
    }

    return bounds;
  },



  getWissensstand() {
    const db = this.getDbWithDynamicScores();
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
      bestValidation: bestStrategy ? bestStrategy.validation : null,
      lastUpdated
    };
  },

  getDbWithDynamicScores() {
    const db = Object.values(App.state.optimizerDb);
    const totalTrials = db.length;
    return db.map(x => {
      const raw = x.rawScore !== undefined ? x.rawScore : x.score;
      const deflated = this.applyDeflatedScore(raw, totalTrials);
      return { ...x, score: deflated };
    });
  },

  getLeaderboard(filterRegime = 'all') {
    let db = this.getDbWithDynamicScores();
    
    // Filter by active symbol if available
    const activeSymbol = document.getElementById('backtest-symbol')?.value;
    if (activeSymbol) {
      const normActive = activeSymbol.toUpperCase().replace('USDT', '').trim();
      db = db.filter(x => {
        const m = (x.market || 'BTC').toUpperCase().replace('USDT', '').trim();
        return m === normActive || m.includes(normActive) || normActive.includes(m);
      });
    }


    if (filterRegime !== 'all') {
      db = db.filter(x => x.marketClass && x.marketClass.regime === filterRegime);
    }

    const optMode = document.getElementById('optimizer-mode')?.value || 'ml';
    if (optMode === 'ml_high_freq') {
      // Prioritize strategies with rich trade samples (N >= 30 trades) for ML training while respecting score
      return db.sort((a, b) => {
        const scoreA = (a.results && a.results.totalTrades >= 30 ? a.score * 1.3 : a.score);
        const scoreB = (b.results && b.results.totalTrades >= 30 ? b.score * 1.3 : b.score);
        return scoreB - scoreA;
      }).slice(0, 100);
    }

    return db.sort((a, b) => b.score - a.score).slice(0, 100);
  },

  // Attaches a Fine-Tune veto profile (derived from a failed-trade analysis) to a specific
  // saved strategy, identified by its testId since the raw storage key isn't exposed to the UI.
  saveVetoProfile(testId, vetoData) {
    const found = Object.entries(App.state.optimizerDb).find(([, v]) => v.testId === testId);
    if (!found) return false;
    App.state.optimizerDb[found[0]].veto = vetoData;
    App.saveToLocalStorage();
    return true;
  },

  // Same, but for the trained ML (logistic regression) loss-prediction model
  saveMLVetoProfile(testId, mlVetoData) {
    const found = Object.entries(App.state.optimizerDb).find(([, v]) => v.testId === testId);
    if (!found) return false;
    App.state.optimizerDb[found[0]].mlVeto = mlVetoData;
    App.saveToLocalStorage();
    return true;
  }
};
