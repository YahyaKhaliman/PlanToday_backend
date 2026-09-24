const db = require("../config/dbMain");

function safe(v, fallback = "-") {
    if (v === null || v === undefined) return fallback;
    const s = String(v).trim();
    return s.length ? s : fallback;
}

function getWIBDateTime() {
    const d = new Date();
    const utc = d.getTime() + d.getTimezoneOffset() * 60 * 1000;
    return new Date(utc + 3600000 * 7);
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

const calonCustomer = async ({ nama, alamat, cabang, telp, pic }) => {
    if (!nama) {
        return {
            status: 400,
            body: {
                success: false,
                message: "Nama customer wajib diisi",
            },
        };
    }

    const conn = await db.getConnection();

    try {
        await conn.beginTransaction();

        const [[{ max_kode }]] = await conn.query(
            `SELECT IFNULL(MAX(CAST(cus_kode AS UNSIGNED)), 0) AS max_kode
             FROM kencanaprint.tcustomer
             WHERE TRIM(IFNULL(cus_kode, '')) REGEXP '^[0-9]{1,5}$'`,
        );

        let nextKodeNum = Number(max_kode || 0) + 1;
        let ccKode = "";

        while (true) {
            ccKode = String(nextKodeNum).padStart(5, "0");

            const [cek] = await conn.query(
                "SELECT 1 FROM kencanaprint.tcustomer WHERE cus_kode = ?",
                [ccKode],
            );

            if (cek.length === 0) break;
            nextKodeNum++;
        }

        await conn.query(
            `INSERT INTO kencanaprint.tcustomer
             (cus_kode, cus_nama, cus_alamat, cus_kota, cus_telp, cus_cp, cus_aktif, user_create, date_create)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, NOW())`,
            [
                ccKode,
                nama,
                alamat || "",
                cabang || "",
                telp || "",
                pic || "",
                "PlanToday",
            ],
        );

        await conn.commit();

        return {
            status: 200,
            body: {
                success: true,
                message: "Calon customer berhasil disimpan",
                data: {
                    cc_id: nextKodeNum,
                    cc_kode: ccKode,
                },
            },
        };
    } catch (err) {
        await conn.rollback();
        console.error(err);
        return {
            status: 500,
            body: {
                success: false,
                message: "Gagal menyimpan calon customer",
            },
        };
    } finally {
        conn.release();
    }
};

const updateCalonCustomerByKode = async ({ cc_kode, body }) => {
    const cc_nama = String(body.cc_nama || "").trim();
    const cc_kota = String(body.cc_kota || "").trim();
    const cc_alamat = String(body.cc_alamat || "").trim();
    const cc_cp = String(body.cc_cp || "").trim();
    const cc_telp = String(body.cc_telp || "").trim();
    const cc_email = String(body.cc_email || "").trim();
    const cc_korporasi = String(body.cc_korporasi || "N").trim();
    const cc_jenisusaha = String(body.cc_jenisusaha || "").trim();
    const cc_npwp = String(body.cc_npwp || "").trim();
    const cc_nama_npwp = String(body.cc_nama_npwp || "").trim();
    const cc_alamat_npwp = String(body.cc_alamat_npwp || "").trim();
    const cc_kota_npwp = String(body.cc_kota_npwp || "").trim();

    if (!cc_kode) {
        return {
            status: 400,
            body: { success: false, message: "cc_kode tidak valid" },
        };
    }
    if (!cc_nama) {
        return {
            status: 400,
            body: { success: false, message: "cc_nama wajib diisi" },
        };
    }

    const [exist] = await db.query(
        `SELECT cus_kode FROM kencanaprint.tcustomer WHERE cus_kode = ? LIMIT 1`,
        [cc_kode],
    );

    if (!exist || exist.length === 0) {
        return {
            status: 404,
            body: { success: false, message: "Data tidak ditemukan" },
        };
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
        return {
            status: 200,
            body: {
                success: true,
                message: "Tidak ada perubahan",
                data: rows?.[0] || null,
            },
        };
    }

    return {
        status: 200,
        body: {
            success: true,
            message: "Berhasil update",
            data: rows?.[0] || null,
        },
    };
};

const getCabang = async ({ jabatan, nama }) => {
    const [cabang] = await db.query(
        `SELECT cabang AS nama FROM tcabang ORDER BY cbg_kode`,
    );

    return {
        user: nama,
        jabatan,
        cabang: cabang.map((c) => c.nama),
    };
};

const cariCustomer = async (search) => {
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
            cus_email                                  AS cc_email,
            'CUSTOMER'                                 AS sumber
        FROM kencanaprint.tcustomer
        WHERE cus_aktif = 1 AND (cus_nama LIKE ? OR cus_kode LIKE ?)
        ORDER BY cus_nama ASC
        LIMIT 50
        `,
        [like, like],
    );

    return rows;
};

const createVisitPlan = async ({ cus_kode, user, tanggal_plan, note }) => {
    if (!cus_kode)
        return {
            status: 400,
            body: { success: false, message: "Customer masih belum diisi" },
        };
    if (!user)
        return {
            status: 400,
            body: { success: false, message: "User wajib" },
        };
    if (!tanggal_plan)
        return {
            status: 400,
            body: { success: false, message: "tanggal_plan wajib" },
        };

    const nowWib = getWIBDateTime();
    const todayYmd = nowWib.toISOString().slice(0, 10);
    const currentHour = nowWib.getHours();

    if (tanggal_plan < todayYmd) {
        return {
            status: 400,
            body: {
                success: false,
                message:
                    "Tanggal rencana kunjungan tidak boleh kurang dari hari ini",
            },
        };
    }

    if (tanggal_plan === todayYmd && currentHour >= 8) {
        return {
            status: 400,
            body: {
                success: false,
                message:
                    "Rencana kunjungan untuk hari yang sama hanya dapat diinput sebelum jam 08:00 pagi",
            },
        };
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

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
            return {
                status: 400,
                body: {
                    success: false,
                    message: "Plan sudah ada",
                },
            };
        }

        const [countRows] = await conn.query(
            `SELECT COUNT(*) as count FROM tkunjungan WHERE user = ? AND DATE(tanggal_plan) = ?`,
            [user, tanggal_plan],
        );

        if (countRows && countRows[0] && countRows[0].count >= 8) {
            await conn.rollback();
            return {
                status: 400,
                body: {
                    success: false,
                    message:
                        "Batas maksimal rencana kunjungan (visit plan) adalah 8 per hari",
                },
            };
        }

        const [ins] = await conn.query(
            `
            INSERT INTO tkunjungan (cus_kode, user, note, tanggal_plan, realisasi)
            VALUES (?, ?, ?, CONCAT(?, ' 00:00:00'), 'N')
            `,
            [cus_kode, user, note, tanggal_plan],
        );

        await conn.commit();
        return {
            status: 200,
            body: {
                success: true,
                message: "Simpan Berhasil",
                data: { id: ins.insertId, isUpdate: false },
            },
        };
    } catch (err) {
        await conn.rollback();
        console.error("CREATE VISIT PLAN ERROR:", err);
        return {
            status: 500,
            body: { success: false, message: err.sqlMessage || err.message },
        };
    } finally {
        conn.release();
    }
};

const visitPlanById = async ({ user, tanggal, cus_kode }) => {
    const [rows] = await db.query(
        `
        SELECT
            k.id,
            DATE(k.tanggal_plan) AS tanggal_plan,
            DATE(k.tanggal) AS tanggal_visit,
            k.cus_kode,
            k.note,
            k.catatan,
            k.realisasi,
            c.cus_nama AS cc_nama,
            c.cus_alamat AS cc_alamat,
            c.cus_kota AS cc_kota
        FROM tkunjungan k
        LEFT JOIN kencanaprint.tcustomer c ON c.cus_kode = k.cus_kode AND c.cus_aktif = 1
        WHERE k.user = ?
            AND DATE(k.tanggal_plan) = ?
            AND k.cus_kode = ?
        ORDER BY (k.realisasi = 'Y') DESC, k.id DESC
        LIMIT 1
        `,
        [user, tanggal, cus_kode],
    );

    return rows?.[0] || null;
};

const updateVisitPlan = async ({ id, tanggal_plan, note, catatan }) => {
    if (!id) {
        return {
            status: 400,
            body: { success: false, message: "ID tidak valid" },
        };
    }

    if (!tanggal_plan) {
        return {
            status: 400,
            body: { success: false, message: "tanggal_plan wajib diisi" },
        };
    }

    const [planRows] = await db.query(
        `SELECT user, cus_kode, DATE_FORMAT(tanggal_plan, '%Y-%m-%d') as current_tgl FROM tkunjungan WHERE id = ?`,
        [id],
    );
    if (planRows.length === 0) {
        return {
            status: 404,
            body: { success: false, message: "Data tidak ditemukan" },
        };
    }

    const planUser = planRows[0].user;
    const currentTgl = planRows[0].current_tgl;
    const newTgl = String(tanggal_plan).trim().slice(0, 10);

    if (currentTgl !== newTgl) {
        const planCusKode = planRows[0].cus_kode;

        const [dupRows] = await db.query(
            `SELECT id FROM tkunjungan WHERE user = ? AND cus_kode = ? AND DATE(tanggal_plan) = ? LIMIT 1`,
            [planUser, planCusKode, newTgl],
        );

        if (dupRows.length > 0) {
            return {
                status: 400,
                body: {
                    success: false,
                    message: "Plan sudah ada",
                },
            };
        }

        const nowWib = getWIBDateTime();
        const todayYmd = nowWib.toISOString().slice(0, 10);
        const currentHour = nowWib.getHours();

        if (newTgl < todayYmd) {
            return {
                status: 400,
                body: {
                    success: false,
                    message:
                        "Tanggal rencana kunjungan tidak boleh kurang dari hari ini",
                },
            };
        }

        if (newTgl === todayYmd && currentHour >= 8) {
            return {
                status: 400,
                body: {
                    success: false,
                    message:
                        "Rencana kunjungan untuk hari yang sama hanya dapat diinput sebelum jam 08:00 pagi",
                },
            };
        }

        const [countRows] = await db.query(
            `SELECT COUNT(*) as count FROM tkunjungan WHERE user = ? AND DATE(tanggal_plan) = ?`,
            [planUser, newTgl],
        );

        if (countRows && countRows[0] && countRows[0].count >= 8) {
            return {
                status: 400,
                body: {
                    success: false,
                    message:
                        "Batas maksimal rencana kunjungan (visit plan) adalah 8 per hari pada tanggal target",
                },
            };
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
        return {
            status: 404,
            body: { success: false, message: "Data tidak ditemukan" },
        };
    }

    return {
        status: 200,
        body: {
            success: true,
            message: "Update Visit Plan Berhasil",
            data: { id: Number(id) },
        },
    };
};

const createVisit = async ({ user, cus_kode, tanggal, note, catatan, latitude, longitude }) => {
    if (!user || !cus_kode || !tanggal) {
        return {
            status: 400,
            body: { success: false, message: "user, cus_kode, tanggal wajib" },
        };
    }

    const nowWib = getWIBDateTime();
    const todayYmd = nowWib.toISOString().slice(0, 10);
    if (tanggal.slice(0, 10) < todayYmd) {
        return {
            status: 400,
            body: {
                success: false,
                message: "Tanggal kunjungan tidak boleh kurang dari hari ini",
            },
        };
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

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
            return {
                status: 200,
                body: {
                    success: true,
                    message: "Visit tersimpan (UPDATE dari plan)",
                    data: { id: draftId },
                },
            };
        }

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
        return {
            status: 200,
            body: {
                success: true,
                message: "Visit tersimpan (CREATE)",
                data: { id: result.insertId },
            },
        };
    } catch (err) {
        await conn.rollback();
        console.error("CREATE VISIT UPSERT ERROR:", err);
        return {
            status: 500,
            body: { success: false, message: err.message },
        };
    } finally {
        conn.release();
    }
};

const getVisitFromPlan = async ({ user, cus_kode, tanggal }) => {
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
        LEFT JOIN kencanaprint.tcustomer c ON c.cus_kode = k.cus_kode AND c.cus_aktif = 1
        WHERE k.user = ?
            AND k.cus_kode = ?
            AND DATE(k.tanggal_plan) = ?
        ORDER BY (k.realisasi='Y') DESC, k.id DESC
        LIMIT 1
        `,
        [user, cus_kode, tanggal],
    );

    return rows?.[0] || null;
};

