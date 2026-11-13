# Hệ thống Quản lý tài sản tập trung – Công ty Cổ phần Sói Biển Trung Thực

Ứng dụng web dùng chung cho **Văn phòng, Kho tổng, Kho IT, Kho Hành chính và 37 cửa hàng**: một cơ sở dữ liệu tập trung, phân quyền tới từng chức danh, từng người dùng và từng thao tác nghiệp vụ, đăng nhập bằng Gmail / số điện thoại, in nhãn **mã QR** dán lên tủ đông, tủ mát và thiết bị lớn.

- Chạy trên **Cloudflare Workers** (giao diện + API) với CSDL **Supabase PostgreSQL** (qua Hyperdrive); mã nguồn trên **GitHub**.
- Chỉ 1 thư viện chạy thật: `postgres` (driver PostgreSQL). Cần **Node.js ≥ 22.13** để chạy thử trên máy.
- Giao diện tiếng Việt, dùng được trên máy tính và điện thoại (quét QR mở thẳng trang tài sản).
- Đã có bộ kiểm thử tự động (`npm test`, 15 kịch bản, chạy trên PostgreSQL thật trong bộ nhớ).

---

## 1. Chạy thử trên máy

```bash
npm install
npm run dev:db     # cửa sổ 1: PostgreSQL thử trong bộ nhớ + dữ liệu mẫu (125 tài sản, 8 người dùng – mật khẩu Demo@2026)
```
```bash
# cửa sổ 2 (PowerShell): chạy Worker giống hệt trên Cloudflare
$env:CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://postgres:postgres@127.0.0.1:54329/postgres"
npx wrangler dev --var PUBLIC_BASE_URL:http://localhost:8787
```

Mở `http://localhost:8787`, đăng nhập **tp.baotri.demo@gmail.com / Demo@2026** hoặc **admin@soibien.vn / SoiBien@2026** (admin bắt buộc đổi mật khẩu lần đầu). Dữ liệu thử mất khi tắt cửa sổ 1.

| Tài khoản mẫu | Chức danh | Phạm vi |
|---|---|---|
| tp.baotri.demo@gmail.com | Trưởng phòng Bảo trì | Toàn hệ thống |
| kt1.demo@gmail.com | NV Bảo trì hạ tầng | Toàn hệ thống |
| it.demo@gmail.com | NV IT Help desk | Toàn hệ thống |
| ketoan.demo@gmail.com | Kế toán tài sản | Toàn hệ thống |
| thukho.demo@gmail.com | Thủ kho | K02, K03 |
| 0911000006 | Cửa hàng trưởng | S08 |
| 0911000007 | Nhân viên cửa hàng | S08 |
| 0911000008 | Quản lý vùng | 6 cửa hàng đầu danh sách |

> Khi đưa vào dùng thật, **không** chạy `npm run demo` trên CSDL Supabase thật.

---

## 2. Kiến trúc

```
 Điện thoại / máy tính (trình duyệt)          Quét QR trên tủ  ──►  https://taisan.soibien.vn/q/<mã>
            │  HTTPS
            ▼
 ┌──────────────────────── Cloudflare (tên miền soibien.vn) ───────────────────┐
 │  Static Assets  public/  Giao diện SPA + public/qr.js (trình duyệt tự vẽ QR) │
 │  Worker  server/worker.js → app.js   (chỉ chạy cho /api/* /auth/* /print/*)  │
 │    server/rbac.js   Danh mục quyền · chức danh mặc định · phạm vi địa điểm    │
 │    routes/auth        Mật khẩu (email/SĐT/mã NV) · OTP SMS · Google OAuth     │
 │    routes/assets      Tài sản · ẩn/hiện trường theo quyền · nhãn QR · CSV     │
 │    routes/operations  Bảo trì · kế hoạch năm · sự cố · điều chuyển · tổng quan│
 │    routes/admin       Địa điểm · loại TS · chức danh · người dùng · nhật ký   │
 │  Hyperdrive  giữ sẵn kết nối tới Supabase (giảm độ trễ)                       │
 └──────────────────────────────┬──────────────────────────────────────────────┘
                                ▼
            Supabase PostgreSQL (server/schema.pg.sql) – sao lưu tự động hằng ngày
            + npm run backup (xuất JSON, giữ 30 bản)
```

