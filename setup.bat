@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Falta Node.js 22.13 o superior. Instalalo desde https://nodejs.org y vuelve a abrir este archivo.
  start https://nodejs.org
  pause
  exit /b 1
)
node scripts\setup.mjs %*
if errorlevel 1 (
  echo.
  echo La instalacion fallo. Copia el mensaje de arriba.
)
pause