const getVisitDraft = async ({ user, cus_kode, tanggal }) => {
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

    return rows?.[0] || null;
};

const updateVisit = async ({ id, note, catatan, tanggal, latitude, longitude }) => {
    if (!id) {
        return {
            status: 400,
            body: {
                success: false,
                message: "ID kunjungan tidak valid",
            },
        };
    }

    if (tanggal) {
        const nowWib = getWIBDateTime();
        const todayYmd = nowWib.toISOString().slice(0, 10);
        if (tanggal.slice(0, 10) < todayYmd) {
            return {
                status: 400,
                body: {
                    success: false,
                    message: "Tanggal kunjungan tidak boleh kurang dari hari ini",
                },
            };
        }
    }

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

    return {
        status: 200,
        body: {
            success: true,
            message: "Update Berhasil",
            data: { id: Number(id) },
        },
    };
};

const uploadVisitPhoto = async ({ id, file }) => {
    if (!id)
        return {
            status: 400,
            body: { success: false, message: "ID visit tidak valid" },
        };
    if (!file)
        return {
            status: 400,
            body: {
                success: false,
                message: "File foto tidak ditemukan (req.file kosong)",
            },
        };

    const relativePath = `/uploads/visits/${file.filename}`;
    await db.query(`UPDATE tkunjungan SET foto = ? WHERE id = ?`, [
        relativePath,
        id,
    ]);

    return {
        status: 200,
        body: {
            success: true,
            message: "Foto berhasil disimpan ke server dan database",
            data: { id: Number(id), filename: file.filename },
        },
    };
};

