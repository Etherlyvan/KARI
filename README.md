# KARI

KARI adalah companion widget yang dapat dipasang pada website tanpa bergantung pada framework host. Maskot kecil, bubble chat, animasi glitch dan backend berada dalam project ini; website host hanya memuat custom element dan modul JavaScript.

**Release 0.1:** integrasi widget dan backend lokal tersedia, sedangkan inference serta Telegram **nonaktif secara default**. Tidak ada API key, akun bot atau koneksi produksi yang dibuat otomatis.

## Yang tersedia

- Widget TypeScript/CSS dengan Shadow DOM, bubble/input kecil, posisi kanan bawah, anchor alternatif, gerak acak terbatas, perintah pindah, minimize/hide, keyboard dan reduced motion.
- FAQ publik dari artifact knowledge per website; sesi pengunjung terisolasi melalui token singkat dalam memori widget, tanpa cookie pihak ketiga.
- NestJS + Fastify, Zod, Pino, Prisma 7/PostgreSQL, pembatasan request, deduplikasi request dan reservasi spending durable sebelum inference.
- Satu model ekonomis melalui yogathedev AI Router, setelah konfigurasi dan verifikasi operator; tidak ada `auto`, advanced routing atau retry inference otomatis.
- Catatan dan reminder satu kali untuk pemilik Telegram yang terverifikasi; teman ngobrol pribadi memakai persona hangat/playful, dan inference hanya jika diaktifkan.

**Belum tersedia:** pengiriman WhatsApp, reminder berulang, login pemilik pada website, voice/lip-sync, atau atlas dengan ekspresi mata/anggota tubuh independen. Artwork saat ini adalah PNG transparan dengan transform/CSS glitch; jangan menyebutnya animasi facial lengkap atau model 3D.

## Stack dan struktur

Node.js 24.12+ diperlukan; pengembangan diverifikasi dengan Node 24.13.1. Gunakan versi dependency yang terkunci dalam `package-lock.json`.

```text
apps/api/src/       Nest/Fastify, sesi publik, knowledge, inference, accounting,
                    autentikasi Telegram, catatan dan scheduler
apps/widget/src/    Web Component TypeScript dan CSS
assets/kari.png     Artwork karakter
prisma/             Schema dan migrasi PostgreSQL
data/              Artifact knowledge publik yang diizinkan
demo/              Dua halaman host dengan gaya berbeda
tests/             Test offline dan integrasi PostgreSQL opsional
```

Widget dan API dibuild bersama menjadi **satu image/runtime Node**. Tidak membutuhkan dev server Vite, renderer animasi di VPS, Redis, queue server atau proses worker terpisah. PostgreSQL merupakan service terpisah untuk data durable. Open-source software tidak menghapus biaya VPS, inference provider atau layanan pengiriman pesan.

## Quickstart lokal tanpa inference atau database

Salin `.env.example` menjadi `.env` lokal yang diabaikan Git. Pertahankan `AI_ENABLED=false`, `AI_CAPABILITIES_VERIFIED=false`, dan `TELEGRAM_ENABLED=false`; biarkan `DATABASE_URL` tidak disetel. `DEMO_ENABLED=true` mengaktifkan halaman demo.

```powershell
Copy-Item .env.example .env
npm ci
$env:DATABASE_URL = 'postgresql://generate:generate@127.0.0.1:5432/generate'
npm run db:generate
Remove-Item Env:DATABASE_URL
npm run check
npm test
npm run build
npm start
```

URI dummy di atas hanya memenuhi konfigurasi generator Prisma; generate tidak menghubungi database tersebut. Jangan menggunakannya untuk migrasi atau produksi. Pada shell POSIX, jalankan satu perintah scoped `DATABASE_URL=postgresql://generate:generate@127.0.0.1:5432/generate npm run db:generate` sebagai pengganti tiga baris PowerShell pengaturan/penghapusan environment.

Buka `http://localhost:3000/demo/` dan `http://localhost:3000/demo/second-site.html`. Keduanya memakai widget yang sama; halaman kedua masih memakai `site-id="portfolio"` untuk mendemonstrasikan perbedaan styling, bukan konteks bisnis situs kedua. Daftarkan site ID/knowledge terpisah untuk konteks lain.

Setelah build pertama, `npm run dev` me-restart backend saat source berubah; perubahan widget tetap membutuhkan `npm run build:widget`. Environment `.env` dimuat oleh script `dev`/`start`. Test tidak memakai secret atau inference nyata. Tanpa PostgreSQL, fitur publik lokal tetap dapat digunakan; catatan, reminder dan inference berbayar tidak tersedia.

