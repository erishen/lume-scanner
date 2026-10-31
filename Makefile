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

# 隐私检查(仓库公开): 已跟踪 + 未跟踪文件里不得出现真实局域网标识。
# 新写的文件最容易带进真实网段, 所以默认也扫未跟踪的(被 .gitignore 忽略的除外)。
# 示例值统一用 192.168.1.x / aa:bb:cc:dd:ee:ff; 确需放行的例外加进脚本的允许清单。
privacy:
	@$(PY) scripts/check_privacy.py $(if $(LOCAL),--local,)

# 单测（标准库 unittest，无第三方依赖）：隐私检查的扫描范围护栏。
# 不放进 check：check 是 DSL 语法检查，跑得快；单测要起子进程造临时 git 仓库，
# 慢一个数量级。分开跑，CI 里两个都执行。
test:
	@$(PY) -m unittest discover -s tests -v

check:
	@$(LUME) --check scanner.lume

# TypeScript 全量类型检查(esbuild 只剥类型不查错)。首次可能冷启 node_modules。
typecheck:
	@../lume/frontend/node_modules/.bin/tsc -p tsconfig.json --noEmit
	@echo "✓ TS 类型检查通过"

ui:
	@$(ESBUILD) src/scanner/app.tsx --bundle --minify --format=esm --jsx=automatic --outdir=www --outbase=src/scanner
	@$(call bump_cache_stamp)
	@echo "✓ 已构建 www/app.js + 缓存戳 ?v=$(STAMP) (make ui 自动生成, 免手改 index.html)"

# 缓存戳: 把 www/index.html 里所有 "?v=<旧戳>" 原地改成当前时间戳。
# 幂等 —— 无论旧值是手写的还是上次 build 生成的都能匹配, 杜绝"忘改戳→用户拿旧 bundle"。
STAMP := $(shell date +%Y%m%d%H%M)
define bump_cache_stamp
	@sed -Ei.bak 's|\?v=[^&"]*|?v=$(STAMP)|g' www/index.html && rm -f www/index.html.bak
endef

# 非 minify 本地构建(排前端 bug 用)。只覆盖 www/app.js,排完再 make ui 重新 minify。
ui-dev:
	@echo "▶ 非 minify 构建 → www/app.js"
	@$(ESBUILD) src/scanner/app.tsx --bundle --format=esm --jsx=automatic --outdir=www --outbase=src/scanner

watch:
	@$(ESBUILD) src/scanner/app.tsx --bundle --format=esm --jsx=automatic --outdir=www --outbase=src/scanner --watch

# 全量真实库: 不用样例库, 直接指向 stock-analyzer 的 data/ 双库(8.5M 行, 走索引毫秒级)
REAL_DATA ?= ../../../invest-kit/apps/stock-analyzer/data
# agent 原生 SQL 工具(sql_query/sql_tables/sql_schema)只有在 SQLITE_DB 存在时才注册
# (agent-httpd/src/agent/sqlite_tool.c: sqlite_tools_init)。dev 用样例库, real 用全量库,
# 两处各指向当次运行的 SCANNER_DB, 保证本地与容器(compose 里同一变量)行为一致。
SCANNER_DB_PATH ?= $(if $(filter real,$(MAKECMDGOALS)),$(REAL_DATA)/stock_analysis.db,.data/scanner.db)
# agent 工具白名单(本地只读 3 个 + SQL introspect + 基础工具, 不放行 sql_write)
SCANNER_TOOLS ?= scan_signals,screen_stocks,stock_kline,stock_indicators,realtime_quote,market_indexes,signal_stats,daily_picks,paper_portfolio,data_freshness,sql_query,sql_tables,sql_schema,read_file,get_time

