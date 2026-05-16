const fs = require("fs");
const path = require("path");
const multer = require("multer");

// Path lokal ke folder gambar — folder ini yang di-share via SMB ke Delphi
// (\\103.94.238.252\image\mintaharga adalah share dari folder lokal ini).
// Bisa di-override via env IMAGE_UPLOAD_DIR jika lokasi berbeda.
const DEFAULT_UPLOAD_DIR = path.join(process.cwd(), "image", "mintaharga");
const UPLOAD_DIR = String(
    process.env.IMAGE_UPLOAD_DIR || DEFAULT_UPLOAD_DIR,
).trim();

// Buat direktori jika belum ada
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

console.log("[UploadPermintaanHarga][Init]", {
    uploadDir: UPLOAD_DIR,
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        fs.access(UPLOAD_DIR, fs.constants.W_OK, (err) => {
            if (err) {
                console.error("[UploadPermintaanHarga][Destination][ERROR]", {
                    uploadDir: UPLOAD_DIR,
                    code: err.code,
                    message: err.message,
                });
                return cb(
                    new Error(
                        `Folder upload tidak bisa ditulis: ${UPLOAD_DIR} (${err.code || "UNKNOWN"})`,
                    ),
                );
            }
            return cb(null, UPLOAD_DIR);
        });
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
        console.log("[UploadPermintaanHarga][FileFilter]", {
            originalname: file?.originalname,
            mimetype: file?.mimetype,
            uploadDir: UPLOAD_DIR,
        });
        const allowed = new Set(["image/jpeg", "image/jpg", "image/png"]);
        if (!allowed.has(String(file.mimetype || "").toLowerCase())) {
            console.error("[UploadPermintaanHarga][FileFilter][REJECT]", {
                originalname: file?.originalname,
                mimetype: file?.mimetype,
            });
            return cb(new Error("Format file harus JPG atau PNG"));
        }
        return cb(null, true);
    },
    limits: {
        fileSize: 1 * 1024 * 1024, // 1MB
    },
});

module.exports = { uploadPermintaanHarga, UPLOAD_DIR };
