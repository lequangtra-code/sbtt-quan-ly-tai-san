// Tạo bảng / nâng cấp CSDL Supabase: npm run db:setup
// Cần DATABASE_URL trong .env (Supabase → Connect → Session pooler hoặc Direct connection).
import { config } from '../server/config.js';
import { createSql, setDefaultSql } from '../server/db.js';
import { setupDatabase } from '../server/setup.js';

if (!config.databaseUrl) { console.error('Thiếu DATABASE_URL trong .env'); process.exit(1); }
const sql = createSql(config.databaseUrl, { max: 1 });
setDefaultSql(sql);
try {
  await setupDatabase();
  console.log('Hoàn tất: CSDL đã sẵn sàng.');
} catch (e) {
  console.error('Lỗi khởi tạo CSDL:', e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
