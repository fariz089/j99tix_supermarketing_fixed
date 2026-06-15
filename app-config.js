// ============================================================
// app-config.js
// SUMBER KEBENARAN TUNGGAL untuk package TikTok yang dipakai.
//
// Di sinilah perbedaan antara "TikTok Biasa" dan "TikTok Lite"
// didefinisikan. Semua file lain (main.js, Worker, UIHelper,
// boostlive, profileboost) mengambil nilai package dari sini —
// TIDAK ADA package name yang di-hardcode di tempat lain lagi.
//
// Cara kerja:
//   - Pilihan disimpan di file app-selection.json (persisten).
//   - UI (index.html) mengubah pilihan via IPC 'set-target-app'.
//   - Saat job dijalankan, Worker membaca package aktif dari sini.
// ============================================================

const fs = require('fs');
const path = require('path');

const SELECTION_FILE = path.join(__dirname, 'app-selection.json');

// --- Definisi tiap varian aplikasi ---------------------------------
// resIdPrefixes: dipakai boostlive/profileboost untuk mencocokkan
// resource-id di UIAutomator dump. Disediakan beberapa kemungkinan
// karena tergantung region/build.
const APPS = {
    regular: {
        id: 'regular',
        label: 'TikTok Biasa',
        // Activity utama untuk am start
        package: 'com.ss.android.ugc.trill',
        mainActivity: 'com.ss.android.ugc.trill.MainActivity',
        // Package alternatif (region berbeda memakai musically). Dipakai
        // hanya untuk deteksi "apakah ini TikTok" (bukan untuk am start).
        detectPackages: [
            'com.ss.android.ugc.trill',
            'com.zhiliaoapp.musically',
            'com.ss.android.ugc.aweme'
        ],
        resIdPrefixes: [
            'com.ss.android.ugc.trill',
            'com.zhiliaoapp.musically',
            'com.ss.android.ugc.aweme'
        ],
    },
    lite: {
        id: 'lite',
        label: 'TikTok Lite',
        // Package Lite yang sebenarnya terpasang: com.zhiliaoapp.musically.go
        // (terdeteksi via detect-tiktok-package.js). Lite ini MENANGANI deeplink
        // web tiktok.com, jadi openUrl bisa langsung buka video.
        package: 'com.zhiliaoapp.musically.go',
        // Launch activity terdeteksi: .mini.MainActivity
        mainActivity: 'com.zhiliaoapp.musically.go.mini.MainActivity',
        detectPackages: [
            'com.zhiliaoapp.musically.go',
            'com.ss.android.ugc.aweme.lite',
            'com.ss.android.ugc.trill.go',
        ],
        // Resource-id Lite (musically.go) memakai prefix yang sama dgn package,
        // namun internal sering tetap pakai com.ss.android.ugc.aweme. Sertakan
        // keduanya supaya deteksi elemen UI tidak meleset.
        resIdPrefixes: [
            'com.zhiliaoapp.musically.go',
            'com.ss.android.ugc.aweme',
        ],
    },
};

const DEFAULT_APP = 'regular';

// Kandidat package untuk tiap varian — dipakai resolver untuk mencari
// package mana yang BENAR-BENAR terpasang di device.
const PACKAGE_CANDIDATES = {
    regular: ['com.ss.android.ugc.trill', 'com.zhiliaoapp.musically'],
    lite: ['com.zhiliaoapp.musically.go', 'com.ss.android.ugc.aweme.lite', 'com.ss.android.ugc.trill.go'],
};

// State di-memori. Di-load sekali saat module pertama di-require.
let _currentId = _loadSelection();

function _loadSelection() {
    try {
        if (fs.existsSync(SELECTION_FILE)) {
            const raw = JSON.parse(fs.readFileSync(SELECTION_FILE, 'utf8'));
            if (raw && raw.app && APPS[raw.app]) return raw.app;
        }
    } catch (e) {
        console.warn('[app-config] gagal baca app-selection.json:', e.message);
    }
    return DEFAULT_APP;
}

