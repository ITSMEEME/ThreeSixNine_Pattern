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
            signals: p.signals
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
      const canTrade = (i >= lastCloseIndex + params.cooldownMin) && (activeTrades.length < params.maxOpen);
      const triggerLong = checkRules(params.rules.long);
      const triggerShort = checkRules(params.rules.short);
      
      let triggerAction = 'none';
      if (triggerLong && !triggerShort) triggerAction = 'long';
      else if (triggerShort && !triggerLong) triggerAction = 'short';

      // Fine-Tune-Veto-Schicht: blockiert Signale, die historisch identifizierten
      // Verlust-Mustern ähneln (z.B. Gegentrend, Flash-Move/Liquidationskaskade-Verdacht)
      if (triggerAction !== 'none' && params.veto && params.veto.enabled && params.veto.codes && params.veto.codes.length > 0) {
        const vetoCode = App.TradeAnalyzer.shouldVeto(candles1m, i, triggerAction, params.veto.codes);
        if (vetoCode) {
          vetoedCount++;
          triggerAction = 'none';
        }
      }

      // ML-Fine-Tune: trainiertes Logistik-Modell schätzt die Verlustwahrscheinlichkeit dieses
      // Trades anhand kontinuierlicher Marktmerkmale und blockiert ihn, wenn sie zu hoch ist
      if (triggerAction !== 'none' && params.mlVeto && params.mlVeto.enabled && params.mlVeto.model) {
        const p = App.TradeAnalyzer.shouldVetoML(params.mlVeto.model, candles1m, i, triggerAction, params.mlVeto.threshold || 0.6);
        if (p !== null) {
          mlVetoedCount++;
          triggerAction = 'none';
        }
      }
      
      if (canTrade && triggerAction !== 'none') {
        const side = triggerAction;
        const entryPrice = side === 'long' ? c.close * (1 + params.spread) : c.close * (1 - params.spread);
        const marginSats = App.Engine.margin(params.qtyUsd, entryPrice, params.leverage);
        const entryFeeSats = App.Engine.fee(params.qtyUsd, entryPrice, params.feeRate);
        
        if (balance >= marginSats + entryFeeSats) {
          balance -= (marginSats + entryFeeSats);
          
          const tpSats = Math.round(marginSats * (params.tpPercent / 100));
          const slSats = Math.round(marginSats * (params.slPercent / 100));
          
          const tpPrice = App.Engine.getTpPrice(side, params.qtyUsd, entryPrice, params.leverage, tpSats);
          const slPrice = App.Engine.getSlPrice(side, params.qtyUsd, entryPrice, params.leverage, slSats);
          const liqPrice = App.Engine.liqPrice(side, entryPrice, params.leverage);
          
          // Log signal state at entry
          const entrySignals = uniqueIntervals.map(tf => {
            const data = htfData[tf];
            return {
              interval: tf,
              signal: data.pointer >= 0 ? data.signals[data.pointer] : 0
            };
          });

          activeTrades.push({
            id: (tradeIdCounter++).toString(),
            side: side,
            qtyUsd: params.qtyUsd,
            leverage: params.leverage,
            entryPrice: entryPrice,
            marginSats: marginSats,
            entryFeeSats: entryFeeSats,
            tpPrice: tpPrice,
            slPrice: slPrice,
            liqPrice: liqPrice,
            entryTime: c.time * 1000,
            signals: entrySignals
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

    if (index.length === 0) {
      container.innerHTML = `<div style="font-size: 10px; color: var(--text-faint); font-style: italic;">Noch keine gespeicherten Datensätze. Geladene Kerzen bleiben hier für spätere Sitzungen erhalten.</div>`;
      return;
    }

    container.innerHTML = index.map(e => {
      const isActive = e.key === activeKey;
      const rangeLabel = `${this.formatDateShort(e.fromTime)} – ${this.formatDateShort(e.toTime)}`;
      return `
        <div class="clickable" data-key="${e.key}" style="display:flex; align-items:center; justify-content:space-between; gap:6px; font-size:10px; padding:6px 8px; border-radius:4px; background: var(--surface-2); border:1px solid ${isActive ? 'var(--teal)' : 'var(--border-soft)'};">
          <div style="overflow:hidden;">
            <div style="font-weight:600; color:${isActive ? 'var(--teal)' : 'var(--text-dim)'};">${isActive ? '✓ ' : ''}${e.symbol} &middot; ${e.days}T &middot; ${rangeLabel}</div>
            <div style="color:var(--text-faint); margin-top:2px;">${e.count.toLocaleString()} Kerzen &middot; gespeichert ${App.formatRelativeTime(e.timestamp)}</div>
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
      spread: App.CONFIG.spread
    };
    
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
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-faint);">Keine ausgeführten Trades in diesem Zeitraum.</td></tr>';
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
        
        return `
          <tr>
            <td><span class="side ${typeCls}">${t.side === 'long' ? 'L' : 'S'} ${t.leverage}x</span></td>
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
    if (!App.state.backtestCandles || App.state.backtestCandles.length === 0) {
      App.UI.showToast('Keine Kerzendaten geladen.');
      return;
    }

    const startBtn = document.getElementById('btn-start-optimizer');
    const stopBtn = document.getElementById('btn-stop-optimizer');
    const statusText = document.getElementById('opt-status-text');
    const phaseText = document.getElementById('opt-phase-text');
    const phaseProg = document.getElementById('opt-phase-progress');
    const totalProg = document.getElementById('opt-total-progress');

    if (startBtn) startBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = false;
    if (statusText) {
      statusText.textContent = 'Aktiv';
      statusText.style.color = 'var(--long)';
    }

    App.Optimizer.state.isRunning = true;
    App.Optimizer.state.symbol = document.getElementById('backtest-symbol').value.trim();
    App.Optimizer.state.timeframe = '1m';

    const startBalanceSats = parseFloat(document.getElementById('backtest-capital').value);
    const qtyUsd = parseFloat(document.getElementById('backtest-qty').value);
    const maxOpen = parseInt(document.getElementById('backtest-max-open').value);

    let marketClass, datasetRange;
    try {
      marketClass = App.Optimizer.classifyMarket(App.state.backtestCandles);
      const candles = App.state.backtestCandles;
      datasetRange = candles && candles.length > 0 ? {
        fromTime: candles[0].time,
        toTime: candles[candles.length - 1].time,
        label: `${this.formatDateShort(candles[0].time)} – ${this.formatDateShort(candles[candles.length - 1].time)}`
      } : null;
    } catch (e) {
      // Never let a problem in the (optional) market-phase metadata block the optimizer itself
      console.error('Konnte Marktphasen-Metadaten nicht berechnen, fahre ohne fort:', e);
      marketClass = { regime: 'sideways', volatility: 'low', avgVolume: 0 };
      datasetRange = null;
    }

    // Load up to 2 other cached historical windows (market phases) so promising candidates can
    // be cross-checked against them, not just the currently active dataset
    let phaseDatasets = [];
    try {
      const cacheIndex = await App.Backtest.getCacheIndex();
      let activeKey = null;
      try { activeKey = await App.DB.get('active-candles-key'); } catch (e) { /* ignore */ }
      const others = cacheIndex.filter(e => e.key !== activeKey).sort((a, b) => b.count - a.count).slice(0, 2);
      for (const o of others) {
        const data = await App.DB.get(o.key);
        if (data && data.candles && data.candles.length > 0) {
          phaseDatasets.push({
            label: `${o.symbol} ${this.formatDateShort(o.fromTime)}–${this.formatDateShort(o.toTime)}`,
            candles: data.candles
          });
        }
      }
    } catch (e) {
      console.error('Konnte weitere Marktphasen nicht laden:', e);
    }

    const { train: baseTrain, test: baseTest } = App.Optimizer.splitCandlesForValidation(App.state.backtestCandles);
    const oosActive = !!baseTest;
    const searchRulesEnabled = document.getElementById('opt-search-rules')?.checked ?? true;

    const validationInfoEl = document.getElementById('opt-validation-info');
    if (validationInfoEl) {
      const lines = [];
      lines.push(oosActive
        ? '✓ Out-of-Sample-Validierung aktiv (70% Training / 30% unbekannter Test-Zeitraum)'
        : '⚠ Zeitraum zu kurz für Out-of-Sample-Split (min. ~3,5 Tage nötig) — Score basiert nur auf Training');
      lines.push('✓ Stabilitäts-Check aktiv für Kandidaten ab Score 65');
      lines.push(phaseDatasets.length > 0
        ? `✓ Multi-Phasen-Check aktiv (${phaseDatasets.length} weitere gespeicherte Zeiträume: ${phaseDatasets.map(p => p.label).join(', ')})`
        : 'ℹ Multi-Phasen-Check inaktiv — lade weitere Zeiträume in der Datensatz-Bibliothek, um Strategien phasenübergreifend zu prüfen');
      lines.push(searchRulesEnabled
        ? `✓ Regel-Kombinationen werden mitgesucht (${App.Optimizer.RULE_SEARCH_INTERVALS.join('/')}, 1-2 Timeframes)`
        : 'ℹ Regel-Suche deaktiviert — nutzt ausschließlich die aktuell konfigurierten Regeln');
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

          App.UI.showToast('Lernprozess erfolgreich beendet.');
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

        // Pick an entry-rule combination for this candidate. In later (exploitation) phases,
        // strongly prefer rule combinations that already scored well; still leave room for
        // random exploration so the search doesn't get stuck on an early lucky rule set.
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

        // 1. Out-of-sample validation: train on the first 70%, validate on the unseen last 30%
        const train = baseTrain;
        const test = baseTest;
        const trainRes = this.runBacktest(train, params);
        const testRes = test ? this.runBacktest(test, params) : null;
        const scores = App.Optimizer.calculateCombinedScore(trainRes, testRes);

        let stability = null;
        let crossPhase = null;

        // 2. & 3. Only run the more expensive stability + cross-phase checks on candidates that
        // already look promising, so exploration (phase 1) stays fast
        if (scores.finalScore >= 65) {
          const neighborScores = [];
          for (let n = 0; n < 3; n++) {
            const neighbor = App.Optimizer.perturbCandidate(combo, bounds);
            const neighborParams = { ...params, ...neighbor };
            const neighborRes = this.runBacktest(train, neighborParams);
            neighborScores.push(App.Optimizer.calculateScore(neighborRes));
          }
          stability = App.Optimizer.computeStabilityScore(scores.trainScore, neighborScores);

          if (phaseDatasets.length > 0) {
            const phaseScores = phaseDatasets.map(pd => ({
              label: pd.label,
              score: App.Optimizer.calculateScore(this.runBacktest(pd.candles, params))
            }));
            const avgPhaseScore = phaseScores.reduce((a, b) => a + b.score, 0) / phaseScores.length;
            crossPhase = { score: Math.round(avgPhaseScore * 10) / 10, phases: phaseScores };
          }
        }

        App.Optimizer.saveToDb(
          App.Optimizer.state.symbol,
          App.Optimizer.state.timeframe,
          candidateRules,
          combo,
          { trainRes, testRes, scores, stability, crossPhase },
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
