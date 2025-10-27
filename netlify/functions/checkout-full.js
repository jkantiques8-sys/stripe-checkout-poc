// netlify/functions/full-checkout.js
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
const MIN_ORDER = 40000;       // $400 minimum order
const TAX_RATE = 0.08875;      // 8.875%

// Window fees - base fee for 1-hour prompt window
const WINDOW_BASE_FEE = {
  prompt: 10000,  // $100 for 1-hour prompt window
  flex: 0         // $0 for flexible window
};

// Time slot fees for 1-hour prompt windows (in cents)
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

// Time slot fees for 4-hour flex windows (in cents)
const FLEX_FEE = {
  '8-12': 0,     // Morning: $0
  '12-4': 7500,  // Afternoon: $75
  '4-8': 0       // Evening: $0
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
    const { 
      flow, 
      items = [], 
      customer = {}, 
      location = {},
      schedule = {},
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
      ? Math.max(10000, Math.round(productsSubtotalC * 0.10))  // max of $100 or 10% of items
      : 0;

    // --- Window fees ---
    const parseHourStart = (range) => {
      // "6-7" -> 6, "21-22" -> 21, "0-1" -> 0
      const h = parseInt(String(range).split('-')[0], 10);
      return Number.isFinite(h) ? h : null;
    };

    // Dropoff window fee
    const dropoffType = schedule.dropoff_window_type || 'flex';
    const dropoffValue = schedule.dropoff_window_value || '';
    let dropoffWindowC = WINDOW_BASE_FEE[dropoffType] || 0;
    
    if (dropoffType === 'prompt') {
      const h = parseHourStart(dropoffValue);
      dropoffWindowC += (h !== null ? (PROMPT_FEE[h] || 0) : 0);
    } else if (dropoffType === 'flex') {
      dropoffWindowC += FLEX_FEE[dropoffValue] || 0;
    }

    // Pickup window fee (no base fee for prompt if same day)
    const pickupDate = toDate(schedule.pickup_date);
    const sameDay = dropoffDate && pickupDate && 
                    (schedule.dropoff_date === schedule.pickup_date);
    
    const pickupType = schedule.pickup_window_type || 'flex';
    const pickupValue = schedule.pickup_window_value || '';
    let pickupWindowC = 0;
    
    // Only add base fee if NOT (prompt AND same day)
    if (pickupType === 'prompt' && !sameDay) {
      pickupWindowC += WINDOW_BASE_FEE[pickupType] || 0;
    } else if (pickupType === 'flex') {
      pickupWindowC += WINDOW_BASE_FEE[pickupType] || 0;
    }
    
    // Always add time slot fee
    if (pickupType === 'prompt') {
      const h = parseHourStart(pickupValue);
      pickupWindowC += (h !== null ? (PROMPT_FEE[h] || 0) : 0);
    } else if (pickupType === 'flex') {
      pickupWindowC += FLEX_FEE[pickupValue] || 0;
    }

    // --- Extended rental fee (15% per extra day after first day) ---
    const rentalDays = daysBetween(dropoffDate, pickupDate);
    const extraDays = Math.max(0, rentalDays - 1);
    const extendedC = Math.round(productsSubtotalC * EXTENDED_RATE * extraDays);

    // --- Minimum order surcharge ---
    // Minimum includes: items + delivery + rush + window fees + extended
    const towardMinC = productsSubtotalC + deliveryC + rushC + dropoffWindowC + pickupWindowC + extendedC;
    const minC = Math.max(0, MIN_ORDER - towardMinC);

    // --- Tax calculation ---
    const taxableC = towardMinC + minC;
    const taxC = Math.round(taxableC * TAX_RATE);

    // --- Build line items for Stripe ---
    const line_items = [];

    // Add each product
    for (const item of validItems) {
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: item.name },
          unit_amount: item.unit,
        },
        quantity: item.qty,
      });
    }

    // Add delivery fee
    if (deliveryC > 0) {
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Delivery fee (30%)' },
          unit_amount: deliveryC,
        },
        quantity: 1,
      });
    }

    // Add rush fee
    if (rushC > 0) {
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Rush fee (≤2 days)' },
          unit_amount: rushC,
        },
        quantity: 1,
      });
    }

    // Add dropoff window fee
    if (dropoffWindowC > 0) {
      const dropoffLabel = dropoffType === 'prompt' 
        ? `Drop-off: 1-hour window (${dropoffValue})` 
        : `Drop-off: 4-hour window (${dropoffValue})`;
      
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: dropoffLabel },
          unit_amount: dropoffWindowC,
        },
        quantity: 1,
      });
    }

    // Add pickup window fee
    if (pickupWindowC > 0) {
      const pickupLabel = pickupType === 'prompt' 
        ? `Pickup: 1-hour window (${pickupValue})` 
        : `Pickup: 4-hour window (${pickupValue})`;
      
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: pickupLabel },
          unit_amount: pickupWindowC,
        },
        quantity: 1,
      });
    }

    // Add extended rental fee
    if (extendedC > 0) {
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: `Extended rental (${extraDays} day${extraDays !== 1 ? 's' : ''})` },
          unit_amount: extendedC,
        },
        quantity: 1,
      });
    }

    // Add minimum order surcharge if needed
    if (minC > 0) {
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Minimum order surcharge (to $400)' },
          unit_amount: minC,
        },
        quantity: 1,
      });
    }

    // Add tax
    if (taxC > 0) {
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: `Sales tax (${(TAX_RATE * 100).toFixed(3)}%)` },
          unit_amount: taxC,
        },
        quantity: 1,
      });
    }

    // --- Create Stripe checkout session ---
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: success_url || 'https://example.com/thank-you',
      cancel_url: cancel_url || 'https://example.com',
      customer_email: customer.email || undefined,
      metadata: {
        flow: 'full_service',
        name: customer.name || '',
        phone: customer.phone || '',
        email: customer.email || '',
        // Location
        street: location.street || '',
        address2: location.address2 || '',
        city: location.city || '',
        state: location.state || '',
        zip: location.zip || '',
        location_notes: (location.notes || '').substring(0, 500), // Stripe metadata limit
        // Schedule
        dropoff_date: schedule.dropoff_date || '',
        dropoff_window_type: schedule.dropoff_window_type || '',
        dropoff_window_value: schedule.dropoff_window_value || '',
        pickup_date: schedule.pickup_date || '',
        pickup_window_type: schedule.pickup_window_type || '',
        pickup_window_value: schedule.pickup_window_value || '',
        // Products (store as JSON string, truncated if needed)
        items: JSON.stringify(validItems).substring(0, 500),
        // Pricing breakdown
        products_subtotal_cents: String(productsSubtotalC),
        delivery_cents: String(deliveryC),
        rush_cents: String(rushC),
        dropoff_window_cents: String(dropoffWindowC),
        pickup_window_cents: String(pickupWindowC),
        extra_days: String(extraDays),
        extended_cents: String(extendedC),
        min_order_cents: String(minC),
        tax_cents: String(taxC),
        total_cents: String(taxableC + taxC),
        ...utm
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
