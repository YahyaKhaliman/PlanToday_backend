/**
 * Middleware untuk membatasi akses dari aplikasi lama (React Native)
 * dan mengarahkan pengguna secara bertahap ke aplikasi baru (Flutter).
 *
 * Konfigurasi .env (opsional):
 * BLOCK_LEGACY_APP=true (default: true)
 */
const clientPlatformGuard = (req, res, next) => {
    // 0. Toggle via env jika ingin dinonaktifkan sementara
    const isGuardEnabled = process.env.BLOCK_LEGACY_APP !== "false";
    if (!isGuardEnabled) {
        return next();
    }

    // 1. Abaikan health check, static files, dan upload images
    const pathLower = String(req.path || "").toLowerCase();
    if (
        pathLower === "/api-plantoday" ||
        pathLower.startsWith("/uploads") ||
        pathLower.startsWith("/image")
    ) {
        return next();
    }

    // 2. Cek Header Identitas Aplikasi Flutter
    const clientHeader = String(req.headers["x-app-client"] || "").trim().toLowerCase();
    const isFlutter = clientHeader === "plantoday-flutter";

    if (isFlutter) {
        return next();
    }

    // 3. Jika dari React Native lama / Client non-Flutter:
    // Izinkan login agar user lama tetap bisa masuk dan melihat riwayat data
    if (pathLower.includes("/auth/login") || pathLower.includes("/login")) {
        return next();
    }

    // Izinkan request GET (Read-Only) agar user tetap bisa melihat daftar & riwayat
    if (req.method === "GET") {
        return next();
    }

    // 4. Blokir seluruh operasi pembuatan / pengubahan data (POST, PUT, DELETE, PATCH)
    return res.status(403).json({
        success: false,
        message:
            "Aplikasi PlanToday versi lama sudah tidak didukung untuk membuat atau mengubah data. Silakan beralih ke aplikasi PlanToday versi terbaru (Flutter).",
        code: "APP_UPGRADE_REQUIRED",
    });
};

module.exports = clientPlatformGuard;
