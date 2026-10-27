#!/usr/bin/env bash
#
# Change the Command Code API key used by OpenCode.
#
#   ./set-key.sh user_xxxxxxxxxxxx   # paste a key from commandcode.ai/settings/billing
#   ./set-key.sh --from-cli          # reuse the key the `cmd` CLI is logged in with
#
# The key is validated against Command Code BEFORE it is saved, so a typo
# cannot silently break your setup.

set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${PREFIX:-$SELF_DIR}"
KEYFILE="$PREFIX/token"
PORT="${PORT:-55990}"
CC="https://api.commandcode.ai"
CLI_AUTH="${HOME}/.commandcode/auth.json"

usage() {
  echo "usage: $0 <user_...>"
  echo "       $0 --from-cli"
  exit 1
}

[ $# -ge 1 ] || usage
KEY="$1"

if [ "$KEY" = "--from-cli" ]; then
  [ -f "$CLI_AUTH" ] || { echo "No CLI login found. Run: cmd login" >&2; exit 1; }
  KEY=$(python3 -c "import json;print(json.load(open('$CLI_AUTH'))['apiKey'])")
  echo "Read key from the command-code CLI login."
fi

# strip whitespace that sneaks in on paste
KEY=$(printf '%s' "$KEY" | tr -d '[:space:]')

case "$KEY" in
  user_*) ;;
  *) echo "ERROR: not a Command Code key (should start with 'user_')." >&2; exit 1 ;;
esac

echo "Checking key with Command Code..."
BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT

CODE=$(curl -s -o "$BODY" -w '%{http_code}' --max-time 25 "$CC/alpha/whoami" \
  -H "Authorization: Bearer $KEY" || echo "000")

if [ "$CODE" != "200" ] || ! grep -q '"success":true' "$BODY"; then
  echo "ERROR: Command Code rejected this key (HTTP $CODE)." >&2
  head -c 400 "$BODY" >&2; echo >&2
  exit 1
fi

USER=$(python3 -c "
import json
d = json.load(open('$BODY'))['user']
print(f\"{d.get('name','?')} <{d.get('email','?')}>\")
" 2>/dev/null || echo "unknown user")

mkdir -p "$PREFIX"
printf '%s' "$KEY" > "$KEYFILE"
chmod 600 "$KEYFILE"

echo "OK  key saved for: $USER"
echo

# end-to-end check through the local proxy
echo "Testing through the proxy..."
TEST=$(curl -s --max-time 90 "http://127.0.0.1:${PORT}/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}],"stream":false,"max_tokens":4}')

if echo "$TEST" | grep -q '"error"'; then
  echo "WARNING: proxy test failed. Is the service running?" >&2
  echo "  systemctl status commandcode-proxy" >&2
  echo "$TEST" | head -c 400 >&2; echo >&2
  exit 1
fi

echo "OK  working."
echo
echo "IMPORTANT: OpenCode reads this file once at startup, so a /reload may not"
echo "pick it up. Restart the background service to be sure:"
echo
echo "    opencode service restart"
echo
echo "(then reopen opencode)"
