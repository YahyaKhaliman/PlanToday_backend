const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const db = require("../config/dbPenawaran");
const { UPLOAD_DIR } = require("../middleware/uploadPermintaanHarga");
const {
    resolveSalesIdentity,
    findActiveSalesByNameNormalized,
} = require("../utils/salesIdentityResolver");
const { kalkulasiGarmenEngine } = require("../utils/kalkulasiGarmenHelper");

const nomorLocks = new Map();
const uploadDir = path.join(process.cwd(), "uploads", "mintaharga");

const toNumber = (value, fallback = 0) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
};

const toDecimalNumber = (value, fallback = 0) => {
    const normalized = String(value ?? "")
        .trim()
        .replace(/,/g, ".")
        .replace(/[^0-9.]/g, "");
    if (!normalized) return fallback;
    const firstDot = normalized.indexOf(".");
    const safe =
        firstDot === -1
            ? normalized
            : normalized.slice(0, firstDot + 1) +
              normalized.slice(firstDot + 1).replace(/\./g, "");
    const num = Number(safe);
    return Number.isFinite(num) ? num : fallback;
};

const normalizeDate = (value) => {
    if (!value) return null;
    const s = String(value).trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    return s;
};

const getCurrentMonthRange = () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const toYmd = (d) => {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd}`;
    };
    return { start: toYmd(start), end: toYmd(end) };
};

const isSalesUser = (user) =>
    String(user?.jabatan || "")
        .trim()
        .toUpperCase() === "SALES";

const isManagerUser = (user) =>
    String(user?.jabatan || "")
        .trim()
        .toUpperCase() === "MANAGER";

const isOwnedBySalesKode = (user, row = {}) => {
    const authSalesKode = String(user?.sales_kode || "").trim();
    const rowSalesKode = String(
        row?.mh_sal_kode || row?.pen_sal_kode || "",
    ).trim();
    return Boolean(authSalesKode) && rowSalesKode === authSalesKode;
};

const resolveActor = (user, body) =>
    String(user?.nama || user?.id || body?.user || "MOBILE").trim() || "MOBILE";

const withNomorLock = async (key, fn) => {
    const prev = nomorLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
        release = resolve;
    });

    nomorLocks.set(
        key,
        prev.then(() => current),
    );
    await prev;

    try {
        return await fn();
    } finally {
        release();
        if (nomorLocks.get(key) === current) {
            nomorLocks.delete(key);
        }
    }
};

const getNextNomor = async (conn, tahun) => {
    const [rows] = await conn.query(
        `
        SELECT IFNULL(MAX(RIGHT(mh_nomor,4)),0) AS jumlah
        FROM tmintaharga
        WHERE YEAR(mh_tanggal) = ?
        `,
        [tahun],
    );
    const next = toNumber(rows?.[0]?.jumlah, 0) + 1;
    return `MH.${tahun}.${String(next).padStart(4, "0")}`;
};

const normalizePublicOrigin = (origin) => {
    const raw = String(origin || "").trim();
    if (!raw) return "";

    let normalized = raw.replace(/\\+/g, "/");

    if (normalized.startsWith("//")) {
        normalized = `http:${normalized}`;
    } else if (!/^https?:\/\//i.test(normalized)) {
        normalized = `http://${normalized.replace(/^\/+/, "")}`;
    }

    return normalized.replace(/\/+$/, "");
};

const resolveImagePublicOrigin = () => {
    const envOrigin = String(
        process.env.PUBLIC_IMAGE_READ_ORIGIN ||
            process.env.PUBLIC_IMAGE_ORIGIN ||
            process.env.IMAGE_PUBLIC_ORIGIN ||
            "",
    ).trim();
    return (
        normalizePublicOrigin(envOrigin) ||
        normalizePublicOrigin("http://103.94.238.252:8182")
    );
};

const buildImageBaseUrl = () => resolveImagePublicOrigin();

const buildImagePaths = (nomor) => {
    const safeNomor = String(nomor || "").trim();
    return {
        delphi1: `/images/mintaharga/${safeNomor}.jpg`,
        delphi2: `/images/mintaharga/${safeNomor}-2.jpg`,
        legacy1: `/images/mintaharga/${safeNomor}.jpg`,
        legacy2: `/images/mintaharga/${safeNomor}-2.jpg`,
    };
};

const getExistingImageMeta = (nomor, slot) => {
    const safeNomor = String(nomor || "").trim();
    if (!safeNomor) return null;
    const fileName = slot === 2 ? `${safeNomor}-2.jpg` : `${safeNomor}.jpg`;
    const absolutePath = path.join(UPLOAD_DIR, fileName);
    if (!fs.existsSync(absolutePath)) return null;
    return { fileName, absolutePath };
};

const getYearFromTanggal = (tanggal) =>
    Number(String(tanggal || "").slice(0, 4));

const isBasicEmail = (value) => {
    const val = String(value || "").trim();
    if (val === "-") return true;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
};

const isBasicNpwp = (value) => {
    const digits = String(value || "").replace(/\D/g, "");
    return digits.length >= 15;
};

const getNextCustomerKode = async (conn) => {
    const baseSql = `
        SELECT IFNULL(MAX(CAST(cus_kode AS UNSIGNED)), 0) AS max_kode
        FROM tcustomer
        WHERE TRIM(IFNULL(cus_kode, '')) REGEXP '^[0-9]{1,5}$'
    `;

    try {
        const [rows] = await conn.query(
            `${baseSql}
             AND (
                 IFNULL(TRIM(cus_kodec), '') = ''
                 OR TRIM(cus_kodec) = '0'
             )`,
        );
        const next = toNumber(rows?.[0]?.max_kode, 0) + 1;
        return String(next).padStart(5, "0");
    } catch (err) {
        if (String(err?.code || "") !== "ER_BAD_FIELD_ERROR") throw err;
        const [fallbackRows] = await conn.query(baseSql);
        const next = toNumber(fallbackRows?.[0]?.max_kode, 0) + 1;
        return String(next).padStart(5, "0");
    }
};

const generateKalkulasiNomor = async (conn, tanggal) => {
    const d = tanggal ? new Date(tanggal) : new Date();
    const tahunStr = String(d.getFullYear()).slice(-2);
    const bulanStr = String(d.getMonth() + 1).padStart(2, "0");
    const prefix = `KALS-${tahunStr}${bulanStr}`;

    const [kalRows] = await conn.query(
        `SELECT IFNULL(MAX(CAST(RIGHT(kal_nomor, 4) AS UNSIGNED)), 0) AS max_val 
         FROM kalkulasi.tkalkulasi_hdr 
         WHERE kal_nomor LIKE ? AND LEFT(kal_nomor, 4) = 'KALS'`,
        [`%${tahunStr}${bulanStr}%`],
    );
    const [kal2Rows] = await conn.query(
        `SELECT IFNULL(MAX(CAST(RIGHT(kal_nomor, 4) AS UNSIGNED)), 0) AS max_val 
         FROM kalkulasi.tkalkulasi2_hdr 
         WHERE kal_nomor LIKE ? AND LEFT(kal_nomor, 4) = 'KALS'`,
        [`%${tahunStr}${bulanStr}%`],
    );
    const [mhRows] = await conn.query(
        `SELECT IFNULL(MAX(CAST(RIGHT(mh_nomor_kalkulasi, 4) AS UNSIGNED)), 0) AS max_val 
         FROM tmintaharga 
         WHERE mh_nomor_kalkulasi LIKE ? AND LEFT(mh_nomor_kalkulasi, 4) = 'KALS'`,
        [`%${tahunStr}${bulanStr}%`],
    );

    const maxKal = parseInt(kalRows?.[0]?.max_val || 0, 10);
    const maxKal2 = parseInt(kal2Rows?.[0]?.max_val || 0, 10);
    const maxMh = parseInt(mhRows?.[0]?.max_val || 0, 10);
    const nextVal = Math.max(maxKal, maxKal2, maxMh) + 1;
    return `${prefix}${String(nextVal).padStart(4, "0")}`;
};

