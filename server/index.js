// Chạy bằng Node.js (máy chủ riêng / chạy thử trên máy): cần DATABASE_URL trỏ tới PostgreSQL (Supabase).
import { createApp } from './app.js';
import { config } from './config.js';
import { createSql, setDefaultSql } from './db.js';

if (!config.databaseUrl) {
  console.error('Thiếu DATABASE_URL trong .env (chuỗi kết nối PostgreSQL / Supabase).');
  process.exit(1);
}
const sql = createSql(config.databaseUrl, { max: 10 });
setDefaultSql(sql);

const { server } = createApp();
server.listen(config.port, config.host, () => {
  console.log(`Hệ thống Quản lý tài sản Sói Biển đang chạy tại http://${config.host}:${config.port}`);
  console.log(`URL in trên mã QR: ${config.publicBaseUrl}/q/<mã>`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => sql.end().then(() => process.exit(0))));
