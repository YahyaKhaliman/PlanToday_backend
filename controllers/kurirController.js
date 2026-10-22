const kurirService = require("../services/kurirService");
const { ensureImageUnder500KB } = require("../utils/imageOptimizer");

function meta(req, extra = {}) {
    return {
        request_id: req.headers["x-request-id"] || null,
        timestamp: new Date().toISOString(),
        ...extra,
    };
}

function ok(
    res,
    req,
    { status = 200, message = "OK", data = null, extraMeta = {} } = {},
) {
    return res.status(status).json({
        success: true,
        message,
        data,
        meta: meta(req, extraMeta),
    });
}

function fail(
    res,
    req,
    {
        status = 500,
        message = "Terjadi kesalahan pada server",
        code = "INTERNAL_SERVER_ERROR",
        details = null,
    } = {},
) {
    const error = { code };
    if (details) error.details = details;

    return res.status(status).json({
        success: false,
        message,
        error,
        meta: meta(req),
    });
}

function parsePositiveInt(value) {
    const num = Number(value);
    if (!Number.isInteger(num) || num < 1) return null;
    return num;
}

function isYmd(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function todayYmd() {
    return new Date().toISOString().slice(0, 10);
}

function isKurirActor(req) {
    return String(req.user?.jabatan || "").toUpperCase() === "KURIR";
}

function scopedUserFilter(req, requestedUser) {
    if (isKurirActor(req)) {
        return String(req.user?.nama || "").trim();
    }
    return String(requestedUser || req.user?.nama || "").trim();
}

function forbidden(
    res,
    req,
    message = "Anda tidak memiliki akses ke data ini",
) {
    return fail(res, req, {
        status: 403,
        message,
        code: "FORBIDDEN",
    });
}

function canAccessRow(req, row) {
    if (!isKurirActor(req)) return true;
    const actor = String(req.user?.nama || "").trim();
    const owner = String(row?.user || "").trim();
    if (!owner) return true;
    return owner === actor;
}

function normalizeStatusToRealisasi(raw) {
    const value = String(raw || "")
        .trim()
        .toLowerCase();
    if (["y", "done", "selesai", "delivered"].includes(value)) return "Y";
    if (
        ["n", "draft", "ready", "in_transit", "cancelled", "belum"].includes(
            value,
        )
    )
        return "N";
    return null;
}

function validateCreateUpdatePayload(body) {
    const details = [];

    const receiver = String(body.receiver ?? body.tujuan ?? "").trim();
    const sender = String(body.sender ?? "").trim();
    const note = body.note == null ? null : String(body.note).trim();
    const catatan =
        body.catatan == null
            ? String(body.alamat_tujuan || "").trim() || null
            : String(body.catatan).trim();

    const tanggal_plan = String(
        body.tanggal_plan ?? body.tanggal_kirim ?? "",
    ).trim();
    const jam_plan = String(body.jam_plan ?? "").trim();
    const tanggal = String(body.tanggal ?? "").trim();
    const jam = String(body.jam ?? "").trim();

    const latitude =
        body.latitude == null ? null : String(body.latitude).trim();
    const longitude =
        body.longitude == null ? null : String(body.longitude).trim();
    const user = String(body.user ?? "").trim();

    const realisasiRaw = body.realisasi ?? body.status;
    const realisasi = normalizeStatusToRealisasi(realisasiRaw) || "N";

    if (!receiver)
        details.push({
            field: "receiver",
            message: "receiver/tujuan wajib diisi",
        });
    if (tanggal_plan && !isYmd(tanggal_plan)) {
        details.push({
            field: "tanggal_plan",
            message: "format tanggal_plan harus YYYY-MM-DD",
        });
    }
    if (tanggal && !isYmd(tanggal)) {
        details.push({
            field: "tanggal",
            message: "format tanggal harus YYYY-MM-DD",
        });
    }
    if (tanggal_plan && realisasi !== "Y" && tanggal_plan < todayYmd()) {
        details.push({
            field: "tanggal_plan",
            message: "tanggal_plan tidak boleh tanggal lampau",
        });
    }
    if (realisasiRaw != null && !normalizeStatusToRealisasi(realisasiRaw)) {
        details.push({
            field: "status",
            message: "status/realisasi tidak valid",
        });
    }

    return {
        payload: {
            sender: sender || null,
            receiver,
            note,
            catatan,
            tanggal_plan: tanggal_plan || null,
            jam_plan: jam_plan || null,
            tanggal: tanggal || null,
            jam: jam || null,
            latitude,
            longitude,
            user: user || null,
            realisasi,
        },
        details,
    };
}

const listPengiriman = async (req, res) => {
    const page = parsePositiveInt(req.query.page || 1);
    const limit = parsePositiveInt(req.query.limit || 10);
    const search = String(req.query.search || req.query.keyword || "").trim();
    const userFilter = scopedUserFilter(req, req.query.user);

    if (!page || !limit || limit > 100) {
        return fail(res, req, {
            status: 422,
            message: "Validasi gagal",
            code: "VALIDATION_ERROR",
            details: [
                { field: "page/limit", message: "page >=1 dan limit 1..100" },
            ],
        });
    }

    const realisasiFilter = req.query.status
        ? normalizeStatusToRealisasi(req.query.status)
        : null;
    if (req.query.status && !realisasiFilter) {
        return fail(res, req, {
            status: 422,
            message: "Validasi gagal",
            code: "VALIDATION_ERROR",
            details: [{ field: "status", message: "status tidak valid" }],
        });
    }

    try {
        const result = await kurirService.listPengiriman({
            userFilter,
            search,
            realisasiFilter,
            page,
            limit,
        });

        return ok(res, req, {
            message: "Data pengiriman berhasil diambil",
            data: result.data,
            extraMeta: {
                pagination: {
                    page,
                    limit,
                    total_items: result.totalItems,
                    total_pages: result.totalPages,
                    has_next: page < result.totalPages,
                    has_prev: page > 1,
                },
            },
        });
    } catch (err) {
        console.error("KURIR LIST ERROR:", err);
        return fail(res, req);
    }
};

function parseDateRange(query) {
    const tanggal = String(query.tanggal || "").trim();
    const tanggalAwal = String(
        query.tanggal_awal || query.tanggalAwal || "",
    ).trim();
    const tanggalAkhir = String(
        query.tanggal_akhir || query.tanggalAkhir || "",
    ).trim();

    const details = [];
    let where = "";
    let params = [];

    if (tanggal) {
        if (!isYmd(tanggal)) {
            details.push({
                field: "tanggal",
                message: "format tanggal harus YYYY-MM-DD",
            });
        } else {
            where = "DATE(?)";
            params = [tanggal];
        }
    } else if (tanggalAwal || tanggalAkhir) {
        if (!isYmd(tanggalAwal) || !isYmd(tanggalAkhir)) {
            details.push({
                field: "tanggal_awal/tanggal_akhir",
                message: "format harus YYYY-MM-DD",
            });
        } else {
            where = "BETWEEN DATE(?) AND DATE(?)";
            params = [tanggalAwal, tanggalAkhir];
        }
    }

    return { where, params, details };
}

async function listByMode(req, res, { mode, title, dateField, orderBy }) {
    const page = parsePositiveInt(req.query.page || 1);
    const limit = parsePositiveInt(req.query.limit || 10);
    const search = String(req.query.search || "").trim();
    const userFilter = scopedUserFilter(req, req.query.user);

    if (!page || !limit || limit > 100) {
        return fail(res, req, {
            status: 422,
            message: "Validasi gagal",
            code: "VALIDATION_ERROR",
            details: [
                { field: "page/limit", message: "page >=1 dan limit 1..100" },
            ],
        });
    }

    const realisasi = mode === "kirim" || mode === "rekap-kirim" ? "Y" : "N";
    const {
        where: dateWhere,
        params: dateParams,
        details,
    } = parseDateRange(req.query);
    if (details.length) {
        return fail(res, req, {
            status: 422,
            message: "Validasi gagal",
            code: "VALIDATION_ERROR",
            details,
        });
    }

    try {
        const result = await kurirService.listByMode({
            realisasi,
            userFilter,
            search,
            dateWhere,
            dateParams,
            dateField,
            orderBy,
            page,
            limit,
        });

        return ok(res, req, {
            message: `${title} berhasil diambil`,
            data: result.data,
            extraMeta: {
                mode,
                pagination: {
                    page,
                    limit,
                    total_items: result.totalItems,
                    total_pages: result.totalPages,
                    has_next: page < result.totalPages,
                    has_prev: page > 1,
                },
            },
        });
    } catch (err) {
        console.error(`KURIR ${mode.toUpperCase()} ERROR:`, err);
        return fail(res, req);
    }
}

const getKirim = async (req, res) => {
    return listByMode(req, res, {
        mode: "kirim",
        title: "Data kirim",
        dateField: "tanggal",
        orderBy: "IFNULL(tanggal, tanggal_plan) DESC, id DESC",
    });
};

const getRekapKirim = async (req, res) => {
    return listByMode(req, res, {
        mode: "rekap-kirim",
        title: "Rekap kirim",
        dateField: "tanggal",
        orderBy: "IFNULL(tanggal, tanggal_plan) DESC, id DESC",
    });
};

const getRencanaKirim = async (req, res) => {
    return listByMode(req, res, {
        mode: "rencana-kirim",
        title: "Rencana kirim",
        dateField: "tanggal_plan",
        orderBy: "IFNULL(tanggal_plan, tanggal) DESC, id DESC",
    });
};

const getRekapRencanaKirim = async (req, res) => {
    return listByMode(req, res, {
        mode: "rekap-rencana-kirim",
        title: "Rekap rencana kirim",
        dateField: "tanggal_plan",
        orderBy: "IFNULL(tanggal_plan, tanggal) DESC, id DESC",
    });
};

const getPengirimanById = async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
        return fail(res, req, {
            status: 422,
            message: "Validasi gagal",
            code: "VALIDATION_ERROR",
            details: [
                { field: "id", message: "id harus bilangan bulat positif" },
            ],
        });
    }

    try {
        const row = await kurirService.findKirimanById(id);

        if (!row) {
            return fail(res, req, {
                status: 404,
                message: "Data pengiriman tidak ditemukan",
                code: "NOT_FOUND",
            });
        }

        if (!canAccessRow(req, row)) {
            return forbidden(res, req);
        }

        return ok(res, req, {
            message: "Detail pengiriman berhasil diambil",
            data: kurirService.mapKirimanRow(row),
        });
    } catch (err) {
        console.error("KURIR DETAIL ERROR:", err);
        return fail(res, req);
    }
};

