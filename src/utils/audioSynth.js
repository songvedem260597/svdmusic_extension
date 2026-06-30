const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function chordify(freq, type, gain) {
  return [
    { freq, type, gain },
    { freq: freq * 1.498, type, gain: gain * 0.55 },
    { freq: freq * 2, type, gain: gain * 0.3 },
    { freq: freq * 2.5, type, gain: gain * 0.15 },
  ];
}

const SCALES = {
  chill: [0, 2, 4, 5, 7, 9, 11, 12],
  energetic: [0, 2, 4, 5, 7, 9, 11, 12],
  edm: [0, 0, 4, 7, 0, 0, 5, 7],
  rap: [0, 0, 3, 5, 0, 0, 3, 5],
  ballad: [0, 2, 4, 5, 7, 9, 11, 12],
};

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function noteToFreq(n) {
  return 440 * Math.pow(2, n / 12);
}

const MELODIES = {
  "3107-duonng": {
    base: -9,
    pattern: [0, 2, 4, 2, 5, 4, 2, 0, 3, 5, 4, 2, 7, 5, 4, 2, 0, 0, 2, 3, 5, 7, 5, 4, 3, 2, 0],
    tempo: 0.48,
    drumPattern: "soft",
  },
  "lac-troi-son-tung": {
    base: 0,
    pattern: [4, 7, 5, 4, 7, 5, 3, 2, 4, 5, 7, 5, 4, 3, 2, 0, 4, 7, 5, 4, 7, 5, 3, 2, 4, 5, 7, 5, 4, 3, 2, 0],
    tempo: 0.36,
    drumPattern: "kick",
  },
  "tuy-am-masew": {
    base: 2,
    pattern: [4, 7, 4, 7, 4, 7, 4, 5, 4, 7, 4, 7, 4, 3, 2, 0, 4, 7, 4, 7, 4, 5, 4, 7, 4, 7, 4, 3, 2, 0, 4, 7],
    tempo: 0.32,
    drumPattern: "edm",
  },
  "bai-nay-chill-det-denvau": {
    base: -7,
    pattern: [0, 0, 2, 4, 0, 0, 3, 5, 0, 0, 2, 4, 0, 0, 3, 5, 4, 5, 7, 5, 4, 5, 7, 5, 0, 0, 2, 3, 5, 4, 2, 0],
    tempo: 0.42,
    drumPattern: "soft",
  },
  "buoc-qua-nhau-vu": {
    base: -4,
    pattern: [0, 2, 3, 4, 5, 7, 5, 4, 3, 2, 0, 2, 3, 4, 5, 7, 5, 4, 3, 2, 0, 2, 4, 5, 7, 5, 4, 2, 0, 0, 2, 3],
    tempo: 0.5,
    drumPattern: "kick",
  },
};

const TEMPO_MAP = {
  soft: 1.0,
  kick: 1.0,
  edm: 1.0,
};

function getDrumFreq(style, t) {
  if (style === "edm") return 150 * Math.pow(0.98, t % 8);
  if (style === "kick") return 100 * Math.pow(0.97, t % 8);
  return 120 * Math.pow(0.985, t % 8);
}

function scheduleOsc(freq, type, gain, t, dur, master, filter) {
  try {
    const osc = audioCtx.createOscillator();
    const env = audioCtx.createGain();

    osc.type = type;
    osc.frequency.value = freq;

    const attack = 0.015;
    const release = dur * 0.4;
    const peakGain = Math.min(gain, 0.5);

    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(peakGain, t + attack);
    env.gain.setValueAtTime(peakGain, t + dur - release);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(env);
    env.connect(filter || master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  } catch (_) {}
}

function scheduleKick(t, freq, gain, master) {
  try {
    const osc = audioCtx.createOscillator();
    const env = audioCtx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(freq * 1.5, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.3, t + 0.12);

    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);

    osc.connect(env);
    env.connect(master);
    osc.start(t);
    osc.stop(t + 0.2);
  } catch (_) {}
}

function scheduleHihat(t, master) {
  try {
    const noiseBuffer = audioCtx.createBuffer(1, Math.floor(audioCtx.sampleRate * 0.05), audioCtx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const noise = audioCtx.createBufferSource();
    noise.buffer = noiseBuffer;

    const hipass = audioCtx.createBiquadFilter();
    hipass.type = "highpass";
    hipass.frequency.value = 7000;

    const env = audioCtx.createGain();
    env.gain.setValueAtTime(0.06, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);

    noise.connect(hipass);
    hipass.connect(env);
    env.connect(master);
    noise.start(t);
    noise.stop(t + 0.06);
  } catch (_) {}
}

function scheduleBass(freq, t, dur, master, filter) {
  try {
    const osc = audioCtx.createOscillator();
    const env = audioCtx.createGain();

    osc.type = "sine";
    osc.frequency.value = freq / 2;

    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.18, t + 0.04);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.8);

    osc.connect(env);
    env.connect(filter || master);
    osc.start(t);
    osc.stop(t + dur);
  } catch (_) {}
}

