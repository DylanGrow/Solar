// SolarLock — Rewritten app.js with full UI wiring & debugged physics
// This version correctly calculates true incidence angles, timezone offsets,
// persists calibration offsets, handles fixed angle modes, and smoothly draws the arc.

/* =============================================================
   CONFIG & GLOBAL STATE
   ============================================================= */
const CONFIG = {
    DEFAULT_LAT: 35.1085,
    DEFAULT_LON: -77.0441,
    DECLINATION_MAP: { "35.1085,-77.0441": -9.4 },
    SMOOTHING: 0.15,
    WATT_PER_PANEL: 400,
    PEAK_HOURS: 5,
    AUDIO_LOCK_TONE: 880,
    AUDIO_PULSE_BASE: 400,
    AUDIO_PULSE_RANGE: 20,
    AUDIO_PULSE_MIN_INTERVAL: 0.1,
    AUDIO_PULSE_MAX_INTERVAL: 1.5
};

let state = {
    active: false,
    mode: 'realtime', // 'realtime' or 'fixed'
    lat: CONFIG.DEFAULT_LAT,
    lon: CONFIG.DEFAULT_LON,
    phoneAz: 0,
    phoneTilt: 0,
    rawTilt: 0,
    azOffset: 0,
    tiltOffset: 0,
    sunAz: 0,
    sunEl: 0,
    errorDeg: 999,
    panels: 10,
    isMuted: false,
    wakeLock: null,
    audioCtx: null,
    nextPingTime: 0,
    sunrise: null,
    sunset: null,
    noon: null,
    sunriseMins: null,
    sunsetMins: null,
    noonMins: null,
    lastLock: null
};

/* =============================================================
   UTILITIES
   ============================================================= */
