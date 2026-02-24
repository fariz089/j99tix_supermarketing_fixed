const { exec, execSync, execFile } = require('child_process');
const SuperMarketingTask = require('./tasks/supermarketing');
const WarmupTask = require('./tasks/warmup');
const BoostLiveTask = require('./tasks/boostlive');
const MassCommentTask = require('./tasks/masscomment');

class DeviceWorker {
    constructor(deviceId, db, deviceInfo) {
        this.deviceId = deviceId;
        this.db = db;
        this.deviceInfo = deviceInfo;
        this.status = 'idle';
        this.currentTask = null;
        this.currentJobId = null;
        this.manuallyPaused = false;

        // Default values
        this.screenWidth = 1080;
        this.screenHeight = 2340;
        this.density = 1.0;
        this.resolutionDetected = false;
    }

    async detectDisplay() {
        try {
            // PRIORITAS 1: Check override dari devices.json
            if (this.deviceInfo && this.deviceInfo.resolution) {
                const [width, height] = this.deviceInfo.resolution.split('x').map(v => parseInt(v));
                this.screenWidth = width;
                this.screenHeight = height;

                console.log(`[${this.deviceId}] 📄 Using override from devices.json: ${width}x${height}`);

                // Apply known patterns for touch range
                const knownPatterns = [
                    {
                        match: (w, h) => w === 1440 && h === 3040,
                        touchMaxX: 1440,
                        touchMaxY: 2280,
                        note: 'Samsung Galaxy S10/S20 series (navigation bar offset)'
                    },
                    {
                        match: (w, h) => w === 1440 && h === 3168,
                        touchMaxX: 1440,
                        touchMaxY: 3168,
                        note: 'OPPO PDEM10 (no offset)'
                    },
                    {
                        match: (w, h) => w === 1080 && h === 2340,
                        touchMaxX: 1080,
                        touchMaxY: 2340,
                        note: 'Standard 1080p (no offset)'
                    },
                    {
                        match: (w, h) => w === 1080 && h === 2280,
                        touchMaxX: 1080,
                        touchMaxY: 2280,
                        note: 'Samsung 1080p (no offset)'
                    }
                ];

                // Check if override matches known pattern
                let patternFound = false;
                for (const pattern of knownPatterns) {
                    if (pattern.match(this.screenWidth, this.screenHeight)) {
                        this.touchMaxX = pattern.touchMaxX;
                        this.touchMaxY = pattern.touchMaxY;
                        console.log(`[${this.deviceId}]    ✅ Pattern: ${pattern.note}`);
                        console.log(`[${this.deviceId}]    Touch range: 0-${this.touchMaxX} x 0-${this.touchMaxY}`);
                        patternFound = true;
                        break;
                    }
                }

                // If no pattern, assume full screen touchable
                if (!patternFound) {
                    this.touchMaxX = this.screenWidth;
                    this.touchMaxY = this.screenHeight;
                    console.log(`[${this.deviceId}]    Touch range (full screen): 0-${this.touchMaxX} x 0-${this.touchMaxY}`);
                }

                // Get density (optional, for logging)
                try {
                    const densityResult = await this.execAdb('shell wm density');
                    const densityMatch = densityResult.match(/(\d+)/);
                    if (densityMatch) {
                        this.dpi = parseInt(densityMatch[1]);
                        this.density = this.dpi / 160;
                        console.log(`[${this.deviceId}]    Density: ${this.dpi} dpi (${this.density.toFixed(2)}x)`);
                    }
                } catch (e) {
                    // Ignore density errors
                }

                return true;
            }

            // PRIORITAS 2: Detect via ADB (fallback jika tidak ada override)
            console.log(`[${this.deviceId}] 🔍 No override found, detecting via ADB...`);

            // Get display size
            const sizeResult = await this.execAdb('shell wm size');
            const sizeMatch = sizeResult.match(/(\d+)x(\d+)/);

            if (sizeMatch) {
                this.screenWidth = parseInt(sizeMatch[1]);
                this.screenHeight = parseInt(sizeMatch[2]);
                console.log(`[${this.deviceId}]    Detected: ${this.screenWidth}x${this.screenHeight}`);
            }

            // Get density
            const densityResult = await this.execAdb('shell wm density');
            const densityMatch = densityResult.match(/(\d+)/);

            if (densityMatch) {
                this.dpi = parseInt(densityMatch[1]);
                this.density = this.dpi / 160;
                console.log(`[${this.deviceId}]    Density: ${this.dpi} dpi (${this.density.toFixed(2)}x)`);
            }

            // Known device patterns
            const knownPatterns = [
                {
                    match: (w, h) => w === 1440 && h === 3040,
                    touchMaxX: 1440,
                    touchMaxY: 2280,
                    note: 'Samsung Galaxy S10/S20 series (navigation bar offset)'
                },
                {
                    match: (w, h) => w === 1440 && h === 3168,
                    touchMaxX: 1440,
                    touchMaxY: 3168,
                    note: 'OPPO PDEM10 (no offset)'
                },
                {
                    match: (w, h) => w === 1080 && h === 2340,
                    touchMaxX: 1080,
                    touchMaxY: 2340,
                    note: 'Standard 1080p (no offset)'
                }
            ];

            // Check known patterns
            let patternFound = false;
            for (const pattern of knownPatterns) {
                if (pattern.match(this.screenWidth, this.screenHeight)) {
                    this.touchMaxX = pattern.touchMaxX;
                    this.touchMaxY = pattern.touchMaxY;
                    console.log(`[${this.deviceId}]    ✅ Known pattern: ${pattern.note}`);
                    console.log(`[${this.deviceId}]    Touch range: 0-${this.touchMaxX} x 0-${this.touchMaxY}`);
                    patternFound = true;
                    break;
                }
            }

            // If no pattern found, try getevent
            if (!patternFound) {
                try {
                    const eventResult = await this.execAdb('shell getevent -p');
                    const xMatch = eventResult.match(/ABS_MT_POSITION_X[^\n]*max\s+(\d+)/);
                    const yMatch = eventResult.match(/ABS_MT_POSITION_Y[^\n]*max\s+(\d+)/);

                    if (xMatch && yMatch) {
                        this.touchMaxX = parseInt(xMatch[1]);
                        this.touchMaxY = parseInt(yMatch[1]);
                        console.log(`[${this.deviceId}]    Touch range (detected): 0-${this.touchMaxX} x 0-${this.touchMaxY}`);
                    } else {
                        // Fallback: 75% of height
                        this.touchMaxX = this.screenWidth;
                        this.touchMaxY = Math.round(this.screenHeight * 0.75);
                        console.log(`[${this.deviceId}]    ⚠️ Using fallback: 75% height`);
                        console.log(`[${this.deviceId}]    Touch range (estimated): 0-${this.touchMaxX} x 0-${this.touchMaxY}`);
                    }
                } catch (e) {
                    // Final fallback
                    this.touchMaxX = this.screenWidth;
                    this.touchMaxY = Math.round(this.screenHeight * 0.75);
                    console.log(`[${this.deviceId}]    ⚠️ Using fallback: 75% height`);
                    console.log(`[${this.deviceId}]    Touch range (estimated): 0-${this.touchMaxX} x 0-${this.touchMaxY}`);
                }
            }

            return true;
        } catch (error) {
            console.error(`[${this.deviceId}] ❌ Failed to detect display:`, error.message);
            // Ultimate fallback
            this.screenWidth = 1080;
            this.screenHeight = 2340;
            this.touchMaxX = 1080;
            this.touchMaxY = 1755;
            console.log(`[${this.deviceId}] Using default: 1080x2340, touch 1080x1755`);
            return false;
        }
    }

