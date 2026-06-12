---
name: Qwen document inline feature
description: How text file documents are inlined into the prompt via the /v1/chat/completions file content part
---

## Format request yang benar

```json
{
  "type": "file",
  "file": {
    "data": "<base64_content_raw>",
    "mime_type": "text/plain",
    "name": "filename.txt"
  }
}
```

**Penting:** field-nya adalah `data` (raw base64, BUKAN data URI), `mime_type` (eksplisit, terpisah), dan `name`. Bukan `file_data`, bukan `filename`.

## Cara kerja di server

Fungsi `messagesToTextPrompt()` di `v1.ts` memeriksa tiga kondisi sebelum inline:
1. `f.data` ada (raw base64)
2. `f.mime_type` ada
3. `isTextMimeType(f.mime_type)` → true

Jika semua terpenuhi, konten di-decode dan di-inject ke prompt sebagai:
```
<document name="filename.txt">
...isi file...
</document>
```

## MIME types yang di-inline (teks)

`text/plain`, `text/markdown`, `text/csv`, `text/html`, `text/xml`, `application/json`, `application/xml`, plus semua yang diawali `text/`.

## File binary (PDF, DOCX)

Tidak di-inline — diupload ke Qwen OSS dan diparse server-side. Bergantung pada Qwen parse completion yang async dan tidak selalu reliable.

**Why:** Inline teks lebih reliable daripada OSS parse karena konten langsung masuk ke prompt; tidak ada ketergantungan pada Qwen async indexing.

**How to apply:** Selalu gunakan format `data`/`mime_type`/`name` untuk teks. Jangan kirim `file_data` (format Responses API) — field itu tidak dikenali normaliser dan dokumen akan diabaikan.
