const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execSync } = require('child_process');
const JobDatabase = require('./database');
const DeviceWorker = require('./Worker');
const JobGenerator = require('./JobGenerator');

// Scrcpy path
const SCRCPY_PATH = path.join(__dirname, 'scrcpy-win64-v3.3.3', 'scrcpy.exe');
const ADB_PATH = path.join(__dirname, 'scrcpy-win64-v3.3.3', 'adb.exe');

// Screen capture module (legacy polling fallback)
const ScreenCapture = require('./ScreenCapture');
let screenCapture = null;

// Realtime streaming module (push-based)
const ScrcpyStreamer = require('./ScrcpyStreamer');
let streamer = null;
let streamingMode = false; // true = realtime push, false = legacy polling

// Mirror control module
const MirrorController = require('./MirrorController');
let mirrorController = null;

let mainWindow = null;
let workerWindow = null;
let jobWindow = null;
let monitorWindow = null;
let devices = [];
let db = null;
const workers = new Map();
let jobCounter = 1;
let workerLoopInterval = null;

// Helper: Execute ADB command on all devices
function execAdbOnAllDevices(command) {
    return Promise.all(
        devices.map(device => {
            return new Promise((resolve) => {
                exec(`"${ADB_PATH}" -s ${device.device} ${command}`, { timeout: 5000, windowsHide: true }, (error) => {
                    if (error) {
                        console.error(`[${device.device}] ADB command failed:`, error.message);
                    }
                    resolve();
                });
            });
        })
    );
}

// Helper: Execute ADB command on specific devices
function execAdbOnDevices(deviceIds, command) {
    return Promise.all(
        deviceIds.map(deviceId => {
            return new Promise((resolve) => {
                exec(`"${ADB_PATH}" -s ${deviceId} ${command}`, { timeout: 5000, windowsHide: true }, (error) => {
                    if (error) {
                        console.error(`[${deviceId}] ADB command failed:`, error.message);
                    }
                    resolve();
                });
            });
        })
    );
}

// Separate toggle for show touches
async function toggleShowTouches(enable) {
    const value = enable ? 1 : 0;
    console.log(`${enable ? 'Enabling' : 'Disabling'} show touches...`);
    await execAdbOnAllDevices(`shell settings put system show_touches ${value}`);
    console.log(`Show touches ${enable ? 'enabled' : 'disabled'}`);
}

// Separate toggle for pointer location
async function togglePointerLocation(enable) {
    const value = enable ? 1 : 0;
    console.log(`${enable ? 'Enabling' : 'Disabling'} pointer location...`);
    await execAdbOnAllDevices(`shell settings put system pointer_location ${value}`);
    console.log(`Pointer location ${enable ? 'enabled' : 'disabled'}`);
}

// DEVICE MANAGEMENT
function loadDevices() {
    try {
        const data = fs.readFileSync(path.join(__dirname, 'devices.json'), 'utf8');
        const parsed = JSON.parse(data);
        devices = Array.isArray(parsed) ? parsed : (parsed.devices || []);

        devices.forEach(device => {
            workers.set(device.device, new DeviceWorker(device.device, db, device));
        });

        console.log(`Loaded ${devices.length} devices with workers`);
        return devices;
    } catch (err) {
        console.error('Failed to load devices:', err);
        return [];
    }
}

/**
 * Start ADB server and reconnect all WiFi devices
 * This is critical after PC restart — ADB server is dead, all connections lost
 */
async function initAdbAndReconnect() {
    console.log('[ADB] Starting ADB server and reconnecting devices...');
    
    // Step 1: Start ADB server
    try {
        await new Promise((resolve, reject) => {
            exec(`"${ADB_PATH}" start-server`, { timeout: 10000, windowsHide: true }, (err, stdout) => {
                if (err) { console.error('[ADB] start-server error:', err.message); reject(err); }
                else { console.log('[ADB] Server started'); resolve(stdout); }
            });
        });
    } catch (e) {
        console.error('[ADB] Failed to start server:', e.message);
    }

    // Step 2: Reconnect all WiFi/TCP devices from devices.json
    const tcpDevices = devices.filter(d => d.device && d.device.includes(':'));
    if (tcpDevices.length > 0) {
        console.log(`[ADB] Reconnecting ${tcpDevices.length} WiFi devices...`);
        
        // Connect in batches of 10 to avoid overloading
        const batchSize = 10;
        for (let i = 0; i < tcpDevices.length; i += batchSize) {
            const batch = tcpDevices.slice(i, i + batchSize);
            await Promise.allSettled(batch.map(d => new Promise((resolve) => {
                exec(`"${ADB_PATH}" connect ${d.device}`, { timeout: 5000, windowsHide: true }, (err, stdout) => {
                    if (stdout && stdout.includes('connected')) {
                        console.log(`[ADB] ✓ ${d.device}`);
                    }
                    resolve(); // always resolve
                });
            })));
            // Small delay between batches
            if (i + batchSize < tcpDevices.length) {
                await new Promise(r => setTimeout(r, 200));
            }
        }
    }

    // Step 3: Wait a moment then check which are actually online
    await new Promise(r => setTimeout(r, 1000));
    const onlineDevices = await scanAdbDevices();
    console.log(`[ADB] Reconnection complete: ${onlineDevices.length} devices online`);
    return onlineDevices;
}

