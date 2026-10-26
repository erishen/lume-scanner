import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  fetchMeta, fetchSignals, fetchScreen, fetchStock, fetchIndicators,
  fetchRealtime, fetchIndexes, fetchSignalStats, fetchDailyPicks,
  fetchPaper, fetchFreshness,
  type Meta, type SignalPayload, type ScreenPayload, type StockPayload, type Filters, type IndicatorsPayload,
  type Realtime, type RealtimeIndexes, type SignalStatsPayload, type DailyPicksPayload,
  type PaperPayload, type PaperPosition, type Freshness,
} from "./api";
import { ChatTab } from "./chat";

type Tab = "signals" | "screen" | "stock" | "indicators" | "paper" | "chat" | "glossary" | "about";

// ---- 轻量 SVG 折线(null 值断开, 支持多序列)----
function fmtAxis(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(1) + "亿";
  if (a >= 1e4) return (v / 1e4).toFixed(1) + "万";
  if (a >= 1000) return v.toFixed(0);
  if (a < 10 && a > 0) return v.toFixed(2);
  return v.toFixed(1);
}

function Lines({ data, labels, w = 720, h = 160, min, max }: {
  data: (number | null)[][]; labels: string[]; w?: number; h?: number;
  min?: number; max?: number;
}) {
  const all = data.flat().filter((v): v is number => v != null);
  const lo = min ?? Math.min(...all);
  const hi = max ?? Math.max(...all);
  const span = hi - lo || 1;
  // 公共 x 轴 = 最长序列长度; 短序列(前导 NaN 已被服务端剥掉)按「右对齐」画,
  // 使 ma5/ma20 等尾端与价格线对齐到同一最新交易日, 不再整体左移(消除错位)。
  const n = Math.max(...data.map((s) => s.length));
  const px = (i: number) => (n > 1 ? (i / (n - 1)) * (w - 56) + 48 : w / 2);
  const py = (v: number) => h - 24 - ((v - lo) / span) * (h - 36);
  const colors = ["#58a6ff", "#f85149", "#3fb950", "#d29922"];
  // 4 条水平网格线
  const grid = [0, 1, 2, 3].map((g) => {
    const v = lo + (span * g) / 3;
    const y = py(v);
    return (
      <g key={g}>
        <line x1={48} x2={w - 8} y1={y} y2={y} stroke="#21262d" strokeDasharray="3 4" />
        <text x={46} y={y + 3.5} fill="#6e7681" fontSize={10} textAnchor="end">{fmtAxis(v)}</text>
      </g>
    );
  });
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", maxWidth: w, background: "transparent" }}>
      {grid}
      {data.map((series, si) => {
        // 右对齐: 短序列(前导 NaN 被剥)尾端对齐最新交易日, x 偏移 = n - 序列长度。
        const off = n - series.length;
        // 分段(null 断开)
        let path = "";
        let pen = false;
        series.forEach((v, i) => {
          if (v == null) { pen = false; return; }
          path += (pen ? "L" : "M") + px(i + off).toFixed(1) + " " + py(v).toFixed(1) + " ";
          pen = true;
        });
        return <path key={si} d={path} fill="none" stroke={colors[si % colors.length]} strokeWidth={1.5} />;
      })}
    </svg>
  );
}

const CHART_COLORS = ["#58a6ff", "#f85149", "#3fb950", "#d29922"];

function Legend({ labels }: { labels: string[] }) {
  return (
    <div className="legend">
      {labels.map((l, i) => (
        <span key={l} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <i style={{ background: CHART_COLORS[i % 4] }} />{l}
        </span>
      ))}
    </div>
  );
}

// 指标图卡片: 标题+副题(左) 与 legend(右) 并排成一行头部 + Lines
function ChartCard({ title, sub, data, labels, min, max, w = 720, h = 150 }: {
  title: string; sub?: string; data: (number | null)[][]; labels: string[];
  min?: number; max?: number; w?: number; h?: number;
}) {
  return (
    <div className="chart-card">
      <div className="chart-title">
        <div className="chart-labels"><b>{title}</b>{sub ? <span>{sub}</span> : null}</div>
        {labels.length > 1 ? <Legend labels={labels} /> : null}
      </div>
      <Lines data={data} labels={labels} min={min} max={max} w={w} h={h} />
    </div>
  );
}

function Perf({ label, v, plain }: { label: string; v: number | null | undefined; plain?: boolean }) {
  const num = v == null || isNaN(v as number) ? null : (v as number);
  // plain(VaR/CVaR: 正数=预期损失)不做红绿着色, 其余按「负数红/非负绿」。
  const cls = num == null || plain ? "" : num < 0 ? "neg" : "pos";
  const txt = num == null ? "—" : num.toFixed(2);
  return (
    <div className={"perf-cell " + cls}>
      <div className="perf-label">{label}</div>
      <div className="perf-val">{txt}</div>
    </div>
  );
}

function cls(n: number): string {
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "";
}

function Num({ v, digits = 2, hint }: { v: number | null | undefined; digits?: number; hint?: string }) {
  if (v == null) return hint ? <span className="cold-hint" title="rolling 指标冷启动, 上市初期无值">{hint}</span> : <span>—</span>;
  return <span>{v.toFixed(digits)}</span>;
}

// ---- 信号 chip 语义着色(按关键词)----
function chipClass(t: string): string {
  if (/金叉|买入/.test(t)) return "gold";
  if (/死叉|卖出/.test(t)) return "red";
  if (/超卖/.test(t)) return "green";
  if (/超买|放量|上轨/.test(t)) return "purple";
  if (/下轨/.test(t)) return "blue";
  return "gray";
}
function Chips({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
      {items.map((s) => <span key={s} className={"chip " + chipClass(s)}>{s}</span>)}
    </div>
  );
}