const createPengiriman = async (req, res) => {
    const { payload, details } = validateCreateUpdatePayload(req.body);
    if (details.length) {
        return fail(res, req, {
            status: 422,
            message: "Validasi gagal",
            code: "VALIDATION_ERROR",
            details,
        });
    }

    const actor = req.user?.nama || null;
    const finalUser = isKurirActor(req) ? actor : payload.user || actor;

    try {
        const data = await kurirService.createPengiriman({ payload, finalUser });
        return ok(res, req, {
            status: 201,
            message: "Pengiriman berhasil disimpan",
            data,
        });
    } catch (err) {
        console.error("KURIR CREATE ERROR:", err);
        return fail(res, req);
    }
};

const updatePengiriman = async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
        return fail(res, req, {
            status: 422,
            message: "Validasi gagal",
            code: "VALIDATION_ERROR",
            details: [
                { field: "id", message: "id harus bilangan bulat positif" },
            ],
        });
    }

    const { payload, details } = validateCreateUpdatePayload(req.body);
    if (details.length) {
        return fail(res, req, {
            status: 422,
            message: "Validasi gagal",
            code: "VALIDATION_ERROR",
            details,
        });
    }

    const actor = req.user?.nama || null;
    const finalUser = isKurirActor(req) ? actor : payload.user || actor;

    try {
        const existing = await kurirService.findKirimanById(id);
        if (!existing) {
            return fail(res, req, {
                status: 404,
                message: "Data pengiriman tidak ditemukan",
                code: "NOT_FOUND",
            });
        }

        if (!canAccessRow(req, existing)) {
            return forbidden(res, req);
        }

        const data = await kurirService.updatePengiriman({ id, payload, finalUser });

        return ok(res, req, {
            message: "Pengiriman berhasil diperbarui",
            data,
        });
    } catch (err) {
        console.error("KURIR UPDATE ERROR:", err);
        return fail(res, req);
    }
};

