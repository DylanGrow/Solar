// ============================================
// SolarLock - Solar Panel Alignment Instrument
// Refactored Fixes Applied (Canvas, Android Permissions, Logic Race)
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
  } catch (e) {
    return fallback;
  }
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
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
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
  stateUpgradePending: false,
  stateUpgradeTimer: null,
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
  watchId: null,

  init() {
    this.needsPermission = this.isIOS && typeof DeviceOrientationEvent.requestPermission === 'function';
    
    // FIX: Unified handler for both Android and iOS permissions
    const startBtn = document.getElementById('enable-sensors-btn');
    startBtn.addEventListener('click', () => {
      if (this.needsPermission) {
        this.requestPermissions();
      } else {
        // Android flow: Standard location request + immediate sensor start
        this.requestPermissions(); 
      }
    });

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
      
      // Sequence the hardware activation
      await this.requestLocation();
      this.startSensors();
      
      // UI Transition
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
        (err) => {
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
    document.getElementById('location-status').textContent = 'Using default location (Charlotte, NC)';
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

      // Accuracy display logic
      const warning = document.getElementById('accuracy-warning');
      if (state.compassAccuracy !== null && state.compassAccuracy > COMPASS_ACCURACY_THRESHOLD) {
        warning.textContent = '⚠ Low compass accuracy';
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
  },

  cleanup() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
  }
};

