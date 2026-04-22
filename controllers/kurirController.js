const db = require("../config/dbMain");

const KIRIMAN_SELECT_FIELDS =
    "id, sender, receiver, note, catatan, realisasi, tanggal, tanggal_plan, jam, jam_plan, latitude, longitude, user, foto";

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

async function findKirimanById(id) {
    const [rows] = await db.query(
        `SELECT ${KIRIMAN_SELECT_FIELDS}
         FROM marketing.tkiriman
         WHERE id = ? LIMIT 1`,
        [id],
    );

    return rows?.[0] || null;
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

function mapRealisasiToStatus(raw) {
    return String(raw || "N").toUpperCase() === "Y" ? "delivered" : "draft";
}

function mapKirimanRow(row) {
    return {
        // kompatibilitas kontrak baru
        id: row.id,
        kode_pengiriman: `KRM-${String(row.id).padStart(6, "0")}`,
        tujuan: row.receiver || "",
        alamat_tujuan: row.catatan || null,
        status: mapRealisasiToStatus(row.realisasi),
        tanggal_kirim: row.tanggal_plan || row.tanggal || null,

        // kompatibilitas acuan Delphi /kiriman
        sender: row.sender || null,
        receiver: row.receiver || null,
        note: row.note || null,
        catatan: row.catatan || null,
        realisasi: String(row.realisasi || "N").toUpperCase(),
        tanggal: row.tanggal || null,
        tanggal_plan: row.tanggal_plan || null,
        jam: row.jam || null,
        jam_plan: row.jam_plan || null,
        latitude: row.latitude || null,
        longitude: row.longitude || null,
        user: row.user || null,
        foto: row.foto || null,
        foto_url: row.foto || null,
    };
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

    const where = ["1=1"];
    const params = [];

    if (userFilter) {
        where.push("`user` = ?");
        params.push(userFilter);
    }
    if (search) {
        where.push(
            "(sender LIKE ? OR receiver LIKE ? OR note LIKE ? OR catatan LIKE ?)",
        );
        const like = `%${search}%`;
        params.push(like, like, like, like);
    }
    if (realisasiFilter) {
        where.push("realisasi = ?");
        params.push(realisasiFilter);
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;
    const offset = (page - 1) * limit;

    try {
        const [countRows] = await db.query(
            `SELECT COUNT(*) AS total_items FROM marketing.tkiriman ${whereSql}`,
            params,
        );

        const [rows] = await db.query(
            `SELECT ${KIRIMAN_SELECT_FIELDS}
             FROM marketing.tkiriman
             ${whereSql}
             ORDER BY IFNULL(tanggal_plan, tanggal) DESC, id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset],
        );

        const totalItems = Number(countRows?.[0]?.total_items || 0);
        const totalPages = Math.max(1, Math.ceil(totalItems / limit));

        return ok(res, req, {
            message: "Data pengiriman berhasil diambil",
            data: rows.map(mapKirimanRow),
            extraMeta: {
                pagination: {
                    page,
                    limit,
                    total_items: totalItems,
                    total_pages: totalPages,
                    has_next: page < totalPages,
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

    const where = ["realisasi = ?"];
    const params = [realisasi];

    if (userFilter) {
        where.push("`user` = ?");
        params.push(userFilter);
    }
    if (search) {
        where.push(
            "(sender LIKE ? OR receiver LIKE ? OR note LIKE ? OR catatan LIKE ?)",
        );
        const like = `%${search}%`;
        params.push(like, like, like, like);
    }
    if (dateWhere) {
        where.push(`DATE(${dateField}) ${dateWhere}`);
        params.push(...dateParams);
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;
    const offset = (page - 1) * limit;

    try {
        const [countRows] = await db.query(
            `SELECT COUNT(*) AS total_items FROM marketing.tkiriman ${whereSql}`,
            params,
        );

        const [rows] = await db.query(
            `SELECT ${KIRIMAN_SELECT_FIELDS}
             FROM marketing.tkiriman
             ${whereSql}
             ORDER BY ${orderBy}
             LIMIT ? OFFSET ?`,
            [...params, limit, offset],
        );

        const totalItems = Number(countRows?.[0]?.total_items || 0);
        const totalPages = Math.max(1, Math.ceil(totalItems / limit));

        return ok(res, req, {
            message: `${title} berhasil diambil`,
            data: rows.map(mapKirimanRow),
            extraMeta: {
                mode,
                pagination: {
                    page,
                    limit,
                    total_items: totalItems,
                    total_pages: totalPages,
                    has_next: page < totalPages,
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
        const row = await findKirimanById(id);

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
            data: mapKirimanRow(row),
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

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [[{ maxId }]] = await conn.query(
            "SELECT IFNULL(MAX(id), 0) AS maxId FROM marketing.tkiriman",
        );
        const newId = Number(maxId || 0) + 1;

        await conn.query(
            `INSERT INTO marketing.tkiriman
             (id, sender, receiver, latitude, longitude, note, catatan, realisasi, tanggal, tanggal_plan, jam, jam_plan, user)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, IFNULL(?, CURDATE()), IFNULL(?, CURDATE()), IFNULL(?, CURTIME()), IFNULL(?, CURTIME()), ?)`,
            [
                newId,
                payload.sender,
                payload.receiver,
                payload.latitude,
                payload.longitude,
                payload.note,
                payload.catatan,
                payload.realisasi,
                payload.tanggal,
                payload.tanggal_plan,
                payload.jam,
                payload.jam_plan,
                finalUser,
            ],
        );

        await conn.commit();
        const row = await findKirimanById(newId);
        return ok(res, req, {
            status: 201,
            message: "Pengiriman berhasil disimpan",
            data: row ? mapKirimanRow(row) : null,
        });
    } catch (err) {
        await conn.rollback();
        console.error("KURIR CREATE ERROR:", err);
        return fail(res, req);
    } finally {
        conn.release();
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
        const existing = await findKirimanById(id);
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

        await db.query(
            `UPDATE marketing.tkiriman
             SET sender = ?, receiver = ?, latitude = ?, longitude = ?, note = ?, catatan = ?,
                 realisasi = ?, tanggal = IFNULL(?, tanggal), tanggal_plan = IFNULL(?, tanggal_plan),
                 jam = IFNULL(?, jam), jam_plan = IFNULL(?, jam_plan), user = ?
             WHERE id = ?`,
            [
                payload.sender,
                payload.receiver,
                payload.latitude,
                payload.longitude,
                payload.note,
                payload.catatan,
                payload.realisasi,
                payload.tanggal,
                payload.tanggal_plan,
                payload.jam,
                payload.jam_plan,
                finalUser,
                id,
            ],
        );

        const row = await findKirimanById(id);

        return ok(res, req, {
            message: "Pengiriman berhasil diperbarui",
            data: row ? mapKirimanRow(row) : null,
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
        const existing = await findKirimanById(id);
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

        if (realisasi === "Y") {
            await db.query(
                `UPDATE marketing.tkiriman
                 SET realisasi = ?,
                     tanggal = IFNULL(?, CURDATE()),
                     jam = IFNULL(?, CURTIME()),
                     latitude = IFNULL(?, latitude),
                     longitude = IFNULL(?, longitude),
                     catatan = COALESCE(?, catatan)
                 WHERE id = ?`,
                [
                    realisasi,
                    tanggal || null,
                    jam,
                    latitude,
                    longitude,
                    catatan,
                    id,
                ],
            );
        } else {
            await db.query(
                "UPDATE marketing.tkiriman SET realisasi = ? WHERE id = ?",
                [realisasi, id],
            );
        }

        const row = await findKirimanById(id);

        return ok(res, req, {
            message: "Status pengiriman berhasil diperbarui",
            data: row ? mapKirimanRow(row) : null,
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
        const existing = await findKirimanById(id);
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

        const relativePath = `/uploads/kiriman/${req.file.filename}`;
        await db.query("UPDATE marketing.tkiriman SET foto = ? WHERE id = ?", [
            relativePath,
            id,
        ]);

        const row = await findKirimanById(id);
        return ok(res, req, {
            message: "Foto pengiriman berhasil disimpan",
            data: row ? mapKirimanRow(row) : null,
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
        const existing = await findKirimanById(id);
        if (!existing) {
            return ok(res, req, {
                message: "Pengiriman berhasil dihapus",
                data: { id, deleted: true },
            });
        }

        if (!canAccessRow(req, existing)) {
            return forbidden(res, req);
        }

        await db.query("DELETE FROM marketing.tkiriman WHERE id = ?", [id]);
        return ok(res, req, {
            message: "Pengiriman berhasil dihapus",
            data: { id, deleted: true },
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
