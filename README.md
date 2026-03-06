# Phone Server Dashboard

A web dashboard for monitoring your PostmarketOS phone server.

## Project Structure

```
dashboard/
├── server.py              # Flask backend application
├── templates/
│   └── dashboard.html     # Main HTML template
├── static/
│   ├── css/
│   │   └── style.css     # Dashboard styles
│   └── js/
│       └── dashboard.js   # Dashboard frontend logic
├── pyproject.toml         # Python project configuration
└── requirements.txt       # Python dependencies
```

## Quick Start

```bash
# Run directly (development)
uv run python server.py
```

## Running as a Service

The dashboard runs as a **systemd system service** (`dashboard.service`), which means:

- Starts automatically on every boot
- Restarts automatically if it crashes (`Restart=always`, 10s delay)
- Runs detached from any terminal — SSH disconnects have no effect
- Runs as the `allorana` user on port **6969**

Service file: `/etc/systemd/system/dashboard.service`

```ini
[Service]
User=allorana
WorkingDirectory=/home/allorana/repos/dashboard
ExecStart=/home/allorana/.local/bin/uv run python server.py
Restart=always
RestartSec=10
```

### Useful commands

```bash
systemctl status dashboard        # check status & recent logs
systemctl restart dashboard       # restart the server
systemctl stop dashboard          # stop (won't auto-restart until started again)
journalctl -u dashboard -f        # follow live logs
```

## Features

- **System Metrics**: CPU, Memory, Temperature, Battery History, Disk, Network monitoring
- **Services**: Monitor systemd services status
- **IPTV**: Check IPTV subscription status
- **Brightness Control**: Adjust screen brightness
- **Tmux Sessions**: Monitor running tmux sessions
- Real-time updates every 5 seconds
- Historical data tracking
- Responsive design with tabbed interface