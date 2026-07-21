@echo off
REM Wrapper for Task Scheduler - runs one SuperTrend poll pass and appends output to a log.
REM Registered as the "TradingView SuperTrend Monitor" scheduled task (every 5 min).
"C:\Program Files\nodejs\node.exe" "%~dp0supertrend-monitor.js" --once >> "%~dp0..\supertrend-monitor.log" 2>&1
