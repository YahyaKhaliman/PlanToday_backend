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
        FOR UPDATE
        `,
        [`${prefix}%`],
    );

    const last = toNumber(rows?.[0]?.max_num, 0);
    const next = String(last + 1).padStart(6, "0");
    return `${prefix}${next}`;
};

/**
 * Service: Mengambil daftar kandidat Penawaran & MAP yang belum masuk tpotensi
 * Diselaraskan dengan kriteria aplikasi Proyeksi Potensi Manksi Web:
 * - Penawaran: belum ada MAP aktif, belum selesai/close, dan belum ada di tpotensi aktif (cek pot_pend_id & nama)
 * - MAP: aktif, belum close, belum terbit SPK aktif, belum terbit SO aktif, dan belum ada di tpotensi aktif
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

    // Subquery untuk eliminasi penawaran yang seluruh detailnya sudah BATAL atau CLOSE (selaras Manksi Web)
    const selesaiPenawaranSubQuery = `
        SELECT pend_pen_nomor AS pen_nomor
        FROM tpenawaran_dtl
        GROUP BY pend_pen_nomor
        HAVING SUM(CASE WHEN pend_status NOT IN ('BATAL', 'CLOSE') THEN 1 ELSE 0 END) = 0
    `;

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
            ON c.cus_kode = h.pen_cus_kode
        LEFT JOIN (${selesaiPenawaranSubQuery}) sel 
            ON sel.pen_nomor = h.pen_nomor
        WHERE sel.pen_nomor IS NULL
          AND COALESCE(d.pend_nama_barang, '') <> ''
          AND COALESCE(h.pen_status, '') <> 'BATAL'
          AND COALESCE(d.pend_batal, '') <> 'Y'
          AND NOT EXISTS (
            SELECT 1 FROM tmemospk m 
            WHERE m.mspk_pen_nomor = h.pen_nomor 
              AND m.mspk_pen_id = d.pend_id
              AND m.mspk_aktif = 'Y'
          )
          AND NOT EXISTS (
            SELECT 1 FROM tpotensi p 
            WHERE p.pot_pen_nomor = h.pen_nomor 
              AND (
                (p.pot_pend_id IS NOT NULL AND p.pot_pend_id = d.pend_id)
                OR (p.pot_pend_id IS NULL AND TRIM(p.pot_nama_item) = TRIM(d.pend_nama_barang))
              )
              AND p.pot_status <> 'BATAL'
          )
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
            COALESCE(NULLIF(d.pend_qty, 0), NULLIF(m.mspk_rencana_order, 0), 1) AS qty,
            (COALESCE(NULLIF(d.pend_harga, 0), NULLIF(m.Mspk_harga, 0), 0) * COALESCE(NULLIF(d.pend_qty, 0), NULLIF(m.mspk_rencana_order, 0), 1)) AS harga,
            COALESCE(d.pend_satuan, 'PCS') AS satuan,
            COALESCE(d.pend_ukuran, m.Mspk_ukuran, '') AS ukuran,
            COALESCE(d.pend_bahan, m.Mspk_kain, '') AS bahan,
            DATE_FORMAT(m.mspk_tanggal, '%Y-%m-%d') AS tanggal,
            COALESCE(m.mspk_sal_kode, h.pen_sal_kode, '') AS sales_kode,
            COALESCE(s.sal_nama, '') AS sales_nama,
            COALESCE(m.mspk_cus_kode, h.pen_cus_kode, '') AS customer_kode,
            COALESCE(c.cus_nama, '') AS customer_nama,
            COALESCE(m.mspk_perush_kode, h.pen_perush_kode, 'KP') AS perush_kode,
            COALESCE(m.mspk_jo_kode, 'LL') AS jo_kode
        FROM tmemospk m
        LEFT JOIN tpenawaran_hdr h 
            ON h.pen_nomor = m.mspk_pen_nomor
        LEFT JOIN tpenawaran_dtl d 
            ON d.pend_pen_nomor = m.mspk_pen_nomor 
           AND d.pend_id = m.mspk_pen_id
        LEFT JOIN tsales s 
            ON s.sal_kode = COALESCE(m.mspk_sal_kode, h.pen_sal_kode, '')
        LEFT JOIN tcustomer c 
            ON c.cus_kode = COALESCE(m.mspk_cus_kode, h.pen_cus_kode, '')
        WHERE m.mspk_aktif = 'Y' 
          AND (m.mspk_close = 0 OR m.mspk_close = '0' OR m.mspk_close = 'N' OR m.mspk_close IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM tspk sp 
            WHERE sp.spk_memo = m.mspk_nomor AND sp.spk_aktif = 'Y'
          )
          AND NOT EXISTS (
            SELECT 1 FROM tsalesorder so 
            WHERE so.so_memo = m.mspk_nomor AND so.so_aktif = 'Y'
          )
          AND NOT EXISTS (
            SELECT 1 FROM tpotensi p_map 
            WHERE (
              p_map.pot_mspk_nomor = m.mspk_nomor 
              OR (
                m.mspk_pen_nomor IS NOT NULL 
                AND m.mspk_pen_nomor <> '' 
                AND p_map.pot_pen_nomor = m.mspk_pen_nomor
                AND (
                  (p_map.pot_pend_id IS NOT NULL AND m.mspk_pen_id IS NOT NULL AND p_map.pot_pend_id = m.mspk_pen_id)
                  OR (p_map.pot_pend_id IS NULL AND TRIM(p_map.pot_nama_item) = TRIM(m.mspk_nama))
                )
              )
            )
            AND p_map.pot_status <> 'BATAL'
          )
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
 * Menyimpan pot_pend_id agar dedupe key unik database aktif dan selaras dengan Manksi Web
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

            const rawPendId =
                item.pend_id !== undefined
                    ? item.pend_id
                    : (item.item_id !== undefined
                          ? item.item_id
                          : (item.pot_pend_id !== undefined
                                ? item.pot_pend_id
                                : null));
            const pendId =
                rawPendId !== null &&
                rawPendId !== "" &&
                !isNaN(Number(rawPendId))
                    ? Number(rawPendId)
                    : null;

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
            let perushKode = String(
                item.perush_kode || item.pot_perush_kode || "",
            ).trim();
            let joKode = String(
                item.jo_kode || item.pot_jo_kode || "",
            ).trim();

            if (!namaItem && !penNomor && !mspkNomor) continue;
            const namaItemFinal = namaItem || penNomor || mspkNomor;

            // Jika perushKode atau joKode kosong, ambil dari data sumber
            let sourcePenNomor = penNomor;
            let sourcePendId = pendId;

            if (mspkNomor) {
                const [mRows] = await conn.query(
                    `SELECT mspk_perush_kode, mspk_jo_kode, mspk_sal_kode, mspk_cus_kode, mspk_pen_nomor, mspk_pen_id, mspk_nama 
                     FROM tmemospk WHERE mspk_nomor = ? LIMIT 1`,
                    [mspkNomor],
                );
                if (mRows && mRows.length > 0) {
                    perushKode = perushKode || mRows[0].mspk_perush_kode || "KP";
                    joKode = joKode || mRows[0].mspk_jo_kode || "LL";
                    sourcePenNomor = sourcePenNomor || mRows[0].mspk_pen_nomor || null;
                    if (sourcePendId === null && mRows[0].mspk_pen_id !== null && !isNaN(Number(mRows[0].mspk_pen_id))) {
                        sourcePendId = Number(mRows[0].mspk_pen_id);
                    }
                }
            } else if (penNomor) {
                const [hRows] = await conn.query(
                    `SELECT pen_perush_kode, pen_sal_kode, pen_cus_kode FROM tpenawaran_hdr WHERE pen_nomor = ? LIMIT 1`,
                    [penNomor],
                );
                if (hRows && hRows.length > 0) {
                    perushKode = perushKode || hRows[0].pen_perush_kode || "KP";
                    joKode = joKode || "LL";
                }
            }

            perushKode = perushKode || "KP";
            joKode = joKode || "LL";

            // Cek pencegahan duplikasi di database (selaras Manksi Web) dengan FOR UPDATE
            let existRows = [];
            let isExistingPenawaranToLink = false;

            if (mspkNomor) {
                const [dup] = await conn.query(
                    `
                    SELECT pot_nomor, pot_pen_nomor, pot_pend_id, pot_mspk_nomor 
                    FROM tpotensi 
                    WHERE (
                        pot_mspk_nomor = ? 
                        OR (
                            ? IS NOT NULL AND ? <> '' AND pot_pen_nomor = ?
                            AND (
                                (? IS NOT NULL AND pot_pend_id = ?)
                                OR (pot_pend_id IS NULL AND TRIM(pot_nama_item) = TRIM(?))
                            )
                        )
                    )
                    AND pot_status <> 'BATAL' 
                    LIMIT 1 FOR UPDATE
                    `,
                    [
                        mspkNomor,
                        sourcePenNomor,
                        sourcePenNomor,
                        sourcePenNomor,
                        sourcePendId,
                        sourcePendId,
                        namaItemFinal,
                    ],
                );
                existRows = dup;

                if (existRows && existRows.length > 0 && !existRows[0].pot_mspk_nomor) {
                    isExistingPenawaranToLink = true;
                }
            } else if (penNomor) {
                const [dup] = await conn.query(
                    `
                    SELECT pot_nomor FROM tpotensi 
                    WHERE (
                        (
                            pot_pen_nomor = ? 
                            AND (
                                (? IS NOT NULL AND pot_pend_id = ?)
                                OR (? IS NULL AND TRIM(pot_nama_item) = TRIM(?))
                            )
                        )
                        OR (
                            pot_mspk_nomor IS NOT NULL 
                            AND pot_mspk_nomor IN (
                                SELECT mspk_nomor FROM tmemospk 
                                WHERE mspk_pen_nomor = ? 
                                  AND (mspk_pen_id = ? OR TRIM(mspk_nama) = TRIM(?))
                            )
                        )
                    )
                    AND pot_status <> 'BATAL' 
                    LIMIT 1 FOR UPDATE
                    `,
                    [penNomor, pendId, pendId, pendId, namaItemFinal, penNomor, pendId, namaItemFinal],
                );
                existRows = dup;
            }

            if (existRows && existRows.length > 0) {
                if (isExistingPenawaranToLink && mspkNomor) {
                    // Update baris potensi penawaran yang sudah ada agar terhubung ke MAP tanpa menduplikasi omset
                    await conn.query(
                        `UPDATE tpotensi 
                         SET pot_mspk_nomor = ?,
                             pot_harga = CASE WHEN ? > 0 THEN ? ELSE pot_harga END
                         WHERE pot_nomor = ?`,
                        [mspkNomor, harga, harga, existRows[0].pot_nomor],
                    );
                    createdList.push({
                        nomor: existRows[0].pot_nomor,
                        pot_nomor: existRows[0].pot_nomor,
                        action: "LINKED_MAP",
                    });
                }
                // Lewati INSERT baru agar tidak dobel
                continue;
            }

            const potNomor = await getNextPotensiNumber(
                conn,
                perushKode,
                joKode,
            );

            try {
                await conn.query(
                    `
                    INSERT INTO tpotensi (
                        pot_nomor,
                        pot_sal_kode,
                        pot_cus_kode,
                        pot_pen_nomor,
                        pot_pend_id,
                        pot_mspk_nomor,
                        pot_nama_item,
                        pot_harga,
                        pot_status,
                        pot_alasan_batal,
                        user_create,
                        date_create
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, ?, NOW())
                    `,
                    [
                        potNomor,
                        salKode,
                        cusKode,
                        penNomor,
                        pendId,
                        mspkNomor,
                        namaItemFinal,
                        harga,
                        username,
                    ],
                );

                createdList.push({
                    pot_nomor: potNomor,
                    nama_item: namaItemFinal,
                    harga: harga,
                });
            } catch (insertErr) {
                // Tangani bentrok duplikat dari UNIQUE KEY database jika ada request bersamaan
                if (insertErr.code === "ER_DUP_ENTRY") {
                    continue;
                }
                throw insertErr;
            }
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
            "(p.pot_sal_kode = ? OR s.sal_nama = ? OR s.sal_nama LIKE ?)",
        );
        params.push(
            effectiveSalesKode,
            effectiveSalesKode,
            `%${effectiveSalesKode}%`,
        );
    }

    if (search) {
        const like = `%${search}%`;
        whereClauses.push(`
            (
                p.pot_nomor LIKE ?
                OR p.pot_nama_item LIKE ?
                OR COALESCE(p.pot_pen_nomor, '') LIKE ?
                OR COALESCE(p.pot_mspk_nomor, '') LIKE ?
                OR COALESCE(c.cus_nama, '') LIKE ?
                OR COALESCE(s.sal_nama, '') LIKE ?
            )
        `);
        params.push(like, like, like, like, like, like);
    }

    const normalizedStatus = String(statusFilter || "ALL")
        .trim()
        .toUpperCase();
    if (normalizedStatus === "BATAL") {
        whereClauses.push("p.pot_status = 'BATAL'");
    } else if (normalizedStatus === "POTENSI" || normalizedStatus === "OPEN") {
        whereClauses.push("(p.pot_status IS NULL OR p.pot_status <> 'BATAL')");
    }

    const whereSql = `WHERE ${whereClauses.join(" AND ")}`;

    // 1. Query Potensi dengan left join dasar (Cepat & Non-Blocking)
    const [rawRows] = await db.query(
        `
        SELECT 
            p.pot_nomor,
            p.pot_sal_kode,
            COALESCE(s.sal_nama, '') AS sal_nama,
            p.pot_cus_kode,
            COALESCE(c.cus_nama, '') AS cus_nama,
            p.pot_pen_nomor,
            p.pot_pend_id,
            p.pot_mspk_nomor,
            p.pot_nama_item,
            p.pot_harga AS pot_harga_awal,
            p.pot_status,
            p.pot_alasan_batal,
            DATE_FORMAT(p.date_create, '%Y-%m-%d %H:%i:%s') AS pot_tanggal,
            DATE_FORMAT(p.date_create, '%Y-%m-%d %H:%i:%s') AS date_create,
            COALESCE(p.user_create, '') AS user_create,
            m_self.mspk_nama AS m_self_nama,
            m_self.mspk_harga AS m_self_harga,
            m_self.mspk_rencana_order AS m_self_qty,
            m_pen.mspk_nomor AS m_pen_nomor,
            m_pen.mspk_nama AS m_pen_nama,
            m_pen.mspk_harga AS m_pen_harga,
            m_pen.mspk_rencana_order AS m_pen_qty
        FROM tpotensi p
        LEFT JOIN tsales s ON s.sal_kode = p.pot_sal_kode
        LEFT JOIN tcustomer c ON c.cus_kode = p.pot_cus_kode
        LEFT JOIN tmemospk m_self 
            ON p.pot_mspk_nomor IS NOT NULL AND m_self.mspk_nomor = p.pot_mspk_nomor AND m_self.mspk_aktif = 'Y'
        LEFT JOIN tmemospk m_pen
            ON p.pot_pen_nomor IS NOT NULL
            AND m_pen.mspk_pen_nomor = p.pot_pen_nomor
            AND m_pen.mspk_pen_id = p.pot_pend_id
            AND m_pen.mspk_aktif = 'Y'
        ${whereSql}
        ORDER BY p.date_create DESC, p.pot_nomor DESC
        LIMIT 300
        `,
        params,
    );

    // Kumpulkan nomor MAP & Penawaran unik
    const allMemoNos = new Set();
    const penNos = new Set();
    for (const r of rawRows) {
        if (r.pot_mspk_nomor) allMemoNos.add(r.pot_mspk_nomor);
        if (r.m_pen_nomor) allMemoNos.add(r.m_pen_nomor);
        if (r.pot_pen_nomor && !r.m_pen_nomor) penNos.add(r.pot_pen_nomor);
    }

    // 2. Lacak revisi berantai MAP secara batch jika ada memo (selaras Manksi Web)
    let currentMemos = [...allMemoNos];
    const memoChainMap = new Map(); // parentMemo -> childMemo row

    if (currentMemos.length > 0) {
        for (let step = 0; step < 5; step++) {
            if (currentMemos.length === 0) break;
            const [revisions] = await db.query(
                `SELECT mspk_nomor, mspk_referensi, mspk_nama, mspk_harga, mspk_rencana_order 
                 FROM tmemospk 
                 WHERE mspk_aktif = 'Y' AND mspk_referensi IN (?)`,
                [currentMemos],
            );
            if (!revisions || revisions.length === 0) break;

            const nextMemos = [];
            for (const rev of revisions) {
                memoChainMap.set(rev.mspk_referensi, rev);
                allMemoNos.add(rev.mspk_nomor);
                nextMemos.push(rev.mspk_nomor);
            }
            currentMemos = nextMemos;
        }
    }

    // 3. Batch query realisasi ke SPK & SO (Non-Blocking)
    const memoReal = new Set();
    if (allMemoNos.size > 0) {
        const list = [...allMemoNos];
        const [found] = await db.query(
            `SELECT so_memo AS n FROM tsalesorder WHERE so_aktif = 'Y' AND so_memo IN (?)
             UNION
             SELECT spk_memo AS n FROM tspk WHERE spk_aktif = 'Y' AND spk_memo IN (?)`,
            [list, list],
        );
        for (const f of found) memoReal.add(f.n);
    }

    const penReal = new Set();
    if (penNos.size > 0) {
        const list = [...penNos];
        const [found] = await db.query(
            `SELECT spk_pen_nomor AS n FROM tspk WHERE spk_aktif = 'Y' AND spk_pen_nomor IN (?)
             UNION
             SELECT so_pen_nomor AS n FROM tsalesorder WHERE so_aktif = 'Y' AND so_pen_nomor IN (?)`,
            [list, list],
        );
        for (const f of found) penReal.add(f.n);
    }

    // 4. Resolve data di Javascript (Sangat cepat, <1ms)
    let listRows = rawRows.map((r) => {
        const baseMemo = r.m_pen_nomor || r.pot_mspk_nomor;
        const memoList = [];
        let curr = baseMemo;
        while (curr) {
            memoList.push(curr);
            const next = memoChainMap.get(curr);
            curr = next ? next.mspk_nomor : null;
        }

        const latestMemo =
            memoList.length > 1
                ? memoChainMap.get(memoList[memoList.length - 2]) || null
                : null;
        const topMemoNo =
            memoList.length > 0 ? memoList[memoList.length - 1] : null;

        const adaMemoReal = memoList.some((m) => memoReal.has(m));
        const adaPenReal =
            !!r.pot_pen_nomor && !r.m_pen_nomor && penReal.has(r.pot_pen_nomor);
        const isReal = adaMemoReal || adaPenReal ? 1 : 0;

        const resolvedNomor = topMemoNo || r.pot_pen_nomor || "";
        const resolvedNama =
            (latestMemo && latestMemo.mspk_nama) ||
            r.m_self_nama ||
            r.m_pen_nama ||
            r.pot_nama_item;

        let resolvedHarga = r.pot_harga_awal;
        if (
            latestMemo &&
            latestMemo.mspk_harga &&
            latestMemo.mspk_rencana_order
        ) {
            resolvedHarga =
                latestMemo.mspk_harga * latestMemo.mspk_rencana_order;
        } else if (r.m_self_harga && r.m_self_qty) {
            resolvedHarga = r.m_self_harga * r.m_self_qty;
        } else if (r.m_pen_harga && r.m_pen_qty) {
            resolvedHarga = r.m_pen_harga * r.m_pen_qty;
        }

        let statusFinal = "POTENSI";
        if (r.pot_status === "BATAL") {
            statusFinal = "BATAL";
        } else if (r.pot_status === "CLOSE" || isReal === 1) {
            statusFinal = "CLOSE";
        }

        const tipeSumber =
            r.pot_mspk_nomor || r.m_pen_nomor ? "MAP" : "PENAWARAN";

        return {
            pot_nomor: r.pot_nomor,
            pot_sal_kode: r.pot_sal_kode,
            sales_kode: r.pot_sal_kode,
            sal_nama: r.sal_nama,
            sales_nama: r.sal_nama,
            pot_cus_kode: r.pot_cus_kode,
            customer_kode: r.pot_cus_kode,
            cus_nama: r.cus_nama,
            customer_nama: r.cus_nama,
            pot_pen_nomor: r.pot_pen_nomor,
            pen_nomor: r.pot_pen_nomor,
            mspk_nomor: r.m_pen_nomor || r.pot_mspk_nomor || "",
            pot_mspk_nomor: r.m_pen_nomor || r.pot_mspk_nomor || "",
            tipe_sumber: tipeSumber,
            nomor_sumber: resolvedNomor,
            is_realisasi: isReal,
            pot_nama_item: resolvedNama,
            nama_item: resolvedNama,
            pot_harga_awal: toNumber(r.pot_harga_awal, 0),
            pot_harga: toNumber(resolvedHarga, 0),
            harga: toNumber(resolvedHarga, 0),
            pot_status: statusFinal,
            status: statusFinal,
            pot_alasan_batal: r.pot_alasan_batal || "",
            alasan_batal: r.pot_alasan_batal || "",
            pot_tanggal: r.pot_tanggal,
            date_create: r.date_create,
            user_create: r.user_create,
        };
    });

    if (normalizedStatus === "POTENSI" || normalizedStatus === "OPEN") {
        listRows = listRows.filter((r) => r.status === "POTENSI");
    } else if (normalizedStatus === "CLOSE") {
        listRows = listRows.filter((r) => r.status === "CLOSE");
    } else if (normalizedStatus === "BATAL") {
        listRows = listRows.filter((r) => r.status === "BATAL");
    }

    let availableSales = [];
    if (managerRole) {
        const [salesRows] = await db.query(
            "SELECT DISTINCT sal_nama FROM tsales WHERE sal_aktif = 'Y' AND sal_nama IS NOT NULL AND sal_nama <> '' ORDER BY sal_nama ASC",
        );
        availableSales = (salesRows || []).map((r) => r.sal_nama);
    } else {
        availableSales = Array.from(
            new Set(
                (listRows || [])
                    .map((r) => r.sal_nama || r.sales_nama)
                    .filter(Boolean),
            ),
        ).sort();
    }

    return {
        list: listRows || [],
        availableSales,
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
