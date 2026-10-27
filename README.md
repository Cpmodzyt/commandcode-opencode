# Command Code ($1 Go plan) → OpenCode

Run **DeepSeek V4, Kimi, GLM, Qwen, MiniMax…** from your **$1/month Command Code Go
plan** inside **OpenCode**, with real streaming and real tool calling.

```
OpenCode  ──▶  local proxy (127.0.0.1:55990)  ──▶  /alpha/generate  ──▶  your $1 plan
```

---

## Why this exists

Command Code has two API surfaces, and the cheap plan only reaches one of them:

| Endpoint | Plans allowed |
| --- | --- |
| `/provider/v1/chat/completions` (OpenAI) | **Pro plan and above** |
| `/provider/v1/messages` (Anthropic) | **Pro plan and above** |
| `/alpha/generate` (internal, what their own CLI uses) | **Any plan, including Go ($1)** |

So pointing OpenCode straight at `https://api.commandcode.ai/provider/v1` fails with:

```json
{"error":{"message":"Your Go plan doesn't include API access. Upgrade to Pro or higher..."}}
```

`/alpha/generate` works, but it speaks a custom envelope (not OpenAI, not Anthropic).
This repo runs a small local translator so OpenCode can talk to it as a normal
OpenAI-compatible provider.

### What MCP does *not* do

MCP servers give an agent **tools**, not **models**. Connecting a "Command Code MCP"
to OpenCode lets OpenCode *delegate a task* to the `cmd` CLI — it never makes DeepSeek
the model answering your prompts. If you want the model itself, you need a provider,
which is what this repo sets up.

---

## What you get

19 models, each verified to work on the Go plan:

| Model | Notes |
| --- | --- |
| `DeepSeek Flash ($1)` | default — cheap, fast |
| `DeepSeek Pro ($1)` | strong, heavy reasoning (costs more) |
| `Kimi K2.7 Code ($1)` | 256K ctx, code-tuned |
| `Kimi K3 ($1)` | 1M ctx |
| `GLM-5.2 ($1)` / `GLM-5.3 ($1)` | 1M ctx |
| `Qwen3.8 Max ($1)` | 1M ctx |
| `MiniMax M3 ($1)` | 1M ctx |
| `Step 3.7 Flash ($1)` / `Step 5 Preview ($1)` | fast |
| `Grok 4.5 ($1)` | premium, included on Go |
| `GPT-5.6 Luna ($1)` | premium, included on Go |
| `Muse Spark 1.2 / 1.3 ($1)` | contributor tier |
| `Nemotron 3 Ultra ($1)`, `Hy3 ($1)`, `Hy4 Preview ($1)`, `Inkling ($1)`, `Inkling Small ($1)` | open weights |

**Not** available on Go (hidden by the included config): Claude, GPT (except Luna),
Gemini, Mistral, Grok 4.6/4.7. Picking them returns `MODEL_NOT_IN_PLAN`.

---

## Requirements

