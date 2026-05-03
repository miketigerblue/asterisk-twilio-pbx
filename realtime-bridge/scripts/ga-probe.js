// GA Realtime API probe.
//
// Connects once with the beta header REMOVED, sends a candidate GA-shaped
// session.update, and logs every server event for 8 seconds. Used to verify
// the exact field names/shapes the GA endpoint accepts before migrating the
// production bridge.
//
// Run: OPENAI_API_KEY=... node scripts/ga-probe.js
//
// Env overrides:
//   OPENAI_REALTIME_MODEL    default gpt-realtime-1.5
//   OPENAI_VOICE             default marin
//   PROBE_AUDIO_FORMAT       default audio/pcmu  (try g711_ulaw if rejected)
//   PROBE_DURATION_MS        default 8000
//   OPENAI_NOISE_REDUCTION   default near_field  (set to "none" to send null / disable)
//   OPENAI_OUTPUT_SPEED      unset by default    (e.g. 0.95 to test)

import WebSocket from 'ws';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY required');
  process.exit(1);
}

const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-1.5';
const VOICE = process.env.OPENAI_VOICE || 'marin';
const AUDIO_FORMAT = process.env.PROBE_AUDIO_FORMAT || 'audio/pcmu';
const DURATION_MS = parseInt(process.env.PROBE_DURATION_MS || '8000', 10);

const NOISE_REDUCTION_RAW = (process.env.OPENAI_NOISE_REDUCTION || 'near_field').toLowerCase();
const NOISE_REDUCTION =
  NOISE_REDUCTION_RAW === 'none' || NOISE_REDUCTION_RAW === '' ? null : { type: NOISE_REDUCTION_RAW };

const OUTPUT_SPEED = process.env.OPENAI_OUTPUT_SPEED ? parseFloat(process.env.OPENAI_OUTPUT_SPEED) : null;

const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;

console.log('[probe] connecting', {
  url,
  model: MODEL,
  voice: VOICE,
  audio_format: AUDIO_FORMAT,
  noise_reduction: NOISE_REDUCTION,
  output_speed: OUTPUT_SPEED,
});

const ws = new WebSocket(url, {
  headers: {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    // NOTE: deliberately omitting OpenAI-Beta: realtime=v1 — that's the point.
  },
});

const sessionUpdate = {
  type: 'session.update',
  session: {
    type: 'realtime',
    model: MODEL,
    output_modalities: ['audio'],
    instructions: 'You are a probe target. Do not speak unless asked.',
    audio: {
      input: {
        format: { type: AUDIO_FORMAT },
        noise_reduction: NOISE_REDUCTION,
        turn_detection: {
          type: 'server_vad',
          interrupt_response: true,
          create_response: true,
        },
        transcription: {
          model: 'gpt-4o-transcribe',
          language: 'en',
        },
      },
      output: {
        format: { type: AUDIO_FORMAT },
        voice: VOICE,
        ...(OUTPUT_SPEED ? { speed: OUTPUT_SPEED } : {}),
      },
    },
  },
};

const eventCounts = new Map();

ws.on('open', () => {
  console.log('[probe] open — sending session.update');
  console.log('[probe] session.update payload:', JSON.stringify(sessionUpdate, null, 2));
  ws.send(JSON.stringify(sessionUpdate));

  setTimeout(() => {
    console.log('[probe] duration elapsed — closing');
    console.log('[probe] event counts:', Object.fromEntries(eventCounts));
    ws.close();
    process.exit(0);
  }, DURATION_MS);
});

ws.on('message', (data) => {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    console.log('[probe][raw]', data.toString().slice(0, 200));
    return;
  }

  const type = msg.type || '<no-type>';
  eventCounts.set(type, (eventCounts.get(type) || 0) + 1);

  // Print full body for the events that matter for migration verification.
  // Truncate audio payloads so the log stays readable.
  const redacted = JSON.parse(JSON.stringify(msg));
  if (redacted.delta && typeof redacted.delta === 'string' && redacted.delta.length > 80) {
    redacted.delta = `<${redacted.delta.length}b base64>`;
  }
  if (redacted.audio && typeof redacted.audio === 'string' && redacted.audio.length > 80) {
    redacted.audio = `<${redacted.audio.length}b base64>`;
  }

  console.log('[event]', type, JSON.stringify(redacted));
});

ws.on('error', (err) => {
  console.error('[probe] ws error', err.message);
});

ws.on('close', (code, reason) => {
  console.log('[probe] closed', { code, reason: reason?.toString() });
});

process.on('SIGINT', () => {
  console.log('[probe] sigint — closing');
  ws.close();
  process.exit(0);
});
