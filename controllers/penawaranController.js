const db = require("../config/dbPenawaran");

const normalizeDate = (value) => {
    if (!value) return null;
    const s = String(value).trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    return s;
};

const getCurrentMonthRange = () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const toYmd = (d) => {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd}`;
    };

    return { start: toYmd(start), end: toYmd(end) };
};

const buildStatusCondition = (status) => {
    const normalized = String(status || "ALL")
        .trim()
        .toUpperCase();

    if (normalized === "OPEN") {
        return {
            label: "OPEN",
        };
    }

    if (normalized === "BATAL" || normalized === "CLOSE") {
        return {
            label: normalized,
            value: normalized,
        };
    }

    return {
        label: "ALL",
    };
};

const toNumber = (value, fallback = 0) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
};

const normalizeApprovalState = (value) =>
    String(value || "")
        .trim()
        .toUpperCase();

const getLatestApprovalState = async (conn, nomor) => {
    const [rows] = await conn.query(
        `
        SELECT COALESCE(
            IF(pin_acc = '' AND pin_dipakai = '', 'WAIT',
                IF(pin_acc = 'Y' AND pin_dipakai = '', 'ACC',
                    IF(pin_acc = 'N', 'TOLAK', '')
                )
            ),
        '') AS approval_state
        FROM tspk_pin5
        WHERE pin_trs = 'PENAWARAN'
          AND pin_nomor = ?
        ORDER BY pin_urut DESC
        LIMIT 1
        `,
        [nomor],
    );

    return normalizeApprovalState(rows?.[0]?.approval_state);
};

const getNextPinUrut = async (conn, pinTrs, nomor) => {
    const [rows] = await conn.query(
        `
        SELECT COALESCE(MAX(pin_urut), 0) + 1 AS next_urut
        FROM tspk_pin5
        WHERE pin_trs = ? AND pin_nomor = ?
        `,
        [pinTrs, nomor],
    );
    return toNumber(rows?.[0]?.next_urut, 1);
};

const writeStatusAuditLog = async ({ conn, nomor, user, changes }) => {
    if (!Array.isArray(changes) || changes.length === 0) return;

    const pinUrut = await getNextPinUrut(conn, "PENAWARAN_STATUS", nomor);
    const payload = JSON.stringify({ changes });

    await conn.query(
        `
        INSERT INTO tspk_pin5 (
            pin_trs,
            pin_nomor,
            pin_urut,
            pin_program,
            pin_tgl_trs,
            pin_ket,
            pin_tgl_minta,
            pin_user_minta,
            pin_acc,
            pin_dipakai,
            pin_alasan
        ) VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, '', '', '')
        `,
        [
            "PENAWARAN_STATUS",
            nomor,
            pinUrut,
            "MOBILE",
            new Date(),
            payload,
            String(user || "MOBILE").slice(0, 10),
        ],
    );
};

const SCHEMA_CACHE_TTL_MS = 60 * 1000;
let schemaCache = {
    checkedAt: 0,
    tables: new Set(),
};

const getAvailableTables = async () => {
    const now = Date.now();
    if (now - schemaCache.checkedAt < SCHEMA_CACHE_TTL_MS) {
        return schemaCache.tables;
    }

    const [rows] = await db.query("SHOW TABLES");
    const tableSet = new Set(
        rows.map((row) => String(Object.values(row)[0] || "").toLowerCase()),
    );

    schemaCache = {
        checkedAt: now,
        tables: tableSet,
    };

    return tableSet;
};

const ensurePenawaranSchema = async (res) => {
    const requiredTables = [
        "tpenawaran_hdr",
        "tpenawaran_dtl",
        "tcustomer",
        "tperusahaan",
    ];
    const tableSet = await getAvailableTables();
    const missingTables = requiredTables.filter(
        (t) => !tableSet.has(String(t).toLowerCase()),
    );

    if (missingTables.length === 0) {
        return true;
    }

    res.status(503).json({
        success: false,
        message:
            "Fitur Penawaran belum siap: tabel utama belum tersedia di database aktif",
        database:
            process.env.DB_NAME_PENAWARAN ||
            process.env.DB_NAME_MAIN ||
            "(unknown)",
        missingTables,
    });
    return false;
};

const getNextPenawaranNumber = async (conn, perusahaanKode, tahun) => {
    const [rows] = await conn.query(
        `
        SELECT IFNULL(MAX(LEFT(pen_nomor, 5)), 0) AS jumlah
        FROM tpenawaran_hdr
        WHERE RIGHT(pen_nomor, 7) = ?
          AND SUBSTR(pen_nomor, 4, 1) <> '/'
        `,
        [`${perusahaanKode}/${tahun}`],
    );

    const last = toNumber(rows?.[0]?.jumlah, 0);
    const next = String(100001 + last).slice(-5);
    return `${next}/${perusahaanKode}/${tahun}`;
};

const getPenawaranList = async (req, res) => {
    try {
        const schemaReady = await ensurePenawaranSchema(res);
        if (!schemaReady) return;

        const monthRange = getCurrentMonthRange();
        const startDate =
            normalizeDate(req.query.startDate) || monthRange.start;
        const endDate = normalizeDate(req.query.endDate) || monthRange.end;
        const search = String(req.query.search || "").trim();
        const statusInfo = buildStatusCondition(req.query.status);
        const limit = Math.min(
            Math.max(Number(req.query.limit) || 100, 1),
            300,
        );

        const params = [];
        let statusCountParam = "";
        let existsParam = "";

        if (statusInfo.value) {
            statusCountParam = " AND COALESCE(d.pend_status, '') = ?";
            existsParam = " AND COALESCE(d.pend_status, '') = ?";
            // Placeholder pertama muncul di subquery detail_count
            params.push(statusInfo.value);
        }

        // Placeholder tanggal muncul setelah subquery detail_count
        params.push(startDate, endDate);

        if (statusInfo.value) {
            // Placeholder status kedua muncul di EXISTS clause
            params.push(statusInfo.value);
        }

        let searchSql = "";
        if (search) {
            searchSql = `
            AND (
                h.pen_nomor LIKE ?
                OR c.cus_nama LIKE ?
                OR p.perush_nama LIKE ?
                OR COALESCE(s.sal_nama, '') LIKE ?
            )`;
            const like = `%${search}%`;
            params.push(like, like, like, like);
        }

        params.push(limit);

        const sql = `
        SELECT
            h.pen_nomor AS nomor,
            DATE_FORMAT(h.pen_tanggal, '%Y-%m-%d') AS tanggal,
            COALESCE(v.divisi, '') AS divisi,
            COALESCE(h.pen_tipe, '') AS tipe,
            COALESCE(p.perush_nama, '') AS perusahaan,
            COALESCE(c.cus_nama, '') AS customer,
            COALESCE(s.sal_nama, '') AS sales,
            COALESCE(h.pen_keterangan, '') AS keterangan,
            COALESCE(h.pen_fu1, '') AS fu1,
            COALESCE(h.pen_fu2, '') AS fu2,
            COALESCE(h.pen_fu3, '') AS fu3,
            COALESCE(h.pen_proyeksi, '') AS proyeksi,
            IF(
                h.pen_cetaktotal = 1,
                COALESCE((SELECT SUM(d.pend_qty * d.pend_harga) FROM tpenawaran_dtl d WHERE d.pend_pen_nomor = h.pen_nomor), 0),
                COALESCE((SELECT MIN(d.pend_qty * d.pend_harga) FROM tpenawaran_dtl d WHERE d.pend_pen_nomor = h.pen_nomor AND (d.pend_qty * d.pend_harga) > 0), 0)
            ) AS nominal,
            (
                SELECT COUNT(*)
                FROM tpenawaran_dtl d
                WHERE d.pend_pen_nomor = h.pen_nomor ${statusCountParam}
            ) AS detail_count,
            COALESCE((
                SELECT IFNULL(
                    IF(pin_acc = '' AND pin_dipakai = '', 'WAIT',
                        IF(pin_acc = 'Y' AND pin_dipakai = '', 'ACC',
                            IF(pin_acc = 'N', 'TOLAK', '')
                        )
                    ),
                '')
                FROM tspk_pin5
                WHERE pin_trs = 'PENAWARAN' AND pin_nomor = h.pen_nomor
                ORDER BY pin_urut DESC
                LIMIT 1
            ), '') AS approval_state
        FROM tpenawaran_hdr h
        INNER JOIN tcustomer c ON c.cus_kode = h.pen_cus_kode
        INNER JOIN tperusahaan p ON p.perush_kode = h.pen_perush_kode
        LEFT JOIN tsales s ON s.sal_kode = h.pen_sal_kode
        LEFT JOIN tdivisi v ON v.kode = h.pen_divisi
        WHERE h.pen_tanggal >= ?
          AND h.pen_tanggal <= ?
          AND EXISTS (
              SELECT 1
              FROM tpenawaran_dtl d
              WHERE d.pend_pen_nomor = h.pen_nomor
              ${existsParam}
          )
          ${searchSql}
        ORDER BY h.pen_tanggal DESC, h.pen_nomor DESC
        LIMIT ?`;

        const [rows] = await db.query(sql, params);

        return res.json({
            success: true,
            data: rows,
            meta: {
                startDate,
                endDate,
                status: statusInfo.label,
                count: rows.length,
            },
        });
    } catch (err) {
        console.error("GET PENAWARAN LIST ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengambil data penawaran",
        });
    }
};

const getPenawaranDetail = async (req, res) => {
    try {
        const schemaReady = await ensurePenawaranSchema(res);
        if (!schemaReady) return;

        const nomor = String(req.params.nomor || "").trim();

        if (!nomor) {
            return res.status(400).json({
                success: false,
                message: "Nomor penawaran tidak valid",
            });
        }

        const [headerRows] = await db.query(
            `
            SELECT
                h.pen_nomor AS nomor,
                DATE_FORMAT(h.pen_tanggal, '%Y-%m-%d') AS tanggal,
                COALESCE(h.pen_divisi, '') AS divisi,
                COALESCE(v.divisi, '') AS divisi_nama,
                COALESCE(h.pen_tipe, '') AS tipe,
                COALESCE(h.pen_perush_kode, '') AS perusahaan_kode,
                COALESCE(p.perush_nama, '') AS perusahaan,
                COALESCE(h.pen_cus_kode, '') AS customer_kode,
                COALESCE(c.cus_nama, '') AS customer,
                COALESCE(c.cus_alamat, '') AS customer_alamat,
                COALESCE(c.cus_kota, '') AS customer_kota,
                COALESCE(h.pen_sal_kode, '') AS sales_kode,
                COALESCE(s.sal_nama, '') AS sales,
                COALESCE(h.pen_keterangan, '') AS keterangan,
                COALESCE(h.pen_note, '') AS note,
                COALESCE(h.pen_rekening, '') AS rekening,
                COALESCE(h.pen_dpper, 0) AS dp_per,
                COALESCE(h.pen_ttd, '') AS ttd,
                COALESCE(h.pen_ttd_jabatan, '') AS ttd_jabatan,
                COALESCE(h.pen_up, '') AS up,
                COALESCE(h.pen_marketing, '') AS marketing,
                COALESCE(h.pen_marketing_telp, '') AS marketing_telp,
                COALESCE(h.pen_status_harga, 0) AS status_harga,
                COALESCE(h.pen_cetaktotal, 0) AS cetak_total,
                COALESCE(h.pen_panjang, 0) AS panjang,
                COALESCE(h.pen_lebar, 0) AS lebar,
                COALESCE(h.pen_tambahan, '') AS tambahan,
                COALESCE(h.pen_fu1, '') AS fu1,
                COALESCE(h.pen_fu2, '') AS fu2,
                COALESCE(h.pen_fu3, '') AS fu3,
                COALESCE(h.pen_proyeksi, '') AS proyeksi,
                COALESCE(h.pen_mx, '') AS mx,
                COALESCE(h.pen_digitalsign, '') AS digital_sign,
                IF(
                    h.pen_cetaktotal = 1,
                    COALESCE((SELECT SUM(d.pend_qty * d.pend_harga) FROM tpenawaran_dtl d WHERE d.pend_pen_nomor = h.pen_nomor), 0),
                    COALESCE((SELECT MIN(d.pend_qty * d.pend_harga) FROM tpenawaran_dtl d WHERE d.pend_pen_nomor = h.pen_nomor AND (d.pend_qty * d.pend_harga) > 0), 0)
                ) AS nominal,
                COALESCE((
                    SELECT IFNULL(
                        IF(pin_acc = '' AND pin_dipakai = '', 'WAIT',
                            IF(pin_acc = 'Y' AND pin_dipakai = '', 'ACC',
                                IF(pin_acc = 'N', 'TOLAK', '')
                            )
                        ),
                    '')
                    FROM tspk_pin5
                    WHERE pin_trs = 'PENAWARAN' AND pin_nomor = h.pen_nomor
                    ORDER BY pin_urut DESC
                    LIMIT 1
                ), '') AS approval_state
            FROM tpenawaran_hdr h
            INNER JOIN tcustomer c ON c.cus_kode = h.pen_cus_kode
            INNER JOIN tperusahaan p ON p.perush_kode = h.pen_perush_kode
            LEFT JOIN tsales s ON s.sal_kode = h.pen_sal_kode
            LEFT JOIN tdivisi v ON v.kode = h.pen_divisi
            WHERE h.pen_nomor = ?
            LIMIT 1
            `,
            [nomor],
        );

        if (!headerRows || headerRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Data penawaran tidak ditemukan",
            });
        }

        const [detailRows] = await db.query(
            `
            SELECT
                pend_id AS id,
                pend_urutan AS urutan,
                COALESCE(pend_minta, '') AS minta,
                COALESCE(pend_nama_barang, '') AS nama_barang,
                COALESCE(pend_bahan, '') AS bahan,
                COALESCE(pend_ukuran, '') AS ukuran,
                COALESCE(pend_panjang, 0) AS panjang,
                COALESCE(pend_lebar, 0) AS lebar,
                COALESCE(pend_satuan, '') AS satuan,
                COALESCE(pend_qty, 0) AS qty,
                COALESCE(pend_harga, 0) AS harga,
                (COALESCE(pend_qty, 0) * COALESCE(pend_harga, 0)) AS total,
                COALESCE(pend_status, '') AS status,
                COALESCE(pend_batal, '') AS ket_batal,
                COALESCE(pend_confirm, '') AS ket_confirm,
                COALESCE(pend_gambar, '') AS gambar
            FROM tpenawaran_dtl
            WHERE pend_pen_nomor = ?
            ORDER BY pend_urutan, pend_id
            `,
            [nomor],
        );

        return res.json({
            success: true,
            data: {
                header: headerRows[0],
                details: detailRows,
            },
        });
    } catch (err) {
        console.error("GET PENAWARAN DETAIL ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengambil detail penawaran",
        });
    }
};

const createPenawaran = async (req, res) => {
    let conn;

    try {
        const schemaReady = await ensurePenawaranSchema(res);
        if (!schemaReady) return;

        conn = await db.getConnection();

        const body = req.body || {};
        const tanggal =
            normalizeDate(body.tanggal) ||
            normalizeDate(new Date().toISOString());
        const divisi = String(body.divisi || "1").trim();
        const tipe = String(body.tipe || "Medium").trim() || "Medium";
        const perusahaanKode = String(body.perusahaan_kode || "").trim();
        const customerKode = String(body.customer_kode || "").trim();
        const salesKode = String(body.sales_kode || "").trim();
        const keterangan = String(body.keterangan || "").trim();
        const note = String(body.note || "").trim();
        const userCreate =
            String(body.user || body.user_create || "MOBILE").trim() ||
            "MOBILE";
        const details = Array.isArray(body.details) ? body.details : [];

        if (!tanggal) {
            return res
                .status(400)
                .json({ success: false, message: "Tanggal tidak valid" });
        }
        if (!perusahaanKode) {
            return res
                .status(400)
                .json({ success: false, message: "Perusahaan wajib diisi" });
        }
        if (!customerKode) {
            return res
                .status(400)
                .json({ success: false, message: "Customer wajib diisi" });
        }
        if (!salesKode) {
            return res
                .status(400)
                .json({ success: false, message: "Sales wajib diisi" });
        }
        if (details.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Detail item minimal 1 baris",
            });
        }

        for (let i = 0; i < details.length; i += 1) {
            const d = details[i] || {};
            const nama = String(d.nama_barang || "").trim();
            const qty = toNumber(d.qty, 0);
            if (!nama) {
                return res.status(400).json({
                    success: false,
                    message: `Nama barang baris ke-${i + 1} wajib diisi`,
                });
            }
            if (qty <= 0) {
                return res.status(400).json({
                    success: false,
                    message: `Qty baris ke-${i + 1} harus lebih dari 0`,
                });
            }
        }

        await conn.beginTransaction();

        const tahun = Number(String(tanggal).slice(0, 4));
        const nomor = await getNextPenawaranNumber(conn, perusahaanKode, tahun);

        await conn.query(
            `
            INSERT INTO tpenawaran_hdr (
                pen_nomor,
                pen_divisi,
                pen_tanggal,
                pen_tipe,
                pen_perush_kode,
                pen_cus_kode,
                pen_sal_kode,
                pen_keterangan,
                pen_note,
                pen_rekening,
                pen_dpper,
                pen_status_harga,
                pen_ttd,
                pen_ttd_jabatan,
                pen_up,
                pen_marketing,
                pen_marketing_telp,
                pen_cetaktotal,
                pen_panjang,
                pen_lebar,
                pen_tambahan,
                pen_fu1,
                pen_fu2,
                pen_fu3,
                pen_proyeksi,
                date_create,
                user_create,
                pen_mx,
                pen_digitalsign
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)
            `,
            [
                nomor,
                divisi,
                tanggal,
                tipe,
                perusahaanKode,
                customerKode,
                salesKode,
                keterangan,
                note,
                "",
                0,
                0,
                "",
                "",
                "",
                "",
                "",
                1,
                0,
                0,
                "",
                "",
                "",
                "",
                "",
                userCreate,
                "N",
                "N",
            ],
        );

        for (let i = 0; i < details.length; i += 1) {
            const d = details[i] || {};
            const urutan = i + 1;
            const id = String(d.id || String(urutan).padStart(2, "0")).slice(
                0,
                2,
            );

            await conn.query(
                `
                INSERT INTO tpenawaran_dtl (
                    pend_urutan,
                    pend_pen_nomor,
                    pend_minta,
                    pend_nama_barang,
                    pend_bahan,
                    pend_ukuran,
                    pend_panjang,
                    pend_lebar,
                    pend_satuan,
                    pend_qty,
                    pend_harga,
                    pend_gambar,
                    pend_status,
                    pend_batal,
                    pend_confirm,
                    pend_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                [
                    urutan,
                    nomor,
                    String(d.minta || "").trim(),
                    String(d.nama_barang || "").trim(),
                    String(d.bahan || "").trim(),
                    String(d.ukuran || "").trim(),
                    toNumber(d.panjang, 0),
                    toNumber(d.lebar, 0),
                    String(d.satuan || "PCS").trim() || "PCS",
                    toNumber(d.qty, 0),
                    toNumber(d.harga, 0),
                    "",
                    "",
                    "",
                    "",
                    id,
                ],
            );
        }

        await conn.commit();

        return res.status(201).json({
            success: true,
            message: "Penawaran berhasil dibuat",
            data: {
                nomor,
            },
        });
    } catch (err) {
        if (conn) {
            await conn.rollback();
        }
        console.error("CREATE PENAWARAN ERROR:", err);
        return res.status(500).json({
            success: false,
            message: err.sqlMessage || err.message || "Gagal membuat penawaran",
        });
    } finally {
        if (conn) {
            conn.release();
        }
    }
};

