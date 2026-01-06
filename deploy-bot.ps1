# Script para desplegar solo el bot en Koyeb

Write-Host "🤖 Deploy del Bot en Koyeb" -ForegroundColor Blue
Write-Host "=========================" -ForegroundColor Blue

# Verificar archivos del bot
$botFiles = @("bot.js", "database.js", "deploy-commands.js", "package.json", "Dockerfile", "koyeb.yaml")
foreach ($file in $botFiles) {
    if (-not (Test-Path $file)) {
        Write-Host "[ERROR] Archivo del bot no encontrado: $file" -ForegroundColor Red
        exit 1
    }
}

Write-Host "[SUCCESS] Todos los archivos del bot encontrados" -ForegroundColor Green

# Commit y push
Write-Host "[INFO] Haciendo commit de los cambios del bot..." -ForegroundColor Blue
git add .
git commit -m "Deploy: Actualización del bot para Koyeb"

Write-Host "[INFO] Enviando al repositorio del bot..." -ForegroundColor Blue
git remote set-url origin https://github.com/dcuadra10/Heavens-Pounds.git
git push origin main

Write-Host ""
Write-Host "🎉 ¡Bot desplegado en Koyeb!" -ForegroundColor Green
Write-Host "URL del bot: https://overseas-mimi-heavens-295a972c.koyeb.app" -ForegroundColor Yellow
Write-Host "API endpoint: https://overseas-mimi-heavens-295a972c.koyeb.app/api/guild-info" -ForegroundColor Yellow
