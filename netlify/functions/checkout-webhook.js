// netlify/functions/checkout-webhook.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const jwt = require('jsonwebtoken');

// Configuration
const OWNER_PHONE = process.env.OWNER_PHONE || '+17182184057';
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'orders@kraustables.com';
const SITE_URL = process.env.SITE_URL || 'https://kraustables.com';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';
const TWILIO_FROM = process.env.TWILIO_FROM_PHONE;

// Check if notification services are configured
const TWILIO_CONFIGURED = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && TWILIO_FROM);
const RESEND_CONFIGURED = !!process.env.RESEND_API_KEY;

// Lazy-load Twilio only if configured
let twilioClient = null;
function getTwilio() {
  if (!TWILIO_CONFIGURED) return null;
  if (!twilioClient) {
    const twilio = require('twilio');
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return twilioClient;
}

// Lazy-load Resend only if configured
let resendClient = null;
function getResend() {
  if (!RESEND_CONFIGURED) return null;
  if (!resendClient) {
    const { Resend } = require('resend');
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

// Generate signed token for approve/decline links (24 hour expiry)
function generateToken(pi, action) {
  return jwt.sign(
    { pi, action, exp: Math.floor(Date.now() / 1000) + 86400 }, // 24 hours
    JWT_SECRET
  );
}

// Format window display
function formatWindow(type, value) {
  if (type === 'prompt') {
    return `1-hour window (${value})`;
  } else if (type === 'flex') {
    return `4-hour window (${value})`;
  }
  return value || 'Not specified';
}

// Send owner SMS notification
async function sendOwnerSMS(orderData) {
  const twilio = getTwilio();
  if (!twilio) {
    console.log('Twilio not configured, skipping SMS');
    return;
  }

  const { pi, sessionId, customerName, customerPhone, isRush, dropoffDate, dropoffWindow, 
          pickupDate, pickupWindow, orderSummary, totalFormatted, approveUrl, declineUrl } = orderData;

  const rushLabel = isRush ? '🔥 RUSH ORDER' : '📦 STANDARD ORDER';
  
  const message = `${rushLabel}

Order #${sessionId.substring(0, 12)}

Customer: ${customerName}
Phone: ${customerPhone}

Drop-off: ${dropoffDate} (${dropoffWindow})
Pickup: ${pickupDate} (${pickupWindow})

Items: ${orderSummary}
Total: ${totalFormatted}

✅ APPROVE: ${approveUrl}
❌ DECLINE: ${declineUrl}`;

  try {
    await twilio.messages.create({
      body: message,
      from: TWILIO_FROM,
      to: OWNER_PHONE
    });
    console.log('Owner SMS sent successfully');
  } catch (error) {
    console.error('Error sending owner SMS:', error);
  }
}

// Send owner email notification
async function sendOwnerEmail(orderData) {
  const resend = getResend();
  if (!resend) {
    console.log('Resend not configured, skipping email');
    return;
  }

  const { pi, sessionId, customerName, customerPhone, customerEmail, isRush, 
          dropoffDate, dropoffWindow, pickupDate, pickupWindow, orderSummary, 
          totalFormatted, street, city, state, zip, approveUrl, declineUrl } = orderData;

  const rushBadge = isRush 
    ? '<span style="background: #ff6b35; color: white; padding: 4px 12px; border-radius: 4px; font-weight: 600; font-size: 14px;">🔥 RUSH ORDER</span>'
    : '<span style="background: #4a90e2; color: white; padding: 4px 12px; border-radius: 4px; font-weight: 600; font-size: 14px;">📦 STANDARD ORDER</span>';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  
  <div style="background: #f8f9fa; padding: 24px; border-radius: 8px; margin-bottom: 24px;">
    <div style="margin-bottom: 12px;">${rushBadge}</div>
    <h2 style="margin: 0; color: #2c3e50;">New Order Confirmation Required</h2>
    <p style="margin: 8px 0 0; color: #666; font-size: 14px;">Order #${sessionId.substring(0, 20)}</p>
  </div>

  <div style="background: white; padding: 24px; border: 1px solid #e0e0e0; border-radius: 8px; margin-bottom: 24px;">
    
    <h3 style="margin-top: 0; color: #2c3e50; border-bottom: 2px solid #5a3a1c; padding-bottom: 8px;">Customer Information</h3>
    <table style="width: 100%; margin-bottom: 20px;">
      <tr>
        <td style="padding: 8px 0; color: #666; width: 120px;"><strong>Name:</strong></td>
        <td style="padding: 8px 0;">${customerName}</td>
      </tr>
      <tr>
        <td style="padding: 8px 0; color: #666;"><strong>Phone:</strong></td>
        <td style="padding: 8px 0;"><a href="tel:${customerPhone}" style="color: #5a3a1c;">${customerPhone}</a></td>
      </tr>
      <tr>
        <td style="padding: 8px 0; color: #666;"><strong>Email:</strong></td>
        <td style="padding: 8px 0;"><a href="mailto:${customerEmail}" style="color: #5a3a1c;">${customerEmail}</a></td>
      </tr>
    </table>

    <h3 style="color: #2c3e50; border-bottom: 2px solid #5a3a1c; padding-bottom: 8px;">Delivery Address</h3>
    <p style="margin: 12px 0 20px; line-height: 1.8;">
      ${street}<br>
      ${city}, ${state} ${zip}
    </p>

    <h3 style="color: #2c3e50; border-bottom: 2px solid #5a3a1c; padding-bottom: 8px;">Schedule</h3>
    <table style="width: 100%; margin-bottom: 20px;">
      <tr>
        <td style="padding: 8px 0; color: #666; width: 120px;"><strong>Drop-off:</strong></td>
        <td style="padding: 8px 0;">${dropoffDate}</td>
      </tr>
      <tr>
        <td style="padding: 8px 0; color: #666;"></td>
        <td style="padding: 8px 0; color: #888; font-size: 14px;">${dropoffWindow}</td>
      </tr>
      <tr>
        <td style="padding: 8px 0; color: #666;"><strong>Pickup:</strong></td>
        <td style="padding: 8px 0;">${pickupDate}</td>
      </tr>
      <tr>
        <td style="padding: 8px 0; color: #666;"></td>
        <td style="padding: 8px 0; color: #888; font-size: 14px;">${pickupWindow}</td>
      </tr>
    </table>

    <h3 style="color: #2c3e50; border-bottom: 2px solid #5a3a1c; padding-bottom: 8px;">Order Items</h3>
    <p style="margin: 12px 0 20px; line-height: 1.8;">${orderSummary}</p>

    <h3 style="color: #2c3e50; border-bottom: 2px solid #5a3a1c; padding-bottom: 8px;">Total</h3>
    <p style="margin: 12px 0 20px; font-size: 20px; font-weight: 600; color: #5a3a1c;">${totalFormatted}</p>
  </div>

  <div style="margin-bottom: 24px;">
    <a href="${approveUrl}" 
       style="display: inline-block; background: #28a745; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px; margin-right: 12px; margin-bottom: 12px;">
      ✅ Approve & Capture Payment
    </a>
    <a href="${declineUrl}" 
       style="display: inline-block; background: #dc3545; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px; margin-bottom: 12px;">
      ❌ Decline & Release Hold
    </a>
  </div>

  <div style="background: #fff3cd; border: 1px solid #ffc107; padding: 16px; border-radius: 6px; margin-bottom: 24px;">
    <p style="margin: 0; color: #856404; font-size: 14px;">
      <strong>⏱️ Action Required:</strong> This authorization expires in 7 days. The approve/decline links expire in 24 hours.
    </p>
  </div>

  <div style="text-align: center; color: #999; font-size: 12px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
    <p>Kraus Tables & Chairs • Vintage Furniture Rentals</p>
  </div>

</body>
</html>
  `;

  try {
    await resend.emails.send({
      from: 'Kraus Orders <orders@kraustables.com>',
      to: OWNER_EMAIL,
      replyTo: customerEmail,
      subject: `${isRush ? '🔥 RUSH' : '📦'} Order Confirmation Needed - ${customerName}`,
      html: html
    });
    console.log('Owner email sent successfully');
  } catch (error) {
    console.error('Error sending owner email:', error);
  }
}

// Send customer confirmation SMS
async function sendCustomerSMS(phone, name, dropoffDate) {
  const twilio = getTwilio();
  if (!twilio) {
    console.log('Twilio not configured, skipping customer SMS');
    return;
  }

  const message = `Hi ${name}! Thanks for your order with Kraus Tables & Chairs.

We've received your request for ${dropoffDate} and placed a hold on your card.

We'll call to confirm within 1 hour during business hours.

If we can't fulfill your order, the hold will be released automatically.

Questions? Call or text (718) 218-4057`;

  try {
    await twilio.messages.create({
      body: message,
      from: TWILIO_FROM,
      to: phone
    });
    console.log('Customer SMS sent successfully');
  } catch (error) {
    console.error('Error sending customer SMS:', error);
  }
}

// Send customer confirmation email
async function sendCustomerEmail(email, name, dropoffDate) {
  const resend = getResend();
  if (!resend) {
    console.log('Resend not configured, skipping customer email');
    return;
  }

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  
  <div style="text-align: center; margin-bottom: 32px;">
    <h1 style="color: #5a3a1c; margin: 0;">Thanks for your order!</h1>
  </div>

  <div style="background: #f8f9fa; padding: 24px; border-radius: 8px; margin-bottom: 24px;">
    <p style="margin: 0 0 16px; font-size: 16px;">Hi ${name},</p>
    <p style="margin: 0 0 16px;">We've received your order for <strong>${dropoffDate}</strong> and placed a hold on your card.</p>
    <p style="margin: 0;">We'll call to confirm within <strong>1 hour during business hours</strong>.</p>
  </div>

  <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 16px; margin-bottom: 24px;">
    <p style="margin: 0; color: #856404;">
      <strong>Important:</strong> If we can't fulfill your order, the hold will be released automatically with no charge.
    </p>
  </div>

  <div style="text-align: center; padding: 24px; background: white; border: 1px solid #e0e0e0; border-radius: 8px; margin-bottom: 24px;">
    <p style="margin: 0 0 12px; color: #666;">Questions about your order?</p>
    <p style="margin: 0;">
      <a href="tel:+17182184057" style="color: #5a3a1c; font-weight: 600; font-size: 18px; text-decoration: none;">📞 (718) 218-4057</a>
    </p>
    <p style="margin: 8px 0 0; font-size: 14px; color: #666;">Call or text anytime</p>
  </div>

  <div style="text-align: center; color: #999; font-size: 12px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
    <p>Kraus Tables & Chairs</p>
    <p style="margin: 4px 0 0;">Vintage Furniture Rentals • Brooklyn, NY</p>
  </div>

</body>
</html>
  `;

  try {
    await resend.emails.send({
      from: 'Kraus Tables & Chairs <orders@kraustables.com>',
      to: email,
      subject: 'Order Received - Confirmation Call Coming Soon',
      html: html
    });
    console.log('Customer email sent successfully');
  } catch (error) {
    console.error('Error sending customer email:', error);
  }
}

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not configured');
    return { statusCode: 500, body: 'Webhook secret not configured' };
  }

  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  // Handle checkout.session.completed event
  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    
    console.log('Processing checkout.session.completed:', session.id);

    // Get the payment intent
    const paymentIntentId = session.payment_intent;
    if (!paymentIntentId) {
      console.error('No payment intent found in session');
      return { statusCode: 200, body: 'No payment intent' };
    }

    // Retrieve full payment intent with metadata
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    // Check if this requires capture (should be true for all our orders now)
    if (paymentIntent.status !== 'requires_capture') {
      console.log('Payment intent does not require capture, skipping notifications');
      return { statusCode: 200, body: 'Not requires_capture' };
    }

    // Extract metadata
    const metadata = paymentIntent.metadata || {};
    const sessionMetadata = session.metadata || {};
    
    const isRush = metadata.rush === 'true' || sessionMetadata.rush === 'true';
    const customerName = metadata.customer_name || sessionMetadata.name || 'Customer';
    const customerPhone = metadata.customer_phone || sessionMetadata.phone || '';
    const customerEmail = metadata.customer_email || sessionMetadata.email || session.customer_email || '';
    
    const dropoffDate = metadata.dropoff_date || sessionMetadata.dropoff_date || '';
    const dropoffWindowType = metadata.dropoff_window_type || sessionMetadata.dropoff_window_type || '';
    const dropoffWindowValue = metadata.dropoff_window_value || sessionMetadata.dropoff_window_value || '';
    
    const pickupDate = metadata.pickup_date || sessionMetadata.pickup_date || '';
    const pickupWindowType = metadata.pickup_window_type || sessionMetadata.pickup_window_type || '';
    const pickupWindowValue = metadata.pickup_window_value || sessionMetadata.pickup_window_value || '';
    
    const orderSummary = metadata.order_summary || 'See order details';
    const totalCents = paymentIntent.amount;
    const totalFormatted = `$${(totalCents / 100).toFixed(2)}`;
    
    const street = sessionMetadata.street || '';
    const city = sessionMetadata.city || '';
    const state = sessionMetadata.state || '';
    const zip = sessionMetadata.zip || '';

    // Generate approve/decline tokens
    const approveToken = generateToken(paymentIntentId, 'approve');
    const declineToken = generateToken(paymentIntentId, 'decline');

    const approveUrl = `${SITE_URL}/.netlify/functions/checkout-approve?pi=${paymentIntentId}&t=${approveToken}`;
    const declineUrl = `${SITE_URL}/.netlify/functions/checkout-decline?pi=${paymentIntentId}&t=${declineToken}`;

    // Format windows for display
    const dropoffWindow = formatWindow(dropoffWindowType, dropoffWindowValue);
    const pickupWindow = formatWindow(pickupWindowType, pickupWindowValue);

    const orderData = {
      pi: paymentIntentId,
      sessionId: session.id,
      customerName,
      customerPhone,
      customerEmail,
      isRush,
      dropoffDate,
      dropoffWindow,
      pickupDate,
      pickupWindow,
      orderSummary,
      totalFormatted,
      street,
      city,
      state,
      zip,
      approveUrl,
      declineUrl
    };

    // Log notification status
    console.log('Notification services configured:', {
      twilio: TWILIO_CONFIGURED,
      resend: RESEND_CONFIGURED
    });

    // Send notifications (don't await - fire and forget to prevent timeout)
    Promise.all([
      sendOwnerSMS(orderData),
      sendOwnerEmail(orderData),
      sendCustomerSMS(customerPhone, customerName, dropoffDate),
      sendCustomerEmail(customerEmail, customerName, dropoffDate)
    ]).catch(err => {
      console.error('Error sending notifications:', err);
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        received: true, 
        notifications_attempted: true,
        twilio_configured: TWILIO_CONFIGURED,
        resend_configured: RESEND_CONFIGURED
      })
    };
  }

  // Return 200 for other event types
  return {
    statusCode: 200,
    body: JSON.stringify({ received: true })
  };
};
