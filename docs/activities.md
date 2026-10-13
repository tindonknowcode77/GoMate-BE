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

## Hoạt động và yêu cầu của người đăng nhập

Hai API dùng `Authorization: Bearer <accessToken>`, lấy user từ token:

| Method | Path | Nội dung items |
| --- | --- | --- |
| GET | `/api/me/activities?page=1&limit=20` | Các activity đã có yêu cầu approved của mình |
| GET | `/api/me/join-requests?status=pending&page=1&limit=20` | Các yêu cầu của mình, mỗi item kèm `activityId` và `activity` |

Response: `{ items, total, page, limit, hasMore }`. Mặc định page=1, limit=20;
page tối đa 500, limit tối đa 50. Query sai/không được hỗ trợ trả 400; thiếu hoặc
hết hạn token trả 401. Danh sách rỗng trả 200 với items=[], total=0.

- `/me/activities` không gồm hoạt động mình tổ chức (dùng `/activities/mine`),
  không gồm pending/rejected/cancelled; có cả hoạt động đã bắt đầu và còn đủ chỗ hay hết chỗ.
  Sắp xếp startsAt tăng dần, sau đó id. Chỉ nhận page/limit, chưa lọc vòng đời.
- `/me/join-requests` nhận status: pending/approved/rejected/cancelled/left/removed; bỏ status
  để lấy mọi trạng thái. Sắp xếp ngày gửi giảm dần, sau đó activity id.
  Item gồm id, userId, name, status, createdAt, updatedAt, activityId, activity.
- Không trả hoạt động đã xóa mềm hoặc yêu cầu của chúng. Yêu cầu pending đã quá
  giờ bắt đầu vẫn được hiển thị với trạng thái hiện có; chưa tự chuyển hết hạn.
- Không trả danh sách yêu cầu của người khác, `_id` hoặc mã nội bộ ảnh Cloudinary.
  Gửi lại sau hủy/từ chối thay bản ghi cũ, nên đây không phải lịch sử mọi lần gửi.
- Index `joinRequests.userId + joinRequests.status` được tạo tự động khi BE khởi động
  (hoặc chạy `npm run db:migrate`). Không cần thay đổi dữ liệu cũ.

## Thành viên nhóm

Các API yêu cầu Bearer token:

| Method | Path | Kết quả |
| --- | --- | --- |
| GET | `/api/activities/:id/members?page=1&limit=20` | Host hoặc thành viên approved; `{ items, total, page, limit, hasMore }` |
| DELETE | `/api/activities/:id/members/me` | Thành viên tự rời nhóm; 204 |
| DELETE | `/api/activities/:id/members/:userId` | Host loại thành viên approved; 204 |

Mỗi item chỉ gồm `{ userId, name, role }`, role là host/member. Host đứng đầu,
thành viên sắp theo thời gian duyệt rồi userId. Tên là snapshot lúc tạo hoạt động/
gửi yêu cầu. Mặc định page=1, limit=20; tối đa page=500, limit=50.

- Người ngoài, người pending hoặc đã rời/bị loại không được xem danh sách (403).
- Host không thể tự rời hoặc bị loại (403). Chỉ host được loại người khác.
- Rời/loại chỉ áp dụng cho hoạt động published chưa bắt đầu; quá giờ trả 409.
- Không có hoạt động hoặc không còn thành viên approved trả 404. Ghi đồng thời
  có thể trả 409; trạng thái và memberCount giảm nguyên tử, không giảm hai lần.
- Yêu cầu chuyển từ approved sang `left` (tự rời) hoặc `removed` (host loại).
  Hai trạng thái này lọc được ở cả danh sách yêu cầu của host và `/api/me/join-requests`.
  Người đó không còn trong `/api/me/activities` hoặc danh sách members.
- Sau left/removed được gửi lại yêu cầu nếu còn chỗ và chưa bắt đầu, luôn cần host
  duyệt lại. Đây không phải chức năng chặn người dùng. Bản ghi cũ được thay thế.
- Các API ghi dùng chung giới hạn 40 lần/15 phút/IP. Không cần migration dữ liệu.

## Gửi yêu cầu

Các endpoint dưới đây đều yêu cầu Bearer token:

| Method | Path | Kết quả |
| --- | --- | --- |
| POST | `/api/activities/:id/join-requests` | Không có body hoặc `{}`; 201 `{ request }` |
| DELETE | `/api/activities/:id/join-requests/me` | Hủy yêu cầu pending của người đăng nhập; 204 |
| GET | `/api/activities/:id/join-requests?status=pending&page=1&limit=20` | Chỉ host; `{ items, total, page, limit, hasMore }` |
| PATCH | `/api/activities/:id/join-requests/:requestId` | Chỉ host; body `{ "status": "approved" }` hoặc `{ "status": "rejected" }`; 200 `{ request }` |

`request` gồm `id`, `userId`, `name` (tên lúc gửi), `status`, `createdAt`, `updatedAt`.
Thời gian trả về ISO UTC. GET không truyền status sẽ lấy mọi trạng thái;
status hợp lệ: `pending`, `approved`, `rejected`, `cancelled`, `left`, `removed`. Phân trang mặc định
page=1, limit=20; limit tối đa 50, page tối đa 500.

- Host không được xin tham gia hoạt động của mình. User lấy từ token, không nhận từ body.
- Gửi/duyệt/từ chối/hủy chỉ áp dụng khi hoạt động published và chưa bắt đầu.
- Gửi và duyệt yêu cầu cần còn chỗ; host đã chiếm 1 chỗ trong memberCount.
- Một người chỉ có một bản ghi yêu cầu trên mỗi hoạt động. Pending/approved không được gửi trùng.
- Sau cancelled/rejected/left/removed được gửi lại với ID và thời gian mới; bản ghi cũ được thay thế, không lưu lịch sử từng lần gửi.
- Hủy chỉ dành cho pending, không phải rời nhóm sau khi đã được duyệt.
- Duyệt cập nhật trạng thái và memberCount nguyên tử; duyệt lặp hoặc đồng thời không tăng quá sức chứa.
- Danh sách yêu cầu chỉ host được xem, không xuất hiện trong response chi tiết/tìm kiếm hoạt động.
- 400: body/query sai; 401: thiếu/không hợp lệ token; 403: sai quyền;
  404: hoạt động/yêu cầu không tồn tại; 409: trạng thái xung đột, hết chỗ hoặc hết hạn thao tác.
- Giới hạn 5.000 người gửi khác nhau mỗi hoạt động để giới hạn kích thước document MongoDB.
  Request được lưu trong document activity, không cần migration hoặc replica set.
- Các thao tác ghi dùng chung giới hạn 40 lần/15 phút/IP với CRUD hoạt động (429 khi vượt).

## Body tạo và chỉnh sửa

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
