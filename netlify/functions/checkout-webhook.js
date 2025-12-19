// checkout-webhooks.js
// Handles Stripe checkout.session.completed, sends owner + customer
// email notifications via Resend and an SMS alert via Twilio.

const Stripe = require('stripe');
const jwt = require('jsonwebtoken');
const twilio = require('twilio');
const { Resend } = require('resend');

// ==== Config / Clients =====================================================

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16'
});

const resend =
  process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const getTwilioClient = () => {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    return null;
  }
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
};

const SITE_URL =
  process.env.SITE_URL || 'https://enchanting-monstera-41f4df.netlify.app';

const FROM_EMAIL = process.env.FROM_EMAIL || 'orders@kraustables.com';
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'jonah@kraustables.com';
const OWNER_PHONE = process.env.OWNER_PHONE; // e.g. "+1917…"
const TWILIO_FROM = process.env.TWILIO_PHONE_NUMBER;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

// ==== Helpers ===============================================================

const asNumberOrNull = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
};

const centsToNumber = (cents) => {
  const n = asNumberOrNull(cents);
  if (n === null) return null;
  return n / 100;
};

const formatMoney = (amount) => {
  const n = asNumberOrNull(amount);
  if (n === null) return '$0.00';
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
};

// Add weekday name (Monday, Tuesday, etc.)
const formatDate = (dateStr) => {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;

  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
};

const safeTrim = (v) => (v ? String(v).trim() : '');

const formatHourRange = (value) => {
  if (!value) return null;
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(String(value).trim());
  if (!match) return null;

  const start = Number(match[1]);
  const end = Number(match[2]);

  const fmt = (h) => {
    const normalized = ((h % 24) + 24) % 24;
    const suffix = normalized >= 12 ? 'PM' : 'AM';
    const hour12 = normalized % 12 === 0 ? 12 : normalized % 12;
    return `${hour12}${suffix}`;
  };

  return `${fmt(start)}–${fmt(end)}`;
};

const formatFlexRange = (value) => {
  if (!value) return null;
  const map = {
    '8-12': '8AM–12PM',
    '12-4': '12PM–4PM',
    '4-8': '4PM–8PM'
  };
  return map[value] || null;
};

const formatTimeSlot = (value, type) => {
  if (!value) return null;

  // Flex slots are stored like "8-12", "12-4", "4-8"
  if (type === 'flex') {
    const pretty = formatFlexRange(value);
    if (pretty) return pretty;
  }

  // Prompt slots are stored like "6-7", "21-22"
  const pretty = formatHourRange(value);
  if (pretty) return pretty;

  return value;
};

const summarizeSchedule = (details) => {
  const dropoff = details.dropoffDate
    ? `${formatDate(details.dropoffDate)} (${formatTimeSlot(
        details.dropoffTimeslotValue,
        details.dropoffTimeslotType
      )})`
    : 'Not provided';

  const pickup = details.pickupDate
    ? `${formatDate(details.pickupDate)} (${formatTimeSlot(
        details.pickupTimeslotValue,
        details.pickupTimeslotType
      )})`
    : 'Not provided';

  return { dropoff, pickup };
};

const safeJsonParse = (str) => {
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
};

const joinLines = (arr) => arr.filter(Boolean).join('\n');

const buildOwnerEmailHtml = (details, approveUrl, declineUrl) => {
  const schedule = summarizeSchedule(details);

  return `
  <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; line-height: 1.45;">
    <h2 style="margin: 0 0 10px 0;">New Full Service Request</h2>
    <p style="margin: 0 0 10px 0;"><strong>Total:</strong> ${formatMoney(details.total)}</p>
    <p style="margin: 0 0 10px 0;">
      <strong>Drop-off:</strong> ${schedule.dropoff}<br />
      <strong>Pickup:</strong> ${schedule.pickup}
    </p>

    <p style="margin: 0 0 10px 0;">
      <strong>Customer:</strong> ${details.customerName || 'Not provided'}<br />
      <strong>Email:</strong> ${details.customerEmail || 'Not provided'}<br />
      <strong>Phone:</strong> ${details.customerPhone || 'Not provided'}
    </p>

    <p style="margin: 0 0 10px 0;">
      <strong>Address:</strong><br />
      ${details.street || ''} ${details.address2 || ''}<br />
      ${details.city || ''}, ${details.state || ''} ${details.zip || ''}
    </p>

    <p style="margin: 0 0 10px 0;">
      <strong>Items:</strong><br />
      ${details.itemsHtml || '<em>No items summary</em>'}
    </p>

    <p style="margin: 0 0 10px 0;">
      <a href="${approveUrl}" style="display:inline-block;padding:10px 14px;background:#2e7d32;color:#fff;text-decoration:none;border-radius:8px;margin-right:8px;">Approve</a>
      <a href="${declineUrl}" style="display:inline-block;padding:10px 14px;background:#b71c1c;color:#fff;text-decoration:none;border-radius:8px;">Decline</a>
    </p>

    <p style="margin: 0; color: #666;">(These links are time-limited.)</p>
  </div>
  `;
};

