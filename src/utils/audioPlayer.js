export class MusicPlayer {
  constructor(songId, audioProfile, onDurationChange) {
    this._audio = null;
    this._songId = songId;
    this._audioProfile = audioProfile;
    this._volume = 0.78;
    this._onDurationChange = onDurationChange || (() => {});
  }

  _ensureAudio() {
    if (!this._audio) {
      this._audio = new Audio();
      this._audio.volume = this._volume;
      this._audio.addEventListener("loadedmetadata", () => {
        if (isFinite(this._audio.duration)) {
          this._onDurationChange(this._audio.duration);
        }
      });
    }
  }

  _loadSrc(songId) {
    this._ensureAudio();
    const src = `./audio/${songId}.mp3`;
    if (this._audio.src !== src) {
      this._audio.src = src;
      this._audio.load();
    }
  }

  getDuration() {
    this._ensureAudio();
    return isFinite(this._audio.duration) ? this._audio.duration : 240;
  }

  getCurrentTime() {
    this._ensureAudio();
    return isFinite(this._audio.currentTime) ? this._audio.currentTime : 0;
  }

  setCurrentTime(t) {
    this._ensureAudio();
    this._audio.currentTime = t;
  }

  setVolume(vol) {
    this._volume = vol;
    if (this._audio) {
      this._audio.volume = Math.max(0, Math.min(1, vol * 0.6));
    }
  }

  async play() {
    this._loadSrc(this._songId);
    try {
      await this._audio.play();
    } catch (err) {
      // Autoplay blocked — try after user gesture
    }
  }

  async pause() {
    if (this._audio) {
      this._audio.pause();
    }
  }

  stop() {
    if (this._audio) {
      this._audio.pause();
      this._audio.currentTime = 0;
    }
  }
}

export function createSynth(songId, audioProfile, onDurationChange) {
  return new MusicPlayer(songId, audioProfile, onDurationChange);
}
