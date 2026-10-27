#!/usr/bin/env bash
#
# Install the Command Code -> OpenAI-compatible proxy for OpenCode.
#
#   sudo ./install.sh
#
# Optional environment variables:
#   PREFIX=/root/cc-proxy   install location
#   PORT=55990              local port
#
# Requires Node.js 18+ (no npm packages are needed).

set -euo pipefail

PREFIX="${PREFIX:-/root/cc-proxy}"
PORT="${PORT:-55990}"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

# --- requirements -----------------------------------------------------------
command -v node >/dev/null || die "Node.js is required (18+). Install it, then re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18+ required, found $(node -v)"
command -v curl >/dev/null || die "curl is required"

[ -f "$SELF_DIR/proxy/proxy.mjs" ] || die "proxy/proxy.mjs missing — run this from the cloned repo"

say "1/4  Installing into $PREFIX (Node $(node -v))"
mkdir -p "$PREFIX"

# Copy beside the old file, then rename: overwriting a running script is fine,
# but this keeps the swap atomic.
install -m 644 "$SELF_DIR/proxy/proxy.mjs" "$PREFIX/.proxy.mjs.new"
mv -f "$PREFIX/.proxy.mjs.new" "$PREFIX/proxy.mjs"
echo "Installed $PREFIX/proxy.mjs"

if [ -f "$SELF_DIR/set-key.sh" ]; then
  install -m 755 "$SELF_DIR/set-key.sh" "$PREFIX/set-key.sh"
  echo "Installed $PREFIX/set-key.sh"
fi

if [ ! -f "$PREFIX/token" ]; then
  : > "$PREFIX/token"
  chmod 600 "$PREFIX/token"
  echo "Created empty $PREFIX/token (mode 600)"
fi

# --- systemd ----------------------------------------------------------------
if command -v systemctl >/dev/null && [ -d /etc/systemd/system ]; then
  say "2/4  Installing systemd service"
  sed -e "s#@PREFIX@#$PREFIX#g" -e "s#@PORT@#$PORT#g" \
    "$SELF_DIR/systemd/commandcode-proxy.service" \
    > /etc/systemd/system/commandcode-proxy.service

  systemctl daemon-reload
  systemctl enable commandcode-proxy >/dev/null 2>&1 || true
  systemctl restart commandcode-proxy
  sleep 2
  systemctl is-active commandcode-proxy
else
  say "2/4  No systemd found — start it manually:"
  echo "  PORT=$PORT nohup node $PREFIX/proxy.mjs &"
fi

# --- health check -----------------------------------------------------------
say "3/4  Health check"
for i in 1 2 3 4 5; do
  if curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/health" 2>/dev/null; then
    echo
    break
  fi
  sleep 1
  [ "$i" = 5 ] && die "proxy did not answer on 127.0.0.1:$PORT — check: journalctl -u commandcode-proxy -n 30"
done

say "4/4  Done"
cat <<EOF

Next steps
----------
1. Save your key:
     $PREFIX/set-key.sh user_your_key_here
     $PREFIX/set-key.sh --from-cli      # or reuse the 'cmd' CLI login

2. Merge the provider block from config/opencode.json into
     ~/.config/opencode/opencode.json

3. In OpenCode run:  /reload
   Then:             /models   -> pick "DeepSeek Flash (\$1)"

Logs:  journalctl -u commandcode-proxy -f
EOF
