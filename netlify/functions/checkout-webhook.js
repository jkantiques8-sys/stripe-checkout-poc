const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const jwt = require('jsonwebtoken');

// Lazy init clients so builds don’t fail if env vars are missing
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

function getNotificationConfig() {
  const hasTwilio =
    !!process.env.TWILIO_ACCOUNT_SID &&
    !!process.env.TWILIO_AUTH_TOKEN &&
    !!process.env.TWILIO_PHONE_NUMBER &&
    !!process.env.OWNER_PHONE;

  const hasResend =
    !!process.env.RESEND_API_KEY &&
    !!process.env.FROM_EMAIL;

  return {
    twilio: hasTwilio,
    resend: hasResend
  };
}

/**
 * Build order/schedule details from the Stripe session metadata
 * so we can use it consistently in logs + emails.
 */
function buildOrderDetails(session) {
  const metadata = session.metadata || {};

  // Try a few possible key names so we’re resilient to small naming differences
  const dropoffDate =
    metadata.dropoffDate ||
    metadata.dropOffDate ||
    metadata.deliveryDate ||
    metadata.eventDate ||
    '';

  const dropoffWindow =
    metadata.dropoffWindow ||
    metadata.dropoffWindowLabel ||
    metadata.dropoffTimeSlot ||
    '';

  const pickupDate =
    metadata.pickupDate ||
    metadata.returnDate ||
    '';

  const pickupWindow =
    metadata.pickupWindow ||
    metadata.pickupWindowLabel ||
    metadata.pickupTimeSlot ||
    '';

  const deliveryAddress =
    metadata.deliveryAddress ||
    metadata.address ||
    '';

  const orderTotal = session.amount_total
    ? (session.amount_total / 100).toFixed(2)
    : '0.00';

  const orderSubtotal = metadata.orderSubtotal || '0.00';
  const deliveryFee = metadata.deliveryFee || '0.00';
  const rushFee = metadata.rushFee || '0.00';

  const scheduleLinesText = [];
  if (dropoffDate || dropoffWindow) {
    scheduleLinesText.push(
      `Drop-off: ${[dropoffDate, dropoffWindow].filter(Boolean).join(' ')}`
    );
  }
  if (pickupDate || pickupWindow) {
    scheduleLinesText.push(
      `Pickup: ${[pickupDate, pickupWindow].filter(Boolean).join(' ')}`
    );
  }

  const scheduleSummaryText =
    scheduleLinesText.length > 0 ? scheduleLinesText.join(' | ') : 'Not provided';

  const scheduleSummaryHtml =
    scheduleLinesText.length > 0
      ? scheduleLinesText
          .map((line) => `<li>${line.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</li>`)
          .join('')
      : '<li>Not provided</li>';

  return {
    dropoffDate: dropoffDate || 'Not provided',
    dropoffWindow: dropoffWindow || 'Not provided',
    pickupDate: pickupDate || 'Not provided',
    pickupWindow: pickupWindow || 'Not provided',
    deliveryAddress: deliveryAddress || 'Not provided',
    orderTotal,
    orderSubtotal,
    deliveryFee,
    rushFee,
    scheduleSummaryText,
    scheduleSummaryHtml
  };
}

/**
 * Send SMS to owner (for now we’re *not* texting the customer).
 */
async function sendTwilioNotifications({ session, orderDetails, approveUrl, declineUrl }) {
  const config = getNotificationConfig();
  const client = getTwilioClient();

  if (!config.twilio || !client) {
    console.log('Twilio not configured, skipping SMS notifications');
    return;
  }

  const ownerPhone = process.env.OWNER_PHONE;
  const total = orderDetails.orderTotal;

  const message = [
    'New order requires approval.',
    `Total: $${total}`,
    orderDetails.scheduleSummaryText !== 'Not provided'
      ? `Schedule: ${orderDetails.scheduleSummaryText}`
      : null,
    '',
    'Approve:',
    approveUrl,
    '',
    'Decline:',
    declineUrl
  ]
    .filter(Boolean)
    .join('\n');

  try {
    await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: ownerPhone
    });
    console.log('SMS notification sent to owner');
  } catch (err) {
    console.error('Failed to send owner SMS:', err.message);
  }
}

/**
 * Send emails via Resend (owner + customer).
 */
