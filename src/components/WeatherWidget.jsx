import { useEffect, useState } from "react";
import {
  DEFAULT_CITY,
  getCurrentWeatherByCoords,
  searchCityWeather,
} from "../services/weatherApi.js";

/**
 * Tiny "state machine" for the widget so we can render one consistent
 * placeholder whether we are waiting on the network or recovering from
 * an error.
 *
 *   idle    → haven't asked anything yet
 *   locating → resolving a coarse location via IP lookup (no permission prompt)
 *   loading  → fetching from Open-Meteo
 *   ready    → have data to render
 *   error    → give up gracefully, render the message
 */
const STATUS = {
  idle: "idle",
  locating: "locating",
  loading: "loading",
  ready: "ready",
  error: "error",
};

// Free IP → city/coords lookup (no API key, no Chrome permission prompt).
// `ipapi.co` is run by the ipapi spinoff and supports ~30k req/month free
// from the browser. We use it instead of navigator.geolocation because
// the W3C Geolocation API surfaces a Chrome extension warning ("Is the
// 'geolocation' permission appropriate?") that noisy linters flag — and
// a music player has no business asking for precise GPS coords anyway.
// Falls back to DEFAULT_CITY on any failure.
const IP_GEOLOCATION_URL = "https://ipapi.co/json/";
const IP_GEOLOCATION_TIMEOUT_MS = 6000;

async function fetchIpLocation() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IP_GEOLOCATION_TIMEOUT_MS);
  try {
    const res = await fetch(IP_GEOLOCATION_URL, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return { ok: false, reason: `http:${res.status}` };
    const json = await res.json();
    const lat = Number(json && json.latitude);
    const lon = Number(json && json.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return { ok: false, reason: "no_coords" };
    }
    return {
      ok: true,
      latitude: lat,
      longitude: lon,
      city: typeof json.city === "string" ? json.city : null,
      country:
        typeof json.country_name === "string"
          ? json.country_name
          : typeof json.country === "string"
            ? json.country
            : null,
    };
  } catch (err) {
    return { ok: false, reason: err && err.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

export default function WeatherWidget() {
  const [status, setStatus] = useState(STATUS.idle);
  const [weather, setWeather] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // 1) Resolve a coarse location via IP lookup (no permission prompt,
      //    no Chrome "geolocation" warning). Falls through to the default
      //    city on any failure.
      setStatus(STATUS.locating);
      const geo = await fetchIpLocation();

      if (cancelled) return;

      // 2) Fetch the forecast — by coords when we have them, else by
      //    the default city.
      let payload = null;
      try {
        setStatus(STATUS.loading);
        if (geo.ok) {
          payload = await getCurrentWeatherByCoords(
            geo.latitude,
            geo.longitude,
          );
          if (geo.city || geo.country) {
            payload = {
              ...payload,
              location: geo.country
                ? `${geo.city || "Vị trí của bạn"}, ${geo.country}`
                : geo.city || payload.location,
            };
          }
        } else {
          payload = await searchCityWeather(DEFAULT_CITY);
        }
      } catch (err) {
        if (cancelled) return;
        setErrorMessage(
          err && err.message ? err.message : "Không lấy được thời tiết",
        );
        setStatus(STATUS.error);
        return;
      }

      if (cancelled) return;
      setWeather(payload);
      setStatus(STATUS.ready);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === STATUS.locating) {
    return (
      <div className="weatherWidget" aria-live="polite">
        <div className="weatherIcon" aria-hidden="true">🌐</div>
        <div className="weatherMain">
          <div className="weatherTemp">…</div>
          <div className="weatherLocation">Đang xác định khu vực…</div>
        </div>
      </div>
    );
  }

  if (status === STATUS.loading) {
    return (
      <div className="weatherWidget" aria-live="polite">
        <div className="weatherIcon" aria-hidden="true">⏳</div>
        <div className="weatherMain">
          <div className="weatherTemp">…</div>
          <div className="weatherLocation">Đang lấy thời tiết…</div>
        </div>
      </div>
    );
  }

  if (status === STATUS.error || !weather) {
    return (
      <div className="weatherWidget" aria-live="polite">
        <div className="weatherIcon" aria-hidden="true">⚠️</div>
        <div className="weatherMain">
          <div className="weatherTemp">--°</div>
          <div className="weatherLocation">Không lấy được thời tiết</div>
        </div>
        {errorMessage ? (
          <div className="weatherMeta">
            <span>{errorMessage}</span>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="weatherWidget" aria-live="polite">
      <div className="weatherIcon" aria-hidden="true">{weather.icon}</div>
      <div className="weatherMain">
        <div className="weatherTemp">{weather.temperature}°C</div>
        <div className="weatherLocation" title={weather.location}>
          {weather.location}
        </div>
      </div>
      <div className="weatherMeta">
        <span>{weather.label}</span>
        <span>Cảm giác {weather.apparentTemperature}°C</span>
        <span>Ẩm {weather.humidity}%</span>
        <span>Gió {weather.windSpeed} km/h</span>
      </div>
    </div>
  );
}