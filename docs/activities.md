# API hoạt động: tạo, sửa, xóa và tìm kiếm

Tất cả endpoint yêu cầu `Authorization: Bearer <accessToken>`.

| Method | Path | Kết quả |
| --- | --- | --- |
| POST | `/api/activities` | 201 `{ activity }`, tạo hoạt động published, host lấy từ token |
| GET | `/api/activities/mine?page=1&limit=20` | Hoạt động do mình tổ chức, gồm cả đã bắt đầu, phân trang |
| GET | `/api/activities/:id` | 200 `{ activity }`; host xem được của mình, người khác chỉ xem published |
| PATCH | `/api/activities/:id` | Host cập nhật một phần; trả `{ activity }` |
| DELETE | `/api/activities/:id` | Host xóa mềm; 204; không còn trong tìm kiếm, danh sách riêng và chi tiết |
| GET | `/api/activities` | Tìm kiếm/Match như mô tả bên dưới |

## Tạo và chỉnh sửa

Body POST ví dụ (đổi ngày thành thời gian thực tế trong tương lai):

```json
{
  "title": "Cà phê cuối tuần",
  "description": "Gặp gỡ và trò chuyện",
  "category": "Ăn uống",
  "location": "Quận 1, TP.HCM",
  "startsAt": "2030-01-07T02:00:00Z",
  "endsAt": "2030-01-07T04:00:00Z",
  "estimatedCost": 50000,
  "maxParticipants": 6,
  "coordinates": { "type": "Point", "coordinates": [106.7, 10.77] },
  "requirements": ["Đến đúng giờ"],
  "tags": ["Coffee"],
  "plan": []
}
```

- Bắt buộc title (3–120), description (1–3000), location (2–200), category,
  startsAt, endsAt, estimatedCost (số nguyên VND 0–1 tỷ), maxParticipants (2–1000).
- Ngày phải là ISO UTC có `Z`, với giây và tùy chọn 3 chữ số milliseconds.
  Ngày bắt đầu phải ở tương lai, kết thúc sau bắt đầu. Cho phép nhiều ngày.
- Coordinates tùy chọn hoặc null; mảng theo thứ tự kinh độ, vĩ độ. Không có
  tọa độ vẫn tìm theo từ khóa nhưng không xuất hiện trong tìm kiếm gần đây.
- tags, requirements, plan: tối đa 20 chuỗi, mỗi chuỗi 1–200 ký tự.
- Tùy chọn `coverBase64`: ảnh JPEG/PNG/WebP tĩnh <=2 MiB/20MP, không có data URL
  prefix. BE thu nhỏ 1200×900 rồi upload Cloudinary dưới `gomate/activities`.
  Tạo không ảnh không cần Cloudinary. Không chấp nhận imageUrl do client tự gán.
- PATCH chỉ truyền trường muốn đổi. Host/memberCount/status/id do BE kiểm soát;
  host khởi đầu tính là 1 thành viên. Không sửa khi đã bắt đầu và không giảm
  sức chứa dưới số thành viên. Không có API tham gia/duyệt trong thay đổi này.
- Sai body: 400; thiếu/hết phiên: 401; không phải host: 403; không có/đã xóa: 404;
  xung đột cập nhật hoặc sức chứa: 409; ảnh quá lớn: 413; cloud lỗi: 502/503.
- Ghi có kiểm tra version đọc bởi BE để tránh ghi đè giữa các request đồng thời.
  Đây không phải cơ chế khóa một form đã mở từ lâu. DELETE đánh dấu `deleted`;
  không cung cấp restore. Ảnh cũ được dọn sau khi lưu/xóa thành công, cleanup
  thất bại được log, chưa có retry queue. hostName là snapshot khi tạo.

FE: tab Tạo dùng form bốn bước, ngày DD/MM/YYYY và giờ UTC+7; sau lưu mở danh sách
**Hoạt động tôi tổ chức**. Danh sách/chi tiết cho host sửa và xác nhận xóa.
Vuốt chọn trong Match mở chi tiết thật. Danh sách hoạt động đã tham gia chưa có.

## Tìm hoạt động / Match

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

Đây là ví dụ schema, không tự ghi vào database. Dùng POST/FE để tạo dữ liệu
thật; ví dụ schema rút gọn ở trên cần thêm endsAt khi gọi POST. Tọa độ thiếu không xuất hiện khi tìm
gần đây. Các trường ngày/số phải dùng BSON Date/number, không dùng chuỗi hiển thị.

## FE và Postman

- Match dùng API thật, có từ khóa, retry và tải trang tiếp theo. Không fallback
  sang hoạt động giả. Ngân sách và thời gian rảnh được gửi cùng truy vấn.
- Nút dùng vị trí yêu cầu quyền foreground; không theo dõi nền. Chưa cho quyền
  vẫn tìm mọi khu vực. Bán kính trong bộ lọc chỉ áp dụng sau khi lấy vị trí.
- Web cần HTTPS hoặc localhost để xin vị trí. Build native cần build lại với
  plugin expo-location; Expo Go có sẵn module. Chưa kiểm thử GPS trên máy thật.
- Swipe bỏ qua/undo chỉ local. Chưa có API xin tham gia hoặc host duyệt; swipe
  phải mở chi tiết hoạt động qua API.
- Import lại Postman và dùng `Search Activities / Match` sau Login. Bật các
  query tùy chọn trong tab Params. Không có dữ liệu thì HTTP 200 với items rỗng.

Tham khảo [MongoDB geoNear](https://www.mongodb.com/docs/manual/reference/operator/aggregation/geonear/)
và [Expo SDK 57 Location](https://docs.expo.dev/versions/v57.0.0/sdk/location/).
