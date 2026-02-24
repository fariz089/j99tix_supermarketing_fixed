// ============================================
// J99Tix Device Monitor v4 - REALTIME Streaming
// ============================================
// Architecture:
// - Main process runs ScrcpyStreamer (1 persistent capture loop per device)
// - Frames are PUSHED to renderer via IPC 'stream-frame' event
// - No more polling! Frames arrive as fast as each device can produce them
// - Fallback to legacy batch polling if streaming fails
// ============================================

let allDevices = [];
let deviceStatuses = new Map();
let selectedDevices = new Set();
let selectMode = false;
let currentFilter = 'all';
let refreshTimer = null;
let refreshInterval = 2000; // Only used in fallback polling mode
let logVisible = false;
let isCapturing = false;
let cycleCount = 0;

// Streaming state
let isStreaming = false;
let streamMode = 'polling'; // 'realtime' or 'polling'
let frameCounter = 0;
let streamStartTime = 0;

// Tags system
let deviceTags = {};
let activeTag = null;

// Command history
let cmdHistory = [];
const MAX_HISTORY = 50;

// Performance
let perfStats = { lastCycleTime: 0, avgCycleTime: 0, framesUpdated: 0, cacheHits: 0, fps: 0 };
let fpsCounter = 0;
let lastFpsCheck = Date.now();

// ============================================
// INITIALIZATION
// ============================================

async function init() {
    addLog('🚀 Initializing Device Monitor v4 (Realtime)...', 'info');
    await loadDevices();

    // Auto-reconnect: scan ADB devices and update online status
    await scanAndReconnectDevices();

    await loadWorkerStatuses();
    loadTagsFromStorage();
    renderDeviceGrid();
    renderDeviceNumberGrid();
    renderTags();
    await loadCachedFrames();

    // Setup streaming frame listener
    setupStreamListeners();

    // Setup mirror gesture listeners
    setupMirrorListeners();

    // Start realtime streaming by default
    await startRealtimeStreaming();

    // Periodic device health check (every 15s)
    setInterval(() => checkDeviceHealth(), 15000);

    if (window.electronAPI.onWorkerUpdate) {
        window.electronAPI.onWorkerUpdate((data) => updateWorkerStatus(data));
    }

    const psBrightness = document.getElementById('ps-brightness');
    if (psBrightness) {
        psBrightness.addEventListener('input', () => {
            document.getElementById('ps-brightness-val').textContent = psBrightness.value;
        });
    }

    addLog(`✅ Monitor ready — ${allDevices.length} devices`, 'success');
}

/**
 * Scan ADB devices and reconnect WiFi devices if needed
 * Called on init and when user clicks Reconnect
 */
async function scanAndReconnectDevices() {
    addLog('🔍 Scanning ADB devices...', 'info');
    showToast('🔍 Scanning devices...', 'info');

    try {
        // First try a quick scan
        const scanResult = await window.electronAPI.scanAdbDevices();
        if (scanResult.success) {
            const onlineSet = new Set(scanResult.onlineDevices);
            let onlineCount = 0;

            allDevices.forEach(d => {
                const status = deviceStatuses.get(d.device);
                if (status) {
                    const isOnline = onlineSet.has(d.device);
                    status.online = isOnline;
                    if (isOnline) onlineCount++;
                }
            });

            addLog(`🔍 Scan: ${onlineCount}/${allDevices.length} online`, onlineCount > 0 ? 'success' : 'error');

            // If many devices offline, auto-reconnect
            if (onlineCount < allDevices.length * 0.5) {
                addLog('📡 Many devices offline, reconnecting...', 'info');
                showToast('📡 Reconnecting devices...', 'info');

                const reconnResult = await window.electronAPI.reconnectDevices();
                if (reconnResult.success) {
                    const reconnSet = new Set(reconnResult.onlineDevices);
                    let newOnline = 0;
                    allDevices.forEach(d => {
                        const status = deviceStatuses.get(d.device);
                        if (status) {
                            const isOnline = reconnSet.has(d.device);
                            status.online = isOnline;
                            if (isOnline) newOnline++;
                        }
                    });
                    addLog(`📡 Reconnect: ${newOnline}/${allDevices.length} online`, newOnline > 0 ? 'success' : 'error');
                    showToast(`📡 ${newOnline} devices online`, newOnline > 0 ? 'success' : 'error');
                }
            } else {
                showToast(`🟢 ${onlineCount} devices online`, 'success');
            }

            renderDeviceGrid();
            updateStats();
        }
    } catch (e) {
        addLog(`Scan error: ${e.message}`, 'error');
    }
}

/**
 * Periodic device health check — rescan which devices are actually online
 */
async function checkDeviceHealth() {
    try {
        const scanResult = await window.electronAPI.scanAdbDevices();
        if (scanResult.success) {
            const onlineSet = new Set(scanResult.onlineDevices);
            let changed = false;

            allDevices.forEach(d => {
                const status = deviceStatuses.get(d.device);
                if (status) {
                    const wasOnline = status.online !== false;
                    const isOnline = onlineSet.has(d.device);
                    if (wasOnline !== isOnline) {
                        status.online = isOnline;
                        updateCardOnlineStatus(d.device, isOnline);
                        changed = true;
                    }
                }
            });

            if (changed) updateStats();
        }
    } catch (e) { /* silent */ }
}

/**
 * Manual reconnect button
 */
async function reconnectAllDevices() {
    showToast('📡 Reconnecting all devices...', 'info');
    addLog('📡 Manual reconnect triggered', 'info');

    try {
        const result = await window.electronAPI.reconnectDevices();
        if (result.success) {
            const onlineSet = new Set(result.onlineDevices);
            let onlineCount = 0;

            allDevices.forEach(d => {
                const status = deviceStatuses.get(d.device);
                if (status) {
                    const isOnline = onlineSet.has(d.device);
                    status.online = isOnline;
                    if (isOnline) onlineCount++;
                    updateCardOnlineStatus(d.device, isOnline);
                }
            });

            updateStats();
            showToast(`📡 ${onlineCount}/${allDevices.length} devices online`, onlineCount > 0 ? 'success' : 'error');
            addLog(`📡 Reconnect done: ${onlineCount}/${allDevices.length} online`, 'success');

            // Restart streaming for newly online devices
            if (onlineCount > 0 && streamMode === 'realtime') {
                await stopRealtimeStreaming();
                await startRealtimeStreaming();
            }
        }
    } catch (e) {
        showToast('Reconnect failed', 'error');
    }
}

/**
 * Setup listeners for push-based streaming frames from main process
 */
