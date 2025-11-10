// netlify/functions/checkout-approve.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const jwt = require('jsonwebtoken');

// Twilio setup
const twilio = require('twilio')(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Resend setup
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';
const TWILIO_FROM = process.env.TWILIO_FROM_PHONE;

// Verify and decode token
function verifyToken(token, expectedAction) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.action !== expectedAction) {
      throw new Error('Invalid action');
    }
    return decoded;
  } catch (err) {
    throw new Error('Invalid or expired token');
  }
}

// Send customer confirmation SMS
async function sendConfirmationSMS(phone, name, dropoffDate) {
  if (!TWILIO_FROM) {
    console.log('Twilio not configured, skipping SMS');
    return;
  }

  const message = `✅ You're confirmed, ${name}!

Your order for ${dropoffDate} has been approved and your payment has been processed.

We'll text you 1 hour before arrival.

Questions? Call or text (718) 218-4057

Thank you for choosing Kraus Tables & Chairs!`;

  try {
    await twilio.messages.create({
      body: message,
      from: TWILIO_FROM,
      to: phone
    });
    console.log('Confirmation SMS sent');
  } catch (error) {
    console.error('Error sending confirmation SMS:', error);
  }
}

// Send customer confirmation email
async function sendConfirmationEmail(email, name, dropoffDate, receiptUrl) {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  
  <div style="text-align: center; margin-bottom: 32px;">
    <div style="font-size: 64px; margin-bottom: 16px;">✅</div>
    <h1 style="color: #28a745; margin: 0;">You're Confirmed!</h1>
  </div>

  <div style="background: #d4edda; border-left: 4px solid #28a745; padding: 24px; border-radius: 8px; margin-bottom: 24px;">
    <p style="margin: 0 0 16px; font-size: 16px;">Hi ${name},</p>
    <p style="margin: 0 0 16px; color: #155724;">Your order for <strong>${dropoffDate}</strong> has been approved!</p>
    <p style="margin: 0; color: #155724;">Your payment has been processed.</p>
  </div>

  <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 16px; margin-bottom: 24px;">
    <p style="margin: 0; color: #856404;">
      <strong>📱 Delivery Reminder:</strong> We'll text you 1 hour before arrival on ${dropoffDate}.
    </p>
  </div>

  ${receiptUrl ? `
  <div style="text-align: center; margin-bottom: 24px;">
    <a href="${receiptUrl}" 
       style="display: inline-block; background: #5a3a1c; color: white; padding: 12px 32px; text-decoration: none; border-radius: 6px; font-weight: 600;">
      View Receipt
    </a>
  </div>
  ` : ''}

  <div style="text-align: center; padding: 24px; background: white; border: 1px solid #e0e0e0; border-radius: 8px; margin-bottom: 24px;">
    <p style="margin: 0 0 12px; color: #666;">Questions or need to make changes?</p>
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
      subject: '✅ Order Confirmed - Payment Processed',
      html: html
    });
    console.log('Confirmation email sent');
  } catch (error) {
    console.error('Error sending confirmation email:', error);
  }
}

exports.handler = async (event) => {
  // Only allow GET requests
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      body: 'Method Not Allowed'
    };
  }

  const params = event.queryStringParameters || {};
  const pi = params.pi;
  const token = params.t;

  if (!pi || !token) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/html' },
      body: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Error</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 40px; text-align: center; background: #f8f9fa; }
    .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { color: #dc3545; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>❌ Error</h1>
    <p>Missing payment information. Please use the link from your notification.</p>
  </div>
</body>
</html>
      `
    };
  }

  try {
    // Verify token
    const decoded = verifyToken(token, 'approve');
    if (decoded.pi !== pi) {
      throw new Error('Token mismatch');
    }

    // Retrieve payment intent
    const paymentIntent = await stripe.paymentIntents.retrieve(pi);

    // Check if already captured
    if (paymentIntent.status === 'succeeded') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/html' },
        body: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Already Approved</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 40px; text-align: center; background: #f8f9fa; }
    .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { color: #ffc107; margin-bottom: 16px; }
    .icon { font-size: 64px; margin-bottom: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">✅</div>
    <h1>Already Approved</h1>
    <p>This order has already been approved and the payment has been captured.</p>
  </div>
</body>
</html>
        `
      };
    }

    // Check if requires capture
    if (paymentIntent.status !== 'requires_capture') {
      throw new Error(`Cannot capture payment in status: ${paymentIntent.status}`);
    }

    // Capture the payment
    const capturedIntent = await stripe.paymentIntents.capture(pi);
    
    console.log('Payment captured successfully:', pi);

    // Get customer info from metadata
    const metadata = paymentIntent.metadata || {};
    const customerName = metadata.customer_name || 'Customer';
    const customerPhone = metadata.customer_phone || '';
    const customerEmail = metadata.customer_email || '';
    const dropoffDate = metadata.dropoff_date || '';
    
    // Get receipt URL from charges
    const receiptUrl = capturedIntent.charges?.data?.[0]?.receipt_url || '';

    // Send customer notifications (fire and forget)
    Promise.all([
      sendConfirmationSMS(customerPhone, customerName, dropoffDate),
      sendConfirmationEmail(customerEmail, customerName, dropoffDate, receiptUrl)
    ]).catch(err => {
      console.error('Error sending customer notifications:', err);
    });

    // Return success page
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Order Approved</title>
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
      padding: 40px; 
      text-align: center; 
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0;
    }
    .container { 
      max-width: 500px; 
      background: white; 
      padding: 48px; 
      border-radius: 16px; 
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .icon { font-size: 80px; margin-bottom: 24px; animation: pop 0.5s ease; }
    @keyframes pop {
      0% { transform: scale(0); }
      50% { transform: scale(1.1); }
      100% { transform: scale(1); }
    }
    h1 { color: #28a745; margin-bottom: 16px; font-size: 32px; }
    p { color: #666; line-height: 1.6; margin-bottom: 16px; }
    .details { 
      background: #f8f9fa; 
      padding: 20px; 
      border-radius: 8px; 
      margin: 24px 0;
      text-align: left;
    }
    .details strong { color: #333; }
    .button {
      display: inline-block;
      background: #5a3a1c;
      color: white;
      padding: 12px 32px;
      text-decoration: none;
      border-radius: 6px;
      font-weight: 600;
      margin-top: 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">✅</div>
    <h1>Order Approved!</h1>
    <p>The payment has been successfully captured and the customer has been notified.</p>
    
    <div class="details">
      <p><strong>Customer:</strong> ${customerName}</p>
      <p><strong>Delivery Date:</strong> ${dropoffDate}</p>
      <p style="margin: 0;"><strong>Status:</strong> <span style="color: #28a745;">Confirmed & Paid</span></p>
    </div>

    <p style="font-size: 14px; color: #999;">You can close this window.</p>
  </div>
</body>
</html>
      `
    };

  } catch (error) {
    console.error('Error approving order:', error);
    
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/html' },
      body: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Error</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 40px; text-align: center; background: #f8f9fa; }
    .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { color: #dc3545; margin-bottom: 16px; }
    .error { background: #f8d7da; color: #721c24; padding: 16px; border-radius: 8px; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>❌ Error</h1>
    <div class="error">
      <p><strong>Could not approve order:</strong></p>
      <p>${error.message}</p>
    </div>
    <p style="font-size: 14px; color: #666;">The link may have expired or the payment may have already been processed.</p>
  </div>
</body>
</html>
      `
    };
  }
};
