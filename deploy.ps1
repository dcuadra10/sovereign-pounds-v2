# Script de Deploy Automatizado para Windows PowerShell
# Para Bot en Koyeb y Web en Vercel

Write-Host "🚀 Iniciando proceso de deploy..." -ForegroundColor Blue

# Función para imprimir mensajes
function Write-Status {
    param($Message)
    Write-Host "[INFO] $Message" -ForegroundColor Blue
}

function Write-Success {
    param($Message)
    Write-Host "[SUCCESS] $Message" -ForegroundColor Green
}

function Write-Warning {
    param($Message)
    Write-Host "[WARNING] $Message" -ForegroundColor Yellow
}

function Write-Error {
    param($Message)
    Write-Host "[ERROR] $Message" -ForegroundColor Red
}

# Verificar que estamos en el directorio correcto
if (-not (Test-Path "bot.js")) {
    Write-Error "No se encontró bot.js. Asegúrate de estar en el directorio raíz del proyecto."
    exit 1
}

Write-Status "Verificando archivos necesarios..."

# Verificar archivos necesarios
$requiredFiles = @("bot.js", "package.json", "Dockerfile", "koyeb.yaml")
foreach ($file in $requiredFiles) {
    if (-not (Test-Path $file)) {
        Write-Error "Archivo requerido no encontrado: $file"
        exit 1
    }
}

Write-Success "Todos los archivos necesarios están presentes"

# Verificar que el repositorio esté en GitHub
Write-Status "Verificando conexión con GitHub..."
try {
    $originUrl = git remote get-url origin
    if ($originUrl -notlike "*github.com*") {
        Write-Warning "No se detectó un repositorio de GitHub. Asegúrate de que tu repositorio esté en GitHub."
    }
} catch {
    Write-Warning "No se pudo verificar la URL del repositorio remoto"
}

# Hacer commit de los cambios
Write-Status "Haciendo commit de los cambios..."
try {
    git add .
    git commit -m "Deploy: Actualización para Koyeb y Vercel"
    Write-Success "Cambios commiteados"
} catch {
    Write-Warning "No hay cambios para commitear o error en el commit"
}

# Push a GitHub
Write-Status "Enviando cambios a GitHub..."
try {
    git push origin main
    Write-Success "Cambios enviados a GitHub exitosamente"
} catch {
    Write-Error "Error al hacer push a GitHub"
    Write-Host "Intenta ejecutar manualmente: git push origin main" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "📋 Próximos pasos manuales:" -ForegroundColor Cyan
Write-Host ""
Write-Host "🤖 DEPLOY EN KOYEB:" -ForegroundColor Yellow
Write-Host "1. Ve a https://koyeb.com"
Write-Host "2. Crea un nuevo servicio"
Write-Host "3. Conecta tu repositorio de GitHub"
Write-Host "4. Configura las variables de entorno:"
Write-Host "   - DISCORD_TOKEN=tu_token_del_bot"
Write-Host "   - GUILD_ID=tu_server_id_de_discord"
Write-Host "   - DATABASE_URL=tu_url_de_base_de_datos"
Write-Host "5. Haz clic en Deploy"
Write-Host ""
Write-Host "🌐 DEPLOY EN VERCEL:" -ForegroundColor Yellow
Write-Host "1. Ve a https://vercel.com"
Write-Host "2. Crea un nuevo proyecto"
Write-Host "3. Conecta tu repositorio de GitHub"
Write-Host "4. Configura:"
Write-Host "   - Root Directory: Heavens-Of-Glory-main"
Write-Host "   - Output Directory: public"
Write-Host "5. Haz clic en Deploy"
Write-Host ""
Write-Host "🔗 CONECTAR BOT Y WEB:" -ForegroundColor Yellow
Write-Host "1. Copia la URL de tu bot en Koyeb"
Write-Host "2. Edita Heavens-Of-Glory-main/public/script.js"
Write-Host "3. Cambia la URL del bot en la línea:"
Write-Host "   const botApiUrl = 'https://tu-bot.koyeb.app/api/guild-info';"
Write-Host "4. Haz commit y push de los cambios"
Write-Host ""
Write-Success "¡Deploy completado! Sigue los pasos manuales arriba."
