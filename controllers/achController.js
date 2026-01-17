const db = require('../config/dbAch');

const parseYear = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

const parseIntOrNull = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
};

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

const normalizeRange = (fromYear, fromMonth, toYear, toMonth) => {
    const now = new Date();
    let fy = fromYear ?? now.getFullYear();
    let fm = fromMonth ?? (now.getMonth() + 1);
    let ty = toYear ?? fy;
    let tm = toMonth ?? fm;

    fm = clamp(fm, 1, 12);
    tm = clamp(tm, 1, 12);

    const a = fy * 12 + (fm - 1);
    const b = ty * 12 + (tm - 1);

    // kalau kebalik, swap
    if (a > b) {
        [fy, ty] = [ty, fy];
        [fm, tm] = [tm, fm];
    }

    return { fy, fm, ty, tm };
};

const getAchievementRange = async (req, res) => {
    try {
        const fromYear = parseIntOrNull(req.query.fromYear);
        const fromMonth = parseIntOrNull(req.query.fromMonth);
        const toYear = parseIntOrNull(req.query.toYear);
        const toMonth = parseIntOrNull(req.query.toMonth);

        const q = String(req.query.q || '').trim();
        const jabatan = String(req.query.jabatan || '').trim();

        const { fy, fm, ty, tm } = normalizeRange(fromYear, fromMonth, toYear, toMonth);

        const sql = `
        SELECT
            v.kode,
            MAX(v.nik) AS nik,
            MAX(v.nama) AS nama,
            MAX(v.jabatan) AS jabatan,

            CAST(ROUND(SUM(v.target), 0) AS UNSIGNED)      AS target,
            CAST(ROUND(SUM(v.realisasi), 0) AS UNSIGNED)   AS realisasi,
            CASE
            WHEN COALESCE(SUM(v.target), 0) = 0 THEN 0
            ELSE ROUND((COALESCE(SUM(v.realisasi), 0) / COALESCE(SUM(v.target), 0)) * 100, 2)
            END AS ach
        FROM kpi.v_mkt_omset v
        FROM kpi.v_mkt_omset v
        WHERE
            (
            v.tahun > ? OR (v.tahun = ? AND v.bulan >= ?)
            )
            AND
            (
            v.tahun < ? OR (v.tahun = ? AND v.bulan <= ?)
            )
            AND (? = '' OR (LOWER(v.nama) LIKE CONCAT('%', LOWER(?), '%') OR LOWER(v.jabatan) LIKE CONCAT('%', LOWER(?), '%')))
            AND (? = '' OR v.jabatan = ?)
        GROUP BY v.kode
        ORDER BY MAX(v.jabatan), MAX(v.nama)
        `;

        const params = [
        fy, fy, fm,
        ty, ty, tm,
        q, q, q,
        jabatan, jabatan,
        ];

        const [rows] = await db.query(sql, params);

        return res.status(200).json({
        success: true,
        meta: { fromYear: fy, fromMonth: fm, toYear: ty, toMonth: tm, q, jabatan },
        data: rows,
        });
    } catch (err) {
        console.error('GET ACHIEVEMENT RANGE:', err);
        return res.status(500).json({
        success: false,
        message: err?.message || 'Gagal mengambil achievement range',
        });
    }
};

// (TES) GET all data
const allData = async (req, res) => {
    try {
        const sql = `
        SELECT *
        FROM v_mkt_omset
        ORDER BY tahun, bulan, jabatan, nik;
        `;

        const [rows] = await db.query(sql);

        return res.status(200).json({
            success: true,
            data: rows,
        });
    } catch (err) {
        console.error('GET ACHIEVEMENT OMSET ERROR:', err);
        return res.status(500).json({
            success: false,
            message: err?.message || 'Gagal mengambil achievement omset',
        });
    }
};

