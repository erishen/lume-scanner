/* Shared API layer + types for the lume-scanner dashboard. All endpoints
 * live on the Lume server (docroot www/, plain root URLs). */

/**
 * Fetch a JSON endpoint defensively. The Lume SPA serves index.html (`<!DOCTYPE ...`)
 * as a 404/500 fallback, so a raw `res.json()` throws `Unexpected token '<'` when the
 * handler errors (e.g. a quant builtin on too-short history). This helper checks
 * status + content-type and, on a non-JSON body, extracts the server's error message
 * so the UI can show *why* it failed instead of a cryptic parse error.
 */
async function getJSON<T>(res: Response): Promise<T> {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (!res.ok || !ct.includes("application/json")) {
    let detail = "";
    try {
      const text = await res.text();
      // Lume httpd 500 page: <p>Lume handler error</p> or a bare reason string.
      const m = text.match(/<h1>([\s\S]*?)<\/h1>/);
      if (m) detail = m[1].trim();
      else if (text.startsWith("{")) {
        try { detail = JSON.parse(text).err || JSON.parse(text).error || ""; } catch { /* ignore */ }
      } else {
        // strip tags from the 500 body for a readable reason
        detail = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
    } catch {
      /* body already consumed or unreadable */
    }
    throw new Error(
      `HTTP ${res.status}${res.ok ? "" : " " + res.statusText}${detail ? " · " + detail : ""}`
      + " (接口未返回 JSON, 请确认 Lume 服务已重启且版本含对应路由)");
  }
  return res.json() as Promise<T>;
}

export interface SignalRow {
  code: string;
  name: string;
  close: number;
  change: number;
  rsi: number;
  /** Lume 现算 Cutler RSI 尾值(与 ETL rsi 列同口径, 按构造 Δ≈0, 验证移植正确性) */
  rsi_lume: number | null;
  /** Lume 现算 Wilder RSI 尾值(EMA, 跨口径参考, 与 Cutler 有分叉) */
  rsi_wilder: number | null;
  /** "match"=Cutler 同口径逐位一致(Δ<0.05) | "diff"=分叉 | "none"=无值 */
  rsi_match: "none" | "match" | "diff" | null;
  /** 共振度: 该行同时命中几个信号(0-9); 服务端按此降序返回 */
  sig_cnt?: number;
  signals: string[];
}

export interface SignalPayload {
  ok: boolean;
  date: string | null;
  count: number;      // 实际返回(被 limit 截断)的行数
  total?: number;     // 全市场带信号总数(未截断)
  sig_counts?: Record<string, number>; // 全市场各信号类别命中数(SQL 条件聚合, 未截断)
  dist?: { g2?: number; g3?: number; g4?: number; g5?: number }; // 全市场共振分布(≥2/≥3/≥4/≥5)
  min_sig?: number;   // 本次返回的最小共振度
  signals: SignalRow[];
  note?: string;
}

export interface AssetRow {
  code: string;
  name: string;
  close: number;
  change_percent: number;
  volume_ratio: number;
  turnover_rate: number;
  total_market_value: number; // 亿元
  float_market_value: number; // 亿元
}

export interface ScreenPayload {
  ok: boolean;
  count: number;
  rows: AssetRow[];
  where?: string;
}

export interface KlineRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  change_percent: number;
  ma5: number | null;
  ma20: number | null;
  rsi: number | null;
  macd: number | null;
  macd_signal: number | null;
}

export interface StockPayload {
  ok: boolean;
  code: string;
  name?: string;
  days: number;
  series: KlineRow[];
}

export interface Meta {
  ok: boolean;
  latest_date: string | null;
  stocks: number;
  analysis_rows: number;
  asset_rows: number;
}

/** #54 实时技术指标(读原始 OHLCV, Lume 内建现算)。数组已截去前 period-1 个冷启动 NaN。 */
export interface IndicatorsPayload {
  ok: boolean;
  code: string;
  name?: string;
  days: number;
  period: number;
  dates: string[];
  note?: string;
  kdj: { rsv: (number | null)[]; k: (number | null)[]; d: (number | null)[]; j: (number | null)[] } | null;
  williams_r: (number | null)[];
  atr: (number | null)[];
  obv: number[];
  closes: number[];
  ma5: (number | null)[];
  ma10: (number | null)[];
  ma20: (number | null)[];
  macd: { line: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] };
  rsi_wilder: (number | null)[];
  /** Cutler RSI(与 ETL 同口径, 精确可对照)序列, 与 rsi_wilder 同窗口 */
  rsi_cutler: (number | null)[];
  boll: { mid: (number | null)[]; upper: (number | null)[]; lower: (number | null)[] };
  performance: {
    cumulative: number | null;
    annualized_return: number | null;
    annualized_vol: number | null;
    sharpe: number | null;
    sortino: number | null;
    calmar: number | null;
    max_drawdown_pct: number | null;
    var_95: number | null;
    cvar_95: number | null;
    /** #57 分布形态(日收益): 偏度 / 超额峰度(正态=0), 收益不足 3/4 个时缺省 */
    skew?: number | null;
    kurtosis?: number | null;
  } | null;
  lume_signals: string[];
}

export interface Filters {
  volume_ratio_min?: number;
  turnover_rate_min?: number;
  total_market_value_min?: number;
  close_min?: number;
  close_max?: number;
}

