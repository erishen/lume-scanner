/* Shared API layer + types for the lume-scanner dashboard. All endpoints
 * live on the Lume server (docroot www/, plain root URLs). */

export interface SignalRow {
  code: string;
  name: string;
  close: number;
  change: number;
  rsi: number;
  signals: string[];
}

export interface SignalPayload {
  ok: boolean;
  date: string | null;
  count: number;
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
  return r.json();
}

export async function fetchSignals(limit = 80): Promise<SignalPayload> {
  const r = await fetch(`/api/signals?limit=${limit}`);
  return r.json();
}

export async function fetchScreen(f: Filters, limit = 50): Promise<ScreenPayload> {
  const r = await fetch(`/api/screen?limit=${limit}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filters: f }),
  });
  return r.json();
}

export async function fetchStock(code: string, days = 120): Promise<StockPayload> {
  const r = await fetch(`/api/stock/${encodeURIComponent(code)}?days=${days}`);
  return r.json();
}

export async function fetchIndicators(code: string, days = 200, period = 9): Promise<IndicatorsPayload> {
  const r = await fetch(`/api/indicators/${encodeURIComponent(code)}?days=${days}&period=${period}`);
  return r.json();
}
