from flask import Flask, render_template, jsonify, request, send_from_directory
from functools import wraps
import subprocess
import os
import requests
from datetime import datetime
import psutil
import socket
from pathlib import Path
import json
import threading
import time
import secrets
import argparse
import shutil
import sys

# Allow importing data fetchers from rally_bot sibling package
_RALLY_BOT_DIR = Path(__file__).parent.parent / 'rally_bot'
if str(_RALLY_BOT_DIR) not in sys.path:
    sys.path.insert(0, str(_RALLY_BOT_DIR.parent))

app = Flask(__name__)

# ---- Rally routes auto-refresh config ----
ROUTES_FILE = Path(__file__).parent.parent / 'rally_bot' / 'station_routes.json'
# How often (seconds) to fetch fresh data from the APIs if the file hasn't been
# updated by the Telegram bot.  0 = watcher only (never self-fetch).
ROUTES_REFRESH_INTERVAL = 1800  # 30 minutes

_routes_cache: dict = {'data': None, 'mtime': 0.0}
_routes_updating = threading.Event()   # set while a fetch is in progress
_routes_lock = threading.Lock()


def _load_routes_if_changed() -> bool:
    """Reload the in-memory cache if station_routes.json was modified.
    Returns True if the cache was updated."""
    global _routes_cache
    try:
        mtime = ROUTES_FILE.stat().st_mtime
    except OSError:
        return False
    with _routes_lock:
        if mtime == _routes_cache['mtime']:
            return False
        with open(ROUTES_FILE, 'r') as f:
            data = json.load(f)
        _routes_cache = {'data': data, 'mtime': mtime}
    return True


def _fetch_routes_from_apis():
    """Run all three data fetchers synchronously and save station_routes.json.
    Safe to call from a background thread."""
    if _routes_updating.is_set():
        return  # already running
    _routes_updating.set()
    try:
        from rally_bot.data_fetcher import StationDataFetcher, ImoovaDataFetcher, IndieCampersDataFetcher
        import logging
        logger = logging.getLogger('dashboard.routes_refresh')
        logger.info('Routes refresh: starting API fetch...')

        imoova = ImoovaDataFetcher(logger)
        indie  = IndieCampersDataFetcher(logger)
        rs     = StationDataFetcher(logger)

        merged = list(imoova.sync_full_update() or [])
        imoova.output_data = merged
        imoova.save_output_to_json(ROUTES_FILE)

        merged += indie.sync_full_update() or []
        indie.output_data = merged
        indie.save_output_to_json(ROUTES_FILE)

        rs_data = rs.sync_full_update() or []
        merged += rs_data
        rs.output_data = merged
        rs.save_output_to_json(ROUTES_FILE)

        _load_routes_if_changed()
        logger.info(f'Routes refresh: done — {len(merged)} entries')
    except Exception as e:
        import logging
        logging.getLogger('dashboard.routes_refresh').error(f'Routes refresh failed: {e}', exc_info=True)
    finally:
        _routes_updating.clear()


def _routes_watcher():
    """Background daemon thread:
    - Reloads the cache whenever station_routes.json changes on disk.
    - If ROUTES_REFRESH_INTERVAL > 0 and the file hasn't been updated
      within that interval, kicks off a fresh API fetch.
    """
    _load_routes_if_changed()  # warm up cache at startup
    while True:
        time.sleep(30)
        changed = _load_routes_if_changed()
        if changed:
            import logging
            logging.getLogger('dashboard.routes_refresh').info(
                'station_routes.json changed on disk — cache reloaded')
        if ROUTES_REFRESH_INTERVAL > 0 and not _routes_updating.is_set():
            try:
                age = time.time() - ROUTES_FILE.stat().st_mtime
                if age > ROUTES_REFRESH_INTERVAL:
                    threading.Thread(target=_fetch_routes_from_apis, daemon=True).start()
            except OSError:
                pass

# ---- Battery history configuration ----
BATTERY_HISTORY_FILE = Path(__file__).parent / 'battery_history.json'

# Todo storage
TODO_FILE = Path(__file__).parent / 'todos.json'
todos_data = []
MAX_HISTORY_ENTRIES = 144  # Keep last 24 hours (144 entries at 10-minute intervals)
BATTERY_UPDATE_INTERVAL = 600  # Record battery every 10 minutes (600 seconds)
battery_history = []  # Will be loaded from file on startup
last_battery_record_time = 0  # Track last time battery was recorded

# Real-time metrics history (in-memory, last 60 points)
MAX_REALTIME_POINTS = 60
metrics_history = {
    'timestamps': [],
    'cpu': [],
    'memory': [],
    'temperature': [],
    'network_rx': [],
    'network_tx': []
}
prev_net_bytes = None  # For calculating network rates

# Load environment variables from .env file
def load_env():
    env_path = Path(__file__).parent / '.env'
    if env_path.exists():
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    os.environ[key] = value

load_env()

# Configuration
IPTV_USERNAME = os.environ.get('IPTV_USERNAME', 'your_username')
IPTV_PASSWORD = os.environ.get('IPTV_PASSWORD', 'your_password')
IPTV_HOST = os.environ.get('IPTV_HOST', 'your_host.com')
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'admin')

# In-memory admin sessions: token -> {created_at}
admin_sessions = {}

# Rate limiting for login attempts
_login_attempts = {}  # ip -> [timestamps]
MAX_LOGIN_ATTEMPTS = 5  # per window
LOGIN_WINDOW_SECONDS = 300  # 5 minutes

# Max upload size (10 MB)
MAX_UPLOAD_SIZE = 10 * 1024 * 1024


def _is_rate_limited(ip: str) -> bool:
    """Check if an IP has exceeded login attempt limits."""
    now = time.time()
    attempts = _login_attempts.get(ip, [])
    # Prune old attempts
    attempts = [t for t in attempts if now - t < LOGIN_WINDOW_SECONDS]
    _login_attempts[ip] = attempts
    return len(attempts) >= MAX_LOGIN_ATTEMPTS


