import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  fetchMeta, fetchSignals, fetchScreen, fetchStock, fetchIndicators,
  type Meta, type SignalPayload, type ScreenPayload, type StockPayload, type Filters, type IndicatorsPayload,
} from "./api";
import { ChatTab } from "./chat";

type Tab = "signals" | "screen" | "stock" | "indicators" | "chat" | "about";

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
        <text x={44} y={y + 3} fill="#6e7681" fontSize={9} textAnchor="end">{fmtAxis(v)}</text>
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

// 指标图卡片: 标题 + 副题 + legend + Lines
function ChartCard({ title, sub, data, labels, min, max, w = 720, h = 150 }: {
  title: string; sub?: string; data: (number | null)[][]; labels: string[];
  min?: number; max?: number; w?: number; h?: number;
}) {
  return (
    <div className="chart-card">
      <div className="chart-title">
        <div>{title}{sub ? <span>{sub}</span> : null}</div>
      </div>
      <Legend labels={labels} />
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

function Num({ v, digits = 2 }: { v: number | null | undefined; digits?: number }) {
  return <span>{v == null ? "—" : v.toFixed(digits)}</span>;
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

// ---- Tab 3: 个股 K 线 + 指标 ----
// seed: 共享的「当前个股」(与指标页跟随); onQuery: 本页手动查询后上报, 供指标页跟随
function StockTab({ seed, onQuery }: { seed?: string; onQuery?: (code: string) => void }) {
  const [code, setCode] = useState("sh600519");
  const [days, setDays] = useState("120");
  const [data, setData] = useState<StockPayload | null>(null);
  const [err, setErr] = useState("");
  const lastAuto = useRef("");

  const load = (c: string, d: string) => {
    setErr("");
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
          <div className="card">
            <div className="series" style={{ maxHeight: 480, overflow: "auto", padding: 0 }}>
              <table>
                <thead>
                  <tr><th>日期</th><th>开</th><th>收</th><th>低/高</th><th>量</th><th>涨跌%</th><th>MA5</th><th>MA20</th><th>RSI</th><th>MACD</th></tr>
                </thead>
                <tbody>
                  {data.series.map((r) => (
                    <tr key={r.date}>
                      <td>{r.date}</td>
                      <td><Num v={r.open} /></td>
                      <td><Num v={r.close} /></td>
                      <td><Num v={r.low} /> / <Num v={r.high} /></td>
                      <td><Num v={r.volume} digits={0} /></td>
                      <td className={cls(r.change_percent)}><Num v={r.change_percent} /></td>
                      <td><Num v={r.ma5} /></td>
                      <td><Num v={r.ma20} /></td>
                      <td><Num v={r.rsi} /></td>
                      <td><Num v={r.macd} digits={3} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
              <div className="chart-title"><div>价格 + 均线<span>收盘 / MA5 / MA20</span></div></div>
              <Legend labels={["Close", "MA5", "MA20"]} />
              <Lines data={[data.closes ?? [], data.ma5, data.ma20]} labels={["Close", "MA5", "MA20"]} />
            </div>
            <div className="chart-card">
              <div className="chart-title"><div>MACD<span>12 / 26 / 9</span></div></div>
              <Legend labels={["MACD", "Signal", "Hist"]} />
              <Lines data={[data.macd.line, data.macd.signal, data.macd.hist]} labels={["MACD", "Signal", "Hist"]} />
            </div>
            <div className="chart-card">
              <div className="chart-title"><div>RSI<span>Wilder vs Cutler · 14</span></div></div>
              <Legend labels={["Wilder", "Cutler"]} />
              <Lines data={[data.rsi_wilder, data.rsi_cutler]} labels={["Wilder", "Cutler"]} min={0} max={100} />
            </div>
            <div className="chart-card">
              <div className="chart-title"><div>布林带<span>20 · 2σ</span></div></div>
              <Legend labels={["Mid", "Upper", "Lower"]} />
              <Lines data={[data.boll.mid, data.boll.upper, data.boll.lower]} labels={["Mid", "Upper", "Lower"]} />
            </div>
            <div className="chart-card">
              <div className="chart-title"><div>KDJ<span>period {data.period}</span></div></div>
              <Legend labels={["K", "D", "J"]} />
              <Lines data={[data.kdj.k, data.kdj.d, data.kdj.j]} labels={["K", "D", "J"]} min={-20} max={120} />
            </div>
            <div className="chart-card">
              <div className="chart-title"><div>Williams %R<span>period {data.period}</span></div></div>
              <Legend labels={["Williams %R"]} />
              <Lines data={[data.williams_r]} labels={["Williams %R"]} min={-100} max={0} />
            </div>
            <div className="chart-card">
              <div className="chart-title"><div>ATR<span>period {data.period}</span></div></div>
              <Legend labels={["ATR"]} />
              <Lines data={[data.atr]} labels={["ATR"]} />
            </div>
            <div className="chart-card">
              <div className="chart-title"><div>OBV<span>on-balance volume</span></div></div>
              <Legend labels={["OBV"]} />
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
    ["chat", "AI 聊天"],
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
        {tab === "signals" && <SignalsTab onStock={openStock} onInd={openInd} />}
        {tab === "screen" && <ScreenTab onStock={openStock} onInd={openInd} />}
        {tab === "stock" && <StockTab seed={focus} onQuery={query} />}
        {tab === "indicators" && <IndicatorsTab seed={focus} onQuery={query} />}
        {tab === "chat" && <ChatTab />}
        {tab === "about" && <AboutTab />}
      </div>
      <div className="note">{active === "信号扫描" ? "MACD/KDJ 金叉、RSI/威廉超买卖、布林带突破、OBV 放量口径同 stock-analyzer ETL" : ""}</div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
