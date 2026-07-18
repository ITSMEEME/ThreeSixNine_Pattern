window.App = window.App || {};

App.Bot = {
  renderBotUI(){
    const b = App.state.bot;
    if (!b) return;

    const cardEl = document.getElementById('bot-status-card');
    if (cardEl) {
      if (b.active) {
        cardEl.style.display = 'block';
        document.getElementById('bot-card-qty').textContent = `$${b.qtyUsd}`;
        document.getElementById('bot-card-lev').textContent = `${b.leverage}x`;
        document.getElementById('bot-card-max').textContent = `${b.maxOpen}`;
        document.getElementById('bot-card-tp').textContent = `+${b.tpPercent}%`;
        document.getElementById('bot-card-sl').textContent = `-${b.slPercent}%`;
        document.getElementById('bot-card-cd-dur').textContent = `${b.cooldownMin}m`;

        const filtersContainer = document.getElementById('bot-card-filters');
        if (filtersContainer) {
          filtersContainer.innerHTML = '';
          if (b.mlVeto && b.mlVeto.enabled) {
            const badge = document.createElement('span');
            badge.textContent = 'ML-Filter';
            badge.style.cssText = 'font-size: 8px; font-weight: 700; padding: 2px 6px; border-radius: 4px; color: #a78bfa; border: 1px solid rgba(167, 139, 250, 0.3); background: rgba(167, 139, 250, 0.1); text-transform: uppercase;';
            filtersContainer.appendChild(badge);
          }
          if (b.veto && b.veto.enabled) {
            const badge = document.createElement('span');
            badge.textContent = 'Regel-Veto';
            badge.style.cssText = 'font-size: 8px; font-weight: 700; padding: 2px 6px; border-radius: 4px; color: var(--amber); border: 1px solid rgba(255, 176, 32, 0.3); background: rgba(255, 176, 32, 0.1); text-transform: uppercase;';
            filtersContainer.appendChild(badge);
          }
          if (b.martingale && b.martingale.enabled) {
            const badge = document.createElement('span');
            badge.textContent = `Martingale (${b.martingale.maxMultiplier}x)`;
            badge.style.cssText = 'font-size: 8px; font-weight: 700; padding: 2px 6px; border-radius: 4px; color: #ff5e62; border: 1px solid rgba(255, 94, 98, 0.3); background: rgba(255, 94, 98, 0.1); text-transform: uppercase;';
            filtersContainer.appendChild(badge);
          }
          if (b.mlVeto && b.mlVeto.model) {
            const badge = document.createElement('span');
            badge.textContent = 'Kelly Sizing';
            badge.style.cssText = 'font-size: 8px; font-weight: 700; padding: 2px 6px; border-radius: 4px; color: var(--teal); border: 1px solid rgba(0, 224, 184, 0.3); background: rgba(0, 224, 184, 0.1); text-transform: uppercase;';
            filtersContainer.appendChild(badge);
          }
          if (filtersContainer.children.length === 0) {
            const badge = document.createElement('span');
            badge.textContent = 'Standard-Modus';
            badge.style.cssText = 'font-size: 8px; font-weight: 700; padding: 2px 6px; border-radius: 4px; color: var(--text-faint); border: 1px solid var(--border-soft); background: rgba(255, 255, 255, 0.02); text-transform: uppercase;';
            filtersContainer.appendChild(badge);
          }
        }

        // --- Collapsible strategy detail section ---
        const detailSourceEl = document.getElementById('bot-card-detail-source');
        const detailContentEl = document.getElementById('bot-card-detail-content');
        const detailToggleEl = document.getElementById('bot-card-detail-toggle');
        const detailArrowEl = document.getElementById('bot-card-detail-arrow');

        if (detailSourceEl) {
          const profile = App.state.activeStrategyProfile;
          if (profile && profile.testId) {
            const relTime = App.formatRelativeTime(profile.appliedAt);
            detailSourceEl.textContent = `📋 ${profile.label} · ${relTime}`;
          } else {
            detailSourceEl.textContent = '📋 Manuell konfiguriert';
          }
        }

        if (detailContentEl) {
          const sections = [];

          // 1. Entry rules
          const rules = App.state.rules;
          const stateLabel = (s) => s === 'bull' ? 'Bull' : s === 'bear' ? 'Bear' : 'Neutral';
          const longText = (rules.long || []).map(r => `${r.interval} ${stateLabel(r.state)}`).join(' · ');
          const shortText = (rules.short || []).map(r => `${r.interval} ${stateLabel(r.state)}`).join(' · ');
          sections.push(`<div style="margin-bottom:4px;"><span style="font-weight:700; color:var(--long);">LONG:</span> ${longText || '–'}</div>`);
          sections.push(`<div style="margin-bottom:6px;"><span style="font-weight:700; color:var(--short);">SHORT:</span> ${shortText || '–'}</div>`);

          // Martingale status in info list
          if (b.martingale && b.martingale.enabled) {
            let mult = 1.0;
            let currentQty = b.qtyUsd;
            if (b.martingale.currentStep > 0) {
              const lastPrice = App.state.lastPrice || 60000;
              const targetProfit = b.martingale.targetProfitSats || (App.Engine.margin(b.qtyUsd, lastPrice, b.leverage) * (b.tpPercent / 100));
              const reqProfitSats = targetProfit + (b.martingale.accumulatedLossSats || 0);
              const marginSatsFor1Usd = App.Engine.margin(1.0, lastPrice, b.leverage);
              const profitPerUsd = marginSatsFor1Usd * (b.tpPercent / 100);
              currentQty = reqProfitSats / profitPerUsd;
              mult = currentQty / b.qtyUsd;
            }
            sections.push(`<div style="margin-bottom:6px; color:#ff5e62;"><span style="font-weight:700;">Martingale:</span> Aktiv (Stufe ${b.martingale.currentStep} &middot; Mult. ×${mult.toFixed(2)} [Einsatz $${Math.round(currentQty)}] &middot; Limit ${b.martingale.maxMultiplier}x)</div>`);
          }

          // 2. Veto filter codes
          if (b.veto && b.veto.enabled && b.veto.codes && b.veto.codes.length > 0) {
            const labels = b.veto.codes.map(c => App.TradeAnalyzer.REASON_LABELS[c] || c);
            sections.push(`<div style="color:var(--amber); margin-bottom:4px;">🛡 <span style="font-weight:600;">Veto-Filter:</span></div>`);
            labels.forEach(l => sections.push(`<div style="padding-left:12px; font-size:8px;">• ${l}</div>`));
            sections.push(`<div style="margin-bottom:6px;"></div>`);
          }

          // 3. ML model weights
          if (b.mlVeto && b.mlVeto.enabled && b.mlVeto.model) {
            const model = b.mlVeto.model;
            sections.push(`<div style="color:#a78bfa; margin-bottom:4px;">🧠 <span style="font-weight:600;">ML-Merkmale</span> <span style="font-weight:400; color:var(--text-faint);">(Schwelle ${Math.round((b.mlVeto.threshold || 0.6) * 100)}%)</span></div>`);
            const featureLabels = App.TradeAnalyzer.ML_FEATURE_LABELS || {};
            (model.featureNames || []).forEach((name, i) => {
              const w = model.weights[i];
              const wColor = Math.abs(w) > 0.3 ? 'var(--short)' : 'var(--text-dim)';
              const label = featureLabels[name] || name;
              sections.push(`<div style="display:flex; justify-content:space-between; padding-left:12px; font-size:8px;"><span>${label}</span><span style="color:${wColor}; font-weight:700; font-family:var(--mono);">${w >= 0 ? '+' : ''}${w.toFixed(2)}</span></div>`);
            });
            if (model.trainedOn) {
              sections.push(`<div style="padding-left:12px; font-size:7.5px; color:var(--text-faint); margin-top:2px;">Trainiert auf ${model.trainedOn} Trades (${model.trainedOnLosses} Verluste)</div>`);
            }
          }

          detailContentEl.innerHTML = sections.join('');
        }

        // Wire toggle (only once — avoid duplicate listeners by checking data flag)
        if (detailToggleEl && !detailToggleEl._wired) {
          detailToggleEl._wired = true;
          detailToggleEl.addEventListener('click', () => {
            const content = document.getElementById('bot-card-detail-content');
            const arrow = document.getElementById('bot-card-detail-arrow');
            if (content && arrow) {
              const open = content.style.display !== 'none';
              content.style.display = open ? 'none' : 'block';
              arrow.textContent = open ? '▸' : '▾';
            }
          });
        }
      } else {
        cardEl.style.display = 'none';
      }
    }

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

    // Sync input values (including martingale checkbox & select)
    const inputs = {
      'bot-qty': b.qtyUsd,
      'bot-lev': b.leverage,
      'bot-tp-pct': b.tpPercent,
      'bot-sl-pct': b.slPercent,
      'bot-martingale-limit': b.martingale?.maxMultiplier ?? 8
    };
    for (const [id, val] of Object.entries(inputs)) {
      const el = document.getElementById(id);
      if (el && document.activeElement !== el) {
        el.value = val;
      }
    }

    const liveMaxOpenInput = document.getElementById('bot-max-open');
    if (liveMaxOpenInput && document.activeElement !== liveMaxOpenInput) {
      if (b.martingale && b.martingale.enabled) {
        liveMaxOpenInput.value = '1';
        liveMaxOpenInput.disabled = true;
        liveMaxOpenInput.style.opacity = '0.5';
        liveMaxOpenInput.style.cursor = 'not-allowed';
        const parentField = liveMaxOpenInput.closest('.field');
        if (parentField) parentField.style.opacity = '0.5';
      } else {
        liveMaxOpenInput.value = b.maxOpen;
        liveMaxOpenInput.disabled = false;
        liveMaxOpenInput.style.opacity = '';
        liveMaxOpenInput.style.cursor = '';
        const parentField = liveMaxOpenInput.closest('.field');
        if (parentField) parentField.style.opacity = '';
      }
    }

    const liveCooldownInput = document.getElementById('bot-cooldown');
    if (liveCooldownInput && document.activeElement !== liveCooldownInput) {
      if (b.martingale && b.martingale.enabled) {
        liveCooldownInput.value = '0';
        liveCooldownInput.disabled = true;
        liveCooldownInput.style.opacity = '0.5';
        liveCooldownInput.style.cursor = 'not-allowed';
        const parentField = liveCooldownInput.closest('.field');
        if (parentField) parentField.style.opacity = '0.5';
      } else {
        liveCooldownInput.value = b.cooldownMin;
        liveCooldownInput.disabled = false;
        liveCooldownInput.style.opacity = '';
        liveCooldownInput.style.cursor = '';
        const parentField = liveCooldownInput.closest('.field');
        if (parentField) parentField.style.opacity = '';
      }
    }

    const martCb = document.getElementById('bot-martingale-enabled');
    const martWrap = document.getElementById('bot-martingale-limit-wrap');
    if (martCb) {
      martCb.checked = b.martingale?.enabled ?? false;
      if (martWrap) {
        martWrap.style.display = martCb.checked ? 'flex' : 'none';
      }
    }

    const vetoStatusEl = document.getElementById('bot-veto-status');
    if (vetoStatusEl) {
      const lines = [];
      if (b.veto && b.veto.enabled && b.veto.codes && b.veto.codes.length > 0) {
        const labels = b.veto.codes.map(c => App.TradeAnalyzer.REASON_LABELS[c] || c).join(', ');
        lines.push(`<div>🛡 Regelbasierter Filter aktiv (${labels}) — ${b.veto.vetoedCount || 0} Trade(s) verhindert. <button type="button" id="btn-disable-veto" style="margin-left:6px; font-size:9px; padding:2px 6px; border:1px dashed var(--border); background:transparent; color:var(--text-dim); border-radius:3px; cursor:pointer;">Deaktivieren</button></div>`);
      }
      if (b.mlVeto && b.mlVeto.enabled && b.mlVeto.model) {
        lines.push(`<div style="margin-top:${lines.length ? '4px' : '0'};">🧠 ML-Filter aktiv (Schwelle ${Math.round((b.mlVeto.threshold || 0.6) * 100)}%) — ${b.mlVeto.vetoedCount || 0} Trade(s) verhindert. <button type="button" id="btn-disable-ml-veto" style="margin-left:6px; font-size:9px; padding:2px 6px; border:1px dashed var(--border); background:transparent; color:var(--text-dim); border-radius:3px; cursor:pointer;">Deaktivieren</button></div>`);
      }
      if (lines.length > 0) {
        vetoStatusEl.style.display = 'block';
        vetoStatusEl.innerHTML = lines.join('');
        const disableBtn = document.getElementById('btn-disable-veto');
        if (disableBtn) {
          disableBtn.addEventListener('click', () => {
            App.state.bot.veto.enabled = false;
            App.saveToLocalStorage();
            App.Bot.renderBotUI();
            App.UI.showToast('Regelbasierter Fine-Tune-Filter deaktiviert.');
          });
        }
        const disableMlBtn = document.getElementById('btn-disable-ml-veto');
        if (disableMlBtn) {
          disableMlBtn.addEventListener('click', () => {
            App.state.bot.mlVeto.enabled = false;
            App.saveToLocalStorage();
            App.Bot.renderBotUI();
            App.UI.showToast('ML-Fine-Tune-Filter deaktiviert.');
          });
        }
      } else {
        vetoStatusEl.style.display = 'none';
      }
    }

    const driftEl = document.getElementById('bot-drift-status');
    if (driftEl) {
      const status = this.getDriftStatus(null);
      if (!status) {
        driftEl.style.display = 'none';
      } else {
        driftEl.style.display = 'block';
        const hitPct = Math.round(status.hitRate * 100);
        const history = b.driftHistory || [];
        const first = history[0];
        const trendDiff = first ? Math.round((status.hitRate - first.hitRate) * 100) : null;

        let warning = '';
        if (status.hitRate < 0.5) {
          warning = `<div style="margin-top:4px; color: var(--short); font-weight:600;">⚠ Filter liegt aktuell schlechter als Zufall — verhindert mehr Gewinne als Verluste. Erwäge, ihn zu deaktivieren.</div>`;
        } else if (trendDiff !== null && trendDiff <= -20) {
          warning = `<div style="margin-top:4px; color: #ffb020; font-weight:600;">⚠ Trefferquote sinkt deutlich (${trendDiff} Punkte seit erster Messung) — möglicher Hinweis auf verändertes Marktverhalten.</div>`;
        }

        driftEl.innerHTML = `
          <div>📉 Live-Drift-Überwachung (letzte ${status.sampleSize} verhinderte Trades, virtuell nachverfolgt):</div>
          <div style="margin-top:2px;">Trefferquote: <strong style="color:${status.hitRate >= 0.5 ? 'var(--long)' : 'var(--short)'};">${hitPct}%</strong> (${status.lossCount} bestätigt vermiedene Verluste, ${status.winCount} verhinderte Gewinne)</div>
          ${warning}
        `;
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

    // Keep filter info panels in sync whenever the bot UI is re-rendered
    if (App.UI && App.UI.renderActiveFiltersInfo) App.UI.renderActiveFiltersInfo();
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
    const cardTimerEl = document.getElementById('bot-card-cooldown-timer');
    if (!timerEl) return;

    if (!b.active) {
      timerEl.textContent = 'Bot ist inaktiv.';
      timerEl.style.color = 'var(--text-dim)';
      if (cardTimerEl) {
        cardTimerEl.textContent = 'CD: INAKTIV';
        cardTimerEl.style.color = 'var(--text-faint)';
      }
      return;
    }

    const now = Date.now();
    const remainingMs = Math.max(0, (b.cooldownMin * 60000) - (now - b.lastTradeTime));
    if (remainingMs > 0) {
      const min = Math.floor(remainingMs / 60000);
      const sec = Math.floor((remainingMs % 60000) / 1000);
      timerEl.textContent = `Abklingzeit aktiv. Nächster Trade in: ${min}m ${sec}s`;
      timerEl.style.color = '#ffb020';
      if (cardTimerEl) {
        cardTimerEl.textContent = `CD: ${min}m ${sec}s`;
        cardTimerEl.style.color = '#ffb020';
      }
    } else {
      timerEl.textContent = 'Bereit für nächsten Trade.';
      timerEl.style.color = 'var(--long)';
      if (cardTimerEl) {
        cardTimerEl.textContent = 'CD: BEREIT';
        cardTimerEl.style.color = 'var(--long)';
      }
    }
  },

  // --- Live-Drift-Überwachung ---
  //
  // Ein verhinderter Trade wird nie real eröffnet, wir kennen also nie direkt, ob das Veto
  // richtig lag. Lösung: ein "Schatten-Trade" — dieselben TP/SL-Level wie ein echter Trade,
  // aber rein virtuell mitverfolgt. Löst er später den SL aus, hatte das Veto recht (Verlust
  // verhindert). Löst er den TP aus, hat das Veto einen Gewinn verhindert (Veto war falsch).
  // Über viele solcher Schatten-Trades ergibt sich eine echte, laufend aktualisierte
  // Trefferquote des Filters im aktuellen Marktumfeld — statt nur der Bewertung von damals.

  SHADOW_ROLLING_WINDOW: 20,

  createShadowTrade(side, source, detail) {
    const b = App.state.bot;
    const entryPrice = App.state.lastPrice;
    if (!entryPrice) return;

    const marginSats = App.Engine.margin(b.qtyUsd, entryPrice, b.leverage);
    const tpSats = Math.round(marginSats * (b.tpPercent / 100));
    const slSats = Math.round(marginSats * (b.slPercent / 100));
    const tpPrice = App.Engine.getTpPrice(side, b.qtyUsd, entryPrice, b.leverage, tpSats);
    const slPrice = App.Engine.getSlPrice(side, b.qtyUsd, entryPrice, b.leverage, slSats);
    if (!tpPrice || !slPrice) return;

    b.shadowTrades.push({
      id: App.nextId(),
      createdAt: Date.now(),
      side, source, detail,
      entryPrice, tpPrice, slPrice,
      status: 'pending'
    });
    // Bounded history so this doesn't grow forever
    if (b.shadowTrades.length > 300) b.shadowTrades = b.shadowTrades.slice(-300);
    App.saveToLocalStorage();
  },

  resolveShadowTrades() {
    const b = App.state.bot;
    if (!b || !b.shadowTrades || b.shadowTrades.length === 0) return;
    const price = App.state.lastPrice;
    if (!price) return;

    let resolvedAny = false;
    const now = Date.now();

    b.shadowTrades.forEach(s => {
      if (s.status !== 'pending') return;
      // Kein Zeitlimit — genau wie echte Positionen in dieser Engine bleibt ein Schatten-Trade
      // offen, bis er TP oder SL erreicht, egal ob das Minuten oder Tage dauert
      if (s.side === 'long') {
        if (price >= s.tpPrice) { s.status = 'win'; s.resolvedAt = now; resolvedAny = true; }
        else if (price <= s.slPrice) { s.status = 'loss'; s.resolvedAt = now; resolvedAny = true; }
      } else {
        if (price <= s.tpPrice) { s.status = 'win'; s.resolvedAt = now; resolvedAny = true; }
        else if (price >= s.slPrice) { s.status = 'loss'; s.resolvedAt = now; resolvedAny = true; }
      }
    });

    if (resolvedAny) {
      this.recordDriftSnapshot();
      App.saveToLocalStorage();
      if (App.UI && App.UI.renderMarketLawsLibrary) App.UI.renderMarketLawsLibrary();
    }
  },

  // Rolling hit-rate over the most recent resolved (win/loss, not expired) shadow trades —
  // "hit" here means the veto correctly predicted a loss.
  getDriftStatus(source) {
    const b = App.state.bot;
    if (!b || !b.shadowTrades) return null;
    const resolved = b.shadowTrades.filter(s => (s.status === 'win' || s.status === 'loss') && (!source || s.source === source));
    const recent = resolved.slice(-this.SHADOW_ROLLING_WINDOW);
    if (recent.length === 0) return null;
    const lossCount = recent.filter(s => s.status === 'loss').length;
    const winCount = recent.length - lossCount;
    const hitRate = lossCount / recent.length;
    return { sampleSize: recent.length, lossCount, winCount, hitRate };
  },

  recordDriftSnapshot() {
    const b = App.state.bot;
    const status = this.getDriftStatus(null);
    if (!status || status.sampleSize < this.SHADOW_ROLLING_WINDOW) return; // erst ab voller Fenstergröße snapshotten
    const last = b.driftHistory[b.driftHistory.length - 1];
    // Nur neuen Snapshot anlegen, wenn sich die Stichprobe seit dem letzten wirklich verändert hat
    if (last && last.sampleSize === status.sampleSize && last.hitRate === status.hitRate) return;
    b.driftHistory.push({ timestamp: Date.now(), ...status });
    if (b.driftHistory.length > 100) b.driftHistory = b.driftHistory.slice(-100);
  },

  runBotLogic() {
    const b = App.state.bot;
    if (!b) return;

    this.resolveShadowTrades();

    // --- Martingale State Update ---
    if (b.martingale && b.martingale.enabled && b.martingale.lastPositionId) {
      const closedTrade = App.state.history.find(h => h.id === b.martingale.lastPositionId);
      if (closedTrade) {
        if (closedTrade.reason === 'tp') {
          b.martingale.currentStep = 0;
          b.martingale.accumulatedLossSats = 0;
          this.logBot(`🎉 Martingale: Letzter Trade war ein Gewinn (TP). Zurück auf Basisbetrag.`);
        } else if (closedTrade.reason === 'sl' || closedTrade.reason === 'liquidation') {
          b.martingale.currentStep++;
          const lossSats = Math.abs(closedTrade.pnlSats);
          b.martingale.accumulatedLossSats = (b.martingale.accumulatedLossSats || 0) + lossSats;

          // Check if safety limit (based on step count) is exceeded
          const maxSteps = b.martingale.maxMultiplier || 8;
          if (b.martingale.currentStep > maxSteps) {
            b.martingale.currentStep = 0;
            b.martingale.accumulatedLossSats = 0;
            this.logBot(`⚠ Martingale: Nächster Schritt (${b.martingale.currentStep}) übersteigt Limit von ${maxSteps} Schritten. Zurück auf Basisbetrag.`);
          } else {
            // Calculate next qty for logging purposes
            const nextPrice = App.state.lastPrice || closedTrade.exitPrice;
            const nextLeverage = b.leverage;
            const nextTpPercent = b.tpPercent;
            const targetProfit = b.martingale.targetProfitSats || (App.Engine.margin(b.qtyUsd, nextPrice, nextLeverage) * (nextTpPercent / 100));
            const reqProfitSats = targetProfit + b.martingale.accumulatedLossSats;
            const marginSatsFor1Usd = App.Engine.margin(1.0, nextPrice, nextLeverage);
            const profitPerUsd = marginSatsFor1Usd * (nextTpPercent / 100);
            const nextQtyUsd = reqProfitSats / profitPerUsd;

            this.logBot(`⚠ Martingale: Verlust erlitten. Stufe ${b.martingale.currentStep}. Verlust: ${Math.round(lossSats).toLocaleString()} sats. Nächster Einsatz: $${Math.round(nextQtyUsd)}`);
          }
        }
        b.martingale.lastPositionId = null;
        App.saveToLocalStorage();
      }
    }

    if (!b.active) return;

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

    // Fine-Tune-Veto: unser Modell sagt "kaufen/verkaufen", aber wenn die aktuelle Marktlage
    // einem historisch gelernten Verlust-Muster ähnelt, wird der Trade verhindert
    if (triggerAction !== 'none' && b.veto && b.veto.enabled && b.veto.codes && b.veto.codes.length > 0) {
      const liveCandles = App.API.activeCandles['1m'];
      if (liveCandles && liveCandles.length > 0) {
        const vetoCode = App.TradeAnalyzer.shouldVeto(liveCandles, liveCandles.length - 1, triggerAction, b.veto.codes);
        if (vetoCode) {
          b.veto.vetoedCount = (b.veto.vetoedCount || 0) + 1;
          App.UI.showToast(`Trade verhindert (Fine-Tune: ${App.TradeAnalyzer.REASON_LABELS[vetoCode]})`);
          this.createShadowTrade(triggerAction, 'rule', vetoCode);
          triggerAction = 'none';
        }
      }
    }

    // ML-Fine-Tune: trainiertes Modell schätzt Verlustwahrscheinlichkeit live
    if (triggerAction !== 'none' && b.mlVeto && b.mlVeto.enabled && b.mlVeto.model) {
      const liveCandles = App.API.activeCandles['1m'];
      if (liveCandles && liveCandles.length > 0) {
        const p = App.TradeAnalyzer.shouldVetoML(b.mlVeto.model, liveCandles, liveCandles.length - 1, triggerAction, b.mlVeto.threshold || 0.6);
        if (p !== null) {
          b.mlVeto.vetoedCount = (b.mlVeto.vetoedCount || 0) + 1;
          App.UI.showToast(`Trade verhindert (ML-Fine-Tune: ${Math.round(p * 100)}% geschätzte Verlustwahrscheinlichkeit)`);
          this.createShadowTrade(triggerAction, 'ml', `${Math.round(p * 100)}%`);
          triggerAction = 'none';
        }
      }
    }

    if (triggerAction === 'none') return;

    const now = Date.now();
    const elapsedMs = now - b.lastTradeTime;
    const cooldownMs = (b.martingale && b.martingale.enabled) ? 0 : b.cooldownMin * 60000;
    if (elapsedMs < cooldownMs) return;

    // Martingale allows only 1 open trade at a time
    const maxAllowed = (b.martingale && b.martingale.enabled) ? 1 : b.maxOpen;
    if (App.state.positions.length >= maxAllowed) return;

    const side = triggerAction;
    const entryPrice = App.Engine.fillPrice(side, 'market', App.state.lastPrice, null);

    // Calculate base qty, optionally adjusted by Kelly (bypassed if martingale is active)
    let tradeQtyUsd = b.qtyUsd;
    let kellyFactor = 1.0;
    const martingaleActive = b.martingale && b.martingale.enabled;
    if (!martingaleActive && b.mlVeto && b.mlVeto.model) {
      const liveCandles = App.API.activeCandles['1m'];
      if (liveCandles && liveCandles.length > 0) {
        const pLoss = App.TradeAnalyzer.predictLossProbability(b.mlVeto.model, liveCandles, liveCandles.length - 1, side);
        const pWin = 1 - pLoss;
        const kelly = App.Engine.kellyAdjustedQty(b.qtyUsd, pWin, b.tpPercent, b.slPercent);
        tradeQtyUsd = kelly.qty;
        kellyFactor = kelly.factor;
      }
    }

    // Apply Martingale recovery if enabled
    let martingaleInfo = '';
    if (b.martingale && b.martingale.enabled) {
      if (b.martingale.currentStep > 0) {
        const targetProfit = b.martingale.targetProfitSats || (App.Engine.margin(b.qtyUsd, entryPrice, b.leverage) * (b.tpPercent / 100));
        const reqProfitSats = targetProfit + (b.martingale.accumulatedLossSats || 0);
        const marginSatsFor1Usd = App.Engine.margin(1.0, entryPrice, b.leverage);
        const profitPerUsd = marginSatsFor1Usd * (b.tpPercent / 100);
        tradeQtyUsd = reqProfitSats / profitPerUsd;
        
        martingaleInfo = ` (Martingale-Recovery -> $${Math.round(tradeQtyUsd)} [Stufe ${b.martingale.currentStep}])`;
      }
    }

    const marginSats = App.Engine.margin(tradeQtyUsd, entryPrice, b.leverage);
    const feeSats = App.Engine.fee(tradeQtyUsd, entryPrice, App.CONFIG.feeRate);

    if (marginSats + feeSats > App.state.balanceSats) {
      this.logBot(`⚠ Fehler: Nicht genug Guthaben für Bot-Trade (${Math.round(marginSats + feeSats).toLocaleString()} sats benötigt).`);
      return;
    }

    const tpSats = Math.round(marginSats * (b.tpPercent / 100));
    const slSats = Math.round(marginSats * (b.slPercent / 100));

    const kellyInfo = kellyFactor !== 1.0 ? ` (Kelly ×${kellyFactor.toFixed(2)} → ${App.UI.fmtUsd(tradeQtyUsd)})` : '';
    this.logBot(`🤖 Signal erkannt: ${side.toUpperCase()}${kellyInfo}${martingaleInfo}...`);
    const success = App.Engine.openPosition(side, tradeQtyUsd, b.leverage, 'market', App.state.lastPrice, null, tpSats, slSats);
    if (success) {
      b.lastTradeTime = now;
      const newPos = App.state.positions[App.state.positions.length - 1];
      if (newPos) {
        if (b.martingale && b.martingale.enabled) {
          b.martingale.lastPositionId = newPos.id;
          if (b.martingale.currentStep === 0) {
            b.martingale.targetProfitSats = tpSats;
          }
        }
      }
      this.logBot(`🤖 ${side.toUpperCase()} eröffnet @ ${App.UI.fmtUsd(entryPrice)} (TP: +${tpSats.toLocaleString()} sats, SL: -${slSats.toLocaleString()} sats).`);
      App.UI.renderAll();
    }
  }
};
