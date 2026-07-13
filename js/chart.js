window.App = window.App || {};

App.Chart = {
  chart: null,
  candleSeries: null,
  volumeSeries: null,
  priceLine: null,
  liqLines: [],
  currentCandle: null,

  timeToLocal(originalTime) {
    const d = new Date(originalTime * 1000);
    return Date.UTC(
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      d.getHours(),
      d.getMinutes(),
      d.getSeconds(),
      d.getMilliseconds()
    ) / 1000;
  },

  initChart() {
    const container = document.getElementById('chart-container');
    this.chart = LightweightCharts.createChart(container, {
      layout: { background: { color: 'transparent' }, textColor: '#7c8797', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 },
      grid: { vertLines: { color: '#131a24' }, horzLines: { color: '#131a24' } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: '#00e0b8', labelBackgroundColor: '#00e0b8' },
        horzLine: { color: '#00e0b8', labelBackgroundColor: '#00e0b8' } },
      rightPriceScale: { borderColor: '#1c2531' },
      timeScale: { borderColor: '#1c2531', timeVisible: true, secondsVisible: false },
      autoSize: true
    });
    this.candleSeries = this.chart.addCandlestickSeries({
      upColor: '#26d97a', downColor: '#ff5c72',
      borderUpColor: '#26d97a', borderDownColor: '#ff5c72',
      wickUpColor: '#26d97a', wickDownColor: '#ff5c72'
    });
    this.volumeSeries = this.chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '', color: '#1c253180'
    });
    this.volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    window.addEventListener('resize', () => this.chart.applyOptions({}));

    const TF_MAP = { '1m':60, '5m':300, '15m':900, '1h':3600, '4h':14400, '1d':86400 };

    this.chart.subscribeCrosshairMove(param => {
      const tooltip = document.getElementById('chart-tooltip');
      if (!tooltip) return;

      if (!param.time || !param.point) {
        tooltip.style.display = 'none';
        return;
      }

      const intervalSeconds = TF_MAP[App.state.timeframe] || 60;
      
      // Find active position matching this candle
      const activePos = App.state.positions.find(p => {
        if (!p.openedAt) return false;
        const candleTimeUTC = Math.floor((p.openedAt / 1000) / intervalSeconds) * intervalSeconds;
        const candleTime = this.timeToLocal(candleTimeUTC);
        return candleTime === param.time;
      });

      // Find closed history item matching this candle
      const closedPos = App.state.history.find(h => {
        if (!h.openedAt) return false;
        const candleTimeUTC = Math.floor((h.openedAt / 1000) / intervalSeconds) * intervalSeconds;
        const candleTime = this.timeToLocal(candleTimeUTC);
        return candleTime === param.time;
      });

      if (activePos) {
        const entryFee = activePos.entryFeeSats ?? App.Engine.fee(activePos.qtyUsd, activePos.entryPrice, App.CONFIG.feeRate);
        const estExitFee = App.state.lastPrice ? App.Engine.fee(activePos.qtyUsd, App.state.lastPrice, App.CONFIG.feeRate) : 0;
        const pnlSats = App.state.lastPrice ? (App.Engine.pnl(activePos.side, activePos.qtyUsd, activePos.entryPrice, App.state.lastPrice) - entryFee - estExitFee) : 0;
        const isWin = pnlSats >= 0;
        tooltip.innerHTML = `
          <div style="font-weight: 700; color: var(--teal); margin-bottom: 6px; border-bottom: 1px solid var(--border-soft); padding-bottom: 4px;">Aktive Position</div>
          <div style="display:flex; justify-content:space-between; gap:12px; margin-bottom: 3px;"><span style="color:var(--text-faint)">Richtung:</span><span class="${activePos.side}">${activePos.side.toUpperCase()} ${activePos.leverage}x</span></div>
          <div style="display:flex; justify-content:space-between; gap:12px; margin-bottom: 3px;"><span style="color:var(--text-faint)">Einstieg:</span><span>${App.UI.fmtUsd(activePos.entryPrice)}</span></div>
          <div style="display:flex; justify-content:space-between; gap:12px;"><span style="color:var(--text-faint)">Netto PnL:</span><span class="${isWin ? 'pnl-pos' : 'pnl-neg'}" style="font-weight: 700;">${isWin ? '+' : ''}${App.UI.fmtSats(pnlSats)}</span></div>
        `;
        
        const x = param.point.x + 15;
        const y = param.point.y + 15;
        tooltip.style.left = x + 'px';
        tooltip.style.top = y + 'px';
        tooltip.style.display = 'block';
      } else if (closedPos) {
        const isWin = closedPos.pnlSats >= 0;
        tooltip.innerHTML = `
          <div style="font-weight: 700; color: var(--text-dim); margin-bottom: 6px; border-bottom: 1px solid var(--border-soft); padding-bottom: 4px;">Geschlossener Trade</div>
          <div style="display:flex; justify-content:space-between; gap:12px; margin-bottom: 3px;"><span style="color:var(--text-faint)">Richtung:</span><span class="${closedPos.side}">${closedPos.side.toUpperCase()} ${closedPos.leverage}x</span></div>
          <div style="display:flex; justify-content:space-between; gap:12px; margin-bottom: 3px;"><span style="color:var(--text-faint)">Einstieg:</span><span>${App.UI.fmtUsd(closedPos.entryPrice)}</span></div>
          <div style="display:flex; justify-content:space-between; gap:12px; margin-bottom: 3px;"><span style="color:var(--text-faint)">Ausstieg:</span><span>${App.UI.fmtUsd(closedPos.exitPrice)}</span></div>
          <div style="display:flex; justify-content:space-between; gap:12px; margin-bottom: 3px;"><span style="color:var(--text-faint)">PnL:</span><span class="${isWin ? 'pnl-pos' : 'pnl-neg'}" style="font-weight: 700;">${isWin ? '+' : ''}${App.UI.fmtSats(closedPos.pnlSats)}</span></div>
          <div style="display:flex; justify-content:space-between; gap:12px;"><span style="color:var(--text-faint)">Grund:</span><span>${closedPos.reason === 'liquidation' ? '⚠ Liq.' : closedPos.reason === 'tp' ? 'Take Profit' : closedPos.reason === 'sl' ? 'Stop Loss' : 'Manuell'}</span></div>
        `;
        
        const x = param.point.x + 15;
        const y = param.point.y + 15;
        tooltip.style.left = x + 'px';
        tooltip.style.top = y + 'px';
        tooltip.style.display = 'block';
      } else {
        tooltip.style.display = 'none';
      }
    });
  },

  updateLiqLines() {
    if (!this.candleSeries) return;
    this.liqLines.forEach(l => this.candleSeries.removePriceLine(l));
    this.liqLines = [];
    App.state.positions.forEach(p => {
      if (p.liqPrice != null) {
        this.liqLines.push(this.candleSeries.createPriceLine({
          price: p.liqPrice, color: '#ffb020', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true, title: `LIQ ${p.side==='long'?'L':'S'}`
        }));
      }
      this.liqLines.push(this.candleSeries.createPriceLine({
        price: p.entryPrice, color: p.side==='long' ? '#26d97a80' : '#ff5c7280', lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true,
        title: `Entry ${p.side==='long'?'L':'S'}`
      }));
      const tpPrice = App.Engine.getTpPrice(p.side, p.qtyUsd, p.entryPrice, p.leverage, p.tpSats);
      if (tpPrice) {
        this.liqLines.push(this.candleSeries.createPriceLine({
          price: tpPrice, color: '#26d97a', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true, title: `TP ${p.side==='long'?'L':'S'}`
        }));
      }
      const slPrice = App.Engine.getSlPrice(p.side, p.qtyUsd, p.entryPrice, p.leverage, p.slSats);
      if (slPrice) {
        this.liqLines.push(this.candleSeries.createPriceLine({
          price: slPrice, color: '#ff5c72', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true, title: `SL ${p.side==='long'?'L':'S'}`
        }));
      }
    });
    this.updateChartMarkers();
  },

  updateChartMarkers() {
    if (!this.candleSeries) return;
    const markers = [];
    const TF_MAP = { '1m':60, '5m':300, '15m':900, '1h':3600, '4h':14400, '1d':86400 };
    const intervalSeconds = TF_MAP[App.state.timeframe] || 60;

    // 1. Active positions entries
    App.state.positions.forEach(p => {
      if (p.openedAt) {
        const candleTimeUTC = Math.floor((p.openedAt / 1000) / intervalSeconds) * intervalSeconds;
        const candleTime = this.timeToLocal(candleTimeUTC);
        markers.push({
          time: candleTime,
          position: p.side === 'long' ? 'belowBar' : 'aboveBar',
          color: p.side === 'long' ? '#26d97a' : '#ff5c72',
          shape: p.side === 'long' ? 'arrowUp' : 'arrowDown',
          text: `${p.side==='long'?'Buy':'Sell'} ${p.leverage}x`
        });
      }
    });

    // 2. Closed historical positions (entries and exits)
    if (App.state.history) {
      App.state.history.slice(0, 20).forEach(h => {
        if (h.openedAt) {
          const candleTimeUTC = Math.floor((h.openedAt / 1000) / intervalSeconds) * intervalSeconds;
          const candleTime = this.timeToLocal(candleTimeUTC);
          markers.push({
            time: candleTime,
            position: h.side === 'long' ? 'belowBar' : 'aboveBar',
            color: h.side === 'long' ? '#26d97a60' : '#ff5c7260',
            shape: h.side === 'long' ? 'arrowUp' : 'arrowDown',
            text: `${h.side==='long'?'Buy':'Sell'} ${h.leverage}x`
          });
        }
        if (h.closedAt) {
          const candleTimeUTC = Math.floor((h.closedAt / 1000) / intervalSeconds) * intervalSeconds;
          const candleTime = this.timeToLocal(candleTimeUTC);
          markers.push({
            time: candleTime,
            position: h.side === 'long' ? 'aboveBar' : 'belowBar',
            color: '#ffb020',
            shape: 'circle',
            text: `Close`
          });
        }
      });
    }

    // Sort ascending by time (Strict requirement of Lightweight Charts)
    markers.sort((a, b) => a.time - b.time);
    this.candleSeries.setMarkers(markers);
  }
};