**Tối ưu cho gói Workers miễn phí (10 ms CPU / request):**
- Băm mật khẩu (bcrypt) chạy **trong PostgreSQL** (`pgcrypto`), không tốn CPU Worker.
- Mã QR được **trình duyệt tự vẽ** (`public/qr.js`), Worker chỉ trả về đường dẫn.
- Giao diện tĩnh do Cloudflare CDN phục vụ, không chạy Worker.
- Mỗi request dùng 1 kết nối CSDL qua Hyperdrive; các truy vấn song song được gửi nối tiếp trên kết nối đó.
- Giới hạn đăng nhập sai (8 lần/15 phút) lưu trong bộ nhớ của từng Worker nên chỉ mang tính tương đối.

### Mô hình dữ liệu chính

| Bảng | Nội dung |
|---|---|
| `locations` | Địa điểm: `office`, `warehouse`, `warehouse_it`, `warehouse_admin`, `store` – mã theo công ty: K00 Văn phòng, K01 Kho hạ tầng, K02 Kho Tân Triều, K03 Kho IT, K04 Kho Hành chính, S01…S81 (danh sách trong `server/seed-data.js`) |
| `roles`, `permissions`, `role_permissions` | Chức danh và thao tác nghiệp vụ được phép |
| `users`, `user_locations`, `user_permission_overrides` | Người dùng, phạm vi địa điểm, ngoại lệ quyền (cấp thêm / thu hồi) |
| `asset_categories` | Nhóm tài sản theo quy ước mã công ty (DL, DH, KE, NT, IT, KS, DC, TB, CC) + chu kỳ bảo trì & thời gian sử dụng mặc định. Mã tài sản mới tự sinh dạng `S08-DL-26-00001` |
| `assets` | Tài sản: thông tin chung · kế toán · bảo trì/bảo hành · mã QR |
| `maintenance_records` | Lịch sử bảo trì, sửa chữa, kiểm tra, bảo hành + chi phí |
| `incidents` | Báo hỏng / sự cố (từ quét QR hoặc trên hệ thống) |
| `transfers` | Đề nghị điều chuyển giữa các địa điểm, có duyệt |
| `audit_logs` | Nhật ký mọi thao tác: ai, lúc nào, thay đổi gì, IP |

---

## 3. Phân quyền – 3 lớp

1. **Chức danh (vị trí công việc)** → bộ quyền mặc định. Có 11 chức danh mẫu: Quản trị hệ thống, Ban Giám đốc, Trưởng phòng Bảo trì, NV Bảo trì hạ tầng, NV IT Help desk, Kế toán tài sản, Thủ kho, NV Hành chính, Quản lý vùng, Cửa hàng trưởng, NV cửa hàng. Thêm/sửa trên giao diện *Chức danh & phân quyền* (có ma trận tổng hợp).
2. **Người dùng** → có thể *cấp thêm* hoặc *thu hồi* từng quyền so với chức danh.
3. **Phạm vi địa điểm** → chức danh/người dùng "toàn hệ thống" hoặc danh sách địa điểm được giao. Mọi truy vấn dữ liệu đều lọc theo phạm vi này ở phía máy chủ.

**27 thao tác nghiệp vụ** được kiểm soát, gồm: xem/thêm/sửa/xoá tài sản, đổi trạng thái, nhập/xuất file, in nhãn QR, xem/sửa thông tin kế toán, xem/ghi bảo trì, sửa kế hoạch bảo trì & bảo hành, báo hỏng, xử lý sự cố, đề nghị/duyệt điều chuyển, quản lý địa điểm, loại tài sản, người dùng, chức danh, xem nhật ký, báo cáo.

