# Quên, đặt lại và đổi mật khẩu

## Endpoint

| Method | Path | Body |
| --- | --- | --- |
| POST | `/api/auth/forgot-password` | `{ "email": "user@example.com" }` |
| POST | `/api/auth/reset-password` | `{ "email": "user@example.com", "code": "123456", "newPassword": "NewPassword123!" }` |
| POST | `/api/auth/change-password` | `{ "currentPassword": "OldPassword123!", "newPassword": "NewPassword123!" }` |

Change yêu cầu `Authorization: Bearer <accessToken>`. Forgot/reset không cần token.
Email trim/lowercase; code phải là chuỗi 6 chữ số; mật khẩu mới 6–128 ký tự,
không trim. Change không cho mật khẩu mới giống currentPassword. Không nhận field
ngoài các field trong bảng. Thành công trả 200 `{ message }`.

## Quy tắc

- Chỉ tài khoản có mật khẩu và đã xác minh email mới nhận mã reset. Tài khoản chỉ
  đăng nhập Google tiếp tục dùng Google, không dùng chức năng này để thêm mật khẩu.
- Dùng SMTP hiện có, không cần biến môi trường mới. Mã reset có email riêng,
  độc lập mã xác minh email; được hash có salt trước khi lưu, không trả qua API.
- Mã hết hạn sau 10 phút, tối đa 5 lần thử, dùng một lần. Chờ 60 giây giữa các lần
  gửi; mã mới thay mã cũ. Gửi lỗi SMTP sẽ hủy mã vừa tạo để có thể yêu cầu lại.
- Forgot trả cùng thông báo cho tài khoản hợp lệ, không tồn tại, chưa xác minh,
  Google-only, còn cooldown và lỗi gửi SMTP. HTTP 200 không bảo đảm thư đã gửi.
  Nếu SMTP chưa cấu hình thì 503 áp dụng cho mọi email. Đây không phải bảo đảm
  thời gian phản hồi bằng nhau vì thời gian gửi SMTP có thể khác nhau.
- Reset/change cập nhật mật khẩu và tăng credential_version nguyên tử. Mọi phiên
  cũ, kể cả rememberMe và phiên đang gọi Change, mất hiệu lực; phải login lại.
  Session được tạo trễ từ thông tin xác thực cũ cũng không dùng được. Các record
  session cũ được MongoDB TTL dọn theo hạn, không cần xóa ngay để thu hồi quyền.
- Phiên/user cũ chưa có credential_version được coi là 0; không cần migration.
  SSE chat kiểm tra lại phiên ở tick kế tiếp và ngắt khi token mất hiệu lực.
- Change cũng hủy mã reset đang chờ. Reset đồng thời hoặc change đồng thời chỉ
  một cập nhật trên cùng thông tin xác thực cũ có thể thành công.
- Giới hạn theo IP/15 phút: Forgot 5, Reset 20, Change 10. Thêm giới hạn 5 lần thử
  trên mỗi mã reset ở database. Không tự đăng nhập sau reset/change.

Lỗi: 400 body/mật khẩu/mã sai hoặc hết hạn, currentPassword sai, thông tin xác thực
đã đổi; 401 token không hợp lệ; 429 quá giới hạn; 503 SMTP chưa cấu hình.

## Test Postman

Import lại collection → **02 - Authentication → Password Recovery & Change**.

1. Điền `email`, chạy Forgot; lấy mã từ email điền `resetCode`.
2. Điền `newPassword`, chạy Reset. Script xóa các token đã lưu để tránh dùng nhầm.
3. Cập nhật biến `password` bằng mật khẩu mới rồi Login.
4. Muốn đổi khi đang đăng nhập: điền `currentPassword`, `newPassword`, chạy Change.
   Cập nhật `password` và Login lại. Nếu tài khoản là host/member trong bộ test,
   cập nhật `hostPassword`/`memberPassword` tương ứng và đăng nhập lại.

Không chạy cả folder bằng Runner; cần nhập mã email và chọn đúng nhánh.
Không chia sẻ collection còn chứa mật khẩu, resetCode hoặc token thật.
Test tự động dùng MongoDB tạm và mailer giả lập; không gửi email thật.
