const db = require("../config/dbPenawaran");

const toNumber = (val, fallback = 0) => {
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
};

// Generate nomor potensi: POT_[Perusahaan]_[KodeJO]_[6 Digit Urut]
const getNextPotensiNumber = async (
    conn,
    perusahaanKode = "KP",
    joKode = "LL",
) => {
    const cleanPerush =
        String(perusahaanKode || "KP")
            .trim()
            .toUpperCase() || "KP";
    const cleanJo =
        String(joKode || "LL")
            .trim()
            .toUpperCase() || "LL";
    const prefix = `POT_${cleanPerush}_${cleanJo}_`;

    const [rows] = await conn.query(
        `
        SELECT IFNULL(MAX(CAST(RIGHT(pot_nomor, 6) AS UNSIGNED)), 0) AS max_num
        FROM tpotensi
        WHERE pot_nomor LIKE ?
        `,
        [`${prefix}%`],
    );

    const last = toNumber(rows?.[0]?.max_num, 0);
    const next = String(last + 1).padStart(6, "0");
    return `${prefix}${next}`;
};

/**
 * Service: Mengambil daftar kandidat Penawaran & MAP yang belum masuk tpotensi
 */
const getKandidatList = async ({
    managerRole,
    authSalesKode,
    salesFilter = "",
    search = "",
    sumberFilter = "ALL",
}) => {
    const effectiveSalesKode = managerRole
        ? salesFilter || null
        : authSalesKode;
    const searchLike = search ? `%${search}%` : null;

    const penParams = [];
    let penSalesSql = "";
    if (effectiveSalesKode) {
        penSalesSql =
            " AND (h.pen_sal_kode = ? OR s.sal_nama = ? OR s.sal_nama LIKE ?) ";
        penParams.push(
            effectiveSalesKode,
            effectiveSalesKode,
            `%${effectiveSalesKode}%`,
        );
    }
    let penSearchSql = "";
    if (searchLike) {
        penSearchSql = `
            AND (
                h.pen_nomor LIKE ?
                OR d.pend_nama_barang LIKE ?
                OR c.cus_nama LIKE ?
                OR s.sal_nama LIKE ?
            )
        `;
        penParams.push(searchLike, searchLike, searchLike, searchLike);
    }

    const mapParams = [];
    let mapSalesSql = "";
    if (effectiveSalesKode) {
        mapSalesSql =
            " AND (COALESCE(m.mspk_sal_kode, h.pen_sal_kode, '') = ? OR s.sal_nama = ? OR s.sal_nama LIKE ?) ";
        mapParams.push(
            effectiveSalesKode,
            effectiveSalesKode,
            `%${effectiveSalesKode}%`,
        );
    }
    let mapSearchSql = "";
    if (searchLike) {
        mapSearchSql = `
            AND (
                m.mspk_nomor LIKE ?
                OR m.mspk_nama LIKE ?
                OR c.cus_nama LIKE ?
                OR s.sal_nama LIKE ?
                OR COALESCE(h.pen_nomor, '') LIKE ?
            )
        `;
        mapParams.push(
            searchLike,
            searchLike,
            searchLike,
            searchLike,
            searchLike,
        );
    }

    const penawaranSubQuery = `
        SELECT 
            'PENAWARAN' AS tipe_sumber,
            h.pen_nomor AS pen_nomor,
            NULL AS mspk_nomor,
            d.pend_id AS item_id,
            COALESCE(d.pend_nama_barang, '') AS nama_item,
            COALESCE(d.pend_harga, 0) AS harga_satuan,
            COALESCE(d.pend_qty, 1) AS qty,
            (COALESCE(d.pend_harga, 0) * COALESCE(d.pend_qty, 1)) AS harga,
            COALESCE(d.pend_satuan, 'PCS') AS satuan,
            COALESCE(d.pend_ukuran, '') AS ukuran,
            COALESCE(d.pend_bahan, '') AS bahan,
            DATE_FORMAT(h.pen_tanggal, '%Y-%m-%d') AS tanggal,
            h.pen_sal_kode AS sales_kode,
            COALESCE(s.sal_nama, '') AS sales_nama,
            h.pen_cus_kode AS customer_kode,
            COALESCE(c.cus_nama, '') AS customer_nama,
            COALESCE(h.pen_perush_kode, 'KP') AS perush_kode,
            'LL' AS jo_kode
        FROM tpenawaran_hdr h
        INNER JOIN tpenawaran_dtl d 
            ON d.pend_pen_nomor = h.pen_nomor
        LEFT JOIN tsales s 
            ON s.sal_kode = h.pen_sal_kode
        LEFT JOIN tcustomer c 
            ON c.cus_kode = h.pen_cus_kode AND c.cus_aktif = 1
        LEFT JOIN tmemospk m 
            ON m.mspk_pen_nomor = h.pen_nomor 
           AND m.mspk_pen_id = d.pend_id
        LEFT JOIN tpotensi p 
            ON p.pot_pen_nomor = h.pen_nomor 
           AND p.pot_nama_item = d.pend_nama_barang
        WHERE m.mspk_nomor IS NULL 
          AND p.pot_nomor IS NULL
          AND COALESCE(h.pen_status, '') <> 'BATAL'
          AND COALESCE(d.pend_batal, '') <> 'Y'
          ${penSalesSql}
          ${penSearchSql}
    `;

    const mapSubQuery = `
        SELECT 
            'MAP' AS tipe_sumber,
            COALESCE(m.mspk_pen_nomor, '') AS pen_nomor,
            m.mspk_nomor AS mspk_nomor,
            COALESCE(m.mspk_pen_id, '') AS item_id,
            COALESCE(m.mspk_nama, '') AS nama_item,
            COALESCE(NULLIF(d.pend_harga, 0), NULLIF(m.Mspk_harga, 0), 0) AS harga_satuan,
            COALESCE(NULLIF(d.pend_qty, 0), NULLIF(m.Mspk_jumlah, 0), 1) AS qty,
            (COALESCE(NULLIF(d.pend_harga, 0), NULLIF(m.Mspk_harga, 0), 0) * COALESCE(NULLIF(d.pend_qty, 0), NULLIF(m.Mspk_jumlah, 0), 1)) AS harga,
            COALESCE(d.pend_satuan, 'PCS') AS satuan,
            COALESCE(d.pend_ukuran, m.Mspk_ukuran, '') AS ukuran,
            COALESCE(d.pend_bahan, m.Mspk_kain, '') AS bahan,
            DATE_FORMAT(m.mspk_tanggal, '%Y-%m-%d') AS tanggal,
            COALESCE(m.mspk_sal_kode, h.pen_sal_kode, '') AS sales_kode,
            COALESCE(s.sal_nama, '') AS sales_nama,
            COALESCE(m.mspk_cus_kode, h.pen_cus_kode, '') AS customer_kode,
            COALESCE(c.cus_nama, '') AS customer_nama,
            COALESCE(m.mspk_perush_kode, h.pen_perush_kode, 'KP') AS perush_kode,
            'LL' AS jo_kode
        FROM tmemospk m
        LEFT JOIN tpenawaran_hdr h 
            ON h.pen_nomor = m.mspk_pen_nomor
        LEFT JOIN tpenawaran_dtl d 
            ON d.pend_pen_nomor = m.mspk_pen_nomor 
           AND d.pend_id = m.mspk_pen_id
        LEFT JOIN tsales s 
            ON s.sal_kode = COALESCE(m.mspk_sal_kode, h.pen_sal_kode, '')
        LEFT JOIN tcustomer c 
            ON c.cus_kode = COALESCE(m.mspk_cus_kode, h.pen_cus_kode, '') AND c.cus_aktif = 1
        LEFT JOIN tsalesorder so 
            ON so.so_memo = m.mspk_nomor 
           AND so.so_aktif = 'Y'
        LEFT JOIN tpotensi p_map 
            ON p_map.pot_mspk_nomor = m.mspk_nomor
        LEFT JOIN tpotensi p_pen 
                ON p_pen.pot_pen_nomor = m.mspk_pen_nomor 
           AND p_pen.pot_nama_item = m.mspk_nama
        WHERE so.so_nomor IS NULL 
          AND p_map.pot_nomor IS NULL 
          AND p_pen.pot_nomor IS NULL
          AND COALESCE(m.mspk_close, '') <> 'Y'
          ${mapSalesSql}
          ${mapSearchSql}
    `;

    let sql = "";
    let queryParams = [];

    const normalizedSumber = String(sumberFilter || "ALL")
        .trim()
        .toUpperCase();

    if (normalizedSumber === "PENAWARAN") {
        sql = `${penawaranSubQuery} ORDER BY tanggal DESC LIMIT 100`;
        queryParams = penParams;
    } else if (normalizedSumber === "MAP") {
        sql = `${mapSubQuery} ORDER BY tanggal DESC LIMIT 100`;
        queryParams = mapParams;
    } else {
        sql = `
            (${penawaranSubQuery})
            UNION ALL
            (${mapSubQuery})
            ORDER BY tanggal DESC
            LIMIT 150
        `;
        queryParams = [...penParams, ...mapParams];
    }

    const [rows] = await db.query(sql, queryParams);
    return rows || [];
};

