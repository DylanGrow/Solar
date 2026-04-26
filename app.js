// ============================================
// SolarLock - Solar Panel Alignment Instrument
// Optimized Mobile Build
// ============================================

// ---------- Constants ----------
const DEFAULT_LOCATION = { lat: 35.2271, lon: -80.8431 };
const SENSOR_READ_INTERVAL = 100;
const SUN_UPDATE_INTERVAL = 5000;
const HYSTERESIS_DURATION = 500;
const LOCK_SAVE_DURATION = 2000;
const LOCATION_TIMEOUT = 10000;
const COMPASS_ACCURACY_THRESHOLD = 30;
const IDLE_TIMEOUT = 300000;

// ---------- Utility Functions ----------
function angleDifference(a, b) {
  return ((a - b + 540) % 360) - 180;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function round1(val) {
  return Math.round(val * 10) / 10;
}

function safeVibrate(pattern) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch (e) { /* no-op */ }
}

function safeParseJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}

let storageTimer = null;
function debouncedSetItem(key, value) {
  clearTimeout(storageTimer);
  storageTimer = setTimeout(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* quota exceeded */ }
  }, 300);
}

function showToast(message) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('show'));
  });
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

function formatTime(date) {
  if (!date || isNaN(date.getTime())) return '--:--';
  // Updated to 12-hour clock for better mobile readability
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
}

// ---------- State ----------
const state = {
  deviceAzimuth: 0,
  deviceTilt: 0,
  rawBeta: 0,
  rawAlpha: null,
  compassAccuracy: null,
  lat: null,
  lon: null,
  locationAcquired: false,
  locationSource: 'none',
  sunAzimuth: 0,
  sunAltitude: 0,
  sunrise: null,
  sunset: null,
  solarNoon: null,
  peakSunHours: 0,
  azimuthError: 0,
  tiltError: 0,
  efficiency: 0,
  alignmentState: 'NIGHT',
  stateTimestamp: 0,
  panels: 10,
  calibrationOffset: 0,
  tiltZeroOffset: 0,
  mode: 'realtime',
  wakeLock: null,
  audioEnabled: true,
  muted: false,
  lastLock: null,
  permissionGranted: false,
  lastSunCalc: 0,
  cachedSun: null,
  lastMotionTime: 0,
  flashlightMode: false,
  isOnline: navigator.onLine,
};

// ---------- Sensor Layer ----------
const SensorLayer = {
  isIOS: /iPhone|iPad|iPod/.test(navigator.userAgent),
  needsPermission: false,

  init() {
    this.needsPermission = this.isIOS && typeof DeviceOrientationEvent.requestPermission === 'function';
    
    const startBtn = document.getElementById('enable-sensors-btn');
    startBtn.addEventListener('click', () => this.requestPermissions());
    document.getElementById('retry-sensors-btn').addEventListener('click', () => this.requestPermissions());
  },

  async requestPermissions() {
    try {
      if (this.needsPermission) {
        const perm = await DeviceOrientationEvent.requestPermission();
        if (perm !== 'granted') {
          this.showDenied();
          return;
        }
      }
      
      await this.requestLocation();
      this.startSensors();
      
      document.getElementById('permission-overlay').classList.remove('active');
      state.permissionGranted = true;
      
      App.showMainUI();
      AudioEngine.init();
      App.startMainLoop();
      App.enableWakeLock();
    } catch (err) {
      console.warn('Permission error:', err);
      this.showDenied();
    }
  },

  requestLocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        this.useDefaultLocation();
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        this.useDefaultLocation();
        resolve();
      }, LOCATION_TIMEOUT);

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearTimeout(timeout);
          state.lat = pos.coords.latitude;
          state.lon = pos.coords.longitude;
          state.locationAcquired = true;
          state.locationSource = 'gps';
          document.getElementById('location-status').textContent = `GPS: ${round1(state.lat)}, ${round1(state.lon)}`;
          resolve();
        },
        () => {
          clearTimeout(timeout);
          this.useDefaultLocation();
          resolve();
        },
        { enableHighAccuracy: true, timeout: LOCATION_TIMEOUT, maximumAge: 600000 }
      );
    });
  },

  useDefaultLocation() {
    state.lat = DEFAULT_LOCATION.lat;
    state.lon = DEFAULT_LOCATION.lon;
    state.locationAcquired = true;
    state.locationSource = 'default';
    document.getElementById('location-status').textContent = 'Using default location (NC)';
  },

  startSensors() {
    window.addEventListener('deviceorientation', (event) => {
      if (event.alpha === null && event.webkitCompassHeading === undefined) {
        document.getElementById('calibration-progress').classList.remove('hidden');
        return;
      }
      document.getElementById('calibration-progress').classList.add('hidden');

      state.rawAlpha = event.alpha;
      state.rawBeta = event.beta;
      state.compassAccuracy = event.webkitCompassAccuracy ?? null;
      state.lastMotionTime = Date.now();

      const rawHeading = this.getCompassHeading(event);
      state.deviceTilt = Math.abs(event.beta || 0);

      const declination = SunEngine.getMagneticDeclination(state.lat, state.lon);
      state.deviceAzimuth = (rawHeading + declination + state.calibrationOffset + 360) % 360;

      const warning = document.getElementById('accuracy-warning');
      if (state.compassAccuracy !== null && state.compassAccuracy > COMPASS_ACCURACY_THRESHOLD) {
        warning.textContent = '⚠ Low accuracy - avoid metal';
        warning.classList.remove('hidden');
      } else {
        warning.classList.add('hidden');
      }
    }, true);
  },

  getCompassHeading(event) {
    if (event.webkitCompassHeading != null) return event.webkitCompassHeading;
    if (event.alpha != null) return (360 - event.alpha) % 360;
    return 0;
  },

  showDenied() {
    document.getElementById('permission-overlay').classList.remove('active');
    document.getElementById('sensors-denied-overlay').classList.add('active');
  }
};