const updatePengirimanStatus = async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
        return fail(res, req, {
            status: 422,
            message: "Validasi gagal",
            code: "VALIDATION_ERROR",
            details: [
                { field: "id", message: "id harus bilangan bulat positif" },
            ],
        });
    }

    const realisasi = normalizeStatusToRealisasi(
        req.body.status ?? req.body.realisasi,
    );
    const tanggal = String(req.body.tanggal || "").trim();
    const jam = String(req.body.jam || "").trim() || null;
    const latitude =
        req.body.latitude == null ? null : String(req.body.latitude).trim();
    const longitude =
        req.body.longitude == null ? null : String(req.body.longitude).trim();
    const catatan =
        req.body.catatan == null ? null : String(req.body.catatan).trim();

    if (!realisasi) {
        return fail(res, req, {
            status: 422,
            message: "Validasi gagal",
            code: "VALIDATION_ERROR",
            details: [
                { field: "status", message: "status/realisasi tidak valid" },
            ],
        });
    }
    if (tanggal && !isYmd(tanggal)) {
        return fail(res, req, {
            status: 422,
            message: "Validasi gagal",
            code: "VALIDATION_ERROR",
            details: [
                {
                    field: "tanggal",
                    message: "format tanggal harus YYYY-MM-DD",
                },
            ],
        });
    }

    try {
        const existing = await kurirService.findKirimanById(id);
        if (!existing) {
            return fail(res, req, {
                status: 404,
                message: "Data pengiriman tidak ditemukan",
                code: "NOT_FOUND",
            });
        }

        if (!canAccessRow(req, existing)) {
            return forbidden(res, req);
        }

        const data = await kurirService.updateStatus({
            id,
            realisasi,
            tanggal,
            jam,
            latitude,
            longitude,
            catatan,
        });

        return ok(res, req, {
            message: "Status pengiriman berhasil diperbarui",
            data,
        });
    } catch (err) {
        console.error("KURIR UPDATE STATUS ERROR:", err);
        return fail(res, req);
    }
};

