// netlify/functions/checkout.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Authoritative price map (USD cents)
const PRICE_MAP = {
  chairs_dark:  { name: 'Vintage Folding Chairs (dark)',  unit: 10_00 },
  chairs_light: { name: 'Vintage Folding Chairs (light)', unit: 10_00 },
};

const MAX_CHAIRS = 25;
const SAME_DAY_RUSH = 25_00;  // $25
const MIN_THRESHOLD = 100_00;  // $100
const EXT_RATE = 0.15;         // 15%/day on chair subtotal
const DEPOSIT_RATE = 0.50;     // 50% of chair subtotal

// CORS helper (loose for preview/dev; tighten to your domain later)
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function ymd(d) {
  return d ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` : '';
}
function parseDate(s){
  if (!s) return null;
  const d = new Date(s + 'T00:00:00');
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function daysBetween(a,b){ return Math.round((b - a)/86400000); }

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: cors };
    }
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
    }

    const {
      mode,
      items = [],
      contact = {},
      pickup_date,
      return_date,
      utm = {},
      success_url,
      cancel_url,
    } = JSON.parse(event.body || '{}');

    if (mode !== 'self_service') {
      return { statusCode: 400, headers: cors, body: 'Unsupported mode' };
    }

    // Rebuild chairs subtotal from trusted price map
    let qtyDark = 0, qtyLight = 0, chairsSubtotal = 0, totalQty = 0;
    const line_items = [];

    for (const it of items) {
      const def = PRICE_MAP[it.sku];
      const qty = Math.max(0, Math.floor(it.qty || 0));
      if (!def || qty === 0) continue;
      totalQty += qty;

      // Accumulate per SKU
      if (it.sku === 'chairs_dark') qtyDark += qty;
      if (it.sku === 'chairs_light') qtyLight += qty;

      chairsSubtotal += (def.unit * qty);

      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: def.name },
          unit_amount: def.unit
        },
        quantity: qty
      });
    }

    if (totalQty === 0) {
      return { statusCode: 400, headers: cors, body: 'No chairs selected' };
    }
    if (totalQty > MAX_CHAIRS) {
      return { statusCode: 400, headers: cors, body: `Max ${MAX_CHAIRS} chairs for self-service` };
    }

    // Dates and fees
    const pDate = parseDate(pickup_date);
    const rDate = parseDate(return_date);
    const today = new Date(); const today0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    if (!pDate || !rDate || rDate <= pDate) {
      return { statusCode: 400, headers: cors, body: 'Invalid dates' };
    }

    const rushFee = (daysBetween(today0, pDate) === 0) ? SAME_DAY_RUSH : 0;

    const nights = Math.max(0, daysBetween(pDate, rDate)); // 1 means "next day"
    const extDays = Math.max(0, nights - 1);
    const extFee = extDays > 0 ? Math.round(chairsSubtotal * EXT_RATE * extDays) : 0;

    const prelim = chairsSubtotal + rushFee + extFee;
    const minAdj = Math.max(0, MIN_THRESHOLD - prelim);

    const deposit = Math.round(chairsSubtotal * DEPOSIT_RATE);

    // Add fee/adjustment/deposit as separate Line Items
    if (rushFee > 0) {
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Same-day pickup rush fee' },
          unit_amount: rushFee
        },
        quantity: 1
      });
    }
    if (extFee > 0) {
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: `Extended rental fee (${extDays} day${extDays===1?'':'s'})` },
          unit_amount: extFee
        },
        quantity: 1
      });
    }
    if (minAdj > 0) {
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Minimum order adjustment' },
          unit_amount: minAdj
        },
        quantity: 1
      });
    }
    if (deposit > 0) {
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Refundable security deposit (50% of chairs)' },
          unit_amount: deposit
        },
        quantity: 1
      });
    }

    const metadata = {
      mode: 'self_service',
      chairs_dark_qty: String(qtyDark),
      chairs_light_qty: String(qtyLight),
      pickup_date: ymd(pDate),
      return_date: ymd(rDate),
      customer_name: (contact.name || '').slice(0, 200),
      customer_phone: (contact.phone || '').slice(0, 100),
      utm_source: utm.utm_source || '',
      utm_medium: utm.utm_medium || '',
      utm_campaign: utm.utm_campaign || ''
    };

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: success_url || 'https://example.com/thanks',
      cancel_url: cancel_url || 'https://example.com',
      customer_email: (contact.email || ''),
      metadata
    });

    return { statusCode: 200, headers: {...cors, 'Content-Type':'application/json'}, body: JSON.stringify({ url: session.url }) };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: cors, body: 'Server error' };
  }
};
