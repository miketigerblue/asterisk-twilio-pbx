/**
 * Twilio Function: /voicemail-status
 *
 * Recording callback for the <Record action="/voicemail-status"> path.
 *
 * It sends you an email with the recording link using SendGrid.
 *
 * Required env vars:
 *  - SENDGRID_API_KEY
 *  - VOICEMAIL_TO_EMAIL
 *  - VOICEMAIL_FROM_EMAIL
 *
 * Optional:
 *  - VOICEMAIL_SUBJECT_PREFIX (default "PBX voicemail")
 */

async function sendSendGridEmail({ apiKey, to, from, subject, text }) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from },
      subject,
      content: [{ type: 'text/plain', value: text }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sendgrid_http_${res.status}: ${body.slice(0, 300)}`);
  }
}

function extractE164OrRaw(input) {
  const raw = (input || '').toString();
  const match = raw.match(/\+\d+/);
  return match ? match[0] : raw || null;
}

exports.handler = async function voicemailStatus(context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  twiml.say('Thank you. Goodbye.');
  twiml.hangup();

  const recordingUrlBase = (event.RecordingUrl || '').toString().trim();
  const recordingSid = (event.RecordingSid || '').toString().trim();
  if (!recordingUrlBase || !recordingSid) {
    return callback(null, twiml);
  }

  const apiKey = (context.SENDGRID_API_KEY || '').toString().trim();
  const toEmail = (context.VOICEMAIL_TO_EMAIL || '').toString().trim();
  const fromEmail = (context.VOICEMAIL_FROM_EMAIL || '').toString().trim();
  const subjectPrefix = (context.VOICEMAIL_SUBJECT_PREFIX || 'PBX voicemail').toString().trim();

  if (!apiKey || !toEmail || !fromEmail) {
    console.warn('[voicemail][email_not_configured]', {
      hasApiKey: !!apiKey,
      hasTo: !!toEmail,
      hasFrom: !!fromEmail,
    });
    return callback(null, twiml);
  }

  const callSid = (event.CallSid || '').toString().trim();
  const from = extractE164OrRaw(event.From);
  const to = extractE164OrRaw(event.To);
  const duration = (event.RecordingDuration || '').toString().trim();
  const mp3Url = `${recordingUrlBase}.mp3`;

  const subject = `${subjectPrefix}: ${from || 'unknown caller'}`;
  const text = [
    'New voicemail recorded',
    '',
    `From: ${from || 'unknown'}`,
    `To: ${to || 'unknown'}`,
    `Duration: ${duration || 'unknown'} seconds`,
    `CallSid: ${callSid || 'unknown'}`,
    `RecordingSid: ${recordingSid}`,
    '',
    `MP3: ${mp3Url}`,
  ].join('\n');

  try {
    await sendSendGridEmail({ apiKey, to: toEmail, from: fromEmail, subject, text });
  } catch (err) {
    console.error('[voicemail][email_error]', err?.message || String(err));
  }

  return callback(null, twiml);
};

