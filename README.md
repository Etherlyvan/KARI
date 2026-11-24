# KARI

KARI adalah companion widget yang dapat dipasang pada website tanpa bergantung pada framework host. Maskot kecil, bubble chat, animasi glitch dan backend berada dalam project ini; website host hanya memuat custom element dan modul JavaScript.

**Release 0.1:** integrasi widget dan backend lokal tersedia, sedangkan inference serta Telegram **nonaktif secara default**. Tidak ada API key, akun bot atau koneksi produksi yang dibuat otomatis.

## Yang tersedia

- Widget TypeScript/CSS dengan Shadow DOM, bubble/input kecil, posisi kanan bawah, anchor alternatif, gerak acak terbatas, perintah pindah, minimize/hide, keyboard dan reduced motion.
- Tampilan pixel opt-in `appearance="pixel"`: renderer Canvas 48 x 72 berbasis kode dengan FSM Companion V2, kedipan, ekspresi, tidur/bangun dan pose yang dipilih sesuai konteks; tanpa PNG baru atau request AI untuk animasi. Tampilan gambar lama tetap default.
- FAQ publik dari artifact knowledge per website; sesi pengunjung terisolasi melalui token singkat dalam memori widget, tanpa cookie pihak ketiga.
- NestJS + Fastify, Zod, Pino, Prisma 7/PostgreSQL, pembatasan request, deduplikasi request dan reservasi spending durable sebelum inference.
- Satu model ekonomis melalui yogathedev AI Router, setelah konfigurasi dan verifikasi operator; tidak ada `auto`, advanced routing atau retry inference otomatis.
- Catatan dan reminder satu kali untuk pemilik Telegram yang terverifikasi; teman ngobrol pribadi memakai persona hangat/playful, dan inference hanya jika diaktifkan.

**Belum tersedia:** pengiriman WhatsApp, reminder berulang, login pemilik pada website, voice/lip-sync, rig skeletal lengkap, atau model 3D. Mode `image` memakai PNG transparan dengan transform/CSS glitch; mode `pixel` menggambar ekspresi serta pose langsung dalam grid, bukan atlas PNG atau rig facial penuh.

## Stack dan struktur

Node.js 24.12+ diperlukan; pengembangan diverifikasi dengan Node 24.13.1. Gunakan versi dependency yang terkunci dalam `package-lock.json`.

```text
apps/api/src/       Nest/Fastify, sesi publik, knowledge, inference, accounting,
                    autentikasi Telegram, catatan dan scheduler
apps/widget/src/    Web Component TypeScript dan CSS
assets/kari.png     Artwork karakter
prisma/             Schema dan migrasi PostgreSQL
data/              Artifact knowledge publik yang diizinkan
demo/              Dua halaman host dan playground pixel opt-in
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

Untuk tampilan pixel, buka **`http://localhost:3000/demo/pixel.html`** dengan `DEMO_ENABLED=true`. Portrait besar menjalankan FSM berbobot, bukan loop 16 frame yang terus sama; tombol Santai/Mikir/Ngobrol/Senang/Penasaran memberi preview singkat lalu perilaku kembali berjalan. Coba **Angkat**/**Glitch**, atau jeda/putar animasi. Portrait tidak berpindah lokasi; widget di kanan bawah memperagakan navigasi sebenarnya. Burst glitch hanya saat terjaga dan tidak mengganggu kondisi pause/reduced motion/hidden. **Tahan dan seret KARI di kanan bawah** untuk mengangkat serta menaruh karakter; klik biasa membuka bubble. Halaman ini opt-in; tidak mengganti portfolio atau dua demo gambar sebelumnya. Untuk screenshot pengembangan saja, `?behavior=SLEEP` dapat memilih pose awal; URL normal tidak memaksa urutan perilaku. Jika memakai port lokal lain, sesuaikan URL dan exact-origin pada `KARI_SITES_JSON`.

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
| `appearance` | `image` (default) atau `pixel`; pixel harus diaktifkan eksplisit |
| `avatar-src` | Opsional: asset HTTPS yang dipercaya untuk mode `image`; diabaikan saat mode `pixel` |
| `behavior-config` | Opsional: JSON konfigurasi lokal Companion V2; frekuensi, waktu tidur/gerak dan personality seperti di bawah |

Untuk mengaktifkan pixel pada website host, cukup tambahkan atribut pada elemen yang sama; loader, site ID dan API tidak berubah:

