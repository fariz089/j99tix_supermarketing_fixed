const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execSync } = require('child_process');
const AsyncJobDatabase = require('./database-async');
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
            const worker = new DeviceWorker(device.device, db, device);
            worker.isJobCancelledFn = isJobCancelled; // FIX: fast cancel check
            workers.set(device.device, worker);
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

// WORKER LOOP - OPTIMIZED v2
let lastLoopLog = Date.now();
const pendingDbWrites = new Set();
let dbWriteTimer = null;
let lastStaleCheck = Date.now();

// FIX: Cache cancelled job IDs in memory so workers don't need to query DB every second
const cancelledJobIds = new Set();

// FIX: Cache running jobs to avoid calling getAllJobs() every loop iteration
let cachedRunningJobs = [];
let lastJobCacheRefresh = 0;
const JOB_CACHE_TTL = 3000; // refresh running jobs cache every 3 seconds

/**
 * Recover stale tasks — tasks stuck in 'running' status because:
 * 1. Worker crashed/disconnected during execution
 * 2. detectDisplay threw an uncaught error (now fixed)
 * 3. ADB timeout left worker in limbo
 * 
 * Also auto-retry failed tasks so devices don't go permanently idle.
 */
async function recoverStaleTasks() {
    try {
        // Build worker status map for the DB worker thread
        const workerStatusMap = {};
        for (const [deviceId, worker] of workers.entries()) {
            workerStatusMap[deviceId] = {
                status: worker.status,
                currentTaskId: worker.currentTask ? worker.currentTask.id : null
            };
        }
        const recovered = await db.recoverStaleTasks(workerStatusMap);
        if (recovered > 0) {
            console.log(`[Recovery] Recovered ${recovered} tasks`);
        }
    } catch (e) {
        console.error('[Recovery] Error:', e.message);
    }
}