async function sendResendEmails({
  session,
  customerName,
  customerEmail,
  orderDetails,
  approveUrl,
  declineUrl
}) {
  const config = getNotificationConfig();
  const resend = getResendClient();

  if (!config.resend || !resend) {
    console.log('Resend not configured, skipping email notifications');
    return;
  }

  const fromEmail = process.env.FROM_EMAIL || 'orders@kraustables.com';
  const ownerEmail = process.env.OWNER_EMAIL || 'jonahkraus@gmail.com';

  console.log('Resend from email:', fromEmail);
  console.log('Owner email:', ownerEmail);
  console.log('Customer email resolved as:', customerEmail || '(none)');

  // OWNER EMAIL
  const ownerHtml = `
    <p>Hi Jonah,</p>
    <p><strong>New Order Requires Manual Approval</strong></p>

    <p><strong>Customer:</strong> ${customerName || 'Not provided'}<br/>
    <strong>Email:</strong> ${customerEmail || 'Not provided'}<br/>
    <strong>Phone:</strong> ${
      session.customer_details?.phone || session.metadata?.customerPhone || 'Not provided'
    }</p>

    <p><strong>Schedule:</strong></p>
    <ul>
      ${orderDetails.scheduleSummaryHtml}
    </ul>

    <p><strong>Delivery Address:</strong><br/>
    ${orderDetails.deliveryAddress}</p>

    <p><strong>Order Summary:</strong></p>
    <ul>
      <li>Subtotal: $${orderDetails.orderSubtotal}</li>
      <li>Delivery Fee: $${orderDetails.deliveryFee}</li>
      <li>Rush Fee: $${orderDetails.rushFee}</li>
      <li><strong>Total: $${orderDetails.orderTotal}</strong></li>
    </ul>

    <p><strong>Action Required:</strong></p>
    <p>
      <a href="${approveUrl}"
         style="display:inline-block;padding:10px 18px;margin-right:10px;background:#16a34a;color:#fff;text-decoration:none;border-radius:4px;">
        ✅ APPROVE ORDER
      </a>
      <a href="${declineUrl}"
         style="display:inline-block;padding:10px 18px;background:#dc2626;color:#fff;text-decoration:none;border-radius:4px;">
        ❌ DECLINE ORDER
      </a>
    </p>

    <p><small>Note: These links expire in 24 hours. The customer's payment will remain on hold
    until you approve or decline.</small></p>
  `;

  // CUSTOMER EMAIL  (content mostly same as before, just no Event Date / Service Type)
  const customerHtml = `
    <p>Hi ${customerName || 'there'},</p>

    <p><strong>Thank you for your order!</strong></p>

    <p>We've received your order and we're reviewing the details to make sure everything is
    perfect for your event.</p>

    <p>We'll confirm your order within a few hours. We'll only charge your card once we confirm
    we can fulfill your order.</p>

    <p><strong>Order Summary:</strong></p>
    <ul>
      <li><strong>Total: $${orderDetails.orderTotal}</strong></li>
    </ul>

    <p>If you have any questions or need to make changes, just reply to this email.</p>

    <p>– Kraus' Tables & Chairs</p>
  `;

  try {
    const ownerResult = await resendClient.emails.send({
      from: `Kraus Tables & Chairs <${fromEmail}>`,
      to: [ownerEmail],
      subject: `⚠️ New Order Needs Approval - ${customerName || 'Customer'}`,
      html: ownerHtml
    });
    console.log('Email notification sent to owner. Resend id:', ownerResult?.id || '(none)');
  } catch (err) {
    console.error('Failed to send owner email:', err.message);
  }

  // Only send customer email if we *have* an address
  if (!customerEmail) {
    console.log('No customer email available, skipping customer notification');
    return;
  }

  try {
    const customerResult = await resendClient.emails.send({
      from: `Kraus Tables & Chairs <${fromEmail}>`,
      to: [customerEmail],
      subject: 'Order Received – Pending Confirmation',
      html: customerHtml
    });
    console.log(
      'Email notification sent to customer. Resend id:',
      customerResult?.id || '(none)'
    );
  } catch (err) {
    console.error('Failed to send customer email:', err.message);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: 'Method Not Allowed'
    };
  }

  const sig = event.headers['stripe-signature'];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('⚠️ Webhook signature verification failed.', err.message);
    return {
      statusCode: 400,
      body: `Webhook Error: ${err.message}`
    };
  }

  if (stripeEvent.type !== 'checkout.session.completed') {
    // For now we only care about checkout completion
    return {
      statusCode: 200,
      body: JSON.stringify({ received: true, ignored: stripeEvent.type })
    };
  }

  const session = stripeEvent.data.object;

  console.log('=== Processing checkout.session.completed ===');
  console.log('Session ID:', session.id);
  console.log('Customer details:', session.customer_details || '(none)');
  console.log('Raw metadata:', JSON.stringify(session.metadata || {}, null, 2));

  const customerName =
    session.customer_details?.name || session.metadata?.customerName || 'Customer';
  const customerEmail =
    session.customer_details?.email || session.metadata?.customerEmail || null;

  const orderDetails = buildOrderDetails(session);

  console.log('Customer:', customerName);
  console.log('Customer email:', customerEmail || '(none)');
  console.log('Schedule summary:', orderDetails.scheduleSummaryText);
  console.log('Delivery address:', orderDetails.deliveryAddress);
  console.log('Order total: $' + orderDetails.orderTotal);

  // Create signed token for approve/decline links
  const tokenPayload = {
    paymentIntentId: session.payment_intent,
    customerName,
    customerEmail,
    orderDetails,
    sessionId: session.id
  };

  const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: '24h' });

  const baseUrl =
    process.env.SITE_URL || 'https://enchanting-monstera-41f4df.netlify.app';

  const approveUrl = `${baseUrl}/.netlify/functions/checkout-approve?token=${token}`;
  const declineUrl = `${baseUrl}/.netlify/functions/checkout-decline?token=${token}`;

  console.log('Approve URL:', approveUrl);
  console.log('Decline URL:', declineUrl);

  // Send notifications
  await sendTwilioNotifications({ session, orderDetails, approveUrl, declineUrl });
  await sendResendEmails({
    session,
    customerName,
    customerEmail,
    orderDetails,
    approveUrl,
    declineUrl
  });

  return {
    statusCode: 200,
    body: JSON.stringify({ received: true })
  };
};
