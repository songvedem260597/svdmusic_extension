# SVD Music Extension - Development Notes
## Extension Info
- Name: SVD Music Player
- Extension ID: oeaflhcgbcnppfldjdcmldkikokkiddc
- Manifest Version: 3

## Version Changelog

### v1.2.7 (2026-07-27)
- **Bỏ thanh chỉ báo bên trái ở dòng đang phát.** `box-shadow: inset 2px 0 0` (thêm ở v1.1.9) bị gỡ ở cả 3 nơi: dark (`--green-color`), light (`#00a878`), và light + ảnh nền tuỳ chỉnh.
- Dòng đang phát vẫn phân biệt được bằng nền gradient mint + tiêu đề và số thứ tự đổi màu mint, nên không mất tín hiệu.
- Có ghi chú ở cuối `styles.css` để lần sau không ai "sửa lại" bằng cách thêm thanh đó về.

### v1.2.6 (2026-07-27)
- **Tiêu đề dài ở khu "Đang phát" giờ cắt bằng "…".** Tên bài lấy từ YouTube có thể dài cả câu (kèm tên DJ, phiên bản, chữ Trung) — `.songHero h3` không giới hạn số dòng nên một tiêu đề như vậy chiếm hơn 10 dòng và đẩy vỡ bố cục (đo được: cao 622px thay vì 132px).
- Cắt bằng `-webkit-line-clamp: 3`, xuống **2 dòng** ở màn hình thấp/hẹp (`max-height: 720px` hoặc `max-width: 720px`).
- `.artistName` cũng cắt một dòng bằng `text-overflow: ellipsis`.
- Thêm thuộc tính `title` cho cả tiêu đề và nghệ sĩ trong App.jsx → rê chuột xem được tên đầy đủ.
- Các chỗ khác (`.songMeta strong`, `.miniSong strong`) vốn đã cắt sẵn, không đụng tới.

### v1.2.5 (2026-07-27)
- **Log trong modal Thêm bài luôn cuộn tới dòng mới nhất.** `.modalLog` bị `max-height: 160px` nên các bước mới bị đẩy khuất; giờ tự cuộn xuống đáy mỗi khi có dòng mới.
  - Không giành quyền cuộn với người dùng: nếu họ kéo lên đọc bước cũ thì ngừng bám đáy, kéo lại xuống thì bám tiếp (ngưỡng 24px).
  - `logAutoScrollingRef` để bỏ qua sự kiện `scroll` do chính code phát ra — thiếu cờ này thì handler đọc vị trí giữa chừng, tưởng người dùng cuộn đi và tắt bám đáy, khiến log dừng cách đáy ~52px (đã đo).
- **Tự đóng modal sau khi thêm bài thành công** — `AUTO_CLOSE_AFTER_SUCCESS_MS = 1500`, đủ để đọc "Hoàn tất." và thấy bài xuất hiện trong danh sách. Nút "Đóng" vẫn còn nếu muốn đóng sớm. Xoá `correlationId`/`jobId` trước khi đóng để không bắn lệnh huỷ vô nghĩa cho một job đã xong.
- **Lỗi tự gây ra khi làm tính năng này, đã sửa:** ban đầu đặt hai `useRef` + hai `useEffect` ở dòng ~2007, tức **sau** `if (!open) return null;` (dòng 392). Hook chạy có điều kiện làm hỏng thứ tự hook của cả component — modal đóng mà không lưu được bài. Đã chuyển toàn bộ lên trước early return, kèm chú thích cảnh báo tại chỗ.
- Kiểm chứng: log `distanceFromBottomPx: 0` (bám sát đáy), modal tự đóng sau ~1.5s, bài vào danh sách (`rows: 1`).

### v1.2.4 (2026-07-27)
- **Light mode + ảnh nền tuỳ chỉnh: ảnh nền gần như không thấy.** Hai panel `.nowPlaying`/`.songListPanel` phủ `rgba(255,255,255,0.5)` với `blur(3px)` — blur yếu nên nó chỉ là màng trắng chứ không ra kính mờ, mà panel chiếm gần hết khung nhìn. Các dòng `.songRow` lại là màu **đặc** `#f5f8f7`, chồng thêm một mảng kín nữa bên trong.
- Sửa: panel + `.songRow` + `.weatherWidget` chuyển sang trong suốt, blur tăng 3px → 16px.
- **Nối thanh trượt "Độ rõ ảnh nền" (vốn đã có) vào độ trong của panel.** Trước đây nó chỉ điều khiển lớp phủ ambient. Thêm biến `--custom-panel-alpha` (App.jsx): slider 100% → alpha 0.30 (ảnh nổi), 10% → 0.59 (chữ an toàn trên mọi ảnh).
- Lý do phải để người dùng quyết, đo bằng contrast ratio trên ảnh nền sáng/tối nhất trong bộ art:
  - alpha 0.30 trên ảnh **tối**: tiêu đề 3.17:1, chữ phụ 1.74:1 → **không đọc được**
  - alpha 0.55 trên ảnh tối: 6.77 / 5.44 → đọc tốt nhưng che gần hết ảnh sáng
  - Không có hằng số nào vừa hiện ảnh vừa đọc được trên **mọi** ảnh nền — chữ đen cần nền sáng, nền sáng thì che ảnh.
