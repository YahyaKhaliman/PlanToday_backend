const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const {
    uploadPermintaanHarga,
} = require("../middleware/uploadPermintaanHarga");
const controller = require("../controllers/permintaanHargaController");

router.get("/permintaan-harga", auth, controller.getPermintaanHargaList);
router.get(
    "/permintaan-harga/:nomor",
    auth,
    controller.getPermintaanHargaDetail,
);
router.post("/permintaan-harga", auth, controller.createPermintaanHarga);
router.post(
    "/permintaan-harga/customer",
    auth,
    controller.createPermintaanHargaCustomer,
);
router.put("/permintaan-harga/:nomor", auth, controller.updatePermintaanHarga);
router.post(
    "/permintaan-harga/:nomor/copy",
    auth,
    controller.copyPermintaanHarga,
);
router.delete(
    "/permintaan-harga/:nomor",
    auth,
    controller.deletePermintaanHarga,
);
router.post(
    "/permintaan-harga/:nomor/gambar/:slot",
    auth,
    (req, res, next) => {
        console.log("[PermintaanHarga][Upload][Route][Incoming]", {
            nomor: req.params?.nomor,
            slot: req.params?.slot,
            contentType: req.headers?.["content-type"],
            contentLength: req.headers?.["content-length"],
            userAgent: req.headers?.["user-agent"],
        });
        uploadPermintaanHarga.single("file")(req, res, (err) => {
            if (err) {
                console.error("[PermintaanHarga][Upload][Route][MulterError]", {
                    nomor: req.params?.nomor,
                    slot: req.params?.slot,
                    message: err.message,
                    stack: err.stack,
                });
                return res.status(400).json({
                    success: false,
                    message: err.message || "Upload gambar gagal",
                });
            }
            console.log("[PermintaanHarga][Upload][Route][Parsed]", {
                nomor: req.params?.nomor,
                slot: req.params?.slot,
                hasFile: Boolean(req.file),
                filename: req.file?.filename,
                mimetype: req.file?.mimetype,
                size: req.file?.size,
                destination: req.file?.destination,
                path: req.file?.path,
            });
            return next();
        });
    },
    controller.uploadPermintaanHargaImage,
);

// TEMP TEST: endpoint uploader internal untuk isolasi uji upload (tanpa validasi DB/status).
router.post(
    "/permintaan-harga-internal/:nomor/gambar/:slot",
    auth,
    (req, res, next) => {
        uploadPermintaanHarga.single("file")(req, res, (err) => {
            if (err) {
                return res.status(400).json({
                    success: false,
                    message: err.message || "Upload internal gambar gagal",
                });
            }
            return next();
        });
    },
    controller.uploadPermintaanHargaImageInternal,
);

// TEMP TEST: endpoint upload base64 (tanpa multipart/multer) untuk bypass masalah network multipart RN.
router.post(
    "/permintaan-harga/:nomor/gambar-base64/:slot",
    auth,
    controller.uploadPermintaanHargaImageBase64,
);

module.exports = router;