function setupStreamListeners() {
    // Listen for individual frames pushed from ScrcpyStreamer
    if (window.electronAPI.onStreamFrame) {
        window.electronAPI.onStreamFrame((frameData) => {
            handleStreamFrame(frameData);
        });
    }

    // Listen for device status changes
    if (window.electronAPI.onDeviceStatusChange) {
        window.electronAPI.onDeviceStatusChange((data) => {
            const status = deviceStatuses.get(data.deviceId);
            if (status && !data.online) {
                if (status.online !== false) {
                    status.online = false;
                    updateCardOnlineStatus(data.deviceId, false);
                    updateStats();
                }
            }
        });
    }
}

/**
 * Handle a single frame pushed from the streaming engine
 * This is called potentially hundreds of times per second across all devices
 */
function handleStreamFrame(frameData) {
    const { deviceId, data, mimeType, size, captureTime } = frameData;

    const status = deviceStatuses.get(deviceId);
    if (!status) return;

    const newSrc = `data:${mimeType};base64,${data}`;

    // Only update DOM if frame actually changed
    if (status.lastFrame !== newSrc) {
        status.lastFrame = newSrc;
        status.lastUpdate = Date.now();
        status.online = true;
        updateFrameDOM(deviceId, newSrc);
    }

    // FPS tracking
    fpsCounter++;
    frameCounter++;
    const now = Date.now();
    if (now - lastFpsCheck > 2000) {
        perfStats.fps = Math.round(fpsCounter / ((now - lastFpsCheck) / 1000));
        fpsCounter = 0;
        lastFpsCheck = now;

        // Update FPS display
        const fpsEl = document.getElementById('fps-display');
        if (fpsEl) fpsEl.textContent = `${perfStats.fps} fps`;
    }
}

/**
 * Start realtime streaming mode
 */
async function startRealtimeStreaming() {
    const deviceIds = allDevices
        .filter(d => (deviceStatuses.get(d.device) || {}).online !== false)
        .map(d => d.device);

    if (deviceIds.length === 0) {
        addLog('⚠️ No online devices to stream', 'error');
        // Fall back to polling
        startPollingFallback();
        return;
    }

    try {
        addLog(`📡 Starting realtime streaming for ${deviceIds.length} devices...`, 'info');
        const result = await window.electronAPI.startStreaming(deviceIds);

        if (result.success) {
            isStreaming = true;
            streamMode = 'realtime';
            streamStartTime = Date.now();
            addLog(`✅ Realtime streaming active! Frames will push automatically.`, 'success');
            updateModeIndicator();

            // Stop any legacy polling
            stopPolling();
        } else {
            addLog(`⚠️ Streaming failed, falling back to polling: ${result.error}`, 'error');
            startPollingFallback();
        }
    } catch (e) {
        addLog(`⚠️ Streaming error, falling back to polling: ${e.message}`, 'error');
        startPollingFallback();
    }
}

/**
 * Stop realtime streaming
 */
async function stopRealtimeStreaming() {
    try {
        await window.electronAPI.stopStreaming();
        isStreaming = false;
        streamMode = 'polling';
        addLog('⏹️ Realtime streaming stopped', 'info');
        updateModeIndicator();
    } catch (e) {
        addLog(`Error stopping stream: ${e.message}`, 'error');
    }
}

/**
 * Toggle between realtime streaming and polling
 */
async function toggleStreamMode() {
    if (streamMode === 'realtime') {
        await stopRealtimeStreaming();
        startPollingFallback();
    } else {
        stopPolling();
        await startRealtimeStreaming();
    }
}

/**
 * Start legacy polling as fallback
 */
function startPollingFallback() {
    streamMode = 'polling';
    isStreaming = false;
    updateModeIndicator();
    startAutoRefresh();
    addLog(`🔄 Polling mode active (interval: ${refreshInterval}ms)`, 'info');
}

function updateModeIndicator() {
    const modeEl = document.getElementById('stream-mode-label');
    if (modeEl) {
        if (streamMode === 'realtime') {
            modeEl.textContent = '🟢 REALTIME';
            modeEl.style.color = '#22c55e';
        } else {
            modeEl.textContent = '🟡 POLLING';
            modeEl.style.color = '#f59e0b';
        }
    }
    const modeBtn = document.getElementById('btn-stream-mode');
    if (modeBtn) {
        if (streamMode === 'realtime') {
            modeBtn.textContent = '📡 Realtime ON';
            modeBtn.style.background = 'linear-gradient(135deg, #10b981, #059669)';
        } else {
            modeBtn.textContent = '🔄 Polling';
            modeBtn.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
        }
    }
}

// ============================================
// DEVICE LOADING
// ============================================

async function loadDevices() {
    try {
        const result = await window.electronAPI.getDevices();
        if (result.success) {
            allDevices = result.devices;
            allDevices.forEach(d => {
                if (!deviceStatuses.has(d.device)) {
                    deviceStatuses.set(d.device, {
                        online: true, busy: false, taskInfo: '',
                        lastFrame: null, mimeType: 'image/jpeg', lastUpdate: 0
                    });
                }
            });
        }
    } catch (e) { addLog(`Failed to load devices: ${e.message}`, 'error'); }
}

async function loadWorkerStatuses() {
    try {
        const result = await window.electronAPI.getWorkers();
        if (result.success) {
            result.workers.forEach(w => {
                const status = deviceStatuses.get(w.deviceId);
                if (status) {
                    status.busy = w.status === 'busy';
                    status.taskInfo = w.currentTask ? `${w.currentTask.type || 'working'}` : '';
                    if (w.manuallyPaused) status.taskInfo = 'paused';
                }
            });
        }
    } catch (e) { /* silent */ }
}

async function loadCachedFrames() {
    try {
        const result = await window.electronAPI.getCachedFrames();
        if (result.success && result.frames) {
            let count = 0;
            for (const [deviceId, frame] of Object.entries(result.frames)) {
                const status = deviceStatuses.get(deviceId);
                if (status && frame.data) {
                    status.lastFrame = `data:${frame.mimeType || 'image/jpeg'};base64,${frame.data}`;
                    status.mimeType = frame.mimeType || 'image/jpeg';
                    status.lastUpdate = frame.timestamp || 0;
                    count++;
                }
            }
            if (count > 0) { addLog(`📦 Loaded ${count} cached frames`, 'info'); renderDeviceGrid(); }
        }
    } catch (e) { /* silent */ }
}

// ============================================
// DEVICE GRID RENDERING
// ============================================

