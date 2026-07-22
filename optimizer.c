#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <omp.h>

#define SATS_PER_BTC 100000000.0

// Zentrale Allokations-Helfer: brechen kontrolliert mit Fehlermeldung ab
// statt mit NULL-Pointer-Dereferenzierung abzustürzen (OOM-Schutz).
static void* safe_malloc(size_t size, const char* what) {
    void* p = malloc(size);
    if (!p) {
        fprintf(stderr, "Fatal: malloc fehlgeschlagen (%zu Bytes) fuer %s\n", size, what);
        exit(1);
    }
    return p;
}

static void* safe_realloc(void* ptr, size_t size, const char* what) {
    void* p = realloc(ptr, size);
    if (!p) {
        fprintf(stderr, "Fatal: realloc fehlgeschlagen (%zu Bytes) fuer %s\n", size, what);
        free(ptr);
        exit(1);
    }
    return p;
}

typedef struct {
    long long time;
    double open;
    double high;
    double low;
    double close;
    double volume;
} Candle;

typedef struct {
    int interval_idx; // 0 to 9 (Index in g_interval_names / htf_durations)
    int expected_signal; // 1 (bull), -1 (bear)
} Rule;

typedef struct {
    // Fix: war vorher [2], obwohl der Triple-Regel-Code bereits auf Index 2
    // schrieb -> Buffer-Overflow. Jetzt korrekt auf 3 Elemente (nur Triple-TF).
    Rule longRules[3];
    int longRulesCount;
    Rule shortRules[3];
    int shortRulesCount;
    char label[64];
} RuleSet;

typedef struct {
    int side; // 0 = long, 1 = short
    double entryPrice;
    double invEntryPrice;
    double marginSats;
    double entryFeeSats;
    double tpPrice;
    double slPrice;
    double liqPrice;
    double qtyUsd;
} ActiveTrade;

typedef struct {
    int leverage;
    int cooldownMin;
    double tpPercent;
    double slPercent;
    int maxOpen;
    int ruleIndex;
} StrategyParams;

typedef struct {
    double finalBalanceSats;
    double totalReturnPercent;
    double maxDrawdownPercent;
    double profitFactor;
    double winRatePercent;
    int totalTrades;
    double totalFeesSats;
    int longTrades;
    int shortTrades;
    double maxLosingStreak;
    double avgTradePercent;
    double grossProfit;
    double maxWin;
    double sortinoRatio;
    double calmarRatio;
    double wfeScore;
} BacktestResult;

typedef struct {
    StrategyParams params;
    BacktestResult results;
    double score;
} StrategyEvaluation;

// Global rule sets array
// Kapazitaet: nur-Triple ueber 10 Timeframes = C(10,3) * 2^3 Vorzeichen-
// Kombinationen (gemischt bull/bear) = 120 * 8 = 960. Mit Puffer auf 1000.
#define MAX_RULE_SETS 1000
RuleSet rule_sets[MAX_RULE_SETS];
int rule_sets_count = 0;

// Namen der 10 Timeframes, Index muss zu htf_durations / interval_mins passen.
const char* g_interval_names[10] = {
    "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h"
};

// Global pointers for HTF data (not modified, shared read-only across threads)
Candle* htf_candles[10];
int htf_counts[10];
int* htf_signals[10];
long long htf_durations[10] = { 
    60000LL,     // 1m
    180000LL,    // 3m
    300000LL,    // 5m
    900000LL,    // 15m
    1800000LL,   // 30m
    3600000LL,   // 1h
    7200000LL,   // 2h
    14400000LL,  // 4h
    21600000LL,  // 6h
    43200000LL   // 12h
};

// Precomputed HTF pointer cache: htf_ptr_cache[tf][candle_index] = correct pointer
int* htf_ptr_cache[10];

typedef struct {
    double high;
    double low;
    double close;
} HLC;

typedef struct {
    double min_low;
    double max_high;
} HLCBlock16;

HLC* g_hlc = NULL;
HLCBlock16* g_hlc_blocks = NULL;

unsigned char* rule_side_signal[MAX_RULE_SETS];
int* rule_next_signal[MAX_RULE_SETS];

// Nur noch Triple-Timeframe-Regeln, aber ueber ALLE 10 Timeframes und ALLE
// gemischten Bull/Bear-Vorzeichenkombinationen (nicht mehr nur "alle bull"
// oder "alle bear" wie im urspruenglichen Code).
//
// Fuer jedes Tripel von 3 verschiedenen Timeframes (aus 10, ungeordnet:
// C(10,3) = 120) werden alle 2^3 = 8 Vorzeichen-Muster durchprobiert, z.B.
// 1m Bull AND 3m Bear AND 1h Bull. Macht 120 * 8 = 960 RuleSets.
//
// Die Short-Seite jedes RuleSets ist bewusst das exakte Spiegelbild der
// Long-Seite (alle Vorzeichen invertiert) -- das entspricht der bisherigen
// Konvention "Short-Einstieg = Gegenteil des Long-Einstiegs" und wird durch
// die Vorzeichen-Enumeration der Long-Seite bereits vollstaendig abgedeckt
// (jedes Spiegelbild-Muster ist selbst auch ein enumeriertes Long-Muster).
void generate_rule_sets() {
    const int intervals_count = 10; // g_interval_names / htf_durations

    for (int i = 0; i < intervals_count - 2; i++) {
        for (int j = i + 1; j < intervals_count - 1; j++) {
            for (int k = j + 1; k < intervals_count; k++) {
                int tf_idx[3] = { i, j, k };

                // Alle 8 Kombinationen aus Bull(+1)/Bear(-1) fuer die 3 TFs.
                for (int mask = 0; mask < 8; mask++) {
                    int sign[3];
                    sign[0] = (mask & 1) ? 1 : -1;
                    sign[1] = (mask & 2) ? 1 : -1;
                    sign[2] = (mask & 4) ? 1 : -1;

                    RuleSet* r3 = &rule_sets[rule_sets_count++];
                    r3->longRulesCount = 3;
                    r3->shortRulesCount = 3;

                    char label_buf[64];
                    label_buf[0] = '\0';

                    for (int n = 0; n < 3; n++) {
                        r3->longRules[n].interval_idx = tf_idx[n];
                        r3->longRules[n].expected_signal = sign[n];

                        // Short-Seite = exaktes Spiegelbild (Vorzeichen invertiert)
                        r3->shortRules[n].interval_idx = tf_idx[n];
                        r3->shortRules[n].expected_signal = -sign[n];

                        char part[16];
                        snprintf(part, sizeof(part), "%s%s",
                                 g_interval_names[tf_idx[n]],
                                 (sign[n] == 1) ? "+" : "-");
                        strcat(label_buf, part);
                        if (n < 2) strcat(label_buf, " ");
                    }
                    snprintf(r3->label, sizeof(r3->label), "%s", label_buf);
                }
            }
        }
    }
}

