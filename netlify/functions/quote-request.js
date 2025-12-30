// netlify/functions/quote-request.js
// Request-only fallback endpoint:
// - Receives JSON payload from Squarespace forms
// - Emails OWNER + CUSTOMER via Resend
// - No Stripe checkout, no DB
//
// Supports your current snake_case payload keys:
//   customer.{name,phone,email}
//   location.{street,address2,city,state,zip,notes}
//   schedule.{dropoff_date,dropoff_timeslot_type,dropoff_timeslot_value, pickup_date, ...}
//   items[{sku,qty}]  (optionally: name, unitPrice, lineTotal)
//   pricing.{items,delivery,rush,congestion,dropFee,pickFee,extraDays,extended,minFee,tax,total,isRush,deposit,remaining}

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers });

const safe = (v) => (v === null || v === undefined ? "" : String(v));
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());

const fmtMoney = (v) => {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return safe(v);
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
};

// ✅ EDIT THIS MAP to match your current catalog pricing.
// These are unit prices (per 1 qty).
const SKU_PRICE_MAP = {
  "table-chair-set": 160,
  "vintage-drafting-table": 275,
  "industrial-garment-rack": 175,
  // Add the rest of your SKUs here:
  // "vintage-folding-chair-dark": 12,
  // "vintage-folding-chair-light": 12,
  // "handmade-banquet-table-6ft": 195,
};

const titleizeSku = (skuRaw) => {
  const sku = safe(skuRaw).trim();
  if (!sku) return "";

  const map = {
    "table-chair-set": "Table + Chair Set",
    "vintage-drafting-table": "Vintage Drafting Table",
    "industrial-garment-rack": "Industrial Garment Rack",
  };
  if (map[sku]) return map[sku];

  const words = sku.replace(/[_-]+/g, " ").split(" ").filter(Boolean);
  return words
    .map((w) => {
      const up = w.toUpperCase();
      if (["NYC", "MCM", "ASH"].includes(up)) return up;
      if (w.length <= 2) return up;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
};

const getSchedule = (p) => {
  const s = p?.schedule || {};
  const dropDate = s.dropoff_date || s.dropoffDate || "";
  const pickDate = s.pickup_date || s.pickupDate || "";

  const dropType = s.dropoff_timeslot_type || s.dropoffTimeslotType || "";
  const dropVal = s.dropoff_timeslot_value || s.dropoffTimeslotValue || "";

  const pickType = s.pickup_timeslot_type || s.pickupTimeslotType || "";
  const pickVal = s.pickup_timeslot_value || s.pickupTimeslotValue || "";

  const humanSlot = (type, val) => {
    if (!type && !val) return "";
    if (type === "flex" && val) return `Flexible window (${val})`;
    if (type && val) return `${type}: ${val}`;
    return val || type;
  };

  return {
    dropDate: safe(dropDate),
    dropWindow: humanSlot(safe(dropType), safe(dropVal)),
    pickDate: safe(pickDate),
    pickWindow: humanSlot(safe(pickType), safe(pickVal)),
  };
};

const getAddress = (p) => {
  const a = p?.location || p?.address || {};
  return {
    line1: safe(a.street || a.line1 || ""),
    line2: safe(a.address2 || a.line2 || ""),
    city: safe(a.city || ""),
    state: safe(a.state || ""),
    zip: safe(a.zip || a.postal || ""),
    notes: safe(a.notes || ""),
  };
};

// Normalize items and compute unitPrice/lineTotal if possible
const normalizeItems = (p) => {
  const items = Array.isArray(p?.items) ? p.items : [];
  return items
    .map((it) => {
      const sku = safe(it.sku || it.id || "").trim();
      const qty = Number(it.qty ?? it.quantity ?? 1) || 1;
      const name = safe(it.name || it.title || it.productName) || titleizeSku(sku);

      // Prefer values from payload if present
      const unitFromPayload = it.unitPrice ?? it.unit_price ?? it.price;
      const lineFromPayload = it.lineTotal ?? it.line_total ?? it.total;

      const unitPrice =
        unitFromPayload !== undefined && unitFromPayload !== null && unitFromPayload !== ""
          ? Number(unitFromPayload)
          : (sku && SKU_PRICE_MAP[sku] !== undefined ? Number(SKU_PRICE_MAP[sku]) : NaN);

      const lineTotal =
        lineFromPayload !== undefined && lineFromPayload !== null && lineFromPayload !== ""
          ? Number(lineFromPayload)
          : (Number.isFinite(unitPrice) ? unitPrice * qty : NaN);

      return { sku, qty, name, unitPrice, lineTotal };
    })
    .filter((it) => it.qty > 0);
};

const buildPricingLines = (pricing) => {
  const lines = [];
  const add = (label, val) => {
    const n = Number(val);
    if (!Number.isFinite(n) || Math.abs(n) < 0.000001) return;
    lines.push({ label, value: n });
  };

  // These names match your payload screenshot
  add("Items subtotal", pricing?.items);
  add("Delivery fee", pricing?.delivery);
  add("Rush fee", pricing?.rush);
  add("Congestion fee", pricing?.congestion);
  add("Delivery time slot fee", pricing?.dropFee);
  add("Pickup time slot fee", pricing?.pickFee);
  add("Extended rental fee", pricing?.extended);
  add("Minimum fee adjustment", pricing?.minFee);

  // Tax + Total at the end (even if 0 tax, include if total present)
  const taxN = Number(pricing?.tax);
  if (Number.isFinite(taxN) && Math.abs(taxN) >= 0.000001) lines.push({ label: "Sales tax", value: taxN });

  const totalN = Number(pricing?.total);
  if (Number.isFinite(totalN)) lines.push({ label: "Total", value: totalN, isTotal: true });

  return lines;
};

const buildItemLines = (items) => {
  const lines = [];
  for (const it of items) {
    const unitOk = Number.isFinite(it.unitPrice);
    const lineOk = Number.isFinite(it.lineTotal);

    if (unitOk && lineOk) {
      lines.push(`- ${it.name} (x${it.qty}) — ${fmtMoney(it.unitPrice)} ea — ${fmtMoney(it.lineTotal)}`);
    } else if (unitOk) {
      lines.push(`- ${it.name} (x${it.qty}) — ${fmtMoney(it.unitPrice)} ea`);
    } else {
      lines.push(`- ${it.name} (x${it.qty})`);
    }
  }
  return lines;
};

async function sendResend({ apiKey, from, to, subject, text }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      text,
    }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.message || data?.error || `Resend error (${r.status})`;
    throw new Error(msg);
  }
  return data;
}

