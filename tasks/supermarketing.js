const UIHelper = require('./UIHelper');

class SuperMarketingTask {

    /**
     * Detect device tier based on deviceInfo
     * - 'low' = EVERCOSS X8 (slow, low RAM) → ultra-fast double tap
     * - 'high' = Samsung/OPPO 8GB RAM → normal double tap
     */
    static getDeviceTier(worker) {
        const info = worker.deviceInfo || {};
        const model = (info.model || '').toUpperCase();
        const manufacturer = (info.manufacturer || '').toUpperCase();

        // EVERCOSS X8 = low-end, very slow
        if (manufacturer.includes('EVERCOSS') || model === 'X8') {
            return 'low';
        }
        // Samsung, OPPO = high-end (8GB RAM)
        if (manufacturer.includes('SAMSUNG') || manufacturer.includes('OPPO') ||
            model.startsWith('SM-') || model.startsWith('PDEM')) {
            return 'high';
        }
        // Default to high
        return 'high';
    }

    /**
     * Double tap center of video to like — NO UI dump, NO uiautomator
     * 
     * For EVERCOSS X8 (low-end, lemot):
     *   - Use sendevent (fastest possible, zero Java overhead)
     *   - Fallback: "input swipe X Y X Y 30" two times in one shell (ultra-fast)
     *   - The gap between taps must be < 100ms or TikTok won't register as double tap
     * 
     * For Samsung/OPPO (high-end, 8GB RAM):
     *   - Use worker.doubleTap() which already handles sendevent + fallback
     *   - These devices are fast enough that input tap works fine
     */
    static async doubleTapLikeCenter(worker) {
        const tier = this.getDeviceTier(worker);
        const W = worker.screenWidth;
        const H = worker.screenHeight;

        // Random center position (avoid edges)
        const x = worker.randomInt(Math.round(W * 0.30), Math.round(W * 0.70));
        const y = worker.randomInt(Math.round(H * 0.35), Math.round(H * 0.60));

        if (tier === 'low') {
            // ============================================
            // EVERCOSS X8: Ultra-fast double tap
            // These devices are SO slow that even "input tap && sleep 0.05 && input tap"
            // has too much overhead. We need the absolute fastest method.
            // ============================================

            // Method 1: sendevent (fastest — direct kernel input, no Java)
            if (worker._touchDevice && worker._touchMaxRawX && worker._touchMaxRawY) {
                const rawX = Math.round(x * worker._touchMaxRawX / W);
                const rawY = Math.round(y * worker._touchMaxRawY / H);
                const dev = worker._touchDevice;

                const cmd = [
                    `sendevent ${dev} 3 57 0`,
                    `sendevent ${dev} 3 53 ${rawX}`,
                    `sendevent ${dev} 3 54 ${rawY}`,
                    `sendevent ${dev} 1 330 1`,
                    `sendevent ${dev} 0 0 0`,
                    `sendevent ${dev} 3 57 -1`,
                    `sendevent ${dev} 1 330 0`,
                    `sendevent ${dev} 0 0 0`,
                    `sendevent ${dev} 3 57 1`,
                    `sendevent ${dev} 3 53 ${rawX}`,
                    `sendevent ${dev} 3 54 ${rawY}`,
                    `sendevent ${dev} 1 330 1`,
                    `sendevent ${dev} 0 0 0`,
                    `sendevent ${dev} 3 57 -1`,
                    `sendevent ${dev} 1 330 0`,
                    `sendevent ${dev} 0 0 0`
                ].join(' && ');

                try {
                    await worker.execAdb(`shell "${cmd}"`);
                    console.log(`[${worker.deviceId}] ❤️ X8 sendevent double-tap at (${x}, ${y})`);
                    return true;
                } catch (e) { /* fall through */ }
            }

            // Method 2: Two "input swipe" with 30ms hold in background (& trick)
            // This runs both taps nearly simultaneously via shell background process
            try {
                await worker.execAdb(`shell "input swipe ${x} ${y} ${x} ${y} 30 & input swipe ${x} ${y} ${x} ${y} 30"`);
                console.log(`[${worker.deviceId}] ❤️ X8 swipe-double-tap at (${x}, ${y})`);
                return true;
            } catch (e) { /* fall through */ }

            // Method 3: Last resort — two input taps with absolute minimum gap
            try {
                await worker.execAdb(`shell "input tap ${x} ${y} && input tap ${x} ${y}"`);
                console.log(`[${worker.deviceId}] ❤️ X8 fast-tap double-tap at (${x}, ${y})`);
                return true;
            } catch (e) { /* fall through */ }

        } else {
            // ============================================
            // Samsung / OPPO (8GB RAM): Normal double tap
            // These devices are fast enough, use worker.doubleTap()
            // which has sendevent → input tap fallback chain
            // ============================================
            try {
                await worker.doubleTap(x, y);
                console.log(`[${worker.deviceId}] ❤️ Double-tap like at (${x}, ${y})`);
                return true;
            } catch (e) { /* fall through */ }
        }

        // Absolute fallback for any device
        try {
            await worker.execAdb(`shell input tap ${x} ${y}`);
            await worker.sleep(50);
            await worker.execAdb(`shell input tap ${x} ${y}`);
            console.log(`[${worker.deviceId}] ❤️ Fallback double-tap at (${x}, ${y})`);
        } catch (e) { }
        return true;
    }

