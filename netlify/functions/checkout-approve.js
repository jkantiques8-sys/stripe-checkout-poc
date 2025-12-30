// netlify/functions/checkout-approve.js
// Approve an order:
// - SELF SERVICE: capture the existing PaymentIntent from Checkout (authorization -> capture on approval)
// - FULL SERVICE: charge deposit/full now via SetupIntent + optional autopay invoice for remaining balance

const Stripe = require('stripe');
const jwt = require('jsonwebtoken');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });


// --- KRAUS: NY date helpers (server-authoritative) ---
function nyTodayYMD() {
  // Returns YYYY-MM-DD for "today" in America/New_York
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
function parseNYDate(ymd) {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(ymd || "").trim())) return null;
  const [y, m, d] = String(ymd).trim().split("-").map(Number);
  return { y, m, d };
}
function compareYMD(a, b) {
  if (!a || !b) return null;
  if (a.y !== b.y) return a.y < b.y ? -1 : 1;
  if (a.m !== b.m) return a.m < b.m ? -1 : 1;
  if (a.d !== b.d) return a.d < b.d ? -1 : 1;
  return 0;
}
function dayDiffNY(a, b) {
  // Whole calendar-day difference between two {y,m,d} dates
  if (!a || !b) return null;
  const da = Date.UTC(a.y, a.m - 1, a.d);
  const db = Date.UTC(b.y, b.m - 1, b.d);
  return Math.round((db - da) / 86400000);
}

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
  const ms = 24 * 60 * 60 * 1000;
  return Math.floor((b.getTime() - a.getTime()) / ms);
}

// Returns offset minutes for America/New_York at a given UTC Date.
// Example: -300 for EST, -240 for EDT.
function nyOffsetMinutes(atDateUtc) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      timeZoneName: 'shortOffset',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    const parts = fmt.formatToParts(atDateUtc);
    const tz = parts.find(p => p.type === 'timeZoneName')?.value || '';
    // tz looks like "GMT-5" or "GMT-04:00"
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tz);
    if (!m) return -300; // safe default (EST)
    const sign = m[1] === '-' ? -1 : 1;
    const hh = Number(m[2] || 0);
    const mm = Number(m[3] || 0);
    return sign * (hh * 60 + mm);
  } catch {
    return -300;
  }
}