- Đã thử `backdrop-filter: brightness(1.8)` để nâng sáng nền sau kính (giúp ảnh tối): **bỏ**, vì nó làm ảnh sáng cháy trắng phẳng lì — tệ hơn vấn đề ban đầu (panel avg 245/255).
- Chữ phụ `#33415a` → `#1b2739`: màu cũ chỉ đạt 3.15:1 trên ảnh nền tối, màu mới 4.61:1 (qua WCAG AA) mà vẫn nhạt hơn tiêu đề.

### v1.2.3 (2026-07-27)
- **Fix treo ở `bridge/mp3-ready` với file lớn — bỏ hẳn base64 khỏi đường bàn giao MP3.**
- Triệu chứng: log chạy đến `Đã tải xong dữ liệu MP3, đang kiểm tra...` rồi đứng vĩnh viễn. Đây là dòng service worker in ra **ngay trước** `arrayBufferToBase64()` + `sendMessage`.
- Nguyên nhân: SW tải bytes rồi phải đẩy sang sidepanel qua runtime message, mà cách duy nhất là base64 → file 139.6 MB phình thành chuỗi **186.2 MB** phải dựng nguyên trong RAM của SW rồi serialize. Hỏng vì kích thước message, hoặc vì SW hết bộ nhớ — không phân biệt được từ ngoài, và **cả hai đều biến mất nếu SW không giữ bytes**.
- Sửa: SW chỉ resolve link rồi trả `{ downloadUrl, mimeType, size, title, duration, filesize }` và emit `mp3/result` kèm `downloadUrl` (không còn `audioBase64`). Sidepanel tự `fetch(downloadUrl)` → Blob → IndexedDB.
  - Khả thi vì đã kiểm: link tải được **không cần Referer**, **dùng lại được nhiều lần**, và `https://*.yt2mp3converter.net/*` vốn đã có trong host_permissions.
  - Sidepanel nhận `downloadUrl` thì fetch rồi **gọi lại chính listener** với `__blobReady` + `__headBytes`, nên toàn bộ khối kiểm tra size/type/header phía dưới chạy y nguyên cho cả hai đường — không đụng vào logic validation.
  - Đường `audioBase64` cũ giữ nguyên làm fallback (mp3cow vẫn dùng).
- Kết quả đo với đúng file 139.6 MB: **169 ms / peak heap 9 MB**, so với **9.900 ms / 469 MB** của đường base64 — nhanh hơn ~58 lần, tốn bộ nhớ ít hơn ~52 lần, và file chỉ truyền **một** lần thay vì hai.
- Kiểm chứng: bytes trong IndexedDB đúng 146.400.960 (khớp `filesize` nhà cung cấp trả về), `audio/mpeg`, header `ff fb e4 64`; phát được `readyState: 4`, duration 3660s.

### v1.2.2 (2026-07-27)
- **Fix nguyên nhân thật của "Không thể tải MP3": bridge yt2mp3 gọi endpoint đã chết.**
- `yt2mp3ConvertMain` gọi `https://api.yt2mp3converter.net/api/new/convert?youtubeId=…` — host này trang **không còn dùng**, và giờ trả `HTTP 500 {"error":"Maximum number of key switches or API calls reached"}` cho **mọi** video. Extension đọc thành "provider chết" → rơi sang MP3Cow (đang hỏng thật) → fail toàn bộ.
- Endpoint sống là **same-origin** `/api/convert?id=<videoId>` ngay trên yt2mp3.cloud — chính là nơi bridge đã inject script, nên gọi thẳng được, không cần host_permissions mới.
- Protocol mới cần **polling**: `{"status":"processing","progress":0}` khi đang convert → `{"status":"ok","link":…,"filesize":…,"duration":…,"title":…}` khi xong. Code cũ chỉ gọi 1 lần rồi bỏ cuộc nếu chưa `ok`. Nay poll 3s/lần, tối đa 50 lần (~2.5 phút), bail ngay nếu `status: error`.
- Response shape của endpoint mới trùng khớp cái hàm vốn đã mong đợi (`link`/`title`/`duration`/`filesize`/`videoId`), nên phần còn lại của pipeline không phải sửa gì.
- Kiểm chứng trên endpoint thật: bài 61 phút resolve trong **421ms / 1 lần gọi**, trả link `api2.yt2mp3converter.net`, duration 3660, filesize 139.6 MB. Đo tốc độ tải thật: **29.1 Mbps → ~38 giây** cho 139.6 MB, thừa trong trần `MP3_WORKER_MAX_TIMEOUT_MS` (180s).
- Hai giả thuyết đã loại trừ bằng đo đạc (ghi lại để khỏi đi lại đường cũ): trần timeout 3 phút **không** phải vấn đề (38s < 180s); `arrayBufferToBase64` với file 146 MB **chạy được** (195.2 MB chuỗi, 1.4s, 346 MB heap) và 195 MB qua `JSON.stringify`/`structuredClone` trong trang thật cũng trót lọt.
- **Còn một ẩn số chưa kiểm được**: giới hạn kích thước thật của `chrome.runtime.sendMessage` khi bàn giao ~186 MB base64 từ service worker sang sidepanel. Chỉ lộ ra khi chạy extension thật. Nếu vỡ ở đây thì hướng sửa là bỏ base64 (cắt khúc, hoặc để sidepanel tự fetch link).
- `YT2MP3_API_BASE` giờ không còn nơi dùng (giữ lại khai báo, chưa xoá).

