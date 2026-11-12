import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Thư mục gốc dự án (chỉ có ý nghĩa khi chạy bằng Node.js; trên Workers không đọc file)
let root = '.';
try { root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); } catch { /* Cloudflare Workers */ }
export const ROOT = root;

// Nạp file .env đơn giản (không cần thư viện dotenv) – chỉ khi chạy Node.js
try {
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch { /* Workers */ }

const env = (k, d = '') => process.env[k] ?? d;

export const config = {
  port: Number(env('PORT', '8080')),
  host: env('HOST', '0.0.0.0'),
  // URL công khai dùng để in vào mã QR, ví dụ https://taisan.soibien.vn
  publicBaseUrl: env('PUBLIC_BASE_URL', 'http://localhost:8080').replace(/\/$/, ''),
  // Chuỗi kết nối PostgreSQL (Supabase) khi chạy bằng Node.js. Trên Workers dùng Hyperdrive.
  databaseUrl: env('DATABASE_URL'),
  production: env('NODE_ENV') === 'production',
  sessionDays: Number(env('SESSION_DAYS', '14')),
  companyName: env('COMPANY_NAME', 'CÔNG TY CỔ PHẦN SÓI BIỂN TRUNG THỰC'),
  companyShort: env('COMPANY_SHORT', 'SÓI BIỂN'),
  maintenanceHotline: env('MAINTENANCE_HOTLINE', ''),
  // Google Sign-In (OAuth 2.0). Để trống nếu chưa dùng.
  googleClientId: env('GOOGLE_CLIENT_ID'),
  googleClientSecret: env('GOOGLE_CLIENT_SECRET'),
  // Giới hạn domain email được phép đăng nhập Google, cách nhau dấu phẩy. Để trống = mọi gmail đã được khai báo trong hệ thống.
  googleAllowedDomains: env('GOOGLE_ALLOWED_DOMAINS').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  // Gửi OTP SMS: 'console' (in ra log, dùng thử) hoặc 'webhook' (gọi HTTP tới nhà cung cấp SMS/Zalo ZNS)
  smsProvider: env('SMS_PROVIDER', 'console'),
  smsWebhookUrl: env('SMS_WEBHOOK_URL'),
  smsWebhookToken: env('SMS_WEBHOOK_TOKEN'),
  // Thông tin quản trị viên đầu tiên (chỉ dùng khi DB trống)
  adminEmail: env('ADMIN_EMAIL', 'admin@soibien.vn'),
  adminPhone: env('ADMIN_PHONE', '0900000000'),
  adminPassword: env('ADMIN_PASSWORD', 'SoiBien@2026'),
  // Cho phép xem thông tin tối thiểu khi quét QR mà chưa đăng nhập
  publicScan: env('PUBLIC_SCAN', 'true') !== 'false',
};