**Phân quyền tới từng nhóm thông tin của tài sản:**

| Nhóm thông tin | Xem | Sửa |
|---|---|---|
| Thông tin chung (tên, vị trí, người quản lý, serial, NCC…) | `asset.view` | `asset.update` |
| Kế toán (mã TS kế toán, nguyên giá, TK, khấu hao, giá trị còn lại) | `accounting.view` | `accounting.update` |
| Bảo trì & bảo hành (chu kỳ, lịch, đơn vị, bảo hành, lịch sử) | `maintenance.view` | `maintenance.plan` |
| Trạng thái (hỏng, thanh lý, mất…) | `asset.view` | `asset.status` |
| Địa điểm | `asset.view` | chỉ qua *Điều chuyển* (`transfer.request` → `transfer.approve`) |

**Chống leo thang quyền:** người quản lý người dùng chỉ được trao những quyền chính mình đang có, không sửa được tài khoản có quyền cao hơn, không cấp phạm vi rộng hơn phạm vi của mình.

---

## 4. Đăng nhập

| Cách | Ghi chú |
|---|---|
| Email (Gmail) + mật khẩu | Mật khẩu ≥ 8 ký tự có chữ và số; bắt buộc đổi ở lần đầu / sau khi đặt lại |
| Số điện thoại + mật khẩu | Chấp nhận `09…`, `+84 9…`, `84 9…` |
| Số điện thoại + **OTP SMS** | Mã 6 số, hiệu lực 5 phút, tối đa 5 lần nhập sai, giới hạn 3 lần gửi/10 phút |
| **Đăng nhập Google** | Bật khi khai báo `GOOGLE_CLIENT_ID/SECRET`; chỉ email đã được cấp tài khoản mới vào được |

**Bảo mật**
- Mật khẩu băm bcrypt trong PostgreSQL (`pgcrypto`); phiên lưu trong CSDL, cookie HttpOnly + SameSite + Secure (production); khoá tài khoản = thu hồi mọi phiên ngay.
- **Mật khẩu tạm = mã nhân viên** → lần đăng nhập đầu phải **xác nhận đúng SĐT đã đăng ký** mới đặt được mật khẩu mới; tài khoản chưa kích hoạt không xem được dữ liệu nào (kể cả danh sách người dùng) và mật khẩu mới không được trùng mã NV.
- Chống dò mật khẩu: 8 lần/15 phút theo tài khoản, 50 lần/15 phút theo IP – bộ đếm lưu trong CSDL (bảng `rate_limits`), đúng cả khi chạy nhiều Worker.
- Chống CSRF bằng header `X-SBTT` (không mở CORS); CSP chỉ cho chạy script của chính website; HSTS; API qua http:// tự chuyển sang https://.
- Supabase: bật RLS mọi bảng, thu hồi quyền gọi hàm của khoá anon/authenticated; Hyperdrive **tắt cache** (khoá tài khoản/đăng xuất có hiệu lực ngay).
- SĐT người dùng chỉ trả cho người có quyền `user.view`; xuất CSV chống chèn công thức Excel; OTP tự tắt khi chưa cấu hình nhà cung cấp SMS.

### Cấu hình Google Sign-In
1. Google Cloud Console → *APIs & Services* → *Credentials* → *Create OAuth client ID* → loại **Web application**.
2. *Authorized redirect URIs*: `https://taisan.soibien.vn/auth/google/callback` (thay bằng tên miền thật).
3. Ghi `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` vào `.env`. Tuỳ chọn `GOOGLE_ALLOWED_DOMAINS=gmail.com,soibien.vn`.

