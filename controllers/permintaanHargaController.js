const fs = require("fs");
const path = require("path");
const db = require("../config/dbPenawaran");

const nomorLocks = new Map();

const toNumber = (value, fallback = 0) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
};

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

const isSalesUser = (req) =>
    String(req.user?.jabatan || "")
        .trim()
        .toUpperCase() === "SALES";

const resolveActor = (req) =>
    String(
        req.user?.id || req.user?.nama || req.body?.user || "MOBILE",
    ).trim() || "MOBILE";

const resolveActorCandidates = (req) => {
    const values = [
        req.user?.id,
        req.user?.nama,
        req.body?.user,
        req.query?.user,
    ]
        .map((v) => String(v || "").trim())
        .filter(Boolean);

    const set = new Set();
    values.forEach((v) => {
        set.add(v);
        set.add(v.toUpperCase());
        set.add(v.toLowerCase());
    });

    return Array.from(set);
};

const withNomorLock = async (key, fn) => {
    const prev = nomorLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
        release = resolve;
    });

    nomorLocks.set(
        key,
        prev.then(() => current),
    );
    await prev;

    try {
        return await fn();
    } finally {
        release();
        if (nomorLocks.get(key) === current) {
            nomorLocks.delete(key);
        }
    }
};

const getNextNomor = async (conn, tahun) => {
    const [rows] = await conn.query(
        `
        SELECT IFNULL(MAX(RIGHT(mh_nomor,4)),0) AS jumlah
        FROM tmintaharga
        WHERE YEAR(mh_tanggal) = ?
        `,
        [tahun],
    );
    const next = toNumber(rows?.[0]?.jumlah, 0) + 1;
    return `MH.${tahun}.${String(next).padStart(4, "0")}`;
};

const uploadDir = path.join(process.cwd(), "uploads", "mintaharga");

const buildBaseUrl = (req) => {
    const protoHeader = String(req.headers["x-forwarded-proto"] || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)[0];
    const protocol = protoHeader || req.protocol || "http";
    const host = req.get("host");
    if (!host) return "";
    return `${protocol}://${host}`;
};

const buildImagePaths = (nomor) => {
    const safeNomor = String(nomor || "").trim();
    return {
        delphi1: `/image/mintaharga/${safeNomor}.jpg`,
        delphi2: `/image/mintaharga/${safeNomor}-2.jpg`,
        legacy1: `/uploads/mintaharga/${safeNomor}.jpg`,
        legacy2: `/uploads/mintaharga/${safeNomor}-2.jpg`,
    };
};

const getYearFromTanggal = (tanggal) =>
    Number(String(tanggal || "").slice(0, 4));

const createPermintaanHargaInTransaction = async ({
    conn,
    payload,
    actor,
    nomor,
}) => {
    await conn.query(
        `
        INSERT INTO tmintaharga (
            mh_divisi, mh_nomor, mh_tanggal, mh_cus_kode, mh_cus_nama, mh_sal_kode,
            mh_nama, mh_jmlorder, mh_harga, mh_budget, mh_dateorder, mh_kain,
            mh_panjang, mh_lebar, mh_ukuran, mh_gramasi, mh_finishing,
            mh_ket, mh_status, date_create, user_create,
            mh_harga_kalkulasi, mh_ket_kalkulasi
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BELUM', NOW(), ?, ?, ?)
        `,
        [
            toNumber(payload.mh_divisi, 0),
            nomor,
            payload.tanggal,
            String(payload.mh_cus_kode || "").trim(),
            String(payload.mh_cus_nama || "").trim(),
            String(payload.mh_sal_kode || "").trim(),
            String(payload.mh_nama || "").trim(),
            toNumber(payload.mh_jmlorder, 0),
            toNumber(payload.mh_harga, 0),
            toNumber(payload.mh_budget, 0),
            normalizeDate(payload.mh_dateorder),
            String(payload.mh_kain || "").trim(),
            toNumber(payload.mh_panjang, 0),
            toNumber(payload.mh_lebar, 0),
            String(payload.mh_ukuran || "").trim(),
            String(payload.mh_gramasi || "").trim(),
            String(payload.mh_finishing || "").trim(),
            String(payload.mh_ket || "").trim(),
            actor,
            toNumber(payload.mh_harga_kalkulasi, 0),
            String(payload.mh_ket_kalkulasi || "").trim(),
        ],
    );
};

