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
          payloadKeys: Object.keys(decoded || {}),
        }),
      };
    }

    // Retrieve session (source of truth for customer email/name)
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    const sessionEmail = session.customer_details?.email || session.customer_email || '';
    const sessionName = session.customer_details?.name || '';

    const customerEmail = decoded.customerEmail || decoded.email || sessionEmail || '';
    const customerName = decoded.customerName || decoded.name || sessionName || '';

    // Expire the Checkout Session (Stripe-required for Checkout-created SetupIntents)
    // If it’s already complete/expired, Stripe may throw—don’t fail the whole decline.
    let expired = null;
    let expireError = null;
    try {
      expired = await stripe.checkout.sessions.expire(sessionId);
    } catch (e) {
      expireError = e.message;
      console.error('Expire session error (continuing):', e.message);
    }

    // Optional cleanup: detach any saved payment method (best-effort)
    let detachError = null;
    try {
      if (session.setup_intent) {
        const si = await stripe.setupIntents.retrieve(session.setup_intent);
        if (si?.payment_method) {
          await stripe.paymentMethods.detach(si.payment_method);
        }
      }
    } catch (e) {
      detachError = e.message;
      console.error('Optional detach cleanup error (non-fatal):', e.message);
    }

    // Email notification (with explicit diagnostics)
    let emailSent = false;
    let emailError = null;
    let emailTo = customerEmail || null;
    let resendId = null;

    const resend = getResendClient();

    // Optional debug BCC (set this in Netlify env vars temporarily)
    // Example: DECLINE_DEBUG_BCC=orders@kraustables.com
    const debugBccRaw = (process.env.DECLINE_DEBUG_BCC || '').trim();
    const debugBcc = debugBccRaw && debugBccRaw.includes('@') ? debugBccRaw : null;

    if (!process.env.RESEND_API_KEY) {
      emailError = 'RESEND_API_KEY missing in environment';
    } else if (!emailTo) {
      emailError = 'No customer email found (token + session both empty)';
    } else if (!resend) {
      emailError = 'Resend client could not initialize';
    } else {
      try {
        const subjectTag = sessionId ? sessionId.slice(-8) : 'request';
        const result = await resend.emails.send({
          from: "Kraus' Tables & Chairs <orders@kraustablesandchairs.com>",
          to: emailTo,
          ...(debugBcc ? { bcc: debugBcc } : {}),
          reply_to: "Kraus' Tables & Chairs <orders@kraustables.com>",
          subject: `Order Request Declined (${subjectTag})`,
          headers: {
            'X-Kraus-Flow': decoded.flow || decoded.flowType || 'unknown',
            'X-Kraus-SessionId': sessionId,
          },
          html: `
            <p>Hi ${customerName || 'there'},</p>
            <p>We’re unable to proceed with your order request.</p>
            <p>No charge was made, and your card details will not be kept on file.</p>
          `,
        });

        // Resend typically returns an object with an id
        resendId = result?.id || null;
        emailSent = true;
      } catch (e) {
        emailError = e.message;
        console.error('Email error:', e.message);
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
        // diagnostics you can remove later
        expireError,
        detachError,
        emailSent,
        emailTo,
        debugBccEnabled: Boolean(debugBcc),
        resendId,
        emailError,
      }),
    };
  } catch (err) {
    console.error('Decline error:', err);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ success: false, error: 'Failed to decline', details: err.message }),
    };
  }
};