```html
<kari-widget
  api-base="https://kari.example.com/kari/api"
  site-id="my-website"
  position="bottom-right"
  appearance="pixel"
></kari-widget>
<script type="module" src="https://kari.example.com/kari/embed.js"></script>
```

Menghapus atribut `appearance` atau memakai `appearance="image"` mengembalikan gambar default. Grid pixel 48 x 72 diperbesar dengan tepi piksel tajam, mengikuti state request/UI dan pengendali motion lokal yang sama. Mode ini tidak memuat PNG avatar dan tidak memerlukan request inference tambahan; reduced motion, jeda animasi, hide dan penghentian saat tab tersembunyi tetap berlaku. Kemampuan chat dan izin pemilik tidak berubah karena pilihan tampilan.

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

**Memindahkan dengan tangan:** tahan karakter sekitar 320 ms atau seret sedikitnya 6 px dengan mouse/sentuhan untuk mengangkatnya. Klik biasa hanya membuka bubble dan tidak memindahkan maskot. Kursor berubah menjadi menggenggam dan KARI berpose terangkat; lepaskan untuk menaruhnya pada posisi baru yang dibatasi viewport. Posisi manual dipertahankan selama interaksi; sesudah idle `manualReturnMs`, KARI dapat kembali ke area pinggir yang aman jika tidak dipin dan percakapan tidak sedang dipakai. Gunakan **Tetap di sini** untuk pin eksplisit. Escape membatalkan drag; alternatif keyboard adalah fokus pada launcher lalu **Shift + tombol panah**. Drag/drop memakai pose fisik dan landing lembut, tidak memicu petir atau glitch sebagai efek perpindahan. Input, bubble dan kontrol lain tetap bisa dipakai normal; `touch-action` khusus drag hanya berlaku pada launcher karakter, bukan seluruh halaman.

| Perintah | Respons |
|---|---|
| `Kari, halo` | Sapaan lokal |
| `Kari, pindah ke kiri` | Memilih anchor kiri yang aman |
| `Ke kanan bawah` | Kembali ke anchor default |
| `Pindah tempat` / `minggir` | Memilih koordinat acak aman lain |
| `Tetap di sini` | Mengunci posisi |
| `Serius dulu` / `tenang` / `jangan banyak gerak` | Mengurangi gestur dan gerak |

Gerak acak berhenti saat mengetik, hover/fokus aktif atau jawaban diproses. Mobile/reduced motion membatasi gerak otomatis; kontrol lokal dapat mengubah preferensi yang didukung. Minimize/Escape menutup bubble; hide menyisakan kontrol buka kembali. Menyembunyikan widget tidak membatalkan reminder pada backend.

Pose mengikuti state percakapan dan interaksi nyata; tidak ada inference tambahan untuk emosi atau animasi. Artwork mode `image` berukuran 1254 x 1254, 459.335 byte transfer dan sekitar 6 MiB untuk satu buffer RGBA sebelum overhead browser; renderer pixel tidak memuat PNG itu. Ukuran bundle V2 perlu diukur dari output `npm run build:widget` untuk release yang dipakai, bukan diasumsikan sama dengan build pixel sebelumnya. Mode pixel menggambar mata, mulut serta anggota tubuh dari kode; mode gambar memakai transform/CSS. Keduanya bukan rig skeletal, voice animation atau model 3D.

## Companion V2: perilaku, gerak dan konfigurasi

FSM memilih perilaku dengan bobot, kondisi dan cooldown, bukan rotasi acak yang selalu berulang sama. State yang tersedia: `IDLE`, `BLINK`, `LOOK_AROUND`, `THINKING`, `STRETCH`, `YAWN`, `SLEEP`, `SLEEP_TALK`, `WAKE_UP`, `WALK`, `RUN`, `DANCE`, `PLAY`, `CURIOUS`, `HAPPY`, `BORED`, `TALK`, `LISTEN`, `DRAGGED`, dan `LANDED`. Tidak semua state dipilih pada setiap situasi: request, ketikan, drag serta kondisi aman memiliki prioritas; perilaku ekspresif jarang memiliki cooldown.

