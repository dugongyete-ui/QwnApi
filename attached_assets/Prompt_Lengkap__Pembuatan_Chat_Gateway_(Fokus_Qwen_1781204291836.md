# Prompt Lengkap: Pembuatan Chat Gateway (Fokus Qwen Guest Mode)

## Deskripsi Proyek
Bangun sebuah aplikasi **Chat Gateway API** dan **Web Dashboard** yang memungkinkan pengguna berinteraksi dengan model AI Qwen secara gratis melalui "Guest Mode" (tanpa login akun Qwen). Aplikasi ini harus menyertakan mekanisme bypass WAF Aliyun dan tidak memerlukan sistem login pengguna (public access).

## Arsitektur Teknis

### 1. Backend (Node.js/Express & Python)
*   **Python Sidecar (WAF Bypass):** Buat skrip Python menggunakan library `curl_cffi` untuk melakukan request ke `https://chat.qwen.ai/api/v2`. Ini diperlukan karena Node.js fetch sering diblokir oleh TLS fingerprinting Aliyun.
    *   Fungsi `create_chat`: Membuat session ID baru.
    *   Fungsi `chat_stream`: Mengirim pesan dan menerima stream SSE (Server-Sent Events).
*   **Token Pool (bx-umidtoken):** Implementasikan sistem rotasi token `bx-umidtoken`. Ambil token secara berkala dari `https://sg-wum.alibaba.com/w/wu.json` menggunakan berbagai User-Agent untuk menghindari rate limit.
*   **API Endpoints:**
    *   `POST /api/chat`: Menerima prompt, memanggil skrip Python, dan mengembalikan jawaban AI.
    *   `GET /api/stats`: Mengembalikan statistik jumlah request dan sukses rate.
    *   `GET /api/history`: Mengembalikan riwayat chat terakhir (simpan di memori atau DB ringan seperti SQLite/Lowdb).

### 2. Frontend (React + Tailwind CSS)
*   **Tanpa Login:** Hapus semua modul autentikasi. Dashboard langsung dapat diakses.
*   **Playground Page:** Antarmuka chat yang bersih. Pengguna bisa memilih model (seperti `qwen3.7-plus`, `qwen-max`) dan langsung mengirim pesan.
*   **Stats & History Page:** Tampilkan grafik sederhana (menggunakan Recharts atau Chart.js) untuk memantau penggunaan gateway secara real-time.
*   **UI/UX:** Gunakan tema gelap (dark mode), desain modern dengan komponen Shadcn UI, dan responsif untuk mobile.

## Detail Implementasi Penting

### Skrip Python (`qwen_engine.py`)
```python
import sys, json, time, base64
from curl_cffi import requests

def get_headers(midtoken):
    return {
        "Content-Type": "application/json",
        "Origin": "https://chat.qwen.ai",
        "Referer": "https://chat.qwen.ai/",
        "X-Requested-With": "XMLHttpRequest",
        "bx-umidtoken": midtoken,
        "bx-v": "2.5.31"
    }

# Implementasikan logika create_chat dan chat_completions di sini
```

### Logika Bypass SSE
Pastikan parser SSE di Node.js dapat menangani format data dari Qwen yang memisahkan antara `thinking` (pemikiran model) dan `answer` (jawaban akhir).

## Output yang Diharapkan
1.  Struktur folder proyek yang rapi.
2.  File `package.json` dengan dependensi yang diperlukan.
3.  Skrip Python untuk engine bypass.
4.  Server Express untuk API Gateway.
5.  Frontend React yang fungsional dan estetis.

---
**Instruksi Tambahan:** "Fokuskan pada stabilitas rotasi bx-umidtoken agar gateway tidak mudah terkena risk control (FAIL_SYS_USER_VALIDATE)."
