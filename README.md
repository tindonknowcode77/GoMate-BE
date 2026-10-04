# GoMate Backend

Node.js 22.12+ / 24+, Express 5 và MongoDB (driver chính thức).

## Chạy FE và API cùng server

Tại C:\GoMate chạy npm.cmd start, mở http://127.0.0.1:3000.
Lệnh này build GoMate-FE/dist rồi chạy backend. API ở /api.
Sau khi sửa FE, chạy npm.cmd run build và tải lại trình duyệt.

## Kết nối MongoDB

Đặt MONGODB_URI trong GoMate-BE/.env. Chọn một kết nối cho mỗi lần chạy:

Local:

    MONGODB_URI=mongodb://127.0.0.1:27017/gomate

Atlas (thay giá trị mẫu bằng chuỗi kết nối của bạn):

    MONGODB_URI=mongodb+srv://USER:PASSWORD@CLUSTER/gomate?retryWrites=true&w=majority

Atlas cần database user có quyền đọc/ghi và IP server được cho phép trong Network Access.
Mã hóa ký tự đặc biệt trong username/password theo URL. Không commit .env.
Local và Atlas là hai database độc lập; đổi URI không tự đồng bộ dữ liệu.
Khởi động lại backend sau khi đổi URI.

Server tự tạo index users/auth_sessions trước khi nhận request. Không cần migration SQL.
npm run db:migrate vẫn dùng được để khởi tạo index thủ công.
Collection dùng UUID trong trường id, password_hash và token_hash;
không tự chuyển đổi collection có schema khác đã tồn tại.

## Lệnh tại GoMate-BE

- npm ci: cài dependencies.
- npm start: chạy server; build FE trước nếu muốn mở giao diện.
- npm run dev: chạy server với Node watch.
- npm test: kiểm thử với MongoDB tạm, độc lập với database ứng dụng.
- npm run db:migrate: tạo index MongoDB, có thể chạy lại.

Test dùng mongodb-memory-server; lần đầu cần tải binary MongoDB.
Có thể dùng binary đã cài để tránh tải thêm khi kiểm thử:

```powershell
$env:MONGOMS_SYSTEM_BINARY='C:\Program Files\MongoDB\Server\8.3\bin\mongod.exe'
$env:MONGOMS_VERSION='8.3.1'
npm.cmd test
```

Điều chỉnh đường dẫn và phiên bản theo máy. Test tạo instance riêng với dữ liệu tạm.

## Cấu hình và deploy

PORT mặc định 3000. HOST mặc định 127.0.0.1 ở local, 0.0.0.0 ở production.
SESSION_TTL_HOURS mặc định 24. TRUST_PROXY_HOPS mặc định 0, đặt 1 với Render proxy.
REMEMBER_SESSION_TTL_HOURS mặc định 720 (30 ngày), áp dụng khi login/Google gửi
`rememberMe: true`. Xem [khôi phục phiên và xử lý hết hạn](docs/persistent-login.md).
CORS_ORIGIN dành cho FE khác origin; FE cùng server gọi /api.
Xem .env.example và [API xác thực](docs/auth.md).
Đăng ký cần SMTP để gửi mã: xem [xác minh email](docs/email-verification.md).
Đăng nhập Google: xem [cấu hình và thử API Google](docs/google-login.md).

Blueprint render.yaml dành cho backend riêng. Đặt MONGODB_URI thành URI Atlas.
Nếu cần FE cùng server, deploy cả hai thư mục cạnh nhau; build từ thư mục cha bằng
npm run setup && npm run build; start bằng npm --prefix GoMate-BE start.
Health check: /api/health. URI phải có tên database; cho phép kết nối từ server trong Atlas.
