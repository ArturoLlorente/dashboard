const REFRESH_MS = 5000;
const MAX_POINTS = 60;

// ---- Quick stats update (always visible) ----
function updateQuickStats() {
  fetch('/api/quick-stats')
    .then(r => r.json())
    .then(data => {
      document.getElementById('last-update').textContent = data.timestamp;
      
      // Update battery hero
      const cap = Number(data.battery.capacity);
      const capOk = Number.isFinite(cap);
      document.getElementById('battery-hero-pct').textContent = capOk ? `${cap.toFixed(0)}%` : '--%';
      document.getElementById('battery-hero-status').textContent = data.battery.status || '--';
      document.getElementById('battery-hero-arrow').textContent = batteryArrow(data.battery.status);
      document.getElementById('battery-hero-bar').style.width = capOk ? `${Math.max(0, Math.min(100, cap))}%` : '0%';
      
      // Update quick stats
      const cpu = Number(data.cpu);
      const mem = Number(data.memory);
      const temp = Number(data.temperature);
      
      document.getElementById('quick-cpu').textContent = Number.isFinite(cpu) ? `${cpu.toFixed(0)}%` : '--%';
      document.getElementById('quick-mem').textContent = Number.isFinite(mem) ? `${mem.toFixed(0)}%` : '--%';
      document.getElementById('quick-temp').textContent = Number.isFinite(temp) ? `${temp.toFixed(1)}°C` : '--°C';
      
      // Update status dot
      const overallBad = (Number.isFinite(cpu) && cpu > 95) || (Number.isFinite(mem) && mem > 92) || (Number.isFinite(temp) && temp > 85);
      const dot = document.getElementById('status-dot');
      dot.style.background = overallBad ? 'var(--bad)' : 'var(--accent)';
      dot.style.boxShadow = overallBad ? '0 0 0 3px rgba(239,68,68,.18)' : '0 0 0 3px rgba(34,197,94,.16)';
    })
    .catch(err => console.error('Error fetching quick stats:', err));
}

// Admin-only windows (require admin authentication)
const ADMIN_WINDOWS = new Set(['metrics', 'controls', 'todo', 'rally-stats']);
let isAdmin = false;
let adminToken = sessionStorage.getItem('adminToken') || null;

// ---- window switching ----
let currentWindow = 'rally';

function switchWindow(windowName) {
  // Guard: admin-only windows are not accessible without authentication
  if (ADMIN_WINDOWS.has(windowName) && !isAdmin) return;

  // Hide all windows
  document.querySelectorAll('.window').forEach(w => w.classList.remove('active'));
  // Remove active from all nav items
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  // Show selected window
  document.getElementById('window-' + windowName).classList.add('active');
  // Activate corresponding nav item via data-window attribute
  const navEl = document.querySelector(`.nav-item[data-window="${windowName}"]`);
  if (navEl) navEl.classList.add('active');
  
  currentWindow = windowName;

  // Load window-specific data
  if (windowName === 'rally') {
    loadRallyBotData();
  } else if (windowName === 'rally-stats') {
    loadRallyStats();
  } else if (windowName === 'metrics') {
    updateDashboard();
  } else if (windowName === 'controls') {
    updateDashboard();
  } else if (windowName === 'todo') {
    loadTodos();
  }

}

// ---- Admin authentication ----

function applyAdminState(active) {
  isAdmin = active;
  document.querySelectorAll('.nav-admin-item').forEach(el => {
    el.style.display = active ? 'flex' : 'none';
  });
  document.querySelectorAll('.nav-admin-divider').forEach(el => {
    el.style.display = active ? 'block' : 'none';
  });
  const lockBtn = document.getElementById('admin-lock-btn');
  if (lockBtn) lockBtn.textContent = active ? '🔓' : '🔒';
}

function toggleAdminModal() {
  if (isAdmin) {
    lockAdmin();
  } else {
    openAdminModal();
  }
}

function openAdminModal() {
  const overlay = document.getElementById('admin-modal-overlay');
  overlay.classList.add('open');
  setTimeout(() => {
    const inp = document.getElementById('admin-password-input');
    if (inp) inp.focus();
  }, 60);
}

function closeAdminModal() {
  document.getElementById('admin-modal-overlay').classList.remove('open');
  document.getElementById('admin-password-input').value = '';
  document.getElementById('admin-login-error').textContent = '';
}

function closeAdminModalOverlay(event) {
  if (event.target === document.getElementById('admin-modal-overlay')) closeAdminModal();
}

