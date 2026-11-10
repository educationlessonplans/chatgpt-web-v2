# ChatGPT Web v2 deployment runbook

This runbook deploys ChatGPT Web v2 as an always-on local service and connects it to OmniRoute without changing or replacing OmniRoute's existing `chatgpt-web` provider.

The intended request path is:

```text
Hermes -> OmniRoute :20128 -> ChatGPT Web v2 :20129 -> chatgpt.com
```

## Deployment boundaries

- The existing OmniRoute `chatgpt-web` provider remains the rollback path.
- ChatGPT Web v2 owns its session cookie, persistent conversation state, image metadata, TLS client, and PoW workers.
- OmniRoute receives only the local v2 endpoint. Do not paste the ChatGPT cookie into the v2 OmniRoute connection.
- Never put the cookie in a command argument, checked-in file, service unit, log, or shell history.
- Initial live validation should use one deliberate request at a time. Increase concurrency only after stable observation.
- Do not configure blind automatic fallback after a conversation POST may have reached ChatGPT; that can duplicate a turn.

## Paths and ports

| Purpose | Value |
| --- | --- |
| Project | `/path/to/chatgpt-web-v2` |
| Node runtime | `$HOME/.nvm/versions/node/v24.11.1/bin/node` |
| OmniRoute CLI | `$HOME/.nvm/versions/node/v24.11.1/lib/node_modules/omniroute/bin/omniroute.mjs` |
| V2 service | `http://127.0.0.1:20129` |
| OmniRoute | `http://127.0.0.1:20128` |
| V2 operator config | `$HOME/.config/chatgpt-web-v2` |
| V2 persistent data | `$HOME/.local/share/chatgpt-web-v2` |

## 1. Preflight

Confirm the expected runtime and offline validation before installing services:

```bash
cd /path/to/chatgpt-web-v2

node --version
npm test
npm run typecheck
npm run syntax:check
npm run integrity:verify

systemctl --user is-system-running
loginctl show-user "$USER" -p Linger
```

Expected results:

- Node is `v24.11.1`.
- Tests, typecheck, syntax check, and OmniRoute v1 integrity verification pass.
- The user systemd manager is running.
- `Linger=yes` is enabled so user services can run without an open terminal.

On this WSL installation, `/etc/wsl.conf` should contain:

```ini
[boot]
systemd=true
```

Changing `wsl.conf` requires a full WSL shutdown from Windows before it takes effect.

## 2. Create secure configuration and data directories

```bash
install -d -m 700 \
  $HOME/.config/chatgpt-web-v2 \
  $HOME/.local/share/chatgpt-web-v2
```

Create `$HOME/.config/chatgpt-web-v2/service.env`:

```ini
CHATGPT_WEB_V2_DATA_DIR=/home/you/.local/share/chatgpt-web-v2
CHATGPT_WEB_V2_CREDENTIAL_FILE=/home/you/.config/chatgpt-web-v2/session-cookie
CHATGPT_WEB_V2_MAX_CONCURRENCY=1
CHATGPT_WEB_V2_REASONING=true
CHATGPT_WEB_V2_LOG_LEVEL=info
```

Protect it:

```bash
chmod 600 $HOME/.config/chatgpt-web-v2/service.env
```

Start at concurrency `1`. Raise it to `2` and then `3` only after the canary procedure succeeds.

## 3. Install the ChatGPT session cookie safely

Obtain the value of `__Secure-next-auth.session-token` from an authenticated `chatgpt.com` browser session. The service accepts either the bare value or the complete cookie assignment.

Use a silent prompt so the value does not enter shell history:

```bash
read -rsp "ChatGPT session cookie: " CHATGPT_V2_COOKIE
printf '%s' "$CHATGPT_V2_COOKIE" > $HOME/.config/chatgpt-web-v2/session-cookie
unset CHATGPT_V2_COOKIE
printf '\n'
chmod 600 $HOME/.config/chatgpt-web-v2/session-cookie
```

Do not inspect the file with `cat`, include it in diagnostic bundles, or paste it into OmniRoute logs. ChatGPT Web v2 atomically replaces this file when ChatGPT rotates the session cookie.

The credential file takes precedence over `CHATGPT_SESSION_COOKIE`. The environment variable is intended only to bootstrap a missing credential file.

## 4. Install ChatGPT Web v2 as a systemd user service

Create `$HOME/.config/systemd/user/chatgpt-web-v2.service`:

```ini
[Unit]
Description=ChatGPT Web v2 OpenAI-compatible provider
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/chatgpt-web-v2
EnvironmentFile=/home/you/.config/chatgpt-web-v2/service.env
ExecStart=/home/you/.nvm/versions/node/v24.11.1/bin/node --experimental-strip-types /path/to/chatgpt-web-v2/src/server.ts
Restart=always
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

Load and start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now chatgpt-web-v2.service
systemctl --user status chatgpt-web-v2.service --no-pager
```