const cloneImageFile = async (fromNomor, toNomor, suffix = "") => {
    const src = path.join(uploadDir, `${fromNomor}${suffix}.jpg`);
    const dst = path.join(uploadDir, `${toNomor}${suffix}.jpg`);
    try {
        await fs.promises.access(src, fs.constants.F_OK);
        await fs.promises.copyFile(src, dst);
        return true;
    } catch {
        return false;
    }
};

const getPermintaanHargaList = async (req, res) => {
    try {
        const monthRange = getCurrentMonthRange();
        const startDate =
            normalizeDate(req.query.startDate) || monthRange.start;
        const endDate = normalizeDate(req.query.endDate) || monthRange.end;
        const status = String(req.query.status || "")
            .trim()
            .toUpperCase();
        const search = String(req.query.search || "").trim();
        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 300);
        const page = Math.max(Number(req.query.page) || 1, 1);
        const offset = (page - 1) * limit;
        const actor = resolveActor(req);
        const actorCandidates = resolveActorCandidates(req);
        const actorCandidatesNormalized = Array.from(
            new Set(
                actorCandidates
                    .map((v) =>
                        String(v || "")
                            .trim()
                            .toUpperCase(),
                    )
                    .filter(Boolean),
            ),
        );
        const salesRole = isSalesUser(req);

        const where = [
            "m.mh_tanggal >= ?",
            "m.mh_tanggal < DATE_ADD(?, INTERVAL 1 DAY)",
        ];
        const params = [startDate, endDate];

        if (status) {
            where.push("COALESCE(m.mh_status,'') = ?");
            params.push(status);
        }

        if (search) {
            where.push(
                "(m.mh_nomor LIKE ? OR m.mh_nama LIKE ? OR m.mh_cus_nama LIKE ?)",
            );
            const like = `%${search}%`;
            params.push(like, like, like);
        }

        const bypassSalesFilter =
            String(process.env.PH_BYPASS_SALES_FILTER || "")
                .trim()
                .toLowerCase() === "1";

        if (
            salesRole &&
            !bypassSalesFilter &&
            actorCandidatesNormalized.length
        ) {
            const placeholders = actorCandidatesNormalized
                .map(() => "?")
                .join(",");
            where.push(
                `UPPER(TRIM(COALESCE(m.user_create,''))) IN (${placeholders})`,
            );
            params.push(...actorCandidatesNormalized);
        }

        if (
            String(process.env.PH_DEBUG_LIST || "")
                .trim()
                .toLowerCase() === "1"
        ) {
            console.log("[PermintaanHarga][List][Debug]", {
                actor,
                actorCandidates,
                actorCandidatesNormalized,
                salesRole,
                bypassSalesFilter,
                startDate,
                endDate,
                status,
                search,
                limit,
                page,
                where,
            });
        }

        params.push(limit, offset);

        const [rows] = await db.query(
            `
            SELECT
                m.mh_nomor AS nomor,
                DATE_FORMAT(m.mh_tanggal, '%Y-%m-%d') AS tanggal,
                COALESCE(m.mh_nama,'') AS nama,
                COALESCE(m.mh_cus_nama,'') AS customer,
                COALESCE(v.divisi,'') AS divisi,
                COALESCE(m.mh_jmlorder,0) AS jml_order,
                COALESCE(m.mh_harga_kalkulasi,0) AS harga_kalkulasi,
                COALESCE(m.mh_status,'') AS status,
                COALESCE(m.mh_ket_kalkulasi,'') AS ket_kalkulasi,
                COALESCE(m.user_create,'') AS user_create
            FROM tmintaharga m
            LEFT JOIN tdivisi v ON v.kode = m.mh_divisi
            WHERE ${where.join(" AND ")}
            ORDER BY m.mh_nomor DESC
            LIMIT ? OFFSET ?
            `,
            params,
        );

        if (
            String(process.env.PH_DEBUG_LIST || "")
                .trim()
                .toLowerCase() === "1"
        ) {
            console.log("[PermintaanHarga][List][Result]", {
                count: rows?.length || 0,
            });
        }

        return res.json({
            success: true,
            data: rows,
            meta: {
                page,
                limit,
                count: rows.length,
            },
        });
    } catch (err) {
        console.error("[PermintaanHarga][List][Error]", {
            message: err?.message,
            sqlMessage: err?.sqlMessage,
            code: err?.code,
        });
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengambil list permintaan harga",
        });
    }
};