# agent 技能白名单: 限制 llm-router 从上游网关同步下来的共享技能目录(skills/router/)。
# 扫描器只保留投资周报 weekly-investment; 其余 code-review/rust-review/hot-news-post(写社媒)/post-comment(写 WP)
# 等与股票无关或写型技能一律不暴露(单一职责 + 零写基调)。
# 注: 若完全不注入该环境变量, agent-httpd 会放行全部 router 同步技能(见 skills.c 的 skill_allowed);
#     空字符串同样=放行全部, 故此处必须给具体值, 不能设空。
SCANNER_SKILLS ?= weekly-investment

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
	@# lume-core/lib 在构建上下文之外(Docker 不允许 COPY ../), 先同步进来,
	@# 再由 Dockerfile COPY 到镜像根 /lume-core/lib —— peer_node.lume 里
	@# "../lume-core/lib/peer.lume" 从 /app 解析出来就是这个位置。
	@if [ -d ../lume-core/lib ]; then \
	  rm -rf .runtime/lume-core && mkdir -p .runtime/lume-core && \
	  cp -R ../lume-core/lib .runtime/lume-core/; \
	else echo "✗ 找不到 ../lume-core/lib" >&2; exit 1; fi
	@echo "▶ build app erishen/lume-scanner"
	@cd ../ && $(DOCKER) build -f lume-scanner/Dockerfile -t erishen/lume-scanner lume-scanner/

# peer 节点是独立容器, 是否启用由 **.env 里的 COMPOSE_PROFILES** 决定:
#   COMPOSE_PROFILES=peer   → docker-up / docker-peer-up 都会带上它
#   没有这一行               → 只起主服务
#
# 不硬编码 --profile: 命令行 profile 会和 .env 叠加, 那样即使 .env 关了,
# 敲一次 docker-peer-up 也会起起来 —— 开关就形同虚设。
docker-peer-up: check-peer-net
	@if ! grep -qE '^COMPOSE_PROFILES=.*peer' .env 2>/dev/null; then \
	  echo "✗ .env 里没有 COMPOSE_PROFILES=peer —— peer 节点未启用"; \
	  echo "  要启用: 在 .env 加一行 COMPOSE_PROFILES=peer(并配好 PEER_SHARED/PEER_ROOT)"; \
	  exit 1; fi
	@$(DOCKER) compose up -d peer

# 给本节点的 peer 配一个自己的 agent(可选)。
#
# 为什么是"可选、单独一个目标": 装了它, 对端才能用 <node>__ask 委派判断;
# 不装, 对端只能 <node>__<tool> 取数据。两种都合法 —— 纯数据节点没必要
# 每个都跑一个模型。
#
# 端口 18199 而不是 18099: 本机可能同时跑着 lume-lan 的 agent(18099),
# 同一端口会互相顶掉, 而报错只是"连不上"。
SCANNER_AGENT_PORT ?= 18199
# 单次委派的等待上限。scanner 的 agent 常会跑 weekly-investment 这类重技能,
# 默认 90s 实测不够(流程本身要 100s+), 表现是"对端答了但连接已超时"。
# 这里放宽到 300s; 主 agent 那侧也有自己的超时, 两边都要够长。
SCANNER_AGENT_TIMEOUT ?= 300
AGENT_HTTPD ?= ../lume/agent-httpd/bin/agent-httpd

