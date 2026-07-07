#!/usr/bin/env bash
#
# 从 GitHub 下载最新 release，验证 sha256，安装/更新 pi。
# 安装前会 rm -rf 安装目录，避免 pi 正在运行时文件繁忙导致无法覆盖。
#
# 用法:
#   ./scripts/update.sh
#   curl -fsSL https://raw.githubusercontent.com/schovest/pi/main/scripts/update.sh | bash
#
# 环境变量:
#   PI_INSTALL_PREFIX   安装目录 (默认 ~/.local/share/pi)
#   PI_INSTALL_BINDIR   符号链接目录 (默认 ~/.local/bin)

set -euo pipefail

GITHUB_REPO="schovest/pi"
PREFIX="${PI_INSTALL_PREFIX:-$HOME/.local/share/pi}"
BINDIR="${PI_INSTALL_BINDIR:-$HOME/.local/bin}"

# ---------------------------------------------------------------------------
# 平台检测
# ---------------------------------------------------------------------------

detect_platform() {
	local os arch
	os=$(uname -s | tr '[:upper:]' '[:lower:]')
	arch=$(uname -m)
	case "$arch" in
		x86_64) arch="x64" ;;
		aarch64|arm64) arch="arm64" ;;
		*) echo "错误: 不支持的架构 $arch" >&2; exit 1 ;;
	esac
	case "$os" in
		darwin|linux) echo "${os}-${arch}" ;;
		*) echo "错误: 不支持的系统 $os (仅支持 macOS/Linux)" >&2; exit 1 ;;
	esac
}

PLATFORM=$(detect_platform)
ARCHIVE="pi-${PLATFORM}.tar.gz"

# ---------------------------------------------------------------------------
# 获取最新 release
# ---------------------------------------------------------------------------

echo "==> 获取最新 release..."

RELEASE_TAG=$(curl -fsSL "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" 2>/dev/null \
	| sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$RELEASE_TAG" ]; then
	echo "错误: 无法获取最新 release 版本号" >&2
	exit 1
fi

echo "    最新版本: $RELEASE_TAG"
echo "    平台:     $PLATFORM"

# ---------------------------------------------------------------------------
# 下载 archive + checksums
# ---------------------------------------------------------------------------

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

BASE_URL="https://github.com/${GITHUB_REPO}/releases/download/${RELEASE_TAG}"

echo "==> 下载 $ARCHIVE ..."
curl -fsSL -o "$TMPDIR/$ARCHIVE" "${BASE_URL}/${ARCHIVE}"

echo "==> 下载 sha256sums.txt ..."
curl -fsSL -o "$TMPDIR/sha256sums.txt" "${BASE_URL}/sha256sums.txt"

# ---------------------------------------------------------------------------
# 验证 hash
# ---------------------------------------------------------------------------

echo "==> 验证完整性 ..."

EXPECTED=$(grep "  ${ARCHIVE}$" "$TMPDIR/sha256sums.txt" | awk '{print $1}')
if [ -z "$EXPECTED" ]; then
	echo "错误: sha256sums.txt 中未找到 $ARCHIVE 的校验值" >&2
	exit 1
fi

if command -v sha256sum &>/dev/null; then
	ACTUAL=$(sha256sum "$TMPDIR/$ARCHIVE" | awk '{print $1}')
else
	# macOS 自带 shasum
	ACTUAL=$(shasum -a 256 "$TMPDIR/$ARCHIVE" | awk '{print $1}')
fi

if [ "$EXPECTED" != "$ACTUAL" ]; then
	echo "错误: hash 不匹配!" >&2
	echo "  期望: $EXPECTED" >&2
	echo "  实际: $ACTUAL" >&2
	exit 1
fi

echo "    ✓ 完整性验证通过"

# ---------------------------------------------------------------------------
# 解压
# ---------------------------------------------------------------------------

echo "==> 解压 ..."
mkdir -p "$TMPDIR/extracted"
tar xzf "$TMPDIR/$ARCHIVE" -C "$TMPDIR/extracted"

if [ ! -d "$TMPDIR/extracted/pi" ]; then
	echo "错误: 解压后未找到 pi/ 目录" >&2
	exit 1
fi

# ---------------------------------------------------------------------------
# 安装：先清理旧目录，再调用 install.sh
# ---------------------------------------------------------------------------

echo "==> 清理旧安装目录 ($PREFIX) ..."
rm -rf "$PREFIX"

echo "==> 安装 ..."
cd "$TMPDIR/extracted/pi"
bash ./install.sh

echo ""
echo "==> 更新完成: $RELEASE_TAG"
