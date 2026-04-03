require("dotenv").config();
const express = require("express");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
const { randomBytes } = require("crypto");

// Ack map untuk webhook status baca/kirim
const ACK_STATUS = {
  0: "error",
  1: "pending",
  2: "sent",
  3: "delivered",
  4: "read",
  5: "played",
};

const app = express();
app.use(express.json({ limit: "20mb" })); // perlu limit besar untuk kirim image base64

const PORT = process.env.PORT || 3009;

// sessions.json menyimpan: { sessionId: { webhookUrl } }
const SESSIONS_FILE = path.join(__dirname, "sessions.json");

// sessionId -> { client, qr, status, webhookUrl }
const sessions = new Map();

function generateSessionId() {
  return randomBytes(8).toString("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function normalizeId(message, id) {
  if (!id) return null;

  // already canonical WA chat IDs
  if (id.endsWith("@c.us") || id.endsWith("@g.us") || id.endsWith("@broadcast")) {
    return id;
  }

  // Special case lid id: try fetch contact data
  try {
    if (typeof message.getContact === "function") {
      const contact = await message.getContact();
      if (contact?.id?._serialized) return contact.id._serialized;
      if (contact?.id?.user) return `${contact.id.user}@c.us`;
      if (contact?.number) return `${contact.number}@c.us`;
    }
  } catch (err) {
    // ignore resolution failure and return original
  }

  return id;
}

function logWebhookPayload(sessionId, payload) {
  // Hindari spam besar: ringkas field media.data
  const clone = { ...payload };
  if (payload.media?.data) {
    clone.media = {
      ...payload.media,
      dataLength: payload.media.data.length,
    };
  }
  console.log(`[${sessionId}] Webhook payload:`, JSON.stringify(clone, null, 2));
}

// ── Simpan semua session (id + webhookUrl) ke disk ────────────────────────────
async function persistSessions() {
  const data = {};
  for (const [id, s] of sessions.entries()) {
    data[id] = { webhookUrl: s.webhookUrl || null };
  }
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(data, null, 2));
}

// ── Restore session dari disk saat server boot ────────────────────────────────
async function restoreSessions() {
  let data = {};
  try {
    const raw = await fs.readFile(SESSIONS_FILE, "utf-8");
    data = JSON.parse(raw);
  } catch {
    return; // belum ada file, skip
  }

  const entries = Object.entries(data);
  if (!entries.length) return;
  console.log(`Restoring ${entries.length} session(s):`, Object.keys(data));

  for (const [sessionId, meta] of entries) {
    const authPath = path.join(
      __dirname,
      ".wwebjs_auth",
      `session-${sessionId}`,
    );
    try {
      await fs.access(authPath);
    } catch {
      console.log(`[${sessionId}] Auth folder not found, skipping`);
      continue;
    }

    console.log(`[${sessionId}] Restoring...`);
    startSession(sessionId, meta.webhookUrl)
      .then(({ qr }) => {
        if (qr) {
          console.log(
            `[${sessionId}] QR needed → GET /api/session/qr/${sessionId}`,
          );
        } else {
          console.log(`[${sessionId}] Restored`);
        }
      })
      .catch((err) => {
        console.error(`[${sessionId}] Restore failed:`, err.message);
      });
  }
}

