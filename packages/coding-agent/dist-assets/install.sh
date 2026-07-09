#!/usr/bin/env bash
set -euo pipefail

PREFIX="${PI_INSTALL_PREFIX:-$HOME/.local/share/pi}"
BINDIR="${PI_INSTALL_BINDIR:-$HOME/.local/bin}"
AGENT_BIN_DIR="${HOME}/.pi/agent/bin"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---------------------------------------------------------------------------
# fd download helper
# ---------------------------------------------------------------------------

download_fd() {
  local dest="$AGENT_BIN_DIR/fd"
  if [ -f "$dest" ]; then
    echo "fd already installed at $dest"
    return 0
  fi

  local os arch
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)
  case "$arch" in
    x86_64)  arch="x86_64" ;;
    aarch64) arch="aarch64" ;;
    arm64)   arch="aarch64" ;;
    *)       echo "  warning: unsupported architecture $arch for fd download"; return 1 ;;
  esac

  local version asset redirect_url

  # 首选：网页重定向（无速率限制）
  # https://github.com/sharkdp/fd/releases/latest → 302 → /releases/tag/vX.Y.Z
  redirect_url=$(curl -fsSL -o /dev/null -w '%{url_effective}' \
    "https://github.com/sharkdp/fd/releases/latest" 2>/dev/null) || redirect_url=""
  if [ -n "$redirect_url" ]; then
    version="${redirect_url##*/tag/}"
    # 无 /tag/ 时原样返回，据此判断失败
    [ "$version" = "$redirect_url" ] && version=""
    # 去掉 'v' 前缀
    version="${version#v}"
  fi

  # 回退：GitHub API（匿名限速 60 次/小时）
  if [ -z "$version" ]; then
    version=$(curl -fsSL "https://api.github.com/repos/sharkdp/fd/releases/latest" 2>/dev/null \
      | grep -o '"tag_name": *"v[^"]*"' | head -1 | sed 's/.*"v\([^"]*\)".*/\1/')
  fi

  if [ -z "$version" ]; then
    echo "  warning: failed to fetch fd latest version"
    return 1
  fi

  case "$os" in
    darwin) asset="fd-v${version}-${arch}-apple-darwin.tar.gz" ;;
    linux)  asset="fd-v${version}-${arch}-unknown-linux-gnu.tar.gz" ;;
    *)      echo "  warning: unsupported OS $os for fd download"; return 1 ;;
  esac

  local url="https://github.com/sharkdp/fd/releases/download/v${version}/${asset}"
  local tmpdir
  tmpdir=$(mktemp -d)
  local archive="$tmpdir/$asset"

  echo "Downloading fd v${version} for ${os}/${arch}..."
  if ! curl -fsSL -o "$archive" "$url" 2>/dev/null; then
    echo "  warning: failed to download fd from $url"
    rm -rf "$tmpdir"
    return 1
  fi

  mkdir -p "$AGENT_BIN_DIR"
  if [[ "$asset" == *.tar.gz ]]; then
    tar xzf "$archive" -C "$tmpdir"
  else
    unzip -q "$archive" -d "$tmpdir" 2>/dev/null || true
  fi

  # Find fd binary in extracted tree
  local fd_bin
  fd_bin=$(find "$tmpdir" -type f -name "fd" -perm /111 2>/dev/null | head -1)
  if [ -z "$fd_bin" ]; then
    fd_bin=$(find "$tmpdir" -type f -name "fd" 2>/dev/null | head -1)
  fi
  if [ -z "$fd_bin" ]; then
    echo "  warning: fd binary not found in archive"
    rm -rf "$tmpdir"
    return 1
  fi

  cp "$fd_bin" "$dest"
  chmod +x "$dest"
  rm -rf "$tmpdir"
  echo "fd installed to $dest"
}

# ---------------------------------------------------------------------------
# Core installation (binary + assets)
# ---------------------------------------------------------------------------

mkdir -p "$PREFIX"
mkdir -p "$BINDIR"

cp -r "$SCRIPT_DIR/pi" "$PREFIX/pi"
cp -r "$SCRIPT_DIR/package.json" "$PREFIX/package.json"
cp -r "$SCRIPT_DIR/README.md" "$PREFIX/README.md"
cp -r "$SCRIPT_DIR/CHANGELOG.md" "$PREFIX/CHANGELOG.md"
cp -r "$SCRIPT_DIR/photon_rs_bg.wasm" "$PREFIX/photon_rs_bg.wasm"

