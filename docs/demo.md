# Demo TP.HCM

Chạy tại GoMate-BE: `npm.cmd run db:seed-demo`. Script dùng MONGODB_URI hiện tại,
tạo 20 hoạt động và 14 tài khoản demo. Bản mới dùng `$setOnInsert`; bản demo cũ
chỉ được bổ sung ảnh/thông tin còn thiếu và roster một lần. Không ghi đè lịch,
mật khẩu hay thao tác duyệt/rời nhóm ở các lần chạy sau.

| Tài khoản | Vai trò | Mật khẩu mặc định |
| --- | --- | --- |
| demo@gomate.local | Người tham gia | gomate123 |
| host1@gomate.local | Minh Anh | gomate123 |
| host2@gomate.local | Tuấn Kiệt | gomate123 |
| host3@gomate.local | Linh Nguyễn | gomate123 |
| member1@gomate.local … member10@gomate.local | 10 thành viên mới, hồ sơ đầy đủ | gomate123 |

Đặt DEMO_PASSWORD trước lần seed đầu nếu cần mật khẩu khác. Tài khoản đã xác minh
email, chỉ dùng để demo. Không thay đổi tài khoản có sẵn trùng email nhưng khác ID.
Hoạt động tính ngày theo Việt Nam, bắt đầu từ ngày kế tiếp và trải trong 10 ngày.
Có lịch 2 giờ, min/max thành viên, điểm tập trung, tọa độ minh họa, kế hoạch và quỹ.
Một số nhóm yêu cầu giới tính/ngôn ngữ/khả năng uống rượu/dress code để demo bộ lọc.
Sự kiện và tọa độ là minh họa; chưa phải sự kiện thật được xác nhận.

Seed giữ nguyên ngày đã lưu ở các lần chạy sau, không tự đẩy lịch hoạt động đã có.

Mỗi nhóm có 3–5 người tính cả host và một yêu cầu chờ duyệt. Thành viên được lưu
thành join request `approved`, phù hợp điều kiện nhóm; `memberCount` luôn bằng
host + các request đã duyệt. Cờ `demoRosterVersion` ngăn seed lại người đã rời/bị loại.

Ảnh hoạt động và ảnh bìa hồ sơ lấy trực tiếp từ Unsplash; avatar từ Random User.
Không lưu ảnh vào local assets. URL được kiểm tra HTTP 200 và Content-Type image;
CSP chỉ cho phép các domain ảnh đã chọn. Các nhân vật là hư cấu, ảnh là minh họa.

Nguồn ảnh cụ thể:

- [Cầu lông — Urja Bhatt](https://unsplash.com/photos/badminton-rackets-and-shuttlecock-on-red-court-with-sunlight-WI1rcfuoSTU).
- [Picnic — Bonnie Kittle](https://unsplash.com/photos/picnic-basket-on-table-xBFEhnAMlFI).
- [Pickleball — eedgar ivann](https://unsplash.com/photos/pickleball-paddle-and-ball-rest-on-the-court-zpy9Lh5aRgg).
- [Sông Sài Gòn/cầu Thủ Thiêm — Kate Le](https://unsplash.com/photos/city-skyline-view-with-river-and-bridge-TJvH2nqycvE).
- [TP.HCM — jet dela cruz](https://unsplash.com/photos/city-skyline-during-day-time-In5ENUxUrO8).
- [Kho ảnh hồ sơ Random User](https://randomuser.me/photos).

Danh sách tất cả URL nằm trong `src/database/demo-media.js`.
