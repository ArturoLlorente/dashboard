# Phone Server Dashboard

A self-hosted web dashboard for monitoring and controlling a Linux phone (or any Linux device) running PostmarketOS, Mobian, or similar. Built with Flask, vanilla JS, and a dark glassmorphism UI — designed to be customized to your own device and needs.

<p align="center">
  <img src="https://img.shields.io/badge/python-3.11+-blue?logo=python" />
  <img src="https://img.shields.io/badge/flask-3.x-green?logo=flask" />
  <img src="https://img.shields.io/badge/license-MIT-orange" />
</p>

---

## Preview

```html
<!-- The dashboard renders cards like these in a responsive grid -->
<div class="card">
  <h2><span>Notification LED</span><span class="pill ok">ON</span></h2>
  <div class="led-mode-row">
    <button class="btn led-mode-btn">Off</button>
    <button class="btn led-mode-btn active">Solid</button>
    <button class="btn led-mode-btn">Blink</button>
    <button class="btn led-mode-btn">♥</button>
    <button class="btn led-mode-btn">Breathe</button>
  </div>
  <div class="led-slider-row">
    <label>Brightness</label>
    <input type="range" min="1" max="100" value="80">
    <span>80%</span>
  </div>
</div>

<div class="card">
  <h2><span>Brightness</span><span class="pill ok">CONTROL</span></h2>
  <div class="kpi"><div class="value">72</div><div class="unit">%</div></div>
  <input type="range" min="0" max="100" value="72">
  <div class="btnrow">
    <button class="btn">Min</button>
    <button class="btn">50%</button>
    <button class="btn">Max</button>
  </div>
</div>

<div class="card">
  <h2><span>Torch</span><span class="pill">OFF</span></h2>
  <div class="led-mode-row">
    <button class="btn led-mode-btn active">Off</button>
    <button class="btn led-mode-btn">White</button>
    <button class="btn led-mode-btn">Yellow</button>
    <button class="btn led-mode-btn">Both</button>
  </div>
  <div class="led-slider-row">
    <label>Brightness</label>
    <input type="range" min="1" max="100" value="50">
    <span>50%</span>
  </div>
</div>
```

---

## Features

### 📊 System Metrics

Real-time monitoring with Chart.js graphs that update every 5 seconds:

| Metric | Details |
|--------|---------|
| **CPU** | Per-second usage percentage with historical line chart |
| **Memory** | Used / total RAM with percentage graph |
| **Temperature** | CPU thermal zone readings in °C |
| **Battery** | Capacity %, charge/discharge status, historical graph (last 24h at 10-min intervals), and estimated time remaining based on recent drain/charge rate |
| **Disk** | Usage percentage of the root filesystem |
| **Network** | RX/TX rates (KB/s) per interface, with cumulative graphs |

All metrics are collected by a background thread and stored in memory for instant access by the frontend.

### 💡 LED Controls

Full hardware control of the device's LEDs via sysfs, exposed through the Controls & Services panel:

**Notification LED** (`white:status`):
- **Solid** — constant on at configurable brightness (0–100%)
- **Blink** — on/off cycle with configurable delay (100–2000ms)
- **Heartbeat** — kernel heartbeat trigger (mimics a heartbeat pulse)
- **Breathe** — smooth sine-like breathing pattern at slow/normal/fast speed

**Torch / Flash LEDs** (`white:flash`, `yellow:flash`):
- Toggle white, yellow, or both simultaneously
- Adjustable brightness (0–100%)
- Instant off kills both LEDs regardless of which color was active

> **Note**: Requires write access to `/sys/class/leds/`. Install the included udev rule (`utils/90-leds.rules`) or `chmod a+w` the relevant sysfs nodes.

### 🔆 Brightness Control

Screen backlight slider (0–100%) with debounced writes to `/sys/class/backlight/`. Includes quick-set buttons for Min / 50% / Max.

### 📺 IPTV Status

Monitors an Xtream Codes–compatible IPTV subscription:
- Username, active/max connections, account status, expiration date
- Automatic retry with multiple User-Agent strings and HTTP/HTTPS fallback
- Caches last successful response for resilience

### ✅ To-Do List

A lightweight task manager built into the dashboard:
- Create, edit, and delete tasks with title, description, notes, and due date
- Drag-and-drop reordering
- Complete/archive tasks and reopen them later
- Persisted to `todos.json`

### 📁 File Storage

