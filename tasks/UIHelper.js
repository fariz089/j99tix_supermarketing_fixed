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
     * Detect if a TikTok search bar is present at the bottom of the screen.
     * 
     * The search bar (e.g. "Search - sepaket ms glow lengkap...") appears above
     * the navigation bar and pushes the right-side action icons (like, comment, 
     * save, share) UPWARD. This shifts their Y positions and causes the comment 
     * button fallback/numeric detection to hit the wrong icon.
     * 
     * @param xml - UI dump XML string
     * @param worker - worker instance for screen dimensions
     * @returns { hasSearchBar: boolean, searchBarY: number|null }
     */
    static detectSearchBar(xml, worker) {
        if (!xml) return { hasSearchBar: false, searchBarY: null };
        const H = worker.screenHeight;
        const W = worker.screenWidth;

        // Search bar patterns:
        // 1. content-desc or text containing "Search" with a query
        // 2. Resource-id patterns for TikTok search bar
        // 3. EditText or TextView with "Search" text in bottom 25% of screen

        // Pattern 1: Look for "Search - ..." text in bottom area
        const searchTextRegex = /(?:text|content-desc)="[^"]*[Ss]earch[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
        let match;
        while ((match = searchTextRegex.exec(xml)) !== null) {
            const y1 = parseInt(match[2]);
            const y2 = parseInt(match[4]);
            const cy = Math.round((y1 + y2) / 2);
            const x1 = parseInt(match[1]);
            const x2 = parseInt(match[3]);
            const width = x2 - x1;
            // Search bar is wide (>40% of screen) and in bottom 30% of screen
            if (cy > H * 0.70 && width > W * 0.40) {
                console.log(`[${worker.deviceId}] 🔍 Search bar detected at y=${cy} (width=${width})`);
                return { hasSearchBar: true, searchBarY: cy };
            }
        }

        // Pattern 2: TikTok search bar resource-ids
        const searchRids = [
            'com.zhiliaoapp.musically:id/search_bar',
            'com.ss.android.ugc.trill:id/search_bar',
            'com.zhiliaoapp.musically:id/abo',
            'com.ss.android.ugc.trill:id/abo',
        ];
        for (const rid of searchRids) {
            const result = this.findByResourceId(xml, rid);
            if (result.success && result.y > H * 0.70) {
                console.log(`[${worker.deviceId}] 🔍 Search bar detected (resource-id) at y=${result.y}`);
                return { hasSearchBar: true, searchBarY: result.y };
            }
        }

        // Pattern 3: Look for a wide clickable element with "Search" or magnifying glass
        // near the bottom that spans most of the width
        const searchDescPatterns = ['Search', 'Cari', 'Pencarian', 'Tìm kiếm'];
        for (const p of searchDescPatterns) {
            const result = this.findByContentDesc(xml, p);
            if (result.success && result.y > H * 0.70 && (result.x2 - result.x1) > W * 0.40) {
                console.log(`[${worker.deviceId}] 🔍 Search bar detected (desc "${p}") at y=${result.y}`);
                return { hasSearchBar: true, searchBarY: result.y };
            }
        }

        return { hasSearchBar: false, searchBarY: null };
    }

    /**
     * Click comment button on video page
     * 
     * IMPORTANT: On first load (cold start), TikTok can take 8-15s to fully render.
     * UIAutomator dump will be empty/incomplete until the page is ready.
     * We retry with increasing delays to handle slow devices.
     * 
     * SEARCH BAR HANDLING:
     * When TikTok shows a search bar at the bottom of the screen (e.g. "Search - sepaket ms glow..."),
     * all right-side icons shift UP. This means:
     * - X8 devices: Without search bar, fallback Y hits Like instead of Comment.
     *               With search bar, the icons are shifted up so the same Y hits Comment correctly.
     * - OPPO/PDEM: Without search bar, fallback works for Comment.
     *              With search bar, icons shift up and the same Y hits Save instead of Comment.
     * 
     * Solution: Detect search bar presence and adjust icon selection + fallback Y accordingly.
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
                
                // Detect search bar presence - this affects icon positions
                const { hasSearchBar } = this.detectSearchBar(xml, worker);
                
                // OPPO/Realme pattern: content-desc is often a number (comment count) 
                // on right-side icons. Find ImageView with numeric content-desc on right side.
                //
                // Right-side icon order (top to bottom): Like, Comment, Save/Bookmark, Share
                // ABOVE Like there is the Avatar/Profile button (~35-42% height) — MUST EXCLUDE!
                // When search bar is present, all icons shift UP.
                //
                // CRITICAL: The avatar/profile circle can also have a numeric content-desc 
                // (follower count). It sits at ~35-42% height. Action icons (like, comment, 
                // save, share) are always BELOW 43% height. We use 43% as minimum Y to 
                // safely exclude the avatar.
                const numericDescRegex = /content-desc="(\d+)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
                let numMatch;
                const rightIcons = [];
                while ((numMatch = numericDescRegex.exec(xml)) !== null) {
                    const cx = Math.round((parseInt(numMatch[2]) + parseInt(numMatch[4])) / 2);
                    const cy = Math.round((parseInt(numMatch[3]) + parseInt(numMatch[5])) / 2);
                    const iconW = parseInt(numMatch[4]) - parseInt(numMatch[2]);
                    const iconH = parseInt(numMatch[5]) - parseInt(numMatch[3]);
                    // Right side icons: x > 75% of screen, reasonable icon size
                    // IMPORTANT: cy > 43% to exclude avatar/profile button above the action icons
                    if (cx > worker.screenWidth * 0.75 && 
                        cy > worker.screenHeight * 0.43 && cy < worker.screenHeight * 0.85 &&
                        iconW < worker.screenWidth * 0.20 && iconH < worker.screenHeight * 0.10) {
                        rightIcons.push({ x: cx, y: cy, desc: numMatch[1], w: iconW, h: iconH });
                    }
                }
                
                if (rightIcons.length >= 2) {
                    rightIcons.sort((a, b) => a.y - b.y);
                    
                    console.log(`[${worker.deviceId}] 🔢 Found ${rightIcons.length} right-side numeric icons (searchBar=${hasSearchBar}):`);
                    rightIcons.forEach((icon, idx) => {
                        console.log(`[${worker.deviceId}]    [${idx}] desc="${icon.desc}" at (${icon.x}, ${icon.y})`);
                    });
                    
                    // The comment icon is ALWAYS the 2nd icon from the top in the
                    // right-side column. The order is: Like(heart), Comment(bubble), 
                    // Save(bookmark), Share(arrow).
                    // Index 1 = Comment regardless of search bar, because search bar
                    // shifts ALL icons equally - the relative order stays the same.
                    //
                    // However, we also look at non-numeric icons (like bookmark/save 
                    // which might have text desc) to build a complete picture.
                    
                    // Additional validation: if we have exactly 2 numeric icons and they're
                    // far apart, we might be missing some. In that case, pick more carefully.
                    if (rightIcons.length >= 3) {
                        // 3+ icons: comment is index 1 (2nd from top)
                        const commentIcon = rightIcons[1];
                        await worker.execAdb(`shell input tap ${commentIcon.x} ${commentIcon.y}`);
                        console.log(`[${worker.deviceId}] ✅ Clicked comment (numeric desc "${commentIcon.desc}", idx=1/${rightIcons.length}) at (${commentIcon.x}, ${commentIcon.y})`);
                        return true;
                    } else if (rightIcons.length === 2) {
                        // Only 2 numeric icons found. This often means like + comment are numeric,
                        // while save/share have text descriptions or different attributes.
                        // Comment = 2nd one (index 1)
                        const commentIcon = rightIcons[1];
                        
                        // Sanity check: the gap between the 2 icons should be reasonable
                        // (not spanning half the screen, which would mean we're picking wrong ones)
                        const gap = commentIcon.y - rightIcons[0].y;
                        const expectedGap = worker.screenHeight * 0.12; // ~12% of screen between icons
                        
                        if (gap > 0 && gap < expectedGap * 2.5) {
                            await worker.execAdb(`shell input tap ${commentIcon.x} ${commentIcon.y}`);
                            console.log(`[${worker.deviceId}] ✅ Clicked comment (numeric desc "${commentIcon.desc}", 2-icon mode, gap=${gap}px) at (${commentIcon.x}, ${commentIcon.y})`);
                            return true;
                        } else {
                            console.log(`[${worker.deviceId}] ⚠️ 2 numeric icons but gap=${gap}px seems off (expected ~${Math.round(expectedGap)}px), skipping`);
                        }
                    }
                }
                
                // Also try: find ALL right-side interactive elements (not just numeric)
                // to build a complete icon column and pick the comment one
                const allRightIcons = this._findRightSideIcons(xml, worker);
                if (allRightIcons.length >= 3) {
                    console.log(`[${worker.deviceId}] 🔢 Extended right-side icon scan: ${allRightIcons.length} icons found`);
                    allRightIcons.forEach((icon, idx) => {
                        console.log(`[${worker.deviceId}]    [${idx}] type="${icon.type}" desc="${icon.desc}" at (${icon.x}, ${icon.y})`);
                    });
                    
                    // Comment is 2nd from top
                    const commentIcon = allRightIcons[1];
                    await worker.execAdb(`shell input tap ${commentIcon.x} ${commentIcon.y}`);
                    console.log(`[${worker.deviceId}] ✅ Clicked comment (extended scan, idx=1) at (${commentIcon.x}, ${commentIcon.y})`);
                    return true;
                }
            }
            
            if (i < maxAttempts - 1) await worker.sleep(waitTimes[i]);
        }
        
        console.log(`[${worker.deviceId}] ⚠️ Element "comment" not found after extended retries`);

        // ============================================================
        // FALLBACK: percentage-based coordinates WITH search bar awareness
        // ============================================================
        // Do one more UI dump to check for search bar
        const fallbackXml = await this.dumpUI(worker);
        const { hasSearchBar } = this.detectSearchBar(fallbackXml, worker);
        
        const x = Math.round(worker.screenWidth * 0.93);
        let y;
        
        // RIGHT-SIDE ICON LAYOUT (top to bottom):
        //   Avatar/Profile: ~35-42% ← NEVER tap here!
        //   Like (heart):   ~47%
        //   Comment:        ~55%
        //   Save:           ~63%
        //   Share:          ~70%
        // With search bar, everything shifts UP by ~7-8%:
        //   Avatar/Profile: ~30-37%
        //   Like (heart):   ~40%
        //   Comment:        ~48%
        //   Save:           ~55%
        //   Share:           ~63%
        
        if (hasSearchBar) {
            // Search bar present: icons shifted UP
            // Comment is at ~48% of screen height
            y = Math.round(worker.screenHeight * 0.48);
            console.log(`[${worker.deviceId}] ⚠️ Comment fallback WITH search bar at (${x}, ${y})`);
        } else {
            // No search bar: Comment at ~55% height
            y = Math.round(worker.screenHeight * 0.55);
            console.log(`[${worker.deviceId}] ⚠️ Comment fallback NO search bar at (${x}, ${y})`);
        }
        
        await worker.execAdb(`shell input tap ${x} ${y}`);
        
        // Secondary tap: try slightly BELOW (towards Save) rather than above (towards Avatar!)
        // Going up risks hitting Like or Avatar. Going down hits Save which is less harmful.
        await worker.sleep(500);
        const y2 = hasSearchBar 
            ? Math.round(worker.screenHeight * 0.51)  // slightly below, still in comment zone
            : Math.round(worker.screenHeight * 0.58);  // slightly below, still in comment zone
        console.log(`[${worker.deviceId}]    → also trying (${x}, ${y2})`);
        await worker.execAdb(`shell input tap ${x} ${y2}`);
        
        return false;
    }

    /**
     * Find all interactive elements on the right side of the screen
     * that form the vertical icon column (like, comment, save, share).
     * 
     * This is more comprehensive than just looking for numeric content-desc.
     * It finds ImageView/ImageButton elements in the right ~20% of screen,
     * with reasonable icon sizes, sorted top to bottom.
     */
    static _findRightSideIcons(xml, worker) {
        if (!xml) return [];
        const W = worker.screenWidth;
        const H = worker.screenHeight;
        
        // Match ImageView and ImageButton elements on the right side
        const iconRegex = /(<node[^>]*class="android\.widget\.(ImageView|ImageButton)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*>)/g;
        let match;
        const icons = [];
        
        while ((match = iconRegex.exec(xml)) !== null) {
            const node = match[1];
            const x1 = parseInt(match[3]), y1 = parseInt(match[4]);
            const x2 = parseInt(match[5]), y2 = parseInt(match[6]);
            const cx = Math.round((x1 + x2) / 2);
            const cy = Math.round((y1 + y2) / 2);
            const w = x2 - x1;
            const h = y2 - y1;
            
            // Right side (>75% width), reasonable size, in the middle vertical area
            // IMPORTANT: cy > 43% to exclude avatar/profile button
            if (cx > W * 0.75 && cx < W * 0.99 &&
                cy > H * 0.43 && cy < H * 0.85 &&
                w > 15 && w < W * 0.18 &&
                h > 15 && h < H * 0.08) {
                
                const descMatch = node.match(/content-desc="([^"]*)"/);
                const desc = descMatch ? descMatch[1] : '';
                const clickable = /clickable="true"/.test(node);
                
                icons.push({ x: cx, y: cy, w, h, desc, clickable, type: match[2] });
            }
        }
        
        if (icons.length < 3) return [];
        
        // Sort by Y (top to bottom)
        icons.sort((a, b) => a.y - b.y);
        
        // Group icons that are close together vertically (within ~15% of screen height apart)
        // to filter out unrelated elements
        const maxGap = H * 0.15;
        const groups = [];
        let currentGroup = [icons[0]];
        
        for (let i = 1; i < icons.length; i++) {
            if (icons[i].y - icons[i - 1].y < maxGap) {
                currentGroup.push(icons[i]);
            } else {
                if (currentGroup.length >= 3) groups.push([...currentGroup]);
                currentGroup = [icons[i]];
            }
        }
        if (currentGroup.length >= 3) groups.push(currentGroup);
        
        // Return the largest group (most likely the action icon column)
        if (groups.length === 0) return [];
        groups.sort((a, b) => b.length - a.length);
        return groups[0];
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
