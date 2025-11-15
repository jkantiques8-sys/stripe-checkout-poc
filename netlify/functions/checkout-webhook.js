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
const formatDate = (isoDate) => {
  if (!isoDate) return 'Not provided';
  const d = new Date(isoDate + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
};

// Convert "23-24" -> "11PM–12AM", "12-4" -> "12PM–4PM" etc.
const formatHourRange = (value) => {
  if (!value) return null;
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(value.trim());
  if (!match) return value;

  const [, startStr, endStr] = match;
  const start = Number(startStr);
  const end = Number(endStr);
  if (Number.isNaN(start) || Number.isNaN(end)) return value;

  const fmt = (h) => {
    const normalized = ((h % 24) + 24) % 24;
    const suffix = normalized >= 12 ? 'PM' : 'AM';
    const hour12 = normalized % 12 === 0 ? 12 : normalized % 12;
    return `${hour12}${suffix}`;
  };

  return `${fmt(start)}–${fmt(end)}`;
};

const formatWindow = (value, type) => {
  if (!value) return 'Not provided';

  const pretty = formatHourRange(value);
  if (pretty) return pretty;

  return value;
};

const summarizeSchedule = (details) => {
  const dropoff = details.dropoffDate
    ? `${formatDate(details.dropoffDate)} (${formatWindow(
        details.dropoffWindowValue,
        details.dropoffWindowType
      )})`
    : 'Not provided';

  const pickup = details.pickupDate
    ? `${formatDate(details.pickupDate)} (${formatWindow(
        details.pickupWindowValue,
        details.pickupWindowType
      )})`
    : 'Not provided';

  const extraDays =
    details.extraDays && Number(details.extraDays) > 0
      ? Number(details.extraDays)
      : 0;

  return {
    dropoff,
    pickup,
    extraDays,
    extraLabel:
      extraDays > 0 ? `${extraDays} extra day${extraDays > 1 ? 's' : ''}` : ''
  };
};

const decodeItems = (rawItems) => {
  if (!rawItems) return [];
  try {
    const parsed = JSON.parse(rawItems);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => ({
      name: item.name || 'Item',
      qty: item.qty || 0,
      unit: centsToNumber(item.unit),
      total: centsToNumber(
        item.unit && item.qty ? Number(item.unit) * Number(item.qty) : null
      )
    }));
  } catch (e) {
    console.warn('Failed to parse items metadata:', e.message);
    return [];
  }
};

