# PBX Runbook (Groundwire ↔ Asterisk ↔ Twilio)

This repo runs Asterisk (PJSIP) in Docker and connects:

- Groundwire (LAN softphone) → Asterisk
- Asterisk → Twilio SIP Domain over **TLS + SRTP (SDES)**

## Required environment variables

Copy `.env.example` to `.env` and fill in your own values locally. Do not commit `.env`.

```dotenv
TWILIO_USERNAME=...
TWILIO_PASSWORD=...
TWILIO_DOMAIN=<your-sip-domain>.sip.twilio.com
TWILIO_PSTN_DOMAIN=<your-sip-domain>.sip.twilio.com

# Caller ID that Twilio will accept (Twilio number or verified caller ID)
TWILIO_CALLERID=<your-callerid-e164>

# Public IP of the PBX as seen by Twilio (SDP/RTP)
EXTERNAL_IP=<your-public-ip>

# LAN IP of the Pi (so LAN phones send RTP to a reachable address)
LAN_IP=<your-lan-ip>

GW_1001_PASSWORD=...
```

## Twilio configuration (SIP Domains)

### 1) SIP Domain auth
In **Voice → Manage → SIP domains → <your-sip-domain>.sip.twilio.com**:

- **Credential Lists**: add your credential list (username/password).
- **IP Access Control Lists**: optional; if you enable it, your public IP must be present.

### 2) Call Control Configuration (required)
Still on the SIP Domain page, under **Call Control Configuration**:

- Set **A CALL COMES IN** = **Webhook**
- Webhook URL = your deployed Twilio Function URL, e.g.
  `https://<your-twilio-functions-domain>.twil.io/dial`

(Using “Function” in the dropdown is fine if Twilio lists it, but if the picker shows “No options”, using **Webhook** with the Function URL works.)

## Asterisk / PJSIP highlights

### TLS registration and wildcard certs
Twilio presents a wildcard certificate. pjproject (used by Asterisk) rejects wildcard certs by default, so the TLS transport explicitly enables them and points at the system CA bundle.

### SRTP
Twilio required secure media; endpoint is configured:

- `media_encryption=sdes`

### Audio / NAT fix
No-audio was caused by Asterisk advertising Docker IPs (e.g. `172.19.0.2`) in SDP.

Fix is:
- Twilio transport advertises `EXTERNAL_IP` in SDP.
- LAN transport advertises `LAN_IP` in SDP.

## Dialing rules

Dialplan translates:

- `00...` → `+...` (E.164)

Example:

- Dial an E.164 number using the international prefix: `00<countrycode><number>`

## Verification commands

Container names differ by environment:

- Dev (macOS compose): `asterisk-twilio-pbx-dev` (service `pbx`)
- Pi compose: `asterisk-twilio-pbx` (service `pbx`)

Use either `docker exec` (container name) or `docker compose exec` (service name).

```bash
# Pick the container name for your environment:
# - Dev (macOS compose): asterisk-twilio-pbx-dev
# - Pi compose: asterisk-twilio-pbx
PBX_CONTAINER=asterisk-twilio-pbx

# Registration status
docker exec "$PBX_CONTAINER" asterisk -rx 'pjsip show registrations'

# Twilio endpoint / transport
docker exec "$PBX_CONTAINER" asterisk -rx 'pjsip show endpoint twilio-endpoint'
docker exec "$PBX_CONTAINER" asterisk -rx 'pjsip show transport twilio-transport-tls'

# Groundwire registration
docker exec "$PBX_CONTAINER" asterisk -rx 'pjsip show aor 1001'
```

---

## Voice agents (ODIN + RIZZY)

This PBX includes two callable OpenAI Realtime voice agents:

- **ODIN** (SOC master): dial **6346**
- **RIZZY ODIN** (dry-humour threat-intel analyst, nephew-friendly): dial **7499**

They use:
- Asterisk dialplan: ext `6346` → `Dial(PJSIP/6346@twilio-endpoint)`
- Asterisk dialplan: ext `7499` → `Dial(PJSIP/7499@twilio-endpoint)`
- Twilio SIP Domain Call Control webhook (`/dial`) that returns TwiML `<Connect><Stream>`
- A public WebSocket bridge (Fly.io app) that connects Twilio Media Streams ↔ OpenAI Realtime
- SITREP context pulled from your PostgREST backend (configured via `SITREP_BASE_URL`)
  - The bridge keeps an in-memory cache refreshed every ~30 minutes so calls don’t block on PostgREST.

Persona selection:
- The Twilio Function signs a short-lived token and includes `agent: "odin" | "rizzy"` in the token payload.
- The bridge validates the token and selects the system prompt based on `agent`.

### 1) Deploy the bridge to Fly

From `./realtime-bridge`:

