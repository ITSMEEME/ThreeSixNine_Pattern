window.App = window.App || {};

App.Backtest = {
  async fetchBinance1mCandles(symbol, totalCount, onProgress) {
    let allCandles = [];
    let endTime = Date.now();
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
      tradeLog: tradeLog
    };
  },

  async loadCachedCandles() {
    if (!App.DB || !App.DB.get) return;
    try {
      const cached = await App.DB.get('cached-candles');
      if (cached && cached.candles && cached.candles.length > 0) {
        App.state.backtestCandles = cached.candles;
        
        // Restore input field values
        const symbolEl = document.getElementById('backtest-symbol');
        const daysEl = document.getElementById('backtest-days');
        if (symbolEl) symbolEl.value = cached.symbol;
        if (daysEl) daysEl.value = cached.days;
        
        // Update status text
        const loaderStatus = document.getElementById('backtest-loader-status');
        if (loaderStatus) {
          loaderStatus.textContent = `${cached.candles.length.toLocaleString()} Kerzen (${cached.symbol.toUpperCase()}, ${cached.days} Tage) aus Cache geladen.`;
        }
        
        // Enable buttons
        const runBtn = document.getElementById('btn-run-backtest');
        const optBtn = document.getElementById('btn-start-optimizer');
        if (runBtn) runBtn.disabled = false;
        if (optBtn) optBtn.disabled = false;
      }
    } catch (e) {
      console.error('Fehler beim Laden der zwischengespeicherten Kerzen:', e);
    }
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
    
    if (!symbol) {
      App.UI.showToast('Bitte ein Symbol eingeben.');
      return;
    }
    
    btn.disabled = true;
    progressContainer.style.display = 'block';
    progressBar.style.width = '0%';
    loaderStatus.textContent = 'Verbinde mit Binance und lade Kerzen...';
    
    const totalCount = days * 1440;
    
    try {
      App.state.backtestCandles = await App.Backtest.fetchBinance1mCandles(symbol, totalCount, (percent) => {
        progressBar.style.width = percent + '%';
        loaderStatus.textContent = `Lade Kerzen: ${percent}% geladen...`;
      });
      
      loaderStatus.textContent = `${App.state.backtestCandles.length.toLocaleString()} Kerzen (1m) geladen.`;
      runBtn.disabled = false;
      if (optBtn) optBtn.disabled = false;
      
      // Save candles to IndexedDB cache
      if (App.DB && App.DB.set) {
        await App.DB.set('cached-candles', {
          symbol: symbol,
          days: days,
          candles: App.state.backtestCandles,
          timestamp: Date.now()
        });
      }
      
      App.UI.showToast('Kerzendaten erfolgreich geladen.');
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

    const marketClass = App.Optimizer.classifyMarket(App.state.backtestCandles);

    const phaseTargets = {
      1: 30,
      3: 100,
      5: 50,
      7: 20
    };

    const runLoop = async () => {
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

      let bounds = App.Optimizer.state.bounds;
      
      if (phase === 3 || phase === 5) {
        const clusters = App.Optimizer.getClusterBounds();
        if (clusters && Math.random() < 0.9) {
          bounds = clusters;
        }
      } else if (phase === 7) {
        const clusters = App.Optimizer.getClusterBounds();
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
        cachedRes = App.Optimizer.checkCache(App.Optimizer.state.symbol, App.state.rules, candidate);
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
          cachedRes = App.Optimizer.checkCache(App.Optimizer.state.symbol, App.state.rules, candidate);
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
        rules: App.state.rules,
        feeRate: App.CONFIG.feeRate,
        spread: App.CONFIG.spread
      };

      const backtestRes = this.runBacktest(App.state.backtestCandles, params);
      
      App.Optimizer.saveToDb(
        App.Optimizer.state.symbol,
        App.Optimizer.state.timeframe,
        App.state.rules,
        combo,
        backtestRes,
        marketClass
      );

      App.Optimizer.state.testsCompletedInPhase++;
      
      setTimeout(runLoop, 5);
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
    document.getElementById('btn-load-backtest-data').addEventListener('click', this.handleLoadBacktestData);
    document.getElementById('btn-run-backtest').addEventListener('click', () => this.handleRunSingleBacktest());
    
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
