const penawaranService = require("../services/penawaranService");

const handleSchemaCheck = async (res) => {
    const schema = await penawaranService.ensurePenawaranSchema();
    if (!schema.ready) {
        res.status(503).json({
            success: false,
            message:
                "Fitur Penawaran belum siap: tabel utama belum tersedia di database aktif",
            database: schema.database,
            missingTables: schema.missingTables,
        });
        return false;
    }
    return true;
};

const getPenawaranList = async (req, res) => {
    try {
        const schemaReady = await handleSchemaCheck(res);
        if (!schemaReady) return;

        const managerRole = penawaranService.isManagerUser(req.user);
        const authSalesKode = penawaranService.getAuthSalesKode(req.user);
        if (!managerRole && !authSalesKode) {
            return res.status(403).json({
                success: false,
                message: "Sales tidak valid (sales_kode kosong)",
            });
        }

        const monthRange = penawaranService.getCurrentMonthRange();
        const startDate =
            penawaranService.normalizeDate(req.query.startDate) || monthRange.start;
        const endDate =
            penawaranService.normalizeDate(req.query.endDate) || monthRange.end;
        const search = String(req.query.search || "").trim();
        const statusInfo = penawaranService.buildStatusCondition(req.query.status);
        const limit = Math.min(
            Math.max(Number(req.query.limit) || 100, 1),
            300,
        );

        const filterSalesKode = String(
            req.query.sales_kode || req.query.sales || "",
        ).trim();

        const approvalStatus = String(
            req.query.approval_status || req.query.approval || req.query.approved || "",
        ).trim().toUpperCase();

        const rows = await penawaranService.getPenawaranList({
            managerRole,
            authSalesKode,
            filterSalesKode,
            startDate,
            endDate,
            search,
            statusInfo,
            approvalStatus,
            limit,
        });

        return res.json({
            success: true,
            data: rows,
            meta: {
                startDate,
                endDate,
                status: statusInfo.label,
                count: rows.length,
            },
        });
    } catch (err) {
        console.error("GET PENAWARAN LIST ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengambil data penawaran",
        });
    }
};

const getPenawaranDetail = async (req, res) => {
    try {
        const schemaReady = await handleSchemaCheck(res);
        if (!schemaReady) return;

        const managerRole = penawaranService.isManagerUser(req.user);
        const authSalesKode = penawaranService.getAuthSalesKode(req.user);
        if (!managerRole && !authSalesKode) {
            return res.status(403).json({
                success: false,
                message: "Sales tidak valid (sales_kode kosong)",
            });
        }

        const nomor = String(req.params.nomor || "").trim();
        if (!nomor) {
            return res.status(400).json({
                success: false,
                message: "Nomor penawaran tidak valid",
            });
        }

        const data = await penawaranService.getPenawaranDetail({
            managerRole,
            authSalesKode,
            nomor,
        });

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Data penawaran tidak ditemukan",
            });
        }

        return res.json({
            success: true,
            data,
        });
    } catch (err) {
        console.error("GET PENAWARAN DETAIL ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengambil detail penawaran",
        });
    }
};

const createPenawaran = async (req, res) => {
    try {
        const schemaReady = await handleSchemaCheck(res);
        if (!schemaReady) return;

        const traceId =
            String(
                req.headers["x-request-id"] ||
                    req.headers["x-idempotency-key"] ||
                    req.body?.client_request_id ||
                    `penawaran-${Date.now()}`,
            ).trim() || `penawaran-${Date.now()}`;

        const result = await penawaranService.createPenawaran({
            traceId,
            body: req.body || {},
            loginUser: req.user || {},
        });

        return res.status(result.status).json(result.body);
    } catch (err) {
        console.error("CREATE PENAWARAN ERROR:", err);
        return res.status(500).json({
            success: false,
            message: err.sqlMessage || err.message || "Gagal membuat penawaran",
        });
    }
};

