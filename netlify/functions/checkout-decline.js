// netlify/functions/checkout-decline.js
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
    let token =
      (event.queryStringParameters && event.queryStringParameters.token) ||
      (event.body && (() => { try { return JSON.parse(event.body).token; } catch { return null; } })());

    if (!token) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Token is required' }) };
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      console.error('JWT verification failed:', err.message);
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Invalid or expired token' }) };
    }

    const { paymentIntentId, customerName, customerEmail, customerPhone } = decoded;

    const paymentIntent = await stripe.paymentIntents.cancel(paymentIntentId);
    console.log(`Payment declined for ${customerName}. PI: ${paymentIntentId}`);

    const twilio = getTwilioClient();
    if (twilio && customerPhone && process.env.TWILIO_PHONE_NUMBER) {
      try {
        await twilio.messages.create({
          body: `Hi ${customerName}, we can’t accommodate your rush order at this time. Your payment hold has been released.`,
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
          subject: 'Rush Order – Unable to Accommodate',
          html: `<p>Your authorization has been voided; you will not be charged.</p>`
        });
      } catch (e) { console.error('Email error:', e.message); }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({
        success: true,
        message: 'Payment declined and cancelled',
        paymentIntentId: paymentIntent.id,
        status: paymentIntent.status
      })
    };
  } catch (error) {
    console.error('Error declining payment:', error);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Failed to decline payment', details: error.message }) };
  }
};