class MusicPlayer {
  constructor(songId, audioProfile) {
    this.songId = songId;
    this.profile = audioProfile;
    this.isPlaying = false;
    this.startWallClock = 0;
    this.offsetSeconds = 0;
    this.masterGain = audioCtx.createGain();
    this.masterGain.gain.value = 0.6;
    this.masterGain.connect(audioCtx.destination);

    this.lpFilter = audioCtx.createBiquadFilter();
    this.lpFilter.type = "lowpass";
    this.lpFilter.frequency.value = 1800;
    this.lpFilter.Q.value = 0.8;
    this.lpFilter.connect(this.masterGain);

    this.scheduledWallClock = 0;
    this._timer = null;

    const melody = MELODIES[songId] || {
      base: 0,
      pattern: [0, 2, 4, 5, 7, 5, 4, 2, 0, 0, 2, 3, 5, 4, 2, 0],
      tempo: 0.4,
      drumPattern: "soft",
    };
    this.melody = melody;
  }

  async _resumeContext() {
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }
  }

  _scheduleChunk(wallClockStart) {
    if (!this.isPlaying) return;

    const now = audioCtx.currentTime;
    const SCHEDULE_AHEAD = 0.3;
    const CHUNK = 2.0;
    const { pattern, tempo, drumPattern } = this.melody;
    const { base, type, baseFreq } = this.profile;

    const scale = SCALES[this.profile.pattern] || SCALES.chill;

    while (this.scheduledWallClock < now + SCHEDULE_AHEAD) {
      const chunkStart = this.scheduledWallClock;
      const chunkEnd = chunkStart + CHUNK;

      for (let beat = 0; beat < CHUNK / tempo; beat++) {
        const beatTime = chunkStart + beat * tempo;
        if (beatTime >= chunkEnd) break;

        const noteIdx = pattern[Math.floor(beat) % pattern.length];
        const semitone = scale[noteIdx % scale.length] + Math.floor(noteIdx / scale.length) * 12 + base;
        const freq = baseFreq * Math.pow(2, semitone / 12);
        const noteDur = tempo * 0.85;

        const notes = chordify(freq, type, 0.18);
        notes.forEach((n) => {
          scheduleOsc(n.freq, n.type, n.gain, beatTime, noteDur, this.masterGain, this.lpFilter);
        });

        if (beat % 4 === 0) {
          const drumFreq = getDrumFreq(drumPattern, beat / 4);
          scheduleKick(beatTime, drumFreq, 0.4, this.masterGain);
        }

        if ((drumPattern === "edm" || drumPattern === "kick") && beat % 2 === 1) {
          scheduleHihat(beatTime, this.masterGain);
        }

        if (beat % 8 === 0) {
          scheduleBass(freq, beatTime, tempo * 4, this.masterGain, this.lpFilter);
        }
      }

      this.scheduledWallClock = chunkEnd;
    }

    this._timer = setTimeout(() => this._scheduleChunk(now), 200);
  }

  async play() {
    await this._resumeContext();
    if (this.isPlaying) return;

    this.isPlaying = true;
    this.startWallClock = audioCtx.currentTime - this.offsetSeconds;
    this.scheduledWallClock = audioCtx.currentTime;
    this._scheduleChunk(audioCtx.currentTime);
  }

  async pause() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.offsetSeconds = this.getCurrentTime();
    clearTimeout(this._timer);
    this.masterGain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.08);
    setTimeout(() => {
      try { this.masterGain.gain.value = 0.6; } catch (_) {}
    }, 120);
  }

  async resume() {
    await this.play();
  }

  getCurrentTime() {
    if (!this.isPlaying) return this.offsetSeconds;
    return audioCtx.currentTime - this.startWallClock;
  }

  setCurrentTime(t) {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) {
      this.isPlaying = false;
      clearTimeout(this._timer);
    }
    this.offsetSeconds = t;
    this.startWallClock = audioCtx.currentTime - t;
    if (wasPlaying) {
      this.scheduledWallClock = audioCtx.currentTime;
      this.isPlaying = true;
      this._scheduleChunk(audioCtx.currentTime);
    }
  }

  getDuration() {
    return 240;
  }

  stop() {
    this.isPlaying = false;
    this.offsetSeconds = 0;
    clearTimeout(this._timer);
    try {
      this.masterGain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.05);
    } catch (_) {}
  }

  setVolume(vol) {
    this.masterGain.gain.value = Math.max(0, Math.min(1, vol * 0.6));
  }
}

export function createSynth(songId, profile) {
  return new MusicPlayer(songId, profile);
}
