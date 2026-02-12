const REFRESH_MS = 5000;
const MAX_POINTS = 60;

// ---- window switching ----
function switchWindow(windowName) {
  // Hide all windows
  document.querySelectorAll('.window').forEach(w => w.classList.remove('active'));
  // Remove active from all nav items
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  
  // Show selected window
  document.getElementById('window-' + windowName).classList.add('active');
  // Activate corresponding nav item
  event.currentTarget.classList.add('active');
}

// ---- helpers ----
function setPill(id, ok){
  const el = document.getElementById(id);
  el.classList.remove('ok','bad');
  el.classList.add(ok ? 'ok' : 'bad');
  el.textContent = ok ? 'OK' : 'ISSUE';
}

// Fix arrow logic: check "discharg" before "charg" so "Discharging" never matches "charg" first.
function batteryArrow(status){
  const s = String(status || '').trim().toLowerCase();
  if (s.includes('discharg')) return '↓';
  if (s.includes('charg')) return '↑';
  if (s.includes('full')) return '•';
  return '•';
}

// ---- history helpers ----
const labels = [];
let startTime = null;
let secondsCounter = 0;

function nowLabel(){
  const d = new Date();
  if (!startTime) {
    startTime = d;
    secondsCounter = 0;
    return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
  }
  secondsCounter += 5; // 5 second intervals
  return `${secondsCounter}s`;
}
function pushLabel(){
  labels.push(nowLabel());
  if (labels.length > MAX_POINTS) {
    labels.shift();
    // Don't reset counter when shifting, keep it relative
  }
}
function pushPoint(arr, v){
  arr.push(v);
  if (arr.length > MAX_POINTS) arr.shift();
}

const chartDefaults = {
  responsive:true,
  maintainAspectRatio:false,
  animation:false,
  plugins:{ legend:{ display:false }},
  scales:{
    x:{ ticks:{ color:'rgba(147,164,189,.75)', maxTicksLimit:6 }, grid:{ color:'rgba(148,163,184,.08)' } },
    y:{ ticks:{ color:'rgba(147,164,189,.75)' }, grid:{ color:'rgba(148,163,184,.08)' } }
  }
};

// ---- line charts (historic) ----
const cpuData=[], memData=[], tempData=[];
const cpuChart = new Chart(document.getElementById('cpuChart'), {
  type:'line',
  data:{ labels, datasets:[{ data:cpuData, borderColor:'#38bdf8', tension:.25, pointRadius:0 }] },
  options: { ...chartDefaults, scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, min: 0 } } }
});
const memChart = new Chart(document.getElementById('memChart'), {
  type:'line',
  data:{ labels, datasets:[{ data:memData, borderColor:'#22c55e', tension:.25, pointRadius:0 }] },
  options: { ...chartDefaults, scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, min: 0 } } }
});
const tempChart = new Chart(document.getElementById('tempChart'), {
  type:'line',
  data:{ labels, datasets:[{ data:tempData, borderColor:'#f59e0b', tension:.25, pointRadius:0 }] },
  options: { ...chartDefaults, scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, min: 0 } } }
});

// ---- battery history chart ----
const batteryLabels = [];
const batteryData = [];
const batteryStatusData = []; // Store status for coloring
const batteryChart = new Chart(document.getElementById('batteryChart'), {
  type:'line',
  data:{ labels: batteryLabels, datasets:[{ data:batteryData, borderColor:'#22c55e', backgroundColor:'rgba(34,197,94,.15)', fill:true, tension:.25, pointRadius:0, segment: {
    borderColor: ctx => {
      const idx = ctx.p0DataIndex;
      if (!batteryStatusData[idx]) return '#22c55e';
      const status = batteryStatusData[idx].status.toLowerCase();
      const capacity = batteryStatusData[idx].capacity;
      if (status.includes('charg') && !status.includes('discharg')) return '#22c55e'; // green for charging
      if (capacity < 20) return '#ef4444'; // red for low battery while discharging
      return '#f59e0b'; // orange for discharging
    },
    backgroundColor: ctx => {
      const idx = ctx.p0DataIndex;
      if (!batteryStatusData[idx]) return 'rgba(34,197,94,.15)';
      const status = batteryStatusData[idx].status.toLowerCase();
      const capacity = batteryStatusData[idx].capacity;
      if (status.includes('charg') && !status.includes('discharg')) return 'rgba(34,197,94,.15)';
      if (capacity < 20) return 'rgba(239,68,68,.15)';
      return 'rgba(245,158,11,.15)';
    }
  }}] },
  options: { 
    ...chartDefaults, 
    scales: { 
      x:{ ticks:{ color:'rgba(147,164,189,.75)', maxTicksLimit:8 }, grid:{ color:'rgba(148,163,184,.08)' } },
      y: { ...chartDefaults.scales.y, min: 0, max: 100 } 
    } 
  }
});

