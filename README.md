# 🚀 ThreeSixNine_Pattern Trading Engine & Auto-ML System

Eine hochperformante, modulare **Quantitative Trading Engine** und KI-gestützte Strategie-Optimierungs-Plattform für Krypto-Perpetuals (Binance 1m Kerzendaten / LN-Markets).

Das System kombiniert einen blitzschnellen, AVX2- und OpenMP-beschleunigten **C-Backtest-Optimizer**, ein **TensorFlow.js Neural Loss Classifier (ML-Veto)** und ein **Ewiges Arena-Ranking** mit Leave-One-Out Cross-Validation über mehrere Jahre.

---

## 🤖 Hauptfokus: Das Auto-ML & KI-Veto System

Das Herzstück der Plattform ist das automatische **Auto-ML & Robustheits-System** (Tab 2). Es entwickelt, testet, filtert und validiert Trading-Strategien vollautomatisch.

```
┌────────────────────────┐      ┌─────────────────────────┐      ┌─────────────────────────┐
│  C-Parallel Grid       │ ───► │  TensorFlow.js          │ ───► │  Leave-One-Out (LOO)    │
│  Optimizer (80M+ Runs) │      │  Neural Loss Classifier │      │  Eternal Arena Ranking  │
└────────────────────────┘      └─────────────────────────┘      └─────────────────────────┘
```

### 1. ⚡ AVX2 & OpenMP beschleunigter C-Grid-Optimizer (`optimizer.c`)
- **Exhaustiver Grid Sweep**: Berechnet **über 82.000.000 Parameter-Kombinationen** lückenlos in wenigen Sekunden über alle verfügbaren CPU-Kerne.
- **Parameter-Dimensionen**:
  - **16 Hebel-Stufen**: $5\text{x}, 6\text{x}, 7\text{x}, 8\text{x}, 9\text{x}, 10\text{x}, 11\text{x}, 12\text{x}, 13\text{x}, 14\text{x}, 15\text{x}, 16\text{x}, 17\text{x}, 18\text{x}, 19\text{x}, 20\text{x}$ (lückenlos)
  - **15 Cooldown-Stufen**: $1\text{m} \dots 30\text{m}$ Kerzen-Sperrzeit
  - **15 Take-Profit Stufen**: $5\% \dots 75\%$ Margin-Profit
  - **10 Stop-Loss Stufen**: $5\% \dots 50\%$ Margin-Loss
  - **6 Max-Positionen Stufen**: $1 \dots 6$ simultane Trades

### 2. 📐 Multi-Timeframe Regelsuch-Matrix (1m bis 12h)
- Durchsucht alle 10 Zeitebenen: **`1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `12h`**.
- **Triple-Timeframe Counter-Indikatoren**: Kombiniert Timing-Muster auf niedrigen Zeitebenen mit übergeordneten Haupttrend-Filtern.
  - *Beispiel Long*: `1m Bull AND 3m Bear (Counter-Rücksetzer) AND 1h Bull (Haupttrend)`
  - *Beispiel Short*: `1m Bear AND 3m Bull (Counter-Rücksetzer) AND 1h Bear (Haupttrend)`

### 3. 🧠 TensorFlow.js Neural Loss Classifier (ML-Veto)
- Trainiert ein neuronales Netz (Binary Cross-Entropy / Sigmoid) auf historischen Verlust-Trades.
- **Strikter 50% Schwellenwert (`Threshold = 0.50`)**: Sobald das Modell eine Verlustwahrscheinlichkeit von $\ge 50\%$ berechnet, wird das Einstiegs-Signal sofort blockiert.
- **Wirkung**: Dient als unüberwindbare Sicherheits-Firewall in Bärenmärkten und Crash-Jahren (z. B. 2018, 2022).

### 4. 📊 Schutz vor Overfitting (Deflated Sharpe & Wilson Score)
- **Wilson Score Interval**: Die Winrate wird anhand des statistischen Konfidenzintervalls gewichtet. Strategien mit wenigen Trades werden vorsichtig bewertet.
- **Deflated Sharpe Ratio (DSR)**: Der Score sinkt logarithmisch mit der Anzahl ausprobierter Kombinationen, um Zufallstreffer durch Multiple-Testing auszuschließen.

---

## 🏆 Das Ewige Arena-Ranking (Leave-One-Out Cross-Validation)

Das Arena-Modul (Tab 3) schickt die besten Strategie-Kandidaten aus dem Auto-ML System in einen unbarmherzigen Langzeit-Härtetest über mehrere Jahre (z. B. 2018–2025).

### 🔄 Leave-One-Out (LOO) Rotations-Verfahren
1. Ein Jahr $k$ (z. B. 2022) wird als **absolut ungesehenes Holdout-Testjahr** reserviert.
2. Die verbleibenden $N-1$ Jahre werden für das In-Sample Training (70/30 Split) genutzt.
3. Das System durchläuft das ungesehene Holdout-Jahr **ein einziges Mal mit aktivem ML-Veto** ohne jegliche Parameteranpassung.

### 📐 Konservative Arena-Score Formel
$$\text{Finaler Arena-Score} = 0,70 \times \text{Perzentil}_{25}(\text{Holdout-Scores}) + 0,30 \times \min(\text{Holdout-Scores})$$

- **25%-Perzentil ($\text{P25}$)**: Beseitigt statistische Ausreißer.
- **Minimum-Score ($\min$)**: Garantiert Schutz vor katastrophalen Verlusten im schlimmsten Bärenmarkt-Jahr.

---

## 🖥️ Systemarchitektur & Module

Das System ist in 3 übersichtliche Hauptmodule unterteilt:

- **Modul 1: Einzel-Backtest & Kerzen-Historie**: Binance API Candle Loader (1m Intervall), Indikatoren-Chart, Trade-Log & CSV-Export.
- **Modul 2: Auto-ML & Robustheit**: C-Engine Grid Search, TensorFlow.js ML-Veto Pipeline, 2D Heatmaps & Marktlagen-Bibliothek.
- **Modul 3: Ewiges Arena-Ranking**: LOO Holdout-Evaluierung, Live Stepper Progress-Monitor & detaillierte Rotations-Ergebnisse.

---

## 🛠️ Installation & Schnellstart

### Systemvoraussetzungen
- **Node.js** (v16 oder höher)
- **GCC Compiler** mit OpenMP Unterstützung (Linux/macOS)

### 1. Repository klonen & Abhängigkeiten installieren
```bash
cd LN-Markets-Test-Trading
npm install
```

### 2. C-Parallel-Optimizer kompilieren
```bash
gcc -O3 -fopenmp -o optimizer optimizer.c -lm
```

### 3. Server starten
```bash
npm start
# Server läuft unter http://localhost:3000
```

---

## 📄 Lizenz & Haftungsausschluss

Dieses Projekt dient ausschließlich zu Test-, Simulations- und Forschungszwecken im Bereich des quantitativen Tradings. Automated Trading birgt finanzielle Risiken.
