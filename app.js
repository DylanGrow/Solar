// ============================================
// SolarLock - Solar Panel Alignment Instrument
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
    } catch (e) { /* quota exceeded, silently fail */ }
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
    if (this.needsPermission) {
      document.getElementById('enable-sensors-btn').addEventListener('click', () => this.requestPermissions());
    } else {
      document.getElementById('enable-sensors-btn').addEventListener('click', () => this.requestLocation());
    }
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
    return new Promise((resolve, reject) => {
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
          if (pos.coords.accuracy > 1000) {
            showToast('GPS accuracy low — consider manual entry');
          }
          document.getElementById('location-status').textContent = `GPS: ${round1(state.lat)}, ${round1(state.lon)} (accuracy: ${Math.round(pos.coords.accuracy)}m)`;
          resolve();
        },
        (err) => {
          clearTimeout(timeout);
          console.warn('Geolocation error:', err);
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
        state.rawAlpha = null;
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
      const corrected = (rawHeading + declination + state.calibrationOffset + 360) % 360;
      state.deviceAzimuth = corrected;

      if (state.compassAccuracy !== null && state.compassAccuracy > COMPASS_ACCURACY_THRESHOLD) {
        document.getElementById('accuracy-warning').textContent = '⚠ Low compass accuracy — avoid metal';
        document.getElementById('accuracy-warning').classList.remove('hidden');
      } else if (state.compassAccuracy !== null) {
        document.getElementById('accuracy-warning').classList.add('hidden');
      }
    }, true);

    window.addEventListener('deviceorientationabsolute', (event) => {
      if (event.alpha !== null) {
        state.rawAlpha = event.alpha;
        document.getElementById('calibration-progress').classList.add('hidden');
      }
    }, true);

    if ('geolocation' in navigator && state.locationSource === 'gps') {
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => {
          state.lat = pos.coords.latitude;
          state.lon = pos.coords.longitude;
          state.locationAcquired = true;
          state.locationSource = 'gps';
        },
        null,
        { enableHighAccuracy: true, maximumAge: 300000 }
      );
    }

    // Check for no compass after 3 seconds
    setTimeout(() => {
      if (state.rawAlpha === null && state.compassAccuracy === null && state.deviceAzimuth === 0) {
        document.getElementById('no-compass-overlay').classList.add('active');
      }
    }, 3000);
  },

  getCompassHeading(event) {
    if (event.webkitCompassHeading != null && event.webkitCompassHeading >= 0) {
      return event.webkitCompassHeading;
    }
    if (event.alpha != null) {
      return (360 - event.alpha) % 360;
    }
    return 0;
  },

  showDenied() {
    document.getElementById('permission-overlay').classList.remove('active');
    document.getElementById('sensors-denied-overlay').classList.add('active');
  },

  cleanup() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }
};

// ---------- Sun Engine ----------
const SunEngine = {
  getMagneticDeclination(lat, lon) {
    if (lat === null || lon === null) return 0;
    return (lon / 22) - (lat / 160);
  },

  getSunPosition(date, lat, lon) {
    if (lat === null || lon === null) {
      return { altitude: 0, azimuth: 180 };
    }
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
    if (lat === null || lon === null) {
      const now = new Date();
      return {
        sunrise: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 30),
        sunset: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 20, 0),
        solarNoon: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 13, 15),
      };
    }
    const day = new Date(date);
    day.setHours(0, 0, 0, 0);
    let sunrise = null;
    let sunset = null;

    for (let h = 0; h < 24; h += 0.25) {
      const t = new Date(day.getTime() + h * 3600000);
      const pos = this.getSunPosition(t, lat, lon);
      if (pos.altitude > -0.833 && sunrise === null && h >= 3) {
        sunrise = t;
      }
      if (pos.altitude < -0.833 && sunrise !== null && sunset === null && h > 6) {
        sunset = t;
        break;
      }
    }
    if (!sunrise) sunrise = new Date(day.getTime() + 6.5 * 3600000);
    if (!sunset) sunset = new Date(day.getTime() + 20 * 3600000);

    const solarNoon = new Date((sunrise.getTime() + sunset.getTime()) / 2);
    return { sunrise, sunset, solarNoon };
  },

  getPeakSunHours(lat, lon) {
    const now = new Date();
    const { sunrise, sunset } = this.getSunriseSunset(now, lat, lon);
    let total = 0;
    const steps = 48;
    const interval = (sunset.getTime() - sunrise.getTime()) / steps;
    for (let i = 0; i <= steps; i++) {
      const t = new Date(sunrise.getTime() + i * interval);
      const pos = this.getSunPosition(t, lat, lon);
      if (pos.altitude > 0) {
        total += Math.sin(pos.altitude * Math.PI / 180) * (interval / 3600000);
      }
    }
    return Math.round(total * 10) / 10;
  },

  getOptimalFixedAngle(lat) {
    if (lat === null) lat = DEFAULT_LOCATION.lat;
    const tilt = Math.abs(lat) * 0.76 + 3.1;
    const azimuth = lat >= 0 ? 180 : 0;
    return { tilt: round1(tilt), azimuth };
  },

  update() {
    const now = Date.now();
    if (now - state.lastSunCalc > SUN_UPDATE_INTERVAL || !state.cachedSun) {
      const date = new Date();
      state.cachedSun = this.getSunPosition(date, state.lat, state.lon);
      state.lastSunCalc = now;

      const { sunrise, sunset, solarNoon } = this.getSunriseSunset(date, state.lat, state.lon);
      state.sunrise = sunrise;
      state.sunset = sunset;
      state.solarNoon = solarNoon;
      state.peakSunHours = this.getPeakSunHours(state.lat, state.lon);
    }
    state.sunAzimuth = state.cachedSun.azimuth;
    state.sunAltitude = state.cachedSun.altitude;
  }
};