for dir in theme assets export-html docs examples extensions; do
	if [ -d "$SCRIPT_DIR/$dir" ]; then
		cp -r "$SCRIPT_DIR/$dir" "$PREFIX/$dir"
	fi
done

if [ -d "$SCRIPT_DIR/bin" ]; then
	cp -r "$SCRIPT_DIR/bin" "$PREFIX/bin"
fi

ln -sf "$PREFIX/pi" "$BINDIR/pi"

if [ -f "$PREFIX/bin/fd" ]; then
	ln -sf "$PREFIX/bin/fd" "$BINDIR/fd"
fi

echo "Installed pi to $PREFIX"
echo "Linked pi to $BINDIR/pi"
if [ -f "$PREFIX/bin/fd" ]; then
	echo "Linked fd to $BINDIR/fd"
fi

# ---------------------------------------------------------------------------
# Extensions -- interactive selection
# ---------------------------------------------------------------------------

# Extension definitions
#   name:    extension identifier
#   desc:    short description
#   default: 1 = selected in standard set, 0 = not
#   install: installation spec (file: = file copy to extensions/, agent: = file copy to primary-agents/, otherwise pi install)

EXT_NAMES=(
	"pi-mcp-adapter"
	"@juicesharp/rpiv-todo"
	"@juicesharp/rpiv-ask-user-question"
	"tps"
	"config"
	"coding"
	"context-mode"
	"@juicesharp/rpiv-btw"
)
EXT_DESCS=(
	"MCP 协议适配器"
	"任务管理插件"
	"用户交互问答"
	"Tokens-per-second 监控"
	"配置管理 Agent (primary-agent)"
	"编码实现 Agent (primary-agent)"
	"智能上下文模式切换"
	"侧边栏问答命令"
)
EXT_DEFAULTS=(1 1 1 0 1 0 0 0)
EXT_INSTALLS=(
	"npm:pi-mcp-adapter"
	"npm:@juicesharp/rpiv-todo"
	"npm:@juicesharp/rpiv-ask-user-question"
	"file:tps.ts"
	"agent:config.md"
	"agent:coding.md"
	"npm:context-mode"
	"npm:@juicesharp/rpiv-btw"
)

NUM=${#EXT_NAMES[@]}
SELECTED=("${EXT_DEFAULTS[@]}")
CURSOR=0

# -- Colors ----------------------------------------------------------------

if command -v tput &>/dev/null && [ -t 0 ]; then
	BOLD=$(tput bold 2>/dev/null || echo "")
	DIM=$(tput dim 2>/dev/null || echo "")
	GREEN=$(tput setaf 2 2>/dev/null || echo "")
	CYAN=$(tput setaf 6 2>/dev/null || echo "")
	RESET=$(tput sgr0 2>/dev/null || echo "")
else
	BOLD="" DIM="" GREEN="" CYAN="" RESET=""
fi

# -- Draw menu -------------------------------------------------------------

draw_menu() {
	if [ "${_DRAWN:-0}" -eq 1 ]; then
		printf "\033[%dA" $((NUM + 5))
	else
		_DRAWN=1
	fi

	printf "\n"
	printf "${BOLD}  Extensions${RESET}\n"
	printf "\n"

	for i in $(seq 0 $((NUM - 1))); do
		local checkbox
		if [ "${SELECTED[$i]}" -eq 1 ]; then
			checkbox="${GREEN}[*]${RESET}"
		else
			checkbox="${DIM}[ ]${RESET}"
		fi

		local num=$((i + 1))
		local label="${EXT_NAMES[$i]}"

		if [ "$i" -eq "$CURSOR" ]; then
			printf "  %s ${CYAN}%d. %-32s${RESET} ${DIM}%s${RESET}\n" "$checkbox" "$num" "$label" "${EXT_DESCS[$i]}"
		else
			printf "  %s  %d. %-32s ${DIM}%s${RESET}\n" "$checkbox" "$num" "$label" "${EXT_DESCS[$i]}"
		fi
	done

	printf "\n"
	printf "  ${DIM}↑/↓${RESET} move  ${DIM}Space${RESET} toggle  ${DIM}a${RESET} all  ${DIM}s${RESET} standard  ${DIM}Enter${RESET} confirm  ${DIM}q${RESET} skip\n"
}

# -- Read single keypress ---------------------------------------------------

read_key() {
	local stty_orig
	stty_orig=$(stty -g 2>/dev/null) || true
	trap 'stty "$stty_orig" 2>/dev/null || true' EXIT
	stty raw -echo 2>/dev/null || true

	local key=""
	IFS= read -r -n1 key || true

	# Handle escape sequences (arrow keys)
	if [ "$key" = $'\x1b' ]; then
		local seq1="" seq2=""
		if IFS= read -r -n1 -t0.05 seq1 2>/dev/null; then
			if [ "$seq1" = "[" ]; then
				IFS= read -r -n1 -t0.05 seq2 2>/dev/null || true
				case "$seq2" in
					A) key="UP" ;;
					B) key="DOWN" ;;
					*) key="UNKNOWN" ;;
				esac
			fi
		fi
		[ "$key" = $'\x1b' ] && key=""
	fi

	stty "$stty_orig" 2>/dev/null || true
	trap - EXIT

	REPLY="$key"
}

