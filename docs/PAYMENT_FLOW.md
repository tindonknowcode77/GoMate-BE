# Luồng tiền cọc và giải ngân

## Cách dùng

- Demo: Admin vào **Tài chính & doanh thu → Xác minh hoạt động → Xác minh ngay (Demo)** và xác nhận biểu mẫu đã điền sẵn. API riêng `POST /api/portal/finance/groups/:id/review-demo` bỏ qua ngày diễn ra, điều kiện hoàn tất và thời gian chờ khi xác minh. Lưu dấu `demo: true` và lịch sử `settlement-demo-approved`; không sửa lịch hoạt động. Sau xác minh demo, khoản cọc đủ điều kiện xuất hiện ngay trong số dư khả dụng và danh sách hoạt động yêu cầu giải ngân của doanh nghiệp; admin có thể duyệt và khóa lệnh chuyển ngay. Các bản ghi đã xác minh demo trước đó cũng được áp dụng. Các chặn khiếu nại/hoàn tiền, hoạt động bị thu hồi, cọc không đủ điều kiện và tự duyệt vẫn áp dụng. Admin tiếp tục ghi nhận chuyển tiền và chứng từ qua các bước giải ngân hiện có.

- Người dùng: **Hồ sơ → Ví & tiền cọc**. Lưu ngân hàng nhận hoàn, xem giao dịch, yêu cầu hoàn cọc, xác nhận tham gia hoặc báo sự cố.
- Doanh nghiệp: **Ví & đối soát** trong `/portal`. Lưu ngân hàng, xem tiền đang giữ theo hoạt động và gửi yêu cầu giải ngân toàn bộ phần đủ điều kiện của một hoạt động.
- Admin: **Tài chính & doanh thu** trong `/portal`. Có đối soát tiền vào, xác minh hoạt động, hoàn cọc, giải ngân, khiếu nại và lịch sử xử lý.

Đây là sổ đối soát tiền cọc theo từng giao dịch, không phải ví nạp/rút tùy ý. Thông tin ngân hàng được lưu để nhận tiền; ứng dụng chưa xác minh quyền sở hữu tài khoản qua ngân hàng.

## Chính sách mặc định

| Tình huống | Xử lý |
| --- | --- |
| Hủy trước giờ bắt đầu ít nhất 24 giờ | Được yêu cầu hoàn đủ tiền thực nhận, chờ admin kiểm tra và thực hiện chuyển khoản. |
| Hủy sát giờ, vắng mặt hoặc có tranh chấp dịch vụ | Không tự động tịch thu cọc. Admin xem xét chứng cứ, duyệt hoàn đủ hoặc từ chối kèm lý do; tiền bị khóa trong lúc xử lý. |
| Hoạt động hủy, bị xóa hoặc doanh nghiệp bị thu hồi | Cho phép yêu cầu hoàn đủ cọc chưa giải ngân. |
| Chuyển sai số tiền, chuyển sau khi mã hết hạn/hủy, chuyển trùng bằng một giao dịch ngân hàng mới | Ghi nhận đúng số tiền thực nhận để hoàn; không cộng thành doanh thu được giải ngân. |
| Tiền vào không khớp mã GM | Lưu giao dịch ngân hàng chưa khớp để admin gắn mã sau, không bỏ mất khoản tiền. |
| Doanh nghiệp bấm bắt đầu/kết thúc sớm hoặc rút ngắn lịch | Không vượt được lịch kết thúc gốc đã chụp tại lúc tạo đơn và thời gian giữ cọc. |
| Thành viên không phản hồi xác nhận | Không tự coi là đã tham gia. Admin phải có bằng chứng hoạt động và lý do xác minh thay thế, được ghi lịch sử. |

Quyền hủy sớm và thời gian giữ cọc được chụp vào đơn. Mốc có thể xét giải ngân là thời điểm muộn nhất giữa lịch kết thúc gốc, lịch hiện tại và lúc hoàn tất thực tế, cộng ít nhất **48 giờ**. Kéo dài lịch có thể kéo dài giữ tiền; sửa lịch ngắn lại không rút ngắn cam kết cũ. Chính sách giờ là cấu hình sản phẩm, không phải kết luận pháp lý.

Phí giữ mức hiện có **10%**, làm tròn VND cho từng khoản cọc. Chỉ ghi nhận doanh thu phí khi giải ngân hoàn tất; hoàn tiền trước giải ngân trả đủ tiền thực nhận. Với một khoản 50.000 VND: doanh nghiệp nhận 45.000 VND và phí là 5.000 VND.

