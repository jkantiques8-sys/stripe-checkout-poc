// netlify/functions/quote-request.js
// Request-only fallback endpoint (Resend):
// - Receives JSON payload from Squarespace forms
// - Emails OWNER + CUSTOMER via Resend
// - HTML emails with column tables (items + summary)
// - No Stripe checkout, no DB

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
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
};

const fmtMoneyOrDash = (v) => {
  const s = fmtMoney(v);
  return s || "—";
};

// EDIT THIS MAP to match your catalog unit prices.
// If a SKU isn't here AND the payload doesn't provide unitPrice, unit will show "—".
const SKU_PRICE_MAP = {
  "antique-work-bench": 400,
  "ASH-NYC-steel-table": 400,
  "dark": 10,
  "end-leaves": 50,
  "folding-table": 100,
  "industrial-bar": 400,
  "industrial-cocktail-table": 50,
  "industrial-garment-rack": 100,
  "light": 10,
  "MCM-etched-tulip-table": 250,
  "table-chair-set": 160,
  "vintage-drafting-table": 100,
  // SELF-SERVICE
  "chair_dark": 10,
  "chair_light": 10,
};

const SKU_NAME_MAP = {
  "antique-work-bench": "Antique Work Bench",
  "ASH-NYC-steel-table": "ASH NYC Standard Steel Table",
  "dark": "Vintage Folding Chairs — Dark",
  "end-leaves": "End Leaves (pair)",
  "folding-table": "Folding Farm Table",
  "industrial-bar": "Industrial Serving Bar",
  "industrial-cocktail-table": "Industrial Cocktail Table",
  "industrial-garment-rack": "Industrial Garment Rack",
  "light": "Vintage Folding Chairs — Light",
  "MCM-etched-tulip-table": "MCM Etched Tulip Table",
  "table-chair-set": "Table + 6 Chairs",
  "vintage-drafting-table": "Vintage Drafting Table",
  // SELF-SERVICE
  "chair_dark": "Vintage Folding Chairs — Dark",
  "chair_light": "Vintage Folding Chairs — Light",
};

