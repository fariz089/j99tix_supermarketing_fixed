let devices = [];
let selectedDevices = { sm: new Set(), wu: new Set(), bl: new Set(), mc: new Set() };
// Track view mode per tab: 'compact' (default) or 'detailed'
let deviceViewMode = { sm: 'compact', wu: 'compact', bl: 'compact', mc: 'compact' };

window.electronAPI.onAppReady(() => {
    console.log('App ready, hiding loading overlay');
    const loadingOverlay = document.getElementById('init-loading');
    if (loadingOverlay) {
        loadingOverlay.classList.remove('active');
        setTimeout(() => loadingOverlay.remove(), 300);
    }
});


// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(tab.dataset.tab).classList.add('active');
    });
});

// Load devices
async function loadDevices() {
    const result = await window.electronAPI.getDevices();
    if (result.success) {
        devices = result.devices;
        renderDeviceSelectors();
    }
}

function selectAllDevices(type) {
    devices.forEach(device => {
        selectedDevices[type].add(device.device);
    });
    renderDeviceSelectors();
}

function deselectAllDevices(type) {
    selectedDevices[type].clear();
    renderDeviceSelectors();
}

// Select all devices in a specific group
function selectGroup(type, manufacturer, model) {
    devices.forEach(device => {
        if (device.manufacturer === manufacturer && device.model === model) {
            selectedDevices[type].add(device.device);
        }
    });
    renderDeviceSelectors();
}

// Deselect all devices in a specific group
function deselectGroup(type, manufacturer, model) {
    devices.forEach(device => {
        if (device.manufacturer === manufacturer && device.model === model) {
            selectedDevices[type].delete(device.device);
        }
    });
    renderDeviceSelectors();
}

// Toggle device view mode
function toggleDeviceView(type) {
    deviceViewMode[type] = deviceViewMode[type] === 'compact' ? 'detailed' : 'compact';
    renderDeviceSelectors();
}

function renderDeviceSelectors() {
    ['sm', 'wu', 'bl', 'mc'].forEach(type => {
        const container = document.getElementById(`${type}_devices`);
        const countEl = document.getElementById(`${type}_count`);

        if (!container || !countEl) return;

        container.innerHTML = '';
        countEl.textContent = selectedDevices[type].size;

        const isCompact = deviceViewMode[type] === 'compact';

        // Group devices by manufacturer + model
        const groups = {};
        devices.forEach(device => {
            const key = `${device.manufacturer}|${device.model}`;
            if (!groups[key]) {
                groups[key] = {
                    manufacturer: device.manufacturer,
                    model: device.model,
                    devices: []
                };
            }
            groups[key].devices.push(device);
        });

        Object.values(groups).forEach(group => {
            const selectedInGroup = group.devices.filter(d => selectedDevices[type].has(d.device)).length;
            const totalInGroup = group.devices.length;
            const allSelected = selectedInGroup === totalInGroup;
            const mfgDisplay = group.manufacturer.toUpperCase();
            const icon = mfgDisplay === 'OPPO' ? '🟢' : '🔵';

            // Group header
            const groupHeader = document.createElement('div');
            groupHeader.className = 'device-group-header';
            groupHeader.innerHTML = `
                <div class="device-group-info">
                    <span class="device-group-icon">${icon}</span>
                    <span class="device-group-title">${mfgDisplay} ${group.model}</span>
                    <span class="device-group-count">${selectedInGroup}/${totalInGroup}</span>
                </div>
                <div class="device-group-actions">
                    <button class="device-group-btn select-grp" onclick="event.stopPropagation(); selectGroup('${type}', '${group.manufacturer}', '${group.model}')">All</button>
                    <button class="device-group-btn deselect-grp" onclick="event.stopPropagation(); deselectGroup('${type}', '${group.manufacturer}', '${group.model}')">None</button>
                </div>
            `;
            container.appendChild(groupHeader);

            // Device grid for this group
            const deviceGrid = document.createElement('div');
            deviceGrid.className = isCompact ? 'device-grid compact' : 'device-grid detailed';

            group.devices.forEach(device => {
                const card = document.createElement('div');
                const isSelected = selectedDevices[type].has(device.device);
                card.className = `device-card-v2 ${isSelected ? 'selected' : ''}`;

                if (isCompact) {
                    // Compact: just number + short label
                    card.innerHTML = `
                        <span class="dc-number">#${String(device.number).padStart(2, '0')}</span>
                        <span class="dc-ip">${device.device.split(':')[0].split('.').slice(2).join('.')}</span>
                    `;
                } else {
                    // Detailed: full info
                    card.innerHTML = `
                        <div class="dc-top">
                            <span class="dc-number">#${String(device.number).padStart(2, '0')}</span>
                            <span class="dc-model">${group.model}</span>
                        </div>
                        <div class="dc-ip-full">${device.device}</div>
                        <div class="dc-res">${device.resolution}</div>
                    `;
                }

                card.onclick = () => {
                    if (selectedDevices[type].has(device.device)) {
                        selectedDevices[type].delete(device.device);
                    } else {
                        selectedDevices[type].add(device.device);
                    }
                    renderDeviceSelectors();
                };

                deviceGrid.appendChild(card);
            });

            container.appendChild(deviceGrid);
        });
    });
}

