# Sale AI Context

File này dùng làm ngữ cảnh bàn giao cho người hoặc AI phát triển tiếp các chức năng sales/ads. Bám sát tài liệu này để không lặp lại các lỗi đã gặp trong bài test `test-sales.ts`.

## Mục Tiêu Bài Toán

Ghép dữ liệu doanh số từ Google Sheets với dữ liệu chi tiêu/chuyển đổi từ TikTok Ads để báo cáo theo:

- MKT phụ trách, ví dụ `MKT80.HOÀNG-TH`.
- Sản phẩm, ví dụ `MẶT NẠ MẮT LANBENA`.
- Thị trường/ngôn ngữ, hiện dùng mã từ `PageMap`, ví dụ `ID`, `VN`.
- Khung thời gian: hôm nay và tháng này.

Các chỉ số chính:

- Số đơn hàng từ sheet.
- Chi tiêu Ads USD.
- Chi tiêu Ads VND.
- Số chuyển đổi Ads.
- CPA USD và CPA VND.
- Doanh số chốt.
- Doanh số thành công.
- `%CP Ads = Chi tiêu Ads VND / Doanh số chốt * 100`.

## Nguồn Dữ Liệu Google Sheets

Config sheet lấy từ env:

- `CONFIG_GOOGLE_SHEET_ID`
- fallback hiện tại: `1f7bH43w8kv_iiqoy9X5TzSugDuWtsKrB3-Iq8IrxvAI`

Các tab quan trọng:

- `Sources!A:E`: chứa danh sách spreadsheet ID của các bảng doanh số. Không được chỉ đọc cột A, vì ID có thể nằm ở các cột khác. Cách đúng là quét từng dòng và tìm cell khớp regex Google spreadsheet ID.
- `SpMap!A:E`: map tên sản phẩm dài trên sheet sang key campaign. Trong layout thực tế, tên sản phẩm dùng cột C, key campaign dùng cột E. Ví dụ `MẶT NẠ MẮT LANBENA` -> `mặt nạ mắt`.
- `PageMap!A:D`: map page sang market code.
  - A: page handle.
  - B: market code, ví dụ `ID`, `VN`.
  - C: page name.
  - D: page URL.
- `Permissions!A:E`: map MKT code sang advertiser ID TikTok, chỉ lấy advertiser enabled.
- `Settings!A:B`: tỷ giá USD/VND nếu có. Tỷ giá chuẩn của bài test hiện là `28119`.

## Nguồn Dữ Liệu Sales Sheet

Mỗi spreadsheet trong `Sources` cần tìm tab Đài Loan. Tên tab có thể là:

- `ĐÀI LOAN`
- `Dai Loan`
- `Taiwan`

Các cột trong tab doanh số:

- A: ngày.
- D: tên page/shop.
- E: mã nhân viên MKT.
- F: mã sản phẩm.
- G: link nick/page.
- O: `DT thực`, doanh số VND.
- Q: trạng thái đơn.

Lọc sales đúng bài toán:

- `row[E]` phải bằng target MKT, ví dụ `MKT80.HOÀNG-TH`.
- `row[F]` phải match sản phẩm mục tiêu:
  - bằng variant trong `SpMap`, ví dụ `MẶT NẠ MẮT LANBENA`;
  - hoặc chứa keyword như `MẶT NẠ MẮT`, `LANBENA`.
- Market code lấy từ `PageMap`, ưu tiên match:
  - page handle trong link;
  - page URL trong link;
  - page name từ cột D.

## Quy Tắc Đếm Đơn Và Doanh Số

Điểm rất quan trọng: số đơn hàng không đồng nghĩa với số dòng có doanh số.

- Nếu dòng đúng ngày, đúng MKT, đúng sản phẩm nhưng cột `DT thực` trống, vẫn phải tính là 1 đơn.
- Với dòng trống `DT thực`, doanh số tính là `0`.
- Nếu `DT thực` có giá trị nhưng parse lỗi, bỏ qua dòng đó và log/debug riêng.
- Trạng thái đơn không ảnh hưởng số đơn hàng tổng.
- `Doanh số chốt` cộng toàn bộ `DT thực` parse được.
- `Doanh số thành công` chỉ cộng `DT thực` nếu status match các trạng thái thành công.