export async function fetchMeta(): Promise<Meta> {
  const r = await fetch("/api/meta");
  return getJSON<Meta>(r);
}

export async function fetchSignals(limit = 80, minSig = 2): Promise<SignalPayload> {
  const r = await fetch(`/api/signals?limit=${limit}&min_sig=${minSig}`);
  return getJSON<SignalPayload>(r);
}

export async function fetchScreen(f: Filters, limit = 50): Promise<ScreenPayload> {
  const r = await fetch(`/api/screen?limit=${limit}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filters: f }),
  });
  return getJSON<ScreenPayload>(r);
}

export async function fetchStock(code: string, days = 120): Promise<StockPayload> {
  const r = await fetch(`/api/stock/${encodeURIComponent(code)}?days=${days}`);
  return getJSON<StockPayload>(r);
}

export async function fetchIndicators(code: string, days = 200, period = 9): Promise<IndicatorsPayload> {
  const r = await fetch(`/api/indicators/${encodeURIComponent(code)}?days=${days}&period=${period}`);
  return getJSON<IndicatorsPayload>(r);
}

// ---- 实时行情(腾讯 qt.gtimg.cn 文本源; Lume 侧单票 15s / 指数 30s 缓存) ----
export interface Realtime {
  ok: boolean;
  code: string;
  name?: string;
  price?: number | null;
  prev_close?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  change?: number | null;
  change_pct?: number | null;
  volume?: number | null;   // 手
  amount?: number | null;    // 万元
  quote_time?: string;       // yyyymmddHHMMSS
  ts?: number;
  suspended?: boolean;
  reason?: string;
}

export interface RealtimeIndex {
  code: string;
  name: string;
  price: number | null;
  change: number | null;
  change_pct: number | null;
}

export interface RealtimeIndexes {
  ok: boolean;
  ts: number | null;
  indexes: RealtimeIndex[];
  reason?: string;
}

export async function fetchRealtime(code: string): Promise<Realtime> {
  const r = await fetch(`/api/realtime/${encodeURIComponent(code)}`);
  return getJSON<Realtime>(r);
}

export async function fetchIndexes(): Promise<RealtimeIndexes> {
  const r = await fetch("/api/realtime/indexes");
  return getJSON<RealtimeIndexes>(r);
}

// ---- 信号历史战绩 / 今日精选(「个人投资价值」层: 规则从信仰变证据) ----
export interface SignalStat {
  sig: string;
  n: number;
  r1?: number | null;
  r5?: number | null;
  r10?: number | null;
  win5?: number | null;
}

export interface SignalStatsPayload {
  ok: boolean;
  window?: string;
  ts?: number;
  signals: SignalStat[];
  note?: string;
  reason?: string;
}

export interface DailyPick {
  code: string;
  name: string;
  close?: number | null;
  change?: number | null;
  signals: string[];
  volume_ratio?: number | null;
  market_value?: number | null;
  score?: number | null;
}

export interface DailyPicksPayload {
  ok: boolean;
  date?: string | null;
  picks: DailyPick[];
  note?: string;
}

export async function fetchSignalStats(): Promise<SignalStatsPayload> {
  const r = await fetch("/api/signal-stats");
  return getJSON<SignalStatsPayload>(r);
}

export async function fetchDailyPicks(): Promise<DailyPicksPayload> {
  const r = await fetch("/api/daily-picks");
  return getJSON<DailyPicksPayload>(r);
}

export interface PaperPosition {
  code: string;
  name: string;
  buy_date?: string | null;
  buy_price: number;
  shares: number;
  stop_loss?: number | null;
  take_profit?: number | null;
  reason?: string | null;
  price?: number | null;
  realtime_ok?: boolean;
  suspended?: boolean;
  cost?: number | null;
  upnl?: number | null;
  upnl_pct?: number | null;
  stop_hit?: boolean | null;
  target_hit?: boolean | null;
  /** #57 Kelly 仓位建议 f* = 近 60 日日收益均值/方差(凯利公式); 负期望→0, 不可算→null */
  kelly?: number | null;
}

export interface PaperPayload {
  ok: boolean;
  ts?: number | null;
  reason?: string | null;
  updated_at?: string | null;
  initial_capital?: number | null;
  cash?: number | null;
  equity?: number | null;
  total_pnl?: number | null;
  total_pnl_pct?: number | null;
  positions?: PaperPosition[];
  closed?: number | null;
  pending?: Array<{ side?: string; code?: string; name?: string | null; signal_date?: string; reason?: string }>;
  /** #57 持仓两两相关性窗口(日) */
  corr_window?: number | null;
  /** 持仓两两相关性矩阵 [i][j] = Pearson(最近 corr_window 日日收益), 对角线=1, 不可算=null; 与 positions 顺序一致 */
  corr_matrix?: Array<Array<number | null>>;
}

export async function fetchPaper(): Promise<PaperPayload> {
  const r = await fetch("/api/paper");
  return getJSON<PaperPayload>(r);
}

export interface Freshness {
  ok: boolean;
  analysis_latest?: string | null;
  snapshot_updated_at?: string | null;
  snapshot_rows?: number | null;
  paper_updated_at?: string | null;
}

export async function fetchFreshness(): Promise<Freshness> {
  const r = await fetch("/api/freshness");
  return getJSON<Freshness>(r);
}