// Update preview on input change
document.addEventListener('DOMContentLoaded', () => {
    const updatePreview = () => {
        const idleMin = document.getElementById('sm_idle_min')?.value || 2;
        const idleMax = document.getElementById('sm_idle_max')?.value || 5;
        const scrollCount = document.getElementById('sm_scroll_count')?.value || 5;
        const scrollDelayMin = document.getElementById('sm_scroll_delay_min')?.value || 2;
        const scrollDelayMax = document.getElementById('sm_scroll_delay_max')?.value || 5;
        const watchMin = document.getElementById('sm_watch_min')?.value || 5;
        const watchMax = document.getElementById('sm_watch_max')?.value || 60;

        if (document.getElementById('sm_preview_idle')) {
            document.getElementById('sm_preview_idle').textContent = `${idleMin}-${idleMax}s`;
            document.getElementById('sm_preview_scroll').textContent = `0-${scrollCount}x`;
            document.getElementById('sm_preview_scroll_delay').textContent = `${scrollDelayMin}-${scrollDelayMax}s`;
            document.getElementById('sm_preview_watch').textContent = `${watchMin}-${watchMax}s`;
        }
    };

    // Add event listeners
    ['sm_idle_min', 'sm_idle_max', 'sm_scroll_count', 'sm_scroll_delay_min',
        'sm_scroll_delay_max', 'sm_watch_min', 'sm_watch_max'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('input', updatePreview);
            }
        });

    // Toggle like settings visibility (Super Marketing)
    const likeToggle = document.getElementById('sm_like_enabled');
    const likeSettings = document.getElementById('sm_like_settings');
    if (likeToggle && likeSettings) {
        likeToggle.addEventListener('change', () => {
            likeSettings.style.opacity = likeToggle.checked ? '1' : '0.5';
            likeSettings.querySelectorAll('input').forEach(input => {
                input.disabled = !likeToggle.checked;
            });
        });
    }

    // ============================================
    // BOOST LIVE: Toggle handlers for Like/Comment/Share
    // ============================================
    const setupBoostLiveToggle = (toggleId, settingsId, previewStatusId) => {
        const toggle = document.getElementById(toggleId);
        const settings = document.getElementById(settingsId);
        const previewStatus = document.getElementById(previewStatusId);
        if (toggle && settings) {
            toggle.addEventListener('change', () => {
                settings.style.opacity = toggle.checked ? '1' : '0.5';
                settings.querySelectorAll('input').forEach(input => {
                    input.disabled = !toggle.checked;
                });
                if (previewStatus) {
                    previewStatus.textContent = toggle.checked ? 'ON' : 'OFF';
                    previewStatus.style.color = toggle.checked ? '#6ee7b7' : '#f87171';
                }
            });
        }
    };

    setupBoostLiveToggle('bl_like_enabled', 'bl_like_settings', 'bl_preview_like_status');
    setupBoostLiveToggle('bl_comment_enabled', 'bl_comment_settings', 'bl_preview_comment_status');
    setupBoostLiveToggle('bl_share_enabled', 'bl_share_settings', 'bl_preview_share_status');

    // Boost Live preview updater
    const updateBoostLivePreview = () => {
        const joinDelay = document.getElementById('bl_join_delay');
        const likeDelay = document.getElementById('bl_like_delay');
        const commentDelay = document.getElementById('bl_comment_delay');
        const shareDelay = document.getElementById('bl_share_delay');

        if (joinDelay && document.getElementById('bl_preview_join_delay')) {
            document.getElementById('bl_preview_join_delay').textContent = joinDelay.value;
        }
        if (likeDelay && document.getElementById('bl_preview_like_delay')) {
            document.getElementById('bl_preview_like_delay').textContent = likeDelay.value;
        }
        if (commentDelay && document.getElementById('bl_preview_comment_delay')) {
            document.getElementById('bl_preview_comment_delay').textContent = commentDelay.value;
        }
        if (shareDelay && document.getElementById('bl_preview_share_delay')) {
            document.getElementById('bl_preview_share_delay').textContent = shareDelay.value;
        }
    };

    ['bl_join_delay', 'bl_like_delay', 'bl_comment_delay', 'bl_share_delay'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', updateBoostLivePreview);
        }
    });

    // Initial preview
    setTimeout(updatePreview, 100);
    setTimeout(updateBoostLivePreview, 150);
});


