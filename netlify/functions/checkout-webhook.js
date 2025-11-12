const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const jwt = require('jsonwebtoken');

// Lazy initialization functions - only create clients when needed
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

  // Handle the checkout.session.completed event
  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    
    console.log(`Processing ${stripeEvent.type}: ${session.id}`);

    // ALL orders require manual approval - no conditional logic needed
    console.log('Order requires manual approval - generating approve/decline URLs');

    const paymentIntentId = session.payment_intent;
    const customerName = session.customer_details?.name || 'Customer';
    const customerEmail = session.customer_details?.email;
    const customerPhone = session.customer_details?.phone;
    
    // Extract order details from metadata
    const orderDetails = {
      eventDate: session.metadata?.eventDate,
      serviceType: session.metadata?.serviceType,
      orderTotal: session.metadata?.orderTotal || (session.amount_total / 100),
      deliveryAddress: session.metadata?.deliveryAddress,
      subtotal: session.metadata?.subtotal,
      deliveryFee: session.metadata?.deliveryFee,
      rushFee: session.metadata?.rushFee,
    };

    // Create JWT token with order information (expires in 24 hours)
    const tokenPayload = {
      paymentIntentId,
      customerName,
      customerEmail,
      customerPhone,
      orderDetails,
      sessionId: session.id
    };

    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: '24h' });

    // Generate approve and decline URLs
    const siteUrl = process.env.SITE_URL || 'https://enchanting-monstera-41f4df.netlify.app';
    const approveUrl = `${siteUrl}/.netlify/functions/checkout-approve?token=${token}`;
    const declineUrl = `${siteUrl}/.netlify/functions/checkout-decline?token=${token}`;

    // Log the URLs prominently
    console.log('='.repeat(80));
    console.log('🔔 NEW ORDER REQUIRES APPROVAL 🔔');
    console.log('='.repeat(80));
    console.log(`Customer: ${customerName}`);
    console.log(`Email: ${customerEmail || 'Not provided'}`);
    console.log(`Phone: ${customerPhone || 'Not provided'}`);
    console.log(`Event Date: ${orderDetails.eventDate || 'Not provided'}`);
    console.log(`Service Type: ${orderDetails.serviceType || 'Not provided'}`);
    console.log(`Order Total: $${orderDetails.orderTotal}`);
    if (orderDetails.rushFee && parseFloat(orderDetails.rushFee) > 0) {
      console.log(`⚡ Rush Fee Applied: $${orderDetails.rushFee}`);
    }
    console.log('-'.repeat(80));
    console.log('APPROVE URL (click to capture payment):');
    console.log(approveUrl);
    console.log('-'.repeat(80));
    console.log('DECLINE URL (click to cancel payment):');
    console.log(declineUrl);
    console.log('='.repeat(80));

    // Check notification services configuration
    const twilioConfigured = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);
    const resendConfigured = !!process.env.RESEND_API_KEY;
    
    console.log(`Notification services configured: { twilio: ${twilioConfigured}, resend: ${resendConfigured} }`);

    // Send SMS to owner if Twilio is configured
    const twilio = getTwilioClient();
    if (twilio && process.env.OWNER_PHONE && process.env.TWILIO_PHONE_NUMBER) {
      try {
        const rushIndicator = orderDetails.rushFee && parseFloat(orderDetails.rushFee) > 0 ? '⚡ RUSH ' : '';
        await twilio.messages.create({
          body: `🔔 ${rushIndicator}ORDER from ${customerName}\nEvent: ${orderDetails.eventDate}\nAmount: $${orderDetails.orderTotal}\n\nApprove: ${approveUrl}\nDecline: ${declineUrl}`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: process.env.OWNER_PHONE
        });
        console.log('SMS notification sent to owner');
      } catch (smsError) {
        console.error('Failed to send SMS to owner:', smsError.message);
      }
    } else {
      console.log('Twilio not configured, skipping owner SMS');
    }

    // Send email to owner if Resend is configured
    const resend = getResendClient();
    if (resend && process.env.OWNER_EMAIL) {
      try {
        const rushBadge = orderDetails.rushFee && parseFloat(orderDetails.rushFee) > 0 
          ? '<span style="background: #ff6b6b; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold;">⚡ RUSH</span>' 
          : '';
        
        await resend.emails.send({
          from: 'Kraus Tables & Chairs <${process.env.FROM_EMAIL || 'orders@kraustables.com'}>',
          to: process.env.OWNER_EMAIL,
          subject: `🔔 New Order Needs Approval - ${customerName}`,
          html: `
            <h2>New Order Requires Manual Approval ${rushBadge}</h2>
            <p><strong>Customer:</strong> ${customerName}</p>
            <p><strong>Email:</strong> ${customerEmail || 'Not provided'}</p>
            <p><strong>Phone:</strong> ${customerPhone || 'Not provided'}</p>
            <p><strong>Event Date:</strong> ${orderDetails.eventDate || 'Not provided'}</p>
            <p><strong>Service Type:</strong> ${orderDetails.serviceType || 'Not provided'}</p>
            ${orderDetails.deliveryAddress ? `<p><strong>Delivery Address:</strong> ${orderDetails.deliveryAddress}</p>` : ''}
            <hr>
            <p><strong>Order Summary:</strong></p>
            <ul>
              ${orderDetails.subtotal ? `<li>Subtotal: $${orderDetails.subtotal}</li>` : ''}
              ${orderDetails.deliveryFee ? `<li>Delivery Fee: $${orderDetails.deliveryFee}</li>` : ''}
              ${orderDetails.rushFee && parseFloat(orderDetails.rushFee) > 0 ? `<li>⚡ Rush Fee: $${orderDetails.rushFee}</li>` : ''}
              <li><strong>Total: $${orderDetails.orderTotal}</strong></li>
            </ul>
            <hr>
            <p><strong>Action Required:</strong></p>
            <p>
              <a href="${approveUrl}" style="display: inline-block; padding: 12px 24px; background: #28a745; color: white; text-decoration: none; border-radius: 5px; margin-right: 10px;">
                ✅ APPROVE ORDER
              </a>
              <a href="${declineUrl}" style="display: inline-block; padding: 12px 24px; background: #dc3545; color: white; text-decoration: none; border-radius: 5px;">
                ❌ DECLINE ORDER
              </a>
            </p>
            <p style="color: #666; font-size: 12px; margin-top: 20px;">
              Note: These links expire in 24 hours. The customer's payment will remain on hold until you approve or decline.
            </p>
          `
        });
        console.log('Email notification sent to owner');
      } catch (emailError) {
        console.error('Failed to send email to owner:', emailError.message);
      }
    } else {
      console.log('Resend not configured, skipping owner email');
    }

    // Send notification to customer that order is pending
    if (twilio && customerPhone && process.env.TWILIO_PHONE_NUMBER) {
      try {
        await twilio.messages.create({
          body: `Hi ${customerName}, thank you for your order! We're reviewing the details for ${orderDetails.eventDate} and will confirm within a few hours. - Kraus Tables & Chairs`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: customerPhone
        });
        console.log('SMS notification sent to customer');
      } catch (smsError) {
        console.error('Failed to send customer SMS:', smsError.message);
      }
    } else {
      console.log('Twilio not configured, skipping customer SMS');
    }

    // Send email to customer that order is pending
    if (resend && customerEmail) {
      try {
        await resend.emails.send({
          from: 'Kraus Tables & Chairs <${process.env.FROM_EMAIL || 'orders@kraustables.com'}>',
          to: customerEmail,
          subject: 'Order Received - Pending Confirmation',
          html: `
            <h2>Thank You For Your Order!</h2>
            <p>Hi ${customerName},</p>
            <p>We've received your order for <strong>${orderDetails.eventDate}</strong>.</p>
            <p>We're reviewing the details to ensure everything is perfect for your event.</p>
            <p><strong>We'll confirm your order within a few hours.</strong></p>
            <p>Your payment of <strong>$${orderDetails.orderTotal}</strong> is authorized but not yet charged. We'll only charge your card once we confirm we can fulfill your order.</p>
            <h3>Order Summary:</h3>
            <ul>
              <li><strong>Event Date:</strong> ${orderDetails.eventDate}</li>
              <li><strong>Service Type:</strong> ${orderDetails.serviceType}</li>
              ${orderDetails.deliveryAddress ? `<li><strong>Delivery Address:</strong> ${orderDetails.deliveryAddress}</li>` : ''}
              <li><strong>Total:</strong> $${orderDetails.orderTotal}</li>
            </ul>
            <p>If you have any questions, feel free to reach out!</p>
            <p>Best regards,<br>Kraus Tables & Chairs</p>
          `
        });
        console.log('Email notification sent to customer');
      } catch (emailError) {
        console.error('Failed to send customer email:', emailError.message);
      }
    } else {
      console.log('Resend not configured, skipping customer email');
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ received: true })
  };
};
