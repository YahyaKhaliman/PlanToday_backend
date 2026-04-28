const jwt = require("jsonwebtoken");
const db = require("../config/dbMain");
const { resolveSalesIdentity } = require("../utils/salesIdentityResolver");

module.exports = async function auth(req, res, next) {
    try {
        const header = req.headers.authorization || "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : null;
        if (!token) {
            return res
                .status(401)
                .json({
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
            return res
                .status(401)
                .json({
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

        next();
    } catch (e) {
        return res
            .status(401)
            .json({ success: false, message: "Unauthorized (invalid token)" });
    }
};
