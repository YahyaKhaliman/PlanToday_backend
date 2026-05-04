const fs = require("fs");
const path = require("path");
const multer = require("multer");

const UPLOAD_DIR = path.join(process.cwd(), "image", "mintaharga");
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        const nomor = String(req.params.nomor || "")
            .trim()
            .replace(/[^A-Z0-9\-_/]/gi, "_");
        const slot = String(req.params.slot || "1").trim();
        const suffix = slot === "2" ? "-2" : "";
        cb(null, `${nomor}${suffix}.jpg`);
    },
});

const uploadPermintaanHarga = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const allowed = new Set(["image/jpeg", "image/jpg", "image/png"]);
        if (!allowed.has(String(file.mimetype || "").toLowerCase())) {
            return cb(new Error("Format file harus JPG atau PNG"));
        }
        return cb(null, true);
    },
    limits: {
        fileSize: 5 * 1024 * 1024,
    },
});

module.exports = { uploadPermintaanHarga, UPLOAD_DIR };
