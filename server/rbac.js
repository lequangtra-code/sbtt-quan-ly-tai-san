// Phân quyền: Chức danh (role) -> tập quyền mặc định; Người dùng -> cấp thêm / thu hồi từng quyền;
// Phạm vi dữ liệu theo địa điểm (toàn hệ thống hoặc danh sách địa điểm được giao).

export const PERMISSIONS = [
  // [code, module, name]
  ['dashboard.view', 'Tổng quan', 'Xem bảng tổng quan'],
  ['asset.view', 'Tài sản', 'Xem danh sách & chi tiết tài sản'],
  ['asset.create', 'Tài sản', 'Thêm tài sản mới'],
  ['asset.update', 'Tài sản', 'Sửa thông tin chung của tài sản'],
  ['asset.delete', 'Tài sản', 'Xoá tài sản'],
  ['asset.status', 'Tài sản', 'Đổi trạng thái (hỏng, thanh lý, mất...)'],
  ['asset.import', 'Tài sản', 'Nhập tài sản từ file CSV'],
  ['asset.export', 'Tài sản', 'Xuất danh sách tài sản'],
  ['asset.qr_print', 'Tài sản', 'In nhãn mã QR'],
  ['accounting.view', 'Kế toán', 'Xem thông tin kế toán (nguyên giá, khấu hao...)'],
  ['accounting.update', 'Kế toán', 'Sửa thông tin kế toán'],
  ['maintenance.view', 'Bảo trì', 'Xem lịch & lịch sử bảo trì, bảo hành'],
  ['maintenance.create', 'Bảo trì', 'Ghi nhận bảo trì / sửa chữa'],
  ['maintenance.plan', 'Bảo trì', 'Sửa chu kỳ & lịch bảo trì, thông tin bảo hành'],
  ['incident.create', 'Sự cố', 'Báo hỏng / báo sự cố tài sản'],
  ['incident.view', 'Sự cố', 'Xem danh sách sự cố'],
  ['incident.manage', 'Sự cố', 'Tiếp nhận, phân công, đóng sự cố'],
  ['transfer.request', 'Điều chuyển', 'Tạo đề nghị điều chuyển tài sản'],
  ['transfer.approve', 'Điều chuyển', 'Duyệt / từ chối điều chuyển'],
  ['location.view', 'Địa điểm', 'Xem danh sách địa điểm'],
  ['location.manage', 'Địa điểm', 'Thêm / sửa địa điểm'],
  ['category.manage', 'Danh mục', 'Quản lý loại tài sản'],
  ['user.view', 'Người dùng', 'Xem danh sách người dùng'],
  ['user.manage', 'Người dùng', 'Tạo / sửa / khoá người dùng, đặt lại mật khẩu'],
  ['role.manage', 'Phân quyền', 'Quản lý chức danh & phân quyền'],
  ['audit.view', 'Hệ thống', 'Xem nhật ký hệ thống'],
  ['report.view', 'Báo cáo', 'Xem báo cáo tổng hợp'],
];
export const ALL_PERMISSION_CODES = PERMISSIONS.map((p) => p[0]);

const VIEW_BASIC = ['dashboard.view', 'asset.view', 'location.view', 'incident.view'];

