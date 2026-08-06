#!/usr/bin/env bash
set -euo pipefail

PREFIX="${PI_INSTALL_PREFIX:-$HOME/.local/share/pi}"
BINDIR="${PI_INSTALL_BINDIR:-$HOME/.local/bin}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---------------------------------------------------------------------------
# Interactive directory selection on fresh install
#   - Skipped in update mode (PI_INSTALL_MODE=update)
#   - Skipped when PI_INSTALL_PREFIX is already set via env var
#   - Skipped in non-interactive terminal ([ -t 0 ])
# ---------------------------------------------------------------------------
if [ "${PI_INSTALL_MODE:-install}" != "update" ] && [ -z "${PI_INSTALL_PREFIX:-}" ] && [ -t 0 ]; then
	printf "\n安装目录 [默认: %s]: " "$PREFIX"
	read -r _dir_input
	if [ -n "$_dir_input" ]; then
		PREFIX="$_dir_input"
	fi
fi

# Persist installation prefix so future updates can locate it
mkdir -p "$HOME/.pi/agent"
printf '%s' "$PREFIX" >"$HOME/.pi/agent/.install-prefix"

# ---------------------------------------------------------------------------
# Core installation (binary + assets)
# ---------------------------------------------------------------------------

# Detect existing installation: skip core copy, only adjust extensions/agents
if [ -x "$PREFIX/pi" ]; then
	echo "Pi already installed at $PREFIX — skipping core installation."
	echo "Only extension/agent selection will run."
else
	mkdir -p "$PREFIX"
	mkdir -p "$BINDIR"

	cp -r "$SCRIPT_DIR/pi" "$PREFIX/pi"
	cp -r "$SCRIPT_DIR/package.json" "$PREFIX/package.json"
	cp -r "$SCRIPT_DIR/README.md" "$PREFIX/README.md"
	cp -r "$SCRIPT_DIR/CHANGELOG.md" "$PREFIX/CHANGELOG.md"
	cp -r "$SCRIPT_DIR/photon_rs_bg.wasm" "$PREFIX/photon_rs_bg.wasm"

	for dir in theme assets export-html docs examples extensions primary-agents; do
		if [ -d "$SCRIPT_DIR/$dir" ]; then
			cp -r "$SCRIPT_DIR/$dir" "$PREFIX/$dir"
		fi
	done

	if [ -d "$SCRIPT_DIR/bin" ]; then
		cp -r "$SCRIPT_DIR/bin" "$PREFIX/bin"
	fi

	# 安装脚本本身 — 允许用户随时重新运行 install.sh 调整扩展选择
	if [ -f "$SCRIPT_DIR/install.sh" ]; then
		cp "$SCRIPT_DIR/install.sh" "$PREFIX/install.sh"
	fi

	ln -sf "$PREFIX/pi" "$BINDIR/pi"

	echo "Installed pi to $PREFIX"
	echo "Linked pi to $BINDIR/pi"
fi

# ---------------------------------------------------------------------------
# Extensions and Agents -- two-step interactive selection
# ---------------------------------------------------------------------------

# Extension definitions
#   name:    extension identifier
#   desc:    short description
#   default: 1 = selected in standard set, 0 = not
#   install: installation spec (file: = file copy to extensions/, otherwise pi install)

# shellcheck disable=SC2034 # used via nameref in run_menu
EXT_NAMES=(
	"@schovest/pi-mcp-adapter"
	"@schovest/pi-todo"
	"@schovest/pi-ask-user-question"
	"@schovest/pi-tps"
	"@schovest/pi-sudo-helper"
	"@narumitw/pi-goal"
	"context-mode"
	"@schovest/pi-btw"
	"superpowers"
	"pi-plugin-manager"
	"pi-lens"
	"pi-hermes-memory"
)
# shellcheck disable=SC2034 # used via nameref in run_menu
EXT_DESCS=(
	"MCP 协议适配器"
	"任务管理插件"
	"用户交互问答"
	"Tokens-per-second 监控"
	"sudo 密码安全注入"
	"目标自主编排"
	"智能上下文模式切换"
	"侧边栏问答命令"
	"Superpowers 技能集"
	"插件管理器"
	"代码智能分析"
	"持久记忆与学习循环"
)
# shellcheck disable=SC2034 # used via nameref in run_menu
EXT_DEFAULTS=(1 1 1 0 0 0 0 0 0 1 0 0)
# shellcheck disable=SC2034 # used via nameref in run_menu
EXT_INSTALLS=(
	"npm:@schovest/pi-mcp-adapter"
	"npm:@schovest/pi-todo"
	"npm:@schovest/pi-ask-user-question"
	"npm:@schovest/pi-tps"
	"npm:@schovest/pi-sudo-helper"
	"npm:@narumitw/pi-goal"
	"npm:context-mode"
	"npm:@schovest/pi-btw"
	"git:github.com/obra/superpowers"
	"npm:pi-plugin-manager"
	"npm:pi-lens"
	"npm:pi-hermes-memory"
)

