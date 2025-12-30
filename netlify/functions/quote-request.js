// netlify/functions/quote-request.js

export default async (req) => {
  // Basic CORS + method handling
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (req.method === "OPTIONS") {
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
      status: 405,
      headers,
    });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const FROM_EMAIL = process.env.FROM_EMAIL || "Kraus' Tables & Chairs <orders@kraustables.com>";
  const OWNER_EMAIL = process.env.OWNER_EMAIL || "orders@kraustables.com";

  if (!RESEND_API_KEY) {
    return new Response(JSON.stringify({ ok: false, error: "Missing RESEND_API_KEY" }), {
      status: 500,
      headers,
    });
  }

  // Parse payload
  let payload;
  try {
    payload = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: "Invalid JSON body" }), {
      status: 400,
      headers,
    });
  }

  // Minimal required fields (adjust as needed)
  const customerEmail = (payload?.customer?.email || payload?.email || "").toString().trim();
  const customerName = (payload?.customer?.name || payload?.name || "").toString().trim();
  const items = payload?.items;

  if (!customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    return new Response(JSON.stringify({ ok: false, error: "Missing/invalid customer email" }), {
      status: 400,
      headers,
    });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return new Response(JSON.stringify({ ok: false, error: "Missing items" }), {
      status: 400,
      headers,
    });
  }

  const requestId =
    (payload?.requestId && String(payload.requestId)) ||
    `KR-${Date.now()}-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;

  const flow = (payload?.flow || payload?.flowType || "request").toString();
  const createdAt = new Date().toISOString();

  // Pretty summary helpers
  const fmtMoney = (v) => {
    if (v === null || v === undefined || v === "") return "";
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
  };

  const safe = (v) => (v === null || v === undefined ? "" : String(v));

  const lines = [];
  lines.push(`Request ID: ${requestId}`);
  lines.push(`Flow: ${flow}`);
  lines.push(`Created: ${createdAt}`);
  lines.push("");
  lines.push("Customer:");
  lines.push(`- Name: ${customerName || "(not provided)"}`);
  lines.push(`- Email: ${customerEmail}`);
  if (payload?.customer?.phone || payload?.phone) lines.push(`- Phone: ${safe(payload?.customer?.phone || payload?.phone)}`);
  lines.push("");

  if (payload?.schedule) {
    lines.push("Schedule:");
    if (payload.schedule.dropoffDate) lines.push(`- Drop-off date: ${safe(payload.schedule.dropoffDate)}`);
    if (payload.schedule.dropoffWindow) lines.push(`- Drop-off window: ${safe(payload.schedule.dropoffWindow)}`);
    if (payload.schedule.pickupDate) lines.push(`- Pickup date: ${safe(payload.schedule.pickupDate)}`);
    if (payload.schedule.pickupWindow) lines.push(`- Pickup window: ${safe(payload.schedule.pickupWindow)}`);
    lines.push("");
  }

  if (payload?.address) {
    const a = payload.address;
    lines.push("Address:");
    lines.push(`- ${safe(a.line1)}`);
    if (a.line2) lines.push(`- ${safe(a.line2)}`);
    lines.push(`- ${safe(a.city)}${a.state ? ", " + safe(a.state) : ""} ${safe(a.postal || a.zip)}`);
    if (a.notes) lines.push(`- Notes: ${safe(a.notes)}`);
    lines.push("");
  }

  lines.push("Items:");
  for (const it of items) {
    const name = safe(it.name || it.title || it.productName);
    const qty = safe(it.qty ?? it.quantity ?? 1);
    const unit = it.unitPrice ?? it.price;
    const lineTotal = it.lineTotal ?? it.total;
    const unitTxt = unit !== undefined ? ` @ ${fmtMoney(unit)}` : "";
    const totalTxt = lineTotal !== undefined ? ` = ${fmtMoney(lineTotal)}` : "";
    lines.push(`- ${name} (x${qty})${unitTxt}${totalTxt}`);
  }
  lines.push("");

  if (payload?.totals) {
    const t = payload.totals;
    lines.push("Totals (as shown to customer):");
    if (t.subtotal !== undefined) lines.push(`- Subtotal: ${fmtMoney(t.subtotal)}`);
    if (t.deliveryFee !== undefined) lines.push(`- Delivery fee: ${fmtMoney(t.deliveryFee)}`);
    if (t.surcharges !== undefined) lines.push(`- Surcharges: ${fmtMoney(t.surcharges)}`);
    if (t.tax !== undefined) lines.push(`- Tax: ${fmtMoney(t.tax)}`);
    if (t.total !== undefined) lines.push(`- Total: ${fmtMoney(t.total)}`);
    lines.push("");
  }

  if (payload?.notes) {
    lines.push("Customer notes:");
    lines.push(safe(payload.notes));
    lines.push("");
  }

  // Include raw JSON for debugging (owner only)
  const ownerText =
    lines.join("\n") +
    "\n\n---\nRAW JSON:\n" +
    JSON.stringify({ ...payload, requestId, createdAt }, null, 2);

  const customerText =
    `Hi${customerName ? " " + customerName : ""},\n\n` +
    `We received your request and it is pending approval.\n` +
    `We’ll review availability and follow up shortly.\n\n` +
    `Request ID: ${requestId}\n\n` +
    `Summary:\n` +
    lines
      .filter((l) => !l.startsWith("RAW JSON"))
      .join("\n")
      // Keep it shorter for customers: remove the RAW JSON section completely
      .replace(/\n---\nRAW JSON:[\s\S]*$/m, "")
      .trim() +
    `\n\nThanks,\nKraus' Tables & Chairs`;

  // Send emails via Resend
  const sendResend = async ({ to, subject, text }) => {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
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
  };

  try {
    // Owner first (so you get it even if customer mail fails later)
    await sendResend({
      to: OWNER_EMAIL,
      subject: `NEW REQUEST (manual) — ${customerName || customerEmail} — ${requestId}`,
      text: ownerText,
    });

    // Customer confirmation
    await sendResend({
      to: customerEmail,
      subject: `KRAUS — Request received (pending approval) — ${requestId}`,
      text: customerText,
    });

    return new Response(JSON.stringify({ ok: true, requestId }), { status: 200, headers });
  } catch (err) {
    console.error("quote-request error:", err);

    // If email fails, still return something useful (no sensitive details)
    return new Response(
      JSON.stringify({
        ok: false,
        requestId,
        error: "Failed to send email",
      }),
      { status: 500, headers }
    );
  }
};
