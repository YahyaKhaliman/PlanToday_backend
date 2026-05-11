const db = require("../config/dbMain");
const jwt = require("jsonwebtoken");
const auth = require("../middleware/auth");
const { resolveSalesIdentity } = require("../utils/salesIdentityResolver");

const login = async (req, res) => {
    const { username, password, deviceId, versiApp } = req.body;

    if (!username || !password) {
        return res.status(400).json({
            success: false,
            message: "Username dan password wajib diisi",
        });
    }

    try {
        const [rows] = await db.query(
            `SELECT *
        FROM tkaryawan
        WHERE kar_isaktif = 1
          AND kar_nama = ?
          AND kar_password = ?
        LIMIT 1`,
            [username, password],
        );

        if (rows.length === 0) {
            return res.json({
                success: false,
                message: "Username atau password salah",
            });
        }

        const user = rows[0];
        const resolvedSales = await resolveSalesIdentity({
            loginUser: {
                id: user.id,
                nama: user.kar_nama,
                jabatan: user.kar_jabatan,
                cabang: user.kar_cabang,
            },
        });

        const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
            expiresIn: "7d",
        });

        await db.query(
            `INSERT INTO marketing.log_plantoday
        (log_nama, log_cabang, log_versi_app, tanggal, log_phoneid)
        VALUES (?, ?, ?, NOW(), ?)`,
            [user.kar_nama, user.kar_cabang, versiApp || "", deviceId || ""],
        );

        console.log("AUTH HEADER:", req.headers.authorization);
        return res.status(200).json({
            success: true,
            token,
            user: {
                id: user.id,
                nama: user.kar_nama,
                jabatan: user.kar_jabatan,
                cabang: user.kar_cabang,
                sales_kode: resolvedSales?.sales_kode || "",
                sales_nama: resolvedSales?.sales_nama || "",
            },
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({
            success: false,
            message: "Kesalahan server",
        });
    }
};

const profile = [
    auth,
    async (req, res) => {
        return res.status(200).json({
            success: true,
            user: {
                id: req.user?.id,
                nama: req.user?.nama,
                jabatan: req.user?.jabatan,
                cabang: req.user?.cabang,
                sales_kode: req.user?.sales_kode || "",
                sales_nama: req.user?.sales_nama || "",
            },
        });
    },
];

const register = async (req, res) => {
    const { nama, password, cabang, jabatan, deviceId } = req.body;
    console.debug(req.body);
    if (!nama || nama.length < 3 || !password || password.length < 3) {
        return res.status(400).json({
            success: false,
            message:
                "Data Belum Lengkap (Nama dan Password minimal 3 karakter)",
        });
    }

    try {
        const [rows] = await db.query(
            `SELECT * FROM tkaryawan
        WHERE kar_nama = ?
        AND kar_registrasi = ?
        LIMIT 1`,
            [nama, deviceId],
        );

        if (rows.length > 0) {
            await db.query(
                `UPDATE tkaryawan
          SET kar_jabatan = ?,
              kar_cabang = ?,
              kar_password = ?
          WHERE kar_nama = ? AND kar_registrasi = ?`,
                [jabatan, cabang, password, nama, deviceId],
            );

            return res.status(200).json({
                success: true,
                message: "Update Password Berhasil.\nSilahkan Login Ulang",
            });
        } else {
            await db.query(
                `INSERT INTO tkaryawan
          (kar_nama, kar_cabang, kar_jabatan, kar_registrasi, kar_password, kar_isaktif)
          VALUES (?, ?, ?, ?, ?, 0)`,
                [nama, cabang, jabatan, deviceId, password],
            );

            return res.status(201).json({
                success: true,
                message: "Registrasi Berhasil. Hubungi IT untuk aktifkan user.",
            });
        }
    } catch (err) {
        console.error("REGISTER ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Terjadi kesalahan server: " + err.message,
        });
    }
};

const checkDevice = async (req, res) => {
    const { deviceId } = req.body;
    if (!deviceId) {
        return res.status(400).json({
            success: false,
            message: "Device belum terdaftar",
        });
    }

    try {
        const [rows] = await db.query(
            `SELECT l.log_nama AS kar_nama
         FROM marketing.log_plantoday l
         INNER JOIN tkaryawan k ON k.kar_nama = l.log_nama
         WHERE l.log_phoneid = ?
           AND k.kar_isaktif = 1
         ORDER BY l.tanggal DESC
         LIMIT 1`,
            [deviceId],
        );

        if (rows.length === 0) {
            return res.json({
                success: false,
                message: "Device belum terdaftar",
            });
        }

        return res.json({
            success: true,
            username: rows[0].kar_nama,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            message: "Server error",
        });
    }
};

module.exports = { login, register, checkDevice, profile };