Regex/status hiện đang dùng:

```ts
/thành công|đã nhận|hoàn thành|done|success/i
```

Trong codebase hiện có một số chuỗi bị mojibake do encoding cũ. Khi sửa tiếp nên ưu tiên giữ file UTF-8 đúng tiếng Việt.

## Parse Ngày

Đây là lỗi lớn nhất trong bài test.

Sheet đang dùng format Việt Nam `dd/mm/yyyy`, ví dụ `02/04/2026`.

Không được gọi `new Date(rawValue)` trước, vì JavaScript có thể hiểu `02/04/2026` là `February 4, 2026` thay vì `2 April 2026`.

Cách đúng:

1. Nếu value là serial number của Google/Excel date, chuyển serial trước.
2. Ưu tiên parse regex `dd/mm/yyyy`, `dd-mm-yyyy`, `dd.mm.yyyy`.
3. Validate lại ngày/tháng/năm sau khi tạo `Date`.
4. Chỉ fallback `new Date(rawValue)` sau cùng cho ISO date như `2026-04-02`.

Kỳ vọng:

- `02/04/2026` -> `2026-04-02`.
- `03/04/2026` -> `2026-04-03`.
- `13/04/2026` -> `2026-04-13`.

## Dữ Liệu TikTok Ads

Hàm chính đang dùng:

- `getTodaySpentCampaigns(startDate?, endDate?)`
- Nếu truyền range tháng: lấy report campaign từ `startDate` đến `endDate`.
- Nếu chỉ hôm nay: dùng thêm cache để giữ campaign đã spend nhưng bị pause/delete.

TikTok report dùng:

- `data_level: AUCTION_CAMPAIGN`
- `entity: CAMPAIGN`
- dimensions: `campaign_id`, `stat_time_day`
- metrics:
  - `campaign_name`
  - `spend`
  - `impressions`
  - `clicks`
  - `ctr`
  - `conversion`
  - `cost_per_conversion`

Không gọi ad report với `AUCTION_AD` + dimension `campaign_id`, vì TikTok trả lỗi:

```text
Invalid value for dimensions: data_level AUCTION_AD and dimension campaign_id do not match
```

Nếu cần bổ sung từ ad-level report, chỉ dùng dimensions hợp lệ như `ad_id`, `stat_time_day`, rồi enrich metadata qua `ad/get`.

## Match Campaign Với Sản Phẩm Và Market

Tên campaign thường được tách bằng dấu `-`.

Cách match sản phẩm:

- Lấy key từ `SpMap`, ví dụ `MẶT NẠ MẮT`.
- Match key với phần đầu campaign hoặc toàn campaign name.
- Fallback match keyword `LANBENA`, `MẶT NẠ MẮT`.

Cách match market:

- Tách campaign name theo `-`.
- Phần thứ 2 thường là market code, ví dụ `ID`, `VN`.
- Fallback kiểm tra market code xuất hiện trong các phần còn lại hoặc trong campaign name.

Chỉ tính campaign thuộc MKT đang xét nếu `advertiser_id` nằm trong `Permissions` của target MKT.

## Tỷ Giá Và Tiền Tệ

Tỷ giá chuẩn bài test hiện tại:

```text
1 USD = 28119 VND
```

Trong code chính:

- Ưu tiên đọc từ `Settings`.
- Fallback mặc định cũng phải là `28119`.

Trong `test-sales.ts`:

- Không dùng `25500` nữa.
- Phải dùng `28119`.

Công thức:

```text
Chi tiêu Ads VND = spend USD * 28119
CPA USD = spend USD / conversions
CPA VND = Chi tiêu Ads VND / conversions
%CP Ads = Chi tiêu Ads VND / Doanh số chốt * 100
```

Nếu sau này TikTok account/report trả spend không phải USD, phải gắn `currency` vào campaign/ad và quy đổi theo currency thực tế. Không được mặc định nhân USD rate cho mọi currency.

## Kết Quả Test Chuẩn Hiện Tại