/**
 * Scan for connected ADB devices (both USB and WiFi)
 * Returns array of device IDs that are currently online
 */
function scanAdbDevices() {
    return new Promise((resolve) => {
        exec(`"${ADB_PATH}" devices`, { timeout: 5000, windowsHide: true }, (err, stdout) => {
            if (err) { resolve([]); return; }
            const lines = stdout.split('\n').filter(l => l.includes('\tdevice'));
            const onlineIds = lines.map(l => l.split('\t')[0].trim()).filter(Boolean);
            resolve(onlineIds);
        });
    });
}

// WORKER LOOP - OPTIMIZED
let lastLoopLog = Date.now();
const pendingDbWrites = new Set();
let dbWriteTimer = null;

function workerLoop() {
    try {
        const runningJobs = db.getAllJobs().filter(j => j.status === 'running');

        if (Date.now() - lastLoopLog > 10000) {
            const activeWorkers = Array.from(workers.values()).filter(w => w.status === 'busy').length;
            console.log(`Workers: ${activeWorkers}/${workers.size} active, Jobs: ${runningJobs.length}`);
            lastLoopLog = Date.now();
        }

        for (const [deviceId, worker] of workers.entries()) {
            if (worker.isAvailable()) {
                for (const job of runningJobs) {
                    if (!job.deviceIds || !Array.isArray(job.deviceIds) || !job.deviceIds.includes(deviceId)) {
                        continue;
                    }

                    const task = db.getNextTask(job.id, deviceId);
                    if (task) {
                        worker.executeTask(task, job.id).then(result => {
                            procesTaskResult(task.id, job.id, result, deviceId);
                        }).catch(error => {
                            if (!error.message || !error.message.includes('Database closed')) {
                                console.error(`[${deviceId}] Task error:`, error.message);
                            }
                        });

                        break;
                    }
                }
            }
        }
    } catch (error) {
        console.error('Worker loop error:', error.message);
    }
}

function procesTaskResult(taskId, jobId, result, deviceId) {
    try {
        if (result.skipDbUpdate || db.isClosed) {
            return;
        }

        if (result.success) {
            db.completeTask(taskId, result.result);
        } else {
            db.failTask(taskId, result.error);
        }

        pendingDbWrites.add(jobId);

        if (!dbWriteTimer) {
            dbWriteTimer = setTimeout(() => {
                processPendingUpdates();
                dbWriteTimer = null;
            }, 500);
        }
    } catch (error) {
        if (!error.message || !error.message.includes('Database closed')) {
            console.error(`Process result error:`, error.message);
        }
    }
}

function processPendingUpdates() {
    if (db.isClosed) return;

    const jobsToUpdate = Array.from(pendingDbWrites);
    pendingDbWrites.clear();

    jobsToUpdate.forEach(jobId => {
        try {
            const counts = db.getTaskCounts(jobId);
            const job = db.getJob(jobId);
            
            if (job && job.type === 'super_marketing') {
                if (counts.failed > 0) {
                    db.db.run('UPDATE jobs SET failed_count = ? WHERE id = ?', 
                        [counts.failed, jobId]);
                    db.save();
                }
            } else {
                db.updateJobProgress(jobId, counts.completed, counts.failed);
            }

            if (counts.pending === 0 && counts.running === 0) {
                db.updateJobStatus(jobId, 'completed', { completedAt: Date.now() });
                notifyJobUpdate(jobId, 'completed');
            } else {
                notifyJobUpdate(jobId, 'task_completed');
            }
        } catch (error) {
            if (!error.message || !error.message.includes('Database closed')) {
                console.error(`Update job ${jobId} error:`, error.message);
            }
        }
    });
}

function startWorkerLoop() {
    if (workerLoopInterval) return;

    workerLoopInterval = setInterval(() => {
        setImmediate(() => workerLoop());
    }, 1000);

    console.log('Worker loop started');
}

function stopWorkerLoop() {
    if (workerLoopInterval) {
        clearInterval(workerLoopInterval);
        workerLoopInterval = null;
    }

    if (dbWriteTimer) {
        clearTimeout(dbWriteTimer);
        dbWriteTimer = null;
    }

    if (pendingDbWrites.size > 0) {
        processPendingUpdates();
    }

    console.log('Worker loop stopped');
}

