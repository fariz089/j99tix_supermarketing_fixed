const UIHelper = require('./UIHelper');

class MassCommentTask {

    static async execute(worker, config) {
        const {
            url, comment,
            idleDelayMin = 2, idleDelayMax = 5,
            scrollCount = 5, scrollDelayMin = 2, scrollDelayMax = 5,
            deviceStartDelay = 0, deviceIndex = 0,
            jobId
        } = config;

        const db = worker.db;

        console.log(`[${worker.deviceId}] ========================================`);
        console.log(`[${worker.deviceId}] 💬 Mass Comment | screen ${worker.screenWidth}x${worker.screenHeight}`);
        console.log(`[${worker.deviceId}]    URL: ${url}`);
        console.log(`[${worker.deviceId}]    Comment: "${comment}"`);
        console.log(`[${worker.deviceId}] ========================================`);

        try {
            // Stagger delay
            if (deviceStartDelay > 0) {
                console.log(`[${worker.deviceId}] ⏱️ Stagger delay: ${deviceStartDelay}s`);
                await worker.sleep(deviceStartDelay * 1000);
            }

            if (jobId && db) {
                const job = db.getJob(jobId);
                if (job && job.status === 'cancelled') throw new Error('Job cancelled by user');
            }

            // Random idle delay
            const randomDelay = worker.randomInt(idleDelayMin, idleDelayMax);
            if (randomDelay > 0) {
                console.log(`[${worker.deviceId}] ⏱️ Idle delay: ${randomDelay}s`);
                await worker.sleep(randomDelay * 1000);
            }

            // Open TikTok
            console.log(`[${worker.deviceId}] 📱 Opening TikTok...`);
            await UIHelper.openTikTok(worker);

            // FYP scroll
            const actualScrolls = worker.randomInt(0, scrollCount);
            if (actualScrolls > 0) {
                console.log(`[${worker.deviceId}] 📜 Scrolling FYP ${actualScrolls}x...`);
                for (let i = 0; i < actualScrolls; i++) {
                    if (worker.status === 'paused') await worker.waitForResume();
                    await UIHelper.swipeFYP(worker);
                    await worker.sleep(worker.randomInt(scrollDelayMin, scrollDelayMax) * 1000);
                }
            }

            // Open target URL + wait for load
            console.log(`[${worker.deviceId}] 🔗 Opening URL: ${url}`);
            await UIHelper.openUrl(worker, url);
            const loadWait = worker.randomInt(4, 6);
            console.log(`[${worker.deviceId}] ⏳ Waiting ${loadWait}s for page load...`);
            await worker.sleep(loadWait * 1000);

            // Click comment (pauses video → dumps UI → taps icon #2)
            console.log(`[${worker.deviceId}] 💬 Finding comment button...`);
            await UIHelper.clickCommentButton(worker);
            await worker.sleep(2000);

            // Captcha check (dump works now — comment panel open)
            const { detected } = await UIHelper.detectCaptcha(worker);
            if (detected) {
                const result = await UIHelper.dismissCaptcha(worker);
                if (!result.dismissed) throw new Error('Captcha could not be dismissed');
                await worker.sleep(1500);
            }

            // Click comment input
            console.log(`[${worker.deviceId}] ⌨️ Finding input field...`);
            await UIHelper.clickCommentInput(worker);
            await worker.sleep(2000);

            if (worker.status === 'paused') await worker.waitForResume();

            // Type comment
            console.log(`[${worker.deviceId}] 📝 Typing: "${comment}"`);
            const typed = await UIHelper.typeWithADBKeyboard(worker, comment);
            if (!typed) throw new Error('Failed to type comment');
            await worker.sleep(800);

            // Send
            if (worker.status === 'paused') await worker.waitForResume();
            console.log(`[${worker.deviceId}] 📤 Sending...`);
            await UIHelper.clickSendButton(worker);
            await worker.sleep(3000);

            // Post-send captcha check
            const captchaOk = await UIHelper.checkAndDismissCaptcha(worker, 'after send');
            if (!captchaOk) {
                console.log(`[${worker.deviceId}] ⚠️ Captcha after send`);
            }

            console.log(`[${worker.deviceId}] ✅ Comment sent!`);

            // Cleanup
            await UIHelper.closeTikTok(worker);
            await UIHelper.goHome(worker);
            console.log(`[${worker.deviceId}] ✅ Task completed!`);

            return { success: true, comment, scrollCount: actualScrolls };
        } catch (error) {
            console.error(`[${worker.deviceId}] ❌ Failed: ${error.message}`);
            try { await UIHelper.closeTikTok(worker); await UIHelper.goHome(worker); } catch (e) {}
            throw error;
        }
    }
}

module.exports = MassCommentTask;