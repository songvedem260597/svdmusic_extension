import axios from "axios";
import { createWriteStream, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const publicDir = resolve(rootDir, "public/audio");
const coverDir = resolve(rootDir, "public/images");

mkdirSync(publicDir, { recursive: true });
mkdirSync(coverDir, { recursive: true });

async function downloadFile(url, destPath) {
  if (existsSync(destPath)) {
    console.log(`  [skip] already exists: ${destPath.split(/[/\\]/).pop()}`);
    return true;
  }
  const filename = url.split("/").pop().substring(0, 40);
  console.log(`  [downloading] ${filename}...`);
  try {
    const response = await axios({
      method: "GET",
      url,
      responseType: "stream",
      timeout: 45000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://pixabay.com/",
        Accept: "*/*",
        "Accept-Encoding": "identity",
        Origin: "https://pixabay.com",
      },
    });
    const writer = createWriteStream(destPath);
    response.data.pipe(writer);
    await new Promise((res, rej) => {
      writer.on("finish", res);
      writer.on("error", rej);
    });
    const stat = await import("fs").then((fs) =>
      fs.promises.stat(destPath).then((s) => s.size),
    );
    if (stat < 5000) {
      await import("fs").then((fs) => fs.promises.unlink(destPath));
      console.log(`  [fail] file too small (${stat} bytes), removed`);
      return false;
    }
    console.log(`  [done] ${destPath.split(/[/\\]/).pop()} (${(stat / 1024).toFixed(1)} KB)`);
    return true;
  } catch (err) {
    console.log(`  [warn] ${err.message}`);
    return false;
  }
}

async function generateCover(color, destPath, title) {
  const { default: sharp } = await import("sharp");
  const size = 400;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${color[0]}"/>
        <stop offset="100%" stop-color="${color[1]}"/>
      </linearGradient>
    </defs>
    <rect width="${size}" height="${size}" fill="url(#bg)" rx="8"/>
    <circle cx="200" cy="185" r="80" fill="rgba(0,0,0,0.18)"/>
    <circle cx="200" cy="185" r="18" fill="rgba(255,255,255,0.85)"/>
    <text x="200" y="310" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" font-weight="700" fill="white" letter-spacing="1">${title}</text>
  </svg>`;

  await sharp(Buffer.from(svg)).png().toFile(destPath);
  console.log(`  [cover] generated: ${destPath.split(/[/\\]/).pop()}`);
}

const SONGS = [
  {
    id: "3107-duonng",
    title: "3107",
    artist: "Duonng",
    color: ["#1a237e", "#4a148c"],
    audioUrl: "https://cdn.pixabay.com/audio/2022/10/25/audio_a0fc1782a1.mp3",
  },
  {
    id: "lac-troi-son-tung",
    title: "Lac Troi",
    artist: "Son Tung M-TP",
    color: ["#004d40", "#00695c"],
    audioUrl: "https://cdn.pixabay.com/audio/2024/01/15/audio_e6a61d09d1.mp3",
  },
  {
    id: "tuy-am-masew",
    title: "Tuy Am",
    artist: "Masew",
    color: ["#311b92", "#4a148c"],
    audioUrl: "https://cdn.pixabay.com/audio/2022/08/02/audio_884fe92c21.mp3",
  },
  {
    id: "bai-nay-chill-det-denvau",
    title: "Bai Nay Chill Phet",
    artist: "Den Vau",
    color: ["#1b5e20", "#2e7d32"],
    audioUrl: "https://cdn.pixabay.com/audio/2022/03/09/audio_cd3a0c2a06.mp3",
  },
  {
    id: "buoc-qua-nhau-vu",
    title: "Buoc Qua Nhau",
    artist: "Vu",
    color: ["#b71c1c", "#880e4f"],
    audioUrl: "https://cdn.pixabay.com/audio/2023/09/06/audio_d91d9a4e0e.mp3",
  },
];

console.log("\nSVD Music - Asset Downloader");
console.log("=".repeat(42));

for (const song of SONGS) {
  console.log(`\n[${song.title}]`);

  const audioPath = resolve(publicDir, `${song.id}.mp3`);
  const coverPath = resolve(coverDir, `${song.id}.png`);

  const ok = await downloadFile(song.audioUrl, audioPath);

  if (!existsSync(coverPath)) {
    await generateCover(song.color, coverPath, song.title);
  }
}

console.log("\nDone!\n");
