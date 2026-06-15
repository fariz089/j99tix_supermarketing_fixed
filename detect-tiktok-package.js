// ============================================================
// detect-tiktok-package.js
// Diagnostik: cari tahu package TikTok APA yang terpasang di device,
// dan apakah package itu bisa menangani link video tiktok.com.
//
// Cara pakai (dari folder project):
//     node detect-tiktok-package.js
//
// Opsional, cek device tertentu:
//     node detect-tiktok-package.js 192.168.1.193:5555
//
// Script akan:
//   1. Ambil 1 device pertama yang online (atau yang Anda sebut).
//   2. List semua package yang mengandung: tiktok, aweme, trill, musically.
//   3. Untuk tiap package TikTok, tampilkan launchable activity-nya.
//   4. Tes apakah package menangani deeplink https://www.tiktok.com/...
// ============================================================

const path = require('path');
const { execSync } = require('child_process');
const fs = require('fs');

const ADB_PATH = path.join(__dirname, 'scrcpy-win64-v3.3.3', 'adb.exe');

function adb(serial, args) {
    const cmd = `"${ADB_PATH}" -s ${serial} ${args}`;
    return execSync(cmd, { timeout: 15000, windowsHide: true }).toString();
}

function getDevices() {
    try {
        const out = execSync(`"${ADB_PATH}" devices`, { timeout: 10000, windowsHide: true }).toString();
        return out.split('\n')
            .slice(1)
            .map(l => l.trim())
            .filter(l => l && l.includes('\tdevice'))
            .map(l => l.split('\t')[0]);
    } catch (e) {
        return [];
    }
}

(function main() {
    console.log('=== TikTok Package Detector ===\n');

    if (!fs.existsSync(ADB_PATH)) {
        console.error('❌ adb.exe tidak ditemukan di:', ADB_PATH);
        console.error('   Pastikan menjalankan script ini dari dalam folder project.');
        process.exit(1);
    }

    let serial = process.argv[2];
    if (!serial) {
        const devs = getDevices();
        if (devs.length === 0) {
            console.error('❌ Tidak ada device online. Cek koneksi ADB.');
            process.exit(1);
        }
        serial = devs[0];
        console.log(`Device online: ${devs.length}. Memakai device pertama: ${serial}`);
        console.log(`(Untuk cek device lain: node detect-tiktok-package.js <ip:port>)\n`);
    } else {
        console.log(`Memakai device: ${serial}\n`);
    }

    // 1. List package TikTok
    console.log('--- Package terpasang (tiktok / aweme / trill / musically) ---');
    let pkgs = [];
    try {
        const out = adb(serial, 'shell pm list packages');
        pkgs = out.split('\n')
            .map(l => l.replace('package:', '').trim())
            .filter(Boolean)
            .filter(p => /tiktok|aweme|trill|musically/i.test(p));
        if (pkgs.length === 0) {
            console.log('⚠️  TIDAK ADA package TikTok yang terpasang di device ini.');
            console.log('   → TikTok / TikTok Lite kemungkinan belum terinstal.');
        } else {
            pkgs.forEach(p => console.log('  ✓', p));
        }
    } catch (e) {
        console.error('  Error list packages:', e.message);
    }
    console.log('');

    // 2. Untuk tiap package, cari launchable activity & versi
    for (const p of pkgs) {
        console.log(`--- Detail: ${p} ---`);
        try {
            const ver = adb(serial, `shell dumpsys package ${p} | findstr versionName`);
            const v = (ver.match(/versionName=([^\s]+)/) || [])[1];
            if (v) console.log('  versionName:', v);
        } catch (e) {}
        try {
            // Launchable activity (yang dipakai untuk membuka app)
            const res = adb(serial, `shell cmd package resolve-activity --brief ${p}`);
            const act = res.split('\n').map(s => s.trim()).filter(s => s.includes('/'));
            if (act.length) console.log('  launch activity:', act[act.length - 1]);
        } catch (e) {}
        console.log('');
    }

    // 3. Tes deeplink: siapa yang menangani link video tiktok.com?
    console.log('--- Handler untuk https://www.tiktok.com/@user/video/123 ---');
    try {
        const testUrl = 'https://www.tiktok.com/@test/video/123';
        const res = adb(serial,
            `shell "cmd package query-activities -a android.intent.action.VIEW -d ${testUrl} 2>/dev/null | grep -E 'packageName|name=' | head -20"`);
        if (res.trim()) {
            console.log(res.trim());
        } else {
            console.log('  (kosong — coba metode alternatif)');
            const res2 = adb(serial, `shell "pm dump-profiles 2>/dev/null; am start -W -a android.intent.action.VIEW -d ${testUrl}"`);
            console.log(res2.trim().slice(0, 500));
        }
    } catch (e) {
        console.log('  Error tes deeplink:', e.message.slice(0, 200));
    }

    console.log('\n=== Selesai ===');
    console.log('Kirim output di atas supaya package Lite yang benar bisa ditambahkan ke app-config.js.');
})();
