# Realtime call flow (annotated example)

This document is a **time-aligned, real call excerpt** for ODIN, reconstructed from a recorded self-call using Whisper (`whisper-cli` / `whisper.cpp` with Metal). :contentReference[oaicite:1]{index=1}

It is intended to illustrate **real-time voice UX realities** (interruptions, turn control, tool lookups) and provide a concrete reference that maps back to the architecture docs.

> Note on timestamps: these are **relative to the recorded audio** (screen-recording timeline), not Twilio’s stream epoch. They are still useful for sequencing and cross-correlation with Wireshark / Fly logs. :contentReference[oaicite:2]{index=2}

---

## Context (this recording)

- LAN handset: Yealink desk phone (ext `1001`)
- PBX: Asterisk (PJSIP) in Docker on Raspberry Pi
- Twilio: SIP Domain (TLS signalling) + Call Control Function
- Agent: ODIN via `<Connect><Stream>` to `odin-realtime-bridge` (Fly.io) → OpenAI Realtime
- Capture method: Wireshark live over SSH, scoped to SIP signalling ports (UDP/5060 + TCP/5061) :contentReference[oaicite:3]{index=3}

---

## High-level flow

`Yealink → Asterisk (UDP/5060) → Twilio SIP Domain (TLS/5061) → Twilio Function (/dial) → <Connect><Stream> → odin-realtime-bridge → OpenAI Realtime → (tools via PostgREST / semantic search)`

---

## Timeline excerpt (key moments)

### 0) Setup / instrumentation

**00:00:16.620 – 00:00:29.140**  
Narration confirms Wireshark is capturing over SSH and filtering SIP signalling ports:
- `5060/udp` (LAN phone ↔ Asterisk)
- `5061/tcp` (Asterisk ↔ Twilio TLS signalling) :contentReference[oaicite:4]{index=4}

**00:00:37.900 – 00:00:52.040**  
Dial plan intent: call extension **6346** (ODIN). :contentReference[oaicite:5]{index=5}

---

### 1) ODIN call begins + initial SITREP

**00:03:10.740 – 00:03:13.780**  
User completes dialling: “that’s odin”. :contentReference[oaicite:6]{index=6}

**00:03:13.780 – 00:03:35.860**  
ODIN opens with a quick SITREP and asks where to dive in. :contentReference[oaicite:7]{index=7}

**00:03:35.860 – 00:03:54.180**  
User initially asks about “wireshark tooling”; ODIN interprets as “security news related to Wireshark tooling”, user corrects and asks for general headlines. :contentReference[oaicite:8]{index=8}

> **Design implication:** first-turn intent can be ambiguous; caller corrections are normal. Don’t over-eagerly tool-call on ambiguous phrases unless confidence is high.

---

### 2) Real-time capture restart (operator behaviour mid-call)

**00:04:12.420 – 00:04:19.780**  
User restarts capture. :contentReference[oaicite:9]{index=9}

**00:04:24.180 – 00:05:06.120**  
User narrates the SSH→tcpdump→Wireshark streaming approach and reattempts dialling. :contentReference[oaicite:10]{index=10}

> **Note:** This segment is useful as evidence that the system is being tested under real instrumentation, not in a toy environment.

---

### 3) Tool-backed CVE lookup (clear intent + structured query)

**00:05:18.080 – 00:05:42.800**  
User requests CVE lookup and provides identifier: **CVE-2025-3400**. :contentReference[oaicite:11]{index=11}

**00:05:48.080 – 00:06:19.400**  
ODIN returns a structured summary including:
- attack surface (remote)
- exploit availability
- CVSS score
- KEV status
- EPSS score :contentReference[oaicite:12]{index=12}

> **Design implication:** this is the “happy path” for tool use:
> - user provides a precise key (CVE ID)
> - agent returns deterministic structured fields
> - minimal conversational thrash

---

### 4) “Cisco zero-day” search + user dissatisfaction (quality control)

**00:06:19.400 – 00:07:04.920**  
User asks “search for Cisco Zero Day”; agent returns results, but user judges them “boring” and “old”. :contentReference[oaicite:13]{index=13}

> **Design implication:** freshness matters. For news search tools, consider:
> - default recency window
> - explicit “last 24h” option
> - ranking by publish date and/or exploitability

---

### 5) Turn control / interruption (“stop talking”)

**00:07:12.220 – 00:07:18.840**  
User: “Hey, stop talking.”  
ODIN: “Got it. Pausing now…” :contentReference[oaicite:14]{index=14}

> **Design implication:** you need an explicit “interrupt/stop” control-plane behaviour.
> In the bridge implementation, this typically corresponds to:
> - barge-in detection (VAD)
> - response cancellation (best effort)
> - clearing outbound audio buffers (avoid “tail spill”)

---

### 6) Cache-awareness + clustering stats (stateful behaviour)

**00:07:18.840 – 00:07:59.700**  
User queries:
- “How many sitreps do you have in the past 24 hours?” → “23” :contentReference[oaicite:15]{index=15}
- “How many clusters do you have?” → “11 active clusters…” :contentReference[oaicite:16]{index=16}

**00:09:12.020 – 00:09:35.860**  
User: “what is in your cache currently”  
ODIN: cache age ≈ “20 minutes ago” + examples of cached topics. :contentReference[oaicite:17]{index=17}

> **Design implication:** cache introspection is a strong UX primitive:
> - makes the agent feel grounded
> - provides observability hooks (healthz/cache age)
> - reduces “hallucination anxiety” for the operator

---

