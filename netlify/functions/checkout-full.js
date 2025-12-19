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
  'ASH-NYC-steel-table': { name: 'ASH NYC Standard Steel Table', unit: 40000 },
  'MCM-etched-tulip-table': { name: 'MCM Etched Tulip Table', unit: 25000 },
  'antique-work-bench': { name: 'Antique Work Bench', unit: 40000 },
  'vintage-drafting-table': { name: 'Vintage Drafting Table', unit: 10000 },
  'industrial-garment-rack': { name: 'Industrial Garment Rack', unit: 10000 }
};

// Fee rates
const DELIVERY_RATE = 0.30;    // 30% of items subtotal
const EXTENDED_RATE = 0.15;    // 15% per extra day
const MIN_ORDER = 30000;       // $300 minimum order
const TAX_RATE = 0.08875;      // 8.875%

// Manhattan congestion surcharge
const CONGESTION_FEE_CENTS = 7500; // $75
const MANHATTAN_ZIPS = [
  "10001","10002","10003","10004","10005","10006","10007","10009","10010","10011","10012","10013","10014",
  "10016","10017","10018","10019","10020","10021","10022","10023","10024","10025","10026","10027","10028","10029",
  "10030","10031","10032","10033","10034","10035","10036","10037","10038","10039","10040",
  "10044",
  "10065","10075","10128",
  "10280","10281","10282"
];

function normalizeZip(zip) {
  // Supports "10001" and "10001-1234"
  return String(zip || '').trim().slice(0, 5);
}

function isManhattanZip(zip) {
  const z = normalizeZip(zip);
  return z.length === 5 && MANHATTAN_ZIPS.includes(z);
}

// Time slot fees - base fee for 1-hour prompt time slot
const TIMESLOT_BASE_FEE = {
  prompt: 10000,  // $100 for 1-hour prompt time slot
  flex: 0         // $0 for flexible time slot
};

// Time slot fees for 1-hour prompt time slots (in cents)
const PROMPT_FEE = {
  6: 7500,   // 6-7am: $75
  7: 5000,   // 7-8am: $50
  8: 2500,   // 8-9am: $25
  9: 0, 10: 0, 11: 0, 12: 0, 13: 0, 14: 0, 15: 0, 16: 0, 17: 0, 18: 0, 19: 0, 20: 0,
  21: 2500,  // 9-10pm: $25
  22: 5000,  // 10-11pm: $50
  23: 5000,  // 11pm-12am: $50
  0: 7500    // 12-1am: $75
};

// Time slot fees for 4-hour flex time slots (in cents)
const FLEX_FEE = {
  '8-12': 0,     // Morning: $0
  '12-4': 5000,  // Afternoon: $50
  '4-8': 0       // Evening: $0
};