def _record_login_attempt(ip: str):
    """Record a login attempt for rate limiting."""
    _login_attempts.setdefault(ip, []).append(time.time())


def require_admin(f):
    """Decorator to require a valid admin session token for an endpoint."""
    @wraps(f)
    def decorated(*args, **kwargs):
        token = (request.headers.get('X-Admin-Token') or
                 request.args.get('admin_token') or
                 (request.get_json(silent=True) or {}).get('admin_token', ''))
        session = admin_sessions.get(token)
        if not session:
            return jsonify({'success': False, 'error': 'Unauthorized'}), 401
        if time.time() - session['created_at'] > 86400:
            admin_sessions.pop(token, None)
            return jsonify({'success': False, 'error': 'Session expired'}), 401
        return f(*args, **kwargs)
    return decorated


def run_command(command):
    """Execute shell command and return output"""
    try:
        result = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=5)
        return result.stdout.strip()
    except Exception as e:
        return f"Error: {str(e)}"


def load_todos():
    """Load todos from file"""
    global todos_data
    try:
        if TODO_FILE.exists():
            with open(TODO_FILE, 'r') as f:
                todos_data = json.load(f)
                print(f"Loaded {len(todos_data)} todos")
        else:
            todos_data = []
    except Exception as e:
        print(f"Error loading todos: {e}")
        todos_data = []


def save_todos():
    """Save todos to file"""
    try:
        with open(TODO_FILE, 'w') as f:
            json.dump(todos_data, f, indent=2)
    except Exception as e:
        print(f"Error saving todos: {e}")


def load_battery_history():
    """Load battery history from file"""
    global battery_history
    try:
        if BATTERY_HISTORY_FILE.exists():
            with open(BATTERY_HISTORY_FILE, 'r') as f:
                battery_history = json.load(f)
                print(f"Loaded {len(battery_history)} battery history entries")
        else:
            battery_history = []
    except Exception as e:
        print(f"Error loading battery history: {e}")
        battery_history = []

def save_battery_history():
    """Save battery history to file"""
    try:
        with open(BATTERY_HISTORY_FILE, 'w') as f:
            json.dump(battery_history, f)
    except Exception as e:
        print(f"Error saving battery history: {e}")

def add_battery_entry(capacity, status, force=False):
    """Add a battery entry to history"""
    global battery_history, last_battery_record_time
    
    # Only record every BATTERY_UPDATE_INTERVAL seconds unless forced
    current_time = time.time()
    if not force and (current_time - last_battery_record_time) < BATTERY_UPDATE_INTERVAL:
        return
    
    last_battery_record_time = current_time
    entry = {
        'timestamp': datetime.now().isoformat(),
        'capacity': capacity,
        'status': status
    }
    battery_history.append(entry)
    
    # Keep only last MAX_HISTORY_ENTRIES
    if len(battery_history) > MAX_HISTORY_ENTRIES:
        battery_history = battery_history[-MAX_HISTORY_ENTRIES:]
    
    # Save to file (in background to avoid blocking)
    threading.Thread(target=save_battery_history, daemon=True).start()

def get_battery_info():
    """Get battery status"""
    try:
        capacity = run_command('cat /sys/class/power_supply/qcom-battery/capacity')
        status = run_command('cat /sys/class/power_supply/qcom-battery/status')
        
        # Add to history if valid
        if capacity != 'N/A' and capacity.isdigit():
            add_battery_entry(int(capacity), status)
        
        return {
            'capacity': capacity,
            'status': status
        }
    except:
        return {'capacity': 'N/A', 'status': 'N/A'}

def get_brightness():
    """Get current brightness level"""
    try:
        brightness = run_command('cat /sys/class/backlight/*/brightness')
        max_brightness = run_command('cat /sys/class/backlight/*/max_brightness')
        return {
            'current': brightness,
            'max': max_brightness,
            'percentage': round((int(brightness) / int(max_brightness)) * 100, 1) if max_brightness != '0' else 0
        }
    except:
        return {'current': 'N/A', 'max': 'N/A', 'percentage': 0}

BACKLIGHT_DIR = Path('/sys/class/backlight/backlight')

def set_brightness(value):
    """Set brightness level (0-100) by writing directly to sysfs."""
    try:
        max_brightness = int((BACKLIGHT_DIR / 'max_brightness').read_text().strip())
        actual_value = int((value / 100) * max_brightness)
        (BACKLIGHT_DIR / 'brightness').write_text(str(actual_value))
        return {'success': True, 'value': value}
    except PermissionError:
        return {'success': False, 'error': 'No write permission on backlight. Run: sudo chmod a+w /sys/class/backlight/backlight/brightness'}
    except Exception as e:
        return {'success': False, 'error': str(e)}

def get_system_info():
    """Get system information"""
    try:
        return {
            'hostname': socket.gethostname(),
            'uptime': run_command('uptime -p'),
            'kernel': run_command('uname -r'),
            'os': run_command('cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2').strip('"'),
            'cpu_usage': psutil.cpu_percent(interval=1),
            'memory': {
                'total': round(psutil.virtual_memory().total / (1024**3), 2),
                'used': round(psutil.virtual_memory().used / (1024**3), 2),
                'percent': psutil.virtual_memory().percent
            },
            'disk': {
                'total': round(psutil.disk_usage('/').total / (1024**3), 2),
                'used': round(psutil.disk_usage('/').used / (1024**3), 2),
                'percent': psutil.disk_usage('/').percent
            },
            'temperature': get_temperature()
        }
    except Exception as e:
        return {'error': str(e)}

def get_temperature():
    """Get CPU temperature"""
    try:
        temp = run_command('cat /sys/class/thermal/thermal_zone*/temp | head -1')
        return round(int(temp) / 1000, 1) if temp.isdigit() else 'N/A'
    except:
        return 'N/A'

