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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    const token =
      event.queryStringParameters?.token ||
      (event.body && JSON.parse(event.body).token);

    if (!token) {
      return {
        statusCode: 400,
        headers: cors,
        body: JSON.stringify({ error: 'Token is required' }),
      };
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const setupIntentId =
      decoded.setupIntentId ||
      decoded.setup_intent ||
      decoded.setup_intent_id;

    const customerEmail = decoded.customerEmail || '';
    const customerName = decoded.customerName || '';

    if (!setupIntentId) {
      return {
        statusCode: 400,
        headers: cors,
        body: JSON.stringify({
          success: false,
          error: 'Missing setupIntentId in token payload',
          payloadKeys: Object.keys(decoded),
        }),
      };
    }

    // Retrieve SetupIntent
    const si = await stripe.setupIntents.retrieve(setupIntentId);

    // Detach saved payment method (THIS is the key step)
    if (si.payment_method) {
      await stripe.paymentMethods.detach(si.payment_method);
    }

    // Optionally cancel SetupIntent
    if (si.status !== 'canceled') {
      await stripe.setupIntents.cancel(setupIntentId);
    }

    // Optional email
    const resend = getResendClient();
    if (resend && customerEmail) {
      await resend.emails.send({
        from: "Kraus' Tables & Chairs <orders@kraustablesandchairs.com>",
        to: customerEmail,
        subject: 'Order Request Declined',
        html: `
          <p>Hi ${customerName || 'there'},</p>
          <p>We’re unable to proceed with your order request.</p>
          <p>Your card details were not charged and have been removed.</p>
        `,
      });
    }

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        success: true,
        message: 'SetupIntent cancelled and payment method removed',
        setupIntentId,
      }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
