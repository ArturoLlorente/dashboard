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
# Or run directly
uv run server.py
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