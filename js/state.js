window.App = window.App || {};

App.idCounter = 1;

App.state = {
  balanceSats: 1000000, // Will be overridden by CONFIG or loaded state
  positions: [],   // {id, side, qtyUsd, leverage, entryPrice, marginSats, liqPrice, openedAt}
  orders: [],      // {id, side, qtyUsd, leverage, limitPrice, createdAt}
  history: [],     // {id, side, qtyUsd, leverage, entryPrice, exitPrice, pnlSats, feeSats, reason, closedAt}
  lastPrice: null,
  timeframe: '15m',
  orderSide: 'long',
  orderType: 'market',
  candles1m: [],
  candles5m: [],
  candles10m: [],
  backtestCandles: [],
  current10mAggrSignal: 0,
  currentAggrSignal: 0,
  rules: {
    long: [{ interval: '1m', state: 'bull' }],
    short: [{ interval: '1m', state: 'bear' }]
  },
  bot: {
    active: false,
    maxOpen: 6,
    cooldownMin: 10,
    qtyUsd: 121,
    leverage: 10,
    tpPercent: 50,
    slPercent: 25,
    lastTradeTime: 0,
    logs: [],
    // Fine-Tune-Filter, aus der Verlust-Trade-Analyse abgeleitet: blockiert Live-Signale,
    // die historisch gelernten Verlust-Mustern ähneln
    veto: { enabled: false, codes: [], vetoedCount: 0 },
    mlVeto: { enabled: false, model: null, threshold: 0.6, vetoedCount: 0 },
    shadowTrades: [],
    driftHistory: []
  },
  optimizerDb: {},
  // "Marktgesetze"-Bibliothek: Muster, die über mehrere Trainings-Epochen und Marktphasen hinweg
  // bestätigt wurden, statt bei jeder einzelnen Analyse sofort übernommen zu werden
  mlLibrary: { epochs: [], rules: {}, mlFeatures: {} }
};

// Set initial balance from config once loaded
App.initState = () => {
  App.state.balanceSats = App.CONFIG.startBalanceSats;
};

App.nextId = () => (App.idCounter++).toString(36);

// Human-readable relative time, e.g. "gerade eben", "vor 5 Min.", "vor 3 Std."
App.formatRelativeTime = (ts) => {
  if (!ts) return 'unbekannt';
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return 'gerade eben';
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `vor ${hrs} Std.`;
  const days = Math.floor(hrs / 24);
  return `vor ${days} Tag${days === 1 ? '' : 'en'}`;
};

// Lightweight IndexedDB helper for storing large datasets like candles
App.DB = {
  dbName: 'paper-perp-db',
  dbVersion: 1,
  
  open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (e) => {
        const db = request.result;
        if (!db.objectStoreNames.contains('cache')) {
          db.createObjectStore('cache');
        }
      };
    });
  },

  async get(key) {
    try {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('cache', 'readonly');
        const store = transaction.objectStore('cache');
        const request = store.get(key);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
    } catch (e) {
      console.error('IndexedDB get error:', e);
      return null;
    }
  },

  async set(key, value) {
    try {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('cache', 'readwrite');
        const store = transaction.objectStore('cache');
        const request = store.put(value, key);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    } catch (e) {
      console.error('IndexedDB set error:', e);
    }
  },

  async delete(key) {
    try {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('cache', 'readwrite');
        const store = transaction.objectStore('cache');
        const request = store.delete(key);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    } catch (e) {
      console.error('IndexedDB delete error:', e);
    }
  }
};

App.saveToLocalStorage = () => {
  try {
    localStorage.setItem('paper-perp-state', JSON.stringify({
      balanceSats: App.state.balanceSats,
      positions: App.state.positions,
      orders: App.state.orders,
      history: App.state.history,
      timeframe: App.state.timeframe,
      orderSide: App.state.orderSide,
      orderType: App.state.orderType,
      bot: App.state.bot,
      rules: App.state.rules
    }));
    // Save optimizer database separately to prevent it from being cleared on simulation reset
    localStorage.setItem('paper-perp-optimizer-db', JSON.stringify(App.state.optimizerDb));
    // Save the market-laws library separately too — it's cross-strategy learned knowledge,
    // not simulation state, and shouldn't be wiped on reset either
    localStorage.setItem('paper-perp-ml-library', JSON.stringify(App.state.mlLibrary));
  } catch (e) {
    console.error('Fehler beim Speichern in localStorage:', e);
  }
};

App.loadFromLocalStorage = () => {
  const saved = localStorage.getItem('paper-perp-state');
  if (saved){
    try {
      const parsed = JSON.parse(saved);
      App.applyLoadedState(parsed, true);
    } catch(e) {
      console.error('Fehler beim Laden aus localStorage:', e);
    }
  }
  // Load optimizer database separately
  const savedOpt = localStorage.getItem('paper-perp-optimizer-db');
  if (savedOpt) {
    try {
      App.state.optimizerDb = JSON.parse(savedOpt);
    } catch(e) {
      console.error('Fehler beim Laden von optimizerDb aus localStorage:', e);
    }
  }
  // Load the market-laws library separately
  const savedLib = localStorage.getItem('paper-perp-ml-library');
  if (savedLib) {
    try {
      App.state.mlLibrary = JSON.parse(savedLib);
    } catch(e) {
      console.error('Fehler beim Laden der Marktgesetze-Bibliothek aus localStorage:', e);
    }
  }
};

