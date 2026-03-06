# Asterisk ↔ Twilio PBX → Realtime Voice Agents — Codebase Summary

## 1. System Purpose & Stakeholder Need

This system turns a **classic SIP PBX** into a **natural-language interface** for a cyber threat-intelligence workflow. A human operator picks up a LAN phone and, through ordinary telephony signalling, reaches an AI-powered SOC (Security Operations Centre) analyst that can deliver real-time cyber SITREPs, look up CVEs, and perform semantic threat searches — all by voice.

The design thesis is **People → Process → Technology**: a real human, following a repeatable daily threat-intel workflow (SITREP + drill-down), enabled by a layered technology stack that bridges legacy SIP protocols to modern agentic AI.

---

## 2. Operational Concept (Modes of Use)

The system supports **three call modes**, each exercising a different routing path:

| Mode | Trigger | Path |
|---|---|---|
| **PSTN outbound** | Dial `00…` from LAN phone | Phone → Asterisk → Twilio SIP Domain → PSTN |
| **ODIN (SOC analyst)** | Dial `6346` | Phone → Asterisk → Twilio → `<Connect><Stream>` → `odin-realtime-bridge` (Fly.io) → OpenAI Realtime |
| **RIZZY (alt persona)** | Dial `7499` | Same as ODIN, different signed-token persona selection |
| **Inbound PSTN** | External caller dials Twilio number | Twilio → ANI allowlist → Agent _or_ voicemail |

Additionally, extension `7000` provides a **ConfBridge** conference room, with `7001` inviting ODIN into the bridge and `7002` dialling a Bermuda subscriber into it.

---

## 3. Functional Architecture (What the System Does)

The system decomposes into **two planes**:

### A) Voice / SIP Plane (real-time, latency-critical)

- **SIP registration**: LAN handsets (e.g. Yealink, Groundwire) register to Asterisk via PJSIP on UDP/5060.
- **Outbound SIP trunking**: Asterisk places calls to Twilio over **TLS (5061) + SRTP (SDES)**, with digest auth (407 challenge).
- **Call control routing**: Twilio invokes a webhook (Twilio Function) which returns TwiML — either `<Dial><Number>` for PSTN, or `<Connect><Stream>` for agent calls.
- **Media streaming**: For agent calls, Twilio opens a WebSocket media stream (G.711 μ-law) to the bridge.
- **Realtime voice agent**: The bridge connects upstream to the **OpenAI Realtime WebSocket API**, forwarding bidirectional audio with 20ms frame pacing, jitter buffering, barge-in detection, and backpressure management.

### B) Threat-Intel Data Plane (near-real-time, cached)

- **OSINT ingestion**: RSS/Atom bulk watching, NVD/CISA KEV/EPSS enrichment.
- **Processing**: Normalisation, severity tagging, clustering into themes, rolling 24h SITREP generation.
- **Serving**: **PostgREST** API (hosted on Fly.io) serves cached SITREP context; **Cyberscape Nexus** provides semantic search. The bridge pre-fetches and caches SITREP data (default 30-min refresh) to keep first-audio latency bounded.

---

## 4. Physical Architecture (How It's Built)

| Component | Technology | Deployment |
|---|---|---|
| **PBX** | Asterisk (PJSIP) in Docker (Debian bullseye-slim) | Raspberry Pi via Ansible, or macOS for dev |
| **Call control** | Twilio Functions (serverless JS) | Twilio Programmable Voice |
| **Realtime bridge** | Node.js WebSocket server (~2300 LOC), `ws` + `node-fetch` | Fly.io (`lhr` region, 1 vCPU / 1GB) |
| **AI model** | OpenAI Realtime API (configurable model, default `gpt-realtime-2025-08-28`) | OpenAI cloud |
| **Threat-intel API** | PostgREST + Cyberscape Nexus (semantic search) | Fly.io |
| **IaC / deployment** | Ansible playbook → sync repo → Docker Compose build on Pi | macOS control machine |