// Helper: Show loading overlay
function showLoading(message = 'Creating job...') {
    const overlay = document.createElement('div');
    overlay.className = 'loading-overlay active';
    overlay.id = 'loading-overlay';
    overlay.innerHTML = `
        <div class="loading-content">
            <div class="loading-spinner"></div>
            <div class="loading-text">${message}</div>
        </div>
    `;
    document.body.appendChild(overlay);
}

// Helper: Hide loading overlay
function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        overlay.classList.remove('active');
        setTimeout(() => overlay.remove(), 200);
    }
}

// Helper: Show notification
function showNotification(message, type = 'success') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.innerHTML = message.replace(/\n/g, '<br>');
    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.animation = 'slideIn 0.3s ease reverse';
        setTimeout(() => notification.remove(), 300);
    }, 5000);
}

// Update createSuperMarketingJob
async function createSuperMarketingJob() {
    // Parse multiple URLs (one per line)
    const urlText = document.getElementById('sm_url').value.trim();
    const urls = urlText.split('\n')
        .map(u => u.trim())
        .filter(u => u.length > 0);

    if (urls.length === 0) {
        return alert('Please enter at least one video URL!');
    }

    console.log('📋 Parsed URLs:', urls);

    const deviceIds = Array.from(selectedDevices.sm);
    if (deviceIds.length === 0) return alert('Please select at least one device!');

    // Get like settings
    const likeEnabled = document.getElementById('sm_like_enabled').checked;
    const likeChance = likeEnabled ? parseInt(document.getElementById('sm_like_chance').value) : 0;

    const config = {
        urls: urls,
        numWatching: parseInt(document.getElementById('sm_target').value),
        durationMin: parseInt(document.getElementById('sm_watch_min').value),
        durationMax: parseInt(document.getElementById('sm_watch_max').value),
        idleDelayMin: parseInt(document.getElementById('sm_idle_min').value),
        idleDelayMax: parseInt(document.getElementById('sm_idle_max').value),
        scrollCount: parseInt(document.getElementById('sm_scroll_count').value),
        scrollDelayMin: parseInt(document.getElementById('sm_scroll_delay_min').value),
        scrollDelayMax: parseInt(document.getElementById('sm_scroll_delay_max').value),
        openUrlDelay: parseInt(document.getElementById('sm_open_delay').value),
        likeEnabled: likeEnabled,
        likeChance: likeChance
    };

    // Validation
    if (config.durationMin > config.durationMax) {
        return alert('Watch duration Min cannot be greater than Max!');
    }
    if (config.idleDelayMin > config.idleDelayMax) {
        return alert('Idle delay Min cannot be greater than Max!');
    }
    if (config.scrollDelayMin > config.scrollDelayMax) {
        return alert('Scroll delay Min cannot be greater than Max!');
    }

    showLoading('Creating Super Marketing job...');

    try {
        const result = await window.electronAPI.createJob({
            type: 'super_marketing',
            config,
            deviceIds
        });

        hideLoading();

        if (result.success) {
            const timePerUrl = config.openUrlDelay + config.durationMax;
            const totalTimePerTask = config.idleDelayMax + (config.scrollCount * config.scrollDelayMax) +
                (timePerUrl * urls.length) + 10;

            const likeStatus = likeEnabled ? `Like: ${likeChance}% (double-tap)` : 'Likes disabled';

            showNotification(
                `<strong>Job Created Successfully!</strong><br><br>` +
                `Job ID: ${result.job.id}<br>` +
                `URLs: ${urls.length}<br>` +
                `Devices: ${deviceIds.length}<br>` +
                `${likeStatus}<br>` +
                `Est. time per task: ~${totalTimePerTask}s<br><br>` +
                `Open Job Queue to monitor progress.`,
                'success'
            );
        }
    } catch (error) {
        hideLoading();
        showNotification(`Failed to create job: ${error.message}`, 'error');
    }
}