// 跳转到个股/指标页的回调(由 App 提供, 会切 tab 并带入 code 自动加载)
type Openers = { onStock: (code: string) => void; onInd: (code: string) => void };

// ---- Tab 1: 全市场信号 ----
function SignalsTab({ onStock, onInd }: Openers) {
  const [data, setData] = useState<SignalPayload | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    fetchSignals(80).then(setData).catch((e) => setErr(String(e)));
  }, []);
  if (err) return <div className="err">加载失败: {err}</div>;
  if (!data) return <div className="kv">加载中…</div>;
  if (data.count === 0) return <div className="kv">{data.note ?? "当日无信号"}</div>;
  return (
    <>
      <IndexTicker />
      <PicksCard onStock={onStock} onInd={onInd} />
      <StatsCard />
      <div className="card">
      <h3>截至 {data.date} · 共 {data.count} 只带信号 <span style={{ textTransform: "none", color: "var(--faint)", fontWeight: 400 }}>· RSI: Lume 现算 Cutler 同口径(Δ≈0 验证移植) + Wilder 跨口径参考</span></h3>
      <table>
        <thead>
          <tr><th>代码</th><th>名称</th><th>收盘</th><th>涨跌%</th><th>RSI(ETL·Cutler)</th><th>RSI(Lume·Cutler)</th><th>RSI(Lume·Wilder)</th><th>一致性</th><th>信号</th><th>操作</th></tr>
        </thead>
        <tbody>
          {data.signals.map((s) => (
            <tr key={s.code} className="rowlink" onClick={() => onStock(s.code)}>
              <td style={{ cursor: "pointer" }} title="点击看个股">{s.code}</td>
              <td className="name">{s.name || "—"}</td>
              <td><Num v={s.close} /></td>
              <td className={cls(s.change)}><Num v={s.change} /></td>
              <td><Num v={s.rsi} /></td>
              <td title="Lume rsi_cutler 内建现算, 与 ETL 同口径, 逐位验证移植正确性"><Num v={s.rsi_lume} /></td>
              <td title="Lume rsi 内建 Wilder EMA, 跨平滑口径参考" style={{ color: "var(--faint)" }}><Num v={s.rsi_wilder} /></td>
              <td>
                {s.rsi_lume == null
                  ? <span style={{ color: "var(--faint)" }}>—</span>
                  : s.rsi_match === "match"
                    ? <span className="chip green" title="Lume Cutler 与 ETL Cutler 逐位一致(Δ<0.05), 移植正确">Δ0.00</span>
                    : <span className="chip gold" title="Lume Cutler 与 ETL Cutler 存在偏差(Δ≥0.05)">Δ {Math.abs((s.rsi_lume ?? 0) - s.rsi).toFixed(2)}</span>}
              </td>
              <td><Chips items={s.signals} /></td>
              <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
                <button className="ghost" onClick={() => onStock(s.code)}>个股</button>{" "}
                <button className="ghost" onClick={() => onInd(s.code)}>指标</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </>
  );
}

// ---- Tab 2: 规则筛选 ----
function ScreenTab({ onStock, onInd }: Openers) {
  const [data, setData] = useState<ScreenPayload | null>(null);
  const [vr, setVr] = useState("");
  const [to, setTo] = useState("");
  const [mv, setMv] = useState("");
  const [cmin, setCmin] = useState("");
  const [cmax, setCmax] = useState("");
  const [loading, setLoading] = useState(false);

  const run = () => {
    const f: Filters = {};
    if (vr) f.volume_ratio_min = Number(vr);
    if (to) f.turnover_rate_min = Number(to);
    if (mv) f.total_market_value_min = Number(mv);
    if (cmin) f.close_min = Number(cmin);
    if (cmax) f.close_max = Number(cmax);
    setLoading(true);
    fetchScreen(f, 50).then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  };
  // 挂载即显示默认数据(无条件 = 服务端回量比 Top 50), 不用点「筛选」
  useEffect(() => { run(); }, []);

  return (
    <>
      <div className="filters">
        <label>量比 ≥ <input value={vr} onChange={(e) => setVr(e.target.value)} placeholder="如 2.0" /></label>
        <label>换手 ≥ <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="如 5" /></label>
        <label>总市值(亿) ≥ <input value={mv} onChange={(e) => setMv(e.target.value)} placeholder="如 100" /></label>
        <label>价格 ≥ <input value={cmin} onChange={(e) => setCmin(e.target.value)} placeholder="如 10" /></label>
        <label>价格 ≤ <input value={cmax} onChange={(e) => setCmax(e.target.value)} placeholder="如 50" /></label>
        <button className="primary" onClick={run} disabled={loading}>筛选</button>
      </div>
      {!data && loading && <div className="kv">加载中…</div>}
      {data && (
        <div className="card">
          <h3>{data.where && data.where !== "1=1"
            ? <>命中 {data.count} 只 · WHERE {data.where}</>
            : <>默认展示 · 量比 Top {data.count}</>}</h3>
          <table>
            <thead>
              <tr><th>代码</th><th>名称</th><th>收盘</th><th>量比</th><th>换手%</th><th>总市值(亿)</th><th>流通市值(亿)</th><th>操作</th></tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.code} className="rowlink" onClick={() => onStock(r.code)}>
                  <td style={{ cursor: "pointer" }} title="点击看个股">{r.code}</td>
                  <td className="name">{r.name || "—"}</td>
                  <td><Num v={r.close} /></td>
                  <td><Num v={r.volume_ratio} /></td>
                  <td><Num v={r.turnover_rate} /></td>
                  <td><Num v={r.total_market_value} /></td>
                  <td><Num v={r.float_market_value} /></td>
                  <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
                    <button className="ghost" onClick={() => onStock(r.code)}>个股</button>{" "}
                    <button className="ghost" onClick={() => onInd(r.code)}>指标</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ---- 实时价卡(腾讯 qt.gtimg.cn 源; 5s 轮询, Lume 侧 15s 缓存; A 股红涨绿跌) ----
function RealtimeCard({ code }: { code: string }) {
  const [rt, setRt] = useState<Realtime | null>(null);
  useEffect(() => {
    let live = true;
    const tick = () => fetchRealtime(code).then((d) => { if (live) setRt(d); }).catch(() => {});
    tick();
    const t = setInterval(tick, 5000);
    return () => { live = false; clearInterval(t); };
  }, [code]);
  if (!rt) return null;
  if (!rt.ok || rt.price == null) {
    return (
      <div className="card rt-card">
        <span className="kv">实时行情不可用</span>
        <span className="kv dim">{rt.reason || "上游无数据, 展示库内收盘"}</span>
      </div>
    );
  }
  const up = (rt.change_pct ?? 0) >= 0;
  const tone = up ? "up" : "down";
  return (
    <div className="card rt-card">
      <div>
        <span className="name">{rt.name ? rt.name + " " : ""}{rt.code}</span>
        <span className={`rt-price ${tone}`}>{(rt.price ?? 0).toFixed(2)}</span>
        <span className={`rt-chg ${tone}`}>
          {up ? "▲" : "▼"} {(rt.change ?? 0) >= 0 ? "+" : ""}{(rt.change ?? 0).toFixed(2)}
          {" "}({(rt.change_pct ?? 0) >= 0 ? "+" : ""}{(rt.change_pct ?? 0).toFixed(2)}%)
        </span>
      </div>
      <div className="rt-meta">
        <span>开 {fmt2(rt.open)}</span><span>高 {fmt2(rt.high)}</span><span>低 {fmt2(rt.low)}</span>
        <span>昨收 {fmt2(rt.prev_close)}</span>
        <span>量 {rt.volume != null ? Math.round(rt.volume / 10000).toLocaleString() + " 万手" : "—"}</span>
        <span className="dim">{rt.quote_time ? fmtT(rt.quote_time) : ""} · 5s 刷新</span>
      </div>
    </div>
  );
}
function fmt2(v?: number | null) { return v == null ? "—" : v.toFixed(2); }
function fmtT(yyyymmddHHMMSS?: string) {
  if (!yyyymmddHHMMSS || yyyymmddHHMMSS.length < 14) return "";
  const s = String(yyyymmddHHMMSS);
  return `${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
}

// ---- 四大指数条(30s 轮询; 信号页顶部) ----
function IndexTicker() {
  const [ix, setIx] = useState<RealtimeIndexes | null>(null);
  useEffect(() => {
    let live = true;
    const tick = () => fetchIndexes().then((d) => { if (live) setIx(d); }).catch(() => {});
    tick();
    const t = setInterval(tick, 30000);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!ix || !ix.indexes.length) return null;
  return (
    <div className="ticker">
      {ix.indexes.map((x) => {
        const up = (x.change_pct ?? 0) >= 0;
        return (
          <div key={x.code} className={`ticker-item ${up ? "up" : "down"}`}>
            <span>{x.name}</span>
            <b>{x.price != null ? x.price.toFixed(2) : "—"}</b>
            <span>{up ? "▲" : "▼"} {Math.abs(x.change_pct ?? 0).toFixed(2)}%</span>
          </div>
        );
      })}
    </div>
  );
}

// ---- 今日精选(信号数×量比×市值打分 Top 8; 信号页顶部) ----
function PicksCard({ onStock, onInd }: Openers) {
  const [pk, setPk] = useState<DailyPicksPayload | null>(null);
  useEffect(() => { fetchDailyPicks().then(setPk).catch(() => {}); }, []);
  if (!pk || !pk.picks.length) return null;
  return (
    <div className="card">
      <h3>今日精选 Top {pk.picks.length} <span>· {pk.note}</span></h3>
      <table>
        <thead>
          <tr><th>#</th><th>代码</th><th>名称</th><th>信号</th><th>量比</th><th>市值(亿)</th><th>打分</th><th>操作</th></tr>
        </thead>
        <tbody>
          {pk.picks.map((p, i) => (
            <tr key={p.code} className="rowlink" onClick={() => onStock(p.code)}>
              <td>{i + 1}</td>
              <td style={{ cursor: "pointer" }} title="点击看个股">{p.code}</td>
              <td className="name">{p.name || "—"}</td>
              <td><Chips items={p.signals} /></td>
              <td><Num v={p.volume_ratio} /></td>
              <td><Num v={p.market_value} digits={0} /></td>
              <td><b>{(p.score ?? 0).toFixed(0)}</b></td>
              <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
                <button className="ghost" onClick={() => onStock(p.code)}>个股</button>{" "}
                <button className="ghost" onClick={() => onInd(p.code)}>指标</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- 信号历史战绩(180d; 每条信号的历史 1/5/10 日收益 + 5 日胜率 = 规则的「证据」) ----
function StatsCard() {
  const [st, setSt] = useState<SignalStatsPayload | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    fetchSignalStats().then(setSt).catch((e) => setErr(String(e)));
  }, []);
  if (err) return <div className="err">战绩加载失败: {err}</div>;
  if (!st) {
    return (
      <div className="card">
        <h3>信号历史战绩 <span>· 首查需扫 8.5M 行窗口函数 ~8s</span></h3>
        <div className="kv">计算中…</div>
      </div>
    );
  }
  if (!st.ok) return <div className="err">战绩查询失败: {st.reason}</div>;
  return (
    <div className="card">
      <h3>信号历史战绩(近 {st.window}) <span>· {st.note}</span></h3>
      <table>
        <thead>
          <tr><th>信号</th><th>事件数</th><th>1日均</th><th>5日均</th><th>10日均</th><th>5日胜率</th></tr>
        </thead>
        <tbody>
          {st.signals.map((s) => {
            const w = s.win5;
            const wTone = w == null ? "" : w >= 50 ? "up" : w >= 45 ? "" : "down";
            return (
              <tr key={s.sig}>
                <td className="name">{s.sig}</td>
                <td>{s.n.toLocaleString()}</td>
                <td className={cls(s.r1 ?? 0)}>{s.r1 == null ? "—" : s.r1.toFixed(2) + "%"}</td>
                <td className={cls(s.r5 ?? 0)}>{s.r5 == null ? "—" : s.r5.toFixed(2) + "%"}</td>
                <td className={cls(s.r10 ?? 0)}>{s.r10 == null ? "—" : s.r10.toFixed(2) + "%"}</td>
                <td className={wTone}>{w == null ? "—" : w.toFixed(1) + "%"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- 数据新鲜度 (K线/资产快照/模拟仓 时间戳 + 前端算滞后天数, 一眼看出哪份数据停了) ----
// ISO 时间戳展示: 去掉 "T" 分隔符 (2026-10-26T19:55:21 → 2026-10-26 19:55:21)
function fmtTs(s: string | null | undefined, noTime = false): string {
  if (!s) return "—";
  const t = s.replace("T", " ");
  return noTime ? t.slice(0, 10) : t;
}
function freshLag(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const days = Math.floor((Date.now() - t) / 86400000);
  return days <= 0 ? "今天" : days + " 天前";
}
function freshTone(iso: string | null | undefined, warnDays = 2): string {
  const lag = freshLag(iso);
  if (lag == null || lag === "今天") return "up";
  const days = parseInt(lag, 10);
  if (days <= warnDays) return "";
  return "down";
}

export function FreshnessCard() {
  const [fr, setFr] = useState<Freshness | null>(null);
  useEffect(() => { fetchFreshness().then(setFr).catch(() => {}); }, []);
  if (!fr || !fr.ok) return null;
  const rows: [string, string, string, string][] = [
    ["日 K / ETL 主库", "最新交易日", fr.analysis_latest ?? "—", fr.analysis_latest ?? ""],
    ["资产快照", "updated_at", fmtTs(fr.snapshot_updated_at), fr.snapshot_updated_at ?? ""],
    ["模拟仓", "updated_at", fmtTs(fr.paper_updated_at), fr.paper_updated_at ?? ""],
  ];
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <h3>数据新鲜度 <span>· 哪份数据停在什么时候</span></h3>
      <table>
        <thead><tr><th>数据源</th><th>时间戳</th><th>距今</th></tr></thead>
        <tbody>
          {rows.map(([label, tsLabel, ts, iso]) => (
            <tr key={label}>
              <td className="name">{label} <span style={{ color: "var(--faint)", fontWeight: 400 }}>{tsLabel}</span></td>
              <td>{ts}</td>
              <td className={freshTone(iso, label === "资产快照" ? 2 : 2)}>{freshLag(iso) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="note" style={{ marginTop: 6 }}>滞后 &gt;2 天的数据源会用红色高亮。资产快照/模拟仓由宿主 stock-analyzer 的 launchd 每日 18:30 刷新, 突然变红说明那条链路断了。</div>
    </div>
  );
}

// ---- 模拟仓 (读 stock-analyzer paper_portfolio.json + 实时行情, 现算浮动盈亏/止损/止盈) ----
function PaperTab({ onStock }: Openers) {
  const [pk, setPk] = useState<PaperPayload | null>(null);
  const [err, setErr] = useState("");
  const load = () => { setErr(""); fetchPaper().then(setPk).catch((e) => setErr(String(e))); };
  useEffect(() => { load(); }, []);
  if (err) return <div className="err">模拟仓加载失败: {err}</div>;
  if (!pk) return <div className="card"><div className="kv">加载中…</div></div>;
  if (!pk.ok) return <div className="card"><div className="kv" style={{ color: "var(--down)" }}>{pk.reason}</div></div>;

  const pos = pk.positions ?? [];
  const totalCls = cls(pk.total_pnl_pct ?? 0);
  return (
    <>
      <div className="card">
        <h3>模拟仓总览 <span>· 更新 {fmtTs(pk.updated_at)} · 已平仓 {pk.closed ?? 0} 笔 · 挂单 {pk.pending?.length ?? 0}</span></h3>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 6 }}>
          {[
            ["初始资金", (pk.initial_capital ?? 0).toLocaleString(), ""],
            ["可用现金", (pk.cash ?? 0).toLocaleString(), ""],
            ["持仓市值", pos.reduce((s, p) => s + ((p.price ?? 0) * (p.shares ?? 0)), 0).toLocaleString(undefined, { maximumFractionDigits: 0 }), ""],
            ["总权益", (pk.equity ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }), totalCls],
            ["累计盈亏", (pk.total_pnl ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }), totalCls],
            ["累计盈亏率", (pk.total_pnl_pct ?? 0).toFixed(2) + "%", totalCls],
          ].map(([k, v, c]) => (
            <div key={k as string} className="perf-cell" style={c === "down" ? { color: "var(--down)" } : c === "up" ? { color: "var(--up)" } : undefined}>
              <div className="perf-label">{k}</div>
              <div className="perf-val">{v}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>当前持仓 {pos.length} 只 <span>· 现价走腾讯实时源(15s 缓存), 盈亏/止损/止盈现场计算</span></h3>
        {pos.length === 0 ? <div className="kv">无持仓</div> : (
          <table>
            <thead>
              <tr><th>代码</th><th>名称</th><th>买入日</th><th>成本</th><th>现价</th><th>浮动盈亏</th><th>盈亏%</th><th>止损/止盈</th><th>操作</th></tr>
            </thead>
            <tbody>
              {pos.map((p) => (
                <PaperRow key={p.code} p={p} onStock={onStock} />
              ))}
            </tbody>
          </table>
        )}
        {(pk.pending?.length ?? 0) > 0 && (
          <div style={{ marginTop: 10 }}>
            <b>挂单 {pk.pending!.length}</b>
            <div className="note">{pk.pending!.map((o) => `${o.side} ${o.code} ${o.signal_date} — ${o.reason}`).join(" · ")}</div>
          </div>
        )}
      </div>
    </>
  );
}

function PaperRow({ p, onStock }: { p: PaperPosition; onStock: (c: string) => void }) {
  const pnlCls = cls(p.upnl ?? 0);
  const stopChip = p.stop_hit === true
    ? <span className="chip red" title={`现价已跌破 -${((p.stop_loss ?? 0) * 100).toFixed(0)}% 止损线`}>触发止损</span>
    : p.target_hit === true
      ? <span className="chip green" title={`现价已涨超 +${((p.take_profit ?? 0) * 100).toFixed(0)}% 止盈线`}>触发止盈</span>
      : null;
  return (
    <tr className="rowlink" onClick={() => onStock(p.code)}>
      <td style={{ cursor: "pointer" }}>{p.code}</td>
      <td className="name">{p.name || "—"}</td>
      <td>{p.buy_date ?? "—"}</td>
      <td>{(p.buy_price ?? 0).toFixed(2)}</td>
      <td>
        {p.suspended ? <span className="chip gray">停牌</span>
          : p.price == null ? <span className="cold-hint" title={p.realtime_ok ? "无实时价" : "实时源不可用, 用库内收盘"}>—</span>
          : <Num v={p.price} />}
      </td>
      <td className={pnlCls}>{p.upnl == null ? "—" : (p.upnl >= 0 ? "+" : "") + p.upnl.toFixed(0)}</td>
      <td className={pnlCls}>{p.upnl_pct == null ? "—" : (p.upnl_pct >= 0 ? "+" : "") + p.upnl_pct.toFixed(1) + "%"}</td>
      <td>{stopChip ?? <span style={{ color: "var(--faint)" }}>(±{(p.stop_loss ?? 0) * 100 || 0}/{(p.take_profit ?? 0) * 100 || 0}%)</span>}</td>
      <td style={{ whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
        <button className="ghost" onClick={() => onStock(p.code)}>个股</button>
      </td>
    </tr>
  );
}

// ---- Tab 3: 个股 K 线 + 指标 ----
// seed: 共享的「当前个股」(与指标页跟随); onQuery: 本页手动查询后上报, 供指标页跟随
function StockTab({ seed, onQuery }: { seed?: string; onQuery?: (code: string) => void }) {
  const [code, setCode] = useState("sh600519");
  const [days, setDays] = useState("120");
  const [showAll, setShowAll] = useState(false);
  const [data, setData] = useState<StockPayload | null>(null);
  const [err, setErr] = useState("");
  const lastAuto = useRef("");

  const load = (c: string, d: string) => {
    setErr("");
    setShowAll(false);   // 每次新查询回到「最近 30 行」视图
    fetchStock(c, Number(d)).then(setData).catch((e) => setErr(String(e)));
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    load(code, days);
    lastAuto.current = code;   // 避免 onQuery 回写 seed 触发 effect 重复加载
    onQuery?.(code);
  };
  // 共享 seed 变化(从指标页/信号页跟过来): 带入代码并自动查询
  useEffect(() => {
    if (seed && seed !== lastAuto.current) {
      lastAuto.current = seed;
      setCode(seed);
      load(seed, days);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  return (
    <>
      <form className="filters" onSubmit={submit}>
        <label>代码 <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="sh600519 / 600519" /></label>
        <label>天数 <input value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 80 }} /></label>
        <button className="primary" type="submit">查询</button>
      </form>
      {err && <div className="err">{err}</div>}
      {data && data.days > 0 && (
        <>
          <div className="summary-bar">
            <div className="kv" style={{ fontSize: 15 }}>
              <span className="name">{data.name ? data.name + " " : ""}{data.code}</span>
            </div>
            <div className="kv">近 {data.days} 个交易日(升序) · 数据截至 {data.series[data.series.length - 1]?.date ?? "—"}</div>
          </div>
          <RealtimeCard code={data.code} />
          <div className="card">
            <div className="series" style={{ maxHeight: 480, overflow: "auto", padding: 0 }}>
              <table>
                <thead>
                  <tr><th>日期</th><th>开</th><th>收</th><th>低/高</th><th>量(万)</th><th>涨跌%</th><th>MA5</th><th>MA20</th><th>RSI</th><th>MACD</th></tr>
                </thead>
                <tbody>
                  {(showAll ? data.series : data.series.slice(-30)).map((r) => (
                    <tr key={r.date}>
                      <td>{r.date}</td>
                      <td><Num v={r.open} /></td>
                      <td><Num v={r.close} /></td>
                      <td><Num v={r.low} /> / <Num v={r.high} /></td>
                      <td>{r.volume == null ? "—" : (r.volume / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}</td>
                      <td className={cls(r.change_percent)}><Num v={r.change_percent} /></td>
                      <td><Num v={r.ma5} hint="上市不足5日" /></td>
                      <td><Num v={r.ma20} hint="上市不足20日" /></td>
                      <td><Num v={r.rsi} hint="不足14日" /></td>
                      <td><Num v={r.macd} digits={3} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.series.length > 30 && (
                <button className="ghost toggle-all" onClick={() => setShowAll(!showAll)}>
                  {showAll ? "收起(只留最近 30 行)" : `展开全部 ${data.series.length} 行`}
                </button>
              )}
            </div>
          </div>
        </>
      )}
      {data && data.days === 0 && <div className="kv">未找到 {code} 的 K 线(确认带市场前缀 sh/sz/bj)</div>}
    </>
  );
}

// ---- Tab 4: 实时技术指标(Lume 内建现算)----
// seed: 共享的「当前个股」(与个股页跟随); onQuery: 本页手动计算后上报, 供个股页跟随
function IndicatorsTab({ seed, onQuery }: { seed?: string; onQuery?: (code: string) => void }) {
  const [code, setCode] = useState("sh600519");
  const [days, setDays] = useState("200");
  const [period, setPeriod] = useState("9");
  const [data, setData] = useState<IndicatorsPayload | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const lastAuto = useRef("");

  const load = (c?: string) => {
    const target = c ?? code;
    setErr("");
    setLoading(true);
    fetchIndicators(target, Number(days) || 200, Number(period) || 9)
      .then(setData)
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  };
  // 共享 seed 变化(从个股页/信号页跟过来): 带入代码并自动计算(显式传 seed 避开闭包旧值)
  useEffect(() => {
    if (seed && seed !== lastAuto.current) {
      lastAuto.current = seed;
      setCode(seed);
      load(seed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);
  const submitInd = () => {
    load();
    lastAuto.current = code;   // 本页手动算过, 记录以区分 seed 自动跟随
    onQuery?.(code);
  };

  return (
    <>
      <form className="filters" onSubmit={(e) => { e.preventDefault(); submitInd(); }}>
        <label>代码 <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="sh600519 / 600519" /></label>
        <label>天数 <input value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 70 }} /></label>
        <label>KDJ/ATR 周期 <input value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: 70 }} /></label>
        <button className="primary" type="submit" disabled={loading}>{loading ? "…" : "计算"}</button>
      </form>
      {err && <div className="err">{err}</div>}
      {data?.note && <div className="kv" style={{ color: "var(--warn)" }}>{data.note}</div>}
      {data && data.kdj && (
        <>
          <div className="summary-bar">
            <div className="kv" style={{ fontSize: 15 }}>
              <span className="name">{data.name ? data.name + " " : ""}{data.code}</span>
            </div>
            <div className="kv">Lume 内建现算(不依赖 ETL 指标列) · 截至 {data.dates[data.dates.length - 1] ?? "—"} · {data.days} 日 · 周期 {data.period}</div>
          </div>
          {data.lume_signals.length > 0 && (
            <div className="card">
              <h3>Lume 信号判定(基于刚算出的序列尾值)</h3>
              <Chips items={data.lume_signals} />
            </div>
          )}
          {data.performance && (
            <div className="card">
              <h3>绩效 / 风险(日收益率, 年化 ×{Math.sqrt(252).toFixed(2)})</h3>
              <div className="perf-grid">
                <Perf label="累计收益%" v={data.performance.cumulative} />
                <Perf label="年化收益%" v={data.performance.annualized_return} />
                <Perf label="年化波动%" v={data.performance.annualized_vol} />
                <Perf label="夏普" v={data.performance.sharpe} />
                <Perf label="Sortino" v={data.performance.sortino} />
                <Perf label="Calmar" v={data.performance.calmar} />
                <Perf label="最大回撤%" v={data.performance.max_drawdown_pct} plain />
                <Perf label="VaR95(日)%" v={data.performance.var_95} plain />
                <Perf label="CVaR95(日)%" v={data.performance.cvar_95} plain />
              </div>
            </div>
          )}
          <div className="chart-grid cols-2">
            <div className="chart-card">
              <div className="chart-title">
                <div className="chart-labels"><b>价格 + 均线</b><span>收盘 / MA5 / MA20</span></div>
                <Legend labels={["Close", "MA5", "MA20"]} />
              </div>
              <Lines data={[data.closes ?? [], data.ma5, data.ma20]} labels={["Close", "MA5", "MA20"]} />
            </div>
            <div className="chart-card">
              <div className="chart-title">
                <div className="chart-labels"><b>MACD</b><span>12 / 26 / 9</span></div>
                <Legend labels={["MACD", "Signal", "Hist"]} />
              </div>
              <Lines data={[data.macd.line, data.macd.signal, data.macd.hist]} labels={["MACD", "Signal", "Hist"]} />
            </div>
            <div className="chart-card">
              <div className="chart-title">
                <div className="chart-labels"><b>RSI</b><span>Wilder vs Cutler · 14</span></div>
                <Legend labels={["Wilder", "Cutler"]} />
              </div>
              <Lines data={[data.rsi_wilder, data.rsi_cutler]} labels={["Wilder", "Cutler"]} min={0} max={100} />
            </div>
            <div className="chart-card">
              <div className="chart-title">
                <div className="chart-labels"><b>布林带</b><span>20 · 2σ</span></div>
                <Legend labels={["Mid", "Upper", "Lower"]} />
              </div>
              <Lines data={[data.boll.mid, data.boll.upper, data.boll.lower]} labels={["Mid", "Upper", "Lower"]} />
            </div>
            <div className="chart-card">
              <div className="chart-title">
                <div className="chart-labels"><b>KDJ</b><span>period {data.period}</span></div>
                <Legend labels={["K", "D", "J"]} />
              </div>
              <Lines data={[data.kdj.k, data.kdj.d, data.kdj.j]} labels={["K", "D", "J"]} min={-20} max={120} />
            </div>
            <div className="chart-card">
              <div className="chart-title">
                <div className="chart-labels"><b>Williams %R</b><span>period {data.period}</span></div>
              </div>
              <Lines data={[data.williams_r]} labels={["Williams %R"]} min={-100} max={0} />
            </div>
            <div className="chart-card">
              <div className="chart-title">
                <div className="chart-labels"><b>ATR</b><span>period {data.period}</span></div>
              </div>
              <Lines data={[data.atr]} labels={["ATR"]} />
            </div>
            <div className="chart-card">
              <div className="chart-title">
                <div className="chart-labels"><b>OBV</b><span>on-balance volume</span></div>
              </div>
              <Lines data={[data.obv]} labels={["OBV"]} />
            </div>
          </div>
        </>
      )}
      {!data && !loading && <div className="kv">点「计算」从全量库实时算 KDJ / MACD / RSI / 布林 / 绩效风险。</div>}
      {loading && <div className="kv">计算中…</div>}
    </>
  );
}

// ---- Tab: 字段说明(各页 UI 字段/信号/口径的定义, 对照 repo.lume 与 ETL 源码核实) ----
type GlossRow = [field: string, def: string];
const GLOSS_SECTIONS: { title: string; sub: string; rows: GlossRow[] }[] = [
  {
    title: "信号扫描页",
    sub: "信号判定来自 ETL flag 列(stock-analyzer 预计算), 非 Lume 现算",
    rows: [
      ["RSI(ETL·Cutler)", "库 rsi 列, Cutler 口径: 涨/跌各取最近 14 个价变的 rolling(14).mean()"],
      ["RSI(Lume·Cutler)", "Lume 内建 rsi_cutler 现算, 与 ETL 同算法 → Δ0.00 逐位验证移植正确性"],
      ["RSI(Lume·Wilder)", "Lume 内建 rsi(Wilder EMA: SMA 种子 + 递归), 跨平滑口径参考, 与 Cutler 分叉属正常"],
      ["一致性 Δ0.00 / Δx.xx", "Cutler 同口径差 <0.05 记 Δ0.00(绿); ≥0.05 显示实际偏差(金)"],
      ["MACD金叉/死叉", "DIF(12/26 EMA 差) 上/下穿 DEA(9), ETL flag"],
      ["KDJ金叉", "K 上穿 D (RSV 的 1/3 平滑 EMA), ETL flag"],
      ["RSI超卖/超买", "ETL Cutler RSI < 30 / > 70"],
      ["威廉超卖/超买", "Williams %R 破 -80 / 0 区, ETL flag"],
      ["OBV放量", "OBV(顺逆量)斜率突变, ETL flag"],
      ["突破布林上轨/跌破下轨", "收盘 > 布林上轨(20日2σ) / < 下轨, ETL boll_position >1 / <0"],
      ["顶部指数条", "上证/深成/创业板/沪深300 实时点位, 腾讯源 30s 缓存"],
    ],
  },
  {
    title: "规则筛选页",
    sub: "字段来自 asset_snapshot(akshare 每日快照); 无过滤时按量比降序 Top 50",
    rows: [
      ["量比", "当日成交 ÷ 近 5 日均量, 无单位, >2 表示放量"],
      ["换手%", "当日成交量 ÷ 流通股本 ×100"],
      ["总市值(亿) / 流通市值(亿)", "total / float market value, 单位亿元"],
      ["默认视图", "未填条件 = 全市场量比 Top 50(当日最活跃票)"],
    ],
  },
  {
    title: "个股页",
    sub: "K 线表 = 库内 T-1 数据; 实时价卡 = 腾讯源 5s 轮询(服务端 15s 缓存)",
    rows: [
      ["量(万)", "库内 volume 单位是「股」, 显示 ÷10000(茅台 576.9 = 577 万股)"],
      ["MA5 / MA20 / RSI / MACD", "ETL 预计算列(RSI=Cutler, MACD=DIF 12/26/9)"],
      ["「上市不足5日/20日」「不足14日」斜体提示", "rolling 指标冷启动: 上市初期历史长度不够窗口, ETL 计算得 NULL(前 4/19/13 个交易日), 属正常数据行为, 非缺失故障"],
      ["实时卡 量(万手)", "腾讯口径 1 手 = 100 股, 与 K 线表「万股」不同源不同口径"],
      ["停牌 / 降级", "实时价卡: 停牌显示「停牌或无行情」, 上游挂显示「实时获取失败, 展示库内收盘」"],
    ],
  },
  {
    title: "指标页 · 摆动类",
    sub: "全部 Lume 内建现算(读原始 OHLCV, 不读 ETL 列), 周期 = 表单 period 缺省 14",
    rows: [
      ["KDJ · K / D / J", "RSV 的 1/3 平滑 EMA; J = 3K−2D, J>100 超买 / <0 超卖区"],
      ["Williams %R", "收盘在 N 日高低区间的位置, 值域 [−100, 0](0=贴高点, −100=贴低点)"],
      ["ATR", "真实波幅的 N 日均值, 量纲=价格, 衡量波动大小区间"],
      ["OBV", "顺逆量: 涨日累加量、跌日累减, 有符号累计, 看量价配合"],
    ],
  },
  {
    title: "指标页 · 趋势类",
    sub: "前导冷启动段被服务端截掉, 图上各序列按尾部对齐最新交易日",
    rows: [
      ["MA5 / MA10 / MA20", "简单移动均线"],
      ["MACD · line / signal / hist", "DIF(12/26 EMA 差) / DEA(DIF 的 9 日 EMA) / 柱(DIF−DEA)"],
      ["RSI · Wilder / Cutler", "双曲线对照: Wilder 更平滑(EMA), Cutler 更敏感(滚动均值), 与 ETL 列同口径的是 Cutler"],
      ["布林带 · mid / upper / lower", "20 日均 ± 2σ, 贴上轨偏强 / 贴下轨偏弱"],
    ],
  },
  {
    title: "指标页 · 绩效/风险九宫格",
    sub: "基于日收益序列, 年化系数 ×√252≈15.87, 夏普无风险利率取 0",
    rows: [
      ["累计收益% / 年化收益%", "区间总涨幅 / 几何年化"],
      ["年化波动%", "日收益标准差 × √252"],
      ["夏普 / Sortino", "(年化−0)÷年化波动; Sortino 分母只算下行标准差"],
      ["Calmar", "年化收益 ÷ 最大回撤"],
      ["最大回撤%", "峰值到谷底最大跌幅"],
      ["VaR95(日) / CVaR95(日)", "95% 置信单日预期损失 / 超 VaR 那 5% 的平均损失(尾部, ≥VaR)"],
    ],
  },
  {
    title: "Lume 信号判定(指标页)",
    sub: "基于刚算出序列的「尾值」, 与信号页 ETL 口径互相独立, 可互验",
    rows: [
      ["MACD金叉/死叉(Lume)", "DIF 与 DEA 尾两根交叉(用刚现算的 MACD)"],
      ["RSI超卖/超买(Wilder 14)", "现算 Wilder RSI < 30 / > 70"],
      ["破布林上/下轨", "最新收盘 > upper / < lower"],
      ["KDJ金叉", "K 上穿 D(尾两根)"],
    ],
  },
  {
    title: "通用约定",
    sub: "",
    rows: [
      ["配色", "A 股习惯: 红涨绿跌"],
      ["行点击", "信号/筛选表整行可点 → 个股页; 「个股/指标」按钮 → 对应 tab(代码自动带入)"],
      ["数据时效", "K线/指标/信号 = 库内 T-1(每日 18:30 launchd ETL 更新); 指数条/实时卡 = 盘中准实时"],
    ],
  },
];

function GlossaryTab() {
  return (
    <div className="glossary">
      {GLOSS_SECTIONS.map((s) => (
        <div className="card" key={s.title}>
          <h3>{s.title}{s.sub ? <span> · {s.sub}</span> : null}</h3>
          <table>
            <tbody>
              {s.rows.map(([f, d]) => (
                <tr key={f}>
                  <td className="gloss-field">{f}</td>
                  <td>{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

// ---- Tab 6: 数据源 ----
function AboutTab() {
  const [meta, setMeta] = useState<Meta | null>(null);
  useEffect(() => { fetchMeta().then(setMeta).catch(() => setMeta(null)); }, []);
  if (!meta) return <div className="kv">数据源信息加载中…</div>;
  return (
    <div className="card">
      <h3>数据源</h3>
      <div className="kv" style={{ margin: 0 }}>
        最新交易日: <b>{meta.latest_date ?? "—"}</b><br />
        标的数: {meta.stocks} · 分析行数: {meta.analysis_rows} · 资产快照行数: {meta.asset_rows}<br />
        架构: Lume 单二进制(C11) 只读 SQLite;信号计算在 Python stock-analyzer ETL 端(宿主 launchd 每日 18:30 自动增量更新)。
      </div>
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("signals");
  const [meta, setMeta] = useState<Meta | null>(null);
  // 共享的「当前个股」: 个股页与指标页互相跟随。
  // - 从信号/筛选点入: 设为该代码并切 tab;
  // - 在某页手动查询/计算后, 回写 focus, 另一页切过来时自动展示同一只票。
  const [focus, setFocus] = useState("");
  useEffect(() => { fetchMeta().then(setMeta).catch(() => {}); }, []);
  const openStock = (code: string) => { setFocus(code); setTab("stock"); };
  const openInd = (code: string) => { setFocus(code); setTab("indicators"); };
  // 某页手动操作后回调: 更新共享 focus(若与该页 seed 相同, 页面内 lastAuto 守卫会跳过重载)
  const query = (code: string) => setFocus(code);
  const tabs: [Tab, string][] = [
    ["signals", "信号扫描"],
    ["screen", "规则筛选"],
    ["stock", "个股"],
    ["indicators", "指标"],
    ["paper", "模拟仓"],
    ["chat", "AI 聊天"],
    ["glossary", "字段说明"],
    ["about", "数据源"],
  ];
  const active = useMemo(() => tabs.find(([t]) => t === tab)?.[1] ?? "", [tab]);
  return (
    <div className="app">
      <div className="hero">
        <h1>Signal Scanner</h1>
        <div className="meta">{meta?.latest_date ? `数据截至 ${meta.latest_date}` : "加载中"}</div>
      </div>
      <div className="tabs">
        {tabs.map(([t, label]) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{label}</button>
        ))}
      </div>
      <div style={{ marginTop: 14 }}>
        {tab === "signals" && (<><FreshnessCard /><SignalsTab onStock={openStock} onInd={openInd} /></>)}
        {tab === "screen" && <ScreenTab onStock={openStock} onInd={openInd} />}
        {tab === "stock" && <StockTab seed={focus} onQuery={query} />}
        {tab === "indicators" && <IndicatorsTab seed={focus} onQuery={query} />}
        {tab === "paper" && <PaperTab onStock={openStock} onInd={openInd} />}
        {tab === "chat" && <ChatTab />}
        {tab === "glossary" && <GlossaryTab />}
        {tab === "about" && <AboutTab />}
      </div>
      <div className="note">{active === "信号扫描" ? "MACD/KDJ 金叉、RSI/威廉超买卖、布林带突破、OBV 放量口径同 stock-analyzer ETL" : ""}</div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