// GET omset per bulan
const getOmsetByMonth = async (req, res) => {
    try {
        const kode = String(req.params.id || req.user?.kode || '').trim()

        if (!kode)
            return res.status(400).json({
        success:false, message:'kode tidak terdeteksi'
        });

        const [nameRows] = await db.query(
        `SELECT MAX(nama) AS nama
        FROM kpi.v_mkt_omset
        WHERE kode = ?`,
        [kode]
        );

        const nama = nameRows?.[0]?.nama || null;

        const year = parseYear(req.query.year);
        const fromInt = parseYmToInt(req.query.from);
        const toInt = parseYmToInt(req.query.to);

        let where = `WHERE kode = ?`;
        const params = [kode];

        if (fromInt && toInt) {
            where += ` AND (tahun*100 + bulan) BETWEEN ? AND ?`;
        params.push(fromInt, toInt);
        } else if (year) {
            where += ` AND tahun = ?`;
            params.push(year);
        }

        const sql = `
        SELECT
            tahun,
            bulan,
            LPAD(bulan, 2, '0') AS bulan2,
            CONCAT(tahun, '-', LPAD(bulan, 2, '0')) AS periode,
            CAST(ROUND(SUM(target), 0) AS UNSIGNED)      AS target,
            CAST(ROUND(SUM(realisasi), 0) AS UNSIGNED)   AS realisasi,
            ROUND((SUM(realisasi) / NULLIF(SUM(target), 0)) * 100, 2) AS ach
        FROM kpi.v_mkt_omset
        ${where}
        GROUP BY tahun, bulan
        ORDER BY tahun, bulan
        `;

        const [rows] = await db.query(sql, params);

        return res.status(200).json({
            success: true,
            nama: nama,
            group: 'month',
            data: rows,
        });
    } catch (err) {
        console.error('GET OMSET BY MONTH:', err);
        return res.status(500).json({
            success: false,
            message: err?.message || 'Gagal mengambil omset per bulan',
        });
    }
};

// GET omset per tahun
const getOmsetByYear = async (req, res) => {
    try {
        const kode = String(req.params.id || req.user?.kode || '').trim()

        if (!kode)
            return res.status(400).json({
        success:false, message:'kode tidak terdeteksi'
        });

        const [nameRows] = await db.query(
        `SELECT MAX(nama) AS nama
        FROM kpi.v_mkt_omset
        WHERE kode = ?`,
        [kode]
        );
        const nama = nameRows?.[0]?.nama || null;

        const sql = `
        SELECT
            tahun,
            SUM(target) AS target,
            SUM(realisasi) AS realisasi,
            ROUND((SUM(realisasi) / NULLIF(SUM(target), 0)) * 100, 2) AS ach
        FROM kpi.v_mkt_omset
        WHERE kode = ?
        GROUP BY tahun
        ORDER BY tahun;
        `;

        const [rows] = await db.query(sql, [kode]);

        return res.status(200).json({
            success: true,
            nama: nama,
            group: 'years',
            data: rows,
        });
    } catch (err) {
        console.error('GET OMSET BY YEAR ERROR:', err);
        return res.status(500).json({
            success: false,
            message: err?.message || 'Gagal mengambil omset per tahun',
        });
    }
};

// Get achievement omset
const getAchievementOmset = async (req, res) => {
    try {
        const now = new Date();
        const tahun = parseInt(req.query.tahun || String(now.getFullYear()), 10);
        const bulan = parseInt(req.query.bulan || String(now.getMonth() + 1), 10);

        const nik = String(req.query.nik || '').trim();
        const jabatan = String(req.query.jabatan || '').trim();
        const search = String(req.query.search || '').trim();

        let limit = parseInt(req.query.limit || '50', 10);
        if (Number.isNaN(limit) || limit <= 0) limit = 50;
        if (limit > 200) limit = 200;

        // base query
        let sql = `
        SELECT
            kpi,
            kode,
            nik,
            nama,
            jabatan,
            tahun,
            bulan,
            target,
            realisasi,
            ach,
            garmen_premium,
            share_garmen_premium,
            digital_print,
            share_digital_print,
            nilai
        FROM v_mkt_omset
        WHERE tahun = ?
            AND bulan = ?
        `;
        const params = [tahun, bulan];

        if (nik) {
            sql += ` AND nik = ?`;
            params.push(nik);
        }

        if (jabatan) {
            sql += ` AND jabatan = ?`;
            params.push(jabatan);
        }

        if (search) {
            sql += ` AND (nama LIKE ? OR kode LIKE ? OR nik LIKE ?)`;
            const like = `%${search}%`;
            params.push(like, like, like);
        }

        sql += `
        ORDER BY ach DESC, realisasi DESC, nama ASC
        LIMIT ?
        `;
        params.push(limit);

        const [rows] = await db.query(sql, params);

        // summary (opsional tapi enak buat header FE)
        const totalTarget = rows.reduce((a, x) => a + (Number(x.target) || 0), 0);
        const totalRealisasi = rows.reduce((a, x) => a + (Number(x.realisasi) || 0), 0);
        const overallAch = totalTarget > 0 ? Math.round((totalRealisasi / totalTarget) * 10000) / 100 : 0;

        return res.json({
            success: true,
            filter: { tahun, bulan, nik: nik || null, jabatan: jabatan || null, search: search || null, limit },
            summary: { total_target: totalTarget, total_realisasi: totalRealisasi, ach: overallAch },
            data: rows,
        });
    } catch (err) {
        console.error('GET ACHIEVEMENT OMSET ERROR:', err);
        return res.status(500).json({
            success: false,
            message: err?.message || 'Gagal mengambil achievement omset',
        });
    }
};

