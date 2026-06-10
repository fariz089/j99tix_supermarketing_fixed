/**
 * SessionManager.js - Session Token & Device ID Rotation
 * Manages per-cycle session rotation dan device fingerprinting
 */

const crypto = require('crypto');

class SessionManager {
  constructor(accountId = 'default_account') {
    this.accountId = accountId;
    this.cycleCount = 0;
    this.sessionState = {
      accountId: accountId,
      cycleCount: 0,
      currentSessionToken: null,
      deviceFingerprint: null,
      cookies: {
        persistent: new Map(),
        session: new Map()
      },
      rotationHistory: [],
      lastRotation: null
    };
    
    // Initialize first session
    this.rotateSession();
  }

  /**
   * Generate unique session token untuk cycle ini
   */
  generateSessionToken() {
    const timestamp = Date.now();
    const randomBytes = crypto.randomBytes(16).toString('hex');
    const combined = `${timestamp}_${randomBytes}`;
    const hash = crypto
      .createHash('sha256')
      .update(combined)
      .digest('hex')
      .substring(0, 16);
    
    return `sess_${timestamp}_${hash}`;
  }

  /**
   * Generate device fingerprint yang berubah setiap cycle
   */
  generateDeviceFingerprint() {
    const cycleHash = crypto
      .createHash('sha256')
      .update(`${this.accountId}_cycle_${this.cycleCount}`)
      .digest('hex');

    return {
      hash: cycleHash.substring(0, 24),
      cycleGenerated: this.cycleCount,
      timestamp: Date.now(),
      // Pseudo-random device properties
      androidId: this.generateAndroidId(),
      serialNumber: this.generateSerialNumber(),
      buildFingerprint: this.generateBuildFingerprint(),
      advertisingId: this.generateAdvertisingId()
    };
  }

  /**
   * Generate pseudo-random Android ID
   */
  generateAndroidId() {
    const random = crypto.randomBytes(8);
    return random.toString('hex').toUpperCase();
  }

  /**
   * Generate pseudo-random serial number
   */
  generateSerialNumber() {
    const prefix = 'SM';
    const random = crypto.randomBytes(6).toString('hex').toUpperCase();
    return `${prefix}${random}`;
  }

  /**
   * Generate realistic build fingerprint
   */
  generateBuildFingerprint() {
    const manufacturers = ['samsung', 'xiaomi', 'oppo', 'vivo'];
    const devices = ['M21S', 'A52', 'A72', 'Note10'];
    const androidVersions = ['12', '13', '14'];
    
    const mfg = manufacturers[Math.floor(Math.random() * manufacturers.length)];
    const device = devices[Math.floor(Math.random() * devices.length)];
    const androidVer = androidVersions[Math.floor(Math.random() * androidVersions.length)];
    const buildId = crypto.randomBytes(4).toString('hex').toUpperCase();
    
    return `${mfg}/${device}:${androidVer}/TP1A.${buildId}/buildid`;
  }

  /**
   * Generate Google Advertising ID
   */
  generateAdvertisingId() {
    const buf = crypto.randomBytes(16);
    return [
      buf.slice(0, 4).toString('hex'),
      buf.slice(4, 6).toString('hex'),
      buf.slice(6, 8).toString('hex'),
      buf.slice(8, 10).toString('hex'),
      buf.slice(10, 16).toString('hex')
    ].join('-').toUpperCase();
  }

  /**
   * Rotate session & device fingerprint setiap cycle
   */
  rotateSession() {
    this.cycleCount++;
    
    const oldSession = this.sessionState.currentSessionToken;
    const newSession = this.generateSessionToken();
    const newFingerprint = this.generateDeviceFingerprint();

    // Clear session cookies (persistent cookies tetap)
    this.sessionState.cookies.session.clear();

    // Update state
    this.sessionState.cycleCount = this.cycleCount;
    this.sessionState.currentSessionToken = newSession;
    this.sessionState.deviceFingerprint = newFingerprint;
    this.sessionState.lastRotation = Date.now();

    // Log rotation untuk audit trail
    this.sessionState.rotationHistory.push({
      cycle: this.cycleCount,
      sessionFrom: oldSession ? oldSession.substring(0, 20) + '...' : 'none',
      sessionTo: newSession.substring(0, 20) + '...',
      fingerprintHash: newFingerprint.hash,
      timestamp: Date.now()
    });

    // Keep only last 100 rotations untuk memory efficiency
    if (this.sessionState.rotationHistory.length > 100) {
      this.sessionState.rotationHistory.shift();
    }

    return {
      sessionToken: newSession,
      fingerprint: newFingerprint,
      cycle: this.cycleCount
    };
  }

  /**
   * Set persistent cookie (survives across cycles)
   */
  setPersistentCookie(name, value, options = {}) {
    const cookie = {
      name,
      value,
      domain: options.domain || '.example.com',
      path: options.path || '/',
      expires: options.expires || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      httpOnly: options.httpOnly !== false,
      secure: options.secure !== false,
      sameSite: options.sameSite || 'Lax',
      createdAt: Date.now()
    };

    this.sessionState.cookies.persistent.set(name, cookie);
    return cookie;
  }

  /**
   * Set session cookie (cleared per cycle)
   */
  setSessionCookie(name, value, options = {}) {
    const cookie = {
      name,
      value,
      domain: options.domain || '.example.com',
      path: options.path || '/',
      httpOnly: options.httpOnly !== false,
      secure: options.secure !== false,
      sameSite: options.sameSite || 'Lax',
      createdAt: Date.now()
    };

    this.sessionState.cookies.session.set(name, cookie);
    return cookie;
  }

  /**
   * Get all cookies dalam format HTTP header
   */
  getCookieHeader() {
    const allCookies = [
      ...this.sessionState.cookies.persistent.values(),
      ...this.sessionState.cookies.session.values()
    ];

    return allCookies
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
  }

  /**
   * Get current session state
   */
  getSessionState() {
    return {
      accountId: this.sessionState.accountId,
      cycleCount: this.sessionState.cycleCount,
      currentSessionToken: this.sessionState.currentSessionToken,
      deviceFingerprint: this.sessionState.deviceFingerprint,
      persistentCookieCount: this.sessionState.cookies.persistent.size,
      sessionCookieCount: this.sessionState.cookies.session.size,
      lastRotation: this.sessionState.lastRotation,
      rotationHistorySize: this.sessionState.rotationHistory.length
    };
  }

  /**
   * Export complete state untuk persistence
   */
  exportState() {
    return {
      accountId: this.sessionState.accountId,
      cycleCount: this.sessionState.cycleCount,
      sessionToken: this.sessionState.currentSessionToken,
      fingerprint: this.sessionState.deviceFingerprint,
      persistentCookies: Array.from(this.sessionState.cookies.persistent.values()),
      rotationCount: this.sessionState.rotationHistory.length,
      lastRotation: this.sessionState.lastRotation
    };
  }

  /**
   * Import state dari file persistence
   */
  importState(state) {
    if (state.accountId) this.sessionState.accountId = state.accountId;
    if (state.cycleCount) this.cycleCount = state.cycleCount;
    if (state.sessionToken) this.sessionState.currentSessionToken = state.sessionToken;
    if (state.fingerprint) this.sessionState.deviceFingerprint = state.fingerprint;
    
    if (state.persistentCookies) {
      state.persistentCookies.forEach(cookie => {
        this.sessionState.cookies.persistent.set(cookie.name, cookie);
      });
    }

    return true;
  }
}

module.exports = SessionManager;
