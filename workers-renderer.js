let selectedUtilDevices = new Set();
let allDevices = [];

// Debug visualization state
let showTouchesEnabled = false;
let pointerLocationEnabled = false;

// ========== DEBUG CONSOLE ==========
console.log('=== WORKERS WINDOW INITIALIZING ===');
console.log('electronAPI available:', !!window.electronAPI);

// ========== DEBUG VISUALIZATION ==========

function showDebugStatus(message, type = 'info') {
    const statusEl = document.getElementById('debug-status');
    if (!statusEl) return;

    const colors = {
        info: '#3b82f6',
        success: '#22c55e',
        warning: '#fb923c',
        error: '#ef4444'
    };

    statusEl.style.display = 'block';
    statusEl.style.borderLeft = `3px solid ${colors[type]}`;
    statusEl.innerHTML = message;

    if (type === 'success') {
        setTimeout(() => {
            statusEl.style.display = 'none';
        }, 3000);
    }
}

async function toggleShowTouches() {
    showTouchesEnabled = !showTouchesEnabled;
    const btn = document.getElementById('show-touches-btn');

    showDebugStatus('🔄 Updating show touches...', 'info');

    try {
        const result = await window.electronAPI.toggleShowTouches(showTouchesEnabled);

        if (result.success) {
            btn.textContent = showTouchesEnabled ? '🔵 Show Touches: ON' : '⚫ Show Touches: OFF';
            btn.style.background = showTouchesEnabled ?
                'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)' :
                'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)';

            showDebugStatus(
                showTouchesEnabled ? '✅ Show touches enabled! Blue dots will appear when tapping.' : '⚫ Show touches disabled.',
                'success'
            );
        }
    } catch (error) {
        showDebugStatus(`❌ Error: ${error.message}`, 'error');
    }
}

async function togglePointerLocation() {
    pointerLocationEnabled = !pointerLocationEnabled;
    const btn = document.getElementById('pointer-location-btn');

    showDebugStatus('🔄 Updating pointer location...', 'info');

    try {
        const result = await window.electronAPI.togglePointerLocation(pointerLocationEnabled);

        if (result.success) {
            btn.textContent = pointerLocationEnabled ? '🎯 Pointer Location: ON' : '⚫ Pointer Location: OFF';
            btn.style.background = pointerLocationEnabled ?
                'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)' :
                'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)';

            showDebugStatus(
                pointerLocationEnabled ? '✅ Pointer location enabled! Crosshair will show coordinates.' : '⚫ Pointer location disabled.',
                'success'
            );
        }
    } catch (error) {
        showDebugStatus(`❌ Error: ${error.message}`, 'error');
    }
}

// ========== DEVICE UTILITIES ==========

async function loadDevicesForUtil() {
    console.log('Loading devices for utilities...');

    try {
        const result = await window.electronAPI.getDevices();
        console.log('Device result:', result);

        if (result.success && result.devices) {
            allDevices = result.devices;
            console.log(`Loaded ${allDevices.length} devices`);
            renderUtilDeviceSelector();
        } else {
            console.error('No devices in result');
        }
    } catch (error) {
        console.error('Error loading devices:', error);
    }
}

function renderUtilDeviceSelector() {
    const container = document.getElementById('util_devices');
    const countEl = document.getElementById('util_count');

    if (!container) {
        console.error('Container #util_devices not found!');
        return;
    }

    console.log(`Rendering ${allDevices.length} devices...`);

    container.innerHTML = '';
    if (countEl) countEl.textContent = selectedUtilDevices.size;

    if (allDevices.length === 0) {
        container.innerHTML = '<div style="color: #64748b; padding: 20px; text-align: center;">No devices available</div>';
        return;
    }

    allDevices.forEach(device => {
        const card = document.createElement('div');
        card.className = 'device-card';

        const span = document.createElement('span');
        span.textContent = device.device;
        card.appendChild(span);

        if (selectedUtilDevices.has(device.device)) {
            card.classList.add('selected');
        }

        card.onclick = () => {
            if (selectedUtilDevices.has(device.device)) {
                selectedUtilDevices.delete(device.device);
            } else {
                selectedUtilDevices.add(device.device);
            }
            renderUtilDeviceSelector();
        };

        container.appendChild(card);
    });

    console.log(`Rendered ${allDevices.length} device cards`);
}

function selectAllDevices() {
    allDevices.forEach(device => {
        selectedUtilDevices.add(device.device);
    });
    renderUtilDeviceSelector();
}

function deselectAllDevices() {
    selectedUtilDevices.clear();
    renderUtilDeviceSelector();
}