// Get Omset BY SPK per Month
const getSpkOmsetByMonth = async (req, res) => {
    try {
        const isManager = String(req.user?.jabatan || '').toUpperCase() === 'MANAGER';

        const tahun = Number(req.query.tahun);
        const bulan = Number(req.query.bulan);

        if (!tahun || !bulan || bulan < 1 || bulan > 12) {
        return res.status(400).json({
            success: false,
            message: 'Query tahun & bulan wajib (bulan 1-12)',
        });
        }

        const kodeFromUser = req.user?.kode || req.user?.sal_kode || req.user?.kode_sales || req.user?.spk_sal_kode;
        const kode = isManager ? req.params.kode : kodeFromUser;

        if (!kode) {
        return res.status(400).json({
            success: false,
            message: 'Kode sales tidak ditemukan di session user',
        });
        }

        const page = Math.max(1, Number(req.query.page || 1));
        const limit = Math.min(100, Math.max(10, Number(req.query.limit || 20)));
        const offset = (page - 1) * limit;

        const sqlList = `
        SELECT
            spk_nomor,
            spk_tanggal,
            spk_cus_kode,
            spk_divisi,
            spk_tipe,
            spk_nama,
            spk_jumlah,
            spk_harga,
            (IFNULL(spk_jumlah,0) * IFNULL(spk_harga,0)) AS nilai
        FROM kencanaprint_lokal.tspk
        WHERE spk_aktif='Y'
            AND spk_divisi IN (1,4,5)
            AND spk_sal_kode = ?
            AND YEAR(spk_tanggal) = ?
            AND MONTH(spk_tanggal) = ?
        ORDER BY spk_tanggal ASC, spk_nomor ASC
        LIMIT ? OFFSET ?;
        `;

        const sqlSummary = `
        SELECT
            COUNT(*) AS total_spk,
            SUM(IFNULL(spk_jumlah,0) * IFNULL(spk_harga,0)) AS total_realisasi,
            SUM(CASE WHEN spk_divisi=4 AND UPPER(spk_tipe)='PREMIUM'
                THEN IFNULL(spk_jumlah,0)*IFNULL(spk_harga,0) ELSE 0 END) AS garmen_premium,
            SUM(CASE WHEN spk_divisi=5
                THEN IFNULL(spk_jumlah,0)*IFNULL(spk_harga,0) ELSE 0 END) AS digital_print
        FROM kencanaprint_lokal.tspk
        WHERE spk_aktif='Y'
            AND spk_divisi IN (1,4,5)
            AND spk_sal_kode = ?
            AND YEAR(spk_tanggal) = ?
            AND MONTH(spk_tanggal) = ?;
        `;

        const [rows] = await db.query(sqlList, [kode, tahun, bulan, limit, offset]);
        const [sumRows] = await db.query(sqlSummary, [kode, tahun, bulan]);
        const summary = sumRows?.[0] || { total_spk: 0, total_realisasi: 0, garmen_premium: 0, digital_print: 0 };

        return res.status(200).json({
        success: true,
        kode,
        tahun,
        bulan,
        page,
        limit,
        summary,
        data: rows,
        });
    } catch (err) {
        console.error('GET SPK OMSET BY MONTH ERROR:', err);
        return res.status(500).json({
        success: false,
        message: err?.message || 'Gagal mengambil detail SPK omset',
        });
    }
};

module.exports = {
    allData,
    getOmsetByMonth,
    getOmsetByYear,
    getAchievementRange,
    getSpkOmsetByMonth,
    getAchievementOmset
};