Default tidur dimulai setelah sekitar **3–5 menit tanpa interaksi**, melalui menguap lalu tidur di posisi bawah yang aman. Emote rebahan terjaga sudah dihapus. `SLEEP` meringkuk dengan kepala di atas lengan, mata tertutup dan Zzz. Saat `DRAGGED`, KARI tampak ditenteng pada badan/bahu: bahu sedikit terangkat, lengan rileks, lutut longgar dan kaki menjuntai dengan ayunan kecil. Kepala/rambut tetap utuh; bagian tubuh di bawah titik pegang tertinggal berlawanan arah drag lalu kembali tegak ketika berhenti. Titik sentuh dan posisi saat drag tetap dipertahankan. Melepas drag memberi pendaratan lembut tanpa glitch. Tidur berlangsung 30–90 detik; mengigau adalah ekspresi visual sesekali, bukan pesan pribadi atau panggilan AI. Sapaan/interaksi membangunkan KARI lewat state `WAKE_UP`, bukan langsung melompat ke ekspresi bicara. Gerak mata/kepala kecil memakai event pointer lokal yang dibatasi; tidak merekam lintasan pengguna atau mengirimkannya ke server.

Ekspresi santai berganti lebih perlahan: melihat sekitar dan penasaran bertahan 6–9 detik, senang 6–8 detik, bosan 8–11 detik, lalu kembali netral selama 8–12 detik sebelum memilih gestur berikutnya. Perpindahan blink mempertahankan ekspresi yang sedang berjalan dan tidak meresetnya ke netral. Respons terhadap ketikan, request, angkat dan bangun tetap langsung mengikuti interaksi. Tombol ekspresi pada demo menahan pratinjau selama 8 detik.

Struktur tanggung jawab berada pada sepuluh file di `apps/widget/src/companion/`:

| File | Tanggung jawab |
|---|---|
| `types.ts` | Tipe state, pose, environment dan konfigurasi |
| `CharacterController.ts` | Koordinasi lifecycle, satu clock rendering, interaksi dan gerak |
| `BehaviorSystem.ts` | FSM berbobot, personality, cooldown serta tidur/bangun |
| `AnimationController.ts` | Sample pose dari waktu dan batas frekuensi render per state |
| `SpriteRenderer.ts` | Menggambar pose karakter pada Canvas kecil |
| `MovementController.ts` | Gerak sepanjang rute, easing, arah hadap dan landing |
| `EmotionController.ts` | Pemetaan reaksi lokal yang dibatasi |
| `ConversationReactions.ts` | Reaksi dari status percakapan; tidak memberi izin aksi |
| `SafeZoneManager.ts` | Area pinggir aman, exclusion dan rute yang menghindari konten |
| `LightningEffect.ts` | Efek sementara untuk perpindahan otonom khusus |

Contoh mengubah ritme pada elemen widget yang sama:

```html
<kari-widget
  api-base="https://kari.example.com/kari/api"
  site-id="my-website"
  appearance="pixel"
  behavior-config='{"decisionMs":1000,"sleepAfterMs":240000,"sleepMinMs":30000,"sleepMaxMs":90000,"moveMinMs":6000,"moveMaxMs":12000,"manualReturnMs":12000,"rareCooldownMs":60000,"personality":{"energy":0.68,"curiosity":0.62,"mood":0.72}}'
></kari-widget>
```

Semua nilai waktu dalam milidetik. `sleepAfterMs` adalah pusat rentang idle sebelum tidur; default 240.000 memberi variasi 180.000–300.000. Default `moveMinMs`/`moveMaxMs` 6.000–12.000 memberi kesempatan blink setiap sekitar **6–12 detik di desktop**, atau **9–18 detik di mobile**. Mode pixel aktif bergerak otomatis di keduanya; **Tetap di sini**, reduced motion dan mode tenang tetap menghentikannya. Jeda adalah kesempatan gerak, bukan jaminan harus pindah ke tempat yang tidak aman. `manualReturnMs` default 12.000 mengevaluasi kembali posisi manual setelah idle; drop selalu mendapat jeda tenang terlebih dahulu. `rareCooldownMs` default 60.000 membatasi perilaku jarang. `decisionMs` dibatasi paling cepat satu detik. `personality.energy`, `curiosity` dan `mood` bernilai 0–1; ini parameter animasi lokal, bukan penilaian emosi manusia atau pengaturan model LLM. Konfigurasi tidak valid dibatasi/dikembalikan ke default dan tidak menambah hak akses backend.

