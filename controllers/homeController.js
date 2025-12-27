const db = require('../config/database');


function safe(v, fallback = '-') {
    if (v === null || v === undefined) return fallback;
    const s = String(v).trim();
    return s.length ? s : fallback;
}
function formatTanggalID(date) {
    return new Date(date).toLocaleDateString("id-ID", {
        day: "2-digit",
        month: "long",
        year: "numeric",
    });
}
function formatStatus(status) {
    if (status === "Y") return "Done";
    if (status === "N") return "Belum";
    return "-";
}


// Post Calon Customer
const calonCustomer = async (req, res) => {
    const { nama, alamat, cabang, telp, pic } = req.body;

    if (!nama) {
        return res.status(400).json({
        success: false,
        message: 'Nama customer wajib diisi',
        });
    }

    const conn = await db.getConnection();

    try {
        await conn.beginTransaction();

        // ambil cc_id terakhir
        const [[{ lastId }]] = await conn.query(
        'SELECT IFNULL(MAX(cc_id), 0) AS lastId FROM tcaloncustomer'
        );

        let nextId = lastId + 1;
        let ccKode = '';

        // memastikan cc_kode tidak bentrok
        while (true) {
        ccKode = `CC-${String(nextId).padStart(4, '0')}`;

        const [cek] = await conn.query(
            'SELECT 1 FROM tcaloncustomer WHERE cc_kode = ?',
            [ccKode]
        );

        if (cek.length === 0) break;
        nextId++;
        }

        // Insert data
        await conn.query(
        `INSERT INTO tcaloncustomer
        (cc_id, cc_kode, cc_nama, cc_alamat, cc_kota, cc_telp, cc_cp)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [nextId, ccKode, nama, alamat, cabang, telp, pic]
        );

        await conn.commit();

        res.json({
        success: true,
        message: 'Calon customer berhasil disimpan',
        data: {
            cc_id: nextId,
            cc_kode: ccKode,
        },
        });

    } catch (err) {
        await conn.rollback();
        console.error(err);
        res.status(500).json({
        success: false,
        message: 'Gagal menyimpan calon customer',
        });
    } finally {
        conn.release();
    }
};

// Get cabang
const getCabang = async (req, res) => {
    const { jabatan, cabang, nama } = req.query;

    try {
        const [cabang] = await db.query(
            `SELECT cabang AS nama FROM tcabang ORDER BY cbg_kode`
        );

        return res.json({
            success: true,
            data: {
                user: nama,
                jabatan,
                cabang: cabang.map(c => c.nama),
            },
        });
    } catch (err) {
        console.error('INIT VISIT PLAN ERROR:', err);
        res.status(500).json({ success: false, message: 'Gagal mengambil data' });
    }
}

// Get Pencarian Customer
const cariCustomer = async (req, res) => {
    try {
        const search = String(req.query.search ?? "").trim();

        if (!search) {
            return res.status(400).json({
                success: false,
                message: "Parameter search wajib diisi"
            });
        }

        // Gunakan backticks (`) untuk string SQL multi-line
        const [rows] = await db.query(
            `SELECT cc_kode, cc_nama, cc_alamat
                FROM tcaloncustomer
                WHERE cc_nama LIKE CONCAT('%', ?, '%')
                ORDER BY cc_nama`,
            [search]
        );

        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

// Post Visit Plan
const createVisitPlan = async (req, res) => {
    const { cus_kode, note, tanggal_plan, user } = req.body;

    if (!cus_kode) {
        return res.status(400).json({
            success: false,
            message: 'Customer masih belum diisi',
        });
    }

    try {
        const [result] = await db.query(
            `INSERT INTO tkunjungan (cus_kode, user, note, tanggal_plan) VALUES (?, ?, ?, ?)`,
            [cus_kode, user, note || '', tanggal_plan]
        );

        return res.json({
            success: true,
            message: 'Simpan Berhasil',
            data: { id: result.insertId },
        });
    } catch (err) {
        console.error('CREATE VISIT PLAN ERROR:', err);
        res.status(500).json({ success: false, message: err.message });
    }
}

// Get visit plan by ID
const visitPlanById = async (req, res) => {
    const { user, tanggal, cus_kode } = req.query;

    if (!user || !tanggal || !cus_kode) {
        return res.status(400).json({
        success: false,
        message: 'user, tanggal, cus_kode wajib',
        });
    }

    try {
        const [rows] = await db.query(
        `
        SELECT
            k.id,
            DATE(k.tanggal_plan) AS tanggal_plan,
            k.cus_kode,
            k.note,
            k.catatan,
            c.cc_nama,
            c.cc_alamat,
            c.cc_kota
        FROM tkunjungan k
        LEFT JOIN tcaloncustomer c ON c.cc_kode = k.cus_kode
        WHERE k.user = ?
            AND DATE(k.tanggal_plan) = ?
            AND k.cus_kode = ?
        ORDER BY k.id DESC
        LIMIT 1
        `,
        [user, tanggal, cus_kode]
        );

        return res.json({
        success: true,
        data: rows?.[0] || null,
        });
    } catch (err) {
        console.error('GET VISIT PLAN DETAIL ERROR:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// Post Visit
const createVisit = async (req, res) => {
    const { cus_kode, note, catatan, tanggal, user, latitude, longitude } = req.body;

    if (!cus_kode) {
        return res.status(400).json({
        success: false,
        message: 'Customer masih belum diisi',
        });
    }

    if (!tanggal) {
        return res.status(400).json({
        success: false,
        message: 'Tanggal masih belum diisi',
        });
    }

    if (!user) {
        return res.status(400).json({
        success: false,
        message: 'User belum ada (login dulu)',
        });
    }

    try {
        const [result] = await db.query(
        `INSERT INTO tkunjungan 
            (cus_kode, user, latitude, longitude, note, catatan, realisasi, tanggal, tanggal_plan)
        VALUES 
            (?, ?, ?, ?, ?, ?, 'Y', ?, ?)`,
        [
            cus_kode,
            user,
            latitude || null,
            longitude || null,
            note || '',
            catatan || '',
            tanggal,   
            tanggal, 
        ]
        );

        return res.json({
        success: true,
        message: 'Simpan Berhasil',
        data: { id: result.insertId },
        });
    } catch (err) {
        console.error('CREATE VISIT ERROR:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// Update Visit
const updateVisit = async (req, res) => {
    const { id } = req.params;
    const { note, catatan, tanggal, latitude, longitude } = req.body;

    if (!id) {
        return res.status(400).json({
        success: false,
        message: 'ID kunjungan tidak valid',
        });
    }

    try {
        await db.query(
        `UPDATE tkunjungan
        SET latitude = ?, longitude = ?, note = ?, catatan = ?, realisasi = 'Y', tanggal = ?
        WHERE id = ?`,
        [
            latitude || null,
            longitude || null,
            note || '',
            catatan || '',
            tanggal || null,
            id,
        ]
        );

        return res.json({
        success: true,
        message: 'Update Berhasil',
        data: { id: Number(id) },
        });
    } catch (err) {
        console.error('UPDATE VISIT ERROR:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// Upload Photo Visit
const uploadVisitPhoto = async (req, res) => {
    const { id } = req.params;

    if (!id) return res.status(400).json({ success: false, message: 'ID visit tidak valid' });
    if (!req.file) return res.status(400).json({ success: false, message: 'File foto tidak ditemukan (req.file kosong)' });

    try {
        const relativePath = `/uploads/visits/${req.file.filename}`;

        await db.query(`UPDATE tkunjungan SET foto = ? WHERE id = ?`, [relativePath, id]);

        return res.json({
        success: true,
        message: 'Foto berhasil disimpan ke server dan database',
        data: { id: Number(id), filename: req.file.filename },
        });
    } catch (err) {
        console.error('UPLOAD PHOTO ERROR:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// Get Rekap Visit
const getRekapVisit = async (req, res) => {
    const { user, tanggal } = req.query;

    if (!user || !tanggal) {
        return res.status(400).json({
        success: false,
        message: 'User dan Tanggal wajib diisi',
        });
    }

    try {
        const query = `
        SELECT
            a.id,
            DATE_FORMAT(a.tanggal_plan, '%d-%m-%Y') AS tanggal_plan,
            a.cus_kode,
            b.cc_nama,
            b.cc_alamat,
            a.latitude,
            a.longitude,
            a.note,
            a.catatan,
            'DONE' AS status
            FROM tkunjungan a
            LEFT JOIN tcaloncustomer b ON b.cc_kode = a.cus_kode
            WHERE a.user = ?
            AND DATE(a.tanggal_plan) = ?
            AND a.realisasi = 'Y'
            ORDER BY a.id DESC
        `;

        const [rows] = await db.query(query, [user, tanggal]);

        return res.json({ success: true, data: rows });
    } catch (err) {
        console.error('GET REKAP VISIT ERROR:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// Rekap visit WA
const rekapVisitWA = async (req, res) => {
    const { user, tanggal, cabang } = req.query;

    if (!user || !tanggal) {
        return res.status(400).json({
        success: false,
        message: 'Parameter user dan tanggal wajib diisi',
        });
    }

    try {
        let sql = `
        SELECT
            ku.id,
            ca.cc_nama,
            ku.cus_kode,
            ku.tanggal AS tanggal_visit,
            ku.tanggal_plan,
            ku.user,
            ku.keperluan,
            ku.note,
            ku.catatan,
            ku.realisasi,
            ka.kar_cabang AS user_cabang
        FROM tkunjungan ku
        INNER JOIN tkaryawan ka
            ON ka.kar_nama = ku.user
        INNER JOIN tcaloncustomer ca
            ON ca.cc_kode = ku.cus_kode
        WHERE ku.user = ?
            AND DATE(ku.tanggal) = ?
        `;

        const params = [user, tanggal];

        if (cabang) {
        sql += ` AND ka.kar_cabang = ?`;
        params.push(cabang);
        }

        sql += ` ORDER BY ku.id ASC`;

        const [rows] = await db.query(sql, params);

        if (!rows || rows.length === 0) {
        return res.json({ success: true, wa_text: '' });
        }

        const cabangFinal = cabang || rows[0]?.user_cabang;

        let text = `*REKAP VISIT*\n`;
        text += `SALES: ${safe(user)}\n`;
        if (cabangFinal) text += `CABANG: ${safe(cabangFinal)}\n`;
        text += `TANGGAL: ${formatTanggalID(String(tanggal))}\n`;
        text += `TOTAL: ${rows.length}\n`;
        text += `_____________________\n\n`;

        rows.forEach((it, idx) => {
        text += `*${idx + 1}. Customer:* ${safe(it.cc_nama)}\n`;
        text += `*Kode:* ${safe(it.cus_kode)}\n`;
        text += `*Tanggal Plan:* ${safe(formatTanggalID(it.tanggal_plan))}\n`;
        text += `*Tanggal Visit:* ${safe(formatTanggalID(it.tanggal_visit))}\n`;

        text += `*Keperluan:* ${safe(it.catatan)}\n`;

        text += `*Catatan:* ${safe(it.note)}\n`;
        text += `*Status:* ${safe(formatStatus(it.realisasi))}\n`;
        text += `_____________________\n`;
        });

        return res.json({ success: true, wa_text: text });
    } catch (err) {
        console.error('REKAP VISIT WA ERROR:', err);
        return res.status(500).json({
        success: false,
        message: err?.message || 'Gagal membuat rekap WA',
        });
    }
};

// Update rekap visit
const updateRekapVisit = async (req, res) => {
    const { id } = req.params;
    const { note } = req.body;

    if (!id) {
        return res.status(400).json({ success: false, message: 'ID tidak valid' });
    }

    try {
        await db.query(
            'UPDATE tkunjungan SET note = ? WHERE id = ?',
            [note, id]
        );

        res.json({
            success: true,
            message: 'Catatan keperluan berhasil diperbarui'
        });
    } catch (err) {
        console.error('UPDATE NOTE ERROR:', err);
        res.status(500).json({ success: false, message: err.message });
    }
}

// Get Rekap visit plan
const getRekapVisitPlan = async (req, res) => {
    const { user, tanggal } = req.query; 

    if (!user || !tanggal) {
        return res.status(400).json({
        success: false,
        message: 'User dan Tanggal wajib diisi',
        });
    }

    try {
        const query = `
        SELECT
            a.id,
            DATE_FORMAT(a.tanggal_plan, '%d-%m-%Y') AS tanggal_plan,
            a.cus_kode,
            b.cc_nama,
            b.cc_alamat,
            a.note,
            a.catatan,

            CASE
                WHEN EXISTS (
                SELECT 1
                FROM tkunjungan x
                WHERE x.cus_kode = a.cus_kode
                    AND x.user = a.user
                    AND x.realisasi = 'Y'
                )
                THEN 'Done'
                ELSE 'Belum'
            END AS label_status

            FROM tkunjungan a
            LEFT JOIN tcaloncustomer b
            ON b.cc_kode = a.cus_kode

            WHERE a.user = ?
            AND DATE(a.tanggal_plan) = ?
            AND (a.realisasi = 'N' OR a.realisasi IS NULL)

            ORDER BY a.id DESC;
        `;

        const [rows] = await db.query(query, [user, tanggal]);

        return res.json({ success: true, data: rows });
    } catch (err) {
        console.error('GET REKAP VISIT PLAN ERROR:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// Rekap visit plan WA
const rekapVisitPlanWA = async (req, res) => {
    const { user, tanggal } = req.query;

    if (!user || !tanggal) {
        return res.status(400).json({ success: false, message: 'user dan tanggal wajib' });
    }

    try {
        const sql = `
        SELECT
            k.id,
            DATE_FORMAT(k.tanggal_plan, '%d-%m-%Y') AS tanggal_plan,
            k.cus_kode,
            c.cc_nama,
            c.cc_alamat,
            c.cc_kota,
            k.note,
            k.catatan,
            k.realisasi
        FROM tkunjungan k
        JOIN (
            SELECT
            cus_kode,
            COALESCE(
                MAX(CASE WHEN realisasi = 'Y' THEN id END),
                MAX(id)
            ) AS pick_id
            FROM tkunjungan
            WHERE user = ?
            AND DATE(tanggal_plan) = ?
            GROUP BY cus_kode
        ) p ON p.pick_id = k.id
        INNER JOIN tcaloncustomer c ON c.cc_kode = k.cus_kode
        WHERE k.user = ?
        ORDER BY k.id ASC
        `;

        const [rows] = await db.query(sql, [user, tanggal, user]);

        if (!rows || rows.length === 0) {
        return res.json({ success: true, wa_text: '', message: 'Data kosong' });
        }

        let text = `*REKAP VISIT PLAN*\n`;
        text += `SALES: ${safe(user)}\n`;
        text += `TANGGAL: ${formatTanggalID(String(tanggal))}\n`;
        text += `TOTAL: ${rows.length}\n`;
        text += `_____________________\n\n`;

        rows.forEach((it, idx) => {
        text += `*${idx + 1}. Customer:* ${safe(it.cc_nama)}\n`;
        text += `*Kode:* ${safe(it.cus_kode)}\n`;
        text += `*Kota:* ${safe(it.cc_kota)}\n`;
        text += `*Alamat:* ${safe(it.cc_alamat)}\n`;
        text += `*Keperluan:* ${safe(it.note)}\n`;
        if (it.catatan && String(it.catatan).trim().length) {
            text += `*Catatan:* ${safe(it.catatan)}\n`;
        }
        text += `*Status:* ${it.realisasi === 'Y' ? 'Done' : 'Belum'}\n`;
        text += `_____________________\n`;
        });

        return res.json({ success: true, wa_text: text });
    } catch (e) {
        console.error('REKAP VISIT PLAN WA ERROR:', e);
        return res.status(500).json({ success: false, message: e.sqlMessage || e.message });
    }
};

// Get Rekap calon customer
const getRekapCalonCustomer = async (req, res) => {
    const { cabang, cc_nama } = req.query;

    // Validasi wajib
    if (!cabang) {
        return res.status(400).json({
        success: false,
        message: 'Parameter cabang wajib diisi',
        });
    }

    try {
        // Base query
        let query = `
        SELECT
            cc_id   AS id,
            cc_kode,
            cc_nama,
            cc_alamat,
            cc_cp,
            cc_telp,
            cc_kota
        FROM tcaloncustomer
        WHERE cc_kota = ?
        `;

        const params = [cabang];

        // Optional search by nama
        if (cc_nama && cc_nama.trim() !== '') {
        query += ` AND cc_nama LIKE ?`;
        params.push(`%${cc_nama.trim()}%`);
        }

        query += ` ORDER BY cc_id DESC`;

        const [rows] = await db.query(query, params);

        return res.json({
        success: true,
        data: rows,
        });
    } catch (err) {
        console.error('GET REKAP CALON CUSTOMER ERROR:', err);
        return res.status(500).json({
        success: false,
        message: 'Gagal mengambil rekap calon customer',
        });
    }
};

// Rekap Calon Customer WA
const rekapCalonCustomerWA = async (req, res) => {
    const { cabang, cc_nama } = req.query;

    if (!cabang) {
        return res.status(400).json({
        success: false,
        message: 'Parameter cabang wajib diisi',
        });
    }

    if (!cc_nama || !cc_nama.trim()) {
        return res.status(400).json({
        success: false,
        message: 'Parameter cc_nama wajib diisi untuk kirim WA (agar tidak semua data terkirim)',
        });
    }

    try {
        const query = `
        SELECT
            cc_id AS id,
            cc_kode,
            cc_nama,
            cc_alamat,
            cc_cp,
            cc_telp,
            cc_kota
        FROM tcaloncustomer
        WHERE cc_kota = ?
            AND cc_nama LIKE ?
        ORDER BY cc_id DESC
        LIMIT 100
        `;

        const params = [cabang, `%${cc_nama.trim()}%`];
        const [rows] = await db.query(query, params);

        if (!rows || rows.length === 0) {
        return res.json({
            success: true,
            wa_text: '',
            message: 'Data tidak ditemukan sesuai filter',
        });
        }

        // Susun WA text: hanya berdasarkan cabang + hasil filter nama
        let text = `*REKAP CALON CUSTOMER*\n`;
        text += `CABANG: ${cabang}\n`;
        text += `FILTER NAMA: ${cc_nama.trim()}\n`;
        text += `TOTAL: ${rows.length}\n`;
        text += `_____________________\n\n`;

        rows.forEach((it, idx) => {
        text += `*${idx + 1}. ${it.cc_nama || '-'}*\n`;
        text += `Kode: ${it.cc_kode || it.id}\n`;
        text += `Alamat: ${it.cc_alamat || '-'}\n`;
        text += `CP: ${it.cc_cp || '-'}\n`;
        text += `Telp: ${it.cc_telp || '-'}\n`;
        if (it.cc_kota) text += `Kota: ${it.cc_kota}\n`;
        text += `_____________________\n`;
        });

        return res.json({
        success: true,
        wa_text: text,
        });
    } catch (err) {
        console.error('REKAP CALON CUSTOMER WA ERROR:', err);
        return res.status(500).json({
        success: false,
        message: 'Gagal membuat rekap WA',
        });
    }
}

// Ganti Password
const gantiPassword = async (req, res) => {
    const { user, oldPassword, newPassword } = req.body;

    // validasi mirip Delphi
    if (!user) {
        return res.status(400).json({ success: false, message: 'User belum ada (login dulu)' });
    }

    if (!oldPassword || oldPassword.length < 3 || !newPassword || newPassword.length < 3) {
        return res.status(400).json({ success: false, message: 'Data belum lengkap.' });
    }

    try {
        const [rows] = await db.query(
            `SELECT kar_password 
            FROM tkaryawan 
            WHERE kar_isaktif = 1 AND kar_nama = ?
            LIMIT 1`,
            [user]
        );

        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User tidak ditemukan / tidak aktif' });
        }

        const currentPassword = rows[0].kar_password;

        if (oldPassword !== currentPassword) {
            return res.status(400).json({ success: false, message: 'Password lama salah.' });
        }

        if (newPassword.length < 3) {
            return res.status(400).json({ success: false, message: 'Password baru tidak valid.' });
        }

        // update password
        await db.query(
        `UPDATE tkaryawan SET kar_password = ? WHERE kar_nama = ?`,
        [newPassword, user]
        );

        return res.json({
        success: true,
        message: 'Perubahan password berhasil.',
        data: { forceLogout: true },
        });
    } catch (err) {
        console.error('CHANGE PASSWORD ERROR:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// Get nama karyawan
const getUser = async (req, res) => {
    const { cabang } = req.query;

    if (!cabang) {
        return res.status(400).json({ 
            success: false, 
            message: 'Parameter cabang wajib diisi' 
        });
    }

    try {
        const [rows] = await db.query(
            `SELECT kar_nama, kar_cabang, kar_jabatan 
                FROM tkaryawan 
                WHERE kar_isaktif = 1 
                AND kar_jabatan = 'SALES' 
                AND kar_cabang = ?`, 
            [cabang] 
        );

        return res.json({
            success: true,
            count: rows.length,
            data: rows
        });

    } catch (err) {
        console.error('ERROR GET SALES BY CABANG:', err);
        return res.status(500).json({ 
            success: false, 
            message: 'Gagal mengambil data sales' 
        });
    }
};

module.exports = {
    calonCustomer, 
    cariCustomer, 
    getCabang, 
    createVisitPlan, 
    visitPlanById,
    createVisit, 
    updateVisit, 
    uploadVisitPhoto, 
    getRekapVisit,
    rekapVisitWA,
    updateRekapVisit,
    getRekapVisitPlan,
    rekapVisitPlanWA,
    getRekapCalonCustomer,
    rekapCalonCustomerWA,
    gantiPassword,
    getUser
}