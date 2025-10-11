// netlify/functions/checkout.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',     // pin API version to avoid “Unsupported mode”
});

const PRICE_MAP = {
  chairs_dark:  { name: 'Vintage Folding Chairs — Dark',  unit: 1000 }, // cents
  chairs_light: { name: 'Vintage Folding Chairs — Light', unit: 1000 },
};

// VERY simple CORS for testing (tighten to your domain when you publish)
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { items = [], customer = {}, success_url, cancel_url, utm, pickup_date, return_date, agree } = body;

    // Build line_items strictly from server-side price map
    const line_items = [];
    for (const i of items) {
      const def = PRICE_MAP[i.sku];
      const qty = Number(i.qty) || 0;
      if (!def || qty <= 0) continue;
      line_items.push({
        quantity: qty,
        price_data: {
          currency: 'usd',
          unit_amount: def.unit,
          product_data: { name: def.name },
        },
      });
    }
    if (line_items.length === 0) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Cart empty' }) };
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: success_url || 'https://example.com/success',
      cancel_url:  cancel_url  || 'https://example.com/cancel',
      customer_email: customer.email || undefined,
      metadata: {
        name: customer.name || '',
        phone: customer.phone || '',
        pickup_date: pickup_date || '',
        return_date: return_date || '',
        agree: agree ? 'yes' : 'no',
        utm: utm || '',
      },
      // enable card automatically with the current API version
      payment_method_types: ['card'],
    });

    return { statusCode: 200, headers: cors, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: `API ${err.statusCode || 400}: ${err.message}` }) };
  }
};