const createPermintaanHargaInTransaction = async ({
    conn,
    payload,
    actor,
    nomor,
}) => {
    const divisiNum = toNumber(payload.mh_divisi, 0);
    const hargaKalkulasi = toNumber(payload.mh_harga_kalkulasi, 0);
    const hargaPengajuan = toNumber(payload.mh_harga, 0);
    let initialStatus = "MINTA";
    if (payload.mh_status) {
        initialStatus = String(payload.mh_status).trim().toUpperCase();
    } else if (hargaKalkulasi > 0) {
        if (hargaPengajuan > 0 && hargaPengajuan >= hargaKalkulasi) {
            initialStatus = "DONE";
        } else {
            initialStatus = "NEGO";
        }
    } else {
        initialStatus = "MINTA";
    }

    let salesKode = String(
        payload.auth_sales_kode || payload.mh_sal_kode || "",
    ).trim();

    if (!salesKode && actor) {
        try {
            const matchedSales = await findActiveSalesByNameNormalized(actor);
            if (matchedSales?.sales_kode) {
                salesKode = matchedSales.sales_kode;
            }
        } catch (e) {
            console.warn(
                "[PermintaanHarga][ResolveSalesInTx][Warn]",
                e.message,
            );
        }
    }

    let nomorKalkulasi = String(payload.mh_nomor_kalkulasi || "").trim();
    let dateKalkulasi = payload.mh_date_kalkulasi || null;

    if (hargaKalkulasi > 0) {
        if (!nomorKalkulasi) {
            nomorKalkulasi = await generateKalkulasiNomor(
                conn,
                payload.tanggal,
            );
        }
        dateKalkulasi = new Date();

        const ketKalkulasi = String(payload.mh_ket_kalkulasi || "").trim();
        const isIncludePpn =
            /INC\s*PPN/i.test(ketKalkulasi) ||
            payload.is_ppn === true ||
            payload.is_inc_ppn === true;

        let kalPpn = 0;
        let kalRpSesuai = hargaKalkulasi;
        let kalRpSesuaiPpn = hargaKalkulasi;

        if (isIncludePpn) {
            kalPpn = 11;
            kalRpSesuaiPpn = hargaKalkulasi;
            kalRpSesuai = Math.round(hargaKalkulasi / 1.11);
        } else {
            kalPpn = 0;
            kalRpSesuai = hargaKalkulasi;
            kalRpSesuaiPpn = Math.round(hargaKalkulasi * 1.11);
        }

        const modelKhKode = String(
            payload.garmen_model ||
                payload.kal_kh_kode ||
                (divisiNum === 4 ? "KH-0001" : ""),
        ).trim();

        let kalRpAllowance = toNumber(payload.kal_rpallowance, 0);
        let kalAllowance = toNumber(payload.kal_allowance, 0);
        let kalRpLaba = toNumber(payload.kal_rplaba, 0);
        let kalLaba = toNumber(payload.kal_laba, 0);
        let kalKetBeli = String(payload.kal_ketbeli || "").trim();

        let ktgGarmen = "COTTON";
        let hargaBahanGarmen = 0;
        let bBodyGarmen = 0;
        let bLenganGarmen = 0;
        let bRibGarmen = 70;

        if (divisiNum === 4) {
            const normKodeModel = (
                payload.garmen_model ||
                payload.kal_kh_kode ||
                modelKhKode ||
                "KH-0001"
            )
                .toUpperCase()
                .trim();
            const normJenisKain = String(
                payload.garmen_kain || payload.mh_kain || "",
            ).trim();
            const normWarna = String(payload.garmen_warna || "MUDA")
                .toUpperCase()
                .trim();
            const numQty = toNumber(payload.mh_jmlorder, 1);

            try {
                const [kRows] = await conn.query(
                    `SELECT * FROM tmintaharga_kain 
                     WHERE (mhk_kode = ? OR mhk_kode = '') 
                       AND mhk_jeniskain = ?`,
                    [normKodeModel, normJenisKain],
                );

                try {
                    const [hRows] = await conn.query(
                        `SELECT hk_hargapabrik, hk_hargatoko 
                         FROM kalkulasi.thargakain 
                         WHERE hk_jeniskain = ? AND hk_warna = ? LIMIT 1`,
                        [normJenisKain, normWarna],
                    );
                    if (hRows && hRows.length > 0) {
                        hargaBahanGarmen =
                            Number(hRows[0].hk_hargapabrik) ||
                            Number(hRows[0].hk_hargatoko) ||
                            0;
                    }
                } catch (hErr) {
                    console.warn(
                        "[PermintaanHarga][ThargakainLookup][Warn]",
                        hErr.message,
                    );
                }

                let allowancePersen = 17;
                let hargaBahanLenganGarmen = 0;

                if (kRows && kRows.length > 0) {
                    ktgGarmen = (kRows[0].mhk_ktg || "COTTON")
                        .toUpperCase()
                        .trim();
                    const isSportKtg =
                        ktgGarmen === "PE" ||
                        ktgGarmen === "HYGIT" ||
                        ktgGarmen === "DRYFIT";
                    const isLacostKtg =
                        ktgGarmen.includes("LACOST") ||
                        ktgGarmen.includes("PIQUE");

                    allowancePersen = toNumber(
                        kRows[0].mhk_allow,
                        isSportKtg ? 5 : isLacostKtg ? 20 : 17,
                    );

                    // Cocokkan baris warna terpilih
                    const matchedWarna = kRows.find(
                        (r) =>
                            (r.mhk_warna || "").toUpperCase().trim() ===
                            normWarna,
                    );
                    if (matchedWarna) {
                        hargaBahanGarmen = toNumber(matchedWarna.mhk_harga, 0);
                        if (
                            matchedWarna.mhk_allow !== undefined &&
                            matchedWarna.mhk_allow !== null
                        ) {
                            allowancePersen = toNumber(
                                matchedWarna.mhk_allow,
                                allowancePersen,
                            );
                        }
                    } else if (kRows[0]?.mhk_harga) {
                        hargaBahanGarmen = toNumber(kRows[0].mhk_harga, 0);
                    }

                    // Pada KH-0002 cari harga warna TUA untuk lengan
                    if (normKodeModel === "KH-0002") {
                        const rowTua = kRows.find(
                            (r) =>
                                (r.mhk_warna || "").toUpperCase().trim() ===
                                    "TUA" && Number(r.mhk_harga) > 0,
                        );
                        if (rowTua) {
                            hargaBahanLenganGarmen = toNumber(
                                rowTua.mhk_harga,
                                0,
                            );
                        }
                    }

                    const bodyRow = kRows.find(
                        (r) =>
                            (r.mhk_komponen || "").toUpperCase().trim() ===
                            "BODY",
                    );
                    if (bodyRow) bBodyGarmen = toNumber(bodyRow.mhk_babaran, 0);

                    const lenganRow = kRows.find(
                        (r) =>
                            (r.mhk_komponen || "").toUpperCase().trim() ===
                            "LENGAN",
                    );
                    if (lenganRow)
                        bLenganGarmen = toNumber(lenganRow.mhk_babaran, 0);

                    const ribRow = kRows.find(
                        (r) =>
                            (r.mhk_komponen || "").toUpperCase().trim() ===
                            "RIB",
                    );
                    if (ribRow) bRibGarmen = toNumber(ribRow.mhk_babaran, 70);
                }

                if (bBodyGarmen === 0) {
                    if (
                        ktgGarmen.includes("LACOST") ||
                        ktgGarmen.includes("PIQUE")
                    ) {
                        bBodyGarmen = 2.4;
                    } else if (
                        ktgGarmen === "PE" ||
                        ktgGarmen === "HYGIT" ||
                        ktgGarmen === "DRYFIT"
                    ) {
                        bBodyGarmen = 3.5;
                    } else {
                        bBodyGarmen = 2.8;
                    }
                }

                if (bBodyGarmen > 0 && hargaBahanGarmen > 0) {
                    const isSport =
                        ktgGarmen === "PE" ||
                        ktgGarmen === "HYGIT" ||
                        ktgGarmen === "DRYFIT";

                    let dbBiayaJahit = undefined;
                    try {
                        const [jRows] = await conn.query(
                            "SELECT mhb_ket, mhb_biaya FROM tmintaharga_biaya WHERE mhb_jenis = 'JAHIT'",
                        );
                        if (jRows && jRows.length > 0) {
                            let pattern = /oblong/i;
                            if (normKodeModel === "KH-0002")
                                pattern = /raglan/i;
                            else if (normKodeModel === "KH-0003")
                                pattern = /polo/i;
                            else if (normKodeModel === "KH-0004")
                                pattern = /kemeja/i;
                            else if (normKodeModel === "KH-0005")
                                pattern = /jaket/i;

                            const matchedJahit = jRows.find((r) =>
                                pattern.test(r.mhb_ket || ""),
                            );
                            if (
                                matchedJahit &&
                                Number(matchedJahit.mhb_biaya) > 0
                            ) {
                                dbBiayaJahit = Number(matchedJahit.mhb_biaya);
                            }
                        }
                    } catch (jErr) {
                        console.warn(
                            "[PermintaanHarga][AutoCalcJahitLookup][Warn]",
                            jErr.message,
                        );
                    }

                    let autoCustomTiers = undefined;
                    try {
                        const [mRows] = await conn.query(
                            "SELECT qmin, qmax, margin, model FROM tmintaharga_margin WHERE model = ? ORDER BY qmin",
                            [normKodeModel],
                        );
                        if (mRows && mRows.length > 0) {
                            autoCustomTiers = mRows.map((r) => ({
                                min: Number(r.qmin) || 0,
                                max:
                                    Number(r.qmax) >= 999999
                                        ? Infinity
                                        : Number(r.qmax),
                                persen: Number(r.margin) || 0,
                                label: `${r.qmin} - ${r.qmax}`,
                            }));
                        }
                    } catch (mErr) {
                        console.warn(
                            "[PermintaanHarga][AutoCalcMarginLookup][Warn]",
                            mErr.message,
                        );
                    }

                    const calcRes = kalkulasiGarmenEngine({
                        customTiers: autoCustomTiers,
                        kodeModel: normKodeModel,
                        hargaBahan: hargaBahanGarmen,
                        hargaBahanLengan: hargaBahanLenganGarmen,
                        bBody: bBodyGarmen,
                        bLengan: bLenganGarmen,
                        bRib: bRibGarmen,
                        allowancePersen,
                        isSport,
                        customBiayaJahit: dbBiayaJahit,
                        qty: numQty,
                        tambahanList: payload.garmen_tambahan || [],
                        cetakList: payload.garmen_cetak || [],
                    });

                    if (calcRes) {
                        kalRpAllowance =
                            calcRes.komponenBiaya?.allowanceRp || 0;
                        kalAllowance =
                            calcRes.komponenBiaya?.allowancePersen ||
                            allowancePersen;
                        kalRpLaba = calcRes.strataAktif?.marginRp || 0;
                        kalLaba = calcRes.strataAktif?.persen || 0;
                    }
                }

                if (!kalKetBeli && bBodyGarmen > 0) {
                    kalKetBeli = `${normJenisKain} ${bBodyGarmen}/kg`;
                } else if (!kalKetBeli && normJenisKain) {
                    kalKetBeli = normJenisKain;
                }
            } catch (e) {
                console.warn(
                    "[PermintaanHarga][AutoCalcGarmen][Warn]",
                    e.message,
                );
            }
        }

        try {
            // 1. Simpan Header Kalkulasi ke tkalkulasi_hdr dan tkalkulasi2_hdr
            const hdrQueries = [
                `
                INSERT INTO kalkulasi.tkalkulasi_hdr (
                    kal_nomor, kal_mh_nomor, kal_project, kal_tanggal, kal_cus, kal_kh_kode,
                    kal_order, kal_rencanaorder, kal_rpallowance, kal_allowance,
                    kal_rplaba, kal_laba, kal_persen, kal_pakaiobat, kal_ppn,
                    kal_rpsesuai, kal_rpsesuaippn, kal_ket, kal_ketbeli,
                    user_create, date_create
                ) VALUES (?, ?, ?, NOW(), ?, ?, 0, ?, ?, ?, ?, ?, 'Y', 'N', ?, ?, ?, ?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE
                    kal_mh_nomor = VALUES(kal_mh_nomor),
                    kal_project = VALUES(kal_project),
                    kal_cus = VALUES(kal_cus),
                    kal_kh_kode = VALUES(kal_kh_kode),
                    kal_rencanaorder = VALUES(kal_rencanaorder),
                    kal_rpallowance = VALUES(kal_rpallowance),
                    kal_allowance = VALUES(kal_allowance),
                    kal_rplaba = VALUES(kal_rplaba),
                    kal_laba = VALUES(kal_laba),
                    kal_ppn = VALUES(kal_ppn),
                    kal_rpsesuai = VALUES(kal_rpsesuai),
                    kal_rpsesuaippn = VALUES(kal_rpsesuaippn),
                    kal_ket = VALUES(kal_ket),
                    kal_ketbeli = VALUES(kal_ketbeli),
                    user_modified = ?,
                    date_modified = NOW()
                `,
                `
                INSERT INTO kalkulasi.tkalkulasi2_hdr (
                    kal_nomor, kal_project, kal_tanggal, kal_cus, kal_kh_kode,
                    kal_order, kal_rencanaorder, kal_rpallowance, kal_allowance,
                    kal_rplaba, kal_laba, kal_persen, kal_pakaiobat, kal_ppn,
                    kal_rpsesuai, kal_rpsesuaippn, kal_ket, kal_ketbeli,
                    user_create, date_create
                ) VALUES (?, ?, NOW(), ?, ?, 0, ?, ?, ?, ?, ?, 'Y', 'N', ?, ?, ?, ?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE
                    kal_project = VALUES(kal_project),
                    kal_cus = VALUES(kal_cus),
                    kal_kh_kode = VALUES(kal_kh_kode),
                    kal_rencanaorder = VALUES(kal_rencanaorder),
                    kal_rpallowance = VALUES(kal_rpallowance),
                    kal_allowance = VALUES(kal_allowance),
                    kal_rplaba = VALUES(kal_rplaba),
                    kal_laba = VALUES(kal_laba),
                    kal_ppn = VALUES(kal_ppn),
                    kal_rpsesuai = VALUES(kal_rpsesuai),
                    kal_rpsesuaippn = VALUES(kal_rpsesuaippn),
                    kal_ket = VALUES(kal_ket),
                    kal_ketbeli = VALUES(kal_ketbeli),
                    user_modified = ?,
                    date_modified = NOW()
                `,
            ];

            await conn.query(hdrQueries[0], [
                nomorKalkulasi,
                nomor,
                String(payload.mh_nama || "").trim(),
                String(payload.mh_cus_nama || "").trim(),
                modelKhKode,
                toNumber(payload.mh_jmlorder, 0),
                kalRpAllowance,
                kalAllowance,
                kalRpLaba,
                kalLaba,
                kalPpn,
                kalRpSesuai,
                kalRpSesuaiPpn,
                ketKalkulasi,
                kalKetBeli,
                actor,
                actor,
            ]);

            try {
                await conn.query(hdrQueries[1], [
                    nomorKalkulasi,
                    String(payload.mh_nama || "").trim(),
                    String(payload.mh_cus_nama || "").trim(),
                    modelKhKode,
                    toNumber(payload.mh_jmlorder, 0),
                    kalRpAllowance,
                    kalAllowance,
                    kalRpLaba,
                    kalLaba,
                    kalPpn,
                    kalRpSesuai,
                    kalRpSesuaiPpn,
                    ketKalkulasi,
                    kalKetBeli,
                    actor,
                    actor,
                ]);
            } catch (eHdr2) {
                console.warn(
                    "[PermintaanHarga][SaveHdr2][Warn]",
                    eHdr2.message,
                );
            }

            if (divisiNum === 4) {
                try {
                    // Bersihkan tabel kalkulasi komponen, aksesoris, dtl, dan cetak lama
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi_komponen WHERE kk_nomor = ?",
                        [nomorKalkulasi],
                    );
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi2_komponen WHERE kk_nomor = ?",
                        [nomorKalkulasi],
                    );
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi_dtl WHERE kald_nomor = ?",
                        [nomorKalkulasi],
                    );
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi2_dtl WHERE kald_nomor = ?",
                        [nomorKalkulasi],
                    );
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi_aksesories WHERE ka_nomor = ?",
                        [nomorKalkulasi],
                    );
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi2_aksesories WHERE ka_nomor = ?",
                        [nomorKalkulasi],
                    );

                    // Bersihkan tabel-tabel cetak khusus (kalkulasi & kalkulasi2)
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi_ctk WHERE kc_nomor = ?",
                        [nomorKalkulasi],
                    );
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi2_ctk WHERE kc_nomor = ?",
                        [nomorKalkulasi],
                    );
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi_cetak WHERE kald_nomor = ?",
                        [nomorKalkulasi],
                    );
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi2_cetak WHERE kald_nomor = ?",
                        [nomorKalkulasi],
                    );
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi_sublim WHERE kald_nomor = ?",
                        [nomorKalkulasi],
                    );
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi2_sublim WHERE kald_nomor = ?",
                        [nomorKalkulasi],
                    );
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi_dtf WHERE kald_nomor = ?",
                        [nomorKalkulasi],
                    );
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi2_dtf WHERE kald_nomor = ?",
                        [nomorKalkulasi],
                    );
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi_bordir WHERE kald_nomor = ?",
                        [nomorKalkulasi],
                    );
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi2_bordir WHERE kald_nomor = ?",
                        [nomorKalkulasi],
                    );

                    // Insert Biaya Konveksi ke DTL
                    const biayaKonveksi =
                        ktgGarmen === "PE" ||
                        ktgGarmen === "HYGIT" ||
                        ktgGarmen === "DRYFIT"
                            ? 2800
                            : 5610;
                    const totalOngkirVal = toNumber(
                        payload.mh_ongkir !== undefined
                            ? payload.mh_ongkir
                            : payload.kald_rpkirim,
                        0,
                    );
                    const numOrderQty = Math.max(
                        1,
                        toNumber(payload.mh_jmlorder, 1),
                    );
                    const ongkirPerPcs = Math.round(
                        totalOngkirVal / numOrderQty,
                    );

                    const dtlSql = `INSERT INTO kalkulasi.tkalkulasi_dtl (kald_nomor, kald_rppotong, kald_rpjahit, kald_rpfinishing, kald_rpkirim, kald_rpbiayaobat) VALUES (?, 0, ?, 0, ?, 0)`;
                    const dtl2Sql = `INSERT INTO kalkulasi.tkalkulasi2_dtl (kald_nomor, kald_rppotong, kald_rpjahit, kald_rpfinishing, kald_rpkirim, kald_rpbiayaobat) VALUES (?, 0, ?, 0, ?, 0)`;
                    await conn.query(dtlSql, [
                        nomorKalkulasi,
                        biayaKonveksi,
                        ongkirPerPcs,
                    ]);
                    try {
                        await conn.query(dtl2Sql, [
                            nomorKalkulasi,
                            biayaKonveksi,
                            ongkirPerPcs,
                        ]);
                    } catch (e) {}

                    // Insert Komponen Kain
                    const normJenisKain = String(
                        payload.garmen_kain || payload.mh_kain || "",
                    ).trim();
                    const normWarna = String(payload.garmen_warna || "MUDA")
                        .toUpperCase()
                        .trim();
                    const kompValues = [];
                    if (bBodyGarmen > 0 || hargaBahanGarmen > 0) {
                        const bodyPcs =
                            bBodyGarmen > 0
                                ? Math.round(
                                      (hargaBahanGarmen / bBodyGarmen / 1.11) *
                                          100,
                                  ) / 100
                                : 0;
                        kompValues.push([
                            nomorKalkulasi,
                            "BODY",
                            "Y",
                            "Y",
                            normJenisKain,
                            "",
                            normWarna,
                            hargaBahanGarmen,
                            bBodyGarmen,
                            bodyPcs,
                            0,
                            0,
                            1,
                        ]);
                    }
                    if (modelKhKode === "KH-0002" && bLenganGarmen > 0) {
                        const lenganPcs =
                            Math.round(
                                (hargaBahanGarmen / bLenganGarmen) * 100,
                            ) / 100;
                        kompValues.push([
                            nomorKalkulasi,
                            "LENGAN",
                            "Y",
                            "Y",
                            normJenisKain,
                            "",
                            normWarna,
                            hargaBahanGarmen,
                            bLenganGarmen,
                            lenganPcs,
                            0,
                            0,
                            2,
                        ]);
                    }
                    if (bRibGarmen > 0) {
                        const ribPcs =
                            Math.round(
                                ((hargaBahanGarmen / 1.11 + 1500) / 70) * 100,
                            ) / 100;
                        kompValues.push([
                            nomorKalkulasi,
                            "RIB",
                            "Y",
                            "Y",
                            "RIB",
                            "",
                            normWarna,
                            hargaBahanGarmen,
                            bRibGarmen,
                            ribPcs,
                            0,
                            0,
                            kompValues.length + 1,
                        ]);
                    }
                    if (kompValues.length > 0) {
                        const kompSql = `INSERT INTO kalkulasi.tkalkulasi_komponen (kk_nomor, kk_komponen, kk_kg, kk_pabrik, kk_jeniskain, kk_lengan, kk_warna, kk_harga, kk_babaran, kk_pcs, kald_logbody, kald_loglengan, kk_nourut) VALUES ?`;
                        const komp2Sql = `INSERT INTO kalkulasi.tkalkulasi2_komponen (kk_nomor, kk_komponen, kk_kg, kk_pabrik, kk_jeniskain, kk_lengan, kk_warna, kk_harga, kk_babaran, kk_pcs, kald_logbody, kald_loglengan, kk_nourut) VALUES ?`;
                        await conn.query(kompSql, [kompValues]);
                        try {
                            await conn.query(komp2Sql, [kompValues]);
                        } catch (e) {}
                    }

                    // Insert Aksesoris
                    let tambahanItems = payload.garmen_tambahan || [];
                    if (typeof tambahanItems === "string") {
                        try {
                            tambahanItems = JSON.parse(tambahanItems);
                        } catch (e) {
                            tambahanItems = [];
                        }
                    }
                    if (
                        Array.isArray(tambahanItems) &&
                        tambahanItems.length > 0
                    ) {
                        const aksValues = tambahanItems.map((t, idx) => [
                            nomorKalkulasi,
                            t.ket || t.nama || "",
                            Number(t.tarif) || 0,
                            idx + 1,
                        ]);
                        const aksSql = `INSERT INTO kalkulasi.tkalkulasi_aksesories (ka_nomor, ka_aksesories, ka_biaya, ka_nourut) VALUES ?`;
                        const aks2Sql = `INSERT INTO kalkulasi.tkalkulasi2_aksesories (ka_nomor, ka_aksesories, ka_biaya, ka_nourut) VALUES ?`;
                        await conn.query(aksSql, [aksValues]);
                        try {
                            await conn.query(aks2Sql, [aksValues]);
                        } catch (e) {}
                    }

                    // ==========================================
                    // PENYIMPANAN DATA CETAK / SUBLIM / DTF / BORDIR TERPISAH
                    // (Tanpa menggunakan tkalkulasi_ctk)
                    // ==========================================
                    let cetakItems = payload.garmen_cetak || [];
                    if (typeof cetakItems === "string") {
                        try {
                            cetakItems = JSON.parse(cetakItems);
                        } catch (e) {
                            cetakItems = [];
                        }
                    }
                    if (!Array.isArray(cetakItems)) {
                        cetakItems = [];
                    }
                    let totalSablon = 0;
                    let totalSublim = 0;
                    let dtfItem = null;
                    let bordirItem = null;

                    cetakItems.forEach((c) => {
                        const j = String(c.jenis || "")
                            .toUpperCase()
                            .trim();
                        const b = Number(c.biaya) || 0;
                        if (j === "SABLON") {
                            totalSablon += b;
                        } else if (j === "SUBLIM") {
                            totalSublim += b;
                        } else if (j === "DTF") {
                            let p = Number(c.panjang) || 0;
                            let l = Number(c.lebar) || 0;
                            let cm = Number(c.tarifCm) || 25;
                            if ((!p || !l) && c.ket) {
                                const m = String(c.ket).match(
                                    /(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/i,
                                );
                                if (m) {
                                    p = Number(m[1]) || 0;
                                    l = Number(m[2]) || 0;
                                }
                            }
                            if (!dtfItem) {
                                dtfItem = { cm, p, l, biaya: b };
                            } else {
                                dtfItem.biaya += b;
                            }
                        } else if (j === "BORDIR") {
                            let p = Number(c.panjang) || 0;
                            let l = Number(c.lebar) || 0;
                            let cm = Number(c.tarifCm) || 90;
                            if ((!p || !l) && c.ket) {
                                const m = String(c.ket).match(
                                    /(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/i,
                                );
                                if (m) {
                                    p = Number(m[1]) || 0;
                                    l = Number(m[2]) || 0;
                                }
                            }
                            if (!bordirItem) {
                                bordirItem = { cm, p, l, biaya: b };
                            } else {
                                bordirItem.biaya += b;
                            }
                        }
                    });

                    // 1. Simpan SABLON ke tkalkulasi_cetak & tkalkulasi2_cetak
                    if (totalSablon > 0) {
                        const ctkSql = `INSERT INTO kalkulasi.tkalkulasi_cetak (kald_nomor, kald_rpcetak) VALUES (?, ?) ON DUPLICATE KEY UPDATE kald_rpcetak = VALUES(kald_rpcetak)`;
                        const ctk2Sql = `INSERT INTO kalkulasi.tkalkulasi2_cetak (kald_nomor, kald_rpcetak) VALUES (?, ?) ON DUPLICATE KEY UPDATE kald_rpcetak = VALUES(kald_rpcetak)`;
                        await conn.query(ctkSql, [nomorKalkulasi, totalSablon]);
                        try {
                            await conn.query(ctk2Sql, [
                                nomorKalkulasi,
                                totalSablon,
                            ]);
                        } catch (e) {}
                    }

                    // 2. Simpan SUBLIM ke tkalkulasi_sublim & tkalkulasi2_sublim
                    if (totalSublim > 0) {
                        const subSql = `INSERT INTO kalkulasi.tkalkulasi_sublim (kald_nomor, kald_rpsublim) VALUES (?, ?) ON DUPLICATE KEY UPDATE kald_rpsublim = VALUES(kald_rpsublim)`;
                        const sub2Sql = `INSERT INTO kalkulasi.tkalkulasi2_sublim (kald_nomor, kald_rpsublim) VALUES (?, ?) ON DUPLICATE KEY UPDATE kald_rpsublim = VALUES(kald_rpsublim)`;
                        await conn.query(subSql, [nomorKalkulasi, totalSublim]);
                        try {
                            await conn.query(sub2Sql, [
                                nomorKalkulasi,
                                totalSublim,
                            ]);
                        } catch (e) {}
                    }

                    // 3. Simpan DTF ke tkalkulasi_dtf & tkalkulasi2_dtf
                    if (dtfItem && dtfItem.biaya > 0) {
                        const dtfSql = `
                            INSERT INTO kalkulasi.tkalkulasi_dtf (
                                kald_nomor, kald_cmdtf, kald_dtfp1, kald_dtfl1, kald_rpdtf
                            ) VALUES (?, ?, ?, ?, ?)
                            ON DUPLICATE KEY UPDATE
                                kald_cmdtf = VALUES(kald_cmdtf),
                                kald_dtfp1 = VALUES(kald_dtfp1),
                                kald_dtfl1 = VALUES(kald_dtfl1),
                                kald_rpdtf = VALUES(kald_rpdtf)
                        `;
                        const dtf2Sql = `
                            INSERT INTO kalkulasi.tkalkulasi2_dtf (
                                kald_nomor, kald_cmdtf, kald_dtfp1, kald_dtfl1, kald_rpdtf
                            ) VALUES (?, ?, ?, ?, ?)
                            ON DUPLICATE KEY UPDATE
                                kald_cmdtf = VALUES(kald_cmdtf),
                                kald_dtfp1 = VALUES(kald_dtfp1),
                                kald_dtfl1 = VALUES(kald_dtfl1),
                                kald_rpdtf = VALUES(kald_rpdtf)
                        `;
                        await conn.query(dtfSql, [
                            nomorKalkulasi,
                            dtfItem.cm,
                            dtfItem.p,
                            dtfItem.l,
                            dtfItem.biaya,
                        ]);
                        try {
                            await conn.query(dtf2Sql, [
                                nomorKalkulasi,
                                dtfItem.cm,
                                dtfItem.p,
                                dtfItem.l,
                                dtfItem.biaya,
                            ]);
                        } catch (e) {}
                    }

                    // 4. Simpan BORDIR ke tkalkulasi_bordir & tkalkulasi2_bordir
                    if (bordirItem && bordirItem.biaya > 0) {
                        const borSql = `
                            INSERT INTO kalkulasi.tkalkulasi_bordir (
                                kald_nomor, kald_cmbordir, kald_bordirp1, kald_bordirl1, kald_rpbordir
                            ) VALUES (?, ?, ?, ?, ?)
                            ON DUPLICATE KEY UPDATE
                                kald_cmbordir = VALUES(kald_cmbordir),
                                kald_bordirp1 = VALUES(kald_bordirp1),
                                kald_bordirl1 = VALUES(kald_bordirl1),
                                kald_rpbordir = VALUES(kald_rpbordir)
                        `;
                        const bor2Sql = `
                            INSERT INTO kalkulasi.tkalkulasi2_bordir (
                                kald_nomor, kald_cmbordir, kald_bordirp1, kald_bordirl1, kald_rpbordir
                            ) VALUES (?, ?, ?, ?, ?)
                            ON DUPLICATE KEY UPDATE
                                kald_cmbordir = VALUES(kald_cmbordir),
                                kald_bordirp1 = VALUES(kald_bordirp1),
                                kald_bordirl1 = VALUES(kald_bordirl1),
                                kald_rpbordir = VALUES(kald_rpbordir)
                        `;
                        await conn.query(borSql, [
                            nomorKalkulasi,
                            bordirItem.cm,
                            bordirItem.p,
                            bordirItem.l,
                            bordirItem.biaya,
                        ]);
                        try {
                            await conn.query(bor2Sql, [
                                nomorKalkulasi,
                                bordirItem.cm,
                                bordirItem.p,
                                bordirItem.l,
                                bordirItem.biaya,
                            ]);
                        } catch (e) {}
                    }
                } catch (dtlErr) {
                    console.warn(
                        "[PermintaanHarga][SaveGarmenDetails][Warn]",
                        dtlErr.message,
                    );
                }
            }
        } catch (kalHdrErr) {
            console.warn(
                "[PermintaanHarga][SaveKalkulasiHeader][Warn]",
                kalHdrErr.message,
            );
        }
    }

    const rawLebar = toDecimalNumber(payload.mh_lebar, 0);
    let finalLebar = rawLebar;
    if (divisiNum === 1 && rawLebar >= 10) {
        finalLebar = Math.round((rawLebar / 100) * 1000) / 1000;
    }

    let finalKain = String(payload.mh_kain || "").trim();
    if (divisiNum === 1) {
        if (
            !finalKain ||
            finalKain.startsWith("Vynil") ||
            finalKain.startsWith("Frontlite") ||
            finalKain.startsWith("COTTON")
        ) {
            finalKain = String(
                payload.spanduk_kain ||
                    payload.spandukJenisKain ||
                    "POLYESTER 50/36",
            ).trim();
        }
    } else if (divisiNum === 5) {
        const isSpandukOrGarmenKain = [
            "POLYESTER",
            "OPTIC",
            "TC",
            "COTTON",
            "LACOST",
            "PE",
            "HYGIT",
            "DRYFIT",
        ].some((k) => finalKain.toUpperCase().includes(k));
        if (!finalKain || isSpandukOrGarmenKain) {
            const mmtKat = String(
                payload.mmt_kategori || payload.kategori || "VYNIL",
            )
                .toUpperCase()
                .trim();
            const mmtBahan = String(
                payload.mmt_bahan_kode || payload.bahanKode || "260",
            ).trim();
            try {
                const [[mRow]] = await conn.query(
                    "SELECT mhm_nama_bahan FROM tmintaharga_mmt WHERE mhm_kategori = ? AND mhm_bahan_kode = ? LIMIT 1",
                    [mmtKat, mmtBahan],
                );
                finalKain = mRow?.mhm_nama_bahan || `${mmtKat} ${mmtBahan}`;
            } catch (e) {
                finalKain = `${mmtKat} ${mmtBahan}`;
            }
        }
    } else if (divisiNum === 4) {
        if (
            !finalKain ||
            finalKain.startsWith("Vynil") ||
            finalKain.includes("POLYESTER") ||
            finalKain.includes("OPTIC")
        ) {
            finalKain = String(
                payload.garmen_kain ||
                    payload.garmenJenisKain ||
                    "COTTON COMBED 30S",
            ).trim();
        }
    }

    let finalUkuran = String(payload.mh_ukuran || "").trim();
    if (!finalUkuran) {
        const p = toDecimalNumber(payload.mh_panjang, 0);
        if (p > 0 && finalLebar > 0) {
            finalUkuran = `${p} x ${finalLebar} m`;
        }
    }

    await conn.query(
        `
        INSERT INTO tmintaharga (
            mh_divisi, mh_nomor, mh_tanggal, mh_cus_kode, mh_cus_nama, mh_sal_kode,
            mh_nama, mh_jmlorder, mh_harga, mh_budget, mh_dateorder, mh_kain,
            mh_panjang, mh_lebar, mh_ukuran, mh_gramasi, mh_finishing, mh_sublim,
            mh_ket, mh_warna, mh_status, date_create, user_create,
            mh_harga_kalkulasi, mh_ket_kalkulasi, mh_nomor_kalkulasi, mh_date_kalkulasi
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?)
        `,
        [
            divisiNum,
            nomor,
            payload.tanggal,
            String(payload.mh_cus_kode || "").trim(),
            String(payload.mh_cus_nama || "").trim(),
            salesKode,
            String(payload.mh_nama || "").trim(),
            toNumber(payload.mh_jmlorder, 0),
            toNumber(payload.mh_harga, 0),
            toNumber(payload.mh_budget, 0),
            payload.mh_dateorder ? normalizeDate(payload.mh_dateorder) : null,
            finalKain,
            toDecimalNumber(payload.mh_panjang, 0),
            finalLebar,
            finalUkuran,
            String(payload.mh_gramasi || "").trim(),
            String(payload.mh_finishing || "").trim(),
            String(payload.mh_sublim || "").trim(),
            String(payload.mh_ket || "").trim(),
            String(
                payload.mh_warna ||
                    payload.garmen_warna ||
                    (divisiNum === 4 ? "MUDA" : ""),
            )
                .trim()
                .toUpperCase(),
            initialStatus,
            actor,
            hargaKalkulasi,
            String(payload.mh_ket_kalkulasi || "").trim(),
            nomorKalkulasi,
            dateKalkulasi,
        ],
    );
};

