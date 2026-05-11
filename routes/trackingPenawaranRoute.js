const express = require("express");
const router = express.Router();
const trackingPenawaranController = require("../controllers/trackingPenawaranController");
const auth = require("../middleware/auth");

router.get(
    "/tracking-penawaran",
    auth,
    trackingPenawaranController.getTrackingPenawaranList,
);
router.get(
    "/tracking-penawaran/detail",
    auth,
    trackingPenawaranController.getTrackingPenawaranDetailByNoPenawaran,
);
router.get(
    "/tracking-penawaran/:noPenawaran",
    auth,
    trackingPenawaranController.getTrackingPenawaranDetailByNoPenawaran,
);

module.exports = router;
