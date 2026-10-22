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
    // Blokir login dan berikan pesan jelas bahwa aplikasi telah berpindah ke versi Web
    const isLoginRoute =
        pathLower.includes("/auth/login") || pathLower.includes("/login");
    if (isLoginRoute) {
        const webUrl = process.env.WEB_APP_URL ? ` di ${process.env.WEB_APP_URL}` : "";
        return res.status(403).json({
            success: false,
            message: `Aplikasi PlanToday APK sudah tidak digunakan dan telah beralih ke versi Web. Silakan akses PlanToday melalui browser/Web${webUrl}.`,
            code: "MIGRATED_TO_WEB",
        });
    }

    // Izinkan request GET (Read-Only) agar pengguna lama yang masih memiliki sesi aktif tetap bisa melihat riwayat
    if (req.method === "GET") {
        return next();
    }

    // 4. Blokir seluruh operasi pembuatan / pengubahan data (POST, PUT, DELETE, PATCH)
    return res.status(403).json({
        success: false,
        message:
            "Aplikasi PlanToday versi lama sudah tidak didukung. Silakan gunakan PlanToday versi Web.",
        code: "MIGRATED_TO_WEB",
    });
};

module.exports = clientPlatformGuard;