int aggregate_candles(const Candle* candles1m, int count1m, int intervalMin, Candle* out_candles) {
    if (intervalMin == 1) {
        memcpy(out_candles, candles1m, sizeof(Candle) * count1m);
        return count1m;
    }
    int out_count = 0;
    for (int i = 0; i < count1m; i += intervalMin) {
        int limit = i + intervalMin;
        if (limit > count1m) limit = count1m;
        if (limit == i) break;
        
        double open = candles1m[i].open;
        double close = candles1m[limit - 1].close;
        double high = candles1m[i].high;
        double low = candles1m[i].low;
        double volume = 0;
        for (int j = i; j < limit; j++) {
            if (candles1m[j].high > high) high = candles1m[j].high;
            if (candles1m[j].low < low) low = candles1m[j].low;
            volume += candles1m[j].volume;
        }
        
        out_candles[out_count].time = candles1m[i].time;
        out_candles[out_count].open = open;
        out_candles[out_count].high = high;
        out_candles[out_count].low = low;
        out_candles[out_count].close = close;
        out_candles[out_count].volume = volume;
        out_count++;
    }
    return out_count;
}

void precalculate_pattern_signals(const Candle* candles_I, int count_I, int* signals) {
    memset(signals, 0, sizeof(int) * count_I);
    if (count_I < 9) return;
    
    int* isGreen = safe_malloc(sizeof(int) * count_I, "isGreen");
    for (int i = 0; i < count_I; i++) {
        isGreen[i] = (candles_I[i].close >= candles_I[i].open) ? 1 : 0;
    }
    
    for (int j = 8; j < count_I; j++) {
        // 3-candle
        int g3 = isGreen[j-2] + isGreen[j-1] + isGreen[j];
        int val3 = (g3 >= 2) ? 1 : -1;
        
        // 6-candle
        int g6 = isGreen[j-5] + isGreen[j-4] + isGreen[j-3] + isGreen[j-2] + isGreen[j-1] + isGreen[j];
        int r6 = 6 - g6;
        int val6 = (g6 >= 4) ? 1 : ((r6 >= 4) ? -1 : 0);
        
        // 9-candle
        int g9 = 0;
        for (int k = j-8; k <= j; k++) {
            g9 += isGreen[k];
        }
        int r9 = 9 - g9;
        int val9 = (g9 >= 6) ? 1 : ((r9 >= 6) ? -1 : 0);
        
        int greens = (val3 == 1 ? 1 : 0) + (val6 == 1 ? 1 : 0) + (val9 == 1 ? 1 : 0);
        int reds = (val3 == -1 ? 1 : 0) + (val6 == -1 ? 1 : 0) + (val9 == -1 ? 1 : 0);
        
        if (greens >= 2) {
            signals[j] = 1;
        } else if (reds >= 2) {
            signals[j] = -1;
        }
    }
    free(isGreen);
}

// Berechnet fuer jeden RuleSet einmalig das long/short-Trigger-Signal ueber
// alle 1m-Kerzen. Ersetzt die pro-Backtest-Neuberechnung im Hot-Path.
void precompute_rule_signals(int count1m, int* const* htf_signals) {
    for (int r = 0; r < rule_sets_count; r++) {
        const RuleSet* rs = &rule_sets[r];
        const int longCount = rs->longRulesCount;
        const int shortCount = rs->shortRulesCount;
        unsigned char* sig = safe_malloc(sizeof(unsigned char) * count1m, "rule_side_signal[r]");

        for (int i = 0; i < count1m; i++) {
            int triggerLong = 1;
            for (int k = 0; k < longCount; k++) {
                int tf = rs->longRules[k].interval_idx;
                int ptr = htf_ptr_cache[tf][i];
                int signal = (ptr >= 0) ? htf_signals[tf][ptr] : 0;
                if (signal != rs->longRules[k].expected_signal) { triggerLong = 0; break; }
            }
            int triggerShort = 1;
            for (int k = 0; k < shortCount; k++) {
                int tf = rs->shortRules[k].interval_idx;
                int ptr = htf_ptr_cache[tf][i];
                int signal = (ptr >= 0) ? htf_signals[tf][ptr] : 0;
                if (signal != rs->shortRules[k].expected_signal) { triggerShort = 0; break; }
            }

            if (triggerLong && !triggerShort) sig[i] = 1;
            else if (triggerShort && !triggerLong) sig[i] = 2;
            else sig[i] = 0;
        }
        rule_side_signal[r] = sig;
        
        // Sprungtabelle rueckwaerts befuellen: next_sig[count1m] = count1m (Sentinel)
        int* next_sig = safe_malloc(sizeof(int) * (count1m + 1), "rule_next_signal[r]");
        next_sig[count1m] = count1m;
        for (int i = count1m - 1; i >= 0; i--) {
            next_sig[i] = (sig[i] != 0) ? i : next_sig[i + 1];
        }
        rule_next_signal[r] = next_sig;
    }
}

