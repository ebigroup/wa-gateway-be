# WhatsApp API Server — Dokumentasi

Server REST berbasis [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js).

---

## Setup

```bash
npm install
node server.js
```

**.env**

```env
PORT=3000
CHROME_BIN=/usr/bin/chromium-browser   # opsional
```

> `WEBHOOK_URL` di `.env` sudah tidak dipakai. Webhook sekarang diset per-session lewat body request.

---

## Format Nomor

| Tujuan   | Format                      | Contoh                    |
| -------- | --------------------------- | ------------------------- |
| Personal | `{kode_negara}{nomor}@c.us` | `6281234567890@c.us`      |
| Grup     | `{group_id}@g.us`           | `120363012345678901@g.us` |

---

## sessions.json

Format file yang tersimpan di disk:

```json
{
  "akun1": { "webhookUrl": "https://domain.com/webhook/akun1" },
  "akun2": { "webhookUrl": null }
}
```

---

## Endpoints

### 1. Mulai Session

```
POST /api/session/start
```

**Body**

```json
{
  "sessionId": "akun1",
  "webhookUrl": "https://domain.com/webhook/akun1"
}
```

| Field        | Wajib | Keterangan                               |
| ------------ | ----- | ---------------------------------------- |
| `sessionId`  | Tidak | Di-generate otomatis jika kosong         |
| `webhookUrl` | Tidak | URL tujuan pesan masuk untuk session ini |

**Response**

```json
{
  "sessionId": "akun1",
  "qr": "data:image/png;base64,..."
}
```

`qr` bernilai `null` jika session langsung tersambung (resume dari sesi sebelumnya).

---

### 2. Update Webhook

Ganti atau hapus `webhookUrl` tanpa perlu buat ulang session.

```
PATCH /api/session/:sessionId/webhook
```

**Body**

```json
{ "webhookUrl": "https://domain.com/webhook-baru" }
```

Untuk hapus webhook (tidak forward pesan masuk):

```json
{ "webhookUrl": null }
```

**Response**

```json
{ "success": true, "webhookUrl": "https://domain.com/webhook-baru" }
```

---

### 3. Ambil QR

```
GET /api/session/qr/:sessionId
```

**Response**

```json
{ "qr": "data:image/png;base64,..." }
```

Tampilkan di browser:

```html
<img src="data:image/png;base64,..." />
```

---

### 4. Cek Status

```
GET /api/session/status/:sessionId
```

**Response**

```json
{
  "sessionId": "akun1",
  "status": "ready",
  "webhookUrl": "https://domain.com/webhook/akun1"
}
```

| Status          | Keterangan               |
| --------------- | ------------------------ |
| `initializing`  | Chromium baru dijalankan |
| `qr_ready`      | Menunggu scan QR         |
| `authenticated` | QR di-scan, sedang load  |
| `ready`         | Siap digunakan           |
| `disconnected`  | Terputus                 |

---

### 5. Daftar Semua Session

```
GET /api/sessions
```

**Response**

```json
[
  { "sessionId": "akun1", "status": "ready", "webhookUrl": "https://..." },
  { "sessionId": "akun2", "status": "qr_ready", "webhookUrl": null }
]
```

---

### 6. Hapus Session

```
DELETE /api/session/:sessionId
```

**Response**

```json
{ "success": true }
```

---

### 7. Kirim Pesan

Satu endpoint untuk kirim teks, gambar via URL, atau gambar via base64.

```
POST /api/session/send
```

---

#### 7a. Kirim Teks

```json
{
  "sessionId": "akun1",
  "to": "6281234567890@c.us",
  "text": "Halo!",
  "delayMs": 0,
  "typingDurationMs": 2000
}
```

| Field              | Wajib | Default | Keterangan                     |
| ------------------ | ----- | ------- | ------------------------------ |
| `sessionId`        | Ya    | —       |                                |
| `to`               | Ya    | —       | Nomor tujuan                   |
| `text`             | Ya    | —       | Isi pesan                      |
| `delayMs`          | Tidak | `0`     | Jeda sebelum mengetik (ms)     |
| `typingDurationMs` | Tidak | `2000`  | Durasi indikator mengetik (ms) |

---

#### 7b. Kirim Gambar via URL

```json
{
  "sessionId": "akun1",
  "to": "6281234567890@c.us",
  "imageUrl": "https://example.com/foto.jpg",
  "caption": "Ini captionnya"
}
```