const getPermintaanHargaDetail = async (req, res) => {
    try {
        const nomor = String(req.params.nomor || "").trim();
        if (!nomor) {
            return res
                .status(400)
                .json({ success: false, message: "Nomor tidak valid" });
        }

        const [rows] = await db.query(
            `
            SELECT
                h.*,
                COALESCE(v.divisi,'') AS divisi_nama,
                COALESCE(s.sal_nama,'') AS sales_nama,
                DATE_FORMAT(h.date_create, '%Y-%m-%d %H:%i:%s') AS created_at_fmt
            FROM tmintaharga h
            LEFT JOIN tdivisi v ON v.kode=h.mh_divisi
            LEFT JOIN tsales s ON s.sal_kode=h.mh_sal_kode
            WHERE h.mh_nomor = ?
            LIMIT 1
            `,
            [nomor],
        );

        if (!rows?.length) {
            return res
                .status(404)
                .json({ success: false, message: "Data tidak ditemukan" });
        }

        const row = rows[0];
        const baseUrl = buildBaseUrl(req);
        const imagePaths = buildImagePaths(row.mh_nomor);
        const withBase = (p) => (baseUrl ? `${baseUrl}${p}` : p);

        row.gambar_1_url = withBase(imagePaths.delphi1);
        row.gambar_2_url = withBase(imagePaths.delphi2);
        row.gambar_1_legacy_url = withBase(imagePaths.legacy1);
        row.gambar_2_legacy_url = withBase(imagePaths.legacy2);
        row.image1 = row.gambar_1_url;
        row.image2 = row.gambar_2_url;

        return res.json({ success: true, data: row });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengambil detail permintaan harga",
        });
    }
};

const createPermintaanHarga = async (req, res) => {
    try {
        const body = req.body || {};
        const tanggal = normalizeDate(
            body.mh_tanggal || new Date().toISOString(),
        );
        const actor = resolveActor(req);
        const tahun = getYearFromTanggal(tanggal);

        if (!tanggal) {
            return res
                .status(400)
                .json({ success: false, message: "Tanggal tidak valid" });
        }

        const result = await withNomorLock(`create:${tahun}`, async () => {
            let conn;
            try {
                conn = await db.getConnection();

                for (let attempt = 1; attempt <= 3; attempt += 1) {
                    await conn.beginTransaction();
                    const nomor = await getNextNomor(conn, tahun);
                    const [exists] = await conn.query(
                        `SELECT mh_nomor FROM tmintaharga WHERE mh_nomor = ? LIMIT 1`,
                        [nomor],
                    );
                    if (exists?.length) {
                        await conn.rollback();
                        continue;
                    }

                    await createPermintaanHargaInTransaction({
                        conn,
                        payload: { ...body, tanggal },
                        actor,
                        nomor,
                    });
                    await conn.commit();
                    return nomor;
                }

                throw new Error(
                    "Gagal membuat nomor permintaan harga yang unik, silakan coba lagi",
                );
            } finally {
                if (conn) conn.release();
            }
        });

        return res.status(201).json({ success: true, data: { nomor: result } });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal membuat permintaan harga",
        });
    }
};

