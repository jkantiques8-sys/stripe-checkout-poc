// netlify/functions/checkout.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ---- Business settings (mirror the client; server is authoritative) ----
const USD = v => Math.round(v);                // cents already
const UNIT = 1000;                             // $10 per chair => 1000 cents
const EXT_RATE   = 0.15;                       // 15% per extra day
const RUSH_FEE   = 2500;                       // $25 flat
const MIN_ORDER  = 10000;                      // $100 before tax/deposit
const DEPOSIT_RATE = 0.5;                      // 50% of chairs
const TAX_RATE   = 0.08875;                    // 8.875%

const PRICE_MAP = {
  chair_dark:  { name: 'Vintage Folding Chairs — Dark',  unit: UNIT },
  chair_light: { name: 'Vintage Folding Chairs — Light', unit: UNIT }
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
  }

  try {
    const { items = [], pickup_date, return_date, customer = {}, utm = {}, success_url, cancel_url } =
      JSON.parse(event.body || '{}');

    // --- sanitize items & quantities ---
    let qtyDark = 0, qtyLight = 0;
    for (const it of items) {
      const q = Number(it.qty) || 0;
      if (it.sku === 'chair_dark')  qtyDark  = Math.max(0, q);
      if (it.sku === 'chair_light') qtyLight = Math.max(0, q);
    }
    const totalQty = qtyDark + qtyLight;
    if (totalQty <= 0) throw new Error('Please select at least 1 chair.');

    // cap to your business rule (25)
    const MAX_QTY = 25;
    const clampedDark  = Math.min(qtyDark,  MAX_QTY);
    const clampedLight = Math.min(qtyLight, Math.max(0, MAX_QTY - clampedDark));

    const chairsSubtotalC = (clampedDark + clampedLight) * UNIT;

    // --- dates ---
    const toDate = (s)=> s ? new Date(`${s}T00:00:00`) : null;
    const pick = toDate(pickup_date);
    const ret  = toDate(return_date);

    const daysBetween = (a,b)=> Math.round((b-a)/(1000*60*60*24));
    let extDays = 0;
    if (pick && ret) extDays = Math.max(0, daysBetween(pick, ret) - 1);

    // rush: pickup is today (America/New_York)
    let rushC = 0;
    if (pick){
      const now = new Date();
      const ny = new Date(now.toLocaleString('en-US',{ timeZone:'America/New_York'}));
      ny.setHours(0,0,0,0);
      if (daysBetween(ny, pick) === 0) rushC = RUSH_FEE;
    }

    const extFeeC = Math.round(chairsSubtotalC * EXT_RATE * extDays);

    const baseC = chairsSubtotalC + rushC + extFeeC;
    const minC  = Math.max(0, MIN_ORDER - baseC);

    const taxC  = Math.round((baseC + minC) * TAX_RATE);

    const depositC = Math.round(chairsSubtotalC * DEPOSIT_RATE);

    // --- Build line items for Stripe ---
    const line_items = [];

    if (clampedDark > 0) {
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: PRICE_MAP.chair_dark.name },
          unit_amount: PRICE_MAP.chair_dark.unit,
        },
        quantity: clampedDark,
      });
    }
    if (clampedLight > 0) {
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: PRICE_MAP.chair_light.name },
          unit_amount: PRICE_MAP.chair_light.unit,
        },
        quantity: clampedLight,
      });
    }
    if (rushC > 0) {
      line_items.push({
        price_data: { currency: 'usd', product_data: { name: 'Same-day pickup rush' }, unit_amount: rushC },
        quantity: 1,
      });
    }
    if (extFeeC > 0) {
      line_items.push({
        price_data: { currency: 'usd', product_data: { name: `Extended rental (${extDays} days)` }, unit_amount: extFeeC },
        quantity: 1,
      });
    }
    if (minC > 0) {
      line_items.push({
        price_data: { currency: 'usd', product_data: { name: 'Minimum order surcharge (to $100)' }, unit_amount: minC },
        quantity: 1,
      });
    }
    if (taxC > 0) {
      line_items.push({
        price_data: { currency: 'usd', product_data: { name: `Sales tax (${(TAX_RATE*100).toFixed(3)}%)` }, unit_amount: taxC },
        quantity: 1,
      });
    }
    if (depositC > 0) {
      line_items.push({
        price_data: { currency: 'usd', product_data: { name: 'Refundable deposit (50% of chairs)' }, unit_amount: depositC },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: success_url || 'https://example.com/thank-you',
      cancel_url:  cancel_url  || 'https://example.com',
      customer_email: customer.email || undefined,
      metadata: {
        flow: 'self_service',               // identify this flow for the webhook
      
        name:  customer.name  || '',
        phone: customer.phone || '',
      
        qty_dark:  String(clampedDark),
        qty_light: String(clampedLight),
        pickup_date:  pickup_date  || '',
        return_date:  return_date  || '',
        chairs_subtotal_cents: String(chairsSubtotalC),
        rush_cents:    String(rushC),
        ext_days:      String(extDays),
        ext_fee_cents: String(extFeeC),
        min_cents:     String(minC),
        tax_cents:     String(taxC),
      
        // if you’re still passing it:
        // deposit_cents: String(depositC),
      
        ...utm
      }
      
      
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type':'application/json', ...cors },
      body: JSON.stringify({ url: session.url })
    };

  } catch (err) {
    return {
      statusCode: 400,
      headers: cors,
      body: `Bad Request: ${err.message || err}`
    };
  }
};