function showUtilStatus(message, type = 'info') {
    const statusEl = document.getElementById('util-status');
    if (!statusEl) return;

    const colors = {
        info: '#3b82f6',
        success: '#22c55e',
        warning: '#fb923c',
        error: '#ef4444'
    };

    statusEl.style.display = 'block';
    statusEl.style.borderLeft = `3px solid ${colors[type]}`;
    statusEl.innerHTML = message;

    if (type === 'success') {
        setTimeout(() => {
            statusEl.style.display = 'none';
        }, 5000);
    }
}

async function openTikTokOnDevices() {
    const deviceIds = Array.from(selectedUtilDevices);

    if (deviceIds.length === 0) {
        return alert('Please select at least one device!');
    }

    if (!confirm(`Open TikTok on ${deviceIds.length} device(s)?`)) {
        return;
    }

    showUtilStatus('🔄 Opening TikTok on devices...', 'info');

    try {
        const result = await window.electronAPI.openTikTokBulk(deviceIds);

        if (result.success) {
            const successCount = result.results.filter(r => r.success).length;
            const failCount = result.results.filter(r => !r.success).length;

            let message = `<strong>✅ TikTok opened successfully!</strong><br>`;
            message += `Success: ${successCount} | Failed: ${failCount}`;

            if (failCount > 0) {
                message += '<br><div style="margin-top: 8px; font-size: 12px;">Failed devices:<br>';
                result.results.filter(r => !r.success).forEach(r => {
                    message += `• ${r.deviceId}: ${r.error}<br>`;
                });
                message += '</div>';
            }

            showUtilStatus(message, failCount > 0 ? 'warning' : 'success');
        } else {
            showUtilStatus(`❌ Failed: ${result.error}`, 'error');
        }
    } catch (error) {
        showUtilStatus(`❌ Error: ${error.message}`, 'error');
    }
}

async function closeTikTokOnDevices() {
    const deviceIds = Array.from(selectedUtilDevices);

    if (deviceIds.length === 0) {
        return alert('Please select at least one device!');
    }

    if (!confirm(`Close TikTok on ${deviceIds.length} device(s)?`)) {
        return;
    }

    showUtilStatus('🔄 Closing TikTok on devices...', 'info');

    try {
        const result = await window.electronAPI.closeTikTokBulk(deviceIds);

        if (result.success) {
            const successCount = result.results.filter(r => r.success).length;
            const failCount = result.results.filter(r => !r.success).length;

            let message = `<strong>✅ TikTok closed successfully!</strong><br>`;
            message += `Success: ${successCount} | Failed: ${failCount}`;

            if (failCount > 0) {
                message += '<br><div style="margin-top: 8px; font-size: 12px;">Failed devices:<br>';
                result.results.filter(r => !r.success).forEach(r => {
                    message += `• ${r.deviceId}: ${r.error}<br>`;
                });
                message += '</div>';
            }

            showUtilStatus(message, failCount > 0 ? 'warning' : 'success');
        } else {
            showUtilStatus(`❌ Failed: ${result.error}`, 'error');
        }
    } catch (error) {
        showUtilStatus(`❌ Error: ${error.message}`, 'error');
    }
}

// ========== WORKER MANAGEMENT ==========

async function refreshWorkers() {
    try {
        const result = await window.electronAPI.getWorkers();
        if (result.success) {
            renderWorkers(result.workers);
        }
    } catch (error) {
        console.error('Error refreshing workers:', error);
    }
}