function submitAdminPassword(event) {
  event.preventDefault();
  const pw = document.getElementById('admin-password-input').value;
  document.getElementById('admin-login-error').textContent = '';
  fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw })
  })
  .then(r => r.json())
  .then(data => {
    if (data.success) {
      adminToken = data.token;
      sessionStorage.setItem('adminToken', adminToken);
      applyAdminState(true);
      closeAdminModal();
    } else {
      document.getElementById('admin-login-error').textContent = data.error || 'Invalid password';
      document.getElementById('admin-password-input').value = '';
      document.getElementById('admin-password-input').focus();
    }
  })
  .catch(() => { document.getElementById('admin-login-error').textContent = 'Network error'; });
}

function lockAdmin() {
  // Invalidate admin session on server
  if (adminToken) {
    fetch('/api/admin/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: adminToken })
    }).catch(() => {});
    adminToken = null;
    sessionStorage.removeItem('adminToken');
  }
  applyAdminState(false);
  // If on an admin window, return to Rally Bot
  if (ADMIN_WINDOWS.has(currentWindow)) {
    switchWindow('rally');
  }
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
  options: chartDefaults
});
const tempChart = new Chart(document.getElementById('tempChart'), {
  type:'line',
  data:{ labels, datasets:[{ data:tempData, borderColor:'#f59e0b', tension:.25, pointRadius:0 }] },
  options: chartDefaults
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

      // Battery life estimate
      const est = data.battery_estimate;
      let estText = '';
      let estCardText = '';
      if (est) {
        const rate = est.rate_per_hour ? `${est.rate_per_hour}%/h` : '';
        if (est.status === 'discharging' && est.estimate !== 'Stable') {
          estText = `~${est.estimate} left`;
          estCardText = `⬇ ${rate} · ~${est.estimate} remaining`;
        } else if (est.status === 'charging' && est.estimate !== 'Stable') {
          estText = `~${est.estimate} to full`;
          estCardText = `⬆ ${rate} · ~${est.estimate} to full`;
        } else if (est.estimate === 'Stable') {
          estText = 'Stable';
          estCardText = 'Drain rate: 0%/h';
        }
      }
      document.getElementById('battery-hero-estimate').textContent = estText;
      document.getElementById('battery-estimate-card').textContent = estCardText;

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

      // Threshold pills
      setPill('cpu-pill', !(Number.isFinite(cpu) && cpu > 90));
      setPill('mem-pill', !(Number.isFinite(mem) && mem > 85));
      setPill('disk-pill', !(Number.isFinite(disk) && disk > 90));
      setPill('temp-pill', !(Number.isFinite(temp) && temp > 80));

      // Overall dot
      const overallBad =
        (Number.isFinite(cpu) && cpu > 95) ||
        (Number.isFinite(mem) && mem > 92) ||
        (Number.isFinite(disk) && disk > 95) ||
        (Number.isFinite(temp) && temp > 85);

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

// ---- Smart refresh based on current window ----
function updateDiskQuickStat() {
  fetch('/api/status')
    .then(r => r.json())
    .then(data => {
      const disk = Number(data.system.disk?.percent);
      document.getElementById('quick-disk').textContent = Number.isFinite(disk) ? `${disk.toFixed(0)}%` : '--%';
    })
    .catch(err => console.error('Error fetching disk stats:', err));
}

function smartRefresh() {
  // Always update quick stats (they're always visible)
  updateQuickStats();
  updateDiskQuickStat();
  
  // Update only the current window's data
  if (currentWindow === 'metrics' || currentWindow === 'controls') {
    updateDashboard();
  }
  // Rally bot and stats don't need auto-refresh (user-driven)
}

// Load battery history on startup and refresh every 5 minutes
loadBatteryHistory();
setInterval(loadBatteryHistory, 300000);

// Load metrics history on startup, then start smart updates
loadMetricsHistory();
updateDashboard();
setInterval(smartRefresh, REFRESH_MS);



// ---- Rally Bot Stats (admin window) ----
let rbsWarnLines = [];
let rbsErrLines  = [];

function loadRallyStats() {
  // Show loading state
  ['rbs-notifs','rbs-warnings','rbs-errors'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '…';
  });
  ['rbs-models','rbs-top-origins','rbs-log'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<div class="loading-message">Loading…</div>';
  });

  fetch('/api/rally-bot/stats')
    .then(r => r.json())
    .then(data => {
      if (!data.success) {
        document.getElementById('rbs-log').innerHTML =
          `<div class="loading-message">Error: ${data.error}</div>`;
        return;
      }

      // --- Summary cards ---
      const r = data.routes || {};

      const n = data.notifications || {};
      document.getElementById('rbs-notifs').textContent   = n.total ?? '--';

      const l = data.log || {};
      const warnEl = document.getElementById('rbs-warnings');
      const errEl  = document.getElementById('rbs-errors');
      warnEl.textContent = l.recent_warnings ?? '--';
      errEl.textContent  = l.recent_errors   ?? '--';
      warnEl.closest('.rally-stat-card').classList.toggle('rbs-active-warn', (l.recent_warnings || 0) > 0);
      errEl.closest('.rally-stat-card').classList.toggle('rbs-active-err',  (l.recent_errors  || 0) > 0);

      // Store filtered lines for detail modal
      rbsWarnLines = l.warning_lines || [];
      rbsErrLines  = l.error_lines   || [];

      // --- Data overview ---
      document.getElementById('rbs-freshness').textContent = r.data_freshness ?? '--';
      document.getElementById('rbs-earliest').textContent  = r.earliest_date  ?? '--';
      document.getElementById('rbs-latest').textContent    = r.latest_date    ?? '--';
      document.getElementById('rbs-logsize').textContent   = l.file_size_mb != null ? `${l.file_size_mb} MB` : '--';
      document.getElementById('rbs-lastlog').textContent   = l.last_entry ?? '--';
      const f = data.favorites || {};
      document.getElementById('rbs-favs').textContent = f.total ?? '--';

      // --- Model breakdown table ---
      const modelsEl = document.getElementById('rbs-models');
      const models = r.model_breakdown || [];
      if (models.length) {
        const maxCount = models[0].count;
        modelsEl.innerHTML = models.map(m => `
          <div class="rbs-row">
            <span class="rbs-row-label">${m.model}</span>
            <div class="rbs-bar-wrap">
              <div class="rbs-bar" style="width:${Math.round(m.count/maxCount*100)}%"></div>
            </div>
            <span class="rbs-row-val">${m.count}</span>
          </div>`).join('');
      } else {
        modelsEl.innerHTML = '<div class="loading-message">No data</div>';
      }

      // --- Top origins table ---
      const originsEl = document.getElementById('rbs-top-origins');
      const tops = r.top_origins || [];
      if (tops.length) {
        const maxC = tops[0].count;
        originsEl.innerHTML = tops.map(o => `
          <div class="rbs-row">
            <span class="rbs-row-label">${o.origin}</span>
            <div class="rbs-bar-wrap">
              <div class="rbs-bar rbs-bar-alt" style="width:${Math.round(o.count/maxC*100)}%"></div>
            </div>
            <span class="rbs-row-val">${o.count}</span>
          </div>`).join('');
      } else {
        originsEl.innerHTML = '<div class="loading-message">No data</div>';
      }

      // --- Log tail ---
      const logEl = document.getElementById('rbs-log');
      const lines = l.recent_lines || [];
      if (lines.length) {
        logEl.innerHTML = lines.map(line => {
          let cls = '';
          if (line.includes(' - ERROR - '))   cls = 'rbs-log-err';
          else if (line.includes(' - WARNING - ')) cls = 'rbs-log-warn';
          else if (line.includes(' - INFO - '))    cls = 'rbs-log-info';
          return `<div class="rbs-log-line ${cls}">${escHtml(line)}</div>`;
        }).join('');
        logEl.scrollTop = logEl.scrollHeight;
      } else {
        logEl.innerHTML = '<div class="loading-message">No recent log entries</div>';
      }
    })
    .catch(err => {
      document.getElementById('rbs-log').innerHTML =
        `<div class="loading-message">Failed to load stats</div>`;
    });
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function rbsShowDetail(type) {
  const lines  = type === 'warn' ? rbsWarnLines : rbsErrLines;
  const title  = type === 'warn' ? '⚠️ Recent Warnings' : '🔴 Recent Errors';
  const cls    = type === 'warn' ? 'rbs-log-warn' : 'rbs-log-err';

  document.getElementById('rbs-detail-title').textContent = title;

  const body = document.getElementById('rbs-detail-body');
  if (!lines.length) {
    body.innerHTML = '<div class="loading-message" style="padding:20px 0">No entries found in recent log.</div>';
  } else {
    body.innerHTML = lines.map(l => `<div class="rbs-log-line ${cls}">${escHtml(l)}</div>`).join('');
    setTimeout(() => { body.scrollTop = body.scrollHeight; }, 0);
  }

  const overlay = document.getElementById('rbs-detail-overlay');
  overlay.classList.add('open');
}

function rbsCloseDetail(e) {
  if (e && e.target !== document.getElementById('rbs-detail-overlay')) return;
  document.getElementById('rbs-detail-overlay').classList.remove('open');
}

// ---- Rally Bot Functions ----
let rallyAllRoutes = [];      // full unfiltered dataset
let rallyLoaded = false;

// Load rally bot data on startup (default window)
loadRallyBotData();

function loadRallyBotData() {
  if (rallyLoaded) { applyRallyFilters(); return; }
  document.getElementById('rally-routes-container').innerHTML =
    '<div class="loading-message">Loading routes…</div>';

  fetch('/api/rally-bot/routes')
    .then(r => r.json())
    .then(data => {
      if (!data.success) {
        document.getElementById('rally-routes-container').innerHTML =
          `<div class="loading-message">Error: ${data.error}</div>`;
        return;
      }
      rallyAllRoutes = data.routes || [];
      rallyLoaded = true;
      buildRallyFilterOptions();
      applyRallyFilters();
    })
    .catch(() => {
      document.getElementById('rally-routes-container').innerHTML =
        '<div class="loading-message">Failed to load routes</div>';
    });
}

// Build filter options from the FULL unfiltered dataset, called once after load
function buildRallyFilterOptions() {
  const origins  = new Set();
  const dests    = new Set();
  const models   = new Set();

  rallyAllRoutes.forEach(route => {
    origins.add(route.origin);
    (route.returns || []).forEach(ret => {
      dests.add(ret.destination);
      if (ret.model_name && ret.model_name.toLowerCase() !== 'unknown') models.add(ret.model_name.toLowerCase());
    });
  });

  buildMultiSelect('ms-origin-options', [...origins].sort(),  new Set());
  buildMultiSelect('ms-dest-options',   [...dests].sort(),    new Set());
  buildMultiSelect('ms-model-options',  [...models].sort(),   new Set());
}

// Filter client-side from the full cache
function parseDMY(str) {
  // "DD/MM/YYYY" -> Date
  const [d, m, y] = str.split('/');
  return new Date(+y, +m - 1, +d);
}

function fmtDMY(date) {
  if (!date) return '';
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

// ---- Calendar state ----
let calViewYear  = new Date().getFullYear();
let calViewMonth = new Date().getMonth();
let calPickStart = null;   // JS Date, pending (not yet applied)
let calPickEnd   = null;
let calApplied   = { start: null, end: null };  // what's actually filtering

function toggleCalendar(event) {
  event.stopPropagation();
  const wrapper = document.getElementById('cal-wrapper');
  const isOpen  = wrapper.classList.contains('open');
  document.querySelectorAll('.ms-wrapper.open').forEach(w => w.classList.remove('open'));
  if (!isOpen) {
    wrapper.classList.add('open');
    renderCal();
  }
}

function calShiftMonth(delta, event) {
  event.stopPropagation();
  calViewMonth += delta;
  if (calViewMonth > 11) { calViewMonth = 0;  calViewYear++; }
  if (calViewMonth < 0)  { calViewMonth = 11; calViewYear--; }
  renderCal();
}

function renderCal() {
  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  document.getElementById('cal-month-label').textContent =
    `${MONTHS[calViewMonth]} ${calViewYear}`;

  const grid = document.getElementById('cal-days');
  grid.innerHTML = '';

  // First weekday of the month (Mon=0)
  const firstDay = new Date(calViewYear, calViewMonth, 1).getDay();
  const offset   = (firstDay === 0) ? 6 : firstDay - 1;
  const daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();

  // Empty cells before first day
  for (let i = 0; i < offset; i++) {
    const blank = document.createElement('span');
    blank.className = 'cal-day cal-day-blank';
    grid.appendChild(blank);
  }

  const today = new Date(); today.setHours(0,0,0,0);

  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(calViewYear, calViewMonth, day);
    const btn = document.createElement('button');
    btn.className = 'cal-day';
    btn.textContent = day;
    btn.onclick = (e) => { e.stopPropagation(); calDayClick(d); };

    if (d < today) btn.classList.add('cal-day-past');

    // Highlight logic
    const s = calPickStart, e2 = calPickEnd;
    if (s && sameDay(d, s)) btn.classList.add('cal-day-start');
    if (e2 && sameDay(d, e2)) btn.classList.add('cal-day-end');
    if (s && e2 && d > s && d < e2) btn.classList.add('cal-day-range');
    if (s && !e2 && sameDay(d, s)) btn.classList.add('cal-day-start', 'cal-day-end');

    grid.appendChild(btn);
  }

  // Selection text
  const txt = document.getElementById('cal-selection-txt');
  if (calPickStart && calPickEnd) {
    txt.textContent = `${fmtDMY(calPickStart)} → ${fmtDMY(calPickEnd)}`;
  } else if (calPickStart) {
    txt.textContent = `${fmtDMY(calPickStart)} → pick end`;
  } else {
    txt.textContent = '';
  }
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}

function calDayClick(date) {
  if (!calPickStart || (calPickStart && calPickEnd)) {
    // Start fresh
    calPickStart = date;
    calPickEnd   = null;
  } else {
    // Second click: assign start/end in order
    if (date < calPickStart) {
      calPickEnd   = calPickStart;
      calPickStart = date;
    } else {
      calPickEnd = date;
    }
  }
  renderCal();
}

function calApply(event) {
  event.stopPropagation();
  calApplied.start = calPickStart;
  calApplied.end   = calPickEnd;

  const label = document.getElementById('cal-label');
  if (calApplied.start && calApplied.end) {
    label.textContent = `${fmtDMY(calApplied.start)} → ${fmtDMY(calApplied.end)}`;
    label.classList.add('has-selection');
  } else if (calApplied.start) {
    label.textContent = `From ${fmtDMY(calApplied.start)}`;
    label.classList.add('has-selection');
  } else {
    label.textContent = 'Any date';
    label.classList.remove('has-selection');
  }

  document.getElementById('cal-wrapper').classList.remove('open');
  applyRallyFilters();
}

function calClear(event) {
  event.stopPropagation();
  calPickStart = null;
  calPickEnd   = null;
  renderCal();
}

function calReset() {
  calPickStart = null; calPickEnd = null;
  calApplied   = { start: null, end: null };
  const label = document.getElementById('cal-label');
  if (label) { label.textContent = 'Any date'; label.classList.remove('has-selection'); }
}

function applyRallyFilters() {
  const selOrigins = new Set(getMsSelected('ms-origin-options'));
  const selDests   = new Set(getMsSelected('ms-dest-options'));
  const selModels  = new Set(getMsSelected('ms-model-options'));
  const filterStart = calApplied.start;
  const filterEnd   = calApplied.end;

  let totalReturns = 0;
  const filtered = [];

  rallyAllRoutes.forEach(route => {
    if (selOrigins.size && !selOrigins.has(route.origin)) return;

    const returns = (route.returns || []).reduce((acc, ret) => {
      if ((ret.model_name || '').toLowerCase() === 'unknown') return acc;
      if (selDests.size  && !selDests.has(ret.destination))  return acc;
      if (selModels.size && !selModels.has((ret.model_name || '').toLowerCase()))  return acc;

      // Date filter: keep only date ranges that overlap the selected window
      let dates = ret.available_dates || [];
      if (filterStart || filterEnd) {
        dates = dates.filter(dr => {
          const routeStart = parseDMY(dr.startDate);
          const routeEnd   = parseDMY(dr.endDate);
          const afterFilterStart = filterStart ? routeEnd   >= filterStart : true;
          const beforeFilterEnd  = filterEnd   ? routeStart <= filterEnd   : true;
          return afterFilterStart && beforeFilterEnd;
        });
        if (!dates.length) return acc;
      }

      acc.push({ ...ret, available_dates: dates });
      return acc;
    }, []);

    if (returns.length) {
      filtered.push({ ...route, returns });
      totalReturns += returns.length;
    }
  });

  document.getElementById('rally-total-routes').textContent  = filtered.length;
  document.getElementById('rally-total-returns').textContent = totalReturns;
  displayRallyRoutes(filtered);
}

// alias used by date inputs
function updateRallyRoutes() { applyRallyFilters(); }

function buildMultiSelect(optionsId, items, currentSelected) {
  const container = document.getElementById(optionsId);
  if (!container) return;
  container.innerHTML = '';
  items.forEach(item => {
    const label = document.createElement('label');
    label.className = 'ms-option' + (currentSelected.has(item) ? ' checked' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = item;
    cb.checked = currentSelected.has(item);
    cb.addEventListener('change', () => {
      label.classList.toggle('checked', cb.checked);
      updateMsTriggerLabel(container.closest('.ms-wrapper'));
      applyRallyFilters();
    });

    label.appendChild(cb);
    label.appendChild(document.createTextNode('\u00a0' + item));
    container.appendChild(label);
  });
  updateMsTriggerLabel(container.closest('.ms-wrapper'));
}

function getMsSelected(optionsId) {
  const container = document.getElementById(optionsId);
  if (!container) return [];
  return Array.from(container.querySelectorAll('input[type=checkbox]:checked')).map(cb => cb.value);
}

function updateMsTriggerLabel(wrapper) {
  if (!wrapper) return;
  const checked = wrapper.querySelectorAll('input[type=checkbox]:checked');
  const label   = wrapper.querySelector('.ms-label');
  const placeholder = wrapper.dataset.placeholder || 'All';
  if (checked.length === 0) {
    label.textContent = placeholder;
    label.classList.remove('has-selection');
  } else if (checked.length === 1) {
    label.textContent = checked[0].value;
    label.classList.add('has-selection');
  } else {
    label.textContent = `${checked.length} selected`;
    label.classList.add('has-selection');
  }
}

function toggleMultiSelect(wrapperId, event) {
  event.stopPropagation();
  const wrapper = document.getElementById(wrapperId);
  const isOpen  = wrapper.classList.contains('open');
  document.querySelectorAll('.ms-wrapper.open').forEach(w => w.classList.remove('open'));
  if (!isOpen) {
    wrapper.classList.add('open');
    const search = wrapper.querySelector('.ms-search');
    if (search) { search.value = ''; filterMsPanel(search); search.focus(); }
  }
}

function filterMsPanel(input) {
  const term = input.value.toLowerCase();
  input.closest('.ms-panel').querySelectorAll('.ms-option').forEach(opt => {
    opt.style.display = opt.textContent.toLowerCase().includes(term) ? '' : 'none';
  });
}

document.addEventListener('click', () => {
  document.querySelectorAll('.ms-wrapper.open').forEach(w => w.classList.remove('open'));
});

function clearRallyFilters() {
  ['ms-origin-options','ms-dest-options','ms-model-options'].forEach(id => {
    const cont = document.getElementById(id);
    if (!cont) return;
    cont.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false; });
    cont.querySelectorAll('.ms-option').forEach(o => o.classList.remove('checked'));
    updateMsTriggerLabel(cont.closest('.ms-wrapper'));
  });
  calReset();
  applyRallyFilters();
}