const cloneImageFile = async (fromNomor, toNomor, suffix = "") => {
    const src = path.join(uploadDir, `${fromNomor}${suffix}.jpg`);
    const dst = path.join(uploadDir, `${toNomor}${suffix}.jpg`);
    try {
        await fs.promises.access(src, fs.constants.F_OK);
        await fs.promises.copyFile(src, dst);
        return true;
    } catch {
        return false;
    }
};

const getPermintaanHargaList = async ({
    managerRole,
    authSalesKode,
    startDate,
    endDate,
    status,
    search,
    limit,
    offset,
}) => {
    const where = [
        "m.mh_tanggal >= ?",
        "m.mh_tanggal < DATE_ADD(?, INTERVAL 1 DAY)",
    ];
    const params = [startDate, endDate];

    if (!managerRole) {
        where.unshift("COALESCE(m.mh_sal_kode,'') = ?");
        params.unshift(authSalesKode);
    }

    if (status) {
        where.push("COALESCE(m.mh_status,'') = ?");
        params.push(status);
    }

    if (search) {
        where.push(
            "(m.mh_nomor LIKE ? OR m.mh_nama LIKE ? OR m.mh_cus_nama LIKE ?)",
        );
        const like = `%${search}%`;
        params.push(like, like, like);
    }

    params.push(limit, offset);

    const [rows] = await db.query(
        `
        SELECT
            m.mh_nomor AS nomor,
            DATE_FORMAT(m.date_create, '%Y-%m-%d') AS tanggal,
            COALESCE(m.mh_nama,'') AS nama,
            COALESCE(m.mh_cus_nama,'') AS customer,
            COALESCE(v.divisi,'') AS divisi,
            COALESCE(m.mh_jmlorder,0) AS jml_order,
            COALESCE(m.mh_harga, 0) AS mh_harga,
            COALESCE(m.mh_harga, 0) AS harga,
            COALESCE(m.mh_harga_kalkulasi,0) AS harga_kalkulasi,
            COALESCE(m.mh_status,'') AS status,
            COALESCE(m.mh_ket_kalkulasi,'') AS ket_kalkulasi,
            COALESCE(m.user_create,'') AS user_create
        FROM tmintaharga m
        LEFT JOIN tdivisi v ON v.kode = m.mh_divisi
        WHERE ${where.join(" AND ")}
        ORDER BY m.mh_nomor DESC
        LIMIT ? OFFSET ?
        `,
        params,
    );

    return rows;
};

