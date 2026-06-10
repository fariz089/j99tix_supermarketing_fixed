/**
 * DeviceRotationHelper.js - ADB Device Rotation Integration
 * Rotates device properties via ADB setiap cycle
 */

const { execSync } = require('child_process');

class DeviceRotationHelper {
  constructor(adbPath = 'adb') {
    this.adbPath = adbPath;
    this.rotationLog = [];
    this.currentDeviceId = null;
  }

  /**
   * Get connected ADB device ID
   */
  getConnectedDevice() {
    try {
      const output = execSync(`${this.adbPath} devices`, { encoding: 'utf8' });
      const lines = output.split('\n').filter(l => l.trim());
      
      for (let line of lines) {
        if (line.includes('device') && !line.includes('List')) {
          const deviceId = line.split('\t')[0].trim();
          if (deviceId && deviceId !== 'device') {
            this.currentDeviceId = deviceId;
            return deviceId;
          }
        }
      }
    } catch (err) {
      console.warn('⚠️ ADB not available or no device connected');
      return null;
    }
  }

  /**
   * Rotate device properties via ADB shell setprop
   */
  rotateDeviceProperties(fingerprint) {
    const device = this.getConnectedDevice();
    if (!device) {
      console.warn('⚠️ No ADB device, skipping rotation');
      return {
        success: false,
        reason: 'No device connected',
        fingerprint: fingerprint
      };
    }

    const rotations = [];
    const errors = [];

    try {
      // Rotate Build Fingerprint
      this.executeAdbShell(device, `setprop ro.build.fingerprint "${fingerprint.buildFingerprint}"`);
      rotations.push('Build Fingerprint');
    } catch (err) {
      errors.push(`Build Fingerprint: ${err.message}`);
    }

    try {
      // Rotate Android ID (requires root)
      this.executeAdbShell(device, `setprop ro.android_id ${fingerprint.androidId}`);
      rotations.push('Android ID');
    } catch (err) {
      errors.push(`Android ID: ${err.message}`);
    }

    try {
      // Rotate Serial Number
      this.executeAdbShell(device, `setprop ro.serialno ${fingerprint.serialNumber}`);
      rotations.push('Serial Number');
    } catch (err) {
      errors.push(`Serial Number: ${err.message}`);
    }

    try {
      // Rotate Board Info
      this.executeAdbShell(device, `setprop ro.board.platform ${this.generateBoardPlatform()}`);
      rotations.push('Board Platform');
    } catch (err) {
      errors.push(`Board Platform: ${err.message}`);
    }

    try {
      // Rotate Display DPI
      const dpi = this.generateRandomDPI();
      this.executeAdbShell(device, `setprop ro.sf.lcd_density ${dpi}`);
      rotations.push(`Display DPI (${dpi})`);
    } catch (err) {
      errors.push(`Display DPI: ${err.message}`);
    }

    const result = {
      success: errors.length === 0,
      device: device,
      propertiesRotated: rotations,
      errors: errors.length > 0 ? errors : null,
      fingerprint: fingerprint,
      timestamp: Date.now()
    };

    this.rotationLog.push(result);
    return result;
  }

  /**
   * Execute ADB shell command safely
   */
  executeAdbShell(device, command) {
    try {
      const fullCmd = `${this.adbPath} -s ${device} shell ${command}`;
      const output = execSync(fullCmd, { 
        encoding: 'utf8',
        timeout: 5000
      });
      return output.trim();
    } catch (err) {
      throw new Error(`ADB execution failed: ${err.message}`);
    }
  }

  /**
   * Generate random board platform
   */
  generateBoardPlatform() {
    const platforms = ['qcom', 'msm8998', 'sdm845', 'sdm855', 'kona'];
    return platforms[Math.floor(Math.random() * platforms.length)];
  }

  /**
   * Generate realistic DPI value
   */
  generateRandomDPI() {
    const dpis = [240, 270, 300, 320, 360, 400, 420, 440];
    return dpis[Math.floor(Math.random() * dpis.length)];
  }

  /**
   * Verify properties after rotation
   */
  verifyProperties(device, fingerprint) {
    try {
      const buildFp = this.executeAdbShell(device, 'getprop ro.build.fingerprint');
      const androidId = this.executeAdbShell(device, 'getprop ro.android_id');
      const serial = this.executeAdbShell(device, 'getprop ro.serialno');

      return {
        verified: true,
        buildFingerprint: buildFp,
        androidId: androidId,
        serialNumber: serial,
        matchesExpected: {
          buildFingerprint: buildFp === fingerprint.buildFingerprint,
          androidId: androidId === fingerprint.androidId,
          serialNumber: serial === fingerprint.serialNumber
        }
      };
    } catch (err) {
      return {
        verified: false,
        error: err.message
      };
    }
  }

  /**
   * Reset device properties ke default
   */
  resetDeviceProperties() {
    const device = this.getConnectedDevice();
    if (!device) return { success: false, reason: 'No device' };

    try {
      const commands = [
        'setprop ro.build.fingerprint ""',
        'setprop ro.android_id ""',
        'setprop ro.serialno ""'
      ];

      commands.forEach(cmd => {
        this.executeAdbShell(device, cmd);
      });

      return {
        success: true,
        device: device,
        timestamp: Date.now()
      };
    } catch (err) {
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * Get rotation history
   */
  getRotationHistory(limit = 50) {
    return this.rotationLog.slice(-limit).map(entry => ({
      device: entry.device,
      propertiesRotated: entry.propertiesRotated,
      success: entry.success,
      timestamp: entry.timestamp
    }));
  }

  /**
   * Get rotation statistics
   */
  getStats() {
    const total = this.rotationLog.length;
    const successful = this.rotationLog.filter(e => e.success).length;
    const failed = total - successful;

    return {
      totalRotations: total,
      successfulRotations: successful,
      failedRotations: failed,
      successRate: total > 0 ? `${((successful / total) * 100).toFixed(2)}%` : 'N/A',
      currentDevice: this.currentDeviceId || 'None'
    };
  }
}

module.exports = DeviceRotationHelper;
