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

    const { paymentIntentId, customerName, customerEmail, customerPhone } = decoded;

    // Cancel the payment intent
    const paymentIntent = await stripe.paymentIntents.cancel(paymentIntentId);

    console.log(`Payment declined for ${customerName}. Payment Intent ID: ${paymentIntentId}`);

    // Send SMS notification to customer if Twilio is configured
    const twilio = getTwilioClient();
    if (twilio && customerPhone && process.env.TWILIO_PHONE_NUMBER) {
      try {
        await twilio.messages.create({
          body: `Hi ${customerName}, unfortunately we cannot accommodate your rush order request at this time. Your payment has been cancelled and you will not be charged. Please contact us if you'd like to place a standard order. - Kraus Tables & Chairs`,
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
          subject: 'Rush Order Request - Unable to Accommodate',
          html: `
            <h2>Rush Order Request Update</h2>
            <p>Hi ${customerName},</p>
            <p>Unfortunately, we cannot accommodate your rush order request at this time.</p>
            <p><strong>Your payment has been cancelled and you will not be charged.</strong></p>
            <p>If you'd like to place a standard order with more advance notice, please visit our website or contact us directly.</p>
            <p>We apologize for any inconvenience.</p>
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
        message: 'Payment declined and cancelled',
        paymentIntentId: paymentIntent.id,
        status: paymentIntent.status
      })
    };

  } catch (error) {
    console.error('Error declining payment:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to decline payment',
        details: error.message 
      })
    };
  }
};
