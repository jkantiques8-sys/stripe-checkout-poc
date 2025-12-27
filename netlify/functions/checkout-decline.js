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

    // Email notification (uses the SAME env var as your other emails)
    const resend = getResendClient();
    const debugBccRaw = (process.env.DECLINE_DEBUG_BCC || '').trim();
    const debugBcc = debugBccRaw && debugBccRaw.includes('@') ? debugBccRaw : null;

    // ✅ Reuse your existing sender config
    // (Your pending/request emails already work with this.)
    const FROM_EMAIL_RAW = (process.env.FROM_EMAIL || '').trim();
    const fromEmail = FROM_EMAIL_RAW || "Kraus' Tables & Chairs <orders@kraustables.com>";

    // Optional: if you already have a reply-to env var, use it; otherwise default
    const REPLY_TO_RAW = (process.env.REPLY_TO_EMAIL || '').trim();
    const replyToEmail = REPLY_TO_RAW || 'orders@kraustables.com';

    let emailTo = customerEmail || null;
    let emailSent = false;
    let emailError = null;

    // Resend diagnostics
    let resendId = null;
    let resendError = null;
    let resendData = null;
    let resendRawKeys = null;

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
          from: fromEmail,
          to: emailTo,
          ...(debugBcc ? { bcc: debugBcc } : {}),
          reply_to: replyToEmail,
          subject: `Order Request Declined (${subjectTag})`,
          headers: {
            'X-Kraus-SessionId': sessionId,
          },
          html: `
            <p>Hi ${customerName || 'there'},</p>
            <p>We’re unable to proceed with your order request.</p>
            <p>No charge was made, and your card details will not be kept on file.</p>
          `,
        });

        // Normalize result shape across Resend SDK versions
        resendRawKeys = result ? Object.keys(result) : null;
        resendData = result?.data ?? null;
        resendError = result?.error ?? null;

        resendId = result?.id || result?.data?.id || null;

        if (resendError) {
          emailError =
            typeof resendError === 'string'
              ? resendError
              : (resendError.message || JSON.stringify(resendError));
          emailSent = false;
        } else if (resendId) {
          emailSent = true;
        } else {
          emailSent = false;
          emailError = 'Resend returned no id (unknown delivery state)';
        }
      } catch (e) {
        emailSent = false;
        emailError = e.message;
        console.error('Email exception:', e.message);
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

        // Stripe diagnostics
        expireError,
        detachError,

        // Email diagnostics
        fromUsed: fromEmail,
        replyToUsed: replyToEmail,
        debugBccEnabled: Boolean(debugBcc),
        emailTo,
        emailSent,
        emailError,
        resendId,
        resendError,
        resendData,
        resendRawKeys,
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
