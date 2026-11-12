// Tạo DỮ LIỆU MẪU để chạy thử (KHÔNG chạy trên CSDL thật).
// Cách dùng: đặt DATABASE_URL trỏ tới CSDL thử nghiệm rồi chạy npm run demo
import { db, tx, createSql, setDefaultSql, newQrToken, nextAssetCode } from '../server/db.js';
import { setupDatabase } from '../server/setup.js';
import { config } from '../server/config.js';

if (!config.databaseUrl) { console.error('Thiếu DATABASE_URL trong .env'); process.exit(1); }
const sql = createSql(config.databaseUrl, { max: 1 });
setDefaultSql(sql);

try {
  await setupDatabase();
  if ((await db.get('SELECT COUNT(*) n FROM assets')).n > 0) { console.log('CSDL đã có tài sản – bỏ qua tạo dữ liệu mẫu.'); }
  else await seed();
} finally {
  await sql.end();
}

async function seed() {
  const role = async (code) => (await db.get('SELECT id FROM roles WHERE code=?', code)).id;
  // Ánh xạ mã mẫu -> mã thật của hệ thống (CHxx = cửa hàng thứ xx trong danh sách)
  const STORES = (await db.all("SELECT code FROM locations WHERE type='store' ORDER BY code")).map((r) => r.code);
  const LOC_MAP = { VP: 'K00', KHO: 'K02', KHO_IT: 'K03', KHO_HC: 'K04' };
  const locCode = (c) => LOC_MAP[c] || (c.startsWith('CH') ? STORES[Number(c.slice(2)) - 1] : c);
  const CAT_MAP = { TU_DONG: 'DL', TU_MAT: 'DL', KHO_LANH: 'DL', DIEU_HOA: 'DH', MAY_TINH: 'IT', MAY_IN: 'IT', MANG: 'IT', CAN: 'TB', CUA_CUON: 'TB', TU_DIEN: 'TB', MAY_PHAT: 'TB' };
  const loc = async (code) => (await db.get('SELECT id FROM locations WHERE code=?', locCode(code))).id;
  const cat = async (code) => { const c = await db.get('SELECT * FROM asset_categories WHERE code=?', CAT_MAP[code] || code); return { ...c, maintenance_cycle_days: c.maintenance_cycle_days || 180 }; };
  const pw = (await db.get("SELECT sbtt_hash_password('Demo@2026') h")).h;
  const day = (offset) => new Date(Date.now() + 7 * 3600e3 + offset * 864e5).toISOString().slice(0, 10);

  await tx(db, async () => {
    const users = [
      ['DEMO01', 'Trưởng phòng Bảo trì (mẫu)', 'tp.baotri.demo@gmail.com', '0911000001', 'TP_BT', 'Bảo trì', []],
      ['DEMO02', 'Kỹ thuật bảo trì 1 (mẫu)', 'kt1.demo@gmail.com', '0911000002', 'NV_BT', 'Bảo trì', []],
      ['DEMO03', 'IT Help desk (mẫu)', 'it.demo@gmail.com', '0911000003', 'NV_IT', 'Bảo trì', []],
      ['DEMO04', 'Kế toán tài sản (mẫu)', 'ketoan.demo@gmail.com', '0911000004', 'KT_TS', 'Kế toán', []],
      ['DEMO05', 'Thủ kho tổng (mẫu)', 'thukho.demo@gmail.com', '0911000005', 'THU_KHO', 'Kho', ['KHO', 'KHO_IT']],
      ['DEMO06', `Cửa hàng trưởng ${locCode('CH05')} (mẫu)`, 'cht05.demo@gmail.com', '0911000006', 'CHT', 'Cửa hàng', ['CH05']],
      ['DEMO07', `Nhân viên ${locCode('CH05')} (mẫu)`, null, '0911000007', 'NV_CH', 'Cửa hàng', ['CH05']],
      ['DEMO08', 'Quản lý vùng 1 (mẫu)', 'qlv1.demo@gmail.com', '0911000008', 'QL_VUNG', 'Vận hành', ['CH01', 'CH02', 'CH03', 'CH04', 'CH05', 'CH06']],
    ];
    const ids = {};
    for (const [code, name, email, phone, r, dept, locs] of users) {
      const id = Number((await db.run('INSERT INTO users(employee_code, full_name, email, phone, password_hash, role_id, department, must_change_password) VALUES (?,?,?,?,?,?,?,0)',
        code, name, email, phone, pw, await role(r), dept)).lastInsertRowid);
      ids[code] = id;
      for (const l of locs) await db.run('INSERT INTO user_locations(user_id, location_id) VALUES (?,?)', id, await loc(l));
    }

    const INS_A = `INSERT INTO assets(asset_code, qr_token, name, category_id, location_id, area, custodian_user_id, brand, model, serial_no, status, criticality,
      purchase_date, in_service_date, original_cost, useful_life_months, accounting_type, accounting_account, accounting_code, supplier, warranty_until, warranty_provider,
      maintenance_cycle_days, last_maintenance_date, next_maintenance_date, maintenance_vendor, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`;
    const models = {
      TU_DONG: [['Tủ đông Sanaky 500L', 'Sanaky', 'VH-5699HY', 12500000], ['Tủ đông Alaska 400L', 'Alaska', 'HB-550C', 9800000]],
      TU_MAT: [['Tủ mát 2 cánh Sanaky 800L', 'Sanaky', 'VH-8009HP', 18500000], ['Tủ mát Alaska 1 cánh', 'Alaska', 'LC-633H', 8200000]],
      DIEU_HOA: [['Điều hoà Daikin 18000BTU', 'Daikin', 'FTKB50WAVMV', 16900000]],
      CUA_CUON: [['Cửa cuốn Austdoor', 'Austdoor', 'S50i', 14000000]],
      MAY_TINH: [['Máy POS bán hàng', 'Sunmi', 'T2s', 11500000]],
      MAY_IN: [['Máy in bill Xprinter', 'Xprinter', 'XP-Q80I', 1650000]],
      CAN: [['Cân điện tử in tem', 'Digi', 'SM-120', 22000000]],
      TU_DIEN: [['Tủ điện tổng cửa hàng', 'Schneider', 'MCCB 100A', 7500000]],
    };
    let n = 0;
    const custodian = { CH05: ids.DEMO06 };
    const statuses = ['in_use', 'in_use', 'in_use', 'in_use', 'in_use', 'in_use', 'under_repair', 'broken'];
    for (let s = 1; s <= 12; s++) {
      const lc = `CH${String(s).padStart(2, '0')}`;
      for (const [cc, list] of Object.entries(models)) {
        const qty = cc === 'TU_DONG' || cc === 'TU_MAT' ? 2 : 1;
        for (let q = 0; q < qty; q++) {
          const [name, brand, model, cost] = list[(s + q) % list.length];
          const c = await cat(cc);
          const purchase = day(-((s * 97 + q * 211 + n * 13) % 1400) - 30);
          const last = day(-((s * 11 + n * 7) % 120) - 1);
          const next = c.maintenance_cycle_days ? day(-((s * 11 + n * 7) % 120) - 1 + c.maintenance_cycle_days) : null;
          await db.run(INS_A, await nextAssetCode(db, c.code, locCode(lc)), await newQrToken(), name, c.id, await loc(lc), cc === 'TU_DONG' || cc === 'TU_MAT' ? 'Khu trưng bày' : null, custodian[lc] ?? null,
            brand, model, `SN${100000 + n * 37}`, statuses[n % statuses.length], ['TU_DONG', 'TU_MAT', 'TU_DIEN'].includes(cc) ? 'A' : cc === 'MAY_IN' ? 'C' : 'B',
            purchase, purchase, cost, c.useful_life_months, cost >= 30000000 ? 'TSCD' : 'CCDC', cost >= 30000000 ? '211' : '242', `KT-${2024}-${String(n + 1).padStart(4, '0')}`,
            'Điện máy mẫu', day(-((s * 97 + q * 211 + n * 13) % 1400) - 30 + 730), brand + ' Việt Nam', c.maintenance_cycle_days, last, next, 'Đội bảo trì nội bộ');
          n++;
        }
      }
    }
    for (const [lc, items] of Object.entries({ KHO_IT: [['MAY_TINH', 'Laptop Dell Latitude 3440', 'Dell', 'Latitude 3440', 15900000], ['MANG', 'Switch TP-Link 24 port', 'TP-Link', 'TL-SG1024D', 1900000]], VP: [['DIEU_HOA', 'Điều hoà phòng họp', 'Panasonic', 'CU/CS-XPU24', 21000000], ['MAY_PHAT', 'Máy phát điện văn phòng', 'Honda', 'EP6500', 45000000]], KHO: [['KHO_LANH', 'Kho lạnh trung tâm', 'Bitzer', 'Cụm máy nén 10HP', 350000000]] })) {
      for (const [cc, name, brand, model, cost] of items) {
        const c = await cat(cc);
        await db.run(INS_A, await nextAssetCode(db, c.code, locCode(lc)), await newQrToken(), name, c.id, await loc(lc), null, null, brand, model, `SN${900000 + n}`, 'in_use', cc === 'KHO_LANH' || cc === 'MAY_PHAT' ? 'A' : 'B',
          day(-400), day(-400), cost, c.useful_life_months, cost >= 30000000 ? 'TSCD' : 'CCDC', cost >= 30000000 ? '211' : '242', `KT-2025-${String(n + 1).padStart(4, '0')}`,
          'NCC mẫu', day(330), brand, c.maintenance_cycle_days, day(-20), c.maintenance_cycle_days ? day(-20 + c.maintenance_cycle_days) : null, 'Đội bảo trì nội bộ');
        n++;
      }
    }
    // Một vài sự cố, bảo trì mẫu
    const a1 = (await db.get("SELECT id FROM assets WHERE status='broken' LIMIT 1")).id;
    await db.run('INSERT INTO incidents(asset_id, title, description, severity, reported_by) VALUES (?,?,?,?,?)', a1, 'Tủ không lạnh, nhiệt độ lên 5°C', 'Phát hiện lúc mở ca sáng', 'high', ids.DEMO06);
    const a2 = (await db.get('SELECT id FROM assets WHERE location_id=? LIMIT 1', await loc('CH05'))).id;
    await db.run('INSERT INTO maintenance_records(asset_id, type, performed_date, performed_by, description, result, cost, created_by) VALUES (?,?,?,?,?,?,?,?)', a2, 'preventive', day(-10), 'Kỹ thuật bảo trì 1 (mẫu)', 'Vệ sinh dàn nóng, kiểm tra gas, kiểm tra ron cửa', 'Đạt', 350000, ids.DEMO02);
    console.log(`Đã tạo ${Object.keys(ids).length} người dùng mẫu (mật khẩu Demo@2026) và ${n} tài sản mẫu.`);
  });
}
