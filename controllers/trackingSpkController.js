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
        const limit = Math.min(
            Math.max(Number(req.query.limit) || 100, 1),
            300,
        );

        const params = [startDate, endDate];
        let ownerFilterSql = "";
        if (!managerRole) {
            ownerFilterSql = "AND COALESCE(s.spk_sal_kode, '') = ?";
            params.push(authSalesKode);
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

        params.push(limit);

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
              ${ownerFilterSql}
              ${searchSql}
            ORDER BY s.spk_tanggal DESC, s.spk_nomor DESC
            LIMIT ?
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

module.exports = {
    getTrackingSpkList,
};
