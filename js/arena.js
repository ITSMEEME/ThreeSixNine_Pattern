window.App = window.App || {};

App.Arena = {
  state: {
    isRunning: false,
    currentSystemId: null,
    currentRotation: 0,
    totalRotations: 0,
    progressPercent: 0
  },

  // Helper: Generates a unique system ID for an Arena System
  generateSystemId() {
    return 'sys_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  },

  // Helper: Generates a canonical fingerprint key for system parameters to prevent duplicates
  getSystemFingerprint(params, veto, mlVeto) {
    const rulesStr = params.rules ? (JSON.stringify(params.rules.long || []) + JSON.stringify(params.rules.short || [])) : '';
    const pStr = `${params.leverage}_${params.cooldownMin}_${params.tpPercent}_${params.slPercent}_${params.maxOpen}`;
    const vetoStr = veto ? JSON.stringify(veto.codes || []) : '';
    const mlStr = mlVeto ? (mlVeto.model ? 'ml_active' : '') : '';
    return `${rulesStr}_${pStr}_${vetoStr}_${mlStr}`;
  },

  // Registers a new strategy profile as an Arena System
  registerSystem(params, veto = null, mlVeto = null, label = null) {
    if (!params) return null;
    
    App.state.arenaSystems = App.state.arenaSystems || [];
    const fingerprint = this.getSystemFingerprint(params, veto, mlVeto);
    
    // Check if system with identical fingerprint already exists
    let existing = App.state.arenaSystems.find(s => s.fingerprint === fingerprint);
    if (existing) {
      return existing;
    }

    const fullParams = {
      ...JSON.parse(JSON.stringify(params)),
      veto: veto ? JSON.parse(JSON.stringify(veto)) : null,
      mlVeto: mlVeto ? JSON.parse(JSON.stringify(mlVeto)) : null
    };

    const system = {
      systemId: this.generateSystemId(),
      fingerprint: fingerprint,
      label: label || App.Optimizer.getRuleLabel(params.rules) + ` (L:${params.leverage}x TP:${params.tpPercent}% SL:${params.slPercent}%)`,
      params: fullParams,
      veto: veto ? JSON.parse(JSON.stringify(veto)) : null,
      mlVeto: mlVeto ? JSON.parse(JSON.stringify(mlVeto)) : null,
      createdAt: Date.now()
    };

    App.state.arenaSystems.push(system);
    this.saveToLocalStorage();
    return system;
  },

  // Evaluates a system on a specific holdout dataset, using remaining datasets for training/validation
  async runRotation(systemId, holdoutDataset, trainingDatasets) {
    const system = (App.state.arenaSystems || []).find(s => s.systemId === systemId);
    if (!system) throw new Error(`Arena-System ${systemId} nicht gefunden.`);

    const evalParams = {
      ...system.params,
      veto: system.veto || (system.params ? system.params.veto : null),
      mlVeto: system.mlVeto || (system.params ? system.params.mlVeto : null)
    };

    // 1. Merge training candles from all training datasets
    let trainCandles = [];
    trainingDatasets.forEach(ds => {
      if (ds && ds.candles && Array.isArray(ds.candles)) {
        trainCandles = trainCandles.concat(ds.candles);
      }
    });

    // 2. Perform 70/30 In-Sample / Out-of-Sample validation on training set
    let trainScore = 0;
    if (trainCandles.length > 0) {
      const split = App.Optimizer.splitCandlesForValidation(trainCandles, 0.7);
      const trainRes = App.Backtest.runBacktest(split.train, evalParams);
      const valRes = split.test ? App.Backtest.runBacktest(split.test, evalParams) : trainRes;
      const combined = App.Optimizer.calculateCombinedScore(trainRes, valRes);
      trainScore = combined.finalScore;
    }

    // 3. Evaluate exclusively on the Hold-out dataset (NO tuning, single pass)
    const holdoutCandles = holdoutDataset.candles || [];
    if (holdoutCandles.length === 0) {
      throw new Error(`Holdout-Datensatz ${holdoutDataset.label || holdoutDataset.key} enthält keine Kerzen.`);
    }

    const holdoutRes = App.Backtest.runBacktest(holdoutCandles, evalParams);
    const holdoutScore = App.Optimizer.calculateScore(holdoutRes);

    const rotationResult = {
      resultId: 'res_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      systemId: systemId,
      holdoutKey: holdoutDataset.key || holdoutDataset.label,
      holdoutLabel: holdoutDataset.label || holdoutDataset.key,
      trainScore: trainScore,
      holdoutScore: holdoutScore,
      results: {
        totalReturnPercent: holdoutRes.totalReturnPercent,
        winRatePercent: holdoutRes.winRatePercent,
        maxDrawdownPercent: holdoutRes.maxDrawdownPercent,
        profitFactor: holdoutRes.profitFactor,
        totalTrades: holdoutRes.totalTrades,
        avgTradePercent: holdoutRes.avgTradePercent || 0
      },
      evaluatedAt: Date.now()
    };

    // Save rotation result in state
    App.state.arenaResults = App.state.arenaResults || [];
    // Remove old result for same system and holdout dataset if exists
    App.state.arenaResults = App.state.arenaResults.filter(
      r => !(r.systemId === systemId && r.holdoutKey === rotationResult.holdoutKey)
    );
    App.state.arenaResults.push(rotationResult);
    this.saveToLocalStorage();

    return rotationResult;
  },

  // Runs full Leave-One-Out rotation evaluation across all datasets for a system
  async runFullArenaEvaluation(systemId, datasets, onProgress) {
    if (!datasets || datasets.length < 2) {
      throw new Error("Für eine Leave-One-Out Arena-Evaluation werden mindestens 2 Datensätze benötigt.");
    }

    this.state.isRunning = true;
    this.state.currentSystemId = systemId;
    this.state.totalRotations = datasets.length;
    this.state.currentRotation = 0;

    for (let i = 0; i < datasets.length; i++) {
      if (!this.state.isRunning) break;

      const holdoutDataset = datasets[i];
      const trainingDatasets = datasets.filter((_, idx) => idx !== i);

      this.state.currentRotation = i + 1;
      this.state.progressPercent = Math.round(((i + 1) / datasets.length) * 100);

      if (onProgress) {
        onProgress({
          rotation: i + 1,
          total: datasets.length,
          holdoutLabel: holdoutDataset.label || holdoutDataset.key,
          percent: this.state.progressPercent
        });
      }

      await this.runRotation(systemId, holdoutDataset, trainingDatasets);
      // Yield to UI loop
      await new Promise(resolve => setTimeout(resolve, 30));
    }

    this.state.isRunning = false;
    return this.aggregateScores(systemId, datasets.length);
  },

  // Backfills missing rotations for all registered systems on available datasets
  async backfillAllSystems(datasets, onProgress, forceRefresh = true) {
    if (!datasets || datasets.length < 2) return;
    const systems = App.state.arenaSystems || [];
    if (systems.length === 0) return;

    if (forceRefresh) {
      // Clear out stale / null results so every run computes authentic metrics
      App.state.arenaResults = [];
    }

    this.state.isRunning = true;
    let totalSteps = systems.length * datasets.length;
    let stepCount = 0;

    for (const sys of systems) {
      if (!this.state.isRunning) break;
      for (let i = 0; i < datasets.length; i++) {
        if (!this.state.isRunning) break;
        
        const holdoutDataset = datasets[i];
        const key = holdoutDataset.key || holdoutDataset.label;

        const exists = !forceRefresh && (App.state.arenaResults || []).some(
          r => r.systemId === sys.systemId && r.holdoutKey === key && r.holdoutScore !== null && r.holdoutScore !== undefined
        );

        if (!exists) {
          const trainingDatasets = datasets.filter((_, idx) => idx !== i);
          await this.runRotation(sys.systemId, holdoutDataset, trainingDatasets);
          await new Promise(resolve => setTimeout(resolve, 20));
        }

        stepCount++;
        if (onProgress) {
          onProgress({
            step: stepCount,
            total: totalSteps,
            percent: Math.round((stepCount / totalSteps) * 100),
            systemLabel: sys.label,
            holdoutLabel: holdoutDataset.label || holdoutDataset.key
          });
        }
      }
    }
    this.state.isRunning = false;
  },

  stopEvaluation() {
    this.state.isRunning = false;
  },

  // Computes conservative 25th percentile, minimum, average, and spread metrics
  aggregateScores(systemId, totalAvailableDatasets = 0) {
    const results = (App.state.arenaResults || []).filter(r => r.systemId === systemId);
    const system = (App.state.arenaSystems || []).find(s => s.systemId === systemId);

    if (!results || results.length === 0) {
      return {
        systemId,
        system,
        completedRotations: 0,
        totalRotations: totalAvailableDatasets,
        isComplete: false,
        minScore: 0,
        percentile25Score: 0,
        avgScore: 0,
        scoreStdDev: 0,
        finalArenaScore: 0,
        rotations: []
      };
    }

    const scores = results.map(r => r.holdoutScore).sort((a, b) => a - b);
    const minScore = scores[0];
    const maxScore = scores[scores.length - 1];
    const avgScore = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;

    // 25th Percentile calculation
    let p25Index = (scores.length - 1) * 0.25;
    let lower = Math.floor(p25Index);
    let upper = Math.ceil(p25Index);
    let weight = p25Index - lower;
    let percentile25Score = Math.round((scores[lower] * (1 - weight) + scores[upper] * weight) * 10) / 10;

    // Standard deviation
    const variance = scores.reduce((sum, s) => sum + Math.pow(s - avgScore, 2), 0) / scores.length;
    const scoreStdDev = Math.round(Math.sqrt(variance) * 10) / 10;

    // Aggregate Trades and Returns across rotations
    const totalTrades = results.reduce((sum, r) => sum + (r.results.totalTrades || 0), 0);
    const avgReturn = Math.round((results.reduce((sum, r) => sum + (r.results.totalReturnPercent || 0), 0) / results.length) * 10) / 10;
    const maxDD = Math.max(...results.map(r => r.results.maxDrawdownPercent || 0));

    // Final Arena Score formula: 70% 25th Percentile + 30% Minimum Score
    const finalArenaScore = Math.round((percentile25Score * 0.7 + minScore * 0.3) * 10) / 10;
    const isComplete = totalAvailableDatasets > 0 ? results.length >= totalAvailableDatasets : true;

    return {
      systemId,
      system,
      completedRotations: results.length,
      totalRotations: totalAvailableDatasets || results.length,
      isComplete,
      minScore,
      maxScore,
      percentile25Score,
      avgScore,
      scoreStdDev,
      scoreRange: Math.round((maxScore - minScore) * 10) / 10,
      totalTrades,
      avgReturn,
      maxDD,
      finalArenaScore,
      rotations: results
    };
  },

  // Fetches sorted list of all Arena Systems with their aggregated scores
  getArenaLeaderboard(totalAvailableDatasets = 0) {
    const systems = App.state.arenaSystems || [];
    const aggregated = systems.map(sys => this.aggregateScores(sys.systemId, totalAvailableDatasets));

    // Sort by completeness first, then by finalArenaScore descending
    return aggregated.sort((a, b) => {
      if (a.isComplete !== b.isComplete) {
        return a.isComplete ? -1 : 1;
      }
      return b.finalArenaScore - a.finalArenaScore;
    });
  },

  getLeaderboard(totalAvailableDatasets = 0) {
    return this.getArenaLeaderboard(totalAvailableDatasets);
  },

  saveToLocalStorage() {
    try {
      localStorage.setItem('paper-perp-arena-db', JSON.stringify({
        arenaSystems: App.state.arenaSystems || [],
        arenaResults: App.state.arenaResults || []
      }));
    } catch (e) {
      console.error('Fehler beim Speichern der Arena-Datenbank:', e);
    }
  },

  loadFromLocalStorage() {
    try {
      const saved = localStorage.getItem('paper-perp-arena-db');
      if (saved) {
        const parsed = JSON.parse(saved);
        App.state.arenaSystems = parsed.arenaSystems || [];
        App.state.arenaResults = parsed.arenaResults || [];
      }
    } catch (e) {
      console.error('Fehler beim Laden der Arena-Datenbank:', e);
    }
  }
};