// Berechnet TP- und SL-Preis in einem Aufruf. Vorher wurden get_tp_price()
// und get_sl_price() unabhaengig voneinander aufgerufen und haben dabei
// jeweils qtyInBtc und entryFeeSats redundant neu berechnet (2x Division +
// 2x Multiplikation zu viel pro Trade-Entry). Jetzt einmalig gemeinsam
// berechnet und an beide Zweige verteilt.
static inline void get_tp_sl_prices(
    int side, double qtyUsd, double invEntryPrice, double tpSats, double slSats,
    double feeRate, double* out_tpPrice, double* out_slPrice
) {
    const double qtyInBtc = (qtyUsd * invEntryPrice) * SATS_PER_BTC;
    const double entryFeeSats = qtyInBtc * feeRate;
    const double base = qtyInBtc - entryFeeSats;

    if (side == 0) { // long
        const double num = qtyUsd * (1.0 + feeRate) * SATS_PER_BTC;
        double A_tp = base - tpSats;
        *out_tpPrice = (A_tp > 0) ? num / A_tp : 0.0;
        double A_sl = base + slSats;
        *out_slPrice = (A_sl > 0) ? num / A_sl : 0.0;
    } else { // short
        const double num = qtyUsd * (1.0 - feeRate) * SATS_PER_BTC;
        double B_tp = tpSats + qtyInBtc + entryFeeSats;
        *out_tpPrice = (B_tp > 0) ? num / B_tp : 0.0;
        double B_sl = -slSats + qtyInBtc + entryFeeSats;
        *out_slPrice = (B_sl > 0) ? num / B_sl : 0.0;
    }
}

static inline int find_idx_int(int val, const int* arr, int count) {
    for (int i = 0; i < count; i++) {
        if (arr[i] == val) return i;
    }
    return 0;
}

static inline int find_idx_double(double val, const double* arr, int count) {
    for (int i = 0; i < count; i++) {
        if (fabs(arr[i] - val) < 0.0001) return i;
    }
    return 0;
}

double wilson_lower_bound(double p, int n, double z) {
    if (n <= 0) return 0;
    double denom = 1.0 + (z * z) / n;
    double centre = p + (z * z) / (2.0 * n);
    double adj = z * sqrt((p * (1.0 - p)) / n + (z * z) / (4.0 * n * n));
    double val = (centre - adj) / denom;
    return val < 0 ? 0 : val;
}

double calculate_concentration_score(double maxWin, double grossProfit, int totalTrades) {
    if (totalTrades == 0) return 100.0;
    if (grossProfit <= 0) return 100.0;
    double concentration = maxWin / grossProfit;
    double diff = concentration - 0.3;
    if (diff < 0) diff = 0;
    double score = 100.0 - diff * 140.0;
    if (score < 0) score = 0.0;
    if (score > 100.0) score = 100.0;
    return score;
}

double calculate_score(const BacktestResult* res) {
    double profitScore = res->totalReturnPercent * 2.0;
    if (profitScore < 0) profitScore = 0;
    if (profitScore > 100) profitScore = 100;
    
    double pfScore = (res->profitFactor - 1.0) * 50.0;
    if (pfScore < 0) pfScore = 0;
    if (pfScore > 100) pfScore = 100;

    if (res->totalTrades < 30) {
        double confidence = res->totalTrades / 30.0;
        pfScore *= confidence;
    }
    
    double ddScore = 100.0 - (res->maxDrawdownPercent * 3.33);
    if (ddScore < 0) ddScore = 0;
    
    double winrateScore = wilson_lower_bound(res->winRatePercent / 100.0, res->totalTrades, 1.645) * 100.0;
    
    double sortinoScore = res->sortinoRatio * 15.0;
    if (sortinoScore < 0) sortinoScore = 0;
    if (sortinoScore > 100) sortinoScore = 100;

    double calmarScore = res->calmarRatio * 10.0;
    if (calmarScore < 0) calmarScore = 0;
    if (calmarScore > 100) calmarScore = 100;
    
    double tradeCountScore = 100.0;
    if (res->totalTrades == 0) tradeCountScore = 0;
    else if (res->totalTrades < 5) tradeCountScore = 30;
    else if (res->totalTrades < 10) tradeCountScore = 70;
    else if (res->totalTrades > 120) tradeCountScore = 60;
    
    double concentrationScore = calculate_concentration_score(res->maxWin, res->grossProfit, res->totalTrades);
    
    double score = (profitScore * 0.25) + (pfScore * 0.15) + (ddScore * 0.15) + (winrateScore * 0.10) +
                   (sortinoScore * 0.10) + (calmarScore * 0.05) + (tradeCountScore * 0.10) + (concentrationScore * 0.10);
    
    // WFE Penalty: If Out-of-Sample performance collapses (WFE < 30%), apply 30% penalty for overfitting
    if (res->wfeScore < 30.0 && res->totalTrades >= 10) {
        score *= 0.70;
    }

    return round(score * 10.0) / 10.0;
}

