# Xác minh email trước khi đăng nhập

1. `POST /api/auth/register` với `name`, `email`, `password`: tạo tài khoản chưa
   xác minh, gửi mã qua SMTP và trả 201 với `verificationRequired: true`.
2. `POST /api/auth/verify-email` với `{ "email": "ban@gmail.com", "code": "123456" }`.
3. Xác minh thành công trả `accessToken`, `tokenType`, `expiresIn`, `expiresAt`, `user`
   giống login. FE lưu phiên và vào app ngay, không yêu cầu nhập lại mật khẩu.
4. Nếu cần mã mới: `POST /api/auth/resend-verification` với `{ "email": "ban@gmail.com" }`.

Mã gồm 6 số, hết hạn sau 10 phút, tối đa 5 lần nhập mỗi mã; gửi lại sau 60 giây.
Mã mới thay thế mã cũ; mã chỉ dùng một lần. Database lưu hash có salt, không lưu mã rõ.
Không trả mã trong API hoặc log. Gửi lại trả thông báo chung để không tiết lộ tài khoản.

Login trả 403 nếu mật khẩu đúng nhưng email chưa xác minh. Các tài khoản mật khẩu
cũ cũng cần gọi gửi lại mã và xác minh; phiên cũ chưa xác minh không dùng được.
Google login vẫn dùng email đã được Google xác minh, không yêu cầu mã riêng.

## SMTP Gmail

Điền trong **GoMate-BE/.env**, không điền ở FE:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=dia-chi-gui@gmail.com
SMTP_PASS=APP_PASSWORD
MAIL_FROM=dia-chi-gui@gmail.com
```

Bật xác minh hai bước cho Gmail gửi, tạo App Password và dùng thay mật khẩu Gmail
thông thường. Client ID Google login không thay thế thông tin SMTP. Có thể đổi
host/port/user/password để dùng dịch vụ SMTP khác; cổng 587 dùng STARTTLS.
Khởi động lại BE sau khi chỉnh .env. Khi deploy, thêm các biến này vào môi trường server.

Chưa cấu hình SMTP: đăng ký/gửi lại trả 503. SMTP thất bại sau khi tạo tài khoản:
tài khoản vẫn chưa xác minh, dùng gửi lại mã khi SMTP hoạt động. Không đăng ký lại.
SMTP chấp nhận thư không bảo đảm thư vào inbox; kiểm tra cả Spam.

Postman: sửa email thành hộp thư bạn đọc được, Register → nhập mã nhận được vào
biến `verificationCode` → Verify Email → Login → Me → Logout. Không chạy toàn bộ
collection liên tục vì cần chờ nhận và nhập mã.

Tham khảo: [Nodemailer SMTP](https://nodemailer.com/smtp),
[Google App Passwords](https://support.google.com/mail/answer/185833).
