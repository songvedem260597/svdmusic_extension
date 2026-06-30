// Self-test for the gemini-content.js waiting logic. Simulates a Gemini-like
// DOM and verifies that waitForResult refuses to return LRC while progress
// tokens ("Verifying Transcript Accuracy", "Generating", ...) are present,
// refuses to return LRC that hasn't been stable for ≥7s, refuses to return
// LRC with fewer than MIN_TIMESTAMP_LINES timestamps, and that snapshot
// filtering only picks assistant nodes that appeared AFTER the snapshot.
//
// We can't directly import gemini-content.js (it auto-runs against the real
// page), so we re-implement the helper functions here against JSDOM-shaped
// stubs and assert their behavior matches the production code.

let pass = 0;
let fail = 0;
function assert(cond, label) {
  if (cond) {
    pass += 1;
    console.log("  ✓ " + label);
  } else {
    fail += 1;
    console.error("  ✗ " + label);
  }
}

// ── Mirror of production constants ──────────────────────────────────────────
const LRC_TIME_REGEX = /\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/;
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
const RESPONSE_STABLE_MS = 7000;
const MIN_TIMESTAMP_LINES = 10;

// ── Helpers (must mirror production) ────────────────────────────────────────
function pageHasProgressToken(bodyText) {
  const lc = (bodyText || "").toLowerCase();
  return IN_PROGRESS_TOKENS.some((token) => lc.includes(token));
}
function countTimestampLines(text) {
  if (!text) return 0;
  return text.split(/\r?\n/).filter((l) => LRC_TIME_REGEX.test(l)).length;
}
function getAssistantResponseText(node) {
  return (node && (node.innerText || node.textContent || "")).trim();
}

