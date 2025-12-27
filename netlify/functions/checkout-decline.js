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
    null
  );
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    const qsToken = event.queryStringParameters?.token;
    let bodyToken = null;
    if (event.body) {
      try { bodyToken = JSON.parse(event.body).token; } catch {}
    }
    const token = qsToken || bodyToken;

    if (!token) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Token is required' }) };
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const sessionId = pickSessionId(decoded);
    const customerEmail = decoded.customerEmail || decoded.email || '';
    const customerName  = decoded.customerName  || decoded.name  || '';

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

    // 1) Retrieve session so we can find the SetupIntent / PaymentIntent if present
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // 2) Expire the Checkout session (this is the Stripe-supported way)
    // If it’s already expired/complete, Stripe will throw—so we handle that gracefully.
    let expired = null;
    try {
      expired = await stripe.checkout.sessions.expire(sessionId);
    } catch (e) {
      // If the session is already complete/expired, we don’t want a hard failure.
      // We'll continue to optional cleanup below.
      console.error('Expire session error (continuing):', e.message);
    }

    // 3) Optional cleanup: if Checkout already saved/attached a payment method, detach it
    // - setup mode: session.setup_intent points to a SetupIntent id
    // - payment mode: session.payment_intent points to a PaymentIntent id (not your current case, but safe)
    try {
      if (session.setup_intent) {
        const si = await stripe.setupIntents.retrieve(session.setup_intent);
        if (si?.payment_method) {
          await stripe.paymentMethods.detach(si.payment_method);
        }
      } else if (session.payment_intent) {
        // If you ever use payment mode in the future, you could cancel here too,
        // but we’ll avoid touching money unless you explicitly want that.
        // const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
      }
    } catch (e) {
      console.error('Optional detach cleanup error (non-fatal):', e.message);
    }

    // 4) Optional email notification
    const resend = getResendClient();
    if (resend && customerEmail) {
      try {
        await resend.emails.send({
          from: "Kraus' Tables & Chairs <orders@kraustablesandchairs.com>",
          to: customerEmail,
          subject: 'Order Request Declined',
          html: `
            <p>Hi ${customerName || 'there'},</p>
            <p>We’re unable to proceed with your order request.</p>
            <p>No charge was made, and your card details will not be kept on file.</p>
          `,
        });
      } catch (e) {
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
      }),
    };
  } catch (err) {
    console.error('Decline error:', err);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
