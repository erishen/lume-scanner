# syntax=docker/dockerfile:1
# ============================================================================
# lume-scanner app 镜像 —— 在最新 C 源码基座上装 scanner DSL + 前端 + 样例库.
#
# 构建上下文 = work/lume/lume-scanner/ (自带 .dockerignore, 排除 node_modules/.git).
# 依赖上一份基座:
#   docker build -f lume/Dockerfile.scanner -t erishen/lume-scanner-base work/lume/lume/
#
# 数据:
#   - 缺省走内置 .data/ 样例库 (SCANNER_DB/ASSET_DB 未设时 repo.lume 的 fallback);
#   - compose 用 bind mount 把宿主 stock-analyzer 真实 data/ 挂进 /app/.data,
#     并以 SCANNER_DB/ASSET_DB 指向只读挂载的 8.5M 行全量库 (镜像不含数据)。
# ============================================================================
FROM erishen/lume-scanner-base

WORKDIR /app
# scanner.lume 相对 CWD=/app 解析: import "src/repo.lume" + docroot "./www"。
COPY scanner.lume ./
COPY src/ ./src/
COPY www/ ./www/
# 样例库 fallback (compose 挂真实库时这些被 SCANNER_DB/ASSET_DB 覆盖)
COPY .data/ ./.data/

USER 10001
# 容器内默认 8094; 宿主 compose 端口 18094->8094。默认 127.0.0.1, 对外须传 LUME_BIND=0.0.0.0。
EXPOSE 8094
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS -m 4 http://127.0.0.1:8094/api/meta >/dev/null || exit 1
CMD ["/usr/local/bin/lume", "scanner.lume"]
