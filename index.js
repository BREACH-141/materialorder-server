require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { Resend } = require("resend");
const { nanoid } = require("nanoid");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3001;
const FROM_EMAIL = process.env.FROM_EMAIL || "onboarding@resend.dev";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const RESEND_API_KEY = process.env.RESEND_API_KEY;

if (!RESEND_API_KEY) {
  console.warn(
    "\n[WARN] RESEND_API_KEY is not set. Copy .env.example to .env and add a real key from https://resend.com\n" +
      "The server will still start, but /api/stock-check will fail until a key is configured.\n"
  );
}

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// --- Simple file-based store -------------------------------------------------
// This is intentionally not a real database. It's a single JSON file on disk,
// good enough for a prototype / personal-use deployment. Swap for Postgres,
// SQLite, or similar before this needs to handle concurrent real users.
const DATA_FILE = path.join(__dirname, "data", "orders.json");

function ensureDataFile() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ orders: {} }, null, 2));
}

function readStore() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function writeStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

// --- Email content ------------------------------------------------------------

function buildStockCheckEmail({ supplierName, items, deliveryAddress, timeframe, replyUrl, orderNumber }) {
  const itemRows = items
    .map((it) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(it.material)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${it.qty}</td></tr>`)
    .join("");

  const itemLines = items.map((it) => `- ${it.material}: ${it.qty}`).join("\n");

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1C1F1D">
    <p>Hello,</p>
    <p>A builder using MaterialOrder would like to check stock and confirm pricing for the items below, ahead of placing order <strong>${orderNumber}</strong>.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0">
      <thead>
        <tr><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #1C1F1D">Material</th><th style="text-align:right;padding:6px 10px;border-bottom:2px solid #1C1F1D">Qty</th></tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>
    <p><strong>Delivery to:</strong> ${escapeHtml(deliveryAddress)}<br/>
    <strong>Needed by:</strong> ${escapeHtml(timeframe)}</p>
    <p>Please let us know whether these items and quantities are in stock and available within the timeframe above, by clicking the link below. It takes under a minute and needs no account or login.</p>
    <p style="margin:24px 0">
      <a href="${replyUrl}" style="background:#D4622A;color:#fff;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:bold;display:inline-block">Confirm stock for this order</a>
    </p>
    <p style="font-size:13px;color:#8A8579">If the button doesn't work, copy and paste this link into your browser:<br/>${replyUrl}</p>
    <p style="font-size:13px;color:#8A8579">This is an automated stock-check request sent on behalf of a builder using MaterialOrder. Replying confirms availability only — it does not commit either party to a sale.</p>
  </div>`;

  const text = `Hello,

A builder using MaterialOrder would like to check stock and confirm pricing for the items below, ahead of placing order ${orderNumber}.

Items:
${itemLines}

Delivery to: ${deliveryAddress}
Needed by: ${timeframe}

Please confirm stock and pricing here: ${replyUrl}

This is an automated stock-check request. Replying confirms availability only and does not commit either party to a sale.`;

  return { html, text };
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --- Routes ---------------------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({ ok: true, emailConfigured: Boolean(resend), fromEmail: FROM_EMAIL });
});

// Kick off stock-check emails for an order. Body:
// { orderNumber, deliveryAddress, timeframe, suppliers: [{ name, email, items: [{material, qty}] }] }
app.post("/api/stock-check", async (req, res) => {
  if (!resend) {
    return res.status(500).json({ error: "Email is not configured on this server. Set RESEND_API_KEY in .env." });
  }

  const { orderNumber, deliveryAddress, timeframe, suppliers } = req.body || {};
  if (!orderNumber || !Array.isArray(suppliers) || suppliers.length === 0) {
    return res.status(400).json({ error: "orderNumber and a non-empty suppliers array are required." });
  }

  const store = readStore();
  const order = store.orders[orderNumber] || { orderNumber, deliveryAddress, timeframe, suppliers: {}, createdAt: new Date().toISOString() };

  const results = [];

  for (const supplier of suppliers) {
    if (!supplier.email) {
      results.push({ supplier: supplier.name, sent: false, reason: "No email address on file for this supplier." });
      continue;
    }
    const replyToken = nanoid(16);
    const replyUrl = `${PUBLIC_BASE_URL}/reply/${replyToken}`;
    const { html, text } = buildStockCheckEmail({
      supplierName: supplier.name,
      items: supplier.items || [],
      deliveryAddress,
      timeframe,
      replyUrl,
      orderNumber,
    });

    try {
      const { data, error } = await resend.emails.send({
        from: `MaterialOrder <${FROM_EMAIL}>`,
        to: [supplier.email],
        subject: `Stock check request — order ${orderNumber}`,
        html,
        text,
      });

      if (error) {
        results.push({ supplier: supplier.name, sent: false, reason: error.message || "Resend rejected the send." });
        continue;
      }

      order.suppliers[replyToken] = {
        supplierName: supplier.name,
        supplierEmail: supplier.email,
        items: supplier.items || [],
        status: "sent",
        emailId: data && data.id,
        sentAt: new Date().toISOString(),
        reply: null,
      };
      results.push({ supplier: supplier.name, sent: true, replyToken });
    } catch (e) {
      results.push({ supplier: supplier.name, sent: false, reason: e.message || "Unknown send error." });
    }
  }

  store.orders[orderNumber] = order;
  writeStore(store);

  res.json({ orderNumber, results });
});

