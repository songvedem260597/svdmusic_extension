export function parseLrc(rawText) {
  if (!rawText) {
    return [];
  }

  const lines = rawText.split(/\r?\n/);
  const parsed = [];

  for (const line of lines) {
    const tagOpen = "[";
    const tagClose = "]";
    const tagStart = line.indexOf(tagOpen);
    if (tagStart === -1) continue;

    let tagEnd = line.indexOf(tagClose, tagStart);
    if (tagEnd === -1) continue;

    const timeTag = line.substring(tagStart + 1, tagEnd);
    const timeParts = timeTag.split(":");
    if (timeParts.length !== 2) continue;

    const minutes = parseInt(timeParts[0], 10);
    const secParts = timeParts[1].split(".");
    const seconds = parseInt(secParts[0], 10);
    const fraction = secParts[1] ? parseInt(secParts[1].padEnd(3, "0").substring(0, 3), 10) : 0;

    if (isNaN(minutes) || isNaN(seconds)) continue;

    const text = line.substring(tagEnd + 1).trim();
    if (!text) continue;

    parsed.push({
      time: minutes * 60 + seconds + fraction / 1000,
      text,
    });
  }

  return parsed.sort((a, b) => a.time - b.time);
}

export function findActiveLyricIndex(lyrics, currentTime) {
  if (!lyrics.length) {
    return -1;
  }

  let activeIndex = 0;

  for (let index = 0; index < lyrics.length; index += 1) {
    if (lyrics[index].time <= currentTime + 0.2) {
      activeIndex = index;
    } else {
      break;
    }
  }

  return activeIndex;
}
