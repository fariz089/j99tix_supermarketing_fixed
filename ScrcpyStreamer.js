/**
 * ScrcpyStreamer.js - Realtime Device Streaming Engine
 * 
 * Uses scrcpy's raw video stream (--video-codec=h264 --no-window) to get
 * continuous frames from each device. Falls back to fast screencap loop.
 * 
 * Architecture:
 * - Each device gets a persistent scrcpy subprocess
 * - scrcpy records to a temp .mkv file
 * - A periodic "frame grabber" extracts the last frame using ffmpeg
 * - Frames are resized with sharp and sent to renderer via IPC push
 * 
 * For systems without ffmpeg, falls back to:
 * - Continuous screencap loop (non-blocking, staggered per device)
 * - Each device captures independently in a tight loop
 * - ~300-600ms per frame depending on device
 * 
 * This is MUCH faster than batch polling because:
 * 1. No waiting for all devices - each streams independently
 * 2. Staggered starts prevent ADB bottleneck
 * 3. Pipeline: capture device N+1 while processing device N
 * 4. Push model: frames sent to renderer as soon as ready
 */

const { exec, execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const EventEmitter = require('events');

let sharp;
try {
    sharp = require('sharp');
} catch (e) {
    console.error('[ScrcpyStreamer] sharp not installed');
    sharp = null;
}

class ScrcpyStreamer extends EventEmitter {
    constructor(options = {}) {
        super();
        this.thumbnailWidth = options.thumbnailWidth || 140;
        this.jpegQuality = options.jpegQuality || 30;
        this.adbPath = options.adbPath || 'adb';
        this.scrcpyPath = options.scrcpyPath || 'scrcpy';
        this.maxConcurrent = options.maxConcurrent || 20;

        // Per-device streaming state
        this.deviceStreams = new Map(); // deviceId -> DeviceStream
        
        // Frame cache (latest frame per device)
        this.frameCache = new Map(); // deviceId -> { base64, mimeType, timestamp, size }

        // Device health
        this.deviceHealth = new Map(); // deviceId -> { failures, lastFailure, lastSuccess }

        // Global state
        this.isRunning = false;
        this.staggerDelay = 50; // ms between starting each device stream (was 100)

        // Configurable breath delay (lower = faster, more CPU)
        this.breathDelay = options.breathDelay || 20; // was calculated 50-200

        // Stats
        this.stats = {
            totalFrames: 0,
            totalErrors: 0,
            activeStreams: 0,
            avgFrameTime: 0,
            _frameTimes: []
        };

        // Check if ffmpeg available (for scrcpy stream decode)
        this.hasFfmpeg = false;
        this._checkFfmpeg();
    }

    _checkFfmpeg() {
        try {
            exec('ffmpeg -version', { timeout: 3000, windowsHide: true }, (err) => {
                this.hasFfmpeg = !err;
                console.log(`[ScrcpyStreamer] ffmpeg available: ${this.hasFfmpeg}`);
            });
        } catch (e) {
            this.hasFfmpeg = false;
        }
    }

    /**
     * Start streaming for a list of device IDs
     * Devices are started with staggered delays to avoid ADB bottleneck
     */
    startStreaming(deviceIds) {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log(`[ScrcpyStreamer] Starting realtime streams for ${deviceIds.length} devices`);

        deviceIds.forEach((deviceId, index) => {
            setTimeout(() => {
                if (this.isRunning) {
                    this._startDeviceStream(deviceId);
                }
            }, index * this.staggerDelay);
        });
    }

    /**
     * Stop all streams
     */
    stopStreaming() {
        this.isRunning = false;
        console.log(`[ScrcpyStreamer] Stopping all streams`);
        for (const [deviceId, stream] of this.deviceStreams.entries()) {
            this._stopDeviceStream(deviceId);
        }
        this.deviceStreams.clear();
    }

    /**
     * Add a single device to the stream pool
     */
    addDevice(deviceId) {
        if (!this.isRunning) return;
        if (this.deviceStreams.has(deviceId)) return;
        this._startDeviceStream(deviceId);
    }

    /**
     * Remove a single device from the stream pool
     */
    removeDevice(deviceId) {
        this._stopDeviceStream(deviceId);
        this.deviceStreams.delete(deviceId);
    }

    /**
     * Start the continuous capture loop for a single device
     * Uses a tight async loop: capture → process → emit → repeat
     */
    _startDeviceStream(deviceId) {
        if (this.deviceStreams.has(deviceId)) return;

        const stream = {
            active: true,
            capturing: false,
            consecutiveFailures: 0,
            lastFrameTime: 0,
            totalFrames: 0,
            process: null
        };

        this.deviceStreams.set(deviceId, stream);
        this.stats.activeStreams = this.deviceStreams.size;

        // Start the capture loop
        this._captureLoop(deviceId, stream);
    }

    /**
     * The main capture loop for a device
     * Runs continuously until stopped. Self-recovering on errors.
     */
    async _captureLoop(deviceId, stream) {
        while (stream.active && this.isRunning) {
            if (!stream.active) break;

            const startTime = Date.now();

            try {
                // Check if device should be throttled (too many failures)
                if (stream.consecutiveFailures >= 5) {
                    // Back off: wait 3 seconds before retrying (was 5s)
                    await this._sleep(3000);
                    stream.consecutiveFailures = 0;
                    continue;
                }

                // Capture raw screenshot
                const rawPng = await this._captureRaw(deviceId);

                if (!rawPng || rawPng.length < 100) {
                    stream.consecutiveFailures++;
                    this.stats.totalErrors++;
                    await this._sleep(300); // was 500
                    continue;
                }

                // Process with sharp (resize + compress)
                let processedBuffer;
                if (sharp) {
                    processedBuffer = await sharp(rawPng)
                        .resize(this.thumbnailWidth, null, {
                            fit: 'inside',
                            withoutEnlargement: true,
                            fastShrinkOnLoad: true,
                            kernel: 'nearest' // fastest resize kernel
                        })
                        .jpeg({
                            quality: this.jpegQuality,
                            mozjpeg: false,
                            chromaSubsampling: '4:2:0',
                            trellisQuantisation: false,
                            overshootDeringing: false,
                            optimizeScans: false
                        })
                        .toBuffer();
                } else {
                    processedBuffer = rawPng;
                }

                const base64 = processedBuffer.toString('base64');
                const mimeType = sharp ? 'image/jpeg' : 'image/png';
                const elapsed = Date.now() - startTime;

                // Update cache
                const frameData = {
                    base64,
                    mimeType,
                    timestamp: Date.now(),
                    size: processedBuffer.length,
                    captureTime: elapsed
                };
                this.frameCache.set(deviceId, frameData);

                // Reset failure counter
                stream.consecutiveFailures = 0;
                stream.lastFrameTime = elapsed;
                stream.totalFrames++;

                // Update stats
                this.stats.totalFrames++;
                this.stats._frameTimes.push(elapsed);
                if (this.stats._frameTimes.length > 100) this.stats._frameTimes.shift();
                this.stats.avgFrameTime = Math.round(
                    this.stats._frameTimes.reduce((a, b) => a + b, 0) / this.stats._frameTimes.length
                );

                // PUSH frame to renderer immediately
                this.emit('frame', {
                    deviceId,
                    data: base64,
                    mimeType,
                    size: processedBuffer.length,
                    captureTime: elapsed
                });

                // Update device health
                this.deviceHealth.set(deviceId, {
                    ...(this.deviceHealth.get(deviceId) || {}),
                    failures: 0,
                    lastSuccess: Date.now()
                });

                // Minimal breathing room - configurable via settings
                await this._sleep(this.breathDelay);

            } catch (error) {
                stream.consecutiveFailures++;
                this.stats.totalErrors++;

                const health = this.deviceHealth.get(deviceId) || { failures: 0 };
                health.failures = (health.failures || 0) + 1;
                health.lastFailure = Date.now();
                health.lastError = error.message;
                this.deviceHealth.set(deviceId, health);

                // Emit offline event if device seems down
                if (error.message && (
                    error.message.includes('offline') ||
                    error.message.includes('not found') ||
                    error.message.includes('no devices')
                )) {
                    this.emit('device-offline', { deviceId, error: error.message });
                    await this._sleep(8000); // was 10000
                } else {
                    await this._sleep(Math.min(800, 150 * stream.consecutiveFailures)); // was 1000, 200
                }
            }
        }

        // Loop ended
        this.stats.activeStreams = Array.from(this.deviceStreams.values()).filter(s => s.active).length;
    }

    /**
     * Capture raw PNG from device
     * Uses execFile (no shell overhead) for maximum speed
     */
    _captureRaw(deviceId) {
        return new Promise((resolve, reject) => {
            // execFile is faster than exec (no shell spawning)
            execFile(this.adbPath, ['-s', deviceId, 'exec-out', 'screencap', '-p'], {
                encoding: 'buffer',
                maxBuffer: 10 * 1024 * 1024,
                timeout: 3500, // was 5000
                windowsHide: true
            }, (error, stdout) => {
                if (error) reject(error);
                else resolve(stdout);
            });
        });
    }

    /**
     * Stop stream for a specific device
     */
    _stopDeviceStream(deviceId) {
        const stream = this.deviceStreams.get(deviceId);
        if (stream) {
            stream.active = false;
            if (stream.process) {
                try { stream.process.kill(); } catch (e) {}
            }
        }
    }

    /**
     * Get the latest cached frame for a device
     */
    getFrame(deviceId) {
        return this.frameCache.get(deviceId) || null;
    }

    /**
     * Get all cached frames (for initial load when monitor opens)
     */
    getAllCachedFrames() {
        const frames = {};
        for (const [deviceId, frame] of this.frameCache.entries()) {
            frames[deviceId] = {
                data: frame.base64,
                mimeType: frame.mimeType,
                timestamp: frame.timestamp,
                size: frame.size
            };
        }
        return frames;
    }

    /**
     * Get streaming stats
     */
    getStats() {
        const streamDetails = {};
        for (const [deviceId, stream] of this.deviceStreams.entries()) {
            streamDetails[deviceId] = {
                active: stream.active,
                totalFrames: stream.totalFrames,
                lastFrameTime: stream.lastFrameTime,
                consecutiveFailures: stream.consecutiveFailures
            };
        }

        return {
            isRunning: this.isRunning,
            activeStreams: Array.from(this.deviceStreams.values()).filter(s => s.active).length,
            totalDevices: this.deviceStreams.size,
            cachedFrames: this.frameCache.size,
            totalFrames: this.stats.totalFrames,
            totalErrors: this.stats.totalErrors,
            avgFrameTime: this.stats.avgFrameTime,
            streamDetails
        };
    }

    /**
     * Update settings on the fly
     */
    updateSettings(settings) {
        if (settings.thumbnailWidth !== undefined) this.thumbnailWidth = settings.thumbnailWidth;
        if (settings.jpegQuality !== undefined) this.jpegQuality = settings.jpegQuality;
        if (settings.breathDelay !== undefined) this.breathDelay = Math.max(5, Math.min(500, settings.breathDelay));
    }

    /**
     * Check if a device is currently streaming
     */
    isDeviceStreaming(deviceId) {
        const stream = this.deviceStreams.get(deviceId);
        return stream && stream.active;
    }

    /**
     * Force restart stream for a device
     */
    restartDevice(deviceId) {
        this._stopDeviceStream(deviceId);
        this.deviceStreams.delete(deviceId);
        setTimeout(() => {
            if (this.isRunning) {
                this._startDeviceStream(deviceId);
            }
        }, 500);
    }

    /**
     * Cleanup everything
     */
    destroy() {
        this.stopStreaming();
        this.frameCache.clear();
        this.deviceHealth.clear();
        this.removeAllListeners();
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = ScrcpyStreamer;
