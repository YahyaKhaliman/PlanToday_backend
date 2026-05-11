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

const getUserCandidates = (req) => {
    const values = [req.user?.nama, req.user?.id]
        .map((v) => String(v || "").trim())
        .filter(Boolean);
    return Array.from(new Set(values));
};

const isManagerUser = (req) =>
    String(req.user?.jabatan || "")
        .trim()
        .toUpperCase() === "MANAGER";

const getAuthSalesKode = (req) => String(req.user?.sales_kode || "").trim();

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
        const limit = Math.min(
            Math.max(Number(req.query.limit) || 100, 1),
            300,
        );

        const params = [startDate, endDate];
        if (!managerRole) {
            params.unshift(authSalesKode);
        }
        let searchSql = "";

        if (search) {
            const like = `%${search}%`;
            searchSql = `
              AND (
                  h.pen_nomor LIKE ?
                  OR COALESCE(m.mspk_nomor, '') LIKE ?
                  OR COALESCE(m.mspk_keterangan, '') LIKE ?
              )`;
            params.push(like, like, like);
        }

        params.push(limit);

        const ownerFilterSql = managerRole
            ? ""
            : "COALESCE(h.pen_sal_kode, '') = ?\n              AND ";

        const [rows] = await db.query(
            `
            SELECT
                h.pen_nomor AS no_penawaran,
                DATE_FORMAT(h.pen_tanggal, '%Y-%m-%d') AS tanggal_penawaran,
                COALESCE(c.cus_nama, '') AS customer,
                COUNT(DISTINCT d.pend_id) AS total_item,
                COUNT(DISTINCT CASE WHEN COALESCE(m.mspk_nomor, '') <> '' THEN d.pend_id END) AS total_item_map,
                GROUP_CONCAT(DISTINCT NULLIF(COALESCE(m.mspk_nomor, ''), '') ORDER BY m.mspk_nomor SEPARATOR ', ') AS no_map,
                MAX(COALESCE(m.mspk_statuskerja, '')) AS map_status,
                MAX(DATE_FORMAT(m.mspk_dateline, '%Y-%m-%d')) AS map_deadline,
                MAX(COALESCE(m.mspk_workshop, '')) AS map_workshop,
                MAX(COALESCE(m.mspk_keterangan, '')) AS map_keterangan,
                MAX(COALESCE(m.mspk_kendala, '')) AS map_kendala
            FROM tpenawaran_hdr h
            INNER JOIN tpenawaran_dtl d
                ON d.pend_pen_nomor = h.pen_nomor
            LEFT JOIN tcustomer c
                ON c.cus_kode = h.pen_cus_kode
            LEFT JOIN tmemospk m
                ON m.mspk_pen_nomor = h.pen_nomor
               AND m.mspk_pen_id = d.pend_id
            WHERE ${ownerFilterSql}h.pen_tanggal >= ?
              AND h.pen_tanggal <= ?
              ${searchSql}
            GROUP BY h.pen_nomor, h.pen_tanggal
            ORDER BY h.pen_tanggal DESC, h.pen_nomor DESC
            LIMIT ?
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
                COALESCE(m.mspk_nomor, '') AS no_map,
                COALESCE(
                    NULLIF(m.mspk_nama, ''),
                    NULLIF(d.pend_nama_barang, ''),
                    NULLIF(h.pen_keterangan, ''),
                    ''
                ) AS map_nama,
                DATE_FORMAT(m.mspk_tanggal, '%Y-%m-%d') AS tanggal_map,
                DATE_FORMAT(m.mspk_dateline, '%Y-%m-%d') AS map_deadline,
                COALESCE(m.mspk_divisi, 0) AS map_divisi,
                COALESCE(m.mspk_perush_kode, '') AS map_perusahaan_kode,
                COALESCE(m.mspk_cus_kode, '') AS map_customer_kode,
                COALESCE(m.mspk_mh_nomor, '') AS no_permintaan,
                COALESCE(m.mspk_workshop, '') AS map_workshop,
                COALESCE(m.mspk_statuskerja, '') AS map_status,
                COALESCE(m.mspk_keterangan, '') AS map_keterangan,
                COALESCE(m.mspk_kendala, '') AS map_kendala,
                COALESCE(m.mspk_close, '') AS map_close,
                COALESCE(m.mspk_revisi, '') AS map_revisi,
                COALESCE(m.mspk_revisi_no, 0) AS map_revisi_no,
                COALESCE(m.user_create, '') AS map_user_create,
                COALESCE(m.user_modified, '') AS map_user_modified,
                DATE_FORMAT(m.date_create, '%Y-%m-%d %H:%i:%s') AS map_date_create,
                DATE_FORMAT(m.date_modified, '%Y-%m-%d %H:%i:%s') AS map_date_modified
            FROM tpenawaran_hdr h
            INNER JOIN tpenawaran_dtl d
                ON d.pend_pen_nomor = h.pen_nomor
            LEFT JOIN tmemospk m
                ON m.mspk_pen_nomor = h.pen_nomor
               AND m.mspk_pen_id = d.pend_id
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

module.exports = {
    getTrackingPenawaranList,
    getTrackingPenawaranDetailByNoPenawaran,
};
