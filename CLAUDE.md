# SVD Music Extension - Development Notes

## Extension Info
- Name: SVD Music Player
- Extension ID: oeaflhcgbcnppfldjdcmldkikokkiddc
- Manifest Version: 3

## Version Changelog

### Workflow
- **Sau khi update version trong manifest.json → tự động chạy `npm run build`** (không cần user nhắc)

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
