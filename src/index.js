import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

const app = new Hono();

app.use('*', cors());

// Helper: Format tiền tệ VND
function formatVND(num) {
  if (!num) return '0 đ';
  return Number(num).toLocaleString('vi-VN') + ' đ';
}

// ==============================================================================
// AUTHENTICATION & USER MANAGEMENT HELPERS (RBAC)
// ==============================================================================
const AUTH_SECRET = 'lunch_auth_secret_v2_2026';

async function hashPassword(password) {
  const data = new TextEncoder().encode(`salt_lunch_pw_${password}_2026`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function signTokenPayload(payloadObj) {
  const payloadStr = JSON.stringify(payloadObj);
  const b64Payload = btoa(unescape(encodeURIComponent(payloadStr)));
  const data = new TextEncoder().encode(`${AUTH_SECRET}:${b64Payload}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const sig = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `${b64Payload}.${sig}`;
}

async function verifyToken(c, token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [b64Payload, signature] = parts;

  try {
    const data = new TextEncoder().encode(`${AUTH_SECRET}:${b64Payload}`);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const expectedSig = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    if (signature !== expectedSig) return null;

    const jsonStr = decodeURIComponent(escape(atob(b64Payload)));
    const payload = JSON.parse(jsonStr);

    // Hết hạn sau 30 ngày
    const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - payload.timestamp > MAX_AGE_MS || payload.timestamp > Date.now() + 60000) {
      return null;
    }

    return payload;
  } catch (e) {
    return null;
  }
}

async function getSessionUser(c) {
  const token = getCookie(c, 'lunch_auth');
  return await verifyToken(c, token);
}

// Tự động khởi tạo bảng users, otp verifications và nạp tài khoản admin, guest demo mặc định
let usersTableChecked = false;
async function ensureUsersTableAndSeeds(db) {
  if (usersTableChecked) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'guest',
        full_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS email_verifications (
        email TEXT PRIMARY KEY,
        otp_code TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // 1. Tạo hoặc cập nhật tài khoản Admin phupx1
    const adminUser = await db.prepare("SELECT id FROM users WHERE username = 'phupx1'").first();
    const adminHash = await hashPassword('phupx1@1609');
    if (!adminUser) {
      await db.prepare(
        "INSERT INTO users (username, password_hash, role, full_name) VALUES ('phupx1', ?, 'admin', 'Alviss (Admin)')"
      ).bind(adminHash).run();
    } else {
      // Đảm bảo role admin và cập nhật mật khẩu phupx1@1609
      await db.prepare("UPDATE users SET role = 'admin', password_hash = ? WHERE username = 'phupx1'").bind(adminHash).run();
    }

    // 2. Tạo tài khoản Guest mặc định (oceanvo437@gmail.com) nếu chưa có
    const guestEmail = 'oceanvo437@gmail.com';
    const guestPassHash = await hashPassword('haivnt');
    const guestFullName = 'Võ Nguyễn Trung Hải';
    const existingGuest = await db.prepare("SELECT id FROM users WHERE username = ?").bind(guestEmail).first();
    if (!existingGuest) {
      await db.prepare(
        "INSERT INTO users (username, password_hash, role, full_name) VALUES (?, ?, 'guest', ?)"
      ).bind(guestEmail, guestPassHash, guestFullName).run();
    }

    // Đồng bộ tài khoản oceanvo437@gmail.com vào bảng members nếu tên chưa được cập nhật
    const existingMember = await db.prepare("SELECT id FROM members WHERE LOWER(email) = ?").bind(guestEmail).first();
    if (existingMember) {
      await db.prepare("UPDATE members SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(guestFullName, existingMember.id).run();
    } else {
      await db.prepare("INSERT INTO members (name, email) VALUES (?, ?)").bind(guestFullName, guestEmail).run();
    }

    usersTableChecked = true;
  } catch (err) {
    console.error('ensureUsersTableAndSeeds error:', err);
  }
}

// ------------------------------------------------------------------------------
// AUTH ENDPOINTS: OTP, Login, Register & Logout
// ------------------------------------------------------------------------------
app.post('/api/send-otp', async (c) => {
  try {
    await ensureUsersTableAndSeeds(c.env.DB);
    const { email } = await c.req.json();
    const cleanEmail = (email || '').trim().toLowerCase();

    if (!cleanEmail || !cleanEmail.includes('@') || !cleanEmail.includes('.')) {
      return c.json({ success: false, error: 'Địa chỉ email không hợp lệ' }, 400);
    }

    const existingUser = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(cleanEmail).first();
    if (existingUser) {
      return c.json({ success: false, error: 'Email này đã được đăng ký tài khoản. Vui lòng đăng nhập!' }, 400);
    }

    // Lấy GAS Web App URL để gửi email
    const gasSetting = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'gas_url'").first();
    const gasUrl = gasSetting ? gasSetting.value : null;

    if (!gasUrl) {
      return c.json({
        success: false,
        error: 'Hệ thống chưa cấu hình Google Apps Script để gửi email OTP. Vui lòng liên hệ Admin.',
      }, 500);
    }

    const senderSetting = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'sender_name'").first();
    const senderName = senderSetting && senderSetting.value ? senderSetting.value : 'Cơm Trưa Đồng Nghiệp';

    // Tạo mã OTP ngẫu nhiên 6 chữ số
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000; // Hiệu lực 5 phút

    // Lưu vào bảng email_verifications
    await c.env.DB.prepare(
      `INSERT INTO email_verifications (email, otp_code, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET otp_code = excluded.otp_code, expires_at = excluded.expires_at, created_at = CURRENT_TIMESTAMP`
    ).bind(cleanEmail, otpCode, expiresAt).run();

    // Gọi Google Apps Script để gửi mail OTP
    const mailRes = await fetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'send_otp',
        email: cleanEmail,
        otp: otpCode,
        sender_name: senderName,
      }),
    });

    const mailData = await mailRes.json();
    if (!mailData.success) {
      return c.json({ success: false, error: 'Không thể gửi email OTP: ' + (mailData.error || 'Lỗi Mailer') }, 500);
    }

    return c.json({ success: true, message: 'Đã gửi mã xác thực OTP tới ' + cleanEmail + '. Vui lòng kiểm tra hộp thư!' });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

app.post('/api/login', async (c) => {
  try {
    await ensureUsersTableAndSeeds(c.env.DB);
    const { email, password } = await c.req.json();
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanPw = (password || '').trim();

    if (!cleanEmail || !cleanPw) {
      return c.json({ success: false, error: 'Vui lòng nhập Email và mật khẩu' }, 400);
    }

    // Chỉ cho phép đăng nhập bằng định dạng email (hoặc tài khoản admin phupx1)
    if (!cleanEmail.includes('@') && cleanEmail !== 'phupx1') {
      return c.json({ success: false, error: 'Hệ thống chỉ cho phép đăng nhập bằng Email!' }, 400);
    }

    const user = await c.env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(cleanEmail).first();
    if (!user) {
      return c.json({ success: false, error: 'Email hoặc mật khẩu không chính xác' }, 401);
    }

    const inputHash = await hashPassword(cleanPw);
    if (inputHash !== user.password_hash) {
      return c.json({ success: false, error: 'Email hoặc mật khẩu không chính xác' }, 401);
    }

    const payload = {
      id: user.id,
      username: user.username,
      role: user.role,
      full_name: user.full_name || user.username,
      timestamp: Date.now(),
    };

    const token = await signTokenPayload(payload);

    setCookie(c, 'lunch_auth', token, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 30 * 24 * 60 * 60, // 30 ngày
    });

    return c.json({ success: true, message: 'Đăng nhập thành công', user: payload });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

app.post('/api/register', async (c) => {
  try {
    await ensureUsersTableAndSeeds(c.env.DB);
    const { email, otp, password, full_name } = await c.req.json();
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanOtp = (otp || '').trim();
    const cleanPw = (password || '').trim();
    const cleanName = (full_name || '').trim();

    if (!cleanEmail || !cleanEmail.includes('@') || !cleanEmail.includes('.')) {
      return c.json({ success: false, error: 'Vui lòng nhập địa chỉ Email hợp lệ' }, 400);
    }

    if (!cleanOtp) {
      return c.json({ success: false, error: 'Vui lòng nhập mã xác thực OTP đã gửi về email' }, 400);
    }

    if (!cleanPw || cleanPw.length < 6) {
      return c.json({ success: false, error: 'Mật khẩu phải có độ dài từ 6 ký tự trở lên' }, 400);
    }

    // Kiểm tra OTP trong bảng email_verifications
    const record = await c.env.DB.prepare('SELECT * FROM email_verifications WHERE email = ?').bind(cleanEmail).first();
    if (!record) {
      return c.json({ success: false, error: 'Chưa có mã OTP nào được gửi cho email này. Vui lòng bấm "Gửi mã OTP"!' }, 400);
    }

    if (Date.now() > record.expires_at) {
      return c.json({ success: false, error: 'Mã OTP đã hết hạn (5 phút). Vui lòng yêu cầu gửi mã mới!' }, 400);
    }

    if (record.otp_code !== cleanOtp) {
      return c.json({ success: false, error: 'Mã xác thực OTP không chính xác' }, 400);
    }

    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(cleanEmail).first();
    if (existing) {
      return c.json({ success: false, error: 'Email này đã được đăng ký tài khoản' }, 400);
    }

    // Luôn luôn tạo với quyền guest
    const role = 'guest';
    const passwordHash = await hashPassword(cleanPw);
    const memberName = cleanName || cleanEmail;

    const info = await c.env.DB.prepare(
      'INSERT INTO users (username, password_hash, role, full_name) VALUES (?, ?, ?, ?)'
    ).bind(cleanEmail, passwordHash, role, memberName).run();

    // Đồng bộ vào Account Section (bảng members):
    // Nếu email đã tồn tại trong members -> chỉ cập nhật lại Tên thành viên (name).
    // Nếu email chưa có -> thêm mới một dòng (name, email).
    const existingMember = await c.env.DB.prepare(
      'SELECT id, name FROM members WHERE LOWER(email) = ?'
    ).bind(cleanEmail).first();

    if (existingMember) {
      if (cleanName && cleanName !== existingMember.name) {
        await c.env.DB.prepare(
          'UPDATE members SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).bind(cleanName, existingMember.id).run();
      }
    } else {
      await c.env.DB.prepare(
        'INSERT INTO members (name, email) VALUES (?, ?)'
      ).bind(memberName, cleanEmail).run();
    }

    // Xóa record verification sau khi đăng ký thành công
    await c.env.DB.prepare('DELETE FROM email_verifications WHERE email = ?').bind(cleanEmail).run();

    const payload = {
      id: info.meta.last_row_id,
      username: cleanEmail,
      role: role,
      full_name: cleanName || cleanEmail,
      timestamp: Date.now(),
    };

    const token = await signTokenPayload(payload);

    setCookie(c, 'lunch_auth', token, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 30 * 24 * 60 * 60,
    });

    return c.json({ success: true, message: 'Đăng ký tài khoản thành công', user: payload });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

app.post('/api/logout', async (c) => {
  deleteCookie(c, 'lunch_auth', { path: '/' });
  return c.json({ success: true, message: 'Đã đăng xuất' });
});

// Endpoint trả về thông tin user hiện tại
app.get('/api/me', async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ success: false, error: 'Chưa đăng nhập' }, 401);
  return c.json({ success: true, user });
});

// API Quản lý danh sách Users (Chỉ dành riêng cho Admin)
app.get('/api/users', async (c) => {
  const user = await getSessionUser(c);
  if (!user || user.role !== 'admin') {
    return c.json({ success: false, error: 'Forbidden: Bạn không có quyền quản lý người dùng' }, 403);
  }
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT id, username, role, full_name, created_at FROM users ORDER BY role ASC, id ASC'
    ).all();
    return c.json({ success: true, data: results });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

app.delete('/api/users/:id', async (c) => {
  const user = await getSessionUser(c);
  if (!user || user.role !== 'admin') {
    return c.json({ success: false, error: 'Forbidden: Bạn không có quyền xóa người dùng' }, 403);
  }
  try {
    const id = c.req.param('id');
    const target = await c.env.DB.prepare('SELECT username, role FROM users WHERE id = ?').bind(id).first();
    if (!target) return c.json({ success: false, error: 'Tài khoản không tồn tại' }, 404);
    if (target.role === 'admin' || target.username === 'phupx1') {
      return c.json({ success: false, error: 'Không thể xóa tài khoản Admin hệ thống' }, 400);
    }
    await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
    return c.json({ success: true, message: 'Đã xóa người dùng' });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

// ------------------------------------------------------------------------------
// MIDDLEWARE: Khóa /api/* và kiểm tra phân quyền RBAC
// ------------------------------------------------------------------------------
app.use('/api/*', async (c, next) => {
  const path = c.req.path;
  const method = c.req.method;

  // 1. Cho phép Public APIs
  if (
    path === '/api/login' ||
    path === '/api/register' ||
    path === '/api/send-otp' ||
    path === '/api/logout' ||
    (path.startsWith('/api/payment-accounts/') && path.endsWith('/qr'))
  ) {
    return await next();
  }

  // 2. Kiểm tra Authentication
  const sessionUser = await getSessionUser(c);
  if (!sessionUser) {
    return c.json({
      success: false,
      error: 'Unauthorized: Bạn cần đăng nhập để thực hiện thao tác này',
    }, 401);
  }

  // Gắn sessionUser vào context Hono để tiện dùng
  c.set('sessionUser', sessionUser);

  // 3. Phân quyền RBAC (Role-Based Access Control):
  // Admin được làm mọi thứ.
  // Guest được:
  // - POST /api/scan
  // - POST /api/notify
  // - GET /api/members (chỉ đọc)
  // - Toàn quyền cấu hình tài khoản thanh toán cá nhân (GET, POST, PUT default, DELETE /api/payment-accounts*)
  // - GET /api/me
  if (sessionUser.role !== 'admin') {
    const isGuestAllowed =
      (path === '/api/scan' && method === 'POST') ||
      (path === '/api/notify' && method === 'POST') ||
      (path === '/api/members' && method === 'GET') ||
      path.startsWith('/api/payment-accounts') ||
      (path === '/api/me' && method === 'GET');

    if (!isGuestAllowed) {
      return c.json({
        success: false,
        error: 'Forbidden: Bạn chỉ có quyền Guest. Không được phép chỉnh sửa danh bạ hoặc cài đặt hệ thống!',
      }, 403);
    }
  }

  return await next();
});

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
// Helper migration: đảm bảo cột payment_link tồn tại trong bảng payment_accounts
async function ensurePaymentLinkCol(db) {
  try {
    await db.prepare('ALTER TABLE payment_accounts ADD COLUMN payment_link TEXT').run();
  } catch (_) {}
}

app.get('/api/payment-accounts', async (c) => {
  try {
    await ensurePaymentLinkCol(c.env.DB);
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
    await ensurePaymentLinkCol(c.env.DB);
    const { bank_code, bank_name, account_no, account_holder, is_default, qr_image_base64, payment_link } = await c.req.json();
    if (!bank_code || !account_no || !account_holder) {
      return c.json({ success: false, error: 'Thiếu thông tin tài khoản' }, 400);
    }

    let qrR2Key = null;
    if (qr_image_base64 && c.env.BUCKET) {
      try {
        let contentType = 'image/png';
        let rawB64 = qr_image_base64;
        if (qr_image_base64.includes(';base64,')) {
          const parts = qr_image_base64.split(';base64,');
          contentType = parts[0].replace('data:', '') || 'image/png';
          rawB64 = parts[1];
        }
        const binaryStr = atob(rawB64);
        const len = binaryStr.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }

        const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : 'png';
        qrR2Key = `qr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.${ext}`;
        await c.env.BUCKET.put(qrR2Key, bytes, {
          httpMetadata: { contentType },
        });
      } catch (uploadErr) {
        console.error('Lỗi lưu ảnh QR vào R2:', uploadErr);
      }
    }

    if (is_default) {
      await c.env.DB.prepare('UPDATE payment_accounts SET is_default = 0').run();
    }

    const cleanPaymentLink = (payment_link || '').trim() || null;
    const info = await c.env.DB.prepare(
      `INSERT INTO payment_accounts (bank_code, bank_name, account_no, account_holder, is_default, qr_r2_key, payment_link)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(bank_code.trim(), (bank_name || bank_code).trim(), account_no.trim(), account_holder.trim().toUpperCase(), is_default ? 1 : 0, qrR2Key, cleanPaymentLink).run();

    return c.json({ success: true, message: 'Đã thêm tài khoản thanh toán', id: info.meta.last_row_id });
  } catch (err) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

// Endpoint trả về ảnh QR cá nhân lưu trong R2
app.get('/api/payment-accounts/:id/qr', async (c) => {
  try {
    const id = c.req.param('id');
    const account = await c.env.DB.prepare(
      'SELECT qr_r2_key FROM payment_accounts WHERE id = ?'
    ).bind(id).first();

    if (!account || !account.qr_r2_key) {
      return c.text('Không tìm thấy mã QR', 404);
    }

    if (!c.env.BUCKET) {
      return c.text('R2 Storage chưa được cấu hình', 500);
    }

    const object = await c.env.BUCKET.get(account.qr_r2_key);
    if (!object) {
      return c.text('File ảnh không tồn tại trong lưu trữ', 404);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('Cache-Control', 'public, max-age=86400');
    if (!headers.get('content-type')) {
      headers.set('content-type', 'image/png');
    }

    return new Response(object.body, { headers });
  } catch (err) {
    return c.text('Lỗi lấy ảnh QR: ' + err.message, 500);
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
    const account = await c.env.DB.prepare('SELECT qr_r2_key FROM payment_accounts WHERE id = ?').bind(id).first();
    if (account && account.qr_r2_key && c.env.BUCKET) {
      try {
        await c.env.BUCKET.delete(account.qr_r2_key);
      } catch (e) {
        console.error('Lỗi xóa file QR trong R2:', e);
      }
    }
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
      if (k === 'app_password' && v) {
        // Cập nhật mật khẩu tài khoản Admin phupx1 trong bảng users
        const newHash = await hashPassword(String(v).trim());
        await c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE username = 'phupx1'").bind(newHash).run();
      }
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
// 4. API: SCAN BILL (Gọi Scanner Bridge trên VPS - Hỗ trợ nhiều ảnh)
// ==============================================================================
app.post('/api/scan', async (c) => {
  try {
    const body = await c.req.json();
    let images = body.images_base64 || [];
    if (!images.length && body.image_base64) {
      images = [body.image_base64];
    }
    if (!images.length) {
      return c.json({ success: false, error: 'Thiếu dữ liệu ảnh' }, 400);
    }

    // 1. Lưu các ảnh vào Cloudflare R2
    let imageR2Keys = [];
    if (c.env.BUCKET) {
      for (let i = 0; i < images.length; i++) {
        try {
          const rawB64 = images[i].includes(',') ? images[i].split(',')[1] : images[i];
          const binaryStr = atob(rawB64);
          const len = binaryStr.length;
          const bytes = new Uint8Array(len);
          for (let j = 0; j < len; j++) {
            bytes[j] = binaryStr.charCodeAt(j);
          }
          let contentType = 'image/webp';
          let ext = 'webp';
          if (images[i].includes('image/png')) {
            contentType = 'image/png';
            ext = 'png';
          } else if (images[i].includes('image/jpeg')) {
            contentType = 'image/jpeg';
            ext = 'jpg';
          }
          const key = `bill_${Date.now()}_part${i + 1}_${Math.random().toString(36).substring(2, 6)}.${ext}`;
          await c.env.BUCKET.put(key, bytes, {
            httpMetadata: { contentType },
          });
          imageR2Keys.push(key);
        } catch (r2Err) {
          console.error('Lỗi lưu R2:', r2Err);
        }
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
        images_base64: images,
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
      image_r2_keys: imageR2Keys,
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

    let gasUrl = payload.gas_url;
    let adminEmail = payload.admin_email;
    let senderName = payload.sender_name;

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

    if (!senderName) {
      const row = await c.env.DB.prepare(
        "SELECT value FROM app_settings WHERE key = 'sender_name'"
      ).first();
      if (row && row.value) senderName = row.value;
    }

    if (!gasUrl) {
      return c.json({
        success: false,
        error: 'Chưa cấu hình Google Apps Script URL. Vui lòng vào Tab "Cài Đặt" để điền URL Web App!',
      }, 400);
    }

    payload.admin_email = adminEmail || '';
    payload.sender_name = senderName || 'Cơm Trưa Đồng Nghiệp';

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
// 6. FRONTEND: LOGIN & REGISTER PAGE & MAIN WEB APP
// ==============================================================================
function renderLoginPage() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Đăng Nhập / Đăng Ký — Bill Splitter</title>
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
    .auth-tab.active {
      background-color: #ffffff;
      color: #ea580c;
      font-weight: 700;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    }
  </style>
</head>
<body class="bg-gradient-to-br from-slate-100 via-orange-50/40 to-slate-100 text-slate-800 min-h-screen flex items-center justify-center p-4 font-sans antialiased">
  <div class="max-w-md w-full bg-white rounded-3xl p-6 sm:p-8 border border-slate-200 shadow-xl space-y-6">
    <div class="text-center space-y-2">
      <div class="w-14 h-14 rounded-2xl bg-gradient-to-tr from-brand-600 to-amber-500 mx-auto flex items-center justify-center text-white shadow-lg shadow-brand-500/30">
        <i data-lucide="receipt" class="w-7 h-7"></i>
      </div>
      <h1 class="text-2xl font-bold text-slate-900">Bill Splitter</h1>
      <p class="text-xs text-slate-500">Hệ thống bóc tách hóa đơn & chia tiền ăn trưa nội bộ</p>
    </div>

    <!-- Auth Tabs Switcher -->
    <div class="bg-slate-100 p-1 rounded-2xl grid grid-cols-2 text-xs sm:text-sm font-medium text-slate-500">
      <button type="button" id="tab-btn-login" onclick="switchAuthTab('login')" class="auth-tab active py-2.5 rounded-xl transition-all flex items-center justify-center space-x-1.5 cursor-pointer">
        <i data-lucide="log-in" class="w-4 h-4"></i>
        <span>Đăng Nhập</span>
      </button>
      <button type="button" id="tab-btn-register" onclick="switchAuthTab('register')" class="auth-tab py-2.5 rounded-xl transition-all flex items-center justify-center space-x-1.5 cursor-pointer">
        <i data-lucide="user-plus" class="w-4 h-4"></i>
        <span>Đăng Ký Mới</span>
      </button>
    </div>

    <!-- Alert Box -->
    <div id="auth-alert" class="hidden p-3 rounded-xl text-xs flex items-center space-x-2">
      <i id="auth-alert-icon" data-lucide="alert-circle" class="w-4 h-4 shrink-0"></i>
      <span id="auth-alert-msg"></span>
    </div>

    <!-- FORM 1: LOGIN -->
    <form id="form-login" onsubmit="handleLogin(event)" class="space-y-4">
      <div class="space-y-1.5">
        <label for="login-email" class="block text-xs font-semibold text-slate-700">Email của bạn</label>
        <div class="relative">
          <input type="text" id="login-email" required autofocus placeholder="Ví dụ: oceanvo437@gmail.com" class="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 pl-10 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 transition-all lowercase">
          <i data-lucide="mail" class="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5 pointer-events-none"></i>
        </div>
      </div>

      <div class="space-y-1.5">
        <label for="login-password" class="block text-xs font-semibold text-slate-700">Mật khẩu</label>
        <div class="relative">
          <input type="password" id="login-password" required placeholder="Nhập mật khẩu..." class="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 pl-10 pr-10 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 transition-all">
          <i data-lucide="lock" class="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5 pointer-events-none"></i>
          <button type="button" onclick="togglePasswordVisibility('login-password', 'login-eye-icon')" class="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600 cursor-pointer">
            <i id="login-eye-icon" data-lucide="eye" class="w-4 h-4"></i>
          </button>
        </div>
      </div>

      <button type="submit" id="btn-login" class="w-full bg-brand-600 hover:bg-brand-700 text-white font-semibold py-3 rounded-xl text-sm shadow-md shadow-brand-600/25 transition-all flex items-center justify-center space-x-2 cursor-pointer">
        <i data-lucide="lock-open" class="w-4 h-4"></i>
        <span>Đăng Nhập</span>
      </button>

      <div class="p-3 bg-amber-50/70 rounded-xl border border-amber-200/60 text-[11px] text-amber-800 space-y-1">
        <p class="font-semibold flex items-center space-x-1">
          <i data-lucide="info" class="w-3.5 h-3.5 text-amber-600"></i>
          <span>Tài khoản Guest mặc định:</span>
        </p>
        <p>Email: <code class="bg-amber-100/80 px-1 py-0.5 rounded font-mono font-bold">oceanvo437@gmail.com</code> — Mật khẩu: <code class="bg-amber-100/80 px-1 py-0.5 rounded font-mono font-bold">haivnt</code></p>
      </div>
    </form>

    <!-- FORM 2: REGISTER -->
    <form id="form-register" onsubmit="handleRegister(event)" class="hidden space-y-4">
      <div class="space-y-1.5">
        <label for="reg-email" class="block text-xs font-semibold text-slate-700">Địa chỉ Email</label>
        <div class="flex gap-2">
          <div class="relative flex-1">
            <input type="email" id="reg-email" required placeholder="name@company.com" class="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 pl-10 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 transition-all lowercase">
            <i data-lucide="mail" class="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5 pointer-events-none"></i>
          </div>
          <button type="button" id="btn-send-otp" onclick="handleSendOtp()" class="bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold px-3.5 py-2.5 rounded-xl transition-all flex items-center space-x-1 cursor-pointer shrink-0 shadow-sm">
            <i data-lucide="send" class="w-3.5 h-3.5"></i>
            <span>Gửi OTP</span>
          </button>
        </div>
        <p id="otp-timer-msg" class="text-[11px] text-slate-400 hidden"></p>
      </div>

      <div class="space-y-1.5">
        <label for="reg-otp" class="block text-xs font-semibold text-slate-700">Mã xác thực OTP (6 số)</label>
        <div class="relative">
          <input type="text" id="reg-otp" required maxlength="6" placeholder="Ví dụ: 123456" class="w-full text-sm font-mono tracking-widest border border-slate-200 rounded-xl px-4 py-3 pl-10 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 transition-all">
          <i data-lucide="shield-check" class="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5 pointer-events-none"></i>
        </div>
      </div>

      <div class="space-y-1.5">
        <label for="reg-fullname" class="block text-xs font-semibold text-slate-700">Họ và tên của bạn</label>
        <div class="relative">
          <input type="text" id="reg-fullname" required placeholder="Ví dụ: Võ Nguyễn Trung Hải" class="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 pl-10 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 transition-all">
          <i data-lucide="user" class="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5 pointer-events-none"></i>
        </div>
      </div>

      <div class="space-y-1.5">
        <label for="reg-password" class="block text-xs font-semibold text-slate-700">Mật khẩu (tối thiểu 6 ký tự)</label>
        <div class="relative">
          <input type="password" id="reg-password" required minlength="6" placeholder="Tạo mật khẩu..." class="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 pl-10 pr-10 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 transition-all">
          <i data-lucide="key" class="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5 pointer-events-none"></i>
          <button type="button" onclick="togglePasswordVisibility('reg-password', 'reg-eye-icon')" class="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600 cursor-pointer">
            <i id="reg-eye-icon" data-lucide="eye" class="w-4 h-4"></i>
          </button>
        </div>
      </div>

      <div class="space-y-1.5">
        <label for="reg-password-confirm" class="block text-xs font-semibold text-slate-700">Nhập lại mật khẩu</label>
        <div class="relative">
          <input type="password" id="reg-password-confirm" required minlength="6" placeholder="Xác nhận lại mật khẩu..." class="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 pl-10 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 transition-all">
          <i data-lucide="check-circle" class="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5 pointer-events-none"></i>
        </div>
      </div>

      <button type="submit" id="btn-register" class="w-full bg-slate-900 hover:bg-black text-white font-semibold py-3 rounded-xl text-sm shadow-md transition-all flex items-center justify-center space-x-2 cursor-pointer">
        <i data-lucide="user-plus" class="w-4 h-4"></i>
        <span>Xác Nhận & Đăng Ký</span>
      </button>

      <p class="text-[11px] text-slate-400 text-center leading-relaxed">
        Tài khoản Guest được phép cấu hình tài khoản thanh toán riêng, scan bill và chia tiền.
      </p>
    </form>

    <div class="text-center pt-2">
      <p class="text-[11px] text-slate-400 flex items-center justify-center space-x-1">
        <i data-lucide="shield-check" class="w-3.5 h-3.5 text-emerald-500"></i>
        <span>Phiên đăng nhập được lưu an toàn 30 ngày</span>
      </p>
    </div>
  </div>

  <script>
    lucide.createIcons();

    function switchAuthTab(mode) {
      clearAlert();
      const tabLogin = document.getElementById('tab-btn-login');
      const tabReg = document.getElementById('tab-btn-register');
      const formLogin = document.getElementById('form-login');
      const formReg = document.getElementById('form-register');

      if (mode === 'login') {
        tabLogin.classList.add('active');
        tabReg.classList.remove('active');
        formLogin.classList.remove('hidden');
        formReg.classList.add('hidden');
        document.getElementById('login-email').focus();
      } else {
        tabReg.classList.add('active');
        tabLogin.classList.remove('active');
        formReg.classList.remove('hidden');
        formLogin.classList.add('hidden');
        document.getElementById('reg-email').focus();
      }
      lucide.createIcons();
    }

    function showAlert(msg, isSuccess = false) {
      const box = document.getElementById('auth-alert');
      const text = document.getElementById('auth-alert-msg');
      text.textContent = msg;
      box.className = 'p-3 rounded-xl text-xs flex items-center space-x-2 ' +
        (isSuccess ? 'bg-emerald-50 border border-emerald-200 text-emerald-700' : 'bg-red-50 border border-red-200 text-red-600');
      box.classList.remove('hidden');
      lucide.createIcons();
    }

    function clearAlert() {
      const box = document.getElementById('auth-alert');
      box.classList.add('hidden');
    }

    function togglePasswordVisibility(inputId, iconId) {
      const input = document.getElementById(inputId);
      const icon = document.getElementById(iconId);
      if (input.type === 'password') {
        input.type = 'text';
        icon.setAttribute('data-lucide', 'eye-off');
      } else {
        input.type = 'password';
        icon.setAttribute('data-lucide', 'eye');
      }
      lucide.createIcons();
    }

    let otpCooldown = 0;
    let otpTimerInterval = null;

    async function handleSendOtp() {
      clearAlert();
      const emailInput = document.getElementById('reg-email');
      const cleanEmail = emailInput.value.trim().toLowerCase();
      const btn = document.getElementById('btn-send-otp');
      const msgTimer = document.getElementById('otp-timer-msg');

      if (!cleanEmail || !cleanEmail.includes('@') || !cleanEmail.includes('.')) {
        showAlert('Vui lòng nhập địa chỉ email hợp lệ trước khi gửi mã OTP!');
        emailInput.focus();
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i><span>Đang gửi...</span>';
      lucide.createIcons();

      try {
        const res = await fetch('/api/send-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: cleanEmail }),
        });
        const data = await res.json();
        if (data.success) {
          showAlert(data.message, true);
          document.getElementById('reg-otp').focus();

          // Khởi động bộ đếm 60 giây gửi lại
          otpCooldown = 60;
          msgTimer.classList.remove('hidden');
          msgTimer.textContent = 'Mã đã gửi! Bạn có thể gửi lại sau 60s.';
          clearInterval(otpTimerInterval);
          otpTimerInterval = setInterval(() => {
            otpCooldown--;
            if (otpCooldown <= 0) {
              clearInterval(otpTimerInterval);
              btn.disabled = false;
              btn.innerHTML = '<i data-lucide="send" class="w-3.5 h-3.5"></i><span>Gửi OTP</span>';
              msgTimer.classList.add('hidden');
              lucide.createIcons();
            } else {
              btn.innerHTML = '<span>' + otpCooldown + 's</span>';
              msgTimer.textContent = 'Bạn có thể gửi lại mã sau ' + otpCooldown + 's.';
            }
          }, 1000);
        } else {
          showAlert(data.error || 'Không thể gửi mã OTP');
          btn.disabled = false;
          btn.innerHTML = '<i data-lucide="send" class="w-3.5 h-3.5"></i><span>Gửi OTP</span>';
          lucide.createIcons();
        }
      } catch (err) {
        showAlert('Lỗi gửi OTP: ' + err.message);
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="send" class="w-3.5 h-3.5"></i><span>Gửi OTP</span>';
        lucide.createIcons();
      }
    }

    async function handleLogin(e) {
      e.preventDefault();
      clearAlert();
      const emailInput = document.getElementById('login-email');
      const pwInput = document.getElementById('login-password');
      const btn = document.getElementById('btn-login');

      btn.disabled = true;
      btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i><span>Đang đăng nhập...</span>';
      lucide.createIcons();

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: emailInput.value.trim(),
            password: pwInput.value.trim(),
          }),
        });
        const data = await res.json();
        if (data.success) {
          window.location.reload();
        } else {
          showAlert(data.error || 'Email hoặc mật khẩu không chính xác!');
          pwInput.focus();
          pwInput.select();
        }
      } catch (err) {
        showAlert('Lỗi kết nối máy chủ: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="lock-open" class="w-4 h-4"></i><span>Đăng Nhập</span>';
        lucide.createIcons();
      }
    }

    async function handleRegister(e) {
      e.preventDefault();
      clearAlert();
      const emailInput = document.getElementById('reg-email');
      const otpInput = document.getElementById('reg-otp');
      const nameInput = document.getElementById('reg-fullname');
      const pwInput = document.getElementById('reg-password');
      const cfInput = document.getElementById('reg-password-confirm');
      const btn = document.getElementById('btn-register');

      if (pwInput.value !== cfInput.value) {
        showAlert('Mật khẩu nhập lại không khớp!');
        cfInput.focus();
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i><span>Đang xác nhận...</span>';
      lucide.createIcons();

      try {
        const res = await fetch('/api/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: emailInput.value.trim(),
            otp: otpInput.value.trim(),
            full_name: nameInput.value.trim(),
            password: pwInput.value.trim(),
          }),
        });
        const data = await res.json();
        if (data.success) {
          showAlert('Đăng ký thành công! Đang vào ứng dụng...', true);
          setTimeout(() => {
            window.location.reload();
          }, 600);
        } else {
          showAlert(data.error || 'Không thể đăng ký tài khoản!');
        }
      } catch (err) {
        showAlert('Lỗi kết nối máy chủ: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="user-plus" class="w-4 h-4"></i><span>Xác Nhận & Đăng Ký</span>';
        lucide.createIcons();
      }
    }
  </script>
</body>
</html>`;
}

app.get('*', async (c) => {
  await ensureUsersTableAndSeeds(c.env.DB);
  const sessionUser = await getSessionUser(c);
  if (!sessionUser) {
    return c.html(renderLoginPage());
  }

  const isAdmin = sessionUser.role === 'admin';
  const displayName = sessionUser.full_name || sessionUser.username;
  const username = sessionUser.username;
  const roleName = isAdmin ? 'Admin' : 'Guest';

  return c.html(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bill Splitter — Quản Lý & Chia Tiền Cơm Trưa</title>
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
<body class="bg-slate-50 text-slate-800 min-h-screen flex flex-col font-sans antialiased overflow-x-hidden">

  <!-- Header -->
  <header class="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-sm">
    <div class="max-w-5xl mx-auto px-3 sm:px-4 py-2.5 sm:py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 sm:gap-3">
      <!-- Top Row on Mobile: Logo & App Title + User info + Logout Button -->
      <div class="flex items-center justify-between w-full sm:w-auto">
        <div class="flex items-center space-x-2.5">
          <div class="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-tr from-brand-600 to-amber-500 flex items-center justify-center text-white shadow-md shadow-brand-500/20 shrink-0">
            <i data-lucide="receipt" class="w-5 h-5"></i>
          </div>
          <div>
            <div class="flex items-center space-x-1.5">
              <h1 class="text-base sm:text-lg font-bold text-slate-900 leading-tight">Bill Splitter</h1>
              <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold ${isAdmin ? 'bg-amber-100 text-amber-800 border border-amber-300' : 'bg-slate-100 text-slate-700 border border-slate-200'}">
                ${isAdmin ? '👑 ADMIN' : '👤 GUEST'}
              </span>
            </div>
            <p class="text-[11px] sm:text-xs text-slate-500 flex items-center space-x-1">
              <span>Xin chào, <b>${displayName}</b> (${username})</span>
            </p>
          </div>
        </div>

        <!-- Logout button on mobile -->
        <button type="button" onclick="logout()" title="Đăng xuất" class="sm:hidden px-2.5 py-1.5 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-xl transition-colors cursor-pointer border border-slate-200 flex items-center space-x-1 text-xs font-semibold shadow-xs">
          <i data-lucide="log-out" class="w-3.5 h-3.5"></i>
          <span>Thoát</span>
        </button>
      </div>

      <!-- Navigation Tabs & Desktop Logout -->
      <div class="flex items-center space-x-2 w-full sm:w-auto">
        <nav class="flex space-x-1 bg-slate-100 p-1 rounded-xl text-xs sm:text-sm font-medium w-full sm:w-auto">
          <button onclick="switchTab('splitter')" id="tab-btn-splitter" class="tab-btn active px-2 sm:px-3.5 py-1.5 rounded-lg transition-all flex items-center justify-center space-x-1 sm:space-x-1.5 cursor-pointer flex-1 sm:flex-initial">
            <i data-lucide="calculator" class="w-3.5 h-3.5 sm:w-4 sm:h-4"></i>
            <span>Bill Split</span>
          </button>
          ${isAdmin ? `
          <button onclick="switchTab('members')" id="tab-btn-members" class="tab-btn px-2 sm:px-3.5 py-1.5 rounded-lg text-slate-600 hover:text-slate-900 transition-all flex items-center justify-center space-x-1 sm:space-x-1.5 cursor-pointer flex-1 sm:flex-initial">
            <i data-lucide="users" class="w-3.5 h-3.5 sm:w-4 sm:h-4"></i>
            <span>Accounts</span>
          </button>
          ` : ''}
          <button onclick="switchTab('settings')" id="tab-btn-settings" class="tab-btn px-2 sm:px-3.5 py-1.5 rounded-lg text-slate-600 hover:text-slate-900 transition-all flex items-center justify-center space-x-1 sm:space-x-1.5 cursor-pointer flex-1 sm:flex-initial">
            <i data-lucide="settings" class="w-3.5 h-3.5 sm:w-4 sm:h-4"></i>
            <span>Settings</span>
          </button>
        </nav>

        <!-- Logout button on desktop -->
        <button type="button" onclick="logout()" title="Đăng xuất" class="hidden sm:flex p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-colors cursor-pointer border border-transparent hover:border-red-100 items-center space-x-1 text-xs font-medium shrink-0">
          <i data-lucide="log-out" class="w-4 h-4"></i>
          <span>Thoát</span>
        </button>
      </div>
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
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 class="text-base font-semibold text-slate-900 flex items-center space-x-2">
              <span class="flex items-center justify-center w-6 h-6 rounded-full bg-brand-100 text-brand-700 text-xs font-bold">1</span>
              <span>Tải Hóa Đơn ShopeeFood / GrabFood</span>
            </h2>
            <p class="text-xs text-slate-500 mt-0.5">Hỗ trợ tải 1 hoặc nhiều ảnh chụp nối tiếp nếu hóa đơn dài. Dán trực tiếp (Ctrl + V) hoặc bấm nút.</p>
          </div>
          <button type="button" onclick="document.getElementById('file-input').click()" class="self-start sm:self-auto bg-brand-50 hover:bg-brand-100 text-brand-700 font-semibold px-4 py-2 rounded-xl text-sm border border-brand-200 transition-all flex items-center space-x-2 cursor-pointer shadow-sm">
            <i data-lucide="upload" class="w-4 h-4"></i>
            <span>Chọn ảnh hóa đơn</span>
          </button>
        </div>

        <input type="file" id="file-input" accept="image/*" multiple class="hidden">

        <!-- Drop zone: Click to upload when empty -->
        <div id="drop-zone" onclick="document.getElementById('file-input').click()" class="border-2 border-dashed border-slate-300 hover:border-brand-500 rounded-xl p-8 text-center transition-colors cursor-pointer bg-slate-50/50 hover:bg-brand-50/20">
          <div id="drop-prompt" class="space-y-3">
            <div class="w-12 h-12 rounded-full bg-brand-50 text-brand-600 mx-auto flex items-center justify-center">
              <i data-lucide="image-up" class="w-6 h-6"></i>
            </div>
            <div class="text-sm text-slate-600">
              <span class="font-semibold text-brand-600 hover:underline">Bấm để chọn 1 hoặc nhiều ảnh</span> hoặc kéo ảnh vào đây
            </div>
            <p class="text-xs text-slate-400">Hỗ trợ PNG, JPG, JPEG, WebP (Có thể chọn nhiều ảnh liên tiếp nếu hóa đơn dài)</p>
          </div>
        </div>

        <!-- Preview Gallery & Actions (OUTSIDE drop-zone to avoid pop-up bug) -->
        <div id="preview-container" class="hidden space-y-4 pt-2">
          <div class="flex items-center justify-between border-b border-slate-100 pb-2">
            <div class="text-sm font-semibold text-slate-700 flex items-center space-x-2">
              <i data-lucide="images" class="w-4 h-4 text-brand-600"></i>
              <span>Danh sách ảnh đã chọn (<span id="images-count">0</span> ảnh)</span>
            </div>
            <button type="button" onclick="document.getElementById('file-input').click()" class="text-xs font-medium text-brand-600 hover:text-brand-700 flex items-center space-x-1 px-3 py-1.5 rounded-lg bg-brand-50 hover:bg-brand-100 transition-colors cursor-pointer">
              <i data-lucide="plus" class="w-3.5 h-3.5"></i>
              <span>Thêm ảnh nối tiếp</span>
            </button>
          </div>

          <!-- Thumbnails grid -->
          <div id="images-gallery" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            <!-- Dynamic thumbnails rendered in JS -->
          </div>

          <!-- Action buttons -->
          <div class="flex flex-wrap items-center justify-center gap-3 pt-3">
            <button type="button" onclick="triggerScan()" id="btn-scan" class="bg-brand-600 hover:bg-brand-700 text-white font-medium px-6 py-2.5 rounded-xl text-sm shadow-md shadow-brand-600/20 transition-all flex items-center space-x-2 cursor-pointer">
              <i data-lucide="sparkles" class="w-4 h-4"></i>
              <span>Bóc Tách Hóa Đơn Bằng AI</span>
            </button>
            <button type="button" onclick="resetAllImages()" class="text-slate-500 hover:text-red-600 text-sm px-4 py-2.5 rounded-xl border border-slate-200 hover:border-red-200 hover:bg-red-50 transition-colors flex items-center space-x-1.5 cursor-pointer">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
              <span>Xóa hết ảnh</span>
            </button>
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
              <input type="text" id="input-subtotal" oninput="this.value = formatInput(this.value); recalculate()" class="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-brand-500">
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-500 mb-1">Voucher Giảm Món</label>
              <input type="text" id="input-discount-items" oninput="this.value = formatInput(this.value); recalculate()" class="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 text-emerald-600 font-medium focus:outline-none focus:border-brand-500">
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-500 mb-1">Phí Ship Thực Tế</label>
              <input type="text" id="input-shipping-net" oninput="this.value = formatInput(this.value); recalculate()" class="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 text-sky-600 font-medium focus:outline-none focus:border-brand-500">
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
            <div>
              <label class="block text-xs font-medium text-slate-500 mb-1">Phí Dịch Vụ / Phụ Phí</label>
              <input type="text" id="input-service-fee" oninput="this.value = formatInput(this.value); recalculate()" class="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-brand-500">
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-500 mb-1">Tổng Bill Thực Trả (App)</label>
              <input type="text" id="input-final-total" oninput="this.value = formatInput(this.value); recalculate()" class="w-full text-sm font-bold text-brand-600 border border-brand-300 bg-brand-50/30 rounded-lg px-3 py-2 focus:outline-none focus:border-brand-500">
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
              <h2 class="text-base font-semibold text-slate-900">Chi tiết món ăn và giá tiền cụ thể</h2>
            </div>
            <button type="button" onclick="addNewDishRow()" class="text-brand-600 hover:text-brand-700 text-xs font-medium flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-brand-50 cursor-pointer">
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
            <button type="button" onclick="copyZaloText()" class="bg-slate-800 hover:bg-slate-900 text-white font-medium px-4 py-2.5 rounded-xl text-sm transition-all flex items-center space-x-2 cursor-pointer">
              <i data-lucide="copy" class="w-4 h-4"></i>
              <span>Copy Bảng Kê (Zalo / Slack)</span>
            </button>
            <button type="button" onclick="sendEmails()" id="btn-send-emails" class="bg-brand-600 hover:bg-brand-700 text-white font-medium px-5 py-2.5 rounded-xl text-sm shadow-md shadow-brand-600/20 transition-all flex items-center space-x-2 cursor-pointer">
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
          <h2 class="text-base font-semibold text-slate-900">Các thành viên và tài khoản</h2>
          <p class="text-xs text-slate-500 mt-1">Dưới đây là danh sách các thành viên của ODC và email của họ. Thu thập email để gửi Spilt Bill gửi hóa đơn ăn uống tới tận giường.</p>
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
            <button type="submit" class="w-full bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors flex items-center justify-center space-x-1.5 cursor-pointer">
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
            <h2 class="text-base font-semibold text-slate-900">Tài Khoản Thanh Toán (Ví MoMo & Ngân Hàng VietQR)</h2>
            <p class="text-xs text-slate-500 mt-0.5">Lưu trong D1, tự động đồng bộ trên tất cả thiết bị của bạn.</p>
          </div>
        </div>

        <form onsubmit="addPaymentAccount(event)" class="space-y-4 bg-slate-50 p-4 rounded-xl border border-slate-200/70">
          <div class="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <label class="block text-xs font-medium text-slate-500 mb-1">Phương thức / Ngân hàng</label>
              <select id="acc-bank-code" onchange="onBankSelectChange()" required class="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-brand-500">
                <optgroup label="Ví điện tử">
                  <option value="MOMO" selected>Ví MoMo (Mã QR Cá Nhân)</option>
                </optgroup>
                <optgroup label="Ngân hàng VietQR">
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
                </optgroup>
              </select>
            </div>
            <div>
              <label id="lbl-acc-no" class="block text-xs font-medium text-slate-500 mb-1">Số điện thoại MoMo</label>
              <input type="text" id="acc-no" placeholder="Ví dụ: 03066416402" required class="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-brand-500">
            </div>
            <div>
              <label id="lbl-acc-holder" class="block text-xs font-medium text-slate-500 mb-1">Tên chủ tài khoản / ví</label>
              <input type="text" id="acc-holder" placeholder="PHAM XUAN PHU" required class="w-full text-sm uppercase border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-brand-500">
            </div>
            <div class="flex items-end">
              <button type="submit" id="btn-save-acc" class="w-full bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors flex items-center justify-center space-x-1.5 cursor-pointer shadow-sm">
                <i data-lucide="plus" class="w-4 h-4"></i>
                <span>Thêm Tài Khoản</span>
              </button>
            </div>
          </div>

          <!-- MoMo Link & QR Upload Section -->
          <div id="momo-qr-upload-section" class="border-t border-slate-200/80 pt-3 space-y-3">
            <div>
              <label class="block text-xs font-semibold text-slate-700 mb-1">
                <span class="text-[#d82d8b] font-bold">Link Nhận Tiền MoMo Cá Nhân:</span> Dán link nhận tiền từ app MoMo (Khuyên dùng để tránh lỗi liên kết)
              </label>
              <div class="relative">
                <input type="url" id="acc-momo-link" placeholder="Ví dụ: https://me.momo.vn/xuanphu hoặc copy từ nút Chia sẻ trên MoMo" class="w-full text-sm border border-slate-200 rounded-lg pl-3 pr-8 py-2 bg-white focus:outline-none focus:border-pink-500">
                <div class="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none text-slate-400">
                  <i data-lucide="link" class="w-4 h-4"></i>
                </div>
              </div>
              <p class="text-[11px] text-slate-500 mt-1">
                💡 <b>Cách lấy:</b> Mở app MoMo &gt; Nhận tiền &gt; Bấm nút <b>Chia sẻ</b> hoặc <b>Tạo link nhận tiền</b> rồi copy dán vào đây. Nút trên email sẽ chuyển thẳng vào app MoMo mà không bị lỗi.
              </p>
            </div>

            <div class="flex items-center justify-between pt-1">
              <label class="block text-xs font-semibold text-slate-700">
                <span class="text-[#d82d8b] font-bold">Mã QR MoMo Cá Nhân:</span> Tải lên ảnh mã QR chụp từ app MoMo của bạn
              </label>
              <span class="text-[11px] text-slate-400">Hỗ trợ PNG, JPG, WebP</span>
            </div>

            <div class="flex flex-col sm:flex-row items-center gap-4 bg-white p-3 rounded-xl border border-slate-200">
              <div id="momo-qr-preview-box" class="w-24 h-24 rounded-lg border-2 border-dashed border-slate-200 flex items-center justify-center bg-slate-50 overflow-hidden shrink-0">
                <div id="momo-qr-placeholder" class="text-center p-2">
                  <i data-lucide="qr-code" class="w-7 h-7 text-slate-300 mx-auto"></i>
                  <span class="text-[10px] text-slate-400 block mt-1">Chưa có ảnh QR</span>
                </div>
                <img id="momo-qr-preview-img" src="" alt="Preview QR MoMo" class="hidden w-full h-full object-contain">
              </div>

              <div class="flex-1 space-y-2 w-full text-center sm:text-left">
                <div class="flex flex-wrap items-center justify-center sm:justify-start gap-2">
                  <input type="file" id="momo-qr-file-input" accept="image/*" class="hidden" onchange="handleMomoQrFile(this.files)">
                  <button type="button" onclick="document.getElementById('momo-qr-file-input').click()" class="bg-pink-50 hover:bg-pink-100 text-[#d82d8b] border border-pink-200 text-xs font-semibold px-3.5 py-1.5 rounded-lg flex items-center space-x-1.5 cursor-pointer transition-colors shadow-sm">
                    <i data-lucide="upload" class="w-3.5 h-3.5"></i>
                    <span>Tải ảnh mã QR MoMo lên</span>
                  </button>
                  <button type="button" id="btn-remove-momo-qr" onclick="removeMomoQrImage()" class="hidden text-xs text-slate-400 hover:text-red-500 px-2 py-1 rounded cursor-pointer">
                    Xóa ảnh này
                  </button>
                </div>
                <p class="text-xs text-slate-500 leading-relaxed">
                  💡 <b>Cách lấy:</b> Mở app MoMo &gt; Nhận tiền &gt; Chụp màn hình rồi bấm nút trên để tải lên. Mã này sẽ hiển thị trực tiếp khi đồng nghiệp quét thanh toán.
                </p>
              </div>
            </div>
          </div>
        </form>

        <div id="payment-accounts-list" class="space-y-3">
          <!-- Rendered via JS -->
        </div>
      </div>

      ${isAdmin ? `
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
            <label class="block text-xs font-medium text-slate-500 mb-1">Tên Người Gửi Hiển Thị (Tránh vào Spam)</label>
            <input type="text" id="setting-sender-name" placeholder="Ví dụ: Alviss - Cơm Trưa" class="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-brand-500">
            <p class="text-[11px] text-slate-400 mt-1">Nên đặt kèm tên của bạn (ví dụ: Alviss - Cơm Trưa) để bạn bè nhận diện ngay và không bị bộ lọc Gmail đánh giá là thư rác mạo danh.</p>
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-500 mb-1">Email của Alviss (Nhận bảng tổng hợp đơn)</label>
            <input type="email" id="setting-admin-email" placeholder="alviss@gmail.com" class="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-brand-500">
          </div>
          <div class="flex justify-end space-x-3 pt-2">
            <button type="button" onclick="saveSettings()" class="bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium px-5 py-2 rounded-xl shadow-md shadow-brand-600/20 transition-all flex items-center space-x-1.5 cursor-pointer">
              <i data-lucide="save" class="w-4 h-4"></i>
              <span>Lưu Cài Đặt</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Security / Password Config -->
      <div class="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-sm space-y-4">
        <div>
          <h2 class="text-base font-semibold text-slate-900 flex items-center space-x-2">
            <i data-lucide="shield-check" class="w-5 h-5 text-brand-600"></i>
            <span>Mật Khẩu Quản Trị Hệ Thống (phupx1)</span>
          </h2>
          <p class="text-xs text-slate-500 mt-0.5">Đổi mật khẩu cho tài khoản Admin chính của bạn.</p>
        </div>

        <div class="space-y-4 max-w-md">
          <div>
            <label class="block text-xs font-medium text-slate-500 mb-1">Mật khẩu mới</label>
            <input type="password" id="setting-app-password" placeholder="Nhập mật khẩu mới nếu muốn đổi..." class="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-brand-500">
          </div>
          <div class="flex justify-start space-x-3 pt-1">
            <button type="button" onclick="changeAppPassword()" class="bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold px-4 py-2.5 rounded-xl transition-all flex items-center space-x-1.5 cursor-pointer shadow-sm">
              <i data-lucide="key" class="w-3.5 h-3.5"></i>
              <span>Cập Nhật Mật Khẩu Admin</span>
            </button>
          </div>
        </div>
      </div>

      <!-- User Management (Admin Only) -->
      <div class="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-sm space-y-4">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 class="text-base font-semibold text-slate-900 flex items-center space-x-2">
              <i data-lucide="users-round" class="w-5 h-5 text-brand-600"></i>
              <span>Danh Sách Tài Khoản Người Dùng (Users)</span>
            </h2>
            <p class="text-xs text-slate-500 mt-0.5">Tất cả tài khoản đăng nhập vào tool (Admin & Guest).</p>
          </div>
          <button type="button" onclick="loadUsersList()" class="self-start sm:self-auto text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold px-3 py-1.5 rounded-lg transition-colors flex items-center space-x-1 cursor-pointer">
            <i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i>
            <span>Làm mới danh sách</span>
          </button>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead class="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
              <tr>
                <th class="p-3">Tên đăng nhập / Email</th>
                <th class="p-3">Họ tên hiển thị</th>
                <th class="p-3 text-center">Vai trò</th>
                <th class="p-3 text-slate-400">Ngày tạo</th>
                <th class="p-3 w-16 text-center">Xóa</th>
              </tr>
            </thead>
            <tbody id="users-list-tbody" class="divide-y divide-slate-100">
              <tr>
                <td colspan="5" class="p-4 text-center text-xs text-slate-400">Đang tải danh sách tài khoản...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      ` : ''}

    </div>

  </main>

  <!-- Payment & QR Modal -->
  <div id="qr-modal" class="hidden fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
    <div class="bg-white rounded-2xl max-w-sm w-full p-6 space-y-4 shadow-2xl my-auto animate-in fade-in zoom-in-95 duration-150">
      <div class="flex justify-between items-center border-b border-slate-100 pb-3">
        <div id="qr-modal-title" class="font-bold text-slate-900 text-base">Thanh Toán</div>
        <button type="button" onclick="closeQrModal()" class="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer">
          <i data-lucide="x" class="w-5 h-5"></i>
        </button>
      </div>
      
      <div class="relative bg-slate-50 p-2 rounded-xl border border-slate-100 flex items-center justify-center">
        <img id="qr-modal-img" src="" alt="Mã QR Thanh Toán" class="rounded-lg w-56 h-56 object-contain shadow-sm bg-white">
      </div>

      <div id="qr-modal-info" class="text-xs text-slate-700 bg-slate-50 p-3.5 rounded-xl border border-slate-100 space-y-1.5"></div>

      <div id="qr-modal-actions" class="space-y-2 pt-1"></div>

      <button type="button" onclick="closeQrModal()" class="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold py-2.5 rounded-xl text-sm transition-colors cursor-pointer">
        Đóng Cửa Sổ
      </button>
    </div>
  </div>

  <!-- Lightbox Modal for Bill Images -->
  <div id="lightbox-modal" class="hidden fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4" onclick="if(event.target === this) closeLightbox()">
    <div class="relative max-w-4xl w-full max-h-[92vh] flex flex-col items-center">
      <div class="w-full flex justify-between items-center text-white pb-2 px-1">
        <span id="lightbox-title" class="text-sm font-semibold">Ảnh hóa đơn</span>
        <button type="button" onclick="closeLightbox()" class="text-white/80 hover:text-white p-1 rounded-lg hover:bg-white/10 transition-colors cursor-pointer">
          <i data-lucide="x" class="w-6 h-6"></i>
        </button>
      </div>
      <div class="overflow-auto max-h-[82vh] w-full flex items-center justify-center bg-slate-900/50 rounded-2xl p-2 border border-white/10">
        <img id="lightbox-img" src="" alt="Hóa đơn phóng to" class="max-h-[80vh] max-w-full object-contain rounded-lg shadow-2xl">
      </div>
    </div>
  </div>

  <script>
    // State
    let uploadedImages = []; // Array of { id, name, base64 }
    let scannedDishes = [];
    let paymentAccounts = [];
    let membersList = [];
    let currentSettlements = [];

    // Helper: Định dạng số có dấu phẩy ngăn cách hàng nghìn (ví dụ: 33,000)
    function formatNumber(num) {
      if (num === undefined || num === null || num === '') return '0';
      const n = parseInt(String(num).replace(/[^0-9]/g, ''), 10);
      if (isNaN(n)) return '0';
      return n.toLocaleString('en-US');
    }

    // Helper: Tự format dấu phẩy khi người dùng đang gõ
    function formatInput(val) {
      const digits = String(val).replace(/[^0-9]/g, '');
      if (!digits) return '';
      return parseInt(digits, 10).toLocaleString('en-US');
    }

    // Helper: Parse chuỗi có dấu phẩy về số nguyên
    function parseNumber(val) {
      if (!val) return 0;
      const digits = String(val).replace(/[^0-9]/g, '');
      return parseInt(digits, 10) || 0;
    }

    // Helper Format VND (ví dụ: 33.000 đ)
    function formatVND(num) {
      if (!num) return '0 đ';
      return Number(num).toLocaleString('vi-VN') + ' đ';
    }

    // Init Lucide
    lucide.createIcons();

    // Tab switcher
    function switchTab(tabId) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      const activeBtn = document.getElementById('tab-btn-' + tabId);
      if (activeBtn) activeBtn.classList.add('active');

      const tabSplitter = document.getElementById('tab-splitter');
      const tabMembers = document.getElementById('tab-members');
      const tabSettings = document.getElementById('tab-settings');

      if (tabSplitter) tabSplitter.classList.add('hidden');
      if (tabMembers) tabMembers.classList.add('hidden');
      if (tabSettings) tabSettings.classList.add('hidden');

      const targetTab = document.getElementById('tab-' + tabId);
      if (targetTab) targetTab.classList.remove('hidden');

      if (tabId === 'members') loadMembers();
      if (tabId === 'settings') {
        loadPaymentAccounts();
        if (document.getElementById('setting-gas-url')) loadSettings();
        if (document.getElementById('users-list-tbody')) loadUsersList();
      }
    }

    // Drag & drop / File input / Paste
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');

    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length) {
        handleImageFiles(e.target.files);
        fileInput.value = ''; // Reset input để có thể chọn lại cùng file
      }
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
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        handleImageFiles(e.dataTransfer.files);
      }
    });

    window.addEventListener('paste', (e) => {
      const items = e.clipboardData.items;
      const files = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const file = items[i].getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length) {
        handleImageFiles(files);
      }
    });

    // Hàm nén ảnh sang định dạng WebP (giảm >90% dung lượng, giữ nguyên độ nét cho AI)
    function compressImageToWebP(file, maxWidth = 1600, quality = 0.85) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const img = new Image();
          img.onload = () => {
            let width = img.width;
            let height = img.height;

            if (width > maxWidth || height > maxWidth) {
              if (width > height) {
                height = Math.round((height * maxWidth) / width);
                width = maxWidth;
              } else {
                width = Math.round((width * maxWidth) / height);
                height = maxWidth;
              }
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            // Xuất WebP (nếu trình duyệt hỗ trợ, nếu không fallback sang JPEG)
            let webpData = canvas.toDataURL('image/webp', quality);
            if (!webpData.startsWith('data:image/webp')) {
              webpData = canvas.toDataURL('image/jpeg', quality);
            }
            resolve(webpData);
          };
          img.onerror = reject;
          img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    async function handleImageFiles(files) {
      if (!files || !files.length) return;
      const validFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
      if (!validFiles.length) return;

      for (const file of validFiles) {
        try {
          const compressedB64 = await compressImageToWebP(file);
          uploadedImages.push({
            id: Date.now() + Math.random().toString(36).substring(2, 6),
            name: file.name || 'Ảnh hóa đơn',
            base64: compressedB64,
          });
        } catch (err) {
          console.error('Lỗi nén ảnh WebP:', err);
        }
      }
      renderImageGallery();
    }

    function renderImageGallery() {
      const container = document.getElementById('preview-container');
      const dropZone = document.getElementById('drop-zone');
      const gallery = document.getElementById('images-gallery');
      const countSpan = document.getElementById('images-count');

      if (!uploadedImages.length) {
        dropZone.classList.remove('hidden');
        container.classList.add('hidden');
        return;
      }

      dropZone.classList.add('hidden');
      container.classList.remove('hidden');
      countSpan.textContent = uploadedImages.length;
      gallery.innerHTML = '';

      uploadedImages.forEach((img, idx) => {
        const card = document.createElement('div');
        card.className = 'relative group border border-slate-200 rounded-xl overflow-hidden bg-slate-50 shadow-sm';
        card.innerHTML = \`
          <div onclick="openLightbox(\${idx})" class="aspect-[3/4] overflow-hidden bg-slate-100 flex items-center justify-center p-1 cursor-zoom-in relative">
            <img src="\${img.base64}" alt="Ảnh \${idx + 1}" class="w-full h-full object-contain">
            <div class="absolute inset-0 bg-black/0 group-hover:bg-black/15 transition-colors flex items-center justify-center">
              <span class="opacity-0 group-hover:opacity-100 bg-black/70 text-white text-[11px] px-2 py-1 rounded-lg backdrop-blur-sm transition-opacity flex items-center space-x-1 shadow-sm">
                <i data-lucide="zoom-in" class="w-3.5 h-3.5"></i>
                <span>Xem to</span>
              </span>
            </div>
          </div>
          <div class="p-2 bg-white flex items-center justify-between text-xs border-t border-slate-100">
            <span class="font-bold text-slate-700">Phần \${idx + 1}</span>
            <button type="button" onclick="removeImage(\${idx})" class="text-slate-400 hover:text-red-500 p-1 rounded hover:bg-red-50 transition-colors cursor-pointer" title="Xóa ảnh này">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        \`;
        gallery.appendChild(card);
      });
      lucide.createIcons();
    }

    function openLightbox(idx) {
      if (!uploadedImages[idx]) return;
      document.getElementById('lightbox-title').textContent = 'Ảnh hóa đơn - Phần ' + (idx + 1) + ' / ' + uploadedImages.length;
      document.getElementById('lightbox-img').src = uploadedImages[idx].base64;
      document.getElementById('lightbox-modal').classList.remove('hidden');
      lucide.createIcons();
    }

    function closeLightbox() {
      document.getElementById('lightbox-modal').classList.add('hidden');
    }

    function removeImage(idx) {
      uploadedImages.splice(idx, 1);
      renderImageGallery();
      if (!uploadedImages.length) {
        document.getElementById('result-section').classList.add('hidden');
      }
    }

    function resetAllImages() {
      uploadedImages = [];
      document.getElementById('file-input').value = '';
      renderImageGallery();
      document.getElementById('result-section').classList.add('hidden');
    }

    // Scan Bill via AI (Gửi mảng nhiều ảnh)
    async function triggerScan() {
      if (!uploadedImages.length) {
        alert('Vui lòng chọn ít nhất 1 ảnh hóa đơn!');
        return;
      }
      const btn = document.getElementById('btn-scan');
      btn.disabled = true;
      btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i><span>Đang bóc tách dữ liệu AI (' + uploadedImages.length + ' ảnh)...</span>';
      lucide.createIcons();

      try {
        const res = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ images_base64: uploadedImages.map(img => img.base64) }),
        });
        const data = await res.json();
        if (!data.success) {
          alert('Lỗi bóc tách hóa đơn: ' + data.error);
          return;
        }

        const bill = data.data;
        document.getElementById('input-store-name').value = bill.store_name || '';
        document.getElementById('input-subtotal').value = formatNumber(bill.subtotal || 0);
        document.getElementById('input-discount-items').value = formatNumber(bill.discount_items || 0);
        
        const shipNet = (bill.shipping_fee || 0) - (bill.discount_shipping || 0);
        document.getElementById('input-shipping-net').value = formatNumber(shipNet > 0 ? shipNet : 0);
        document.getElementById('input-service-fee').value = formatNumber(bill.service_fee || 0);
        document.getElementById('input-final-total').value = formatNumber(bill.final_total || 0);

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

    // Render Dishes Table (Thêm dấu phẩy vào giá gốc)
    function renderDishesTable() {
      const tbody = document.getElementById('dishes-tbody');
      tbody.innerHTML = '';

      scannedDishes.forEach((d, idx) => {
        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td class="p-3">
            <input type="text" value="\${d.user_name}" onchange="updateDish(\${idx}, 'user_name', this.value)" class="w-full text-sm font-medium border border-slate-200 rounded px-2 py-1 focus:border-brand-500 focus:outline-none">
          </td>
          <td class="p-3">
            <input type="email" value="\${d.email}" placeholder="email@company.com" onchange="updateDish(\${idx}, 'email', this.value)" class="w-full text-xs text-slate-600 border border-slate-200 rounded px-2 py-1 focus:border-brand-500 focus:outline-none">
          </td>
          <td class="p-3">
            <input type="text" value="\${d.dish_name}" onchange="updateDish(\${idx}, 'dish_name', this.value)" class="w-full text-sm border border-slate-200 rounded px-2 py-1 focus:border-brand-500 focus:outline-none">
          </td>
          <td class="p-3 text-center">
            <input type="number" min="1" value="\${d.quantity}" onchange="updateDish(\${idx}, 'quantity', parseInt(this.value)||1)" class="w-14 text-center text-sm border border-slate-200 rounded px-1 py-1 focus:outline-none">
          </td>
          <td class="p-3 text-right">
            <input type="text" value="\${formatNumber(d.price)}" oninput="this.value = formatInput(this.value)" onchange="updateDish(\${idx}, 'price', parseNumber(this.value))" class="w-28 text-right text-sm font-semibold border border-slate-200 rounded px-2 py-1 focus:border-brand-500 focus:outline-none">
          </td>
          <td class="p-3 text-center">
            <button type="button" onclick="removeDishRow(\${idx})" class="text-slate-400 hover:text-red-500 p-1 cursor-pointer">
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
      const subtotal = parseNumber(document.getElementById('input-subtotal').value);
      const discountItems = parseNumber(document.getElementById('input-discount-items').value);
      const shippingNet = parseNumber(document.getElementById('input-shipping-net').value);
      const serviceFee = parseNumber(document.getElementById('input-service-fee').value);
      const finalTotal = parseNumber(document.getElementById('input-final-total').value);

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

      // Lấy tài khoản thanh toán được chọn
      const accSelect = document.getElementById('select-payment-account');
      const selectedAccId = accSelect ? accSelect.value : null;
      const bankAcc = paymentAccounts.find(a => String(a.id) === String(selectedAccId)) || paymentAccounts[0] || {};

      const isMomo = (bankAcc.bank_code || '').toUpperCase() === 'MOMO' || bankAcc.bank_code === '971025' || ((bankAcc.bank_name || '').toUpperCase().indexOf('MOMO') !== -1);
      const momoLink = isMomo ? (bankAcc.payment_link || (bankAcc.account_no ? \`https://me.momo.vn/\${bankAcc.account_no}\` : '')) : '';

      let calculatedSum = 0;
      currentSettlements = users.map(u => {
        const discountRatio = totalItemsCost > 0 ? (u.totalOriginal / totalItemsCost) : (1 / userCount);
        const myDiscount = Math.round(discountItems * discountRatio);
        
        let rawPay = u.totalOriginal - myDiscount + sharedFeePerPerson;
        let roundedPay = Math.round(rawPay / 1000) * 1000;
        calculatedSum += roundedPay;

        let qrCodeUrl = '';
        if (isMomo) {
          // Lấy mã QR MoMo cá nhân của Alviss tải lên (nếu có)
          if (bankAcc.qr_r2_key) {
            qrCodeUrl = window.location.origin + \`/api/payment-accounts/\${bankAcc.id}/qr\`;
          }
        } else {
          // Sinh mã VietQR động có sẵn số tiền cho tài khoản ngân hàng
          if (bankAcc.account_no) {
            qrCodeUrl = \`https://img.vietqr.io/image/\${bankAcc.bank_code}-\${bankAcc.account_no}-compact2.png?amount=\${roundedPay}&addInfo=\${encodeURIComponent('AN TRUA ' + u.name)}&accountName=\${encodeURIComponent(bankAcc.account_holder || '')}\`;
          }
        }

        return {
          name: u.name,
          email: u.email,
          dishesStr: u.dishes.join(', '),
          original: u.totalOriginal,
          discount: myDiscount,
          shipping: sharedFeePerPerson,
          finalAmount: roundedPay,
          vietqrUrl: qrCodeUrl,
          bankInfo: bankAcc,
          isMomo: isMomo,
          momoLink: momoLink,
        };
      });

      // Bù trừ sai số làm tròn vào người đầu tiên (người đặt / Alviss) nếu có lệch với finalTotal
      if (finalTotal > 0 && currentSettlements.length > 0) {
        const diff = finalTotal - calculatedSum;
        if (diff !== 0 && Math.abs(diff) < 10000) {
          currentSettlements[0].finalAmount += diff;
          if (!isMomo && currentSettlements[0].vietqrUrl && bankAcc.account_no) {
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
        let actionBtn = '<span class="text-xs text-slate-400">Thiếu STK</span>';
        if (s.vietqrUrl) {
          if (s.isMomo) {
            actionBtn = \`
              <button type="button" onclick="openQrModal(\${idx})" class="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-pink-50 hover:bg-pink-100 text-pink-700 border border-pink-200 inline-flex items-center space-x-1.5 cursor-pointer shadow-sm transition-all" title="Xem QR MoMo hoặc mở app MoMo">
                <span class="w-2 h-2 rounded-full bg-[#d82d8b]"></span>
                <span>Ví MoMo / QR</span>
              </button>
            \`;
          } else {
            actionBtn = \`
              <button type="button" onclick="openQrModal(\${idx})" class="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 inline-flex items-center space-x-1 cursor-pointer transition-all">
                <i data-lucide="qr-code" class="w-3.5 h-3.5"></i>
                <span>Xem QR</span>
              </button>
            \`;
          }
        }

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
            \${actionBtn}
          </td>
        \`;
        tbody.appendChild(tr);
      });

      document.getElementById('settlement-total-badge').textContent = 'Tổng thu: ' + formatVND(sum);
      lucide.createIcons();
    }

    // Modal Thanh Toán (Hỗ trợ Ví MoMo & Ngân Hàng VietQR)
    function openQrModal(idx) {
      const s = currentSettlements[idx];
      const isMomo = s.isMomo;
      const modalTitle = document.getElementById('qr-modal-title');
      const modalImg = document.getElementById('qr-modal-img');
      const modalInfo = document.getElementById('qr-modal-info');
      const modalActions = document.getElementById('qr-modal-actions');

      modalImg.src = s.vietqrUrl;

      if (isMomo) {
        modalTitle.innerHTML = \`
          <div class="flex items-center space-x-2">
            <span class="px-2 py-0.5 rounded bg-[#d82d8b] text-white font-bold text-xs uppercase tracking-wide">MoMo</span>
            <span class="font-bold text-slate-900 text-base">Thanh Toán: \${s.name}</span>
          </div>
        \`;
        modalInfo.innerHTML = \`
          <div class="space-y-1.5">
            <div class="flex justify-between items-center py-0.5 border-b border-pink-100">
              <span class="text-slate-500">Chủ ví nhận:</span>
              <span class="font-bold text-slate-900">\${s.bankInfo.account_holder || ''}</span>
            </div>
            <div class="flex justify-between items-center py-0.5 border-b border-pink-100">
              <span class="text-slate-500">Số điện thoại MoMo:</span>
              <span class="font-bold text-[#be185d] font-mono text-sm">\${s.bankInfo.account_no || ''}</span>
            </div>
            <div class="flex justify-between items-center py-0.5 border-b border-pink-100">
              <span class="text-slate-500">Số tiền cần chuyển:</span>
              <span class="font-bold text-[#be185d] text-base">\${formatVND(s.finalAmount)}</span>
            </div>
            <div class="flex justify-between items-center py-0.5">
              <span class="text-slate-500">Lời nhắn:</span>
              <span class="font-bold text-slate-800">AN TRUA \${s.name}</span>
            </div>
          </div>
        \`;
        const mLink = s.momoLink || (s.bankInfo && s.bankInfo.payment_link) || '';
        modalActions.innerHTML = \`
          <button type="button" onclick="openMomoApp('\${s.bankInfo.account_no}', \${s.finalAmount}, '\${mLink}')" class="w-full bg-[#d82d8b] hover:bg-[#be185d] text-white font-bold py-2.5 px-4 rounded-xl text-sm shadow-md shadow-pink-500/25 transition-all flex items-center justify-center space-x-2 cursor-pointer">
            <i data-lucide="smartphone" class="w-4 h-4"></i>
            <span>Mở Ứng Dụng MoMo Để Chuyển</span>
          </button>
          <div class="grid grid-cols-2 gap-2 pt-1">
            <button type="button" onclick="copyToClipboard('\${s.finalAmount}', 'Đã copy số tiền \${formatVND(s.finalAmount)}!')" class="bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold py-2 px-3 rounded-lg text-xs flex items-center justify-center space-x-1 cursor-pointer transition-colors">
              <i data-lucide="copy" class="w-3.5 h-3.5"></i>
              <span>Copy số tiền</span>
            </button>
            <button type="button" onclick="copyToClipboard('\${s.bankInfo.account_no}', 'Đã copy SĐT MoMo \${s.bankInfo.account_no}!')" class="bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold py-2 px-3 rounded-lg text-xs flex items-center justify-center space-x-1 cursor-pointer transition-colors">
              <i data-lucide="phone" class="w-3.5 h-3.5"></i>
              <span>Copy SĐT</span>
            </button>
          </div>
          <p class="text-[11px] text-slate-400 text-center leading-relaxed pt-1">
            * Bấm "Mở Ứng Dụng MoMo" sẽ tự động copy số tiền và mở app. Bạn cũng có thể dùng app MoMo hoặc ngân hàng quét mã QR trên để chuyển tiền tự động.
          </p>
        \`;
      } else {
        modalTitle.innerHTML = \`
          <div class="flex items-center space-x-2">
            <span class="px-2 py-0.5 rounded bg-blue-600 text-white font-bold text-xs uppercase tracking-wide">\${s.bankInfo.bank_code || 'VietQR'}</span>
            <span class="font-bold text-slate-900 text-base">Thanh Toán: \${s.name}</span>
          </div>
        \`;
        modalInfo.innerHTML = \`
          <div class="space-y-1.5">
            <div class="flex justify-between items-center py-0.5 border-b border-slate-100">
              <span class="text-slate-500">Ngân hàng:</span>
              <span class="font-bold text-slate-900">\${s.bankInfo.bank_name || s.bankInfo.bank_code || ''}</span>
            </div>
            <div class="flex justify-between items-center py-0.5 border-b border-slate-100">
              <span class="text-slate-500">Số tài khoản:</span>
              <span class="font-bold text-blue-700 font-mono text-sm">\${s.bankInfo.account_no || ''}</span>
            </div>
            <div class="flex justify-between items-center py-0.5 border-b border-slate-100">
              <span class="text-slate-500">Chủ tài khoản:</span>
              <span class="font-bold text-slate-900">\${s.bankInfo.account_holder || ''}</span>
            </div>
            <div class="flex justify-between items-center py-0.5 border-b border-slate-100">
              <span class="text-slate-500">Số tiền:</span>
              <span class="font-bold text-brand-600 text-base">\${formatVND(s.finalAmount)}</span>
            </div>
            <div class="flex justify-between items-center py-0.5">
              <span class="text-slate-500">Nội dung:</span>
              <span class="font-bold text-slate-800">AN TRUA \${s.name}</span>
            </div>
          </div>
        \`;
        modalActions.innerHTML = \`
          <div class="grid grid-cols-2 gap-2">
            <button type="button" onclick="copyToClipboard('\${s.finalAmount}', 'Đã copy số tiền \${formatVND(s.finalAmount)}!')" class="bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold py-2 px-3 rounded-lg text-xs flex items-center justify-center space-x-1 cursor-pointer transition-colors">
              <i data-lucide="copy" class="w-3.5 h-3.5"></i>
              <span>Copy số tiền</span>
            </button>
            <button type="button" onclick="copyToClipboard('\${s.bankInfo.account_no}', 'Đã copy STK \${s.bankInfo.account_no}!')" class="bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold py-2 px-3 rounded-lg text-xs flex items-center justify-center space-x-1 cursor-pointer transition-colors">
              <i data-lucide="credit-card" class="w-3.5 h-3.5"></i>
              <span>Copy STK</span>
            </button>
          </div>
        \`;
      }

      document.getElementById('qr-modal').classList.remove('hidden');
      lucide.createIcons();
    }

    function closeQrModal() {
      document.getElementById('qr-modal').classList.add('hidden');
    }

    function copyToClipboard(text, msg) {
      if (!text) return;
      navigator.clipboard.writeText(String(text)).then(() => {
        showToast(msg || 'Đã sao chép vào bộ nhớ tạm!');
      }).catch(() => {
        prompt('Sao chép giá trị sau:', text);
      });
    }

    function openMomoApp(phone, amount, customLink) {
      navigator.clipboard.writeText(String(amount)).catch(() => {});
      showToast(\`Đã copy \${formatVND(amount)}! Đang chuyển sang MoMo...\`);
      const targetUrl = customLink || (phone ? \`https://me.momo.vn/\${phone}\` : 'https://momo.vn');
      setTimeout(() => {
        window.open(targetUrl, '_blank');
      }, 300);
    }

    function showToast(msg) {
      let toast = document.getElementById('toast-notification');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast-notification';
        toast.className = 'fixed bottom-5 left-1/2 -translate-x-1/2 z-50 bg-slate-900/95 text-white px-4 py-2.5 rounded-xl text-xs font-semibold shadow-xl border border-slate-700 flex items-center space-x-2 transition-all duration-300 pointer-events-none opacity-0 translate-y-2';
        document.body.appendChild(toast);
      }
      toast.innerHTML = \`<i data-lucide="check-circle" class="w-4 h-4 text-emerald-400 shrink-0"></i><span>\${msg}</span>\`;
      lucide.createIcons();
      toast.classList.remove('opacity-0', 'translate-y-2');
      setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-2');
      }, 2500);
    }

    // Copy Zalo / Slack text
    function copyZaloText() {
      const store = document.getElementById('input-store-name').value || 'Cơm trưa';
      const today = new Date().toLocaleDateString('vi-VN');
      let text = \`🍱 TIỀN CƠM TRƯA (\${store} - \${today})\\n--------------------------------\\n\`;

      currentSettlements.forEach((s, i) => {
        text += \`\${i + 1}. \${s.name}: \${formatVND(s.finalAmount)} (\${s.dishesStr})\\n\`;
        if (s.isMomo) {
          const mLink = s.momoLink || (s.bankInfo && s.bankInfo.payment_link) || (s.bankInfo && s.bankInfo.account_no ? \`https://me.momo.vn/\${s.bankInfo.account_no}\` : '');
          if (mLink) {
            text += \`   👉 Mở MoMo: \${mLink}\\n\`;
          }
        }
        if (s.vietqrUrl) {
          text += \`   👉 Quét QR: \${s.vietqrUrl}\\n\`;
        }
      });

      if (currentSettlements.length && currentSettlements[0].bankInfo) {
        const b = currentSettlements[0].bankInfo;
        text += \`--------------------------------\\n\`;
        if (currentSettlements[0].isMomo) {
          const mLink = (b && b.payment_link) || (b && b.account_no ? \`https://me.momo.vn/\${b.account_no}\` : '');
          text += \`Ví MoMo: \${b.account_no} (\${b.account_holder})\\n\`;
          if (mLink) {
            text += \`Link MoMo: \${mLink}\\n\`;
          }
        } else {
          text += \`STK: \${b.account_no} - \${b.bank_code} (\${b.account_holder})\\n\`;
        }
      }

      navigator.clipboard.writeText(text).then(() => {
        showToast('Đã copy bảng kê vào clipboard! Bạn có thể dán ngay vào Zalo hoặc Slack.');
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
        members: currentSettlements.map(s => {
          let qrUrlForEmail = s.vietqrUrl || '';
          if (qrUrlForEmail && !qrUrlForEmail.startsWith('http')) {
            qrUrlForEmail = window.location.origin + qrUrlForEmail;
          }
          return {
            name: s.name,
            email: s.email,
            dish_name: s.dishesStr,
            original_price: s.original,
            discount: s.discount,
            shipping_fee: s.shipping,
            final_amount: s.finalAmount,
            vietqr_url: qrUrlForEmail,
            bank_info: {
              ...s.bankInfo,
              payment_link: (s.bankInfo && s.bankInfo.payment_link) || s.momoLink || '',
            },
          };
        }),
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
            <button type="button" onclick="deleteMember(\${m.id})" class="text-slate-400 hover:text-red-500 p-1 cursor-pointer">
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

    let uploadedMomoQrBase64 = null;

    function handleMomoQrFile(files) {
      if (!files || !files.length) return;
      const file = files[0];
      if (!file.type.startsWith('image/')) {
        alert('Vui lòng chọn file hình ảnh hợp lệ (PNG, JPG, WebP)!');
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        uploadedMomoQrBase64 = e.target.result;
        const img = document.getElementById('momo-qr-preview-img');
        img.src = e.target.result;
        img.classList.remove('hidden');
        document.getElementById('momo-qr-placeholder').classList.add('hidden');
        document.getElementById('btn-remove-momo-qr').classList.remove('hidden');
      };
      reader.readAsDataURL(file);
    }

    function removeMomoQrImage() {
      uploadedMomoQrBase64 = null;
      const input = document.getElementById('momo-qr-file-input');
      if (input) input.value = '';
      const img = document.getElementById('momo-qr-preview-img');
      if (img) {
        img.src = '';
        img.classList.add('hidden');
      }
      const ph = document.getElementById('momo-qr-placeholder');
      if (ph) ph.classList.remove('hidden');
      const btn = document.getElementById('btn-remove-momo-qr');
      if (btn) btn.classList.add('hidden');
    }

    function onBankSelectChange() {
      const code = document.getElementById('acc-bank-code').value;
      const lblNo = document.getElementById('lbl-acc-no');
      const inputNo = document.getElementById('acc-no');
      const qrSection = document.getElementById('momo-qr-upload-section');
      if (code === 'MOMO') {
        lblNo.textContent = 'Số điện thoại MoMo';
        inputNo.placeholder = 'Ví dụ: 03066416402';
        if (qrSection) qrSection.classList.remove('hidden');
      } else {
        lblNo.textContent = 'Số tài khoản ngân hàng';
        inputNo.placeholder = 'Ví dụ: 0987654321';
        if (qrSection) qrSection.classList.add('hidden');
      }
    }

    function renderPaymentAccounts() {
      const container = document.getElementById('payment-accounts-list');
      container.innerHTML = '';
      if (!paymentAccounts.length) {
        container.innerHTML = '<div class="text-xs text-slate-400 text-center p-3">Chưa có tài khoản thanh toán nào.</div>';
        return;
      }

      paymentAccounts.forEach(a => {
        const isMomo = a.bank_code === 'MOMO' || a.bank_code === '971025' || (a.bank_name || '').toUpperCase().indexOf('MOMO') !== -1;
        const div = document.createElement('div');
        div.className = \`flex items-center justify-between p-3.5 rounded-xl border \${a.is_default ? 'border-brand-500 bg-brand-50/20 shadow-sm' : 'border-slate-200 bg-white'}\`;
        
        let badgeHtml = '';
        if (isMomo) {
          if (a.qr_r2_key) {
            badgeHtml = \`
              <div class="relative group">
                <img src="/api/payment-accounts/\${a.id}/qr" alt="QR" class="w-10 h-10 rounded-xl object-contain border border-pink-200 bg-white p-0.5 shadow-sm">
                <span class="absolute -bottom-1 -right-1 w-3.5 h-3.5 bg-emerald-500 border-2 border-white rounded-full"></span>
              </div>
            \`;
          } else {
            badgeHtml = '<div class="w-10 h-10 rounded-xl bg-[#d82d8b] text-white flex items-center justify-center font-bold text-xs shadow-sm shadow-pink-500/20 shrink-0">MoMo</div>';
          }
        } else {
          badgeHtml = \`<div class="w-10 h-10 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center font-bold text-xs shrink-0">\${a.bank_code}</div>\`;
        }
        
        const qrStatusText = isMomo 
          ? (a.qr_r2_key ? '• <span class="text-pink-600 font-semibold">Đã tải QR cá nhân</span>' : '• <span class="text-amber-600">Chưa có ảnh QR</span>')
          : '';

        const descHtml = isMomo
          ? \`Ví MoMo \${qrStatusText}\`
          : (a.bank_name || a.bank_code);

        const linkHtml = (isMomo && a.payment_link) 
          ? \`<div class="text-[11px] text-[#d82d8b] truncate max-w-xs mt-0.5"><a href="\${a.payment_link}" target="_blank" class="hover:underline flex items-center gap-1 font-mono"><span>🔗 \${a.payment_link}</span></a></div>\`
          : '';

        div.innerHTML = \`
          <div class="flex items-center space-x-3">
            \${badgeHtml}
            <div>
              <div class="text-sm font-bold text-slate-900">\${a.account_no} (\${a.account_holder})</div>
              <div class="text-xs text-slate-500">\${descHtml} \${a.is_default ? '• <span class="text-brand-600 font-semibold">Mặc định</span>' : ''}</div>
              \${linkHtml}
            </div>
          </div>
          <div class="flex items-center space-x-2">
            \${!a.is_default ? \`<button type="button" onclick="setDefaultAccount(\${a.id})" class="text-xs text-slate-600 hover:text-brand-600 px-2.5 py-1 rounded-lg border border-slate-200 hover:bg-slate-50 transition-colors cursor-pointer">Đặt mặc định</button>\` : ''}
            <button type="button" onclick="deletePaymentAccount(\${a.id})" class="text-slate-400 hover:text-red-500 p-1.5 rounded-lg hover:bg-red-50 transition-colors cursor-pointer" title="Xóa tài khoản">
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
        const isMomo = a.bank_code === 'MOMO' || a.bank_code === '971025' || (a.bank_name || '').toUpperCase().indexOf('MOMO') !== -1;
        const opt = document.createElement('option');
        opt.value = a.id;
        const prefix = isMomo ? (a.qr_r2_key ? 'Ví MoMo (Có QR)' : 'Ví MoMo') : a.bank_code;
        opt.textContent = \`\${prefix} - \${a.account_no} (\${a.account_holder})\` + (a.is_default ? ' [Mặc định]' : '');
        if (a.is_default) opt.selected = true;
        sel.appendChild(opt);
      });
    }

    async function addPaymentAccount(e) {
      e.preventDefault();
      const bank_code = document.getElementById('acc-bank-code').value;
      const selectElem = document.getElementById('acc-bank-code');
      const isMomo = bank_code === 'MOMO' || bank_code === '971025';
      const bank_name = isMomo ? 'Ví MoMo' : selectElem.selectedOptions[0].text;
      const account_no = document.getElementById('acc-no').value.trim();
      const account_holder = document.getElementById('acc-holder').value.trim();
      const payment_link = isMomo && document.getElementById('acc-momo-link') ? document.getElementById('acc-momo-link').value.trim() : '';

      const btn = document.getElementById('btn-save-acc');
      if (btn) btn.disabled = true;

      try {
        const res = await fetch('/api/payment-accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bank_code,
            bank_name,
            account_no,
            account_holder,
            payment_link,
            is_default: paymentAccounts.length === 0,
            qr_image_base64: isMomo ? uploadedMomoQrBase64 : null,
          }),
        });
        const data = await res.json();
        if (data.success) {
          document.getElementById('acc-no').value = '';
          if (document.getElementById('acc-momo-link')) document.getElementById('acc-momo-link').value = '';
          removeMomoQrImage();
          showToast('Đã thêm tài khoản thanh toán thành công!');
          loadPaymentAccounts();
        } else {
          alert(data.error);
        }
      } catch (err) {
        alert('Lỗi: ' + err.message);
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    async function setDefaultAccount(id) {
      await fetch('/api/payment-accounts/' + id + '/default', { method: 'PUT' });
      showToast('Đã chuyển tài khoản mặc định!');
      loadPaymentAccounts();
    }

    async function deletePaymentAccount(id) {
      if (!confirm('Xóa tài khoản này?')) return;
      await fetch('/api/payment-accounts/' + id, { method: 'DELETE' });
      showToast('Đã xóa tài khoản!');
      loadPaymentAccounts();
    }

    // Settings
    async function loadSettings() {
      try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        if (data.success && data.data) {
          if (data.data.gas_url) document.getElementById('setting-gas-url').value = data.data.gas_url;
          if (data.data.sender_name) document.getElementById('setting-sender-name').value = data.data.sender_name;
          if (data.data.admin_email) document.getElementById('setting-admin-email').value = data.data.admin_email;
        }
      } catch (err) {
        console.error('Lỗi tải cài đặt:', err);
      }
    }

    async function saveSettings() {
      const gas_url = document.getElementById('setting-gas-url').value.trim();
      const sender_name = document.getElementById('setting-sender-name').value.trim();
      const admin_email = document.getElementById('setting-admin-email').value.trim();
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gas_url, sender_name, admin_email }),
      });
      const data = await res.json();
      if (data.success) {
        alert('Đã lưu cấu hình thành công!');
      } else {
        alert(data.error);
      }
    }

    async function logout() {
      if (!confirm('Bạn có chắc chắn muốn đăng xuất?')) return;
      try {
        await fetch('/api/logout', { method: 'POST' });
        window.location.reload();
      } catch (err) {
        window.location.reload();
      }
    }

    async function changeAppPassword() {
      const pwInput = document.getElementById('setting-app-password');
      const newPassword = (pwInput.value || '').trim();
      if (!newPassword) {
        alert('Vui lòng nhập mật khẩu mới');
        return;
      }
      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_password: newPassword }),
        });
        const data = await res.json();
        if (data.success) {
          alert('Đã cập nhật mật khẩu mới thành công! Vui lòng ghi nhớ mật khẩu này.');
          pwInput.value = '';
        } else {
          alert('Lỗi: ' + (data.error || 'Không đổi được mật khẩu'));
        }
      } catch (e) {
        alert('Lỗi cập nhật mật khẩu: ' + e.message);
      }
    }

    async function loadUsersList() {
      const tbody = document.getElementById('users-list-tbody');
      if (!tbody) return;
      tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-xs text-slate-400">Đang tải danh sách tài khoản...</td></tr>';
      try {
        const res = await fetch('/api/users');
        const data = await res.json();
        if (!data.success) {
          tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-xs text-red-500">' + (data.error || 'Không tải được danh sách') + '</td></tr>';
          return;
        }

        if (!data.data || !data.data.length) {
          tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-xs text-slate-400">Chưa có người dùng nào</td></tr>';
          return;
        }

        tbody.innerHTML = data.data.map(u => {
          const isUAdmin = u.role === 'admin';
          const roleBadge = isUAdmin
            ? '<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-amber-100 text-amber-800 border border-amber-300">👑 Admin</span>'
            : '<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-slate-100 text-slate-600 border border-slate-200">👤 Guest</span>';
          const deleteBtn = isUAdmin || u.username === 'phupx1'
            ? '<span class="text-xs text-slate-300 cursor-not-allowed" title="Không thể xóa Admin">—</span>'
            : '<button type="button" data-id="' + u.id + '" data-username="' + u.username + '" onclick="confirmDeleteUser(this)" class="text-slate-400 hover:text-red-600 p-1.5 rounded-lg hover:bg-red-50 transition-colors cursor-pointer" title="Xóa tài khoản"><i data-lucide="trash-2" class="w-4 h-4"></i></button>';
          return '<tr class="hover:bg-slate-50/70 transition-colors">' +
            '<td class="p-3 font-mono font-semibold text-slate-800">' + u.username + '</td>' +
            '<td class="p-3 text-slate-700">' + (u.full_name || '—') + '</td>' +
            '<td class="p-3 text-center">' + roleBadge + '</td>' +
            '<td class="p-3 text-xs text-slate-400">' + (u.created_at ? u.created_at.split(' ')[0] : '—') + '</td>' +
            '<td class="p-3 text-center">' + deleteBtn + '</td>' +
          '</tr>';
        }).join('');
        lucide.createIcons();
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-xs text-red-500">Lỗi kết nối: ' + err.message + '</td></tr>';
      }
    }

    async function confirmDeleteUser(btn) {
      const id = btn.getAttribute('data-id');
      const username = btn.getAttribute('data-username');
      if (!confirm('Bạn có chắc chắn muốn xóa tài khoản "' + username + '"?')) return;
      try {
        const res = await fetch('/api/users/' + id, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
          showToast('Đã xóa tài khoản "' + username + '"');
          loadUsersList();
        } else {
          alert('Lỗi: ' + (data.error || 'Không thể xóa'));
        }
      } catch (err) {
        alert('Lỗi: ' + err.message);
      }
    }

    // Initial Load (Chỉ tải các module nếu phần tử tồn tại trong DOM của role hiện tại)
    if (document.getElementById('payment-accounts-list')) {
      loadPaymentAccounts();
    }
    if (document.getElementById('members-list-tbody')) {
      loadMembers();
    }
  </script>
</body>
</html>`);
});

export default app;
