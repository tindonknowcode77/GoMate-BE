# GoMate Postman

Import lại `GoMate-Auth.postman_collection.json` trong Postman. Collection mới có
tên **GoMate - Auth & Profile**, gồm 13 request. Đây là file trong repository,
chưa được đồng bộ trực tiếp lên Postman cloud/workspace.

## Dùng thử

1. Đặt `baseUrl` là địa chỉ BE **không có `/api`**, ví dụ `http://127.0.0.1:3000`.
2. Tài khoản mới: Register → lấy mã email điền `verificationCode` → Verify Email.
   Đã có tài khoản xác minh thì bắt đầu từ Login.
3. Đặt `rememberMe` thành `true` hoặc `false`, rồi Login. Collection tự lưu
   `accessToken`, `userId`, `expiresAt`, `expiresIn`.
4. Gọi Me để kiểm tra/khôi phục phiên. GET không gia hạn phiên. Nếu nhận 401,
   collection xóa token đã lưu; test HTTP 200 sẽ báo thất bại đúng với phiên hết hạn.
5. Get Profile → sửa `profileName`, `username`, `bio`, `location` → Update Profile.
   Sửa danh sách `interests` trực tiếp trong body. Username rỗng sẽ xóa username;
   bỏ trường khỏi body nếu muốn giữ nguyên giá trị cũ.
6. Upload Avatar → Body → form-data → `avatar` loại **File** → **Select Files**
   → chọn ảnh trên máy → Send → View Avatar. Collection tự lưu `avatarUrl`;
   Get Profile cũng có thể lấy đường dẫn ảnh đã lưu trước đó.
7. Logout sau khi thử xong. Google Login và Resend là các luồng tùy chọn.

Trước Logout, có thể dùng **Search Activities / Match**. Bật các query cần dùng
trong Params; lat/lng/distanceKm đi cùng nhau. API có phân trang và trả danh sách
rỗng nếu MongoDB chưa có hoạt động phù hợp. Xem `../docs/activities.md`.

Không chạy toàn bộ collection liên tục: cần nhập mã email, cung cấp ảnh và
xem lại nội dung hồ sơ trước các request cập nhật. Dùng **Send** từng request.
Tránh khai báo trùng các biến token/profile trong Environment vì chúng có thể
ghi đè biến collection mà các script tự lưu.

## Chọn ảnh trên máy và lưu Cloudinary

Ảnh JPEG/PNG/WebP tĩnh, tối đa 2 MiB và 20 megapixels. Request Upload Avatar đã
cấu hình form-data với field `avatar`; chọn File từ máy, không cần đổi base64.
Xóa header Content-Type tự đặt nếu có, để Postman tạo multipart boundary.

Điền `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` trong
BE `.env` rồi restart BE. Không nhập các khóa Cloudinary vào collection.
BE trả URL HTTPS Cloudinary và lưu vào hồ sơ. JSON base64 vẫn được hỗ trợ cho FE.

Collection không chứa token hoặc thông tin từ `.env`. Khi xuất/chia sẻ bản đã
dùng, xóa password thật, accessToken, googleIdToken, verificationCode và ảnh.
