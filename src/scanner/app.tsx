import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  fetchMeta, fetchSignals, fetchScreen, fetchStock, fetchIndicators,
  fetchRealtime, fetchIndexes, fetchSignalStats, fetchDailyPicks,
  fetchPaper, fetchFreshness,
  type Meta, type SignalPayload, type ScreenPayload, type StockPayload, type Filters, type IndicatorsPayload,
  type KlineRow,
  type Realtime, type RealtimeIndexes, type SignalStatsPayload, type DailyPicksPayload,
  type PaperPayload, type PaperPosition, type Freshness,
} from "./api";
import { ChatTab } from "./chat";

type Tab = "signals" | "screen" | "stock" | "indicators" | "paper" | "chat" | "glossary" | "about";
const TABS: [Tab, string][] = [
  ["signals", "信号扫描"],
  ["screen", "规则筛选"],
  ["stock", "个股"],
  ["indicators", "指标"],
  ["paper", "模拟仓"],
  ["chat", "AI 聊天"],
  ["glossary", "字段说明"],
  ["about", "数据源"],
];

// ---- 交易时段门控: 仅工作日 09:30-11:30 / 13:00-15:00(Asia/Shanghai)盘中轮询, 否则停 ----
// 收盘后腾讯价已冻结, 继续 5s/30s 轮询只浪费且让用户误以为在动; 门控后停轮询并标注时段。
// 跑在浏览器: 取 viewer 本地 new Date(), 换算成 UTC+8 墙钟(A股按沪市时区判定), 与 viewer 所在时区无关。
function isTradingNow(now0 = new Date()): boolean {
  const cst = new Date(now0.getTime() + 8 * 3600 * 1000);
  const wd = cst.getUTCDay(); // 周一1 ... 周日0
  if (wd === 0 || wd === 6) return false;
  const mins = cst.getUTCHours() * 60 + cst.getUTCMinutes();
  return (mins >= 570 && mins <= 690) || (mins >= 780 && mins <= 900);
}

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
  // 客户端信号类别筛选: 点 chip 只显示含该信号的行(多类别 OR); 纯前端零接口。
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [minSig, setMinSig] = useState(2); // 共振度阈值: 默认只看同时命中≥2个信号的票
  // 视图切换: 表格(全字段精读) / 卡片(快速浏览 80 只); 选择记 localStorage 跨刷新保留
  const [view, setView] = useState<"table" | "card">(() => {
    try { return localStorage.getItem("sigview") === "card" ? "card" : "table"; } catch { return "table"; }
  });
  const switchView = (v: "table" | "card") => {
    setView(v);
    try { localStorage.setItem("sigview", v); } catch {}
  };
  const togg = (k: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const [err, setErr] = useState("");
  useEffect(() => {
    setSel(new Set());
    fetchSignals(80, minSig).then(setData).catch((e) => setErr(String(e)));
  }, [minSig]);
  if (err) return <div className="err">加载失败: {err}</div>;
  if (!data) return <div className="kv">加载中…</div>;
  // total=全市场带信号总数(未截断), 老后端无 total 时降级为 count
  const total = data.total ?? data.count;
  if (total === 0) return <div className="kv">{data.note ?? "当日无信号"}</div>;
  // 全市场各类别命中数(SQL 条件聚合, 未截断)。只展示 >0 的类别; 老后端无 sig_counts 时降级为按返回行统计。
  const cats = new Map<string, number>();
  if (data.sig_counts && Object.keys(data.sig_counts).length) {
    for (const [k, c] of Object.entries(data.sig_counts)) if (c > 0) cats.set(k, c);
  } else {
    for (const s of data.signals) for (const k of s.signals) cats.set(k, (cats.get(k) ?? 0) + 1);
  }
  const activeCats = sel.size ? Array.from(sel) : null;
  const rows = activeCats
    ? data.signals.filter((s) => s.signals.some((k) => sel.has(k)))
    : data.signals;
  return (
    <>
      <IndexTicker />
      <PicksCard onStock={onStock} onInd={onInd} />
      <StatsCard />
      <div className="card">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, margin: "4px 0" }}>
        <h3 style={{ margin: 0, flex: 1, minWidth: 260 }}>截至 {data.date} · 全市场 {total} 只带信号 · 当前显示前 {data.count} 条(按共振度降序)</h3>
        <span style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
          <button className="ghost" style={{ border: "none", background: view === "table" ? "var(--accent-soft)" : "transparent", color: view === "table" ? "var(--blue)" : "var(--muted)" }} onClick={() => switchView("table")} title="逐行全字段, 适合精读 RSI 三口径">表格</button>
          <button className="ghost" style={{ border: "none", background: view === "card" ? "var(--accent-soft)" : "transparent", color: view === "card" ? "var(--blue)" : "var(--muted)" }} onClick={() => switchView("card")} title="卡片网格, 快速浏览 80 只">卡片</button>
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", margin: "6px 0" }}>
        <span className="dim" style={{ fontSize: 12 }}>共振度</span>
        {[1, 2, 3, 4, 5].map((m) => {
          const d = data.dist;
          const c = m === 1 ? total : m === 2 ? (d?.g2 ?? 0) : m === 3 ? (d?.g3 ?? 0) : m === 4 ? (d?.g4 ?? 0) : (d?.g5 ?? 0);
          return (
            <button key={m} className="ghost"
              style={minSig === m ? { borderColor: "var(--up)", color: "var(--up)" } : {}}
              onClick={() => setMinSig(m)}>
              ≥{m}{c > 0 ? ` · ${c}` : ""}
            </button>
          );
        })}
        <span className="dim" style={{ fontSize: 12, marginLeft: 4 }} title="同时命中≥N个信号的股票数(全市场, SQL 条件聚合)。≥1 占 83% 无信息量, 共振 ≥2/≥3 才有筛选价值">· 单信号无信息量, 看共振</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", margin: "6px 0" }}>
        <span className="dim" style={{ fontSize: 12 }}>类别</span>
        {[...cats.entries()].map(([k, c]) => (
          <button
            key={k}
            className="ghost"
            style={sel.has(k) ? { borderColor: "var(--up)", color: "var(--up)" } : {}}
            onClick={() => togg(k)}
          >
            {k} · {c}
          </button>
        ))}
        {sel.size > 0 && (
          <button className="ghost" style={{ color: "var(--faint)" }} onClick={() => setSel(new Set())}>
            清除({rows.length}/{data.count})
          </button>
        )}
        {sel.size === 0 && <span className="dim" style={{ fontSize: 12 }}>· 点类别可筛选</span>}
      </div>
      {view === "card" && (
        <div className="sig-cards">
          {rows.length === 0 && (
            <div className="dim" style={{ padding: 18, textAlign: "center" }}>
              所选类别今日无命中 · <a style={{ color: "var(--up)", cursor: "pointer" }} onClick={() => setSel(new Set())}>清除筛选</a>
            </div>
          )}
          {rows.map((s) => {
            const up = (s.change ?? 0) >= 0;
            return (
              <div key={s.code} className="sig-card" onClick={() => onStock(s.code)}>
                <div className="sc-top">
                  <span className="sc-code">{s.code}</span>
                  <span className="sc-name">{s.name || "—"}</span>
                  <span className={`sc-reso ${s.sig_cnt >= 4 ? "hot" : ""}`} title={`同时命中 ${s.sig_cnt ?? s.signals.length} 个信号`}>
                    {s.sig_cnt ?? s.signals.length}信号
                  </span>
                </div>
                <div className="sc-price">
                  <span>{(s.close ?? 0).toFixed(2)}</span>
                  <span className={cls(s.change ?? 0)}>{up ? "▲" : "▼"} {Math.abs(s.change ?? 0).toFixed(2)}%</span>
                </div>
                <div className="sc-mid">
                  <span title="RSI(ETL·Cutler)">RSI <Num v={s.rsi} /></span>
                  <span title="RSI(Lume·Cutler, 与 ETL 同口径, Δ≈0 验证移植正确性)">
                    {s.rsi_lume == null ? "—" : s.rsi_match === "match"
                      ? <span className="chip green">Δ0.00</span>
                      : <span className="chip gold">Δ{Math.abs((s.rsi_lume ?? 0) - s.rsi).toFixed(2)}</span>}
                  </span>
                </div>
                <div className="sc-chips"><Chips items={s.signals} /></div>
                <div className="sc-act" onClick={(e) => e.stopPropagation()}>
                  <button className="ghost" onClick={() => onStock(s.code)}>个股</button>{" "}
                  <button className="ghost" onClick={() => onInd(s.code)}>指标</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {view === "table" && (
      <table>
        <thead>
          <tr><th>代码</th><th>名称</th><th>收盘</th><th>涨跌%</th><th title="同时命中几个信号(0-9), 按此降序">共振</th><th>RSI(ETL·Cutler)</th><th>RSI(Lume·Cutler)</th><th>RSI(Lume·Wilder)</th><th>一致性</th><th>信号</th><th>操作</th></tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={11} className="dim" style={{ textAlign: "center", padding: 18 }}>
              所选类别今日无命中 · <a style={{ color: "var(--up)", cursor: "pointer" }} onClick={() => setSel(new Set())}>清除筛选</a>
            </td></tr>
          )}
          {rows.map((s) => (
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
      )}
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
  const [trading, setTrading] = useState(isTradingNow);
  useEffect(() => {
    const c = setInterval(() => setTrading(isTradingNow()), 30000);
    return () => clearInterval(c);
  }, []);
  useEffect(() => {
    let live = true;
    const tick = () => fetchRealtime(code).then((d) => { if (live) setRt(d); }).catch(() => {});
    tick();
    // 非交易时段停止高频轮询(收盘后价已冻结), 仅在盘中 5s 刷新
    const t = trading ? setInterval(tick, 5000) : null;
    return () => { live = false; if (t) clearInterval(t); };
  }, [code, trading]);
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
        <span className="dim">{rt.quote_time ? fmtT(rt.quote_time) : ""} · {trading ? "5s 刷新" : "非交易时段已停刷新"}</span>
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

// ---- 四大指数条(30s 轮询; 信号页顶部; 非交易时段停止刷新并标注) ----
function IndexTicker() {
  const [ix, setIx] = useState<RealtimeIndexes | null>(null);
  const [trading, setTrading] = useState(isTradingNow);
  useEffect(() => {
    const c = setInterval(() => setTrading(isTradingNow()), 30000);
    return () => clearInterval(c);
  }, []);
  useEffect(() => {
    let live = true;
    const tick = () => fetchIndexes().then((d) => { if (live) setIx(d); }).catch(() => {});
    tick();
    const t = trading ? setInterval(tick, 30000) : null;
    return () => { live = false; if (t) clearInterval(t); };
  }, [trading]);
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
      {!trading && (
        <div className="ticker-item" style={{ borderColor: "var(--faint)" }} title="工作日 09:30-11:30 / 13:00-15:00 外停止刷新">
          <span className="dim">已定格 · 非交易时段</span>
        </div>
      )}
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
    ["资产快照", "更新时间", fmtTs(fr.snapshot_updated_at), fr.snapshot_updated_at ?? ""],
    ["模拟仓", "更新时间", fmtTs(fr.paper_updated_at), fr.paper_updated_at ?? ""],
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
            <div className="note" style={{ display: "none" }} />
            <table style={{ marginTop: 4 }}>
              <thead><tr><th>方向</th><th>代码</th><th>名称</th><th>信号日</th><th>原因</th></tr></thead>
              <tbody>
                {pk.pending!.map((o, i) => (
                  <tr key={i}>
                    <td>{o.side === "buy"
                      ? <span className="chip gold">买入</span>
                      : <span className="chip red">卖出</span>}</td>
                    <td>{o.code}</td>
                    <td className="name">{o.name || "—"}</td>
                    <td>{o.signal_date}</td>
                    <td>{o.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="note">挂单 = 自动交易已决策、待下次 paper-auto 运行成交的指令</div>
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

// ---- 蜡烛图(个股页标配: 红涨绿跌 K 线 + MA5/MA20 叠加 + 成交量副图; 零依赖 SVG)----
function CandleChart({ series }: { series: KlineRow[] }) {
  const [n, setN] = useState(60); // 显示根数: 30 / 60 / 全
  const [hover, setHover] = useState<number | null>(null);   // 十字光标: 悬停的蜡烛序号
  const [hoverY, setHoverY] = useState<number | null>(null); // 十字光标: 横线 Y(仅价格区)
  const svgRef = useRef<SVGSVGElement | null>(null);
  const pick = (v: number) => { setN(v); setHover(null); setHoverY(null); };
  const view = (n === 0 ? series : series.slice(-n)).filter((r) => r.high != null && r.low != null);
  if (view.length === 0) return null;
  const W = 720, mainH = 180, volH = 52, top = 10, gap = 22, labelH = 20;
  const H = top + mainH + gap + volH + labelH;
  const x0 = 48, x1 = W - 10, plotW = x1 - x0;
  const slot = plotW / view.length;
  const cw = Math.max(2, Math.min(14, slot * 0.55));
  const px = (i: number) => x0 + slot * (i + 0.5);
  // 价格域: 高低点 + 均线(非空), 上下各留 5% 边距
  let lo = Infinity, hi = -Infinity;
  for (const r of view) {
    if (r.ma5 != null) { lo = Math.min(lo, r.ma5); hi = Math.max(hi, r.ma5); }
    if (r.ma20 != null) { lo = Math.min(lo, r.ma20); hi = Math.max(hi, r.ma20); }
    lo = Math.min(lo, r.low); hi = Math.max(hi, r.high);
  }
  if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
  const pad = (hi - lo) * 0.05 || 1;
  lo -= pad; hi += pad;
  const span = hi - lo;
  const y = (v: number) => top + mainH - ((v - lo) / span) * mainH;
  const vtop = top + mainH + gap; // 成交量区顶
  const vmax = Math.max(...view.map((r) => r.volume ?? 0), 1);
  const maPts = (get: (r: KlineRow) => number | null | undefined) =>
    view.map((r, i) => {
      const v = get(r);
      return v == null ? null : `${px(i).toFixed(1)},${y(v).toFixed(1)}`;
    }).filter(Boolean).join(" ");
  const xticks = Array.from(new Set([0, 1, 2, 3, 4, 5].map((j) => Math.round((j * (view.length - 1)) / 5))));
  const last = view[view.length - 1];
  const lastUp = (last.close ?? 0) >= (last.open ?? 0);
  // 十字光标: 鼠标 X → 最近蜡烛序号; 只有指针在价格区(上)内才显示横线
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    const vx = ((e.clientX - box.left) / box.width) * W;
    const vy = ((e.clientY - box.top) / box.height) * H;
    const i = Math.max(0, Math.min(view.length - 1, Math.round((vx - x0) / slot - 0.5)));
    setHover(i);
    setHoverY(vy >= top && vy <= top + mainH ? vy : null);
  };
  const onLeave = () => { setHover(null); setHoverY(null); };
  // 读数条: 悬停显示该日 OHLC, 不悬停显示最新日; 量(万手)
  const rd = hover != null ? view[hover] : last;
  const rdUp = (rd.close ?? 0) >= (rd.open ?? 0);
  const rdCls = hover != null ? (rdUp ? "up" : "down") : "";
  // 横线对应的价格(仅悬停横线时): 屏幕 Y → 价格
  const hoverPrice = hoverY != null ? lo + (top + mainH - hoverY) / mainH * span : null;
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
        <div className="chart-labels" style={{ margin: 0 }}>
          <b>K 线图</b>
          <span style={{ display: "inline-flex", gap: 16, alignItems: "center", marginLeft: 16 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <i style={{ display: "inline-block", width: 14, borderTop: "2px solid #d29922" }} /> MA5
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <i style={{ display: "inline-block", width: 14, borderTop: "2px solid #bc8cff" }} /> MA20
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <i style={{ display: "inline-block", width: 14, borderTop: "2px dashed #58a6ff" }} /> 最新价
            </span>
          </span>
        </div>
        <span style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }} title="K 线图显示根数(列表仍受上方「天数」控制)">
          {[30, 60, 0].map((v) => (
            <button key={v} className="ghost"
              style={{ border: "none", background: n === v ? "var(--accent-soft)" : "transparent", color: n === v ? "var(--blue)" : "var(--muted)", padding: "2px 8px" }}
              onClick={() => pick(v)}>{v === 0 ? "全" : `${v}根`}</button>
          ))}
        </span>
      </div>
      <div className="candle-readout" title="移动鼠标看当日 OHLC">
        <span className="dim">{rd.date}</span>
        <span>开 <b className={rdCls}>{(rd.open ?? 0).toFixed(2)}</b></span>
        <span>高 <b className={rdUp ? "up" : ""}>{(rd.high ?? 0).toFixed(2)}</b></span>
        <span>低 <b className={rdUp ? "" : "down"}>{(rd.low ?? 0).toFixed(2)}</b></span>
        <span>收 <b className={rdCls}>{(rd.close ?? 0).toFixed(2)}</b></span>
        <span className={cls(rd.change_percent ?? 0)}>
          {(rd.change_percent ?? 0) >= 0 ? "+" : ""}{(rd.change_percent ?? 0).toFixed(2)}%
        </span>
        <span className="dim">量 {((rd.volume ?? 0) / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}万手</span>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block", cursor: "crosshair" }}
        onMouseMove={onMove} onMouseLeave={onLeave}>
        {/* 4 条价格网格 + 左轴 */}
        {[0, 1, 2, 3].map((g) => {
          const v = lo + (span * g) / 3;
          const yy = y(v);
          return (
            <g key={g}>
              <line x1={x0} x2={x1} y1={yy} y2={yy} stroke="#21262d" strokeDasharray="3 4" />
              <text x={x0 - 4} y={yy + 3.5} fill="#6e7681" fontSize={10} textAnchor="end">{v.toFixed(2)}</text>
            </g>
          );
        })}
        {/* 最新价虚线 */}
        <line x1={x0} x2={x1} y1={y(last.close ?? 0)} y2={y(last.close ?? 0)} stroke={lastUp ? "#f85149" : "#3fb950"} strokeDasharray="5 4" strokeOpacity={0.65} />
        <text x={x1 - 2} y={y(last.close ?? 0) - 4} fill={lastUp ? "#f85149" : "#3fb950"} fontSize={10} textAnchor="end">{(last.close ?? 0).toFixed(2)}</text>
        {/* 蜡烛: 影线 + 实体(红涨绿跌) */}
        {view.map((r, i) => {
          const up = (r.close ?? 0) >= (r.open ?? 0);
          const color = up ? "#f85149" : "#3fb950";
          const bodyTop = y(Math.max(r.open ?? 0, r.close ?? 0));
          const bodyH = Math.max(1, Math.abs(y(r.open ?? 0) - y(r.close ?? 0)));
          return (
            <g key={r.date}>
              <line x1={px(i)} x2={px(i)} y1={y(r.high ?? 0)} y2={y(r.low ?? 0)} stroke={color} strokeWidth={1} />
              <rect x={px(i) - cw / 2} y={bodyTop} width={cw} height={bodyH} fill={color} />
            </g>
          );
        })}
        {/* MA 叠加 */}
        <polyline points={maPts((r) => r.ma5)} fill="none" stroke="#d29922" strokeWidth={1.4} />
        <polyline points={maPts((r) => r.ma20)} fill="none" stroke="#bc8cff" strokeWidth={1.4} />
        {/* 成交量副图 */}
        <line x1={x0} x2={x1} y1={vtop + volH} y2={vtop + volH} stroke="#21262d" />
        <text x={x0 + 2} y={vtop + 10} fill="#6e7681" fontSize={9}>量(万手) · 最大 {((vmax / 10000)).toFixed(0)}</text>
        {view.map((r, i) => {
          const up = (r.close ?? 0) >= (r.open ?? 0);
          const h = Math.max(1, ((r.volume ?? 0) / vmax) * (volH - 14));
          return <rect key={r.date} x={px(i) - cw / 2} y={vtop + volH - h} width={cw} height={h}
            fill={up ? "rgba(248,81,73,.45)" : "rgba(63,185,80,.45)"} />;
        })}
        {/* 日期刻度(6 个, 去重) */}
        {xticks.map((i) => (
          <text key={i} x={px(i)} y={H - 4} fill="#6e7681" fontSize={9} textAnchor="middle">{view[i]?.date?.slice(5)}</text>
        ))}
        {/* 十字光标: 竖线(悬停蜡烛)+ 横线(仅价格区)+ 左轴价格气泡 */}
        {hover != null && (
          <g>
            <line x1={px(hover)} x2={px(hover)} y1={top} y2={vtop + volH} stroke="#8b949e" strokeOpacity={0.55} strokeDasharray="2 3" />
            {hoverY != null && (
              <>
                <line x1={x0} x2={x1} y1={hoverY} y2={hoverY} stroke="#8b949e" strokeOpacity={0.55} strokeDasharray="2 3" />
                <g>
                  <rect x={x0 - 46} y={hoverY - 8} width={44} height={16} rx={3} fill="#21262d" stroke="#30363d" />
                  <text x={x0 - 24} y={hoverY + 3.5} fill="#e6edf3" fontSize={10} textAnchor="middle">
                    {hoverPrice != null ? hoverPrice.toFixed(2) : ""}
                  </text>
                </g>
              </>
            )}
          </g>
        )}
      </svg>
    </div>
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
            <div className="kv">近 {data.days} 个交易日(倒序, 最新在上) · 数据截至 {data.series[data.series.length - 1]?.date ?? "—"}</div>
          </div>
          <RealtimeCard code={data.code} />
          <CandleChart series={data.series} />
          <div className="card">
            <div className="series" style={{ maxHeight: 480, overflow: "auto", padding: 0 }}>
              <table>
                <thead>
                  <tr><th>日期</th><th>开</th><th>收</th><th>低/高</th><th>量(万)</th><th>涨跌%</th><th>MA5</th><th>MA20</th><th>RSI</th><th>MACD</th></tr>
                </thead>
                <tbody>
                  {(showAll ? data.series : data.series.slice(-30)).slice().reverse().map((r) => (
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
// 每条定义都尽量「说人话」: 先说是什么、再给怎么读/举例。
type GlossRow = [field: string, def: string];
const GLOSS_SECTIONS: { title: string; sub: string; rows: GlossRow[] }[] = [
  {
    title: "信号扫描页",
    sub: "页面顶部有指数条; 信号列都是 stock-analyzer 的 ETL 端预先算好存进库的, 页面只负责展示, 不现算",
    rows: [
      ["共振度（命中数）", "这只票当天「同时命中」几个信号。全市场命中≥1 的有 4000+ 只（占 83%），几乎没有筛选价值，所以默认只看 ≥2 个的；命中数越大越值得关注，≥4 会用红色「热点」标记。列表默认展示命中数最高的 80 只。"],
      ["今日精选（打分）", "在「命中≥1」的股票池里，按 信号数 × 量比 × 市值 综合打分取 Top 8，相当于「当天最可能被主力关注、又足够活跃好进出」的一批。"],
      ["RSI(ETL·Cutler)", "库里 rsi 列的值。Cutler 口径 = 最近 14 个「价格涨跌」里，上涨部分的均值 ÷ 下跌部分的均值。是 ETL 端算好存库的。"],
      ["RSI(Lume·Cutler)", "页面用 Lume 内建 rsi_cutler 按「同一套」Cutler 算法再算一遍，专门用来核对 ETL 算得对不对。"],
      ["RSI(Lume·Wilder)", "再按另一套 Wilder 算法（指数平滑，曲线更顺滑）现算，做对照参考。它和 Cutler 差一点是正常的，不代表谁对谁错。"],
      ["一致性 Δ0.00 / Δx.xx", "上面两个 Cutler 口径（ETL 存库 vs 页面现算）的差。差 <0.05 显示「Δ0.00」（绿）= 移植无误；差 ≥0.05 显示实际偏差值（金）= 需要留意。"],
      ["MACD金叉 / 死叉", "MACD 快线上穿慢线=金叉（偏多），下穿=死叉（偏空）。"],
      ["KDJ金叉", "KDJ 指标的 K 线上穿 D 线，随机指标的短线买点信号。"],
      ["RSI超卖 / 超买", "Cutler RSI <30=超卖（跌得有点多了），>70=超买（涨得有点多了）。"],
      ["威廉超卖 / 超买", "Williams %R 指标 < −80=超卖，> −20=超买。注意它的取值区间是 −100~0，数字越小越超卖。"],
      ["OBV放量", "OBV（顺逆量）突然放大，往往代表有资金异动。"],
      ["突破布林上轨 / 跌破下轨", "收盘价突破 20 日布林带（均值±2 倍标准差）的上轨=偏强势；跌破下轨=偏弱势。"],
      ["顶部指数条", "上证指数 / 深证成指 / 创业板指 / 沪深300 的实时点位，腾讯源 30s 缓存。"],
    ],
  },
  {
    title: "规则筛选页",
    sub: "字段来自 asset_snapshot（akshare 每日快照）；一个条件都不填时，直接给你全市场量比最高的 50 只",
    rows: [
      ["量比", "今天每分钟成交量 ÷ 过去 5 天每分钟平均成交量。无单位，>2 代表明显放量、比平时活跃。"],
      ["换手%", "今天成交量 ÷ 流通股本。数值越高代表当天筹码交换越剧烈。"],
      ["总市值(亿) / 流通市值(亿)", "总市值=股价×总股本，流通市值=股价×流通股本，都按亿元显示。"],
      ["默认视图", "啥都不填 = 全市场量比 Top 50，也就是「当天最活跃」的一批票。"],
    ],
  },
  {
    title: "个股页",
    sub: "K 线表 = 库里 T-1（前一天收盘）数据，按最新交易日倒序；实时价卡 = 腾讯源盘中刷新",
    rows: [
      ["量(万)", "库里 volume 的单位是「股」，显示时 ÷10000 换成「万股」。例：576.9 就是 577 万股。"],
      ["MA5 / MA20 / RSI / MACD", "这些列都是 ETL 预先算好存库的（RSI=Cutler 口径，MACD=DIF 12/26/9）。"],
      ["「上市不足5日/20日」「不足14日」斜体提示", "刚上市的票历史不够指标计算窗口，前几个交易日这些指标为空（NULL）。这是正常的数据行为，不是故障。"],
      ["实时卡 量(万手)", "腾讯口径里 1 手 = 100 股，和上面 K 线表的「万股」不是同一个源、不同口径，两个数字不能直接比。"],
      ["停牌 / 降级", "实时价卡：票停牌会显示「停牌或无行情」；上游数据源挂了会显示「实时获取失败，展示库内收盘」。"],
    ],
  },
  {
    title: "模拟仓页",
    sub: "读 stock-analyzer 的 paper_portfolio.json（每日 18:30 paper-auto 自动更新），现价走腾讯实时源，盈亏现场算",
    rows: [
      ["成本", "买入均价（含摊入的手续费）。"],
      ["现价", "腾讯实时源报价（服务端 15s 缓存）。"],
      ["浮动盈亏 / 盈亏%", "(现价 − 成本) × 股数，以及 ÷ 成本 ×100，都是现场算的。"],
      ["止损 / 止盈", "成本 ×(1 − 止损线) / ×(1 + 止盈线)，止损线默认 −8%。现价一旦跌破止损，右侧会出现红色「触发止损」标记。"],
      ["持仓市值 / 总权益 / 累计盈亏(率)", "各持仓市价之和 / 再加现金得到总权益 / 相对初始资金（10 万）的盈亏。"],
      ["挂单", "自动交易（paper-auto）已经决策、但要等下一次 paper-auto 运行才成交的买卖指令。表里列出 代码 / 名称 / 信号日 / 原因（为什么触发）。"],
      ["已平仓 笔", "历史已卖出的交易笔数。"],
    ],
  },
  {
    title: "指标页 · 摆动类",
    sub: "全部由 Lume 内建函数现算（读原始 OHLCV，不读 ETL 存库列），周期 = 顶部表单的 period，缺省 14",
    rows: [
      ["KDJ · K / D / J", "K、D 是 RSV 的 1/3 平滑 EMA；J = 3K − 2D。J >100 属超买区，<0 属超卖区。"],
      ["Williams %R", "衡量收盘价在 N 日高低区间里的位置，取值 [−100, 0]：0=贴区间高点，−100=贴低点。"],
      ["ATR", "真实波幅的 N 日均值，单位是价格（不是百分比），用来衡量这只票波动幅度的大小。"],
      ["OBV", "顺逆量：涨日把成交量加上、跌日减去，是有符号的累计值，用来观察量价是否配合。"],
    ],
  },
  {
    title: "指标页 · 趋势类",
    sub: "序列开头那段冷启动（数据不够算不出来的部分）会被服务端截掉，图上各曲线都按「最新交易日」对齐到右边",
    rows: [
      ["MA5 / MA10 / MA20", "简单移动均线：过去 5/10/20 日收盘价的平均。"],
      ["MACD · line / signal / hist", "line=DIF（12 日 EMA − 26 日 EMA）；signal=DEA（DIF 的 9 日 EMA）；hist=柱（DIF − DEA）。"],
      ["RSI · Wilder / Cutler", "两条曲线对照：Wilder 更平滑（指数平滑），Cutler 更敏感（滚动均值）。和 ETL 存库列同口径的是 Cutler。"],
      ["布林带 · mid / upper / lower", "mid=20 日均值；upper/lower=均值 ± 2 倍标准差。贴上轨偏强、贴下轨偏弱。"],
    ],
  },
  {
    title: "指标页 · 绩效 / 风险九宫格",
    sub: "基于日收益率序列计算，年化系数 ×√252 ≈ 15.87；夏普比率无风险利率取 0",
    rows: [
      ["累计收益% / 年化收益%", "区间总涨幅 / 几何年化。"],
      ["年化波动%", "日收益的标准差 × √252。"],
      ["夏普 / Sortino", "都是 (年化收益 − 0) ÷ 年化波动；Sortino 的分母只算「下行」标准差（更看重亏损方向）。"],
      ["Calmar", "年化收益 ÷ 最大回撤，衡量承担回撤换来的收益。"],
      ["最大回撤%", "从净值峰值跌到谷底的最大跌幅。"],
      ["VaR95(日) / CVaR95(日)", "95% 置信下「最坏单日」预期损失 / 超过 VaR 的那 5% 日子的平均损失（尾部更凶）。"],
    ],
  },
  {
    title: "Lume 信号判定（指标页）",
    sub: "基于「刚刚现算」出来的序列尾值做判断，和信号页的 ETL 口径是两套独立系统，可以互相印证",
    rows: [
      ["MACD金叉/死叉(Lume)", "刚现算的 DIF 与 DEA 在尾两根发生交叉。"],
      ["RSI超卖/超买(Wilder 14)", "刚现算的 Wilder RSI <30 / >70。"],
      ["破布林上/下轨", "最新收盘 > upper / < lower。"],
      ["KDJ金叉", "刚现算的 K 上穿 D（尾两根）。"],
    ],
  },
  {
    title: "数据新鲜度卡片",
    sub: "在信号页顶部，提示三个库各自「上次是什么时候刷新」的",
    rows: [
      ["更新时间", "该库最近一次成功刷新的时间。asset_snapshot 是每天 18:30 自动刷，超过 3 天会标红提醒你数据可能过期。"],
      ["最新交易日 / 行数", "K 线库与资产快照库各自的最新数据日期和总行数。"],
    ],
  },
  {
    title: "通用约定",
    sub: "",
    rows: [
      ["配色", "A 股习惯：红涨绿跌（红=涨，绿=跌）。"],
      ["行点击", "信号 / 筛选表整行可点 → 跳到个股页；行内「个股 / 指标」按钮 → 跳到对应 tab 并自动带入代码。"],
      ["数据时效", "K线 / 指标 / 信号 = 库里 T-1（前一天，每日 18:30 ETL 更新）；指数条 / 实时价卡 / 模拟仓现价 = 盘中准实时。"],
    ],
  },
];

// ---- 字段说明页: 内嵌 SVG 示意(零依赖, 与 K 线图同风格; 只挑「看图最直观」的字段配) ----
const FIG = { up: "#f85149", down: "#3fb950", blue: "#58a6ff", warn: "#d29922" };
// 轴/参考线通用样式
const axis = { stroke: "var(--border)", strokeWidth: 1 } as const;
const refL = { strokeDasharray: "3 3", stroke: "var(--faint)", strokeWidth: 1 } as const;

// 共振度分布: ≥1~≥5 命中数递减(数值为当日示例)
function FigResonance() {
  const d: [string, number, number][] = [["≥1", 4603, 40], ["≥2", 2286, 30], ["≥3", 544, 18], ["≥4", 106, 12], ["≥5", 15, 7]];
  return (
    <svg viewBox="0 0 150 62" className="gloss-fig">
      {d.map(([lab, cnt, h], i) => (
        <g key={lab} transform={`translate(${6 + i * 29},0)`}>
          <rect x={0} y={46 - h} width={20} height={h} rx={2} fill={i === 0 ? "var(--faint)" : FIG.up} opacity={0.8} />
          <text x={10} y={42 - h} textAnchor="middle" fontSize={7} fill="var(--text)">{cnt}</text>
          <text x={10} y={56} textAnchor="middle" fontSize={8} fill="var(--muted)">{lab}</text>
        </g>
      ))}
    </svg>
  );
}
// MACD: DIF 上穿 DEA = 金叉(柱由绿翻红)
function FigMACD() {
  return (
    <svg viewBox="0 0 150 62" className="gloss-fig">
      <line x1={0} x2={150} y1={34} y2={34} {...axis} />
      <path d="M4 44 C 40 40, 58 32, 76 24 S 120 14, 146 10" fill="none" stroke={FIG.blue} strokeWidth={2} />
      <path d="M4 38 C 40 36, 64 33, 82 28 S 124 22, 146 19" fill="none" stroke={FIG.warn} strokeWidth={2} />
      <line x1={78} y1={6} x2={78} y2={34} {...refL} />
      <text x={82} y={14} fontSize={8} fill={FIG.up}>金叉</text>
      <text x={4} y={12} fontSize={8} fill={FIG.blue}>DIF(快)</text>
      <text x={4} y={54} fontSize={8} fill={FIG.warn}>DEA(慢)</text>
    </svg>
  );
}
// KDJ: K 上穿 D
function FigKDJ() {
  return (
    <svg viewBox="0 0 150 62" className="gloss-fig">
      <line x1={0} x2={150} y1={10} y2={10} {...refL} /><text x={120} y={8} fontSize={7} fill="var(--faint)">100</text>
      <line x1={0} x2={150} y1={52} y2={52} {...refL} /><text x={120} y={58} fontSize={7} fill="var(--faint)">0</text>
      <path d="M4 48 C 30 44, 50 30, 70 40 S 110 52, 146 34" fill="none" stroke={FIG.blue} strokeWidth={2} />
      <path d="M4 44 C 30 40, 52 36, 72 42 S 112 48, 146 40" fill="none" stroke={FIG.warn} strokeWidth={2} />
      <line x1={71} y1={36} x2={71} y2={48} {...refL} />
      <text x={75} y={34} fontSize={8} fill={FIG.up}>K 上穿 D</text>
    </svg>
  );
}
// RSI: 70/30 阈值带, 线跌破 30 = 超卖
function FigRSI() {
  return (
    <svg viewBox="0 0 150 62" className="gloss-fig">
      <line x1={0} x2={150} y1={14} y2={14} {...refL} /><text x={122} y={12} fontSize={7} fill={FIG.down}>70 超买</text>
      <line x1={0} x2={150} y1={46} y2={46} {...refL} /><text x={122} y={52} fontSize={7} fill={FIG.up}>30 超卖</text>
      <path d="M4 30 C 24 24, 40 36, 58 30 S 92 22, 110 40 S 134 54, 146 50" fill="none" stroke={FIG.blue} strokeWidth={2} />
      <circle cx={122} cy={47} r={2.5} fill={FIG.up} />
    </svg>
  );
}
// Williams %R: 0~−100 刻度, 破 −80 超卖
function FigWilliams() {
  return (
    <svg viewBox="0 0 150 62" className="gloss-fig">
      {[["0", 10, FIG.down], ["−20", 20, FIG.warn], ["−80", 44, FIG.up], ["−100", 56, FIG.up]].map(([lab, y]) => (
        <g key={String(lab)}>
          <line x1={0} x2={14} y1={Number(y)} y2={Number(y)} {...axis} />
          <text x={16} y={Number(y) + 3} fontSize={7} fill="var(--muted)">{lab}</text>
        </g>
      ))}
      <path d="M34 18 C 56 16, 70 30, 86 38 S 124 52, 146 48" fill="none" stroke={FIG.blue} strokeWidth={2} />
      <text x={96} y={58} fontSize={7} fill={FIG.up}>破 −80 = 超卖</text>
    </svg>
  );
}
// 布林带: 价线上穿 mid±2σ 上轨
function FigBoll() {
  return (
    <svg viewBox="0 0 150 62" className="gloss-fig">
      <path d="M4 16 C 40 12, 90 12, 146 14" fill="none" stroke={FIG.up} strokeWidth={1.5} />
      <path d="M4 32 C 40 32, 90 32, 146 30" fill="none" stroke="var(--muted)" strokeWidth={1} strokeDasharray="4 3" />
      <path d="M4 48 C 40 52, 90 52, 146 48" fill="none" stroke={FIG.down} strokeWidth={1.5} />
      <path d="M4 36 C 30 34, 60 38, 84 34 S 118 20, 130 16 L 138 10" fill="none" stroke="var(--text)" strokeWidth={2} />
      <circle cx={138} cy={10} r={2.5} fill={FIG.up} />
      <text x={98} y={8} fontSize={7} fill={FIG.up}>破上轨</text>
      <text x={4} y={60} fontSize={7} fill="var(--faint)">中轨 / 上轨(红) / 下轨(绿), 20 日均 ± 2σ</text>
    </svg>
  );
}
// 量比: 今日柱 vs 5 日均量虚线
function FigVolRatio() {
  const bars = [22, 18, 24, 20, 23];
  return (
    <svg viewBox="0 0 150 62" className="gloss-fig">
      <line x1={0} x2={150} y1={54} y2={54} {...axis} />
      <line x1={0} x2={126} y1={32} y2={32} {...refL} /><text x={128} y={35} fontSize={7} fill="var(--faint)">5 日均</text>
      {bars.map((h, i) => (
        <rect key={i} x={10 + i * 22} y={54 - h} width={12} height={h} rx={2} fill="var(--faint)" opacity={0.7} />
      ))}
      <rect x={10 + 4 * 22 + 14} y={54 - 48} width={12} height={48} rx={2} fill={FIG.up} />
      <text x={10 + 4 * 22 + 10} y={10} fontSize={7} fill={FIG.up}>今日</text>
    </svg>
  );
}
// OBV: 涨日加量 / 跌日减量
function FigOBV() {
  return (
    <svg viewBox="0 0 150 62" className="gloss-fig">
      <line x1={0} x2={150} y1={52} y2={52} {...axis} />
      <path d="M4 48 L24 38 L40 44 L60 30 L80 38 L100 22 L120 30 L146 14" fill="none" stroke={FIG.blue} strokeWidth={2} />
      <path d="M4 48 L24 52 L40 44" fill="none" stroke={FIG.down} strokeWidth={1.5} strokeDasharray="3 2" />
      <text x={104} y={58} fontSize={7} fill={FIG.up}>涨日 + 量</text>
      <text x={62} y={58} fontSize={7} fill={FIG.down}>跌日 − 量</text>
    </svg>
  );
}
// 最大回撤: 净值峰值→谷底
function FigDrawdown() {
  return (
    <svg viewBox="0 0 150 62" className="gloss-fig">
      <line x1={0} x2={150} y1={54} y2={54} {...axis} />
      <path d="M4 48 L34 14 L52 30 L74 10 L104 44 L146 22" fill="none" stroke={FIG.blue} strokeWidth={2} />
      <circle cx={74} cy={10} r={2.5} fill="var(--text)" />
      <circle cx={104} cy={44} r={2.5} fill={FIG.up} />
      <line x1={86} y1={10} x2={86} y2={44} {...refL} />
      <line x1={74} y1={27} x2={104} y2={27} {...refL} />
      <text x={89} y={25} fontSize={7} fill={FIG.up}>峰→谷</text>
      <text x={116} y={50} fontSize={7} fill="var(--faint)">最大回撤</text>
    </svg>
  );
}
// 止损: 现价跌破成本 −8% 虚线
function FigStop() {
  return (
    <svg viewBox="0 0 150 62" className="gloss-fig">
      <line x1={0} x2={150} y1={54} y2={54} {...axis} />
      <line x1={0} x2={150} y1={20} y2={20} stroke="var(--text)" strokeWidth={1} strokeDasharray="5 3" />
      <text x={4} y={16} fontSize={7} fill="var(--text)">成本价</text>
      <line x1={0} x2={150} y1={40} y2={40} {...refL} />
      <text x={4} y={37} fontSize={7} fill={FIG.up}>止损线 −8%</text>
      <path d="M4 22 L30 26 L56 30 L82 36 L108 46 L146 50" fill="none" stroke={FIG.down} strokeWidth={2} />
      <circle cx={108} cy={46} r={2.5} fill={FIG.up} />
      <text x={112} y={56} fontSize={7} fill={FIG.up}>触发</text>
    </svg>
  );
}
// K 线蜡烛: 红涨 / 绿跌 + MA 线穿过
function FigCandle() {
  return (
    <svg viewBox="0 0 150 62" className="gloss-fig">
      {[
        [16, 20, 34, FIG.up], [44, 12, 30, FIG.up], [72, 18, 42, FIG.down], [100, 26, 44, FIG.down], [128, 10, 38, FIG.up],
      ].map(([x, top, bot, col]) => (
        <g key={Number(x)}>
          <line x1={Number(x)} y1={Number(top) - 4} x2={Number(x)} y2={Number(bot) + 4} stroke={col} strokeWidth={1} />
          <rect x={Number(x) - 5} y={Number(top)} width={10} height={Number(bot) - Number(top)} fill={col} opacity={0.85} />
        </g>
      ))}
      <path d="M4 40 C 40 34, 70 26, 100 22 S 130 16, 146 14" fill="none" stroke={FIG.blue} strokeWidth={1.5} />
      <path d="M4 44 C 40 40, 70 34, 100 30 S 130 26, 146 24" fill="none" stroke={FIG.warn} strokeWidth={1.5} />
      <text x={4} y={58} fontSize={7} fill="var(--faint)">红涨绿跌 · MA5(蓝) / MA20(金) 叠加</text>
    </svg>
  );
}
// RSI 双口径: Wilder 平滑 / Cutler 敏感
function FigRSI2() {
  return (
    <svg viewBox="0 0 150 62" className="gloss-fig">
      <line x1={0} x2={150} y1={14} y2={14} {...refL} /><text x={118} y={11} fontSize={7} fill={FIG.down}>70</text>
      <line x1={0} x2={150} y1={46} y2={46} {...refL} /><text x={118} y={52} fontSize={7} fill={FIG.up}>30</text>
      <path d="M4 30 C 30 24, 50 38, 74 32 S 116 24, 146 30" fill="none" stroke={FIG.blue} strokeWidth={2} />
      <path d="M4 32 L24 22 L44 42 L64 26 L86 46 L108 24 L130 50 L146 40" fill="none" stroke={FIG.warn} strokeWidth={1.5} strokeDasharray="4 3" />
      <text x={4} y={10} fontSize={7} fill={FIG.blue}>Wilder(平滑)</text>
      <text x={4} y={58} fontSize={7} fill={FIG.warn}>Cutler(敏感, 与 ETL 同口径)</text>
    </svg>
  );
}
// 字段 → 示意图 映射(键须与 GLOSS 字段名完全一致)
const FIGS: Record<string, () => ReturnType<typeof FigMACD>> = {
  "共振度（命中数）": FigResonance,
  "MACD金叉 / 死叉": FigMACD,
  "KDJ金叉": FigKDJ,
  "RSI超卖 / 超买": FigRSI,
  "威廉超卖 / 超买": FigWilliams,
  "突破布林上轨 / 跌破下轨": FigBoll,
  "量比": FigVolRatio,
  "OBV": FigOBV,
  "最大回撤%": FigDrawdown,
  "止损 / 止盈": FigStop,
  "MA5 / MA20 / RSI / MACD": FigCandle,
  "RSI · Wilder / Cutler": FigRSI2,
};

function GlossaryTab() {
  // 关键词过滤: 同时匹配「字段名」和「定义」。
  const [q, setQ] = useState("");
  const kw = q.trim().toLowerCase();
  const match = (r: GlossRow) =>
    kw === "" || r[0].toLowerCase().includes(kw) || r[1].toLowerCase().includes(kw);
  const sections = GLOSS_SECTIONS.map((s) => ({ ...s, rows: s.rows.filter(match) }))
    .filter((s) => s.rows.length > 0);
  const totalRows = GLOSS_SECTIONS.reduce((n, s) => n + s.rows.length, 0);
  return (
    <div className="glossary">
      <div className="card gloss-search">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`搜字段 / 关键词, 如: 止损 / 量比 / RSI / 冷启动`}
        />
        <span className="gloss-search-hint">共 {totalRows} 个字段{kw !== "" ? ` · 命中 ${sections.reduce((n, s) => n + s.rows.length, 0)} 个` : ""}</span>
      </div>
      {sections.length === 0 && (
        <div className="card" style={{ color: "var(--muted)", fontSize: 13 }}>没有匹配「{q}」的字段。</div>
      )}
      {sections.map((s) => (
        <div className="card" key={s.title}>
          <h3>{s.title}{s.sub ? <span> · {s.sub}</span> : null}</h3>
          <table>
            <tbody>
              {s.rows.map(([f, d]) => {
                const Fig = FIGS[f];
                return (
                  <tr key={f}>
                    <td className="gloss-field">{f}{Fig ? <span className="gloss-hasfig"> 有图</span> : null}</td>
                    <td>
                      {d}
                      {Fig ? <Fig /> : null}
                    </td>
                  </tr>
                );
              })}
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
  // 深链: #/tab[/code] — 刷新保留状态、可分享定位(如 #/indicators/sh600519)。
  const parseHash = (): Tab => {
    const h = (typeof location !== "undefined" ? location.hash : "").replace(/^#\/?/, "");
    const seg = h.split("/")[0];
    const valid: string[] = TABS.map(([t]) => t);
    return (valid.includes(seg) ? seg : "signals") as Tab;
  };
  const initFocus = (): string => {
    const h = (typeof location !== "undefined" ? location.hash : "").replace(/^#\/?/, "");
    const segs = h.split("/");
    return segs[1] && /^\w{6,8}$/.test(segs[1]) ? segs[1] : "";
  };
  const [tab, setTab] = useState<Tab>(parseHash);
  const [meta, setMeta] = useState<Meta | null>(null);
  // 共享的「当前个股」: 个股页与指标页互相跟随。
  // - 从信号/筛选点入: 设为该代码并切 tab;
  // - 在某页手动查询/计算后, 回写 focus, 另一页切过来时自动展示同一只票。
  const [focus, setFocus] = useState<string>(initFocus);
  useEffect(() => { fetchMeta().then(setMeta).catch(() => {}); }, []);
  // tab/focus 变化 → 同步 URL hash(replaceState 不堆叠历史)
  useEffect(() => {
    const codePart = (tab === "stock" || tab === "indicators") && focus ? "/" + focus : "";
    const next = "#/" + tab + codePart;
    if (location.hash !== next) {
      try { history.replaceState(null, "", next); } catch {}
    }
  }, [tab, focus]);
  // 支持浏览器前进/后退: hashchange → 回读
  useEffect(() => {
    const onHash = () => {
      const t = parseHash();
      setTab(t);
      const h = location.hash.replace(/^#\/?/, "");
      const code = h.split("/")[1];
      setFocus(code && /^\w{6,8}$/.test(code) ? code : "");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const goTab = (t: Tab) => { setTab(t); };
  const openStock = (code: string) => { setFocus(code); setTab("stock"); };
  const openInd = (code: string) => { setFocus(code); setTab("indicators"); };
  // 某页手动操作后回调: 更新共享 focus(若与该页 seed 相同, 页面内 lastAuto 守卫会跳过重载)
  const query = (code: string) => setFocus(code);
  const active = useMemo(() => TABS.find(([t]) => t === tab)?.[1] ?? "", [tab]);
  return (
    <div className="app">
      <div className="hero">
        <h1>Signal Scanner</h1>
        <div className="meta">{meta?.latest_date ? `数据截至 ${meta.latest_date}` : "加载中"}</div>
      </div>
      <div className="tabs">
        {TABS.map(([t, label]) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => goTab(t)}>{label}</button>
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