export default async (req) => {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const FROM_EMAIL = process.env.FROM_EMAIL || "Kraus' Tables & Chairs <orders@kraustables.com>";
  const OWNER_EMAIL = process.env.OWNER_EMAIL || "orders@kraustables.com";

  if (!RESEND_API_KEY) return json(500, { ok: false, error: "Missing RESEND_API_KEY" });

  let p;
  try {
    p = await req.json();
  } catch {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }

  const customer = p?.customer || {};
  const customerEmail = safe(customer.email || p?.email).trim();
  const customerName = safe(customer.name || p?.name).trim();

  if (!isEmail(customerEmail)) return json(400, { ok: false, error: "Missing/invalid customer email" });

  const items = normalizeItems(p);
  if (!items.length) return json(400, { ok: false, error: "Missing items" });

  const requestId =
    (p?.requestId && String(p.requestId)) ||
    `KR-${Date.now()}-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;

  const flow = safe(p?.flow || p?.flowType || "request");
  const createdAt = new Date().toISOString();

  const schedule = getSchedule(p);
  const addr = getAddress(p);
  const pricing = p?.pricing || p?.totals || {};

  // Build shared blocks
  const itemLines = buildItemLines(items);
  const pricingLines = buildPricingLines(pricing);

  const pricingText = pricingLines.length
    ? pricingLines
        .map((x) => (x.isTotal ? `- ${x.label}: ${fmtMoney(x.value)}` : `- ${x.label}: ${fmtMoney(x.value)}`))
        .join("\n")
    : "";

  // OWNER EMAIL (no RAW JSON)
  const ownerLines = [];
  ownerLines.push(`Request ID: ${requestId}`);
  ownerLines.push(`Flow: ${flow}`);
  ownerLines.push(`Created: ${createdAt}`);
  if (p?.client_order_token) ownerLines.push(`Client token: ${safe(p.client_order_token)}`);
  ownerLines.push("");
  ownerLines.push("Customer:");
  ownerLines.push(`- Name: ${customerName || "(not provided)"}`);
  ownerLines.push(`- Email: ${customerEmail}`);
  if (customer.phone) ownerLines.push(`- Phone: ${safe(customer.phone)}`);
  ownerLines.push("");
  ownerLines.push("Schedule:");
  if (schedule.dropDate) ownerLines.push(`- Drop-off: ${schedule.dropDate}${schedule.dropWindow ? " (" + schedule.dropWindow + ")" : ""}`);
  if (schedule.pickDate) ownerLines.push(`- Pickup:  ${schedule.pickDate}${schedule.pickWindow ? " (" + schedule.pickWindow + ")" : ""}`);
  ownerLines.push("");

  if (addr.line1 || addr.city || addr.zip) {
    ownerLines.push("Address:");
    if (addr.line1) ownerLines.push(`- ${addr.line1}`);
    if (addr.line2) ownerLines.push(`- ${addr.line2}`);
    ownerLines.push(`- ${addr.city}${addr.state ? ", " + addr.state : ""} ${addr.zip}`);
    if (addr.notes) ownerLines.push(`- Notes: ${addr.notes}`);
    ownerLines.push("");
  }

  ownerLines.push("Items:");
  ownerLines.push(itemLines.join("\n"));
  ownerLines.push("");

  if (pricingText) {
    ownerLines.push("Order Summary (as shown to customer):");
    ownerLines.push(pricingText);
    ownerLines.push("");
  }

  const ownerText = ownerLines.join("\n");

  // CUSTOMER EMAIL
  const custLines = [];
  custLines.push(`Hi${customerName ? " " + customerName : ""},`);
  custLines.push("");
  custLines.push("We received your request and it is pending approval.");
  custLines.push("We’ll review availability and follow up shortly.");
  custLines.push("If approved, we’ll email you an invoice to complete booking.");
  custLines.push("");
  custLines.push(`Request ID: ${requestId}`);
  custLines.push("");

  if (schedule.dropDate) custLines.push(`Drop-off: ${schedule.dropDate}${schedule.dropWindow ? " (" + schedule.dropWindow + ")" : ""}`);
  if (schedule.pickDate) custLines.push(`Pickup:  ${schedule.pickDate}${schedule.pickWindow ? " (" + schedule.pickWindow + ")" : ""}`);
  if (schedule.dropDate || schedule.pickDate) custLines.push("");

  custLines.push("Items:");
  custLines.push(itemLines.join("\n"));

  if (pricingText) {
    custLines.push("");
    custLines.push("Order Summary:");
    custLines.push(pricingText);
  }

  custLines.push("");
  custLines.push("Thanks,");
  custLines.push("Kraus' Tables & Chairs");

  const customerText = custLines.join("\n");

  try {
    await sendResend({
      apiKey: RESEND_API_KEY,
      from: FROM_EMAIL,
      to: OWNER_EMAIL,
      subject: `NEW REQUEST (manual) — ${customerName || customerEmail} — ${requestId}`,
      text: ownerText,
    });

    await sendResend({
      apiKey: RESEND_API_KEY,
      from: FROM_EMAIL,
      to: customerEmail,
      subject: `KRAUS — Request received (pending approval) — ${requestId}`,
      text: customerText,
    });

    return json(200, { ok: true, requestId });
  } catch (err) {
    console.error("quote-request error:", err);
    return json(500, { ok: false, requestId, error: "Failed to send email" });
  }
};
