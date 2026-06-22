#!/usr/bin/env bash
set -euo pipefail

PREFIX="${PI_INSTALL_PREFIX:-$HOME/.local/share/pi}"
BINDIR="${PI_INSTALL_BINDIR:-$HOME/.local/bin}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

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

if [ -d "$SCRIPT_DIR/node_modules/@earendil-works/pi-plugins" ]; then
	mkdir -p "$PREFIX/node_modules/@earendil-works/pi-plugins"
	cp -r "$SCRIPT_DIR/node_modules/@earendil-works/pi-plugins"/* "$PREFIX/node_modules/@earendil-works/pi-plugins/"
fi

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
# Recommended extensions — interactive selection
# ---------------------------------------------------------------------------

# Extension definitions
#   name:    display label
#   desc:    short description
#   default: 1 = selected in standard set, 0 = not

EXT_NAMES=("context-mode" "tps" "btw")
EXT_DESCS=(
	"Smart context mode switching for Pi"
	"Tokens-per-second monitor after each turn"
	"/btw side-question command (npm:@juicesharp/rpiv-btw)"
)
EXT_DEFAULTS=(1 1 0)  # context-mode + tps = standard; btw = optional

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
	# Move cursor up to overwrite previous draw
	if [ "${_DRAWN:-0}" -eq 1 ]; then
		# menu is NUM items + 3 header/blank lines + 1 hint line
		printf "\033[%dA" $((NUM + 4))
	else
		_DRAWN=1
	fi

	printf "\n"
	printf "${BOLD}  Recommended Extensions${RESET}\n"
	printf "\n"

	for i in $(seq 0 $((NUM - 1))); do
		local mark checkbox
		if [ "${SELECTED[$i]}" -eq 1 ]; then
			checkbox="${GREEN}[*]${RESET}"
		else
			checkbox="${DIM}[ ]${RESET}"
		fi

		local num=$((i + 1))
		local label="${EXT_NAMES[$i]}"

		# Highlight current cursor position
		if [ "$i" -eq "$CURSOR" ]; then
			printf "  %s ${CYAN}%d. %-16s${RESET} ${DIM}%s${RESET}\n" "$checkbox" "$num" "$label" "${EXT_DESCS[$i]}"
		else
			printf "  %s  %d. %-16s ${DIM}%s${RESET}\n" "$checkbox" "$num" "$label" "${EXT_DESCS[$i]}"
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
					*) key="" ;;
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
	# Initial draw (no prior draw to erase)
	_DRAWN=0
	draw_menu

	while true; do
		read_key
		case "$REPLY" in
			"")
				# Enter — confirm
				break
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
				# Select all
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
	printf "\033[%dA" $((NUM + 4))
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
	any_installed=1

	case "$name" in
		context-mode)
			echo "Installing context-mode..."
			if command -v npm &>/dev/null; then
				npm install -g context-mode 2>/dev/null && echo "  npm: installed context-mode globally" \
					|| echo "  npm: warning - global install failed"
			else
				echo "  npm: warning - npm not found, skipping global install"
			fi
			if [ -x "$BINDIR/pi" ]; then
				"$BINDIR/pi" install npm:context-mode 2>/dev/null && echo "  pi: installed context-mode plugin" \
					|| echo "  pi: warning - pi install npm:context-mode failed"
			else
				echo "  pi: warning - pi binary not found at $BINDIR/pi"
			fi
			;;
		tps)
			echo "Installing tps extension..."
			ext_dir="$PREFIX/extensions"
			mkdir -p "$ext_dir"
			if [ -f "$SCRIPT_DIR/extensions/tps.ts" ]; then
				cp "$SCRIPT_DIR/extensions/tps.ts" "$ext_dir/tps.ts"
				echo "  copied tps.ts to $ext_dir/"
			else
				echo "  warning - tps.ts not found in $SCRIPT_DIR/extensions/"
			fi
			;;
		btw)
			echo "Installing btw extension..."
			if [ -x "$BINDIR/pi" ]; then
				"$BINDIR/pi" install npm:@juicesharp/rpiv-btw 2>/dev/null && echo "  pi: installed @juicesharp/rpiv-btw" \
					|| echo "  pi: warning - pi install npm:@juicesharp/rpiv-btw failed"
			else
				echo "  pi: warning - pi binary not found at $BINDIR/pi"
			fi
			;;
	esac
done

if [ "$any_installed" -eq 0 ]; then
	echo "No extensions selected. Skipping."
fi

echo ""
echo "Installation complete."