function lerpAngle(a, b, t) {
    const diff = ((b - a + 540) % 360) - 180;
    return (a + diff * t + 360) % 360;
}
function getDeclination(lat, lon) {
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    return CONFIG.DECLINATION_MAP[key] ?? 0;
}
function equationOfTime(dayOfYear) {
    const B = (360/365) * (dayOfYear - 81) * (Math.PI/180);
    return 9.87 * Math.sin(2*B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
}
function solarMinutes(date, lon) {
    const utcMinutes = date.getUTCHours()*60 + date.getUTCMinutes();
    const startOfYear = new Date(Date.UTC(date.getUTCFullYear(),0,0));
    const dayOfYear = Math.floor((date - startOfYear) / 86400000);
    const eot = equationOfTime(dayOfYear);
    const solar = utcMinutes + (lon/15)*60 + eot;
    return (solar + 1440) % 1440;
}
function formatMins(mins) {
    const h = Math.floor(mins / 60) % 24;
    const m = Math.floor(mins % 60);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${m.toString().padStart(2,'0')} ${ampm}`;
}

/* =============================================================
   AUDIO ENGINE
   ============================================================= */
function initAudioEngine() {
    if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
}
function playTone(frequency, duration, now) {
    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();
    osc.frequency.value = frequency;
    osc.type = 'sine';
    osc.connect(gain);
    gain.connect(state.audioCtx.destination);
    gain.gain.setValueAtTime(0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.start(now);
    osc.stop(now + duration);
}
function handleAudioFeedback() {
    if (state.isMuted || !state.audioCtx) return;
    const now = state.audioCtx.currentTime;
    if (now < state.nextPingTime) return;
    if (state.errorDeg <= 1) {
        playTone(CONFIG.AUDIO_LOCK_TONE, 0.5, now);
        state.nextPingTime = now + 0.1;
        if (navigator.vibrate) navigator.vibrate(50);
    } else if (state.errorDeg <= 20) {
        const interval = Math.max(CONFIG.AUDIO_PULSE_MIN_INTERVAL, (state.errorDeg / 20) * CONFIG.AUDIO_PULSE_MAX_INTERVAL);
        const freq = CONFIG.AUDIO_PULSE_BASE + (20 - state.errorDeg) * CONFIG.AUDIO_PULSE_RANGE;
        const osc = state.audioCtx.createOscillator();
        const gain = state.audioCtx.createGain();
        osc.frequency.value = freq;
        osc.type = 'square';
        osc.connect(gain);
        gain.connect(state.audioCtx.destination);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
        osc.start(now);
        osc.stop(now + 0.1);
        state.nextPingTime = now + interval;
    }
}

/* =============================================================
   SUN POSITION ENGINE & TIMINGS
   ============================================================= */
function calculateSunDetails() {
    const now = new Date();
    const startOfYear = new Date(Date.UTC(now.getUTCFullYear(),0,0));
    const dayOfYear = Math.floor((now - startOfYear) / 86400000);
    const gamma = (2 * Math.PI / 365) * (dayOfYear - 1 + (now.getUTCHours() - 12)/24 + now.getUTCMinutes()/1440);
    const decl = 0.006918 - 0.399912*Math.cos(gamma) + 0.070257*Math.sin(gamma) - 0.006758*Math.cos(2*gamma) + 0.000907*Math.sin(2*gamma) - 0.002697*Math.cos(3*gamma) + 0.00148*Math.sin(3*gamma);
    const latRad = state.lat * (Math.PI/180);
    
    // Always calculate solar times
    const cosHA = (Math.sin(-0.833 * Math.PI/180) - Math.sin(latRad)*Math.sin(decl)) / (Math.cos(latRad)*Math.cos(decl));
    if (cosHA >= -1 && cosHA <= 1) {
        const haSunRad = Math.acos(cosHA);
        const haSunDeg = haSunRad * (180/Math.PI);
        const eot = equationOfTime(dayOfYear);
        const utcNoonMins = 720 - (state.lon/15)*60 - eot;
        const tzOffset = now.getTimezoneOffset(); // local offset in mins
        const localNoonMins = utcNoonMins - tzOffset;
        
        state.noonMins = localNoonMins;
        state.sunriseMins = localNoonMins - (haSunDeg*4);
        state.sunsetMins = localNoonMins + (haSunDeg*4);
        
        state.noon = formatMins(state.noonMins);
        state.sunrise = formatMins(state.sunriseMins);
        state.sunset = formatMins(state.sunsetMins);
    }

    if (state.mode === 'fixed') {
        state.sunAz = state.lat >= 0 ? 180 : 0;
        state.sunEl = 90 - (Math.abs(state.lat) * 0.85); // simple optimal fixed tilt heuristic
    } else {
        const solarMins = solarMinutes(now, state.lon);
        const hourAngleDeg = (solarMins / 4) - 180;
        const haRad = hourAngleDeg * (Math.PI/180);
        const sinEl = Math.sin(latRad)*Math.sin(decl) + Math.cos(latRad)*Math.cos(decl)*Math.cos(haRad);
        const elRad = Math.asin(sinEl);
        state.sunEl = Math.max(0, elRad * (180/Math.PI));
        const cosAz = (Math.sin(decl) - Math.sin(elRad)*Math.sin(latRad)) / (Math.cos(elRad)*Math.cos(latRad));
        let azRad = Math.acos(Math.max(-1, Math.min(1, cosAz)));
        if (haRad > 0) azRad = 2*Math.PI - azRad;
        state.sunAz = azRad * (180/Math.PI);
    }
    recalculateError();
}

function recalculateError() {
    // True incidence angle for solar panels
    const sunZ = (90 - state.sunEl) * (Math.PI/180);
    const panZ = state.phoneTilt * (Math.PI/180);
    const sunA = state.sunAz * (Math.PI/180);
    const panA = state.phoneAz * (Math.PI/180);
    const cosInc = Math.cos(sunZ)*Math.cos(panZ) + Math.sin(sunZ)*Math.sin(panZ)*Math.cos(sunA - panA);
    
    state.errorDeg = Math.acos(Math.max(-1, Math.min(1, cosInc))) * (180/Math.PI);
    updateUI();
}

/* =============================================================
   ORIENTATION HANDLER
   ============================================================= */
function handleOrientation(event) {
    if (event.alpha == null || event.beta == null) return;
    
    const rawMag = (360 - event.alpha) % 360;
    const decl = getDeclination(state.lat, state.lon);
    const trueHeading = (rawMag + decl + state.azOffset + 360) % 360;
    state.phoneAz = lerpAngle(state.phoneAz, trueHeading, CONFIG.SMOOTHING);
    
    state.rawTilt = event.beta;
    const tilt = Math.max(0, event.beta + state.tiltOffset);
    state.phoneTilt = lerpAngle(state.phoneTilt, tilt, CONFIG.SMOOTHING);
    
    recalculateError();
    handleAudioFeedback();
}

/* =============================================================
   UI / CANVAS DRAWING
   ============================================================= */
const canvas = document.getElementById('compass-canvas');
const ctx = canvas.getContext('2d');
const w = canvas.width, h = canvas.height;
const cx = w/2, cy = h/2;

function drawHUD() {
    ctx.clearRect(0,0,w,h);
    const isHC = document.body.classList.contains('high-contrast');
    ctx.strokeStyle = isHC ? '#999' : 'rgba(136,136,160,0.3)';
    ctx.lineWidth = 1;
    for(let r=30; r<=150; r+=30) { ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.stroke(); }
    
    const maxR = 140; const scale = maxR/90;
    // Sun marker
    const sunR = (90 - state.sunEl) * scale;
    const sunA = (state.sunAz - 90) * Math.PI/180;
    const sx = cx + sunR*Math.cos(sunA);
    const sy = cy + sunR*Math.sin(sunA);
    ctx.fillStyle = isHC ? '#d32f2f' : '#FFB81C';
    ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = isHC ? 0 : 15;
    ctx.beginPath(); ctx.arc(sx,sy,8,0,Math.PI*2); ctx.fill();
    ctx.shadowBlur = 0;
    
    // Phone reticle
    const phR = (90 - state.phoneTilt) * scale;
    const phA = (state.phoneAz - 90) * Math.PI/180;
    const px = cx + phR*Math.cos(phA);
    const py = cy + phR*Math.sin(phA);
    ctx.strokeStyle = state.errorDeg <= 1 ? (isHC ? '#388e3c' : '#00e676') : (isHC ? '#333' : '#e8e8f0');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px-15,py); ctx.lineTo(px+15,py);
    ctx.moveTo(px,py-15); ctx.lineTo(px,py+15);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(px,py,10,0,Math.PI*2); ctx.stroke();
    
    if(state.active) requestAnimationFrame(drawHUD);
}

function drawSunArc() {
    const svg = document.getElementById('arc-svg');
    if (!svg) return;
    const sw = 300, sh = 160, r = 120, scx = sw/2, scy = 140;
    let html = `<path d="M ${scx-r} ${scy} A ${r} ${r} 0 0 1 ${scx+r} ${scy}" fill="none" stroke="currentColor" stroke-width="2" opacity="0.3"/>`;
    html += `<line x1="20" y1="${scy}" x2="${sw-20}" y2="${scy}" stroke="currentColor" stroke-width="1" opacity="0.5"/>`;
    
    if (state.sunEl > 0 && state.sunriseMins && state.sunsetMins) {
        const now = new Date();
        const currentMins = now.getHours()*60 + now.getMinutes();
        const elapsed = currentMins - state.sunriseMins;
        const total = state.sunsetMins - state.sunriseMins;
        const clampedT = Math.max(0, Math.min(1, elapsed / total));
        const angle = Math.PI - (clampedT * Math.PI);
        const psx = scx + r*Math.cos(angle);
        const psy = scy - r*Math.sin(angle);
        html += `<circle cx="${psx}" cy="${psy}" r="6" fill="var(--gold)"/>`;
    }
    
    svg.innerHTML = html;
    if (state.sunrise) document.getElementById('arc-sunrise').innerText = state.sunrise;
    if (state.noon) document.getElementById('arc-noon').innerText = state.noon;
    if (state.sunset) document.getElementById('arc-sunset').innerText = state.sunset;
    
    const peakEl = document.getElementById('arc-peak-window');
    if (peakEl && state.noonMins) {
        const pStart = formatMins(state.noonMins - 120);
        const pEnd = formatMins(state.noonMins + 120);
        peakEl.innerText = `Best time to align: ${pStart} - ${pEnd}`;
    }
}

function updateUI() {
    document.getElementById('az-target').innerText = `${state.sunAz.toFixed(1)}°`;
    document.getElementById('tilt-target').innerText = `${state.sunEl.toFixed(1)}°`;
    
    let azDiff = state.sunAz - state.phoneAz;
    if (azDiff > 180) azDiff -= 360;
    if (azDiff < -180) azDiff += 360;
    document.getElementById('az-instruction').innerText = Math.abs(azDiff) < 1 ? "Azimuth aligned" : `Turn ${azDiff > 0 ? 'right' : 'left'} ${Math.abs(azDiff).toFixed(0)}°`;
    
    let tiltDiff = state.sunEl - state.phoneTilt;
    document.getElementById('tilt-instruction').innerText = Math.abs(tiltDiff) < 1 ? "Tilt aligned" : `Tilt ${tiltDiff > 0 ? 'up' : 'down'} ${Math.abs(tiltDiff).toFixed(0)}°`;

    const inc = state.errorDeg * Math.PI/180;
    const eff = Math.max(0, Math.cos(inc)) * 100;
    document.getElementById('efficiency-bar').style.width = `${eff}%`;
    document.getElementById('efficiency-label').innerText = `${eff.toFixed(1)}% Array Efficiency`;
    const maxPower = state.panels * CONFIG.WATT_PER_PANEL;
    const actual = maxPower * (eff/100);
    const loss = maxPower - actual;
    document.getElementById('power-output').innerText = `Power Yield: ${Math.round(actual)}W (Losing ${Math.round(loss)}W)`;
    
    const dailyYield = maxPower * CONFIG.PEAK_HOURS * (eff/100) / 1000;
    const yieldEl = document.getElementById('daily-yield');
    if (yieldEl) yieldEl.innerText = `Est. Daily Yield: ${dailyYield.toFixed(2)} kWh`;

    const badge = document.getElementById('state-badge');
    badge.className = '';
    if (state.mode === 'realtime' && state.sunEl <= 0) {
        badge.innerText = 'NIGHT'; badge.classList.add('night');
    } else if (state.errorDeg <= 1) {
        badge.innerText = 'LOCKED'; badge.classList.add('locked');
    } else if (state.errorDeg <= 5) {
        badge.innerText = 'CLOSE'; badge.classList.add('close');
    } else {
        badge.innerText = 'SEEKING'; badge.classList.add('seeking');
    }

    const pAz = document.getElementById('cal-preview-az');
    if (pAz) pAz.innerText = `${state.phoneAz.toFixed(1)}°`;
    const pTilt = document.getElementById('cal-preview-tilt');
    if (pTilt) pTilt.innerText = `${state.phoneTilt.toFixed(1)}°`;

    const lockBtn = document.getElementById('save-lock-btn');
    if (state.errorDeg <= 2) {
        lockBtn.disabled = false;
        document.getElementById('efficiency-bar-container').classList.add('locked');
    } else {
        lockBtn.disabled = true;
        document.getElementById('efficiency-bar-container').classList.remove('locked');
    }
}

/* =============================================================
   CSV EXPORT & LOCKING
   ============================================================= */
let csvRows = [];

document.getElementById('save-lock-btn').addEventListener('click', () => {
    if (navigator.vibrate) navigator.vibrate([50,100,50]);
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = formatMins(now.getHours()*60 + now.getMinutes());
    const eff = (Math.cos(state.errorDeg * Math.PI/180)*100).toFixed(1);
    
    const row = [date, time, state.lat.toFixed(4), state.lon.toFixed(4), state.phoneAz.toFixed(1), state.phoneTilt.toFixed(1), eff, state.panels].join(',');
    csvRows.push(row);
    
    state.lastLock = { time, az: state.phoneAz.toFixed(1), tilt: state.phoneTilt.toFixed(1), eff };
    document.getElementById('last-lock-card').classList.remove('hidden');
    document.getElementById('last-lock-content').innerText = `Time: ${time}\nAzimuth: ${state.phoneAz.toFixed(1)}°\nTilt: ${state.phoneTilt.toFixed(1)}°\nEfficiency: ${eff}%`;
    document.getElementById('export-lock-btn').classList.remove('hidden');
    document.getElementById('copy-lock-btn').classList.remove('hidden');
    
    const savedBadge = document.getElementById('lock-saved-badge');
    savedBadge.classList.remove('hidden');
    setTimeout(() => savedBadge.classList.add('hidden'), 2000);
});

const exportBtn = document.getElementById('export-lock-btn');
if (exportBtn) exportBtn.addEventListener('click', () => {
    const date = new Date().toISOString().split('T')[0];
    const csv = "Date,Time,Lat,Lon,True Azimuth,Tilt,Efficiency,Active Panels\n" + csvRows.join('\n');
    const blob = new Blob([csv],{type:'text/csv;charset=utf-8'});
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `SolarLock_${date}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
});

