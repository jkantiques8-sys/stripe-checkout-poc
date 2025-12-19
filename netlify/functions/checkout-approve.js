// netlify/functions/checkout-approve.js
// Deposit + invoice approval handler.
//
// Request step uses Stripe Checkout (mode=setup) to securely collect a card.
// Approval charges:
//  - full_service: 30% deposit now; balance via invoice
//      * if daysUntilDropoff <= 7: invoice sent immediately, due in 1 day
//      * else: invoice scheduled for 7 days before dropoff, due in 2 days
//  - self_service: 100% now; no invoice

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

const toCents = (n) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.round(x * 100));
};

const fmtMoney = (cents) => `$${(cents / 100).toFixed(2)}`;

function parseLocalDate(dateStr) {
  // dateStr like "2025-12-31"
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(start, end) {
  if (!start || !end) return null;
  const a = new Date(start); a.setHours(0,0,0,0);
  const b = new Date(end);   b.setHours(0,0,0,0);
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

async function createAndSendBalanceInvoice({ customerId, balanceCents, dueDays, description, metadata }) {
  if (balanceCents <= 0) return null;

  // Create invoice item (balance only)
  await stripe.invoiceItems.create({
    customer: customerId,
    currency: 'usd',
    amount: balanceCents,
    description: description || 'Remaining balance'
  });

  // Create invoice
  let invoice = await stripe.invoices.create({
    customer: customerId,
    collection_method: 'send_invoice',
    days_until_due: dueDays,
    auto_advance: false,
    description: description || undefined,
    metadata: metadata || undefined
  });

  // Finalize and send
  invoice = await stripe.invoices.finalizeInvoice(invoice.id);
  invoice = await stripe.invoices.sendInvoice(invoice.id);
  return invoice;
}

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
    } catch {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Invalid or expired token' }) };
    }

    const {
      setupIntentId,
      stripeCustomerId,
      flow,
      customerName,
      customerEmail,
      customerPhone,
      orderDetails = {}
    } = decoded;

    if (!setupIntentId || !stripeCustomerId) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing setupIntentId or stripeCustomerId in token' }) };
    }

    // Retrieve saved payment method
    const si = await stripe.setupIntents.retrieve(setupIntentId);
    const paymentMethodId = si.payment_method;
    if (!paymentMethodId) {
      return { statusCode: 409, headers: cors, body: JSON.stringify({ error: 'No payment method found on SetupIntent' }) };
    }

    // Attach + set default (safe if already attached)
    try {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: stripeCustomerId });
    } catch (e) {
      // Ignore "already attached" / "belongs to customer"
      const msg = String(e && e.message || '');
      if (!msg.toLowerCase().includes('already') && !msg.toLowerCase().includes('belongs')) {
        throw e;
      }
    }

    await stripe.customers.update(stripeCustomerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
      metadata: {
        kraus_order_status: 'approved',
        kraus_flow: flow || orderDetails.flow || 'unknown'
      }
    });

    const totalCents = toCents(orderDetails.totalNumber || orderDetails.total || 0);
    if (totalCents <= 0) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Order total is missing or invalid' }) };
    }

    const isSelf = (flow || orderDetails.flow) === 'self_service';

    // Amount to charge now
    const chargeNowCents = isSelf ? totalCents : Math.round(totalCents * 0.30);
    const balanceCents = Math.max(0, totalCents - chargeNowCents);

    // Charge now (off-session)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: chargeNowCents,
      currency: 'usd',
      customer: stripeCustomerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      description: isSelf ? 'Kraus self-service rental (approved)' : 'Kraus full-service deposit (approved)',
      metadata: {
        kraus_flow: (flow || orderDetails.flow || ''),
        kraus_type: isSelf ? 'self_full' : 'full_deposit',
        kraus_total_cents: String(totalCents),
        kraus_balance_cents: String(balanceCents),
        dropoff_date: orderDetails.dropoffDate || ''
      }
    });

    // Invoice logic (full-service only)
    let invoice = null;
    let invoiceMode = null;

    if (!isSelf && balanceCents > 0) {
      const now = new Date(); now.setHours(0,0,0,0);
      const drop = parseLocalDate(orderDetails.dropoffDate);
      const dUntil = drop ? daysBetween(now, drop) : null;

      if (dUntil !== null && dUntil <= 7) {
        // Send immediately, due in 1 day
        invoiceMode = 'sent_immediately';
        invoice = await createAndSendBalanceInvoice({
          customerId: stripeCustomerId,
          balanceCents,
          dueDays: 1,
          description: 'Remaining balance for your Kraus full-service rental',
          metadata: {
            kraus_flow: 'full_service',
            kraus_invoice_kind: 'balance',
            kraus_total_cents: String(totalCents),
            kraus_deposit_cents: String(chargeNowCents),
            kraus_balance_cents: String(balanceCents),
            dropoff_date: orderDetails.dropoffDate || ''
          }
        });

        await stripe.customers.update(stripeCustomerId, {
          metadata: {
            kraus_invoice_sent: 'true',
            kraus_invoice_id: invoice ? invoice.id : '',
            kraus_invoice_send_at: '',
            kraus_invoice_due_days: '1'
          }
        });
      } else {
        // Schedule for 7 days before dropoff, due in 2 days
        invoiceMode = 'scheduled';
        let sendAt = null;
        if (drop) {
          const d = new Date(drop);
          d.setDate(d.getDate() - 7);
          d.setHours(0,0,0,0);
          sendAt = d.toISOString().slice(0,10); // YYYY-MM-DD
        }

        await stripe.customers.update(stripeCustomerId, {
          metadata: {
            kraus_invoice_sent: 'false',
            kraus_invoice_send_at: sendAt || '',
            kraus_invoice_due_days: '2',
            kraus_total_cents: String(totalCents),
            kraus_deposit_cents: String(chargeNowCents),
            kraus_balance_cents: String(balanceCents),
            kraus_dropoff_date: orderDetails.dropoffDate || ''
          }
        });
      }
    }

    // Notifications (optional)
    const twilio = getTwilioClient();
    if (twilio && customerPhone && process.env.TWILIO_PHONE_NUMBER) {
      try {
        const msg = isSelf
          ? `Hi ${customerName || ''}! Your self-service order has been approved. Your card was charged ${fmtMoney(chargeNowCents)}.`
          : `Hi ${customerName || ''}! Your request has been approved. Your deposit of ${fmtMoney(chargeNowCents)} was charged. ${invoiceMode === 'sent_immediately' ? 'Your balance invoice was sent by email.' : 'Your balance invoice will be sent closer to your delivery date.'}`;
        await twilio.messages.create({
          body: msg,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: customerPhone
        });
      } catch (e) {
        console.error('SMS error:', e.message);
      }
    }

    const resend = getResendClient();
    if (resend && customerEmail && process.env.FROM_EMAIL) {
      try {
        const subject = isSelf ? 'Order Approved – Payment Received' : 'Request Approved – Deposit Received';
        const html = isSelf
          ? `<p>Hi ${customerName || 'there'},</p><p>Your self-service order has been approved and your card was charged <strong>${fmtMoney(chargeNowCents)}</strong>.</p>`
          : `<p>Hi ${customerName || 'there'},</p><p>Your request has been approved and your deposit of <strong>${fmtMoney(chargeNowCents)}</strong> was charged.</p>${(invoiceMode === 'sent_immediately' && invoice && invoice.hosted_invoice_url) ? `<p>Your balance invoice is ready: <a href="${invoice.hosted_invoice_url}">View invoice</a></p>` : `<p>We’ll email your balance invoice closer to your drop-off date.</p>`}`
        ;
        await resend.emails.send({
          from: process.env.FROM_EMAIL,
          to: customerEmail,
          subject,
          html
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
        flow: flow || orderDetails.flow || null,
        charged_now_cents: chargeNowCents,
        balance_cents: balanceCents,
        payment_intent_id: paymentIntent.id,
        payment_intent_status: paymentIntent.status,
        invoice_id: invoice ? invoice.id : null,
        invoice_mode: invoiceMode
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
