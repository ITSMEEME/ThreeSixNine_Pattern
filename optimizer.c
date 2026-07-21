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
    int interval_idx; // 0 to 4
    int expected_signal; // 1 (bull), -1 (bear)
} Rule;

typedef struct {
    Rule longRules[2];
    int longRulesCount;
    Rule shortRules[2];
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
RuleSet rule_sets[100];
int rule_sets_count = 0;

// Global pointers for HTF data (not modified, shared read-only across threads)
Candle* htf_candles[5];
int htf_counts[5];
int* htf_signals[5];
long long htf_durations[5] = { 60000LL, 300000LL, 900000LL, 3600000LL, 14400000LL };

// Precomputed HTF pointer cache: htf_ptr_cache[tf][candle_index] = correct pointer
// Eliminates the per-candle while-loop from hot path (computed once, read 2.1M times)
int* htf_ptr_cache[5];

// Kompakte Kerzen-Kopie fuer den run_backtest()-Hot-Path: NUR high/low/close
// (24 statt 48 Bytes wie beim vollen Candle-Struct), aber als EIN
// zusammenhaengendes Array (kein SoA!). Wichtig: bei getrennten Arrays
// (SoA) braeuchte jeder Skip-Ahead-Sprung 3 Cache-Misses in 3 verschiedenen
// Speicherbereichen statt 1 - bei einem Struct-Array bleiben alle drei
// Felder in derselben Cache-Line, genau wie beim urspruenglichen Candle,
// nur mit halbem Speicherbedarf.
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

// Precomputed Rule-Signal pro RuleSet und 1m-Kerze: 0=keins, 1=long, 2=short.
// Vorher wurde triggerLong/triggerShort (htf_pointers-Gather + Regelvergleich)
// in run_backtest() für JEDE Parameterkombination neu berechnet, obwohl das
// Signal nur vom ruleIndex abhaengt. Bei 50 RuleSets x 105000 Kombinationen/RuleSet
// war das eine ~100000-fache Redundanz. Jetzt: einmal pro RuleSet vorab berechnet.
unsigned char* rule_side_signal[100];

// Sprungtabelle pro RuleSet: rule_next_signal[r][i] = kleinster Index j>=i mit
// sig[j]!=0, sonst count1m. Erlaubt dem Backtest, Leerlauf-Strecken (keine
// offene Position, kein Signal) in O(1) zu ueberspringen statt Kerze fuer
// Kerze durchzulaufen. Aequivalent zum Original: waehrend activeTradesCount==0
// aendert sich weder Balance noch Equity/Drawdown noch Cooldown-Fenster, es
// wird also nichts uebersehen.
int* rule_next_signal[100];

void generate_rule_sets() {
    const char* intervals[] = {"1m", "5m", "15m", "1h", "4h"};
    int intervals_count = 5;
    
    // 1. Single interval rules (1m, 5m, 15m, 1h, 4h)
    for (int i = 0; i < intervals_count; i++) {
        const char* iv = intervals[i];
        RuleSet* r1 = &rule_sets[rule_sets_count++];
        r1->longRulesCount = 1;
        r1->longRules[0].interval_idx = i;
        r1->longRules[0].expected_signal = 1; // bull
        r1->shortRulesCount = 1;
        r1->shortRules[0].interval_idx = i;
        r1->shortRules[0].expected_signal = -1; // bear
        sprintf(r1->label, "%s", iv);
    }

    // 2. Dual interval multi-timeframe rules (e.g. 1m + 5m, 5m + 15m, 15m + 1h, 1h + 4h...)
    for (int i = 0; i < intervals_count - 1; i++) {
        for (int j = i + 1; j < intervals_count; j++) {
            RuleSet* r2 = &rule_sets[rule_sets_count++];
            r2->longRulesCount = 2;
            r2->longRules[0].interval_idx = i;
            r2->longRules[0].expected_signal = 1;
            r2->longRules[1].interval_idx = j;
            r2->longRules[1].expected_signal = 1;

            r2->shortRulesCount = 2;
            r2->shortRules[0].interval_idx = i;
            r2->shortRules[0].expected_signal = -1;
            r2->shortRules[1].interval_idx = j;
            r2->shortRules[1].expected_signal = -1;
            sprintf(r2->label, "%s + %s", intervals[i], intervals[j]);
        }
    }

    // 3. Triple interval multi-timeframe rules (e.g. 1m+5m+15m, 5m+15m+1h, 15m+1h+4h...)
    for (int i = 0; i < intervals_count - 2; i++) {
        for (int j = i + 1; j < intervals_count - 1; j++) {
            for (int k = j + 1; k < intervals_count; k++) {
                RuleSet* r3 = &rule_sets[rule_sets_count++];
                r3->longRulesCount = 3;
                r3->longRules[0].interval_idx = i;
                r3->longRules[0].expected_signal = 1;
                r3->longRules[1].interval_idx = j;
                r3->longRules[1].expected_signal = 1;
                r3->longRules[2].interval_idx = k;
                r3->longRules[2].expected_signal = 1;

                r3->shortRulesCount = 3;
                r3->shortRules[0].interval_idx = i;
                r3->shortRules[0].expected_signal = -1;
                r3->shortRules[1].interval_idx = j;
                r3->shortRules[1].expected_signal = -1;
                r3->shortRules[2].interval_idx = k;
                r3->shortRules[2].expected_signal = -1;
                sprintf(r3->label, "%s + %s + %s", intervals[i], intervals[j], intervals[k]);
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
            const char* iv_str = "";
            if (rs->longRules[r].interval_idx == 0) iv_str = "1m";
            else if (rs->longRules[r].interval_idx == 1) iv_str = "5m";
            else if (rs->longRules[r].interval_idx == 2) iv_str = "15m";
            else if (rs->longRules[r].interval_idx == 3) iv_str = "1h";
            else if (rs->longRules[r].interval_idx == 4) iv_str = "4h";
            
            const char* state_str = (rs->longRules[r].expected_signal == 1) ? "bull" : "bear";
            fprintf(f, "          {\"interval\": \"%s\", \"state\": \"%s\"}%s\n", iv_str, state_str, (r == rs->longRulesCount - 1) ? "" : ",");
        }
        fprintf(f, "        ],\n");
        
        // Print Short rules
        fprintf(f, "        \"short\": [\n");
        for (int r = 0; r < rs->shortRulesCount; r++) {
            const char* iv_str = "";
            if (rs->shortRules[r].interval_idx == 0) iv_str = "1m";
            else if (rs->shortRules[r].interval_idx == 1) iv_str = "5m";
            else if (rs->shortRules[r].interval_idx == 2) iv_str = "15m";
            else if (rs->shortRules[r].interval_idx == 3) iv_str = "1h";
            else if (rs->shortRules[r].interval_idx == 4) iv_str = "4h";
            
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
    int interval_mins[5] = {1, 5, 15, 60, 240};
    for (int i = 0; i < 5; i++) {
        int max_htf_len = count1m / interval_mins[i] + 1;
        htf_candles[i] = safe_malloc(sizeof(Candle) * max_htf_len, "htf_candles[i]");
        htf_counts[i] = aggregate_candles(candles1m, count1m, interval_mins[i], htf_candles[i]);
        
        htf_signals[i] = safe_malloc(sizeof(int) * htf_counts[i], "htf_signals[i]");
        precalculate_pattern_signals(htf_candles[i], htf_counts[i], htf_signals[i]);
        
        printf("Interval %d (%d mins): aggregated to %d candles.\n", i, interval_mins[i], htf_counts[i]);
    }
    
    // Precompute HTF pointer cache (done once, avoids per-backtest while-loops)
    for (int tf = 0; tf < 5; tf++) {
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
    
    int leverages[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 25, 30, 35, 40, 45, 50, 60, 75, 100};
    int leverages_count = 24;
    
    int cooldowns[] = {0, 1, 2, 3, 5, 10, 15, 20, 25, 30, 40, 50, 60, 90, 120};
    int cooldowns_count = 15;
    
    double tps[] = {1.0, 1.5, 2.0, 2.5, 5.0, 7.5, 10.0, 12.5, 15.0, 20.0, 25.0, 30.0, 35.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0, 120.0, 150.0, 200.0};
    int tps_count = 23;
    
    double sls[] = {1.0, 1.5, 2.0, 2.5, 5.0, 7.5, 10.0, 12.5, 15.0, 17.5, 20.0, 25.0, 30.0, 35.0, 40.0, 50.0, 60.0, 75.0, 100.0};
    int sls_count = 19;
    
    int max_opens[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20};
    int max_opens_count = 13;

    // Coarse-Suche Indizes auswaehlen (Phase 1):
    int leverages_coarse_idx[] = {0, 1, 3, 5, 7, 9, 11, 14, 16, 18, 20, 22, 23}; // 1, 2, 4, 6, 8, 10, 14, 20, 30, 40, 50, 75, 100
    int leverages_coarse_count = 13;
    
    int cooldowns_coarse_idx[] = {0, 1, 3, 5, 7, 9, 11, 12, 14}; // 0, 1, 3, 10, 20, 30, 50, 60, 120
    int cooldowns_coarse_count = 9;
    
    int tps_coarse_idx[] = {0, 1, 3, 6, 8, 10, 13, 15, 17, 19, 21, 22}; // 1.0, 1.5, 2.5, 7.5, 12.5, 20, 35, 50, 70, 90, 150, 200
    int tps_coarse_count = 12;
    
    int sls_coarse_idx[] = {0, 1, 3, 6, 8, 10, 12, 14, 16, 18}; // 1.0, 1.5, 2.5, 7.5, 12.5, 20, 30, 40, 60, 100
    int sls_coarse_count = 10;
    
    int max_opens_coarse_idx[] = {0, 1, 2, 3, 4, 6, 8, 10, 12}; // 1, 2, 3, 4, 5, 7, 9, 12, 20
    int max_opens_coarse_count = 9;
    
    int coarse_combos = rule_sets_count * leverages_coarse_count * cooldowns_coarse_count 
                      * tps_coarse_count * sls_coarse_count * max_opens_coarse_count;
                      
    printf("Starting Phase 1 (Coarse search) on %d combinations using OpenMP multi-threading...\n", coarse_combos);
    
    StrategyEvaluation* evals_coarse = safe_malloc(sizeof(StrategyEvaluation) * coarse_combos, "evals_coarse");
    
    double start_time = omp_get_wtime();
    int progress_counter = 0;
    int progress_step = coarse_combos / 100;
    if (progress_step < 100) progress_step = 100;
    const int PROGRESS_BATCH = 256;
    
    #pragma omp parallel
    {
        int local_progress = 0;
        
        #pragma omp for collapse(6) schedule(dynamic, 64)
        for (int r = 0; r < rule_sets_count; r++) {
            for (int l = 0; l < leverages_coarse_count; l++) {
                for (int cd = 0; cd < cooldowns_coarse_count; cd++) {
                    for (int tp = 0; tp < tps_coarse_count; tp++) {
                        for (int sl = 0; sl < sls_coarse_count; sl++) {
                            for (int mo = 0; mo < max_opens_coarse_count; mo++) {
                                int idx = r * (leverages_coarse_count * cooldowns_coarse_count * tps_coarse_count * sls_coarse_count * max_opens_coarse_count)
                                        + l * (cooldowns_coarse_count * tps_coarse_count * sls_coarse_count * max_opens_coarse_count)
                                        + cd * (tps_coarse_count * sls_coarse_count * max_opens_coarse_count)
                                        + tp * (sls_coarse_count * max_opens_coarse_count)
                                        + sl * max_opens_coarse_count
                                        + mo;
                                        
                                StrategyParams params;
                                params.leverage = leverages[leverages_coarse_idx[l]];
                                params.cooldownMin = cooldowns[cooldowns_coarse_idx[cd]];
                                params.tpPercent = tps[tps_coarse_idx[tp]];
                                params.slPercent = sls[sls_coarse_idx[sl]];
                                params.maxOpen = max_opens[max_opens_coarse_idx[mo]];
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
                                
                                evals_coarse[idx].params = params;
                                evals_coarse[idx].results = res;
                                evals_coarse[idx].score = calculate_score(&res);
                                
                                local_progress++;
                                if (local_progress >= PROGRESS_BATCH) {
                                    int gc;
                                    #pragma omp atomic capture
                                    gc = progress_counter += local_progress;
                                    int prevGc = gc - local_progress;
                                    local_progress = 0;
                                    if (gc / progress_step != prevGc / progress_step || gc >= coarse_combos) {
                                        printf("PROGRESS: %.1f%%\n", (double)gc * 15.0 / coarse_combos);
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
            if (gc >= coarse_combos) {
                printf("PROGRESS: %.1f%%\n", (double)gc * 15.0 / coarse_combos);
                fflush(stdout);
            }
        }
    }
    
    printf("Finished Phase 1 in %.3f seconds. Sorting coarse results...\n", omp_get_wtime() - start_time);
    qsort(evals_coarse, coarse_combos, sizeof(StrategyEvaluation), compare_strategy_eval);
    
    int top_k = (coarse_combos < 200) ? coarse_combos : 200;
    
    // Generate fine neighborhoods for top_k candidates by shifting indices in the full grids
    // Leverage neighborhood: baseIdx - 1, baseIdx, baseIdx + 1 (3 steps)
    // Cooldown neighborhood: baseIdx - 1, baseIdx, baseIdx + 1 (3 steps)
    // TP neighborhood: baseIdx - 2, baseIdx - 1, baseIdx, baseIdx + 1, baseIdx + 2 (5 steps)
    // SL neighborhood: baseIdx - 1, baseIdx, baseIdx + 1 (3 steps)
    // MaxOpen neighborhood: baseIdx - 1, baseIdx, baseIdx + 1 (3 steps)
    // Total: 3 * 3 * 5 * 3 * 3 = 405 potential combinations per seed candidate
    int max_potential = top_k * 405;
    CandidateCombo* potential_combos = safe_malloc(sizeof(CandidateCombo) * max_potential, "potential_combos");
    int potential_count = 0;
    
    for (int k = 0; k < top_k; k++) {
        StrategyParams base = evals_coarse[k].params;
        
        int base_lev_idx = find_idx_int(base.leverage, leverages, leverages_count);
        int base_cd_idx = find_idx_int(base.cooldownMin, cooldowns, cooldowns_count);
        int base_tp_idx = find_idx_double(base.tpPercent, tps, tps_count);
        int base_sl_idx = find_idx_double(base.slPercent, sls, sls_count);
        int base_mo_idx = find_idx_int(base.maxOpen, max_opens, max_opens_count);
        
        for (int dl = -1; dl <= 1; dl++) {
            int l_idx = base_lev_idx + dl;
            if (l_idx < 0) l_idx = 0;
            if (l_idx >= leverages_count) l_idx = leverages_count - 1;
            int lev = leverages[l_idx];
            
            for (int dc = -1; dc <= 1; dc++) {
                int c_idx = base_cd_idx + dc;
                if (c_idx < 0) c_idx = 0;
                if (c_idx >= cooldowns_count) c_idx = cooldowns_count - 1;
                int cd = cooldowns[c_idx];
                
                for (int dt = -2; dt <= 2; dt++) {
                    int t_idx = base_tp_idx + dt;
                    if (t_idx < 0) t_idx = 0;
                    if (t_idx >= tps_count) t_idx = tps_count - 1;
                    double tp = tps[t_idx];
                    
                    for (int ds = -1; ds <= 1; ds++) {
                        int s_idx = base_sl_idx + ds;
                        if (s_idx < 0) s_idx = 0;
                        if (s_idx >= sls_count) s_idx = sls_count - 1;
                        double sl = sls[s_idx];
                        
                        for (int dm = -1; dm <= 1; dm++) {
                            int m_idx = base_mo_idx + dm;
                            if (m_idx < 0) m_idx = 0;
                            if (m_idx >= max_opens_count) m_idx = max_opens_count - 1;
                            int mo = max_opens[m_idx];
                            
                            StrategyParams p;
                            p.ruleIndex = base.ruleIndex;
                            p.leverage = lev;
                            p.cooldownMin = cd;
                            p.tpPercent = tp;
                            p.slPercent = sl;
                            p.maxOpen = mo;
                            
                            CandidateCombo combo;
                            combo.params = p;
                            combo.key = encode_params(&p);
                            
                            potential_combos[potential_count++] = combo;
                        }
                    }
                }
            }
        }
    }
    
    printf("Generated %d potential combinations for Phase 2. Sorting and deduplicating...\n", potential_count);
    qsort(potential_combos, potential_count, sizeof(CandidateCombo), compare_candidate_combo);
    
    int unique_count = 0;
    CandidateCombo* unique_combos = safe_malloc(sizeof(CandidateCombo) * potential_count, "unique_combos");
    for (int i = 0; i < potential_count; i++) {
        if (i == 0 || potential_combos[i].key != potential_combos[i - 1].key) {
            unique_combos[unique_count++] = potential_combos[i];
        }
    }
    free(potential_combos);
    printf("Found %d unique combinations for Phase 2.\n", unique_count);
    
    printf("Starting Phase 2 (Fine search) on %d combinations using OpenMP multi-threading...\n", unique_count);
    StrategyEvaluation* evals_fine = safe_malloc(sizeof(StrategyEvaluation) * unique_count, "evals_fine");
    
    int fine_progress_counter = 0;
    int fine_progress_step = unique_count / 100;
    if (fine_progress_step < 100) fine_progress_step = 100;
    
    #pragma omp parallel
    {
        int local_progress = 0;
        
        #pragma omp for schedule(dynamic, 64)
        for (int i = 0; i < unique_count; i++) {
            StrategyParams params = unique_combos[i].params;
            
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
                rule_side_signal[params.ruleIndex],
                rule_next_signal[params.ruleIndex]
            );
            
            evals_fine[i].params = params;
            evals_fine[i].results = res;
            evals_fine[i].score = calculate_score(&res);
            
            local_progress++;
            if (local_progress >= PROGRESS_BATCH) {
                int gc;
                #pragma omp atomic capture
                gc = fine_progress_counter += local_progress;
                int prevGc = gc - local_progress;
                local_progress = 0;
                if (gc / fine_progress_step != prevGc / fine_progress_step || gc >= unique_count) {
                    printf("PROGRESS: %.1f%%\n", 15.0 + (double)gc * 85.0 / unique_count);
                    fflush(stdout);
                }
            }
        }
        
        if (local_progress > 0) {
            int gc;
            #pragma omp atomic capture
            gc = fine_progress_counter += local_progress;
            if (gc >= unique_count) {
                printf("PROGRESS: %.1f%%\n", 15.0 + (double)gc * 85.0 / unique_count);
                fflush(stdout);
            }
        }
    }
    
    double end_time = omp_get_wtime();
    printf("Finished Phase 2 in %.3f seconds. Sorting fine results...\n", end_time - start_time);
    
    qsort(evals_fine, unique_count, sizeof(StrategyEvaluation), compare_strategy_eval);
    
    int output_count = (unique_count < 200) ? unique_count : 200;
    printf("Writing top %d strategies to %s...\n", output_count, output_path);
    write_strategies_json(output_path, evals_fine, output_count, rule_sets, market);
    
    // Cleanup
    free(evals_coarse);
    free(unique_combos);
    free(evals_fine);
    for (int i = 0; i < 5; i++) {
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