### 7) Tool surface discovery (self-documenting agent)

**00:09:35.860 – 00:10:11.780**  
User asks what tools ODIN has; ODIN lists semantic search, CVE/KEV/EPSS tooling, KEV updates, EPSS movers. :contentReference[oaicite:18]{index=18}

> **Design implication:** explicit tool discovery reduces prompt-injection risk and
> improves operator trust by showing the bounded capability set.

---

### 8) Call termination (clean teardown)

**00:11:45.780 – 00:12:01.060**  
User indicates intent to hang up; ODIN responds; user ends call. :contentReference[oaicite:19]{index=19}

**00:12:01.060 – 00:12:18.180**  
User narrates stopping the capture and planning post-analysis / write-up. :contentReference[oaicite:20]{index=20}

---

## Key behaviours illustrated by this call

1) **Real turn control**: user interrupts and can stop the agent (control-plane primitive). :contentReference[oaicite:21]{index=21}  
2) **Confidence-driven tool use**: CVE lookup succeeds when the user provides a stable key (CVE ID). :contentReference[oaicite:22]{index=22}  
3) **Recency sensitivity**: “Cisco zero-day” search demonstrates that stale results break trust. :contentReference[oaicite:23]{index=23}  
4) **Stateful agent**: cache status + sitrep/clustering counts show the agent is grounded in backend state. :contentReference[oaicite:24]{index=24}  
5) **Observability-first testing**: call performed with Wireshark capture over SSH to validate SIP/TLS legs. :contentReference[oaicite:25]{index=25}

---

## Artefacts produced by this run

- Whisper baseline transcript outputs (`.txt/.vtt/.srt/.json`) were generated with:
  - `whisper-cli` + `ggml-large-v3.bin` + Metal acceleration (Apple GPU) :contentReference[oaicite:26]{index=26}

> Do not commit raw transcripts to the repo unless you’re comfortable with the content living forever.
> This file is the “derived artefact” intended for sharing.

---

## Related docs

- PBX + Twilio operational notes: `RUNBOOK.md`
- Bridge internals (state machine, buffering, tool guards): `realtime-bridge/README.md`
- Repo overview: root `README.md`


## Highlighted example (≈90 seconds): ODIN live call under instrumentation

This excerpt captures a single conversational arc that demonstrates:
- real-time turn-taking
- confidence-gated tool invocation
- barge-in / interruption handling
- stateful, cache-backed responses

---

### Timeline excerpt

**00:03:10.740 – 00:03:13.780**  
**Caller** completes dialling extension `6346` (“that’s ODIN”).

> *System:* SIP call already bridged via Twilio `<Connect><Stream>` to `odin-realtime-bridge`.

---

**00:03:13.780 – 00:03:35.860**  
**ODIN (assistant)** opens with a short cyber threat SITREP and prompts for drill-down.

> *System:* Initial response created immediately after OpenAI Realtime session setup, using cached SITREP context (no backend blocking on first audio).

---

**00:03:35.860 – 00:03:54.180**  
**Caller:** asks about “Wireshark tooling”.  
**ODIN:** interprets as security news related to Wireshark; caller corrects and asks for general headlines.

> *Design note:* First-turn ambiguity is normal. No tool calls are triggered until intent stabilises.

---

**00:05:18.080 – 00:05:42.800**  
**Caller:** “Yeah, I want to look up a CVE. CVE-2025-3400.”

> *System:* Intent classified as `cve_lookup`. Confidence threshold met → tool call authorised.

---

**00:05:48.080 – 00:06:19.400**  
**ODIN:** returns structured CVE summary:
- remote exploitability
- public exploit disclosure
- CVSS score
- KEV status
- EPSS score

> *System:* Tool execution occurs only after full function arguments are received; response is deterministic and bounded.

---

**00:06:19.400 – 00:07:04.920**  
**Caller:** asks for “Cisco zero-day”.  
**ODIN:** returns results; caller judges them stale (“boring”, “old”).

> *Design note:* Demonstrates the importance of recency ranking and explicit time windows for news-style queries.

---

**00:07:12.220 – 00:07:18.840**  
**Caller:** “Hey, stop talking.”  
**ODIN:** “Got it. Pausing now.”

> *System (control plane):*
> - barge-in detected via server VAD  
> - outbound audio queue cleared  
> - in-flight response cancelled (best effort)  
> - assistant yields immediately

---

**00:07:29.840 – 00:07:38.200**  
**Caller:** “How many sitreps do you have in the past 24 hours?”  
**ODIN:** “23 sitreps.”

> *System:* Answer served directly from cached state; no live fetch.

---

**00:07:38.200 – 00:07:52.640**  
**Caller:** “How many clusters do you have?”  
**ODIN:** “11 active clusters…”

> *System:* Demonstrates stateful aggregation (clustering) exposed conversationally.

---

### Why this excerpt matters

- **Turn control is explicit:** the assistant never decides when it may speak.
- **Tooling is gated:** free-form conversation does not trigger backend calls.
- **Latency is bounded:** first audio and follow-ups are served from cache.
- **State is inspectable:** cache age, counts, and scope are surfaced on demand.
- **Testing is real:** this call was performed under live SIP/TLS capture (UDP/5060 + TCP/5061) via Wireshark over SSH.

This is representative of how ODIN behaves under normal operator use, not a scripted demo.


> _Correlated with Wireshark capture indicating a clean SIP teardown initiated upstream and relayed through the PBX._


> Supporting SIP teardown evidence is included in `docs/appendix-wireshark.md`.
