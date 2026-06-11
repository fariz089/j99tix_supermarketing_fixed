/**
 * UIHelper v5 — Optimized: Pause + UIAutomator Dump
 * 
 * Key insight: UIAutomator dump FAILS during TikTok video playback
 * (SurfaceView blocks hierarchy traversal → 8s timeout).
 * Solution: Tap center to PAUSE video first, then dump works reliably.
 * 
 * After comment panel opens, dump also works (video is dimmed).
 * 
 * NO dependencies (no tesseract, no sharp, no opencv).
 * Just ADB + uiautomator.
 */
class UIHelper {

    // ================================================
    // UI DUMP
    // ================================================

    /**
     * Dump UI hierarchy. Combined rm+dump+cat in one shell call.
     * Single attempt, max 8s timeout from execAdb.
     */
    static async dumpUI(worker) {
        try {
            const result = await worker.execAdb('shell "rm -f /sdcard/ui.xml; uiautomator dump /sdcard/ui.xml 2>/dev/null; cat /sdcard/ui.xml 2>/dev/null"');
            if (result && result.length > 100 && result.includes('<node')) {
                const cleaned = result.replace(/UI hierarch[^\n]*/g, '').trim();
                if (cleaned.length > 100) return cleaned;
            }
        } catch (e) {}
        return null;
    }

    // ================================================
    // XML PARSERS
    // ================================================

    static findByContentDesc(xml, pattern) {
        if (!xml) return { success: false };
        const patterns = pattern.split('|').map(p => p.trim());
        for (const p of patterns) {
            const regex = new RegExp(
                `content-desc="[^"]*${p}[^"]*"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i'
            );
            const match = xml.match(regex);
            if (match) {
                const x1 = parseInt(match[1]), y1 = parseInt(match[2]);
                const x2 = parseInt(match[3]), y2 = parseInt(match[4]);
                return { success: true, x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
            }
        }
        return { success: false };
    }

    static findByText(xml, pattern) {
        if (!xml) return { success: false };
        const patterns = pattern.split('|').map(p => p.trim());
        for (const p of patterns) {
            const regex = new RegExp(`text="${p}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i');
            const match = xml.match(regex);
            if (match) {
                const x1 = parseInt(match[1]), y1 = parseInt(match[2]);
                const x2 = parseInt(match[3]), y2 = parseInt(match[4]);
                return { success: true, x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
            }
        }
        return { success: false };
    }

    static findByResourceId(xml, resourceId) {
        if (!xml) return { success: false };
        const regex = new RegExp(`resource-id="${resourceId}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i');
        const match = xml.match(regex);
        if (match) {
            const x1 = parseInt(match[1]), y1 = parseInt(match[2]);
            const x2 = parseInt(match[3]), y2 = parseInt(match[4]);
            return { success: true, x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
        }
        return { success: false };
    }

    // ================================================
    // CLICK COMMENT BUTTON (pause → dump → tap icon #2)
    // ================================================

    static async clickCommentButton(worker) {
        const W = worker.screenWidth;
        const H = worker.screenHeight;

        // Step 1: Pause video so UIAutomator can dump
        await worker.execAdb(`shell input tap ${Math.round(W * 0.5)} ${Math.round(H * 0.45)}`);
        await worker.sleep(800);

        // Step 2: Dump UI
        const xml = await this.dumpUI(worker);

        if (xml) {
            // Try content-desc "comment" (most common)
            for (const desc of ['comment', 'Comment', 'Komentar', 'komentar', 'Comments', '评论']) {
                const r = this.findByContentDesc(xml, desc);
                if (r.success && r.x > W * 0.70) {
                    await worker.execAdb(`shell input tap ${r.x} ${r.y}`);
                    console.log(`[${worker.deviceId}] ✅ Comment (desc) at (${r.x}, ${r.y})`);
                    return true;
                }
            }

            // Try resource-id
            for (const rid of ['com.ss.android.ugc.trill:id/comment_button']) {
                const r = this.findByResourceId(xml, rid);
                if (r.success) {
                    await worker.execAdb(`shell input tap ${r.x} ${r.y}`);
                    console.log(`[${worker.deviceId}] ✅ Comment (rid) at (${r.x}, ${r.y})`);
                    return true;
                }
            }

            // Read all right-side icons, sort by Y, tap #2 = comment
            const icons = this._findRightSideIcons(xml, W, H);
            if (icons.length >= 2) {
                const c = icons[1];
                await worker.execAdb(`shell input tap ${c.x} ${c.y}`);
                console.log(`[${worker.deviceId}] ✅ Comment (icon #2) "${c.desc}" at (${c.x}, ${c.y})`);
                return true;
            }
        }

        // Fallback: ratio
        const yRatio = (H / W) > 2.15 ? 0.53 : 0.48;
        const x = Math.round(W * 0.93);
        const y = Math.round(H * yRatio);
        await worker.execAdb(`shell input tap ${x} ${y}`);
        console.log(`[${worker.deviceId}] ⚠️ Comment (fallback) at (${x}, ${y})`);
        return false;
    }

    /**
     * Find all icon-like nodes on right side, sorted by Y (top→bottom).
     * Returns array of { x, y, desc }
     */
    static _findRightSideIcons(xml, W, H) {
        const nodes = [];
        const nodeRegex = /<node\s+([^>]+)>/g;
        let match;

        while ((match = nodeRegex.exec(xml)) !== null) {
            const attrs = match[1];
            const bm = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
            if (!bm) continue;

            const x1 = parseInt(bm[1]), y1 = parseInt(bm[2]);
            const x2 = parseInt(bm[3]), y2 = parseInt(bm[4]);
            const cx = Math.round((x1 + x2) / 2), cy = Math.round((y1 + y2) / 2);
            const w = x2 - x1, h = y2 - y1;

            if (cx < W * 0.75 || cy < H * 0.25 || cy > H * 0.82) continue;
            if (w > W * 0.35 || h > H * 0.15 || w < 10 || h < 10) continue;

            const dm = attrs.match(/content-desc="([^"]*)"/);
            const desc = dm ? dm[1] : '';
            const cm = attrs.match(/class="([^"]*)"/);
            const cls = cm ? cm[1] : '';

            if (/Image|Frame|ViewGroup|Linear/i.test(cls) ||
                /^\d[\d.,]*[KkMmBb]?$/.test(desc) ||
                /clickable="true"/.test(attrs)) {
                nodes.push({ x: cx, y: cy, desc });
            }
        }

        // Sort by Y, deduplicate close nodes
        nodes.sort((a, b) => a.y - b.y);
        const groups = [];
        for (const n of nodes) {
            const last = groups[groups.length - 1];
            if (last && Math.abs(n.y - last.y) < H * 0.04) {
                if (n.desc) { last.x = n.x; last.y = n.y; last.desc = n.desc; }
            } else {
                groups.push({ ...n });
            }
        }
        return groups;
    }

