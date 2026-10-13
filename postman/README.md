# GoMate Postman

Import lại `GoMate-Auth.postman_collection.json` trong Postman. Collection mới có
tên **GoMate - Auth, Profile & Activities**, gồm 26 request. Đây là file trong repository,
chưa được đồng bộ trực tiếp lên Postman cloud/workspace.

## Cấu trúc collection

- **01 - System**: kiểm tra Health.
- **02 - Authentication**: đăng ký, xác minh/gửi lại mã, đăng nhập email/Google,
  xem phiên và đăng xuất.
- **03 - Profile**: xem/sửa hồ sơ, upload/xem avatar.
- **04 - Activities**: tìm kiếm, tạo, danh sách của tôi, chi tiết, sửa và xóa.
- **05 - Join Requests**:
  - **01 - Setup (two accounts)**: đăng nhập host, tạo hoạt động, đăng nhập member.
  - **02 - Member**: gửi và hủy yêu cầu.
  - **03 - Host**: xem danh sách, duyệt hoặc từ chối.

Import lại file để nhận cấu trúc mới. Tên request, biến, body và script được giữ
nguyên; chỉ thay đổi cách nhóm thư mục. Vẫn dùng Send từng request theo luồng dưới đây.

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

CRUD: **Activities - Create → Mine → Detail → Update**. Create lưu `activityId`;
hai biến `activityStartsAt`/`activityEndsAt` rỗng sẽ tự đặt thành ngày mai và 2 giờ
sau lúc bắt đầu. Sửa các biến nếu cần thời gian khác; ngày phải ở tương lai.
**Activities - Delete (manual)** xóa hoạt động trong `activityId`, chỉ bấm Send
khi muốn xóa. Hoạt động của mình không xuất hiện trong Match của chính mình;
dùng Mine để xem, hoặc đăng nhập tài khoản khác để thử Match.

Không chạy toàn bộ collection liên tục: cần nhập mã email, cung cấp ảnh và
xem lại nội dung hồ sơ trước các request cập nhật. Dùng **Send** từng request.
Tránh khai báo trùng các biến token/profile trong Environment vì chúng có thể
ghi đè biến collection mà các script tự lưu.

## Test yêu cầu tham gia

Mở folder **05 - Join Requests**, dùng Send từng request trong các mục Setup,
Member và Host:

1. Chuẩn bị hai tài khoản đã xác minh email khác nhau. Điền collection variables
   `hostEmail`, `hostPassword`, `memberEmail`, `memberPassword` và `baseUrl`.
2. **Login Host → Create Activity (Host)**: tự lưu `hostAccessToken`, `activityId`.
   Nếu ngày cũ đã hết hạn, xóa `activityStartsAt`/`activityEndsAt` để tự tạo ngày mai.
3. **Login Member → Submit (Member)**: tự lưu `memberAccessToken`, `joinRequestId`.
4. **List (Host)**: xem danh sách pending. Bỏ query `status` để xem mọi trạng thái.
5. Chọn một nhánh: **Cancel (Member)**, **Approve (Host)** hoặc **Reject (Host)**.
   Sau Cancel/Reject, bấm Submit lại để thử nhánh khác; ID mới được tự lưu.
   Sau Approve không thể hủy bằng API này; tạo hoạt động khác để thử lại từ đầu.

Hai token riêng không thay đổi `accessToken` chung. Không khai báo trùng các biến
này trong Environment. List không tự chọn yêu cầu: muốn xử lý người khác thì copy
ID từ danh sách vào `joinRequestId`. Không chạy toàn bộ folder bằng Runner vì các
nhánh Cancel/Approve/Reject loại trừ nhau. Các test hiện mong đợi thành công;
thử gửi trùng hoặc duyệt lại sẽ trả 409 và test HTTP báo đỏ như dự kiến.

Khi chia sẻ collection đã dùng, xóa cả `hostPassword`, `memberPassword`,
`hostAccessToken` và `memberAccessToken`.

## Upload ảnh

Ảnh JPEG/PNG/WebP tĩnh, tối đa 2 MiB và 20 megapixels. Request Upload Avatar đã
cấu hình form-data với field `avatar`; chọn File từ máy, không cần đổi base64.
Xóa header Content-Type tự đặt nếu có, để Postman tạo multipart boundary.

Điền `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` trong
BE `.env` rồi restart BE. Không nhập các khóa Cloudinary vào collection.
BE trả URL HTTPS Cloudinary và lưu vào hồ sơ. JSON base64 vẫn được hỗ trợ cho FE.

Collection không chứa token hoặc thông tin từ `.env`. Khi xuất/chia sẻ bản đã
dùng, xóa password thật, accessToken, googleIdToken, verificationCode và ảnh.
