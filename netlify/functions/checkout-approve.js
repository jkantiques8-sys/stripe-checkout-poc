// netlify/functions/checkout-approve.js
// Approve a request:
// - Full-service: charge 30% deposit immediately (off-session), create draft invoice for remaining balance,
//               send now if drop-off <= 7 days else scheduled via send-balance-invoices
// - Self-serve: charge 100% immediately (off-session), no invoice
//
// Requires env vars:
// STRIPE_SECRET_KEY
// (optional) TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
// (optional) RESEND_API_KEY, EMAIL_FROM, EMAIL_OWNER
//
// This function expects a request body that includes at minimum:
// { checkout_session_id: "cs_..." }
//
// It retrieves metadata from the Checkout Session (setup mode) to compute totals.

const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2025-09-30.clover'
});

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders
    },
    body: JSON.stringify(body)
  };
}

function getCorsHeaders(origin) {
  // Keep permissive for now since you're calling from Squarespace/static
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}

function cents(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x);
}

function formatUSD(centsVal) {
  const v = (Number(centsVal || 0) / 100).toFixed(2);
  return `$${v}`;
}

function getTwilioClient() {
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) return null;
    // eslint-disable-next-line global-require
    const twilio = require('twilio');
    return twilio(sid, token);
  } catch (e) {
    return null;
  }
}

async function sendEmailApproved({ to, customerName, depositCents, balanceCents, dropoffDate, invoiceHostedUrl }) {
  // Uses Resend if configured; otherwise no-op
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'orders@kraustables.com';
  const owner = process.env.EMAIL_OWNER || from;

  if (!apiKey) return;

  // eslint-disable-next-line global-require
  const { Resend } = require('resend');
  const resend = new Resend(apiKey);

  const subject = `Your Kraus' Tables & Chairs request is approved`;
  const lines = [];

  lines.push(`Hi ${customerName || 'there'},`);
  lines.push('');
  lines.push('Your request has been approved.');
  lines.push('');
  lines.push(`Deposit charged: ${formatUSD(depositCents)}`);
  lines.push('');
  lines.push(`Remaining balance: ${formatUSD(balanceCents)}${dropoffDate ? ` (for drop-off ${dropoffDate})` : ''}`);
  lines.push('');

  if (balanceCents > 0) {
    if (invoiceHostedUrl) {
      lines.push(`Pay your remaining balance here:`);
      lines.push(invoiceHostedUrl);
    } else {
      lines.push(`Your remaining balance will be invoiced by email.`);
    }
  } else {
    lines.push('No remaining balance is due.');
  }

  lines.push('');
  lines.push('If you have any questions, just reply to this email.');
  lines.push('');
  lines.push('– Kraus’ Tables & Chairs');

  await resend.emails.send({
    from,
    to: [to, owner],
    subject,
    text: lines.join('\n')
  });
}

async function sendEmailDepositPaymentLink({ to, customerName, depositCents, paymentUrl }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'orders@kraustables.com';
  const owner = process.env.EMAIL_OWNER || from;

  if (!apiKey) return;

  // eslint-disable-next-line global-require
  const { Resend } = require('resend');
  const resend = new Resend(apiKey);

  const subject = `Action needed: confirm your deposit payment`;
  const lines = [];

  lines.push(`Hi ${customerName || 'there'},`);
  lines.push('');
  lines.push('Your request has been approved, but your deposit could not be charged automatically.');
  lines.push('');
  lines.push(`Deposit due: ${formatUSD(depositCents)}`);
  lines.push('');
  lines.push('Please complete your deposit payment here:');
  lines.push(paymentUrl);
  lines.push('');
  lines.push('If you have any questions, just reply to this email.');
  lines.push('');
  lines.push('– Kraus’ Tables & Chairs');

  await resend.emails.send({
    from,
    to: [to, owner],
    subject,
    text: lines.join('\n')
  });
}

