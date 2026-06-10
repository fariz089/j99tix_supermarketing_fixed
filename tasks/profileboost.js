/**
 * Profile Boost Task v5 — Cached coordinates per device category
 * 
 * Flow per cycle:
 *  1. Close TikTok → idle → open TikTok (lands on Home/FYP)
 *  2. Tap Search icon (cached coord OR dump UI)
 *  3. Tap search input (cached coord OR dump UI)
 *  4. Type username via ADB keyboard + Enter
 *  5. Tap first video in results (cached coord OR dump UI)
 *  6. Watch + swipe loop
 * 
 * Cache strategy:
 *  - Key: `${jobId}|${manufacturer}|${model}|${W}x${H}`
 *  - First successful tap stores coords in module-level Map
 *  - Subsequent cycles & devices with same category SKIP dump UI
 *  - Cache reset per job (Map cleared in execute when first task of jobId arrives)
 * 
 * Tier-aware wait:
 *  - Low-tier devices (X8): 2x longer wait at each step
 *  - High-tier (Samsung, OPPO): normal wait
 */

const UIHelper = require('./UIHelper');

// ============================================================
// MODULE-LEVEL CACHE
// Map<jobId, Map<deviceCategoryKey, { searchIcon, searchInput, firstVideo }>>
// ============================================================
const coordCache = new Map();
// Lock to prevent multiple workers from dumping the same category at once
const categoryLock = new Map(); // Map<jobId|category, Promise>

function getDeviceCategoryKey(worker) {
    const info = worker.deviceInfo || {};
    const mfg = (info.manufacturer || 'unknown').toUpperCase();
    const model = (info.model || 'unknown').toUpperCase();
    return `${mfg}|${model}|${worker.screenWidth}x${worker.screenHeight}`;
}

function getJobCache(jobId) {
    if (!jobId) return null;
    let jobMap = coordCache.get(jobId);
    if (!jobMap) {
        jobMap = new Map();
        coordCache.set(jobId, jobMap);
    }
    return jobMap;
}

function getCachedCoords(jobId, worker) {
    const jobMap = getJobCache(jobId);
    if (!jobMap) return null;
    return jobMap.get(getDeviceCategoryKey(worker)) || null;
}

function setCachedCoords(jobId, worker, coords) {
    const jobMap = getJobCache(jobId);
    if (!jobMap) return;
    const key = getDeviceCategoryKey(worker);
    const existing = jobMap.get(key) || {};
    jobMap.set(key, { ...existing, ...coords });
}

// Optional: clean up cache when a job is done (called at end of execute)
function cleanupJobCache(jobId) {
    if (jobId) coordCache.delete(jobId);
}

/**
 * Look across all device categories in this job's cache for a coord of the given type
 * (searchIcon, searchInput, firstVideo). Return the scaled coord for the requesting worker.
 * 
 * The cache key format is `${MFG}|${MODEL}|${W}x${H}`. We extract W & H from the key
 * of the source category and use them to compute proportional (px/H, py/H) ratios,
 * then multiply by the worker's W & H.
 * 
 * This is useful when one device category (e.g. X8) cannot reliably dump the UI,
 * but a similar TikTok layout exists in another category (e.g. Samsung) that DID succeed.
 */
function getScaledCoordsFromOtherCategory(jobId, worker, coordType) {
    const jobMap = getJobCache(jobId);
    if (!jobMap || jobMap.size === 0) return null;
    const ownKey = getDeviceCategoryKey(worker);

    for (const [key, coords] of jobMap.entries()) {
        if (key === ownKey) continue; // skip own (no scaling needed if we had it)
        if (!coords[coordType]) continue;

        // Extract source W/H from key (format: MFG|MODEL|WxH)
        const parts = key.split('|');
        const wxh = parts[parts.length - 1];
        const m = wxh.match(/^(\d+)x(\d+)$/);
        if (!m) continue;
        const srcW = parseInt(m[1]);
        const srcH = parseInt(m[2]);
        if (!srcW || !srcH) continue;

        const sc = coords[coordType];
        const scaledX = Math.round(sc.x / srcW * worker.screenWidth);
        const scaledY = Math.round(sc.y / srcH * worker.screenHeight);
        return { x: scaledX, y: scaledY, sourceKey: key, sourceW: srcW, sourceH: srcH };
    }
    return null;
}

class ProfileBoostTask {

    static getDeviceTier(worker) {
        return UIHelper.getDeviceTier(worker);
    }

