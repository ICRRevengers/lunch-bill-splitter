/**
 * ==============================================================================
 * GOOGLE APPS SCRIPT: LUNCH BILL NOTIFICATION SERVICE
 * ==============================================================================
 * Dịch vụ gửi email thông báo tiền cơm trưa văn phòng trực tiếp từ Gmail cá nhân.
 * 
 * HƯỚNG DẪN CÀI ĐẶT TỪNG BƯỚC CHO ALVISS:
 * 1. Truy cập https://script.google.com/home trên trình duyệt (đăng nhập tài khoản Google của bạn).
 * 2. Bấm vào nút "+ Dự án mới" (New project) ở góc trên bên trái.
 * 3. Đặt tên dự án (ví dụ: "Lunch Bill Mailer").
 * 4. Xóa hết code mẫu mặc định trong file `Mã.gs` (Code.gs) và DÁN TOÀN BỘ file này vào.
 * 5. Bấm vào biểu tượng Đĩa mềm (Save) hoặc nhấn Ctrl + S để lưu lại.
 * 6. Bấm nút màu xanh "Triển khai" (Deploy) ở góc trên bên phải -> Chọn "Tùy chọn triển khai mới" (New deployment).
 * 7. Bấm vào biểu tượng Bánh răng (Select type) -> Chọn "Ứng dụng web" (Web app).
 * 8. Cấu hình như sau:
 *    - Mô tả: "Lunch Mailer Web App"
 *    - Thực thi dưới dạng (Execute as): "Tôi (<địa_chỉ_email_của_bạn>)" (Me)
 *    - Ai có quyền truy cập (Who has access): "Bất kỳ ai" (Anyone) -> RẤT QUAN TRỌNG để Cloudflare Worker có thể gọi tới.
 * 9. Bấm nút "Triển khai" (Deploy).
 * 10. Google sẽ yêu cầu "Ủy quyền truy cập" (Authorize access):
 *     - Bấm "Xem lại quyền" (Review permissions) -> Chọn tài khoản Google của bạn.
 *     - Nếu hiện cảnh báo "Google chưa xác minh ứng dụng này" (Google hasn't verified this app):
 *       -> Bấm vào "Nâng cao" (Advanced) ở góc dưới.
 *       -> Bấm vào link "Đi tới Lunch Bill Mailer (không an toàn)" (Go to Lunch Bill Mailer).
 *       -> Bấm "Cho phép" (Allow).
 * 11. Copy chuỗi "URL ứng dụng web" (Web App URL) có dạng:
 *     https://script.google.com/macros/s/AKfycbx.../exec
 * 12. Mở Web Tool "Lunch Bill Splitter", vào Tab "⚙️ Cài Đặt", dán URL này vào ô "Google Apps Script Web App URL" và bấm Lưu.
 * ==============================================================================
 */

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ success: false, error: "Empty request body" }, 400);
    }

    var data = JSON.parse(e.postData.contents);
    var storeName = data.store_name || "Bữa trưa văn phòng";
    var dateStr = data.date || Utilities.formatDate(new Date(), "GMT+7", "dd/MM/yyyy");
    var adminEmail = data.admin_email || "";
    var members = data.members || []; // Danh sách từng người

    var sentCount = 0;
    var errors = [];

    // 1. Gửi email cho từng thành viên
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      if (!m.email || m.email.indexOf("@") === -1) {
        continue;
      }

      var subject = "[Ăn Trưa] Tiền cơm ngày " + dateStr + " - " + storeName;
      var htmlBody = buildMemberEmailHtml(m, storeName, dateStr);

      try {
        GmailApp.sendEmail(m.email, subject, "", {
          htmlBody: htmlBody,
          name: "Ăn Trưa Văn Phòng"
        });
        sentCount++;
      } catch (err) {
        errors.push("Lỗi gửi cho " + m.email + ": " + err.toString());
      }
    }

    // 2. Gửi email tổng hợp cho Alviss (admin)
    if (adminEmail && adminEmail.indexOf("@") !== -1) {
      var adminSubject = "[Ăn Trưa Tổng Hợp] Bảng kê tiền cơm ngày " + dateStr + " - " + storeName;
      var adminHtml = buildAdminEmailHtml(data, storeName, dateStr);
      try {
        GmailApp.sendEmail(adminEmail, adminSubject, "", {
          htmlBody: adminHtml,
          name: "Ăn Trưa Văn Phòng"
        });
      } catch (err) {
        errors.push("Lỗi gửi admin summary: " + err.toString());
      }
    }

    return jsonResponse({
      success: true,
      message: "Đã gửi " + sentCount + " email thành công!",
      sent_count: sentCount,
      errors: errors
    });

  } catch (globalErr) {
    return jsonResponse({
      success: false,
      error: globalErr.toString()
    }, 500);
  }
}

