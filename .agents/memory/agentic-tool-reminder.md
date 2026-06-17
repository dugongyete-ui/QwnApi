---
name: Agentic tool calling fixes
description: Dua lapis pencegahan "lazy tool calling" di gateway untuk agentic long-running sessions — sliding window context + tool reminder re-injection.
---

# Agentic Tool Calling Fixes

## Root Cause

Untuk AI agent otonom yang menjalankan banyak step (5–10+), setiap step menghasilkan banyak message turns: execution prompt + narasi `message_notify_user` sebelum/sesudah tool + tool call/result pairs. Setelah beberapa step, context yang dikirim ke Qwen menjadi sangat panjang (50–100+ messages). Akibatnya:
- Tool definitions di system block "terkubur" jauh di awal context
- Model tidak lagi memperhatikan instruksi tool calling
- Model menulis teks biasa atau langsung nulis JSON `{"success":true}` palsu tanpa benar-benar memanggil tools ("ghost success")

## Fix 1 — Sliding Window (gateway, `v1.ts`)

**Rule:** Sebelum `messagesToTextPrompt()`, filter `augmentedMessages`:
- System messages → **selalu dipertahankan penuh**
- Non-system messages → **ambil hanya 24 terakhir** (dikontrol `SLIDING_WINDOW_SIZE`)

```typescript
const SLIDING_WINDOW_SIZE = 24;
const windowedMessages = (() => {
  const systemMsgs  = augmentedMessages.filter(m => m.role === "system");
  const nonSysMsgs  = augmentedMessages.filter(m => m.role !== "system");
  if (nonSysMsgs.length <= SLIDING_WINDOW_SIZE) return augmentedMessages;
  const trimmed = nonSysMsgs.slice(nonSysMsgs.length - SLIDING_WINDOW_SIZE);
  return [...systemMsgs, ...trimmed];
})();
const _basePrompt = messagesToTextPrompt(windowedMessages, ...);
```

**Why:** Membuang message lama yang tidak relevan agar model fokus pada step saat ini dan tool definitions tetap terlihat jelas di awal context.

**How to apply:** Hanya aktif saat `nonSysMsgs.length > SLIDING_WINDOW_SIZE`. Log: `context-window: trimmed old messages`. Untuk agent dengan context lebih pendek, tidak ada efek sama sekali.

## Fix 2 — Tool Reminder Re-injection (gateway, `v1.ts`)

**Rule:** Saat `hasTools=true`, tambahkan tool reminder di AKHIR prompt setelah `messagesToTextPrompt()`:

```typescript
const qwenMessageContent = hasTools
  ? _basePrompt +
    "\n\n---\n" +
    "TOOL REMINDER: You are in the middle of an ongoing task. " +
    "If you still need data or have not completed all required steps, " +
    "call a tool now using the JSON format: " +
    '{"tool_calls":[{"name":"TOOL_NAME","arguments":{...}}]}. ' +
    "Do NOT write a final analysis or conclusion until you have gathered all necessary data."
  : _basePrompt;
```

**Why:** Token yang paling dekat dengan posisi generasi mendapat perhatian terbesar dari model. Menempatkan pengingat tool di akhir prompt memastikan model "ingat" harus call tools meski tool definitions di system block sudah jauh tertinggal.

**How to apply:** Hanya aktif saat `hasTools=true && tool_choice !== "none"`. Untuk request chat biasa tanpa tools, tidak ada penambahan apapun.

## Kedua Fix Bekerja Bersamaan

- Sliding window mengurangi noise dari step-step lama
- Tool reminder memastikan model fokus ke tool calling di titik generasi
- Keduanya transparan — client/agent tidak perlu mengubah apapun

## Threshold Sliding Window

`SLIDING_WINDOW_SIZE = 24` dipilih karena:
- Analisis Gold/Crypto 5–6 step × 4–5 tool call = ~25–30 non-system messages
- Window 24 membuang step paling awal tapi mempertahankan sebagian besar context relevan
- Jika masih terjadi lazy tool calling, turunkan ke 16–20
- Jika agent kehilangan context penting dari step awal, naikkan ke 30–36