const updatePermintaanHarga = async (req, res) => {
    try {
        const nomor = String(req.params.nomor || "").trim();
        const actor = resolveActor(req);
        const body = req.body || {};

        const [rows] = await db.query(
            `SELECT mh_nomor, mh_status, user_create FROM tmintaharga WHERE mh_nomor = ? LIMIT 1`,
            [nomor],
        );
        if (!rows?.length) {
            return res
                .status(404)
                .json({ success: false, message: "Data tidak ditemukan" });
        }
        if (
            isSalesUser(req) &&
            String(rows[0].user_create || "").trim() !== actor
        ) {
            return res.status(403).json({
                success: false,
                message: "Tidak berhak mengubah data ini",
            });
        }
        if (String(rows[0].mh_status || "").toUpperCase() !== "BELUM") {
            return res.status(409).json({
                success: false,
                message: "Hanya status BELUM yang dapat diubah",
            });
        }

        await db.query(
            `
            UPDATE tmintaharga
            SET
                mh_tanggal = ?,
                mh_divisi = ?,
                mh_cus_kode = ?,
                mh_cus_nama = ?,
                mh_sal_kode = ?,
                mh_nama = ?,
                mh_jmlorder = ?,
                mh_harga = ?,
                mh_budget = ?,
                mh_dateorder = ?,
                mh_kain = ?,
                mh_panjang = ?,
                mh_lebar = ?,
                mh_ukuran = ?,
                mh_gramasi = ?,
                mh_finishing = ?,
                mh_ket = ?,
                mh_harga_kalkulasi = ?,
                mh_ket_kalkulasi = ?,
                user_modified = ?,
                date_modified = NOW()
            WHERE mh_nomor = ?
            `,
            [
                normalizeDate(body.mh_tanggal || new Date().toISOString()),
                toNumber(body.mh_divisi, 0),
                String(body.mh_cus_kode || "").trim(),
                String(body.mh_cus_nama || "").trim(),
                String(body.mh_sal_kode || "").trim(),
                String(body.mh_nama || "").trim(),
                toNumber(body.mh_jmlorder, 0),
                toNumber(body.mh_harga, 0),
                toNumber(body.mh_budget, 0),
                normalizeDate(body.mh_dateorder),
                String(body.mh_kain || "").trim(),
                toNumber(body.mh_panjang, 0),
                toNumber(body.mh_lebar, 0),
                String(body.mh_ukuran || "").trim(),
                String(body.mh_gramasi || "").trim(),
                String(body.mh_finishing || "").trim(),
                String(body.mh_ket || "").trim(),
                toNumber(body.mh_harga_kalkulasi, 0),
                String(body.mh_ket_kalkulasi || "").trim(),
                actor,
                nomor,
            ],
        );

        return res.json({
            success: true,
            message: "Permintaan harga berhasil diubah",
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengubah permintaan harga",
        });
    }
};

const copyPermintaanHarga = async (req, res) => {
    try {
        const actor = resolveActor(req);
        const nomor = String(req.params.nomor || "").trim();
        const [rows] = await db.query(
            `SELECT * FROM tmintaharga WHERE mh_nomor = ? LIMIT 1`,
            [nomor],
        );
        if (!rows?.length) {
            return res.status(404).json({
                success: false,
                message: "Data sumber copy tidak ditemukan",
            });
        }

        const source = rows[0];
        if (
            isSalesUser(req) &&
            String(source.user_create || "").trim() !== actor
        ) {
            return res.status(403).json({
                success: false,
                message: "Tidak berhak copy data ini",
            });
        }

        if (
            String(source.mh_status || "")
                .trim()
                .toUpperCase() !== "BELUM"
        ) {
            return res.status(409).json({
                success: false,
                message: "Hanya status BELUM yang dapat di-copy",
            });
        }

        const tanggalBaru = normalizeDate(new Date().toISOString());
        const tahun = getYearFromTanggal(tanggalBaru);
        const nomorBaru = await withNomorLock(`copy:${tahun}`, async () => {
            let conn;
            try {
                conn = await db.getConnection();
                for (let attempt = 1; attempt <= 3; attempt += 1) {
                    await conn.beginTransaction();
                    const candidate = await getNextNomor(conn, tahun);
                    const [exists] = await conn.query(
                        `SELECT mh_nomor FROM tmintaharga WHERE mh_nomor = ? LIMIT 1`,
                        [candidate],
                    );
                    if (exists?.length) {
                        await conn.rollback();
                        continue;
                    }

                    await createPermintaanHargaInTransaction({
                        conn,
                        payload: {
                            ...source,
                            tanggal: tanggalBaru,
                        },
                        actor,
                        nomor: candidate,
                    });
                    await conn.commit();
                    return candidate;
                }

                throw new Error(
                    "Gagal membuat nomor copy yang unik, silakan coba lagi",
                );
            } finally {
                if (conn) conn.release();
            }
        });

        const copied1 = await cloneImageFile(nomor, nomorBaru, "");
        const copied2 = await cloneImageFile(nomor, nomorBaru, "-2");
        if (!copied1 || !copied2) {
            console.warn("[PermintaanHarga][CopyImage][Partial]", {
                nomor_sumber: nomor,
                nomor_baru: nomorBaru,
                gambar_1_copied: copied1,
                gambar_2_copied: copied2,
            });
        }

        return res.status(201).json({
            success: true,
            message: "Copy permintaan harga berhasil",
            data: {
                nomor_sumber: nomor,
                nomor_baru: nomorBaru,
                gambar_1_copied: copied1,
                gambar_2_copied: copied2,
            },
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage || err.message || "Gagal copy permintaan harga",
        });
    }
};

