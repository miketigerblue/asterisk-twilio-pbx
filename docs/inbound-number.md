# Inbound PSTN routing (Twilio Number → allowlist → agent / voicemail)

This project supports **inbound PSTN calls to your Twilio phone number** with:

- ANI (caller ID) allowlist lookup
- per-caller greeting
- routing to ODIN/RIZZY (Twilio Media Streams → Fly.io `odin-realtime-bridge` → OpenAI Realtime)
- fallback voicemail for unknown callers (Twilio `<Record>`)

## Configure Twilio Phone Number webhook

Twilio Console:
**Phone Numbers → Manage → Active numbers → <your number> → Configure**

Set:

- **A call comes in**: Function
- Path: `/inbound`

Unknown callers will be sent to voicemail (`/voicemail-status`).

## Repo files

- `twilio-functions/twilio-function-inbound.js`
- `twilio-functions/twilio-function-voicemail-status.js`
- `twilio-functions/callers.example.json`

## Allowlist storage (recommended)

Create a **Private Twilio Asset** named:

- `callers.private.json`

Use the schema in `twilio-functions/callers.example.json`.

## Twilio Function environment variables

Agent routing:
- `ODIN_STREAM_URL` = `wss://<your-fly-app>.fly.dev/twilio/stream`
- `ODIN_HMAC_SECRET` = shared secret (must match Fly secret `TWILIO_STREAM_HMAC_SECRET`)

Voicemail email (SendGrid):
- `SENDGRID_API_KEY`
- `VOICEMAIL_TO_EMAIL`
- `VOICEMAIL_FROM_EMAIL`

Optional:
- `ODIN_TOKEN_TTL_SECONDS` (default 300)
- `VOICEMAIL_MAX_LENGTH_SECONDS` (default 60)
- `VOICEMAIL_SUBJECT_PREFIX` (default `PBX voicemail`)

## Security notes

- In Twilio Functions, enable **Validate incoming requests**.
- Keep the allowlist in a **Private Asset**.