function renderDeviceGrid() {
    const grid = document.getElementById('device-grid');
    if (!grid) return;
    const filtered = getFilteredDevices();

    grid.innerHTML = filtered.map(device => {
        const status = deviceStatuses.get(device.device) || {};
        const isSelected = selectedDevices.has(device.device);
        const isOnline = status.online !== false;
        const isBusy = status.busy;
        const safeId = device.device.replace(/[:.]/g, '_');
        let statusDotClass = isOnline ? (isBusy ? 'busy' : 'online') : 'offline';
        let cardClasses = `monitor-card${isSelected ? ' selected' : ''}${!isOnline ? ' offline' : ''}`;
        const screenshotHtml = status.lastFrame
            ? `<img src="${status.lastFrame}" alt="" loading="lazy">`
            : `<div class="placeholder">📱</div>`;
        let workerOverlay = '';
        if (isBusy && status.taskInfo) workerOverlay = `<div class="mc-worker-overlay running">🔵 ${status.taskInfo}</div>`;
        else if (status.taskInfo === 'paused') workerOverlay = `<div class="mc-worker-overlay paused">⏸️ Paused</div>`;
        let tagDot = '';
        for (const [name, tag] of Object.entries(deviceTags)) {
            if (tag.deviceIds && tag.deviceIds.includes(device.device)) {
                tagDot = `<div class="mc-tag-dot" style="background:${tag.color};"></div>`;
                break;
            }
        }
        return `
            <div class="${cardClasses}" id="card-${safeId}" data-device="${device.device}"
                 onclick="handleCardClick(event, '${device.device}')"
                 ondblclick="openScrcpy('${device.device}')">
                <div class="mc-header">
                    <div style="display:flex;align-items:center;gap:5px;">
                        <span class="mc-number">${device.number || '?'}</span>
                        <span class="mc-model">${device.model}</span>
                    </div>
                    <div class="mc-status-dot ${statusDotClass}"></div>
                </div>
                <div class="mc-screenshot" id="ss-${safeId}">
                    ${screenshotHtml}
                    ${workerOverlay}
                    ${tagDot}
                </div>
                <div class="mc-checkbox">${isSelected ? '✓' : ''}</div>
                <div class="mc-scrcpy-hint">🖥️ Double-click → scrcpy</div>
            </div>`;
    }).join('');

    updateStats();
    if (selectMode) grid.classList.add('select-mode');
    else grid.classList.remove('select-mode');
}

function getFilteredDevices() {
    let devices = allDevices.filter(d => {
        const status = deviceStatuses.get(d.device) || {};
        if (currentFilter === 'online') return status.online !== false && !status.busy;
        if (currentFilter === 'busy') return status.busy;
        if (currentFilter === 'offline') return status.online === false;
        return true;
    });
    if (activeTag && deviceTags[activeTag]) {
        const tagDeviceIds = deviceTags[activeTag].deviceIds || [];
        devices = devices.filter(d => tagDeviceIds.includes(d.device));
    }
    return devices;
}

function updateStats() {
    let online = 0, offline = 0, busy = 0;
    allDevices.forEach(d => {
        const status = deviceStatuses.get(d.device) || {};
        if (status.online === false) offline++;
        else if (status.busy) { busy++; online++; }
        else online++;
    });
    document.getElementById('stat-online').textContent = online;
    document.getElementById('stat-offline').textContent = offline;
    document.getElementById('stat-busy').textContent = busy;
}

// ============================================
// FRAME DOM UPDATES (optimized for high frequency)
// ============================================

function updateFrameDOM(deviceId, src) {
    const safeId = deviceId.replace(/[:.]/g, '_');
    const container = document.getElementById(`ss-${safeId}`);
    if (!container) return;
    const existingImg = container.querySelector('img');
    if (existingImg) {
        existingImg.src = src;
    } else {
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        const placeholder = container.querySelector('.placeholder');
        if (placeholder) placeholder.remove();
        container.prepend(img);
    }
}

function updateCardOnlineStatus(deviceId, isOnline) {
    const safeId = deviceId.replace(/[:.]/g, '_');
    const card = document.getElementById(`card-${safeId}`);
    if (!card) return;
    if (isOnline) card.classList.remove('offline');
    else card.classList.add('offline');
    const dot = card.querySelector('.mc-status-dot');
    if (dot) {
        const status = deviceStatuses.get(deviceId) || {};
        dot.className = `mc-status-dot ${isOnline ? (status.busy ? 'busy' : 'online') : 'offline'}`;
    }
}

// ============================================
// LEGACY POLLING (fallback)
// ============================================

function startAutoRefresh() {
    stopPolling();
    if (refreshInterval > 0 && streamMode === 'polling') {
        doBatchCapture();
        refreshTimer = setInterval(() => doBatchCapture(), refreshInterval);
    }
}

function stopPolling() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

function changeRefreshInterval(value) {
    refreshInterval = parseInt(value);
    if (streamMode === 'polling') {
        if (refreshInterval > 0) startAutoRefresh();
        else stopPolling();
    }
}

async function doBatchCapture() {
    if (isCapturing || streamMode === 'realtime') return;
    isCapturing = true;
    const cycleStart = Date.now();
    cycleCount++;

    try {
        const visible = getFilteredDevices().filter(d => (deviceStatuses.get(d.device) || {}).online !== false);
        if (visible.length === 0) { isCapturing = false; return; }
        const deviceIds = visible.map(d => d.device);
        const result = await window.electronAPI.batchCaptureScreenshots(deviceIds);
        if (result.success && result.results) {
            let updated = 0, cached = 0;
            for (const [deviceId, frameResult] of Object.entries(result.results)) {
                const status = deviceStatuses.get(deviceId);
                if (!status) continue;
                if (frameResult.success) {
                    const mimeType = frameResult.mimeType || 'image/jpeg';
                    const newSrc = `data:${mimeType};base64,${frameResult.data}`;
                    if (status.lastFrame !== newSrc) {
                        status.lastFrame = newSrc;
                        status.lastUpdate = Date.now();
                        updateFrameDOM(deviceId, newSrc);
                        updated++;
                    }
                    status.online = true;
                    if (frameResult.fromCache) cached++;
                } else {
                    if (frameResult.error && (frameResult.error.includes('offline') || frameResult.error.includes('timeout') || frameResult.error.includes('not found'))) {
                        if (status.online !== false) { status.online = false; updateCardOnlineStatus(deviceId, false); }
                    }
                }
            }
            perfStats.lastCycleTime = Date.now() - cycleStart;
            perfStats.framesUpdated = updated;
            if (cycleCount % 10 === 0) addLog(`📸 Cycle #${cycleCount}: ${updated} updated, ${perfStats.lastCycleTime}ms`, 'info');
        }
    } catch (e) { addLog(`Capture error: ${e.message}`, 'error'); }
    isCapturing = false;
    updateStats();
}

