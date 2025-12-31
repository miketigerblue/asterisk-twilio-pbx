# odin-realtime-bridge

WebSocket bridge used by Twilio `<Connect><Stream>` to talk to OpenAI Realtime.

## Diagrams (Mermaid)

These diagrams reflect the current implementation in `src/server.js`:

- Twilio connects to `GET /twilio/stream?token=...` (token may be missing/invalid in query).
- If query token is missing/invalid, the bridge accepts the WebSocket upgrade and later expects a valid token via Twilio Media Stream `start.customParameters`.
- Audio is **G.711 μ-law** end-to-end (`g711_ulaw`) and is paced to Twilio in ~20ms frames.
- Tool calls execute only after `response.function_call_arguments.done`.

### 1) High-level architecture

```mermaid
flowchart LR
	subgraph Twilio["Twilio Programmable Voice"]
		TCall["Phone call"]
		TFn["Twilio Function<br/>(Call Control / TwiML)"]
		TMS["Media Stream<br/>(Connect + Stream)"]
		TCall --> TFn
		TFn --> TMS
	end

	subgraph Fly["Fly.io"]
		BR["odin-realtime-bridge<br/>(Node.js WebSocket server)"]
	end

	subgraph OpenAI["OpenAI Realtime"]
		OAR["Realtime WebSocket API<br/>(model: OPENAI_REALTIME_MODEL)"]
	end

	subgraph Intel["Threat Intel Services"]
		PG["SITREP PostgREST<br/>(SITREP_BASE_URL)"]
		NX["Cyberscape Nexus<br/>(CYBERSCAPE_NEXUS_BASE_URL)"]
	end

	TMS -->|"WS /twilio/stream"| BR
	BR -->|"WS realtime"| OAR
	BR -->|"HTTP fetch sitrep"| PG
	BR -->|"HTTP semantic search"| NX
	BR -->|"GET /healthz"| HZ["Health check"]
```

### 2) Call + stream sequence (most common path)

```mermaid
sequenceDiagram
	autonumber
	participant Tw as "Twilio Media Stream"
	participant Br as "odin-realtime-bridge"
	participant Oa as "OpenAI Realtime WS"
	participant Pg as "SITREP PostgREST"
	participant Nx as "Cyberscape Nexus"

	Note over Tw,Br: Twilio connects to the bridge WebSocket endpoint
	Tw->>Br: WS upgrade GET /twilio/stream (token may be missing/invalid)
	Br-->>Tw: 101 Switching Protocols

	Note over Tw,Br: Twilio sends stream start with customParameters
	Tw->>Br: event=start (streamSid, start.customParameters.token)
	Br->>Br: verifyToken(query OR customParameters)
	Br-->>Tw: (optional) accept + begin processing media

	Note over Br,Pg: Bridge fetches sitrep context before starting OpenAI session
	Br->>Pg: GET sitrep context (cached, scheduled refresh)
	Pg-->>Br: JSON sitrep + hourly excerpts
	Br->>Br: buildSystemPrompt(agent, sitrep)

	Note over Br,Oa: OpenAI Realtime session setup
	Br->>Oa: WS connect
	Oa-->>Br: ws_open
	Br->>Oa: session.update (modalities=text+audio, g711_ulaw, server_vad, tools[])
	Br->>Oa: response.create (initial greeting + sitrep)

	par Caller audio upstream (Twilio -> OpenAI)
		loop Every 20ms-ish
			Tw->>Br: event=media (base64 g711_ulaw payload)
			Br->>Br: queueTwilioToOpenAi(payload)
			Br->>Oa: input_audio_buffer.append (payload)
		end
	and Assistant audio downstream (OpenAI -> Twilio)
		loop While assistant speaks
			Oa-->>Br: response.audio.delta (base64 g711_ulaw)
			Br->>Br: enqueueOutAudio(delta)
			Br->>Tw: event=media (paced 20ms frames)
		end
	end

	Note over Br,Oa: Tool call lifecycle (args streamed, execute at done)
	Oa-->>Br: response.function_call_arguments.delta (args chunk)
	Oa-->>Br: response.function_call_arguments.done (name + full args)
	Br->>Br: executeToolByName(name, args)
	alt semantic_search_news
		Br->>Nx: POST /semantic_search (query)
		Nx-->>Br: results
	else CVE/KEV/EPSS lookups
		Br->>Pg: GET postgrest endpoints
		Pg-->>Br: details
	end
	Br->>Oa: conversation.item.create (function_call_output)
	Note over Br,Oa: If no active response, bridge may nudge with response.create

	Note over Br,Oa: Barge-in: server VAD starts/stops
	Oa-->>Br: input_audio_buffer.speech_started
	Br->>Br: debounce + clearOutAudio + suppress playback window
	Br->>Oa: response.cancel (best-effort)
	Oa-->>Br: input_audio_buffer.speech_stopped
	Note over Br,Oa: On end-of-speech, OpenAI may auto-create a response

	Tw-->>Br: event=stop
	Br-->>Oa: ws_close
	Br-->>Tw: ws_close
```

