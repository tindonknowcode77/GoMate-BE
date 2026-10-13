# Chat riêng và nhóm

Tất cả API dùng `Authorization: Bearer <accessToken>`. Prefix `/api/conversations`.
Chat hiện hỗ trợ văn bản; chưa có file, ảnh, sửa/xóa tin, typing, online presence
hay push khi ứng dụng đóng. Khởi động lại BE để tạo các index chat tự động.

| Method | Path | Body / kết quả |
| --- | --- | --- |
| POST | `/` | `{ "type": "direct", "userId": "UUID-người-nhận" }` hoặc `{ "type": "group", "activityId": "UUID-hoạt-động" }`; 200 `{ conversation }` |
| GET | `/?page=1&limit=20` | 200 `{ items, total, page, limit, hasMore }` |
| GET | `/:id/messages?limit=30&before=<messageId>` | 200 `{ items, hasMore, nextCursor }` |
| POST | `/:id/messages` | `{ "text": "Xin chào", "clientMessageId": "UUID-do-client-tạo" }`; 200 `{ message }` |
| PATCH | `/:id/read` | `{ "messageId": "ID-tin-đã-xem" }`; 200 `{ conversation }` |
| GET | `/:id/events` | SSE; giữ kết nối để nhận `conversation.updated` |

## Dữ liệu và quy tắc

- Một hội thoại riêng duy nhất cho mỗi cặp người dùng (hai chiều dùng cùng ID).
  Hai người phải tồn tại; không được chat với chính mình. Hiện cho phép người dùng
  đăng nhập mở chat với người dùng bất kỳ; chưa có chính sách block/contact.
- Mỗi hoạt động có một hội thoại nhóm, tạo khi host/thành viên approved mở lần đầu.
  Không lưu bản sao danh sách thành viên trong chat. Mỗi lần đọc/gửi/đánh dấu đã
  đọc kiểm tra quyền hiện tại. Hoạt động đã xóa không truy cập được chat; người
  rời/bị loại mất quyền. Người được duyệt lại đọc được cả lịch sử nhóm.
- Hội thoại trả id, type, createdAt; direct có participantIds, group có activityId;
  kèm lastMessage (hoặc null), unreadCount, messageCount, lastReadMessageId (hoặc null).
  Không trả email/password/token. Danh sách sắp theo thời gian tạo giảm dần rồi id;
  chưa sắp theo tin cuối. page tối đa 500, limit tối đa 50.
- Message: id (24 ký tự hex), conversationId, senderId, text, clientMessageId, createdAt.
  ID người gửi lấy từ token. Text được trim, dài tối đa 4.000 ký tự, không nhận HTML
  đặc biệt; FE phải hiển thị như văn bản, không chèn raw HTML.
- clientMessageId là chuỗi 1–100 chữ/số/`_`/`-`, nên dùng UUID mới cho mỗi tin mới.
  Retry cùng sender + conversation + clientMessageId và cùng nội dung trả lại tin cũ.
  Cùng mã nhưng khác nội dung trả 409. Mã được lưu MongoDB, không phụ thuộc RAM.
- Lịch sử tin mới nhất trước, sort theo ObjectId giảm dần. Gửi nextCursor vào before
  để tải trang cũ hơn (limit tối đa 100). Khi có tin mới tải lại trang đầu và gộp
  theo message.id; không dùng trang cũ như con trỏ nhận tin mới.
- PATCH read đánh dấu đã đọc đến messageId được chỉ định trong hội thoại. Mốc đọc
  chỉ tăng, không lùi khi nhiều thiết bị cập nhật; tin do chính mình gửi không tính
  unread. Tin được xếp theo ObjectId, không phải thứ tự cam kết giao dịch toàn cục.
- 400: body/query sai; 401: phiên không hợp lệ; 403: không có quyền; 404: đối tượng
  không tồn tại; 409: xung đột clientMessageId; 429: vượt giới hạn ghi 120 lần/phút/IP.

## SSE cho FE

Mở GET `/:id/events` với header Bearer. Dùng HTTP streaming/fetch có hỗ trợ header;
EventSource chuẩn trên browser không cho đặt Authorization tùy ý. Không đặt token
trong URL. Client phải tự kết nối lại khi EOF, lỗi mạng hoặc event reconnect.

```text
event: conversation.updated
data: {"id":"...","type":"group","activityId":"...","lastMessage":{...},"unreadCount":1,"messageCount":1,"lastReadMessageId":null,"createdAt":"..."}

```

- Mở stream sẽ nhận snapshot đầu tiên. Khi dữ liệu đổi, nhận snapshot mới và FE
  gọi GET messages để đồng bộ. Đây là thông báo thay đổi, không phải log phát lại
  từng tin; có thể gộp nhiều tin trong một thông báo. Kết nối lại luôn nhận snapshot
  hiện tại, không dùng Last-Event-ID. FE tiếp tục tải lịch sử nếu khoảng trống lớn.
- Server kiểm tra MongoDB mỗi giây, dùng chung dữ liệu nên chạy nhiều instance
  hoặc restart vẫn đồng bộ được. Không yêu cầu replica set, Redis hoặc change streams.
  Polling tạo tải DB theo số kết nối; cần tối ưu sang event bus khi tăng quy mô.
- Kiểm tra phiên và quyền nhóm ở mỗi tick. `access-revoked` (401/403/404) đóng stream;
  `stream-error` báo lỗi server và đóng. Ngừng reconnect nếu mất quyền, đăng nhập lại
  nếu hết phiên. Thao tác đang xử lý đồng thời với thu hồi quyền có thể đã được cho
  phép tại thời điểm kiểm tra; tick sau sẽ phát hiện thay đổi.
- Heartbeat comment khoảng 15 giây; tối đa 5 stream/user/server. Stream tự đóng
  sau khoảng 5 phút với event reconnect. Client chậm bị ngắt để giới hạn bộ nhớ.
- SSE theo từng hội thoại; FE refresh danh sách khi mở màn hình/quay lại app để
  nhận hội thoại mới. Đây không phải push notification cho app chạy nền.

## Test Postman

Import collection, mở **08 - Chat**. Chạy Setup của Join Requests để có host/member
token, memberUserId và activityId. Với nhóm phải Submit → Approve trước.

1. Open Direct (Host) hoặc Open Group (Host), tự lưu conversationId.
2. Mở Events (Member) trong một tab/request riêng, giữ kết nối.
3. Send Message (Host): tự tạo clientMessageId mỗi lần Send và lưu messageId.
   Muốn kiểm tra retry, tắt script prerequest và dùng lại clientMessageId.
4. History/List (Member): kiểm tra tin và unreadCount; Mark Read (Member) để về 0.
5. Host loại member, stream nhóm nhận access-revoked; History trả 403.

Stream nhận snapshot ban đầu nên có thể thấy dữ liệu trước khi gửi tin. Tránh chạy
folder bằng Runner vì request Events giữ kết nối. Dữ liệu chỉ dùng MongoDB của BE;
test tự động dùng MongoDB tạm độc lập, không đọc `.env`.
