-- =====================================================================
-- CSDL tập trung – Hệ thống Quản lý tài sản Sói Biển Trung Thực
-- =====================================================================
PRAGMA foreign_keys = ON;

-- Địa điểm: văn phòng, kho tổng, kho IT, kho hành chính, 37 cửa hàng
CREATE TABLE IF NOT EXISTS locations (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('office','warehouse','warehouse_it','warehouse_admin','store')),
  address       TEXT,
  region        TEXT,
  phone         TEXT,
  manager_user_id INTEGER REFERENCES users(id),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Danh mục quyền (thao tác nghiệp vụ)
CREATE TABLE IF NOT EXISTS permissions (
  code    TEXT PRIMARY KEY,
  module  TEXT NOT NULL,
  name    TEXT NOT NULL,
  sort    INTEGER NOT NULL DEFAULT 0
);

-- Chức danh / vị trí công việc (vai trò)
CREATE TABLE IF NOT EXISTS roles (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  department  TEXT,
  description TEXT,
  all_locations INTEGER NOT NULL DEFAULT 0, -- chức danh được xem mọi địa điểm
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id         INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  employee_code   TEXT UNIQUE,
  full_name       TEXT NOT NULL,
  email           TEXT UNIQUE COLLATE NOCASE,
  phone           TEXT UNIQUE,
  password_hash   TEXT,
  role_id         INTEGER NOT NULL REFERENCES roles(id),
  department      TEXT,
  all_locations   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked')),
  must_change_password INTEGER NOT NULL DEFAULT 1,
  google_sub      TEXT UNIQUE,
  last_login_at   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

-- Phạm vi địa điểm của từng người dùng
CREATE TABLE IF NOT EXISTS user_locations (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, location_id)
);

-- Ngoại lệ quyền theo người dùng: cấp thêm (grant) hoặc thu hồi (deny) so với chức danh
CREATE TABLE IF NOT EXISTS user_permission_overrides (
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  effect          TEXT NOT NULL CHECK (effect IN ('grant','deny')),
  PRIMARY KEY (user_id, permission_code)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  method      TEXT
);

CREATE TABLE IF NOT EXISTS otp_codes (
  phone       TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Loại tài sản
CREATE TABLE IF NOT EXISTS asset_categories (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  grp         TEXT NOT NULL, -- Lạnh, Điện, IT, Hành chính, Hạ tầng...
  maintenance_cycle_days INTEGER,
  useful_life_months     INTEGER,
  label_qr    INTEGER NOT NULL DEFAULT 1,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS assets (
  id                INTEGER PRIMARY KEY,
  asset_code        TEXT NOT NULL UNIQUE,
  qr_token          TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  category_id       INTEGER NOT NULL REFERENCES asset_categories(id),
  location_id       INTEGER NOT NULL REFERENCES locations(id),
  area              TEXT,      -- vị trí đặt trong địa điểm (khu quầy, kho lạnh...)
  custodian_user_id INTEGER REFERENCES users(id),
  brand             TEXT,
  model             TEXT,
  serial_no         TEXT,
  specs             TEXT,
  status            TEXT NOT NULL DEFAULT 'in_use'
                    CHECK (status IN ('in_use','in_storage','under_repair','broken','liquidated','lost')),
  criticality       TEXT NOT NULL DEFAULT 'B' CHECK (criticality IN ('A','B','C')),
  -- Kế toán
  accounting_code   TEXT,      -- mã TSCĐ/CCDC trên phần mềm kế toán
  accounting_type   TEXT CHECK (accounting_type IN ('TSCD','CCDC','KHAC')),
  accounting_account TEXT,     -- 211, 242, 153...
  cost_center       TEXT,
  purchase_date     TEXT,
  in_service_date   TEXT,
  original_cost     REAL,
  useful_life_months INTEGER,
  supplier          TEXT,
  invoice_no        TEXT,
  -- Bảo hành
  warranty_until    TEXT,
  warranty_provider TEXT,
  warranty_contact  TEXT,
  -- Bảo trì
  maintenance_cycle_days INTEGER,
  maintenance_vendor TEXT,
  last_maintenance_date TEXT,
  next_maintenance_date TEXT,
  notes             TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_assets_location ON assets(location_id);
CREATE INDEX IF NOT EXISTS ix_assets_category ON assets(category_id);
CREATE INDEX IF NOT EXISTS ix_assets_next_mt ON assets(next_maintenance_date);

CREATE TABLE IF NOT EXISTS maintenance_records (
  id            INTEGER PRIMARY KEY,
  asset_id      INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('preventive','corrective','inspection','warranty')),
  performed_date TEXT NOT NULL,
  performed_by  TEXT,
  vendor        TEXT,
  description   TEXT NOT NULL,
  result        TEXT,
  cost          REAL DEFAULT 0,
  ticket_ref    TEXT,
  incident_id   INTEGER REFERENCES incidents(id),
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_mt_asset ON maintenance_records(asset_id);

CREATE TABLE IF NOT EXISTS incidents (
  id            INTEGER PRIMARY KEY,
  asset_id      INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT,
  severity      TEXT NOT NULL DEFAULT 'normal' CHECK (severity IN ('low','normal','high','critical')),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','cancelled')),
  reported_by   INTEGER REFERENCES users(id),
  assigned_to   INTEGER REFERENCES users(id),
  resolution    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_inc_asset ON incidents(asset_id);

CREATE TABLE IF NOT EXISTS transfers (
  id               INTEGER PRIMARY KEY,
  asset_id         INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  from_location_id INTEGER NOT NULL REFERENCES locations(id),
  to_location_id   INTEGER NOT NULL REFERENCES locations(id),
  from_custodian_id INTEGER REFERENCES users(id),
  to_custodian_id  INTEGER REFERENCES users(id),
  reason           TEXT,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by     INTEGER REFERENCES users(id),
  decided_by       INTEGER REFERENCES users(id),
  decision_note    TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at       TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  detail     TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_logs(entity, entity_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
