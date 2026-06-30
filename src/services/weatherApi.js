// Open-Meteo weather service.
//
// Open-Meteo is keyless and free for non-commercial use, so we can call it
// directly from the extension side panel without provisioning any API key.
//
// Two endpoints are used:
//   - Geocoding  → resolves a city name into {latitude, longitude, name, country}
//   - Forecast   → returns current weather for a given lat/lon
//
// We also keep a tiny in-localStorage cache (10 min TTL) so the widget does
// not hammer the API when the user re-opens the side panel repeatedly.

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";

const CACHE_KEY = "svd_weather_cache";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export const DEFAULT_CITY = "Ho Chi Minh City";

// ── weather_code → human label + emoji ────────────────────────────────
// Source: https://open-meteo.com/en/docs (WMO weather interpretation codes)
// Keys we know are mapped explicitly; everything else falls back to "Mây".
export const WEATHER_CODE_MAP = {
  0: { label: "Trời quang", icon: "☀️" },
  1: { label: "Ít mây", icon: "🌤️" },
  2: { label: "Nhiều mây", icon: "⛅" },
  3: { label: "Âm u", icon: "☁️" },
  45: { label: "Sương mù", icon: "🌫️" },
  48: { label: "Sương mù", icon: "🌫️" },
  51: { label: "Mưa phùn nhẹ", icon: "🌦️" },
  53: { label: "Mưa phùn", icon: "🌦️" },
  55: { label: "Mưa phùn mạnh", icon: "🌧️" },
  56: { label: "Mưa phùn đóng băng", icon: "🌧️" },
  57: { label: "Mưa phùn đóng băng", icon: "🌧️" },
  61: { label: "Mưa nhẹ", icon: "🌧️" },
  63: { label: "Mưa", icon: "🌧️" },
  65: { label: "Mưa lớn", icon: "⛈️" },
  66: { label: "Mưa đóng băng", icon: "🌧️" },
  67: { label: "Mưa đóng băng", icon: "⛈️" },
  71: { label: "Tuyết nhẹ", icon: "🌨️" },
  73: { label: "Tuyết", icon: "🌨️" },
  75: { label: "Tuyết dày", icon: "❄️" },
  77: { label: "Tuyết hạt", icon: "🌨️" },
  80: { label: "Mưa rào nhẹ", icon: "🌦️" },
  81: { label: "Mưa rào", icon: "🌧️" },
  82: { label: "Mưa rào mạnh", icon: "⛈️" },
  85: { label: "Mưa tuyết", icon: "🌨️" },
  86: { label: "Mưa tuyết", icon: "❄️" },
  95: { label: "Dông", icon: "⛈️" },
  96: { label: "Dông kèm mưa đá", icon: "⛈️" },
  99: { label: "Dông kèm mưa đá lớn", icon: "⛈️" },
};

export const FALLBACK_WEATHER = {
  label: "Không rõ",
  icon: "🌡️",
};

// ── cache helpers ─────────────────────────────────────────────────────
// Cached entries are keyed by `coords:lat,lon` or `city:name`. Anything
// older than CACHE_TTL_MS is treated as a miss and silently overwritten.

function readCache(key) {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const store = JSON.parse(raw);
    const entry = store[key];
    if (!entry) return null;
    if (Date.now() - entry.savedAt > CACHE_TTL_MS) return null;
    return entry.payload;
  } catch {
    return null;
  }
}

function writeCache(key, payload) {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const store = raw ? JSON.parse(raw) : {};
    store[key] = { savedAt: Date.now(), payload };
    localStorage.setItem(CACHE_KEY, JSON.stringify(store));
  } catch {
    // localStorage may be unavailable (private mode / quota); ignore.
  }
}

// ── core: fetch current weather for known coordinates ─────────────────
export async function getCurrentWeatherByCoords(latitude, longitude) {
  if (typeof latitude !== "number" || typeof longitude !== "number") {
    throw new Error("getCurrentWeatherByCoords: lat/lon phải là số");
  }

  const cacheKey = `coords:${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current:
      "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
    timezone: "auto",
  });

  const res = await fetch(`${FORECAST_URL}?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Forecast HTTP ${res.status}`);
  }
  const json = await res.json();
  if (!json || !json.current) {
    throw new Error("Forecast: phản hồi không hợp lệ");
  }

  const c = json.current;
  const code = Number(c.weather_code);
  const meta = WEATHER_CODE_MAP[code] || FALLBACK_WEATHER;

  const payload = {
    location: json.timezone_abbreviation
      ? `${json.timezone_abbreviation}`
      : "Vị trí của bạn",
    latitude,
    longitude,
    temperature: Math.round(Number(c.temperature_2m)),
    apparentTemperature: Math.round(Number(c.apparent_temperature)),
    humidity: Math.round(Number(c.relative_humidity_2m)),
    windSpeed: Math.round(Number(c.wind_speed_10m)),
    weatherCode: code,
    label: meta.label,
    icon: meta.icon,
    savedAt: Date.now(),
  };

  writeCache(cacheKey, payload);
  return payload;
}

// ── search a city → fetch current weather in one call ─────────────────
export async function searchCityWeather(city) {
  if (!city || typeof city !== "string") {
    throw new Error("searchCityWeather: city phải là chuỗi");
  }
  const trimmed = city.trim();
  if (!trimmed) {
    throw new Error("searchCityWeather: city trống");
  }

  const cacheKey = `city:${trimmed.toLowerCase()}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;

  const geoParams = new URLSearchParams({
    name: trimmed,
    count: "1",
    language: "vi",
    format: "json",
  });
  const geoRes = await fetch(`${GEOCODING_URL}?${geoParams.toString()}`);
  if (!geoRes.ok) {
    throw new Error(`Geocoding HTTP ${geoRes.status}`);
  }
  const geoJson = await geoRes.json();
  const hit = geoJson && Array.isArray(geoJson.results) && geoJson.results[0];
  if (!hit) {
    throw new Error(`Không tìm thấy thành phố: ${trimmed}`);
  }

  const weather = await getCurrentWeatherByCoords(
    Number(hit.latitude),
    Number(hit.longitude),
  );

  const payload = {
    ...weather,
    location: hit.country
      ? `${hit.name}, ${hit.country}`
      : hit.name,
    cityQuery: trimmed,
  };

  writeCache(cacheKey, payload);
  return payload;
}