### 3) Per-call connection state (bridge-side)

```mermaid
stateDiagram-v2
	[*] --> TwilioUpgrading
	TwilioUpgrading --> TwilioConnected: "WS upgrade success"
	TwilioConnected --> AwaitingStart: "waiting for start event"
	AwaitingStart --> TokenVerified: "token verified (query OR customParameters)"
	AwaitingStart --> TokenMissingOrBad: "no valid token yet"
	TokenMissingOrBad --> TokenVerified: "start.customParameters.token verified"

	TokenVerified --> SitrepFetch: "fetchSitrepContext()"
	SitrepFetch --> OpenAIConnecting: "openAiRealtime()"
	OpenAIConnecting --> OpenAIReady: "ws_open"
	OpenAIReady --> SessionConfigured: "session.update"
	SessionConfigured --> Streaming: "Twilio media + OpenAI audio"

	Streaming --> BargeIn: "server_vad speech_started"
	BargeIn --> Streaming: "speech_stopped (resume)"

	Streaming --> Closing: "Twilio stop/close OR OpenAI close"
	BargeIn --> Closing: "disconnect"
	Closing --> [*]
```

### 4) Audio buffering + pacing + backpressure (OpenAI -> Twilio)

```mermaid
flowchart TD
	OA["OpenAI: response.audio.delta<br/>(base64 g711_ulaw)"] --> ENQ["enqueueOutAudio()<br/>Base64 decode to bytes"]
	ENQ --> Q["outAudioChunks[] + outAudioBytes"]

	Q -->|"bytes == 0 -> set outFirstAudioAtMs"| JIT["Jitter gate<br/>(min 60ms OR enough bytes)"]
	JIT --> LOOP["Timer tick every 20ms<br/>startOutSendLoop()"]

	LOOP -->|"if bargeInActive -> pause"| PAUSE["Pause playback<br/>(barge-in)"]
	LOOP --> POP["popOutFrame()<br/>160 bytes; pad 0xFF"]
	POP --> TW["Twilio: event=media<br/>(base64 160-byte frame)"]

	Q -->|"if outAudioBytes > OUT_MAX_BUFFER_BYTES"| BP["Backpressure detected<br/>set outBackpressure=true"]
	BP --> TRIM["trimOutAudioToTargetBytes()<br/>drop oldest audio to ~60% target"]
	TRIM --> Q

	LOOP -->|"if outBackpressure -> send bigger bursts"| BURST["framesToSend up to OUT_MAX_FRAMES_PER_TICK"]
	BURST --> POP
```

## Environment variables

