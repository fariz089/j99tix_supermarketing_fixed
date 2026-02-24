const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getDevices: () => ipcRenderer.invoke('get-devices'),
    getWorkers: () => ipcRenderer.invoke('get-workers'),
    pauseWorker: (deviceId) => ipcRenderer.invoke('pause-worker', deviceId),
    resumeWorker: (deviceId) => ipcRenderer.invoke('resume-worker', deviceId),
    createJob: (data) => ipcRenderer.invoke('create-job', data),
    getJobs: () => ipcRenderer.invoke('get-jobs'),
    pauseJob: (jobId) => ipcRenderer.invoke('pause-job', jobId),
    resumeJob: (jobId) => ipcRenderer.invoke('resume-job', jobId),
    cancelJob: (jobId) => ipcRenderer.invoke('cancel-job', jobId),
    retryJob: (jobId) => ipcRenderer.invoke('retry-job', jobId),
    deleteJob: (jobId) => ipcRenderer.invoke('delete-job', jobId),
    openWorkerWindow: () => ipcRenderer.invoke('open-worker-window'),
    openJobWindow: () => ipcRenderer.invoke('open-job-window'),
    openMonitorWindow: () => ipcRenderer.invoke('open-monitor-window'),

    openTikTokBulk: (deviceIds) => ipcRenderer.invoke('open-tiktok-bulk', deviceIds),
    closeTikTokBulk: (deviceIds) => ipcRenderer.invoke('close-tiktok-bulk', deviceIds),

    toggleShowTouches: (enable) => ipcRenderer.invoke('toggle-show-touches', enable),
    togglePointerLocation: (enable) => ipcRenderer.invoke('toggle-pointer-location', enable),
    toggleTapMonitoring: (deviceId, enable) => ipcRenderer.invoke('toggle-tap-monitoring', deviceId, enable),

    cancelAllJobs: () => ipcRenderer.invoke('cancel-all-jobs'),
    deleteAllJobs: () => ipcRenderer.invoke('delete-all-jobs'),

    // Refill comments for a job
    refillComments: (jobId, comments) => ipcRenderer.invoke('refill-comments', jobId, comments),
    
    // Get comment stats for a job
    getCommentStats: (jobId) => ipcRenderer.invoke('get-comment-stats', jobId),

    // Monitor APIs
    captureScreenshot: (deviceId) => ipcRenderer.invoke('capture-screenshot', deviceId),
    batchCaptureScreenshots: (deviceIds) => ipcRenderer.invoke('batch-capture-screenshots', deviceIds),
    getCachedFrames: () => ipcRenderer.invoke('get-cached-frames'),
    getCaptureStats: () => ipcRenderer.invoke('get-capture-stats'),
    updateCaptureSettings: (settings) => ipcRenderer.invoke('update-capture-settings', settings),
    openScrcpy: (deviceId) => ipcRenderer.invoke('open-scrcpy', deviceId),
    batchAdbCommand: (deviceIds, command) => ipcRenderer.invoke('batch-adb-command', deviceIds, command),
    batchInstallAPK: (deviceIds, apkPath) => ipcRenderer.invoke('batch-install-apk', deviceIds, apkPath),

    // Realtime Streaming APIs
    startStreaming: (deviceIds) => ipcRenderer.invoke('start-streaming', deviceIds),
    stopStreaming: () => ipcRenderer.invoke('stop-streaming'),
    getStreamStats: () => ipcRenderer.invoke('get-stream-stats'),
    restartDeviceStream: (deviceId) => ipcRenderer.invoke('restart-device-stream', deviceId),

    // Device Scan & Reconnect APIs
    scanAdbDevices: () => ipcRenderer.invoke('scan-adb-devices'),
    reconnectDevices: () => ipcRenderer.invoke('reconnect-devices'),

    // Mirror Control APIs
    mirrorStart: (masterDeviceId, slaveDeviceIds, resolution) => ipcRenderer.invoke('mirror-start', masterDeviceId, slaveDeviceIds, resolution),
    mirrorStop: () => ipcRenderer.invoke('mirror-stop'),
    mirrorTap: (normX, normY) => ipcRenderer.invoke('mirror-tap', normX, normY),
    mirrorSwipe: (x1, y1, x2, y2, duration) => ipcRenderer.invoke('mirror-swipe', x1, y1, x2, y2, duration),
    mirrorKeyEvent: (keycode) => ipcRenderer.invoke('mirror-keyevent', keycode),
    mirrorText: (text) => ipcRenderer.invoke('mirror-text', text),
    mirrorStatus: () => ipcRenderer.invoke('mirror-status'),

    // Mirror event listeners (push from main)
    onMirrorGesture: (callback) => {
        ipcRenderer.on('mirror-gesture', (event, data) => callback(data));
    },
    onMirrorStopped: (callback) => {
        ipcRenderer.on('mirror-stopped', () => callback());
    },

    // Stream frame listener (push from main process)
    onStreamFrame: (callback) => {
        ipcRenderer.on('stream-frame', (event, data) => callback(data));
    },

    // Device status change listener
    onDeviceStatusChange: (callback) => {
        ipcRenderer.on('device-status-change', (event, data) => callback(data));
    },

    onAppReady: (callback) => ipcRenderer.on('app-ready', callback),

    onWorkerUpdate: (callback) => {
        ipcRenderer.on('worker-update', (event, data) => callback(data));
    },

    onJobUpdate: (callback) => {
        ipcRenderer.on('job-update', (event, data) => callback(data));
    },
    toggleDebugVisualization: (enable) => ipcRenderer.invoke('toggle-debug-visualization', enable),
});
