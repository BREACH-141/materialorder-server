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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function itemTable(items) {
  const rows = items
    .map((it) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(it.material)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${it.qty}</td></tr>`)
    .join("");
  return `<table style="width:100%;border-collapse:collapse;margin:16px 0">
    <thead><tr><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #1C1F1D">Material</th><th style="text-align:right;padding:6px 10px;border-bottom:2px solid #1C1F1D">Qty</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function buildStockCheckEmail({ items, deliveryAddress, timeframe, replyUrl, orderNumber }) {
  const itemLines = items.map((it) => `- ${it.material}: ${it.qty}`).join("\n");
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1C1F1D">
    <p>Hello,</p>
    <p>A builder using MaterialOrder would like to check stock and confirm pricing for the items below, ahead of placing order <strong>${orderNumber}</strong>.</p>
    ${itemTable(items)}
    <p><strong>Delivery to:</strong> ${escapeHtml(deliveryAddress)}<br/>
    <strong>Needed by:</strong> ${escapeHtml(timeframe)}</p>
    <p>Please let us know whether these items and quantities are in stock and available within the timeframe above, by clicking the link below. It takes under a minute and needs no account or login.</p>
    <p style="margin:24px 0">
      <a href="${replyUrl}" style="background:#D4622A;color:#fff;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:bold;display:inline-block">Confirm stock for this order</a>
    </p>
    <p style="font-size:13px;color:#8A8579">If the button doesn't work, copy and paste this link into your browser:<br/>${replyUrl}</p>
    <p style="font-size:13px;color:#8A8579">This is an automated stock-check request sent on behalf of a builder using MaterialOrder. Replying confirms availability only — it does not commit either party to a sale.</p>
  </div>`;
  const text = `Hello,\n\nA builder using MaterialOrder would like to check stock for order ${orderNumber}.\n\nItems:\n${itemLines}\n\nDelivery to: ${deliveryAddress}\nNeeded by: ${timeframe}\n\nConfirm stock here: ${replyUrl}\n\nReplying confirms availability only and does not commit either party to a sale.`;
  return { html, text };
}

function buildChaseEmail({ items, deliveryAddress, timeframe, replyUrl, orderNumber }) {
  const itemLines = items.map((it) => `- ${it.material}: ${it.qty}`).join("\n");
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1C1F1D">
    <p>Hello,</p>
    <p>Just following up on our stock-check request for order <strong>${orderNumber}</strong> sent yesterday. We haven't received a reply yet and would appreciate a quick confirmation when you get a chance.</p>
    ${itemTable(items)}
    <p><strong>Delivery to:</strong> ${escapeHtml(deliveryAddress)}<br/>
    <strong>Needed by:</strong> ${escapeHtml(timeframe)}</p>
    <p style="margin:24px 0">
      <a href="${replyUrl}" style="background:#D4622A;color:#fff;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:bold;display:inline-block">Confirm stock for this order</a>
    </p>
    <p style="font-size:13px;color:#8A8579">If the button doesn't work, copy and paste this link:<br/>${replyUrl}</p>
    <p style="font-size:13px;color:#8A8579">This is an automated follow-up from MaterialOrder. Replying confirms availability only — it does not commit either party to a sale.</p>
  </div>`;
  const text = `Hello,\n\nJust following up on our stock-check for order ${orderNumber}. We haven't received a reply yet.\n\nItems:\n${itemLines}\n\nDelivery to: ${deliveryAddress}\nNeeded by: ${timeframe}\n\nConfirm stock here: ${replyUrl}`;
  return { html, text };
}

function buildReplyNotificationEmail({ supplierName, status, note, orderNumber, items }) {
  const statusLabel = status === "confirmed" ? "All items in stock"
    : status === "partial" ? "Some items unavailable"
    : "None available";
  const statusColor = status === "confirmed" ? "#2D5C4D"
    : status === "partial" ? "#9F7400"
    : "#C0392B";
  const itemLines = items.map((it) => `- ${it.material}: ${it.qty}`).join("\n");
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1C1F1D">
    <p><strong>${escapeHtml(supplierName)}</strong> has replied to your stock-check for order <strong>${orderNumber}</strong>.</p>
    <p style="display:inline-block;padding:8px 16px;border-radius:4px;background:${statusColor};color:#fff;font-weight:bold;font-size:15px">${statusLabel}</p>
    ${note ? `<p><strong>Their note:</strong> ${escapeHtml(note)}</p>` : ""}
    ${itemTable(items)}
    <p style="font-size:13px;color:#8A8579">This notification was sent automatically by MaterialOrder.</p>
  </div>`;
  const text = `${supplierName} replied to order ${orderNumber}:\n\nStatus: ${statusLabel}${note ? `\nNote: ${note}` : ""}\n\nItems:\n${itemLines}`;
  return { html, text };
}

// --- Routes ---------------------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({ ok: true, emailConfigured: Boolean(resend), fromEmail: FROM_EMAIL });
});

// List all orders (for order history screen)
app.get("/api/orders", (req, res) => {
  const store = readStore();
  const orders = Object.values(store.orders).map((order) => {
    const supplierEntries = Object.values(order.suppliers || {});
    const totalSuppliers = supplierEntries.length;
    const repliedCount = supplierEntries.filter((s) => s.status !== "sent").length;
    return {
      orderNumber: order.orderNumber,
      projectName: order.projectName || "",
      createdAt: order.createdAt,
      deliveryAddress: order.deliveryAddress,
      timeframe: order.timeframe,
      totalSuppliers,
      repliedCount,
      suppliers: order.suppliers,
    };
  });
  orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ orders });
});

// Kick off stock-check emails for an order.
// Body: { orderNumber, deliveryAddress, timeframe, builderEmail, suppliers: [{ name, email, items }] }
app.post("/api/stock-check", async (req, res) => {
  if (!resend) {
    return res.status(500).json({ error: "Email is not configured on this server. Set RESEND_API_KEY in .env." });
  }

  const { orderNumber, deliveryAddress, timeframe, suppliers, builderEmail, projectName } = req.body || {};
  if (!orderNumber || !Array.isArray(suppliers) || suppliers.length === 0) {
    return res.status(400).json({ error: "orderNumber and a non-empty suppliers array are required." });
  }

  const store = readStore();
  const order = store.orders[orderNumber] || {
    orderNumber,
    projectName: projectName || "",
    deliveryAddress,
    timeframe,
    builderEmail: builderEmail || "",
    suppliers: {},
    createdAt: new Date().toISOString(),
  };

  const results = [];

  for (const supplier of suppliers) {
    if (!supplier.email) {
      results.push({ supplier: supplier.name, sent: false, reason: "No email address on file for this supplier." });
      continue;
    }
    const replyToken = nanoid(16);
    const replyUrl = `${PUBLIC_BASE_URL}/reply/${replyToken}`;
    const { html, text } = buildStockCheckEmail({
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

// Status of a single order — polled by the frontend.
app.get("/api/orders/:orderNumber", (req, res) => {
  const store = readStore();
  const order = store.orders[req.params.orderNumber];
  if (!order) return res.status(404).json({ error: "Order not found." });
  res.json(order);
});

// The page a supplier sees when they click the reply link.
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

// Records a supplier's reply and notifies the builder.
app.post("/api/reply/:token", (req, res) => {
  const { status, note } = req.body || {};
  if (!["confirmed", "partial", "unavailable"].includes(status)) {
    return res.status(400).json({ error: "status must be confirmed, partial, or unavailable." });
  }
  const store = readStore();
  let owningOrder = null;
  for (const order of Object.values(store.orders)) {
    if (order.suppliers[req.params.token]) {
      order.suppliers[req.params.token].status = status;
      order.suppliers[req.params.token].reply = { status, note: note || "", repliedAt: new Date().toISOString() };
      owningOrder = order;
      break;
    }
  }
  if (!owningOrder) return res.status(404).json({ error: "Reply link not recognised." });
  writeStore(store);

  // Notify the builder — fire-and-forget so supplier page isn't delayed
  if (owningOrder.builderEmail && resend) {
    const sup = owningOrder.suppliers[req.params.token];
    const { html, text } = buildReplyNotificationEmail({
      supplierName: sup.supplierName,
      status,
      note: note || "",
      orderNumber: owningOrder.orderNumber,
      items: sup.items || [],
    });
    resend.emails.send({
      from: `MaterialOrder <${FROM_EMAIL}>`,
      to: [owningOrder.builderEmail],
      subject: `Reply received — ${sup.supplierName} (order ${owningOrder.orderNumber})`,
      html,
      text,
    }).catch((e) => console.error("[notify] Failed to send builder notification:", e.message));
  }

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

// --- Chase email background job ----------------------------------------------
// Runs every hour. Sends one follow-up to any supplier who hasn't replied
// within 24 hours. Marks chaseSentAt on the supplier record to avoid repeats.

function startChaseJob() {
  const CHASE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const CHASE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

  setInterval(async () => {
    if (!resend) return;
    const store = readStore();
    let dirty = false;

    for (const order of Object.values(store.orders)) {
      for (const [token, supplier] of Object.entries(order.suppliers)) {
        if (supplier.status !== "sent") continue;
        if (supplier.chaseSentAt) continue;
        const sentAt = new Date(supplier.sentAt).getTime();
        if (Date.now() - sentAt < CHASE_THRESHOLD_MS) continue;

        const replyUrl = `${PUBLIC_BASE_URL}/reply/${token}`;
        const { html, text } = buildChaseEmail({
          items: supplier.items || [],
          deliveryAddress: order.deliveryAddress,
          timeframe: order.timeframe,
          replyUrl,
          orderNumber: order.orderNumber,
        });

        try {
          const { error } = await resend.emails.send({
            from: `MaterialOrder <${FROM_EMAIL}>`,
            to: [supplier.supplierEmail],
            subject: `Following up — stock check for order ${order.orderNumber}`,
            html,
            text,
          });
          if (!error) {
            supplier.chaseSentAt = new Date().toISOString();
            dirty = true;
            console.log(`[chase] Sent follow-up to ${supplier.supplierName} for order ${order.orderNumber}`);
          } else {
            console.error(`[chase] Resend error for ${supplier.supplierName}:`, error.message);
          }
        } catch (e) {
          console.error(`[chase] Exception chasing ${supplier.supplierName}:`, e.message);
        }
      }
    }

    if (dirty) writeStore(store);
  }, CHASE_INTERVAL_MS);
}

app.listen(PORT, () => {
  console.log(`MaterialOrder server listening on port ${PORT}`);
  console.log(`Email sending ${resend ? "is" : "is NOT"} configured.`);
  startChaseJob();
});
