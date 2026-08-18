# ChatGPT Web v2 (offline-tested service)

This is an isolated, parallel OpenAI-compatible service for the ChatGPT web protocol. It is designed to run beside the existing OmniRoute `chatgpt-web` provider. The existing provider, its configuration, and the npm-managed OmniRoute installation are not modified by this project.

For secure cookie installation, systemd setup, OmniRoute registration, live canary testing, Hermes session identity, monitoring, troubleshooting, and rollback, see [`DEPLOYMENT.md`](./DEPLOYMENT.md).

The default listener is `127.0.0.1:20129`.

## Local run and tests

Use the required runtime explicitly:

```sh
NODE=/home/tyler/.nvm/versions/node/v24.11.1/bin/node
NPM_CLI=/home/tyler/.nvm/versions/node/v24.11.1/lib/node_modules/npm/bin/npm-cli.js
cd /mnt/c/Users/Tyler/Documents/ChatGPT/chatgpt-web-v2
"$NODE" "$NPM_CLI" install
"$NODE" "$NPM_CLI" test
"$NODE" "$NPM_CLI" run typecheck
"$NODE" "$NPM_CLI" run syntax:check
"$NODE" "$NPM_CLI" run integrity:verify
CHATGPT_SESSION_COOKIE='[paste only in the process environment]' "$NODE" --experimental-strip-types src/server.ts
```

The normal tests use only sanitized fixtures and injected mock transports. They do not make a ChatGPT request and contain no real credentials. Node's `node:sqlite` is used for durable state; its experimental warning is expected on Node 24. `syntax:check` checks every source/test/script file; it is intentionally a syntax check, not a formatter.

## Configuration

Configuration is versioned (`version: 1`) and read from environment variables. Safe defaults are conservative: port `20129`, loopback host, one account-wide active turn, queue length `8`, 30-second queue deadline, and reasoning output disabled.

Important variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHATGPT_SESSION_COOKIE` | unset | `__Secure-next-auth.session-token` value or cookie line; never logged |
| `CHATGPT_WEB_V2_PORT` | `20129` | local service port |
| `CHATGPT_WEB_V2_HOST` | `127.0.0.1` | bind address |
| `CHATGPT_WEB_V2_DATA_DIR` | `./data` | SQLite/image data root |
| `CHATGPT_WEB_V2_DATABASE` | `<data-dir>/sessions.sqlite` | conversation state database |
| `CHATGPT_WEB_V2_IMAGE_CACHE` | `<data-dir>/images` | persistent image metadata/cache root |
| `CHATGPT_WEB_V2_CREDENTIAL_FILE` | `<data-dir>/session-cookie` | owner-only cookie file; atomically replaced on rotation |
| `CHATGPT_WEB_V2_MAX_CONCURRENCY` | `1` | account-wide limit, bounded to `1..3` |
| `CHATGPT_WEB_V2_QUEUE_MAX` | `8` | waiting requests before 429 |
| `CHATGPT_WEB_V2_QUEUE_TIMEOUT_MS` | `30000` | queue deadline |
| `CHATGPT_WEB_V2_REQUEST_TIMEOUT_MS` | `120000` | conversation POST deadline |
| `CHATGPT_WEB_V2_HANDOFF_TIMEOUT_MS` | `1200000` | handoff resume deadline |
| `CHATGPT_WEB_V2_POLL_INTERVAL_MS` | `4000` | reconciliation poll interval |
| `CHATGPT_WEB_V2_POLL_TIMEOUT_MS` | `1200000` | reconciliation poll deadline |
| `CHATGPT_WEB_V2_REASONING` | `false` | expose only explicitly labelled upstream thought/reasoning summaries |
| `CHATGPT_WEB_V2_POW_WORKER_POOL_SIZE` | `1` | bounded PoW worker-thread pool, capped at `3` |
| `CHATGPT_WEB_V2_TRANSPORT` | `tls` | production `tls`; stock `fetch` requires `CHATGPT_WEB_V2_ALLOW_FETCH=true` and is for dev/fixtures |
| `CHATGPT_WEB_V2_TLS_RUNTIME` | `native` | `tls-client-node` runtime mode; native binding is required by default |
| `CHATGPT_WEB_V2_TLS_NATIVE_LIBRARY` | auto | optional explicit native library path; no runtime dependency on OmniRoute |
| `CHATGPT_WEB_V2_TLS_PROXY_URL` | unset | operator proxy hook passed to the TLS client |
| `CHATGPT_WEB_V2_TLS_ROTATING_PROXY` | `false` | marks the configured proxy as rotating for TLS-client routing |
| `CHATGPT_WEB_V2_TLS_STARTUP_TIMEOUT_MS` | `20000` | native TLS initialization deadline |
| `CHATGPT_WEB_V2_TLS_TEMP_DIR` | `<data-dir>/tls-streams` | restrictive temporary stream output directory |
| `CHATGPT_WEB_V2_TLS_FIRST_BYTE_TIMEOUT_MS` | `30000` | bounded wait for the first native stream-file byte before buffered fallback |
| `CHATGPT_WEB_V2_UPSTREAM_BASE_URL` | `https://chatgpt.com` | protocol base URL; use a fixture URL in tests |
| `CHATGPT_WEB_V2_LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info`, or `debug` |