// ---- disk gauge ----
function makeSpeedometerGauge(canvas, color){
  const START_DEG = -100;
  const ARC_DEG = 200;
  return new Chart(canvas, {
    type: 'doughnut',
    data: {
      datasets: [{
        data: [0, 100],
        backgroundColor: [color, 'rgba(148,163,184,.14)'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 1.5,
      animation: true,
      cutout: '50%',
      rotation: START_DEG,
      circumference: ARC_DEG,
      layout: { 
        padding: { 
          top: 0, 
          left: 0, 
          right: 0, 
          bottom: 0 
        } 
      },
      plugins: { 
        legend: { display: false }, 
        tooltip: { enabled: true } 
      }
    }
  });
}

function setSpeedometerGauge(chart, percent){
  let p = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  if (p > 0 && p < 2) p = 2; // minimum visibility
  chart.data.datasets[0].data = [p, 100 - p];
  chart.update();
}

const diskGauge = makeSpeedometerGauge(document.getElementById('diskGauge'), '#a78bfa');

// ---- network rate chart ----
const netRx = [], netTx = [];
const netChart = new Chart(document.getElementById('netChart'), {
  type:'line',
  data:{
    labels,
    datasets:[
      { label:'RX (KB/s)', data:netRx, borderColor:'#38bdf8', tension:.25, pointRadius:0 },
      { label:'TX (KB/s)', data:netTx, borderColor:'#22c55e', tension:.25, pointRadius:0 }
    ]
  },
  options:{
    responsive:true,
    maintainAspectRatio:false,
    animation:false,
    plugins:{ legend:{ display:true, labels:{ color:'rgba(147,164,189,.85)' } } },
    scales: { ...chartDefaults.scales, y: { ...chartDefaults.scales.y, min: 0 } }
  }
});

// ---- brightness (don't jump while dragging) ----
let brightnessTimeout;
let userDraggingBrightness = false;
const slider = document.getElementById('brightness-slider');

slider.addEventListener('pointerdown', () => userDraggingBrightness = true);
slider.addEventListener('pointerup', () => userDraggingBrightness = false);
slider.addEventListener('pointercancel', () => userDraggingBrightness = false);
slider.addEventListener('touchstart', () => userDraggingBrightness = true, {passive:true});
slider.addEventListener('touchend', () => userDraggingBrightness = false);

function setBrightness(value){
  fetch(`/api/brightness/set/${value}`)
    .then(r => r.json())
    .then(data => {
      if (!data.success) console.error("Brightness error:", data.error);
    })
    .catch(err => console.error('Error setting brightness:', err));
}

slider.addEventListener('input', (e) => {
  const v = Number(e.target.value);
  document.getElementById('brightness-kpi').textContent = v.toFixed(0);
  clearTimeout(brightnessTimeout);
  brightnessTimeout = setTimeout(() => setBrightness(v), 450);
});

// ---- network delta state (backend returns bytes totals) ----
let prevNetTotals = null; // { rxBytes, txBytes, ts }

// ---- tmux sessions ----
function updateTmux(){
  fetch('/api/tmux')
    .then(r => r.json())
    .then(data => {
      const total = data.total || 0;
      const sessions = data.sessions || [];
      
      document.getElementById('tmux-total').textContent = total;
      
      let activeCount = 0;
      let totalWindows = 0;
      let totalPanes = 0;
      let sessionsHTML = '';
      
      if (sessions.length === 0) {
        sessionsHTML = '<div class="stat"><span class="stat-label">No tmux sessions</span><span class="stat-value">--</span></div>';
      } else {
        sessions.forEach(session => {
          if (session.attached) activeCount++;
          totalWindows += session.windows || 0;
          totalPanes += session.panes || 0;
          
          const statusText = session.attached ? 'Attached' : 'Detached';
          const statusClass = session.attached ? 'ok' : 'bad';
          
          sessionsHTML += `
            <div class="card" style="margin-bottom:12px;background:rgba(2,6,23,.35);">
              <h2 style="margin-bottom:10px;">
                <span>${session.name}</span>
                <span class="pill ${statusClass}">${statusText}</span>
              </h2>
              <div class="rows">
                <div class="stat">
                  <span class="stat-label">Windows</span>
                  <span class="stat-value">${session.windows}</span>
                </div>
                <div class="stat">
                  <span class="stat-label">Panes</span>
                  <span class="stat-value">${session.panes}</span>
                </div>
                <div class="stat">
                  <span class="stat-label">Uptime</span>
                  <span class="stat-value">${session.uptime}</span>
                </div>
              </div>`;
          
          if (session.window_list && session.window_list.length > 0) {
            sessionsHTML += '<div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(148,163,184,.10);">';
            sessionsHTML += '<div style="color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;font-weight:900;">Windows</div>';
            session.window_list.forEach(win => {
              const activeIndicator = win.active ? '●' : '○';
              const activeColor = win.active ? 'var(--accent2)' : 'var(--muted)';
              sessionsHTML += `<div style="font-size:12px;color:var(--muted);margin:4px 0;"><span style="color:${activeColor};margin-right:6px;">${activeIndicator}</span>${win.name}</div>`;
            });
            sessionsHTML += '</div>';
          }
          
          sessionsHTML += '</div>';
        });
      }
      
      document.getElementById('tmux-active').textContent = activeCount;
      document.getElementById('tmux-windows').textContent = totalWindows;
      document.getElementById('tmux-panes').textContent = totalPanes;
      document.getElementById('tmux-sessions-list').innerHTML = sessionsHTML;
      
      setPill('tmux-pill', total > 0);
    })
    .catch(err => {
      console.error('Error fetching tmux sessions:', err);
      document.getElementById('tmux-sessions-list').innerHTML = 
        '<div class="stat"><span class="stat-label">Error</span><span class="stat-value">Failed to load</span></div>';
    });
}

// ---- battery history ----
function loadBatteryHistory() {
  fetch('/api/battery/history')
    .then(r => r.json())
    .then(data => {
      batteryLabels.length = 0;
      batteryData.length = 0;
      batteryStatusData.length = 0;
      
      data.forEach((entry, index) => {
        const date = new Date(entry.timestamp);
        // Show absolute time for first entry, then relative hours
        if (index === 0) {
          batteryLabels.push(date.toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}));
        } else {
          batteryLabels.push(date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}));
        }
        batteryData.push(entry.capacity);
        batteryStatusData.push({status: entry.status || '', capacity: entry.capacity});
      });
      
      batteryChart.update();
      console.log(`Loaded ${data.length} battery history entries`);
    })
    .catch(err => console.error('Error loading battery history:', err));
}