### Cấu hình gửi OTP SMS
Mặc định `SMS_PROVIDER=console` (mã OTP in ra log – dùng thử). Khi dùng thật đặt `SMS_PROVIDER=webhook`, `SMS_WEBHOOK_URL`, `SMS_WEBHOOK_TOKEN`; hệ thống gửi `POST {"phone","text"}` tới webhook – nối webhook đó với nhà cung cấp SMS/Zalo ZNS của công ty (eSMS, SpeedSMS, Viettel…).

---

## 5. Mã QR cho tủ đông, tủ mát, thiết bị lớn

- Mỗi tài sản có **mã QR riêng, khó đoán** (`/q/<10 ký tự>`), không dùng mã tài sản để tránh bị dò.
- **In nhãn**: chọn tài sản (hoặc lọc theo cửa hàng) → *In nhãn QR*. 3 khổ: 50×30, 70×50, 100×70 mm; mức sửa lỗi Q (~25%) – nhãn trầy xước vẫn quét được. Nên in decal PVC/giấy chống nước cho tủ lạnh.
- **Quét bằng camera điện thoại** (không cần cài app):
  - Chưa đăng nhập: thấy mã, tên, địa điểm, trạng thái, hotline bảo trì.
  - Đã đăng nhập & trong phạm vi: thấy theo quyền – người quản lý & SĐT, bảo trì/bảo hành, lịch sử sửa chữa, kế toán (nếu có quyền) + nút **Báo hỏng**, **Ghi bảo trì**, **Gọi người quản lý**.
  - Ngoài phạm vi địa điểm: chỉ thông tin cơ bản.
- **Cấp lại QR** khi nhãn mất/hỏng: nhãn cũ bị vô hiệu ngay.

---

## 6. Các chức năng khác

- **Bảng tổng quan**: tài sản theo nhóm/địa điểm/mức quan trọng, hỏng – đang sửa, bảo trì quá hạn/đến hạn, bảo hành sắp hết, chi phí bảo trì tháng, tổng nguyên giá & giá trị còn lại.
- **Kế hoạch bảo trì năm**: lưới 12 tháng × thiết bị (○ kế hoạch, ● đã làm, viền đỏ = trễ), lọc theo cửa hàng/nhóm, in được.
- **Sự cố**: tiếp nhận → giao người → ghi sửa chữa → đóng sự cố.
- **Điều chuyển**: đề nghị → duyệt/từ chối → tự cập nhật địa điểm và người quản lý.
- **Nhập CSV** (có bước *Kiểm tra* trước khi lưu; mã đã tồn tại thì cập nhật) và **Xuất CSV** (cột kế toán chỉ có khi có quyền).
- **Nhật ký hệ thống**: mọi đăng nhập, tạo/sửa/xoá, quét QR, in nhãn, xuất file.

---

## 7. Triển khai thật

### Cách chính – Cloudflare Workers + Supabase + GitHub

**Bước 1 – Supabase: lấy chuỗi kết nối & tạo bảng**
1. Supabase → project → nút **Connect** → chọn **Session pooler** (cổng 5432, chạy được trên mạng IPv4) → sao chép chuỗi `postgresql://postgres.xxxx:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`.
2. Trên máy: `copy .env.example .env`, mở `.env`, dán chuỗi vào `DATABASE_URL` (thay `[YOUR-PASSWORD]` bằng mật khẩu CSDL), đặt `ADMIN_EMAIL`, `ADMIN_PASSWORD`.
3. Chạy `npm install` rồi `npm run db:setup` → tạo bảng, nạp 41 địa điểm, loại tài sản, 11 chức danh và tài khoản admin.

**Bước 2 – Cloudflare: Hyperdrive, tên miền, đưa lên mạng**
1. `npx wrangler login` (mở trình duyệt, đăng nhập Cloudflare).
2. `npx wrangler hyperdrive create taisan-db --connection-string="<chuỗi kết nối ở bước 1>"` → sao chép **id** nhận được, dán vào `wrangler.jsonc` thay `THAY_BANG_HYPERDRIVE_ID`.
3. Tên miền `soibien.vn` phải nằm trong tài khoản Cloudflare (Add a domain → đổi nameserver tại nhà đăng ký tên miền). Khi đó Worker tự gắn `taisan.soibien.vn` và cấp HTTPS.
4. (Tuỳ chọn) biến bí mật: `npx wrangler secret put GOOGLE_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `SMS_WEBHOOK_TOKEN`…; sửa `MAINTENANCE_HOTLINE` trong `wrangler.jsonc`.
5. `npx wrangler deploy` → mở `https://taisan.soibien.vn`.

