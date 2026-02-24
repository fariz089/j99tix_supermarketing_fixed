const UIHelper = require('./UIHelper');

class WarmupTask {

    static async execute(worker, config) {
        const { duration = 3600, percentages = {}, jobId } = config;
        const db = worker.db;
        const startTime = Date.now();
        const endTime = startTime + (duration * 1000);

        const viewChance = percentages.view || 100;
        const likeChance = percentages.like || 30;
        const commentChance = percentages.comment || 10;
        const shareChance = percentages.share || 5;

        let stats = { scrolls: 0, likes: 0, comments: 0, shares: 0, actions: 0 };

        const checkCancelled = () => {
            if (jobId && db) {
                const job = db.getJob(jobId);
                if (job && job.status === 'cancelled') throw new Error('Job cancelled by user');
            }
        };

        try {
            console.log(`[${worker.deviceId}] 🔥 Warmup | ${duration}s, screen ${worker.screenWidth}x${worker.screenHeight}`);
            console.log(`[${worker.deviceId}]    View: ${viewChance}%, Like: ${likeChance}%, Comment: ${commentChance}%, Share: ${shareChance}%`);

            await UIHelper.closeTikTok(worker);
            await UIHelper.openTikTok(worker);

            while (Date.now() < endTime) {
                checkCancelled();
                if (worker.status === 'paused') await worker.waitForResume();

                // Scroll to next video
                const roll = Math.random() * 100;
                if (roll < viewChance) {
                    await UIHelper.swipeFYP(worker);
                    stats.scrolls++;
                    await worker.sleep(worker.randomInt(3000, 8000));
                }

                checkCancelled();
                if (worker.status === 'paused') await worker.waitForResume();

                // Like (double tap)
                if (Math.random() * 100 < likeChance) {
                    await UIHelper.doubleTapLike(worker);
                    stats.likes++;
                    await worker.sleep(500);
                }

                // Comment (just tap comment icon then close - for warmup behavior)
                if (Math.random() * 100 < commentChance) {
                    await UIHelper.clickCommentButton(worker);
                    await worker.sleep(1500);
                    await UIHelper.goBack(worker);
                    stats.comments++;
                }

                // Share (open share menu, maybe repost, then close)
                if (Math.random() * 100 < shareChance) {
                    const shared = await UIHelper.clickShareAndRepost(worker);
                    if (shared) stats.shares++;
                    await worker.sleep(500);
                }

                stats.actions++;

                // Log every 10 actions
                if (stats.actions % 10 === 0) {
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    const remaining = Math.round((endTime - Date.now()) / 1000);
                    console.log(`[${worker.deviceId}] 📊 ${elapsed}s/${duration}s (${remaining}s left) | Scrolls:${stats.scrolls} Likes:${stats.likes} Comments:${stats.comments} Shares:${stats.shares}`);
                }
            }

            await UIHelper.closeTikTok(worker);
            console.log(`[${worker.deviceId}] ✅ Warmup done! ${stats.actions} actions, ${stats.likes} likes, ${stats.scrolls} scrolls`);

            return stats;
        } catch (error) {
            console.error(`[${worker.deviceId}] ❌ Warmup failed:`, error.message);
            try { await UIHelper.closeTikTok(worker); } catch (e) { }
            throw error;
        }
    }
}

module.exports = WarmupTask;
