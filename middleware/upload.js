// middleware/uploadVisit.js
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'visits'); 
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
    const id = req.params.id || 'visit';
    const ext = path.extname(file.originalname || '') || '.jpg';
    const safeExt = ext.toLowerCase();
    cb(null, `${id}-${Date.now()}${safeExt}`);
    },
});

const fileFilter = (req, file, cb) => {
    const ok = /^image\/(jpeg|jpg|png|webp)$/i.test(file.mimetype);
    if (!ok) return cb(new Error('Tipe file harus gambar (jpg/png/webp)'), false);
    cb(null, true);
};

const uploadVisit = multer({
    storage,
    fileFilter,
    limits: { fileSize: 1 * 1024 * 1024 }, // 1MB
});

module.exports = { uploadVisit, UPLOAD_DIR };