BacktestResult run_backtest(
    const HLC* restrict hlc, int count1m,
    double startBalanceSats, double qtyUsd, double leverage,
    int cooldownMin, int maxOpen, double tpPercent, double slPercent,
    double feeRate, double spread,
    const unsigned char* restrict sideSignal,
    const int* restrict nextSignal
) {
    double balance = startBalanceSats;
    double maxEquity = balance;
    double maxDrawdown = 0.0;

    double downside_sq_sum = 0.0;
    int loss_trades_count = 0;
    int is_cutoff_idx = (int)(count1m * 0.70);
    double balance_at_is = startBalanceSats;
    
    // Precompute constants (avoids repeated division/multiplication in hot loop)
    const double fee_x_SATS = feeRate * SATS_PER_BTC;
    const double one_plus_fee = 1.0 + feeRate;
    const double one_minus_fee = 1.0 - feeRate;
    const double inv_leverage = 1.0 / leverage;
    
    // Early termination threshold: cheapest possible trade cost
    // Use first candle close as price estimate (conservative: actual entry may be cheaper)
    double estMaxPrice = hlc[count1m > 0 ? 0 : 0].close * 2.0;
    double minMarginSats = (qtyUsd / estMaxPrice / leverage) * SATS_PER_BTC;
    double minEntryFee = (qtyUsd / estMaxPrice) * fee_x_SATS;
    double minTradeCost = minMarginSats + minEntryFee;
    
    // Array to track multiple active trades
    ActiveTrade activeTrades[100];
    int activeTradesCount = 0;
    
    int lastCloseIndex = -cooldownMin;
    double totalFeesSats = 0.0;
    
    int totalTrades = 0;
    int winTrades = 0;
    int longTrades = 0;
    int shortTrades = 0;
    double grossProfit = 0.0;
    double grossLoss = 0.0;
    double maxWin = 0.0;
    double sumTradeReturnPercent = 0.0;
    int currentLosingStreak = 0;
    int maxLosingStreak = 0;
    
    int i = 0;
    while (i < count1m) {
        // --- Skip-Ahead: ohne offene Position aendert sich bis zum naechsten
        // handelbaren Signal weder Balance noch Equity/Drawdown noch Cooldown.
        // Direkt zur naechsten moeglichen Einstiegskerze springen statt jede
        // Leerlaufkerze einzeln zu durchlaufen (aequivalent zum Original).
        if (activeTradesCount == 0) {
            if (balance < minTradeCost) break;
            int earliestAllowed = lastCloseIndex + cooldownMin;
            int startFrom = (i > earliestAllowed) ? i : earliestAllowed;
            if (startFrom >= count1m) break;
            int nextSig = nextSignal[startFrom];
            if (nextSig >= count1m) break;
            i = nextSig;
        } else if ((i & 15) == 0 && (i + 16 < count1m) && g_hlc_blocks) {
            int blockIdx = i >> 4;
            double b_low = g_hlc_blocks[blockIdx].min_low;
            double b_high = g_hlc_blocks[blockIdx].max_high;

            int canSkip = 1;
            for (int t = 0; t < activeTradesCount; t++) {
                const ActiveTrade* curr = &activeTrades[t];
                if (curr->side == 0) { // long
                    if (b_low <= curr->liqPrice || (curr->slPrice > 0 && b_low <= curr->slPrice) || (curr->tpPrice > 0 && b_high >= curr->tpPrice)) {
                        canSkip = 0;
                        break;
                    }
                } else { // short
                    if ((curr->liqPrice > 0 && b_high >= curr->liqPrice) || (curr->slPrice > 0 && b_high >= curr->slPrice) || (curr->tpPrice > 0 && b_low <= curr->tpPrice)) {
                        canSkip = 0;
                        break;
                    }
                }
            }

            if (canSkip) {
                i += 16;
                continue;
            }
        }
        
        const HLC hc = hlc[i];
        const double c_high = hc.high;
        const double c_low = hc.low;
        const double c_close = hc.close;
        
        // --- Check active trade exit (in-place Kompaktierung statt Kopie in Zweitarray) ---
        int closedAny = 0;
        int w = 0;
        
        for (int t = 0; t < activeTradesCount; t++) {
            const ActiveTrade* curr = &activeTrades[t];
            double exitPrice = 0.0;
            int exitReason = 0; // 0=none, 1=liq, 2=sl, 3=tp, 4=end
            
            if (curr->side == 0) { // long
                if (c_low <= curr->liqPrice) {
                    exitPrice = curr->liqPrice;
                    exitReason = 1;
                } else if (curr->slPrice > 0 && c_low <= curr->slPrice) {
                    exitPrice = curr->slPrice;
                    exitReason = 2;
                } else if (curr->tpPrice > 0 && c_high >= curr->tpPrice) {
                    exitPrice = curr->tpPrice;
                    exitReason = 3;
                }
            } else { // short
                if (curr->liqPrice > 0 && c_high >= curr->liqPrice) {
                    exitPrice = curr->liqPrice;
                    exitReason = 1;
                } else if (curr->slPrice > 0 && c_high >= curr->slPrice) {
                    exitPrice = curr->slPrice;
                    exitReason = 2;
                } else if (curr->tpPrice > 0 && c_low <= curr->tpPrice) {
                    exitPrice = curr->tpPrice;
                    exitReason = 3;
                }
            }
            
            if (i == count1m - 1 && exitReason == 0) {
                exitPrice = c_close;
                exitReason = 4;
            }
            
            if (exitReason != 0) {
                closedAny = 1;
                double pnlSats = 0.0;
                double exitFeeSats = 0.0;
                
                if (exitReason == 1) { // liquidation
                    pnlSats = -curr->marginSats;
                    exitFeeSats = 0.0;
                } else {
                    double inv_entry = curr->invEntryPrice;
                    double inv_exit = 1.0 / exitPrice;
                    if (curr->side == 0) { // long
                        pnlSats = curr->qtyUsd * (inv_entry - inv_exit) * SATS_PER_BTC;
                    } else { // short
                        pnlSats = curr->qtyUsd * (inv_exit - inv_entry) * SATS_PER_BTC;
                    }
                    exitFeeSats = (curr->qtyUsd * inv_exit) * fee_x_SATS;
                    balance += curr->marginSats + pnlSats - exitFeeSats;
                }
                
                totalFeesSats += (curr->entryFeeSats + exitFeeSats);
                
                double netPnlSats = pnlSats - curr->entryFeeSats - exitFeeSats;
                totalTrades++;
                double tradeReturnPct = (netPnlSats / curr->marginSats) * 100.0;
                sumTradeReturnPercent += tradeReturnPct;

                if (netPnlSats > 0) {
                    winTrades++;
                    grossProfit += netPnlSats;
                    if (netPnlSats > maxWin) maxWin = netPnlSats;
                    currentLosingStreak = 0;
                } else {
                    grossLoss -= netPnlSats; // fabs via negation
                    currentLosingStreak++;
                    if (currentLosingStreak > maxLosingStreak) {
                        maxLosingStreak = currentLosingStreak;
                    }
                    downside_sq_sum += (tradeReturnPct * tradeReturnPct);
                    loss_trades_count++;
                }
                
                if (curr->side == 0) longTrades++;
                else shortTrades++;
            } else {
                if (w != t) activeTrades[w] = *curr;
                w++;
            }
        }
        activeTradesCount = w;
        
        if (closedAny) {
            lastCloseIndex = i;
        }

        // Track In-Sample cutoff balance (at 70% of dataset) for WFE calculation
        if (i == is_cutoff_idx) {
            balance_at_is = balance;
        }
        
        // --- Enter new trade ---
        int canTrade = (i >= lastCloseIndex + cooldownMin) && (activeTradesCount < maxOpen);
        
        if (canTrade) {
            // Signal ist bereits vorab pro RuleSet berechnet (precompute_rule_signals):
            // 0=keins, 1=long, 2=short. Kein htf_pointers-Gather, kein Regelvergleich mehr im Hot-Path.
            unsigned char sig = sideSignal[i];
            
            if (sig != 0) {
                int side = sig - 1; // 1 -> 0 (long), 2 -> 1 (short)
                double entryPrice = (side == 0) ? c_close * (1.0 + spread) : c_close * (1.0 - spread);
                double inv_entry = 1.0 / entryPrice;
                double marginSats = (qtyUsd * inv_entry * inv_leverage) * SATS_PER_BTC;
                double entryFeeSats = (qtyUsd * inv_entry) * fee_x_SATS;
                
                if (balance >= marginSats + entryFeeSats) {
                    balance -= (marginSats + entryFeeSats);
                    
                    double tpSats = marginSats * (tpPercent / 100.0);
                    double slSats = marginSats * (slPercent / 100.0);
                    
                    double tpPrice, slPrice;
                    get_tp_sl_prices(side, qtyUsd, inv_entry, tpSats, slSats, feeRate, &tpPrice, &slPrice);
                    
                    double liqPrice = 0.0;
                    if (side == 0) {
                        liqPrice = entryPrice * (leverage / (leverage + 1.0)) * one_plus_fee;
                    } else {
                        if (leverage > 1.0) {
                            liqPrice = entryPrice * (leverage / (leverage - 1.0)) * one_minus_fee;
                        }
                    }
                    
                    ActiveTrade newTrade;
                    newTrade.side = side;
                    newTrade.entryPrice = entryPrice;
                    newTrade.invEntryPrice = inv_entry;
                    newTrade.marginSats = marginSats;
                    newTrade.entryFeeSats = entryFeeSats;
                    newTrade.tpPrice = tpPrice;
                    newTrade.slPrice = slPrice;
                    newTrade.liqPrice = liqPrice;
                    newTrade.qtyUsd = qtyUsd;
                    
                    activeTrades[activeTradesCount++] = newTrade;
                }
            }
        }
        
        // --- Equity / drawdown (only when trade is open) ---
        if (activeTradesCount > 0) {
            double totalMargin = 0.0;
            double totalUpnl = 0.0;
            double totalEstExitFee = 0.0;
            double inv_close = 1.0 / c_close;
            for (int t = 0; t < activeTradesCount; t++) {
                const ActiveTrade* curr = &activeTrades[t];
                double upnl;
                if (curr->side == 0) {
                    upnl = curr->qtyUsd * (1.0 / curr->entryPrice - inv_close) * SATS_PER_BTC;
                } else {
                    upnl = curr->qtyUsd * (inv_close - 1.0 / curr->entryPrice) * SATS_PER_BTC;
                }
                totalMargin += curr->marginSats;
                totalUpnl += upnl;
                totalEstExitFee += (curr->qtyUsd * inv_close) * fee_x_SATS;
            }
            double currentEquity = balance + totalMargin + totalUpnl - totalEstExitFee;
            if (currentEquity > maxEquity) {
                maxEquity = currentEquity;
            }
            double drawdown = ((maxEquity - currentEquity) / maxEquity) * 100.0;
            if (drawdown > maxDrawdown) {
                maxDrawdown = drawdown;
            }
        } else if (balance < minTradeCost) {
            // No active trade and balance depleted: can never open another trade
            break;
        }
        
        i++;
    }
    
    BacktestResult res;
    res.finalBalanceSats = balance;
    res.totalReturnPercent = ((balance - startBalanceSats) / startBalanceSats) * 100.0;
    res.maxDrawdownPercent = maxDrawdown;
    res.profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999.0 : 0.0);
    res.winRatePercent = totalTrades > 0 ? ((double)winTrades * 100.0) / totalTrades : 0.0;
    res.totalTrades = totalTrades;
    res.totalFeesSats = totalFeesSats;
    res.longTrades = longTrades;
    res.shortTrades = shortTrades;
    res.maxLosingStreak = maxLosingStreak;
    res.avgTradePercent = totalTrades > 0 ? sumTradeReturnPercent / totalTrades : 0.0;
    res.grossProfit = grossProfit;
    res.maxWin = maxWin;

    // Downside Risk & Sortino Ratio
    double downsideDev = loss_trades_count > 0 ? sqrt(downside_sq_sum / loss_trades_count) : 0.0;
    res.sortinoRatio = downsideDev > 0.0 ? (res.totalReturnPercent / downsideDev) : (res.totalReturnPercent > 0.0 ? 10.0 : 0.0);

    // Calmar Ratio
    res.calmarRatio = res.maxDrawdownPercent > 0.0 ? (res.totalReturnPercent / res.maxDrawdownPercent) : (res.totalReturnPercent > 0.0 ? 10.0 : 0.0);

    // Walk-Forward Efficiency (WFE)
    double isReturnPercent = ((balance_at_is - startBalanceSats) / startBalanceSats) * 100.0;
    double oosReturnPercent = ((balance - balance_at_is) / balance_at_is) * 100.0;
    double wfe = (isReturnPercent > 0.0) ? (oosReturnPercent / isReturnPercent) * 100.0 : (oosReturnPercent > 0.0 ? 100.0 : 0.0);
    if (wfe < 0.0) wfe = 0.0;
    res.wfeScore = wfe;
    
    return res;
}

