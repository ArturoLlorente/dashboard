from flask import Flask, render_template, jsonify
import subprocess
import os
import requests
from datetime import datetime
import psutil
import socket
from pathlib import Path

app = Flask(__name__)

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

def run_command(command):
    """Execute shell command and return output"""
    try:
        result = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=5)
        return result.stdout.strip()
    except Exception as e:
        return f"Error: {str(e)}"

def get_battery_info():
    """Get battery status"""
    try:
        capacity = run_command('cat /sys/class/power_supply/qcom-battery/capacity')
        status = run_command('cat /sys/class/power_supply/qcom-battery/status')
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
                'bytes_sent': round(stats.bytes_sent / (1024**2), 2),
                'bytes_recv': round(stats.bytes_recv / (1024**2), 2)
            }
        
        return {
            'ip_address': ip_addr,
            'interfaces': interfaces
        }
    except Exception as e:
        return {'error': str(e)}

def get_iptv_status():
    try:
        url = f"https://av-ext.com:8443/player_api.php?username={IPTV_USERNAME}&password={IPTV_PASSWORD}"
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
            "Accept": "application/json,text/plain,*/*",
            "Referer": "https://av-ext.com:8443/",
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

# Routes
@app.route('/')
def index():
    return render_template('dashboard.html')

@app.route('/api/status')
def status():
    """Get all status information"""
    return jsonify({
        'battery': get_battery_info(),
        'brightness': get_brightness(),
        'system': get_system_info(),
        'network': get_network_info(),
        'services': get_running_services(),
        'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    })

@app.route('/api/iptv')
def iptv_status():
    """Get IPTV status"""
    return jsonify(get_iptv_status())

@app.route('/api/brightness/set/<int:value>')
def set_brightness_api(value):
    """Set brightness via API"""
    if 0 <= value <= 100:
        result = set_brightness(value)
        return jsonify(result)
    return jsonify({'success': False, 'error': 'Value must be between 0 and 100'})

@app.route('/api/reboot')
def reboot():
    """Reboot system (use with caution)"""
    # Add authentication here in production!
    run_command('sudo reboot')
    return jsonify({'success': True, 'message': 'Rebooting...'})

def main():
    """Main entry point for the application"""
    app.run(host='0.0.0.0', port=5020, debug=False)

if __name__ == '__main__':
    main()