function displayRallyRoutes(routes) {
  const container = document.getElementById('rally-routes-container');

  if (routes.length === 0) {
    container.innerHTML = '<div class="loading-message">No routes found matching your filters</div>';
    return;
  }

  // Group by origin + destination so date ranges are merged under one card
  const grouped = new Map();
  routes.forEach(route => {
    route.returns.forEach(ret => {
      const key = `${route.origin}||${ret.destination}`;
      if (!grouped.has(key)) {
        grouped.set(key, { origin: route.origin, destination: ret.destination, rows: [] });
      }
      const model = (ret.model_name || '').toLowerCase();
      const image = ret.model_image || '';
      ret.available_dates.forEach(dateRange => {
        grouped.get(key).rows.push({ model, image, dateRange, url: ret.roadsurfer_url });
      });
    });
  });

  let html = '';
  // Sort groups by their earliest date, then sort rows within each group
  [...grouped.values()]
    .map(g => {
      g.rows.sort((a, b) => parseDMY(a.dateRange.startDate) - parseDMY(b.dateRange.startDate));
      return g;
    })
    .sort((a, b) => parseDMY(a.rows[0].dateRange.startDate) - parseDMY(b.rows[0].dateRange.startDate))
    .forEach(({ origin, destination, rows }) => {
    const dateRows = rows.map(({ model, image, dateRange, url }) => `
      <div class="rc-date-row">
        ${image ? `<img class="rc-van-img" src="/api/rally-bot/assets/${image}" alt="${model}" title="${model}" loading="lazy">` : ''}
        ${model ? `<span class="rc-model">${model}</span>` : ''}
        <span class="rc-dates">${dateRange.startDate}<span class="rc-datesep">→</span>${dateRange.endDate}</span>
        <a href="${url}" target="_blank" class="rc-book">Book →</a>
      </div>`).join('');

    html += `
    <div class="route-card">
      <div class="rc-header">
        <span class="rc-origin">${origin}</span>
        <span class="rc-arrow">→</span>
        <span class="rc-dest">${destination}</span>
      </div>
      <div class="rc-dates-list">${dateRows}</div>
    </div>`;
  });

  container.innerHTML = `<div class="route-list">${html}</div>`;
}