### v1.2.1 (2026-07-27)
- **Fix "Không thể tải MP3 ... (HTTP 200)" — fallback MP3Cow bị bỏ qua.** yt2mp3 trả HTTP 200 nhưng body là trang HTML/JSON báo lỗi thay vì audio; `validateMp3Blob` bắt đúng và ném lỗi kèm `httpStatus = 200`.
- Nguyên nhân: `isFallbackEligible` (background.js) chỉ xét mã 403/404/410/429/5xx cộng vài regex trên chuỗi lỗi. Không mã nào khớp 200, nên fallback bị bỏ qua và bài hát fail luôn dù nhà cung cấp thứ hai đang sẵn sàng. Việc có fallback hay không phụ thuộc chuỗi lỗi **tình cờ** chứa chữ "audio" (qua `type=audio/mpeg`) — tức hoàn toàn hên xui.
- Sửa: thêm `providerPayloadUnusable` — mọi lỗi mang `mp3Stage` (do `validateMp3Blob` hoặc `MP3_FETCH_TIMEOUT` ném) đều là "nhà cung cấp có trả lời nhưng dữ liệu không dùng được" → **luôn** đủ điều kiện fallback, bất kể mã HTTP. Không đụng tới các điều kiện cũ.
- Test mới `scripts/test-mp3-fallback.mjs` (gắn vào `npm test`): 15 assertion. Predicate được **trích từ source lúc chạy test** nên không thể lệch với code thật. A/B: code cũ bỏ qua fallback ở 4/6 ca (2 ca INVALID_CONTENT_TYPE, octet-stream không phải mp3, và MP3_FETCH_TIMEOUT); code mới phủ đủ 6, đồng thời vẫn từ chối các lỗi không đáng thử lại (thiếu videoId, URL không hỗ trợ, HTTP 400, người dùng huỷ).

### v1.2.0 (2026-07-26)
- **Kiểm chứng bằng browser test** (`scripts/browser-tests/`, xem README trong đó): chạy UI thật trong tab thường qua chrome-shim.
  - 15 fixture cho `detectGeminiError` với DOM thật — **bắt được lỗi thật**: `textOf` fallback sang `textContent` khiến nội dung `<script>` bị quét, mà Gemini nhúng sẵn chuỗi "something went wrong" trong bundle → báo lỗi giả ở MỌI lần chạy. Đã sửa thành chỉ dùng `innerText`.
  - 4 kịch bản end-to-end qua chính AddSongModal: tick không lời (3:33) → lưu, `geminiCalls: 0`; bài 25:00 + Gemini lỗi → lưu không lời sau 3 lần thử + 2 lần xoá chat; bài 3:33 + Gemini lỗi → không lưu, báo lỗi; bài 3:33 + Gemini OK → lưu kèm lời.
- **LRC không còn bắt buộc khi thêm bài.** `persistSong` nhận thêm `allowMissingLrc`; khi không có LRC thì bỏ qua bước ghi IndexedDB, đặt `lyricsKey`/`lyricsTextKey = null`, `hasLyrics = false`, `lyricsDownloaded = false`. Trình phát vốn đã xử lý sẵn (hiện "Bài hát này chưa có lyric.") nên bài không lời dùng bình thường.
- Hai điều kiện được lưu không lời:
  - **Người dùng tick "Nhạc không lời"** (checkbox mới trong modal Thêm bài) → **bỏ qua hẳn bước Gemini**, không mở tab, không chờ.
  - **Bài dài ≥ 10 phút** (`LYRICS_OPTIONAL_MIN_SECONDS = 600`) → vẫn chạy Gemini nhưng nếu lỗi/không có LRC thì vẫn lưu bài.
- **Dò thời lượng TRƯỚC khi chạy Gemini** — `fetchVideoDurationSeconds()` trong `services/youtube.js` fetch trang watch và đọc `"lengthSeconds"`. Trước đây thời lượng chỉ biết sau khi tải xong MP3, tức là quá muộn để quyết định có nên chờ Gemini hay không. `https://*.youtube.com/*` đã có sẵn trong host_permissions nên không cần đổi manifest. Thêm step `DURATION_PROBE`.
- Tách `commitSong()` dùng chung cho cả đường có lời và không lời (trước đây khối MP3 + persist bị lặp).
- **Phát hiện lỗi Gemini bằng DOM** — `gemini-content.js` trước đây không hề nhận biết lỗi: gặp rate limit / "something went wrong" / bị từ chối thì vòng lặp cứ quay đủ `RESPONSE_TIMEOUT_MS` (5 phút) rồi mới báo timeout chung chung. Thêm `detectGeminiError()` + kiểm tra ở đầu mỗi vòng poll, throw `GEMINI_ERROR: <text>` ngay.
  - Chống báo nhầm: cụm từ đặc trưng (`something went wrong`, `bạn đã đạt giới hạn`, `vui lòng thử lại sau`…) mới so trên toàn trang; cụm ngắn (`error`, `lỗi`, `thử lại`) chỉ tin khi nằm trong container lỗi (`[role=alert]`, snackbar, `[class*=error]`…) và element phải đang hiển thị. Lời bài hát có chứa "error"/"sorry" không kích hoạt.
  - Phải thấy lỗi ở **2 vòng poll liên tiếp** mới bail, tránh snackbar chớp nhoáng tự khỏi.