### Key repository components:

- `asterisk/` — PJSIP config template, dialplan, RTP range, ConfBridge profiles, module config.
- `docker/` — Dockerfile (Debian bullseye + Asterisk + envsubst) and entrypoint (env validation, TLS cert generation, config rendering).
- `compose/` — Dev and Pi Docker Compose files.
- `ansible/` — Inventory, playbook, role (`pbx_pi`) for idempotent Raspberry Pi deployment.
- `realtime-bridge/` — The WebSocket bridge server, Fly.io config, and reference Twilio Functions for `/dial` and `/dial-result`.
- `twilio-functions/` — Inbound PSTN call handler (`/inbound`), voicemail status handler (`/voicemail-status`), and caller allowlist example.
- `docs/` — Annotated realtime call flow, inbound routing docs, Wireshark appendix, draw.io architecture diagrams.

---

## 5. Interface Specification

| Interface | Protocol | Security | Notes |
|---|---|---|---|
| LAN phone ↔ Asterisk | SIP/UDP (5060) + RTP (10000–10100/UDP) | Username/password auth | LAN-only; Asterisk advertises `LAN_IP` in SDP |
| Asterisk ↔ Twilio | SIP/TLS (5061) + SRTP SDES | Digest auth + TLS (wildcard cert support) | Asterisk advertises `EXTERNAL_IP` in SDP |
| Twilio ↔ Bridge | WebSocket (WSS) | HMAC-signed short-lived token (base64url payload + HMAC-SHA256 sig) | Token passed in query string AND `start.customParameters` (redundancy against Twilio query-string stripping) |
| Bridge ↔ OpenAI | WebSocket | Bearer API key | G.711 μ-law codec, server-side VAD |
| Bridge ↔ PostgREST | HTTPS (GET) | Network-level (Fly.io internal) | Cached with configurable refresh interval |
| Bridge ↔ Nexus | HTTPS (POST) | Network-level | Semantic search (on-demand tool calls) |
| Voicemail → Email | HTTPS (SendGrid API) | Bearer API key | Recording link sent to operator |

---

## 6. Behavioural Model (State Machine & Key Sequences)

The bridge maintains a **per-call connection state machine**:

```
[TwilioUpgrading] → [TwilioConnected] → [AwaitingStart] → [TokenVerified]
  → [SitrepFetch] → [OpenAIConnecting] → [OpenAIReady] → [SessionConfigured]
  → [Streaming] ⇄ [BargeIn] → [Closing]
```

Key real-time behaviours:

- **Audio pacing**: Outbound audio delivered in 20ms / 160-byte frames via a timer loop.
- **Backpressure**: When the outbound queue exceeds `OUT_MAX_BUFFER_MS` (default 20s), oldest audio is trimmed to ~60% capacity — no cancel-loop.
- **Barge-in**: Server VAD `speech_started` events trigger debounced (default 450ms) outbound audio queue clearing and best-effort `response.cancel`.
- **Tool gating**: Tool calls execute **only** on `response.function_call_arguments.done` — never on partial/streamed arguments. Per-call limits: 6 counted calls (soft), 30 total (hard), 3 argument-error retries per tool.

---

## 7. Security Architecture

| Concern | Mitigation |
|---|---|
| Secrets management | `.env` file (never committed); Twilio Function env vars; Fly.io secrets |
| SIP transport | TLS 1.2 mandatory for Twilio leg; wildcard cert acceptance enabled |
| Media encryption | SRTP SDES required on Twilio endpoint |
| Agent auth | HMAC-SHA256 signed tokens with expiry (default 300s TTL), timing-safe comparison |
| Inbound call filtering | ANI allowlist (Twilio Private Asset `callers.private.json`); unknown callers → voicemail |
| NAT traversal | Dual-IP architecture: `EXTERNAL_IP` for Internet-facing SDP, `LAN_IP` for local SDP — prevents Docker bridge IP leakage |
| Dialplan hardening | Explicit deny-default in `[outbound]`; malformed E.164 blocked with `403`; only `00…` and `+X.` patterns permitted |
| Tool call limits | Configurable soft/hard/arg-error caps prevent runaway model tool loops |

