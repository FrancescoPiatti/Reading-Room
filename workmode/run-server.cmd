@echo off
REM ===========================================================================
REM Reading Room - server runner (Windows). ReadingRoom.bat starts this hidden;
REM you can also double-click it to run the server in a visible console.
REM
REM Runs the server and relaunches it when it exits with code 75 - the
REM "restart me" code the in-app updater uses after installing a new version.
REM ANY other exit code ends the loop: a normal quit (the app window closed), a
REM crash, or node missing (9009) - so this can never spin hot.
REM
REM The loop is ONE parenthesised block on purpose: cmd.exe reads a batch file
REM incrementally by byte offset, so if an update rewrote this file while the
REM old loop was running, a line-by-line loop would resume mid-line in the NEW
REM file and die. A block is parsed in full before it runs, so the relaunch
REM survives an update of this very file.
REM
REM The relaunched server gets RR_NO_OPEN=1: the page that asked for the restart
REM stays open and reloads itself, so a second app window must not appear.
REM RR_LAUNCHER=1 tells the server a loop is here, so the in-app "Restart now"
REM is offered (a bare `npm start` has no loop and is told to restart by hand).
REM The log is truncated once per launch and appended to across restarts.
REM ===========================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
set "RR_NO_OPEN="
set "RR_LAUNCHER=1"
type nul > workmode.log
for /l %%i in (1,0,2) do (
  node server.js >> workmode.log 2>&1
  if not "!errorlevel!"=="75" exit /b !errorlevel!
  set "RR_NO_OPEN=1"
)
