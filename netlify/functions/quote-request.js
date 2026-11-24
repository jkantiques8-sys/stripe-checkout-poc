// netlify/functions/quote-request.js

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

// --- Policies / Signature (CUSTOMER ONLY) ---
const POLICIES_URL = "https://kraustables.com/terms-conditions";
const SIG_ADDRESS = "956 Hancock Street, #1L\nBrooklyn, NY 11233";
const SIG_PHONE = "(718) 218-4057";

// EDIT THIS MAP to match your catalog unit prices.
const SKU_PRICE_MAP = {
  "ASH-NYC-steel-table": 400,
  dark: 10,
  "end-leaves": 50,
  "folding-table": 100,
  "industrial-bar": 400,
  "industrial-cocktail-table": 50,
  "industrial-garment-rack": 100,
  light: 10,
  "MCM-etched-tulip-table": 250,
  "table-chair-set": 160,
  "vintage-drafting-table": 100,
  // SELF-SERVICE
  chair_dark: 10,
  chair_light: 10,
};

const SKU_NAME_MAP = {
  "ASH-NYC-steel-table": "ASH NYC Standard Steel Table",
  dark: "Vintage Folding Chairs — Dark",
  "end-leaves": "End Leaves (pair)",
  "folding-table": "Folding Farm Table",
  "industrial-bar": "Industrial Serving Bar",
  "industrial-cocktail-table": "Industrial Cocktail Table",
  "industrial-garment-rack": "Industrial Garment Rack",
  light: "Vintage Folding Chairs — Light",
  "MCM-etched-tulip-table": "MCM Etched Tulip Table",
  "table-chair-set": "Table + 6 Chairs",
  "vintage-drafting-table": "Vintage Drafting Table",
  // SELF-SERVICE
  chair_dark: "Vintage Folding Chairs — Dark",
  chair_light: "Vintage Folding Chairs — Light",
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

// --- Time window formatting (prompt) ---
// "7-8" -> "7-8 AM" (assume AM if < 12)
// "19-20" -> "7-8 PM"
const formatPromptHourRange = (rangeStr) => {
  const raw = safe(rangeStr).trim();
  if (!raw) return "";
  const m = raw.match(/^(\d{1,2})(?::\d{2})?\s*-\s*(\d{1,2})(?::\d{2})?$/);
  if (!m) return raw;

  const start = parseInt(m[1], 10);
  const end = parseInt(m[2], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return raw;

  const meridiem = start >= 12 ? "PM" : "AM";
  const to12 = (h) => {
    const x = h % 12;
    return x === 0 ? 12 : x;
  };

  return `${to12(start)}-${to12(end)} ${meridiem}`;
};

const getSchedule = (p) => {
  const s = p?.schedule || {};
  // FULL-SERVICE: nested schedule (dropoff/pickup)
  // SELF-SERVICE: pickup_date + return_date at root
  const dropDate = s.dropoff_date || s.dropoffDate || "";
  const pickDate = s.pickup_date || s.pickupDate || "";
  const selfPickupDate = p?.pickup_date || p?.pickupDate || "";
  const selfReturnDate = p?.return_date || p?.returnDate || "";
  const dropType = s.dropoff_timeslot_type || s.dropoffTimeslotType || "";
  const dropVal = s.dropoff_timeslot_value || s.dropoffTimeslotValue || "";
  const pickType = s.pickup_timeslot_type || s.pickupTimeslotType || "";
  const pickVal = s.pickup_timeslot_value || s.pickupTimeslotValue || "";

  const humanSlot = (type, val) => {
    const t = safe(type);
    const v = safe(val);
    if (!t && !v) return "";
    if (t === "prompt" && v) return formatPromptHourRange(v);
    if (t === "flex" && v) return { "9-14": "9 AM–2 PM", "13-18": "1 PM–6 PM" }[v] || `Flexible window (${v})`;
    if (t && v) return `${t}: ${v}`;
    return v || t;
  };

  return {
    dropDate: safe(dropDate),
    dropWindow: humanSlot(dropType, dropVal),
    pickDate: safe(pickDate),
    pickWindow: humanSlot(pickType, pickVal),
    selfPickupDate: safe(selfPickupDate),
    selfReturnDate: safe(selfReturnDate),
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

      const unitFromPayload = it.unitPrice ?? it.unit_price ?? it.price;
      const lineFromPayload = it.lineTotal ?? it.line_total ?? it.total;

      const unitPrice =
        unitFromPayload !== undefined && unitFromPayload !== null && unitFromPayload !== ""
          ? Number(unitFromPayload)
          : sku && SKU_PRICE_MAP[sku] !== undefined
            ? Number(SKU_PRICE_MAP[sku])
            : NaN;

      const lineTotal =
        lineFromPayload !== undefined && lineFromPayload !== null && lineFromPayload !== ""
          ? Number(lineFromPayload)
          : Number.isFinite(unitPrice)
            ? unitPrice * qty
            : NaN;

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

  add("Items subtotal", pricing?.items ?? pricing?.itemsSubtotal ?? pricing?.chairsSubtotal);
  add("Delivery fee (30%)", pricing?.delivery);
  add("Rush fee (≤2 days)", pricing?.rush);
  add("Congestion fee", pricing?.congestion);
  add("Delivery time slot fee", pricing?.dropFee);
  add("Pickup time slot fee", pricing?.pickFee);
  add("Extended rental fee", pricing?.extended ?? pricing?.extend);
  add("Minimum surcharge", pricing?.minFee);

  const tax = Number(pricing?.tax);
  if (Number.isFinite(tax) && Math.abs(tax) >= 0.000001) rows.push({ label: "Sales tax", value: tax });

  const total = Number(pricing?.total);
  if (Number.isFinite(total)) rows.push({ label: "Total", value: total, isTotal: true });

  return rows;
};

// Full-service email summaries mirror the order form's presentation.
// These are display rows only: all amounts come from the submitted pricing.
const summaryWindowLabel = (typeRaw, rangeRaw) => {
  const type = safe(typeRaw).trim();
  const range = safe(rangeRaw).trim();
  if (type === "flex") {
    return { "9-14": "9 AM–2 PM", "13-18": "1 PM–6 PM" }[range] || range;
  }
  if (type !== "prompt") return range;
  const match = range.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!match) return range;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const hour12 = (h) => h % 12 || 12;
  const period = (h) => h >= 12 ? "PM" : "AM";
  return period(start) === period(end)
    ? `${hour12(start)}–${hour12(end)} ${period(end)}`
    : `${hour12(start)} ${period(start)}–${hour12(end)} ${period(end)}`;
};

const buildFullServiceSummaryRows = (pricing, rawSchedule = {}) => {
  const s = rawSchedule || {};
  const dropType = safe(s.dropoff_timeslot_type || s.dropoffTimeslotType);
  const dropValue = safe(s.dropoff_timeslot_value || s.dropoffTimeslotValue);
  const pickType = safe(s.pickup_timeslot_type || s.pickupTimeslotType);
  const pickValue = safe(s.pickup_timeslot_value || s.pickupTimeslotValue);
  const dropPremium = dropType === "prompt";
  const pickPremium = pickType === "prompt";
  const rows = [];
  const amount = (v) => (v === null || v === undefined || v === "") ? 0 : Number(v);
  const add = (label, val, opts = {}) => {
    const n = amount(val);
    if (!Number.isFinite(n) || Math.abs(n) < 0.000001) return;
    rows.push({ label, value: n, ...opts });
  };
  const slotLabel = (kind, type, value) =>
    `${type === "prompt" ? "Premium" : "Standard"} ${kind}: ${summaryWindowLabel(type, value)}`;

  add("Items subtotal", pricing?.items ?? pricing?.itemsSubtotal);
  add("Delivery fee (30%)", pricing?.delivery);
  add("Manhattan delivery surcharge", pricing?.congestion);
  if (!dropPremium) add(slotLabel("delivery", dropType, dropValue), pricing?.dropFee);
  if (!pickPremium) add(slotLabel("pickup", pickType, pickValue), pricing?.pickFee);
  add("Extended rental fee", pricing?.extended);
  add("Minimum order surcharge (to $400)", pricing?.minFee);

  // Sum the already-provided base charges, never reprice the order.
  const base = rows.reduce((sum, row) => sum + row.value, 0);
  const hasPricing = Number.isFinite(Number(pricing?.total));
  if (hasPricing) rows.push({ label: "Base rental total", value: base, isSubtotal: true });

  const extra = [];
  const addExtra = (label, val) => {
    const n = amount(val);
    if (Number.isFinite(n) && Math.abs(n) >= 0.000001) extra.push({ label, value: n });
  };
  addExtra("Rush fee (≤2 days)", pricing?.rush);
  if (dropPremium) addExtra(slotLabel("delivery", dropType, dropValue), pricing?.dropFee);
  if (pickPremium) addExtra(slotLabel("pickup", pickType, pickValue), pricing?.pickFee);
  if (Number(pricing?.holiday) > 0) {
    const period = safe(pricing?.holidayPeriod).trim();
    addExtra(period ? `Holiday rental surcharge (${period})` : "Holiday rental surcharge", pricing.holiday);
  }
  if (extra.length) {
    rows.push({ label: "Additional service fees", isHeading: true });
    rows.push(...extra);
  }

  add("Sales tax (8.875%)", pricing?.tax, { isTaxSeparation: extra.length > 0 });
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

// Format structured venue notes from the full-service form as readable email rows.
// Older, unstructured notes remain readable without losing any submitted text.
const VENUE_NOTE_LABELS = {
  "Furniture use": "Furniture use",
  "Outdoor surface/weather protection": "Surface & weather protection",
  "Delivery access": "Delivery access",
  "Service/freight entrance": "Service/freight entrance",
  "Loading/parking": "Loading & parking",
  "Freight elevator restrictions": "Freight elevator restrictions",
  "Additional notes": "Additional notes",
};

const formatVenueNotes = (notes) => {
  const raw = safe(notes).trim();
  if (!raw) return { html: "", text: "" };

  const lines = raw.split(/\r?\n/);
  const entries = [];
  for (const line of lines) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    const label = match && VENUE_NOTE_LABELS[match[1].trim()];
    if (label) {
      entries.push({ label, value: match[2].trim() });
    } else if (entries.length) {
      // Preserve multiline answers entered in a free-text field.
      entries[entries.length - 1].value += `\n${line}`;
    } else {
      entries.push({ label: "Notes", value: line });
    }
  }

  const html = `<h3 style="margin:18px 0 6px;">Event Venue &amp; Delivery Access</h3>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse; font-family:Arial,Helvetica,sans-serif; font-size:13px; line-height:1.35;">
      <tbody>${entries.map(({ label, value }) => `
        <tr>
          <td style="padding:3px 12px 3px 0; vertical-align:top; width:196px; font-weight:600;">${escapeHtml(label)}:</td>
          <td style="padding:3px 0; vertical-align:top; white-space:pre-wrap; overflow-wrap:anywhere;">${escapeHtml(value)}</td>
        </tr>`).join("")}
      </tbody>
    </table>`;
  const text = `Event Venue & Delivery Access:\n${entries.map(({ label, value }) => `${label}: ${value}`).join("\n")}\n`;
  return { html, text };
};

// Plain-text notes for copying directly into Square's invoice message field.
// HTML email renders this as selectable text without relying on table formatting.
const formatInvoiceDate = (iso) => {
  const value = safe(iso).trim();
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return value;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(date.getTime()) ? value :
    date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
};

const buildInvoiceCopy = ({ customerName, customerEmail, phone, address, schedule, venueNotes, isSelfFlow }) => {
  const lines = [];
  lines.push("Contact Info");
  lines.push(`Name:   ${customerName || "Not provided"}`);
  lines.push(`Email:   ${customerEmail || "Not provided"}`);
  lines.push(`Phone:   ${phone || "Not provided"}`);

  if (address.line1 || address.line2 || address.city || address.zip) {
    lines.push("", "Address");
    if (address.line1) lines.push(address.line1);
    if (address.line2) lines.push(address.line2);
    lines.push(`${address.city}${address.state ? ", " + address.state : ""} ${address.zip}`.trim());
  }
  if (venueNotes.text) {
    // Three spaces after the colon improve legibility in Square's plain-text
    // message field, which does not preserve the email's HTML table columns.
    const venueCopy = venueNotes.text.trimEnd().split("\n").map(line =>
      /^([^:\n]+): (.*)$/.test(line) ? line.replace(/^([^:\n]+): /, "$1:   ") : line
    ).join("\n");
    lines.push("", venueCopy);
  }
  lines.push("", "Schedule");
  if (isSelfFlow) {
    if (schedule.selfPickupDate) lines.push(`Pickup:   ${formatInvoiceDate(schedule.selfPickupDate)}`);
    if (schedule.selfReturnDate) lines.push(`Return:   ${formatInvoiceDate(schedule.selfReturnDate)}`);
  } else {
    if (schedule.dropDate) lines.push(`Delivery:   ${formatInvoiceDate(schedule.dropDate)}${schedule.dropWindow ? " (" + schedule.dropWindow + ")" : ""}`);
    if (schedule.pickDate) lines.push(`Pickup:   ${formatInvoiceDate(schedule.pickDate)}${schedule.pickWindow ? " (" + schedule.pickWindow + ")" : ""}`);
  }
  return lines.join("\n");
};

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
    .map((r, index) => {
      if (r.isHeading) return `
        <tr>
          <td colspan="2" style="padding:16px 0 6px; border-top:1px solid #ccc; font-weight:700;">
            ${escapeHtml(r.label)}
          </td>
        </tr>`;
      const emphasized = !!(r.isTotal || r.isSubtotal);
      // Reuse the preceding fee row's bottom border as the tax divider (no double line).
      const beforeTax = !!rows[index + 1]?.isTaxSeparation;
      const border = beforeTax ? "1px solid #ccc" : "1px solid #eee";
      const padding = r.isTaxSeparation ? "14px 0 8px" : "8px 0";
      return `
        <tr>
          <td style="padding:${padding}; border-bottom:${border}; ${emphasized ? "font-weight:700;" : ""}">
            ${escapeHtml(r.label)}
          </td>
          <td style="padding:${padding}; border-bottom:${border}; text-align:right; white-space:nowrap; ${emphasized ? "font-weight:700;" : ""}">
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
  rows.map((r) => r.isHeading ? `\n${r.label}:` : `${r.isSubtotal || r.isTotal ? "" : "- "}${r.label}: ${fmtMoneyOrDash(r.value)}`).join("\n");

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

async function sendTwilioSms({ accountSid, authToken, from, to, body }) {
  if (!accountSid || !authToken || !from || !to || !body) return;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = btoa(`${accountSid}:${authToken}`);

  const params = new URLSearchParams();
  params.set("From", from);
  params.set("To", to);
  params.set("Body", body);

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Twilio SMS error (${r.status}): ${t.slice(0, 200)}`);
  }
}

export default async (req) => {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const FROM_EMAIL = process.env.FROM_EMAIL || "Kraus' Tables & Chairs <orders@kraustables.com>";
  const OWNER_EMAIL = process.env.OWNER_EMAIL || "orders@kraustables.com";

  const OWNER_PHONE = process.env.OWNER_PHONE; // e.g. "+1917..."
  const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

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

  const isSelfFlow =
    /self/i.test(flow) ||
    (!!p?.pickup_date || !!p?.pickupDate || !!p?.return_date || !!p?.returnDate) ||
    (Array.isArray(p?.items) &&
      p.items.length > 0 &&
      p.items.every((it) => /^chair_/i.test(safe(it?.sku || it?.id || ""))));

  const schedule = getSchedule(p);
  const addr = getAddress(p);
  const pricing = p?.pricing || p?.totals || {};
  const summaryRows = isSelfFlow
    ? buildSummaryRows(pricing)
    : buildFullServiceSummaryRows(pricing, p?.schedule);
  const venueNotes = formatVenueNotes(addr.notes);
  const invoiceCopy = buildInvoiceCopy({
    customerName, customerEmail, phone: safe(customer.phone || p?.phone || customer.phone_number || customer.phoneNumber),
    address: addr, schedule, venueNotes, isSelfFlow,
  });

  const ownerSubject = isSelfFlow
    ? `NEW CHAIR RENTAL REQUEST — ${requestId}`
    : `NEW EVENT RENTAL REQUEST — ${requestId}`;

  // OWNER EMAIL (NO policies link, NO signature)
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
    (isSelfFlow
      ? (schedule.selfPickupDate ? `- Pickup: ${schedule.selfPickupDate}\n` : "") +
        (schedule.selfReturnDate ? `- Return: ${schedule.selfReturnDate}\n` : "")
      : (schedule.dropDate
          ? `- Delivery: ${schedule.dropDate}${schedule.dropWindow ? " (" + schedule.dropWindow + ")" : ""}\n`
          : "") +
        (schedule.pickDate
          ? `- Pickup:   ${schedule.pickDate}${schedule.pickWindow ? " (" + schedule.pickWindow + ")" : ""}\n`
          : "")) +
    (addr.line1 || addr.city || addr.zip
      ? `\nAddress:\n` +
        (addr.line1 ? `- ${addr.line1}\n` : "") +
        (addr.line2 ? `- ${addr.line2}\n` : "") +
        `- ${addr.city}${addr.state ? ", " + addr.state : ""} ${addr.zip}\n`
      : "") +
    (venueNotes.text ? `\n${venueNotes.text}` : "") +
    `\nItems:\n${textItems(items)}\n` +
    (summaryRows.length ? `\nOrder Summary:\n${textSummary(summaryRows)}\n` : "") +
    `\n--- COPY INTO SQUARE INVOICE (plain text) ---\n${invoiceCopy}\n--- END INVOICE DETAILS ---\n`;

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
        ${isSelfFlow && schedule.selfPickupDate ? `<strong>Pickup:</strong> ${escapeHtml(schedule.selfPickupDate)}<br>` : ""}
        ${isSelfFlow && schedule.selfReturnDate ? `<strong>Return:</strong> ${escapeHtml(schedule.selfReturnDate)}` : ""}
        ${
          !isSelfFlow && schedule.dropDate
            ? `<strong>Delivery:</strong> ${escapeHtml(schedule.dropDate)}${
                schedule.dropWindow ? " (" + escapeHtml(schedule.dropWindow) + ")" : ""
              }<br>`
            : ""
        }
        ${
          !isSelfFlow && schedule.pickDate
            ? `<strong>Pickup:</strong> ${escapeHtml(schedule.pickDate)}${
                schedule.pickWindow ? " (" + escapeHtml(schedule.pickWindow) + ")" : ""
              }`
            : ""
        }
      </p>

      ${
        addr.line1 || addr.city || addr.zip
          ? `
        <h3 style="margin:18px 0 8px;">Address</h3>
        <p style="margin:0 0 14px;">
          ${escapeHtml(addr.line1)}${addr.line2 ? `<br>${escapeHtml(addr.line2)}` : ""}<br>
          ${escapeHtml(addr.city)}${addr.state ? ", " + escapeHtml(addr.state) : ""} ${escapeHtml(addr.zip)}

        </p>
      `
          : ""
      }

      ${venueNotes.html}

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

      <h3 style="margin:26px 0 8px;">Copy into Square invoice</h3>
      <p style="font-size:12px; color:#666; margin:0 0 8px;">Plain text below is formatted for Square’s invoice message field. Select and copy just the text inside the box.</p>
      <div style="padding:12px 14px; border:1px solid #ddd; border-radius:6px; background:#f8f8f8; color:#222; font-family:Arial,Helvetica,sans-serif; font-size:13px; line-height:1.55; white-space:pre-wrap; overflow-wrap:anywhere;">${escapeHtml(invoiceCopy)}</div>
    </div>
  `;

  const customerSubject = isSelfFlow
    ? "Chair Rental Request Received – Pending Approval"
    : "Event Rental Request Received – Pending Approval";

  const customerText =
    `Hi${customerName ? " " + customerName : ""},\n\n` +
    `We received your request and it is pending approval.\n` +
    `We’ll review availability and follow up shortly.\n` +
    `If approved, we’ll email you an invoice to complete booking.\n\n` +
    `Request ID: ${requestId}\n\n` +
    (isSelfFlow
      ? (schedule.selfPickupDate ? `Pickup: ${schedule.selfPickupDate}\n` : "") +
        (schedule.selfReturnDate ? `Return: ${schedule.selfReturnDate}\n\n` : "\n")
      : (schedule.dropDate
          ? `Delivery: ${schedule.dropDate}${schedule.dropWindow ? " (" + schedule.dropWindow + ")" : ""}\n`
          : "") +
        (schedule.pickDate
          ? `Pickup:   ${schedule.pickDate}${schedule.pickWindow ? " (" + schedule.pickWindow + ")" : ""}\n\n`
          : "\n")) +
    (venueNotes.text ? `${venueNotes.text}\n` : "") +
    `Items:\n${textItems(items)}\n` +
    (summaryRows.length ? `\nOrder Summary:\n${textSummary(summaryRows)}\n` : "") +
    `\nView our Rental Policies:\n${POLICIES_URL}\n` +
    `\nThanks,\nKraus' Tables & Chairs\n${SIG_ADDRESS}\n${SIG_PHONE}\nkraustables.com\n`;

  const customerHtml = `
    <div style="font-family:Arial,Helvetica,sans-serif; color:#111; line-height:1.4;">
      <p style="margin:0 0 12px;">Hi${customerName ? " " + escapeHtml(customerName) : ""},</p>

      <p style="margin:0 0 12px;">
        We received your request and it is pending approval.<br>
        We’ll review availability and follow up shortly.<br>
        <strong>If approved, we’ll email you an invoice to complete booking.</strong>
      </p>

      <p style="margin:0 0 14px;"><strong>Request ID:</strong> ${escapeHtml(requestId)}</p>

      <h3 style="margin:18px 0 8px;">Contact Info</h3>
      <p style="margin:0 0 14px;">
        <strong>Name:</strong> ${escapeHtml(customerName || "(not provided)")}<br>
        <strong>Email:</strong> ${escapeHtml(customerEmail)}${customer.phone ? `<br><strong>Phone:</strong> ${escapeHtml(customer.phone)}` : ""}
      </p>

      ${
        addr.line1 || addr.city || addr.zip
          ? `
        <h3 style="margin:18px 0 8px;">Delivery Address</h3>
        <p style="margin:0 0 14px;">
          ${escapeHtml(addr.line1)}${addr.line2 ? `<br>${escapeHtml(addr.line2)}` : ""}<br>
          ${escapeHtml(addr.city)}${addr.state ? ", " + escapeHtml(addr.state) : ""} ${escapeHtml(addr.zip)}

        </p>
      `
          : ""
      }

      ${venueNotes.html}

      <h3 style="margin:18px 0 8px;">Schedule</h3>
      <p style="margin:0 0 14px;">
        ${isSelfFlow && schedule.selfPickupDate ? `<strong>Pickup:</strong> ${escapeHtml(schedule.selfPickupDate)}<br>` : ""}
        ${isSelfFlow && schedule.selfReturnDate ? `<strong>Return:</strong> ${escapeHtml(schedule.selfReturnDate)}` : ""}
        ${
          !isSelfFlow && schedule.dropDate
            ? `<strong>Delivery:</strong> ${escapeHtml(schedule.dropDate)}${
                schedule.dropWindow ? " (" + escapeHtml(schedule.dropWindow) + ")" : ""
              }<br>`
            : ""
        }
        ${
          !isSelfFlow && schedule.pickDate
            ? `<strong>Pickup:</strong> ${escapeHtml(schedule.pickDate)}${
                schedule.pickWindow ? " (" + escapeHtml(schedule.pickWindow) + ")" : ""
              }`
            : ""
        }
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

      <p style="margin:18px 0 0;">
        <a href="${escapeHtml(POLICIES_URL)}">View our Rental Policies</a>
      </p>

      <div style="margin-top:24px;font-size:13px;line-height:1.45;color:#888;">
  <strong style="color:#666;">Kraus’ Tables &amp; Chairs</strong><br>
  956 Hancock Street, #1L<br>
  Brooklyn, NY 11233<br>
  <a href="tel:+17182184057">(718) 218-4057</a><br>
  <a href="https://kraustables.com">kraustables.com</a>
</div>
    </div>
  `;

  try {
    await sendResend({
      apiKey: RESEND_API_KEY,
      from: FROM_EMAIL,
      to: OWNER_EMAIL,
      subject: ownerSubject,
      text: ownerText,
      html: ownerHtml,
    });

    // SMS owner notification (uses same env vars as checkout-webhook)
    try {
      const smsEnabled =
        !!OWNER_PHONE &&
        !!TWILIO_PHONE_NUMBER &&
        !!TWILIO_ACCOUNT_SID &&
        !!TWILIO_AUTH_TOKEN;

      if (smsEnabled) {
        const totalLine = pricing?.total ? `Total: ${fmtMoney(pricing.total)}` : "";
        const nameLine = customerName ? `Customer: ${customerName}` : "";
        const idLine = `Request: ${requestId}`;

        const deliveryLine = schedule.dropDate
          ? `Delivery: ${schedule.dropDate}${schedule.dropWindow ? ` (${schedule.dropWindow})` : ""}`
          : "";
        const pickupLine = schedule.pickDate
          ? `Pickup: ${schedule.pickDate}${schedule.pickWindow ? ` (${schedule.pickWindow})` : ""}`
          : "";

        const selfPickupLine = schedule.selfPickupDate
          ? `Pickup: ${schedule.selfPickupDate}`
          : "";
        const selfReturnLine = schedule.selfReturnDate
          ? `Return: ${schedule.selfReturnDate}`
          : "";

        const header = isSelfFlow
          ? `🙋‍♀️ NEW CHAIR RENTAL REQUEST`
          : `🚚 NEW EVENT RENTAL REQUEST`;

        const body = [
          `${header} — ${requestId}`,
          nameLine,
          idLine,
          isSelfFlow ? selfPickupLine : deliveryLine,
          isSelfFlow ? selfReturnLine : pickupLine,
          totalLine,
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 1500);

        await sendTwilioSms({
          accountSid: TWILIO_ACCOUNT_SID,
          authToken: TWILIO_AUTH_TOKEN,
          from: TWILIO_PHONE_NUMBER,
          to: OWNER_PHONE,
          body,
        });
      } else {
        console.log("Twilio not configured; skipping SMS");
      }
    } catch (smsErr) {
      console.error("Failed to send owner SMS:", smsErr?.message || smsErr);
      // Best-effort: do not fail the request if SMS fails
    }

    await sendResend({
      apiKey: RESEND_API_KEY,
      from: FROM_EMAIL,
      to: customerEmail,
      subject: customerSubject,
      text: customerText,
      html: customerHtml,
    });

    return json(200, { ok: true, requestId });
  } catch (err) {
    console.error("quote-request error:", err);
    return json(500, { ok: false, requestId, error: "Failed to send email" });
  }
};
