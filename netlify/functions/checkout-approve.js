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
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // Get the token from the request body
    const { token } = JSON.parse(event.body);
    
    if (!token) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Token is required' })
      };
    }

    // Verify the JWT token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      console.error('JWT verification failed:', err.message);
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Invalid or expired token' })
      };
    }

    const { paymentIntentId, customerName, customerEmail, customerPhone, orderDetails } = decoded;

    // Capture the payment
    const paymentIntent = await stripe.paymentIntents.capture(paymentIntentId);

    console.log(`Payment approved for ${customerName}. Payment Intent ID: ${paymentIntentId}`);

    // Send SMS notification to customer if Twilio is configured
    const twilio = getTwilioClient();
    if (twilio && customerPhone && process.env.TWILIO_PHONE_NUMBER) {
      try {
        await twilio.messages.create({
          body: `Great news ${customerName}! Your rush order has been approved and your payment has been processed. We'll have everything ready for ${orderDetails?.eventDate || 'your event'}. Thank you for choosing Kraus Tables & Chairs!`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: customerPhone
        });
        console.log(`SMS notification sent to customer: ${customerPhone}`);
      } catch (smsError) {
        console.error('Failed to send SMS to customer:', smsError.message);
      }
    } else {
      console.log('Twilio not configured - skipping customer SMS notification');
    }

    // Send email notification to customer if Resend is configured
    const resend = getResendClient();
    if (resend && customerEmail) {
      try {
        await resend.emails.send({
          from: 'Kraus Tables & Chairs <orders@kraustablesandchairs.com>',
          to: customerEmail,
          subject: 'Rush Order Approved! 🎉',
          html: `
            <h2>Your Rush Order Has Been Approved!</h2>
            <p>Hi ${customerName},</p>
            <p>Great news! We can accommodate your rush order request.</p>
            <p><strong>Your payment has been processed and your order is confirmed.</strong></p>
            ${orderDetails ? `
              <h3>Order Details:</h3>
              <ul>
                ${orderDetails.eventDate ? `<li><strong>Event Date:</strong> ${orderDetails.eventDate}</li>` : ''}
                ${orderDetails.serviceType ? `<li><strong>Service Type:</strong> ${orderDetails.serviceType}</li>` : ''}
              </ul>
            ` : ''}
            <p>We'll have everything ready for your event. If you have any questions, feel free to reach out!</p>
            <p>Best regards,<br>Kraus Tables & Chairs</p>
          `
        });
        console.log(`Email notification sent to customer: ${customerEmail}`);
      } catch (emailError) {
        console.error('Failed to send email to customer:', emailError.message);
      }
    } else {
      console.log('Resend not configured - skipping customer email notification');
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        message: 'Payment captured',
        paymentIntentId: paymentIntent.id,
        status: paymentIntent.status
      })
    };

  } catch (error) {
    console.error('Error capturing payment:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to capture payment',
        details: error.message 
      })
    };
  }
};