/**
 * Service: Menyimpan batch item ke tpotensi
 */
const createBatch = async ({
    items = [],
    authSalesKode,
    username = "SYSTEM",
}) => {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const createdList = [];

        for (const item of items) {
            const penNomor =
                String(item.pen_nomor || item.pot_pen_nomor || "").trim() ||
                null;
            const mspkNomor =
                String(item.mspk_nomor || item.pot_mspk_nomor || "").trim() ||
                null;
            const namaItem = String(
                item.nama_item || item.pot_nama_item || "",
            ).trim();
            const harga = toNumber(
                item.harga !== undefined ? item.harga : item.pot_harga,
                0,
            );
            const cusKode = String(
                item.customer_kode || item.pot_cus_kode || "",
            ).trim();
            const salKode = String(
                item.sales_kode || item.pot_sal_kode || authSalesKode || "",
            ).trim();
            const perushKode = String(
                item.perush_kode || item.pot_perush_kode || "KP",
            ).trim();
            const joKode = String(
                item.jo_kode || item.pot_jo_kode || "LL",
            ).trim();

            if (!namaItem) continue;

            // Cek pencegahan duplikasi di database
            const [existRows] = await conn.query(
                `
                SELECT pot_nomor FROM tpotensi 
                WHERE (pot_mspk_nomor IS NOT NULL AND pot_mspk_nomor = ?)
                   OR (pot_pen_nomor IS NOT NULL AND pot_pen_nomor = ? AND pot_nama_item = ?)
                LIMIT 1
                `,
                [mspkNomor, penNomor, namaItem],
            );

            if (existRows && existRows.length > 0) {
                continue;
            }

            const potNomor = await getNextPotensiNumber(
                conn,
                perushKode,
                joKode,
            );

            await conn.query(
                `
                INSERT INTO tpotensi (
                    pot_nomor,
                    pot_sal_kode,
                    pot_cus_kode,
                    pot_pen_nomor,
                    pot_mspk_nomor,
                    pot_nama_item,
                    pot_harga,
                    pot_status,
                    pot_alasan_batal,
                    user_create,
                    date_create
                ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NOW())
                `,
                [
                    potNomor,
                    salKode,
                    cusKode,
                    penNomor,
                    mspkNomor,
                    namaItem,
                    harga,
                    username,
                ],
            );

            createdList.push({
                pot_nomor: potNomor,
                nama_item: namaItem,
                harga: harga,
            });
        }

        await conn.commit();
        return createdList;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
};

