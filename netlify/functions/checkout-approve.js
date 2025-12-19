// netlify/functions/checkout-approve.js
const Stripe = require('stripe');
const jwt = require('jsonwebtoken');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

let twilioClient = null;
let resendClient = null;

function getTwilioClient() {
  if (!twilioClient && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    const twilio = require('twilio');
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return twilioClient;
}

function getResendClient() {
  if (!resendClient && process.env.RESEND_API_KEY) {
    const { Resend } = require('resend');
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
};

function centsToDollars(cents) {
  const n = Number(cents || 0);
  return (n / 100).toFixed(2);
}

function parseYYYYMMDD(s) {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function daysBetween(a, b) {
  // whole days (b - a)
  const ms = 24 * 60 * 60 * 1000;
  return Math.floor((b.getTime() - a.getTime()) / ms);
}

async function sendEmailApproved({ to, customerName, depositCents, balanceCents, dropoffDate, invoiceHostedUrl }) {
  const resend = getResendClient();
  if (!resend || !process.env.FROM_EMAIL) return;

  const depositStr = `$${centsToDollars(depositCents)}`;
  const balanceStr = `$${centsToDollars(balanceCents)}`;
  const invoiceLine = invoiceHostedUrl
    ? `<p><a href="${invoiceHostedUrl}">Pay your remaining balance here</a>.</p>`
    : `<p>Your remaining balance will be invoiced by email.</p>`;

  await resend.emails.send({
    from: process.env.FROM_EMAIL,
    to,
    subject: "Your Kraus' Tables & Chairs request is approved",
    html: `
      <p>Hi ${customerName || ''},</p>
      <p>Your request has been approved.</p>
      <p><strong>Deposit charged:</strong> ${depositStr}</p>
      ${balanceCents > 0 ? `<p><strong>Remaining balance:</strong> ${balanceStr}${dropoffDate ? ` (for drop-off ${dropoffDate})` : ''}</p>` : ''}
      ${balanceCents > 0 ? invoiceLine : '<p>No remaining balance is due.</p>'}
      <p>If you have any questions, just reply to this email.</p>
    `
  });
}

async function sendEmailDepositPaymentLink({ to, customerName, depositCents, paymentUrl }) {
  const resend = getResendClient();
  if (!resend || !process.env.FROM_EMAIL) return;

  const depositStr = `$${centsToDollars(depositCents)}`;

  await resend.emails.send({
    from: process.env.FROM_EMAIL,
    to,
    subject: "Action needed: confirm your deposit",
    html: `
      <p>Hi ${customerName || ''},</p>
      <p>Your request has been approved, but we couldn’t charge your deposit automatically.</p>
      <p><strong>Deposit due:</strong> ${depositStr}</p>
      <p><a href="${paymentUrl}">Pay the deposit here</a>.</p>
      <p>If you need help, reply to this email.</p>
    `
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    const qsToken = event.queryStringParameters && event.queryStringParameters.token;
    let bodyToken = null;
    if (event.body) { try { bodyToken = JSON.parse(event.body).token; } catch {} }
    const token = qsToken || bodyToken;

    if (!token) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Token is required' }) };
    }

    const JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Missing JWT_SECRET' }) };
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Invalid or expired token' }) };
    }

    const setupIntentId = decoded.setupIntentId;
    const sessionId = decoded.sessionId;
    const customerName = decoded.customerName || '';
    const customerEmail = decoded.customerEmail || '';
    const customerPhone = decoded.customerPhone || '';
    const flow = decoded.orderDetails?.flow || 'full_service';

    if (!setupIntentId || !sessionId) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing setupIntentId or sessionId in token' }) };
    }

    // Retrieve session metadata (pricing + schedule)
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const md = session.metadata || {};

    const totalCents = Number(md.total_cents || decoded.orderDetails?.total_cents || 0);
    if (!Number.isFinite(totalCents) || totalCents <= 0) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ er