const getPermintaanHargaDetail = async ({
    managerRole,
    authSalesKode,
    nomor,
}) => {
    const whereUserCreate = managerRole
        ? ""
        : "AND COALESCE(h.mh_sal_kode,'') = ?";
    const [rows] = await db.query(
        `
        SELECT
            h.mh_nomor,
            h.mh_divisi,
            h.mh_tanggal,
            h.mh_cus_kode,
            h.mh_cus_nama,
            h.mh_sal_kode,
            h.mh_nama,
            h.mh_jmlorder,
            h.mh_harga,
            h.mh_budget,
            DATE_FORMAT(h.mh_dateorder, '%Y-%m-%d') AS mh_dateorder,
            h.mh_kain,
            h.mh_panjang,
            h.mh_lebar,
            h.mh_ukuran,
            h.mh_gramasi,
            h.mh_finishing,
            COALESCE(h.mh_sublim, '') AS mh_sublim,
            COALESCE(h.mh_warna, '') AS mh_warna,
            h.mh_ket,
            h.mh_status,
            COALESCE(h.mh_harga_kalkulasi, 0) AS mh_harga_kalkulasi,
            COALESCE(h.mh_ket_kalkulasi, '') AS mh_ket_kalkulasi,
            COALESCE(h.mh_nomor_kalkulasi, '') AS mh_nomor_kalkulasi,
            DATE_FORMAT(h.mh_date_kalkulasi, '%Y-%m-%d %H:%i:%s') AS mh_date_kalkulasi,
            COALESCE(h.mh_apv_usr, '') AS mh_apv_usr,
            h.user_kalkulasi AS user_kalkulasi,
            h.user_create,
            COALESCE(v.divisi,'') AS divisi_nama,
            COALESCE(s.sal_nama,'') AS sales_nama,
            DATE_FORMAT(h.date_create, '%Y-%m-%d %H:%i:%s') AS created_at_fmt
        FROM tmintaharga h
        LEFT JOIN tdivisi v ON v.kode=h.mh_divisi
        LEFT JOIN tsales s ON s.sal_kode=h.mh_sal_kode
        WHERE h.mh_nomor = ?
          ${whereUserCreate}
        LIMIT 1
        `,
        managerRole ? [nomor] : [nomor, authSalesKode],
    );

    if (!rows?.length) {
        return null;
    }

    const row = rows[0];
    row.kald_rpkirim = 0;
    row.mh_ongkir = 0;
    if (row.mh_nomor_kalkulasi) {
        try {
            const [dtlRows] = await db.query(
                `SELECT kald_rpkirim FROM kalkulasi.tkalkulasi_dtl WHERE kald_nomor = ? LIMIT 1`,
                [row.mh_nomor_kalkulasi],
            );
            if (
                dtlRows?.[0]?.kald_rpkirim !== undefined &&
                dtlRows?.[0]?.kald_rpkirim !== null
            ) {
                const perPcs = Number(dtlRows[0].kald_rpkirim) || 0;
                const qty = Math.max(1, Number(row.mh_jmlorder || 1));
                row.kald_rpkirim = perPcs;
                row.mh_ongkir = Math.round(perPcs * qty);
            }
        } catch (e) {}
    }
    const baseUrl = buildImageBaseUrl();
    const imagePaths = buildImagePaths(row.mh_nomor);
    const withBase = (p) => (baseUrl ? `${baseUrl}${p}` : p);

    const existing1 = getExistingImageMeta(row.mh_nomor, 1);
    const existing2 = getExistingImageMeta(row.mh_nomor, 2);

    row.gambar_1_url = existing1 ? withBase(imagePaths.delphi1) : "";
    row.gambar_2_url = existing2 ? withBase(imagePaths.delphi2) : "";
    row.gambar_1_path = existing1 ? imagePaths.delphi1 : "";
    row.gambar_2_path = existing2 ? imagePaths.delphi2 : "";
    row.gambar_1_file = existing1 ? existing1.fileName : "";
    row.gambar_2_file = existing2 ? existing2.fileName : "";

    return row;
};

const createPermintaanHarga = async ({ body, user }) => {
    const tanggal = normalizeDate(body.mh_tanggal || new Date().toISOString());
    const actor = resolveActor(user, body);
    const tahun = getYearFromTanggal(tanggal);

    if (!tanggal) {
        return {
            status: 400,
            body: { success: false, message: "Tanggal tidak valid" },
        };
    }

    const result = await withNomorLock(`create:${tahun}`, async () => {
        let conn;
        try {
            conn = await db.getConnection();

            for (let attempt = 1; attempt <= 3; attempt += 1) {
                await conn.beginTransaction();
                const nomor = await getNextNomor(conn, tahun);
                const [exists] = await conn.query(
                    `SELECT mh_nomor FROM tmintaharga WHERE mh_nomor = ? LIMIT 1`,
                    [nomor],
                );
                if (exists?.length) {
                    await conn.rollback();
                    continue;
                }

                let resolvedSalesKode = String(
                    body.mh_sal_kode || user?.sales_kode || "",
                ).trim();

                if (!resolvedSalesKode) {
                    try {
                        const resIdentity = await resolveSalesIdentity({
                            loginUser: user,
                            explicitSalesKode: body.mh_sal_kode,
                            allowLegacyFallback: true,
                        });
                        if (resIdentity?.sales_kode) {
                            resolvedSalesKode = resIdentity.sales_kode;
                        }
                    } catch (resErr) {
                        console.warn(
                            "[PermintaanHarga][Create][ResolveSalesErr]",
                            resErr.message,
                        );
                    }
                }

                if (!resolvedSalesKode && actor) {
                    try {
                        const byName =
                            await findActiveSalesByNameNormalized(actor);
                        if (byName?.sales_kode) {
                            resolvedSalesKode = byName.sales_kode;
                        }
                    } catch (nameErr) {
                        console.warn(
                            "[PermintaanHarga][Create][FindSalesByNameErr]",
                            nameErr.message,
                        );
                    }
                }

                await createPermintaanHargaInTransaction({
                    conn,
                    payload: {
                        ...body,
                        tanggal,
                        auth_sales_kode: resolvedSalesKode,
                        auth_user_nama: user?.nama,
                    },
                    actor,
                    nomor,
                });
                await conn.commit();
                return nomor;
            }

            throw new Error(
                "Gagal membuat nomor permintaan harga yang unik, silakan coba lagi",
            );
        } finally {
            if (conn) conn.release();
        }
    });

    return {
        status: 201,
        body: { success: true, data: { nomor: result } },
    };
};