int compare_strategy_eval(const void* a, const void* b) {
    double scoreA = ((StrategyEvaluation*)a)->score;
    double scoreB = ((StrategyEvaluation*)b)->score;
    if (scoreB > scoreA) return 1;
    if (scoreB < scoreA) return -1;
    return 0;
}

// Min-Heap ueber .score, Groesse `size`, Wurzel (Index 0) = kleinstes Element.
// Wird pro Thread genutzt, um nur die TOP_K_RESULTS besten Ergebnisse im
// Speicher zu halten, waehrend trotzdem alle 207 Mio. Kombinationen
// durchgerechnet werden (kein Datenverlust bei der Suche selbst, nur bei
// den nicht mehr benoetigten Zwischenergebnissen).
static void heap_sift_down(StrategyEvaluation* heap, int size, int i) {
    while (1) {
        int left = 2 * i + 1;
        int right = 2 * i + 2;
        int smallest = i;
        if (left < size && heap[left].score < heap[smallest].score) smallest = left;
        if (right < size && heap[right].score < heap[smallest].score) smallest = right;
        if (smallest == i) break;
        StrategyEvaluation tmp = heap[i];
        heap[i] = heap[smallest];
        heap[smallest] = tmp;
        i = smallest;
    }
}

Candle* load_candles_csv(const char* filepath, int* out_count) {
    FILE* f = fopen(filepath, "r");
    if (!f) {
        perror("Failed to open candles file");
        return NULL;
    }
    
    char line[256];
    if (!fgets(line, sizeof(line), f)) {
        fclose(f);
        return NULL;
    }
    
    int capacity = 10000;
    int count = 0;
    Candle* candles = safe_malloc(sizeof(Candle) * capacity, "candles");
    
    while (fgets(line, sizeof(line), f)) {
        if (count >= capacity) {
            capacity *= 2;
            candles = safe_realloc(candles, sizeof(Candle) * capacity, "candles (realloc)");
        }
        
        long long t;
        double o, h, l, c, v;
        if (sscanf(line, "%lld,%lf,%lf,%lf,%lf,%lf", &t, &o, &h, &l, &c, &v) == 6) {
            candles[count].time = t;
            candles[count].open = o;
            candles[count].high = h;
            candles[count].low = l;
            candles[count].close = c;
            candles[count].volume = v;
            count++;
        }
    }
    fclose(f);
    *out_count = count;
    return candles;
}

