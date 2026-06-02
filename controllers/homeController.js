const db = require("../config/dbMain");

function safe(v, fallback = "-") {
    if (v === null || v === undefined) return fallback;
    const s = String(v).trim();
    return s.length ? s : fallback;
}
function getWIBDateTime() {
    const d = new Date();
    const utc = d.getTime() + (d.getTimezoneOffset() * 60 * 1000);
    return new Date(utc + (3600000 * 7));
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
function getPublicBaseUrl(req) {
    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers["x-forwarded-host"] || req.get("host");
    return `${proto}://${host}`;
}

// Post Calon Customer
const calonCustomer = async (req, res) => {
    const { nama, alamat, cabang, telp, pic } = req.body;

    if (!nama) {
        return res.status(400).json({
            success: false,
            message: "Nama customer wajib diisi",
        });
    }

    const conn = await db.getConnection();

    try {
        await conn.beginTransaction();

        // ambil cc_kode (5-digit numeric) baru dari kencanaprint.tcustomer
        const [[{ max_kode }]] = await conn.query(
            `SELECT IFNULL(MAX(CAST(cus_kode AS UNSIGNED)), 0) AS max_kode
             FROM kencanaprint.tcustomer
             WHERE TRIM(IFNULL(cus_kode, '')) REGEXP '^[0-9]{1,5}$'`,
        );

        let nextKodeNum = Number(max_kode || 0) + 1;
        let ccKode = "";

        // memastikan cc_kode tidak bentrok
        while (true) {
            ccKode = String(nextKodeNum).padStart(5, "0");

            const [cek] = await conn.query(
                "SELECT 1 FROM kencanaprint.tcustomer WHERE cus_kode = ?",
                [ccKode],
            );

            if (cek.length === 0) break;
            nextKodeNum++;
        }

        // Insert data ke kencanaprint.tcustomer
        await conn.query(
            `INSERT INTO kencanaprint.tcustomer
             (cus_kode, cus_nama, cus_alamat, cus_kota, cus_telp, cus_cp, cus_aktif, user_create, date_create)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, NOW())`,
            [ccKode, nama, alamat || "", cabang || "", telp || "", pic || "", "PlanToday"],
        );

        await conn.commit();

        res.json({
            success: true,
            message: "Calon customer berhasil disimpan",
            data: {
                cc_id: nextKodeNum,
                cc_kode: ccKode,
            },
        });
    } catch (err) {
        await conn.rollback();
        console.error(err);
        res.status(500).json({
            success: false,
            message: "Gagal menyimpan calon customer",
        });
    } finally {
        conn.release();
    }
};

// Update calon customer
const updateCalonCustomerByKode = async (req, res) => {
    const cc_kode = String(req.params.cc_kode || "").trim();

    const cc_nama = String(req.body.cc_nama || "").trim();
    const cc_kota = String(req.body.cc_kota || "").trim();
    const cc_alamat = String(req.body.cc_alamat || "").trim();
    const cc_cp = String(req.body.cc_cp || "").trim();
    const cc_telp = String(req.body.cc_telp || "").trim();
    const cc_email = String(req.body.cc_email || "").trim();
    const cc_korporasi = String(req.body.cc_korporasi || "N").trim();
    const cc_jenisusaha = String(req.body.cc_jenisusaha || "").trim();
    const cc_npwp = String(req.body.cc_npwp || "").trim();
    const cc_nama_npwp = String(req.body.cc_nama_npwp || "").trim();
    const cc_alamat_npwp = String(req.body.cc_alamat_npwp || "").trim();
    const cc_kota_npwp = String(req.body.cc_kota_npwp || "").trim();

    if (!cc_kode) {
        return res
            .status(400)
            .json({ success: false, message: "cc_kode tidak valid" });
    }
    if (!cc_nama) {
        return res
            .status(400)
            .json({ success: false, message: "cc_nama wajib diisi" });
    }

    try {
        const [exist] = await db.query(
            `SELECT cus_kode FROM kencanaprint.tcustomer WHERE cus_kode = ? LIMIT 1`,
            [cc_kode],
        );

        if (!exist || exist.length === 0) {
            return res
                .status(404)
                .json({ success: false, message: "Data tidak ditemukan" });
        }

        const sql = `
        UPDATE kencanaprint.tcustomer
        SET
            cus_nama = ?,
            cus_kota = ?,
            cus_alamat = ?,
            cus_cp = ?,
            cus_telp = ?,
            cus_email = ?,
            cus_korporasi = ?,
            cus_jenisusaha = ?,
            cus_npwp = ?,
            cus_nama_npwp = ?,
            cus_alamat_npwp = ?,
            cus_kota_npwp = ?
        WHERE cus_kode = ?
        LIMIT 1
        `;

        const params = [
            cc_nama,
            cc_kota,
            cc_alamat,
            cc_cp,
            cc_telp,
            cc_email,
            cc_korporasi,
            cc_jenisusaha,
            cc_npwp,
            cc_nama_npwp,
            cc_alamat_npwp,
            cc_kota_npwp,
            cc_kode,
        ];

        const [result] = await db.query(sql, params);

        const [rows] = await db.query(
            `SELECT cus_kode AS cc_kode, cus_nama AS cc_nama, cus_alamat AS cc_alamat, cus_kota AS cc_kota, cus_cp AS cc_cp, cus_telp AS cc_telp
             FROM kencanaprint.tcustomer
             WHERE cus_kode = ? LIMIT 1`,
            [cc_kode],
        );

        if (result?.affectedRows === 0) {
            return res.status(200).json({
                success: true,
                message: "Tidak ada perubahan",
                data: rows?.[0] || null,
            });
        }

        return res.json({
            success: true,
            message: "Berhasil update",
            data: rows?.[0] || null,
        });
    } catch (err) {
        console.error("UPDATE CUSTOMER ERROR:", err);
        return res
            .status(500)
            .json({ success: false, message: err.sqlMessage || err.message });
    }
};

// Get cabang
const getCabang = async (req, res) => {
    const { jabatan, cabang, nama } = req.query;

    try {
        const [cabang] = await db.query(
            `SELECT cabang AS nama FROM tcabang ORDER BY cbg_kode`,
        );

        return res.json({
            success: true,
            data: {
                user: nama,
                jabatan,
                cabang: cabang.map((c) => c.nama),
            },
        });
    } catch (err) {
        console.error("INIT VISIT PLAN ERROR:", err);
        res.status(500).json({
            success: false,
            message: "Gagal mengambil data",
        });
    }
};

// Get Pencarian Customer
const cariCustomer = async (req, res) => {
    try {
        const search = String(req.query.search ?? "").trim();

        if (!search) {
            return res.status(400).json({
                success: false,
                message: "Parameter search wajib diisi",
            });
        }

        const like = `%${search}%`;
        const [rows] = await db.query(
            `
            SELECT
                CONCAT('CUSTOMER-', NULLIF(cus_kode, '')) AS id,
                cus_kode                                   AS cc_kode,
                cus_nama                                   AS cc_nama,
                cus_alamat                                 AS cc_alamat,
                cus_cp                                     AS cc_cp,
                cus_telp                                   AS cc_telp,
                cus_kota                                   AS cc_kota,
                'CUSTOMER'                                 AS sumber
            FROM kencanaprint.tcustomer
            WHERE cus_nama LIKE ? OR cus_kode LIKE ?
            ORDER BY cus_nama ASC
            LIMIT 50
            `,
            [like, like],
        );

        return res.json({ success: true, data: rows });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

const logVisitPlanAction = (action, payload) => {
    try {
        console.info(`VISIT_PLAN_${action.toUpperCase()}`, payload);
    } catch (_) {
        /* noop logging fallback */
    }
};

// Post Visit Plan
const createVisitPlan = async (req, res) => {
    const cus_kode = String(req.body.cus_kode || "").trim();
    const user = String(req.body.user || "").trim();
    const tanggal_plan = String(req.body.tanggal_plan || "")
        .trim()
        .slice(0, 10);
    const note = String(req.body.note || "").trim();

    if (!cus_kode)
        return res
            .status(400)
            .json({ success: false, message: "Customer masih belum diisi" });
    if (!user)
        return res.status(400).json({ success: false, message: "User wajib" });
    if (!tanggal_plan)
        return res
            .status(400)
            .json({ success: false, message: "tanggal_plan wajib" });

    // Batasan Waktu: Rencana kunjungan untuk hari yang sama hanya dapat diinput sebelum jam 08:00 pagi WIB
    const nowWib = getWIBDateTime();
    const todayYmd = nowWib.toISOString().slice(0, 10); // YYYY-MM-DD
    const currentHour = nowWib.getHours();

    if (tanggal_plan < todayYmd) {
        return res.status(400).json({
            success: false,
            message: "Tanggal rencana kunjungan tidak boleh kurang dari hari ini",
        });
    }

    if (tanggal_plan === todayYmd && currentHour >= 8) {
        return res.status(400).json({
            success: false,
            message: "Rencana kunjungan untuk hari yang sama hanya dapat diinput sebelum jam 08:00 pagi",
        });
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        // Lock 1 baris plan yang relevan (kalau ada)
        const [exist] = await conn.query(
            `
        SELECT id
        FROM tkunjungan
        WHERE user = ?
            AND cus_kode = ?
            AND DATE(tanggal_plan) = ?
        LIMIT 1
        FOR UPDATE
        `,
            [user, cus_kode, tanggal_plan],
        );

        if (exist.length > 0) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                message: "Plan sudah ada",
            });
        }

        // Cek kuota maksimal 8 plan di hari yang sama sebelum insert baru
        const [countRows] = await conn.query(
            `SELECT COUNT(*) as count FROM tkunjungan WHERE user = ? AND DATE(tanggal_plan) = ?`,
            [user, tanggal_plan],
        );

        if (countRows && countRows[0] && countRows[0].count >= 8) {
            await conn.rollback();
            return res.status(400).json({
                success: false,
                message: "Batas maksimal rencana kunjungan (visit plan) adalah 8 per hari",
            });
        }

        // Kalau belum ada, insert baru (realisasi default N)
        const [ins] = await conn.query(
            `
        INSERT INTO tkunjungan (cus_kode, user, note, tanggal_plan, realisasi)
        VALUES (?, ?, ?, CONCAT(?, ' 00:00:00'), 'N')
        `,
            [cus_kode, user, note, tanggal_plan],
        );

        await conn.commit();
        logVisitPlanAction("insert", {
            user,
            cus_kode,
            tanggal_plan,
            id: ins.insertId,
        });
        return res.json({
            success: true,
            message: "Simpan Berhasil",
            data: { id: ins.insertId, isUpdate: false },
        });
    } catch (err) {
        await conn.rollback();
        console.error("CREATE VISIT PLAN ERROR:", err);
        return res
            .status(500)
            .json({ success: false, message: err.sqlMessage || err.message });
    } finally {
        conn.release();
    }
};