def get_network_info():
    """Get network information"""
    try:
        ip_addr = run_command("ip addr show | grep 'inet ' | grep -v '127.0.0.1' | awk '{print $2}' | cut -d/ -f1")
        interfaces = {}
        net_io = psutil.net_io_counters(pernic=True)
        
        for interface, stats in net_io.items():
            interfaces[interface] = {
                'bytes_sent': stats.bytes_sent,
                'bytes_recv': stats.bytes_recv
            }
        
        return {
            'ip_address': ip_addr,
            'interfaces': interfaces
        }
    except Exception as e:
        return {'error': str(e)}

_iptv_cache: dict = {}   # last successful response

def get_iptv_status():
    global _iptv_cache
    # Candidate User-Agents used by real Xtream-Codes–compatible players
    _UA_LIST = [
        "okhttp/4.9.0",
        "Dalvik/2.1.0 (Linux; U; Android 11; SDK_GPHONE_X86 Build/RSR1.201013.001)",
        "TiviMate/4.7.0",
        "GSE-IPTV",
        "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 4 rev: 1812 Safari/533.3",
    ]
    path = f"/player_api.php?username={IPTV_USERNAME}&password={IPTV_PASSWORD}"
    for scheme in ("http", "https"):
        for ua in _UA_LIST:
            try:
                url = f"{scheme}://{IPTV_HOST}{path}"
                headers = {
                    "User-Agent": ua,
                    "Accept": "application/json, text/plain, */*",
                }
                r = requests.get(url, headers=headers, timeout=8)
                if r.status_code == 403:
                    continue
                r.raise_for_status()
                data = r.json()
                user_info = data.get("user_info", {}) or {}

                exp_date = user_info.get("exp_date", "N/A")
                if exp_date and str(exp_date).isdigit():
                    exp_date = datetime.fromtimestamp(int(exp_date)).strftime("%Y-%m-%d %H:%M:%S")

                result = {
                    "success": True,
                    "username": user_info.get("username", "N/A"),
                    "active_cons": user_info.get("active_cons", "N/A"),
                    "max_connections": user_info.get("max_connections", "N/A"),
                    "status": user_info.get("status", "N/A"),
                    "exp_date": exp_date,
                }
                _iptv_cache = result
                return result
            except Exception:
                continue

    # All attempts failed — return cached data if available, else error
    if _iptv_cache:
        return dict(_iptv_cache, cached=True)
    return {"success": False, "error": "Provider blocked all requests (403). No cached data available."}