function refreshAllScreenshots() {
    showToast('🔄 Refreshing all...', 'info');
    allDevices.forEach(d => {
        const status = deviceStatuses.get(d.device);
        if (status) { status.lastFrame = null; status.online = true; }
    });
    renderDeviceGrid();
    if (streamMode === 'polling') doBatchCapture();
}

// ============================================
// CARD INTERACTION & SELECTION
// ============================================

function handleCardClick(event, deviceId) {
    if (selectMode) { event.stopPropagation(); toggleDeviceSelection(deviceId); }
}

function toggleDeviceSelection(deviceId) {
    if (selectedDevices.has(deviceId)) selectedDevices.delete(deviceId);
    else selectedDevices.add(deviceId);
    updateSelectionUI();
    const safeId = deviceId.replace(/[:.]/g, '_');
    const card = document.getElementById(`card-${safeId}`);
    if (card) {
        card.classList.toggle('selected', selectedDevices.has(deviceId));
        const cb = card.querySelector('.mc-checkbox');
        if (cb) cb.textContent = selectedDevices.has(deviceId) ? '✓' : '';
    }
    renderDeviceNumberGrid();
}

function toggleSelectMode() {
    selectMode = !selectMode;
    const btn = document.getElementById('btn-select-mode');
    const grid = document.getElementById('device-grid');
    if (selectMode) {
        btn.textContent = '☑ Select Mode ON';
        btn.style.background = 'linear-gradient(135deg, #667eea, #764ba2)';
        grid.classList.add('select-mode');
    } else {
        btn.textContent = '☐ Select Mode';
        btn.style.background = 'linear-gradient(135deg, #6b7280, #4b5563)';
        grid.classList.remove('select-mode');
        selectedDevices.clear();
    }
    updateSelectionUI();
    renderDeviceGrid();
}

function updateSelectionUI() {
    const bar = document.getElementById('selection-bar');
    const countEl = document.getElementById('selected-count');
    if (selectMode && selectedDevices.size > 0) { bar.classList.add('visible'); countEl.textContent = selectedDevices.size; }
    else bar.classList.remove('visible');
}

function selectAllVisible() {
    getFilteredDevices().forEach(d => selectedDevices.add(d.device));
    updateSelectionUI(); renderDeviceGrid(); renderDeviceNumberGrid();
}

function clearSelection() {
    selectedDevices.clear(); updateSelectionUI(); renderDeviceGrid(); renderDeviceNumberGrid();
}

// ============================================
// SCRCPY
// ============================================

function openScrcpy(deviceId) {
    addLog(`🖥️ Opening scrcpy for ${getDeviceLabel(deviceId)}...`, 'info');
    window.electronAPI.openScrcpy(deviceId).then(result => {
        if (result.success) showToast(`scrcpy: ${getDeviceLabel(deviceId)}`, 'success');
        else showToast(`scrcpy failed: ${result.error}`, 'error');
    });
}

function batchScrcpy() {
    if (selectedDevices.size === 0) return;
    const ids = Array.from(selectedDevices);
    if (ids.length > 10 && !confirm(`Open scrcpy for ${ids.length} devices?`)) return;
    ids.forEach(id => openScrcpy(id));
}

// ============================================
// BATCH COMMANDS
// ============================================

function showBatchModal() {
    if (selectedDevices.size === 0) { showToast('Select devices first', 'error'); return; }
    document.getElementById('modal-device-count').textContent = selectedDevices.size;
    document.getElementById('batch-modal').classList.add('visible');
}
function closeBatchModal() { document.getElementById('batch-modal').classList.remove('visible'); }

async function batchCommand(command) {
    if (selectedDevices.size === 0) return;
    const deviceIds = Array.from(selectedDevices);
    addLog(`⚡ "${command}" → ${deviceIds.length} devices`, 'info');
    showToast(`Running on ${deviceIds.length} devices...`, 'info');
    try {
        const result = await window.electronAPI.batchAdbCommand(deviceIds, command);
        if (result.success) {
            const ok = result.results.filter(r => r.success).length;
            showToast(`✅ ${ok}/${deviceIds.length} OK`, 'success');
        }
    } catch (e) { showToast('Command failed', 'error'); }
    closeBatchModal();
}
function runCustomCommand() { const cmd = document.getElementById('custom-adb-cmd').value.trim(); if (cmd) batchCommand(cmd); }

async function batchOpenTikTok() {
    if (selectedDevices.size === 0) return;
    showToast(`Opening TikTok...`, 'info');
    try { await window.electronAPI.openTikTokBulk(Array.from(selectedDevices)); showToast('TikTok opened', 'success'); }
    catch (e) { showToast('Failed', 'error'); }
}
async function batchCloseTikTok() {
    if (selectedDevices.size === 0) return;
    showToast(`Closing TikTok...`, 'info');
    try { await window.electronAPI.closeTikTokBulk(Array.from(selectedDevices)); showToast('TikTok closed', 'success'); }
    catch (e) { showToast('Failed', 'error'); }
}

async function batchInstallAPK() {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.apk';
    input.onchange = async (e) => {
        const file = e.target.files[0]; if (!file) return;
        const deviceIds = selectedDevices.size > 0 ? Array.from(selectedDevices) : allDevices.map(d => d.device);
        showToast('Installing APK...', 'info');
        try {
            const result = await window.electronAPI.batchInstallAPK(deviceIds, file.path);
            if (result.success) { const ok = result.results.filter(r => r.success).length; showToast(`✅ APK: ${ok}/${deviceIds.length}`, 'success'); }
        } catch (err) { showToast(`Failed: ${err.message}`, 'error'); }
        closeBatchModal();
    };
    input.click();
}
async function batchScreenshot() { closeBatchModal(); showToast('📸 Capturing...', 'info'); await doBatchCapture(); showToast('Done', 'success'); }

// ============================================
// FILTER & SIZE
// ============================================

function filterDevices(filter, btn) {
    currentFilter = filter;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderDeviceGrid();
}

function changeCardSize(value) {
    document.getElementById('device-grid').style.setProperty('--card-width', value + 'px');
    document.getElementById('size-label').textContent = value + 'px';
    const thumbWidth = Math.min(Math.round(parseInt(value) * 1.5), 360);
    window.electronAPI.updateCaptureSettings({ thumbnailWidth: thumbWidth });
}

/**
 * Display Size panel slider: changes grid card size
 */
function changeDisplaySize(value) {
    document.getElementById('device-grid').style.setProperty('--card-width', value + 'px');
    document.getElementById('large-screen-val').textContent = value + 'px';
    // Also sync the top-bar card-size slider
    const topSlider = document.getElementById('card-size');
    if (topSlider) topSlider.value = value;
    document.getElementById('size-label').textContent = value + 'px';
}

