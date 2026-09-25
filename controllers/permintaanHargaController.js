const permintaanHargaService = require("../services/permintaanHargaService");

const getPermintaanHargaList = async (req, res) => {
    try {
        const monthRange = permintaanHargaService.getCurrentMonthRange();
        const startDate =
            permintaanHargaService.normalizeDate(req.query.startDate) || monthRange.start;
        const endDate =
            permintaanHargaService.normalizeDate(req.query.endDate) || monthRange.end;
        const status = String(req.query.status || "")
            .trim()
            .toUpperCase();
        const search = String(req.query.search || "").trim();
        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 300);
        const page = Math.max(Number(req.query.page) || 1, 1);
        const offset = (page - 1) * limit;

        const managerRole = permintaanHargaService.isManagerUser(req.user);
        const authSalesKode = String(req.user?.sales_kode || "").trim();

        if (!managerRole && !authSalesKode) {
            return res.status(403).json({
                success: false,
                message: "Sales tidak valid (sales_kode kosong)",
            });
        }

        const rows = await permintaanHargaService.getPermintaanHargaList({
            managerRole,
            authSalesKode,
            startDate,
            endDate,
            status,
            search,
            limit,
            offset,
        });

        return res.json({
            success: true,
            data: rows,
            meta: {
                page,
                limit,
                count: rows.length,
            },
        });
    } catch (err) {
        console.error("[PermintaanHarga][List][Error]", {
            message: err?.message,
            sqlMessage: err?.sqlMessage,
            code: err?.code,
        });
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengambil list permintaan harga",
        });
    }
};

const getPermintaanHargaDetail = async (req, res) => {
    try {
        const nomor = String(req.params.nomor || "").trim();
        const managerRole = permintaanHargaService.isManagerUser(req.user);
        const authSalesKode = String(req.user?.sales_kode || "").trim();

        if (!managerRole && !authSalesKode) {
            return res.status(403).json({
                success: false,
                message: "Sales tidak valid (sales_kode kosong)",
            });
        }

        if (!nomor) {
            return res
                .status(400)
                .json({ success: false, message: "Nomor tidak valid" });
        }

        const row = await permintaanHargaService.getPermintaanHargaDetail({
            managerRole,
            authSalesKode,
            nomor,
        });

        if (!row) {
            return res
                .status(404)
                .json({ success: false, message: "Data tidak ditemukan" });
        }

        return res.json({ success: true, data: row });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengambil detail permintaan harga",
        });
    }
};

const createPermintaanHarga = async (req, res) => {
    try {
        const result = await permintaanHargaService.createPermintaanHarga({
            body: req.body || {},
            user: req.user || {},
        });
        return res.status(result.status).json(result.body);
    } catch (err) {
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal membuat permintaan harga",
        });
    }
};

const updatePermintaanHarga = async (req, res) => {
    try {
        const nomor = String(req.params.nomor || "").trim();
        const result = await permintaanHargaService.updatePermintaanHarga({
            nomor,
            body: req.body || {},
            user: req.user || {},
        });
        return res.status(result.status).json(result.body);
    } catch (err) {
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengubah permintaan harga",
        });
    }
};

const copyPermintaanHarga = async (req, res) => {
    try {
        const nomor = String(req.params.nomor || "").trim();
        const result = await permintaanHargaService.copyPermintaanHarga({
            nomor,
            user: req.user || {},
            body: req.body || {},
        });
        return res.status(result.status).json(result.body);
    } catch (err) {
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage || err.message || "Gagal copy permintaan harga",
        });
    }
};

const deletePermintaanHarga = async (req, res) => {
    try {
        const nomor = String(req.params.nomor || "").trim();
        const result = await permintaanHargaService.deletePermintaanHarga({
            nomor,
            user: req.user || {},
        });
        return res.status(result.status).json(result.body);
    } catch (err) {
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal menghapus permintaan harga",
        });
    }
};