- **Retry trong tab mới sau khi xoá chat lỗi** — `startLrcGenerationWithRetry` trong AddSongModal, tối đa 3 lần. Mỗi lần thất bại gọi `discardFailedLrcChat()` → message mới `gemini/discard-failed-chat` ở background: gửi `svdmusic/cleanup-conversation` cho tab job (dùng lại code xoá hội thoại sẵn có), chờ 2.5s cho dialog xác nhận chạy xong, đóng tab, xoá job lock. `ensureGeminiTab` vốn luôn tạo tab mới nên lần thử kế tiếp là tab mới + chat mới.
  - `isRetryableGeminiError()` chỉ retry lỗi transient (`GEMINI_ERROR`, `SEND_FAILED`, `INVALID_LRC_ATTACHMENT`, `DRIVE_VIEWER_TEXT_FAILED`, timeout). Lock conflict và huỷ tay thì không retry.
  - Hết 3 lần mà bài đủ điều kiện không lời → vẫn lưu; bài thường → báo lỗi như cũ.
- CSS: `.modalField.addSongNoLyrics` — `.modalField` là grid stack nên checkbox bị kéo full-width; override thành flex row, checkbox 16px, `accent-color: var(--green-color)`.
- Kiểm chứng: `fetchVideoDurationSeconds` chạy thật trên YouTube — bài 3:33 → 213s (không tuỳ chọn), stream dài → vượt ngưỡng (tuỳ chọn), id sai → null. Checkbox toggle + layout xác nhận trong trình duyệt. `npm test` (view-transfer) vẫn xanh.

### v1.1.10 (2026-07-26)
- **Fix nút "Mở rộng / Ghim lại" bị treo vĩnh viễn khi lặp expand ↔ pin.** Tái hiện được 100%: bấm "Mở trong tab" → transfer thành công → nút xám và không bao giờ hồi (baseline kẹt ở vòng 1–2).
- Nguyên nhân gốc: `isTransferringRef` là mutex boolean **nhả bằng tay** trên ~20 đường `return` của hai handler async dài, cộng giả định sai "Side Panel sẽ unmount sau khi đóng" (chính CLAUDE.md v1.1.8 ghi nhận cây React của Side Panel sống suốt page lifetime). Đường **thành công** của detach cố ý không nhả khoá → cây React còn sống mang khoá kẹt. `handleViewModeClick` chặn click, `ViewModeButton` nhận `disabled={isViewTransitioning}` → nút chết hẳn.
- **Tầng 1 — khoá tự nhả.** Thân hai handler tách thành `runDetachToStandalone` / `runPinBackToSidePanel`; wrapper `handleDetachToStandalone` / `handlePinBackToSidePanel` acquire → `try` → `finally` release. Thân KHÔNG được đụng vào khoá (có test cấu trúc chặn regression).
- **Tầng 2 — bỏ giả định vòng đời.** Nhả khoá trên MỌI đường ra, kể cả success path.
- **Tầng 3 — khoá có TTL + watchdog.** `src/utils/viewTransferLock.js`: khoá lưu timestamp (0 = free), hết hạn sau `VIEW_TRANSFER_TIMEOUT_MS + 5s`, tự đòi lại; chống cả trường hợp đồng hồ hệ thống lùi. `beginTransferUi()` hẹn watchdog xoá `isViewTransitioning` — vì TTL chỉ mở cổng click, còn nút `disabled` thì một handler treo hẳn sẽ giữ mãi.
- **Tầng 4 — các lỗi độc lập:**
  - `processIncomingViewTransfer`: guard `snapshot_mismatch` + `wrong_window` nằm SAU chỗ đặt khoá nhưng TRƯỚC `try/finally` → đưa vào trong.
  - Bus `transfer-ready` `clearTimeout` cho **bất kỳ** transferId → giết timeout 25s của transfer đang bay, `await readyPromise` không bao giờ settle, hàm không return (try/finally cũng vô dụng). Thêm `inFlightTransferIdRef` để chỉ xử lý transfer của chính view này.
  - `clearReadyListeners` **gọi** listener thay vì gỡ khỏi `chrome.runtime.onMessage` → rò một listener mỗi vòng. Đổi sang `removeListener(readyMessageListener)`.
  - `discardViewTransfer()` xoá cả `pendingViewSnapshot` khi rollback — trước đây snapshot chết còn lại làm mọi transfer sau đó dính `snapshot_mismatch` suốt phiên.
  - Listener `storage.session.onChanged` đăng ký cho CẢ hai surface (trước chỉ sidepanel) — popup đã mở không có đường nhận transfer nên detach lần 2 chắc chắn timeout 25s.
  - `hasFreshViewTransferInFlight`: `catch` trả `false` thay vì `true`; record không timestamp coi là bỏ hoang thay vì "tươi vĩnh viễn".
  - `App.jsx` scoping: `session` khai báo trong `try` nhưng dùng ngoài → ReferenceError bị nuốt, xoá mất đúng log chẩn đoán.
  - `background.js`: bỏ so sánh window id với tab id (hai không gian ID khác nhau); xoá helper `cleanupTransfer` chết.