const buildCustomerEmailHtml = (details) => {
  const schedule = summarizeSchedule(details);

  return `
  <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; line-height: 1.45;">
    <h2 style="margin: 0 0 10px 0;">Full Service Request Received</h2>
    <p style="margin: 0 0 10px 0;">
      Thanks — we received your request. We typically confirm availability within <strong>2 business hours</strong>.
      No charge has been made. Your card details were saved securely.
    </p>

    <p style="margin: 0 0 10px 0;"><strong>Total:</strong> ${formatMoney(details.total)}</p>

    <p style="margin: 0 0 10px 0;">
      <strong>Drop-off:</strong> ${schedule.dropoff}<br />
      <strong>Pickup:</strong> ${schedule.pickup}
    </p>

    <p style="margin: 0;">
      If anything needs clarification or we need to confirm logistics, we’ll reach out.
    </p>
  </div>
  `;
};

const buildSelfOwnerEmailHtml = (details, approveUrl, declineUrl) => {
  const schedule = summarizeSchedule(details);

  return `
  <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; line-height: 1.45;">
    <h2 style="margin: 0 0 10px 0;">New Self Service Request</h2>
    <p style="margin: 0 0 10px 0;"><strong>Total:</strong> ${formatMoney(details.total)}</p>

    <p style="margin: 0 0 10px 0;">
      <strong>Pickup:</strong> ${schedule.pickup}<br />
      <strong>Return:</strong> ${details.returnDate ? formatDate(details.returnDate) : 'Not provided'}
    </p>

    <p style="margin: 0 0 10px 0;">
      <strong>Customer:</strong> ${details.customerName || 'Not provided'}<br />
      <strong>Email:</strong> ${details.customerEmail || 'Not provided'}<br />
      <strong>Phone:</strong> ${details.customerPhone || 'Not provided'}
    </p>

    <p style="margin: 0 0 10px 0;">
      <strong>Items:</strong><br />
      ${details.itemsHtml || '<em>No items summary</em>'}
    </p>

    <p style="margin: 0 0 10px 0;">
      <a href="${approveUrl}" style="display:inline-block;padding:10px 14px;background:#2e7d32;color:#fff;text-decoration:none;border-radius:8px;margin-right:8px;">Approve</a>
      <a href="${declineUrl}" style="display:inline-block;padding:10px 14px;background:#b71c1c;color:#fff;text-decoration:none;border-radius:8px;">Decline</a>
    </p>

    <p style="margin: 0; color: #666;">(These links are time-limited.)</p>
  </div>
  `;
};

const buildSelfCustomerEmailHtml = (details) => {
  const schedule = summarizeSchedule(details);

  return `
  <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; line-height: 1.45;">
    <h2 style="margin: 0 0 10px 0;">Self Service Request Received</h2>
    <p style="margin: 0 0 10px 0;">
      Thanks — we received your request. We typically confirm availability within <strong>2 business hours</strong>.
      No charge has been made. Your card details were saved securely.
    </p>

    <p style="margin: 0 0 10px 0;"><strong>Total:</strong> ${formatMoney(details.total)}</p>

    <p style="margin: 0 0 10px 0;">
      <strong>Pickup:</strong> ${schedule.pickup}<br />
      <strong>Return:</strong> ${details.returnDate ? formatDate(details.returnDate) : 'Not provided'}
    </p>

    <p style="margin: 0;">
      If anything needs clarification, we’ll reach out.
    </p>
  </div>
  `;
};

const parseItems = (metadata) => {
  // Full-service items may be stored in metadata.items as JSON string
  const raw = metadata.items || null;
  if (!raw) return [];
  const parsed = safeJsonParse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((it) => ({
      sku: safeTrim(it.sku),
      qty: Number(it.qty || 0) || 0,
      unit: Number(it.unit || 0) || 0,
      name: safeTrim(it.name) || safeTrim(it.sku)
    }))
    .filter((it) => it.qty > 0);
};

