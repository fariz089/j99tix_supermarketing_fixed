const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

class JobDatabase {
    constructor() {
        this.dbPath = path.join(__dirname, 'jobs.db');
        this.db = null;
        this.SQL = null;
        this.isClosed = false;
    }

    async init() {
        this.SQL = await initSqlJs();

        if (fs.existsSync(this.dbPath)) {
            const buffer = fs.readFileSync(this.dbPath);
            this.db = new this.SQL.Database(buffer);
        } else {
            this.db = new this.SQL.Database();
        }

        this.initTables();
        console.log('Database initialized');
    }


    save(force = false) {
        if (this.isClosed && !force) return;

        try {
            const data = this.db.export();
            const buffer = Buffer.from(data);
            fs.writeFileSync(this.dbPath, buffer);
        } catch (error) {
            console.error('Database save error:', error.message);
        }
    }

    initTables() {
        this.db.run(`
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

        this.db.run(`
            CREATE TABLE IF NOT EXISTS job_comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT NOT NULL,
                comment TEXT NOT NULL,
                used INTEGER DEFAULT 0,
                used_at INTEGER,
                used_by_device TEXT
            )
        `);

        // New table for tracking comment cycles
        this.db.run(`
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

        // Add last_comment_at column if it doesn't exist (migration for existing DBs)
        try {
            this.db.run(`ALTER TABLE job_comment_cycles ADD COLUMN last_comment_at INTEGER DEFAULT 0`);
        } catch (e) {
            // Column already exists, ignore
        }

        this.db.run(`
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

        this.db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_job_id ON tasks(job_id)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned_device ON tasks(assigned_device)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_job_comments_job_id ON job_comments(job_id)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_job_comments_used ON job_comments(used)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_job_comment_cycles_job_id ON job_comment_cycles(job_id)`);

        this.save();
    }

