# Tìm hoạt động / Match

`GET /api/activities` yêu cầu Bearer token. API chỉ đọc MongoDB, không tạo mẫu
tự động. Chỉ trả hoạt động `published`, chưa bắt đầu, còn chỗ và không do người
đang tìm tổ chức. Restart BE để nạp route và các index mới.

| Query | Ý nghĩa |
| --- | --- |
| `q` | Tối đa 100 ký tự; tìm chuỗi trong title, description, location và tags, không phân biệt hoa thường. Regex được escape; chưa có tìm kiếm bỏ dấu/fuzzy. |
| `categories` | Các danh mục ngăn bởi dấu phẩy: Ăn uống, Thể thao, Du lịch, Giải trí, Học tập, Gaming, Khác |
| `minCost`, `maxCost` | VND/người, giới hạn bao gồm hai đầu; 0 là miễn phí |
| `days` | Thứ ISO, 1=Thứ Hai … 7=Chủ Nhật, ngăn bởi dấu phẩy |
| `fromHour`, `toHour` | Giờ bắt đầu theo UTC+7, từ 0 đến 24; đầu bao gồm, cuối không bao gồm. Mặc định cả ngày. Không kiểm tra toàn bộ thời lượng hoạt động. |
| `lat`, `lng` | Tọa độ người tìm, phải đi cùng nhau |
| `distanceKm` | Bán kính 0.1–500 km; yêu cầu lat/lng |
| `page`, `limit` | Mặc định 1/20; tối đa page 500, limit 50 |

Kết quả `{ items, total, page, limit, hasMore }`. Có tọa độ thì sắp gần nhất
trước, sau đó startsAt/id; không có thì sắp startsAt/id. `distanceKm` trong
item là số hoặc null khi chưa có tọa độ. Không có dữ liệu trả mảng rỗng.
Phân trang offset có thể thay đổi nếu dữ liệu được cập nhật giữa các request.
Query sai trả 400; token thiếu/hết hạn trả 401.

## Dữ liệu MongoDB

Collection `activities`, schema cho phần tìm kiếm:

```js
{
  id: "unique-activity-id",
  hostId: "id-of-host-account",
  hostName: "Tên host",
  title: "Cà phê cuối tuần",
  description: "Gặp gỡ và trò chuyện",
  location: "Quận 1, TP.HCM",
  coordinates: { type: "Point", coordinates: [106.7, 10.77] }, // longitude, latitude
  startsAt: ISODate("2030-01-07T12:00:00Z"), // ví dụ; phải là ngày tương lai thực tế
  status: "published",
  category: "Ăn uống",
  estimatedCost: 50000,
  memberCount: 1,
  maxParticipants: 5,
  tags: ["Coffee"],
  requirements: [],
  plan: [],
  imageUrl: "https://res.cloudinary.com/your-cloud/image/upload/your-cover.webp"
}
```

Đây là ví dụ schema, không tự ghi vào database. Người quản lý dữ liệu có thể
chuẩn bị dữ liệu dev theo schema; API tạo/sửa hoạt động và luồng FE tạo hoạt động
chưa được triển khai trong thay đổi này. Tọa độ thiếu không xuất hiện khi tìm
gần đây. Các trường ngày/số phải dùng BSON Date/number, không dùng chuỗi hiển thị.

## FE và Postman

- Match dùng API thật, có từ khóa, retry và tải trang tiếp theo. Không fallback
  sang hoạt động giả. Ngân sách và thời gian rảnh được gửi cùng truy vấn.
- Nút dùng vị trí yêu cầu quyền foreground; không theo dõi nền. Chưa cho quyền
  vẫn tìm mọi khu vực. Bán kính trong bộ lọc chỉ áp dụng sau khi lấy vị trí.
- Web cần HTTPS hoặc localhost để xin vị trí. Build native cần build lại với
  plugin expo-location; Expo Go có sẵn module. Chưa kiểm thử GPS trên máy thật.
- Swipe bỏ qua/undo chỉ local. Chưa có API xin tham gia hoặc host duyệt; swipe
  phải không còn mở Match thành công giả ở luồng khám phá API.
- Import lại Postman và dùng `Search Activities / Match` sau Login. Bật các
  query tùy chọn trong tab Params. Không có dữ liệu thì HTTP 200 với items rỗng.

Tham khảo [MongoDB geoNear](https://www.mongodb.com/docs/manual/reference/operator/aggregation/geonear/)
và [Expo SDK 57 Location](https://docs.expo.dev/versions/v57.0.0/sdk/location/).
