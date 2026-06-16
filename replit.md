# Qwen Chat Gateway

Reverse proxy pribadi yang membuat AI Alibaba Qwen bisa diakses melalui API yang kompatibel dengan OpenAI. Kirim request seperti ke OpenAI API, gateway menangani autentikasi ke Qwen secara otomatis.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — jalankan API server (port 8080)
- `pnpm --filter @workspace/gateway-dashboard run dev` — jalankan dashboard admin (port 5173)
- `pnpm run typecheck` — typecheck semua package
- `pnpm run build` — build semua package
- `pnpm --filter @workspace/db run push` — push schema DB (dev only)

**Workflows Replit:**
- **API Server** — backend gateway, port 8080, otomatis rebuild + restart
- **Dashboard** — UI admin gateway-dashboard

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM (schema di `lib/db/src/schema/`)
- Python sidecar: `qwen_cffi.py` (curl_cffi, tanpa `impersonate=` agar bypass Aliyun WAF)
- Build: esbuild (bundle ESM ke `artifacts/api-server/dist/`)

## Where things live

```
artifacts/
  api-server/
    src/
      routes/
        v1.ts       ← SEMUA endpoint OpenAI-compatible (/v1/chat/completions, /v1/models, dll)
        keys.ts     ← Admin CRUD API keys
        stats.ts    ← Status token pool & statistik
        chat.ts     ← Internal chat sessions
      lib/
        qwenEngine.ts ← qwenPyCreateAndChat() + withRetry() — entry point ke sidecar
        umid-pool.ts  ← Pool 2000 bx-umidtoken, keepalive setiap 50 menit
        migrate.ts    ← Auto-migrasi DB saat startup
        logger.ts     ← Pino logger
    qwen_cffi.py    ← Python sidecar (create_and_chat command), dipanggil via spawn()
    token_cache.json← Cache pool token di disk
  gateway-dashboard/
    src/pages/      ← UI React admin (keys, stats, playground)
lib/
  db/src/schema/    ← Drizzle schema (apiKeys, gatewayStats, chatSessions)
```

## Architecture decisions

- **Token pool 2000 umidtoken**: Qwen membutuhkan `bx-umidtoken` (Alibaba bot-detection token) untuk setiap request. Gateway pre-generate 2000 token, simpan ke disk, dan refresh setiap 50 menit via keepalive interval sehingga pool tidak pernah expired saat ada traffic.
- **Single-spawn Python sidecar**: curl_cffi (Python) mem-bypass TLS fingerprint detection Aliyun lebih baik dari fetch/node-fetch. Setiap request hanya spawn **1 subprocess** via `child_process.spawn()` — command `create_and_chat` menggabungkan create sesi + streaming chat dalam satu proses. Sebelumnya 2 spawn terpisah yang menambah ~500–1500ms overhead.
- **Retry otomatis 3x di TypeScript**: `withRetry()` di `v1.ts` menangani error transient (timeout, crash sidecar) dengan backoff 1.5s/3s/fail. Error `WAF` dan `aborted` tidak di-retry. Transparan ke client.
- **Retry di Python sidecar**: Session create retry 3x (jeda 1.5s/3s). Risk-control Qwen retry 3x (jeda 3s/6s). Total fallback chain sebelum error dikembalikan ke TypeScript.
- **Format error konsisten**: Semua endpoint (`/v1/*`, `/api/*`) mengembalikan `{ error: { message, type, code } }` — OpenAI-compatible. Tidak ada silent fallback.
- **Inline text dokumen**: File teks (md, txt, csv, json) di-decode dari base64 dan di-inline langsung ke prompt sebagai `<document>` block, bukan mengandalkan Qwen OSS parse (yang async dan tidak di-poll). Binary files (PDF, DOCX) tetap via OSS.
- **Vision via OSS upload**: Gambar diunduh gateway lalu di-upload ke Qwen OSS via STS token sebelum dikirim ke model. URL gambar harus bisa diakses oleh server (hindari URL Wikipedia/hotlink-protected).
- **Audio butuh model omni**: Model text-only (qwen3-30b-a3b, dll.) tidak bisa proses audio meski file terupload. Gunakan `qwen-audio-turbo` atau `qwen2.5-omni-7b` untuk request audio.

## Product

Gateway ini menyediakan:
- **Chat & streaming** — OpenAI-compatible `/v1/chat/completions` dengan SSE streaming
- **Vision** — Analisis gambar dari URL atau data URI (gunakan model `qwen-vl-max`)
- **Dokumen** — Baca file teks/PDF dalam percakapan (`type: "file"` content part)
- **Audio** — Analisis/transkripsi audio WAV/MP3 (gunakan model `qwen-audio-turbo`)
- **Image generation** — Generate gambar via `/v1/images/generations`
- **Admin dashboard** — UI untuk kelola API keys, lihat statistik, playground chat

Lihat **GATEWAY.md** untuk dokumentasi API lengkap beserta contoh kode.

## User preferences

- Bahasa respon: Indonesia (Bahasa Indonesia) kecuali diminta berbeda.
- Setiap perbaikan harus ditest langsung dengan curl sebelum dinyatakan selesai.
- Jangan rewrite from scratch; selalu preserve kode dan struktur yang ada.

## Gotchas

- **curl_cffi TANPA `impersonate=`**: Jangan tambah `impersonate="chrome120"` atau flag impersonate apapun — ini justru diblokir Aliyun WAF. Versi tanpa impersonate yang bypass.
- **Port 8080 di Replit**: Server listen di `process.env.PORT` (8080 di Replit dev). Jangan hardcode 5000.
- **DB migration otomatis**: `runMigrations()` dipanggil saat `app.listen()` — tidak perlu manual migration untuk column baru selama didefinisikan di `migrate.ts`.
- **Wikipedia image URLs**: Mengembalikan HTTP 400 saat diunduh gateway. Gunakan URL gambar yang tidak memblokir automated download.
- **`success` column di DB**: Tipe `boolean` bukan `text`. Migration cast otomatis, tapi kalau ada error `invalid input syntax for type boolean` jalankan: `ALTER TABLE gateway_stats ALTER COLUMN success TYPE boolean USING (success::boolean)`.
- **Rebuild wajib setelah edit `v1.ts`**: Workflow API Server otomatis rebuild (`pnpm run build && pnpm run start`), tapi kalau manual: `pnpm --filter @workspace/api-server run build`.
- **Jangan tambah 2-spawn ke sidecar**: Command baru wajib pakai `create_and_chat` (1 spawn). Jangan kembalikan ke pola `qwenPyCreate` + `qwenPyBody` terpisah — menambah latency 500–1500ms dan melipatgandakan slot concurrency yang terpakai.
- **Retry tidak berlaku untuk WAF/aborted**: `withRetry()` skip retry kalau message error mengandung kata `"WAF"`, `"aborted"`, atau `"QWEN_SESSION_TOKEN"` — ini error permanen, bukan transient.
- **Python stdout protocol**: Baris pertama dari Python sidecar adalah `X-Chat-Id: <uuid>\n` — TypeScript buffer sampai `\n` pertama untuk ekstrak chat ID, sisanya adalah SSE stream. Jangan ubah urutan ini di `qwen_cffi.py`.

## Pointers

- Dokumentasi API lengkap: `GATEWAY.md`
- Schema DB: `lib/db/src/schema/`
- Token pool logic: `artifacts/api-server/src/lib/umid-pool.ts`
- Semua endpoint OpenAI-compatible: `artifacts/api-server/src/routes/v1.ts`