const getMasterPerusahaan = async (req, res) => {
    try {
        const schemaReady = await handleSchemaCheck(res);
        if (!schemaReady) return;

        const search = String(req.query.search || "").trim();
        const data = await penawaranService.getMasterPerusahaan(search);

        return res.json({
            success: true,
            data,
        });
    } catch (err) {
        console.error("GET MASTER PERUSAHAAN ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengambil data perusahaan",
        });
    }
};

const getMasterCustomer = async (req, res) => {
    try {
        const schemaReady = await handleSchemaCheck(res);
        if (!schemaReady) return;

        const search = String(req.query.search || "").trim();
        const data = await penawaranService.getMasterCustomer(search);

        return res.json({
            success: true,
            data,
        });
    } catch (err) {
        console.error("GET MASTER CUSTOMER PENAWARAN ERROR:", err);
        return res.status(500).json({
            success: false,
            data: [],
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengambil data customer penawaran",
        });
    }
};

const getMasterSales = async (req, res) => {
    try {
        const schemaReady = await handleSchemaCheck(res);
        if (!schemaReady) return;

        const search = String(req.query.search || "").trim();
        const data = await penawaranService.getMasterSales(search);

        return res.json({
            success: true,
            data,
        });
    } catch (err) {
        console.error("GET MASTER SALES ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage || err.message || "Gagal mengambil data sales",
        });
    }
};

const getMasterPenawaranNomor = async (req, res) => {
    try {
        const schemaReady = await handleSchemaCheck(res);
        if (!schemaReady) return;

        const search = String(req.query.search || "").trim();
        const data = await penawaranService.getMasterPenawaranNomor(search);

        return res.json({
            success: true,
            data,
        });
    } catch (err) {
        console.error("GET MASTER NOMOR PENAWARAN ERROR:", err);
        return res.status(500).json({
            success: false,
            data: [],
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengambil data master nomor penawaran",
        });
    }
};

const getMasterPermintaanHargaForPenawaran = async (req, res) => {
    try {
        const schemaReady = await handleSchemaCheck(res);
        if (!schemaReady) return;

        const search = String(req.query.search || "").trim();
        const selectedNomor = String(req.query.nomor || "").trim();
        const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
        const page = Math.max(Number(req.query.page) || 1, 1);

        const authSalesKode = String(req.user?.sales_kode || "").trim();
        const isManager =
            String(req.user?.jabatan || "")
                .trim()
                .toUpperCase() === "MANAGER";
        const requestedSalesKode = String(req.query.sales_kode || "").trim();
        const referenceCustomerKode = String(
            req.query.customer_kode || "",
        ).trim();
        const effectiveSalesKode = isManager
            ? requestedSalesKode || authSalesKode
            : authSalesKode;

        if (!effectiveSalesKode) {
            return res.status(400).json({
                success: false,
                message:
                    "Sales tidak valid untuk pencarian permintaan harga (sales_kode kosong)",
            });
        }

        const result =
            await penawaranService.getMasterPermintaanHargaForPenawaran({
                effectiveSalesKode,
                referenceCustomerKode,
                search,
                limit,
                page,
                selectedNomor,
                isManager,
                requestedSalesKode,
            });

        if (result.selectedError) {
            return res
                .status(result.selectedError.status)
                .json({ success: false, message: result.selectedError.message });
        }

        return res.json({
            success: true,
            data: {
                options: result.rows || [],
                selected: result.selected,
            },
            meta: {
                page,
                limit,
                count: result.rows?.length || 0,
                sales_kode: effectiveSalesKode,
                customer_kode: referenceCustomerKode,
                sales_source:
                    isManager && requestedSalesKode
                        ? "HEADER_SALES"
                        : "AUTH_LOGIN",
            },
        });
    } catch (err) {
        console.error("GET MASTER PERMINTAAN HARGA PENAWARAN ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengambil data permintaan harga untuk penawaran",
        });
    }
};

