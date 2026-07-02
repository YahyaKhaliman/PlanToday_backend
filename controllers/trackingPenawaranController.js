const db = require("../config/dbPenawaran");
const {
    normalizeDate,
    getCurrentMonthRange,
    isManagerUser,
    getAuthSalesKode,
} = require("../utils/trackingHelper");

const getUserCandidates = (req) => {
    const values = [req.user?.nama, req.user?.id]
        .map((v) => String(v || "").trim())
        .filter(Boolean);
    return Array.from(new Set(values));
};

const getTrackingPenawaranList = async (req, res) => {
    try {
        const managerRole = isManagerUser(req);
        const authSalesKode = getAuthSalesKode(req);
        const userCandidates = getUserCandidates(req);
        if (!managerRole && !authSalesKode) {
            return res.status(403).json({
                success: false,
                message: "Sales tidak valid (sales_kode kosong)",
            });
        }

        const monthRange = getCurrentMonthRange();
        const startDate =
            normalizeDate(req.query.startDate) || monthRange.start;
        const endDate = normalizeDate(req.query.endDate) || monthRange.end;
        const search = String(req.query.search || "").trim();
        const sales = String(req.query.sales || "").trim();
        const customer = String(req.query.customer || "").trim();
        const status = String(req.query.status || "").trim().toUpperCase();
        const params = [startDate, endDate];
        if (!managerRole) {
            params.unshift(authSalesKode);
        }
        let searchSql = "";

        if (search) {
            const like = `%${search}%`;
            searchSql += `
              AND (
                  h.pen_nomor LIKE ?
                  OR COALESCE(m.mspk_nomor, '') LIKE ?
                  OR COALESCE(sp.spk_nomor, '') LIKE ?
                  OR COALESCE(m.mspk_keterangan, '') LIKE ?
                  OR COALESCE(sp.spk_keterangan, '') LIKE ?
              )`;
            params.push(like, like, like, like, like);
        }
        if (sales) {
            searchSql += ` AND COALESCE(s.sal_nama, '') LIKE ? `;
            params.push(`%${sales}%`);
        }
        if (customer) {
            searchSql += ` AND COALESCE(c.cus_nama, '') LIKE ? `;
            params.push(`%${customer}%`);
        }

        let havingSql = "";
        if (status === "OPEN") {
            havingSql = "HAVING COUNT(DISTINCT CASE WHEN COALESCE(m.mspk_nomor, '') <> '' OR COALESCE(sp.spk_nomor, '') <> '' THEN d.pend_id END) = 0";
        } else if (status === "PARSIAL") {
            havingSql = "HAVING COUNT(DISTINCT CASE WHEN COALESCE(m.mspk_nomor, '') <> '' OR COALESCE(sp.spk_nomor, '') <> '' THEN d.pend_id END) > 0 AND COUNT(DISTINCT CASE WHEN COALESCE(m.mspk_nomor, '') <> '' OR COALESCE(sp.spk_nomor, '') <> '' THEN d.pend_id END) < COUNT(DISTINCT d.pend_id)";
        } else if (status === "CLOSE") {
            havingSql = "HAVING COUNT(DISTINCT CASE WHEN COALESCE(m.mspk_nomor, '') <> '' OR COALESCE(sp.spk_nomor, '') <> '' THEN d.pend_id END) = COUNT(DISTINCT d.pend_id)";
        }

        const ownerFilterSql = managerRole
            ? ""
            : "COALESCE(h.pen_sal_kode, '') = ?\n              AND ";

        const [rows] = await db.query(
            `
            SELECT
                h.pen_nomor AS no_penawaran,
                DATE_FORMAT(h.pen_tanggal, '%Y-%m-%d') AS tanggal_penawaran,
                COALESCE(c.cus_nama, '') AS customer,
                COALESCE(s.sal_nama, '') AS sales,
                COUNT(DISTINCT d.pend_id) AS total_item,
                COUNT(DISTINCT CASE WHEN COALESCE(m.mspk_nomor, '') <> '' OR COALESCE(sp.spk_nomor, '') <> '' THEN d.pend_id END) AS total_item_map,
                GROUP_CONCAT(DISTINCT NULLIF(COALESCE(m.mspk_nomor, sp.spk_nomor, ''), '') ORDER BY COALESCE(m.mspk_nomor, sp.spk_nomor) SEPARATOR ', ') AS no_map,
                MAX(COALESCE(NULLIF(m.mspk_statuskerja, ''), NULLIF(sp.spk_statuskerja, ''), '')) AS map_status,
                MAX(DATE_FORMAT(COALESCE(m.mspk_dateline, sp.spk_dateline), '%Y-%m-%d')) AS map_deadline,
                MAX(COALESCE(NULLIF(m.mspk_workshop, ''), NULLIF(sp.spk_workshop, ''), '')) AS map_workshop,
                MAX(COALESCE(NULLIF(m.mspk_keterangan, ''), NULLIF(sp.spk_keterangan, ''), '')) AS map_keterangan,
                MAX(COALESCE(NULLIF(m.mspk_kendala, ''), NULLIF(sp.spk_pending, ''), '')) AS map_kendala,
                CASE 
                    WHEN COUNT(DISTINCT CASE WHEN COALESCE(m.mspk_nomor, '') <> '' OR COALESCE(sp.spk_nomor, '') <> '' THEN d.pend_id END) = 0 THEN 'OPEN'
                    WHEN COUNT(DISTINCT CASE WHEN COALESCE(m.mspk_nomor, '') <> '' OR COALESCE(sp.spk_nomor, '') <> '' THEN d.pend_id END) = COUNT(DISTINCT d.pend_id) THEN 'CLOSE'
                    ELSE 'PARSIAL'
                END AS status_tracking
            FROM tpenawaran_hdr h
            INNER JOIN tpenawaran_dtl d
                ON d.pend_pen_nomor = h.pen_nomor
            LEFT JOIN tsales s
                ON s.sal_kode = h.pen_sal_kode
            LEFT JOIN tcustomer c
                ON c.cus_kode = h.pen_cus_kode
            LEFT JOIN tmemospk m
                ON m.mspk_pen_nomor = h.pen_nomor
               AND m.mspk_pen_id = d.pend_id
            LEFT JOIN (
                SELECT 
                    spk_pen_nomor,
                    spk_pen_id,
                    GROUP_CONCAT(DISTINCT spk_nomor SEPARATOR ', ') AS spk_nomor,
                    MAX(spk_nama) AS spk_nama,
                    MIN(spk_tanggal) AS spk_tanggal,
                    MAX(spk_dateline) AS spk_dateline,
                    MAX(spk_divisi) AS spk_divisi,
                    MAX(spk_perush_kode) AS spk_perush_kode,
                    MAX(spk_cus_kode) AS spk_cus_kode,
                    MAX(spk_workshop) AS spk_workshop,
                    MAX(spk_statuskerja) AS spk_statuskerja,
                    GROUP_CONCAT(DISTINCT spk_keterangan SEPARATOR '\n') AS spk_keterangan,
                    MAX(spk_pending) AS spk_pending,
                    MAX(spk_close) AS spk_close,
                    MAX(user_create) AS user_create,
                    MAX(user_modified) AS user_modified,
                    MAX(date_create) AS date_create,
                    MAX(date_modified) AS date_modified
                FROM tspk
                WHERE COALESCE(spk_pen_nomor, '') <> ''
                GROUP BY spk_pen_nomor, spk_pen_id
            ) sp
                ON sp.spk_pen_nomor = h.pen_nomor
               AND sp.spk_pen_id = d.pend_id
            WHERE ${ownerFilterSql}h.pen_tanggal >= ?
              AND h.pen_tanggal <= ?
              ${searchSql}
            GROUP BY h.pen_nomor, h.pen_tanggal, c.cus_nama, s.sal_nama
            ${havingSql}
            ORDER BY h.pen_tanggal DESC, h.pen_nomor DESC
            `,
            params,
        );

        const baseParams = [startDate, endDate];
        if (!managerRole) {
            baseParams.unshift(authSalesKode);
        }

        const [filterRows] = await db.query(
            `
            SELECT 
                COALESCE(s.sal_nama, '') AS sales,
                COALESCE(c.cus_nama, '') AS customer
            FROM tpenawaran_hdr h
            LEFT JOIN tsales s ON s.sal_kode = h.pen_sal_kode
            LEFT JOIN tcustomer c ON c.cus_kode = h.pen_cus_kode
            WHERE ${ownerFilterSql}h.pen_tanggal >= ? AND h.pen_tanggal <= ?
            `,
            baseParams
        );

        const availableSales = Array.from(new Set(filterRows.map(r => r.sales).filter(Boolean))).sort();
        const availableCustomers = Array.from(new Set(filterRows.map(r => r.customer).filter(Boolean))).sort();

        return res.json({
            success: true,
            data: rows || [],
            meta: {
                startDate,
                endDate,
                search,
                count: rows?.length || 0,
                filter_options: {
                    sales: availableSales,
                    customers: availableCustomers
                }
            },
        });
    } catch (err) {
        console.error("GET TRACKING PENAWARAN LIST ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengambil data tracking penawaran",
        });
    }
};