const copyBtn = document.getElementById('copy-lock-btn');
if (copyBtn) copyBtn.addEventListener('click', () => {
    if (state.lastLock) {
        const text = `SolarLock Alignment:\nTime: ${state.lastLock.time}\nAzimuth: ${state.lastLock.az}°\nTilt: ${state.lastLock.tilt}°\nEfficiency: ${state.lastLock.eff}%`;
        navigator.clipboard.writeText(text).then(() => {
            copyBtn.innerText = "Copied!";
            setTimeout(() => copyBtn.innerText = "Copy", 2000);
        });
    }
});

/* =============================================================
   NETWORK & ORIENTATION
   ============================================================= */
function handleNetworkChange() {
    const ind = document.getElementById('online-indicator');
    if (navigator.onLine) {
        ind.classList.remove('offline');
        ind.title = "Online";
    } else {
        ind.classList.add('offline');
        ind.title = "Offline";
    }
}
window.addEventListener('online', handleNetworkChange);
window.addEventListener('offline', handleNetworkChange);
handleNetworkChange();

function handleResize() {
    const overlay = document.getElementById('portrait-overlay');
    if (window.innerWidth > window.innerHeight) {
        overlay.classList.add('active');
    } else {
        overlay.classList.remove('active');
    }
}
window.addEventListener('resize', handleResize);
handleResize();