// NOTIFICATIONS
const pendingJobUpdates = new Set();
let batchUpdateTimer = null;

function notifyJobUpdate(jobId, event, data = {}) {
    const immediateEvents = ['completed', 'cancelled', 'started', 'deleted'];

    if (immediateEvents.includes(event)) {
        sendJobUpdate(jobId, event, data);
        return;
    }

    pendingJobUpdates.add(jobId);

    if (!batchUpdateTimer) {
        batchUpdateTimer = setTimeout(() => {
            pendingJobUpdates.forEach(jId => {
                sendJobUpdate(jId, 'progress_update', {});
            });

            pendingJobUpdates.clear();
            batchUpdateTimer = null;
        }, 1000);
    }
}

function sendJobUpdate(jobId, event, data = {}) {
    const job = db.getJob(jobId);
    const counts = job ? db.getTaskCounts(jobId) : null;

    const payload = {
        jobId,
        event,
        data: { ...data, job, counts },
        timestamp: Date.now()
    };

    [mainWindow, workerWindow, jobWindow, monitorWindow].forEach(win => {
        if (win && !win.isDestroyed()) {
            win.webContents.send('job-update', payload);
        }
    });
}

function notifyWorkerUpdate(deviceId, event, task = null, error = null) {
    const data = { deviceId, event, task, error, timestamp: Date.now() };

    [mainWindow, workerWindow, jobWindow, monitorWindow].forEach(win => {
        if (win && !win.isDestroyed()) {
            win.webContents.send('worker-update', data);
        }
    });
}

// IPC HANDLERS
ipcMain.handle('get-devices', () => {
    return { success: true, devices };
});

ipcMain.handle('get-workers', () => {
    const workerStates = Array.from(workers.entries()).map(([deviceId, worker]) => ({
        deviceId,
        status: worker.status,
        currentTask: worker.currentTask,
        currentJobId: worker.currentJobId,
        manuallyPaused: worker.manuallyPaused
    }));
    return { success: true, workers: workerStates };
});

ipcMain.handle('pause-worker', (event, deviceId) => {
    const worker = workers.get(deviceId);
    if (worker) {
        const success = worker.pauseManually();
        notifyWorkerUpdate(deviceId, 'manually_paused');
        return { success };
    }
    return { success: false };
});

ipcMain.handle('resume-worker', (event, deviceId) => {
    const worker = workers.get(deviceId);
    if (worker) {
        const success = worker.resumeManually();
        notifyWorkerUpdate(deviceId, 'manually_resumed');
        return { success };
    }
    return { success: false };
});