/**
 * Service: Mengambil daftar potensi beserta KPI summary
 */
const getList = async ({
    managerRole,
    authSalesKode,
    startDate,
    endDate,
    salesFilter = "",
    search = "",
    statusFilter = "ALL",
}) => {
    const effectiveSalesKode = managerRole
        ? salesFilter || null
        : authSalesKode;

    const whereClauses = [
        "DATE(p.date_create) >= ? AND DATE(p.date_create) <= ?",
    ];
    const params = [startDate, endDate];

    if (effectiveSalesKode) {
        whereClauses.push(
            "(p.pot_sal_kode = ? OR s.sal_nama = ? OR s.sal_nama LIKE ? OR m.mspk_sal_kode = ?)",
        );
        params.push(
            effectiveSalesKode,
            effectiveSalesKode,
            `%${effectiveSalesKode}%`,
            effectiveSalesKode,
        );
    }

    if (search) {
        const like = `%${search}%`;
        whereClauses.push(`
            (
                p.pot_nomor LIKE ?
                OR p.pot_nama_item LIKE ?
                OR COALESCE(m.mspk_nama, '') LIKE ?
                OR COALESCE(d.pend_nama_barang, '') LIKE ?
                OR COALESCE(p.pot_pen_nomor, '') LIKE ?
                OR COALESCE(p.pot_mspk_nomor, m.mspk_nomor, '') LIKE ?
                OR COALESCE(c.cus_nama, '') LIKE ?
                OR COALESCE(s.sal_nama, '') LIKE ?
            )
        `);
        params.push(like, like, like, like, like, like, like, like);
    }

    const normalizedStatus = String(statusFilter || "ALL")
        .trim()
        .toUpperCase();
    if (normalizedStatus === "POTENSI") {
        whereClauses.push("p.pot_status IS NULL");
    } else if (normalizedStatus === "CLOSE") {
        whereClauses.push("p.pot_status = 'CLOSE'");
    } else if (normalizedStatus === "BATAL") {
        whereClauses.push("p.pot_status = 'BATAL'");
    }

    const whereSql = `WHERE ${whereClauses.join(" AND ")}`;

    // Query Detail List Dinamis dengan LEFT JOIN ke MAP & Penawaran
    const [listRows] = await db.query(
        `
        SELECT 
            p.pot_nomor,
            p.pot_sal_kode,
            COALESCE(MAX(s.sal_kode), p.pot_sal_kode) AS sales_kode,
            COALESCE(MAX(s.sal_nama), '') AS sal_nama,
            COALESCE(MAX(s.sal_nama), '') AS sales_nama,
            p.pot_cus_kode,
            COALESCE(MAX(c.cus_kode), p.pot_cus_kode) AS customer_kode,
            COALESCE(MAX(c.cus_nama), '') AS cus_nama,
            COALESCE(MAX(c.cus_nama), '') AS customer_nama,
            p.pot_pen_nomor,
            p.pot_pen_nomor AS pen_nomor,
            COALESCE(p.pot_mspk_nomor, MAX(m.mspk_nomor), '') AS mspk_nomor,
            COALESCE(p.pot_mspk_nomor, MAX(m.mspk_nomor), '') AS pot_mspk_nomor,
            COALESCE(
                NULLIF(MAX(m.mspk_nama), ''),
                NULLIF(MAX(d.pend_nama_barang), ''),
                p.pot_nama_item
            ) AS pot_nama_item,
            COALESCE(
                NULLIF(MAX(m.mspk_nama), ''),
                NULLIF(MAX(d.pend_nama_barang), ''),
                p.pot_nama_item
            ) AS nama_item,
            p.pot_harga AS pot_harga_awal,
            COALESCE(
                NULLIF(MAX(COALESCE(m.Mspk_harga, 0) * COALESCE(m.Mspk_jumlah, 1)), 0),
                NULLIF(MAX(COALESCE(d.pend_harga, 0) * COALESCE(d.pend_qty, 1)), 0),
                p.pot_harga,
                0
            ) AS pot_harga,
            COALESCE(
                NULLIF(MAX(COALESCE(m.Mspk_harga, 0) * COALESCE(m.Mspk_jumlah, 1)), 0),
                NULLIF(MAX(COALESCE(d.pend_harga, 0) * COALESCE(d.pend_qty, 1)), 0),
                p.pot_harga,
                0
            ) AS harga,
            COALESCE(p.pot_status, 'POTENSI') AS pot_status,
            COALESCE(p.pot_status, 'POTENSI') AS status,
            COALESCE(p.pot_alasan_batal, '') AS pot_alasan_batal,
            COALESCE(p.pot_alasan_batal, '') AS alasan_batal,
            DATE_FORMAT(p.date_create, '%Y-%m-%d %H:%i:%s') AS pot_tanggal,
            DATE_FORMAT(p.date_create, '%Y-%m-%d %H:%i:%s') AS date_create,
            COALESCE(p.user_create, '') AS user_create
        FROM tpotensi p
        LEFT JOIN tmemospk m 
            ON (
                (p.pot_mspk_nomor IS NOT NULL AND m.mspk_nomor = p.pot_mspk_nomor)
                OR (
                    p.pot_pen_nomor IS NOT NULL 
                    AND m.mspk_pen_nomor = p.pot_pen_nomor 
                    AND (m.mspk_nama = p.pot_nama_item OR m.mspk_nama LIKE CONCAT('%', p.pot_nama_item, '%'))
                )
            )
            AND COALESCE(m.mspk_close, '') <> 'Y'
        LEFT JOIN tpenawaran_hdr h 
            ON h.pen_nomor = COALESCE(p.pot_pen_nomor, m.mspk_pen_nomor)
        LEFT JOIN tpenawaran_dtl d 
            ON d.pend_pen_nomor = h.pen_nomor 
           AND (d.pend_id = m.mspk_pen_id OR d.pend_nama_barang = p.pot_nama_item)
        LEFT JOIN tcustomer c 
            ON c.cus_kode = COALESCE(p.pot_cus_kode, m.mspk_cus_kode, h.pen_cus_kode) AND c.cus_aktif = 1
        LEFT JOIN tsales s 
            ON s.sal_kode = COALESCE(p.pot_sal_kode, m.mspk_sal_kode, h.pen_sal_kode)
        ${whereSql}
        GROUP BY 
            p.pot_nomor,
            p.pot_sal_kode,
            p.pot_cus_kode,
            p.pot_pen_nomor,
            p.pot_mspk_nomor,
            p.pot_nama_item,
            p.pot_harga,
            p.pot_status,
            p.pot_alasan_batal,
            p.date_create,
            p.user_create
        ORDER BY p.date_create DESC, p.pot_nomor DESC
        LIMIT 300
        `,
        params,
    );

    return {
        list: listRows || [],
    };
};

