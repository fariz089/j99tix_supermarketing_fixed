@echo off
REM Deteksi package TikTok yang terpasang di device.
REM Double-click file ini, atau jalankan: detect-tiktok-package.bat 192.168.1.193:5555
node "%~dp0detect-tiktok-package.js" %1
echo.
pause
