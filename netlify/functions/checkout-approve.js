// netlify/functions/checkout-approve.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const jwt = require('jsonwebtoken');

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
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // accept token via GET ?token=... or POST { token }
    const qsToken = event.queryStringParameters && event.queryStringParameters.token;
    let bodyToken = null;
    if (event.body) { try { bodyToken = JSON.parse(event.body).token; } catch {} }
    const token = qsToken || bodyToken;

    if (!token) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Token is required' }) };
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Invalid or expired token' }) };
    }

    const { paymentIntentId, customerName, customerEmail, customerPhone, orderDetails } = decoded;

    // ✅ STATUS GUARD: Only capture if capturable
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi.status !== 'requires_capture' || (pi.amount_capturable ?? 0) <= 0) {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({
          success: false,
          error: 'Not capturable',
          details: `PaymentIntent is ${pi.status}. Only requires_capture can be approved.`,
        }),
      };
    }

    // Capture
    const paymentIntent = await stripe.paymentIntents.capture(paymentIntentId);

    // Optional notifications
    const twilio = getTwilioClient();
    if (twilio && customerPhone && process.env.TWILIO_PHONE_NUMBER) {
      try {
        await twilio.messages.create({
          body: `Great news ${customerName}! Your rush order has been approved. ${orderDetails?.eventDate ? 'Event: ' + orderDetails.eventDate : ''}`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: customerPhone
        });
      } catch (e) { console.error('SMS error:', e.message); }
    }
    const resend = getResendClient();
    if (resend && customerEmail) {
      try {
        await resend.emails.send({
          from: 'Kraus Tables & Chairs <orders@kraustablesandchairs.com>',
          to: customerEmail,
          subject: 'Rush Order Approved',
          html: `<p>Hi ${customerName}, your payment was captured successfully.</p>`
        });
      } catch (e) { console.error('Email error:', e.message); }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({
        success: true,
        message: 'Payment captured',
        paymentIntentId: paymentIntent.id,
        status: paymentIntent.status
      })
    };
  } catch (error) {
    console.error('Approve error:', error);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Failed to capture payment', details: error.message }) };
  }
};