const updatePermintaanHarga = async ({ nomor, body, user }) => {
    const actor = resolveActor(user, body);

    const [rows] = await db.query(
        `SELECT mh_nomor, mh_status, mh_sal_kode, user_create FROM tmintaharga WHERE mh_nomor = ? LIMIT 1`,
        [nomor],
    );
    if (!rows?.length) {
        return {
            status: 404,
            body: { success: false, message: "Data tidak ditemukan" },
        };
    }
    if (isSalesUser(user) && !isOwnedBySalesKode(user, rows[0])) {
        return {
            status: 403,
            body: {
                success: false,
                message: "Tidak berhak mengubah data ini",
            },
        };
    }
    if (String(rows[0].mh_status || "").toUpperCase() !== "BELUM") {
        return {
            status: 409,
            body: {
                success: false,
                message: "Hanya status BELUM yang dapat diubah",
            },
        };
    }

    const updateDivisiNum = toNumber(body.mh_divisi, 0);
    const updateRawLebar = toDecimalNumber(body.mh_lebar, 0);
    let updateFinalLebar = updateRawLebar;
    if (updateDivisiNum === 1 && updateRawLebar >= 10) {
        updateFinalLebar = Math.round((updateRawLebar / 100) * 1000) / 1000;
    }

    let updateKain = String(body.mh_kain || "").trim();
    if (updateDivisiNum === 5) {
        const isSpandukOrGarmen = [
            "POLYESTER",
            "OPTIC",
            "TC",
            "COTTON",
            "LACOST",
            "PE",
        ].some((k) => updateKain.toUpperCase().includes(k));
        if (!updateKain || isSpandukOrGarmen) {
            const mmtKat = String(body.mmt_kategori || body.kategori || "VYNIL")
                .toUpperCase()
                .trim();
            const mmtBahan = String(
                body.mmt_bahan_kode || body.bahanKode || "260",
            ).trim();
            try {
                const [[mRow]] = await db.query(
                    "SELECT mhm_nama_bahan FROM tmintaharga_mmt WHERE mhm_kategori = ? AND mhm_bahan_kode = ? LIMIT 1",
                    [mmtKat, mmtBahan],
                );
                updateKain = mRow?.mhm_nama_bahan || `${mmtKat} ${mmtBahan}`;
            } catch (e) {
                updateKain = `${mmtKat} ${mmtBahan}`;
            }
        }
    }

    let updateSalesKode = String(
        body.mh_sal_kode || user?.sales_kode || "",
    ).trim();
    if (!updateSalesKode && actor) {
        try {
            const byName = await findActiveSalesByNameNormalized(actor);
            if (byName?.sales_kode) updateSalesKode = byName.sales_kode;
        } catch (e) {}
    }
    if (!updateSalesKode) {
        updateSalesKode = String(rows[0].mh_sal_kode || "").trim();
    }

    const updateOngkirTotal = toNumber(
        body.mh_ongkir !== undefined ? body.mh_ongkir : body.kald_rpkirim,
        0,
    );
    const updateOrderQty = Math.max(
        1,
        toNumber(body.mh_jmlorder || rows[0].mh_jmlorder, 1),
    );
    const updateOngkirPerPcs = Math.round(updateOngkirTotal / updateOrderQty);
    const existingNomorKal = String(
        rows[0].mh_nomor_kalkulasi || body.mh_nomor_kalkulasi || "",
    ).trim();
    if (existingNomorKal) {
        try {
            await db.query(
                `UPDATE kalkulasi.tkalkulasi_dtl SET kald_rpkirim = ? WHERE kald_nomor = ?`,
                [updateOngkirPerPcs, existingNomorKal],
            );
            await db.query(
                `UPDATE kalkulasi.tkalkulasi2_dtl SET kald_rpkirim = ? WHERE kald_nomor = ?`,
                [updateOngkirPerPcs, existingNomorKal],
            );
        } catch (dtlOngkirErr) {
            console.warn(
                "[PermintaanHarga][UpdateDtlOngkir][Warn]",
                dtlOngkirErr.message,
            );
        }
    }

    await db.query(
        `
        UPDATE tmintaharga
        SET
            mh_tanggal = ?,
            mh_divisi = ?,
            mh_cus_kode = ?,
            mh_cus_nama = ?,
            mh_sal_kode = ?,
            mh_nama = ?,
            mh_jmlorder = ?,
            mh_harga = ?,
            mh_budget = ?,
            mh_dateorder = ?,
            mh_kain = ?,
            mh_panjang = ?,
            mh_lebar = ?,
            mh_ukuran = ?,
            mh_gramasi = ?,
            mh_finishing = ?,
            mh_sublim = ?,
            mh_ket = ?,
            mh_warna = ?,
            mh_harga_kalkulasi = ?,
            mh_ket_kalkulasi = ?,
            user_modified = ?,
            date_modified = NOW()
        WHERE mh_nomor = ?
        `,
        [
            normalizeDate(body.mh_tanggal || new Date().toISOString()),
            updateDivisiNum,
            String(body.mh_cus_kode || "").trim(),
            String(body.mh_cus_nama || "").trim(),
            updateSalesKode || String(rows[0].mh_sal_kode || "").trim(),
            String(body.mh_nama || "").trim(),
            toNumber(body.mh_jmlorder, 0),
            toNumber(body.mh_harga, 0),
            toNumber(body.mh_budget, 0),
            normalizeDate(body.mh_dateorder),
            updateKain,
            toDecimalNumber(body.mh_panjang, 0),
            updateFinalLebar,
            String(body.mh_ukuran || "").trim(),
            String(body.mh_gramasi || "").trim(),
            String(body.mh_finishing || "").trim(),
            String(body.mh_sublim || "").trim(),
            String(body.mh_ket || "").trim(),
            String(
                body.mh_warna ||
                    body.garmen_warna ||
                    (updateDivisiNum === 4 ? "MUDA" : ""),
            )
                .trim()
                .toUpperCase(),
            toNumber(body.mh_harga_kalkulasi, 0),
            String(body.mh_ket_kalkulasi || "").trim(),
            actor,
            nomor,
        ],
    );

    return {
        status: 200,
        body: {
            success: true,
            message: "Permintaan harga berhasil diubah",
        },
    };
};

const copyPermintaanHarga = async ({ nomor, user, body }) => {
    const actor = resolveActor(user, body);
    const [rows] = await db.query(
        `SELECT * FROM tmintaharga WHERE mh_nomor = ? LIMIT 1`,
        [nomor],
    );
    if (!rows?.length) {
        return {
            status: 404,
            body: {
                success: false,
                message: "Data sumber copy tidak ditemukan",
            },
        };
    }

    const source = rows[0];
    if (isSalesUser(user) && !isOwnedBySalesKode(user, source)) {
        return {
            status: 403,
            body: {
                success: false,
                message: "Tidak berhak copy data ini",
            },
        };
    }

    if (
        String(source.mh_status || "")
            .trim()
            .toUpperCase() !== "BELUM"
    ) {
        return {
            status: 409,
            body: {
                success: false,
                message: "Hanya status BELUM yang dapat di-copy",
            },
        };
    }

    const tanggalBaru = normalizeDate(new Date().toISOString());
    const tahun = getYearFromTanggal(tanggalBaru);
    const nomorBaru = await withNomorLock(`copy:${tahun}`, async () => {
        let conn;
        try {
            conn = await db.getConnection();
            for (let attempt = 1; attempt <= 3; attempt += 1) {
                await conn.beginTransaction();
                const candidate = await getNextNomor(conn, tahun);
                const [exists] = await conn.query(
                    `SELECT mh_nomor FROM tmintaharga WHERE mh_nomor = ? LIMIT 1`,
                    [candidate],
                );
                if (exists?.length) {
                    await conn.rollback();
                    continue;
                }

                await createPermintaanHargaInTransaction({
                    conn,
                    payload: {
                        ...source,
                        tanggal: tanggalBaru,
                    },
                    actor,
                    nomor: candidate,
                });
                await conn.commit();
                return candidate;
            }

            throw new Error(
                "Gagal membuat nomor copy yang unik, silakan coba lagi",
            );
        } finally {
            if (conn) conn.release();
        }
    });

    const copied1 = await cloneImageFile(nomor, nomorBaru, "");
    const copied2 = await cloneImageFile(nomor, nomorBaru, "-2");
    if (!copied1 || !copied2) {
        console.warn("[PermintaanHarga][CopyImage][Partial]", {
            nomor_sumber: nomor,
            nomor_baru: nomorBaru,
            gambar_1_copied: copied1,
            gambar_2_copied: copied2,
        });
    }

    return {
        status: 201,
        body: {
            success: true,
            message: "Copy permintaan harga berhasil",
            data: {
                nomor_sumber: nomor,
                nomor_baru: nomorBaru,
                gambar_1_copied: copied1,
                gambar_2_copied: copied2,
            },
        },
    };
};

const deletePermintaanHarga = async ({ nomor, user }) => {
    const [rows] = await db.query(
        `SELECT mh_nomor, mh_status, mh_sal_kode, user_create FROM tmintaharga WHERE mh_nomor = ? LIMIT 1`,
        [nomor],
    );
    if (!rows?.length) {
        return {
            status: 404,
            body: { success: false, message: "Data tidak ditemukan" },
        };
    }
    if (isSalesUser(user) && !isOwnedBySalesKode(user, rows[0])) {
        return {
            status: 403,
            body: {
                success: false,
                message: "Tidak berhak menghapus data ini",
            },
        };
    }
    if (String(rows[0].mh_status || "").toUpperCase() !== "BELUM") {
        return {
            status: 409,
            body: {
                success: false,
                message: "Hanya status BELUM yang dapat dihapus",
            },
        };
    }

    await db.query(`DELETE FROM tmintaharga WHERE mh_nomor = ?`, [nomor]);
    return {
        status: 200,
        body: {
            success: true,
            message: "Permintaan harga berhasil dihapus",
        },
    };
};

const createPermintaanHargaCustomer = async ({ body, user }) => {
    let conn;
    try {
        const actor =
            String(body.user_create || "").trim() ||
            String(user?.nama || "").trim() ||
            resolveActor(user, body);

        const nama = String(body.nama || "").trim();
        const alamat = String(body.alamat || "").trim();
        const kota = String(body.kota || "").trim();
        const telp = String(body.cus_telp || body.telp || "").trim();
        const cp = String(body.cus_cp || body.kontak_person || "").trim();
        const email = String(body.cus_email || body.email || "").trim();
        const korporasi =
            String(body.cus_korporasi || body.korporasi || "N")
                .trim()
                .toUpperCase() === "Y"
                ? "Y"
                : "N";

        const jenisUsaha = String(
            body.cus_jenisusaha || body.jenis_usaha || "",
        ).trim();
        const npwp = String(body.cus_npwp || body.npwp || "").trim();
        const namaNpwp = String(
            body.cus_nama_npwp || body.nama_npwp || "",
        ).trim();
        const alamatNpwp = String(
            body.cus_alamat_npwp || body.alamat_npwp || "",
        ).trim();
        const kotaNpwp = String(
            body.cus_kota_npwp || body.kota_npwp || "",
        ).trim();

        if (!nama || !alamat || !kota || !telp || !cp || !email) {
            return {
                status: 400,
                body: {
                    success: false,
                    message:
                        "Nama, alamat, kota, no telp, kontak person, dan email wajib diisi",
                },
            };
        }

        if (!isBasicEmail(email)) {
            return {
                status: 400,
                body: {
                    success: false,
                    message: "Format email tidak valid",
                },
            };
        }

        if (korporasi === "Y") {
            if (!jenisUsaha || !npwp) {
                return {
                    status: 400,
                    body: {
                        success: false,
                        message:
                            "Jenis usaha dan NPWP wajib diisi untuk korporasi",
                    },
                };
            }
            if (!isBasicNpwp(npwp)) {
                return {
                    status: 400,
                    body: {
                        success: false,
                        message: "Format NPWP tidak valid",
                    },
                };
            }
        }

        const kode = await withNomorLock("customer:create", async () => {
            conn = await db.getConnection();
            try {
                for (let attempt = 1; attempt <= 3; attempt += 1) {
                    await conn.beginTransaction();
                    const candidate = await getNextCustomerKode(conn);
                    const [exists] = await conn.query(
                        `SELECT cus_kode FROM tcustomer WHERE cus_kode = ? LIMIT 1`,
                        [candidate],
                    );
                    if (exists?.length) {
                        await conn.rollback();
                        continue;
                    }

                    await conn.query(
                        `
                        INSERT INTO tcustomer (
                            cus_kode,
                            cus_nama,
                            cus_alamat,
                            cus_kota,
                            cus_telp,
                            cus_cp,
                            cus_email,
                            cus_korporasi,
                            cus_jenisusaha,
                            cus_npwp,
                            cus_nama_npwp,
                            cus_alamat_npwp,
                            cus_kota_npwp,
                            cus_aktif,
                            user_create,
                            date_create
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NOW())
                        `,
                        [
                            candidate,
                            nama,
                            alamat,
                            kota,
                            telp,
                            cp,
                            email,
                            korporasi,
                            korporasi === "Y" ? jenisUsaha : "",
                            korporasi === "Y" ? npwp : "",
                            korporasi === "Y" ? namaNpwp : "",
                            korporasi === "Y" ? alamatNpwp : "",
                            korporasi === "Y" ? kotaNpwp : "",
                            actor,
                        ],
                    );

                    await conn.commit();
                    return candidate;
                }

                throw new Error("Gagal membuat kode customer unik");
            } finally {
                if (conn) {
                    conn.release();
                    conn = null;
                }
            }
        });

        return {
            status: 201,
            body: {
                success: true,
                data: {
                    kode,
                    nama,
                },
            },
        };
    } catch (err) {
        if (conn) {
            try {
                await conn.rollback();
            } catch {}
            conn.release();
        }
        return {
            status: 500,
            body: {
                success: false,
                message:
                    err.sqlMessage ||
                    err.message ||
                    "Gagal menambahkan customer",
            },
        };
    }
};

