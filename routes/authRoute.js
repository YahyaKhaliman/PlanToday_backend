const express = require("express");
const router = express.Router();

const authController = require("../controllers/authController");

router.post("/login", authController.login);
router.post("/register", authController.register);
router.post("/check-device", authController.checkDevice);
router.get("/profile", ...authController.profile);

module.exports = router;