/**
 * Display Size panel slider: changes thumbnail capture width
 */
function changeThumbnailWidth(value) {
    document.getElementById('small-screen-val').textContent = value + 'px';
    window.electronAPI.updateCaptureSettings({ thumbnailWidth: parseInt(value) });
}

/**
 * Display Size panel slider: controls streaming speed
 * 1 = Fastest (minimal delay), 10 = Slowest (battery saver)
 */
function changeStreamSpeed(value) {
    const labels = { 1: 'Max Speed', 2: 'Faster', 3: 'Fast', 4: 'Fast', 5: 'Normal', 6: 'Normal', 7: 'Eco', 8: 'Eco', 9: 'Slow', 10: 'Battery' };
    document.getElementById('frame-rate-val').textContent = labels[value] || 'Normal';
    // Map 1-10 to breathDelay: 1=10ms, 5=100ms, 10=500ms
    const breathDelay = Math.round(Math.pow(value / 10, 2) * 500) + 10;
    window.electronAPI.updateCaptureSettings({ breathDelay: breathDelay });
}

/**
 * Run multiple ADB commands sequentially (for compound commands)
 */
async function runCompoundCmd(cmds) {
    const targets = getTargetDevices();
    for (const cmd of cmds) {
        await window.electronAPI.batchAdbCommand(targets, cmd);
    }
    showToast(`${cmds.length} commands executed`, 'success');
}

// ============================================
// RIGHT PANEL
// ============================================

function toggleRightPanel() { document.getElementById('right-panel').classList.toggle('collapsed'); }

function switchPanelTab(tabId, btn) {
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel-section').forEach(s => s.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const section = document.getElementById(`panel-${tabId}`);
    if (section) section.classList.add('active');
    if (tabId === 'tags') { renderTags(); renderDeviceNumberGrid(); }
}

// ============================================
// COMMON TAB - TOGGLE ACTIONS
// ============================================

function getTargetDevices() {
    return selectedDevices.size > 0 ? Array.from(selectedDevices) : allDevices.map(d => d.device);
}

async function toggleShowTouches(enable) {
    try { await window.electronAPI.toggleShowTouches(enable); showToast(`Show touches ${enable ? 'ON' : 'OFF'}`, 'success'); }
    catch (e) { showToast('Failed', 'error'); }
}
async function toggleDarkScreen(enable) {
    const targets = getTargetDevices();
    try {
        await window.electronAPI.batchAdbCommand(targets, 'shell settings put system screen_brightness_mode 0');
        const brightness = enable ? '0' : '128';
        await window.electronAPI.batchAdbCommand(targets, `shell settings put system screen_brightness ${brightness}`);
        showToast(`Dark screen ${enable ? 'ON' : 'OFF'}`, 'success');
    } catch (e) { showToast('Failed', 'error'); }
}
async function toggleAutoScreenOff(enable) {
    const cmd = enable ? 'shell settings put system screen_off_timeout 15000' : 'shell settings put system screen_off_timeout 2147483647';
    try { await window.electronAPI.batchAdbCommand(getTargetDevices(), cmd); showToast(`Auto off ${enable ? 'ON' : 'OFF'}`, 'success'); }
    catch (e) { showToast('Failed', 'error'); }
}
async function toggleStayOn(enable) {
    const cmd = enable ? 'shell svc power stayon true' : 'shell svc power stayon false';
    try { await window.electronAPI.batchAdbCommand(getTargetDevices(), cmd); showToast(`Stay on ${enable ? 'ON' : 'OFF'}`, 'success'); }
    catch (e) { showToast('Failed', 'error'); }
}
async function toggleWifiMode(enable) {
    const cmd = enable ? 'shell svc wifi enable' : 'shell svc wifi disable';
    try { await window.electronAPI.batchAdbCommand(getTargetDevices(), cmd); showToast(`WiFi ${enable ? 'ON' : 'OFF'}`, 'success'); }
    catch (e) { showToast('Failed', 'error'); }
}
async function quickAction(action) {
    const cmds = {
        'reboot': 'shell reboot', 'shutdown': 'shell reboot -p',
        'wake': 'shell input keyevent KEYCODE_WAKEUP', 'sleep': 'shell input keyevent KEYCODE_SLEEP',
        'home': 'shell input keyevent KEYCODE_HOME', 'back': 'shell input keyevent KEYCODE_BACK',
        'volup': 'shell input keyevent KEYCODE_VOLUME_UP', 'voldown': 'shell input keyevent KEYCODE_VOLUME_DOWN',
        'wifi-on': 'shell svc wifi enable', 'wifi-off': 'shell svc wifi disable'
    };
    const cmd = cmds[action]; if (!cmd) return;
    try { await window.electronAPI.batchAdbCommand(getTargetDevices(), cmd); showToast(`${action} OK`, 'success'); }
    catch (e) { showToast('Failed', 'error'); }
}

// ============================================
// PHONE SETTINGS
// ============================================

function openPhoneSettings() {
    if (selectedDevices.size === 0) { showToast('Select devices first', 'error'); return; }
    document.getElementById('settings-device-count').textContent = selectedDevices.size;
    document.getElementById('settings-backdrop').classList.add('visible');
    document.getElementById('phone-settings-dialog').classList.add('visible');
}
function closePhoneSettings() {
    document.getElementById('settings-backdrop').classList.remove('visible');
    document.getElementById('phone-settings-dialog').classList.remove('visible');
}
async function applyPhoneSettingsDialog() {
    const ids = Array.from(selectedDevices);
    const w = document.getElementById('ps-width').value.trim();
    const h = document.getElementById('ps-height').value.trim();
    const dpi = document.getElementById('ps-dpi').value.trim();
    const br = document.getElementById('ps-brightness').value;
    if (w && h) await window.electronAPI.batchAdbCommand(ids, `shell wm size ${w}x${h}`);
    if (dpi) await window.electronAPI.batchAdbCommand(ids, `shell wm density ${dpi}`);
    if (br) { await window.electronAPI.batchAdbCommand(ids, `shell settings put system screen_brightness_mode 0`); await window.electronAPI.batchAdbCommand(ids, `shell settings put system screen_brightness ${br}`); }
    showToast(`Settings applied to ${ids.length} devices`, 'success');
    closePhoneSettings();
}
async function resetPhoneSettingsDialog() {
    const ids = Array.from(selectedDevices);
    await window.electronAPI.batchAdbCommand(ids, 'shell wm size reset');
    await window.electronAPI.batchAdbCommand(ids, 'shell wm density reset');
    showToast(`Reset ${ids.length} devices`, 'success');
    closePhoneSettings();
}
function adjustDPIDialog(delta) { const i = document.getElementById('ps-dpi'); i.value = Math.max(100, Math.min(640, (parseInt(i.value) || 320) + delta)); }
function adjustDPI(delta) { const i = document.getElementById('set-dpi'); i.value = Math.max(100, Math.min(640, (parseInt(i.value) || 320) + delta)); }