const getMasterPerusahaan = async (req, res) => {
    try {
        const schemaReady = await ensurePenawaranSchema(res);
        if (!schemaReady) return;

        const search = String(req.query.search || "").trim();
        const like = `%${search}%`;

        const [rows] = await db.query(
            `
            SELECT
                p.perush_kode AS kode,
                p.perush_nama AS nama,
                COALESCE(p.perush_alamat, '') AS alamat
            FROM tperusahaan p
            INNER JOIN tpenawaran_hdr h ON h.pen_perush_kode = p.perush_kode
            WHERE (? = '' OR p.perush_kode LIKE ? OR p.perush_nama LIKE ?)
            GROUP BY p.perush_kode, p.perush_nama, p.perush_alamat
            ORDER BY p.perush_nama ASC
            LIMIT 50
            `,
            [search, like, like],
        );

        return res.json({
            success: true,
            data: rows,
        });
    } catch (err) {
        console.error("GET MASTER PERUSAHAAN ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengambil data perusahaan",
        });
    }
};

const getMasterSales = async (req, res) => {
    try {
        const schemaReady = await ensurePenawaranSchema(res);
        if (!schemaReady) return;

        const search = String(req.query.search || "").trim();
        const like = `%${search}%`;

        const [rows] = await db.query(
            `
            SELECT
                s.sal_kode AS kode,
                s.sal_nama AS nama,
                COALESCE(s.sal_alamat, '') AS alamat
            FROM tsales s
            INNER JOIN tpenawaran_hdr h ON h.pen_sal_kode = s.sal_kode
            WHERE COALESCE(s.sal_aktif, 'Y') <> 'N'
              AND (? = '' OR s.sal_kode LIKE ? OR s.sal_nama LIKE ?)
            GROUP BY s.sal_kode, s.sal_nama, s.sal_alamat
            ORDER BY s.sal_nama ASC
            LIMIT 50
            `,
            [search, like, like],
        );

        return res.json({
            success: true,
            data: rows,
        });
    } catch (err) {
        console.error("GET MASTER SALES ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage || err.message || "Gagal mengambil data sales",
        });
    }
};