---

## 8. Deployment & Lifecycle

```
Dev (macOS)                    Deploy (Raspberry Pi)              Runtime (Fly.io)
─────────────                  ─────────────────────              ─────────────────
Edit asterisk/*.conf           ansible-playbook                   fly deploy
  + .env                         ↓                                 ↓
docker compose up              Sync repo → Pi                     odin-realtime-bridge
  (dev compose)                Build image on Pi                   (WebSocket server)
                               docker compose up -d
                               (asterisk-twilio-pbx)
```

- **PBX**: Ansible role `pbx_pi` performs idempotent deployment — installs Docker, syncs repo, copies `.env`, builds image on-device, runs `docker compose up -d`.
- **Bridge**: Deployed to Fly.io via `fly deploy` from `realtime-bridge/`; secrets set via `fly secrets set`.
- **Twilio Functions**: Deployed via Twilio Console or CLI; reference implementations in repo.

---

## 9. Verification & Validation Evidence

The repository includes **real-world V&V artefacts**, not just unit tests:

- **Annotated call transcript** (`docs/realtime-flow.md`): A time-aligned, Whisper-transcribed recording of a live ODIN call demonstrating turn control, tool invocation, barge-in, cache introspection, and clean SIP teardown.
- **Wireshark capture analysis** (`docs/appendix-wireshark.md`): SIP signalling captured live over SSH (`tcpdump` → Wireshark) to validate TLS/SRTP negotiation and diagnose the ~9-minute call-drop issue (traced to upstream PSTN BYE, not Asterisk).
- **Runbook verification commands** (`RUNBOOK.md`): `pjsip show registrations`, `pjsip show endpoint`, `pjsip set logger on` — operational proof-of-state checks.
- **Troubleshooting matrix**: Symptom → cause → fix table covering `488 Secure SIP`, `403 Forbidden`, `404 Not Found`, and no-audio conditions.

---

## 10. Design Decisions & Trade-offs (Rationale Capture)

| Decision | Rationale |
|---|---|
| **Twilio SIP Domains** (not Elastic SIP Trunking) | Simpler setup for portfolio/lab; 407-digest auth + webhook call control is sufficient |
| **G.711 μ-law end-to-end** | Maximum interoperability across SIP, Twilio Media Streams, and OpenAI Realtime — no transcoding |
| **SITREP caching (30-min refresh)** | Keeps first-audio latency low; avoids blocking on backend fetch at call start |
| **Token redundancy** (query string + `customParameters`) | Twilio occasionally strips/mangles WebSocket upgrade query strings |
| **Backpressure via trim** (not cancel-loop) | Previous cancel-based approach caused silence; trim preserves continuity while bounding latency |
| **Docker on Raspberry Pi** (local build) | Avoids multi-arch CI complexity; Ansible syncs source and builds on-device |
| **Explicit dialplan deny-default** | Defence-in-depth: only allow-listed dial patterns reach the trunk |

---

## Summary

This is a **vertically integrated, production-realistic voice system** that bridges 1990s-era SIP telephony to a 2025-era agentic AI backend. It demonstrates mastery across the full stack — network protocols (SIP/TLS/SRTP), cloud voice APIs (Twilio), real-time media engineering (WebSocket bridging, audio pacing, barge-in), AI tool orchestration (OpenAI Realtime + gated tool calls), infrastructure-as-code (Docker, Ansible, Fly.io), and operational discipline (runbooks, Wireshark captures, annotated call transcripts). The separation into a latency-critical voice plane and a cached data plane is a deliberate architectural choice that keeps the system responsive under real conversational dynamics.
