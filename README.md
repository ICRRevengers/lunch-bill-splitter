# 🧾 Bill Splitter (Cloudflare Serverless)

Hệ thống bóc tách và phân chia chi phí nhóm tự động, dùng cho nhiều mục đích: mua sắm chung, liên hoan, cà phê, du lịch, sự kiện văn phòng... Vận hành trên nền tảng **Cloudflare Serverless (Worker + D1 + R2)**, kết hợp năng lực AI của **Antigravity CLI trên VPS** và dịch vụ gửi mail qua **Google Apps Script cá nhân**.

---

## 🌟 Tính Năng Nổi Bật

1. **Bóc Tách Ảnh Đơn Thông Minh (Zero GCP / Zero Third-Party API):**
   - Hỗ trợ ảnh chụp màn hình đơn từ các ứng dụng giao hàng, siêu thị, cửa hàng...
   - Tự động bóc tách: Địa điểm, người chọn, từng mục, số lượng, giá gốc, ưu đãi giảm, phí giao hàng, phụ phí, tổng thực trả.
   - Tự động đối chiếu với **Danh bạ thành viên** để gán email chính xác cho từng người.

2. **Thuật Toán Phân Chia Công Bằng (Fair Proportional Split):**
   - Ưu đãi giảm được phân bổ theo tỷ lệ giá trị từng mục của mỗi người.
   - Phí giao hàng & phí dịch vụ thực tế được chia đều theo số thành viên ($N$).
   - Làm tròn đến nghìn đồng (chuẩn VNĐ) và tự bù trừ sai số vào người tạo đơn.

3. **Tích Hợp VietQR Chuẩn NAPAS & MoMo:**
   - Quản lý tài khoản nhận chuyển khoản lưu trong Cloudflare D1 (đồng bộ trên mọi thiết bị).
   - Tự động tạo ảnh VietQR động gắn đúng số cần chuyển và nội dung `SPLIT [TEN]`.

4. **Gửi Thông Báo Cá Nhân Qua Gmail (Google Apps Script):**
   - Gửi email riêng cho từng người kèm chi tiết phần của họ và mã QR để thanh toán.
   - Gửi email bảng tổng hợp cho admin.
   - Miễn phí 100%, gửi trực tiếp từ hộp thư Gmail của bạn.

5. **Tài Khoản & Phân Quyền:**
   - Đăng ký bằng email, xác thực OTP; đăng nhập bằng email + mật khẩu.
   - Guest tự cấu hình tài khoản thanh toán của mình trong tab Settings.

6. **Giao Diện Responsive Mobile & Desktop:**
   - Single-Page App hiện đại (Tailwind CSS, Lucide Icons).
   - Quản lý danh bạ thành viên (Tên ↔ Email) và tài khoản nhận chuyển khoản trực tiếp trên UI.

---

## 🏗 Kiến Trúc Kỹ Thuật

- **Frontend & Backend API:** [Hono Framework](https://hono.dev/) đóng gói trong 1 Cloudflare Worker duy nhất (`src/index.js`).
- **Cơ sở dữ liệu:** Cloudflare D1 (`lunch-db`).
- **Lưu trữ ảnh:** Cloudflare R2 (`lunch-bills`) lưu ảnh gốc.
- **AI Scanner Bridge:** Daemon Python trên VPS (`scripts/linux/bill-scanner/`) lắng nghe tại `127.0.0.1:2309`, proxy qua Caddy tại `lunch-bill-splitter-api.16092001.xyz`, gọi Antigravity CLI (`agy -p`).
- **Gửi Email:** Google Apps Script Web App (`gas/Mã.js`, bản sao tại `google-apps-script.js`).

> [!NOTE]
> Tên các tài nguyên hạ tầng (`lunch-db`, `lunch-bills`, domain `lunch.16092001.xyz`, repo) được giữ nguyên để không gián đoạn dữ liệu và CI/CD hiện có.

---

## 🚀 Hướng Dẫn Cài Đặt & Triển Khai

### 1. Cài đặt Google Apps Script gửi mail
Xem hướng dẫn chi tiết từng bước trong file [`google-apps-script.js`](google-apps-script.js), hoặc dùng `npx clasp push && npx clasp deploy -i <DEPLOYMENT_ID>`.

### 2. Triển khai Worker lên Cloudflare (CI/CD Tự Động)

> [!IMPORTANT]
> **Dự án đã được thiết lập Auto-Deploy qua Cloudflare Workers Builds!**
> - Mỗi khi có commit mới được **`git push` lên nhánh `main`** trên GitHub, Cloudflare sẽ **tự động pull mã nguồn, build và deploy** lên Production (`https://lunch.16092001.xyz`).
> - **KHÔNG CẦN** chạy lệnh `npx wrangler deploy` thủ công mỗi lần sửa code. Mọi thay đổi chỉ cần commit và push lên Git là hoàn tất triển khai.

#### Biến môi trường & Secrets (chỉ cấu hình một lần đầu)
Trong Cloudflare Dashboard -> Worker `lunch-bill-splitter` -> **Settings** -> **Variables and Secrets**:
- Thêm Secret `SCANNER_SECRET_TOKEN`: Mã token trong file `~/.config/phu/secrets.env` trên VPS (hoặc nạp qua `npx wrangler secret put SCANNER_SECRET_TOKEN`).