const getTrackingPenawaranDetailByNoPenawaran = async (req, res) => {
    try {
        const managerRole = isManagerUser(req);
        const authSalesKode = getAuthSalesKode(req);
        const userCandidates = getUserCandidates(req);
        if (!managerRole && !authSalesKode) {
            return res.status(403).json({
                success: false,
                message: "Sales tidak valid (sales_kode kosong)",
            });
        }

        const noPenawaran = String(
            req.params.noPenawaran || req.query.noPenawaran || "",
        ).trim();

        if (!noPenawaran) {
            return res.status(400).json({
                success: false,
                message: "No. penawaran tidak valid",
            });
        }

        const ownerFilterSql = managerRole
            ? ""
            : "AND COALESCE(h.pen_sal_kode, '') = ?";
        const [rows] = await db.query(
            `
            SELECT
                h.pen_nomor AS no_penawaran,
                d.pend_id AS pen_id,
                COALESCE(d.pend_urutan, 0) AS urutan,
                COALESCE(NULLIF(m.mspk_nomor, ''), NULLIF(sp.spk_nomor, ''), '') AS no_map,
                COALESCE(
                    NULLIF(m.mspk_nama, ''),
                    NULLIF(sp.spk_nama, ''),
                    NULLIF(d.pend_nama_barang, ''),
                    NULLIF(h.pen_keterangan, ''),
                    ''
                ) AS map_nama,
                DATE_FORMAT(COALESCE(m.mspk_tanggal, sp.spk_tanggal), '%Y-%m-%d') AS tanggal_map,
                DATE_FORMAT(COALESCE(m.mspk_dateline, sp.spk_dateline), '%Y-%m-%d') AS map_deadline,
                COALESCE(m.mspk_divisi, sp.spk_divisi, 0) AS map_divisi,
                COALESCE(NULLIF(m.mspk_perush_kode, ''), NULLIF(sp.spk_perush_kode, ''), '') AS map_perusahaan_kode,
                COALESCE(NULLIF(m.mspk_cus_kode, ''), NULLIF(sp.spk_cus_kode, ''), '') AS map_customer_kode,
                COALESCE(m.mspk_mh_nomor, '') AS no_permintaan,
                COALESCE(NULLIF(m.mspk_workshop, ''), NULLIF(sp.spk_workshop, ''), '') AS map_workshop,
                COALESCE(NULLIF(m.mspk_statuskerja, ''), NULLIF(sp.spk_statuskerja, ''), '') AS map_status,
                COALESCE(NULLIF(m.mspk_keterangan, ''), NULLIF(sp.spk_keterangan, ''), '') AS map_keterangan,
                COALESCE(NULLIF(m.mspk_kendala, ''), NULLIF(sp.spk_pending, ''), '') AS map_kendala,
                COALESCE(m.mspk_close, sp.spk_close, '') AS map_close,
                COALESCE(m.mspk_revisi, '') AS map_revisi,
                COALESCE(m.mspk_revisi_no, 0) AS map_revisi_no,
                COALESCE(NULLIF(m.user_create, ''), NULLIF(sp.user_create, ''), '') AS map_user_create,
                COALESCE(NULLIF(m.user_modified, ''), NULLIF(sp.user_modified, ''), '') AS map_user_modified,
                DATE_FORMAT(COALESCE(m.date_create, sp.date_create), '%Y-%m-%d %H:%i:%s') AS map_date_create,
                DATE_FORMAT(COALESCE(m.date_modified, sp.date_modified), '%Y-%m-%d %H:%i:%s') AS map_date_modified
            FROM tpenawaran_hdr h
            INNER JOIN tpenawaran_dtl d
                ON d.pend_pen_nomor = h.pen_nomor
            LEFT JOIN tmemospk m
                ON m.mspk_pen_nomor = h.pen_nomor
               AND m.mspk_pen_id = d.pend_id
            LEFT JOIN (
                SELECT 
                    spk_pen_nomor,
                    spk_pen_id,
                    GROUP_CONCAT(DISTINCT spk_nomor SEPARATOR ', ') AS spk_nomor,
                    MAX(spk_nama) AS spk_nama,
                    MIN(spk_tanggal) AS spk_tanggal,
                    MAX(spk_dateline) AS spk_dateline,
                    MAX(spk_divisi) AS spk_divisi,
                    MAX(spk_perush_kode) AS spk_perush_kode,
                    MAX(spk_cus_kode) AS spk_cus_kode,
                    MAX(spk_workshop) AS spk_workshop,
                    MAX(spk_statuskerja) AS spk_statuskerja,
                    GROUP_CONCAT(DISTINCT spk_keterangan SEPARATOR '\n') AS spk_keterangan,
                    MAX(spk_pending) AS spk_pending,
                    MAX(spk_close) AS spk_close,
                    MAX(user_create) AS user_create,
                    MAX(user_modified) AS user_modified,
                    MAX(date_create) AS date_create,
                    MAX(date_modified) AS date_modified
                FROM tspk
                WHERE COALESCE(spk_pen_nomor, '') <> ''
                GROUP BY spk_pen_nomor, spk_pen_id
            ) sp
                ON sp.spk_pen_nomor = h.pen_nomor
               AND sp.spk_pen_id = d.pend_id
            WHERE h.pen_nomor = ?
              ${ownerFilterSql}
            ORDER BY d.pend_urutan, d.pend_id
            `,
            managerRole ? [noPenawaran] : [noPenawaran, authSalesKode],
        );

        if (!rows || rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Data tracking penawaran tidak ditemukan",
            });
        }

        const mapDetails = rows.map((row) => ({
            pen_id: row.pen_id,
            no_map: row.no_map,
            map_nama: row.map_nama,
            tanggal_map: row.tanggal_map,
            map_deadline: row.map_deadline,
            map_divisi: row.map_divisi,
            map_status: row.map_status,
            map_workshop: row.map_workshop,
            map_close: row.map_close,
            map_keterangan: row.map_keterangan,
            map_kendala: row.map_kendala,
        }));

        const uniqueMapNumbers = Array.from(
            new Set(
                rows.map((r) => String(r.no_map || "").trim()).filter(Boolean),
            ),
        );

        const header = {
            no_penawaran: rows[0].no_penawaran,
        };

        const firstWithReference =
            rows.find(
                (r) =>
                    String(r.no_permintaan || "").trim() ||
                    String(r.map_perusahaan_kode || "").trim() ||
                    String(r.map_customer_kode || "").trim(),
            ) || rows[0];

        const firstWithRevision =
            rows.find(
                (r) =>
                    String(r.map_revisi || "").trim() ||
                    Number(r.map_revisi_no || 0) > 0,
            ) || rows[0];

        const latestAuditRow =
            [...rows].sort((a, b) => {
                const da = new Date(
                    a.map_date_modified || a.map_date_create || 0,
                ).getTime();
                const dbb = new Date(
                    b.map_date_modified || b.map_date_create || 0,
                ).getTime();
                return dbb - da;
            })[0] || rows[0];

        return res.json({
            success: true,
            data: {
                header,
                summary: {
                    total_map_item: mapDetails.length,
                    total_map_number: uniqueMapNumbers.length,
                    map_numbers: uniqueMapNumbers,
                },
                map_details: mapDetails,
                meta_optional: {
                    references: {
                        no_permintaan: firstWithReference?.no_permintaan || "",
                        map_divisi: firstWithReference?.map_divisi || 0,
                        map_perusahaan_kode:
                            firstWithReference?.map_perusahaan_kode || "",
                        map_customer_kode:
                            firstWithReference?.map_customer_kode || "",
                    },
                    revision: {
                        map_revisi: firstWithRevision?.map_revisi || "",
                        map_revisi_no: firstWithRevision?.map_revisi_no || 0,
                    },
                    audit: {
                        map_user_create: latestAuditRow?.map_user_create || "",
                        map_user_modified:
                            latestAuditRow?.map_user_modified || "",
                        map_date_create:
                            latestAuditRow?.map_date_create || null,
                        map_date_modified:
                            latestAuditRow?.map_date_modified || null,
                    },
                },
            },
        });
    } catch (err) {
        console.error("GET TRACKING PENAWARAN DETAIL ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengambil detail tracking penawaran",
        });
    }
};