const uploadPengirimanPhoto = async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
        return fail(res, req, {
            status: 422,
            message: "Validasi gagal",
            code: "VALIDATION_ERROR",
            details: [
                { field: "id", message: "id harus bilangan bulat positif" },
            ],
        });
    }

    if (!req.file) {
        return fail(res, req, {
            status: 400,
            message: "File foto tidak ditemukan",
            code: "FILE_REQUIRED",
        });
    }

    try {
        const existing = await kurirService.findKirimanById(id);
        if (!existing) {
            return fail(res, req, {
                status: 404,
                message: "Data pengiriman tidak ditemukan",
                code: "NOT_FOUND",
            });
        }

        if (!canAccessRow(req, existing)) {
            return forbidden(res, req);
        }

        // Pastikan ukuran foto pengiriman <= 500 KB sebelum disimpan
        if (req.file && req.file.path) {
            await ensureImageUnder500KB(req.file.path);
        }

        const relativePath = `/uploads/kiriman/${req.file.filename}`;
        const data = await kurirService.updatePhoto({ id, relativePath });

        return ok(res, req, {
            message: "Foto pengiriman berhasil disimpan",
            data,
        });
    } catch (err) {
        console.error("KURIR UPLOAD PHOTO ERROR:", err);
        return fail(res, req);
    }
};

const softDeletePengiriman = async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
        return fail(res, req, {
            status: 422,
            message: "Validasi gagal",
            code: "VALIDATION_ERROR",
            details: [
                { field: "id", message: "id harus bilangan bulat positif" },
            ],
        });
    }

    try {
        const existing = await kurirService.findKirimanById(id);
        if (!existing) {
            return ok(res, req, {
                message: "Pengiriman berhasil dihapus",
                data: { id, deleted: true },
            });
        }

        if (!canAccessRow(req, existing)) {
            return forbidden(res, req);
        }

        const data = await kurirService.deleteById(id);
        return ok(res, req, {
            message: "Pengiriman berhasil dihapus",
            data,
        });
    } catch (err) {
        console.error("KURIR DELETE ERROR:", err);
        return fail(res, req);
    }
};

module.exports = {
    getKirim,
    getRekapKirim,
    getRencanaKirim,
    getRekapRencanaKirim,
    listPengiriman,
    getPengirimanById,
    createPengiriman,
    updatePengiriman,
    updatePengirimanStatus,
    uploadPengirimanPhoto,
    softDeletePengiriman,
};
