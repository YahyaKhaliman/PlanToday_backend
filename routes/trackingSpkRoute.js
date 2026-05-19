const express = require("express");
const router = express.Router();
const trackingSpkController = require("../controllers/trackingSpkController");
const auth = require("../middleware/auth");

router.get(
    "/tracking-spk",
    auth,
    trackingSpkController.getTrackingSpkList,
);

module.exports = router;
