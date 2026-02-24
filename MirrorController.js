/**
 * MirrorController.js v4 - Per-Device Resolution Scaling
 * 
 * FIXED: Previously used master device resolution for ALL devices.
 * OPPO (1440x3168) coords sent to Samsung (1080x2280) = wrong position.
 * 
 * NOW: Each device gets its OWN resolution, coordinates scaled individually.
 */

const { exec, execFile, spawn } = require('child_process');
const EventEmitter = require('events');

class MirrorController extends EventEmitter {
    constructor(options = {}) {
        super();
        this.adbPath = options.adbPath || 'adb';
        this.scrcpyPath = options.scrcpyPath || 'scrcpy';
        this.masterDevice = null;
        this.allDevices = [];
        this.isActive = false;
        this.masterProcess = null;
        this.deviceResolutions = new Map();
        this.defaultResolution = { width: 1080, height: 2340 };
        this.stats = { gesturesSent: 0, errors: 0 };
    }

    startMirror(masterDeviceId, allDeviceIds, resolution, allDeviceInfo) {
        this.stopMirror();
        this.masterDevice = masterDeviceId;
        this.allDevices = allDeviceIds;
        this.isActive = true;
        if (resolution) this.defaultResolution = resolution;

        // Build per-device resolution map
        this.deviceResolutions.clear();
        if (allDeviceInfo && Array.isArray(allDeviceInfo)) {
            for (const dev of allDeviceInfo) {
                if (dev.device && dev.resolution) {
                    const parts = dev.resolution.split('x');
                    if (parts.length === 2) {
                        this.deviceResolutions.set(dev.device, {
                            width: parseInt(parts[0]) || this.defaultResolution.width,
                            height: parseInt(parts[1]) || this.defaultResolution.height
                        });
                    }
                }
            }
        }

        // Query missing resolutions async
        this._queryMissingResolutions();

        const resByType = {};
        for (const [, res] of this.deviceResolutions) {
            const k = `${res.width}x${res.height}`;
            resByType[k] = (resByType[k] || 0) + 1;
        }
        console.log(`[Mirror] Master: ${masterDeviceId}, Total: ${allDeviceIds.length}, Resolutions:`, resByType);

        this._openMasterScrcpy(masterDeviceId);
        return { success: true, master: masterDeviceId, totalDevices: allDeviceIds.length, resolution: this.defaultResolution };
    }

    _queryMissingResolutions() {
        for (const deviceId of this.allDevices) {
            if (!this.deviceResolutions.has(deviceId)) {
                execFile(this.adbPath, ['-s', deviceId, 'shell', 'wm', 'size'], {
                    timeout: 3000, windowsHide: true
                }, (error, stdout) => {
                    if (!error && stdout) {
                        const match = stdout.match(/(\d+)x(\d+)/);
                        if (match) {
                            this.deviceResolutions.set(deviceId, { width: parseInt(match[1]), height: parseInt(match[2]) });
                        }
                    }
                });
            }
        }
    }

    _getRes(deviceId) {
        return this.deviceResolutions.get(deviceId) || this.defaultResolution;
    }

    stopMirror() {
        this.isActive = false;
        if (this.masterProcess) { try { this.masterProcess.kill(); } catch (e) {} this.masterProcess = null; }
        this.masterDevice = null;
        this.allDevices = [];
        this.deviceResolutions.clear();
        console.log('[Mirror] Stopped');
        return { success: true };
    }

    async sendTap(normX, normY) {
        if (!this.isActive) return { success: false, error: 'Not active' };
        const cx = Math.max(0, Math.min(1, normX));
        const cy = Math.max(0, Math.min(1, normY));

        let ok = 0, errors = 0;
        const promises = this.allDevices.map(deviceId => {
            const r = this._getRes(deviceId);
            const x = Math.round(cx * r.width), y = Math.round(cy * r.height);
            return new Promise(resolve => {
                execFile(this.adbPath, ['-s', deviceId, 'shell', 'input', 'tap', String(x), String(y)], {
                    timeout: 5000, windowsHide: true
                }, err => { if (err) { errors++; this.stats.errors++; } else ok++; resolve(); });
            });
        });
        await Promise.all(promises);
        this.stats.gesturesSent++;
        const mr = this._getRes(this.masterDevice);
        this.emit('gesture', { type: 'tap', x: Math.round(cx * mr.width), y: Math.round(cy * mr.height), devices: this.allDevices.length, ok });
        return { success: true, sent: ok, total: this.allDevices.length };
    }

