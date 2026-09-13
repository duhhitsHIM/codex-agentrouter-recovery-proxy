# Codex AgentRouter recovery proxy

A small local proxy that keeps [Codex](https://openai.com/codex/) sessions alive when AgentRouter
(or any load-balancing OpenAI reseller) rejects the encrypted reasoning items from your own
conversation.

It fixes these errors, which kill a session permanently and survive a restart:

```
OpenAI Responses bad request: The encrypted content for item rs_0b50e6... could not be
verified. Reason: Encrypted content could not be decrypted or parsed. [trace_id=...]
```

```
The requested item was created under a different Azure OpenAI resource. Use the same
resource that created the item to access it. [trace_id=...]
```

Both are the same problem wearing different masks. Nothing is wrong with your account, your key,
or your session.

## Why this happens

Codex runs the Responses API with `store: false` and `include: ["reasoning.encrypted_content"]`.
The model's reasoning never lives on the server — Codex keeps it locally and re-sends the whole
pile of opaque `rs_…` blobs with **every** follow-up turn.

Those blobs are sealed to the exact org or Azure resource that minted them. A reseller like
AgentRouter load-balances across several upstream accounts, so the moment one turn lands on a
different backend than the turn that produced the reasoning, the gateway refuses to open the
envelope and returns a 400.

The session is then stuck forever: every retry re-sends the same poisoned blob, so the error
repeats until you abandon the conversation.

## What the proxy does

It sits between Codex and AgentRouter on `127.0.0.1:17863` and watches for that specific rejection
**before any bytes reach Codex**. When it sees one, it:

1. Cancels the failed response, so Codex never sees the error.
2. Re-sends the same request with the opaque reasoning items stripped out — your messages, tool
   calls, tool results and compaction items are all preserved.
3. Remembers the rejected blob (as a SHA-256 hash) so later turns in that session drop it up front
   instead of failing again.

You lose some of the model's private reasoning from the affected turns. You keep the conversation.

Deliberate limits, because getting these wrong is worse than the bug:

- **It never replays a request after visible model output.** Once a single token or tool call has
  reached you, a retry could duplicate a side effect, so the error is passed through instead.
- **It only ever strips `reasoning` items.** `compaction` items also carry `encrypted_content`, but
  dropping one would delete conversation history, so a compaction-only failure is passed through.
- **It retries once.** A second failure goes to the client rather than looping.

## Requirements

- Node.js 22 or newer
- Codex (desktop app or CLI) already working against AgentRouter
- `~/.codex/config.toml` containing a `[model_providers.agentrouter]` section
- Windows for the autostart script; the proxy itself runs anywhere Node does

## Install

Get the folder, either by cloning it or by unzipping a copy someone sent you:

```bash
git clone https://github.com/duhhitsHIM/codex-agentrouter-recovery-proxy.git
```

Then open a terminal **in that folder** and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1
```

Keep the folder where it is afterwards — the scheduled task launches the proxy from that path, so
moving or deleting it stops the proxy from coming back. Anywhere is fine, it just has to be stable.

That runs the test suite, points `config.toml` at the proxy (backing the file up first), registers
a scheduled task that starts the proxy at logon and restarts it within two minutes if it ever
dies, and waits until it answers.

**Restart Codex afterwards** so it picks up the new `base_url`.

The only change to your config is one line:

```toml
[model_providers.agentrouter]
base_url = "http://127.0.0.1:17863/v1" # local recovery proxy -> https://agentrouter.org/v1
```

## Verify

```bash
curl http://127.0.0.1:17863/health
```

```json
{"service":"codex-agentrouter-recovery-proxy","version":"1.0.0","requests":12,"retries":1,"recovered":1,"filtered":3}
```

- `retries` — times a rejection was detected and the request re-sent
- `recovered` — times that retry produced a working response
- `filtered` — blobs dropped up front because they were already known bad

`retries` can exceed `recovered`: if the retry hits an unrelated failure (AgentRouter 502s are
common), it is counted honestly as not recovered.

## Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 -Uninstall
```

Removes the scheduled task and restores `base_url` to whatever it was before. Every edit also
leaves a `config.toml.bak-<timestamp>` next to the original.

## Troubleshooting

**Codex says connection refused.** The proxy is down. `curl http://127.0.0.1:17863/health`, then
`powershell -File start.ps1`, or `Start-ScheduledTask -TaskName CodexAgentRouterRecoveryProxy`.

**The error still appears.** Check that Codex is actually going through the proxy — if `requests`
in `/health` stays at 0, `base_url` was never picked up, so restart Codex. Otherwise read the log:

```bash
tail -30 proxy.stderr.log
```

An `unhandled_upstream_rejection` entry means the gateway used a wording the proxy does not
recognize yet. The message is in the log (with anything key-shaped redacted); add its pattern to
`BOUND_ITEM_PATTERNS` in `proxy.mjs`.

**`no_agentrouter_provider`.** Your provider section is named something else. Either rename it to
`[model_providers.agentrouter]` (and update `model_provider =` to match) or edit the section name
in `server.mjs` and `wire-config.mjs`.

**`provider_key_unavailable` (503).** The proxy could not find your key. It reads
`experimental_bearer_token` from the `[model_providers.agentrouter]` section, or the variable named
by `env_key` if you use that instead. Note that the autostart task launches at logon and only sees
variables set **persistently** (System Properties, or `setx`) — one exported in a terminal session
will not reach it. Putting the token in `config.toml` avoids the problem entirely.

**Not on Windows.** Skip `setup.ps1`. Run `node wire-config.mjs` to edit the config, then keep
`node server.mjs` running however you prefer — launchd, systemd, or just a terminal.

## Security

- Binds to `127.0.0.1` only, and rejects any request whose `Host` is not the loopback address or
  that carries an `Origin` header, so a browser on your machine cannot reach it.
- Requires your own bearer token on every request and compares it in constant time.
- Only forwards `POST /v1/responses`, `POST /v1/responses/compact` and `GET /v1/models`.
- Never follows redirects, so the token cannot be bounced to another host.
- Strips `Cookie` and hop-by-hop headers before forwarding.
- Your token is read from `~/.codex/config.toml` at request time and is never written to disk or
  logged. Logs contain event names, counts and status codes — never prompts, completions or
  encrypted payloads. The test suite asserts this.

## Development

```bash
npm run lint    # syntax check
npm test        # 18 tests, no network
```

`live-check.mjs` is an opt-in check against the real gateway. It sends one synthetic prompt plus a
single reasoning blob taken from a rollout file, and `--corrupt` flips bytes in that blob to force
the failure on demand:

```bash
node live-check.mjs ~/.codex/config.toml <rollout.jsonl> <rs_itemId> --corrupt
```

Expect `PROXY_OK` twice and `retries 1 / recovered 1`.

## The bug that cost the first attempt

On `stream: true` requests the gateway returns its 400 with `content-type: text/event-stream` but
an **unframed JSON body**. Any probe that trusts the declared framing looks for an SSE separator
that never arrives, finds nothing, and forwards the error untouched — while every unit test using
`application/json` passes. `probe()` now parses what actually arrived rather than what the header
claims.