/* ================================================================
   TODO LIST
   ================================================================ */

let todoItems = [];
let todoArchiveVisible = false;
let todoDragSrcId = null;
let todoDragOverId = null;

// ---- Data loading ----

async function loadTodos() {
  try {
    const res = await fetch('/api/todos');
    todoItems = await res.json();
    renderTodos();
  } catch (e) {
    console.error('Error loading todos:', e);
  }
}

// ---- Rendering ----

function renderTodos() {
  const openList    = document.getElementById('todo-open-list');
  const archiveList = document.getElementById('todo-archive-list');
  const archiveCnt  = document.getElementById('todo-archive-count');
  if (!openList) return;

  const openItems     = todoItems.filter(t => !t.completed).sort((a, b) => (a.order || 0) - (b.order || 0));
  const archivedItems = todoItems.filter(t =>  t.completed).sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));

  archiveCnt.textContent = archivedItems.length;

  // ---- open items ----
  if (openItems.length === 0) {
    openList.innerHTML = '<div class="todo-empty">No open items. Click "+ Add Item" to create one.</div>';
  } else {
    openList.innerHTML = openItems.map(item => {
      const dueClass = item.due_date ? todoDueClass(item.due_date) : '';
      const dueTxt   = item.due_date ? todoFormatDue(item.due_date) : '';
      const descTxt  = item.description
        ? `<div class="todo-item-desc">${escHtml(item.description.substring(0, 90))}${item.description.length > 90 ? '…' : ''}</div>`
        : '';
      const dueBadge = dueTxt
        ? `<div class="todo-item-due ${dueClass}">${dueTxt}</div>`
        : '';
      return `
        <div class="todo-item" draggable="true" data-id="${item.id}"
             ondragstart="todoDragStart(event)"
             ondragover="todoDragOver(event)"
             ondrop="todoDrop(event)"
             ondragend="todoDragEnd(event)">
          <div class="todo-drag-handle" title="Drag to reorder">⠿</div>
          <button class="todo-done-btn" onclick="completeTodo('${item.id}')" title="Mark as done">○</button>
          <div class="todo-item-main" onclick="openTodoModal('${item.id}')">
            <div class="todo-item-title">${escHtml(item.title)}</div>
            ${dueBadge}${descTxt}
          </div>
        </div>`;
    }).join('');
  }

  // ---- archived items ----
  if (archivedItems.length === 0) {
    archiveList.innerHTML = '<div class="todo-empty">No archived items.</div>';
  } else {
    archiveList.innerHTML = archivedItems.map(item => `
      <div class="todo-archive-item" data-id="${item.id}">
        <div class="todo-archive-check">✓</div>
        <div class="todo-item-main" onclick="openTodoModal('${item.id}')">
          <div class="todo-item-title todo-item-title-done">${escHtml(item.title)}</div>
          ${item.completed_at ? `<div class="todo-item-due">${todoFormatDate(item.completed_at)}</div>` : ''}
        </div>
        <button class="todo-reopen-btn" onclick="reopenTodo('${item.id}')" title="Reopen">↩</button>
        <button class="todo-del-btn"    onclick="deleteTodo('${item.id}')"  title="Delete permanently">✕</button>
      </div>`).join('');
  }
}

