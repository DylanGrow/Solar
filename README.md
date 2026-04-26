# SolarLock - Solar Panel Alignment Instrument
### Optimized Mobile Build

SolarLock is a progressive web application that helps solar panel installers and owners precisely align their panels to maximize energy output. This mobile-optimized version provides real-time alignment feedback using device sensors and astronomical calculations.

![SolarLock Interface](https://via.placeholder.com/600x400?text=SolarLock+Interface+Screenshot)

## Features

✅ **Real-time Alignment Tracking** - Uses device compass and tilt sensors
✅ **Astronomical Calculations** - Precise sun position based on location
✅ **Two Operation Modes**:
   - **Realtime Mode**: Tracks the sun's current position
   - **Fixed Mode**: Aligns to optimal fixed angle for your location
✅ **Alignment Feedback** - Visual and audio cues for optimal positioning
✅ **Offline Capable** - Works without internet connection after initial setup
✅ **Data Persistence** - Saves alignment positions for future reference
✅ **Battery Efficient** - Implements sensor throttling and wake lock management

## Technical Implementation

### Core Components

1. **Sensor Layer**
   - Handles device orientation and location permissions
   - Manages compass heading and tilt detection
   - Implements iOS-specific permission handling

2. **Sun Engine**
   - Calculates sun position using astronomical algorithms
   - Determines sunrise/sunset times for your location
   - Handles magnetic declination correction

3. **Alignment Engine**
   - Computes alignment errors (azimuth and tilt)
   - Determines alignment state (NIGHT, LOW_SUN, OFF_TARGET, etc.)
   - Calculates theoretical power output based on alignment

4. **Audio Engine**
   - Provides haptic and audio feedback
   - Generates tones when panel is optimally aligned

5. **Storage Engine**
   - Persists alignment positions locally
   - Manages debounced writes to prevent storage quota issues

### Key Algorithms

- **Sun Position Calculation**: Uses modified Julian date calculations
- **Magnetic Declination**: Approximation based on latitude/longitude
- **Alignment Efficiency**: Cosine-based efficiency calculation
- **State Machine**: Determines alignment status based on error thresholds

## Installation & Usage

### Prerequisites

- Modern smartphone (iOS or Android)
- Browser with sensor support (Chrome, Safari, Firefox recommended)
- GPS capability (for location services)

### Quick Start

1. **Access the App**:
   - Visit [https://solarlock.example.com](https://solarlock.example.com) in your mobile browser
   - Or install as a PWA (Progressive Web App) for better performance

2. **Grant Permissions**:
   - Allow location access (required for sun position calculations)
   - Allow motion sensors (required for alignment tracking)

3. **Calibrate**:
   - Hold device flat and rotate 360° to calibrate compass
   - Follow on-screen instructions for best results

4. **Align Your Panels**:
   - Point device at your solar panel
   - Adjust panel position until reaching "LOCKED" state
   - Save the alignment position for future reference

### Operation Modes

- **Realtime Mode** (Default):
  - Tracks the sun's current position
  - Ideal for dynamic adjustments during installation

- **Fixed Mode**:
  - Aligns to optimal fixed angle for your location
  - Useful for permanent installations

## Configuration

### Default Constants

```javascript
const DEFAULT\_LOCATION = { lat: 35.2271, lon: -80.8431 }; // Charlotte, NC
const SENSOR\_READ\_INTERVAL = 100; // ms
const SUN\_UPDATE\_INTERVAL = 5000; // ms
const COMPASS\_ACCURACY\_THRESHOLD = 30; // degrees