## Memasang di website mana pun

Prasyaratnya browser mendukung ES modules/custom elements, website mengizinkan script widget, dan backend KARI dapat diakses melalui HTTPS. Tidak perlu memasang NestJS/Prisma di website host.

### 1. Daftarkan website pada backend

Setel `KARI_SITES_JSON` pada environment **server KARI**, lalu restart service:

```json
[
  {
    "id": "my-website",
    "name": "Website saya",
    "origins": ["https://website.example.com"],
    "knowledgePath": "data/my-website.json"
  }
]
```

Origin harus persis sama, termasuk skema dan port; jangan menambahkan slash/path atau wildcard. URL dan nama domain `.example.com` di panduan ini adalah placeholder. `knowledgePath` opsional dan menunjuk file lokal yang dipilih operator, bukan URL atau path dari pengunjung. Situs tanpa knowledge tetap mendapat respons lokal yang mengakui keterbatasan informasi.

### 2. Tambahkan embed sekali sebelum `</body>`

```html
<kari-widget
  api-base="https://kari.example.com/kari/api"
  site-id="my-website"
  position="bottom-right"
></kari-widget>
<script type="module" src="https://kari.example.com/kari/embed.js"></script>
```

| Atribut | Nilai |
|---|---|
| `site-id` | ID publik yang didaftarkan server; default `portfolio` |
| `api-base` | Prefix API KARI, URL HTTPS eksternal atau path relatif satu origin |
| `position` | `bottom-right` (default), `bottom-left`, `middle-right`, `middle-left` |
| `avatar-src` | Opsional: asset karakter HTTPS yang dipercaya; default artwork KARI |

`site-id` bukan API key, autentikasi pemilik atau izin mengambil konteks situs lain. Backend memeriksa hubungan site ID, origin dan token pengunjung pada setiap permintaan. Atribut `owner` atau pengakuan "aku Jovan" tidak membuka mode pribadi.

Untuk deployment satu origin melalui reverse proxy, gunakan `/kari/api` dan `/kari/embed.js` sebagai URL relatif. Pertahankan prefix `/kari/` sampai backend, arahkan hanya route yang diperlukan, dan jangan menjadikan kegagalan KARI sebagai kegagalan seluruh website. API menggunakan `no-store`; jangan melakukan retry POST otomatis atau meng-cache respons chat.

### Astro, React dan CMS

- **Astro:** gunakan elemen yang sama dan `<script is:inline type="module" src="https://kari.example.com/kari/embed.js"></script>`. `is:inline` hanya directive Astro agar source KARI tidak dibundle sebagai import lokal; HTML biasa tidak memerlukannya.
- **React/router client:** muat modul satu kali pada root document/layout dan render custom element pada client. Jika versi TypeScript/React memerlukan deklarasi tipe custom element, tambahkan di host. Jangan memuat ulang script pada setiap navigasi.
- **WordPress/CMS:** tempatkan custom element melalui template/block yang mengizinkannya dan enqueue modul melalui mekanisme theme/plugin sesuai versi CMS. Beberapa editor menghapus script/custom tag; pemasangan harus dilakukan melalui fasilitas yang memang diizinkan.

Browser menggunakan token pengunjung singkat yang diterbitkan backend dan disimpan hanya pada memori instance widget. Tidak ada browser API key atau keharusan cookie pihak ketiga. Kode embed, sprite dan modul tetap dapat dilihat pengunjung; jangan menaruh secret pada atribut atau asset.

CORS asset publik menggunakan akses module lintas domain, sedangkan endpoint sesi/chat memeriksa exact-origin allowlist. CORS bukan autentikasi atau perlindungan penuh dari scripted clients; rate limit dan spending admission tetap diperlukan. Shadow DOM memisahkan styling, bukan sandbox keamanan.

CSP website perlu mengizinkan origin modul/chunks, gambar dan API. Widget 0.1 memakai elemen `<style>` di Shadow DOM; kebijakan `style-src` ketat perlu hash style yang ditinjau atau kebijakan inline yang terkontrol. Mekanisme nonce belum disediakan. Jangan menganggap widget dapat melewati semua pembatasan CSP/CMS tanpa penyesuaian.

## Memakai widget

Klik/fokuskan KARI untuk membuka bubble. Balasan tetap dekat karakter tanpa window chat besar. Perintah lokal berikut tidak memakai inference:

| Perintah | Respons |
|---|---|
| `Kari, halo` | Sapaan lokal |
| `Kari, pindah ke kiri` | Memilih anchor kiri yang aman |
| `Ke kanan bawah` | Kembali ke anchor default |
| `Pindah tempat` / `minggir` | Memilih anchor aman lain |
| `Tetap di sini` | Mengunci posisi |
| `Serius dulu` / `tenang` / `jangan banyak gerak` | Mengurangi gestur dan gerak |