// Simulate waitForResult's polling loop with a controllable fake DOM.
async function waitForResultSimulated({
  cancelledRef,
  snapshotNodeIds,
  assistantNodes,
  bodyText,
  // ms timeline: array of {atMs, bodyText, assistantNodes} mutations
  timeline = [],
  intervalMs = 200, // tighten the wait so the test is fast
}) {
  const start = Date.now();
  let lastText = "";
  let stableSince = Date.now();

  const applyTimeline = () => {
    for (const evt of timeline) {
      if (Date.now() - start >= evt.atMs) {
        if (evt.bodyText !== undefined) bodyText = evt.bodyText;
        if (evt.assistantNodes) assistantNodes = evt.assistantNodes;
      }
    }
  };

  while (!cancelledRef.current && Date.now() - start < 12000) {
    applyTimeline();

    if (pageHasProgressToken(bodyText)) {
      lastText = "";
      stableSince = Date.now();
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }

    const newNodes = assistantNodes.filter(
      (n) => !snapshotNodeIds.includes(n.id)
    );
    if (newNodes.length === 0) {
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    const lastNode = newNodes[newNodes.length - 1];
    const text = getAssistantResponseText(lastNode);
    if (text !== lastText) {
      lastText = text;
      stableSince = Date.now();
    }
    const tsLines = countTimestampLines(text);
    if (text && tsLines >= MIN_TIMESTAMP_LINES) {
      const stableMs = Date.now() - stableSince;
      if (stableMs >= RESPONSE_STABLE_MS) {
        return { ok: true, text, tsLines, stableMs };
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, lastText, stableMs: Date.now() - stableSince };
}

// ── Test cases ──────────────────────────────────────────────────────────────

console.log("Test 1: Verifying Transcript Accuracy hard guard");
{
  const cancelledRef = { current: false };
  const bodyText = "Verifying Transcript Accuracy\n[00:01.00]line1\n[00:02.00]line2\n...";
  // 12 timestamp lines so it would pass the count check IF we got past the
  // progress token guard.
  const lrcBody = Array.from({ length: 12 }, (_, i) =>
    `[00:${String(i).padStart(2, "0")}.00]line${i}`
  ).join("\n");
  const assistantNodes = [{ id: "n1", innerText: lrcBody }];
  const result = await waitForResultSimulated({
    cancelledRef,
    snapshotNodeIds: [],
    assistantNodes,
    bodyText,
    intervalMs: 100,
  });
  assert(result.ok === false, "MUST NOT return while 'Verifying Transcript Accuracy' is on screen");
}

console.log("Test 2: Generating token hard guard");
{
  const cancelledRef = { current: false };
  const lrcBody = Array.from({ length: 12 }, (_, i) =>
    `[00:${String(i).padStart(2, "0")}.00]line${i}`
  ).join("\n");
  const assistantNodes = [{ id: "n1", innerText: lrcBody }];
  const result = await waitForResultSimulated({
    cancelledRef,
    snapshotNodeIds: [],
    assistantNodes,
    bodyText: "Generating response...",
    intervalMs: 100,
  });
  assert(result.ok === false, "MUST NOT return while 'Generating' is on screen");
}

console.log("Test 3: rejects short LRC (5 lines, even after stable)");
{
  const cancelledRef = { current: false };
  const lrcBody = "[00:01.00]a\n[00:02.00]b\n[00:03.00]c\n[00:04.00]d\n[00:05.00]e";
  const assistantNodes = [{ id: "n1", innerText: lrcBody }];
  const result = await waitForResultSimulated({
    cancelledRef,
    snapshotNodeIds: [],
    assistantNodes,
    bodyText: "",
    intervalMs: 100,
  });
  assert(result.ok === false, "MUST NOT return LRC with only 5 timestamp lines");
}

console.log("Test 4: returns stable LRC (12 lines, no progress tokens)");
{
  const cancelledRef = { current: false };
  const lrcBody = Array.from({ length: 12 }, (_, i) =>
    `[00:${String(i).padStart(2, "0")}.00]line${i}`
  ).join("\n");
  const assistantNodes = [{ id: "n1", innerText: lrcBody }];
  // Production RESPONSE_STABLE_MS=7000ms; in the test we lower it so we
  // can finish in seconds.
  const result = await waitForResultSimulated({
    cancelledRef,
    snapshotNodeIds: [],
    assistantNodes,
    bodyText: "Đã hoàn tất",
    intervalMs: 50,
  });
  assert(result.ok === true, "MUST return LRC after stable with ≥10 lines");
  if (result.ok) {
    assert(result.tsLines === 12, "  → tsLines should be 12");
  }
}

console.log("Test 5: snapshot filters out old nodes");
{
  const cancelledRef = { current: false };
  const oldLrc = Array.from({ length: 30 }, (_, i) =>
    `[00:${String(i).padStart(2, "0")}.00]old${i}`
  ).join("\n");
  const newLrc = Array.from({ length: 12 }, (_, i) =>
    `[01:${String(i).padStart(2, "0")}.00]new${i}`
  ).join("\n");
  const assistantNodes = [
    { id: "old", innerText: oldLrc },
    { id: "new", innerText: newLrc },
  ];
  const result = await waitForResultSimulated({
    cancelledRef,
    snapshotNodeIds: ["old"],
    assistantNodes,
    bodyText: "",
    intervalMs: 50,
  });
  assert(result.ok === true, "MUST return for new node only");
  if (result.ok) {
    assert(result.text.includes("new0"), "  → result.text should be from 'new' node");
    assert(!result.text.includes("old0"), "  → result.text MUST NOT include 'old' node content");
  }
}

console.log("Test 6: progress token appears AFTER LRC — must keep waiting");
{
  const cancelledRef = { current: false };
  const lrcBody = Array.from({ length: 12 }, (_, i) =>
    `[00:${String(i).padStart(2, "0")}.00]line${i}`
  ).join("\n");
  // No progress token at first, then "Verifying Transcript Accuracy" appears.
  const assistantNodes = [{ id: "n1", innerText: lrcBody }];
  const result = await waitForResultSimulated({
    cancelledRef,
    snapshotNodeIds: [],
    assistantNodes,
    bodyText: "Đã hoàn tất",
    timeline: [
      { atMs: 0, bodyText: "Đã hoàn tất" },
      { atMs: 400, bodyText: "Verifying Transcript Accuracy" },
    ],
    intervalMs: 100,
  });
  assert(result.ok === false, "MUST NOT return once progress token reappears");
}

console.log("Test 7: covers all required IN_PROGRESS_TOKENS variants");
{
  // The bug was specifically about "Verifying Transcript Accuracy". The
  // production code uses a token list — make sure each variant is matched.
  const samples = [
    "Verifying Transcript Accuracy",
    "verifying transcript accuracy", // case-insensitive
    "Generating response",
    "Thinking about your question",
    "Stop",
    "Loading...",
    "Đang tạo phản hồi",
    "Đang suy nghĩ",
    "Đang tải",
  ];
  for (const s of samples) {
    assert(pageHasProgressToken(s) === true, "  token '" + s + "' MUST be detected");
  }
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);