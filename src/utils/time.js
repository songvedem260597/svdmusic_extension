function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

export function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) {
    return "00:00";
  }

  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);

  return pad(minutes) + ":" + pad(seconds);
}