void write_strategies_json(const char* filepath, const StrategyEvaluation* evals, int count, const RuleSet* r_sets, const char* market) {
    FILE* f = fopen(filepath, "w");
    if (!f) {
        perror("Failed to open output file");
        return;
    }
    
    fprintf(f, "[\n");
    for (int i = 0; i < count; i++) {
        const StrategyEvaluation* ev = &evals[i];
        const RuleSet* rs = &r_sets[ev->params.ruleIndex];
        
        fprintf(f, "  {\n");
        fprintf(f, "    \"market\": \"%s\",\n", market);
        fprintf(f, "    \"timeframe\": \"1m\",\n");
        fprintf(f, "    \"params\": {\n");
        fprintf(f, "      \"leverage\": %d,\n", ev->params.leverage);
        fprintf(f, "      \"cooldownMin\": %d,\n", ev->params.cooldownMin);
        fprintf(f, "      \"tpPercent\": %.2f,\n", ev->params.tpPercent);
        fprintf(f, "      \"slPercent\": %.2f,\n", ev->params.slPercent);
        fprintf(f, "      \"maxOpen\": %d,\n", ev->params.maxOpen);
        fprintf(f, "      \"rules\": {\n");
        
        // Print Long rules
        fprintf(f, "        \"long\": [\n");
        for (int r = 0; r < rs->longRulesCount; r++) {
            const char* iv_str = g_interval_names[rs->longRules[r].interval_idx];
            const char* state_str = (rs->longRules[r].expected_signal == 1) ? "bull" : "bear";
            fprintf(f, "          {\"interval\": \"%s\", \"state\": \"%s\"}%s\n", iv_str, state_str, (r == rs->longRulesCount - 1) ? "" : ",");
        }
        fprintf(f, "        ],\n");
        
        // Print Short rules
        fprintf(f, "        \"short\": [\n");
        for (int r = 0; r < rs->shortRulesCount; r++) {
            const char* iv_str = g_interval_names[rs->shortRules[r].interval_idx];
            const char* state_str = (rs->shortRules[r].expected_signal == 1) ? "bull" : "bear";
            fprintf(f, "          {\"interval\": \"%s\", \"state\": \"%s\"}%s\n", iv_str, state_str, (r == rs->shortRulesCount - 1) ? "" : ",");
        }
        fprintf(f, "        ]\n");
        fprintf(f, "      }\n");
        fprintf(f, "    },\n");
        
        // Results
        fprintf(f, "    \"results\": {\n");
        fprintf(f, "      \"totalReturnPercent\": %.4f,\n", ev->results.totalReturnPercent);
        fprintf(f, "      \"winRatePercent\": %.4f,\n", ev->results.winRatePercent);
        fprintf(f, "      \"maxDrawdownPercent\": %.4f,\n", ev->results.maxDrawdownPercent);
        fprintf(f, "      \"profitFactor\": %.4f,\n", ev->results.profitFactor);
        fprintf(f, "      \"totalTrades\": %d,\n", ev->results.totalTrades);
        fprintf(f, "      \"avgTradePercent\": %.4f,\n", ev->results.avgTradePercent);
        fprintf(f, "      \"maxLosingStreak\": %d,\n", (int)ev->results.maxLosingStreak);
        fprintf(f, "      \"longTrades\": %d,\n", ev->results.longTrades);
        fprintf(f, "      \"shortTrades\": %d,\n", ev->results.shortTrades);
        fprintf(f, "      \"sortinoRatio\": %.4f,\n", ev->results.sortinoRatio);
        fprintf(f, "      \"calmarRatio\": %.4f,\n", ev->results.calmarRatio);
        fprintf(f, "      \"wfeScore\": %.2f\n", ev->results.wfeScore);
        fprintf(f, "    },\n");
        
        // Counts
        fprintf(f, "    \"counts\": {\n");
        fprintf(f, "      \"count369Long\": 0,\n");
        fprintf(f, "      \"count369Short\": 0\n");
        fprintf(f, "    },\n");
        
        // Validation
        fprintf(f, "    \"validation\": {\n");
        fprintf(f, "      \"trainScore\": %.2f,\n", ev->score);
        fprintf(f, "      \"testScore\": null,\n");
        fprintf(f, "      \"validated\": false,\n");
        fprintf(f, "      \"stabilityScore\": null,\n");
        fprintf(f, "      \"crossPhaseScore\": null,\n");
        fprintf(f, "      \"crossPhaseDetails\": null\n");
        fprintf(f, "    },\n");
        
        // MarketClass
        fprintf(f, "    \"marketClass\": {\n");
        fprintf(f, "      \"regime\": \"sideways\",\n");
        fprintf(f, "      \"volatility\": \"low\",\n");
        fprintf(f, "      \"avgVolume\": 1000\n");
        fprintf(f, "    },\n");
        
        fprintf(f, "    \"rawScore\": %.2f,\n", ev->score);
        fprintf(f, "    \"score\": %.2f\n", ev->score);
        
        fprintf(f, "  }%s\n", (i == count - 1) ? "" : ",");
    }
    fprintf(f, "]\n");
    fclose(f);
}

typedef struct {
    unsigned long long key;
    StrategyParams params;
} CandidateCombo;