// ---------- Sun Engine ----------
const SunEngine = {
  getMagneticDeclination(lat, lon) {
    if (lat === null || lon === null) return 0;
    return (lon / 22) - (lat / 160);
  },

  getSunPosition(date, lat, lon) {
    if (lat === null || lon === null) return { altitude: 0, azimuth: 180 };
    const JD = date.getTime() / 86400000 + 2440587.5;
    const n = JD - 2451545.0;
    const L = (280.46 + 0.9856474 * n) % 360;
    const g = ((357.528 + 0.9856003 * n) % 360) * Math.PI / 180;
    const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * Math.PI / 180;
    const RA = Math.atan2(Math.cos(23.439 * Math.PI / 180) * Math.sin(lambda), Math.cos(lambda));
    const dec = Math.asin(Math.sin(23.439 * Math.PI / 180) * Math.sin(lambda));
    const LMST = ((6.697375 + 0.0657098242 * n + (date.getTime() % 86400000) / 3600000) % 24 + lon / 15 + 24) % 24;
    const HA = (LMST * 15 - RA * 180 / Math.PI + 360) % 360;
    const altitude = Math.asin(Math.sin(dec) * Math.sin(lat * Math.PI / 180) + Math.cos(dec) * Math.cos(lat * Math.PI / 180) * Math.cos(HA * Math.PI / 180)) * 180 / Math.PI;
    const azimuth = ((Math.atan2(-Math.cos(dec) * Math.cos(lat * Math.PI / 180) * Math.sin(HA * Math.PI / 180), Math.sin(dec) - Math.sin(lat * Math.PI / 180) * Math.sin(altitude * Math.PI / 180)) * 180 / Math.PI) + 360) % 360;
    return { altitude, azimuth };
  },

  getSunriseSunset(date, lat, lon) {
    const day = new Date(date); day.setHours(0, 0, 0, 0);
    let sunrise = null, sunset = null;
    for (let h = 0; h < 24; h += 0.25) {
      const t = new Date(day.getTime() + h * 3600000);
      const pos = this.getSunPosition(t, lat, lon);
      if (pos.altitude > -0.833 && sunrise === null && h >= 3) sunrise = t;
      if (pos.altitude < -0.833 && sunrise !== null && sunset === null && h > 6) { sunset = t; break; }
    }
    sunrise = sunrise || new Date(day.getTime() + 6.5 * 3600000);
    sunset = sunset || new Date(day.getTime() + 20 * 3600000);
    return { sunrise, sunset, solarNoon: new Date((sunrise.getTime() + sunset.getTime()) / 2) };
  },

  update() {
    const now = Date.now();
    if (now - state.lastSunCalc > SUN_UPDATE_INTERVAL || !state.cachedSun) {
      const date = new Date();
      state.cachedSun = this.getSunPosition(date, state.lat, state.lon);
      state.lastSunCalc = now;
      Object.assign(state, this.getSunriseSunset(date, state.lat, state.lon));
    }
    state.sunAzimuth = state.cachedSun.azimuth;
    state.sunAltitude = state.cachedSun.altitude;
  }
};

// ---------- Alignment Engine ----------
const AlignmentEngine = {
  update() {
    const target = state.mode === 'fixed' 
      ? SunEngine.getOptimalFixedAngle(state.lat) 
      : { azimuth: state.sunAzimuth, tilt: state.sunAltitude };

    state.azimuthError = angleDifference(state.deviceAzimuth, target.azimuth);
    state.tiltError = state.deviceTilt - target.tilt;

    const azEff = Math.max(0, Math.cos(Math.abs(state.azimuthError) * Math.PI / 180));
    const tiltEff = Math.max(0, Math.cos(Math.abs(state.tiltError) * Math.PI / 180));
    state.efficiency = azEff * tiltEff;
    
    this.updateState();
  },

  updateState() {
    const prev = state.alignmentState;
    if (state.sunAltitude < -6) state.alignmentState = 'NIGHT';
    else if (state.sunAltitude < 5) state.alignmentState = 'LOW_SUN';
    else if (Math.abs(state.azimuthError) > 10 || Math.abs(state.tiltError) > 15) state.alignmentState = 'OFF_TARGET';
    else if (Math.abs(state.azimuthError) < 0.5 && Math.abs(state.tiltError) < 2) state.alignmentState = 'LOCKED';
    else if (Math.abs(state.azimuthError) <= 3 && Math.abs(state.tiltError) <= 5) state.alignmentState = 'NEAR_LOCK';
    else state.alignmentState = 'TRACKING';
    
    if (prev !== state.alignmentState) state.stateTimestamp = Date.now();
  },

  getOutput() { return Math.round(state.panels * 100 * state.efficiency); }
};