const formatPhoneNumber = (value) => {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  let d = digits;
  if (d.length === 11 && d.startsWith('1')) {
    d = d.slice(1);
  }
  if (d.length === 10) {
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return value;
};

const buildItemsHtml = (items) => {
  if (!items || !items.length) return '';

  return `
    <h3 style="margin:24px 0 8px;font-size:15px;">Items</h3>
    <table width="100%" cellspacing="0" cellpadding="4" style="border-collapse:collapse;font-size:14px;">
      <thead>
        <tr>
          <th align="left">Item</th>
          <th align="right">Qty</th>
          <th align="right">Unit</th>
          <th align="right">Total</th>
        </tr>
      </thead>
      <tbody>
        ${items
          .map(
            (item) => `
          <tr>
            <td>${item.name}</td>
            <td align="right">${item.qty}</td>
            <td align="right">${formatMoney(item.unit)}</td>
            <td align="right">${formatMoney(item.total)}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>`;
};

const buildOrderSummaryRows = (details) => {
  const rows = [];

  // Subtotal always shown
  rows.push(`
    <tr>
      <td style="padding:2px 8px 2px 0;">Subtotal:</td>
      <td style="padding:2px 0;" align="right">${formatMoney(
        details.subtotalNumber
      )}</td>
    </tr>
  `);

  const addRowIfPositive = (label, value) => {
    if (!value || value <= 0) return;
    rows.push(`
      <tr>
        <td style="padding:2px 8px 2px 0;">${label}:</td>
        <td style="padding:2px 0;" align="right">${formatMoney(value)}</td>
      </tr>
    `);
  };

  addRowIfPositive('Delivery Fee', details.deliveryFeeNumber);
  addRowIfPositive('Rush Fee', details.rushFeeNumber);
  addRowIfPositive('Drop-off Window Fee', details.dropoffWindowFeeNumber);
  addRowIfPositive('Pickup Window Fee', details.pickupWindowFeeNumber);
  addRowIfPositive('Extended Rental Fee', details.extendedFeeNumber);
  addRowIfPositive('Minimum Surcharge', details.minOrderFeeNumber);
  addRowIfPositive('Tax', details.taxNumber);

  rows.push(`
    <tr>
      <td style="padding:8px 8px 2px 0;font-weight:bold;border-top:1px solid #ddd;">Total:</td>
      <td style="padding:8px 0 2px;font-weight:bold;border-top:1px solid #ddd;" align="right">${formatMoney(
        details.totalNumber
      )}</td>
    </tr>
  `);

  return rows.join('');
};

// ==== Email builders ========================================================

const buildOwnerEmailHtml = (details, approveUrl, declineUrl) => {
  const schedule = summarizeSchedule(details);
  const items = details.items || [];

  const itemsHtml = buildItemsHtml(items);

  const addressLines = [
    details.street,
    details.address2,
    details.city && details.state
      ? `${details.city}, ${details.state} ${details.zip || ''}`.trim()
      : null,
    !details.city && !details.state && details.zip ? details.zip : null
  ].filter(Boolean);

  const addressHtml =
    addressLines.length > 0
      ? addressLines.join('<br />')
      : 'Not provided';

  const formattedPhone = formatPhoneNumber(details.customerPhone);
  const phoneHtml = details.customerPhone
    ? `<a href="tel:${details.customerPhone}">${formattedPhone}</a>`
    : 'Not provided';

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#111;line-height:1.6;">
    <p>Hi Jonah,</p>

    <p><strong>New Order Requires Manual Approval</strong></p>

    <h3 style="margin:16px 0 4px;font-size:15px;">Customer</h3>
    <p style="margin:0;">
      <strong>Name:</strong> ${details.customerName || 'Not provided'}<br />
      <strong>Email:</strong> ${details.customerEmail || 'Not provided'}<br />
      <strong>Phone:</strong> ${phoneHtml}
    </p>

    <h3 style="margin:16px 0 4px;font-size:15px;">Schedule</h3>
    <p style="margin:0;">
      <strong>Drop-off:</strong> ${schedule.dropoff}<br />
      <strong>Pickup:</strong> ${schedule.pickup}${
        schedule.extraLabel
          ? `<br /><strong>Extra Days:</strong> ${schedule.extraLabel}`
          : ''
      }
    </p>

    <h3 style="margin:16px 0 4px;font-size:15px;">Delivery Address</h3>
    <p style="margin:0;">
      ${addressHtml}<br />
      <strong>Location Notes:</strong> ${
        details.locationNotes || 'None provided'
      }
    </p>

    ${itemsHtml}

    <h3 style="margin:24px 0 8px;font-size:15px;">Order Summary</h3>
    <table cellspacing="0" cellpadding="0" style="font-size:14px;">
      <tbody>
        ${buildOrderSummaryRows(details)}
      </tbody>
    </table>

    <h3 style="margin:24px 0 8px;font-size:15px;">Action Required</h3>
    <p style="margin:0 0 12px;">Capture or cancel the payment:</p>

    <p>
      <a href="${approveUrl}"
         style="display:inline-block;margin-right:12px;padding:10px 18px;background:#16a34a;color:#fff;text-decoration:none;border-radius:4px;font-weight:600;">
        ✅ APPROVE ORDER
      </a>
      <a href="${declineUrl}"
         style="display:inline-block;padding:10px 18px;background:#dc2626;color:#fff;text-decoration:none;border-radius:4px;font-weight:600;">
        ✖ DECLINE ORDER
      </a>
    </p>

    <p style="margin-top:16px;font-size:12px;color:#555;">
      Note: These links expire in 24 hours. The customer's payment will remain
      on hold until you approve or decline.
    </p>
  </div>
  `;
};

const buildCustomerEmailHtml = (details) => {
  const schedule = summarizeSchedule(details);
  const items = details.items || [];
  const itemsHtml = buildItemsHtml(items);

  const addressLines = [
    details.street,
    details.address2,
    details.city && details.state
      ? `${details.city}, ${details.state} ${details.zip || ''}`.trim()
      : null,
    !details.city && !details.state && details.zip ? details.zip : null
  ].filter(Boolean);

  const addressHtml =
    addressLines.length > 0
      ? addressLines.join('<br />')
      : 'Not provided';

  const formattedPhone = formatPhoneNumber(details.customerPhone);

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#111;line-height:1.6;">
    <p>Hi ${details.customerName || ''},</p>

    <p><strong>Thank you for your order!</strong></p>

    <p>
      We've received your order and we're reviewing the details to make sure
      everything is perfect for your event.
    </p>

    <h3 style="margin:16px 0 4px;font-size:15px;">Schedule</h3>
    <p style="margin:0;">
      <strong>Drop-off:</strong> ${schedule.dropoff}<br />
      <strong>Pickup:</strong> ${schedule.pickup}${
        schedule.extraLabel
          ? `<br /><strong>Extra Days:</strong> ${schedule.extraLabel}`
          : ''
      }
    </p>

    <h3 style="margin:16px 0 4px;font-size:15px;">Contact Info</h3>
    <p style="margin:0;">
      <strong>Name:</strong> ${details.customerName || 'Not provided'}<br />
      <strong>Email:</strong> ${details.customerEmail || 'Not provided'}<br />
      <strong>Phone:</strong> ${
        formattedPhone || 'Not provided'
      }
    </p>

    <h3 style="margin:16px 0 4px;font-size:15px;">Delivery Address</h3>
    <p style="margin:0;">
      ${addressHtml}<br />
      <strong>Location Notes:</strong> ${
        details.locationNotes || 'None provided'
      }
    </p>

    ${itemsHtml}

    <h3 style="margin:24px 0 8px;font-size:15px;">Order Summary</h3>
    <table cellspacing="0" cellpadding="0" style="font-size:14px;">
      <tbody>
        ${buildOrderSummaryRows(details)}
      </tbody>
    </table>

    <p style="margin-top:16px;">
      We'll confirm your order within a few hours. We'll only charge your card
      once we confirm we can fulfill your order.
    </p>

    <p style="margin-top:16px;">
      If you have any questions or need to make changes, just reply to this email.
    </p>

    <p style="margin-top:24px;">– Kraus’ Tables &amp; Chairs</p>
  </div>
  `;
};

// ==== SMS builder (short!) ==================================================

const buildOwnerSms = (details, approveUrl, declineUrl) => {
  const schedule = summarizeSchedule(details);

  return (
    `New order ${formatMoney(details.totalNumber)} – ${
      details.customerName || 'New customer'
    }\n` +
    `Drop-off: ${schedule.dropoff}\n` +
    `Pickup: ${schedule.pickup}\n` +
    (schedule.extraLabel ? `Extra: ${schedule.extraLabel}\n` : '') +
    `Approve: ${approveUrl}\nDecline: ${declineUrl}`
  );
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

  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  }

  const session = stripeEvent.data.object;
  console.log(`=== Processing checkout.session.completed ===`);
  console.log('Session ID:', session.id);

  const metadata = session.metadata || {};
  const customerDetails = session.customer_details || {};

  console.log('Customer details:', customerDetails);
  console.log('Raw metadata:', metadata);

  // ---- Map metadata into a normalized orderDetails object ------------------

  const subtotalNumber = centsToNumber(metadata.products_subtotal_cents);
  const deliveryFeeNumber = centsToNumber(metadata.delivery_cents);
  const rushFeeNumber = centsToNumber(metadata.rush_cents);
  const taxNumber = centsToNumber(metadata.tax_cents);

  const dropoffWindowFeeNumber = centsToNumber(
    metadata.dropoff_window_cents
  );
  const pickupWindowFeeNumber = centsToNumber(
    metadata.pickup_window_cents
  );
  const extendedFeeNumber = centsToNumber(metadata.extended_cents);
  const minOrderFeeNumber = centsToNumber(metadata.min_order_cents);

  const totalNumber =
    centsToNumber(metadata.total_cents) ??
    centsToNumber(session.amount_total) ??
    0;

  const items = decodeItems(metadata.items);

  const orderDetails = {
    customerName:
      metadata.name || customerDetails.name || 'Not provided',
    customerEmail:
      customerDetails.email || metadata.email || 'Not provided',
    customerPhone: metadata.phone || customerDetails.phone || null,

    // schedule
    dropoffDate: metadata.dropoff_date || null,
    dropoffWindowValue: metadata.dropoff_window_value || null,
    dropoffWindowType: metadata.dropoff_window_type || null,
    pickupDate: metadata.pickup_date || null,
    pickupWindowValue: metadata.pickup_window_value || null,
    pickupWindowType: metadata.pickup_window_type || null,
    extraDays: metadata.extra_days || null,

    // address
    street: metadata.street || null,
    address2: metadata.address2 || null,
    city: metadata.city || null,
    state: metadata.state || null,
    zip: metadata.zip || null,
    locationNotes: metadata.location_notes || null,

    // financials
    subtotalNumber,
    deliveryFeeNumber,
    rushFeeNumber,
    taxNumber,
    dropoffWindowFeeNumber,
    pickupWindowFeeNumber,
    extendedFeeNumber,
    minOrderFeeNumber,
    totalNumber,

    items
  };

  console.log('Customer:', orderDetails.customerName);
  console.log('Customer email:', orderDetails.customerEmail);

  // ---- Build approve / decline URLs (JWT token) ----------------------------

  const tokenPayload = {
    paymentIntentId: session.payment_intent,
    customerName: orderDetails.customerName,
    customerEmail: orderDetails.customerEmail,
    customerPhone: orderDetails.customerPhone,
    orderDetails: {
      total: orderDetails.totalNumber
    },
    sessionId: session.id
  };

  const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '24h' });

  const approveUrl = `${SITE_URL}/.netlify/functions/checkout-approve?token=${token}`;
  const declineUrl = `${SITE_URL}/.netlify/functions/checkout-decline?token=${token}`;

  console.log('Order total:', formatMoney(orderDetails.totalNumber));
  console.log('Approve URL:', approveUrl);
  console.log('Decline URL:', declineUrl);

  // ---- Notification configuration -----------------------------------------

  const twilioClient = getTwilioClient();
  const smsEnabled = !!(twilioClient && OWNER_PHONE && TWILIO_FROM);
  const resendEnabled = !!resend && !!FROM_EMAIL;

  console.log('Notification services configured:', {
    twilio: smsEnabled,
    resend: resendEnabled
  });

  // ---- Send SMS to owner (short summary) ----------------------------------

  if (smsEnabled) {
    try {
      const smsBody = buildOwnerSms(orderDetails, approveUrl, declineUrl);
      await twilioClient.messages.create({
        from: TWILIO_FROM,
        to: OWNER_PHONE,
        body: smsBody
      });
      console.log('Owner SMS sent');
    } catch (err) {
      console.error('Failed to send owner SMS:', err.message);
    }
  } else {
    console.log('Twilio not configured, skipping owner SMS');
  }

  // ---- Send emails via Resend ---------------------------------------------

  if (resendEnabled) {
    const ownerSubject = `⚠️ New Order Needs Approval - ${orderDetails.customerName}`;
    const ownerHtml = buildOwnerEmailHtml(
      orderDetails,
      approveUrl,
      declineUrl
    );

    const customerSubject = 'Order Received – Pending Confirmation';
    const customerHtml = buildCustomerEmailHtml(orderDetails);

    console.log('Resend from email:', FROM_EMAIL);
    console.log('Owner email:', OWNER_EMAIL);
    console.log('Customer email resolved as:', orderDetails.customerEmail);

    try {
      await resend.emails.send({
        from: FROM_EMAIL,
        to: OWNER_EMAIL,
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
        to: orderDetails.customerEmail,
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