const updatePenawaranStatusDetail = async (req, res) => {
    let conn;

    try {
        const schemaReady = await ensurePenawaranSchema(res);
        if (!schemaReady) return;

        conn = await db.getConnection();
        const nomor = String(req.params.nomor || "").trim();
        const updates = Array.isArray(req.body.updates) ? req.body.updates : [];

        if (!nomor) {
            return res.status(400).json({
                success: false,
                message: "Nomor penawaran tidak valid",
            });
        }

        if (updates.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Tidak ada item status yang diubah",
            });
        }

        await conn.beginTransaction();

        const [headerRows] = await conn.query(
            `SELECT pen_nomor FROM tpenawaran_hdr WHERE pen_nomor = ? LIMIT 1`,
            [nomor],
        );

        if (!headerRows || headerRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({
                success: false,
                message: "Penawaran tidak ditemukan",
            });
        }

        const approvalState = await getLatestApprovalState(conn, nomor);
        if (approvalState === "WAIT") {
            await conn.rollback();
            return res.status(409).json({
                success: false,
                message:
                    "Penawaran sedang dalam proses approval (WAIT), status detail tidak dapat diubah",
                approval_state: approvalState,
            });
        }

        const userModified =
            String(req.body.user || "MOBILE").trim() || "MOBILE";
        const changes = [];

        for (const upd of updates) {
            const id = String(upd.id || "").trim();
            const newStatus = String(upd.status || "")
                .trim()
                .toUpperCase();
            const ketBatal = String(upd.ket_batal || "").trim();

            if (!id) {
                await conn.rollback();
                return res.status(400).json({
                    success: false,
                    message: "ID item tidak valid",
                });
            }

            if (newStatus === "BATAL" && !ketBatal) {
                await conn.rollback();
                return res.status(400).json({
                    success: false,
                    message: "Status BATAL wajib diisi alasannya (ket_batal)",
                });
            }

            const ketConfirm =
                newStatus === "BATAL"
                    ? ""
                    : String(upd.ket_confirm || "").trim();

            const [detailRows] = await conn.query(
                `
                SELECT
                    COALESCE(pend_status, '') AS status,
                    COALESCE(pend_batal, '') AS ket_batal,
                    COALESCE(pend_confirm, '') AS ket_confirm
                FROM tpenawaran_dtl
                WHERE pend_id = ? AND pend_pen_nomor = ?
                LIMIT 1
                `,
                [id, nomor],
            );

            if (!detailRows || detailRows.length === 0) {
                await conn.rollback();
                return res.status(404).json({
                    success: false,
                    message: `Detail item ${id} tidak ditemukan`,
                });
            }

            const before = detailRows[0];
            const beforeStatus = String(before.status || "")
                .trim()
                .toUpperCase();
            const beforeBatal = String(before.ket_batal || "").trim();
            const beforeConfirm = String(before.ket_confirm || "").trim();

            if (
                beforeStatus === newStatus &&
                beforeBatal === ketBatal &&
                beforeConfirm === ketConfirm
            ) {
                continue;
            }

            await conn.query(
                `
                UPDATE tpenawaran_dtl
                SET
                    pend_status = ?,
                    pend_batal = ?,
                    pend_confirm = ?,
                    date_modified = NOW(),
                    user_modified = ?
                WHERE pend_id = ? AND pend_pen_nomor = ?
                `,
                [newStatus, ketBatal, ketConfirm, userModified, id, nomor],
            );

            changes.push({
                id,
                before: {
                    status: beforeStatus,
                    ket_batal: beforeBatal,
                    ket_confirm: beforeConfirm,
                },
                after: {
                    status: newStatus,
                    ket_batal: ketBatal,
                    ket_confirm: ketConfirm,
                },
            });
        }

        if (changes.length === 0) {
            await conn.rollback();
            return res.json({
                success: true,
                message: "Tidak ada perubahan status detail",
                changed_count: 0,
            });
        }

        await writeStatusAuditLog({
            conn,
            nomor,
            user: userModified,
            changes,
        });

        await conn.commit();

        return res.json({
            success: true,
            message: "Status detail berhasil diubah",
            changed_count: changes.length,
        });
    } catch (err) {
        if (conn) {
            await conn.rollback();
        }
        console.error("UPDATE STATUS DETAIL ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage || err.message || "Gagal mengubah status detail",
        });
    } finally {
        if (conn) {
            conn.release();
        }
    }
};

