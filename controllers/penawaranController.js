const { createHash } = require("crypto");
const db = require("../config/dbPenawaran");
const { resolveSalesIdentity } = require("../utils/salesIdentityResolver");

const CREATE_PENAWARAN_DEDUPE_TTL_MS = 30 * 1000;
const createPenawaranInFlight = new Map();

const toShortKey = (value, maxLen = 12) =>
    String(value || "").slice(0, Math.max(1, Number(maxLen) || 12));

const buildCreatePenawaranFingerprint = ({
    tanggal,
    divisi,
    tipe,
    perusahaanKode,
    customerKode,
    salesKode,
    keterangan,
    note,
    details,
}) => {
    const normalized = {
        tanggal: String(tanggal || "").trim(),
        divisi: String(divisi || "").trim(),
        tipe: String(tipe || "").trim(),
        perusahaanKode: String(perusahaanKode || "").trim(),
        customerKode: String(customerKode || "").trim(),
        salesKode: String(salesKode || "").trim(),
        keterangan: String(keterangan || "").trim(),
        note: String(note || "").trim(),
        details: (Array.isArray(details) ? details : []).map((d) => ({
            minta: String(d?.minta || "").trim(),
            nama_barang: String(d?.nama_barang || "").trim(),
            bahan: String(d?.bahan || "").trim(),
            ukuran: String(d?.ukuran || "").trim(),
            panjang: toNumber(d?.panjang, 0),
            lebar: toNumber(d?.lebar, 0),
            satuan: String(d?.satuan || "PCS").trim() || "PCS",
            qty: toNumber(d?.qty, 0),
            harga: toNumber(d?.harga, 0),
        })),
    };

    return createHash("sha1").update(JSON.stringify(normalized)).digest("hex");
};

const cleanCreatePenawaranLocks = () => {
    const now = Date.now();
    for (const [key, value] of createPenawaranInFlight.entries()) {
        if (!value || value.expiresAt <= now) {
            createPenawaranInFlight.delete(key);
        }
    }
};

const acquireCreatePenawaranLock = ({ fingerprint, traceId }) => {
    cleanCreatePenawaranLocks();

    const now = Date.now();
    const existing = createPenawaranInFlight.get(fingerprint);
    if (existing && existing.expiresAt > now) {
        console.log("[PenawaranCreate][LOCK] acquire:blocked", {
            traceId,
            lockKey: toShortKey(fingerprint),
            inFlightTraceId: existing.traceId,
            ttlRemainingMs: existing.expiresAt - now,
        });
        return {
            acquired: false,
            fingerprint,
            traceId,
            inFlightTraceId: existing.traceId,
        };
    }

    createPenawaranInFlight.set(fingerprint, {
        traceId,
        expiresAt: now + CREATE_PENAWARAN_DEDUPE_TTL_MS,
    });

    console.log("[PenawaranCreate][LOCK] acquire:ok", {
        traceId,
        lockKey: toShortKey(fingerprint),
        ttlMs: CREATE_PENAWARAN_DEDUPE_TTL_MS,
    });

    return { acquired: true, fingerprint, traceId };
};

const releaseCreatePenawaranLock = ({ fingerprint, traceId }) => {
    const existing = createPenawaranInFlight.get(fingerprint);
    if (!existing) {
        console.log("[PenawaranCreate][LOCK] release:skip-missing", {
            traceId,
            lockKey: toShortKey(fingerprint),
        });
        return;
    }
    if (existing.traceId !== traceId) {
        console.log("[PenawaranCreate][LOCK] release:skip-owner-mismatch", {
            traceId,
            lockKey: toShortKey(fingerprint),
            ownerTraceId: existing.traceId,
        });
        return;
    }
    createPenawaranInFlight.delete(fingerprint);
    console.log("[PenawaranCreate][LOCK] release:ok", {
        traceId,
        lockKey: toShortKey(fingerprint),
    });
};

const buildDetailDedupKey = (detail) => {
    const normalized = {
        minta: String(detail?.minta || "")
            .trim()
            .toUpperCase(),
        nama_barang: String(detail?.nama_barang || "")
            .trim()
            .toUpperCase(),
        bahan: String(detail?.bahan || "")
            .trim()
            .toUpperCase(),
        ukuran: String(detail?.ukuran || "")
            .trim()
            .toUpperCase(),
        panjang: toNumber(detail?.panjang, 0),
        lebar: toNumber(detail?.lebar, 0),
        satuan: String(detail?.satuan || "PCS")
            .trim()
            .toUpperCase(),
        qty: toNumber(detail?.qty, 0),
        harga: toNumber(detail?.harga, 0),
    };

    return JSON.stringify(normalized);
};

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

const buildStatusCondition = (status) => {
    const normalized = String(status || "ALL")
        .trim()
        .toUpperCase();

    if (normalized === "OPEN") {
        return {
            label: "OPEN",
        };
    }

    if (normalized === "BATAL" || normalized === "CLOSE") {
        return {
            label: normalized,
            value: normalized,
        };
    }

    return {
        label: "ALL",
    };
};

const toNumber = (value, fallback = 0) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
};

const limitText = (value, maxLen) => {
    const text = String(value || "");
    const length = toNumber(maxLen, 0);
    if (length <= 0) return text;
    if (text.length <= length) return text;
    return text.slice(0, length);
};

const isManagerUser = (user) =>
    String(user?.jabatan || "")
        .trim()
        .toUpperCase() === "MANAGER";

const getOwnerCandidates = (req) =>
    Array.from(
        new Set(
            [req.user?.nama, req.user?.id]
                .map((v) => String(v || "").trim())
                .filter(Boolean),
        ),
    );

const getAuthSalesKode = (req) => String(req.user?.sales_kode || "").trim();

const assertPenawaranOwnership = async ({ conn, nomor, req }) => {
    const managerRole = isManagerUser(req.user);
    const authSalesKode = getAuthSalesKode(req);

    if (managerRole) {
        return { allowed: true, ownerSalesKode: "", managerRole: true };
    }

    if (!authSalesKode) {
        return {
            allowed: false,
            statusCode: 403,
            message: "Sales tidak valid (sales_kode kosong)",
        };
    }

    const [ownerRows] = await conn.query(
        `
        SELECT COALESCE(pen_sal_kode, '') AS owner_sales_kode
        FROM tpenawaran_hdr
        WHERE pen_nomor = ?
        LIMIT 1
        `,
        [nomor],
    );

    if (!ownerRows?.length) {
        return {
            allowed: false,
            statusCode: 404,
            message: "Penawaran tidak ditemukan",
        };
    }

    const ownerSalesKode = String(ownerRows[0]?.owner_sales_kode || "").trim();
    const allowed = ownerSalesKode === authSalesKode;

    if (
        String(process.env.PENAWARAN_DEBUG_AUTH || "")
            .trim()
            .toLowerCase() === "1"
    ) {
        console.log("[Penawaran][OwnershipCheck]", {
            nomor,
            managerRole,
            authSalesKode,
            ownerSalesKode,
            allowed,
        });
    }

    if (!allowed) {
        return {
            allowed: false,
            statusCode: 403,
            message: "Tidak berhak mengakses penawaran ini",
        };
    }

    return { allowed: true, ownerSalesKode, managerRole: false };
};

const normalizePerusahaanLookupKey = (value) =>
    String(value || "")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");

const PENAWARAN_TTD_MAP = {
    [normalizePerusahaanLookupKey("CV.Kencana Print")]: {
        ttd: "Tri Yuliani, S.I.Kom",
        ttd_jabatan: "Supervisor Office Marketing",
    },
    [normalizePerusahaanLookupKey("PT.Jaya Abadi Mulia")]: {
        ttd: "Widi Hariyanto",
        ttd_jabatan: "Manager Marketing",
    },
    [normalizePerusahaanLookupKey("PT. Madani Production")]: {
        ttd: "Ariyani Trikusumastuti, S.E.",
        ttd_jabatan: "Chief Marketing Officer",
    },
    [normalizePerusahaanLookupKey("Retailer")]: {
        ttd: "",
        ttd_jabatan: "",
    },
    [normalizePerusahaanLookupKey("Sukiman")]: {
        ttd: "",
        ttd_jabatan: "",
    },
};

