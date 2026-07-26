// Tests the MP3 fallback-eligibility decision in src/background.js.
//
// Symptom this guards against: "Không thể tải MP3. Đã hủy thêm bài và xoá dữ
// liệu tạm. (HTTP 200)". The yt2mp3 provider answered 200 and handed back an
// HTML error page instead of audio. validateMp3Blob correctly rejected it, but
// the eligibility test only looked at status codes (403/404/410/429/5xx) and a
// handful of message regexes — none of which match a 200. So the MP3Cow
// fallback was skipped and the add failed outright, even though the second
// provider was sitting right there.
//
// Whether it *did* fall back came down to whether the error text happened to
// contain "audio" (via `type=audio/mpeg`), i.e. pure luck.
//
// The predicate is not exported — it is an inline expression inside a large
// catch block — so the test extracts it from source at run time. That way the
// test can never drift from the shipped logic.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BG = readFileSync(resolve(HERE, "../src/background.js"), "utf8");

// ── Extract the real predicate ─────────────────────────────────────────────
const startMarker = "const providerPayloadUnusable";
const endMarker = "if (!isFallbackEligible)";
const start = BG.indexOf(startMarker);
const end = BG.indexOf(endMarker, start);
if (start === -1 || end === -1) {
  console.error("  FAILED: could not locate the fallback predicate in background.js");
  console.error("  (did the variable names change? update this test alongside them)");
  process.exit(1);
}
const snippet = BG.slice(start, end);

// `extractHttpStatus` is a helper the predicate calls; stub it with the same
// behaviour (scrape the first 3-digit HTTP code out of the message).
const evaluate = new Function(
  "error",
  "errMsg",
  "httpStatus",
  "extractHttpStatus",
  snippet + "\n return isFallbackEligible;"
);
const extractHttpStatus = (msg) => {
  const m = /HTTP\s*(\d{3})/i.exec(String(msg || ""));
  return m ? Number(m[1]) : 0;
};

function eligible({ message, httpStatus = 0, mp3Stage = null }) {
  const error = { message, httpStatus, mp3Stage };
  return Boolean(evaluate(error, message, httpStatus, extractHttpStatus));
}

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  if (actual === expected) passed += 1;
  else failures.push(`${name} — expected ${expected}, got ${actual}`);
}

// ── The reported bug: HTTP 200 with an unusable body ───────────────────────
// Every one of these is thrown by validateMp3Blob, so every one carries
// mp3Stage and every one must now reach MP3Cow.
const stage = "download";
check("200 + HTML error page (content-type)",
  eligible({ message: "download: INVALID_CONTENT_TYPE size=250000 type=text/html", httpStatus: 200, mp3Stage: stage }), true);
check("200 + JSON error body",
  eligible({ message: "download: INVALID_CONTENT_TYPE size=250000 type=application/json", httpStatus: 200, mp3Stage: stage }), true);
check("200 + octet-stream that is not an MP3",
  eligible({ message: "download: INVALID_MP3_HEADER head=[60,33,68,79] type=application/octet-stream size=300000", httpStatus: 200, mp3Stage: stage }), true);
check("200 + mislabelled audio/mpeg that is not an MP3",
  eligible({ message: "download: INVALID_MP3_HEADER head=[60,33,68,79] type=audio/mpeg size=300000", httpStatus: 200, mp3Stage: stage }), true);
check("200 + body too small",
  eligible({ message: 'download: INVALID_AUDIO_BLOB size=812 type=text/html raw="<html>"', httpStatus: 200, mp3Stage: stage }), true);
check("provider stalled mid-download",
  eligible({ message: "download: MP3_FETCH_TIMEOUT (không nhận thêm dữ liệu trong 60 giây).", httpStatus: 0, mp3Stage: stage }), true);

// ── Previously-working cases must keep working ─────────────────────────────
check("410 Gone", eligible({ message: "download: HTTP_NOT_OK status=410", httpStatus: 410, mp3Stage: stage }), true);
check("429 rate limited", eligible({ message: "convert: API trả HTTP 429.", httpStatus: 429 }), true);
check("503 upstream down", eligible({ message: "convert: API trả HTTP 503.", httpStatus: 503 }), true);
check("no download link returned", eligible({ message: "convert: NO_LINK" }), true);
check("network failure", eligible({ message: "download: failed to fetch" }), true);

// ── Must NOT trigger a pointless second attempt ────────────────────────────
// No mp3Stage means the provider never got far enough to hand us a payload;
// these are configuration/argument faults that MP3Cow would hit as well.
check("missing videoId", eligible({ message: "start: MISSING_VIDEO_ID" }), false);
check("unsupported url", eligible({ message: "start: UNSUPPORTED_URL" }), false);
check("400 bad request", eligible({ message: "convert: API trả HTTP 400.", httpStatus: 400 }), false);
check("user cancelled", eligible({ message: "Đã hủy." }), false);

// ── Report ─────────────────────────────────────────────────────────────────
console.log(`\n  passed: ${passed}`);
if (failures.length > 0) {
  console.error(`  FAILED: ${failures.length}`);
  for (const f of failures) console.error(`    ✗ ${f}`);
  process.exit(1);
}
console.log("  mp3 fallback eligibility behaves\n");
