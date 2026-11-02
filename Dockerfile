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
FROM erishen/lume-scanner-base:latest

WORKDIR /app
# scanner.lume 相对 CWD=/app 解析: import "src/repo.lume" + docroot "./www"。
COPY scanner.lume ./
COPY src/ ./src/
COPY www/ ./www/
# peer 节点: 让扫描结果能被其它 lume 应用(如 lume-lan"应用互访")查询。
# 与 scanner.lume 各自一个 server{}, 主服务不用改。
COPY peer_node.lume ./
# ── lume-core/lib: 按版本从 release 取 ─────────────────────────────────
# peer_node.lume 里写 import "../lume-core/lib/peer.lume", 从 /app 解析就是
# /lume-core/lib/。这些是 **.lume 源码**(运行时读盘), 不编进二进制。
# 以前从 ../lume-core/lib 复制进 .runtime/ 再 COPY —— 那份副本无版本标记,
# 会静默停在旧版(镜像里 13KB 的 peer.lume / 源码 17KB), 症状只是
# "module 'peer' has no export 'config_warnings'", 指不到旧文件。
ARG LUME_CORE_VERSION=v0.12.1
ARG LUME_CORE_REPO=erishen/lume-core
ARG TARGETARCH
# base 镜像已经 USER 10001, 非 root 建不了 /lume-core。
# 临时切回 root 只做这一层(下载+落盘), 下一行立刻回到 10001 ——
# 最终容器的运行身份不变。
USER root
RUN set -eux; \
    case "${TARGETARCH:-arm64}" in \
      amd64) carch=x64 ;; \
      arm64) carch=arm64 ;; \
      *) echo "unsupported TARGETARCH='${TARGETARCH}'" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/${LUME_CORE_REPO}/releases/download/${LUME_CORE_VERSION}"; \
    asset="lume-core-linux-${carch}"; \
    curl -fsSL --retry 3 --retry-delay 2 -o /tmp/core.tar.gz "${base}/${asset}.tar.gz"; \
    curl -fsSL --retry 3 -o /tmp/core.sha256 "${base}/${asset}.sha256"; \
    (cd /tmp && sed "s|${asset}.tar.gz|core.tar.gz|" core.sha256 | sha256sum -c -); \
    mkdir -p /tmp/core && tar -xzf /tmp/core.tar.gz -C /tmp/core; \
    mkdir -p /lume-core; \
    cp -r "/tmp/core/${asset}/lib" /lume-core/lib; \
    test -f /lume-core/lib/peer.lume; \
    rm -rf /tmp/core /tmp/core.tar.gz /tmp/core.sha256
# 样例库 fallback (compose 挂真实库时这些被 SCANNER_DB/ASSET_DB 覆盖)
COPY .data/ ./.data/

USER 10001
# 容器内默认 8094; 宿主 compose 端口 18094->8094。默认 127.0.0.1, 对外须传 LUME_BIND=0.0.0.0。
EXPOSE 8094
# 健康检查跟着 peer 走: peer 容器跑的是 peer_node.lume(端口 18103, 端点
# /peer/health), 不是主服务(8094, /api/meta)。写死 8094 会让 peer 容器
# 永远 unhealthy —— 服务其实是好的, 只是探针问错了地方。
#
# 用 PEER_PORT 是否存在来切换: 只有 peer 容器会设它(见 compose 的 peer 服务),
# 主服务不设, 行为与之前完全一致。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD if [ -n "$PEER_PORT" ]; then \
          curl -fsS -m 4 "http://127.0.0.1:$PEER_PORT/peer/health" >/dev/null || exit 1; \
        else \
          curl -fsS -m 4 http://127.0.0.1:8094/api/meta >/dev/null || exit 1; \
        fi
CMD ["/usr/local/bin/lume", "scanner.lume"]
