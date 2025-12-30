// netlify/functions/quote-request.js
// Minimal "request-only" endpoint for fallback mode.
// - Receives JSON payload from Squarespace forms
// - Emails OWNER + CUSTOMER via Resend
// - No Stripe checkout, no DB
//
// Supports your current snake_case payload keys:
//   customer.{name,phone,email}
//   location.{street,address2,city,state,zip,notes}
//   schedule.{dropoff_date,dropoff_timeslot_type,dropoff_timeslot_value, pickup_date, ...}
//   items[{sku,qty}] (and will auto-generate readable names from sku if name is missing)
//   pricing.{items,delivery,rush,dropFee,tax,total,deposit,remaining,isRush}

const json = (obj) =>
  new Response(JSON.stringify(obj), {
    status: obj?.ok ? 200 : obj?.status || 500,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Content-Type": "application/json",
    },
  });

const safe = (v) => (v === null || v === undefined ? "" : String(v));
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());

const fmtMoney = (v) => {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return safe(v);
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
};

const titleizeSku = (skuRaw) => {
  const sku = safe(skuRaw).trim();
  if (!sku) return "";

  const map = {
    "table-chair-set": "Table + Chair Set",
    "vintage-drafting-table": "Vintage Drafting Table",
    "industrial-garment-rack": "Industrial Garment Rack",
    "folding-table": "Folding Table",
    "industrial-bar": "Industrial Bar",
    "industrial-cocktail-table": "Industrial Cocktail Table",
    "antique-work-bench": "Antique Work Bench",
    "dark": "Vintage Folding Chair (Dark)",
    "light": "Vintage Folding Chair (Light)",
    "end-leaves": "Table End Leaves",
    "ASH-NYC-steel-table": "ASH NYC Steel Table",
    "MCM-etched-tulip-table": "MCM Etched Tulip Table",
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
  const line1 = a.street || a.line1 || "";
  const line2 = a.address2 || a.line2 || "";
  const city = a.city || "";
  const state = a.state || "";
  const zip = a.zip || a.postal || "";
  const notes = a.notes || "";
  return {
    line1: safe(line1),
    line2: safe(line2),
    city: safe(city),
    state: safe(state),
    zip: safe(zip),
    notes: safe(notes),
  };
};

const normalizeItems = (p) => {
  const items = Array.isArray(p?.items) ? p.items : [];
  return items
    .map((it) => {
      const sku = safe(it.sku || it.id || "");
      const qty = Number(it.qty ?? it.quantity ?? 1) || 1;
      const name =
        safe(it.name || it.title || it.productName) || titleizeSku(sku);
      return { sku, qty, name };
    })
    .filter((it) => it.qty > 0);
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
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST")
    return json({ ok: false, status: 405, error: "Method not allowed" });

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const FROM_EMAIL =
    process.env.FROM_EMAIL || "Kraus' Tables & Chairs <orders@kraustables.com>";
  const OWNER_EMAIL = process.env.OWNER_EMAIL || "orders@kraustables.com";

  if (!RESEND_API_KEY)
    return json({ ok: false, status: 500, error: "Missing RESEND_API_KEY" });

  let p;
  try {
    p = await req.json();
  } catch {
    return json({ ok: false, status: 400, error: "Invalid JSON body" });
  }

  const customer = p?.customer || {};
  const customerEmail = safe(customer.email || p?.email).trim();
  const customerName = safe(customer.name || p?.name).trim();

  if (!isEmail(customerEmail))
    return json({
      ok: false,
      status: 400,
      error: "Missing/invalid customer email",
    });

  const items = normalizeItems(p);
  if (!items.length)
    return json({ ok: false, status: 400, error: "Missing items" });

  const requestId =
    (p?.requestId && String(p.requestId)) ||
    `KR-${Date.now()}-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;
  const flow = safe(p?.flow || p?.flowType || "request");
  const createdAt = new Date().toISOString();

  const schedule = getSchedule(p);
  const addr = getAddress(p);
  const pricing = p?.pricing || p?.totals || {};

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
  for (const it of items) ownerLines.push(`- ${it.name} (x${it.qty}) [${it.sku}]`);
  ownerLines.push("");
  if (pricing?.total !== undefined) {
    ownerLines.push("Pricing (as shown to customer):");
    if (pricing.items !== undefined) ownerLines.push(`- Items subtotal: ${fmtMoney(pricing.items)}`);
    if (pricing.delivery !== undefined) ownerLines.push(`- Delivery fee: ${fmtMoney(pricing.delivery)}`);
    if (pricing.rush !== undefined) ownerLines.push(`- Rush fee: ${fmtMoney(pricing.rush)}`);
    if (pricing.dropFee !== undefined) ownerLines.push(`- Time slot fee: ${fmtMoney(pricing.dropFee)}`);
    if (pricing.tax !== undefined) ownerLines.push(`- Tax: ${fmtMoney(pricing.tax)}`);
    ownerLines.push(`- Total: ${fmtMoney(pricing.total)}`);
    ownerLines.push("");
  }

  ownerLines.push("---");
  ownerLines.push("RAW JSON:");
  ownerLines.push(JSON.stringify({ ...p, requestId, createdAt }, null, 2));

  const ownerText = ownerLines.join("\n");

  const custLines = [];
  custLines.push(`Hi${customerName ? " " + customerName : ""},`);
  custLines.push("");
  custLines.push("We received your request and it is pending approval.");
  custLines.push("We’ll review availability and follow up shortly.");
  custLines.push("");
  custLines.push(`Request ID: ${requestId}`);
  custLines.push("");
  if (schedule.dropDate) custLines.push(`Drop-off: ${schedule.dropDate}${schedule.dropWindow ? " (" + schedule.dropWindow + ")" : ""}`);
  if (schedule.pickDate) custLines.push(`Pickup:  ${schedule.pickDate}${schedule.pickWindow ? " (" + schedule.pickWindow + ")" : ""}`);
  if (schedule.dropDate || schedule.pickDate) custLines.push("");
  custLines.push("Items:");
  for (const it of items) custLines.push(`- ${it.name} (x${it.qty})`);
  if (pricing?.total !== undefined) {
    custLines.push("");
    custLines.push(`Estimated total: ${fmtMoney(pricing.total)}`);
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

    return json({ ok: true, requestId });
  } catch (err) {
    console.error("quote-request error:", err);
    return json({
      ok: false,
      status: 500,
      requestId,
      error: "Failed to send email",
    });
  }
};
