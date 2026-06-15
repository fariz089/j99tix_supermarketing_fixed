/**
 * device-diagnostic.js  (READ-ONLY)
 * -------------------------------------------------------------
 * Tujuan: cari tahu KENAPA sebagian device terhitung di live view
 * dan sebagian tidak — dengan membandingkan properti sistem,
 * versi TikTok, dan status Google Play Services antar device.
 *
 * Script ini TIDAK mengubah apa pun di device. Hanya membaca.
 *
 * Cara pakai:
 *   node device-diagnostic.js
 *   node device-diagnostic.js 192.168.1.214:5555 192.168.1.193:5555
 *
 * Kalau argumen kosong, dia baca semua device dari devices.json.
 * Output: tabel ringkas di terminal + file device-diagnostic-report.json
 * -------------------------------------------------------------
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const TIKTOK_PACKAGES = [
    'com.ss.android.ugc.trill',       // TikTok global
    'com.zhiliaoapp.musically',       // TikTok (musically)
    'com.ss.android.ugc.aweme'        // Douyin / sebagian region
];

// Properti yang paling relevan untuk identitas device & integritas.
const PROP_KEYS = [
    'ro.product.model',
    'ro.product.brand',
    'ro.product.manufacturer',
    'ro.product.device',
    'ro.build.version.release',   // versi Android
    'ro.build.version.sdk',       // API level
    'ro.build.fingerprint',
    'ro.boot.verifiedbootstate',  // green = terkunci, orange = unlocked
    'ro.build.type'               // user / userdebug
];

function adb(deviceId, args, timeout = 8000) {
    return new Promise((resolve) => {
        execFile('adb', ['-s', deviceId, ...args], { timeout, windowsHide: true }, (err, stdout) => {
            if (err) return resolve({ ok: false, out: '', err: err.message });
            resolve({ ok: true, out: (stdout || '').trim(), err: null });
        });
    });
}

async function getProp(deviceId, key) {
    const r = await adb(deviceId, ['shell', 'getprop', key]);
    return r.ok ? r.out : '(?)';
}

async function getTikTokInfo(deviceId) {
    for (const pkg of TIKTOK_PACKAGES) {
        const r = await adb(deviceId, ['shell', 'dumpsys', 'package', pkg]);
        if (r.ok && r.out.includes('versionName')) {
            const m = r.out.match(/versionName=([^\s]+)/);
            const c = r.out.match(/versionCode=(\d+)/);
            return {
                package: pkg,
                versionName: m ? m[1] : '(?)',
                versionCode: c ? c[1] : '(?)'
            };
        }
    }
    return { package: '(none installed)', versionName: '-', versionCode: '-' };
}

async function getGmsInfo(deviceId) {
    // Versi Google Play Services — kalau usang / tidak ada, integritas sering gagal.
    const r = await adb(deviceId, ['shell', 'dumpsys', 'package', 'com.google.android.gms']);
    if (r.ok && r.out.includes('versionName')) {
        const m = r.out.match(/versionName=([^\s]+)/);
        return m ? m[1] : '(installed, version unknown)';
    }
    return '(GMS not found)';
}

async function isOnline(deviceId) {
    const r = await adb(deviceId, ['get-state'], 4000);
    return r.ok && r.out === 'device';
}

function loadDevices(args) {
    if (args.length > 0) {
        return args.map((d, i) => ({ device: d, model: '(arg)', manufacturer: '(arg)', number: i + 1 }));
    }
    const p = path.join(__dirname, 'devices.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function inspectOne(d) {
    const deviceId = d.device;
    const online = await isOnline(deviceId);
    if (!online) {
        return { ...d, online: false };
    }

    const props = {};
    for (const k of PROP_KEYS) {
        props[k] = await getProp(deviceId, k);
    }
    const tiktok = await getTikTokInfo(deviceId);
    const gms = await getGmsInfo(deviceId);

    return {
        number: d.number,
        device: deviceId,
        labelModel: d.model,
        online: true,
        model: props['ro.product.model'],
        brand: props['ro.product.brand'],
        manufacturer: props['ro.product.manufacturer'],
        androidRelease: props['ro.build.version.release'],
        sdk: props['ro.build.version.sdk'],
        verifiedBoot: props['ro.boot.verifiedbootstate'],
        buildType: props['ro.build.type'],
        fingerprint: props['ro.build.fingerprint'],
        tiktokPackage: tiktok.package,
        tiktokVersion: tiktok.versionName,
        tiktokVersionCode: tiktok.versionCode,
        gmsVersion: gms
    };
}

function pad(s, n) {
    s = String(s == null ? '' : s);
    return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

(async () => {
    const args = process.argv.slice(2);
    const devices = loadDevices(args);

    console.log(`\n🔍 Diagnostic READ-ONLY untuk ${devices.length} device. Tidak ada perubahan yang dilakukan ke device.\n`);

    const results = [];
    // Proses sekuensial biar ADB server tidak kebanjiran.
    for (const d of devices) {
        process.stdout.write(`   • ${d.device} (label: ${d.model}) ... `);
        try {
            const info = await inspectOne(d);
            results.push(info);
            console.log(info.online ? 'OK' : 'OFFLINE');
        } catch (e) {
            results.push({ ...d, online: false, error: e.message });
            console.log('ERROR: ' + e.message);
        }
    }

    const online = results.filter(r => r.online);

    // ---- Tabel ringkas ----
    console.log('\n================ RINGKASAN ================\n');
    console.log(
        pad('#', 4) + pad('Model (asli)', 16) + pad('Android', 9) +
        pad('Boot', 8) + pad('Build', 11) + pad('TikTok ver', 16) + pad('GMS', 18)
    );
    console.log('-'.repeat(82));
    for (const r of online) {
        console.log(
            pad(r.number, 4) +
            pad(r.model, 16) +
            pad(r.androidRelease, 9) +
            pad(r.verifiedBoot, 8) +
            pad(r.buildType, 11) +
            pad(r.tiktokVersion, 16) +
            pad(r.gmsVersion, 18)
        );
    }

    // ---- Analisis perbedaan per kelompok model ----
    console.log('\n================ ANALISIS PERBEDAAN ================\n');

    const groups = {};
    for (const r of online) {
        const key = r.model || '(unknown)';
        (groups[key] = groups[key] || []).push(r);
    }

    const summarize = (arr, field) => {
        const set = [...new Set(arr.map(x => x[field]))];
        return set.join(' | ');
    };

    for (const [model, arr] of Object.entries(groups)) {
        console.log(`📦 ${model}  (${arr.length} device)`);
        console.log(`   Android       : ${summarize(arr, 'androidRelease')} (SDK ${summarize(arr, 'sdk')})`);
        console.log(`   verifiedBoot  : ${summarize(arr, 'verifiedBoot')}`);
        console.log(`   build.type    : ${summarize(arr, 'buildType')}`);
        console.log(`   TikTok pkg    : ${summarize(arr, 'tiktokPackage')}`);
        console.log(`   TikTok ver    : ${summarize(arr, 'tiktokVersion')} (code ${summarize(arr, 'tiktokVersionCode')})`);
        console.log(`   GMS           : ${summarize(arr, 'gmsVersion')}`);
        console.log('');
    }

    // ---- Petunjuk membaca hasil ----
    console.log('================ CARA BACA ================\n');
    console.log('Bandingkan baris kelompok yang TERHITUNG (PDEM10) vs yang TIDAK (SM-G973F / SM-G975F).');
    console.log('Perhatikan kolom yang BERBEDA antar kelompok — itu kandidat penyebabnya:');
    console.log('  • TikTok ver / pkg berbeda  → coba samakan versi APK-nya, tes ulang.');
    console.log('  • GMS jauh lebih tua / "(GMS not found)" pada Samsung → integritas device kemungkinan gagal.');
    console.log('  • build.type = userdebug, atau verifiedBoot = orange → device dianggap tidak tepercaya.');
    console.log('  • Android/SDK beda jauh → perilaku player/heartbeat bisa beda.');
    console.log('\nKalau yang berbeda hanya GMS/boot/build (bukan versi TikTok), penyebabnya adalah');
    console.log('INTEGRITAS DEVICE, bukan nama model — jadi mengganti label tidak akan membantu.\n');

    const outPath = path.join(__dirname, 'device-diagnostic-report.json');
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`📄 Laporan lengkap tersimpan: ${outPath}\n`);
})();
