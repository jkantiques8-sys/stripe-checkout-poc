// netlify/functions/checkout-approve.js
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

function centsToDollars(cents) {
  const n = Number(cents || 0);
  return (n / 100).toFixed(2);
}


function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseYYYYMMDD(s) {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function daysBetween(a, b) {
  // whole days (b - a)
  const ms = 24 * 60 * 60 * 1000;
  return Math.floor((b.getTime() - a.getTime()) / ms);
}

async function sendEmailApproved({ to, customerName, depositCents, balanceCents, dropoffDate }) {
  const resend = getResendClient();
  if (!resend || !process.env.FROM_EMAIL) return;

  const depositStr = `$${centsToDollars(depositCents)}`;
  const balanceStr = `$${centsToDollars(balanceCents)}`;

  let autopayDateStr = '';
  if (dropoffDate) {
    const [yy, mm, dd] = String(dropoffDate).split('-').map((x) => parseInt(x, 10));
    if (!Number.isNaN(yy) && !Number.isNaN(mm) && !Number.isNaN(dd)) {
      const d = new Date(Date.UTC(yy, mm - 1, dd));
      d.setUTCDate(d.getUTCDate() - 1);
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      autopayDateStr = `${y}-${m}-${day}`;
    }
  }

  const autopayLine = autopayDateStr
    ? `We will automatically charge the remaining balance the day before your drop-off (${autopayDateStr}).`
    : `We will automatically charge the remaining balance the day before your drop-off.`;

  await resend.emails.send({
    from: process.env.FROM_EMAIL,
    to,
    subject: "Your Kraus' Tables & Chairs request is approved",
    html: `
      <p>Hi ${escapeHtml(customerName || '')},</p>
      <p>Your request has been approved.</p>
      <p><strong>Deposit charged:</strong> ${depositStr}</p>
      <p><strong>Remaining balance:</strong> ${balanceStr}${dropoffDate ? ` (for drop-off ${escapeHtml(dropoffDate)})` : ''}</p>
      <p>${escapeHtml(autopayLine)}</p>
      <p>If you need to make changes, just reply to this email.</p>
      <p>— Kraus' Tables & Chairs</p>
    `
  });
}

async function sendEmailDepositPaymentLink({ to, customerName, depositCents, paymentUrl }) {
  const resend = getResendClient();
  if (!resend || !process.env.FROM_EMAIL) return;

  const depositStr = `$${centsToDollars(depositCents)}`;

  await resend.emails.send({
    from: process.env.FROM_EMAIL,
    to,
    subject: "Action needed: confirm your deposit",
    html: `
      <p>Hi ${customerName || ''},</p>
      <p>Your request has been approved, but we couldn’t charge your deposit automatically.</p>
      <p><strong>Deposit due:</strong> ${depositStr}</p>
      <p><a href="${paymentUrl}">Pay the deposit here</a>.</p>
      <p>If you need help, reply to this email.</p>
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
    const sessionId = decoded.sessionId;
    const customerName = decoded.customerName || '';
    const customerEmail = decoded.customerEmail || '';
    const customerPhone = decoded.customerPhone || '';
    const flow = decoded.orderDetails?.flow || 'full_service';

    if (!setupIntentId || !sessionId) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing setupIntentId or sessionId in token' }) };
    }

    // Retrieve session metadata (pricing + schedule)
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const md = session.metadata || {};

    const totalCents = Number(md.total_cents || decoded.orderDetails?.total_cents || 0);
    if (!Number.isFinite(totalCents) || totalCents <= 0) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing or invalid total_cents' }) };
    }

    const dropoffDateStr = md.dropoff_date || decoded.orderDetails?.dropoff_date || '';
    const dropoffDate = parseYYYYMMDD(dropoffDateStr);
    const today = new Date();
    const daysUntilDropoff = dropoffDate ? daysBetween(today, dropoffDate) : 999;

    // Retrieve setup intent to find saved payment method + customer
    const si = await stripe.setupIntents.retrieve(setupIntentId);
    const customerId = si.customer || decoded.customerId || session.customer;
    const paymentMethodId = si.payment_method;

    if (!customerId || !paymentMethodId) {
      return {
        statusCode: 409,
        headers: cors,
        body: JSON.stringify({ error: 'Missing customer or payment method on SetupIntent' })
      };
    }

    // Determine charge now: full-service = 30% deposit; self-serve = 100%
    const depositPercent = flow === 'self_service' ? 1.0 : 0.30;
    const depositCents = Math.max(0, Math.round(totalCents * depositPercent));
    const balanceCents = Math.max(0, totalCents - depositCents);

    // Charge deposit/full amount off-session
    let pi;
    try {
      pi = await stripe.paymentIntents.create({
        amount: depositCents,
        currency: 'usd',
        customer: customerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        description: flow === 'self_service'
          ? "Self-service rental payment"
          : "30% deposit for rental request",
        metadata: {
          flow,
          checkout_session_id: sessionId,
          setup_intent_id: setupIntentId,
          dropoff_date: dropoffDateStr || ''
        }
      });
    } catch (err) {
      // Fallback: send a payment link (Checkout Session)
      const paySession = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        customer: customerId,
        success_url: `${process.env.SITE_URL || ''}/?deposit=paid`,
        cancel_url: `${process.env.SITE_URL || ''}/?deposit=cancelled`,
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: { name: flow === 'self_service' ? 'Self-service rental payment' : 'Deposit (30%)' },
            unit_amount: depositCents
          },
          quantity: 1
        }],
        metadata: {
          flow,
          checkout_session_id: sessionId,
          setup_intent_id: setupIntentId,
          dropoff_date: dropoffDateStr || ''
        }
      });

      await sendEmailDepositPaymentLink({
        to: customerEmail,
        customerName,
        depositCents,
        paymentUrl: paySession.url
      });

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({
          success: false,
          message: 'Deposit charge failed; payment link emailed',
          payment_url: paySession.url
        })
      };
    }

    // If self-serve, we are done (no invoice)
    let invoiceId = null;

    if (flow !== 'self_service' && balanceCents > 0) {
      // Build invoice items for FULL total, then subtract deposit as a negative line item.
      const invoiceItems = [];

      const addLine = (label, cents) => {
        const n = Number(cents || 0);
        if (!Number.isFinite(n) || n === 0) return;
        invoiceItems.push({ label, cents: n });
      };

      addLine('Rental items', md.products_subtotal_cents);
      addLine('Delivery fee', md.delivery_cents);
      addLine('Manhattan surcharge', md.congestion_cents);
      addLine('Rush fee', md.rush_cents);
      addLine('Drop-off time slot', md.dropoff_timeslot_cents);
      addLine('Pickup time slot', md.pickup_timeslot_cents);
      addLine('Extended rental', md.extended_cents);
      addLine('Minimum order surcharge', md.min_order_cents);
      addLine('Sales tax', md.tax_cents);


// Create a draft invoice for the remaining balance and schedule autopay for the day before drop-off.
// IMPORTANT: We do NOT email a "pay now" invoice link; we only auto-charge off-session on the scheduled date.
if (balanceCents > 0) {
  // One line item for remaining balance (keep editable by you until autopay runs)
  await stripe.invoiceItems.create({
    customer: customerId,
    currency: 'usd',
    amount: balanceCents,
    description: 'Remaining balance'
  });

  // Schedule autopay: 2:00 PM UTC on the day before drop-off (≈ 9/10am in NY depending on DST)
  // This avoids midnight edge cases and keeps the charge solidly on the "day before" date.
  let autopayTs = null;
  if (dropoffDateStr) {
    const [yy, mm, dd] = dropoffDateStr.split('-').map((x) => parseInt(x, 10));
    if (!Number.isNaN(yy) && !Number.isNaN(mm) && !Number.isNaN(dd)) {
      const dropoffAtUtc = Date.UTC(yy, mm - 1, dd, 14, 0, 0); // 14:00 UTC on drop-off day
      autopayTs = Math.floor((dropoffAtUtc - 24 * 60 * 60 * 1000) / 1000); // day before
    }
  }

  // Create a draft invoice that will auto-finalize & auto-charge at autopayTs
  const invoice = await stripe.invoices.create({
    customer: customerId,
    payment_settings: { payment_method_types: ['card'] },
    collection_method: 'charge_automatically',
    auto_advance: true,
    ...(autopayTs ? { automatically_finalizes_at: autopayTs } : {}),
    metadata: {
      kraus_flow: 'full_service',
      checkout_session_id: sessionId,
      setup_intent_id: setupIntentId,
      deposit_payment_intent_id: pi.id,
      dropoff_date: dropoffDateStr || ''
    }
  });

  invoiceId = invoice.id;
}

    // Notifications (optional)
    const twilio = getTwilioClient();
    if (twilio && customerPhone && process.env.TWILIO_PHONE_NUMBER) {
      try {
        const supportEmail = process.env.FROM_EMAIL || 'orders@kraustables.com';
        await twilio.messages.create({
          body: `Your Kraus’ Tables & Chairs request is approved.

Automated text — replies aren’t monitored.
Questions? Email ${supportEmail}.`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: customerPhone
        });
      } catch (e) {
        console.warn('Twilio SMS failed:', e.message);
      }
    }

    await sendEmailApproved({
      to: customerEmail,
      customerName,
      depositCents,
      balanceCents,
      dropoffDate: dropoffDateStr,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({
        success: true,
        message: flow === 'self_service' ? 'Payment charged' : 'Deposit charged',
        payment_intent_id: pi.id,
        invoice_id: invoiceId,
      })
    };
  } catch (error) {
    console.error('Approve error:', error);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: 'Failed to approve', details: error.message })
    };
  }
};