    // Map coordinates from reference device (1440x2280)
    mapCoordinatesFromReference(refX, refY) {
        const REF_WIDTH = 1440;
        const REF_HEIGHT = 2280;

        const xPercent = refX / REF_WIDTH;
        const yPercent = refY / REF_HEIGHT;

        const mappedX = Math.round(this.touchMaxX * xPercent);
        const mappedY = Math.round(this.touchMaxY * yPercent);

        return { x: mappedX, y: mappedY };
    }


    //  Scale coordinates from reference device to current device
    // Reference device: 1440x2280 (Samsung SM-G973F from debug)
    scaleCoordinates(refX, refY, refWidth = 1440, refHeight = 2280) {
        const scaleX = this.screenWidth / refWidth;
        const scaleY = this.screenHeight / refHeight;

        return {
            x: Math.round(refX * scaleX),
            y: Math.round(refY * scaleY)
        };
    }

    // Helper to calculate position based on percentage
    getPosition(xPercent, yPercent) {
        return {
            x: Math.round(this.screenWidth * xPercent / 100),
            y: Math.round(this.screenHeight * yPercent / 100)
        };
    }

    async executeTask(task, jobId) {
        // Detect display before first task
        if (!this.resolutionDetected) {
            await this.detectDisplay();
            this.resolutionDetected = true;
        }

        this.status = 'busy';
        this.currentTask = task;
        this.currentJobId = jobId;

        try {
            const result = await this.runTaskScript(task);

            this.status = 'idle';
            this.currentTask = null;
            this.currentJobId = null;

            return { success: true, result };
        } catch (error) {
            this.status = 'idle';
            this.currentTask = null;
            this.currentJobId = null;

            return { success: false, error: error.message };
        }
    }

