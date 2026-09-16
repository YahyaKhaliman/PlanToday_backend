import { describe, it, expect } from "vitest";
const {
    tentukanTierMargin,
    hitungKomponenBahan,
    hitungBiayaKonveksi,
    bulatkanHargaUp,
    kalkulasiGarmenEngine,
} = require("../utils/kalkulasiGarmenHelper");

describe("Unit Test: Logika Kalkulasi Garmen PlanToday (Murni / Tanpa DB)", () => {
    describe("1. Pengujian Tangga Tier Margin Kuantitas (Selaras tmintaharga_margin)", () => {
        it("harus memilih Tier 1 (20%) untuk pesanan kecil di bawah 100 pcs", () => {
            const tier = tentukanTierMargin(50);
            expect(tier.tier).toBe(1);
            expect(tier.persen).toBe(20);
        });

        it("harus memilih Tier 1 (20%) untuk rentang 100 - 249 pcs", () => {
            const tier = tentukanTierMargin(150);
            expect(tier.tier).toBe(1);
            expect(tier.persen).toBe(20);
        });

        it("harus memilih Tier 2 (15%) untuk rentang 250 - 499 pcs", () => {
            const tier = tentukanTierMargin(300);
            expect(tier.tier).toBe(2);
            expect(tier.persen).toBe(15);
        });

        it("harus memilih Tier 3 (10%) untuk rentang 500 - 749 pcs", () => {
            const tier = tentukanTierMargin(600);
            expect(tier.tier).toBe(3);
            expect(tier.persen).toBe(10);
        });

        it("harus memilih Tier 4 (7.5%) untuk rentang 750 - 999 pcs", () => {
            const tier = tentukanTierMargin(850);
            expect(tier.tier).toBe(4);
            expect(tier.persen).toBe(7.5);
        });

        it("harus memilih Tier 5 (2%) untuk pesanan besar >= 1000 pcs", () => {
            const tier = tentukanTierMargin(1500);
            expect(tier.tier).toBe(5);
            expect(tier.persen).toBe(2);
        });
    });

    describe("2. Pengujian Pembulatan Harga UP (Kelipatan 1000 ke Atas)", () => {
        it("harus membulatkan ke atas jika ada kelebihan rupiah", () => {
            expect(bulatkanHargaUp(45100)).toBe(46000);
            expect(bulatkanHargaUp(45001)).toBe(46000);
            expect(bulatkanHargaUp(45999)).toBe(46000);
        });

        it("harus tetap sama jika sudah pas kelipatan 1000", () => {
            expect(bulatkanHargaUp(45000)).toBe(45000);
            expect(bulatkanHargaUp(50000)).toBe(50000);
        });
    });

    describe("3. Pengujian Biaya Konveksi (Jahit) (Selaras tmintaharga_biaya)", () => {
        it("harus menggunakan tarif standar Rp 5.000 untuk katun/lacost", () => {
            const biaya = hitungBiayaKonveksi({ isSport: false });
            expect(biaya).toBe(5000);
        });

        it("harus menggunakan tarif sport Rp 2.000 untuk bahan jersey/sport", () => {
            const biaya = hitungBiayaKonveksi({ isSport: true });
            expect(biaya).toBe(2000);
        });

        it("harus mendukung custom biaya jahit jika ditentukan", () => {
            const biaya = hitungBiayaKonveksi({
                isSport: false,
                customBiayaJahit: 6500,
            });
            expect(biaya).toBe(6500);
        });
    });

    describe("4. Pengujian Komponen Bahan & Model (KH-0001 vs KH-0002)", () => {
        it("Kaos Oblong (KH-0001) tidak boleh memperhitungkan biaya lengan terpisah", () => {
            const bahan = hitungKomponenBahan({
                kodeModel: "KH-0001",
                hargaBahan: 130000,
                bBody: 4.2,
                bLengan: 7,
                bRib: 70,
                allowancePersen: 17,
            });

            expect(bahan.hargaBody).toBe(27885);
            expect(bahan.hargaLengan).toBe(0); // Kaos oblong lengan menyatu di body
            expect(bahan.hargaRib).toBe(1695);
            expect(bahan.allowancePersen).toBe(17);
            expect(bahan.totalBahan).toBeGreaterThan(bahan.totalHargaBahan);
        });

        it("Kaos 2 Warna (KH-0002) harus menghitung biaya lengan terpisah dari DPP Tua", () => {
            const bahan = hitungKomponenBahan({
                kodeModel: "KH-0002",
                hargaBahan: 115000,
                hargaBahanLengan: 125000,
                bBody: 6.5,
                bLengan: 23,
                bRib: 70,
                allowancePersen: 17,
            });

            expect(bahan.hargaBody).toBe(15939);
            expect(bahan.hargaLengan).toBe(4896); // (125000 / 1.11) / 23
            expect(bahan.hargaRib).toBe(1501);
            expect(bahan.totalHargaBahan).toBe(22336);
            expect(bahan.allowanceRp).toBe(3797);
            expect(bahan.totalBahan).toBe(26133);
        });
    });

    describe("5. Pengujian Engine Kalkulasi End-to-End Tanpa DB", () => {
        it("harus menghasilkan HPP, Margin, dan Harga UP dengan tepat", () => {
            const res = kalkulasiGarmenEngine({
                kodeModel: "KH-0001",
                hargaBahan: 130000,
                bBody: 4.2,
                bLengan: 0,
                bRib: 70,
                allowancePersen: 17,
                isSport: false,
                qty: 150,
                totalTambahanPerPcsManual: 12000, // Sablon
            });

            expect(res.hpp).toBe(39609); // 34609 + 5000
            expect(res.strataAktif.tier).toBe(1);
            expect(res.strataAktif.persen).toBe(20);
            expect(res.strataAktif.marginRp).toBe(7922);
            expect(res.hargaJualPerPcs).toBe(48000 + 12000);
            expect(res.hargaUpPerPcs).toBe(res.hargaJualPerPcs);
            expect(res.totalHargaOrder).toBe(res.hargaJualPerPcs * 150);
            expect(res.tabelReferensi).toHaveLength(5);
            expect(res.tabelReferensi[0].up).toBe(48000);
        });

        it("harus menghitung biaya tambahan dan cetak secara akurat", () => {
            const res = kalkulasiGarmenEngine({
                kodeModel: "KH-0001",
                hargaBahan: 130000,
                bBody: 4.2,
                bLengan: 0,
                bRib: 70,
                allowancePersen: 17,
                isSport: false,
                qty: 100, // Rencana order 100 pcs
                tambahanList: [
                    { ket: "KRAH BIASA", tarif: 5000 },
                ],
                cetakList: [
                    { jenis: "CETAK", ket: "SABLON A3", biaya: 10000 },
                ],
            });

            expect(res.tambahan.totalOrder).toBe(500000);
            expect(res.tambahan.totalPerPcs).toBe(5000);
            expect(res.cetak.totalOrder).toBe(1000000);
            expect(res.cetak.totalPerPcs).toBe(10000);
            // Total = Harga Bahan UP (48.000) + tambahan (5.000) + cetak (10.000) = 63.000
            expect(res.hargaJualPerPcs).toBe(
                res.strataAktif.hargaBahanUp + 15000,
            );
            expect(res.hargaJualPerPcs).toBe(63000);
        });
    });
});
