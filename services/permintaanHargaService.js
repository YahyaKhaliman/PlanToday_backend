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
    const [mhRows] = await conn.query(
        `SELECT IFNULL(MAX(CAST(RIGHT(mh_nomor_kalkulasi, 4) AS UNSIGNED)), 0) AS max_val 
         FROM tmintaharga 
         WHERE mh_nomor_kalkulasi LIKE ? AND LEFT(mh_nomor_kalkulasi, 4) = 'KALS'`,
        [`%${tahunStr}${bulanStr}%`],
    );

    const maxKal = parseInt(kalRows?.[0]?.max_val || 0, 10);
    const maxMh = parseInt(mhRows?.[0]?.max_val || 0, 10);
    const nextVal = Math.max(maxKal, maxMh) + 1;
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
                        const isPartaiBesarJahit = numQty >= 1000;
                        const colPartaiBesar =
                            normKodeModel === "KH-0002"
                                ? "mhb_biaya_partaibesar_kh0002"
                                : "mhb_biaya_partaibesar_kh0001";
                        const [jRows] = await conn.query(
                            `SELECT mhb_ket, mhb_biaya, 
                                    COALESCE(${colPartaiBesar}, 0) AS mhb_biaya_partaibesar 
                             FROM tmintaharga_biaya 
                             WHERE mhb_jenis = 'JAHIT'`,
                        );
                        if (jRows && jRows.length > 0) {
                            const ktgUpper = (ktgGarmen || "").toUpperCase().trim();
                            const matchedJahit =
                                jRows.find((r) => {
                                    const ket = (r.mhb_ket || "").trim().toUpperCase();
                                    if (isSport) {
                                        return (
                                            ket === ktgUpper ||
                                            ket === "PE" ||
                                            ket === "HYGIT" ||
                                            ket === "DRYFIT"
                                        );
                                    }
                                    if (ktgUpper.includes("LACOST")) return ket === "LACOST";
                                    if (ktgUpper.includes("COTTON")) return ket === "COTTON" || ket === "-";
                                    return ket === "-" || ket === "";
                                }) ||
                                jRows.find((r) => (r.mhb_ket || "").trim() === "-") ||
                                jRows[0];

                            if (matchedJahit) {
                                const biayaNormal = Number(matchedJahit.mhb_biaya) || 0;
                                const biayaBesar = Number(matchedJahit.mhb_biaya_partaibesar) || 0;
                                dbBiayaJahit =
                                    isPartaiBesarJahit && biayaBesar > 0
                                        ? biayaBesar
                                        : biayaNormal;
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
                        let marginKtg = "COTTON";
                        const ktgUpper = String(ktgGarmen || "").toUpperCase().trim();
                        if (
                            ktgUpper.includes("PE") ||
                            ktgUpper.includes("HYGIT") ||
                            ktgUpper.includes("DRYFIT")
                        ) {
                            marginKtg = "PE";
                        } else if (
                            ktgUpper.includes("LACOST") ||
                            ktgUpper.includes("PIQUE")
                        ) {
                            marginKtg = "LACOST";
                        }

                        let mRows;
                        try {
                            const [rows] = await conn.query(
                                "SELECT qmin, qmax, margin, model, ktg FROM tmintaharga_margin WHERE model = ? AND (ktg = ? OR ktg IS NULL) ORDER BY qmin",
                                [normKodeModel, marginKtg],
                            );
                            mRows = rows;
                            if (!mRows || mRows.length === 0) {
                                const [fallbackRows] = await conn.query(
                                    "SELECT qmin, qmax, margin, model, ktg FROM tmintaharga_margin WHERE model = ? ORDER BY qmin",
                                    [normKodeModel],
                                );
                                mRows = fallbackRows;
                            }
                        } catch (errKtg) {
                            const [fallbackRows] = await conn.query(
                                "SELECT qmin, qmax, margin, model FROM tmintaharga_margin WHERE model = ? ORDER BY qmin",
                                [normKodeModel],
                            );
                            mRows = fallbackRows;
                        }

                        if (mRows && mRows.length > 0) {
                            const seenQ = new Set();
                            const uniqueMRows = [];
                            for (const r of mRows) {
                                const qminVal = Number(r.qmin) || 0;
                                if (!seenQ.has(qminVal)) {
                                    seenQ.add(qminVal);
                                    uniqueMRows.push(r);
                                }
                            }
                            autoCustomTiers = uniqueMRows.map((r, idx) => ({
                                tier: idx + 1,
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
            // 1. Simpan Header Kalkulasi ke tkalkulasi_hdr
            const hdrSql = `
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
            `;

            await conn.query(hdrSql, [
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

            if (divisiNum === 4) {
                try {
                    // Bersihkan tabel kalkulasi komponen, aksesoris, dtl, dan cetak lama
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi_komponen WHERE kk_nomor = ?",
                        [nomorKalkulasi],
                    );
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi_dtl WHERE kald_nomor = ?",
                        [nomorKalkulasi],
                    );
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi_aksesories WHERE ka_nomor = ?",
                        [nomorKalkulasi],
                    );

                    // Bersihkan tabel-tabel cetak khusus kalkulasi
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi_ctk WHERE kc_nomor = ?",
                        [nomorKalkulasi],
                    );
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi_cetak WHERE kald_nomor = ?",
                        [nomorKalkulasi],
                    );
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi_sublim WHERE kald_nomor = ?",
                        [nomorKalkulasi],
                    );
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi_dtf WHERE kald_nomor = ?",
                        [nomorKalkulasi],
                    );
                    await conn.query(
                        "DELETE FROM kalkulasi.tkalkulasi_bordir WHERE kald_nomor = ?",
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
                    await conn.query(dtlSql, [
                        nomorKalkulasi,
                        biayaKonveksi,
                        ongkirPerPcs,
                    ]);

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
                        await conn.query(kompSql, [kompValues]);
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
                        await conn.query(aksSql, [aksValues]);
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

                    // 1. Simpan SABLON ke tkalkulasi_cetak
                    if (totalSablon > 0) {
                        const ctkSql = `INSERT INTO kalkulasi.tkalkulasi_cetak (kald_nomor, kald_rpcetak) VALUES (?, ?) ON DUPLICATE KEY UPDATE kald_rpcetak = VALUES(kald_rpcetak)`;
                        await conn.query(ctkSql, [nomorKalkulasi, totalSablon]);
                    }

                    // 2. Simpan SUBLIM ke tkalkulasi_sublim
                    if (totalSublim > 0) {
                        const subSql = `INSERT INTO kalkulasi.tkalkulasi_sublim (kald_nomor, kald_rpsublim) VALUES (?, ?) ON DUPLICATE KEY UPDATE kald_rpsublim = VALUES(kald_rpsublim)`;
                        await conn.query(subSql, [nomorKalkulasi, totalSublim]);
                    }

                    // 3. Simpan DTF ke tkalkulasi_dtf
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
                        await conn.query(dtfSql, [
                            nomorKalkulasi,
                            dtfItem.cm,
                            dtfItem.p,
                            dtfItem.l,
                            dtfItem.biaya,
                        ]);
                    }

                    // 4. Simpan BORDIR ke tkalkulasi_bordir
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
                        await conn.query(borSql, [
                            nomorKalkulasi,
                            bordirItem.cm,
                            bordirItem.p,
                            bordirItem.l,
                            bordirItem.biaya,
                        ]);
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

    // Workshop garmen: PREMIUM=P04, MEDIUM=P01 (hanya divisi 4) - default MEDIUM (P01)
    let workshopGarmen = null;
    if (divisiNum === 4) {
        const rawWorkshop = String(
            payload.mh_workshop ??
                payload.garmen_workshop ??
                payload.workshop ??
                payload.garmen_tier ??
                payload.tier ??
                "",
        )
            .trim()
            .toUpperCase();
        if (rawWorkshop === "P04" || rawWorkshop === "PREMIUM") workshopGarmen = "P04";
        else if (rawWorkshop === "P01" || rawWorkshop === "MEDIUM") workshopGarmen = "P01";
        else workshopGarmen = "P01";
    }

    // Jika status bukan DONE (misalnya NEGO), kosongkan kolom nomor dan tanggal kalkulasi di tmintaharga
    const mhNomorKalkulasi = initialStatus === "DONE" ? nomorKalkulasi : null;
    const mhDateKalkulasi = initialStatus === "DONE" ? dateKalkulasi : null;

    // Coba insert dengan kolom mh_workshop, fallback jika kolom belum ada di DB (ER_BAD_FIELD_ERROR)
    try {
        await conn.query(
            `
        INSERT INTO tmintaharga (
            mh_divisi, mh_nomor, mh_tanggal, mh_cus_kode, mh_cus_nama, mh_sal_kode,
            mh_nama, mh_jmlorder, mh_harga, mh_budget, mh_dateorder, mh_kain,
            mh_panjang, mh_lebar, mh_ukuran, mh_gramasi, mh_finishing, mh_sublim,
            mh_ket, mh_warna, mh_workshop, mh_status, date_create, user_create,
            mh_harga_kalkulasi, mh_ket_kalkulasi, mh_nomor_kalkulasi, mh_date_kalkulasi
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?)
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
                workshopGarmen,
                initialStatus,
                actor,
                hargaKalkulasi,
                String(payload.mh_ket_kalkulasi || "").trim(),
                mhNomorKalkulasi,
                mhDateKalkulasi,
            ],
        );
    } catch (e) {
        if (String(e?.code || "") === "ER_BAD_FIELD_ERROR" && String(e?.sqlMessage || "").includes("mh_workshop")) {
            console.warn("[PermintaanHarga][InsertWorkshopFallback][Warn] kolom mh_workshop belum ada, fallback tanpa kolom");
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
                    mhNomorKalkulasi,
                    mhDateKalkulasi,
                ],
            );
        } else throw e;
    }
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
    let hasWorkshopCol = true;
    try {
        const [colChk] = await db.query(`SHOW COLUMNS FROM tmintaharga LIKE 'mh_workshop'`);
        hasWorkshopCol = Array.isArray(colChk) && colChk.length > 0;
    } catch {}
    const workshopSelect = hasWorkshopCol ? `COALESCE(h.mh_workshop,'') AS mh_workshop,` : `'' AS mh_workshop,`;
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
            ${workshopSelect}
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
        } catch (dtlOngkirErr) {
            console.warn(
                "[PermintaanHarga][UpdateDtlOngkir][Warn]",
                dtlOngkirErr.message,
            );
        }
    }

    // workshop garmen untuk update (hanya divisi 4) - default MEDIUM (P01)
    let updWorkshop = null;
    let hasWorkshopColUpd = true;
    try {
        const [c] = await db.query(`SHOW COLUMNS FROM tmintaharga LIKE 'mh_workshop'`);
        hasWorkshopColUpd = Array.isArray(c) && c.length > 0;
    } catch { hasWorkshopColUpd = false; }
    if (updateDivisiNum === 4 && hasWorkshopColUpd) {
        const rawUpd = String(
            body.mh_workshop ?? body.garmen_workshop ?? body.workshop ?? body.garmen_tier ?? body.tier ?? "",
        ).trim().toUpperCase();
        if (rawUpd === "P04" || rawUpd === "PREMIUM") updWorkshop = "P04";
        else if (rawUpd === "P01" || rawUpd === "MEDIUM") updWorkshop = "P01";
        else updWorkshop = "P01";
    }
    if (hasWorkshopColUpd && updWorkshop !== null) {
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
            mh_workshop = ?,
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
                updWorkshop,
                toNumber(body.mh_harga_kalkulasi, 0),
                String(body.mh_ket_kalkulasi || "").trim(),
                actor,
                nomor,
            ],
        );
    } else {
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
    }

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

// ========================================================
// 1. GARMEN KAIN (tmintaharga_kain) - Sesuai settingHargaBahanService Manksi
// ========================================================
const getKainGarmen = async () => {
    let rows;
    try {
        const [r] = await db.query(
            "SELECT * FROM tmintaharga_kain ORDER BY mhk_ktg ASC, mhk_jeniskain ASC, mhk_warna ASC",
        );
        rows = r;
    } catch (err) {
        if (
            err.code === "ER_BAD_FIELD_ERROR" &&
            (String(err.sqlMessage).includes("mhk_harga_partaibesar") ||
                String(err.sqlMessage).includes("mhk_allow_partaibesar"))
        ) {
            const [r2] = await db.query(
                "SELECT *, NULL AS mhk_harga_partaibesar, NULL AS mhk_allow_partaibesar FROM tmintaharga_kain ORDER BY mhk_ktg ASC, mhk_jeniskain ASC, mhk_warna ASC",
            );
            rows = r2;
        } else throw err;
    }

    const kh0002InfoMap = new Map();
    const kh0002InfoMapBesar = new Map();
    rows.forEach((r) => {
        const kode = (r.mhk_kode || "").trim().toUpperCase();
        if (kode !== "KH-0002") return;
        const jk = (r.mhk_jeniskain || "").trim();
        if (!kh0002InfoMap.has(jk)) {
            kh0002InfoMap.set(jk, {
                babaranLengan: 0,
                hargaTua: 0,
                fallbackHarga: 0,
            });
            kh0002InfoMapBesar.set(jk, {
                babaranLengan: 0,
                hargaTua: 0,
                fallbackHarga: 0,
            });
        }
        const info = kh0002InfoMap.get(jk);
        const infoB = kh0002InfoMapBesar.get(jk);
        const komp = (r.mhk_komponen || "").trim().toUpperCase();
        const warna = (r.mhk_warna || "").trim().toUpperCase();
        const babaran = Number(r.mhk_babaran) || 0;
        const harga = Number(r.mhk_harga) || 0;
        const hargaBesar = Number(r.mhk_harga_partaibesar) || harga || 0;

        if (komp === "LENGAN" && babaran > 0) {
            info.babaranLengan = babaran;
            infoB.babaranLengan = babaran;
            if (!info.fallbackHarga) info.fallbackHarga = harga;
            if (!infoB.fallbackHarga) infoB.fallbackHarga = hargaBesar;
        }
        if (warna === "TUA" && harga > 0) {
            info.hargaTua = harga;
        }
        if (warna === "TUA" && hargaBesar > 0) {
            infoB.hargaTua = hargaBesar;
        }
    });

    const lenganPriceMap = new Map();
    const lenganPriceMapBesar = new Map();
    kh0002InfoMap.forEach((info, jk) => {
        const hrg = info.hargaTua || info.fallbackHarga || 0;
        if (info.babaranLengan > 0 && hrg > 0) {
            const dppTua = hrg / 1.11;
            lenganPriceMap.set(jk, Math.round(dppTua / info.babaranLengan));
        }
    });
    kh0002InfoMapBesar.forEach((info, jk) => {
        const hrg = info.hargaTua || info.fallbackHarga || 0;
        if (info.babaranLengan > 0 && hrg > 0) {
            const dppTua = hrg / 1.11;
            lenganPriceMapBesar.set(
                jk,
                Math.round(dppTua / info.babaranLengan),
            );
        }
    });

    const babaranBodyMap = new Map();
    rows.forEach((r) => {
        const kode = (r.mhk_kode || "").trim().toUpperCase();
        const jk = (r.mhk_jeniskain || "").trim();
        const key = `${kode}_${jk}`;
        const komp = (r.mhk_komponen || "").trim().toUpperCase();
        const val = Number(r.mhk_babaran) || 0;
        if (!babaranBodyMap.has(key)) babaranBodyMap.set(key, 0);
        if (komp === "BODY" && val > 0) {
            babaranBodyMap.set(key, val);
        } else if (val > 0 && babaranBodyMap.get(key) === 0) {
            babaranBodyMap.set(key, val);
        }
    });

    let biayaJahitRows;
    try {
        const [bRows] = await db.query(
            "SELECT mhb_ket, mhb_biaya, mhb_biaya_partaibesar_kh0001, mhb_biaya_partaibesar_kh0002 FROM tmintaharga_biaya WHERE mhb_jenis = 'JAHIT'",
        );
        biayaJahitRows = bRows;
    } catch (err) {
        if (
            err.code === "ER_BAD_FIELD_ERROR" &&
            String(err.sqlMessage).includes("mhb_biaya_partaibesar")
        ) {
            const [bRows] = await db.query(
                "SELECT mhb_ket, mhb_biaya, NULL AS mhb_biaya_partaibesar_kh0001, NULL AS mhb_biaya_partaibesar_kh0002 FROM tmintaharga_biaya WHERE mhb_jenis = 'JAHIT'",
            );
            biayaJahitRows = bRows;
        } else throw err;
    }
    const biayaJahitMap = new Map();
    const biayaJahitBesarMapKh0001 = new Map();
    const biayaJahitBesarMapKh0002 = new Map();
    let defaultBiayaJahit = 5000;
    let defaultBiayaKh0001 = null;
    let defaultBiayaKh0002 = null;
    biayaJahitRows.forEach((b) => {
        const ket = (b.mhb_ket || "").trim().toUpperCase();
        const cost = Number(b.mhb_biaya) || 0;
        const raw1 = b.mhb_biaya_partaibesar_kh0001;
        const raw2 = b.mhb_biaya_partaibesar_kh0002;
        const costBesar1 =
            raw1 !== null && raw1 !== undefined && Number(raw1) !== 0
                ? Number(raw1)
                : null;
        const costBesar2 =
            raw2 !== null && raw2 !== undefined && Number(raw2) !== 0
                ? Number(raw2)
                : null;
        if (ket === "-" || ket === "") {
            defaultBiayaJahit = cost;
            if (costBesar1 !== null) defaultBiayaKh0001 = costBesar1;
            if (costBesar2 !== null) defaultBiayaKh0002 = costBesar2;
        } else {
            biayaJahitMap.set(ket, cost);
            if (costBesar1 !== null) {
                if (
                    !biayaJahitBesarMapKh0001.has(ket) ||
                    biayaJahitBesarMapKh0001.get(ket) === 0
                ) {
                    biayaJahitBesarMapKh0001.set(ket, costBesar1);
                }
            }
            if (costBesar2 !== null) {
                if (
                    !biayaJahitBesarMapKh0002.has(ket) ||
                    biayaJahitBesarMapKh0002.get(ket) === 0
                ) {
                    biayaJahitBesarMapKh0002.set(ket, costBesar2);
                }
            }
        }
    });

    return rows.map((r) => {
        const kode = (r.mhk_kode || "").trim().toUpperCase();
        const jk = (r.mhk_jeniskain || "").trim();
        const ktg = (r.mhk_ktg || "").trim().toUpperCase();
        const key = `${kode}_${jk}`;
        const bBody = babaranBodyMap.get(key) || 0;
        const bLengan =
            kode === "KH-0002"
                ? kh0002InfoMap.get(jk)?.babaranLengan || 0
                : 0;
        const bLenganBesar =
            kode === "KH-0002"
                ? kh0002InfoMapBesar.get(jk)?.babaranLengan || bLengan
                : 0;

        const hargaBahan = Number(r.mhk_harga) || 0;
        const hargaBahanBesarRaw = r.mhk_harga_partaibesar;
        const hargaBahanBesar =
            hargaBahanBesarRaw !== null &&
            hargaBahanBesarRaw !== undefined &&
            Number(hargaBahanBesarRaw) !== 0
                ? Number(hargaBahanBesarRaw)
                : hargaBahan;
        const hargaBody =
            bBody > 0 ? Math.round(hargaBahan / bBody / 1.11) : 0;
        const hargaRib = Math.round((hargaBahan / 1.11 + 1500) / 70);
        const hargaLengan =
            kode === "KH-0002" ? lenganPriceMap.get(jk) || 0 : 0;

        const hargaBodyBesar =
            bBody > 0 ? Math.round(hargaBahanBesar / bBody / 1.11) : 0;
        const hargaRibBesar = Math.round(
            (hargaBahanBesar / 1.11 + 1500) / 70,
        );
        const hargaLenganBesar =
            kode === "KH-0002"
                ? lenganPriceMapBesar.get(jk) || hargaLengan
                : 0;

        const totalHargaBahan = hargaBody + hargaLengan + hargaRib;
        const allowancePersen = Number(r.mhk_allow) || 0;
        const allowancePersenBesarRaw = r.mhk_allow_partaibesar;
        const allowancePersenBesar =
            allowancePersenBesarRaw !== null &&
            allowancePersenBesarRaw !== undefined &&
            String(allowancePersenBesarRaw) !== ""
                ? Number(allowancePersenBesarRaw)
                : allowancePersen;
        const allowanceRp = Math.round(
            totalHargaBahan * (allowancePersen / 100),
        );
        const totalBahan = totalHargaBahan + allowanceRp;

        const totalHargaBahanBesar =
            hargaBodyBesar + hargaLenganBesar + hargaRibBesar;
        const allowanceRpBesar = Math.round(
            totalHargaBahanBesar * (allowancePersenBesar / 100),
        );
        const totalBahanBesar = totalHargaBahanBesar + allowanceRpBesar;

        const biayaKonveksi = biayaJahitMap.has(ktg)
            ? biayaJahitMap.get(ktg)
            : defaultBiayaJahit;
        const isKh0001 = kode === "KH-0001";
        const biayaKonveksiBesar = (() => {
            const mapBesar = isKh0001
                ? biayaJahitBesarMapKh0001
                : biayaJahitBesarMapKh0002;
            const defBesar = isKh0001
                ? defaultBiayaKh0001
                : defaultBiayaKh0002;
            if (mapBesar.has(ktg)) return mapBesar.get(ktg);
            if (defBesar !== null && defBesar !== undefined) return defBesar;
            return biayaKonveksi;
        })();
        const hpp = totalBahan + biayaKonveksi;
        const hppBesar = totalBahanBesar + biayaKonveksiBesar;

        return {
            ...r,
            kode: r.mhk_kode,
            ktg: r.mhk_ktg,
            jenis_kain: r.mhk_jeniskain,
            lengan: r.mhk_lengan,
            komponen: r.mhk_komponen,
            babaran: r.mhk_babaran,
            warna: r.mhk_warna,
            harga: r.mhk_harga,
            allow: r.mhk_allow,
            mhk_harga_partaibesar:
                hargaBahanBesarRaw !== undefined
                    ? hargaBahanBesarRaw
                    : null,
            babaranBody: bBody,
            babaran_body: bBody,
            babaranLengan: bLengan,
            babaran_lengan: bLengan,
            babaranRib: 70,
            babaran_rib: 70,
            mhk_harga_rib: hargaRib,
            hargaRib,
            mhk_harga_lengan: hargaLengan,
            hargaLengan,
            mhk_harga_body: hargaBody,
            hargaBody,
            mhk_total_harga_bahan: totalHargaBahan,
            totalHargaBahan,
            mhk_allowance_rp: allowanceRp,
            allowanceRp,
            mhk_total_bahan: totalBahan,
            totalBahan,
            mhk_biaya_konveksi: biayaKonveksi,
            biayaKonveksi,
            mhk_biaya_konveksi_partaibesar: biayaKonveksiBesar,
            biayaKonveksiBesar,
            biayaKonveksiPartaiBesar: biayaKonveksiBesar,
            mhk_hpp: hpp,
            hpp,
            mhk_harga_body_partaibesar: hargaBodyBesar,
            hargaBody_partaibesar: hargaBodyBesar,
            mhk_harga_rib_partaibesar: hargaRibBesar,
            hargaRib_partaibesar: hargaRibBesar,
            mhk_harga_lengan_partaibesar: hargaLenganBesar,
            hargaLengan_partaibesar: hargaLenganBesar,
            mhk_total_harga_bahan_partaibesar: totalHargaBahanBesar,
            totalHargaBahan_partaibesar: totalHargaBahanBesar,
            mhk_allowance_rp_partaibesar: allowanceRpBesar,
            allowanceRp_partaibesar: allowanceRpBesar,
            mhk_total_bahan_partaibesar: totalBahanBesar,
            totalBahan_partaibesar: totalBahanBesar,
            mhk_hpp_partaibesar: hppBesar,
            hpp_partaibesar: hppBesar,
            hppPartaiBesar: hppBesar,
        };
    });
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

    const garmenKain = await getKainGarmen();

    const [garmenTambahan] = await db.query(
        `SELECT 
            mht_ket AS ket,
            mht_lacost AS harga_lacost,
            mht_cotton AS harga_cotton,
            mht_pe AS harga_pe,
            COALESCE(mht_pe_partaibesar, 0) AS harga_pe_partaibesar
         FROM tmintaharga_tambahan
         ORDER BY mht_ket`,
    );

    const [ongkirList] = await db.query(
        `SELECT 
            mho_id AS id,
            mho_alokasi AS alokasi,
            mho_harga_kg AS harga_kg,
            mho_min_kg AS min_kg,
            mho_free_spanduk_m AS free_spanduk_m,
            mho_free_mmt_m2 AS free_mmt_m2,
            mho_free_garmen_pcs AS free_garmen_pcs,
            mho_spanduk_m_per_kg AS spanduk_m_per_kg,
            mho_mmt_m2_per_kg AS mmt_m2_per_kg,
            mho_garmen_med_pcs_per_kg AS garmen_med_pcs_per_kg,
            mho_garmen_prem_pcs_per_kg AS garmen_prem_pcs_per_kg
         FROM tmintaharga_ongkir
         ORDER BY mho_id`,
    );

    return {
        spanduk: spandukBahan,
        mmt: mmtBahan,
        topping: toppingBanner,
        garmenKain,
        garmenTambahan,
        ongkir: ongkirList,
    };
};

const getOngkirOptions = async () => {
    const [rows] = await db.query(
        `SELECT 
            mho_id AS id,
            mho_alokasi AS alokasi,
            mho_harga_kg AS harga_kg,
            mho_min_kg AS min_kg,
            mho_free_spanduk_m AS free_spanduk_m,
            mho_free_mmt_m2 AS free_mmt_m2,
            mho_free_garmen_pcs AS free_garmen_pcs,
            mho_spanduk_m_per_kg AS spanduk_m_per_kg,
            mho_mmt_m2_per_kg AS mmt_m2_per_kg,
            mho_garmen_med_pcs_per_kg AS garmen_med_pcs_per_kg,
            mho_garmen_prem_pcs_per_kg AS garmen_prem_pcs_per_kg
         FROM tmintaharga_ongkir
         ORDER BY mho_id`,
    );
    return rows;
};

const calculateOngkir = async ({
    alokasi = "Jakarta",
    divisi = "1",
    panjang = 0,
    lebar = 0,
    qty = 0,
    sublim = "",
    customNominal = null,
}) => {
    const numPanjang = toNumber(panjang, 0);
    const numLebar = toNumber(lebar, 0);
    const numQty = toNumber(qty, 0);
    const normDivisi = String(divisi || "1").trim();
    const isCustom =
        String(alokasi || "").toLowerCase() === "custom" ||
        (customNominal !== null && customNominal !== undefined && customNominal !== "");

    if (isCustom && customNominal !== null && customNominal !== undefined && customNominal !== "") {
        const totalOngkir = toNumber(customNominal, 0);
        const ongkirPerPcs = numQty > 0 ? Math.round(totalOngkir / numQty) : totalOngkir;
        return {
            alokasi: "Custom",
            isCustom: true,
            totalBeratKg: 0,
            beratDihitungKg: 0,
            minKg: 0,
            tarifPerKg: 0,
            isFreeCharge: false,
            totalOngkir,
            ongkirPerPcs,
            keterangan: "Custom Ongkir",
        };
    }

    const [rows] = await db.query(
        `SELECT * FROM tmintaharga_ongkir WHERE mho_alokasi = ? OR mho_id = ? LIMIT 1`,
        [alokasi, alokasi],
    );

    if (!rows || rows.length === 0) {
        const totalCustom = toNumber(customNominal, 0);
        return {
            alokasi: alokasi || "Custom",
            isCustom: true,
            totalBeratKg: 0,
            beratDihitungKg: 0,
            minKg: 0,
            tarifPerKg: 0,
            isFreeCharge: false,
            totalOngkir: totalCustom,
            ongkirPerPcs: numQty > 0 ? Math.round(totalCustom / numQty) : 0,
            keterangan: "Alokasi tidak ditemukan",
        };
    }

    const cfg = rows[0];
    let totalVolume = 0;
    let totalBeratKg = 0;
    let isFreeCharge = false;

    if (normDivisi === "1") {
        // SPANDUK: 10 meter = 1 kg (mho_spanduk_m_per_kg)
        const totalMeter = Math.round(numPanjang * numQty * 100) / 100;
        totalVolume = totalMeter;
        const rasio = toNumber(cfg.mho_spanduk_m_per_kg, 10);
        totalBeratKg = rasio > 0 ? totalMeter / rasio : 0;
        if (cfg.mho_free_spanduk_m > 0 && totalMeter >= cfg.mho_free_spanduk_m) {
            isFreeCharge = true;
        }
    } else if (normDivisi === "5") {
        // MMT: 2 m2 = 1 kg / 0.5 kg per m2 (mho_mmt_m2_per_kg)
        const luasPerPcs = Math.round(numPanjang * numLebar * 100) / 100;
        const totalLuas = Math.round(luasPerPcs * numQty * 100) / 100;
        totalVolume = totalLuas;
        const rasio = toNumber(cfg.mho_mmt_m2_per_kg, 2);
        totalBeratKg = rasio > 0 ? totalLuas / rasio : 0;
        if (cfg.mho_free_mmt_m2 > 0 && totalLuas >= cfg.mho_free_mmt_m2) {
            isFreeCharge = true;
        }
    } else if (normDivisi === "4") {
        // GARMEN: 5 pcs/kg (Medium) atau 3 pcs/kg (Premium)
        totalVolume = numQty;
        const isPremium = String(sublim || "").toUpperCase() === "PREMIUM";
        const rasio = isPremium
            ? toNumber(cfg.mho_garmen_prem_pcs_per_kg, 3)
            : toNumber(cfg.mho_garmen_med_pcs_per_kg, 5);
        totalBeratKg = rasio > 0 ? numQty / rasio : 0;
        if (cfg.mho_free_garmen_pcs > 0 && numQty >= cfg.mho_free_garmen_pcs) {
            isFreeCharge = true;
        }
    } else {
        totalBeratKg = numQty;
    }

    totalBeratKg = Math.round(totalBeratKg * 100) / 100;

    let totalOngkir = 0;
    let beratDihitungKg = 0;
    const minKg = toNumber(cfg.mho_min_kg, 20);
    const tarifPerKg = toNumber(cfg.mho_harga_kg, 0);

    if (isFreeCharge) {
        totalOngkir = 0;
        beratDihitungKg = totalBeratKg;
    } else {
        beratDihitungKg = Math.max(totalBeratKg, minKg);
        totalOngkir = Math.round(beratDihitungKg * tarifPerKg);
    }

    const ongkirPerPcs = numQty > 0 ? Math.round(totalOngkir / numQty) : totalOngkir;

    return {
        id: cfg.mho_id,
        alokasi: cfg.mho_alokasi,
        tarifPerKg,
        minKg,
        totalBeratKg,
        beratDihitungKg,
        isFreeCharge,
        totalOngkir,
        ongkirPerPcs,
        rawConfig: {
            freeSpandukM: cfg.mho_free_spanduk_m,
            freeMmtM2: cfg.mho_free_mmt_m2,
            freeGarmenPcs: cfg.mho_free_garmen_pcs,
            spandukMPerKg: cfg.mho_spanduk_m_per_kg,
            mmtM2PerKg: cfg.mho_mmt_m2_per_kg,
            garmenMedPcsPerKg: cfg.mho_garmen_med_pcs_per_kg,
            garmenPremPcsPerKg: cfg.mho_garmen_prem_pcs_per_kg,
        },
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
    selongsongVertical = false,
    selongsongHorizontal = false,
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

    // Biaya Finishing Selongsong (Opsional)
    const isSelongsongVert = Boolean(selongsongVertical);
    const isSelongsongHoriz = Boolean(selongsongHorizontal);
    const biayaSelongsongVertPerPcs = isSelongsongVert
        ? Math.round(0.2 * numPanjang * tarifPerM2)
        : 0;
    const biayaSelongsongHorizPerPcs = isSelongsongHoriz
        ? Math.round(0.2 * numLebar * tarifPerM2)
        : 0;
    const totalSelongsongPerPcs =
        biayaSelongsongVertPerPcs + biayaSelongsongHorizPerPcs;
    const totalSelongsong = totalSelongsongPerPcs * numQty;

    const totalHarga = biayaCetak + totalTopping + totalSelongsong;
    const hargaSatuanPcs = numQty > 0 ? Math.round(totalHarga / numQty) : 0;

    return {
        luasPerPcs,
        totalLuas,
        tarifPerM2,
        biayaCetak,
        topping: toppingData,
        selongsong: {
            isVertical: isSelongsongVert,
            isHorizontal: isSelongsongHoriz,
            biayaVerticalPerPcs: biayaSelongsongVertPerPcs,
            biayaHorizontalPerPcs: biayaSelongsongHorizPerPcs,
            totalPerPcs: totalSelongsongPerPcs,
            totalBiaya: totalSelongsong,
        },
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
    let hargaBahanBesar = 0;
    let allowancePersen = 17;
    let allowancePersenBesar = 17;
    let bBody = 0;
    let bLengan = 0;
    let bRib = 70;
    let hargaBahanLengan = 0;
    let hargaBahanLenganBesar = 0;

    if (kainRows.length > 0) {
        ktg = (kainRows[0].mhk_ktg || "COTTON").toUpperCase().trim();
        allowancePersen = toNumber(
            kainRows[0].mhk_allow,
            ktg === "PE" || ktg === "HYGIT" || ktg === "DRYFIT" ? 5 : 17,
        );
        allowancePersenBesar = allowancePersen;

        // Kumpulkan babaran (BODY, LENGAN, RIB) dari seluruh baris model & jenis kain ini
        kainRows.forEach((r) => {
            const komp = (r.mhk_komponen || "").toUpperCase().trim();
            const val = Number(r.mhk_babaran) || 0;
            if (komp === "BODY" && val > 0) bBody = val;
            else if (komp === "LENGAN" && val > 0) bLengan = val;
            else if (komp === "RIB" && val >= 10) bRib = val;
            else if (val > 0 && bBody === 0) bBody = val;
        });

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
            if (
                matchedWarna.mhk_harga_partaibesar !== null &&
                matchedWarna.mhk_harga_partaibesar !== undefined &&
                Number(matchedWarna.mhk_harga_partaibesar) > 0
            ) {
                hargaBahanBesar = toNumber(
                    matchedWarna.mhk_harga_partaibesar,
                    hargaBahan,
                );
            } else {
                hargaBahanBesar = hargaBahan;
            }
            if (
                matchedWarna.mhk_allow_partaibesar !== null &&
                matchedWarna.mhk_allow_partaibesar !== undefined &&
                String(matchedWarna.mhk_allow_partaibesar) !== ""
            ) {
                allowancePersenBesar = toNumber(
                    matchedWarna.mhk_allow_partaibesar,
                    allowancePersen,
                );
            } else {
                allowancePersenBesar = allowancePersen;
            }
        } else {
            hargaBahan = toNumber(kainRows[0].mhk_harga, 0);
            if (
                kainRows[0].mhk_harga_partaibesar !== null &&
                kainRows[0].mhk_harga_partaibesar !== undefined &&
                Number(kainRows[0].mhk_harga_partaibesar) > 0
            ) {
                hargaBahanBesar = toNumber(
                    kainRows[0].mhk_harga_partaibesar,
                    hargaBahan,
                );
            } else {
                hargaBahanBesar = hargaBahan;
            }
            if (
                kainRows[0].mhk_allow_partaibesar !== null &&
                kainRows[0].mhk_allow_partaibesar !== undefined &&
                String(kainRows[0].mhk_allow_partaibesar) !== ""
            ) {
                allowancePersenBesar = toNumber(
                    kainRows[0].mhk_allow_partaibesar,
                    allowancePersen,
                );
            } else {
                allowancePersenBesar = allowancePersen;
            }
        }

        // Pada KH-0002 cari harga kain warna TUA untuk lengan
        hargaBahanLengan = 0;
        hargaBahanLenganBesar = 0;
        if (normKodeModel === "KH-0002") {
            const rowTua = kainRows.find(
                (r) =>
                    (r.mhk_warna || "").toUpperCase().trim() === "TUA" &&
                    Number(r.mhk_harga) > 0,
            );
            hargaBahanLengan = rowTua
                ? toNumber(rowTua.mhk_harga, 0)
                : hargaBahan;
            const rowTuaBesar = kainRows.find(
                (r) =>
                    (r.mhk_warna || "").toUpperCase().trim() === "TUA" &&
                    Number(r.mhk_harga_partaibesar) > 0,
            );
            hargaBahanLenganBesar = rowTuaBesar
                ? toNumber(rowTuaBesar.mhk_harga_partaibesar, 0)
                : hargaBahanLengan;
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

                if (isLacost) {
                    tarifTambahan = toNumber(matchedTam.mht_lacost, 0);
                } else if (isPe) {
                    const peBesar = toNumber(matchedTam.mht_pe_partaibesar, 0);
                    const peNormal = toNumber(matchedTam.mht_pe, 0);
                    if (numQty >= 1000 && peBesar > 0) tarifTambahan = peBesar;
                    else tarifTambahan = peNormal;
                } else tarifTambahan = toNumber(matchedTam.mht_cotton, 0);

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
        // Kategori cetak sablon berdasarkan ktg kain (mirip tambahan)
        const ktgUpperCetak = (ktg || "").toUpperCase().trim();
        const jkUpperCetak = (normJenisKain || "").toUpperCase().trim();
        let kategoriCetak = "COTTON";
        if (
            ktgUpperCetak.includes("LACOST") ||
            jkUpperCetak.includes("LACOST") ||
            jkUpperCetak.includes("PIQUE")
        ) kategoriCetak = "LACOST";
        else if (
            ktgUpperCetak.includes("PE") ||
            ktgUpperCetak.includes("HYGIT") ||
            ktgUpperCetak.includes("DRYFIT") ||
            jkUpperCetak.includes("PE ") ||
            jkUpperCetak.includes("HYGIT") ||
            jkUpperCetak.includes("DRYFIT")
        ) kategoriCetak = "PE";

        cetakList.forEach((cItem) => {
            const jenisName = (cItem?.jenis || "").trim().toUpperCase();
            const ketName = (cItem?.ket || "").trim().toUpperCase();
            const isSablon = jenisName === "SABLON";

            let matchedCetak = null;
            if (isSablon) {
                // 1. Coba exact match langsung di master
                matchedCetak = allCetak.find((ac) => {
                    const acJenis = String(ac.mhb_jenis || "").trim().toUpperCase();
                    const acKet = String(ac.mhb_ket || "").trim().toUpperCase();
                    return acJenis === "SABLON" && acKet === ketName;
                });

                // 2. Jika belum cocok dan ketName belum ada suffix kain, coba cari dengan suffix kategori kain
                if (!matchedCetak) {
                    const targetWithKtg = `${ketName} ${kategoriCetak}`;
                    matchedCetak = allCetak.find((ac) => {
                        const acJenis = String(ac.mhb_jenis || "").trim().toUpperCase();
                        const acKet = String(ac.mhb_ket || "").trim().toUpperCase();
                        return acJenis === "SABLON" && acKet === targetWithKtg;
                    });
                }

                // 3. Khusus MEDIUM: jika PE cari varian "... PE", jika Cotton/Lacost cari varian umum (tanpa PE)
                if (!matchedCetak && ketName.startsWith("MEDIUM")) {
                    matchedCetak = allCetak.find((ac) => {
                        const acJenis = String(ac.mhb_jenis || "").trim().toUpperCase();
                        const acKet = String(ac.mhb_ket || "").trim().toUpperCase();
                        if (acJenis !== "SABLON") return false;
                        if (kategoriCetak === "PE") {
                            return acKet === `${ketName} PE` || (acKet.startsWith(ketName) && acKet.endsWith(" PE"));
                        } else {
                            return acKet === ketName && !acKet.endsWith(" PE");
                        }
                    });
                }

                // 4. Fallback: cari sablon yang dimulai dengan ketName dasar dan berakhiran kategori kain
                if (!matchedCetak) {
                    matchedCetak = allCetak.find((ac) => {
                        const acJenis = String(ac.mhb_jenis || "").trim().toUpperCase();
                        const acKet = String(ac.mhb_ket || "").trim().toUpperCase();
                        if (acJenis !== "SABLON") return false;
                        return acKet.startsWith(ketName) && acKet.endsWith(` ${kategoriCetak}`);
                    });
                }
            } else {
                matchedCetak = allCetak.find((ac) => {
                    const acJenis = String(ac.mhb_jenis || "").trim().toUpperCase();
                    const acKet = String(ac.mhb_ket || "").trim().toUpperCase();
                    return acJenis === jenisName && acKet === ketName;
                });
            }

            if (matchedCetak) {
                const itemBiaya =
                    Number(cItem?.biaya) > 0
                        ? Number(cItem.biaya)
                        : Number(matchedCetak.mhb_biaya) || 0;
                resolvedCetak.push({
                    jenis: matchedCetak.mhb_jenis,
                    ket: matchedCetak.mhb_ket || ketName,
                    biaya: itemBiaya,
                });
            } else if (Number(cItem?.biaya) > 0) {
                resolvedCetak.push({
                    jenis: cItem.jenis || (isSablon ? "SABLON" : "CETAK"),
                    ket: cItem.ket || "",
                    biaya: Number(cItem.biaya),
                });
            } else {
                resolvedCetak.push({
                    jenis: cItem?.jenis || (isSablon ? "SABLON" : "CETAK"),
                    ket: cItem?.ket || "",
                    biaya: 0,
                });
            }
        });
    }

    const isSport = ktg === "PE" || ktg === "HYGIT" || ktg === "DRYFIT";

    let marginKtg = "COTTON";
    const ktgUpper = String(ktg || "").toUpperCase().trim();
    if (
        ktgUpper.includes("PE") ||
        ktgUpper.includes("HYGIT") ||
        ktgUpper.includes("DRYFIT")
    ) {
        marginKtg = "PE";
    } else if (
        ktgUpper.includes("LACOST") ||
        ktgUpper.includes("PIQUE")
    ) {
        marginKtg = "LACOST";
    }

    let marginRows;
    try {
        const [mRows] = await db.query(
            `SELECT qmin, qmax, margin, persen, model, ktg 
             FROM tmintaharga_margin 
             WHERE model = ? AND (ktg = ? OR ktg IS NULL)
             ORDER BY qmin`,
            [normKodeModel, marginKtg],
        );
        marginRows = mRows;
        if (!marginRows || marginRows.length === 0) {
            const [fallbackRows] = await db.query(
                `SELECT qmin, qmax, margin, persen, model, ktg 
                 FROM tmintaharga_margin 
                 WHERE model = ? 
                 ORDER BY qmin`,
                [normKodeModel],
            );
            marginRows = fallbackRows;
        }
    } catch (mErr) {
        if (
            mErr.code === "ER_BAD_FIELD_ERROR" &&
            String(mErr.sqlMessage).includes("ktg")
        ) {
            const [mRows] = await db.query(
                `SELECT qmin, qmax, margin, persen, model 
                 FROM tmintaharga_margin 
                 WHERE model = ? 
                 ORDER BY qmin`,
                [normKodeModel],
            );
            marginRows = mRows;
        } else throw mErr;
    }

    let customTiers = null;
    if (marginRows && marginRows.length > 0) {
        const seenMarginQmin = new Set();
        const uniqueMarginRows = [];
        for (const r of marginRows) {
            const q = Number(r.qmin) || 0;
            if (!seenMarginQmin.has(q)) {
                seenMarginQmin.add(q);
                uniqueMarginRows.push(r);
            }
        }
        customTiers = uniqueMarginRows.map((r, idx) => {
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
    let dbBiayaJahitBesar = null;
    if (customBiayaJahit === undefined || customBiayaJahit === null) {
        try {
            const colPartaiBesar =
                normKodeModel === "KH-0002"
                    ? "mhb_biaya_partaibesar_kh0002"
                    : "mhb_biaya_partaibesar_kh0001";
            const [jahitRows] = await db.query(
                `SELECT mhb_ket, mhb_biaya, 
                        COALESCE(${colPartaiBesar}, 0) AS mhb_biaya_partaibesar 
                 FROM tmintaharga_biaya 
                 WHERE mhb_jenis = 'JAHIT'`,
            );
            if (jahitRows && jahitRows.length > 0) {
                const ktgUpper = (ktg || "").toUpperCase().trim();
                const rowJahit =
                    jahitRows.find((j) => {
                        const ket = (j.mhb_ket || "").trim().toUpperCase();
                        if (isSport) {
                            return (
                                ket === ktgUpper ||
                                ket === "PE" ||
                                ket === "HYGIT" ||
                                ket === "DRYFIT" ||
                                ket === "SPORT"
                            );
                        }
                        if (ktgUpper.includes("LACOST")) return ket === "LACOST";
                        if (ktgUpper.includes("COTTON")) return ket === "COTTON" || ket === "-";
                        return ket === "-" || ket === "";
                    }) ||
                    jahitRows.find((j) => (j.mhb_ket || "").trim() === "-") ||
                    jahitRows[0];

                if (rowJahit) {
                    const biayaNormal = Number(rowJahit.mhb_biaya) || 0;
                    const biayaBesar = Number(rowJahit.mhb_biaya_partaibesar) || 0;
                    dbBiayaJahit = biayaNormal;
                    dbBiayaJahitBesar = biayaBesar > 0 ? biayaBesar : biayaNormal;
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
        hargaBahanBesar,
        hargaBahanLengan:
            typeof hargaBahanLengan !== "undefined" ? hargaBahanLengan : 0,
        hargaBahanLenganBesar:
            typeof hargaBahanLenganBesar !== "undefined"
                ? hargaBahanLenganBesar
                : 0,
        bBody,
        bLengan,
        bRib,
        allowancePersen,
        allowancePersenBesar,
        customAllowance,
        isSport,
        customBiayaJahit:
            customBiayaJahit !== undefined && customBiayaJahit !== null
                ? customBiayaJahit
                : dbBiayaJahit,
        customBiayaJahitBesar: dbBiayaJahitBesar,
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
    let sql = `SELECT DISTINCT 
            mhk_jeniskain AS mhk_kain,
            mhk_jeniskain AS Jeniskain,
            mhk_jeniskain AS nama,
            mhk_ktg AS mhk_ktg,
            mhk_ktg AS Kategori
         FROM tmintaharga_kain`;
    const params = [];
    if (kode) {
        sql += ` WHERE (mhk_kode = ? OR mhk_kode = '' OR mhk_kode IS NULL)`;
        params.push(kode);
    }
    sql += ` ORDER BY mhk_ktg ASC, mhk_jeniskain ASC`;
    const [rows] = await db.query(sql, params);
    return rows;
};

const getTambahanOptions = async ({
    jenisKain = "",
    kategori = "",
    kodeModel = "KH-0001",
    qty = 0,
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

    const numQty = toNumber(qty, 0);
    const [rows] = await db.query(
        `SELECT 
            mht_ket,
            mht_ket AS mht_keterangan,
            mht_ket AS ket,
            mht_ket AS nama,
            mht_lacost,
            mht_cotton,
            mht_pe,
            COALESCE(mht_pe_partaibesar, 0) AS mht_pe_partaibesar
         FROM tmintaharga_tambahan 
         ORDER BY mht_ket`,
    );

    return rows.map((r) => {
        let tarif = toNumber(r.mht_cotton, 0);
        let selectedCategory = "COTTON";

        if (isLacost) {
            tarif = toNumber(r.mht_lacost, 0);
            selectedCategory = "LACOSTE";
        } else if (isPe) {
            const peBesar = toNumber(r.mht_pe_partaibesar, 0);
            const peNormal = toNumber(r.mht_pe, 0);
            if (numQty >= 1000 && peBesar > 0) {
                tarif = peBesar;
                selectedCategory = "PE_PARTAIBESAR";
            } else {
                tarif = peNormal;
                selectedCategory = "PE";
            }
        }

        return {
            ...r,
            tarif: tarif,
            biaya: tarif,
            kategori_terpilih: selectedCategory,
        };
    });
};

const getCetakOptions = async (options = {}) => {
    const { jenisKain = "", kategori = "" } =
        typeof options === "object" ? options : {};

    let resolvedKtg = String(kategori || "")
        .toUpperCase()
        .trim();
    const normJenisKain = String(jenisKain || "").trim();

    if (!resolvedKtg && normJenisKain) {
        const [kainRows] = await db.query(
            `SELECT mhk_ktg FROM tmintaharga_kain 
             WHERE LOWER(TRIM(mhk_kain)) = LOWER(TRIM(?)) 
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

    const targetKategori = isLacost ? "LACOST" : isPe ? "PE" : "COTTON";

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

    // Filter khusus item SABLON agar hanya menampilkan yang sesuai target kategori kain
    // dan membuang entri generik tanpa akhiran kain yang menduplikasi list
    const filteredRows = rows.filter((r) => {
        const j = String(r.mhb_jenis || "").toUpperCase();
        if (j !== "SABLON") return true; // SUBLIM, DTF, BORDIR tetap tampil

        const ketUpper = String(r.mhb_ket || "")
            .toUpperCase()
            .trim();

        const hasCotton =
            ketUpper.endsWith("COTTON") || ketUpper.includes(" COTTON");
        const hasPe = ketUpper.endsWith("PE") || ketUpper.includes(" PE");
        const hasLacost =
            ketUpper.endsWith("LACOST") ||
            ketUpper.includes(" LACOST") ||
            ketUpper.includes(" LACOSTE");

        if (targetKategori === "LACOST") {
            return hasLacost;
        } else if (targetKategori === "PE") {
            return hasPe;
        } else {
            // Default COTTON
            return hasCotton;
        }
    });

    return filteredRows;
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
    getOngkirOptions,
    calculateOngkir,
    calculateSpanduk,
    calculateMmt,
    calculateGarmen,
    getKainGarmen,
    getJenisKainMintaHarga,
    getTambahanOptions,
    getCetakOptions,
    getCustomerSoHistory,
};

