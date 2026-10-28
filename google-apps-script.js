/**
 * ==============================================================================
 * GOOGLE APPS SCRIPT: BILL SPLITTER NOTIFICATION SERVICE (CHỐNG SPAM TỐI ĐA)
 * ==============================================================================
 * Dịch vụ gửi email thông báo chi tiết phần chia của từng thành viên trực tiếp từ Gmail cá nhân.
 * 
 * CÁC CẢI TIẾN CHỐNG SPAM:
 * 1. Bổ sung nội dung Plain Text (Multipart/alternative) đầy đủ - giải quyết lỗi HTML-only.
 * 2. Tinh chỉnh từ ngữ tự nhiên, loại bỏ các từ khóa kích hoạt bộ lọc lừa đảo hóa đơn (Invoice Phishing).
 * 3. Hỗ trợ tùy chỉnh Tên người gửi (Sender Name) thân thiện (mặc định: Bill Splitter hoặc tên bạn).
 * 4. Tự động giãn cách thời gian gửi (Rate limiting 800ms) tránh bị nghi ngờ gửi hàng loạt.
 * 
 * HƯỚNG DẪN CẬP NHẬT CHO DỰ ÁN ĐÃ TRIỂN KHAI:
 * 1. Mở lại dự án Google Apps Script của bạn tại https://script.google.com/home
 * 2. Dán đè toàn bộ code này vào file `Mã.gs` (hoặc `Code.gs`).
 * 3. Bấm biểu tượng Đĩa mềm (Save) hoặc Ctrl + S để lưu lại.
 * 4. Bấm "Triển khai" (Deploy) ở góc trên bên phải -> Chọn "Quản lý bản triển khai" (Manage deployments).
 * 5. Bấm vào biểu tượng Cây Bút (Edit) ở góc trên bên phải của bản triển khai Web App hiện tại.
 * 6. Tại dòng "Phiên bản" (Version), chọn "Phiên bản mới" (New version).
 * 7. Bấm "Triển khai" (Deploy) -> Xong! (URL Web App cũ vẫn giữ nguyên, không cần cấu hình lại).
 * ==============================================================================
 */

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ success: false, error: "Empty request body" }, 400);
    }

    var data = JSON.parse(e.postData.contents);

    // XỬ LÝ GỬI MÃ OTP XÁC THỰC EMAIL
    if (data.action === "send_otp") {
      var targetEmail = (data.email || "").trim();
      var otpCode = data.otp;
      var appName = data.sender_name || "Bill Splitter";

      if (!targetEmail || !otpCode) {
        return jsonResponse({ success: false, error: "Thiếu email hoặc mã OTP" }, 400);
      }

      var otpSubject = "Mã xác thực tài khoản Bill Splitter: " + otpCode;
      var otpPlainText = "Xin chào,\n\nMã xác thực (OTP) cho tài khoản Bill Splitter của bạn là: " + otpCode + "\nMã có hiệu lực trong vòng 5 phút. Vui lòng không chia sẻ mã này cho người khác.\n\nTrân trọng!";
      var otpHtml = '<div style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif; max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">' +
        '<div style="background: #ea580c; padding: 24px 20px; text-align: center; color: #ffffff;">' +
        '  <h2 style="margin: 0; font-size: 20px; font-weight: bold;">Xác Thực Email Đăng Ký</h2>' +
        '  <p style="margin: 6px 0 0; opacity: 0.9; font-size: 13px;">Bill Splitter — Phân chia chi phí nhóm</p>' +
        '</div>' +
        '<div style="padding: 24px 20px; text-align: center; color: #334155;">' +
        '  <p style="font-size: 14px; margin-top: 0;">Xin chào <b>' + targetEmail + '</b>,</p>' +
        '  <p style="font-size: 14px; color: #64748b; line-height: 1.5;">Bạn đang thực hiện đăng ký tài khoản trên hệ thống. Dưới đây là mã xác thực OTP của bạn:</p>' +
        '  <div style="margin: 24px auto; display: inline-block; background: #fff7ed; border: 2px dashed #ea580c; padding: 12px 32px; border-radius: 12px;">' +
        '    <span style="font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #ea580c; font-family: monospace;">' + otpCode + '</span>' +
        '  </div>' +
        '  <p style="font-size: 12px; color: #94a3b8; margin: 0;">Mã có hiệu lực trong <b>5 phút</b>. Vui lòng không chia sẻ mã này cho bất kỳ ai.</p>' +
        '</div>' +
        '</div>';

      GmailApp.sendEmail(targetEmail, otpSubject, otpPlainText, {
        htmlBody: otpHtml,
        name: appName
      });

      return jsonResponse({
        success: true,
        message: "Đã gửi mã OTP đến " + targetEmail
      });
    }

    var storeName = data.store_name || "Đơn chung";
    var dateStr = data.date || Utilities.formatDate(new Date(), "GMT+7", "dd/MM/yyyy");
    var adminEmail = data.admin_email || "";
    var senderName = data.sender_name || "Bill Splitter";
    var members = data.members || []; // Danh sách từng người

    var sentCount = 0;
    var errors = [];

    // 1. Gửi email cho từng thành viên
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      if (!m.email || m.email.indexOf("@") === -1) {
        continue;
      }

      var memberName = (m.name || "bạn").trim();
      // Tiêu đề tự nhiên, không dùng thẻ ngoặc vuông [...] hay từ "tiền" để tránh bộ lọc spam
      var subject = storeName + " (" + dateStr + ") - " + memberName;
      var plainTextBody = buildMemberPlainText(m, storeName, dateStr);
      var htmlBody = buildMemberEmailHtml(m, storeName, dateStr);

      try {
        GmailApp.sendEmail(m.email, subject, plainTextBody, {
          htmlBody: htmlBody,
          name: senderName
        });
        sentCount++;
        // Giãn cách gửi để trông tự nhiên, tránh bị Gmail phát hiện gửi hàng loạt dồn dập
        Utilities.sleep(800);
      } catch (err) {
        errors.push("Lỗi gửi cho " + m.email + ": " + err.toString());
      }
    }

    // 2. Gửi email tổng hợp cho admin
    if (adminEmail && adminEmail.indexOf("@") !== -1) {
      var adminSubject = "Bảng tổng hợp " + storeName + " (" + dateStr + ")";
      var adminPlainText = buildAdminPlainText(data, storeName, dateStr);
      var adminHtml = buildAdminEmailHtml(data, storeName, dateStr);
      try {
        GmailApp.sendEmail(adminEmail, adminSubject, adminPlainText, {
          htmlBody: adminHtml,
          name: senderName
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
    service: "Lunch Bill Mailer (Google Apps Script Anti-Spam)",
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

function buildMemberPlainText(m, storeName, dateStr) {
  var lines = [
    "Xin chào " + (m.name || "bạn") + ",",
    "",
    "Dưới đây là chi tiết phần của bạn tại " + storeName + " (" + dateStr + "):",
    "----------------------------------------",
    "- Mục: " + (m.dish_name || "Mục đã chọn"),
    "- Giá gốc: " + formatVND(m.original_price)
  ];
  if (m.discount) {
    lines.push("- Ưu đãi giảm: -" + formatVND(m.discount));
  }
  if (m.shipping_fee) {
    lines.push("- Phí chia sẻ: +" + formatVND(m.shipping_fee));
  }
  lines.push("----------------------------------------");
  lines.push("TỔNG PHẦN BẠN: " + formatVND(m.final_amount));
  lines.push("----------------------------------------");

  if (m.bank_info) {
    lines.push("");
    lines.push("THÔNG TIN CHUYỂN KHOẢN:");
    var code = (m.bank_info.bank_code || m.bank_info.bank || "").toUpperCase();
    var name = (m.bank_info.bank_name || "").toUpperCase();
    var isMomo = (code === "MOMO" || code === "971025" || name.indexOf("MOMO") !== -1);
    if (isMomo) {
      lines.push("- Hình thức: Ví MoMo");
      if (m.bank_info.account_no) lines.push("- Số ví: " + m.bank_info.account_no);
      if (m.bank_info.account_holder) lines.push("- Chủ ví: " + m.bank_info.account_holder);
    } else {
      lines.push("- Ngân hàng: " + (m.bank_info.bank_name || m.bank_info.bank_code || m.bank_info.bank || ""));
      if (m.bank_info.account_no) lines.push("- Số tài khoản: " + m.bank_info.account_no);
      if (m.bank_info.account_holder) lines.push("- Chủ tài khoản: " + m.bank_info.account_holder);
    }
    lines.push("- Cần chuyển: " + formatVND(m.final_amount));
    lines.push("- Lời nhắn: SPLIT " + (m.name || ""));
  }

  lines.push("");
  lines.push("Chúc bạn một ngày làm việc hiệu quả!");
  return lines.join("\n");
}

function buildAdminPlainText(data, storeName, dateStr) {
  var members = data.members || [];
  var totalAmount = 0;
  var lines = [
    "BẢNG KÊ TỔNG HỢP",
    "Địa điểm: " + storeName,
    "Ngày: " + dateStr,
    "----------------------------------------"
  ];
  for (var i = 0; i < members.length; i++) {
    var m = members[i];
    totalAmount += (m.final_amount || 0);
    lines.push((i + 1) + ". " + (m.name || "Thành viên") + " (" + (m.dish_name || "") + "): " + formatVND(m.final_amount));
  }
  lines.push("----------------------------------------");
  lines.push("TỔNG CỘNG: " + formatVND(totalAmount));
  return lines.join("\n");
}

function buildMemberEmailHtml(m, storeName, dateStr) {
  var isMomo = false;
  if (m.bank_info) {
    var code = (m.bank_info.bank_code || m.bank_info.bank || "").toUpperCase();
    var name = (m.bank_info.bank_name || "").toUpperCase();
    if (code === "MOMO" || code === "971025" || name.indexOf("MOMO") !== -1) {
      isMomo = true;
    }
  }

  // Nút mở MoMo nếu là ví MoMo
  var momoButtonHtml = "";
  var momoUrl = "";
  if (isMomo && m.bank_info) {
    momoUrl = (m.bank_info.payment_link || "").trim();
    if (!momoUrl && m.bank_info.account_no) {
      momoUrl = 'https://me.momo.vn/' + m.bank_info.account_no;
    }
  }
  if (isMomo && momoUrl) {
    momoButtonHtml = '<div style="text-align: center; margin: 18px 0 8px 0;">' +
      '<a href="' + momoUrl + '" target="_blank" style="background-color: #d82d8b; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; font-size: 14px; display: inline-block; box-shadow: 0 2px 6px rgba(216,45,139,0.3);">' +
      'Mở Ví MoMo' +
      '</a>' +
      '</div>' +
      '<p style="text-align: center; font-size: 12px; color: #64748b; margin: 0 0 16px 0; line-height: 1.4;">' +
      '* Khi quét mã QR hoặc mở app MoMo, bạn vui lòng nhập số cần chuyển là <b style="color: #d82d8b;">' + formatVND(m.final_amount) + '</b>.' +
      '</p>';
  }

  // QR Code Image
  var qrImgTag = "";
  if (m.vietqr_url) {
    var qrHeading = isMomo 
      ? 'Mã QR MoMo nhận chuyển khoản:'
      : 'Mã VietQR chuyển khoản nhanh:';
    qrImgTag = '<div style="text-align: center; margin: 20px 0;">' +
      '<p style="font-weight: 600; color: #1e293b; margin-bottom: 8px; font-size: 13px;">' + qrHeading + '</p>' +
      '<img src="' + m.vietqr_url + '" alt="Mã QR Chuyển Khoản" style="max-width: 240px; width: 100%; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); border: 1px solid #e2e8f0;" />' +
      '</div>';
  }

  // Thông tin tài khoản
  var paymentInfoHtml = "";
  if (m.bank_info) {
    if (isMomo) {
      paymentInfoHtml = '<table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: #fdf2f8; border: 1px solid #fbcfe8; border-radius: 8px; padding: 14px; margin-top: 15px; font-size: 13px; color: #831843;">' +
        '<tr><td colspan="2" style="font-weight: bold; padding-bottom: 6px; color: #9d174d;">Thông tin ví nhận:</td></tr>' +
        '<tr><td style="padding: 3px 0; color: #701a75;">Hình thức:</td><td align="right" style="padding: 3px 0; font-weight: bold;">Ví MoMo</td></tr>' +
        '<tr><td style="padding: 3px 0; color: #701a75;">Số điện thoại ví:</td><td align="right" style="padding: 3px 0; font-weight: bold; color: #be185d;">' + (m.bank_info.account_no || "") + '</td></tr>' +
        '<tr><td style="padding: 3px 0; color: #701a75;">Chủ ví:</td><td align="right" style="padding: 3px 0; font-weight: bold;">' + (m.bank_info.account_holder || "") + '</td></tr>' +
        '<tr><td style="padding: 3px 0; color: #701a75;">Cần chuyển:</td><td align="right" style="padding: 3px 0; font-weight: bold; color: #be185d; font-size: 14px;">' + formatVND(m.final_amount) + '</td></tr>' +
        '<tr><td style="padding: 3px 0; color: #701a75;">Lời nhắn:</td><td align="right" style="padding: 3px 0; font-weight: bold; color: #ea580c;">SPLIT ' + (m.name || "") + '</td></tr>' +
        '</table>';
    } else {
      paymentInfoHtml = '<table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin-top: 15px; font-size: 13px; color: #334155;">' +
        '<tr><td colspan="2" style="font-weight: bold; padding-bottom: 6px; color: #0f172a;">Thông tin chuyển khoản:</td></tr>' +
        '<tr><td style="padding: 3px 0; color: #64748b;">Ngân hàng thụ hưởng:</td><td align="right" style="padding: 3px 0; font-weight: bold;">' + (m.bank_info.bank_name || m.bank_info.bank_code || m.bank_info.bank || "") + '</td></tr>' +
        '<tr><td style="padding: 3px 0; color: #64748b;">Số tài khoản:</td><td align="right" style="padding: 3px 0; font-weight: bold; color: #2563eb;">' + (m.bank_info.account_no || "") + '</td></tr>' +
        '<tr><td style="padding: 3px 0; color: #64748b;">Chủ tài khoản:</td><td align="right" style="padding: 3px 0; font-weight: bold;">' + (m.bank_info.account_holder || "") + '</td></tr>' +
        '<tr><td style="padding: 3px 0; color: #64748b;">Cần chuyển:</td><td align="right" style="padding: 3px 0; font-weight: bold; color: #ea580c; font-size: 14px;">' + formatVND(m.final_amount) + '</td></tr>' +
        '<tr><td style="padding: 3px 0; color: #64748b;">Lời nhắn:</td><td align="right" style="padding: 3px 0; font-weight: bold; color: #ea580c;">SPLIT ' + (m.name || "") + '</td></tr>' +
        '</table>';
    }
  }

  return '<!DOCTYPE html>' +
    '<html><head><meta charset="utf-8"></head>' +
    '<body style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; padding: 20px; margin: 0; color: #334155;">' +
    '<table width="100%" border="0" cellpadding="0" cellspacing="0">' +
    '  <tr><td align="center">' +
    '    <table width="100%" border="0" cellpadding="0" cellspacing="0" style="max-width: 520px; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.06); text-align: left;">' +
    '      <tr>' +
    '        <td style="background-color: #ea580c; padding: 24px 20px; color: #ffffff; text-align: center;">' +
    '          <div style="font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; opacity: 0.9; margin-bottom: 4px;">Chi Tiết Phần Bạn</div>' +
    '          <h1 style="margin: 0; font-size: 20px; font-weight: bold; color: #ffffff;">' + storeName + '</h1>' +
    '          <p style="margin: 6px 0 0; opacity: 0.95; font-size: 13px;">Ngày: <b>' + dateStr + '</b></p>' +
    '        </td>' +
    '      </tr>' +
    '      <tr>' +
    '        <td style="padding: 24px 20px;">' +
    '          <p style="font-size: 16px; color: #1e293b; margin-top: 0;">Xin chào <b>' + (m.name || "bạn") + '</b>,</p>' +
    '          <p style="color: #475569; font-size: 14px; line-height: 1.5; margin-bottom: 16px;">Dưới đây là chi tiết phần của bạn:</p>' +
    '          <table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: #fff7ed; border-left: 4px solid #ea580c; border-radius: 0 8px 8px 0; padding: 14px 16px; margin: 16px 0;">' +
    '            <tr>' +
    '              <td colspan="2" style="font-weight: bold; color: #9a3412; font-size: 15px; padding-bottom: 8px;">' + (m.dish_name || "Mục đã chọn") + '</td>' +
    '            </tr>' +
    '            <tr>' +
    '              <td style="font-size: 13px; color: #7c2d12; padding: 3px 0;">Giá gốc:</td>' +
    '              <td align="right" style="font-size: 13px; color: #7c2d12; padding: 3px 0; font-weight: 500;">' + formatVND(m.original_price) + '</td>' +
    '            </tr>' +
    (m.discount ? (
    '            <tr>' +
    '              <td style="font-size: 13px; color: #16a34a; padding: 3px 0;">Ưu đãi giảm:</td>' +
    '              <td align="right" style="font-size: 13px; color: #16a34a; padding: 3px 0; font-weight: 600;">-' + formatVND(m.discount) + '</td>' +
    '            </tr>'
    ) : '') +
    (m.shipping_fee ? (
    '            <tr>' +
    '              <td style="font-size: 13px; color: #0284c7; padding: 3px 0;">Phí chia sẻ:</td>' +
    '              <td align="right" style="font-size: 13px; color: #0284c7; padding: 3px 0; font-weight: 600;">+' + formatVND(m.shipping_fee) + '</td>' +
    '            </tr>'
    ) : '') +
    '            <tr>' +
    '              <td style="border-top: 1px dashed #fdba74; margin-top: 8px; padding-top: 10px; font-size: 14px; font-weight: bold; color: #c2410c;">TỔNG PHẦN BẠN:</td>' +
    '              <td align="right" style="border-top: 1px dashed #fdba74; margin-top: 8px; padding-top: 10px; font-size: 18px; font-weight: bold; color: #ea580c;">' + formatVND(m.final_amount) + '</td>' +
    '            </tr>' +
    '          </table>' +
    momoButtonHtml +
    qrImgTag +
    paymentInfoHtml +
    '          <p style="text-align: center; color: #94a3b8; font-size: 12px; margin-top: 24px; margin-bottom: 0;">Chúc bạn một ngày làm việc hiệu quả!</p>' +
    '        </td>' +
    '      </tr>' +
    '    </table>' +
    '  </td></tr>' +
    '</table>' +
    '</body></html>';
}

function buildAdminEmailHtml(data, storeName, dateStr) {
  var members = data.members || [];
  var rowsHtml = "";
  var totalAmount = 0;

  for (var i = 0; i < members.length; i++) {
    var m = members[i];
    totalAmount += (m.final_amount || 0);
    rowsHtml += '<tr style="border-bottom: 1px solid #e2e8f0;">' +
      '<td style="padding: 10px; font-weight: 600; color: #0f172a;">' + (m.name || "") + '</td>' +
      '<td style="padding: 10px; color: #475569;">' + (m.dish_name || "") + '</td>' +
      '<td style="padding: 10px; text-align: right; font-weight: bold; color: #ea580c;">' + formatVND(m.final_amount) + '</td>' +
      '</tr>';
  }

  return '<!DOCTYPE html>' +
    '<html><head><meta charset="utf-8"></head>' +
    '<body style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif; background-color: #f1f5f9; padding: 20px; margin: 0; color: #334155;">' +
    '<table width="100%" border="0" cellpadding="0" cellspacing="0">' +
    '  <tr><td align="center">' +
    '    <table width="100%" border="0" cellpadding="0" cellspacing="0" style="max-width: 600px; background: #ffffff; border-radius: 16px; padding: 24px; box-shadow: 0 4px 20px rgba(0,0,0,0.06); text-align: left;">' +
    '      <tr><td>' +
    '        <div style="border-bottom: 2px solid #f1f5f9; padding-bottom: 16px; margin-bottom: 16px;">' +
    '          <span style="background-color: #ea580c; color: #ffffff; font-size: 11px; font-weight: bold; padding: 3px 8px; border-radius: 4px; text-transform: uppercase;">BẢNG KÊ TỔNG HỢP</span>' +
    '          <h2 style="color: #0f172a; margin: 8px 0 4px 0; font-size: 20px;">Bảng Tổng Hợp</h2>' +
    '          <p style="color: #64748b; font-size: 13px; margin: 0;">Địa điểm: <b>' + storeName + '</b> | Ngày: <b>' + dateStr + '</b></p>' +
    '        </div>' +
    '        <table width="100%" border="0" cellpadding="0" cellspacing="0" style="border-collapse: collapse; font-size: 14px;">' +
    '          <thead>' +
    '            <tr style="background-color: #f8fafc; border-bottom: 2px solid #cbd5e1; text-align: left;">' +
    '              <th style="padding: 10px; color: #475569;">Thành viên</th>' +
    '              <th style="padding: 10px; color: #475569;">Mục</th>' +
    '              <th style="padding: 10px; text-align: right; color: #475569;">Phần</th>' +
    '            </tr>' +
    '          </thead>' +
    '          <tbody>' + rowsHtml + '</tbody>' +
    '          <tfoot>' +
    '            <tr style="background-color: #fff7ed; font-weight: bold;">' +
    '              <td colspan="2" style="padding: 14px 10px; color: #9a3412;">TỔNG CỘNG:</td>' +
    '              <td style="padding: 14px 10px; text-align: right; color: #ea580c; font-size: 17px;">' + formatVND(totalAmount) + '</td>' +
    '            </tr>' +
    '          </tfoot>' +
    '        </table>' +
    '      </td></tr>' +
    '    </table>' +
    '  </td></tr>' +
    '</table>' +
    '</body></html>';
}