// ── Buat dan inisialisasi client WhatsApp ─────────────────────────────────────
function startSession(sessionId, webhookUrl = null) {
  return new Promise((resolve, reject) => {
    const client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionId }),
      puppeteer: {
        headless: true,
        executablePath: process.env.CHROME_BIN || undefined,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-gpu",
        ],
      },
    });

    sessions.set(sessionId, {
      client,
      qr: null,
      status: "initializing",
      webhookUrl,
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error("Timeout: no QR or connection after 60s"));
      }
    }, 60_000);

    client.on("qr", async (qr) => {
      try {
        const qrImage = await QRCode.toDataURL(qr);
        const session = sessions.get(sessionId);
        if (session) {
          session.qr = qrImage;
          session.status = "qr_ready";
        }
        console.log(`[${sessionId}] QR ready`);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve({ sessionId, qr: qrImage });
        }
      } catch (err) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(err);
        }
      }
    });

    client.on("authenticated", () => {
      const session = sessions.get(sessionId);
      if (session) {
        session.status = "authenticated";
        session.qr = null;
      }
      console.log(`[${sessionId}] Authenticated`);
    });

    client.on("ready", () => {
      const session = sessions.get(sessionId);
      if (session) session.status = "ready";
      console.log(`[${sessionId}] Ready`);
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ sessionId, qr: null });
      }
    });

    client.on("disconnected", (reason) => {
      console.log(`[${sessionId}] Disconnected:`, reason);
      const session = sessions.get(sessionId);
      if (session) session.status = "disconnected";
    });

    client.on("auth_failure", (msg) => {
      console.error(`[${sessionId}] Auth failure:`, msg);
      const session = sessions.get(sessionId);
      if (session) session.status = "disconnected";
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`Auth failure: ${msg}`));
      }
    });

    // ── Incoming messages → kirim ke webhook milik session ini ────────────────
    client.on("message", async (message) => {
      if (message.fromMe) return;

      const session = sessions.get(sessionId);
      const url = session?.webhookUrl;
      if (!url) return;

      const from = await normalizeId(message, message.from);

      const payload = {
        event: "message_in",
        sessionId,
        from,
        rawFrom: message.from,
        text: message.body,
        timestamp: message.timestamp,
        messageId: message.id.id,
        type: message.type, // 'chat' | 'image' | 'document' | dll
        hasMedia: message.hasMedia,
        isReply: message.hasQuotedMsg || false,
      };

      // Jika pesan berisi media, sertakan base64-nya ke payload webhook
      if (message.hasMedia) {
        try {
          const media = await message.downloadMedia();
          payload.media = {
            mimetype: media.mimetype,
            filename: media.filename || null,
            data: media.data, // base64
          };
        } catch (err) {
          console.error(
            `[${sessionId}] Failed to download media:`,
            err.message,
          );
        }
      }

      // Sertakan info pesan yang di-reply jika ada
      if (message.hasQuotedMsg) {
        try {
          const quoted = await message.getQuotedMessage();
          const quotedFrom = await normalizeId(quoted, quoted.from);
          payload.quoted = {
            messageId: quoted.id.id,
            from: quotedFrom,
            rawFrom: quoted.from,
            text: quoted.body,
            timestamp: quoted.timestamp,
            type: quoted.type,
          };
        } catch (err) {
          console.error(
            `[${sessionId}] Failed to fetch quoted message:`,
            err.message,
          );
        }
      }

      try {
        logWebhookPayload(sessionId, payload);
        await axios.post(url, payload);
      } catch (err) {
        console.error(`[${sessionId}] Webhook failed:`, err.message);
      }
    });

    // Pesan keluar (dikirim via API) → kirim ke webhook juga
    client.on("message_create", async (message) => {
      if (!message.fromMe) return;

      const session = sessions.get(sessionId);
      const url = session?.webhookUrl;
      if (!url) return;

      const to = await normalizeId(message, message.to);
      const from = await normalizeId(message, message.from);

      const payload = {
        event: "message_out",
        sessionId,
        to,
        rawTo: message.to,
        from,
        rawFrom: message.from,
        text: message.body,
        timestamp: message.timestamp,
        messageId: message.id.id,
        type: message.type,
        hasMedia: message.hasMedia,
      };

      if (message.hasMedia) {
        try {
          const media = await message.downloadMedia();
          payload.media = {
            mimetype: media.mimetype,
            filename: media.filename || null,
            data: media.data, // base64
          };
        } catch (err) {
          console.error(
            `[${sessionId}] Failed to download outgoing media:`,
            err.message,
          );
        }
      }

      try {
        logWebhookPayload(sessionId, payload);
        await axios.post(url, payload);
      } catch (err) {
        console.error(`[${sessionId}] Webhook failed:`, err.message);
      }
    });

    // Status pesan (sent/delivered/read/played) → webhook
    client.on("message_ack", async (message, ack) => {
      const session = sessions.get(sessionId);
      const url = session?.webhookUrl;
      if (!url) return;

      const from = await normalizeId(message, message.from);
      const to = await normalizeId(message, message.to);

      const payload = {
        event: "message_ack",
        sessionId,
        messageId: message.id.id,
        fromMe: message.fromMe,
        from,
        rawFrom: message.from,
        to,
        rawTo: message.to,
        ack,
        status: ACK_STATUS[ack] || "unknown",
        timestamp: message.timestamp,
      };

      try {
        logWebhookPayload(sessionId, payload);
        await axios.post(url, payload);
      } catch (err) {
        console.error(`[${sessionId}] Webhook failed:`, err.message);
      }
    });

    client.initialize().catch((err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`initialize() failed: ${err.message}`));
      }
    });
  });
}