const deletePermintaanHarga = async (req, res) => {
    try {
        const nomor = String(req.params.nomor || "").trim();
        const actor = resolveActor(req);
        const [rows] = await db.query(
            `SELECT mh_nomor, mh_status, user_create FROM tmintaharga WHERE mh_nomor = ? LIMIT 1`,
            [nomor],
        );
        if (!rows?.length) {
            return res
                .status(404)
                .json({ success: false, message: "Data tidak ditemukan" });
        }
        if (
            isSalesUser(req) &&
            String(rows[0].user_create || "").trim() !== actor
        ) {
            return res.status(403).json({
                success: false,
                message: "Tidak berhak menghapus data ini",
            });
        }
        if (String(rows[0].mh_status || "").toUpperCase() !== "BELUM") {
            return res.status(409).json({
                success: false,
                message: "Hanya status BELUM yang dapat dihapus",
            });
        }

        await db.query(`DELETE FROM tmintaharga WHERE mh_nomor = ?`, [nomor]);
        return res.json({
            success: true,
            message: "Permintaan harga berhasil dihapus",
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal menghapus permintaan harga",
        });
    }
};

const uploadPermintaanHargaImage = async (req, res) => {
    try {
        const nomor = String(req.params.nomor || "").trim();
        const slot = String(req.params.slot || "1").trim();
        if (!["1", "2"].includes(slot)) {
            return res.status(400).json({
                success: false,
                message: "Slot gambar hanya 1 atau 2",
            });
        }
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "File gambar wajib diunggah",
            });
        }

        const [rows] = await db.query(
            `SELECT mh_nomor, mh_status, user_create FROM tmintaharga WHERE mh_nomor = ? LIMIT 1`,
            [nomor],
        );
        if (!rows?.length) {
            return res
                .status(404)
                .json({ success: false, message: "Data tidak ditemukan" });
        }
        if (
            isSalesUser(req) &&
            String(rows[0].user_create || "").trim() !== resolveActor(req)
        ) {
            return res.status(403).json({
                success: false,
                message: "Tidak berhak upload gambar untuk data ini",
            });
        }

        if (
            String(rows[0].mh_status || "")
                .trim()
                .toUpperCase() !== "BELUM"
        ) {
            return res.status(409).json({
                success: false,
                message: "Upload gambar hanya diizinkan untuk status BELUM",
            });
        }

        const baseUrl = buildBaseUrl(req);
        const imagePaths = buildImagePaths(nomor);
        const currentPath =
            String(slot) === "2" ? imagePaths.delphi2 : imagePaths.delphi1;
        const legacyPath =
            String(slot) === "2" ? imagePaths.legacy2 : imagePaths.legacy1;
        const withBase = (p) => (baseUrl ? `${baseUrl}${p}` : p);

        return res.json({
            success: true,
            message: "Upload gambar berhasil",
            data: {
                nomor,
                slot,
                file: req.file.filename,
                url: withBase(currentPath),
                legacy_url: withBase(legacyPath),
            },
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: err.sqlMessage || err.message || "Gagal upload gambar",
        });
    }
};

module.exports = {
    getPermintaanHargaList,
    getPermintaanHargaDetail,
    createPermintaanHarga,
    updatePermintaanHarga,
    copyPermintaanHarga,
    deletePermintaanHarga,
    uploadPermintaanHargaImage,
};
