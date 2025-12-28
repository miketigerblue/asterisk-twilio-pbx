/**
 * Twilio Function: /dial
 *
 * Supports routes:
 *  1) PSTN: dial sip:+E164@<domain> -> returns TwiML <Dial><Number>
 *  2) ODIN:  dial sip:6346@<domain> -> returns TwiML <Connect><Stream>
 *  3) RIZZY: dial sip:7499@<domain> -> returns TwiML <Connect><Stream>
 *
 * Configure in Twilio Console:
 * Voice -> Manage -> SIP Domains -> <your domain> -> Call Control Configuration
 *   A CALL COMES IN: Webhook
 *   URL: https://<your-runtime>.twil.io/dial
 *
 * Environment variables (Twilio Functions -> Settings -> Environment Variables):
 *  - ODIN_STREAM_URL: e.g. wss://odin-realtime-bridge.fly.dev/twilio/stream
 *  - ODIN_HMAC_SECRET: shared secret used to sign stream tokens
 *  - ODIN_TOKEN_TTL_SECONDS: optional, default 300
 *  - TWILIO_CALLERID: optional; your Twilio/verified caller ID in E.164
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

function extractE164(to) {
  const rawTo = (to || '').toString();
  const match = rawTo.match(/\+\d+/);
  return match ? match[0] : null;
}

function getAgent(to) {
  const rawTo = (to || '').toString().toLowerCase();
  // Typical inbound To for SIP Domain: "sip:6346@yourdomain.sip.twilio.com"
  if (rawTo.includes('sip:6346@')) return 'odin';
  if (rawTo.includes('sip:7499@')) return 'rizzy';
  return null;
}

exports.handler = function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();

  // ODIN / RIZZY route
  const agent = getAgent(event.To);
  if (agent) {
    const streamUrl = context.ODIN_STREAM_URL;
    const secret = context.ODIN_HMAC_SECRET;
    const ttl = parseInt(context.ODIN_TOKEN_TTL_SECONDS || '300', 10);

    if (!streamUrl || !secret) {
      twiml.say('Voice agent is not configured');
      return callback(null, twiml);
    }

    const now = Math.floor(Date.now() / 1000);
    const token = buildToken(secret, {
      exp: now + ttl,
      callSid: event.CallSid,
      agent,
    });

    // Build a robust Stream URL even if ODIN_STREAM_URL already contains query params.
    // IMPORTANT: ODIN_STREAM_URL should normally be set to something like:
    //   wss://odin-realtime-bridge.fly.dev/twilio/stream
    // (no token included). But this will safely handle existing "?foo=bar" too.
    const u = new URL(streamUrl);
    u.searchParams.set('token', token);

    const connect = twiml.connect();
    const stream = connect.stream({ url: u.toString() });

    // Send the token redundantly as a Twilio Media Streams Parameter so it arrives
    // in the `start` event as `start.customParameters.token`.
    // This makes auth resilient even if querystrings are stripped/mangled.
    stream.parameter({ name: 'token', value: token });
    stream.parameter({ name: 'agent', value: agent });
    stream.parameter({ name: 'callSid', value: event.CallSid });

    return callback(null, twiml);
  }

  // PSTN route (existing behaviour)
  const toNumber = extractE164(event.To);
  if (!toNumber) {
    twiml.say('No destination number found');
    return callback(null, twiml);
  }

  const callerId = (context.TWILIO_CALLERID || '').toString();
  const dial = twiml.dial(callerId ? { callerId } : undefined);
  dial.number(toNumber);

  return callback(null, twiml);
};
