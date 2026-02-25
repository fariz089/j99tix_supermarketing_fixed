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
            for (const rid of ['com.zhiliaoapp.musically:id/comment_button', 'com.ss.android.ugc.trill:id/comment_button']) {
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

        // Fallback: In TikTok live, send button is at far right of input row (~93% X, ~93% Y)
        // But we need to be on the SAME row as input, not below
        const x = Math.round(W * 0.90);
        const y = Math.round(H * 0.925);
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
        await worker.execAdb('shell monkey -p com.zhiliaoapp.musically 1');
        await worker.sleep(4000);
    }

    static async closeTikTok(worker) {
        try { await worker.execAdb('shell am force-stop com.zhiliaoapp.musically'); await worker.sleep(500); } catch (e) {}
    }

    static async goHome(worker) {
        try { await worker.execAdb('shell input keyevent 3'); await worker.sleep(500); } catch (e) {}
    }

    static async openUrl(worker, url) {
        try {
            await worker.execAdb(`shell am start -a android.intent.action.VIEW -p com.zhiliaoapp.musically -d "${url}"`);
        } catch (e) {
            await worker.execAdb(`shell am start -a android.intent.action.VIEW -d "${url}"`);
        }
        await worker.sleep(1500);
    }

    static async goBack(worker) {
        await worker.execAdb('shell input keyevent 4');
        await worker.sleep(500);
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

        const xml = await this.dumpUI(worker);
        if (xml) {
            const r = this.findByContentDesc(xml, 'share|Share');
            if (r.success) {
                await worker.execAdb(`shell input tap ${r.x} ${r.y}`);
                await worker.sleep(2000);
                const xml2 = await this.dumpUI(worker);
                if (xml2) {
                    const rp = this.findByText(xml2, 'Repost') || this.findByContentDesc(xml2, 'Repost');
                    if (rp && rp.success) {
                        await worker.execAdb(`shell input tap ${rp.x} ${rp.y}`);
                        console.log(`[${worker.deviceId}] 🔄 Reposted!`);
                        await worker.sleep(1500);
                        return true;
                    }
                }
                await this.goBack(worker);
            }
        }
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