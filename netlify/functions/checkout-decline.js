// netlify/functions/checkout-decline.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const jwt = require('jsonwebtoken');

let resendClient = null;
function getResendClient() {
  if (!resendClient && process.env.RESEND_API_KEY) {
    const { Resend } = require('resend');
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

function pickSessionId(decoded) {
  return (
    decoded.checkoutSessionId ||
    decoded.checkout_session_id ||
    decoded.sessionId ||
    decoded.session_id ||
    decoded.session ||
    decoded.checkoutSession ||
    decoded.checkout_session ||
    null
  );
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Accept token via GET ?token=... OR POST body { token }
    const qsToken = event.queryStringParameters?.token;

    let bodyToken = null;
    if (event.body) {
      try {
        bodyToken = JSON.parse(event.body).token;
      } catch (_) {}
    }

    const token = qsToken || bodyToken;
    if (!token) {
      return {
        statusCode: 400,
        headers: cors,
        body: JSON.stringify({ success: false, error: 'Token is required' }),
      };
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (_) {
      return {
        statusCode: 401,
        headers: cors,
        body: JSON.stringify({ success: false, error: 'Invalid or expired token' }),
      };
    }

    const sessionId = pickSessionId(decoded);
    if (!sessionId || typeof sessionId !== 'string') {
      return {
        statusCode: 400,
        headers: cors,
        body: JSON.stringify({
          success: false,
          error: 'Missing Checkout Session id in token payload',
          details: 'Expected a Checkout Session id like "cs_..." on decline tokens.',
        }),
      };
    }

    // Retrieve Checkout Session (authoritative source for email/name)
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    const sessionEmail =
      session.customer_details?.email ||
      session.customer_email ||
      '';

    const sessionName =
      session.customer_details?.name ||
      '';

    const customerEmail =
      decoded.customerEmail ||
      decoded.email ||
      sessionEmail ||
      '';

    const customerName =
      decoded.customerName ||
      decoded.name ||
      sessionName ||
      '';

    // Expire Checkout Session (best-effort)
    let expired = null;
    try {
      expired = await stripe.checkout.sessions.expire(sessionId);
    } catch (_) {
      // Session may already be complete; this is fine
    }

    // Detach saved payment method (best-effort)
    try {
      if (session.setup_intent) {
        const si = await stripe.setupIntents.retrieve(session.setup_intent);
        if (si?.payment_method) {
          await stripe.paymentMethods.detach(si.payment_method);
        }
      }
    } catch (_) {}

    // -------- Email (clean, normalized, production-ready) --------

    const resend = getResendClient();

    const fromEmail =
      (process.env.FROM_EMAIL || '').trim() ||
      "Kraus' Tables & Chairs <orders@kraustables.com>";

    const replyToEmail =
      (process.env.REPLY_TO_EMAIL || '').trim() ||
      'orders@kraustables.com';

    // Always BCC internal inbox for records
    const internalBcc = 'orders@kraustables.com';

    let emailSent = false;
    let emailError = null;

    if (!process.env.RESEND_API_KEY) {
      emailError = 'RESEND_API_KEY missing';
    } else if (!customerEmail) {
      emailError = 'Customer email missing';
    } else if (!resend) {
      emailError = 'Resend client not initialized';
    } else {
      const subjectTag = sessionId ? sessionId.slice(-8) : '';

      const result = await resend.emails.send({
        from: fromEmail,
        to: customerEmail,
        bcc: internalBcc,
        reply_to: replyToEmail,
        subject: subjectTag
          ? `Order Request Update (${subjectTag})`
          : 'Order Request Update',
        html: `
          <p>Hi ${customerName || 'there'},</p>

          <p>Thank you for your order request.</p>

          <p>
            Unfortunately, we’re unable to proceed with this request at this time.
            No charge was made, and your card details were not retained.
          </p>

          <p>
            If you have any questions or would like to explore alternative options,
            feel free to reply to this email.
          </p>

          <p>
            —<br />
            Kraus’ Tables &amp; Chairs
          </p>
        `,
      });

      if (result?.id || result?.data?.id) {
        emailSent = true;
      } else {
        emailError = 'Resend did not return an email id';
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({
        success: true,
        message: 'Checkout Session expired (declined)',
        sessionId,
        sessionStatus: expired?.status || session.status,
        emailSent,
        emailError,
      }),
    };
  } catch (err) {
    console.error('Decline error:', err);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({
        success: false,
        error: 'Failed to decline order',
        details: err.message,
      }),
    };
  }
};