// ---------- Alignment Engine ----------
const AlignmentEngine = {
  update() {
    if (state.mode === 'fixed') {
      const optimal = SunEngine.getOptimalFixedAngle(state.lat);
      state.azimuthError = angleDifference(state.deviceAzimuth, optimal.azimuth);
      state.tiltError = state.deviceTilt - optimal.tilt;
    } else {
      state.azimuthError = angleDifference(state.deviceAzimuth, state.sunAzimuth);
      state.tiltError = state.deviceTilt - state.sunAltitude;
    }

    const azEff = Math.max(0, Math.cos(Math.abs(state.azimuthError) * Math.PI / 180));
    const tiltEff = Math.max(0, Math.cos(Math.abs(state.tiltError) * Math.PI / 180));
    state.efficiency = azEff * tiltEff;

    if (state.sunAltitude > 0) {
      const airMass = 1 / Math.cos((90 - state.sunAltitude) * Math.PI / 180);
      state.efficiency *= Math.min(1, Math.pow(0.7, Math.pow(airMass, 0.678)));
    } else if (state.sunAltitude > -6) {
      state.efficiency *= 0.05;
    } else {
      state.efficiency = 0;
    }

    this.updateState();
  },

  updateState() {
    const prevState = state.alignmentState;
    let newState = prevState;

    if (state.sunAltitude < -6) {
      newState = 'NIGHT';
    } else if (state.sunAltitude < 5) {
      newState = 'LOW_SUN';
    } else if (Math.abs(state.azimuthError) > 10 || Math.abs(state.tiltError) > 15) {
      newState = 'OFF_TARGET';
      this.clearUpgrade();
    } else if (Math.abs(state.azimuthError) < 0.5 && Math.abs(state.tiltError) < 2) {
      if (prevState !== 'LOCKED') {
        if (!state.stateUpgradePending) {
          state.stateUpgradePending = true;
          state.stateUpgradeTimer = setTimeout(() => {
            state.alignmentState = 'LOCKED';
            state.stateTimestamp = Date.now();
            state.stateUpgradePending = false;
          }, HYSTERESIS_DURATION);
        }
        newState = prevState;
      } else {
        newState = 'LOCKED';
      }
    } else if (Math.abs(state.azimuthError) <= 3 && Math.abs(state.tiltError) <= 5) {
      if (prevState !== 'NEAR_LOCK' && prevState !== 'LOCKED') {
        if (!state.stateUpgradePending) {
          state.stateUpgradePending = true;
          state.stateUpgradeTimer = setTimeout(() => {
            state.alignmentState = 'NEAR_LOCK';
            state.stateTimestamp = Date.now();
            state.stateUpgradePending = false;
          }, HYSTERESIS_DURATION);
        }
        newState = prevState;
      } else if (prevState !== 'LOCKED') {
        newState = 'NEAR_LOCK';
      } else {
        newState = prevState;
      }
    } else if (Math.abs(state.azimuthError) <= 10 && Math.abs(state.tiltError) <= 15) {
      if (prevState !== 'TRACKING' && prevState !== 'NEAR_LOCK' && prevState !== 'LOCKED') {
        if (!state.stateUpgradePending) {
          state.stateUpgradePending = true;
          state.stateUpgradeTimer = setTimeout(() => {
            state.alignmentState = 'TRACKING';
            state.stateTimestamp = Date.now();
            state.stateUpgradePending = false;
          }, HYSTERESIS_DURATION);
        }
        newState = prevState;
      } else if (prevState !== 'NEAR_LOCK' && prevState !== 'LOCKED') {
        newState = 'TRACKING';
      } else {
        newState = prevState;
      }
    } else {
      newState = 'OFF_TARGET';
      this.clearUpgrade();
    }

    if (newState !== prevState && newState !== 'LOCKED') {
      state.alignmentState = newState;
      state.stateTimestamp = Date.now();
    }
  },

  clearUpgrade() {
    if (state.stateUpgradeTimer) {
      clearTimeout(state.stateUpgradeTimer);
      state.stateUpgradeTimer = null;
    }
    state.stateUpgradePending = false;
  },

  getOutput() {
    const maxOutput = state.panels * 100;
    return Math.round(maxOutput * state.efficiency);
  },

  getEstimatedDailyYield() {
    const maxOutput = state.panels * 100;
    const avgEff = clamp(state.efficiency, 0.1, 1);
    return round1((state.peakSunHours * maxOutput * avgEff * 0.85) / 1000);
  }
};