// ---- metrics history ----
function loadMetricsHistory() {
  fetch('/api/metrics/history')
    .then(r => r.json())
    .then(data => {
      // Clear arrays
      labels.length = 0;
      cpuData.length = 0;
      memData.length = 0;
      tempData.length = 0;
      netRx.length = 0;
      netTx.length = 0;
      
      // Load historical data
      data.timestamps.forEach((timestamp, index) => {
        const date = new Date(timestamp);
        if (index === 0) {
          startTime = date;
          secondsCounter = 0;
          labels.push(date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}));
        } else {
          secondsCounter += 5;
          labels.push(`${secondsCounter}s`);
        }
        
        cpuData.push(data.cpu[index]);
        memData.push(data.memory[index]);
        tempData.push(data.temperature[index]);
        netRx.push(data.network_rx[index]);
        netTx.push(data.network_tx[index]);
      });
      
      // Update all charts
      cpuChart.update();
      memChart.update();
      tempChart.update();
      netChart.update();
      
      console.log(`Loaded ${data.timestamps.length} metrics history entries`);
    })
    .catch(err => console.error('Error loading metrics history:', err));
}

function updateDashboard(){
  fetch('/api/status')
    .then(r => r.json())
    .then(data => {
      document.getElementById('last-update').textContent = data.timestamp;

      // Battery hero
      const cap = Number(data.battery.capacity);
      const capOk = Number.isFinite(cap);
      document.getElementById('battery-hero-pct').textContent = capOk ? `${cap.toFixed(0)}%` : '--%';
      document.getElementById('battery-hero-status').textContent = data.battery.status || '--';
      document.getElementById('battery-hero-arrow').textContent = batteryArrow(data.battery.status);
      document.getElementById('battery-hero-bar').style.width = capOk ? `${Math.max(0, Math.min(100, cap))}%` : '0%';
      
      // Battery history KPI
      document.getElementById('battery-hist-kpi').textContent = capOk ? cap.toFixed(0) : '--';

      // Current metrics
      const cpu = Number(data.system.cpu_usage);
      const mem = Number(data.system.memory?.percent);
      const disk = Number(data.system.disk?.percent);
      const temp = (typeof data.system.temperature === 'number') ? data.system.temperature : Number(data.system.temperature);

      document.getElementById('cpu-kpi').textContent = Number.isFinite(cpu) ? cpu.toFixed(0) : '--';
      document.getElementById('mem-kpi').textContent = Number.isFinite(mem) ? mem.toFixed(0) : '--';
      document.getElementById('disk-kpi').textContent = Number.isFinite(disk) ? disk.toFixed(0) : '--';
      document.getElementById('temp-kpi').textContent = Number.isFinite(temp) ? temp.toFixed(1) : '--';

      // Disk gauge
      setSpeedometerGauge(diskGauge, disk);

      // memory/disk details
      document.getElementById('mem-progress').style.width = (Number.isFinite(mem) ? mem : 0) + '%';
      document.getElementById('mem-info').textContent =
        `${data.system.memory?.used ?? '--'} GB / ${data.system.memory?.total ?? '--'} GB`;

      const diskInfo = `${data.system.disk?.used ?? '--'} GB / ${data.system.disk?.total ?? '--'} GB`;
      document.getElementById('disk-info').textContent = diskInfo;

      // Network
      document.getElementById('net-ip').textContent = data.network.ip_address || '--';
      let interfacesHTML = '';
      let rxBytes = 0, txBytes = 0;
      for (const [iface, stats] of Object.entries(data.network.interfaces || {})) {
        // Skip usb0 and rmnet_ipa0
        if (iface === 'usb0' || iface === 'rmnet_ipa0') continue;
        
        const rb = Number(stats.bytes_recv) || 0;
        const tb = Number(stats.bytes_sent) || 0;
        rxBytes += rb;
        txBytes += tb;
        const rMB = (rb / (1024 * 1024)).toFixed(2);
        const tMB = (tb / (1024 * 1024)).toFixed(2);
        interfacesHTML += `
          <div class="stat">
            <span class="stat-label">${iface}</span>
            <span class="stat-value">↓ ${rMB} MB   ↑ ${tMB} MB</span>
          </div>`;
      }
      document.getElementById('network-interfaces').innerHTML = interfacesHTML || '';

      // KB/s from delta bytes
      const now = Date.now();
      let rxKBs = 0, txKBs = 0;
      if (prevNetTotals) {
        const dt = Math.max(1, (now - prevNetTotals.ts) / 1000);
        rxKBs = Math.max(0, ((rxBytes - prevNetTotals.rxBytes) / dt) / 1024);
        txKBs = Math.max(0, ((txBytes - prevNetTotals.txBytes) / dt) / 1024);
      }
      prevNetTotals = { rxBytes, txBytes, ts: now };

      // Services
      let servicesHTML = '';
      let anyBad = false;
      for (const [svc, st] of Object.entries(data.services || {})) {
        const active = (st === 'active');
        anyBad = anyBad || !active;
        servicesHTML += `
          <div class="stat">
            <span class="stat-label">${svc}</span>
            <span class="pill ${active ? 'ok' : 'bad'}">${st}</span>
          </div>`;
      }
      document.getElementById('services-list').innerHTML = servicesHTML || `
        <div class="stat"><span class="stat-label">No services</span><span class="stat-value">--</span></div>`;

      // Threshold pills
      setPill('cpu-pill', !(Number.isFinite(cpu) && cpu > 90));
      setPill('mem-pill', !(Number.isFinite(mem) && mem > 85));
      setPill('disk-pill', !(Number.isFinite(disk) && disk > 90));
      setPill('temp-pill', !(Number.isFinite(temp) && temp > 80));
      setPill('svc-pill', !anyBad);

      // Overall dot
      const overallBad =
        (Number.isFinite(cpu) && cpu > 95) ||
        (Number.isFinite(mem) && mem > 92) ||
        (Number.isFinite(disk) && disk > 95) ||
        (Number.isFinite(temp) && temp > 85) ||
        anyBad;

      const dot = document.getElementById('status-dot');
      dot.style.background = overallBad ? 'var(--bad)' : 'var(--accent)';
      dot.style.boxShadow = overallBad ? '0 0 0 3px rgba(239,68,68,.18)' : '0 0 0 3px rgba(34,197,94,.16)';

      // Brightness (sync, but do not overwrite while dragging)
      const b = Number(data.brightness?.percentage);
      if (Number.isFinite(b)) {
        document.getElementById('brightness-kpi').textContent = b.toFixed(0);
        if (!userDraggingBrightness) slider.value = b.toFixed(0);
      }

      // ---- push historic points (CPU/MEM/TEMP + NET rate) ----
      pushLabel();
      pushPoint(cpuData, Number.isFinite(cpu) ? cpu : null);
      pushPoint(memData, Number.isFinite(mem) ? mem : null);
      pushPoint(tempData, Number.isFinite(temp) ? temp : null);
      pushPoint(netRx, rxKBs);
      pushPoint(netTx, txKBs);

      cpuChart.update();
      memChart.update();
      tempChart.update();
      netChart.update();
    })
    .catch(err => console.error('Error fetching status:', err));

  fetch('/api/iptv')
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        document.getElementById('iptv-username').textContent = data.username ?? '--';
        document.getElementById('iptv-connections').textContent = `${data.active_cons} / ${data.max_connections}`;
        document.getElementById('iptv-status').textContent = data.status ?? '--';
        document.getElementById('iptv-expires').textContent = data.exp_date ?? '--';
        setPill('iptv-pill', String(data.status).toLowerCase() === 'active' || String(data.status).toLowerCase() === 'enabled');
      } else {
        const msg = String(data.error || 'Unknown error');
        document.getElementById('iptv-content').innerHTML =
          `<div class="stat"><span class="stat-label">Error</span><span class="stat-value">${msg}</span></div>`;
        setPill('iptv-pill', false);
      }
    })
    .catch(err => console.error('Error fetching IPTV status:', err));
}

// Load battery history on startup and refresh every 5 minutes
loadBatteryHistory();
setInterval(loadBatteryHistory, 300000);

// Load metrics history on startup, then start live updates
loadMetricsHistory();
updateDashboard();
updateTmux();
setInterval(updateDashboard, REFRESH_MS);
setInterval(updateTmux, REFRESH_MS);