function doGet(e) {
  return jsonResponse({
    status: "ok",
    service: "Lunch Bill Mailer (Google Apps Script)",
    time: new Date().toISOString()
  });
}

function jsonResponse(obj, status) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function formatVND(num) {
  if (!num) return "0 đ";
  return Number(num).toLocaleString("vi-VN") + " đ";
}

function buildMemberEmailHtml(m, storeName, dateStr) {
  var qrImgTag = "";
  if (m.vietqr_url) {
    qrImgTag = '<div style="text-align: center; margin: 20px 0;">' +
      '<p style="font-weight: 600; color: #1e293b; margin-bottom: 8px;">Quét mã VietQR để thanh toán nhanh:</p>' +
      '<img src="' + m.vietqr_url + '" alt="Mã VietQR" style="max-width: 260px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); border: 1px solid #e2e8f0;" />' +
      '</div>';
  }

  var bankInfoHtml = "";
  if (m.bank_info) {
    bankInfoHtml = '<div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-top: 15px; font-size: 13px; color: #334155;">' +
      '<strong>Thông tin chuyển khoản:</strong><br>' +
      '• Ngân hàng: <b>' + (m.bank_info.bank || "") + '</b><br>' +
      '• Số tài khoản: <b style="color: #2563eb;">' + (m.bank_info.account_no || "") + '</b><br>' +
      '• Chủ tài khoản: <b>' + (m.bank_info.account_holder || "") + '</b><br>' +
      '• Nội dung: <b style="color: #ea580c;">AN TRUA ' + (m.name || "") + '</b>' +
      '</div>';
  }

  return '<!DOCTYPE html>' +
    '<html><head><meta charset="utf-8"></head>' +
    '<body style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; padding: 20px; margin: 0;">' +
    '<div style="max-width: 500px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.06);">' +
    '  <div style="background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); padding: 24px 20px; color: #ffffff; text-align: center;">' +
    '    <h2 style="margin: 0; font-size: 20px;">🍱 Tiền Ăn Trưa Văn Phòng</h2>' +
    '    <p style="margin: 6px 0 0; opacity: 0.9; font-size: 14px;">Quán: <b>' + storeName + '</b> (' + dateStr + ')</p>' +
    '  </div>' +
    '  <div style="padding: 24px 20px;">' +
    '    <p style="font-size: 16px; color: #1e293b; margin-top: 0;">Xin chào <b>' + (m.name || "bạn") + '</b>,</p>' +
    '    <p style="color: #475569; font-size: 14px; line-height: 1.5;">Dưới đây là chi tiết tiền ăn trưa của bạn hôm nay:</p>' +
    '    <div style="background-color: #fff7ed; border-left: 4px solid #f97316; padding: 12px 16px; margin: 16px 0; border-radius: 0 8px 8px 0;">' +
    '      <div style="font-weight: 600; color: #9a3412; font-size: 15px;">' + (m.dish_name || "Món ăn") + '</div>' +
    '      <div style="display: flex; justify-content: space-between; font-size: 13px; color: #7c2d12; margin-top: 6px;">' +
    '        <span>Giá gốc món:</span> <span>' + formatVND(m.original_price) + '</span>' +
    '      </div>' +
    (m.discount ? '      <div style="display: flex; justify-content: space-between; font-size: 13px; color: #16a34a; margin-top: 2px;">' +
    '        <span>Giảm giá món:</span> <span>-' + formatVND(m.discount) + '</span>' +
    '      </div>' : '') +
    (m.shipping_fee ? '      <div style="display: flex; justify-content: space-between; font-size: 13px; color: #0284c7; margin-top: 2px;">' +
    '        <span>Phí ship chia đều:</span> <span>+' + formatVND(m.shipping_fee) + '</span>' +
    '      </div>' : '') +
    '      <div style="border-top: 1px dashed #fdba74; margin-top: 8px; padding-top: 8px; display: flex; justify-content: space-between; font-size: 16px; font-weight: 700; color: #c2410c;">' +
    '        <span>CẦN THANH TOÁN:</span> <span>' + formatVND(m.final_amount) + '</span>' +
    '      </div>' +
    '    </div>' +
    qrImgTag +
    bankInfoHtml +
    '    <p style="text-align: center; color: #94a3b8; font-size: 12px; margin-top: 24px;">Cảm ơn bạn! Chúc bạn bữa trưa ngon miệng.</p>' +
    '  </div>' +
    '</div></body></html>';
}