    static async doubleTapLikeCenter(worker) {
        return UIHelper.doubleTapLikeCenter(worker);
    }

    // ------------------------------------------------------------
    // TIER-AWARE WAIT — X8 needs 2x longer
    // FAST-MODE — when cache hit & user enabled it, multiply waits by 0.4
    // ------------------------------------------------------------

    static waitMultiplier(worker) {
        return this.getDeviceTier(worker) === 'low' ? 2.0 : 1.0;
    }

    /**
     * Sleep with tier-aware multiplier. When fast=true, cut wait to 40%.
     */
    static async tierSleep(worker, baseMs, fast = false) {
        const mult = this.waitMultiplier(worker) * (fast ? 0.4 : 1.0);
        await worker.sleep(Math.round(baseMs * mult));
    }

    // ------------------------------------------------------------
    // DEBUG HELPERS
    // ------------------------------------------------------------

    static async takeErrorScreenshot(worker, label) {
        // Disabled: auto-screenshot was filling device storage.
        // Re-enable by uncommenting the body below if needed for debugging.
        return null;
        /*
        try {
            const ts = Date.now();
            const remotePath = `/sdcard/pb_err_${label}_${ts}.png`;
            await worker.execAdb(`shell screencap -p ${remotePath}`);
            console.log(`[${worker.deviceId}] 📸 Error screenshot: ${remotePath}`);
            return remotePath;
        } catch (e) { return null; }
        */
    }

    static async verifyTikTokForeground(worker) {
        try {
            const out = await worker.execAdb(`shell "dumpsys window 2>/dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -2"`);
            return /com\.ss\.android\.ugc\.trill|com\.zhiliaoapp\.musically/.test(out || '');
        } catch (e) { return false; }
    }

    // ------------------------------------------------------------
    // PARSE NODES FROM UIAUTOMATOR XML
    // ------------------------------------------------------------

