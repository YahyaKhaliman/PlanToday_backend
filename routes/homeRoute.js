const express = require('express');
const router = express.Router();
const { uploadVisit } = require('../middleware/upload');  
const homeController = require('../controllers/homeController');

// Calon customer
router.post('/calon-customer', homeController.calonCustomer);

// Visit Plan
router.get('/cabang', homeController.getCabang);
router.post('/visit-plan', homeController.createVisitPlan);
router.get('/cari-customer', homeController.cariCustomer)

// Visit
router.post('/visits', homeController.createVisit);
router.put('/visits/:id', homeController.updateVisit);
router.post('/visits/:id/photo', (req, res, next) => {
  uploadVisit.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    next();
  });
}, homeController.uploadVisitPhoto);

// Rekap visit
router.get('/rekap-visit', homeController.getRekapVisit)
router.get('/rekap-visit/wa', homeController.rekapVisitWA)
router.put('/update-rekap-visit/:id', homeController.updateRekapVisit)

// Rekap Visit Plan
router.get('/rekap-visit-detail', homeController.visitPlanById)
router.get('/rekap-visit-plan', homeController.getRekapVisitPlan)
router.get('/rekap-visit-plan/wa', homeController.rekapVisitPlanWA)

// Rekap Calon Customer
router.get('/rekap-calon-customer', homeController.getRekapCalonCustomer)
router.get('/rekap-calon-customer/wa', homeController.rekapCalonCustomerWA)

// Ganti Password
router.post('/ganti-password', homeController.gantiPassword)

// Get Karyawan
router.get('/karyawan', homeController.getUser)
module.exports = router;