const uploadPermintaanHargaImage = async (req, res) => {
    try {
        const nomor = String(req.params.nomor || "").trim();
        const slot = String(req.params.slot || "1").trim();
        const result = await permintaanHargaService.uploadPermintaanHargaImage({
            nomor,
            slot,
            file: req.file,
            user: req.user || {},
        });
        return res.status(result.status).json(result.body);
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: err.sqlMessage || err.message || "Gagal upload gambar",
        });
    }
};

const uploadPermintaanHargaImageInternal = async (req, res) => {
    try {
        const nomor = String(req.params.nomor || "").trim();
        const slot = String(req.params.slot || "1").trim();
        const result =
            await permintaanHargaService.uploadPermintaanHargaImageInternal({
                nomor,
                slot,
                file: req.file,
            });
        return res.status(result.status).json(result.body);
    } catch (err) {
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage || err.message || "Gagal upload internal gambar",
        });
    }
};

const uploadPermintaanHargaImageBase64 = async (req, res) => {
    try {
        const nomor = String(req.params.nomor || "").trim();
        const slot = String(req.params.slot || "1").trim();
        const dataUrl = String(req.body?.file_base64 || "").trim();
        const result =
            await permintaanHargaService.uploadPermintaanHargaImageBase64({
                nomor,
                slot,
                dataUrl,
                user: req.user || {},
            });
        return res.status(result.status).json(result.body);
    } catch (err) {
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage || err.message || "Gagal upload base64 gambar",
        });
    }
};

const createPermintaanHargaCustomer = async (req, res) => {
    try {
        const result =
            await permintaanHargaService.createPermintaanHargaCustomer({
                body: req.body || {},
                user: req.user || {},
            });
        return res.status(result.status).json(result.body);
    } catch (err) {
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage || err.message || "Gagal menambahkan customer",
        });
    }
};

const deletePermintaanHargaImage = async (req, res) => {
    try {
        const nomor = String(req.params.nomor || "").trim();
        const slot = String(req.params.slot || "1").trim();
        const result = await permintaanHargaService.deletePermintaanHargaImage({
            nomor,
            slot,
            user: req.user || {},
        });
        return res.status(result.status).json(result.body);
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: err.message || "Gagal menghapus gambar dari server",
        });
    }
};

const getPermintaanHargaStatusCounts = async (req, res) => {
    try {
        const monthRange = permintaanHargaService.getCurrentMonthRange();
        const startDate =
            permintaanHargaService.normalizeDate(req.query.startDate) || monthRange.start;
        const endDate =
            permintaanHargaService.normalizeDate(req.query.endDate) || monthRange.end;

        const managerRole = permintaanHargaService.isManagerUser(req.user);
        const authSalesKode = String(req.user?.sales_kode || "").trim();

        if (!managerRole && !authSalesKode) {
            return res.status(403).json({
                success: false,
                message: "Sales tidak valid (sales_kode kosong)",
            });
        }

        const statusMap =
            await permintaanHargaService.getPermintaanHargaStatusCounts({
                managerRole,
                authSalesKode,
                startDate,
                endDate,
            });

        return res.json({
            success: true,
            data: statusMap,
        });
    } catch (err) {
        console.error("[PermintaanHarga][StatusCounts][Error]", err);
        return res.status(500).json({
            success: false,
            message:
                err.message ||
                "Gagal mengambil rincian status permintaan harga",
        });
    }
};