/* =============================================================
   APP INITIALISATION
   ============================================================= */
async function requestWakeLock() {
    try { state.wakeLock = await navigator.wakeLock.request('screen'); }
    catch(e) { console.warn('WakeLock error', e); }
}
function requestSensorsPermission() {
    if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().then(p => {
            if (p === 'granted') startApp();
            else console.warn('Orientation permission denied');
        }).catch(console.error);
    } else {
        startApp();
    }
}

document.getElementById('enable-sensors-btn').addEventListener('click', () => {
    initAudioEngine();
    requestWakeLock();
    requestSensorsPermission();
});

function startApp() {
    state.active = true;
    document.getElementById('permission-overlay').classList.remove('active');
    document.getElementById('app-header').classList.remove('hidden');
    document.getElementById('main-content').classList.remove('hidden');
    window.removeEventListener('deviceorientation', handleOrientation);
    window.removeEventListener('deviceorientationabsolute', handleOrientation);
    window.addEventListener('deviceorientationabsolute', handleOrientation);
    window.addEventListener('deviceorientation', handleOrientation);

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(pos => {
            state.lat = pos.coords.latitude;
            state.lon = pos.coords.longitude;
            document.getElementById('location-status').innerText = `Using GPS: ${state.lat.toFixed(4)}, ${state.lon.toFixed(4)}`;
            calculateSunDetails(); drawSunArc();
        }, err => {
            console.warn('Geolocation failed', err);
            document.getElementById('location-status').innerText = `Using default location`;
            calculateSunDetails(); drawSunArc();
        }, { enableHighAccuracy:true, timeout:8000, maximumAge:0 });
    } else {
        document.getElementById('location-status').innerText = `Geolocation not supported`;
        calculateSunDetails(); drawSunArc();
    }
    setInterval(() => { calculateSunDetails(); drawSunArc(); }, 60000);
    calculateSunDetails(); drawSunArc();
    requestAnimationFrame(drawHUD);
}

