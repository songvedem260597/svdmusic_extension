const BASE_URL = import.meta.env.BASE_URL ?? "";

const assetUrl = (folder, fileName) =>
  `${BASE_URL}/${folder}/${encodeURIComponent(fileName)}`;

export const DEFAULT_COVER = "images/default/cover.svg";
export const DEFAULT_BANNER = "images/default/banner.svg";

export const makeSong = ({ title, artist, cover, banner, audio, lyrics, tags = [] }) => ({
  id: `${title}-${artist}`.toLowerCase().replace(/\s+/g, "-"),
  title,
  artist,
  tags,
  // Prefer local extension asset; fall back to the onError handler on every
  // <img> tag which renders DEFAULT_COVER / DEFAULT_BANNER when the network
  // request fails.
  cover: cover
    ? assetUrl("image_song", cover)
    : DEFAULT_COVER,
  banner: banner
    ? assetUrl("image_song", banner)
    : DEFAULT_BANNER,
  audio: audio ? assetUrl("mp3", audio) : assetUrl("mp3", `${title}.mp3`),
  lyrics: audio
    ? assetUrl("lrc", audio.replace(/\.mp3$/, ".lrc"))
    : assetUrl("lrc", `${title}.lrc`),
});

export const BASE_UPLOAD_URL = BASE_URL;

export const songs = [
  makeSong({ title: "3107", artist: "Duonng", tags: ["V-Pop", "Chill"] }),
  makeSong({ title: "Lạc Trôi", artist: "Sơn Tùng M-TP", tags: ["V-Pop", "Hot"] }),
  makeSong({ title: "Túy Âm", artist: "Masew", tags: ["EDM", "V-Pop"] }),
  makeSong({ title: "Bạc Phận Remix", artist: "Masew", tags: ["Remix", "Dance"] }),
  makeSong({
    title: "Tell Ur Mom", artist: "Cukak",
    cover: "Tell Ur Mom.png",
    banner: "Tell Ur Mom.png",
    tags: ["Pop", "Fresh"],
  }),
  makeSong({ title: "Độ tộc 2 Remix", artist: "Cukak", tags: ["Remix", "Trending"] }),
  makeSong({ title: "Đường tôi chở em về", artist: "Cukak", tags: ["V-Pop", "Acoustic"] }),
  makeSong({ title: "Ai hát cho em nghe Remix", artist: "Cukak", tags: ["Remix", "Love"] }),
  makeSong({ title: "Em gì ơi", artist: "Jack", tags: ["V-Pop", "Hit"] }),
  makeSong({ title: "Điều khác lạ", artist: "Masew", tags: ["Chill", "V-Pop"] }),
  makeSong({ title: "Em có nghe", artist: "Rum", tags: ["V-Pop", "Love"] }),
  makeSong({ title: "Kém Duyên", artist: "Rum", tags: ["V-Pop", "Remix"] }),
  makeSong({ title: "Lần hẹn hò đầu tiên", artist: "Cukak", tags: ["Love", "Chill"] }),
  makeSong({ title: "Em cố đô Remix", artist: "Cukak", tags: ["Remix", "V-Pop"] }),
  makeSong({ title: "Phố đã lên đèn Remix", artist: "Cukak", tags: ["Remix", "Night"] }),
  makeSong({ title: "Chuyện rằng", artist: "Cukak", tags: ["Ballad", "V-Pop"] }),
  makeSong({ title: "Thằng điên", artist: "JustaTee", tags: ["V-Pop", "Hit"] }),
  makeSong({ title: "Bài này chill phết", artist: "Đen Vâu", tags: ["Rap", "Chill"] }),
  makeSong({ title: "Đi về nhà", artist: "Đen Vâu, JustaTee", tags: ["Rap", "Family"] }),
  makeSong({ title: "Có hẹn với thanh xuân", artist: "MONSTAR", tags: ["Youth", "V-Pop"] }),
  makeSong({ title: "Hoa sứ nhà nàng", artist: "Cukak", tags: ["Bolero", "Remix"] }),
  makeSong({ title: "Tình đầu", artist: "Tăng Duy Tân", tags: ["V-Pop", "Love"] }),
  makeSong({ title: "Người chơi hệ đẹp", artist: "Cukak", tags: ["Dance", "Fun"] }),
  makeSong({ title: "Ngày đầu tiên", artist: "Cukak", tags: ["Ballad", "Love"] }),
  makeSong({ title: "Nụ cười em là nắng", artist: "Cukak", tags: ["Love", "Pop"] }),
  makeSong({ title: "Anh đã lạc vào", artist: "Cukak", tags: ["V-Pop", "Chill"] }),
  makeSong({ title: "Bước qua nhau", artist: "Vũ.", tags: ["Indie", "Ballad"] }),
  makeSong({ title: "Lung Lay", artist: "Cukak", tags: ["V-Pop", "Fresh"] }),
  makeSong({ title: "Siren Remix", artist: "Cukak", tags: ["Remix", "EDM"] }),
  makeSong({ title: "Cũng đành thôi", artist: "Đức Phúc", tags: ["Ballad", "V-Pop"] }),
];
