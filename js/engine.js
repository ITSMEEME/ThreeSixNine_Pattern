window.App = window.App || {};

App.Engine = {
  margin(qtyUsd, price, leverage){
    return (qtyUsd / price / leverage) * App.SATS_PER_BTC;
  },
  
  fee(qtyUsd, price, rate){
    return (qtyUsd / price) * rate * App.SATS_PER_BTC;
  },
  
  liqPrice(side, entryPrice, leverage){
    if (side === 'long') return entryPrice * (leverage / (leverage + 1)) * (1 + App.CONFIG.feeRate);
    if (leverage <= 1) return null;
    return entryPrice * (leverage / (leverage - 1)) * (1 - App.CONFIG.feeRate);
  },
  
  pnl(side, qtyUsd, entryPrice, exitPrice){
    if (side === 'long') return qtyUsd * (1/entryPrice - 1/exitPrice) * App.SATS_PER_BTC;
    return qtyUsd * (1/exitPrice - 1/entryPrice) * App.SATS_PER_BTC;
  },
  
  fillPrice(side, orderType, markPrice, limitPrice){
    if (orderType === 'limit') return limitPrice;
    // Market: synthetischer Spread gegen den Trader
    return side === 'long' ? markPrice * (1 + App.CONFIG.spread) : markPrice * (1 - App.CONFIG.spread);
  },
  
  openPosition(side, qtyUsd, leverage, orderType, price, limitPrice, tpSats = null, slSats = null){
    const entryPrice = this.fillPrice(side, orderType, price, limitPrice);
    const margin = this.margin(qtyUsd, entryPrice, leverage);
    const fee = this.fee(qtyUsd, entryPrice, App.CONFIG.feeRate);
    if (margin + fee > App.state.balanceSats){
      App.UI.showToast('Nicht genug Guthaben für Margin + Gebühr.');
      return false;
    }
    App.state.balanceSats -= (margin + fee);
    const pos = {
      id: App.nextId(), side, qtyUsd, leverage, entryPrice,
      marginSats: margin, liqPrice: this.liqPrice(side, entryPrice, leverage),
      openedAt: Date.now(),
      entryFeeSats: fee,
      tpSats: tpSats || null,
      slSats: slSats || null
    };
    App.state.positions.push(pos);
    App.UI.showToast(`${side==='long'?'Long':'Short'} eröffnet @ ${App.UI.fmtUsd(entryPrice)}`);
    return true;
  },
  
  closePosition(id, exitPrice, reason){
    const idx = App.state.positions.findIndex(p => p.id === id);
    if (idx === -1) return;
    const p = App.state.positions[idx];
    const pnl = this.pnl(p.side, p.qtyUsd, p.entryPrice, exitPrice);
    const fee = this.fee(p.qtyUsd, exitPrice, App.CONFIG.feeRate);
    const entryFee = p.entryFeeSats ?? this.fee(p.qtyUsd, p.entryPrice, App.CONFIG.feeRate);
    const netRealizedPnl = reason === 'liquidation' ? -(p.marginSats + entryFee) : pnl - entryFee - fee;
    
    if (reason === 'liquidation') {
      // In isolated margin, the user loses exactly their marginSats.
      // Since marginSats was already deducted when opening, we return 0.
      // No closing fee is deducted from the remaining cash balance.
    } else {
      App.state.balanceSats += p.marginSats + pnl - fee;
    }
    
    App.state.positions.splice(idx, 1);
    App.state.history.unshift({
      id: p.id, side: p.side, qtyUsd: p.qtyUsd, leverage: p.leverage,
      entryPrice: p.entryPrice, exitPrice, pnlSats: netRealizedPnl, reason: reason || 'manual',
      openedAt: p.openedAt,
      closedAt: Date.now()
    });
    if (reason === 'liquidation'){
      App.UI.showToast(`⚠ ${p.side==='long'?'Long':'Short'} liquidiert @ ${App.UI.fmtUsd(exitPrice)}`, true);
    } else {
      App.UI.showToast(`Position geschlossen. PnL: ${App.UI.fmtSats(netRealizedPnl)}`);
    }
    App.UI.renderAll();
  },
  
  checkLiquidations(markPrice){
    [...App.state.positions].forEach(p => {
      if (p.side === 'long' && markPrice <= p.liqPrice){
        this.closePosition(p.id, p.liqPrice, 'liquidation');
      } else if (p.side === 'short' && p.liqPrice !== null && markPrice >= p.liqPrice){
        this.closePosition(p.id, p.liqPrice, 'liquidation');
      }
    });
  },
  
  checkLimitOrders(markPrice){
    [...App.state.orders].forEach(o => {
      const triggered = (o.side === 'long' && markPrice <= o.limitPrice) ||
                         (o.side === 'short' && markPrice >= o.limitPrice);
      if (triggered){
        App.state.orders = App.state.orders.filter(x => x.id !== o.id);
        this.openPosition(o.side, o.qtyUsd, o.leverage, 'limit', markPrice, o.limitPrice, o.tpSats, o.slSats);
        App.UI.renderAll();
      }
    });
  },
  
  checkTpSl(markPrice){
    [...App.state.positions].forEach(p => {
      const entryFee = p.entryFeeSats ?? this.fee(p.qtyUsd, p.entryPrice, App.CONFIG.feeRate);
      const pnl = this.pnl(p.side, p.qtyUsd, p.entryPrice, markPrice);
      const exitFee = this.fee(p.qtyUsd, markPrice, App.CONFIG.feeRate);
      const netPnl = pnl - entryFee - exitFee;

      if (p.tpSats && netPnl >= p.tpSats) {
        const tpPrice = this.getTpPrice(p.side, p.qtyUsd, p.entryPrice, p.leverage, p.tpSats) || markPrice;
        this.closePosition(p.id, tpPrice, 'tp');
      } else if (p.slSats && netPnl <= -p.slSats) {
        const slPrice = this.getSlPrice(p.side, p.qtyUsd, p.entryPrice, p.leverage, p.slSats) || markPrice;
        this.closePosition(p.id, slPrice, 'sl');
      }
    });
  },
  
  unrealizedPnl(markPrice){
    return App.state.positions.reduce((sum, p) => {
      const pnl = this.pnl(p.side, p.qtyUsd, p.entryPrice, markPrice);
      const exitFee = this.fee(p.qtyUsd, markPrice, App.CONFIG.feeRate);
      return sum + (pnl - exitFee);
    }, 0);
  },

  getTpPrice(side, qtyUsd, entryPrice, leverage, tpSats) {
    if (!tpSats) return null;
    const entryFee = this.fee(qtyUsd, entryPrice, App.CONFIG.feeRate);
    if (side === 'long') {
      const A = (qtyUsd / entryPrice) * App.SATS_PER_BTC - entryFee - tpSats;
      if (A <= 0) return null;
      return (qtyUsd * (1 + App.CONFIG.feeRate) * App.SATS_PER_BTC) / A;
    } else {
      const B = tpSats + (qtyUsd / entryPrice) * App.SATS_PER_BTC + entryFee;
      if (B <= 0) return null;
      return (qtyUsd * (1 - App.CONFIG.feeRate) * App.SATS_PER_BTC) / B;
    }
  },

  getSlPrice(side, qtyUsd, entryPrice, leverage, slSats) {
    if (!slSats) return null;
    const entryFee = this.fee(qtyUsd, entryPrice, App.CONFIG.feeRate);
    const T = -slSats;
    if (side === 'long') {
      const A = (qtyUsd / entryPrice) * App.SATS_PER_BTC - entryFee - T;
      if (A <= 0) return null;
      return (qtyUsd * (1 + App.CONFIG.feeRate) * App.SATS_PER_BTC) / A;
    } else {
      const B = T + (qtyUsd / entryPrice) * App.SATS_PER_BTC + entryFee;
      if (B <= 0) return null;
      return (qtyUsd * (1 - App.CONFIG.feeRate) * App.SATS_PER_BTC) / B;
    }
  }
};
