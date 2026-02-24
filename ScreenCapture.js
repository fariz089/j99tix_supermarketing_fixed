/**
 * ScreenCapture.js v4 - Wrapper for backward compatibility
 * 
 * Delegates to ScrcpyStreamer for realtime mode,
 * but still supports legacy batch capture for fallback.
 */

const { exec, execFile } = require('child_process');

let sharp;
try { sharp = require('sharp'); } catch (e) { sharp = null; }

class ScreenCapture {
    constructor(options = {}) {
        this.thumbnailWidth = options.thumbnailWidth || 140;
        this.jpegQuality = options.jpegQuality || 30;
        this.maxConcurrent = options.maxConcurrent || 12;
        this.cacheMaxAge = options.cacheMaxAge || 600;
        this.captureTimeout = options.captureTimeout || 3500;
        this.adbPath = options.adbPath || 'adb';
        this.frameCache = new Map();
        this.failureCount = new Map();
        this.stats = { totalCaptures: 0, cacheHits: 0, failures: 0, avgCaptureTime: 0, totalCaptureTime: 0 };
    }

    async getScreenshot(deviceId) {
        const cached = this.frameCache.get(deviceId);
        if (cached && (Date.now() - cached.timestamp) < this.cacheMaxAge) {
            this.stats.cacheHits++;
            return { success: true, data: cached.base64, fromCache: true, mimeType: cached.mimeType };
        }
        return this._captureAndProcess(deviceId);
    }

    async batchCapture(deviceIds) {
        const results = new Map();
        const needCapture = [];
        for (const deviceId of deviceIds) {
            const cached = this.frameCache.get(deviceId);
            if (cached && (Date.now() - cached.timestamp) < this.cacheMaxAge) {
                results.set(deviceId, { success: true, data: cached.base64, fromCache: true, mimeType: cached.mimeType });
                this.stats.cacheHits++;
            } else {
                needCapture.push(deviceId);
            }
        }
        if (needCapture.length === 0) return results;
        const batchSize = this.maxConcurrent;
        for (let i = 0; i < needCapture.length; i += batchSize) {
            const batch = needCapture.slice(i, i + batchSize);
            const batchResults = await Promise.allSettled(batch.map(did => this._captureAndProcess(did)));
            batch.forEach((deviceId, idx) => {
                const r = batchResults[idx];
                results.set(deviceId, r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message || 'error' });
            });
        }
        return results;
    }

    async _captureAndProcess(deviceId) {
        const startTime = Date.now();
        try {
            const rawPng = await this._captureRaw(deviceId);
            if (!rawPng || rawPng.length < 100) { this.stats.failures++; return { success: false, error: 'Empty' }; }
            let buf;
            if (sharp) {
                buf = await sharp(rawPng).resize(this.thumbnailWidth, null, { fit: 'inside', withoutEnlargement: true, fastShrinkOnLoad: true, kernel: 'nearest' })
                    .jpeg({ quality: this.jpegQuality, mozjpeg: false, chromaSubsampling: '4:2:0', trellisQuantisation: false, overshootDeringing: false, optimizeScans: false }).toBuffer();
            } else { buf = rawPng; }
            const base64 = buf.toString('base64');
            const mimeType = sharp ? 'image/jpeg' : 'image/png';
            this.frameCache.set(deviceId, { buffer: buf, base64, mimeType, timestamp: Date.now(), size: buf.length });
            const elapsed = Date.now() - startTime;
            this.stats.totalCaptures++;
            this.stats.totalCaptureTime += elapsed;
            this.stats.avgCaptureTime = Math.round(this.stats.totalCaptureTime / this.stats.totalCaptures);
            return { success: true, data: base64, mimeType, fromCache: false, size: buf.length, captureTime: elapsed };
        } catch (error) {
            this.stats.failures++;
            return { success: false, error: error.message };
        }
    }

    _captureRaw(deviceId) {
        return new Promise((resolve, reject) => {
            execFile(this.adbPath, ['-s', deviceId, 'exec-out', 'screencap', '-p'], {
                encoding: 'buffer', maxBuffer: 10 * 1024 * 1024, timeout: this.captureTimeout, windowsHide: true
            }, (error, stdout) => { if (error) reject(error); else resolve(stdout); });
        });
    }

    /**
     * Inject a frame from ScrcpyStreamer into our cache
     * This is called by main.js when streamer emits a frame
     */
    injectFrame(deviceId, base64, mimeType, size) {
        this.frameCache.set(deviceId, { base64, mimeType, timestamp: Date.now(), size });
    }

    getAllCachedFrames() {
        const frames = {};
        for (const [deviceId, cached] of this.frameCache.entries()) {
            frames[deviceId] = { data: cached.base64, mimeType: cached.mimeType || 'image/jpeg', timestamp: cached.timestamp, size: cached.size };
        }
        return frames;
    }

    getMemoryStats() {
        let totalCacheSize = 0;
        for (const [, cached] of this.frameCache.entries()) {
            totalCacheSize += cached.size || 0;
        }
        return { cachedDevices: this.frameCache.size, totalCacheSize, totalCacheSizeMB: (totalCacheSize / 1024 / 1024).toFixed(2), ...this.stats };
    }

    clearCache(deviceId = null) {
        if (deviceId) this.frameCache.delete(deviceId);
        else this.frameCache.clear();
    }

    updateSettings(settings) {
        if (settings.thumbnailWidth) this.thumbnailWidth = settings.thumbnailWidth;
        if (settings.jpegQuality) this.jpegQuality = settings.jpegQuality;
        if (settings.maxConcurrent) this.maxConcurrent = settings.maxConcurrent;
        if (settings.cacheMaxAge) this.cacheMaxAge = settings.cacheMaxAge;
    }

    destroy() { this.frameCache.clear(); }
}

module.exports = ScreenCapture;