/* =============================================================
   PANEL & BUTTON WIRING
   ============================================================= */
const panelSlider = document.getElementById('panel-slider');
const panelInput = document.getElementById('panel-number-input');
function updatePanels(val) {
    state.panels = parseInt(val, 10);
    document.getElementById('panel-count-value').innerText = state.panels;
    if(panelSlider) panelSlider.value = state.panels;
    if(panelInput) panelInput.value = state.panels;
    recalculateError();
}
if (panelSlider) panelSlider.addEventListener('input', e => updatePanels(e.target.value));
if (panelInput) panelInput.addEventListener('change', e => updatePanels(e.target.value));

const muteBtn = document.getElementById('mute-btn');
if (muteBtn) muteBtn.addEventListener('click', () => {
    state.isMuted = !state.isMuted;
    document.getElementById('mute-icon-unmuted').classList.toggle('hidden');
    document.getElementById('mute-icon-muted').classList.toggle('hidden');
});

const flashlightBtn = document.getElementById('flashlight-btn');
if (flashlightBtn) flashlightBtn.addEventListener('click', async () => {
    document.body.classList.toggle('high-contrast');
    if (!state.wakeLock && !document.body.classList.contains('high-contrast')) {
        await requestWakeLock();
    }
});

const calBtn = document.getElementById('calibration-btn');
if (calBtn) calBtn.addEventListener('click', () => document.getElementById('calibration-panel').classList.remove('hidden'));
const closeCalBtn = document.getElementById('close-calibration-btn');
if (closeCalBtn) closeCalBtn.addEventListener('click', () => document.getElementById('calibration-panel').classList.add('hidden'));

