import sharp from "sharp";
import { mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(__dirname, "../icons");

const sizes = [16, 32, 48, 128];

function createSvg(size) {
  const center = size / 2;
  const discRadius = size * 0.35;
  const inner = size * 0.16;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs>
      <radialGradient id="bg${size}" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#1a2d4a"/>
        <stop offset="100%" stop-color="#0b1220"/>
      </radialGradient>
      <linearGradient id="accent${size}" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#00ffb3"/>
        <stop offset="100%" stop-color="#00e5ce"/>
      </linearGradient>
    </defs>
    <rect width="${size}" height="${size}" fill="url(#bg${size})" rx="${size * 0.18}"/>
    <circle cx="${center}" cy="${center}" r="${discRadius}" fill="#1e3a5f" stroke="url(#accent${size})" stroke-width="${size * 0.025}"/>
    <circle cx="${center}" cy="${center}" r="${inner}" fill="#00ffb3" opacity="0.9"/>
    <polygon points="${center},${center - discRadius * 0.45} ${center + discRadius * 0.65},${center} ${center},${center + discRadius * 0.45}" fill="#00ffb3" opacity="0.85"/>
  </svg>`;
}

mkdirSync(iconsDir, { recursive: true });

for (const size of sizes) {
  const svg = Buffer.from(createSvg(size));
  const filename = resolve(iconsDir, `icon${size}.png`);
  await sharp(svg).resize(size, size).png().toFile(filename);
  console.log(`Created icon${size}.png`);
}

console.log("All icons generated.");
