/**
 * Helper Logika Murni Kalkulasi Harga Garmen (Pure Functions)
 * Selaras 100% dengan Setting Harga Bahan Garmen Manksi Web & DB tmintaharga_margin, tmintaharga_biaya.
 */

const DEFAULT_TIERS_KH0001 = [
    { tier: 1, label: "100 - 249 PCS", qmin: 100, qmax: 249, persen: 20 },
    { tier: 2, label: "250 - 499 PCS", qmin: 250, qmax: 499, persen: 15 },
    { tier: 3, label: "500 - 749 PCS", qmin: 500, qmax: 749, persen: 10 },
    { tier: 4, label: "750 - 999 PCS", qmin: 750, qmax: 999, persen: 7.5 },
    { tier: 5, label: "≥ 1000 PCS", qmin: 1000, qmax: 999999, persen: 2 },
];

const DEFAULT_TIERS_KH0002 = [
    { tier: 1, label: "100 - 299 PCS", qmin: 100, qmax: 299, persen: 20 },
    { tier: 2, label: "300 - 499 PCS", qmin: 300, qmax: 499, persen: 15 },
    { tier: 3, label: "500 - 749 PCS", qmin: 500, qmax: 749, persen: 10 },
    { tier: 4, label: "750 - 999 PCS", qmin: 750, qmax: 999, persen: 7.5 },
    { tier: 5, label: "≥ 1000 PCS", qmin: 1000, qmax: 999999, persen: 2 },
];

const TIERS_MARGIN = DEFAULT_TIERS_KH0001;

/**
 * Mengambil daftar tier margin berdasarkan kode model dan data custom jika ada
 */
function getTiersMargin(kodeModel = "KH-0001", customTiers = null) {
    if (Array.isArray(customTiers) && customTiers.length > 0) {
        return customTiers;
    }
    return String(kodeModel).toUpperCase() === "KH-0002"
        ? DEFAULT_TIERS_KH0002
        : DEFAULT_TIERS_KH0001;
}

/**
 * Menentukan tangga tier margin berdasarkan kuantitas order
 */
function tentukanTierMargin(qty, tiers = DEFAULT_TIERS_KH0001) {
    const numQty = Number(qty) || 0;
    const list =
        Array.isArray(tiers) && tiers.length > 0 ? tiers : DEFAULT_TIERS_KH0001;
    let matched = list.find((t) => numQty >= t.qmin && numQty <= t.qmax);
    if (!matched) {
        if (numQty < list[0].qmin) {
            matched = list[0]; // Qty < batas bawah memakai tier 1 (20%)
        } else {
            matched = list[list.length - 1];
        }
    }
    return matched;
}

/**
 * Menghitung rincian biaya bahan kain per pcs (Body, Lengan, Rib, Allowance)
 * Selaras 100% dengan formula Manksi Web:
 * - hargaBody = Math.round(hargaBahan / bBody / 1.11)
 * - hargaRib  = Math.round((hargaBahan / 1.11 + 1500) / 70)
 * - hargaLengan (KH-0002) = Math.round((hargaBahanLengan / 1.11) / bLengan)
 * - totalHargaBahan = hargaBody + hargaLengan + hargaRib
 * - allowanceRp = Math.round(totalHargaBahan * (allowancePersen / 100))
 * - totalBahan = totalHargaBahan + allowanceRp
 */
function hitungKomponenBahan({
    kodeModel = "KH-0001",
    hargaBahan = 0,
    hargaBahanLengan,
    bBody = 0,
    bLengan = 0,
    bRib = 70,
    allowancePersen = 17,
    customAllowance,
}) {
    const normModel = String(kodeModel).toUpperCase();
    const finalAllowance =
        customAllowance !== undefined
            ? Number(customAllowance)
            : Number(allowancePersen);

    const hargaBody = bBody > 0 ? Math.round(Number(hargaBahan) / Number(bBody) / 1.11) : 0;

    let hargaLengan = 0;
    if (normModel === "KH-0002" && Number(bLengan) > 0) {
        // Pada KH-0002 komponen lengan menggunakan harga kain warna TUA (DPP dibagi 1.11)
        const hrgLenganSrc =
            hargaBahanLengan !== undefined && Number(hargaBahanLengan) > 0
                ? Number(hargaBahanLengan)
                : Number(hargaBahan);
        const dppLengan = hrgLenganSrc / 1.11;
        hargaLengan = Math.round(dppLengan / Number(bLengan));
    }

    const pembagiRib = Number(bRib) >= 10 ? Number(bRib) : 70;
    const hargaRib = Math.round((Number(hargaBahan) / 1.11 + 1500) / pembagiRib);

    const totalHargaBahan = hargaBody + hargaLengan + hargaRib;
    const allowanceRp = Math.round(totalHargaBahan * (finalAllowance / 100));
    const totalBahan = totalHargaBahan + allowanceRp;

    return {
        hargaBody,
        hargaLengan,
        hargaRib,
        totalHargaBahan,
        allowancePersen: finalAllowance,
        allowanceRp,
        totalBahan,
    };
}

/**
 * Menghitung biaya konveksi (ongkos jahit)
 * Master DB tmintaharga_biaya WHERE mhb_jenis = 'JAHIT':
 * - Standard / Cotton / Lacost: 5000
 * - Sport / PE / Hygit / Dryfit: 2000
 */