int compare_candidate_combo(const void* a, const void* b) {
    unsigned long long keyA = ((CandidateCombo*)a)->key;
    unsigned long long keyB = ((CandidateCombo*)b)->key;
    if (keyA > keyB) return 1;
    if (keyA < keyB) return -1;
    return 0;
}

unsigned long long encode_params(const StrategyParams* p) {
    int tp = (int)(p->tpPercent * 10.0 + 0.5);
    int sl = (int)(p->slPercent * 10.0 + 0.5);
    unsigned long long key = 0;
    key |= ((unsigned long long)p->ruleIndex & 0xF);
    key |= (((unsigned long long)p->leverage & 0x7F) << 4);
    key |= (((unsigned long long)p->cooldownMin & 0xFF) << 11);
    key |= (((unsigned long long)tp & 0x7FF) << 19);
    key |= (((unsigned long long)sl & 0x7FF) << 30);
    key |= (((unsigned long long)p->maxOpen & 0x7F) << 41);
    return key;
}

int main(int argc, char** argv) {
    if (argc < 3) {
        printf("Usage: %s <candles.csv> <output.json> [startBalanceSats] [qtyUsd] [feeRate] [spread] [market]\n", argv[0]);
        return 1;
    }
    
    const char* csv_path = argv[1];
    const char* output_path = argv[2];
    
    double startBalanceSats = 1000000.0;
    double qtyUsd = 25.0;
    double feeRate = 0.001;
    double spread = 0.0005;
    const char* market = "BTC";
    
    if (argc >= 4) startBalanceSats = atof(argv[3]);
    if (argc >= 5) qtyUsd = atof(argv[4]);
    if (argc >= 6) feeRate = atof(argv[5]);
    if (argc >= 7) spread = atof(argv[6]);
    if (argc >= 8) market = argv[7];
    
    printf("Config: startBalanceSats=%.1f, qtyUsd=%.1f, feeRate=%.4f, spread=%.4f\n", 
           startBalanceSats, qtyUsd, feeRate, spread);
    
    int count1m = 0;
    Candle* candles1m = load_candles_csv(csv_path, &count1m);
    if (!candles1m || count1m == 0) {
        fprintf(stderr, "No 1m candles loaded from %s\n", csv_path);
        return 1;
    }
    printf("Loaded %d 1m candles.\n", count1m);
    
    // Einmalig kompakte HLC-Kopie fuer den run_backtest()-Hot-Path anlegen
    g_hlc = safe_malloc(sizeof(HLC) * count1m, "g_hlc");
    for (int i = 0; i < count1m; i++) {
        g_hlc[i].high = candles1m[i].high;
        g_hlc[i].low = candles1m[i].low;
        g_hlc[i].close = candles1m[i].close;
    }

    int g_hlc_blocks_count = (count1m + 15) / 16;
    g_hlc_blocks = safe_malloc(sizeof(HLCBlock16) * g_hlc_blocks_count, "g_hlc_blocks");
    for (int b = 0; b < g_hlc_blocks_count; b++) {
        double min_l = 1e18;
        double max_h = -1e18;
        int start = b * 16;
        int end = start + 16;
        if (end > count1m) end = count1m;
        for (int i = start; i < end; i++) {
            if (g_hlc[i].low < min_l) min_l = g_hlc[i].low;
            if (g_hlc[i].high > max_h) max_h = g_hlc[i].high;
        }
        g_hlc_blocks[b].min_low = min_l;
        g_hlc_blocks[b].max_high = max_h;
    }
    
    // Precompute HTF candles and signals
    // Muss zu g_interval_names / htf_durations passen: 1m,3m,5m,15m,30m,1h,2h,4h,6h,12h
    int interval_mins[10] = {1, 3, 5, 15, 30, 60, 120, 240, 360, 720};
    for (int i = 0; i < 10; i++) {
        int max_htf_len = count1m / interval_mins[i] + 1;
        htf_candles[i] = safe_malloc(sizeof(Candle) * max_htf_len, "htf_candles[i]");
        htf_counts[i] = aggregate_candles(candles1m, count1m, interval_mins[i], htf_candles[i]);
        
        htf_signals[i] = safe_malloc(sizeof(int) * htf_counts[i], "htf_signals[i]");
        precalculate_pattern_signals(htf_candles[i], htf_counts[i], htf_signals[i]);
        
        printf("Interval %d (%d mins): aggregated to %d candles.\n", i, interval_mins[i], htf_counts[i]);
    }
    
    // Precompute HTF pointer cache (done once, avoids per-backtest while-loops)
    for (int tf = 0; tf < 10; tf++) {
        htf_ptr_cache[tf] = safe_malloc(sizeof(int) * count1m, "htf_ptr_cache[tf]");
        int ptr = -1;
        for (int i = 0; i < count1m; i++) {
            while (ptr + 1 < htf_counts[tf] && htf_candles[tf][ptr + 1].time + htf_durations[tf] <= candles1m[i].time) {
                ptr++;
            }
            htf_ptr_cache[tf][i] = ptr;
        }
    }
    printf("Precomputed HTF pointer cache.\n");
    
    // candles1m wird ab hier nirgends mehr gelesen (run_backtest nutzt nur
    // noch g_hlc). Sofort freigeben statt es die ganze - potenziell
    // stundenlange - Grid-Search ueber ungenutzt im Speicher mitzuschleifen.
    // Sonst haette man 72 statt 48 Bytes/Kerze aktiv im Speicher (48 tot +
    // 24 genutzt) - mehr Working-Set als im Original, nicht weniger.
    free(candles1m);
    candles1m = NULL;
    
    generate_rule_sets();
    
    precompute_rule_signals(count1m, htf_signals);
    printf("Precomputed rule signals fuer %d RuleSets.\n", rule_sets_count);
    
    int leverages[] = {5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20};
    int leverages_count = 16;
    
    int cooldowns[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30};
    int cooldowns_count = 15;
    
    double tps[] = {5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 35.0, 40.0, 45.0, 50.0, 55.0, 60.0, 65.0, 70.0, 75.0};
    int tps_count = 15;
    
    double sls[] = {5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 35.0, 40.0, 45.0, 50.0};
    int sls_count = 10;
    
    int max_opens[] = {1, 2, 3, 4, 5, 6};
    int max_opens_count = 6;
    
    int total_combos = rule_sets_count * leverages_count * cooldowns_count 
                      * tps_count * sls_count * max_opens_count;
                      
    printf("Starting Exhaustive Grid Search on %d combinations using OpenMP multi-threading...\n", total_combos);
    
    // Option 1 (laufendes Top-K): statt ALLER total_combos Ergebnisse im
    // RAM zu halten (bei 207 Mio. Kombinationen ~30+ GB), haelt jeder Thread
    // nur einen Min-Heap seiner TOP_K_RESULTS besten Ergebnisse. Alle
    // Kombinationen werden weiterhin vollstaendig durchgerechnet -- es
    // aendert sich nur, was danach im Speicher bleibt.
    const int TOP_K_RESULTS = 500;
    int max_threads = omp_get_max_threads();
    StrategyEvaluation** thread_tops = safe_malloc(sizeof(StrategyEvaluation*) * max_threads, "thread_tops");
    int* thread_top_counts = safe_malloc(sizeof(int) * max_threads, "thread_top_counts");
    for (int t = 0; t < max_threads; t++) {
        thread_tops[t] = safe_malloc(sizeof(StrategyEvaluation) * TOP_K_RESULTS, "thread_tops[t]");
        thread_top_counts[t] = 0;
    }
    
    double start_time = omp_get_wtime();
    int progress_counter = 0;
    int progress_step = total_combos / 100;
    if (progress_step < 100) progress_step = 100;
    const int PROGRESS_BATCH = 256;
    
    #pragma omp parallel
    {
        int tid = omp_get_thread_num();
        StrategyEvaluation* local_top = thread_tops[tid];
        int local_count = 0;
        int local_progress = 0;
        
        #pragma omp for collapse(6) schedule(dynamic, 64)
        for (int r = 0; r < rule_sets_count; r++) {
            for (int l = 0; l < leverages_count; l++) {
                for (int cd = 0; cd < cooldowns_count; cd++) {
                    for (int tp = 0; tp < tps_count; tp++) {
                        for (int sl = 0; sl < sls_count; sl++) {
                            for (int mo = 0; mo < max_opens_count; mo++) {
                                StrategyParams params;
                                params.leverage = leverages[l];
                                params.cooldownMin = cooldowns[cd];
                                params.tpPercent = tps[tp];
                                params.slPercent = sls[sl];
                                params.maxOpen = max_opens[mo];
                                params.ruleIndex = r;
                                
                                BacktestResult res = run_backtest(
                                    g_hlc, count1m,
                                    startBalanceSats,
                                    qtyUsd,
                                    params.leverage,
                                    params.cooldownMin,
                                    params.maxOpen,
                                    params.tpPercent,
                                    params.slPercent,
                                    feeRate,
                                    spread,
                                    rule_side_signal[r],
                                    rule_next_signal[r]
                                );
                                
                                StrategyEvaluation ev;
                                ev.params = params;
                                ev.results = res;
                                ev.score = calculate_score(&res);
                                
                                // Laufendes Top-K per Min-Heap: solange der
                                // lokale Puffer noch nicht voll ist, einfach
                                // anhaengen; danach nur ersetzen, wenn besser
                                // als das aktuell schlechteste Element (Wurzel).
                                if (local_count < TOP_K_RESULTS) {
                                    local_top[local_count] = ev;
                                    local_count++;
                                    if (local_count == TOP_K_RESULTS) {
                                        for (int hi = TOP_K_RESULTS / 2 - 1; hi >= 0; hi--) {
                                            heap_sift_down(local_top, TOP_K_RESULTS, hi);
                                        }
                                    }
                                } else if (ev.score > local_top[0].score) {
                                    local_top[0] = ev;
                                    heap_sift_down(local_top, TOP_K_RESULTS, 0);
                                }
                                
                                local_progress++;
                                if (local_progress >= PROGRESS_BATCH) {
                                    int gc;
                                    #pragma omp atomic capture
                                    gc = progress_counter += local_progress;
                                    int prevGc = gc - local_progress;
                                    local_progress = 0;
                                    if (gc / progress_step != prevGc / progress_step || gc >= total_combos) {
                                        printf("PROGRESS: %.1f%%\n", (double)gc * 100.0 / total_combos);
                                        fflush(stdout);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        
        if (local_progress > 0) {
            int gc;
            #pragma omp atomic capture
            gc = progress_counter += local_progress;
            if (gc >= total_combos) {
                printf("PROGRESS: %.1f%%\n", (double)gc * 100.0 / total_combos);
                fflush(stdout);
            }
        }
        
        thread_top_counts[tid] = local_count;
    }
    
    printf("Finished Grid Search in %.3f seconds. Merging per-thread Top-%d results...\n", omp_get_wtime() - start_time, TOP_K_RESULTS);
    
    // Alle Thread-lokalen Top-K-Puffer zusammenfuehren (max_threads * TOP_K_RESULTS
    // Elemente, z.B. 16 * 500 = 8000 -- trivial klein) und final sortieren.
    int merged_count = 0;
    for (int t = 0; t < max_threads; t++) merged_count += thread_top_counts[t];
    
    StrategyEvaluation* merged_top = safe_malloc(sizeof(StrategyEvaluation) * merged_count, "merged_top");
    int offset = 0;
    for (int t = 0; t < max_threads; t++) {
        memcpy(merged_top + offset, thread_tops[t], sizeof(StrategyEvaluation) * thread_top_counts[t]);
        offset += thread_top_counts[t];
    }
    
    qsort(merged_top, merged_count, sizeof(StrategyEvaluation), compare_strategy_eval);
    
    int output_count = (merged_count < TOP_K_RESULTS) ? merged_count : TOP_K_RESULTS;
    printf("Writing top %d strategies to %s...\n", output_count, output_path);
    write_strategies_json(output_path, merged_top, output_count, rule_sets, market);
    
    // Cleanup
    free(merged_top);
    for (int t = 0; t < max_threads; t++) free(thread_tops[t]);
    free(thread_tops);
    free(thread_top_counts);
    for (int i = 0; i < 10; i++) {
        free(htf_candles[i]);
        free(htf_signals[i]);
        free(htf_ptr_cache[i]);
    }
    for (int r = 0; r < rule_sets_count; r++) {
        free(rule_side_signal[r]);
        free(rule_next_signal[r]);
    }
    free(g_hlc);
    printf("Done.\n");
    return 0;
}
