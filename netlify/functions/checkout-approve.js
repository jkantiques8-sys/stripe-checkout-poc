const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM_EMAIL = process.env.FROM_EMAIL || "Kraus' Tables & Chairs <orders@kraustables.com>";

const DAY_MS = 24 * 60 * 60 * 1000;

function getEmailOnly(from) {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const params =
      event.httpMethod === 'GET'
        ? event.queryStringParameters
        : JSON.parse(event.body || '{}');

    const { token } = params;
    if (!token) {
      return { statusCode: 400, body: 'Missing token' };
    }

    const session = await stripe.checkout.sessions.retrieve(token);
    const meta = session.metadata || {};

    const customerEmail = meta.customer_email;
    const customerName = meta.customer_name || 'Customer';
    const customerPhone = meta.customer_phone;
    const dropoffDate = meta.dropoff_date;

    const totalCents = Number(meta.total_cents || 0);
    const depositCents = Math.round(totalCents * 0.3);
    const remainingCents = totalCents - depositCents;

    const dropoffTs = new Date(dropoffDate).getTime();
    const now = Date.now();
    const daysUntilDropoff = Math.ceil((dropoffTs - now) / DAY_MS);

    const isRush = daysUntilDropoff <= 1 || meta.is_rush === 'true';

    const customer = await stripe.customers.retrieve(session.customer);

    let chargedNowCents = 0;

    // ===== CHARGE NOW =====
    if (isRush) {
      const pi = await stripe.paymentIntents.create({
        customer: customer.id,
        amount: totalCents,
        currency: 'usd',
        off_session: true,
        confirm: true,
        description: 'Rental payment (paid in full)',
      });
      chargedNowCents = pi.amount;
    } else {
      const pi = await stripe.paymentIntents.create({
        customer: customer.id,
        amount: depositCents,
        currency: 'usd',
        off_session: true,
        confirm: true,
        description: '30% deposit for rental',
      });
      chargedNowCents = pi.amount;
    }

    // ===== AUTOPAY REMAINING (NON-RUSH ONLY) =====
    if (!isRush && remainingCents > 0) {
      const autopayDate = new Date(dropoffTs - DAY_MS);
      autopayDate.setHours(10, 0, 0, 0); // 10am local

      await stripe.invoiceItems.create({
        customer: customer.id,
        amount: remainingCents,
        currency: 'usd',
        description: 'Remaining balance for rental',
      });

      await stripe.invoices.create({
        customer: customer.id,
        collection_method: 'charge_automatically',
        automatically_finalizes_at: Math.floor(autopayDate.getTime() / 1000),
        metadata: {
          kraus_flow: 'full_service',
          dropoff_date: dropoffDate,
        },
      });
    }

    // ===== CUSTOMER APPROVAL EMAIL (PAYMENT-ONLY) =====
    if (resend && customerEmail) {
      const chargedNow = (chargedNowCents / 100).toFixed(2);
      const remaining = isRush ? '0.00' : (remainingCents / 100).toFixed(2);

      let body = `
Hi ${customerName},

Your request has been approved.

Payment processed now: $${chargedNow}
Remaining balance: $${remaining}${!isRush ? ` (for drop-off ${dropoffDate})` : ''}

${!isRush ? 'We will automatically charge the remaining balance the day before your drop-off.' : ''}

If you have any questions, just reply to this email.

– Kraus’ Tables & Chairs
`.trim();

      await resend.emails.send({
        from: FROM_EMAIL,
        to: customerEmail,
        subject: "Your Kraus’ Tables & Chairs request is approved",
        text: body,
      });
    }

    // ===== CUSTOMER SMS (ONE-WAY) =====
    if (customerPhone && process.env.TWILIO_SID) {
      const supportEmail = getEmailOnly(FROM_EMAIL);
      const sms = `
Your Kraus’ Tables & Chairs request is approved.

Automated text — replies are not monitored.
Questions? Email ${supportEmail}.
`.trim();

      await sendSms(customerPhone, sms);
    }

    return {
      statusCode: 200,
      body: 'Approved',
    };
  } catch (err) {
    console.error('Approve error:', err);
    return {
      statusCode: 500,
      body: 'Internal Server Error',
    };
  }
};