Gerak acak berhenti saat mengetik, hover/fokus aktif atau jawaban diproses. Mobile/reduced motion membatasi gerak otomatis; kontrol lokal dapat mengubah preferensi yang didukung. Minimize/Escape menutup bubble; hide menyisakan kontrol buka kembali. Menyembunyikan widget tidak membatalkan reminder pada backend.

Pose idle/think/talk/error mengikuti status request nyata; tanpa inference tambahan untuk emosi atau animasi. Artwork awal berukuran 1.254 ? 1.254, 459.335 byte transfer dan sekitar 6 MiB untuk satu buffer RGBA sebelum overhead browser. Bundle widget terukur sekitar 25,4 KiB mentah / 8,1 KiB gzip pada build awal. Angka ini bukan jaminan peak RAM perangkat atau server. Layer/transform saat ini tidak menggantikan atlas ekspresi wajah yang belum dibuat.

## Konteks publik per website

`data/portfolio.json` berisi snapshot fakta publik yang diekspor portfolio, dengan `schemaVersion`, `siteId`, `sourceOrigin`, `contentVersion` dan `chunks`. Format contoh:

```json
{
  "schemaVersion": 1,
  "siteId": "my-website",
  "sourceOrigin": "https://website.example.com",
  "contentVersion": "<SHA-256 hex 64 karakter dari publikasi konten>",
  "chunks": [
    { "id": "contact", "href": "/#contact", "text": "Kontak publik yang sudah diverifikasi." }
  ]
}
```

Ganti placeholder hash dengan SHA-256 hex yang benar saat mempublikasikan artifact. `sourceOrigin` harus ada dalam origin situs terdaftar; href berupa path lokal. KARI tidak crawl website atau mem-fetch URL pengguna. Jangan menyertakan halaman personal, kredensial, source penuh atau catatan pemilik. Update artifact dan restart service untuk memuat konteks baru; gagal membaca/validasi file berarti konteks situs tersebut tidak tersedia, bukan izin mengambil data lain.

## PostgreSQL dan deployment Docker

Simpan `.env` dan backup di luar Git. Compose memerlukan **dua password berbeda**: `POSTGRES_PASSWORD` untuk admin migrasi `kari_admin` dan `KARI_DB_PASSWORD` untuk runtime `kari_app`. Masing-masing harus 24–128 karakter dari `[A-Za-z0-9_-]`; init script memvalidasinya. Nilainya dipakai mentah dalam connection URI, sehingga gunakan set URL-safe tersebut, bukan karakter seperti `@`, `:`, `/` atau `%`. Tidak ada password produksi bawaan. Jangan menaruh credential pada shell arguments, URL embed atau source browser.

Service KARI hanya menerima connection string `kari_app`; tidak menerima password admin. Role runtime tidak superuser, tidak dapat membuat database/role/schema/tabel, dan hanya mendapat `SELECT`, `INSERT`, `UPDATE`, `DELETE` pada lima tabel aplikasi. Tabel `_prisma_migrations` tidak diberikan kepada runtime. Container migrasi menerima hanya `DATABASE_URL` admin, tanpa API key atau bot token; sesudah migrasi, `scripts/grant-runtime.mjs` menerapkan grants aplikasi secara eksplisit. Untuk migrasi lokal, sediakan admin URL lewat environment aman pada proses migrasi saja, lalu jalankan script grants; jangan menjalankan migrasi menggunakan URL runtime atau menyimpan admin URL sebagai environment aplikasi permanen.

Deployment gabungan mengharapkan checkout sibling `../portfolio` yang sudah memiliki integrasi KARI:

```text
jovan/
  portfolio/     # Astro/Nginx yang dapat berjalan mandiri
  kari/          # project ini, pemilik Compose gabungan
```

Setel `POSTGRES_PASSWORD`, `KARI_DB_PASSWORD`, `SITE_URL`, origin pada `KARI_SITES_JSON` dan `PORTFOLIO_PORT` bila diperlukan dalam `.env` yang diabaikan Git. Dengan inference/Telegram tetap off:

```sh
docker compose build
docker compose --profile tools build migrate
docker compose up -d postgres
docker compose --profile tools run --rm migrate
docker compose up -d kari portfolio
docker compose ps
```

