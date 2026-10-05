const potensiService = require("../services/potensiService");

const isManagerUser = (user) =>
    String(user?.jabatan || "")
        .trim()
        .toUpperCase() === "MANAGER";

const getAuthSalesKode = (req) =>
    String(req.user?.sales_kode || req.user?.kode || "").trim();

const normalizeDate = (val) => {
    if (!val) return null;
    const str = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    return null;
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

/**
 * GET /api/potensi/kandidat
 * Mengambil kandidat Penawaran (belum MAP) dan MAP (belum SO) yang belum masuk tpotensi
 */
const getPotensiKandidatList = async (req, res) => {
    try {
        const managerRole = isManagerUser(req.user);
        const authSalesKode = getAuthSalesKode(req);

        if (!managerRole && !authSalesKode) {
            return res.status(403).json({
                success: false,
                message: "Sales tidak valid (sales_kode kosong)",
            });
        }

        const data = await potensiService.getKandidatList({
            managerRole,
            authSalesKode,
            salesFilter: String(req.query.sales || "").trim(),
            search: String(req.query.search || "").trim(),
            sumberFilter: String(req.query.sumber || "ALL").trim().toUpperCase(),
        });

        return res.json({
            success: true,
            data,
        });
    } catch (err) {
        console.error("GET POTENSI KANDIDAT ERROR:", err);
        return res.status(err.statusCode || 500).json({
            success: false,
            message: err.sqlMessage || err.message || "Gagal mengambil daftar kandidat potensi",
        });
    }
};

/**
 * POST /api/potensi
 * Menyimpan batch item potensi yang dicentang oleh sales
 */
const createPotensiBatch = async (req, res) => {
    try {
        const managerRole = isManagerUser(req.user);
        const authSalesKode = getAuthSalesKode(req);
        const username = String(req.user?.nama || req.user?.username || "SYSTEM").trim();

        if (!managerRole && !authSalesKode) {
            return res.status(403).json({
                success: false,
                message: "Sales tidak valid (sales_kode kosong)",
            });
        }

        const items = Array.isArray(req.body?.items) ? req.body.items : [];
        if (items.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Tidak ada item potensi yang dipilih untuk disimpan",
            });
        }

        const createdList = await potensiService.createBatch({
            items,
            authSalesKode,
            username,
        });

        return res.json({
            success: true,
            message: `Berhasil menambahkan ${createdList.length} item ke daftar potensi`,
            data: createdList,
        });
    } catch (err) {
        console.error("CREATE POTENSI BATCH ERROR:", err);
        return res.status(err.statusCode || 500).json({
            success: false,
            message: err.sqlMessage || err.message || "Gagal menyimpan data potensi",
        });
    }
};

/**
 * GET /api/potensi
 * Mengambil daftar data tpotensi dengan filter tanggal, sales, status, dan KPI summary
 */
const getPotensiList = async (req, res) => {
    try {
        const managerRole = isManagerUser(req.user);
        const authSalesKode = getAuthSalesKode(req);

        if (!managerRole && !authSalesKode) {
            return res.status(403).json({
                success: false,
                message: "Sales tidak valid (sales_kode kosong)",
            });
        }

        const monthRange = getCurrentMonthRange();
        const startDate = normalizeDate(req.query.startDate) || monthRange.start;
        const endDate = normalizeDate(req.query.endDate) || monthRange.end;

        const result = await potensiService.getList({
            managerRole,
            authSalesKode,
            startDate,
            endDate,
            salesFilter: String(req.query.sales || "").trim(),
            search: String(req.query.search || "").trim(),
            statusFilter: String(req.query.status || "ALL").trim().toUpperCase(),
        });

        return res.json({
            success: true,
            data: result.list || [],
            meta: {
                startDate,
                endDate,
                count: (result.list || []).length,
                filter_options: {
                    sales: result.availableSales || [],
                },
            },
        });
    } catch (err) {
        console.error("GET POTENSI LIST ERROR:", err);
        return res.status(err.statusCode || 500).json({
            success: false,
            message: err.sqlMessage || err.message || "Gagal mengambil daftar potensi",
        });
    }
};

/**
 * POST /api/potensi/:pot_nomor/batal
 * Membatalkan potensi dengan input alasan wajib
 */
const batalPotensi = async (req, res) => {
    try {
        const managerRole = isManagerUser(req.user);
        const authSalesKode = getAuthSalesKode(req);
        const username = String(req.user?.nama || req.user?.username || "SYSTEM").trim();

        const potNomor = String(req.params.pot_nomor || "").trim();
        const alasan = String(req.body?.alasan || "").trim();

        if (!potNomor) {
            return res.status(400).json({
                success: false,
                message: "Nomor potensi tidak valid",
            });
        }

        if (!alasan || alasan.length < 3) {
            return res.status(400).json({
                success: false,
                message: "Alasan pembatalan wajib diisi (minimal 3 karakter)",
            });
        }

        await potensiService.batal({
            potNomor,
            alasan,
            managerRole,
            authSalesKode,
            username,
        });

        return res.json({
            success: true,
            message: `Potensi ${potNomor} berhasil dibatalkan`,
        });
    } catch (err) {
        console.error("BATAL POTENSI ERROR:", err);
        return res.status(err.statusCode || 500).json({
            success: false,
            message: err.sqlMessage || err.message || "Gagal membatalkan potensi",
        });
    }
};

module.exports = {
    getPotensiKandidatList,
    createPotensiBatch,
    getPotensiList,
    batalPotensi,
};
