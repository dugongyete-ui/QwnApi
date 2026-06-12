# Dokumentasi Parameter Endpoint [`/v1/chat/completions` OpenAI API

Dokumen ini menyajikan daftar lengkap parameter yang didukung oleh endpoint `/v1/chat/completions` dari OpenAI API, berdasarkan dokumentasi resmi OpenAI [1] [2]. Pemahaman yang akurat tentang parameter ini sangat penting untuk mengoptimalkan interaksi dengan model chat dan mengontrol output yang dihasilkan.

## Parameter Utama

| Parameter | Tipe Data | Deskripsi |
| :-------- | :-------- | :-------- |
| `model` | String | ID model yang akan digunakan untuk pembuatan chat. Contoh: `gpt-4o`, `gpt-3.5-turbo`. |
| `messages` | Array of Objects | Daftar objek pesan yang membentuk percakapan. Setiap objek pesan memiliki `role` (system, user, assistant, tool) dan `content`. `content` dapat berupa teks atau array objek untuk input multimodal (teks dan gambar). |

## Parameter Kontrol Generasi

Parameter ini memengaruhi cara model menghasilkan respons, memungkinkan penyesuaian kreativitas, fokus, dan karakteristik output lainnya.

| Parameter | Tipe Data | Deskripsi |
| :-------- | :-------- | :-------- |
| `temperature` | Float (0-2) | Nilai sampling. Nilai yang lebih tinggi (misalnya 0.8) membuat output lebih acak, sedangkan nilai yang lebih rendah (misalnya 0.2) membuatnya lebih fokus dan deterministik. Disarankan untuk mengubah ini atau `top_p`, tetapi tidak keduanya. |
| `top_p` | Float (0-1) | Alternatif untuk sampling dengan `temperature`, disebut nucleus sampling. Model mempertimbangkan hasil token dengan massa probabilitas `top_p`. Jadi, 0.1 berarti hanya token yang membentuk 10% massa probabilitas teratas yang dipertimbangkan. Disarankan untuk mengubah ini atau `temperature`, tetapi tidak keduanya. |
| `n` | Integer | Berapa banyak pilihan penyelesaian chat yang akan dihasilkan untuk setiap pesan input. Biaya akan dikenakan berdasarkan jumlah token yang dihasilkan di semua pilihan. Pertahankan `n` sebagai 1 untuk meminimalkan biaya. |
| `max_tokens` | Integer | Jumlah token maksimum yang dapat dihasilkan dalam penyelesaian chat. Nilai ini dapat digunakan untuk mengontrol biaya untuk teks yang dihasilkan melalui API. |
| `max_completion_tokens` | Integer | Batas atas untuk jumlah token yang dapat dihasilkan untuk penyelesaian, termasuk token output yang terlihat dan token penalaran. Ini adalah pengganti `max_tokens` untuk model o-series. |
| `stop` | String / Array of Strings | Hingga 4 urutan di mana API akan berhenti menghasilkan token lebih lanjut. |
| `presence_penalty` | Float (-2.0 - 2.0) | Nilai positif akan memberikan penalti pada token baru berdasarkan apakah token tersebut muncul dalam teks sejauh ini, meningkatkan kemungkinan model untuk membahas topik baru. |
| `frequency_penalty` | Float (-2.0 - 2.0) | Nilai positif akan memberikan penalti pada token baru berdasarkan frekuensi kemunculannya dalam teks sejauh ini, mengurangi kemungkinan model untuk mengulang baris yang sama secara verbatim. |
| `logit_bias` | JSON Object | Memetakan token (berdasarkan ID token) ke nilai bias dari -100 hingga 100. Bias ditambahkan ke logit model sebelum sampling. Nilai antara -1 dan 1 akan mengurangi atau meningkatkan kemungkinan pemilihan; -100 atau 100 akan menghasilkan larangan atau pemilihan eksklusif token. |
| `seed` | Integer | (Beta) Jika ditentukan, sistem akan berusaha sebaik mungkin untuk melakukan sampling secara deterministik, sehingga permintaan berulang dengan `seed` dan parameter yang sama akan mengembalikan hasil yang sama. Determinisme tidak dijamin. |

## Parameter Output dan Streaming

Parameter ini mengontrol format respons dan apakah respons akan dialirkan.