**Bước 3 – GitHub: tự động triển khai**
1. Đẩy mã nguồn lên repo riêng tư `sbtt-quan-ly-tai-san` (file `.env` và thư mục `data/` đã bị loại trừ bởi `.gitignore`).
2. Cloudflare → Workers & Pages → `taisan-soibien` → **Settings → Builds → Connect** → chọn repo, nhánh `main`, Deploy command `npx wrangler deploy`.
3. Từ đó mỗi lần đẩy code lên `main`, Cloudflare tự triển khai bản mới.

**Khi thay đổi danh mục quyền / cấu trúc bảng**: chạy lại `npm run db:setup` (an toàn, không mất dữ liệu).

**Sao lưu**: Supabase tự sao lưu hằng ngày (gói Free giữ ít ngày; gói Pro giữ 7 ngày). Thêm 1 bản riêng: `npm run backup` → `backup/sbtt-asset-*.json`, chép sang Google Drive/NAS.

> **Lưu ý gói miễn phí:** project Supabase Free bị **tạm dừng nếu 7 ngày không có truy cập**; Worker Free giới hạn 100.000 request/ngày và 10 ms CPU/request (ứng dụng đã được tối ưu cho giới hạn này).

### Cách dự phòng – máy chủ riêng (Node.js / Docker)
```bash
cp .env.example .env      # DATABASE_URL, PUBLIC_BASE_URL, ...
npm ci --omit=dev && npm run db:setup && npm start     # hoặc: docker compose up -d (kèm Caddy tự cấp HTTPS)
```

### Quy trình đưa vào sử dụng
1. Đăng nhập admin, đổi mật khẩu → kiểm tra tên/địa chỉ cửa hàng trong *Địa điểm* (đã nạp sẵn theo danh sách bộ phận của công ty).
2. Rà soát *Chức danh & phân quyền* cho đúng quy định công ty.
3. Tạo người dùng (gán chức danh + cửa hàng).
4. Tải file mẫu → kiểm kê → nhập danh mục tài sản từ CSV.
5. In nhãn QR theo từng cửa hàng → dán lên tủ đông, tủ mát, điều hoà, tủ điện…
6. Hướng dẫn cửa hàng: thấy hỏng → quét QR → *Báo hỏng*.

---

## 8. Cấu trúc thư mục
```
wrangler.jsonc   Cấu hình Cloudflare Workers (tên miền, Hyperdrive, biến môi trường)
server/   worker.js (điểm vào Cloudflare) · index.js (điểm vào Node.js) · app.js · config.js
          db.js (PostgreSQL) · schema.pg.sql · setup.js · rbac.js · security.js · http.js · qr.js
          routes/ auth.js · assets.js · operations.js · admin.js
          (schema.sql: bản SQLite cũ, không còn dùng)
public/   index.html · app.js · qr.js · styles.css · _headers · icon.svg · manifest.webmanifest
scripts/  db-setup.js · dev-db.js · seed-demo.js · backup.js
test/     api.test.js
```

## 9. Hướng phát triển tiếp
- Đính kèm ảnh khi báo hỏng (chụp tủ, nhiệt kế) – cần thêm lưu trữ file.
- Gửi thông báo Zalo/Gapo cho đội bảo trì khi có sự cố mức Cao/Khẩn cấp.
- Kiểm kê định kỳ bằng quét QR (đối chiếu sổ sách – thực tế).
- Đồng bộ mã tài sản với phần mềm kế toán.
