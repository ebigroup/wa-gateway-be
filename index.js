require("dotenv").config();
const express = require("express");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
const { randomBytes } = require("crypto");

// Jangan biarkan proses mati karena error yang bisa kita log
process.on("unhandledRejection", (reason, p) => {
  console.error("Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

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
  if (
    id.endsWith("@c.us") ||
    id.endsWith("@g.us") ||
    id.endsWith("@broadcast")
  ) {
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

function phoneFromJid(jid) {
  if (!jid) return null;
  const user = jid.split("@")[0];
  const digits = user.replace(/\D/g, "");
  return digits || null;
}

function normalizePhone(number) {
  if (!number) return null;
  let n = number.replace(/\D/g, "");
  if (!n) return null;
  // Jika diawali 0, ubah ke 62 (Indonesia)
  if (n.startsWith("0")) n = `62${n.slice(1)}`;
  return n;
}

function canonicalJid(id) {
  if (!id) return null;
  if (id.endsWith("@lid")) return `${id.split("@")[0]}@c.us`;
  if (id.endsWith("@c.us")) return id;
  return id;
}

/**
 * Upload base64 media ke API external dan kembalikan URL-nya.
 */
async function uploadMediaToExternal(media) {
  if (!process.env.CHAT_API_BASE_URL) {
    // console.warn("[Upload] CHAT_API_BASE_URL not set, skipping media upload");
    return null;
  }

  try {
    const formData = new FormData();
    const buffer = Buffer.from(media.data, "base64");
    const blob = new Blob([buffer], { type: media.mimetype });
    formData.append("file", blob, media.filename || "upload.jpg");
    formData.append("folder", "transactions");

    const response = await axios.post(
      `${process.env.CHAT_API_BASE_URL}/v2/upload/image`,
      formData,
      {
        headers: { "Content-Type": "multipart/form-data" },
      },
    );

    if (response.data?.status && response.data?.data?.url) {
      return response.data.data.url;
    }
  } catch (err) {
    console.error(
      "[Upload] Failed to upload media:",
      err.response?.data || err.message,
    );
  }
  return null;
}

function logWebhookPayload(sessionId, payload) {
  const clone = { ...payload };
  if (payload.media?.data) {
    clone.media = {
      ...payload.media,
      data: `[BASE64 DATA: ${payload.media.data.length} chars]`,
    };
  }
  console.log(
    `[${sessionId}] Webhook payload:`,
    JSON.stringify(clone, null, 2),
  );
}

function formatTimestamp(ts) {
  if (!ts) return null;
  const ms = ts < 2_000_000_000 ? ts * 1000 : ts;
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
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
          "--disable-extensions",
          "--disable-software-rasterizer",
          "--mute-audio",
          "--no-default-browser-check",
          "--disable-background-networking",
          "--disable-background-timer-throttling",
          "--disable-client-side-phishing-detection",
          "--disable-default-apps",
          "--disable-sync",
          "--metrics-recording-only",
          "--safebrowsing-disable-auto-update",
          "--ignore-certificate-errors",
          "--ignore-ssl-errors",
          "--ignore-certificate-errors-spki-list"
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

    client.on("ready", async () => {
      const session = sessions.get(sessionId);
      if (session) session.status = "ready";
      console.log(`[${sessionId}] Ready`);

      // Kirim webhook event connected
      const url = session?.webhookUrl || webhookUrl;
      if (url) {
        const payload = {
          event: "connected",
          sessionId,
          status: "ready",
          timestamp: Math.floor(Date.now() / 1000)
        };
        try {
          logWebhookPayload(sessionId, payload);
          await axios.post(url, payload);
        } catch (err) {
          console.error(`[${sessionId}] Webhook (connected) failed:`, err.message);
        }
      }

      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ sessionId, qr: null });
      }
    });

    client.on("error", (err) => {
      console.error(`[${sessionId}] Client error:`, err.message || err);
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

      const chat = await message.getChat().catch(() => null);
      const contact = await message.getContact().catch(() => null);
      const contactJid = canonicalJid(contact?.id?._serialized || null);
      const chatJid = canonicalJid(chat?.id?._serialized || null);
      const from =
        contactJid ||
        chatJid ||
        canonicalJid(message.id?.remote) ||
        canonicalJid(message.from) ||
        (await normalizeId(message, message.from));
      // Abaikan grup/status
      if (!from || !from.endsWith("@c.us")) return;
      const phone = normalizePhone(
        contact?.id?.user || chat?.id?.user || phoneFromJid(from),
      );

      console.log(
        `[${sessionId}] in debug: from=${from}, rawFrom=${message.from}, contact=${contact?.id?._serialized}, chatId=${chat?.id?._serialized}, chatUser=${chat?.id?.user}, msg.id.remote=${message.id?.remote}`,
      );

      const payload = {
        event: "message_in",
        sessionId,
        jid: from,
        phone,
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
        if (url) await axios.post(url, payload);
      } catch (err) {
        console.error(`[${sessionId}] Webhook failed:`, err.message);
      }
    });

    // Pesan keluar (dikirim via API) → kirim ke webhook juga
    client.on("message_create", async (message) => {
      if (!message.fromMe) return;

      const session = sessions.get(sessionId);
      const url = session?.webhookUrl;

      const chat = await message.getChat().catch(() => null);
      const contact = await message.getContact().catch(() => null);
      const peerContact = await chat?.getContact?.().catch(() => null);
      const selfJid =
        session.client?.info?.wid?._serialized ||
        (session.client?.info?.wid?.user
          ? `${session.client.info.wid.user}@c.us`
          : null);
      const rawPeerCandidate =
        peerContact?.id?._serialized ||
        message.id?.remote ||
        contact?.id?._serialized ||
        message.to ||
        chat?.id?._serialized ||
        message.from;

      const to =
        canonicalJid(rawPeerCandidate) ||
        (await normalizeId(message, rawPeerCandidate));
      const from =
        selfJid ||
        canonicalJid(message.from) ||
        (await normalizeId(message, message.from));
      // Abaikan grup/status
      if (!to || !to.endsWith("@c.us")) return;
      const phone = normalizePhone(
        phoneFromJid(to) ||
          peerContact?.id?.user ||
          contact?.id?.user ||
          (rawPeerCandidate || "").split("@")[0] ||
          chat?.id?.user ||
          null,
      );

      // Debug mapping for outbound (helps ensure we use correct peer JID)
      console.log(
        `[${sessionId}] out debug: to=${to}, type=${message.type}, hasMedia=${message.hasMedia}, body=${message.body?.slice(0, 50)}, rawTo=${rawPeerCandidate}, self=${selfJid}`,
      );

      const payload = {
        event: "message_out",
        sessionId,
        jid: to,
        phone,
        to,
        rawTo: rawPeerCandidate,
        from,
        rawFrom: selfJid || message.from,
        text: message.body,
        timestamp: message.timestamp,
        messageId: message.id.id,
        type: message.type,
        hasMedia: message.hasMedia,
      };

      if (
        message.hasMedia ||
        ["image", "video", "document"].includes(message.type)
      ) {
        try {
          // Beri jeda sedikit agar media siap didownload
          await new Promise((r) => setTimeout(r, 500));
          const media = await message.downloadMedia();
          if (media) {
            payload.media = {
              mimetype: media.mimetype,
              filename: media.filename || null,
              data: media.data, // base64
            };
          }
        } catch (err) {
          console.error(
            `[${sessionId}] Failed to download outgoing media:`,
            err.message,
          );
        }
      }



      try {
        logWebhookPayload(sessionId, payload);
        if (url) await axios.post(url, payload);
      } catch (err) {
        console.error(`[${sessionId}] Webhook failed:`, err.message);
      }
    });

    // Status pesan (sent/delivered/read/played) → webhook
    client.on("message_ack", async (message, ack) => {
      const session = sessions.get(sessionId);
      const url = session?.webhookUrl;

      const from =
        canonicalJid(message.from) ||
        (await normalizeId(message, message.from));
      const to =
        canonicalJid(message.to) ||
        canonicalJid(message.id?.remote) ||
        (await normalizeId(
          message,
          message.to || message.id?.remote || message.from,
        ));
      const phone = normalizePhone(
        phoneFromJid(to) ||
          message.id?.remote?.split("@")[0] ||
          message.to?.split("@")[0],
      );
      if (!to || !to.endsWith("@c.us")) return;

      const payload = {
        event: "message_ack",
        sessionId,
        messageId: message.id.id,
        fromMe: message.fromMe,
        from,
        rawFrom: message.from,
        to,
        rawTo: message.to,
        phone,
        jid: to,
        ack,
        status: ACK_STATUS[ack] || "unknown",
        timestamp: message.timestamp,
      };

      try {
        logWebhookPayload(sessionId, payload);
        if (url) await axios.post(url, payload);
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
// Body: { phoneNumber?, sessionId?, webhookUrl? }
app.post("/api/session/start", async (req, res) => {
  let { sessionId, phoneNumber, webhookUrl = null } = req.body;
  if (phoneNumber) sessionId = normalizePhone(phoneNumber) || phoneNumber;
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
    // gambar/file via base64 — bisa sertakan "data:application/pdf;base64," atau tanpa prefix
    imageBase64,
    mimeType: mimeTypeParam,
    filename: filenameParam,
    fileName: fileNameParam, // Alias untuk request CamelCase
    caption = "",
    // timing
    delayMs = 0,
    typingDurationMs = 2000,
  } = req.body;

  const mimeType = mimeTypeParam || "image/jpeg";
  const filename = fileNameParam || filenameParam || "image.jpg";

  if (!sessionId || !to) {
    return res.status(400).json({ error: "Missing: sessionId, to" });
  }

  // Auto-append @c.us if missing (assume individual contact if no @ sign)
  let formattedTo = to.toString().trim();
  if (!formattedTo.includes("@")) {
    formattedTo = `${formattedTo}@c.us`;
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
      const chat = await session.client.getChatById(formattedTo);
      await chat.sendStateTyping();
      await sleep(typingDurationMs);
      await chat.clearState();
      msg = await session.client.sendMessage(formattedTo, text);
    } else if (imageUrl) {
      // ── Kirim gambar dari URL ────────────────────────────────────────────────
      const media = await MessageMedia.fromUrl(imageUrl, { unsafeMime: true });
      msg = await session.client.sendMessage(formattedTo, media, {
        caption: caption || undefined,
      });
    } else if (imageBase64) {
      // ── Kirim gambar/file dari base64 ─────────────────────────────────────────────
      let finalMime = mimeType;
      let finalBase64 = imageBase64;

      // Deteksi otomatis mimetype jika ada prefix "data:..."
      if (imageBase64.includes(",")) {
        const parts = imageBase64.split(",");
        const match = parts[0].match(/data:(.*?);base64/);
        if (match) finalMime = match[1];
        finalBase64 = parts[1];
      }

      const media = new MessageMedia(finalMime, finalBase64, filename);
      msg = await session.client.sendMessage(formattedTo, media, {
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
