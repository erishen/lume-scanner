import { useEffect, useRef, useState, type ReactNode } from "react";

type SseEvent =
  | { t: "delta"; d: string }
  | { t: "note"; d: string }
  | { t: "error"; d?: string }
  | { t: "done" };

const SID_KEY = "lume.scanner.sid";

function makeSessionId(): string {
  const a = new Uint8Array(16);
  window.crypto.getRandomValues(a);
  let h = "sess-";
  for (const b of a) h += b.toString(16).padStart(2, "0");
  return h;
}
function getSessionId(): string {
  const e = window.localStorage.getItem(SID_KEY);
  if (e) return e;
  const n = makeSessionId();
  window.localStorage.setItem(SID_KEY, n);
  return n;
}

/** 流式 POST /react/api/chat(SSE 包:note -> delta* -> done), 增量回调。 */
async function streamChat(
  message: string,
  sessionId: string,
  signal: AbortSignal,
  onDelta: (d: string) => void,
  onNote: (n: string) => void,
  onError: (m: string) => void
): Promise<void> {
  const res = await window.fetch("/react/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sessionId }),
    signal,
  });
  const body = res.body;
  if (!res.ok || !body) {
    const text = await res.text().catch(() => "");
    throw new Error((res.status ? res.status + " " : "") + text.slice(0, 120).trim());
  }
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let sawDone = false;
  function handleBlock(block: string): void {
    for (const ln of block.split("\n")) {
      if (!ln.startsWith("data: ")) continue; // ":" heartbeat / event: / id:
      let ev: SseEvent;
      try {
        ev = JSON.parse(ln.slice(6)) as SseEvent;
      } catch {
        continue;
      }
      if (ev.t === "delta" && typeof ev.d === "string") onDelta(ev.d);
      else if (ev.t === "note" && typeof ev.d === "string") onNote(ev.d);
      else if (ev.t === "error") onError(typeof ev.d === "string" ? ev.d : "agent error");
      else if (ev.t === "done") sawDone = true;
    }
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      handleBlock(block);
    }
  }
  handleBlock(buf);
  if (!sawDone) throw new Error("stream ended without a done event");
}

type Msg = { role: "user" | "agent"; text: string; notes: string[] };

// ---- 轻量 Markdown → React(零依赖: LLM 回复含 **加粗** / 列表 / 表格 / 代码块 / 引用) ----
// 只覆盖聊天场景常用子集; 流式中未闭合的围栏代码块会先按 pre 显示, done 后自动成形。
function mdInline(text: string): ReactNode {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else {
      const lm = t.match(/\[([^\]]+)\]\(([^)\s]+)\)/);
      out.push(
        lm ? (
          <a key={k++} href={lm[2]} target="_blank" rel="noreferrer">{lm[1]}</a>
        ) : t
      );
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function splitRow(s: string): string[] {
  return s.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((x) => x.trim());
}