Target:

- MKT: `MKT80.HOÀNG-TH`
- Sản phẩm: `MẶT NẠ MẮT LANBENA`
- Key campaign: `MẶT NẠ MẮT`
- Tỷ giá: `28119`
- Khoảng tháng: `2026-04-01` đến `2026-04-26`

Kết quả sales sheet tháng:

- `ID`: 155 đơn.
- `VN`: 17 đơn.
- Tổng: 172 đơn.
- Có 15 dòng đúng MKT/sản phẩm nhưng trống `DT thực`; vẫn tính đơn, doanh số là 0.

Kết quả từ lần chạy `test-sales.ts` sau cùng:

### Hôm Nay

`ID`:

- Số đơn hàng: 1.
- Chi tiêu Ads: `116.693,85 VND` / `$4.15`.
- Chuyển đổi Ads: 5.
- CPA: `$0.83`, xấp xỉ `23.339 VND`.
- Doanh số chốt: `311.363 VND`.
- Doanh số thành công: `0 VND`.
- `%CP Ads`: `37.48%`.

### Tháng Này

`ID`:

- Số đơn hàng: 155.
- Chi tiêu Ads: `31.649.340,45 VND` / `$1125.55`.
- Chuyển đổi Ads: 1316.
- CPA: `$0.86`, xấp xỉ `24.050 VND`.
- Doanh số chốt: `42.173.249 VND`.
- Doanh số thành công: `40.927.797 VND`.
- `%CP Ads`: `75.05%`.

`VN`:

- Số đơn hàng: 17.
- Chi tiêu Ads: `4.008.925,83 VND` / `$142.57`.
- Chuyển đổi Ads: 119.
- CPA: `$1.20`, xấp xỉ `33.688 VND`.
- Doanh số chốt: `7.874.142 VND`.
- Doanh số thành công: `7.874.142 VND`.
- `%CP Ads`: `50.91%`.

Tổng tháng `ID + VN`:

- Số đơn hàng: 172.
- Chi tiêu Ads: khoảng `35.658.266 VND` / `$1268.12`.
- Chuyển đổi Ads: 1435.
- CPA tổng: `$0.88`, xấp xỉ `24.849 VND`.
- Doanh số chốt: `50.047.391 VND`.
- Doanh số thành công: `48.801.939 VND`.
- `%CP Ads` theo doanh số chốt: khoảng `71.25%`.
- `%CP Ads` theo doanh số thành công: khoảng `73.07%`.

Lưu ý: số Ads hôm nay có thể thay đổi theo thời gian trong ngày vì TikTok report cập nhật liên tục.

## Checklist Khi Viết Tính Năng Mới

Khi phát triển command/report sales mới, luôn kiểm tra:

1. Đã đọc `Sources!A:E` bằng regex spreadsheet ID chưa.
2. Đã đọc `SpMap!A:E`, không đọc nhầm `STT/Tên vật tư` chưa.
3. Đã parse ngày `dd/mm/yyyy` trước `new Date()` chưa.
4. Đã đếm đơn trống `DT thực` là 1 đơn, doanh số 0 chưa.
5. Đã map market bằng `PageMap` handle/url/page name chưa.
6. Đã lọc advertiser theo `Permissions` của đúng MKT chưa.
7. Đã dùng tỷ giá `28119` hoặc `Settings` chưa.
8. Đã phân biệt `%CP Ads` theo doanh số chốt và theo doanh số thành công chưa.
9. Đã tránh gọi TikTok `AUCTION_AD + campaign_id` chưa.
10. Đã test lại tổng tháng khớp benchmark `172` đơn cho MKT80/mặt nạ mắt chưa.

## File Liên Quan

- `test-sales.ts`: script kiểm chứng end-to-end với dữ liệu thật.
- `google-sheets/api.ts`: parse config, parse sales, parse ngày, map page, tỷ giá.
- `tiktok/api.ts`: lấy spend/conversion TikTok, campaign/ad report, cache campaign hôm nay.
- `bot/handlers.ts`: command `/sales`, tổng hợp sales và ads để trả về Telegram.
