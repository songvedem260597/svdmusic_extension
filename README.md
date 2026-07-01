# SVD Music Player Extension

SVD Music Player Extension is a Chrome Manifest V3 side-panel music player built with React and Vite. It ships with a local music library, synced LRC lyrics, search, playback controls, theme settings, weather, mood quotes, and an add-song flow for saving user music into local browser storage.

## Features

- Chrome side-panel player powered by React.
- Local bundled songs with MP3, cover art, banner images, and LRC files.
- Synced lyrics with active-line highlighting and auto-scroll.
- Search, shuffle, repeat, seek, volume, and compact player controls.
- Lyrics view with animated disc and bass-reactive visual effects.
- Add-song workflow for YouTube links, LRC generation, cover/audio storage, and local library persistence.
- Settings modal for theme and custom background preferences.
- Weather widget and Vietnamese mood quote support.
- Local-first storage using Chrome storage, IndexedDB, and generated object URLs.

## Requirements

- Node.js 18 or newer.
- npm.
- Google Chrome or another Chromium-based browser that supports Manifest V3 side panels.

## Install

```bash
npm install
```

## Build

```bash
npm run build
```

The production extension is generated in `dist/`.

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the generated `dist/` directory.
5. Click the extension icon to open SVD Music in the side panel.

## Development

For a quick local extension build:

```bash
npm run dev
```

For a Vite preview of the built output:

```bash
npm run preview
```

After changing source files, run `npm run build` again and reload the unpacked extension in Chrome.

## Scripts

| Command | Description |
| --- | --- |
| `npm run setup` | Downloads/generates required media assets when supported by the local scripts. |
| `npm run icons` | Regenerates extension icons. |
| `npm run build` | Cleans output, builds with Vite, generates icons, copies assets, and verifies `dist/`. |
| `npm run dev` | Runs the extension build command for development iteration. |
| `npm run preview` | Serves the built app with Vite preview. |

## Project Structure

```text
.
├── manifest.json              # Chrome MV3 manifest
├── popup.html                 # Extension popup entry shell
├── sidepanel.html             # Side-panel entry shell
├── src/
│   ├── App.jsx                # Main player/runtime UI
│   ├── background.js          # Extension service worker
│   ├── components/            # UI components and modals
│   ├── data/                  # Bundled song metadata
│   ├── services/              # Storage, Gemini/LRC, MP3, weather, quote helpers
│   └── utils/                 # Audio, lyrics, search, and time helpers
├── public/
│   ├── audio/                 # Bundled MP3 files
│   ├── fonts/                 # Local Lexend fonts
│   ├── images/                # Covers, banners, and fallback artwork
│   └── lrc/                   # Bundled LRC lyric files
├── scripts/                   # Build, asset, icon, and verification scripts
└── dist/                      # Generated build output, not committed
```

## Permissions

The extension requests Chrome permissions for:

- `sidePanel`: open the player in Chrome's side panel.
- `storage`: save settings, user songs, and runtime preferences.
- `tabs`, `downloads`, `scripting`: support the add-song and media-fetch workflows.

Host permissions are limited to the services used by the add-song, lyrics, quote, weather, and media flows.

## Data And Privacy

- Bundled songs and artwork are loaded from extension assets.
- User-added songs, cover images, and LRC text are stored locally in browser storage/IndexedDB.
- Gemini, MP3 provider, quote, and weather requests are only used by their related features.
- Build output, dependencies, logs, and local tool state are ignored by `.gitignore`.

## Troubleshooting

- If the side panel is blank, rebuild with `npm run build` and reload the unpacked extension.
- If fonts do not render correctly, confirm `public/fonts/` exists before building and `dist/fonts/` exists after building.
- If lyrics do not sync, verify the song has a matching `.lrc` file and reload the extension after rebuilding.
- If a user-added song cannot play, check whether the MP3 was saved successfully in the add-song flow.

## License

Private project. Add a license before distributing publicly.