function Md({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const ln = lines[i];
    // 围栏代码
    if (ln.trimStart().startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(
        <pre key={k++} className="md-pre">
          <code>{buf.join("\n")}</code>
        </pre>
      );
      continue;
    }
    // 标题
    const h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push(
        <div key={k++} className={"md-h md-h" + h[1].length}>
          {mdInline(h[2])}
        </div>
      );
      i++;
      continue;
    }
    // 表格(表头 + 分隔行, 之后连续的 | 行)
    const sep = i + 1 < lines.length ? lines[i + 1] : "";
    if (ln.includes("|") && sep.includes("-") && /^[\s|:-]+$/.test(sep)) {
      const head = splitRow(ln);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push(
        <table key={k++} className="md-table">
          <thead>
            <tr>
              {head.map((c, j) => (
                <th key={j}>{mdInline(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {head.map((_, ci) => (
                  <td key={ci}>{mdInline(r[ci] ?? "")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
      continue;
    }
    // 列表(- / * / 数字. ; 缩进 >=2 空格视为子项)
    if (/^\s*([-*+]|\d+[.)])\s+/.test(ln)) {
      const items: { t: string; sub: boolean; num: string | null }[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const m2 = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        items.push({
          t: m2 ? m2[3] : lines[i],
          sub: m2 ? m2[1].length >= 2 : false,
          num: m2 && m2[2].match(/^\d/) ? m2[2] : null,
        });
        i++;
      }
      blocks.push(
        <ul key={k++} className="md-list">
          {items.map((it, j) => (
            <li key={j} className={"md-li" + (it.sub ? " sub" : "") + (it.num ? " ord" : "")}>
              {it.num ? <span className="md-li-num">{it.num}</span> : null}
              {mdInline(it.t)}
            </li>
          ))}
        </ul>
      );
      continue;
    }
    // 引用
    if (/^>\s?/.test(ln)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <div key={k++} className="md-quote">
          {mdInline(buf.join(" "))}
        </div>
      );
      continue;
    }
    // 分隔线
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(ln)) {
      blocks.push(<hr key={k++} />);
      i++;
      continue;
    }
    // 空行
    if (ln.trim() === "") {
      i++;
      continue;
    }
    // 段落(合并到下一个块级/空行; 保留段内换行)
    {
      const buf: string[] = [ln];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !lines[i].trimStart().startsWith("```") &&
        !/^(#{1,6})\s/.test(lines[i]) &&
        !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
        !/^>\s?/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      blocks.push(
        <div key={k++} className="md-p">
          {mdInline(buf.join("\n"))}
        </div>
      );
    }
  }
  return <div className="md">{blocks}</div>;
}

const DEMO_PROMPTS: Array<[string, string]> = [
  ["量比>2 换手>5", "帮我筛一下量比大于 2、换手率大于 5 的票"],
  ["当日金叉", "今天全市场哪些票 MACD 或 KDJ 金叉?"],
  ["查茅台", "看看 sh600519 近 30 日的 K 线和技术指标"],
];

export function ChatTab() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, busy]);

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    setInput("");
    const sessionId = getSessionId();
    setMessages((m) => [...m, { role: "user", text: t, notes: [] }]);
    setBusy(true);
    // 占位 agent 消息, 流式追加
    let agentText = "";
    let notes: string[] = [];
    setMessages((m) => [...m, { role: "agent", text: "", notes: [] }]);
    const patchAgent = () => {
      setMessages((m) => {
        const copy = m.slice();
        const last = copy[copy.length - 1];
        if (last && last.role === "agent") {
          copy[copy.length - 1] = { role: "agent", text: agentText, notes };
        }
        return copy;
      });
    };
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamChat(
        t,
        sessionId,
        controller.signal,
        (d) => {
          agentText += d;
          patchAgent();
        },
        (n) => {
          notes = [...notes, n];
          patchAgent();
        },
        () => {
          agentText += "\n(agent error)";
          patchAgent();
        }
      );
    } catch (e) {
      agentText += "\n" + String(e);
      patchAgent();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="kv">
        聊天走 SSE <code>/react/api/chat</code>;未配 LLM 时走离线 demo 引擎(不真正调工具)。
        配好 <code>LLM_API_URL/KEY</code> 后, agent 会调用 scan_signals / screen_stocks /
        stock_kline 三个只读工具直查库。
      </div>
      <div className="chatbox">
        <div className="chatlist" ref={listRef}>
          {messages.map((m, i) => (
            <div key={i} className={"msg " + m.role}>
              <div className="who">{m.role === "user" ? "你" : "agent"}</div>
              <div className="body">
                {m.notes.map((n, j) => (
                  <div key={j} className="note">
                    {n}
                  </div>
                ))}
                <div>{m.role === "agent" ? (
                    m.text ? <Md text={m.text} /> : (busy && i === messages.length - 1 ? "…" : "")
                  ) : (
                    m.text
                  )}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="chatinput">
          <div className="prompts">
            {DEMO_PROMPTS.map(([label, p]) => (
              <button key={label} className="ghost" disabled={busy} onClick={() => send(p)}>
                {label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) send(input);
              }}
              placeholder="问点什么(回车发送)"
              style={{ flex: 1 }}
            />
            <button className="primary" disabled={busy || !input.trim()} onClick={() => send(input)}>
              发送
            </button>
            {busy && (
              <button className="ghost" onClick={() => abortRef.current?.abort()}>
                停止
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
