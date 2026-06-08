#!/usr/bin/env bash
set -euo pipefail

PREFIX="${PI_INSTALL_PREFIX:-$HOME/.local/share/pi}"
BINDIR="${PI_INSTALL_BINDIR:-$HOME/.local/bin}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$PREFIX"
mkdir -p "$BINDIR"

cp -r "$SCRIPT_DIR/pi" "$PREFIX/pi"
cp -r "$SCRIPT_DIR/package.json" "$PREFIX/package.json"
cp -r "$SCRIPT_DIR/README.md" "$PREFIX/README.md"
cp -r "$SCRIPT_DIR/CHANGELOG.md" "$PREFIX/CHANGELOG.md"
cp -r "$SCRIPT_DIR/photon_rs_bg.wasm" "$PREFIX/photon_rs_bg.wasm"

for dir in theme assets export-html docs examples; do
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

# Install context-mode plugin
echo "Installing context-mode plugin..."

if command -v npm &>/dev/null; then
	npm install -g context-mode 2>/dev/null && echo "npm: installed context-mode globally" \
		|| echo "npm: warning - global install failed (may need sudo or npm not configured)"
else
	echo "npm: warning - npm not found, skipping global install of context-mode"
fi

# Use the just-installed pi binary directly
if [ -x "$BINDIR/pi" ]; then
	"$BINDIR/pi" install npm:context-mode 2>/dev/null && echo "pi: installed context-mode plugin" \
		|| echo "pi: warning - pi install npm:context-mode failed"
else
	echo "pi: warning - pi binary not found at $BINDIR/pi, skipping plugin install"
fi