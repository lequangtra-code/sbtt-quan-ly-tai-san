// CSDL PostgreSQL chạy thử trên máy (PGlite, trong bộ nhớ) – không cần cài Postgres hay kết nối Supabase.
// Cách dùng:  npm run dev:db   (giữ cửa sổ này mở), rồi ở cửa sổ khác: npm run dev
// Thêm --demo để nạp dữ liệu mẫu.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = Number(process.env.DEV_DB_PORT || 54329);
const pg = await PGlite.create({ extensions: { pgcrypto, unaccent } });
const server = new PGLiteSocketServer({ db: pg, port, host: '127.0.0.1', maxConnections: 20 });
await server.start();
const url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;

process.env.DATABASE_URL = url;
const { createSql, setDefaultSql } = await import('../server/db.js');
const { setupDatabase } = await import('../server/setup.js');
const sql = createSql(url, { max: 1 });
setDefaultSql(sql);
await setupDatabase();
await sql.end();
if (process.argv.includes('--demo')) await import('./seed-demo.js'); // chạy trong cùng tiến trình
console.log(`CSDL thử đang chạy: ${url}  (Ctrl+C để dừng – dữ liệu sẽ mất)`);
