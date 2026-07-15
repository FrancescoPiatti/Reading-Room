@echo off
REM ===========================================================================
REM Reading Room - double-click launcher (Windows).
REM Starts the local "work mode" server IN THE BACKGROUND (hidden) and opens the
REM app window, then this console closes. The static GitHub Pages browse path is
REM unaffected; this only runs things locally.
REM
REM The server runs headless - close the app window to stop it (it auto-quits a
REM few seconds after the last window closes). Logs go to workmode\workmode.log.
REM ===========================================================================
setlocal
cd /d "%~dp0"

echo.
echo   Reading Room - starting work mode...

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   X  Node.js is required for work mode but was not found.
  echo      Install it from https://nodejs.org/ then run this again.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do echo   node %%v

REM Require Node 18+ up front - a too-old Node fails cryptically mid-install.
set "NODE_MAJOR="
for /f "tokens=1 delims=v." %%m in ('node -v') do set "NODE_MAJOR=%%m"
if not defined NODE_MAJOR set "NODE_MAJOR=0"
if %NODE_MAJOR% LSS 18 (
  echo.
  echo   X  Work mode needs Node.js 18 or newer.
  echo      Update it from https://nodejs.org/ then run this again.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

if not exist "workmode\node_modules" (
  echo   Installing work-mode dependencies ^(first run only - may take a minute^)...
  pushd workmode
  call npm install
  if errorlevel 1 (
    echo.
    echo   X  npm install failed. See the messages above.
    popd
    pause
    exit /b 1
  )
  popd
)

REM Start the server hidden + detached so closing this console doesn't kill it.
REM The server opens the app window itself and auto-quits when that window closes.
echo   Starting the server in the background...  (logs: workmode\workmode.log)
powershell -NoProfile -Command "Start-Process -FilePath 'cmd' -ArgumentList '/c node server.js > workmode.log 2>&1' -WorkingDirectory '%CD%\workmode' -WindowStyle Hidden"

REM First run only: offer a desktop shortcut (Yes = Desktop, No = pick a folder,
REM Cancel = skip). One-shot, remembered under the gitignored user\ folder.
if not exist "user" mkdir user
if not exist "user\.desktop-shortcut-offered" (
  type nul > "user\.desktop-shortcut-offered"
  set "RR_ROOT=%CD%"
  powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $r=[System.Windows.Forms.MessageBox]::Show('Add a Reading Room shortcut to your Desktop?'+[Environment]::NewLine+[Environment]::NewLine+'Yes: add to Desktop    No: choose a folder    Cancel: skip','Reading Room',[System.Windows.Forms.MessageBoxButtons]::YesNoCancel,[System.Windows.Forms.MessageBoxIcon]::Question); $dest=$null; if($r -eq 'Yes'){$dest=[Environment]::GetFolderPath('Desktop')} elseif($r -eq 'No'){$fb=New-Object System.Windows.Forms.FolderBrowserDialog; $fb.Description='Where should the Reading Room shortcut go?'; if($fb.ShowDialog() -eq 'OK'){$dest=$fb.SelectedPath}}; if($dest){$ws=New-Object -ComObject WScript.Shell; $lnk=$ws.CreateShortcut((Join-Path $dest 'Reading Room.lnk')); $lnk.TargetPath=(Join-Path $env:RR_ROOT 'ReadingRoom.bat'); $lnk.WorkingDirectory=$env:RR_ROOT; $ico=(Join-Path $env:RR_ROOT 'assets\ReadingRoom.ico'); if(Test-Path $ico){$lnk.IconLocation=$ico}; $lnk.Save()}"
)

REM Give it a moment to bind + open the app window, then let this console close.
timeout /t 2 /nobreak >nul
exit /b 0
