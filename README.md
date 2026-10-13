# GoMate Backend

Node.js 22.12+ / 24+, Express 5 và MongoDB (driver chính thức).

Demo 20 hoạt động TP.HCM: `npm.cmd run db:seed-demo`; tài khoản và hướng dẫn ở
[docs/demo.md](docs/demo.md). Xác minh email tự cấp phiên; mật khẩu tối thiểu 6 ký tự.

Create/PATCH hỗ trợ `minParticipants`, `maxParticipants`, `participantPreferences`
(`genders`, `languages`, `religions`, `alcohol`, `dressCode`). Số lượng 2–1000,
tối thiểu không lớn hơn tối đa. Xin tham gia kiểm tra điều kiện với hồ sơ hiện tại.
Discovery hỗ trợ `dateFrom`/`dateTo` (`YYYY-MM-DD`, theo giờ Việt Nam),
`fromTime`/`toTime` (`HH:mm`, khoảng giờ bắt đầu bao gồm hai đầu), `minParticipants`,
`maxParticipants`, `gender`, `language`, `religion`, `alcohol`, `dressCode=yes|no`.
Các nhóm không giới hạn vẫn khớp bộ lọc tùy chọn cá nhân. Khung giờ qua nửa đêm
cần hai khoảng tìm kiếm; khoảng trong một yêu cầu phải từ sớm đến muộn.

Chat riêng/nhóm, tin nhắn và SSE: xem [docs/chat.md](docs/chat.md).
Khôi phục/đổi mật khẩu: xem [docs/password-recovery.md](docs/password-recovery.md).

## Chạy FE và API cùng server

Tại GoMate-FE, build Expo web với API cùng origin:

```powershell
$env:EXPO_PUBLIC_API_BASE_URL='/api'
npx.cmd expo export --platform web --output-dir dist
```

Sau đó tại GoMate-BE chạy `npm.cmd start`, mở http://127.0.0.1:3000.
BE phục vụ GoMate-FE/dist và API ở /api. Build lại FE sau khi sửa giao diện.

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
CORS_ORIGIN nhận danh sách origin cách nhau bằng dấu phẩy. Mặc định hỗ trợ
Expo `http://localhost:8081`, `http://127.0.0.1:8081` và origin cũ `http://localhost:5173`.
FE cùng server gọi /api. Với thiết bị thật, đặt HOST=0.0.0.0 và FE dùng IP LAN máy tính.
Xem .env.example và [API xác thực](docs/auth.md).
Đăng ký cần SMTP để gửi mã: xem [xác minh email](docs/email-verification.md).
Đăng nhập Google: xem [cấu hình và thử API Google](docs/google-login.md).

FE đã nối các API yêu cầu tham gia, duyệt/từ chối và quản lý thành viên.
`GET /api/activities/mine` chỉ liệt kê hoạt động host tổ chức;
`GET /api/me/activities` liệt kê hoạt động đã được duyệt;
`GET /api/me/join-requests?status=pending` liệt kê yêu cầu đang chờ.
Create/PATCH activity nhận thêm `meetingPoint`, `registrationDeadline` (ISO UTC)
và `financialConfig`. Cấu hình quỹ gồm chế độ đóng đủ/đặt cọc, các số tiền nguyên
không âm, hạn đóng tiền ISO UTC, quy tắc xác nhận và `treasurerUserId` bắt buộc là host.
Hạn đăng ký được kiểm tra nguyên tử khi gửi yêu cầu; cấu hình quỹ chỉ lưu dữ liệu,
chưa có giao dịch thanh toán. Kiểm thử liên kết FE–BE: tại GoMate-FE chạy
`npm.cmd run test:integration` sau khi cài dependencies cả hai dự án.

Blueprint render.yaml dành cho backend riêng. Đặt MONGODB_URI thành URI Atlas.
Nếu cần FE cùng server, deploy cả hai thư mục cạnh nhau; build từ thư mục cha bằng
npm run setup && npm run build; start bằng npm --prefix GoMate-BE start.
Health check: /api/health. URI phải có tên database; cho phép kết nối từ server trong Atlas.
