// netlify/functions/checkout-decline.js
const Stripe = require('stripe');
const jwt = require('jsonwebtoken');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

let twilioClient = null;
let resendClient = null;

function getTwilioClient() {
  if (!twilioClient && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    const twilio = require('twilio');
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return twilioClient;
}

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
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
};

async function sendEmailDeclined({ to, customerName }) {
  const resend = getResendClient();
  if (!resend || !process.env.FROM_EMAIL) return;

  await resend.emails.send({
    from: process.env.FROM_EMAIL,
    to,
    subject: "Update on your Kraus' Tables & Chairs request",
    html: `
      <p>Hi ${customerName || ''},</p>
      <p>Thanks for your request. Unfortunately we’re unable to fulfill it for the dates/details requested.</p>
      <p><strong>No charges were made.</strong></p>
      <p>If you’d like, reply with alternate dates and we’ll take another look.</p>
    `
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    const qsToken = event.queryStringParameters && event.queryStringParameters.token;
    let bodyToken = null;
    if (event.body) { try { bodyToken = JSON.parse(event.body).token; } catch {} }
    const token = qsToken || bodyToken;

    if (!token) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Token is required' }) };
    }

    const JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Missing JWT_SECRET' }) };
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Invalid or expired token' }) };
    }

    const setupIntentId = decoded.setupIntentId;
    const customerName = decoded.customerName || '';
    const customerEmail = decoded.customerEmail || '';
    const customerPhone = decoded.customerPhone || '';

    if (setupIntentId) {
      try {
        // Cancel the SetupIntent (releases card-on-file setup)
        await stripe.setupIntents.cancel(setupIntentId);
      } catch (e) {
        // Not fatal; SetupIntent may already be succeeded/cannot cancel in some states
        console.warn('SetupIntent cancel failed:', e.message);
      }
    }

    const twilio = getTwilioClient();
    if (twilio && customerPhone && process.env.TWILIO_PHONE_NUMBER) {
      try {
        await twilio.messages.create({
          body: `Hi${customerName ? ' ' + customerName : ''} — we’re unable to fulfill your request. No charges were made.`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: customerPhone
        });
      } catch (e) {
        console.warn('Twilio SMS failed:', e.message);
      }
    }

    await sendEmailDeclined({ to: customerEmail, customerName });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ success: true, message: 'Request declined (no charges made)' })
    };
  } catch (error) {
    console.error('Decline error:', error);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: 'Failed to decline', details: error.message })
    };
  }
};