/**
 * Service: Membatalkan data potensi
 */
const batal = async ({
    potNomor,
    alasan,
    managerRole,
    authSalesKode,
    username = "SYSTEM",
}) => {
    const [rows] = await db.query(
        `
        SELECT pot_nomor, pot_sal_kode, pot_status 
        FROM tpotensi 
        WHERE pot_nomor = ? 
        LIMIT 1
        `,
        [potNomor],
    );

    if (!rows || rows.length === 0) {
        const error = new Error("Data potensi tidak ditemukan");
        error.statusCode = 404;
        throw error;
    }

    const potData = rows[0];

    if (potData.pot_status === "CLOSE") {
        const error = new Error(
            "Data potensi yang sudah CLOSE tidak dapat dibatalkan",
        );
        error.statusCode = 400;
        throw error;
    }

    if (!managerRole && potData.pot_sal_kode !== authSalesKode) {
        const error = new Error(
            "Anda tidak memiliki izin membatalkan potensi milik sales lain",
        );
        error.statusCode = 403;
        throw error;
    }

    await db.query(
        `
        UPDATE tpotensi 
        SET pot_status = 'BATAL',
            pot_alasan_batal = ?,
            user_modified = ?,
            date_modified = NOW()
        WHERE pot_nomor = ?
        `,
        [alasan, username, potNomor],
    );

    return { potNomor };
};

module.exports = {
    getKandidatList,
    createBatch,
    getList,
    batal,
};