// Build a UTC Date for a specific local NY time on a YYYY-MM-DD day.
function nyLocalToUtc(yyyyMmDd, hour24 = 10, minute = 0) {
  const base = new Date(`${yyyyMmDd}T${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  const offsetMin = nyOffsetMinutes(base);
  return new Date(base.getTime() - offsetMin * 60 * 1000);
}

async function sendEmailApproved({ to, customerName, paidNowCents, balanceCents, dropoffDateStr }) {
  const resend = getResendClient();
  const from = process.env.FROM_EMAIL;
  if (!resend || !from || !to) return;

  const paidNowStr = `$${centsToDollars(paidNowCents)}`;
  const balanceStr = `$${centsToDollars(balanceCents)}`;

  const balanceLine = balanceCents > 0
    ? `<p><strong>Remaining balance:</strong> ${balanceStr}${dropoffDateStr ? ` (for drop-off ${dropoffDateStr})` : ''}</p>
       <p>We will automatically charge the remaining balance the day before your delivery.</p>`
    : `<p><strong>Remaining balance:</strong> $0.00 (paid in full)</p>`;

  await resend.emails.send({
    from,
    to,
    subject: "Your event rental request is approved",
    html: `
      <p>Hi ${customerName || ''},</p>
      <p>Your request has been approved.</p>
      <p><strong>${balanceCents > 0 ? 'Deposit charged:' : 'Payment charged:'}</strong> ${paidNowStr}</p>
      ${balanceLine}
      <p>If you have any questions, just reply to this email.</p>
    `
  });
}

async function sendOwnerSms({ body }) {
  const client = getTwilioClient();
  if (!client) return;
  const to = process.env.OWNER_SMS_TO;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!to || !from) return;
  await client.messages.create({ to, from, body });
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

    const sessionId = decoded.sessionId;
    if (!sessionId) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing sessionId in token' }) };
    }

    const customerName = decoded.customerName || '';
    const customerEmail = decoded.customerEmail || '';
    const customerPhone = decoded.customerPhone || '';

    // Always retrieve the session; we use it to determine flow + amounts safely
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const md = session.metadata || {};

    // Flow: token wins, else checkout metadata wins, else default
    const flow = decoded.orderDetails?.flow || md.flow || 'full_service';

    // Total cents:
    // - prefer metadata.total_cents
    // - else token orderDetails.total_cents
    // - else Stripe session.amount_total
    const totalCents = Number(
      md.total_cents ||
      decoded.orderDetails?.total_cents ||
      session.amount_total ||
      0
    );

    if (!Number.isFinite(totalCents) || totalCents <= 0) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing or invalid total_cents' }) };
    }

    // --- Minimal money sanity checks (prevents rare drift between token/metadata and Stripe) ---
    const sessionAmountCents = Number(session.amount_total || 0);
    const mdTotalCents = md.total_cents ? Number(md.total_cents) : null;
    const tokenTotalCents = decoded.orderDetails?.total_cents ? Number(decoded.orderDetails.total_cents) : null;

    const mismatch = (a, b) =>
      Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0 && a !== b;

    if (mismatch(mdTotalCents, sessionAmountCents)) {
      console.error('[ALERT] total_cents mismatch (metadata vs session.amount_total):', {
        mdTotalCents,
        sessionAmountCents,
        sessionId
      });
      return {
        statusCode: 409,
        headers: cors,
        body: JSON.stringify({ error: 'Amount mismatch (metadata vs Stripe session). Please refresh and try again.' })
      };
    }

    if (mismatch(tokenTotalCents, sessionAmountCents)) {
      console.error('[ALERT] total_cents mismatch (token vs session.amount_total):', {
        tokenTotalCents,
        sessionAmountCents,
        sessionId
      });
      return {
        statusCode: 409,
        headers: cors,
        body: JSON.stringify({ error: 'Amount mismatch (token vs Stripe session). Please refresh and try again.' })
      };
    }

    // -----------------------------
    // SELF SERVICE: capture PI
    // -----------------------------
    if (flow === 'self_service') {
      const paymentIntentId =
        decoded.paymentIntentId ||
        session.payment_intent ||
        null;

      if (!paymentIntentId) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing paymentIntentId for self_service approval' }) };
      }

      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

      if (sessionAmountCents && pi?.amount && pi.amount !== sessionAmountCents) {
        console.error('[ALERT] amount mismatch (PI vs session.amount_total):', {
          piAmount: pi.amount,
          sessionAmountCents,
          paymentIntentId,
          sessionId
        });
        return {
          statusCode: 409,
          headers: cors,
          body: JSON.stringify({ error: 'Amount mismatch (Stripe). Please refresh and try again.' })
        };
      }


      // If the intent was authorized (manual capture), capture it now.
      // If it's already succeeded, just treat as approved/paid.
      if (pi.status === 'requires_capture') {
        await stripe.paymentIntents.capture(paymentIntentId, {}, { idempotencyKey: `capture_${sessionId}` });
      } else if (pi.status !== 'succeeded') {
        return { statusCode: 409, headers: cors, body: JSON.stringify({ error: `PaymentIntent not capturable (status: ${pi.status})` }) };
      }

      // Use PI amount if present; fall back to totalCents
      const paidNowCents = Number(pi.amount || totalCents);

      // Email + optional owner SMS (non-blocking; do not fail approval if notifications fail)
      try {
        await sendEmailApproved({
        to: customerEmail,
        customerName,
        paidNowCents,
        balanceCents: 0,
        dropoffDateStr: ''
        });
      } catch (err) {
        console.error('[ALERT] Failed to send approval email:', err?.message || err);
      }

      if (process.env.OWNER_SMS_TO) {
        const ownerBody = [
          "Approved SELF-SERVE order:",
          customerName || customerEmail || 'Unknown customer',
          `Paid now: $${centsToDollars(paidNowCents)}`,
          `PI: ${paymentIntentId}`
        ].filter(Boolean).join(' | ');
        try {
          try {
      await sendOwnerSms({ body: ownerBody });
    } catch (err) {
      console.error('[ALERT] Failed to send owner SMS:', err?.message || err);
    }
        } catch (err) {
          console.error('[ALERT] Failed to send owner SMS:', err?.message || err);
        }
      }

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({
          ok: true,
          flow: 'self_service',
          payment_intent_id: paymentIntentId,
          paid_now_cents: paidNowCents,
          remaining_balance_cents: 0
        })
      };
    }

    // -----------------------------
    // FULL SERVICE: SetupIntent -> charge now + optional autopay invoice
    // -----------------------------
    const setupIntentId = decoded.setupIntentId || md.setup_intent_id || session.setup_intent || null;
    if (!setupIntentId) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing setupIntentId (not present in token or session)' }) };
    }

        const dropoffDateStr = String(md.dropoff_date || decoded.orderDetails?.dropoff_date || '');
    const pickupDateStr  = String(md.pickup_date  || decoded.orderDetails?.pickup_date  || '');

    const todayNY = parseNYDate(nyTodayYMD());
    const dropoffNY = parseNYDate(dropoffDateStr);
    const pickupNY  = parseNYDate(pickupDateStr);

    if (!dropoffNY) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Cannot approve: missing or invalid dropoff date' }) };
    }
    if (compareYMD(dropoffNY, todayNY) < 0) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Cannot approve: dropoff date is in the past (NY time)' }) };
    }
    if (pickupNY && compareYMD(pickupNY, dropoffNY) < 0) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Cannot approve: pickup date is before dropoff date' }) };
    }

    const daysUntilDropoff = dayDiffNY(todayNY, dropoffNY);


    const rushCents = Number(md.rush_cents || 0);
    const isRush = Number.isFinite(rushCents) && rushCents > 0;

    // Payment policy
    // - Rush OR same/next day => full pay now
    // - Else => 30% deposit now, remainder auto-charged day before drop-off
    const payInFullNow = isRush || daysUntilDropoff <= 1;
    const depositPercent = payInFullNow ? 1.0 : 0.30;
    const paidNowCents = Math.max(0, Math.round(totalCents * depositPercent));
    const balanceCents = Math.max(0, totalCents - paidNowCents);

    // Retrieve setup intent to find saved payment method + customer
    const si = await stripe.setupIntents.retrieve(setupIntentId);
    const customerId = si.customer || decoded.customerId || session.customer;
    const paymentMethodId = si.payment_method;

    if (!customerId || !paymentMethodId) {
      return { statusCode: 409, headers: cors, body: JSON.stringify({ error: 'Missing customer or payment method on SetupIntent' }) };
    }

    // Ensure PM attached + default for invoices
    try {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    } catch {
      // ignore if already attached
    }
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId }
    });

    // Charge now (deposit or full)
    const chargeDescription = payInFullNow
      ? 'Rental payment (paid in full)'
      : '30% deposit for rental request';

    const pi = await stripe.paymentIntents.create({
      amount: paidNowCents,
      currency: 'usd',
      customer: customerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      description: chargeDescription,
      metadata: {
        flow: 'full_service',
        checkout_session_id: sessionId,
        setup_intent_id: setupIntentId,
        dropoff_date: dropoffDateStr
      }
    }, { idempotencyKey: `pi_${sessionId}_${payInFullNow ? 'full' : 'deposit'}` });

    // Schedule remaining balance (draft invoice; no sending now)
    let scheduledInvoiceId = null;
    if (balanceCents > 0) {
      if (!dropoffDateStr) {
        throw new Error('Missing dropoff_date for scheduling remaining balance');
      }

      const testMinutesRaw = process.env.AUTOPAY_TEST_MINUTES;
      const testMinutes = testMinutesRaw ? parseInt(testMinutesRaw, 10) : null;

      let dayBeforeStr = null;
      let finalizeAtUtc = null;
      let autopayLabel = null;

      if (Number.isFinite(testMinutes) && testMinutes > 0) {
        finalizeAtUtc = new Date(Date.now() + testMinutes * 60 * 1000);
        autopayLabel = `TEST:+${testMinutes}min`;
      } else {
        const dropoff = parseYYYYMMDD(dropoffDateStr);
        const dayBefore = new Date(dropoff.getTime() - 24 * 60 * 60 * 1000);
        const yyyy = dayBefore.getFullYear();
        const mm = String(dayBefore.getMonth() + 1).padStart(2, '0');
        const dd = String(dayBefore.getDate()).padStart(2, '0');
        dayBeforeStr = `${yyyy}-${mm}-${dd}`;
        finalizeAtUtc = nyLocalToUtc(dayBeforeStr, 10, 0);
        autopayLabel = dayBeforeStr;
      }

      const remainingBalanceDescription =
        (Number.isFinite(testMinutes) && testMinutes > 0)
          ? `Remaining balance (TEST auto-charge in ${testMinutes} min)`
          : 'Remaining balance (auto-charged day before drop-off)';

      await stripe.invoiceItems.create({
        customer: customerId,
        currency: 'usd',
        amount: balanceCents,
        description: remainingBalanceDescription,
        metadata: {
          flow: 'full_service',
          checkout_session_id: sessionId,
          dropoff_date: dropoffDateStr
        }
      }, { idempotencyKey: `invitem_${sessionId}` });

      const inv = await stripe.invoices.create({
        customer: customerId,
        collection_method: 'charge_automatically',
        auto_advance: true,
        automatically_finalizes_at: Math.floor(finalizeAtUtc.getTime() / 1000),
        metadata: {
          flow: 'full_service',
          checkout_session_id: sessionId,
          setup_intent_id: setupIntentId,
          dropoff_date: dropoffDateStr,
          autopay_scheduled_for: autopayLabel
        }
      }, { idempotencyKey: `invoice_${sessionId}` });

      scheduledInvoiceId = inv.id;
    }

    await sendEmailApproved({
      to: customerEmail,
      customerName,
      paidNowCents,
      balanceCents,
      dropoffDateStr
    });

    if (process.env.OWNER_SMS_TO) {
      const ownerBody = [
        "Approved FULL-SERVICE order:",
        customerName || customerEmail || 'Unknown customer',
        `Paid now: $${centsToDollars(paidNowCents)}`,
        balanceCents > 0 ? `Remaining: $${centsToDollars(balanceCents)} (invoice ${scheduledInvoiceId || 'scheduled'})` : 'Paid in full',
        dropoffDateStr ? `Drop-off: ${dropoffDateStr}` : ''
      ].filter(Boolean).join(' | ');
      try {
      await sendOwnerSms({ body: ownerBody });
    } catch (err) {
      console.error('[ALERT] Failed to send owner SMS:', err?.message || err);
    }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({
        ok: true,
        flow: 'full_service',
        payment_intent_id: pi.id,
        paid_now_cents: paidNowCents,
        remaining_balance_cents: balanceCents,
        scheduled_invoice_id: scheduledInvoiceId
      })
    };
  } catch (err) {
    console.error('checkout-approve error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: err?.message || 'Internal error' })
    };
  }
};
