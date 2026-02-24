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
                    await worker.sleep(2000);
                    opened = true;
                } catch (e) {
                    console.log(`[${worker.deviceId}] ⚠️ URL failed`);
                }
            }
            if (!opened && username) {
                try {
                    const clean = username.replace('@', '');
                    await UIHelper.openUrl(worker, `https://www.tiktok.com/@${clean}/live`);
                    await worker.sleep(2000);
                    opened = true;
                } catch (e) { }
            }
            if (!opened) throw new Error('Failed to open live stream');

            console.log(`[${worker.deviceId}] ✅ Live opened - watching for ${duration}s`);

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
                const actions = [];

                // Tap screen (natural behavior)
                if (Math.random() * 100 < percentages.tap) {
                    actions.push(async () => {
                        await UIHelper.tapScreen(worker);
                        stats.taps++;
                    });
                }

                // Like
                if (likeEnabled && Math.random() * 100 < percentages.like) {
                    const myLikeTime = deviceIndex * likeDelay;
                    if (elapsed >= myLikeTime) {
                        actions.push(async () => {
                            await UIHelper.doubleTapLike(worker);
                            stats.likes++;
                        });
                    }
                }

                // Comment
                if (commentEnabled && Math.random() * 100 < percentages.comment) {
                    actions.push(async () => {
                        const commentResult = db.tryGetComment ?
                            db.tryGetComment(jobId, worker.deviceId, deviceIndex, commentDelay) :
                            { status: 'ok', comment: db.getAndUseComment ? db.getAndUseComment(jobId, worker.deviceId) : null };

                        if (commentResult.status === 'already_commented' || commentResult.status === 'waiting_delay' || commentResult.status === 'no_comments') return;

                        if (commentResult.comment) {
                            console.log(`[${worker.deviceId}] 💬 Commenting...`);

                            // Click comment/type area on live
                            const typeClicked = await UIHelper.clickByDesc(worker, 'type|comment|chat', 2);
                            if (!typeClicked.success) {
                                // Fallback: tap bottom area where chat input usually is
                                const x = Math.round(worker.screenWidth * 0.35);
                                const y = Math.round(worker.screenHeight * 0.90);
                                await worker.multiTap(x, y, 3, 300);
                            }
                            await worker.sleep(2000);

                            const typed = await UIHelper.typeWithADBKeyboard(worker, commentResult.comment);
                            if (typed) {
                                await worker.sleep(1000);
                                const sent = await UIHelper.clickSendButton(worker);
                                await worker.sleep(1500);
                                stats.comments++;
                                if (db.markDeviceCommented) db.markDeviceCommented(jobId, worker.deviceId);
                                console.log(`[${worker.deviceId}] ✅ Comment posted`);
                            } else {
                                stats.commentsFailed++;
                            }
                        }
                    });
                }

                // Share (using UIAutomator - now works on all resolutions)
                if (shareEnabled && Math.random() * 100 < percentages.share) {
                    const myShareTime = deviceIndex * shareDelay;
                    if (elapsed >= myShareTime) {
                        actions.push(async () => {
                            const shared = await UIHelper.clickShareAndRepost(worker);
                            if (shared) stats.shares++;
                        });
                    }
                }

                // Execute actions
                for (const action of actions) {
                    if (await checkCancelled()) throw new Error('Job cancelled by user');
                    if (worker.status === 'paused') break;
                    await action();
                    await worker.sleep(worker.randomInt(500, 1500));
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
}

module.exports = BoostLiveTask;