    static parseNodes(xml) {
        if (!xml) return [];
        const nodes = [];
        const nodeRegex = /<node\s+([^>]+?)\/?>/g;
        let m;
        while ((m = nodeRegex.exec(xml)) !== null) {
            const attrs = m[1];
            const boundsMatch = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
            if (!boundsMatch) continue;
            const x1 = +boundsMatch[1], y1 = +boundsMatch[2];
            const x2 = +boundsMatch[3], y2 = +boundsMatch[4];
            const w = x2 - x1, h = y2 - y1;
            if (w <= 0 || h <= 0) continue;
            const ridM = attrs.match(/resource-id="([^"]*)"/);
            const descM = attrs.match(/content-desc="([^"]*)"/);
            const textM = attrs.match(/text="([^"]*)"/);
            const classM = attrs.match(/class="([^"]*)"/);
            const clickM = attrs.match(/clickable="(true|false)"/);
            nodes.push({
                x: Math.round((x1 + x2) / 2),
                y: Math.round((y1 + y2) / 2),
                x1, y1, x2, y2, w, h,
                rid: ridM ? ridM[1] : '',
                desc: descM ? descM[1] : '',
                text: textM ? textM[1] : '',
                cls: classM ? classM[1] : '',
                clickable: clickM ? clickM[1] === 'true' : false
            });
        }
        return nodes;
    }

    // ------------------------------------------------------------
    // ENSURE TIKTOK ON HOME
    // 
    // forceReopen=true → close+open TikTok (fresh state, slow ~5-8s)
    // forceReopen=false → just press back a few times (fast ~1-2s)
    // ------------------------------------------------------------

    static async ensureOnHome(worker, forceReopen = true) {
        console.log(`[${worker.deviceId}]   [STEP] Ensure on TikTok Home ${forceReopen ? '(force reopen)' : '(back to home)'}`);

        if (forceReopen) {
            try { await UIHelper.closeTikTok(worker); } catch (e) { }
            await this.tierSleep(worker, 800);
            try { await UIHelper.openTikTok(worker); } catch (e) { }
            await this.tierSleep(worker, 3500);

            const inForeground = await this.verifyTikTokForeground(worker);
            if (!inForeground) {
                console.log(`[${worker.deviceId}]   [STEP] ⚠️ Not in TikTok — retry`);
                await UIHelper.openTikTok(worker);
                await this.tierSleep(worker, 3000);
            }
            return true;
        }

        // Fast path: press BACK 3x to get out of current view (video → search results → search page → home)
        // KEYCODE_BACK = 4
        const inForeground = await this.verifyTikTokForeground(worker);
        if (!inForeground) {
            // TikTok might have been killed by OS — fall back to full reopen
            console.log(`[${worker.deviceId}]   [STEP] ⚠️ TikTok not foreground — fallback to reopen`);
            try { await UIHelper.openTikTok(worker); } catch (e) { }
            await this.tierSleep(worker, 3500);
            return true;
        }

        for (let i = 0; i < 4; i++) {
            try { await worker.execAdb('shell input keyevent 4'); } catch (e) { }
            await this.tierSleep(worker, 500);
        }
        await this.tierSleep(worker, 800);
        return true;
    }

    // ------------------------------------------------------------
    // TAP SEARCH ICON (cached or via dump)
    // ------------------------------------------------------------

    static async tapSearchIcon(worker, jobId, fastMode = false) {
        const cached = getCachedCoords(jobId, worker);
        if (cached && cached.searchIcon) {
            const c = cached.searchIcon;
            console.log(`[${worker.deviceId}]   [STEP] 🎯 Tap search icon from CACHE @ ${c.x},${c.y}${fastMode ? ' (fast)' : ''}`);
            await worker.execAdb(`shell input tap ${c.x} ${c.y}`);
            await this.tierSleep(worker, 2500, fastMode);
            return true;
        }

        // SHORTCUT: try cross-category cache BEFORE dump UI
        const scaledEarly = getScaledCoordsFromOtherCategory(jobId, worker, 'searchIcon');
        if (scaledEarly) {
            console.log(`[${worker.deviceId}]   [STEP] ⚡ Skip dump UI — use cross-category cache for search icon from "${scaledEarly.sourceKey}" → @ ${scaledEarly.x},${scaledEarly.y}`);
            setCachedCoords(jobId, worker, { searchIcon: { x: scaledEarly.x, y: scaledEarly.y } });
            await worker.execAdb(`shell input tap ${scaledEarly.x} ${scaledEarly.y}`);
            await this.tierSleep(worker, 2500, fastMode);
            return true;
        }

        console.log(`[${worker.deviceId}]   [STEP] 🔍 Find search icon (dump UI — no cache available yet)`);

        for (let attempt = 0; attempt < 4; attempt++) {
            const xml = await UIHelper.dumpUI(worker);
            if (!xml || xml.length < 500) {
                console.log(`[${worker.deviceId}]   [STEP] Dump short attempt ${attempt + 1}`);
                await this.tierSleep(worker, 1500);
                continue;
            }
            const nodes = this.parseNodes(xml);

            // Strategy 1: content-desc
            const r1 = UIHelper.findByContentDesc(xml, 'Search|search|Cari|cari|搜索');
            if (r1.success) {
                console.log(`[${worker.deviceId}]   [STEP] ✓ Search icon via content-desc @ ${r1.x},${r1.y}`);
                setCachedCoords(jobId, worker, { searchIcon: { x: r1.x, y: r1.y } });
                await worker.execAdb(`shell input tap ${r1.x} ${r1.y}`);
                await this.tierSleep(worker, 2500);
                return true;
            }

            // Strategy 2: resource-id
            const ridC = nodes.filter(n =>
                n.clickable && /search.*icon|top_search|search_button|btn_search|search_entry/i.test(n.rid)
            );
            if (ridC.length > 0) {
                ridC.sort((a, b) => a.y - b.y || (worker.screenWidth - a.x) - (worker.screenWidth - b.x));
                const t = ridC[0];
                console.log(`[${worker.deviceId}]   [STEP] ✓ Search icon via resource-id "${t.rid}" @ ${t.x},${t.y}`);
                setCachedCoords(jobId, worker, { searchIcon: { x: t.x, y: t.y } });
                await worker.execAdb(`shell input tap ${t.x} ${t.y}`);
                await this.tierSleep(worker, 2500);
                return true;
            }

            // Strategy 3: small icon top-right
            const topRight = nodes.filter(n =>
                n.clickable &&
                n.y < worker.screenHeight * 0.12 &&
                n.x > worker.screenWidth * 0.70 &&
                n.w < worker.screenWidth * 0.20
            );
            if (topRight.length > 0) {
                topRight.sort((a, b) => b.x - a.x);
                const t = topRight[0];
                console.log(`[${worker.deviceId}]   [STEP] ✓ Search icon via top-right heuristic @ ${t.x},${t.y}`);
                setCachedCoords(jobId, worker, { searchIcon: { x: t.x, y: t.y } });
                await worker.execAdb(`shell input tap ${t.x} ${t.y}`);
                await this.tierSleep(worker, 2500);
                return true;
            }

            await this.tierSleep(worker, 1500);
        }

        // FALLBACK: cross-category cache before blind tap
        const scaled = getScaledCoordsFromOtherCategory(jobId, worker, 'searchIcon');
        if (scaled) {
            console.log(`[${worker.deviceId}]   [STEP] 🔄 Cross-category fallback for search icon from "${scaled.sourceKey}" → @ ${scaled.x},${scaled.y}`);
            setCachedCoords(jobId, worker, { searchIcon: { x: scaled.x, y: scaled.y } });
            await worker.execAdb(`shell input tap ${scaled.x} ${scaled.y}`);
            await this.tierSleep(worker, 2500);
            return true;
        }

        console.log(`[${worker.deviceId}]   [STEP] ⚠️ Search icon not found — fallback blind tap top-right`);
        await this.takeErrorScreenshot(worker, 'no_search_icon');
        const x = Math.round(worker.screenWidth * 0.92);
        const y = Math.round(worker.screenHeight * 0.07);
        await worker.execAdb(`shell input tap ${x} ${y}`);
        await this.tierSleep(worker, 2500);
        return false;
    }

    // ------------------------------------------------------------
    // TAP SEARCH INPUT + TYPE + ENTER
    // ------------------------------------------------------------

    static async tapSearchInputAndType(worker, username, jobId, fastMode = false) {
        const cached = getCachedCoords(jobId, worker);
        let tappedInput = false;

        if (cached && cached.searchInput) {
            const c = cached.searchInput;
            console.log(`[${worker.deviceId}]   [STEP] 🎯 Tap search input from CACHE @ ${c.x},${c.y}${fastMode ? ' (fast)' : ''}`);
            await worker.execAdb(`shell input tap ${c.x} ${c.y}`);
            await this.tierSleep(worker, 1500, fastMode);
            tappedInput = true;
        } else {
            // SHORTCUT: try cross-category cache BEFORE dump UI
            const scaledEarly = getScaledCoordsFromOtherCategory(jobId, worker, 'searchInput');
            if (scaledEarly) {
                console.log(`[${worker.deviceId}]   [STEP] ⚡ Skip dump UI — use cross-category cache for search input from "${scaledEarly.sourceKey}" → @ ${scaledEarly.x},${scaledEarly.y}`);
                setCachedCoords(jobId, worker, { searchInput: { x: scaledEarly.x, y: scaledEarly.y } });
                await worker.execAdb(`shell input tap ${scaledEarly.x} ${scaledEarly.y}`);
                await this.tierSleep(worker, 1500, fastMode);
                tappedInput = true;
            } else {
                console.log(`[${worker.deviceId}]   [STEP] 🔍 Find search input (dump UI — no cache available yet)`);
                for (let attempt = 0; attempt < 3; attempt++) {
                    const xml = await UIHelper.dumpUI(worker);
                    if (!xml) { await this.tierSleep(worker, 1500); continue; }
                    const nodes = this.parseNodes(xml);

                    // Strategy 1: EditText class
                    let cands = nodes.filter(n => n.cls === 'android.widget.EditText');
                    if (cands.length === 0) {
                        // Strategy 2: resource-id for search input
                        cands = nodes.filter(n =>
                            /search.*input|et_search|search_box|search_edit|search_text/i.test(n.rid)
                        );
                    }
                    if (cands.length > 0) {
                        cands.sort((a, b) => a.y - b.y);
                        const t = cands[0];
                        console.log(`[${worker.deviceId}]   [STEP] ✓ Search input @ ${t.x},${t.y} (cls="${t.cls}")`);
                        setCachedCoords(jobId, worker, { searchInput: { x: t.x, y: t.y } });
                        await worker.execAdb(`shell input tap ${t.x} ${t.y}`);
                        await this.tierSleep(worker, 1500);
                        tappedInput = true;
                        break;
                    }
                    await this.tierSleep(worker, 1500);
                }
            }
        }

        if (!tappedInput) {
            // FALLBACK: cross-category cache for search input
            const scaled = getScaledCoordsFromOtherCategory(jobId, worker, 'searchInput');
            if (scaled) {
                console.log(`[${worker.deviceId}]   [STEP] 🔄 Cross-category fallback for search input from "${scaled.sourceKey}" → @ ${scaled.x},${scaled.y}`);
                setCachedCoords(jobId, worker, { searchInput: { x: scaled.x, y: scaled.y } });
                await worker.execAdb(`shell input tap ${scaled.x} ${scaled.y}`);
                await this.tierSleep(worker, 1500);
                tappedInput = true;
            }
        }

        if (!tappedInput) {
            const x = Math.round(worker.screenWidth * 0.5);
            const y = Math.round(worker.screenHeight * 0.07);
            console.log(`[${worker.deviceId}]   [STEP] ⚠️ Fallback blind tap on search bar @ ${x},${y}`);
            await worker.execAdb(`shell input tap ${x} ${y}`);
            await this.tierSleep(worker, 1500);
        }

        console.log(`[${worker.deviceId}]   [STEP] ⌨️ Type "${username}" via ADB keyboard`);
        const typed = await UIHelper.typeWithADBKeyboard(worker, username);
        if (!typed) {
            console.log(`[${worker.deviceId}]   [STEP] ⚠️ Typing failed`);
            return false;
        }
        await this.tierSleep(worker, 1500, fastMode);

        console.log(`[${worker.deviceId}]   [STEP] ↵ Press Enter`);
        await worker.execAdb('shell input keyevent 66');
        await this.tierSleep(worker, 3000, fastMode);

        return true;
    }

    // ------------------------------------------------------------
    // TAP FIRST VIDEO IN SEARCH RESULTS
    // NOTE: video tap coord is NOT cached because video grid position can vary
    // slightly based on user card height (with/without ads/showcase row).
    // BUT we cache the FIRST cycle's coord — for subsequent cycles same category,
    // the layout should be identical (same search query → same result page).
    // ------------------------------------------------------------

    static async tapFirstVideoInGrid(worker, jobId, fastMode = false) {
        const cached = getCachedCoords(jobId, worker);
        if (cached && cached.firstVideo) {
            const c = cached.firstVideo;
            console.log(`[${worker.deviceId}]   [STEP] 🎯 Tap first video from CACHE @ ${c.x},${c.y}${fastMode ? ' (fast)' : ''}`);
            await worker.execAdb(`shell input tap ${c.x} ${c.y}`);
            await this.tierSleep(worker, 3500, fastMode);
            return true;
        }

        // SHORTCUT: try cross-category cache BEFORE dump UI.
        // This is huge for X8 (low-tier) where dump UI is unreliable.
        // If another device category already mapped firstVideo, just scale & tap.
        const scaledEarly = getScaledCoordsFromOtherCategory(jobId, worker, 'firstVideo');
        if (scaledEarly) {
            console.log(`[${worker.deviceId}]   [STEP] ⚡ Skip dump UI — use cross-category cache from "${scaledEarly.sourceKey}" → @ ${scaledEarly.x},${scaledEarly.y}`);
            // Persist scaled coords into own-category cache so next cycles on this device are even faster
            setCachedCoords(jobId, worker, { firstVideo: { x: scaledEarly.x, y: scaledEarly.y } });
            await worker.execAdb(`shell input tap ${scaledEarly.x} ${scaledEarly.y}`);
            await this.tierSleep(worker, 3500, fastMode);
            return true;
        }

        console.log(`[${worker.deviceId}]   [STEP] 🔍 Find first video (dump UI — no cache available yet)`);
        const W = worker.screenWidth, H = worker.screenHeight;

        // Wait for search results to fully render
        await this.tierSleep(worker, 2000);

        for (let attempt = 0; attempt < 8; attempt++) {
            let xml = await UIHelper.dumpUI(worker);
            if (!xml || xml.length < 500) {
                const waitMs = 1500 + (attempt * 500);
                console.log(`[${worker.deviceId}]   [STEP] Dump short attempt ${attempt + 1}, wait ${waitMs}ms`);
                await this.tierSleep(worker, waitMs);
                xml = await UIHelper.dumpUI(worker);
            }
            if (!xml) continue;

            const nodes = this.parseNodes(xml);
            if (nodes.length < 30) {
                console.log(`[${worker.deviceId}]   [STEP] Only ${nodes.length} nodes — wait & retry`);
                await this.tierSleep(worker, 2000);
                continue;
            }

            // Strategy 1: resource-id strict
            let videoNodes = nodes.filter(n =>
                n.clickable &&
                /videomusiccoverblock|video_item|aweme_item|video_cover|post_item/i.test(n.rid)
            );

            const dedup = (arr) => {
                const seen = new Set();
                return arr.filter(n => {
                    const key = `${n.x1},${n.y1}`;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
            };

            videoNodes = dedup(videoNodes);
            const rowTol = Math.round(H * 0.05);
            videoNodes.sort((a, b) => {
                if (Math.abs(a.y - b.y) > rowTol) return a.y - b.y;
                return a.x - b.x;
            });

            console.log(`[${worker.deviceId}]   [STEP] Attempt ${attempt + 1}: ${videoNodes.length} video items via resource-id`);
            if (videoNodes.length >= 1) {
                const t = videoNodes[0];
                console.log(`[${worker.deviceId}]   [STEP] ✓ Tap first video @ ${t.x},${t.y} (rid="${t.rid}")`);
                setCachedCoords(jobId, worker, { firstVideo: { x: t.x, y: t.y } });
                await worker.execAdb(`shell input tap ${t.x} ${t.y}`);
                await this.tierSleep(worker, 3500);
                return true;
            }

            // Strategy 2: thumbnail heuristic
            let thumbs = nodes.filter(n =>
                n.clickable &&
                n.y > H * 0.25 &&
                n.w > W * 0.25 && n.w < W * 0.45 &&
                n.h > W * 0.30 && n.h < W * 0.80
            );
            thumbs = dedup(thumbs);
            thumbs.sort((a, b) => {
                if (Math.abs(a.y - b.y) > rowTol) return a.y - b.y;
                return a.x - b.x;
            });
            if (thumbs.length >= 1) {
                const t = thumbs[0];
                console.log(`[${worker.deviceId}]   [STEP] ✓ Tap first video via thumbnail heuristic @ ${t.x},${t.y}`);
                setCachedCoords(jobId, worker, { firstVideo: { x: t.x, y: t.y } });
                await worker.execAdb(`shell input tap ${t.x} ${t.y}`);
                await this.tierSleep(worker, 3500);
                return true;
            }

            console.log(`[${worker.deviceId}]   [STEP] ⚠️ No video found in ${nodes.length} nodes — wait & retry`);
            await this.tierSleep(worker, 2000);
        }

        // FALLBACK: cross-category cache. If another category in this job
        // already found the firstVideo coord, scale it to our resolution.
        const scaled = getScaledCoordsFromOtherCategory(jobId, worker, 'firstVideo');
        if (scaled) {
            console.log(`[${worker.deviceId}]   [STEP] 🔄 Cross-category fallback: scale from "${scaled.sourceKey}" (${scaled.sourceW}x${scaled.sourceH}) → tap @ ${scaled.x},${scaled.y}`);
            await worker.execAdb(`shell input tap ${scaled.x} ${scaled.y}`);
            await this.tierSleep(worker, 3500);
            return true;
        }

        console.log(`[${worker.deviceId}]   [STEP] ❌ Could not find any video element (no cross-category cache either)`);
        await this.takeErrorScreenshot(worker, 'no_video_found');
        return false;
    }

    // ------------------------------------------------------------
    // MAIN EXECUTE
    // ------------------------------------------------------------

    static async execute(worker, config) {
        const {
            username,
            scrollCount = 5,
            durationMin = 5,
            durationMax = 30,
            swipeDelayMin = 1,
            swipeDelayMax = 3,
            idleDelayMin = 2,
            idleDelayMax = 5,
            totalCycles = 1,
            likeEnabled = true,
            likeChance = 5,
            // Accept both naming conventions
            skipReopen,
            skipReopenBetweenCycles,
            fastMode,
            fastModeOnCache,
            jobId
        } = config;

        // Resolve final values with default ON
        const _skipReopen = (skipReopen !== undefined ? skipReopen
                            : skipReopenBetweenCycles !== undefined ? skipReopenBetweenCycles
                            : true);
        const _fastMode = (fastMode !== undefined ? fastMode
                          : fastModeOnCache !== undefined ? fastModeOnCache
                          : true);

        const db = worker.db;
        const tier = this.getDeviceTier(worker);

        if (!username || typeof username !== 'string') {
            throw new Error('username is required');
        }
        const cleanUsername = username.replace(/^@/, '').trim();
        const totalVideosPerCycle = 1 + scrollCount;

        let stats = {
            cyclesCompleted: 0,
            totalVideosWatched: 0,
            totalWatchTime: 0,
            likes: 0,
            errors: 0
        };

        const checkCancelled = () => {
            if (jobId && worker.isJobCancelled(jobId)) {
                throw new Error('Job cancelled by user');
            }
        };

        try {
            // SCREEN WAKE LOCK: wake/unlock + set stay-on to prevent Samsung lockscreen
            // during long tasks. Reverted to false in finally block at the end.
            await UIHelper.wakeAndUnlock(worker);
            await UIHelper.setStayOn(worker, true);
            console.log(`[${worker.deviceId}] 🔆 Screen stay-on enabled (USB)`);

            const catKey = getDeviceCategoryKey(worker);
            console.log(`[${worker.deviceId}] 🎯 Profile Boost v7 (cached + fast options) | @${cleanUsername} | ${totalCycles} cycles × ${totalVideosPerCycle} videos`);
            console.log(`[${worker.deviceId}] 📐 Screen ${worker.screenWidth}x${worker.screenHeight}, tier: ${tier} (wait x${this.waitMultiplier(worker)}), category: ${catKey}`);
            console.log(`[${worker.deviceId}] ❤️ Like: ${likeEnabled ? `${likeChance}% chance` : 'OFF'}`);
            console.log(`[${worker.deviceId}] ⚡ Skip reopen between cycles: ${_skipReopen ? 'ON' : 'OFF'} | Fast mode on cache: ${_fastMode ? 'ON' : 'OFF'}`);

            await worker.sleep(worker.randomInt(0, 10000));

            // Extra stagger for low-tier devices: give high-tier devices time
            // to populate the cache first. X8 will then benefit from cross-category cache.
            if (tier === 'low') {
                const extra = worker.randomInt(15000, 25000);
                console.log(`[${worker.deviceId}] 🐢 Low-tier extra stagger ${extra}ms — let high-tier devices populate cache first`);
                await worker.sleep(extra);
            }

            const idleDelay = worker.randomInt(idleDelayMin, idleDelayMax);
            if (idleDelay > 0) {
                console.log(`[${worker.deviceId}] [STEP 1/4] Idle ${idleDelay}s`);
                await worker.sleep(idleDelay * 1000);
            }
            if (worker.status === 'paused') await worker.waitForResume();

            let consecutiveErrors = 0;

            for (let cycle = 0; cycle < totalCycles; cycle++) {
                checkCancelled();
                if (worker.status === 'paused') await worker.waitForResume();

                try {
                    // Periodic wake check: re-apply stayon and wake/unlock at the start of each cycle.
                    // Cheap insurance against Samsung devices sometimes ignoring stayon mid-task.
                    try {
                        await UIHelper.setStayOn(worker, true);
                        await UIHelper.wakeAndUnlock(worker);
                    } catch (e) {}

                    const cacheStatus = getCachedCoords(jobId, worker);
                    const cacheInfo = cacheStatus
                        ? `[CACHE: icon=${!!cacheStatus.searchIcon}, input=${!!cacheStatus.searchInput}, video=${!!cacheStatus.firstVideo}]`
                        : '[CACHE: empty]';
                    console.log(`[${worker.deviceId}] [STEP 2/4] 🔄 Cycle ${cycle + 1}/${totalCycles} ${cacheInfo}`);

                    // Determine if cache is hit (fast mode active) for this cycle
                    const cacheHitAll = !!(cacheStatus && cacheStatus.searchIcon && cacheStatus.searchInput && cacheStatus.firstVideo);
                    const useFast = _fastMode && cacheHitAll;

                    // Cycle 1 ALWAYS does full reopen for clean state.
                    // Cycle 2+: respect _skipReopen config.
                    const forceReopen = (cycle === 0) || !_skipReopen;

                    await this.ensureOnHome(worker, forceReopen);
                    if (worker.status === 'paused') await worker.waitForResume();

                    await this.tapSearchIcon(worker, jobId, useFast);
                    if (worker.status === 'paused') await worker.waitForResume();

                    await this.tapSearchInputAndType(worker, cleanUsername, jobId, useFast);
                    if (worker.status === 'paused') await worker.waitForResume();

                    const tapped = await this.tapFirstVideoInGrid(worker, jobId, useFast);
                    if (!tapped) {
                        throw new Error('Could not find video in search results');
                    }
                    if (worker.status === 'paused') await worker.waitForResume();

                    // Watch + swipe loop
                    let videosWatched = 0;
                    for (let vIdx = 1; vIdx <= totalVideosPerCycle; vIdx++) {
                        checkCancelled();
                        if (worker.status === 'paused') await worker.waitForResume();

                        const dur = worker.randomInt(durationMin, durationMax);
                        console.log(`[${worker.deviceId}] [STEP 3/4] 👁️ Watch video #${vIdx}/${totalVideosPerCycle} (${dur}s) — cycle ${cycle + 1}`);

                        const watchEnd = Date.now() + (dur * 1000);
                        let lastAction = 0;

                        while (Date.now() < watchEnd) {
                            checkCancelled();
                            if (worker.status === 'paused') await worker.waitForResume();
                            await worker.sleep(2000);

                            if (!likeEnabled) continue;
                            const now = Date.now();
                            if (now - lastAction < 5000) continue;
                            if (Math.random() * 100 < likeChance) {
                                try {
                                    await this.doubleTapLikeCenter(worker);
                                    lastAction = now;
                                    stats.likes++;
                                    console.log(`[${worker.deviceId}]   ❤️ Like on video #${vIdx}`);
                                } catch (e) { }
                            }
                        }

                        stats.totalWatchTime += dur;
                        videosWatched++;
                        stats.totalVideosWatched++;

                        if (vIdx < totalVideosPerCycle) {
                            const swipeDelay = worker.randomInt(swipeDelayMin, swipeDelayMax);
                            await worker.sleep(swipeDelay * 1000);
                            try {
                                await UIHelper.swipeProfileBoostNext(worker);
                                console.log(`[${worker.deviceId}]   ⬆️ Swipe to next video`);
                            } catch (e) { }
                            await this.tierSleep(worker, 2500, useFast);
                        }
                    }

                    console.log(`[${worker.deviceId}] ✓ Cycle ${cycle + 1} done: ${videosWatched} videos watched`);

                    stats.cyclesCompleted++;
                    consecutiveErrors = 0;
                    if (jobId && db) { try { await db.incrementJobProgress(jobId, 1); } catch (e) { } }

                    if (cycle < totalCycles - 1) {
                        // If skipReopen is ON, don't close TikTok (next cycle will use back button).
                        // If OFF, close TikTok so next cycle can do clean reopen.
                        if (_skipReopen) {
                            console.log(`[${worker.deviceId}] [STEP 4/4] Quick cleanup (skip-reopen mode)`);
                            await worker.sleep(worker.randomInt(800, 1500));
                        } else {
                            console.log(`[${worker.deviceId}] [STEP 4/4] Cleanup (close TikTok)`);
                            try { await UIHelper.closeTikTok(worker); } catch (e) { }
                            await worker.sleep(worker.randomInt(1500, 3000));
                        }
                    }

                } catch (cycleError) {
                    if (cycleError.message && cycleError.message.includes('cancelled')) throw cycleError;

                    consecutiveErrors++;
                    stats.errors++;
                    console.error(`[${worker.deviceId}] ⚠️ Cycle ${cycle + 1} ERROR: ${cycleError.message}`);
                    await this.takeErrorScreenshot(worker, `cycle${cycle + 1}_error`);

                    console.log(`[${worker.deviceId}] 🔄 Recovering...`);
                    try { await UIHelper.closeTikTok(worker); } catch (e) { }
                    await worker.sleep(3000);
                    try { await UIHelper.goHome(worker); } catch (e) { }
                    await worker.sleep(2000);

                    if (consecutiveErrors >= 5) {
                        throw new Error(`${consecutiveErrors} consecutive cycle errors`);
                    }
                }
            }

            try { await UIHelper.closeTikTok(worker); } catch (e) { }
            try { await UIHelper.goHome(worker); } catch (e) { }
            console.log(`[${worker.deviceId}] ✅ Done! ${stats.cyclesCompleted}/${totalCycles} cycles, ${stats.totalVideosWatched} videos, ${stats.likes} likes, ${stats.errors} errors`);

            return stats;

        } catch (error) {
            console.error(`[${worker.deviceId}] ❌ Failed:`, error.message);
            await this.takeErrorScreenshot(worker, 'fatal');
            try { await UIHelper.closeTikTok(worker); await UIHelper.goHome(worker); } catch (e) { }
            throw error;
        } finally {
            // Always revert screen stay-on so the device can sleep normally
            try {
                await UIHelper.setStayOn(worker, false);
                console.log(`[${worker.deviceId}] 🌙 Screen stay-on disabled`);
            } catch (e) {}
        }
    }

    // Optional helper to allow external code to clear cache (e.g. when a job ends).
    // Not strictly needed because cache is keyed by jobId and old jobIds are never queried.
    // But useful to free memory after long-running sessions.
    static clearJobCache(jobId) {
        cleanupJobCache(jobId);
    }
}

module.exports = ProfileBoostTask;
