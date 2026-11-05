#!/usr/bin/env bash
# vendor_lume.sh —— 把 framework 二进制 + lume-core 共享库落进仓内 vendor/, 解耦兄弟 checkout
#
# ══ 为什么要 vendor/ ════════════════════════════════════════════════════
# 项目源码 import 的是共享 .lume 模块(peer.lume 等, 解释器按路径读盘),
# 运行时还要一个 **framework 二进制**(含 RSI/量化内建 + agent 框架 + llm-router
# + `any` 类型)。两者都指向活着的兄弟 checkout:
#     import "vendor/lume-core/lib/peer.lume"   (原来是 ../lume-core/lib/...)
#     LUME=../lume/bin/lume                      (framework 二进制)
# 单独 git clone 下来的仓既起不来、import 也解析不了。本脚本把这两样固定落地。
#
# ══ vendor/ 布局 ═══════════════════════════════════════════════════════
#   vendor/lume/bin/lume          framework 二进制(不入库: 体积大、无法 review)
#   vendor/lume-core/lib/*.lume  共享 .lume 模块(入库: 解释器按路径 import 的源码)
#   vendor/.vendor-stamp         记录 bin 版本 + lib tag, 可查可复核
#
# ══ 两种来源(按优先级)═══════════════════════════════════════════════════
#   1) 本地兄弟 checkout  ../lume + ../lume-core  (monorepo 开发: 快、离线、改了即时生效)
#   2) GitHub release     erishen/lume + erishen/lume-core (单独 clone: 可复现)
#
# ⚠️ 二进制必须是 **framework**(../lume/bin/lume), 不是语言核心(../lume-core/bin/lume-core):
# 业务内建(rsi_cutler / any / agent 框架)只在 framework 里, 拿语言核心 check 会漏报。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor"
LUME_BIN="$VENDOR/lume/bin/lume"          # framework 二进制
LUME_CORE_LIB="$VENDOR/lume-core/lib"     # 共享 .lume 库
STAMP="$VENDOR/.vendor-stamp"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

# 要 vendor 的库文件(peer.lume 会 import 同目录 identity.lume, 所以整包带)
LIB_FILES="approval.lume domains.lume graph.lume identity.lume linalg.lume \
ml.lume optim.lume peer.lume sci.lume sig.lume"

# pin 的版本(release 分支用; 本地分支用活 checkout)
LUME_FRAMEWORK_VERSION="${LUME_VERSION:-v0.12.2}"    # framework 二进制(erishen/lume release)
LUME_CORE_TAG="${LUME_CORE_TAG:-v0.12.1}"            # 共享库(erishen/lume-core release, 与二进制同代)
LUME_REPO="${LUME_REPO:-erishen/lume}"
LUME_CORE_REPO="${LUME_CORE_REPO:-erishen/lume-core}"

have_local_lume() { [ -f "$ROOT/../lume/bin/lume" ]; }
have_local_core() { [ -d "$ROOT/../lume-core/lib" ]; }

# ── 本地兄弟 checkout 分支(monorepo 开发)─────────────────────────────
# 二进制软链(不 cp: macOS 复制会破坏 codesign, 触发 amfi Killed:9)。
# lib 取本地工作树(活代码, 改了即时生效); 想用 pinned tag 就 LUME_CORE_TAG 走 git show。
vendor_from_local() {
  mkdir -p "$(dirname "$LUME_BIN")" "$LUME_CORE_LIB"
  ln -sf "$ROOT/../lume/bin/lume" "$LUME_BIN"
  local ok=1 f
  for f in $LIB_FILES; do
    if [ -f "$ROOT/../lume-core/lib/$f" ]; then
      # 默认用工作树; 若设了 LUME_CORE_PIN=1 则从 tag 取
      if [ "${LUME_CORE_PIN:-0}" = "1" ] && git -C "$ROOT/../lume-core" show "$LUME_CORE_TAG:lib/$f" > "$LUME_CORE_LIB/$f" 2>/dev/null; then
        :
      else
        cp "$ROOT/../lume-core/lib/$f" "$LUME_CORE_LIB/$f"
      fi
    else
      ok=0
      echo "✗ 本地缺 $ROOT/../lume-core/lib/$f" >&2
    fi
  done
  local binver
  binver="$("$LUME_BIN" --version 2>/dev/null | head -1 || echo unknown)"
  {
    echo "source=local-checkout"
    echo "bin=$binver"
    echo "lib=working-tree$( [ "$ok" = "1" ] || echo "(不完整)" )"
    echo "lib_files=$(ls "$LUME_CORE_LIB" 2>/dev/null | wc -l | tr -d ' ')"
  } > "$STAMP"
}

