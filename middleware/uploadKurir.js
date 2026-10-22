const multer = require("multer");
const path = require("path");
const fs = require("fs");

const UPLOAD_DIR = path.join(process.cwd(), "uploads", "kiriman");
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        const id = req.params.id || "kiriman";
        const ext = path.extname(file.originalname || "") || ".jpg";
        cb(null, `${id}-${Date.now()}${ext.toLowerCase()}`);
    },
});

const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const isImageExt = [".jpg", ".jpeg", ".png", ".webp"].includes(ext);
    const isImageMime = /^image\/(jpeg|jpg|png|webp)$/i.test(file.mimetype);
    if (!isImageMime && !isImageExt) {
        return cb(new Error("Tipe file harus gambar (jpg/png/webp)"), false);
    }
    cb(null, true);
};

const uploadKurir = multer({
    storage,
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 },
});

module.exports = { uploadKurir, UPLOAD_DIR };