function toggleTodoArchive() {
  todoArchiveVisible = !todoArchiveVisible;
  document.getElementById('todo-archive-list').style.display = todoArchiveVisible ? 'flex' : 'none';
  document.getElementById('todo-archive-chevron').textContent = todoArchiveVisible ? '▴' : '▾';
}

// ---- Due-date helpers ----

function todoDueClass(dueDate) {
  const diff = (new Date(dueDate) - new Date()) / 86400000;
  if (diff < 0) return 'due-overdue';
  if (diff < 2) return 'due-soon';
  return '';
}

function todoFormatDue(dueDate) {
  const due  = new Date(dueDate);
  const diff = Math.floor((due - new Date()) / 86400000);
  if (diff < 0)  return `Overdue (${due.toLocaleDateString()})`;
  if (diff === 0) return 'Due today';
  if (diff === 1) return 'Due tomorrow';
  return `Due ${due.toLocaleDateString()}`;
}

function todoFormatDate(isoStr) {
  return isoStr ? new Date(isoStr).toLocaleDateString() : '';
}

function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- Modal ----

function openTodoModal(id) {
  const overlay   = document.getElementById('todo-modal-overlay');
  const heading   = document.getElementById('todo-modal-heading');
  const deleteBtn = document.getElementById('todo-modal-delete-btn');

  document.getElementById('todo-modal-id').value  = id || '';
  document.getElementById('todo-modal-title-input').style.borderColor = '';

  if (id) {
    const item = todoItems.find(t => t.id === id);
    if (!item) return;
    heading.textContent = 'Edit Item';
    document.getElementById('todo-modal-title-input').value = item.title        || '';
    document.getElementById('todo-modal-due-input').value   = item.due_date     || '';
    document.getElementById('todo-modal-desc-input').value  = item.description  || '';
    document.getElementById('todo-modal-notes-input').value = item.notes        || '';
    deleteBtn.style.display = 'inline-flex';
  } else {
    heading.textContent = 'New Item';
    document.getElementById('todo-modal-title-input').value = '';
    document.getElementById('todo-modal-due-input').value   = '';
    document.getElementById('todo-modal-desc-input').value  = '';
    document.getElementById('todo-modal-notes-input').value = '';
    deleteBtn.style.display = 'none';
  }

  overlay.classList.add('open');
  setTimeout(() => document.getElementById('todo-modal-title-input').focus(), 60);
}