agent-up:
	@if [ ! -x "$(AGENT_HTTPD)" ]; then \
	  echo "✗ 找不到 $(AGENT_HTTPD) —— 先 cd ../lume/agent-httpd && make" >&2; exit 1; fi
	@if lsof -nP -iTCP:$(SCANNER_AGENT_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
	  echo "  scanner agent :$(SCANNER_AGENT_PORT) 已在监听"; \
	 else \
	  LLM_API_URL="$$(grep -E '^LLM_API_URL=' .env | cut -d= -f2-)" \
	  LLM_MODEL="$$(grep -E '^LLM_MODEL=' .env | cut -d= -f2-)" \
	  LLM_API_KEY="$$(grep -E '^LLM_API_KEY=' .env | cut -d= -f2-)" \
	    nohup $(AGENT_HTTPD) -p $(SCANNER_AGENT_PORT) -w 2 \
	      > .runtime-agent.log 2>&1 & \
	  echo $$! > .runtime-agent.pid; \
	  sleep 2; echo "  已启动 scanner agent :$(SCANNER_AGENT_PORT)"; fi

agent-down:
	@if lsof -nP -iTCP:$(SCANNER_AGENT_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
	  lsof -nP -tiTCP:$(SCANNER_AGENT_PORT) -sTCP:LISTEN | xargs kill 2>/dev/null || true; \
	  echo "  已停 scanner agent"; else echo "  scanner agent 未运行"; fi

# 自注册: 写 .data/peers.d/scanner.json, 让其它节点能认出本节点。
# 默认目录是 lume-lan/.data/peers.d(所有节点共用一处); 换位置设 PEER_REG_DIR。
PEER_REG_SHARED ?= ../lume-lan/.data/peers.d
peer-register:
	@mkdir -p $(PEER_REG_SHARED)
	@printf '%s\n' '{"node":"scanner","port":18103,"registered_at":'$$(date +%s)'}' \
	  > $(PEER_REG_SHARED)/scanner.json
	@echo "  已自注册 scanner → $(PEER_REG_SHARED)/scanner.json"

peer-registry:
	@ls -1 $(PEER_REG_SHARED) 2>/dev/null | sed 's/\.json$$//' | sed 's/^/  /' || echo "  (空)"

docker-peer-down:
	@$(DOCKER) compose stop peer 2>/dev/null || true
	@$(DOCKER) compose rm -f peer 2>/dev/null || true

docker-up:
	@$(DOCKER) compose up -d
	@echo "▶ 已起容器; 日志: $(DOCKER) compose logs -f  |  端口: 127.0.0.1:$(PORT)"

# ---- 跨应用共享网络(lume-peer-net) ----
#
# peer 容器不发布宿主端口(compose 里是 expose), 靠这张网按别名被看板等
# 应用访问(scanner-peer:18103)。
#
# external 而不是让本 compose 定义: 三个应用各自独立部署, 谁先起都不该
# 决定这张网的生命周期。代价是它可能不存在, 所以 peer 目标先过这个检查。
PEER_NET ?= lume-peer-net

check-peer-net:
	@if $(DOCKER) network inspect $(PEER_NET) >/dev/null 2>&1; then :; \
	 else \
	  echo "▶ 创建共享网络 $(PEER_NET)"; \
	  $(DOCKER) network create $(PEER_NET) >/dev/null; \
	 fi

peer-net-rm:
	@$(DOCKER) network rm $(PEER_NET) 2>/dev/null && echo "  已删除 $(PEER_NET)" \
	  || echo "  $(PEER_NET) 不存在或仍被容器占用"

docker-down:
	@# 显式带 --profile peer: compose down 只停"当前 profile 里"的服务,
	@# 一旦 .env 里关掉 COMPOSE_PROFILES, peer 就不在集合里, 容器会残留。
	@$(DOCKER) compose --profile peer down 2>/dev/null || $(DOCKER) compose down

real: stop check
	@echo "▶ http://127.0.0.1:$(PORT)  (make real: 真实 stock-analyzer 全量库, 工具白名单已注入)"
	@echo "  SCANNER_DB=$(REAL_DATA)/stock_analysis.db ASSET_DB=$(REAL_DATA)/asset_snapshot.db PAPER_PORTFOLIO=$(REAL_DATA)/paper_portfolio.json"
	@$(ESBUILD) src/scanner/app.tsx --bundle --minify --format=esm --jsx=automatic --outdir=www --outbase=src/scanner &
	@sleep 1
	@SCANNER_DB=$(REAL_DATA)/stock_analysis.db ASSET_DB=$(REAL_DATA)/asset_snapshot.db PAPER_PORTFOLIO=$(REAL_DATA)/paper_portfolio.json \
		SQLITE_DB=$(SCANNER_DB_PATH) \
		HARNESS_TOOLS_ALLOW=$(SCANNER_TOOLS) \
		HARNESS_SKILLS_ALLOW=$(SCANNER_SKILLS) \
		$(LUME) scanner.lume

# 日常入口(热更): stop(清旧实例)→ check → sample-data → esbuild --watch(后台)→ 前台起 Lume。
# 重复执行安全——每次先清掉占 PORT 的上次实例。
dev: stop check sample-data
	@echo "▶ http://127.0.0.1:$(PORT)  (make dev:热更已开,.tsx 改动自动重打包)"
	@echo "  数据源: .data/scanner.db + .data/asset.db(样例;生产设 SCANNER_DB/ASSET_DB)"
	@$(ESBUILD) src/scanner/app.tsx --bundle --format=esm --jsx=automatic --outdir=www --outbase=src/scanner --watch &
	@sleep 1
	@echo "▶ esbuild watch 后台运行;Ctrl-C 停服务(make stop 清残留 watch)"
	@SQLITE_DB=$(SCANNER_DB_PATH) HARNESS_SKILLS_ALLOW=$(SCANNER_SKILLS) $(LUME) scanner.lume

.PHONY: peer-serve peer-up peer-register peer-registry agent-up agent-down peer-down peer-status peer-check  default dev stop check typecheck sample-data ui ui-dev watch docker docker-base docker-app docker-up docker-down privacy test

# peer-node-targets
# ---- 本应用的 peer 节点(供其它 lume 应用发现与查询) ----
#
# 谁负责起: **本应用自己**。看板(lume-lan)只负责"探"和"展示", 不该替别的
# 应用管进程生命周期 —— 那会造成版本/配置永久漂移: 改了 peer_node.lume
# 或换了端口, 看板那边不知道, 也不会重启它。
#
# 端口约定(改这里要同时改 lume-lan/.env 的 PEER_TARGETS):
#   lume-blog    → 18321
#   lume-crm     → 18102
#   lume-scanner → 18103
PEER_PORT_RUN ?= 18103
# 绑定地址。默认 127.0.0.1(单机安全基线: 只有本机能连)。
#
# 跨机时必须设 0.0.0.0 —— 但那个决定不该藏在 Makefile 里: 之前这里是硬编码
# 127.0.0.1, 于是 .env 里写 PEER_BIND=0.0.0.0 完全不生效, 而文档却说"配
# PEER_BIND 即可"。这种"配了不生效"比"不支持"更难排查(实测另一台机器
# 连过来只得到连接被拒, 看起来像网络问题)。
#
# 现在: .env 的 PEER_BIND 优先, 没写才用 127.0.0.1。
PEER_BIND_RUN ?= $(shell grep -E '^PEER_BIND=' .env 2>/dev/null | cut -d= -f2- | sed 's/^$$/127.0.0.1/')
PEER_BIND_RUN := $(if $(PEER_BIND_RUN),$(PEER_BIND_RUN),127.0.0.1)
PEER_NAME_RUN ?= scanner
PEER_SHARED_RUN ?= $(shell grep -E '^PEER_SHARED=' .env 2>/dev/null | cut -d= -f2-)
PEER_ROOT_RUN ?= $(shell grep -E '^PEER_ROOT=' .env 2>/dev/null | cut -d= -f2-)
PEER_BIN ?= ../lume/bin/lume
SITE_NAME ?= lume-scanner

# 前台起(调试时看得见日志)。Ctrl-C 停。
peer-serve:
	@if [ ! -x "$(PEER_BIN)" ]; then \
	  echo "✗ 找不到 $(PEER_BIN) —— 先 cd ../lume && make" >&2; exit 1; fi
	@if [ -z "$(PEER_SHARED_RUN)$(PEER_ROOT_RUN)" ]; then \
	  echo "✗ .env 里 PEER_SHARED / PEER_ROOT 都是空的 —— 对端会拒绝所有请求" >&2; exit 1; fi
	@echo "▶ $(PEER_NAME_RUN) peer :$(PEER_PORT_RUN)"
	@PEER_NAME=$(PEER_NAME_RUN) PEER_PORT=$(PEER_PORT_RUN) PEER_BIND=$(PEER_BIND_RUN) \
	  PEER_SHARED="$(PEER_SHARED_RUN)" PEER_ROOT="$(PEER_ROOT_RUN)" \
	  PEER_SITE_NAME=$(SITE_NAME) \
	  $(PEER_BIN) peer_node.lume

# 后台常驻。日志落 .runtime-peer.log。
# 数据源: peer 节点读的是 repo.lume 的 SCANNER_DB/ASSET_DB, 而 .env 里只有
# STOCKANALYZER_DATA(那是给容器 volume 用的)。不打通的话, 宿主 peer 读
# `.data/` 的样例库(40 只), 容器 peer 读全量库(5574 只) —— 同一个节点
# 两种数据, 而这种不一致在界面上完全看不出来。
# .env 里的值不会自动进 make 变量, 显式读一下(只读这一个, 避免把密钥带进 make 变量表)
STOCKANALYZER_DATA ?= $(shell grep -E '^STOCKANALYZER_DATA=' .env 2>/dev/null | cut -d= -f2-)
PEER_DB_ENV = $(if $(wildcard $(STOCKANALYZER_DATA)),\
  SCANNER_DB=$(STOCKANALYZER_DATA)/stock_analysis.db ASSET_DB=$(STOCKANALYZER_DATA)/asset_snapshot.db,)

# 起本节点的 peer。顺带把自己的名字写进共享自注册目录 ——
# 别的节点靠扫那个目录认人, 所以"多了一个应用"不需要改它们的白名单。
peer-up: peer-register
	@if [ -x "$(PEER_BIN)" ]; then :; else \
	  echo "✗ 找不到 $(PEER_BIN) —— 先 cd ../lume && make" >&2; exit 1; fi
	@if lsof -nP -iTCP:$(PEER_PORT_RUN) -sTCP:LISTEN >/dev/null 2>&1; then \
	  echo "  $(PEER_NAME_RUN) :$(PEER_PORT_RUN) 已在监听"; \
	 else \
	  PEER_NAME=$(PEER_NAME_RUN) PEER_PORT=$(PEER_PORT_RUN) PEER_BIND=$(PEER_BIND_RUN) \
	  PEER_SHARED="$(PEER_SHARED_RUN)" PEER_ROOT="$(PEER_ROOT_RUN)" \
	  PEER_SITE_NAME=$(SITE_NAME) \
	  PEER_REG_DIR=$(PEER_REG_SHARED) \
	  AGENT_URL=http://127.0.0.1:$(SCANNER_AGENT_PORT) \
	  AGENT_TIMEOUT=$(SCANNER_AGENT_TIMEOUT) \
	  $(PEER_DB_ENV) \
	    nohup $(PEER_BIN) peer_node.lume < /dev/null > .runtime-peer.log 2>&1 & \
	  echo $! > .runtime-peer.pid; \
	  sleep 1; \
	  echo "  已启动 $(PEER_NAME_RUN) :$(PEER_PORT_RUN) → .runtime-peer.log"; fi

peer-down:
	@if [ -f .runtime-peer.pid ]; then \
	  kill $$(cat .runtime-peer.pid) 2>/dev/null && echo "  已停 $(PEER_NAME_RUN)" || true; \
	  rm -f .runtime-peer.pid; \
	 else echo "  $(PEER_NAME_RUN) 未在运行(或不是本仓库起的)"; fi

peer-status:
	@n=$$(lsof -nP -iTCP:$(PEER_PORT_RUN) -sTCP:LISTEN 2>/dev/null | wc -l | tr -d ' '); \
	 if [ "$$n" -gt 0 ]; then echo "  $(PEER_NAME_RUN) :$(PEER_PORT_RUN) 在监听"; \
	 else echo "  $(PEER_NAME_RUN) :$(PEER_PORT_RUN) 未运行"; fi

# 语法检查(用仓库里的 lume, 不用 ~/.local/bin 的旧版)
peer-check:
	@$(PEER_BIN) --check peer_node.lume
