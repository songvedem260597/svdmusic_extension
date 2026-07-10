// Content script running on https://gemini.google.com/*.
//
// Responsibilities:
//   1. Detect whether the user is signed in (sign-in button visible? URL
//      contains /signin or /signedout? chat composer missing?).
//   2. Insert the requested prompt into Gemini's composer.
//   3. Select model "3.1 Pro" and thinking level "Mở rộng" via text-based
//      matching (Gemini changes its class names often).
//   4. Submit and watch the DOM for either an .lrc attachment or inline LRC
//      text matching the [mm:ss.xx] format.
//   5. Forward all progress + results to the background worker so the
//      sidepanel can react.
//
// All selectors fall back to ARIA / role / textContent. If a step fails we
// report a precise error rather than guessing another model.
//
// Locking:
//   - We open a long-lived Port ("svdmusic.gemini.content") to the
//     background service worker on startup and announce our jobId. The
//     background keeps at most ONE content-script port per jobId; any
//     duplicate injection is told to bail immediately. This is what kills
//     duplicate-log spam.
//   - Each `send()` is a `chrome.runtime.sendMessage` to the background; the
//     background's port registry then forwards the message to the
//     sidepanel. We never publish progress if our port was rejected.

(() => {
  // Single-instance guard: when Chrome re-injects the content script
  // (extension reload, lazy injection on a rehydrated tab, debugging),
  // it runs this IIFE again. Without an early bail, two scripts race on
  // `acquireTabLock` and both can claim it (sessionStorage write isn't
  // atomic with the read inside `acquireTabLock`), which then produces
  // duplicate progress logs ("Đang chèn prompt..." appears twice) and
  // double-injected prompts. We mark the window on the very first line
  // so any re-entry aborts before touching DOM, port, or background.
  const INSTANCE_KEY = "__svdmusicGeminiContentInited";
  if (typeof window !== "undefined" && window[INSTANCE_KEY]) {
    console.log("[gemini-lrc] DUPLICATE_INJECTION_DETECTED — bailing before any side effect.");
    return;
  }
  if (typeof window !== "undefined") {
    try { window[INSTANCE_KEY] = true; } catch (_) { /* sandboxed — fall through */ }
  }

  const TAB_LOCK_KEY = "svdmusic_gemini_tab_lock";
  const TAB_LOCK_TTL_MS = 10 * 60 * 1000;

  const MY_TAB_LOCK_ID =
    (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
    `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  let CURRENT_JOB_ID = null;
  // Tracked by reportLrcReady so cleanupLog / cleanupProgress can attach
  // the right correlationId to its forwarded progress message — without
  // this, the sidepanel's MP3 listener (which filters by correlationId)
  // would silently drop every "[GeminiCleanup] ..." line we forward.
  let CURRENT_CORRELATION_ID = null;
  let PORT_ALLOWED = false;
  let backgroundPort = null;

  function openBackgroundPort(jobId) {
    try {
      if (backgroundPort) {
        try { backgroundPort.disconnect(); } catch (_) { /* noop */ }
      }
      const port = chrome.runtime.connect({ name: "svdmusic.gemini.content" });
      backgroundPort = port;
      port.onMessage.addListener((msg) => {
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "svdmusic/bail") {
          console.log("[gemini-lrc] BACKGROUND_BAIL", msg.reason || "?");
          PORT_ALLOWED = false;
        } else if (msg.type === "svdmusic/welcome") {
          PORT_ALLOWED = true;
          console.log("[gemini-lrc] PORT_WELCOME jobId=" + msg.jobId);
        }
      });
      port.onDisconnect.addListener(() => {
        console.log("[gemini-lrc] PORT_DISCONNECTED");
        backgroundPort = null;
        PORT_ALLOWED = false;
      });
      port.postMessage({ type: "svdmusic/hello", jobId });
    } catch (error) {
      console.warn("[gemini-lrc] connect background failed", error);
      backgroundPort = null;
      PORT_ALLOWED = false;
    }
  }

  function readTabLock() {
    try {
      const raw = sessionStorage.getItem(TAB_LOCK_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function writeTabLock(id, jobId) {
    try {
      sessionStorage.setItem(
        TAB_LOCK_KEY,
        JSON.stringify({ id, jobId, startedAt: Date.now() })
      );
    } catch (_) { /* noop */ }
  }

  function clearTabLock(id) {
    try {
      const lock = readTabLock();
      if (!lock || lock.id === id) {
        sessionStorage.removeItem(TAB_LOCK_KEY);
      }
    } catch (_) { /* noop */ }
  }

  function acquireTabLock(jobId) {
    const existing = readTabLock();
    const now = Date.now();
    // A lock that's still alive means another instance is running. We bail
    // regardless of jobId — same jobId re-injection is also rejected because
    // the existing instance is the one holding the port and must finish
    // before a second one starts (otherwise we get duplicate-log spam).
    if (existing && now - existing.startedAt < TAB_LOCK_TTL_MS) {
      console.log(
        `[gemini-lrc] TAB_LOCK_EXISTS existing=${existing.jobId} new=${jobId || "(none)"} — exiting.`
      );
      CURRENT_JOB_ID = existing.jobId || null;
      return false;
    }
    // Stale or absent — claim it.
    writeTabLock(MY_TAB_LOCK_ID, jobId || null);
    CURRENT_JOB_ID = jobId || null;
    return true;
  }

  // ── Constants ────────────────────────────────────────────────────────────────
  const MODEL_NEEDLE = /3\.1\s*pro|pro/i;
  const THINKING_NEEDLE = /mở\s*rộng|deep\s*research|thinking\s*level|mức\s*độ\s*tư\s*duy/i;
  // Accepts both:
  //   [mm:ss.xx]   (mm part optional capture, falls back to mm)
  //   [hh:mm:ss.xx]
  // Group 1 = optional hh, Group 2 = mm, Group 3 = ss, Group 4 = .xx|.xxx|:xx|:xxx
  const LRC_TIME_REGEX = /\[(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})([.:]\d{1,3})?\]/;
  const LRC_FILE_NEEDLE = /\.lrc(\b|$)/i;

  // Tokens that indicate Gemini is still actively producing output. We must
  // NOT extract LRC while any of these are visible.
  const IN_PROGRESS_TOKENS = [
    "verifying transcript accuracy",
    "đang xác minh",
    "đang xác thực",
    "generating",
    "đang tạo",
    "thinking",
    "đang suy nghĩ",
    "stop",
    "dừng",
    "stop generating",
    "loading",
    "đang tải",
  ];

  const RESPONSE_STABLE_MS = 7000; // require text unchanged for ≥7s
  const RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;
  const MIN_TIMESTAMP_LINES = 10;

  const COMPOSER_SELECTORS = [
    "div.ql-editor[contenteditable=\"true\"]",
    "div[contenteditable=\"true\"][data-placeholder*=\"hỏi\" i]",
    "div[contenteditable=\"true\"][data-placeholder*=\"ask\" i]",
    "div[contenteditable=\"true\"][aria-label*=\"câu lệnh\" i]",
    "div[contenteditable=\"true\"][aria-label*=\"prompt\" i]",
    "div[contenteditable=\"true\"][aria-label*=\"ask\" i]",
    "div[contenteditable=\"true\"][role=\"textbox\"]",
    "textarea",
  ];

  const activeJobs = new Map(); // correlationId -> { cancelled, observer, timeout }

  // ── Utilities ────────────────────────────────────────────────────────────────
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Deep query that pierces open shadow DOM. Returns an array of every node
  // that matches `selector`, walking both light-tree descendants and every
  // shadow root we encounter. Useful because Gemini wraps interactive bits
  // (open-button, file chips, etc.) inside custom elements with shadow
  // roots, so a plain element.querySelector("open-button") misses them.
  function deepQueryAll(root, selector) {
    const out = [];
    if (!root || typeof root.querySelectorAll !== "function") return out;

    const visit = (node) => {
      try {
        const matches = node.querySelectorAll(selector);
        for (let i = 0; i < matches.length; i += 1) out.push(matches[i]);
      } catch (_) { /* selector invalid on this node */ }

      // Recurse into shadow roots. Query them instead of just walking
      // .children because a node may have a shadowRoot but no light-tree
      // children, and we want to find both.
      const findShadows = (n) => {
        if (!n) return;
        if (n.shadowRoot) visit(n.shadowRoot);
        const kids = n.children || n.childNodes || [];
        for (let i = 0; i < kids.length; i += 1) findShadows(kids[i]);
      };
      findShadows(node);
    };

    visit(root);
    return out;
  }

  function deepQuerySelector(root, selector) {
    const all = deepQueryAll(root, selector);
    return all.length > 0 ? all[0] : null;
  }

  function send(message) {
    // Drop every message from this content-script instance if the
    // background has marked us as a duplicate injection. The user only sees
    // logs from the "winning" port.
    if (backgroundPort && !PORT_ALLOWED) {
      return;
    }
    try {
      const tagged = { ...message, jobId: CURRENT_JOB_ID || message.jobId || null };
      chrome.runtime.sendMessage(tagged, () => {
        void chrome.runtime?.lastError;
      });
    } catch (error) {
      console.warn("[gemini-lrc] sendMessage failed", error);
    }
  }

  function log(...args) {
    const prefix = "[gemini-lrc" + (CURRENT_JOB_ID ? ":" + CURRENT_JOB_ID : "") + "]";
    console.log(prefix, ...args);
  }

  function reportError(correlationId, message) {
    send({ type: "error", correlationId, payload: { message } });
  }

  function reportProgress(correlationId, payload) {
    send({ type: "progress", correlationId, payload });
  }

  function reportLrcReady(correlationId, payload) {
    CURRENT_CORRELATION_ID = correlationId || null;
    send({ type: "lrc-ready", correlationId, payload });
    // Schedule cleanup so it doesn't block the LRC-ready message being sent.
    // 500ms is enough for the Drive viewer iframe to settle without giving
    // the Gemini tab time to navigate away. The cleanup function itself
    // installs the navigation guard before clicking anything, so even if
    // Gemini tries to navigate mid-cleanup we keep the tab on Gemini.
    setTimeout(() => {
      cleanupGeminiConversationAfterLrc().catch((err) => {
        cleanupLog("failed:", err && err.message ? err.message : err);
      });
    }, 500);
  }

  // ── Gemini conversation cleanup (best-effort, post-LRC) ─────────────────
  //
  // Sau khi đã mở file LRC từ Gemini, đọc viewer/text URL, parse/validate,
  // và emit lrc-ready, ta muốn xoá cuộc trò chuyện vừa rồi để:
  //   - Tránh state cũ (composer/prompt/model selection) dính vào phiên
  //     kế tiếp.
  //   - Không reuse tab Gemini (mỗi "Tạo bài hát" → tab mới) vẫn có thể
  //     được nhưng nếu vì lý do gì đó user giữ tab cũ thì nó vẫn sạch.
  //
  // Best-effort: mọi bước đều try/catch, lỗi chỉ log warning.
  // Không đồng bộ hoá với job lock — chạy nền xong lúc nào hay lúc đó.

  let CLEANUP_RUNNING_FOR = null;

  // ── Target conversation tracking ────────────────────────────────────────────
  // Captured right after the prompt is successfully sent (or as soon as
  // Gemini navigates to /app/<conversationId>). Cleanup MUST only operate
  // on this exact conversation; any mismatch with the current URL aborts.
  let TARGET_CONVERSATION_ID = "";
  let TARGET_CONVERSATION_URL = "";

  // Delete-once guard. Even if some helper retries internally, the outer
  // delete/confirm clicks each fire at most once per cleanup run.
  const cleanupDeleteState = {
    attempted: false,
    confirmed: false,
  };

  function extractGeminiConversationId(url) {
    const match = String(url || "").match(/\/app\/([^/?#]+)/);
    return match ? match[1] : "";
  }

  // Collapse whitespace; Gemini's menu DOM sometimes repeats the label
  // ("Xoá Xoá") which previously caused our label regex to fail.
  function normalizeMenuLabel(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    const parts = value.split(" ");

    if (parts.length === 2 && parts[0].toLowerCase() === parts[1].toLowerCase()) {
      return parts[0];
    }

    const half = Math.floor(parts.length / 2);
    if (
      parts.length % 2 === 0 &&
      parts.slice(0, half).join(" ").toLowerCase() === parts.slice(half).join(" ").toLowerCase()
    ) {
      return parts.slice(0, half).join(" ");
    }

    return value;
  }

  function getMenuItemLabel(el) {
    if (!el) return "";
    const raw =
      el.getAttribute?.("aria-label") ||
      el.getAttribute?.("title") ||
      el.innerText ||
      el.textContent ||
      "";
    return normalizeMenuLabel(raw);
  }

  function isDeleteMenuItem(el) {
    const label = getMenuItemLabel(el);
    return /^(Xoá|Xóa|Delete|Remove)$/i.test(label);
  }

  function isCancelMenuItem(el) {
    const label = getMenuItemLabel(el);
    return /^(Huỷ|Hủy|Cancel|Không|No)$/i.test(label);
  }

  function captureTargetConversation(reason) {
    const url = window.location.href || "";
    const id = extractGeminiConversationId(url);
    TARGET_CONVERSATION_URL = url;
    TARGET_CONVERSATION_ID = id;
    cleanupLog(
      "target conversation id captured: " + (id || "(none yet)") +
        " reason=" + (reason || "?") +
        " url=" + url.slice(0, 120)
    );
    return id;
  }

  // Polls window.location.href until extractGeminiConversationId returns a
  // non-empty string, or the timeout elapses. Used right after clickSend
  // because Gemini may keep the URL on /app until the response starts.
  async function waitForConversationIdFromUrl(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const id = extractGeminiConversationId(window.location.href || "");
      if (id) return id;
      await cleanupSleep(150);
    }
    return "";
  }

  function cleanupLog(...args) {
    const prefix = "[GeminiCleanup" + (CURRENT_JOB_ID ? ":" + CURRENT_JOB_ID : "") + "]";
    console.log(prefix, ...args);
    // Forward to sidepanel so user sees cleanup progress in the Add Song modal.
    // The background's progress forwarder (background.js) only delivers when
    // `sender.tab.url` is still a Gemini URL — by the time we run cleanup the
    // tab may already have navigated, so each forward is best-effort.
    try {
      const line = args.map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch (_) { return String(a); } })())).join(" ");
      chrome.runtime.sendMessage({
        type: "progress",
        correlationId: CURRENT_CORRELATION_ID || null,
        jobId: CURRENT_JOB_ID || null,
        payload: { message: prefix + " " + line, cleanup: true },
      }, () => { void chrome.runtime?.lastError; });
    } catch (_) { /* tab navigated — fallback to console */ }
  }

  // ── Navigation guard: keep the original Gemini tab on gemini.google.com ──
  //
  // Some Gemini UI flows (clicking the file card to preview the generated
  // LRC) navigate the tab to https://drive.google.com/viewer/text?id=...
  // which destroys the content script (manifest matches only
  // gemini.google.com). If we let that navigation happen, the cleanup
  // message can never reach the content script — the sidepanel sends
  // `svdmusic/cleanup-conversation`, background dispatches it, but the
  // receiving end no longer exists.
  //
  // Strategy: cancel every programmatic navigation away from Gemini while
  // the LRC reader is fetching the Drive viewer payload. The XHR/fetch
  // request to drive.google.com itself is a SEPARATE connection and is
  // not affected — `performance.getEntriesByType("resource")` still
  // captures it, so the LRC read works.
  //
  // We use TWO mechanisms:
  //   1. Capture-phase `click`/`auxclick` listener that calls
  //      `event.preventDefault()` on anchor clicks whose href leaves
  //      Gemini. This cancels the browser's default navigation before
  //      Gemini's handler can fire any `location.href = ...` chain.
  //   2. `beforeunload` listener that calls `preventDefault()` to abort
  //      programmatic navigation. We do NOT set `event.returnValue` —
  //      without it Chrome cancels the navigation silently (no "Leave
  //      site?" dialog), because programmatic `window.location.href`
  //      changes are not user-initiated.
  let NAV_GUARD_INSTALLED = false;
  let NAV_GUARD_BLOCKED = 0;
  function cleanupNavGuardShouldBlockNavigation(urlString) {
    if (!urlString || typeof urlString !== "string") return false;
    if (urlString === "#" || urlString.startsWith("#") || urlString.startsWith("javascript:")) return false;
    try {
      const u = new URL(urlString, window.location.href);
      if (/^gemini\.google\.com$/i.test(u.hostname)) return false;
      return true;
    } catch (_) {
      return false;
    }
  }
  function cleanupNavGuardClickHandler(event) {
    try {
      // Only intercept clicks that would navigate the top-level page away
      // from Gemini. We don't touch clicks whose target is a Gemini URL or
      // which have no href (button / div) — those are how Gemini loads its
      // own preview UI without navigating the tab.
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      const anchor = target.closest("a[href], area[href], form[action]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") || anchor.getAttribute("action") || "";
      if (!cleanupNavGuardShouldBlockNavigation(href)) return;
      // Cancel default navigation but DO let any JS handlers run — we
      // still need Gemini's preview logic to fire its XHR/fetch so
      // performance.getEntriesByType("resource") captures the viewer URL.
      event.preventDefault();
      NAV_GUARD_BLOCKED += 1;
      cleanupLog("blocked cross-origin click default href=" + href.slice(0, 120));
    } catch (_) { /* noop */ }
  }
  function cleanupNavGuardBeforeUnloadHandler(event) {
    // Programmatic navigation (e.g. `window.location.href = ...` from
    // Gemini's click handler). Cancel silently — we do NOT set
    // event.returnValue so Chrome does not show a "Leave site?" dialog.
    try {
      event.preventDefault();
      event.stopPropagation();
    } catch (_) { /* noop */ }
    NAV_GUARD_BLOCKED += 1;
    cleanupLog("beforeunload fired (programmatic nav attempt — cancelled)");
  }
  function cleanupNavGuardInstall() {
    if (NAV_GUARD_INSTALLED) return;
    NAV_GUARD_INSTALLED = true;
    NAV_GUARD_BLOCKED = 0;
    try { window.addEventListener("click", cleanupNavGuardClickHandler, true); } catch (_) { /* noop */ }
    try { window.addEventListener("auxclick", cleanupNavGuardClickHandler, true); } catch (_) { /* noop */ }
    try { window.addEventListener("beforeunload", cleanupNavGuardBeforeUnloadHandler); } catch (_) { /* noop */ }
    cleanupLog("nav-guard installed (block cross-origin top-level navigation)");
  }
  function cleanupNavGuardRemove(reason) {
    if (!NAV_GUARD_INSTALLED) return;
    NAV_GUARD_INSTALLED = false;
    try { window.removeEventListener("click", cleanupNavGuardClickHandler, true); } catch (_) { /* noop */ }
    try { window.removeEventListener("auxclick", cleanupNavGuardClickHandler, true); } catch (_) { /* noop */ }
    try { window.removeEventListener("beforeunload", cleanupNavGuardBeforeUnloadHandler); } catch (_) { /* noop */ }
    cleanupLog("nav-guard removed reason=" + (reason || "done") + " blockedCount=" + NAV_GUARD_BLOCKED);
  }

  function cleanupNormalize(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function cleanupSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Uses the same event dispatch strategy as the main `realClick` function.
  // Gemini's CDK overlay elements don't respond reliably to direct
  // dispatchEvent on the element — elementFromPoint resolves the actual
  // hit target at the centre of the element's bounding rect, which is
  // what a real user click would target.
  function cleanupRealClick(el) {
    if (!el) return false;
    try {
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      // Resolve the actual hit target at the click coordinates.
      let target = el;
      try {
        target = document.elementFromPoint(x, y) || el;
      } catch (_) { /* sandboxed — fall through to el */ }
      const eventTypes = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
      for (const type of eventTypes) {
        try {
          target.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: x,
            clientY: y,
            button: 0,
          }));
        } catch (_) { /* noop */ }
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  // ── New top-menu cleanup helpers ────────────────────────────────────────────
  // The previous flow (open sidebar → hover row → click row menu → Xoá) was
  // flaky and failed at "step fail: sidebar không mở được". Console-tested
  // flow: top-right current-conversation action menu → menu item "Xoá" →
  // confirm "Xoá".

  // Normalize whitespace-only text from any source.
  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Collect every available text source on an element and merge into a
  // single normalized string. Order matters: aria-label/title first so
  // icon-only buttons (no innerText) still match by their accessible name.
  function getElementText(el) {
    if (!el) return "";
    return normalizeText(
      [
        el.getAttribute && el.getAttribute("aria-label"),
        el.getAttribute && el.getAttribute("title"),
        el.innerText,
        el.textContent,
      ]
        .filter(Boolean)
        .join(" ")
    );
  }

  function realClick(el) {
    if (!el) return false;
    try {
      el.scrollIntoView?.({ block: "center", inline: "center" });
    } catch (_) { /* noop */ }
    try {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      let target = el;
      try {
        target = document.elementFromPoint(x, y) || el;
      } catch (_) { /* sandboxed — fall through to el */ }
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        try {
          target.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: x,
            clientY: y,
            button: 0,
          }));
        } catch (_) { /* noop */ }
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  // waitFor(fn, timeoutMs, intervalMs) — polls fn() until it returns truthy
  // or the timeout elapses. Returns the truthy value or null on timeout.
  async function waitFor(fn, timeoutMs, intervalMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let v = null;
      try { v = fn(); } catch (_) { v = null; }
      if (v) return v;
      await cleanupSleep(intervalMs);
    }
    return null;
  }

  // ── Semantic text/aria-label matchers (no rect/position dependencies) ─────

  // Returns { el, text, match } or null.
  // 3-tier fallback:
  //   1. exact Vietnamese aria ("Mở trình đơn thao tác đối với cuộc trò chuyện")
  //   2. English semantic ("conversation" + "action/menu/options/more")
  //   3. Vietnamese semantic ("cuộc trò chuyện" + "trình đơn/thao tác/tuỳ chọn/tùy chọn")
  function findCurrentConversationActionMenuButton() {
    const buttons = Array.from(
      document.querySelectorAll("button, [role='button']")
    ).filter(isVisible);

    const exact = buttons.find((el) => {
      const text = getElementText(el);
      return /Mở trình đơn thao tác đối với cuộc trò chuyện/i.test(text);
    });
    if (exact) {
      return { el: exact, text: getElementText(exact), match: "exact-vi" };
    }

    const english = buttons.find((el) => {
      const text = getElementText(el);
      return (
        /conversation/i.test(text) &&
        /(action|actions|menu|options|more)/i.test(text)
      );
    });
    if (english) {
      return { el: english, text: getElementText(english), match: "semantic-en" };
    }

    const viFallback = buttons.find((el) => {
      const text = getElementText(el);
      return (
        /cuộc trò chuyện/i.test(text) &&
        /(trình đơn|thao tác|tuỳ chọn|tùy chọn)/i.test(text)
      );
    });
    if (viFallback) {
      return {
        el: viFallback,
        text: getElementText(viFallback),
        match: "semantic-vi",
      };
    }

    return null;
  }

  // Find the "Xoá" / "Delete" menu item inside an open menu. Scoped to
  // gem-menu-item / role=menuitem / button / role=button — never query
  // div/span broadly. Cancels are explicitly excluded.
  function findDeleteMenuItem() {
    const items = Array.from(
      document.querySelectorAll(
        "gem-menu-item, [role='menuitem'], button, [role='button']"
      )
    ).filter(isVisible);

    const found = items.find((el) => {
      const text = getElementText(el);
      if (/Hủy|Huỷ|Cancel/i.test(text)) return false;
      return /^(Xoá|Xóa|Delete|Remove)\b/i.test(text);
    });

    if (!found) return null;

    // If we matched a wrapper, walk up to the nearest clickable ancestor so
    // the real click lands on the actual button / menu-item.
    const clickable =
      found.closest?.(
        "gem-menu-item,[role='menuitem'],button,[role='button']"
      ) || found;

    return { el: clickable, text: getElementText(clickable) };
  }

  // Find the "Xoá" button INSIDE a confirm dialog. Scoped to dialog roots
  // first — querying the full document would risk clicking a leftover menu
  // item from the previous step. Cancels are explicitly excluded.
  function findConfirmDeleteButton() {
    const dialogRoots = Array.from(
      document.querySelectorAll(
        "[role='dialog'], [aria-modal='true'], mat-dialog-container, .cdk-overlay-pane"
      )
    ).filter(isVisible);

    for (const root of dialogRoots) {
      const buttons = Array.from(
        root.querySelectorAll("button, [role='button']")
      ).filter(isVisible);

      const found = buttons.find((el) => {
        const text = getElementText(el);
        if (/Hủy|Huỷ|Cancel/i.test(text)) return false;
        return /^(Xoá|Xóa|Delete|Remove)\b/i.test(text);
      });

      if (found) {
        return { el: found, text: getElementText(found) };
      }
    }

    return null;
  }

  // Find the "Xoá" / "Delete" menu item inside an OPEN menu. Scoped strictly
// to live CDK overlay / menu ancestors — never the whole document. The
// overlay selector list matches the Material/CDK overlay pane that hosts
// every Gemini menu (top-right, sidebar row, kebab — they all use the
// same overlay container).
function findDeleteMenuItemScopedToOverlay() {
  const overlaySelectors = [
    ".cdk-overlay-pane",
    ".cdk-overlay-container",
    "[role='menu']",
    "[role='listbox']",
    "gem-menu",
    ".mat-mdc-menu-panel",
  ];

  const candidates = [];
  for (const sel of overlaySelectors) {
    try {
      const roots = document.querySelectorAll(sel);
      for (const root of roots) {
        if (!isVisible(root)) continue;
        try {
          const items = root.querySelectorAll(
            "gem-menu-item, [role='menuitem'], [role='option'], .mat-mdc-menu-item, button"
          );
          for (const item of items) {
            if (!isVisible(item)) continue;
            candidates.push(item);
          }
        } catch (_) { /* noop */ }
      }
    } catch (_) { /* noop */ }
  }

  // Sort: prefer items that look exactly like a delete (no icon prefix,
  // normalized label).
  for (const item of candidates) {
    if (isCancelMenuItem(item)) continue;
    if (isDeleteMenuItem(item)) {
      return { el: item, label: getMenuItemLabel(item) };
    }
  }

  return null;
}

// Find the confirm "Xoá" button INSIDE a confirm dialog overlay. Same
// overlay scoping as the menu search.
function findConfirmDeleteButtonScopedToOverlay() {
  const overlaySelectors = [
    ".cdk-overlay-pane",
    ".cdk-overlay-container",
    "[role='dialog']",
    "mat-dialog-container",
    ".mat-mdc-dialog-container",
  ];

  // Required dialog text — only confirm if we see one of these somewhere
  // in the dialog/overlay ancestor text.
  const dialogConfirmVariants = [
    /xoá\s+cuộc\s+trò\s+chuyện/i,
    /xóa\s+cuộc\s+trò\s+chuyện/i,
    /bạn\s+muốn\s+xoá/i,
    /bạn\s+muốn\s+xóa/i,
    /delete\s+this\s+conversation/i,
    /delete\s+conversation/i,
  ];

  for (const sel of overlaySelectors) {
    let roots;
    try { roots = document.querySelectorAll(sel); } catch (_) { continue; }
    for (const root of roots) {
      if (!isVisible(root)) continue;
      const dialogText = (root.innerText || root.textContent || "").trim();
      const matched = dialogConfirmVariants.some((rx) => rx.test(dialogText));
      if (!matched) continue;

      let buttons;
      try { buttons = root.querySelectorAll("button, [role='button']"); } catch (_) { continue; }
      for (const btn of buttons) {
        if (!isVisible(btn)) continue;
        if (isCancelMenuItem(btn)) continue;
        if (isDeleteMenuItem(btn)) {
          return { el: btn, label: getMenuItemLabel(btn) };
        }
      }
    }
  }

  return null;
}

async function deleteCurrentGeminiConversationFromTopMenu() {
  // Reset per-run delete guard.
  cleanupDeleteState.attempted = false;
  cleanupDeleteState.confirmed = false;

  // Pre-flight: only delete if the current URL still points at the target
  // conversation. Mismatch = abort (don't touch any other conversation).
  const currentId = extractGeminiConversationId(window.location.href || "");
  if (!TARGET_CONVERSATION_ID || currentId !== TARGET_CONVERSATION_ID) {
    cleanupLog(
      "abort: current conversation mismatch target=" + (TARGET_CONVERSATION_ID || "(none)") +
        " current=" + (currentId || "(none)")
    );
    return false;
  }
  cleanupLog("verify current conversation id ok: " + currentId);

  cleanupLog("opening current conversation action menu...");

  const menuButton = findCurrentConversationActionMenuButton();

  if (!menuButton || !menuButton.el) {
    cleanupLog("step fail: không tìm thấy nút menu cuộc trò chuyện hiện tại");
    dumpVisibleButtonsForCleanup();
    return false;
  }

  // Open the menu. We do NOT log the menuButton.text as a click target — the
  // exact label here has nothing to do with the delete item label.
  realClick(menuButton.el);

  // Wait for the menu overlay to mount and present a delete item. Single
  // attempt; if it doesn't appear, abort.
  const deleteItem = await waitFor(
    () => findDeleteMenuItemScopedToOverlay(),
    5000,
    200
  );

  if (!deleteItem || !deleteItem.el) {
    cleanupLog("step fail: không tìm thấy menu item Xoá (overlay-scoped)");
    dumpVisibleButtonsForCleanup();
    return false;
  }

  // Once-and-only-once click on delete.
  if (cleanupDeleteState.attempted) {
    cleanupLog("abort: delete already attempted once for this job");
    return false;
  }
  cleanupDeleteState.attempted = true;
  cleanupLog("click top-menu delete item: label=" + (deleteItem.label || "?"));
  realClick(deleteItem.el);

  const confirmBtn = await waitFor(
    () => findConfirmDeleteButtonScopedToOverlay(),
    6000,
    250
  );

  if (!confirmBtn || !confirmBtn.el) {
    cleanupLog("step fail: không tìm thấy nút confirm Xoá (overlay-scoped)");
    dumpVisibleButtonsForCleanup();
    return false;
  }

  cleanupLog("click confirm delete: label=" + (confirmBtn.label || "?"));
  realClick(confirmBtn.el);
  cleanupDeleteState.confirmed = true;

  await cleanupSleep(1200);
  cleanupLog("done ok");
  return true;
}

  function pressEscapeForCleanup() {
    // Dispatch ESC keydown + keyup to every plausible target that might be
    // holding the viewer modal open. Gemini's overlays often trap focus inside
    // a specific element; blasting at activeElement + body + document + window
    // maximizes coverage without knowing which element has the keyboard handler.
    const evtInit = {
      key: "Escape",
      code: "Escape",
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true,
      composed: true,
    };

    const targets = [
      document.activeElement,
      document.body,
      document.documentElement,
      document,
      window,
    ].filter(Boolean);

    for (const target of targets) {
      try {
        target.dispatchEvent(new KeyboardEvent("keydown", evtInit));
        target.dispatchEvent(new KeyboardEvent("keyup", evtInit));
      } catch (_) { /* noop */ }
    }
  }

  async function cleanupPressEscape(times = 2) {
    for (let i = 0; i < times; i += 1) {
      pressEscapeForCleanup();
      await cleanupSleep(350);
    }
  }

  // ── LRC viewer close helpers ────────────────────────────────────────────────

  function isLrcViewerOpen() {
    const url = location.href || "";
    if (/drive\.google\.com|docs\.google\.com/i.test(url)) return true;

    const roots = findDriveViewerRoots();
    if (!roots.length) return false;

    const bodyText = document.body.innerText || "";
    const hasLrcName = /\.lrc/i.test(bodyText);
    const hasViewerToolbar =
      /Tải xuống|Download|Thông tin chi tiết|Print|In|Google Drive|Drive viewer|Open with|Mở bằng|Đang hiển thị người xem/i.test(
        bodyText
      );

    return hasLrcName && hasViewerToolbar;
  }

  function isVisible(el) {
    if (!el) return false;
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  function describeElement(el) {
    if (!el) return "(null)";
    try {
      const tag = el.tagName || "";
      const role = el.getAttribute("role") || "";
      const label = el.getAttribute("aria-label") || "";
      const title = el.getAttribute("title") || "";
      const id = el.id ? "#" + el.id : "";
      const text = (el.innerText || el.textContent || "").slice(0, 40).replace(/\s+/g, " ").trim();
      const r = el.getBoundingClientRect();
      return (
        "<" +
        tag +
        (role ? ' role="' + role + '"' : "") +
        id +
        (label ? ' aria-label="' + label + '"' : "") +
        (title ? ' title="' + title + '"' : "") +
        (text ? ' text="' + text + '"' : "") +
        " rect=" +
        Math.round(r.left) +
        "," +
        Math.round(r.top) +
        " " +
        Math.round(r.width) +
        "x" +
        Math.round(r.height) +
        ">"
      );
    } catch (_) {
      return "(error describing element)";
    }
  }

  // ---------------------------------------------------------------------------
  // Drive viewer helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns the combined accessible-name text of an element for debug comparison.
   * Used to catch wrong-element clicks before they happen.
   */
  function getFullElementDebugText(el) {
    if (!el) return "";
    return [
      el.getAttribute?.("aria-label"),
      el.getAttribute?.("title"),
      el.innerText,
      el.textContent,
      // Walk ancestors for aria-label
      (function walkUp(node, limit) {
        if (!node || node === limit) return "";
        const a = node.getAttribute?.("aria-label") || "";
        return a + (node.parentElement ? walkUp(node.parentElement, limit) : "");
      })(el.parentElement, document.body),
    ]
      .filter(Boolean)
      .map((s) => String(s).replace(/\s+/g, " ").trim())
      .join(" ");
  }

  /**
   * Returns true if `el` is a sidebar/menu/navigation element that must NOT
   * be considered as the LRC viewer close button under any circumstance.
   */
  function isForbiddenViewerCloseCandidate(el) {
    if (!el) return true;
    const text = [
      el.getAttribute?.("aria-label"),
      el.getAttribute?.("title"),
      el.innerText,
      el.textContent,
    ]
      .filter(Boolean)
      .map((s) => String(s).replace(/\s+/g, " ").trim())
      .join(" ");

    return /mở thanh bên|đóng thanh bên|sidebar|side bar|side-nav|mở trình đơn|trình đơn|menu|cuộc trò chuyện|conversation|new chat|chat mới/i.test(
      text
    );
  }

  /**
   * Find all Drive/Docs viewer root containers on the page.
   * We scope close-button searches inside these containers to avoid picking up
   * unrelated corner buttons (e.g. the Gemini sidebar toggle at rect=8,10).
   */
  function findDriveViewerRoots() {
    const selectors = [
      ".drive-viewer",
      ".drive-viewer-overlay",
      '[aria-label*="người xem" i]',
      '[aria-label*="viewer" i]',
      '[aria-label*="Drive" i]',
      '[aria-label*="Docs" i]',
    ];

    const roots = [];
    for (const sel of selectors) {
      try {
        roots.push(...document.querySelectorAll(sel));
      } catch (_) { /* noop */ }
    }

    // Also deep-search shadow/iframe roots (drive-viewer may live inside shadow DOM).
    try {
      const deep = deepQueryAll(document, selectors.join(", "));
      roots.push(...deep);
    } catch (_) { /* noop */ }

    return [...new Set(roots)].filter(isVisible);
  }

  function findLrcViewerCloseButton() {
    const roots = findDriveViewerRoots();

    if (!roots.length) {
      // No Drive viewer root on the page — nothing to close.
      return null;
    }

    const textOf = (el) =>
      [
        el.getAttribute?.("aria-label"),
        el.getAttribute?.("title"),
        el.innerText,
        el.textContent,
        el.querySelector?.("mat-icon")?.innerText,
        el.querySelector?.("svg") ? "svg" : "",
      ]
        .filter(Boolean)
        .map((s) => String(s || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" ");

    for (const root of roots) {
      let candidates = [];
      try {
        candidates.push(...Array.from(root.querySelectorAll("button, [role='button'], a, [aria-label], [title]")));
      } catch (_) { /* noop */ }
      try {
        candidates.push(...deepQueryAll(root, "button, [role='button'], a, [aria-label], [title]"));
      } catch (_) { /* noop */ }
      candidates = candidates.filter(isVisible);

      // Tier 1: exact-match close/back/dismiss labels (not forbidden)
      const semantic = candidates.find((el) => {
        if (isForbiddenViewerCloseCandidate(el)) return false;
        const text = textOf(el).trim();
        return /^(Đóng|Close|Quay lại|Back|Thoát|Exit|Dismiss|Hủy|Huỷ|Cancel)$/i.test(text);
      });
      if (semantic) return semantic;

      // Tier 2: close-like word anywhere in accessible name, not forbidden
      const closeLike = candidates.find((el) => {
        if (isForbiddenViewerCloseCandidate(el)) return false;
        const text = textOf(el);
        return /đóng|close|quay lại|back|thoát|exit|dismiss/i.test(text);
      });
      if (closeLike) return closeLike;

      // Tier 3: icon-only top-left corner inside Drive viewer root
      const iconOnly = candidates.find((el) => {
        if (isForbiddenViewerCloseCandidate(el)) return false;

        const text = textOf(el);
        if (text && !/^[×✕xX\s]{0,5}$/.test(text)) return false;

        let r;
        try { r = el.getBoundingClientRect(); } catch (_) { return false; }
        const hasIcon = !!el.querySelector?.("svg, mat-icon");

        return hasIcon && r.top < 90 && r.left < 90 && r.width <= 72 && r.height <= 72;
      });
      if (iconOnly) return iconOnly;
    }

    return null;
  }

  function dumpVisibleButtonsForCleanup() {
    // Log every visible interactive element as diagnostic when we can't find
    // the close button. This tells us exactly what was on screen.
    const roots = findDriveViewerRoots();
    if (roots.length > 0) {
      cleanupLog("drive-viewer-roots: " + roots.length + " found");
      roots.forEach((root, i) => {
        cleanupLog("  root[" + i + "]: " + describeElement(root));
        // Dump close-candidate buttons inside this root
        const inner = [];
        try {
          const all = [...Array.from(root.querySelectorAll("button, [role='button'], a"))];
          for (const el of all) {
            if (!isVisible(el)) continue;
            const text = [
              el.getAttribute?.("aria-label"),
              el.getAttribute?.("title"),
              el.innerText,
              el.textContent,
            ]
              .filter(Boolean)
              .map((s) => String(s).replace(/\s+/g, " ").trim())
              .join(" ");
            const isForbid = isForbiddenViewerCloseCandidate(el);
            inner.push(
              "    " +
              describeElement(el) +
              (text ? ' text="' + text + '"' : "") +
              (isForbid ? " [FORBIDDEN]" : "")
            );
          }
        } catch (_) { /* noop */ }
        if (inner.length > 0) {
          cleanupLog(inner.join("\n"));
        }
      });
    } else {
      cleanupLog("drive-viewer-roots: none found");
    }

    const buttons = Array.from(
      document.querySelectorAll(
        "button, [role='button'], [role='link'], [role='menuitem'], a"
      )
    )
      .filter(isVisible)
      .map((el) => {
        const text = (el.innerText || el.textContent || "").slice(0, 50).replace(/\s+/g, " ").trim();
        return "  " + describeElement(el) + (text ? ' | text="' + text + '"' : "");
      })
      .slice(0, 30); // cap at 30 so the log doesn't explode

    if (buttons.length > 0) {
      cleanupLog("visible-buttons:\n" + buttons.join("\n"));
    } else {
      cleanupLog("visible-buttons: (none found)");
    }
  }

  async function closeLrcViewerForCleanup() {
    // Returns true when the LRC viewer is definitely closed.
    // Returns false when we exhausted all options and the viewer is still open.
    cleanupLog("closing LRC viewer...");

    const roots = findDriveViewerRoots();

    // Fast path: if nothing is open, nothing to do.
    if (!isLrcViewerOpen()) {
      cleanupLog("LRC viewer already closed");
      return true;
    }

    // On Gemini pages with no Drive viewer root, the "viewer" was likely
    // a misdetection — treat it as already closed and proceed.
    if (!roots.length && /gemini\.google\.com/i.test(location.href)) {
      cleanupLog("no Drive viewer root on Gemini page, treating viewer as already closed");
      return true;
    }

    // Strategy 1: press Escape at multiple targets, up to 5 times.
    for (let i = 0; i < 5; i += 1) {
      pressEscapeForCleanup();
      await cleanupSleep(350);
      if (!isLrcViewerOpen()) {
        cleanupLog("LRC viewer closed by Escape attempt " + (i + 1));
        return true;
      }
    }

    // Strategy 2: find and click a dedicated close/back button inside the
    // viewer overlay.
    const closeBtn = findLrcViewerCloseButton();

    if (!closeBtn) {
      cleanupLog("no valid LRC viewer close button found");

      if (/gemini\.google\.com/i.test(location.href) && findDriveViewerRoots().length === 0) {
        cleanupLog("no viewer root on Gemini page, treating viewer as already closed");
        return true;
      }

      dumpVisibleButtonsForCleanup();
      return false;
    }

    const btnDesc = describeElement(closeBtn);
    const fullText = getFullElementDebugText(closeBtn);
    cleanupLog("click LRC viewer close button: " + btnDesc);

    // Guard: reject sidebar/menu/conversation buttons before they are clicked.
    if (
      isForbiddenViewerCloseCandidate(closeBtn) ||
      /Mở thanh bên|Đóng thanh bên|sidebar|side-nav|Mở trình đơn|conversation|cuộc trò chuyện/i.test(
        btnDesc + " " + fullText
      )
    ) {
      cleanupLog("BUG: rejected wrong LRC close candidate: " + btnDesc + " fullText=" + fullText);
      dumpVisibleButtonsForCleanup();

      if (/gemini\.google\.com/i.test(location.href)) {
        cleanupLog("wrong close candidate is Gemini UI; treating viewer as already closed");
        return true;
      }

      return false;
    }

    try {
      cleanupRealClick(closeBtn);
    } catch (_) {
      cleanupLog("close button click threw");
    }
    await cleanupSleep(800);
    if (!isLrcViewerOpen()) {
      cleanupLog("LRC viewer closed by close button");
      return true;
    }

    // All strategies exhausted — the viewer is still open.
    cleanupLog("step fail: LRC viewer chưa đóng, không mở sidebar");
    dumpVisibleButtonsForCleanup();
    return false;
  }

  function cleanupFindMainMenuButton() {
    const direct =
      document.querySelector('button[aria-label="Trình đơn chính"]') ||
      document.querySelector('button[aria-label*="Trình đơn" i]') ||
      document.querySelector('button[aria-label*="menu" i]') ||
      document.querySelector('button[aria-label*="main menu" i]');
    if (direct) return direct;

    // Look for menu icons (hamburger or three-line icon)
    const icon = document.querySelector(
      'mat-icon[fonticon="menu"], mat-icon[data-mat-icon-name="menu"], ' +
      'mat-icon[fonticon="menu_open"], mat-icon[data-mat-icon-name="menu_open"], ' +
      '[data-test-id*="menu-button"], button[data-test-id*="menu"]'
    );
    if (icon) {
      const btn = icon.closest("button");
      if (btn) return btn;
    }

    // Fallback: any visible button with a menu-related class or aria-label
    const allBtns = Array.from(document.querySelectorAll("button"));
    for (const btn of allBtns) {
      const label = cleanupNormalize(btn.getAttribute("aria-label") || btn.innerText || "");
      if (label.includes("menu") && !label.includes("open")) return btn;
    }
    return null;
  }

  function cleanupSidebarLooksOpen() {
    try {
      const text = cleanupNormalize(document.body && document.body.innerText);
      return text.includes("gần đây") || text.includes("cuộc trò chuyện mới");
    } catch (_) {
      return false;
    }
  }

  async function cleanupEnsureSidebarOpen() {
    if (cleanupSidebarLooksOpen()) return true;
    const btn = cleanupFindMainMenuButton();
    if (!btn) return false;
    cleanupRealClick(btn);
    await cleanupSleep(1000);
    return cleanupSidebarLooksOpen();
  }

  function cleanupFindRecentConversationItem() {
    // Strategy 1: find items with role="listitem" in the sidebar, filtered by
    // recent/similar text patterns. The active conversation usually has
    // aria-selected="true" or class contains "selected"/"active".
    const listItems = Array.from(
      document.querySelectorAll('[role="listitem"], [role="option"]')
    );

    // Find the currently selected/active conversation item
    for (const el of listItems) {
      try {
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width < 60 || rect.height < 20) continue;
        const text = cleanupNormalize(el.innerText || el.textContent || "");
        if (!text) continue;
        const cls = String(el.className || "").toLowerCase();
        if (cls.includes("selected") || cls.includes("active")) {
          if (el.getAttribute("aria-selected") === "true") return el;
        }
      } catch (_) {}
    }

    // Strategy 2: find the most recent conversation in the sidebar by
    // looking at items that contain "tạo file lrc" or "lrc" or recent-looking
    // text and are visible in the sidebar area.
    const candidates = Array.from(
      document.querySelectorAll('[role="listitem"], [role="option"], a, li, div')
    );
    for (const el of candidates) {
      try {
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width < 60 || rect.height < 20) continue;
        const text = cleanupNormalize(el.innerText || el.textContent || "");
        if (!text) continue;
        // Skip navigation/utility items
        if (text.includes("sổ ghi chú")) continue;
        if (text.includes("thư viện")) continue;
        if (text.includes("gần đây")) continue; // section header, not item
        // Look for LRC-related conversation or any recent-looking item
        if (text.includes("tạo file lrc") || /lrc/i.test(text)) return el;
      } catch (_) {}
    }

    // Strategy 3: find the first visible sidebar list item that looks like a
    // conversation (has reasonable text, is in a sidebar-like area)
    for (const el of listItems) {
      try {
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width < 60 || rect.height < 20) continue;
        const text = cleanupNormalize(el.innerText || el.textContent || "");
        if (!text || text.length < 2) continue;
        if (text.includes("sổ ghi chú")) continue;
        if (text.includes("thư viện")) continue;
        return el;
      } catch (_) {}
    }

    return null;
  }

  function cleanupFindMoreButtonInItem(item) {
    if (!item) return null;
    // Direct search within the item element
    const direct = item.querySelector(
      'button[aria-label*="Tuỳ chọn" i], button[aria-label*="Tùy chọn" i], button[aria-label*="More" i], button[aria-label*="more" i]'
    );
    if (direct) return direct;

    // Look for the three-dots icon (⋮ or similar)
    const iconBtns = item.querySelectorAll("button, [role='button']");
    for (const btn of iconBtns) {
      const text = cleanupNormalize(btn.innerText || btn.getAttribute("aria-label") || "");
      const cls = String(btn.className || "").toLowerCase();
      // The more button often has just the icon (no text) or a specific class
      if (
        text.includes("⋮") ||
        text.includes("more") ||
        text.includes("tuỳ chọn") ||
        text.includes("tùy chọn") ||
        cls.includes("more") ||
        cls.includes("menu-item") && cls.includes("action")
      ) {
        // Make sure it's visible and clickable
        try {
          const rect = btn.getBoundingClientRect();
          if (!rect || rect.width <= 0 || rect.height <= 0) continue;
        } catch (_) { continue; }
        return btn;
      }
    }

    // Last resort: the last button in the item (usually the action button)
    const lastBtn = iconBtns[iconBtns.length - 1];
    if (lastBtn) {
      try {
        const rect = lastBtn.getBoundingClientRect();
        if (rect && rect.width > 0 && rect.height > 0) return lastBtn;
      } catch (_) {}
    }
    return null;
  }

  function cleanupFindMenuDeleteButton() {
    // First search inside CDK overlay roots (where the menu lives)
    const overlayRoots = (function() {
      const roots = [];
      try {
        for (const sel of OVERLAY_ROOT_SELECTORS) {
          try {
            document.querySelectorAll(sel).forEach(n => {
              try {
                const r = n.getBoundingClientRect();
                if (r && r.width > 0 && r.height > 0) roots.push(n);
              } catch (_) {}
            });
          } catch (_) {}
        }
      } catch (_) {}
      return roots;
    })();

    // Menu delete button label variations:
    //  - "xoá", "xóa", "delete"
    //  - with trailing icon (Gemini sometimes renders "Xoá ⋮")
    const isDeleteLabel = (raw) => {
      const t = cleanupNormalize(raw).replace(/^[^\p{L}]+/u, "").trim();
      return t === "xoá" || t === "xóa" || t === "delete";
    };

    // Search overlay roots first
    for (const root of overlayRoots) {
      const candidates = root.querySelectorAll('[role="menuitem"], button, div[role], span[role]');
      for (const el of candidates) {
        const text = cleanupNormalize(el.innerText || el.textContent || "");
        if (isDeleteLabel(text)) return el;
      }
    }

    // Fallback: search whole document
    const all = Array.from(document.querySelectorAll('[role="menuitem"], button, div'));
    return all.find(el => isDeleteLabel(el.innerText || el.textContent || "")) || null;
  }

  function cleanupFindConfirmDeleteButton() {
    // Same label matching as the menu delete button (with leading punctuation
    // stripped — Gemini may render "Xoá" with an icon prefix).
    const isDeleteLabel = (raw) => {
      const t = cleanupNormalize(raw).replace(/^[^\p{L}]+/u, "").trim();
      return t === "xoá" || t === "xóa" || t === "delete";
    };
    const confirmTextVariants = [
      "bạn muốn xoá",
      "bạn muốn xóa",
      "xoá cuộc trò chuyện",
      "xóa cuộc trò chuyện",
      "delete this conversation",
      "delete conversation",
      "delete",
    ];

    // First check inside dialog elements
    const dialogs = Array.from(
      document.querySelectorAll(
        '[role="dialog"], mat-dialog-container, .mat-mdc-dialog-container, [aria-modal="true"]'
      )
    );
    for (const d of dialogs) {
      const text = cleanupNormalize(d.innerText || "");
      const matched = confirmTextVariants.some((needle) => text.includes(needle));
      if (matched) {
        // Look for the confirm delete button inside this dialog
        const btns = d.querySelectorAll("button");
        for (const btn of btns) {
          const btnText = cleanupNormalize(btn.innerText || btn.textContent || "");
          if (isDeleteLabel(btnText)) return btn;
        }
        // Also try root-level
        for (const btn of document.querySelectorAll("button")) {
          const btnText = cleanupNormalize(btn.innerText || btn.textContent || "");
          if (isDeleteLabel(btnText) && btn.closest('[role="dialog"]') === d) {
            return btn;
          }
        }
      }
    }

    // Fallback: look for any delete button near a confirm dialog
    const allBtns = Array.from(document.querySelectorAll("button"));
    return allBtns.find(btn => {
      const text = cleanupNormalize(btn.innerText || btn.textContent || "");
      if (!isDeleteLabel(text)) return false;
      // Button should be inside or near a dialog
      const dialog = btn.closest('[role="dialog"], [aria-modal="true"]');
      if (dialog) return true;
      // Or the dialog text is visible nearby
      const parent = btn.parentElement;
      if (parent) {
        const parentText = cleanupNormalize(parent.innerText || "");
        if (confirmTextVariants.some((needle) => parentText.includes(needle))) return true;
      }
      return false;
    }) || null;
  }

  async function cleanupGeminiConversationAfterLrc() {
    // Guard: chỉ chạy 1 cleanup tại 1 thời điểm. Sau khi xong mới cho job
    // kế tiếp chạy tiếp — tránh 2 cleanup song song click nhầm conversation.
    if (CLEANUP_RUNNING_FOR) {
      cleanupLog("skip: another cleanup in progress (running for jobId=" + CLEANUP_RUNNING_FOR + ")");
      return false;
    }
    CLEANUP_RUNNING_FOR = CURRENT_JOB_ID || "active";

    try {
      cleanupLog("start currentUrl=" + window.location.href);
      // Some Gemini flows navigate to a Drive viewer after LRC is ready; if
      // we are no longer on a Gemini chat URL, we cannot clean up at all.
      const onGemini = /gemini\.google\.com/.test(window.location.href);
      if (!onGemini) {
        cleanupLog("cleanup skipped: tab đã rời gemini.google.com (URL=" + window.location.href + ")");
        return false;
      }

      // Install nav-guard now so a stray click on "Open in Drive" or any
      // Gemini-driven `location.href = ...` cannot rip the tab out from
      // under us mid-cleanup. The guard auto-blocks cross-origin top-level
      // navigations and logs every block.
      cleanupNavGuardInstall();

      // Single pass. No retries, no sidebar fallback. Each step either
      // succeeds or aborts.
      const viewerClosed = await closeLrcViewerForCleanup();
      if (!viewerClosed) {
        cleanupLog("abort: LRC viewer still open, cleanup skipped");
        cleanupNavGuardRemove("viewer-still-open");
        return false;
      }

      const ok = await deleteCurrentGeminiConversationFromTopMenu();
      if (ok) {
        cleanupNavGuardRemove("success");
        return true;
      }
      cleanupLog("cleanup aborted (no retry)");
      cleanupNavGuardRemove("aborted");
      return false;
    } catch (err) {
      cleanupLog("cleanup skipped/failed:", err && err.message ? err.message : err);
      cleanupNavGuardRemove("error");
      return false;
    } finally {
      CLEANUP_RUNNING_FOR = null;
    }
  }

  function findComposer() {
    for (const selector of COMPOSER_SELECTORS) {
      const node = document.querySelector(selector);
      if (node) return node;
    }
    return null;
  }

  function findByText(needle, { root = document } = {}) {
    const candidates = root.querySelectorAll(
      "button, [role=\"button\"], [role=\"menuitem\"], [role=\"option\"], a, li, span, div"
    );
    for (const node of candidates) {
      const text = (node.innerText || node.textContent || "").trim();
      if (!text) continue;
      if (needle.test(text)) return node;
    }
    return null;
  }

  /**
   * Single cleanup attempt — invoked by cleanupGeminiConversationAfterLrc
   * with up to 3 retries. Returns true only when the conversation was
   * actually clicked into the trash (i.e. confirm dialog button clicked).
   *
   * Replaced by the single-pass flow inside cleanupGeminiConversationAfterLrc
   * (which now runs closeLrcViewer → verify conversation id → open top-menu
   * → click delete → click confirm, exactly once, with no sidebar fallback).
   * Dead code retained as a no-op for now.
   */
  async function cleanupGeminiConversationAttempt() {
    return false;
  }

  function clickByText(needle, { root = document, roleHints = [] } = {}) {
    const candidates = root.querySelectorAll(
      "button, [role=\"button\"], [role=\"menuitem\"], [role=\"option\"], a, div[role], span[role], li"
    );
    for (const node of candidates) {
      if (node.disabled || node.getAttribute("aria-disabled") === "true") continue;
      const text = (node.innerText || node.textContent || "").trim();
      if (!text) continue;
      if (!needle.test(text)) continue;
      if (roleHints.length) {
        const role = (node.getAttribute("role") || "").toLowerCase();
        if (!roleHints.some((hint) => role.includes(hint.toLowerCase()))) continue;
      }
      node.click();
      return node;
    }
    return null;
  }

  // waitForComposer — returns the composer element as soon as it
  // appears in the DOM. We used to poll every 200ms which could take up
  // to 10–15s on slow Gemini loads where the composer mounts after a
  // late hydration step. Now we install a MutationObserver the first
  // time anyone waits, and the observer immediately resolves the
  // promise the moment a matching node shows up. A short-interval poll
  // (50ms) stays as a safety net in case the observer misses (e.g. the
  // node already existed before this script attached, or it lives
  // inside a shadow root that mutations on `document` don't fire for).
  let composerObserver = null;
  const composerWaiters = new Set();

  function ensureComposerObserver() {
    if (composerObserver || typeof MutationObserver === "undefined") return;
    try {
      composerObserver = new MutationObserver(() => {
        if (composerWaiters.size === 0) return;
        if (findComposer()) {
          // Drain waiters; each was holding an open Promise that the
          // resolver will resolve on this microtask. Detach after firing
          // so we don't leak a live observer when no one's waiting.
          for (const waiter of composerWaiters) waiter();
          composerWaiters.clear();
          if (composerObserver) {
            try { composerObserver.disconnect(); } catch (_) { /* noop */ }
            composerObserver = null;
          }
        }
      });
      // Observe the document subtree so insertions anywhere on the page
      // wake us up — Gemini hydrates the composer deep inside the
      // <main> container after several asynchronous chunks.
      composerObserver.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["contenteditable", "data-placeholder", "aria-label"],
      });
    } catch (_) {
      composerObserver = null;
    }
  }

  async function waitForComposer(timeoutMs = 30000) {
    // Fast path: composer is already mounted (e.g. user navigated to an
    // existing Gemini tab). This avoids even the first 50ms tick.
    const ready = findComposer();
    if (ready) return ready;

    const start = Date.now();
    let resolveOnce;
    const woken = new Promise((resolve) => { resolveOnce = resolve; });
    const waiter = () => {
      try { resolveOnce(findComposer()); } catch (_) { resolveOnce(null); }
    };
    composerWaiters.add(waiter);
    ensureComposerObserver();

    while (Date.now() - start < timeoutMs) {
      // Race the observer against a 50ms safety poll. The observer wins
      // the moment the node appears; the poll catches cases the observer
      // missed (shadow-root only mutations, attribute swaps that the
      // attributeFilter excludes, etc).
      const result = await Promise.race([
        woken,
        sleep(50).then(() => findComposer()),
      ]);
      if (result) {
        composerWaiters.delete(waiter);
        if (composerWaiters.size === 0 && composerObserver) {
          try { composerObserver.disconnect(); } catch (_) { /* noop */ }
          composerObserver = null;
        }
        return result;
      }
    }
    composerWaiters.delete(waiter);
    if (composerWaiters.size === 0 && composerObserver) {
      try { composerObserver.disconnect(); } catch (_) { /* noop */ }
      composerObserver = null;
    }
    return null;
  }

  // ── Composer manipulation ────────────────────────────────────────────────────
  function insertPrompt(prompt) {
    const composer = findComposer();
    if (!composer) {
      throw new Error("Không tìm thấy khung nhập câu lệnh của Gemini.");
    }
    composer.scrollIntoView({ block: "center" });
    composer.focus({ preventScroll: true });

    const range = document.createRange();
    range.selectNodeContents(composer);
    range.collapse(false);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }

    const tag = (composer.tagName || "").toLowerCase();

    if (tag === "textarea") {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      if (setter) setter.call(composer, prompt);
      else composer.value = prompt;
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      composer.innerHTML = "";
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, data: "" }));

      let inserted = false;
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
          const r = sel.getRangeAt(0);
          r.deleteContents();
          r.insertNode(document.createTextNode(prompt));
          r.collapse(false);
          inserted = true;
        }
      } catch (_) { /* fall through */ }

      if (!inserted) {
        try {
          document.execCommand("insertText", false, prompt);
          inserted = true;
        } catch (_) { /* fall through */ }
      }
      if (!inserted) {
        composer.innerText = prompt;
      }

      composer.dispatchEvent(new InputEvent("input", { bubbles: true, data: prompt }));
    }

    if ((composer.value || composer.innerText || "").trim() === "") {
      throw new Error("Không chèn được prompt vào Gemini.");
    }
    return composer;
  }

  // Verifies that Gemini consumed the prompt: the composer is empty or a new
  // user message node appeared in the conversation.
  function verifySendSuccess(originalPrompt) {
    const composer = findComposer();
    if (!composer) return true; // composer gone — likely submitted
    const composerText = (composer.value || composer.innerText || "").trim();
    if (composerText === "") return true;
    // Partial remaining text is OK — Gemini may strip whitespace.
    if (composerText.length < originalPrompt.length * 0.5) return true;
    // Check for new user message bubble in the conversation.
    const userMsgs = document.querySelectorAll('[data-message-author="user"], [data-test-id*="user-message"]');
    for (const msg of userMsgs) {
      const t = (msg.innerText || msg.textContent || "").trim();
      if (t.includes(originalPrompt.slice(0, 40))) return true;
    }
    return false;
  }

  /**
   * Attempts to submit the Gemini prompt using up to 4 strategies.
   * Returns { ok: true, method: string } on success, throws on total failure.
   */
  async function clickSend(originalPrompt) {
    const composer = findComposer();
    const logPrefix = (tag) => console.log(`[gemini-lrc] SEND_${tag}`);

    // ── Strategy 1: Ctrl+Enter ──────────────────────────────────────────────
    logPrefix("ATTEMPT_CTRL_ENTER");
    if (composer) {
      composer.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13,
          ctrlKey: true, bubbles: true, cancelable: true,
        })
      );
      await sleep(700);
      if (verifySendSuccess(originalPrompt)) {
        logPrefix("SUCCESS method=CTRL_ENTER");
        return { ok: true, method: "CTRL_ENTER" };
      }
    }

    // ── Strategy 1b: plain Enter (no modifier) ──────────────────────────────
    // Gemini's composer treats plain Enter as submit when there's text in
    // the field and Shift+Enter as newline. Older versions required
    // Ctrl+Enter; recent ones switched the default. We try both so a
    // regression in either binding doesn't hard-fail the flow.
    logPrefix("ATTEMPT_ENTER");
    if (composer) {
      composer.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13,
          bubbles: true, cancelable: true,
        })
      );
      await sleep(700);
      if (verifySendSuccess(originalPrompt)) {
        logPrefix("SUCCESS method=ENTER");
        return { ok: true, method: "ENTER" };
      }
    }

    // ── Strategy 2: send button by multiple patterns ────────────────────────
    logPrefix("ATTEMPT_SENDBUTTON");
    const SKIP_RE = /skip|bỏ|close|dismiss|back|prev|next|menu|expand|collapse|sign|in|login/i;

    // Collect all candidate buttons.
    const allButtons = Array.from(document.querySelectorAll("button"));
    const candidates = [];

    for (const btn of allButtons) {
      if (btn.disabled || btn.getAttribute("aria-disabled") === "true") continue;
      const label = (btn.getAttribute("aria-label") || btn.textContent || "").trim().toLowerCase();
      if (SKIP_RE.test(label)) continue;
      // By aria-label containing send-like words.
      if (/gửi|send|submit|enter/i.test(label)) candidates.push(btn);
      // By text content exactly "gửi" / "send" / "submit".
      else if (/^(gửi|send|submit)$/i.test(label)) candidates.push(btn);
      // SVG-only icon button (Gemini uses inline SVG for the send icon).
      else if (!btn.textContent?.trim() && btn.querySelector("svg")) candidates.push(btn);
    }
    // Buttons inside composer area.
    const composerParent = composer?.closest(
      '[class*="composer"], [class*="input"], [class*="prompt"], [class*="send"]'
    );
    if (composerParent) {
      for (const btn of composerParent.querySelectorAll("button")) {
        if (btn.disabled || btn.getAttribute("aria-disabled") === "true") continue;
        const label = (btn.getAttribute("aria-label") || btn.textContent || "").trim().toLowerCase();
        if (SKIP_RE.test(label)) continue;
        if (!candidates.includes(btn)) candidates.push(btn);
      }
    }

    for (const btn of candidates) {
      try {
        btn.scrollIntoView({ block: "center" });
        btn.click();
        await sleep(700);
        if (verifySendSuccess(originalPrompt)) {
          logPrefix("SUCCESS method=SENDBUTTON label=" + (
            btn.getAttribute("aria-label") || btn.textContent?.trim() || "?"
          ));
          return { ok: true, method: "SENDBUTTON" };
        }
      } catch (_) { /* try next */ }
    }

    // ── Strategy 3: form submit ─────────────────────────────────────────────
    logPrefix("ATTEMPT_FORMSUBMIT");
    const form = composer?.closest("form");
    if (form) {
      try {
        form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
        await sleep(700);
        if (verifySendSuccess(originalPrompt)) {
          logPrefix("SUCCESS method=FORMSUBMIT");
          return { ok: true, method: "FORMSUBMIT" };
        }
        // Real form.requestSubmit() synthesises a submit event AND runs
        // form-validation. dispatchEvent alone may be ignored by React-
        // controlled forms, so fall back to the imperative API.
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit();
          await sleep(700);
          if (verifySendSuccess(originalPrompt)) {
            logPrefix("SUCCESS method=FORMSUBMIT_REQUEST");
            return { ok: true, method: "FORMSUBMIT_REQUEST" };
          }
        }
      } catch (_) { /* fall through */ }
    }

    // ── Strategy 4: any enabled button inside composer wrapper ───────────────
    logPrefix("ATTEMPT_COMPOSERBUTTON");
    if (composerParent) {
      const nearby = composerParent.querySelectorAll("button");
      for (const btn of nearby) {
        if (btn.disabled || btn.getAttribute("aria-disabled") === "true") continue;
        const label = (btn.getAttribute("aria-label") || btn.textContent || "").trim().toLowerCase();
        if (SKIP_RE.test(label)) continue;
        try {
          btn.scrollIntoView({ block: "center" });
          btn.click();
          await sleep(700);
          if (verifySendSuccess(originalPrompt)) {
            logPrefix("SUCCESS method=COMPOSERBUTTON label=" + (label || "?"));
            return { ok: true, method: "COMPOSERBUTTON" };
          }
        } catch (_) { /* try next */ }
      }
    }

    // ── Strategy 5: any enabled role=button div near composer ───────────────
    // Gemini's recent UI sometimes renders the send affordance as a div
    // with role=button + an inline SVG (no real <button> element), so
    // the selectors above miss it. Search for role=button + SVG inside
    // the composer parent or near the composer in the DOM tree.
    logPrefix("ATTEMPT_ROLE_BUTTON");
    if (composerParent) {
      const roleButtons = composerParent.querySelectorAll('[role="button"]');
      for (const el of roleButtons) {
        if (el.getAttribute("aria-disabled") === "true") continue;
        const label = (el.getAttribute("aria-label") || el.textContent || "").trim().toLowerCase();
        if (label && SKIP_RE.test(label)) continue;
        // Heuristic: must contain an SVG (send affordance is icon-only),
        // OR have an aria-label that mentions send / gửi / submit.
        const hasIcon = !!el.querySelector("svg, img");
        const looksLikeSend = /gửi|send|submit|enter|arrow_upward|send_icon/i.test(
          (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("data-testid") || "")
        );
        if (!hasIcon && !looksLikeSend) continue;
        try {
          el.scrollIntoView({ block: "center" });
          el.click();
          await sleep(700);
          if (verifySendSuccess(originalPrompt)) {
            logPrefix("SUCCESS method=ROLE_BUTTON label=" + (label || el.tagName));
            return { ok: true, method: "ROLE_BUTTON" };
          }
        } catch (_) { /* try next */ }
      }
    }

    // ── Strategy 6: data-testid / data-test-id send button ──────────────────
    // Gemini's E2E suite tags the send control with a stable test
    // attribute that survives class-name churns. If we can find it,
    // clicking it bypasses any aria-label mismatch.
    logPrefix("ATTEMPT_TESTID_SEND");
    const testIdSelectors = [
      '[data-testid*="send" i]',
      '[data-test-id*="send" i]',
      'button[aria-label*="send" i]',
      'button[mat-icon-button] i.material-icons',
    ];
    for (const sel of testIdSelectors) {
      let el = null;
      try { el = composerParent ? composerParent.querySelector(sel) : document.querySelector(sel); }
      catch (_) { el = null; }
      if (!el) continue;
      const target = el.closest("button") || el;
      if (target.disabled || target.getAttribute("aria-disabled") === "true") continue;
      try {
        target.scrollIntoView({ block: "center" });
        target.click();
        await sleep(700);
        if (verifySendSuccess(originalPrompt)) {
          logPrefix("SUCCESS method=TESTID_SEND selector=" + sel);
          return { ok: true, method: "TESTID_SEND" };
        }
      } catch (_) { /* try next selector */ }
    }

    // All strategies failed.
    const reason = `CtrlEnter=false, Enter=false, SendButton=false, FormSubmit=false, ComposerButton=false, RoleButton=false, TestIdSend=false`;
    logPrefix("FAILED " + reason);
    throw new Error("SEND_FAILED: " + reason);
  }

  // ── Model menu helpers ─────────────────────────────────────────────────────
  //
  // The Gemini composer-area model menu is what carries BOTH model selection
  // (3.1 Pro / Flash / Flash-Lite) AND thinking level (Cấp độ → Mở rộng).
  // The old separate "thinking" trigger has been merged into this menu, so
  // both selectModel() and selectThinkingLevel() must:
  //   1) Find the correct menu button via several strategies (NOT just
  //      data-test-id, which has changed before).
  //   2) Real-click it (synthetic mousedown/mouseup/click, not .click()).
  //   3) Wait for the menu to actually open before navigating into it.
  //   4) Then drill down through "Cấp độ" → "Mở rộng".

  function isElementVisible(el) {
    if (!el) return false;
    try {
      const rect = el.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(el);
      if (style && (style.visibility === "hidden" || style.display === "none" || style.opacity === "0")) {
        return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function findModelMenuButton() {
    const selectors = [
      '[data-test-id="bard-mode-menu-button"]',
      'button[aria-label*="model" i]',
      'button[aria-label*="mô hình" i]',
      'button[aria-label*="mode" i]',
    ];

    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);
        if (el && isElementVisible(el)) return el;
      } catch (_) { /* noop */ }
    }

    const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
    const modelTextPatterns = [
      /3\.1\s*Pro/i,
      /3\.5\s*Flash/i,
      /Flash/i,
      /\bPro\b/i,
    ];

    for (const btn of buttons) {
      const text = (btn.innerText || btn.textContent || btn.getAttribute("aria-label") || "").trim();
      if (!text) continue;
      if (modelTextPatterns.some((re) => re.test(text)) && isElementVisible(btn)) {
        return btn;
      }
    }

    return null;
  }

  function realClick(el, ratioX = 0.5, ratioY = 0.5) {
    if (!el) return false;
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (_) { /* noop */ }

    let x = 0;
    let y = 0;
    let rect = null;
    try {
      rect = el.getBoundingClientRect();
      const rx = Math.min(Math.max(Number(ratioX) || 0.5, 0), 1);
      const ry = Math.min(Math.max(Number(ratioY) || 0.5, 0), 1);
      x = rect.left + rect.width * rx;
      y = rect.top + rect.height * ry;
    } catch (_) { /* keep 0,0 */ }

    let target = el;
    try {
      target = document.elementFromPoint(x, y) || el;
    } catch (_) { /* keep el */ }

    const eventTypes = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
    for (const type of eventTypes) {
      try {
        target.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          button: 0,
        }));
      } catch (_) { /* noop */ }
    }
    return true;
  }

  // Same as realClick but dispatches events directly on `el` instead of
  // using document.elementFromPoint to re-resolve the target. Use this when
  // you know exactly which element should receive the click (e.g. a chip
  // whose real target is the chip itself, not whatever happens to be at
  // those coordinates in the stacking context).
  function realClickAt(el, ratioX = 0.5, ratioY = 0.5) {
    if (!el) return false;
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (_) { /* noop */ }

    let x = 0;
    let y = 0;
    try {
      const rect = el.getBoundingClientRect();
      const rx = Math.min(Math.max(Number(ratioX) || 0.5, 0), 1);
      const ry = Math.min(Math.max(Number(ratioY) || 0.5, 0), 1);
      x = rect.left + rect.width * rx;
      y = rect.top + rect.height * ry;
    } catch (_) { /* keep 0,0 */ }

    // Dispatch directly on `el` — no elementFromPoint redirect.
    const target = el;
    const eventTypes = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
    for (const type of eventTypes) {
      try {
        target.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          button: 0,
        }));
      } catch (_) { /* noop */ }
    }
    return true;
  }

  function realHover(el, ratioX = 0.5, ratioY = 0.5) {
    if (!el) return false;
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (_) { /* noop */ }

    let x = 0;
    let y = 0;
    try {
      const rect = el.getBoundingClientRect();
      const rx = Math.min(Math.max(Number(ratioX) || 0.5, 0), 1);
      const ry = Math.min(Math.max(Number(ratioY) || 0.5, 0), 1);
      x = rect.left + rect.width * rx;
      y = rect.top + rect.height * ry;
    } catch (_) { /* keep 0,0 */ }

    let target = el;
    try {
      target = document.elementFromPoint(x, y) || el;
    } catch (_) { /* keep el */ }

    const eventTypes = ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"];
    for (const type of eventTypes) {
      try {
        target.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
        }));
      } catch (_) { /* noop */ }
    }
    return true;
  }

  function isModelMenuOpen() {
    // The current trigger can read "Pro Mở rộng" even while its menu is
    // closed. Only an overlay containing menu-specific choices proves that
    // the menu is actually open.
    const menuNeedle =
      /(?:3\.(?:1|5)\s*(?:flash|pro)|flash-lite|t\u01b0\s*duy\s*m\u1edf\s*r\u1ed9ng|deep\s*think)/i;
    const roots = document.querySelectorAll(
      ".cdk-overlay-container, .cdk-overlay-pane, .mat-mdc-menu-panel, mat-menu-panel, [role='menu'], [role='listbox'], [role='dialog']"
    );
    for (const root of roots) {
      if (!isElementVisible(root)) continue;
      const text = (root.innerText || root.textContent || "").replace(/\s+/g, " ");
      if (menuNeedle.test(text)) return true;
    }
    return false;
  }

  async function openModelMenu() {
    log("Đang tìm nút menu model Gemini...");
    const btn = findModelMenuButton();
    if (!btn) {
      log("Không tìm thấy nút mở menu model Gemini.");
      throw new Error("Không tìm thấy nút mở menu model Gemini.");
    }
    const label = (btn.innerText || btn.textContent || btn.getAttribute("aria-label") || "").trim();
    log("Đã tìm thấy nút menu model: " + (label || "(không có nhãn)"));

    if (isModelMenuOpen()) {
      log("Menu model đã mở sẵn, bỏ qua click.");
      return true;
    }

    log("Đang mở menu model Gemini...");
    realClick(btn);

    for (let i = 0; i < 20; i += 1) {
      if (isModelMenuOpen()) {
        log("Đã mở menu model Gemini.");
        return true;
      }
      await sleep(250);
    }
    log("Không mở được menu model Gemini sau khi click.");
    throw new Error("Không mở được menu model Gemini sau khi click nút model.");
  }

  // ── Overlay-scoped menu helpers ────────────────────────────────────────────
  //
  // Why scoped: findByText over the whole document matches `div.content-wrapper`,
  // banner text, chat bubbles, etc. When realClick then hits the centre of that
  // wrapper, `elementFromPoint` falls through to the ql-editor underneath and
  // the click is swallowed by the composer. We must only consider rows that
  // live inside Gemini's CDK overlay (the same DOM subtree as gem-menu-item).
  //
  // Overlay roots observed in production: .cdk-overlay-container,
  // .cdk-overlay-pane, .mat-mdc-menu-panel, [role="menu"], [role="listbox"].

  const OVERLAY_ROOT_SELECTORS = [
    ".cdk-overlay-container",
    ".cdk-overlay-pane",
    ".mat-mdc-menu-panel",
    "mat-menu-panel",
    '[role="menu"]',
    '[role="listbox"]',
    '[role="dialog"]',
  ];

  const MENU_ROW_SELECTOR = [
    "gem-menu-item",
    '[role="menuitem"]',
    '[role="option"]',
    '[role="menuitemradio"]',
    '[role="menuitemcheckbox"]',
    "button",
    '[role="button"]',
    "button[aria-haspopup]",
    "button[aria-expanded]",
  ].join(",");

  const SAFE_TEXT_BLOCKLIST = [
    /trò\s*chuyện\s*với\s*gemini/i,
    /chào\s+[a-zà-ỹ]+/i,
    /tiếp\s*theo\s*mình/i,
    /^\s*gemini\s*can\s*make\s*mistakes/i,
    /^hôm nay là/i,
  ];

  function getOverlayRoots() {
    const roots = [];
    const seen = new Set();

    const push = (node) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      try {
        if (!isElementVisible(node)) return;
        const rect = node.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return;
      } catch (_) {
        return;
      }
      roots.push(node);
    };

    for (const selector of OVERLAY_ROOT_SELECTORS) {
      try {
        document.querySelectorAll(selector).forEach(push);
      } catch (_) { /* noop */ }
    }

    if (roots.length === 0) {
      // CDK overlays are normally portalled to body. We deliberately do NOT
      // fall back to document.body — that would re-introduce the
      // div.content-wrapper false-positive.
      log("getOverlayRoots: no overlay roots found.");
      return [];
    }

    return roots;
  }

  function nodeText(node) {
    return (node && (node.innerText || node.textContent || "")).replace(/\s+/g, " ").trim();
  }

  function rowTextLooksLikeMenuRow(text) {
    if (!text) return false;
    if (text.length < 2 || text.length > 200) return false;
    if (SAFE_TEXT_BLOCKLIST.some((re) => re.test(text))) return false;
    return true;
  }

  function findMenuRows(needle) {
    const roots = getOverlayRoots();
    const matches = [];

    for (const root of roots) {
      let candidates;
      try {
        candidates = root.querySelectorAll(MENU_ROW_SELECTOR);
      } catch (_) {
        continue;
      }

      for (const node of candidates) {
        const text = nodeText(node);
        if (!rowTextLooksLikeMenuRow(text)) continue;
        if (!needle.test(text)) continue;
        matches.push({ node, text, root });
      }
    }

    return matches;
  }

  function dumpOverlaySnapshot(tag) {
    const roots = getOverlayRoots();
    const lines = [];
    for (const root of roots) {
      try {
        const t = nodeText(root);
        if (t) lines.push(`${tag} root text: ${t.slice(0, 240)}`);
      } catch (_) { /* noop */ }
    }
    if (lines.length === 0) {
      log(`${tag}: no overlay roots.`);
    } else {
      log(lines.join("\n"));
    }
    return lines;
  }

  function pickFirstGemMenuItem(matches) {
    if (!matches || !matches.length) return null;
    for (const m of matches) {
      const tag = (m.node.tagName || "").toLowerCase();
      if (tag === "gem-menu-item") return m;
    }
    return matches[0];
  }

  const DIRECT_EXPANDED_THINKING_NEEDLE =
    /(?:t\u01b0\s*duy\s*m\u1edf\s*r\u1ed9ng|gi\u1ea3i\s*quy\u1ebft\s*v\u1ea5n\s*\u0111\u1ec1\s*ph\u1ee9c\s*t\u1ea1p|extended\s*thinking|solve\s*complex\s*problems)/i;

  function hasSelectedMenuState(node) {
    if (!node) return false;
    const selectedSelector =
      '[aria-checked="true"], [aria-selected="true"], [data-selected="true"], input:checked';
    try {
      if (node.matches?.(selectedSelector) || node.querySelector?.(selectedSelector)) return true;
    } catch (_) { /* noop */ }
    const text = nodeText(node);
    return /\b(?:check|done)\b/i.test(text) || text.includes("\u2713");
  }

  async function selectDirectExpandedThinking({ onProgress } = {}) {
    let match = null;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const matches = findMenuRows(DIRECT_EXPANDED_THINKING_NEEDLE);
      match = pickFirstGemMenuItem(matches);
      if (match) break;
      await sleep(200);
    }
    if (!match) return null;

    if (hasSelectedMenuState(match.node)) {
      onProgress?.("Tư duy mở rộng đã được chọn.");
      return { found: true, selected: true };
    }

    onProgress?.("Đang chọn Tư duy mở rộng...");
    realClickAt(match.node, 0.5, 0.5);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await sleep(180);
      if (
        hasSelectedMenuState(match.node) ||
        isThinkingLevelSelectedInPill(readModelThinkingTriggerText())
      ) {
        onProgress?.("Tư duy mở rộng đã được chọn.");
        return { found: true, selected: true };
      }
    }
    return { found: true, selected: false };
  }

  async function selectModel({ onProgress } = {}) {
    const btn = findModelMenuButton();
    if (!btn) {
      throw new Error("Không tìm thấy nút chọn model trong Gemini UI.");
    }

    const triggerText = (btn.innerText || btn.textContent || "").trim();
    if (/pro/i.test(triggerText)) {
      onProgress?.("Model Pro đã được chọn.");
      log("Model Pro đã được chọn, bỏ qua chọn lại.");
      return;
    }

    onProgress?.("Đang mở menu model để chọn 3.1 Pro...");
    await openModelMenu();
    await sleep(200);

    let option = null;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const overlayMatch = pickFirstGemMenuItem(findMenuRows(/3\.1\s*pro/i));
      if (overlayMatch) {
        realClickAt(overlayMatch.node, 0.5, 0.5);
        option = overlayMatch.node;
        break;
      }
      option = clickByText(/3\.1\s*pro/i, { roleHints: ["menuitem", "option", "radio"] });
      if (option) break;
      await sleep(300);
    }
    if (!option) {
      throw new Error("Không tìm thấy model Pro trong menu.");
    } else {
      onProgress?.("Đã chọn model 3.1 Pro.");
    }
    await sleep(500);
  }

  async function selectThinkingLevel({ onProgress } = {}) {
    // Returns:
    //   { found: true,  selected: true }  — Mở rộng selected (verified)
    //   { found: true,  selected: false } — menu opened but Mở rộng not found
    //   { found: false }                  — couldn't even open the model menu
    //
    // Flow (driven by console-test observation):
    //   1) openModelMenu() and verify.
    //   2) Scope the row search to CDK overlay roots only — never document.body
    //      (which would re-match div.content-wrapper / chat text).
    //   3) Find the "Cấp độ tư duy" gem-menu-item row.
    //   4) realHover(levelRow, 0.5, 0.5) to "wake" the row,
    //      then realHover(levelRow, 0.9, 0.5) + realClick(levelRow, 0.9, 0.5)
    //      to open the submenu (CDK menus expand on hover at the right edge,
    //      not on centre-click).
    //   5) Find "Mở rộng" inside the overlay and click it.
    //   6) Verify by reopening the menu and confirming the level row now reads
    //      "Cấp độ tư duy / Mở rộng".

    try {
      await openModelMenu();
    } catch (error) {
      log("openModelMenu failed:", error?.message || String(error));
      return { found: false };
    }
    await sleep(250);

    // Gemini's current menu exposes "Tư duy mở rộng" as a direct row next
    // to Deep Think. Prefer it before trying the legacy nested submenu.
    const directThinkingResult = await selectDirectExpandedThinking({ onProgress });
    if (directThinkingResult) return directThinkingResult;

    // Step 1: locate the "Cấp độ tư duy" row INSIDE the overlay only.
    const levelNeedle = /cấp\s*độ(\s*tư\s*duy)?|thinking|reasoning/i;
    const verifyNeedle = /cấp\s*độ\s*tư\s*duy/i;

    let levelMatch = null;
    onProgress?.("Tìm dòng Cấp độ trong overlay...");
    dumpOverlaySnapshot("OVERLAY");
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const overlayRoots = getOverlayRoots();
      if (!overlayRoots.length) {
        await sleep(300);
        continue;
      }
      const matches = findMenuRows(levelNeedle);
      if (matches.length) {
        levelMatch = pickFirstGemMenuItem(matches);
        if (levelMatch) {
          log(
            `LEVEL ROWS: ${(levelMatch.node.tagName || "?").toLowerCase()} ` +
              `"${levelMatch.text}"`
          );
          break;
        }
      }
      await sleep(300);
    }

    if (!levelMatch) {
      log("Không tìm thấy dòng Cấp độ trong menu model (overlay scope).");
      return { found: true, selected: false };
    }

    // Double-check: the chosen row must really look like "Cấp độ tư duy".
    if (!verifyNeedle.test(levelMatch.text) && !/cấp\s*độ/i.test(levelMatch.text)) {
      log(`LEVEL ROWS: bỏ — text không khớp: "${levelMatch.text}"`);
      return { found: true, selected: false };
    }

    const levelRow = levelMatch.node;

    // Step 2: open the submenu via hover-then-click at the right edge (0.9, 0.5).
    // The 0.5 horizontal centre click tends to fall on the label, not on the
    // CDK hover trigger that expands the submenu — and on top of ql-editor when
    // the row is inside the wrong subtree. The right-edge click avoids that.
    onProgress?.("Đang mở submenu cấp độ tư duy...");
    realHover(levelRow, 0.5, 0.5);
    await sleep(120);
    realHover(levelRow, 0.9, 0.5);
    await sleep(120);
    realClick(levelRow, 0.9, 0.5);
    await sleep(500);

    // Step 3: find the thinking-level option inside the overlay.
    //
    // The option label varies across Gemini builds/locales:
    //   • "Mở rộng"            — older build, single label
    //   • "Pro Mở rộng"        — current build (matches the chip shown
    //                            outside the composer after selection)
    //   • "Giải quyết vấn đề phức tạp" — accessibility / tooltip text
    //
    // The previous strict needle `/^mở\s*rộng$/i` matched ONLY the bare
    // "Mở rộng" cell and missed the "Pro Mở rộng" cell, leaving the user
    // with the right thing already selected on the page but our code
    // falling through to the verify / retry path that printed a misleading
    // "Không tìm thấy Mở rộng" warning. Match all three forms here.
    const optionNeedle =
      /(?:^|\s)pro\s*mở\s*rộng|mở\s*rộng|giải\s*quyết\s*vấn\s*đề\s*phức\s*tạp/i;

    let moRongMatch = null;
    let moRongMatchedText = "";
    onProgress?.("Đang chọn Mở rộng...");
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const matches = findMenuRows(optionNeedle);
      if (matches.length) {
        const pick = pickFirstGemMenuItem(matches);
        if (pick) {
          moRongMatch = pick;
          moRongMatchedText = pick.text;
          break;
        }
      }
      await sleep(300);
    }

    if (!moRongMatch) {
      log("Không tìm thấy option Mở rộng trong submenu.");
      return { found: true, selected: false };
    }

    log(
      `EXPANDED ROWS: ${(moRongMatch.node.tagName || "?").toLowerCase()} ` +
        `"${moRongMatchedText}"`
    );
    realClick(moRongMatch.node, 0.5, 0.5);
    // Brief settle so the click registers and the model/thinking chip
    // outside the composer updates. The chip is the source of truth — we
    // verify the click via THAT, not by reopening the menu (which races
    // against CDK overlay teardown and frequently reports the wrong
    // row text).
    await sleep(500);

    // Step 4: verify by reading the model/thinking chip OUTSIDE the
    // composer. If the chip already says "Mở rộng" / "Pro Mở rộng" /
    // contains both "Pro" and "Mở rộng", the click took effect — emit a
    // single success line and DO NOT retry.
    const externalPillText = readModelThinkingTriggerText();
    log(`EXTERNAL PILL: "${externalPillText}"`);
    if (isThinkingLevelSelectedInPill(externalPillText)) {
      onProgress?.("Cấp độ tư duy Mở rộng đã được chọn.");
      log("Cấp độ tư duy Mở rộng đã được chọn.");
      return { found: true, selected: true };
    }

    // External verification did not see "Mở rộng". Retry exactly once —
    // close, reopen the model menu, click the option again — before we
    // give up and report failure.
    log(
      "Verify fail: chip dưới composer không hiển thị Mở rộng " +
        `(chip="${externalPillText}"), thử click lại 1 lần.`
    );
    try { closeAnyOverlay(); } catch (_) { /* noop */ }
    await sleep(300);
    try {
      await openModelMenu();
    } catch (error) {
      log("retry openModelMenu failed:", error?.message || String(error));
      return { found: true, selected: false };
    }
    // Re-open the level row + its submenu the same way as the first pass.
    let retryLevelMatch = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const matches = findMenuRows(/cấp\s*độ\s*tư\s*duy/i);
      if (matches.length) {
        const pick = pickFirstGemMenuItem(matches);
        if (pick) { retryLevelMatch = pick; break; }
      }
      await sleep(300);
    }
    if (!retryLevelMatch) {
      log("retry: không thấy dòng Cấp độ tư duy lần 2.");
      return { found: true, selected: false };
    }
    const retryLevelRow = retryLevelMatch.node;
    realHover(retryLevelRow, 0.5, 0.5);
    await sleep(120);
    realHover(retryLevelRow, 0.9, 0.5);
    await sleep(120);
    realClick(retryLevelRow, 0.9, 0.5);
    await sleep(500);
    const retryMatches = findMenuRows(optionNeedle);
    const retryPick = retryMatches.length ? pickFirstGemMenuItem(retryMatches) : null;
    if (!retryPick) {
      log("retry: không thấy option Mở rộng trong submenu lần 2.");
      return { found: true, selected: false };
    }
    realClick(retryPick.node, 0.5, 0.5);
    await sleep(500);

    // Second verification on the chip.
    const retryPillText = readModelThinkingTriggerText();
    log(`EXTERNAL PILL (retry): "${retryPillText}"`);
    if (isThinkingLevelSelectedInPill(retryPillText)) {
      onProgress?.("Cấp độ tư duy Mở rộng đã được chọn.");
      log("Cấp độ tư duy Mở rộng đã được chọn (sau retry).");
      return { found: true, selected: true };
    }
    log(
      "Verify fail (retry): chip dưới composer vẫn không hiển thị Mở rộng " +
        `(chip="${retryPillText}").`
    );
    return { found: true, selected: false };
  }

  // ── Thinking-level external verification ──────────────────────────────
  //
  // After clicking the "Mở rộng" option inside the dropdown, the source of
  // truth is the model/thinking chip rendered OUTSIDE the composer (the
  // little pill shown below the prompt input that reads "Pro Mở rộng" /
  // "3.1 Pro Mở rộng" once thinking is on). Reading that chip is more
  // reliable than reopening the menu, because:
  //   • Reopening races against CDK overlay teardown.
  //   • The "Cấp độ tư duy / X" row inside the menu occasionally parses
  //     to unexpected text (e.g. a trailing badge), causing false
  //     negatives that print the misleading "Không tìm thấy Mở rộng"
  //     warning while the user has actually got the right config.
  //
  // The chip lives in the same DOM tree as `findModelMenuButton` — we
  // reuse it to read the trigger text without reopening anything.

  function readModelThinkingTriggerText() {
    const btn = findModelMenuButton();
    if (!btn) return "";
    // innerText collapses whitespace and respects visibility, which is
    // what we want for chip text. Fall back to textContent for shadow
    // trees where innerText is unavailable.
    return ((btn.innerText || btn.textContent || "") + "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isThinkingLevelSelectedInPill(text) {
    if (!text) return false;
    const norm = text.toLowerCase();
    // Direct "Pro Mở rộng" chip.
    if (/pro\s*mở\s*rộng/.test(norm)) return true;
    // Generic "Mở rộng" chip without the model prefix.
    if (/mở\s*rộng/.test(norm)) return true;
    // Chip splits into "Pro" + separate "Mở rộng" badges joined by a
    // newline / bullet — match both halves present.
    if (/\bpro\b/.test(norm) && /mở\s*rộng/.test(norm)) return true;
    return false;
  }

  function closeAnyOverlay() {
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true,
      }));
    } catch (_) { /* noop */ }
    try {
      const closer = document.querySelector(
        '[aria-label*="đóng" i], [aria-label*="close" i], [data-test-id*="close" i]'
      );
      if (closer) closer.click();
    } catch (_) { /* noop */ }
  }

  // ── File attachment detection ──────────────────────────────────────────────
  //
  // Gemini often returns the LRC as a downloadable file attachment (.txt or
  // .lrc) inside the assistant response, NOT as inline text. When that
  // happens we must identify the file chip, fetch its content, and forward
  // the raw content to the sidepanel — never the assistant node's innerText.
  //
  // Card structure (observed on Gemini UI):
  //   <message-content>
  //     <file-name-lr-chip>
  //       <file-name>NoiTinhYeuKetThuc.txt</file-name>
  //       <a download="NoiTinhYeuKetThuc.txt" href="blob:...">...</a>
  //       <open-button>Open</open-button>
  //     </file-name-lr-chip>
  //     ...text fallback...
  //   </message-content>
  //
  // Selectors below match:
  //   - <a download="..."> with href blob:... or href*.txt / *.lrc
  //   - custom element <file-name> with adjacent <open-button>
  //   - generic [data-test-id="file-name"] / .file-name-lr

  const FILE_TEXT_NEEDLE = /\.(txt|lrc)(\?|#|$)/i;

  function findFileAttachmentIn(node) {
    if (!node) return null;
    // 1. Direct <a download> with blob: href or text/lrc href.
    //
    //    STRICT rule: we only consider the anchor an attachment if BOTH the
    //    href has a .txt/.lrc extension OR is a blob: URL, AND the
    //    downloadable filename (or aria-label) ends with .txt/.lrc. A bare
    //    anchor with text "Watch on YouTube" must NOT match — that's the
    //    bug we're fixing here.
    const anchors = node.querySelectorAll(
      'a[download], a[href^="blob:"]'
    );
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") || "";
      const name = (
        anchor.getAttribute("download") ||
        anchor.getAttribute("aria-label") ||
        ""
      ).trim();
      const hrefLooksLikeText =
        FILE_TEXT_NEEDLE.test(href) ||
        href.startsWith("blob:");
      const nameLooksLikeText = FILE_TEXT_NEEDLE.test(name);
      if (!hrefLooksLikeText || !nameLooksLikeText) continue;
      const chipRoot =
        anchor.closest("file-name-lr-chip") ||
        anchor.closest(".file-name-lr-chip") ||
        anchor.closest("[class*='chip']") ||
        anchor.parentElement;
      return { anchor, href, name, chipRoot, nameEl: null };
    }
    // 2. Custom elements: <file-name>NoiTinhYeuKetThuc.txt</file-name>
    //    Inside <file-name-lr-chip>...</file-name-lr-chip>. The chip
    //    itself must contain a TXT/LRC badge or the file-name has to be
    //    sibling to a TXT/LRC icon so we know it's a real file card.
    const nameEls = node.querySelectorAll(
      'file-name, [data-test-id="file-name"], .file-name-lr'
    );
    for (const nameEl of nameEls) {
      const fileName = (nameEl.textContent || "").trim();
      if (!fileName || !FILE_TEXT_NEEDLE.test(fileName)) continue;
      const chipRoot =
        nameEl.closest("file-name-lr-chip") ||
        nameEl.closest(".file-name-lr-chip") ||
        nameEl.closest("[class*='chip']") ||
        nameEl.parentElement;
      if (!chipRoot) continue;
      // The chip must show a "TXT" / "LRC" badge to count. Otherwise we
      // treat it as a stray filename that happens to live in a chip.
      const chipText = (chipRoot.innerText || chipRoot.textContent || "").toUpperCase();
      if (!/\b(TXT|LRC)\b/.test(chipText)) continue;
      const anchor =
        chipRoot.querySelector('a[download], a[href^="blob:"]') || null;
      return {
        anchor,
        href: anchor?.getAttribute("href") || "",
        name: fileName,
        chipRoot,
        nameEl,
      };
    }
    // 3. Fallback: chip with explicit TXT/LRC badge whose own text
    //    starts with a filename ending in .txt/.lrc. e.g.
    //    "Noi_Tinh_Yeu_Ke...\nTXT" with the chip having role="button" or
    //    similar click affordance.
    const candidateChips = node.querySelectorAll(
      'file-name-lr-chip, [class*="file-name-lr"], [class*="chip" i]'
    );
    for (const chip of candidateChips) {
      const text = (chip.innerText || chip.textContent || "").trim();
      if (!/\b(TXT|LRC)\b/i.test(text)) continue;
      const m = text.match(/([\wÀ-ỹ\.\-_]+\.(txt|lrc))/i);
      if (!m) continue;
      const anchor = chip.querySelector('a[download], a[href^="blob:"]') || null;
      return {
        anchor,
        href: anchor?.getAttribute("href") || "",
        name: m[1],
        chipRoot: chip,
        nameEl: null,
      };
    }
    return null;
  }

  async function fetchAttachmentAsText(anchor, href) {
    const target = href || anchor?.getAttribute?.("href") || "";
    if (target) {
      try {
        const response = await fetch(target);
        if (response.ok) {
          const text = await response.text();
          if (text && text.trim().length >= 20) return text;
        }
        log("fetchAttachment failed status=" + response.status);
      } catch (error) {
        log("fetchAttachment threw", String(error));
      }
    }
    return null;
  }

  // ── Google Drive viewer/text reader ─────────────────────────────────────────
  //
  // Gemini serves text attachments through Google's internal Drive viewer.
  // The viewer/text endpoint returns a small JSON envelope of the form:
  //   { "mimetype": "text/plain", "data": "<raw LRC text>" }
  // wrapped in an XSSI prefix `)]}'`. Calling this endpoint with the user's
  // existing Gemini cookies (credentials: "include") returns the full file
  // content without any preview click, dialog open, or DOM scraping.
  //
  // IMPORTANT: the content script runs in an isolated world, so we cannot
  // rely on hooking window.fetch to observe Gemini's own requests. Instead
  // we look at the Performance Resource Timing buffer, which is updated
  // for every subresource the page itself fetches — including the
  // viewer/text request Gemini makes after the user opens the file card.
  //
  // Flow:
  //   1) Stamp the click moment with performance.now().
  //   2) Click the file card's open affordance, walking through shadow
  //      DOMs (Gemini uses custom <open-button> elements).
  //   3) Poll performance.getEntriesByType("resource") for a viewer/text
  //      entry whose startTime is at or after the click stamp (with a
  //      small backward tolerance). If nothing new arrives within 8s we
  //      fall back to the freshest viewer/text entry we have, since the
  //      request may already have been in flight at click time.
  //   4) fetch() that URL with credentials: "include", parse JSON.data.
  //
  // No preview/iframe fallback is attempted during this test phase — if
  // we don't see any viewer/text URL, we surface
  // DRIVE_VIEWER_TEXT_URL_NOT_FOUND_AFTER_CLICK and let the caller fail.

  function getDriveViewerTextEntriesFromPerformance() {
    let entries;
    try {
      entries = performance.getEntriesByType("resource") || [];
    } catch (_) {
      return [];
    }
    const out = [];
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i];
      const name = e && e.name;
      if (!name || typeof name !== "string") continue;
      try {
        const u = new URL(name);
        if (
          u.hostname === "drive.google.com" &&
          u.pathname === "/viewer/text" &&
          u.searchParams.get("id")
        ) {
          out.push({
            url: u.href,
            startTime: typeof e.startTime === "number" ? e.startTime : 0,
          });
        }
      } catch (_) { /* noop */ }
    }
    return out;
  }

  // Returns the most recent viewer/text URL whose startTime is at or after
  // `minStartTime` (with a small backward tolerance to absorb clock skew
  // between when we sampled performance.now() and when the resource entry
  // was actually stamped). Falls back to the freshest viewer/text entry if
  // nothing new arrived within the timeout window — covers the case where
  // the resource was already in flight at click time.
  async function waitForDriveViewerTextUrlSince(minStartTime, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 8000);
    const tolerance = 300; // ms
    const floor = (minStartTime || 0) - tolerance;

    while (Date.now() < deadline) {
      const entries = getDriveViewerTextEntriesFromPerformance();

      // Pass 1: any entry stamped at or after the click.
      let newest = null;
      for (let i = 0; i < entries.length; i += 1) {
        if (entries[i].startTime >= floor) {
          if (!newest || entries[i].startTime > newest.startTime) {
            newest = entries[i];
          }
        }
      }
      if (newest) return newest.url;

      // Pass 2: still nothing — wait a tick and retry.
      await sleep(250);
    }

    // Pass 3 (fallback): timeout expired, return the freshest entry we
    // have, regardless of timestamp. This keeps the flow working when the
    // browser clamps startTime resolution or when performance.now() and the
    // resource entry stamp disagree.
    const entries = getDriveViewerTextEntriesFromPerformance();
    if (entries.length === 0) return null;
    let newest = entries[0];
    for (let i = 1; i < entries.length; i += 1) {
      if (entries[i].startTime > newest.startTime) newest = entries[i];
    }
    return newest.url;
  }

  async function fetchDriveViewerText(url) {
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json,text/plain,*/*" },
    });
    if (!res.ok) {
      throw new Error("DRIVE_VIEWER_TEXT_HTTP_" + res.status);
    }
    const raw = await res.text();
    // Google wraps the payload with an XSSI prefix to defeat direct script
    // inclusion: `)]}'\n`. Strip it before JSON.parse.
    const cleaned = raw.replace(/^\)\]\}'\s*/, "").trim();
    let json;
    try {
      json = JSON.parse(cleaned);
    } catch (_) {
      throw new Error("DRIVE_VIEWER_TEXT_JSON_PARSE_FAILED");
    }
    const data = json && typeof json.data === "string" ? json.data : "";
    if (!data || data.trim().length < 20) {
      throw new Error("DRIVE_VIEWER_TEXT_EMPTY");
    }
    return data.trim();
  }

  function findOpenTarget(fileCard) {
    if (!fileCard) return null;

    if (fileCard.matches?.(".chip-lr.clickable")) {
      return fileCard;
    }

    const closestChip = fileCard.closest?.(".chip-lr.clickable");
    if (closestChip) {
      return closestChip;
    }

    const chip = deepQuerySelector(fileCard, ".chip-lr.clickable");
    if (chip) {
      return chip;
    }

    const fileNameEl =
      fileCard.matches?.('[data-test-id="file-name"]')
        ? fileCard
        : deepQuerySelector(fileCard, '[data-test-id="file-name"]');

    if (fileNameEl) {
      const chip2 = fileNameEl.closest(".chip-lr.clickable");
      if (chip2) return chip2;
    }

    return fileCard;
  }

  async function readGeminiFileByDriveViewer({ fileCard, assistantNode: _assistantNode, onProgress }) {
    if (!fileCard) {
      throw new Error("DRIVE_VIEWER_TEXT_NO_FILE_CARD");
    }

    // 1) Stamp the click moment. We use this to filter performance entries
    //    that were stamped at/after the click — much more robust than a
    //    snapshot URL set, because the resource might already be in flight
    //    at click time and the URL would have appeared "before" the click.
    let clickStartTime = 0;
    try { clickStartTime = performance.now(); } catch (_) { clickStartTime = Date.now(); }

    // 2) Click the file card's open affordance (deep query so we pierce
    //    any shadow DOM Gemini uses for its custom <open-button>).
    onProgress?.("Đang mở file LRC từ Gemini để lấy viewer/text URL...");

    // Install the navigation guard BEFORE clicking so Gemini cannot rip the
    // tab away to drive.google.com mid-read. We tear it down as soon as the
    // LRC payload is in hand (success or failure). This is what keeps the
    // content script alive long enough for cleanupGeminiConversationAfterLrc
    // to actually run later.
    cleanupNavGuardInstall();
    let navGuardReason = "done";
    try {
      try {
        if (typeof fileCard.scrollIntoView === "function") {
          fileCard.scrollIntoView({ block: "center" });
        }
      } catch (_) { /* noop */ }

      const openTarget = findOpenTarget(fileCard);
      if (!openTarget) {
        navGuardReason = "no-open-target";
        throw new Error("DRIVE_VIEWER_TEXT_NO_OPEN_TARGET");
      }
      try {
        // Dispatch directly on the chip — no elementFromPoint redirect.
        realClickAt(openTarget, 0.35, 0.5);
      } catch (_) {
        // Fallback to native click if realClickAt somehow can't fire.
        try { openTarget.click(); } catch (__) { /* noop */ }
      }

      // 3) Poll performance entries for a viewer/text URL stamped at or after
      //    the click (≤8s). If nothing matches, fall back to the freshest
      //    viewer/text URL we have.
      const viewerUrl = await waitForDriveViewerTextUrlSince(clickStartTime, 8000);
      if (!viewerUrl) {
        throw new Error("DRIVE_VIEWER_TEXT_URL_NOT_FOUND_AFTER_CLICK");
      }

      onProgress?.("Đã tìm thấy Google Drive viewer/text URL.");
      onProgress?.("Đang đọc file LRC từ Google Drive viewer/text...");

      // 4) Fetch + parse. The fetch targets drive.google.com via XHR which
      //    is a separate connection and is not blocked by the navigation
      //    guard (we only block top-level navigation, not XHR/fetch).
      const text = await fetchDriveViewerText(viewerUrl);
      onProgress?.("Đã đọc nội dung file LRC từ viewer/text.");
      return text;
    } catch (err) {
      navGuardReason = "error:" + (err && err.message ? err.message.slice(0, 40) : "unknown");
      throw err;
    } finally {
      // Tear down nav-guard FIRST so any click we do below isn't blocked.
      cleanupNavGuardRemove(navGuardReason);
      // Close the LRC viewer NOW — don't wait for a later cleanup pass.
      // If we leave the viewer open the "LRC viewer still open" guard in
      // cleanupGeminiConversationAfterLrc blocks the conversation delete.
      try {
        await closeLrcViewerForCleanup();
      } catch (_) { /* best-effort */ }
    }
  }

  // ── File-card preview reading ──────────────────────────────────────────────
  //
  // Gemini returns the LRC as a downloadable file attachment. The card on
  // screen shows the filename and a small "TXT / LRC" chip but the actual
  // contents are only visible after the user opens the file viewer. We
  // click the card to open the viewer, wait for the preview DOM to appear,
  // and read its text. If the preview never appears within 30s we abort
  // with a precise error instead of looping forever.

  const PREVIEW_TIMEOUT_MS = 30 * 1000;
  const PREVIEW_POLL_MS = 250;

  // Selectors tried in order when reading the preview contents.
  const PREVIEW_CONTENT_SELECTORS = [
    '[role="dialog"] pre',
    '[role="dialog"] code',
    '[role="dialog"] [contenteditable="true"]',
    'pre',
    'code',
    '[contenteditable="true"]',
  ];

  // Selectors that indicate a preview/viewer has opened.
  const PREVIEW_DIALOG_SELECTORS = [
    '[role="dialog"]',
    '[role="complementary"]',
    '[aria-modal="true"]',
    'file-viewer',
    'image-viewer',
  ];

  function isPreviewOpen() {
    for (const sel of PREVIEW_DIALOG_SELECTORS) {
      const node = document.querySelector(sel);
      if (node && node.offsetParent !== null) return node;
    }
    return null;
  }

  async function waitForPreviewDialog(timeoutMs = PREVIEW_TIMEOUT_MS) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const dlg = isPreviewOpen();
      if (dlg) return dlg;
      await sleep(PREVIEW_POLL_MS);
    }
    return null;
  }

  function readPreviewText(previewRoot) {
    if (!previewRoot) return "";
    for (const sel of PREVIEW_CONTENT_SELECTORS) {
      const el = previewRoot.querySelector(sel);
      if (!el) continue;
      const t = (el.innerText || el.textContent || "").trim();
      if (t.length >= 20) return t;
    }
    // Fallback: dump the dialog's full innerText.
    return (previewRoot.innerText || previewRoot.textContent || "").trim();
  }

  function closePreview() {
    const closeCandidates = document.querySelectorAll(
      '[aria-label*="close" i], [aria-label*="đóng" i], [data-test-id*="close" i], button[aria-label*="đóng" i]'
    );
    for (const node of closeCandidates) {
      try { node.click(); } catch (_) { /* noop */ }
    }
    // Last resort: press Escape.
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true }));
    } catch (_) { /* noop */ }
  }

  /**
   * Clicks a file card so its preview opens, then reads the text content of
   * the preview viewer. Returns the raw text or throws
   * `GEMINI_ATTACHMENT_TEXT_EMPTY` / `GEMINI_PREVIEW_TIMEOUT`.
   *
   * @param {HTMLElement} fileCard - the chip element representing the file.
   * @returns {Promise<string>}
   */
  async function readGeminiAttachmentText(fileCard) {
    if (!fileCard) throw new Error("GEMINI_NO_FILE_CARD");
    try {
      fileCard.scrollIntoView({ block: "center" });
    } catch (_) { /* noop */ }
    try {
      fileCard.click();
    } catch (error) {
      log("fileCard.click threw", String(error));
    }

    const preview = await waitForPreviewDialog();
    if (!preview) {
      throw new Error(
        "GEMINI_PREVIEW_TIMEOUT: không mở được preview cho file sau " +
          Math.round(PREVIEW_TIMEOUT_MS / 1000) + "s."
      );
    }

    // The preview may render the text asynchronously. Poll briefly until
    // the content is non-empty.
    let text = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      text = readPreviewText(preview);
      if (text && text.length >= 20) break;
      await sleep(150);
    }

    closePreview();

    if (!text || text.trim().length < 20) {
      throw new Error("GEMINI_ATTACHMENT_TEXT_EMPTY");
    }
    return text.trim();
  }

  // ── LRC extraction ─────────────────────────────────────────────────────────
  //
  // We NEVER read `document.body.innerText` and we NEVER scan old responses.
  // The caller (waitForResult) passes a `startSnapshot` taken *before* the
  // prompt was sent. We only consider assistant message nodes that appear
  // AFTER that snapshot.
  //
  // LRC source priority:
  //   1. File attachment (.txt / .lrc) inside a NEW assistant node — the
  //      expected path now that Gemini returns the LRC as a downloadable
  //      file card.
  //   2. Inline LRC text inside the new assistant node (fallback for
  //      sessions where Gemini still emits raw text).

  const ASSISTANT_NODE_SELECTORS = [
    "[data-message-author=\"model\"]",
    "[data-message-author=\"assistant\"]",
    "[data-test-id*=\"model-response\"]",
    "[data-test-id*=\"assistant-message\"]",
    "message-content",
    "model-response",
    "[data-author=\"model\"]",
    "[data-author=\"assistant\"]",
  ];

  function assistantNodes() {
    const out = [];
    const seen = new Set();
    for (const sel of ASSISTANT_NODE_SELECTORS) {
      const nodes = document.querySelectorAll(sel);
      for (const node of nodes) {
        if (seen.has(node)) continue;
        seen.add(node);
        out.push(node);
      }
    }
    return out;
  }

  function takeAssistantSnapshot() {
    // Stable ordered list of DOM nodes currently representing assistant
    // responses. Used to detect "new responses since X".
    return assistantNodes().slice();
  }

  function nodesAfterSnapshot(snapshot) {
    // Return assistant nodes that appeared AFTER the snapshot was taken.
    // If no nodes appear, returns [].
    if (!snapshot || snapshot.length === 0) {
      // No snapshot (first ever message) — treat the first assistant node
      // we see as "new".
      return assistantNodes();
    }
    const lastSnapshotNode = snapshot[snapshot.length - 1];
    const all = assistantNodes();
    const out = [];
    let passed = false;
    for (const node of all) {
      if (node === lastSnapshotNode) {
        passed = true;
        continue;
      }
      if (passed) out.push(node);
    }
    return out;
  }

  function getAssistantResponseText(node) {
    if (!node) return "";
    return (node.innerText || node.textContent || "").trim();
  }

  function pageHasProgressToken() {
    // Hard guard: refuse to extract LRC while Gemini UI still shows any
    // "verifying/generating/thinking" indicator anywhere in the DOM.
    // This intentionally reads more than the assistant node, because the
    // progress badge lives in a separate toolbar/status region, not inside
    // the assistant message itself.
    const haystack = (document.body && (document.body.innerText || "")) || "";
    const lc = haystack.toLowerCase();
    return IN_PROGRESS_TOKENS.some((token) => lc.includes(token));
  }

  function countTimestampLines(text) {
    if (!text) return 0;
    let n = 0;
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (LRC_TIME_REGEX.test(line)) n += 1;
    }
    return n;
  }

  // ── LRC normalization ──────────────────────────────────────────────────────
  //
  // Gemini sometimes emits [hh:mm:ss.xx] timestamps. We always store LRC in
  // [mm:ss.xx] form, so collapse any [hh:mm:ss.xx] (or hh:mm:ss without
  // fractional part) down to [mm:ss.xx] before validating and saving.
  //
  // Examples:
  //   [01:02:03.45] -> [62:03.45]   (mm wraps when hh > 0)
  //   [00:01:23]    -> [01:23]      (no fractional part preserved)
  //   [00:01:23.456] -> [01:23.456] (3-digit fraction preserved)
  //   [01:23.45]    -> [01:23.45]   (already canonical — untouched)
  //
  // Returns the normalized text. If anything looks off (e.g. >99 hours,
  // non-numeric fragments), we leave that token alone rather than corrupt it.
  function normalizeLrcText(text) {
    if (!text || typeof text !== "string") return text;
    const HOUR = /(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})([.:]\d{1,3})?/;
    return text.replace(/\[([^\]\n]+)\]/g, (bracket, inner) => {
      // Only rewrite tags whose entire content is a timestamp (possibly with
      // trailing whitespace). Anything else — e.g. [ar: artist] — passes
      // through unchanged.
      const m = inner.match(HOUR);
      if (!m) return bracket;
      const [, hhRaw, mmRaw, ssRaw, fracRaw] = m;
      // If the regex consumed the whole inner string, normalize. Otherwise
      // there is trailing metadata after the timestamp — leave it alone.
      const matched = m[0];
      if (matched.length !== inner.length) return bracket;

      const hh = hhRaw == null ? 0 : parseInt(hhRaw, 10);
      const mm = parseInt(mmRaw, 10);
      const ss = parseInt(ssRaw, 10);
      if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) {
        return bracket;
      }
      const totalMinutes = hh * 60 + mm;
      // Keep fraction punctuation consistent: '.'
      const frac = fracRaw ? fracRaw.replace(/^:/, ".") : "";
      return "[" + totalMinutes + ":" + String(ss).padStart(2, "0") + frac + "]";
    });
  }

  // ── LRC validation ────────────────────────────────────────────────────────
  //
  // Three shapes are accepted:
  //   1) "raw" — direct LRC text with [mm:ss.xx] timestamps.
  //   2) "python" — Gemini sometimes wraps LRC inside a Python code block:
  //         lrc_content = """
  //         [00:12.34]Lời bài hát
  //         ...
  //         """
  //      or
  //         lrc_content = '''
  //         [00:12.34]Lời bài hát
  //         ...
  //         '''
  //      or
  //         ```lrc
  //         ...
  //         ```
  //   3) "markdown" — generic ``` fenced code block containing LRC text.
  //
  // Returns { ok, format, reason, timestampLineCount }. The caller MUST
  // refuse to save when ok=false.

  function validateLrcText(text) {
    if (!text || typeof text !== "string") {
      return { ok: false, reason: "EMPTY", format: null, timestampLineCount: 0 };
    }
    const trimmed = text.trim();
    if (trimmed.length < 20) {
      return { ok: false, reason: "TOO_SHORT", format: null, timestampLineCount: 0 };
    }

    // Format 1: raw LRC.
    const rawCount = countTimestampLines(trimmed);
    if (rawCount >= MIN_TIMESTAMP_LINES) {
      return { ok: true, format: "raw", reason: null, timestampLineCount: rawCount };
    }

    // Format 2: Python wrapper `lrc_content = """..."""`.
    const pyTripleDouble = trimmed.match(/lrc_content\s*=\s*"""([\s\S]*?)"""/i);
    const pyTripleSingle = trimmed.match(/lrc_content\s*=\s*'''([\s\S]*?)'''/i);
    const pyInner =
      (pyTripleDouble && pyTripleDouble[1]) ||
      (pyTripleSingle && pyTripleSingle[1]) ||
      null;
    if (pyInner && countTimestampLines(pyInner) >= MIN_TIMESTAMP_LINES) {
      return {
        ok: true,
        format: "python",
        reason: null,
        timestampLineCount: countTimestampLines(pyInner),
      };
    }

    // Format 3: Markdown ``` fenced code block.
    const fenceMatch = trimmed.match(/```(?:lrc|lyrics|text)?\s*\n([\s\S]*?)```/i);
    if (fenceMatch && countTimestampLines(fenceMatch[1]) >= MIN_TIMESTAMP_LINES) {
      return {
        ok: true,
        format: "markdown",
        reason: null,
        timestampLineCount: countTimestampLines(fenceMatch[1]),
      };
    }

    return {
      ok: false,
      reason:
        "Không tìm thấy ≥" +
        MIN_TIMESTAMP_LINES +
        " dòng [mm:ss.xx] trong raw LRC / Python wrapper / markdown code block.",
      format: null,
      timestampLineCount: rawCount,
    };
  }

  function findLrcAttachment() {
    // Deprecated. Kept as a thin wrapper for any caller that still uses it
    // (none expected — waitForResult now uses findFileAttachmentIn on each
    // new assistant node instead of scanning the whole document).
    const node = assistantNodes().slice(-1)[0] || document.body;
    return findFileAttachmentIn(node);
  }

  async function readAnchorAsText(anchor, _isChip) {
    if (!anchor) return null;
    const href = anchor.getAttribute?.("href") || "";
    return await fetchAttachmentAsText(anchor, href);
  }

  async function waitForResult({ cancelledRef, onProgress, snapshot }) {
    // Snapshot of assistant nodes BEFORE the prompt was sent. We only consider
    // assistant message nodes that appear AFTER this snapshot, and within
    // those nodes we look for an LRC FILE ATTACHMENT (.txt/.lrc).
    //
    // Order of checks each iteration:
    //   1) Look for an attachment FIRST. If we find one, process it right
    //      away — we don't let the "Verifying / Generating" progress token
    //      block us because Gemini often shows those tokens for a few seconds
    //      AFTER the file card has already rendered, and the file content
    //      is what the user actually wants.
    //   2) If no attachment, check progress token and wait.
    //   3) If still nothing, wait for new assistant nodes.
    const start = Date.now();
    let lastReport = 0;
    let announcedAttachment = false;

    while (!cancelledRef.current && Date.now() - start < RESPONSE_TIMEOUT_MS) {
      // 1) Look at new assistant response nodes first.
      const newNodes = nodesAfterSnapshot(snapshot);

      // 2) Try to find an attachment in any new assistant node BEFORE
      //    gating on the progress token. Gemini often paints the file
      //    card while a stale "Generating" badge is still on screen.
      let foundAttachment = null;
      if (newNodes.length > 0) {
        for (let i = newNodes.length - 1; i >= 0; i -= 1) {
          const att = findFileAttachmentIn(newNodes[i]);
          if (att && att.name) {
            foundAttachment = att;
            break;
          }
        }
      }

      if (foundAttachment) {
        if (!announcedAttachment) {
          const display = foundAttachment.name.length > 32
            ? foundAttachment.name.slice(0, 30) + "…"
            : foundAttachment.name;
          onProgress?.("Gemini đã trả về file LRC ứng viên: " + display);
          announcedAttachment = true;
          lastReport = Date.now();
        }

        // 3) ONLY path during testing: Google Drive viewer/text. We
        //    intentionally do NOT fall back to blob-href fetch or to the
        //    inline preview viewer while we verify that the Drive endpoint
        //    can deliver the full LRC content for every Gemini response.
        let fileText = null;
        try {
          fileText = await readGeminiFileByDriveViewer({
            fileCard:
              foundAttachment.chipRoot ||
              foundAttachment.anchor ||
              foundAttachment.nameEl,
            assistantNode:
              foundAttachment.assistantNode ||
              foundAttachment.node ||
              newNodes[newNodes.length - 1],
            onProgress,
          });
        } catch (error) {
          onProgress?.(
            "Không lấy được LRC bằng Google Drive viewer/text: " +
              (error?.message || String(error))
          );
          // TẠM THỜI KHÔNG FALLBACK PREVIEW NỮA
          throw new Error(
            "DRIVE_VIEWER_TEXT_FAILED_NO_PREVIEW_FALLBACK: " +
              (error?.message || String(error))
          );
        }

        // Normalize first: collapse any [hh:mm:ss.xx] down to [mm:ss.xx],
        // then validate. The saved LRC is always the normalized form so we
        // never persist [00:00:03.00] style timestamps.
        fileText = normalizeLrcText(fileText);
        const validation = validateLrcText(fileText);
        if (!validation.ok) {
          onProgress?.(
            "Không phải LRC hợp lệ: " + (validation.reason || "INVALID_LRC_ATTACHMENT")
          );
          throw new Error(
            "INVALID_LRC_ATTACHMENT: " + (validation.reason || "không parse được LRC.")
          );
        }

        onProgress?.("Đã trích xuất " + validation.timestampLineCount + " dòng LRC.");

        return {
          lrcText: fileText,
          savedAsFile: true,
          fileName: foundAttachment.name,
          timestampLineCount: validation.timestampLineCount,
          lrcFormat: validation.format,
        };
      }

      // 5) No attachment yet. Now — and ONLY now — gate on the progress
      //    token. We refuse to read inline assistant text because the user
      //    explicitly asked for the file attachment path.
      if (pageHasProgressToken()) {
        if (Date.now() - lastReport > 3000) {
          onProgress?.("Đang chờ Gemini tạo file LRC...");
          lastReport = Date.now();
        }
        await sleep(1000);
        continue;
      }

      if (newNodes.length === 0) {
        if (Date.now() - lastReport > 5000) {
          onProgress?.("Đang chờ Gemini hoàn tất phản hồi...");
          lastReport = Date.now();
        }
        await sleep(1000);
        continue;
      }

      // 6) No attachment in any of the new nodes yet. Wait.
      if (Date.now() - lastReport > 5000) {
        onProgress?.("Đang chờ Gemini tạo file LRC...");
        lastReport = Date.now();
      }
      await sleep(1000);
    }

    if (cancelledRef.current) {
      throw new Error("Đã hủy trong khi chờ Gemini trả lời.");
    }
    throw new Error(
      "Hết thời gian chờ Gemini trả lời (" +
        Math.round(RESPONSE_TIMEOUT_MS / 60000) +
        " phút)."
    );
  }

  // ── Job orchestration ───────────────────────────────────────────────────────
  async function waitForGeminiStable({ onProgress } = {}) {
    // Wait until Gemini's UI has settled: composer is present, no in-flight
    // loading spinner visible, and DOM mutations have quieted down for at
    // least 500ms. Without this, a freshly opened tab can look "ready"
    // (composer visible) but the model/thinking menu hasn't been hydrated
    // yet — selectModel / selectThinkingLevel then fail with "Không tìm
    // thấy" and the prompt gets sent immediately at line 2026, before the
    // user has actually finished picking a config.
    onProgress?.("Đang chờ trang Gemini ổn định...");

    const COMPOSER = "div.ql-editor[contenteditable=\"true\"], div[contenteditable=\"true\"][role=\"textbox\"]";
    const LOADING_NEEDLE = /(đang\s*tải|loading|generating|thinking|đang\s*sinh|đang\s*phản\s*hồi)/i;

    const start = Date.now();
    const TIMEOUT_MS = 15000;
    let lastMutations = Date.now();
    const mutationObserver = new MutationObserver(() => {
      lastMutations = Date.now();
    });
    try {
      mutationObserver.observe(document.documentElement || document.body, {
        childList: true, subtree: true, characterData: true,
      });
    } catch (_) { /* sandboxed */ }

    try {
      while (Date.now() - start < TIMEOUT_MS) {
        // 1. Composer must exist and be visible.
        const composer = document.querySelector(COMPOSER);
        const composerReady = composer && composer.getBoundingClientRect().height > 0;

        // 2. No visible "loading / generating" text.
        let stillLoading = false;
        try {
          const all = document.querySelectorAll("div, span, p, button");
          for (let i = 0; i < all.length; i += 1) {
            const t = (all[i].textContent || "").trim();
            if (t && t.length < 80 && LOADING_NEEDLE.test(t)) {
              // Heuristic: must be visible-ish (non-zero box).
              if (all[i].getBoundingClientRect().height > 0) {
                stillLoading = true;
                break;
              }
            }
          }
        } catch (_) { /* keep going */ }

        // 3. DOM must have been quiet for at least 500ms.
        const quiet = Date.now() - lastMutations >= 500;

        if (composerReady && !stillLoading && quiet) {
          log("Gemini page is STABLE (composerReady + !loading + 500ms quiet)");
          return true;
        }
        await sleep(150);
      }
      console.warn(
        "[gemini-lrc] waitForGeminiStable: timed out after " + TIMEOUT_MS +
          "ms — proceeding anyway (composerReady + best effort)."
      );
      return false;
    } finally {
      try { mutationObserver.disconnect(); } catch (_) { /* noop */ }
    }
  }

  async function startJob({ correlationId, jobId, prompt }) {
    if (!acquireTabLock(jobId || null)) {
      log("startJob SKIPPED — another instance holds the tab lock for jobId=" + jobId);
      return;
    }
    CURRENT_JOB_ID = jobId || CURRENT_JOB_ID || null;

    // Announce ourselves to the background so it can pick ONE content
    // script per jobId. If a duplicate injection beat us to it, PORT_ALLOWED
    // stays false and every subsequent `send()` is dropped on the floor.
    openBackgroundPort(CURRENT_JOB_ID);
    // Give the welcome/bail handshake a tick to settle so the first
    // reportProgress() inside this function lands on a known state.
    await sleep(80);
    if (backgroundPort && PORT_ALLOWED === false) {
      log("startJob SKIPPED — background marked this content script as duplicate.");
      clearTabLock(MY_TAB_LOCK_ID);
      return;
    }

    const job = { cancelled: false, observer: null, timeout: null };
    activeJobs.set(correlationId, job);
    const cancelledRef = { get current() { return job.cancelled; } };

    log("LOCK_ACQUIRED");

    try {
      if (isLoggedOut()) {
        reportProgress(correlationId, {
          step: "need-login",
          needLogin: true,
          message: "Cần đăng nhập Gemini thủ công trong tab đang mở.",
        });
        return;
      }

      const composer = await waitForComposer();
      if (!composer) throw new Error("Không tìm thấy khung nhập câu hỏi của Gemini.");
      if (job.cancelled) throw new Error("Đã hủy trước khi gửi prompt.");

      // Page-stability gate. Gemini SPA hydrates the composer and the
      // model/thinking menu asynchronously; running selectModel /
      // selectThinkingLevel before hydration finishes yields a flaky
      // "Không tìm thấy" failure and the prompt gets submitted with the
      // default (wrong) thinking level. waitForGeminiStable waits for
      // composer to be present, no visible loading/Generating text, and
      // 500ms of DOM quiet before we proceed.
      await waitForGeminiStable({
        onProgress: (m) => reportProgress(correlationId, { message: m }),
      });

      log("INSERT_PROMPT_START");
      reportProgress(correlationId, { step: "insert-prompt", message: "Đang chèn prompt vào Gemini..." });
      insertPrompt(prompt);
      log("INSERT_PROMPT_DONE");
      if (job.cancelled) throw new Error("Đã hủy trước khi chọn model.");

      // Brief settle so the model's "send" affordance has a chance to
      // become enabled (it can be disabled while the assistant is busy
      // replying to the previous turn). Without this, selectModel can
      // open the menu while the page is still in a transitional state.
      await sleep(400);

      log("MODEL_SELECTING");
      reportProgress(correlationId, { step: "selecting-model", message: "Đang chọn model 3.1 Pro..." });
      try {
        await selectModel({ onProgress: (m) => reportProgress(correlationId, { message: m }) });
      } catch (error) {
        if (!/Không tìm thấy/.test(error.message)) throw error;
      }
      log("MODEL_SELECTED");
      if (job.cancelled) throw new Error("Đã hủy sau khi chọn model.");

      await sleep(300);

      log("THINKING_SELECTING");
      reportProgress(correlationId, {
        step: "selecting-thinking",
        message: "Đang chọn cấp độ tư duy Mở rộng...",
      });
      let thinkingResult = { found: false };
      // Retry selectThinkingLevel up to 2 extra times. The first attempt
      // often races against Gemini's lazy menu hydration; a 1-second gap
      // plus a re-render usually lets the "Cấp độ tư duy" row appear.
      // Only swallow errors that explicitly say "Không tìm thấy" — any
      // other failure (real DOM error, layout shift, etc.) bubbles up so
      // we don't silently mask a regression.
      for (let thinkingAttempt = 0; thinkingAttempt < 3; thinkingAttempt += 1) {
        if (thinkingAttempt > 0) {
          log("selectThinkingLevel retry #" + thinkingAttempt);
          reportProgress(correlationId, {
            step: "selecting-thinking-retry",
            message:
              "Đang thử lại chọn cấp độ tư duy (lần " + (thinkingAttempt + 1) + "/3)...",
          });
          await sleep(1000);
          try { closeAnyOverlay(); } catch (_) { /* noop */ }
          await sleep(250);
        }
        try {
          thinkingResult = await selectThinkingLevel({
            onProgress: (m) => reportProgress(correlationId, { message: m }),
          });
        } catch (error) {
          if (!/Không tìm thấy/.test(error.message)) throw error;
          thinkingResult = { found: true, selected: false };
        }
        if (thinkingResult.selected) break;
      }
      log("THINKING_SELECTED", thinkingResult);
      if (!thinkingResult.found) {
        reportProgress(correlationId, {
          step: "thinking-warning",
          message:
            "Không tìm thấy cấp độ tư duy Mở rộng, tiếp tục với cấu hình Gemini hiện tại.",
        });
      } else if (!thinkingResult.selected) {
        reportProgress(correlationId, {
          step: "thinking-warning",
          message:
            "Không tìm thấy 'Mở rộng' trong menu, tiếp tục với cấu hình Gemini hiện tại.",
        });
      }
      if (job.cancelled) throw new Error("Đã hủy trước khi gửi.");

      // Snapshot assistant nodes BEFORE we send the prompt. After sending,
      // we only consider nodes that appear after this snapshot.
      const snapshot = takeAssistantSnapshot();
      log("SNAPSHOT_BEFORE_SEND count=" + snapshot.length);

      // clickSend returns { ok, method } or throws.
      const sendResult = await clickSend(prompt);
      reportProgress(correlationId, {
        step: "waiting-for-result",
        message: "Đã gửi prompt, đang chờ Gemini trả lời...",
      });
      log("WAITING_RESPONSE method=" + sendResult.method);

      // Capture the target conversation ID immediately after send. Some
      // Gemini builds keep the URL on /app until the response starts streaming,
      // so wait briefly for the URL to switch to /app/<conversationId>.
      captureTargetConversation("after-send");
      const capturedId = await waitForConversationIdFromUrl(8000);
      if (capturedId) {
        TARGET_CONVERSATION_ID = capturedId;
        TARGET_CONVERSATION_URL = window.location.href;
        cleanupLog("target conversation id confirmed: " + capturedId);
      } else {
        cleanupLog("warn: target conversation id not seen within 8s; URL=" + window.location.href.slice(0, 120));
      }

      const result = await waitForResult({
        cancelledRef,
        onProgress: (m) => reportProgress(correlationId, { message: m }),
        snapshot,
      });
      const tsLines = result.timestampLineCount || countTimestampLines(result.lrcText || "");
      log(
        "RESULT_READY tsLines=" + tsLines +
          " savedAsFile=" + !!result.savedAsFile +
          " fileName=" + (result.fileName || "") +
          " format=" + (result.lrcFormat || "?")
      );
      // result.lrcText is the raw content of the file attachment Gemini
      // returned. The sidepanel will run extractLrcFromGeminiOutput() on it
      // to handle raw LRC / Python wrapper / markdown, then save as
      // svdmusic/lrc/{videoId}.lrc — never as the original Gemini filename.
      reportLrcReady(correlationId, {
        lrcText: result.lrcText || "",
        savedAsFile: !!result.savedAsFile,
        fileName: result.fileName || "",
        timestampLineCount: tsLines,
        lrcFormat: result.lrcFormat || "raw",
      });
    } catch (error) {
      log("ERROR", error.message || String(error));
      reportError(correlationId, error.message || String(error));
    } finally {
      cleanupJob(correlationId);
      clearTabLock(MY_TAB_LOCK_ID);
    }
  }

  function isLoggedOut() {
    const url = window.location.href;
    if (/\/signin|\/signedout/i.test(url)) return true;
    const signIn = Array.from(document.querySelectorAll("a, button")).find(
      (node) => /^(đăng\s*nhập|sign\s*in)$/i.test((node.textContent || "").trim())
    );
    if (signIn) return true;
    if (!findComposer()) return true;
    return false;
  }

  function cancelJob(correlationId) {
    const job = activeJobs.get(correlationId);
    if (!job) return;
    job.cancelled = true;
    cleanupJob(correlationId);
  }

  function cleanupJob(correlationId) {
    const job = activeJobs.get(correlationId);
    if (!job) return;
    if (job.observer) {
      try { job.observer.disconnect(); } catch (_) { /* noop */ }
    }
    if (job.timeout) clearTimeout(job.timeout);
    activeJobs.delete(correlationId);
  }

  // ── Message listener ────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;
    // `gemini/ping` is a liveness probe from `ensureGeminiTab`. The
    // background polls this up to 30×500ms while it waits for the
    // content script to attach. We must answer the ping SYNCHRONOUSLY
    // (no `correlationId` required) so the polling loop terminates as
    // soon as the listener is registered. If we required correlationId
    // here the probe would always return false and the polling loop
    // would burn its full 15-second budget on every single call — that
    // is what was producing the "đợi 16s mới chèn prompt" symptom.
    if (message.type === "gemini/ping") {
      try { sendResponse({ ok: true, ts: Date.now() }); } catch (_) { /* port closed */ }
      return false; // synchronous response — no need to keep channel open
    }
    if (!message.correlationId) return false;
    if (message.type === "gemini/start-lrc") {
      const { correlationId, jobId, prompt } = message;
      sendResponse({ ok: true });
      startJob({ correlationId, jobId, prompt }).catch((error) => {
        reportError(correlationId, error.message || String(error));
      });
      return true;
    }
    if (message.type === "gemini/continue") {
      const { correlationId, jobId } = message;
      sendResponse({ ok: true });
      startJob({ correlationId, jobId, prompt: "" }).catch((error) => {
        reportError(correlationId, error.message || String(error));
      });
      return true;
    }
    if (message.type === "gemini/cancel") {
      cancelJob(message.correlationId);
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === "svdmusic/cleanup-conversation") {
      // Background báo đã hoàn tất LRC + tải nhạc về → dọn conversation
      // hiện tại. Best-effort: lỗi chỉ log, không bao giờ fail caller.
      cleanupLog(
        "received cleanup-conversation reason=" + (message.reason || "?") +
        " correlationId=" + (message.correlationId || "?") +
        " videoId=" + (message.videoId || "?") +
        " currentUrl=" + window.location.href
      );
      sendResponse({ ok: true });
      cleanupGeminiConversationAfterLrc().catch((err) => {
        console.warn("[gemini-lrc] cleanup-on-message exception:", err);
      });
      return true;
    }
    return false;
  });
})();