const getKalkulasiOptions = async (req, res) => {
    try {
        const data = await permintaanHargaService.getKalkulasiOptions();
        return res.json({
            success: true,
            data,
        });
    } catch (err) {
        console.error("[PermintaanHarga][Kalkulasi][Options][Error]", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const getOngkirOptions = async (req, res) => {
    try {
        const data = await permintaanHargaService.getOngkirOptions();
        return res.json({
            success: true,
            data,
        });
    } catch (err) {
        console.error("[PermintaanHarga][Kalkulasi][OngkirOptions][Error]", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const calculateOngkir = async (req, res) => {
    try {
        const data = await permintaanHargaService.calculateOngkir(req.body || {});
        return res.json({
            success: true,
            data,
        });
    } catch (err) {
        console.error("[PermintaanHarga][Kalkulasi][Ongkir][Error]", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const calculateSpanduk = async (req, res) => {
    try {
        const data = await permintaanHargaService.calculateSpanduk(req.body || {});
        return res.json({
            success: true,
            data,
        });
    } catch (err) {
        console.error("[PermintaanHarga][Kalkulasi][Spanduk][Error]", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const calculateMmt = async (req, res) => {
    try {
        const data = await permintaanHargaService.calculateMmt(req.body || {});
        return res.json({
            success: true,
            data,
        });
    } catch (err) {
        console.error("[PermintaanHarga][Kalkulasi][MMT][Error]", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const calculateGarmen = async (req, res) => {
    try {
        const data = await permintaanHargaService.calculateGarmen(req.body || {});
        return res.json({
            success: true,
            data,
        });
    } catch (err) {
        console.error("[PermintaanHarga][Kalkulasi][Garmen][Error]", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const getKainGarmen = async (req, res) => {
    try {
        const data = await permintaanHargaService.getKainGarmen();
        return res.json({ success: true, data });
    } catch (err) {
        console.error("[PermintaanHarga][Lookup][KainGarmen][Error]", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const getJenisKainMintaHarga = async (req, res) => {
    try {
        const { kode = "KH-0001" } = req.query;
        const data = await permintaanHargaService.getJenisKainMintaHarga(kode);
        return res.json({ success: true, data });
    } catch (err) {
        console.error("[PermintaanHarga][Lookup][JenisKain][Error]", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const getTambahanOptions = async (req, res) => {
    try {
        const { jenisKain, kategori, kodeModel, qty } = req.query;
        const data = await permintaanHargaService.getTambahanOptions({
            jenisKain,
            kategori,
            kodeModel,
            qty,
        });
        return res.json({ success: true, data });
    } catch (err) {
        console.error("[PermintaanHarga][Lookup][Tambahan][Error]", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const getCetakOptions = async (req, res) => {
    try {
        const { jenisKain, kategori } = req.query;
        const data = await permintaanHargaService.getCetakOptions({
            jenisKain,
            kategori,
        });
        return res.json({ success: true, data });
    } catch (err) {
        console.error("[PermintaanHarga][Lookup][Cetak][Error]", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

const getCustomerSoHistory = async (req, res) => {
    try {
        const cusKode = req.params.cusKode || req.query.cus_kode;
        const { divisi = "SEMUA", q = "", page = 1, limit = 20 } = req.query;
        const result = await permintaanHargaService.getCustomerSoHistory({
            cusKode,
            divisi,
            q,
            page,
            limit,
        });
        return res.json({
            success: true,
            data: result.data,
            pagination: result.pagination,
        });
    } catch (err) {
        console.error("[PermintaanHarga][CustomerSoHistory][Error]", err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

module.exports = {
    getKalkulasiOptions,
    getOngkirOptions,
    calculateOngkir,
    calculateSpanduk,
    calculateMmt,
    calculateGarmen,
    getKainGarmen,
    getJenisKainMintaHarga,
    getTambahanOptions,
    getCetakOptions,
    getCustomerSoHistory,
    getPermintaanHargaList,
    getPermintaanHargaDetail,
    createPermintaanHarga,
    updatePermintaanHarga,
    createPermintaanHargaCustomer,
    copyPermintaanHarga,
    deletePermintaanHarga,
    uploadPermintaanHargaImage,
    uploadPermintaanHargaImageInternal,
    uploadPermintaanHargaImageBase64,
    deletePermintaanHargaImage,
    getPermintaanHargaStatusCounts,
};
