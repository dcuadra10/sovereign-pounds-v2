#!/bin/bash

# Script de Deploy Automatizado
# Para Bot en Koyeb y Web en Vercel

echo "🚀 Iniciando proceso de deploy..."

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Función para imprimir mensajes
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Verificar que estamos en el directorio correcto
if [ ! -f "bot.js" ]; then
    print_error "No se encontró bot.js. Asegúrate de estar en el directorio raíz del proyecto."
    exit 1
fi

print_status "Verificando archivos necesarios..."

# Verificar archivos necesarios
required_files=("bot.js" "package.json" "Dockerfile" "koyeb.yaml")
for file in "${required_files[@]}"; do
    if [ ! -f "$file" ]; then
        print_error "Archivo requerido no encontrado: $file"
        exit 1
    fi
done

print_success "Todos los archivos necesarios están presentes"

# Verificar que el repositorio esté en GitHub
print_status "Verificando conexión con GitHub..."
if ! git remote get-url origin | grep -q "github.com"; then
    print_warning "No se detectó un repositorio de GitHub. Asegúrate de que tu repositorio esté en GitHub."
fi

# Hacer commit de los cambios
print_status "Haciendo commit de los cambios..."
git add .
git commit -m "Deploy: Actualización para Koyeb y Vercel" || print_warning "No hay cambios para commitear"

# Push a GitHub
print_status "Enviando cambios a GitHub..."
git push origin main || {
    print_error "Error al hacer push a GitHub"
    exit 1
}

print_success "Cambios enviados a GitHub exitosamente"

echo ""
echo "📋 Próximos pasos manuales:"
echo ""
echo "🤖 DEPLOY EN KOYEB:"
echo "1. Ve a https://koyeb.com"
echo "2. Crea un nuevo servicio"
echo "3. Conecta tu repositorio de GitHub"
echo "4. Configura las variables de entorno:"
echo "   - DISCORD_TOKEN=tu_token_del_bot"
echo "   - GUILD_ID=tu_server_id_de_discord"
echo "   - DATABASE_URL=tu_url_de_base_de_datos"
echo "5. Haz clic en Deploy"
echo ""
echo "🌐 DEPLOY EN VERCEL:"
echo "1. Ve a https://vercel.com"
echo "2. Crea un nuevo proyecto"
echo "3. Conecta tu repositorio de GitHub"
echo "4. Configura:"
echo "   - Root Directory: Heavens-Of-Glory-main"
echo "   - Output Directory: public"
echo "5. Haz clic en Deploy"
echo ""
echo "🔗 CONECTAR BOT Y WEB:"
echo "1. Copia la URL de tu bot en Koyeb"
echo "2. Edita Heavens-Of-Glory-main/public/script.js"
echo "3. Cambia la URL del bot en la línea:"
echo "   const botApiUrl = 'https://tu-bot.koyeb.app/api/guild-info';"
echo "4. Haz commit y push de los cambios"
echo ""
print_success "¡Deploy completado! Sigue los pasos manuales arriba."
