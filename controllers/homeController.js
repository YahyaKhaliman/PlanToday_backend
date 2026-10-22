const homeService = require("../services/homeService");

function getPublicBaseUrl(req) {
    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers["x-forwarded-host"] || req.get("host");
    return `${proto}://${host}`;
}

const calonCustomer = async (req, res) => {
    try {
        const result = await homeService.calonCustomer(req.body || {});
        return res.status(result.status).json(result.body);
    } catch (err) {
        console.error(err);
        return res.status(500).json({
            success: false,
            message: "Gagal menyimpan calon customer",
        });
    }
};

const updateCalonCustomerByKode = async (req, res) => {
    try {
        const cc_kode = String(req.params.cc_kode || "").trim();
        const result = await homeService.updateCalonCustomerByKode({
            cc_kode,
            body: req.body || {},
        });
        return res.status(result.status).json(result.body);
    } catch (err) {
        console.error("UPDATE CUSTOMER ERROR:", err);
        return res
            .status(500)
            .json({ success: false, message: err.sqlMessage || err.message });
    }
};

const getCabang = async (req, res) => {
    const { jabatan, cabang, nama } = req.query;

    try {
        const data = await homeService.getCabang({ jabatan, nama });
        return res.json({
            success: true,
            data,
        });
    } catch (err) {
        console.error("INIT VISIT PLAN ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal mengambil data",
        });
    }
};