// ---------- Audio Engine ----------
const AudioEngine = {
  ctx: null,
  gainNode: null,
  oscillator: null,
  lfoOsc: null,
  lfoGain: null,
  currentInterval: null,
  tickTimer: null,

  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.gainNode = this.ctx.createGain();
      this.gainNode.connect(this.ctx.destination);
      this.gainNode.gain.value = 0;
    } catch (e) {
      console.warn('Audio not available');
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.ctx?.state === 'suspended') {
        this.ctx.resume();
      }
    });
  },

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  },

  stop() {
    this.clearSounds();
    if (this.oscillator) {
      try { this.oscillator.stop(); } catch (e) {}
      this.oscillator = null;
    }
    if (this.lfoOsc) {
      try { this.lfoOsc.stop(); } catch (e) {}
      this.lfoOsc = null;
    }
  },

  clearSounds() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.gainNode && (this.gainNode.gain.value = 0);
  },

  setState(alignmentState, azError, azDirection) {
    if (!this.ctx || state.muted) return;
    if (document.hidden) { this.clearSounds(); return; }
    if (this.ctx.state === 'suspended') { this.ctx.resume(); return; }

    this.clearSounds();
    this.stop();

    const pitchMod = clamp(azError * 15 * (azDirection === 'left' ? -1 : 1), -200, 200);

    switch (alignmentState) {
      case 'NIGHT':
        break;
      case 'LOW_SUN':
        this.playTone(220, 0.04);
        this.tickTimer = setInterval(() => {
          if (state.alignmentState === 'LOW_SUN') this.playTone(220, 0.04, 0.3);
        }, 4000);
        break;
      case 'OFF_TARGET':
        break;
      case 'TRACKING':
        this.tickTimer = setInterval(() => {
          this.playTone(880 + pitchMod, 0.06, 0.05);
        }, 1000);
        break;
      case 'NEAR_LOCK':
        this.tickTimer = setInterval(() => {
          this.playTone(1100 + pitchMod, 0.08, 0.03);
        }, 300);
        break;
      case 'LOCKED':
        this.playContinuous(1760, 0.12);
        this.addTremolo(8, 5);
        break;
    }
  },

  playTone(freq, gain, duration) {
    if (!this.ctx || this.ctx.state === 'suspended') return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(gain, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + (duration || 0.2));
    osc.connect(g);
    g.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + (duration || 0.2) + 0.01);
  },

  playContinuous(freq, gain) {
    if (!this.ctx || this.ctx.state === 'suspended') return;
    this.stop();
    this.oscillator = this.ctx.createOscillator();
    this.oscillator.type = 'sine';
    this.oscillator.frequency.value = freq;
    this.oscillator.connect(this.gainNode);
    this.gainNode.gain.setValueAtTime(gain, this.ctx.currentTime);
    this.oscillator.start();
  },

  addTremolo(rate, depth) {
    if (!this.ctx || !this.oscillator) return;
    this.lfoOsc = this.ctx.createOscillator();
    this.lfoGain = this.ctx.createGain();
    this.lfoOsc.frequency.value = rate;
    this.lfoGain.gain.value = depth;
    this.lfoOsc.connect(this.lfoGain);
    this.lfoGain.connect(this.oscillator.frequency);
    this.lfoOsc.start();
  }
};

// ---------- Haptic Engine ----------
const HapticEngine = {
  lastHaptic: 0,
  hapticInterval: null,

  setState(alignmentState) {
    if (this.hapticInterval) {
      clearInterval(this.hapticInterval);
      this.hapticInterval = null;
    }
    if (document.hidden) return;

    switch (alignmentState) {
      case 'TRACKING':
        this.hapticInterval = setInterval(() => safeVibrate([20]), 2000);
        break;
      case 'NEAR_LOCK':
        this.hapticInterval = setInterval(() => {
          safeVibrate([30, 50, 30]);
        }, 500);
        break;
      case 'LOCKED':
        if (Date.now() - this.lastHaptic > 2000) {
          safeVibrate([100, 30, 100]);
          this.lastHaptic = Date.now();
        }
        break;
      default:
        break;
    }
  },

  clearAll() {
    if (this.hapticInterval) {
      clearInterval(this.hapticInterval);
      this.hapticInterval = null;
    }
  }
};

// ---------- Storage Engine ----------
const StorageEngine = {
  saveLock() {
    const lockData = {
      azimuth: round1(state.deviceAzimuth),
      tilt: round1(state.deviceTilt),
      timestamp: new Date().toISOString(),
      location: state.locationAcquired ? `Lat ${round1(state.lat)}, Lon ${round1(state.lon)}` : 'Unknown',
      output: AlignmentEngine.getOutput(),
      panels: state.panels,
      mode: state.mode,
    };
    state.lastLock = lockData;
    debouncedSetItem('solarlock_last_lock', lockData);
    this.displayLastLock();
    document.getElementById('lock-saved-badge').classList.remove('hidden');
    document.getElementById('export-lock-btn').classList.remove('hidden');
    document.getElementById('copy-lock-btn').classList.remove('hidden');
    document.getElementById('last-lock-card').classList.remove('hidden');
    showToast('Lock saved ✓');
  },

  loadLastLock() {
    state.lastLock = safeParseJSON('solarlock_last_lock', null);
    if (state.lastLock) {
      this.displayLastLock();
      document.getElementById('export-lock-btn').classList.remove('hidden');
      document.getElementById('copy-lock-btn').classList.remove('hidden');
      document.getElementById('last-lock-card').classList.remove('hidden');
    }
  },

  displayLastLock() {
    if (!state.lastLock) {
      document.getElementById('last-lock-content').textContent = 'No saved lock';
      return;
    }
    const l = state.lastLock;
    document.getElementById('last-lock-content').innerHTML = `
      Panel setting: Face <strong>${l.azimuth}°</strong> South, tilt <strong>${l.tilt}°</strong><br>
      Output: ${l.output}W | Panels: ${l.panels}<br>
      ${l.timestamp ? new Date(l.timestamp).toLocaleString() : ''}<br>
      ${l.location}
    `;
  },

  exportLock() {
    if (!state.lastLock) return;
    const l = state.lastLock;
    const text = `SolarLock Panel Setting\n` +
      `Face: ${l.azimuth}° (${l.mode === 'fixed' ? 'Optimal Fixed' : 'Sun-Tracked'})\n` +
      `Tilt: ${l.tilt}°\n` +
      `Panels: ${l.panels} × 100W = ${l.output}W\n` +
      `Location: ${l.location}\n` +
      `Saved: ${l.timestamp}\n`;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'solarlock-reading.txt';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Exported');
  },

  copyLock() {
    if (!state.lastLock) return;
    const l = state.lastLock;
    const text = `Panel setting: Face ${l.azimuth}° South, tilt ${l.tilt}°`;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard'));
    } else {
      showToast('Clipboard not available');
    }
  }
};