// Helper function to format time slot value to 12-hour AM/PM format
const formatTimeSlot = (value) => {
  if (!value) return value;

  const flexMap = {
    '8-12': '8AM–12PM',
    '12-4': '12PM–4PM',
    '4-8': '4PM–8PM'
  };

  if (flexMap[value]) return flexMap[value];

  const match = /^(\d{1,2})-(\d{1,2})$/.exec(String(value).trim());
  if (!match) return value;

  const [, startStr, endStr] = match;
  const start = Number(startStr);
  const end = Number(endStr);

  const formatHour = (h) => {
    const normalized = ((h % 24) + 24) % 24;
    const suffix = normalized >= 12 ? 'PM' : 'AM';
    const hour12 = normalized % 12 === 0 ? 12 : normalized % 12;
    return `${hour12}${suffix}`;
  };

  return `${formatHour(start)}–${formatHour(end)}`;
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
    'utm_content',
    'gclid',
    'fbclid'
  ];
  const out = {};
  if (!utm || typeof utm !== 'object') return out;
  for (const key of allowed) {
    if (utm[key] == null) continue;
    out[key] = String(utm[key]).slice(0, 350);
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
  }

  try {
    const {
      flow,
      items = [],
      customer = {},
      location = {},
      schedule = {},
      isRush = false, // kept (not required)
      utm = {},
      success_url,
      cancel_url
    } = JSON.parse(event.body || '{}');

    // Validate flow
    if (flow !== 'full_service') {
      throw new Error('Invalid flow: expected full_service');
    }

    // --- Calculate products subtotal ---
    let productsSubtotalC = 0;
    const validItems = [];

    for (const item of items) {
      const sku = item.sku;
      const qty = Math.max(0, Number(item.qty) || 0);

      if (qty > 0 && PRICE_MAP[sku]) {
        const priceInfo = PRICE_MAP[sku];
        productsSubtotalC += priceInfo.unit * qty;
        validItems.push({ sku, qty, unit: priceInfo.unit, name: priceInfo.name });
      }
    }

    if (validItems.length === 0) {
      throw new Error('Please select at least 1 item.');
    }

    // --- Calculate delivery fee (30% of items) ---
    const deliveryC = Math.round(productsSubtotalC * DELIVERY_RATE);

    // --- Manhattan congestion surcharge (flat $75 for Manhattan ZIPs) ---
    const zip5 = normalizeZip(location.zip);
    const congestionC = isManhattanZip(zip5) ? CONGESTION_FEE_CENTS : 0;

    // --- Rush fee (if drop-off is within 2 days) ---
    const toDate = (s) => s ? new Date(`${s}T00:00:00`) : null;
    const dropoffDate = toDate(schedule.dropoff_date);
    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);

    const daysBetween = (a, b) => {
      if (!a || !b) return 0;
      return Math.max(0, Math.round((b - a) / (1000 * 60 * 60 * 24)));
    };

    const daysUntilDropoff = daysBetween(todayDate, dropoffDate);
    const rushC = (dropoffDate && daysUntilDropoff <= 2)
      ? Math.max(10000, Math.round(productsSubtotalC * 0.10))
      : 0;

    // --- Time slot fees ---
    const parseHourStart = (range) => {
      const h = parseInt(String(range).split('-')[0], 10);
      return Number.isFinite(h) ? h : null;
    };

    // Dropoff time slot fee
    const dropoffType = schedule.dropoff_timeslot_type || 'flex';
    const dropoffValue = schedule.dropoff_timeslot_value || '';
    let dropoffTimeslotC = TIMESLOT_BASE_FEE[dropoffType] || 0;

    if (dropoffType === 'prompt') {
      const h = parseHourStart(dropoffValue);
      dropoffTimeslotC += (h !== null ? (PROMPT_FEE[h] || 0) : 0);
    } else if (dropoffType === 'flex') {
      dropoffTimeslotC += FLEX_FEE[dropoffValue] || 0;
    }

    // Pickup time slot fee (no base fee for prompt if same day)
    const pickupDate = toDate(schedule.pickup_date);
    const sameDay = dropoffDate && pickupDate &&
                    (schedule.dropoff_date === schedule.pickup_date);

    const pickupType = schedule.pickup_timeslot_type || 'flex';
    const pickupValue = schedule.pickup_timeslot_value || '';
    let pickupTimeslotC = 0;

    if (pickupType === 'prompt' && !sameDay) {
      pickupTimeslotC += TIMESLOT_BASE_FEE[pickupType] || 0;
    } else if (pickupType === 'flex') {
      pickupTimeslotC += TIMESLOT_BASE_FEE[pickupType] || 0;
    }

    if (pickupType === 'prompt') {
      const h = parseHourStart(pickupValue);
      pickupTimeslotC += (h !== null ? (PROMPT_FEE[h] || 0) : 0);
    } else if (pickupType === 'flex') {
      pickupTimeslotC += FLEX_FEE[pickupValue] || 0;
    }

    // --- Extended rental fee (15% per extra day after first day) ---
    const rentalDays = daysBetween(dropoffDate, pickupDate);
    const extraDays = Math.max(0, rentalDays - 1);
    const extendedC = Math.round(productsSubtotalC * EXTENDED_RATE * extraDays);

    // --- Minimum order surcharge ---
    const towardMinC =
      productsSubtotalC +
      deliveryC +
      congestionC +
      rushC +
      dropoffTimeslotC +
      pickupTimeslotC +
      extendedC;

    const minC = Math.max(0, MIN_ORDER - towardMinC);

    // --- Tax calculation ---
    const taxableC = towardMinC + minC;
    const taxC = Math.round(taxableC * TAX_RATE);

    // --- Total ---
    const totalC = taxableC + taxC;

    // ✅ Ensure a Stripe Customer exists so SetupIntent.customer is populated reliably
    const customerEmail = (customer.email || '').trim();
    const customerName = (customer.name || '').trim();
    const customerPhone = (customer.phone || '').trim();

    if (!customerEmail) {
      throw new Error('Customer email is required.');
    }

    const stripeCustomer = await stripe.customers.create({
      email: customerEmail,
      name: customerName || undefined,
      phone: customerPhone || undefined,
      metadata: {
        flow: 'full_service',
        dropoff_date: schedule.dropoff_date || '',
        pickup_date: schedule.pickup_date || '',
        zip: String(location.zip || '').slice(0, 50)
      }
    });

    // --- Create Stripe Checkout session in SETUP mode (save card only; no line_items) ---
    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      currency: 'usd',                 // ✅ required for setup mode w/ dynamic PMs
      payment_method_types: ['card'],  // ✅ keeps UI "Reserve with card" (no Klarna/Cash App/etc.)

      success_url: success_url || 'https://example.com/thank-you-full-service',
      cancel_url: cancel_url || 'https://example.com',

      // ✅ attach the Customer so SI has customer + approve/invoicing is stable
      customer: stripeCustomer.id,

      custom_text: {
        submit: {
          message:
            "This saves your card to reserve your request. We usually confirm availability within ~2 hours. If approved, we’ll charge a 30% deposit and email an invoice for the remaining balance."
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
        dropoff_date: schedule.dropoff_date || '',
        dropoff_timeslot_type: schedule.dropoff_timeslot_type || '',
        dropoff_timeslot_value: schedule.dropoff_timeslot_value || '',
        pickup_date: schedule.pickup_date || '',
        pickup_timeslot_type: schedule.pickup_timeslot_type || '',
        pickup_timeslot_value: schedule.pickup_timeslot_value || '',

        // customer + location (trimmed)
        name: String(customerName || '').slice(0, 350),
        phone: String(customerPhone || '').slice(0, 350),
        email: String(customerEmail || '').slice(0, 350),
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
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ url: session.url })
    };

  } catch (err) {
    console.error('Full-checkout error:', err);
    return {
      statusCode: 400,
      headers: cors,
      body: `Bad Request: ${err.message || err}`
    };
  }
};
