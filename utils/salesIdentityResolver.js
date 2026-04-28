const dbPenawaran = require("../config/dbPenawaran");
const dbMain = require("../config/dbMain");

const normalizeName = (value) =>
    String(value || "")
        .toUpperCase()
        .replace(/[^A-Z0-9 ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

const getCandidateSalesCodesFromUser = (user) => {
    const keys = [
        "sales_kode",
        "sal_kode",
        "kode_sales",
        "kode",
        "spk_sal_kode",
        "kar_kode_sales",
    ];

    const values = [];
    for (const key of keys) {
        const v = String(user?.[key] || "").trim();
        if (v) values.push(v);
    }
    return [...new Set(values)];
};

const findActiveSalesByKode = async (kode) => {
    const cleanKode = String(kode || "").trim();
    if (!cleanKode) return null;

    const [rows] = await dbPenawaran.query(
        `
        SELECT
            s.sal_kode AS sales_kode,
            s.sal_nama AS sales_nama
        FROM tsales s
        WHERE s.sal_kode = ?
          AND COALESCE(s.sal_aktif, 'Y') <> 'N'
        LIMIT 1
        `,
        [cleanKode],
    );

    return rows?.[0] || null;
};

const getCandidateNiksFromUser = (user) => {
    const keys = ["kar_nik", "nik", "user_nik", "karyawan_nik"];
    const values = [];
    for (const key of keys) {
        const v = String(user?.[key] || "").trim();
        if (v) values.push(v);
    }
    return [...new Set(values)];
};

const findKaryawanNikById = async (id) => {
    const userId = Number(id);
    if (!Number.isFinite(userId) || userId <= 0) return "";

    const [rows] = await dbMain.query(
        `
        SELECT COALESCE(kar_nik, '') AS kar_nik
        FROM tkaryawan
        WHERE id = ?
          AND kar_isaktif = 1
        LIMIT 1
        `,
        [userId],
    );

    return String(rows?.[0]?.kar_nik || "").trim();
};

const findActiveSalesByNik = async (nik) => {
    const cleanNik = String(nik || "").trim();
    if (!cleanNik) return null;

    const [rows] = await dbPenawaran.query(
        `
        SELECT
            s.sal_kode AS sales_kode,
            s.sal_nama AS sales_nama,
            COALESCE(s.sal_nik, '') AS sales_nik
        FROM tsales s
        WHERE COALESCE(s.sal_nik, '') = ?
          AND COALESCE(s.sal_aktif, 'Y') <> 'N'
        LIMIT 1
        `,
        [cleanNik],
    );

    return rows?.[0] || null;
};

const findActiveSalesByNameNormalized = async (name) => {
    const normalizedLoginName = normalizeName(name);
    if (!normalizedLoginName) return null;

    const [rows] = await dbPenawaran.query(
        `
        SELECT
            s.sal_kode AS sales_kode,
            s.sal_nama AS sales_nama
        FROM tsales s
        WHERE COALESCE(s.sal_aktif, 'Y') <> 'N'
        ORDER BY s.sal_nama ASC
        `,
    );

    if (!Array.isArray(rows) || rows.length === 0) return null;

    const exact = rows.find(
        (row) => normalizeName(row.sales_nama) === normalizedLoginName,
    );
    if (exact) return exact;

    const loginTokens = normalizedLoginName.split(" ").filter(Boolean);
    if (loginTokens.length === 0) return null;

    const loose = rows.find((row) => {
        const normalizedSalesName = normalizeName(row.sales_nama);
        return loginTokens.every((token) =>
            normalizedSalesName.includes(token),
        );
    });

    return loose || null;
};

const resolveSalesIdentity = async ({
    loginUser,
    explicitSalesKode,
    allowLegacyFallback = true,
} = {}) => {
    const explicitKode = String(explicitSalesKode || "").trim();

    if (explicitKode) {
        const explicitMatch = await findActiveSalesByKode(explicitKode);
        if (explicitMatch) {
            return {
                sales_kode: explicitMatch.sales_kode,
                sales_nama: explicitMatch.sales_nama,
                source: "explicit",
            };
        }
    }

    const nikCandidates = getCandidateNiksFromUser(loginUser);
    if (nikCandidates.length === 0) {
        const nikFromId = await findKaryawanNikById(loginUser?.id);
        if (nikFromId) nikCandidates.push(nikFromId);
    }

    for (const nikCandidate of nikCandidates) {
        const matchedByNik = await findActiveSalesByNik(nikCandidate);
        if (matchedByNik) {
            return {
                sales_kode: matchedByNik.sales_kode,
                sales_nama: matchedByNik.sales_nama,
                sales_nik: matchedByNik.sales_nik,
                source: "resolver_nik",
            };
        }
    }

    if (!allowLegacyFallback) {
        return null;
    }

    const userCodeCandidates = getCandidateSalesCodesFromUser(loginUser);
    for (const kodeCandidate of userCodeCandidates) {
        const matched = await findActiveSalesByKode(kodeCandidate);
        if (matched) {
            return {
                sales_kode: matched.sales_kode,
                sales_nama: matched.sales_nama,
                source: "login-user-code",
            };
        }
    }

    const matchedByName = await findActiveSalesByNameNormalized(
        loginUser?.nama,
    );
    if (matchedByName) {
        return {
            sales_kode: matchedByName.sales_kode,
            sales_nama: matchedByName.sales_nama,
            source: "login-user-name",
        };
    }

    return null;
};

module.exports = {
    resolveSalesIdentity,
    findActiveSalesByKode,
    findActiveSalesByNik,
    findActiveSalesByNameNormalized,
};
