# @iaconpatrick Dashboard v2.0

## Cómo usarlo (2 minutos)

### Requisitos
- Node.js instalado (https://nodejs.org — versión 16 o superior)
- Cuenta en Apify (https://apify.com) — plan gratis

### Pasos

**1. Abre una terminal en esta carpeta**

```bash
cd iaconpatrick-dashboard
```

**2. Arranca el servidor**

```bash
node server.js
```

Verás esto:
```
  ╔══════════════════════════════════════╗
  ║   @iaconpatrick Dashboard v2.0       ║
  ║   SISTEMA ONLINE                     ║
  ╠══════════════════════════════════════╣
  ║   URL: http://localhost:3000         ║
  ║   Ctrl+C para parar                  ║
  ╚══════════════════════════════════════╝
```

**3. Abre el navegador en http://localhost:3000**

**4. Ve a Configurar en el dashboard**
- Pega tu Apify API Token (Settings → Integrations en apify.com)
- Pulsa "Probar Conexión"
- Cuando salga ✓, pulsa ↻ SYNC en el header

---

## Por qué necesitas el servidor

Los navegadores bloquean llamadas directas a APIs externas (CORS) cuando el archivo
se abre como `file://`. El servidor actúa de intermediario: el browser habla con
`localhost:3000`, y el servidor habla con `api.apify.com` sin restricciones.

## APIs necesarias

| API | Para qué | Dónde conseguirla |
|-----|----------|-------------------|
| Apify Token | Scraping TikTok + Instagram | apify.com → Settings → Integrations |
| Anthropic Key (opcional) | Generar ideas con Claude | console.anthropic.com → API Keys |

## Coste estimado (Apify plan gratis)

- $5 créditos/mes gratis
- 1 sync completo (TikTok + Instagram + Trending) ≈ $0.10–0.30
- Con el plan gratis: 15–50 syncs al mes
