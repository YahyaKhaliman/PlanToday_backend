const express = require("express");
const router = express.Router();
const penawaranController = require("../controllers/penawaranController");
const auth = require("../middleware/auth");

router.get("/penawaran", penawaranController.getPenawaranList);
router.get("/penawaran/:nomor", penawaranController.getPenawaranDetail);
router.post("/penawaran", auth, penawaranController.createPenawaran);
router.put(
    "/penawaran/:nomor/status",
    auth,
    penawaranController.updatePenawaranStatusDetail,
);
router.post(
    "/penawaran/:nomor/pengajuan-perubahan",
    auth,
    penawaranController.requestApprovalPerubahan,
);
router.get(
    "/penawaran/:nomor/activity-logs",
    penawaranController.getPenawaranActivityLogs,
);
router.get(
    "/penawaran/master/nomor",
    penawaranController.getMasterPenawaranNomor,
);
router.get(
    "/penawaran/master/permintaan-harga",
    auth,
    penawaranController.getMasterPermintaanHargaForPenawaran,
);
router.get(
    "/penawaran/master/perusahaan",
    penawaranController.getMasterPerusahaan,
);
router.get("/penawaran/master/customer", penawaranController.getMasterCustomer);
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
