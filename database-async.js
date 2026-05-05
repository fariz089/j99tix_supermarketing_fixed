/**
 * database-async.js — Async DB Proxy (Main Thread)
 * 
 * Drop-in replacement for database.js that delegates all SQLite operations
 * to a worker thread, keeping the Electron main process event loop free.
 * 
 * All methods return Promises. The worker loop and IPC handlers in main.js
 * need to `await` these calls.
 * 
 * Usage:
 *   const db = new AsyncJobDatabase();
 *   await db.init();
 *   const jobs = await db.getAllJobs(); // non-blocking!
 */

const { Worker } = require('worker_threads');
const path = require('path');

class AsyncJobDatabase {
    constructor() {
        this.dbPath = path.join(__dirname, 'jobs.db');
        this.isClosed = false;
        this._worker = null;
        this._pending = new Map(); // id -> { resolve, reject }
        this._nextId = 1;
        this._ready = false;
    }

    async init() {
        return new Promise((resolve, reject) => {
            this._worker = new Worker(path.join(__dirname, 'db-worker-thread.js'), {
                workerData: { dbPath: this.dbPath }
            });

            // Handle responses from worker
            this._worker.on('message', (msg) => {
                if (msg.id === '__ready') {
                    // Worker is ready, now call init
                    this._ready = true;
                    this._call('init').then(resolve).catch(reject);
                    return;
                }

                const pending = this._pending.get(msg.id);
                if (pending) {
                    this._pending.delete(msg.id);
                    if (msg.error) {
                        // Don't reject for "Database closed" errors
                        if (msg.error.includes('Database closed')) {
                            pending.resolve(null);
                        } else {
                            pending.reject(new Error(msg.error));
                        }
                    } else {
                        pending.resolve(msg.result);
                    }
                }
            });

            this._worker.on('error', (err) => {
                console.error('[DB Async] Worker error:', err);
                // Reject all pending
                for (const [, p] of this._pending) {
                    p.reject(err);
                }
                this._pending.clear();
            });

            this._worker.on('exit', (code) => {
                console.log(`[DB Async] Worker exited with code ${code}`);
                this.isClosed = true;
            });
        });
    }

    /**
     * Send a method call to the worker thread and return a Promise
     */
    _call(method, ...args) {
        if (this.isClosed) {
            return Promise.resolve(null);
        }

        return new Promise((resolve, reject) => {
            const id = this._nextId++;
            this._pending.set(id, { resolve, reject });

            try {
                this._worker.postMessage({ id, method, args });
            } catch (err) {
                this._pending.delete(id);
                reject(err);
            }
        });
    }

    // ══════════════════════════════════════════════════════════════
    //  PROXY METHODS — all async, matching original database.js API
    // ══════════════════════════════════════════════════════════════

    // For backward compat, save() is a no-op
    save(force = false) { }

    async createJob(job) {
        return this._call('createJob', job);
    }

    async updateJobStatus(jobId, status, extraData = {}) {
        return this._call('updateJobStatus', jobId, status, extraData);
    }

    async updateJobProgress(jobId, completed, failed) {
        return this._call('updateJobProgress', jobId, completed, failed);
    }

    async incrementJobProgress(jobId, delta = 1) {
        return this._call('incrementJobProgress', jobId, delta);
    }

    async getJob(jobId) {
        return this._call('getJob', jobId);
    }

    async getAllJobs() {
        return this._call('getAllJobs');
    }

    async deleteJob(jobId) {
        return this._call('deleteJob', jobId);
    }

    async createTasks(tasks) {
        return this._call('createTasks', tasks);
    }

    async getNextTask(jobId, deviceId) {
        return this._call('getNextTask', jobId, deviceId);
    }

    async completeTask(taskId, result) {
        return this._call('completeTask', taskId, result);
    }

    async failTask(taskId, error) {
        return this._call('failTask', taskId, error);
    }

    async getTaskCounts(jobId) {
        return this._call('getTaskCounts', jobId);
    }

    async retryFailedTasks(jobId) {
        return this._call('retryFailedTasks', jobId);
    }

    async createCommentPool(jobId, comments, totalDevices) {
        return this._call('createCommentPool', jobId, comments, totalDevices);
    }

    async refillComments(jobId, comments) {
        return this._call('refillComments', jobId, comments);
    }

    async getCommentStats(jobId) {
        return this._call('getCommentStats', jobId);
    }

    async tryGetComment(jobId, deviceId, deviceIndex, commentDelay) {
        return this._call('tryGetComment', jobId, deviceId, deviceIndex, commentDelay);
    }

    async canDeviceComment(jobId, deviceId) {
        return this._call('canDeviceComment', jobId, deviceId);
    }

    async markDeviceCommented(jobId, deviceId) {
        return this._call('markDeviceCommented', jobId, deviceId);
    }

    async getAndUseComment(jobId, deviceId) {
        return this._call('getAndUseComment', jobId, deviceId);
    }

    async getCurrentCycleInfo(jobId) {
        return this._call('getCurrentCycleInfo', jobId);
    }

    async recoverStaleTasks(workerStatusMap) {
        return this._call('recoverStaleTasks', workerStatusMap);
    }

    async cancelJobTasks(jobId) {
        return this._call('cancelJobTasks', jobId);
    }

    async deleteAllData() {
        return this._call('deleteAllData');
    }

    async updateJobFailedCount(jobId, failedCount) {
        return this._call('updateJobFailedCount', jobId, failedCount);
    }

    async _refreshCountCache(jobId) {
        return this._call('_refreshCountCache', jobId);
    }

    // ── CLEANUP METHODS ──
    async cleanupCompletedJob(jobId) {
        return this._call('cleanupCompletedJob', jobId);
    }

    async walCheckpoint(mode = 'PASSIVE') {
        return this._call('walCheckpoint', mode);
    }

    async releaseMemory() {
        return this._call('releaseMemory');
    }

    async close() {
        if (this.isClosed) return;
        this.isClosed = true;
        try {
            await this._call('close');
        } catch (e) { }
        await this._worker.terminate();
    }
}

module.exports = AsyncJobDatabase;
