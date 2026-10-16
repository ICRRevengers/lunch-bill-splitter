# Project Guidelines & Agent Instructions

## Triển Khai & CI/CD (Cloudflare Workers Builds)
- Dự án này đã được cấu hình CI/CD tự động bằng **Cloudflare Workers Builds** kết nối với repository GitHub `ICRRevengers/lunch-bill-splitter`.
- Mỗi khi code được commit và push lên nhánh `main`, Cloudflare sẽ tự động build và deploy lên production (`https://lunch.16092001.xyz`).
- **Tuyệt đối không chạy lệnh `npx wrangler deploy` thủ công** mỗi lần sửa code (trừ khi có sự cố mạng hoặc người dùng yêu cầu đặc biệt).

## Quy Tắc Phản Hồi Khi Thay Đổi Code
- Sau mỗi lượt làm việc có sửa đổi file/code trong repo, ở cuối phản hồi **LUÔN nhắc ngắn gọn một câu** hỏi người dùng có cần commit và push lên Git luôn không (để phòng trường hợp người dùng quên push khiến phiên bản mới chưa tự deploy).