// Update createWarmupJob
async function createWarmupJob() {
    const deviceIds = Array.from(selectedDevices.wu);
    if (deviceIds.length === 0) return alert('Please select at least one device!');

    const config = {
        duration: parseInt(document.getElementById('wu_duration').value),
        percentages: {
            view: parseInt(document.getElementById('wu_view').value),
            like: parseInt(document.getElementById('wu_like').value),
            comment: parseInt(document.getElementById('wu_comment').value),
            share: parseInt(document.getElementById('wu_share').value)
        }
    };

    showLoading('Creating Warmup job...');

    try {
        const result = await window.electronAPI.createJob({
            type: 'warmup',
            config,
            deviceIds
        });

        hideLoading();

        if (result.success) {
            showNotification(
                `<strong>Warmup Job Created!</strong><br><br>` +
                `Job ID: ${result.job.id}<br>` +
                `Devices: ${deviceIds.length}`,
                'success'
            );
        }
    } catch (error) {
        hideLoading();
        showNotification(`Failed to create job: ${error.message}`, 'error');
    }
}

// Update createBoostLiveJob
async function createBoostLiveJob() {
    const url = document.getElementById('bl_url').value.trim();
    const username = document.getElementById('bl_username').value.trim();

    if (!url && !username) {
        return alert('Please enter either live URL or username!');
    }

    const deviceIds = Array.from(selectedDevices.bl);
    if (deviceIds.length === 0) return alert('Please select at least one device!');

    const comments = document.getElementById('bl_comments').value
        .split('\n')
        .map(c => c.trim())
        .filter(c => c.length > 0);

    // Read enable/disable toggles
    const likeEnabled = document.getElementById('bl_like_enabled').checked;
    const commentEnabled = document.getElementById('bl_comment_enabled').checked;
    const shareEnabled = document.getElementById('bl_share_enabled').checked;

    const config = {
        liveUrl: url,
        username: username,
        duration: parseInt(document.getElementById('bl_duration').value),
        interval: parseInt(document.getElementById('bl_interval').value),
        idleDelayMin: parseInt(document.getElementById('bl_idle_min').value),
        idleDelayMax: parseInt(document.getElementById('bl_idle_max').value),
        comments: comments,
        // Sequential join delay
        joinDelay: parseInt(document.getElementById('bl_join_delay').value) || 0,
        // Enable/disable toggles
        likeEnabled: likeEnabled,
        commentEnabled: commentEnabled,
        shareEnabled: shareEnabled,
        // Sequential action delays
        likeDelay: likeEnabled ? (parseInt(document.getElementById('bl_like_delay').value) || 0) : 0,
        commentDelay: commentEnabled ? (parseInt(document.getElementById('bl_comment_delay').value) || 0) : 0,
        shareDelay: shareEnabled ? (parseInt(document.getElementById('bl_share_delay').value) || 0) : 0,
        // Percentages
        percentages: {
            tap: parseInt(document.getElementById('bl_tap').value),
            like: parseInt(document.getElementById('bl_like').value),
            comment: parseInt(document.getElementById('bl_comment').value),
            share: parseInt(document.getElementById('bl_share').value)
        }
    };

    showLoading('Creating Boost Live job...');

    try {
        const result = await window.electronAPI.createJob({
            type: 'boost_live',
            config,
            deviceIds
        });

        hideLoading();

        if (result.success) {
            const estimatedActions = Math.floor(config.duration / config.interval);
            const joinSpread = (deviceIds.length - 1) * config.joinDelay;

            const actionStatus = [];
            if (likeEnabled) actionStatus.push(`❤️ Like (delay: ${config.likeDelay}s)`);
            if (commentEnabled) actionStatus.push(`💬 Comment (delay: ${config.commentDelay}s)`);
            if (shareEnabled) actionStatus.push(`🔄 Share (delay: ${config.shareDelay}s)`);

            showNotification(
                `<strong>Boost Live Job Created!</strong><br><br>` +
                `Job ID: ${result.job.id}<br>` +
                `Duration: ${config.duration}s<br>` +
                `Join delay: ${config.joinDelay}s/device (spread: ${joinSpread}s)<br>` +
                `Idle delay: ${config.idleDelayMin}-${config.idleDelayMax}s<br>` +
                `Estimated checks: ~${estimatedActions}<br>` +
                `Custom comments: ${comments.length}<br>` +
                `Devices: ${deviceIds.length}<br><br>` +
                `Actions: ${actionStatus.join(', ') || 'None enabled'}`,
                'success'
            );
        }
    } catch (error) {
        hideLoading();
        showNotification(`Failed to create job: ${error.message}`, 'error');
    }
}

