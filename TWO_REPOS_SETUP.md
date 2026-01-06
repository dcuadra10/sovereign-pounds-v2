# Setup con Dos Repositorios Separados

## 🎯 Estrategia
- **Bot**: Repositorio separado → Deploy en Koyeb
- **Página Web**: Repositorio separado → Deploy en Vercel
- **Token**: Mismo token de Discord para ambos

## 📁 Estructura de Repositorios

### Repositorio 1: Bot (Koyeb)
```
heavenly-pounds-bot/
├── bot.js
├── database.js
├── deploy-commands.js
├── package.json
├── Dockerfile
├── koyeb.yaml
└── .env (local)
```

### Repositorio 2: Página Web (Vercel)
```
heavens-of-glory-web/
├── public/
│   ├── index.html
│   ├── style.css
│   ├── script.js
│   └── IMG_4145.png
├── server.js
├── vercel.json
└── package.json
```

## 🚀 Deploy del Bot en Koyeb

### Variables de Entorno en Koyeb:
```
DISCORD_TOKEN=tu_token_del_bot
GUILD_ID=tu_server_id_de_discord
DATABASE_URL=tu_url_de_base_de_datos
HEALTHCHECK_URL=tu_url_de_healthcheck (opcional)
```

### URL del Bot:
`https://heavenly-pounds-bot-xxxxx.koyeb.app`

## 🌐 Deploy de la Página Web en Vercel

### Variables de Entorno en Vercel:
```
DISCORD_TOKEN=tu_token_del_bot (mismo token)
GUILD_ID=tu_server_id_de_discord (mismo server)
BOT_API_URL=https://heavenly-pounds-bot-xxxxx.koyeb.app/api/guild-info
```

### URL de la Página:
`https://heavens-of-glory-xxxxx.vercel.app`

## 🔗 Conexión entre Bot y Web

### En la Página Web (script.js):
```javascript
// Usar variable de entorno o URL directa
const botApiUrl = process.env.BOT_API_URL || 'https://heavenly-pounds-bot-xxxxx.koyeb.app/api/guild-info';
```

### En Vercel (vercel.json):
```json
{
  "version": 2,
  "builds": [
    { "src": "server.js", "use": "@vercel/node" },
    { "src": "public/**", "use": "@vercel/static" }
  ],
  "routes": [
    { "src": "/api/(.*)", "dest": "server.js" },
    { "src": "/(.*)", "dest": "public/$1" }
  ],
  "env": {
    "DISCORD_TOKEN": "@discord_token",
    "GUILD_ID": "@guild_id",
    "BOT_API_URL": "@bot_api_url"
  }
}
```

## 📋 Pasos de Deploy

### 1. Bot en Koyeb:
1. **Crea repositorio**: `heavenly-pounds-bot`
2. **Sube archivos del bot**:
   - `bot.js`
   - `database.js`
   - `deploy-commands.js`
   - `package.json`
   - `Dockerfile`
   - `koyeb.yaml`
3. **Conecta a Koyeb**:
   - Ve a [koyeb.com](https://koyeb.com)
   - Crea nuevo servicio
   - Conecta tu repositorio
4. **Configura variables de entorno**:
   - `DISCORD_TOKEN=tu_token_del_bot`
   - `GUILD_ID=tu_server_id_de_discord`
   - `DATABASE_URL=tu_url_de_base_de_datos`
5. **Deploy** y copia la URL del bot

### 2. Página Web en Vercel:
1. **Crea repositorio**: `heavens-of-glory-web`
2. **Sube archivos de la página web**:
   - `public/` (con index.html, style.css, script.js)
   - `server.js`
   - `vercel.json`
   - `package.json`
3. **Conecta a Vercel**:
   - Ve a [vercel.com](https://vercel.com)
   - Crea nuevo proyecto
   - Conecta tu repositorio
4. **Configura variables de entorno**:
   - `DISCORD_TOKEN=tu_token_del_bot` (mismo token)
   - `GUILD_ID=tu_server_id_de_discord` (mismo server)
   - `BOT_API_URL=https://tu-bot.koyeb.app/api/guild-info`
5. **Deploy**

### 3. ¡Listo! 🎉
- El bot estará en: `https://tu-bot.koyeb.app`
- La página web estará en: `https://tu-pagina.vercel.app`
- Las estadísticas se actualizarán automáticamente cada 30 segundos

## ✅ Ventajas de Esta Estrategia

- **Separación clara**: Bot y web en repositorios independientes
- **Deploy independiente**: Puedes actualizar uno sin afectar el otro
- **Mismo token**: Un solo bot de Discord para ambos servicios
- **Escalabilidad**: Fácil de mantener y actualizar
- **Flexibilidad**: Diferentes configuraciones para cada servicio

## 🔧 Comandos Útiles

### Para el Bot:
```bash
# En el repositorio del bot
git add .
git commit -m "Update bot"
git push origin main
```

### Para la Página Web:
```bash
# En el repositorio de la página web
git add .
git commit -m "Update web page"
git push origin main
```

## 🛠️ Troubleshooting

### Si el bot no responde:
1. Verifica variables de entorno en Koyeb
2. Revisa logs en Koyeb
3. Prueba: `https://tu-bot.koyeb.app/api/guild-info`

### Si la página no carga datos:
1. Verifica `BOT_API_URL` en Vercel
2. Revisa console del navegador
3. Verifica que el bot esté online

### Si hay errores de CORS:
1. El bot ya tiene CORS configurado
2. Verifica que la URL del bot sea correcta
3. Asegúrate de que el bot esté desplegado
