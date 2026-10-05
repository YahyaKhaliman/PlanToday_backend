import { describe, it, expect } from "vitest";
const svc = require("../services/permintaanHargaService");

describe("Kalkulasi Spanduk Engine dengan Finishing Master", () => {
    it("1. Pengujian Kalkulasi Dasar Spanduk tanpa Finishing", async () => {
        const res = await svc.calculateSpanduk({
            metode: "MANUAL",
            lebar: 90,
            jenisKain: "POLYESTER 50/36",
            panjang: 3,
            qty: 100,
            finishingIds: [],
        });

        expect(res).toBeDefined();
        expect(res.totalMeter).toBe(300);
        expect(res.tarifPerMeter).toBeGreaterThan(0);
        expect(res.biayaCetakPerPcs).toBe(res.tarifPerMeter * 3);
        expect(res.finishing.items.length).toBe(0);
        expect(res.finishing.biayaPerPcs).toBe(0);
        expect(res.hargaSatuanPcs).toBe(res.biayaCetakPerPcs);
    });

    it("2. Pengujian Kalkulasi Spanduk dengan Finishing (Potong, Jahit Keliling, Selongsong)", async () => {
        const res = await svc.calculateSpanduk({
            metode: "MANUAL",
            lebar: 90,
            jenisKain: "POLYESTER 50/36",
            panjang: 3,
            qty: 100,
            finishingIds: [1, 2, 3],
        });

        expect(res).toBeDefined();
        expect(res.finishing.items.length).toBe(3);

        // Potong (500/m * 3m = 1.500)
        const potong = res.finishing.items.find(i => i.id === 1);
        expect(potong).toBeDefined();
        expect(potong.biayaPerPcs).toBe(1500);

        // Jahit Keliling (250 * 2 * (3 + 0.9) = 250 * 7.8 = 1.950)
        const jahit = res.finishing.items.find(i => i.id === 2);
        expect(jahit).toBeDefined();
        expect(jahit.biayaPerPcs).toBe(1950);

        // Selongsong (350/m * 3m = 1.050)
        const selongsong = res.finishing.items.find(i => i.id === 3);
        expect(selongsong).toBeDefined();
        expect(selongsong.biayaPerPcs).toBe(1050);

        // Total Finishing per pcs: 1.500 + 1.950 + 1.050 = 4.500
        expect(res.finishing.biayaPerPcs).toBe(4500);
        expect(res.finishing.totalBiaya).toBe(4500 * 100);

        // Total Harga per pcs = biayaCetak + 4.500
        expect(res.hargaSatuanPcs).toBe(res.biayaCetakPerPcs + 4500);
        expect(res.totalHarga).toBe(res.totalBiayaCetak + res.finishing.totalBiaya);
    });

    it("3. Pengujian Master Options Menyertakan spandukTambahan", async () => {
        const opts = await svc.getKalkulasiOptions();
        expect(opts.spandukTambahan).toBeDefined();
        expect(Array.isArray(opts.spandukTambahan)).toBe(true);
        expect(opts.spandukTambahan.length).toBeGreaterThanOrEqual(3);
    });
});
