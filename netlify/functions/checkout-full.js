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
const NYC_DELIVERY_RATE = 0.30; // 30% of products subtotal
const TAX_RATE = 0.0875; // NYC sales tax (adjust if needed)

// Minimum order (items + fees before tax) (in cents)
const MIN_ORDER = 40000;

// Rush fee: if drop-off date is within 2 days => $100 or 10% of total (whichever is greater)
const RUSH_FLAT = 10000;
const RUSH_RATE = 0.10;

// Time slot fees (per trip)
const FLEX_4HR_FEE = 7500;      // e.g., 12-4PM
const PROMPT_1HR_FEE = 10000;   // premium 1-hour window
const OFF_HOURS_FEE = 10000;    // off-hours surcharge (if applicable)

// Congestion fee (Manhattan example)
const MANHATTAN_CONGESTION_FEE = 7500;
const MANHATTAN_ZIPS = new Set([
  // example list – keep your actual list here
  '10001','10002','10003','10004','10005','10006','10007','10009','10010',
  '10011','10012','10013','10014','10016','10017','10018','10019','10020',
  '10021','10022','10023','10024','10025','10026','10027','10028','10029',
  '10030','10031','10032','10033','10034','10035','10036','10037','10038',
  '10039','10040','10128','10280'
]);

// Helpers
const parseDate = (s) => {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
};

const daysBetween = (a, b) => {
  const ms = 24 * 60 * 60 * 1000;
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db - da) / ms);
};