const titleizeSku = (skuRaw) => {
  const sku = safe(skuRaw).trim();
  if (!sku) return "";
  if (SKU_NAME_MAP[sku]) return SKU_NAME_MAP[sku];

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

const normalizeItems = (p) => {
  const items = Array.isArray(p?.items) ? p.items : [];
  return items
    .map((it) => {
      const sku = safe(it.sku || it.id || "").trim();
      const qty = Number(it.qty ?? it.quantity ?? 1) || 1;

      const name =
        safe(it.name || it.title || it.productName).trim() || titleizeSku(sku) || sku || "Item";

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

const buildSummaryRows = (pricing) => {
  const rows = [];
  const add = (label, val, opts = {}) => {
    const n = Number(val);
    if (!Number.isFinite(n) || Math.abs(n) < 0.000001) return;
    rows.push({ label, value: n, ...opts });
  };

  // Try to match what you show on the page
  add("Items subtotal", pricing?.items);
  add("Delivery fee (30%)", pricing?.delivery);
  add("Rush fee (≤2 days)", pricing?.rush);
  add("Congestion fee", pricing?.congestion);
  add("Delivery time slot fee", pricing?.dropFee);
  add("Pickup time slot fee", pricing?.pickFee);
  add("Extended rental fee", pricing?.extended);
  add("Minimum surcharge", pricing?.minFee);

  const tax = Number(pricing?.tax);
  if (Number.isFinite(tax) && Math.abs(tax) >= 0.000001) rows.push({ label: "Sales tax", value: tax });

  const total = Number(pricing?.total);
  if (Number.isFinite(total)) rows.push({ label: "Total", value: total, isTotal: true });

  return rows;
};

const escapeHtml = (s) =>
  safe(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const htmlTableItems = (items) => {
  const rows = items
    .map((it) => {
      const unit = Number.isFinite(it.unitPrice) ? fmtMoney(it.unitPrice) : "—";
      const line = Number.isFinite(it.lineTotal) ? fmtMoney(it.lineTotal) : "—";
      return `
        <tr>
          <td style="padding:8px 0; border-bottom:1px solid #eee;">
            ${escapeHtml(it.name)}
          </td>
          <td style="padding:8px 0; border-bottom:1px solid #eee; text-align:right; white-space:nowrap;">
            ${it.qty}
          </td>
          <td style="padding:8px 0; border-bottom:1px solid #eee; text-align:right; white-space:nowrap;">
            ${unit}
          </td>
          <td style="padding:8px 0; border-bottom:1px solid #eee; text-align:right; white-space:nowrap;">
            ${line}
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse; font-size:14px;">
      <thead>
        <tr>
          <th align="left" style="padding:6px 0; border-bottom:2px solid #ddd;">Item</th>
          <th align="right" style="padding:6px 0; border-bottom:2px solid #ddd; white-space:nowrap;">Qty</th>
          <th align="right" style="padding:6px 0; border-bottom:2px solid #ddd; white-space:nowrap;">Unit</th>
          <th align="right" style="padding:6px 0; border-bottom:2px solid #ddd; white-space:nowrap;">Total</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
};

const htmlTableSummary = (rows) => {
  if (!rows.length) return "";

  const body = rows
    .map((r) => {
      const isTotal = !!r.isTotal;
      return `
        <tr>
          <td style="padding:8px 0; border-bottom:1px solid #eee; ${isTotal ? "font-weight:700;" : ""}">
            ${escapeHtml(r.label)}
          </td>
          <td style="padding:8px 0; border-bottom:1px solid #eee; text-align:right; white-space:nowrap; ${isTotal ? "font-weight:700;" : ""}">
            ${fmtMoneyOrDash(r.value)}
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse; font-size:14px;">
      <tbody>
        ${body}
      </tbody>
    </table>
  `;
};

const textItems = (items) =>
  items
    .map((it) => {
      const unitOk = Number.isFinite(it.unitPrice);
      const lineOk = Number.isFinite(it.lineTotal);
      const unitTxt = unitOk ? ` — ${fmtMoney(it.unitPrice)} ea` : "";
      const lineTxt = lineOk ? ` — ${fmtMoney(it.lineTotal)}` : "";
      return `- ${it.name} (x${it.qty})${unitTxt}${lineTxt}`;
    })
    .join("\n");

const textSummary = (rows) =>
  rows.map((r) => `- ${r.label}: ${fmtMoneyOrDash(r.value)}`).join("\n");

async function sendResend({ apiKey, from, to, subject, text, html }) {
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
      html,
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
  const summaryRows = buildSummaryRows(pricing);

  // ---------- OWNER EMAIL ----------
  const ownerText =
    `Request ID: ${requestId}\n` +
    `Flow: ${flow}\n` +
    `Created: ${createdAt}\n` +
    (p?.client_order_token ? `Client token: ${safe(p.client_order_token)}\n` : "") +
    `\nCustomer:\n` +
    `- Name: ${customerName || "(not provided)"}\n` +
    `- Email: ${customerEmail}\n` +
    (customer.phone ? `- Phone: ${safe(customer.phone)}\n` : "") +
    `\nSchedule:\n` +
    (schedule.dropDate ? `- Drop-off: ${schedule.dropDate}${schedule.dropWindow ? " (" + schedule.dropWindow + ")" : ""}\n` : "") +
    (schedule.pickDate ? `- Pickup:  ${schedule.pickDate}${schedule.pickWindow ? " (" + schedule.pickWindow + ")" : ""}\n` : "") +
    (addr.line1 || addr.city || addr.zip
      ? `\nAddress:\n` +
        (addr.line1 ? `- ${addr.line1}\n` : "") +
        (addr.line2 ? `- ${addr.line2}\n` : "") +
        `- ${addr.city}${addr.state ? ", " + addr.state : ""} ${addr.zip}\n` +
        (addr.notes ? `- Notes: ${addr.notes}\n` : "")
      : "") +
    `\nItems:\n${textItems(items)}\n` +
    (summaryRows.length ? `\nOrder Summary:\n${textSummary(summaryRows)}\n` : "");

  const ownerHtml = `
    <div style="font-family:Arial,Helvetica,sans-serif; color:#111; line-height:1.4;">
      <h2 style="margin:0 0 10px;">New Request (manual)</h2>
      <p style="margin:0 0 14px;">
        <strong>Request ID:</strong> ${escapeHtml(requestId)}<br>
        <strong>Flow:</strong> ${escapeHtml(flow)}<br>
        <strong>Created:</strong> ${escapeHtml(createdAt)}
        ${p?.client_order_token ? `<br><strong>Client token:</strong> ${escapeHtml(p.client_order_token)}` : ""}
      </p>

      <h3 style="margin:18px 0 8px;">Contact Info</h3>
      <p style="margin:0 0 14px;">
        <strong>Name:</strong> ${escapeHtml(customerName || "(not provided)")}<br>
        <strong>Email:</strong> ${escapeHtml(customerEmail)}
        ${customer.phone ? `<br><strong>Phone:</strong> ${escapeHtml(customer.phone)}` : ""}
      </p>

      <h3 style="margin:18px 0 8px;">Schedule</h3>
      <p style="margin:0 0 14px;">
        ${schedule.dropDate ? `<strong>Drop-off:</strong> ${escapeHtml(schedule.dropDate)}${schedule.dropWindow ? " (" + escapeHtml(schedule.dropWindow) + ")" : ""}<br>` : ""}
        ${schedule.pickDate ? `<strong>Pickup:</strong> ${escapeHtml(schedule.pickDate)}${schedule.pickWindow ? " (" + escapeHtml(schedule.pickWindow) + ")" : ""}` : ""}
      </p>

      ${
        addr.line1 || addr.city || addr.zip
          ? `
        <h3 style="margin:18px 0 8px;">Address</h3>
        <p style="margin:0 0 14px;">
          ${escapeHtml(addr.line1)}${addr.line2 ? `<br>${escapeHtml(addr.line2)}` : ""}<br>
          ${escapeHtml(addr.city)}${addr.state ? ", " + escapeHtml(addr.state) : ""} ${escapeHtml(addr.zip)}
          ${addr.notes ? `<br><strong>Notes:</strong> ${escapeHtml(addr.notes)}` : ""}
        </p>
      `
          : ""
      }

      <h3 style="margin:18px 0 8px;">Items</h3>
      ${htmlTableItems(items)}

      ${
        summaryRows.length
          ? `
        <h3 style="margin:18px 0 8px;">Order Summary</h3>
        ${htmlTableSummary(summaryRows)}
      `
          : ""
      }
    </div>
  `;

  // ---------- CUSTOMER EMAIL ----------
  const customerText =
    `Hi${customerName ? " " + customerName : ""},\n\n` +
    `We received your request and it is pending approval.\n` +
    `We’ll review availability and follow up shortly.\n` +
    `If approved, we’ll email you an invoice to complete booking.\n\n` +
    `Request ID: ${requestId}\n\n` +
    (schedule.dropDate ? `Drop-off: ${schedule.dropDate}${schedule.dropWindow ? " (" + schedule.dropWindow + ")" : ""}\n` : "") +
    (schedule.pickDate ? `Pickup:  ${schedule.pickDate}${schedule.pickWindow ? " (" + schedule.pickWindow + ")" : ""}\n\n` : "\n") +
    `Items:\n${textItems(items)}\n` +
    (summaryRows.length ? `\nOrder Summary:\n${textSummary(summaryRows)}\n` : "") +
    `\nThanks,\nKraus' Tables & Chairs`;

  const customerHtml = `
    <div style="font-family:Arial,Helvetica,sans-serif; color:#111; line-height:1.4;">
      <p style="margin:0 0 12px;">Hi${customerName ? " " + escapeHtml(customerName) : ""},</p>

      <p style="margin:0 0 12px;">
        We received your request and it is pending approval.<br>
        We’ll review availability and follow up shortly.<br>
        <strong>If approved, we’ll email you an invoice to complete booking.</strong>
      </p>

      <p style="margin:0 0 14px;"><strong>Request ID:</strong> ${escapeHtml(requestId)}</p>

      <h3 style="margin:18px 0 8px;">Schedule</h3>
      <p style="margin:0 0 14px;">
        ${schedule.dropDate ? `<strong>Drop-off:</strong> ${escapeHtml(schedule.dropDate)}${schedule.dropWindow ? " (" + escapeHtml(schedule.dropWindow) + ")" : ""}<br>` : ""}
        ${schedule.pickDate ? `<strong>Pickup:</strong> ${escapeHtml(schedule.pickDate)}${schedule.pickWindow ? " (" + escapeHtml(schedule.pickWindow) + ")" : ""}` : ""}
      </p>

      <h3 style="margin:18px 0 8px;">Items</h3>
      ${htmlTableItems(items)}

      ${
        summaryRows.length
          ? `
        <h3 style="margin:18px 0 8px;">Order Summary</h3>
        ${htmlTableSummary(summaryRows)}
      `
          : ""
      }

      <p style="margin:18px 0 0;">Thanks,<br>Kraus' Tables & Chairs</p>
    </div>
  `;

  try {
    await sendResend({
      apiKey: RESEND_API_KEY,
      from: FROM_EMAIL,
      to: OWNER_EMAIL,
      subject: `NEW REQUEST (manual) — ${customerName || customerEmail} — ${requestId}`,
      text: ownerText,
      html: ownerHtml,
    });

    await sendResend({
      apiKey: RESEND_API_KEY,
      from: FROM_EMAIL,
      to: customerEmail,
      subject: `KRAUS — Request received (pending approval) — ${requestId}`,
      text: customerText,
      html: customerHtml,
    });

    return json(200, { ok: true, requestId });
  } catch (err) {
    console.error("quote-request error:", err);
    return json(500, { ok: false, requestId, error: "Failed to send email" });
  }
};
