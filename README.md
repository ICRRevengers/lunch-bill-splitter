# 🍱 Lunch Bill Splitter (Cloudflare Serverless)

Hệ thống quản lý, quét hóa đơn và chia tiền ăn trưa văn phòng fullstack vận hành trên nền tảng **Cloudflare Serverless (Worker + D1 + R2)**, kết hợp năng lực AI của **Antigravity CLI trên VPS** và dịch vụ gửi mail qua **Google Apps Script cá nhân**.

---

## 🌟 Tính Năng Nổi Bật

1. **Quét Hóa Đơn Thông Minh (Zero GCP / Zero Third-Party API):**
   - Hỗ trợ ảnh chụp màn hình đơn hàng từ ShopeeFood, GrabFood, Baemin...
   - Tự động bóc tách: Tên quán, người đặt món, tên món ăn, số lượng, giá gốc, voucher giảm giá món, phí ship, phụ phí, tổng tiền thực tế.
   - Tự động đối chiếu với **Danh bạ thành viên** để gán email chính xác cho từng người.

2. **Thuật Toán Chia Tiền Công Bằng (Fair Proportional Split):**
   - Giảm giá món (Voucher món) được phân bổ theo tỷ lệ giá trị món từng người đặt.
   - Phí giao hàng & phí dịch vụ thực tế được chia đều theo đầu người ($N$).
   - Làm tròn tiền đến nghìn đồng (chuẩn VNĐ) và tự bù trừ sai số vào người tạo đơn.

3. **Tích Hợp VietQR Chuẩn NAPAS Đa Thiết Bị:**
   - Quản lý danh sách STK ngân hàng nhận tiền lưu trong Cloudflare D1 (tự động đồng bộ trên điện thoại, máy tính bàn, laptop).
   - Tự động tạo link ảnh VietQR động gắn đúng số tiền và nội dung chuyển khoản `AN TRUA [TEN]`.

4. **Gửi Thông Báo Cá Nhân Qua Gmail (Google Apps Script):**
   - Gửi email riêng cho từng người kèm chi tiết món ăn, số tiền và ảnh VietQR để quét thanh toán.
   - Gửi email tổng hợp cho Alviss (admin) kèm bảng kê toàn bộ đơn hàng.
   - Miễn phí 100%, gửi trực tiếp từ hộp thư Gmail của bạn, không lo rơi vào thư rác.

5. **Giao Diện Responsive Mobile & Desktop:**
   - Single-Page App hiện đại (Tailwind CSS, Lucide Icons) chạy mượt mà trên cả trình duyệt máy tính và điện thoại.
   - Quản lý danh bạ thành viên (Tên ↔ Email) và tài khoản ngân hàng trực tiếp trên UI.

---

## 🏗 Kiến Trúc Kỹ Thuật

- **Frontend & Backend API:** [Hono Framework](https://hono.dev/) đóng gói trong 1 Cloudflare Worker duy nhất (`src/index.js`).
- **Cơ sở dữ liệu:** Cloudflare D1 (`lunch-db`) với đầy đủ chỉ mục (`INDEX`) tối ưu hóa số lượt đọc.
- **Lưu trữ hóa đơn:** Cloudflare R2 (`lunch-bills`) lưu ảnh gốc.
- **AI Scanner Bridge:** Daemon Python trên VPS (`scripts/linux/bill-scanner/`) lắng nghe tại `127.0.0.1:2309`, proxy qua Caddy tại `lunch-bill-splitter-api.16092001.xyz`, gọi Antigravity CLI (`agy -p`).
- **Gửi Email:** Google Apps Script Web App (`google-apps-script.js`).

---

## 🚀 Hướng Dẫn Cài Đặt & Triển Khai

### 1. Cài đặt Google Apps Script gửi mail
Xem hướng dẫn chi tiết từng bước trong file [`google-apps-script.js`](google-apps-script.js).

### 2. Triển khai Worker lên Cloudflare (CI/CD Tự Động)

> [!IMPORTANT]
> **Dự án đã được thiết lập Auto-Deploy qua Cloudflare Workers Builds!**
> - Mỗi khi có commit mới được **`git push` lên nhánh `main`** trên GitHub, Cloudflare sẽ **tự động pull mã nguồn, build và deploy** lên Production (`https://lunch.16092001.xyz`).
> - **KHÔNG CẦN** chạy lệnh `npx wrangler deploy` thủ công mỗi lần sửa code. Mọi thay đổi chỉ cần commit và push lên Git là hoàn tất triển khai.

#### Biến môi trường & Secrets (chỉ cấu hình một lần đầu)
Trong Cloudflare Dashboard -> Worker `lunch-bill-splitter` -> **Settings** -> **Variables and Secrets**:
- Thêm Secret `SCANNER_SECRET_TOKEN`: Mã token trong file `~/.config/phu/secrets.env` trên VPS (hoặc nạp qua `npx wrangler secret put SCANNER_SECRET_TOKEN`).