// Get visit plan by ID
const visitPlanById = async (req, res) => {
    const { user, tanggal, cus_kode } = req.query;

    if (!user || !tanggal || !cus_kode) {
        return res.status(400).json({
            success: false,
            message: "user, tanggal, cus_kode wajib",
        });
    }

    try {
        const [rows] = await db.query(
            `
        SELECT
            k.id,
            DATE(k.tanggal_plan) AS tanggal_plan,
            DATE(k.tanggal) AS tanggal_visit,
            k.cus_kode,
            k.note,
            k.catatan,
            k.realisasi,             -- ✅ tambahkan ini
            c.cus_nama AS cc_nama,
            c.cus_alamat AS cc_alamat,
            c.cus_kota AS cc_kota
        FROM tkunjungan k
        LEFT JOIN v_customer c ON c.cus_kode = k.cus_kode
        WHERE k.user = ?
            AND DATE(k.tanggal_plan) = ?
            AND k.cus_kode = ?
        ORDER BY (k.realisasi = 'Y') DESC, k.id DESC   -- ✅ DONE dipilih dulu
        LIMIT 1
        `,
            [user, tanggal, cus_kode],
        );

        return res.json({ success: true, data: rows?.[0] || null });
    } catch (err) {
        console.error("GET VISIT PLAN DETAIL ERROR:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// Update visit plan
const updateVisitPlan = async (req, res) => {
    const { id } = req.params;
    const { tanggal_plan, note, catatan } = req.body;

    if (!id) {
        return res
            .status(400)
            .json({ success: false, message: "ID tidak valid" });
    }

    if (!tanggal_plan) {
        return res
            .status(400)
            .json({ success: false, message: "tanggal_plan wajib diisi" });
    }

    try {
        const [planRows] = await db.query(
            `SELECT user, cus_kode, DATE_FORMAT(tanggal_plan, '%Y-%m-%d') as current_tgl FROM tkunjungan WHERE id = ?`,
            [id]
        );
        if (planRows.length === 0) {
            return res
                .status(404)
                .json({ success: false, message: "Data tidak ditemukan" });
        }

        const planUser = planRows[0].user;
        const currentTgl = planRows[0].current_tgl;
        const newTgl = String(tanggal_plan).trim().slice(0, 10);

        // Batasan Waktu & Kuota hanya dicek jika ada perpindahan tanggal rencana
        if (currentTgl !== newTgl) {
            const planCusKode = planRows[0].cus_kode;

            // Cek duplikasi plan untuk customer & tanggal target yang sama
            const [dupRows] = await db.query(
                `SELECT id FROM tkunjungan WHERE user = ? AND cus_kode = ? AND DATE(tanggal_plan) = ? LIMIT 1`,
                [planUser, planCusKode, newTgl]
            );

            if (dupRows.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: "Plan sudah ada",
                });
            }

            const nowWib = getWIBDateTime();
            const todayYmd = nowWib.toISOString().slice(0, 10); // YYYY-MM-DD
            const currentHour = nowWib.getHours();

            if (newTgl < todayYmd) {
                return res.status(400).json({
                    success: false,
                    message: "Tanggal rencana kunjungan tidak boleh kurang dari hari ini",
                });
            }

            // Batas waktu jam 8 pagi WIB untuk plan hari ini
            if (newTgl === todayYmd && currentHour >= 8) {
                return res.status(400).json({
                    success: false,
                    message: "Rencana kunjungan untuk hari yang sama hanya dapat diinput sebelum jam 08:00 pagi",
                });
            }

            // Batas kuota 8 plan di tanggal target
            const [countRows] = await db.query(
                `SELECT COUNT(*) as count FROM tkunjungan WHERE user = ? AND DATE(tanggal_plan) = ?`,
                [planUser, newTgl]
            );

            if (countRows && countRows[0] && countRows[0].count >= 8) {
                return res.status(400).json({
                    success: false,
                    message: "Batas maksimal rencana kunjungan (visit plan) adalah 8 per hari pada tanggal target",
                });
            }
        }

        const [result] = await db.query(
            `UPDATE tkunjungan
        SET tanggal_plan = CONCAT(?, ' 00:00:00'),
            note = ?,
            catatan = ?
        WHERE id = ?
        `,
            [String(tanggal_plan), note ?? "", catatan ?? "", id],
        );

        if (result.affectedRows === 0) {
            return res
                .status(404)
                .json({ success: false, message: "Data tidak ditemukan" });
        }

        return res.json({
            success: true,
            message: "Update Visit Plan Berhasil",
            data: { id: Number(id) },
        });
    } catch (err) {
        console.error("UPDATE VISIT PLAN ERROR:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// Post Visit
const createVisit = async (req, res) => {
    const user = String(req.body.user || "").trim();
    const cus_kode = String(req.body.cus_kode || "").trim();
    const tanggal = String(req.body.tanggal || "").trim(); // YYYY-MM-DD

    const note = String(req.body.note || "").trim();
    const catatan = String(req.body.catatan || "").trim();
    const latitude = req.body.latitude || null;
    const longitude = req.body.longitude || null;

    if (!user || !cus_kode || !tanggal) {
        return res
            .status(400)
            .json({ success: false, message: "user, cus_kode, tanggal wajib" });
    }

    const nowWib = getWIBDateTime();
    const todayYmd = nowWib.toISOString().slice(0, 10); // YYYY-MM-DD
    if (tanggal.slice(0, 10) < todayYmd) {
        return res.status(400).json({
            success: false,
            message: "Tanggal kunjungan tidak boleh kurang dari hari ini",
        });
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        // kunci draft agar tidak double insert saat submit bersamaan
        const [draftRows] = await conn.query(
            `
        SELECT id
        FROM tkunjungan
        WHERE user = ?
            AND cus_kode = ?
            AND DATE(tanggal_plan) = ?
            AND (realisasi = 'N' OR realisasi IS NULL OR realisasi = '')
        ORDER BY id DESC
        LIMIT 1
        FOR UPDATE
        `,
            [user, cus_kode, tanggal],
        );

        if (draftRows.length > 0) {
            const draftId = draftRows[0].id;

            await conn.query(
                `
            UPDATE tkunjungan
            SET
            latitude = ?,
            longitude = ?,
            note = ?,
            catatan = ?,
            realisasi = 'Y',
            tanggal = CONCAT(?, ' 00:00:00'),
            tanggal_plan = CONCAT(?, ' 00:00:00')
            WHERE id = ?
            LIMIT 1
            `,
                [latitude, longitude, note, catatan, tanggal, tanggal, draftId],
            );

            await conn.commit();
            return res.json({
                success: true,
                message: "Visit tersimpan (UPDATE dari plan)",
                data: { id: draftId },
            });
        }

        // kalau tidak ada draft -> insert baru
        const [result] = await conn.query(
            `
        INSERT INTO tkunjungan
            (cus_kode, user, latitude, longitude, note, catatan, realisasi, tanggal, tanggal_plan)
        VALUES
            (?, ?, ?, ?, ?, ?, 'Y', CONCAT(?, ' 00:00:00'), CONCAT(?, ' 00:00:00'))
        `,
            [
                cus_kode,
                user,
                latitude,
                longitude,
                note,
                catatan,
                tanggal,
                tanggal,
            ],
        );

        await conn.commit();
        return res.json({
            success: true,
            message: "Visit tersimpan (CREATE)",
            data: { id: result.insertId },
        });
    } catch (err) {
        await conn.rollback();
        console.error("CREATE VISIT UPSERT ERROR:", err);
        return res.status(500).json({ success: false, message: err.message });
    } finally {
        conn.release();
    }
};

// Get visit from visit plan
const getVisitFromPlan = async (req, res) => {
    const user = String(req.query.user || "").trim();
    const cus_kode = String(req.query.cus_kode || "").trim();
    const tanggal = String(req.query.tanggal || "")
        .trim()
        .slice(0, 10); // YYYY-MM-DD

    if (!user || !cus_kode || !tanggal) {
        return res
            .status(400)
            .json({ success: false, message: "user, cus_kode, tanggal wajib" });
    }

    try {
        const [rows] = await db.query(
            `
        SELECT
            k.id,
            DATE_FORMAT(k.tanggal_plan, '%Y-%m-%d') AS tanggal_plan,
            DATE_FORMAT(k.tanggal, '%Y-%m-%d') AS tanggal,
            k.cus_kode,
            k.note,
            k.catatan,
            k.realisasi,
            k.latitude,
            k.longitude,
            c.cus_nama AS cc_nama,
            c.cus_alamat AS cc_alamat,
            c.cus_kota AS cc_kota
        FROM tkunjungan k
        LEFT JOIN v_customer c ON c.cus_kode = k.cus_kode
        WHERE k.user = ?
            AND k.cus_kode = ?
            AND DATE(k.tanggal_plan) = ?
        ORDER BY (k.realisasi='Y') DESC, k.id DESC
        LIMIT 1
        `,
            [user, cus_kode, tanggal],
        );

        // kalau tidak ada plan => null
        return res.json({ success: true, data: rows?.[0] || null });
    } catch (err) {
        console.error("GET VISIT FROM PLAN ERROR:", err);
        return res
            .status(500)
            .json({ success: false, message: err.sqlMessage || err.message });
    }
};

const getVisitDraft = async (req, res) => {
    const user = String(req.query.user || "").trim();
    const cus_kode = String(req.query.cus_kode || "").trim();
    const tanggal = String(req.query.tanggal || "").trim(); // YYYY-MM-DD

    if (!user || !cus_kode || !tanggal) {
        return res
            .status(400)
            .json({ success: false, message: "user, cus_kode, tanggal wajib" });
    }

    try {
        const [rows] = await db.query(
            `
        SELECT
            k.id,
            DATE_FORMAT(k.tanggal_plan, '%Y-%m-%d') AS tanggal_plan,
            k.cus_kode,
            k.note,
            k.catatan,
            k.realisasi
        FROM tkunjungan k
        WHERE k.user = ?
            AND k.cus_kode = ?
            AND DATE(k.tanggal_plan) = ?
            AND (k.realisasi = 'N' OR k.realisasi IS NULL OR k.realisasi = '')
        ORDER BY k.id DESC
        LIMIT 1
        `,
            [user, cus_kode, tanggal],
        );

        return res.json({ success: true, data: rows?.[0] || null });
    } catch (err) {
        console.error("GET VISIT DRAFT ERROR:", err);
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
            message: "ID kunjungan tidak valid",
        });
    }

    if (tanggal) {
        const nowWib = getWIBDateTime();
        const todayYmd = nowWib.toISOString().slice(0, 10); // YYYY-MM-DD
        if (tanggal.slice(0, 10) < todayYmd) {
            return res.status(400).json({
                success: false,
                message: "Tanggal kunjungan tidak boleh kurang dari hari ini",
            });
        }
    }

    try {
        await db.query(
            `UPDATE tkunjungan
        SET latitude = ?, longitude = ?, note = ?, catatan = ?, realisasi = 'Y', tanggal = ?
        WHERE id = ?`,
            [
                latitude || null,
                longitude || null,
                note || "",
                catatan || "",
                tanggal || null,
                id,
            ],
        );

        return res.json({
            success: true,
            message: "Update Berhasil",
            data: { id: Number(id) },
        });
    } catch (err) {
        console.error("UPDATE VISIT ERROR:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// Upload Photo Visit
const uploadVisitPhoto = async (req, res) => {
    const { id } = req.params;

    if (!id)
        return res
            .status(400)
            .json({ success: false, message: "ID visit tidak valid" });
    if (!req.file)
        return res.status(400).json({
            success: false,
            message: "File foto tidak ditemukan (req.file kosong)",
        });

    try {
        const relativePath = `/uploads/visits/${req.file.filename}`;

        await db.query(`UPDATE tkunjungan SET foto = ? WHERE id = ?`, [
            relativePath,
            id,
        ]);

        return res.json({
            success: true,
            message: "Foto berhasil disimpan ke server dan database",
            data: { id: Number(id), filename: req.file.filename },
        });
    } catch (err) {
        console.error("UPLOAD PHOTO ERROR:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// Get Rekap Visit
const getRekapVisit = async (req, res) => {
    const user = String(req.query.user || "").trim();

    const tanggal = String(req.query.tanggal || "").trim();
    const tanggalAwal = String(req.query.tanggal_awal || "").trim();
    const tanggalAkhir = String(req.query.tanggal_akhir || "").trim();

    const cabang = String(req.query.cabang || "")
        .trim()
        .toUpperCase();

    if (!user) {
        return res
            .status(400)
            .json({ success: false, message: "User wajib diisi" });
    }

    const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

    let start = "";
    let end = "";

    if (tanggal) {
        if (!isYmd(tanggal)) {
            return res.status(400).json({
                success: false,
                message: "format tanggal harus YYYY-MM-DD",
            });
        }
        start = tanggal;
        end = tanggal;
    } else if (tanggalAwal && tanggalAkhir) {
        if (!isYmd(tanggalAwal) || !isYmd(tanggalAkhir)) {
            return res.status(400).json({
                success: false,
                message: "format tanggal_awal & tanggal_akhir harus YYYY-MM-DD",
            });
        }
        start = tanggalAwal <= tanggalAkhir ? tanggalAwal : tanggalAkhir;
        end = tanggalAwal <= tanggalAkhir ? tanggalAkhir : tanggalAwal;
    } else {
        return res.status(400).json({
            success: false,
            message:
                "Tanggal wajib diisi (tanggal) atau (tanggal_awal & tanggal_akhir)",
        });
    }

    try {
        const PUBLIC_BASE_URL =
            process.env.PUBLIC_BASE_URL || getPublicBaseUrl(req);
        let sql = `
            SELECT
            a.id,
            DATE_FORMAT(a.tanggal_plan, '%Y-%m-%d') AS tanggal_plan,
            DATE_FORMAT(a.tanggal, '%Y-%m-%d') AS tanggal,
            a.cus_kode,
            b.cus_nama AS cc_nama,
            b.cus_alamat AS cc_alamat,
            a.latitude,
            a.longitude,
            a.note,
            a.catatan,
            a.realisasi,
            CAST(a.foto AS CHAR(255)) AS foto,
            CASE
                WHEN a.foto IS NULL OR CAST(a.foto AS CHAR(255)) = '' THEN NULL
                WHEN CAST(a.foto AS CHAR(255)) LIKE 'http%' THEN CAST(a.foto AS CHAR(255))
                ELSE CONCAT(?, CAST(a.foto AS CHAR(255)))
            END AS foto_url
            FROM tkunjungan a
            LEFT JOIN v_customer b ON b.cus_kode = a.cus_kode
            LEFT JOIN tkaryawan k ON k.kar_nama = a.user AND k.kar_isaktif = 1
            WHERE a.user = ?
            AND a.realisasi = 'Y'
            AND DATE(a.tanggal) >= ?
            AND DATE(a.tanggal) <= ?
            `;

        const params = [PUBLIC_BASE_URL, user, start, end];

        if (cabang) {
            sql += ` AND UPPER(k.kar_cabang) = ?`;
            params.push(cabang);
        }

        sql += ` ORDER BY a.tanggal DESC, a.id DESC`;

        const [rows] = await db.query(sql, params);

        return res.json({ success: true, data: rows });
    } catch (err) {
        console.error("GET REKAP VISIT ERROR:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// Rekap visit WA
const rekapVisitWA = async (req, res) => {
    const user = String(req.query.user || "").trim();
    const cabang = String(req.query.cabang || "").trim();

    const tanggal = String(req.query.tanggal || "").trim();
    const tanggalAwal = String(req.query.tanggal_awal || "").trim();
    const tanggalAkhir = String(req.query.tanggal_akhir || "").trim();

    if (!user) {
        return res
            .status(400)
            .json({ success: false, message: "Parameter user wajib diisi" });
    }

    const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

    let start = "";
    let end = "";

    if (tanggal) {
        if (!isYmd(tanggal))
            return res.status(400).json({
                success: false,
                message: "format tanggal harus YYYY-MM-DD",
            });
        start = tanggal;
        end = tanggal;
    } else if (tanggalAwal && tanggalAkhir) {
        if (!isYmd(tanggalAwal) || !isYmd(tanggalAkhir)) {
            return res.status(400).json({
                success: false,
                message: "format tanggal_awal & tanggal_akhir harus YYYY-MM-DD",
            });
        }
        start = tanggalAwal <= tanggalAkhir ? tanggalAwal : tanggalAkhir;
        end = tanggalAwal <= tanggalAkhir ? tanggalAkhir : tanggalAwal;
    } else {
        return res.status(400).json({
            success: false,
            message: "Isi tanggal atau tanggal_awal & tanggal_akhir",
        });
    }

    try {
        let sql = `
        SELECT
            ku.id,
            ca.cus_nama AS cc_nama,
            ku.cus_kode,
            DATE_FORMAT(ku.tanggal, '%Y-%m-%d') AS tanggal_visit,
            DATE_FORMAT(ku.tanggal_plan, '%Y-%m-%d') AS tanggal_plan,
            ku.user,
            ku.note,
            ku.catatan,
            ku.realisasi,
            ka.kar_cabang AS user_cabang
        FROM tkunjungan ku
        INNER JOIN tkaryawan ka ON ka.kar_nama = ku.user
        INNER JOIN v_customer ca ON ca.cus_kode = ku.cus_kode
        WHERE ku.user = ?
            AND ku.realisasi = 'Y'
            AND DATE(ku.tanggal) >= ?
            AND DATE(ku.tanggal) <= ?
        `;

        const params = [user, start, end];

        if (cabang) {
            sql += ` AND UPPER(ka.kar_cabang) = ?`;
            params.push(String(cabang).toUpperCase());
        }

        sql += ` ORDER BY DATE(ku.tanggal) ASC, ku.id ASC`;

        const [rows] = await db.query(sql, params);

        if (!rows || rows.length === 0) {
            return res.json({ success: true, wa_text: "" });
        }

        const cabangFinal = cabang || rows[0]?.user_cabang;

        let text = `*REKAP VISIT*\n`;
        text += `SALES: ${safe(user)}\n`;
        if (cabangFinal) text += `CABANG: ${safe(cabangFinal)}\n`;
        text +=
            start === end
                ? `TANGGAL: ${formatTanggalID(String(start))}\n`
                : `PERIODE: ${formatTanggalID(String(start))} s/d ${formatTanggalID(String(end))}\n`;
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
        console.error("REKAP VISIT WA ERROR:", err);
        return res.status(500).json({
            success: false,
            message: err?.message || "Gagal membuat rekap WA",
        });
    }
};

// Update rekap visit
const updateRekapVisit = async (req, res) => {
    const { id } = req.params;
    const { note } = req.body;

    if (!id) {
        return res
            .status(400)
            .json({ success: false, message: "ID tidak valid" });
    }

    try {
        await db.query("UPDATE tkunjungan SET note = ? WHERE id = ?", [
            note,
            id,
        ]);

        res.json({
            success: true,
            message: "Catatan keperluan berhasil diperbarui",
        });
    } catch (err) {
        console.error("UPDATE NOTE ERROR:", err);
        res.status(500).json({ success: false, message: err.message });
    }
};

const logRekapDebug = (tag, payload) => {
    try {
        console.info(`[REKAP_VISIT_PLAN] ${tag}`, payload);
    } catch (_) {}
};

// Get Rekap visit plan
const getRekapVisitPlan = async (req, res) => {
    const { user, cabang, tanggal_awal, tanggal_akhir } = req.query;

    if (!user || !tanggal_awal || !tanggal_akhir) {
        return res.status(400).json({
            success: false,
            message: "Parameter user, tanggal_awal, tanggal_akhir wajib diisi",
        });
    }

    try {
        const PUBLIC_BASE_URL =
            process.env.PUBLIC_BASE_URL || getPublicBaseUrl(req);
        let sql = `
        WITH pick AS (
            SELECT
                cus_kode,
                DATE(tanggal_plan) AS tgl,
                MAX(id) AS pick_id
            FROM tkunjungan
            WHERE user = ?
                AND DATE(tanggal_plan) BETWEEN ? AND ?
            GROUP BY cus_kode, DATE(tanggal_plan)
        )
        SELECT
            k.id,
            DATE_FORMAT(k.tanggal_plan, '%Y-%m-%d') AS tanggal_plan,
            DATE_FORMAT(k.tanggal, '%Y-%m-%d') AS tanggal,
            k.cus_kode,
            k.note,
            k.catatan,
            k.realisasi,
            k.latitude,
            k.longitude,
            CAST(k.foto AS CHAR(255)) AS foto,
            CASE
                WHEN k.foto IS NULL OR CAST(k.foto AS CHAR(255)) = '' THEN NULL
                WHEN CAST(k.foto AS CHAR(255)) LIKE 'http%' THEN CAST(k.foto AS CHAR(255))
                ELSE CONCAT(?, CAST(k.foto AS CHAR(255)))
            END AS foto_url,
            c.cus_nama AS cc_nama,
            c.cus_alamat AS cc_alamat,
            c.cus_kota AS cc_kota
        FROM pick p
        JOIN tkunjungan k ON k.id = p.pick_id
        LEFT JOIN v_customer c ON c.cus_kode = k.cus_kode
        INNER JOIN tkaryawan ka ON ka.kar_nama = k.user AND ka.kar_isaktif = 1
        WHERE k.user = ?
        `;

        const params = [user, tanggal_awal, tanggal_akhir, PUBLIC_BASE_URL, user];

        if (cabang) {
            sql += ` AND ka.kar_cabang = ?`;
            params.push(cabang);
        }

        sql += ` ORDER BY DATE(k.tanggal_plan) DESC, k.id DESC`;

        const [rows] = await db.query(sql, params);
        logRekapDebug("fetch", {
            user,
            tanggal_awal,
            tanggal_akhir,
            total: rows?.length || 0,
        });
        return res.json({ success: true, data: rows || [] });
    } catch (err) {
        console.error("REKAP VISIT PLAN ERROR:", err);
        return res
            .status(500)
            .json({ success: false, message: err.sqlMessage || err.message });
    }
};

// Rekap visit plan WA
const rekapVisitPlanWA = async (req, res) => {
    const user = String(req.query.user || "").trim();
    const cabang = String(req.query.cabang || "").trim();

    const tanggal = String(req.query.tanggal || "").trim();
    const tanggalAwal = String(req.query.tanggal_awal || "").trim();
    const tanggalAkhir = String(req.query.tanggal_akhir || "").trim();

    if (!user) {
        return res
            .status(400)
            .json({ success: false, message: "Parameter user wajib diisi" });
    }

    const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

    let start = "";
    let end = "";

    if (tanggal) {
        if (!isYmd(tanggal)) {
            return res.status(400).json({
                success: false,
                message: "format tanggal harus YYYY-MM-DD",
            });
        }
        start = tanggal;
        end = tanggal;
    } else if (tanggalAwal && tanggalAkhir) {
        if (!isYmd(tanggalAwal) || !isYmd(tanggalAkhir)) {
            return res.status(400).json({
                success: false,
                message: "format tanggal_awal & tanggal_akhir harus YYYY-MM-DD",
            });
        }
        start = tanggalAwal <= tanggalAkhir ? tanggalAwal : tanggalAkhir;
        end = tanggalAwal <= tanggalAkhir ? tanggalAkhir : tanggalAwal;
    } else {
        return res.status(400).json({
            success: false,
            message: "Isi tanggal atau tanggal_awal & tanggal_akhir",
        });
    }

    try {
        let sql = `
        SELECT
        k.id,
        DATE_FORMAT(k.tanggal_plan, '%Y-%m-%d') AS tanggal_plan,
        k.cus_kode,
        c.cus_nama AS cc_nama,
        c.cus_alamat AS cc_alamat,
        c.cus_kota AS cc_kota,
        k.note,
        k.catatan,
        k.realisasi,
        ka.kar_cabang AS user_cabang
        FROM tkunjungan k
        JOIN (
        SELECT
            t.user,
            DATE(t.tanggal_plan) AS tgl,
            t.cus_kode,
            COALESCE(
            MAX(CASE WHEN t.realisasi = 'Y' THEN t.id END),
            MAX(t.id)
            ) AS pick_id
        FROM tkunjungan t
        WHERE t.user = ?
            AND DATE(t.tanggal_plan) >= ?
            AND DATE(t.tanggal_plan) <= ?
        GROUP BY t.user, DATE(t.tanggal_plan), t.cus_kode
        ) p ON p.pick_id = k.id
        LEFT JOIN v_customer c ON c.cus_kode = k.cus_kode
        LEFT JOIN tkaryawan ka ON ka.kar_nama = k.user AND ka.kar_isaktif = 1
        WHERE k.user = ?
    `;

        const params = [user, start, end, user];

        if (cabang) {
            sql += ` AND UPPER(ka.kar_cabang) = ?`;
            params.push(String(cabang).toUpperCase());
        }

        sql += ` ORDER BY DATE(k.tanggal_plan) ASC, k.id ASC`;

        const [rows] = await db.query(sql, params);

        if (!rows || rows.length === 0) {
            return res.json({
                success: true,
                wa_text: "",
                message: "Data kosong",
            });
        }

        const cabangFinal = cabang || rows[0]?.user_cabang;

        let text = `*REKAP VISIT PLAN*\n`;
        text += `SALES: ${safe(user)}\n`;
        if (cabangFinal) text += `CABANG: ${safe(cabangFinal)}\n`;
        text +=
            start === end
                ? `TANGGAL: ${formatTanggalID(String(start))}\n`
                : `PERIODE: ${formatTanggalID(String(start))} s/d ${formatTanggalID(String(end))}\n`;
        text += `TOTAL: ${rows.length}\n`;
        text += `_____________________\n\n`;

        let lastDate = "";
        rows.forEach((it, idx) => {
            const tglPlan = String(it.tanggal_plan || "").slice(0, 10);

            text += `*${idx + 1}.*\n`;
            if (tglPlan && tglPlan !== lastDate) {
                lastDate = tglPlan;
                text += `*${formatTanggalID(tglPlan)}*\n`;
            }

            text += `*Customer:* ${safe(it.cc_nama)}\n`;
            text += `*Kode:* ${safe(it.cus_kode)}\n`;
            text += `*Kota:* ${safe(it.cc_kota)}\n`;
            text += `*Alamat:* ${safe(it.cc_alamat)}\n`;

            // note kamu sebelumnya tulis sebagai "Keperluan" => tetap
            text += `*Keperluan:* ${safe(it.catatan)}\n`;

            if (it.catatan && String(it.catatan).trim().length) {
                text += `*Catatan:* ${safe(it.note)}\n`;
            }

            text += `*Status:* ${String(it.realisasi) === "Y" ? "Done" : "Belum"}\n`;
            text += `_____________________\n`;
        });

        return res.json({ success: true, wa_text: text });
    } catch (e) {
        console.error("REKAP VISIT PLAN WA ERROR:", e);
        return res
            .status(500)
            .json({ success: false, message: e.sqlMessage || e.message });
    }
};

// Get Rekap calon customer
const getRekapCalonCustomer = async (req, res) => {
    const { cabang, cc_nama, limit } = req.query;

    try {
        let query = `
        SELECT
            cus_kode  AS id,
            cus_kode  AS cc_kode,
            cus_nama  AS cc_nama,
            cus_alamat AS cc_alamat,
            cus_cp    AS cc_cp,
            cus_telp  AS cc_telp,
            cus_kota  AS cc_kota
        FROM kencanaprint.tcustomer
        WHERE 1=1
        `;
        const params = [];

        if (cabang && String(cabang).trim() !== "") {
            query += ` AND cus_kota = ?`;
            params.push(String(cabang).trim());
        }

        if (cc_nama && String(cc_nama).trim() !== "") {
            query += ` AND cus_nama LIKE ?`;
            params.push(`%${String(cc_nama).trim()}%`);
        }

        query += ` ORDER BY cus_kode DESC`;

        // limit default hanya kalau cabang kosong
        const safeLimit = Math.min(Number(limit || 200), 1000); // max 1000
        if (!cabang || String(cabang).trim() === "") {
            query += ` LIMIT ?`;
            params.push(safeLimit);
        }

        const [rows] = await db.query(query, params);
        return res.json({ success: true, data: rows });
    } catch (err) {
        console.error("GET REKAP CALON CUSTOMER ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal mengambil rekap calon customer",
        });
    }
};

// Rekap Calon Customer WA
const rekapCalonCustomerWA = async (req, res) => {
    const { cabang, cc_nama } = req.query;

    // cc_nama wajib supaya tidak semua data terkirim
    const keyword = String(cc_nama || "").trim();
    if (!keyword) {
        return res.status(400).json({
            success: false,
            message:
                "Tentukan Nama Customer \n(agar tidak semua data terkirim)",
        });
    }

    // Hard cap supaya WA tidak kebanyakan
    const MAX_WA_ROWS = 10;

    try {
        const like = `%${keyword}%`;
        const cab = String(cabang || "").trim(); // optional

        let query = `
        SELECT
            cus_kode   AS id,
            cus_kode   AS cc_kode,
            cus_nama   AS cc_nama,
            cus_alamat AS cc_alamat,
            cus_cp     AS cc_cp,
            cus_telp   AS cc_telp,
            cus_kota   AS cc_kota,
            'CUSTOMER' AS sumber
        FROM kencanaprint.tcustomer
        WHERE cus_nama LIKE ?
        ${cab ? "AND cus_kota = ?" : ""}
        ORDER BY cus_nama ASC
        LIMIT ${MAX_WA_ROWS}
        `;

        const params = cab ? [like, cab] : [like];

        const [rows] = await db.query(query, params);

        if (!rows || rows.length === 0) {
            return res.json({
                success: true,
                wa_text: "",
                message: "Data tidak ditemukan sesuai filter",
            });
        }

        const cabangLabel = cab ? cab : "SEMUA";

        // Susun WA text
        let text = `*REKAP CUSTOMER*\n`;
        text += `CABANG/KOTA: ${cabangLabel}\n`;
        text += `FILTER NAMA: ${keyword}\n`;
        text += `TOTAL DIKIRIM: ${rows.length} (max ${MAX_WA_ROWS})\n`;
        text += `_____________________\n\n`;

        rows.forEach((it, idx) => {
            text += `*${idx + 1}. ${it.cc_nama || "-"}*\n`;
            text += `Sumber: ${it.sumber || "-"}\n`;
            text += `Kode: ${it.cc_kode || it.id || "-"}\n`;
            text += `Alamat: ${it.cc_alamat || "-"}\n`;
            text += `CP: ${it.cc_cp || "-"}\n`;
            text += `Telp: ${it.cc_telp || "-"}\n`;
            if (it.cc_kota) text += `Kota: ${it.cc_kota}\n`;
            text += `_____________________\n`;
        });

        return res.json({
            success: true,
            wa_text: text,
        });
    } catch (err) {
        console.error("REKAP CALON CUSTOMER WA ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal membuat rekap WA",
        });
    }
};

// Ganti Password
const gantiPassword = async (req, res) => {
    const { user, oldPassword, newPassword } = req.body;

    // validasi mirip Delphi
    if (!user) {
        return res
            .status(400)
            .json({ success: false, message: "User belum ada (login dulu)" });
    }

    if (
        !oldPassword ||
        oldPassword.length < 3 ||
        !newPassword ||
        newPassword.length < 3
    ) {
        return res
            .status(400)
            .json({ success: false, message: "Data belum lengkap." });
    }

    try {
        const [rows] = await db.query(
            `SELECT kar_password 
            FROM tkaryawan 
            WHERE kar_isaktif = 1 AND kar_nama = ?
            LIMIT 1`,
            [user],
        );

        if (!rows || rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User tidak ditemukan / tidak aktif",
            });
        }

        const currentPassword = rows[0].kar_password;

        if (oldPassword !== currentPassword) {
            return res
                .status(400)
                .json({ success: false, message: "Password lama salah." });
        }

        if (newPassword.length < 3) {
            return res.status(400).json({
                success: false,
                message: "Password baru tidak valid.",
            });
        }

        // update password
        await db.query(
            `UPDATE tkaryawan SET kar_password = ? WHERE kar_nama = ?`,
            [newPassword, user],
        );

        return res.json({
            success: true,
            message: "Perubahan password berhasil.",
            data: { forceLogout: true },
        });
    } catch (err) {
        console.error("CHANGE PASSWORD ERROR:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// Get nama karyawan
const getUser = async (req, res) => {
    const { cabang } = req.query;

    if (!cabang) {
        return res.status(400).json({
            success: false,
            message: "Parameter cabang wajib diisi",
        });
    }

    try {
        const [rows] = await db.query(
            `SELECT kar_nama, kar_cabang, kar_jabatan, sls_kode 
                FROM tkaryawan 
                WHERE kar_isaktif = 1 
                AND kar_jabatan = 'SALES' 
                AND kar_cabang = ?`,
            [cabang],
        );

        return res.json({
            success: true,
            count: rows.length,
            data: rows,
        });
    } catch (err) {
        console.error("ERROR GET SALES BY CABANG:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal mengambil data sales",
        });
    }
};

module.exports = {
    calonCustomer,
    updateCalonCustomerByKode,
    cariCustomer,
    getCabang,
    createVisitPlan,
    visitPlanById,
    updateVisitPlan,
    createVisit,
    getVisitFromPlan,
    getVisitDraft,
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
    getUser,
};