const getTtdMappingByPerusahaanNama = (perusahaanNama) => {
    const key = normalizePerusahaanLookupKey(perusahaanNama);
    return PENAWARAN_TTD_MAP[key] || { ttd: "", ttd_jabatan: "" };
};

const getTtdMappingByPerusahaanKode = async (conn, perusahaanKode) => {
    if (!perusahaanKode) return { ttd: "", ttd_jabatan: "" };
    const [rows] = await conn.query(
        `
        SELECT COALESCE(perush_nama, '') AS perush_nama
        FROM tperusahaan
        WHERE perush_kode = ?
        LIMIT 1
        `,
        [perusahaanKode],
    );

    const perusahaanNama = String(rows?.[0]?.perush_nama || "");
    return getTtdMappingByPerusahaanNama(perusahaanNama);
};

const normalizeApprovalState = (value) =>
    String(value || "")
        .trim()
        .toUpperCase();

const normalizePermintaanStatus = (value) =>
    String(value || "")
        .trim()
        .toUpperCase();

const PERMINTAAN_STATUS_SELESAI_VALUES = ["SELESAI", "DONE"];

const isPermintaanStatusSelesai = (value) =>
    PERMINTAAN_STATUS_SELESAI_VALUES.includes(normalizePermintaanStatus(value));

const normalizePermintaanNomor = (value) => String(value || "").trim();

const extractPermintaanNomorFromDetails = (details) => {
    const list = [];
    const seen = new Set();

    for (const detail of Array.isArray(details) ? details : []) {
        const nomor = normalizePermintaanNomor(detail?.minta);
        if (!nomor || seen.has(nomor)) continue;
        seen.add(nomor);
        list.push(nomor);
    }

    return list;
};

const getPermintaanCustomerMap = async (
    conn,
    nomorList,
    { forUpdate = false } = {},
) => {
    if (!Array.isArray(nomorList) || nomorList.length === 0) {
        return new Map();
    }

    const placeholders = buildInPlaceholders(nomorList);
    const lockSql = forUpdate ? " FOR UPDATE" : "";
    const [rows] = await conn.query(
        `
        SELECT
            COALESCE(m.mh_nomor, '') AS nomor,
            COALESCE(m.mh_cus_kode, '') AS customer_kode,
            COALESCE(m.mh_cus_nama, '') AS customer
        FROM tmintaharga m
        WHERE COALESCE(m.mh_nomor, '') IN (${placeholders})${lockSql}
        `,
        nomorList,
    );

    const customerMap = new Map();
    for (const row of rows || []) {
        const nomor = normalizePermintaanNomor(row?.nomor);
        customerMap.set(nomor, {
            customer_kode: String(row?.customer_kode || "").trim(),
            customer: String(row?.customer || "").trim(),
        });
    }
    return customerMap;
};

const buildInPlaceholders = (values) =>
    (Array.isArray(values) ? values : []).map(() => "?").join(", ");

const getPermintaanUsageMap = async (
    conn,
    nomorList,
    { forUpdate = false } = {},
) => {
    if (!Array.isArray(nomorList) || nomorList.length === 0) {
        return new Map();
    }

    const placeholders = buildInPlaceholders(nomorList);
    const lockSql = forUpdate ? " FOR UPDATE" : "";
    const [rows] = await conn.query(
        `
        SELECT
            COALESCE(d.pend_minta, '') AS nomor,
            COUNT(*) AS used_count
        FROM tpenawaran_dtl d
        WHERE COALESCE(d.pend_minta, '') IN (${placeholders})
        GROUP BY d.pend_minta${lockSql}
        `,
        nomorList,
    );

    const usageMap = new Map();
    for (const row of rows || []) {
        const nomor = normalizePermintaanNomor(row?.nomor);
        usageMap.set(nomor, toNumber(row?.used_count, 0));
    }
    return usageMap;
};

const getPermintaanStatusMap = async (
    conn,
    nomorList,
    { forUpdate = false } = {},
) => {
    if (!Array.isArray(nomorList) || nomorList.length === 0) {
        return new Map();
    }

    const placeholders = buildInPlaceholders(nomorList);
    const lockSql = forUpdate ? " FOR UPDATE" : "";
    const [rows] = await conn.query(
        `
        SELECT
            COALESCE(m.mh_nomor, '') AS nomor,
            COALESCE(m.mh_status, '') AS status
        FROM tmintaharga m
        WHERE COALESCE(m.mh_nomor, '') IN (${placeholders})${lockSql}
        `,
        nomorList,
    );

    const statusMap = new Map();
    for (const row of rows || []) {
        const nomor = normalizePermintaanNomor(row?.nomor);
        statusMap.set(nomor, String(row?.status || ""));
    }
    return statusMap;
};

const getLatestApprovalState = async (conn, nomor) => {
    const [rows] = await conn.query(
        `
        SELECT COALESCE(
            IF(pin_acc = '' AND pin_dipakai = '', 'WAIT',
                IF(pin_acc = 'Y' AND pin_dipakai = '', 'ACC',
                    IF(pin_acc = 'N', 'TOLAK', '')
                )
            ),
        '') AS approval_state
        FROM tspk_pin5
        WHERE pin_trs = 'PENAWARAN'
          AND pin_nomor = ?
        ORDER BY pin_urut DESC
        LIMIT 1
        `,
        [nomor],
    );

    return normalizeApprovalState(rows?.[0]?.approval_state);
};

const getNextPinUrut = async (conn, pinTrs, nomor) => {
    const [rows] = await conn.query(
        `
        SELECT COALESCE(MAX(pin_urut), 0) + 1 AS next_urut
        FROM tspk_pin5
        WHERE pin_trs = ? AND pin_nomor = ?
        `,
        [pinTrs, nomor],
    );
    return toNumber(rows?.[0]?.next_urut, 1);
};

const writeStatusAuditLog = async ({ conn, nomor, user, changes }) => {
    if (!Array.isArray(changes) || changes.length === 0) return;

    const pinTrs = "PENAWARAN_STATUS";
    const pinUrut = await getNextPinUrut(conn, pinTrs, nomor);
    const normalizedUser = String(user || "MOBILE").trim() || "MOBILE";
    const userMinta = normalizedUser;
    const shortUserPin = "SISTEM";

    const statusSummary = changes
        .map((item) => {
            const id = String(item?.id || "").trim();
            const beforeStatus = String(item?.before?.status || "-")
                .trim()
                .toUpperCase();
            const afterStatus = String(item?.after?.status || "-")
                .trim()
                .toUpperCase();
            return `${id}:${beforeStatus}->${afterStatus}`;
        })
        .join(", ");

    const pinKetSummary = limitText(
        `Update status detail (${changes.length} item): ${statusSummary}`,
        120,
    );

    const firstMainReason = limitText(
        changes
            .map((item) =>
                String(
                    item?.after?.ket_batal || item?.after?.ket_confirm || "",
                ).trim(),
            )
            .find((v) => v) || "",
        255,
    );

    const hasPinProgram = await hasTableColumn(
        conn,
        "tspk_pin5",
        "pin_program",
    );
    const hasPinTglTrs = await hasTableColumn(conn, "tspk_pin5", "pin_tgl_trs");
    const hasPinKet = await hasTableColumn(conn, "tspk_pin5", "pin_ket");
    const hasPinTglMinta = await hasTableColumn(
        conn,
        "tspk_pin5",
        "pin_tgl_minta",
    );
    const hasPinUserMinta = await hasTableColumn(
        conn,
        "tspk_pin5",
        "pin_user_minta",
    );
    const hasPinTglPin = await hasTableColumn(conn, "tspk_pin5", "pin_tgl_pin");
    const hasPinUserPin = await hasTableColumn(
        conn,
        "tspk_pin5",
        "pin_user_pin",
    );
    const hasPinAcc = await hasTableColumn(conn, "tspk_pin5", "pin_acc");
    const hasPinDipakai = await hasTableColumn(
        conn,
        "tspk_pin5",
        "pin_dipakai",
    );
    const hasPinAlasan = await hasTableColumn(conn, "tspk_pin5", "pin_alasan");

    const insertColumns = ["pin_trs", "pin_nomor", "pin_urut"];
    const insertValues = [pinTrs, nomor, pinUrut];
    const insertPlaceholders = ["?", "?", "?"];

    if (hasPinProgram) {
        insertColumns.push("pin_program");
        insertValues.push("MOBILE");
        insertPlaceholders.push("?");
    }

    if (hasPinTglTrs) {
        insertColumns.push("pin_tgl_trs");
        insertValues.push(new Date());
        insertPlaceholders.push("?");
    }

    if (hasPinKet) {
        insertColumns.push("pin_ket");
        insertValues.push(pinKetSummary);
        insertPlaceholders.push("?");
    }

    if (hasPinTglMinta) {
        insertColumns.push("pin_tgl_minta");
        insertPlaceholders.push("NOW()");
    }

    if (hasPinUserMinta) {
        insertColumns.push("pin_user_minta");
        insertValues.push(userMinta);
        insertPlaceholders.push("?");
    }

    if (hasPinTglPin) {
        insertColumns.push("pin_tgl_pin");
        insertPlaceholders.push("NOW()");
    }

    if (hasPinUserPin) {
        insertColumns.push("pin_user_pin");
        insertValues.push(shortUserPin);
        insertPlaceholders.push("?");
    }

    if (hasPinAcc) {
        insertColumns.push("pin_acc");
        insertValues.push("Y");
        insertPlaceholders.push("?");
    }

    if (hasPinDipakai) {
        insertColumns.push("pin_dipakai");
        insertValues.push("Y");
        insertPlaceholders.push("?");
    }

    if (hasPinAlasan) {
        insertColumns.push("pin_alasan");
        insertValues.push(firstMainReason);
        insertPlaceholders.push("?");
    }

    await conn.query(
        `
        INSERT INTO tspk_pin5 (${insertColumns.join(", ")})
        VALUES (${insertPlaceholders.join(", ")})
        `,
        insertValues,
    );
};