function _saveSelection(id) {
    try {
        fs.writeFileSync(SELECTION_FILE, JSON.stringify({ app: id }, null, 2), 'utf8');
    } catch (e) {
        console.warn('[app-config] gagal simpan app-selection.json:', e.message);
    }
}

/** Set aplikasi target. Mengembalikan config aktif yang baru. */
function setTargetApp(id) {
    if (!APPS[id]) throw new Error(`Unknown target app: ${id}`);
    _currentId = id;
    _saveSelection(id);
    console.log(`[app-config] Target app di-set ke: ${APPS[id].label} (${APPS[id].package})`);
    return APPS[id];
}

/** Ambil config aplikasi yang sedang aktif. */
function getActiveApp() {
    return APPS[_currentId] || APPS[DEFAULT_APP];
}

/** Daftar semua app untuk dropdown UI. */
function listApps() {
    return Object.values(APPS).map(a => ({ id: a.id, label: a.label, package: a.package }));
}

// --- Helper cepat yang dipakai di banyak tempat --------------------
function pkg() { return getActiveApp().package; }
function mainActivity() { return getActiveApp().mainActivity; }

/**
 * Regex (sebagai string) yang cocok dengan resource-id app aktif.
 * Contoh hasil: "com\.ss\.android\.ugc\.aweme\.lite"
 * Dipakai untuk membangun regex deteksi elemen UI.
 */
function resIdPattern() {
    const prefixes = getActiveApp().resIdPrefixes;
    return '(?:' + prefixes.map(p => p.replace(/\./g, '\\.')).join('|') + ')';
}

/** RegExp untuk mendeteksi apakah foreground adalah TikTok target. */
function detectRegex() {
    const prefixes = getActiveApp().detectPackages;
    return new RegExp(prefixes.map(p => p.replace(/\./g, '\\.')).join('|'), 'i');
}

/**
 * Resolusi package yang BENAR-BENAR terpasang di device tertentu.
 * Berguna karena package Lite bisa berbeda (aweme.lite vs trill.go) &
 * package biasa bisa trill atau musically tergantung region.
 *
 * worker: objek DeviceWorker (punya execAdb).
 * Mengembalikan nama package yang terpasang, atau null kalau tidak ketemu.
 * Kalau ketemu & beda dari default, package aktif di-override untuk worker
 * tersebut via worker._resolvedPackage (tidak mengubah global selection).
 */
async function resolveInstalledPackage(worker) {
    const activeId = getActiveApp().id;
    const candidates = PACKAGE_CANDIDATES[activeId] || [getActiveApp().package];
    for (const cand of candidates) {
        try {
            const out = await worker.execAdb(`shell pm list packages ${cand}`);
            if (out && out.includes(cand)) {
                worker._resolvedPackage = cand;
                worker._packageInstalled = true;
                if (cand !== getActiveApp().package) {
                    console.log(`[${worker.deviceId}] 📦 Package terpasang: ${cand} (default: ${getActiveApp().package})`);
                }
                return cand;
            }
        } catch (e) { /* lanjut kandidat berikutnya */ }
    }
    worker._packageInstalled = false;
    console.log(`[${worker.deviceId}] ⚠️ Tidak menemukan package ${activeId} terpasang. Kandidat dicoba: ${candidates.join(', ')}`);
    return null;
}

/** Package efektif untuk worker (hasil resolve kalau ada, else default global). */
function pkgFor(worker) {
    return (worker && worker._resolvedPackage) ? worker._resolvedPackage : pkg();
}

module.exports = {
    APPS,
    PACKAGE_CANDIDATES,
    setTargetApp,
    getActiveApp,
    listApps,
    pkg,
    pkgFor,
    mainActivity,
    resIdPattern,
    detectRegex,
    resolveInstalledPackage,
};