// ── Hapus session ─────────────────────────────────────────────────────────────
async function deleteSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  try {
    await session.client.destroy();
  } catch (_) {}

  const authPath = path.join(__dirname, ".wwebjs_auth", `session-${sessionId}`);
  try {
    await fs.rm(authPath, { recursive: true, force: true });
  } catch (_) {}

  sessions.delete(sessionId);
  console.log(`[${sessionId}] Deleted`);
  return true;
}

// ════════════════════════ ROUTES ═════════════════════════════════════════════

// POST /api/session/start
// Body: { sessionId?, webhookUrl? }
app.post("/api/session/start", async (req, res) => {
  let { sessionId, webhookUrl = null } = req.body;
  if (!sessionId) sessionId = generateSessionId();

  if (sessions.has(sessionId)) {
    return res.status(400).json({ error: "Session already exists" });
  }

  try {
    const result = await startSession(sessionId, webhookUrl);
    await persistSessions();
    res.json(result);
  } catch (err) {
    sessions.delete(sessionId);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/session/:sessionId/webhook
// Ganti webhookUrl tanpa harus hapus dan buat ulang session
// Body: { webhookUrl: "https://..." }  — kirim null untuk hapus webhook
app.patch("/api/session/:sessionId/webhook", async (req, res) => {
  const { sessionId } = req.params;
  const { webhookUrl = null } = req.body;

  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  session.webhookUrl = webhookUrl;
  await persistSessions();
  res.json({ success: true, webhookUrl });
});

// GET /api/session/qr/:sessionId
app.get("/api/session/qr/:sessionId", (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (!session.qr) {
    return res.status(404).json({
      error: "QR not available",
      status: session.status,
      hint:
        session.status === "ready" ? "Already connected" : "Still initializing",
    });
  }
  res.json({ qr: session.qr });
});

// POST /api/session/regenerate-qr/:sessionId
// Regenerate QR code untuk session yang sudah ada (misal jika disconnected atau perlu login ulang)
app.post("/api/session/regenerate-qr/:sessionId", async (req, res) => {
  const { sessionId } = req.params;

  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  // Destroy client jika ada
  try {
    await session.client.destroy();
  } catch (_) {}

  // Hapus auth folder untuk force regenerate QR
  const authPath = path.join(__dirname, ".wwebjs_auth", `session-${sessionId}`);
  try {
    await fs.rm(authPath, { recursive: true, force: true });
  } catch (_) {}

  // Hapus dari map
  sessions.delete(sessionId);

  // Start ulang session dengan webhook yang sama
  try {
    const result = await startSession(sessionId, session.webhookUrl);
    await persistSessions();
    res.json(result);
  } catch (err) {
    sessions.delete(sessionId);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/session/status/:sessionId
app.get("/api/session/status/:sessionId", (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({
    sessionId: req.params.sessionId,
    status: session.status,
    webhookUrl: session.webhookUrl || null,
  });
});

// GET /api/sessions
app.get("/api/sessions", (_req, res) => {
  const list = [...sessions.entries()].map(([id, s]) => ({
    sessionId: id,
    status: s.status,
    webhookUrl: s.webhookUrl || null,
  }));
  res.json(list);
});

// DELETE /api/session/:sessionId
app.delete("/api/session/:sessionId", async (req, res) => {
  const ok = await deleteSession(req.params.sessionId);
  if (!ok) return res.status(404).json({ error: "Session not found" });
  await persistSessions();
  res.json({ success: true });
});

// POST /api/session/send
// Kirim pesan teks atau gambar
//
// Kirim teks:
//   { sessionId, to, text, delayMs?, typingDurationMs? }
//
// Kirim gambar (salah satu dari imageUrl atau imageBase64):
//   { sessionId, to, imageUrl: "https://...", caption? }
//   { sessionId, to, imageBase64: "data:image/jpeg;base64,...", mimeType?, filename?, caption? }
app.post("/api/session/send", async (req, res) => {
  const {
    sessionId,
    to,
    // teks
    text,
    // gambar via URL
    imageUrl,
    // gambar via base64 — bisa sertakan "data:image/jpeg;base64," atau tanpa prefix
    imageBase64,
    mimeType = "image/jpeg",
    filename = "image.jpg",
    caption = "",
    // timing
    delayMs = 0,
    typingDurationMs = 2000,
  } = req.body;

  if (!sessionId || !to) {
    return res.status(400).json({ error: "Missing: sessionId, to" });
  }
  if (!text && !imageUrl && !imageBase64) {
    return res
      .status(400)
      .json({ error: "Missing: text, imageUrl, atau imageBase64" });
  }

  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.status !== "ready") {
    return res
      .status(400)
      .json({ error: `Not ready (status: ${session.status})` });
  }

  try {
    if (delayMs > 0) await sleep(delayMs);

    let msg;

    if (text) {
      // ── Kirim teks dengan typing indicator ──────────────────────────────────
      const chat = await session.client.getChatById(to);
      await chat.sendStateTyping();
      await sleep(typingDurationMs);
      await chat.clearState();
      msg = await session.client.sendMessage(to, text);
    } else if (imageUrl) {
      // ── Kirim gambar dari URL ────────────────────────────────────────────────
      const media = await MessageMedia.fromUrl(imageUrl, { unsafeMime: true });
      msg = await session.client.sendMessage(to, media, {
        caption: caption || undefined,
      });
    } else if (imageBase64) {
      // ── Kirim gambar dari base64 ─────────────────────────────────────────────
      // Hapus prefix "data:image/jpeg;base64," jika ada
      const base64Data = imageBase64.includes(",")
        ? imageBase64.split(",")[1]
        : imageBase64;

      const media = new MessageMedia(mimeType, base64Data, filename);
      msg = await session.client.sendMessage(to, media, {
        caption: caption || undefined,
      });
    }

    res.json({ success: true, messageId: msg.id.id });
  } catch (err) {
    console.error(`[${sessionId}] Send error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/session/read
// Body: { sessionId, chatId }
app.post("/api/session/read", async (req, res) => {
  const { sessionId, chatId } = req.body;
  if (!sessionId || !chatId) {
    return res.status(400).json({ error: "Missing: sessionId, chatId" });
  }

  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.status !== "ready") {
    return res
      .status(400)
      .json({ error: `Not ready (status: ${session.status})` });
  }

  try {
    const chat = await session.client.getChatById(chatId);
    await chat.sendSeen();
    res.json({ success: true });
  } catch (err) {
    console.error(`[${sessionId}] Read error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await restoreSessions();
});
