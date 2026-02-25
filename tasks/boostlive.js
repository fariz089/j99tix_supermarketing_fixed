const UIHelper = require('./UIHelper');

class BoostLiveTask {

    static async execute(worker, config) {
        const {
            liveUrl, username,
            duration = 1800,
            idleDelayMin = 0, idleDelayMax = 0,
            jobId,
            deviceIndex = 0,
            joinDelay = 0,
            likeEnabled = true, commentEnabled = true, shareEnabled = true,
            likeInterval = 5,      // double tap setiap X detik
            commentDelay = 30,     // comment setiap X detik
        } = config;

        const startTime = Date.now();
        const endTime = startTime + (duration * 1000);
        const db = worker.db;
        const W = worker.screenWidth;
        const H = worker.screenHeight;

        let stats = { likes: 0, comments: 0, commentsFailed: 0, shares: 0 };
        let shareDone = false;
        let lastCommentTime = 0;
        let lastLikeTime = 0;

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
            console.log(`[${worker.deviceId}]    Like: ${likeEnabled ? 'ON' : 'OFF'} (tiap ${likeInterval}s), Comment: ${commentEnabled ? 'ON' : 'OFF'} (tiap ${commentDelay}s), Share: ${shareEnabled ? '1x' : 'OFF'}`);

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

            // Check captcha after opening (common trigger point)
            await worker.sleep(2000);
            await this._detectAndHandleCaptchaLive(worker);

            console.log(`[${worker.deviceId}] ✅ Live opened - watching for ${duration}s`);

            // ============================================================
            // MAIN LOOP
            // Like: double tap setiap likeInterval detik
            // Comment: setiap commentDelay detik (sequential cycle dari DB)
            // Share: 1x saja
            // Captcha: periodic check setiap ~30 detik + setelah comment
            // Loop sleep = 1 detik (granular timing)
            // ============================================================
            let loopCount = 0;
            let lastCaptchaCheckTime = 0;
            const CAPTCHA_CHECK_INTERVAL = 30; // check captcha setiap 30 detik

            while (Date.now() < endTime) {
                if (await checkCancelled()) throw new Error('Job cancelled by user');
                if (worker.status === 'paused') { await worker.waitForResume(); continue; }

                const now = Date.now();

                // ---- PERIODIC CAPTCHA CHECK ----
                // Di live, captcha bisa muncul kapan saja (tidak seperti masscomment yang predictable).
                // Check setiap CAPTCHA_CHECK_INTERVAL detik supaya tidak terlalu sering (dumpUI lambat).
                const timeSinceLastCaptchaCheck = (now - lastCaptchaCheckTime) / 1000;
                if (lastCaptchaCheckTime === 0 || timeSinceLastCaptchaCheck >= CAPTCHA_CHECK_INTERVAL) {
                    const captchaBlocking = await this._detectAndHandleCaptchaLive(worker);
                    lastCaptchaCheckTime = Date.now();
                    if (captchaBlocking) {
                        // Captcha terdetect tapi tidak bisa di-dismiss, skip actions dulu
                        // Tunggu 30 detik lagi sebelum retry
                        console.log(`[${worker.deviceId}] ⏳ Captcha blocking, waiting before retry...`);
                        await worker.sleep(10000);
                        continue;
                    }
                }

                // ============================================================
                // PRIORITY SYSTEM:
                // Comment punya priority TERTINGGI. Kalau comment waktunya sudah
                // tiba, SEMUA action lain (like, share) di-SKIP di iteration ini.
                // 
                // Kenapa? Karena proses comment itu multi-step:
                //   klik input → type text → klik send
                // Kalau double tap like jalan SEBELUM comment, tap di center
                // layar bisa membuat input field/keyboard hilang (lihat screenshot).
                // Ini menyebabkan text tidak terkirim.
                //
                // Flow:
                //   1. Cek apakah comment waktunya sudah tiba → set flag
                //   2. Kalau flag ON → jalankan HANYA comment, skip like & share
                //   3. Kalau flag OFF → jalankan like & share seperti biasa
                // ============================================================

                let commentIsDue = false;
                if (commentEnabled) {
                    const timeSinceLastComment = (now - lastCommentTime) / 1000;
                    if (lastCommentTime === 0 || timeSinceLastComment >= commentDelay) {
                        commentIsDue = true;
                    }
                }

                if (commentIsDue) {
                    // ---- COMMENT HAS PRIORITY — skip all other actions ----
                    const commentResult = db.tryGetComment ?
                        db.tryGetComment(jobId, worker.deviceId, deviceIndex, commentDelay) :
                        { status: 'ok', comment: db.getAndUseComment ? db.getAndUseComment(jobId, worker.deviceId) : null };

                    if (commentResult.status === 'ok' && commentResult.comment) {
                        console.log(`[${worker.deviceId}] 💬 [PRIORITY] Commenting: "${commentResult.comment}" (like & share paused)`);

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
                        // Reset like timer supaya like tidak langsung jalan di next iteration
                        // (beri jeda 2 detik setelah comment selesai)
                        lastLikeTime = Date.now() - ((likeInterval - 2) * 1000);

                        // Check captcha after comment (comment sering trigger captcha)
                        const captchaAfterComment = await this._detectAndHandleCaptchaLive(worker);
                        lastCaptchaCheckTime = Date.now();
                        if (captchaAfterComment) {
                            console.log(`[${worker.deviceId}] ⏳ Captcha after comment, pausing actions...`);
                            await worker.sleep(10000);
                            continue;
                        }
                    } else {
                        // waiting_delay, already_commented, no_comments → 
                        // Comment tidak jadi, lanjut like & share di bawah
                        commentIsDue = false;
                    }
                }

                // ---- DOUBLE TAP LIKE — HANYA kalau comment TIDAK sedang proses ----
                if (!commentIsDue && likeEnabled) {
                    const timeSinceLastLike = (now - lastLikeTime) / 1000;
                    if (lastLikeTime === 0 || timeSinceLastLike >= likeInterval) {
                        await UIHelper.doubleTapLikeCenter(worker);
                        stats.likes++;
                        lastLikeTime = Date.now();
                    }
                }

                // ---- SHARE (1x only) — HANYA kalau comment TIDAK sedang proses ----
                if (!commentIsDue && shareEnabled && !shareDone) {
                    console.log(`[${worker.deviceId}] 🔄 Sharing...`);
                    const shared = await UIHelper.clickShareAndRepost(worker);
                    if (shared) {
                        stats.shares++;
                        console.log(`[${worker.deviceId}] ✅ Shared`);
                    }
                    shareDone = true;
                }

                // ---- LOG every 30 loops (~30s) ----
                loopCount++;
                if (loopCount % 30 === 0) {
                    const elapsed = Math.floor((now - startTime) / 1000);
                    const rem = Math.max(0, Math.floor((endTime - now) / 1000));
                    console.log(`[${worker.deviceId}] 📊 ${elapsed}s/${duration}s (${rem}s left) | L:${stats.likes} C:${stats.comments} S:${stats.shares}`);
                }

                // Sleep 1 second (granular loop for accurate timing)
                await worker.sleep(1000);
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
     * Detect captcha in LIVE stream context.
     * 
     * Problem: dumpUI() sering gagal di live karena video terus jalan (SurfaceView blocks UIAutomator).
     * Solution: Pakai 2 metode detection:
     *   1. Quick check via `dumpsys window` — cek apakah ada captcha dialog/overlay window
     *   2. Fallback ke dumpUI() — tapi di live, ini sering timeout
     * 
     * Returns true jika captcha blocking dan TIDAK bisa di-dismiss.
     */
    static async _detectAndHandleCaptchaLive(worker) {
        try {
            // Method 1: Quick window check (fast, works even during live playback)
            // Captcha di TikTok biasanya muncul sebagai dialog/overlay window
            let captchaDetected = false;
            try {
                const windowInfo = await worker.execAdb('shell "dumpsys window windows 2>/dev/null | grep -i -E \'captcha|verify|puzzle|webview.*tiktok\' || true"');
                if (windowInfo && windowInfo.trim().length > 0) {
                    console.log(`[${worker.deviceId}] 🛡️ Captcha detected via window check`);
                    captchaDetected = true;
                }
            } catch (e) { }

            // Method 2: Activity check — captcha sering buka activity baru atau WebView
            if (!captchaDetected) {
                try {
                    const focusedWindow = await worker.execAdb('shell "dumpsys window 2>/dev/null | grep mCurrentFocus || true"');
                    // Kalau focus bukan di TikTok main activity, mungkin captcha overlay
                    if (focusedWindow && (
                        focusedWindow.toLowerCase().includes('captcha') ||
                        focusedWindow.toLowerCase().includes('verify') ||
                        focusedWindow.toLowerCase().includes('webview')
                    )) {
                        console.log(`[${worker.deviceId}] 🛡️ Captcha detected via focus check`);
                        captchaDetected = true;
                    }
                } catch (e) { }
            }

            // Method 3: UI dump fallback (slower, may timeout on live but worth trying)
            if (!captchaDetected) {
                try {
                    const { detected } = await UIHelper.detectCaptcha(worker);
                    if (detected) {
                        captchaDetected = true;
                    }
                } catch (e) { }
            }

            if (!captchaDetected) return false;

            // Captcha detected — try to dismiss
            console.log(`[${worker.deviceId}] 🛡️ Captcha detected in live! Attempting dismiss...`);
            return await this._handleCaptchaLive(worker);

        } catch (e) {
            return false;
        }
    }

    /**
     * Handle/dismiss captcha during LIVE stream.
     * Returns true if captcha is STILL blocking (failed to dismiss).
     * Returns false if captcha is gone (dismissed or was false positive).
     */
    static async _handleCaptchaLive(worker) {
        const W = worker.screenWidth;
        const H = worker.screenHeight;

        for (let attempt = 1; attempt <= 3; attempt++) {
            console.log(`[${worker.deviceId}] 🛡️ Dismiss attempt ${attempt}/3...`);

            // Try UI dump to find close button
            const xml = await UIHelper.dumpUI(worker);
            if (xml) {
                // Cek dulu apakah masih ada captcha text
                const captchaPatterns = [/Verify to continue/i, /Drag the puzzle/i, /Slide to verify/i,
                    /Verifikasi untuk melanjutkan/i, /Geser potongan puzzle/i, /captcha/i, /验证/];
                let stillHasCaptcha = false;
                for (const p of captchaPatterns) {
                    if (p.test(xml)) { stillHasCaptcha = true; break; }
                }
                if (!stillHasCaptcha) {
                    console.log(`[${worker.deviceId}] ✅ Captcha gone (false positive or already dismissed)`);
                    return false;
                }

                // Try close/X button
                for (const desc of ['Close', '×', 'close', 'Tutup', 'Refresh']) {
                    const r = UIHelper.findByContentDesc(xml, desc);
                    if (r.success && r.y < H * 0.7) {
                        console.log(`[${worker.deviceId}] 👆 Tapping "${desc}" at ${r.x},${r.y}`);
                        await worker.execAdb(`shell input tap ${r.x} ${r.y}`);
                        await worker.sleep(2000);
                        break;
                    }
                }

                // Also try text-based close button
                for (const text of ['Close', 'Tutup', 'Refresh', 'Report a problem']) {
                    const r = UIHelper.findByText(xml, text);
                    if (r.success) {
                        console.log(`[${worker.deviceId}] 👆 Tapping text "${text}" at ${r.x},${r.y}`);
                        await worker.execAdb(`shell input tap ${r.x} ${r.y}`);
                        await worker.sleep(2000);
                        break;
                    }
                }
            }

            // Back button as fallback
            await UIHelper.goBack(worker);
            await worker.sleep(2000);

            // Verify if captcha is gone
            const { detected } = await UIHelper.detectCaptcha(worker);
            if (!detected) {
                // Double-check with window method
                try {
                    const windowInfo = await worker.execAdb('shell "dumpsys window windows 2>/dev/null | grep -i -E \'captcha|verify|puzzle\' || true"');
                    if (!windowInfo || windowInfo.trim().length === 0) {
                        console.log(`[${worker.deviceId}] ✅ Captcha dismissed!`);
                        return false;
                    }
                } catch (e) {
                    console.log(`[${worker.deviceId}] ✅ Captcha likely dismissed`);
                    return false;
                }
            }

            await worker.sleep(3000);
        }

        console.log(`[${worker.deviceId}] ⚠️ Captcha persists after 3 attempts, will retry later`);
        return true; // Still blocking
    }
}

module.exports = BoostLiveTask;