const itemsToHtml = (items) => {
  if (!items || !items.length) return '';
  const rows = items
    .map((it) => {
      const line = it.unit && it.qty ? (it.unit * it.qty) / 100 : null;
      return `<div>${it.qty}× ${it.name}${line != null ? ` — ${formatMoney(line)}` : ''}</div>`;
    })
    .join('');
  return rows;
};

const safeListInvoices = async (invoiceId) => {
  try {
    if (!invoiceId) return [];
    const inv = await stripe.invoices.retrieve(invoiceId);
    return inv ? [inv] : [];
  } catch (e) {
    console.warn('Could not retrieve invoice:', e.message);
    return [];
  }
};

const formatPhoneNumber = (raw) => {
  if (!raw) return null;
  const s = String(raw).trim();
  return s.startsWith('+') ? s : s; // keep as-is (Twilio requires E.164)
};

const summarizeOwnerSms = (details) => {
  const schedule = summarizeSchedule(details);
  return joinLines([
    details.flow === 'self_service' ? 'New pickup request' : 'New delivery request',
    details.total ? `Total: ${formatMoney(details.total)}` : null,
    details.customerName ? `Customer: ${details.customerName}` : null,
    `Drop-off: ${schedule.dropoff}`,
    `Pickup: ${schedule.pickup}`,
    details.returnDate ? `Return: ${details.returnDate}` : null,
    details.extraLabel ? `Extended: ${details.extraLabel}` : null
  ]);
};

// ==== Main handler ==========================================================

