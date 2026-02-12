from flask import Flask, render_template, jsonify
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

app = Flask(__name__)

# Battery history configuration
BATTERY_HISTORY_FILE = Path(__file__).parent / 'battery_history.json'
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

def run_command(command):
    """Execute shell command and return output"""
    try:
        result = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=5)
        return result.stdout.strip()
    except Exception as e:
        return f"Error: {str(e)}"

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

def set_brightness(value):
    """Set brightness level (0-100)"""
    try:
        max_brightness = int(run_command('cat /sys/class/backlight/*/max_brightness'))
        actual_value = int((value / 100) * max_brightness)
        result = run_command(f'echo {actual_value} | sudo tee /sys/class/backlight/*/brightness')
        return {'success': True, 'value': value}
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

def get_iptv_status():
    try:
        url = f"https://{IPTV_HOST}/player_api.php?username={IPTV_USERNAME}&password={IPTV_PASSWORD}"
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
            "Accept": "application/json,text/plain,*/*",
            "Referer": f"https://{IPTV_HOST}/",
        }

        r = requests.get(url, headers=headers, timeout=10)
        # if it's 403, show it cleanly
        if r.status_code == 403:
            return {"success": False, "error": "Forbidden (403) - provider blocked this host/IP"}

        r.raise_for_status()
        data = r.json()
        user_info = data.get("user_info", {}) or {}

        exp_date = user_info.get("exp_date", "N/A")
        if exp_date and str(exp_date).isdigit():
            exp_date = datetime.fromtimestamp(int(exp_date)).strftime("%Y-%m-%d %H:%M:%S")

        return {
            "success": True,
            "username": user_info.get("username", "N/A"),
            "active_cons": user_info.get("active_cons", "N/A"),
            "max_connections": user_info.get("max_connections", "N/A"),
            "status": user_info.get("status", "N/A"),
            "exp_date": exp_date,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}

def get_running_services():
    """Get status of important services"""
    services = ['sshd', 'cron', 'systemd-resolved']
    status = {}
    
    for service in services:
        result = run_command(f'systemctl is-active {service}')
        status[service] = result
    
    return status

def get_tmux_sessions():
    """Get tmux sessions and their status"""
    try:
        # Get list of tmux sessions
        sessions_output = run_command('tmux list-sessions -F "#{session_name}|#{session_created}|#{session_attached}|#{session_windows}" 2>/dev/null')
        
        if not sessions_output or 'Error' in sessions_output or sessions_output == '':
            return {'sessions': [], 'total': 0}
        
        sessions = []
        for line in sessions_output.strip().split('\n'):
            if not line:
                continue
            parts = line.split('|')
            if len(parts) >= 4:
                session_name = parts[0]
                created = parts[1]
                attached = parts[2]
                windows = parts[3]
                
                # Get windows info for this session
                windows_output = run_command(f'tmux list-windows -t "{session_name}" -F "#{{window_index}}:#{{window_name}}|#{{window_active}}" 2>/dev/null')
                window_list = []
                if windows_output and 'Error' not in windows_output:
                    for win_line in windows_output.strip().split('\n'):
                        if '|' in win_line:
                            win_info, is_active = win_line.split('|')
                            window_list.append({
                                'name': win_info,
                                'active': is_active == '1'
                            })
                
                # Get panes count
                panes_count = run_command(f'tmux list-panes -t "{session_name}" 2>/dev/null | wc -l')
                
                # Calculate uptime
                try:
                    created_ts = int(created)
                    uptime_seconds = int(time.time()) - created_ts
                    hours = uptime_seconds // 3600
                    minutes = (uptime_seconds % 3600) // 60
                    if hours > 0:
                        uptime = f"{hours}h {minutes}m"
                    else:
                        uptime = f"{minutes}m"
                except:
                    uptime = 'N/A'
                
                sessions.append({
                    'name': session_name,
                    'attached': attached != '0',
                    'windows': int(windows) if windows.isdigit() else 0,
                    'panes': int(panes_count.strip()) if panes_count.strip().isdigit() else 0,
                    'uptime': uptime,
                    'window_list': window_list
                })
        
        return {
            'sessions': sessions,
            'total': len(sessions)
        }
    except Exception as e:
        print(f"Error getting tmux sessions: {e}")
        return {'sessions': [], 'total': 0, 'error': str(e)}

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
    services = get_running_services()
    
    return jsonify({
        'battery': battery,
        'brightness': brightness,
        'system': system,
        'network': network,
        'services': services,
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

@app.route('/api/tmux')
def tmux_sessions():
    """Get tmux sessions"""
    return jsonify(get_tmux_sessions())

@app.route('/api/reboot')
def reboot():
    """Reboot system (use with caution)"""
    # Add authentication here in production!
    run_command('sudo reboot')
    return jsonify({'success': True, 'message': 'Rebooting...'})

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

def main():
    """Main entry point for the application"""
    # Load battery history on startup
    load_battery_history()
    
    # Start background metrics collection thread
    collector_thread = threading.Thread(target=background_metrics_collector, daemon=True)
    collector_thread.start()
    
    print(f"Starting server on port 5020...")
    app.run(host='0.0.0.0', port=5020, debug=False)

if __name__ == '__main__':
    main()