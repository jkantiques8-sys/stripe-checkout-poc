// netlify/functions/checkout-approve.js
// Approves a request and charges either:
//  - Full payment immediately for: self_service, same-day, next-day, or rush (<=2 days)
//  - Otherwise: 30% deposit now + remaining balance auto-charged the day before drop-off
//
// Notes:
// - Uses a saved card from Checkout (mode: setup).
// - For non-rush full-service orders >= 2 days out, we create a Stripe *draft* invoice for the remaining balance.
//   That invoice is set to auto-finalize (and auto-charge) at a scheduled timestamp (day before drop-off).
// - You can edit invoice line items up until it finalizes (add/remove items), which matches your rental workflow.

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
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysBetween(a, b) {
  // whole days (b - a)
  const ms = 24 * 60 * 60 * 1000;
  return Math.floor((b.getTime() - a.getTime()) / ms);
}

/**
 * Returns a unix timestamp (seconds) for when the remaining balance should auto-charge:
 * "day before drop-off, late morning New York time-ish"
 *
 * We intentionally keep this simple: schedule at 15:00 UTC (≈ 10am ET winter / 11am ET summer).
 */
function computeAutoPayTimestamp(dropoffDate) {
  if (!dropoffDate) return null;
  const d = new Date(dropoffDate.getTime() - 24 * 60 * 60 * 1000); // day before
  d.setUTCHours(15, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function formatDatePretty(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
}

async function sendEmailApproved({
  to,
  customerName,
  flow,
  paidNowCents,
  remainingCents,
  dropoffDateStr,
  autoPayTs,
  invoiceId
}) {
  const resend = getResendClient();
  if (!resend || !process.env.FROM_EMAIL || !to) return;

  const paidNowStr = `$${centsToDollars(paidNowCents)}`;

  const isPaidInFull = !remainingCents || Number(remainingCents) <= 0;
  const remainingStr = `$${centsToDollars(remainingCents)}`;

  const dropoffPretty = dropoffDateStr ? formatDatePretty(dropoffDateStr) : '';
  const autoPayDatePretty = autoPayTs
    ? new Date(autoPayTs * 1000).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
    : '';

  const subject = "Your Kraus’ Tables & Chairs request is approved";

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#111;line-height:1.6;">
      <p>Hi ${customerName || ''},</p>
      <p>Your request has been approved.</p>

      <p><strong>Payment processed now:</strong> ${paidNowStr}</p>

      ${
        isPaidInFull
          ? `<p><strong>Remaining balance:</strong> $0.00 (paid in full)</p>`
          : `
            <p><strong>Remaining balance:</strong> ${remainingStr}${dropoffPretty ? ` (for drop-off ${dropoffPretty})` : ''}</p>
            <p>
              We will automatically charge the remaining balance
              <strong>the day before your drop-off${autoPayDatePretty ? ` (${autoPayDatePretty})` : ''}</strong>.
              If you need to make changes, reply to this email any time before then.
            </p>
            ${invoiceId ? `<p style="color:#555;font-size:12px;margin-top:12px;">(Internal ref: ${invoiceId})</p>` : ''}
          `
      }

      <p>If you have any questions, just reply to this email.</p>
      <p style="margin-top:18px;">– Kraus’ Tables &amp; Chairs</p>
    </div>
  `;

  await resend.emails.send({
    from: process.env.FROM_EMAIL,
    to,
    subject,
    html
  });
}

async function sendEmailPaymentLink({ to, customerName, amountCents, reasonLabel, paymentUrl }) {
  const resend = getResendClient();
  if (!resend || !process.env.FROM_EMAIL || !to) return;

  const amountStr = `$${centsToDollars(amountCents)}`;

  await resend.emails.send({
    from: process.env.FROM_EMAIL,
    to,
    subject: `Action needed: ${reasonLabel}`,
    html: `
      <p>Hi ${customerName || ''},</p>
      <p>We weren’t able to charge your card automatically.</p>
      <p><strong>Amount due:</strong> ${amountStr}</p>
      <p><a href="${paymentUrl}">Pay here</a></p>
      <p>If you need help, reply to this email.</p>
    `
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  // IMPORTANT: Your approve link is clicked from an email, so it will be a GET.
  // We support GET and POST.
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const qsToken = event.queryStringParameters && event.queryStringParameters.token;
    let bodyToken = null;
    if (event.body) {
      try {
        bodyToken = JSON.parse(event.body).token;
      } catch {}
    }
    const token = qsToken || bodyToken;

    if (!token) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify({ error: 'Token is required' }) };
    }

    const JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET) {
      return { statusCode: 500, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify({ error: 'Missing JWT_SECRET' }) };
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return { statusCode: 401, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify({ error: 'Invalid or expired token' }) };
    }

    const setupIntentId = decoded.setupIntentId;
    const sessionId = decoded.sessionId;

    const customerName = decoded.customerName || '';
    const customerEmail = decoded.customerEmail || '';
    const customerPhone = decoded.customerPhone || '';
    const flow = decoded.orderDetails?.flow || 'full_service';

    if (!setupIntentId || !sessionId) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify({ error: 'Missing setupIntentId or sessionId in token' }) };
    }

    // Retrieve session metadata (pricing + schedule)
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const md = session.metadata || {};

    const totalCents = Number(md.total_cents || decoded.orderDetails?.total_cents || 0);
    if (!Number.isFinite(totalCents) || totalCents <= 0) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify({ error: 'Missing or invalid total_cents' }) };
    }

    const dropoffDateStr = md.dropoff_date || decoded.orderDetails?.dropoff_date || '';
    const dropoffDate = parseYYYYMMDD(dropoffDateStr);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const daysUntilDropoff = dropoffDate ? daysBetween(today, dropoffDate) : 999;

    const rushCents = Number(md.rush_cents || 0) || 0;
    const isRush = rushCents > 0; // checkout-full defines rush if within 2 days

    // Retrieve setup intent to find saved payment method + customer
    const si = await stripe.setupIntents.retrieve(setupIntentId);
    const customerId = si.customer || decoded.customerId || session.customer;
    const paymentMethodId = si.payment_method || decoded.paymentMethodId || null;

    if (!customerId || !paymentMethodId) {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({ error: 'Missing customer or payment method on SetupIntent' })
      };
    }

    // --- Decision: full pay now vs deposit now ---
    // Policy:
    // - self_service: pay in full now
    // - same-day / next-day (daysUntilDropoff <= 1): pay in full now
    // - rush (within 2 days): pay in full now
    // - otherwise: 30% deposit now, remaining auto-charged day before drop-off
    const payInFullNow =
      flow === 'self_service' ||
      daysUntilDropoff <= 1 ||
      isRush;

    const depositPercent = payInFullNow ? 1.0 : 0.30;
    const paidNowCents = Math.max(0, Math.round(totalCents * depositPercent));
    const remainingCents = Math.max(0, totalCents - paidNowCents);

    // --- Charge now (off-session) ---
    let pi;
    try {
      pi = await stripe.paymentIntents.create(
        {
          amount: paidNowCents,
          currency: 'usd',
          customer: customerId,
          payment_method: paymentMethodId,
          off_session: true,
          confirm: true,
          description: payInFullNow
            ? (flow === 'self_service' ? 'Self-service rental payment' : 'Rental payment (paid in full)')
            : '30% deposit for rental request',
          metadata: {
            flow,
            checkout_session_id: sessionId,
            setup_intent_id: setupIntentId,
            dropoff_date: dropoffDateStr || '',
            kraus_paid_in_full: payInFullNow ? 'true' : 'false'
          }
        },
        { idempotencyKey: `approve_pi_${sessionId}_${paidNowCents}` }
      );
    } catch (err) {
      // Fallback: send a one-time payment link
      const paySession = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          payment_method_types: ['card'],
          customer: customerId,
          success_url: `${process.env.SITE_URL || ''}/?payment=paid`,
          cancel_url: `${process.env.SITE_URL || ''}/?payment=cancelled`,
          line_items: [
            {
              price_data: {
                currency: 'usd',
                product_data: {
                  name: payInFullNow ? 'Rental payment' : 'Deposit (30%)'
                },
                unit_amount: paidNowCents
              },
              quantity: 1
            }
          ],
          metadata: {
            flow,
            checkout_session_id: sessionId,
            setup_intent_id: setupIntentId,
            dropoff_date: dropoffDateStr || ''
          }
        },
        { idempotencyKey: `approve_paylink_${sessionId}_${paidNowCents}` }
      );

      await sendEmailPaymentLink({
        to: customerEmail,
        customerName,
        amountCents: paidNowCents,
        reasonLabel: payInFullNow ? 'Complete your payment' : 'Confirm your deposit',
        paymentUrl: paySession.url
      });

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({
          success: false,
          message: 'Auto-charge failed; payment link emailed',
          payment_url: paySession.url
        })
      };
    }

    // --- For full-service deposits: create a draft invoice for the remaining balance and schedule auto-finalize/pay ---
    let invoiceId = null;
    let autoPayTs = null;

    if (!payInFullNow && flow !== 'self_service' && remainingCents > 0 && dropoffDate) {
      autoPayTs = computeAutoPayTimestamp(dropoffDate);

      // Create the draft invoice first (exclude any existing pending invoice items on the customer)
      const invoice = await stripe.invoices.create(
        {
          customer: customerId,
          collection_method: 'charge_automatically',
          auto_advance: true,
          automatically_finalizes_at: autoPayTs, // Stripe will finalize at this time, then attempt payment
          pending_invoice_items_behavior: 'exclude',
          payment_settings: { payment_method_types: ['card'] },
          metadata: {
            kraus_flow: 'full_service',
            kraus_type: 'remaining_balance',
            checkout_session_id: sessionId,
            setup_intent_id: setupIntentId,
            deposit_payment_intent_id: pi.id,
            dropoff_date: dropoffDateStr || '',
            kraus_autopay_ts: String(autoPayTs),
            kraus_total_cents: String(totalCents),
            kraus_deposit_cents: String(paidNowCents),
            kraus_remaining_cents: String(remainingCents)
          }
        },
        { idempotencyKey: `approve_inv_${sessionId}_${remainingCents}` }
      );

      invoiceId = invoice.id;

      // Attach invoice line items directly to THIS invoice (so they're editable before finalization)
      const addLine = async (label, cents) => {
        const n = Number(cents || 0);
        if (!Number.isFinite(n) || n === 0) return;
        await stripe.invoiceItems.create({
          customer: customerId,
          invoice: invoiceId,
          currency: 'usd',
          amount: n,
          description: label
        });
      };

      await addLine('Rental items', md.products_subtotal_cents);
      await addLine('Delivery fee', md.delivery_cents);
      await addLine('Manhattan surcharge', md.congestion_cents);
      await addLine('Rush fee', md.rush_cents);
      await addLine('Drop-off time slot', md.dropoff_timeslot_cents);
      await addLine('Pickup time slot', md.pickup_timeslot_cents);
      await addLine('Extended rental', md.extended_cents);
      await addLine('Minimum order surcharge', md.min_order_cents);
      await addLine('Sales tax', md.tax_cents);

      // Credit line item for deposit already paid
      await stripe.invoiceItems.create({
        customer: customerId,
        invoice: invoiceId,
        currency: 'usd',
        amount: -paidNowCents,
        description: 'Deposit paid'
      });
    }

    // Optional SMS notification
    const twilio = getTwilioClient();
    if (twilio && customerPhone && process.env.TWILIO_PHONE_NUMBER) {
      try {
        await twilio.messages.create({
          body: `Great news${customerName ? ' ' + customerName : ''}! Your request is approved. ${
            payInFullNow ? 'Payment has been charged in full.' : 'Your 30% deposit has been charged.'
          }`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: customerPhone
        });
      } catch (e) {
        console.warn('Twilio SMS failed:', e.message);
      }
    }

    // Email customer confirmation
    await sendEmailApproved({
      to: customerEmail,
      customerName,
      flow,
      paidNowCents,
      remainingCents,
      dropoffDateStr,
      autoPayTs,
      invoiceId
    });

    // Response (JSON) — for browser clicks this will just render JSON; that's fine for now.
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({
        success: true,
        pay_in_full_now: payInFullNow,
        days_until_dropoff: daysUntilDropoff,
        payment_intent_id: pi.id,
        invoice_id: invoiceId,
        autopay_ts: autoPayTs
      })
    };
  } catch (error) {
    console.error('Approve error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: 'Failed to approve', details: error.message })
    };
  }
};