async function applyPhoneSettings() {
    const ids = getTargetDevices();
    const w = document.getElementById('set-width').value.trim();
    const h = document.getElementById('set-height').value.trim();
    const dpi = document.getElementById('set-dpi').value.trim();
    const br = document.getElementById('set-brightness').value;
    if (w && h) await window.electronAPI.batchAdbCommand(ids, `shell wm size ${w}x${h}`);
    if (dpi) await window.electronAPI.batchAdbCommand(ids, `shell wm density ${dpi}`);
    await window.electronAPI.batchAdbCommand(ids, `shell settings put system screen_brightness ${br}`);
    showToast('Applied', 'success');
}
async function resetPhoneSettings() {
    await window.electronAPI.batchAdbCommand(getTargetDevices(), 'shell wm size reset');
    await window.electronAPI.batchAdbCommand(getTargetDevices(), 'shell wm density reset');
    showToast('Reset done', 'success');
}
async function adbAction(cmd) {
    try {
        const result = await window.electronAPI.batchAdbCommand(getTargetDevices(), cmd);
        if (result.success) {
            const ok = result.results.filter(r => r.success).length;
            showToast(`✅ ${ok} OK`, 'success');
            const first = result.results.find(r => r.success && r.output);
            if (first) addLog(first.output.substring(0, 200), 'info');
        }
    } catch (e) { showToast('Failed', 'error'); }
}

// ============================================
// ADB CONSOLE
// ============================================

function switchConsoleTab(tabId, btn) {
    document.querySelectorAll('.adb-console-tab').forEach(t => t.classList.remove('active'));
    if (btn) btn.classList.add('active');
    document.getElementById('console-common-cmds').style.display = tabId === 'common-cmds' ? '' : 'none';
    document.getElementById('console-history').style.display = tabId === 'history' ? '' : 'none';
    document.getElementById('console-adb-list').style.display = tabId === 'adb-list' ? '' : 'none';
    if (tabId === 'adb-list') refreshAdbList();
    if (tabId === 'history') renderHistory();
}
async function executeAdbFromConsole() {
    const input = document.getElementById('adb-cmd-input');
    const cmd = input.value.trim(); if (!cmd) return;
    addToHistory(cmd); input.value = '';
    await adbAction(cmd);
}
function runConsoleCmd(cmd) { addToHistory(cmd); adbAction(cmd); }
function addToHistory(cmd) {
    cmdHistory = cmdHistory.filter(c => c !== cmd);
    cmdHistory.unshift(cmd);
    if (cmdHistory.length > MAX_HISTORY) cmdHistory.pop();
    try { localStorage.setItem('j99tix-cmd-history', JSON.stringify(cmdHistory)); } catch (e) {}
}
function renderHistory() {
    try { cmdHistory = JSON.parse(localStorage.getItem('j99tix-cmd-history') || '[]'); } catch (e) { cmdHistory = []; }
    const c = document.getElementById('console-history');
    if (cmdHistory.length === 0) { c.innerHTML = '<div style="color:#64748b;font-size:10px;padding:8px;text-align:center;">No history</div>'; return; }
    c.innerHTML = cmdHistory.map((cmd, i) =>
        `<div class="adb-cmd-item" onclick="runConsoleCmd('${cmd.replace(/'/g, "\\'")}')"><span class="cmd-num">${i+1}</span><span class="cmd-detail">${cmd}</span></div>`
    ).join('');
}
function refreshAdbList() {
    const c = document.getElementById('console-adb-list');
    c.innerHTML = allDevices.map((d, i) => {
        const s = deviceStatuses.get(d.device) || {};
        const st = s.online === false ? '🔴 offline' : (s.busy ? '🔵 busy' : '🟢 online');
        return `<div class="adb-cmd-item"><span class="cmd-num">${d.number||i+1}</span><span class="cmd-label">${d.device}</span><span class="cmd-detail">${d.model} ${st}</span></div>`;
    }).join('');
}

// ============================================
// TEXT & FILE DISTRIBUTION
// ============================================

async function distributeText() {
    const text = document.getElementById('text-distribute').value.trim();
    if (!text) { showToast('Enter text', 'error'); return; }
    const escaped = text.replace(/ /g, '%s');
    await window.electronAPI.batchAdbCommand(getTargetDevices(), `shell input text "${escaped}"`);
    showToast('Text sent', 'success');
}
async function pushFile() {
    const input = document.createElement('input'); input.type = 'file';
    input.onchange = async (e) => {
        const file = e.target.files[0]; if (!file) return;
        showToast(`Pushing ${file.name}...`, 'info');
        try { await window.electronAPI.batchAdbCommand(getTargetDevices(), `push "${file.path}" /sdcard/${file.name}`); showToast('File pushed', 'success'); }
        catch (e) { showToast('Failed', 'error'); }
    };
    input.click();
}

// ============================================
// TAGS SYSTEM
// ============================================

const TAG_COLORS = ['#ef4444','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#14b8a6','#f97316'];
function loadTagsFromStorage() { try { deviceTags = JSON.parse(localStorage.getItem('j99tix-device-tags')||'{}'); } catch(e) { deviceTags = {}; } }
function saveTagsToStorage() { try { localStorage.setItem('j99tix-device-tags', JSON.stringify(deviceTags)); } catch(e) {} }

// Fixed: use inline input instead of prompt() which doesn't work in Electron
function addTagInline() {
    const input = document.getElementById('new-tag-name');
    const name = input.value.trim();
    if (!name) { showToast('Enter a tag name', 'error'); input.focus(); return; }
    const devIds = selectedDevices.size > 0 ? Array.from(selectedDevices) : [];
    deviceTags[name] = { color: TAG_COLORS[Object.keys(deviceTags).length % TAG_COLORS.length], deviceIds: devIds };
    saveTagsToStorage(); renderTags();
    input.value = '';
    showToast(`Tag "${name}" created with ${devIds.length} devices`, 'success');
}

// Keep old addTag as alias (for backward compat)
function addTag() { addTagInline(); }