    // ================================================
    // CLICK COMMENT INPUT (dump works here — panel is open)
    // ================================================

    static async clickCommentInput(worker) {
        const W = worker.screenWidth;
        const H = worker.screenHeight;
        const minY = Math.round(H * 0.78);

        const xml = await this.dumpUI(worker);
        if (xml) {
            // content-desc
            for (const p of ['add comment', 'Add comment', 'Tambah komentar', 'tambah komentar', 'Tulis komentar']) {
                const r = this.findByContentDesc(xml, p);
                if (r.success && r.y > minY) {
                    await worker.execAdb(`shell input tap ${r.x} ${r.y}`);
                    console.log(`[${worker.deviceId}] ✅ Input (desc) at (${r.x}, ${r.y})`);
                    return true;
                }
            }

            // text
            for (const p of ['Add comment', 'Tambah komentar', 'Tulis komentar', 'Add comment...', 'Tambah komentar...']) {
                const r = this.findByText(xml, p);
                if (r.success && r.y > minY) {
                    await worker.execAdb(`shell input tap ${r.x} ${r.y}`);
                    console.log(`[${worker.deviceId}] ✅ Input (text "${p}") at (${r.x}, ${r.y})`);
                    return true;
                }
            }

            // Lowest EditText in bottom 20%
            const editRegex = /(<node[^>]*class="android\.widget\.EditText"[^>]*>)/g;
            let em, edits = [];
            while ((em = editRegex.exec(xml)) !== null) {
                const node = em[1];
                if (/package="com\.android\.adbkeyboard"/.test(node)) continue;
                const bm = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
                if (!bm) continue;
                const cy = Math.round((parseInt(bm[2]) + parseInt(bm[4])) / 2);
                const w = parseInt(bm[3]) - parseInt(bm[1]);
                if (cy > minY && w > W * 0.3) {
                    edits.push({ x: Math.round((parseInt(bm[1]) + parseInt(bm[3])) / 2), y: cy });
                }
            }
            if (edits.length > 0) {
                edits.sort((a, b) => b.y - a.y);
                await worker.execAdb(`shell input tap ${edits[0].x} ${edits[0].y}`);
                console.log(`[${worker.deviceId}] ✅ Input (EditText) at (${edits[0].x}, ${edits[0].y})`);
                return true;
            }
        }

        // Fallback
        const x = Math.round(W * 0.35);
        const y = Math.round(H * 0.935);
        await worker.execAdb(`shell input tap ${x} ${y}`);
        console.log(`[${worker.deviceId}] ⚠️ Input (fallback) at (${x}, ${y})`);
        return false;
    }

    // ================================================
    // CLICK SEND BUTTON
    // ================================================

    static async clickSendButton(worker) {
        const W = worker.screenWidth;
        const H = worker.screenHeight;

        const xml = await this.dumpUI(worker);
        if (xml) {
            // Find EditText with typed text → calculate send position
            const editRegex = /(<node[^>]*class="android\.widget\.EditText"[^>]*>)/g;
            let em, edits = [];
            while ((em = editRegex.exec(xml)) !== null) {
                const node = em[1];
                if (/package="com\.android\.adbkeyboard"/.test(node)) continue;
                const textMatch = node.match(/\btext="([^"]*)"/);
                const hasText = textMatch && textMatch[1] && textMatch[1].length > 0;
                const bm = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
                if (!bm) continue;
                const cy = Math.round((parseInt(bm[2]) + parseInt(bm[4])) / 2);
                if (cy > H * 0.05 && cy < H * 0.95) {
                    edits.push({ cy, hasText, w: parseInt(bm[3]) - parseInt(bm[1]) });
                }
            }

            edits.sort((a, b) => (a.hasText !== b.hasText) ? (b.hasText ? 1 : -1) : b.w - a.w);

            if (edits.length > 0) {
                const target = edits[0];
                const isKBOpen = target.cy < H * 0.50;
                let sendX, sendY;

                if (isKBOpen) {
                    sendX = Math.round(W * 0.47);
                    sendY = Math.round(target.cy + 45);
                } else {
                    sendX = Math.round(W * 0.935);
                    sendY = Math.round(target.cy + H * 0.07);
                }

                await worker.execAdb(`shell input tap ${sendX} ${sendY}`);
                console.log(`[${worker.deviceId}] ✅ Send (${isKBOpen ? 'KB open' : 'KB closed'}) at (${sendX}, ${sendY})`);
                return true;
            }
        }