const getRekapVisit = async ({ user, start, end, cabang, publicBaseUrl }) => {
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
        LEFT JOIN kencanaprint.tcustomer b ON b.cus_kode = a.cus_kode AND b.cus_aktif = 1
        LEFT JOIN tkaryawan k ON k.kar_nama = a.user AND k.kar_isaktif = 1
        WHERE a.user = ?
        AND a.realisasi = 'Y'
        AND DATE(a.tanggal) >= ?
        AND DATE(a.tanggal) <= ?
        `;

    const params = [publicBaseUrl, user, start, end];

    if (cabang) {
        sql += ` AND UPPER(k.kar_cabang) = ?`;
        params.push(cabang);
    }

    sql += ` ORDER BY a.tanggal DESC, a.id DESC`;

    const [rows] = await db.query(sql, params);
    return rows;
};

const rekapVisitWA = async ({ user, start, end, cabang }) => {
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
    INNER JOIN kencanaprint.tcustomer ca ON ca.cus_kode = ku.cus_kode AND ca.cus_aktif = 1
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
        return "";
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

    return text;
};

const updateRekapVisit = async ({ id, note }) => {
    await db.query("UPDATE tkunjungan SET note = ? WHERE id = ?", [
        note,
        id,
    ]);
};

const getRekapVisitPlan = async ({
    user,
    cabang,
    tanggal_awal,
    tanggal_akhir,
    isManagerMode,
    publicBaseUrl,
}) => {
    let sql = "";
    let params = [];

    if (isManagerMode) {
        sql = `
        WITH pick AS (
            SELECT
                cus_kode,
                DATE(tanggal_plan) AS tgl,
                user,
                MAX(id) AS pick_id
            FROM tkunjungan
            WHERE DATE(tanggal_plan) BETWEEN ? AND ?
            GROUP BY cus_kode, DATE(tanggal_plan), user
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
            k.user AS sales_name,
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
        LEFT JOIN kencanaprint.tcustomer c ON c.cus_kode = k.cus_kode AND c.cus_aktif = 1
        INNER JOIN tkaryawan ka ON ka.kar_nama = k.user AND ka.kar_isaktif = 1
        WHERE ka.kar_jabatan = 'SALES'
        `;
        params = [tanggal_awal, tanggal_akhir, publicBaseUrl];
    } else {
        sql = `
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
            k.user AS sales_name,
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
        LEFT JOIN kencanaprint.tcustomer c ON c.cus_kode = k.cus_kode AND c.cus_aktif = 1
        INNER JOIN tkaryawan ka ON ka.kar_nama = k.user AND ka.kar_isaktif = 1
        WHERE k.user = ?
        `;
        params = [
            user,
            tanggal_awal,
            tanggal_akhir,
            publicBaseUrl,
            user,
        ];

        if (cabang) {
            sql += ` AND ka.kar_cabang = ?`;
            params.push(cabang);
        }
    }

    sql += ` ORDER BY DATE(k.tanggal_plan) DESC, k.id DESC`;

    const [rows] = await db.query(sql, params);
    return rows || [];
};

const rekapVisitPlanWA = async ({ user, start, end, cabang }) => {
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
    LEFT JOIN kencanaprint.tcustomer c ON c.cus_kode = k.cus_kode AND c.cus_aktif = 1
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
        return "";
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
        text += `*Keperluan:* ${safe(it.catatan)}\n`;

        if (it.catatan && String(it.catatan).trim().length) {
            text += `*Catatan:* ${safe(it.note)}\n`;
        }

        text += `*Status:* ${String(it.realisasi) === "Y" ? "Done" : "Belum"}\n`;
        text += `_____________________\n`;
    });

    return text;
};

const getRekapCalonCustomer = async ({ cabang, cc_nama, limit }) => {
    let query = `
      SELECT
          cus_kode  AS id,
          cus_kode  AS cc_kode,
          cus_nama  AS cc_nama,
          cus_alamat AS cc_alamat,
          cus_cp    AS cc_cp,
          cus_telp  AS cc_telp,
          cus_kota  AS cc_kota,
            CASE
                WHEN cus_email IS NULL OR TRIM(cus_email) = '' OR cus_email = '-'
                THEN '-'
                ELSE cus_email
            END AS cc_email,
          cus_korporasi AS cc_korporasi,
          cus_jenisusaha AS cc_jenisusaha,
          cus_npwp  AS cc_npwp,
          cus_nama_npwp AS cc_nama_npwp,
          cus_alamat_npwp AS cc_alamat_npwp,
          cus_kota_npwp AS cc_kota_npwp
      FROM kencanaprint.tcustomer
    WHERE cus_aktif = 1
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

    const safeLimit = Math.min(Number(limit || 200), 1000);
    if (!cabang || String(cabang).trim() === "") {
        query += ` LIMIT ?`;
        params.push(safeLimit);
    }

    const [rows] = await db.query(query, params);
    return rows;
};

const rekapCalonCustomerWA = async ({ cabang, keyword }) => {
    const MAX_WA_ROWS = 10;
    const like = `%${keyword}%`;
    const cab = String(cabang || "").trim();

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
    WHERE cus_aktif = 1 AND cus_nama LIKE ?
    ${cab ? "AND cus_kota = ?" : ""}
    ORDER BY cus_nama ASC
    LIMIT ${MAX_WA_ROWS}
    `;

    const params = cab ? [like, cab] : [like];
    const [rows] = await db.query(query, params);

    if (!rows || rows.length === 0) {
        return "";
    }

    const cabangLabel = cab ? cab : "SEMUA";

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

    return text;
};

const gantiPassword = async ({ user, oldPassword, newPassword }) => {
    if (!user) {
        return {
            status: 400,
            body: { success: false, message: "User belum ada (login dulu)" },
        };
    }

    if (
        !oldPassword ||
        oldPassword.length < 3 ||
        !newPassword ||
        newPassword.length < 3
    ) {
        return {
            status: 400,
            body: { success: false, message: "Data belum lengkap." },
        };
    }

    const [rows] = await db.query(
        `SELECT kar_password 
        FROM tkaryawan 
        WHERE kar_isaktif = 1 AND kar_nama = ?
        LIMIT 1`,
        [user],
    );

    if (!rows || rows.length === 0) {
        return {
            status: 404,
            body: {
                success: false,
                message: "User tidak ditemukan / tidak aktif",
            },
        };
    }

    const currentPassword = rows[0].kar_password;

    if (oldPassword !== currentPassword) {
        return {
            status: 400,
            body: { success: false, message: "Password lama salah." },
        };
    }

    if (newPassword.length < 3) {
        return {
            status: 400,
            body: {
                success: false,
                message: "Password baru tidak valid.",
            },
        };
    }

    await db.query(
        `UPDATE tkaryawan SET kar_password = ? WHERE kar_nama = ?`,
        [newPassword, user],
    );

    return {
        status: 200,
        body: {
            success: true,
            message: "Perubahan password berhasil.",
            data: { forceLogout: true },
        },
    };
};

const getUserByCabang = async (cabang) => {
    const [rows] = await db.query(
        `SELECT kar_nama, kar_cabang, kar_jabatan, sls_kode 
            FROM tkaryawan 
            WHERE kar_isaktif = 1 
            AND kar_jabatan = 'SALES' 
            AND kar_cabang = ?`,
        [cabang],
    );

    return rows;
};

module.exports = {
    calonCustomer,
    updateCalonCustomerByKode,
    getCabang,
    cariCustomer,
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
    getUserByCabang,
};
