// Bass-reactive zoom + rotation for the `.discWrap` cover on the player stage.
//
// Watches the `<audio>` element currently driving the app, samples its
// output through a Web Audio AnalyserNode, and drives CSS variables on
// `.discWrap` and `.discWrap img` every animation frame:
//
//   --bass              raw bar13 value (0..1)
//   --bass-smooth       smoothed pulse (discPulseSmooth, 0..1)
//   --avatar-pulse      clamped, smoothed pulse (avatarPulse, 0..1)
//   --disc-rotate-angle current rotation angle of the cover image (Ndeg)
//
// CSS consumes them to:
//   .discWrap:     scale(1 + avatar-pulse * 0.16)         ← zoom pulse
//   .discWrap img: rotate(var(--disc-rotate-angle)) scale(1.5) ← JS-driven spin
//
// bar13 is the frequency bin at index ((13 * numPoints) / 16) | 0 — the
// 13th band of 16 evenly-spaced FFT bands.  Rotation base is 12°/s; when
// bar13 > 0.22 an extra speed boost up to +95°/s is added proportionally.
//
// Lifecycle guarantees:
//   • One AudioContext, one AnalyserNode, one MediaElementSource per audio
//     element (WeakMap guards against double createMediaElementSource).
//   • The RAF loop continues across pause/ended so values decay gracefully.
//   • stopBassReactiveCover() cancels RAF; disposeBassReactiveCover() tears
//     everything down (called on App unmount).

const FFT_SIZE = 1024;
const ANALYSER_SMOOTHING = 0.62;

let bassAudioCtx = null;
let bassAnalyser = null;
const bassSourceByAudio = new WeakMap();
let bassDataArray = null;
let bassRafId = null;

let discPulseSmooth = 0;
let discRotateAngle = 0;
let lastBassFrameTime = performance.now();
let bassDebugLastLog = 0;

let bassRunning = false;
let bassDiscWrap = null;
let bassCurrentAudio = null;
let bassDomObserver = null;

// Resolves the live `.discWrap` element. The discWrap can be unmounted
// when the user toggles the lyrics/list view (the micButton in the player
// bar swaps between the two layouts, dropping the disc from the DOM and
// re-creating a fresh node on the way back). Falling back to a query here
// means the loop self-heals after a view swap instead of writing CSS vars
// into a detached node — which would make the new disc appear frozen.
function resolveDiscWrap() {
  if (bassDiscWrap && bassDiscWrap.isConnected) return bassDiscWrap;
  const found = document.querySelector(".discWrap");
  if (found && found.isConnected) {
    bassDiscWrap = found;
    return bassDiscWrap;
  }
  bassDiscWrap = null;
  return null;
}