exports.handler = async (event, context) => {
  const sig = event.headers['stripe-signature'];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `Webhook Error: ${err.message}` })
    };
  }

  const eventType = stripeEvent.type;

  // ===========================
  // INVOICE PAID (confirmation)
  // ===========================
  if (eventType === 'invoice.paid') {
    const inv = stripeEvent.data.object;
    const md = inv.metadata || {};

    // Basic idempotency (no DB): mark invoice metadata after sending
    if (md.kraus_paid_email_sent === '1') {
      return {
        statusCode: 200,
        body: JSON.stringify({ received: true, skipped: 'already_emailed' })
      };
    }

    const amountPaid = (inv.amount_paid || 0) / 100;
    const amountDue = (inv.amount_due || 0) / 100;

    // Resolve customer email/name
    let customerEmail = inv.customer_email || null;
    let customerName = inv.customer_name || null;

    if ((!customerEmail || !customerName) && inv.customer) {
      try {
        const cust = await stripe.customers.retrieve(inv.customer);
        customerEmail = customerEmail || cust.email || null;
        customerName = customerName || cust.name || null;
      } catch (e) {
        console.warn('Could not retrieve customer for invoice.paid:', e.message);
      }
    }

    const dropoffDate = md.dropoff_date || null;
    const hostedUrl = inv.hosted_invoice_url || null;
    const invoiceNumber = inv.number || inv.id;

    if (resend) {
      const customerTo = customerEmail ? [customerEmail] : [];
      const ownerTo = OWNER_EMAIL ? [OWNER_EMAIL] : [];

      const commonLines = [
        customerName ? `Customer: ${customerName}` : null,
        customerEmail ? `Email: ${customerEmail}` : null,
        dropoffDate ? `Drop-off: ${dropoffDate}` : null,
        hostedUrl ? `Invoice link: ${hostedUrl}` : null
      ]
        .filter(Boolean)
        .join('<br>');

      const customerHtml = `
        <p>Hi ${customerName || ''},</p>
        <p>We’ve received your payment. You’re all set.</p>
        <p><strong>Amount paid:</strong> ${formatMoney(amountPaid)}</p>
        ${dropoffDate ? `<p><strong>Drop-off date:</strong> ${dropoffDate}</p>` : ''}
        ${hostedUrl ? `<p>You can view your invoice here: <a href="${hostedUrl}">${invoiceNumber}</a></p>` : ''}
        <p>If you have any questions or need to update anything, reply to this email.</p>
      `;

      const ownerHtml = `
        <p><strong>Invoice paid</strong></p>
        <p><strong>Invoice:</strong> ${invoiceNumber}</p>
        <p><strong>Amount paid:</strong> ${formatMoney(amountPaid)}<br>
           <strong>Amount due now:</strong> ${formatMoney(amountDue)}</p>
        <p>${commonLines}</p>
      `;

      try {
        if (customerTo.length) {
          await resend.emails.send({
            from: FROM_EMAIL,
            to: customerTo,
            subject: "Payment received – Kraus' Tables & Chairs",
            html: customerHtml
          });
          console.log('invoice.paid email sent to customer');
        } else {
          console.log(
            'invoice.paid: no customer email found; skipping customer email'
          );
        }

        if (ownerTo.length) {
          await resend.emails.send({
            from: FROM_EMAIL,
            to: ownerTo,
            subject: `✅ Invoice paid${customerName ? ` – ${customerName}` : ''} – ${formatMoney(amountPaid)}`,
            html: ownerHtml
          });
          console.log('invoice.paid email sent to owner');
        }
      } catch (e) {
        console.error('Error sending invoice.paid emails via Resend:', e.message);
      }
    } else {
      console.log('Resend not configured, skipping invoice.paid emails');
    }

    // Mark sent to avoid duplicates (Stripe may retry webhooks)
    try {
      await stripe.invoices.update(inv.id, {
        metadata: { ...md, kraus_paid_email_sent: '1' }
      });
    } catch (e) {
      console.warn(
        'Could not update invoice metadata for idempotency:',
        e.message
      );
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ received: true })
    };
  }

  // ===========================
  // CHECKOUT COMPLETED (request)
  // ===========================
  if (eventType !== 'checkout.session.completed') {
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  }

  const session = stripeEvent.data.object;
  console.log(`=== Processing Stripe checkout.session.completed ===`);
  console.log('Session ID:', session.id);
  console.log('Mode:', session.mode);
  console.log('Customer email:', session.customer_details?.email);

  const metadata = session.metadata || {};
  const isSelfService = metadata.flow === 'self_service';

  // Parse items for full-service
  const items = parseItems(metadata);
  const itemsHtml = itemsToHtml(items);

  // Some sessions may also reference an invoice id (if you ever add one later)
  const invoices = await safeListInvoices(session.invoice);

  const customerDetails = session.customer_details || {};

  // --- Compute line totals (numbers in dollars) ----------------------------

  let subtotalNumber,
    deliveryFeeNumber,
    rushFeeNumber,
    taxNumber,
    dropoffTimeslotFeeNumber,
    pickupTimeslotFeeNumber,
    extendedFeeNumber,
    minOrderFeeNumber;

  if (isSelfService) {
    // Self-service chairs
    subtotalNumber = centsToNumber(metadata.chairs_subtotal_cents);
    deliveryFeeNumber = null; // no delivery line
    rushFeeNumber = centsToNumber(metadata.rush_cents);
    taxNumber = centsToNumber(metadata.tax_cents);
    dropoffTimeslotFeeNumber = null;
    pickupTimeslotFeeNumber = centsToNumber(metadata.pickup_timeslot_cents);
    extendedFeeNumber = centsToNumber(metadata.extended_cents);
    minOrderFeeNumber = centsToNumber(metadata.min_order_cents);
  } else {
    // Full-service
    subtotalNumber = centsToNumber(metadata.products_subtotal_cents);
    deliveryFeeNumber = centsToNumber(metadata.delivery_cents);
    rushFeeNumber = centsToNumber(metadata.rush_cents);
    taxNumber = centsToNumber(metadata.tax_cents);
    dropoffTimeslotFeeNumber = centsToNumber(metadata.dropoff_timeslot_cents);
    pickupTimeslotFeeNumber = centsToNumber(metadata.pickup_timeslot_cents);
    extendedFeeNumber = centsToNumber(metadata.extended_cents);
    minOrderFeeNumber = centsToNumber(metadata.min_order_cents);
  }

  const totalNumber = centsToNumber(metadata.total_cents);

  // Build schedule strings
  const schedule = {
    dropoff: isSelfService
      ? null
      : formatTimeSlot(
          metadata.dropoff_timeslot_value,
          metadata.dropoff_timeslot_type
        ),
    pickup: formatTimeSlot(
      metadata.pickup_timeslot_value,
      metadata.pickup_timeslot_type
    ),
    returnDate: metadata.pickup_date ? formatDate(metadata.pickup_date) : null
  };

  // Extended label (if present)
  const extraLabel =
    extendedFeeNumber && extendedFeeNumber > 0
      ? `${formatMoney(extendedFeeNumber)}`
      : null;

  const orderDetails = {
    flow: isSelfService ? 'self_service' : 'full_service',

    // money lines (dollars)
    subtotal: subtotalNumber,
    deliveryFee: deliveryFeeNumber,
    rushFee: rushFeeNumber,
    dropoffTimeslotFee: dropoffTimeslotFeeNumber,
    pickupTimeslotFee: pickupTimeslotFeeNumber,
    extendedFee: extendedFeeNumber,
    minOrderFee: minOrderFeeNumber,
    tax: taxNumber,
    total: totalNumber,

    // items html
    itemsHtml,

    // customer + contact
    customerName:
      metadata.name ||
      metadata.customer_name ||
      customerDetails.name ||
      'Not provided',
    customerEmail:
      metadata.email ||
      metadata.customer_email ||
      customerDetails.email ||
      'Not provided',
    customerPhone:
      metadata.customer_phone || metadata.phone || customerDetails.phone || null,

    // address (full-service only)
    street: isSelfService ? null : metadata.street || null,
    address2: isSelfService ? null : metadata.address2 || null,
    city: isSelfService ? null : metadata.city || null,
    state: isSelfService ? null : metadata.state || null,
    zip: isSelfService ? null : metadata.zip || null,

    // schedule
    dropoffDate: isSelfService ? null : metadata.dropoff_date || null,
    dropoffTimeslotValue: isSelfService
      ? null
      : metadata.dropoff_timeslot_value || null,
    dropoffTimeslotType: isSelfService
      ? null
      : metadata.dropoff_timeslot_type || null,
    pickupDate: metadata.pickup_date || null,
    pickupTimeslotValue: metadata.pickup_timeslot_value || null,
    pickupTimeslotType: metadata.pickup_timeslot_type || null,
    returnDate: metadata.pickup_date || null,
    extraLabel
  };

  // ---- Generate approve/decline JWT links --------------------------------

  const setupIntentId = session.setup_intent;
  const tokenPayload = {
    sessionId: session.id,
    setupIntentId: setupIntentId,
    customerName: orderDetails.customerName,
    customerEmail: orderDetails.customerEmail,
    customerPhone: orderDetails.customerPhone,
    orderDetails: {
      ...metadata,
      flow: orderDetails.flow
    }
  };

  const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

  const approveUrl = `${SITE_URL}/.netlify/functions/checkout-approve?token=${encodeURIComponent(
    token
  )}`;
  const declineUrl = `${SITE_URL}/.netlify/functions/checkout-decline?token=${encodeURIComponent(
    token
  )}`;

  // ---- Owner SMS via Twilio ----------------------------------------------

  const twilioClient = getTwilioClient();
  const ownerPhone = formatPhoneNumber(OWNER_PHONE);

  if (twilioClient && TWILIO_FROM && ownerPhone) {
    try {
      await twilioClient.messages.create({
        from: TWILIO_FROM,
        to: ownerPhone,
        body: summarizeOwnerSms(orderDetails)
      });
      console.log('Owner SMS sent');
    } catch (err) {
      console.error('Error sending owner SMS:', err.message);
    }
  } else {
    console.log('Twilio not configured, skipping owner SMS');
  }

  // ---- Send emails via Resend ---------------------------------------------

  const resendEnabled = !!resend && !!process.env.RESEND_API_KEY;

  if (resendEnabled) {
    const isSelfServiceFlow = orderDetails.flow === 'self_service';

    const ownerSubject = isSelfServiceFlow
      ? '🙋‍♀️ New Pickup Order'
      : '🚚 New Delivery Order';

    const ownerHtml = isSelfServiceFlow
      ? buildSelfOwnerEmailHtml(orderDetails, approveUrl, declineUrl)
      : buildOwnerEmailHtml(orderDetails, approveUrl, declineUrl);

    const customerSubject = isSelfServiceFlow
      ? 'Self Service Request Received – Pending Confirmation'
      : 'Full Service Request Received – Pending Confirmation';

    const customerHtml = isSelfServiceFlow
      ? buildSelfCustomerEmailHtml(orderDetails)
      : buildCustomerEmailHtml(orderDetails);

    console.log('Resend from email:', FROM_EMAIL);
    console.log('Owner email:', OWNER_EMAIL);
    console.log('Customer email resolved as:', orderDetails.customerEmail);

    try {
      await resend.emails.send({
        from: FROM_EMAIL,
        to: [OWNER_EMAIL],
        subject: ownerSubject,
        html: ownerHtml
      });
      console.log('Email notification sent to owner');
    } catch (err) {
      console.error('Error sending owner email via Resend:', err.message);
    }

    try {
      await resend.emails.send({
        from: FROM_EMAIL,
        to: [orderDetails.customerEmail],
        subject: customerSubject,
        html: customerHtml
      });
      console.log('Email notification sent to customer');
    } catch (err) {
      console.error('Error sending customer email via Resend:', err.message);
    }
  } else {
    console.log('Resend not configured, skipping emails');
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ received: true })
  };
};