function buildAdminEmailHtml(data, storeName, dateStr) {
  var members = data.members || [];
  var rowsHtml = "";
  var totalAmount = 0;

  for (var i = 0; i < members.length; i++) {
    var m = members[i];
    totalAmount += (m.final_amount || 0);
    rowsHtml += '<tr style="border-bottom: 1px solid #e2e8f0;">' +
      '<td style="padding: 10px; font-weight: 500;">' + (m.name || "") + '</td>' +
      '<td style="padding: 10px; color: #64748b;">' + (m.dish_name || "") + '</td>' +
      '<td style="padding: 10px; text-align: right; font-weight: 600; color: #ea580c;">' + formatVND(m.final_amount) + '</td>' +
      '</tr>';
  }

  return '<!DOCTYPE html>' +
    '<html><head><meta charset="utf-8"></head>' +
    '<body style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif; background-color: #f1f5f9; padding: 20px;">' +
    '<div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; padding: 24px; box-shadow: 0 4px 20px rgba(0,0,0,0.06);">' +
    '  <h2 style="color: #1e293b; margin-top: 0;">📊 Bảng Tổng Hợp Tiền Ăn Trưa</h2>' +
    '  <p style="color: #64748b; font-size: 14px;">Quán: <b>' + storeName + '</b> | Ngày: <b>' + dateStr + '</b></p>' +
    '  <table style="width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 14px;">' +
    '    <thead>' +
    '      <tr style="background-color: #f8fafc; border-bottom: 2px solid #cbd5e1; text-align: left;">' +
    '        <th style="padding: 10px;">Thành viên</th>' +
    '        <th style="padding: 10px;">Món</th>' +
    '        <th style="padding: 10px; text-align: right;">Cần thu</th>' +
    '      </tr>' +
    '    </thead>' +
    '    <tbody>' + rowsHtml + '</tbody>' +
    '    <tfoot>' +
    '      <tr style="background-color: #fff7ed; font-weight: 700;">' +
    '        <td colspan="2" style="padding: 12px 10px; color: #9a3412;">TỔNG TIỀN CẦN THU:</td>' +
    '        <td style="padding: 12px 10px; text-align: right; color: #ea580c; font-size: 16px;">' + formatVND(totalAmount) + '</td>' +
    '      </tr>' +
    '    </tfoot>' +
    '  </table>' +
    '</div></body></html>';
}
