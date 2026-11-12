// Điểm vào trên Cloudflare Workers.
// - Tệp tĩnh (public/) do Workers Static Assets phục vụ; Worker chỉ xử lý /api/*, /auth/*, /print/*.
// - CSDL: Supabase PostgreSQL qua Hyperdrive (binding HYPERDRIVE), mỗi request 1 kết nối riêng.
import { httpServerHandler } from 'cloudflare:node';
import { env, waitUntil } from 'cloudflare:workers';

// Đưa biến môi trường / secret của Worker vào process.env TRƯỚC khi nạp cấu hình ứng dụng
// (NODE_ENV được wrangler đặt sẵn là "production" khi deploy.)
for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && process.env[k] === undefined) process.env[k] = v;

const { createSql } = await import('./db.js');
const { createApp } = await import('./app.js');

const { server } = createApp({
  serveStatic: false,
  connect() {
    // 1 kết nối / request: các truy vấn song song được gửi nối tiếp (pipelining) trên cùng kết nối
    const sql = createSql(env.HYPERDRIVE.connectionString, { max: 1 });
    return { sql, done: () => waitUntil(sql.end({ timeout: 5 })) };
  },
});
server.listen(8080);

export default httpServerHandler({ port: 8080 });