| Field       | Wajib | Keterangan           |
| ----------- | ----- | -------------------- |
| `sessionId` | Ya    |                      |
| `to`        | Ya    |                      |
| `imageUrl`  | Ya    | URL publik gambar    |
| `caption`   | Tidak | Teks di bawah gambar |

---

#### 7c. Kirim Gambar via Base64

```json
{
  "sessionId": "akun1",
  "to": "6281234567890@c.us",
  "imageBase64": "data:image/jpeg;base64,/9j/4AAQSkZJRgAB...",
  "mimeType": "image/jpeg",
  "filename": "foto.jpg",
  "caption": "Ini captionnya"
}
```

| Field         | Wajib | Default      | Keterangan                                               |
| ------------- | ----- | ------------ | -------------------------------------------------------- |
| `sessionId`   | Ya    | —            |                                                          |
| `to`          | Ya    | —            |                                                          |
| `imageBase64` | Ya    | —            | Base64 gambar, boleh dengan atau tanpa prefix `data:...` |
| `mimeType`    | Tidak | `image/jpeg` | MIME type gambar                                         |
| `filename`    | Tidak | `image.jpg`  | Nama file                                                |
| `caption`     | Tidak | `""`         | Teks di bawah gambar                                     |

**Response (semua tipe)**

```json
{ "success": true, "messageId": "3EB0123456789ABCDEF" }
```

---

### 8. Tandai Dibaca

```
POST /api/session/read
```

**Body**

```json
{
  "sessionId": "akun1",
  "chatId": "6281234567890@c.us"
}
```

**Response**

```json
{ "success": true }
```

---

## Webhook — Payload Pesan Masuk

Setiap pesan masuk yang bukan dari diri sendiri akan di-POST ke `webhookUrl` milik session tersebut.

**Pesan teks:**

```json
{
  "sessionId": "akun1",
  "from": "6281234567890@c.us",
  "text": "Halo balik!",
  "timestamp": 1718000000,
  "messageId": "3EB0ABCDEF123456789",
  "type": "chat",
  "hasMedia": false
}
```

**Pesan dengan gambar/file:**

```json
{
  "sessionId": "akun1",
  "from": "6281234567890@c.us",
  "text": "",
  "timestamp": 1718000000,
  "messageId": "3EB0ABCDEF123456789",
  "type": "image",
  "hasMedia": true,
  "media": {
    "mimetype": "image/jpeg",
    "filename": "foto.jpg",
    "data": "/9j/4AAQSkZJRgAB..."
  }
}
```

---

## Contoh cURL

**Start session dengan webhook:**

```bash
curl -X POST http://localhost:3000/api/session/start \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"akun1","webhookUrl":"https://domain.com/hook"}'
```

**Kirim teks:**

```bash
curl -X POST http://localhost:3000/api/session/send \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"akun1","to":"6281234567890@c.us","text":"Halo!"}'
```

**Kirim gambar via URL:**

```bash
curl -X POST http://localhost:3000/api/session/send \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"akun1","to":"6281234567890@c.us","imageUrl":"https://example.com/img.jpg","caption":"Lihat ini"}'
```

**Update webhook:**

```bash
curl -X PATCH http://localhost:3000/api/session/akun1/webhook \
  -H "Content-Type: application/json" \
  -d '{"webhookUrl":"https://domain.com/hook-baru"}'
```

---

## Contoh PHP

**Kirim teks:**

```php
<?php
function waSend($sessionId, $to, $text) {
    $ch = curl_init('http://localhost:3000/api/session/send');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS     => json_encode([
            'sessionId' => $sessionId,
            'to'        => $to,
            'text'      => $text,
        ]),
    ]);
    $res = json_decode(curl_exec($ch), true);
    curl_close($ch);
    return $res;
}

$result = waSend('akun1', '6281234567890@c.us', 'Halo dari PHP!');
echo $result['success'] ? 'OK: ' . $result['messageId'] : 'Error: ' . $result['error'];
```

**Kirim gambar dari file:**

```php
<?php
$imageData = base64_encode(file_get_contents('/path/to/foto.jpg'));

$ch = curl_init('http://localhost:3000/api/session/send');
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST           => true,
    CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
    CURLOPT_POSTFIELDS     => json_encode([
        'sessionId'   => 'akun1',
        'to'          => '6281234567890@c.us',
        'imageBase64' => $imageData,
        'mimeType'    => 'image/jpeg',
        'filename'    => 'foto.jpg',
        'caption'     => 'Foto dari server',
    ]),
]);
$res = json_decode(curl_exec($ch), true);
curl_close($ch);
```
