@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js n est pas installe. Installe la version LTS puis relance ce fichier.
  start "" https://nodejs.org
  pause
  exit /b
)
set PORT=3001
echo Demarrage... NE FERME PAS cette fenetre tant que tu joues.
echo Adresse : http://localhost:3001/host
start "" /b powershell -NoProfile -Command "Start-Sleep 3; Start-Process 'http://localhost:3001/host'"
npm start
pause