const getTrackingPenawaranStatusCounts = async (req, res) => {
    try {
        const managerRole = isManagerUser(req);
        const authSalesKode = getAuthSalesKode(req);
        if (!managerRole && !authSalesKode) {
            return res.status(403).json({
                success: false,
                message: "Sales tidak valid (sales_kode kosong)",
            });
        }

        const monthRange = getCurrentMonthRange();
        const startDate =
            normalizeDate(req.query.startDate) || monthRange.start;
        const endDate = normalizeDate(req.query.endDate) || monthRange.end;

        const params = [startDate, endDate];
        if (!managerRole) {
            params.unshift(authSalesKode);
        }

        const ownerFilterSql = managerRole
            ? ""
            : "COALESCE(h.pen_sal_kode, '') = ? AND ";

        const [rows] = await db.query(
            `
            SELECT 
                status_tracking,
                COUNT(*) AS jumlah
            FROM (
                SELECT
                    h.pen_nomor,
                    CASE 
                        WHEN COUNT(DISTINCT CASE WHEN COALESCE(m.mspk_nomor, '') <> '' OR COALESCE(sp.spk_nomor, '') <> '' THEN d.pend_id END) = 0 THEN 'OPEN'
                        WHEN COUNT(DISTINCT CASE WHEN COALESCE(m.mspk_nomor, '') <> '' OR COALESCE(sp.spk_nomor, '') <> '' THEN d.pend_id END) = COUNT(DISTINCT d.pend_id) THEN 'CLOSE'
                        ELSE 'PARSIAL'
                    END AS status_tracking
                FROM tpenawaran_hdr h
                INNER JOIN tpenawaran_dtl d
                    ON d.pend_pen_nomor = h.pen_nomor
                LEFT JOIN tmemospk m
                    ON m.mspk_pen_nomor = h.pen_nomor
                   AND m.mspk_pen_id = d.pend_id
                LEFT JOIN (
                    SELECT 
                        spk_pen_nomor,
                        spk_pen_id,
                        GROUP_CONCAT(DISTINCT spk_nomor SEPARATOR ', ') AS spk_nomor,
                        MAX(spk_nama) AS spk_nama,
                        MIN(spk_tanggal) AS spk_tanggal,
                        MAX(spk_dateline) AS spk_dateline,
                        MAX(spk_divisi) AS spk_divisi,
                        MAX(spk_perush_kode) AS spk_perush_kode,
                        MAX(spk_cus_kode) AS spk_cus_kode,
                        MAX(spk_workshop) AS spk_workshop,
                        MAX(spk_statuskerja) AS spk_statuskerja,
                        GROUP_CONCAT(DISTINCT spk_keterangan SEPARATOR '\n') AS spk_keterangan,
                        MAX(spk_pending) AS spk_pending,
                        MAX(spk_close) AS spk_close,
                        MAX(user_create) AS user_create,
                        MAX(user_modified) AS user_modified,
                        MAX(date_create) AS date_create,
                        MAX(date_modified) AS date_modified
                    FROM tspk
                    WHERE COALESCE(spk_pen_nomor, '') <> ''
                    GROUP BY spk_pen_nomor, spk_pen_id
                ) sp
                    ON sp.spk_pen_nomor = h.pen_nomor
                   AND sp.spk_pen_id = d.pend_id
                WHERE ${ownerFilterSql}h.pen_tanggal >= ?
                  AND h.pen_tanggal <= ?
                GROUP BY h.pen_nomor
            ) t
            GROUP BY status_tracking
            `,
            params,
        );

        const statusMap = {
            OPEN: 0,
            PARSIAL: 0,
            CLOSE: 0
        };

        for (const row of rows || []) {
            const statusKey = String(row?.status_tracking || "").trim().toUpperCase();
            if (statusKey in statusMap) {
                statusMap[statusKey] = Number(row?.jumlah || 0);
            }
        }

        return res.json({
            success: true,
            data: statusMap
        });
    } catch (err) {
        console.error("GET TRACKING PENAWARAN STATUS COUNTS ERROR:", err);
        return res.status(500).json({
            success: false,
            message: err.message || "Gagal mengambil status counts penawaran",
        });
    }
};

module.exports = {
    getTrackingPenawaranList,
    getTrackingPenawaranDetailByNoPenawaran,
    getTrackingPenawaranStatusCounts,
};