async function workerLoop() {
    try {
        // FIX: Use cached running jobs instead of querying DB every iteration
        const now = Date.now();
        if (now - lastJobCacheRefresh > JOB_CACHE_TTL) {
            const allJobs = await db.getAllJobs();
            cachedRunningJobs = (allJobs || []).filter(j => j.status === 'running');
            lastJobCacheRefresh = now;
        }
        const runningJobs = cachedRunningJobs;

        // FIX: Run stale task recovery every 60 seconds
        if (now - lastStaleCheck > 60000) {
            lastStaleCheck = now;
            recoverStaleTasks();
        }

        if (now - lastLoopLog > 10000) {
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

                    const task = await db.getNextTask(job.id, deviceId);
                    if (task) {
                        worker.executeTask(task, job.id).then(result => {
                            procesTaskResult(task.id, job.id, result, deviceId);
                        }).catch(error => {
                            // CRITICAL: If executeTask promise rejects, reset worker status
                            worker.status = 'idle';
                            worker.currentTask = null;
                            worker.currentJobId = null;
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

async function procesTaskResult(taskId, jobId, result, deviceId) {
    try {
        if (result.skipDbUpdate || db.isClosed) {
            return;
        }

        if (result.success) {
            await db.completeTask(taskId, result.result);
        } else {
            await db.failTask(taskId, result.error);
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

/**
 * Post-job cleanup — dipanggil sekali setelah job selesai.
 * Tujuannya: bebaskan RAM & cegah WAL bloat sehingga tidak perlu restart
 * komputer di antara run.
 *
 * Yang dibersihkan:
 *   1. cancelledJobIds Set entry untuk job ini
 *   2. Worker state stale (_liveContext, _touchDevice tetap karena valid)
 *   3. DB internal cache untuk job ini (_countCache)
 *   4. WAL checkpoint TRUNCATE — shrink WAL file ke 0 byte
 *   5. SQLite shrink_memory — release page cache
 *   6. Force GC kalau --expose-gc dijalankan (best-effort)
 */
async function postJobCleanup(jobId) {
    try {
        // 1. Hapus dari Set in-memory yang terus tumbuh
        cancelledJobIds.delete(jobId);

        // 2. Reset worker per-job state (jangan reset display info — masih valid)
        for (const [, worker] of workers.entries()) {
            if (worker.currentJobId === jobId) {
                worker.currentJobId = null;
                worker.currentTask = null;
            }
            // Bersihkan context per-task yang nempel di worker
            if (worker._liveContext) worker._liveContext = null;
        }

        // 3. Cleanup DB cache untuk job ini
        if (db && !db.isClosed) {
            try { await db.cleanupCompletedJob(jobId); } catch (e) { }

            // 4. Checkpoint WAL — TRUNCATE supaya file shrink ke 0
            // Ini penting: tanpa ini, WAL bisa tumbuh ratusan MB → SQLite lambat
            try {
                const r = await db.walCheckpoint('TRUNCATE');
                if (r && r.success) {
                    console.log(`[Cleanup] WAL checkpoint TRUNCATE done for ${jobId}`);
                }
            } catch (e) { }

            // 5. Release SQLite page cache back to OS
            try { await db.releaseMemory(); } catch (e) { }
        }

        // 6. Best-effort GC (hanya jalan kalau electron di-launch dengan --js-flags="--expose-gc")
        if (global.gc) {
            try { global.gc(); } catch (e) { }
        }

        // Log heap size untuk monitoring
        const mem = process.memoryUsage();
        const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
        const rssMB = Math.round(mem.rss / 1024 / 1024);
        console.log(`[Cleanup] Job ${jobId} done | Heap: ${heapMB}MB | RSS: ${rssMB}MB`);
    } catch (e) {
        console.error(`[Cleanup] Error for ${jobId}:`, e.message);
    }
}

async function processPendingUpdates() {
    if (db.isClosed) return;

    const jobsToUpdate = Array.from(pendingDbWrites);
    pendingDbWrites.clear();

    for (const jobId of jobsToUpdate) {
        try {
            const counts = await db.getTaskCounts(jobId);
            const job = await db.getJob(jobId);
            
            if (job && job.type === 'super_marketing') {
                if (counts.failed > 0) {
                    await db.updateJobFailedCount(jobId, counts.failed);
                }
            } else {
                await db.updateJobProgress(jobId, counts.completed, counts.failed);
            }

            if (counts.pending === 0 && counts.running === 0) {
                await db.updateJobStatus(jobId, 'completed', { completedAt: Date.now() });
                notifyJobUpdate(jobId, 'completed');
                // FIX: post-completion cleanup — bersihkan cache & WAL supaya
                // RAM tidak menumpuk antar job (jadi tidak perlu restart komputer)
                await postJobCleanup(jobId);
            } else {
                notifyJobUpdate(jobId, 'task_completed');
            }
        } catch (error) {
            if (!error.message || !error.message.includes('Database closed')) {
                console.error(`Update job ${jobId} error:`, error.message);
            }
        }
    }
}

function startWorkerLoop() {
    if (workerLoopInterval) return;

    // FIX v2: Use recursive setTimeout instead of setInterval.
    // setInterval + async = overlapping calls if async takes longer than interval.
    // setTimeout chain ensures the next iteration only starts after the previous completes.
    // With async DB (worker thread), this loop no longer blocks the event loop at all!
    function scheduleNext() {
        workerLoopInterval = setTimeout(async () => {
            await workerLoop();
            if (workerLoopInterval !== null) scheduleNext();
        }, 1000);
    }
    scheduleNext();
    console.log('Worker loop started (1000ms async interval, DB on worker thread)');

    // FIX: periodic maintenance loop — jalan setiap 5 menit untuk job yang
    // jalan lama (misal supermarketing 30 menit). Tanpa ini, WAL bisa tumbuh
    // jadi ratusan MB selama job berjalan dan bikin SQLite lambat.
    startMaintenanceLoop();
}

let maintenanceInterval = null;
function startMaintenanceLoop() {
    if (maintenanceInterval) return;

    const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000; // 5 menit

    maintenanceInterval = setInterval(async () => {
        try {
            if (db && !db.isClosed) {
                // PASSIVE checkpoint = aman dipanggil saat ada writer aktif,
                // tidak akan block. Hanya truncate WAL kalau memungkinkan.
                await db.walCheckpoint('PASSIVE');
                await db.releaseMemory();
            }
            if (global.gc) { try { global.gc(); } catch (e) { } }

            const mem = process.memoryUsage();
            const rssMB = Math.round(mem.rss / 1024 / 1024);
            const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
            console.log(`[Maintenance] Heap: ${heapMB}MB | RSS: ${rssMB}MB`);
        } catch (e) {
            console.error('[Maintenance] Error:', e.message);
        }
    }, MAINTENANCE_INTERVAL_MS);
}

function stopMaintenanceLoop() {
    if (maintenanceInterval) {
        clearInterval(maintenanceInterval);
        maintenanceInterval = null;
    }
}

/**
 * Pre-detect display for all workers in parallel batches
 * This eliminates the 3-8s per-device delay when first job starts
 */
async function preDetectAllDisplays() {
    const allWorkers = Array.from(workers.values());
    const undetected = allWorkers.filter(w => !w.resolutionDetected);
    
    if (undetected.length === 0) return;
    
    console.log(`[PreDetect] Detecting display for ${undetected.length} devices in parallel batches...`);
    
    const batchSize = 10; // 10 concurrent ADB calls at a time
    for (let i = 0; i < undetected.length; i += batchSize) {
        const batch = undetected.slice(i, i + batchSize);
        await Promise.allSettled(batch.map(async (worker) => {
            try {
                await worker.detectDisplay();
                worker.resolutionDetected = true;
                console.log(`[PreDetect] ✓ ${worker.deviceId} (${worker.screenWidth}x${worker.screenHeight})`);
            } catch (e) {
                console.log(`[PreDetect] ✗ ${worker.deviceId}: ${e.message}`);
            }
        }));
        // Small gap between batches to avoid ADB overload
        if (i + batchSize < undetected.length) {
            await new Promise(r => setTimeout(r, 300));
        }
    }
    
    const detected = allWorkers.filter(w => w.resolutionDetected).length;
    console.log(`[PreDetect] Done: ${detected}/${allWorkers.length} devices ready`);
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

    stopMaintenanceLoop();

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
        }, 2000); // FIX: was 1000ms, now 2000ms to reduce IPC flooding
    }
}

async function sendJobUpdate(jobId, event, data = {}) {
    const job = await db.getJob(jobId);
    const counts = job ? await db.getTaskCounts(jobId) : null;

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

ipcMain.handle('create-job', async (event, data) => {
    const { type, config, deviceIds } = data;
    const jobId = `job_${Date.now()}_${jobCounter++}`;

    try {
        const tasks = JobGenerator.generateTasks(jobId, type, config, deviceIds);

        let initialTotal = tasks.length;
        if (type === 'super_marketing') {
            const targetCycles = config.numWatching || 100;
            initialTotal = deviceIds.length * targetCycles;
        }

        await db.createJob({
            id: jobId,
            type,
            status: 'pending',
            config,
            deviceIds,
            initialTotal: initialTotal,
            createdAt: Date.now()
        });

        await db.createTasks(tasks);

        if (type === 'boost_live' && config.comments && config.comments.length > 0) {
            await db.createCommentPool(jobId, config.comments, deviceIds.length);
        }

        setTimeout(async () => {
            await db.updateJobStatus(jobId, 'running', { startedAt: Date.now() });
            lastJobCacheRefresh = 0; // FIX: invalidate cache
            notifyJobUpdate(jobId, 'started');
        }, 100);

        const job = await db.getJob(jobId);
        const counts = await db.getTaskCounts(jobId);

        return {
            success: true,
            job: { ...job, ...counts }
        };
    } catch (error) {
        console.error('Failed to create job:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-jobs', async () => {
    const allJobs = await db.getAllJobs();
    const jobs = [];
    for (const job of allJobs) {
        const counts = await db.getTaskCounts(job.id);
        let completedCount = counts.completed;
        if (job.type === 'super_marketing') {
            completedCount = job.completed_count || 0;
        }
        jobs.push({
            ...job,
            completed: completedCount,
            failed: counts.failed,
            remaining: counts.pending + counts.running,
            total: job.initial_total
        });
    }
    return { success: true, jobs };
});

ipcMain.handle('pause-job', async (event, jobId) => {
    await db.updateJobStatus(jobId, 'paused');
    lastJobCacheRefresh = 0; // FIX: invalidate cache
    notifyJobUpdate(jobId, 'paused');
    return { success: true };
});

ipcMain.handle('resume-job', async (event, jobId) => {
    await db.updateJobStatus(jobId, 'running');
    lastJobCacheRefresh = 0; // FIX: invalidate cache
    notifyJobUpdate(jobId, 'resumed');
    return { success: true };
});

// UPDATED: Cancel job now also closes TikTok
ipcMain.handle('cancel-job', async (event, jobId) => {
    try {
        const job = await db.getJob(jobId);
        
        await db.updateJobStatus(jobId, 'cancelled');
        await db.cancelJobTasks(jobId);

        // FIX: Mark job as cancelled in memory so workers see it instantly
        cancelledJobIds.add(jobId);
        // FIX: Invalidate running jobs cache immediately
        lastJobCacheRefresh = 0;

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

ipcMain.handle('retry-job', async (event, jobId) => {
    await db.retryFailedTasks(jobId);
    await db.updateJobStatus(jobId, 'running');
    notifyJobUpdate(jobId, 'retrying');
    return { success: true };
});

ipcMain.handle('delete-job', async (event, jobId) => {
    await db.deleteJob(jobId);
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
        const allJobs = await db.getAllJobs();
        const activeJobs = allJobs.filter(j => j.status === 'running' || j.status === 'pending');

        if (activeJobs.length === 0) {
            return { success: true, count: 0, message: 'No active jobs to cancel' };
        }

        console.log(`Cancelling ${activeJobs.length} active job(s)...`);

        const allDeviceIds = new Set();
        
        for (const job of activeJobs) {
            await db.updateJobStatus(job.id, 'cancelled');
            await db.cancelJobTasks(job.id);

            // FIX: Mark in memory
            cancelledJobIds.add(job.id);

            if (job.deviceIds && Array.isArray(job.deviceIds)) {
                job.deviceIds.forEach(id => allDeviceIds.add(id));
            }

            notifyJobUpdate(job.id, 'cancelled');
        }

        // FIX: Invalidate cache
        lastJobCacheRefresh = 0;

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
        const allJobs = await db.getAllJobs();

        if (allJobs.length === 0) {
            return { success: true, count: 0, message: 'No jobs to delete' };
        }

        console.log(`Deleting ${allJobs.length} job(s)...`);

        await db.deleteAllData();

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

        const result = await db.refillComments(jobId, comments);
        
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
        const stats = await db.getCommentStats(jobId);
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

// FIX: Expose cancelledJobIds so Worker.js can check without DB query
// This is used by the isJobCancelled() method
function isJobCancelled(jobId) {
    return cancelledJobIds.has(jobId);
}

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
            thumbnailWidth: 140,
            jpegQuality: 30,
            adbPath: ADB_PATH,
            scrcpyPath: SCRCPY_PATH,
            maxConcurrent: 20,
            breathDelay: 200 // FIX v2: was 20ms — way too fast for 100 devices!
                             // 200ms = max 5 FPS per device, but with 100 devices
                             // the actual rate is ~0.5-1 FPS per device (ADB bottleneck)
        });

        // FIX v2: THROTTLED frame delivery — batch frames and send max 2x/sec
        // Instead of per-frame IPC (100s of calls/sec), collect frames in a buffer
        // and flush to renderer every 500ms. This reduces IPC overhead by 95%+.
        const frameBatch = new Map(); // deviceId -> latest frameData
        let batchFlushTimer = null;

        function flushFrameBatch() {
            if (!monitorWindow || monitorWindow.isDestroyed()) {
                frameBatch.clear();
                return;
            }

            // Send all buffered frames in ONE IPC call
            if (frameBatch.size > 0) {
                const frames = Object.fromEntries(frameBatch);
                monitorWindow.webContents.send('stream-frame-batch', frames);
                frameBatch.clear();
            }
        }

        // When streamer emits a frame, buffer it (don't send immediately)
        streamer.on('frame', (frameData) => {
            // Update legacy cache so getCachedFrames works
            ensureScreenCapture().injectFrame(
                frameData.deviceId, frameData.data, frameData.mimeType, frameData.size
            );

            // Buffer frame (latest wins per device)
            frameBatch.set(frameData.deviceId, {
                deviceId: frameData.deviceId,
                data: frameData.data,
                mimeType: frameData.mimeType,
                size: frameData.size,
                captureTime: frameData.captureTime
            });

            // Schedule flush if not already scheduled
            if (!batchFlushTimer) {
                batchFlushTimer = setInterval(() => {
                    flushFrameBatch();
                    if (frameBatch.size === 0 && !streamer.isRunning) {
                        clearInterval(batchFlushTimer);
                        batchFlushTimer = null;
                    }
                }, 500); // Flush every 500ms = 2 batch updates/sec
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

        // Cleanup on streamer stop
        const originalStop = streamer.stopStreaming.bind(streamer);
        streamer.stopStreaming = function() {
            if (batchFlushTimer) {
                clearInterval(batchFlushTimer);
                batchFlushTimer = null;
            }
            frameBatch.clear();
            return originalStop();
        };
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
        // Pre-detect display for newly connected devices
        preDetectAllDisplays().catch(e => console.error('[PreDetect] Error:', e.message));
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

        const allJobs = await db.getAllJobs();
        const activeJobs = allJobs.filter(j => j.status === 'running' || j.status === 'pending');

        if (activeJobs.length === 0) {
            console.log('No active jobs to cancel');
            return;
        }

        console.log('Cancelling jobs...');

        const allDeviceIds = new Set();

        for (const job of activeJobs) {
            await db.updateJobStatus(job.id, 'cancelled');
            await db.cancelJobTasks(job.id);

            if (job.deviceIds && Array.isArray(job.deviceIds)) {
                job.deviceIds.forEach(id => allDeviceIds.add(id));
            }
        }

        // better-sqlite3 auto-persists, no export needed

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
    db = new AsyncJobDatabase();
    await db.init();
    console.log('[DB] AsyncJobDatabase ready (worker thread)');

    loadDevices();
    
    // Auto-start ADB and reconnect devices (critical after PC restart!)
    initAdbAndReconnect()
        .then(() => preDetectAllDisplays())
        .catch(e => console.error('[ADB] Init error:', e.message));

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
    const dbFilePath = path.join(__dirname, 'jobs.db');
    if (fs.existsSync(dbFilePath)) {
        const stats = fs.statSync(dbFilePath);
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
        await db.close();
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