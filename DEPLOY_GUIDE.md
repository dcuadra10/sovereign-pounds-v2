# Guía de Deploy - Bot en Koyeb y Web en Vercel

## 🚀 Deploy del Bot en Koyeb

### Paso 1: Preparar el Bot
✅ **Archivos necesarios ya creados:**
- `bot.js` - Tu bot principal
- `package.json` - Dependencias
- `Dockerfile` - Para containerización
- `koyeb.yaml` - Configuración de Koyeb

### Paso 2: Crear Cuenta en Koyeb
1. Ve a [koyeb.com](https://koyeb.com)
2. Regístrate con GitHub
3. Conecta tu repositorio de GitHub

### Paso 3: Crear Nuevo Servicio
1. En el dashboard de Koyeb, haz clic en "Create Service"
2. Selecciona "GitHub" como fuente
3. Elige tu repositorio "Heavenly Pounds"
4. Configura:
   - **Name**: `heavenly-pounds-bot`
   - **Build Command**: `npm install`
   - **Run Command**: `npm start`
   - **Port**: `8080`
   - **Instance Type**: `Nano` (gratis)

### Paso 4: Variables de Entorno en Koyeb
En la sección "Environment Variables", agrega:
```
DISCORD_TOKEN=tu_token_del_bot
GUILD_ID=tu_server_id_de_discord
DATABASE_URL=tu_url_de_base_de_datos
HEALTHCHECK_URL=tu_url_de_healthcheck (opcional)
```

### Paso 5: Deploy
1. Haz clic en "Deploy"
2. Espera a que termine el build
3. Tu bot estará disponible en: `https://heavenly-pounds-bot-xxxxx.koyeb.app`

---

## 🌐 Deploy de la Página Web en Vercel

### Paso 1: Preparar la Página Web
1. Asegúrate de que la carpeta `Heavens-Of-Glory-main` tenga:
   - `package.json` (si es necesario)
   - `vercel.json` (configuración de Vercel)
   - Archivos estáticos en `public/`

### Paso 2: Crear Cuenta en Vercel
1. Ve a [vercel.com](https://vercel.com)
2. Regístrate con GitHub
3. Conecta tu repositorio

### Paso 3: Crear Nuevo Proyecto
1. En el dashboard de Vercel, haz clic en "New Project"
2. Selecciona tu repositorio
3. Configura:
   - **Framework Preset**: `Other`
   - **Root Directory**: `Heavens-Of-Glory-main`
   - **Build Command**: (dejar vacío si es solo HTML/CSS/JS)
   - **Output Directory**: `public`

### Paso 4: Deploy
1. Haz clic en "Deploy"
2. Espera a que termine el build
3. Tu página estará disponible en: `https://heavens-of-glory-xxxxx.vercel.app`

---

## 🔗 Conectar Bot y Página Web

### Paso 1: Obtener URL del Bot
1. Ve a tu servicio en Koyeb
2. Copia la URL del servicio (ej: `https://heavenly-pounds-bot-xxxxx.koyeb.app`)

### Paso 2: Actualizar la Página Web
1. Edita `Heavens-Of-Glory-main/public/script.js`
2. Cambia la línea:
   ```javascript
   const botApiUrl = 'https://your-bot-name.koyeb.app/api/guild-info';
   ```
   Por:
   ```javascript
   const botApiUrl = 'https://heavenly-pounds-bot-xxxxx.koyeb.app/api/guild-info';
   ```

### Paso 3: Redesplegar la Página
1. Haz commit y push de los cambios
2. Vercel automáticamente redesplegará la página

---

## 🚀 Deploy Automatizado

### Opción 1: Script de PowerShell (Windows)
```powershell
.\deploy.ps1
```

### Opción 2: Script de Bash (Linux/Mac)
```bash
./deploy.sh
```

### Opción 3: Manual
```bash
git add .
git commit -m "Deploy: Actualización para Koyeb y Vercel"
git push origin main
```

## 📋 Checklist de Deploy

### Bot en Koyeb:
- [ ] Repositorio conectado
- [ ] Variables de entorno configuradas:
  - [ ] `DISCORD_TOKEN`
  - [ ] `GUILD_ID`
  - [ ] `DATABASE_URL`
- [ ] Build exitoso
- [ ] Bot responde en `/api/guild-info`
- [ ] URL del bot: `https://tu-bot.koyeb.app`

### Página en Vercel:
- [ ] Repositorio conectado
- [ ] Root directory: `Heavens-Of-Glory-main`
- [ ] Output directory: `public`
- [ ] Build exitoso
- [ ] Página carga correctamente
- [ ] URL de la página: `https://tu-pagina.vercel.app`

### Conexión:
- [ ] URL del bot actualizada en `script.js`
- [ ] API responde con datos del servidor
- [ ] Estadísticas se actualizan en tiempo real
- [ ] Prueba: `https://tu-bot.koyeb.app/api/guild-info`

---

## 🛠️ Comandos Útiles

### Para el Bot:
```bash
# Instalar dependencias
npm install

# Ejecutar localmente
npm start

# Ver logs en Koyeb
# Ve a tu servicio > Logs
```

### Para la Página Web:
```bash
# Servir localmente
cd Heavens-Of-Glory-main
npx serve public

# O usar Python
cd Heavens-Of-Glory-main/public
python -m http.server 8000
```

---

## 🔍 Troubleshooting

### Bot no responde:
1. Verifica las variables de entorno en Koyeb
2. Revisa los logs en Koyeb
3. Asegúrate de que el bot esté en el servidor de Discord

### Página no carga datos:
1. Verifica la URL del bot en script.js
2. Abre las herramientas de desarrollador (F12)
3. Revisa la consola para errores
4. Prueba la API directamente: `https://tu-bot.koyeb.app/api/guild-info`

### CORS Errors:
1. Verifica que el bot tenga los headers CORS (ya incluidos en el código)
2. Asegúrate de que la URL del bot sea correcta

---

## 📞 Soporte

Si tienes problemas:
1. Revisa los logs en Koyeb y Vercel
2. Verifica las variables de entorno
3. Prueba la API directamente en el navegador
4. Revisa la consola del navegador para errores