const SCHEMA_CACHE_TTL_MS = 60 * 1000;
let schemaCache = {
    checkedAt: 0,
    tables: new Set(),
    columns: new Map(),
};

const getAvailableTables = async () => {
    const now = Date.now();
    if (now - schemaCache.checkedAt < SCHEMA_CACHE_TTL_MS) {
        return schemaCache.tables;
    }

    const [rows] = await db.query("SHOW TABLES");
    const tableSet = new Set(
        rows.map((row) => String(Object.values(row)[0] || "").toLowerCase()),
    );

    schemaCache = {
        checkedAt: now,
        tables: tableSet,
        columns: new Map(),
    };

    return tableSet;
};

const hasTableColumn = async (conn, tableName, columnName) => {
    const tableKey = String(tableName || "")
        .trim()
        .toLowerCase();
    const columnKey = String(columnName || "")
        .trim()
        .toLowerCase();
    if (!tableKey || !columnKey) return false;

    const now = Date.now();
    if (now - schemaCache.checkedAt >= SCHEMA_CACHE_TTL_MS) {
        await getAvailableTables();
    }

    if (!schemaCache.tables.has(tableKey)) {
        return false;
    }

    const cachedColumns = schemaCache.columns.get(tableKey);
    if (cachedColumns) {
        return cachedColumns.has(columnKey);
    }

    const [rows] = await conn.query(`SHOW COLUMNS FROM ${tableKey}`);
    const colSet = new Set(
        (rows || []).map((row) => String(row?.Field || "").toLowerCase()),
    );
    schemaCache.columns.set(tableKey, colSet);

    return colSet.has(columnKey);
};

const ensurePenawaranSchema = async (res) => {
    const requiredTables = [
        "tpenawaran_hdr",
        "tpenawaran_dtl",
        "tcustomer",
        "tperusahaan",
    ];
    const tableSet = await getAvailableTables();
    const missingTables = requiredTables.filter(
        (t) => !tableSet.has(String(t).toLowerCase()),
    );

    if (missingTables.length === 0) {
        return true;
    }

    res.status(503).json({
        success: false,
        message:
            "Fitur Penawaran belum siap: tabel utama belum tersedia di database aktif",
        database:
            process.env.DB_NAME_PENAWARAN ||
            process.env.DB_NAME_MAIN ||
            "(unknown)",
        missingTables,
    });
    return false;
};

const getNextPenawaranNumber = async (conn, perusahaanKode, tahun) => {
    const [rows] = await conn.query(
        `
        SELECT IFNULL(MAX(LEFT(pen_nomor, 5)), 0) AS jumlah
        FROM tpenawaran_hdr
        WHERE RIGHT(pen_nomor, 7) = ?
          AND SUBSTR(pen_nomor, 4, 1) <> '/'
        `,
        [`${perusahaanKode}/${tahun}`],
    );

    const last = toNumber(rows?.[0]?.jumlah, 0);
    const next = String(100001 + last).slice(-5);
    return `${next}/${perusahaanKode}/${tahun}`;
};