## Đối soát tiền vào

`Tạo QR → Chờ tiền → Ngân hàng/admin đối soát → Giữ cọc`

“Tôi đã chuyển khoản xong” chỉ gửi thông báo, không chuyển trạng thái sang đã thanh toán. Polling trạng thái phải có đăng nhập và đúng chủ giao dịch/admin. Các khoản ghi nhận thủ công, trạng thái `paid` cũ không có xác minh hoặc lệnh giải ngân cũ không phải bằng chứng tiền thật.

Admin nhập số thực nhận, mã giao dịch ngân hàng và bằng chứng sao kê. Đơn hợp lệ mới tạo biên nhận `verified`. Khi nhận thiếu/thừa, mã cũ hoặc chuyển lần hai, tiền thật được giữ ở khoản chỉ dùng để hoàn. Một mã giao dịch ngân hàng chỉ được ghi nhận một lần; cùng mã nhưng khác số tiền/đơn bị từ chối.

Webhook mặc định tắt nếu `PAYMENT_WEBHOOK_SECRET` thiếu hoặc dưới 32 ký tự. Adapter ngân hàng tin cậy phải gọi qua HTTPS và gửi header `x-gomate-webhook-secret`, với body chuẩn hóa:

```json
{
  "direction": "in",
  "accountNo": "TAI_KHOAN_GOMATE_DA_CAU_HINH",
  "amount": 50000,
  "transactionRef": "BANK-UNIQUE-TRANSACTION-001",
  "content": "GM123456789012 COC GOMATE"
}
```

Không dùng header/body này từ client người dùng. Adapter phải xác minh chữ ký/thông tin nguồn theo hợp đồng nhà cung cấp trước khi chuẩn hóa. Chỉ chấp nhận tiền vào đúng tài khoản cấu hình và số nguyên VND trong giới hạn. Mã GM mới dài 12 số, vẫn nhận mã cũ 6 số.

## Hoàn cọc

`Giữ cọc → Yêu cầu hoàn → Admin duyệt → Chờ chuyển ngân hàng → Admin ghi nhận hoàn tất`

Người dùng lưu ngân hàng và gửi lý do; ngân hàng nhận tiền được chụp cố định vào yêu cầu. Đổi ngân hàng trong ví sau đó không đổi yêu cầu đang chờ. Gửi trước giờ bắt đầu cũng từ bỏ chỗ tham gia. Người dùng không thể tự đánh dấu đã hoàn; admin liên quan trực tiếp đến tiền không được tự duyệt.

Chỉ khi admin đã chuyển thật, kiểm tra kết quả, nhập mã ngân hàng và xác nhận trên giao diện thì khoản cọc mới mang trạng thái hoàn tất. Chưa có API ngân hàng tự động chuyển tiền. Không được dùng mã tiền vào hoặc dùng lại mã chuyển ra của lệnh khác.

## Giải ngân

`Hoàn tất hoạt động → Hết thời gian giữ → Xử lý hết khiếu nại/hoàn tiền → Admin xác minh hoạt động → Doanh nghiệp yêu cầu → Admin duyệt → Khóa lệnh chuyển → Chuyển ở ngân hàng → Ghi nhận mã giao dịch`

- Có xác nhận độc lập từ thành viên; trường hợp thiếu xác nhận cần admin kiểm tra bằng chứng và ghi lý do thay thế. Doanh nghiệp tự đánh dấu điểm danh/kết thúc không đủ điều kiện rút tiền.
- Yêu cầu giữ chỗ toàn bộ tiền được giải ngân và chụp ngân hàng nhận. Có mã chống gửi trùng; retry sau mất mạng trả lại cùng yêu cầu.
- Khi còn `pending`/`approved`, yêu cầu hoàn hoặc khiếu nại khóa lệnh và trả các khoản chưa có tranh chấp về giữ cọc. Phải xét hoạt động lại sau xử lý.
- **Khóa lệnh & chuẩn bị chuyển** đổi thành `processing` trước khi admin thao tác ngân hàng. Lúc này không tự giải phóng số dư hoặc cho hoàn cùng khoản tiền; người dùng được báo liên hệ hỗ trợ để đối soát. Chỉ trạng thái này mới ghi nhận chuyển tiền hoàn tất.
- Nếu ngân hàng trả kết quả không rõ hoặc mất mạng: giữ `processing`, kiểm tra sao kê, không chuyển lại. Không tự hết hạn/mở khóa. Chỉ mở khóa qua thao tác **Ngân hàng xác nhận chưa chuyển**, với xác nhận tiền chưa bị trừ/chuyển và chứng cứ tối thiểu 15 ký tự; sau đó phải xác minh hoạt động lại.
- Hoàn tất đòi hỏi mã giao dịch và xác nhận đã kiểm tra chuyển tiền. Replay không chi tiền hai lần. Tiền đã giải ngân không còn trong quỹ cọc có thể hoàn; khiếu nại sau giải ngân đi qua hỗ trợ và đối soát riêng.