Check the local endpoints:

```bash
curl -fsS http://127.0.0.1:20129/healthz
curl -fsS http://127.0.0.1:20129/readyz
curl -fsS http://127.0.0.1:20129/v1/models
```

`/readyz` should return HTTP 200 with `ready:true`. A 503 response is expected when the cookie is missing, the credential file is invalid, or native TLS initialization failed.

Useful logs:

```bash
journalctl --user -u chatgpt-web-v2.service -n 100 --no-pager
journalctl --user -u chatgpt-web-v2.service --since today -f
```

The logger is designed to redact credentials, but logs should still be treated as private operational data.

## 5. Enable OmniRoute autostart

Use the installed Node runtime and OmniRoute CLI explicitly:

```bash
node \
  $HOME/.nvm/versions/node/v24.11.1/lib/node_modules/omniroute/bin/omniroute.mjs \
  autostart enable
```

Make OmniRoute start after ChatGPT Web v2:

```bash
systemctl --user edit omniroute.service
```

Add this drop-in:

```ini
[Unit]
Wants=chatgpt-web-v2.service
After=chatgpt-web-v2.service
```

Apply it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now omniroute.service
systemctl --user status omniroute.service chatgpt-web-v2.service --no-pager
```

If an existing Hermes startup hook also starts OmniRoute, its normal non-restart path should see port `20128` already listening and exit. Avoid invoking any force-restart variant of that hook while systemd owns OmniRoute.

## 6. Register ChatGPT Web v2 in OmniRoute

Open the OmniRoute dashboard:

```text
http://127.0.0.1:20128
```

Create a separate OpenAI-compatible provider node with these values:

| Field | Value |
| --- | --- |
| Type | `OpenAI-compatible` |
| Name | `ChatGPT Web v2` |
| Prefix | `chatgpt-web-v2` |
| API type | `chat` |
| Base URL | `http://127.0.0.1:20129` |
| Chat path | `/v1/chat/completions` |
| Models path | `/v1/models` |
| Custom headers | none |

OmniRoute generates an internal provider ID beginning with `openai-compatible-`. Use the configured prefix as the user-facing model namespace:

```text
chatgpt-web-v2/gpt-5.6-thinking
```

After creating the provider node, create and activate its provider connection in OmniRoute. ChatGPT Web v2 owns the upstream ChatGPT credential; the OmniRoute connection must not contain the ChatGPT cookie. If OmniRoute requires an API-key value for the local OpenAI-compatible connection, use a local placeholder until inbound bearer authentication is implemented.

Verify that the model catalog is visible:

```bash
curl -fsS http://127.0.0.1:20128/v1/models
```

Do not mutate or disable the original `chatgpt-web` connection. It remains the rollback route.

## 7. Controlled live smoke test

The following requests contact the live ChatGPT account. Run them deliberately and only after offline tests and `/readyz` are green.

First test ChatGPT Web v2 directly:

```bash
curl -sS http://127.0.0.1:20129/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5.6-thinking",
    "user": "v2-smoke-test",
    "messages": [{"role":"user","content":"Reply with exactly V2_OK"}],
    "stream": false
  }'
```

Then send one equivalent request through OmniRoute using:

```text
chatgpt-web-v2/gpt-5.6-thinking
```

Confirm:

- The response is from the v2 route, not an OmniRoute fallback.
- No credential appears in either service's journal.
- The v2 session database records the `v2-smoke-test` session.
- A second request using the same `user` continues the same upstream conversation.
- A different `user` starts an isolated conversation.

Do not configure automatic cross-provider fallback for the canary. If the conversation POST outcome is uncertain, v2 must resume or poll that conversation rather than submitting the turn again elsewhere.

## 8. Hermes session identity

ChatGPT Web v2 uses the top-level OpenAI `user` request field as its persistent conversation key:

```json
{
  "model": "chatgpt-web-v2/gpt-5.6-thinking",
  "user": "stable-hermes-session-id",
  "messages": [{"role":"user","content":"Continue our work."}]
}
```

Hermes already tracks an internal `session_id`, but the current Hermes Chat Completions path does not automatically copy it into `user`. Until that bridge is implemented, requests without `user` map to the shared key `anonymous` and are serialized into one upstream conversation.

The preferred Hermes integration is:

```python
if targeting_chatgpt_web_v2 and session_id:
    api_kwargs["user"] = session_id
```

Apply this only to the v2 model/provider route. Do not globally send Hermes session IDs to unrelated providers.

For a temporary three-worker canary, three fixed user values can be supplied through worker-specific request overrides:

```text
hermes-chatgpt-1
hermes-chatgpt-2
hermes-chatgpt-3
```

