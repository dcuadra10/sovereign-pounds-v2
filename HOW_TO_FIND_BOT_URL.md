# Cómo Encontrar la BOT_API_URL

## 🎯 ¿Qué es BOT_API_URL?
Es la URL donde está desplegado tu bot en Koyeb. Se ve así:
```
https://heavenly-pounds-bot-xxxxx.koyeb.app/api/guild-info
```

## 📍 Paso a Paso para Encontrarla

### 1. Despliega tu Bot en Koyeb Primero
1. Ve a [koyeb.com](https://koyeb.com)
2. Crea un nuevo servicio
3. Conecta tu repositorio de GitHub
4. Configura las variables de entorno
5. Haz clic en "Deploy"

### 2. Encuentra la URL en Koyeb
Una vez que el deploy termine:

1. **Ve a tu servicio en Koyeb**
2. **Busca la sección "Domains" o "URL"**
3. **Copia la URL que aparece**, por ejemplo:
   ```
   https://heavenly-pounds-bot-abc123.koyeb.app
   ```

### 3. Construye la BOT_API_URL
Agrega `/api/guild-info` al final:
```
https://heavenly-pounds-bot-abc123.koyeb.app/api/guild-info
```

## 🔧 Cómo Configurarla

### En Vercel (Variables de Entorno):
1. Ve a tu proyecto en Vercel
2. Ve a "Settings" → "Environment Variables"
3. Agrega:
   - **Name**: `BOT_API_URL`
   - **Value**: `https://heavenly-pounds-bot-abc123.koyeb.app/api/guild-info`
   - **Environment**: Production, Preview, Development

### En tu archivo .env (local):
```env
BOT_API_URL=https://heavenly-pounds-bot-abc123.koyeb.app/api/guild-info
```

## 🧪 Cómo Probar que Funciona

### 1. Prueba la API directamente:
Abre en tu navegador:
```
https://tu-bot.koyeb.app/api/guild-info
```

Deberías ver algo como:
```json
{
  "serverName": "Heavens of Glory",
  "status": "Online",
  "totalMembers": 250,
  "onlineMembers": 45,
  "notes": "Serving 250 members"
}
```

### 2. Si ves un error:
- Verifica que el bot esté desplegado
- Revisa los logs en Koyeb
- Asegúrate de que las variables de entorno estén configuradas

## 📋 Ejemplo Completo

### Tu URL de Koyeb:
```
https://heavenly-pounds-bot-abc123.koyeb.app
```

### Tu BOT_API_URL:
```
https://heavenly-pounds-bot-abc123.koyeb.app/api/guild-info
```

### En Vercel Environment Variables:
```
BOT_API_URL = https://heavenly-pounds-bot-abc123.koyeb.app/api/guild-info
```

## 🚨 Errores Comunes

### Error 404:
- El bot no está desplegado
- La URL está mal escrita
- El endpoint no existe

### Error 503:
- El bot está iniciando
- Variables de entorno faltantes
- Error en el código del bot

### Error CORS:
- El bot no tiene CORS configurado (ya está incluido en el código)
- URL incorrecta

## 💡 Tips

1. **Guarda la URL**: Una vez que la encuentres, guárdala en un lugar seguro
2. **Prueba primero**: Siempre prueba la API directamente antes de configurarla
3. **Verifica logs**: Si algo no funciona, revisa los logs en Koyeb
4. **Actualiza Vercel**: Después de cambiar variables de entorno, redespliega en Vercel

## 🔄 Flujo Completo

1. **Despliega bot en Koyeb** → Obtén URL
2. **Construye BOT_API_URL** → Agrega `/api/guild-info`
3. **Configura en Vercel** → Agrega variable de entorno
4. **Despliega página web** → En Vercel
5. **Prueba** → Ve si las estadísticas se actualizan

¡Eso es todo! Una vez que tengas la URL de tu bot en Koyeb, solo agrega `/api/guild-info` al final y esa será tu `BOT_API_URL`.
