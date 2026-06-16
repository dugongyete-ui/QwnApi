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

Semua endpoint `/v1/*` membutuhkan API key di header `Authorization`:

```
Authorization: Bearer gw_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ADMIN_API_KEY Bearer sk-dzeckxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Format API key:** Key baru yang dibuat via `/api/keys` memiliki prefix `gw_` diikuti 32 karakter hex. Key yang diinsert manual ke DB bisa memiliki format custom.

**Endpoint admin** (`/api/*`) tidak membutuhkan autentikasi.

---

## Models

| Model ID | Deskripsi | Konteks |
|----------|-----------|---------|
| `qwen3-235b-a22b` | Paling kuat, default | 131k |
| `qwen3-30b-a3b` | Cepat, seimbang | 131k |
| `qwen3.7-max` | Vision + multimodal | 131k |
| `qwen3.7-plus` | Plus tier | 131k |
| `qwen3.6-plus` | Plus tier generasi lama | 131k |
| `qwen3.5-flash` | Paling cepat | 131k |
| `qwen3.5-35b-a3b` | MoE efisien | 131k |
| `qwen-plus` | Alias → qwen3-235b-a22b | 131k |
| `qwen-max` | Alias → qwen3.7-max | 32k |
| `qwen-turbo` | Alias → qwen3.5-flash | 131k |
| `qwen-vl-max` | Alias vision → qwen3.7-max | 131k |
| `qwen2.5-omni-7b` | **Audio + multimodal** | 32k |
| `qwen-audio-turbo` | Alias audio → qwen2.5-omni-7b | 32k |
| `qwen2-audio-instruct` | Alias audio → qwen2.5-omni-7b | 32k |

**Alias vision lain:** `qwen-vl`, `qwen-vl-plus`, `qwen2-vl-7b-instruct`, `qwen2-vl-72b-instruct`, `qwen2.5-vl`, `qwen2.5-vl-max`
**Alias audio lain:** `qwen2.5-omni`, `qwen2.5-omni-turbo`

---

## Endpoints OpenAI-Compatible (`/v1/*`)

### `GET /v1/models` — Daftar model

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer gw_..."
```

Response:
```json
{
  "object": "list",
  "data": [
    {
      "id": "qwen3-235b-a22b",
      "object": "model",
      "created": 1781252642,
      "owned_by": "qwen-gateway",
      "context_window": 131072
    }
  ]
}
```

---

### `GET /v1/models/:model` — Detail satu model

```bash
curl http://localhost:8080/v1/models/qwen3-30b-a3b \
  -H "Authorization: Bearer gw_..."
```

Response:
```json
{
  "id": "qwen3-30b-a3b",
  "object": "model",
  "created": 1781252642,
  "owned_by": "qwen-gateway",
  "context_window": 131072
}
```

---

### `POST /v1/chat/completions` — Chat teks (non-streaming)

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer gw_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-30b-a3b",
    "messages": [
      { "role": "user", "content": "Berapa 7 dikali 8?" }
    ]
  }'
```

Response:
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1781252192,
  "model": "qwen3-30b-a3b",
  "system_fingerprint": "fp_qwen_gateway_v2",
  "service_tier": "default",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "56", "refusal": null, "tool_calls": null },
    "finish_reason": "stop",
    "logprobs": null
  }],
  "usage": {
    "prompt_tokens": 65,
    "completion_tokens": 3,
    "total_tokens": 68,
    "prompt_tokens_details": { "cached_tokens": 0, "audio_tokens": 0 },
    "completion_tokens_details": { "reasoning_tokens": 0 }
  },
  "x_gateway": { "conversation_id": "uuid-..." }
}
```

---

### `POST /v1/chat/completions` — Streaming SSE

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer gw_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.5-flash",
    "stream": true,
    "messages": [{ "role": "user", "content": "Sebutkan 3 warna" }]
  }'
```

Response: SSE stream dengan format:
```
data: {"id":"chatcmpl-...","choices":[{"delta":{"role":"assistant","content":""},...}]}

data: {"id":"chatcmpl-...","choices":[{"delta":{"content":"Merah"},...}]}

data: [DONE]
```

---

### `POST /v1/chat/completions` — Vision (analisis gambar)

Gunakan model vision (`qwen-vl-max`, `qwen3.7-max`, dll.). URL gambar harus bisa diunduh server (hindari URL Wikipedia/hotlink-protected). Data URI selalu bekerja.

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer gw_..." \
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

Bisa juga pakai data URI:
```json
"image_url": { "url": "data:image/jpeg;base64,/9j/4AAQ..." }
```

---

### `POST /v1/chat/completions` — Dokumen / file teks

File teks (markdown, txt, csv, json, html, xml) dikirim sebagai base64. Gateway otomatis men-decode dan meng-inline konten ke dalam prompt — model langsung bisa membacanya.

```python
import base64, requests

content = open("laporan.md", "rb").read()
b64 = base64.b64encode(content).decode()

response = requests.post("http://localhost:8080/v1/chat/completions",
  headers={"Authorization": "Bearer gw_..."},
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
        { "type": "text", "text": "Rangkum dokumen ini." }
      ]
    }]
  }
)
print(response.json()["choices"][0]["message"]["content"])
```

**MIME types teks yang diinline langsung:** `text/plain`, `text/markdown`, `text/csv`, `text/html`, `text/xml`, `application/json`, `application/xml`

**File binary (PDF, DOCX):** Dikirim via Qwen OSS — bergantung pada Qwen server-side parse.

---

### `POST /v1/chat/completions` — Audio

Harus menggunakan model omni/audio: `qwen-audio-turbo` atau `qwen2.5-omni-7b`. Model text-only tidak bisa proses audio.

```python
import base64, requests

audio_bytes = open("recording.wav", "rb").read()
b64 = base64.b64encode(audio_bytes).decode()

response = requests.post("http://localhost:8080/v1/chat/completions",
  headers={"Authorization": "Bearer gw_..."},
  json={
    "model": "qwen-audio-turbo",
    "messages": [{
      "role": "user",
      "content": [
        {
          "type": "input_audio",
          "input_audio": {
            "data": b64,
            "format": "wav"
          }
        },
        { "type": "text", "text": "Transkripsi dan deskripsikan audio ini." }
      ]
    }]
  }
)
print(response.json()["choices"][0]["message"]["content"])
```

**Format audio:** `wav`, `mp3`, `ogg`, `flac`, `m4a`, `aac`, `webm`

**Model yang support audio:** `qwen2.5-omni-7b`, `qwen-audio-turbo`, `qwen2-audio-instruct`, `qwen2.5-omni`, `qwen2.5-omni-turbo`

**Model yang TIDAK support audio:** semua model selain omni (qwen3-xxx, qwen3.x-xxx, qwen-plus, qwen-max, dll.)

---

### `POST /v1/images/generations` — Generate gambar

```bash
curl http://localhost:8080/v1/images/generations \
  -H "Authorization: Bearer gw_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dall-e-3",
    "prompt": "Seekor kucing oranye di taman bunga, digital art",
    "n": 1,
    "size": "1024x1024"
  }'
```

Response:
```json
{
  "created": 1781252000,
  "data": [
    { "url": "https://cdn.qwenlm.ai/output/..." }
  ]
}
```

**Catatan:** Parameter `model` diabaikan — selalu gunakan Qwen image generation internal. URL gambar dari Alibaba CDN (`cdn.qwenlm.ai`).

---

### `POST /v1/completions` — Legacy completions (text completion)

```bash
curl http://localhost:8080/v1/completions \
  -H "Authorization: Bearer gw_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.5-flash",
    "prompt": "Ibu kota Indonesia adalah",
    "max_tokens": 50
  }'
```

Response (OpenAI format `text.completion`):
```json
{
  "id": "cmpl-...",
  "object": "text_completion",
  "choices": [{ "text": " Jakarta.", "finish_reason": "stop" }]
}
```

---

## Parameters Chat Completions

| Parameter | Tipe | Keterangan |
|-----------|------|------------|
| `model` | string | ID model (lihat tabel model di atas) |
| `messages` | array | Array pesan OpenAI format |
| `stream` | boolean | SSE streaming (default: `false`) |
| `temperature` | float | 0.0–2.0 |
| `max_tokens` | int | Maks token output |
| `top_p` | float | 0.0–1.0 |
| `n` | int | Jumlah completion (non-streaming saja) |
| `stop` | string / array | Stop sequences |
| `response_format` | object | `{"type":"json_object"}` atau `{"type":"json_schema","json_schema":{...}}` |
| `tools` | array | Function calling (OpenAI format) |
| `tool_choice` | string / object | `"auto"`, `"required"`, `{"type":"function","function":{"name":"..."}}` |
| `reasoning_effort` | string | `"none"`, `"low"`, `"medium"`, `"high"` |
| `conversation_id` | string | UUID untuk session persistence lintas request |
| `stream_options` | object | `{"include_usage": true}` untuk token count di SSE |

---

## Admin Endpoints (`/api/*`)

Tidak membutuhkan autentikasi. Hanya untuk internal/localhost.

---

### `GET /api/keys` — List semua API key

```bash
curl http://localhost:8080/api/keys
```

Response:
```json
{
  "keys": [
    {
      "id": "11111111-1111-1111-1111-111111111111",
      "name": "my-app-key",
      "keyPreview": "gw_ab****cd12",
      "createdAt": "2026-06-12T08:00:00.000Z",
      "lastUsed": null,
      "requestCount": 0,
      "isActive": true
    }
  ],
  "total": 1
}
```

**Catatan:** Field `key` (nilai penuh) tidak dikembalikan di list — hanya tersedia saat key pertama kali dibuat.

---

### `POST /api/keys` — Buat API key baru

```bash
curl -X POST http://localhost:8080/api/keys \
  -H "Content-Type: application/json" \
  -d '{ "name": "My App Key" }'
```

Response (key penuh hanya ditampilkan sekali, simpan baik-baik):
```json
{
  "id": "fa2a5b43-73d9-4202-ae79-af5e6f9980ab",
  "name": "My App Key",
  "key": "gw_c19d9d13619c40faac301eec833a5e76",
  "keyPreview": "gw_c1****5e76",
  "createdAt": "2026-06-12T08:37:04.564Z",
  "isActive": true
}
```

**Format key:** `gw_` diikuti 32 karakter hex. Simpan nilai `key` penuh — tidak bisa diambil lagi setelah ini.

---

### `DELETE /api/keys/:id` — Hapus API key

```bash
curl -X DELETE http://localhost:8080/api/keys/fa2a5b43-73d9-4202-ae79-af5e6f9980ab
```

Response:
```json
{ "success": true, "message": "API key deleted" }
```

---

### `PATCH /api/keys/:id` — Update nama / status key

```bash
curl -X PATCH http://localhost:8080/api/keys/fa2a5b43-... \
  -H "Content-Type: application/json" \
  -d '{ "name": "Nama Baru", "isActive": false }'
```

Response: objek key yang diupdate (format sama dengan GET list per-item).

---

### `GET /api/stats` — Statistik request gateway

```bash
curl http://localhost:8080/api/stats
```

Response:
```json
{
  "totalRequests": 16,
  "successRequests": 16,
  "failedRequests": 0,
  "successRate": 100,
  "requestsToday": 16,
  "requestsThisHour": 16,
  "averageResponseTime": 7994,
  "activeApiKeys": 1,
  "tokenPoolSize": 505,
  "tokenPoolHealthy": 505
}
```

---

### `GET /api/token-pool` — Status token pool

```bash
curl http://localhost:8080/api/token-pool
```

Response:
```json
{
  "size": 505,
  "entries": [
    { "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)...", "ageMs": 2560617, "hasToken": true },
    ...
  ]
}
```

Field `size` = jumlah token aktif. Field `entries` = array semua token (ua = user-agent, ageMs = umur token dalam ms, hasToken = token tersedia).

---

### `POST /api/token-pool/refresh` — Force refresh pool

```bash
curl -X POST http://localhost:8080/api/token-pool/refresh
```

Memaksa re-fetch semua token yang expired/pre-expired. Berguna saat pool kosong setelah restart panjang.

---

## Integrasi dengan OpenAI SDK

### Python

```python
from openai import OpenAI

client = OpenAI(
    api_key="gw_...",
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
    model="qwen3.5-flash",
    messages=[{"role": "user", "content": "Hitung 1 sampai 5"}]
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

### JavaScript / TypeScript

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "gw_...",
  baseURL: "http://localhost:8080/v1",
});

// Chat biasa
const response = await client.chat.completions.create({
  model: "qwen3-30b-a3b",
  messages: [{ role: "user", content: "Apa itu machine learning?" }],
});
console.log(response.choices[0].message.content);

// JSON mode
const jsonResp = await client.chat.completions.create({
  model: "qwen3-30b-a3b",
  response_format: { type: "json_object" },
  messages: [{ role: "user", content: "Beri data 3 kota Indonesia dalam JSON" }],
});
console.log(JSON.parse(jsonResp.choices[0].message.content!));
```

---

## Database Schema

PostgreSQL + Drizzle ORM. Schema di `lib/db/src/schema/`.

| Tabel | Kolom Utama | Keterangan |
|-------|-------------|-----------|
| `api_keys` | `id`, `name`, `key_hash`, `key_preview`, `is_active`, `request_count`, `last_used` | API keys dengan hash SHA256 |
| `gateway_stats` | `id`, `created_at`, `duration_ms`, `model`, `success` (boolean) | Log per-request |
| `chat_sessions` | `conversation_id`, `model`, `messages` (JSONB), `message_count` | Riwayat percakapan |

**Auto-migrasi:** Tabel dan kolom dibuat otomatis saat server startup via `artifacts/api-server/src/lib/migrate.ts`.

---

## Token Pool (`bx-umidtoken`)

Gateway membutuhkan `bx-umidtoken` (token anti-bot Alibaba) untuk setiap request ke Qwen.

| Property | Nilai |
|----------|-------|
| Pool size | **2000 slot** |
| Cache disk | `artifacts/api-server/token_cache.json` |
| Keepalive | Refresh otomatis setiap 50 menit |
| Rotation | Round-robin antar token; rotasi per-token saat upload rate limit |

```bash
# Cek status pool
curl http://localhost:8080/api/token-pool

# Force refresh
curl -X POST http://localhost:8080/api/token-pool/refresh
```

---

## Environment Variables

| Variabel | Wajib | Keterangan |
|----------|-------|-----------|
| `PORT` | Ya | Port server (8080 di Replit dev) |
| `DATABASE_URL` | Ya | PostgreSQL connection string |
| `QWEN_SESSION_TOKEN` | Tidak | Token sesi Qwen akun premium (opsional) |

---

## Robustness & Retry

Gateway secara otomatis menangani error transient dari Qwen — agent tidak perlu implementasi retry sendiri.

**Retry logic (3x dengan exponential backoff):**
- Error `timeout`, `exit 1`, crash Python sidecar → retry otomatis 1.5s / 3s / fail
- Error `WAF blocked` atau client `aborted` → langsung fail (tidak di-retry)
- Retry terjadi **transparan** — client tidak tahu sedang di-retry

**Python-level retry (per-request):**
- Risk-control Qwen (WAF session-level) → retry 3x dengan jeda 3s / 6s di dalam Python sidecar
- Session create gagal → retry 3x dengan jeda 1.5s / 3s sebelum return error

**Single-spawn optimization:**
- Setiap request hanya spawn **1 Python subprocess** (create + chat digabung dalam satu proses)
- Sebelumnya: 2 spawn terpisah (create → chat) yang menambah ~500–1500ms overhead per call

---

## Format Error

Semua error dari gateway menggunakan format OpenAI-compatible yang konsisten:

```json
{
  "error": {
    "message": "Deskripsi error yang jelas",
    "type": "invalid_request_error | server_error | gateway_error | upstream_error | service_unavailable",
    "code": "snake_case_error_code"
  }
}
```

**Tipe error yang umum:**

| `type` | `code` | HTTP | Keterangan |
|--------|--------|------|-----------|
| `invalid_request_error` | `invalid_api_key` | 401 | Key tidak valid atau tidak ada |
| `invalid_request_error` | `invalid_value` | 400 | Body request tidak valid |
| `gateway_error` | `token_pool_empty` | 503 | Pool `bx-umidtoken` habis |
| `upstream_error` | `qwen_risk_control` | 503 | Qwen server busy/rate limit |
| `gateway_error` | `create_failed` | 503 | Gagal buat sesi Qwen setelah retry |
| `service_unavailable` | `qwen_waf_blocked` | 503 | IP diblokir WAF Aliyun |
| `service_unavailable` | `OVERLOADED` | 503 | Concurrency queue penuh (>80 request) |
| `server_error` | `internal_error` | 500 | Error internal gateway |

---

## Tool Calling (Function Calling) untuk AI Agent

Gateway mendukung penuh OpenAI function calling — cocok untuk autonomous agent yang memanggil tools secara loop.

**Contoh request dengan tools:**

```python
from openai import OpenAI

client = OpenAI(api_key="sk-dzeck-...", base_url="http://localhost:8080/v1")

tools = [
    {
        "type": "function",
        "function": {
            "name": "get_price",
            "description": "Get current asset price",
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {"type": "string"},
                    "timeframe": {"type": "string"}
                },
                "required": ["symbol"]
            }
        }
    }
]

# Step 1: agent memanggil tool
response = client.chat.completions.create(
    model="qwen3.7-max",
    tools=tools,
    tool_choice="auto",
    messages=[{"role": "user", "content": "Berapa harga XAUUSD sekarang?"}]
)

choice = response.choices[0]
# finish_reason = "tool_calls" → agent mau panggil tool
if choice.finish_reason == "tool_calls":
    tool_call = choice.message.tool_calls[0]
    fn_name = tool_call.function.name       # "get_price"
    fn_args = tool_call.function.arguments  # '{"symbol":"XAUUSD"}'

    # Step 2: eksekusi tool dan feed hasilnya kembali
    messages = [
        {"role": "user", "content": "Berapa harga XAUUSD sekarang?"},
        choice.message,  # assistant message dengan tool_calls
        {
            "role": "tool",
            "tool_call_id": tool_call.id,
            "content": '{"price": 3342.50, "change": "+0.73%"}'
        }
    ]

    # Step 3: agent melanjutkan dengan hasil tool
    final = client.chat.completions.create(
        model="qwen3.7-max",
        tools=tools,
        messages=messages
    )
    print(final.choices[0].message.content)
```

**Fitur tool calling yang didukung:**
- `tool_choice: "auto"` — model memutuskan sendiri kapan pakai tool
- `tool_choice: "required"` — selalu panggil tool
- `tool_choice: {"type":"function","function":{"name":"..."}}` — paksa tool tertentu
- `parallel_tool_calls` — model bisa panggil beberapa tools sekaligus dalam satu response
- Multi-turn loop: feed tool result → panggil LLM lagi → tools lagi → dst.

**Performance test (10-step agent loop, XAUUSD analysis):**
- 5 steps hingga keputusan final (agent selesai lebih awal — normal)
- 10 tool calls total (beberapa paralel di step yang sama)
- 11,778 token total context
- 31.9 detik wall time, rata-rata **6.4 detik per LLM call**
- Tidak ada error atau retry yang terlihat dari luar

---

## Hasil Test Semua Fitur (Verified)

| Fitur | Status | Catatan |
|-------|--------|---------|
| `GET /v1/models` | ✅ | 13 model listed |
| Chat teks | ✅ | Token count akurat |
| Streaming SSE | ✅ | Word-by-word real-time, include_usage support |
| Vision | ✅ | URL gambar & data URI |
| Dokumen `.md` | ✅ | Inline base64 decode |
| Audio WAV | ✅ | Model: `qwen-audio-turbo` |
| Image generation | ✅ | URL `cdn.qwenlm.ai/output/...` |
| Tool calling | ✅ | Parallel tools, multi-turn loop |
| Agent loop (10-step) | ✅ | 5 steps, 10 tool calls, 31.9s, error 0 |
| Retry otomatis | ✅ | Transparan ke client |
| `GET /api/keys` | ✅ | `{keys:[...], total:N}` |
| `POST /api/keys` | ✅ | `{id, name, key, keyPreview, createdAt, isActive}` |
| `DELETE /api/keys` | ✅ | `{success:true}` |
| `GET /api/stats` | ✅ | 100% success rate |
| `GET /api/token-pool` | ✅ | 1988+ token aktif |
| `POST /api/token-pool/refresh` | ✅ | Force refresh |

---

## Troubleshooting

| Masalah | Penyebab | Solusi |
|---------|---------|--------|
| Vision: model bilang tidak ada gambar | URL gambar di-block saat download | Gunakan URL yang allow automated access, atau data URI `data:image/...;base64,...` |
| Dokumen: model tidak bisa baca file | MIME type bukan teks | Pastikan `mime_type` adalah `text/markdown`, `text/plain`, dll. Binary harus via OSS |
| Audio: "tidak bisa mendengar audio" | Model text-only dipakai | Ganti ke `qwen-audio-turbo` atau `qwen2.5-omni-7b` |
| 401 Unauthorized | API key salah/tidak ada | Pastikan format `Bearer gw_...` di header Authorization |
| 503 WAF blocked | curl_cffi pakai `impersonate=` | Hapus semua flag `impersonate` dari `qwen_cffi.py` |
| Pool 0 token | Server baru restart | Tunggu ~10 detik atau hit `POST /api/token-pool/refresh` |
| DB error: invalid input for boolean | Kolom `success` tipe lama (`text`) | Jalankan: `ALTER TABLE gateway_stats ALTER COLUMN success TYPE boolean USING (success::boolean)` |
