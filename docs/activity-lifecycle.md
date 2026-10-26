# Bắt đầu, kết thúc, điểm danh và nhật ký

Tất cả endpoint cần Bearer token. Prefix `/api/activities/:id`.

| Method | Path | Quyền / kết quả |
| --- | --- | --- |
| POST | `/start` | Host; không body hoặc {}; 200 `{ activity }` |
| POST | `/complete` | Host; không body hoặc {}; 200 `{ activity }` |
| GET | `/attendance?page=1&limit=20` | Host/approved member; danh sách điểm danh |
| PATCH | `/attendance/:userId` | Host; `{ "status": "present" }`; 200 `{ attendance }` |
| GET | `/updates?page=1&limit=20` | Host/approved member; nhật ký mới nhất trước |
| POST | `/updates` | Host; `{ "text": "Tập trung ở cổng chính" }`; 201 `{ update }` |

## Trạng thái và quyền

- Chuyển `published → in-progress → completed`. Host có thể chủ động bắt đầu
  sớm hoặc muộn hơn giờ dự kiến; không tự chuyển trạng thái theo đồng hồ.
  `startedAt`/`completedAt` là thời gian server, khác `startsAt`/`endsAt` dự kiến.
- Gọi start/complete lặp hoặc sai thứ tự trả 409. Bắt đầu chốt roster gồm host
  và các yêu cầu approved, không có pending/rejected/left/removed. Điểm danh ban
  đầu là unmarked, kể cả host. Trước start, GET attendance trả danh sách rỗng.
- Khi đã bắt đầu không nhận/duyệt yêu cầu mới, không rời/loại thành viên, không sửa
  bằng PATCH activity, kể cả khi bắt đầu sớm. Sau complete vẫn xem được chi tiết,
  nhóm/chat, danh sách đã tham gia, attendance và nhật ký nếu còn quyền.
- Điểm danh chỉ host thay đổi khi in-progress: unmarked/present/absent/late.
  Item gồm userId, name (snapshot), status, và updatedAt/updatedBy khi đã cập nhật.
  Member không tự điểm danh. Chưa đánh dấu không tự coi là absent khi complete.
- Nhật ký tự ghi started/completed/attendance-changed, gồm id, type, actorId,
  createdAt. Điểm danh thêm userId, previousStatus, status. Ghi chú thêm text
  1–1.000 ký tự; không thay đổi giờ/địa điểm thực tế hoặc gửi push.
- Status/attendance và log được cập nhật nguyên tử trong cùng document bằng
  version. Xung đột đồng thời trả 409: tải lại trước khi thử tiếp. PATCH cùng
  trạng thái hiện tại trả 200 và không tạo thêm log. POST note không có khóa
  idempotency: nếu mất response, kiểm tra nhật ký trước khi gửi lại.
- Nhật ký gồm các thao tác lifecycle/điểm danh/ghi chú, không phải audit toàn bộ
  CRUD/tham gia. Tối đa 2.000 entry trước khi thêm note/đổi điểm danh bị chặn;
  vẫn luôn cho phép hoàn tất (tối đa 2.001 entry). Không cắt bỏ lịch sử.
- GET trả `{ items, total, page, limit, hasMore }`; page mặc định 1, max 500;
  limit mặc định 20, max 50. Attendance theo roster, host trước.
- Không lộ toàn bộ roster/log trong response activity công khai. Các endpoint
  riêng chỉ cho host/approved member; hoạt động đã xóa trả 404.
- 400: body/query sai; 401: thiếu/hết phiên; 403: sai quyền; 404: hoạt động hoặc
  người không thuộc roster; 409: sai trạng thái/xung đột/giới hạn log; 429: quá
  giới hạn ghi chung 40 lần/15 phút/IP. Không cần migration dữ liệu.

## Automatic schedule processing

- `src/server.js` runs the activity scheduler at startup and every 30 seconds.
- Published or in-progress activities whose `endsAt` has passed become completed atomically. Completion retains the actual scheduled end time, increments the version, and appends a lifecycle event.
- Existing attendance remains unchanged. Automatic completion does not mark anyone present or bypass rating eligibility.
- Host and approved members receive an in-app reminder in the 30 minutes before `startsAt`, plus an automatic-completion notice. Notification settings apply; pending/rejected members do not receive these notices.
- Stable activity/schedule notification keys prevent duplicates across ticks and server restarts. Failed completion notices are retried; large overdue backlogs are processed in batches of 100 per tick.

## Postman

Import collection → **09 - Activity Lifecycle**. Chuẩn bị bằng Join Requests Setup
→ Submit → Approve trước, rồi Start → Attendance → Mark Attendance → Add Note →
Updates → Complete. Dùng hostAccessToken; memberUserId lấy từ Login Member.
Đổi token GET thành memberAccessToken để kiểm tra quyền thành viên. Chọn trạng
thái khác trong body Mark Attendance để sửa trước Complete. Tạo hoạt động mới
nếu muốn test lại từ đầu; không có API mở lại hoạt động đã hoàn tất.
