// netlify/functions/checkout-decline.js
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

// Send customer decline SMS
async function sendDeclineSMS(phone, name, dropoffDate) {
  if (!TWILIO_FROM) {
    console.log('Twilio not configured, skipping SMS');
    return;
  }

  const message = `Hi ${name},

We're sorry – we can't accommodate your order for ${dropoffDate}.

The card hold has been released (no charge).

Want alternative dates or have questions?
Call or text (718) 218-4057

Thank you for considering Kraus Tables & Chairs.`;

  try {
    await twilio.messages.create({
      body: message,
      from: TWILIO_FROM,
      to: phone
    });
    console.log('Decline SMS sent');
  } catch (error) {
    console.error('Error sending decline SMS:', error);
  }
}

// Send customer decline email
async function sendDeclineEmail(email, name, dropoffDate) {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  
  <div style="text-align: center; margin-bottom: 32px;">
    <h1 style="color: #856404; margin: 0;">Order Update</h1>
  </div>

  <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 24px; border-radius: 8px; margin-bottom: 24px;">
    <p style="margin: 0 0 16px; font-size: 16px;">Hi ${name},</p>
    <p style="margin: 0 0 16px; color: #856404;">We're sorry – we're unable to accommodate your order for <strong>${dropoffDate}</strong>.</p>
    <p style="margin: 0; color: #856404;">This may be due to inventory availability or scheduling conflicts.</p>
  </div>

  <div style="background: #d4edda; border-left: 4px solid #28a745; padding: 16px; margin-bottom: 24px;">
    <p style="margin: 0; color: #155724;">
      <strong>✓ No Charge:</strong> The hold on your card has been released. You will not be charged.
    </p>
  </div>

  <div style="background: #f8f9fa; padding: 24px; border-radius: 8px; margin-bottom: 24px;">
    <h3 style="margin: 0 0 16px; color: #5a3a1c;">Need Different Dates?</h3>
    <p style="margin: 0 0 16px; color: #666;">We may have availability on alternative dates. We'd love to help you find a solution!</p>
    <div style="text-align: center;">
      <a href="tel:+17182184057" 
         style="display: inline-block; background: #5a3a1c; color: white; padding: 12px 32px; text-decoration: none; border-radius: 6px; font-weight: 600; margin-right: 8px;">
        📞 Call Us
      </a>
      <a href="sms:+17182184057" 
         style="display: inline-block; background: #28a745; color: white; padding: 12px 32px; text-decoration: none; border-radius: 6px; font-weight: 600;">
        💬 Text Us
      </a>
    </div>
  </div>

  <div style="text-align: center; padding: 24px; background: white; border: 1px solid #e0e0e0; border-radius: 8px; margin-bottom: 24px;">
    <p style="margin: 0 0 8px; color: #666; font-size: 18px; font-weight: 600;">(718) 218-4057</p>
    <p style="margin: 0; font-size: 14px; color: #666;">Monday - Saturday, 9am - 6pm</p>
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
      subject: 'Order Update - Unable to Accommodate',
      html: html
    });
    console.log('Decline email sent');
  } catch (error) {
    console.error('Error sending decline email:', error);
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
    const decoded = verifyToken(token, 'decline');
    if (decoded.pi !== pi) {
      throw new Error('Token mismatch');
    }

    // Retrieve payment intent
    const paymentIntent = await stripe.paymentIntents.retrieve(pi);

    // Check if already canceled
    if (paymentIntent.status === 'canceled') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/html' },
        body: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Already Declined</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 40px; text-align: center; background: #f8f9fa; }
    .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { color: #ffc107; margin-bottom: 16px; }
    .icon { font-size: 64px; margin-bottom: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">⚠️</div>
    <h1>Already Declined</h1>
    <p>This order has already been declined and the hold has been released.</p>
  </div>
</body>
</html>
        `
      };
    }

    // Check if already captured (can't decline if already paid)
    if (paymentIntent.status === 'succeeded') {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'text/html' },
        body: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cannot Decline</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 40px; text-align: center; background: #f8f9fa; }
    .container { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { color: #dc3545; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>❌ Cannot Decline</h1>
    <p>This order has already been approved and the payment has been captured.</p>
    <p style="font-size: 14px; color: #666;">You cannot decline an order that has already been paid.</p>
  </div>
</body>
</html>
        `
      };
    }

    // Cancel the payment intent
    const canceledIntent = await stripe.paymentIntents.cancel(pi);
    
    console.log('Payment canceled successfully:', pi);

    // Get customer info from metadata
    const metadata = paymentIntent.metadata || {};
    const customerName = metadata.customer_name || 'Customer';
    const customerPhone = metadata.customer_phone || '';
    const customerEmail = metadata.customer_email || '';
    const dropoffDate = metadata.dropoff_date || '';

    // Send customer notifications (fire and forget)
    Promise.all([
      sendDeclineSMS(customerPhone, customerName, dropoffDate),
      sendDeclineEmail(customerEmail, customerName, dropoffDate)
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
  <title>Order Declined</title>
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
      padding: 40px; 
      text-align: center; 
      background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
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
    .icon { font-size: 80px; margin-bottom: 24px; }
    h1 { color: #856404; margin-bottom: 16px; font-size: 32px; }
    p { color: #666; line-height: 1.6; margin-bottom: 16px; }
    .details { 
      background: #f8f9fa; 
      padding: 20px; 
      border-radius: 8px; 
      margin: 24px 0;
      text-align: left;
    }
    .details strong { color: #333; }
    .notice {
      background: #d4edda;
      border-left: 4px solid #28a745;
      padding: 16px;
      border-radius: 8px;
      margin: 24px 0;
      text-align: left;
    }
    .notice p { margin: 0; color: #155724; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">❌</div>
    <h1>Order Declined</h1>
    <p>The payment hold has been released and the customer has been notified.</p>
    
    <div class="details">
      <p><strong>Customer:</strong> ${customerName}</p>
      <p><strong>Requested Date:</strong> ${dropoffDate}</p>
      <p style="margin: 0;"><strong>Status:</strong> <span style="color: #dc3545;">Declined</span></p>
    </div>

    <div class="notice">
      <p><strong>✓ Hold Released:</strong> The customer will not be charged.</p>
    </div>

    <p style="font-size: 14px; color: #999;">The customer has been sent information about rebooking. You can close this window.</p>
  </div>
</body>
</html>
      `
    };

  } catch (error) {
    console.error('Error declining order:', error);
    
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
      <p><strong>Could not decline order:</strong></p>
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
