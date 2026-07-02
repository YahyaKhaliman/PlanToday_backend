const db = require("../config/dbPenawaran");
const {
    normalizeDate,
    getCurrentMonthRange,
    isManagerUser,
    getAuthSalesKode,
} = require("../utils/trackingHelper");


const getTrackingMapList = async (req, res) => {
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
        const search = String(req.query.search || "").trim();
        const sales = String(req.query.sales || "").trim();
        const filterBast = String(req.query.filterBast || "").trim().toLowerCase();
        const filterSjMap = String(req.query.filterSjMap || "").trim().toLowerCase();

        const params = [startDate, endDate];
        let ownerFilterSql = "";
        if (!managerRole) {
            ownerFilterSql = "AND COALESCE(h.pen_sal_kode, m.mspk_sal_kode, '') = ?";
            params.push(authSalesKode);
        }

        let searchSql = "";
        if (search) {
            const like = `%${search}%`;
            searchSql = `
                AND (
                    COALESCE(m.mspk_nomor, '') LIKE ?
                    OR COALESCE(ch.cus_nama, '') LIKE ?
                    OR COALESCE(ch.cus_alamat, '') LIKE ?
                    OR COALESCE(cm.cus_nama, '') LIKE ?
                    OR COALESCE(cm.cus_alamat, '') LIKE ?
                    OR COALESCE(sh.SJ_Nomor, '') LIKE ?
                )`;
            params.push(like, like, like, like, like, like);
        }

        if (sales) {
            searchSql += " AND COALESCE(s.sal_nama, '') LIKE ? ";
            params.push(`%${sales}%`);
        }

        let filterBastSql = "";
        if (filterBast === "belum") {
            filterBastSql = "AND k.mspk_nomor IS NULL";
        } else if (filterBast === "sudah") {
            filterBastSql = "AND k.mspk_nomor IS NOT NULL";
        }

        let filterSjMapSql = "";
        if (filterSjMap === "belum") {
            filterSjMapSql = "AND k.mspk_nomor IS NOT NULL AND sh.SJ_Nomor IS NULL";
        } else if (filterSjMap === "sudah") {
            filterSjMapSql = "AND sh.SJ_Nomor IS NOT NULL";
        }

        const [rows] = await db.query(
            `
            SELECT
                COALESCE(m.mspk_nomor, '') AS no_map,
                COALESCE(NULLIF(cm.cus_nama, ''), COALESCE(ch.cus_nama, '')) AS customer,
                COALESCE(NULLIF(cm.cus_alamat, ''), COALESCE(ch.cus_alamat, '')) AS alamat,
                DATE_FORMAT(m.mspk_tanggal, '%Y-%m-%d') AS tanggal_map,
                DATE_FORMAT(MAX(k.date_create), '%Y-%m-%d') AS tanggal_bast,
                DATE_FORMAT(MAX(sh.SJ_Tanggal), '%Y-%m-%d') AS tanggal_sj_map,
                MAX(COALESCE(sh.SJ_Nomor, '')) AS nomor_sj,
                MAX(COALESCE(m.mspk_nama, '')) AS mspk_nama,
                MAX(COALESCE(m.mspk_ukuran, '')) AS mspk_ukuran,
                MAX(COALESCE(m.mspk_kain, '')) AS mspk_kain,
                MAX(COALESCE(m.mspk_finishing, '')) AS mspk_finishing,
                MAX(COALESCE(m.mspk_keterangan, '')) AS mspk_keterangan,
                MAX(COALESCE(s.sal_nama, '')) AS sales
            FROM tmemospk m
            LEFT JOIN tpenawaran_hdr h
                ON h.pen_nomor = m.mspk_pen_nomor
            LEFT JOIN tsales s
                ON s.sal_kode = COALESCE(h.pen_sal_kode, m.mspk_sal_kode, '')
            LEFT JOIN tcustomer ch
                ON ch.cus_kode = h.pen_cus_kode
            LEFT JOIN tcustomer cm
                ON cm.cus_kode = m.mspk_cus_kode
            LEFT JOIN tkesesuaianmap k
                ON k.mspk_nomor = m.mspk_nomor
            LEFT JOIN tsj_dtl_memo sd
                ON sd.SJD_MSPK_Nomor = m.mspk_nomor
            LEFT JOIN tsj_hdr_memo sh
                ON sh.SJ_Nomor = sd.SJD_SJ_Nomor
            WHERE m.mspk_tanggal >= ?
              AND m.mspk_tanggal <= ?
              AND COALESCE(m.mspk_divisi, '') NOT IN ('3', '6')
              ${ownerFilterSql}
              ${searchSql}
              ${filterBastSql}
              ${filterSjMapSql}
            GROUP BY
                m.mspk_nomor,
                m.mspk_tanggal,
                h.pen_cus_kode,
                ch.cus_kode,
                ch.cus_nama,
                ch.cus_alamat,
                m.mspk_cus_kode,
                cm.cus_kode,
                cm.cus_nama,
                cm.cus_alamat
            ORDER BY m.mspk_tanggal DESC, m.mspk_nomor DESC
            `,
            params,
        );

        const filterParams = [startDate, endDate];
        let filterOwnerSql = "";
        if (!managerRole) {
            filterOwnerSql = "AND COALESCE(h.pen_sal_kode, m.mspk_sal_kode, '') = ?";
            filterParams.push(authSalesKode);
        }

        const [filterRows] = await db.query(
            `
            SELECT DISTINCT
                COALESCE(s.sal_nama, '') AS sales
            FROM tmemospk m
            LEFT JOIN tpenawaran_hdr h ON h.pen_nomor = m.mspk_pen_nomor
            LEFT JOIN tsales s ON s.sal_kode = COALESCE(h.pen_sal_kode, m.mspk_sal_kode, '')
            WHERE m.mspk_tanggal >= ? AND m.mspk_tanggal <= ?
              AND COALESCE(m.mspk_divisi, '') NOT IN ('3', '6')
              ${filterOwnerSql}
            `,
            filterParams
        );
        const availableSales = Array.from(new Set(filterRows.map(r => r.sales).filter(Boolean))).sort();

        return res.json({
            success: true,
            data: rows || [],
            meta: {
                startDate,
                endDate,
                search,
                count: rows?.length || 0,
                filter_options: {
                    sales: availableSales
                }
            },
        });
    } catch (err) {
        console.error("GET TRACKING MAP LIST ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengambil data tracking MAP",
        });
    }
};

module.exports = {
    getTrackingMapList,
};
