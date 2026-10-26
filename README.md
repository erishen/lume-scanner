# lume-scanner — A 股信号扫描 + 实时行情(Lume 单二进制 + 只读 SQLite)

把 [stock-analyzer](../../../../invest-kit/apps/stock-analyzer) 的 ETL 产出(信号/指标/资产快照
SQLite 库, 8.5M 行)用一个 **Lume 单二进制** 只读服务起来:全市场信号扫描(带 RSI 双口径对照)、
白名单规则筛选、个股 K 线 + **指标页 Lume 内建现算**(KDJ/MACD/RSI/Wilder/Cutler/布林/
Williams/ATR/OBV/绩效风险, 不依赖 Python ETL 指标列)、**实时行情**(个股价卡 + 四大指数条)、
内置 LLM agent 聊天(可直查库 + 查实时价)。信号「计算」留在 Python ETL 端(每日 18:30 launchd
增量更新), 本服务零写操作。

范式同 [`lume-orbstack`](../lume-orbstack):宿主 ETL 产库 → Lume 只读服务 + React 前端。

## 三种启动方式

| 方式 | 命令 | 数据源 | 场景 |
|---|---|---|---|
| 样例库 | `make dev` | `.data/`(40 只 × 60 交易日抽取) | 本地演示、改前端热更 |
| 全量库 | `make real` | stock-analyzer `data/` 双库(8.5M 行) | 日常看全市场, 宿主直跑 |
| Docker | `make docker && make docker-up` | bind mount 宿主 `data/`(只读) | 长驻 / 对外 / 隔离跑 |

```bash
make dev      # http://127.0.0.1:8094 (esbuild --watch 热更 + Lume 前台)
make real     # 同上, 直连全量双库(agent 工具白名单已注入)

# Docker 两步构建(基座在容器内重编带 #54/#55/rsi_cutler 内建的 C 源码, 静态 Linux 二进制):
make docker   # = docker-base(基座) + docker-app(应用)
make docker-up    # compose 起容器: 宿主 18094 → 容器 8094, 真实双库只读挂载
make docker-down
```

注意: `make dev`/`make real` 用的是邻居宿主树本地构建 `../lume/bin/lume`(含二期新内建);
安装件 `~/.local/bin/lume` 是老版, 缺 `rsi_cutler` 等内建会报 `undefined variable`。

## 数据链路

```
stock-analyzer ETL(宿主 launchd 每日 18:30, 增量拉 K 线→算 51 指标列→信号 flag→钉钉推送)
  └─► data/stock_analysis.db(8.5M 行) + asset_snapshot.db
        ├─ make real / docker: 直接只读(8.5M 行走索引毫秒级)
        ├─ make dev: scripts/make_sample_data.py 抽 40 只 × 60 交易日 → .data/
        └─ 实时行情: 不走库, Lume http_get 直连腾讯 qt.gtimg.cn(单票 15s / 指数 30s TTL 缓存)
```

数据停更 >3 天由 stock-analyzer 的 `check-stale` 兜底推钉钉告警。

## 端点

| 端点 | 说明 |
|---|---|
| `GET /` | 仪表盘 SPA(信号 / 筛选 / 个股 / 指标 / AI 聊天 / 数据源 6 tab) |
| `GET /api/signals?limit=` | 最新交易日全市场信号 + **RSI 双口径列**(ETL·Cutler / Lume·Cutler 逐位对照 / Lume·Wilder 参考) |
| `POST /api/screen` | 规则筛选:白名单字段 `?` 占位绑定不拼 SQL;无过滤时回量比 Top N |
| `GET /api/stock/:code?days=` | 个股近 N 日 K 线 + ma5/ma20/rsi/macd 序列(代码自动归一 6 位→sh/sz/bj) |
| `GET /api/indicators/:code?days=&period=` | **Lume 内建现算**(读原始 OHLCV, 不读 ETL 列):KDJ/Williams/ATR/OBV/MA/MACD/RSI(Wilder+Cutler)/布林 + 绩效风险面板(夏普/Sortino/CVaR/VaR…)+ Lume 侧信号判定 |
| `GET /api/realtime/indexes` | 四大指数实时点位(腾讯文本源, 30s 缓存) |
| `GET /api/realtime/:code` | 单票实时价/涨跌/开高低昨收/量额/时间戳(15s 缓存; 停牌→`suspended`, 上游挂→`ok:false+reason` 前端降级) |
| `GET /api/meta` | 最新交易日/标的数/行数 |
| `POST /react/api/chat` | agent SSE 聊天(工具白名单直查库 + 查实时价; 未配 LLM 走离线 demo 引擎) |
| `GET /discovery` | 启动时发现的 skills / tools / mcps 一览 |

## RSI 双口径(为什么信号页有三列 RSI)

| 列 | 算法 | 来源 |
|---|---|---|
| RSI(ETL·Cutler) | 涨/跌各取 rolling(14).mean() | stock-analyzer ETL 存库列 |
| RSI(Lume·Cutler) | 同算法 Lume 内建 `rsi_cutler` 现算 | 逐位 Δ≈0 = 移植正确性证据(全量库 80/80 match) |
| RSI(Lume·Wilder) | Wilder 原著 EMA(SMA 种子 + 递归) | 跨口径参考, 与 Cutler 分叉属正常 |

## agent 工具(`src/repo.lume` 顶层注册, 全部只读, 白名单由 env 注入)

- `scan_signals` / `screen_stocks` / `stock_kline` / `stock_indicators` — 库内 T-1 数据
- `realtime_quote` / `market_indexes` — 盘中实时价(腾讯源, 服务端缓存)
- `sql_query` / `sql_tables` / `sql_schema` / `read_file` / `get_time` — introspect + 基础

`make real` 与 docker compose 都注入 `HARNESS_TOOLS_ALLOW`(Makefile `SCANNER_TOOLS`, 不含 `sql_write`)。

## 安全

- 默认绑 `127.0.0.1`; 对外部署注入 `HTPASSWD_FILE` 开 Basic Auth。docker compose 端口
  默认映射 `127.0.0.1:18094`(仅本机) —— 容器内 Lume 自身绑 `0.0.0.0` 且无鉴权, 若映射到
  宿主 `0.0.0.0`, 局域网任何设备即可匿名读全市场数据并消耗你的 `LLM_API_KEY` 额度;
  需共享时显式 `PORT=0.0.0.0:18094 make docker-up` 并同时注入 `HTPASSWD_FILE`。
- `sql_query` 物理只读 + SELECT-only 护栏; agent `read_file` 经 `resolve_within()`
  锁在 web root(`www/`), 路径穿越拒绝; 本服务永不写库(docker 真实库挂载为 `:ro`)。
- 实时行情只读公开行情源, 数据不外发; LLM 未配置时聊天降级离线引擎。
- `.env`(含 LLM key) 权限 600, 不进 git; 聊天会话 `.data/sessions/` 不进 git 也不进镜像。
- 行情数据为交易所/行情商公开数据, 本项目为个人本地分析工具, 不收集任何用户个人数据。