const getPenawaranList = async (req, res) => {
    try {
        const schemaReady = await ensurePenawaranSchema(res);
        if (!schemaReady) return;

        const managerRole = isManagerUser(req.user);
        const ownerCandidates = getOwnerCandidates(req);
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
        const statusInfo = buildStatusCondition(req.query.status);
        const limit = Math.min(
            Math.max(Number(req.query.limit) || 100, 1),
            300,
        );

        const params = [];
        let statusCountParam = "";
        let existsParam = "";

        if (statusInfo.value) {
            statusCountParam = " AND COALESCE(d.pend_status, '') = ?";
            existsParam = " AND COALESCE(d.pend_status, '') = ?";
            // Placeholder pertama muncul di subquery detail_count
            params.push(statusInfo.value);
        }

        // Placeholder tanggal muncul setelah subquery detail_count
        params.push(startDate, endDate);

        if (statusInfo.value) {
            // Placeholder status kedua muncul di EXISTS clause
            params.push(statusInfo.value);
        }

        let searchSql = "";
        if (search) {
            searchSql = `
            AND (
                h.pen_nomor LIKE ?
                OR c.cus_nama LIKE ?
                OR p.perush_nama LIKE ?
                OR COALESCE(s.sal_nama, '') LIKE ?
            )`;
            const like = `%${search}%`;
            params.push(like, like, like, like);
        }

        params.push(limit);

        const queryParams = [];
        if (statusInfo.value) {
            // placeholder untuk statusCountParam
            queryParams.push(statusInfo.value);
        }
        // placeholder untuk range tanggal di WHERE
        queryParams.push(startDate, endDate);
        // placeholder untuk owner filter di WHERE (sales only)
        if (!managerRole) {
            queryParams.push(authSalesKode);
        }
        if (statusInfo.value) {
            // placeholder untuk existsParam
            queryParams.push(statusInfo.value);
        }
        if (search) {
            const like = `%${search}%`;
            queryParams.push(like, like, like, like);
        }
        queryParams.push(limit);

        const ownerFilterSql = managerRole
            ? ""
            : "AND COALESCE(h.pen_sal_kode, '') = ?";

        const sql = `
        SELECT
            h.pen_nomor AS nomor,
            DATE_FORMAT(h.pen_tanggal, '%Y-%m-%d') AS tanggal,
            COALESCE(v.divisi, '') AS divisi,
            COALESCE(h.pen_tipe, '') AS tipe,
            COALESCE(p.perush_nama, '') AS perusahaan,
            COALESCE(c.cus_nama, '') AS customer,
            COALESCE(s.sal_nama, '') AS sales,
            COALESCE(h.pen_keterangan, '') AS keterangan,
            COALESCE(h.pen_fu1, '') AS fu1,
            COALESCE(h.pen_fu2, '') AS fu2,
            COALESCE(h.pen_fu3, '') AS fu3,
            COALESCE(h.pen_proyeksi, '') AS proyeksi,
            IF(
                h.pen_cetaktotal = 1,
                COALESCE((SELECT SUM(d.pend_qty * d.pend_harga) FROM tpenawaran_dtl d WHERE d.pend_pen_nomor = h.pen_nomor), 0),
                COALESCE((SELECT MIN(d.pend_qty * d.pend_harga) FROM tpenawaran_dtl d WHERE d.pend_pen_nomor = h.pen_nomor AND (d.pend_qty * d.pend_harga) > 0), 0)
            ) AS nominal,
            (
                SELECT COUNT(*)
                FROM tpenawaran_dtl d
                WHERE d.pend_pen_nomor = h.pen_nomor ${statusCountParam}
            ) AS detail_count,
            COALESCE((
                SELECT IFNULL(
                    IF(pin_acc = '' AND pin_dipakai = '', 'WAIT',
                        IF(pin_acc = 'Y' AND pin_dipakai = '', 'ACC',
                            IF(pin_acc = 'N', 'TOLAK', '')
                        )
                    ),
                '')
                FROM tspk_pin5
                WHERE pin_trs = 'PENAWARAN' AND pin_nomor = h.pen_nomor
                ORDER BY pin_urut DESC
                LIMIT 1
            ), '') AS approval_state
        FROM tpenawaran_hdr h
        INNER JOIN tcustomer c ON c.cus_kode = h.pen_cus_kode
        INNER JOIN tperusahaan p ON p.perush_kode = h.pen_perush_kode
        LEFT JOIN tsales s ON s.sal_kode = h.pen_sal_kode
        LEFT JOIN tdivisi v ON v.kode = h.pen_divisi
        WHERE h.pen_tanggal >= ?
          AND h.pen_tanggal <= ?
          ${ownerFilterSql}
          AND EXISTS (
              SELECT 1
              FROM tpenawaran_dtl d
              WHERE d.pend_pen_nomor = h.pen_nomor
              ${existsParam}
          )
          ${searchSql}
        ORDER BY h.pen_tanggal DESC, h.pen_nomor DESC
        LIMIT ?`;

        const [rows] = await db.query(sql, queryParams);

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
        const schemaReady = await ensurePenawaranSchema(res);
        if (!schemaReady) return;

        const managerRole = isManagerUser(req.user);
        const ownerCandidates = getOwnerCandidates(req);
        const authSalesKode = getAuthSalesKode(req);
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

        const ownerFilterSql = managerRole
            ? ""
            : "AND COALESCE(h.pen_sal_kode, '') = ?";

        const [headerRows] = await db.query(
            `
            SELECT
                h.pen_nomor AS nomor,
                DATE_FORMAT(h.pen_tanggal, '%Y-%m-%d') AS tanggal,
                COALESCE(h.pen_divisi, '') AS divisi,
                COALESCE(v.divisi, '') AS divisi_nama,
                COALESCE(h.pen_tipe, '') AS tipe,
                COALESCE(h.pen_perush_kode, '') AS perusahaan_kode,
                COALESCE(p.perush_nama, '') AS perusahaan,
                COALESCE(h.pen_cus_kode, '') AS customer_kode,
                COALESCE(c.cus_nama, '') AS customer,
                COALESCE(c.cus_alamat, '') AS customer_alamat,
                COALESCE(c.cus_kota, '') AS customer_kota,
                COALESCE(h.pen_sal_kode, '') AS sales_kode,
                COALESCE(s.sal_nama, '') AS sales,
                COALESCE(h.pen_keterangan, '') AS keterangan,
                COALESCE(h.pen_note, '') AS note,
                COALESCE(h.pen_rekening, '') AS rekening,
                COALESCE(h.pen_dpper, 0) AS dp_per,
                COALESCE(h.pen_ttd, '') AS ttd,
                COALESCE(h.pen_ttd_jabatan, '') AS ttd_jabatan,
                COALESCE(h.pen_up, '') AS up,
                COALESCE(h.pen_marketing, '') AS marketing,
                COALESCE(h.pen_marketing_telp, '') AS marketing_telp,
                COALESCE(h.pen_status_harga, 0) AS status_harga,
                COALESCE(h.pen_cetaktotal, 0) AS cetak_total,
                COALESCE(h.pen_panjang, 0) AS panjang,
                COALESCE(h.pen_lebar, 0) AS lebar,
                COALESCE(h.pen_tambahan, '') AS tambahan,
                COALESCE(h.pen_fu1, '') AS fu1,
                COALESCE(h.pen_fu2, '') AS fu2,
                COALESCE(h.pen_fu3, '') AS fu3,
                COALESCE(h.pen_proyeksi, '') AS proyeksi,
                COALESCE(h.pen_mx, '') AS mx,
                COALESCE(h.pen_digitalsign, '') AS digital_sign,
                IF(
                    h.pen_cetaktotal = 1,
                    COALESCE((SELECT SUM(d.pend_qty * d.pend_harga) FROM tpenawaran_dtl d WHERE d.pend_pen_nomor = h.pen_nomor), 0),
                    COALESCE((SELECT MIN(d.pend_qty * d.pend_harga) FROM tpenawaran_dtl d WHERE d.pend_pen_nomor = h.pen_nomor AND (d.pend_qty * d.pend_harga) > 0), 0)
                ) AS nominal,
                COALESCE((
                    SELECT IFNULL(
                        IF(pin_acc = '' AND pin_dipakai = '', 'WAIT',
                            IF(pin_acc = 'Y' AND pin_dipakai = '', 'ACC',
                                IF(pin_acc = 'N', 'TOLAK', '')
                            )
                        ),
                    '')
                    FROM tspk_pin5
                    WHERE pin_trs = 'PENAWARAN' AND pin_nomor = h.pen_nomor
                    ORDER BY pin_urut DESC
                    LIMIT 1
                ), '') AS approval_state
            FROM tpenawaran_hdr h
            INNER JOIN tcustomer c ON c.cus_kode = h.pen_cus_kode
            INNER JOIN tperusahaan p ON p.perush_kode = h.pen_perush_kode
            LEFT JOIN tsales s ON s.sal_kode = h.pen_sal_kode
            LEFT JOIN tdivisi v ON v.kode = h.pen_divisi
            WHERE h.pen_nomor = ?
              ${ownerFilterSql}
            LIMIT 1
            `,
            managerRole ? [nomor] : [nomor, authSalesKode],
        );

        if (!headerRows || headerRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Data penawaran tidak ditemukan",
            });
        }

        const [detailRows] = await db.query(
            `
            SELECT
                pend_id AS id,
                pend_urutan AS urutan,
                COALESCE(pend_minta, '') AS minta,
                COALESCE(pend_nama_barang, '') AS nama_barang,
                COALESCE(pend_bahan, '') AS bahan,
                COALESCE(pend_ukuran, '') AS ukuran,
                COALESCE(pend_panjang, 0) AS panjang,
                COALESCE(pend_lebar, 0) AS lebar,
                COALESCE(pend_satuan, '') AS satuan,
                COALESCE(pend_qty, 0) AS qty,
                COALESCE(pend_harga, 0) AS harga,
                (COALESCE(pend_qty, 0) * COALESCE(pend_harga, 0)) AS total,
                COALESCE(pend_status, '') AS status,
                COALESCE(pend_batal, '') AS ket_batal,
                COALESCE(pend_confirm, '') AS ket_confirm,
                COALESCE(pend_gambar, '') AS gambar
            FROM tpenawaran_dtl
            WHERE pend_pen_nomor = ?
            ORDER BY pend_urutan, pend_id
            `,
            [nomor],
        );

        return res.json({
            success: true,
            data: {
                header: headerRows[0],
                details: detailRows,
            },
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
    let conn;
    let lockState = null;

    try {
        const schemaReady = await ensurePenawaranSchema(res);
        if (!schemaReady) return;

        conn = await db.getConnection();

        const traceId =
            String(
                req.headers["x-request-id"] ||
                    req.headers["x-idempotency-key"] ||
                    req.body?.client_request_id ||
                    `penawaran-${Date.now()}`,
            ).trim() || `penawaran-${Date.now()}`;

        const body = req.body || {};
        const tanggal =
            normalizeDate(body.tanggal) ||
            normalizeDate(new Date().toISOString());
        const divisi = String(body.divisi || "1").trim();
        const tipe = String(body.tipe || "Medium").trim() || "Medium";
        const perusahaanKode = String(body.perusahaan_kode || "").trim();
        const customerKode = String(body.customer_kode || "").trim();
        const salesKode = String(
            body.sales_kode || body.sal_kode || body.sales_id || body.id || "",
        ).trim();
        const up = String(body.up || "");
        const incomingTtd = String(body.ttd || "").trim();
        const incomingTtdJabatan = String(body.ttd_jabatan || "").trim();
        const keterangan = String(body.keterangan || "").trim();
        const note = String(body.note || "").trim();
        const userCreate =
            String(body.user || body.user_create || "MOBILE").trim() ||
            "MOBILE";
        const details = Array.isArray(body.details) ? body.details : [];

        const dedupedDetails = [];
        const detailSeen = new Set();
        let duplicateDetailCount = 0;
        for (let i = 0; i < details.length; i += 1) {
            const d = details[i] || {};
            const key = buildDetailDedupKey(d);
            if (detailSeen.has(key)) {
                duplicateDetailCount += 1;
                continue;
            }
            detailSeen.add(key);
            dedupedDetails.push(d);
        }

        console.log("[PenawaranCreate][API] incoming", {
            traceId,
            incomingDetails: details.length,
            dedupedDetails: dedupedDetails.length,
            duplicateDetailCount,
            tanggal,
            divisi,
            perusahaanKode,
            customerKode,
            salesKode,
        });

        // Source of truth create penawaran:
        // 1) explicit sales_kode request diprioritaskan jika valid aktif
        // 2) jika explicit kosong/tidak valid, fallback utama ke resolver NIK login
        const resolvedSales = await resolveSalesIdentity({
            loginUser: req.user || {},
            explicitSalesKode: salesKode,
            allowLegacyFallback: false,
        });
        const finalSales = resolvedSales?.sales_kode
            ? {
                  sales_kode: resolvedSales.sales_kode,
                  sales_nama: resolvedSales.sales_nama,
              }
            : null;
        const finalSalesSource = String(resolvedSales?.source || "").trim();

        const ttdFallback = await getTtdMappingByPerusahaanKode(
            conn,
            perusahaanKode,
        );
        const ttd = incomingTtd || ttdFallback.ttd;
        const ttdJabatan = incomingTtdJabatan || ttdFallback.ttd_jabatan;

        const payloadFingerprint = buildCreatePenawaranFingerprint({
            tanggal,
            divisi,
            tipe,
            perusahaanKode,
            customerKode,
            salesKode: finalSales?.sales_kode || salesKode,
            keterangan,
            note,
            details: dedupedDetails,
        });
        const lockKey = toShortKey(payloadFingerprint);

        console.log("[PenawaranCreate][API] lock:prepare", {
            traceId,
            lockKey,
        });

        lockState = acquireCreatePenawaranLock({
            fingerprint: payloadFingerprint,
            traceId,
        });

        if (!lockState.acquired) {
            return res.status(409).json({
                success: false,
                message:
                    "Permintaan create penawaran yang sama sedang diproses",
                trace_id: traceId,
                in_flight_trace_id: lockState.inFlightTraceId,
            });
        }

        if (!tanggal) {
            return res
                .status(400)
                .json({ success: false, message: "Tanggal tidak valid" });
        }
        if (!perusahaanKode) {
            return res
                .status(400)
                .json({ success: false, message: "Perusahaan wajib diisi" });
        }
        if (!customerKode) {
            return res
                .status(400)
                .json({ success: false, message: "Customer wajib diisi" });
        }
        if (!finalSales?.sales_kode) {
            return res.status(400).json({
                success: false,
                message:
                    "Sales tidak valid. sales_kode request kosong/tidak valid, dan fallback NIK login (kar_nik -> sal_nik) tidak menemukan sales aktif.",
                data: {
                    sales_kode: "",
                    sales_source: "",
                },
            });
        }
        if (dedupedDetails.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Detail item minimal 1 baris",
            });
        }

        for (let i = 0; i < dedupedDetails.length; i += 1) {
            const d = dedupedDetails[i] || {};
            const nama = String(d.nama_barang || "").trim();
            const qty = toNumber(d.qty, 0);
            if (!nama) {
                return res.status(400).json({
                    success: false,
                    message: `Nama barang baris ke-${i + 1} wajib diisi`,
                });
            }
            if (qty <= 0) {
                return res.status(400).json({
                    success: false,
                    message: `Qty baris ke-${i + 1} harus lebih dari 0`,
                });
            }
        }

        await conn.beginTransaction();

        const requestedPermintaanNomor =
            extractPermintaanNomorFromDetails(dedupedDetails);

        if (requestedPermintaanNomor.length > 0) {
            const permintaanStatusMap = await getPermintaanStatusMap(
                conn,
                requestedPermintaanNomor,
                { forUpdate: true },
            );
            const permintaanUsageMap = await getPermintaanUsageMap(
                conn,
                requestedPermintaanNomor,
                { forUpdate: true },
            );
            const permintaanCustomerMap = await getPermintaanCustomerMap(
                conn,
                requestedPermintaanNomor,
                { forUpdate: true },
            );

            const conflictNomor = [];
            for (const nomorPermintaan of requestedPermintaanNomor) {
                const status = permintaanStatusMap.get(nomorPermintaan);
                const usedCount = toNumber(
                    permintaanUsageMap.get(nomorPermintaan),
                    0,
                );

                if (
                    !status ||
                    !isPermintaanStatusSelesai(status) ||
                    usedCount > 0
                ) {
                    conflictNomor.push(nomorPermintaan);
                }
            }

            if (conflictNomor.length > 0) {
                await conn.rollback();
                return res.status(409).json({
                    success: false,
                    message:
                        "Sebagian No. Permintaan sudah tidak valid (harus SELESAI/DONE dan belum terpakai)",
                    conflict_nomor_permintaan: conflictNomor,
                });
            }

            const mismatchNomor = [];
            for (const nomorPermintaan of requestedPermintaanNomor) {
                const permintaanCustomer =
                    permintaanCustomerMap.get(nomorPermintaan);
                const permintaanCustomerKode = String(
                    permintaanCustomer?.customer_kode || "",
                ).trim();
                if (!permintaanCustomerKode) {
                    mismatchNomor.push(nomorPermintaan);
                    continue;
                }
                if (permintaanCustomerKode !== customerKode) {
                    mismatchNomor.push(nomorPermintaan);
                }
            }

            if (mismatchNomor.length > 0) {
                await conn.rollback();
                return res.status(409).json({
                    success: false,
                    message:
                        "Customer detail No. Permintaan tidak konsisten dengan customer header transaksi",
                    mismatch_nomor_permintaan: mismatchNomor,
                });
            }
        }

        const tahun = Number(String(tanggal).slice(0, 4));
        const nomor = await getNextPenawaranNumber(conn, perusahaanKode, tahun);

        await conn.query(
            `
            INSERT INTO tpenawaran_hdr (
                pen_nomor,
                pen_divisi,
                pen_tanggal,
                pen_tipe,
                pen_perush_kode,
                pen_cus_kode,
                pen_sal_kode,
                pen_keterangan,
                pen_note,
                pen_rekening,
                pen_dpper,
                pen_status_harga,
                pen_ttd,
                pen_ttd_jabatan,
                pen_up,
                pen_marketing,
                pen_marketing_telp,
                pen_cetaktotal,
                pen_panjang,
                pen_lebar,
                pen_tambahan,
                pen_fu1,
                pen_fu2,
                pen_fu3,
                pen_proyeksi,
                date_create,
                user_create,
                pen_mx,
                pen_digitalsign
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)
            `,
            [
                nomor,
                divisi,
                tanggal,
                tipe,
                perusahaanKode,
                customerKode,
                finalSales.sales_kode,
                keterangan,
                note,
                "",
                0,
                0,
                ttd,
                ttdJabatan,
                up,
                "",
                "",
                1,
                0,
                0,
                "",
                "",
                "",
                "",
                "",
                userCreate,
                "N",
                "N",
            ],
        );

        const [beforeCountRows] = await conn.query(
            `
            SELECT COUNT(*) AS total
            FROM tpenawaran_dtl
            WHERE pend_pen_nomor = ?
            `,
            [nomor],
        );
        const beforeInsertedCount = toNumber(beforeCountRows?.[0]?.total, 0);

        for (let i = 0; i < dedupedDetails.length; i += 1) {
            const d = dedupedDetails[i] || {};
            const urutan = i + 1;
            const id = String(d.id || String(urutan).padStart(2, "0")).slice(
                0,
                2,
            );

            await conn.query(
                `
                INSERT INTO tpenawaran_dtl (
                    pend_urutan,
                    pend_pen_nomor,
                    pend_minta,
                    pend_nama_barang,
                    pend_bahan,
                    pend_ukuran,
                    pend_panjang,
                    pend_lebar,
                    pend_satuan,
                    pend_qty,
                    pend_harga,
                    pend_gambar,
                    pend_status,
                    pend_batal,
                    pend_confirm,
                    pend_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                [
                    urutan,
                    nomor,
                    String(d.minta || "").trim(),
                    String(d.nama_barang || "").trim(),
                    String(d.bahan || "").trim(),
                    String(d.ukuran || "").trim(),
                    toNumber(d.panjang, 0),
                    toNumber(d.lebar, 0),
                    String(d.satuan || "PCS").trim() || "PCS",
                    toNumber(d.qty, 0),
                    toNumber(d.harga, 0),
                    "",
                    "",
                    "",
                    "",
                    id,
                ],
            );
        }

        const [countRows] = await conn.query(
            `
            SELECT COUNT(*) AS total
            FROM tpenawaran_dtl
            WHERE pend_pen_nomor = ?
            `,
            [nomor],
        );
        const insertedCount = toNumber(countRows?.[0]?.total, 0);
        const insertedDelta = insertedCount - beforeInsertedCount;
        if (insertedDelta !== dedupedDetails.length) {
            throw new Error(
                `Jumlah detail tersimpan tidak konsisten. expected=${dedupedDetails.length}, actual_delta=${insertedDelta}, before=${beforeInsertedCount}, after=${insertedCount}`,
            );
        }

        await conn.commit();

        console.log("[PenawaranCreate][API] committed", {
            traceId,
            nomor,
            insertedCount,
            sales_kode: finalSales.sales_kode,
            sales_source: finalSalesSource,
        });

        return res.status(201).json({
            success: true,
            message: "Penawaran berhasil dibuat",
            data: {
                nomor,
                sales_kode: finalSales.sales_kode,
                sales_nama: finalSales.sales_nama,
                sales_source: finalSalesSource,
            },
        });
    } catch (err) {
        if (conn) {
            await conn.rollback();
        }
        console.error("CREATE PENAWARAN ERROR:", err);

        if (err?.code === "ER_DUP_ENTRY") {
            return res.status(409).json({
                success: false,
                message:
                    "No. Permintaan conflict (sudah terpakai oleh transaksi lain). Silakan refresh data dan pilih nomor lain.",
            });
        }

        return res.status(500).json({
            success: false,
            message: err.sqlMessage || err.message || "Gagal membuat penawaran",
        });
    } finally {
        if (lockState?.acquired) {
            console.log("[PenawaranCreate][API] lock:release-requested", {
                traceId: lockState.traceId,
                lockKey: toShortKey(lockState.fingerprint),
            });
            releaseCreatePenawaranLock(lockState);
        }
        if (conn) {
            conn.release();
        }
    }
};

const getMasterPerusahaan = async (req, res) => {
    try {
        const schemaReady = await ensurePenawaranSchema(res);
        if (!schemaReady) return;

        const search = String(req.query.search || "").trim();
        const like = `%${search}%`;

        const [rows] = await db.query(
            `
            SELECT
                p.perush_kode AS kode,
                p.perush_nama AS nama,
                COALESCE(p.perush_alamat, '') AS alamat
            FROM tperusahaan p
            INNER JOIN tpenawaran_hdr h ON h.pen_perush_kode = p.perush_kode
            WHERE (? = '' OR p.perush_kode LIKE ? OR p.perush_nama LIKE ?)
            GROUP BY p.perush_kode, p.perush_nama, p.perush_alamat
            ORDER BY p.perush_nama ASC
            LIMIT 50
            `,
            [search, like, like],
        );

        return res.json({
            success: true,
            data: rows,
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
        const schemaReady = await ensurePenawaranSchema(res);
        if (!schemaReady) return;

        const search = String(req.query.search || "").trim();
        const like = `%${search}%`;

        const [rows] = await db.query(
            `
            SELECT
                c.cus_kode AS cc_kode,
                c.cus_nama AS cc_nama,
                COALESCE(c.cus_alamat, '') AS cc_alamat,
                COALESCE(c.cus_cp, '') AS cc_cp,
                COALESCE(c.cus_telp, '') AS cc_telp,
                'CUSTOMER' AS sumber
            FROM tcustomer c
            WHERE (? = '' OR c.cus_kode LIKE ? OR c.cus_nama LIKE ?)
            ORDER BY c.cus_nama ASC
            LIMIT 50
            `,
            [search, like, like],
        );

        return res.json({
            success: true,
            data: rows || [],
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
        const schemaReady = await ensurePenawaranSchema(res);
        if (!schemaReady) return;

        const search = String(req.query.search || "").trim();
        const like = `%${search}%`;

        const [rows] = await db.query(
            `
            SELECT
                s.sal_kode AS id,
                s.sal_kode AS kode,
                s.sal_nama AS nama,
                COALESCE(s.sal_alamat, '') AS alamat
            FROM tsales s
            INNER JOIN tpenawaran_hdr h ON h.pen_sal_kode = s.sal_kode
            WHERE COALESCE(s.sal_aktif, 'Y') <> 'N'
              AND (? = '' OR s.sal_kode LIKE ? OR s.sal_nama LIKE ?)
            GROUP BY s.sal_kode, s.sal_nama, s.sal_alamat
            ORDER BY s.sal_nama ASC
            LIMIT 50
            `,
            [search, like, like],
        );

        return res.json({
            success: true,
            data: rows,
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
        const schemaReady = await ensurePenawaranSchema(res);
        if (!schemaReady) return;

        const search = String(req.query.search || "").trim();
        const like = `%${search}%`;

        const [rows] = await db.query(
            `
            SELECT
                h.pen_nomor AS kode,
                h.pen_nomor AS nama,
                DATE_FORMAT(h.pen_tanggal, '%Y-%m-%d') AS tanggal,
                COALESCE(c.cus_nama, '') AS customer,
                COALESCE(p.perush_nama, '') AS perusahaan
            FROM tpenawaran_hdr h
            LEFT JOIN tcustomer c ON c.cus_kode = h.pen_cus_kode
            LEFT JOIN tperusahaan p ON p.perush_kode = h.pen_perush_kode
            WHERE (
                ? = ''
                OR h.pen_nomor LIKE ?
                OR COALESCE(c.cus_nama, '') LIKE ?
                OR COALESCE(p.perush_nama, '') LIKE ?
            )
            ORDER BY h.pen_tanggal DESC, h.pen_nomor DESC
            LIMIT 30
            `,
            [search, like, like, like],
        );

        return res.json({
            success: true,
            data: rows || [],
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
        const schemaReady = await ensurePenawaranSchema(res);
        if (!schemaReady) return;

        const search = String(req.query.search || "").trim();
        const selectedNomor = String(req.query.nomor || "").trim();
        const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
        const page = Math.max(Number(req.query.page) || 1, 1);
        const offset = (page - 1) * limit;

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

        const params = [
            effectiveSalesKode,
            ...PERMINTAAN_STATUS_SELESAI_VALUES,
        ];
        let customerSql = "";
        if (referenceCustomerKode) {
            customerSql =
                "\n                  AND COALESCE(m.mh_cus_kode, '') = ?";
            params.push(referenceCustomerKode);
        }
        let searchSql = "";
        if (search) {
            const like = `%${search}%`;
            searchSql = `
                AND (
                    m.mh_nomor LIKE ?
                    OR COALESCE(m.mh_nama, '') LIKE ?
                    OR COALESCE(m.mh_kain, '') LIKE ?
                    OR COALESCE(m.mh_ukuran, '') LIKE ?
                    OR COALESCE(m.mh_cus_nama, '') LIKE ?
                )
            `;
            params.push(like, like, like, like, like);
        }

        params.push(limit, offset);

        const [rows] = await db.query(
            `
            SELECT
                COALESCE(m.mh_nomor, '') AS nomor,
                DATE_FORMAT(m.mh_tanggal, '%Y-%m-%d') AS tanggal,
                COALESCE(m.mh_status, '') AS status,
                COALESCE(m.mh_divisi, '') AS divisi,
                COALESCE(m.mh_sal_kode, '') AS sales_kode,
                COALESCE(s.sal_nama, '') AS sales,
                COALESCE(m.mh_cus_kode, '') AS customer_kode,
                COALESCE(m.mh_cus_nama, '') AS customer,
                COALESCE(m.mh_nama, '') AS nama_barang,
                COALESCE(m.mh_kain, '') AS bahan,
                COALESCE(m.mh_ukuran, '') AS ukuran,
                COALESCE(m.mh_panjang, 0) AS panjang,
                COALESCE(m.mh_lebar, 0) AS lebar,
                    COALESCE(m.mh_jmlorder, 0) AS qty,
                    COALESCE(NULLIF(m.mh_harga_kalkulasi, 0), m.mh_harga, 0) AS harga_referensi,
                    IF(UPPER(TRIM(COALESCE(m.mh_status, ''))) IN ('SELESAI', 'DONE'), 1, 0) AS is_non_belum
                FROM tmintaharga m
                LEFT JOIN tsales s ON s.sal_kode = m.mh_sal_kode
                WHERE COALESCE(m.mh_sal_kode, '') = ?
                  AND UPPER(TRIM(COALESCE(m.mh_status, ''))) IN (?, ?)
                  ${customerSql}
                  AND NOT EXISTS (
                      SELECT 1
                      FROM tpenawaran_dtl d
                      WHERE COALESCE(d.pend_minta, '') = COALESCE(m.mh_nomor, '')
                  )
                ${searchSql}
                ORDER BY m.mh_tanggal DESC, m.mh_nomor DESC
                LIMIT ? OFFSET ?
            `,
            params,
        );

        let selected = null;
        if (selectedNomor) {
            const [detailRows] = await db.query(
                `
                SELECT
                    COALESCE(m.mh_nomor, '') AS nomor,
                    DATE_FORMAT(m.mh_tanggal, '%Y-%m-%d') AS tanggal,
                    COALESCE(m.mh_status, '') AS status,
                    COALESCE(m.mh_divisi, '') AS divisi,
                    COALESCE(m.mh_sal_kode, '') AS sales_kode,
                    COALESCE(s.sal_nama, '') AS sales,
                    COALESCE(m.mh_cus_kode, '') AS customer_kode,
                    COALESCE(m.mh_cus_nama, '') AS customer,
                    COALESCE(m.mh_nama, '') AS nama_barang,
                    COALESCE(m.mh_kain, '') AS bahan,
                    COALESCE(m.mh_ukuran, '') AS ukuran,
                    COALESCE(m.mh_panjang, 0) AS panjang,
                    COALESCE(m.mh_lebar, 0) AS lebar,
                    COALESCE(m.mh_jmlorder, 0) AS qty,
                    COALESCE(NULLIF(m.mh_harga_kalkulasi, 0), m.mh_harga, 0) AS harga_referensi,
                    COALESCE(m.mh_ket, '') AS keterangan,
                    IF(UPPER(TRIM(COALESCE(m.mh_status, ''))) IN ('SELESAI', 'DONE'), 1, 0) AS is_non_belum
                FROM tmintaharga m
                LEFT JOIN tsales s ON s.sal_kode = m.mh_sal_kode
                WHERE m.mh_nomor = ?
                  AND COALESCE(m.mh_sal_kode, '') = ?
                LIMIT 1
                `,
                [selectedNomor, effectiveSalesKode],
            );

            if (detailRows?.length) {
                const d = detailRows[0];
                if (
                    referenceCustomerKode &&
                    String(d.customer_kode || "").trim() !==
                        referenceCustomerKode
                ) {
                    return res.status(409).json({
                        success: false,
                        message:
                            "Customer pada No. Permintaan tidak sama dengan customer acuan transaksi",
                    });
                }
                if (!isPermintaanStatusSelesai(d.status)) {
                    return res.status(409).json({
                        success: false,
                        message:
                            "No. Permintaan belum selesai (hanya status SELESAI/DONE yang diizinkan)",
                    });
                }

                const [usageRows] = await db.query(
                    `
                    SELECT COUNT(*) AS used_count
                    FROM tpenawaran_dtl
                    WHERE COALESCE(pend_minta, '') = ?
                    `,
                    [normalizePermintaanNomor(d.nomor)],
                );
                const isAlreadyUsed =
                    toNumber(usageRows?.[0]?.used_count, 0) > 0;
                if (isAlreadyUsed) {
                    return res.status(409).json({
                        success: false,
                        message:
                            "No. Permintaan sudah terpakai pada penawaran lain dan tidak bisa dipilih",
                    });
                }

                const normalizedStatus = normalizePermintaanStatus(d.status);

                selected = {
                    nomor: d.nomor,
                    tanggal: d.tanggal,
                    status: d.status,
                    divisi: String(d.divisi || "").trim(),
                    sales_kode: d.sales_kode,
                    sales: d.sales,
                    customer_kode: d.customer_kode,
                    customer: d.customer,
                    autofill: {
                        no_permintaan: d.nomor,
                        nama_barang: d.nama_barang,
                        bahan: d.bahan,
                        ukuran: d.ukuran,
                        panjang: toNumber(d.panjang, 0),
                        lebar: toNumber(d.lebar, 0),
                        qty: toNumber(d.qty, 0),
                        harga_referensi: toNumber(d.harga_referensi, 0),
                        keterangan: d.keterangan,
                    },
                    warning:
                        normalizedStatus !== "BELUM"
                            ? `Status permintaan: ${normalizedStatus || "-"}`
                            : "",
                    info: "Form Terisi otomatis",
                };
            }
        }

        return res.json({
            success: true,
            data: {
                options: rows || [],
                selected,
            },
            meta: {
                page,
                limit,
                count: rows?.length || 0,
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
    let conn;

    try {
        const schemaReady = await ensurePenawaranSchema(res);
        if (!schemaReady) return;

        conn = await db.getConnection();
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

        const ownership = await assertPenawaranOwnership({ conn, nomor, req });
        if (!ownership.allowed) {
            return res.status(ownership.statusCode || 403).json({
                success: false,
                message: ownership.message || "Tidak berhak mengakses data",
            });
        }

        await conn.beginTransaction();

        const [headerRows] = await conn.query(
            `SELECT pen_nomor FROM tpenawaran_hdr WHERE pen_nomor = ? LIMIT 1`,
            [nomor],
        );

        if (!headerRows || headerRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({
                success: false,
                message: "Penawaran tidak ditemukan",
            });
        }

        const approvalState = await getLatestApprovalState(conn, nomor);
        if (approvalState === "WAIT") {
            await conn.rollback();
            return res.status(409).json({
                success: false,
                message:
                    "Penawaran sedang dalam proses approval (WAIT), status detail tidak dapat diubah",
                approval_state: approvalState,
            });
        }

        const authUserNama = String(req.user?.nama || "").trim();
        const bodyUser = String(req.body.user || "").trim();
        const userModified = authUserNama || bodyUser || "MOBILE";
        const hasUserModifiedColumn = await hasTableColumn(
            conn,
            "tpenawaran_dtl",
            "user_modified",
        );
        const hasDateModifiedColumn = await hasTableColumn(
            conn,
            "tpenawaran_dtl",
            "date_modified",
        );

        console.log("[PenawaranStatus][SchemaAudit]", {
            nomor,
            hasUserModifiedColumn,
            hasDateModifiedColumn,
        });

        const changes = [];

        for (const upd of updates) {
            const id = String(upd.id || "").trim();
            const newStatus = String(upd.status || "")
                .trim()
                .toUpperCase();
            const ketBatal = String(upd.ket_batal || "").trim();

            if (!id) {
                await conn.rollback();
                return res.status(400).json({
                    success: false,
                    message: "ID item tidak valid",
                });
            }

            if (newStatus === "BATAL" && !ketBatal) {
                await conn.rollback();
                return res.status(400).json({
                    success: false,
                    message: "Status BATAL wajib diisi alasannya (ket_batal)",
                });
            }

            const ketConfirm =
                newStatus === "BATAL"
                    ? ""
                    : String(upd.ket_confirm || "").trim();

            const [detailRows] = await conn.query(
                `
                SELECT
                    COALESCE(pend_status, '') AS status,
                    COALESCE(pend_batal, '') AS ket_batal,
                    COALESCE(pend_confirm, '') AS ket_confirm
                FROM tpenawaran_dtl
                WHERE pend_id = ? AND pend_pen_nomor = ?
                LIMIT 1
                `,
                [id, nomor],
            );

            if (!detailRows || detailRows.length === 0) {
                await conn.rollback();
                return res.status(404).json({
                    success: false,
                    message: `Detail item ${id} tidak ditemukan`,
                });
            }

            const before = detailRows[0];
            const beforeStatus = String(before.status || "")
                .trim()
                .toUpperCase();
            const beforeBatal = String(before.ket_batal || "").trim();
            const beforeConfirm = String(before.ket_confirm || "").trim();

            if (
                beforeStatus === newStatus &&
                beforeBatal === ketBatal &&
                beforeConfirm === ketConfirm
            ) {
                continue;
            }

            const setClauses = [
                "pend_status = ?",
                "pend_batal = ?",
                "pend_confirm = ?",
            ];
            const params = [newStatus, ketBatal, ketConfirm];

            if (hasUserModifiedColumn) {
                setClauses.push("user_modified = ?");
                params.push(userModified);
            }

            if (hasDateModifiedColumn) {
                setClauses.push("date_modified = NOW()");
            }

            params.push(id, nomor);

            await conn.query(
                `
                UPDATE tpenawaran_dtl
                SET
                    ${setClauses.join(",\n                    ")}
                WHERE pend_id = ? AND pend_pen_nomor = ?
                `,
                params,
            );

            changes.push({
                id,
                before: {
                    status: beforeStatus,
                    ket_batal: beforeBatal,
                    ket_confirm: beforeConfirm,
                },
                after: {
                    status: newStatus,
                    ket_batal: ketBatal,
                    ket_confirm: ketConfirm,
                },
            });
        }

        if (changes.length === 0) {
            await conn.rollback();
            return res.json({
                success: true,
                message: "Tidak ada perubahan status detail",
                changed_count: 0,
            });
        }

        await writeStatusAuditLog({
            conn,
            nomor,
            user: userModified,
            changes,
        });

        await conn.commit();

        return res.json({
            success: true,
            message: "Status detail berhasil diubah",
            changed_count: changes.length,
        });
    } catch (err) {
        if (conn) {
            await conn.rollback();
        }
        console.error("UPDATE STATUS DETAIL ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage || err.message || "Gagal mengubah status detail",
        });
    } finally {
        if (conn) {
            conn.release();
        }
    }
};

const getMasterPenawaranBatal = async (req, res) => {
    try {
        const [rows] = await db.query(
            `
            SELECT
                COALESCE(batal, '') AS kode,
                COALESCE(batal, '') AS nama
            FROM tpenawaran_batal
            WHERE COALESCE(batal, '') <> ''
            ORDER BY batal ASC
            `,
        );

        return res.json({
            success: true,
            data: rows || [],
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
        const [rows] = await db.query(
            `
            SELECT
                COALESCE(confirm, '') AS kode,
                COALESCE(confirm, '') AS nama
            FROM tpenawaran_confirm
            WHERE COALESCE(confirm, '') <> ''
            ORDER BY confirm ASC
            `,
        );

        return res.json({
            success: true,
            data: rows || [],
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
    let conn;

    try {
        const schemaReady = await ensurePenawaranSchema(res);
        if (!schemaReady) return;

        conn = await db.getConnection();
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

        const ownership = await assertPenawaranOwnership({ conn, nomor, req });
        if (!ownership.allowed) {
            return res.status(ownership.statusCode || 403).json({
                success: false,
                message: ownership.message || "Tidak berhak mengakses data",
            });
        }

        await conn.beginTransaction();

        const [headerRows] = await conn.query(
            `SELECT pen_nomor FROM tpenawaran_hdr WHERE pen_nomor = ? LIMIT 1`,
            [nomor],
        );

        if (!headerRows || headerRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({
                success: false,
                message: "Penawaran tidak ditemukan",
            });
        }

        const [existingPin] = await conn.query(
            `
                        SELECT pin_nomor
            FROM tspk_pin5
            WHERE pin_trs = 'PENAWARAN'
              AND pin_nomor = ?
              AND COALESCE(pin_dipakai, '') = ''
            LIMIT 1
            `,
            [nomor],
        );

        if (existingPin && existingPin.length > 0) {
            await conn.rollback();
            return res.status(409).json({
                success: false,
                message: "Pengajuan perubahan untuk penawaran ini sudah ada",
            });
        }

        const authUserNama = String(req.user?.nama || "").trim();
        const authUserId = String(req.user?.id || "").trim();
        const bodyUser = String(req.body.user || "").trim();
        const userCreate = (authUserNama || authUserId || bodyUser || "MOBILE")
            .trim()
            .toUpperCase();
        console.log("[RequestApprovalPerubahan][UserResolution]", {
            nomor,
            hasAuthUser: Boolean(authUserNama || authUserId),
            authUserNama,
            authUserId,
            bodyUser,
            resolvedUserCreate: userCreate,
        });
        const pinUrut = await getNextPinUrut(conn, "PENAWARAN", nomor);

        await conn.query(
            `
            INSERT INTO tspk_pin5 (
                pin_trs,
                pin_nomor,
                pin_urut,
                pin_program,
                pin_tgl_trs,
                pin_ket,
                pin_tgl_minta,
                pin_user_minta,
                pin_acc,
                pin_dipakai,
                pin_alasan
            ) VALUES (?, ?, ?, ?, CURDATE(), ?, NOW(), ?, '', '', '')
            `,
            [
                "PENAWARAN",
                nomor,
                pinUrut,
                "MOBILE",
                alasan,
                String(userCreate).slice(0, 10),
            ],
        );

        await conn.commit();

        return res.status(201).json({
            success: true,
            message: "Pengajuan perubahan berhasil dibuat",
            approval_state: "WAIT",
        });
    } catch (err) {
        if (conn) {
            await conn.rollback();
        }
        console.error("REQUEST APPROVAL ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage ||
                err.message ||
                "Gagal membuat pengajuan perubahan",
        });
    } finally {
        if (conn) {
            conn.release();
        }
    }
};

const getPenawaranActivityLogs = async (req, res) => {
    try {
        const schemaReady = await ensurePenawaranSchema(res);
        if (!schemaReady) return;

        const nomor = String(req.params.nomor || "").trim();
        if (!nomor) {
            return res.status(400).json({
                success: false,
                message: "Nomor penawaran tidak valid",
            });
        }

        const ownership = await assertPenawaranOwnership({
            conn: db,
            nomor,
            req,
        });
        if (!ownership.allowed) {
            return res.status(ownership.statusCode || 403).json({
                success: false,
                message: ownership.message || "Tidak berhak mengakses data",
            });
        }

        const [rows] = await db.query(
            `
            SELECT
                COALESCE(pin_trs, '') AS pin_trs,
                COALESCE(pin_nomor, '') AS pin_nomor,
                COALESCE(pin_urut, 0) AS pin_urut,
                COALESCE(pin_ket, '') AS pin_ket,
                COALESCE(pin_acc, '') AS pin_acc,
                COALESCE(pin_dipakai, '') AS pin_dipakai,
                pin_tgl_minta,
                COALESCE(pin_user_minta, '') AS pin_user_minta,
                COALESCE(pin_alasan, '') AS pin_alasan
            FROM tspk_pin5
            WHERE pin_nomor = ?
              AND pin_trs IN ('PENAWARAN', 'PENAWARAN_STATUS')
            ORDER BY pin_tgl_minta DESC, pin_urut DESC
            LIMIT 100
            `,
            [nomor],
        );

        const data = (rows || []).map((row) => {
            const pinTrs = String(row.pin_trs || "")
                .trim()
                .toUpperCase();

            if (pinTrs === "PENAWARAN_STATUS") {
                let parsed = null;
                try {
                    parsed = JSON.parse(String(row.pin_ket || "{}"));
                } catch (e) {
                    parsed = null;
                }

                return {
                    type: "STATUS_UPDATE",
                    created_at: row.pin_tgl_minta,
                    user: row.pin_user_minta || "",
                    keterangan: row.pin_ket || "",
                    changes: parsed?.changes || [],
                };
            }

            const approvalState = normalizeApprovalState(
                row.pin_acc === "" && row.pin_dipakai === ""
                    ? "WAIT"
                    : row.pin_acc === "Y" && row.pin_dipakai === ""
                      ? "ACC"
                      : row.pin_acc === "N"
                        ? "TOLAK"
                        : "",
            );

            return {
                type: "APPROVAL",
                created_at: row.pin_tgl_minta,
                user: row.pin_user_minta || "",
                keterangan: row.pin_alasan || "",
                approval_state: approvalState,
                changes: [],
            };
        });

        return res.json({
            success: true,
            data,
        });
    } catch (err) {
        console.error("GET PENAWARAN ACTIVITY LOGS ERROR:", err);
        return res.status(500).json({
            success: false,
            message:
                err.sqlMessage || err.message || "Gagal mengambil activity log",
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
};