// Watch the DOM for `.discWrap` showing up. This catches BOTH situations
// where the disc would otherwise freeze:
//
//   (a) Cold start with no .discWrap in DOM — user pressed Play while on
//       the "list" view (no .discWrap → start() failed → no analyser).
//       When the lyrics panel later mounts, we re-trigger start().
//
//   (b) Warm start with a fresh .discWrap after view toggle — user had
//       the song playing, pressed micButton to leave lyrics view (which
//       paused the loop via handlePauseEvent → pauseBassReactiveCover()),
//       then tapped micButton back. The previous watcher early-returned
//       when `bassAnalyser` was already set, so the loop never resumed on
//       the freshly mounted disc. Now we also resume() when we detect a
//       live .discWrap + audio playing + loop stopped.
//
// A MutationObserver fires on the actual DOM change, so it works
// regardless of the RAF loop's state.
function ensureDomObserver() {
  if (bassDomObserver || typeof MutationObserver === "undefined") return;
  bassDomObserver = new MutationObserver(() => {
    if (!bassCurrentAudio) return;
    if (bassCurrentAudio.paused) return;
    const found = document.querySelector(".discWrap");
    if (!found || !found.isConnected) return;

    // (a) Cold path: no analyser yet → fresh setup.
    if (!bassAnalyser) {
      try {
        startBassReactiveCover(bassCurrentAudio);
      } catch (_) { /* start() throws are caught inside */ }
      return;
    }

    // (b) Warm path: analyser alive but loop stopped (after pause +
    // view swap). re-cache the live node and resume the RAF loop.
    bassDiscWrap = found;
    if (!bassRunning) {
      try {
        resumeBassReactiveCover(bassCurrentAudio);
      } catch (_) { /* resume() guards its own setup */ }
    }
  });
  bassDomObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function teardownDomObserver() {
  if (bassDomObserver) {
    bassDomObserver.disconnect();
    bassDomObserver = null;
  }
}

// ─── Audio graph setup ───────────────────────────────────────────────────────

function setupDiscAudioReactive(audio) {
  if (!audio) return false;
  const discWrap = document.querySelector(".discWrap");
  if (!discWrap) return false;

  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return false;
  if (!bassAudioCtx) bassAudioCtx = new Ctor();

  if (!bassAnalyser) {
    bassAnalyser = bassAudioCtx.createAnalyser();
    bassAnalyser.fftSize = FFT_SIZE;
    bassAnalyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
    bassDataArray = new Uint8Array(bassAnalyser.frequencyBinCount);
  }

  let source = bassSourceByAudio.get(audio);
  if (!source) {
    source = bassAudioCtx.createMediaElementSource(audio);
    bassSourceByAudio.set(audio, source);
  }

  try { bassAnalyser.disconnect(); } catch (_) {}
  try { source.disconnect(); } catch (_) {}
  source.connect(bassAnalyser);
  bassAnalyser.connect(bassAudioCtx.destination);

  bassDiscWrap = discWrap;

  // Seed all vars to 0 so the disc doesn't flash zoomed on first paint.
  discWrap.style.setProperty("--bass", "0");
  discWrap.style.setProperty("--bass-smooth", "0");
  discWrap.style.setProperty("--avatar-pulse", "0");
  discWrap.style.setProperty("--disc-rotate-angle", "0deg");

  return true;
}

// ─── Main animation loop ────────────────────────────────────────────────────

function loop() {
  if (!bassAnalyser || !bassDataArray) {
    // The audio graph might not be set up yet — either start() failed
    // because `.discWrap` wasn't in the DOM (user on list view) or the
    // audio element was reassigned. The MutationObserver handles the
    // DOM-missing case; this branch self-recovers if start() did succeed
    // and only the analyser pointer was lost (shouldn't happen in normal
    // flow, but cheap to guard).
    if (bassCurrentAudio && !bassCurrentAudio.paused && resolveDiscWrap()) {
      try { startBassReactiveCover(bassCurrentAudio); } catch (_) { /* ignore */ }
    }
    bassRafId = requestAnimationFrame(loop);
    return;
  }

  // The lyrics panel (which holds .discWrap) is unmounted when the user
  // toggles the micButton to leave lyrics view. Re-resolve every frame so
  // we transparently pick up the new node when they come back, and skip
  // writes entirely while the panel is hidden.
  const discWrap = resolveDiscWrap();
  if (!discWrap) {
    bassRafId = requestAnimationFrame(loop);
    return;
  }

  bassAnalyser.getByteFrequencyData(bassDataArray);
  const numPoints = bassAnalyser.frequencyBinCount;
  const ndx = Math.max(1, Math.min(numPoints - 1, ((13 * numPoints) / 16) | 0));
  const bar13Value = bassDataArray[ndx] / 255;

  // Smoothed pulse for zoom.
  discPulseSmooth += (bar13Value - discPulseSmooth) * 0.28;
  const avatarPulse = Math.min(1, discPulseSmooth * 1.35);

  // Rotation: base + optional bass boost.
  const now = performance.now();
  const dt = Math.max(0.001, Math.min(0.08, (now - lastBassFrameTime) / 1000));
  lastBassFrameTime = now;

  const baseDegPerSec = 12;
  const threshold = 0.22;
  const extraNormalized = bar13Value > threshold ? (bar13Value - threshold) / (1 - threshold) : 0;
  const extraDegPerSec = extraNormalized * 95;
  const totalDegPerSec = baseDegPerSec + extraDegPerSec;

  discRotateAngle = (discRotateAngle + totalDegPerSec * dt) % 360;

  // Write CSS vars.
  discWrap.style.setProperty("--bass", bar13Value.toFixed(3));
  discWrap.style.setProperty("--bass-smooth", discPulseSmooth.toFixed(3));
  discWrap.style.setProperty("--avatar-pulse", avatarPulse.toFixed(3));
  discWrap.style.setProperty("--disc-rotate-angle", `${discRotateAngle.toFixed(3)}deg`);

  // Debug log every 500 ms.
  if (now - bassDebugLastLog > 500) {
    bassDebugLastLog = now;
    console.log("[SVD DiscReactive]", {
      bar13: Number(bar13Value.toFixed(3)),
      pulse: Number(avatarPulse.toFixed(3)),
      baseDegPerSec,
      extraDegPerSec: Number(extraDegPerSec.toFixed(3)),
      totalDegPerSec: Number(totalDegPerSec.toFixed(3)),
      angle: Number(discRotateAngle.toFixed(2)),
    });
  }

  bassRafId = requestAnimationFrame(loop);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Starts (or resumes) the disc-reactive effect on `.discWrap`.
 * Safe to call multiple times with the same audio element.
 *
 * @param {HTMLAudioElement|null} audio
 */
export function startBassReactiveCover(audio) {
  if (!audio) return;
  if (!setupDiscAudioReactive(audio)) {
    // Setup failed (likely `.discWrap` not in the DOM yet — user is on the
    // "list" view, or the panel just unmounted). Stash the audio element
    // and let the MutationObserver trigger a re-try as soon as a fresh
    // `.discWrap` shows up. This makes the effect "just work" no matter
    // which view the user hits Play in.
    bassCurrentAudio = audio;
    ensureDomObserver();
    return;
  }

  bassCurrentAudio = audio;
  ensureDomObserver();

  if (bassRunning) return;

  // AudioContexts start in "suspended" state; resume after a user gesture.
  if (bassAudioCtx && bassAudioCtx.state === "suspended") {
    bassAudioCtx.resume().catch(() => { /* swallow */ });
  }

  bassRunning = true;
  lastBassFrameTime = performance.now();
  console.log("[SVD DiscReactive] loop started");
  if (bassRafId == null) {
    bassRafId = requestAnimationFrame(loop);
  }
}

/**
 * Stops the RAF loop. AudioContext + MediaElementSource stay alive so the
 * next start() is cheap. The smoothed values continue to decay.
 */
export function stopBassReactiveCover() {
  bassRunning = false;
  if (bassRafId != null) {
    cancelAnimationFrame(bassRafId);
    bassRafId = null;
  }
}

// ─── Pause / resume helpers ─────────────────────────────────────────────────
//
// We expose a dedicated stop/start so the playback layer (Play / Pause button,
// audio 'pause' / 'play' events, song-end, etc.) can pause the rotation and
// zoom-pulse loop deterministically. Without this, the 12°/s base rotation
// would keep running whenever the audio is paused, making it look like the
// disc keeps spinning while the song is on hold.

/**
 * Pauses the RAF loop without tearing down the audio graph. The disc
 * freezes on its current rotation angle and the zoom-pulse values are
 * clamped to 0 so the cover no longer breathes.
 */
export function pauseBassReactiveCover() {
  bassRunning = false;
  if (bassRafId != null) {
    cancelAnimationFrame(bassRafId);
    bassRafId = null;
  }
  // Write to whichever .discWrap is currently in the DOM — if the user
  // swapped views via micButton, bassDiscWrap may be detached.
  const liveDiscWrap = resolveDiscWrap();
  if (liveDiscWrap) {
    liveDiscWrap.style.setProperty("--bass", "0");
    liveDiscWrap.style.setProperty("--bass-smooth", "0");
    liveDiscWrap.style.setProperty("--avatar-pulse", "0");
    // NOTE: we intentionally KEEP --disc-rotate-angle so the disc freezes
    // on its current pose instead of snapping back to 0deg. The next
    // resume() picks up from the same angle and continues the spin.
  }
  // Don't tear down the DOM observer while paused — if the user un-pauses
  // and we still need to find a fresh .discWrap, the observer is what
  // kicks off the re-setup.
  discPulseSmooth = 0;
}

/**
 * Resumes the RAF loop. If startBassReactiveCover() was never called for
 * this audio element yet, falls back to a one-shot setup so callers don't
 * have to remember the lifecycle.
 *
 * @param {HTMLAudioElement|null} audio
 */
export function resumeBassReactiveCover(audio) {
  if (!audio) return;
  // If the live .discWrap was unmounted (e.g. user toggled the micButton
  // out of lyrics view and back), re-resolve it before re-attaching.
  resolveDiscWrap();
  if (!bassAnalyser || !bassDiscWrap) {
    startBassReactiveCover(audio);
    return;
  }
  if (bassRunning) return;

  // AudioContexts return to "suspended" after long pauses; resume on a
  // user-initiated resume() call (Play button).
  if (bassAudioCtx && bassAudioCtx.state === "suspended") {
    bassAudioCtx.resume().catch(() => { /* swallow */ });
  }
  // Re-seed dt so we don't get a huge angle jump from the paused interval.
  lastBassFrameTime = performance.now();
  bassRunning = true;
  if (bassRafId == null) {
    bassRafId = requestAnimationFrame(loop);
  }
}

/**
 * Tears down everything: cancels RAF, disconnects analyser, closes context.
 * Called on App unmount. Resets CSS vars on the discWrap before teardown.
 */
export function disposeBassReactiveCover() {
  stopBassReactiveCover();
  teardownDomObserver();
  bassCurrentAudio = null;

  // Reset rotation angle before the DOM reference potentially vanishes.
  if (bassDiscWrap && bassDiscWrap.isConnected) {
    bassDiscWrap.style.setProperty("--bass", "0");
    bassDiscWrap.style.setProperty("--bass-smooth", "0");
    bassDiscWrap.style.setProperty("--avatar-pulse", "0");
    bassDiscWrap.style.setProperty("--disc-rotate-angle", "0deg");
  }

  try { bassAnalyser && bassAnalyser.disconnect(); } catch (_) {}
  bassAnalyser = null;
  bassDataArray = null;
  try { bassAudioCtx && bassAudioCtx.close(); } catch (_) {}
  bassAudioCtx = null;

  bassSourceByAudio.clear();
  bassDiscWrap = null;
  discPulseSmooth = 0;
  discRotateAngle = 0;
  lastBassFrameTime = performance.now();
}