## Tính nhất quán và khôi phục

Mỗi hoạt động có một sổ `finance_escrows`, cập nhật nguyên tử theo phiên bản MongoDB. Cùng một khoản không đồng thời dùng để hoàn và giải ngân. Các khoản vào có bản ghi `bank_events` bền vững trước khi ghi sổ; worker chạy lúc khởi động và mỗi 30 giây để khôi phục sự cố giữa các bước. Worker không chạy chồng và lỗi tài chính không chặn bộ lập lịch hoạt động.

Các yêu cầu và tài khoản nhận tiền, người xử lý, thời điểm, lý do và mã ngân hàng được lưu để đối soát. `finance_transfers` ngăn tái sử dụng một mã chuyển ra. Admin xem 100 sự kiện gần nhất của mỗi sổ; lịch sử đầy đủ vẫn trong DB.

Phương trình kiểm tra:

`Tiền vào đã đối soát = Cọc đang giữ + Đã hoàn + Đã trả doanh nghiệp + Phí đã thực hiện`

Số tổng được tính từ sổ, không từ biên nhận doanh nghiệp hoặc chỉ trang danh sách đang mở. Mỗi sổ giới hạn 2.000 khoản và 5.000 sự kiện để giữ dưới giới hạn document Mongo; đạt giới hạn thì dừng thao tác và cần vận hành đối soát riêng.

## Cấu hình và triển khai

1. Triển khai BE và FE cùng phiên bản, chạy `npm run db:migrate` để có chỉ mục chống trùng; restart BE nếu không dùng watch.
2. Kiểm tra `VIETQR_BANK_ID`, `VIETQR_ACCOUNT_NO`, `VIETQR_ACCOUNT_NAME` là tài khoản thu tiền đúng. Xem lại dữ liệu ngân hàng doanh nghiệp cũ nếu có trùng `ownerId` trước khi áp dụng chỉ mục unique.
3. Mặc định `PAYMENT_FREE_CANCELLATION_HOURS=24`, `PAYMENT_SETTLEMENT_HOLD_HOURS=48`; chấp nhận số nguyên 1–168. Lệnh cũ giữ cam kết đã chụp, không rút ngắn giữ cọc.
4. Có thể demo bằng admin đối soát thủ công với chứng từ mẫu; không coi thao tác demo là tiền đã di chuyển ngoài ngân hàng. Đối soát lệnh `business_payouts` cũ và trạng thái paid cũ riêng trước khi đưa vào tiền đã xác minh.
5. Muốn nhận tự động từ ngân hàng, cần cấu hình adapter thật và secret. Muốn chuyển tiền bằng API, cần tích hợp nhà cung cấp chuyển tiền có kiểm tra kết quả và khóa idempotency, thay bước admin chuyển thủ công; hiện chưa có tích hợp đó.

## Kiểm thử

- `node --test tests/finance.test.js tests/payment.test.js`: quyền truy cập, tự báo chuyển khoản, webhook giả, số tiền sai, chuyển trùng, tiền chưa khớp, thay lịch để rút sớm, ngân hàng chụp cố định, hủy sớm, hủy muộn/vắng mặt, khiếu nại sau duyệt, đồng thời hoàn/giải ngân, khóa chuyển ngân hàng, mở khóa khi thất bại, replay và khôi phục worker, phương trình tiền và phân trang.
- `npm test`: kiểm tra hồi quy toàn BE.
- FE `node tests/finance.web.cjs`: thao tác người dùng trên màn hình điện thoại, QR chỉ báo chuyển tiền, lưu ngân hàng/hoàn cọc, admin đối soát/duyệt/ghi nhận mã ngân hàng, doanh nghiệp gửi giải ngân và retry sau khi server đã nhận nhưng mạng mất phản hồi. Chạy trên DB riêng; không gọi ngân hàng thật.