    async runTaskScript(task) {
        const { type, config } = task;
        const taskConfig = { ...config, jobId: task.job_id };

        switch (type) {
            case 'super_marketing':
                return await SuperMarketingTask.execute(this, taskConfig);
            case 'warmup':
                return await WarmupTask.execute(this, taskConfig);
            case 'boost_live':
                return await BoostLiveTask.execute(this, taskConfig);
            case 'masscomment':
                return await MassCommentTask.execute(this, taskConfig);
            default:
                throw new Error(`Unknown task type: ${type}`);
        }
    }

    pauseManually() {
        this.manuallyPaused = true;
        if (this.status === 'idle') {
            this.status = 'paused';
        }
        return true;
    }

    resumeManually() {
        this.manuallyPaused = false;
        if (this.status === 'paused') {
            this.status = 'idle';
        }
        return true;
    }

    pause() {
        if (this.status === 'busy') {
            this.status = 'paused';
            return true;
        }
        return false;
    }

    resume() {
        if (this.status === 'paused') {
            this.status = 'busy';
            return true;
        }
        return false;
    }

    async waitForResume() {
        while (this.status === 'paused') {
            await this.sleep(500);
        }
    }

    isAvailable() {
        return this.status === 'idle' && !this.manuallyPaused;
    }

    // ============================================
    // OPTIMIZED ADB METHODS
    // ============================================

    async execAdb(command) {
        return new Promise((resolve, reject) => {
            // Use execFile instead of exec — avoids spawning a shell process
            // This cuts CPU usage by ~50% per call (no cmd.exe/sh wrapper)
            const args = ['-s', this.deviceId, ...command.split(/\s+/)];
            
            // For complex shell commands (contains quotes, pipes, &&), fall back to exec
            if (command.includes('"') || command.includes('|') || command.includes('&&') || command.includes('&') || command.includes(';')) {
                exec(`adb -s ${this.deviceId} ${command}`, { timeout: 8000, windowsHide: true }, (error, stdout) => {
                    if (error) reject(error);
                    else resolve(stdout);
                });
            } else {
                execFile('adb', args, { timeout: 8000, windowsHide: true }, (error, stdout) => {
                    if (error) reject(error);
                    else resolve(stdout);
                });
            }
        });
    }

    /**
     * OPTIMIZED: Execute multiple shell commands in ONE adb call
     * @param {string[]} commands - Array of shell commands (without 'shell' prefix)
     */
    async execAdbBatch(commands) {
        if (!commands || commands.length === 0) return '';
        
        // Join commands with semicolons for single shell session
        const batchCommand = commands.join(' && ');
        return this.execAdb(`shell "${batchCommand}"`);
    }

    /**
     * OPTIMIZED: Type text in one command (instead of word-by-word)
     * @param {string} text - Text to type
     */
    async typeText(text) {
        // Clean and escape the text
        const cleanText = text
            .replace(/[\r\n]+/g, ' ')
            .trim()
            // Strip emoji
            .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '');

        if (!cleanText) return false;

        // Escape for shell - handle special characters
        const escaped = cleanText
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/'/g, "\\'")
            .replace(/`/g, '\\`')
            .replace(/\$/g, '\\$')
            .replace(/ /g, '%s'); // ADB uses %s for space

        await this.execAdb(`shell input text "${escaped}"`);
        return true;
    }

    /**
     * OPTIMIZED: Clear text field (single command instead of 100 loops)
     * @param {number} maxChars - Maximum characters to delete
     */
    async clearTextField(maxChars = 100) {
        // Use 'input keyevent' with multiple keycodes in one call
        // Or use shell script for batch delete
        const deleteScript = `
            for i in $(seq 1 ${maxChars}); do
                input keyevent KEYCODE_DEL
            done
        `.replace(/\n/g, ' ').trim();
        
        // Alternative: Use Ctrl+A then Delete (much faster)
        // Select all (Ctrl+A) then delete
        await this.execAdb('shell input keyevent KEYCODE_MOVE_END');
        await this.execAdb('shell input keycombination 113 29'); // Ctrl+A (select all)
        await this.sleep(100);
        await this.execAdb('shell input keyevent KEYCODE_DEL');
    }

    /**
     * OPTIMIZED: Perform multiple taps efficiently
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate  
     * @param {number} count - Number of taps
     * @param {number} delay - Delay between taps in ms
     */
    async multiTap(x, y, count = 1, delay = 150) {
        if (count === 1) {
            await this.execAdb(`shell input tap ${x} ${y}`);
            return;
        }

        // Build batch command for multiple taps
        const commands = [];
        for (let i = 0; i < count; i++) {
            commands.push(`input tap ${x} ${y}`);
            if (i < count - 1 && delay > 0) {
                commands.push(`sleep ${delay / 1000}`);
            }
        }
        
        await this.execAdbBatch(commands);
    }