Tujuan blink diambil dari koordinat acak baru di sepanjang pita pinggir yang aman, termasuk variasi jarak dari tepi. Jarak perpindahan diacak tiap kesempatan; delapan posisi terakhir dan sisi yang sering dikunjungi diberi prioritas lebih rendah, sehingga karakter tidak sekadar bolak-balik antar-anchor. Jalur horizontal tetap mendapat kesempatan untuk menampilkan petir. Titik fallback dan langkah kecil tersedia untuk mobile yang sempit. Perintah umum `pindah tempat`, `minggir` dan `pindah` memakai pemilihan koordinat yang sama; perintah kiri/kanan yang spesifik tetap memakai anchor yang diminta. Jika ruang aman belum tersedia, geometri dievaluasi ulang setelah sekitar dua detik. Bubble yang terbuka tetapi idle tidak mengunci karakter selamanya; draft yang belum selesai, ketikan/composition, drag dan request yang sedang diproses tetap menahan perpindahan. Bubble juga diperiksa agar tujuan tidak menutup kontrol penting. Respons error tidak mengunci gerakan dan animasi bicara mempunyai durasi terbatas.

Petir horizontal memakai geometri berseed per perpindahan: fork, busur ganda atau segmen putus, core cyan/hijau, echo magenta dan sisa percikan yang memudar. Geometri dihitung sekali, buffer canvas tetap berupa pita tipis, dan repaint dibatasi sekitar 30 fps. Tidur memakai delapan fase lambat: kaki/telapak tetap bertumpu, dada bernapas 1 px, kepala/rambut menyusul, core meredup dan Zzz naik lalu memudar. Waktu tidur tidak dihitung ulang akibat roaming; sesudah mengantuk, KARI berhenti roaming biasa dan tidur di tempat aman. Interaksi baru membatalkan persiapan tidur. Mode tenang/reduced motion memakai pose statis.

Navigasi otonom hanya memakai area pinggir, memeriksa seluruh kotak karakter dan menghindari center content, navigasi, kontrol, link serta teks penting. Tambahkan `data-kari-avoid` atau `data-kari-exclude` pada elemen/container yang tidak boleh tertutup:

```html
<aside data-kari-avoid>Kontrol yang harus selalu dapat diakses</aside>
```

KARI berpindah dengan **blink** pada `appearance="pixel"`, baik saat roaming maupun menerima perintah pindah: tubuh terpotong menjadi garis energi, hilang di tempat asal selama minimal 180 ms, lalu muncul di tujuan. Fase hilang selalu mendapat frame tersendiri meskipun browser sempat lambat. Seluruh efek berlangsung sekitar setengah detik tanpa pose jalan/lari. Perpindahan horizontal dengan lintasan lurus yang aman meninggalkan garis listrik cyan/magenta; vertikal/diagonal cukup blink tanpa garis listrik. Tujuan tetap harus aman. Jika tidak ada tujuan aman, KARI tetap diam. Drop memakai pose netral dengan satu settling kecil, lalu diam selama enam detik; tidak memicu joget, listrik atau glitch. `DANCE` tidak dipilih otomatis. Efek berhenti ketika drag, ketikan baru, hidden atau reduced motion; perintah pindah pada reduced motion langsung menempatkan karakter tanpa efek. Canvas garis listrik hanya berupa pita tipis, pointer-transparent, dan dibersihkan setelah efek selesai. Opsi lama `lightningChance` tetap diterima untuk kompatibilitas, tetapi arah dan keamanan perpindahan kini menentukan efeknya.

Di `/demo/pixel.html`, klik **Blink ↔** untuk memindahkan widget kecil di pojok antara kiri dan kanan. Portrait besar hanya memperagakan pose. Website host juga dapat meminta perpindahan lokal dengan API berikut; nilai balik `true` berarti tujuan aman dan perpindahan diterima:

```js
await customElements.whenDefined('kari-widget');
document.querySelector('kari-widget')?.moveTo('bottom-left');
```

Tujuan yang didukung: `bottom-left`, `bottom-right`, `middle-left`, `middle-right`. Mengubah atribut `position` setelah widget terpasang juga memakai blink. Mode gambar lama tetap tersedia melalui `appearance="image"`; pasang `appearance="pixel"` untuk companion V2 dan efek blink.

Pixel Canvas tetap kecil dan integer; sample pose bergantung waktu, bukan jumlah pemanggilan frame. Render idle/tidur lebih jarang daripada gerak aktif; loop/timer dihentikan ketika hidden, pause atau reduced motion sesuai konteks. Tidak menambah PNG, engine 3D, library rendering, layanan server, atau panggilan model untuk membuat KARI bergerak. Cache frame dan efek sementara dibatasi; ukur CPU/RAM dan ukuran bundle pada perangkat sasaran sebelum menaikkan kompleksitas.

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
