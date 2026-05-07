const fs = require("fs");
const path = require("path");
const multer = require("multer");

// TEMP TEST: arahkan upload langsung ke SMB share (default), bisa dioverride via env.
const DEFAULT_SMB_UPLOAD_DIR = "\\\\103.94.238.252\\image\\mintaharga";
const UPLOAD_DIR = String(
    process.env.IMAGE_UPLOAD_DIR || DEFAULT_SMB_UPLOAD_DIR,
).trim();

console.log("[UploadPermintaanHarga][Init]", {
    uploadDir: UPLOAD_DIR,
    isUncPath: /^\\\\[^\\]+\\[^\\]+/i.test(UPLOAD_DIR),
});

// const isUncPath = /^\\\\[^\\]+\\[^\\]+/i.test(UPLOAD_DIR);
// if (!isUncPath && !fs.existsSync(UPLOAD_DIR)) {
//     fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// }

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
        fileSize: 5 * 1024 * 1024,
    },
});

module.exports = { uploadPermintaanHarga, UPLOAD_DIR };
