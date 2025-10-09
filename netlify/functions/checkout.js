// netlify/functions/checkout.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Authoritative price map (server trusts only these)
const PRICE_MAP = {
  chairs: { name: 'Vintage Folding Chairs', unit: 10_00 },  // cents
  tables: { name: 'Folding Farm Tables',    unit: 100_00 }
};

exports.handler = async (event) => {
  // CORS for Squarespace preview/live; tighten to your domain later
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors() };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors(), body: 'Method Not Allowed' };
  }

  try {
    const { items = [], utm = {}, success_url, cancel_url } = JSON.parse(event.body || '{}');

    // Build Stripe line_items from trusted PRICE_MAP
    const line_items = [];
    let total = 0;
    for (const i of items) {
      const def = PRICE_MAP[i.sku];
      const qty = Number(i.qty || 0);
      if (!def || qty <= 0) continue;
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: def.name },
          unit_amount: def.unit
        },
        quantity: qty
      });
      total += def.unit * qty;
    }
    if (line_items.length === 0) {
      return json(400, { error: 'No valid items' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: success_url || 'https://example.com/thank-you',
      cancel_url:  cancel_url  || 'https://example.com/',
      customer_creation: 'always',
      phone_number_collection: { enabled: true },
      shipping_address_collection: { allowed_countries: ['US'] },
      payment_intent_data: {
        metadata: {
          // UTM trail
          utm_source: utm.source || '',
          utm_medium: utm.medium || '',
          utm_campaign: utm.campaign || '',
          utm_content: utm.content || '',
          utm_term: utm.term || '',
          // Simple order echo for quick visibility
          order_items: items.map(i => `${i.sku}:${i.qty}`).join(','),
          order_total_cents: String(total)
        }
      }
    });

    return json(200, { url: session.url });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'server_error' });
  }
};

function cors(){
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST,OPTIONS'
  };
}
function json(status, obj){
  return { statusCode: status, headers: cors(), body: JSON.stringify(obj) };
}
