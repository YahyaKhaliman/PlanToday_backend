# PlanToday - REST API Backend Server

Backend PlanToday adalah layanan REST API server yang dibangun menggunakan **Express.js (Node.js)**. Server ini berfungsi sebagai jembatan data untuk aplikasi mobile PlanToday dengan mengintegrasikan logika bisnis ke tiga database MySQL yang berbeda.

---

## 🛠️ Tech Stack & Dependensi Utama

- **Core Framework**: Express.js (v5.2.1)
- **Runtime**: Node.js (versi >= 20)
- **Database Driver**: `mysql2/promise` (menggunakan Connection Pool)
- **Keamanan**:
  - `jsonwebtoken` (JWT) untuk manajemen sesi & otorisasi token.
  - `bcryptjs` (untuk enkripsi data bila diperlukan).
- **Manajemen File**:
  - `multer` untuk mengunggah gambar bukti fisik kunjungan, kurir, dan permintaan harga.
  - `sharp` untuk kompresi dan manipulasi gambar sebelum disimpan.
- **Development Tool**: `nodemon` (auto-reload server saat ada perubahan kode).

---

## 🗄️ Arsitektur Multi-Database

Server ini terhubung ke tiga database MySQL terpisah untuk membagi fungsionalitas sistem:

1. **Main Database (`marketing`)** - Config: [config/dbMain.js](file:///d:/Coding/PlanToday-backend/config/dbMain.js)
   - Digunakan untuk data pengguna/karyawan (`tkaryawan`), logs login (`log_plantoday`), data calon customer, kunjungan sales (visit plan/record), serta data master kurir.
2. **ACH Database (`database_kpi`)** - Config: [config/dbAch.js](file:///d:/Coding/PlanToday-backend/config/dbAch.js)
   - Digunakan untuk mengelola data visual pencapaian sales, target omset bulanan/tahunan, serta data realisasi performa sales.
3. **Penawaran Database (`database_penawaran`)** - Config: [config/dbPenawaran.js](file:///d:/Coding/PlanToday-backend/config/dbPenawaran.js)
   - Digunakan untuk mengelola pembuatan penawaran harga (quotation), status progress approval penawaran, daftar SPK, serta riwayat pelacakan penawaran cetak.

---

## 📂 Struktur Folder Proyek

```
PlanToday-backend/
├── config/              # Konfigurasi koneksi pool ke database MySQL (Main, ACH, Penawaran)
├── controllers/         # Logika utama API & eksekusi query SQL per modul bisnis
├── middleware/          # Middleware Express (Auth JWT, Logger, Upload File Multer)
├── routes/              # Definisi endpoint API yang dipetakan ke controller masing-masing
├── uploads/             # Direktori lokal penampung file upload sementara
├── utils/               # Fungsi utilitas (pencocokan nama & resolusi identitas sales)
├── docs/                # Dokumen checklist deployment VPS
├── .env                 # File konfigurasi variabel lingkungan (diabaikan oleh git)
├── package.json         # Dependensi proyek & script menjalankan server
└── server.js            # Entry point utama aplikasi Express
```

---

## ⚙️ Persyaratan Sistem & Instalasi Lokal

### 1. Prasyarat Sistem

- **Node.js**: Versi `>= 20` (disarankan LTS).
- **MySQL Client**: Server MySQL yang aktif (bisa berupa MySQL lokal untuk development atau koneksi server VPS).

### 2. Instalasi Dependensi

Jalankan perintah berikut di root folder backend:

```bash
npm install
```

_Atau menggunakan perintah npm ci untuk instalasi bersih berbasis package-lock.json:_

```bash
npm ci
```

---

## 🔑 Konfigurasi Variabel Lingkungan (.env)

Buat file bernama `.env` di root folder backend (duplikat dari `.env` yang ada) dan konfigurasikan variabel berikut:

````env
# 1. Konfigurasi Database Utama (marketing)
DB_HOST_MAIN=localhost
DB_USER_MAIN=your_db_user
DB_PASSWORD_MAIN='your_db_password'
DB_NAME_MAIN=marketing
DB_PORT_MAIN=3306

# 2. Konfigurasi Database database_kpi & Achievement
DB_HOST_ACH=localhost
DB_USER_ACH=your_db_user
DB_PASSWORD_ACH='your_db_password'
DB_NAME_ACH=database_kpi
DB_PORT_ACH=3306

# 3. Konfigurasi Database Penawaran (database_penawaran)
DB_HOST_PENAWARAN=localhost
DB_USER_PENAWARAN=your_db_user
DB_PASSWORD_PENAWARAN='your_db_password'
DB_NAME_PENAWARAN=database_penawaran
DB_PORT_PENAWARAN=3306

# 4. Port Server & Rahasia JWT
PORT=3001
JWT_SECRET=your_super_secret_jwt_key

---

## 💻 Cara Menjalankan Server di Lokal

Setelah dependensi terpasang dan `.env` sudah dikonfigurasi, jalankan perintah berikut:

### **Mode Development (Auto-Reload)**

Menjalankan server menggunakan `nodemon`. Server akan restart secara otomatis setiap kali ada perubahan file kode.

```bash
npm run dev
````

### **Mode Production (Standard)**

Menjalankan server menggunakan runtime Node.js bawaan secara langsung.

```bash
npm run start
```

### **Menjalankan di VPS menggunakan PM2**

Untuk memastikan backend tetap menyala di latar belakang (background process) pada server Linux VPS, gunakan **PM2 Manager**:

```bash
# Menjalankan aplikasi
pm2 start server.js --name plantoday-api

# Melihat log real-time
pm2 logs plantoday-api

# Melihat status aplikasi
pm2 status
```

---

## 🔒 Catatan Arsitektur Keamanan & Autentikasi

1. **Metode Autentikasi**: Login didasarkan pada pencocokan data username dan password di tabel `tkaryawan` (pada database `marketing`).
2. **Keamanan Password**: Saat ini, pencocokan password di database dilakukan secara **plain-text** langsung melalui kueri SQL.
3. **Session Token**: Setelah login sukses, backend akan membuat JWT token yang berisi payload ID Karyawan dengan masa aktif selama **7 hari**. Token ini dikirim kembali ke aplikasi mobile dan harus disertakan pada HTTP Header `Authorization` sebagai `Bearer <token>` untuk mengakses endpoint yang dilindungi.
4. **Middleware Otorisasi**: File [middleware/auth.js](file:///d:/Coding/PlanToday-backend/middleware/auth.js) bertindak sebagai penjaga gerbang. Middleware ini memverifikasi JWT token, lalu mengidentifikasi pengguna terkait di database utama sebelum melanjutkan request ke API Controller.

---

## 📦 Alur Deployment Otomatis (CI/CD)

Backend ini menggunakan alur deployment otomatis (Auto Deploy) via GitHub Actions ke VPS yang terkonfigurasi di berkas `.github/workflows/backend-deploy-vps.yml`.

### Cara Kerja Workflow:

1. **Trigger**: Developer melakukan push commit ke branch `main` pada repositori GitHub.
2. **Autentikasi SSH**: Runner GitHub Actions terhubung ke VPS melalui SSH menggunakan host, user, dan SSH Key privat yang disimpan di GitHub Secrets.
3. **Pembaruan Kode**: Runner masuk ke direktori deployment VPS `/var/www/PlanToday_backend` dan mengeksekusi git reset:
   ```bash
   git fetch origin
   git reset --hard origin/main
   ```
4. **Penyelarasan Dependensi**: Menjalankan perintah `npm ci` untuk menginstal ulang dependensi secara aman dan cepat.
5. **Restart Layanan**: Menjalankan perintah `pm2 restart plantoday-api` agar perubahan kode baru langsung dimuat oleh server Express.