# -- Interactive loop -------------------------------------------------------

if [ ! -t 0 ]; then
	echo ""
	echo "Non-interactive terminal detected. Installing standard extensions only."
	echo ""
else
	_DRAWN=0
	draw_menu

	while true; do
		read_key
		case "$REPLY" in
			"")
				# Enter — confirm
				break
				;;
			UNKNOWN)
				draw_menu
				;;
			q|Q)
				# Skip all extensions
				for i in $(seq 0 $((NUM - 1))); do SELECTED[$i]=0; done
				break
				;;
			" ")
				# Toggle current item
				if [ "${SELECTED[$CURSOR]}" -eq 1 ]; then
					SELECTED[$CURSOR]=0
				else
					SELECTED[$CURSOR]=1
				fi
				draw_menu
				;;
			UP)
				CURSOR=$(((CURSOR - 1 + NUM) % NUM))
				draw_menu
				;;
			DOWN)
				CURSOR=$(((CURSOR + 1) % NUM))
				draw_menu
				;;
			a|A)
				# Select all (not install)
				for i in $(seq 0 $((NUM - 1))); do SELECTED[$i]=1; done
				draw_menu
				;;
			s|S)
				# Standard set
				for i in $(seq 0 $((NUM - 1))); do SELECTED[$i]=${EXT_DEFAULTS[$i]}; done
				draw_menu
				;;
		esac
	done

	# Clear menu from terminal
	printf "\033[%dA" $((NUM + 5))
	printf "\033[J"
fi

# -- Install selected extensions --------------------------------------------

echo ""
any_installed=0

for i in $(seq 0 $((NUM - 1))); do
	if [ "${SELECTED[$i]}" -ne 1 ]; then
		continue
	fi

	name="${EXT_NAMES[$i]}"
	install_spec="${EXT_INSTALLS[$i]}"
	any_installed=1

	if [ "${install_spec#file:}" != "$install_spec" ]; then
		# File copy install (extensions)
		src_file="${install_spec#file:}"
		echo "Installing $name (file copy)..."
		ext_dir="$HOME/.pi/agent/extensions"
		mkdir -p "$ext_dir"
		if [ -f "$SCRIPT_DIR/extensions/$src_file" ]; then
			cp "$SCRIPT_DIR/extensions/$src_file" "$ext_dir/$src_file"
			echo "  copied $src_file to $ext_dir/"
		else
			echo "  warning - $src_file not found in $SCRIPT_DIR/extensions/"
		fi
	elif [ "${install_spec#agent:}" != "$install_spec" ]; then
		# File copy install (primary agents)
		src_file="${install_spec#agent:}"
		echo "Installing $name (primary agent)..."
		agent_dir="$HOME/.pi/agent/primary-agents"
		mkdir -p "$agent_dir"
		if [ -f "$SCRIPT_DIR/primary-agents/$src_file" ]; then
			cp "$SCRIPT_DIR/primary-agents/$src_file" "$agent_dir/$src_file"
			echo "  copied $src_file to $agent_dir/"
		else
			echo "  warning - $src_file not found in $SCRIPT_DIR/primary-agents/"
		fi
	else
		# pi install
		echo "Installing $name..."
		if [ -x "$BINDIR/pi" ]; then
			err_output=$("$BINDIR/pi" install "$install_spec" 2>&1) \
				&& echo "  pi: installed $install_spec" \
				|| echo "  pi: warning - pi install $install_spec failed: $err_output"
		else
			echo "  pi: warning - pi binary not found at $BINDIR/pi"
		fi
	fi
done

if [ "$any_installed" -eq 0 ]; then
	echo "No extensions selected. Skipping."
fi

echo ""

# ---------------------------------------------------------------------------
# Download fd to ~/.pi/agent/bin/fd
# ---------------------------------------------------------------------------
download_fd

echo ""
echo "Installation complete."
