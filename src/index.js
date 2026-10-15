import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

app.use('*', cors());

// Helper: Format tiền tệ VND
function formatVND(num) {
  if (!num) return '0 đ';
  return Number(num).toLocaleString('vi-VN') + ' đ';
}

// ==============================================================================
// 1. API: MEMBERS (Danh bạ Tên <-> Email)
// ==============================================================================
app.get('/api/members', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM members ORDER BY name ASC'
    ).all();
    return c.json({ success: true, data: results });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

app.post('/api/members', async (c) => {
  try {
    const { name, email } = await c.req.json();
    if (!name || !email) {
      return c.json({ success: false, error: 'Tên và email không được để trống' }, 400);
    }
    const cleanName = name.trim();
    const cleanEmail = email.trim();

    const info = await c.env.DB.prepare(
      `INSERT INTO members (name, email) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET email = excluded.email, updated_at = CURRENT_TIMESTAMP`
    ).bind(cleanName, cleanEmail).run();

    return c.json({ success: true, message: 'Đã lưu thành viên', id: info.meta.last_row_id });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

app.delete('/api/members/:id', async (c) => {
  try {
    const id = c.req.param('id');
    await c.env.DB.prepare('DELETE FROM members WHERE id = ?').bind(id).run();
    return c.json({ success: true, message: 'Đã xóa thành viên' });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

// ==============================================================================
// 2. API: PAYMENT ACCOUNTS (Tài khoản ngân hàng VietQR)
// ==============================================================================
app.get('/api/payment-accounts', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM payment_accounts ORDER BY is_default DESC, id DESC'
    ).all();
    return c.json({ success: true, data: results });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

app.post('/api/payment-accounts', async (c) => {
  try {
    const { bank_code, bank_name, account_no, account_holder, is_default } = await c.req.json();
    if (!bank_code || !account_no || !account_holder) {
      return c.json({ success: false, error: 'Thiếu thông tin tài khoản' }, 400);
    }

    if (is_default) {
      await c.env.DB.prepare('UPDATE payment_accounts SET is_default = 0').run();
    }

    const info = await c.env.DB.prepare(
      `INSERT INTO payment_accounts (bank_code, bank_name, account_no, account_holder, is_default)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(bank_code.trim(), (bank_name || bank_code).trim(), account_no.trim(), account_holder.trim().toUpperCase(), is_default ? 1 : 0).run();

    return c.json({ success: true, message: 'Đã thêm tài khoản thanh toán', id: info.meta.last_row_id });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

app.put('/api/payment-accounts/:id/default', async (c) => {
  try {
    const id = c.req.param('id');
    await c.env.DB.prepare('UPDATE payment_accounts SET is_default = 0').run();
    await c.env.DB.prepare('UPDATE payment_accounts SET is_default = 1 WHERE id = ?').bind(id).run();
    return c.json({ success: true, message: 'Đã đặt làm tài khoản mặc định' });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

app.delete('/api/payment-accounts/:id', async (c) => {
  try {
    const id = c.req.param('id');
    await c.env.DB.prepare('DELETE FROM payment_accounts WHERE id = ?').bind(id).run();
    return c.json({ success: true, message: 'Đã xóa tài khoản' });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

// ==============================================================================
// 3. API: SETTINGS (Google Apps Script URL, Admin Email)
// ==============================================================================
app.get('/api/settings', async (c) => {
  try {
    const { results } = await c.env.DB.prepare('SELECT key, value FROM app_settings').all();
    const settings = {};
    for (const r of results) {
      settings[r.key] = r.value;
    }
    return c.json({ success: true, data: settings });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

app.post('/api/settings', async (c) => {
  try {
    const body = await c.req.json();
    for (const [k, v] of Object.entries(body)) {
      await c.env.DB.prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
      ).bind(k, String(v)).run();
    }
    return c.json({ success: true, message: 'Đã lưu cài đặt' });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

// ==============================================================================
// 4. API: SCAN BILL (Gọi Scanner Bridge trên VPS)
// ==============================================================================
app.post('/api/scan', async (c) => {
  try {
    const { image_base64 } = await c.req.json();
    if (!image_base64) {
      return c.json({ success: false, error: 'Thiếu dữ liệu ảnh' }, 400);
    }

    // 1. Lưu ảnh gốc vào Cloudflare R2
    let imageR2Key = null;
    if (c.env.BUCKET) {
      try {
        const rawB64 = image_base64.includes(',') ? image_base64.split(',')[1] : image_base64;
        const binaryStr = atob(rawB64);
        const len = binaryStr.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        imageR2Key = `bill_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.jpg`;
        await c.env.BUCKET.put(imageR2Key, bytes, {
          httpMetadata: { contentType: 'image/jpeg' },
        });
      } catch (r2Err) {
        console.error('Lỗi lưu R2:', r2Err);
      }
    }

    // 2. Lấy danh sách thành viên hiện có từ D1
    const { results: members } = await c.env.DB.prepare(
      'SELECT name, email FROM members'
    ).all();

    // 3. Gọi Scanner Bridge trên VPS
    const scannerUrl = c.env.SCANNER_API_URL || 'https://lunch-bill-splitter-api.16092001.xyz';
    const scannerToken = c.env.SCANNER_SECRET_TOKEN || '';

    const scannerRes = await fetch(`${scannerUrl}/scan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${scannerToken}`,
      },
      body: JSON.stringify({
        image_base64,
        members: members || [],
      }),
    });

    if (!scannerRes.ok) {
      const errText = await scannerRes.text();
      return c.json({
        success: false,
        error: `Scanner daemon lỗi (HTTP ${scannerRes.status}): ${errText}`,
      }, 502);
    }

    const scannerData = await scannerRes.json();
    if (!scannerData.success) {
      return c.json({
        success: false,
        error: scannerData.error || 'Không bóc tách được hóa đơn',
        raw_output: scannerData.raw_output,
      }, 500);
    }

    return c.json({
      success: true,
      data: scannerData.data,
      image_r2_key: imageR2Key,
    });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

// ==============================================================================
// 5. API: NOTIFY (Gọi Google Apps Script gửi mail)
// ==============================================================================
app.post('/api/notify', async (c) => {
  try {
    const payload = await c.req.json();

    // Lấy URL GAS từ settings nếu payload không truyền
    let gasUrl = payload.gas_url;
    let adminEmail = payload.admin_email;

    if (!gasUrl) {
      const row = await c.env.DB.prepare(
        "SELECT value FROM app_settings WHERE key = 'gas_url'"
      ).first();
      if (row) gasUrl = row.value;
    }

    if (!adminEmail) {
      const row = await c.env.DB.prepare(
        "SELECT value FROM app_settings WHERE key = 'admin_email'"
      ).first();
      if (row) adminEmail = row.value;
    }

    if (!gasUrl) {
      return c.json({
        success: false,
        error: 'Chưa cấu hình Google Apps Script URL. Vui lòng vào Tab "Cài Đặt" để điền URL Web App!',
      }, 400);
    }

    payload.admin_email = adminEmail || '';

    const gasRes = await fetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const gasResult = await gasRes.json();
    return c.json({ success: true, result: gasResult });
  } catch (err) {
    return c.json({ success: false, error: 'Lỗi gửi tới Google Apps Script: ' + err.message }, 500);
  }
});

// ==============================================================================
// 6. FRONTEND: SINGLE-PAGE WEB APP
// ==============================================================================
app.get('*', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lunch Bill Splitter — Quản Lý & Chia Tiền Cơm Trưa</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/lucide@latest"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            brand: {
              50: '#fff7ed',
              100: '#ffedd5',
              500: '#f97316',
              600: '#ea580c',
              700: '#c2410c',
            }
          }
        }
      }
    }
  </script>
  <style>
    [x-cloak] { display: none !important; }
    .tab-btn.active {
      background-color: #ea580c;
      color: #ffffff;
      box-shadow: 0 4px 12px rgba(234, 88, 12, 0.25);
    }
  </style>
</head>
<body class="bg-slate-50 text-slate-800 min-h-screen flex flex-col font-sans antialiased">

  <!-- Header -->
  <header class="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-sm">
    <div class="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
      <div class="flex items-center space-x-3">
        <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-brand-600 to-amber-500 flex items-center justify-center text-white shadow-md shadow-brand-500/20">
          <i data-lucide="receipt" class="w-5 h-5"></i>
        </div>
        <div>
          <h1 class="text-lg font-bold text-slate-900 leading-tight">Lunch Bill Splitter</h1>
          <p class="text-xs text-slate-500 flex items-center space-x-1">
            <span>Serverless on Cloudflare</span>
            <span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
          </p>
        </div>
      </div>

      <!-- Navigation Tabs -->
      <nav class="flex space-x-1 bg-slate-100 p-1 rounded-xl text-sm font-medium">
        <button onclick="switchTab('splitter')" id="tab-btn-splitter" class="tab-btn active px-3.5 py-1.5 rounded-lg transition-all flex items-center space-x-1.5">
          <i data-lucide="calculator" class="w-4 h-4"></i>
          <span>Chia Tiền</span>
        </button>
        <button onclick="switchTab('members')" id="tab-btn-members" class="tab-btn px-3.5 py-1.5 rounded-lg text-slate-600 hover:text-slate-900 transition-all flex items-center space-x-1.5">
          <i data-lucide="users" class="w-4 h-4"></i>
          <span>Danh Bạ</span>
        </button>
        <button onclick="switchTab('settings')" id="tab-btn-settings" class="tab-btn px-3.5 py-1.5 rounded-lg text-slate-600 hover:text-slate-900 transition-all flex items-center space-x-1.5">
          <i data-lucide="settings" class="w-4 h-4"></i>
          <span>Cài Đặt</span>
        </button>
      </nav>
    </div>
  </header>

  <!-- Main Content -->
  <main class="flex-1 max-w-5xl w-full mx-auto p-4 sm:p-6 space-y-6">

    <!-- ========================================================================= -->
    <!-- TAB 1: CHIA TIỀN (SPLITTER) -->
    <!-- ========================================================================= -->
    <div id="tab-splitter" class="space-y-6">

      <!-- Upload Section -->
      <div class="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-sm space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-base font-semibold text-slate-900 flex items-center space-x-2">
              <span class="flex items-center justify-center w-6 h-6 rounded-full bg-brand-100 text-brand-700 text-xs font-bold">1</span>
              <span>Tải Hóa Đơn ShopeeFood / GrabFood</span>
            </h2>
            <p class="text-xs text-slate-500 mt-0.5">Kéo thả ảnh, chọn file hoặc dán trực tiếp (Ctrl + V)</p>
          </div>
          <span id="scan-status-pill" class="hidden text-xs font-medium px-2.5 py-1 rounded-full bg-slate-100 text-slate-600"></span>
        </div>

        <div id="drop-zone" class="border-2 border-dashed border-slate-300 hover:border-brand-500 rounded-xl p-8 text-center transition-colors cursor-pointer bg-slate-50/50 hover:bg-brand-50/20">
          <input type="file" id="file-input" accept="image/*" class="hidden">
          <div id="drop-prompt" class="space-y-3">
            <div class="w-12 h-12 rounded-full bg-brand-50 text-brand-600 mx-auto flex items-center justify-center">
              <i data-lucide="image-up" class="w-6 h-6"></i>
            </div>
            <div class="text-sm text-slate-600">
              <span class="font-semibold text-brand-600 hover:underline">Bấm để chọn ảnh</span> hoặc kéo ảnh vào đây
            </div>
            <p class="text-xs text-slate-400">Hỗ trợ PNG, JPG, JPEG, WebP</p>
          </div>

          <div id="preview-container" class="hidden space-y-4">
            <img id="image-preview" src="" alt="Hóa đơn" class="max-h-64 mx-auto rounded-lg shadow-sm border border-slate-200 object-contain">
            <div class="flex items-center justify-center space-x-3">
              <button onclick="triggerScan()" id="btn-scan" class="bg-brand-600 hover:bg-brand-700 text-white font-medium px-5 py-2 rounded-xl text-sm shadow-md shadow-brand-600/20 transition-all flex items-center space-x-2">
                <i data-lucide="sparkles" class="w-4 h-4"></i>
                <span>Bóc Tách Hóa Đơn Bằng AI</span>
              </button>
              <button onclick="resetImage()" class="text-slate-500 hover:text-slate-700 text-sm px-3 py-2">
                Đổi ảnh khác
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Result & Edit Section -->
      <div id="result-section" class="hidden space-y-6">

        <!-- Bill Overview & Summary Inputs -->
        <div class="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-sm space-y-4">
          <div class="flex items-center justify-between border-b border-slate-100 pb-3">
            <div class="flex items-center space-x-2">
              <span class="flex items-center justify-center w-6 h-6 rounded-full bg-brand-100 text-brand-700 text-xs font-bold">2</span>
              <h2 class="text-base font-semibold text-slate-900">Thông Tin Tổng Quan Đơn Hàng</h2>
            </div>
            <span class="text-xs text-emerald-600 font-medium bg-emerald-50 px-2.5 py-1 rounded-full flex items-center space-x-1">
              <i data-lucide="check" class="w-3.5 h-3.5"></i>
              <span>AI đã nhận diện</span>
            </span>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <label class="block text-xs font-medium text-slate-500 mb-1">Tên Quán Ăn</label>
              <input type="text" id="input-store-name" class="w-full text-sm font-semibold border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-brand-500">
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-500 mb-1">Tổng Tiền Gốc Các Món</label>
              <input type="number" id="input-subtotal" oninput="recalculate()" class="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-brand-500">
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-500 mb-1">Voucher Giảm Món</label>
              <input type="number" id="input-discount-items" oninput="recalculate()" class="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 text-emerald-600 font-medium focus:outline-none focus:border-brand-500">
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-500 mb-1">Phí Ship Thực Tế</label>
              <input type="number" id="input-shipping-net" oninput="recalculate()" class="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 text-sky-600 font-medium focus:outline-none focus:border-brand-500">
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
            <div>
              <label class="block text-xs font-medium text-slate-500 mb-1">Phí Dịch Vụ / Phụ Phí</label>
              <input type="number" id="input-service-fee" oninput="recalculate()" class="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-brand-500">
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-500 mb-1">Tổng Bill Thực Trả (App)</label>
              <input type="number" id="input-final-total" oninput="recalculate()" class="w-full text-sm font-bold text-brand-600 border border-brand-300 bg-brand-50/30 rounded-lg px-3 py-2 focus:outline-none focus:border-brand-500">
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-500 mb-1">Tài Khoản Nhận Chuyển Khoản</label>
              <select id="select-payment-account" onchange="recalculate()" class="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-brand-500">
                <!-- Dynamic load -->
              </select>
            </div>
          </div>
        </div>

        <!-- Dishes Table -->
        <div class="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-sm space-y-4">
          <div class="flex items-center justify-between border-b border-slate-100 pb-3">
            <div class="flex items-center space-x-2">
              <span class="flex items-center justify-center w-6 h-6 rounded-full bg-brand-100 text-brand-700 text-xs font-bold">3</span>
              <h2 class="text-base font-semibold text-slate-900">Chi Tiết Món Ăn & Ánh Xạ Người Đặt</h2>
            </div>
            <button onclick="addNewDishRow()" class="text-brand-600 hover:text-brand-700 text-xs font-medium flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-brand-50">
              <i data-lucide="plus" class="w-3.5 h-3.5"></i>
              <span>Thêm món</span>
            </button>
          </div>

          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead class="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                <tr>
                  <th class="p-3">Người đặt</th>
                  <th class="p-3">Email nhận thông báo</th>
                  <th class="p-3">Tên món ăn</th>
                  <th class="p-3 w-16 text-center">SL</th>
                  <th class="p-3 text-right">Giá gốc (VNĐ)</th>
                  <th class="p-3 w-12 text-center">Xóa</th>
                </tr>
              </thead>
              <tbody id="dishes-tbody" class="divide-y divide-slate-100">
                <!-- Rows injected dynamically -->
              </tbody>
            </table>
          </div>
        </div>

        <!-- Calculated Settlements (Bảng chia tiền cuối cùng) -->
        <div class="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-sm space-y-4">
          <div class="flex items-center justify-between border-b border-slate-100 pb-3">
            <div class="flex items-center space-x-2">
              <span class="flex items-center justify-center w-6 h-6 rounded-full bg-brand-100 text-brand-700 text-xs font-bold">4</span>
              <h2 class="text-base font-semibold text-slate-900">Bảng Quyết Toán & Chia Tiền Theo Đầu Người</h2>
            </div>
            <span id="settlement-total-badge" class="text-xs font-bold px-3 py-1 rounded-full bg-brand-100 text-brand-700"></span>
          </div>

          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead class="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
                <tr>
                  <th class="p-3">Thành viên</th>
                  <th class="p-3">Món</th>
                  <th class="p-3 text-right">Tiền món gốc</th>
                  <th class="p-3 text-right text-emerald-600">Được giảm</th>
                  <th class="p-3 text-right text-sky-600">Ship chia đều</th>
                  <th class="p-3 text-right font-bold text-brand-600">CẦN TRẢ</th>
                  <th class="p-3 text-center">Mã VietQR</th>
                </tr>
              </thead>
              <tbody id="settlement-tbody" class="divide-y divide-slate-100">
                <!-- Dynamic settlements -->
              </tbody>
            </table>
          </div>

          <!-- Action Buttons -->
          <div class="pt-4 flex flex-wrap items-center justify-end gap-3 border-t border-slate-100">
            <button onclick="copyZaloText()" class="bg-slate-800 hover:bg-slate-900 text-white font-medium px-4 py-2.5 rounded-xl text-sm transition-all flex items-center space-x-2">
              <i data-lucide="copy" class="w-4 h-4"></i>
              <span>Copy Bảng Kê (Zalo / Slack)</span>
            </button>
            <button onclick="sendEmails()" id="btn-send-emails" class="bg-brand-600 hover:bg-brand-700 text-white font-medium px-5 py-2.5 rounded-xl text-sm shadow-md shadow-brand-600/20 transition-all flex items-center space-x-2">
              <i data-lucide="send" class="w-4 h-4"></i>
              <span>Gửi Email Cá Nhân (Gmail)</span>
            </button>
          </div>
        </div>

      </div>
    </div>

    <!-- ========================================================================= -->
    <!-- TAB 2: DANH BẠ THÀNH VIÊN (MEMBERS) -->
    <!-- ========================================================================= -->
    <div id="tab-members" class="hidden space-y-6">
      <div class="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-sm space-y-5">
        <div>
          <h2 class="text-base font-semibold text-slate-900">Danh Bạ Ánh Xạ Tên ↔ Email</h2>
          <p class="text-xs text-slate-500 mt-1">Danh bạ này được lưu trong Cloudflare D1 và tự động nạp vào AI khi scan để gán email chính xác.</p>
        </div>

        <!-- Add Form -->
        <form onsubmit="addMember(event)" class="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-slate-50 p-4 rounded-xl border border-slate-200/70">
          <div>
            <label class="block text-xs font-medium text-slate-500 mb-1">Tên thường gọi / Tên Shopee</label>
            <input type="text" id="member-name-input" placeholder="Ví dụ: Phú, Linh, Tuấn..." required class="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-brand-500">
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-500 mb-1">Địa chỉ Email</label>
            <input type="email" id="member-email-input" placeholder="dongnghiep@company.com" required class="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-brand-500">
          </div>
          <div class="flex items-end">
            <button type="submit" class="w-full bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors flex items-center justify-center space-x-1.5">
              <i data-lucide="user-plus" class="w-4 h-4"></i>
              <span>Lưu Thành Viên</span>
            </button>
          </div>
        </form>

        <!-- Members Table -->
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead class="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
              <tr>
                <th class="p-3">Tên thành viên</th>
                <th class="p-3">Email nhận hóa đơn</th>
                <th class="p-3 w-20 text-center">Thao tác</th>
              </tr>
            </thead>
            <tbody id="members-list-tbody" class="divide-y divide-slate-100">
              <!-- Rendered via JS -->
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ========================================================================= -->
    <!-- TAB 3: CÀI ĐẶT (SETTINGS) -->
    <!-- ========================================================================= -->
    <div id="tab-settings" class="hidden space-y-6">

      <!-- Payment Accounts -->
      <div class="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-sm space-y-5">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-base font-semibold text-slate-900">Tài Khoản Ngân Hàng (VietQR)</h2>
            <p class="text-xs text-slate-500 mt-0.5">Lưu trong D1, tự động đồng bộ trên tất cả thiết bị của bạn.</p>
          </div>
        </div>

        <form onsubmit="addPaymentAccount(event)" class="grid grid-cols-1 sm:grid-cols-4 gap-3 bg-slate-50 p-4 rounded-xl border border-slate-200/70">
          <div>
            <label class="block text-xs font-medium text-slate-500 mb-1">Ngân hàng</label>
            <select id="acc-bank-code" required class="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-brand-500">
              <option value="MB">MBBank (Quân Đội)</option>
              <option value="TCB">Techcombank</option>
              <option value="VCB">Vietcombank</option>
              <option value="TPB">TPBank</option>
              <option value="VPB">VPBank</option>
              <option value="ACB">ACB</option>
              <option value="BIDV">BIDV</option>
              <option value="VIB">VIB</option>
              <option value="VBA">Agribank</option>
              <option value="MSB">MSB</option>
              <option value="OCB">OCB</option>
              <option value="STB">Sacombank</option>
            </select>
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-500 mb-1">Số tài khoản</label>
            <input type="text" id="acc-no" placeholder="Ví dụ: 0987654321" required class="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-brand-500">
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-500 mb-1">Tên chủ tài khoản</label>
            <input type="text" id="acc-holder" placeholder="NGUYEN VAN A" required class="w-full text-sm uppercase border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-brand-500">
          </div>
          <div class="flex items-end">
            <button type="submit" class="w-full bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors flex items-center justify-center space-x-1.5">
              <i data-lucide="plus" class="w-4 h-4"></i>
              <span>Thêm STK</span>
            </button>
          </div>
        </form>

        <div id="payment-accounts-list" class="space-y-3">
          <!-- Rendered via JS -->
        </div>
      </div>

      <!-- Google Apps Script Config -->
      <div class="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-sm space-y-4">
        <div>
          <h2 class="text-base font-semibold text-slate-900">Cấu Hình Gửi Mail (Google Apps Script)</h2>
          <p class="text-xs text-slate-500 mt-0.5">Kết nối với Web App triển khai từ Gmail cá nhân của bạn.</p>
        </div>

        <div class="space-y-4">
          <div>
            <label class="block text-xs font-medium text-slate-500 mb-1">Google Apps Script Web App URL</label>
            <input type="url" id="setting-gas-url" placeholder="https://script.google.com/macros/s/AKfycb.../exec" class="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-brand-500">
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-500 mb-1">Email của Alviss (Nhận bảng tổng hợp đơn)</label>
            <input type="email" id="setting-admin-email" placeholder="alviss@gmail.com" class="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-brand-500">
          </div>
          <div class="flex justify-end space-x-3 pt-2">
            <button onclick="saveSettings()" class="bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium px-5 py-2 rounded-xl shadow-md shadow-brand-600/20 transition-all flex items-center space-x-1.5">
              <i data-lucide="save" class="w-4 h-4"></i>
              <span>Lưu Cài Đặt</span>
            </button>
          </div>
        </div>
      </div>

    </div>

  </main>

  <!-- VietQR Modal -->
  <div id="qr-modal" class="hidden fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl max-w-sm w-full p-6 space-y-4 text-center shadow-xl">
      <div class="flex justify-between items-center border-b border-slate-100 pb-3">
        <h3 id="qr-modal-title" class="font-bold text-slate-900 text-base">Thanh Toán VietQR</h3>
        <button onclick="closeQrModal()" class="text-slate-400 hover:text-slate-600">
          <i data-lucide="x" class="w-5 h-5"></i>
        </button>
      </div>
      <img id="qr-modal-img" src="" alt="Mã VietQR" class="mx-auto rounded-xl border border-slate-200 shadow-sm w-64 h-64 object-contain">
      <div id="qr-modal-info" class="text-xs text-slate-600 bg-slate-50 p-3 rounded-lg text-left space-y-1"></div>
      <button onclick="closeQrModal()" class="w-full bg-slate-800 hover:bg-slate-900 text-white font-medium py-2 rounded-xl text-sm">
        Đóng
      </button>
    </div>
  </div>

  <script>
    // State
    let currentImageBase64 = null;
    let scannedDishes = [];
    let paymentAccounts = [];
    let membersList = [];
    let currentSettlements = [];

    // Init Lucide
    lucide.createIcons();

    // Tab switcher
    function switchTab(tabId) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('tab-btn-' + tabId).classList.add('active');

      document.getElementById('tab-splitter').classList.add('hidden');
      document.getElementById('tab-members').classList.add('hidden');
      document.getElementById('tab-settings').classList.add('hidden');

      document.getElementById('tab-' + tabId).classList.remove('hidden');

      if (tabId === 'members') loadMembers();
      if (tabId === 'settings') {
        loadPaymentAccounts();
        loadSettings();
      }
    }

    // Drag & drop / File input / Paste
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');

    dropZone.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleImageFile(file);
    });

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('border-brand-500', 'bg-brand-50/20');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('border-brand-500', 'bg-brand-50/20');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('border-brand-500', 'bg-brand-50/20');
      if (e.dataTransfer.files.length) {
        handleImageFile(e.dataTransfer.files[0]);
      }
    });

    window.addEventListener('paste', (e) => {
      const items = e.clipboardData.items;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const file = items[i].getAsFile();
          handleImageFile(file);
          break;
        }
      }
    });

    function handleImageFile(file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        currentImageBase64 = e.target.result;
        document.getElementById('image-preview').src = currentImageBase64;
        document.getElementById('drop-prompt').classList.add('hidden');
        document.getElementById('preview-container').classList.remove('hidden');
      };
      reader.readAsDataURL(file);
    }

    function resetImage() {
      currentImageBase64 = null;
      document.getElementById('file-input').value = '';
      document.getElementById('drop-prompt').classList.remove('hidden');
      document.getElementById('preview-container').classList.add('hidden');
      document.getElementById('result-section').classList.add('hidden');
    }

    // Scan Bill via AI
    async function triggerScan() {
      if (!currentImageBase64) return;
      const btn = document.getElementById('btn-scan');
      btn.disabled = true;
      btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i><span>Đang bóc tách dữ liệu AI...</span>';
      lucide.createIcons();

      try {
        const res = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_base64: currentImageBase64 }),
        });
        const data = await res.json();
        if (!data.success) {
          alert('Lỗi bóc tách hóa đơn: ' + data.error);
          return;
        }

        const bill = data.data;
        document.getElementById('input-store-name').value = bill.store_name || '';
        document.getElementById('input-subtotal').value = bill.subtotal || 0;
        document.getElementById('input-discount-items').value = bill.discount_items || 0;
        
        const shipNet = (bill.shipping_fee || 0) - (bill.discount_shipping || 0);
        document.getElementById('input-shipping-net').value = shipNet > 0 ? shipNet : 0;
        document.getElementById('input-service-fee').value = bill.service_fee || 0;
        document.getElementById('input-final-total').value = bill.final_total || 0;

        scannedDishes = (bill.items || []).map(item => ({
          user_name: item.matched_user_name || item.raw_user_name || 'Khách',
          email: item.email || '',
          dish_name: item.dish_name || 'Món ăn',
          quantity: item.quantity || 1,
          price: item.price || 0,
        }));

        renderDishesTable();
        await loadPaymentAccounts();
        recalculate();

        document.getElementById('result-section').classList.remove('hidden');
        document.getElementById('result-section').scrollIntoView({ behavior: 'smooth' });
      } catch (err) {
        alert('Lỗi kết nối máy chủ: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="sparkles" class="w-4 h-4"></i><span>Bóc Tách Hóa Đơn Bằng AI</span>';
        lucide.createIcons();
      }
    }

    // Render Dishes Table
    function renderDishesTable() {
      const tbody = document.getElementById('dishes-tbody');
      tbody.innerHTML = '';

      scannedDishes.forEach((d, idx) => {
        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td class="p-3">
            <input type="text" value="\${d.user_name}" onchange="updateDish(\${idx}, 'user_name', this.value)" class="w-full text-sm font-medium border border-slate-200 rounded px-2 py-1 focus:border-brand-500">
          </td>
          <td class="p-3">
            <input type="email" value="\${d.email}" placeholder="email@company.com" onchange="updateDish(\${idx}, 'email', this.value)" class="w-full text-xs text-slate-600 border border-slate-200 rounded px-2 py-1 focus:border-brand-500">
          </td>
          <td class="p-3">
            <input type="text" value="\${d.dish_name}" onchange="updateDish(\${idx}, 'dish_name', this.value)" class="w-full text-sm border border-slate-200 rounded px-2 py-1 focus:border-brand-500">
          </td>
          <td class="p-3 text-center">
            <input type="number" min="1" value="\${d.quantity}" onchange="updateDish(\${idx}, 'quantity', parseInt(this.value)||1)" class="w-14 text-center text-sm border border-slate-200 rounded px-1 py-1">
          </td>
          <td class="p-3 text-right">
            <input type="number" value="\${d.price}" onchange="updateDish(\${idx}, 'price', parseInt(this.value)||0)" class="w-24 text-right text-sm font-semibold border border-slate-200 rounded px-2 py-1">
          </td>
          <td class="p-3 text-center">
            <button onclick="removeDishRow(\${idx})" class="text-slate-400 hover:text-red-500 p-1">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </td>
        \`;
        tbody.appendChild(tr);
      });
      lucide.createIcons();
    }

    function updateDish(idx, key, val) {
      scannedDishes[idx][key] = val;
      recalculate();
    }

    function removeDishRow(idx) {
      scannedDishes.splice(idx, 1);
      renderDishesTable();
      recalculate();
    }

    function addNewDishRow() {
      scannedDishes.push({
        user_name: 'Người mới',
        email: '',
        dish_name: 'Món thêm',
        quantity: 1,
        price: 40000,
      });
      renderDishesTable();
      recalculate();
    }

    // Calculation Algorithm (Thuật toán chia tiền)
    function recalculate() {
      const subtotal = parseInt(document.getElementById('input-subtotal').value) || 0;
      const discountItems = parseInt(document.getElementById('input-discount-items').value) || 0;
      const shippingNet = parseInt(document.getElementById('input-shipping-net').value) || 0;
      const serviceFee = parseInt(document.getElementById('input-service-fee').value) || 0;
      const finalTotal = parseInt(document.getElementById('input-final-total').value) || 0;

      // Gom theo người đặt
      const userMap = {};
      let totalItemsCost = 0;

      scannedDishes.forEach(d => {
        const u = d.user_name || 'Khách';
        if (!userMap[u]) {
          userMap[u] = {
            name: u,
            email: d.email || '',
            dishes: [],
            totalOriginal: 0,
          };
        }
        if (d.email && !userMap[u].email) userMap[u].email = d.email;
        const itemCost = (d.price || 0) * (d.quantity || 1);
        userMap[u].dishes.push(d.dish_name);
        userMap[u].totalOriginal += itemCost;
        totalItemsCost += itemCost;
      });

      const users = Object.values(userMap);
      const userCount = users.length || 1;
      const sharedFeePerPerson = Math.round((shippingNet + serviceFee) / userCount);

      // Lấy tài khoản ngân hàng được chọn
      const accSelect = document.getElementById('select-payment-account');
      const selectedAccId = accSelect ? accSelect.value : null;
      const bankAcc = paymentAccounts.find(a => String(a.id) === String(selectedAccId)) || paymentAccounts[0] || {};

      let calculatedSum = 0;
      currentSettlements = users.map(u => {
        // Tỷ lệ giảm giá món theo giá gốc
        const discountRatio = totalItemsCost > 0 ? (u.totalOriginal / totalItemsCost) : (1 / userCount);
        const myDiscount = Math.round(discountItems * discountRatio);
        
        // Làm tròn đến nghìn
        let rawPay = u.totalOriginal - myDiscount + sharedFeePerPerson;
        let roundedPay = Math.round(rawPay / 1000) * 1000;
        calculatedSum += roundedPay;

        const vietqrUrl = bankAcc.account_no ? \`https://img.vietqr.io/image/\${bankAcc.bank_code}-\${bankAcc.account_no}-compact2.png?amount=\${roundedPay}&addInfo=\${encodeURIComponent('AN TRUA ' + u.name)}&accountName=\${encodeURIComponent(bankAcc.account_holder || '')}\` : '';

        return {
          name: u.name,
          email: u.email,
          dishesStr: u.dishes.join(', '),
          original: u.totalOriginal,
          discount: myDiscount,
          shipping: sharedFeePerPerson,
          finalAmount: roundedPay,
          vietqrUrl,
          bankInfo: bankAcc,
        };
      });

      // Bù trừ sai số làm tròn vào người đầu tiên (người đặt / Alviss) nếu có lệch với finalTotal
      if (finalTotal > 0 && currentSettlements.length > 0) {
        const diff = finalTotal - calculatedSum;
        if (diff !== 0 && Math.abs(diff) < 10000) {
          currentSettlements[0].finalAmount += diff;
          if (currentSettlements[0].vietqrUrl && bankAcc.account_no) {
            currentSettlements[0].vietqrUrl = \`https://img.vietqr.io/image/\${bankAcc.bank_code}-\${bankAcc.account_no}-compact2.png?amount=\${currentSettlements[0].finalAmount}&addInfo=\${encodeURIComponent('AN TRUA ' + currentSettlements[0].name)}&accountName=\${encodeURIComponent(bankAcc.account_holder || '')}\`;
          }
        }
      }

      renderSettlementsTable();
    }

    function renderSettlementsTable() {
      const tbody = document.getElementById('settlement-tbody');
      tbody.innerHTML = '';
      let sum = 0;

      currentSettlements.forEach((s, idx) => {
        sum += s.finalAmount;
        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td class="p-3">
            <div class="font-semibold text-slate-900">\${s.name}</div>
            <div class="text-xs text-slate-500">\${s.email || '<span class="text-amber-600 font-medium">Chưa có email</span>'}</div>
          </td>
          <td class="p-3 text-slate-600 text-xs max-w-xs truncate">\${s.dishesStr}</td>
          <td class="p-3 text-right text-slate-600">\${formatVND(s.original)}</td>
          <td class="p-3 text-right text-emerald-600 font-medium">-\${formatVND(s.discount)}</td>
          <td class="p-3 text-right text-sky-600 font-medium">+\${formatVND(s.shipping)}</td>
          <td class="p-3 text-right font-bold text-brand-600 text-base">\${formatVND(s.finalAmount)}</td>
          <td class="p-3 text-center">
            \${s.vietqrUrl ? \`<button onclick="openQrModal(\${idx})" class="text-xs font-semibold px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 inline-flex items-center space-x-1">
              <i data-lucide="qr-code" class="w-3.5 h-3.5"></i>
              <span>Xem QR</span>
            </button>\` : '<span class="text-xs text-slate-400">Thiếu STK</span>'}
          </td>
        \`;
        tbody.appendChild(tr);
      });

      document.getElementById('settlement-total-badge').textContent = 'Tổng thu: ' + formatVND(sum);
      lucide.createIcons();
    }

    // Modal VietQR
    function openQrModal(idx) {
      const s = currentSettlements[idx];
      document.getElementById('qr-modal-title').textContent = 'Mã QR: ' + s.name;
      document.getElementById('qr-modal-img').src = s.vietqrUrl;
      document.getElementById('qr-modal-info').innerHTML = \`
        <div>• Ngân hàng: <b>\${s.bankInfo.bank_code || ''}</b></div>
        <div>• Số tài khoản: <b>\${s.bankInfo.account_no || ''}</b></div>
        <div>• Chủ tài khoản: <b>\${s.bankInfo.account_holder || ''}</b></div>
        <div>• Số tiền: <b class="text-brand-600 text-sm">\${formatVND(s.finalAmount)}</b></div>
        <div>• Nội dung: <b>AN TRUA \${s.name}</b></div>
      \`;
      document.getElementById('qr-modal').classList.remove('hidden');
      lucide.createIcons();
    }

    function closeQrModal() {
      document.getElementById('qr-modal').classList.add('hidden');
    }

    // Copy Zalo / Slack text
    function copyZaloText() {
      const store = document.getElementById('input-store-name').value || 'Cơm trưa';
      const today = new Date().toLocaleDateString('vi-VN');
      let text = \`🍱 TIỀN CƠM TRƯA (\${store} - \${today})\\n--------------------------------\\n\`;

      currentSettlements.forEach((s, i) => {
        text += \`\${i + 1}. \${s.name}: \${formatVND(s.finalAmount)} (\${s.dishesStr})\\n\`;
        if (s.vietqrUrl) text += \`   👉 Quét QR: \${s.vietqrUrl}\\n\`;
      });

      if (currentSettlements.length && currentSettlements[0].bankInfo) {
        const b = currentSettlements[0].bankInfo;
        text += \`--------------------------------\\nSTK: \${b.account_no} - \${b.bank_code} (\${b.account_holder})\\n\`;
      }

      navigator.clipboard.writeText(text).then(() => {
        alert('Đã copy bảng kê vào clipboard! Bạn có thể dán ngay vào Zalo hoặc Slack.');
      });
    }

    // Gửi email via Google Apps Script
    async function sendEmails() {
      const btn = document.getElementById('btn-send-emails');
      btn.disabled = true;
      btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i><span>Đang gửi mail qua Gmail...</span>';
      lucide.createIcons();

      const storeName = document.getElementById('input-store-name').value || 'Bữa trưa văn phòng';
      const dateStr = new Date().toLocaleDateString('vi-VN');

      const payload = {
        store_name: storeName,
        date: dateStr,
        members: currentSettlements.map(s => ({
          name: s.name,
          email: s.email,
          dish_name: s.dishesStr,
          original_price: s.original,
          discount: s.discount,
          shipping_fee: s.shipping,
          final_amount: s.finalAmount,
          vietqr_url: s.vietqrUrl,
          bank_info: s.bankInfo,
        })),
      };

      try {
        const res = await fetch('/api/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const result = await res.json();
        if (result.success) {
          alert('Thành công! Đã gửi email thông báo trực tiếp từ Gmail của bạn.');
        } else {
          alert('Không thể gửi mail: ' + result.error);
        }
      } catch (err) {
        alert('Lỗi: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="send" class="w-4 h-4"></i><span>Gửi Email Cá Nhân (Gmail)</span>';
        lucide.createIcons();
      }
    }

    // =========================================================================
    // MEMBERS MANAGEMENT
    // =========================================================================
    async function loadMembers() {
      try {
        const res = await fetch('/api/members');
        const data = await res.json();
        if (data.success) {
          membersList = data.data || [];
          renderMembersList();
        }
      } catch (err) {
        console.error('Lỗi tải danh bạ:', err);
      }
    }

    function renderMembersList() {
      const tbody = document.getElementById('members-list-tbody');
      tbody.innerHTML = '';
      if (!membersList.length) {
        tbody.innerHTML = '<tr><td colspan="3" class="p-4 text-center text-slate-400 text-xs">Chưa có thành viên nào. Hãy thêm ở trên!</td></tr>';
        return;
      }

      membersList.forEach(m => {
        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td class="p-3 font-semibold text-slate-800">\${m.name}</td>
          <td class="p-3 text-slate-600">\${m.email}</td>
          <td class="p-3 text-center">
            <button onclick="deleteMember(\${m.id})" class="text-slate-400 hover:text-red-500 p-1">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </td>
        \`;
        tbody.appendChild(tr);
      });
      lucide.createIcons();
    }

    async function addMember(e) {
      e.preventDefault();
      const name = document.getElementById('member-name-input').value.trim();
      const email = document.getElementById('member-email-input').value.trim();
      if (!name || !email) return;

      const res = await fetch('/api/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email }),
      });
      const data = await res.json();
      if (data.success) {
        document.getElementById('member-name-input').value = '';
        document.getElementById('member-email-input').value = '';
        loadMembers();
      } else {
        alert(data.error);
      }
    }

    async function deleteMember(id) {
      if (!confirm('Bạn chắc chắn muốn xóa thành viên này?')) return;
      await fetch('/api/members/' + id, { method: 'DELETE' });
      loadMembers();
    }

    // =========================================================================
    // PAYMENT ACCOUNTS & SETTINGS
    // =========================================================================
    async function loadPaymentAccounts() {
      try {
        const res = await fetch('/api/payment-accounts');
        const data = await res.json();
        if (data.success) {
          paymentAccounts = data.data || [];
          renderPaymentAccounts();
          updatePaymentSelect();
        }
      } catch (err) {
        console.error('Lỗi tải tài khoản:', err);
      }
    }

    function renderPaymentAccounts() {
      const container = document.getElementById('payment-accounts-list');
      container.innerHTML = '';
      if (!paymentAccounts.length) {
        container.innerHTML = '<div class="text-xs text-slate-400 text-center p-3">Chưa có tài khoản ngân hàng nào.</div>';
        return;
      }

      paymentAccounts.forEach(a => {
        const div = document.createElement('div');
        div.className = \`flex items-center justify-between p-3 rounded-xl border \${a.is_default ? 'border-brand-500 bg-brand-50/20' : 'border-slate-200 bg-white'}\`;
        div.innerHTML = \`
          <div class="flex items-center space-x-3">
            <div class="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center font-bold text-xs text-slate-700">
              \${a.bank_code}
            </div>
            <div>
              <div class="text-sm font-bold text-slate-900">\${a.account_no} (\${a.account_holder})</div>
              <div class="text-xs text-slate-500">\${a.bank_name || a.bank_code} \${a.is_default ? '• <span class="text-brand-600 font-semibold">Mặc định</span>' : ''}</div>
            </div>
          </div>
          <div class="flex items-center space-x-2">
            \${!a.is_default ? \`<button onclick="setDefaultAccount(\${a.id})" class="text-xs text-slate-600 hover:text-brand-600 px-2 py-1 rounded border border-slate-200">Đặt mặc định</button>\` : ''}
            <button onclick="deletePaymentAccount(\${a.id})" class="text-slate-400 hover:text-red-500 p-1">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </div>
        \`;
        container.appendChild(div);
      });
      lucide.createIcons();
    }

    function updatePaymentSelect() {
      const sel = document.getElementById('select-payment-account');
      if (!sel) return;
      sel.innerHTML = '';
      paymentAccounts.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = \`\${a.bank_code} - \${a.account_no} (\${a.account_holder})\` + (a.is_default ? ' [Mặc định]' : '');
        if (a.is_default) opt.selected = true;
        sel.appendChild(opt);
      });
    }

    async function addPaymentAccount(e) {
      e.preventDefault();
      const bank_code = document.getElementById('acc-bank-code').value;
      const bank_name = document.getElementById('acc-bank-code').selectedOptions[0].text;
      const account_no = document.getElementById('acc-no').value.trim();
      const account_holder = document.getElementById('acc-holder').value.trim();

      const res = await fetch('/api/payment-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bank_code, bank_name, account_no, account_holder, is_default: paymentAccounts.length === 0 }),
      });
      const data = await res.json();
      if (data.success) {
        document.getElementById('acc-no').value = '';
        document.getElementById('acc-holder').value = '';
        loadPaymentAccounts();
      } else {
        alert(data.error);
      }
    }

    async function setDefaultAccount(id) {
      await fetch('/api/payment-accounts/' + id + '/default', { method: 'PUT' });
      loadPaymentAccounts();
    }

    async function deletePaymentAccount(id) {
      if (!confirm('Xóa tài khoản này?')) return;
      await fetch('/api/payment-accounts/' + id, { method: 'DELETE' });
      loadPaymentAccounts();
    }

    // Settings
    async function loadSettings() {
      try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        if (data.success && data.data) {
          if (data.data.gas_url) document.getElementById('setting-gas-url').value = data.data.gas_url;
          if (data.data.admin_email) document.getElementById('setting-admin-email').value = data.data.admin_email;
        }
      } catch (err) {
        console.error('Lỗi tải cài đặt:', err);
      }
    }

    async function saveSettings() {
      const gas_url = document.getElementById('setting-gas-url').value.trim();
      const admin_email = document.getElementById('setting-admin-email').value.trim();
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gas_url, admin_email }),
      });
      const data = await res.json();
      if (data.success) {
        alert('Đã lưu cấu hình thành công!');
      } else {
        alert(data.error);
      }
    }

    // Initial Load
    loadPaymentAccounts();
    loadMembers();
  </script>
</body>
</html>`);
});

export default app;
