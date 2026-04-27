// --- CONFIG & CONSTANTS ---
const CONFIG = {
    DEFAULT_LAT: 35.1085, // New Bern, NC
    DEFAULT_LON: -77.0441,
    DECLINATION: -9.4,    // Magnetic Offset for NC
    SMOOTHING: 0.15,      // Low-pass filter weight
    WATT_PER_PANEL: 400,
    PEAK_HOURS: 5
};

// --- STATE ---
let state = {
    active: false,
    lat: CONFIG.DEFAULT_LAT,
    lon: CONFIG.DEFAULT_LON,
    phoneAz: 0,
    phoneTilt: 0,
    sunAz: 0,
    sunEl: 0,
    errorDeg: 999,
    panels: 10,
    isMuted: false,
    wakeLock: null
};

// --- AUDIO SYSTEM (Geiger Pulse) ---
let audioCtx;
let nextPingTime = 0;

function initAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
}

function handleAudioFeedback() {
    if (state.isMuted || !audioCtx || state.errorDeg > 20) return;

    let now = audioCtx.currentTime;
    if (now < nextPingTime) return;

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    if (state.errorDeg <= 1) {
        // Locked Tone
        osc.frequency.value = 880; 
        osc.type = 'sine';
        osc.start(now);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
        osc.stop(now + 0.5);
        nextPingTime = now + 0.1;
        if (navigator.vibrate) navigator.vibrate(50); // Haptic sync
    } else {
        // Geiger Pulse
        const interval = Math.max(0.1, (state.errorDeg / 20) * 1.5);
        osc.frequency.value = 400 + (20 - state.errorDeg) * 20; 
        osc.type = 'square';
        osc.start(now);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
        osc.stop(now + 0.1);
        nextPingTime = now + interval;
    }
}

// --- SUN POSITION MATH ---
function updateSunPosition() {
    // Simplified Solar Position Engine
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 0);
    const diff = now - start;
    const dayOfYear = Math.floor(diff / 86400000);
    const hour = now.getHours() + now.getMinutes() / 60;

    const gamma = (2 * Math.PI / 365) * (dayOfYear - 1 + (hour - 12) / 24);
    const declRad = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma);
    
    // Rough local solar time approximation
    const timeOffset = 4 * state.lon; 
    const tSolar = (hour * 60 + timeOffset) % 1440;
    const haRad = ((tSolar / 4) - 180) * (Math.PI / 180);
    const latRad = state.lat * (Math.PI / 180);

    const sinEl = Math.sin(latRad) * Math.sin(declRad) + Math.cos(latRad) * Math.cos(declRad) * Math.cos(haRad);
    state.sunEl = Math.max(0, Math.asin(sinEl) * (180 / Math.PI)); // Don't track below horizon

    const cosAz = (Math.sin(declRad) - sinEl * Math.sin(latRad)) / (Math.cos(Math.asin(sinEl)) * Math.cos(latRad));
    let rawAz = Math.acos(Math.max(-1, Math.min(1, cosAz))) * (180 / Math.PI);
    state.sunAz = haRad > 0 ? 360 - rawAz : rawAz;
}

// --- SENSOR PROCESSING ---
function handleOrientation(event) {
    if (!event.alpha || !event.beta) return;

    // Apply Magnetic Declination Fix (True North)
    let rawHeading = 360 - event.alpha; 
    let trueHeading = (rawHeading + CONFIG.DECLINATION + 360) % 360;

    // Low-Pass Filter to remove jitter
    state.phoneAz = (state.phoneAz * (1 - CONFIG.SMOOTHING)) + (trueHeading * CONFIG.SMOOTHING);
    state.phoneTilt = (state.phoneTilt * (1 - CONFIG.SMOOTHING)) + (Math.max(0, event.beta) * CONFIG.SMOOTHING);

    // Calculate angular error
    const azDiff = Math.abs(state.sunAz - state.phoneAz);
    const azError = Math.min(azDiff, 360 - azDiff);
    const tiltError = Math.abs(state.sunEl - state.phoneTilt);
    state.errorDeg = Math.sqrt(azError * azError + tiltError * tiltError);

    updateUI();
    handleAudioFeedback();
}

// --- UI & CANVAS DRAWING ---
const canvas = document.getElementById('compass-canvas');
const ctx = canvas.getContext('2d');
const w = canvas.width;
const h = canvas.height;
const cx = w / 2;
const cy = h / 2;