function hitungBiayaKonveksi({ isSport = false, customBiayaJahit }) {
    if (customBiayaJahit !== undefined && customBiayaJahit !== null) {
        return Number(customBiayaJahit);
    }
    return isSport ? 2000 : 5000;
}

/**
 * Membulatkan harga ke ribuan terdekat ke atas (Harga UP)
 */
function bulatkanHargaUp(harga) {
    return Math.ceil(Number(harga) / 1000) * 1000;
}

/**
 * Engine kalkulasi garmen lengkap selaras Manksi
 */
function kalkulasiGarmenEngine({
    kodeModel = "KH-0001",
    hargaBahan = 0,
    hargaBahanLengan,
    bBody = 0,
    bLengan = 0,
    bRib = 70,
    allowancePersen = 17,
    customAllowance,
    isSport = false,
    customBiayaJahit,
    qty = 1,
    tambahanList = [],
    cetakList = [],
    totalTambahanPerPcsManual = 0,
    customTiers = null,
}) {
    const normModel = String(kodeModel).toUpperCase();
    const numQty = Number(qty) > 0 ? Number(qty) : 1;
    const tiersList = getTiersMargin(normModel, customTiers);

    const bahan = hitungKomponenBahan({
        kodeModel: normModel,
        hargaBahan,
        hargaBahanLengan,
        bBody,
        bLengan,
        bRib,
        allowancePersen,
        customAllowance,
    });

    const biayaKonveksi = hitungBiayaKonveksi({ isSport, customBiayaJahit });
    const hpp = bahan.totalBahan + biayaKonveksi;

    // 1. Tambahan: tarif patokan per pcs x kuantitas rencana order
    let totalBiayaTambahanOrder = 0;
    let totalTambahanPerPcs = 0;
    const processedTambahan = (tambahanList || []).map((t) => {
        const tarif = Number(t.tarif) || 0;
        const subtotal = tarif * numQty;
        totalBiayaTambahanOrder += subtotal;
        totalTambahanPerPcs += tarif;
        return {
            ket: t.ket || t.nama || "",
            tarif,
            qty: numQty,
            subtotal,
        };
    });
    const tambahanPerPcs =
        totalTambahanPerPcs > 0
            ? totalTambahanPerPcs
            : Number(totalTambahanPerPcsManual) || 0;

    // 2. Cetak: tarif patokan per pcs x kuantitas rencana order
    let totalBiayaCetakOrder = 0;
    let totalCetakPerPcs = 0;
    const processedCetak = (cetakList || []).map((c) => {
        const biaya = Number(c.biaya) || 0;
        const subtotal = biaya * numQty;
        totalBiayaCetakOrder += subtotal;
        totalCetakPerPcs += biaya;
        return {
            jenis: c.jenis || "",
            ket: c.ket || "",
            biaya,
            qty: numQty,
            subtotal,
        };
    });
    const cetakPerPcs = totalCetakPerPcs;

    const matchedTier = tentukanTierMargin(numQty, tiersList);
    const marginRp = Math.round(hpp * (matchedTier.persen / 100));
    const hargaBahanDasar = hpp + marginRp;
    const hargaBahanUp = bulatkanHargaUp(hargaBahanDasar);

    // Total Kalkulasi = Harga Bahan (UP dari master bahan) + Tambahan/pcs + Cetak/pcs
    const totalTambahanDanCetakPerPcs = tambahanPerPcs + cetakPerPcs;
    const hargaJualPerPcs = hargaBahanUp + totalTambahanDanCetakPerPcs;
    const hargaUpPerPcs = hargaJualPerPcs;
    const totalHargaOrder = Math.round(hargaJualPerPcs * numQty);

    const tabelReferensi = tiersList.map((t) => {
        const m = Math.round(hpp * (t.persen / 100));
        const j = Math.round(hpp + m);
        const u = bulatkanHargaUp(j);
        return {
            tier: t.tier,
            label: t.label,
            qmin: t.qmin,
            qmax: t.qmax,
            persen: t.persen,
            margin: m,
            jual: j,
            up: u,
        };
    });

    return {
        komponenBiaya: {
            ...bahan,
            biayaKonveksi,
        },
        hpp,
        tambahan: {
            items: processedTambahan,
            totalPerPcs: tambahanPerPcs,
            totalOrder: totalBiayaTambahanOrder,
        },
        cetak: {
            items: processedCetak,
            totalPerPcs: cetakPerPcs,
            totalOrder: totalBiayaCetakOrder,
        },
        strataAktif: {
            tier: matchedTier.tier,
            label: matchedTier.label,
            persen: matchedTier.persen,
            marginRp,
            hargaBahanUp,
        },
        hargaJualPerPcs,
        hargaUpPerPcs,
        totalHargaOrder,
        tabelReferensi,
    };
}

module.exports = {
    DEFAULT_TIERS_KH0001,
    DEFAULT_TIERS_KH0002,
    TIERS_MARGIN,
    getTiersMargin,
    tentukanTierMargin,
    hitungKomponenBahan,
    hitungBiayaKonveksi,
    bulatkanHargaUp,
    kalkulasiGarmenEngine,
};
