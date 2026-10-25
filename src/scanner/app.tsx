import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  fetchMeta, fetchSignals, fetchScreen, fetchStock, fetchIndicators,
  type Meta, type SignalPayload, type ScreenPayload, type StockPayload, type Filters, type IndicatorsPayload,
} from "./api";
import { ChatTab } from "./chat";

type Tab = "signals" | "screen" | "stock" | "indicators" | "chat" | "about";

// ---- 轻量 SVG 折线(null 值断开, 支持多序列)----
function Lines({ data, labels, w = 720, h = 160, min, max }: {
  data: (number | null)[][]; labels: string[]; w?: number; h?: number;
  min?: number; max?: number;
}) {
  const all = data.flat().filter((v): v is number => v != null);
  const lo = min ?? Math.min(...all);
  const hi = max ?? Math.max(...all);
  const span = hi - lo || 1;
  const n = data[0]?.length ?? 0;
  const px = (i: number) => (n > 1 ? (i / (n - 1)) * (w - 16) + 8 : w / 2);
  const py = (v: number) => h - 20 - ((v - lo) / span) * (h - 30);
  const colors = ["#58a6ff", "#f85149", "#3fb950", "#d29922"];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", maxWidth: w, background: "#0d1117", borderRadius: 8 }}>
      <line x1={8} x2={w - 8} y1={h - 20} y2={h - 20} stroke="#30363d" />
      <line x1={8} x2={w - 8} y1={10} y2={10} stroke="#30363d" />
      <text x={8} y={h - 6} fill="#8b949e" fontSize={10}>{lo.toFixed(1)}</text>
      <text x={w - 8} y={h - 6} fill="#8b949e" fontSize={10} textAnchor="end">{hi.toFixed(1)}</text>
      {data.map((series, si) => {
        // 分段(null 断开)
        let path = "";
        let pen = false;
        series.forEach((v, i) => {
          if (v == null) { pen = false; return; }
          path += (pen ? "L" : "M") + px(i).toFixed(1) + " " + py(v).toFixed(1) + " ";
          pen = true;
        });
        return <path key={si} d={path} fill="none" stroke={colors[si % colors.length]} strokeWidth={1.5} />;
      })}
    </svg>
  );
}

function Legend({ labels }: { labels: string[] }) {
  const colors = ["#58a6ff", "#f85149", "#3fb950", "#d29922"];
  return (
    <div style={{ display: "flex", gap: 14, marginBottom: 6, fontSize: 12, color: "#8b949e" }}>
      {labels.map((l, i) => (
        <span key={l} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 14, height: 3, background: colors[i % 4], display: "inline-block", borderRadius: 2 }} />{l}
        </span>
      ))}
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