    /**
     * OPTIMIZED: Double tap for like
     * On slow devices (X8 3GB RAM), input tap is too slow — 
     * TikTok reads 2 single taps (pause+unpause) instead of 1 double tap.
     * 
     * Solution: Use sendevent which is MUCH faster than input tap.
     * sendevent writes directly to the input device, no Java overhead.
     */
    async doubleTap(x, y) {
        if (!this._touchDevice) {
            // Detect touch input device once (cache it)
            try {
                const devices = await this.execAdb('shell "cat /proc/bus/input/devices"');
                // Find the touchscreen device event path
                const touchMatch = devices.match(/Touch[\s\S]*?event(\d+)/i) ||
                                   devices.match(/input_mt[\s\S]*?event(\d+)/i);
                if (touchMatch) {
                    this._touchDevice = `/dev/input/event${touchMatch[1]}`;
                }
            } catch (e) { }

            // Also detect if this device needs coordinate scaling for sendevent
            // sendevent uses raw touch coordinates which may differ from screen pixels
            try {
                const maxX = await this.execAdb('shell "cat /sys/class/input/event*/device/properties 2>/dev/null || echo"');
                // For simplicity, check if getevent can give us max ranges
                const absInfo = await this.execAdb('shell "getevent -lp 2>/dev/null | grep ABS_MT_POSITION" || true');
                if (absInfo.includes('ABS_MT_POSITION_X')) {
                    const xMax = absInfo.match(/ABS_MT_POSITION_X.*?max\s+(\d+)/);
                    const yMax = absInfo.match(/ABS_MT_POSITION_Y.*?max\s+(\d+)/);
                    if (xMax && yMax) {
                        this._touchMaxRawX = parseInt(xMax[1]);
                        this._touchMaxRawY = parseInt(yMax[1]);
                    }
                }
            } catch (e) { }
        }

        // If we have sendevent info AND raw touch ranges, use fast sendevent
        if (this._touchDevice && this._touchMaxRawX && this._touchMaxRawY) {
            // Scale screen coordinates to raw touch coordinates
            const rawX = Math.round(x * this._touchMaxRawX / this.screenWidth);
            const rawY = Math.round(y * this._touchMaxRawY / this.screenHeight);
            const dev = this._touchDevice;

            // Two taps via sendevent — MUCH faster than input tap
            const cmd = [
                // Tap 1: DOWN
                `sendevent ${dev} 3 57 0`,      // ABS_MT_TRACKING_ID
                `sendevent ${dev} 3 53 ${rawX}`, // ABS_MT_POSITION_X
                `sendevent ${dev} 3 54 ${rawY}`, // ABS_MT_POSITION_Y
                `sendevent ${dev} 1 330 1`,      // BTN_TOUCH DOWN
                `sendevent ${dev} 0 0 0`,        // SYN_REPORT
                // Tap 1: UP
                `sendevent ${dev} 3 57 -1`,      // ABS_MT_TRACKING_ID release
                `sendevent ${dev} 1 330 0`,      // BTN_TOUCH UP
                `sendevent ${dev} 0 0 0`,        // SYN_REPORT
                // Tap 2: DOWN (immediate — no sleep needed!)
                `sendevent ${dev} 3 57 1`,
                `sendevent ${dev} 3 53 ${rawX}`,
                `sendevent ${dev} 3 54 ${rawY}`,
                `sendevent ${dev} 1 330 1`,
                `sendevent ${dev} 0 0 0`,
                // Tap 2: UP
                `sendevent ${dev} 3 57 -1`,
                `sendevent ${dev} 1 330 0`,
                `sendevent ${dev} 0 0 0`
            ].join(' && ');

            try {
                await this.execAdb(`shell "${cmd}"`);
                return;
            } catch (e) {
                // sendevent failed, fall through to input tap
            }
        }

        // Fallback: input tap with minimal delay
        try {
            await this.execAdb(`shell "input tap ${x} ${y} && sleep 0.05 && input tap ${x} ${y}"`);
        } catch (e) {
            await this.execAdb(`shell input tap ${x} ${y}`);
            await this.execAdb(`shell input tap ${x} ${y}`);
        }
    }

    /**
     * OPTIMIZED: Send multiple key events in one call
     * @param {string[]} keycodes - Array of keycodes
     */
    async sendKeys(keycodes) {
        if (!keycodes || keycodes.length === 0) return;
        
        const commands = keycodes.map(k => `input keyevent ${k}`);
        await this.execAdbBatch(commands);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    randomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }
}

module.exports = DeviceWorker;