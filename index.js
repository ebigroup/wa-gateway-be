require("dotenv").config();
const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
const { randomBytes } = require("crypto");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// File yang menyimpan daftar sessionId yang perlu di-restore saat server boot
const SESSIONS_FILE = path.join(__dirname, "sessions.json");

// sessionId -> { client, qr, status }
// status: 'initializing' | 'qr_ready' | 'authenticated' | 'ready' | 'disconnected'
const sessions = new Map();

function generateSessionId() {
  return randomBytes(8).toString("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Simpan daftar sessionId ke disk ──────────────────────────────────────────
async function persistSessions() {
  const ids = [...sessions.keys()];
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(ids, null, 2));
}

// ── Load & restore semua session yang tersimpan saat server boot ──────────────
async function restoreSessions() {
  let ids = [];
  try {
    const raw = await fs.readFile(SESSIONS_FILE, "utf-8");
    ids = JSON.parse(raw);
  } catch {
    return; // file belum ada, tidak ada yang perlu di-restore
  }

  if (!ids.length) return;
  console.log(`Restoring ${ids.length} session(s):`, ids);

  for (const sessionId of ids) {
    // Hanya restore jika folder auth-nya masih ada (belum dihapus)
    const authPath = path.join(
      __dirname,
      ".wwebjs_auth",
      `session-${sessionId}`,
    );
    try {
      await fs.access(authPath);
    } catch {
      console.log(`[${sessionId}] Auth folder not found, skipping restore`);
      continue;
    }

    console.log(`[${sessionId}] Restoring...`);
    // Jalankan di background, jangan blokir startup server
    startSession(sessionId)
      .then(({ qr }) => {
        if (qr) {
          console.log(
            `[${sessionId}] QR needed – fetch via GET /api/session/qr/${sessionId}`,
          );
        } else {
          console.log(`[${sessionId}] Restored successfully`);
        }
      })
      .catch((err) => {
        console.error(`[${sessionId}] Restore failed:`, err.message);
      });
  }
}

// ── Create and initialize a wwebjs client ─────────────────────────────────────
function startSession(sessionId) {
  return new Promise((resolve, reject) => {
    // LocalAuth saves session to ./.wwebjs_auth/session-<sessionId>
    // so re-running the server won't need a new QR scan
    const client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionId }),
      puppeteer: {
        headless: true,
        // Use system Chromium if available (avoids missing .so library issues)
        executablePath: process.env.CHROME_BIN || undefined,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--single-process", // helps in constrained environments
          "--disable-gpu",
        ],
      },
    });

    sessions.set(sessionId, { client, qr: null, status: "initializing" });

    // Resolve only once
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error("Timeout: no QR or connection after 60s"));
      }
    }, 60_000);

    // ── QR received ──────────────────────────────────────────────────────────
    client.on("qr", async (qr) => {
      try {
        const qrImage = await QRCode.toDataURL(qr);
        const session = sessions.get(sessionId);
        if (session) {
          session.qr = qrImage;
          session.status = "qr_ready";
        }
        console.log(`[${sessionId}] QR ready – scan with WhatsApp`);

        // Resolve on first QR so HTTP response returns immediately
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

    // ── Authenticated (QR was scanned) ───────────────────────────────────────
    client.on("authenticated", () => {
      const session = sessions.get(sessionId);
      if (session) {
        session.status = "authenticated";
        session.qr = null;
      }
      console.log(`[${sessionId}] Authenticated`);
    });

    // ── Ready (fully loaded – also fires when resuming a saved session) ──────
    client.on("ready", () => {
      const session = sessions.get(sessionId);
      if (session) session.status = "ready";
      console.log(`[${sessionId}] Ready`);

      // Resumed sessions skip QR and go straight here
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ sessionId, qr: null });
      }
    });

    // ── Disconnected ─────────────────────────────────────────────────────────
    client.on("disconnected", (reason) => {
      console.log(`[${sessionId}] Disconnected:`, reason);
      const session = sessions.get(sessionId);
      if (session) session.status = "disconnected";
    });

    // ── Auth failure ─────────────────────────────────────────────────────────
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

    // ── Incoming messages → webhook ──────────────────────────────────────────
    client.on("message", async (message) => {
      if (!WEBHOOK_URL || message.fromMe) return;
      try {
        await axios.post(WEBHOOK_URL, {
          sessionId,
          from: message.from,
          text: message.body,
          timestamp: message.timestamp,
          messageId: message.id.id,
        });
      } catch (err) {
        console.error(`[${sessionId}] Webhook failed:`, err.message);
      }
    });

    // Launch Puppeteer + Chromium
    client.initialize().catch((err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`initialize() failed: ${err.message}`));
      }
    });
  });
}

// ── Delete a session ──────────────────────────────────────────────────────────
async function deleteSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  try {
    await session.client.destroy();
  } catch (_) {}

  // Remove saved auth folder
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
// Body (optional): { sessionId: "myname" }
// Returns: { sessionId, qr: "<dataURL>" }  — qr is null if session resumed
app.post("/api/session/start", async (req, res) => {
  let { sessionId } = req.body;
  if (!sessionId) sessionId = generateSessionId();

  if (sessions.has(sessionId)) {
    return res.status(400).json({ error: "Session already exists" });
  }

  try {
    const result = await startSession(sessionId);
    await persistSessions(); // simpan daftar session ke disk
    res.json(result);
  } catch (err) {
    sessions.delete(sessionId);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/session/qr/:sessionId
// Fetch the latest QR image (refreshes if WhatsApp sends a new one before scan)
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

// GET /api/session/status/:sessionId
app.get("/api/session/status/:sessionId", (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({ sessionId: req.params.sessionId, status: session.status });
});

// GET /api/sessions  — list all active sessions
app.get("/api/sessions", (_req, res) => {
  const list = [...sessions.entries()].map(([id, s]) => ({
    sessionId: id,
    status: s.status,
  }));
  res.json(list);
});

// DELETE /api/session/:sessionId
app.delete("/api/session/:sessionId", async (req, res) => {
  const ok = await deleteSession(req.params.sessionId);
  if (!ok) return res.status(404).json({ error: "Session not found" });
  await persistSessions(); // update daftar session di disk
  res.json({ success: true });
});

// POST /api/session/send
// Body: { sessionId, to, text, delayMs?, typingDurationMs? }
// "to" examples:
//   personal : "6281234567890@c.us"
//   group    : "120363xxxxxx@g.us"
app.post("/api/session/send", async (req, res) => {
  const {
    sessionId,
    to,
    text,
    delayMs = 0,
    typingDurationMs = 2000,
  } = req.body;
  if (!sessionId || !to || !text) {
    return res.status(400).json({ error: "Missing: sessionId, to, text" });
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

    // Typing indicator
    const chat = await session.client.getChatById(to);
    await chat.sendStateTyping();
    await sleep(typingDurationMs);
    await chat.clearState();

    const msg = await session.client.sendMessage(to, text);
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
  await restoreSessions(); // auto-reconnect semua session sebelumnya
});