exports.handler = async (event) => {
  const cors = getCorsHeaders(event.headers?.origin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' }, cors);
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const sessionId = body.checkout_session_id;

    if (!sessionId) {
      return json(400, { error: 'Missing checkout_session_id' }, cors);
    }

    // Retrieve Checkout Session (setup mode)
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['customer', 'setup_intent']
    });

    const md = session.metadata || {};
    const flow = md.flow || 'full_service';

    const customerId = session.customer?.id || session.customer;
    const customerEmail = md.email || session.customer_details?.email || session.customer?.email;
    const customerName = md.name || session.customer_details?.name || session.customer?.name;
    const customerPhone = md.phone || session.customer_details?.phone;

    if (!customerId) {
      return json(400, { error: 'No customer found on session' }, cors);
    }
    if (!customerEmail) {
      return json(400, { error: 'No customer email found (metadata.email or customer_details.email)' }, cors);
    }

    const setupIntentId = session.setup_intent?.id || session.setup_intent;
    if (!setupIntentId) {
      return json(400, { error: 'No setup_intent found on checkout session' }, cors);
    }

    // Get the PaymentMethod saved
    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId, {
      expand: ['payment_method']
    });
    const paymentMethodId = setupIntent.payment_method?.id || setupIntent.payment_method;

    if (!paymentMethodId) {
      return json(400, { error: 'No payment_method attached to setup_intent' }, cors);
    }

    // Totals come from metadata (locked architecture: Stripe APIs only, no DB)
    const totalCents = cents(md.total_cents);
    const dropoffDateStr = md.dropoff_date || '';
    const dropoffDate = dropoffDateStr ? new Date(dropoffDateStr) : null;

    if (!totalCents || totalCents <= 0) {
      return json(400, { error: 'Invalid total_cents in metadata' }, cors);
    }

    const now = new Date();
    const daysUntilDropoff = dropoffDate ? Math.ceil((dropoffDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)) : 999;

    // Amount to charge now
    const chargeCents = flow === 'self_service' ? totalCents : Math.round(totalCents * 0.30);
    const depositCents = flow === 'self_service' ? totalCents : chargeCents;
    const balanceCents = Math.max(0, totalCents - depositCents);

    // Ensure the PaymentMethod is attached/defaulted
    await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId }).catch(() => {});
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId }
    });

    // Charge now (off-session)
    let pi;
    try {
      pi = await stripe.paymentIntents.create({
        amount: chargeCents,
        currency: 'usd',
        customer: customerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        description:
          flow === 'self_service'
            ? 'Full payment for approved self-serve rental request'
            : '30% deposit for approved rental request',
        metadata: {
          flow,
          checkout_session_id: sessionId,
          setup_intent_id: setupIntentId,
          total_cents: String(totalCents),
          deposit_cents: String(depositCents),
          balance_cents: String(balanceCents),
          dropoff_date: dropoffDateStr || ''
        }
      });
    } catch (err) {
      // If off-session charge fails, email a payment link for the deposit
      const paySession = await stripe.checkout.sessions.create({
        mode: 'payment',
        success_url: md.success_url || `${md.origin || 'https://kraustables.com'}/thank-you`,
        cancel_url: md.cancel_url || `${md.origin || 'https://kraustables.com'}/full-service`,
        customer: customerId,
        customer_email: customerEmail,
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: flow === 'self_service' ? 'Payment due (self-serve)' : 'Deposit due (30%)'
              },
              unit_amount: chargeCents
            },
            quantity: 1
          }
        ],
        payment_method_types: ['card'],
        metadata: {
          flow,
          checkout_session_id: sessionId,
          setup_intent_id: setupIntentId,
          total_cents: String(totalCents),
          deposit_cents: String(depositCents),
          balance_cents: String(balanceCents),
          dropoff_date: dropoffDateStr || ''
        }
      });

      await sendEmailDepositPaymentLink({
        to: customerEmail,
        customerName,
        depositCents,
        paymentUrl: paySession.url
      });

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({
          success: false,
          message: 'Deposit charge failed; payment link emailed',
          payment_url: paySession.url
        })
      };
    }

    // If self-serve, we are done (no invoice)
    let invoiceHostedUrl = null;
    let invoiceId = null;

    if (flow !== 'self_service' && balanceCents > 0) {
      // We want an invoice for the REMAINING balance.
      // If we have a breakdown for the *full* total, we can show it and include a "Deposit paid" credit.
      // If we *don't* have that breakdown (common when metadata isn't wired yet), we MUST NOT create
      // a credit-only invoice (Stripe will treat it as $0 and mark it paid).

      const breakdownItems = [];
      const addLine = (label, centsVal) => {
        const n = Number(centsVal || 0);
        if (!Number.isFinite(n) || n <= 0) return;
        breakdownItems.push({ label, cents: n });
      };

      addLine('Rental items', md.products_subtotal_cents);
      addLine('Delivery fee', md.delivery_cents);
      addLine('Manhattan surcharge', md.congestion_cents);
      addLine('Rush fee', md.rush_cents);
      addLine('Drop-off time slot', md.dropoff_timeslot_cents);
      addLine('Pickup time slot', md.pickup_timeslot_cents);
      addLine('Extended rental', md.extended_cents);
      addLine('Minimum order surcharge', md.min_order_cents);
      addLine('Sales tax', md.tax_cents);

      const breakdownSum = breakdownItems.reduce((sum, it) => sum + it.cents, 0);
      const breakdownLooksComplete = breakdownSum > 0 && Math.abs(breakdownSum - totalCents) <= 2; // allow 1–2¢ rounding

      const shouldSendNow = daysUntilDropoff <= 7;
      const sendTs = (() => {
        if (shouldSendNow) return Math.floor(Date.now() / 1000);
        if (!dropoffDate) return 0;
        const sendDate = new Date(dropoffDate.getTime() - 7 * 24 * 60 * 60 * 1000);
        // send at 9am local-ish (server time)
        sendDate.setHours(9, 0, 0, 0);
        return Math.floor(sendDate.getTime() / 1000);
      })();

      // Always keep invoice in draft until we explicitly send it.
      const invoice = await stripe.invoices.create({
        customer: customerId,
        collection_method: 'send_invoice',
        days_until_due: shouldSendNow ? 1 : 2,
        auto_advance: false,
        metadata: {
          kraus_flow: flow,
          checkout_session_id: sessionId,
          setup_intent_id: setupIntentId,
          deposit_payment_intent_id: pi.id,
          dropoff_date: dropoffDateStr || '',
          total_cents: String(totalCents),
          deposit_cents: String(depositCents),
          balance_cents: String(balanceCents),
          kraus_send_ts: sendTs ? String(sendTs) : ''
        }
      });

      invoiceId = invoice.id;

      if (breakdownLooksComplete) {
        // Attach the FULL breakdown to the invoice, then subtract deposit as a credit.
        for (const it of breakdownItems) {
          await stripe.invoiceItems.create({
            customer: customerId,
            invoice: invoice.id,
            currency: 'usd',
            amount: it.cents,
            description: it.label
          });
        }

        await stripe.invoiceItems.create({
          customer: customerId,
          invoice: invoice.id,
          currency: 'usd',
          amount: -depositCents,
          description: 'Deposit paid'
        });
      } else {
        // No reliable breakdown: create a single line item for the remaining balance ONLY.
        await stripe.invoiceItems.create({
          customer: customerId,
          invoice: invoice.id,
          currency: 'usd',
          amount: balanceCents,
          description: 'Remaining balance (after deposit)'
        });
      }

      if (shouldSendNow) {
        const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
        const sent = await stripe.invoices.sendInvoice(finalized.id);
        invoiceHostedUrl = sent.hosted_invoice_url || null;
      }
    }

    // Notifications (optional)
    const twilio = getTwilioClient();
    if (twilio && customerPhone && process.env.TWILIO_PHONE_NUMBER) {
      try {
        await twilio.messages.create({
          body: `Great news${customerName ? ' ' + customerName : ''}! Your request is approved. ${
            flow === 'self_service' ? 'Payment' : 'Deposit'
          } has been charged.`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: customerPhone
        });
      } catch (e) {
        console.warn('Twilio SMS failed:', e.message);
      }
    }

    await sendEmailApproved({
      to: customerEmail,
      customerName,
      depositCents,
      balanceCents,
      dropoffDate: dropoffDateStr,
      invoiceHostedUrl
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({
        success: true,
        flow,
        deposit_cents: depositCents,
        balance_cents: balanceCents,
        invoice_id: invoiceId,
        invoice_hosted_url: invoiceHostedUrl,
        payment_intent_id: pi.id
      })
    };
  } catch (err) {
    console.error('checkout-approve error:', err);
    return json(500, { error: err.message || 'Server error' }, getCorsHeaders(event.headers?.origin));
  }
};
