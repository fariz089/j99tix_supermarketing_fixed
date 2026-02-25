const UIHelper = require('./UIHelper');

class SuperMarketingTask {

    /**
     * Delegate to UIHelper (shared method)
     */
    static getDeviceTier(worker) {
        return UIHelper.getDeviceTier(worker);
    }

    static async doubleTapLikeCenter(worker) {
        return UIHelper.doubleTapLikeCenter(worker);
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