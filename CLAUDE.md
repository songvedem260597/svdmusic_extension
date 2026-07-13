# SVD Music Extension - Development Notes
## Extension Info
- Name: SVD Music Player
- Extension ID: oeaflhcgbcnppfldjdcmldkikokkiddc
- Manifest Version: 3

## Version Changelog

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