// Update createMassCommentJob
async function createMassCommentJob() {
    const url = document.getElementById('mc_url').value.trim();
    if (!url) return alert('Please enter video URL!');

    const comments = document.getElementById('mc_comments').value.split('\n').filter(c => c.trim());
    if (comments.length === 0) return alert('Please enter at least one comment!');

    const deviceIds = Array.from(selectedDevices.mc);
    if (deviceIds.length === 0) return alert('Please select at least one device!');

    const config = {
        url: url,
        comments: comments,
        commentsPerDevice: parseInt(document.getElementById('mc_perdevice').value),
        idleDelayMin: parseInt(document.getElementById('mc_idle_min').value),
        idleDelayMax: parseInt(document.getElementById('mc_idle_max').value),
        scrollCount: parseInt(document.getElementById('mc_scroll_count').value),
        scrollDelayMin: parseInt(document.getElementById('mc_scroll_delay_min').value),
        scrollDelayMax: parseInt(document.getElementById('mc_scroll_delay_max').value),
        deviceStartDelay: parseInt(document.getElementById('mc_device_delay').value) || 0
    };

    // Validation
    if (config.idleDelayMin > config.idleDelayMax) {
        return alert('Idle delay Min cannot be greater than Max!');
    }
    if (config.scrollDelayMin > config.scrollDelayMax) {
        return alert('Scroll delay Min cannot be greater than Max!');
    }

    showLoading('Creating Mass Comment job...');

    try {
        const result = await window.electronAPI.createJob({
            type: 'masscomment',
            config,
            deviceIds
        });

        hideLoading();

        if (result.success) {
            const totalComments = deviceIds.length * config.commentsPerDevice;
            const totalDelay = (deviceIds.length - 1) * config.deviceStartDelay;
            showNotification(
                `<strong>Mass Comment Job Created!</strong><br><br>` +
                `Job ID: ${result.job.id}<br>` +
                `Total Comments: ${totalComments}<br>` +
                `Devices: ${deviceIds.length}<br>` +
                `Per Device: ${config.commentsPerDevice}<br>` +
                `Device Delay: ${config.deviceStartDelay}s (total spread: ${totalDelay}s)`,
                'success'
            );
        }
    } catch (error) {
        hideLoading();
        showNotification(`Failed to create job: ${error.message}`, 'error');
    }
}



// Window openers
async function openWorkerWindow() {
    await window.electronAPI.openWorkerWindow();
}

async function openJobWindow() {
    await window.electronAPI.openJobWindow();
}

async function openMonitorWindow() {
    await window.electronAPI.openMonitorWindow();
}

// Init
loadDevices();
