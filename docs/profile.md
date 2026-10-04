# Hồ sơ và ảnh đại diện

Hồ sơ cơ bản đã có từ đăng ký. FE dùng GET để tải và PATCH để hoàn thiện hoặc
chỉnh sửa; không tạo bản ghi người dùng thứ hai. Tất cả thao tác `/me` yêu cầu
`Authorization: Bearer <accessToken>`, chỉ cập nhật tài khoản của token.

| Method | Đường dẫn | Body / kết quả |
| --- | --- | --- |
| GET | `/api/profile/me` | `{ profile }` |
| PATCH | `/api/profile/me` | Một hoặc nhiều trường `name`, `username`, `bio`, `location`, `interests`; trả `{ profile }` |
| PUT | `/api/profile/me/avatar` | `multipart/form-data`, file field `avatar`; hoặc JSON `{ "base64": "..." }`; trả `{ profile }` |
| GET | `/api/profile/:id/avatar` | Redirect tới ảnh Cloudinary; ảnh MongoDB cũ vẫn được phục vụ; 404 nếu chưa có ảnh |

Profile trả `id`, `email`, `name`, `username`, `bio`, `location`, `interests`,
`avatarUrl` (URL HTTPS Cloudinary; ảnh cũ có thể là đường dẫn tương đối; hoặc null).
Không trả mật khẩu/token/hash.

- Tên: 2–100 ký tự; bio: tối đa 500; khu vực: tối đa 100.
- Username tùy chọn, duy nhất, chuẩn hóa chữ thường và bỏ `@` đầu chuỗi;
  3–30 ký tự `[a-z0-9_]`. Chuỗi rỗng xóa username. Trùng trả 409.
- Sở thích: tối đa 12 chuỗi, mỗi chuỗi 1–40 ký tự, tự loại trùng.
- Chỉ cập nhật trường được truyền; từ chối trường lạ, email, id và quyền.
- Ảnh: JPEG/PNG/WebP tĩnh, tối đa 2 MiB và 20 megapixels. JSON upload giới hạn
  3 MiB; giới hạn JSON của API thông thường vẫn 16 KiB. Upload yêu cầu xác thực
  trước khi đọc body và giới hạn 20 lần/IP/15 phút.
- Sharp giải mã, xoay theo EXIF, thu nhỏ tối đa 512×512 và xuất WebP, không giữ
  metadata gốc. SVG, ảnh động, dữ liệu hỏng hoặc quá giới hạn bị từ chối.
- BE upload WebP lên Cloudinary bằng server SDK, lưu URL và public ID trong
  MongoDB. Chỉ xóa ảnh Cloudinary cũ sau khi lưu URL mới thành công; nếu lưu DB
  thất bại, thử xóa ảnh vừa upload. Cleanup lỗi chỉ cảnh báo, chưa có retry queue.
- Ảnh MongoDB cũ vẫn đọc được; lần upload tiếp theo thay bằng Cloudinary và
  bỏ binary cũ. Không tự di chuyển toàn bộ ảnh cũ. Avatar là ảnh công khai.

## Cấu hình Cloudinary

Điền trong **GoMate-BE/.env** rồi khởi động lại BE:

```dotenv
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
```

Lấy các giá trị ở Cloudinary Console / API Keys. Không đưa API secret vào FE
hoặc Postman. Không cần unsigned upload preset. Thiếu cấu hình trả 503; upload
Cloudinary thất bại trả 502, hồ sơ giữ URL ảnh trước đó.

Postman: Login → Upload Avatar → Body → form-data → key `avatar`, loại **File**
→ Select Files → chọn ảnh trên máy → Send. Không tự đặt Content-Type vì Postman
sẽ thêm multipart boundary. Response `profile.avatarUrl` là link ảnh Cloudinary.
FE vẫn chọn ảnh từ thư viện/máy bằng ImagePicker và gửi base64 tới BE như trước.

Khởi động lại BE để nạp router và tạo unique index username. `sharp` đã thêm
trong package/lockfile; môi trường deploy cần chạy `npm ci` như bình thường.
Dependencies gồm `sharp`, `cloudinary`, `multer`. Chưa có API xóa ảnh hoặc xem
hồ sơ công khai của người khác.

FE đã nối màn tạo/sửa, chọn ảnh và màn hồ sơ của mình. Lưu thông tin và upload
ảnh là hai request: nếu upload thất bại sau PATCH, FE báo thông tin đã lưu và
cho thử lại ảnh. Các số liệu đánh giá/hoạt động mẫu được bỏ khỏi hồ sơ của mình.

Tham khảo: [Sharp input validation](https://sharp.pixelplumbing.com/api-constructor/),
[Expo SDK 57 ImagePicker](https://docs.expo.dev/versions/v57.0.0/sdk/imagepicker/).
Upload cloud dùng [Cloudinary Node SDK](https://cloudinary.com/documentation/node_image_and_video_upload).
