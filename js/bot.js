window.App = window.App || {};

App.Bot = {
  renderBotUI(){
    const b = App.state.bot;
    if (!b) return;

    const toggleBtn = document.getElementById('btn-toggle-bot');
    const statusText = document.getElementById('bot-status-text');
    if (toggleBtn && statusText) {
      if (b.active) {
        toggleBtn.textContent = 'Bot Stoppen';
        toggleBtn.style.background = 'var(--short)';
        toggleBtn.style.color = '#fff';
        statusText.textContent = 'Aktiv';
        statusText.style.color = 'var(--long)';
      } else {
        toggleBtn.textContent = 'Bot Starten';
        toggleBtn.style.background = 'var(--teal)';
        toggleBtn.style.color = '#000';
        statusText.textContent = 'Inaktiv';
        statusText.style.color = 'var(--text-dim)';
      }
    }

    const inputs = {
      'bot-max-open': b.maxOpen,
      'bot-cooldown': b.cooldownMin,
      'bot-qty': b.qtyUsd,
      'bot-lev': b.leverage,
      'bot-tp-pct': b.tpPercent,
      'bot-sl-pct': b.slPercent
    };
    for (const [id, val] of Object.entries(inputs)) {
      const el = document.getElementById(id);
      if (el && document.activeElement !== el) {
        el.value = val;
      }
    }

    const cPreset = document.getElementById('bot-preset-cons');
    const mPreset = document.getElementById('bot-preset-mod');
    const aPreset = document.getElementById('bot-preset-aggr');
    if (cPreset && mPreset && aPreset) {
      cPreset.classList.toggle('active', b.tpPercent === 20 && b.slPercent === 10);
      mPreset.classList.toggle('active', b.tpPercent === 50 && b.slPercent === 25);
      aPreset.classList.toggle('active', b.tpPercent === 100 && b.slPercent === 50);
    }

    const logWrap = document.getElementById('bot-log-wrap');
    if (logWrap) {
      if (!b.logs || b.logs.length === 0) {
        logWrap.innerHTML = `<div style="color:var(--text-faint)">Keine Bot-Aktivität aufgezeichnet.</div>`;
      } else {
        logWrap.innerHTML = b.logs.map(l => {
          let style = '';
          if (l.includes('🤖')) style = 'color:#e2c974; font-weight:600;';
          else if (l.includes('⚠')) style = 'color:var(--short); font-weight:600;';
          return `<div style="${style}">${l}</div>`;
        }).join('');
      }
    }
  },

  logBot(message) {
    if (!App.state.bot.logs) App.state.bot.logs = [];
    const timeStr = new Date().toLocaleTimeString();
    const logMsg = `[${timeStr}] ${message}`;
    App.state.bot.logs.unshift(logMsg);
    if (App.state.bot.logs.length > 50) App.state.bot.logs.pop();
    this.renderBotUI();
    App.saveToLocalStorage();
  },

  updateBotCooldownDisplay() {
    const b = App.state.bot;
    if (!b) return;
    const timerEl = document.getElementById('bot-cooldown-timer');
    if (!timerEl) return;

    if (!b.active) {
      timerEl.textContent = 'Bot ist inaktiv.';
      timerEl.style.color = 'var(--text-dim)';
      return;
    }

    const now = Date.now();
    const remainingMs = Math.max(0, (b.cooldownMin * 60000) - (now - b.lastTradeTime));
    if (remainingMs > 0) {
      const min = Math.floor(remainingMs / 60000);
      const sec = Math.floor((remainingMs % 60000) / 1000);
      timerEl.textContent = `Abklingzeit aktiv. Nächster Trade in: ${min}m ${sec}s`;
      timerEl.style.color = '#ffb020';
    } else {
      timerEl.textContent = 'Bereit für nächsten Trade.';
      timerEl.style.color = 'var(--long)';
    }
  },

  runBotLogic() {
    const b = App.state.bot;
    if (!b || !b.active) return;

    const checkRules = (rulesList) => {
      if (!rulesList || rulesList.length === 0) return false;
      for (let rule of rulesList) {
        const candles = App.API.activeCandles[rule.interval];
        if (!candles || candles.length < 9) {
          return false;
        }
        const currentSignal = App.Indicators.calculatePattern(candles);
        
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

    const triggerLong = checkRules(App.state.rules.long);
    const triggerShort = checkRules(App.state.rules.short);

    let triggerAction = 'none';
    if (triggerLong && !triggerShort) triggerAction = 'long';
    else if (triggerShort && !triggerLong) triggerAction = 'short';

    if (triggerAction === 'none') return;

    const now = Date.now();
    const elapsedMs = now - b.lastTradeTime;
    const cooldownMs = b.cooldownMin * 60000;
    if (elapsedMs < cooldownMs) return;

    if (App.state.positions.length >= b.maxOpen) return;

    const side = triggerAction;
    const entryPrice = App.Engine.fillPrice(side, 'market', App.state.lastPrice, null);
    const marginSats = App.Engine.margin(b.qtyUsd, entryPrice, b.leverage);
    const feeSats = App.Engine.fee(b.qtyUsd, entryPrice, App.CONFIG.feeRate);

    if (marginSats + feeSats > App.state.balanceSats) {
      this.logBot(`⚠ Fehler: Nicht genug Guthaben für Bot-Trade (${Math.round(marginSats + feeSats).toLocaleString()} sats benötigt).`);
      return;
    }

    const tpSats = Math.round(marginSats * (b.tpPercent / 100));
    const slSats = Math.round(marginSats * (b.slPercent / 100));

    this.logBot(`🤖 Signal erkannt: ${side.toUpperCase()}...`);
    const success = App.Engine.openPosition(side, b.qtyUsd, b.leverage, 'market', App.state.lastPrice, null, tpSats, slSats);
    if (success) {
      b.lastTradeTime = now;
      this.logBot(`🤖 ${side.toUpperCase()} eröffnet @ ${App.UI.fmtUsd(entryPrice)} (TP: +${tpSats.toLocaleString()} sats, SL: -${slSats.toLocaleString()} sats).`);
      App.UI.renderAll();
    }
  }
};