Upload and manage files directly on the device:
- Folder creation, file upload (multi-file, max 10 MB each), deletion
- Image preview for common formats (jpg, png, gif, webp, svg)
- Breadcrumb navigation with path-traversal protection
- Drag-and-drop upload zone

### 🔒 Admin Access

Sensitive operations (LED control, file upload/delete, data refresh) are protected behind an admin login:
- Password-based authentication with session tokens (24h expiry)
- Rate limiting (5 attempts per 5-minute window per IP)
- Admin-only navigation items are hidden until authenticated

### 🌍 Internationalization (i18n)

Built-in language switcher with full English and Spanish translations. All UI labels use `data-i18n` attributes — adding a new language is a single object in `dashboard.js`.

### 🗺️ Rally Bot Integration *(optional)*

If a sibling `rally_bot/` directory exists with `station_routes.json`, the dashboard provides:
- Filterable list of campervan relocation routes (origin, destination, model, dates)
- Interactive Leaflet map view with geocoded city markers
- Auto-refresh from APIs every 30 minutes or on file change
- Admin stats panel with log viewer, notification history, and model breakdown

---

## Project Structure

```
dashboard/
├── server.py              # Flask backend (API + routes)
├── templates/
│   └── dashboard.html     # Single-page HTML template
├── static/
│   ├── css/style.css      # Dark glassmorphism theme
│   └── js/dashboard.js    # Frontend logic, charts, i18n
├── storage/               # User-uploaded files (created at runtime)
├── certs/                 # Optional TLS certs (cert.pem + key.pem)
├── battery_history.json   # Persisted battery data
├── todos.json             # Persisted to-do items
├── .env                   # Environment configuration (not committed)
└── pyproject.toml         # Python project config
```

---

## Quick Start

### 1. Clone & configure

```bash
git clone <your-repo-url>
cd dashboard

# Create your .env file
cat > .env <<EOF
ADMIN_PASSWORD=your_secure_password
IPTV_USERNAME=your_iptv_user
IPTV_PASSWORD=your_iptv_pass
IPTV_HOST=your.iptv-provider.com
EOF
```

### 2. Run (development)

```bash
uv run python server.py --port 8080
```

The server listens on `0.0.0.0` by default. If `certs/cert.pem` and `certs/key.pem` exist, it starts in HTTPS mode automatically.

### 3. Run as a systemd service (production)

Create `/etc/systemd/system/dashboard.service`:

```ini
[Unit]
Description=Phone Dashboard Server
After=network.target

[Service]
Type=simple
User=<your-user>
WorkingDirectory=/path/to/dashboard
ExecStart=/path/to/uv run python server.py --port 8080
Restart=always
RestartSec=10
Environment="PATH=/usr/local/bin:/usr/bin:/bin"

[Install]
WantedBy=multi-user.target
```

Then enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dashboard
```

### Useful commands

```bash
systemctl status dashboard        # check status & recent logs
systemctl restart dashboard       # restart after changes
journalctl -u dashboard -f        # follow live logs
```

---

## Configuration

All configuration is done through environment variables (or a `.env` file in the project root):

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_PASSWORD` | `admin` | Password to unlock admin features |
| `IPTV_USERNAME` | — | IPTV provider username |
| `IPTV_PASSWORD` | — | IPTV provider password |
| `IPTV_HOST` | — | IPTV provider hostname |

CLI arguments:

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `6969` | Port to listen on |

---

## LED Permissions

For LED control to work without root, the dashboard user needs write access to the LED sysfs nodes. Two options:

**Option A** — Install the udev rule (recommended, persists across reboots):

```bash
sudo cp utils/90-leds.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
```

**Option B** — Manual chmod (resets on reboot):

```bash
sudo chmod a+w /sys/class/leds/white:status/brightness
sudo chmod a+w /sys/class/leds/white:status/trigger
sudo chmod a+w /sys/class/leds/white:flash/brightness
sudo chmod a+w /sys/class/leds/yellow:flash/brightness
```

---

## Customization

The dashboard is designed to be extended:

- **Add a new card**: Add HTML in `dashboard.html` inside a `<div class="card">`, wire it up in `dashboard.js`
- **Add a new window/page**: Add a `<div class="window" id="window-mypage">` section, add a sidebar nav item, and register it in `switchWindow()`
- **Add a language**: Add a new key to the `TRANSLATIONS` object in `dashboard.js`
- **Change the theme**: All colors use CSS custom properties at the top of `style.css`

---

## License

MIT