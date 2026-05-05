@echo off
chcp 65001 >nul 2>&1
cls

echo.
echo   ╔════════════════════════════════════╗
echo   ║     SOCIAL ANALYTICS DASHBOARD     ║
echo   ║          by iaconpatrick           ║
echo   ╚════════════════════════════════════╝
echo.

:: ── Comprobar Node.js ──────────────────────
node --version >nul 2>&1
if %errorlevel% neq 0 (
  echo   ✕ Node.js no está instalado.
  echo.
  echo   1. Ve a https://nodejs.org
  echo   2. Descarga la version LTS ^(boton verde grande^)
  echo   3. Instalala y vuelve a hacer doble clic aqui
  echo.
  set /p open="   Pulsa Enter para abrir nodejs.org..."
  start https://nodejs.org
  exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
echo   ✓ Node.js %NODE_VER% detectado

:: ── Instalar dependencias (solo la primera vez) ──
if not exist "node_modules\" (
  echo.
  echo   Instalando dependencias ^(solo ocurre la primera vez^)...
  npm install --silent
  echo   ✓ Dependencias instaladas
)

:: ── Abrir navegador tras 2 segundos ──────
start "" /min cmd /c "timeout /t 2 >nul && start http://localhost:3000"

echo.
echo   ✓ Iniciando servidor...
echo   ✓ El dashboard se abrira en tu navegador
echo.
echo   IMPORTANTE: Mantén esta ventana abierta mientras usas el dashboard.
echo   Para cerrarlo, cierra esta ventana.
echo.
echo   ──────────────────────────────────────
echo.

:: ── Arrancar servidor ─────────────────────
node server.js
pause
