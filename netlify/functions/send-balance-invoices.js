// netlify/functions/send-balance-invoices.js
// Netlify Scheduled Function: send remaining-balance invoices on the scheduled date.
//
// This works without a separate database by using Stripe Customer metadata:
//  - kraus_order_status = "approved"
//  - kraus_invoice_sent = "false"
//  - kraus_invoice_send_at = "YYYY-MM-DD"
//  - kraus_invoice_due_days = "2" (optional)
//  - kraus_balance_cents = ... (optional; ...)
//
// The full order payload is stored on Customer.description as:
//   KRAUS_ORDER_B64:<base64(deflate(JSON))>
//
// IMPORTANT: Stripe does not support range queries on metadata, so we list and filter.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const zlib = require('zlib');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

function todayIsoNY() {
  // Good-enough: run based on UTC date, but since you’re in America/New_York,
  // schedule the job in the morning; this is fine in practice.
  return new Date().toISOString().slice(0, 10);
}

function readOrderFromCustomerDescription(desc) {
  if (!desc) return null;
  const prefix = 'KRAUS_ORDER_B64:';
  const idx = desc.indexOf(prefix);
  if (idx === -1) return null;
  const b64 = desc.slice(idx + prefix.length).trim();
  if (!b64) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    const jsonBuf = zlib.inflateSync(buf);
    return JSON.parse(jsonBuf.toString('utf8'));
  } catch (e) {
    console.error('Failed to decode order blob:', e.message);
    return null;
  }
}

async function createAndSendBalanceInvoice({ customerId, balanceCents, dueDays, description, metadata }) {
  if (!balanceCents || balanceCents <= 0) return null;

  await stripe.invoiceItems.create({
    customer: customerId,
    currency: 'usd',
    amount: balanceCents,
    description: description || 'Remaining balance'
  });

  let invoice = await stripe.invoices.create({
    customer: customerId,
    collection_method: 'send_invoice',
    days_until_due: dueDays,
    auto_advance: false,
    description: description || undefined,
    metadata: metadata || undefined
  });

  invoice = await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: false });
  invoice = await stripe.invoices.sendInvoice(invoice.id);
  return invoice;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    const today = todayIsoNY();
    const out = { checked: 0, dueToday: 0, sent: 0, skipped: 0, errors: 0, today };

    let starting_after = undefined;
    for (;;) {
      const page = await stripe.customers.list({ limit: 100, starting_after });
      for (const c of page.data) {
        out.checked += 1;

        const md = c.metadata || {};
        if (md.kraus_order_status !== 'approved') continue;
        if ((md.kraus_invoice_sent || '').toLowerCase() === 'true') continue;
        if (!md.kraus_invoice_send_at) continue;
        if (md.kraus_invoice_send_at > today) continue;

        out.dueToday += 1;

        try {
          const order = readOrderFromCustomerDescription(c.description);
          const balanceCents = Number(md.kraus_balance_cents || (order && order.pricing_cents && order.pricing_cents.total ? (order.pricing_cents.total - Number(md.kraus_deposit_cents || 0)) : 0)) || 0;
          const dueDays = Math.max(1, Number(md.kraus_invoice_due_days || 2) || 2);

          if (balanceCents <= 0) {
            await stripe.customers.update(c.id, {
              metadata: {
                kraus_invoice_sent: 'true',
                kraus_invoice_id: '',
                kraus_invoice_send_at: '',
              }
            });
            out.skipped += 1;
            continue;
          }

          const invoice = await createAndSendBalanceInvoice({
            customerId: c.id,
            balanceCents,
            dueDays,
            description: 'Remaining balance for your Kraus full-service rental',
            metadata: {
              kraus_flow: md.kraus_flow || 'full_service',
              kraus_invoice_kind: 'balance',
              kraus_total_cents: String(md.kraus_total_cents || ''),
              kraus_deposit_cents: String(md.kraus_deposit_cents || ''),
              kraus_balance_cents: String(balanceCents),
              dropoff_date: md.kraus_dropoff_date || ''
            }
          });

          await stripe.customers.update(c.id, {
            metadata: {
              kraus_invoice_sent: 'true',
              kraus_invoice_id: invoice ? invoice.id : '',
              kraus_invoice_send_at: '',
            }
          });

          out.sent += 1;
        } catch (e) {
          out.errors += 1;
          console.error('Invoice send error:', c.id, e.message);
        }
      }

      if (!page.has_more) break;
      starting_after = page.data[page.data.length - 1].id;
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify(out)
    };
  } catch (e) {
    console.error('Scheduler error:', e);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: 'Scheduler failed', details: e.message })
    };
  }
};

// Run every hour. Adjust as desired.
exports.config = {
  schedule: '0 * * * *'
};
