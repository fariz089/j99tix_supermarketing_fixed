const Database = require('better-sqlite3');
const path = require('path');

class JobDatabase {
    constructor() {
        this.dbPath = path.join(__dirname, 'jobs.db');
        this.db = null;
        this.isClosed = false;

        // ── In-memory cache for task counts (avoid expensive SUM queries) ──
        this._countCache = new Map(); // jobId -> { completed, failed, pending, running }
    }

    /**
     * Initialize database.
     * better-sqlite3 opens the file directly — no export/import overhead.
     * Kept async signature for backward compatibility with existing code.
     */
    async init() {
        this.db = new Database(this.dbPath);

        // ── WAL mode: reads don't block writes, huge perf boost ──
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');   // Safe enough, 2x faster than FULL
        this.db.pragma('cache_size = -64000');     // 64MB cache (default is 2MB)
        this.db.pragma('temp_store = MEMORY');     // Temp tables in memory
        this.db.pragma('mmap_size = 268435456');   // 256MB memory-mapped I/O

        this.initTables();
        this._warmCountCache();
        console.log('Database initialized (better-sqlite3 + WAL mode)');
    }

    /**
     * save() is now a NO-OP.
     * better-sqlite3 writes directly to disk via WAL — no manual export needed.
     * Kept for backward compatibility so all existing this.save() calls don't break.
     */
    save(force = false) {
        // No-op: better-sqlite3 auto-persists
    }

    initTables() {
        this.db.exec(`
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

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS job_comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT NOT NULL,
                comment TEXT NOT NULL,
                used INTEGER DEFAULT 0,
                used_at INTEGER,
                used_by_device TEXT
            )
        `);

        this.db.exec(`
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

        // Migration: add last_comment_at if missing
        try {
            this.db.exec(`ALTER TABLE job_comment_cycles ADD COLUMN last_comment_at INTEGER DEFAULT 0`);
        } catch (e) {
            // Column already exists
        }

        this.db.exec(`
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

        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_job_id ON tasks(job_id)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned_device ON tasks(assigned_device)`);
        // ── Composite index for the hot query path (getNextTask) ──
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_job_status_device ON tasks(job_id, status, assigned_device)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_job_comments_job_id ON job_comments(job_id)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_job_comments_used ON job_comments(used)`);
        // ── Composite index for comment lookups ──
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_job_comments_job_used ON job_comments(job_id, used)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_job_comment_cycles_job_id ON job_comment_cycles(job_id)`);
    }

    // ══════════════════════════════════════════════════════════════
    //  COUNT CACHE — avoids expensive SUM(CASE WHEN...) on 100K rows
    // ══════════════════════════════════════════════════════════════

    _warmCountCache() {
        const jobs = this.db.prepare('SELECT id FROM jobs').all();
        for (const job of jobs) {
            this._refreshCountCache(job.id);
        }
    }

    _refreshCountCache(jobId) {
        const row = this.db.prepare(`
            SELECT 
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running
            FROM tasks WHERE job_id = ?
        `).get(jobId);

        this._countCache.set(jobId, {
            completed: row?.completed || 0,
            failed: row?.failed || 0,
            pending: row?.pending || 0,
            running: row?.running || 0
        });
    }

    _getCache(jobId) {
        if (!this._countCache.has(jobId)) {
            this._refreshCountCache(jobId);
        }
        return this._countCache.get(jobId);
    }

    _updateCache(jobId, fromStatus, toStatus) {
        const cache = this._getCache(jobId);
        if (fromStatus && cache[fromStatus] > 0) cache[fromStatus]--;
        if (toStatus) cache[toStatus]++;
    }

    // ══════════════════════════════════════════════════════════════
    //  JOB CRUD
    // ══════════════════════════════════════════════════════════════

    createJob(job) {
        if (this.isClosed) return;

        this.db.prepare(`
            INSERT INTO jobs (id, type, status, config, device_ids, initial_total, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            job.id,
            job.type,
            job.status,
            JSON.stringify(job.config),
            JSON.stringify(job.deviceIds),
            job.initialTotal,
            job.createdAt
        );
    }

    updateJobStatus(jobId, status, extraData = {}) {
        if (this.isClosed && !this.db) return;

        try {
            let sql = 'UPDATE jobs SET status = ?';
            const params = [status];

            if (extraData.startedAt) {
                sql += ', started_at = ?';
                params.push(extraData.startedAt);
            }
            if (extraData.completedAt) {
                sql += ', completed_at = ?';
                params.push(extraData.completedAt);
            }

            sql += ' WHERE id = ?';
            params.push(jobId);

            this.db.prepare(sql).run(...params);
        } catch (error) {
            console.error('updateJobStatus error:', error);
        }
    }

