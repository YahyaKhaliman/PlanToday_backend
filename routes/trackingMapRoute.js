const express = require("express");
const router = express.Router();
const trackingMapController = require("../controllers/trackingMapController");
const auth = require("../middleware/auth");

router.get("/tracking-map", auth, trackingMapController.getTrackingMapList);

module.exports = router;