# ── GitHub release 分支(单独 clone, 可复现)────────────────────────────
vendor_from_release() {
  mkdir -p "$(dirname "$LUME_BIN")" "$LUME_CORE_LIB"
  local os carch tmp
  os="$(uname -s | tr 'A-Z' 'a-z')"        # darwin / linux
  case "$(uname -m)" in
    arm64|aarch64) carch=arm64 ;;
    x86_64|amd64)  carch=x64 ;;
    *) echo "✗ 不支持的架构: $(uname -m)" >&2; exit 1 ;;
  esac
  tmp="$ROOT/.vendor-dl.$$"
  mkdir -p "$tmp"
  # 1) framework 二进制(与 Dockerfile 同款: <arch>-static 资产)
  echo "▶ 拉 framework 二进制 ${LUME_REPO} ${LUME_FRAMEWORK_VERSION} (${os}-${carch}-static)"
  curl -fsSL --retry 3 -o "$tmp/lume-static.tar.gz" \
    "https://github.com/${LUME_REPO}/releases/download/${LUME_FRAMEWORK_VERSION}/lume-${os}-${carch}-static.tar.gz"
  tar -xzf "$tmp/lume-static.tar.gz" -C "$tmp"
  local lsrc
  lsrc="$(find "$tmp" -name 'lume' -type f 2>/dev/null | head -1)"
  [ -n "$lsrc" ] || { echo "✗ 解压后找不到 framework 二进制" >&2; rm -rf "$tmp"; exit 1; }
  cp "$lsrc" "$LUME_BIN"
  chmod +x "$LUME_BIN"
  # 2) 共享库
  echo "▶ 拉 lume-core 库 ${LUME_CORE_REPO} ${LUME_CORE_TAG} (${os}-${carch})"
  curl -fsSL --retry 3 -o "$tmp/core.tar.gz" \
    "https://github.com/${LUME_CORE_REPO}/releases/download/${LUME_CORE_TAG}/lume-core-${os}-${carch}.tar.gz"
  tar -xzf "$tmp/core.tar.gz" -C "$tmp"
  local csrc="$tmp/lume-core-${os}-${carch}"
  local f
  for f in $LIB_FILES; do
    [ -f "$csrc/lib/$f" ] && cp "$csrc/lib/$f" "$LUME_CORE_LIB/$f"
  done
  rm -rf "$tmp"
  {
    echo "source=release"
    echo "bin=${LUME_FRAMEWORK_VERSION}(${LUME_REPO})"
    echo "lib_tag=${LUME_CORE_TAG}(${LUME_CORE_REPO})"
    echo "lib_files=$(ls "$LUME_CORE_LIB" 2>/dev/null | wc -l | tr -d ' ')"
  } > "$STAMP"
}

# ── 主流程 ────────────────────────────────────────────────────────────
if [ "$CHECK_ONLY" = "1" ]; then
  [ -f "$LUME_BIN" ] || { echo "✗ vendor 二进制缺失(先跑: make bootstrap)"; exit 1; }
  [ -f "$LUME_CORE_LIB/peer.lume" ] || { echo "✗ vendor/lume-core/lib/peer.lume 缺失"; exit 1; }
  # 自检: 用 vendor 二进制 check 项目入口(VENDOR_CHECK_ENTRY)或库自身。
  # 项目入口能过, 才证明二进制配对了(业务内建齐全)。
  local_entry="${VENDOR_CHECK_ENTRY:-$LUME_CORE_LIB/peer.lume}"
  [ -f "$local_entry" ] || local_entry="$LUME_CORE_LIB/peer.lume"
  ok=0; i=0
  for i in 1 2 3; do
    if "$LUME_BIN" --check "$local_entry" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  [ "$ok" = "1" ] || { echo "✗ vendor 二进制无法 check $local_entry(版本/类型不匹配)"; exit 1; }
  echo "✓ vendor 就绪: $(grep -E '^(bin|lib)' "$STAMP" 2>/dev/null | tr '\n' ' ')"
  exit 0
fi

if have_local_lume && have_local_core; then
  vendor_from_local
else
  vendor_from_release
fi
echo "▶ vendor 已就绪($([ -f "$STAMP" ] && cat "$STAMP" | tr '\n' ' '))"
exec bash "$0" --check
