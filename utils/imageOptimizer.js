const fs = require("fs");
const sharp = require("sharp");

const MAX_IMAGE_BYTES = 500 * 1024; // 500 KB

/**
 * Memastikan ukuran file gambar di server maksimal 500 KB.
 * Jika ukuran file sudah <= 500 KB, file tidak dikompresi ulang untuk hemat CPU.
 * Jika masih > 500 KB, dilakukan kompresi bertahap dengan Sharp sebelum disimpan ke disk.
 *
 * @param {string} filePath - Path absolut file gambar di server
 * @returns {Promise<{ compressed: boolean, originalSize: number, finalSize: number }>}
 */
async function ensureImageUnder500KB(filePath) {
    if (!filePath) {
        return { compressed: false, originalSize: 0, finalSize: 0 };
    }

    try {
        const stats = await fs.promises.stat(filePath);
        const originalSize = stats.size;

        if (originalSize <= MAX_IMAGE_BYTES) {
            return {
                compressed: false,
                originalSize,
                finalSize: originalSize,
            };
        }

        console.log(
            `[ImageOptimizer] File ${filePath} berukuran ${(originalSize / 1024).toFixed(1)} KB (> 500 KB). Melakukan kompresi ulang...`,
        );

        let quality = 80;
        let width = 1280;
        const initialBuffer = await fs.promises.readFile(filePath);
        let buffer = initialBuffer;

        while (buffer.length > MAX_IMAGE_BYTES && quality >= 35) {
            try {
                buffer = await sharp(initialBuffer)
                    .rotate() // Rotasi otomatis sesuai metadata EXIF kamera
                    .resize({ width, withoutEnlargement: true, fit: "inside" })
                    .jpeg({ quality, mozjpeg: true })
                    .toBuffer();

                if (buffer.length > MAX_IMAGE_BYTES) {
                    quality -= 15;
                    width = Math.max(800, Math.round(width * 0.85));
                }
            } catch (err) {
                console.error("[ImageOptimizer] Error Sharp saat kompresi:", err);
                break;
            }
        }

        await fs.promises.writeFile(filePath, buffer);
        const finalSize = buffer.length;

        console.log(
            `[ImageOptimizer] Kompresi selesai: ${(originalSize / 1024).toFixed(1)} KB -> ${(finalSize / 1024).toFixed(1)} KB`,
        );

        return { compressed: true, originalSize, finalSize };
    } catch (err) {
        console.error("[ImageOptimizer] Gagal memproses gambar:", err);
        return { compressed: false, originalSize: 0, finalSize: 0 };
    }
}

module.exports = {
    MAX_IMAGE_BYTES,
    ensureImageUnder500KB,
};
