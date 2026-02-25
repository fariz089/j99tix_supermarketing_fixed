const UIHelper = require('./UIHelper');

class BoostLiveTask {

    static async execute(worker, config) {
        const {
            liveUrl, username,
            duration = 1800,
            interval = 10,
            percentages = { tap: 15, like: 30, comment: 100, share: 5 },
            idleDelayMin = 0, idleDelayMax = 0,
            jobId,
            deviceIndex = 0,
            joinDelay = 0, likeDelay = 0, commentDelay = 0, shareDelay = 0,
            likeEnabled = true, commentEnabled = true, shareEnabled = true
        } = config;

        const startTime = Date.now();
        const endTime = startTime + (duration * 1000);
        const db = worker.db;

        let stats = { taps: 0, likes: 0, comments: 0, commentsFailed: 0, shares: 0, checks: 0 };

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
            console.log(`[${worker.deviceId}] 🎥 Boost Live | ${duration}s, Device #${deviceIndex + 1}, screen ${worker.screenWidth}x${worker.screenHeight}`);
            console.log(`[${worker.deviceId}]    Join: ${deviceIndex * joinDelay}s, Like: ${likeEnabled ? 'ON' : 'OFF'}, Comment: ${commentEnabled ? 'ON' : 'OFF'}, Share: ${shareEnabled ? 'ON' : 'OFF'}`);

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

            // Additional random idle delay
            if (idleDelayMax > 0) {
                const randomDelay = worker.randomInt(idleDelayMin, idleDelayMax);
                console.log(`[${worker.deviceId}] ⏱️ Idle delay: ${randomDelay}s`);
                await worker.sleep(randomDelay * 1000);
            }

            if (await checkCancelled()) throw new Error('Job cancelled by user');

            // Open TikTok and go to live
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

            console.log(`[${worker.deviceId}] ✅ Live opened - watching for ${duration}s`);

            // Track if comment has been done this cycle (comment is sequential/berurutan)
            let commentDoneThisCycle = false;

            // Main loop
            while (Date.now() < endTime) {
                if (await checkCancelled()) throw new Error('Job cancelled by user');
                if (worker.status === 'paused') { await worker.waitForResume(); continue; }

                stats.checks++;
                await worker.sleep(interval * 1000);
                if (Date.now() >= endTime) break;
                if (await checkCancelled()) throw new Error('Job cancelled by user');
                if (worker.status === 'paused') continue;

                const elapsed = (Date.now() - startTime) / 1000;

                // ============ LIKE (random, berdasarkan persentase) ============
                if (likeEnabled && Math.random() * 100 < percentages.like) {
                    const myLikeTime = deviceIndex * likeDelay;
                    if (elapsed >= myLikeTime) {
                        await UIHelper.doubleTapLike(worker);
                        stats.likes++;
                        await worker.sleep(worker.randomInt(500, 1500));
                    }
                }

                // ============ TAP SCREEN (random natural behavior) ============
                if (Math.random() * 100 < percentages.tap) {
                    await UIHelper.tapScreen(worker);
                    stats.taps++;
                    await worker.sleep(worker.randomInt(300, 800));
                }

                // ============ COMMENT (sequential/berurutan via database) ============
                if (commentEnabled && !commentDoneThisCycle) {
                    const commentResult = db.tryGetComment ?
                        db.tryGetComment(jobId, worker.deviceId, deviceIndex, commentDelay) :
                        { status: 'ok', comment: db.getAndUseComment ? db.getAndUseComment(jobId, worker.deviceId) : null };

                    if (commentResult.status === 'already_commented') {
                        commentDoneThisCycle = true;
                    } else if (commentResult.status === 'waiting_delay') {
                        // Will retry next interval
                    } else if (commentResult.status === 'ok' && commentResult.comment) {
                        console.log(`[${worker.deviceId}] 💬 Commenting: "${commentResult.comment}"`);

                        const commentSuccess = await this._postCommentLive(worker, commentResult.comment);

                        if (commentSuccess) {
                            stats.comments++;
                            if (db.markDeviceCommented) db.markDeviceCommented(jobId, worker.deviceId);
                            commentDoneThisCycle = true;
                            console.log(`[${worker.deviceId}] ✅ Comment posted`);
                        } else {
                            stats.commentsFailed++;
                            console.log(`[${worker.deviceId}] ❌ Comment failed`);
                        }
                        await worker.sleep(worker.randomInt(1000, 2000));
                    }
                }

                // Reset commentDoneThisCycle when new cycle starts
                if (commentDoneThisCycle && db.canDeviceComment && db.canDeviceComment(jobId, worker.deviceId)) {
                    commentDoneThisCycle = false;
                }

                // ============ SHARE (random) ============
                if (shareEnabled && Math.random() * 100 < percentages.share) {
                    const myShareTime = deviceIndex * shareDelay;
                    if (elapsed >= myShareTime) {
                        const shared = await UIHelper.clickShareAndRepost(worker);
                        if (shared) stats.shares++;
                        await worker.sleep(worker.randomInt(500, 1500));
                    }
                }

                // Log every 5 checks
                if (stats.checks % 5 === 0) {
                    const el = Math.floor((Date.now() - startTime) / 1000);
                    const rem = Math.floor((endTime - Date.now()) / 1000);
                    console.log(`[${worker.deviceId}] 📊 ${el}s/${duration}s (${rem}s left) | L:${stats.likes} C:${stats.comments} S:${stats.shares} T:${stats.taps}`);
                }
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
     * Live has input field always visible at bottom, send button to the right.
     * UIAutomator dump works in live (not SurfaceView-blocked like video playback).
     */
    static async _postCommentLive(worker, comment) {
        try {
            // Step 1: Click the comment input at bottom of live
            await UIHelper.clickCommentInputLive(worker);
            await worker.sleep(1500);

            // Step 2: Type comment
            const typed = await UIHelper.typeWithADBKeyboard(worker, comment);
            if (!typed) {
                console.log(`[${worker.deviceId}] ⚠️ Type failed`);
                return false;
            }
            await worker.sleep(800);

            // Step 3: Send — use live-specific send button
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
}

module.exports = BoostLiveTask;