/**
 * UIHelper - Universal UI interaction helper for all tasks
 * Uses uiautomator dump to find elements by content-desc, text, resource-id
 * Works on ALL screen resolutions without hardcoded coordinates
 */
class UIHelper {

    /**
     * Dump UI hierarchy and return XML string
     */
    static async dumpUI(worker, retries = 2) {
        for (let i = 0; i < retries; i++) {
            try {
                // Combine dump+cat in single shell call to reduce ADB round-trips
                const xml = await worker.execAdb('shell "uiautomator dump /sdcard/ui.xml && cat /sdcard/ui.xml"');
                if (xml && xml.length > 100) return xml;
                // If combined command fails, try separate (some devices don't support &&)
                await worker.execAdb('shell uiautomator dump /sdcard/ui.xml');
                await worker.sleep(i === 0 ? 500 : 1000);
                const xml2 = await worker.execAdb('shell cat /sdcard/ui.xml');
                if (xml2 && xml2.length > 100) return xml2;
            } catch (e) {
                if (i < retries - 1) await worker.sleep(1000);
            }
        }
        return null;
    }

    /**
     * Find element bounds by content-desc pattern
     * Returns { success, x, y, x1, y1, x2, y2 } or { success: false }
     */
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
                if (!isNaN(x1) && !isNaN(y1) && !isNaN(x2) && !isNaN(y2)) {
                    return {
                        success: true,
                        x: Math.round((x1 + x2) / 2),
                        y: Math.round((y1 + y2) / 2),
                        x1, y1, x2, y2
                    };
                }
            }
        }
        return { success: false };
    }

    /**
     * Find element bounds by text attribute
     */
    static findByText(xml, pattern) {
        if (!xml) return { success: false };
        const patterns = pattern.split('|').map(p => p.trim());
        for (const p of patterns) {
            const regex = new RegExp(
                `text="${p}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i'
            );
            const match = xml.match(regex);
            if (match) {
                const x1 = parseInt(match[1]), y1 = parseInt(match[2]);
                const x2 = parseInt(match[3]), y2 = parseInt(match[4]);
                if (!isNaN(x1) && !isNaN(y1) && !isNaN(x2) && !isNaN(y2)) {
                    return {
                        success: true,
                        x: Math.round((x1 + x2) / 2),
                        y: Math.round((y1 + y2) / 2),
                        x1, y1, x2, y2
                    };
                }
            }
        }
        return { success: false };
    }

    /**
     * Find element by resource-id
     */
    static findByResourceId(xml, resourceId) {
        if (!xml) return { success: false };
        const regex = new RegExp(
            `resource-id="${resourceId}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i'
        );
        const match = xml.match(regex);
        if (match) {
            const x1 = parseInt(match[1]), y1 = parseInt(match[2]);
            const x2 = parseInt(match[3]), y2 = parseInt(match[4]);
            if (!isNaN(x1) && !isNaN(y1) && !isNaN(x2) && !isNaN(y2)) {
                return {
                    success: true,
                    x: Math.round((x1 + x2) / 2),
                    y: Math.round((y1 + y2) / 2),
                    x1, y1, x2, y2
                };
            }
        }
        return { success: false };
    }

    // ============================================
    // HIGH-LEVEL ACTIONS (resolution independent)
    // ============================================

    /**
     * Click element by content-desc with retries
     */
    static async clickByDesc(worker, pattern, retries = 3) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            const xml = await this.dumpUI(worker);
            const result = this.findByContentDesc(xml, pattern);
            if (result.success) {
                await worker.execAdb(`shell input tap ${result.x} ${result.y}`);
                console.log(`[${worker.deviceId}] ✅ Clicked "${pattern}" at (${result.x}, ${result.y})`);
                return result;
            }
            if (attempt < retries) await worker.sleep(1500);
        }
        console.log(`[${worker.deviceId}] ⚠️ Element "${pattern}" not found`);
        return { success: false };
    }

    /**
     * Click element by text with retries
     */
    static async clickByText(worker, pattern, retries = 2) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            const xml = await this.dumpUI(worker);
            const result = this.findByText(xml, pattern);
            if (result.success) {
                await worker.execAdb(`shell input tap ${result.x} ${result.y}`);
                console.log(`[${worker.deviceId}] ✅ Clicked text "${pattern}" at (${result.x}, ${result.y})`);
                return result;
            }
            if (attempt < retries) await worker.sleep(1000);
        }
        return { success: false };
    }

    /**
     * Click send/post button - SMART APPROACH based on EditText position
     * 
     * TikTok comment UI has TWO different layouts:
     * 
     * KEYBOARD OPEN (EditText in upper half of screen):
     *   Row 1: [avatar] [EditText "sweet kaa"]
     *   Row 2: [📷] [☺] [@]  ................  [↑ SEND]
     *   Send button is in the ICON ROW, ~45px below EditText center
     *   Send X ≈ 47% of screen width (right end of icon row, NOT screen edge)
     * 
     * KEYBOARD CLOSED (EditText in lower half):
     *   [avatar] [EditText "sweet kaa"] [↑ SEND]
     *   Send button is at the RIGHT EDGE of the input bar
     *   Send X ≈ 93% of screen width
     * 
     * From user screenshots on 800x1280:
     *   KB open:   send at ~(375, 425) = (47%W, 33%H)
     *   KB closed: send at ~(744, varies) = (93%W, same Y as input)
     */
    static async clickSendButton(worker) {
        const W = worker.screenWidth;
        const H = worker.screenHeight;

        // ============================================================
        // STRATEGY 1: Find EditText with text → calculate send position
        // ============================================================
        try {
            const xml = await this.dumpUI(worker);
            if (xml) {
                const editRegex = /(<node[^>]*class="android\.widget\.EditText"[^>]*>)/g;
                let match;
                const editTexts = [];
                
                while ((match = editRegex.exec(xml)) !== null) {
                    const node = match[1];
                    
                    // Skip ADB Keyboard / system IME
                    if (/package="com\.android\.adbkeyboard"/.test(node)) continue;
                    if (/package="com\.android\.inputmethod"/.test(node)) continue;
                    
                    const textMatch = node.match(/\btext="([^"]*)"/);
                    const hasText = textMatch && textMatch[1] && textMatch[1].length > 0;
                    
                    const boundsMatch = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
                    if (!boundsMatch) continue;
                    
                    const x1 = parseInt(boundsMatch[1]), y1 = parseInt(boundsMatch[2]);
                    const x2 = parseInt(boundsMatch[3]), y2 = parseInt(boundsMatch[4]);
                    const cy = Math.round((y1 + y2) / 2);
                    
                    if (cy < H * 0.95 && cy > H * 0.05) {
                        editTexts.push({ x1, y1, x2, y2, cy, hasText, w: x2 - x1 });
                    }
                }
                
                // Prefer EditText WITH text, then widest
                editTexts.sort((a, b) => {
                    if (a.hasText !== b.hasText) return b.hasText ? 1 : -1;
                    return b.w - a.w;
                });
                
                if (editTexts.length > 0) {
                    const target = editTexts[0];
                    const isKeyboardOpen = target.cy < H * 0.50;
                    
                    let sendX, sendY;
                    
                    if (isKeyboardOpen) {
                        // Keyboard OPEN: send button is in icon row BELOW the EditText
                        // From screenshots: send ↑ is at ~47% width, ~45px below EditText center
                        sendX = Math.round(W * 0.47);
                        sendY = Math.round(target.cy + 45);
                        console.log(`[${worker.deviceId}] 📤 KB OPEN: EditText at y=${target.cy}, send at (${sendX}, ${sendY})`);
                    } else {
                        // Keyboard CLOSED: send button is in ICON ROW BELOW EditText
                        // Layout: Row1=[avatar][EditText] Row2=[📷][☺][@][#]...[↑SEND]
                        // From screenshot: EditText cy≈754, send button at ≈(748,842)
                        // Offset is ~88px below EditText center (~7% of screen height)
                        sendX = Math.round(W * 0.935);
                        sendY = Math.round(target.cy + H * 0.07);
                        console.log(`[${worker.deviceId}] 📤 KB CLOSED: EditText at y=${target.cy}, send at (${sendX}, ${sendY})`);
                    }
                    
                    await worker.execAdb(`shell input tap ${sendX} ${sendY}`);
                    await worker.sleep(1000);
                    
                    // Try the OTHER state too in case we guessed wrong
                    let altX, altY;
                    if (isKeyboardOpen) {
                        // Also try KB-closed position (icon row below EditText)
                        altX = Math.round(W * 0.935);
                        altY = Math.round(target.cy + H * 0.07);
                    } else {
                        // Also try KB-open position (send in icon row below, centered)
                        altX = Math.round(W * 0.47);
                        altY = Math.round(target.cy + 45);
                    }
                    console.log(`[${worker.deviceId}]    → also trying alt (${altX}, ${altY})`);
                    await worker.execAdb(`shell input tap ${altX} ${altY}`);
                    
                    return true;
                }
                
                console.log(`[${worker.deviceId}] ⚠️ No EditText found in UI dump`);
            }
        } catch (e) {
            console.log(`[${worker.deviceId}] ⚠️ UI dump failed: ${e.message}`);
        }

        // ============================================================
        // STRATEGY 2: Hardcoded fallback positions
        // ============================================================
        console.log(`[${worker.deviceId}] 📤 Trying hardcoded send positions...`);
        
        // Try both keyboard states
        const positions = [
            // KB closed: send in icon row (from screenshot: ~93.5%W, ~65.8%H for 800x1280)
            { x: Math.round(W * 0.935), y: Math.round(H * 0.658) },
            // KB open: icon row send button
            { x: Math.round(W * 0.47), y: Math.round(H * 0.33) },
            // Additional KB closed fallbacks at various heights
            { x: Math.round(W * 0.935), y: Math.round(H * 0.70) },
            { x: Math.round(W * 0.935), y: Math.round(H * 0.60) },
            { x: Math.round(W * 0.935), y: Math.round(H * 0.75) },
            { x: Math.round(W * 0.935), y: Math.round(H * 0.50) },
        ];
        
        for (const pos of positions) {
            await worker.execAdb(`shell input tap ${pos.x} ${pos.y}`);
            await worker.sleep(350);
        }
        
        return false;
    }

    /**
     * Click comment button on video page
     * 
     * IMPORTANT: On first load (cold start), TikTok can take 8-15s to fully render.
     * UIAutomator dump will be empty/incomplete until the page is ready.
     * We retry with increasing delays to handle slow devices.
     */
    static async clickCommentButton(worker) {
        // Optimized: 2 rounds instead of 4, check ALL patterns per single dump
        // Total worst case: ~12s instead of ~37s
        const maxAttempts = 4;
        const waitTimes = [1500, 2000, 2500, 3000];
        
        for (let i = 0; i < maxAttempts; i++) {
            const xml = await this.dumpUI(worker);
            
            if (xml) {
                // Try content-desc "comment" (most common, EN)
                const result = this.findByContentDesc(xml, 'comment');
                if (result.success) {
                    await worker.execAdb(`shell input tap ${result.x} ${result.y}`);
                    console.log(`[${worker.deviceId}] ✅ Clicked "comment" at (${result.x}, ${result.y})`);
                    return true;
                }
                
                // Try resource-id (works on all languages)
                for (const rid of [
                    'com.zhiliaoapp.musically:id/comment_button',
                    'com.ss.android.ugc.trill:id/comment_button'
                ]) {
                    const ridResult = this.findByResourceId(xml, rid);
                    if (ridResult.success) {
                        await worker.execAdb(`shell input tap ${ridResult.x} ${ridResult.y}`);
                        console.log(`[${worker.deviceId}] ✅ Clicked comment (resource-id) at (${ridResult.x}, ${ridResult.y})`);
                        return true;
                    }
                }
                
                // Try multi-language content-desc on right side
                for (const desc of ['Komentar', 'komentar', 'Comments', 'comments', 'Bình luận', 'コメント', '评论']) {
                    const descResult = this.findByContentDesc(xml, desc);
                    if (descResult.success && descResult.x > worker.screenWidth * 0.75) {
                        await worker.execAdb(`shell input tap ${descResult.x} ${descResult.y}`);
                        console.log(`[${worker.deviceId}] ✅ Clicked comment (desc "${desc}") at (${descResult.x}, ${descResult.y})`);
                        return true;
                    }
                }
                
                // OPPO/Realme pattern: content-desc is often a number (comment count) 
                // on right-side icons. Find ImageView with numeric content-desc on right side,
                // positioned between like and share (roughly 55-75% height)
                const numericDescRegex = /content-desc="(\d+)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
                let numMatch;
                const rightIcons = [];
                while ((numMatch = numericDescRegex.exec(xml)) !== null) {
                    const cx = Math.round((parseInt(numMatch[2]) + parseInt(numMatch[4])) / 2);
                    const cy = Math.round((parseInt(numMatch[3]) + parseInt(numMatch[5])) / 2);
                    if (cx > worker.screenWidth * 0.80 && cy > worker.screenHeight * 0.40 && cy < worker.screenHeight * 0.75) {
                        rightIcons.push({ x: cx, y: cy, desc: numMatch[1] });
                    }
                }
                // Comment icon is typically the 2nd icon from top (after like/heart)
                if (rightIcons.length >= 2) {
                    rightIcons.sort((a, b) => a.y - b.y);
                    const commentIcon = rightIcons[1]; // 2nd one = comment
                    await worker.execAdb(`shell input tap ${commentIcon.x} ${commentIcon.y}`);
                    console.log(`[${worker.deviceId}] ✅ Clicked comment (numeric desc "${commentIcon.desc}") at (${commentIcon.x}, ${commentIcon.y})`);
                    return true;
                }
            }
            
            if (i < maxAttempts - 1) await worker.sleep(waitTimes[i]);
        }
        
        console.log(`[${worker.deviceId}] ⚠️ Element "comment" not found after extended retries`);

        // Fallback: percentage-based coordinates
        const x = Math.round(worker.screenWidth * 0.93);
        const y = Math.round(worker.screenHeight * 0.645);
        await worker.execAdb(`shell input tap ${x} ${y}`);
        console.log(`[${worker.deviceId}] ⚠️ Comment fallback at (${x}, ${y})`);
        return false;
    }

    /**
     * Click comment input field ("Add comment...")
     * 
     * Flow: comment panel is open, keyboard NOT yet open.
     * We need to tap the TikTok "Add comment..." input bar at the VERY BOTTOM
     * of the comment panel (just above the navigation bar).
     * 
     * CRITICAL: If we tap the wrong area (on someone's comment text), TikTok
     * opens a REPLY to that comment instead of a new comment. This is the #1 bug.
     * 
     * The "Add comment..." bar is at ~y=93-96% of screen height on most devices.
     * It contains: [avatar] [EditText "Add comment..."] [📷] [☺] [@]
     * 
     * Strategy order:
     * 1. Find by content-desc (various languages)
     * 2. Find by text attribute ("Add comment...", "Tambah komentar...", etc.)
     * 3. Find by resource-id (TikTok specific)
     * 4. Find lowest EditText in TikTok package (must be in bottom 20% of screen)
     * 5. Fallback: tap at very bottom of screen (93-95%H)
     */
    static async clickCommentInput(worker) {
        const W = worker.screenWidth;
        const H = worker.screenHeight;
        
        // The "Add comment" input is ALWAYS at the very bottom of the comment panel
        // It should be in the bottom 20% of screen (y > 80%H)
        // Anything above that is comment text and will trigger REPLY mode
        const minY = Math.round(H * 0.78);  // Input must be BELOW this
        const maxY = Math.round(H * 0.99);  // But above nav bar
        
        const xml = await this.dumpUI(worker);
        
        if (xml) {
            // STRATEGY 1: Find by content-desc patterns
            const descPatterns = [
                'add comment', 'Add comment', 'Tambah komentar', 'tambah komentar',
                'tulis komentar', 'Tulis komentar', 'Write a comment', 'Añadir comentario',
                'Agregar comentario', 'コメントを追加', 'Thêm bình luận'
            ];
            for (const p of descPatterns) {
                const result = this.findByContentDesc(xml, p);
                if (result.success && result.y > minY && result.y < maxY) {
                    await worker.execAdb(`shell input tap ${result.x} ${result.y}`);
                    console.log(`[${worker.deviceId}] ✅ Comment input (content-desc "${p}") at (${result.x}, ${result.y})`);
                    return true;
                }
            }
            
            // STRATEGY 2: Find by text attribute
            const textPatterns = [
                'Add comment', 'Tambah komentar', 'Tulis komentar',
                'Write a comment', 'Añadir comentario', 'Agregar comentario',
                'Add comment...', 'Tambah komentar...', 'Tulis komentar...'
            ];
            for (const p of textPatterns) {
                const result = this.findByText(xml, p);
                if (result.success && result.y > minY && result.y < maxY) {
                    await worker.execAdb(`shell input tap ${result.x} ${result.y}`);
                    console.log(`[${worker.deviceId}] ✅ Comment input (text "${p}") at (${result.x}, ${result.y})`);
                    return true;
                }
            }
            
            // STRATEGY 3: Find by resource-id (TikTok uses these)
            const resourceIds = [
                'com.zhiliaoapp.musically:id/comment_input',
                'com.ss.android.ugc.trill:id/comment_input',
                'com.zhiliaoapp.musically:id/be3',
                'com.ss.android.ugc.trill:id/be3'
            ];
            for (const rid of resourceIds) {
                const result = this.findByResourceId(xml, rid);
                if (result.success && result.y > minY) {
                    await worker.execAdb(`shell input tap ${result.x} ${result.y}`);
                    console.log(`[${worker.deviceId}] ✅ Comment input (resource-id) at (${result.x}, ${result.y})`);
                    return true;
                }
            }
            
            // STRATEGY 4: Find the LOWEST EditText in TikTok (not ADB Keyboard)
            // The "Add comment..." input is always the lowest TikTok EditText
            const allEditRegex = /(<node[^>]*class="android\.widget\.EditText"[^>]*>)/g;
            let editTexts = [];
            let m;
            
            while ((m = allEditRegex.exec(xml)) !== null) {
                const node = m[1];
                
                // Skip ADB Keyboard / system IME packages
                if (/package="com\.android\.adbkeyboard"/.test(node)) continue;
                if (/package="com\.android\.inputmethod"/.test(node)) continue;
                
                const boundsMatch = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
                if (!boundsMatch) continue;
                
                const x1 = parseInt(boundsMatch[1]), y1 = parseInt(boundsMatch[2]);
                const x2 = parseInt(boundsMatch[3]), y2 = parseInt(boundsMatch[4]);
                const cy = Math.round((y1 + y2) / 2);
                const w = x2 - x1;
                
                // Must be in bottom area AND reasonably wide (input bar spans most of screen)
                if (cy > minY && cy < maxY && w > W * 0.3) {
                    editTexts.push({ 
                        x: Math.round((x1 + x2) / 2), 
                        y: cy, 
                        w,
                        node: node.substring(0, 100) // for debug
                    });
                }
            }
            
            if (editTexts.length > 0) {
                // Pick the LOWEST one (highest Y) - that's the "Add comment" bar
                editTexts.sort((a, b) => b.y - a.y);
                const target = editTexts[0];
                await worker.execAdb(`shell input tap ${target.x} ${target.y}`);
                console.log(`[${worker.deviceId}] ✅ Comment input (lowest EditText) at (${target.x}, ${target.y})`);
                return true;
            }
            
            console.log(`[${worker.deviceId}] ⚠️ No comment input found in UI dump, using fallback`);
        }

        // STRATEGY 5: Fallback - tap at very bottom of comment panel
        // From screenshots: "Add comment..." is at ~93-95% of screen height
        // CRITICAL: Must be very low on screen. Tapping at 80% hits comment text → Reply mode!
        const x = Math.round(W * 0.35);
        const y = Math.round(H * 0.935);
        console.log(`[${worker.deviceId}] ⚠️ Comment input fallback at (${x}, ${y})`);
        await worker.execAdb(`shell input tap ${x} ${y}`);
        await worker.sleep(800);
        
        // Try a second tap slightly higher in case first was too low (hit nav bar)
        const y2 = Math.round(H * 0.91);
        await worker.execAdb(`shell input tap ${x} ${y2}`);
        console.log(`[${worker.deviceId}]    → also trying (${x}, ${y2})`);
        return false;
    }

    /**
     * Type text using ADBKeyBoard (supports emoji via Base64)
     * Falls back to regular input text if ADBKeyBoard not available
     */
    static async typeWithADBKeyboard(worker, text) {
        const cleanText = text.replace(/[\r\n]+/g, ' ').trim();
        if (!cleanText) return false;

        try {
            // Set ADBKeyBoard as input method
            await worker.execAdb('shell ime set com.android.adbkeyboard/.AdbIME');
            await worker.sleep(500);

            // Send via Base64 (supports emoji)
            const base64Text = Buffer.from(cleanText).toString('base64');
            await worker.execAdb(`shell am broadcast -a ADB_INPUT_B64 --es msg "${base64Text}"`);
            await worker.sleep(1000);
            return true;
        } catch (e) {
            console.log(`[${worker.deviceId}] ⚠️ ADBKeyBoard failed, using fallback`);
            return await this.typeFallback(worker, cleanText);
        }
    }

    /**
     * Fallback text input without ADBKeyBoard (no emoji support)
     */
    static async typeFallback(worker, text) {
        try {
            const textOnly = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FAFF}]/gu, '').trim();
            if (!textOnly) return false;

            const words = textOnly.split(/\s+/).filter(w => w);
            for (let i = 0; i < words.length; i++) {
                const escaped = words[i].replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'").replace(/`/g, '\\`').replace(/\$/g, '\\$');
                await worker.execAdb(`shell input text "${escaped}"`);
                await worker.sleep(300);
                if (i < words.length - 1) {
                    await worker.execAdb('shell input keyevent 62');
                    await worker.sleep(150);
                }
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    // ============================================
    // GESTURE HELPERS (percentage-based, resolution independent)
    // ============================================

    /**
     * Like a video - smart approach that works on ALL devices including slow ones
     * 
     * Strategy:
     * 1. First try: click the heart ICON on right side via UIAutomator (1 single tap, no pause risk)
     * 2. Fallback: use "input swipe X Y X Y 50" which simulates a long-press-release
     *    that TikTok may interpret as engagement, then double tap
     * 
     * The UIAutomator approach is BEST because:
     * - Single tap on heart icon = guaranteed like
     * - No risk of pausing video
     * - Works on ALL resolutions (UIAutomator finds actual button position)
     * 
     * Note: dumpUI is cached for 3 seconds to avoid spamming uiautomator dump
     */
    static _uiCache = { xml: null, timestamp: 0 };

    static async getCachedUI(worker) {
        const now = Date.now();
        if (this._uiCache.xml && (now - this._uiCache.timestamp) < 3000) {
            return this._uiCache.xml;
        }
        const xml = await this.dumpUI(worker);
        this._uiCache = { xml, timestamp: now };
        return xml;
    }

    static async likeVideo(worker) {
        // Strategy 1: Find and click the heart/like ICON via UIAutomator
        const xml = await this.getCachedUI(worker);
        if (xml) {
            // TikTok like button content-desc patterns
            for (const pattern of ['Like', 'like', 'heart', 'Heart', 'Suka']) {
                const result = this.findByContentDesc(xml, pattern);
                // Make sure it's on the right side of screen (to avoid hitting other "like" elements)
                if (result.success && result.x > worker.screenWidth * 0.7) {
                    await worker.execAdb(`shell input tap ${result.x} ${result.y}`);
                    console.log(`[${worker.deviceId}] ❤️ Like icon tapped at (${result.x}, ${result.y})`);
                    // Invalidate cache since UI changed
                    this._uiCache = { xml: null, timestamp: 0 };
                    return true;
                }
            }
        }

        // Strategy 2: Fallback — double tap with swipe trick
        // "input swipe X Y X Y 50" = tap and hold 50ms at same point, 
        // done twice with no shell sleep = much faster than input tap + sleep + input tap
        const x = worker.randomInt(
            Math.round(worker.screenWidth * 0.25),
            Math.round(worker.screenWidth * 0.50)
        );
        const y = worker.randomInt(
            Math.round(worker.screenHeight * 0.35),
            Math.round(worker.screenHeight * 0.65)
        );
        try {
            // Two swipe-taps in one shell call with no delay between them
            await worker.execAdb(`shell "input swipe ${x} ${y} ${x} ${y} 50 & input swipe ${x} ${y} ${x} ${y} 50"`);
        } catch (e) {
            // Final fallback
            await worker.doubleTap(x, y);
        }
        console.log(`[${worker.deviceId}] ❤️ Like double-tap at (${x}, ${y})`);
        return true;
    }

    /**
     * @deprecated Use likeVideo() instead — kept for backward compatibility
     */
    static async doubleTapLike(worker) {
        return this.likeVideo(worker);
    }

    /**
     * Swipe up for FYP scroll
     */
    static async swipeFYP(worker, speed) {
        const x = Math.round(worker.screenWidth * 0.5);
        const startY = Math.round(worker.screenHeight * 0.75);
        const endY = Math.round(worker.screenHeight * 0.25);
        const swipeSpeed = speed || worker.randomInt(200, 400);
        await worker.execAdb(`shell input swipe ${x} ${startY} ${x} ${endY} ${swipeSpeed}`);
    }

    /**
     * Tap center of screen (for natural behavior, e.g. pause/unpause)
     */
    static async tapScreen(worker) {
        const x = worker.randomInt(
            Math.round(worker.screenWidth * 0.30),
            Math.round(worker.screenWidth * 0.70)
        );
        const y = worker.randomInt(
            Math.round(worker.screenHeight * 0.30),
            Math.round(worker.screenHeight * 0.50)
        );
        await worker.execAdb(`shell input tap ${x} ${y}`);
        return { x, y };
    }

    // ============================================
    // TIKTOK-SPECIFIC HELPERS
    // ============================================

    static async openTikTok(worker) {
        await worker.execAdb('shell monkey -p com.zhiliaoapp.musically 1');
        await worker.sleep(4000);
    }

    static async closeTikTok(worker) {
        try {
            await worker.execAdb('shell am force-stop com.zhiliaoapp.musically');
            await worker.sleep(500);
        } catch (e) { }
    }

    static async goHome(worker) {
        try {
            await worker.execAdb('shell input keyevent 3');
            await worker.sleep(500);
        } catch (e) { }
    }

    static async openUrl(worker, url) {
        // Use TikTok package directly to avoid Samsung "Open with" dialog
        // This is faster and more reliable than generic VIEW intent
        try {
            await worker.execAdb(`shell am start -a android.intent.action.VIEW -p com.zhiliaoapp.musically -d "${url}"`);
        } catch (e) {
            // Fallback to generic intent if package-specific fails
            await worker.execAdb(`shell am start -a android.intent.action.VIEW -d "${url}"`);
        }
        await worker.sleep(1500);
    }

    static async goBack(worker) {
        await worker.execAdb('shell input keyevent 4');
        await worker.sleep(500);
    }

    /**
     * Full comment flow: click comment button → click input → type → send
     */
    static async postComment(worker, comment) {
        try {
            // Click comment button
            await this.clickCommentButton(worker);
            
            // Check for captcha (often appears after clicking comment)
            // Poll a few times since captcha WebView takes time to render
            for (let poll = 0; poll < 3; poll++) {
                await worker.sleep(1500);
                const { detected } = await this.detectCaptcha(worker);
                if (detected) {
                    console.log(`[${worker.deviceId}] 🛡️ Captcha detected after comment click, dismissing...`);
                    const result = await this.dismissCaptcha(worker);
                    if (!result.dismissed) {
                        throw new Error('Captcha could not be dismissed');
                    }
                    // Comment panel stays open after captcha dismiss
                    await worker.sleep(1500);
                    break;
                }
            }

            // Click input field
            await this.clickCommentInput(worker);
            await worker.sleep(2000);

            // Type comment
            await this.typeWithADBKeyboard(worker, comment);
            await worker.sleep(800); // minimal delay - keyboard closes fast

            // Click send
            await this.clickSendButton(worker);
            await worker.sleep(1500);

            console.log(`[${worker.deviceId}] ✅ Comment posted: "${comment}"`);
            return true;
        } catch (e) {
            console.error(`[${worker.deviceId}] ❌ Comment failed: ${e.message}`);
            return false;
        }
    }

    /**
     * Click like button — alias for likeVideo()
     */
    static async clickLikeButton(worker) {
        return this.likeVideo(worker);
    }

    // ============================================
    // CAPTCHA DETECTION & DISMISSAL
    // ============================================

    /**
     * Detect if a CAPTCHA/verification dialog is currently on screen.
     * 
     * TikTok captchas typically show:
     * - "Verify to continue" or "Verifikasi untuk melanjutkan" text
     * - A puzzle piece drag challenge
     * - "Refresh" and "Report a problem" buttons
     * - Close button (X) in the top-right corner of the dialog
     * 
     * @returns { detected: boolean, xml: string|null, closeInfo: object|null }
     */
    static async detectCaptcha(worker) {
        try {
            const xml = await this.dumpUI(worker);
            if (!xml) return { detected: false, xml: null, closeInfo: null };

            const captchaPatterns = [
                /Verify to continue/i,
                /Drag the puzzle/i,
                /Report a problem/i,
                /Slide to verify/i,
                /Complete the verification/i,
                /Verifikasi untuk melanjutkan/i,
                /Geser potongan puzzle/i,
                /Geser untuk verifikasi/i,
                /Laporkan masalah/i,
                /验证/,
                /拖动滑块/,
                /拼图/,
                /確認してください/,
                /Xác minh để tiếp tục/i,
                /captcha/i,
                /verification.*puzzle/i,
            ];

            let captchaDetected = false;
            for (const pattern of captchaPatterns) {
                if (pattern.test(xml)) {
                    captchaDetected = true;
                    break;
                }
            }

            if (!captchaDetected) {
                return { detected: false, xml, closeInfo: null };
            }

            console.log(`[${worker.deviceId}] 🛡️ CAPTCHA DETECTED!`);
            const closeInfo = this._findCaptchaCloseButton(worker, xml);
            return { detected: true, xml, closeInfo };
        } catch (e) {
            console.log(`[${worker.deviceId}] ⚠️ Captcha detection error: ${e.message}`);
            return { detected: false, xml: null, closeInfo: null };
        }
    }

    /**
     * Find the close button (X) on a captcha dialog.
     */
    static _findCaptchaCloseButton(worker, xml) {
        if (!xml) return null;
        const W = worker.screenWidth;
        const H = worker.screenHeight;

        // Method 1: Find by content-desc
        for (const desc of ['Close', '×', 'close', 'Tutup', 'tutup', '关闭', 'Đóng']) {
            const result = this.findByContentDesc(xml, desc);
            if (result.success && result.y < H * 0.65 && result.x > W * 0.4) {
                return { success: true, x: result.x, y: result.y, method: `content-desc "${desc}"` };
            }
        }

        // Method 2: Find by text "×" or "✕"
        for (const txt of ['×', '✕', '✖']) {
            const result = this.findByText(xml, txt);
            if (result.success && result.y < H * 0.65) {
                return { success: true, x: result.x, y: result.y, method: `text "${txt}"` };
            }
        }

        // Method 3: Look for small clickable ImageView/ImageButton in top-right of captcha area
        const closeNodeRegex = /(<node[^>]*class="android\.widget\.(ImageView|ImageButton)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*>)/g;
        let match;
        const candidates = [];
        while ((match = closeNodeRegex.exec(xml)) !== null) {
            const node = match[1];
            const x1 = parseInt(match[3]), y1 = parseInt(match[4]);
            const x2 = parseInt(match[5]), y2 = parseInt(match[6]);
            const w = x2 - x1;
            const h = y2 - y1;
            const cx = Math.round((x1 + x2) / 2);
            const cy = Math.round((y1 + y2) / 2);

            if (w >= 15 && w <= 80 && h >= 15 && h <= 80 && cx > W * 0.55 && cy < H * 0.55) {
                const isClickable = /clickable="true"/.test(node);
                candidates.push({ x: cx, y: cy, w, h, clickable: isClickable });
            }
        }

        if (candidates.length > 0) {
            candidates.sort((a, b) => {
                if (a.clickable !== b.clickable) return b.clickable ? 1 : -1;
                return (b.x - a.x) || (a.y - b.y);
            });
            const best = candidates[0];
            return { success: true, x: best.x, y: best.y, method: 'ImageView close candidate' };
        }

        return null;
    }

    /**
     * Attempt to dismiss/close a detected CAPTCHA.
     * 
     * Strategy order:
     * 1. Tap the close (X) button if found via UI analysis
     * 2. Press Back button (Android KEYEVENT_BACK)
     * 3. Tap outside the dialog to dismiss
     * 
     * @param maxAttempts - number of dismiss attempts before giving up
     * @returns { dismissed: boolean, method: string }
     */
    static async dismissCaptcha(worker, maxAttempts = 3) {
        const W = worker.screenWidth;
        const H = worker.screenHeight;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            console.log(`[${worker.deviceId}] 🛡️ Captcha dismiss attempt ${attempt}/${maxAttempts}...`);

            const { detected, xml, closeInfo } = await this.detectCaptcha(worker);

            if (!detected) {
                console.log(`[${worker.deviceId}] ✅ Captcha no longer detected!`);
                return { dismissed: true, method: attempt === 1 ? 'not present' : `cleared on attempt ${attempt}` };
            }

            // Strategy 1: Tap close button
            if (closeInfo && closeInfo.success) {
                console.log(`[${worker.deviceId}] 🛡️ Tapping close via ${closeInfo.method} at (${closeInfo.x}, ${closeInfo.y})`);
                await worker.execAdb(`shell input tap ${closeInfo.x} ${closeInfo.y}`);
                await worker.sleep(2000);

                const check = await this.detectCaptcha(worker);
                if (!check.detected) {
                    console.log(`[${worker.deviceId}] ✅ Captcha dismissed via close button!`);
                    return { dismissed: true, method: 'close button' };
                }
            }

            // Strategy 2: Back button
            console.log(`[${worker.deviceId}] 🛡️ Trying Back button...`);
            await worker.execAdb('shell input keyevent 4');
            await worker.sleep(2000);

            const checkBack = await this.detectCaptcha(worker);
            if (!checkBack.detected) {
                console.log(`[${worker.deviceId}] ✅ Captcha dismissed via Back button!`);
                return { dismissed: true, method: 'back button' };
            }

            // Strategy 3: Tap outside dialog
            console.log(`[${worker.deviceId}] 🛡️ Trying tap outside dialog...`);
            await worker.execAdb(`shell input tap ${Math.round(W * 0.1)} ${Math.round(H * 0.05)}`);
            await worker.sleep(1500);

            const checkOutside = await this.detectCaptcha(worker);
            if (!checkOutside.detected) {
                console.log(`[${worker.deviceId}] ✅ Captcha dismissed via outside tap!`);
                return { dismissed: true, method: 'outside tap' };
            }

            if (attempt < maxAttempts) {
                console.log(`[${worker.deviceId}] ⚠️ Captcha still present, waiting before retry...`);
                await worker.sleep(2000);
            }
        }

        console.log(`[${worker.deviceId}] ❌ Failed to dismiss captcha after ${maxAttempts} attempts`);
        return { dismissed: false, method: 'all strategies failed' };
    }

    /**
     * Check for captcha and dismiss if found.
     * Convenience wrapper for use in task flows at key checkpoints.
     * 
     * @param label - descriptive label for logging
     * @returns boolean - true if no captcha or successfully dismissed
     */
    static async checkAndDismissCaptcha(worker, label = '') {
        const prefix = label ? ` [${label}]` : '';
        const { detected } = await this.detectCaptcha(worker);
        
        if (!detected) return true;

        console.log(`[${worker.deviceId}]${prefix} 🛡️ Captcha detected! Attempting to dismiss...`);
        const result = await this.dismissCaptcha(worker);
        
        if (result.dismissed) {
            console.log(`[${worker.deviceId}]${prefix} ✅ Captcha cleared (${result.method})`);
            return true;
        } else {
            console.log(`[${worker.deviceId}]${prefix} ❌ Captcha could not be dismissed`);
            return false;
        }
    }

    /**
     * Click share button and try to repost
     */
    static async clickShareAndRepost(worker) {
        const xml = await this.dumpUI(worker);
        if (!xml) return false;

        // Find share button
        for (const pattern of ['share', 'Share']) {
            const result = this.findByContentDesc(xml, pattern);
            if (result.success) {
                await worker.execAdb(`shell input tap ${result.x} ${result.y}`);
                await worker.sleep(2000);

                // Try to find and click repost
                const xml2 = await this.dumpUI(worker);
                if (xml2) {
                    for (const rp of ['Repost', 'repost']) {
                        const repostResult = this.findByText(xml2, rp);
                        if (repostResult.success) {
                            await worker.execAdb(`shell input tap ${repostResult.x} ${repostResult.y}`);
                            await worker.sleep(1500);
                            console.log(`[${worker.deviceId}] 🔄 Reposted!`);
                            return true;
                        }
                        const repostDesc = this.findByContentDesc(xml2, rp);
                        if (repostDesc.success) {
                            await worker.execAdb(`shell input tap ${repostDesc.x} ${repostDesc.y}`);
                            await worker.sleep(1500);
                            console.log(`[${worker.deviceId}] 🔄 Reposted!`);
                            return true;
                        }
                    }
                }

                // Close share menu
                await this.goBack(worker);
                console.log(`[${worker.deviceId}] ⚠️ Share opened but repost not found`);
                return false;
            }
        }

        console.log(`[${worker.deviceId}] ⚠️ Share button not found`);
        return false;
    }
}

module.exports = UIHelper;