// ---------- Sun Engine ----------
const SunEngine = {
  getMagneticDeclination(lat, lon) {
    if (lat === null || lon === null) return 0;
    // Simple linear approximation for North America
    return (lon / 22) - (lat / 160);
  },

  getSunPosition(date, lat, lon) {
    if (lat === null || lon === null) return { altitude: 0, azimuth: 180 };
    const JD = date.getTime() / 86400000 + 2440587.5;
    const n = JD - 2451545.0;
    const L = (280.46 + 0.9856474 * n) % 360;
    const g = ((357.528 + 0.9856003 * n) % 360) * Math.PI / 180;
    const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * Math.PI / 180;
    const epsilon = 23.439 * Math.PI / 180;
    const RA = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
    const dec = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
    const GMST = (6.697375 + 0.0657098242 * n + (date.getTime() % 86400000) / 3600000) % 24;
    const LMST = (GMST + lon / 15 + 24) % 24;
    const HA = (LMST * 15 - RA * 180 / Math.PI + 360) % 360;
    const latR = lat * Math.PI / 180;
    const HAr = HA * Math.PI / 180;
    const altitude = Math.asin(
      Math.sin(dec) * Math.sin(latR) + Math.cos(dec) * Math.cos(latR) * Math.cos(HAr)
    ) * 180 / Math.PI;
    const azimuth = ((Math.atan2(
      -Math.cos(dec) * Math.cos(latR) * Math.sin(HAr),
      Math.sin(dec) - Math.sin(latR) * Math.sin(altitude * Math.PI / 180)
    ) * 180 / Math.PI) + 360) % 360;
    return { altitude, azimuth };
  },

  getSunriseSunset(date, lat, lon) {
    const day = new Date(date);
    day.setHours(0, 0, 0, 0);
    let sunrise = null, sunset = null;

    for (let h = 0; h < 24; h += 0.25) {
      const t = new Date(day.getTime() + h * 3600000);
      const pos = this.getSunPosition(t, lat, lon);
      if (pos.altitude > -0.833 && sunrise === null && h >= 3) sunrise = t;
      if (pos.altitude < -0.833 && sunrise !== null && sunset === null && h > 6) {
        sunset = t;
        break;
      }
    }
    if (!sunrise) sunrise = new Date(day.getTime() + 6.5 * 3600000);
    if (!sunset) sunset = new Date(day.getTime() + 20 * 3600000);
    return { sunrise, sunset, solarNoon: new Date((sunrise.getTime() + sunset.getTime()) / 2) };
  },

  getPeakSunHours(lat, lon) {
    const { sunrise, sunset } = this.getSunriseSunset(new Date(), lat, lon);
    let total = 0;
    const interval = (sunset.getTime() - sunrise.getTime()) / 48;
    for (let i = 0; i <= 48; i++) {
      const t = new Date(sunrise.getTime() + i * interval);
      const pos = this.getSunPosition(t, lat, lon);
      if (pos.altitude > 0) total += Math.sin(pos.altitude * Math.PI / 180) * (interval / 3600000);
    }
    return round1(total);
  },

  getOptimalFixedAngle(lat) {
    const targetLat = lat || DEFAULT_LOCATION.lat;
    return { tilt: round1(Math.abs(targetLat) * 0.76 + 3.1), azimuth: targetLat >= 0 ? 180 : 0 };
  },

  update() {
    const now = Date.now();
    if (now - state.lastSunCalc > SUN_UPDATE_INTERVAL || !state.cachedSun) {
      const date = new Date();
      state.cachedSun = this.getSunPosition(date, state.lat, state.lon);
      state.lastSunCalc = now;
      Object.assign(state, this.getSunriseSunset(date, state.lat, state.lon));
      state.peakSunHours = this.getPeakSunHours(state.lat, state.lon);
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

    if (state.sunAltitude > 0) {
      const airMass = 1 / Math.cos((90 - state.sunAltitude) * Math.PI / 180);
      state.efficiency *= Math.min(1, Math.pow(0.7, Math.pow(airMass, 0.678)));
    } else {
      state.efficiency = state.sunAltitude > -6 ? 0.05 : 0;
    }
    this.updateState();
  },

  updateState() {
    const prevState = state.alignmentState;
    let newState = prevState;

    if (state.sunAltitude < -6) newState = 'NIGHT';
    else if (state.sunAltitude < 5) newState = 'LOW_SUN';
    else if (Math.abs(state.azimuthError) > 10 || Math.abs(state.tiltError) > 15) newState = 'OFF_TARGET';
    else if (Math.abs(state.azimuthError) < 0.5 && Math.abs(state.tiltError) < 2) newState = 'LOCKED';
    else if (Math.abs(state.azimuthError) <= 3 && Math.abs(state.tiltError) <= 5) newState = 'NEAR_LOCK';
    else newState = 'TRACKING';

    if (newState !== prevState) {
      state.alignmentState = newState;
      state.stateTimestamp = Date.now();
    }
  },

  getOutput() { return Math.round(state.panels * 100 * state.efficiency); },
  getEstimatedDailyYield() {
    return round1((state.peakSunHours * state.panels * 100 * clamp(state.efficiency, 0.1, 1) * 0.85) / 1000);
  }
};

// ---------- Audio, Haptic, Storage (Omitted for space, existing logic preserved) ----------
// [Insert your original AudioEngine, HapticEngine, StorageEngine here]

// ---------- UI ----------
const UI = {
  compassCanvas: null,
  compassCtx: null,
  arcSvg: null,

  init() {
    this.compassCanvas = document.getElementById('compass-canvas');
    this.arcSvg = document.getElementById('arc-svg');

    // FIX: Dynamic Canvas Resolution
    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());

    this.compassCtx = this.compassCanvas.getContext('2d');
    this.bindEvents();
    StorageEngine.loadLastLock();
  },

  resizeCanvas() {
    if (!this.compassCanvas) return;
    const size = this.compassCanvas.offsetWidth;
    this.compassCanvas.width = size;
    this.compassCanvas.height = size;
  },

  bindEvents() {
    // Port existing button bindings from your original file...
    // [Ensure IDs like 'mode-toggle-btn' and 'save-lock-btn' are matched]
  },

  render() {
    this.drawCompass();
    // Update labels
    document.getElementById('power-output').textContent = `${AlignmentEngine.getOutput()}W`;
    document.getElementById('efficiency-label').textContent = `${Math.round(state.efficiency * 100)}% efficiency`;
  },

  drawCompass() {
    const ctx = this.compassCtx;
    const w = this.compassCanvas.width;
    const r = w / 2 - 20;
    ctx.clearRect(0, 0, w, w);
    // Draw logic remains the same...
  }
};

// ---------- App ----------
const App = {
  rafId: null,
  lastSensorUpdate: 0,

  init() {
    SensorLayer.init();
    UI.init();
    this.bindGlobalEvents();
  },

  showMainUI() {
    document.getElementById('app-header').classList.remove('hidden');
    document.getElementById('main-content').classList.remove('hidden');
  },

  bindGlobalEvents() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.enableWakeLock();
    });
  },

  async enableWakeLock() {
    if ('wakeLock' in navigator) {
      try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
    }
  },

  startMainLoop() {
    const loop = (timestamp) => {
      if (timestamp - this.lastSensorUpdate > SENSOR_READ_INTERVAL) {
        SunEngine.update();
        AlignmentEngine.update();
        this.lastSensorUpdate = timestamp;
      }
      UI.render();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