// Status of an order — polled by the frontend to show sent/awaiting/confirmed states.
app.get("/api/orders/:orderNumber", (req, res) => {
  const store = readStore();
  const order = store.orders[req.params.orderNumber];
  if (!order) return res.status(404).json({ error: "Order not found." });
  res.json(order);
});

// The page a supplier lands on when they click the reply link in their email.
// No login, no email parsing — they just tap a button. This is the realistic,
// reliable way to get a structured answer back without needing the supplier's
// own systems to support anything.
app.get("/reply/:token", (req, res) => {
  const store = readStore();
  let found = null;
  let orderNumber = null;
  for (const [num, order] of Object.entries(store.orders)) {
    if (order.suppliers[req.params.token]) {
      found = order.suppliers[req.params.token];
      orderNumber = num;
      break;
    }
  }
  if (!found) {
    res.status(404).send(renderReplyPage({ notFound: true }));
    return;
  }
  res.send(renderReplyPage({ token: req.params.token, orderNumber, supplier: found }));
});

app.post("/api/reply/:token", (req, res) => {
  const { status, note } = req.body || {};
  if (!["confirmed", "partial", "unavailable"].includes(status)) {
    return res.status(400).json({ error: "status must be confirmed, partial, or unavailable." });
  }
  const store = readStore();
  let updated = false;
  for (const order of Object.values(store.orders)) {
    if (order.suppliers[req.params.token]) {
      order.suppliers[req.params.token].status = status;
      order.suppliers[req.params.token].reply = { status, note: note || "", repliedAt: new Date().toISOString() };
      updated = true;
      break;
    }
  }
  if (!updated) return res.status(404).json({ error: "Reply link not recognised." });
  writeStore(store);
  res.json({ ok: true });
});

function renderReplyPage({ notFound, token, orderNumber, supplier }) {
  if (notFound) {
    return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center">
      <h2>Link not recognised</h2><p>This stock-check link is invalid or has expired.</p></body></html>`;
  }
  const itemRows = (supplier.items || [])
    .map((it) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(it.material)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${it.qty}</td></tr>`)
    .join("");

  return `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Confirm stock — ${escapeHtml(orderNumber)}</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#1C1F1D">
  <h2>Order ${escapeHtml(orderNumber)}</h2>
  <p>Please confirm stock availability for these items:</p>
  <table style="width:100%;border-collapse:collapse;margin:16px 0">
    <thead><tr><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #1C1F1D">Material</th><th style="text-align:right;padding:6px 10px;border-bottom:2px solid #1C1F1D">Qty</th></tr></thead>
    <tbody>${itemRows}</tbody>
  </table>
  <div id="form">
    <button onclick="submitReply('confirmed')" style="display:block;width:100%;padding:14px;margin-bottom:10px;background:#2D5C4D;color:#fff;border:none;border-radius:4px;font-size:15px;font-weight:bold;cursor:pointer">All items in stock</button>
    <button onclick="submitReply('partial')" style="display:block;width:100%;padding:14px;margin-bottom:10px;background:#D4622A;color:#fff;border:none;border-radius:4px;font-size:15px;font-weight:bold;cursor:pointer">Some items unavailable</button>
    <button onclick="submitReply('unavailable')" style="display:block;width:100%;padding:14px;margin-bottom:10px;background:#C0392B;color:#fff;border:none;border-radius:4px;font-size:15px;font-weight:bold;cursor:pointer">None of this is available</button>
    <textarea id="note" placeholder="Optional note (e.g. which items, or alternative lead time)" style="width:100%;padding:10px;margin-top:10px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box" rows="3"></textarea>
  </div>
  <p id="result" style="display:none;font-weight:bold"></p>
  <script>
    async function submitReply(status) {
      const note = document.getElementById('note').value;
      const res = await fetch('/api/reply/${token}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, note })
      });
      if (res.ok) {
        document.getElementById('form').style.display = 'none';
        const r = document.getElementById('result');
        r.style.display = 'block';
        r.textContent = 'Thanks — your reply has been recorded.';
      } else {
        alert('Something went wrong submitting your reply. Please try again.');
      }
    }
  </script>
</body></html>`;
}

app.listen(PORT, () => {
  console.log(`MaterialOrder server listening on port ${PORT}`);
  console.log(`Email sending ${resend ? "is" : "is NOT"} configured.`);
});
