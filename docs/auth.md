# Đăng ký và xác thực GoMate

Base URL local: `http://127.0.0.1:3000/api`.

Giữ đăng nhập: login/Google nhận `rememberMe: true` để cấp phiên mặc định 30 ngày.
Login và `/auth/me` trả thêm `expiresAt`; `/auth/me` trả số giây còn lại `expiresIn`.
Xem [hợp đồng khôi phục phiên và xử lý hết hạn](persistent-login.md).
Production dùng `https://<service>.onrender.com/api`.
Mọi body gửi lên có `Content-Type: application/json`.

## API

Google login: `POST /api/auth/google` với `{ "idToken": "..." }`.
Xem [cấu hình Google và Postman](google-login.md).

| Method | Path | Body / xác thực | Kết quả |
| --- | --- | --- | --- |
| POST | `/auth/register` | `{ "name": "Nguyen An", "email": "an@example.com", "password": "a long sample password" }` | 201 `{ "user": { "id", "name", "email", "createdAt" } }` |
| POST | `/auth/login` | `{ "email": "an@example.com", "password": "a long sample password", "rememberMe": false }` | 200 `{ "accessToken", "tokenType": "Bearer", "expiresIn": 86400, "expiresAt", "user" }` |
| GET | `/auth/me` | Header `Authorization: Bearer <accessToken>` | 200 `{ "user", "expiresAt", "expiresIn" }` |
| POST | `/auth/logout` | Header `Authorization: Bearer <accessToken>` | 204, không có body |

Các ví dụ response trong bảng mô tả trường dữ liệu, không phải JSON mẫu hoàn chỉnh.
Đăng ký tạo tài khoản và gửi mã email; gọi `/auth/verify-email` với `email`, `code`
trước khi login lấy token. Xem [xác minh email và SMTP](email-verification.md).
Email được trim và chuyển
thành chữ thường, không được trùng. Tên dài 2–100 ký tự, mật khẩu 12–128 ký tự.
Mật khẩu không bị trim hoặc thay đổi. Các trường khác như `role` không được sử dụng.

Lỗi trả JSON `{ "error": "..." }`:

- 400: dữ liệu không hợp lệ hoặc JSON bị lỗi.
- 401: sai email/mật khẩu, thiếu token, token không hợp lệ hoặc đã hết hạn.
- 409: email đã được đăng ký.
- 413: request body vượt 16 KB.
- 429: quá giới hạn thử; xem header `Retry-After`.
- 500: lỗi nội bộ, không trả chi tiết database cho client.

## Ví dụ gọi từ JavaScript

```js
const baseUrl = 'https://<service>.onrender.com/api'
const loginResponse = await fetch(`${baseUrl}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'an@example.com', password: 'a long sample password' }),
})
const login = await loginResponse.json()
if (!loginResponse.ok) throw new Error(login.error)

const meResponse = await fetch(`${baseUrl}/auth/me`, {
  headers: { Authorization: `Bearer ${login.accessToken}` },
})
const me = await meResponse.json()
if (!meResponse.ok) throw new Error(me.error)
console.log(me.user)

await fetch(`${baseUrl}/auth/logout`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${login.accessToken}` },
})
```

## Token và bảo vệ route

Token là chuỗi ngẫu nhiên 256-bit, không phải JWT. Chỉ SHA-256 của token được lưu
trong `auth_sessions`; mật khẩu lưu dưới dạng scrypt có salt riêng cho từng tài khoản.
Mỗi lần login tạo một phiên riêng, mặc định sống 24 giờ (`SESSION_TTL_HOURS`, 1–720 giờ).
Với `rememberMe: true`, thời hạn mặc định 30 ngày (`REMEMBER_SESSION_TTL_HOURS`).
Logout thu hồi phiên hiện tại ngay lập tức. Phiên khác của cùng tài khoản vẫn hoạt động.
Khi nhận 401 do phiên hết hạn, client yêu cầu đăng nhập lại; chưa có refresh token.
Tài khoản và phiên được lưu trong MongoDB nên không mất khi backend restart/redeploy.
Phiên hết hạn được dọn bằng TTL index; API luôn kiểm tra thời hạn khi xác thực.

Web có thể giữ token trong bộ nhớ ứng dụng; app native lưu trong kho bảo mật của hệ điều hành.
Không đưa token vào URL hoặc log. Trên production gọi API qua HTTPS.
Mobile native không cần cookie và không phụ thuộc browser CORS.
Web phải có origin khớp với `CORS_ORIGIN`; cấu hình hiện hỗ trợ một origin.

Để bảo vệ API mới, dùng middleware có sẵn:

```js
import { authenticate } from './middlewares/authenticate.js'

app.get('/api/private', authenticate(authRepository), (req, res) => {
  res.json({ user: req.auth.user })
})
```

Đăng ký giới hạn 5 request/IP/15 phút; đăng nhập 20 request/IP/15 phút.
Limiter hiện lưu trong bộ nhớ từng process, phù hợp cấu hình một instance hiện tại.
Khi chạy nhiều instance, cần shared rate-limit store. `TRUST_PROXY_HOPS=1` dành cho
Render proxy; local dùng `0`. Cần kiểm tra lại số proxy nếu thêm CDN hoặc proxy khác.

Phạm vi hiện tại: xác thực email/mật khẩu, mã xác minh email, Google login và phiên đăng nhập.
Chưa có quên mật khẩu hoặc phân quyền admin. Tài khoản mật khẩu phải xác minh email
trước khi đăng nhập; Google login dùng email đã được Google xác minh.

## Kiểm thử

`npm test` chạy HTTP integration test với MongoDB tạm qua mongodb-memory-server,
dùng repository và index thật. Lần đầu cần tải binary MongoDB. Test không dùng database
ứng dụng. Kết nối Atlas cần được kiểm tra riêng khi deploy.

Tham khảo triển khai: [Node.js crypto](https://nodejs.org/api/crypto.html),
[MongoDB Node.js driver](https://www.mongodb.com/docs/drivers/node/current/).