// ---------- Audio Engine ----------
const AudioEngine = {
  ctx: null, g: null, osc: null,
  init() {
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.g = this.ctx.createGain(); this.g.connect(this.ctx.destination);
      this.g.gain.value = 0;
    } catch (e) { console.warn('Audio blocked'); }
  },
  playTone(freq, dur) {
    if (!this.ctx || state.muted) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.value = freq; o.connect(g); g.connect(this.ctx.destination);
    g.gain.setTargetAtTime(0.1, this.ctx.currentTime, 0.01);
    g.gain.setTargetAtTime(0, this.ctx.currentTime + dur, 0.01);
    o.start(); o.stop(this.ctx.currentTime + dur + 0.1);
  },
  update(alignmentState) {
    if (alignmentState === 'LOCKED' && Date.now() % 1000 < 100) this.playTone(880, 0.05);
  }
};

// ---------- Storage Engine ----------
const StorageEngine = {
  saveLock() {
    const lock = { az: round1(state.deviceAzimuth), tilt: round1(state.deviceTilt), ts: new Date().toISOString() };
    debouncedSetItem('solarlock_last_lock', lock);
    showToast('Alignment Saved ✓');
  },
  loadLastLock() {
    const l = safeParseJSON('solarlock_last_lock', null);
    if (l) document.getElementById('last-lock-content').innerHTML = `Last: ${l.az}° / ${l.tilt}°`;
  }
};

// ---------- UI ----------
const UI = {
  compassCanvas: null, ctx: null,
  init() {
    this.compassCanvas = document.getElementById('compass-canvas');
    this.ctx = this.compassCanvas.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.bind();
  },
  resize() {
    const size = this.compassCanvas.offsetWidth;
    this.compassCanvas.width = size; this.compassCanvas.height = size;
  },
  bind() {
    document.getElementById('mode-toggle-btn').addEventListener('click', () => {
      state.mode = state.mode === 'realtime' ? 'fixed' : 'realtime';
      showToast(`Switched to ${state.mode} mode`);
    });
    document.getElementById('save-lock-btn').addEventListener('click', () => StorageEngine.saveLock());
    document.getElementById('mute-btn').addEventListener('click', () => {
      state.muted = !state.muted;
      document.getElementById('mute-icon-unmuted').classList.toggle('hidden', state.muted);
      document.getElementById('mute-icon-muted').classList.toggle('hidden', !state.muted);
    });
    document.getElementById('panel-slider').addEventListener('input', (e) => {
      state.panels = e.target.value;
      document.getElementById('panel-count-value').textContent = state.panels;
    });
  },
  render() {
    const c = this.ctx, w = this.compassCanvas.width, r = w / 2 - 20;
    c.clearRect(0, 0, w, w);
    c.strokeStyle = '#333355'; c.beginPath(); c.arc(w/2, w/2, r, 0, 7); c.stroke();
    
    // Sun Needle
    const sRad = (state.sunAzimuth - 90) * Math.PI / 180;
    c.strokeStyle = '#f5a623'; c.lineWidth = 4; c.beginPath();
    c.moveTo(w/2, w/2); c.lineTo(w/2 + Math.cos(sRad)*r, w/2 + Math.sin(sRad)*r); c.stroke();

    document.getElementById('power-output').textContent = `${AlignmentEngine.getOutput()}W Output`;
    document.getElementById('state-badge').textContent = state.alignmentState;
    document.getElementById('az-instruction').textContent = `${round1(state.azimuthError)}° to target`;
  }
};

// ---------- App ----------
const App = {
  init() { SensorLayer.init(); UI.init(); StorageEngine.loadLastLock(); },
  showMainUI() {
    document.getElementById('app-header').classList.remove('hidden');
    document.getElementById('main-content').classList.remove('hidden');
  },
  enableWakeLock() {
    if ('wakeLock' in navigator) navigator.wakeLock.request('screen').catch(() => {});
  },
  startMainLoop() {
    const loop = () => {
      SunEngine.update();
      AlignmentEngine.update();
      AudioEngine.update(state.alignmentState);
      UI.render();
      requestAnimationFrame(loop);
    };
    loop();
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
