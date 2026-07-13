window.App = window.App || {};

App.API = {
  ws: null,
  currentRestBaseIndex: 0,
  rateLimitWarningActive: false,
  lastWsUpdateReceived: Date.now(),
  wsReconnectTimeout: null,
  wsReconnectAttempts: 0,

  initWatchdog() {
    // Watchdog checks every 10s: if connection is open but no message received for 18s, trigger a reconnect.
    setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const elapsed = Date.now() - this.lastWsUpdateReceived;
        if (elapsed > 18000) {
          console.warn(`WebSocket Watchdog: Keine Updates seit ${Math.round(elapsed/1000)}s erhalten. Force reconnect...`);
          App.UI.showToast('Datenstrom eingefroren. Starte Verbindung neu…', false, 3000);
          this.connectWs(App.state.timeframe);
        }
      }
    }, 10000);
  },

  checkBinanceRateLimit(res) {
    const BINANCE_WEIGHT_LIMIT_PER_MIN = 1200;
    const usedWeight = parseInt(res.headers.get('x-mbx-used-weight-1m'), 10);
    if (!isNaN(usedWeight)) {
      if (usedWeight >= BINANCE_WEIGHT_LIMIT_PER_MIN * 0.8) {
        if (!this.rateLimitWarningActive) {
          this.rateLimitWarningActive = true;
          App.UI.showToast(`API-Auslastung hoch: ${usedWeight}/${BINANCE_WEIGHT_LIMIT_PER_MIN} Gewichtspunkten.`, false, 5000);
        }
      } else {
        this.rateLimitWarningActive = false;
      }
    }

    if (res.status === 429 || res.status === 418) {
      const retryAfter = parseInt(res.headers.get('retry-after'), 10);
      const waitMsg = !isNaN(retryAfter) ? `Bitte warte ${retryAfter}s.` : 'Bitte kurz warten.';
      const reason = res.status === 418 ? 'IP-Sperre wegen wiederholter Verstöße' : 'Rate-Limit erreicht';
      const err = new Error(`Binance-API gedrosselt (${reason}, Status ${res.status}). ${waitMsg}`);
      err.isRateLimit = true;
      err.retryAfter = isNaN(retryAfter) ? null : retryAfter;
      throw err;
    }
  },

  async fetchBinanceKlines(symbol, interval, limit, endTime = null) {
    const BINANCE_REST_BASES = [
      'https://api.binance.com',
      'https://api1.binance.com',
      'https://api2.binance.com',
      'https://api3.binance.com'
    ];
    let query = `symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`;
    if (endTime !== null) {
      query += `&endTime=${endTime}`;
    }
    
    for (let i = 0; i < BINANCE_REST_BASES.length; i++) {
      const baseIndex = (this.currentRestBaseIndex + i) % BINANCE_REST_BASES.length;
      const base = BINANCE_REST_BASES[baseIndex];
      const url = `${base}/api/v3/klines?${query}`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);
      
      try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        this.checkBinanceRateLimit(res);
        if (!res.ok) throw new Error(`HTTP-Fehler! Status: ${res.status}`);
        
        this.currentRestBaseIndex = baseIndex; // Update target base for efficiency
        return await res.json();
      } catch (error) {
        clearTimeout(timeoutId);
        console.warn(`Binance REST Request failed on endpoint ${base}:`, error);
        
        if (error.isRateLimit) {
          throw error;
        }
        
        if (i === BINANCE_REST_BASES.length - 1) {
          throw new Error('Alle Binance API Endpunkte sind fehlgeschlagen.');
        }
      }
    }
  },

  async loadHistory(tf){
    try {
      const raw = await this.fetchBinanceKlines(App.CONFIG.symbol, tf, App.CONFIG.klineLimit);
      const candles = raw.map(k => ({ time: App.Chart.timeToLocal(Math.floor(k[0]/1000)), open:+k[1], high:+k[2], low:+k[3], close:+k[4] }));
      const volumes = raw.map(k => ({ time: App.Chart.timeToLocal(Math.floor(k[0]/1000)), value:+k[5], color: (+k[4] >= +k[1]) ? '#26d97a30' : '#ff5c7230' }));
      App.Chart.candleSeries.setData(candles);
      App.Chart.volumeSeries.setData(volumes);
      App.Chart.currentCandle = candles[candles.length - 1];
      const last = raw[raw.length-1];
      App.UI.onPriceUpdate(+last[4]);
    } catch (error) {
      console.error('Fehler beim Laden der Historie:', error);
      App.UI.showToast(error.isRateLimit ? error.message : 'Fehler beim Laden der Kursdaten von Binance.', false, error.isRateLimit ? 5000 : 3200);
    }
  },

  updateWsStatus(status) {
    const el = document.getElementById('ws-status');
    if (!el) return;
    
    el.className = 'brand-status ' + status;
    const dot = el.querySelector('.status-dot');
    const text = el.querySelector('.status-text');
    
    if (status === 'connected') {
      text.textContent = 'Live';
    } else if (status === 'connecting') {
      text.textContent = 'Verbinden';
    } else {
      text.textContent = 'Offline';
    }
  },

  activeCandles: {},

  getActiveIntervals() {
    const list = new Set();
    const rules = App.state.rules || {};
    if (rules.long) rules.long.forEach(r => list.add(r.interval));
    if (rules.short) rules.short.forEach(r => list.add(r.interval));
    return Array.from(list);
  },

  async loadActiveIntervalsHistory() {
    const activeTfs = this.getActiveIntervals();
    for (let tf of activeTfs) {
      if (!this.activeCandles[tf]) {
        try {
          const raw = await this.fetchBinanceKlines(App.CONFIG.symbol, tf, 20);
          this.activeCandles[tf] = raw.map(k => ({
            time: Math.floor(k[0]/1000),
            open: +k[1],
            close: +k[4],
            isClosed: true
          }));
        } catch (error) {
          console.error(`Fehler beim Laden der Historie fuer ${tf}:`, error);
        }
      }
    }
  },

  connectWs(tf){
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
    }
    this.updateWsStatus('connecting');
    
    const activeTfs = this.getActiveIntervals();
    let streams = [`${App.CONFIG.symbol}@aggTrade`, `${App.CONFIG.symbol}@kline_1m`, `${App.CONFIG.symbol}@kline_5m`];
    activeTfs.forEach(activeTf => {
      if (activeTf !== '1m' && activeTf !== '5m') {
        streams.push(`${App.CONFIG.symbol}@kline_${activeTf}`);
      }
    });
    if (tf !== '1m' && tf !== '5m' && !activeTfs.includes(tf)) {
      streams.push(`${App.CONFIG.symbol}@kline_${tf}`);
    }
    streams = Array.from(new Set(streams));
    
    const streamUrl = `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`;
    this.ws = new WebSocket(streamUrl);
    
    this.ws.onopen = () => {
      this.updateWsStatus('connected');
      this.wsReconnectAttempts = 0;
      this.lastWsUpdateReceived = Date.now();
    };
    
    this.ws.onmessage = (ev) => {
      this.lastWsUpdateReceived = Date.now();
      const msg = JSON.parse(ev.data);
      const stream = msg.stream;
      const data = msg.data;
      
      if (stream && stream.endsWith('@aggTrade')) {
        const price = +data.p;
        if (App.Chart.currentCandle) {
          App.Chart.currentCandle.close = price;
          if (price > App.Chart.currentCandle.high) App.Chart.currentCandle.high = price;
          if (price < App.Chart.currentCandle.low) App.Chart.currentCandle.low = price;
          App.Chart.candleSeries.update(App.Chart.currentCandle);
        }
        App.UI.onPriceUpdate(price);
      } else if (stream && stream.includes('@kline_')) {
        const k = data.k;
        const interval = k.i;
        
        if (stream.endsWith(`@kline_${tf}`)) {
          const candle = { time: App.Chart.timeToLocal(Math.floor(k.t/1000)), open:+k.o, high:+k.h, low:+k.l, close:+k.c };
          App.Chart.candleSeries.update(candle);
          App.Chart.volumeSeries.update({ time: candle.time, value:+k.v, color: (+k.c >= +k.o) ? '#26d97a30' : '#ff5c7230' });
          App.Chart.currentCandle = candle;
          App.UI.onPriceUpdate(+k.c);
        }
        
        if (activeTfs.includes(interval)) {
          const t = Math.floor(k.t/1000);
          const candle = { time: t, open: +k.o, close: +k.c, isClosed: k.x };
          if (!this.activeCandles[interval]) {
            this.activeCandles[interval] = [];
          }
          const list = this.activeCandles[interval];
          const idx = list.findIndex(c => c.time === t);
          if (idx !== -1) {
            list[idx] = candle;
          } else {
            list.push(candle);
            if (list.length > 25) {
              list.shift();
            }
          }
        }
        
        if (stream.endsWith('@kline_1m')) {
          const t = Math.floor(k.t/1000);
          const candle = { time: t, open: +k.o, close: +k.c, isClosed: k.x };
          const idx = App.state.candles1m.findIndex(c => c.time === t);
          if (idx !== -1) {
            App.state.candles1m[idx] = candle;
          } else {
            App.state.candles1m.push(candle);
            if (App.state.candles1m.length > 20) {
              App.state.candles1m.shift();
            }
          }
          App.Indicators.updatePatternMetric();
          if (k.x && App.state.bot && App.state.bot.active) {
            App.Bot.runBotLogic();
          }
        }
        
        if (stream.endsWith('@kline_5m')) {
          const t = Math.floor(k.t/1000);
          const candle = { time: t, open: +k.o, close: +k.c, isClosed: k.x };
          const idx = App.state.candles5m.findIndex(c => c.time === t);
          if (idx !== -1) {
            App.state.candles5m[idx] = candle;
          } else {
            App.state.candles5m.push(candle);
            if (App.state.candles5m.length > 40) {
              App.state.candles5m.shift();
            }
          }
          App.state.candles10m = App.Indicators.aggregate5mTo10m(App.state.candles5m);
          App.Indicators.update10mPatternMetric();
        }
      }
    };
    
    this.ws.onerror = (err) => {
      console.error('WebSocket Fehler:', err);
      this.updateWsStatus('disconnected');
    };
    
    this.ws.onclose = () => {
      this.updateWsStatus('disconnected');
      this.wsReconnectAttempts++;
      const backoff = Math.min(1000 * Math.pow(1.5, this.wsReconnectAttempts), 15000);
      console.log(`WebSocket geschlossen. Reconnect in ${Math.round(backoff)}ms...`);
      if (this.wsReconnectTimeout) clearTimeout(this.wsReconnectTimeout);
      this.wsReconnectTimeout = setTimeout(() => {
        if (App.state.timeframe === tf) this.connectWs(tf);
      }, backoff);
    };
  },

  async load1mHistory(){
    try {
      const raw = await this.fetchBinanceKlines(App.CONFIG.symbol, '1m', 15);
      App.state.candles1m = raw.map(k => ({
        time: Math.floor(k[0]/1000),
        open: +k[1],
        close: +k[4],
        isClosed: true
      }));
      App.Indicators.updatePatternMetric();
    } catch (error) {
      console.error('Fehler beim Laden der 1m-Historie:', error);
      if (error.isRateLimit) App.UI.showToast(error.message, false, 5000);
    }
  },

  async load10mHistory(){
    try {
      const raw = await this.fetchBinanceKlines(App.CONFIG.symbol, '5m', 30);
      App.state.candles5m = raw.map(k => ({
        time: Math.floor(k[0]/1000),
        open: +k[1],
        close: +k[4],
        isClosed: true
      }));
      App.state.candles10m = App.Indicators.aggregate5mTo10m(App.state.candles5m);
      App.Indicators.update10mPatternMetric();
    } catch (error) {
      console.error('Fehler beim Laden der 10m-Historie:', error);
      if (error.isRateLimit) App.UI.showToast(error.message, false, 5000);
    }
  }
};
