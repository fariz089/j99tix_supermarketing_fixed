const UIHelper = require('./UIHelper');

class BoostLiveTask {

    static async execute(worker, config) {
        const {
            liveUrl, username,
            duration = 1800,
            interval = 10,
            percentages = { tap: 15, like: 30, comment: 10, share: 5 },
            idleDelayMin = 0, idleDelayMax = 0,
            jobId,
            deviceIndex = 0,
            joinDelay = 0, likeDelay = 0, commentDelay = 0, shareDelay = 0,
            likeEnabled = true, commentEnabled = true, shareEnabled = true
        } = config;

        const startTime = Date.now();
        const endTime = startTime + (duration * 1000);
        const db = worker.db;
        const W = worker.screenWidth;
        const H = worker.screenHeight;

        let stats = { likes: 0, comments: 0, commentsFailed: 0, shares: 0, checks: 0 };
        let shareDone = false;
        let lastCommentTime = 0;

        const checkCancelled = async () => {
            if (jobId && db) {
                const job = db.getJob(jobId);
                if (job && job.status === 'cancelled') {
                    await UIHelper.closeTikTok(worker);
                    await UIHelper.goHome(worker);
                    return true;
                }
            }
            return false;
        };

        try {
            const tier = UIHelper.getDeviceTier(worker);
            console.log(`[${worker.deviceId}] 🎥 Boost Live | ${duration}s, Device #${deviceIndex + 1}, screen ${W}x${H}, tier: ${tier}`);
            console.log(`[${worker.deviceId}]    Like: ${likeEnabled ? 'ON' : 'OFF'}, Comment: ${commentEnabled ? 'ON' : 'OFF'} (delay ${commentDelay}s), Share: ${shareEnabled ? '1x' : 'OFF'}`);

            // Pre-detect touch device for X8 sendevent
            if (tier === 'low' && !worker._touchDevice) {
                try {
                    const devices = await worker.execAdb('shell "cat /proc/bus/input/devices"');
                    const touchMatch = devices.match(/Touch[\s\S]*?event(\d+)/i) ||
                                       devices.match(/input_mt[\s\S]*?event(\d+)/i);
                    if (touchMatch) worker._touchDevice = `/dev/input/event${touchMatch[1]}`;
                    const absInfo = await worker.execAdb('shell "getevent -lp 2>/dev/null | grep ABS_MT_POSITION" || true');
                    if (absInfo.includes('ABS_MT_POSITION_X')) {
                        const xMax = absInfo.match(/ABS_MT_POSITION_X.*?max\s+(\d+)/);
                        const yMax = absInfo.match(/ABS_MT_POSITION_Y.*?max\s+(\d+)/);
                        if (xMax && yMax) {
                            worker._touchMaxRawX = parseInt(xMax[1]);
                            worker._touchMaxRawY = parseInt(yMax[1]);
                        }
                    }
                } catch (e) { }
            }

            // Sequential join delay
            const joinWait = deviceIndex * joinDelay;
            if (joinWait > 0) {
                console.log(`[${worker.deviceId}] 🚪 Join delay: ${joinWait}s`);
                let waited = 0;
                while (waited < joinWait * 1000) {
                    if (await checkCancelled()) throw new Error('Job cancelled by user');
                    const chunk = Math.min(5000, (joinWait * 1000) - waited);
                    await worker.sleep(chunk);
                    waited += chunk;
                }
            }

            // Random idle delay
            if (idleDelayMax > 0) {
                const randomDelay = worker.randomInt(idleDelayMin, idleDelayMax);
                console.log(`[${worker.deviceId}] ⏱️ Idle delay: ${randomDelay}s`);
                await worker.sleep(randomDelay * 1000);
            }

            if (await checkCancelled()) throw new Error('Job cancelled by user');

            // Open TikTok
            await UIHelper.closeTikTok(worker);
            await worker.sleep(1000);
            await UIHelper.openTikTok(worker);

            if (await checkCancelled()) throw new Error('Job cancelled by user');

            // Optional FYP scroll
            const scrollCount = worker.randomInt(0, 2);
            for (let i = 0; i < scrollCount; i++) {
                if (await checkCancelled()) throw new Error('Job cancelled by user');
                await UIHelper.swipeFYP(worker);
                await worker.sleep(worker.randomInt(2000, 4000));
            }

            if (await checkCancelled()) throw new Error('Job cancelled by user');

            // Open live stream
            let opened = false;
            if (liveUrl) {
                try {
                    console.log(`[${worker.deviceId}] 🔗 Opening live URL...`);
                    await UIHelper.openUrl(worker, liveUrl);
                    await worker.sleep(3000);
                    opened = true;
                } catch (e) {
                    console.log(`[${worker.deviceId}] ⚠️ URL failed`);
                }
            }
            if (!opened && username) {
                try {
                    const clean = username.replace('@', '');
                    await UIHelper.openUrl(worker, `https://www.tiktok.com/@${clean}/live`);
                    await worker.sleep(3000);
                    opened = true;
                } catch (e) { }
            }
            if (!opened) throw new Error('Failed to open live stream');

            // Check captcha after opening
            await worker.sleep(2000);
            await this._handleCaptcha(worker);

            console.log(`[${worker.deviceId}] ✅ Live opened - watching for ${duration}s`);

            // ============================================================
            // MAIN LOOP
            // Every interval: double tap (like), check comment, share 1x
            // ============================================================
            while (Date.now() < endTime) {
                if (await checkCancelled()) throw new Error('Job cancelled by user');
                if (worker.status === 'paused') { await worker.waitForResume(); continue; }

                stats.checks++;
                const now = Date.now();
                const elapsed = (now - startTime) / 1000;

                // ---- DOUBLE TAP LIKE (proven method from supermarketing) ----
                if (likeEnabled) {
                    const myLikeTime = deviceIndex * likeDelay;
                    if (elapsed >= myLikeTime) {
                        await UIHelper.doubleTapLikeCenter(worker);
                        stats.likes++;
                    }
                }

                // ---- COMMENT (sequential via database cycle) ----
                if (commentEnabled) {
                    const timeSinceLastComment = (now - lastCommentTime) / 1000;

                    if (lastCommentTime === 0 || timeSinceLastComment >= commentDelay) {
                        const commentResult = db.tryGetComment ?
                            db.tryGetComment(jobId, worker.deviceId, deviceIndex, commentDelay) :
                            { status: 'ok', comment: db.getAndUseComment ? db.getAndUseComment(jobId, worker.deviceId) : null };

                        if (commentResult.status === 'ok' && commentResult.comment) {
                            console.log(`[${worker.deviceId}] 💬 Commenting: "${commentResult.comment}"`);

                            const success = await this._postCommentLive(worker, commentResult.comment);

                            if (success) {
                                stats.comments++;
                                if (db.markDeviceCommented) db.markDeviceCommented(jobId, worker.deviceId);
                                console.log(`[${worker.deviceId}] ✅ Comment posted`);
                            } else {
                                stats.commentsFailed++;
                                console.log(`[${worker.deviceId}] ❌ Comment failed`);
                            }
                            lastCommentTime = Date.now();

                            // Check captcha after comment
                            await this._handleCaptcha(worker);
                        }
                        // waiting_delay, already_commented, no_comments → skip
                    }
                }

                // ---- SHARE (1x only) ----
                if (shareEnabled && !shareDone) {
                    const myShareTime = deviceIndex * shareDelay;
                    if (elapsed >= myShareTime) {
                        console.log(`[${worker.deviceId}] 🔄 Sharing...`);
                        const shared = await UIHelper.clickShareAndRepost(worker);
                        if (shared) {
                            stats.shares++;
                            console.log(`[${worker.deviceId}] ✅ Shared`);
                        }
                        shareDone = true;
                    }
                }

                // ---- LOG every 5 checks ----
                if (stats.checks % 5 === 0) {
                    const el = Math.floor(elapsed);
                    const rem = Math.max(0, Math.floor((endTime - Date.now()) / 1000));
                    console.log(`[${worker.deviceId}] 📊 ${el}s/${duration}s (${rem}s left) | L:${stats.likes} C:${stats.comments} S:${stats.shares}`);
                }

                // Sleep interval
                await worker.sleep(interval * 1000);
            }

            // Cleanup
            await UIHelper.closeTikTok(worker);
            await UIHelper.goHome(worker);

            const actualDur = Math.floor((Date.now() - startTime) / 1000);
            console.log(`[${worker.deviceId}] ✅ Done! ${actualDur}s | Likes:${stats.likes} Comments:${stats.comments} Shares:${stats.shares}`);

            return { duration: actualDur, stats };
        } catch (error) {
            console.error(`[${worker.deviceId}] ❌ Stopped:`, error.message);
            try { await UIHelper.closeTikTok(worker); await UIHelper.goHome(worker); } catch (e) { }
            throw error;
        }
    }

