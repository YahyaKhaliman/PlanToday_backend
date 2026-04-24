const express = require("express");
const router = express.Router();
const penawaranController = require("../controllers/penawaranController");

router.get("/penawaran", penawaranController.getPenawaranList);
router.get("/penawaran/:nomor", penawaranController.getPenawaranDetail);
router.post("/penawaran", penawaranController.createPenawaran);
router.put(
    "/penawaran/:nomor/status",
    penawaranController.updatePenawaranStatusDetail,
);
router.post(
    "/penawaran/:nomor/pengajuan-perubahan",
    penawaranController.requestApprovalPerubahan,
);
router.get(
    "/penawaran/:nomor/activity-logs",
    penawaranController.getPenawaranActivityLogs,
);
router.get(
    "/penawaran/master/perusahaan",
    penawaranController.getMasterPerusahaan,
);
router.get("/penawaran/master/sales", penawaranController.getMasterSales);
router.get(
    "/penawaran/master/batal",
    penawaranController.getMasterPenawaranBatal,
);
router.get(
    "/penawaran/master/confirm",
    penawaranController.getMasterPenawaranConfirm,
);

module.exports = router;
