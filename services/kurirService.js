const db = require("../config/dbMain");

const KIRIMAN_SELECT_FIELDS =
    "id, sender, receiver, note, catatan, realisasi, tanggal, tanggal_plan, jam, jam_plan, latitude, longitude, user, foto";

function mapRealisasiToStatus(raw) {
    return String(raw || "N").toUpperCase() === "Y" ? "delivered" : "draft";
}

function mapKirimanRow(row) {
    return {
        id: row.id,
        kode_pengiriman: `KRM-${String(row.id).padStart(6, "0")}`,
        tujuan: row.receiver || "",
        alamat_tujuan: row.catatan || null,
        status: mapRealisasiToStatus(row.realisasi),
        tanggal_kirim: row.tanggal_plan || row.tanggal || null,

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

async function findKirimanById(id) {
    const [rows] = await db.query(
        `SELECT ${KIRIMAN_SELECT_FIELDS}
         FROM marketing.tkiriman
         WHERE id = ? LIMIT 1`,
        [id],
    );

    return rows?.[0] || null;
}

const listPengiriman = async ({
    userFilter,
    search,
    realisasiFilter,
    page,
    limit,
}) => {
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

    return {
        data: (rows || []).map(mapKirimanRow),
        totalItems,
        totalPages,
    };
};

const listByMode = async ({
    realisasi,
    userFilter,
    search,
    dateWhere,
    dateParams,
    dateField,
    orderBy,
    page,
    limit,
}) => {
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

    return {
        data: (rows || []).map(mapKirimanRow),
        totalItems,
        totalPages,
    };
};

const createPengiriman = async ({ payload, finalUser }) => {
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
        return row ? mapKirimanRow(row) : null;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
};

const updatePengiriman = async ({ id, payload, finalUser }) => {
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
    return row ? mapKirimanRow(row) : null;
};

const updateStatus = async ({
    id,
    realisasi,
    tanggal,
    jam,
    latitude,
    longitude,
    catatan,
}) => {
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
            [realisasi, tanggal || null, jam, latitude, longitude, catatan, id],
        );
    } else {
        await db.query(
            "UPDATE marketing.tkiriman SET realisasi = ? WHERE id = ?",
            [realisasi, id],
        );
    }

    const row = await findKirimanById(id);
    return row ? mapKirimanRow(row) : null;
};

const updatePhoto = async ({ id, relativePath }) => {
    await db.query("UPDATE marketing.tkiriman SET foto = ? WHERE id = ?", [
        relativePath,
        id,
    ]);

    const row = await findKirimanById(id);
    return row ? mapKirimanRow(row) : null;
};

const deleteById = async (id) => {
    await db.query("DELETE FROM marketing.tkiriman WHERE id = ?", [id]);
    return { id, deleted: true };
};

module.exports = {
    findKirimanById,
    listPengiriman,
    listByMode,
    createPengiriman,
    updatePengiriman,
    updateStatus,
    updatePhoto,
    deleteById,
    mapKirimanRow,
};
