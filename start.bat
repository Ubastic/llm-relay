@echo off
chcp 65001 >nul
cd /d %~dp0
node server.js
timeout /t 1 >nul
start "" http://localhost:18788