const uploadPermintaanHargaImage = async ({ nomor, slot, file, user }) => {
    if (!["1", "2"].includes(slot)) {
        return {
            status: 400,
            body: {
                success: false,
                message: "Slot gambar hanya 1 atau 2",
            },
        };
    }
    if (!file) {
        return {
            status: 400,
            body: {
                success: false,
                message: "File gambar wajib diunggah",
            },
        };
    }

    const [rows] = await db.query(
        `SELECT mh_nomor, mh_status, mh_sal_kode, user_create FROM tmintaharga WHERE mh_nomor = ? LIMIT 1`,
        [nomor],
    );
    if (!rows?.length) {
        return {
            status: 404,
            body: { success: false, message: "Data tidak ditemukan" },
        };
    }
    if (isSalesUser(user) && !isOwnedBySalesKode(user, rows[0])) {
        return {
            status: 403,
            body: {
                success: false,
                message: "Tidak berhak upload gambar untuk data ini",
            },
        };
    }

    if (
        String(rows[0].mh_status || "")
            .trim()
            .toUpperCase() !== "BELUM"
    ) {
        return {
            status: 409,
            body: {
                success: false,
                message: "Upload gambar hanya diizinkan untuk status BELUM",
            },
        };
    }

    if (file && file.path) {
        try {
            const imgBuffer = await sharp(file.path)
                .jpeg({ quality: 90, force: true })
                .toBuffer();
            await fs.promises.writeFile(file.path, imgBuffer);
        } catch (sharpErr) {
            console.error("[PermintaanHarga][Upload][SharpError]", sharpErr);
        }
    }

    const baseUrl = buildImageBaseUrl();
    const imagePaths = buildImagePaths(nomor);
    const currentPath =
        String(slot) === "2" ? imagePaths.delphi2 : imagePaths.delphi1;
    const legacyPath =
        String(slot) === "2" ? imagePaths.legacy2 : imagePaths.legacy1;
    const withBase = (p) => (baseUrl ? `${baseUrl}${p}` : p);

    return {
        status: 200,
        body: {
            success: true,
            message: "Upload gambar berhasil",
            data: {
                nomor,
                slot,
                file: file.filename,
                url: withBase(currentPath),
                legacy_url: withBase(legacyPath),
            },
        },
    };
};

const uploadPermintaanHargaImageInternal = async ({ nomor, slot, file }) => {
    if (!nomor) {
        return {
            status: 400,
            body: {
                success: false,
                message: "Nomor wajib diisi",
            },
        };
    }

    if (!["1", "2"].includes(slot)) {
        return {
            status: 400,
            body: {
                success: false,
                message: "Slot gambar hanya 1 atau 2",
            },
        };
    }

    if (!file) {
        return {
            status: 400,
            body: {
                success: false,
                message: "File gambar wajib diunggah",
            },
        };
    }

    if (file && file.path) {
        try {
            const imgBuffer = await sharp(file.path)
                .jpeg({ quality: 90, force: true })
                .toBuffer();
            await fs.promises.writeFile(file.path, imgBuffer);
        } catch (sharpErr) {
            console.error(
                "[PermintaanHarga][Upload][Internal][SharpError]",
                sharpErr,
            );
        }
    }

    const baseUrl = buildImageBaseUrl();
    const imagePaths = buildImagePaths(nomor);
    const currentPath =
        String(slot) === "2" ? imagePaths.delphi2 : imagePaths.delphi1;
    const legacyPath =
        String(slot) === "2" ? imagePaths.legacy2 : imagePaths.legacy1;
    const withBase = (p) => (baseUrl ? `${baseUrl}${p}` : p);

    return {
        status: 200,
        body: {
            success: true,
            message: "Upload internal berhasil",
            data: {
                nomor,
                slot,
                file: file.filename,
                destination: file.destination,
                path: file.path,
                url: withBase(currentPath),
                legacy_url: withBase(legacyPath),
            },
        },
    };
};

const uploadPermintaanHargaImageBase64 = async ({
    nomor,
    slot,
    dataUrl,
    user,
}) => {
    if (!["1", "2"].includes(slot)) {
        return {
            status: 400,
            body: {
                success: false,
                message: "Slot gambar hanya 1 atau 2",
            },
        };
    }

    const [rows] = await db.query(
        `SELECT mh_nomor, mh_status, mh_sal_kode, user_create FROM tmintaharga WHERE mh_nomor = ? LIMIT 1`,
        [nomor],
    );
    if (!rows?.length) {
        return {
            status: 404,
            body: { success: false, message: "Data tidak ditemukan" },
        };
    }
    if (isSalesUser(user) && !isOwnedBySalesKode(user, rows[0])) {
        return {
            status: 403,
            body: {
                success: false,
                message: "Tidak berhak upload gambar untuk data ini",
            },
        };
    }

    if (
        String(rows[0].mh_status || "")
            .trim()
            .toUpperCase() !== "BELUM"
    ) {
        return {
            status: 409,
            body: {
                success: false,
                message: "Upload gambar hanya diizinkan untuk status BELUM",
            },
        };
    }

    if (!dataUrl) {
        return {
            status: 400,
            body: {
                success: false,
                message: "Payload file_base64 wajib diisi",
            },
        };
    }

    const matched = dataUrl.match(
        /^data:(image\/(jpeg|jpg|png));base64,(.+)$/i,
    );
    if (!matched) {
        return {
            status: 400,
            body: {
                success: false,
                message: "Format base64 tidak valid",
            },
        };
    }

    const mimeType = String(matched[1] || "image/jpeg").toLowerCase();
    const ext = "jpg";
    const b64 = String(matched[3] || "");
    let buffer = Buffer.from(b64, "base64");
    if (!buffer.length) {
        return {
            status: 400,
            body: {
                success: false,
                message: "Konten gambar kosong",
            },
        };
    }

    const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB
    if (buffer.length > MAX_FILE_SIZE) {
        return {
            status: 400,
            body: {
                success: false,
                message: `Ukuran gambar melebihi batas maksimal 1MB (ukuran file: ${(buffer.length / (1024 * 1024)).toFixed(2)} MB)`,
            },
        };
    }

    try {
        buffer = await sharp(buffer)
            .jpeg({ quality: 90, force: true })
            .toBuffer();
    } catch (sharpErr) {
        console.error(
            "[PermintaanHarga][Upload][Base64][SharpError]",
            sharpErr,
        );
    }

    const safeNomor = String(nomor || "")
        .trim()
        .replace(/[^A-Z0-9.\-_/]/gi, "_");
    const suffix = slot === "2" ? "-2" : "";
    const fileName = `${safeNomor}${suffix}.${ext}`;
    const targetPath = path.join(UPLOAD_DIR, fileName);

    await fs.promises.writeFile(targetPath, buffer);

    const baseUrl = buildImageBaseUrl();
    const imagePaths = buildImagePaths(nomor);
    const currentPath =
        String(slot) === "2" ? imagePaths.delphi2 : imagePaths.delphi1;
    const legacyPath =
        String(slot) === "2" ? imagePaths.legacy2 : imagePaths.legacy1;
    const withBase = (p) => (baseUrl ? `${baseUrl}${p}` : p);

    return {
        status: 200,
        body: {
            success: true,
            message: "Upload base64 berhasil",
            data: {
                nomor,
                slot,
                file: fileName,
                path: targetPath,
                url: withBase(currentPath),
                legacy_url: withBase(legacyPath),
            },
        },
    };
};

const deletePermintaanHargaImage = async ({ nomor, slot, user }) => {
    if (!["1", "2"].includes(slot)) {
        return {
            status: 400,
            body: {
                success: false,
                message: "Slot gambar hanya 1 atau 2",
            },
        };
    }

    const [rows] = await db.query(
        `SELECT mh_nomor, mh_status, mh_sal_kode, user_create FROM tmintaharga WHERE mh_nomor = ? LIMIT 1`,
        [nomor],
    );
    if (!rows?.length) {
        return {
            status: 404,
            body: { success: false, message: "Data tidak ditemukan" },
        };
    }
    if (isSalesUser(user) && !isOwnedBySalesKode(user, rows[0])) {
        return {
            status: 403,
            body: {
                success: false,
                message: "Tidak berhak menghapus gambar data ini",
            },
        };
    }
    if (
        String(rows[0].mh_status || "")
            .trim()
            .toUpperCase() !== "BELUM"
    ) {
        return {
            status: 409,
            body: {
                success: false,
                message: "Hapus gambar hanya diizinkan untuk status BELUM",
            },
        };
    }

    const fileName = slot === "2" ? `${nomor}-2.jpg` : `${nomor}.jpg`;
    const targetPath = path.join(UPLOAD_DIR, fileName);

    if (fs.existsSync(targetPath)) {
        await fs.promises.unlink(targetPath);
        return {
            status: 200,
            body: {
                success: true,
                message: "Gambar berhasil dihapus dari server",
            },
        };
    } else {
        return {
            status: 200,
            body: {
                success: true,
                message:
                    "File gambar tidak ditemukan di server, namun data telah di-sinkronisasi",
            },
        };
    }
};

const getPermintaanHargaStatusCounts = async ({
    managerRole,
    authSalesKode,
    startDate,
    endDate,
}) => {
    let query = `
        SELECT 
            COALESCE(mh_status, '') AS status,
            COUNT(*) AS jumlah
        FROM tmintaharga
        WHERE mh_tanggal >= ?
          AND mh_tanggal < DATE_ADD(?, INTERVAL 1 DAY)
    `;
    const params = [startDate, endDate];

    if (!managerRole) {
        query += " AND COALESCE(mh_sal_kode, '') = ?";
        params.push(authSalesKode);
    }

    query += " GROUP BY mh_status";

    const [rows] = await db.query(query, params);

    const statusMap = {
        BELUM: 0,
        MINTA: 0,
        WAIT: 0,
        NEGO: 0,
        DONE: 0,
        CANCEL: 0,
    };

    for (const row of rows || []) {
        const statusKey = String(row?.status || "")
            .trim()
            .toUpperCase();
        if (statusKey in statusMap) {
            statusMap[statusKey] = toNumber(row?.jumlah, 0);
        }
    }

    return statusMap;
};

const getKalkulasiOptions = async () => {
    const [spandukBahan] = await db.query(
        `SELECT DISTINCT 
            mhsp_metode AS metode, 
            mhsp_lebar AS lebar, 
            mhsp_jenis_kain AS jenis_kain 
         FROM tmintaharga_spanduk 
         ORDER BY mhsp_metode, mhsp_lebar, mhsp_jenis_kain`,
    );

    const [mmtBahan] = await db.query(
        `SELECT DISTINCT 
            mhm_kategori AS kategori, 
            mhm_bahan_kode AS bahan_kode, 
            mhm_nama_bahan AS nama_bahan, 
            mhm_resolusi_tipe AS resolusi_tipe 
         FROM tmintaharga_mmt 
         WHERE mhm_is_netto = 0 
         ORDER BY mhm_kategori, mhm_bahan_kode`,
    );

    const [toppingBanner] = await db.query(
        `SELECT 
            mhmt_kode AS kode, 
            mhmt_nama AS nama, 
            mhmt_kategori AS kategori, 
            mhmt_ukuran AS ukuran, 
            mhmt_material AS material, 
            mhmt_harga AS harga 
         FROM tmintaharga_mmt_tambahan 
         WHERE mhmt_aktif = 1 
         ORDER BY mhmt_id`,
    );

    const [garmenKain] = await db.query(
        `SELECT 
            mhk_kode AS kode,
            mhk_ktg AS ktg,
            mhk_jeniskain AS jenis_kain,
            mhk_lengan AS lengan,
            mhk_komponen AS komponen,
            mhk_babaran AS babaran,
            mhk_warna AS warna,
            mhk_harga AS harga,
            mhk_allow AS allow
         FROM tmintaharga_kain
         ORDER BY mhk_kode, mhk_ktg, mhk_jeniskain, mhk_warna`,
    );

    const [garmenTambahan] = await db.query(
        `SELECT 
            mht_ket AS ket,
            mht_lacost AS harga_lacost,
            mht_cotton AS harga_cotton,
            mht_pe AS harga_pe
         FROM tmintaharga_tambahan
         ORDER BY mht_ket`,
    );

    return {
        spanduk: spandukBahan,
        mmt: mmtBahan,
        topping: toppingBanner,
        garmenKain,
        garmenTambahan,
    };
};

