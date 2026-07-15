#!/usr/bin/env bash
#
# 从 GitHub 下载最新 release，验证 sha256，安装/更新 pi。
# 已安装且为最新版本时自动跳过；更新前会 rm -rf 安装目录，
# 避免 pi 正在运行时文件繁忙导致无法覆盖。
#
# 用法:
#   ./scripts/update.sh
#   curl -fsSL https://raw.githubusercontent.com/schovest/pi/main/scripts/update.sh | bash
#
# 环境变量:
#   PI_INSTALL_PREFIX   安装目录 (默认 ~/.local/share/pi)
#   PI_INSTALL_BINDIR   符号链接目录 (默认 ~/.local/bin)
#   PI_FORCE_UPDATE     设为 1 时强制更新，跳过版本检查

set -euo pipefail

GITHUB_REPO="schovest/pi"
# ---------------------------------------------------------------------------
# 安装目录检测
#   优先级：环境变量 > 保存的配置 > 符号链接解析 > 默认值
#   确保升级时正确定位用户自定义的安装目录
# ---------------------------------------------------------------------------

if [ -z "${PI_INSTALL_PREFIX:-}" ]; then
	if [ -f "$HOME/.pi/agent/.install-prefix" ]; then
		PI_INSTALL_PREFIX=$(cat "$HOME/.pi/agent/.install-prefix" 2>/dev/null)
	elif [ -L "$HOME/.local/bin/pi" ]; then
		# 通过符号链接解析实际安装目录
		_resolved=$(readlink -f "$HOME/.local/bin/pi" 2>/dev/null)
		if [ -n "$_resolved" ]; then
			PI_INSTALL_PREFIX=$(dirname "$_resolved")
		fi
	fi
fi

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
#
# 首选方案：利用 https://github.com/<repo>/releases/latest 的 302 重定向
#   到 /releases/tag/vX.Y.Z，只请求 github.com 网页前端，完全不走 API，
#   不受匿名用户 60 次/小时的速率限制。
# 回退方案：GitHub API releases/latest（受速率限制，仅在首选方案失败时使用）。
# ---------------------------------------------------------------------------

get_latest_tag() {
	local url tag

	# 首选：网页重定向（无速率限制）
	url=$(curl -fsSL -o /dev/null -w '%{url_effective}' \
		"https://github.com/${GITHUB_REPO}/releases/latest" 2>/dev/null) || url=""
	if [ -n "$url" ]; then
		# 从 .../releases/tag/vX.Y.Z 中提取 tag；无 /tag/ 时原样返回，据此判断失败
		tag="${url##*/tag/}"
		if [ -n "$tag" ] && [ "$tag" != "$url" ]; then
			printf '%s' "$tag"
			return 0
		fi
	fi

	# 回退：GitHub API（匿名限速 60 次/小时）
	tag=$(curl -fsSL "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" 2>/dev/null \
		| sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
	if [ -n "$tag" ]; then
		printf '%s' "$tag"
		return 0
	fi

	return 1
}

echo "==> 获取最新 release..."

RELEASE_TAG=$(get_latest_tag)

if [ -z "$RELEASE_TAG" ]; then
	echo "错误: 无法获取最新 release 版本号" >&2
	exit 1
fi

# 去掉 'v' 前缀，用于版本对比
LATEST_VERSION="${RELEASE_TAG#v}"

echo "    最新版本: $RELEASE_TAG"
echo "    平台:     $PLATFORM"

# ---------------------------------------------------------------------------
# 版本检查：已安装且为最新则跳过（PI_FORCE_UPDATE=1 时强制更新）
# ---------------------------------------------------------------------------

if [ -x "$PREFIX/pi" ]; then
	LOCAL_VERSION=$("$PREFIX/pi" --version 2>/dev/null | head -1)
	echo "    当前版本: v${LOCAL_VERSION}"
	if [ "${PI_FORCE_UPDATE:-0}" != "1" ] && [ "$LOCAL_VERSION" = "$LATEST_VERSION" ]; then
		echo ""
		echo "==> 已经是最新版本，无需更新。"
		exit 0
	fi
else
	echo "    当前版本: 未安装"
fi

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
# 安装：已安装则清理旧目录（避免 pi 繁忙），未安装则直接安装
#
# 全新安装：通过 /dev/tty 连接控制终端，确保 curl|bash 管道下也能弹出
#   组件选择菜单（install.sh 用 [ -t 0 ] 检测交互模式，管道 stdin 不是
#   终端，需要重定向到 /dev/tty 才能正确交互）。
# 更新模式：跳过组件选择菜单（用户首次安装时已选过，无需每次更新重选）。
# ---------------------------------------------------------------------------

if [ -x "$PREFIX/pi" ]; then
	echo "==> 检测到已安装，清理旧目录 ($PREFIX) ..."
	rm -rf "$PREFIX"
	FRESH_INSTALL=0
else
	echo "==> 未检测到 pi，执行全新安装 ..."
	FRESH_INSTALL=1
fi

echo "==> 执行 install.sh ..."
cd "$TMPDIR/extracted/pi"
if [ "$FRESH_INSTALL" -eq 1 ]; then
	# 全新安装：连接控制终端，确保 curl|bash 下也能交互选择组件
	bash ./install.sh < /dev/tty
else
	# 更新模式：跳过扩展选择与安装，保留用户已有的扩展配置
	# 扩展持久化在 ~/.pi/agent/ 目录，update 的 rm -rf $PREFIX 不会删除
	# 通过 PI_INSTALL_MODE=update 通知 install.sh 跳过扩展安装，
	# 避免用默认配置集覆盖用户首次安装时的自定义选择
	# 同时传递 PI_INSTALL_PREFIX 确保安装到正确的目录
	PI_INSTALL_MODE=update PI_INSTALL_PREFIX="$PREFIX" bash ./install.sh < /dev/null
fi

echo ""
echo "==> 安装完成: $RELEASE_TAG"