function renderWorkers(workers) {
    const container = document.getElementById('worker-list');
    const countEl = document.getElementById('worker-count');

    if (!container || !countEl) return;

    countEl.textContent = workers.length;

    // Group by status
    const groups = {
        idle: workers.filter(w => w.status === 'idle' && !w.manuallyPaused),
        busy: workers.filter(w => w.status === 'busy'),
        paused: workers.filter(w => w.manuallyPaused || w.status === 'paused')
    };

    // Stats cards
    const statsHtml = `
    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px;">
      <div style="background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 12px; padding: 16px; text-align: center;">
        <div style="font-size: 32px; font-weight: 700; color: #22c55e;">${groups.idle.length}</div>
        <div style="font-size: 14px; color: #22c55e; margin-top: 4px;">✅ Idle Workers</div>
      </div>
      <div style="background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 12px; padding: 16px; text-align: center;">
        <div style="font-size: 32px; font-weight: 700; color: #3b82f6;">${groups.busy.length}</div>
        <div style="font-size: 14px; color: #3b82f6; margin-top: 4px;">⚙️ Busy Workers</div>
      </div>
      <div style="background: rgba(251, 146, 60, 0.1); border: 1px solid rgba(251, 146, 60, 0.3); border-radius: 12px; padding: 16px; text-align: center;">
        <div style="font-size: 32px; font-weight: 700; color: #fb923c;">${groups.paused.length}</div>
        <div style="font-size: 14px; color: #fb923c; margin-top: 4px;">⏸️ Paused Workers</div>
      </div>
    </div>
  `;

    // Bulk actions
    const bulkActionsHtml = `
    <div style="display: flex; gap: 12px; margin-bottom: 20px;">
      <button onclick="pauseAllWorkers()" style="flex: 1; background: linear-gradient(135deg, #fb923c 0%, #f97316 100%);">
        ⏸️ Pause All Workers
      </button>
      <button onclick="resumeAllWorkers()" style="flex: 1; background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);">
        ▶ Resume All Workers
      </button>
    </div>
  `;

    container.innerHTML = statsHtml + bulkActionsHtml;

    if (workers.length === 0) {
        container.innerHTML += '<p style="color: #64748b; text-align: center; padding: 40px 0;">No workers available</p>';
        return;
    }

    // Render worker cards
    workers.forEach(worker => {
        const card = document.createElement('div');
        card.className = `worker-card status-${worker.status}`;

        const statusColor = worker.manuallyPaused ? '#fb923c' :
            worker.status === 'busy' ? '#3b82f6' : '#22c55e';
        const statusText = worker.manuallyPaused ? 'PAUSED' : worker.status.toUpperCase();

        let taskInfo = '';
        if (worker.currentTask) {
            taskInfo = `
        <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(167, 139, 250, 0.2);">
          <div style="font-size: 12px; color: #64748b; margin-bottom: 4px;">Current Task:</div>
          <div style="font-size: 12px; font-family: 'Courier New', monospace; color: #a5b4fc;">${worker.currentTask.id}</div>
          <div style="font-size: 11px; color: #64748b; margin-top: 4px;">Job: ${worker.currentJobId}</div>
        </div>
      `;
        }

        card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <strong style="font-size: 15px;">📱 ${worker.deviceId}</strong>
        <span class="status" style="background: ${statusColor}33; color: ${statusColor};">${statusText}</span>
      </div>
      ${taskInfo}
      <div class="worker-controls">
        ${worker.manuallyPaused ?
                `<button onclick="resumeWorker('${worker.deviceId}')" style="width: 100%; background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);">▶ Resume Worker</button>` :
                `<button onclick="pauseWorker('${worker.deviceId}')" style="width: 100%; background: linear-gradient(135deg, #fb923c 0%, #f97316 100%);">⏸ Pause Worker</button>`
            }
      </div>
    `;
        container.appendChild(card);
    });
}

async function pauseWorker(deviceId) {
    try {
        const result = await window.electronAPI.pauseWorker(deviceId);
        if (result.success) {
            refreshWorkers();
        }
    } catch (error) {
        console.error('Error pausing worker:', error);
    }
}

async function resumeWorker(deviceId) {
    try {
        const result = await window.electronAPI.resumeWorker(deviceId);
        if (result.success) {
            refreshWorkers();
        }
    } catch (error) {
        console.error('Error resuming worker:', error);
    }
}

async function pauseAllWorkers() {
    if (!confirm('Pause all workers? They will stop taking new tasks.')) return;

    try {
        const result = await window.electronAPI.getWorkers();
        if (result.success) {
            for (const worker of result.workers) {
                if (!worker.manuallyPaused) {
                    await window.electronAPI.pauseWorker(worker.deviceId);
                }
            }
            refreshWorkers();
        }
    } catch (error) {
        console.error('Error pausing all workers:', error);
    }
}

async function resumeAllWorkers() {
    if (!confirm('Resume all workers?')) return;

    try {
        const result = await window.electronAPI.getWorkers();
        if (result.success) {
            for (const worker of result.workers) {
                if (worker.manuallyPaused) {
                    await window.electronAPI.resumeWorker(worker.deviceId);
                }
            }
            refreshWorkers();
        }
    } catch (error) {
        console.error('Error resuming all workers:', error);
    }
}

// Listen to updates
if (window.electronAPI.onWorkerUpdate) {
    window.electronAPI.onWorkerUpdate((data) => {
        refreshWorkers();
    });
}

// ========== INITIALIZATION ==========

// Init on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM ready, initializing...');
    loadDevicesForUtil();
    refreshWorkers();
});

// Also try after window load (fallback)
window.addEventListener('load', () => {
    console.log('Window loaded, ensuring devices are loaded...');
    setTimeout(() => {
        if (allDevices.length === 0) {
            console.log('Devices not loaded, retrying...');
            loadDevicesForUtil();
        }
    }, 500);
});

// Auto-refresh workers every 2 seconds
setInterval(() => {
    refreshWorkers();
}, 2000);

console.log('=== WORKERS WINDOW INITIALIZED ===');
