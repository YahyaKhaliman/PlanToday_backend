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

const isManagerUser = (req) =>
    String(req.user?.jabatan || "")
        .trim()
        .toUpperCase() === "MANAGER";

const getAuthSalesKode = (req) => String(req.user?.sales_kode || "").trim();

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

        const params = [startDate, endDate];
        let ownerFilterSql = "";
        if (!managerRole) {
            ownerFilterSql = "AND COALESCE(h.pen_sal_kode, '') = ?";
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

        const [rows] = await db.query(
            `
            SELECT
                COALESCE(m.mspk_nomor, '') AS no_map,
                COALESCE(NULLIF(cm.cus_nama, ''), COALESCE(ch.cus_nama, '')) AS customer,
                COALESCE(NULLIF(cm.cus_alamat, ''), COALESCE(ch.cus_alamat, '')) AS alamat,
                DATE_FORMAT(m.mspk_tanggal, '%Y-%m-%d') AS tanggal_map,
                DATE_FORMAT(MAX(k.date_create), '%Y-%m-%d') AS tanggal_bast,
                DATE_FORMAT(MAX(sh.SJ_Tanggal), '%Y-%m-%d') AS tanggal_sj_map,
                MAX(COALESCE(sh.SJ_Nomor, '')) AS nomor_sj
            FROM tmemospk m
            INNER JOIN tpenawaran_hdr h
                ON h.pen_nomor = m.mspk_pen_nomor
            LEFT JOIN tcustomer ch
                ON ch.cus_kode = h.pen_cus_kode
            LEFT JOIN tcustomer cm
                ON cm.cus_kode = m.mspk_cus_kode
            LEFT JOIN tkesesuaianmap k
                ON TRIM(COALESCE(k.mspk_nomor, '')) = TRIM(COALESCE(m.mspk_nomor, ''))
            LEFT JOIN tsj_dtl_memo sd
                ON TRIM(COALESCE(sd.SJD_MSPK_Nomor, '')) = TRIM(COALESCE(m.mspk_nomor, ''))
            LEFT JOIN tsj_hdr_memo sh
                ON TRIM(COALESCE(sh.SJ_Nomor, '')) = TRIM(COALESCE(sd.SJD_SJ_Nomor, ''))
            WHERE m.mspk_tanggal >= ?
              AND m.mspk_tanggal <= ?
              ${ownerFilterSql}
              ${searchSql}
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

        return res.json({
            success: true,
            data: rows || [],
            meta: {
                startDate,
                endDate,
                search,
                count: rows?.length || 0,
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
