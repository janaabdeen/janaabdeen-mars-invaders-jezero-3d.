@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
if not exist node_modules call npm install
call npm run prep
if errorlevel 1 (echo. & echo Data preparation failed - see message above. & pause & exit /b 1)
call npm run dev -- --open
pause