function drawHUD() {
    ctx.clearRect(0, 0, w, h);

    // Radar Rings
    ctx.strokeStyle = 'rgba(136, 136, 160, 0.3)';
    ctx.lineWidth = 1;
    for(let r = 30; r <= 150; r += 30) {
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    }

    // Map Sun Position
    const maxRadius = 140;
    const tiltScale = maxRadius / 90;
    
    // Draw Target (Sun)
    const sunR = (90 - state.sunEl) * tiltScale;
    const sunRad = (state.sunAz - 90) * (Math.PI / 180);
    const sx = cx + sunR * Math.cos(sunRad);
    const sy = cy + sunR * Math.sin(sunRad);

    ctx.fillStyle = '#FFB81C';
    ctx.shadowColor = '#FFB81C';
    ctx.shadowBlur = 15;
    ctx.beginPath(); ctx.arc(sx, sy, 8, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;

    // Draw Reticle (Phone)
    const phR = (90 - state.phoneTilt) * tiltScale;
    const phRad = (state.phoneAz - 90) * (Math.PI / 180);
    const px = cx + phR * Math.cos(phRad);
    const py = cy + phR * Math.sin(phRad);

    ctx.strokeStyle = state.errorDeg <= 1 ? '#00e676' : '#e8e8f0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px - 15, py); ctx.lineTo(px + 15, py);
    ctx.moveTo(px, py - 15); ctx.lineTo(px, py + 15);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(px, py, 10, 0, Math.PI * 2); ctx.stroke();

    if (state.active) requestAnimationFrame(drawHUD);
}

function updateUI() {
    // 12-Hour formatted times
    const now = new Date();
    const timeString = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    
    document.getElementById('az-target').innerText = `${state.sunAz.toFixed(1)}°`;
    document.getElementById('tilt-target').innerText = `${state.sunEl.toFixed(1)}°`;

    // Efficiency Math (Cosine Loss)
    const incidence = state.errorDeg * (Math.PI / 180);
    const efficiency = Math.max(0, Math.cos(incidence)) * 100;
    
    document.getElementById('efficiency-bar').style.width = `${efficiency}%`;
    document.getElementById('efficiency-label').innerText = `${efficiency.toFixed(1)}% Array Efficiency`;

    const maxPower = state.panels * CONFIG.WATT_PER_PANEL;
    const actualPower = maxPower * (efficiency / 100);
    const lostPower = maxPower - actualPower;
    
    document.getElementById('power-output').innerText = `Power Yield: ${Math.round(actualPower)}W (Losing ${Math.round(lostPower)}W)`;

    // Lock Button Logic
    const lockBtn = document.getElementById('save-lock-btn');
    if (state.errorDeg <= 2) {
        lockBtn.disabled = false;
        document.getElementById('efficiency-bar-container').classList.add('locked');
    } else {
        lockBtn.disabled = true;
        document.getElementById('efficiency-bar-container').classList.remove('locked');
    }
}

// --- CSV EXPORT LOGIC ---
function formatAMPM(date) {
  let hours = date.getHours();
  let minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12; // the hour '0' should be '12'
  minutes = minutes < 10 ? '0'+minutes : minutes;
  return hours + ':' + minutes + ' ' + ampm;
}

document.getElementById('save-lock-btn').addEventListener('click', () => {
    if (navigator.vibrate) navigator.vibrate([50, 100, 50]);
    const now = new Date();
    const formattedTime = formatAMPM(now);
    const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    
    const csvContent = "Date,Time,Lat,Lon,True Azimuth,Tilt,Efficiency,Active Panels\n" +
        `${dateStr},${formattedTime},${state.lat.toFixed(4)},${state.lon.toFixed(4)},${state.phoneAz.toFixed(1)},${state.phoneTilt.toFixed(1)},${(Math.cos(state.errorDeg * Math.PI/180)*100).toFixed(1)}%,${state.panels}`;

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `SolarLock_Survey_${dateStr}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
});

// --- BOOTSTRAP & WAKE LOCK ---
async function requestWakeLock() {
    try {
        state.wakeLock = await navigator.wakeLock.request('screen');
    } catch (err) {
        console.log("Wake Lock failed:", err);
    }
}

document.getElementById('enable-sensors-btn').addEventListener('click', () => {
    initAudio();
    requestWakeLock();
    
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().then(permissionState => {
            if (permissionState === 'granted') startApp();
        }).catch(console.error);
    } else {
        startApp();
    }
});

function startApp() {
    state.active = true;
    document.getElementById('permission-overlay').classList.remove('active');
    document.getElementById('app-header').classList.remove('hidden');
    document.getElementById('main-content').classList.remove('hidden');

    window.addEventListener('deviceorientationabsolute', handleOrientation);
    // Fallback if absolute isn't supported
    window.addEventListener('deviceorientation', handleOrientation);

    setInterval(updateSunPosition, 60000); // Update sun every minute
    updateSunPosition();
    requestAnimationFrame(drawHUD);
}

// Controls
document.getElementById('panel-slider').addEventListener('input', (e) => {
    state.panels = parseInt(e.target.value);
    document.getElementById('panel-count-value').innerText = state.panels;
    document.getElementById('panel-number-input').value = state.panels;
});

// Register Service Worker
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW registration failed:', err));
}