| Parameter | Tipe Data | Deskripsi |
| :-------- | :-------- | :-------- |
| `stream` | Boolean | Jika `true`, data respons model akan dialirkan ke klien sebagai server-sent events. |
| `stream_options` | Object | Opsi untuk respons streaming. Hanya diatur ketika `stream: true`. |
| `logprobs` | Boolean | Jika `true`, mengembalikan probabilitas log dari setiap token output yang dikembalikan dalam `content` dari `message`. |
| `top_logprobs` | Integer (0-20) | Jumlah maksimum token yang paling mungkin untuk dikembalikan pada setiap posisi token, masing-masing dengan probabilitas log terkait. `logprobs` harus diatur ke `true` jika parameter ini digunakan. |
| `response_format` | Object | Objek yang menentukan format yang harus dihasilkan model. Misalnya, `{ "type": "json_object" }` untuk respons JSON terstruktur. |

## Parameter Lanjutan dan Spesifik Model

Beberapa parameter mungkin spesifik untuk model tertentu atau menawarkan fungsionalitas yang lebih canggih.

| Parameter | Tipe Data | Deskripsi |
| :-------- | :-------- | :-------- |
| `tools` | Array of Objects | Daftar alat yang dapat dipanggil oleh model. Setiap alat memiliki `type` (misalnya `function`) dan definisi `function` dengan `name`, `description`, dan `parameters` (skema JSON). |
| `tool_choice` | String / Object | Mengontrol bagaimana model memilih untuk memanggil fungsi. Dapat berupa `"none"` (model tidak memanggil fungsi), `"auto"` (model dapat memilih untuk memanggil fungsi atau tidak), atau objek spesifik untuk memaksa pemanggilan fungsi tertentu. |
| `parallel_tool_calls` | Boolean | Apakah akan mengaktifkan pemanggilan fungsi paralel selama penggunaan alat. |
| `user` | String | Pengidentifikasi stabil untuk pengguna akhir Anda. Digunakan untuk membantu OpenAI mendeteksi dan mencegah penyalahgunaan. Bidang ini digantikan oleh `safety_identifier` dan `prompt_cache_key` untuk tujuan yang berbeda. |
| `safety_identifier` | String | Pengidentifikasi stabil yang digunakan untuk membantu mendeteksi pengguna aplikasi Anda yang mungkin melanggar kebijakan penggunaan OpenAI. |
| `prompt_cache_key` | String | Pengidentifikasi stabil untuk pengguna akhir Anda. Digunakan untuk meningkatkan tingkat hit cache dengan mengelompokkan permintaan serupa. |
| `prompt_cache_retention` | String | Kebijakan retensi untuk cache prompt. Dapat berupa `in_memory` atau `24h`. |
| `metadata` | JSON Object | Set 16 pasangan kunci-nilai yang dapat dilampirkan ke objek. Berguna untuk menyimpan informasi tambahan tentang objek dalam format terstruktur. |
| `reasoning_effort` | String / Object | (Khusus model penalaran) Mengarahkan model seberapa banyak untuk berpikir saat melakukan tugas. Nilai yang didukung tergantung pada model dan dapat mencakup `none`, `low`, `medium`, `high`, atau objek yang lebih spesifik. Mengurangi upaya penalaran dapat menghasilkan respons yang lebih cepat dan lebih sedikit token yang digunakan untuk penalaran. |
| `modalities` | Array of Strings | Mendukung input teks dan gambar. Catatan: input gambar di atas 8MB akan diabaikan. Untuk model seperti `gpt-4o-audio-preview`, dapat digunakan untuk menghasilkan respons teks dan audio. |
| `prediction` | Object | Parameter untuk output audio. Diperlukan saat output audio diminta dengan `modalities: ["audio"]`. |
| `service_tier` | String | Tingkat layanan yang digunakan untuk permintaan. Dapat berupa `auto`, `default`, `flex`, atau `priority`. |
| `store_output` | Boolean | Apakah akan menyimpan output dari permintaan penyelesaian chat ini untuk digunakan dalam produk distilasi model atau evaluasi OpenAI. |
| `moderation` | Object | Konfigurasi untuk menjalankan moderasi pada input permintaan dan output yang dihasilkan. |
| `verbosity` | String | Membatasi verbositas respons model. Nilai yang lebih rendah akan menghasilkan respons yang lebih ringkas, sementara nilai yang lebih tinggi akan menghasilkan respons yang lebih verbose. Nilai yang didukung saat ini adalah `low`, `medium`, dan `high`. |
| `web_search_options` | Object | Alat ini mencari hasil yang relevan untuk digunakan dalam respons. |

## Referensi

[1] OpenAI API Reference. (n.d.). *Create chat completion*. Diakses dari [https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create/](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create/)
[2] OpenAI API Reference. (n.d.). *Reasoning models*. Diakses dari [https://developers.openai.com/api/docs/guides/reasoning](https://developers.openai.com/api/docs/guides/reasoning)