const calculateSpanduk = async ({
    metode = "MANUAL",
    lebar = 90,
    jenisKain = "POLYESTER 50/36",
    panjang = 0,
    qty = 0,
}) => {
    const numPanjang = toNumber(panjang, 0);
    const numQty = toNumber(qty, 0);
    const normMetode = (metode || "MANUAL").toUpperCase().trim();

    if (normMetode === "MANUAL" && numQty < 100) {
        throw new Error(
            "Cetak Spanduk Manual minimal pemesanan 100 pcs. Silakan gunakan metode Cetak Machine untuk pesanan di bawah 100 pcs.",
        );
    }

    const totalMeter = Math.round(numPanjang * numQty * 100) / 100;

    const [allStrata] = await db.query(
        `SELECT 
            mhsp_id AS id, 
            mhsp_qmin AS qmin, 
            mhsp_qmax AS qmax, 
            mhsp_harga AS harga 
         FROM tmintaharga_spanduk 
         WHERE mhsp_metode = ? AND mhsp_lebar = ? AND mhsp_jenis_kain = ? 
         ORDER BY mhsp_qmin`,
        [normMetode, toNumber(lebar, 90), jenisKain],
    );

    let matched = allStrata.find(
        (s) => totalMeter >= s.qmin && totalMeter <= s.qmax,
    );
    if (!matched && allStrata.length > 0) {
        if (totalMeter < allStrata[0].qmin) {
            matched = allStrata[0];
        } else {
            matched = allStrata[allStrata.length - 1];
        }
    }

    const tarifPerMeter = matched ? matched.harga : 0;
    const hargaSatuanPcs = Math.round(numPanjang * tarifPerMeter);
    const totalHarga = Math.round(totalMeter * tarifPerMeter);

    return {
        totalMeter,
        tarifPerMeter,
        hargaSatuanPcs,
        totalHarga,
        strataAktif: matched || null,
        tabelReferensi: allStrata,
    };
};

const calculateMmt = async ({
    kategori = "VYNIL",
    bahanKode = "260",
    panjang = 0,
    lebar = 0,
    qty = 0,
    toppingKode = "",
    toppingQty = 0,
    isNetto = false,
}) => {
    const numPanjang = toNumber(panjang, 0);
    const numLebar = toNumber(lebar, 0);
    const numQty = toNumber(qty, 0);

    const luasPerPcs = Math.round(numPanjang * numLebar * 100) / 100;
    const totalLuas = Math.round(luasPerPcs * numQty * 100) / 100;

    const [allStrata] = await db.query(
        `SELECT 
            mhm_id AS id, 
            mhm_nama_bahan AS nama_bahan, 
            mhm_qmin AS qmin, 
            mhm_qmax AS qmax, 
            mhm_harga AS harga, 
            mhm_is_netto AS is_netto 
         FROM tmintaharga_mmt 
         WHERE mhm_kategori = ? AND mhm_bahan_kode = ? 
         ORDER BY mhm_is_netto, mhm_qmin`,
        [kategori, String(bahanKode)],
    );

    const normalStrata = allStrata.filter((s) => s.is_netto === 0);
    const nettoStrata = allStrata.find((s) => s.is_netto === 1);

    let matched = null;
    if (Boolean(isNetto) && nettoStrata) {
        matched = nettoStrata;
    } else {
        matched = normalStrata.find(
            (s) => totalLuas >= s.qmin && totalLuas <= s.qmax,
        );
        if (!matched && normalStrata.length > 0) {
            if (totalLuas < normalStrata[0].qmin) {
                matched = normalStrata[0];
            } else {
                matched = normalStrata[normalStrata.length - 1];
            }
        }
    }

    const tarifPerM2 = matched ? matched.harga : 0;
    const biayaCetak = Math.round(totalLuas * tarifPerM2);

    let toppingData = null;
    let totalTopping = 0;

    if (toppingKode) {
        const [[topRow]] = await db.query(
            `SELECT 
                mhmt_kode AS kode, 
                mhmt_nama AS nama, 
                mhmt_harga AS harga, 
                mhmt_material AS material, 
                mhmt_ukuran AS ukuran 
             FROM tmintaharga_mmt_tambahan 
             WHERE mhmt_kode = ? LIMIT 1`,
            [toppingKode],
        );
        if (topRow) {
            const hargaSatuanTopping = toNumber(topRow.harga, 0);
            totalTopping = Math.round(
                hargaSatuanTopping * (numQty > 0 ? numQty : 1),
            );
            toppingData = {
                kode: topRow.kode,
                nama: topRow.nama,
                material: topRow.material,
                ukuran: topRow.ukuran,
                hargaSatuan: hargaSatuanTopping,
                qty: numQty > 0 ? numQty : 1,
                totalHarga: totalTopping,
            };
        }
    }

    const totalHarga = biayaCetak + totalTopping;
    const hargaSatuanPcs = numQty > 0 ? Math.round(totalHarga / numQty) : 0;

    return {
        luasPerPcs,
        totalLuas,
        tarifPerM2,
        biayaCetak,
        topping: toppingData,
        totalHarga,
        hargaSatuanPcs,
        strataAktif: matched || null,
        tabelReferensi: allStrata,
    };
};

const calculateGarmen = async ({
    kodeModel = "KH-0001",
    jenisKain = "COMBED 30S",
    warna = "MUDA",
    qty = 100,
    tambahanList = [],
    cetakList = [],
    customAllowance,
    customBiayaJahit,
}) => {
    const numQty = toNumber(qty, 1);
    const normKodeModel = (kodeModel || "KH-0001").toUpperCase().trim();
    const normJenisKain = (jenisKain || "").trim();
    const normWarna = (warna || "MUDA").toUpperCase().trim();

    const [kainRows] = await db.query(
        `SELECT * FROM tmintaharga_kain 
         WHERE (mhk_kode = ? OR mhk_kode = '') 
           AND mhk_jeniskain = ?`,
        [normKodeModel, normJenisKain],
    );

    let ktg = "COTTON";
    let hargaBahan = 0;
    let allowancePersen = 17;
    let bBody = 0;
    let bLengan = 0;
    let bRib = 70;

    if (kainRows.length > 0) {
        ktg = (kainRows[0].mhk_ktg || "COTTON").toUpperCase().trim();
        allowancePersen = toNumber(
            kainRows[0].mhk_allow,
            ktg === "PE" || ktg === "HYGIT" || ktg === "DRYFIT" ? 5 : 17,
        );

        // Kumpulkan babaran (BODY, LENGAN, RIB) dari seluruh baris model & jenis kain ini
        kainRows.forEach((r) => {
            const komp = (r.mhk_komponen || "").toUpperCase().trim();
            const val = Number(r.mhk_babaran) || 0;
            if (komp === "BODY" && val > 0) bBody = val;
            else if (komp === "LENGAN" && val > 0) bLengan = val;
            else if (komp === "RIB" && val >= 10) bRib = val;
            else if (val > 0 && bBody === 0) bBody = val;
        });

        // Ambil harga bahan & allowance yang spesifik sesuai pilihan warna
        const matchedWarna = kainRows.find(
            (r) => (r.mhk_warna || "").toUpperCase().trim() === normWarna,
        );
        if (matchedWarna) {
            hargaBahan = toNumber(matchedWarna.mhk_harga, 0);
            if (
                matchedWarna.mhk_allow !== undefined &&
                matchedWarna.mhk_allow !== null
            ) {
                allowancePersen = toNumber(
                    matchedWarna.mhk_allow,
                    allowancePersen,
                );
            }
        } else {
            hargaBahan = toNumber(kainRows[0].mhk_harga, 0);
        }

        // Pada KH-0002 cari harga kain warna TUA untuk lengan
        var hargaBahanLengan = 0;
        if (normKodeModel === "KH-0002") {
            const rowTua = kainRows.find(
                (r) =>
                    (r.mhk_warna || "").toUpperCase().trim() === "TUA" &&
                    Number(r.mhk_harga) > 0,
            );
            hargaBahanLengan = rowTua
                ? toNumber(rowTua.mhk_harga, 0)
                : hargaBahan;
        }
    }

    if (bBody === 0) {
        const [anyKain] = await db.query(
            `SELECT mhk_komponen, mhk_babaran FROM tmintaharga_kain 
             WHERE mhk_jeniskain = ? AND mhk_babaran > 0`,
            [normJenisKain],
        );
        anyKain.forEach((r) => {
            const komp = (r.mhk_komponen || "").toUpperCase().trim();
            const val = Number(r.mhk_babaran) || 0;
            if (komp === "BODY" && val > 0) bBody = val;
            else if (komp === "LENGAN" && val > 0 && bLengan === 0)
                bLengan = val;
            else if (komp === "RIB" && val > 0) bRib = val;
        });
    }

    let resolvedTambahan = [];
    if (Array.isArray(tambahanList) && tambahanList.length > 0) {
        const [allTambahan] = await db.query(
            "SELECT * FROM tmintaharga_tambahan",
        );
        tambahanList.forEach((tItem) => {
            const ketName =
                typeof tItem === "string"
                    ? tItem
                    : tItem?.ket || tItem?.nama || "";
            const matchedTam = allTambahan.find(
                (at) =>
                    at.mht_ket.trim().toUpperCase() ===
                    ketName.trim().toUpperCase(),
            );
            if (matchedTam) {
                let tarifTambahan = 0;
                const ktgUpper = (ktg || "").toUpperCase().trim();
                const jkUpper = (normJenisKain || "").toUpperCase().trim();
                const isLacost =
                    ktgUpper.includes("LACOST") ||
                    jkUpper.includes("LACOST") ||
                    jkUpper.includes("PIQUE");
                const isPe =
                    ktgUpper.includes("PE") ||
                    ktgUpper.includes("HYGIT") ||
                    ktgUpper.includes("DRYFIT") ||
                    jkUpper.includes("PE ") ||
                    jkUpper.includes("HYGIT") ||
                    jkUpper.includes("DRYFIT");

                if (
                    isLacost &&
                    matchedTam.mht_lacost !== undefined &&
                    matchedTam.mht_lacost !== null
                )
                    tarifTambahan = toNumber(matchedTam.mht_lacost, 0);
                else if (
                    isPe &&
                    matchedTam.mht_pe !== undefined &&
                    matchedTam.mht_pe !== null
                )
                    tarifTambahan = toNumber(matchedTam.mht_pe, 0);
                else tarifTambahan = toNumber(matchedTam.mht_cotton, 0);

                resolvedTambahan.push({
                    ket: matchedTam.mht_ket,
                    tarif: tarifTambahan,
                });
            } else if (
                typeof tItem === "object" &&
                tItem?.tarif !== undefined
            ) {
                resolvedTambahan.push({
                    ket: tItem.ket || tItem.nama || "",
                    tarif: Number(tItem.tarif) || 0,
                });
            }
        });
    }

    let resolvedCetak = [];
    if (Array.isArray(cetakList) && cetakList.length > 0) {
        const [allCetak] = await db.query(
            `SELECT 
                mhb_jenis, 
                COALESCE(NULLIF(mhb_ket, ''), mhb_jenis) AS mhb_ket, 
                COALESCE(mhb_biaya, 0) AS mhb_biaya,
                COALESCE(mhb_min, 0) AS mhb_min,
                COALESCE(mhb_cm, 0) AS mhb_cm
            FROM tmintaharga_biaya 
            WHERE mhb_jenis IN ('SABLON', 'SUBLIM', 'DTF', 'BORDIR')`,
        );
        cetakList.forEach((cItem) => {
            const jenisName = (cItem?.jenis || "").trim().toUpperCase();
            const ketName = (cItem?.ket || "").trim().toUpperCase();
            const matchedCetak = allCetak.find(
                (ac) =>
                    ac.mhb_jenis.trim().toUpperCase() === jenisName &&
                    ac.mhb_ket.trim().toUpperCase() === ketName,
            );
            if (matchedCetak) {
                const itemBiaya =
                    Number(cItem?.biaya) > 0
                        ? Number(cItem.biaya)
                        : Number(matchedCetak.mhb_biaya) || 0;
                resolvedCetak.push({
                    jenis: matchedCetak.mhb_jenis,
                    ket: matchedCetak.mhb_ket,
                    biaya: itemBiaya,
                });
            } else if (cItem) {
                resolvedCetak.push({
                    jenis: cItem.jenis || "CETAK",
                    ket: cItem.ket || "",
                    biaya: Number(cItem.biaya) || 0,
                });
            }
        });
    }

    const isSport = ktg === "PE" || ktg === "HYGIT" || ktg === "DRYFIT";

    const [marginRows] = await db.query(
        `SELECT qmin, qmax, margin, persen, model 
         FROM tmintaharga_margin 
         WHERE model = ? 
         ORDER BY qmin`,
        [normKodeModel],
    );
    let customTiers = null;
    if (marginRows && marginRows.length > 0) {
        customTiers = marginRows.map((r, idx) => {
            const qmin = Number(r.qmin) || 0;
            const qmax = Number(r.qmax) || 999999;
            const persen = Number(r.margin) || 0;
            const label =
                qmax >= 999999 ? `≥ ${qmin} PCS` : `${qmin} - ${qmax} PCS`;
            return {
                tier: idx + 1,
                label,
                qmin,
                qmax,
                persen,
            };
        });
    }

    // Ambil master biaya jahit konveksi dari DB jika tidak ditentukan
    let dbBiayaJahit = null;
    if (customBiayaJahit === undefined || customBiayaJahit === null) {
        try {
            const [jahitRows] = await db.query(
                "SELECT mhb_ket, mhb_biaya FROM tmintaharga_biaya WHERE mhb_jenis = 'JAHIT'",
            );
            if (jahitRows && jahitRows.length > 0) {
                const rowJahit = jahitRows.find((j) => {
                    const ket = (j.mhb_ket || "").trim().toUpperCase();
                    return isSport
                        ? ket === "PE" ||
                              ket === "HYGIT" ||
                              ket === "DRYFIT" ||
                              ket === "SPORT"
                        : ket === "-" || ket === "";
                });
                if (rowJahit) {
                    dbBiayaJahit = Number(rowJahit.mhb_biaya) || 0;
                }
            }
        } catch (jErr) {
            console.warn(
                "[PermintaanHarga][BiayaJahitLookup][Warn]",
                jErr.message,
            );
        }
    }

    const calcResult = kalkulasiGarmenEngine({
        customTiers,
        kodeModel: normKodeModel,
        hargaBahan,
        hargaBahanLengan:
            typeof hargaBahanLengan !== "undefined" ? hargaBahanLengan : 0,
        bBody,
        bLengan,
        bRib,
        allowancePersen,
        customAllowance,
        isSport,
        customBiayaJahit:
            customBiayaJahit !== undefined && customBiayaJahit !== null
                ? customBiayaJahit
                : dbBiayaJahit,
        qty: numQty,
        tambahanList: resolvedTambahan,
        cetakList: resolvedCetak,
    });

    return {
        kodeModel: normKodeModel,
        jenisKain: normJenisKain,
        warna: normWarna,
        kategori: ktg,
        qty: numQty,
        hargaBahanKg: hargaBahan,
        babaran: {
            body: bBody,
            lengan: bLengan,
            rib: bRib,
        },
        ...calcResult,
        biayaKain: calcResult.komponenBiaya?.totalBahan || 0,
        biayaBody: calcResult.komponenBiaya?.hargaBody || 0,
        biayaLengan: calcResult.komponenBiaya?.hargaLengan || 0,
        biayaRib: calcResult.komponenBiaya?.hargaRib || 0,
        biayaJahit: calcResult.komponenBiaya?.biayaKonveksi || 0,
        biayaTambahan: calcResult.tambahan?.totalPerPcs || 0,
        biayaCetak: calcResult.cetak?.totalPerPcs || 0,
        hargaModal: calcResult.hpp || 0,
        marginPersen: calcResult.strataAktif?.persen
            ? calcResult.strataAktif.persen / 100
            : 0,
        hargaJual: calcResult.hargaUpPerPcs || calcResult.hargaJualPerPcs || 0,
        hargaJualRevisi:
            calcResult.hargaUpPerPcs || calcResult.hargaJualPerPcs || 0,
        tanggaMargin: (calcResult.tabelReferensi || []).map((t) => ({
            minOrder: t.qmin,
            maxOrder: t.qmax,
            marginPercent: t.persen,
            hargaJual: t.up || t.jual,
            label: t.label,
        })),
    };
};

