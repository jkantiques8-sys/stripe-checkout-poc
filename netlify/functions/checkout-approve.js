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

async function sendEmailApproved({ to, customerName, depositCents, balanceCents, dropoffDate, invoiceHostedUrl }) {
  const resend = getResendClient();
  if (!resend || !process.env.FROM_EMAIL) return;

  const depositStr = `$${centsToDollars(depositCents)}`;
  const balanceStr = `$${centsToDollars(balanceCents)}`;
  const invoiceLine = invoiceHostedUrl
    ? `<p><a href="${invoiceHostedUrl}">Pay your remaining balance here</a>.</p>`
    : `<p>Your remaining balance will be invoiced by email.</p>`;

  await resend.emails.send({
    from: process.env.FROM_EMAIL,
    to,
    subject: "Your Kraus' Tables & Chairs request is approved",
    html: `
      <p>Hi ${customerName || ''},</p>
      <p>Your request has been approved.</p>
      <p><strong>Deposit charged:</strong> ${depositStr}</p>
      ${itemsHtml}
      ${balanceCents > 0 ? `<p><strong>Remaining balance:</strong> ${balanceStr}${dropoffDate ? ` (for drop-off ${dropoffDate})` : ''}</p>` : ''}
      ${balanceCents > 0 ? invoiceLine : '<p>No remaining balance is due.</p>'}
      <p>If you have any questions, just reply to this email.</p>
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

    // Human-readable item list (qty only), generated server-side in checkout-full
    const itemsSummary = String(md.items_summary || '').trim();
    const itemsHtml = itemsSummary
      ? `<p><strong>Requested items</strong><br/>${escapeHtml(itemsSummary).replace(/\n/g, '<br/>')}</p>`
      : '';

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
    let invoiceHostedUrl = null;
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

      // Create invoice items
      for (const it of invoiceItems) {
        await stripe.invoiceItems.create({
          customer: customerId,
          currency: 'usd',
          amount: it.cents,
          description: it.label
        });
      }

      // Negative line item for deposit already paid
      await stripe.invoiceItems.create({
        customer: customerId,
        currency: 'usd',
        amount: -depositCents,
        description: 'Deposit paid'
      });

      const shouldSendNow = daysUntilDropoff <= 7;

      const invoice = await stripe.invoices.create({
        customer: customerId,
        payment_settings: { payment_method_types: ['card'] },
        collection_method: 'send_invoice',
        days_until_due: shouldSendNow ? 1 : 2,
        auto_advance: shouldSendNow, // finalize automatically if sending now
        metadata: {
          kraus_flow: 'full_service',
          checkout_session_id: sessionId,
          setup_intent_id: setupIntentId,
          deposit_payment_intent_id: pi.id,
          dropoff_date: dropoffDateStr || '',
          kraus_send_ts: (() => {
            if (shouldSendNow) return String(Math.floor(Date.now() / 1000));
            if (!dropoffDate) return '';
            const sendDate = new Date(dropoffDate.getTime() - 7 * 24 * 60 * 60 * 1000);
            // send at 9am local-ish (server time)
            sendDate.setHours(9, 0, 0, 0);
            return String(Math.floor(sendDate.getTime() / 1000));
          })()
        }
      });

      invoiceId = invoice.id;

      if (shouldSendNow) {
        // Ensure finalized and sent
        const finalized = invoice.status === 'draft' ? await stripe.invoices.finalizeInvoice(invoice.id) : invoice;
        const sent = await stripe.invoices.sendInvoice(finalized.id);
        invoiceHostedUrl = sent.hosted_invoice_url || null;
      }
    }

    // Notifications (optional)
    const twilio = getTwilioClient();
    if (twilio && customerPhone && process.env.TWILIO_PHONE_NUMBER) {
      try {
        await twilio.messages.create({
          body: `Great news${customerName ? ' ' + customerName : ''}! Your request is approved. ${flow === 'self_service' ? 'Payment' : 'Deposit'} has been charged. Automated text—replies not monitored. Email us if needed.`,
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
      invoiceHostedUrl
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({
        success: true,
        message: flow === 'self_service' ? 'Payment charged' : 'Deposit charged',
        payment_intent_id: pi.id,
        invoice_id: invoiceId,
        invoice_hosted_url: invoiceHostedUrl
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
