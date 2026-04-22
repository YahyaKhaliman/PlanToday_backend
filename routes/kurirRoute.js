const express = require("express");
const router = express.Router();

const auth = require("../middleware/auth");
const { uploadKurir } = require("../middleware/uploadKurir");
const kurirController = require("../controllers/kurirController");

router.use("/kurir", auth);

// Contract menu (Delphi /kiriman compatible, maintainable naming)
router.get("/kurir/kirim", kurirController.getKirim);
router.get("/kurir/rekap-kirim", kurirController.getRekapKirim);
router.get("/kurir/rencana-kirim", kurirController.getRencanaKirim);
router.get("/kurir/rekap-rencana-kirim", kurirController.getRekapRencanaKirim);

// Existing generic endpoints (keep for compatibility)
router.get("/kurir/pengiriman", kurirController.listPengiriman);
router.get("/kurir/pengiriman/:id", kurirController.getPengirimanById);
router.post("/kurir/pengiriman", kurirController.createPengiriman);
router.put("/kurir/pengiriman/:id", kurirController.updatePengiriman);
router.post(
    "/kurir/pengiriman/:id/photo",
    (req, res, next) => {
        uploadKurir.single("file")(req, res, (err) => {
            if (err) {
                return res
                    .status(400)
                    .json({ success: false, message: err.message });
            }
            next();
        });
    },
    kurirController.uploadPengirimanPhoto,
);
router.patch(
    "/kurir/pengiriman/:id/status",
    kurirController.updatePengirimanStatus,
);
router.delete("/kurir/pengiriman/:id", kurirController.softDeletePengiriman);

module.exports = router;
