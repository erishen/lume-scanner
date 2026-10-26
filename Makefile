# lume-scanner Makefile — A 股信号扫描(Lume 服务端 + React + 样例库)
#
# 常用:
#   make dev       日常入口(热更): stop 清旧实例 → check → sample-data(建 .data/ 样例库)→
#                  esbuild --watch(改 .tsx 自动重打包) + 前台起 Lume。
#   make stop      只停: kill PORT 上旧服务 + 残留 esbuild watch
#
# 分步:
#   make sample-data  从 stock-analyzer 真实库抽撮数 → .data/scanner.db + .data/asset.db
#   make ui           一次性构建前端(esbuild 单次 → www/app.js,非 watch;dev 用 watch)
#   make check        只跑 Lume 类型检查(scanner.lume + src/repo.lume)
#
# 依赖:
#   LUME = ~/.local/bin/lume(release;安装 curl …/install.sh | sh)
#   esbuild 走 PATH,兜底 ../lume/frontend/node_modules
#   样例库脚本用 /usr/bin/python3(无第三方依赖)
#
# 生产数据源: 不用样例库时,设 SCANNER_DB / ASSET_DB 指向真实 stock-analyzer data/ 双库
#   SCANNER_DB=/path/stock_analysis.db ASSET_DB=/path/asset_snapshot.db make dev

# 默认用邻居宿主树的本地构建(含 #54 序列指标内建; 安装件 ~/.local/bin/lume
# 是 0.8.1 老版, 没有 kdj/atr/obv 等, 用它 check 会报 undefined variable)。
# 想用安装件可 LUME=~/.local/bin/lume make dev(需先把宿主树 make 后重装)。
LUME   ?= $(CURDIR)/../lume/bin/lume
PORT   ?= 8094
PY     ?= /usr/bin/python3

ESBUILD := $(shell command -v esbuild 2>/dev/null || echo ../lume/frontend/node_modules/.bin/esbuild)

# 样例库默认源: 真实 stock-analyzer(可用 env SCANNER_SRC / ASSET_SRC 覆盖)
STOCKANALYZER ?= ../../../invest-kit/apps/stock-analyzer/data

default: dev

# 停掉 PORT 上的旧服务 + 残留 esbuild watch
stop:
	@{ lsof -ti tcp:$(PORT) 2>/dev/null; pgrep -f "scanner\.lume" 2>/dev/null; } \
	| xargs -r kill 2>/dev/null || true
	@pkill -f "esbuild src/scanner/app.tsx" 2>/dev/null || true
	@sleep 1
	@echo "已停 $(PORT) 上的旧服务与残留 esbuild watch"

# 样例库: 从真实 stock-analyzer 抽数据到 .data/
sample-data:
	@mkdir -p .data
	@SCANNER_SRC=$(STOCKANALYZER)/stock_analysis.db ASSET_SRC=$(STOCKANALYZER)/asset_snapshot.db \
		$(PY) scripts/make_sample_data.py --out .data

check:
	@$(LUME) --check scanner.lume

# TypeScript 全量类型检查(esbuild 只剥类型不查错)。首次可能冷启 node_modules。
typecheck:
	@../lume/frontend/node_modules/.bin/tsc -p tsconfig.json --noEmit
	@echo "✓ TS 类型检查通过"

ui:
	@$(ESBUILD) src/scanner/app.tsx --bundle --minify --format=esm --jsx=automatic --outdir=www --outbase=src/scanner

# 非 minify 本地构建(排前端 bug 用)。只覆盖 www/app.js,排完再 make ui 重新 minify。
ui-dev:
	@echo "▶ 非 minify 构建 → www/app.js"
	@$(ESBUILD) src/scanner/app.tsx --bundle --format=esm --jsx=automatic --outdir=www --outbase=src/scanner

watch:
	@$(ESBUILD) src/scanner/app.tsx --bundle --format=esm --jsx=automatic --outdir=www --outbase=src/scanner --watch

# 全量真实库: 不用样例库, 直接指向 stock-analyzer 的 data/ 双库(8.5M 行, 走索引毫秒级)
REAL_DATA ?= ../../../invest-kit/apps/stock-analyzer/data
# agent 工具白名单(本地只读 3 个 + SQL introspect + 基础工具, 不放行 sql_write)
SCANNER_TOOLS ?= scan_signals,screen_stocks,stock_kline,stock_indicators,realtime_quote,market_indexes,signal_stats,daily_picks,paper_portfolio,data_freshness,sql_query,sql_tables,sql_schema,read_file,get_time

# Docker 构建/运行 (OrbStack daemon; 沙箱无 DOCKER_HOST 时由宿主终端跑)
# 基座: 容器内重编当前宿主 lume/ C 源码(带 #54/#55 内建, 非老 v0.6.3), 静态 Linux bin/lume。
# app:  基座 + scanner.lume/src/www/样例 .data。真实库不进镜像, compose 只读挂载。
DOCKER ?= docker

docker: docker-base docker-app
	@echo "▶ docker 镜像已就绪, 起容器: $(DOCKER) compose up -d  (http://127.0.0.1:$(PORT))"

docker-base:
	@echo "▶ build 基座 erishen/lume-scanner-base (容器内重编 C, 约 1-3min)"
	@cd ../ && $(DOCKER) build -f lume/Dockerfile.scanner -t erishen/lume-scanner-base lume/

docker-app:
	@echo "▶ build app erishen/lume-scanner"
	@cd ../ && $(DOCKER) build -f lume-scanner/Dockerfile -t erishen/lume-scanner lume-scanner/

docker-up:
	@$(DOCKER) compose up -d
	@echo "▶ 已起容器; 日志: $(DOCKER) compose logs -f  |  端口: 127.0.0.1:$(PORT)"

docker-down:
	@$(DOCKER) compose down

real: stop check
	@echo "▶ http://127.0.0.1:$(PORT)  (make real: 真实 stock-analyzer 全量库, 工具白名单已注入)"
	@echo "  SCANNER_DB=$(REAL_DATA)/stock_analysis.db ASSET_DB=$(REAL_DATA)/asset_snapshot.db PAPER_PORTFOLIO=$(REAL_DATA)/paper_portfolio.json"
	@$(ESBUILD) src/scanner/app.tsx --bundle --minify --format=esm --jsx=automatic --outdir=www --outbase=src/scanner &
	@sleep 1
	@SCANNER_DB=$(REAL_DATA)/stock_analysis.db ASSET_DB=$(REAL_DATA)/asset_snapshot.db PAPER_PORTFOLIO=$(REAL_DATA)/paper_portfolio.json \
		HARNESS_TOOLS_ALLOW=$(SCANNER_TOOLS) \
		$(LUME) scanner.lume

# 日常入口(热更): stop(清旧实例)→ check → sample-data → esbuild --watch(后台)→ 前台起 Lume。
# 重复执行安全——每次先清掉占 PORT 的上次实例。
dev: stop check sample-data
	@echo "▶ http://127.0.0.1:$(PORT)  (make dev:热更已开,.tsx 改动自动重打包)"
	@echo "  数据源: .data/scanner.db + .data/asset.db(样例;生产设 SCANNER_DB/ASSET_DB)"
	@$(ESBUILD) src/scanner/app.tsx --bundle --format=esm --jsx=automatic --outdir=www --outbase=src/scanner --watch &
	@sleep 1
	@echo "▶ esbuild watch 后台运行;Ctrl-C 停服务(make stop 清残留 watch)"
	@$(LUME) scanner.lume

.PHONY: default dev stop check typecheck sample-data ui ui-dev watch docker docker-base docker-app docker-up docker-down