    static async execute(worker, config) {
        const {
            urls = [],
            durationMin = 5,
            durationMax = 60,
            idleDelayMin = 2,
            idleDelayMax = 5,
            scrollCount = 5,
            scrollDelayMin = 2,
            scrollDelayMax = 5,
            openUrlDelay = 2,
            totalCycles = 1,
            likeEnabled = true,
            likeChance = 5,
            jobId
        } = config;

        const db = worker.db;
        let stats = { cyclesCompleted: 0, totalUrlsWatched: 0, totalWatchTime: 0, likes: 0 };
        const tier = this.getDeviceTier(worker);

        const checkCancelled = () => {
            if (jobId && db) {
                const job = db.getJob(jobId);
                if (job && job.status === 'cancelled') throw new Error('Job cancelled by user');
            }
        };

        // Pre-detect touch device for X8 sendevent (do it once upfront)
        if (tier === 'low' && !worker._touchDevice) {
            try {
                const devices = await worker.execAdb('shell "cat /proc/bus/input/devices"');
                const touchMatch = devices.match(/Touch[\s\S]*?event(\d+)/i) ||
                                   devices.match(/input_mt[\s\S]*?event(\d+)/i);
                if (touchMatch) {
                    worker._touchDevice = `/dev/input/event${touchMatch[1]}`;
                }
                const absInfo = await worker.execAdb('shell "getevent -lp 2>/dev/null | grep ABS_MT_POSITION" || true');
                if (absInfo.includes('ABS_MT_POSITION_X')) {
                    const xMax = absInfo.match(/ABS_MT_POSITION_X.*?max\s+(\d+)/);
                    const yMax = absInfo.match(/ABS_MT_POSITION_Y.*?max\s+(\d+)/);
                    if (xMax && yMax) {
                        worker._touchMaxRawX = parseInt(xMax[1]);
                        worker._touchMaxRawY = parseInt(yMax[1]);
                    }
                }
                console.log(`[${worker.deviceId}] 🔧 X8 touch device: ${worker._touchDevice || 'not found'}, raw max: ${worker._touchMaxRawX || '?'}x${worker._touchMaxRawY || '?'}`);
            } catch (e) { }
        }

        try {
            console.log(`[${worker.deviceId}] 🎯 Super Marketing | ${totalCycles} cycles, ${urls.length} URLs, screen ${worker.screenWidth}x${worker.screenHeight}, tier: ${tier}`);
            console.log(`[${worker.deviceId}] ❤️ Like: ${likeEnabled ? `${likeChance}% (double-tap only)` : 'OFF'}`);

            // Random stagger 0-3s so 100 devices don't all hit ADB at the same time
            await worker.sleep(worker.randomInt(0, 3000));

            // Close & go home (lightweight, no UI dump needed)
            await UIHelper.closeTikTok(worker);
            await UIHelper.goHome(worker);

            // Idle delay
            const idleDelay = worker.randomInt(idleDelayMin, idleDelayMax);
            if (idleDelay > 0) {
                console.log(`[${worker.deviceId}] ⏸️ Idle ${idleDelay}s...`);
                await worker.sleep(idleDelay * 1000);
            }
            if (worker.status === 'paused') await worker.waitForResume();

            // Open TikTok
            await UIHelper.openTikTok(worker);
            if (worker.status === 'paused') await worker.waitForResume();

            // FYP scroll (uses swipe — no UI dump)
            const actualScrolls = worker.randomInt(0, scrollCount);
            for (let i = 0; i < actualScrolls; i++) {
                if (worker.status === 'paused') await worker.waitForResume();
                await UIHelper.swipeFYP(worker);
                await worker.sleep(worker.randomInt(scrollDelayMin, scrollDelayMax) * 1000);
                if (likeEnabled && Math.random() < 0.1) {
                    await this.doubleTapLikeCenter(worker);
                    stats.likes++;
                }
            }

            // Main loop
            for (let cycle = 0; cycle < totalCycles; cycle++) {
                checkCancelled();
                if (worker.status === 'paused') await worker.waitForResume();
                console.log(`[${worker.deviceId}] 🔄 Cycle ${cycle + 1}/${totalCycles}`);

                const shuffledUrls = [...urls].sort(() => Math.random() - 0.5);

                for (let ui = 0; ui < shuffledUrls.length; ui++) {
                    checkCancelled();
                    if (worker.status === 'paused') await worker.waitForResume();

                    if (cycle > 0 || ui > 0) {
                        await worker.sleep(worker.randomInt(1, openUrlDelay) * 1000);
                    }

                    // Open URL with retry (uses am start — no UI dump)
                    let opened = false;
                    for (let r = 0; r < 2; r++) {
                        try {
                            await UIHelper.openUrl(worker, shuffledUrls[ui]);
                            opened = true;
                            break;
                        } catch (e) { if (r === 0) await worker.sleep(2000); }
                    }
                    if (!opened) { console.log(`[${worker.deviceId}] ❌ URL failed, skip`); continue; }

                    // Watch video
                    const dur = worker.randomInt(durationMin, durationMax);
                    console.log(`[${worker.deviceId}] 👁️ Watching ${dur}s (${ui + 1}/${shuffledUrls.length})...`);

                    const watchEnd = Date.now() + (dur * 1000);
                    let lastAction = 0;

                    while (Date.now() < watchEnd) {
                        checkCancelled();
                        if (worker.status === 'paused') await worker.waitForResume();
                        
                        // Sleep 2s instead of 500ms — with 100 devices, 500ms = 200 wakeups/sec!
                        // 2s = 50 wakeups/sec total, much lighter on CPU
                        await worker.sleep(2000);
                        
                        if (!likeEnabled) continue;
                        const now = Date.now();
                        if (now - lastAction < 5000) continue;
                        if (Math.random() * 100 < likeChance) {
                            await this.doubleTapLikeCenter(worker);
                            lastAction = now;
                            stats.likes++;
                        }
                    }

                    stats.totalWatchTime += dur;
                    stats.totalUrlsWatched++;
                }

                stats.cyclesCompleted++;
                if (jobId && db) { try { db.incrementJobProgress(jobId, 1); } catch (e) { } }

                if (cycle < totalCycles - 1 && Math.random() < 0.3) {
                    await UIHelper.swipeFYP(worker);
                    await worker.sleep(worker.randomInt(1000, 2000));
                }
            }

            await UIHelper.closeTikTok(worker);
            await UIHelper.goHome(worker);
            console.log(`[${worker.deviceId}] ✅ Done! ${stats.cyclesCompleted} cycles, ${stats.totalUrlsWatched} URLs, ${stats.likes} likes`);

            return stats;
        } catch (error) {
            console.error(`[${worker.deviceId}] ❌ Failed:`, error.message);
            try { await UIHelper.closeTikTok(worker); await UIHelper.goHome(worker); } catch (e) { }
            throw error;
        }
    }
}

module.exports = SuperMarketingTask;
