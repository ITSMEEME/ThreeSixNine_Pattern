window.App = window.App || {};

App.Backtest = {
  async fetchBinance1mCandles(symbol, totalCount, onProgress, anchorEndTimeMs) {
    let allCandles = [];
    let endTime = anchorEndTimeMs || Date.now();
    const limit = 1000;
    
    while (allCandles.length < totalCount) {
      const fetchCount = Math.min(limit, totalCount - allCandles.length);
      const data = await App.API.fetchBinanceKlines(symbol, '1m', fetchCount, endTime);
      if (data.length === 0) break;
      
      const chunk = data.map(k => ({
        time: Math.floor(k[0] / 1000),
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
        volume: +k[5],
        openTime: k[0]
      }));
      
      allCandles = allCandles.concat(chunk);
      if (data.length < fetchCount) {
        break;
      }
      endTime = data[0][0] - 1;
      
      if (onProgress) {
        onProgress(Math.min(100, Math.round((allCandles.length / totalCount) * 100)));
      }
    }
    
    allCandles.sort((a, b) => a.time - b.time);
    return allCandles;
  },

  aggregateCandles(candles1m, intervalMin) {
    if (!candles1m || candles1m.length === 0) return [];
    if (intervalMin === 1) return candles1m;
    
    let aggregated = [];
    for (let i = 0; i < candles1m.length; i += intervalMin) {
      let chunk = candles1m.slice(i, i + intervalMin);
      if (chunk.length === 0) break;
      
      let open = chunk[0].open;
      let close = chunk[chunk.length - 1].close;
      let high = Math.max(...chunk.map(c => c.high));
      let low = Math.min(...chunk.map(c => c.low));
      let volume = chunk.reduce((sum, c) => sum + c.volume, 0);
      let time = chunk[0].time;
      
      aggregated.push({
        time: time,
        open: open,
        high: high,
        low: low,
        close: close,
        volume: volume
      });
    }
    return aggregated;
  },

  runBacktest(candles1m, params) {
    let balance = params.startBalanceSats;
    let activeTrades = [];
    let tradeLog = [];
    let lastCloseIndex = -params.cooldownMin;
    let maxEquity = balance;
    let maxDrawdown = 0;
    let tradeIdCounter = 1;
    let totalFeesSats = 0;
    let vetoedCount = 0;
    let mlVetoedCount = 0;
    
    const martingaleEnabled = params.martingale && params.martingale.enabled;
    const martingaleMaxMultiplier = (params.martingale && params.martingale.maxMultiplier) || 8;
    let martingaleStep = 0;
    let martingaleAccumulatedLossSats = 0;
    let martingaleTargetProfitSats = 0;
    
    // Helper functions for intervals
    const getUniqueRuleIntervals = (rules) => {
      const intervals = new Set();
      if (rules.long) rules.long.forEach(r => intervals.add(r.interval));
      if (rules.short) rules.short.forEach(r => intervals.add(r.interval));
      return Array.from(intervals);
    };

    const intervalToMinutes = (interval) => {
      const unit = interval.slice(-1);
      const value = parseInt(interval.slice(0, -1));
      if (unit === 'm') return value;
      if (unit === 'h') return value * 60;
      if (unit === 'd') return value * 1440;
      return 1;
    };

    const precalculatePatternSignals = (candles_I) => {
      const signals = new Array(candles_I.length).fill(0);
      if (candles_I.length < 9) return signals;

      const isGreen = candles_I.map(c => c.close >= c.open);

      for (let j = 8; j < candles_I.length; j++) {
        // 3-candle
        const g3 = isGreen[j-2] + isGreen[j-1] + isGreen[j];
        signals[j-2] = signals[j-2] || 0; // ensure initialized
        const val3 = g3 >= 2 ? 1 : -1;

        // 6-candle
        const g6 = isGreen[j-5] + isGreen[j-4] + isGreen[j-3] + isGreen[j-2] + isGreen[j-1] + isGreen[j];
        const r6 = 6 - g6;
        const val6 = g6 >= 4 ? 1 : (r6 >= 4 ? -1 : 0);

        // 9-candle
        let g9 = 0;
        for (let k = j-8; k <= j; k++) if (isGreen[k]) g9++;
        const r9 = 9 - g9;
        const val9 = g9 >= 6 ? 1 : (r9 >= 6 ? -1 : 0);

        // Aggregate
        const greens = (val3 === 1 ? 1 : 0) + (val6 === 1 ? 1 : 0) + (val9 === 1 ? 1 : 0);
        const reds = (val3 === -1 ? 1 : 0) + (val6 === -1 ? 1 : 0) + (val9 === -1 ? 1 : 0);
        
        if (greens >= 2) signals[j] = 1;
        else if (reds >= 2) signals[j] = -1;
      }
      return signals;
    };

    // Precalculate data for all unique intervals
    const uniqueIntervals = getUniqueRuleIntervals(params.rules);
    const htfData = {};
    for (let tf of uniqueIntervals) {
      const mins = intervalToMinutes(tf);
      const candles_I = this.aggregateCandles(candles1m, mins);
      const signals_I = precalculatePatternSignals(candles_I);
      htfData[tf] = {
        candles: candles_I,
        signals: signals_I,
        pointer: -1,
        durationSeconds: mins * 60
      };
    }

    const checkRules = (rulesList) => {
      if (!rulesList || rulesList.length === 0) return false;
      for (let rule of rulesList) {
        const data = htfData[rule.interval];
        const currentSignal = data && data.pointer >= 0 ? data.signals[data.pointer] : 0;
        
        let expectedSignal = 0;
        if (rule.state === 'bull') expectedSignal = 1;
        else if (rule.state === 'bear') expectedSignal = -1;
        else if (rule.state === 'neutral') expectedSignal = 0;

        if (currentSignal !== expectedSignal) {
          return false;
        }
      }
      return true;
    };
    
    for (let i = 0; i < candles1m.length; i++) {
      const c = candles1m[i];
      
      // Update HTF pointers to current 1m time
      for (let tf of uniqueIntervals) {
        const data = htfData[tf];
        while (data.pointer + 1 < data.candles.length && data.candles[data.pointer + 1].time + data.durationSeconds <= c.time) {
          data.pointer++;
        }
      }
      
      // Check open trades
      let closedAny = false;
      let nextActiveTrades = [];
      
      for (let p of activeTrades) {
        let exitPrice = null;
        let exitReason = null;
        
        const liq = p.liqPrice;
        const tp = p.tpPrice;
        const sl = p.slPrice;
        
        if (p.side === 'long') {
          if (c.low <= liq) {
            exitPrice = liq;
            exitReason = 'liquidation';
          } else if (sl && c.low <= sl) {
            exitPrice = sl;
            exitReason = 'sl';
          } else if (tp && c.high >= tp) {
            exitPrice = tp;
            exitReason = 'tp';
          }
        } else {
          if (liq && c.high >= liq) {
            exitPrice = liq;
            exitReason = 'liquidation';
          } else if (sl && c.high >= sl) {
            exitPrice = sl;
            exitReason = 'sl';
          } else if (tp && c.low <= tp) {
            exitPrice = tp;
            exitReason = 'tp';
          }
        }
        
        if (i === candles1m.length - 1 && !exitReason) {
          exitPrice = c.close;
          exitReason = 'end';
        }
        
        if (exitReason) {
          closedAny = true;
          let pnlSats = 0;
          let entryFeeSats = p.entryFeeSats;
          let exitFeeSats = 0;
          
          if (exitReason === 'liquidation') {
            pnlSats = -p.marginSats;
            exitFeeSats = 0;
          } else {
            pnlSats = App.Engine.pnl(p.side, p.qtyUsd, p.entryPrice, exitPrice);
            exitFeeSats = App.Engine.fee(p.qtyUsd, exitPrice, params.feeRate);
            balance += p.marginSats + pnlSats - exitFeeSats;
          }
          totalFeesSats += (entryFeeSats + exitFeeSats);

          // Martingale recovery adjustments on exit
          let safetyLimitHit = false;
          if (martingaleEnabled) {
            if (exitReason === 'tp') {
              martingaleStep = 0;
              martingaleAccumulatedLossSats = 0;
            } else if (exitReason === 'sl' || exitReason === 'liquidation') {
              martingaleStep++;
              const netRealizedPnl = exitReason === 'liquidation' ? -(p.marginSats + entryFeeSats) : pnlSats - entryFeeSats - exitFeeSats;
              martingaleAccumulatedLossSats += Math.abs(netRealizedPnl);

              // Check if safety limit (based on step count) is exceeded
              if (martingaleStep > martingaleMaxMultiplier) {
                martingaleStep = 0;
                martingaleAccumulatedLossSats = 0;
                safetyLimitHit = true;
              }
            }
          }
          
          tradeLog.push({
            id: p.id,
            side: p.side,
            qtyUsd: p.qtyUsd,
            leverage: p.leverage,
            entryPrice: p.entryPrice,
            exitPrice: exitPrice,
            entryTime: p.entryTime,
            exitTime: c.time * 1000,
            reason: exitReason,
            pnlSats: pnlSats - entryFeeSats - exitFeeSats,
            signals: p.signals,
            features: p.features,
            martingaleStep: p.martingaleStep,
            safetyLimitHit: safetyLimitHit
          });
        } else {
          nextActiveTrades.push(p);
        }
      }
      
      activeTrades = nextActiveTrades;
      if (closedAny) {
        lastCloseIndex = i;
      }
      
      // Open new trades
      const maxAllowed = martingaleEnabled ? 1 : params.maxOpen;
      const cooldownPeriod = martingaleEnabled ? 0 : params.cooldownMin;
      const canTrade = (i >= lastCloseIndex + cooldownPeriod) && (activeTrades.length < maxAllowed);
      
      let triggerAction = 'none';
      if (canTrade) {
        const triggerLong = checkRules(params.rules.long);
        const triggerShort = checkRules(params.rules.short);
        if (triggerLong && !triggerShort) triggerAction = 'long';
        else if (triggerShort && !triggerLong) triggerAction = 'short';

        // Fine-Tune-Veto-Schicht
        if (triggerAction !== 'none' && params.veto && params.veto.enabled && params.veto.codes && params.veto.codes.length > 0) {
          const vetoCode = App.TradeAnalyzer.shouldVeto(candles1m, i, triggerAction, params.veto.codes);
          if (vetoCode) {
            vetoedCount++;
            triggerAction = 'none';
          }
        }

        // ML-Fine-Tune
        if (triggerAction !== 'none' && params.mlVeto && params.mlVeto.enabled && params.mlVeto.model) {
          const p = App.TradeAnalyzer.shouldVetoML(params.mlVeto.model, candles1m, i, triggerAction, params.mlVeto.threshold || 0.6);
          if (p !== null) {
            mlVetoedCount++;
            triggerAction = 'none';
          }
        }
      }
      
      if (triggerAction !== 'none') {
        const side = triggerAction;
        const entryPrice = side === 'long' ? c.close * (1 + params.spread) : c.close * (1 - params.spread);

        // Kelly-Positionsgröße (bypassed if martingale is active)
        let tradeQtyUsd = params.qtyUsd;
        let kellyFactor = 1.0;
        if (!martingaleEnabled && params.mlVeto && params.mlVeto.model) {
          const pLoss = App.TradeAnalyzer.predictLossProbability(params.mlVeto.model, candles1m, i, side);
          const pWin = 1 - pLoss;
          const kelly = App.Engine.kellyAdjustedQty(params.qtyUsd, pWin, params.tpPercent, params.slPercent);
          tradeQtyUsd = kelly.qty;
          kellyFactor = kelly.factor;
        }

        // Apply Martingale recovery if enabled
        if (martingaleEnabled) {
          if (martingaleStep > 0) {
            const targetProfit = martingaleTargetProfitSats || (App.Engine.margin(params.qtyUsd, entryPrice, params.leverage) * (params.tpPercent / 100));
            const reqProfitSats = targetProfit + martingaleAccumulatedLossSats;
            const marginSatsFor1Usd = App.Engine.margin(1.0, entryPrice, params.leverage);
            const profitPerUsd = marginSatsFor1Usd * (params.tpPercent / 100);
            tradeQtyUsd = reqProfitSats / profitPerUsd;
          }
        }

        const marginSats = App.Engine.margin(tradeQtyUsd, entryPrice, params.leverage);
        const entryFeeSats = App.Engine.fee(tradeQtyUsd, entryPrice, params.feeRate);
        
        if (balance >= marginSats + entryFeeSats) {
          balance -= (marginSats + entryFeeSats);
          
          const tpSats = Math.round(marginSats * (params.tpPercent / 100));
          const slSats = Math.round(marginSats * (params.slPercent / 100));
          
          if (martingaleEnabled && martingaleStep === 0) {
            martingaleTargetProfitSats = tpSats;
          }
          
          const tpPrice = App.Engine.getTpPrice(side, tradeQtyUsd, entryPrice, params.leverage, tpSats);
          const slPrice = App.Engine.getSlPrice(side, tradeQtyUsd, entryPrice, params.leverage, slSats);
          const liqPrice = App.Engine.liqPrice(side, entryPrice, params.leverage);
          
          // Log signal state at entry
          const entrySignals = uniqueIntervals.map(tf => {
            const data = htfData[tf];
            return {
              interval: tf,
              signal: data.pointer >= 0 ? data.signals[data.pointer] : 0
            };
          });

          // Extract features for ML
          const features = App.TradeAnalyzer.extractFeatures(candles1m, i, side);

          activeTrades.push({
            id: (tradeIdCounter++).toString(),
            side: side,
            qtyUsd: tradeQtyUsd,
            leverage: params.leverage,
            entryPrice: entryPrice,
            marginSats: marginSats,
            entryFeeSats: entryFeeSats,
            tpPrice: tpPrice,
            slPrice: slPrice,
            liqPrice: liqPrice,
            entryTime: c.time * 1000,
            signals: entrySignals,
            kellyFactor: kellyFactor,
            features: features,
            martingaleStep: martingaleEnabled ? martingaleStep : null
          });
        }
      }
      
      let currentEquity = balance;
      for (let p of activeTrades) {
        const upnl = App.Engine.pnl(p.side, p.qtyUsd, p.entryPrice, c.close);
        const estExitFee = App.Engine.fee(p.qtyUsd, c.close, params.feeRate);
        currentEquity += p.marginSats + upnl - estExitFee;
      }
      if (currentEquity > maxEquity) {
        maxEquity = currentEquity;
      }
      const drawdown = ((maxEquity - currentEquity) / maxEquity) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }
    
    const totalTrades = tradeLog.length;
    const wins = tradeLog.filter(t => t.pnlSats > 0);
    const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;
    
    let grossProfit = 0;
    let grossLoss = 0;
    for (let t of tradeLog) {
      if (t.pnlSats > 0) grossProfit += t.pnlSats;
      else grossLoss += Math.abs(t.pnlSats);
    }
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
    
    const totalReturn = ((balance - params.startBalanceSats) / params.startBalanceSats) * 100;
    
    return {
      finalBalanceSats: balance,
      totalReturnPercent: totalReturn,
      maxDrawdownPercent: maxDrawdown,
      profitFactor: profitFactor,
      winRatePercent: winRate,
      totalTrades: totalTrades,
      totalFeesSats: totalFeesSats,
      vetoedTrades: vetoedCount,
      mlVetoedTrades: mlVetoedCount,
      tradeLog: tradeLog
    };
  },

  // ---- Helpers for the multi-slot candle dataset library (IndexedDB) ----

  formatDateShort(unixSec) {
    return new Date(unixSec * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  },

  buildDatasetKey(symbol, days, endMode, endDateStr) {
    const endPart = endMode === 'custom' && endDateStr ? endDateStr : 'live';
    return `candles::${symbol.toUpperCase()}::${days}d::${endPart}`;
  },

  async getCacheIndex() {
    if (!App.DB || !App.DB.get) return [];
    try {
      const idx = await App.DB.get('cache-index');
      return Array.isArray(idx) ? idx : [];
    } catch (e) {
      return [];
    }
  },

  async saveCacheIndex(index) {
    if (!App.DB || !App.DB.set) return;
    await App.DB.set('cache-index', index);
  },

  async upsertCacheIndexEntry(entry) {
    let index = await this.getCacheIndex();
    index = index.filter(e => e.key !== entry.key);
    index.push(entry);
    index.sort((a, b) => b.timestamp - a.timestamp);

    // Soft cap: keep at most 15 saved datasets so IndexedDB doesn't grow unbounded
    // when building up a library of market phases
    const MAX_DATASETS = 15;
    if (index.length > MAX_DATASETS) {
      const overflow = index.slice(MAX_DATASETS);
      index = index.slice(0, MAX_DATASETS);
      for (const old of overflow) {
        try { await App.DB.delete(old.key); } catch (e) { /* ignore */ }
      }
    }
    await this.saveCacheIndex(index);
    return index;
  },

  async removeCacheIndexEntry(key) {
    let index = await this.getCacheIndex();
    index = index.filter(e => e.key !== key);
    await this.saveCacheIndex(index);
    try { await App.DB.delete(key); } catch (e) { /* ignore */ }
    return index;
  },

  async setActiveDatasetKey(key) {
    if (!App.DB || !App.DB.set) return;
    await App.DB.set('active-candles-key', key);
  },

  // Live estimate of candle count / requests / rough load time, shown before the user commits to a download
  updateBacktestEstimate() {
    const days = parseInt(document.getElementById('backtest-days').value) || 0;
    const totalCount = days * 1440;
    const requests = Math.ceil(totalCount / 1000);
    const seconds = Math.max(1, Math.round(requests * 0.35));
    const timeLabel = seconds < 60 ? `~${seconds}s` : `~${Math.round(seconds / 60)} Min.`;

    const endMode = document.querySelector('input[name="backtest-end-mode"]:checked')?.value || 'live';
    const endDateEl = document.getElementById('backtest-end-date');
    let endMs = Date.now();
    if (endMode === 'custom' && endDateEl.value) {
      endMs = new Date(endDateEl.value + 'T23:59:59Z').getTime();
    }
    const startMs = endMs - totalCount * 60000;
    const rangeLabel = `${this.formatDateShort(Math.floor(startMs / 1000))} – ${this.formatDateShort(Math.floor(endMs / 1000))}`;

    const estEl = document.getElementById('backtest-estimate');
    if (!estEl) return;
    let warning = '';
    if (totalCount > 50000) warning = ' ⚠ große Datenmenge — Ladevorgang kann mehrere Minuten dauern und viel Speicher benötigen.';
    estEl.innerHTML = `≈ ${totalCount.toLocaleString()} Kerzen (1m) &middot; Zeitraum: ${rangeLabel} &middot; ${requests} Anfragen, geschätzt ${timeLabel}${warning}`;
  },

  async renderCacheList() {
    const container = document.getElementById('backtest-cache-list');
    if (!container) return;
    const index = await this.getCacheIndex();
    let activeKey = null;
    try { activeKey = await App.DB.get('active-candles-key'); } catch (e) { /* ignore */ }

    // ── Compute per-dataset usage stats from the optimizerDb ──
    // A test matches a dataset when its datasetRange overlaps the dataset's time window.
    const getDatasetUsageStats = (entry) => {
      const db = App.state.optimizerDb || {};
      let count = 0;
      let bestScore = -Infinity;
      let lastTimestamp = 0;
      let bestEntry = null;
      Object.values(db).forEach(test => {
        if (!test.datasetRange) return;
        // Match: the test's time range overlaps or equals this dataset's range
        const dr = test.datasetRange;
        if (dr.fromTime <= entry.toTime && dr.toTime >= entry.fromTime) {
          count++;
          const score = test.postMlScore != null ? test.postMlScore : (test.score || 0);
          if (score > bestScore) {
            bestScore = score;
            bestEntry = test;
          }
          if (test.timestamp > lastTimestamp) lastTimestamp = test.timestamp;
        }
      });
      return {
        count,
        bestScore: count > 0 ? bestScore : null,
        bestEntry,
        lastTimestamp: count > 0 ? lastTimestamp : null
      };
    };

    if (index.length === 0) {
      container.innerHTML = `<div style="font-size: 10px; color: var(--text-faint); font-style: italic;">Noch keine gespeicherten Datensätze. Geladene Kerzen bleiben hier für spätere Sitzungen erhalten.</div>`;
      return;
    }

    container.innerHTML = index.map(e => {
      const isActive = e.key === activeKey;
      const rangeLabel = `${this.formatDateShort(e.fromTime)} – ${this.formatDateShort(e.toTime)}`;
      const usage = getDatasetUsageStats(e);

      // Build usage badge HTML
      let usageHtml = '';
      if (usage.count > 0) {
        const scoreColor = usage.bestScore >= 80 ? '#00e0b8' : usage.bestScore >= 60 ? '#ffb020' : 'var(--text-dim)';
        usageHtml = `
          <div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:3px;">
            <span style="font-size:8px; padding:1px 5px; border-radius:3px; background:rgba(110,180,255,0.1); color:#6eb4ff; border:1px solid rgba(110,180,255,0.2);">🧪 ${usage.count} Tests</span>
            <span style="font-size:8px; padding:1px 5px; border-radius:3px; background:rgba(0,224,184,0.08); color:${scoreColor}; border:1px solid rgba(0,224,184,0.15);">⭐ Best: ${usage.bestScore.toFixed(0)}</span>
            <span style="font-size:8px; padding:1px 5px; border-radius:3px; background:rgba(255,255,255,0.03); color:var(--text-faint); border:1px solid var(--border-soft);">⏱ ${App.formatRelativeTime(usage.lastTimestamp)}</span>
          </div>
        `;
      } else {
        usageHtml = `<div style="margin-top:3px;"><span style="font-size:8px; padding:1px 5px; border-radius:3px; background:rgba(255,255,255,0.03); color:var(--text-faint); border:1px solid var(--border-soft);">— Noch nicht trainiert</span></div>`;
      }

      return `
        <div class="clickable" data-key="${e.key}" style="display:flex; align-items:center; justify-content:space-between; gap:6px; font-size:10px; padding:6px 8px; border-radius:4px; background: var(--surface-2); border:1px solid ${isActive ? 'var(--teal)' : 'var(--border-soft)'};">
          <div style="overflow:hidden;">
            <div style="font-weight:600; color:${isActive ? 'var(--teal)' : 'var(--text-dim)'};">${isActive ? '✓ ' : ''}${e.symbol} &middot; ${e.days}T &middot; ${rangeLabel}</div>
            <div style="color:var(--text-faint); margin-top:2px;">${e.count.toLocaleString()} Kerzen &middot; gespeichert ${App.formatRelativeTime(e.timestamp)}</div>
            ${usageHtml}
          </div>
          <div style="display:flex; gap:4px; flex:0 0 auto;">
            ${isActive ? '' : `<button type="button" class="backtest-btn ds-load-btn" data-key="${e.key}" style="padding:4px 8px; font-size:9px;">Laden</button>`}
            <button type="button" class="backtest-btn ds-del-btn" data-key="${e.key}" style="padding:4px 8px; font-size:9px; border:1px dashed var(--border); background:transparent; color:var(--text-dim);">Löschen</button>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.ds-load-btn').forEach(btn => {
      btn.addEventListener('click', () => this.handleLoadCachedDataset(btn.dataset.key));
    });
    container.querySelectorAll('.ds-del-btn').forEach(btn => {
      btn.addEventListener('click', () => this.handleDeleteCachedDataset(btn.dataset.key));
    });

    // Render checkboxes for optimizer selection
    const optContainer = document.getElementById('optimizer-datasets-selection');
    if (optContainer) {
      if (index.length === 0) {
        optContainer.innerHTML = `<div style="font-size: 10px; color: var(--text-faint); font-style: italic;">Keine Datensätze vorhanden. Lade zuerst Daten.</div>`;
      } else {
        // Ensure at least one dataset is selected if none are set
        if (!App.state.optimizerDatasets || App.state.optimizerDatasets.length === 0) {
          if (activeKey) {
            App.state.optimizerDatasets = [activeKey];
          } else {
            App.state.optimizerDatasets = [index[0].key];
          }
        }

        optContainer.innerHTML = index.map(e => {
          const isChecked = App.state.optimizerDatasets.includes(e.key);
          const rangeLabel = `${this.formatDateShort(e.fromTime)}–${this.formatDateShort(e.toTime)}`;
          const usage = getDatasetUsageStats(e);

          // Compact usage info for the optimizer checkbox list
          let usageBadge = '';
          if (usage.count > 0) {
            const scoreColor = usage.bestScore >= 80 ? '#00e0b8' : usage.bestScore >= 60 ? '#ffb020' : 'var(--text-dim)';
            usageBadge = `<span style="font-size:7.5px; margin-left:4px; padding:1px 4px; border-radius:3px; background:rgba(110,180,255,0.1); color:#6eb4ff; border:1px solid rgba(110,180,255,0.15);">${usage.count}× trainiert · Best ${usage.bestScore.toFixed(0)}</span>`;
          } else {
            usageBadge = `<span style="font-size:7.5px; margin-left:4px; padding:1px 4px; border-radius:3px; background:rgba(255,255,255,0.03); color:var(--text-faint); border:1px solid var(--border-soft);">neu</span>`;
          }

          return `
            <label style="display:flex; align-items:center; gap:6px; font-size:10px; padding:6px 8px; border-radius:4px; background:var(--surface-2); border:1px solid var(--border-soft); cursor:pointer;">
              <input type="checkbox" class="opt-ds-checkbox" data-key="${e.key}" ${isChecked ? 'checked' : ''}>
              <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-dim);">
                <strong>${e.symbol}</strong> &middot; ${e.days}T &middot; ${rangeLabel}${usageBadge}
              </span>
            </label>
          `;
        }).join('');

        optContainer.querySelectorAll('.opt-ds-checkbox').forEach(cb => {
          cb.addEventListener('change', () => {
            const key = cb.dataset.key;
            if (cb.checked) {
              if (!App.state.optimizerDatasets.includes(key)) {
                App.state.optimizerDatasets.push(key);
              }
            } else {
              App.state.optimizerDatasets = App.state.optimizerDatasets.filter(k => k !== key);
            }
            App.saveToLocalStorage();
          });
        });
      }
    }
  },

  applyLoadedDataset(entry, candles) {
    App.state.backtestCandles = candles;

    const symbolEl = document.getElementById('backtest-symbol');
    const daysEl = document.getElementById('backtest-days');
    const liveRadio = document.getElementById('backtest-end-mode-live');
    const customRadio = document.getElementById('backtest-end-mode-custom');
    const endDateWrap = document.getElementById('backtest-end-date-wrap');
    const endDateEl = document.getElementById('backtest-end-date');

    if (symbolEl) symbolEl.value = entry.symbol;
    if (daysEl) daysEl.value = entry.days;
    if (entry.endMode === 'custom' && entry.endDateStr) {
      if (customRadio) customRadio.checked = true;
      if (endDateWrap) endDateWrap.style.display = 'block';
      if (endDateEl) endDateEl.value = entry.endDateStr;
    } else {
      if (liveRadio) liveRadio.checked = true;
      if (endDateWrap) endDateWrap.style.display = 'none';
    }

    const loaderStatus = document.getElementById('backtest-loader-status');
    const rangeLabel = `${this.formatDateShort(entry.fromTime)} – ${this.formatDateShort(entry.toTime)}`;
    if (loaderStatus) {
      loaderStatus.innerHTML = `💾 ${candles.length.toLocaleString()} Kerzen (${entry.symbol}, ${rangeLabel}) aus lokalem Cache geladen &middot; ${App.formatRelativeTime(entry.timestamp)}, kein erneuter Download nötig.`;
    }

    const runBtn = document.getElementById('btn-run-backtest');
    const optBtn = document.getElementById('btn-start-optimizer');
    const clearBtn = document.getElementById('btn-clear-candle-cache');
    if (runBtn) runBtn.disabled = false;
    if (optBtn) optBtn.disabled = false;
    if (clearBtn) clearBtn.disabled = false;

    this.updateBacktestEstimate();
  },

  async handleLoadCachedDataset(key) {
    if (!App.DB || !App.DB.get) return;
    try {
      const data = await App.DB.get(key);
      if (!data || !data.candles) {
        App.UI.showToast('Datensatz konnte nicht geladen werden.');
        return;
      }
      await this.setActiveDatasetKey(key);
      this.applyLoadedDataset(data, data.candles);
      await this.renderCacheList();
      App.UI.showToast('Datensatz geladen.');
    } catch (e) {
      console.error('Fehler beim Laden des Datensatzes:', e);
      App.UI.showToast('Fehler beim Laden des Datensatzes.');
    }
  },

  async handleDeleteCachedDataset(key) {
    if (!confirm('Diesen gespeicherten Datensatz wirklich löschen? Er muss danach ggf. erneut von Binance heruntergeladen werden.')) return;
    let activeKey = null;
    try { activeKey = await App.DB.get('active-candles-key'); } catch (e) { /* ignore */ }
    await this.removeCacheIndexEntry(key);

    if (key === activeKey) {
      App.state.backtestCandles = [];
      try { await App.DB.delete('active-candles-key'); } catch (e) { /* ignore */ }
      const loaderStatus = document.getElementById('backtest-loader-status');
      if (loaderStatus) loaderStatus.textContent = 'Keine Kerzen geladen.';
      const runBtn = document.getElementById('btn-run-backtest');
      const optBtn = document.getElementById('btn-start-optimizer');
      const clearBtn = document.getElementById('btn-clear-candle-cache');
      if (runBtn) runBtn.disabled = true;
      if (optBtn) optBtn.disabled = true;
      if (clearBtn) clearBtn.disabled = true;
    }
    await this.renderCacheList();
    App.UI.showToast('Datensatz gelöscht.');
  },

  async loadCachedCandles() {
    if (!App.DB || !App.DB.get) return;
    try {
      await this.renderCacheList();
      const index = await this.getCacheIndex();
      if (index.length === 0) return;

      let activeKey = await App.DB.get('active-candles-key');
      let entry = activeKey ? index.find(e => e.key === activeKey) : null;
      // Fall back to the most recently saved dataset if there's no explicit active pointer
      if (!entry) entry = index[0];

      const data = await App.DB.get(entry.key);
      if (data && data.candles && data.candles.length > 0) {
        await this.setActiveDatasetKey(entry.key);
        this.applyLoadedDataset(entry, data.candles);
        await this.renderCacheList();
      }
    } catch (e) {
      console.error('Fehler beim Laden der zwischengespeicherten Kerzen:', e);
    }
  },

  async handleClearCandleCache() {
    if (!confirm('Den aktuell geladenen Datensatz aus dem Cache entfernen? Er muss danach ggf. erneut von Binance heruntergeladen werden.')) return;
    let activeKey = null;
    try { activeKey = await App.DB.get('active-candles-key'); } catch (e) { /* ignore */ }
    if (activeKey) {
      await this.removeCacheIndexEntry(activeKey);
      try { await App.DB.delete('active-candles-key'); } catch (e) { /* ignore */ }
    }
    App.state.backtestCandles = [];
    const loaderStatus = document.getElementById('backtest-loader-status');
    if (loaderStatus) loaderStatus.textContent = 'Keine Kerzen geladen.';
    const runBtn = document.getElementById('btn-run-backtest');
    const optBtn = document.getElementById('btn-start-optimizer');
    const clearBtn = document.getElementById('btn-clear-candle-cache');
    if (runBtn) runBtn.disabled = true;
    if (optBtn) optBtn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;
    await this.renderCacheList();
    App.UI.showToast('Aktiver Kerzen-Cache gelöscht.');
  },

  async handleLoadBacktestData() {
    const btn = document.getElementById('btn-load-backtest-data');
    const symbol = document.getElementById('backtest-symbol').value.trim();
    const days = parseInt(document.getElementById('backtest-days').value);
    const loaderStatus = document.getElementById('backtest-loader-status');
    const progressContainer = document.getElementById('backtest-progress-container');
    const progressBar = document.getElementById('backtest-progress-bar');
    const runBtn = document.getElementById('btn-run-backtest');
    const optBtn = document.getElementById('btn-start-optimizer');

    const endMode = document.querySelector('input[name="backtest-end-mode"]:checked')?.value || 'live';
    const endDateEl = document.getElementById('backtest-end-date');
    const endDateStr = endDateEl ? endDateEl.value : '';

    if (!symbol) {
      App.UI.showToast('Bitte ein Symbol eingeben.');
      return;
    }
    if (endMode === 'custom' && !endDateStr) {
      App.UI.showToast('Bitte ein Enddatum wählen oder auf "Live" zurückschalten.');
      return;
    }

    const totalCount = days * 1440;

    // Large historical ranges (always 1m candles, by design) mean many API calls and a lot of
    // memory — warn explicitly instead of silently downsampling or blocking the request.
    if (totalCount > 50000) {
      const requests = Math.ceil(totalCount / 1000);
      const proceed = confirm(`Dieser Zeitraum ergibt ca. ${totalCount.toLocaleString()} 1m-Kerzen (~${requests} Anfragen an Binance) und kann mehrere Minuten dauern sowie viel Speicher benötigen. Fortfahren?`);
      if (!proceed) return;
    }

    const anchorEndTimeMs = endMode === 'custom' ? new Date(endDateStr + 'T23:59:59Z').getTime() : undefined;

    btn.disabled = true;
    progressContainer.style.display = 'block';
    progressBar.style.width = '0%';
    loaderStatus.textContent = 'Verbinde mit Binance und lade Kerzen...';

    try {
      App.state.backtestCandles = await App.Backtest.fetchBinance1mCandles(symbol, totalCount, (percent) => {
        progressBar.style.width = percent + '%';
        loaderStatus.textContent = `Lade Kerzen: ${percent}% geladen...`;
      }, anchorEndTimeMs);

      const candles = App.state.backtestCandles;
      runBtn.disabled = false;
      if (optBtn) optBtn.disabled = false;

      if (candles.length === 0) {
        loaderStatus.textContent = 'Keine Kerzendaten für diesen Zeitraum gefunden.';
        return;
      }

      const fromTime = candles[0].time;
      const toTime = candles[candles.length - 1].time;
      const key = this.buildDatasetKey(symbol, days, endMode, endDateStr);
      const cacheTimestamp = Date.now();

      const entry = {
        key,
        symbol: symbol.toUpperCase(),
        days,
        endMode,
        endDateStr: endMode === 'custom' ? endDateStr : null,
        fromTime,
        toTime,
        count: candles.length,
        timestamp: cacheTimestamp
      };

      // Save candles + metadata to IndexedDB so this exact historical window (a "market phase")
      // is cached locally and reusable across sessions without re-downloading
      if (App.DB && App.DB.set) {
        await App.DB.set(key, { ...entry, candles });
        await this.upsertCacheIndexEntry(entry);
        await this.setActiveDatasetKey(key);
      }

      const clearBtn = document.getElementById('btn-clear-candle-cache');
      if (clearBtn) clearBtn.disabled = false;
      const rangeLabel = `${this.formatDateShort(fromTime)} – ${this.formatDateShort(toTime)}`;
      loaderStatus.innerHTML = `${candles.length.toLocaleString()} Kerzen (${symbol.toUpperCase()}, ${rangeLabel}) heruntergeladen &middot; 💾 lokal zwischengespeichert.`;

      await this.renderCacheList();
      App.UI.showToast('Kerzendaten erfolgreich geladen und lokal zwischengespeichert.');
    } catch (err) {
      console.error(err);
      loaderStatus.textContent = err.isRateLimit
        ? `⚠ Binance-API gedrosselt${err.retryAfter ? ` — bitte ${err.retryAfter}s warten` : ' — bitte kurz warten'}.`
        : 'Fehler beim Laden der Kerzendaten.';
      App.UI.showToast(err.isRateLimit ? err.message : ('Fehler beim Laden: ' + err.message), false, err.isRateLimit ? 5000 : 3200);
    } finally {
      btn.disabled = false;
      setTimeout(() => {
        progressContainer.style.display = 'none';
      }, 1000);
    }
  },

  handleRunSingleBacktest() {
    if (!App.state.backtestCandles || App.state.backtestCandles.length === 0) {
      App.UI.showToast('Keine Kerzendaten geladen.');
      return;
    }
    
    const startBalanceSats = parseFloat(document.getElementById('backtest-capital').value);
    const qtyUsd = parseFloat(document.getElementById('backtest-qty').value);
    const leverage = parseFloat(document.getElementById('backtest-lev').value);
    const cooldownMin = parseInt(document.getElementById('backtest-cooldown').value);
    const maxOpen = parseInt(document.getElementById('backtest-max-open').value);
    const tpPercent = parseFloat(document.getElementById('backtest-tp').value);
    const slPercent = parseFloat(document.getElementById('backtest-sl').value);
    const martingaleEnabled = document.getElementById('backtest-martingale-enabled')?.checked ?? false;
    const martingaleLimit = parseInt(document.getElementById('backtest-martingale-limit')?.value ?? '8');

    const params = {
      startBalanceSats,
      qtyUsd,
      leverage,
      cooldownMin,
      maxOpen,
      tpPercent,
      slPercent,
      rules: App.state.rules,
      feeRate: App.CONFIG.feeRate,
      spread: App.CONFIG.spread,
      martingale: {
        enabled: martingaleEnabled,
        maxMultiplier: martingaleLimit
      }
    };

    // Include the active bot's veto/ML filters so the manual backtest runs with
    // the exact same configuration as the live bot — deckungsgleich.
    const b = App.state.bot;
    if (b.veto && b.veto.enabled && b.veto.codes && b.veto.codes.length > 0) {
      params.veto = { enabled: true, codes: b.veto.codes };
    }
    if (b.mlVeto && b.mlVeto.enabled && b.mlVeto.model) {
      params.mlVeto = { enabled: true, model: b.mlVeto.model, threshold: b.mlVeto.threshold || 0.6 };
    }
    
    const res = this.runBacktest(App.state.backtestCandles, params);
    this.renderBacktestResults(res);
  },

  renderBacktestResults(res) {
    document.getElementById('backtest-no-results').style.display = 'none';
    document.getElementById('backtest-results-content').style.display = 'block';
    
    const retEl = document.getElementById('res-return');
    retEl.textContent = (res.totalReturnPercent >= 0 ? '+' : '') + res.totalReturnPercent.toFixed(2) + '%';
    retEl.parentElement.className = 'metric-card return ' + (res.totalReturnPercent >= 0 ? 'up' : 'down');
    
    document.getElementById('res-drawdown').textContent = res.maxDrawdownPercent.toFixed(2) + '%';
    document.getElementById('res-factor').textContent = res.profitFactor === 999 ? '∞' : res.profitFactor.toFixed(2);
    document.getElementById('res-winrate').textContent = res.winRatePercent.toFixed(1) + '%';
    document.getElementById('res-total-trades').textContent = res.totalTrades.toString();
    document.getElementById('res-total-fees').textContent = Math.round(res.totalFeesSats).toLocaleString() + ' sats';
    document.getElementById('res-final-balance').textContent = Math.round(res.finalBalanceSats).toLocaleString() + ' sats';
    
    const tbody = document.querySelector('#table-backtest-trades tbody');
    if (res.tradeLog.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-faint);">Keine ausgeführten Trades in diesem Zeitraum.</td></tr>';
    } else {
      tbody.innerHTML = res.tradeLog.map(t => {
        const pnlCls = t.pnlSats >= 0 ? 'long' : 'short';
        const typeCls = t.side === 'long' ? 'long' : 'short';
        const formattedEntryTime = new Date(t.entryTime).toLocaleTimeString([], {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
        const formattedExitTime = new Date(t.exitTime).toLocaleTimeString([], {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
        
        const sigsHtml = t.signals ? t.signals.map(s => {
          const badge = s.signal === 1 ? '<span class="signal-badge up">▲</span>' : (s.signal === -1 ? '<span class="signal-badge down">▼</span>' : '<span class="signal-badge neutral">→</span>');
          return `<span style="font-size:9px; color:var(--text-dim); margin-right:4px;">${s.interval}:${badge}</span>`;
        }).join('') : '—';
        
        let reasonTxt = '';
        if (t.reason === 'liquidation') reasonTxt = '⚠ Liq.';
        else if (t.reason === 'tp') reasonTxt = 'TP';
        else if (t.reason === 'sl') reasonTxt = 'SL';
        else reasonTxt = 'Ende';

        let stepHtml = '—';
        if (t.martingaleStep !== undefined && t.martingaleStep !== null) {
          if (t.safetyLimitHit) {
            stepHtml = `<span style="background: rgba(255,92,92,0.18); color: var(--short); border: 1px solid rgba(255,92,92,0.35); border-radius: 3px; padding: 2px 4px; font-weight: 700; font-size: 8px; white-space: nowrap; letter-spacing: 0.3px;">Stufe ${t.martingaleStep} (Reset! ❌)</span>`;
          } else {
            stepHtml = t.martingaleStep === 0 
              ? `<span style="color: var(--text-dim); font-size: 9px;">Basis</span>` 
              : `<span style="color: var(--teal); font-weight: 600; font-size: 9px;">Stufe ${t.martingaleStep}</span>`;
          }
        }
        
        return `
          <tr>
            <td><span class="side ${typeCls}">${t.side === 'long' ? 'L' : 'S'} ${t.leverage}x</span></td>
            <td>$${Math.round(t.qtyUsd).toLocaleString()}</td>
            <td>${stepHtml}</td>
            <td style="font-size:10px;">${formattedEntryTime} → ${formattedExitTime}</td>
            <td>${t.entryPrice.toFixed(1)} → ${t.exitPrice.toFixed(1)} <span style="font-size:9px; color:var(--text-faint);">(${reasonTxt})</span></td>
            <td><span class="side ${pnlCls}">${t.pnlSats >= 0 ? '+' : ''}${Math.round(t.pnlSats).toLocaleString()} sats</span></td>
            <td>${sigsHtml}</td>
          </tr>
        `;
      }).join('');
    }
  },

  async handleStartOptimizer() {
    const startBtn = document.getElementById('btn-start-optimizer');
    const stopBtn = document.getElementById('btn-stop-optimizer');
    const statusText = document.getElementById('opt-status-text');
    const phaseText = document.getElementById('opt-phase-text');
    const phaseProg = document.getElementById('opt-phase-progress');
    const totalProg = document.getElementById('opt-total-progress');

    // Load all selected datasets for multi-dataset optimization
    const selectedKeys = App.state.optimizerDatasets || [];
    let datasetsToOptimize = [];
    
    try {
      if (selectedKeys.length > 0) {
        const cacheIndex = await App.Backtest.getCacheIndex();
        for (const key of selectedKeys) {
          const data = await App.DB.get(key);
          if (data && data.candles && data.candles.length > 0) {
            const entry = cacheIndex.find(e => e.key === key);
            const label = entry ? `${entry.symbol} ${this.formatDateShort(entry.fromTime)}–${this.formatDateShort(entry.toTime)}` : 'Gespeichert';
            datasetsToOptimize.push({
              key,
              label,
              candles: data.candles,
              symbol: entry ? entry.symbol : 'BTC'
            });
          }
        }
      }
    } catch (e) {
      console.error('Fehler beim Laden der ausgewählten Datensätze:', e);
    }

    // Fallback to active candles if none selected
    if (datasetsToOptimize.length === 0) {
      if (App.state.backtestCandles && App.state.backtestCandles.length > 0) {
        let activeKey = 'active';
        try { activeKey = await App.DB.get('active-candles-key') || 'active'; } catch(e){}
        datasetsToOptimize.push({
          key: activeKey,
          label: 'Aktiver Datensatz (Standard)',
          candles: App.state.backtestCandles,
          symbol: document.getElementById('backtest-symbol').value.trim() || 'BTC'
        });
      } else {
        App.UI.showToast('Keine Kerzendaten geladen oder ausgewählt.');
        if (startBtn) startBtn.disabled = false;
        if (stopBtn) stopBtn.disabled = true;
        return;
      }
    }

    if (startBtn) startBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = false;
    if (statusText) {
      statusText.textContent = 'Aktiv';
      statusText.style.color = 'var(--long)';
    }

    App.Optimizer.state.isRunning = true;
    App.Optimizer.state.symbol = datasetsToOptimize[0].symbol;
    App.Optimizer.state.timeframe = '1m';

    const startBalanceSats = parseFloat(document.getElementById('backtest-capital').value);
    const qtyUsd = parseFloat(document.getElementById('backtest-qty').value);
    const maxOpen = parseInt(document.getElementById('backtest-max-open').value);

    // Build overall dataset range meta-information
    const minTime = Math.min(...datasetsToOptimize.map(d => d.candles[0].time));
    const maxTime = Math.max(...datasetsToOptimize.map(d => d.candles[d.candles.length - 1].time));
    const datasetRange = {
      fromTime: minTime,
      toTime: maxTime,
      label: datasetsToOptimize.map(d => d.label).join(' & ')
    };

    // Classify market regime using the first dataset as reference
    let marketClass;
    try {
      marketClass = App.Optimizer.classifyMarket(datasetsToOptimize[0].candles);
    } catch (e) {
      marketClass = { regime: 'sideways', volatility: 'low', avgVolume: 0 };
    }

    const searchRulesEnabled = document.getElementById('opt-search-rules')?.checked ?? true;
    const autoMlEnabled = document.getElementById('opt-auto-ml')?.checked ?? true;

    const validationInfoEl = document.getElementById('opt-validation-info');
    if (validationInfoEl) {
      const lines = [];
      lines.push(`✓ Multi-Datensatz-Lernen aktiv: ${datasetsToOptimize.length} Zeitraum/Zeiträume`);
      lines.push(autoMlEnabled 
        ? '✓ Automatisches ML-Veto-Training aktiv (ab Score 60)'
        : 'ℹ Automatisches ML-Training inaktiv');
      lines.push(searchRulesEnabled
        ? `✓ Regel-Kombinationen werden mitgesucht (${App.Optimizer.RULE_SEARCH_INTERVALS.join('/')})`
        : 'ℹ Regel-Suche deaktiviert');
      
      const currentTrials = Object.keys(App.state.optimizerDb).length;
      const currentPenalty = Math.round(App.Optimizer.deflatedScorePenalty(Math.max(1, currentTrials)) * 100);
      lines.push(`✓ Deflated-Sharpe-Korrektur aktiv (${currentPenalty}% Abschlag bei ${currentTrials} Tests)`);
      validationInfoEl.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
    }

    const phaseTargets = {
      1: 30,
      3: 100,
      5: 50,
      7: 20
    };

    const runLoop = async () => {
      try {
        if (!App.Optimizer.state.isRunning) return;

        const phase = App.Optimizer.state.phase;

        if (phase >= 8) {
          if (statusText) {
            statusText.textContent = 'Bereit';
            statusText.style.color = 'var(--teal)';
          }
          if (startBtn) startBtn.disabled = false;
          if (stopBtn) stopBtn.disabled = true;
          App.Optimizer.state.isRunning = false;
          App.Optimizer.state.phase = 1;
          App.Optimizer.state.testsCompletedInPhase = 0;
          
          document.getElementById('backtest-no-results').style.display = 'none';
          document.getElementById('backtest-results-content').style.display = 'block';
          
          document.querySelectorAll('.res-tab').forEach(x => x.classList.toggle('active', x.dataset.resTab === 'leaderboard'));
          ['trades', 'leaderboard', 'heatmaps', 'wissensstand'].forEach(name => {
            const el = document.getElementById('res-tab-' + name);
            if (el) el.style.display = (name === 'leaderboard') ? 'block' : 'none';
          });
          
          App.UI.renderLeaderboard('all');
          App.UI.renderHeatmaps();
          App.UI.renderWissensstand();
          if (App.UI.syncResultsVisibility) App.UI.syncResultsVisibility();

          // Show best-result modal with parameters and rules
          App.Backtest.showOptimizationResultModal();
          App.UI.showToast('✅ ML-Lernprozess abgeschlossen — Beste Strategie gefunden!');
          return;
        }

        if (phase % 2 === 0) {
          if (phaseText) phaseText.textContent = `Lernen & Analyse...`;
          if (phaseProg) phaseProg.textContent = `-`;
          
          await new Promise(resolve => setTimeout(resolve, 800));

          App.Optimizer.state.phase = phase + 1;
          App.Optimizer.state.testsCompletedInPhase = 0;
          
          App.UI.renderLeaderboard('all');
          App.UI.renderHeatmaps();
          App.UI.renderWissensstand();

          setTimeout(runLoop, 0);
          return;
        }

        const target = phaseTargets[phase];
        if (phaseText) phaseText.textContent = `Phase ${phase} / 7 (${phase === 1 ? 'Zufallssuche' : phase === 7 ? 'Feintuning' : 'Cluster-Exploitation'})`;
        if (phaseProg) phaseProg.textContent = `${App.Optimizer.state.testsCompletedInPhase} / ${target}`;
        
        const totalCompleted = Object.keys(App.state.optimizerDb).length;
        if (totalProg) totalProg.textContent = `${totalCompleted} Tests`;

        if (App.Optimizer.state.testsCompletedInPhase >= target) {
          App.Optimizer.state.phase = phase + 1;
          App.Optimizer.state.testsCompletedInPhase = 0;
          setTimeout(runLoop, 0);
          return;
        }

        let candidateRules = App.state.rules;
        if (searchRulesEnabled) {
          if (phase >= 3) {
            const topRuleSets = App.Optimizer.getTopRuleSets(3);
            if (topRuleSets.length > 0 && Math.random() < 0.85) {
              candidateRules = topRuleSets[Math.floor(Math.random() * topRuleSets.length)].rules;
            } else {
              candidateRules = App.Optimizer.pickRandomRuleSet(true);
            }
          } else {
            candidateRules = App.Optimizer.pickRandomRuleSet(true);
          }
        }
        const rulesSignature = App.Optimizer.getRulesSignature(candidateRules);

        let bounds = App.Optimizer.state.bounds;
        
        if (phase === 3 || phase === 5) {
          const clusters = App.Optimizer.getClusterBounds(rulesSignature);
          if (clusters && Math.random() < 0.9) {
            bounds = clusters;
          }
        } else if (phase === 7) {
          const clusters = App.Optimizer.getClusterBounds(rulesSignature);
          if (clusters && Math.random() < 0.95) {
            bounds = {
              leverage: {
                min: Math.max(2, Math.round((clusters.leverage.min + clusters.leverage.max) / 2) - 1),
                max: Math.min(50, Math.round((clusters.leverage.min + clusters.leverage.max) / 2) + 1)
              },
              cooldownMin: {
                min: Math.max(5, Math.round((clusters.cooldownMin.min + clusters.cooldownMin.max) / 2) - 1),
                max: Math.min(60, Math.round((clusters.cooldownMin.min + clusters.cooldownMin.max) / 2) + 1)
              },
              tpPercent: {
                min: Math.max(5, Math.round((clusters.tpPercent.min + clusters.tpPercent.max) / 2) - 5),
                max: Math.min(150, Math.round((clusters.tpPercent.min + clusters.tpPercent.max) / 2) + 5)
              },
              slPercent: {
                min: Math.max(5, Math.round((clusters.slPercent.min + clusters.slPercent.max) / 2) - 5),
                max: Math.min(100, Math.round((clusters.slPercent.min + clusters.slPercent.max) / 2) + 5)
              },
              maxOpen: {
                min: Math.max(1, Math.round((clusters.maxOpen.min + clusters.maxOpen.max) / 2) - 1),
                max: Math.min(20, Math.round((clusters.maxOpen.min + clusters.maxOpen.max) / 2) + 1)
              }
            };
          }
        }

        let combo = null;
        let cachedRes = null;
        let attempts = 0;

        while (attempts < 100) {
          const candidate = App.Optimizer.generateCandidate(bounds);
          cachedRes = App.Optimizer.checkCache(App.Optimizer.state.symbol, candidateRules, candidate, datasetRange);
          if (!cachedRes) {
            combo = candidate;
            break;
          }
          attempts++;
        }

        if (!combo) {
          attempts = 0;
          while (attempts < 100) {
            const candidate = App.Optimizer.generateCandidate(App.Optimizer.state.bounds);
            cachedRes = App.Optimizer.checkCache(App.Optimizer.state.symbol, candidateRules, candidate, datasetRange);
            if (!cachedRes) {
              combo = candidate;
              break;
            }
            attempts++;
          }
        }

        if (!combo) {
          App.Optimizer.state.phase = 8;
          setTimeout(runLoop, 0);
          return;
        }

        const params = {
          startBalanceSats,
          qtyUsd,
          leverage: combo.leverage,
          cooldownMin: combo.cooldownMin,
          maxOpen: combo.maxOpen,
          tpPercent: combo.tpPercent,
          slPercent: combo.slPercent,
          rules: candidateRules,
          feeRate: App.CONFIG.feeRate,
          spread: App.CONFIG.spread
        };

        // Out-of-sample validation: evaluate candidate over all selected datasets
        const datasetResults = [];
        for (const ds of datasetsToOptimize) {
          const { train, test } = App.Optimizer.splitCandlesForValidation(ds.candles);
          const trainRes = this.runBacktest(train, params);
          const testRes = test ? this.runBacktest(test, params) : null;
          const scores = App.Optimizer.calculateCombinedScore(trainRes, testRes);
          datasetResults.push({
            train,
            test,
            trainRes,
            testRes,
            scores,
            label: ds.label
          });
        }

        // Calculate average scores
        const avgTrainScore = datasetResults.reduce((sum, r) => sum + r.scores.trainScore, 0) / datasetResults.length;
        const avgTestScore = datasetResults.some(r => r.scores.testScore !== null)
          ? (datasetResults.reduce((sum, r) => sum + (r.scores.testScore || r.scores.trainScore), 0) / datasetResults.length)
          : null;
        const avgFinalScore = datasetResults.reduce((sum, r) => sum + r.scores.finalScore, 0) / datasetResults.length;

        const scores = {
          trainScore: Math.round(avgTrainScore * 10) / 10,
          testScore: avgTestScore !== null ? Math.round(avgTestScore * 10) / 10 : null,
          finalScore: Math.round(avgFinalScore * 10) / 10,
          validated: datasetResults.some(r => r.scores.validated)
        };

        const trainRes = datasetResults[0].trainRes;
        const testRes = datasetResults[0].testRes;

        let stability = null;
        let crossPhase = null;

        // Perform stability check using the training segment of the first dataset
        if (scores.finalScore >= 65) {
          const neighborScores = [];
          for (let n = 0; n < 3; n++) {
            const neighbor = App.Optimizer.perturbCandidate(combo, bounds);
            const neighborParams = { ...params, ...neighbor };
            const neighborRes = this.runBacktest(datasetResults[0].train, neighborParams);
            neighborScores.push(App.Optimizer.calculateScore(neighborRes));
          }
          stability = App.Optimizer.computeStabilityScore(datasetResults[0].scores.trainScore, neighborScores);
        }

        // Automated Veto and ML Veto training for promising candidates
        let mlVeto = null;
        let veto = null;
        let postMlScore = null;

        if (scores.finalScore >= 60 && autoMlEnabled) {
          const combinedTrainTrades = [];
          datasetResults.forEach(r => {
            if (r.trainRes && r.trainRes.tradeLog) {
              combinedTrainTrades.push(...r.trainRes.tradeLog);
            }
          });

          const trainLosses = combinedTrainTrades.filter(t => t.pnlSats < 0);
          const trainWinsCount = combinedTrainTrades.length - trainLosses.length;

          // 1. Train ML model
          if (combinedTrainTrades.length >= 20 && trainLosses.length >= 5 && trainWinsCount >= 5) {
            try {
              // Pass null candles because features are pre-calculated on the trades!
              const mlModel = await App.TradeAnalyzer.trainLossModel(null, combinedTrainTrades);
              if (mlModel) {
                const threshold = 0.6;
                
                // Evaluate ML OOS on combined test trades if split was available
                const combinedTestTrades = [];
                datasetResults.forEach(r => {
                  if (r.testRes && r.testRes.tradeLog) {
                    combinedTestTrades.push(...r.testRes.tradeLog);
                  }
                });
                
                const splitAvailable = combinedTestTrades.length >= 30;
                
                // Evaluate before/after stats across all datasets
                let postMlReturnSum = 0;
                let postMlWinRateSum = 0;
                let beforeMlReturnSum = 0;
                let beforeMlWinRateSum = 0;
                let totalBeforeTrades = 0;
                let totalAfterTrades = 0;
                let totalBlockedTrades = 0;
                
                const mlParams = { ...params, mlVeto: { enabled: true, model: mlModel, threshold } };
                for (const r of datasetResults) {
                  const beforeAllRes = r.testRes ? this.runBacktest(r.test, params) : r.trainRes;
                  const afterAllRes = r.testRes ? this.runBacktest(r.test, mlParams) : this.runBacktest(r.train, mlParams);
                  
                  beforeMlReturnSum += beforeAllRes.totalReturnPercent;
                  beforeMlWinRateSum += beforeAllRes.winRatePercent;
                  postMlReturnSum += afterAllRes.totalReturnPercent;
                  postMlWinRateSum += afterAllRes.winRatePercent;
                  totalBeforeTrades += beforeAllRes.totalTrades;
                  totalAfterTrades += afterAllRes.totalTrades;

                  let blockedCount = 0;
                  if (beforeAllRes.tradeLog) {
                    for (const t of beforeAllRes.tradeLog) {
                      if (t.features) {
                        const p = App.TradeAnalyzer.predictLossProbability(mlModel, null, null, t.side, t.features);
                        if (p >= threshold) {
                          blockedCount++;
                        }
                      }
                    }
                  }
                  totalBlockedTrades += blockedCount;
                }
                
                mlVeto = {
                  enabled: true,
                  model: mlModel,
                  threshold,
                  validated: splitAvailable,
                  beforeAfter: {
                    beforeWinRate: beforeMlWinRateSum / datasetResults.length,
                    afterWinRate: postMlWinRateSum / datasetResults.length,
                    beforeReturn: beforeMlReturnSum / datasetResults.length,
                    afterReturn: postMlReturnSum / datasetResults.length,
                    beforeTrades: totalBeforeTrades,
                    afterTrades: totalAfterTrades,
                    mlVetoedTrades: totalBlockedTrades
                  }
                };

                // Compute post-ML score (average across all datasets with ML active)
                const postMlResults = [];
                for (const ds of datasetsToOptimize) {
                  const { train, test } = App.Optimizer.splitCandlesForValidation(ds.candles);
                  const trainSc = this.runBacktest(train, mlParams);
                  const testSc = test ? this.runBacktest(test, mlParams) : null;
                  const scs = App.Optimizer.calculateCombinedScore(trainSc, testSc);
                  postMlResults.push(scs.finalScore);
                }
                const avgPostMlScore = postMlResults.reduce((a, b) => a + b, 0) / postMlResults.length;
                postMlScore = Math.round(avgPostMlScore * 10) / 10;
              }
            } catch (err) {
              console.warn('Auto-ML training failed:', err.message);
            }
          }

          // 2. Train Rule-Based Veto
          if (trainLosses.length >= 5) {
            try {
              const analysis = App.TradeAnalyzer.analyzeLosses(null, combinedTrainTrades);
              const vetoRules = App.TradeAnalyzer.deriveVetoRules(analysis.summary, analysis.totalLosses);
              if (vetoRules.length > 0) {
                const codes = vetoRules.map(r => r.code);
                
                let postReturnSum = 0;
                let postWinRateSum = 0;
                let beforeReturnSum = 0;
                let beforeWinRateSum = 0;
                let totalBefore = 0;
                let totalAfter = 0;
                let totalVetoed = 0;
                
                const vetoParams = { ...params, veto: { enabled: true, codes } };
                for (const r of datasetResults) {
                  const beforeRes = r.testRes ? this.runBacktest(r.test, params) : r.trainRes;
                  const afterRes = r.testRes ? this.runBacktest(r.test, vetoParams) : this.runBacktest(r.train, vetoParams);
                  
                  beforeReturnSum += beforeRes.totalReturnPercent;
                  beforeWinRateSum += beforeRes.winRatePercent;
                  postReturnSum += afterRes.totalReturnPercent;
                  postWinRateSum += afterRes.winRatePercent;
                  totalBefore += beforeRes.totalTrades;
                  totalAfter += afterRes.totalTrades;

                  let vetoedCount = 0;
                  if (beforeRes.tradeLog) {
                    for (const t of beforeRes.tradeLog) {
                      if (t.features) {
                        const matchedVeto = App.TradeAnalyzer.shouldVeto(null, null, t.side, codes, t.features);
                        if (matchedVeto) {
                          vetoedCount++;
                        }
                      }
                    }
                  }
                  totalVetoed += vetoedCount;
                }
                
                veto = {
                  enabled: true,
                  codes,
                  patterns: vetoRules.map(r => ({ code: r.code, label: r.label, sharePercent: r.percent })),
                  derivedAt: Date.now(),
                  beforeAfter: {
                    beforeWinRate: beforeWinRateSum / datasetResults.length,
                    afterWinRate: postWinRateSum / datasetResults.length,
                    beforeReturn: beforeReturnSum / datasetResults.length,
                    afterReturn: postReturnSum / datasetResults.length,
                    beforeTrades: totalBefore,
                    afterTrades: totalAfter,
                    vetoedTrades: totalVetoed
                  }
                };
              }
            } catch (err) {
              console.warn('Auto-Veto training failed:', err.message);
            }
          }
        }

        App.Optimizer.saveToDb(
          App.Optimizer.state.symbol,
          App.Optimizer.state.timeframe,
          candidateRules,
          combo,
          { trainRes, testRes, scores, stability, crossPhase, veto, mlVeto, postMlScore },
          marketClass,
          datasetRange
        );

        App.Optimizer.state.testsCompletedInPhase++;
        
        setTimeout(runLoop, 5);
      } catch (e) {
        // Surface any unexpected error instead of silently freezing at "Aktiv"
        console.error('Optimizer-Lernschleife abgebrochen:', e);
        App.Optimizer.state.isRunning = false;
        if (startBtn) startBtn.disabled = false;
        if (stopBtn) stopBtn.disabled = true;
        if (statusText) {
          statusText.textContent = 'Fehler — siehe Konsole (F12)';
          statusText.style.color = 'var(--short)';
        }
        App.UI.showToast('Optimizer-Fehler: ' + (e && e.message ? e.message : e), false, 5000);
      }
    };

    runLoop();
  },

  // ---- Post-Optimization Result Modal ----
  showOptimizationResultModal() {
    // Remove any existing modal
    const existing = document.getElementById('opt-result-modal');
    if (existing) existing.remove();

    const best = App.Optimizer.getLeaderboard('all')[0];
    if (!best) return;

    const p = best.params;
    const r = best.results;
    const v = best.validation || {};
    const rules = p.rules || App.state.rules;

    const stateLabel = (s) => s === 'bull' ? '📈 Bull' : s === 'bear' ? '📉 Bear' : '→ Neutral';
    const longRuleLines = (rules.long || []).map(r => `<div style="display:flex;align-items:center;gap:6px;padding:3px 6px;background:rgba(0,200,100,0.08);border-radius:4px;"><span style="color:var(--long);font-weight:700;font-size:9px;min-width:28px;">${r.interval}</span><span style="font-size:9px;color:var(--text-dim);">${stateLabel(r.state)}</span></div>`).join('');
    const shortRuleLines = (rules.short || []).map(r => `<div style="display:flex;align-items:center;gap:6px;padding:3px 6px;background:rgba(255,80,60,0.08);border-radius:4px;"><span style="color:var(--short);font-weight:700;font-size:9px;min-width:28px;">${r.interval}</span><span style="font-size:9px;color:var(--text-dim);">${stateLabel(r.state)}</span></div>`).join('');

    const displayScore = (best.postMlScore !== null && best.postMlScore !== undefined) ? best.postMlScore : best.score;
    const scoreColor = displayScore >= 80 ? '#00e0b8' : displayScore >= 60 ? '#ffb020' : '#ff5c5c';
    const returnColor = r.totalReturnPercent >= 0 ? '#00e0b8' : '#ff5c5c';
    const hasMl = best.mlVeto && best.mlVeto.model;
    const hasVeto = best.veto && best.veto.enabled;

    const overlay = document.createElement('div');
    overlay.id = 'opt-result-modal';
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 9999;
      background: rgba(0,0,0,0.75); backdrop-filter: blur(8px);
      display: flex; align-items: center; justify-content: center;
      animation: fadeIn 0.25s ease;
    `;

    overlay.innerHTML = `
      <style>
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(24px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        #opt-result-modal .modal-card {
          animation: slideUp 0.3s cubic-bezier(0.22, 1, 0.36, 1);
          background: linear-gradient(160deg, #0d1219 0%, #111820 100%);
          border: 1px solid rgba(0,224,184,0.25);
          border-radius: 16px;
          box-shadow: 0 32px 80px rgba(0,0,0,0.8), 0 0 0 1px rgba(0,224,184,0.08);
          width: min(560px, 96vw);
          max-height: 92vh;
          overflow-y: auto;
          font-family: var(--sans, 'Inter', sans-serif);
        }
        #opt-result-modal .modal-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 20px 24px 16px;
          border-bottom: 1px solid rgba(255,255,255,0.07);
        }
        #opt-result-modal .score-ring {
          width: 72px; height: 72px; border-radius: 50%;
          border: 3px solid ${scoreColor};
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          box-shadow: 0 0 20px ${scoreColor}55;
          flex-shrink: 0;
        }
        #opt-result-modal .param-grid {
          display: grid; grid-template-columns: 1fr 1fr 1fr;
          gap: 8px; margin: 0 24px 16px;
        }
        #opt-result-modal .param-box {
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 8px; padding: 10px 12px;
          text-align: center;
        }
        #opt-result-modal .param-label {
          font-size: 8px; text-transform: uppercase; letter-spacing: 0.8px;
          color: rgba(255,255,255,0.35); margin-bottom: 4px;
        }
        #opt-result-modal .param-value {
          font-size: 18px; font-weight: 800; color: #fff;
          font-family: var(--mono, monospace);
        }
        #opt-result-modal .metric-row {
          display: flex; gap: 8px; padding: 0 24px; margin-bottom: 12px;
        }
        #opt-result-modal .metric-pill {
          flex: 1; background: rgba(255,255,255,0.04);
          border-radius: 8px; padding: 10px 8px; text-align: center;
          border: 1px solid rgba(255,255,255,0.07);
        }
        #opt-result-modal .rules-section {
          margin: 0 24px 16px;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 10px; padding: 12px;
        }
        #opt-result-modal .apply-btn {
          display: block; width: calc(100% - 48px); margin: 0 24px 20px;
          padding: 14px; border-radius: 10px;
          background: linear-gradient(135deg, #00c9a0, #00e0b8);
          color: #000; font-weight: 800; font-size: 14px; border: none;
          cursor: pointer; letter-spacing: 0.3px;
          transition: opacity 0.15s, transform 0.15s;
          box-shadow: 0 4px 20px rgba(0,224,184,0.35);
        }
        #opt-result-modal .apply-btn:hover { opacity: 0.9; transform: translateY(-1px); }
        #opt-result-modal .close-link {
          display: block; text-align: center; padding-bottom: 16px;
          font-size: 11px; color: rgba(255,255,255,0.3); cursor: pointer;
        }
        #opt-result-modal .close-link:hover { color: rgba(255,255,255,0.6); }
        #opt-result-modal .badge {
          display: inline-flex; align-items: center; gap: 3px;
          padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: 700;
        }
      </style>
      <div class="modal-card">
        <!-- Header -->
        <div class="modal-header">
          <div>
            <div style="font-size:11px;color:${scoreColor};font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">🏆 ML-Optimierung abgeschlossen</div>
            <div style="font-size:18px;font-weight:800;color:#fff;">Beste Strategie gefunden</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.35);margin-top:2px;">
              ${Object.keys(App.state.optimizerDb).length} Tests durchgeführt
              ${hasMl ? ' &middot; <span style="color:#00e0b8;">ML-Veto aktiv</span>' : ''}
              ${hasVeto ? ' &middot; <span style="color:#d53f8c;">Regel-Veto aktiv</span>' : ''}
            </div>
          </div>
          <div class="score-ring">
            <div style="font-size:22px;font-weight:900;color:${scoreColor};">${displayScore}</div>
            <div style="font-size:8px;color:rgba(255,255,255,0.4);margin-top:1px;">SCORE</div>
          </div>
        </div>

        <!-- Validation badges -->
        <div style="padding: 12px 24px 0; display:flex; gap:6px; flex-wrap:wrap;">
          ${v.validated ? `<span class="badge" style="background:rgba(0,200,100,0.12);color:#00c864;border:1px solid rgba(0,200,100,0.2);">✓ OOS validiert (Train:${v.trainScore} · Test:${v.testScore})</span>` : ''}
          ${v.stabilityScore !== null && v.stabilityScore !== undefined ? `<span class="badge" style="background:rgba(100,180,255,0.1);color:#6eb4ff;border:1px solid rgba(100,180,255,0.2);">⬡ Stabilität ${v.stabilityScore}/100</span>` : ''}
          ${v.crossPhaseScore !== null && v.crossPhaseScore !== undefined ? `<span class="badge" style="background:rgba(255,180,30,0.1);color:#ffb020;border:1px solid rgba(255,180,30,0.2);">⚡ Cross-Phasen ${v.crossPhaseScore}/100</span>` : ''}
        </div>

        <!-- Performance metrics -->
        <div class="metric-row" style="margin-top:16px;">
          <div class="metric-pill">
            <div style="font-size:8px;text-transform:uppercase;color:rgba(255,255,255,0.3);margin-bottom:4px;">Rendite</div>
            <div style="font-size:16px;font-weight:800;color:${returnColor};">${r.totalReturnPercent >= 0 ? '+' : ''}${r.totalReturnPercent.toFixed(1)}%</div>
          </div>
          <div class="metric-pill">
            <div style="font-size:8px;text-transform:uppercase;color:rgba(255,255,255,0.3);margin-bottom:4px;">Win-Rate</div>
            <div style="font-size:16px;font-weight:800;color:#fff;">${r.winRatePercent.toFixed(1)}%</div>
          </div>
          <div class="metric-pill">
            <div style="font-size:8px;text-transform:uppercase;color:rgba(255,255,255,0.3);margin-bottom:4px;">Profit-Faktor</div>
            <div style="font-size:16px;font-weight:800;color:#fff;">${r.profitFactor === 999 ? '∞' : r.profitFactor.toFixed(2)}</div>
          </div>
          <div class="metric-pill">
            <div style="font-size:8px;text-transform:uppercase;color:rgba(255,255,255,0.3);margin-bottom:4px;">Max. DD</div>
            <div style="font-size:16px;font-weight:800;color:#ff9966;">${r.maxDrawdownPercent.toFixed(1)}%</div>
          </div>
        </div>

        <!-- Best Parameters -->
        <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.8px;color:rgba(255,255,255,0.3);padding:0 24px;margin-bottom:8px;">⚙ Beste Parameter</div>
        <div class="param-grid">
          <div class="param-box">
            <div class="param-label">Hebel</div>
            <div class="param-value" style="color:#6eb4ff;">${p.leverage}x</div>
          </div>
          <div class="param-box">
            <div class="param-label">Cooldown</div>
            <div class="param-value">${p.cooldownMin}<span style="font-size:11px;font-weight:400;color:rgba(255,255,255,0.4);"> min</span></div>
          </div>
          <div class="param-box">
            <div class="param-label">Max Trades</div>
            <div class="param-value">${p.maxOpen}</div>
          </div>
          <div class="param-box">
            <div class="param-label">Take Profit</div>
            <div class="param-value" style="color:#00e0b8;">${p.tpPercent}<span style="font-size:11px;font-weight:400;color:rgba(255,255,255,0.4);"> %</span></div>
          </div>
          <div class="param-box">
            <div class="param-label">Stop Loss</div>
            <div class="param-value" style="color:#ff5c5c;">${p.slPercent}<span style="font-size:11px;font-weight:400;color:rgba(255,255,255,0.4);"> %</span></div>
          </div>
          <div class="param-box">
            <div class="param-label">Trades</div>
            <div class="param-value" style="font-size:14px;">${r.totalTrades}</div>
          </div>
        </div>

        <!-- Entry Rules -->
        <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.8px;color:rgba(255,255,255,0.3);padding:0 24px;margin-bottom:8px;">📋 Einstieg-Regeln</div>
        <div class="rules-section">
          ${longRuleLines ? `
            <div style="font-size:9px;font-weight:700;color:var(--long, #00c864);margin-bottom:6px;">LONG</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:${shortRuleLines ? '10px' : '0'}">${longRuleLines}</div>
          ` : '<div style="font-size:10px;color:rgba(255,255,255,0.3);">Keine Long-Regeln</div>'}
          ${shortRuleLines ? `
            <div style="font-size:9px;font-weight:700;color:var(--short, #ff5c5c);margin-bottom:6px;">SHORT</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;">${shortRuleLines}</div>
          ` : ''}
        </div>

        <!-- Action Button -->
        <button class="apply-btn" id="opt-modal-apply-btn">🚀 Diese Parameter auf Bot anwenden</button>
        <div class="close-link" id="opt-modal-close-link">Schließen (nur anzeigen)</div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Apply button → copy best params to bot state
    document.getElementById('opt-modal-apply-btn').addEventListener('click', () => {
      // Apply to bot state
      App.state.bot.leverage = p.leverage;
      App.state.bot.cooldownMin = p.cooldownMin;
      App.state.bot.maxOpen = p.maxOpen;
      App.state.bot.tpPercent = p.tpPercent;
      App.state.bot.slPercent = p.slPercent;
      // Apply rules
      App.state.rules = JSON.parse(JSON.stringify(p.rules));
      // Apply ML veto if present
      if (best.mlVeto && best.mlVeto.model) {
        App.state.bot.mlVeto = { enabled: true, model: best.mlVeto.model, threshold: best.mlVeto.threshold || 0.6 };
      }
      if (best.veto && best.veto.enabled) {
        App.state.bot.veto = { enabled: true, codes: best.veto.codes };
      }
      App.saveToLocalStorage();
      if (App.Bot && App.Bot.renderBotUI) App.Bot.renderBotUI();
      if (App.UI && App.UI.renderRules) App.UI.renderRules();
      App.UI.showToast('✅ Beste Parameter und Regeln wurden auf den Bot angewendet!');
      overlay.remove();
    });

    // Close link
    document.getElementById('opt-modal-close-link').addEventListener('click', () => overlay.remove());

    // Close on overlay background click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
  },

  handleStopOptimizer() {
    App.Optimizer.state.isRunning = false;
    
    const startBtn = document.getElementById('btn-start-optimizer');
    const stopBtn = document.getElementById('btn-stop-optimizer');
    const statusText = document.getElementById('opt-status-text');

    if (startBtn) startBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
    if (statusText) {
      statusText.textContent = 'Gestoppt';
      statusText.style.color = 'var(--short)';
    }

    App.UI.renderLeaderboard('all');
    App.UI.renderHeatmaps();
    App.UI.renderWissensstand();
    if (App.UI.syncResultsVisibility) App.UI.syncResultsVisibility();
    
    App.UI.showToast('Lernprozess gestoppt.');
  },

  wireBacktestEvents() {
    document.getElementById('btn-load-backtest-data').addEventListener('click', () => this.handleLoadBacktestData());
    document.getElementById('btn-run-backtest').addEventListener('click', () => this.handleRunSingleBacktest());

    const clearCacheBtn = document.getElementById('btn-clear-candle-cache');
    if (clearCacheBtn) clearCacheBtn.addEventListener('click', () => this.handleClearCandleCache());

    // Free date-anchor controls: toggle the custom end-date field and keep the live estimate in sync
    const endModeLive = document.getElementById('backtest-end-mode-live');
    const endModeCustom = document.getElementById('backtest-end-mode-custom');
    const endDateWrap = document.getElementById('backtest-end-date-wrap');
    const endDateEl = document.getElementById('backtest-end-date');
    const daysEl = document.getElementById('backtest-days');

    if (endDateEl && !endDateEl.value) {
      endDateEl.value = new Date().toISOString().slice(0, 10);
      endDateEl.max = new Date().toISOString().slice(0, 10);
    }

    const toggleEndMode = () => {
      const mode = document.querySelector('input[name="backtest-end-mode"]:checked')?.value || 'live';
      if (endDateWrap) endDateWrap.style.display = mode === 'custom' ? 'block' : 'none';
      this.updateBacktestEstimate();
    };
    if (endModeLive) endModeLive.addEventListener('change', toggleEndMode);
    if (endModeCustom) endModeCustom.addEventListener('change', toggleEndMode);
    if (endDateEl) endDateEl.addEventListener('change', () => this.updateBacktestEstimate());
    if (daysEl) daysEl.addEventListener('change', () => this.updateBacktestEstimate());
    this.updateBacktestEstimate();
    
    const startOptBtn = document.getElementById('btn-start-optimizer');
    if (startOptBtn) startOptBtn.addEventListener('click', () => this.handleStartOptimizer());

    const stopOptBtn = document.getElementById('btn-stop-optimizer');
    if (stopOptBtn) stopOptBtn.addEventListener('click', () => this.handleStopOptimizer());
    
    document.querySelectorAll('.res-tab').forEach(t => t.addEventListener('click', () => {
      document.querySelectorAll('.res-tab').forEach(x => x.classList.toggle('active', x === t));
      ['trades', 'leaderboard', 'heatmaps', 'wissensstand'].forEach(name => {
        const el = document.getElementById('res-tab-' + name);
        if (el) el.style.display = (name === t.dataset.resTab) ? 'block' : 'none';
      });
      if (t.dataset.resTab === 'leaderboard') {
        const filterVal = document.getElementById('leaderboard-filter')?.value || 'all';
        App.UI.renderLeaderboard(filterVal);
      } else if (t.dataset.resTab === 'heatmaps') {
        App.UI.renderHeatmaps();
      } else if (t.dataset.resTab === 'wissensstand') {
        App.UI.renderWissensstand();
      }
    }));
  }
};
