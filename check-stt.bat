@echo off
cd /d "%~dp0"
node scripts\bench.mjs %*
pause