// ---------- UI ----------
const UI = {
  compassCanvas: null,
  compassCtx: null,
  arcSvg: null,
  arcPanelVisible: false,

  init() {
    this.compassCanvas = document.getElementById('compass-canvas');
    this.compassCtx = this.compassCanvas.getContext('2d');
    this.arcSvg = document.getElementById('arc-svg');
    this.bindEvents();
    StorageEngine.loadLastLock();
    this.updateOnlineStatus();
  },

  bindEvents() {
    document.getElementById('calibration-btn').addEventListener('click', () => this.togglePanel('calibration-panel'));
    document.getElementById('close-calibration-btn').addEventListener('click', () => this.hidePanel('calibration-panel'));
    document.getElementById('info-btn').addEventListener('click', () => this.togglePanel('info-panel'));
    document.getElementById('close-info-btn').addEventListener('click', () => this.hidePanel('info-panel'));
    document.getElementById('toggle-arc-btn').addEventListener('click', () => this.toggleArcPanel());
    document.getElementById('close-arc-btn').addEventListener('click', () => this.hideArcPanel());
    document.getElementById('location-settings-btn').addEventListener('click', () => this.togglePanel('location-panel'));
    document.getElementById('close-location-btn').addEventListener('click', () => this.hidePanel('location-panel'));

    const panelSlider = document.getElementById('panel-slider');
    const panelNumInput = document.getElementById('panel-number-input');
    const panelCountValue = document.getElementById('panel-count-value');

    panelSlider.addEventListener('input', () => {
      const val = parseInt(panelSlider.value);
      panelNumInput.value = val;
      panelCountValue.textContent = val;
      state.panels = val;
    });
    panelNumInput.addEventListener('input', () => {
      let val = parseInt(panelNumInput.value);
      if (isNaN(val)) val = 1;
      val = clamp(val, 1, 50);
      panelNumInput.value = val;
      panelSlider.value = val;
      panelCountValue.textContent = val;
      state.panels = val;
    });

    document.getElementById('cal-offset-slider').addEventListener('input', (e) => {
      state.calibrationOffset = parseFloat(e.target.value);
      document.getElementById('cal-offset-value').textContent = round1(state.calibrationOffset) + '°';
    });

    document.getElementById('zero-tilt-btn').addEventListener('click', () => {
      state.tiltZeroOffset = state.rawBeta || 0;
      document.getElementById('tilt-zero-value').textContent = `Offset: ${round1(state.tiltZeroOffset)}°`;
      showToast('Tilt zeroed');
    });

    document.getElementById('reset-compass-btn').addEventListener('click', () => {
      state.calibrationOffset = 0;
      document.getElementById('cal-offset-slider').value = 0;
      document.getElementById('cal-offset-value').textContent = '0°';
      showToast('Compass offset reset');
    });

    document.getElementById('reset-cal-btn').addEventListener('click', () => {
      if (confirm('Reset all calibration to defaults?')) {
        state.calibrationOffset = 0;
        state.tiltZeroOffset = 0;
        document.getElementById('cal-offset-slider').value = 0;
        document.getElementById('cal-offset-value').textContent = '0°';
        document.getElementById('tilt-zero-value').textContent = 'Offset: 0.0°';
        showToast('Calibration reset');
      }
    });

    document.getElementById('mode-toggle-btn').addEventListener('click', () => {
      state.mode = state.mode === 'realtime' ? 'fixed' : 'realtime';
      document.getElementById('mode-toggle-btn').textContent =
        state.mode === 'realtime' ? 'Fixed Angle Mode' : 'Real-Time Tracking';
      showToast(state.mode === 'realtime' ? 'Real-time tracking' : 'Fixed angle mode');
    });

    document.getElementById('save-lock-btn').addEventListener('click', () => StorageEngine.saveLock());
    document.getElementById('export-lock-btn').addEventListener('click', () => StorageEngine.exportLock());
    document.getElementById('copy-lock-btn').addEventListener('click', () => StorageEngine.copyLock());

    document.getElementById('mute-btn').addEventListener('click', () => {
      state.muted = !state.muted;
      document.getElementById('mute-icon-unmuted').classList.toggle('hidden', state.muted);
      document.getElementById('mute-icon-muted').classList.toggle('hidden', !state.muted);
      if (state.muted) {
        AudioEngine.stop();
        HapticEngine.clearAll();
      }
      showToast(state.muted ? 'Muted' : 'Unmuted');
    });

    document.getElementById('flashlight-btn').addEventListener('click', () => {
      state.flashlightMode = !state.flashlightMode;
      document.body.style.filter = state.flashlightMode ? 'invert(0.9) brightness(1.5)' : 'none';
      showToast(state.flashlightMode ? 'High contrast on' : 'High contrast off');
    });

    document.getElementById('apply-location-btn').addEventListener('click', () => {
      const lat = parseFloat(document.getElementById('manual-lat').value);
      const lon = parseFloat(document.getElementById('manual-lon').value);
      if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        state.lat = lat;
        state.lon = lon;
        state.locationAcquired = true;
        state.locationSource = 'manual';
        document.getElementById('location-status').textContent = `Manual: ${round1(lat)}, ${round1(lon)}`;
        showToast('Location updated');
      } else {
        showToast('Invalid coordinates');
      }
    });

    document.getElementById('use-gps-btn').addEventListener('click', () => {
      SensorLayer.requestLocation().then(() => {
        showToast('Using GPS location');
      });
    });

    // Two-finger swipe for arc panel
    let touchStartY = 0;
    let twoFingerActive = false;
    document.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        touchStartY = e.touches[0].clientY;
        twoFingerActive = true;
      }
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
      if (twoFingerActive && e.touches.length < 2) {
        const dy = (e.changedTouches[0]?.clientY || 0) - touchStartY;
        if (Math.abs(dy) > 60) {
          UI.toggleArcPanel();
        }
        twoFingerActive = false;
        touchStartY = 0;
      }
    });

    // Portrait enforcement
    this.checkOrientation();
    window.addEventListener('orientationchange', () => {
      setTimeout(() => this.checkOrientation(), 300);
    });
    if (screen.orientation) {
      screen.orientation.addEventListener('change', () => {
        setTimeout(() => this.checkOrientation(), 300);
      });
    }
  },

  checkOrientation() {
    const isPortrait = window.innerHeight > window.innerWidth;
    const portraitOverlay = document.getElementById('portrait-overlay');
    if (!isPortrait && state.permissionGranted) {
      portraitOverlay.classList.add('active');
      AudioEngine.stop();
      HapticEngine.clearAll();
    } else {
      portraitOverlay.classList.remove('active');
    }
  },

  togglePanel(panelId) {
    const panel = document.getElementById(panelId);
    const isHidden = panel.classList.contains('hidden');
    document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
    if (isHidden) {
      panel.classList.remove('hidden');
    }
  },

  hidePanel(panelId) {
    document.getElementById(panelId).classList.add('hidden');
  },

  toggleArcPanel() {
    this.arcPanelVisible = !this.arcPanelVisible;
    const panel = document.getElementById('arc-panel');
    if (this.arcPanelVisible) {
      panel.classList.remove('hidden');
      document.getElementById('toggle-arc-btn').textContent = 'Hide Arc';
      this.drawArc();
    } else {
      panel.classList.add('hidden');
      document.getElementById('toggle-arc-btn').textContent = 'Show Arc';
    }
  },

  hideArcPanel() {
    this.arcPanelVisible = false;
    document.getElementById('arc-panel').classList.add('hidden');
    document.getElementById('toggle-arc-btn').textContent = 'Show Arc';
  },

  updateOnlineStatus() {
    const indicator = document.getElementById('online-indicator');
    state.isOnline = navigator.onLine;
    indicator.className = state.isOnline ? 'online' : 'offline';
    indicator.title = state.isOnline ? 'Online' : 'Offline';
  },

  drawCompass() {
    const canvas = this.compassCanvas;
    const ctx = this.compassCtx;
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) / 2 - 20;

    ctx.clearRect(0, 0, w, h);

    // Outer ring
    ctx.strokeStyle = '#333355';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    // Degree markers
    for (let deg = 0; deg < 360; deg += 10) {
      const rad = (deg - 90) * Math.PI / 180;
      const isCardinal = deg % 30 === 0;
      const innerR = r - (isCardinal ? 16 : 10);
      const outerR = r - 4;
      const x1 = cx + Math.cos(rad) * innerR;
      const y1 = cy + Math.sin(rad) * innerR;
      const x2 = cx + Math.cos(rad) * outerR;
      const y2 = cy + Math.sin(rad) * outerR;
      ctx.strokeStyle = isCardinal ? '#8888a0' : '#44445a';
      ctx.lineWidth = isCardinal ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      if (isCardinal) {
        const labelR = r - 24;
        const lx = cx + Math.cos(rad) * labelR;
        const ly = cy + Math.sin(rad) * labelR;
        ctx.fillStyle = '#8888a0';
        ctx.font = 'bold 12px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(deg, lx, ly);
      }
    }

    // Cardinal labels
    const cardinals = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    cardinals.forEach((label, i) => {
      const deg = i * 45;
      const rad = (deg - 90) * Math.PI / 180;
      const lr = r - 36;
      const lx = cx + Math.cos(rad) * lr;
      const ly = cy + Math.sin(rad) * lr;
      ctx.fillStyle = '#e8e8f0';
      ctx.font = 'bold 13px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, lx, ly);
    });

    // Sun needle (amber) - smoothed
    const sunRad = (state.sunAzimuth - 90) * Math.PI / 180;
    const sunX = cx + Math.cos(sunRad) * (r - 30);
    const sunY = cy + Math.sin(sunRad) * (r - 30);

    ctx.strokeStyle = '#f5a623';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(sunRad) * 10, cy - Math.sin(sunRad) * 10);
    ctx.lineTo(sunX, sunY);
    ctx.stroke();

    // Sun triangle marker
    ctx.fillStyle = '#f5a623';
    ctx.beginPath();
    ctx.moveTo(sunX, sunY);
    ctx.lineTo(
      sunX + Math.cos(sunRad + 2.5) * 12,
      sunY + Math.sin(sunRad + 2.5) * 12
    );
    ctx.lineTo(
      sunX + Math.cos(sunRad - 2.5) * 12,
      sunY + Math.sin(sunRad - 2.5) * 12
    );
    ctx.closePath();
    ctx.fill();

    // Phone needle (white) - immediate
    const phoneRad = (state.deviceAzimuth - 90) * Math.PI / 180;
    const phoneX = cx + Math.cos(phoneRad) * (r - 25);
    const phoneY = cy + Math.sin(phoneRad) * (r - 25);

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.setLineDash([1, 3]);
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(phoneRad) * 8, cy - Math.sin(phoneRad) * 8);
    ctx.lineTo(phoneX, phoneY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Phone triangle marker (outline)
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(phoneX, phoneY);
    ctx.lineTo(
      phoneX + Math.cos(phoneRad + 2.2) * 14,
      phoneY + Math.sin(phoneRad + 2.2) * 14
    );
    ctx.lineTo(
      phoneX + Math.cos(phoneRad - 2.2) * 14,
      phoneY + Math.sin(phoneRad - 2.2) * 14
    );
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Difference arc
    const diffArc = Math.abs(angleDifference(state.deviceAzimuth, state.sunAzimuth));
    if (diffArc > 0.2 && diffArc < 180) {
      const startAngle = (state.sunAzimuth - 90) * Math.PI / 180;
      const endAngle = (state.deviceAzimuth - 90) * Math.PI / 180;
      let arcColor = '#ff1744';
      if (state.alignmentState === 'LOCKED') arcColor = '#00e676';
      else if (state.alignmentState === 'NEAR_LOCK') arcColor = '#88aa44';
      else if (state.alignmentState === 'TRACKING') arcColor = '#f5a623';

      ctx.strokeStyle = arcColor;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, r - 6, Math.min(startAngle, endAngle), Math.max(startAngle, endAngle));
      ctx.stroke();
    }

    // Center dot
    const centerColor = {
      NIGHT: '#334466',
      LOW_SUN: '#886633',
      OFF_TARGET: '#884444',
      TRACKING: '#997744',
      NEAR_LOCK: '#88aa44',
      LOCKED: '#00e676',
    };
    ctx.fillStyle = centerColor[state.alignmentState] || '#667799';
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#1a1a24';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Fixed mode target indicator
    if (state.mode === 'fixed') {
      const optimal = SunEngine.getOptimalFixedAngle(state.lat);
      const optRad = (optimal.azimuth - 90) * Math.PI / 180;
      const optX = cx + Math.cos(optRad) * (r - 20);
      const optY = cy + Math.sin(optRad) * (r - 20);
      ctx.fillStyle = '#448aff';
      ctx.beginPath();
      ctx.arc(optX, optY, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('T', optX, optY);
    }
  },

  drawArc() {
    const svg = this.arcSvg;
    if (!state.sunrise || !state.sunset) return;

    const w = 300;
    const h = 160;
    const pad = 20;
    const pw = w - pad * 2;
    const ph = h - pad * 2;

    const sunriseMs = state.sunrise.getTime();
    const sunsetMs = state.sunset.getTime();
    const noonMs = state.solarNoon.getTime();
    const nowMs = Date.now();

    const steps = 60;
    let pathData = '';
    let peakStart = null;
    let peakEnd = null;
    let nowX = null;
    let nowY = null;

    for (let i = 0; i <= steps; i++) {
      const t = sunriseMs + (sunsetMs - sunriseMs) * (i / steps);
      const pos = SunEngine.getSunPosition(new Date(t), state.lat, state.lon);
      const x = pad + (i / steps) * pw;
      const y = pad + ph - (Math.max(0, pos.altitude) / 90) * ph;
      if (i === 0) pathData += `M${x},${y}`;
      else pathData += ` L${x},${y}`;

      if (pos.altitude > 20 && peakStart === null) peakStart = x;
      if (pos.altitude > 20) peakEnd = x;

      if (t <= nowMs && (t + (sunsetMs - sunriseMs) / steps) > nowMs) {
        nowX = x;
        nowY = y;
      }
    }

    svg.innerHTML = `
      <defs>
        <linearGradient id="skyGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#1a1a33"/>
          <stop offset="100%" stop-color="#0a0a0f"/>
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${w}" height="${h}" fill="url(#skyGrad)" rx="8"/>
      <line x1="${pad}" y1="${pad + ph}" x2="${w - pad}" y2="${pad + ph}" stroke="#44445a" stroke-width="1"/>
      <path d="${pathData}" fill="none" stroke="#f5a623" stroke-width="2.5" opacity="0.8"/>
      ${peakStart !== null && peakEnd !== null ? `
        <rect x="${peakStart}" y="${pad}" width="${peakEnd - peakStart}" height="${ph}" fill="rgba(245,166,35,0.1)" rx="2"/>
      ` : ''}
      ${nowX !== null && nowY !== null ? `
        <circle cx="${nowX}" cy="${nowY}" r="5" fill="#00e676"/>
        <circle cx="${nowX}" cy="${nowY}" r="9" fill="none" stroke="#00e676" stroke-width="1.5" opacity="0.5"/>
      ` : ''}
      <text x="${pad}" y="${h - 4}" fill="#8888a0" font-size="9" font-family="monospace">Sunrise</text>
      <text x="${w - pad}" y="${h - 4}" fill="#8888a0" font-size="9" font-family="monospace" text-anchor="end">Sunset</text>
      <text x="${w / 2}" y="12" fill="#f5a623" font-size="10" font-family="monospace" text-anchor="middle">Solar Noon</text>
    `;

    document.getElementById('arc-sunrise').textContent = formatTime(state.sunrise);
    document.getElementById('arc-sunset').textContent = formatTime(state.sunset);
    document.getElementById('arc-noon').textContent = formatTime(state.solarNoon);

    if (state.sunrise && state.sunset) {
      const peakWindowStart = new Date(state.sunrise.getTime() + 3600000);
      const peakWindowEnd = new Date(state.sunset.getTime() - 3600000);
      document.getElementById('arc-peak-window').textContent =
        `Best time to align: ${formatTime(peakWindowStart)} – ${formatTime(peakWindowEnd)}`;

      const now = new Date();
      const remaining = peakWindowEnd.getTime() - now.getTime();
      if (remaining > 0) {
        const hRem = Math.floor(remaining / 3600000);
        const mRem = Math.floor((remaining % 3600000) / 60000);
        document.getElementById('peak-countdown').textContent =
          `Peak window: ${hRem}h ${mRem}m remaining`;
      } else {
        document.getElementById('peak-countdown').textContent = 'Peak window has closed';
      }
    }
  },

  render() {
    this.drawCompass();
    if (this.arcPanelVisible) this.drawArc();

    // Display angles
    const displayAz = round1(state.deviceAzimuth);
    const displayTilt = round1(state.deviceTilt - state.tiltZeroOffset);
    const displaySunAz = round1(state.sunAzimuth);
    const displaySunAlt = round1(state.sunAltitude);

    // Guidance
    const azErr = state.azimuthError;
    const tiltErr = state.tiltError;

    let azInstruction = '';
    if (state.alignmentState === 'NIGHT') {
      azInstruction = '☽ Night — sun below horizon';
    } else if (state.alignmentState === 'LOW_SUN') {
      azInstruction = '⚠ Sun too low — limited output';
    } else if (Math.abs(azErr) > 10) {
      azInstruction = azErr < 0 ? 'TURN RIGHT →→' : 'TURN LEFT ←←';
    } else if (Math.abs(azErr) > 3) {
      azInstruction = azErr < 0 ? 'Turn right →' : 'Turn left ←';
    } else if (Math.abs(azErr) > 0.5) {
      azInstruction = azErr < 0 ? 'Nudge right' : 'Nudge left';
    } else {
      azInstruction = '✓ Direction locked';
    }

    let tiltInstruction = '';
    if (state.alignmentState === 'NIGHT') {
      tiltInstruction = '';
    } else if (state.alignmentState === 'LOW_SUN') {
      tiltInstruction = '';
    } else if (Math.abs(tiltErr) > 15) {
      tiltInstruction = tiltErr < 0 ? 'TILT UP ↑↑' : 'TILT DOWN ↓↓';
    } else if (Math.abs(tiltErr) > 5) {
      tiltInstruction = tiltErr < 0 ? 'Tilt up ↑' : 'Tilt down ↓';
    } else if (Math.abs(tiltErr) > 2) {
      tiltInstruction = 'Slight tilt needed';
    } else {
      tiltInstruction = '✓ Angle locked';
    }

    document.getElementById('az-instruction').textContent = azInstruction;
    document.getElementById('tilt-instruction').textContent = tiltInstruction;

    document.getElementById('az-target').textContent =
      state.mode === 'fixed'
        ? `Target: ${round1(SunEngine.getOptimalFixedAngle(state.lat).azimuth)}° — You: ${displayAz}°`
        : `Sun at ${displaySunAz}° — You're at ${displayAz}° (${Math.abs(round1(azErr))}° ${azErr < 0 ? 'right' : 'left'})`;
    document.getElementById('tilt-target').textContent =
      state.mode === 'fixed'
        ? `Target tilt: ${SunEngine.getOptimalFixedAngle(state.lat).tilt}° — Yours: ${displayTilt}°`
        : `Sun altitude ${displaySunAlt}° — Your tilt ${displayTilt}° (${tiltErr < 0 ? 'tilt up' : 'tilt down'} ${Math.abs(round1(tiltErr))}°)`;

    // Efficiency bar
    const effPercent = Math.round(state.efficiency * 100);
    const effBar = document.getElementById('efficiency-bar');
    effBar.style.width = effPercent + '%';
    effBar.style.background = effPercent > 90 ? 'var(--accent-green)' :
      effPercent > 50 ? 'var(--accent-amber)' : 'var(--accent-red)';
    effBar.setAttribute('aria-valuenow', effPercent);
    document.getElementById('efficiency-label').textContent = `${effPercent}% efficiency`;

    const output = AlignmentEngine.getOutput();
    const maxOutput = state.panels * 100;
    document.getElementById('power-output').textContent = `${output.toLocaleString()}W / ${maxOutput.toLocaleString()}W max`;

    const dailyYield = AlignmentEngine.getEstimatedDailyYield();
    document.getElementById('daily-yield').textContent = `Est. ${dailyYield} kWh today`;

    // State badge
    const badge = document.getElementById('state-badge');
    badge.className = '';
    const stateClasses = {
      NIGHT: 'state-night',
      LOW_SUN: 'state-low-sun',
      OFF_TARGET: 'state-off-target',
      TRACKING: 'state-tracking',
      NEAR_LOCK: 'state-near-lock',
      LOCKED: 'state-locked',
    };
    badge.className = stateClasses[state.alignmentState] || '';
    badge.textContent = state.alignmentState.replace('_', ' ');

    // Save lock button
    const saveBtn = document.getElementById('save-lock-btn');
    saveBtn.disabled = state.alignmentState !== 'LOCKED';

    // Screen reader
    const guidance = [azInstruction, tiltInstruction].filter(Boolean).join('. ');
    document.getElementById('screen-reader-guidance').textContent = guidance;

    // Calibration preview
    document.getElementById('cal-preview-az').textContent = displayAz + '°';
    document.getElementById('cal-preview-tilt').textContent = displayTilt + '°';

    // Off-target suggestion
    if (state.sunAltitude > 5 && state.efficiency < 0.05 && state.alignmentState === 'OFF_TARGET') {
      document.getElementById('power-output').textContent = 'Panel facing away from sun';
    }
  }
};