    /**
     * Post comment in LIVE stream.
     */
    static async _postCommentLive(worker, comment) {
        try {
            await UIHelper.clickCommentInputLive(worker);
            await worker.sleep(1500);

            const typed = await UIHelper.typeWithADBKeyboard(worker, comment);
            if (!typed) return false;
            await worker.sleep(800);

            await UIHelper.clickSendButtonLive(worker);
            await worker.sleep(1500);
            return true;
        } catch (e) {
            console.log(`[${worker.deviceId}] ⚠️ Comment error: ${e.message}`);
            try { await UIHelper.goBack(worker); } catch (e2) { }
            await worker.sleep(500);
            return false;
        }
    }

    /**
     * Detect and try to dismiss captcha.
     */
    static async _handleCaptcha(worker) {
        try {
            const { detected } = await UIHelper.detectCaptcha(worker);
            if (!detected) return false;

            console.log(`[${worker.deviceId}] 🛡️ Captcha detected! Dismissing...`);

            for (let i = 0; i < 3; i++) {
                const xml = await UIHelper.dumpUI(worker);
                if (xml) {
                    for (const desc of ['Close', '×', 'close', 'Tutup']) {
                        const r = UIHelper.findByContentDesc(xml, desc);
                        if (r.success) {
                            await worker.execAdb(`shell input tap ${r.x} ${r.y}`);
                            await worker.sleep(2000);
                            break;
                        }
                    }
                }

                await UIHelper.goBack(worker);
                await worker.sleep(2000);

                const check = await UIHelper.detectCaptcha(worker);
                if (!check.detected) {
                    console.log(`[${worker.deviceId}] ✅ Captcha dismissed`);
                    return true;
                }
            }

            console.log(`[${worker.deviceId}] ⚠️ Captcha persists, waiting 30s...`);
            await worker.sleep(30000);
            return false;
        } catch (e) { return false; }
    }
}

module.exports = BoostLiveTask;