- **Test:** `npm test` → `scripts/stress-view-transfer.mjs`, 58 assertion gồm 200.000 lượt tiêm lỗi vào contract acquire/try/finally + kiểm tra bất biến cấu trúc trong App.jsx/background.js (chặn tái phát cả lớp bug này).
- Kiểm chứng A/B trong trình duyệt bằng cùng một harness: baseline kẹt ở vòng 2 (`disabled` vĩnh viễn); bản sửa qua 40/40 vòng triple-click + snapshot chết + transfer-ready lạ + record không timestamp, không kẹt lần nào.
- Build: sidepanel JS 533.49 → 535.22 kB (gzip 117.07 → 117.54 kB); CSS không đổi.

### v1.1.9 (2026-07-26)
- **UI polish layer** — refactor giao diện giữ nguyên nhận diện dark navy + mint, thêm layer `v1.1.9 — Visual polish` ở cuối `src/styles.css`. Chỉ đổi màu/chất liệu/bo góc, KHÔNG đổi layout, không đổi kích thước lyric line (JS đo đạc), không rename class JS phụ thuộc (`.discWrap`, `.coverStack`, `.lyricLine`, `.view-lyrics`…).
- Token: `--yellow-color` #ffff00 → #ffd66e (vàng đồng dịu) cho dark theme — live lyric, active karaoke line, hover đổi theo tự động; light theme giữ #806b00 riêng nhờ specificity `:root[data-theme=light]`. Thêm `--accent-soft`, `--accent-border`, `--surface-hover`.
- Top bar: 4 nút (`.topBadgeButton`) chuyển từ outline mint đồng loạt → nền trung tính `rgba(255,255,255,0.045)` + border `--ui-border`, mint chỉ hiện khi hover/focus. Badge đếm bài (`.topBadge.topBadgeButton`) giữ mint làm điểm nhấn duy nhất.
- Song list: `.rowIndex` bỏ vàng chói → `--ui-muted` (mint + đậm khi active); `.songRow.isActive` = gradient mint + thanh inset trái 2px `var(--green-color)`; hover nền `--surface-hover`; `.rowCover`/`.miniCover` thêm ring 1px; tag pill (`.songTag`, `.tagRow span`, `.searchTag`, `.songLibraryRowTag`) dịu lại.
- Player bar: bỏ gradient đặc → kính mờ `rgba(10,16,28,0.82)` + `backdrop-filter: blur(18px)`; glow nút play giảm từ `0 0 30px rgba(21,255,146,0.5)` → shadow 2 lớp mềm; ripple `::before` giảm alpha 0.65 → 0.4.
- Đĩa xoay: viền trắng đặc 5px → 4px `rgba(255,255,255,0.72)` + bóng đổ sâu (chỉ đổi border/box-shadow, không đụng transform/`--bass`).
- Karaoke: glow active line từ vàng-xanh `rgba(217,221,0,0.28)` → vàng đồng `rgba(255,214,110,0.32)`; light-mode active line #ffff00 → #ffd66e.
- Light theme: bộ override tương ứng (nút header trắng viền xám, hover mint nhạt; active row gradient `#e2f7ef` + inset `#00a878`, border transparent để không double-outline với rule cũ; rowIndex slate #64748b thay #614700 w800).
- Lưu ý cascade: layer nằm CUỐI file nên thắng mọi rule cùng specificity trước đó; các rule `.theme-light .X` (specificity cao hơn) vẫn thắng phần dark. KHÔNG thêm rule unqualified đổi layout (grid-template-columns/min-height của `.songRow`…) vào layer này vì sẽ đè lên các media query responsive ở giữa file.
- Build: sidepanel CSS 178.39 → 179.02 kB (gzip 37.63 kB); JS không đổi logic.

### v1.1.8 (2026-07-14)
- Manifest version normalized to `1.1.8` (3-part semver, previously `1.1.7.001`). Chrome MV3 was warning "Manifest version 1.1.7.1 is not semver compliant".
- **Fix Side Panel pin-back READY handshake.** Popup "Ghim lại" was stuck at `[PIN_BACK] WAITING_READY` and timed out because Side Panel's React tree mounts once per page lifetime and `chrome.sidePanel.open({windowId})` only refocuses an already-loaded surface — no remount, no fresh useEffect run. The previous mount effect read `getTransferIdFromUrl()`, but `sidepanel.html` is static with no query string, so it always early-returned before sending READY.
- Refactor transfer-handling code into a single shared helper `processIncomingViewTransfer(transfer, trigger)` in App.jsx, fed from three entry paths:
 - **A. `standalone-url-mount`** — popup mounts with `?transferId=…` (URL contract preserved; no change for popup-side flow).
 - **B. `sidepanel-mount`** — read `activeViewTransfer` from storage on Side Panel mount, no URL id required.
 - **C. `session-onchanged`** — `chrome.storage.session.onChanged` listener registered only when `surfaceMode === "sidepanel"`, filtering on `ACTIVE_VIEW_TRANSFER_KEY` and `targetMode === "sidepanel"`.
- Duplicate handling: `processingTransferIdsRef` + `completedTransferIdsRef` gate re-entry, plus `updateActiveViewTransfer` re-checks storage status before committing. READY is only sent AFTER ownership + snapshot restore complete.
- Validation gates in `processIncomingViewTransfer`: transferId non-empty string; not already processing/completed; `transfer.targetMode === surfaceMode`; `status` in {`waiting-target`, `target-restoring`}; `pendingViewSnapshot.transferId` matches (when present); `chrome.windows.getCurrent().id === transfer.originWindowId` (sidepanel only).
- `src/utils/viewMode.js`: export `STANDALONE`, `SIDEPANEL` constants (previously module-private).
- Build: sidepanel JS 517.16 → 516.75 kB (gzip 114.35 → 114.08 kB). Diagnostic log markers trimmed to the production-grade set: `TRANSFER_DETECTED`, `TRANSFER_DUPLICATE_SKIPPED`, `OWNERSHIP_ACQUIRED`, `SNAPSHOT_APPLIED`, `SENDING_READY`, `READY_SENT`, `TRANSFER_ERROR`.
- BG_BUILD_ID: `pin-back-sidepanel-fix-20260714-004`.

### v1.1.7-hotfix (2026-07-14)
- Pin back: popup window did not self-close after SIDEPANEL_READY.
 - Root cause: `handlePinBackToSidePanel` in App.jsx read `popupWindowId` from session storage AFTER READY. Session state could already be cleared/overwritten, or message handler fails silently.
 - Fix 1 — `handlePinBackToSidePanel` (App.jsx): capture `popupWindowId` at the START of pin back via `chrome.windows.getCurrent()`. Stash in local const for the whole flow. Use it instead of session read.
 - Fix 2 — `closeStandalonePopup(windowId, sender)` (background.js): resolve target via chain `message.standaloneWindowId → sender.tab.windowId → stored session`. Read `originWindowId` from session. Validate `target !== originWindowId`. `chrome.windows.get(target)` to check existence. Verify `win.type === 'popup'`. Only then call `chrome.windows.remove(target)`. Return `{ ok, removedWindowId }` or `{ ok: false, error }`.
 - Fix 3 — `player/close-standalone-popup` handler now passes `sender` and wraps execution in try/catch.
 - Added UI logs `[PIN_BACK] START / SIDEPANEL_READY / CLOSE_RESULT / TIMEOUT` and SW logs `[SW] CLOSE_STANDALONE_POPUP / POPUP_REMOVED`.
 - Cleanup ordering preserved: `chrome.windows.remove` first; `chrome.windows.onRemoved` cleans session state only on real removal.
 - Build OK: sidepanel-*.js 506.01 → 507.60 kB (gzip 112.38 → 112.66 kB); CSS unchanged.

### v1.1.7 (2026-07-13)
- Standalone: migrated from `chrome.tabs.create` (regular tab) to `chrome.windows.create({ type: 'popup' })` — OS-native popup window with no URL bar, no tab strip.
 - `openStandalonePopup` in background.js calculates popup bounds: 88% of origin window, min 1000×680, centered.
 - `originWindowId` captured before popup creation (via `chrome.windows.getCurrent()`).
 - `svdmusic.standaloneWindowId` is the primary tracker (replacing `standaloneTabId`).
 - `svdmusic.standaloneTabId` still stored for the child tab id within the popup.
 - Duplicate popup guard: checks `svdmusic.standaloneWindowId` + `chrome.windows.get()` before creating a new popup.
 - Detach flow: Side Panel → popup via SW message `player/standalone-opened` → `chrome.windows.create`. After `STANDALONE_READY` with matching `transferId`, Side Panel closed via `chrome.sidePanel.close({ windowId: originWindowId })`.
 - Pin back flow: popup → Side Panel via `chrome.sidePanel.open({ windowId: originWindowId })` in user gesture. After `SIDEPANEL_READY`, popup closed via `player/close-standalone-popup` → `chrome.windows.remove(popupWindowId)`.
 - `chrome.windows.onRemoved` listener cleans up all popup session metadata; no auto-reopen when user closes popup via OS X button.
 - `src/App.jsx`: `isPopupSurface = detectPopupSurface()`, root class `svdmusic-surface-popup`, duplicate-guard updated, `player/close-standalone-popup` message, mount READY payloads include window IDs.
 - `src/utils/viewMode.js`: added `SURFACE_QUERY_KEY`, `POPUP_SURFACE`, `detectPopupSurface()`, `STANDALONE_WINDOW_ID_KEY`, `POPUP_BOUNDS_KEY`, `standaloneWindowId` in `createViewTransfer()`.
 - `src/styles.css` (appended): popup CSS rules for `html/body { overflow: hidden }`, `#root`, `.appShell.svdmusic-surface-popup`, `.pageGrid`, `.songList`.
 - Standalone URL now includes `surface=popup` query param for surface detection.
 - Manifest bumped 1.1.6 → 1.1.7; permissions unchanged.
 - Build output: `dist/assets/sidepanel-*.css` 138.65 kB (gzip 28.66 kB); `dist/assets/sidepanel-*.js` 506.01 kB (gzip 112.38 kB).

### v1.1.6 (2026-07-13)
- Add sidepanel ↔ standalone view-mode (open player in a regular Chrome tab and pin it back to the Side Panel)
 - New `Maximize2` / `Pin` button in `.topBarActions`, next to the library badge, with proper tooltip + aria-label
 - Standalone URL: `chrome.runtime.getURL('sidepanel.html?view=standalone')` — same React tree, detected via `?view=standalone`
 - Audio ownership via `BroadcastChannel('svdmusic-player-view')` between the two contexts:
   - `view-ready`, `ownership-handoff`, `view-closing` messages
   - Only the owner may call `audio.play()` (gate added to `playAudio()`)
   - New view does not autoplay on mount; it waits for the snapshot the prior owner hands off
 - New files: `src/utils/viewMode.js`, `src/components/ViewModeButton.jsx`, `src/components/ViewModeToast.jsx`
 - SW plumbing (already present in v1.1.5): `player/standalone-opened`, `player/sidepanel-open`, `player/sidepanel-close`, `player/close-standalone-tab`, `player/standalone-closed`
 - Duplicate-tab guard: before `chrome.tabs.create`, queries for an existing standalone tab and focuses it
 - Snapshot persists to `playbackSessionStorage` (v2 schema) so the receiving side can recover even if the BroadcastChannel handshake fails
 - Root class `svdmusic-view-sidepanel` / `svdmusic-view-standalone` so CSS can drop the 1480px cap on the standalone surface
 - Toast for the failure cases (chrome.tabs.create failed, sidePanel.open failed) — no silent failures
 - Manifest permissions unchanged (sidePanel + tabs already declared)
 - Build output: `dist/assets/sidepanel-*.js` 470 → 488.64 kB (gzip 100 → 109.45 kB); CSS 125.09 → 136.63 kB (gzip 24.83 → 28.11 kB)

### v1.1.5 (2026-07-02)
- Comprehensive responsive CSS layer added at the END of `src/styles.css`
 - Fluid typography: `html { font-size: clamp(13px, 0.45vw + 11px, 17px) }` — every rem-based size scales smoothly between 320px and 1600px+
 - Fluid spacing: `clamp()` on padding, gaps, discWrap, lyricsLine, playerBar, miniCover, etc.
 - Breakpoint sweep: 1600 / 1280 / 1024 / 900 / 768 / 640 / 480 / 360 / 320 px
 - Special handling:
   - 4K cap (2400px): max type 18px, pageGrid max-width 1680px, discWrap 440px
   - Landscape phones (max-height: 480px): lyricsPanel + discWrap shrink to fit
   - Safe-area insets for notched iOS/Android devices
   - `100dvh` for shell and lyricsPanel — fixes mobile browser chrome resizing
   - `min-width: 280px` on `.appShell` — prevents accidental collapse if side panel is dragged to ~280px
 - Existing 1040 / 720 / 480 / 400 component-specific media queries are preserved; this new layer smooths the gaps between them and fixes tiny-side-panel edge cases
 - Build output: `dist/assets/sidepanel-*.css` grew from 110.93 kB → 125.09 kB (gzip 21.56 → 24.83 kB)

### Workflow
- **Sau khi update version trong manifest.json → tự động chạy `npm run build`** (không cần user nhắc)

### v1.1.5 (2026-07-02)
- Restrict `max-width: 1480px` chỉ áp dụng cho `.pageGrid.view-list`
 - Trước đó `.pageGrid` chính có `max-width: 1480px` + `@media (min-width: 1600px) { .pageGrid { max-width: 1480px } }` + `@media (min-width: 2200px) { .pageGrid { max-width: 1680px } }`
 - View-lyrics bị cap 1480/1680 ở viewport lớn → disc và lyrics stage bị bó hẹp trong khi stage có rule max-width riêng (1320/1520) ổn rồi
 - Bỏ max-width khỏi `.pageGrid` chính + xóa hẳn 2 @media `.pageGrid` ở ≥1600/2200
 - Move `max-width: 1480px` sang `.pageGrid.view-list` để giữ centered cap cho list view (where list có thể span to)
 - Lyrics view giờ full-width viewport, chỉ `.lyricsStage` còn cap 1320/1520 ở ≥1600/2200
 - Không ảnh hưởng rule `.lyricsPanel` clamp height đã move sang `.pageGrid.view-list .lyricsPanel` ở v1.1.4

### v1.1.4 (2026-06-30)
- Fix: loại bỏ hoàn toàn `navigator.geolocation` (đã được thay bằng IP geolocation)
  - Trước đó WeatherWidget gọi `navigator.geolocation.getCurrentPosition()` — W3C Geolocation API
    này, dù đã có fallback DEFAULT_CITY, vẫn trigger Chrome warning "Is the 'geolocation' permission
    appropriate?" mỗi lần extension khởi động vì các Chrome extension scanner xem bất kỳ tham
    chiếu nào tới `geolocation` như dấu hiệu permission không phù hợp với extension scope
  - Thay thế bằng `ipapi.co/json/` (free, không cần API key, không cần permission prompt)
    qua fetch — extension hoàn toàn không touch W3C Geolocation API
  - Flow: IP lookup (6s timeout) → coords thì gọi Open-Meteo by coords + label "City, Country";
    fail thì fallback DEFAULT_CITY = "Ho Chi Minh City"
  - Thêm `https://ipapi.co/*` vào `host_permissions`
  - Lint-friendly hơn: geolocation keyword chỉ còn xuất hiện trong file doc/service description,
    không còn trong runtime code

### v1.1.3 (2026-06-30)
- Fix triệt để: bấm Play khi đang ở view "list" → bấm micButton quay lại "lyrics" → đĩa vẫn không quay
  - Root cause: khi user bấm Play ở view list, `.discWrap` chưa có trong DOM → `startBassReactiveCover` early-return → `bassAnalyser` không bao giờ được tạo
  - Khi user bấm micButton quay lại lyrics, `.discWrap` mới được mount nhưng không có gì re-trigger start → đĩa đứng yên
  - Thêm `MutationObserver` theo dõi `.discWrap` xuất hiện trong DOM → tự retry `startBassReactiveCover` ngay khi lyrics panel mount xong
  - `loop()` cũng thêm defensive branch: nếu `!bassAnalyser` + `bassCurrentAudio` đang play + `.discWrap` có → retry start
  - Theo dõi `bassCurrentAudio` để biết audio element nào cần setup lại
  - `disposeBassReactiveCover` cũng teardown observer

### v1.1.2 (2026-06-30)
- Fix bug: chuyển view bằng micButton (lyrics ↔ list) làm đĩa đứng yên khi quay lại lyrics
  - `.discWrap` chỉ mount trong view "lyrics"; khi toggle sang "list" thì DOM node cũ bị detach
  - `bassDiscWrap` cache node cũ đã detached, nên mọi `setProperty` không còn áp dụng lên DOM → đĩa mới trông như "đứng yên"
  - Thêm `resolveDiscWrap()` self-heal mỗi frame trong `loop()` + dùng lại trong `pause`/`resume`
  - Khi DOM node `.discWrap` hiện tại bị detach → tự `querySelector` lại node mới (chỉ query khi cần, không phải mỗi frame)

### v1.1.1 (2026-06-30)
- Fix bug: đĩa vẫn quay sau khi bấm Pause
  - Thêm `pauseBassReactiveCover()` / `resumeBassReactiveCover()` trong `src/utils/bassReactiveCover.js`
  - `handlePauseEvent` giờ gọi `pauseBassReactiveCover()` (cancel RAF + reset --bass/--avatar-pulse về 0, giữ nguyên `--disc-rotate-angle` để đĩa freeze đúng góc hiện tại)
  - `handlePlayEvent` đổi từ `startBassReactiveCover` sang `resumeBassReactiveCover` (fallback về start nếu loop chưa từng setup)
  - Triệu chứng "click WeatherWidget thì đĩa dừng" là coincidence: geolocation prompt block main thread → RAF không tick → đĩa nhìn như đứng yên. Không cần fix code ở widget.

### v1.0.17 (2026-06-26)
- Fix bug: click bài #2 nhưng nhạc vẫn phát bài #1
  - `initSynth`/`playAudio` nhận song object trực tiếp thay vì rely on closure
  - Fix `selectSong`, `playByDirection`, `handleSongEnd`

### v1.0.7 (2026-06-26)
- Đổi hoàn toàn sang **position: absolute** cho layout (thay grid/flex)
- topBar: `top: 0; height: 62px`
- pageGrid: `top: 62px; bottom: 83px` (fill giữa)
- playerBar: `bottom: 0; height: 83px`
- Fix duplicate `.topBar` và `.playerBar` rules trong styles.css
- Bỏ `flex: 1` khỏi `.pageGrid` (không cần khi dùng absolute)
- Tăng manifest `default_height` lên 1500px

### v1.0.4 (2026-06-26)
- Fix playerBar bị cắt mất trong popup Chrome extension
- Thay flex layout bằng grid layout trong `.appShell`:
  - `grid-template-rows: 62px 1fr 83px` (topBar / pageGrid / playerBar)
- Thêm CSS rule cho `.lyricsBox` (bị thiếu, gây overflow không scroll)
- Bỏ `min-height: 100%` trên `.lyricsTrack` (đẩy track cao bất thường)
- Thay `height: 100%` bằng `flex: 1` trên `.lyricsBox` để flex chain đúng
- Tăng manifest `default_height` lên 1500px
- Reload unpacked extension sau mỗi build

### v1.0.3
- (before v1.0.4)

### v1.0.2
- (before v1.0.3)

### v1.0.1
- (before v1.0.2)

## Known Issues
- Extension reload: Chrome cache có thể giữ file cũ. Sau khi load unpacked, bấm F5 trong popup hoặc tắt/mở lại extension.

## Build Commands
```bash
cd svdmusic-extension
npm run build
```
Build output: `dist/` folder, load unpacked tại `dist/` trong Chrome.