        // Fallback: tap far right at bottom area
        const x = Math.round(W * 0.935);
        const y = Math.round(H * 0.935);
        await worker.execAdb(`shell input tap ${x} ${y}`);
        console.log(`[${worker.deviceId}] ⚠️ Send (fallback) at (${x}, ${y})`);
        return false;
    }

    // ================================================
    // CLICK SEND BUTTON — LIVE STREAM VERSION
    // In live, send button is to the RIGHT of the EditText on the SAME row
    // (not below like in comment panel)
    // ================================================

    static async clickSendButtonLive(worker) {
        const W = worker.screenWidth;
        const H = worker.screenHeight;

        const xml = await this.dumpUI(worker);
        if (xml) {
            // Strategy 1: Find "Send"/"Kirim" button by text
            for (const txt of ['Send', 'Kirim', 'Post', 'send', 'kirim']) {
                const r = this.findByText(xml, txt);
                if (r.success && r.y > H * 0.75) {
                    await worker.execAdb(`shell input tap ${r.x} ${r.y}`);
                    console.log(`[${worker.deviceId}] ✅ Send Live (text "${txt}") at (${r.x}, ${r.y})`);
                    return true;
                }
            }

            // Strategy 2: Find send by content-desc
            for (const desc of ['Send', 'send', 'Kirim', 'kirim', 'Post']) {
                const r = this.findByContentDesc(xml, desc);
                if (r.success && r.y > H * 0.75) {
                    await worker.execAdb(`shell input tap ${r.x} ${r.y}`);
                    console.log(`[${worker.deviceId}] ✅ Send Live (desc "${desc}") at (${r.x}, ${r.y})`);
                    return true;
                }
            }

            // Strategy 3: Find EditText with text → send button is at the RIGHT END of same row
            const editRegex = /(<node[^>]*class="android\.widget\.EditText"[^>]*>)/g;
            let em;
            while ((em = editRegex.exec(xml)) !== null) {
                const node = em[1];
                if (/package="com\.android\.adbkeyboard"/.test(node)) continue;
                const textMatch = node.match(/\btext="([^"]*)"/);
                const hasText = textMatch && textMatch[1] && textMatch[1].length > 0;
                if (!hasText) continue;

                const bm = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
                if (!bm) continue;
                const editY = Math.round((parseInt(bm[2]) + parseInt(bm[4])) / 2);
                const editRight = parseInt(bm[3]);

                // Send button is to the right of EditText, same Y
                // Look for clickable nodes to the right of EditText on same row
                const rightNodes = [];
                const nodeRegex = /<node\s+([^>]+)>/g;
                let nm;
                while ((nm = nodeRegex.exec(xml)) !== null) {
                    const attrs = nm[1];
                    if (/package="com\.android\.adbkeyboard"/.test(attrs)) continue;
                    const nbm = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
                    if (!nbm) continue;
                    const nx1 = parseInt(nbm[1]), ny1 = parseInt(nbm[2]);
                    const nx2 = parseInt(nbm[3]), ny2 = parseInt(nbm[4]);
                    const ncx = Math.round((nx1 + nx2) / 2);
                    const ncy = Math.round((ny1 + ny2) / 2);
                    const nw = nx2 - nx1, nh = ny2 - ny1;

                    // Must be: to the right of EditText, same row (Y within ±5%), small-ish
                    if (ncx > editRight && Math.abs(ncy - editY) < H * 0.05 && nw < W * 0.25 && nh < H * 0.10) {
                        if (/clickable="true"/.test(attrs) || /ImageView|Button/.test(attrs)) {
                            rightNodes.push({ x: ncx, y: ncy });
                        }
                    }
                }

                if (rightNodes.length > 0) {
                    // Take rightmost = send button
                    rightNodes.sort((a, b) => b.x - a.x);
                    const send = rightNodes[0];
                    await worker.execAdb(`shell input tap ${send.x} ${send.y}`);
                    console.log(`[${worker.deviceId}] ✅ Send Live (right of EditText) at (${send.x}, ${send.y})`);
                    return true;
                }
            }
        }

        // Fallback: Send button coordinates based on successful logs:
        // SM-G973F 1080x2280: (1009, 1993) → (0.934, 0.874)
        // X8 800x1280: (764, 1150) → (0.955, 0.898)  
        // SM-G975F 1080x2280: (972, 2109) → (0.900, 0.925)
        // PDEM10 1440x3168: (1332, 2736) → (0.925, 0.864)
        // Average: X ≈ 0.93, Y ≈ 0.89
        const x = Math.round(W * 0.93);
        const y = Math.round(H * 0.89);
        await worker.execAdb(`shell input tap ${x} ${y}`);
        console.log(`[${worker.deviceId}] ⚠️ Send Live (fallback) at (${x}, ${y})`);
        return false;
    }

    // ================================================
    // CLICK COMMENT INPUT — LIVE STREAM VERSION
    // In live, input is always visible at bottom (not in popup panel)
    // ================================================

    static async clickCommentInputLive(worker) {
        const W = worker.screenWidth;
        const H = worker.screenHeight;

        const xml = await this.dumpUI(worker);
        if (xml) {
            // Find input by hint text
            for (const txt of ['type|chat|comment|komentar|Say something|Katakan sesuatu']) {
                const r = this.findByContentDesc(xml, txt);
                if (r.success && r.y > H * 0.80) {
                    await worker.execAdb(`shell input tap ${r.x} ${r.y}`);
                    console.log(`[${worker.deviceId}] ✅ Live input (desc) at (${r.x}, ${r.y})`);
                    return true;
                }
            }

            // Find EditText in bottom 25%
            const editRegex = /(<node[^>]*class="android\.widget\.EditText"[^>]*>)/g;
            let em, edits = [];
            while ((em = editRegex.exec(xml)) !== null) {
                const node = em[1];
                if (/package="com\.android\.adbkeyboard"/.test(node)) continue;
                const bm = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
                if (!bm) continue;
                const cy = Math.round((parseInt(bm[2]) + parseInt(bm[4])) / 2);
                if (cy > H * 0.75) {
                    edits.push({ x: Math.round((parseInt(bm[1]) + parseInt(bm[3])) / 2), y: cy });
                }
            }
            if (edits.length > 0) {
                edits.sort((a, b) => b.y - a.y);
                await worker.execAdb(`shell input tap ${edits[0].x} ${edits[0].y}`);
                console.log(`[${worker.deviceId}] ✅ Live input (EditText) at (${edits[0].x}, ${edits[0].y})`);
                return true;
            }
        }

        // Fallback: tap left-center of bottom bar
        const x = Math.round(W * 0.30);
        const y = Math.round(H * 0.925);
        await worker.execAdb(`shell input tap ${x} ${y}`);
        console.log(`[${worker.deviceId}] ⚠️ Live input (fallback) at (${x}, ${y})`);
        return false;
    }

    // ================================================
    // TYPING
    // ================================================

    static async typeWithADBKeyboard(worker, text) {
        const clean = text.replace(/[\r\n]+/g, ' ').trim();
        if (!clean) return false;
        try {
            await worker.execAdb('shell ime set com.android.adbkeyboard/.AdbIME');
            await worker.sleep(500);
            const b64 = Buffer.from(clean).toString('base64');
            await worker.execAdb(`shell am broadcast -a ADB_INPUT_B64 --es msg "${b64}"`);
            await worker.sleep(1000);
            return true;
        } catch (e) {
            // Fallback: input text word by word
            try {
                const stripped = clean.replace(/[\u{1F600}-\u{1FAFF}]/gu, '').trim();
                if (!stripped) return false;
                const words = stripped.split(/\s+/);
                for (let i = 0; i < words.length; i++) {
                    const esc = words[i].replace(/[\\"`$]/g, '\\$&');
                    await worker.execAdb(`shell input text "${esc}"`);
                    await worker.sleep(300);
                    if (i < words.length - 1) { await worker.execAdb('shell input keyevent 62'); await worker.sleep(150); }
                }
                return true;
            } catch (e2) { return false; }
        }
    }

    // ================================================
    // GESTURES
    // ================================================

    /**
     * Detect device tier for optimized double tap
     */
    static getDeviceTier(worker) {
        const info = worker.deviceInfo || {};
        const model = (info.model || '').toUpperCase();
        const manufacturer = (info.manufacturer || '').toUpperCase();
        if (manufacturer.includes('EVERCOSS') || model === 'X8') return 'low';
        if (manufacturer.includes('SAMSUNG') || manufacturer.includes('OPPO') ||
            model.startsWith('SM-') || model.startsWith('PDEM')) return 'high';
        return 'high';
    }

    /**
     * Double tap center — proven method from SuperMarketing.
     * Tier-based: EVERCOSS X8 uses sendevent, Samsung/OPPO uses worker.doubleTap()
     */
    static async doubleTapLikeCenter(worker) {
        const tier = this.getDeviceTier(worker);
        const W = worker.screenWidth;
        const H = worker.screenHeight;
        const x = worker.randomInt(Math.round(W * 0.30), Math.round(W * 0.70));
        const y = worker.randomInt(Math.round(H * 0.35), Math.round(H * 0.60));

        if (tier === 'low') {
            // EVERCOSS X8: sendevent (fastest, zero Java overhead)
            if (worker._touchDevice && worker._touchMaxRawX && worker._touchMaxRawY) {
                const rawX = Math.round(x * worker._touchMaxRawX / W);
                const rawY = Math.round(y * worker._touchMaxRawY / H);
                const dev = worker._touchDevice;
                const cmd = [
                    `sendevent ${dev} 3 57 0`, `sendevent ${dev} 3 53 ${rawX}`, `sendevent ${dev} 3 54 ${rawY}`,
                    `sendevent ${dev} 1 330 1`, `sendevent ${dev} 0 0 0`,
                    `sendevent ${dev} 3 57 -1`, `sendevent ${dev} 1 330 0`, `sendevent ${dev} 0 0 0`,
                    `sendevent ${dev} 3 57 1`, `sendevent ${dev} 3 53 ${rawX}`, `sendevent ${dev} 3 54 ${rawY}`,
                    `sendevent ${dev} 1 330 1`, `sendevent ${dev} 0 0 0`,
                    `sendevent ${dev} 3 57 -1`, `sendevent ${dev} 1 330 0`, `sendevent ${dev} 0 0 0`
                ].join(' && ');
                try {
                    await worker.execAdb(`shell "${cmd}"`);
                    return true;
                } catch (e) { }
            }
            // Fallback: two swipes in background
            try {
                await worker.execAdb(`shell "input swipe ${x} ${y} ${x} ${y} 30 & input swipe ${x} ${y} ${x} ${y} 30"`);
                return true;
            } catch (e) { }
            // Last resort
            try {
                await worker.execAdb(`shell "input tap ${x} ${y} && input tap ${x} ${y}"`);
                return true;
            } catch (e) { }
        } else {
            // Samsung/OPPO: worker.doubleTap()
            try {
                await worker.doubleTap(x, y);
                return true;
            } catch (e) { }
        }
        // Absolute fallback
        try {
            await worker.execAdb(`shell input tap ${x} ${y}`);
            await worker.sleep(50);
            await worker.execAdb(`shell input tap ${x} ${y}`);
        } catch (e) { }
        return true;
    }

    static async swipeFYP(worker, speed) {
        const x = Math.round(worker.screenWidth * 0.5);
        const sy = Math.round(worker.screenHeight * 0.75);
        const ey = Math.round(worker.screenHeight * 0.25);
        await worker.execAdb(`shell input swipe ${x} ${sy} ${x} ${ey} ${speed || worker.randomInt(200, 400)}`);
    }

    /**
     * Swipe to next video — variant for Profile Boost flow.
     *
     * Profile Boost opens videos from the search-results page, which often
     * shows a CapCut creator tag near the bottom (~y=75-80%). Tapping or
     * starting a swipe there opens Play Store / CapCut app. So we keep
     * the entire gesture comfortably above the CapCut tag zone.
     *
     * No pre-tap (focus tap risked hitting the CapCut tag too).
     * Swipe runs from y=65% → y=20%, x at 45% (slightly left of center,
     * away from the right-side like/comment/share rail), duration ~700ms
     * (slow enough to register as a deliberate fling).
     */
    static async swipeProfileBoostNext(worker) {
        const W = worker.screenWidth;
        const H = worker.screenHeight;

        try {
            const x = Math.round(W * 0.45);
            const sy = Math.round(H * 0.65);   // safely above the CapCut tag area
            const ey = Math.round(H * 0.20);
            await worker.execAdb(`shell input swipe ${x} ${sy} ${x} ${ey} 700`);
        } catch (e) {}
    }

    static async tapScreen(worker) {
        const x = worker.randomInt(Math.round(worker.screenWidth * 0.30), Math.round(worker.screenWidth * 0.70));
        const y = worker.randomInt(Math.round(worker.screenHeight * 0.30), Math.round(worker.screenHeight * 0.50));
        await worker.execAdb(`shell input tap ${x} ${y}`);
        return { x, y };
    }

    static async doubleTapLike(worker) {
        const x = worker.randomInt(Math.round(worker.screenWidth * 0.25), Math.round(worker.screenWidth * 0.50));
        const y = worker.randomInt(Math.round(worker.screenHeight * 0.35), Math.round(worker.screenHeight * 0.65));
        try {
            await worker.execAdb(`shell "input swipe ${x} ${y} ${x} ${y} 50 & input swipe ${x} ${y} ${x} ${y} 50"`);
        } catch (e) {
            try { await worker.doubleTap(x, y); } catch (e2) {
                await worker.execAdb(`shell input tap ${x} ${y}`);
                await worker.sleep(50);
                await worker.execAdb(`shell input tap ${x} ${y}`);
            }
        }
        return true;
    }

    static async likeVideo(worker) { return this.doubleTapLike(worker); }
    static async clickLikeButton(worker) { return this.doubleTapLike(worker); }

    // ================================================
    // APP CONTROL
    // ================================================

    static async openTikTok(worker) {
        // FIX: Replace unreliable 'monkey' with 'am start' (always available, more reliable)
        try {
            // Method 1: Direct activity launch (more reliable than monkey)
            await worker.execAdb('shell am start -n com.ss.android.ugc.trill/com.ss.android.ugc.trill.MainActivity');
            await worker.sleep(4000);
        } catch (e1) {
            try {
                // Method 2: Fallback - generic intent launch
                console.log(`[${worker.deviceId}] ⚠️ Method 1 failed, trying fallback...`);
                await worker.execAdb('shell am start -a android.intent.action.MAIN -n com.ss.android.ugc.trill/.MainActivity');
                await worker.sleep(4000);
            } catch (e2) {
                console.log(`[${worker.deviceId}] ❌ Failed to open TikTok: ${e2.message}`);
                throw new Error(`Cannot open TikTok on ${worker.deviceId}`);
            }
        }
    }

    static async closeTikTok(worker) {
        try { await worker.execAdb('shell am force-stop com.ss.android.ugc.trill'); await worker.sleep(500); } catch (e) {}
    }

    static async goHome(worker) {
        try { await worker.execAdb('shell input keyevent 3'); await worker.sleep(500); } catch (e) {}
    }

    static async openUrl(worker, url) {
        try {
            await worker.execAdb(`shell am start -a android.intent.action.VIEW -p com.ss.android.ugc.trill -d "${url}"`);
        } catch (e) {
            await worker.execAdb(`shell am start -a android.intent.action.VIEW -d "${url}"`);
        }
        // FIX: was 1500ms — too short, video belum sempet load + play sebelum watch timer mulai
        // 4000ms kasih waktu deep link diproses + video load dari server + mulai playback
        await worker.sleep(4000);
    }

    static async goBack(worker) {
        await worker.execAdb('shell input keyevent 4');
        await worker.sleep(500);
    }

    // ================================================
    // CLICK "WATCH ONLY" (popup saat buka link share)
    //
    // Saat buka deep-link share, TikTok kadang munculin popup:
    //   [ Watch and follow ]   ← tombol merah (JANGAN dipencet, itu follow)
    //     Watch only           ← teks ini yang kita mau (cuma nonton)
    //
    // Popup ini TIDAK selalu muncul. Strategi:
    //   1. Dump UI → cari teks "Watch only" / "Tonton saja" → tap (paling akurat,
    //      otomatis nyesuain semua resolusi: X8 800x1280, SM 1080x2280, PDEM10 1440x3168)
    //   2. Kalau dump gagal tapi popup mungkin ada → tap koordinat rasio
    //      tombol "Watch only" (di bawah tombol merah, tengah layar ~Y 0.64)
    //
    // Return: { found: true/false }  — found=true kalau popup terdeteksi & di-tap
    // ================================================
    static async clickWatchOnly(worker, useFallbackCoord = true) {
        const W = worker.screenWidth;
        const H = worker.screenHeight;

        const xml = await this.dumpUI(worker);
        if (xml) {
            // Strategy 1: cari teks "Watch only" (EN + ID + variasi)
            for (const p of ['Watch only', 'watch only', 'Tonton saja', 'tonton saja',
                              'Hanya tonton', 'Hanya menonton', 'Lihat saja']) {
                let r = this.findByText(xml, p);
                if (!r.success) r = this.findByContentDesc(xml, p);
                if (r.success) {
                    await worker.execAdb(`shell input tap ${r.x} ${r.y}`);
                    console.log(`[${worker.deviceId}] 👀 Watch only (text "${p}") at (${r.x}, ${r.y})`);
                    await worker.sleep(1500);
                    return { found: true };
                }
            }

            // Strategy 2: deteksi tombol merah "Watch and follow" → Watch only ada
            // tepat di bawahnya. Hitung posisinya relatif ke tombol merah.
            for (const p of ['Watch and follow', 'watch and follow', 'Tonton dan ikuti',
                             'Tonton & ikuti', 'Ikuti dan tonton']) {
                let r = this.findByText(xml, p);
                if (!r.success) r = this.findByContentDesc(xml, p);
                if (r.success) {
                    // "Watch only" kira-kira 1 baris di bawah tombol merah (~6% tinggi layar)
                    const woX = r.x;
                    const woY = Math.round(r.y + H * 0.058);
                    await worker.execAdb(`shell input tap ${woX} ${woY}`);
                    console.log(`[${worker.deviceId}] 👀 Watch only (below "${p}") at (${woX}, ${woY})`);
                    await worker.sleep(1500);
                    return { found: true };
                }
            }
        }

        // Strategy 3 (opsional): fallback koordinat rasio.
        // Dari screenshot popup: tombol "Watch only" ada di tengah-horizontal,
        // sedikit di bawah tengah layar. Diukur: X ≈ 0.50, Y ≈ 0.64
        // Ini PROPORSIONAL → otomatis benar di semua 4 resolusi device.
        if (useFallbackCoord) {
            const x = Math.round(W * 0.50);
            const y = Math.round(H * 0.64);
            await worker.execAdb(`shell input tap ${x} ${y}`);
            console.log(`[${worker.deviceId}] 👀 Watch only (fallback coord) at (${x}, ${y})`);
            await worker.sleep(1200);
            return { found: false }; // tidak yakin popup ada — ini cuma tap di posisi
        }

        return { found: false };
    }

    // ================================================
    // SCREEN WAKE / STAY-ON (mainly for Samsung screen-timeout issue)
    // ================================================

    /**
     * Check if device screen is currently ON.
     * Check if device screen is currently ON.
     * Tries multiple detection methods (dumpsys power → dumpsys display → input_method).
     * Samsung One UI sometimes returns different formats, so we use multiple checks.
     * Returns true if screen is on, false if confirmed off.
     */
    static async isScreenOn(worker) {
        try {
            // Method 1: dumpsys power | grep mWakefulness (most reliable on stock Android)
            const out1 = await worker.execAdb('shell "dumpsys power 2>/dev/null | grep -E \'mWakefulness=|Display Power|mScreenOn\' | head -5"');
            if (/mWakefulness=Awake/i.test(out1) || /Display Power: state=ON/i.test(out1) || /mScreenOn=true/i.test(out1)) {
                return true;
            }
            if (/mWakefulness=(Asleep|Dozing)/i.test(out1) || /Display Power: state=(OFF|DOZE)/i.test(out1) || /mScreenOn=false/i.test(out1)) {
                return false;
            }
            // Method 2 (Samsung One UI fallback): dumpsys display | grep mScreenState
            const out2 = await worker.execAdb('shell "dumpsys display 2>/dev/null | grep -E \'mScreenState|mState=\' | head -3"');
            if (/mScreenState=ON|mState=ON/i.test(out2)) return true;
            if (/mScreenState=OFF|mState=OFF/i.test(out2)) return false;

            return true; // unknown → assume on (don't trigger wake unnecessarily)
        } catch (e) {
            return true;
        }
    }

    /**
     * Wake the screen if off. Uses KEYCODE_WAKEUP (224).
     * If WAKEUP doesn't work, fall back to POWER (26) which toggles.
     */
    static async wakeScreen(worker) {
        try {
            const on = await this.isScreenOn(worker);
            if (on) return false; // already on
            // KEYCODE_WAKEUP — only turns on, doesn't toggle off (safer than POWER)
            await worker.execAdb('shell input keyevent 224');
            await worker.sleep(500);
            // Verify it worked; if not, try POWER (toggles)
            const onAfter = await this.isScreenOn(worker);
            if (!onAfter) {
                await worker.execAdb('shell input keyevent 26'); // KEYCODE_POWER
                await worker.sleep(500);
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Swipe up to dismiss simple lock screen (no PIN/password).
     */
    static async swipeUpUnlock(worker) {
        try {
            const W = worker.screenWidth;
            const H = worker.screenHeight;
            const x = Math.round(W * 0.5);
            const y1 = Math.round(H * 0.85);
            const y2 = Math.round(H * 0.20);
            await worker.execAdb(`shell input swipe ${x} ${y1} ${x} ${y2} 300`);
            await worker.sleep(800);
        } catch (e) {}
    }

    /**
     * Ensure screen is on + unlock. Always performs the swipe even if screen
     * was already on — cheap (~1s) and ensures any sleeping lockscreen overlay
     * is dismissed. Safe to call repeatedly (mid-task too).
     */
    static async wakeAndUnlock(worker) {
        try {
            // Always send WAKEUP — it's idempotent (no effect if already awake)
            await worker.execAdb('shell input keyevent 224');
            await worker.sleep(400);
            // Always swipe up to dismiss any lockscreen overlay that might be present
            await this.swipeUpUnlock(worker);
        } catch (e) {}
        return true;
    }

    /**
     * Set screen stay-on. Uses combined mode for max compatibility:
     *   true  → "usb,ac,wireless" (keeps screen on while plugged in ANY way,
     *                              including pure WiFi-ADB without USB cable)
     *   false → "false" (revert to OS default timeout)
     */
    static async setStayOn(worker, enabled) {
        try {
            // Combined mode: keep screen on regardless of charge source.
            // On Android 9+: bitmask 7 = USB(1)|AC(2)|WIRELESS(4) = 7
            // On older: comma-separated "usb,ac,wireless"
            const arg = enabled === true ? 'true' :
                        enabled === false ? 'false' :
                        String(enabled);
            // Try the modern bitmask first (works on Android 9+)
            await worker.execAdb(`shell svc power stayon ${arg}`);
            return true;
        } catch (e) {
            return false;
        }
    }

    // ================================================
    // CAPTCHA
    // ================================================

    static async detectCaptcha(worker) {
        try {
            const xml = await this.dumpUI(worker);
            if (!xml) return { detected: false };
            const patterns = [/Verify to continue/i, /Drag the puzzle/i, /Slide to verify/i,
                /Verifikasi untuk melanjutkan/i, /Geser potongan puzzle/i, /captcha/i, /验证/];
            for (const p of patterns) {
                if (p.test(xml)) {
                    console.log(`[${worker.deviceId}] 🛡️ CAPTCHA DETECTED`);
                    return { detected: true, xml };
                }
            }
            return { detected: false };
        } catch (e) { return { detected: false }; }
    }

    static async dismissCaptcha(worker, maxAttempts = 3) {
        const W = worker.screenWidth, H = worker.screenHeight;
        for (let i = 1; i <= maxAttempts; i++) {
            const { detected } = await this.detectCaptcha(worker);
            if (!detected) return { dismissed: true, method: 'gone' };

            // Try close button
            const xml = await this.dumpUI(worker);
            if (xml) {
                for (const desc of ['Close', '×', 'close', 'Tutup']) {
                    const r = this.findByContentDesc(xml, desc);
                    if (r.success && r.y < H * 0.65) {
                        await worker.execAdb(`shell input tap ${r.x} ${r.y}`);
                        await worker.sleep(2000);
                        break;
                    }
                }
            }

            // Back button
            await worker.execAdb('shell input keyevent 4');
            await worker.sleep(2000);

            const check = await this.detectCaptcha(worker);
            if (!check.detected) return { dismissed: true, method: 'dismissed' };
        }
        return { dismissed: false, method: 'failed' };
    }

    static async checkAndDismissCaptcha(worker, label = '') {
        const { detected } = await this.detectCaptcha(worker);
        if (!detected) return true;
        console.log(`[${worker.deviceId}] [${label}] 🛡️ Captcha! Dismissing...`);
        const r = await this.dismissCaptcha(worker);
        console.log(`[${worker.deviceId}] [${label}] ${r.dismissed ? '✅ Cleared' : '❌ Failed'}`);
        return r.dismissed;
    }

    // ================================================
    // SHARE + REPOST
    // ================================================

    static async clickShareAndRepost(worker) {
        const W = worker.screenWidth, H = worker.screenHeight;

        // Pause video first for dump
        await worker.execAdb(`shell input tap ${Math.round(W * 0.5)} ${Math.round(H * 0.45)}`);
        await worker.sleep(800);

        let shareX, shareY;
        const xml = await this.dumpUI(worker);
        if (xml) {
            const r = this.findByContentDesc(xml, 'share|Share|Bagikan');
            if (r.success) {
                shareX = r.x;
                shareY = r.y;
            }
        }

        // Fallback share coordinates from successful logs:
        // X8 800x1280: (759, 1176) → (0.949, 0.919)
        // PDEM10 1440x3168: (1320, 2834) → (0.917, 0.895)
        // SM-G973F 1080x2280: (1001, 2035) → (0.927, 0.893)
        // SM-G975F = same as SM-G973F
        // Average: X ≈ 0.93, Y ≈ 0.90
        if (!shareX) {
            shareX = Math.round(W * 0.93);
            shareY = Math.round(H * 0.90);
            console.log(`[${worker.deviceId}] 🔄 Share button (fallback) at (${shareX}, ${shareY})`);
        } else {
            console.log(`[${worker.deviceId}] 🔄 Share button at (${shareX}, ${shareY})`);
        }

        await worker.execAdb(`shell input tap ${shareX} ${shareY}`);
        await worker.sleep(2000);

        // Try to find Repost button
        const xml2 = await this.dumpUI(worker);
        if (xml2) {
            // Try multiple text variants (EN + ID)
            const rp = this.findByText(xml2, 'Repost|repost|Posting ulang|posting ulang') 
                     || this.findByContentDesc(xml2, 'Repost|repost|Posting ulang|posting ulang');
            if (rp && rp.success) {
                console.log(`[${worker.deviceId}] 🔄 Repost button at (${rp.x}, ${rp.y})`);
                await worker.execAdb(`shell input tap ${rp.x} ${rp.y}`);
                console.log(`[${worker.deviceId}] 🔄 Reposted!`);
                await worker.sleep(1500);
                return true;
            }
            
            // Debug: log semua text yang ada di share panel supaya kita tahu nama button-nya
            const textNodes = [];
            const nodeRegex = /text="([^"]+)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
            let m;
            while ((m = nodeRegex.exec(xml2)) !== null) {
                const txt = m[1];
                const cy = Math.round((parseInt(m[3]) + parseInt(m[5])) / 2);
                // Only log nodes in bottom half (share panel area)
                if (cy > H * 0.5 && txt.length > 0 && txt.length < 30) {
                    textNodes.push(`"${txt}" y=${cy}`);
                }
            }
            if (textNodes.length > 0) {
                console.log(`[${worker.deviceId}] 📋 Share panel texts: ${textNodes.join(', ')}`);
            } else {
                console.log(`[${worker.deviceId}] ⚠️ Repost not found, no text nodes in share panel`);
            }
        } else {
            console.log(`[${worker.deviceId}] ⚠️ UI dump failed after share tap`);
        }
        await this.goBack(worker);
        return false;
    }

    // ================================================
    // BACKWARD-COMPAT ALIASES
    // ================================================

    static async clickByDesc(worker, pattern, retries = 2) {
        for (let i = 0; i < retries; i++) {
            const xml = await this.dumpUI(worker);
            const r = this.findByContentDesc(xml, pattern);
            if (r.success) {
                await worker.execAdb(`shell input tap ${r.x} ${r.y}`);
                return r;
            }
            if (i < retries - 1) await worker.sleep(1500);
        }
        return { success: false };
    }

    static async clickByText(worker, pattern, retries = 2) {
        for (let i = 0; i < retries; i++) {
            const xml = await this.dumpUI(worker);
            const r = this.findByText(xml, pattern);
            if (r.success) {
                await worker.execAdb(`shell input tap ${r.x} ${r.y}`);
                return r;
            }
            if (i < retries - 1) await worker.sleep(1000);
        }
        return { success: false };
    }

    static async postComment(worker, comment) {
        try {
            await this.clickCommentButton(worker);
            await worker.sleep(2000);
            await this.clickCommentInput(worker);
            await worker.sleep(2000);
            await this.typeWithADBKeyboard(worker, comment);
            await worker.sleep(800);
            await this.clickSendButton(worker);
            await worker.sleep(1500);
            return true;
        } catch (e) { return false; }
    }
}

module.exports = UIHelper;