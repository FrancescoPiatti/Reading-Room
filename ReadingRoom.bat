@echo off
REM ===========================================================================
REM Reading Room - double-click launcher (Windows).
REM Starts the local server IN THE BACKGROUND (hidden) and the server opens the
REM app window itself; then this console closes. The static GitHub Pages browse
REM path is unaffected; this only runs things locally.
REM
REM The server is run through workmode\run-server.cmd, which relaunches it when
REM it exits with code 75 (= "restart me", used by the in-app updater) and ends
REM on any other exit code. Close the app window to stop everything (the server
REM auto-quits a few seconds after the last window closes). Logs go to
REM workmode\workmode.log.
REM ===========================================================================
setlocal
cd /d "%~dp0"
set "RR_ROOT=%CD%"

echo.
echo   Reading Room - starting...

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   X  Reading Room needs Node.js, which was not found.
  echo      Install it from https://nodejs.org/ then run this again.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do echo   node %%v

REM Python 3 is the build (scripts\build.py) - say so now, not as a broken site later.
python --version >nul 2>nul
if errorlevel 1 (
  py -3 --version >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   X  Python 3 is required but was not found.
    echo      Install it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^), then run this again.
    start "" "https://www.python.org/downloads/"
    pause
    exit /b 1
  )
)

REM Require Node 18+ up front - a too-old Node fails cryptically mid-install.
set "NODE_MAJOR="
for /f "tokens=1 delims=v." %%m in ('node -v') do set "NODE_MAJOR=%%m"
if not defined NODE_MAJOR set "NODE_MAJOR=0"
if %NODE_MAJOR% LSS 18 (
  echo.
  echo   X  Reading Room needs Node.js 18 or newer.
  echo      Update it from https://nodejs.org/ then run this again.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

if not exist "workmode\node_modules" (
  echo   Installing dependencies for Reading Room ^(first run only - may take a minute^)...
  pushd workmode
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   X  npm install failed. See the messages above.
    popd
    pause
    exit /b 1
  )
  REM node-pty is a native module; if npm's script policy skipped its build the
  REM terminal would be disabled - rebuild it explicitly in that case.
  node -e "require('node-pty')" >nul 2>&1
  if errorlevel 1 call npm rebuild node-pty
  popd
)

if not exist "workmode\run-server.cmd" (
  echo.
  echo   X  Part of the app is missing ^(workmode\run-server.cmd^). Download Reading Room again.
  pause
  exit /b 1
)

REM Start the server hidden + detached so closing this console doesn't kill it.
REM run-server.cmd keeps it alive across in-app updates (relaunch on exit 75).
REM The server opens the app window itself and auto-quits when that window closes.
echo   Starting the server in the background...  (logs: workmode\workmode.log)
powershell -NoProfile -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','run-server.cmd' -WorkingDirectory (Join-Path $env:RR_ROOT 'workmode') -WindowStyle Hidden"

REM First run only: offer a shortcut (Yes = Desktop, No = Start Menu, Cancel =
REM skip). One-shot, remembered under the gitignored user\ folder.
if not exist "user" mkdir user
if not exist "user\.desktop-shortcut-offered" (
  type nul > "user\.desktop-shortcut-offered"
  powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $r=[System.Windows.Forms.MessageBox]::Show('Add a Reading Room shortcut?'+[Environment]::NewLine+[Environment]::NewLine+'Yes: on the Desktop    No: in the Start Menu    Cancel: skip','Reading Room',[System.Windows.Forms.MessageBoxButtons]::YesNoCancel,[System.Windows.Forms.MessageBoxIcon]::Question); $dest=$null; if($r -eq 'Yes'){$dest=[Environment]::GetFolderPath('Desktop')} elseif($r -eq 'No'){$dest=[Environment]::GetFolderPath('Programs')}; if($dest){New-Item -ItemType Directory -Force -Path $dest | Out-Null; $ws=New-Object -ComObject WScript.Shell; $lnk=$ws.CreateShortcut((Join-Path $dest 'Reading Room.lnk')); $lnk.TargetPath=(Join-Path $env:RR_ROOT 'ReadingRoom.bat'); $lnk.WorkingDirectory=$env:RR_ROOT; $ico=(Join-Path $env:RR_ROOT 'assets\ReadingRoom.ico'); if(Test-Path $ico){$lnk.IconLocation=$ico}; $lnk.Save()}"
)

REM Give it a moment to bind + open the app window, then let this console close.
timeout /t 2 /nobreak >nul
exit /b 0
