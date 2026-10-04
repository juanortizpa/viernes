@echo off
cd /d "%~dp0"
node scripts\island.mjs %*
if errorlevel 1 pause
