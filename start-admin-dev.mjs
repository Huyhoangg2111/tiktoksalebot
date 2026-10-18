/* Dev-only: chạy riêng Admin dashboard để xem trước giao diện local (không cần bot Telegram).
   Bỏ qua đăng nhập OTP (ADMIN_DEV_SKIP_AUTH=1, chỉ có ở script này). Dữ liệu demo được gieo vào runtime/dev_dashboard.db lần đầu chạy. */
import { config } from 'dotenv';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

config();

// Đặt env TRƯỚC load module, rồi import động (các module đọc env ngay lúc parser file).
const DB_PATH = resolve('./runtime/dev_dashboard.db');
process.env.DATABASE_PATH = DB_PATH;
process.env.ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '1';
process.env.ADMIN_WEB_PORT = process.env.ADMIN_WEB_PORT || '8080';
process.env.ADMIN_DEV_SKIP_AUTH = '1'; // dev-only: dashboard không hỏi OTP

const dbModule = await import('./dist/db/index.js');
const adminModule = await import('./dist/admin/server.js');
const { connectDB } = dbModule;
const { startAdminServer } = adminModule;
// db là biến let gán trong connectDB() → luôn truy cập qua dbModule.db (không destructure sớm).

const seedDemoData = async () => {
  const db = dbModule.db;
  // Demo dual-layer: 1 card / tên chiến dịch, 2 khối ngưỡng camp ≠ material.
  const hasDual = await db.get(`SELECT COUNT(*) as c FROM alert_action_rules WHERE note LIKE 'Demo dual%'`);
  if (Number(hasDual?.c || 0) === 0) {
    await db.run(`DELETE FROM alert_action_rules WHERE note IN ('Demo Cả hai') OR note LIKE 'Demo dual%'`);
    const spendDemo = [
      { entity: 'campaign', th: 0.5, action: 'pause' },
      { entity: 'material', th: 0.2, action: 'pause' },
    ];
    for (const rule of spendDemo) {
      await db.run(`INSERT INTO alert_action_rules
        (entity,trigger_kind,name_contains,metric,metric_operator,metric_threshold,
         conversions_operator,conversions_threshold,action,is_active,note)
        VALUES(?,'continuous','gấu bông -VN','spend','gt',?,'lt',1,?,1,'Demo dual spend')`,
        [rule.entity, rule.th, rule.action]);
    }
    const cpaDemo = [
      { entity: 'campaign', op: 'gt', th: 0.6, action: 'pause' },
      { entity: 'campaign', op: 'lt', th: 0.6, action: 'enable' },
      { entity: 'material', op: 'gt', th: 0.4, action: 'pause' },
      { entity: 'material', op: 'lt', th: 0.4, action: 'enable' },
    ];
    for (const rule of cpaDemo) {
      await db.run(`INSERT INTO alert_action_rules
        (entity,trigger_kind,name_contains,metric,metric_operator,metric_threshold,
         conversions_operator,conversions_threshold,action,is_active,note)
        VALUES(?,'continuous','gấu bông -VN','cpa',?,?, 'gte',1,?,1,'Demo dual CPA')`,
        [rule.entity, rule.op, rule.th, rule.action]);
    }
    await db.run(`INSERT INTO alert_action_rules
      (entity,trigger_kind,run_time,period,name_contains,metric,metric_operator,metric_threshold,
       conversions_operator,conversions_threshold,action,is_active,note)
      VALUES('both','scheduled','06:30','last_7_days','Son kem demo','spend','gt',30,'gt',0,'notify',1,'Demo dual notify')`);
    console.log('Đã gieo demo dual-layer: spend camp>0.5/mat>0.2 · CPA camp 0.6/mat 0.4');
  }
  await db.exec('CREATE TABLE IF NOT EXISTS admin_config_rows(id INTEGER PRIMARY KEY AUTOINCREMENT,section TEXT NOT NULL,data_json TEXT NOT NULL,position INTEGER NOT NULL DEFAULT 0,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)');
  const existing = await db.get('SELECT COUNT(*) as c FROM alert_action_rules');
  if (Number(existing?.c || 0) > 0) return;
  await db.exec('DELETE FROM admin_config_rows');
  for (const row of [
    { business_center_id: '7999999999999999', read_token: 'demo-read-token', write_token: 'demo-write-token', note: 'Dữ liệu demo' },
  ]) {
    await db.run('INSERT INTO admin_config_rows(section,data_json,position) VALUES(?,?,0)', ['tiktok', JSON.stringify(row)]);
  }
  const advertisers = [
    { advertiser_id: '730000000000000001', advertiser_name: 'AA 32 · Hoang TH', market_code: 'ID', enabled: 1, note: '' },
    { advertiser_id: '730000000000000002', advertiser_name: 'AA 33 · Hoang TH', market_code: 'VN', enabled: 1, note: '' },
  ];
  for (const row of advertisers) {
    await db.run('INSERT INTO admin_config_rows(section,data_json,position) VALUES(?,?,?)', ['advertisers', JSON.stringify(row), 0]);
  }
  await db.run('INSERT INTO admin_config_rows(section,data_json,position) VALUES(?,?,?)', ['sources',
    JSON.stringify({ name: 'AGRI Sheet 7', sheet_id: '1f7bH43w8kv_iiqoy9X5TzSugDuWtsKrB3-Iq8IrxvAI', enabled: 1, note: 'Đài Loan' }), 0]);
  for (const row of [
    { material_name: 'Mặt nạ mắt Lanbena', variant_name: 'MẶT NẠ MẮT LANBENA', campaign_key: 'MẶT NẠ MẮT', enabled: 1 },
    { material_name: 'Mặt nạ gạo XX', variant_name: 'MẶT NẠ GẠO XX', campaign_key: 'MẶT NẠ GẠO', enabled: 1 },
  ]) {
    await db.run('INSERT INTO admin_config_rows(section,data_json,position) VALUES(?,?,?)', ['products', JSON.stringify(row), 0]);
  }
  for (const row of [
    { page_handle: '@vlnshop', market_code: 'VN', page_name: 'VN Shop', page_url: 'https://tiktok.com/@vlnshop', enabled: 1 },
    { page_handle: '@idnshop', market_code: 'ID', page_name: 'ID Shop', page_url: 'https://tiktok.com/@idnshop', enabled: 1 },
  ]) {
    await db.run('INSERT INTO admin_config_rows(section,data_json,position) VALUES(?,?,?)', ['pages', JSON.stringify(row), 0]);
  }
  const rules = [
    { entity: 'campaign', trigger_kind: 'continuous', name_contains: 'MẶT NẠ MẮT', metric: 'spend', metric_operator: 'gt', metric_threshold: 50, conversions_operator: 'gte', conversions_threshold: 0, action: 'pause', is_active: 1, note: 'Demo TẮT đang chạy' },
    { entity: 'campaign', trigger_kind: 'continuous', name_contains: 'MẶT NẠ MẮT', metric: 'spend', metric_operator: 'gt', metric_threshold: 30, conversions_operator: 'gte', conversions_threshold: 0, action: 'enable', is_active: 1, note: 'Demo BẬT đang tạm dừng' },
    { entity: 'material', trigger_kind: 'scheduled', run_time: '06:30', period: 'month_to_date', name_contains: 'MẶT NẠ MẮT', metric: 'cpa', metric_operator: 'lt', metric_threshold: 1, conversions_operator: 'gte', conversions_threshold: 1, action: 'enable', is_active: 1, note: 'Bật lại theo lịch' },
    { entity: 'material', trigger_kind: 'continuous', name_contains: 'MẶT NẠ GẠO', metric: 'cpa', metric_operator: 'gt', metric_threshold: 2, metric_min_threshold: 1, conversions_operator: 'gte', conversions_threshold: 2, action: 'notify', is_active: 1, note: 'Nhóm THÔNG BÁO' },
  ];
  for (const rule of rules) {
    await db.run(`INSERT INTO alert_action_rules(entity,name_contains,metric,metric_operator,metric_threshold,metric_min_threshold,
      conversions_operator,conversions_threshold,action,trigger_kind,run_time,period,is_active,note)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [rule.entity, rule.name_contains ?? null, rule.metric, rule.metric_operator, rule.metric_threshold,
       rule.metric_min_threshold ?? null,
       rule.conversions_operator, rule.conversions_threshold, rule.action, rule.trigger_kind,
       rule.run_time ?? null, rule.period ?? null,
       rule.is_active, rule.note ?? null]);
  }
  console.log('Đã gieo dữ liệu demo cho dev_dashboard.db');
};

const main = async () => {
  await connectDB();
  await seedDemoData();
  await startAdminServer(async (code) => {
    console.log(`[DEV-OTP] Ma dang nhap dashboard: ${code}`);
    try { writeFileSync(resolve('./runtime/dev-otp.txt'), code); } catch {}
  });
  console.log('[DEV] Dashboard chay o http://127.0.0.1:8080/admin');
};

main().catch(error => { console.error(error); process.exit(1); });
