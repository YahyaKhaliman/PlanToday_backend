// utils/nameMatch.js
// Return: kode (string) atau null
module.exports = async function NameMatch(db, loginName) {
  const raw = String(loginName || '').trim();
  if (!raw) return null;

  // Normalisasi di JS biar gak berat di DB
  const loginNorm = raw
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!loginNorm) return null;

  // token untuk fallback
  const parts = loginNorm.split(' ').filter(Boolean);
  const first = parts[0] || '';
  const last = parts[parts.length - 1] || '';

  // 1) Exact match (paling aman)
  // 2) Prefix match (kasus kamu)
  // 3) Token match (first & last harus ada sebagai kata utuh)
  // Catatan: kita normalisasi nama di SQL dengan REGEXP_REPLACE (MySQL 8)
  const sql = `
    SELECT
      v.kode,
      MAX(v.nama) AS nama,
      -- skor untuk menentukan kandidat terbaik
      MAX(
        CASE
          WHEN nama_norm = ? THEN 300
          WHEN nama_norm LIKE CONCAT(?, '%') THEN 200
          WHEN nama_padded LIKE CONCAT('% ', ?, ' %')
           AND nama_padded LIKE CONCAT('% ', ?, ' %') THEN 120
          WHEN nama_padded LIKE CONCAT('% ', ?, ' %') THEN 80
          ELSE 0
        END
      ) AS score
    FROM (
      SELECT
        kode,
        nama,
        TRIM(
          REGEXP_REPLACE(
            REGEXP_REPLACE(UPPER(nama), '[^A-Z0-9 ]', ' '),
            '[[:space:]]+', ' '
          )
        ) AS nama_norm,
        CONCAT(' ',
          TRIM(
            REGEXP_REPLACE(
              REGEXP_REPLACE(UPPER(nama), '[^A-Z0-9 ]', ' '),
              '[[:space:]]+', ' '
            )
          ),
        ' ') AS nama_padded
      FROM kpi_lokal.v_mkt_omset
    ) v
    WHERE
      v.nama_norm = ?
      OR v.nama_norm LIKE CONCAT(?, '%')
      OR (v.nama_padded LIKE CONCAT('% ', ?, ' %') AND v.nama_padded LIKE CONCAT('% ', ?, ' %'))
      OR v.nama_padded LIKE CONCAT('% ', ?, ' %')
    GROUP BY v.kode
    ORDER BY score DESC, LENGTH(MAX(v.nama)) ASC
    LIMIT 1;
  `;

  const params = [
    loginNorm, loginNorm, first, last, first,
    loginNorm, loginNorm, first, last, first,
  ];

  const [rows] = await db.query(sql, params);
  if (!rows || rows.length === 0) return null;

  // score 0 artinya gak valid
  if (!rows[0].score || Number(rows[0].score) <= 0) return null;

  return rows[0].kode;
};