ipcMain.handle('create-job', (event, data) => {
    const { type, config, deviceIds } = data;
    const jobId = `job_${Date.now()}_${jobCounter++}`;

    try {
        const tasks = JobGenerator.generateTasks(jobId, type, config, deviceIds);

        let initialTotal = tasks.length;
        if (type === 'super_marketing') {
            const targetCycles = config.numWatching || 100;
            initialTotal = deviceIds.length * targetCycles;
        }

        db.createJob({
            id: jobId,
            type,
            status: 'pending',
            config,
            deviceIds,
            initialTotal: initialTotal,
            createdAt: Date.now()
        });

        db.createTasks(tasks);

        if (type === 'boost_live' && config.comments && config.comments.length > 0) {
            db.createCommentPool(jobId, config.comments, deviceIds.length);
        }

        setTimeout(() => {
            db.updateJobStatus(jobId, 'running', { startedAt: Date.now() });
            notifyJobUpdate(jobId, 'started');
        }, 100);

        const job = db.getJob(jobId);
        const counts = db.getTaskCounts(jobId);

        return {
            success: true,
            job: { ...job, ...counts }
        };
    } catch (error) {
        console.error('Failed to create job:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-jobs', () => {
    const jobs = db.getAllJobs().map(job => {
        const counts = db.getTaskCounts(job.id);
        
        let completedCount = counts.completed;
        if (job.type === 'super_marketing') {
            completedCount = job.completed_count || 0;
        }
        
        return {
            ...job,
            completed: completedCount,
            failed: counts.failed,
            remaining: counts.pending + counts.running,
            total: job.initial_total
        };
    });
    return { success: true, jobs };
});

ipcMain.handle('pause-job', (event, jobId) => {
    db.updateJobStatus(jobId, 'paused');
    notifyJobUpdate(jobId, 'paused');
    return { success: true };
});

ipcMain.handle('resume-job', (event, jobId) => {
    db.updateJobStatus(jobId, 'running');
    notifyJobUpdate(jobId, 'resumed');
    return { success: true };
});

// UPDATED: Cancel job now also closes TikTok
ipcMain.handle('cancel-job', async (event, jobId) => {
    try {
        const job = db.getJob(jobId);
        
        db.updateJobStatus(jobId, 'cancelled');
        db.db.prepare('UPDATE tasks SET status = ? WHERE job_id = ? AND status IN (?, ?)')
            .run('cancelled', jobId, 'pending', 'running');
        db.save();

        if (job && job.deviceIds && job.deviceIds.length > 0) {
            console.log(`[Cancel Job] Closing TikTok on ${job.deviceIds.length} devices...`);
            await execAdbOnDevices(job.deviceIds, 'shell am force-stop com.zhiliaoapp.musically');
            console.log(`[Cancel Job] TikTok closed on all job devices`);
        }

        notifyJobUpdate(jobId, 'cancelled');
        return { success: true };
    } catch (error) {
        console.error('Failed to cancel job:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('retry-job', (event, jobId) => {
    db.retryFailedTasks(jobId);
    db.updateJobStatus(jobId, 'running');
    notifyJobUpdate(jobId, 'retrying');
    return { success: true };
});

ipcMain.handle('delete-job', (event, jobId) => {
    db.deleteJob(jobId);
    notifyJobUpdate(jobId, 'deleted');
    return { success: true };
});

ipcMain.handle('open-worker-window', () => {
    createWorkerWindow();
    return { success: true };
});

ipcMain.handle('open-job-window', () => {
    createJobWindow();
    return { success: true };
});

ipcMain.handle('open-tiktok-bulk', async (event, deviceIds) => {
    try {
        console.log(`Opening TikTok on ${deviceIds.length} devices in parallel...`);

        const results = await Promise.all(
            deviceIds.map(async (deviceId) => {
                try {
                    await new Promise((resolve, reject) => {
                        exec(`"${ADB_PATH}" -s ${deviceId} shell monkey -p com.zhiliaoapp.musically 1`,
                            { timeout: 8000, windowsHide: true },
                            (error, stdout) => {
                                if (error) reject(error);
                                else resolve(stdout);
                            }
                        );
                    });

                    console.log(`Opened TikTok on ${deviceId}`);
                    return { deviceId, success: true };
                } catch (error) {
                    console.error(`Failed to open TikTok on ${deviceId}:`, error.message);
                    return { deviceId, success: false, error: error.message };
                }
            })
        );

        const successCount = results.filter(r => r.success).length;
        const failCount = results.filter(r => !r.success).length;
        console.log(`Bulk open completed: ${successCount} success, ${failCount} failed`);

        return { success: true, results };
    } catch (error) {
        console.error('Bulk open TikTok failed:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('close-tiktok-bulk', async (event, deviceIds) => {
    try {
        console.log(`Closing TikTok on ${deviceIds.length} devices in parallel...`);

        const results = await Promise.all(
            deviceIds.map(async (deviceId) => {
                try {
                    await new Promise((resolve, reject) => {
                        exec(`"${ADB_PATH}" -s ${deviceId} shell am force-stop com.zhiliaoapp.musically`,
                            { timeout: 5000, windowsHide: true },
                            (error, stdout) => {
                                if (error) reject(error);
                                else resolve(stdout);
                            }
                        );
                    });

                    console.log(`Closed TikTok on ${deviceId}`);
                    return { deviceId, success: true };
                } catch (error) {
                    console.error(`Failed to close TikTok on ${deviceId}:`, error.message);
                    return { deviceId, success: false, error: error.message };
                }
            })
        );

        const successCount = results.filter(r => r.success).length;
        const failCount = results.filter(r => !r.success).length;
        console.log(`Bulk close completed: ${successCount} success, ${failCount} failed`);

        return { success: true, results };
    } catch (error) {
        console.error('Bulk close TikTok failed:', error);
        return { success: false, error: error.message };
    }
});

// UPDATED: Cancel all jobs now also closes TikTok
ipcMain.handle('cancel-all-jobs', async () => {
    try {
        const allJobs = db.getAllJobs();
        const activeJobs = allJobs.filter(j => j.status === 'running' || j.status === 'pending');

        if (activeJobs.length === 0) {
            return { success: true, count: 0, message: 'No active jobs to cancel' };
        }

        console.log(`Cancelling ${activeJobs.length} active job(s)...`);

        const allDeviceIds = new Set();
        
        for (const job of activeJobs) {
            db.updateJobStatus(job.id, 'cancelled');
            db.db.prepare('UPDATE tasks SET status = ? WHERE job_id = ? AND status IN (?, ?)')
                .run('cancelled', job.id, 'pending', 'running');

            if (job.deviceIds && Array.isArray(job.deviceIds)) {
                job.deviceIds.forEach(id => allDeviceIds.add(id));
            }

            notifyJobUpdate(job.id, 'cancelled');
        }

        db.save();

        const deviceArray = Array.from(allDeviceIds);
        if (deviceArray.length > 0) {
            console.log(`[Cancel All] Closing TikTok on ${deviceArray.length} devices...`);
            await execAdbOnDevices(deviceArray, 'shell am force-stop com.zhiliaoapp.musically');
            console.log(`[Cancel All] TikTok closed on all devices`);
        }

        console.log(`Cancelled ${activeJobs.length} job(s)`);
        return { success: true, count: activeJobs.length };
    } catch (error) {
        console.error('Failed to cancel all jobs:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('delete-all-jobs', async () => {
    try {
        const allJobs = db.getAllJobs();

        if (allJobs.length === 0) {
            return { success: true, count: 0, message: 'No jobs to delete' };
        }

        console.log(`Deleting ${allJobs.length} job(s)...`);

        try { db.db.run('DELETE FROM tasks'); } catch (e) { }
        try { db.db.run('DELETE FROM job_comments'); } catch (e) { }
        try { db.db.run('DELETE FROM job_comment_cycles'); } catch (e) { }
        try { db.db.run('DELETE FROM jobs'); } catch (e) { }

        db.save();

        console.log(`Deleted ${allJobs.length} job(s)`);
        allJobs.forEach(job => notifyJobUpdate(job.id, 'deleted'));

        return { success: true, count: allJobs.length };
    } catch (error) {
        console.error('Failed to delete all jobs:', error);
        return { success: false, error: error.message };
    }
});

// NEW: Refill comments
ipcMain.handle('refill-comments', async (event, jobId, comments) => {
    try {
        if (!comments || !Array.isArray(comments) || comments.length === 0) {
            return { success: false, error: 'No comments provided' };
        }

        const result = db.refillComments(jobId, comments);
        
        if (result.success) {
            console.log(`[Refill] Added ${result.count} comments to job ${jobId}`);
            notifyJobUpdate(jobId, 'comments_refilled', { count: result.count });
        }

        return result;
    } catch (error) {
        console.error('Failed to refill comments:', error);
        return { success: false, error: error.message };
    }
});

// NEW: Get comment stats
ipcMain.handle('get-comment-stats', async (event, jobId) => {
    try {
        const stats = db.getCommentStats(jobId);
        return { success: true, stats };
    } catch (error) {
        console.error('Failed to get comment stats:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('toggle-show-touches', async (event, enable) => {
    try {
        await toggleShowTouches(enable);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('toggle-pointer-location', async (event, enable) => {
    try {
        await togglePointerLocation(enable);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Toggle debug visualization overlay
ipcMain.handle('toggle-debug-visualization', async (event, enable) => {
    try {
        const value = enable ? 1 : 0;
        await execAdbOnAllDevices(`shell setprop debug.layout ${value}`);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Toggle tap monitoring on a specific device
ipcMain.handle('toggle-tap-monitoring', async (event, deviceId, enable) => {
    try {
        const value = enable ? 1 : 0;
        exec(`"${ADB_PATH}" -s ${deviceId} shell settings put system show_touches ${value}`, { timeout: 5000, windowsHide: true });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// ============================================
// MONITOR IPC HANDLERS (Realtime Streaming + Legacy Fallback)
// ============================================

function ensureScreenCapture() {
    if (!screenCapture) {
        screenCapture = new ScreenCapture({
            thumbnailWidth: 140, // was 180
            jpegQuality: 30, // was 40
            maxConcurrent: 12, // was 10
            cacheMaxAge: 600, // was 800
            captureTimeout: 3500, // was 4000
            adbPath: ADB_PATH
        });
    }
    return screenCapture;
}

function ensureStreamer() {
    if (!streamer) {
        streamer = new ScrcpyStreamer({
            thumbnailWidth: 140, // was 180 — smaller = faster
            jpegQuality: 30, // was 40 — lower = faster
            adbPath: ADB_PATH,
            scrcpyPath: SCRCPY_PATH,
            maxConcurrent: 20, // was 15
            breathDelay: 20 // minimal delay between frames
        });

        // When streamer emits a frame, push to monitor window AND update legacy cache
        streamer.on('frame', (frameData) => {
            // Update legacy cache so getCachedFrames works
            ensureScreenCapture().injectFrame(
                frameData.deviceId, frameData.data, frameData.mimeType, frameData.size
            );

            // Push frame directly to monitor window (REALTIME!)
            if (monitorWindow && !monitorWindow.isDestroyed()) {
                monitorWindow.webContents.send('stream-frame', {
                    deviceId: frameData.deviceId,
                    data: frameData.data,
                    mimeType: frameData.mimeType,
                    size: frameData.size,
                    captureTime: frameData.captureTime
                });
            }
        });

        // When device goes offline
        streamer.on('device-offline', (info) => {
            if (monitorWindow && !monitorWindow.isDestroyed()) {
                monitorWindow.webContents.send('device-status-change', {
                    deviceId: info.deviceId,
                    online: false,
                    error: info.error
                });
            }
        });
    }
    return streamer;
}

// Start realtime streaming
ipcMain.handle('start-streaming', async (event, deviceIds) => {
    try {
        const s = ensureStreamer();
        s.startStreaming(deviceIds);
        streamingMode = true;
        console.log(`[Monitor] Realtime streaming started for ${deviceIds.length} devices`);
        return { success: true, mode: 'realtime' };
    } catch (error) {
        console.error('[Monitor] Failed to start streaming:', error);
        return { success: false, error: error.message };
    }
});

// Stop realtime streaming
ipcMain.handle('stop-streaming', async () => {
    try {
        if (streamer) {
            streamer.stopStreaming();
            streamingMode = false;
        }
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Get streaming stats
ipcMain.handle('get-stream-stats', async () => {
    if (streamer) return { success: true, stats: streamer.getStats() };
    return { success: true, stats: {} };
});

// Restart stream for a specific device
ipcMain.handle('restart-device-stream', async (event, deviceId) => {
    if (streamer) { streamer.restartDevice(deviceId); return { success: true }; }
    return { success: false };
});

// Legacy: Capture screenshot from a single device
ipcMain.handle('capture-screenshot', async (event, deviceId) => {
    const sc = ensureScreenCapture();
    const result = await sc.getScreenshot(deviceId);
    if (result.success) {
        return { success: true, data: result.data, mimeType: result.mimeType || 'image/jpeg', fromCache: result.fromCache || false, size: result.size };
    }
    return { success: false, error: result.error };
});

// Legacy: Batch capture screenshots (used when streaming is off)
ipcMain.handle('batch-capture-screenshots', async (event, deviceIds) => {
    const sc = ensureScreenCapture();

    // If streaming is active, just return cached frames from stream
    if (streamingMode && streamer) {
        const output = {};
        for (const deviceId of deviceIds) {
            const frame = streamer.getFrame(deviceId);
            if (frame) {
                output[deviceId] = { success: true, data: frame.base64, mimeType: frame.mimeType, fromCache: true, size: frame.size };
            } else {
                output[deviceId] = { success: false, error: 'No stream frame yet' };
            }
        }
        return { success: true, results: output };
    }

    // Fallback to legacy batch capture
    const results = await sc.batchCapture(deviceIds);
    const output = {};
    for (const [deviceId, result] of results.entries()) {
        output[deviceId] = result;
    }
    return { success: true, results: output };
});

// Get cached frames (for quick initial load)
ipcMain.handle('get-cached-frames', async () => {
    // Prefer streamer cache if available
    if (streamer && streamingMode) {
        return { success: true, frames: streamer.getAllCachedFrames() };
    }
    const sc = ensureScreenCapture();
    return { success: true, frames: sc.getAllCachedFrames() };
});

// Get capture stats
ipcMain.handle('get-capture-stats', async () => {
    const legacyStats = screenCapture ? screenCapture.getMemoryStats() : {};
    const streamStats = streamer ? streamer.getStats() : {};
    return { success: true, stats: { ...legacyStats, streaming: streamStats, mode: streamingMode ? 'realtime' : 'polling' } };
});

// Update capture settings
ipcMain.handle('update-capture-settings', async (event, settings) => {
    if (screenCapture) screenCapture.updateSettings(settings);
    if (streamer) streamer.updateSettings(settings);
    return { success: true };
});

// ============================================
// MIRROR CONTROL IPC HANDLERS
// ============================================

function ensureMirrorController() {
    if (!mirrorController) {
        mirrorController = new MirrorController({
            adbPath: ADB_PATH,
            scrcpyPath: SCRCPY_PATH
        });
    }
    return mirrorController;
}

ipcMain.handle('mirror-start', async (event, masterDeviceId, allDeviceIds, resolution) => {
    try {
        const mc = ensureMirrorController();

        mc.removeAllListeners('gesture');
        mc.removeAllListeners('master-closed');

        mc.on('gesture', (data) => {
            if (monitorWindow && !monitorWindow.isDestroyed()) {
                monitorWindow.webContents.send('mirror-gesture', data);
            }
        });

        mc.on('master-closed', () => {
            if (monitorWindow && !monitorWindow.isDestroyed()) {
                monitorWindow.webContents.send('mirror-stopped');
            }
        });

        // Pass ALL device info so MirrorController can scale per-device resolution
        const allDeviceInfo = devices.filter(d => allDeviceIds.includes(d.device));
        const result = mc.startMirror(masterDeviceId, allDeviceIds, resolution, allDeviceInfo);
        console.log(`[Mirror] Started: master=${masterDeviceId}, total=${allDeviceIds.length}`);
        return result;
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('mirror-stop', async () => {
    try {
        if (mirrorController) return mirrorController.stopMirror();
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('mirror-tap', async (event, normX, normY) => {
    if (!mirrorController) return { success: false };
    return mirrorController.sendTap(normX, normY);
});

ipcMain.handle('mirror-swipe', async (event, x1, y1, x2, y2, duration) => {
    if (!mirrorController) return { success: false };
    return mirrorController.sendSwipe(x1, y1, x2, y2, duration);
});

ipcMain.handle('mirror-keyevent', async (event, keycode) => {
    if (!mirrorController) return { success: false };
    return mirrorController.sendKeyEvent(keycode);
});

ipcMain.handle('mirror-text', async (event, text) => {
    if (!mirrorController) return { success: false };
    return mirrorController.sendText(text);
});

ipcMain.handle('mirror-status', async () => {
    if (!mirrorController) return { success: true, status: { isActive: false } };
    return { success: true, status: mirrorController.getStatus() };
});

// Open scrcpy for a specific device
ipcMain.handle('open-scrcpy', async (event, deviceId) => {
    try {
        const scrcpyExe = fs.existsSync(SCRCPY_PATH) ? `"${SCRCPY_PATH}"` : 'scrcpy';
        const cmd = `${scrcpyExe} -s ${deviceId} --window-title "J99Tix - ${deviceId}" --max-size 800 --max-fps 30 --video-bit-rate 2M --no-audio`;

        exec(cmd, { timeout: 0 }, (error) => {
            if (error && !error.killed) {
                console.error(`scrcpy error for ${deviceId}:`, error.message);
            }
        });

        console.log(`[Monitor] scrcpy opened for ${deviceId}`);
        return { success: true };
    } catch (error) {
        console.error(`[Monitor] scrcpy failed for ${deviceId}:`, error.message);
        return { success: false, error: error.message };
    }
});

// Batch ADB command on specific devices
ipcMain.handle('batch-adb-command', async (event, deviceIds, command) => {
    try {
        console.log(`[Monitor] Batch command: "${command}" on ${deviceIds.length} devices`);

        const results = await Promise.all(
            deviceIds.map(async (deviceId) => {
                try {
                    const output = await new Promise((resolve, reject) => {
                        exec(`"${ADB_PATH}" -s ${deviceId} ${command}`, { timeout: 15000, windowsHide: true }, (error, stdout, stderr) => {
                            if (error) reject(error);
                            else resolve(stdout || stderr || 'OK');
                        });
                    });
                    return { deviceId, success: true, output: output.trim() };
                } catch (error) {
                    return { deviceId, success: false, error: error.message };
                }
            })
        );

        const successCount = results.filter(r => r.success).length;
        console.log(`[Monitor] Batch complete: ${successCount}/${deviceIds.length} success`);

        return { success: true, results };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Batch install APK
ipcMain.handle('batch-install-apk', async (event, deviceIds, apkPath) => {
    try {
        console.log(`[Monitor] Installing APK: ${apkPath} on ${deviceIds.length} devices`);

        const results = await Promise.all(
            deviceIds.map(async (deviceId) => {
                try {
                    await new Promise((resolve, reject) => {
                        exec(`"${ADB_PATH}" -s ${deviceId} install -r "${apkPath}"`, { timeout: 120000, windowsHide: true }, (error, stdout) => {
                            if (error) reject(error);
                            else resolve(stdout);
                        });
                    });
                    return { deviceId, success: true };
                } catch (error) {
                    return { deviceId, success: false, error: error.message };
                }
            })
        );

        return { success: true, results };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Open monitor window
ipcMain.handle('open-monitor-window', () => {
    createMonitorWindow();
    return { success: true };
});

// Scan for connected ADB devices
ipcMain.handle('scan-adb-devices', async () => {
    try {
        const onlineIds = await scanAdbDevices();
        return { success: true, onlineDevices: onlineIds, totalKnown: devices.length };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Reconnect all WiFi devices (after PC restart)
ipcMain.handle('reconnect-devices', async () => {
    try {
        const onlineDevices = await initAdbAndReconnect();
        return { success: true, onlineDevices, totalKnown: devices.length };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// WINDOWS
function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 900,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        },
        autoHideMenuBar: true,
        title: 'J99Tix - Create Jobs',
        backgroundColor: '#0a0e27'
    });

    mainWindow.loadFile('index.html');
    mainWindow.on('closed', () => { mainWindow = null; });
}

function createWorkerWindow() {
    if (workerWindow) {
        workerWindow.focus();
        return;
    }

    workerWindow = new BrowserWindow({
        width: 600,
        height: 700,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        },
        autoHideMenuBar: true,
        title: 'J99Tix - Workers',
        backgroundColor: '#0a0e27'
    });

    workerWindow.loadFile('workers.html');
    workerWindow.on('closed', () => { workerWindow = null; });
}

function createJobWindow() {
    if (jobWindow) {
        jobWindow.focus();
        return;
    }

    jobWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        },
        autoHideMenuBar: true,
        title: 'Job Manager - J99Tix',
        backgroundColor: '#0a0e27'
    });

    jobWindow.loadFile('jobs.html');
    jobWindow.on('closed', () => { jobWindow = null; });
}

function createMonitorWindow() {
    if (monitorWindow) {
        monitorWindow.focus();
        return;
    }

    monitorWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        },
        autoHideMenuBar: true,
        title: 'Device Monitor - J99Tix',
        backgroundColor: '#0a0e1a'
    });

    monitorWindow.loadFile('monitor.html');
    monitorWindow.maximize();
    monitorWindow.on('closed', () => {
        // Stop streaming when monitor closes
        if (streamer) {
            streamer.stopStreaming();
            streamingMode = false;
            console.log('[Monitor] Streaming stopped (window closed)');
        }
        monitorWindow = null;
    });
}

// HELPER: CANCEL ALL JOBS (for app quit)
async function cancelAllJobsOnQuit() {
    try {
        console.log('=== CANCEL ALL JOBS START ===');

        const allJobs = db.getAllJobs();
        const activeJobs = allJobs.filter(j => j.status === 'running' || j.status === 'pending');

        if (activeJobs.length === 0) {
            console.log('No active jobs to cancel');
            return;
        }

        console.log('Cancelling jobs...');

        const allDeviceIds = new Set();

        for (const job of activeJobs) {
            db.updateJobStatus(job.id, 'cancelled');

            const stmt = db.db.prepare('UPDATE tasks SET status = ? WHERE job_id = ? AND status IN (?, ?)');
            stmt.run(['cancelled', job.id, 'pending', 'running']);
            stmt.free();

            if (job.deviceIds && Array.isArray(job.deviceIds)) {
                job.deviceIds.forEach(id => allDeviceIds.add(id));
            }
        }

        const data = db.db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(db.dbPath, buffer);

        const deviceArray = Array.from(allDeviceIds);
        if (deviceArray.length > 0) {
            console.log(`Closing TikTok on ${deviceArray.length} devices...`);
            await execAdbOnDevices(deviceArray, 'shell am force-stop com.zhiliaoapp.musically');
        }

        console.log('=== CANCEL ALL JOBS COMPLETE ===');
    } catch (error) {
        console.error('Failed to cancel jobs:', error);
    }
}

// APP LIFECYCLE
app.whenReady().then(async () => {
    db = new JobDatabase();
    await db.init();

    loadDevices();
    
    // Auto-start ADB and reconnect devices (critical after PC restart!)
    initAdbAndReconnect().catch(e => console.error('[ADB] Init error:', e.message));

    createMainWindow();

    mainWindow.webContents.on('did-finish-load', () => {
        console.log('Main window loaded');

        setTimeout(() => {
            startWorkerLoop();

            setTimeout(() => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('app-ready');
                    console.log('App ready signal sent');
                }
            }, 1000);
        }, 500);
    });
});

app.on('window-all-closed', () => {
    stopWorkerLoop();
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('before-quit', async (event) => {
    event.preventDefault();

    console.log('=== APP QUITTING ===');

    stopWorkerLoop();

    let waitCount = 0;
    const maxWait = 20;

    while (waitCount < maxWait) {
        const busyWorkers = Array.from(workers.values()).filter(w => w.status === 'busy');
        if (busyWorkers.length === 0) {
            console.log('All workers idle');
            break;
        }
        if (waitCount % 5 === 0) {
            console.log(`Waiting for ${busyWorkers.length} workers...`);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
        waitCount++;
    }

    const stillBusy = Array.from(workers.values()).filter(w => w.status === 'busy');
    if (stillBusy.length > 0) {
        console.log(`Forcing ${stillBusy.length} workers to idle...`);
        stillBusy.forEach(w => w.status = 'idle');
    }

    console.log('Cancelling active jobs...');
    await cancelAllJobsOnQuit();

    console.log('Verifying database file...');
    if (fs.existsSync(db.dbPath)) {
        const stats = fs.statSync(db.dbPath);
        console.log(`Database file size: ${stats.size} bytes`);
    }

    try {
        await toggleShowTouches(false);
        await togglePointerLocation(false);
    } catch (e) {
        console.error('Toggle error:', e);
    }

    if (db && !db.isClosed) {
        console.log('Closing database...');
        db.close();
    }

    // Cleanup screen capture and streamer
    if (screenCapture) {
        screenCapture.destroy();
    }
    if (streamer) {
        streamer.destroy();
    }
    if (mirrorController) {
        mirrorController.destroy();
    }

    console.log('=== EXITING ===');
    app.exit(0);
});
