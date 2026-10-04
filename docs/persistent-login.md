# Giữ đăng nhập khi mở lại app

BE lưu phiên trong MongoDB. Đóng app hoặc khởi động lại BE không xóa phiên.
FE phải lưu token an toàn và kiểm tra lại phiên khi mở app; chỉ sửa BE không
thể giữ token qua lần khởi động lại FE.

## Đăng nhập và thời hạn

`POST /api/auth/login`:

```json
{
  "email": "ban@example.com",
  "password": "your-long-password",
  "rememberMe": true
}
```

`POST /api/auth/google` cũng nhận `rememberMe` bên cạnh `idToken`.
`rememberMe` chỉ nhận boolean, không nhận chuỗi `"true"`.

- Không truyền hoặc `false`: `SESSION_TTL_HOURS`, mặc định 24 giờ.
- `true`: `REMEMBER_SESSION_TTL_HOURS`, mặc định 720 giờ (30 ngày).
- Cả hai trả `accessToken`, `tokenType`, `user`, `expiresIn` (giây) và
  `expiresAt` (thời điểm ISO UTC). Không trả hash token hoặc mật khẩu.
- Thời hạn cố định từ lúc đăng nhập, không tự kéo dài khi gọi API.
- Chưa có refresh token. Hết hạn cần đăng nhập lại.

Cấu hình tùy chọn trong môi trường BE (không cần thay đổi để dùng mặc định):

```dotenv
SESSION_TTL_HOURS=24
REMEMBER_SESSION_TTL_HOURS=720
```

Thời hạn ghi nhớ phải là số nguyên, từ `SESSION_TTL_HOURS` đến 720 giờ.
Đổi cấu hình chỉ ảnh hưởng phiên cấp mới. Không cần migration database.

## Khôi phục phiên trên FE

1. Sau khi login thành công, lưu `accessToken` vào kho bảo mật của hệ điều hành
   trên app native; không lưu mật khẩu. Web cần thiết kế lưu phiên riêng,
   không giả định kho bảo mật native hoạt động trên trình duyệt.
2. Khi mở app, đọc token rồi gọi `GET /api/auth/me` với
   `Authorization: Bearer <accessToken>`. Chờ kết quả trước khi mở màn chính.
3. HTTP 200 trả `{ user, expiresAt, expiresIn }`: khôi phục người dùng hiện tại.
   `expiresIn` là số giây còn lại, không phải thời hạn ban đầu.
4. HTTP 401 trả `{ error, code }`: xóa token cục bộ và mở màn đăng nhập.
   `AUTH_REQUIRED` nghĩa là thiếu/sai định dạng Bearer;
   `SESSION_INVALID_OR_EXPIRED` nghĩa là token không hợp lệ, hết hạn, đã thu hồi
   hoặc không còn người dùng đủ điều kiện. Mã chung vẫn đúng khi MongoDB đã
   dọn phiên hết hạn, không phụ thuộc thời điểm TTL cleanup.
5. Mất mạng hoặc HTTP 5xx: giữ token và cho thử lại; không coi là hết phiên.
6. Đăng xuất: gọi `POST /api/auth/logout` với Bearer; HTTP 204 xác nhận đã thu hồi
   phiên hiện tại, sau đó xóa token cục bộ. HTTP 401 cũng cho phép xóa token.
   Các thiết bị khác vẫn đăng nhập bằng phiên riêng.

BE chỉ lưu SHA-256 của token; thời hạn được kiểm tra mỗi request trước khi
cho truy cập. Các response auth có `Cache-Control: no-store`.

FE hiện tại chưa truyền `rememberMe` hoặc lưu/khôi phục token. Cần triển khai
các bước trên trong FE để người dùng sử dụng đầy đủ chức năng này.