const getJenisKainMintaHarga = async (kode = "KH-0001") => {
    const [rows] = await db.query(
        `SELECT DISTINCT 
            mhk_jeniskain AS mhk_kain,
            mhk_jeniskain AS Jeniskain,
            mhk_jeniskain AS nama,
            mhk_ktg AS mhk_ktg,
            mhk_ktg AS Kategori
         FROM tmintaharga_kain 
         WHERE mhk_kode = ? 
         ORDER BY mhk_jeniskain`,
        [kode],
    );
    return rows;
};

const getTambahanOptions = async ({
    jenisKain = "",
    kategori = "",
    kodeModel = "KH-0001",
} = {}) => {
    let resolvedKtg = (kategori || "").toUpperCase().trim();
    const normJenisKain = (jenisKain || "").trim();

    if (!resolvedKtg && normJenisKain) {
        const [kainRows] = await db.query(
            `SELECT mhk_ktg FROM tmintaharga_kain 
             WHERE mhk_jeniskain = ? 
             LIMIT 1`,
            [normJenisKain],
        );
        if (kainRows.length > 0 && kainRows[0].mhk_ktg) {
            resolvedKtg = kainRows[0].mhk_ktg.toUpperCase().trim();
        }
    }

    const jkUpper = normJenisKain.toUpperCase();
    const isLacost =
        resolvedKtg.includes("LACOST") ||
        jkUpper.includes("LACOST") ||
        jkUpper.includes("PIQUE");
    const isPe =
        resolvedKtg.includes("PE") ||
        resolvedKtg.includes("HYGIT") ||
        resolvedKtg.includes("DRYFIT") ||
        jkUpper.includes("PE ") ||
        jkUpper.includes("HYGIT") ||
        jkUpper.includes("DRYFIT");

    const [rows] = await db.query(
        `SELECT 
            mht_ket,
            mht_ket AS mht_keterangan,
            mht_ket AS ket,
            mht_ket AS nama,
            mht_lacost,
            mht_cotton,
            mht_pe 
         FROM tmintaharga_tambahan 
         ORDER BY mht_ket`,
    );

    return rows.map((r) => {
        let tarif = toNumber(r.mht_cotton, 0);
        let selectedCategory = "COTTON";

        if (isLacost && r.mht_lacost !== undefined && r.mht_lacost !== null) {
            tarif = toNumber(r.mht_lacost, 0);
            selectedCategory = "LACOSTE";
        } else if (isPe && r.mht_pe !== undefined && r.mht_pe !== null) {
            tarif = toNumber(r.mht_pe, 0);
            selectedCategory = "PE";
        }

        return {
            ...r,
            tarif: tarif,
            biaya: tarif,
            kategori_terpilih: selectedCategory,
        };
    });
};

const getCetakOptions = async () => {
    const [rows] = await db.query(
        `SELECT 
            mhb_jenis,
            mhb_jenis AS jenis,
            COALESCE(NULLIF(mhb_ket, ''), mhb_jenis) AS mhb_ket,
            COALESCE(NULLIF(mhb_ket, ''), mhb_jenis) AS ket,
            COALESCE(NULLIF(mhb_ket, ''), mhb_jenis) AS nama,
            COALESCE(NULLIF(mhb_ket, ''), mhb_jenis) AS keterangan,
            COALESCE(mhb_biaya, 0) AS mhb_biaya,
            COALESCE(mhb_biaya, 0) AS biaya,
            COALESCE(mhb_min, 0) AS mhb_min,
            COALESCE(mhb_cm, 0) AS mhb_cm
        FROM tmintaharga_biaya 
        WHERE mhb_jenis IN ('SABLON', 'SUBLIM', 'DTF', 'BORDIR') 
        ORDER BY 
            CASE 
                WHEN mhb_jenis = 'SABLON' THEN 1
                WHEN mhb_jenis = 'SUBLIM' THEN 2
                WHEN mhb_jenis = 'DTF' THEN 3
                WHEN mhb_jenis = 'BORDIR' THEN 4
                ELSE 5 
            END,
            mhb_ket`,
    );
    return rows;
};

const getCustomerSoHistory = async (options = {}) => {
    const cusKode = typeof options === "string" ? options : options.cusKode;
    const {
        divisi = "SEMUA",
        q = "",
        page = 1,
        limit = 20,
    } = typeof options === "object" ? options : {};

    const normCusKode = String(cusKode || "").trim();
    if (!normCusKode) {
        return {
            data: [],
            pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
        };
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    const where = ["so.so_cus_kode = ?", "COALESCE(so.so_aktif, 'Y') = 'Y'"];
    const params = [normCusKode];

    const normDivisi = String(divisi || "SEMUA")
        .trim()
        .toUpperCase();
    if (normDivisi && normDivisi !== "SEMUA" && normDivisi !== "ALL") {
        if (/^\d+$/.test(normDivisi)) {
            where.push("so.so_divisi = ?");
            params.push(parseInt(normDivisi, 10));
        } else if (normDivisi === "SPANDUK") {
            where.push("so.so_divisi = 1");
        } else if (normDivisi === "GARMEN") {
            where.push("so.so_divisi = 4");
        } else if (normDivisi === "MMT") {
            where.push("so.so_divisi = 5");
        } else {
            where.push("v.divisi LIKE ?");
            params.push(`%${normDivisi}%`);
        }
    }

    const normQ = String(q || "").trim();
    if (normQ) {
        where.push(
            "(so.so_nama LIKE ? OR so.so_nama2 LIKE ? OR so.so_nomor LIKE ? OR so.so_kain LIKE ? OR so.so_finishing LIKE ? OR so.so_ukuran LIKE ?)",
        );
        params.push(
            `%${normQ}%`,
            `%${normQ}%`,
            `%${normQ}%`,
            `%${normQ}%`,
            `%${normQ}%`,
            `%${normQ}%`,
        );
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const [cntRows] = await db.query(
        `SELECT COUNT(*) AS total
         FROM tsalesorder so
         LEFT JOIN tdivisi v ON v.kode = so.so_divisi
         ${whereSql}`,
        params,
    );
    const total = parseInt(cntRows?.[0]?.total || 0, 10);

    const [rows] = await db.query(
        `SELECT 
            so.so_nomor,
            DATE_FORMAT(so.so_tanggal, '%Y-%m-%d') AS so_tanggal,
            DATE_FORMAT(so.so_tanggal, '%d/%m/%Y') AS so_tanggal_fmt,
            COALESCE(so.so_nama, '') AS so_nama,
            COALESCE(so.so_nama2, '') AS so_nama2,
            COALESCE(so.so_jumlah, 0) AS so_jumlah,
            COALESCE(so.so_harga, 0) AS so_harga,
            COALESCE(so.so_ukuran, '') AS so_ukuran,
            COALESCE(so.so_kain, '') AS so_kain,
            COALESCE(so.so_finishing, '') AS so_finishing,
            COALESCE(so.so_panjang, 0) AS so_panjang,
            COALESCE(so.so_lebar, 0) AS so_lebar,
            COALESCE(so.so_gramasi, '') AS so_gramasi,
            COALESCE(so.so_keterangan, '') AS so_keterangan,
            COALESCE(so.so_divisi, 0) AS so_divisi,
            COALESCE(v.divisi, '') AS divisi_nama
        FROM tsalesorder so
        LEFT JOIN tdivisi v ON v.kode = so.so_divisi
        ${whereSql}
        ORDER BY so.so_tanggal DESC, so.so_nomor DESC
        LIMIT ? OFFSET ?`,
        [...params, limitNum, offset],
    );

    return {
        data: rows || [],
        pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            totalPages: Math.ceil(total / limitNum),
        },
    };
};

module.exports = {
    isSalesUser,
    isManagerUser,
    isOwnedBySalesKode,
    resolveActor,
    normalizeDate,
    getCurrentMonthRange,
    getPermintaanHargaList,
    getPermintaanHargaDetail,
    createPermintaanHarga,
    updatePermintaanHarga,
    copyPermintaanHarga,
    deletePermintaanHarga,
    createPermintaanHargaCustomer,
    uploadPermintaanHargaImage,
    uploadPermintaanHargaImageInternal,
    uploadPermintaanHargaImageBase64,
    deletePermintaanHargaImage,
    getPermintaanHargaStatusCounts,
    getKalkulasiOptions,
    calculateSpanduk,
    calculateMmt,
    calculateGarmen,
    getJenisKainMintaHarga,
    getTambahanOptions,
    getCetakOptions,
    getCustomerSoHistory,
};