Migrasi dan grants dijalankan eksplisit satu kali per release; tidak otomatis pada setiap request atau startup. Script `deploy/init-runtime-role.sh` dijalankan image PostgreSQL hanya saat volume kosong pertama kali diinisialisasi, dengan SQL password yang di-quote oleh psql dan tanpa password dalam argumen CLI. `.gitattributes` mempertahankan line ending LF script untuk clone Windows/Linux. Pada volume yang sudah ada, perubahan environment tidak otomatis menciptakan role atau merotasi password. Rencanakan backup serta perubahan role oleh admin sebelum mengubah konfigurasi; jangan menghapus volume untuk menyelesaikan masalah login. Rotasi password runtime harus memperbarui role PostgreSQL dan secret service secara terkoordinasi.

Compose membatasi gateway 384 MiB dan PostgreSQL 512 MiB sebagai alokasi awal **belum jaminan cukup untuk semua beban**. Hanya Nginx mempublikasikan port website; database tidak diekspos ke host. Uji resource, backup/restore dan proxy pada VPS sesungguhnya. Image produksi sebaiknya dibuild CI lalu dipin dengan digest, bukan terus membangun pada VPS kecil.

Named volume `kari-data` menyimpan PostgreSQL. Jangan memakai `docker compose down -v` untuk update. Backup harian konsisten dan terenkripsi, uji restore, dan rekonsiliasi spending sejak backup sebelum membuka kembali aksi berbayar. Jangan menjalankan Compose standalone portfolio dan Compose gabungan pada port yang sama. Compose lokal ini bukan setup HA atau pengganti TLS edge produksi.

Untuk website selain portfolio, image KARI yang sama dapat disajikan melalui reverse proxy HTTPS milikmu; tidak wajib menjalankan service `portfolio` contoh. Domain asal harus terdaftar dan deployment harus menyediakan akses API/modul yang sesuai. Tidak perlu mempublikasikan PostgreSQL atau menambah container frontend keempat.

## Mengaktifkan inference secara sengaja

Default `AI_ENABLED=false` menjadikan FAQ lokal berjalan tanpa kredit API. Untuk inference, PostgreSQL harus tersedia dan sudah dimigrasikan, lalu operator perlu memverifikasi ID/model yang benar-benar operational, output cap/billable reasoning, harga, larangan expensive substitution, serta praktik retention/privacy provider sebelum mengirim data.

Konfigurasi server yang diperlukan adalah `AI_ENABLED=true`, `AI_CAPABILITIES_VERIFIED=true`, `AI_API_KEY`, dan `DATABASE_URL`. Flag verifikasi adalah pernyataan operator bahwa pemeriksaan telah dilakukan, **bukan health check otomatis**. Endpoint tetap `https://ai.yogathedev.com/v1` dan model hanya `deepseek-v4-flash`; mengganti ke `auto` atau model mahal ditolak.

Setiap inference mendapat reservasi durable sebelum request. Batas global awal 1 unit USD katalog/hari dan 20/bulan, ditambah batas model 0,60/hari dan 12/bulan; hari/bulan mengikuti Asia/Jakarta. Harga dasar perhitungan adalah snapshot katalog yang pernah ditinjau (input 0,09/output 0,18 per juta token), bukan jaminan harga atau nilai cash credit terkini. Recheck harga sebelum mengaktifkan fitur; edit/configure kebijakan yang diuji jika tarif berubah. Actual usage yang tepercaya tetap dicatat bila melebihi reservasi; pelanggaran cap/model/format response membekukan admission berbayar secara durable, termasuk sesudah restart. Pengaktifan kembali memerlukan pemeriksaan operator atas tagihan dan flag financial database, bukan sekadar restart service.

Chat publik dibatasi 2.000 input/300 output; owner chat 1.000/160. Maksimum empat inference aktif bersama dan satu private chat aktif; riwayat singkat, tanpa classifier/tools publik atau retry otomatis. Pemakaian yang tidak diketahui mempertahankan worst-case reservation. Database/accounting gagal, budget habis atau kontrak model berubah berarti paid request ditolak; tidak pindah provider/model diam-diam. Local FAQ tetap tersedia. Cancelling/timeout tidak dianggap menghapus biaya yang mungkin sudah terjadi.

## Telegram pribadi dan reminder