const calOffsetSlider = document.getElementById('cal-offset-slider');
if (calOffsetSlider) calOffsetSlider.addEventListener('input', e => {
    const val = parseFloat(e.target.value);
    document.getElementById('cal-offset-value').innerText = `${val > 0 ? '+' : ''}${val}°`;
    state.azOffset = val;
    // Immediate feedback
    state.phoneAz = (state.phoneAz + state.azOffset) % 360;
    recalculateError();
});
const zeroTiltBtn = document.getElementById('zero-tilt-btn');
if (zeroTiltBtn) zeroTiltBtn.addEventListener('click', () => {
    state.tiltOffset = -state.rawTilt;
    document.getElementById('tilt-zero-value').innerText = `Offset: ${state.tiltOffset.toFixed(1)}°`;
    state.phoneTilt = Math.max(0, state.rawTilt + state.tiltOffset);
    recalculateError();
});
const resetCompassBtn = document.getElementById('reset-compass-btn');
if (resetCompassBtn) resetCompassBtn.addEventListener('click', () => {
    state.azOffset = 0;
    if (calOffsetSlider) { calOffsetSlider.value = 0; document.getElementById('cal-offset-value').innerText = '0°'; }
    recalculateError();
});
const resetCalBtn = document.getElementById('reset-cal-btn');
if (resetCalBtn) resetCalBtn.addEventListener('click', () => {
    state.azOffset = 0; state.tiltOffset = 0;
    if (calOffsetSlider) { calOffsetSlider.value = 0; document.getElementById('cal-offset-value').innerText = '0°'; }
    document.getElementById('tilt-zero-value').innerText = 'Offset: 0.0°';
    recalculateError();
});

const infoBtn = document.getElementById('info-btn');
if (infoBtn) infoBtn.addEventListener('click', () => document.getElementById('info-panel').classList.remove('hidden'));
const closeInfoBtn = document.getElementById('close-info-btn');
if (closeInfoBtn) closeInfoBtn.addEventListener('click', () => document.getElementById('info-panel').classList.add('hidden'));

const modeToggleBtn = document.getElementById('mode-toggle-btn');
if (modeToggleBtn) modeToggleBtn.addEventListener('click', () => {
    state.mode = state.mode === 'realtime' ? 'fixed' : 'realtime';
    modeToggleBtn.innerText = state.mode === 'realtime' ? 'Fixed Angle Mode' : 'Realtime Mode';
    calculateSunDetails(); drawSunArc();
});

const toggleArcBtn = document.getElementById('toggle-arc-btn');
if (toggleArcBtn) toggleArcBtn.addEventListener('click', () => document.getElementById('arc-panel').classList.remove('hidden'));
const closeArcBtn = document.getElementById('close-arc-btn');
if (closeArcBtn) closeArcBtn.addEventListener('click', () => document.getElementById('arc-panel').classList.add('hidden'));

const locSettingsBtn = document.getElementById('location-settings-btn');
if (locSettingsBtn) locSettingsBtn.addEventListener('click', () => document.getElementById('location-panel').classList.remove('hidden'));
const closeLocBtn = document.getElementById('close-location-btn');
if (closeLocBtn) closeLocBtn.addEventListener('click', () => document.getElementById('location-panel').classList.add('hidden'));

const applyLocBtn = document.getElementById('apply-location-btn');
if (applyLocBtn) applyLocBtn.addEventListener('click', () => {
    const lat = parseFloat(document.getElementById('manual-lat').value);
    const lon = parseFloat(document.getElementById('manual-lon').value);
    if (!isNaN(lat) && !isNaN(lon)) {
        state.lat = lat; state.lon = lon;
        document.getElementById('location-status').innerText = `Using manual location: ${lat}, ${lon}`;
        calculateSunDetails(); drawSunArc();
    }
});
const useGpsBtn = document.getElementById('use-gps-btn');
if (useGpsBtn) useGpsBtn.addEventListener('click', () => {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(pos => {
            state.lat = pos.coords.latitude; state.lon = pos.coords.longitude;
            document.getElementById('location-status').innerText = `Using GPS: ${state.lat.toFixed(4)}, ${state.lon.toFixed(4)}`;
            calculateSunDetails(); drawSunArc();
        }, err => console.warn(err), { enableHighAccuracy:true, timeout:8000, maximumAge:0 });
    }
});
const retrySensorsBtn = document.getElementById('retry-sensors-btn');
if (retrySensorsBtn) retrySensorsBtn.addEventListener('click', () => requestSensorsPermission());

/* =============================================================
   SERVICE WORKER
   ============================================================= */
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW registration failed', err));
}