# Primary Agent definitions
#   name:    agent identifier
#   desc:    short description
#   default: 1 = selected, 0 = not
#   install: agent: = file copy to primary-agents/

# shellcheck disable=SC2034 # used via nameref in run_menu
AGENT_NAMES=(
	"plan"
	"coding"
	"config"
)
# shellcheck disable=SC2034 # used via nameref in run_menu
AGENT_DESCS=(
	"规划与探索 Agent"
	"编码实现 Agent"
	"配置管理 Agent"
)
# shellcheck disable=SC2034 # used via nameref in run_menu
AGENT_DEFAULTS=(1 1 1)
# shellcheck disable=SC2034 # used via nameref in run_menu
AGENT_INSTALLS=(
	"agent:plan.md"
	"agent:coding.md"
	"agent:config.md"
)

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

# -- Draw menu (generic — uses MN_* globals) --------------------------------

draw_menu() {
	local title="$1"

	if [ "${_DRAWN:-0}" -eq 1 ]; then
		printf "\033[%dA" $((MN_NUM + 5))
	else
		_DRAWN=1
	fi

	printf "\n"
	printf "${BOLD}  %s${RESET}\n" "$title"
	printf "\n"

	for i in $(seq 0 $((MN_NUM - 1))); do
		local checkbox
		if [ "${MN_SELECTED[$i]}" -eq 1 ]; then
			checkbox="${GREEN}[*]${RESET}"
		else
			checkbox="${DIM}[ ]${RESET}"
		fi

		local num=$((i + 1))
		local label="${MN_NAMES[$i]}"

		if [ "$i" -eq "$MN_CURSOR" ]; then
			printf "  %s ${CYAN}%d. %-32s${RESET} ${DIM}%s${RESET}\n" "$checkbox" "$num" "$label" "${MN_DESCS[$i]}"
		else
			printf "  %s  %d. %-32s ${DIM}%s${RESET}\n" "$checkbox" "$num" "$label" "${MN_DESCS[$i]}"
		fi
	done

	printf "\n"
	printf "  ${DIM}↑/↓${RESET} move  ${DIM}Space${RESET} toggle  ${DIM}a${RESET} all  ${DIM}c${RESET} none  ${DIM}s${RESET} standard  ${DIM}Enter${RESET} confirm  ${DIM}q${RESET} skip\n"
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

# -- Run a single interactive selection menu --------------------------------
# Arguments: title names_ref descs_ref defaults_ref → sets MN_SELECTED, MN_NAMES, etc.
# Environment: PI_INSTALL_MODE controls update mode (skip all)

run_menu() {
	local title="$1"
	local -n _mn_names=$2
	local -n _mn_descs=$3
	local -n _mn_defaults=$4

	# Copy arrays into globals used by draw_menu / read_key / loop
	MN_NAMES=("${_mn_names[@]}")
	MN_DESCS=("${_mn_descs[@]}")
	MN_DEFAULTS=("${_mn_defaults[@]}")
	MN_NUM=${#MN_NAMES[@]}
	MN_SELECTED=("${MN_DEFAULTS[@]}")
	MN_CURSOR=0

	if [ "${PI_INSTALL_MODE:-install}" = "update" ]; then
		echo ""
		echo "Update mode: skipping ${title} selection."
		echo ""
		for i in $(seq 0 $((MN_NUM - 1))); do MN_SELECTED[$i]=0; done
	elif [ ! -t 0 ]; then
		echo ""
		echo "Non-interactive terminal detected. Installing standard ${title} only."
		echo ""
	else
		_DRAWN=0
		draw_menu "$title"

		while true; do
			read_key
			case "$REPLY" in
			"")
				# Enter — confirm
				break
				;;
			UNKNOWN)
				draw_menu "$title"
				;;
			q | Q)
				# Skip all
				for i in $(seq 0 $((MN_NUM - 1))); do MN_SELECTED[$i]=0; done
				break
				;;
			" ")
				# Toggle current item
				if [ "${MN_SELECTED[$MN_CURSOR]}" -eq 1 ]; then
					MN_SELECTED[$MN_CURSOR]=0
				else
					MN_SELECTED[$MN_CURSOR]=1
				fi
				draw_menu "$title"
				;;
			UP)
				MN_CURSOR=$(((MN_CURSOR - 1 + MN_NUM) % MN_NUM))
				draw_menu "$title"
				;;
			DOWN)
				MN_CURSOR=$(((MN_CURSOR + 1) % MN_NUM))
				draw_menu "$title"
				;;
			a | A)
				# Select all
				for i in $(seq 0 $((MN_NUM - 1))); do MN_SELECTED[$i]=1; done
				draw_menu "$title"
				;;
			c | C)
				# Clear all
				for i in $(seq 0 $((MN_NUM - 1))); do MN_SELECTED[$i]=0; done
				draw_menu "$title"
				;;
			s | S)
				# Standard set
				for i in $(seq 0 $((MN_NUM - 1))); do MN_SELECTED[$i]=${MN_DEFAULTS[$i]}; done
				draw_menu "$title"
				;;
			esac
		done

		# Clear menu from terminal
		printf "\033[%dA" $((MN_NUM + 5))
		printf "\033[J"
	fi

	# Write selection back to caller via global variable (caller reads MN_SELECTED, MN_NUM etc.)
}

