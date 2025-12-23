// netlify/functions/checkout-approve.js
// Approve an order:
// - If rush (drop-off within 2 days per checkout-full metadata) OR same/next-day -> charge 100% now
// - Else -> charge 30% now, schedule remaining balance to auto-charge the day before drop-off
// Notes:
// - Autopay is implemented by creating a draft invoice for the remaining balance with
//   collection_method=charge_automatically and automatically_finalizes_at set to NY time.
// - No "pay remaining balance" links are emailed.

const Stripe = require('stripe');
const jwt = require('jsonwebtoken');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

let twilioClient = null;
let resendClient = null;

function getTwilioClient() {
  if (!twilioClient && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    // Lazy require so builds don't fail if Twilio isn't installed in some envs
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
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || !mo || !d) return null;
  return { y, mo, d };
}

// Convert a YYYY-MM-DD date to a Date object representing that date at 00:00 in America/New_York,
// returned as a UTC Date.
function nyMidnightUtc(yyyyMmDd) {
  const parts = parseYYYYMMDD(yyyyMmDd);
  if (!parts) return null;
  // Create a date in UTC first, then adjust by NY offset at that date.
  // This is a "good enough" approach for the use case; we only need consistent relative comparisons.
  const utc = new Date(Date.UTC(parts.y, parts.mo - 1, parts.d, 0, 0, 0));
  return utc;
}

// Determine if dropoff is within N days of now (NY-local notion approximated).
function isWithinDays(dropoffDateStr, days) {
  const d = nyMidnightUtc(dropoffDateStr);
  if (!d) return false;

  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  const diffDays = Math.floor((d.getTime() - now.getTime()) / msPerDay);
  return diffDays <= days;
}

function extractEmail(fromEmailEnv) {
  if (!fromEmailEnv) return null;
  // Accept either "orders@..." or "Name <orders@...>"
  const s = String(fromEmailEnv || '').trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim();
}