- `OPENAI_API_KEY` (required)
- `OPENAI_REALTIME_MODEL` (optional) e.g. `gpt-realtime-2025-08-28`
- `OPENAI_VOICE` (optional) default `alloy` (voice name for realtime TTS)
- `TWILIO_STREAM_HMAC_SECRET` (required) – used to validate Twilio Stream URL tokens (must match Twilio Function `ODIN_HMAC_SECRET`)
- `SITREP_BASE_URL` (optional) defaults to `https://your-postgrest-instance.example.com`
- `CYBERSCAPE_NEXUS_BASE_URL` (optional) default `https://your-nexus-instance.example.com` (semantic news search service)
- `SITREP_WINDOW_HOURS` (optional) default `24` (agent’s default “SITREP window”)
- `SITREP_REFRESH_SECONDS` (optional) default `1800` (30 min) (scheduled refresh interval)
- `SITREP_HOURLY_HISTORY_HOURS` (optional) default `168` (cache last 7 days of hourly sitreps)
- `OUT_MAX_BUFFER_MS` (optional) default `20000` (max assistant audio buffered locally; higher reduces drops, lower improves barge-in responsiveness)
- `OUT_MAX_FRAMES_PER_TICK` (optional) default `10` (when backpressure is detected, allow larger send bursts to drain backlog and avoid trimming)
- `VAD_BARGE_IN_DEBOUNCE_MS` (optional) default `450` (debounce chatty server VAD so noisy lines don’t repeatedly clear/suppress audio)
- `TOOL_CALL_LIMIT` (optional) default `6` (max _counted_ tool calls per phone call; argument errors do not count)
- `TOOL_CALL_HARD_LIMIT` (optional) default `30` (hard cap including invalid-arg tool calls; prevents infinite loops)
- `TOOL_ARG_ERROR_LIMIT` (optional) default `3` (max argument errors per tool before we force the model to ask the caller)
- `TOOL_LOG_LEVEL` (optional) default `errors` (`none` | `errors` | `all`) — controls how much tool execution info is logged
- `TOOL_EVENT_LOG_LEVEL` (optional) default `none` (`none` | `ids` | `verbose`) — logs tool-event ID fields / argument streaming shapes from OpenAI Realtime (useful when tool calls have empty args)

## Behavior notes (important for ops)

### Tool calling reliability

OpenAI Realtime streams tool arguments in pieces. The bridge **waits for**:

- `response.function_call_arguments.done`

…before executing tools, to avoid empty/partial argument execution.

### Audio backpressure (no “cancel loop”)

If OpenAI generates audio faster-than-realtime, the bridge’s outbound queue can grow.

- When the queue exceeds `OUT_MAX_BUFFER_MS`, the bridge **trims oldest queued audio** to keep latency bounded.
- It does **not** rely on repeatedly cancelling responses (which previously could lead to “silence”).

If you see frequent `buffer_high_trim_audio` in logs, increase `OUT_MAX_BUFFER_MS` and/or `OUT_MAX_FRAMES_PER_TICK`.

## Fly deploy (manual)

From this directory:

```bash
fly launch --name odin-realtime-bridge --region lhr --no-deploy
fly secrets set OPENAI_API_KEY=... TWILIO_STREAM_HMAC_SECRET=...
fly deploy
```

### Debug logging (Fly)

Temporarily enable tool debug logging:

- `fly secrets set -a odin-realtime-bridge TOOL_LOG_LEVEL=all TOOL_EVENT_LOG_LEVEL=ids`

Revert to normal logging:

- `fly secrets set -a odin-realtime-bridge TOOL_LOG_LEVEL=errors TOOL_EVENT_LOG_LEVEL=none`

## Local run

```bash
npm install
OPENAI_API_KEY=... TWILIO_STREAM_HMAC_SECRET=... npm run dev
```

---

## Twilio call-control Functions

This repo includes example Twilio Functions for the SIP Domain “Call comes in” webhook.

### `/dial` (SIP Domain inbound)

File: `twilio-function-odin-dial.js`

- **ODIN / RIZZY**: for `sip:6346@...` and `sip:7499@...` it returns TwiML:
  - `<Connect><Stream>` to `ODIN_STREAM_URL` (with HMAC token)
- **PSTN**: for `sip:+E164@...` it returns TwiML:
  - `<Dial action="/dial-result" method="POST"><Number>+E164</Number></Dial>`

### `/dial-result` (PSTN outcome handling)

File: `twilio-function-dial-result.js`

This is the `<Dial action>` handler. It branches on `DialCallStatus` and returns per-status TwiML.

Possible `DialCallStatus` values:

- `completed`
- `busy`
- `no-answer`
- `failed`
- `canceled`

If you want different behavior (e.g. retries, voicemail, or forwarding), change the TwiML in `/dial-result`.
