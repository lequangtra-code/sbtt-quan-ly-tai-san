import crypto from 'node:crypto';

// Băm / kiểm tra mật khẩu: thực hiện trong PostgreSQL (bcrypt, pgcrypto) – xem db.hashPassword / db.verifyPassword.

export function validatePassword(pw) {
  pw = String(pw || '');
  if (pw.length < 8) return 'Mật khẩu tối thiểu 8 ký tự';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Mật khẩu phải có cả chữ và số';
  return null;
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomDigits = (n = 6) => String(crypto.randomInt(0, 10 ** n)).padStart(n, '0');

/** Giới hạn số lần thử (chống dò mật khẩu) – lưu trong bộ nhớ của từng tiến trình / isolate */
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    if (buckets.size > 10000) buckets.clear();
    buckets.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  b.n++;
  return b.n <= max;
}
export function resetRate(key) { buckets.delete(key); }