`tls-client-node` v0.2.0 is a local dependency. Production uses its native `firefox_148` profile, random TLS extension order, redirects, timeout, proxy, and stream-output options. Streaming starts after the first bytes appear in the native temp file and tails bounded chunks while the opaque native request continues; it does not buffer the whole SSE body. Because the native API exposes status/headers only when its request promise settles, positively identified SSE responses are exposed as HTTP 200 with synthesized event-stream headers; non-SSE/error bodies wait for the real status and remain buffered. If the native binding cannot initialize, `/readyz` returns 503 with `TLS_UNAVAILABLE` and requests fail explicitly; the service never silently falls back to stock `fetch`. `/healthz` reports process/account health. `/readyz` also returns 503 until a cookie is configured and the credential store/TLS transport are ready. `/v1/models` returns the supported web model aliases. `/v1/chat/completions` accepts OpenAI JSON and both stream modes.

The credential file takes precedence over `CHATGPT_SESSION_COOKIE`. If the file does not exist, an environment cookie bootstraps it with owner-only permissions (`0600` on POSIX); rotated cookies are written using same-directory temporary-file + rename replacement. This file is git-ignored and is not printed or included in diagnostics. Rollback must account for a rotated cookie: the original provider may need the latest value through its normal secret workflow.

## OmniRoute registration (documentation only)

Do not mutate OmniRoute from this repository. Add a separate generic OpenAI-compatible provider in the operator's normal configuration with these values:

```text
provider prefix: openai-compatible-chatgpt-web-v2
base URL:       http://127.0.0.1:20129
chat path:      /v1/chat/completions
models:         gpt-5.6-thinking, gpt-5.6-pro, ...
```

Keep the existing `chatgpt-web` record untouched. OmniRoute should call the local service with its ordinary OpenAI-compatible request. A Hermes worker should provide a stable `user` value so state remains isolated:

```json
{
  "model": "openai-compatible-chatgpt-web-v2/gpt-5.6-thinking",
  "user": "hermes-researcher-1",
  "messages": [{"role": "user", "content": "Summarize the fixture report."}],
  "stream": true
}
```

The service maps that user key to a durable `(account, user)` session. Normal keyed turns set `history_and_training_disabled:false`, store the upstream `conversation_id` and final `parent_message_id`, and send only the new user turn on continuation. Set `{"reset":true}` for an explicit new upstream conversation; reset preserves the local row/version metadata. Temporary/ephemeral behavior is opt-in with `temporary:true`, `persistConversation:false`, or `chatgpt_web_v2.temporary:true`.

## Recovery and safety model

Auth exchange is single-flight and adopts rotated session cookies immediately in process and through the credential store. The DPL/Sentinel prepare and PoW stages, conversation payload/header shapes, SSE parser, handoff resume offsets `0/1/2`, and conversation polling are injectable and covered by offline tests. PoW runs in a bounded worker-thread pool so the HTTP event loop is not occupied by hash loops. Streaming and non-streaming calls consume the same internal event pipeline. SSE comments are heartbeat comments; they are not zero-width assistant content. Stream failures are structured `error` events and are never emitted as assistant prose.

If a conversation POST may have reached ChatGPT, the session is marked `uncertain`. The next request first polls/reconciles and will not replay the POST. If reconciliation cannot establish the outcome, reset explicitly or resolve the upstream state before continuing.

Logs are structured and recursively redacted. Cookie, bearer, access-token, Sentinel, Turnstile, proof, API-key, and secret fields are replaced with `[REDACTED]`; prompt logging is not enabled by the service.

## Rollout / rollback

1. Run `npm test` and `npm run typecheck` with the exact Node binary above.
2. Run `npm run syntax:check` and `npm run integrity:verify`; the latter verifies the stored path/SHA-256 baseline for the audit-identified v1 OmniRoute artifacts without editing them.
3. Start on loopback and verify `/healthz`, `/readyz`, and `/v1/models`; use a mock transport or a deliberately controlled account smoke test only after the offline suite is green.
4. Register the generic provider as a separate route in OmniRoute (operator action, not a repository write).
5. Move one Hermes identity to the v2 model and observe health, queue time, Sentinel failures, uncertain turns, and cookie rotation.
6. Increase `CHATGPT_WEB_V2_MAX_CONCURRENCY` to `2`, then `3`, only after stable canary behavior.

Rollback is selecting the original `chatgpt-web/...` model/provider in Hermes and stopping this listener. Do not configure blind automatic failover after an uncertain turn. The original provider remains the rollback path; if its cookie rotated, update it through its normal secret workflow without printing it.

## Deliberately incomplete/live-validation items

- This pass has not made a live ChatGPT request and has not validated current account/model availability, current Sentinel requirements, Turnstile handling, or TLS fingerprint compatibility. Run a small, deliberate live smoke test before canary rollout.
- Native `tls-client-node` binding initialization and incremental temp-file SSE tailing are verified offline under Node v24.11.1; upstream connectivity, current account behavior, and first-byte timing against ChatGPT remain unvalidated. If a native binding hangs beyond its own timeout, cleanup remains tied to producer settlement because the opaque API has no mid-flight abort primitive.
- Native image download/WebSocket resolution is an extension interface; persistent image metadata/cache is implemented, while upstream asset resolution remains unconfigured rather than faked.
- Tool compatibility is strict schema-validated emulation for the audited `<tool>` convention. Native web tool execution, all streaming `tool_calls` edge cases, and arbitrary JSON Schema dialects remain follow-up work.
- A production deployment should supply an operator-managed secret mechanism rather than committing or placing a session cookie in a shell history. No credential-bearing files belong in this project.
