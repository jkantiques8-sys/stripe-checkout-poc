

function escapeHtml(input) {
  const s = String(input ?? '');
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
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
  
  // Special handling for known flex slot patterns
  const flexMap = {
    '8-12': '8AM–12PM',
    '12-4': '12PM–4PM',
    '4-8': '4PM–8PM'
  };
  
  if (flexMap[value]) {
    return flexMap[value];
  }
  
  // Otherwise, format as 24-hour time slot (for prompt slots)
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


const formatTimeSlot = (value, type) => {
  if (!value) return 'Not provided';

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

const summarizeSelfSchedule = (details) => {
  const pickup = details.pickupDate
    ? formatDate(details.pickupDate)
    : 'Not provided';

  const returnDate = details.returnDate
    ? formatDate(details.returnDate)
    : 'Not provided';

  const extraDays =
    details.extraDays && Number(details.extraDays) > 0
      ? Number(details.extraDays)
      : 0;

  return {
    pickup,
    returnDate,
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

  addRowIfPositive('Delivery fee', details.deliveryFeeNumber);
  addRowIfPositive('Rush fee', details.rushFeeNumber);
  addRowIfPositive('Drop-off time slot fee', details.dropoffTimeslotFeeNumber);
  addRowIfPositive('Pickup time slot fee', details.pickupTimeslotFeeNumber);
  addRowIfPositive('Extended rental fee', details.extendedFeeNumber);
  addRowIfPositive('Minimum surcharge', details.minOrderFeeNumber);
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

  <h2 style="margin:0 0 16px;font-size:20px;">Request Received – Pending Confirmation</h2>

<p>Hi ${details.customerName || 'there'},</p>

<p>
	Thank you for submitting your <strong>full-service rental request</strong> with Kraus’ Tables & Chairs. We’ve received your details and are reviewing availability, delivery logistics, and access requirements for your location.
</p>

<p>
	<strong>Your card has been authorized, but not yet charged.</strong>
</p>

<p>
	Once your request is approved:
</p>

<ul>
	<li>For standard orders, we’ll charge a <strong>30% deposit</strong>.
	</li>
	<li>For last-minute or rush orders, payment will be <strong>charged in full</strong>.
	</li>
</ul>

<p>
	For standard orders, the remaining balance is <strong>automatically charged the day before drop-off</strong>.
</p>

<p>
	We typically confirm full-service requests within <strong>2 business hours</strong>. If we need to clarify any details, we’ll contact you before proceeding.
</p>
<p>
	Need to make changes? Just reply to this email and we’ll take care of it.
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
      We'll confirm your order within 2 business hours. We'll only charge your card
      once we confirm we can fulfill your order.
    </p>

    <p style="margin-top:16px;">
      If you have any questions or need to make changes, just reply to this email.
    </p>

    <p style="margin-top:16px;">
      <a href="https://kazoo-earthworm-tgxd.squarespace.com/terms-conditions">View our Terms & Conditions</a>
    </p>

    <p style="margin-top:24px;">– Kraus’ Tables &amp; Chairs</p>
  </div>
  `;
};

const buildSelfOwnerEmailHtml = (details, approveUrl, declineUrl) => {
  const schedule = summarizeSelfSchedule(details);
  const items = details.items || [];
  const itemsHtml = buildItemsHtml(items);

  const chairLines = [];
  if (details.selfQtyDark) chairLines.push(`${details.selfQtyDark} × dark chairs`);
  if (details.selfQtyLight) chairLines.push(`${details.selfQtyLight} × light chairs`);

  const chairsHtml =
    chairLines.length > 0
      ? `<p style="margin:0 0 12px;"><strong>Chairs:</strong> ${chairLines.join(
          ' & '
        )}</p>`
      : '';

  return `
  <div style="font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#432F28;line-height:1.5;">
    <h2 style="margin:0 0 16px;font-size:20px;">New Self-Service Order – Needs Review</h2>

    <p style="margin:0 0 12px;">
      A new <strong>self-service chair rental</strong> order was submitted on the website.
      Review the details below and capture or cancel the payment using the links at the bottom.
    </p>

    <h3 style="margin:24px 0 8px;font-size:15px;">Pickup &amp; Return</h3>
    <p style="margin:0 0 4px;"><strong>Pickup:</strong> ${schedule.pickup}</p>
    <p style="margin:0 0 4px;"><strong>Return:</strong> ${schedule.returnDate}</p>
    ${
      schedule.extraLabel
        ? `<p style="margin:0 0 4px;"><strong>Extended rental:</strong> ${schedule.extraLabel}</p>`
        : ''
    }

    <h3 style="margin:24px 0 8px;font-size:15px;">Contact Info</h3>
    <p style="margin:0;">
      <strong>Name:</strong> ${details.customerName || 'Not provided'}<br/>
      <strong>Email:</strong> ${details.customerEmail || 'Not provided'}<br/>
      <strong>Phone:</strong> ${
        details.customerPhone
          ? `<a href="tel:${details.customerPhone}" style="color:#432F28;text-decoration:underline;">${details.customerPhone}</a>`
          : 'Not provided'
      }
    </p>


    <h3 style="margin:24px 0 8px;font-size:15px;">Order Details</h3>
    ${chairsHtml}
    ${itemsHtml}

    <h3 style="margin:24px 0 8px;font-size:15px;">Order Summary</h3>
    <table cellspacing="0" cellpadding="0" style="font-size:14px;">
      <tbody>
        ${buildOrderSummaryRows(details)}
      </tbody>
    </table>

    <h3 style="margin:24px 0 8px;font-size:15px;">Action Required</h3>
    <p style="margin:0 0 12px;">Capture or cancel the payment:</p>

    <p style="margin:0 0 4px;">
      <a href="${approveUrl}"
         style="display:inline-block;margin-right:12px;padding:10px 16px;border-radius:4px;background:#2f855a;color:#fff;text-decoration:none;">
        Approve &amp; Capture
      </a>
      <a href="${declineUrl}"
         style="display:inline-block;padding:10px 16px;border-radius:4px;background:#c53030;color:#fff;text-decoration:none;">
        Decline &amp; Release Hold
      </a>
    </p>

    <p style="margin-top:24px;">– Kraus’ Tables &amp; Chairs</p>
  </div>
  `;
};

const buildSelfCustomerEmailHtml = (details) => {
  const schedule = summarizeSelfSchedule(details);

  return `
  <div style="font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#432F28;line-height:1.5;">
<h2 style="margin:0 0 16px;font-size:20px;">Request Received – Pending Confirmation</h2>

<p>Hi ${details.customerName || 'there'},</p>

<p>
  Thank you for submitting your request for <strong>self-service chair rentals</strong> with Kraus’ Tables &amp; Chairs.
</p>

<p>
  <strong>Your card has not been charged—this is an authorization only.</strong>  
  We’ll call you within 2 hours to review your request and finalize your pickup plan:
</p>

<ul>
  <li><strong>Self-pickup</strong> at our Brooklyn location (24-hour lockbox access)</li>
  <li><strong>Uber or rideshare pickup</strong> — we’ll pack your order for your driver</li>
</ul>

<p>
  Once your request is approved and all details are confirmed, we will capture payment.  
</p>

<p>
  Need to make changes? Simply reply to this email.
</p>

    <h3 style="margin:24px 0 8px;font-size:15px;">Pickup &amp; Return</h3>
    <p style="margin:0 0 4px;"><strong>Pickup:</strong> ${schedule.pickup}</p>
    <p style="margin:0 0 4px;"><strong>Return:</strong> ${schedule.returnDate}</p>
    ${
      schedule.extraLabel
        ? `<p style="margin:0 0 4px;"><strong>Extended rental:</strong> ${schedule.extraLabel}</p>`
        : ''
    }
    <h3 style="margin:24px 0 8px;font-size:15px;">Contact Info</h3>
    <p style="margin:0;">
      <strong>Name:</strong> ${details.customerName || 'Not provided'}<br/>
      <strong>Email:</strong> ${details.customerEmail || 'Not provided'}<br/>
      <strong>Phone:</strong> ${details.customerPhone || 'Not provided'}
    </p>

    <h3 style="margin:24px 0 8px;font-size:15px;">Order Summary</h3>
    <table cellspacing="0" cellpadding="0" style="font-size:14px;">
      <tbody>
        ${buildOrderSummaryRows(details)}
      </tbody>
    </table>

    <p style="margin-top:16px;">
      We’ll confirm your order within 2 business hours. Your card will
      <strong>not be charged</strong> until we call to confirm your pickup and return times.
    </p>

    <p style="margin-top:16px;">
      If you have questions or need to make changes, just reply to this email.
    </p>

    <p style="margin-top:16px;">
      <a href="https://kazoo-earthworm-tgxd.squarespace.com/terms-conditions">View our Terms & Conditions</a>
    </p>

    <p style="margin-top:24px;">– Kraus’ Tables &amp; Chairs</p>
  </div>
  `;
};


// ==== SMS builder (short!) ==================================================

const buildOwnerSms = (details) => {
  const schedule = summarizeSchedule(details);

  return (
    `🚚 New DELIVERY order ${formatMoney(details.totalNumber)} – ${
      details.customerName || 'New customer'
    }\n` +
    `Drop-off: ${schedule.dropoff}\n` +
    `Pickup: ${schedule.pickup}\n` +
    (schedule.extraLabel ? `Extra: ${schedule.extraLabel}\n` : '')
  );
};

const buildSelfOwnerSms = (details) => {
  const schedule = summarizeSelfSchedule(details);

  const total = formatMoney(details.totalNumber);

  return [
    `🙋‍♀️ New SELF-SERVICE order ${total}`,
    details.customerName ? `Customer: ${details.customerName}` : null,
    `Pickup: ${schedule.pickup}`,
    `Return: ${schedule.returnDate}`,
    schedule.extraLabel ? `Extended: ${schedule.extraLabel}` : null
  ]
    .filter(Boolean)
    .join('\n');
};


// ==== Main handler ==========================================================

exports.handler = async (event, context) => {
  // Netlify normalizes headers to lowercase, but be defensive.
  const sig =
    event.headers['stripe-signature'] ||
    event.headers['Stripe-Signature'] ||
    event.headers['STRIPE-SIGNATURE'];

  // Stripe requires the *raw* request body for signature verification.
  // Netlify may base64-encode the payload depending on configuration.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : event.body;

  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
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

  console.log(
    '[checkout-webhook] received event:',
    stripeEvent.type,
    'id:',
    stripeEvent.id
  );

  // We handle two events:
  //  - checkout.session.completed (for setup-mode requests)
  //  - invoice.paid (send confirmation to customer + owner)
  if (
    stripeEvent.type !== 'checkout.session.completed' &&
    stripeEvent.type !== 'invoice.paid'
  ) {
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  }

  // ---------------------------------------------------------------------
  // INVOICE PAID (customer + owner email)
  // ---------------------------------------------------------------------
  if (stripeEvent.type === 'invoice.paid') {
    const invoice = stripeEvent.data.object;

    // Resolve customer email/name as best we can.
    let customerEmail = invoice.customer_email || null;
    let customerName = invoice.customer_name || null;
    try {
      if ((!customerEmail || !customerName) && invoice.customer) {
        const cust = await stripe.customers.retrieve(invoice.customer);
        customerEmail = customerEmail || cust.email || null;
        customerName = customerName || cust.name || null;
      }
    } catch (e) {
      console.warn('Failed to retrieve invoice customer:', e.message);
    }

    const amountPaidCents = Number(invoice.amount_paid ?? 0);
    const totalCents = Number(invoice.total ?? invoice.amount_due ?? 0);
    const amountPaid = centsToNumber(amountPaidCents > 0 ? amountPaidCents : totalCents);
    const amountDue = centsToNumber(totalCents);
    const hostedUrl = invoice.hosted_invoice_url || null;
    const pdfUrl = invoice.invoice_pdf || null;


// If Stripe reports a $0 invoice paid (common when you create an invoice that nets to $0),
// skip sending "payment received" emails to avoid confusing $0 receipts.
if ((Number(invoice.total ?? invoice.amount_due ?? 0) === 0) && (Number(invoice.amount_paid ?? 0) === 0)) {
  console.log('invoice.paid: $0 invoice; skipping payment-received emails', { invoice_id: invoice.id, number: invoice.number });
  return { statusCode: 200, body: JSON.stringify({ received: true }) };
}

    const subject = `✅ Invoice paid${invoice.number ? ` (${invoice.number})` : ''}`;

    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#111;line-height:1.6;">
        <p>Payment received.</p>
        <p style="margin:0;">
          <strong>Customer:</strong> ${customerName || 'Unknown'}<br/>
          <strong>Email:</strong> ${customerEmail || 'Unknown'}<br/>
          <strong>Invoice:</strong> ${invoice.number || invoice.id}<br/>
          <strong>Amount paid:</strong> ${formatMoney(amountPaid)}<br/>
          <strong>Remaining balance: $0.00 (paid in full)</strong>
        </p>
        ${
          hostedUrl
            ? `<p style="margin-top:16px;"><a href="${hostedUrl}">View invoice</a>${
                pdfUrl ? ` • <a href="${pdfUrl}">Download PDF</a>` : ''
              }</p>`
            : ''
        }
        <p style="margin-top:24px;">– Kraus’ Tables &amp; Chairs</p>
      </div>
    `;

    const resendEnabled = !!resend && !!FROM_EMAIL;
    if (!resendEnabled) {
      console.log('Resend not configured, skipping invoice.paid emails');
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }

    // Send to owner
    try {
      await resend.emails.send({
        from: FROM_EMAIL,
        to: OWNER_EMAIL,
        subject,
        html
      });
      console.log('invoice.paid email sent to owner');
    } catch (e) {
      console.error('Failed sending invoice.paid email to owner:', e.message);
    }

    // Send to customer (if we have an email)
    if (customerEmail) {
      try {
        await resend.emails.send({
          from: FROM_EMAIL,
          to: customerEmail,
          subject: '✅ Payment received – Kraus’ Tables & Chairs',
          html
        });
        console.log('invoice.paid email sent to customer');
      } catch (e) {
        console.error('Failed sending invoice.paid email to customer:', e.message);
      }
    } else {
      console.warn('invoice.paid: no customer email found; skipping customer email');
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  }

  // ---------------------------------------------------------------------
  // CHECKOUT SESSION COMPLETED (SETUP MODE)
  // ---------------------------------------------------------------------

  const session = stripeEvent.data.object;
  console.log(`=== Processing checkout.session.completed ===`);
  console.log('Session ID:', session.id);

  // In setup-mode, Stripe may NOT create a Customer unless you set
  // `customer_creation: 'always'` when creating the session. We can still
  // proceed by creating a Customer here and attaching the saved payment method.
  const sessionMode = session.mode;
  console.log('Session mode:', sessionMode);

  const metadata = session.metadata || {};
  const customerDetails = session.customer_details || {};

  console.log('Customer details:', customerDetails);
  console.log('Raw metadata:', metadata);

// ---- Map metadata into a normalized orderDetails object ------------------

// Determine flow: full-service vs self-service
const flow =
  metadata.flow ||
  (metadata.chairs_subtotal_cents ? 'self_service' : 'full_service');
const isSelfService = flow === 'self_service';

// Money values
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
  pickupTimeslotFeeNumber = null;
  extendedFeeNumber = centsToNumber(metadata.ext_fee_cents);
  minOrderFeeNumber = centsToNumber(metadata.min_cents);
} else {
  // Full-service delivery
  subtotalNumber = centsToNumber(metadata.products_subtotal_cents);
  deliveryFeeNumber = centsToNumber(metadata.delivery_cents);
  rushFeeNumber = centsToNumber(metadata.rush_cents);
  taxNumber = centsToNumber(metadata.tax_cents);
  dropoffTimeslotFeeNumber = centsToNumber(
    metadata.dropoff_timeslot_cents
  );
  pickupTimeslotFeeNumber = centsToNumber(
    metadata.pickup_timeslot_cents
  );
  extendedFeeNumber = centsToNumber(metadata.extended_cents);
  minOrderFeeNumber = centsToNumber(metadata.min_order_cents);
}

const totalNumber =
  centsToNumber(metadata.total_cents) ??
  centsToNumber(session.amount_total) ??
  0;

const items = decodeItems(metadata.items);

const orderDetails = {
  flow,
  customerName:
    metadata.customer_name || metadata.name || customerDetails.name || 'Not provided',
  customerEmail:
    customerDetails.email ||
    metadata.customer_email ||
    metadata.email ||
    'Not provided',
  customerPhone:
    metadata.customer_phone || metadata.phone || customerDetails.phone || null,

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
  returnDate: metadata.return_date || null,
  extraDays: isSelfService
    ? metadata.ext_days || null
    : metadata.extra_days || null,

  // address (used only for full-service)
  street: metadata.street || null,
  address2: metadata.address2 || null,
  city: metadata.city || null,
  state: metadata.state || null,
  zip: metadata.zip || null,
  locationNotes: metadata.location_notes || null,

  // self-service chair counts (for email copy)
  selfQtyDark: metadata.qty_dark ? Number(metadata.qty_dark) : null,
  selfQtyLight: metadata.qty_light ? Number(metadata.qty_light) : null,

  // financials
  subtotalNumber,
  deliveryFeeNumber,
  rushFeeNumber,
  taxNumber,
  dropoffTimeslotFeeNumber,
  pickupTimeslotFeeNumber,
  extendedFeeNumber,
  minOrderFeeNumber,
  totalNumber,

  items
};


  console.log('Customer:', orderDetails.customerName);
  console.log('Customer email:', orderDetails.customerEmail);

  // ---- Build approve / decline URLs (JWT token) ----------------------------

  // ---- Ensure we have a customer and a reusable payment method -----------
  let customerId = session.customer || null;
  let setupIntentId = session.setup_intent || null;
  let paymentMethodId = null;

  try {
    if (setupIntentId) {
      const si = await stripe.setupIntents.retrieve(setupIntentId);
      paymentMethodId = si.payment_method || null;

      // If Checkout didn't create a customer, create one now.
      if (!customerId) {
        const created = await stripe.customers.create({
          email:
            customerDetails.email ||
            metadata.customer_email ||
            metadata.email ||
            undefined,
          name:
            customerDetails.name ||
            metadata.customer_name ||
            metadata.name ||
            undefined,
          phone: customerDetails.phone || metadata.customer_phone || undefined,
          metadata: {
            source: 'checkout-webhook',
            session_id: session.id,
            flow: metadata.flow || 'full_service'
          }
        });
        customerId = created.id;
        console.log('Created customer:', customerId);
      }

      // Attach PM to customer so later charges/invoices can reuse it.
      if (customerId && paymentMethodId) {
        await stripe.paymentMethods.attach(paymentMethodId, {
          customer: customerId
        });
        await stripe.customers.update(customerId, {
          invoice_settings: { default_payment_method: paymentMethodId }
        });
        console.log('Attached payment method to customer + set default');
      }
    } else {
      console.warn('No setup_intent on session; cannot attach payment method');
    }
  } catch (e) {
    console.error('Failed to ensure customer/payment method:', e.message);
  }

  const tokenPayload = {
    setupIntentId,
    customerId,
    paymentMethodId,
    customerName: orderDetails.customerName,
    customerEmail: orderDetails.customerEmail,
    customerPhone: orderDetails.customerPhone,
    orderDetails: {
      total: orderDetails.totalNumber,
      total_cents: metadata.total_cents || '',
      dropoff_date: metadata.dropoff_date || '',
      flow: metadata.flow || 'full_service'
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
  
  console.log('Twilio env present:', {
    hasSid: !!process.env.TWILIO_ACCOUNT_SID,
    hasToken: !!process.env.TWILIO_AUTH_TOKEN,
    hasFrom: !!TWILIO_FROM,
    hasOwner: !!OWNER_PHONE
  });
  
  console.log('Notification services configured:', {
    twilio: smsEnabled,
    resend: resendEnabled
  });
  

  // ---- Send SMS to owner (short summary) ----------------------------------

  if (smsEnabled) {
    try {
      const smsBody = orderDetails.flow === 'self_service'
        ? buildSelfOwnerSms(orderDetails, approveUrl, declineUrl)
        : buildOwnerSms(orderDetails, approveUrl, declineUrl);  
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