const getMasterPenawaranBatal = async (req, res) => {
    try {
        const [rows] = await db.query(
            `
            SELECT
                COALESCE(batal, '') AS kode,
                COALESCE(batal, '') AS nama
            FROM tpenawaran_batal
            WHERE COALESCE(batal, '') <> ''
            ORDER BY batal ASC
            `,
        );

        return res.json({
            success: true,
            data: rows || [],
        });
    } catch (err) {
        console.error("GET MASTER BATAL ERROR:", err);
        return res.status(500).json({
            success: false,
            data: [],
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengambil data alasan batal",
        });
    }
};

const getMasterPenawaranConfirm = async (req, res) => {
    try {
        const [rows] = await db.query(
            `
            SELECT
                COALESCE(confirm, '') AS kode,
                COALESCE(confirm, '') AS nama
            FROM tpenawaran_confirm
            WHERE COALESCE(confirm, '') <> ''
            ORDER BY confirm ASC
            `,
        );

        return res.json({
            success: true,
            data: rows || [],
        });
    } catch (err) {
        console.error("GET MASTER CONFIRM ERROR:", err);
        return res.status(500).json({
            success: false,
            data: [],
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengambil data confirmation",
        });
    }
};

const requestApprovalPerubahan = async (req, res) => {
    let conn;

    try {
        const schemaReady = await ensurePenawaranSchema(res);
        if (!schemaReady) return;

        conn = await db.getConnection();
        const nomor = String(req.params.nomor || "").trim();
        const alasan = String(req.body.alasan || "").trim();

        if (!nomor) {
            return res.status(400).json({
                success: false,
                message: "Nomor penawaran tidak valid",
            });
        }

        if (!alasan) {
            return res.status(400).json({
                success: false,
                message: "Alasan pengajuan perubahan wajib diisi",
            });
        }

        await conn.beginTransaction();

        const [headerRows] = await conn.query(
            `SELECT pen_nomor FROM tpenawaran_hdr WHERE pen_nomor = ? LIMIT 1`,
            [nomor],
        );

        if (!headerRows || headerRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({
                success: false,
                message: "Penawaran tidak ditemukan",
            });
        }

        const [existingPin] = await conn.query(
            `
                        SELECT pin_nomor
            FROM tspk_pin5
            WHERE pin_trs = 'PENAWARAN'
              AND pin_nomor = ?
              AND COALESCE(pin_dipakai, '') = ''
            LIMIT 1
            `,
            [nomor],
        );

        if (existingPin && existingPin.length > 0) {
            await conn.rollback();
            return res.status(409).json({
                success: false,
                message: "Pengajuan perubahan untuk penawaran ini sudah ada",
            });
        }

        const userCreate = String(req.body.user || "MOBILE").trim() || "MOBILE";
        const pinUrut = await getNextPinUrut(conn, "PENAWARAN", nomor);

        await conn.query(
            `
            INSERT INTO tspk_pin5 (
                pin_trs,
                pin_nomor,
                pin_urut,
                pin_program,
                pin_tgl_trs,
                pin_ket,
                pin_tgl_minta,
                pin_user_minta,
                pin_acc,
                pin_dipakai,
                pin_alasan
            ) VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, '', '', '')
            `,
            [
                "PENAWARAN",
                nomor,
                pinUrut,
                "MOBILE",
                new Date(),
                alasan,
                String(userCreate).slice(0, 10),
            ],
        );

        await conn.commit();

        return res.status(201).json({
            success: true,
            message: "Pengajuan perubahan berhasil dibuat",
            approval_state: "WAIT",
        });
    } catch (err) {
        if (conn) {
            await conn.rollback();
        }
        console.error("REQUEST APPROVAL ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal membuat pengajuan perubahan",
        });
    } finally {
        if (conn) {
            conn.release();
        }
    }
};