const cariCustomer = async (req, res) => {
    try {
        const search = String(req.query.search ?? "").trim();

        if (!search) {
            return res.status(400).json({
                success: false,
                message: "Parameter search wajib diisi",
            });
        }

        const rows = await homeService.cariCustomer(search);
        return res.json({ success: true, data: rows });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

const createVisitPlan = async (req, res) => {
    try {
        const cus_kode = String(req.body.cus_kode || "").trim();
        const user = String(req.body.user || "").trim();
        const tanggal_plan = String(req.body.tanggal_plan || "")
            .trim()
            .slice(0, 10);
        const note = String(req.body.note || "").trim();
        const latitude = req.body.latitude != null ? req.body.latitude : null;
        const longitude = req.body.longitude != null ? req.body.longitude : null;

        const result = await homeService.createVisitPlan({
            cus_kode,
            user,
            tanggal_plan,
            note,
            latitude,
            longitude,
        });

        return res.status(result.status).json(result.body);
    } catch (err) {
        console.error("CREATE VISIT PLAN ERROR:", err);
        return res
            .status(500)
            .json({ success: false, message: err.sqlMessage || err.message });
    }
};

const visitPlanById = async (req, res) => {
    const { user, tanggal, cus_kode } = req.query;

    if (!user || !tanggal || !cus_kode) {
        return res.status(400).json({
            success: false,
            message: "user, tanggal, cus_kode wajib",
        });
    }

    try {
        const data = await homeService.visitPlanById({ user, tanggal, cus_kode });
        return res.json({ success: true, data });
    } catch (err) {
        console.error("GET VISIT PLAN DETAIL ERROR:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const updateVisitPlan = async (req, res) => {
    const { id } = req.params;
    const { tanggal_plan, note, catatan, latitude, longitude } = req.body;

    try {
        const result = await homeService.updateVisitPlan({
            id,
            tanggal_plan,
            note,
            catatan,
            latitude: latitude != null ? latitude : null,
            longitude: longitude != null ? longitude : null,
        });
        return res.status(result.status).json(result.body);
    } catch (err) {
        console.error("UPDATE VISIT PLAN ERROR:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const createVisit = async (req, res) => {
    const user = String(req.body.user || "").trim();
    const cus_kode = String(req.body.cus_kode || "").trim();
    const tanggal = String(req.body.tanggal || "").trim();
    const note = String(req.body.note || "").trim();
    const catatan = String(req.body.catatan || "").trim();
    const latitude = req.body.latitude || null;
    const longitude = req.body.longitude || null;

    try {
        const result = await homeService.createVisit({
            user,
            cus_kode,
            tanggal,
            note,
            catatan,
            latitude,
            longitude,
        });
        return res.status(result.status).json(result.body);
    } catch (err) {
        console.error("CREATE VISIT UPSERT ERROR:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const getVisitFromPlan = async (req, res) => {
    const user = String(req.query.user || "").trim();
    const cus_kode = String(req.query.cus_kode || "").trim();
    const tanggal = String(req.query.tanggal || "")
        .trim()
        .slice(0, 10);

    if (!user || !cus_kode || !tanggal) {
        return res
            .status(400)
            .json({ success: false, message: "user, cus_kode, tanggal wajib" });
    }

    try {
        const data = await homeService.getVisitFromPlan({ user, cus_kode, tanggal });
        return res.json({ success: true, data });
    } catch (err) {
        console.error("GET VISIT FROM PLAN ERROR:", err);
        return res
            .status(500)
            .json({ success: false, message: err.sqlMessage || err.message });
    }
};

const getVisitDraft = async (req, res) => {
    const user = String(req.query.user || "").trim();
    const cus_kode = String(req.query.cus_kode || "").trim();
    const tanggal = String(req.query.tanggal || "").trim();

    if (!user || !cus_kode || !tanggal) {
        return res
            .status(400)
            .json({ success: false, message: "user, cus_kode, tanggal wajib" });
    }

    try {
        const data = await homeService.getVisitDraft({ user, cus_kode, tanggal });
        return res.json({ success: true, data });
    } catch (err) {
        console.error("GET VISIT DRAFT ERROR:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const updateVisit = async (req, res) => {
    const { id } = req.params;
    const { note, catatan, tanggal, latitude, longitude } = req.body;

    try {
        const result = await homeService.updateVisit({
            id,
            note,
            catatan,
            tanggal,
            latitude,
            longitude,
        });
        return res.status(result.status).json(result.body);
    } catch (err) {
        console.error("UPDATE VISIT ERROR:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const uploadVisitPhoto = async (req, res) => {
    const { id } = req.params;

    try {
        const result = await homeService.uploadVisitPhoto({
            id,
            file: req.file,
        });
        return res.status(result.status).json(result.body);
    } catch (err) {
        console.error("UPLOAD PHOTO ERROR:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const getRekapVisit = async (req, res) => {
    const user = String(req.query.user || "").trim();
    const tanggal = String(req.query.tanggal || "").trim();
    const tanggalAwal = String(req.query.tanggal_awal || "").trim();
    const tanggalAkhir = String(req.query.tanggal_akhir || "").trim();
    const cabang = String(req.query.cabang || "")
        .trim()
        .toUpperCase();

    if (!user) {
        return res
            .status(400)
            .json({ success: false, message: "User wajib diisi" });
    }

    const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

    let start = "";
    let end = "";

    if (tanggal) {
        if (!isYmd(tanggal)) {
            return res.status(400).json({
                success: false,
                message: "format tanggal harus YYYY-MM-DD",
            });
        }
        start = tanggal;
        end = tanggal;
    } else if (tanggalAwal && tanggalAkhir) {
        if (!isYmd(tanggalAwal) || !isYmd(tanggalAkhir)) {
            return res.status(400).json({
                success: false,
                message: "format tanggal_awal & tanggal_akhir harus YYYY-MM-DD",
            });
        }
        start = tanggalAwal <= tanggalAkhir ? tanggalAwal : tanggalAkhir;
        end = tanggalAwal <= tanggalAkhir ? tanggalAkhir : tanggalAwal;
    } else {
        return res.status(400).json({
            success: false,
            message:
                "Tanggal wajib diisi (tanggal) atau (tanggal_awal & tanggal_akhir)",
        });
    }

    try {
        const publicBaseUrl =
            process.env.PUBLIC_BASE_URL || getPublicBaseUrl(req);
        const rows = await homeService.getRekapVisit({
            user,
            start,
            end,
            cabang,
            publicBaseUrl,
        });
        return res.json({ success: true, data: rows });
    } catch (err) {
        console.error("GET REKAP VISIT ERROR:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const rekapVisitWA = async (req, res) => {
    const user = String(req.query.user || "").trim();
    const cabang = String(req.query.cabang || "").trim();
    const tanggal = String(req.query.tanggal || "").trim();
    const tanggalAwal = String(req.query.tanggal_awal || "").trim();
    const tanggalAkhir = String(req.query.tanggal_akhir || "").trim();

    if (!user) {
        return res
            .status(400)
            .json({ success: false, message: "Parameter user wajib diisi" });
    }

    const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

    let start = "";
    let end = "";

    if (tanggal) {
        if (!isYmd(tanggal))
            return res.status(400).json({
                success: false,
                message: "format tanggal harus YYYY-MM-DD",
            });
        start = tanggal;
        end = tanggal;
    } else if (tanggalAwal && tanggalAkhir) {
        if (!isYmd(tanggalAwal) || !isYmd(tanggalAkhir)) {
            return res.status(400).json({
                success: false,
                message: "format tanggal_awal & tanggal_akhir harus YYYY-MM-DD",
            });
        }
        start = tanggalAwal <= tanggalAkhir ? tanggalAwal : tanggalAkhir;
        end = tanggalAwal <= tanggalAkhir ? tanggalAkhir : tanggalAwal;
    } else {
        return res.status(400).json({
            success: false,
            message: "Isi tanggal atau tanggal_awal & tanggal_akhir",
        });
    }

    try {
        const text = await homeService.rekapVisitWA({
            user,
            start,
            end,
            cabang,
        });

        if (!text) {
            return res.json({ success: true, wa_text: "" });
        }

        return res.json({ success: true, wa_text: text });
    } catch (err) {
        console.error("REKAP VISIT WA ERROR:", err);
        return res.status(500).json({
            success: false,
            message: err?.message || "Gagal membuat rekap WA",
        });
    }
};

const updateRekapVisit = async (req, res) => {
    const { id } = req.params;
    const { note } = req.body;

    if (!id) {
        return res
            .status(400)
            .json({ success: false, message: "ID tidak valid" });
    }

    try {
        await homeService.updateRekapVisit({ id, note });
        return res.json({
            success: true,
            message: "Catatan keperluan berhasil diperbarui",
        });
    } catch (err) {
        console.error("UPDATE NOTE ERROR:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const getRekapVisitPlan = async (req, res) => {
    const { user, cabang, tanggal_awal, tanggal_akhir, is_manager } = req.query;

    if (!tanggal_awal || !tanggal_akhir) {
        return res.status(400).json({
            success: false,
            message: "Parameter tanggal_awal dan tanggal_akhir wajib diisi",
        });
    }

    try {
        const publicBaseUrl =
            process.env.PUBLIC_BASE_URL || getPublicBaseUrl(req);
        const isManagerMode = is_manager === "true";

        if (!isManagerMode && !user) {
            return res.status(400).json({
                success: false,
                message: "Parameter user wajib diisi untuk mode non-manager",
            });
        }

        const rows = await homeService.getRekapVisitPlan({
            user,
            cabang,
            tanggal_awal,
            tanggal_akhir,
            isManagerMode,
            publicBaseUrl,
        });

        return res.json({ success: true, data: rows || [] });
    } catch (err) {
        console.error("REKAP VISIT PLAN ERROR:", err);
        return res
            .status(500)
            .json({ success: false, message: err.sqlMessage || err.message });
    }
};

const rekapVisitPlanWA = async (req, res) => {
    const user = String(req.query.user || "").trim();
    const cabang = String(req.query.cabang || "").trim();
    const tanggal = String(req.query.tanggal || "").trim();
    const tanggalAwal = String(req.query.tanggal_awal || "").trim();
    const tanggalAkhir = String(req.query.tanggal_akhir || "").trim();

    if (!user) {
        return res
            .status(400)
            .json({ success: false, message: "Parameter user wajib diisi" });
    }

    const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

    let start = "";
    let end = "";

    if (tanggal) {
        if (!isYmd(tanggal)) {
            return res.status(400).json({
                success: false,
                message: "format tanggal harus YYYY-MM-DD",
            });
        }
        start = tanggal;
        end = tanggal;
    } else if (tanggalAwal && tanggalAkhir) {
        if (!isYmd(tanggalAwal) || !isYmd(tanggalAkhir)) {
            return res.status(400).json({
                success: false,
                message: "format tanggal_awal & tanggal_akhir harus YYYY-MM-DD",
            });
        }
        start = tanggalAwal <= tanggalAkhir ? tanggalAwal : tanggalAkhir;
        end = tanggalAwal <= tanggalAkhir ? tanggalAkhir : tanggalAwal;
    } else {
        return res.status(400).json({
            success: false,
            message: "Isi tanggal atau tanggal_awal & tanggal_akhir",
        });
    }

    try {
        const text = await homeService.rekapVisitPlanWA({
            user,
            start,
            end,
            cabang,
        });

        if (!text) {
            return res.json({
                success: true,
                wa_text: "",
                message: "Data kosong",
            });
        }

        return res.json({ success: true, wa_text: text });
    } catch (e) {
        console.error("REKAP VISIT PLAN WA ERROR:", e);
        return res
            .status(500)
            .json({ success: false, message: e.sqlMessage || e.message });
    }
};

const getRekapCalonCustomer = async (req, res) => {
    const { cabang, cc_nama, limit } = req.query;

    try {
        const rows = await homeService.getRekapCalonCustomer({
            cabang,
            cc_nama,
            limit,
        });
        return res.json({ success: true, data: rows });
    } catch (err) {
        console.error("GET REKAP CALON CUSTOMER ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal mengambil rekap calon customer",
        });
    }
};

const rekapCalonCustomerWA = async (req, res) => {
    const { cabang, cc_nama } = req.query;
    const keyword = String(cc_nama || "").trim();
    if (!keyword) {
        return res.status(400).json({
            success: false,
            message:
                "Tentukan Nama Customer \n(agar tidak semua data terkirim)",
        });
    }

    try {
        const text = await homeService.rekapCalonCustomerWA({
            cabang,
            keyword,
        });

        if (!text) {
            return res.json({
                success: true,
                wa_text: "",
                message: "Data tidak ditemukan sesuai filter",
            });
        }

        return res.json({
            success: true,
            wa_text: text,
        });
    } catch (err) {
        console.error("REKAP CALON CUSTOMER WA ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal membuat rekap WA",
        });
    }
};

const gantiPassword = async (req, res) => {
    const { user, oldPassword, newPassword } = req.body;

    try {
        const result = await homeService.gantiPassword({
            user,
            oldPassword,
            newPassword,
        });
        return res.status(result.status).json(result.body);
    } catch (err) {
        console.error("CHANGE PASSWORD ERROR:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const getUser = async (req, res) => {
    const { cabang } = req.query;

    if (!cabang) {
        return res.status(400).json({
            success: false,
            message: "Parameter cabang wajib diisi",
        });
    }

    try {
        const rows = await homeService.getUserByCabang(cabang);
        return res.json({
            success: true,
            count: rows.length,
            data: rows,
        });
    } catch (err) {
        console.error("ERROR GET SALES BY CABANG:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal mengambil data sales",
        });
    }
};

module.exports = {
    calonCustomer,
    updateCalonCustomerByKode,
    cariCustomer,
    getCabang,
    createVisitPlan,
    visitPlanById,
    updateVisitPlan,
    createVisit,
    getVisitFromPlan,
    getVisitDraft,
    updateVisit,
    uploadVisitPhoto,
    getRekapVisit,
    rekapVisitWA,
    updateRekapVisit,
    getRekapVisitPlan,
    rekapVisitPlanWA,
    getRekapCalonCustomer,
    rekapCalonCustomerWA,
    gantiPassword,
    getUser,
};