- Linux VPS, `x86_64` **or** `aarch64` (ARM)
- Root (or sudo)
- [OpenCode](https://opencode.ai) v2
- A Command Code account with a `user_...` API key

---

## Install, step by step

### 1. Clone

```bash
git clone https://github.com/Cpmodzyt/commandcode-opencode.git
cd commandcode-opencode
```

### 2. Install the proxy

```bash
sudo ./install.sh
```

This will:

- detect your CPU architecture and download the matching prebuilt binary
- put it in `/root/cc-proxy/`
- install and start a systemd service (`commandcode-proxy`) on `127.0.0.1:55990`
- create an empty, root-only `/root/cc-proxy/token`

Check it:

```bash
systemctl status commandcode-proxy
curl http://127.0.0.1:55990/health
# {"status":"ok"}
```

### 3. Get your Command Code API key

1. Open <https://commandcode.ai/settings/billing>
2. Copy the token that starts with `user_`
3. If you already ran `cmd login`, you can reuse that key instead (see step 4)

### 4. Save the key

```bash
/root/cc-proxy/set-key.sh user_your_key_here

# or reuse whatever the `cmd` CLI is logged in with:
/root/cc-proxy/set-key.sh --from-cli
```

The script validates the key against Command Code **before** saving it, then runs a
real test request. You should see:

```
OK  key saved for: Your Name <you@example.com>
Testing through the proxy...
OK  working.
```

### 5. Add the provider to OpenCode

Open `~/.config/opencode/opencode.json` and merge in the `providers.commandcode`
block from [`config/opencode.json`](config/opencode.json). Keep any providers you
already have.

The important parts:

```jsonc
{
  "providers": {
    "commandcode": {
      "name": "CommandCode $1",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:55990/v1",
        "apiKey": "{file:/root/cc-proxy/token}"
      }
    }
  },
  "model": "commandcode/deepseek/deepseek-v4.1-flash"
}
```

> **Never paste the raw key into this file.** It is world-readable. The
> `{file:...}` reference keeps the secret in a `600` file instead.

### 6. Reload

In OpenCode, run:

```
/reload
```

Config hot-reloads; you do **not** need to restart the machine or the proxy.

### 7. Verify

```bash
opencode models | grep commandcode
```

Then inside OpenCode:

```
/models
```

Pick **`DeepSeek Flash ($1)`**, and ask it something. If it answers, you are done.

---

## Daily use

```bash
cd ~/your-project
opencode
```

Switch model inside the TUI with `/models`.

One-shot from the shell:

```bash
opencode run "explain this codebase"
opencode run -m commandcode/deepseek/deepseek-v4-pro "why does this crash"
```

---

## Change the API key

```bash
/root/cc-proxy/set-key.sh user_NEW_KEY
```

then `/reload` in OpenCode.

Switching to a different Command Code account:

```bash
cmd login
/root/cc-proxy/set-key.sh --from-cli
```

Credits belong to the **account**, not the machine.

Manual equivalent:

```bash
printf '%s' 'user_NEW_KEY' > /root/cc-proxy/token   # printf, NOT echo
chmod 600 /root/cc-proxy/token
```

A trailing newline ends up inside the `Authorization` header and causes a `401`.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `401 UNAUTHORIZED` | Bad or revoked key. Re-run `set-key.sh`. |
| `MODEL_NOT_IN_PLAN` | That model needs Pro/GOAT. Stick to the `($1)` models. |
| `400` on every request | Proxy is stale. Re-run `install.sh` to update the binary. |
| `connection refused` on 55990 | `systemctl restart commandcode-proxy` |
| Hangs / `context length` | Prompt too large. Switch to a 1M-context model. |
| Credits draining fast | You are on `DeepSeek Pro`. Switch to `DeepSeek Flash`. |

Useful commands:

```bash
systemctl status commandcode-proxy
journalctl -u commandcode-proxy -f
curl -s http://127.0.0.1:55990/health
opencode api get /api/model | grep commandcode
```

Check remaining credits:

```bash
curl -s https://api.commandcode.ai/alpha/billing/credits \
  -H "Authorization: Bearer $(cat /root/cc-proxy/token)"
```

---

## Credits, honestly

Every request carries **~7.6K tokens of baseline overhead** (Command Code's own
system prompt), mostly cache-read even for a one-word prompt.

- `DeepSeek Flash` → cheap, use it for everything
- `DeepSeek Pro` → reasoning tokens bill as output, drains credits fast

The Go plan also has rolling caps (roughly 3 units / 5 hours, 6 / week).

---

## GitHub authentication (personal access token)

To push to this repo yourself you need a **Personal Access Token (PAT)** — GitHub
no longer accepts account passwords over HTTPS.

### Create one

1. <https://github.com/settings/tokens> → **Tokens (classic)** → **Generate new token**
2. Note: `vps-opencode`
3. Expiration: 30 days (short is better)
4. Scopes: check **`repo`** only
5. Generate and copy it — it is shown **once**

Prefer a fine-grained token when you can: *Repository access → Only select
repositories → commandcode-opencode*, *Permissions → Contents: Read and write*.
That cannot touch anything else if it leaks.

### Use it without leaking it

Do **not** do this — the token gets saved into `.git/config` in plaintext:

```bash
git remote add origin https://ghp_xxxx@github.com/user/repo.git   # ❌
```

Instead, keep the credential out of the repo and out of shell history:

```bash
# 1. remote WITHOUT the token
git remote set-url origin https://github.com/Cpmodzyt/commandcode-opencode.git

# 2. paste the token when prompted (or export it for one command)
GIT_TOKEN='ghp_xxxxx'
git -c http.extraheader="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GIT_TOKEN" | base64 -w0)" push -u origin main
```

Better still, cache it once with a credential helper:

```bash
git config --global credential.helper store   # plaintext on disk, 600 — acceptable on a private VPS
git push   # username: your GitHub username, password: the PAT
```

Or use SSH keys and skip tokens entirely.

### If a token leaks

1. Revoke it immediately: <https://github.com/settings/tokens>
2. Generate a new one
3. Audit <https://github.com/settings/security-log>

A token pasted into a chat, screenshot, or commit is compromised — revoke it even
if you think nobody saw it.

---

## Security notes

- The API key lives in `/root/cc-proxy/token`, mode `600`, owned by root.
- The proxy binds to `127.0.0.1` only — not reachable from the internet.
- `token`, `.env`, and `auth.json` are in `.gitignore`. Never commit them.
- `opencode.json` holds only a `{file:...}` reference, never the secret.

---

## Disclaimer

`/alpha/generate` is an **undocumented internal endpoint** of the Command Code CLI,
not a published API. It can change or be restricted at any time.

Command Code's documentation states the Go plan does not include API access. Using
this proxy routes around that restriction via the same endpoint their own CLI uses.
**That may violate their Terms of Service** and could get your account flagged or
banned. Use at your own risk.

If you want a supported setup, upgrade to a plan with official API access and point
OpenCode at `https://api.commandcode.ai/provider/v1` directly — no proxy needed.

## Credits

Proxy binary: [dev2k6/command-code-proxy-server](https://github.com/dev2k6/command-code-proxy-server) (MIT).
Protocol notes: [safzanpirani/pi-commandcode-provider](https://github.com/safzanpirani/pi-commandcode-provider).
