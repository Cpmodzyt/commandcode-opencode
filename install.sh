#!/usr/bin/env bash
#
# Install the Command Code -> OpenAI-compatible proxy for OpenCode.
#
#   sudo ./install.sh
#
# Optional environment variables:
#   PREFIX=/root/cc-proxy   install location
#   PORT=55990              local port

set -euo pipefail

PREFIX="${PREFIX:-/root/cc-proxy}"
PORT="${PORT:-55990}"
UPSTREAM="dev2k6/command-code-proxy-server"
RAW="https://raw.githubusercontent.com/${UPSTREAM}/main/bin"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

command -v curl >/dev/null || die "curl is required"

# --- pick the right prebuilt binary -----------------------------------------
case "$(uname -m)" in
  aarch64|arm64) BIN="command-code-proxy-arm64" ;;
  x86_64|amd64)  BIN="command-code-proxy" ;;
  *) die "unsupported CPU architecture: $(uname -m)" ;;
esac

say "1/4  Installing the proxy ($BIN) into $PREFIX"
mkdir -p "$PREFIX"

# Download beside the target, then atomically rename. Overwriting a *running*
# binary directly fails with ETXTBSY ("Text file busy").
TMP="$PREFIX/.command-code-proxy.new"
rm -f "$TMP"
curl -fsSL -o "$TMP" "$RAW/$BIN" || die "download failed"
chmod +x "$TMP"
mv -f "$TMP" "$PREFIX/command-code-proxy"
"$PREFIX/command-code-proxy" -version

# --- key file ---------------------------------------------------------------
if [ ! -f "$PREFIX/token" ]; then
  : > "$PREFIX/token"
  chmod 600 "$PREFIX/token"
  echo "Created empty $PREFIX/token"
fi

# --- helper script ----------------------------------------------------------
if [ -f "$SELF_DIR/set-key.sh" ]; then
  install -m 755 "$SELF_DIR/set-key.sh" "$PREFIX/set-key.sh"
  echo "Installed $PREFIX/set-key.sh"
fi

# --- systemd ----------------------------------------------------------------
if command -v systemctl >/dev/null && [ -d /etc/systemd/system ]; then
  say "2/4  Installing systemd service"
  if [ -f "$SELF_DIR/systemd/commandcode-proxy.service" ]; then
    sed -e "s#@PREFIX@#$PREFIX#g" -e "s#@PORT@#$PORT#g" \
      "$SELF_DIR/systemd/commandcode-proxy.service" \
      > /etc/systemd/system/commandcode-proxy.service
  else
    cat > /etc/systemd/system/commandcode-proxy.service <<EOF
[Unit]
Description=Command Code -> OpenAI-compatible proxy (for OpenCode)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$PREFIX/command-code-proxy -host 127.0.0.1 -port $PORT
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
  fi

  systemctl daemon-reload
  systemctl enable commandcode-proxy >/dev/null 2>&1 || true
  systemctl restart commandcode-proxy
  sleep 2
  systemctl is-active commandcode-proxy
else
  say "2/4  No systemd found — start it manually:"
  echo "  nohup $PREFIX/command-code-proxy -host 127.0.0.1 -port $PORT &"
fi

# --- health check -----------------------------------------------------------
say "3/4  Health check"
for i in 1 2 3 4 5; do
  if curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/health" 2>/dev/null; then
    echo
    break
  fi
  sleep 1
  [ "$i" = 5 ] && die "proxy did not answer on 127.0.0.1:$PORT"
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
