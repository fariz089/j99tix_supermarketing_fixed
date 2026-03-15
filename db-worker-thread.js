/**
 * db-worker-thread.js — SQLite Worker Thread
 * 
 * Runs ALL better-sqlite3 operations in a separate thread so the Electron
 * main process event loop is NEVER blocked by synchronous DB calls.
 * 
 * Communication: main <-> worker via MessagePort (postMessage / on('message'))
 * 
 * Protocol:
 *   Request:  { id, method, args }
 *   Response: { id, result } | { id, error }
 */

const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = workerData.dbPath || path.join(__dirname, 'jobs.db');

let db = null;
let isClosed = false;
let _stmts = {};
let _countCache = new Map();

// ══════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════

function init() {
    db = new Database(dbPath);

    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000');
    db.pragma('temp_store = MEMORY');
    db.pragma('mmap_size = 268435456');

    initTables();

    _stmts = {
        getNextTask: db.prepare(`
            SELECT * FROM tasks 
            WHERE job_id = ? AND status = 'pending' AND assigned_device = ?
            LIMIT 1
        `),
        setTaskRunning: db.prepare('UPDATE tasks SET status = ? WHERE id = ?'),
        getAllJobs: db.prepare('SELECT * FROM jobs ORDER BY created_at DESC'),
        getJob: db.prepare('SELECT * FROM jobs WHERE id = ?'),
        completeTask: db.prepare(`
            UPDATE tasks SET status = ?, result = ?, completed_at = ? WHERE id = ?
        `),
        failTask: db.prepare(`
            UPDATE tasks SET status = ?, error = ?, completed_at = ? WHERE id = ?
        `),
        getTaskJobId: db.prepare('SELECT job_id FROM tasks WHERE id = ?'),
        countCacheRefresh: db.prepare(`
            SELECT 
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running
            FROM tasks WHERE job_id = ?
        `),
    };

    _warmCountCache();
    return 'Database initialized (worker thread + WAL mode)';
}

function initTables() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            status TEXT NOT NULL,
            config TEXT NOT NULL,
            device_ids TEXT NOT NULL,
            initial_total INTEGER NOT NULL,
            completed_count INTEGER DEFAULT 0,
            failed_count INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL,
            started_at INTEGER,
            completed_at INTEGER
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS job_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT NOT NULL,
            comment TEXT NOT NULL,
            used INTEGER DEFAULT 0,
            used_at INTEGER,
            used_by_device TEXT
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS job_comment_cycles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT NOT NULL,
            cycle_number INTEGER DEFAULT 1,
            devices_commented TEXT DEFAULT '[]',
            total_devices INTEGER DEFAULT 0,
            last_comment_at INTEGER DEFAULT 0,
            started_at INTEGER,
            completed_at INTEGER
        )
    `);

    try {
        db.exec(`ALTER TABLE job_comment_cycles ADD COLUMN last_comment_at INTEGER DEFAULT 0`);
    } catch (e) { /* already exists */ }

    db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL,
            type TEXT NOT NULL,
            config TEXT NOT NULL,
            assigned_device TEXT,
            status TEXT DEFAULT 'pending',
            result TEXT,
            error TEXT,
            created_at INTEGER NOT NULL,
            completed_at INTEGER
        )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_job_id ON tasks(job_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned_device ON tasks(assigned_device)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_job_status_device ON tasks(job_id, status, assigned_device)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_job_comments_job_id ON job_comments(job_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_job_comments_used ON job_comments(used)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_job_comments_job_used ON job_comments(job_id, used)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_job_comment_cycles_job_id ON job_comment_cycles(job_id)`);
}

// ══════════════════════════════════════════════════════════════
//  COUNT CACHE
// ══════════════════════════════════════════════════════════════

function _warmCountCache() {
    const jobs = db.prepare('SELECT id FROM jobs').all();
    for (const job of jobs) {
        _refreshCountCache(job.id);
    }
}