    async sendSwipe(nx1, ny1, nx2, ny2, duration = 300) {
        if (!this.isActive) return { success: false, error: 'Not active' };
        const c = (v) => Math.max(0, Math.min(1, v));
        nx1 = c(nx1); ny1 = c(ny1); nx2 = c(nx2); ny2 = c(ny2);

        let ok = 0, errors = 0;
        const promises = this.allDevices.map(deviceId => {
            const r = this._getRes(deviceId);
            return new Promise(resolve => {
                execFile(this.adbPath, ['-s', deviceId, 'shell', 'input', 'swipe',
                    String(Math.round(nx1 * r.width)), String(Math.round(ny1 * r.height)),
                    String(Math.round(nx2 * r.width)), String(Math.round(ny2 * r.height)),
                    String(duration)
                ], { timeout: 5000, windowsHide: true }, err => { if (err) { errors++; this.stats.errors++; } else ok++; resolve(); });
            });
        });
        await Promise.all(promises);
        this.stats.gesturesSent++;
        const mr = this._getRes(this.masterDevice);
        this.emit('gesture', { type: 'swipe', x: Math.round(nx2 * mr.width), y: Math.round(ny2 * mr.height), devices: this.allDevices.length, ok });
        return { success: true, sent: ok, total: this.allDevices.length };
    }

    async sendLongPress(normX, normY, duration = 1000) {
        return this.sendSwipe(normX, normY, normX, normY, duration);
    }

    async sendKeyEvent(keycode) {
        if (!this.isActive) return { success: false, error: 'Not active' };
        let ok = 0, errors = 0;
        const promises = this.allDevices.map(deviceId => new Promise(resolve => {
            execFile(this.adbPath, ['-s', deviceId, 'shell', 'input', 'keyevent', keycode], {
                timeout: 5000, windowsHide: true
            }, err => { if (err) { errors++; this.stats.errors++; } else ok++; resolve(); });
        }));
        await Promise.all(promises);
        this.stats.gesturesSent++;
        this.emit('gesture', { type: 'key', keycode, devices: this.allDevices.length, ok });
        return { success: true, sent: ok, total: this.allDevices.length };
    }

    async sendText(text) {
        if (!this.isActive) return { success: false, error: 'Not active' };
        const escaped = text.replace(/ /g, '%s').replace(/[&|;<>`$"'\\]/g, '');
        let ok = 0, errors = 0;
        const promises = this.allDevices.map(deviceId => new Promise(resolve => {
            execFile(this.adbPath, ['-s', deviceId, 'shell', 'input', 'text', escaped], {
                timeout: 5000, windowsHide: true
            }, err => { if (err) { errors++; this.stats.errors++; } else ok++; resolve(); });
        }));
        await Promise.all(promises);
        this.stats.gesturesSent++;
        return { success: true, sent: ok, total: this.allDevices.length };
    }

    _openMasterScrcpy(deviceId) {
        try {
            this.masterProcess = spawn(this.scrcpyPath, [
                '-s', deviceId, '--window-title', `MASTER (VIEW) - ${deviceId}`,
                '--max-size', '900', '--max-fps', '30', '--video-bit-rate', '4M',
                '--no-audio', '--no-control', '--always-on-top', '--window-borderless'
            ], { windowsHide: false, stdio: 'ignore' });

            this.masterProcess.on('close', () => {
                this.masterProcess = null;
                if (this.isActive) { this.stopMirror(); this.emit('master-closed'); }
            });
            this.masterProcess.on('error', (err) => console.error('[Mirror] scrcpy error:', err.message));
        } catch (e) { console.error('[Mirror] Failed to open scrcpy:', e.message); }
    }

    getStatus() {
        return {
            isActive: this.isActive, masterDevice: this.masterDevice,
            totalDevices: this.allDevices.length, stats: this.stats,
            resolutions: Object.fromEntries(this.deviceResolutions)
        };
    }

    destroy() { this.stopMirror(); this.removeAllListeners(); }
}

module.exports = MirrorController;