// Chức danh mặc định – có thể sửa trên giao diện "Chức danh & phân quyền"
export const DEFAULT_ROLES = [
  { code: 'ADMIN', name: 'Quản trị hệ thống', department: 'IT', all: 1, system: 1, perms: ALL_PERMISSION_CODES },
  { code: 'BGD', name: 'Ban Giám đốc', department: 'Ban Giám đốc', all: 1,
    perms: [...VIEW_BASIC, 'asset.export', 'accounting.view', 'maintenance.view', 'transfer.approve', 'report.view', 'user.view', 'audit.view'] },
  { code: 'TP_BT', name: 'Trưởng phòng Bảo trì', department: 'Bảo trì', all: 1,
    perms: [...VIEW_BASIC, 'asset.create', 'asset.update', 'asset.status', 'asset.import', 'asset.export', 'asset.qr_print',
      'accounting.view', 'maintenance.view', 'maintenance.create', 'maintenance.plan', 'incident.create', 'incident.manage',
      'transfer.request', 'transfer.approve', 'category.manage', 'user.view', 'report.view', 'audit.view'] },
  { code: 'NV_BT', name: 'Nhân viên Bảo trì hạ tầng', department: 'Bảo trì', all: 1,
    perms: [...VIEW_BASIC, 'asset.update', 'asset.status', 'asset.qr_print', 'maintenance.view', 'maintenance.create',
      'incident.create', 'incident.manage', 'transfer.request'] },
  { code: 'NV_IT', name: 'Nhân viên IT Help desk', department: 'Bảo trì', all: 1,
    perms: [...VIEW_BASIC, 'asset.update', 'asset.status', 'asset.qr_print', 'maintenance.view', 'maintenance.create',
      'incident.create', 'incident.manage', 'transfer.request'] },
  { code: 'KT_TS', name: 'Kế toán tài sản', department: 'Kế toán', all: 1,
    perms: [...VIEW_BASIC, 'asset.create', 'asset.update', 'asset.status', 'asset.import', 'asset.export', 'asset.qr_print',
      'accounting.view', 'accounting.update', 'maintenance.view', 'report.view'] },
  { code: 'THU_KHO', name: 'Thủ kho', department: 'Kho', all: 0,
    perms: [...VIEW_BASIC, 'asset.create', 'asset.update', 'asset.qr_print', 'maintenance.view', 'incident.create', 'transfer.request'] },
  { code: 'HC', name: 'Nhân viên Hành chính', department: 'Hành chính', all: 0,
    perms: [...VIEW_BASIC, 'asset.create', 'asset.update', 'asset.qr_print', 'maintenance.view', 'incident.create', 'transfer.request'] },
  { code: 'QL_VUNG', name: 'Quản lý vùng', department: 'Vận hành', all: 0,
    perms: [...VIEW_BASIC, 'maintenance.view', 'incident.create', 'transfer.request', 'report.view'] },
  { code: 'CHT', name: 'Cửa hàng trưởng', department: 'Cửa hàng', all: 0,
    perms: [...VIEW_BASIC, 'maintenance.view', 'incident.create', 'transfer.request'] },
  { code: 'NV_CH', name: 'Nhân viên cửa hàng', department: 'Cửa hàng', all: 0,
    perms: ['asset.view', 'incident.create'] },
];

/** Tính quyền hiệu lực & phạm vi địa điểm của 1 người dùng */
export async function loadAccess(db, userId) {
  const user = await db.get(`SELECT u.*, r.code AS role_code, r.name AS role_name, r.all_locations AS role_all
                           FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`, userId);
  if (!user) return null;
  const perms = new Set((await db.all('SELECT permission_code FROM role_permissions WHERE role_id = ?', user.role_id)).map((r) => r.permission_code));
  for (const o of await db.all('SELECT permission_code, effect FROM user_permission_overrides WHERE user_id = ?', userId)) {
    if (o.effect === 'grant') perms.add(o.permission_code); else perms.delete(o.permission_code);
  }
  const allLocations = !!(user.all_locations || user.role_all);
  const locationIds = allLocations ? null : (await db.all('SELECT location_id FROM user_locations WHERE user_id = ?', userId)).map((r) => r.location_id);
  return { user, perms, allLocations, locationIds };
}

export function can(access, perm) { return !!access && access.perms.has(perm); }

export function canLocation(access, locationId) {
  return !!access && (access.allLocations || access.locationIds.includes(Number(locationId)));
}

/** Mệnh đề SQL giới hạn theo địa điểm */
export function locationFilter(access, column = 'a.location_id') {
  if (access.allLocations) return { sql: '1=1', params: [] };
  if (!access.locationIds.length) return { sql: '1=0', params: [] };
  return { sql: `${column} IN (${access.locationIds.map(() => '?').join(',')})`, params: access.locationIds };
}
