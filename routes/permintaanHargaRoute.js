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
        uploadPermintaanHarga.single("file")(req, res, (err) => {
            if (err) {
                return res.status(400).json({
                    success: false,
                    message: err.message || "Upload gambar gagal",
                });
            }
            return next();
        });
    },
    controller.uploadPermintaanHargaImage,
);

module.exports = router;