    updateJobProgress(jobId, completed, failed) {
        if (this.isClosed) return;

        this.db.prepare('UPDATE jobs SET completed_count = ?, failed_count = ? WHERE id = ?')
            .run(completed, failed, jobId);
    }

    incrementJobProgress(jobId, delta = 1) {
        if (this.isClosed) return;

        this.db.prepare('UPDATE jobs SET completed_count = completed_count + ? WHERE id = ?')
            .run(delta, jobId);
    }

    getJob(jobId) {
        if (this.isClosed) return null;

        const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
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

    getAllJobs() {
        if (this.isClosed) return [];

        const rows = this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all();
        return rows.map(row => ({
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
        }));
    }

    deleteJob(jobId) {
        if (this.isClosed) return;

        // ── Atomic multi-table delete in one transaction ──
        const deleteAll = this.db.transaction(() => {
            this.db.prepare('DELETE FROM tasks WHERE job_id = ?').run(jobId);
            this.db.prepare('DELETE FROM job_comments WHERE job_id = ?').run(jobId);
            this.db.prepare('DELETE FROM job_comment_cycles WHERE job_id = ?').run(jobId);
            this.db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
        });

        deleteAll();
        this._countCache.delete(jobId);
    }

    // ══════════════════════════════════════════════════════════════
    //  TASK CRUD — with cache updates
    // ══════════════════════════════════════════════════════════════

    createTask(task) {
        if (this.isClosed) return;

        this.db.prepare(`
            INSERT INTO tasks (id, job_id, type, config, assigned_device, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            task.id,
            task.jobId,
            task.type,
            JSON.stringify(task.config),
            task.assignedDevice || null,
            Date.now()
        );

        this._updateCache(task.jobId, null, 'pending');
    }

    createTasks(tasks) {
        if (this.isClosed) return;

        // ── Wrap in transaction: 100x faster for bulk inserts ──
        const insertMany = this.db.transaction((taskList) => {
            const stmt = this.db.prepare(`
                INSERT INTO tasks (id, job_id, type, config, assigned_device, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `);

            const now = Date.now();
            for (const task of taskList) {
                stmt.run(
                    task.id,
                    task.jobId,
                    task.type,
                    JSON.stringify(task.config),
                    task.assignedDevice || null,
                    now
                );
            }
        });

        insertMany(tasks);

        // Refresh cache for affected jobs
        const jobIds = new Set(tasks.map(t => t.jobId));
        for (const jobId of jobIds) {
            this._refreshCountCache(jobId);
        }
    }

    getNextTask(jobId, deviceId) {
        if (this.isClosed) return null;

        const row = this.db.prepare(`
            SELECT * FROM tasks 
            WHERE job_id = ? 
            AND status = 'pending'
            AND assigned_device = ?
            LIMIT 1
        `).get(jobId, deviceId);

        if (!row) return null;

        this.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('running', row.id);
        this._updateCache(jobId, 'pending', 'running');

        return {
            id: row.id,
            job_id: row.job_id,
            type: row.type,
            config: JSON.parse(row.config),
            assigned_device: row.assigned_device
        };
    }

    completeTask(taskId, result) {
        if (this.isClosed) return;

        const task = this.db.prepare('SELECT job_id FROM tasks WHERE id = ?').get(taskId);

        this.db.prepare(`
            UPDATE tasks 
            SET status = ?, result = ?, completed_at = ?
            WHERE id = ?
        `).run('completed', JSON.stringify(result), Date.now(), taskId);

        if (task) this._updateCache(task.job_id, 'running', 'completed');
    }

    failTask(taskId, error) {
        if (this.isClosed) return;

        const task = this.db.prepare('SELECT job_id FROM tasks WHERE id = ?').get(taskId);

        this.db.prepare(`
            UPDATE tasks 
            SET status = ?, error = ?, completed_at = ?
            WHERE id = ?
        `).run('failed', error, Date.now(), taskId);

        if (task) this._updateCache(task.job_id, 'running', 'failed');
    }

    getTaskCounts(jobId) {
        if (this.isClosed) return { completed: 0, failed: 0, pending: 0, running: 0 };

        // ── Return cached counts — O(1) instead of full table scan ──
        const cache = this._getCache(jobId);
        return { ...cache };
    }

    retryFailedTasks(jobId) {
        if (this.isClosed) return;

        this.db.prepare(`
            UPDATE tasks 
            SET status = 'pending', error = NULL
            WHERE job_id = ? AND status = 'failed'
        `).run(jobId);

        this._refreshCountCache(jobId);
    }

    // ══════════════════════════════════════════════════════════════
    //  COMMENT CYCLE MANAGEMENT
    // ══════════════════════════════════════════════════════════════

    initCommentCycle(jobId, totalDevices) {
        if (this.isClosed) return;

        const existing = this.db.prepare(
            'SELECT * FROM job_comment_cycles WHERE job_id = ? ORDER BY cycle_number DESC LIMIT 1'
        ).get(jobId);

        if (!existing) {
            this.db.prepare(`
                INSERT INTO job_comment_cycles (job_id, cycle_number, devices_commented, total_devices, started_at, last_comment_at)
                VALUES (?, 1, '[]', ?, ?, 0)
            `).run(jobId, totalDevices, Date.now());
        }
    }

    /**
     * MAIN ENTRY POINT for comment logic — enforces delay at database level
     */
    tryGetComment(jobId, deviceId, deviceIndex, commentDelay) {
        if (this.isClosed) return { status: 'no_comments' };

        const row = this.db.prepare(`
            SELECT * FROM job_comment_cycles 
            WHERE job_id = ? AND completed_at IS NULL
            ORDER BY cycle_number DESC LIMIT 1
        `).get(jobId);

        if (!row) return { status: 'no_comments' };

        const devicesCommented = JSON.parse(row.devices_commented || '[]');

        if (devicesCommented.includes(deviceId)) {
            return { status: 'already_commented' };
        }

        const lastCommentAt = row.last_comment_at || 0;
        const now = Date.now();
        const timeSinceLastComment = (now - lastCommentAt) / 1000;

        if (lastCommentAt > 0 && timeSinceLastComment < commentDelay) {
            const waitSeconds = Math.ceil(commentDelay - timeSinceLastComment);
            return { status: 'waiting_delay', waitSeconds };
        }

        const commentRow = this.db.prepare(`
            SELECT * FROM job_comments 
            WHERE job_id = ? AND used = 0 
            ORDER BY id ASC LIMIT 1
        `).get(jobId);

        if (!commentRow) return { status: 'no_comments' };

        // ── Atomic: mark comment used + update cycle timestamp ──
        const doComment = this.db.transaction(() => {
            this.db.prepare('UPDATE job_comments SET used = 1, used_at = ?, used_by_device = ? WHERE id = ?')
                .run(now, deviceId, commentRow.id);

            this.db.prepare('UPDATE job_comment_cycles SET last_comment_at = ? WHERE id = ?')
                .run(now, row.id);
        });

        doComment();

        console.log(`[DB] Device ${deviceId} got comment #${commentRow.id} (cycle ${row.cycle_number}, ${devicesCommented.length + 1}/${row.total_devices} devices, delay OK: ${timeSinceLastComment.toFixed(1)}s >= ${commentDelay}s)`);
        return { status: 'ok', comment: commentRow.comment };
    }

    canDeviceComment(jobId, deviceId) {
        if (this.isClosed) return false;

        const row = this.db.prepare(`
            SELECT * FROM job_comment_cycles 
            WHERE job_id = ? AND completed_at IS NULL
            ORDER BY cycle_number DESC LIMIT 1
        `).get(jobId);

        if (!row) return true;

        const devicesCommented = JSON.parse(row.devices_commented || '[]');
        return !devicesCommented.includes(deviceId);
    }

    markDeviceCommented(jobId, deviceId) {
        if (this.isClosed) return;

        const row = this.db.prepare(`
            SELECT * FROM job_comment_cycles 
            WHERE job_id = ? AND completed_at IS NULL
            ORDER BY cycle_number DESC LIMIT 1
        `).get(jobId);

        if (!row) return;

        const devicesCommented = JSON.parse(row.devices_commented || '[]');
        if (!devicesCommented.includes(deviceId)) {
            devicesCommented.push(deviceId);
        }

        this.db.prepare('UPDATE job_comment_cycles SET devices_commented = ? WHERE id = ?')
            .run(JSON.stringify(devicesCommented), row.id);

        if (devicesCommented.length >= row.total_devices) {
            console.log(`[DB] Cycle ${row.cycle_number} completed! All ${row.total_devices} devices have commented.`);
            this.db.prepare('UPDATE job_comment_cycles SET completed_at = ? WHERE id = ?')
                .run(Date.now(), row.id);

            this.startNewCommentCycle(jobId, row.total_devices, row.cycle_number + 1);
        }
    }

    startNewCommentCycle(jobId, totalDevices, cycleNumber) {
        if (this.isClosed) return;

        this.db.prepare(`
            INSERT INTO job_comment_cycles (job_id, cycle_number, devices_commented, total_devices, started_at, last_comment_at)
            VALUES (?, ?, '[]', ?, ?, 0)
        `).run(jobId, cycleNumber, totalDevices, Date.now());

        console.log(`[DB] Started new comment cycle ${cycleNumber} for job ${jobId}`);
    }

    getCurrentCycleInfo(jobId) {
        if (this.isClosed) return null;

        const row = this.db.prepare(`
            SELECT * FROM job_comment_cycles 
            WHERE job_id = ?
            ORDER BY cycle_number DESC LIMIT 1
        `).get(jobId);

        if (!row) return null;

        return {
            cycleNumber: row.cycle_number,
            devicesCommented: JSON.parse(row.devices_commented || '[]'),
            totalDevices: row.total_devices,
            isComplete: row.completed_at !== null,
            startedAt: row.started_at || Date.now()
        };
    }

    getAndUseComment(jobId, deviceId = null) {
        if (this.isClosed) return null;

        const cycleInfo = this.getCurrentCycleInfo(jobId);

        const row = this.db.prepare(`
            SELECT * FROM job_comments 
            WHERE job_id = ? AND used = 0 
            ORDER BY id ASC LIMIT 1
        `).get(jobId);

        if (!row) {
            console.log(`[DB] No more unused comments available for job ${jobId}`);
            return null;
        }

        this.db.prepare('UPDATE job_comments SET used = 1, used_at = ?, used_by_device = ? WHERE id = ?')
            .run(Date.now(), deviceId, row.id);

        console.log(`[DB] Device ${deviceId} got comment #${row.id} (cycle ${cycleInfo?.cycleNumber || 1}, ${(cycleInfo?.devicesCommented?.length || 0) + 1}/${cycleInfo?.totalDevices || '?'} devices commented)`);
        return row.comment;
    }

    createCommentPool(jobId, comments, totalDevices = 0) {
        if (this.isClosed || !comments || comments.length === 0) return;

        // ── Bulk insert in transaction ──
        const insertComments = this.db.transaction((commentList) => {
            const stmt = this.db.prepare('INSERT INTO job_comments (job_id, comment) VALUES (?, ?)');
            for (const comment of commentList) {
                stmt.run(jobId, comment);
            }
        });

        insertComments(comments);

        if (totalDevices > 0) {
            this.initCommentCycle(jobId, totalDevices);
        }
    }

    refillComments(jobId, comments) {
        if (this.isClosed || !comments || comments.length === 0) return { success: false, count: 0 };

        let count = 0;
        const insertComments = this.db.transaction((commentList) => {
            const stmt = this.db.prepare('INSERT INTO job_comments (job_id, comment) VALUES (?, ?)');
            for (const comment of commentList) {
                if (comment && comment.trim()) {
                    stmt.run(jobId, comment.trim());
                    count++;
                }
            }
        });

        insertComments(comments);
        console.log(`[DB] Refilled ${count} comments for job ${jobId}`);
        return { success: true, count };
    }

    getCommentStats(jobId) {
        if (this.isClosed) return { total: 0, used: 0, available: 0, cycleInfo: null };

        const row = this.db.prepare(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN used = 1 THEN 1 ELSE 0 END) as used,
                SUM(CASE WHEN used = 0 THEN 1 ELSE 0 END) as available
            FROM job_comments
            WHERE job_id = ?
        `).get(jobId);

        return {
            total: row?.total || 0,
            used: row?.used || 0,
            available: row?.available || 0,
            cycleInfo: this.getCurrentCycleInfo(jobId)
        };
    }

    // ══════════════════════════════════════════════════════════════
    //  CLEANUP & CLOSE
    // ══════════════════════════════════════════════════════════════

    close() {
        if (this.db && !this.isClosed) {
            this.isClosed = true;
            try {
                this.db.pragma('wal_checkpoint(TRUNCATE)');
            } catch (e) { }
            this.db.close();
            console.log('Database closed');
        }
    }
}

module.exports = JobDatabase;