const updatePenawaranStatusDetail = async (req, res) => {
    try {
        const schemaReady = await handleSchemaCheck(res);
        if (!schemaReady) return;

        const nomor = String(req.params.nomor || "").trim();
        const updates = Array.isArray(req.body.updates) ? req.body.updates : [];

        if (!nomor) {
            return res.status(400).json({
                success: false,
                message: "Nomor penawaran tidak valid",
            });
        }

        if (updates.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Tidak ada item status yang diubah",
            });
        }

        const result = await penawaranService.updatePenawaranStatusDetail({
            nomor,
            updates,
            user: req.user,
        });

        return res.status(result.status).json(result.body);
    } catch (err) {
        console.error("UPDATE STATUS DETAIL ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage || err.message || "Gagal mengubah status detail",
        });
    }
};

const getMasterPenawaranBatal = async (req, res) => {
    try {
        const data = await penawaranService.getMasterPenawaranBatal();
        return res.json({
            success: true,
            data,
        });
    } catch (err) {
        console.error("GET MASTER BATAL ERROR:", err);
        return res.status(500).json({
            success: false,
            data: [],
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengambil data alasan batal",
        });
    }
};

const getMasterPenawaranConfirm = async (req, res) => {
    try {
        const data = await penawaranService.getMasterPenawaranConfirm();
        return res.json({
            success: true,
            data,
        });
    } catch (err) {
        console.error("GET MASTER CONFIRM ERROR:", err);
        return res.status(500).json({
            success: false,
            data: [],
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal mengambil data confirmation",
        });
    }
};

const requestApprovalPerubahan = async (req, res) => {
    try {
        const schemaReady = await handleSchemaCheck(res);
        if (!schemaReady) return;

        const nomor = String(req.params.nomor || "").trim();
        const alasan = String(req.body.alasan || "").trim();

        if (!nomor) {
            return res.status(400).json({
                success: false,
                message: "Nomor penawaran tidak valid",
            });
        }

        if (!alasan) {
            return res.status(400).json({
                success: false,
                message: "Alasan pengajuan perubahan wajib diisi",
            });
        }

        const result = await penawaranService.requestApprovalPerubahan({
            nomor,
            alasan,
            user: req.user,
        });

        return res.status(result.status).json(result.body);
    } catch (err) {
        console.error("REQUEST APPROVAL ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal membuat pengajuan perubahan",
        });
    }
};

const getPenawaranActivityLogs = async (req, res) => {
    try {
        const schemaReady = await handleSchemaCheck(res);
        if (!schemaReady) return;

        const nomor = String(req.params.nomor || "").trim();
        if (!nomor) {
            return res.status(400).json({
                success: false,
                message: "Nomor penawaran tidak valid",
            });
        }

        const result = await penawaranService.getPenawaranActivityLogs({
            nomor,
            user: req.user,
        });

        return res.status(result.status).json(result.body);
    } catch (err) {
        console.error("GET PENAWARAN ACTIVITY LOGS ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage || err.message || "Gagal mengambil activity log",
        });
    }
};

const approvePenawaran = async (req, res) => {
    try {
        const schemaReady = await handleSchemaCheck(res);
        if (!schemaReady) return;

        const managerRole = penawaranService.isManagerUser(req.user);
        if (!managerRole) {
            return res.status(403).json({
                success: false,
                message: "Hanya manager yang berhak meng-approve penawaran",
            });
        }

        const nomor = String(req.params.nomor || "").trim();
        if (!nomor) {
            return res.status(400).json({
                success: false,
                message: "Nomor penawaran tidak valid",
            });
        }

        const result = await penawaranService.approvePenawaran({
            nomor,
            user: req.user,
        });

        return res.status(result.status).json(result.body);
    } catch (err) {
        console.error("APPROVE PENAWARAN ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage || err.message || "Gagal meng-approve penawaran",
        });
    }
};

module.exports = {
    getPenawaranList,
    getPenawaranDetail,
    createPenawaran,
    getMasterPenawaranNomor,
    getMasterPermintaanHargaForPenawaran,
    getMasterPerusahaan,
    getMasterCustomer,
    getMasterSales,
    updatePenawaranStatusDetail,
    getMasterPenawaranBatal,
    getMasterPenawaranConfirm,
    requestApprovalPerubahan,
    getPenawaranActivityLogs,
    approvePenawaran,
};