// ---------- App ----------
const App = {
  rafId: null,
  lastSensorUpdate: 0,
  lastStateChange: null,
  lockTimer: null,
  idleCheckInterval: null,

  init() {
    SensorLayer.init();
    UI.init();
    this.registerSW();
    this.bindGlobalEvents();

    if (!SensorLayer.needsPermission) {
      // Android or non-iOS: show permission overlay
    }
  },

  showMainUI() {
    document.getElementById('app-header').classList.remove('hidden');
    document.getElementById('main-content').classList.remove('hidden');
  },

  bindGlobalEvents() {
    window.addEventListener('online', () => {
      state.isOnline = true;
      UI.updateOnlineStatus();
    });
    window.addEventListener('offline', () => {
      state.isOnline = false;
      UI.updateOnlineStatus();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.enableWakeLock();
        AudioEngine.resume();
      } else {
        AudioEngine.stop();
        HapticEngine.clearAll();
        if (state.wakeLock) {
          state.wakeLock.release().catch(() => {});
          state.wakeLock = null;
        }
      }
    });
  },

  async enableWakeLock() {
    try {
      if ('wakeLock' in navigator && !state.wakeLock) {
        state.wakeLock = await navigator.wakeLock.request('screen');
        state.wakeLock.addEventListener('release', () => {
          state.wakeLock = null;
        });
      }
    } catch (e) { /* not critical */ }
  },

  registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(reg => {
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                showToast('New version ready — reload to update');
              }
            });
          }
        });
      }).catch(() => { /* offline, no SW */ });

      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'SW_ACTIVATED') {
          console.log('Service worker activated');
        }
      });
    }
  },

  startMainLoop() {
    const loop = (timestamp) => {
      if (!state.permissionGranted) {
        this.rafId = requestAnimationFrame(loop);
        return;
      }

      if (timestamp - this.lastSensorUpdate > SENSOR_READ_INTERVAL) {
        SunEngine.update();
        AlignmentEngine.update();
        this.lastSensorUpdate = timestamp;
      }

      // State change handling
      if (state.alignmentState !== this.lastStateChange) {
        AudioEngine.setState(state.alignmentState, state.azimuthError,
          state.azimuthError < 0 ? 'right' : 'left');
        HapticEngine.setState(state.alignmentState);
        this.lastStateChange = state.alignmentState;

        if (state.alignmentState === 'LOCKED') {
          if (!this.lockTimer) {
            this.lockTimer = setTimeout(() => {
              StorageEngine.saveLock();
              this.lockTimer = null;
            }, LOCK_SAVE_DURATION);
          }
        } else {
          if (this.lockTimer) {
            clearTimeout(this.lockTimer);
            this.lockTimer = null;
          }
        }
      }

      UI.render();
      this.rafId = requestAnimationFrame(loop);
    };

    // Idle check
    this.idleCheckInterval = setInterval(() => {
      if (Date.now() - state.lastMotionTime > IDLE_TIMEOUT && state.wakeLock) {
        state.wakeLock.release().catch(() => {});
        state.wakeLock = null;
      }
    }, 60000);

    this.rafId = requestAnimationFrame(loop);
  },

  cleanup() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.idleCheckInterval) clearInterval(this.idleCheckInterval);
    if (this.lockTimer) clearTimeout(this.lockTimer);
    SensorLayer.cleanup();
    AudioEngine.stop();
    HapticEngine.clearAll();
    if (state.wakeLock) {
      state.wakeLock.release().catch(() => {});
      state.wakeLock = null;
    }
  }
};

// ---------- Boot ----------
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});

window.addEventListener('beforeunload', () => {
  App.cleanup();
});