App.saveState = async () => {
  const data = JSON.stringify({ ...App.state, savedAt: Date.now() }, null, 2);
  if (window.showSaveFilePicker){
    try{
      const handle = await window.showSaveFilePicker({
        suggestedName: 'paper-perp-state.json',
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(data);
      await writable.close();
      App.UI.showToast('Zustand gespeichert.');
      return;
    } catch(e){ if (e.name === 'AbortError') return; }
  }
  // Fallback: Download
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'paper-perp-state.json'; a.click();
  URL.revokeObjectURL(url);
  App.UI.showToast('Zustand als Datei heruntergeladen.');
};

App.loadState = async () => {
  if (window.showOpenFilePicker){
    try{
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
      });
      const file = await handle.getFile();
      const text = await file.text();
      try {
        const parsed = JSON.parse(text);
        App.applyLoadedState(parsed);
      } catch (parseErr) {
        App.UI.showToast('Fehler beim Laden: Ungültiges Dateiformat.');
      }
      return;
    } catch(e){ if (e.name === 'AbortError') return; }
  }
  // Fallback: file input
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      App.applyLoadedState(parsed);
    } catch(e) {
      App.UI.showToast('Fehler beim Laden: Ungültiges Dateiformat.');
    }
  };
  input.click();
};

App.applyLoadedState = (data, silent) => {
  if (!data || typeof data !== 'object') {
    if (!silent) App.UI.showToast('Fehler beim Laden: Ungültige Daten.');
    return;
  }
  App.state.balanceSats = data.balanceSats ?? App.CONFIG.startBalanceSats;
  App.state.positions = data.positions ?? [];
  App.state.orders = data.orders ?? [];
  App.state.history = data.history ?? [];
  if (data.timeframe) App.state.timeframe = data.timeframe;
  if (data.orderSide) App.state.orderSide = data.orderSide;
  if (data.orderType) App.state.orderType = data.orderType;
  if (data.bot) {
    App.state.bot = {
      active: data.bot.active ?? false,
      maxOpen: data.bot.maxOpen ?? 6,
      cooldownMin: data.bot.cooldownMin ?? 10,
      qtyUsd: data.bot.qtyUsd ?? 121,
      leverage: data.bot.leverage ?? 10,
      tpPercent: data.bot.tpPercent ?? 50,
      slPercent: data.bot.slPercent ?? 25,
      lastTradeTime: data.bot.lastTradeTime ?? 0,
      logs: data.bot.logs ?? [],
      veto: data.bot.veto ?? { enabled: false, codes: [], vetoedCount: 0 },
      mlVeto: data.bot.mlVeto ?? { enabled: false, model: null, threshold: 0.6, vetoedCount: 0 },
      shadowTrades: data.bot.shadowTrades ?? [],
      driftHistory: data.bot.driftHistory ?? []
    };
  }
  
  // Find highest base-36 ID to restore idCounter properly
  let maxIdVal = 0;
  [...App.state.positions, ...App.state.orders, ...App.state.history].forEach(item => {
    if (item && item.id) {
      const val = parseInt(item.id, 36);
      if (!isNaN(val) && val > maxIdVal) maxIdVal = val;
    }
  });
  App.idCounter = Math.max(App.idCounter, maxIdVal + 1);

  if (data.rules) {
    App.state.rules = data.rules;
  } else {
    App.state.rules = {
      long: [{ interval: '1m', state: 'bull' }],
      short: [{ interval: '1m', state: 'bear' }]
    };
  }

  App.state.optimizerDb = data.optimizerDb ?? {};

  if (App.UI && App.UI.renderAll) {
    App.UI.renderAll();
    App.UI.syncUIFromState();
    if (App.UI.renderLeaderboard) App.UI.renderLeaderboard('all');
    if (App.UI.renderHeatmaps) App.UI.renderHeatmaps();
    if (App.UI.renderWissensstand) App.UI.renderWissensstand();
    if (App.UI.syncResultsVisibility) App.UI.syncResultsVisibility();
  }
  if (App.Chart && App.Chart.updateLiqLines) {
    App.Chart.updateLiqLines();
  }
  if (!silent) App.UI.showToast('Zustand geladen.');
};

App.resetState = () => {
  if (!confirm('Simulation wirklich zurücksetzen? Alle Positionen, Orders und die Historie gehen verloren.')) return;
  App.state.balanceSats = App.CONFIG.startBalanceSats;
  App.state.positions = [];
  App.state.orders = [];
  App.state.history = [];
  App.state.timeframe = '15m';
  App.state.orderSide = 'long';
  App.state.orderType = 'market';
  App.state.bot = {
    active: false,
    maxOpen: 6,
    cooldownMin: 10,
    qtyUsd: 121,
    leverage: 10,
    tpPercent: 50,
    slPercent: 25,
    lastTradeTime: 0,
    logs: [],
    veto: { enabled: false, codes: [], vetoedCount: 0 },
    mlVeto: { enabled: false, model: null, threshold: 0.6, vetoedCount: 0 },
    shadowTrades: [],
    driftHistory: []
  };
  App.state.rules = {
    long: [{ interval: '1m', state: 'bull' }],
    short: [{ interval: '1m', state: 'bear' }]
  };
  App.idCounter = 1;
  try {
    localStorage.removeItem('paper-perp-state');
  } catch (e) {
    console.error(e);
  }
  App.UI.renderAll();
  App.UI.syncUIFromState();
  App.Chart.updateLiqLines();
  App.UI.showToast('Simulation zurückgesetzt.');
};
