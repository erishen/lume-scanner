# lume-scanner — A 股信号扫描(Lume 单二进制 + 只读 SQLite)

把 [stock-analyzer](../../../../invest-kit/apps/stock-analyzer) 的 ETL 产出(信号/指标/资产快照
SQLite 库)用一个 **Lume 单二进制** 只读服务起来:全市场信号扫描、白名单规则筛选、个股 K 线
序列 + 内置 LLM agent 工具。信号「计算」留在 Python ETL 端(每晚 make etl),本服务零写操作。

范式同 [`lume-orbstack`](../lume-orbstack):宿主采集产快照 → Lume 只读服务 + React 前端。

## 启动

```bash
make dev     # http://127.0.0.1:8094 (热更:改 .tsx 自动重打包)
make stop    # 停服务 + 残留 esbuild watch
```

`make dev` 先跑 `make sample-data` 从 stock-analyzer 真实库抽 40 只 × 5 个交易日到
`.data/scanner.db` + `.data/asset.db` 样例。生产直接用真实库:

```bash
SCANNER_DB=../../../../invest-kit/apps/stock-analyzer/data/stock_analysis.db \
ASSET_DB=../../../../invest-kit/apps/stock-analyzer/data/asset_snapshot.db \
  make dev
```

## 端点

| 端点 | 说明 |
|---|---|
| `GET /` | 仪表盘 SPA(信号 / 筛选 / 个股 / AI 聊天 / 数据源 5 tab) |
| `GET /api/signals?limit=` | 最新交易日全市场信号(MACD/KDJ 金叉、RSI/威廉超买卖、布林突破、OBV 放量) |
| `POST /api/screen` | 规则筛选:`{"filters":{volume_ratio_min, turnover_rate_min, total_market_value_min, close_min, max}}`,值走 `?` 占位绑定不拼 SQL |
| `GET /api/stock/:code?days=` | 个股近 N 日 K 线 + ma5/ma20/rsi/macd/kdj 序列(升序;代码自动归一 6 位→带 sh/sz/bj 前缀) |
| `GET /api/meta` | 最新交易日/标的数/行数 |
| `POST /react/api/chat` | 内置 agent SSE 聊天(工具经白名单直查库;未配 LLM 走离线 demo 引擎) |
| `GET /discovery` | 启动时发现的 skills / tools / mcps 一览 |

## AI 聊天

「AI 聊天」tab 走 `POST /react/api/chat` SSE 流(agent-httpd 原生 C 引擎), 可让 agent 调用下方
三个只读工具直查库。未配 LLM(`LLM_API_KEY` 空)时走离线 demo 引擎(不真正调工具, 仅回显)。
配好 `LLM_API_URL` / `LLM_MODEL` / `LLM_API_KEY` 后即真实调用。

信号口径与 stock-analyzer `src/etl/pipeline.py` 一致(读 ETL 已算好的 flag 列,不在服务侧重算)。

## agent 工具(src/repo.lume 顶层注册, 全部只读)

- `scan_signals` — 全市场当日技术信号
- `screen_stocks` — 估值/量能规则筛选
- `stock_kline` — 个股 K 线 + 指标序列

聊天页(SSE,`/react/api/chat`)经白名单工具直查库;未配 LLM 时走离线 demo 引擎。
需要 LLM 时配 `LLM_API_URL` / `LLM_API_KEY`(见 `.env.example`)。

## 安全

- 默认绑 `127.0.0.1`;对外部署注入 `HTPASSWD_FILE` 开 Basic Auth。
- `sql_query` 物理只读 + SELECT-only 护栏,与 agent 工具同源;本服务永不写库。
- LLM 未配置时聊天降级离线引擎,不外发数据。
