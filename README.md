# lume-scanner — A-share signal scanner + real-time dashboard (Lume single binary + read-only SQLite)

[中文文档](README.zh.md)

Serves the ETL output of [stock-analyzer](https://github.com/erishen/stock-analyzer) — full-market
signal / indicator / asset-snapshot SQLite databases (~8.5M rows) — with a **single Lume binary** in
read-only mode:

- Full-market signal scan with **dual-caliber RSI cross-checks**
- Rule-based whitelisted screening
- Per-stock K-line + **indicator page computed live by Lume builtins** (KDJ / MACD / RSI-Cutler /
  RSI-Wilder / Bollinger / Williams / ATR / OBV / performance & risk) — no dependency on the
  Python ETL indicator columns
- **Real-time quotes** (per-stock quote card + 4 major index ticker), cached server-side
- Built-in LLM agent chat that can query the databases and live quotes directly

Signal *computation* stays on the Python ETL side (host launchd, incremental daily at 18:30).
This service performs **zero writes**.

## Three ways to run

| Mode | Command | Data source | Use case |
|---|---|---|---|
| Sample DB | `make dev` | `.data/` (40 stocks × 60 sessions, extracted) | Local demo, hot-reloading the frontend |
| Full DB | `make real` | stock-analyzer `data/` pair (~8.5M rows) | Daily full-market use, direct on the host |
| Docker | `make docker && make docker-up` | bind-mounted host `data/` (read-only) | Long-running / shared / isolated |

```bash
make dev      # http://127.0.0.1:8094 (esbuild --watch hot reload + Lume in foreground)
make real     # same, but pointed at the full dual DBs (agent tool whitelist injected)

# Docker two-step build (base image recompiles the C source with the #54/#55/rsi_cutler
# builtins inside the container, producing a static Linux binary):
make docker   # = docker-base (base) + docker-app (app)
make docker-up    # compose up: host 18094 -> container 8094, real DBs mounted read-only
make docker-down
```

Note: `make dev` / `make real` use the locally built `../lume/bin/lume` from the neighboring host
tree (which contains the newer builtins). The installed `~/.local/bin/lume` is an older release and
lacks `rsi_cutler` etc. — it will fail with `undefined variable`.

## Getting started in 5 minutes

**Minute 1 · start the service** (pick one; for daily use the Docker long-running mode is
recommended):

```bash
cd work/lume/lume-scanner
make docker && make docker-up        # full 8.5M-row DBs in a container, http://127.0.0.1:18094
# or: make dev                       # 40-stock sample DB, local hot reload, http://127.0.0.1:8094
```

**Minute 2 · what to look at in the browser** (tab map — each tab answers one question):

| Tab | Question it answers |
|---|---|
| Signal scan | Which stocks fired signals today / recently? Two cards on top: **Today's picks** (scored top 8 worth a look today) + **Track record** (180-day win rate / avg return per signal — tells you whether the signal is trustworthy) |
| Rule screening | Find stocks by volume ratio / turnover / market cap; leave all filters empty = today's full-market top 50 by volume ratio |
| Stock | How has this stock been doing recently (live quote + last 30 K-line bars); click a code on the signal page to jump here |
| Indicators | 8 indicator charts (KDJ/MACD/RSI×2/Bollinger/Williams/ATR/OBV), computed live by Lume, no Python dependency |
| Glossary | What every number means, why the three RSI columns differ, why nulls show "listed <20 days" |
| AI chat | Ask questions directly; the agent queries the DBs itself (signals / K-line / live quotes / track record / picks). The data is real |

**Minutes 3–5 · walk through real data**: on the signal page pick a golden-cross row → click the
code to jump to the stock page → open the indicator charts → back to AI chat, ask "which stock has
the most resonant signals today" and watch it call tools and answer from the DB.

**When do you need to rebuild?** One rule to remember:

- Changed the frontend (`src/scanner/` + `www/`) → `make ui`, then just refresh the browser.
  **No rebuild.**
- Changed `.lume` logic (`scanner.lume` / `src/repo.lume`) → in Docker: `make docker-app &&
  make docker-up` (the Lume program is baked into the image); locally with `make dev` /
  `make real` just restart the process.
- Changed C builtins → `make docker` full rebuild (base recompiles the binary).

Troubleshooting: frontend shows "HTTP 404 · interface did not return JSON" = the `.lume` inside
the image is older than the frontend — rebuild the app image.

## Data pipeline

```
stock-analyzer ETL (host launchd, daily 18:30, incremental K-line fetch -> 51 indicator
columns -> signal flags -> DingTalk push)
  └─► data/stock_analysis.db (~8.5M rows) + asset_snapshot.db
        ├─ make real / docker: read directly (8.5M rows resolve in ms via indexes)
        ├─ make dev: scripts/make_sample_data.py extracts 40 stocks × 60 sessions -> .data/
        └─ live quotes: NOT from the DB — Lume http_get straight to the public Tencent quote
           endpoint (15s TTL per stock, 30s for indexes)
```

If data goes stale for >3 days, stock-analyzer's `check-stale` job pushes a DingTalk alert.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Dashboard SPA (signals / screening / stock / indicators / AI chat / data source — 6 tabs) |
| `GET /api/signals?limit=` | Latest-session full-market signals + **dual-caliber RSI columns** (ETL·Cutler / Lume·Cutler bit-identical cross-check / Lume·Wilder reference) |
| `POST /api/screen` | Rule screening: whitelist fields bound via `?` placeholders, never string-concatenated; no filters = volume-ratio top N |
| `GET /api/stock/:code?days=` | Per-stock K-line (last N sessions) + ma5/ma20/rsi/macd series (code auto-normalized to 6-digit → sh/sz/bj prefix) |
| `GET /api/indicators/:code?days=&period=` | **Computed live by Lume builtins** (raw OHLCV in, ETL columns not read): KDJ/Williams/ATR/OBV/MA/MACD/RSI(Wilder+Cutler)/Bollinger + performance panel (Sharpe/Sortino/CVaR/VaR/…) + Lume-side signal verdict |
| `GET /api/realtime/indexes` | Live levels of the 4 major indexes (text source, 30s cache) |
| `GET /api/realtime/:code` | Live price/change/OHLC/prev-close/volume/amount/timestamp (15s cache; suspended → `suspended`, upstream down → `ok:false+reason`, frontend degrades gracefully) |
| `GET /api/meta` | Latest session / instrument count / row count |
| `POST /react/api/chat` | Agent SSE chat (tool whitelist queries the DBs + live quotes; unconfigured LLM falls back to the offline demo engine) |
| `GET /discovery` | Skills / tools / mcps discovered at boot |

## RSI dual caliber (why the signal page shows three RSI columns)

| Column | Algorithm | Source |
|---|---|---|
| RSI (ETL·Cutler) | up/down each = rolling(14).mean() | stock-analyzer ETL stored column |
| RSI (Lume·Cutler) | same algorithm, Lume builtin `rsi_cutler` computed live | Bit-identical (Δ≈0) = proof of port correctness (80/80 match on the full DB) |
| RSI (Lume·Wilder) | Wilder's original EMA (SMA seed + recursion) | Cross-caliber reference; divergence from Cutler is expected |

## Agent tools (registered at the top level of `src/repo.lume`, all read-only, whitelist via env)

- `scan_signals` / `screen_stocks` / `stock_kline` / `stock_indicators` — T-1 data from the DBs
- `realtime_quote` / `market_indexes` — intraday live prices (Tencent source, server-side cached)
- `sql_query` / `sql_tables` / `sql_schema` / `read_file` / `get_time` — introspection + basics

Both `make real` and docker compose inject `HARNESS_TOOLS_ALLOW` (the `SCANNER_TOOLS` list in the
Makefile; `sql_write` is never included).

## Security

- Binds `127.0.0.1` by default; inject `HTPASSWD_FILE` to enable Basic Auth for external
  deployments. The compose port is mapped to `127.0.0.1:18094` (loopback only) by default —
  inside the container Lume itself binds `0.0.0.0` with no auth, so if you map it to host
  `0.0.0.0`, any device on the LAN can read the full market data anonymously and burn your
  `LLM_API_KEY` quota. To share: explicitly `PORT=0.0.0.0:18094 make docker-up` **and** inject
  `HTPASSWD_FILE`.
- `sql_query` is physically read-only + SELECT-only guarded; the agent's `read_file` is locked to
  the web root (`www/`) via `resolve_within()` — path traversal is rejected; this service never
  writes to the DBs (Docker mounts them `:ro`).
- Live quotes are fetched from public quote sources only; no data is sent anywhere. When the LLM
  is unconfigured, chat degrades to the offline engine.
- `.env` (holds the LLM key) is `600` and gitignored; chat sessions in `.data/sessions/` are
  gitignored and not baked into the image.
- Market data is public exchange/quote-vendor data. This project is a personal local analysis
  tool; it does not collect any user personal data.

## Disclaimer

- This project is a quantitative-research / paper-trading research tool. All signals, backtests
  and simulated results are for reference only and **do not constitute investment advice**.
- Market data comes from public feeds (akshare / Tencent / EastMoney), for research purposes only;
  data belongs to their respective owners.
- Past performance does not guarantee future results.

## License

MIT