    createJob(job) {
        if (this.isClosed) return;

        const stmt = this.db.prepare(`
            INSERT INTO jobs (id, type, status, config, device_ids, initial_total, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run([
            job.id,
            job.type,
            job.status,
            JSON.stringify(job.config),
            JSON.stringify(job.deviceIds),
            job.initialTotal,
            job.createdAt
        ]);

        stmt.free();
        this.save();
    }

    updateJobStatus(jobId, status, extraData = {}) {
        // Allow updates even if closing
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

            this.db.run(sql, params);

            // Don't auto-save, will be saved manually
        } catch (error) {
            console.error('updateJobStatus error:', error);
        }
    }


    updateJobProgress(jobId, completed, failed) {
        if (this.isClosed) return;

        this.db.run('UPDATE jobs SET completed_count = ?, failed_count = ? WHERE id = ?',
            [completed, failed, jobId]);
        this.save();
    }

    // Increment completed count by delta (for cycle-based progress)
    incrementJobProgress(jobId, delta = 1) {
        if (this.isClosed) return;

        this.db.run('UPDATE jobs SET completed_count = completed_count + ? WHERE id = ?',
            [delta, jobId]);
        this.save();
    }

    getJob(jobId) {
        if (this.isClosed) return null;

        const stmt = this.db.prepare('SELECT * FROM jobs WHERE id = ?');
        stmt.bind([jobId]);

        if (stmt.step()) {
            const row = stmt.getAsObject();
            stmt.free();

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

        stmt.free();
        return null;
    }

    getAllJobs() {
        if (this.isClosed) return [];

        const jobs = [];
        const stmt = this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC');

        while (stmt.step()) {
            const row = stmt.getAsObject();
            jobs.push({
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
            });
        }

        stmt.free();
        return jobs;
    }

    deleteJob(jobId) {
        if (this.isClosed) return;

        this.db.run('DELETE FROM tasks WHERE job_id = ?', [jobId]);
        this.db.run('DELETE FROM job_comments WHERE job_id = ?', [jobId]);
        this.db.run('DELETE FROM job_comment_cycles WHERE job_id = ?', [jobId]);
        this.db.run('DELETE FROM jobs WHERE id = ?', [jobId]);
        this.save();
    }

    createTask(task) {
        if (this.isClosed) return;

        const stmt = this.db.prepare(`
            INSERT INTO tasks (id, job_id, type, config, assigned_device, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        stmt.run([
            task.id,
            task.jobId,
            task.type,
            JSON.stringify(task.config),
            task.assignedDevice || null,
            Date.now()
        ]);

        stmt.free();
        this.save();
    }

    createTasks(tasks) {
        if (this.isClosed) return;

        const stmt = this.db.prepare(`
            INSERT INTO tasks (id, job_id, type, config, assigned_device, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        tasks.forEach(task => {
            stmt.run([
                task.id,
                task.jobId,
                task.type,
                JSON.stringify(task.config),
                task.assignedDevice || null,
                Date.now()
            ]);
        });

        stmt.free();
        this.save();
    }

    getNextTask(jobId, deviceId) {
        if (this.isClosed) return null;

        const stmt = this.db.prepare(`
            SELECT * FROM tasks 
            WHERE job_id = ? 
            AND status = 'pending'
            AND assigned_device = ?
            LIMIT 1
        `);

        stmt.bind([jobId, deviceId]);

        if (stmt.step()) {
            const row = stmt.getAsObject();
            const taskId = row.id;
            stmt.free();

            this.db.run('UPDATE tasks SET status = ? WHERE id = ?', ['running', taskId]);
            this.save();

            return {
                id: row.id,
                job_id: row.job_id,
                type: row.type,
                config: JSON.parse(row.config),
                assigned_device: row.assigned_device
            };
        }

        stmt.free();
        return null;
    }

    completeTask(taskId, result) {
        if (this.isClosed) return;

        this.db.run(`
            UPDATE tasks 
            SET status = ?, result = ?, completed_at = ?
            WHERE id = ?
        `, ['completed', JSON.stringify(result), Date.now(), taskId]);
        this.save();
    }

    failTask(taskId, error) {
        if (this.isClosed) return;

        this.db.run(`
            UPDATE tasks 
            SET status = ?, error = ?, completed_at = ?
            WHERE id = ?
        `, ['failed', error, Date.now(), taskId]);
        this.save();
    }

    getTaskCounts(jobId) {
        if (this.isClosed) return { completed: 0, failed: 0, pending: 0, running: 0 };

        const stmt = this.db.prepare(`
            SELECT 
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running
            FROM tasks
            WHERE job_id = ?
        `);

        stmt.bind([jobId]);

        if (stmt.step()) {
            const result = stmt.getAsObject();
            stmt.free();
            return {
                completed: result.completed || 0,
                failed: result.failed || 0,
                pending: result.pending || 0,
                running: result.running || 0
            };
        }

        stmt.free();
        return { completed: 0, failed: 0, pending: 0, running: 0 };
    }

    retryFailedTasks(jobId) {
        if (this.isClosed) return;

        this.db.run(`
            UPDATE tasks 
            SET status = 'pending', error = NULL
            WHERE job_id = ? AND status = 'failed'
        `, [jobId]);
        this.save();
    }

    // ================== COMMENT CYCLE MANAGEMENT ==================

    // Initialize comment cycle for a job
    initCommentCycle(jobId, totalDevices) {
        if (this.isClosed) return;

        // Check if cycle already exists
        const stmt = this.db.prepare('SELECT * FROM job_comment_cycles WHERE job_id = ? ORDER BY cycle_number DESC LIMIT 1');
        stmt.bind([jobId]);
        
        if (!stmt.step()) {
            // No cycle exists, create first one
            this.db.run(`
                INSERT INTO job_comment_cycles (job_id, cycle_number, devices_commented, total_devices, started_at, last_comment_at)
                VALUES (?, 1, '[]', ?, ?, 0)
            `, [jobId, totalDevices, Date.now()]);
            this.save();
        }
        stmt.free();
    }

    /**
     * MAIN ENTRY POINT for comment logic - enforces delay at database level
     * Returns: { status: 'ok'|'already_commented'|'waiting_delay'|'no_comments', comment?, waitSeconds? }
     */
    tryGetComment(jobId, deviceId, deviceIndex, commentDelay) {
        if (this.isClosed) return { status: 'no_comments' };

        // 1. Get current active cycle
        const stmt = this.db.prepare(`
            SELECT * FROM job_comment_cycles 
            WHERE job_id = ? AND completed_at IS NULL
            ORDER BY cycle_number DESC LIMIT 1
        `);
        stmt.bind([jobId]);

        if (!stmt.step()) {
            stmt.free();
            return { status: 'no_comments' };
        }

        const row = stmt.getAsObject();
        stmt.free();

        const devicesCommented = JSON.parse(row.devices_commented || '[]');
        
        // 2. Check if this device already commented in this cycle
        if (devicesCommented.includes(deviceId)) {
            return { status: 'already_commented' };
        }

        // 3. ENFORCE DELAY: Check time since last comment in this cycle
        const lastCommentAt = row.last_comment_at || 0;
        const now = Date.now();
        const timeSinceLastComment = (now - lastCommentAt) / 1000;
        
        if (lastCommentAt > 0 && timeSinceLastComment < commentDelay) {
            const waitSeconds = Math.ceil(commentDelay - timeSinceLastComment);
            return { status: 'waiting_delay', waitSeconds };
        }

        // 4. Get next available comment
        const commentStmt = this.db.prepare(`
            SELECT * FROM job_comments 
            WHERE job_id = ? AND used = 0 
            ORDER BY id ASC
            LIMIT 1
        `);
        commentStmt.bind([jobId]);

        if (!commentStmt.step()) {
            commentStmt.free();
            return { status: 'no_comments' };
        }

        const commentRow = commentStmt.getAsObject();
        commentStmt.free();

        // 5. Mark comment as used
        this.db.run('UPDATE job_comments SET used = 1, used_at = ?, used_by_device = ? WHERE id = ?',
            [now, deviceId, commentRow.id]);

        // 6. Update last_comment_at on the cycle (this is the delay enforcement timestamp)
        this.db.run(`
            UPDATE job_comment_cycles 
            SET last_comment_at = ?
            WHERE id = ?
        `, [now, row.id]);

        this.save();

        console.log(`[DB] Device ${deviceId} got comment #${commentRow.id} (cycle ${row.cycle_number}, ${devicesCommented.length + 1}/${row.total_devices} devices, delay OK: ${timeSinceLastComment.toFixed(1)}s >= ${commentDelay}s)`);
        
        return { status: 'ok', comment: commentRow.comment };
    }

    // Check if a device can comment in current cycle
    canDeviceComment(jobId, deviceId) {
        if (this.isClosed) return false;

        const stmt = this.db.prepare(`
            SELECT * FROM job_comment_cycles 
            WHERE job_id = ? AND completed_at IS NULL
            ORDER BY cycle_number DESC LIMIT 1
        `);
        stmt.bind([jobId]);

        if (stmt.step()) {
            const row = stmt.getAsObject();
            stmt.free();
            
            const devicesCommented = JSON.parse(row.devices_commented || '[]');
            return !devicesCommented.includes(deviceId);
        }

        stmt.free();
        return true; // If no cycle, allow comment
    }

    // Mark a device as having commented in current cycle
    markDeviceCommented(jobId, deviceId) {
        if (this.isClosed) return;

        const stmt = this.db.prepare(`
            SELECT * FROM job_comment_cycles 
            WHERE job_id = ? AND completed_at IS NULL
            ORDER BY cycle_number DESC LIMIT 1
        `);
        stmt.bind([jobId]);

        if (stmt.step()) {
            const row = stmt.getAsObject();
            stmt.free();
            
            const devicesCommented = JSON.parse(row.devices_commented || '[]');
            if (!devicesCommented.includes(deviceId)) {
                devicesCommented.push(deviceId);
            }
            
            // Update the cycle
            this.db.run(`
                UPDATE job_comment_cycles 
                SET devices_commented = ?
                WHERE id = ?
            `, [JSON.stringify(devicesCommented), row.id]);

            // Check if cycle is complete (all devices have commented)
            if (devicesCommented.length >= row.total_devices) {
                console.log(`[DB] Cycle ${row.cycle_number} completed! All ${row.total_devices} devices have commented.`);
                this.db.run(`
                    UPDATE job_comment_cycles 
                    SET completed_at = ?
                    WHERE id = ?
                `, [Date.now(), row.id]);

                // Start new cycle
                this.startNewCommentCycle(jobId, row.total_devices, row.cycle_number + 1);
            }

            this.save();
        } else {
            stmt.free();
        }
    }

    // Start a new comment cycle
    startNewCommentCycle(jobId, totalDevices, cycleNumber) {
        if (this.isClosed) return;

        this.db.run(`
            INSERT INTO job_comment_cycles (job_id, cycle_number, devices_commented, total_devices, started_at, last_comment_at)
            VALUES (?, ?, '[]', ?, ?, 0)
        `, [jobId, cycleNumber, totalDevices, Date.now()]);

        // DON'T reset comments - continue from where left off

        console.log(`[DB] Started new comment cycle ${cycleNumber} for job ${jobId}`);
        this.save();
    }

    // Get current cycle info
    getCurrentCycleInfo(jobId) {
        if (this.isClosed) return null;

        const stmt = this.db.prepare(`
            SELECT * FROM job_comment_cycles 
            WHERE job_id = ?
            ORDER BY cycle_number DESC LIMIT 1
        `);
        stmt.bind([jobId]);

        if (stmt.step()) {
            const row = stmt.getAsObject();
            stmt.free();
            return {
                cycleNumber: row.cycle_number,
                devicesCommented: JSON.parse(row.devices_commented || '[]'),
                totalDevices: row.total_devices,
                isComplete: row.completed_at !== null,
                startedAt: row.started_at || Date.now()
            };
        }

        stmt.free();
        return null;
    }

    // Get and use comment with device tracking - sequential assignment, never reuses
    getAndUseComment(jobId, deviceId = null) {
        if (this.isClosed) return null;

        const cycleInfo = this.getCurrentCycleInfo(jobId);

        // Get the first unused comment (sequential order)
        const stmt = this.db.prepare(`
            SELECT * FROM job_comments 
            WHERE job_id = ? AND used = 0 
            ORDER BY id ASC
            LIMIT 1
        `);

        stmt.bind([jobId]);

        if (stmt.step()) {
            const row = stmt.getAsObject();
            const commentId = row.id;
            const comment = row.comment;
            stmt.free();

            this.db.run('UPDATE job_comments SET used = 1, used_at = ?, used_by_device = ? WHERE id = ?',
                [Date.now(), deviceId, commentId]);
            this.save();

            console.log(`[DB] Device ${deviceId} got comment #${commentId} (cycle ${cycleInfo?.cycleNumber || 1}, ${(cycleInfo?.devicesCommented?.length || 0) + 1}/${cycleInfo?.totalDevices || '?'} devices commented)`);
            return comment;
        }

        stmt.free();
        
        // All comments used up
        console.log(`[DB] No more unused comments available for job ${jobId}`);
        return null;
    }

    createCommentPool(jobId, comments, totalDevices = 0) {
        if (this.isClosed || !comments || comments.length === 0) return;

        this.db.run(`
            CREATE TABLE IF NOT EXISTS job_comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT NOT NULL,
                comment TEXT NOT NULL,
                used INTEGER DEFAULT 0,
                used_at INTEGER,
                used_by_device TEXT
            )
        `);

        const stmt = this.db.prepare(`
            INSERT INTO job_comments (job_id, comment) VALUES (?, ?)
        `);

        comments.forEach(comment => {
            stmt.run([jobId, comment]);
        });

        stmt.free();

        // Initialize comment cycle if totalDevices provided
        if (totalDevices > 0) {
            this.initCommentCycle(jobId, totalDevices);
        }

        this.save();
    }

    // Refill comments for a job
    refillComments(jobId, comments) {
        if (this.isClosed || !comments || comments.length === 0) return { success: false, count: 0 };

        const stmt = this.db.prepare(`
            INSERT INTO job_comments (job_id, comment) VALUES (?, ?)
        `);

        let count = 0;
        comments.forEach(comment => {
            if (comment && comment.trim()) {
                stmt.run([jobId, comment.trim()]);
                count++;
            }
        });

        stmt.free();
        this.save();

        console.log(`[DB] Refilled ${count} comments for job ${jobId}`);
        return { success: true, count };
    }

    getCommentStats(jobId) {
        if (this.isClosed) return { total: 0, used: 0, available: 0, cycleInfo: null };

        const stmt = this.db.prepare(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN used = 1 THEN 1 ELSE 0 END) as used,
                SUM(CASE WHEN used = 0 THEN 1 ELSE 0 END) as available
            FROM job_comments
            WHERE job_id = ?
        `);

        stmt.bind([jobId]);

        let result = { total: 0, used: 0, available: 0, cycleInfo: null };

        if (stmt.step()) {
            const row = stmt.getAsObject();
            result = {
                total: row.total || 0,
                used: row.used || 0,
                available: row.available || 0,
                cycleInfo: this.getCurrentCycleInfo(jobId)
            };
        }

        stmt.free();
        return result;
    }

    // ================== END COMMENT CYCLE MANAGEMENT ==================

    close() {
        if (this.db && !this.isClosed) {
            this.save(true); // Force save before closing
            this.isClosed = true;
            this.db.close();
            console.log('Database closed');
        }
    }

}

module.exports = JobDatabase;