/**
 * Twilio Function: /inbound
 *
 * Inbound PSTN calls to your Twilio phone number.
 *
 * Behavior:
 *  - Normalize ANI (event.From) to +E.164.
 *  - Lookup ANI in allowlist (recommended: Twilio Private Asset callers.private.json).
 *  - If known: play a short greeting and route to ODIN/RIZZY via <Connect><Stream>.
 *  - If unknown: record voicemail and POST to /voicemail-status.
 *
 * Required env vars (Twilio Functions):
 *  - ODIN_STREAM_URL
 *  - ODIN_HMAC_SECRET
 *
 * Optional env vars:
 *  - ODIN_TOKEN_TTL_SECONDS (default 300)
 *  - VOICEMAIL_MAX_LENGTH_SECONDS (default 60)
 *  - CALLERS_JSON (optional inline JSON allowlist; prefer Asset)
 */

const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signHmac(secret, payloadJson) {
  return crypto.createHmac('sha256', secret).update(payloadJson).digest('hex');
}

function buildToken(secret, payload) {
  // payload: { exp: <unix seconds>, callSid: string, agent?: 'odin'|'rizzy' }
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = base64url(payloadJson);
  const sig = signHmac(secret, payloadJson);
  return `${payloadB64}.${sig}`;
}

function extractE164(input) {
  const raw = (input || '').toString();
  const match = raw.match(/\+\d+/);
  return match ? match[0] : null;
}

function safeAgent(input) {
  const a = (input || '').toString().toLowerCase();
  return a === 'rizzy' ? 'rizzy' : 'odin';
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeAssetKey(input) {
  const raw = (input || '').toString().trim();
  if (!raw) return null;
  const key = raw.startsWith('/') ? raw : `/${raw}`;
  return key;
}

function loadJsonAsset(assetKey) {
  if (!assetKey) return null;
  try {
    // Runtime is provided by Twilio Functions. In local tests/emulators it may be missing.
    if (typeof Runtime === 'undefined' || typeof Runtime.getAssets !== 'function') return null;
    const assets = Runtime.getAssets();
    const asset = assets[assetKey];
    if (!asset) return null;
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const data = require(asset.path);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function loadAllowlist(context) {
  // 1) Optional inline JSON string env var (small allowlists only)
  const inline = (context.CALLERS_JSON || '').toString().trim();
  if (inline) {
    const obj = parseJsonSafe(inline);
    if (obj && typeof obj === 'object') return obj;

    // Allow CALLERS_JSON to point at an Asset (e.g. "callers.private.json")
    // so you don't have to paste JSON into an environment variable.
    if (/\.json$/i.test(inline)) {
      const byName = loadJsonAsset(normalizeAssetKey(inline));
      if (byName) return byName;
    }
  }

  // 2) Recommended: Twilio Private Asset callers.private.json
  // Create an asset named callers.private.json and mark it as Private.
  const recommended = loadJsonAsset('/callers.private.json');
  return recommended || {};
}

function connectToAgent({ twiml, streamUrl, secret, ttlSeconds, callSid, agent, ani }) {
  const now = Math.floor(Date.now() / 1000);
  const token = buildToken(secret, {
    exp: now + ttlSeconds,
    callSid,
    agent,
  });

  const u = new URL(streamUrl);
  u.searchParams.set('token', token);

  const connect = twiml.connect();
  const stream = connect.stream({ url: u.toString() });

  // Redundant parameters (robustness: querystrings can be stripped/mangled)
  stream.parameter({ name: 'token', value: token });
  stream.parameter({ name: 'agent', value: agent });
  stream.parameter({ name: 'callSid', value: callSid });
  if (ani) stream.parameter({ name: 'ani', value: ani });
}

exports.handler = function inbound(context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();

  const streamUrl = (context.ODIN_STREAM_URL || '').toString().trim();
  const secret = (context.ODIN_HMAC_SECRET || '').toString().trim();
  const ttlSeconds = Math.max(60, parseInt(context.ODIN_TOKEN_TTL_SECONDS || '300', 10) || 300);
  const voicemailMax = Math.max(10, Math.min(300, parseInt(context.VOICEMAIL_MAX_LENGTH_SECONDS || '60', 10) || 60));

  if (!streamUrl || !secret) {
    twiml.say('Voice agent is not configured.');
    twiml.hangup();
    return callback(null, twiml);
  }

  const ani = extractE164(event.From);
  const callSid = (event.CallSid || '').toString();

  const allowlist = loadAllowlist(context);
  const callerCfg = ani ? allowlist[ani] : null;

  // Known caller (allowlist) -> greet -> route to agent
  if (callerCfg && callerCfg.route === 'agent') {
    const name = (callerCfg.name || '').toString().trim();
    const greeting = (callerCfg.greeting || '').toString().trim();
    const agent = safeAgent(callerCfg.agent);

    if (greeting) {
      twiml.say(greeting);
    } else if (name) {
      twiml.say(`Hello ${name}.`);
    } else {
      twiml.say('Hello.');
    }

    connectToAgent({ twiml, streamUrl, secret, ttlSeconds, callSid, agent, ani });
    return callback(null, twiml);
  }

  // Unknown caller -> voicemail
  twiml.say('Sorry, we do not recognize this number. Please leave a message after the beep.');
  twiml.record({
    action: '/voicemail-status',
    method: 'POST',
    playBeep: true,
    maxLength: voicemailMax,
    trim: 'trim-silence',
  });
  twiml.hangup();
  return callback(null, twiml);
};

