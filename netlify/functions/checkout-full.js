// netlify/functions/checkout-full.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ---- Business settings (prices in cents) ----
const USD = v => Math.round(v);

// Product pricing (in cents)
const PRICE_MAP = {
  'table-chair-set': { name: 'Table + 6 Chairs', unit: 16000 },
  'dark': { name: 'Vintage Folding Chairs — Dark', unit: 1000 },
  'light': { name: 'Vintage Folding Chairs — Light', unit: 1000 },
  'folding-table': { name: 'Folding Farm Table', unit: 10000 },
  'end-leaves': { name: 'End Leaves (pair)', unit: 5000 },
  'industrial-bar': { name: 'Industrial Serving Bar', unit: 40000 },
  'industrial-cocktail-table': { name: 'Industrial Cocktail Table', unit: 5000 },
  'garment-rack': { name: 'Industrial Garment Rack', unit: 15000 },
  'coat-rack': { name: 'Vintage Coat Rack', unit: 15000 },
  'side-table': { name: 'Vintage Side Table', unit: 5000 }
};

// Fees (in cents)
const NYC_DELIVERY_RATE = 0.30;
const TAX_RATE = 0.0875;
const MIN_ORDER = 40000;
const RUSH_FLAT = 10000;
const RUSH_RATE = 0.10;

const FLEX_4HR_FEE = 7500;
const PROMPT_1HR_FEE = 10000;
const OFF_HOURS_FEE = 10000;

const MANHATTAN_CONGESTION_FEE = 7500;
const MANHATTAN_ZIPS = new Set([
  '10001','10002','10003','10004','10005','10006','10007','10009','10010',
  '10011','10012','10013','10014','10016','10017','10018','10019','10020',
  '10021','10022','10023','10024','10025','10026','10027','10028','10029',
  '10030','10031','10032','10033','10034','10035','10036','10037','10038',
  '10039','10040','10128','10280'
]);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { items = [], customer = {}, location = {}, schedule = {}, utm = {}, success_url, cancel_url } = body;

    const validItems = items
      .map(it => {
        const cfg = PRICE_MAP[it.sku];
        if (!cfg || it.qty <= 0) return null;
        return { ...cfg, qty: it.qty };
      })
      .filter(Boolean);

    if (!validItems.length) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'No valid items' }) };
    }

    const productsSubtotalC = validItems.reduce((s, it) => s + it.unit * it.qty, 0);
    const deliveryC = Math.round(productsSubtotalC * NYC_DELIVERY_RATE);
    const congestionC = MANHATTAN_ZIPS.has(String(location.zip || '')) ? MANHATTAN_CONGESTION_FEE : 0;
    const taxC = Math.round((productsSubtotalC + deliveryC + congestionC) * TAX_RATE);
    const totalC = productsSubtotalC + deliveryC + congestionC + taxC;

    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      payment_method_types: ['card'],
      customer_creation: 'always',

      success_url: success_url,
      cancel_url: cancel_url,
      customer_email: customer.email || undefined,

      custom_text: {
        submit: {
          message: "This saves your card to reserve your request. We’ll charge a deposit after approval."
        }
      },

      metadata: {
        flow: 'full_service',
        total_cents: String(totalC),
        email: customer.email || '',
        name: customer.name || '',
        phone: customer.phone || '',
        zip: location.zip || '',
        items: JSON.stringify(validItems).slice(0, 350)
      }
    });

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, url: session.url })
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: err.message })
    };
  }
};
