const db = require("../config/dbPenawaran");
const {
    normalizeDate,
    getCurrentMonthRange,
    isManagerUser,
    getAuthSalesKode,
} = require("../utils/trackingHelper");

const getTrackingSpkList = async (req, res) => {
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
        const filterStatus = String(req.query.filterStatus || "").trim().toLowerCase();
        const params = [startDate, endDate];
        let ownerFilterSql = "";
        if (!managerRole) {
            ownerFilterSql = "AND COALESCE(s.spk_sal_kode, '') = ?";
            params.push(authSalesKode);
        }

        let filterStatusSql = "";
        if (filterStatus === "sudah") {
            filterStatusSql = "AND COALESCE((SELECT SUM(sjd.SJD_Jumlah) FROM tsj_dtl sjd WHERE sjd.SJD_SPK_Nomor = s.spk_nomor), 0) >= s.spk_jumlah";
        } else if (filterStatus === "proses") {
            filterStatusSql = "AND COALESCE((SELECT SUM(sjd.SJD_Jumlah) FROM tsj_dtl sjd WHERE sjd.SJD_SPK_Nomor = s.spk_nomor), 0) < s.spk_jumlah AND COALESCE((SELECT SUM(sjd.SJD_Jumlah) FROM tsj_dtl sjd WHERE sjd.SJD_SPK_Nomor = s.spk_nomor), 0) > 0";
        } else if (filterStatus === "belum") {
            filterStatusSql = "AND COALESCE((SELECT SUM(sjd.SJD_Jumlah) FROM tsj_dtl sjd WHERE sjd.SJD_SPK_Nomor = s.spk_nomor), 0) = 0";
        }

        let searchSql = "";

        if (search) {
            const like = `%${search}%`;
            searchSql += `
              AND (
                  s.spk_nomor LIKE ?
                  OR s.spk_nama LIKE ?
              )`;
            params.push(like, like);
        }

        const [dbRows] = await db.query(
            `
            SELECT
                s.spk_nomor,
                DATE_FORMAT(s.spk_tanggal, '%Y-%m-%d') AS spk_tanggal,
                s.spk_nama,
                s.spk_jumlah,
                (SELECT JSON_ARRAYAGG(JSON_OBJECT('tanggal', DATE_FORMAT(j.tanggal, '%Y-%m-%d'), 'jumlah', j.jumlah)) FROM tjadwalkirim j WHERE j.spk_nomor = s.spk_nomor) AS estimasi_list,
                (SELECT JSON_ARRAYAGG(JSON_OBJECT('tanggal', DATE_FORMAT(p.plan_tanggal, '%Y-%m-%d'), 'jumlah', p.plan_kirim)) FROM tplan_ppic_dtl2 p WHERE p.plan_spk = s.spk_nomor AND p.plan_kirim > 0) AS komitmen_list,
                (SELECT JSON_ARRAYAGG(JSON_OBJECT('tanggal', DATE_FORMAT(sj.SJ_Tanggal, '%Y-%m-%d'), 'jumlah', sjd.SJD_Jumlah)) FROM tsj_dtl sjd INNER JOIN tsj_hdr sj ON sj.SJ_Nomor = sjd.SJD_SJ_Nomor WHERE sjd.SJD_SPK_Nomor = s.spk_nomor) AS realisasi_list
            FROM tspk s
            WHERE s.spk_tanggal >= ?
              AND s.spk_tanggal <= ?
              AND COALESCE(s.spk_divisi, '') NOT IN ('3', '6')
              ${ownerFilterSql}
              ${searchSql}
              ${filterStatusSql}
            ORDER BY s.spk_tanggal DESC, s.spk_nomor DESC
            `,
            params,
        );

        const rows = dbRows.map((row) => {
            const parseList = (str) => {
                if (!str) return [];
                try {
                    return JSON.parse(str);
                } catch {
                    return [];
                }
            };

            const estimasiList = parseList(row.estimasi_list);
            const komitmenList = parseList(row.komitmen_list);
            const realisasiList = parseList(row.realisasi_list);

            return {
                spk_nomor: row.spk_nomor,
                spk_tanggal: row.spk_tanggal,
                spk_nama: row.spk_nama,
                spk_jumlah: row.spk_jumlah,
                estimasi_list: estimasiList,
                estimasi_total: estimasiList.reduce(
                    (acc, curr) => acc + (Number(curr.jumlah) || 0),
                    0,
                ),
                komitmen_list: komitmenList,
                komitmen_total: komitmenList.reduce(
                    (acc, curr) => acc + (Number(curr.jumlah) || 0),
                    0,
                ),
                realisasi_list: realisasiList,
                realisasi_total: realisasiList.reduce(
                    (acc, curr) => acc + (Number(curr.jumlah) || 0),
                    0,
                ),
            };
        });

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
        console.error("GET TRACKING SPK LIST ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengambil data tracking SPK",
        });
    }
};

const getTrackingSpkStatusCounts = async (req, res) => {
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
        let ownerFilterSql = "";
        if (!managerRole) {
            ownerFilterSql = "AND COALESCE(s.spk_sal_kode, '') = ?";
            params.push(authSalesKode);
        }

        const [rows] = await db.query(
            `
            SELECT 
                status_tracking,
                COUNT(*) AS jumlah
            FROM (
                SELECT
                    s.spk_nomor,
                    CASE 
                        WHEN COALESCE((SELECT SUM(sjd.SJD_Jumlah) FROM tsj_dtl sjd WHERE sjd.SJD_SPK_Nomor = s.spk_nomor), 0) = 0 THEN 'BELUM'
                        WHEN COALESCE((SELECT SUM(sjd.SJD_Jumlah) FROM tsj_dtl sjd WHERE sjd.SJD_SPK_Nomor = s.spk_nomor), 0) >= s.spk_jumlah THEN 'SUDAH'
                        ELSE 'PROSES'
                    END AS status_tracking
                FROM tspk s
                WHERE s.spk_tanggal >= ?
                  AND s.spk_tanggal <= ?
                  AND COALESCE(s.spk_divisi, '') NOT IN ('3', '6')
                  ${ownerFilterSql}
            ) t
            GROUP BY status_tracking
            `,
            params,
        );

        const statusMap = {
            BELUM: 0,
            PROSES: 0,
            SUDAH: 0
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
        console.error("GET TRACKING SPK STATUS COUNTS ERROR:", err);
        return res.status(500).json({
            success: false,
            message: err.message || "Gagal mengambil status counts SPK",
        });
    }
};

module.exports = {
    getTrackingSpkList,
    getTrackingSpkStatusCounts,
};