function _refreshCountCache(jobId) {
    const row = _stmts.countCacheRefresh.get(jobId);
    _countCache.set(jobId, {
        completed: row?.completed || 0,
        failed: row?.failed || 0,
        pending: row?.pending || 0,
        running: row?.running || 0
    });
}

function _getCache(jobId) {
    if (!_countCache.has(jobId)) {
        _refreshCountCache(jobId);
    }
    return _countCache.get(jobId);
}

function _updateCache(jobId, fromStatus, toStatus) {
    const cache = _getCache(jobId);
    if (fromStatus && cache[fromStatus] > 0) cache[fromStatus]--;
    if (toStatus) cache[toStatus]++;
}

// ══════════════════════════════════════════════════════════════
//  DB METHODS (same as database.js but running in worker thread)
// ══════════════════════════════════════════════════════════════

function parseJobRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        type: row.type,
        status: row.status,
        config: JSON.parse(row.config),
        deviceIds: JSON.parse(row.device_ids),
        initial_total: row.initial_total,
        completed_count: row.completed_count,
        failed_count: row.failed_count,
        created_at: row.created_at,
        started_at: row.started_at,
        completed_at: row.completed_at,
        progress: row.initial_total > 0 ? Math.round((row.completed_count / row.initial_total) * 100) : 0
    };
}

