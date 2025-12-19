// netlify/functions/send-balance-invoices.js
// Scheduled function: finalizes + sends draft invoices when their scheduled send time is reached.
const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };

  try {
    const now = Math.floor(Date.now() / 1000);
    let sentCount = 0;
    let checked = 0;
    let starting_after = null;

    // Paginate through draft invoices (small businesses: this is fine)
    while (true) {
      const page = await stripe.invoices.list({
        status: 'draft',
        limit: 100,
        ...(starting_after ? { starting_after } : {})
      });

      if (!page.data || page.data.length === 0) break;

      for (const inv of page.data) {
        if (inv.status !== 'draft') continue; // defensive
        checked += 1;

        const md = inv.metadata || {};
        if (md.kraus_flow !== 'full_service') continue;

        const sendTs = Number(md.kraus_send_ts || 0);
        if (!Number.isFinite(sendTs) || sendTs <= 0) continue;

        if (sendTs > now) {
          console.log(`Skipping ${inv.id} — scheduled for ${sendTs} (now=${now})`);
          continue;
        }

        // finalize + send
        const finalized = await stripe.invoices.finalizeInvoice(inv.id);
        await stripe.invoices.sendInvoice(finalized.id);
        sentCount += 1;
      }

      if (!page.has_more) break;
      starting_after = page.data[page.data.length - 1].id;
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ ok: true, checked, sent: sentCount })
    };
  } catch (err) {
    console.error('send-balance-invoices error:', err);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};
