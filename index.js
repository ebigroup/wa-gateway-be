require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
const { randomBytes } = require("crypto");
const mysql = require("mysql2/promise");

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
const DB_HOST = process.env.DB_HOST || "153.92.15.39";
const DB_NAME = process.env.DB_NAME || "u623463806_hope_stg";
const DB_USER = process.env.DB_USER || "u623463806_admin";
const DB_PASS = process.env.DB_PASS || "AsikAsikJos!23";
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DEFAULT_TENANT_ID = Number(process.env.DEFAULT_TENANT_ID || 1);
const DEFAULT_ID_TOKO =
  process.env.DEFAULT_ID_TOKO === undefined
    ? null
    : Number(process.env.DEFAULT_ID_TOKO);

// sessions.json menyimpan: { sessionId: { webhookUrl } }
const SESSIONS_FILE = path.join(__dirname, "sessions.json");

// sessionId -> { client, qr, status, webhookUrl }
const sessions = new Map();

// MySQL pool
const db = mysql.createPool({
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASS,
  database: DB_NAME,
  port: DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
});

// WebSocket room state
const rooms = new Map(); // roomName -> Set<ws>
let wss = null;

function broadcastRoom(room, message, excludeWs = null) {
  const clients = rooms.get(room);
  if (!clients) return;
  const data = typeof message === "string" ? message : JSON.stringify(message);
  for (const ws of clients) {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function joinRoom(ws, room, channel = null) {
  const fullRoom = channel ? `${room}-${channel}` : room;
  if (!rooms.has(fullRoom)) rooms.set(fullRoom, new Set());
  rooms.get(fullRoom).add(ws);
  if (!ws.rooms) ws.rooms = new Set();
  ws.rooms.add(fullRoom);
}

function leaveRoom(ws, room, channel = null) {
  const fullRoom = channel ? `${room}-${channel}` : room;
  const roomClients = rooms.get(fullRoom);
  if (!roomClients) return;
  roomClients.delete(ws);
  if (roomClients.size === 0) rooms.delete(fullRoom);
  ws.rooms?.delete(fullRoom);
}

function leaveAllRooms(ws) {
  if (!ws.rooms) return;
  for (const room of ws.rooms) {
    const roomClients = rooms.get(room);
    if (!roomClients) continue;
    roomClients.delete(ws);
    if (roomClients.size === 0) rooms.delete(room);
  }
  ws.rooms.clear();
}

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

async function withDb(fn) {
  const conn = await db.getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

const storeCache = new Map(); // sessionId -> { id_toko, tenant_id }

async function resolveStoreBySession(sessionId) {
  if (!sessionId) return null;
  if (storeCache.has(sessionId)) return storeCache.get(sessionId);
  const [rows] = await db.query(
    `SELECT tm.toko_id AS id_toko, t.tenant_id
     FROM toko_meta tm
     JOIN toko t ON t.id = tm.toko_id
     WHERE tm.meta_key = 'chat_session_id' AND tm.meta_value = ?
     LIMIT 1`,
    [sessionId],
  );
  const result = rows[0] || null;
  storeCache.set(sessionId, result);
  return result;
}

async function updateSessionStatusMeta(sessionId, status) {
  const store = await resolveStoreBySession(sessionId);
  if (!store?.id_toko) return;
  await withDb((conn) =>
    conn.query(
      `UPDATE toko_meta
         SET meta_value = ?, updated_at = NOW()
       WHERE toko_id = ? AND meta_key = 'chat_session_status'`,
      [status, store.id_toko],
    ),
  );
}

async function upsertChatAndMessage({
  sessionId,
  phone,
  jid,
  chatJid,
  text,
  direction, // 'in' | 'out'
  fromMe,
  messageType,
  externalId,
  timestamp,
  id_toko = DEFAULT_ID_TOKO,
  tenant_id = DEFAULT_TENANT_ID,
  quotedText = null,
  quotedExternalId = null,
  mediaPath = null,
  mediaMime = null,
}) {
  const ts = formatTimestamp(timestamp || Date.now());
  const lastSnippet = text ? text.slice(0, 120) : null;
  return withDb(async (conn) => {
    let chatId;
    // Cari berdasar phone dulu (karena sudah dinormalisasi), lalu jid
    const [existingPhone] = await conn.query(
      `SELECT id FROM whatsapp_chats
         WHERE session_id = ? AND phone = ?
         LIMIT 1`,
      [sessionId, phone],
    );
    const [existingJid] = await conn.query(
      `SELECT id FROM whatsapp_chats
         WHERE session_id = ? AND jid = ?
         LIMIT 1`,
      [sessionId, jid],
    );
    const [existingChatJid] = await conn.query(
      `SELECT id FROM whatsapp_chats
         WHERE session_id = ? AND jid = ?
         LIMIT 1`,
      [sessionId, chatJid],
    );

    if (existingPhone.length) {
      chatId = existingPhone[0].id;
    } else if (existingJid.length) {
      chatId = existingJid[0].id;
    } else if (existingChatJid.length) {
      chatId = existingChatJid[0].id;
    }

    if (chatId) {
      await conn.query(
        `UPDATE whatsapp_chats
         SET phone = COALESCE(?, phone),
             jid = COALESCE(?, jid),
             id_toko = COALESCE(?, id_toko),
             last_message_at = ?,
             last_message_snippet = ?,
             unread_count = unread_count + ?,
             updated_at = NOW()
         WHERE id = ?`,
        [
          phone || null,
          chatJid || jid || null,
          id_toko,
          ts,
          lastSnippet,
          direction === "in" ? 1 : 0,
          chatId,
        ],
      );
    } else {
      const [insert] = await conn.query(
        `INSERT INTO whatsapp_chats
         (tenant_id, id_toko, phone, jid, session_id, display_name,
          last_message_at, last_message_snippet, unread_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NOW(), NOW())`,
        [
          tenant_id,
          id_toko,
          phone || null,
          chatJid || jid || null,
          sessionId,
          ts,
          lastSnippet,
          direction === "in" ? 1 : 0,
        ],
      );
      chatId = insert.insertId;
    }

    const [msgInsert] = await conn.query(
      `INSERT INTO whatsapp_messages
       (tenant_id, id_toko, chat_id, direction, from_me, message_type, text,
        media_path, media_mime, external_message_id, session_id, status,
        quoted_message_id, quoted_text, received_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        tenant_id,
        id_toko,
        chatId,
        direction,
        fromMe ? 1 : 0,
        messageType || "text",
        text || null,
        mediaPath || null,
        mediaMime || null,
        externalId,
        sessionId,
        "pending",
        quotedExternalId,
        quotedText,
        ts,
      ],
    );

    const [chatRows] = await conn.query(
      "SELECT * FROM whatsapp_chats WHERE id = ? LIMIT 1",
      [chatId],
    );
    const [msgRows] = await conn.query(
      "SELECT * FROM whatsapp_messages WHERE id = ? LIMIT 1",
      [msgInsert.insertId],
    );
    return { chat: chatRows[0], message: msgRows[0] };
  });
}

async function updateMessageStatus(externalId, status) {
  if (!externalId) return;
  return withDb(async (conn) => {
    await conn.query(
      "UPDATE whatsapp_messages SET status = ?, updated_at = NOW() WHERE external_message_id = ?",
      [status, externalId],
    );
    const [rows] = await conn.query(
      "SELECT * FROM whatsapp_messages WHERE external_message_id = ? LIMIT 1",
      [externalId],
    );
    return rows[0] || null;
  });
}

async function fetchChats(sessionId = null, id_toko = null) {
  const rows = await withDb((conn) =>
    conn
      .query(
        `SELECT wc.*,
                COALESCE(wc.display_name, c.nama_customer) AS display_name,
                c.nama_customer
         FROM whatsapp_chats wc
         LEFT JOIN customer c ON c.no_hp_customer = wc.phone
         WHERE (? IS NULL OR wc.session_id = ?)
           AND (? IS NULL OR wc.id_toko = ?)
         ORDER BY wc.updated_at DESC`,
        [sessionId, sessionId, id_toko, id_toko],
      )
      .then(([rows]) => rows),
  );

  if (!rows.length) return rows;

  const chatIds = rows.map((r) => r.id);
  const labelRows = await withDb((conn) =>
    conn
      .query(
        `SELECT cl.chat_id,
                cl.label_id,
                l.name,
                l.color
         FROM whatsapp_chat_labels cl
         JOIN whatsapp_labels l ON l.id = cl.label_id
         WHERE cl.chat_id IN (${chatIds.map(() => "?").join(",")})`,
        chatIds,
      )
      .then(([r]) => r),
  );

  const labelMap = new Map();
  for (const lr of labelRows) {
    if (!labelMap.has(lr.chat_id)) labelMap.set(lr.chat_id, []);
    labelMap.get(lr.chat_id).push({
      label_id: lr.label_id,
      name: lr.name,
      color: lr.color,
    });
  }

  return rows.map((row) => ({
    ...row,
    labels: labelMap.get(row.id) || [],
  }));
}

async function fetchMessages(chatId, limit = 50) {
  return withDb((conn) =>
    conn
      .query(
        `SELECT * FROM whatsapp_messages
         WHERE chat_id = ?
         ORDER BY id DESC
         LIMIT ?`,
        [chatId, limit],
      )
      .then(([rows]) => rows.reverse()),
  );
}

async function markChatRead(chatId) {
  await withDb((conn) =>
    conn.query(
      `UPDATE whatsapp_chats
       SET unread_count = 0, updated_at = NOW()
       WHERE id = ?`,
      [chatId],
    ),
  );
  const [rows] = await withDb((conn) =>
    conn.query("SELECT * FROM whatsapp_chats WHERE id = ? LIMIT 1", [chatId]),
  );
  return rows[0];
}

function matchIdToko(clientIdToko, rowIdToko) {
  if (clientIdToko === undefined || clientIdToko === null) return true;
  return rowIdToko === clientIdToko;
}

function enrichChatForBroadcast(chat) {
  if (!chat) return chat;
  return {
    ...chat,
    display_name: chat.display_name ?? chat.nama_customer ?? chat.displayName,
    labels: chat.labels || [],
  };
}

function broadcastChatUpdate(chat) {
  if (!wss) return;
  const enriched = enrichChatForBroadcast(chat);
  for (const ws of wss.clients) {
    if (
      ws.readyState === WebSocket.OPEN &&
      (ws.meta?.sessionId === null ||
        ws.meta?.sessionId === enriched.session_id) &&
      matchIdToko(ws.meta?.id_toko, enriched.id_toko)
    ) {
      ws.send(JSON.stringify({ type: "chat_updated", chat: enriched }));
    }
  }
}

async function broadcastMessage(message, chat) {
  if (!wss) return chat;

  const watchers = [];
  for (const ws of wss.clients) {
    const watchChat =
      ws.readyState === WebSocket.OPEN &&
      ws.meta?.chatId &&
      Number(ws.meta.chatId) === Number(chat.id);
    if (watchChat) watchers.push(ws);
  }

  // Jika ada yang sedang membuka chat ini dan pesan masuk, tandai sebagai dibaca
  let currentChat = chat;
  if (watchers.length && message.direction === "in") {
    try {
      const updatedChat = await markChatRead(chat.id);
      if (updatedChat) currentChat = updatedChat;
    } catch (err) {
      console.error(
        `[${chat.session_id}] markRead on broadcast failed:`,
        err.message,
      );
    }
  }

  for (const ws of watchers) {
    ws.send(
      JSON.stringify({
        type: "chat_detail_append",
        chatId: currentChat.id,
        message,
      }),
    );
  }

  // Update list view dengan unread terbaru jika berubah
  if (message.direction === "in" && watchers.length) {
    broadcastChatUpdate(currentChat);
  }

  return currentChat;
}

function broadcastMessageStatus(message) {
  if (!wss || !message) return;
  for (const ws of wss.clients) {
    const watchChat =
      ws.readyState === WebSocket.OPEN &&
      ws.meta?.chatId &&
      Number(ws.meta.chatId) === Number(message.chat_id);
    if (watchChat) {
      ws.send(
        JSON.stringify({
          type: "message_status",
          chatId: message.chat_id,
          messageId: message.external_message_id,
          status: message.status,
        }),
      );
    }
  }
}

async function sendChatList(ws) {
  const sessionId = ws.meta?.sessionId ?? null;
  const id_toko = ws.meta?.id_toko ?? null;
  try {
    const chats = await fetchChats(sessionId, id_toko);
    ws.send(JSON.stringify({ type: "chat_list", sessionId, id_toko, chats }));
  } catch (err) {
    ws.send(
      JSON.stringify({ type: "error", message: `db error: ${err.message}` }),
    );
  }
}

async function sendChatDetail(ws, chatId) {
  try {
    const updatedChat = await markChatRead(chatId);
    const messages = await fetchMessages(chatId);
    ws.meta.chatId = chatId;
    ws.send(
      JSON.stringify({
        type: "chat_detail",
        chatId,
        messages,
        chat: updatedChat,
      }),
    );
    if (updatedChat) broadcastChatUpdate(updatedChat);
  } catch (err) {
    ws.send(
      JSON.stringify({ type: "error", message: `db error: ${err.message}` }),
    );
  }
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
      updateSessionStatusMeta(sessionId, "authenticated").catch((e) =>
        console.error(`[${sessionId}] status meta error:`, e.message),
      );
    });

    client.on("ready", () => {
      const session = sessions.get(sessionId);
      if (session) session.status = "ready";
      console.log(`[${sessionId}] Ready`);
      updateSessionStatusMeta(sessionId, "ready").catch((e) =>
        console.error(`[${sessionId}] status meta error:`, e.message),
      );
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
      updateSessionStatusMeta(sessionId, `disconnected:${reason || ""}`).catch(
        (e) => console.error(`[${sessionId}] status meta error:`, e.message),
      );
    });

    client.on("auth_failure", (msg) => {
      console.error(`[${sessionId}] Auth failure:`, msg);
      const session = sessions.get(sessionId);
      if (session) session.status = "disconnected";
      updateSessionStatusMeta(sessionId, "auth_failure").catch((e) =>
        console.error(`[${sessionId}] status meta error:`, e.message),
      );
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
        const store = await resolveStoreBySession(sessionId);
        const tenant_id = store?.tenant_id ?? DEFAULT_TENANT_ID;
        const id_toko = store?.id_toko ?? DEFAULT_ID_TOKO;

        let mediaPath = null;
        if (payload.media) {
          mediaPath = await uploadMediaToExternal(payload.media);
        }

        const { chat, message: savedMessage } = await upsertChatAndMessage({
          sessionId,
          phone,
          jid: from,
          chatJid,
          text: message.body,
          direction: "in",
          fromMe: false,
          messageType: message.type,
          externalId: message.id.id,
          timestamp: message.timestamp,
          id_toko,
          tenant_id,
          quotedText: payload.quoted?.text || null,
          quotedExternalId: payload.quoted?.messageId || null,
          mediaPath,
          mediaMime: payload.media?.mimetype || null,
        });
        const updatedChat = await broadcastMessage(savedMessage, chat);
        broadcastChatUpdate(updatedChat || chat);
      } catch (err) {
        console.error(`[${sessionId}] DB persist error:`, err.message);
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
        const store = await resolveStoreBySession(sessionId);
        const tenant_id = store?.tenant_id ?? DEFAULT_TENANT_ID;
        const id_toko = store?.id_toko ?? DEFAULT_ID_TOKO;

        let mediaPath = null;
        if (payload.media) {
          mediaPath = await uploadMediaToExternal(payload.media);
        }

        let finalMediaPath = mediaPath;
        let finalMediaMime = payload.media?.mimetype || null;

        // Custom logic: If document message starts with "Berikut tagihan untuk pesanan kakak",
        // Extract invoice ID (INVxxx) and store it in media_path / media_mime = transaction.
        if (
          message.type === "document" &&
          message.body &&
          message.body.startsWith("Berikut tagihan untuk pesanan kakak")
        ) {
          const invMatch = message.body.match(/INV[0-9A-Z]+/);
          if (invMatch) {
            finalMediaPath = invMatch[0];
            finalMediaMime = "transaction";
          }
        }

        const { chat, message: savedMessage } = await upsertChatAndMessage({
          sessionId,
          phone,
          jid: to,
          chatJid: to,
          text: message.body,
          direction: "out",
          fromMe: true,
          messageType: message.type,
          externalId: message.id.id,
          timestamp: message.timestamp,
          id_toko,
          tenant_id,
          mediaPath: finalMediaPath,
          mediaMime: finalMediaMime,
        });
        const updatedChat = await broadcastMessage(savedMessage, chat);
        broadcastChatUpdate(updatedChat || chat);
      } catch (err) {
        console.error(`[${sessionId}] DB persist error:`, err.message);
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
        const updatedMsg = await updateMessageStatus(
          message.id.id,
          ACK_STATUS[ack] || "unknown",
        );
        broadcastMessageStatus(updatedMsg);
      } catch (err) {
        console.error(`[${sessionId}] DB ack update error:`, err.message);
      }

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

const server = http.createServer(app);

wss = new WebSocket.Server({ noServer: true });

wss.on("connection", (ws, req) => {
  ws.meta = {};
  const url = new URL(req.url, `http://${req.headers.host}`);
  const qs = Object.fromEntries(url.searchParams.entries());

  // Info awal (bisa diisi token auth sendiri, contohnya dari qs.auth)
  ws.send(JSON.stringify({ event: "ws_connected", info: { query: qs } }));

  ws.on("message", async (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ event: "error", message: "Invalid JSON" }));
      return;
    }

    const action = payload.action;
    if (action === "join") {
      if (!payload.room) {
        ws.send(JSON.stringify({ event: "error", message: "room missing" }));
        return;
      }
      const channel = payload.channel || null; // default null = room utama
      joinRoom(ws, payload.room, channel);
      ws.send(JSON.stringify({ event: "joined", room: payload.room, channel }));
      return;
    }

    if (action === "leave") {
      if (!payload.room) {
        ws.send(JSON.stringify({ event: "error", message: "room missing" }));
        return;
      }
      const channel = payload.channel || null;
      leaveRoom(ws, payload.room, channel);
      ws.send(JSON.stringify({ event: "left", room: payload.room, channel }));
      return;
    }

    if (action === "message") {
      if (!payload.room || !payload.data) {
        ws.send(
          JSON.stringify({ event: "error", message: "room/data missing" }),
        );
        return;
      }
      const channel = payload.channel || null;
      const fullRoom = channel ? `${payload.room}-${channel}` : payload.room;
      broadcastRoom(
        fullRoom,
        { event: "message", room: payload.room, channel, data: payload.data },
        ws,
      );
      return;
    }

    if (action === "join_list") {
      ws.meta.sessionId = payload.sessionId || null;
      ws.meta.id_toko =
        payload.id_toko === undefined || payload.id_toko === null
          ? null
          : Number(payload.id_toko);
      await sendChatList(ws);
      return;
    }

    if (action === "join_chat") {
      if (!payload.chatId) {
        ws.send(JSON.stringify({ event: "error", message: "chatId missing" }));
        return;
      }
      ws.meta.chatId = Number(payload.chatId);
      await sendChatDetail(ws, ws.meta.chatId);
      return;
    }

    ws.send(JSON.stringify({ event: "error", message: "unsupported action" }));
  });

  ws.on("close", () => {
    leaveAllRooms(ws);
  });
});

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

app.post("/api/ws/room/:room/broadcast", (req, res) => {
  const { room } = req.params;
  const { event = "message", data, channel, chat_id } = req.body;
  if (!room || data === undefined) {
    return res.status(400).json({ error: "Missing: room, data" });
  }
  const fullRoom = channel ? `${room}-${channel}` : room;
  const payload = { event, room, channel, data };
  if (chat_id) payload.chat_id = chat_id;
  broadcastRoom(fullRoom, payload);
  res.json({ success: true, room, channel, event, data, chat_id });
});

server.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await restoreSessions();
});