Fitur ini off hingga `TELEGRAM_ENABLED=true`, PostgreSQL termigrasi, `TELEGRAM_OWNER_ID` numerik, `TELEGRAM_BOT_TOKEN` dan `TELEGRAM_WEBHOOK_SECRET` dikonfigurasi aman. Daftarkan webhook HTTPS `/kari/api/telegram/webhook` melalui API resmi Telegram dengan secret yang sama; ikuti [dokumentasi Bot API resmi](https://core.telegram.org/bots/api#setwebhook). Lakukan provisioning dari lingkungan server yang aman; jangan menaruh bot token dalam command history, URL publik, tangkapan layar atau log.

Handler memeriksa secret webhook, ID sender dan chat pribadi yang persis cocok dengan owner; username/nama tampilan tidak memberi hak. Saat enabled, pengiriman pesan/reply sungguhan dapat terjadi, sehingga jangan mengaktifkannya hanya untuk menguji UI.

| Perintah pribadi | Fungsi |
|---|---|
| `/note isi catatan` | Menyimpan catatan setelah commit database |
| `/notes` | Daftar 20 catatan terbaru milik owner |
| `/remind 2026-12-01T09:00+07:00 review CV` | Reminder satu kali dengan zona waktu eksplisit |
| `/reminders` | Daftar reminder dan status |
| `/cancel <UUID>` | Membatalkan reminder yang masih pending |

Waktu harus di masa depan, maksimal 366 hari. Tanggal contoh perlu diganti sesuai kebutuhan. Scheduler mengklaim occurrence dengan lease/database; timeout/outcome tak pasti tidak di-retry buta. Status Telegram `accepted` berarti API menerima pesan, bukan bukti dibaca/delivered. Setelah mulai dikirim, pembatalan tidak dijanjikan berhasil; cek status. Reminder yang terlambat lebih dari toleransi 15 menit ditandai missed, bukan dibanjiri setelah downtime.

Pesan biasa dari owner diteruskan ke companion chat setelah pemeriksaan identitas. Sapaan/help lokal tetap bekerja dengan AI off; free-form reply menyatakan AI belum aktif. AI on memakai persona hangat dan cukup flirty, tanpa posesif/ingatan rekaan, tools, atau pengambilan semua catatan otomatis. Isi chat tidak otomatis menjadi catatan durable. Tidak ada web owner login, WhatsApp atau recurrence dalam release ini.

## Keamanan, observabilitas dan verifikasi

- Public token hanya berlaku untuk site/origin yang menerbitkannya, kedaluwarsa dan bukan owner token. Server tidak mempercayai role/model/system prompt dari HTML atau JSON pengunjung.
- `KARI_TRUSTED_PROXIES` default kosong. Bila ada proxy, set hanya IP/CIDR proxy yang benar; jangan `*`/trust-all. Tanpa konfigurasi, pengunjung di balik proxy berbagi kuota IP karena server tidak mempercayai forwarded headers.
- Pino tidak merekam isi chat, provider credential, raw header atau IP; event operasional memakai kode/status. Rotasi Docker logs dibatasi. Tetap tinjau log proxy/provider; redaksi aplikasi tidak mengendalikan retention pihak ketiga.
- `/kari/api/health` adalah liveness tanpa inference; `/kari/api/ready` memeriksa database bila dikonfigurasi. Status `local-only` bukan bukti PostgreSQL siap atau provider operational. Set `DEMO_ENABLED=false` di produksi.

```sh
npm run check
npm test
npm run build
```

Test inference/Telegram memakai fake fetch, tidak mengirim request berbayar atau pesan sungguhan. Test PostgreSQL opsional memakai `KARI_TEST_DATABASE_URL` yang menunjuk database khusus bernama **`kari_test`**; migrasikan database itu dahulu dan jangan memakai database aplikasi/produksi. Tanpa variabel tersebut suite integrasi PostgreSQL dilewati; unit test bukan bukti koneksi database produksi sehat.

| Gejala | Periksa |
|---|---|
| Widget tidak muncul | URL modul/MIME/CORS/CSP, registrasi custom element, asset dan flag host |
| Sesi/chat 403 | Site ID dan exact origin termasuk skema/port |
| API 401 | Token kedaluwarsa, site/origin berbeda; token hanya di memori instance |
| AI unavailable | Flag verifikasi/key, PostgreSQL/migrasi, budget, timeout atau model mismatch; jangan membuka fallback mahal |
| KARI tidak bergerak | Reduced motion/quiet/pin, input/hover aktif, viewport atau asset gagal |
| Reminder tidak terkirim | Telegram enabled, owner/secret, koneksi database, waktu/status lease, outcome provider |
| Proxy 502 | Nama service/network/port serta resolusi ulang setelah recreate |

Menonaktifkan embed di host hanya menyembunyikan UI, tidak menghentikan scheduler atau membatalkan reminder. Pembatalan/penonaktifan kanal dilakukan melalui operasi yang diizinkan dan prosedur backend. Backup dan migrasi memerlukan kontrol terpisah; rollback image bukan rollback data otomatis.
