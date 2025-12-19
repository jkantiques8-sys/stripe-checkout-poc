// netlify/functions/checkout-decline.js
// Decline handler for the deposit-based flow.
// - No payment has been captured at request time.
// - On decline, we simply mark the Stripe customer as declined (for reporting)
//   and (optionally) detach the saved payment method.

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
    const qsToken = event.queryStringParameters && event.queryStringParameters.token;
    let bodyToken = null;
    if (event.body) {
      try { bodyToken = JSON.parse(event.body).token; } catch {}
    }
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

    const {
      setupIntentId,
      stripeCustomerId,
      flow,
      customerName,
      customerEmail,
      customerPhone
    } = decoded;

    // Mark the customer/order as declined.
    if (stripeCustomerId) {
      try {
        await stripe.customers.update(stripeCustomerId, {
          metadata: {
            kraus_order_status: 'declined',
            kraus_invoice_sent: 'false'
          }
        });
      } catch (e) {
        console.error('Failed to update customer metadata:', e.message);
      }
    }

    // Optional: detach the payment method so it is not retained.
    // (If you prefer to keep it in case you later accept the same order, remove this block.)
    if (setupIntentId) {
      try {
        const si = await stripe.setupIntents.retrieve(setupIntentId);
        if (si && si.payment_method) {
          await stripe.paymentMethods.detach(si.payment_method);
        }
      } catch (e) {
        console.error('Failed to detach payment method (non-fatal):', e.message);
      }
    }

    // Notify customer (optional)
    const twilio = getTwilioClient();
    if (twilio && customerPhone && process.env.TWILIO_PHONE_NUMBER) {
      try {
        await twilio.messages.create({
          body: `Hi ${customerName || ''} — we’re sorry, but we can’t accommodate this request. No charge was made.`.trim(),
          from: process.env.TWILIO_PHONE_NUMBER,
          to: customerPhone
        });
      } catch (e) {
        console.error('SMS error:', e.message);
      }
    }

    const resend = getResendClient();
    if (resend && customerEmail) {
      try {
        await resend.emails.send({
          from: 'Kraus\' Tables & Chairs <orders@kraustablesandchairs.com>',
          to: customerEmail,
          subject: 'Request Update',
          html: `<p>Hi ${customerName || 'there'},</p><p>We’re sorry, but we can’t accommodate this request. No charge was made.</p>`
        });
      } catch (e) {
        console.error('Email error:', e.message);
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ success: true, message: 'Request declined (no charge)', flow: flow || null })
    };
  } catch (error) {
    console.error('Decline error:', error);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Failed to decline request', details: error.message }) };
  }
};
