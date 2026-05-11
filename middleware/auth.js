const jwt = require("jsonwebtoken");
const db = require("../config/dbMain");
const { resolveSalesIdentity } = require("../utils/salesIdentityResolver");

const extractToken = (req) => {
    const rawAuthorization = String(req.headers.authorization || "").trim();

    // Normal form: Authorization: Bearer <token> (case-insensitive)
    const bearerMatch = rawAuthorization.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch?.[1]) {
        return String(bearerMatch[1]).trim();
    }

    // Fallback 1: token mentah di Authorization header
    if (rawAuthorization && !rawAuthorization.includes(" ")) {
        return rawAuthorization;
    }

    // Fallback 2: common custom headers
    const xAccessToken = String(req.headers["x-access-token"] || "").trim();
    if (xAccessToken) return xAccessToken;

    const xAuthToken = String(req.headers["x-auth-token"] || "").trim();
    if (xAuthToken) return xAuthToken;

    const tokenHeader = String(req.headers.token || "").trim();
    if (tokenHeader) return tokenHeader;

    const authTokenHeader = String(req.headers["auth-token"] || "").trim();
    if (authTokenHeader) return authTokenHeader;

    const jwtHeader = String(req.headers.jwt || "").trim();
    if (jwtHeader) return jwtHeader;

    // Fallback 3: query/body token (legacy clients)
    const queryToken = String(
        req.query?.token || req.query?.access_token || "",
    ).trim();
    if (queryToken) return queryToken;

    const bodyToken = String(
        req.body?.token || req.body?.access_token || "",
    ).trim();
    if (bodyToken) return bodyToken;

    const cookieRaw = String(req.headers.cookie || "").trim();
    if (cookieRaw) {
        const matched = cookieRaw.match(
            /(?:^|;\s*)(?:token|access_token)=([^;]+)/i,
        );
        if (matched?.[1]) return String(matched[1]).trim();
    }

    return "";
};

module.exports = async function auth(req, res, next) {
    try {
        const token = extractToken(req)
            .trim()
            .replace(/^"|"$/g, "")
            .replace(/^'|'$/g, "");

        if (
            String(process.env.AUTH_DEBUG || "")
                .trim()
                .toLowerCase() === "1"
        ) {
            console.log("[Auth][TokenExtract]", {
                path: req.path,
                method: req.method,
                hasAuthorization: Boolean(req.headers.authorization),
                hasXAccessToken: Boolean(req.headers["x-access-token"]),
                hasXAuthToken: Boolean(req.headers["x-auth-token"]),
                hasTokenHeader: Boolean(req.headers.token),
                hasAuthTokenHeader: Boolean(req.headers["auth-token"]),
                hasJwtHeader: Boolean(req.headers.jwt),
                hasQueryToken: Boolean(
                    req.query?.token || req.query?.access_token,
                ),
                hasBodyToken: Boolean(
                    req.body?.token || req.body?.access_token,
                ),
                hasCookieHeader: Boolean(req.headers.cookie),
                tokenExtracted: Boolean(token),
            });
        }

        if (
            String(process.env.AUTH_DEBUG_PENAWARAN || "")
                .trim()
                .toLowerCase() === "1" &&
            String(req.path || "").startsWith("/penawaran")
        ) {
            const authHeader = String(req.headers.authorization || "");
            const authPreview = authHeader
                ? `${authHeader.slice(0, 20)}...len=${authHeader.length}`
                : "";
            console.log("[Auth][Penawaran][TokenCheck]", {
                path: req.path,
                method: req.method,
                hasAuthorization: Boolean(req.headers.authorization),
                authPreview,
                tokenExtracted: Boolean(token),
            });
        }

        if (!token) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized (token missing)",
            });
        }

        const payload = jwt.verify(token, process.env.JWT_SECRET);

        const [rows] = await db.query(
            `SELECT id, kar_nama, kar_jabatan, kar_cabang
        FROM tkaryawan
        WHERE id = ? AND kar_isaktif = 1
        LIMIT 1`,
            [payload.id],
        );

        if (!rows.length) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized (user not found)",
            });
        }

        const u = rows[0];
        const resolvedSales = await resolveSalesIdentity({
            loginUser: {
                id: u.id,
                nama: u.kar_nama,
                jabatan: u.kar_jabatan,
                cabang: u.kar_cabang,
            },
        });
        req.user = {
            id: u.id,
            nama: u.kar_nama,
            jabatan: u.kar_jabatan,
            cabang: u.kar_cabang,
            sales_kode: resolvedSales?.sales_kode || "",
            sales_nama: resolvedSales?.sales_nama || "",
        };

        if (
            String(process.env.PH_DEBUG_LIST || "")
                .trim()
                .toLowerCase() === "1" &&
            String(req.path || "").includes("/permintaan-harga")
        ) {
            console.log("[Auth][PermintaanHarga][User]", {
                path: req.path,
                method: req.method,
                id: req.user.id,
                nama: req.user.nama,
                jabatan: req.user.jabatan,
                sales_kode: req.user.sales_kode,
                sales_nama: req.user.sales_nama,
            });
        }

        next();
    } catch (e) {
        return res
            .status(401)
            .json({ success: false, message: "Unauthorized (invalid token)" });
    }
};