// ---- Tab 1: 全市场信号 ----
function SignalsTab() {
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
      <div className="kv">截至 {data.date} · 共 {data.count} 只带信号</div>
      <table>
        <thead>
          <tr><th>代码</th><th>收盘</th><th>涨跌%</th><th>RSI</th><th>信号</th></tr>
        </thead>
        <tbody>
          {data.signals.map((s) => (
            <tr key={s.code}>
              <td>{s.code}</td>
              <td><Num v={s.close} /></td>
              <td className={cls(s.change)}><Num v={s.change} /></td>
              <td><Num v={s.rsi} /></td>
              <td>{s.signals.map((t) => <span key={t} className="chip">{t}</span>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// ---- Tab 2: 规则筛选 ----
function ScreenTab() {
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
      {data && (
        <>
          <div className="kv">命中 {data.count} 只{data.where ? ` · WHERE ${data.where}` : ""}</div>
          <table>
            <thead>
              <tr><th>代码</th><th>名称</th><th>收盘</th><th>量比</th><th>换手%</th><th>总市值(亿)</th><th>流通市值(亿)</th></tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.code}>
                  <td>{r.code}</td>
                  <td>{r.name}</td>
                  <td><Num v={r.close} /></td>
                  <td><Num v={r.volume_ratio} /></td>
                  <td><Num v={r.turnover_rate} /></td>
                  <td><Num v={r.total_market_value} /></td>
                  <td><Num v={r.float_market_value} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

// ---- Tab 3: 个股 K 线 + 指标 ----
function StockTab() {
  const [code, setCode] = useState("sh600519");
  const [days, setDays] = useState("120");
  const [data, setData] = useState<StockPayload | null>(null);
  const [err, setErr] = useState("");

  const load = (c: string, d: string) => {
    setErr("");
    fetchStock(c, Number(d)).then(setData).catch((e) => setErr(String(e)));
  };
  const submit = (e: React.FormEvent) => { e.preventDefault(); load(code, days); };

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
          <div className="kv">{data.code} · 近 {data.days} 个交易日(升序)</div>
          <div className="series">
            <table>
              <thead>
                <tr><th>日期</th><th>开</th><th>收</th><th>高低</th><th>量</th><th>涨跌%</th><th>MA5</th><th>MA20</th><th>RSI</th><th>MACD</th></tr>
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
        </>
      )}
      {data && data.days === 0 && <div className="kv">未找到 {code} 的 K 线(确认带市场前缀 sh/sz/bj)</div>}
    </>
  );
}

// ---- Tab 4: 实时技术指标(Lume 内建现算)----
function IndicatorsTab() {
  const [code, setCode] = useState("sh600519");
  const [days, setDays] = useState("200");
  const [period, setPeriod] = useState("9");
  const [data, setData] = useState<IndicatorsPayload | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const load = () => {
    setErr("");
    setLoading(true);
    fetchIndicators(code, Number(days) || 200, Number(period) || 9)
      .then(setData)
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  };

  return (
    <>
      <form className="filters" onSubmit={(e) => { e.preventDefault(); load(); }}>
        <label>代码 <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="sh600519" /></label>
        <label>天数 <input value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 70 }} /></label>
        <label>KDJ/ATR 周期 <input value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: 70 }} /></label>
        <button className="primary" type="submit" disabled={loading}>{loading ? "…" : "计算"}</button>
      </form>
      <div className="kv">Lume 内建现算(读原始 high/low/close/volume, 不依赖 Python ETL 指标列)。
        {data ? ` 数据截至 ${data.dates[data.dates.length - 1] ?? "—"} · ${data.days} 日 · 周期 ${data.period}` : ""}</div>
      {err && <div className="err">{err}</div>}
      {data?.note && <div className="kv">{data.note}</div>}
      {data && data.kdj && (
        <div className="series" style={{ maxHeight: "none" }}>
          <div style={{ padding: "10px 6px" }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>KDJ (period {data.period})</div>
            <Legend labels={["K", "D", "J"]} />
            <Lines data={[data.kdj.k, data.kdj.d, data.kdj.j]} labels={["K", "D", "J"]} min={-20} max={120} />
            <div style={{ fontWeight: 600, margin: "14px 0 4px" }}>Williams %R</div>
            <Legend labels={["Williams %R"]} />
            <Lines data={[data.williams_r]} labels={["Williams %R"]} min={-100} max={100} />
            <div style={{ fontWeight: 600, margin: "14px 0 4px" }}>ATR (period {data.period})</div>
            <Legend labels={["ATR"]} />
            <Lines data={[data.atr]} labels={["ATR"]} />
            <div style={{ fontWeight: 600, margin: "14px 0 4px" }}>OBV (on-balance volume)</div>
            <Legend labels={["OBV"]} />
            <Lines data={[data.obv]} labels={["OBV"]} />
          </div>
        </div>
      )}
      {!data && !loading && <div className="kv">点「计算」从全量库实时算 KDJ / Williams %R / ATR / OBV。</div>}
    </>
  );
}

// ---- Tab 4: 数据源 ----
function AboutTab() {
  const [meta, setMeta] = useState<Meta | null>(null);
  useEffect(() => { fetchMeta().then(setMeta).catch(() => setMeta(null)); }, []);
  if (!meta) return <div className="kv">数据源信息加载中…</div>;
  return (
    <div className="kv">
      最新交易日: {meta.latest_date ?? "—"}<br />
      标的数: {meta.stocks} · 分析行数: {meta.analysis_rows} · 资产快照行数: {meta.asset_rows}<br />
      架构: Lume 单二进制(C11) 只读 SQLite;信号计算在 Python stock-analyzer ETL 端。
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("signals");
  const [meta, setMeta] = useState<Meta | null>(null);
  useEffect(() => { fetchMeta().then(setMeta).catch(() => {}); }, []);
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
        {tab === "signals" && <SignalsTab />}
        {tab === "screen" && <ScreenTab />}
        {tab === "stock" && <StockTab />}
        {tab === "indicators" && <IndicatorsTab />}
        {tab === "chat" && <ChatTab />}
        {tab === "about" && <AboutTab />}
      </div>
      <div className="note">{active === "信号扫描" ? "MACD/KDJ 金叉、RSI/威廉超买卖、布林带突破、OBV 放量口径同 stock-analyzer ETL" : ""}</div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