// Auto-create tags by device model
function autoTagByModel() {
    const modelGroups = {};
    allDevices.forEach(d => {
        const model = d.model || 'Unknown';
        if (!modelGroups[model]) modelGroups[model] = [];
        modelGroups[model].push(d.device);
    });

    let created = 0;
    for (const [model, deviceIds] of Object.entries(modelGroups)) {
        if (!deviceTags[model]) {
            deviceTags[model] = {
                color: TAG_COLORS[(Object.keys(deviceTags).length + created) % TAG_COLORS.length],
                deviceIds: deviceIds
            };
            created++;
        } else {
            // Update existing tag with current devices
            deviceTags[model].deviceIds = deviceIds;
        }
    }

    saveTagsToStorage();
    renderTags();
    showToast(`Auto-tagged ${created} new groups: ${Object.keys(modelGroups).join(', ')}`, 'success');
}

function removeTag(name) {
    delete deviceTags[name];
    if (activeTag === name) activeTag = null;
    saveTagsToStorage(); renderTags(); renderDeviceGrid();
    showToast(`Tag "${name}" deleted`, 'info');
}
function toggleTagFilter(name) { activeTag = activeTag === name ? null : name; renderTags(); renderDeviceGrid(); }
function selectAllByTag() {
    selectedDevices.clear(); if (!selectMode) toggleSelectMode();
    allDevices.forEach(d => selectedDevices.add(d.device));
    updateSelectionUI(); renderDeviceGrid(); renderDeviceNumberGrid();
}
function renderTags() {
    document.getElementById('tag-total').textContent = allDevices.filter(d=>(deviceStatuses.get(d.device)||{}).online!==false).length;
    document.getElementById('tag-max').textContent = allDevices.length;
    document.getElementById('tag-list').innerHTML = Object.entries(deviceTags).map(([name, tag]) =>
        `<div class="tag-item ${activeTag===name?'active':''}" style="background:${tag.color}22;color:${tag.color};" onclick="toggleTagFilter('${name.replace(/'/g,"\\'")}')">
            ${name} (${(tag.deviceIds||[]).length})
            <span onclick="event.stopPropagation();removeTag('${name.replace(/'/g,"\\'")}')" style="cursor:pointer;margin-left:4px;">✕</span>
        </div>`
    ).join('');
}
function renderDeviceNumberGrid() {
    const c = document.getElementById('device-number-grid'); if (!c) return;
    c.innerHTML = allDevices.map(d => {
        const s = deviceStatuses.get(d.device)||{};
        let cls = 'device-num-btn';
        if (selectedDevices.has(d.device)) cls += ' selected';
        cls += (s.online!==false) ? ' online' : ' offline';
        return `<div class="${cls}" onclick="toggleDeviceFromGrid('${d.device}')" title="${d.model}">${d.number||'?'}</div>`;
    }).join('');
}
function toggleDeviceFromGrid(deviceId) { if (!selectMode) toggleSelectMode(); toggleDeviceSelection(deviceId); }

// ============================================
// MIRROR CONTROL
// ============================================

let mirrorActive = false;
let mirrorMasterDevice = null;
let mirrorDragState = null; // { startX, startY, startTime }
let mirrorScreenTimer = null;

async function startMirrorMode() {
    if (selectedDevices.size === 0) { showToast('Select devices first', 'error'); return; }

    const allSelected = Array.from(selectedDevices);
    const masterDevice = allSelected[0];

    const masterDev = allDevices.find(d => d.device === masterDevice);
    let resolution = { width: 1080, height: 2340 };
    if (masterDev && masterDev.resolution) {
        const parts = masterDev.resolution.split('x');
        if (parts.length === 2) resolution = { width: parseInt(parts[0]), height: parseInt(parts[1]) };
    }

    try {
        const result = await window.electronAPI.mirrorStart(masterDevice, allSelected, resolution);
        if (result.success) {
            mirrorActive = true;
            mirrorMasterDevice = masterDevice;
            document.getElementById('mirror-status').innerHTML =
                `<span style="color:#22c55e;">🟢 Active</span> — Master: #${masterDev?.number||'?'} → ${result.totalDevices} devices`;
            document.getElementById('btn-mirror-start').style.display = 'none';
            document.getElementById('btn-mirror-stop').style.display = '';
            document.getElementById('mirror-touchpad').style.display = '';
            document.getElementById('mirror-gesture-log').innerHTML = '';
            setupMirrorTouchpad();
            startMirrorScreenUpdate();
            showToast(`🪞 Mirror aktif! Tap/swipe di layar panel kanan → semua ${result.totalDevices} device mengikuti`, 'success');
        }
    } catch (e) { showToast(`Mirror failed: ${e.message}`, 'error'); }
}

async function stopMirrorMode() {
    try { await window.electronAPI.mirrorStop(); } catch (e) {}
    _resetMirrorUI();
    showToast('Mirror stopped', 'info');
}

function _resetMirrorUI() {
    mirrorActive = false;
    mirrorMasterDevice = null;
    if (mirrorScreenTimer) { clearInterval(mirrorScreenTimer); mirrorScreenTimer = null; }
    document.getElementById('mirror-status').innerHTML = 'Status: Inactive';
    document.getElementById('btn-mirror-start').style.display = '';
    document.getElementById('btn-mirror-stop').style.display = 'none';
    document.getElementById('mirror-touchpad').style.display = 'none';
}

/**
 * Setup the visual touchpad: transparent overlay on top of live screenshot
 * Mouse events on the container → normalized coords → sent to all devices
 */
function setupMirrorTouchpad() {
    const container = document.getElementById('mirror-screen-container');
    if (!container) return;

    container.onmousedown = (e) => {
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const normX = (e.clientX - rect.left) / rect.width;
        const normY = (e.clientY - rect.top) / rect.height;

        mirrorDragState = { startX: normX, startY: normY, startTime: Date.now() };

        // Show touch dot
        const dot = document.getElementById('mirror-touch-dot');
        dot.style.left = (normX * 100) + '%';
        dot.style.top = (normY * 100) + '%';
        dot.style.display = 'block';
        dot.style.opacity = '1';
    };

    container.onmousemove = (e) => {
        if (!mirrorDragState) return;
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const normX = (e.clientX - rect.left) / rect.width;
        const normY = (e.clientY - rect.top) / rect.height;

        // Update dot position
        const dot = document.getElementById('mirror-touch-dot');
        dot.style.left = (normX * 100) + '%';
        dot.style.top = (normY * 100) + '%';

        // Show swipe line
        const line = document.getElementById('swipe-line-el');
        line.setAttribute('x1', (mirrorDragState.startX * 100) + '%');
        line.setAttribute('y1', (mirrorDragState.startY * 100) + '%');
        line.setAttribute('x2', (normX * 100) + '%');
        line.setAttribute('y2', (normY * 100) + '%');
        line.style.display = '';
    };

    container.onmouseup = async (e) => {
        if (!mirrorDragState) return;
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const endX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const endY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        const elapsed = Date.now() - mirrorDragState.startTime;

        const dx = Math.abs(endX - mirrorDragState.startX);
        const dy = Math.abs(endY - mirrorDragState.startY);

        // Hide indicators
        document.getElementById('mirror-touch-dot').style.opacity = '0';
        document.getElementById('swipe-line-el').style.display = 'none';

        const startX = mirrorDragState.startX;
        const startY = mirrorDragState.startY;
        mirrorDragState = null;

        if (dx < 0.015 && dy < 0.015) {
            // TAP
            await window.electronAPI.mirrorTap(endX, endY);
        } else {
            // SWIPE
            const duration = Math.max(150, Math.min(1000, elapsed));
            await window.electronAPI.mirrorSwipe(startX, startY, endX, endY, duration);
        }
    };

    container.onmouseleave = () => {
        if (mirrorDragState) {
            document.getElementById('mirror-touch-dot').style.opacity = '0';
            document.getElementById('swipe-line-el').style.display = 'none';
            mirrorDragState = null;
        }
    };
}