```bash
# one-time
fly launch --name <your-fly-app-name> --region <region> --no-deploy

# secrets
fly secrets set OPENAI_API_KEY=... TWILIO_STREAM_HMAC_SECRET=... SITREP_BASE_URL=... CYBERSCAPE_NEXUS_BASE_URL=...

# deploy
fly deploy
```

Sanity check:

```bash
curl -sS https://<your-fly-app-name>.fly.dev/healthz
```

This should include cache status like `cache.has_data` and `cache.age_seconds`.

### 2) Configure Twilio Function (/dial)

In Twilio Functions:
- create/edit the function at path `/dial`
- paste the contents of `realtime-bridge/twilio-function-odin-dial.js`
- set environment variables:
  - `ODIN_STREAM_URL` = `wss://<your-fly-app-name>.fly.dev/twilio/stream`
  - `ODIN_HMAC_SECRET` = same value you used for Fly secret `TWILIO_STREAM_HMAC_SECRET`
  - optional: `ODIN_TOKEN_TTL_SECONDS` (default 300)
  - optional: `TWILIO_CALLERID` (your Twilio/verified caller ID)

### 3) Place a call

From Groundwire:
- dial `6346` (ODIN)
- dial `7499` (RIZZY)

What you should see:
- Twilio logs show the SIP Domain webhook was called
- Fly logs show a WebSocket connection to `/twilio/stream`
- ODIN speaks first with a **past-24h** SITREP (default), then takes questions

### Tool calling + debug logging (bridge)

The bridge exposes a small set of tools to OpenAI Realtime (vendor/news search, CVE lookup, KEV, and EPSS). To prevent runaway tool loops during calls, there are guardrails:

- `TOOL_CALL_LIMIT` (default `6`): max *counted* tool executions per call
  - argument errors (e.g. `missing_query`, `invalid_cve_id`) **do not count**
- `TOOL_CALL_HARD_LIMIT` (default `30`): hard cap including invalid-arg tool calls
- `TOOL_ARG_ERROR_LIMIT` (default `3`): per-tool argument-error cap before the model must ask the caller

Debug log controls:

- `TOOL_LOG_LEVEL` (`none|errors|all`) — tool execution logs (`errors` is default)
- `TOOL_EVENT_LOG_LEVEL` (`none|ids|verbose`) — logs OpenAI Realtime tool-event ID fields and argument streaming

Recommended debug workflow on Fly (temporarily):

- Enable verbose tool logs:
  `fly secrets set -a <your-fly-app-name> TOOL_LOG_LEVEL=all TOOL_EVENT_LOG_LEVEL=ids`

- Revert back to normal:
  `fly secrets set -a <your-fly-app-name> TOOL_LOG_LEVEL=errors TOOL_EVENT_LOG_LEVEL=none`

### Audio quality + stability tuning (bridge)

The bridge uses OpenAI Realtime **server VAD** for barge-in and paces OpenAI→Twilio audio at ~20ms frames.

If calls are responsive but you hear chopped/missing words, check Fly logs for:

- `buffer_high_trim_audio` (outbound queue exceeded limit; oldest audio was trimmed)
- lots of rapid `speech_started`/`speech_stopped` (chatty VAD causing repeated clears/suppression)

Tuning env vars:

- `OUT_MAX_BUFFER_MS` (default `20000`): raise to reduce trimming at the cost of more latency
- `OUT_MAX_FRAMES_PER_TICK` (default `10`): raise to let the sender drain backlog faster and avoid trimming
- `VAD_BARGE_IN_DEBOUNCE_MS` (default `450`): raise to reduce choppy barge-in on noisy lines

### Debugging ODIN / RIZZY

- Twilio Function logs: confirm it hits the `sip:6346@...` (ODIN) or `sip:7499@...` (RIZZY) branch.
- Fly logs:
  ```bash
  fly logs -a <your-fly-app-name>
  ```
- If the call connects but ODIN is silent:
  - it’s usually an audio codec mismatch. The bridge currently requests `g711_ulaw` I/O from OpenAI Realtime.
  - we can adjust to PCM16 + add transcoding if needed.

- If ODIN speaks but audio drops out mid-sentence:
  - look for `buffer_high_trim_audio` in Fly logs
  - increase `OUT_MAX_BUFFER_MS` and/or `OUT_MAX_FRAMES_PER_TICK`

## Common failure signatures

- **`488 Secure SIP transport required`**: Twilio requires TLS; ensure TLS transport is used.
- **`488 Secure media required`**: enable SRTP (`media_encryption=sdes`).
- **Twilio `403` without any `407` challenge**: Twilio is refusing before digest auth (often IP ACL/policy).
- **Twilio `404` after `407`**: SIP Domain has no Call Control Configuration (webhook/TwiML).
- **Call connects but no audio**: SDP likely advertises an unroutable address; verify `c=IN IP4` lines in SIP logs and ensure EXTERNAL_IP/LAN_IP are correct.
