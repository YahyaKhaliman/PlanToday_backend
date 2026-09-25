const db = require("../config/dbAch");
const NameMatch = require("../utils/nameMatch");

const OMSET_NAME_MAP = {
    "muhammad khoirul majid": "majid",
    "fahrur rozi": "rozie",
    "ZULFAN RIZKI EFENDI": "ZULFAN",
};

function normalize(s = "") {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function getOmsetNameKey(employeeFullName) {
    const key = normalize(employeeFullName);
    return OMSET_NAME_MAP[key] ?? null;
}

const getAchievementRange = async ({
    fromYear,
    fromMonth,
    toYear,
    toMonth,
    q = "",
    jabatan = "",
    isManager,
    userKode,
    userNama,
}) => {
    let selfKode = null;

    if (!isManager) {
        selfKode = userKode || null;

        if (!selfKode) {
            const loginName = String(userNama || "").trim();
            const mappedName = getOmsetNameKey(loginName);
            const nameToMatch = mappedName ?? loginName;
            selfKode = await NameMatch(db, nameToMatch);
        }

        if (!selfKode) {
            return {
                notFound: true,
                message: `User "${userNama}" tidak ditemukan di data achievement`,
            };
        }
    }

    const sql = `
    SELECT
        CASE WHEN s.sal_jabatan = 'CMO' THEN 'CMO' ELSE s.sal_kode END AS kode,
        MAX(COALESCE(s.sal_nik, '')) AS nik,
        MAX(CASE WHEN s.sal_jabatan = 'CMO' THEN 'CMO' ELSE COALESCE(s.sal_nama, t.USER) END) AS nama,
        MAX(COALESCE(s.sal_jabatan, t.kode)) AS jabatan,
        CAST(ROUND(SUM(t.target), 0) AS UNSIGNED) AS target,
        CAST(ROUND(SUM(COALESCE(o.realisasi, 0)), 0) AS UNSIGNED) AS realisasi,
        CASE
        WHEN COALESCE(SUM(t.target), 0) = 0 THEN
            CASE WHEN COALESCE(SUM(o.realisasi), 0) > 0 THEN 100 ELSE 0 END
        ELSE ROUND((COALESCE(SUM(o.realisasi), 0) / COALESCE(SUM(t.target), 0)) * 100, 2)
        END AS ach
    FROM kpi.v_target_mkt_monthly t
    JOIN kencanaprint.tsales s ON (
        t.kode_sales = s.sal_kode 
        OR (t.kode_sales = 'MO' AND s.sal_jabatan = 'CMO')
    )
    LEFT JOIN kpi.v_mkt_omset o ON s.sal_kode = o.kode AND t.tahun = o.tahun AND t.bulan = o.bulan
    WHERE
        s.sal_jabatan != 'MO'
        AND
        (t.tahun > ? OR (t.tahun = ? AND t.bulan >= ?))
        AND
        (t.tahun < ? OR (t.tahun = ? AND t.bulan <= ?))
        AND (
        ? = '' OR (
            LOWER(COALESCE(s.sal_nama, t.USER)) LIKE CONCAT('%', LOWER(?), '%')
            OR LOWER(COALESCE(s.sal_jabatan, t.kode)) LIKE CONCAT('%', LOWER(?), '%')
        )
        )
        AND (? = '' OR COALESCE(s.sal_jabatan, t.kode) = ?)
        ${isManager ? "" : "AND s.sal_kode = ?"}
    GROUP BY s.sal_kode
    ORDER BY MAX(COALESCE(s.sal_jabatan, t.kode)), MAX(COALESCE(s.sal_nama, t.USER))
    `;

    const params = [
        fromYear,
        fromYear,
        fromMonth,
        toYear,
        toYear,
        toMonth,
        q,
        q,
        q,
        jabatan,
        jabatan,
        ...(isManager ? [] : [selfKode]),
    ];

    const [rows] = await db.query(sql, params);

    return {
        selfKode,
        rows: rows || [],
    };
};

const getAllData = async () => {
    const sql = `
    SELECT *
    FROM v_mkt_omset
    ORDER BY tahun, bulan, jabatan, nik;
    `;
    const [rows] = await db.query(sql);
    return rows || [];
};

const getOmsetByMonth = async ({ kode, year, fromInt, toInt }) => {
    let isCMO = kode === "CMO";
    if (!isCMO) {
        const [salesRows] = await db.query(
            `SELECT sal_jabatan FROM ${process.env.DB_NAME_PENAWARAN}.tsales WHERE sal_kode = ? LIMIT 1`,
            [kode],
        );
        if (salesRows?.[0]?.sal_jabatan === "CMO") {
            isCMO = true;
        }
    }

    let nama = null;
    if (isCMO) {
        nama = "CMO";
    } else {
        const [nameRows] = await db.query(
            `SELECT MAX(nama) AS nama
             FROM ${process.env.DB_NAME_ACH}.v_mkt_omset
             WHERE kode = ?`,
            [kode],
        );
        nama = nameRows?.[0]?.nama || null;
    }

    let where = "";
    const params = [];

    if (isCMO) {
        where = `WHERE kode IN (SELECT sal_kode FROM ${process.env.DB_NAME_PENAWARAN}.tsales WHERE sal_jabatan = 'CMO')`;
    } else {
        where = `WHERE kode = ?`;
        params.push(kode);
    }

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
    FROM ${process.env.DB_NAME_ACH}.v_mkt_omset
    ${where}
    GROUP BY tahun, bulan
    ORDER BY tahun, bulan
    `;

    const [rows] = await db.query(sql, params);

    const dataWithSpk = await Promise.all(
        (rows || []).map(async (row) => {
            let salesFilterSql = "";
            let queryParams = [];

            if (isCMO) {
                salesFilterSql = `AND s.spk_sal_kode IN (SELECT sal_kode FROM ${process.env.DB_NAME_PENAWARAN}.tsales WHERE sal_jabatan IN ('MO', 'CMO'))`;
                queryParams = [row.tahun, row.bulan];
            } else {
                salesFilterSql = `AND s.spk_sal_kode = ?`;
                queryParams = [kode, row.tahun, row.bulan];
            }

            const [spkRows] = await db.query(
                `SELECT
                    s.spk_nomor,
                    DATE_FORMAT(s.spk_tanggal, '%Y-%m-%d') AS spk_tanggal,
                    s.spk_cus_kode,
                    c.cus_nama AS customer_nama,
                    s.spk_divisi,
                    s.spk_tipe,
                    s.spk_nama,
                    s.spk_jumlah,
                    s.spk_harga,
                    (IFNULL(s.spk_jumlah, 0) * IFNULL(s.spk_harga, 0)) AS nilai,
                    COALESCE(s.spk_close, 0) AS spk_close
                FROM ${process.env.DB_NAME_PENAWARAN}.tspk s
                LEFT JOIN ${process.env.DB_NAME_PENAWARAN}.tcustomer c ON c.cus_kode = s.spk_cus_kode
                WHERE s.spk_aktif = 'Y'
                  AND s.spk_divisi IN (1, 4, 5)
                  ${salesFilterSql}
                  AND YEAR(s.spk_tanggal) = ?
                  AND MONTH(s.spk_tanggal) = ?
                ORDER BY s.spk_tanggal ASC, s.spk_nomor ASC`,
                queryParams,
            );

            const nominal_spk = (spkRows || []).reduce(
                (sum, item) => sum + Number(item.nilai || 0),
                0,
            );

            return {
                ...row,
                total_spk: spkRows?.length || 0,
                nominal_spk: nominal_spk,
                detail_spk: spkRows || [],
            };
        }),
    );

    return {
        nama,
        data: dataWithSpk,
    };
};

const getOmsetByYear = async ({ kode }) => {
    const [nameRows] = await db.query(
        `SELECT MAX(nama) AS nama
        FROM ${process.env.DB_NAME_ACH}.v_mkt_omset
        WHERE kode = ?`,
        [kode],
    );
    const nama = nameRows?.[0]?.nama || null;

    const sql = `
    SELECT
        tahun,
        SUM(target) AS target,
        SUM(realisasi) AS realisasi,
        ROUND((SUM(realisasi) / NULLIF(SUM(target), 0)) * 100, 2) AS ach
    FROM ${process.env.DB_NAME_ACH}.v_mkt_omset
    WHERE kode = ?
    GROUP BY tahun
    ORDER BY tahun;
    `;

    const [rows] = await db.query(sql, [kode]);

    return {
        nama,
        rows: rows || [],
    };
};

const getAchievementOmset = async ({ tahun, bulan, nik, jabatan, search, limit }) => {
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
        AND jabatan != 'MO'
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

    const totalTarget = (rows || []).reduce(
        (a, x) => a + (Number(x.target) || 0),
        0,
    );
    const totalRealisasi = (rows || []).reduce(
        (a, x) => a + (Number(x.realisasi) || 0),
        0,
    );
    const overallAch =
        totalTarget > 0
            ? Math.round((totalRealisasi / totalTarget) * 10000) / 100
            : 0;

    return {
        summary: {
            total_target: totalTarget,
            total_realisasi: totalRealisasi,
            ach: overallAch,
        },
        rows: rows || [],
    };
};

const getSpkOmsetByMonth = async ({ kode, tahun, bulan, page, limit }) => {
    let isCMO = kode === "CMO";
    if (!isCMO) {
        const [salesRows] = await db.query(
            `SELECT sal_jabatan FROM ${process.env.DB_NAME_PENAWARAN}.tsales WHERE sal_kode = ? LIMIT 1`,
            [kode],
        );
        if (salesRows?.[0]?.sal_jabatan === "CMO") {
            isCMO = true;
        }
    }

    const offset = (page - 1) * limit;

    let salesFilterSql = "";
    let listParams = [];
    let summaryParams = [];

    if (isCMO) {
        salesFilterSql = `AND spk_sal_kode IN (SELECT sal_kode FROM ${process.env.DB_NAME_PENAWARAN}.tsales WHERE sal_jabatan IN ('MO', 'CMO'))`;
        listParams = [tahun, bulan, limit, offset];
        summaryParams = [tahun, bulan];
    } else {
        salesFilterSql = `AND spk_sal_kode = ?`;
        listParams = [kode, tahun, bulan, limit, offset];
        summaryParams = [kode, tahun, bulan];
    }

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
        (IFNULL(spk_jumlah,0) * IFNULL(spk_harga,0)) AS nilai,
        COALESCE(spk_close, 0) AS spk_close
    FROM ${process.env.DB_NAME_PENAWARAN}.tspk
    WHERE spk_aktif='Y'
        AND spk_divisi IN (1,4,5)
        ${salesFilterSql}
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
    FROM ${process.env.DB_NAME_PENAWARAN}.tspk
    WHERE spk_aktif='Y'
        AND spk_divisi IN (1,4,5)
        ${salesFilterSql}
        AND YEAR(spk_tanggal) = ?
        AND MONTH(spk_tanggal) = ?;
    `;

    const [rows] = await db.query(sqlList, listParams);
    const [sumRows] = await db.query(sqlSummary, summaryParams);
    const summary = sumRows?.[0] || {
        total_spk: 0,
        total_realisasi: 0,
        garmen_premium: 0,
        digital_print: 0,
    };

    return {
        summary,
        rows: rows || [],
    };
};

module.exports = {
    getAchievementRange,
    getAllData,
    getOmsetByMonth,
    getOmsetByYear,
    getAchievementOmset,
    getSpkOmsetByMonth,
    getOmsetNameKey,
    normalize,
};
