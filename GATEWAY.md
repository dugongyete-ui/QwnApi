# Qwen Chat Gateway — Dokumentasi API Lengkap

Gateway OpenAI-compatible untuk Alibaba Qwen AI. Gunakan dokumentasi ini di project Replit baru agar AI assistant langsung mengerti cara kerja, endpoint, model, dan contoh request.

---

## Base URL

```
http://localhost:8080        ← development (Replit preview)
https://<repl>.replit.app   ← production (deployed)
```

---

## Autentikasi

Semua endpoint `/v1/*` membutuhkan API key di header Authorization:

```
Authorization: Bearer sk-dzeck-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Format API key: `sk-dzeck-` diikuti 32 karakter hex.

**Endpoint admin** (`/api/*`) tidak membutuhkan autentikasi (hanya untuk internal/localhost).

---

## Models

| Model ID | Deskripsi | Konteks |
|----------|-----------|---------|
| `qwen3-235b-a22b` | Paling kuat, default | 131k |
| `qwen3-30b-a3b` | Cepat, seimbang | 131k |
| `qwen3.7-max` | Vision + multimodal | 131k |
| `qwen3.7-plus` | Plus tier | 131k |
| `qwen3.6-plus` | Plus tier generasi sebelumnya | 131k |
| `qwen3.5-flash` | Paling cepat | 131k |
| `qwen3.5-35b-a3b` | MoE efisien | 131k |
| `qwen-plus` | Alias → qwen3-235b-a22b | 131k |
| `qwen-max` | Alias → qwen3.7-max | 32k |
| `qwen-turbo` | Alias → qwen3.5-flash | 131k |
| `qwen-vl-max` | Alias vision → qwen3.7-max | 131k |
| `qwen2.5-omni-7b` | **Audio + multimodal** | 32k |
| `qwen-audio-turbo` | Alias audio → qwen2.5-omni-7b | 32k |
| `qwen2-audio-instruct` | Alias audio → qwen2.5-omni-7b | 32k |

**Alias vision lain yang tersedia:** `qwen-vl`, `qwen-vl-plus`, `qwen2-vl-7b-instruct`, `qwen2-vl-72b-instruct`, `qwen2.5-vl`, `qwen2.5-vl-max`

---

## Endpoints

### `GET /v1/models` — Daftar model

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer sk-dzeck-..."
```

Response (OpenAI format):
```json
{
  "object": "list",
  "data": [
    { "id": "qwen3-235b-a22b", "object": "model", "owned_by": "qwen-gateway" },
    ...
  ]
}
```

---

### `POST /v1/chat/completions` — Chat (non-streaming)

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-dzeck-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-30b-a3b",
    "messages": [
      { "role": "user", "content": "Berapa 7 dikali 8?" }
    ]
  }'
```

Response (OpenAI format):
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "qwen3-30b-a3b",
  "choices": [{
    "message": { "role": "assistant", "content": "7 × 8 = 56" },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20 }
}
```

---

### `POST /v1/chat/completions` — Streaming SSE

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-dzeck-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-30b-a3b",
    "stream": true,
    "messages": [{ "role": "user", "content": "Hitung 100 dalam 3 langkah" }]
  }'
```

Response: SSE stream dengan `data: {...}` chunks, diakhiri `data: [DONE]`.

---

### `POST /v1/chat/completions` — Vision (analisis gambar)

Gunakan model vision (`qwen-vl-max`, `qwen3.7-max`, dll.). Gambar bisa dari URL atau data URI base64.

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-dzeck-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-vl-max",
    "messages": [{
      "role": "user",
      "content": [
        {
          "type": "image_url",
          "image_url": { "url": "https://www.gstatic.com/webp/gallery/1.jpg" }
        },
        { "type": "text", "text": "Apa yang ada di gambar ini?" }
      ]
    }]
  }'
```

**Catatan:** URL gambar harus bisa diunduh oleh server gateway (hindari URL Wikipedia atau situs dengan hotlink protection). Data URI `data:image/jpeg;base64,...` selalu bekerja.

---

### `POST /v1/chat/completions` — Dokumen / file teks

Kirim file teks (markdown, txt, csv, json, html, xml) sebagai base64. Gateway otomatis meng-inline konten ke prompt.

```python
import base64, requests

content = open("laporan.md", "rb").read()
b64 = base64.b64encode(content).decode()

response = requests.post("http://localhost:8080/v1/chat/completions",
  headers={"Authorization": "Bearer sk-dzeck-..."},
  json={
    "model": "qwen3-30b-a3b",
    "messages": [{
      "role": "user",
      "content": [
        {
          "type": "file",
          "file": {
            "data": b64,
            "mime_type": "text/markdown",
            "name": "laporan.md"
          }
        },
        { "type": "text", "text": "Rangkum dokumen ini dalam 3 poin." }
      ]
    }]
  }
)
print(response.json()["choices"][0]["message"]["content"])
```

**MIME types teks yang didukung (inline):** `text/plain`, `text/markdown`, `text/csv`, `text/html`, `text/xml`, `application/json`, `application/xml`

**File binary (PDF, DOCX):** Dikirim via Qwen OSS — hasilnya tergantung Qwen server-side parse.

---

### `POST /v1/chat/completions` — Audio

Gunakan model omni/audio: `qwen-audio-turbo` atau `qwen2.5-omni-7b`.

```python
import base64, requests

audio_bytes = open("recording.wav", "rb").read()
b64 = base64.b64encode(audio_bytes).decode()

response = requests.post("http://localhost:8080/v1/chat/completions",
  headers={"Authorization": "Bearer sk-dzeck-..."},
  json={
    "model": "qwen-audio-turbo",
    "messages": [{
      "role": "user",
      "content": [
        {
          "type": "input_audio",
          "input_audio": {
            "data": b64,
            "format": "wav"      # wav, mp3, ogg, flac, m4a
          }
        },
        { "type": "text", "text": "Transkripsi audio ini." }
      ]
    }]
  }
)
print(response.json()["choices"][0]["message"]["content"])
```

**Format audio yang didukung:** WAV, MP3, OGG, FLAC, M4A, AAC, WebM.
**Model yang TIDAK support audio:** `qwen3-30b-a3b`, `qwen3-235b-a22b`, semua model non-omni.

---

### `POST /v1/images/generations` — Generate gambar

```bash
curl http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer sk-dzeck-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dall-e-3",
    "prompt": "Kucing astronot di luar angkasa, digital art, detailed",
    "n": 1,
    "size": "1024x1024"
  }'
```

Response:
```json
{
  "data": [{ "url": "https://img.alicdn.com/..." }]
}
```

**Catatan:** Parameter `model` diabaikan — selalu gunakan Qwen image generation internal (`qwen3.7-plus` dengan `chat_type: "t2i"`). URL gambar dari Alibaba CDN.

---

### `POST /v1/completions` — Legacy completions

```bash
curl http://localhost:8080/v1/completions \
  -H "Authorization: Bearer sk-dzeck-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-30b-a3b",
    "prompt": "Ibu kota Indonesia adalah",
    "max_tokens": 50
  }'
```

---

## Admin Endpoints (`/api/*`)

Tidak membutuhkan autentikasi (internal only).

### Kelola API Keys

```bash
# List semua keys
curl http://localhost:8080/api/keys

# Buat key baru
curl -X POST http://localhost:8080/api/keys \
  -H "Content-Type: application/json" \
  -d '{ "name": "My App Key", "isAdmin": false }'

# Hapus key
curl -X DELETE http://localhost:8080/api/keys/{id}
```

Response create key:
```json
{
  "id": "uuid",
  "name": "My App Key",
  "key": "sk-dzeck-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "isAdmin": false,
  "usageCount": 0,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

### Statistik

```bash
# Request stats (7 hari terakhir)
curl http://localhost:8080/api/stats

# Status token pool
curl http://localhost:8080/api/token-pool

# Force refresh pool tokens
curl -X POST http://localhost:8080/api/token-pool/refresh
```

---

## Parameters yang Didukung

| Parameter | Tipe | Keterangan |
|-----------|------|------------|
| `model` | string | ID model (lihat tabel model) |
| `messages` | array | Array pesan OpenAI format |
| `stream` | boolean | SSE streaming (`false` default) |
| `temperature` | float | 0.0–2.0 |
| `max_tokens` | int | Maks token output |
| `top_p` | float | 0.0–1.0 |
| `n` | int | Jumlah completion (non-streaming) |
| `stop` | string/array | Stop sequences |
| `response_format` | object | `{"type":"json_object"}` atau `{"type":"json_schema",...}` |
| `tools` | array | Function calling (OpenAI format) |
| `tool_choice` | string/object | `"auto"`, `"required"`, `{"type":"function",...}` |
| `reasoning_effort` | string | `"none"`, `"low"`, `"medium"`, `"high"` |
| `conversation_id` | string | UUID untuk session persistence |

---

## Integrasi dengan OpenAI SDK

### Python

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-dzeck-...",
    base_url="http://localhost:8080/v1"
)

# Chat biasa
response = client.chat.completions.create(
    model="qwen3-235b-a22b",
    messages=[{"role": "user", "content": "Halo!"}]
)
print(response.choices[0].message.content)

# Streaming
with client.chat.completions.stream(
    model="qwen3-30b-a3b",
    messages=[{"role": "user", "content": "Hitung 1 sampai 10"}]
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

### JavaScript / TypeScript

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "sk-dzeck-...",
  baseURL: "http://localhost:8080/v1",
});

const response = await client.chat.completions.create({
  model: "qwen3-30b-a3b",
  messages: [{ role: "user", content: "Apa itu machine learning?" }],
});
console.log(response.choices[0].message.content);
```

---

## Database Schema

Gateway menggunakan PostgreSQL dengan Drizzle ORM. Schema di `lib/db/src/schema/`.

| Tabel | Keterangan |
|-------|-----------|
| `api_keys` | API keys dengan hash SHA256, usage count |
| `gateway_stats` | Log per-request (durasi, model, success: boolean) |
| `chat_sessions` | Riwayat percakapan (conversation_id, messages JSON) |

**Auto-migrasi**: Tabel dan kolom dibuat otomatis saat server startup via `migrate.ts`.

---

## Token Pool (`bx-umidtoken`)

Gateway membutuhkan `bx-umidtoken` (token anti-bot Alibaba) untuk setiap request ke Qwen.

- **Pool size**: 509 token
- **Cache**: Disimpan ke `artifacts/api-server/token_cache.json`
- **Keepalive**: Refresh otomatis setiap 50 menit (pool tidak pernah expired)
- **Rotation**: Saat upload gagal karena rate limit, gateway otomatis rotasi ke token lain

Lihat status pool:
```bash
curl http://localhost:8080/api/token-pool
```

---

## Environment Variables

| Variabel | Wajib | Keterangan |
|----------|-------|-----------|
| `PORT` | Ya | Port server (8080 di Replit) |
| `DATABASE_URL` | Ya | PostgreSQL connection string |
| `QWEN_SESSION_TOKEN` | Tidak | Token sesi Qwen login (opsional, untuk akun premium) |

---

## Troubleshooting

| Masalah | Penyebab | Solusi |
|---------|---------|--------|
| Vision: model bilang tidak ada gambar | URL gambar di-block saat download | Gunakan URL yang allow automated access, atau data URI |
| Dokumen: model tidak bisa baca file | File bukan teks atau parse Qwen belum selesai | Gunakan MIME type teks; file binary perlu waktu parse |
| Audio: model bilang tidak support audio | Model text-only dipakai | Ganti ke `qwen-audio-turbo` atau `qwen2.5-omni-7b` |
| 503 WAF blocked | curl_cffi pakai `impersonate=` | Hapus flag impersonate dari `qwen_cffi.py` |
| Pool tokens 0 | Server baru restart, pool belum siap | Tunggu ~10 detik, atau hit `/api/token-pool/refresh` |
| DB error: invalid input for boolean | Kolom `success` tipe salah | Jalankan migration manual: `ALTER TABLE gateway_stats ALTER COLUMN success TYPE boolean USING (success::boolean)` |
