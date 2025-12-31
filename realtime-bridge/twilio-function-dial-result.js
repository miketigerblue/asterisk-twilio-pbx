/**
 * Twilio Function: /dial-result
 *
 * This is the <Dial action="..."> callback for the PSTN route.
 * Twilio will make an HTTP request here after the <Dial> verb ends.
 *
 * `DialCallStatus` values:
 *   - completed
 *   - busy
 *   - no-answer
 *   - failed
 *   - canceled
 *
 * Docs: https://www.twilio.com/docs/voice/twiml/dial#dial-status-callback
 */

exports.handler = function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();

  // Twilio posts these parameters to the action URL.
  const status = (event.DialCallStatus || '').toString().toLowerCase();

  switch (status) {
    case 'completed':
      // The callee answered and the call bridged; when the bridged call ends,
      // Twilio will request this action URL. Usually you just hang up.
      twiml.hangup();
      break;
    case 'busy':
      twiml.say('The number you dialed is busy. Please try again later.');
      break;
    case 'no-answer':
      twiml.say('No answer. Please try again later.');
      break;
    case 'canceled':
      twiml.say('The call was canceled.');
      break;
    case 'failed':
    default:
      // Includes explicit 'failed' and any unexpected value.
      twiml.say('The call could not be completed. Please try again later.');
      break;
  }

  return callback(null, twiml);
};