# ---------------------------------------------------------------------------
# Step 1: Extensions
# ---------------------------------------------------------------------------

run_menu "Extensions" EXT_NAMES EXT_DESCS EXT_DEFAULTS
EXT_NUM=$MN_NUM
EXT_SELECTED=("${MN_SELECTED[@]}")

# ---------------------------------------------------------------------------
# Step 2: Primary Agents
# ---------------------------------------------------------------------------

run_menu "Primary Agents" AGENT_NAMES AGENT_DESCS AGENT_DEFAULTS
AGENT_NUM=$MN_NUM
AGENT_SELECTED=("${MN_SELECTED[@]}")

# ---------------------------------------------------------------------------
# Install selected extensions
# ---------------------------------------------------------------------------

echo ""
any_installed=0

# codex hooks 桥接已内置（core/codex-hooks-bridge.ts），删除旧版本可选扩展残留，
# 防止与内置 inline factory 双份注册 hooks/斜杠命令
if [ -f "$HOME/.pi/agent/extensions/codex-hooks.ts" ]; then
	rm -f "$HOME/.pi/agent/extensions/codex-hooks.ts"
	echo "  removed legacy codex-hooks extension (now built-in)"
fi

for i in $(seq 0 $((EXT_NUM - 1))); do
	if [ "${EXT_SELECTED[$i]}" -ne 1 ]; then
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
	else
		# pi install (npm or git)
		echo "Installing $name..."
		if [ -x "$BINDIR/pi" ]; then
			err_output=$("$BINDIR/pi" install "$install_spec" 2>&1) &&
				echo "  pi: installed $install_spec" ||
				echo "  pi: warning - pi install $install_spec failed: $err_output"
		else
			echo "  pi: warning - pi binary not found at $BINDIR/pi"
		fi
	fi
done

if [ "$any_installed" -eq 0 ]; then
	echo "No extensions selected. Skipping."
fi

# ---------------------------------------------------------------------------
# Install selected primary agents
# ---------------------------------------------------------------------------

any_agents=0

for i in $(seq 0 $((AGENT_NUM - 1))); do
	if [ "${AGENT_SELECTED[$i]}" -ne 1 ]; then
		continue
	fi

	name="${AGENT_NAMES[$i]}"
	install_spec="${AGENT_INSTALLS[$i]}"
	any_agents=1

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
done

if [ "$any_agents" -eq 0 ]; then
	echo "No agents selected. Skipping."
fi

echo ""
echo "Installation complete."