const methods = {
    init() {
        return init();
    },

    // ── JOB CRUD ──
    createJob(job) {
        if (isClosed) return;
        db.prepare(`
            INSERT INTO jobs (id, type, status, config, device_ids, initial_total, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(job.id, job.type, job.status, JSON.stringify(job.config),
            JSON.stringify(job.deviceIds), job.initialTotal, job.createdAt);
    },

    updateJobStatus(jobId, status, extraData = {}) {
        if (isClosed) return;
        try {
            let sql = 'UPDATE jobs SET status = ?';
            const params = [status];
            if (extraData.startedAt) { sql += ', started_at = ?'; params.push(extraData.startedAt); }
            if (extraData.completedAt) { sql += ', completed_at = ?'; params.push(extraData.completedAt); }
            sql += ' WHERE id = ?';
            params.push(jobId);
            db.prepare(sql).run(...params);
        } catch (e) { console.error('updateJobStatus error:', e); }
    },

    updateJobProgress(jobId, completed, failed) {
        if (isClosed) return;
        db.prepare('UPDATE jobs SET completed_count = ?, failed_count = ? WHERE id = ?')
            .run(completed, failed, jobId);
    },

    incrementJobProgress(jobId, delta = 1) {
        if (isClosed) return;
        db.prepare('UPDATE jobs SET completed_count = completed_count + ? WHERE id = ?')
            .run(delta, jobId);
    },

    getJob(jobId) {
        if (isClosed) return null;
        return parseJobRow(_stmts.getJob.get(jobId));
    },

    getAllJobs() {
        if (isClosed) return [];
        return _stmts.getAllJobs.all().map(parseJobRow);
    },

    deleteJob(jobId) {
        if (isClosed) return;
        const deleteAll = db.transaction(() => {
            db.prepare('DELETE FROM tasks WHERE job_id = ?').run(jobId);
            db.prepare('DELETE FROM job_comments WHERE job_id = ?').run(jobId);
            db.prepare('DELETE FROM job_comment_cycles WHERE job_id = ?').run(jobId);
            db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
        });
        deleteAll();
        _countCache.delete(jobId);
    },

    // ── TASK CRUD ──
    createTasks(tasks) {
        if (isClosed) return;
        const insertMany = db.transaction((taskList) => {
            const stmt = db.prepare(`
                INSERT INTO tasks (id, job_id, type, config, assigned_device, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            const now = Date.now();
            for (const task of taskList) {
                stmt.run(task.id, task.jobId, task.type, JSON.stringify(task.config),
                    task.assignedDevice || null, now);
            }
        });
        insertMany(tasks);
        const jobIds = new Set(tasks.map(t => t.jobId));
        for (const jid of jobIds) _refreshCountCache(jid);
    },

    getNextTask(jobId, deviceId) {
        if (isClosed) return null;
        const row = _stmts.getNextTask.get(jobId, deviceId);
        if (!row) return null;
        _stmts.setTaskRunning.run('running', row.id);
        _updateCache(jobId, 'pending', 'running');
        return {
            id: row.id, job_id: row.job_id, type: row.type,
            config: JSON.parse(row.config), assigned_device: row.assigned_device
        };
    },

    completeTask(taskId, result) {
        if (isClosed) return;
        const task = _stmts.getTaskJobId.get(taskId);
        _stmts.completeTask.run('completed', JSON.stringify(result), Date.now(), taskId);
        if (task) _updateCache(task.job_id, 'running', 'completed');
    },

    failTask(taskId, error) {
        if (isClosed) return;
        const task = _stmts.getTaskJobId.get(taskId);
        _stmts.failTask.run('failed', error, Date.now(), taskId);
        if (task) _updateCache(task.job_id, 'running', 'failed');
    },

    getTaskCounts(jobId) {
        if (isClosed) return { completed: 0, failed: 0, pending: 0, running: 0 };
        return { ..._getCache(jobId) };
    },

    retryFailedTasks(jobId) {
        if (isClosed) return;
        db.prepare(`UPDATE tasks SET status = 'pending', error = NULL WHERE job_id = ? AND status = 'failed'`).run(jobId);
        _refreshCountCache(jobId);
    },

    // ── COMMENT CYCLE ──
    createCommentPool(jobId, comments, totalDevices) {
        if (isClosed || !comments || comments.length === 0) return;
        const insertComments = db.transaction((commentList) => {
            const stmt = db.prepare('INSERT INTO job_comments (job_id, comment) VALUES (?, ?)');
            for (const comment of commentList) stmt.run(jobId, comment);
        });
        insertComments(comments);
        if (totalDevices > 0) {
            const existing = db.prepare('SELECT * FROM job_comment_cycles WHERE job_id = ? ORDER BY cycle_number DESC LIMIT 1').get(jobId);
            if (!existing) {
                db.prepare(`INSERT INTO job_comment_cycles (job_id, cycle_number, devices_commented, total_devices, started_at, last_comment_at) VALUES (?, 1, '[]', ?, ?, 0)`)
                    .run(jobId, totalDevices, Date.now());
            }
        }
    },

    refillComments(jobId, comments) {
        if (isClosed || !comments || comments.length === 0) return { success: false, count: 0 };
        let count = 0;
        const insertComments = db.transaction((commentList) => {
            const stmt = db.prepare('INSERT INTO job_comments (job_id, comment) VALUES (?, ?)');
            for (const comment of commentList) {
                if (comment && comment.trim()) { stmt.run(jobId, comment.trim()); count++; }
            }
        });
        insertComments(comments);
        return { success: true, count };
    },

    getCommentStats(jobId) {
        if (isClosed) return { total: 0, used: 0, available: 0, cycleInfo: null };
        const row = db.prepare(`
            SELECT COUNT(*) as total,
                SUM(CASE WHEN used = 1 THEN 1 ELSE 0 END) as used,
                SUM(CASE WHEN used = 0 THEN 1 ELSE 0 END) as available
            FROM job_comments WHERE job_id = ?
        `).get(jobId);

        const cycleRow = db.prepare('SELECT * FROM job_comment_cycles WHERE job_id = ? ORDER BY cycle_number DESC LIMIT 1').get(jobId);
        let cycleInfo = null;
        if (cycleRow) {
            cycleInfo = {
                cycleNumber: cycleRow.cycle_number,
                devicesCommented: JSON.parse(cycleRow.devices_commented || '[]'),
                totalDevices: cycleRow.total_devices,
                isComplete: cycleRow.completed_at !== null,
                startedAt: cycleRow.started_at || Date.now()
            };
        }
        return { total: row?.total || 0, used: row?.used || 0, available: row?.available || 0, cycleInfo };
    },

    tryGetComment(jobId, deviceId, deviceIndex, commentDelay) {
        if (isClosed) return { status: 'no_comments' };
        const row = db.prepare(`SELECT * FROM job_comment_cycles WHERE job_id = ? AND completed_at IS NULL ORDER BY cycle_number DESC LIMIT 1`).get(jobId);
        if (!row) return { status: 'no_comments' };

        const devicesCommented = JSON.parse(row.devices_commented || '[]');
        if (devicesCommented.includes(deviceId)) return { status: 'already_commented' };

        const lastCommentAt = row.last_comment_at || 0;
        const now = Date.now();
        const timeSinceLastComment = (now - lastCommentAt) / 1000;
        if (lastCommentAt > 0 && timeSinceLastComment < commentDelay) {
            return { status: 'waiting_delay', waitSeconds: Math.ceil(commentDelay - timeSinceLastComment) };
        }

        const commentRow = db.prepare(`SELECT * FROM job_comments WHERE job_id = ? AND used = 0 ORDER BY id ASC LIMIT 1`).get(jobId);
        if (!commentRow) return { status: 'no_comments' };

        const doComment = db.transaction(() => {
            db.prepare('UPDATE job_comments SET used = 1, used_at = ?, used_by_device = ? WHERE id = ?').run(now, deviceId, commentRow.id);
            db.prepare('UPDATE job_comment_cycles SET last_comment_at = ? WHERE id = ?').run(now, row.id);
        });
        doComment();

        return { status: 'ok', comment: commentRow.comment };
    },

    canDeviceComment(jobId, deviceId) {
        if (isClosed) return false;
        const row = db.prepare(`SELECT * FROM job_comment_cycles WHERE job_id = ? AND completed_at IS NULL ORDER BY cycle_number DESC LIMIT 1`).get(jobId);
        if (!row) return true;
        const devicesCommented = JSON.parse(row.devices_commented || '[]');
        return !devicesCommented.includes(deviceId);
    },

    markDeviceCommented(jobId, deviceId) {
        if (isClosed) return;
        const row = db.prepare(`SELECT * FROM job_comment_cycles WHERE job_id = ? AND completed_at IS NULL ORDER BY cycle_number DESC LIMIT 1`).get(jobId);
        if (!row) return;
        const devicesCommented = JSON.parse(row.devices_commented || '[]');
        if (!devicesCommented.includes(deviceId)) devicesCommented.push(deviceId);
        db.prepare('UPDATE job_comment_cycles SET devices_commented = ? WHERE id = ?').run(JSON.stringify(devicesCommented), row.id);
        if (devicesCommented.length >= row.total_devices) {
            db.prepare('UPDATE job_comment_cycles SET completed_at = ? WHERE id = ?').run(Date.now(), row.id);
            // Start new cycle
            db.prepare(`INSERT INTO job_comment_cycles (job_id, cycle_number, devices_commented, total_devices, started_at, last_comment_at) VALUES (?, ?, '[]', ?, ?, 0)`)
                .run(jobId, row.cycle_number + 1, row.total_devices, Date.now());
        }
    },

    getAndUseComment(jobId, deviceId) {
        if (isClosed) return null;
        const commentRow = db.prepare(`SELECT * FROM job_comments WHERE job_id = ? AND used = 0 ORDER BY id ASC LIMIT 1`).get(jobId);
        if (!commentRow) return null;
        db.prepare('UPDATE job_comments SET used = 1, used_at = ?, used_by_device = ? WHERE id = ?')
            .run(Date.now(), deviceId, commentRow.id);
        return commentRow.comment;
    },

    getCurrentCycleInfo(jobId) {
        if (isClosed) return null;
        const row = db.prepare('SELECT * FROM job_comment_cycles WHERE job_id = ? ORDER BY cycle_number DESC LIMIT 1').get(jobId);
        if (!row) return null;
        return {
            cycleNumber: row.cycle_number,
            devicesCommented: JSON.parse(row.devices_commented || '[]'),
            totalDevices: row.total_devices,
            isComplete: row.completed_at !== null,
            startedAt: row.started_at || Date.now()
        };
    },

    // ── RECOVERY ──
    recoverStaleTasks(workerStatusMap) {
        // workerStatusMap: { deviceId: { status, currentTaskId } }
        try {
            const runningJobs = methods.getAllJobs().filter(j => j.status === 'running');
            let totalRecovered = 0;

            for (const job of runningJobs) {
                const rows = db.prepare(`SELECT id, assigned_device FROM tasks WHERE job_id = ? AND status = 'running'`).all(job.id);
                const stuckTasks = [];

                for (const row of rows) {
                    const wStatus = workerStatusMap[row.assigned_device];
                    if (!wStatus || wStatus.status === 'idle' ||
                        (wStatus.status === 'busy' && wStatus.currentTaskId && wStatus.currentTaskId !== row.id)) {
                        stuckTasks.push(row.id);
                    }
                }

                if (stuckTasks.length > 0) {
                    const resetStmt = db.prepare("UPDATE tasks SET status = 'pending', error = NULL WHERE id = ?");
                    for (const taskId of stuckTasks) resetStmt.run(taskId);
                    _refreshCountCache(job.id);
                    totalRecovered += stuckTasks.length;
                }

                // Auto-retry failed
                const failedRow = db.prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE job_id = ? AND status = 'failed'`).get(job.id);
                if (failedRow && failedRow.cnt > 0) {
                    db.prepare("UPDATE tasks SET status = 'pending', error = NULL WHERE job_id = ? AND status = 'failed'").run(job.id);
                    _refreshCountCache(job.id);
                    totalRecovered += failedRow.cnt;
                }
            }

            return totalRecovered;
        } catch (e) {
            console.error('[DB Worker] Recovery error:', e.message);
            return 0;
        }
    },

    // ── BULK operations for cancel/delete ──
    cancelJobTasks(jobId) {
        db.prepare('UPDATE tasks SET status = ? WHERE job_id = ? AND status IN (?, ?)')
            .run('cancelled', jobId, 'pending', 'running');
    },

    deleteAllData() {
        try { db.exec('DELETE FROM tasks'); } catch (e) { }
        try { db.exec('DELETE FROM job_comments'); } catch (e) { }
        try { db.exec('DELETE FROM job_comment_cycles'); } catch (e) { }
        try { db.exec('DELETE FROM jobs'); } catch (e) { }
        _countCache.clear();
    },

    updateJobFailedCount(jobId, failedCount) {
        db.prepare('UPDATE jobs SET failed_count = ? WHERE id = ?').run(failedCount, jobId);
    },

    _refreshCountCache(jobId) {
        _refreshCountCache(jobId);
        return _getCache(jobId);
    },

    // ── CLOSE ──
    close() {
        if (db && !isClosed) {
            isClosed = true;
            try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { }
            db.close();
            return 'Database closed';
        }
        return 'Already closed';
    }
};

// ══════════════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ══════════════════════════════════════════════════════════════

parentPort.on('message', (msg) => {
    const { id, method, args } = msg;

    try {
        if (!methods[method]) {
            parentPort.postMessage({ id, error: `Unknown method: ${method}` });
            return;
        }

        const result = methods[method](...(args || []));
        parentPort.postMessage({ id, result });
    } catch (err) {
        parentPort.postMessage({ id, error: err.message || String(err) });
    }
});

// Signal ready
parentPort.postMessage({ id: '__ready', result: 'DB worker thread started' });
