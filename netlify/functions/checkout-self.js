// netlify/functions/checkout.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const crypto = require('crypto');


// --- KRAUS: NY date helpers (server-authoritative) ---
function nyTodayYMD() {
  // Returns YYYY-MM-DD for "today" in America/New_York
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
function parseNYDate(ymd) {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(ymd || "").trim())) return null;
  const [y, m, d] = String(ymd).trim().split("-").map(Number);
  return { y, m, d };
}
function compareYMD(a, b) {
  if (!a || !b) return null;
  if (a.y !== b.y) return a.y < b.y ? -1 : 1;
  if (a.m !== b.m) return a.m < b.m ? -1 : 1;
  if (a.d !== b.d) return a.d < b.d ? -1 : 1;
  return 0;
}
function dayDiffNY(a, b) {
  // Whole calendar-day difference between two {y,m,d} dates
  if (!a || !b) return null;
  const da = Date.UTC(a.y, a.m - 1, a.d);
  const db = Date.UTC(b.y, b.m - 1, b.d);
  return Math.round((db - da) / 86400000);
}

// ---- Business settings (mirror the client; server is authoritative) ----
const USD = v => Math.round(v);                // cents already
const UNIT = 1000;                             // $10 per chair => 1000 cents
const EXT_RATE   = 0.15;                       // 15% per extra day
const RUSH_FEE   = 2500;                       // $25 flat
const MIN_ORDER  = 5000;                      // $50 before tax/deposit
const TAX_RATE   = 0.08875;                    // 8.875%

const PRICE_MAP = {
  chair_dark:  { name: 'Vintage Folding Chairs — Dark',  unit: UNIT },
  chair_light: { name: 'Vintage Folding Chairs — Light', unit: UNIT }
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};
function getBaseOrigin(event) {
  const origin = (event.headers?.origin || event.headers?.Origin || '').trim();
  if (origin) return origin;
  const ref = (event.headers?.referer || event.headers?.Referer || '').trim();
  if (ref) {
    try { return new URL(ref).origin; } catch {}
  }
  const envSite = (process.env.SITE_URL || '').trim();
  if (envSite) {
    try { return new URL(envSite).origin; } catch {}
  }
  try { return new URL('https://example.com').origin; } catch { return 'https://example.com'; }
}

function getAllowedOrigins(event) {
  const origins = new Set();
  const base = getBaseOrigin(event);
  if (base) origins.add(base);

  const envSite = (process.env.SITE_URL || '').trim();
  if (envSite) {
    try { origins.add(new URL(envSite).origin); } catch {}
  }

  const extra = (process.env.ALLOWED_REDIRECT_ORIGINS || '').split(',')
    .map(s => s.trim())
    .filter(Boolean);
  for (const s of extra) {
    try { origins.add(new URL(s).origin); } catch {}
  }
  return origins;
}

function normalizeAndValidateRedirect(urlStr, allowedOrigins, baseOrigin, fieldName) {
  if (!urlStr) return null;
  const s = String(urlStr).trim();
  if (!s) return null;

  let u;
  try {
    u = s.startsWith('/') ? new URL(s, baseOrigin) : new URL(s);
  } catch {
    throw new Error(`Invalid ${fieldName}`);
  }

  if (!allowedOrigins.has(u.origin)) {
    throw new Error(`${fieldName} must be on one of: ${Array.from(allowedOrigins).join(', ')}`);
  }
  return u.toString();
}


exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
  }

  try {
    const { items = [], pickup_date, return_date, customer = {}, utm = {}, success_url, cancel_url, client_order_token } =
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
    // --- dates (NY calendar days; server-authoritative) ---
    const todayNY = parseNYDate(nyTodayYMD());
    const pickupNY = parseNYDate(pickup_date);
    const returnNY = parseNYDate(return_date);

    if (!pickupNY || !returnNY) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid or missing rental dates' }) };
    }
    if (compareYMD(pickupNY, todayNY) < 0) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Pickup date cannot be in the past' }) };
    }
    if (compareYMD(returnNY, pickupNY) < 0) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Return date cannot be before pickup date' }) };
    }

    const rentalDays = dayDiffNY(pickupNY, returnNY);
    const extDays = Math.max(0, (Number.isFinite(rentalDays) ? rentalDays : 0) - 1);

    // rush: pickup is today (America/New_York calendar day)
    let rushC = 0;
    const daysUntilPickup = dayDiffNY(todayNY, pickupNY);
    if (Number.isFinite(daysUntilPickup) && daysUntilPickup === 0) {
      rushC = RUSH_FEE;
    }

    const extFeeC = Math.round(chairsSubtotalC * EXT_RATE * extDays);

    const baseC = chairsSubtotalC + rushC + extFeeC;
    const minC  = Math.max(0, MIN_ORDER - baseC);

    const taxC  = Math.round((baseC + minC) * TAX_RATE);


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
        price_data: { currency: 'usd', product_data: { name: 'Minimum order surcharge (to $50)' }, unit_amount: minC },
        quantity: 1,
      });
    }
    if (taxC > 0) {
      line_items.push({
        price_data: { currency: 'usd', product_data: { name: `Sales tax (${(TAX_RATE*100).toFixed(3)}%)` }, unit_amount: taxC },
        quantity: 1,
      });
    }



    const sessionParams = {
      mode: 'payment',
      payment_intent_data: {
        capture_method: 'manual',   // AUTH ONLY - capture after phone confirmation
      },
      custom_text: {
        submit: {
          message:
            "Clicking Pay places an authorization only. We’ll call within 2 business hours to confirm availability and finalize pickup before any charge is made."
        }
      },
      line_items,
      success_url: safeSuccessUrl,
      cancel_url: safeCancelUrl,
      customer_email: customer.email || undefined,
      metadata: {
        flow: 'self_service',               // identify this flow for the webhook

        // Optional idempotency token passed from the client (helps dedupe accidental retries)
        client_order_token: String(client_order_token || ''),
      
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
      
      
        ...utm
      }
      
      
    };

    // Stripe idempotency: stable key derived from params.
    // Same params => safe retry; different params => different key (prevents Stripe 400 mismatch).
    const idemKey = 'self_' + crypto.createHash('sha256').update(JSON.stringify(sessionParams)).digest('hex').slice(0, 48);

    const session = await stripe.checkout.sessions.create(sessionParams, { idempotencyKey: idemKey });

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