const getPenawaranActivityLogs = async (req, res) => {
    try {
        const schemaReady = await ensurePenawaranSchema(res);
        if (!schemaReady) return;

        const nomor = String(req.params.nomor || "").trim();
        if (!nomor) {
            return res.status(400).json({
                success: false,
                message: "Nomor penawaran tidak valid",
            });
        }

        const [rows] = await db.query(
            `
            SELECT
                COALESCE(pin_trs, '') AS pin_trs,
                COALESCE(pin_nomor, '') AS pin_nomor,
                COALESCE(pin_urut, 0) AS pin_urut,
                COALESCE(pin_ket, '') AS pin_ket,
                COALESCE(pin_acc, '') AS pin_acc,
                COALESCE(pin_dipakai, '') AS pin_dipakai,
                pin_tgl_minta,
                COALESCE(pin_user_minta, '') AS pin_user_minta,
                COALESCE(pin_alasan, '') AS pin_alasan
            FROM tspk_pin5
            WHERE pin_nomor = ?
              AND pin_trs IN ('PENAWARAN', 'PENAWARAN_STATUS')
            ORDER BY pin_tgl_minta DESC, pin_urut DESC
            LIMIT 100
            `,
            [nomor],
        );

        const data = (rows || []).map((row) => {
            const pinTrs = String(row.pin_trs || "")
                .trim()
                .toUpperCase();

            if (pinTrs === "PENAWARAN_STATUS") {
                let parsed = null;
                try {
                    parsed = JSON.parse(String(row.pin_ket || "{}"));
                } catch (e) {
                    parsed = null;
                }

                return {
                    type: "STATUS_UPDATE",
                    created_at: row.pin_tgl_minta,
                    user: row.pin_user_minta || "",
                    keterangan: row.pin_ket || "",
                    changes: parsed?.changes || [],
                };
            }

            const approvalState = normalizeApprovalState(
                row.pin_acc === "" && row.pin_dipakai === ""
                    ? "WAIT"
                    : row.pin_acc === "Y" && row.pin_dipakai === ""
                      ? "ACC"
                      : row.pin_acc === "N"
                        ? "TOLAK"
                        : "",
            );

            return {
                type: "APPROVAL",
                created_at: row.pin_tgl_minta,
                user: row.pin_user_minta || "",
                keterangan: row.pin_alasan || "",
                approval_state: approvalState,
                changes: [],
            };
        });

        return res.json({
            success: true,
            data,
        });
    } catch (err) {
        console.error("GET PENAWARAN ACTIVITY LOGS ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage || err.message || "Gagal mengambil activity log",
        });
    }
};

module.exports = {
    getPenawaranList,
    getPenawaranDetail,
    createPenawaran,
    getMasterPerusahaan,
    getMasterSales,
    updatePenawaranStatusDetail,
    getMasterPenawaranBatal,
    getMasterPenawaranConfirm,
    requestApprovalPerubahan,
    getPenawaranActivityLogs,
};
