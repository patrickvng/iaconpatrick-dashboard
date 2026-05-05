#!/bin/bash
# ─────────────────────────────────────────────
#  Dashboard · Script de arranque para Mac
# ─────────────────────────────────────────────

cd "$(dirname "$0")"

clear
echo ""
echo "  ╔════════════════════════════════════╗"
echo "  ║     SOCIAL ANALYTICS DASHBOARD     ║"
echo "  ║          by iaconpatrick           ║"
echo "  ╚════════════════════════════════════╝"
echo ""

# ── Comprobar Node.js ──────────────────────
if ! command -v node &> /dev/null; then
  echo "  ✕ Node.js no está instalado."
  echo ""
  echo "  1. Ve a https://nodejs.org"
  echo "  2. Descarga la versión LTS (botón verde grande)"
  echo "  3. Instálala y vuelve a hacer doble clic aquí"
  echo ""
  read -p "  Pulsa Enter para abrir nodejs.org..."
  open "https://nodejs.org"
  exit 1
fi

echo "  ✓ Node.js $(node -v) detectado"

# ── Instalar dependencias (solo la primera vez) ──
if [ ! -d "node_modules" ]; then
  echo ""
  echo "  → Instalando dependencias (solo ocurre la primera vez)..."
  npm install --silent
  echo "  ✓ Dependencias instaladas"
fi

# ── Abrir el navegador tras 2 segundos ────
(sleep 2 && open "http://localhost:3000") &

echo ""
echo "  ✓ Iniciando servidor..."
echo "  ✓ El dashboard se abrirá en tu navegador"
echo ""
echo "  ⚠  Mantén esta ventana abierta mientras usas el dashboard."
echo "     Para cerrarlo, cierra esta ventana."
echo ""
echo "  ──────────────────────────────────────"
echo ""

# ── Arrancar servidor ─────────────────────
node server.js