function closeTodoModal() {
  document.getElementById('todo-modal-overlay').classList.remove('open');
}

function closeTodoModalOverlay(event) {
  if (event.target === document.getElementById('todo-modal-overlay')) closeTodoModal();
}

async function saveTodoModal() {
  const id    = document.getElementById('todo-modal-id').value;
  const title = document.getElementById('todo-modal-title-input').value.trim();

  if (!title) {
    const inp = document.getElementById('todo-modal-title-input');
    inp.style.borderColor = 'var(--bad)';
    inp.focus();
    return;
  }

  const payload = {
    title,
    due_date:    document.getElementById('todo-modal-due-input').value,
    description: document.getElementById('todo-modal-desc-input').value,
    notes:       document.getElementById('todo-modal-notes-input').value,
  };

  try {
    let res;
    if (id) {
      res = await fetch(`/api/todos/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
    } else {
      res = await fetch('/api/todos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
    }
    const saved = await res.json();
    if (id) {
      const idx = todoItems.findIndex(t => t.id === id);
      if (idx >= 0) todoItems[idx] = saved;
    } else {
      todoItems.push(saved);
    }
    renderTodos();
    closeTodoModal();
  } catch (e) {
    console.error('Error saving todo:', e);
  }
}

async function deleteTodoFromModal() {
  const id = document.getElementById('todo-modal-id').value;
  if (!id) return;
  if (!confirm('Permanently delete this item?')) return;
  await deleteTodo(id);
  closeTodoModal();
}

// ---- Item actions ----

async function completeTodo(id) {
  try {
    const res     = await fetch(`/api/todos/${id}/complete`, { method: 'POST' });
    const updated = await res.json();
    const idx     = todoItems.findIndex(t => t.id === id);
    if (idx >= 0) todoItems[idx] = updated;
    renderTodos();
  } catch (e) { console.error('Error completing todo:', e); }
}

async function reopenTodo(id) {
  try {
    const res     = await fetch(`/api/todos/${id}/reopen`, { method: 'POST' });
    const updated = await res.json();
    const idx     = todoItems.findIndex(t => t.id === id);
    if (idx >= 0) todoItems[idx] = updated;
    renderTodos();
  } catch (e) { console.error('Error reopening todo:', e); }
}

async function deleteTodo(id) {
  try {
    await fetch(`/api/todos/${id}`, { method: 'DELETE' });
    todoItems = todoItems.filter(t => t.id !== id);
    renderTodos();
  } catch (e) { console.error('Error deleting todo:', e); }
}

// ---- Drag and drop ----

function todoDragStart(event) {
  todoDragSrcId = event.currentTarget.dataset.id;
  event.currentTarget.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
}

function todoDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const el = event.currentTarget;
  document.querySelectorAll('.todo-item').forEach(i => i.classList.remove('drag-over'));
  if (el.dataset.id !== todoDragSrcId) el.classList.add('drag-over');
  todoDragOverId = el.dataset.id;
}

function todoDrop(event) {
  event.preventDefault();
  if (!todoDragSrcId || todoDragSrcId === todoDragOverId) return;

  const openItems = todoItems
    .filter(t => !t.completed)
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  const srcIdx = openItems.findIndex(t => t.id === todoDragSrcId);
  const dstIdx = openItems.findIndex(t => t.id === todoDragOverId);
  if (srcIdx < 0 || dstIdx < 0) return;

  const [moved] = openItems.splice(srcIdx, 1);
  openItems.splice(dstIdx, 0, moved);
  openItems.forEach((item, i) => { item.order = i; });

  fetch('/api/todos/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: openItems.map(t => t.id) })
  }).catch(e => console.error('Error reordering todos:', e));

  renderTodos();
}

function todoDragEnd() {
  document.querySelectorAll('.todo-item').forEach(i => i.classList.remove('dragging', 'drag-over'));
  todoDragSrcId  = null;
  todoDragOverId = null;
}

// Keyboard shortcut: Enter saves, Escape closes
document.addEventListener('keydown', (e) => {
  // Todo modal shortcuts
  const todoOverlay = document.getElementById('todo-modal-overlay');
  if (todoOverlay && todoOverlay.classList.contains('open')) {
    if (e.key === 'Escape') { e.preventDefault(); closeTodoModal(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveTodoModal(); }
    return;
  }
  // Admin modal shortcut
  const adminOverlay = document.getElementById('admin-modal-overlay');
  if (adminOverlay && adminOverlay.classList.contains('open')) {
    if (e.key === 'Escape') { e.preventDefault(); closeAdminModal(); }
  }
  // RBS detail modal shortcut
  const rbsOverlay = document.getElementById('rbs-detail-overlay');
  if (rbsOverlay && rbsOverlay.classList.contains('open')) {
    if (e.key === 'Escape') { e.preventDefault(); rbsOverlay.classList.remove('open'); }
  }
});

// ---- Admin state initialisation (runs on page load) ----
// Hide admin nav items immediately (before any async check)
applyAdminState(false);

if (adminToken) {
  // Verify token is still valid on the server
  fetch('/api/admin/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: adminToken })
  })
  .then(r => {
    if (r.ok) {
      applyAdminState(true);
    } else {
      adminToken = null;
      sessionStorage.removeItem('adminToken');
      applyAdminState(false);
    }
  })
  .catch(() => { applyAdminState(false); });
}
