import { normalizePhone } from '../db.js';
import { validatePassword, randomToken, sha256, randomDigits } from '../security.js';
import { HttpError, bad, setCookie } from '../http.js';

/** Chỉ cho phép chuyển hướng nội bộ: "/..." nhưng không phải "//..." hay "/\..." (trình duyệt hiểu là trang ngoài) */
export const safeNext = (n) => (typeof n === 'string' && /^\/(?![/\\])/.test(n) && !/[\r\n\t]/.test(n) ? n : '/');

export default function registerAuth({ db, api, audit, config }) {
  // OTP chỉ bật khi đã cấu hình nhà cung cấp SMS (hoặc khi chạy thử trên máy)
  const otpOn = (config.smsProvider === 'webhook' && !!config.smsWebhookUrl) || !config.production;
  const findByIdentifier = async (identifier) => {
    const id = String(identifier || '').trim();
    if (id.includes('@')) return db.get('SELECT * FROM users WHERE email = ?', id.toLowerCase());
    const phone = normalizePhone(id);
    if (phone) return db.get('SELECT * FROM users WHERE phone = ?', phone);
    return db.get('SELECT * FROM users WHERE lower(employee_code) = lower(?)', id);
  };

  const startSession = async (ctx, user, method) => {
    const token = randomToken(32);
    const days = config.sessionDays;
    await db.run(`INSERT INTO sessions(token_hash, user_id, expires_at, ip, user_agent, method) VALUES (?,?,datetime('now', ?),?,?,?)`,
      sha256(token), user.id, `+${days} days`, ctx.ip, String(ctx.req.headers['user-agent'] || '').slice(0, 250), method);
    await db.run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", user.id);
    // Dọn phiên & bộ đếm hết hạn
    await db.run("DELETE FROM sessions WHERE expires_at <= datetime('now')");
    await db.run("DELETE FROM rate_limits WHERE reset_at <= datetime('now')");
    setCookie(ctx.res, 'sbtt_sid', token, { maxAge: days * 86400, secure: config.production });
    ctx.access = { user };
    await audit(ctx, 'login', 'user', user.id, { method });
  };

  api.get('/api/public/config', null, () => ({
    companyName: config.companyName,
    companyShort: config.companyShort,
    googleEnabled: !!(config.googleClientId && config.googleClientSecret),
    otpEnabled: otpOn,
    hotline: config.maintenanceHotline,
  }));

  // Đăng nhập bằng email (gmail) / số điện thoại / mã nhân viên + mật khẩu
  api.post('/api/auth/login', null, async (ctx) => {
    const { identifier, password } = ctx.body;
    if (!identifier || !password) throw bad('Vui lòng nhập email/số điện thoại và mật khẩu');
    const key = 'login:' + String(identifier).toLowerCase();
    if (!(await db.rateLimit(key, 8, 900)) || !(await db.rateLimit('loginip:' + ctx.ip, 50, 900))) throw new HttpError(429, 'Đăng nhập sai quá nhiều lần, thử lại sau 15 phút');
    const user = await findByIdentifier(identifier);
    if (!user || !(await db.verifyPassword(password, user.password_hash))) {
      await audit(ctx, 'login_failed', 'user', user?.id, { identifier: String(identifier).slice(0, 80) });
      throw new HttpError(401, 'Thông tin đăng nhập không đúng');
    }
    if (user.status !== 'active') throw new HttpError(403, 'Tài khoản đã bị khoá');
    await db.resetRate(key);
    await startSession(ctx, user, 'password');
    return { ok: true, mustChangePassword: !!user.must_change_password };
  });

  // OTP qua SMS cho số điện thoại
  api.post('/api/auth/otp/request', null, async (ctx) => {
    if (!otpOn) throw new HttpError(404, 'Chưa bật đăng nhập bằng OTP');
    const phone = normalizePhone(ctx.body.phone);
    if (!phone) throw bad('Số điện thoại không hợp lệ');
    if (!(await db.rateLimit('otp:' + phone, 3, 600)) || !(await db.rateLimit('otpip:' + ctx.ip, 20, 3600))) throw new HttpError(429, 'Bạn đã yêu cầu quá nhiều mã, thử lại sau');
    const user = await db.get("SELECT * FROM users WHERE phone = ? AND status='active'", phone);
    // Không tiết lộ số điện thoại có tồn tại hay không
    if (user) {
      const code = randomDigits(6);
      await db.run(`INSERT INTO otp_codes(phone, code_hash, expires_at) VALUES (?,?,datetime('now','+5 minutes'))
                  ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, created_at=datetime('now')`,
        phone, sha256(phone + ':' + code));
      await sendSms(config, phone, `[${config.companyShort}] Ma dang nhap he thong tai san: ${code}. Het han sau 5 phut.`);
    }
    return { ok: true, message: 'Nếu số điện thoại đã được đăng ký, mã OTP sẽ được gửi qua SMS.' };
  });

  api.post('/api/auth/otp/verify', null, async (ctx) => {
    if (!otpOn) throw new HttpError(404, 'Chưa bật đăng nhập bằng OTP');
    const phone = normalizePhone(ctx.body.phone);
    const code = String(ctx.body.code || '').trim();
    const row = phone && await db.get("SELECT * FROM otp_codes WHERE phone = ? AND expires_at > datetime('now')", phone);
    if (!row || row.attempts >= 5) throw new HttpError(401, 'Mã OTP không đúng hoặc đã hết hạn');
    if (row.code_hash !== sha256(phone + ':' + code)) {
      await db.run('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = ?', phone);
      throw new HttpError(401, 'Mã OTP không đúng hoặc đã hết hạn');
    }
    await db.run('DELETE FROM otp_codes WHERE phone = ?', phone);
    const user = await db.get("SELECT * FROM users WHERE phone = ? AND status='active'", phone);
    if (!user) throw new HttpError(401, 'Tài khoản không hợp lệ');
    await startSession(ctx, user, 'otp');
    return { ok: true, mustChangePassword: !!user.must_change_password && !!user.password_hash };
  });

  api.post('/api/auth/logout', null, async (ctx) => {
    if (ctx.cookies.sbtt_sid) await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(ctx.cookies.sbtt_sid));
    setCookie(ctx.res, 'sbtt_sid', '', { maxAge: 0, secure: config.production });
    return { ok: true };
  });

  api.get('/api/auth/me', 'auth', (ctx) => {
    const { user, perms, allLocations, locationIds } = ctx.access;
    const pending = !!user.must_change_password; // chưa kích hoạt: không trả SĐT/email (dùng để xác minh khi đổi mật khẩu)
    return {
      user: { id: user.id, full_name: user.full_name, email: pending ? null : user.email, phone: pending ? null : user.phone, employee_code: user.employee_code,
        verify_phone: pending && !!user.phone,
        role_code: user.role_code, role_name: user.role_name, department: user.department, must_change_password: !!user.must_change_password },
      permissions: [...perms], allLocations, locationIds,
    };
  });

  api.post('/api/auth/change-password', 'auth', async (ctx) => {
    const { current, next } = ctx.body;
    const user = await db.get('SELECT * FROM users WHERE id = ?', ctx.access.user.id);
    if (!(await db.rateLimit('pwchange:' + user.id, 10, 900))) throw new HttpError(429, 'Thử quá nhiều lần, vui lòng đợi 15 phút');
    if (user.password_hash && !(await db.verifyPassword(current || '', user.password_hash))) throw bad('Mật khẩu hiện tại không đúng');
    // Kích hoạt lần đầu: phải xác nhận đúng SĐT đã đăng ký (mật khẩu tạm có thể đoán được)
    if (user.must_change_password && user.phone && normalizePhone(ctx.body.phone_confirm) !== user.phone) {
      await audit(ctx, 'activate_failed', 'user', user.id);
      throw bad('Số điện thoại xác nhận không đúng với số đã đăng ký');
    }
    const err = validatePassword(next);
    if (err) throw bad(err);
    if (String(next) === String(current) || (user.employee_code && String(next).toUpperCase() === user.employee_code.toUpperCase()))
      throw bad('Mật khẩu mới phải khác mật khẩu hiện tại và khác mã nhân viên');
    await db.run("UPDATE users SET password_hash = sbtt_hash_password(?), must_change_password = 0, updated_at = datetime('now') WHERE id = ?", String(next), user.id);
    // Đăng xuất các phiên khác
    await db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', user.id, sha256(ctx.cookies.sbtt_sid || ''));
    await db.resetRate('pwchange:' + user.id);
    await audit(ctx, 'change_password', 'user', user.id);
    return { ok: true };
  });

  // ---- Đăng nhập Google (Gmail / Google Workspace) qua OAuth 2.0 ----
  const redirectUri = () => `${config.publicBaseUrl}/auth/google/callback`;
  api.get('/auth/google', null, (ctx) => {
    if (!config.googleClientId) throw bad('Chưa cấu hình đăng nhập Google');
    const state = randomToken(16);
    setCookie(ctx.res, 'sbtt_gstate', state + '|' + safeNext(ctx.query.next), { maxAge: 600, secure: config.production });
    const qs = new URLSearchParams({ client_id: config.googleClientId, redirect_uri: redirectUri(), response_type: 'code',
      scope: 'openid email profile', state, prompt: 'select_account' });
    ctx.res.writeHead(302, { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + qs });
    ctx.res.end();
  });

  api.get('/auth/google/callback', null, async (ctx) => {
    const fail = (msg) => { ctx.res.writeHead(302, { Location: '/login?error=' + encodeURIComponent(msg) }); ctx.res.end(); };
    const [state, next = '/'] = String(ctx.cookies.sbtt_gstate || '').split('|');
    setCookie(ctx.res, 'sbtt_gstate', '', { maxAge: 0, secure: config.production });
    if (!state || state !== ctx.query.state || !ctx.query.code) return fail('Phiên đăng nhập Google không hợp lệ');
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: ctx.query.code, client_id: config.googleClientId, client_secret: config.googleClientSecret,
        redirect_uri: redirectUri(), grant_type: 'authorization_code' }),
    });
    if (!r.ok) return fail('Không xác thực được với Google');
    const tok = await r.json();
    // id_token nhận trực tiếp từ Google qua TLS nên có thể đọc payload (theo hướng dẫn OpenID của Google)
    const payload = JSON.parse(Buffer.from(String(tok.id_token).split('.')[1], 'base64url').toString('utf8'));
    if (payload.aud !== config.googleClientId || !payload.email_verified) return fail('Email Google chưa được xác minh');
    const email = String(payload.email).toLowerCase();
    if (config.googleAllowedDomains.length && !config.googleAllowedDomains.includes(email.split('@')[1]))
      return fail('Email không thuộc domain được phép');
    const user = await db.get('SELECT * FROM users WHERE google_sub = ? OR email = ?', payload.sub, email);
    if (!user) return fail(`Email ${email} chưa được cấp tài khoản. Liên hệ quản trị viên.`);
    if (user.status !== 'active') return fail('Tài khoản đã bị khoá');
    if (!user.google_sub) await db.run('UPDATE users SET google_sub = ? WHERE id = ?', payload.sub, user.id);
    // Đăng nhập bằng Google không cần đổi mật khẩu lần đầu
    await db.run('UPDATE users SET must_change_password = 0 WHERE id = ? AND password_hash IS NULL', user.id);
    await startSession(ctx, user, 'google');
    ctx.res.writeHead(302, { Location: safeNext(next) });
    ctx.res.end();
  });
}

async function sendSms(config, phone, text) {
  if (config.smsProvider === 'webhook' && config.smsWebhookUrl) {
    // Gọi tới dịch vụ SMS/Zalo ZNS của công ty (eSMS, SpeedSMS, Viettel...) qua webhook trung gian
    const r = await fetch(config.smsWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.smsWebhookToken}` },
      body: JSON.stringify({ phone, text }),
    });
    if (!r.ok) throw new HttpError(502, 'Không gửi được SMS, vui lòng thử lại');
  } else {
    console.log(`[OTP] ${phone}: ${text}`);
  }
}