const formatHour = (h) => {
  const hour = ((h % 24) + 24) % 24;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}${suffix}`;
};

const formatSlot = (value) => {
  if (!value) return '';
  // expects "8-12" or "12-16" etc
  const [a, b] = String(value).split('-').map(x => parseInt(x, 10));
  if (!isFinite(a) || !isFinite(b)) return String(value);
  return `${formatHour(a)}–${formatHour(b)}`;
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sanitizeUtm(utm) {
  const allowed = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content'
  ];
  const out = {};
  if (!utm || typeof utm !== 'object') return out;
  for (const k of allowed) {
    if (utm[k]) out[k] = String(utm[k]).slice(0, 120);
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  try {
    const body = JSON.parse(event.body || '{}');

    const {
      items = [],
      customer = {},
      location = {},
      schedule = {},
      utm = {},
      success_url,
      cancel_url
    } = body;

    // ---- Validate items ----
    const validItems = [];
    for (const it of items) {
      const sku = String(it.sku || '').trim();
      const qty = Math.max(0, parseInt(it.qty, 10) || 0);
      if (!sku || qty <= 0) continue;
      const cfg = PRICE_MAP[sku];
      if (!cfg) continue;
      validItems.push({
        sku,
        name: cfg.name,
        qty,
        unit: cfg.unit
      });
    }

    if (!validItems.length) {
      return {
        statusCode: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'No valid items in request.' })
      };
    }

    // ---- Pricing: products subtotal ----
    const productsSubtotalC = validItems.reduce((sum, it) => sum + (it.unit * it.qty), 0);

    // ---- Delivery fee ----
    const deliveryC = Math.round(productsSubtotalC * NYC_DELIVERY_RATE);

    // ---- Congestion fee ----
    const zip = String(location.zip || '').trim();
    const congestionC = MANHATTAN_ZIPS.has(zip) ? MANHATTAN_CONGESTION_FEE : 0;

    // ---- Rush fee ----
    const dropoffDate = parseDate(schedule.dropoff_date);
    let rushC = 0;
    if (dropoffDate) {
      const days = daysBetween(new Date(), dropoffDate);
      if (days <= 2) {
        const pct = Math.round((productsSubtotalC + deliveryC + congestionC) * RUSH_RATE);
        rushC = Math.max(RUSH_FLAT, pct);
      }
    }

    // ---- Time slot fees ----
    // expects:
    // schedule.dropoff_timeslot_type = "flex" | "prompt" | "offhours"
    // schedule.dropoff_timeslot_value = "12-16" etc
    // same for pickup
    const dropoffType = String(schedule.dropoff_timeslot_type || '');
    const pickupType = String(schedule.pickup_timeslot_type || '');
    const dropoffTimeslotValue = String(schedule.dropoff_timeslot_value || '');
    const pickupTimeslotValue = String(schedule.pickup_timeslot_value || '');

    const dropoffTimeslotC =
      dropoffType === 'prompt' ? PROMPT_1HR_FEE :
      dropoffType === 'offhours' ? OFF_HOURS_FEE :
      dropoffType === 'flex' ? FLEX_4HR_FEE :
      0;

    const pickupTimeslotC =
      pickupType === 'prompt' ? PROMPT_1HR_FEE :
      pickupType === 'offhours' ? OFF_HOURS_FEE :
      pickupType === 'flex' ? FLEX_4HR_FEE :
      0;

    // ---- Extended rental fee (if you have it in schedule) ----
    const extendedC = Math.max(0, parseInt(schedule.extended_cents, 10) || 0);

    // ---- Minimum order top-up (if needed) ----
    const towardMinC =
      productsSubtotalC +
      deliveryC +
      congestionC +
      rushC +
      dropoffTimeslotC +
      pickupTimeslotC +
      extendedC;

    const minC = Math.max(0, MIN_ORDER - towardMinC);

    // ---- Tax calculation ----
    const taxableC = towardMinC + minC;
    const taxC = Math.round(taxableC * TAX_RATE);

    // ---- Total ----
    const totalC = taxableC + taxC;

    // ---- Create Stripe Checkout session in SETUP mode (save card only; no line_items) ----
    // IMPORTANT FIXES:
    // - payment_method_types: ['card']  => prevents Link/Klarna/etc
    // - setup_intent_data.usage='off_session' => allows later invoice charges / auto-pay
    // - customer_creation:'always' => guarantees a Customer exists
    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      payment_method_types: ['card'],
      customer_creation: 'always',
      setup_intent_data: { usage: 'off_session' },

      success_url: success_url || 'https://example.com/thank-you-full-service',
      cancel_url: cancel_url || 'https://example.com',
      customer_email: customer.email || undefined,

      custom_text: {
        submit: {
          message:
            "This saves your card to reserve your request. We use a 30% deposit and email an invoice for the remaining balance."
        }
      },

      metadata: {
        flow: 'full_service',

        // pricing (cents)
        products_subtotal_cents: String(productsSubtotalC),
        delivery_cents: String(deliveryC),
        congestion_cents: String(congestionC),
        rush_cents: String(rushC),
        dropoff_timeslot_cents: String(dropoffTimeslotC),
        pickup_timeslot_cents: String(pickupTimeslotC),
        extended_cents: String(extendedC),
        min_order_cents: String(minC),
        tax_cents: String(taxC),
        total_cents: String(totalC),

        // schedule
        dropoff_date: String(schedule.dropoff_date || '').slice(0, 50),
        pickup_date: String(schedule.pickup_date || '').slice(0, 50),
        dropoff_timeslot_type: String(dropoffType || '').slice(0, 50),
        dropoff_timeslot_value: String(dropoffTimeslotValue || '').slice(0, 50),
        pickup_timeslot_type: String(pickupType || '').slice(0, 50),
        pickup_timeslot_value: String(pickupTimeslotValue || '').slice(0, 50),

        // customer info
        name: String(customer.name || '').slice(0, 350),
        phone: String(customer.phone || '').slice(0, 350),
        email: String(customer.email || '').slice(0, 350),

        // address
        street: String(location.street || '').slice(0, 350),
        address2: String(location.address2 || '').slice(0, 350),
        city: String(location.city || '').slice(0, 350),
        state: String(location.state || '').slice(0, 350),
        zip: String(location.zip || '').slice(0, 350),
        location_notes: String(location.notes || '').slice(0, 350),

        // items (trim hard)
        items: JSON.stringify(validItems).slice(0, 350),

        // UTM (sanitized)
        ...sanitizeUtm(utm)
      }
    });

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, url: session.url, id: session.id })
    };
  } catch (err) {
    console.error('checkout-full error:', err);
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'Server error' })
    };
  }
};
