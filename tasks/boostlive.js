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
            // ============================================================
            // PRE-EMPTIVE ANTI-DETECTION (anti-captcha pattern)
            // Nilai 0 = disabled (behavior lama). Default sudah aktif ringan.
            // ============================================================
            commentJitter = 0.25,         // ±25% variasi commentDelay (e.g., 30s → random 22-37s)
            likeJitter = 0.4,             // ±40% variasi likeInterval (e.g., 5s → random 3-7s)
            commentStaggerSeconds = 3,    // offset awal antar device (deviceIndex × X detik)
        } = config;

        const startTime = Date.now();
        const endTime = startTime + (duration * 1000);
        const db = worker.db;
        const W = worker.screenWidth;
        const H = worker.screenHeight;

        // Helper: hitung interval dengan jitter
        // jitter 0.25 berarti hasil = base × random(0.75 .. 1.25)
        const withJitter = (base, jitter) => {
            if (!jitter || jitter <= 0) return base;
            const min = base * (1 - jitter);
            const max = base * (1 + jitter);
            return min + Math.random() * (max - min);
        };

        // Stagger awal: offset comment time per device supaya tidak nembak bareng
        // Device #0 = 0s offset, Device #1 = 3s offset, Device #2 = 6s offset, dst
        // Setelah staggerSeconds × N detik, kembali ke 0 supaya tidak menumpuk di belakang
        const STAGGER_CYCLE = 30; // wrap setiap 30 device biar tidak terlalu jauh
        const initialCommentStagger = (commentStaggerSeconds > 0)
            ? (deviceIndex % STAGGER_CYCLE) * commentStaggerSeconds * 1000
            : 0;

        let stats = { likes: 0, comments: 0, commentsFailed: 0, shares: 0 };
        let shareDone = false;
        let lastCommentTime = 0;
        let lastLikeTime = 0;

        // Dynamic interval — di-randomize ulang setiap kali action selesai
        // supaya pattern tidak predictable (bot detection countermeasure)
        let nextCommentInterval = withJitter(commentDelay, commentJitter);
        let nextLikeInterval = withJitter(likeInterval, likeJitter);

        // Rejoin tracking — supaya tidak infinite loop kalau live sudah ended
        // atau ada masalah permanen lain
        let rejoinAttempts = 0;
        let rejoinSuccesses = 0;
        let lastRejoinAttempt = 0;
        let consecutiveRejoinFailures = 0;
        const REJOIN_COOLDOWN_MS = 15000;  // minimum 15s antara rejoin attempts (V3: turun dari 30s, krn detection lebih akurat)
        const MAX_CONSECUTIVE_FAILURES = 4; // setelah 4 fail berturut, anggap live ended → exit task (V3: turun dari 5)

        // FIX: Use in-memory cancel check instead of DB query every second.
        // Before: 20 devices × 1 query/sec = 20 synchronous DB queries/sec just for cancel checks.
        // After: O(1) memory lookup, zero DB load.
        let lastDbCancelCheck = 0;
        const DB_CANCEL_CHECK_INTERVAL = 10000; // fallback DB check every 10s

        const checkCancelled = async () => {
            if (!jobId) return false;
            
            // Fast path: in-memory check (no DB query)
            if (worker.isJobCancelled(jobId)) {
                await UIHelper.closeTikTok(worker);
                await UIHelper.goHome(worker);
                return true;
            }
            
            // Slow fallback: only check DB every 10 seconds (if fast check unavailable)
            const now = Date.now();
            if (!worker.isJobCancelledFn && db && (now - lastDbCancelCheck > DB_CANCEL_CHECK_INTERVAL)) {
                lastDbCancelCheck = now;
                const job = await db.getJob(jobId);
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
            console.log(`[${worker.deviceId}]    Like: ${likeEnabled ? `ON (${likeInterval}s ±${Math.round(likeJitter * 100)}%)` : 'OFF'}, Comment: ${commentEnabled ? `ON (${commentDelay}s ±${Math.round(commentJitter * 100)}%)` : 'OFF'}, Share: ${shareEnabled ? '1x' : 'OFF'}`);
            if (commentStaggerSeconds > 0 && deviceIndex > 0) {
                const offsetSec = Math.round(initialCommentStagger / 1000);
                console.log(`[${worker.deviceId}]    🔀 Anti-detect: comment stagger offset = ${offsetSec}s (device #${deviceIndex + 1})`);
            }

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

            // Simpan info live ke worker supaya helper captcha bisa re-join
            // kalau dismiss captcha membuat TikTok keluar dari live
            worker._liveContext = {
                liveUrl: liveUrl || null,
                username: username || null,
            };

            // Check captcha after opening (common trigger point)
            await worker.sleep(2000);
            await this._detectAndHandleCaptchaLive(worker);

            console.log(`[${worker.deviceId}] ✅ Live opened - watching for ${duration}s`);

            // ============================================================
            // APPLY INITIAL COMMENT STAGGER
            // Geser "lastCommentTime" ke depan/belakang supaya device tidak
            // pertama kali comment di waktu yang sama persis.
            //
            // Cara kerja: anggap "baru saja comment" sebanyak X detik yang lalu.
            // Hasilnya: comment pertama akan tertunda sebesar (commentDelay - X).
            //
            // Contoh dengan commentDelay=30s, stagger=3s:
            //   Device #0: lastCommentTime = now - 30s → comment pertama: ~0s lagi
            //   Device #1: lastCommentTime = now - 27s → comment pertama: ~3s lagi
            //   Device #2: lastCommentTime = now - 24s → comment pertama: ~6s lagi
            //   ... dst
            // ============================================================
            if (initialCommentStagger > 0 && commentEnabled) {
                lastCommentTime = Date.now() - (commentDelay * 1000) + initialCommentStagger;
            }

            // ============================================================
            // MAIN LOOP
            // Like: double tap setiap likeInterval detik (±jitter)
            // Comment: setiap commentDelay detik (±jitter, dengan stagger awal)
            // Share: 1x saja
            // Captcha: periodic check + after-comment + health check
            // Loop sleep = 1 detik (granular timing)
            // ============================================================
            let loopCount = 0;
            let lastCaptchaCheckTime = 0;
            let lastLiveHealthCheckTime = 0;
            let consecutiveOutsideLive = 0;     // counter berapa kali berturut-turut detect "keluar live"
            const CAPTCHA_CHECK_INTERVAL = 12;  // check captcha setiap 12s (sebelumnya 30s, terlalu lambat — TikTok kick ~15-20s)
            const LIVE_HEALTH_CHECK_INTERVAL = 8; // check "masih di live?" setiap 8s, INDEPENDEN dari captcha

            while (Date.now() < endTime) {
                if (await checkCancelled()) throw new Error('Job cancelled by user');
                if (worker.status === 'paused') { await worker.waitForResume(); continue; }

                const now = Date.now();

                // ---- LIVE HEALTH CHECK (independen dari captcha) ----
                // Cek setiap 8 detik: "apakah aku masih di live?"
                // Kalau sudah keluar (kick, error, redirect), langsung rejoin TANPA tunggu
                // captcha cycle. Ini menangani case: captcha tidak terdeteksi tapi
                // device sudah di-kick oleh TikTok.
                const timeSinceLastHealth = (now - lastLiveHealthCheckTime) / 1000;
                if (lastLiveHealthCheckTime === 0 || timeSinceLastHealth >= LIVE_HEALTH_CHECK_INTERVAL) {
                    lastLiveHealthCheckTime = Date.now();
                    try {
                        const stillInLive = await this._isStillInLive(worker);
                        if (!stillInLive) {
                            consecutiveOutsideLive++;
                            console.log(`[${worker.deviceId}] ⚠️ Health check: NOT in live (${consecutiveOutsideLive}x). Force re-join...`);

                            // Confirm 2x in a row sebelum force rejoin (hindari false positive saat transisi)
                            if (consecutiveOutsideLive >= 2) {
                                // Cek cooldown — jangan rejoin terlalu sering (boros resource & ADB)
                                const sinceLastRejoin = now - lastRejoinAttempt;
                                if (lastRejoinAttempt > 0 && sinceLastRejoin < REJOIN_COOLDOWN_MS) {
                                    const waitSec = Math.ceil((REJOIN_COOLDOWN_MS - sinceLastRejoin) / 1000);
                                    console.log(`[${worker.deviceId}] ⏸️ Rejoin cooldown ${waitSec}s remaining, skip`);
                                    consecutiveOutsideLive = 0;
                                    await worker.sleep(5000);
                                    continue;
                                }

                                // Cek dulu apakah karena captcha (kalau iya, biarkan captcha handler yang urus)
                                let captchaPresent = false;
                                try {
                                    const w = await worker.execAdb('shell "dumpsys window windows 2>/dev/null | grep -i -E \'captcha|verify|puzzle\' || true"');
                                    if (w && w.trim().length > 0) captchaPresent = true;
                                } catch (e) { }

                                if (captchaPresent) {
                                    console.log(`[${worker.deviceId}] 🛡️ Captcha hadir saat health check, forward ke captcha handler`);
                                    await this._detectAndHandleCaptchaLive(worker);
                                    lastCaptchaCheckTime = Date.now();
                                } else {
                                    // Force rejoin agresif (V2 multi-tier)
                                    rejoinAttempts++;
                                    lastRejoinAttempt = Date.now();
                                    const result = await this._forceRejoinLive(worker);

                                    if (result.success) {
                                        rejoinSuccesses++;
                                        consecutiveRejoinFailures = 0;
                                        console.log(`[${worker.deviceId}] ✅ Rejoin sukses (total: ${rejoinSuccesses}/${rejoinAttempts})`);
                                    } else {
                                        consecutiveRejoinFailures++;
                                        console.log(`[${worker.deviceId}] ❌ Rejoin gagal — reason: ${result.reason} (consecutive failures: ${consecutiveRejoinFailures})`);

                                        // Live ended → langsung exit task, tidak perlu loop
                                        if (result.reason === 'live_ended') {
                                            console.log(`[${worker.deviceId}] 🏁 LIVE ENDED — exiting task (host stop streaming)`);
                                            break; // exit main while loop
                                        }

                                        // Terlalu banyak gagal berturut → assume permanent issue
                                        if (consecutiveRejoinFailures >= MAX_CONSECUTIVE_FAILURES) {
                                            console.log(`[${worker.deviceId}] 💀 ${consecutiveRejoinFailures} consecutive rejoin failures — exiting task`);
                                            break; // exit main while loop
                                        }

                                        // Wait lebih lama setelah gagal (exponential-ish backoff)
                                        const backoff = Math.min(60000, 10000 * consecutiveRejoinFailures);
                                        console.log(`[${worker.deviceId}] ⏳ Backoff ${backoff / 1000}s before next attempt`);
                                        await worker.sleep(backoff);
                                    }
                                }
                                consecutiveOutsideLive = 0;
                                continue; // skip iteration ini, mulai bersih
                            }
                        } else {
                            consecutiveOutsideLive = 0; // reset counter
                            consecutiveRejoinFailures = 0; // reset failure counter saat di live
                        }
                    } catch (e) { /* health check error tidak fatal */ }
                }

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
                    // Pakai nextCommentInterval (sudah di-jitter) bukan commentDelay langsung
                    if (lastCommentTime === 0 || timeSinceLastComment >= nextCommentInterval) {
                        commentIsDue = true;
                    }
                }

                if (commentIsDue) {
                    // ---- COMMENT HAS PRIORITY — skip all other actions ----
                    const commentResult = db.tryGetComment ?
                        await db.tryGetComment(jobId, worker.deviceId, deviceIndex, commentDelay) :
                        { status: 'ok', comment: db.getAndUseComment ? await db.getAndUseComment(jobId, worker.deviceId) : null };

                    if (commentResult.status === 'ok' && commentResult.comment) {
                        console.log(`[${worker.deviceId}] 💬 [PRIORITY] Commenting: "${commentResult.comment}" (like & share paused)`);

                        const success = await this._postCommentLive(worker, commentResult.comment);

                        if (success) {
                            stats.comments++;
                            if (db.markDeviceCommented) await db.markDeviceCommented(jobId, worker.deviceId);
                            console.log(`[${worker.deviceId}] ✅ Comment posted`);
                        } else {
                            stats.commentsFailed++;
                            console.log(`[${worker.deviceId}] ❌ Comment failed`);
                        }
                        lastCommentTime = Date.now();
                        // Re-randomize commentInterval untuk next cycle (anti-pattern)
                        nextCommentInterval = withJitter(commentDelay, commentJitter);

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
                    // Pakai nextLikeInterval (sudah di-jitter) bukan likeInterval langsung
                    if (lastLikeTime === 0 || timeSinceLastLike >= nextLikeInterval) {
                        await UIHelper.doubleTapLikeCenter(worker);
                        stats.likes++;
                        lastLikeTime = Date.now();
                        // Re-randomize likeInterval untuk next cycle (anti-pattern)
                        nextLikeInterval = withJitter(likeInterval, likeJitter);
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
            const rejoinSummary = rejoinAttempts > 0
                ? ` | Rejoin: ${rejoinSuccesses}/${rejoinAttempts} success`
                : '';
            console.log(`[${worker.deviceId}] ✅ Done! ${actualDur}s | Likes:${stats.likes} Comments:${stats.comments} Shares:${stats.shares}${rejoinSummary}`);

            return { duration: actualDur, stats: { ...stats, rejoinAttempts, rejoinSuccesses } };
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
            const stillBlocking = await this._handleCaptchaLive(worker);

            // Kalau dismiss berhasil, cek apakah masih di live (dismiss sering
            // membuat TikTok keluar dari live) → kalau keluar, rejoin otomatis
            if (!stillBlocking) {
                await this._rejoinLiveIfNeeded(worker);
            }

            return stillBlocking;

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

    /**
     * Cek apakah TikTok masih di halaman live stream.
     * V3: lebih akurat — prioritas deteksi FYP (negative signature) DULU
     * sebelum positive signature, karena FYP itu state default yang sering
     * di-misclassify sebagai live.
     *
     * Return value:
     *   true  = yakin masih di live
     *   false = yakin sudah keluar dari live (FYP / profile / app lain / dll)
     *
     * PENTING: kalau ambiguous, return FALSE (bukan true seperti V2).
     * Karena false-positive (anggap di live padahal di FYP) bikin task stuck —
     * lebih baik trigger rejoin attempt yang nanti bisa dideteksi sebagai
     * "joined" via verifikasi ulang, daripada diam selamanya di FYP.
     */
    static async _isStillInLive(worker) {
        try {
            // ========== Method 1: focused window/activity ==========
            // Ini paling reliable kalau berhasil dapat info.
            const focusInfo = await worker.execAdb('shell "dumpsys window 2>/dev/null | grep -E \'mCurrentFocus|mFocusedApp\' || true"');
            if (focusInfo) {
                const lower = focusInfo.toLowerCase();

                // Kalau bukan di TikTok sama sekali → pasti keluar
                if (!lower.includes('musically') && !lower.includes('tiktok')) {
                    return false;
                }

                // Kalau focus mengandung activity LIVE → strong signal masih di live
                if (lower.includes('liveroom') ||
                    lower.includes('liveactivity') ||
                    lower.includes('live_room') ||
                    lower.includes('liveplay') ||
                    lower.includes('livesdk') ||
                    lower.includes('webcastsdk')) {
                    return true;
                }

                // Kalau focus mengandung MainActivity / HomeActivity / FYP → strong signal SUDAH KELUAR
                // (TikTok pakai com.ss.android.ugc.aweme.main.MainActivity untuk FYP)
                if (lower.includes('mainactivity') ||
                    lower.includes('homeactivity') ||
                    lower.includes('feedactivity') ||
                    lower.includes('detailactivity') ||
                    lower.includes('profileactivity') ||
                    lower.includes('useractivity')) {
                    return false;
                }
            }

            // ========== Method 2: UI signature dari dumpUI ==========
            const xml = await UIHelper.dumpUI(worker);
            if (!xml) {
                // Dump gagal — TIDAK bisa diasumsikan masih di live.
                // Return false supaya logic di atas trigger rejoin attempt
                // yang akan verify ulang nanti.
                return false;
            }

            // ----- 2a: Negative signatures DULU (FYP / non-live state) -----
            // Cek ini DULU sebelum positive — karena beberapa elemen FYP
            // bisa keliru di-match sebagai live.
            const notLiveSignatures = [
                // Bottom nav: kalau Home / Inbox / Profile / Shop selected, ini FYP/profile
                /content-desc="Home"\s+[^>]*selected="true"/i,
                /content-desc="Beranda"\s+[^>]*selected="true"/i,
                /content-desc="Inbox"\s+[^>]*selected="true"/i,
                /content-desc="Kotak masuk"\s+[^>]*selected="true"/i,
                /content-desc="Profile"\s+[^>]*selected="true"/i,
                /content-desc="Profil"\s+[^>]*selected="true"/i,
                /content-desc="Shop"\s+[^>]*selected="true"/i,
                /content-desc="Toko"\s+[^>]*selected="true"/i,
                // FYP top tabs (For You / Following / Drama / dll yang muncul di FYP)
                /content-desc="For You"\s+[^>]*selected="true"/i,
                /content-desc="Untuk Anda"\s+[^>]*selected="true"/i,
                /text="For You"\s+[^>]*selected="true"/i,
                /text="Untuk Anda"\s+[^>]*selected="true"/i,
                // FYP-specific text patterns
                /Sign up to follow creators/i,
                /Daftar untuk mengikuti/i,
                // Profile page indicators
                /Profile photo/i,
                /Foto profil/i,
                /Edit profile/i,
                /Edit profil/i,
                /Following.*Followers.*Likes/i,
                /Mengikuti.*Pengikut.*Suka/i,
                // Comment / Inbox page
                /content-desc="Activity"\s+[^>]*selected="true"/i,
                /Notifications.*All activity/i,
            ];
            for (const p of notLiveSignatures) {
                if (p.test(xml)) return false;
            }

            // ----- 2b: Positive signatures (live-specific) -----
            const strongLiveSignatures = [
                // Comment input live (placeholder text khas)
                /Say something\.\.\./i,
                /Add a comment\.\.\./i,
                /Tulis komentar\.\.\./i,
                /Katakan sesuatu\.\.\./i,
                /Beri komentar\.\.\./i,
                /Tulis sesuatu\.\.\./i,
                // Live UI element IDs
                /com\.zhiliaoapp\.musically:id\/[^"]*live[^"]*input/i,
                /com\.zhiliaoapp\.musically:id\/[^"]*gift_button/i,
                /com\.zhiliaoapp\.musically:id\/[^"]*live_gift/i,
                /com\.zhiliaoapp\.musically:id\/[^"]*gift_panel/i,
                /com\.zhiliaoapp\.musically:id\/[^"]*viewer/i,
                /com\.zhiliaoapp\.musically:id\/[^"]*audience/i,
                /com\.zhiliaoapp\.musically:id\/[^"]*live_room/i,
                /com\.zhiliaoapp\.musically:id\/[^"]*chat_message/i,
                // Live action buttons
                /content-desc="Send a gift"/i,
                /content-desc="Kirim hadiah"/i,
                /content-desc="Send gift"/i,
            ];
            let strongHits = 0;
            for (const p of strongLiveSignatures) {
                if (p.test(xml)) strongHits++;
            }
            if (strongHits >= 1) return true;

            // ----- 2c: Fallback ambiguous -----
            // Kalau ada "LIVE" + viewer count + tidak ada FYP signature, anggap live
            if (/\bLIVE\b/.test(xml) && /viewer|penonton|watching|menonton/i.test(xml)) {
                // Tapi pastikan bukan LIVE icon di FYP (yang muncul di video FYP biasa)
                // FYP punya pattern "LIVE" tapi disertai komentar count tinggi & no gift button
                if (!/com\.zhiliaoapp\.musically:id\/[^"]*home_tab/i.test(xml)) {
                    return true;
                }
            }

            // Default: tidak ada bukti kuat di live → anggap sudah keluar
            return false;
        } catch (e) {
            // Error saat dump → SAFER untuk return false supaya logic
            // bisa coba rejoin (yang akan verify ulang state setelah openUrl)
            return false;
        }
    }

    /**
     * Force rejoin live stream — V2: Multi-tier strategy untuk case stuck di FYP/loading.
     *
     * Tier 1 (Quick): openUrl saja (kalau state masih bersih)
     * Tier 2 (Hard reset): force-stop → openUrl → multiple URL formats
     * Tier 3 (Nuclear): force-stop → clear app data partial → reopen
     *
     * Returns: { success: bool, reason: string }
     *   reason bisa 'joined', 'live_ended', 'unknown', 'no_context'
     */
    static async _forceRejoinLive(worker) {
        const ctx = worker._liveContext;
        if (!ctx || (!ctx.liveUrl && !ctx.username)) {
            console.log(`[${worker.deviceId}] ⚠️ No live context, skip force rejoin`);
            return { success: false, reason: 'no_context' };
        }

        console.log(`[${worker.deviceId}] 🔄 FORCE REJOIN V3 — multi-tier rejoin starting...`);

        // Helper: deteksi "live ended" pattern di UI XML.
        // Dipakai berulang — supaya kalau host udah stop, kita
        // langsung exit task tanpa buang waktu di Tier 1/2/3.
        const liveEndedPatterns = [
            /Live ended/i,
            /LIVE has ended/i,
            /Siaran langsung berakhir/i,
            /Siaran langsung telah berakhir/i,
            /Siaran langsung sudah berakhir/i,
            /Siaran langsung sudah selesai/i,
            /LIVE telah berakhir/i,
            /LIVE sudah berakhir/i,
            /LIVE sudah selesai/i,
            /Stream has ended/i,
            /Streaming has ended/i,
            /This LIVE has ended/i,
            /User is offline/i,
            /Pengguna sedang offline/i,
            /Pengguna offline/i,
            /not currently live/i,
            /tidak sedang live/i,
            /tidak sedang siaran/i,
            /sedang tidak live/i,
            /Tayangan langsung berakhir/i,
            /Tayangan berakhir/i,
            /Live ini telah berakhir/i,
        ];
        const checkLiveEnded = async () => {
            try {
                const xml = await UIHelper.dumpUI(worker);
                if (!xml) return false;
                for (const p of liveEndedPatterns) {
                    if (p.test(xml)) return true;
                }
                return false;
            } catch (e) { return false; }
        };

        // Build daftar target URL — multiple format untuk increase success rate
        const cleanUser = ctx.username ? ctx.username.replace('@', '') : null;
        const targets = [];
        if (ctx.liveUrl) targets.push(ctx.liveUrl);
        if (cleanUser) {
            targets.push(`https://www.tiktok.com/@${cleanUser}/live`);
            targets.push(`snssdk1233://live?username=${cleanUser}`);
            targets.push(`snssdk1128://user/profile/${cleanUser}`);
        }

        // ============================================================
        // PRE-CHECK: kalau saat ini UI sudah nunjukkan "live ended",
        // langsung return — gak perlu tier 1/2/3
        // ============================================================
        if (await checkLiveEnded()) {
            console.log(`[${worker.deviceId}] 📛 Live ENDED detected (pre-check) — host stop streaming`);
            return { success: false, reason: 'live_ended' };
        }

        // ============================================================
        // TIER 1: Quick rejoin (tanpa close TikTok, tanpa goHome)
        // V3 fix: HAPUS goHome — itu bikin TikTok keluar foreground &
        // sering bikin openUrl berikutnya malah masuk FYP, bukan live.
        // ============================================================
        console.log(`[${worker.deviceId}] 🔹 Tier 1: Quick rejoin (in-app)`);
        try {
            for (let i = 0; i < Math.min(2, targets.length); i++) {
                await UIHelper.openUrl(worker, targets[i]);
                await worker.sleep(3500);

                // Cek live ended dulu — kalau host udah stop, exit cepat
                if (await checkLiveEnded()) {
                    console.log(`[${worker.deviceId}] 📛 Live ENDED detected (Tier 1)`);
                    return { success: false, reason: 'live_ended' };
                }

                if (await this._isStillInLive(worker)) {
                    console.log(`[${worker.deviceId}] ✅ Tier 1 sukses (URL ${i + 1})`);
                    return { success: true, reason: 'joined' };
                }
            }
        } catch (e) { /* lanjut ke tier 2 */ }

        // ============================================================
        // TIER 2: Hard reset (force-stop + reopen)
        // ============================================================
        console.log(`[${worker.deviceId}] 🔹 Tier 2: Hard reset...`);
        try {
            await UIHelper.closeTikTok(worker);
            await worker.sleep(2000); // tunggu lebih lama biar process bener mati

            // Buka HOME dulu (bukan langsung deeplink) — supaya TikTok tidak resume ke last state
            await worker.execAdb('shell input keyevent 3');
            await worker.sleep(500);

            for (let i = 0; i < targets.length; i++) {
                console.log(`[${worker.deviceId}] 🚀 Tier 2 attempt ${i + 1}/${targets.length}: ${targets[i].substring(0, 60)}...`);
                try {
                    await UIHelper.openUrl(worker, targets[i]);
                    await worker.sleep(5000);

                    if (await checkLiveEnded()) {
                        console.log(`[${worker.deviceId}] 📛 Live ENDED detected (Tier 2)`);
                        return { success: false, reason: 'live_ended' };
                    }

                    let ok = await this._isStillInLive(worker);
                    if (!ok) {
                        await worker.sleep(2500);
                        ok = await this._isStillInLive(worker);
                    }

                    if (ok) {
                        console.log(`[${worker.deviceId}] ✅ Tier 2 sukses (URL ${i + 1})`);
                        return { success: true, reason: 'joined' };
                    }
                } catch (e) {
                    console.log(`[${worker.deviceId}] ⚠️ Tier 2 URL ${i + 1} error: ${e.message}`);
                }
            }
        } catch (e) {
            console.log(`[${worker.deviceId}] ⚠️ Tier 2 fatal: ${e.message}`);
        }

        // ============================================================
        // TIER 3: Final live-ended check
        // ============================================================
        console.log(`[${worker.deviceId}] 🔹 Tier 3: Final live-ended check...`);
        if (await checkLiveEnded()) {
            console.log(`[${worker.deviceId}] 📛 Live ENDED detected (Tier 3) — host stop streaming`);
            return { success: false, reason: 'live_ended' };
        }

        console.log(`[${worker.deviceId}] ❌ Force rejoin gagal di semua tier`);
        return { success: false, reason: 'unknown' };
    }

    /**
     * Setelah captcha berhasil di-dismiss, pastikan masih di live stream.
     * Kalau keluar, buka ulang live URL/username.
     */
    static async _rejoinLiveIfNeeded(worker) {
        try {
            const ctx = worker._liveContext;
            if (!ctx || (!ctx.liveUrl && !ctx.username)) return;

            const stillInLive = await this._isStillInLive(worker);
            if (stillInLive) {
                console.log(`[${worker.deviceId}] ✅ Masih di live setelah dismiss captcha`);
                return;
            }

            console.log(`[${worker.deviceId}] 🔄 Keluar dari live setelah dismiss captcha, re-joining...`);

            // Strategy 1: Coba openUrl tanpa close TikTok dulu (cepat, kalau state masih waras)
            let rejoined = false;
            const targets = [];
            if (ctx.liveUrl) targets.push(ctx.liveUrl);
            if (ctx.username) {
                const clean = ctx.username.replace('@', '');
                targets.push(`https://www.tiktok.com/@${clean}/live`);
            }

            for (let i = 0; i < targets.length && !rejoined; i++) {
                try {
                    await UIHelper.openUrl(worker, targets[i]);
                    await worker.sleep(3000);
                    // Verify benar-benar masuk live
                    if (await this._isStillInLive(worker)) {
                        rejoined = true;
                        console.log(`[${worker.deviceId}] ✅ Re-joined via target ${i + 1} (soft rejoin)`);
                    }
                } catch (e) {
                    console.log(`[${worker.deviceId}] ⚠️ Soft rejoin target ${i + 1} gagal`);
                }
            }

            // Strategy 2: Soft rejoin gagal → escalate ke force rejoin (close + reopen)
            if (!rejoined) {
                console.log(`[${worker.deviceId}] 🔄 Soft rejoin gagal, escalate ke FORCE rejoin...`);
                const forceResult = await this._forceRejoinLive(worker);
                rejoined = forceResult.success;
                if (!rejoined && forceResult.reason === 'live_ended') {
                    // Mark live ended di context supaya main loop tau
                    worker._liveContext._liveEnded = true;
                }
            }

            if (rejoined) {
                // Cek captcha lagi setelah rejoin (kadang muncul lagi)
                await worker.sleep(1500);
                try {
                    const xml = await UIHelper.dumpUI(worker);
                    if (xml && /captcha|Verify to continue|Verifikasi/i.test(xml)) {
                        console.log(`[${worker.deviceId}] 🛡️ Captcha muncul lagi setelah rejoin`);
                    }
                } catch (e) { }
            } else {
                console.log(`[${worker.deviceId}] ❌ Gagal re-join live (soft + force keduanya)`);
            }
        } catch (e) {
            console.log(`[${worker.deviceId}] ⚠️ Rejoin error: ${e.message}`);
        }
    }
}

module.exports = BoostLiveTask;