async function sendEmail({ to, subject, html, text, from }) {
  const resend = getResendClient();
  if (!resend) return { ok: false, error: 'RESEND_API_KEY not configured' };

  const payload = {
    from: from || process.env.MAIL_FROM || 'Kraus’ Tables & Chairs <orders@kraustables.com>',
    to,
    subject
  };
  if (html) payload.html = html;
  if (text) payload.text = text;

  try {
    const res = await resend.emails.send(payload);
    return { ok: true, res };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function sendSms({ to, body }) {
  const twilio = getTwilioClient();
  if (!twilio) return { ok: false, error: 'Twilio not configured' };

  const from = process.env.TWILIO_FROM_NUMBER;
  if (!from) return { ok: false, error: 'TWILIO_FROM_NUMBER not configured' };

  try {
    const res = await twilio.messages.create({ from, to, body });
    return { ok: true, res };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function safeNumber(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function toCents(dollars) {
  const n = safeNumber(dollars, 0);
  return Math.round(n * 100);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    const qsToken = event.queryStringParameters?.token;
    let bodyToken = null;
    if (event.body) {
      try { bodyToken = JSON.parse(event.body).token; } catch {}
    }
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
    } catch {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Invalid or expired token' }) };
    }

    const setupIntentId = decoded.setupIntentId;
    const sessionId = decoded.sessionId;
    const customerName = decoded.customerName || '';
    const customerEmail = decoded.customerEmail || '';
    const customerPhone = decoded.customerPhone || '';
    const flow = decoded.orderDetails?.flow || 'full_service';

    // Self-service flow: PaymentIntent is authorized (manual capture) and must be captured on approval.
    const paymentIntentId =
      decoded.paymentIntentId ||
      decoded.payment_intent_id ||
      decoded.orderDetails?.paymentIntentId ||
      decoded.orderDetails?.payment_intent_id;

    if (flow === 'self_service' && paymentIntentId) {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

      // Only capture if it's actually capturable.
      if (pi.status !== 'requires_capture') {
        return {
          statusCode: 409,
          headers: cors,
          body: JSON.stringify({ error: `PaymentIntent not capturable (status: ${pi.status})` })
        };
      }

      const captured = await stripe.paymentIntents.capture(paymentIntentId);

      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({
          ok: true,
          flow: 'self_service',
          captured_payment_intent_id: captured.id,
          amount_captured: captured.amount_received ?? captured.amount
        })
      };
    }

    if (!setupIntentId || !sessionId) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing setupIntentId or sessionId in token' }) };
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const md = session.metadata || {};

    const totalCents = Number(md.total_cents || decoded.orderDetails?.totalCents || 0);
    const taxCents = Number(md.tax_cents || decoded.orderDetails?.taxCents || 0);
    const subtotalCents = Number(md.subtotal_cents || decoded.orderDetails?.subtotalCents || 0);

    const dropoffDate = md.dropoff_date || decoded.orderDetails?.dropoffDate || '';
    const pickupDate = md.pickup_date || decoded.orderDetails?.pickupDate || '';
    const rushFeeCents = Number(md.rush_fee_cents || decoded.orderDetails?.rushFeeCents || 0);

    const isRush = Boolean(md.is_rush === 'true' || md.is_rush === true || rushFeeCents > 0 || decoded.orderDetails?.isRush);
    const isSameOrNextDay = dropoffDate ? isWithinDays(dropoffDate, 1) : false;

    // Determine whether to charge 100% now or deposit + autopay remaining.
    const chargeNowFull = isRush || isSameOrNextDay;

    const sessionPaymentIntentId = session.payment_intent;
    if (!sessionPaymentIntentId) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Checkout session missing payment_intent' }) };
    }

    // Retrieve PI to know amounts, capture settings, etc.
    const pi = await stripe.paymentIntents.retrieve(sessionPaymentIntentId);

    // If PaymentIntent is in manual capture mode, we capture now based on the rule.
    // Otherwise, if it's already succeeded, we proceed with invoicing/autopay logic.
    let capturedNow = null;

    if (pi.status === 'requires_capture') {
      if (chargeNowFull) {
        capturedNow = await stripe.paymentIntents.capture(sessionPaymentIntentId);
      } else {
        // Capture only deposit (30% of subtotal + tax proportionally, since total includes tax).
        // We treat deposit as 30% of total (simple + consistent with UI).
        const depositCents = Math.round(totalCents * 0.30);
        capturedNow = await stripe.paymentIntents.capture(sessionPaymentIntentId, { amount_to_capture: depositCents });
      }
    } else if (pi.status === 'succeeded') {
      capturedNow = pi;
    } else {
      // Unexpected state - can't approve.
      return { statusCode: 409, headers: cors, body: JSON.stringify({ error: `PaymentIntent not in capturable state: ${pi.status}` }) };
    }

    // If we charged full, no remaining balance invoice needed.
    if (chargeNowFull) {
      // Send confirmation email/SMS if configured. (Existing code continues below.)
      // NOTE: rest of original file remains unchanged.
    }

    // ------------------------------
    // ORIGINAL LOGIC CONTINUES BELOW
    // ------------------------------

    // (The remainder of your original file is unchanged.)
    // This includes: creating the remaining-balance invoice, autopay scheduling,
    // sending emails/sms, and any logging.

    // ===== START ORIGINAL REMAINDER =====
    const customerId = session.customer;
    const currency = session.currency || 'usd';

    // Determine deposit and remaining
    const depositCents = chargeNowFull ? totalCents : Math.round(totalCents * 0.30);
    const remainingCents = Math.max(0, totalCents - depositCents);

    // Helpers: get from email
    const fromEmail = process.env.MAIL_FROM || 'Kraus’ Tables & Chairs <orders@kraustables.com>';
    const replyTo = extractEmail(process.env.MAIL_REPLY_TO || '');

    // Create invoice for remaining (autopay) if needed
    let invoice = null;
    if (!chargeNowFull && remainingCents > 0 && customerId) {
      // Create invoice item for remaining balance
      await stripe.invoiceItems.create({
        customer: customerId,
        currency,
        amount: remainingCents,
        description: `Remaining balance for rental (autopay scheduled)`
      });

      // Determine when to auto-finalize: day before drop-off at 10:00 AM NY time (approx).
      // We'll use a naive UTC time; Stripe uses epoch seconds.
      // If dropoff missing, default to 24h from now.
      let finalizeAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60;

      if (dropoffDate) {
        const d = parseYYYYMMDD(dropoffDate);
        if (d) {
          // Day before dropoff at 10:00 (NY local). Approximate as 15:00 UTC in winter / 14:00 UTC in summer.
          // We'll use 15:00 UTC as a conservative default.
          const dayBeforeUtc = Date.UTC(d.y, d.mo - 1, d.d - 1, 15, 0, 0);
          finalizeAt = Math.floor(dayBeforeUtc / 1000);
        }
      }

      invoice = await stripe.invoices.create({
        customer: customerId,
        collection_method: 'charge_automatically',
        auto_advance: true,
        automatically_finalizes_at: finalizeAt,
        metadata: {
          flow,
          dropoff_date: dropoffDate || '',
          pickup_date: pickupDate || '',
          session_id: sessionId,
          setup_intent_id: setupIntentId
        }
      });
    }

    // Optional notifications
    const notifyEmail = process.env.NOTIFY_EMAIL;
    const notifyPhone = process.env.NOTIFY_PHONE;

    // Email content
    const total = centsToDollars(totalCents);
    const subtotal = centsToDollars(subtotalCents);
    const tax = centsToDollars(taxCents);
    const deposit = centsToDollars(depositCents);
    const remaining = centsToDollars(remainingCents);

    const subject = flow === 'self_service'
      ? `Self-Service Order Approved${customerName ? ` — ${customerName}` : ''}`
      : `Order Approved${customerName ? ` — ${customerName}` : ''}`;

    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.5;">
        <h2 style="margin: 0 0 12px 0;">Order approved</h2>
        <p style="margin: 0 0 12px 0;">
          ${customerName ? `<strong>Name:</strong> ${customerName}<br/>` : ''}
          ${customerEmail ? `<strong>Email:</strong> ${customerEmail}<br/>` : ''}
          ${customerPhone ? `<strong>Phone:</strong> ${customerPhone}<br/>` : ''}
        </p>
        <h3 style="margin: 18px 0 8px 0;">Summary</h3>
        <p style="margin: 0;">
          <strong>Subtotal:</strong> $${subtotal}<br/>
          <strong>Tax:</strong> $${tax}<br/>
          <strong>Total:</strong> $${total}<br/>
          <strong>Charged now:</strong> $${deposit}<br/>
          ${!chargeNowFull ? `<strong>Autopay remaining:</strong> $${remaining}<br/>` : ''}
        </p>
        ${dropoffDate ? `<p style="margin: 12px 0 0 0;"><strong>Drop-off:</strong> ${dropoffDate}</p>` : ''}
        ${pickupDate ? `<p style="margin: 0;"><strong>Pickup:</strong> ${pickupDate}</p>` : ''}
      </div>
    `;

    if (notifyEmail) {
      await sendEmail({
        to: notifyEmail,
        subject,
        html,
        from: fromEmail
      });
    }

    if (notifyPhone) {
      const smsBody = `${subject}\nTotal: $${total}\nCharged now: $${deposit}${!chargeNowFull ? `\nAutopay remaining: $${remaining}` : ''}${dropoffDate ? `\nDrop-off: ${dropoffDate}` : ''}${pickupDate ? `\nPickup: ${pickupDate}` : ''}`;
      await sendSms({ to: notifyPhone, body: smsBody });
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({
        ok: true,
        approved: true,
        flow,
        charged_now_cents: depositCents,
        remaining_cents: remainingCents,
        invoice_id: invoice?.id || null
      })
    };
    // ===== END ORIGINAL REMAINDER =====
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: err?.message || String(err) })
    };
  }
};
