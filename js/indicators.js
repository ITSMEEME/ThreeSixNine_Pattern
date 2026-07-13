window.App = window.App || {};

App.Indicators = {
  aggregate5mTo10m(candles5m) {
    const groups = {};
    candles5m.forEach(c => {
      const t10 = Math.floor(c.time / 600) * 600;
      if (!groups[t10]) {
        groups[t10] = [];
      }
      groups[t10].push(c);
    });
    
    const times = Object.keys(groups).map(Number).sort((a, b) => a - b);
    return times.map(t10 => {
      const chunk = groups[t10];
      chunk.sort((a, b) => a.time - b.time);
      return {
        time: t10,
        open: chunk[0].open,
        close: chunk[chunk.length - 1].close,
        isClosed: chunk.every(c => c.isClosed)
      };
    });
  },

  updatePatternMetric() {
    if (!App.state.candles1m || App.state.candles1m.length < 9) return;

    const candles = App.state.candles1m.slice(-9);
    const isGreen = c => c.close >= c.open;

    // 3-candle trend
    const c3 = candles.slice(-3);
    const g3 = c3.filter(isGreen).length;
    const r3 = 3 - g3;
    const val3 = g3 >= 2 ? 1 : -1;

    // 6-candle trend
    const c6 = candles.slice(-6);
    const g6 = c6.filter(isGreen).length;
    const r6 = 6 - g6;
    let val6 = 0;
    if (g6 >= 4) val6 = 1;
    else if (r6 >= 4) val6 = -1;

    // 9-candle trend
    const g9 = candles.filter(isGreen).length;
    const r9 = 9 - g9;
    let val9 = 0;
    if (g9 >= 6) val9 = 1;
    else if (r9 >= 6) val9 = -1;

    // Aggregate: Buy if >= 2 signals are green (+1), Sell if >= 2 signals are red (-1)
    const greens = (val3 === 1 ? 1 : 0) + (val6 === 1 ? 1 : 0) + (val9 === 1 ? 1 : 0);
    const reds = (val3 === -1 ? 1 : 0) + (val6 === -1 ? 1 : 0) + (val9 === -1 ? 1 : 0);
    let valAggr = 0;
    if (greens >= 2) valAggr = 1;
    else if (reds >= 2) valAggr = -1;

    App.state.currentAggrSignal = valAggr;

    this.renderPatternUI({ val3, val6, val9, valAggr, g3, r3, g6, r6, g9, r9, greens, reds });
  },

  renderPatternUI({ val3, val6, val9, valAggr, g3, r3, g6, r6, g9, r9, greens, reds }) {
    const format = (val) => {
      if (val > 0) return { symbol: '➔', cls: 'up' };
      if (val < 0) return { symbol: '➔', cls: 'down' };
      return { symbol: '➔', cls: 'neutral' };
    };

    const p3 = format(val3);
    const p6 = format(val6);
    const p9 = format(val9);
    const pAggr = format(valAggr);

    const el3 = document.getElementById('pat-3');
    const el6 = document.getElementById('pat-6');
    const el9 = document.getElementById('pat-9');
    const elAggr = document.getElementById('pat-aggr');

    const det3 = document.getElementById('pat-detail-3');
    const det6 = document.getElementById('pat-detail-6');
    const det9 = document.getElementById('pat-detail-9');
    const detAggr = document.getElementById('pat-detail-aggr');

    const angle3 = (1 - 2 * (g3 / 3)) * 90;
    const angle6 = (1 - 2 * (g6 / 6)) * 90;
    const angle9 = (1 - 2 * (g9 / 9)) * 90;
    const sumSignals = val3 + val6 + val9;
    const angleAggr = -sumSignals * 30;

    if (el3) {
      el3.textContent = p3.symbol;
      el3.className = 'pattern-val ' + p3.cls;
      el3.style.transform = `rotate(${angle3}deg)`;
    }
    if (el6) {
      el6.textContent = p6.symbol;
      el6.className = 'pattern-val ' + p6.cls;
      el6.style.transform = `rotate(${angle6}deg)`;
    }
    if (el9) {
      el9.textContent = p9.symbol;
      el9.className = 'pattern-val ' + p9.cls;
      el9.style.transform = `rotate(${angle9}deg)`;
    }
    if (elAggr) {
      elAggr.textContent = pAggr.symbol;
      elAggr.className = 'pattern-val ' + pAggr.cls;
      elAggr.style.transform = `rotate(${angleAggr}deg)`;
    }

    if (det3) det3.textContent = `${g3}g/${r3}r`;
    if (det6) det6.textContent = `${g6}g/${r6}r`;
    if (det9) det9.textContent = `${g9}g/${r9}r`;
    if (detAggr) detAggr.textContent = `${greens}G/${reds}R`;
  },

  update10mPatternMetric() {
    if (!App.state.candles10m || App.state.candles10m.length < 9) return;

    const candles = App.state.candles10m.slice(-9);
    const isGreen = c => c.close >= c.open;

    // 3-candle trend
    const c3 = candles.slice(-3);
    const g3 = c3.filter(isGreen).length;
    const r3 = 3 - g3;
    const val3 = g3 >= 2 ? 1 : -1;

    // 6-candle trend
    const c6 = candles.slice(-6);
    const g6 = c6.filter(isGreen).length;
    const r6 = 6 - g6;
    let val6 = 0;
    if (g6 >= 4) val6 = 1;
    else if (r6 >= 4) val6 = -1;

    // 9-candle trend
    const g9 = candles.filter(isGreen).length;
    const r9 = 9 - g9;
    let val9 = 0;
    if (g9 >= 6) val9 = 1;
    else if (r9 >= 6) val9 = -1;

    // Aggregate (10m)
    const greens = (val3 === 1 ? 1 : 0) + (val6 === 1 ? 1 : 0) + (val9 === 1 ? 1 : 0);
    const reds = (val3 === -1 ? 1 : 0) + (val6 === -1 ? 1 : 0) + (val9 === -1 ? 1 : 0);
    let valAggr = 0;
    if (greens >= 2) valAggr = 1;
    else if (reds >= 2) valAggr = -1;

    App.state.current10mAggrSignal = valAggr;

    this.render10mPatternUI({ val3, val6, val9, valAggr, g3, r3, g6, r6, g9, r9, greens, reds });
  },

  render10mPatternUI({ val3, val6, val9, valAggr, g3, r3, g6, r6, g9, r9, greens, reds }) {
    const format = (val) => {
      if (val > 0) return { symbol: '➔', cls: 'up' };
      if (val < 0) return { symbol: '➔', cls: 'down' };
      return { symbol: '➔', cls: 'neutral' };
    };

    const p3 = format(val3);
    const p6 = format(val6);
    const p9 = format(val9);
    const pAggr = format(valAggr);

    const el3 = document.getElementById('pat10m-3');
    const el6 = document.getElementById('pat10m-6');
    const el9 = document.getElementById('pat10m-9');
    const elAggr = document.getElementById('pat10m-aggr');

    const det3 = document.getElementById('pat10m-detail-3');
    const det6 = document.getElementById('pat10m-detail-6');
    const det9 = document.getElementById('pat10m-detail-9');
    const detAggr = document.getElementById('pat10m-detail-aggr');

    const angle3 = (1 - 2 * (g3 / 3)) * 90;
    const angle6 = (1 - 2 * (g6 / 6)) * 90;
    const angle9 = (1 - 2 * (g9 / 9)) * 90;
    const sumSignals = val3 + val6 + val9;
    const angleAggr = -sumSignals * 30;

    if (el3) {
      el3.textContent = p3.symbol;
      el3.className = 'pattern-val ' + p3.cls;
      el3.style.transform = `rotate(${angle3}deg)`;
    }
    if (el6) {
      el6.textContent = p6.symbol;
      el6.className = 'pattern-val ' + p6.cls;
      el6.style.transform = `rotate(${angle6}deg)`;
    }
    if (el9) {
      el9.textContent = p9.symbol;
      el9.className = 'pattern-val ' + p9.cls;
      el9.style.transform = `rotate(${angle9}deg)`;
    }
    if (elAggr) {
      elAggr.textContent = pAggr.symbol;
      elAggr.className = 'pattern-val ' + pAggr.cls;
      elAggr.style.transform = `rotate(${angleAggr}deg)`;
    }

    if (det3) det3.textContent = `${g3}g/${r3}r`;
    if (det6) det6.textContent = `${g6}g/${r6}r`;
    if (det9) det9.textContent = `${g9}g/${r9}r`;
    if (detAggr) detAggr.textContent = `${greens}G/${reds}R`;
  },

  calculatePattern(candles) {
    if (!candles || candles.length < 9) return 0;

    const last9 = candles.slice(-9);
    const isGreen = c => c.close >= c.open;

    // 3-candle trend
    const c3 = last9.slice(-3);
    const g3 = c3.filter(isGreen).length;
    const val3 = g3 >= 2 ? 1 : -1;

    // 6-candle trend
    const c6 = last9.slice(-6);
    const g6 = c6.filter(isGreen).length;
    const r6 = 6 - g6;
    const val6 = g6 >= 4 ? 1 : (r6 >= 4 ? -1 : 0);

    // 9-candle trend
    const g9 = last9.filter(isGreen).length;
    const r9 = 9 - g9;
    const val9 = g9 >= 6 ? 1 : (r9 >= 6 ? -1 : 0);

    // Aggregate
    const greens = (val3 === 1 ? 1 : 0) + (val6 === 1 ? 1 : 0) + (val9 === 1 ? 1 : 0);
    const reds = (val3 === -1 ? 1 : 0) + (val6 === -1 ? 1 : 0) + (val9 === -1 ? 1 : 0);

    if (greens >= 2) return 1;
    if (reds >= 2) return -1;
    return 0;
  }
};

