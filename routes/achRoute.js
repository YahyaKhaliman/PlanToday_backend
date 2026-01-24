const express = require('express');
const router = express.Router();

const achController = require('../controllers/achController');
const auth = require('../middleware/auth');

router.get('/tes-achievement', achController.allData);

router.use('/achievement', auth);

router.get('/achievement/omset/range', achController.getAchievementRange);
router.get('/achievement/omset/month/:id', achController.getOmsetByMonth);
router.get('/achievement/omset/year/:id', achController.getOmsetByYear);
router.get('/achievement/spk-omset/month/:id', achController.getSpkOmsetByMonth);
router.get('/achievement', achController.getAchievementOmset);

module.exports = router;
