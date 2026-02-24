const UIHelper = require('./UIHelper');

class MassCommentTask {

    static async execute(worker, config) {
        const {
            url, comment,
            idleDelayMin = 2, idleDelayMax = 5,
            scrollCount = 5, scrollDelayMin = 2, scrollDelayMax = 5,
            deviceStartDelay = 0, deviceIndex = 0,
            jobId, useUIAutomator = true
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
                console.log(`[${worker.deviceId}] ⏱️ Stagger delay: ${deviceStartDelay}s (Device #${deviceIndex + 1})`);
                await worker.sleep(deviceStartDelay * 1000);
            }

            // Check cancelled
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

            if (jobId && db) {
                const job = db.getJob(jobId);
                if (job && job.status === 'cancelled') throw new Error('Job cancelled by user');
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
                    const delay = worker.randomInt(scrollDelayMin, scrollDelayMax);
                    await worker.sleep(delay * 1000);
                }
            }

            // Open target URL
            console.log(`[${worker.deviceId}] 🔗 Opening URL: ${url}`);
            await UIHelper.openUrl(worker, url);
            
            // Wait for page to load - check if UI has TikTok elements
            // Optimized: check FIRST then sleep, wider pattern matching
            console.log(`[${worker.deviceId}] ⏳ Waiting for page load...`);
            let pageReady = false;
            for (let wait = 0; wait < 6; wait++) {
                // First iteration: minimal wait (URL intent already had 1.5s sleep)
                // Subsequent: increasing wait
                if (wait > 0) await worker.sleep(wait < 3 ? 2000 : 3000);
                
                try {
                    const xml = await UIHelper.dumpUI(worker);
                    if (!xml) continue;
                    
                    // Check if TikTok video page elements are present
                    // Expanded patterns: EN, ID, numeric content-desc on right-side icons
                    if (
                        /content-desc="[^"]*comment/i.test(xml) ||
                        /content-desc="[^"]*like/i.test(xml) ||
                        /content-desc="[^"]*share/i.test(xml) ||
                        /content-desc="[^"]*komentar/i.test(xml) ||
                        /content-desc="[^"]*Suka/i.test(xml) ||
                        /content-desc="[^"]*Bagikan/i.test(xml) ||
                        /musically/i.test(xml) ||
                        /ugc\.trill/i.test(xml) ||
                        // OPPO/Realme: right-side icons have numeric content-desc
                        /com\.zhiliaoapp\.musically:id\/\w*comment/i.test(xml) ||
                        /com\.ss\.android\.ugc\.trill:id\/\w*comment/i.test(xml)
                    ) {
                        pageReady = true;
                        console.log(`[${worker.deviceId}] ✅ Page loaded (${wait === 0 ? '<2' : (wait < 3 ? wait * 2 : wait * 3)}s)`);
                        break;
                    }
                    
                    // Samsung sometimes shows "Open with" dialog - dismiss it
                    if (/android:id\/resolver_list|android:id\/button_once|android:id\/button_always/i.test(xml)) {
                        console.log(`[${worker.deviceId}] ⚠️ "Open with" dialog detected, tapping TikTok/Always...`);
                        const alwaysBtn = UIHelper.findByResourceId(xml, 'android:id/button_always');
                        if (alwaysBtn.success) {
                            await worker.execAdb(`shell input tap ${alwaysBtn.x} ${alwaysBtn.y}`);
                            await worker.sleep(2000);
                            continue;
                        }
                        const onceBtn = UIHelper.findByResourceId(xml, 'android:id/button_once');
                        if (onceBtn.success) {
                            await worker.execAdb(`shell input tap ${onceBtn.x} ${onceBtn.y}`);
                            await worker.sleep(2000);
                            continue;
                        }
                        const ttText = UIHelper.findByText(xml, 'TikTok');
                        if (ttText.success) {
                            await worker.execAdb(`shell input tap ${ttText.x} ${ttText.y}`);
                            await worker.sleep(1000);
                            const xml2 = await UIHelper.dumpUI(worker);
                            if (xml2) {
                                const btn = UIHelper.findByResourceId(xml2, 'android:id/button_always') 
                                         || UIHelper.findByResourceId(xml2, 'android:id/button_once');
                                if (btn && btn.success) {
                                    await worker.execAdb(`shell input tap ${btn.x} ${btn.y}`);
                                }
                            }
                            await worker.sleep(2000);
                            continue;
                        }
                    }
                } catch (e) { }
            }
            if (!pageReady) {
                console.log(`[${worker.deviceId}] ⚠️ Page may not be fully loaded, continuing anyway...`);
            }

            // Check for captcha after page load
            const captchaCleared1 = await UIHelper.checkAndDismissCaptcha(worker, 'after page load');
            if (!captchaCleared1) {
                throw new Error('Captcha detected after page load and could not be dismissed');
            }

            // Click comment icon
            console.log(`[${worker.deviceId}] 💬 Finding comment button...`);
            await UIHelper.clickCommentButton(worker);

            // Check for captcha after opening comments
            // Optimized: 1 quick check, only poll again if comment panel seems off
            console.log(`[${worker.deviceId}] 🛡️ Checking for captcha after comment click...`);
            await worker.sleep(1500);
            let captchaFound = false;
            const { detected: captchaDetected1 } = await UIHelper.detectCaptcha(worker);
            if (captchaDetected1) {
                captchaFound = true;
            } else {
                // One more quick check - captcha WebView can be slow to render
                await worker.sleep(1000);
                const { detected: captchaDetected2 } = await UIHelper.detectCaptcha(worker);
                if (captchaDetected2) captchaFound = true;
            }

            if (captchaFound) {
                console.log(`[${worker.deviceId}] [after comment open] 🛡️ Captcha detected! Attempting to dismiss...`);
                const result = await UIHelper.dismissCaptcha(worker);
                if (result.dismissed) {
                    console.log(`[${worker.deviceId}] [after comment open] ✅ Captcha cleared (${result.method})`);
                    // Comment panel stays open after captcha dismiss (back button only closes captcha dialog)
                    await worker.sleep(1500);
                } else {
                    throw new Error('Captcha detected after opening comments and could not be dismissed');
                }
            }

            // Click comment input field
            console.log(`[${worker.deviceId}] ⌨️ Finding input field...`);
            const inputFound = await UIHelper.clickCommentInput(worker);

            // If input not found, captcha may have appeared (late render)
            if (!inputFound) {
                const { detected } = await UIHelper.detectCaptcha(worker);
                if (detected) {
                    console.log(`[${worker.deviceId}] [input search] 🛡️ Captcha detected (late)! Attempting to dismiss...`);
                    const result = await UIHelper.dismissCaptcha(worker);
                    if (result.dismissed) {
                        console.log(`[${worker.deviceId}] [input search] ✅ Captcha cleared (${result.method})`);
                        // Comment panel still open, just retry finding input
                        await worker.sleep(1500);
                        console.log(`[${worker.deviceId}] ⌨️ Retrying input field...`);
                        await UIHelper.clickCommentInput(worker);
                    } else {
                        throw new Error('Captcha detected during input search and could not be dismissed');
                    }
                }
            }
            await worker.sleep(2000);

            if (worker.status === 'paused') await worker.waitForResume();

            // Type comment
            console.log(`[${worker.deviceId}] 📝 Typing: "${comment}"`);
            const typed = await UIHelper.typeWithADBKeyboard(worker, comment);
            if (!typed) throw new Error('Failed to type comment');
            
            // IMPORTANT: Minimal delay between typing and send!
            // ADB Keyboard closes quickly after broadcast, changing send button position.
            // The shorter this delay, the more likely we catch the keyboard-open state.
            await worker.sleep(800);

            // Click send
            if (worker.status === 'paused') await worker.waitForResume();
            console.log(`[${worker.deviceId}] 📤 Sending...`);

            await UIHelper.clickSendButton(worker);
            
            // Wait for comment to actually post before closing
            await worker.sleep(3000);

            // Check for captcha after sending (TikTok sometimes shows captcha after posting)
            const captchaCleared3 = await UIHelper.checkAndDismissCaptcha(worker, 'after send');
            if (!captchaCleared3) {
                console.log(`[${worker.deviceId}] ⚠️ Captcha after send - comment may not have been posted`);
            }

            console.log(`[${worker.deviceId}] ✅ Comment sent!`);

            // Cleanup
            await UIHelper.closeTikTok(worker);
            await UIHelper.goHome(worker);

            console.log(`[${worker.deviceId}] ✅ Task completed!`);
            return {
                success: true,
                comment: comment,
                scrollCount: actualScrolls
            };

        } catch (error) {
            console.error(`[${worker.deviceId}] ❌ Failed: ${error.message}`);
            try {
                await UIHelper.closeTikTok(worker);
                await UIHelper.goHome(worker);
            } catch (e) { }
            throw error;
        }
    }
}

module.exports = MassCommentTask;