The dynamic Hermes `session_id` bridge is preferable because it naturally isolates new, resumed, and branched Hermes sessions.

## 9. Concurrency rollout

Begin with:

```ini
CHATGPT_WEB_V2_MAX_CONCURRENCY=1
```

After stable single-agent operation, change it to `2`, restart v2, and observe the account. Repeat for `3` only if the account remains healthy.

```bash
systemctl --user restart chatgpt-web-v2.service
systemctl --user status chatgpt-web-v2.service --no-pager
```

Monitor for:

- HTTP 429 responses
- Sentinel or Turnstile blocking
- authentication failures
- uncertain turns
- queue timeouts
- repeated conduit resume or polling failures
- cookie rotation failures

Do not increase PoW worker count merely to increase account traffic. Account concurrency and PoW worker concurrency are separate controls.

## 10. Routine operations

### Status

```bash
systemctl --user is-active chatgpt-web-v2.service omniroute.service
curl -fsS http://127.0.0.1:20129/healthz
curl -fsS http://127.0.0.1:20129/readyz
curl -fsS http://127.0.0.1:20128/api/health
```

`/healthz` proves the v2 process and coordinator are responsive. `/readyz` proves local credential/TLS readiness. Neither endpoint guarantees that ChatGPT has not changed its private web protocol; real request failures remain the upstream compatibility signal.

### Restart

```bash
systemctl --user restart chatgpt-web-v2.service
systemctl --user restart omniroute.service
```

### Logs

```bash
journalctl --user -u chatgpt-web-v2.service --since today --no-pager
journalctl --user -u omniroute.service --since today --no-pager
```

### Re-run validation after code or dependency changes

```bash
cd /path/to/chatgpt-web-v2
npm test
npm run typecheck
npm run syntax:check
npm run integrity:verify
```

Restart v2 only after validation passes.

## 11. Rollback

1. Stop sending new turns to v2.
2. Allow active turns to finish or reconcile uncertain sessions.
3. Point Hermes back to the original `chatgpt-web/...` model.
4. Stop v2 if desired:

```bash
systemctl --user disable --now chatgpt-web-v2.service
```

Do not delete v2's SQLite database during rollback. It contains the state needed to resume its conversations later.

If ChatGPT rotated the cookie while v2 was active, the original provider's stored cookie may be stale. Update the original connection through its normal secret workflow using the latest cookie value; never retrieve or print it through logs.

## 12. Troubleshooting

### V2 does not start

```bash
systemctl --user status chatgpt-web-v2.service --no-pager
journalctl --user -u chatgpt-web-v2.service -n 200 --no-pager
```

Check the exact Node path, project path, service environment file, data-directory permissions, and whether port `20129` is already in use.

### `/readyz` returns 503

Inspect the response's non-secret readiness fields. Common causes are:

- missing cookie file
- cookie file permissions broader than owner-only
- empty credential file
- native `tls-client-node` initialization failure
- account health state blocked by authentication or Sentinel failures

Do not print the credential while diagnosing it.

### OmniRoute cannot reach v2

```bash
curl -fsS http://127.0.0.1:20129/v1/models
systemctl --user status chatgpt-web-v2.service omniroute.service --no-pager
```

Confirm the provider node uses `127.0.0.1:20129`, the chat path is `/v1/chat/completions`, and OmniRoute permits local provider URLs.

### All Hermes agents share one conversation

Inspect the outgoing request shape without recording credentials or prompt bodies. Each agent/session must have a distinct, stable top-level `user`. If it is absent, all requests use `anonymous`.

### A session reports an uncertain prior turn

Do not resend the prompt through another provider. Let v2 reconcile through conversation polling/resume. If reconciliation cannot establish the result, explicitly reset that session only after deciding that abandoning the upstream conversation is acceptable.

### Original provider fails after rollback

The ChatGPT session cookie may have rotated while v2 was active. Refresh the original provider's credential through OmniRoute's normal protected UI. Do not copy it through logs or command output.

## 13. Known production gaps

- Live compatibility with the current ChatGPT Sentinel/Turnstile behavior has not yet been validated.
- The native TLS library does not reveal final upstream status before its request promise settles. Positively identified early SSE output is exposed with synthesized HTTP 200 event-stream headers.
- Native image asset download and WebSocket resolution are not complete.
- Tool support is schema-validated emulation, not native ChatGPT web tool execution.
- Inbound bearer authentication for the loopback v2 API is not implemented; keep it bound to `127.0.0.1`.
- The Hermes `session_id` to OpenAI `user` bridge remains to be implemented.
- Process supervision cannot guarantee that an undocumented upstream web protocol will remain compatible.

Do not describe the deployment as production-ready until the live canary, Hermes session bridge, and operational monitoring have been completed.