def estimate_battery_life():
    """Estimate remaining battery life (or time to full charge) from recent history."""
    if len(battery_history) < 2:
        return None

    # Use up to the last 6 entries (~60 minutes of data)
    window = battery_history[-6:]
    current = window[-1]
    current_status = current['status'].lower()

    # Only use entries that share the current charge/discharge status
    consistent = [e for e in window if e['status'].lower() == current_status]
    if len(consistent) < 2:
        return None

    first = consistent[0]
    last = consistent[-1]

    try:
        t1 = datetime.fromisoformat(first['timestamp'])
        t2 = datetime.fromisoformat(last['timestamp'])
        time_diff_minutes = (t2 - t1).total_seconds() / 60
        if time_diff_minutes < 1:
            return None

        # capacity_diff > 0  => discharging (capacity dropped)
        # capacity_diff < 0  => charging  (capacity rose)
        capacity_diff = first['capacity'] - last['capacity']
        rate_per_minute = capacity_diff / time_diff_minutes  # % per minute

        current_capacity = current['capacity']

        if current_status == 'discharging' and rate_per_minute > 0:
            minutes_remaining = current_capacity / rate_per_minute
            hours = int(minutes_remaining // 60)
            mins = int(minutes_remaining % 60)
            return {
                'status': 'discharging',
                'rate_per_hour': round(rate_per_minute * 60, 1),
                'estimate': f"{hours}h {mins}m" if hours > 0 else f"{mins}m",
                'minutes': round(minutes_remaining)
            }
        elif current_status == 'charging' and rate_per_minute < 0:
            charge_rate = -rate_per_minute  # positive %/min
            if charge_rate > 0:
                minutes_to_full = (100 - current_capacity) / charge_rate
                hours = int(minutes_to_full // 60)
                mins = int(minutes_to_full % 60)
                return {
                    'status': 'charging',
                    'rate_per_hour': round(charge_rate * 60, 1),
                    'estimate': f"{hours}h {mins}m" if hours > 0 else f"{mins}m",
                    'minutes': round(minutes_to_full)
                }
        elif rate_per_minute == 0:
            return {'status': current_status, 'rate_per_hour': 0, 'estimate': 'Stable', 'minutes': None}

    except Exception:
        pass

    return None


def add_metrics_history(system_info, network_info):
    """Add current metrics to history"""
    global metrics_history, prev_net_bytes
    
    # Add timestamp
    metrics_history['timestamps'].append(datetime.now().isoformat())
    
    # Add CPU, memory, temperature
    metrics_history['cpu'].append(system_info.get('cpu_usage', 0))
    metrics_history['memory'].append(system_info.get('memory', {}).get('percent', 0))
    temp = system_info.get('temperature', 'N/A')
    metrics_history['temperature'].append(temp if isinstance(temp, (int, float)) else 0)
    
    # Calculate network rates (KB/s)
    total_rx = 0
    total_tx = 0
    for iface_stats in network_info.get('interfaces', {}).values():
        total_rx += iface_stats.get('bytes_recv', 0)
        total_tx += iface_stats.get('bytes_sent', 0)
    
    rx_kbs = 0
    tx_kbs = 0
    if prev_net_bytes:
        time_diff = 5  # Assume 5 second intervals
        rx_kbs = max(0, (total_rx - prev_net_bytes['rx']) / time_diff / 1024)
        tx_kbs = max(0, (total_tx - prev_net_bytes['tx']) / time_diff / 1024)
    
    prev_net_bytes = {'rx': total_rx, 'tx': total_tx}
    metrics_history['network_rx'].append(rx_kbs)
    metrics_history['network_tx'].append(tx_kbs)
    
    # Keep only last MAX_REALTIME_POINTS
    for key in metrics_history:
        if len(metrics_history[key]) > MAX_REALTIME_POINTS:
            metrics_history[key] = metrics_history[key][-MAX_REALTIME_POINTS:]

# Routes
@app.route('/')
def index():
    return render_template('dashboard.html')

@app.route('/api/status')
def status():
    """Get all status information"""
    battery = get_battery_info()
    brightness = get_brightness()
    system = get_system_info()
    network = get_network_info()
    battery_estimate = estimate_battery_life()

    return jsonify({
        'battery': battery,
        'battery_estimate': battery_estimate,
        'brightness': brightness,
        'system': system,
        'network': network,
        'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    })

@app.route('/api/iptv')
def iptv_status():
    """Get IPTV status"""
    return jsonify(get_iptv_status())

@app.route('/api/battery/history')
def battery_history_api():
    """Get battery history"""
    return jsonify(battery_history)

@app.route('/api/metrics/history')
def metrics_history_api():
    """Get real-time metrics history"""
    return jsonify(metrics_history)

@app.route('/api/brightness/set/<int:value>')
def set_brightness_api(value):
    """Set brightness via API"""
    if 0 <= value <= 100:
        result = set_brightness(value)
        return jsonify(result)
    return jsonify({'success': False, 'error': 'Value must be between 0 and 100'})

# ---- LED control endpoints ----

# Import LED paths/helpers from led_control.py
_UTILS_DIR = Path(__file__).parent.parent / 'utils'
LEDS_BASE = Path('/sys/class/leds')
NOTIFICATION_LED = LEDS_BASE / 'white:status'
WHITE_FLASH_LED = LEDS_BASE / 'white:flash'
YELLOW_FLASH_LED = LEDS_BASE / 'yellow:flash'


def _led_read(path: Path) -> str:
    try:
        return path.read_text().strip()
    except (OSError, PermissionError):
        return ''


def _led_write(path: Path, value: str) -> bool:
    try:
        path.write_text(value)
        return True
    except PermissionError:
        import subprocess as sp
        res = sp.run(['sudo', 'chmod', 'a+w', str(path)], capture_output=True)
        if res.returncode == 0:
            try:
                path.write_text(value)
                return True
            except OSError:
                pass
        return False
    except OSError:
        return False


def _led_get_trigger(led_path: Path) -> str:
    raw = _led_read(led_path / 'trigger')
    for part in raw.split():
        if part.startswith('[') and part.endswith(']'):
            return part[1:-1]
    return 'none'


# ---- Software-driven blink / breathe for notification LED ----
# delay_on/off and pattern/repeat sysfs files require root write permissions
# even when the trigger is set by a non-root user, so we drive these effects
# from a background thread using only the brightness file (which is world-writable).

_notify_effect_stop = threading.Event()
_notify_effect_thread = None
_notify_effect_lock = threading.Lock()


def _stop_notify_effect():
    """Signal the current blink/breathe thread to stop and wait for it."""
    global _notify_effect_thread
    _notify_effect_stop.set()
    with _notify_effect_lock:
        if _notify_effect_thread and _notify_effect_thread.is_alive():
            _notify_effect_thread.join(timeout=2)
        _notify_effect_thread = None
    _notify_effect_stop.clear()


def _run_blink(value: int, delay_s: float):
    steps = [value, 0]
    while not _notify_effect_stop.is_set():
        for v in steps:
            if _notify_effect_stop.is_set():
                return
            _led_write(NOTIFICATION_LED / 'brightness', str(v))
            if _notify_effect_stop.wait(delay_s):
                return


def _run_breathe(max_value: int, step_s: float):
    steps_up   = [0, 8, 32, 72, 128, 184, 224, 248, 255]
    steps_down = list(reversed(steps_up[:-1]))
    cycle = steps_up + steps_down
    scaled = [int(s / 255 * max_value) for s in cycle]
    while not _notify_effect_stop.is_set():
        for v in scaled:
            if _notify_effect_stop.is_set():
                return
            _led_write(NOTIFICATION_LED / 'brightness', str(v))
            if _notify_effect_stop.wait(step_s):
                return


@app.route('/api/led/status')
def led_status():
    """Get current LED states."""
    def led_info(led_path):
        brightness = _led_read(led_path / 'brightness')
        max_br = _led_read(led_path / 'max_brightness')
        trigger = _led_get_trigger(led_path)
        info = {
            'brightness': int(brightness) if brightness.isdigit() else 0,
            'max_brightness': int(max_br) if max_br.isdigit() else 0,
            'trigger': trigger,
        }
        return info

    return jsonify({
        'notification': led_info(NOTIFICATION_LED),
        'white_flash': led_info(WHITE_FLASH_LED),
        'yellow_flash': led_info(YELLOW_FLASH_LED),
        'notify_effect': '' if _notify_effect_thread is None or not _notify_effect_thread.is_alive() else 'running',
    })


@app.route('/api/led/notify', methods=['POST'])
@require_admin
def led_notify():
    """Control the notification LED."""
    global _notify_effect_thread
    data = request.get_json() or {}
    action = data.get('action', 'off')

    if action == 'off':
        _stop_notify_effect()
        _led_write(NOTIFICATION_LED / 'trigger', 'none')
        _led_write(NOTIFICATION_LED / 'brightness', '0')
        return jsonify({'success': True, 'state': 'off'})

    brightness_pct = max(0, min(100, int(data.get('brightness', 100))))
    max_val = int(_led_read(NOTIFICATION_LED / 'max_brightness') or '255')
    value = int((brightness_pct / 100) * max_val)
    mode = data.get('mode', 'solid')  # solid, blink, heartbeat, breathe

    # Stop any running software effect before switching mode
    _stop_notify_effect()
    _led_write(NOTIFICATION_LED / 'trigger', 'none')

    if mode == 'heartbeat':
        _led_write(NOTIFICATION_LED / 'trigger', 'heartbeat')
    elif mode == 'blink':
        # Software blink: only uses brightness file (world-writable)
        delay_s = max(0.1, int(data.get('blink_ms', 500))) / 1000
        _notify_effect_thread = threading.Thread(
            target=_run_blink, args=(value, delay_s), daemon=True)
        _notify_effect_thread.start()
    elif mode == 'breathe':
        # Software breathe: only uses brightness file (world-writable)
        speeds = {'slow': 0.08, 'normal': 0.04, 'fast': 0.02}
        step_s = speeds.get(data.get('speed', 'normal'), 0.04)
        _notify_effect_thread = threading.Thread(
            target=_run_breathe, args=(value, step_s), daemon=True)
        _notify_effect_thread.start()
    else:  # solid
        _led_write(NOTIFICATION_LED / 'brightness', str(value))

    return jsonify({'success': True, 'state': 'on', 'mode': mode, 'brightness': brightness_pct})


@app.route('/api/led/torch', methods=['POST'])
@require_admin
def led_torch():
    """Control the flash LEDs in torch mode."""
    data = request.get_json() or {}
    action = data.get('action', 'off')
    color = data.get('color', 'white')

    leds = []
    if color in ('white', 'both'):
        leds.append(WHITE_FLASH_LED)
    if color in ('yellow', 'both'):
        leds.append(YELLOW_FLASH_LED)

    if action == 'off':
        for led in leds:
            _led_write(led / 'flash_strobe', '0')
            _led_write(led / 'brightness', '0')
            _led_write(led / 'trigger', 'none')
        return jsonify({'success': True, 'state': 'off'})

    brightness_pct = max(0, min(100, int(data.get('brightness', 50))))
    for led in leds:
        max_val = int(_led_read(led / 'max_brightness') or '255')
        value = int((brightness_pct / 100) * max_val)
        _led_write(led / 'trigger', 'none')
        _led_write(led / 'brightness', str(value))

    return jsonify({'success': True, 'state': 'on', 'color': color, 'brightness': brightness_pct})


# ---- Admin endpoints ----

@app.route('/api/admin/login', methods=['POST'])
def admin_login():
    """Authenticate as admin and get a session token"""
    ip = request.headers.get('X-Real-IP', request.remote_addr)
    if _is_rate_limited(ip):
        return jsonify({'success': False, 'error': 'Too many attempts. Try again later.'}), 429
    _record_login_attempt(ip)
    data = request.get_json() or {}
    if data.get('password') == ADMIN_PASSWORD:
        token = secrets.token_hex(16)
        admin_sessions[token] = {'created_at': time.time()}
        return jsonify({'success': True, 'token': token})
    return jsonify({'success': False, 'error': 'Invalid password'}), 401


@app.route('/api/admin/logout', methods=['POST'])
def admin_logout():
    """Invalidate an admin session token"""
    data = request.get_json() or {}
    admin_sessions.pop(data.get('token', ''), None)
    return jsonify({'success': True})


@app.route('/api/admin/verify', methods=['POST'])
def admin_verify():
    """Verify an admin session token is still valid"""
    data = request.get_json() or {}
    token = data.get('token', '')
    session = admin_sessions.get(token)
    if not session:
        return jsonify({'valid': False}), 401
    if time.time() - session['created_at'] > 86400:  # 24-hour expiry
        admin_sessions.pop(token, None)
        return jsonify({'valid': False}), 401
    return jsonify({'valid': True})


# ---- Todo endpoints ----

@app.route('/api/todos', methods=['GET'])
def get_todos():
    """Return all todos"""
    return jsonify(todos_data)


@app.route('/api/todos/reorder', methods=['POST'])
def reorder_todos():
    """Persist new ordering for open todos"""
    data = request.get_json() or {}
    order = data.get('order', [])  # list of ids in new order
    id_to_order = {tid: i for i, tid in enumerate(order)}
    for todo in todos_data:
        if todo['id'] in id_to_order:
            todo['order'] = id_to_order[todo['id']]
    threading.Thread(target=save_todos, daemon=True).start()
    return jsonify({'success': True})


@app.route('/api/todos', methods=['POST'])
def create_todo():
    """Create a new todo item"""
    data = request.get_json() or {}
    new_id = secrets.token_hex(8)
    open_count = len([t for t in todos_data if not t.get('completed', False)])
    todo = {
        'id': new_id,
        'title': (data.get('title') or 'Untitled').strip(),
        'description': data.get('description', ''),
        'notes': data.get('notes', ''),
        'due_date': data.get('due_date', ''),
        'completed': False,
        'created_at': datetime.now().isoformat(),
        'completed_at': None,
        'order': open_count,
    }
    todos_data.append(todo)
    threading.Thread(target=save_todos, daemon=True).start()
    return jsonify(todo), 201


@app.route('/api/todos/<todo_id>', methods=['PUT'])
def update_todo(todo_id):
    """Update an existing todo item"""
    data = request.get_json() or {}
    for todo in todos_data:
        if todo['id'] == todo_id:
            for field in ['title', 'description', 'notes', 'due_date']:
                if field in data:
                    todo[field] = data[field]
            threading.Thread(target=save_todos, daemon=True).start()
            return jsonify(todo)
    return jsonify({'error': 'Not found'}), 404


@app.route('/api/todos/<todo_id>/complete', methods=['POST'])
def complete_todo(todo_id):
    """Mark a todo as completed (archived)"""
    for todo in todos_data:
        if todo['id'] == todo_id:
            todo['completed'] = True
            todo['completed_at'] = datetime.now().isoformat()
            threading.Thread(target=save_todos, daemon=True).start()
            return jsonify(todo)
    return jsonify({'error': 'Not found'}), 404


@app.route('/api/todos/<todo_id>/reopen', methods=['POST'])
def reopen_todo(todo_id):
    """Re-open an archived todo"""
    open_count = len([t for t in todos_data if not t.get('completed', False)])
    for todo in todos_data:
        if todo['id'] == todo_id:
            todo['completed'] = False
            todo['completed_at'] = None
            todo['order'] = open_count
            threading.Thread(target=save_todos, daemon=True).start()
            return jsonify(todo)
    return jsonify({'error': 'Not found'}), 404


@app.route('/api/todos/<todo_id>', methods=['DELETE'])
def delete_todo(todo_id):
    """Delete a todo item permanently"""
    global todos_data
    todos_data = [t for t in todos_data if t['id'] != todo_id]
    threading.Thread(target=save_todos, daemon=True).start()
    return jsonify({'success': True})


@app.route('/api/rally-bot/assets/<path:filename>')
def rally_bot_asset(filename):
    """Serve van images from rally_bot/assets/"""
    assets_dir = Path(__file__).parent.parent / 'rally_bot' / 'assets'
    return send_from_directory(str(assets_dir), filename)


@app.route('/api/rally-bot/routes')
def rally_bot_routes():
    """Get rally bot station routes with optional filtering"""
    try:
        # Use in-memory cache; falls back to disk if cache is cold
        with _routes_lock:
            all_routes = _routes_cache['data']
        if all_routes is None:
            _load_routes_if_changed()
            with _routes_lock:
                all_routes = _routes_cache['data']
        if all_routes is None:
            return jsonify({'success': False, 'error': 'Rally bot data not found'})

        # Build image lookup from models that have images, then fill gaps
        img_lookup = {}
        for route in all_routes:
            for ret in route.get('returns', []):
                mi = ret.get('model_image', '')
                if mi:
                    img_lookup[ret.get('model_name', '')] = mi
        # Map short roadsurfer names to a known image via keyword matching
        _FALLBACK_KEYWORDS = {
            'active bunk': 'Eu Active Bunk 4 Auto Base',
            'active long': 'Active Long 2',
            'active poptop': 'Eu Active Poptop 4 Auto Select',
            'active standard': 'Eu Active Standard 2 Auto Select',
            'california grand': 'VW Grand California',
            'california standard': 'Eu California Standard 4 Auto Base',
            'comfort compact': 'Comfort Compact',
            'comfort family': 'EU Comfort Family 6 Auto Select',
            'comfort long': 'EU Comfort Long 4 Auto Select',
            'comfort space': 'Eu Comfort Space 4 Auto Select',
            'comfort standard': 'Eu Comfort Standard 5 Auto Select',
        }
        fallback_map = {k: img_lookup.get(v, '') for k, v in _FALLBACK_KEYWORDS.items()}
        for route in all_routes:
            for ret in route.get('returns', []):
                if not ret.get('model_image'):
                    key = ret.get('model_name', '').lower()
                    if key in fallback_map and fallback_map[key]:
                        ret['model_image'] = fallback_map[key]
                # Deduplicate available_dates by (startDate, endDate, duration)
                seen_dates = set()
                unique_dates = []
                for dr in ret.get('available_dates', []):
                    dk = (dr.get('startDate'), dr.get('endDate'), dr.get('duration'))
                    if dk not in seen_dates:
                        seen_dates.add(dk)
                        unique_dates.append(dr)
                ret['available_dates'] = unique_dates

        # Get filter parameters (comma-separated multi-values supported)
        def parse_multi(param):
            raw = request.args.get(param, '').strip()
            return [v.strip().lower() for v in raw.split(',') if v.strip()] if raw else []

        origin_filters = parse_multi('origin')
        destination_filters = parse_multi('destination')
        model_filters = parse_multi('model')
        start_date = request.args.get('start_date', '').strip()
        end_date = request.args.get('end_date', '').strip()
        
        filtered_routes = []
        
        for route in all_routes:
            # Filter by origin (any selected)
            if origin_filters and not any(f in route['origin'].lower() for f in origin_filters):
                continue
            
            # Filter returns by destination, model and date
            filtered_returns = []
            for ret in route.get('returns', []):
                # Filter by destination (any selected)
                if destination_filters and not any(f in ret['destination'].lower() for f in destination_filters):
                    continue
                
                # Filter by model name (any selected)
                if model_filters and not any(f in ret.get('model_name', '').lower() for f in model_filters):
                    continue
                
                # Filter by date
                if start_date or end_date:
                    has_matching_date = False
                    for date_range in ret.get('available_dates', []):
                        # Check if route dates match filter
                        if start_date and end_date:
                            # Check if there's overlap with filter range
                            has_matching_date = True  # Simplified - could add proper date comparison
                        elif start_date:
                            has_matching_date = True
                        elif end_date:
                            has_matching_date = True
                    if not has_matching_date:
                        continue
                
                filtered_returns.append(ret)
            
            if filtered_returns:
                route_copy = route.copy()
                route_copy['returns'] = filtered_returns
                filtered_routes.append(route_copy)
        
        # Get unique origins, destinations and models for filter options
        origins = sorted(list(set([r['origin'] for r in all_routes])))
        destinations = sorted(list(set([
            ret['destination'] 
            for r in all_routes 
            for ret in r.get('returns', [])
        ])))
        models = sorted(list(set([
            ret['model_name']
            for r in all_routes
            for ret in r.get('returns', [])
            if ret.get('model_name')
        ])))
        
        return jsonify({
            'success': True,
            'routes': filtered_routes,
            'total_routes': len(filtered_routes),
            'total_returns': sum([len(r['returns']) for r in filtered_routes]),
            'filter_options': {
                'origins': origins,
                'destinations': destinations,
                'models': models
            }
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/api/rally-bot/refresh', methods=['POST'])
@require_admin
def rally_bot_refresh():
    """Manually trigger a fresh data fetch from all relocation APIs."""
    if _routes_updating.is_set():
        return jsonify({'success': False, 'message': 'Update already in progress'})
    threading.Thread(target=_fetch_routes_from_apis, daemon=True).start()
    return jsonify({'success': True, 'message': 'Refresh started in background'})


@app.route('/api/rally-bot/stats')
def rally_bot_stats():
    """Get rally bot statistics for admin dashboard"""
    try:
        rally_dir = Path(__file__).parent.parent / 'rally_bot'
        result = {}

        # --- station_routes.json ---
        routes_file = rally_dir / 'station_routes.json'
        if routes_file.exists():
            with open(routes_file, 'r') as f:
                all_routes = json.load(f)

            all_returns = [ret for r in all_routes for ret in r.get('returns', [])]

            model_counts = {}
            for ret in all_returns:
                m = ret.get('model_name') or 'Unknown'
                model_counts[m] = model_counts.get(m, 0) + 1

            top_origins = sorted(
                [{'origin': r['origin'], 'count': len(r.get('returns', []))} for r in all_routes],
                key=lambda x: x['count'], reverse=True
            )[:10]

            all_dates = []
            for ret in all_returns:
                for d in ret.get('available_dates', []):
                    try:
                        all_dates.append(datetime.strptime(d['startDate'], '%d/%m/%Y'))
                    except Exception:
                        pass

            result['routes'] = {
                'data_freshness': datetime.fromtimestamp(routes_file.stat().st_mtime).strftime('%Y-%m-%d %H:%M:%S'),
                'total_origins': len(all_routes),
                'total_returns': len(all_returns),
                'unique_destinations': len(set(ret['destination'] for ret in all_returns)),
                'model_breakdown': [{'model': k, 'count': v} for k, v in sorted(model_counts.items(), key=lambda x: x[1], reverse=True)],
                'top_origins': top_origins,
                'earliest_date': min(all_dates).strftime('%d/%m/%Y') if all_dates else None,
                'latest_date': max(all_dates).strftime('%d/%m/%Y') if all_dates else None,
            }
        else:
            result['routes'] = None

        # --- notification_history.json ---
        notif_file = rally_dir / 'notification_history.json'
        if notif_file.exists():
            with open(notif_file, 'r') as f:
                notif_data = json.load(f)
            per_user = {uid: len(notifs) for uid, notifs in notif_data.items()}
            result['notifications'] = {
                'total': sum(per_user.values()),
                'per_user': per_user,
            }
        else:
            result['notifications'] = None

        # --- user_favorites.json ---
        favs_file = rally_dir / 'user_favorites.json'
        if favs_file.exists():
            with open(favs_file, 'r') as f:
                favs_data = json.load(f)
            result['favorites'] = {
                'total': sum(len(v) for v in favs_data.values()),
                'per_user': {uid: len(favs) for uid, favs in favs_data.items()},
            }
        else:
            result['favorites'] = None

        # --- bot.log (last ~200 KB for recent stats) ---
        log_file = rally_dir / 'bot.log'
        if log_file.exists():
            with open(log_file, 'r', errors='replace') as f:
                f.seek(0, 2)
                size = f.tell()
                chunk = min(size, 200000)
                f.seek(size - chunk)
                lines = f.read(chunk).splitlines()

            error_count = sum(1 for l in lines if ' - ERROR - ' in l)
            warning_count = sum(1 for l in lines if ' - WARNING - ' in l)

            last_ts = None
            for line in reversed(lines):
                parts = line.split(' - ', 2)
                if len(parts) >= 2 and parts[0].strip():
                    last_ts = parts[0].strip()
                    break

            recent = [l for l in lines[-100:] if l.strip()][-25:]
            warning_lines = [l for l in lines if ' - WARNING - ' in l][-50:]
            error_lines   = [l for l in lines if ' - ERROR - '   in l][-50:]

            result['log'] = {
                'file_size_mb': round(log_file.stat().st_size / (1024 * 1024), 1),
                'recent_errors': error_count,
                'recent_warnings': warning_count,
                'last_entry': last_ts,
                'recent_lines': recent,
                'warning_lines': warning_lines,
                'error_lines': error_lines,
            }
        else:
            result['log'] = None

        return jsonify({'success': True, **result})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/api/quick-stats')
def quick_stats():
    """Get quick stats for dashboard header (lightweight)"""
    try:
        battery = get_battery_info()
        cpu_usage = psutil.cpu_percent(interval=0.1)
        mem_percent = psutil.virtual_memory().percent
        temp = get_temperature()
        
        return jsonify({
            'battery': battery,
            'cpu': cpu_usage,
            'memory': mem_percent,
            'temperature': temp,
            'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        })
    except Exception as e:
        return jsonify({'error': str(e)})

def background_metrics_collector():
    """Background thread to continuously collect metrics"""
    global last_battery_record_time
    print("Starting background metrics collection...")
    
    while True:
        try:
            # Collect system metrics
            system = get_system_info()
            network = get_network_info()
            
            # Add to metrics history
            add_metrics_history(system, network)
            
            # Check if it's time to record battery (every 10 minutes)
            battery = get_battery_info()
            # get_battery_info already handles the timing internally
            
            time.sleep(5)  # Collect every 5 seconds
        except Exception as e:
            print(f"Error in background collector: {e}")
            time.sleep(5)

# ---- Rally Bot geocoding endpoints ----
_GEOCODE_CACHE_FILE = Path(__file__).parent.parent / 'rally_bot' / 'geocode_cache.json'

@app.route('/api/rally-bot/geocodes')
def rally_bot_geocodes():
    """Return the full geocode cache (city → [lat, lng])."""
    if not _GEOCODE_CACHE_FILE.exists():
        return jsonify({})
    with open(_GEOCODE_CACHE_FILE, 'r') as f:
        return jsonify(json.load(f))

@app.route('/api/rally-bot/geocode')
def rally_bot_geocode_city():
    """Geocode a single city name via Nominatim, cache and return [lat, lng]."""
    city = request.args.get('city', '').strip()
    if not city:
        return jsonify({'error': 'city required'}), 400

    # Load existing cache
    cache = {}
    if _GEOCODE_CACHE_FILE.exists():
        with open(_GEOCODE_CACHE_FILE, 'r') as f:
            cache = json.load(f)

    if city in cache:
        return jsonify({'coords': cache[city], 'cached': True})

    # Query Nominatim
    try:
        resp = requests.get(
            'https://nominatim.openstreetmap.org/search',
            params={'q': city, 'format': 'json', 'limit': 1},
            headers={'User-Agent': 'rally-dashboard/1.0'},
            timeout=8,
        )
        results = resp.json()
        if results:
            coords = [float(results[0]['lat']), float(results[0]['lon'])]
            cache[city] = coords
            with open(_GEOCODE_CACHE_FILE, 'w') as f:
                json.dump(cache, f, indent=2)
            return jsonify({'coords': coords, 'cached': False})
        return jsonify({'error': 'City not found'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ---- File Storage endpoints ----
STORAGE_ROOT = Path(__file__).parent / 'storage'
STORAGE_ROOT.mkdir(exist_ok=True)

IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico'}


def _resolve_storage_path(rel: str) -> Path:
    """Resolve a relative path inside STORAGE_ROOT, preventing path traversal."""
    safe = STORAGE_ROOT.resolve()
    target = (safe / rel.lstrip('/')).resolve()
    if not str(target).startswith(str(safe)):
        raise ValueError('Path traversal attempt')
    return target


@app.route('/api/storage/list')
def storage_list():
    """List contents of a directory inside storage."""
    rel = request.args.get('path', '')
    try:
        folder = _resolve_storage_path(rel)
        if not folder.exists() or not folder.is_dir():
            return jsonify({'success': False, 'error': 'Not a directory'}), 400
        items = []
        for item in sorted(folder.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
            stat = item.stat()
            entry = {
                'name': item.name,
                'type': 'file' if item.is_file() else 'dir',
                'size': stat.st_size if item.is_file() else None,
                'modified': datetime.fromtimestamp(stat.st_mtime).strftime('%Y-%m-%d %H:%M'),
                'is_image': item.suffix.lower() in IMAGE_EXTS,
                'path': str(item.relative_to(STORAGE_ROOT)),
            }
            items.append(entry)
        return jsonify({'success': True, 'items': items, 'path': rel or '/'})
    except ValueError:
        return jsonify({'success': False, 'error': 'Invalid path'}), 400
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/storage/mkdir', methods=['POST'])
@require_admin
def storage_mkdir():
    """Create a new folder."""
    data = request.get_json() or {}
    rel = data.get('path', '')
    try:
        folder = _resolve_storage_path(rel)
        folder.mkdir(parents=True, exist_ok=False)
        return jsonify({'success': True})
    except FileExistsError:
        return jsonify({'success': False, 'error': 'Folder already exists'}), 409
    except ValueError:
        return jsonify({'success': False, 'error': 'Invalid path'}), 400
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/storage/upload', methods=['POST'])
@require_admin
def storage_upload():
    """Upload one or more files to a target directory."""
    # Enforce upload size limit
    if request.content_length and request.content_length > MAX_UPLOAD_SIZE:
        return jsonify({'success': False, 'error': 'File too large (max 10 MB)'}), 413
    rel = request.form.get('path', '')
    try:
        folder = _resolve_storage_path(rel)
        folder.mkdir(parents=True, exist_ok=True)
        saved = []
        for f in request.files.getlist('files'):
            filename = Path(f.filename).name  # strip any directory components
            if not filename:
                continue
            dest = folder / filename
            # avoid overwriting: append a counter if needed
            counter = 1
            stem, suffix = dest.stem, dest.suffix
            while dest.exists():
                dest = folder / f'{stem}_{counter}{suffix}'
                counter += 1
            f.save(str(dest))
            saved.append(dest.name)
        return jsonify({'success': True, 'saved': saved})
    except ValueError:
        return jsonify({'success': False, 'error': 'Invalid path'}), 400
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/storage/delete', methods=['POST'])
@require_admin
def storage_delete():
    """Delete a file or folder (recursively)."""
    data = request.get_json() or {}
    rel = data.get('path', '')
    try:
        target = _resolve_storage_path(rel)
        if not target.exists():
            return jsonify({'success': False, 'error': 'Not found'}), 404
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()
        return jsonify({'success': True})
    except ValueError:
        return jsonify({'success': False, 'error': 'Invalid path'}), 400
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/storage/file/<path:rel>')
def storage_file(rel):
    """Serve a file from storage (for preview / download)."""
    try:
        target = _resolve_storage_path(rel)
        if not target.is_file():
            return jsonify({'error': 'Not found'}), 404
        return send_from_directory(str(target.parent), target.name)
    except ValueError:
        return jsonify({'error': 'Invalid path'}), 400


def main():
    """Main entry point for the application"""
    # Load persisted data on startup
    load_battery_history()
    load_todos()
    
    # Start background metrics collection thread
    collector_thread = threading.Thread(target=background_metrics_collector, daemon=True)
    collector_thread.start()

    # Start rally routes file watcher / auto-refresh thread
    threading.Thread(target=_routes_watcher, daemon=True, name='routes_watcher').start()

    parser = argparse.ArgumentParser(description='Server Dashboard')
    parser.add_argument('--port', type=int, default=6969, help='Port to listen on (default: 6969)')
    args = parser.parse_args()

    cert = Path(__file__).parent / 'certs' / 'cert.pem'
    key  = Path(__file__).parent / 'certs' / 'key.pem'
    ssl_ctx = (str(cert), str(key)) if cert.exists() and key.exists() else None

    print(f"Starting server on port {args.port} ({'HTTPS' if ssl_ctx else 'HTTP'})...")
    app.run(host='0.0.0.0', port=args.port, debug=False, ssl_context=ssl_ctx)

if __name__ == '__main__':
    main()