/**
 * Periodically update the mirror screen with the master device's latest frame
 */
function startMirrorScreenUpdate() {
    if (mirrorScreenTimer) clearInterval(mirrorScreenTimer);

    const updateScreen = () => {
        if (!mirrorActive || !mirrorMasterDevice) return;
        const status = deviceStatuses.get(mirrorMasterDevice);
        if (status && status.lastFrame) {
            const img = document.getElementById('mirror-screen-img');
            if (img && img.src !== status.lastFrame) {
                img.src = status.lastFrame;
            }
        }
    };

    updateScreen(); // Immediate first update
    mirrorScreenTimer = setInterval(updateScreen, 300); // Update every 300ms
}

// Listen for mirror events from main process
function setupMirrorListeners() {
    if (window.electronAPI.onMirrorGesture) {
        window.electronAPI.onMirrorGesture((data) => {
            const logEl = document.getElementById('mirror-gesture-log');
            if (logEl) {
                const entry = document.createElement('div');
                entry.style.cssText = 'font-size:9px;color:#a5b4fc;padding:1px 0;';
                if (data.type === 'tap') entry.textContent = `👆 Tap (${data.x},${data.y}) → ${data.ok}/${data.devices}`;
                else if (data.type === 'swipe') entry.textContent = `👉 Swipe → ${data.ok}/${data.devices}`;
                else if (data.type === 'key') entry.textContent = `⌨ Key: ${data.keycode} → ${data.ok}/${data.devices}`;
                else entry.textContent = `⚡ ${data.type} → ${data.ok}/${data.devices}`;
                logEl.appendChild(entry);
                logEl.scrollTop = logEl.scrollHeight;
                while (logEl.children.length > 20) logEl.removeChild(logEl.firstChild);
            }
        });
    }

    if (window.electronAPI.onMirrorStopped) {
        window.electronAPI.onMirrorStopped(() => {
            _resetMirrorUI();
            showToast('Mirror stopped (scrcpy closed)', 'info');
        });
    }
}

async function mirrorKey(keycode) {
    if (!mirrorActive) { showToast('Start mirror first', 'error'); return; }
    await window.electronAPI.mirrorKeyEvent(keycode);
}

async function sendMirrorText() {
    if (!mirrorActive) { showToast('Start mirror first', 'error'); return; }
    const input = document.getElementById('mirror-text-input');
    const text = input.value.trim();
    if (!text) return;
    await window.electronAPI.mirrorText(text);
    input.value = '';
    showToast('Text sent', 'success');
}

// ============================================
// WORKER STATUS UPDATES
// ============================================

function updateWorkerStatus(data) {
    const status = deviceStatuses.get(data.deviceId); if (!status) return;
    if (data.event==='task_started'||data.event==='busy') { status.busy=true; status.taskInfo=data.task?(data.task.type||'working'):'working'; }
    else if (data.event==='task_completed'||data.event==='idle') { status.busy=false; status.taskInfo=''; }
    else if (data.event==='manually_paused') status.taskInfo='paused';
    else if (data.event==='manually_resumed') status.taskInfo='';

    const safeId = data.deviceId.replace(/[:.]/g,'_');
    const container = document.getElementById(`ss-${safeId}`);
    if (container) {
        const existing = container.querySelector('.mc-worker-overlay');
        let html = '';
        if (status.busy&&status.taskInfo) html=`<div class="mc-worker-overlay running">🔵 ${status.taskInfo}</div>`;
        else if (status.taskInfo==='paused') html=`<div class="mc-worker-overlay paused">⏸️ Paused</div>`;
        if (existing) { if (html) existing.outerHTML=html; else existing.remove(); }
        else if (html) container.insertAdjacentHTML('beforeend',html);
        const card = container.closest('.monitor-card');
        if (card) { const dot=card.querySelector('.mc-status-dot'); if(dot) dot.className=`mc-status-dot ${status.busy?'busy':'online'}`; }
    }
    updateStats();
}

// ============================================
// LOGGING & TOAST
// ============================================

function addLog(message, type='info') {
    const log = document.getElementById('status-log'); if (!log) return;
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    log.appendChild(entry); log.scrollTop = log.scrollHeight;
    while (log.children.length > 200) log.removeChild(log.firstChild);
}
function toggleLog() {
    logVisible = !logVisible;
    document.getElementById('status-log').classList.toggle('visible', logVisible);
    if (logVisible) showCaptureStats();
}
async function showCaptureStats() {
    try {
        const result = await window.electronAPI.getCaptureStats();
        if (result.success && result.stats) {
            const s = result.stats;
            const stream = s.streaming || {};
            addLog(`📊 Mode: ${s.mode} | Streams: ${stream.activeStreams||0} | Total frames: ${stream.totalFrames||0} | Avg: ${stream.avgFrameTime||0}ms | FPS: ${perfStats.fps}`, 'info');
        }
    } catch (e) {}
}
function showToast(message, type='info') {
    const existing = document.querySelector('.toast'); if (existing) existing.remove();
    const toast = document.createElement('div'); toast.className=`toast ${type}`; toast.textContent=message;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity='0'; toast.style.transition='opacity 0.3s'; setTimeout(()=>toast.remove(),300); }, 3000);
}

function getDeviceLabel(deviceId) { const d = allDevices.find(d=>d.device===deviceId); return d ? `#${d.number} ${d.model}` : deviceId; }

// ============================================
// LIFECYCLE
// ============================================

window.electronAPI.onAppReady(() => {});
setInterval(async () => { await loadWorkerStatuses(); }, 5000);
setInterval(async () => { if (logVisible) showCaptureStats(); }, 15000);

init();
