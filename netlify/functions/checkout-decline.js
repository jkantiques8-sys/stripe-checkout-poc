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

function pickPaymentIntentId(decoded) {
  return (
    decoded.paymentIntentId ||
    decoded.intent ||
    decoded.payment_intent ||
    decoded.payment_intent_id ||
    decoded.paymentIntent ||
    decoded.pi ||
    null
  );
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // token via GET ?token= or POST body
    const qsToken = event.queryStringParameters?.token;
    let bodyToken = null;
    if (event.body) {
      try {
        bodyToken = JSON.parse(event.body).token;
      } catch {}
    }
    const token = qsToken || bodyToken;

    if (!token) {
      return {
        statusCode: 400,
        headers: cors,
        body: JSON.stringify({ error: 'Token is required' }),
      };
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return {
        statusCode: 401,
        headers: cors,
        body: JSON.stringify({ error: 'Invalid or expired token' }),
      };
    }

    const paymentIntentId = pickPaymentIntentId(decoded);
    const customerName = decoded.customerName || decoded.name || '';
    const customerEmail = decoded.customerEmail || decoded.email || '';

    // 🔒 Hard guard: never call Stripe with null intent
    if (!paymentIntentId || typeof paymentIntentId !== 'string') {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({
          success: false,
          error: 'Missing paymentIntentId in token payload',
          payloadKeys: Object.keys(decoded || {}),
        }),
      };
    }

    // Retrieve PI
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

    // Don’t cancel if already paid / processing
    if (pi.status === 'succeeded' || pi.status === 'processing') {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({
          success: false,
          error: 'Not cancelable',
          details: `PaymentIntent is ${pi.status}`,
        }),
      };
    }

    // Cancel (void authorization)
    const canceled = await stripe.paymentIntents.cancel(paymentIntentId);

    // Optional email notification
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
            <p>Your card authorization has been voided and no charge was made.</p>
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
        message: 'Payment authorization cancelled',
        paymentIntentId: canceled.id,
        status: canceled.status,
      }),
    };
  } catch (error) {
    console.error('Decline error:', error);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({
        error: 'Failed to decline payment',
        details: error.message,
      }),
    };
  }
};
