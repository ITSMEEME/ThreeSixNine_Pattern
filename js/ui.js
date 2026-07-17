window.App = window.App || {};

App.UI = {
  toastTimer: null,
  prevPrice: null,

  fmtUsd(v){ return v==null ? '—' : '$' + v.toLocaleString('en-US', {maximumFractionDigits:1}); },
  
  fmtSats(v){
    if (v == null) return '—';
    const sign = v > 0 ? '+' : '';
    return sign + Math.round(v).toLocaleString('en-US') + ' sats';
  },
  
  fmtBtc(sats){ return (sats/App.SATS_PER_BTC).toFixed(6) + ' BTC'; },

  showToast(msg, isLiq, durationMs){
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show' + (isLiq ? ' liq' : '');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('show'), durationMs || 3200);
  },

  updatePriceUI(price){
    const el = document.getElementById('live-px');
    if (!el) return;
    el.textContent = this.fmtUsd(price);
    el.classList.remove('up','down');
    if (this.prevPrice != null){ el.classList.add(price >= this.prevPrice ? 'up' : 'down'); }
  },

  onPriceUpdate(price){
    this.prevPrice = App.state.lastPrice;
    App.state.lastPrice = price;
    App.Engine.checkLimitOrders(price);
    App.Engine.checkTpSl(price);
    App.Engine.checkLiquidations(price);
    this.updatePriceUI(price);
    if (App.Chart && App.Chart.updateLiqLines) App.Chart.updateLiqLines();
    this.renderPositions();
    this.updateHeaderStats();
    this.updatePreview();
  },

  updatePreview(){
    const qtyInput = document.getElementById('in-qty');
    const levInput = document.getElementById('in-lev');
    const limitPriceInput = document.getElementById('in-limit-price');
    const pvEntry = document.getElementById('pv-entry');
    const pvMargin = document.getElementById('pv-margin');
    const pvFee = document.getElementById('pv-fee');
    const pvLiq = document.getElementById('pv-liq');
    const qtyMarginHint = document.getElementById('qty-margin-hint');

    if (!qtyInput || !levInput || !limitPriceInput) return;

    const qty = parseFloat(qtyInput.value) || 0;
    const lev = parseInt(levInput.value) || 1;
    const side = App.state.orderSide;
    const isLimit = App.state.orderType === 'limit';
    const limitPrice = parseFloat(limitPriceInput.value) || null;
    const refPrice = isLimit && limitPrice ? limitPrice : App.state.lastPrice;

    if (pvEntry) pvEntry.textContent = refPrice ? this.fmtUsd(refPrice) : '—';
    if (!refPrice || qty <= 0){
      if (pvMargin) pvMargin.textContent = '—';
      if (pvFee) pvFee.textContent = '—';
      if (pvLiq) pvLiq.textContent = '—';
      if (qtyMarginHint) qtyMarginHint.textContent = '';
      return;
    }
    const margin = App.Engine.margin(qty, refPrice, lev);
    const fee = App.Engine.fee(qty, refPrice, App.CONFIG.feeRate);
    const liq = App.Engine.liqPrice(side, refPrice, lev);
    if (pvMargin) pvMargin.textContent = this.fmtSats(margin).replace('+','');
    if (pvFee) pvFee.textContent = this.fmtSats(fee).replace('+','');
    if (pvLiq) pvLiq.textContent = liq ? this.fmtUsd(liq) : '— (kein Liq. Risiko)';
    if (qtyMarginHint) qtyMarginHint.textContent = 'Margin: ' + Math.round(margin).toLocaleString() + ' sats';
  },

  submitOrder(){
    const qtyInput = document.getElementById('in-qty');
    const levInput = document.getElementById('in-lev');
    const limitPriceInput = document.getElementById('in-limit-price');
    const tpInput = document.getElementById('in-tp');
    const slInput = document.getElementById('in-sl');
    const tpslContainer = document.getElementById('tpsl-container');
    const tpslToggleIcon = document.getElementById('tpsl-toggle-icon');

    if (!qtyInput || !levInput || !limitPriceInput || !tpInput || !slInput) return;

    const qty = parseFloat(qtyInput.value) || 0;
    const lev = parseInt(levInput.value) || 1;
    const side = App.state.orderSide;
    if (qty <= 0){ this.showToast('Positionsgröße muss > 0 sein.'); return; }
    if (!App.state.lastPrice){ this.showToast('Warte auf Kursdaten…'); return; }

    const tp = Math.round(Math.abs(parseFloat(tpInput.value))) || null;
    const sl = Math.round(Math.abs(parseFloat(slInput.value))) || null;

    if (App.state.orderType === 'market'){
      App.Engine.openPosition(side, qty, lev, 'market', App.state.lastPrice, null, tp, sl);
    } else {
      const limitPrice = parseFloat(limitPriceInput.value);
      if (!limitPrice || limitPrice <= 0){ this.showToast('Bitte gültigen Limit-Preis angeben.'); return; }
      
      const isImmediate = (side === 'long' && limitPrice >= App.state.lastPrice) ||
                          (side === 'short' && limitPrice <= App.state.lastPrice);
                          
      if (isImmediate) {
        App.Engine.openPosition(side, qty, lev, 'market', App.state.lastPrice, null, tp, sl);
        this.showToast(`Limit-Order sofort ausgeführt @ ${this.fmtUsd(App.state.lastPrice)}`);
      } else {
        App.state.orders.push({ id: App.nextId(), side, qtyUsd: qty, leverage: lev, limitPrice, tpSats: tp, slSats: sl, createdAt: Date.now() });
        this.showToast(`Limit-Order platziert @ ${this.fmtUsd(limitPrice)}`);
      }
    }

    // Reset TP/SL inputs and collapse container
    tpInput.value = '';
    slInput.value = '';
    if (tpslContainer) tpslContainer.style.display = 'none';
    if (tpslToggleIcon) tpslToggleIcon.textContent = '▶';

    this.renderAll();
  },

  updateHeaderStats(){
    const upnl = App.state.lastPrice ? App.Engine.unrealizedPnl(App.state.lastPrice) : 0;
    const equity = App.state.balanceSats + App.state.positions.reduce((s,p)=>s+p.marginSats,0) + upnl;
    
    const balanceEl = document.getElementById('stat-balance');
    const balanceUsdEl = document.getElementById('stat-balance-usd');
    const upnlEl = document.getElementById('stat-upnl');
    const equityEl = document.getElementById('stat-equity');

    if (balanceEl) balanceEl.textContent = Math.round(App.state.balanceSats).toLocaleString() + ' sats';
    if (balanceUsdEl) balanceUsdEl.textContent = App.state.lastPrice ? '$' + (App.state.balanceSats/App.SATS_PER_BTC*App.state.lastPrice).toFixed(2) : '—';
    if (upnlEl) {
      upnlEl.textContent = this.fmtSats(upnl);
      upnlEl.style.color = upnl > 0 ? 'var(--long)' : upnl < 0 ? 'var(--short)' : 'var(--text)';
    }
    if (equityEl) equityEl.textContent = Math.round(equity).toLocaleString() + ' sats';
  },

  renderPositions(){
    const wrap = document.getElementById('tab-positions');
    const cntPos = document.getElementById('cnt-pos');
    if (!wrap) return;
    if (cntPos) cntPos.textContent = App.state.positions.length ? `(${App.state.positions.length})` : '';
    if (App.state.positions.length === 0){
      wrap.innerHTML = `<div class="empty-state">Keine offenen Positionen.<br>Platziere eine Order, um zu starten.</div>`;
      return;
    }
    const mp = App.state.lastPrice;
    wrap.innerHTML = App.state.positions.map(p => {
      const pnl = mp ? App.Engine.pnl(p.side, p.qtyUsd, p.entryPrice, mp) : 0;
      const pnlPct = p.marginSats ? (pnl / p.marginSats * 100) : 0;
      const pnlClass = pnl >= 0 ? 'pnl-pos' : 'pnl-neg';

      const entryFee = p.entryFeeSats ?? App.Engine.fee(p.qtyUsd, p.entryPrice, App.CONFIG.feeRate);
      const estExitFee = mp ? App.Engine.fee(p.qtyUsd, mp, App.CONFIG.feeRate) : App.Engine.fee(p.qtyUsd, p.entryPrice, App.CONFIG.feeRate);
      const totalFees = entryFee + estExitFee;
      const netPnl = pnl - totalFees;
      const netPnlPct = p.marginSats ? (netPnl / p.marginSats * 100) : 0;
      const netPnlClass = netPnl >= 0 ? 'pnl-pos' : 'pnl-neg';

      return `
      <div class="pos-card" style="padding: 10px 14px; border-bottom: 1px solid var(--border-soft); font-family: var(--mono); font-size: 11px;">
        <!-- Zeile 1: Richtung, Hebel, Größe und Netto PnL -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="pos-badge ${p.side}" style="padding: 1px 5px; font-size: 9px; line-height: 1;">${p.side==='long'?'LONG':'SHORT'}</span>
            <span class="pos-lev" style="font-size: 10px; margin-left: 0;">${p.leverage}x</span>
            <strong style="color: var(--text); font-size: 12px;">${this.fmtUsd(p.qtyUsd)}</strong>
          </div>
          <div class="${netPnlClass}" style="font-weight: 700; font-size: 12px; text-align: right;">
            ${netPnl >= 0 ? '+' : ''}${Math.round(netPnl).toLocaleString()} sats (${netPnlPct >= 0 ? '+' : ''}${netPnlPct.toFixed(1)}%)
          </div>
        </div>
        
        <!-- Zeile 2: Einstiegspreis, Markpreis, Liquidation und Aktionen -->
        <div style="display: flex; justify-content: space-between; align-items: center; color: var(--text-dim); font-size: 10px; margin-bottom: 6px;">
          <div>
            Entry: <span style="color: var(--text);">${this.fmtUsd(p.entryPrice)}</span> | 
            Mark: <span style="color: var(--text);">${mp ? this.fmtUsd(mp) : '—'}</span> | 
            Liq: <span style="color: var(--amber); font-weight: 600;">${p.liqPrice ? this.fmtUsd(p.liqPrice) : '—'}</span>
          </div>
          <div style="display: flex; gap: 4px;">
            <button class="pos-edit-tpsl" data-edit-tpsl="${p.id}">TP/SL</button>
            <button class="pos-close" data-close="${p.id}">Schließen</button>
          </div>
        </div>

        <!-- Zeile 3: Margin, Gebühren, TP / SL -->
        <div style="display: flex; justify-content: space-between; color: var(--text-faint); font-size: 9px; padding-top: 4px; border-top: 1px dashed var(--border-soft);">
          <div>
            Margin: <span style="color: var(--text-dim);">${Math.round(p.marginSats).toLocaleString()} sats</span> | 
            Fees: <span style="color: var(--text-dim);">${Math.round(totalFees).toLocaleString()} sats</span>
          </div>
          <div>
            TP: <span style="color: var(--long);">${p.tpSats ? ('+' + p.tpSats.toLocaleString() + ' sats') : '—'}</span> | 
            SL: <span style="color: var(--short);">${p.slSats ? ('-' + p.slSats.toLocaleString() + ' sats') : '—'}</span>
          </div>
        </div>
      </div>`;
    }).join('');
    wrap.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => App.Engine.closePosition(btn.dataset.close, App.state.lastPrice, 'manual'));
    });
    wrap.querySelectorAll('[data-edit-tpsl]').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = App.state.positions.find(x => x.id === btn.dataset.editTpsl);
        if (!p) return;
        const newTpStr = prompt(`Take Profit in sats für ${p.side.toUpperCase()} (aktuell: ${p.tpSats ? p.tpSats + ' sats' : 'kein'}):`, p.tpSats || '');
        if (newTpStr === null) return;
        const newSlStr = prompt(`Stop Loss in sats für ${p.side.toUpperCase()} (aktuell: ${p.slSats ? p.slSats + ' sats' : 'kein'}):`, p.slSats || '');
        if (newSlStr === null) return;
        p.tpSats = Math.round(Math.abs(parseFloat(newTpStr))) || null;
        p.slSats = Math.round(Math.abs(parseFloat(newSlStr))) || null;
        this.renderAll();
      });
    });
  },

  renderOrders(){
    const wrap = document.getElementById('tab-orders');
    const cntOrd = document.getElementById('cnt-ord');
    if (!wrap) return;
    if (cntOrd) cntOrd.textContent = App.state.orders.length ? `(${App.state.orders.length})` : '';
    if (App.state.orders.length === 0){
      wrap.innerHTML = `<div class="empty-state">Keine offenen Limit-Orders.</div>`;
      return;
    }
    wrap.innerHTML = App.state.orders.map(o => `
      <div class="pos-card">
        <div class="pos-top">
          <div><span class="pos-badge ${o.side}">${o.side==='long'?'LONG':'SHORT'}</span><span class="pos-lev">${o.leverage}x Limit</span></div>
          <button class="order-cancel" data-cancel="${o.id}">✕</button>
        </div>
        <div class="pos-grid">
          <div class="k">Größe</div><div class="v">${this.fmtUsd(o.qtyUsd)}</div>
          <div class="k">Limit-Preis</div><div class="v">${this.fmtUsd(o.limitPrice)}</div>
          <div class="k">Take Profit</div><div class="v" style="color:var(--long)">${o.tpSats ? ('+' + o.tpSats.toLocaleString() + ' sats') : '—'}</div>
          <div class="k">Stop Loss</div><div class="v" style="color:var(--short)">${o.slSats ? ('-' + o.slSats.toLocaleString() + ' sats') : '—'}</div>
        </div>
      </div>`).join('');
    wrap.querySelectorAll('[data-cancel]').forEach(btn => {
      btn.addEventListener('click', () => {
        App.state.orders = App.state.orders.filter(o => o.id !== btn.dataset.cancel);
        this.renderAll();
      });
    });
  },

  renderHistory(){
    const wrap = document.getElementById('tab-history');
    if (!wrap) return;
    if (App.state.history.length === 0){
      wrap.innerHTML = `<div class="empty-state">Noch keine geschlossenen Trades.</div>`;
      return;
    }
    wrap.innerHTML = `<div class="hist-row" style="color:var(--text-faint); font-weight:600;">
        <div>Seite</div><div>Entry → Exit</div><div>PnL</div><div>Grund</div>
      </div>` + App.state.history.map(h => `
      <div class="hist-row">
        <div class="side ${h.side}">${h.side==='long'?'L':'S'} ${h.leverage}x</div>
        <div>${this.fmtUsd(h.entryPrice)} → ${this.fmtUsd(h.exitPrice)}</div>
        <div class="${h.pnlSats>=0?'side long':'side short'}">${this.fmtSats(h.pnlSats)}</div>
        <div>${h.reason === 'liquidation' ? '⚠ Liq.' : h.reason === 'tp' ? 'Take Profit' : h.reason === 'sl' ? 'Stop Loss' : 'Manuell'}</div>
      </div>`).join('');
  },

  renderAll(){
    this.updateHeaderStats();
    this.renderPositions();
    this.renderOrders();
    this.renderHistory();
    this.updatePreview();
    if (App.Bot && App.Bot.renderBotUI) App.Bot.renderBotUI();
    this.renderRules();
    if (App.Chart && App.Chart.updateLiqLines) App.Chart.updateLiqLines();
    this.syncResultsVisibility();
    App.saveToLocalStorage();
  },

  syncUIFromState(){
    // Side buttons
    document.querySelectorAll('.side-btn').forEach(b => {
      const active = b.dataset.side === App.state.orderSide;
      b.classList.toggle('active', active);
    });
    
    // Submit button classes and text
    const submit = document.getElementById('btn-submit');
    if (submit) {
      submit.className = 'submit-btn ' + App.state.orderSide;
      submit.textContent = (App.state.orderSide === 'long' ? 'Long' : 'Short') + (App.state.orderType==='limit' ? ' Order platzieren' : ' eröffnen');
    }
    
    // Order type buttons
    document.querySelectorAll('.otype-btn').forEach(b => {
      const active = b.dataset.otype === App.state.orderType;
      b.classList.toggle('active', active);
    });
    const limitField = document.getElementById('limit-price-field');
    if (limitField) {
      limitField.style.display = App.state.orderType === 'limit' ? 'block' : 'none';
    }
  },

  renderRules() {
    const listLong = document.getElementById('rules-list-long');
    const listShort = document.getElementById('rules-list-short');
    const btListLong = document.getElementById('backtest-rules-list-long');
    const btListShort = document.getElementById('backtest-rules-list-short');

    const intervals = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d'];
    const states = [
      { value: 'bull', label: 'Bull' },
      { value: 'bear', label: 'Bear' },
      { value: 'neutral', label: 'Neutral' }
    ];

    const generateRowHtml = (rule, index, side) => {
      const intervalOptions = intervals.map(tf => 
        `<option value="${tf}" ${rule.interval === tf ? 'selected' : ''}>${tf}</option>`
      ).join('');
      
      const stateOptions = states.map(st => 
        `<option value="${st.value}" ${rule.state === st.value ? 'selected' : ''}>${st.label}</option>`
      ).join('');

      return `
        <div class="rule-row" data-side="${side}" data-index="${index}">
          <select class="rule-select rule-interval-select">
            ${intervalOptions}
          </select>
          <select class="rule-select rule-state-select">
            ${stateOptions}
          </select>
          <button type="button" class="btn-delete-rule" title="Entfernen">✕</button>
        </div>
      `;
    };

    const populate = (container, side) => {
      if (!container) return;
      const rules = App.state.rules[side] || [];
      container.innerHTML = rules.map((r, i) => generateRowHtml(r, i, side)).join('');
      
      container.querySelectorAll('.rule-row').forEach(row => {
        const index = parseInt(row.dataset.index);
        
        row.querySelector('.rule-interval-select').addEventListener('change', (e) => {
          App.state.rules[side][index].interval = e.target.value;
          App.saveToLocalStorage();
          App.API.loadActiveIntervalsHistory().then(() => {
            App.API.connectWs(App.state.timeframe);
          });
          this.renderRules();
        });
        
        row.querySelector('.rule-state-select').addEventListener('change', (e) => {
          App.state.rules[side][index].state = e.target.value;
          App.saveToLocalStorage();
          this.renderRules();
        });
        
        row.querySelector('.btn-delete-rule').addEventListener('click', () => {
          App.state.rules[side].splice(index, 1);
          App.saveToLocalStorage();
          App.API.loadActiveIntervalsHistory().then(() => {
            App.API.connectWs(App.state.timeframe);
          });
          this.renderRules();
        });
      });
    };

    populate(listLong, 'long');
    populate(listShort, 'short');
    populate(btListLong, 'long');
    populate(btListShort, 'short');
  },

  switchTimeframe(tf){
    App.state.timeframe = tf;
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.toggle('active', b.dataset.tf === tf));
    App.API.loadHistory(tf);
    App.API.connectWs(tf);
  },

  wireEvents(){
    document.querySelectorAll('.tf-btn').forEach(b => b.addEventListener('click', () => this.switchTimeframe(b.dataset.tf)));

    document.querySelectorAll('.side-btn').forEach(b => b.addEventListener('click', () => {
      App.state.orderSide = b.dataset.side;
      document.querySelectorAll('.side-btn').forEach(x => x.classList.toggle('active', x === b));
      const submit = document.getElementById('btn-submit');
      if (submit) {
        submit.className = 'submit-btn ' + App.state.orderSide;
        submit.textContent = (App.state.orderSide === 'long' ? 'Long' : 'Short') + (App.state.orderType==='limit' ? ' Order platzieren' : ' eröffnen');
      }
      this.updatePreview();
    }));

    document.querySelectorAll('.otype-btn').forEach(b => b.addEventListener('click', () => {
      App.state.orderType = b.dataset.otype;
      document.querySelectorAll('.otype-btn').forEach(x => x.classList.toggle('active', x === b));
      const limitField = document.getElementById('limit-price-field');
      if (limitField) limitField.style.display = App.state.orderType === 'limit' ? 'block' : 'none';
      const submit = document.getElementById('btn-submit');
      if (submit) {
        submit.textContent = (App.state.orderSide === 'long' ? 'Long' : 'Short') + (App.state.orderType==='limit' ? ' Order platzieren' : ' eröffnen');
      }
      this.updatePreview();
    }));

    const levInput = document.getElementById('in-lev');
    const levVal = document.getElementById('lev-val');
    if (levInput) {
      levInput.addEventListener('input', (e) => {
        if (levVal) levVal.textContent = e.target.value + 'x';
        document.querySelectorAll('.lev-chip').forEach(c => c.classList.toggle('active', c.dataset.lev === e.target.value));
        this.updatePreview();
      });
    }
    
    document.querySelectorAll('.lev-chip').forEach(c => c.addEventListener('click', () => {
      if (levInput) levInput.value = c.dataset.lev;
      if (levVal) levVal.textContent = c.dataset.lev + 'x';
      document.querySelectorAll('.lev-chip').forEach(x => x.classList.toggle('active', x === c));
      this.updatePreview();
    }));

    const qtyInput = document.getElementById('in-qty');
    if (qtyInput) qtyInput.addEventListener('input', () => this.updatePreview());
    
    const limitPxInput = document.getElementById('in-limit-price');
    if (limitPxInput) limitPxInput.addEventListener('input', () => this.updatePreview());
    
    const toggleTpslBtn = document.getElementById('btn-toggle-tpsl');
    const tpslContainer = document.getElementById('tpsl-container');
    const tpslToggleIcon = document.getElementById('tpsl-toggle-icon');
    const tpInput = document.getElementById('in-tp');
    const slInput = document.getElementById('in-sl');

    if (toggleTpslBtn) {
      toggleTpslBtn.addEventListener('click', () => {
        if (!tpslContainer || !tpslToggleIcon) return;
        const isHidden = tpslContainer.style.display === 'none';
        if (isHidden) {
          tpslContainer.style.display = 'flex';
          tpslToggleIcon.textContent = '▼';
        } else {
          tpslContainer.style.display = 'none';
          tpslToggleIcon.textContent = '▶';
          if (tpInput) tpInput.value = '';
          if (slInput) slInput.value = '';
        }
      });
    }

    const submitBtn = document.getElementById('btn-submit');
    if (submitBtn) submitBtn.addEventListener('click', () => this.submitOrder());

    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
      ['positions','orders','history','backtest'].forEach(name => {
        const tabEl = document.getElementById('tab-' + name);
        if (tabEl) tabEl.style.display = (name === t.dataset.tab) ? 'block' : 'none';
      });
    }));

    const saveBtn = document.getElementById('btn-save');
    const loadBtn = document.getElementById('btn-load');
    const resetBtn = document.getElementById('btn-reset');

    if (saveBtn) saveBtn.addEventListener('click', () => App.saveState());
    if (loadBtn) loadBtn.addEventListener('click', () => App.loadState());
    if (resetBtn) resetBtn.addEventListener('click', () => App.resetState());

    // Maximize / Restore tab container
    const btnMax = document.getElementById('btn-maximize-list');
    const wrapMax = document.getElementById('tabs-container-wrap');
    if (btnMax && wrapMax) {
      btnMax.addEventListener('click', () => {
        const isMax = wrapMax.classList.toggle('maximized');
        btnMax.textContent = isMax ? '⤫' : '⤢';
        btnMax.title = isMax ? 'Schließen' : 'Vergrößern';
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && wrapMax && wrapMax.classList.contains('maximized')) {
        wrapMax.classList.remove('maximized');
        if (btnMax) {
          btnMax.textContent = '⤢';
          btnMax.title = 'Vergrößern';
        }
      }
    });

    this.wireBotEvents();
  },

  wireBotEvents(){
    const toggleBotBtn = document.getElementById('btn-toggle-bot');
    if (toggleBotBtn) {
      toggleBotBtn.addEventListener('click', () => {
        App.state.bot.active = !App.state.bot.active;
        if (App.state.bot.active) {
          App.Bot.logBot('Bot gestartet.');
        } else {
          App.Bot.logBot('Bot gestoppt.');
        }
        App.Bot.renderBotUI();
        App.saveToLocalStorage();
      });
    }

    const inputMappings = {
      'bot-max-open': 'maxOpen',
      'bot-cooldown': 'cooldownMin',
      'bot-qty': 'qtyUsd',
      'bot-lev': 'leverage',
      'bot-tp-pct': 'tpPercent',
      'bot-sl-pct': 'slPercent'
    };
    for (const [id, prop] of Object.entries(inputMappings)) {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', (e) => {
          const val = parseFloat(e.target.value);
          if (!isNaN(val) && val >= 0) {
            App.state.bot[prop] = val;
            App.saveToLocalStorage();
            App.Bot.renderBotUI();
          }
        });
      }
    }

    const applyPreset = (preset) => {
      if (preset === '1m') {
        App.state.strategyMatrix = {
          '1_1': 'long', '1_0': 'long', '1_-1': 'long',
          '0_1': 'none', '0_0': 'none', '0_-1': 'none',
          '-1_1': 'short', '-1_0': 'short', '-1_-1': 'short'
        };
      } else if (preset === 'filter') {
        App.state.strategyMatrix = {
          '1_1': 'long', '1_0': 'none', '1_-1': 'none',
          '0_1': 'none', '0_0': 'none', '0_-1': 'none',
          '-1_1': 'none', '-1_0': 'none', '-1_-1': 'short'
        };
      } else if (preset === 'contrarian') {
        App.state.strategyMatrix = {
          '1_1': 'none', '1_0': 'none', '1_-1': 'long',
          '0_1': 'none', '0_0': 'none', '0_-1': 'none',
          '-1_1': 'short', '-1_0': 'none', '-1_-1': 'none'
        };
      }
      App.saveToLocalStorage();
      this.renderStrategyMatrix();
    };

    const presetCons = document.getElementById('bot-preset-cons');
    const presetMod = document.getElementById('bot-preset-mod');
    const presetAggr = document.getElementById('bot-preset-aggr');

    if (presetCons) {
      presetCons.addEventListener('click', () => {
        App.state.bot.tpPercent = 20;
        App.state.bot.slPercent = 10;
        App.Bot.renderBotUI();
        App.saveToLocalStorage();
      });
    }
    if (presetMod) {
      presetMod.addEventListener('click', () => {
        App.state.bot.tpPercent = 50;
        App.state.bot.slPercent = 25;
        App.Bot.renderBotUI();
        App.saveToLocalStorage();
      });
    }
    if (presetAggr) {
      presetAggr.addEventListener('click', () => {
        App.state.bot.tpPercent = 100;
        App.state.bot.slPercent = 50;
        App.Bot.renderBotUI();
        App.saveToLocalStorage();
      });
    }

    // Wire "+ Zeile" buttons for adding rules
    const addRuleLong = document.getElementById('btn-add-rule-long');
    const addRuleShort = document.getElementById('btn-add-rule-short');
    const btAddRuleLong = document.getElementById('backtest-btn-add-rule-long');
    const btAddRuleShort = document.getElementById('backtest-btn-add-rule-short');

    const handleAddRule = (side) => {
      App.state.rules[side].push({ interval: '1m', state: 'bull' });
      App.saveToLocalStorage();
      App.API.loadActiveIntervalsHistory().then(() => {
        App.API.connectWs(App.state.timeframe);
      });
      this.renderRules();
    };

    if (addRuleLong) addRuleLong.addEventListener('click', () => handleAddRule('long'));
    if (addRuleShort) addRuleShort.addEventListener('click', () => handleAddRule('short'));
    if (btAddRuleLong) btAddRuleLong.addEventListener('click', () => handleAddRule('long'));
    if (btAddRuleShort) btAddRuleShort.addEventListener('click', () => handleAddRule('short'));

    const toggleBotPanel = document.getElementById('btn-toggle-bot-panel');
    const botPanelContent = document.getElementById('bot-panel-content');
    const botPanelToggleIcon = document.getElementById('bot-panel-toggle-icon');

    if (toggleBotPanel) {
      toggleBotPanel.addEventListener('click', () => {
        if (!botPanelContent || !botPanelToggleIcon) return;
        const isHidden = botPanelContent.style.display === 'none';
        if (isHidden) {
          botPanelContent.style.display = 'block';
          botPanelToggleIcon.textContent = '▼';
        } else {
          botPanelContent.style.display = 'none';
          botPanelToggleIcon.textContent = '▶';
        }
      });
    }

    // Leaderboard filter event
    const filterEl = document.getElementById('leaderboard-filter');
    if (filterEl) {
      filterEl.addEventListener('change', (e) => {
        this.renderLeaderboard(e.target.value);
      });
    }

    // Reset Optimizer DB event
    const resetOptDbBtn = document.getElementById('btn-reset-optimizer-db');
    if (resetOptDbBtn) {
      resetOptDbBtn.addEventListener('click', () => {
        if (confirm('Lernspeicher (alle Testergebnisse, Leaderboard, Wissensstand) wirklich löschen?\n\nDeine gespeicherten Kerzen-Datensätze (Marktphasen-Bibliothek) bleiben davon unberührt und müssen nicht erneut heruntergeladen werden.')) {
          App.state.optimizerDb = {};
          App.saveToLocalStorage();
          this.renderLeaderboard('all');
          this.renderHeatmaps();
          this.renderWissensstand();
          this.syncResultsVisibility();
          App.UI.showToast('Lernspeicher gelöscht. Kerzen-Cache bleibt erhalten.');
        }
      });
    }
  },

  renderLeaderboard(filterRegime = 'all') {
    const list = App.Optimizer.getLeaderboard(filterRegime);
    const tbody = document.querySelector('#table-optimizer-leaderboard tbody');
    if (!tbody) return;

    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="12" style="text-align:center; color:var(--text-faint); font-size: 11px; padding: 16px 0;">Keine aufgezeichneten Tests für diesen Filter.</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map((item, idx) => {
      const returnCls = item.results.totalReturnPercent >= 0 ? 'long' : 'short';
      const scoreColor = item.score >= 80 ? 'var(--long)' : item.score >= 50 ? '#ffb020' : 'var(--short)';

      const v = item.validation || {};
      const badgeParts = [];
      if (v.validated) {
        const gap = v.trainScore - v.testScore;
        const oosColor = gap <= 15 ? 'var(--long)' : gap <= 30 ? '#ffb020' : 'var(--short)';
        badgeParts.push(`<span style="color:${oosColor};" title="Training: ${v.trainScore} · Test: ${v.testScore}">OOS</span>`);
      } else {
        badgeParts.push(`<span style="color:var(--text-faint);">–</span>`);
      }
      if (v.stabilityScore !== null && v.stabilityScore !== undefined) {
        const staColor = v.stabilityScore >= 80 ? 'var(--long)' : v.stabilityScore >= 50 ? '#ffb020' : 'var(--short)';
        badgeParts.push(`<span style="color:${staColor};">STA</span>`);
      }
      if (v.crossPhaseScore !== null && v.crossPhaseScore !== undefined) {
        const phzColor = v.crossPhaseScore >= 70 ? 'var(--long)' : v.crossPhaseScore >= 40 ? '#ffb020' : 'var(--short)';
        badgeParts.push(`<span style="color:${phzColor};">PHZ</span>`);
      }
      // Deflated-Sharpe-Korrektur: Badge zeigt an, dass der Score um Multiple-Testing-Risiko korrigiert ist
      if (item.rawScore !== undefined && item.rawScore !== item.score) {
        badgeParts.push(`<span style="color:#9f7aea;" title="Deflated Score (Roh: ${item.rawScore})">DSR</span>`);
      }

      const rowId = `lb-row-${idx}`;
      const rules = item.params.rules || App.state.rules;
      const stateLabel = (s) => s === 'bull' ? 'Bull' : s === 'bear' ? 'Bear' : 'Neutral';
      const longRuleText = (rules.long || []).map(r => `${r.interval} ${stateLabel(r.state)}`).join(' UND ');
      const shortRuleText = (rules.short || []).map(r => `${r.interval} ${stateLabel(r.state)}`).join(' UND ');

      let validationDetailHtml = '';
      if (v.validated) {
        const gap = v.trainScore - v.testScore;
        const gapColor = gap <= 15 ? 'var(--long)' : gap <= 30 ? '#ffb020' : 'var(--short)';
        validationDetailHtml += `<div style="color:${gapColor};">Out-of-Sample: Training ${v.trainScore} &middot; Test (unbekannte Daten) ${v.testScore}</div>`;
      } else {
        validationDetailHtml += `<div style="color:var(--text-faint);">Kein Out-of-Sample-Test (Zeitraum zu kurz)</div>`;
      }
      if (v.stabilityScore !== null && v.stabilityScore !== undefined) {
        const staColor = v.stabilityScore >= 80 ? 'var(--long)' : v.stabilityScore >= 50 ? '#ffb020' : 'var(--short)';
        validationDetailHtml += `<div style="color:${staColor};">Stabilität bei Parameter-Variation: ${v.stabilityScore}/100</div>`;
      } else {
        validationDetailHtml += `<div style="color:var(--text-faint);">Kein Stabilitäts-Check (Score war unter 65)</div>`;
      }
      if (v.crossPhaseScore !== null && v.crossPhaseScore !== undefined) {
        const phzColor = v.crossPhaseScore >= 70 ? 'var(--long)' : v.crossPhaseScore >= 40 ? '#ffb020' : 'var(--short)';
        const detail = (v.crossPhaseDetails || []).map(p => `${p.label}: ${p.score}`).join(', ');
        validationDetailHtml += `<div style="color:${phzColor};">Cross-Phasen-Check (Ø ${v.crossPhaseScore}/100): ${detail || '–'}</div>`;
      } else {
        validationDetailHtml += `<div style="color:var(--text-faint);">Kein Cross-Phasen-Check</div>`;
      }

      return `
        <tr class="clickable lb-toggle-row" data-target="${rowId}">
          <td style="font-weight: bold; color: ${scoreColor};" title="${item.rawScore !== undefined ? 'Roh-Score: ' + item.rawScore : ''}">${item.score}</td>
          <td style="font-size: 8px; white-space: nowrap; letter-spacing: 0.3px;">${badgeParts.join(' ')}</td>
          <td style="font-size: 9px; white-space: nowrap;">${App.Optimizer.getRuleLabel(rules)} ▾</td>
          <td>${item.params.leverage}x</td>
          <td>${item.params.cooldownMin}m</td>
          <td>${item.params.tpPercent}%</td>
          <td>${item.params.slPercent}%</td>
          <td>${item.params.maxOpen || 1}</td>
          <td class="side ${returnCls}">${item.results.totalReturnPercent >= 0 ? '+' : ''}${item.results.totalReturnPercent.toFixed(2)}%</td>
          <td>${item.results.winRatePercent.toFixed(1)}%</td>
          <td class="side short">${item.results.maxDrawdownPercent.toFixed(2)}%</td>
          <td>${item.results.totalTrades}</td>
        </tr>
        <tr id="${rowId}" class="lb-detail-row" style="display:none;">
          <td colspan="12" style="background: var(--surface-3); padding: 10px; font-size: 10px; line-height: 1.6;">
            <div style="font-weight:600; margin-bottom:4px;">Einstiegsregeln (alle Bedingungen müssen gleichzeitig gelten — AND):</div>
            <div>LONG: <strong>${longRuleText || '–'}</strong></div>
            <div style="margin-bottom:8px;">SHORT: <strong>${shortRuleText || '–'}</strong></div>
            <div style="font-weight:600; margin-bottom:4px;">Validierung:</div>
            ${item.rawScore !== undefined && item.rawScore !== item.score ? `<div style="color:#9f7aea;">Deflated Score: ${item.score} (Roh-Score: ${item.rawScore}, Korrektur für ${Object.keys(App.state.optimizerDb).length} getestete Kombinationen)</div>` : ''}
            ${validationDetailHtml}
            ${item.veto && item.veto.enabled !== false && item.veto.codes && item.veto.codes.length > 0 ? `<div style="margin-top:6px; color: var(--teal);">🛡 Fine-Tune-Filter gespeichert: ${(item.veto.patterns || []).map(p => p.label).join(', ')}</div>` : ''}
            <button type="button" class="backtest-btn lb-apply-btn" data-lev="${item.params.leverage}" data-cooldown="${item.params.cooldownMin}" data-tp="${item.params.tpPercent}" data-sl="${item.params.slPercent}" data-max-open="${item.params.maxOpen || 1}" data-rules='${JSON.stringify(rules)}' style="margin-top:10px; width:100%;">✓ Diese Einstellung übernehmen (Regeln + Parameter)</button>
            <button type="button" class="backtest-btn lb-analyze-btn" data-idx="${idx}" style="margin-top:6px; width:100%; background:transparent; border:1px dashed var(--border); color:var(--text-dim);">🔍 Verlust-Trades analysieren</button>
            <div id="lb-analysis-${idx}" style="margin-top:8px;"></div>
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('.lb-toggle-row').forEach(tr => {
      tr.addEventListener('click', () => {
        const detail = document.getElementById(tr.dataset.target);
        if (detail) detail.style.display = detail.style.display === 'none' ? 'table-row' : 'none';
      });
    });

    tbody.querySelectorAll('.lb-analyze-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx);
        App.UI.runTradeAnalysisForEntry(list[idx], idx);
      });
    });

    tbody.querySelectorAll('.lb-apply-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const lev = parseFloat(btn.dataset.lev);
        const cooldown = parseFloat(btn.dataset.cooldown);
        const tp = parseFloat(btn.dataset.tp);
        const sl = parseFloat(btn.dataset.sl);
        const maxOpen = parseInt(btn.dataset.maxOpen || '1');

        document.getElementById('bot-lev').value = lev;
        document.getElementById('bot-cooldown').value = cooldown;
        document.getElementById('bot-tp-pct').value = tp;
        document.getElementById('bot-sl-pct').value = sl;
        document.getElementById('bot-max-open').value = maxOpen;

        document.getElementById('backtest-lev').value = lev;
        document.getElementById('backtest-cooldown').value = cooldown;
        document.getElementById('backtest-tp').value = tp;
        document.getElementById('backtest-sl').value = sl;
        document.getElementById('backtest-max-open').value = maxOpen;

        App.state.bot.leverage = lev;
        App.state.bot.cooldownMin = cooldown;
        App.state.bot.tpPercent = tp;
        App.state.bot.slPercent = sl;
        App.state.bot.maxOpen = maxOpen;

        let ruleLabel = '';
        try {
          const rules = JSON.parse(btn.dataset.rules);
          if (rules && rules.long) {
            App.state.rules = rules;
            App.UI.renderRules();
            ruleLabel = `, Regeln=${App.Optimizer.getRuleLabel(rules)}`;
            App.API.loadActiveIntervalsHistory().then(() => {
              App.API.connectWs(App.state.timeframe);
            });
          }
        } catch (err) {
          console.error('Konnte Regeln des Leaderboard-Eintrags nicht anwenden:', err);
        }

        App.Bot.renderBotUI();
        App.saveToLocalStorage();
        App.UI.showToast(`Übernommen: Hebel=${lev}x, Cooldown=${cooldown}m, TP=${tp}%, SL=${sl}%, Max. Trades=${maxOpen}${ruleLabel}`);
      });
    });
  },

  // Re-runs the given leaderboard entry's strategy on the full active dataset and explains
  // every losing trade (market phase, momentum, possible flash-move/cascade) — the "why did
  // this fail" report the failed-trade-analysis feature is built around.
  runTradeAnalysisForEntry(item, idx) {
    const container = document.getElementById(`lb-analysis-${idx}`);
    if (!container) return;

    if (!App.state.backtestCandles || App.state.backtestCandles.length === 0) {
      container.innerHTML = `<div style="color:var(--short);">Keine Kerzendaten geladen — bitte zuerst im Datenlader Kerzen laden.</div>`;
      return;
    }

    container.innerHTML = `<div style="color:var(--text-dim);">Analysiere Verlust-Trades...</div>`;

    // Small delay so the "Analysiere..." message actually paints before the (synchronous) backtest runs
    setTimeout(() => {
      const startBalanceSats = parseFloat(document.getElementById('backtest-capital')?.value) || App.CONFIG.startBalanceSats;
      const qtyUsd = parseFloat(document.getElementById('backtest-qty')?.value) || 100;

      const params = {
        startBalanceSats,
        qtyUsd,
        leverage: item.params.leverage,
        cooldownMin: item.params.cooldownMin,
        maxOpen: item.params.maxOpen || 1,
        tpPercent: item.params.tpPercent,
        slPercent: item.params.slPercent,
        rules: item.params.rules || App.state.rules,
        feeRate: App.CONFIG.feeRate,
        spread: App.CONFIG.spread
      };

      const candlesUsed = App.state.backtestCandles;
      const res = App.Backtest.runBacktest(candlesUsed, params);
      const analysis = App.TradeAnalyzer.analyzeLosses(candlesUsed, res.tradeLog);
      const datasetRangeLabel = (item.datasetRange && item.datasetRange.label)
        || `${App.Backtest.formatDateShort(candlesUsed[0].time)}–${App.Backtest.formatDateShort(candlesUsed[candlesUsed.length - 1].time)}`;

      if (analysis.totalLosses === 0) {
        container.innerHTML = `<div style="color:var(--long);">Keine Verlust-Trades im aktuell geladenen Zeitraum — nichts zu analysieren.</div>`;
        return;
      }

      const summaryHtml = analysis.summary.map(s => `
        <div style="display:flex; justify-content:space-between; margin-bottom:3px;">
          <span>${s.label}</span>
          <strong>${s.count}/${analysis.totalLosses} (${s.percent}%)</strong>
        </div>
      `).join('');

      container.innerHTML = `
        <div style="background: var(--surface-2); border: 1px solid var(--border-soft); border-radius: 4px; padding: 8px;">
          <div style="font-weight:600; margin-bottom:6px;">${analysis.totalLosses} von ${analysis.totalTrades} Trades verloren — häufigste Ursachen:</div>
          ${summaryHtml}
          <button type="button" class="backtest-btn lb-derive-veto-btn" style="margin-top:8px; width:100%;">⚙ Regelbasierten Fine-Tune-Filter erstellen</button>
          <button type="button" class="backtest-btn lb-train-ml-btn" style="margin-top:6px; width:100%; border:1px dashed var(--border); background:transparent; color:var(--text-dim);">🧠 ML-Modell trainieren (logistische Regression)</button>
          <div class="lb-veto-result" style="margin-top:8px;"></div>
          <div class="lb-ml-result" style="margin-top:8px;"></div>
        </div>
      `;

      container.querySelector('.lb-derive-veto-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        App.UI.deriveAndTestVeto(item, params, analysis, container.querySelector('.lb-veto-result'), datasetRangeLabel, candlesUsed);
      });

      container.querySelector('.lb-train-ml-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        App.UI.trainAndTestML(item, params, res, container.querySelector('.lb-ml-result'), datasetRangeLabel, candlesUsed);
      });
    }, 30);
  },

  // Turns the recurring loss patterns into a concrete veto filter, re-tests the strategy with
  // the filter applied (before/after comparison), and offers to push it live to the bot —
  // this is the actual feedback loop: base model says "buy", fine-tune layer can override it.
  deriveAndTestVeto(item, params, analysis, resultEl, datasetRangeLabel, candlesUsed) {
    const vetoRules = App.TradeAnalyzer.deriveVetoRules(analysis.summary, analysis.totalLosses);
    const candles = candlesUsed || App.state.backtestCandles;

    // Record this run as a library epoch regardless of outcome — "no significant pattern this
    // time" is useful data too (it can trigger demotion of a previously confirmed pattern)
    const ruleFindings = {};
    analysis.summary.forEach(s => {
      if (s.code === 'unclear') return;
      ruleFindings[s.code] = { significant: vetoRules.some(v => v.code === s.code), sharePercent: s.percent, count: s.count };
    });
    // Also record codes that didn't show up at all this epoch as "not significant"
    Object.keys(App.TradeAnalyzer.REASON_LABELS).forEach(code => {
      if (code !== 'unclear' && !ruleFindings[code]) ruleFindings[code] = { significant: false, sharePercent: 0, count: 0 };
    });
    App.TradeAnalyzer.recordEpoch({ type: 'rule', testId: item.testId, datasetRangeLabel, ruleFindings });
    App.UI.renderMarketLawsLibrary();

    if (vetoRules.length === 0) {
      resultEl.innerHTML = `<div style="color:var(--text-faint);">Keine ausreichend häufige Verlust-Ursache in dieser Epoche (mind. 5 Fälle und 25% der Verluste nötig) — als Epoche aufgezeichnet, aber kein Filter für diesen Lauf erstellt.</div>`;
      return;
    }

    const codes = vetoRules.map(r => r.code);
    const beforeRes = App.Backtest.runBacktest(candles, params);
    const afterParams = { ...params, veto: { enabled: true, codes } };
    const afterRes = App.Backtest.runBacktest(candles, afterParams);

    const veto = {
      enabled: true,
      codes,
      patterns: vetoRules.map(r => ({ code: r.code, label: r.label, sharePercent: r.percent })),
      derivedAt: Date.now(),
      beforeAfter: {
        beforeWinRate: beforeRes.winRatePercent, afterWinRate: afterRes.winRatePercent,
        beforeReturn: beforeRes.totalReturnPercent, afterReturn: afterRes.totalReturnPercent,
        beforeTrades: beforeRes.totalTrades, afterTrades: afterRes.totalTrades,
        vetoedTrades: afterRes.vetoedTrades
      }
    };

    if (item.testId) App.Optimizer.saveVetoProfile(item.testId, veto);

    const wrColor = afterRes.winRatePercent >= beforeRes.winRatePercent ? 'var(--long)' : 'var(--short)';
    const retColor = afterRes.totalReturnPercent >= beforeRes.totalReturnPercent ? 'var(--long)' : 'var(--short)';

    resultEl.innerHTML = `
      <div style="font-weight:600; margin-bottom:4px;">Filter dieser Epoche: ${vetoRules.map(r => r.label).join(' · ')}</div>
      <div>Winrate: ${beforeRes.winRatePercent.toFixed(1)}% → <span style="color:${wrColor};">${afterRes.winRatePercent.toFixed(1)}%</span></div>
      <div>Rendite: ${beforeRes.totalReturnPercent.toFixed(2)}% → <span style="color:${retColor};">${afterRes.totalReturnPercent.toFixed(2)}%</span></div>
      <div>Trades: ${beforeRes.totalTrades} → ${afterRes.totalTrades} (${afterRes.vetoedTrades} durch Filter blockiert)</div>
      <div style="margin-top:6px; color:var(--text-faint);">📚 Als Epoche aufgezeichnet — schau im Tab "Wissensstand" nach, ob dieses Muster über mehrere Epochen hinweg bestätigt wird, bevor du es dauerhaft live nutzt.</div>
      <button type="button" class="backtest-btn lb-apply-veto-btn" style="margin-top:8px; width:100%; border:1px dashed var(--border); background:transparent; color:var(--text-dim);">⚠ Nur diese Epoche testweise auf Live-Bot anwenden (unbestätigt)</button>
    `;

    resultEl.querySelector('.lb-apply-veto-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      App.state.bot.veto = { enabled: true, codes, vetoedCount: 0 };
      App.saveToLocalStorage();
      App.UI.showToast(`Unbestätigter Test-Filter aktiv: ${vetoRules.map(r => r.label).join(', ')}`);
    });
  },

  // Trains a logistic regression on continuous market features (trend/volatility/momentum/
  // volume) labeled by trade outcome, shows the learned weights in plain language, and compares
  // before/after performance with the ML filter applied — the "smarter" alternative to the
  // fixed-threshold rule-based veto above.
  async trainAndTestML(item, params, res, resultEl, datasetRangeLabel, candlesUsed) {
    resultEl.innerHTML = `<div style="color:var(--text-dim);">Trainiere Modell...</div>`;
    try {
      const candles = candlesUsed || App.state.backtestCandles;
      const { trainTrades, testTrades, splitAvailable } = App.TradeAnalyzer.splitTradesForValidation(res.tradeLog);

      const mlModel = await App.TradeAnalyzer.trainLossModel(candles, trainTrades);
      const threshold = 0.6;

      const weighted = mlModel.featureNames.map((name, i) => ({
        name,
        label: App.TradeAnalyzer.ML_FEATURE_LABELS[name],
        weight: mlModel.weights[i]
      })).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

      const mlFindings = {};
      mlModel.featureNames.forEach((name, i) => { mlFindings[name] = { weight: mlModel.weights[i] }; });
      App.TradeAnalyzer.recordEpoch({ type: 'ml', testId: item.testId, datasetRangeLabel, mlFindings });
      App.UI.renderMarketLawsLibrary();

      const weightsHtml = weighted.map(w => {
        const color = Math.abs(w.weight) > 0.3 ? 'var(--short)' : 'var(--text-dim)';
        return `<div style="display:flex; justify-content:space-between; margin-bottom:3px;"><span>${w.label}</span><strong style="color:${color};">${w.weight >= 0 ? '+' : ''}${w.weight.toFixed(2)}</strong></div>`;
      }).join('');

      const accText = mlModel.trainingAccuracy !== null ? ` &middot; Trainings-Genauigkeit: ${Math.round(mlModel.trainingAccuracy * 100)}%` : '';

      let oosHtml = '';
      let beforeRes, afterRes, evalCandles;

      if (splitAvailable) {
        // Only evaluate on the time window covering the unseen test trades — the model must
        // never be judged on the period it was trained on
        const splitTimeSec = Math.floor(testTrades[0].entryTime / 1000);
        const splitIdx = App.TradeAnalyzer.findCandleIndex(candles, splitTimeSec);
        evalCandles = candles.slice(splitIdx);

        const oosEval = App.TradeAnalyzer.evaluateOOS(mlModel, candles, testTrades, threshold);
        const sepColor = oosEval.separation !== null && oosEval.separation > 0.05 ? 'var(--long)' : 'var(--short)';
        oosHtml = `
          <div style="margin-top:8px; padding-top:6px; border-top: 1px solid var(--border-soft);">
            <div style="font-weight:600;">Out-of-Sample-Test (${testTrades.length} unbekannte Trades, nie im Training gesehen):</div>
            <div>Trefferquote bei Schwelle ${Math.round(threshold * 100)}%: ${Math.round(oosEval.accuracy * 100)}%</div>
            <div style="color:${sepColor};">Trennschärfe (Ø geschätzte Verlust-Whs. Verlierer − Gewinner): ${oosEval.separation !== null ? (oosEval.separation >= 0 ? '+' : '') + (oosEval.separation * 100).toFixed(1) + ' Punkte' : '–'}</div>
          </div>
        `;

        beforeRes = App.Backtest.runBacktest(evalCandles, params);
        const afterParams = { ...params, mlVeto: { enabled: true, model: mlModel, threshold } };
        afterRes = App.Backtest.runBacktest(evalCandles, afterParams);
      } else {
        oosHtml = `<div style="margin-top:8px; padding-top:6px; border-top: 1px solid var(--border-soft); color: var(--text-faint);">⚠ Zu wenige Trades für einen Out-of-Sample-Split (mind. 30 nötig) — Vergleich unten ist In-Sample, also mit Vorsicht zu genießen.</div>`;
        evalCandles = candles;
        beforeRes = res;
        const afterParams = { ...params, mlVeto: { enabled: true, model: mlModel, threshold } };
        afterRes = App.Backtest.runBacktest(evalCandles, afterParams);
      }

      const mlVeto = {
        enabled: true,
        model: mlModel,
        threshold,
        validated: splitAvailable,
        beforeAfter: {
          beforeWinRate: beforeRes.winRatePercent, afterWinRate: afterRes.winRatePercent,
          beforeReturn: beforeRes.totalReturnPercent, afterReturn: afterRes.totalReturnPercent,
          beforeTrades: beforeRes.totalTrades, afterTrades: afterRes.totalTrades,
          mlVetoedTrades: afterRes.mlVetoedTrades
        }
      };
      if (item.testId) App.Optimizer.saveMLVetoProfile(item.testId, mlVeto);

      const wrColor = afterRes.winRatePercent >= beforeRes.winRatePercent ? 'var(--long)' : 'var(--short)';
      const retColor = afterRes.totalReturnPercent >= beforeRes.totalReturnPercent ? 'var(--long)' : 'var(--short)';

      resultEl.innerHTML = `
        <div style="font-weight:600; margin-bottom:4px;">Gelernte Gewichte (trainiert auf ${mlModel.trainedOn} Trades, davon ${mlModel.trainedOnLosses} Verluste${accText}):</div>
        <div style="font-size:9px; color:#9f7aea; margin-bottom:6px;">⚙ L2-Regularisierung (λ=${mlModel.l2Lambda || 0.01}) · Klassengewichtung: Gewinn ×${mlModel.classWeights ? mlModel.classWeights[0].toFixed(2) : '?'}, Verlust ×${mlModel.classWeights ? mlModel.classWeights[1].toFixed(2) : '?'}</div>
        ${weightsHtml}
        ${oosHtml}
        <div style="margin-top:8px; font-weight:600;">${splitAvailable ? 'Vorher/Nachher — nur unbekannter Test-Zeitraum:' : 'Vorher/Nachher (In-Sample):'}</div>
        <div>Winrate: ${beforeRes.winRatePercent.toFixed(1)}% → <span style="color:${wrColor};">${afterRes.winRatePercent.toFixed(1)}%</span></div>
        <div>Rendite: ${beforeRes.totalReturnPercent.toFixed(2)}% → <span style="color:${retColor};">${afterRes.totalReturnPercent.toFixed(2)}%</span></div>
        <div>Trades: ${beforeRes.totalTrades} → ${afterRes.totalTrades} (${afterRes.mlVetoedTrades} durch ML-Filter blockiert)</div>
        <div style="margin-top:6px; color:var(--text-faint);">📚 Als Epoche aufgezeichnet — die einzelnen Merkmalsgewichte werden im Tab "Wissensstand" über mehrere Epochen hinweg auf Konsistenz geprüft.</div>
        <button type="button" class="backtest-btn lb-apply-ml-btn" style="margin-top:8px; width:100%; border:1px dashed var(--border); background:transparent; color:var(--text-dim);">⚠ Nur dieses Modell testweise auf Live-Bot anwenden (unbestätigt)</button>
      `;

      resultEl.querySelector('.lb-apply-ml-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        App.state.bot.mlVeto = { enabled: true, model: mlModel, threshold, vetoedCount: 0 };
        App.saveToLocalStorage();
        App.UI.showToast(`Unbestätigtes ML-Testmodell aktiv (Schwelle ${Math.round(threshold * 100)}%).`);
      });
    } catch (err) {
      console.error('ML-Training fehlgeschlagen:', err);
      resultEl.innerHTML = `<div style="color:var(--short);">${err.message || 'ML-Training fehlgeschlagen.'}</div>`;
    }
  },

  renderHeatmaps() {
    const container = document.getElementById('heatmaps-container');
    if (!container) return;

    const { weights, ratings } = App.Optimizer.analyzeParameters();

    let html = '';
    const paramNames = {
      leverage: 'Hebel (Leverage)',
      cooldownMin: 'Cooldown (Min.)',
      tpPercent: 'TP (% Margin)',
      slPercent: 'SL (% Margin)',
      maxOpen: 'Max. Trades (Simultan)'
    };

    for (const [key, name] of Object.entries(paramNames)) {
      const weight = weights[key] ?? 0;
      const values = ratings[key] ?? {};
      
      html += `
        <div style="margin-bottom: 12px; background: var(--surface-2); border: 1px solid var(--border-soft); padding: 8px; border-radius: 4px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <span style="font-size: 10px; font-weight: bold; color: var(--text-dim);">${name}</span>
            <span style="font-size: 8px; background: var(--border); padding: 1px 4px; border-radius: 3px; font-weight: bold; color: var(--teal);">Einfluss: ${weight}%</span>
          </div>
          <div style="display: flex; flex-direction: column; gap: 3px;">
      `;

      const entries = Object.entries(values);
      if (entries.length === 0) {
        html += `<div style="font-size: 9px; color: var(--text-faint); font-style: italic;">Keine ausreichenden Daten.</div>`;
      } else {
        entries.sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));
        entries.forEach(([val, score]) => {
          const pct = Math.max(0, Math.min(100, score));
          let barColor = 'var(--short)';
          if (score >= 75) barColor = 'var(--long)';
          else if (score >= 50) barColor = '#ffb020';

          const unit = key === 'leverage' ? 'x' : (key === 'maxOpen' ? '' : (key.endsWith('Percent') ? '%' : 'm'));

          html += `
            <div style="display: flex; align-items: center; font-size: 9px; font-family: monospace;">
              <span style="width: 50px; text-align: right; margin-right: 8px; color: var(--text-dim);">${val}${unit}</span>
              <div style="flex: 1; height: 8px; background: var(--border); border-radius: 2px; overflow: hidden; position: relative;">
                <div style="width: ${pct}%; height: 100%; background: ${barColor}; transition: width 0.3s ease;"></div>
              </div>
              <span style="width: 40px; text-align: right; margin-left: 8px; font-weight: bold; color: ${barColor};">${score.toFixed(1)}</span>
            </div>
          `;
        });
      }

      html += `
          </div>
        </div>
      `;
    }

    container.innerHTML = html;
  },

  renderWissensstand() {
    const stats = App.Optimizer.getWissensstand();
    
    const runEl = document.getElementById('wissen-total-runs');
    const clusterEl = document.getElementById('wissen-clusters');
    const exclEl = document.getElementById('wissen-exclusion');
    const bestEl = document.getElementById('wissen-best-score');
    const bestParamsEl = document.getElementById('wissen-best-params');
    const persistEl = document.getElementById('wissen-persistence-status');
    
    if (runEl) runEl.textContent = stats.totalRuns;
    if (clusterEl) clusterEl.textContent = stats.goodClusters;
    if (exclEl) exclEl.textContent = stats.exclusionPercent + '%';
    if (bestEl) bestEl.textContent = stats.bestScore.toFixed(1);

    // Make it explicit that this memory is durable (localStorage) and survives resets/reloads
    if (persistEl) {
      if (stats.totalRuns > 0) {
        persistEl.innerHTML = `💾 Lernspeicher gespeichert &middot; ${stats.totalRuns} Einträge &middot; zuletzt aktualisiert ${App.formatRelativeTime(stats.lastUpdated)} &middot; bleibt nach Reload/Reset erhalten`;
        persistEl.style.color = 'var(--teal)';
      } else {
        persistEl.innerHTML = `💾 Noch kein Lernspeicher vorhanden. Starte den Optimizer, um dauerhaft (über Sitzungen und Resets hinweg) zu lernen.`;
        persistEl.style.color = 'var(--text-faint)';
      }
    }
    
    if (bestParamsEl) {
      if (stats.bestParams) {
        const p = stats.bestParams;
        const v = stats.bestValidation || {};
        let validationHtml = '';
        if (v.validated) {
          const gap = v.trainScore - v.testScore;
          const gapColor = gap <= 15 ? 'var(--long)' : gap <= 30 ? '#ffb020' : 'var(--short)';
          validationHtml += `<div style="margin-top: 6px; color: ${gapColor};">Out-of-Sample: Training ${v.trainScore} &middot; Test (unbekannte Daten) ${v.testScore}</div>`;
        } else {
          validationHtml += `<div style="margin-top: 6px; color: var(--text-faint);">Kein Out-of-Sample-Test (Zeitraum zu kurz)</div>`;
        }
        if (v.stabilityScore !== null && v.stabilityScore !== undefined) {
          const staColor = v.stabilityScore >= 80 ? 'var(--long)' : v.stabilityScore >= 50 ? '#ffb020' : 'var(--short)';
          validationHtml += `<div style="color: ${staColor};">Stabilität bei Parameter-Variation: ${v.stabilityScore}/100</div>`;
        }
        if (v.crossPhaseScore !== null && v.crossPhaseScore !== undefined) {
          const phzColor = v.crossPhaseScore >= 70 ? 'var(--long)' : v.crossPhaseScore >= 40 ? '#ffb020' : 'var(--short)';
          validationHtml += `<div style="color: ${phzColor};">Ø Score in weiteren Marktphasen: ${v.crossPhaseScore}/100</div>`;
        }
        bestParamsEl.innerHTML = `
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-top: 4px;">
            <span>Regeln: <strong>${App.Optimizer.getRuleLabel(p.rules)}</strong></span>
            <span>Hebel: <strong>${p.leverage}x</strong></span>
            <span>Cooldown: <strong>${p.cooldownMin}m</strong></span>
            <span>Take Profit: <strong>${p.tpPercent}%</strong></span>
            <span>Stop Loss: <strong>${p.slPercent}%</strong></span>
            <span>Max. Trades: <strong>${p.maxOpen || 1}</strong></span>
          </div>
          ${validationHtml}
        `;
      } else {
        bestParamsEl.textContent = 'Keine Daten vorhanden. Führe den Optimizer aus.';
      }
    }

    this.renderMarketLawsLibrary();
  },

  renderMarketLawsLibrary() {
    const lib = App.state.mlLibrary;
    const epochCountEl = document.getElementById('wissen-library-epoch-count');
    const contentEl = document.getElementById('wissen-library-content');
    const applyBtn = document.getElementById('btn-apply-library');
    if (!contentEl) return;

    const epochs = (lib && lib.epochs) || [];
    if (epochCountEl) epochCountEl.textContent = `${epochs.length} Epoche${epochs.length === 1 ? '' : 'n'}`;

    if (epochs.length === 0) {
      contentEl.innerHTML = 'Noch keine Epochen aufgezeichnet. Jede Verlust-Trade-Analyse im Leaderboard zählt als eine Epoche.';
      if (applyBtn) applyBtn.style.display = 'none';
      return;
    }

    const statusLabel = (s) => s === 'confirmed' ? '✓ Bestätigt' : s === 'insufficient_data' ? '… zu wenig Daten' : '○ Kandidat';
    const statusColor = (s) => s === 'confirmed' ? 'var(--long)' : s === 'insufficient_data' ? 'var(--text-faint)' : '#ffb020';

    const ruleRows = Object.entries(lib.rules || {})
      .filter(([, v]) => v.totalEpochs > 0)
      .sort((a, b) => b[1].significantCount - a[1].significantCount)
      .map(([code, v]) => `<div style="display:flex; justify-content:space-between; margin-bottom:2px;"><span>${App.TradeAnalyzer.REASON_LABELS[code] || code}</span><span style="color:${statusColor(v.status)};">${statusLabel(v.status)} (${v.significantCount}/${v.totalEpochs}, ${v.distinctPhases} Phasen)</span></div>`)
      .join('');

    const mlRows = Object.entries(lib.mlFeatures || {})
      .filter(([, v]) => v.totalEpochs > 0)
      .sort((a, b) => b[1].significantCount - a[1].significantCount)
      .map(([name, v]) => `<div style="display:flex; justify-content:space-between; margin-bottom:2px;"><span>${App.TradeAnalyzer.ML_FEATURE_LABELS[name] || name}</span><span style="color:${statusColor(v.status)};">${statusLabel(v.status)} (${v.significantCount}/${v.totalEpochs}, ${v.distinctPhases} Phasen)</span></div>`)
      .join('');

    contentEl.innerHTML = `
      ${ruleRows ? `<div style="color:var(--text-faint); margin-bottom:2px;">Regelbasierte Muster:</div>${ruleRows}` : ''}
      ${mlRows ? `<div style="color:var(--text-faint); margin: 6px 0 2px;">ML-Merkmale:</div>${mlRows}` : ''}
    `;

    const confirmedCodes = App.TradeAnalyzer.getConfirmedRuleCodes();
    if (applyBtn) {
      applyBtn.style.display = confirmedCodes.length > 0 ? 'block' : 'none';
      applyBtn.onclick = () => {
        App.state.bot.veto = { enabled: true, codes: confirmedCodes, vetoedCount: 0 };
        App.saveToLocalStorage();
        App.Bot.renderBotUI();
        App.UI.showToast(`Bestätigte Bibliothek angewendet: ${confirmedCodes.map(c => App.TradeAnalyzer.REASON_LABELS[c]).join(', ')}`);
      };
    }
  },

  syncResultsVisibility() {
    const totalRuns = App.state.optimizerDb ? Object.keys(App.state.optimizerDb).length : 0;
    const noResultsEl = document.getElementById('backtest-no-results');
    const contentEl = document.getElementById('backtest-results-content');
    const totalProg = document.getElementById('opt-total-progress');

    // Update the optimizer control panel total count
    if (totalProg) {
      totalProg.textContent = totalRuns > 0 ? `${totalRuns} Tests` : '-';
    }

    // Also update the status indicator in the control panel
    const optStatusText = document.getElementById('opt-status-text');
    if (optStatusText && (!App.Optimizer || !App.Optimizer.state.isRunning)) {
      if (totalRuns > 0) {
        const stats = App.Optimizer.getWissensstand();
        optStatusText.textContent = `Bereit (Lernspeicher geladen: ${totalRuns} Tests, zuletzt ${App.formatRelativeTime(stats.lastUpdated)})`;
        optStatusText.style.color = 'var(--teal)';
      } else {
        optStatusText.textContent = 'Bereit (Keine Lern-Daten)';
        optStatusText.style.color = 'var(--text-dim)';
      }
    }

    // If there is optimizer database data but no backtest has run yet in this session,
    // show the results container and default to the Leaderboard sub-tab!
    if (totalRuns > 0) {
      if (noResultsEl) noResultsEl.style.display = 'none';
      if (contentEl) contentEl.style.display = 'block';

      // Check if we already have a single backtest results rendered
      const tradesTableBody = document.querySelector('#table-backtest-trades tbody');
      const hasTrades = tradesTableBody && tradesTableBody.children.length > 0 && !tradesTableBody.innerHTML.includes('Keine ausgeführten Trades');
      
      const activeTab = document.querySelector('.res-tab.active');
      if (!hasTrades && (!activeTab || activeTab.dataset.resTab === 'trades')) {
        // Switch to leaderboard tab!
        document.querySelectorAll('.res-tab').forEach(x => {
          x.classList.toggle('active', x.dataset.resTab === 'leaderboard');
        });
        ['trades', 'leaderboard', 'heatmaps', 'wissensstand'].forEach(name => {
          const el = document.getElementById('res-tab-' + name);
          if (el) el.style.display = (name === 'leaderboard') ? 'block' : 'none';
        });
      }
    } else {
      // If no optimizer runs and no backtest has run, hide content
      const tradesTableBody = document.querySelector('#table-backtest-trades tbody');
      const hasTrades = tradesTableBody && tradesTableBody.children.length > 0 && !tradesTableBody.innerHTML.includes('Keine ausgeführten Trades');
      if (!hasTrades) {
        if (noResultsEl) noResultsEl.style.display = 'block';
        if (contentEl) contentEl.style.display = 'none';
      }
    }
  }
};
