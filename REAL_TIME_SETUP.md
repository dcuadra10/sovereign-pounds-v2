# Real-Time Stats Setup Guide

## Overview
Your web page will now fetch real-time Discord server statistics from your bot deployed on Koyeb.

## Required Environment Variables

### For your Discord Bot (Koyeb deployment):
Add these environment variables in your Koyeb dashboard:

```
GUILD_ID=your_discord_server_id
DISCORD_TOKEN=your_bot_token
```

### For your Web Page (Vercel deployment):
No additional environment variables needed for the web page.

## Setup Steps

### 1. Get your Discord Server ID
1. Enable Developer Mode in Discord (User Settings > Advanced > Developer Mode)
2. Right-click on your server name
3. Click "Copy Server ID"
4. Use this ID as your `GUILD_ID`

### 2. Update the Bot API URL
In `Heavens-Of-Glory-main/public/script.js`, replace:
```javascript
const botApiUrl = 'https://your-bot-name.koyeb.app/api/guild-info';
```

With your actual Koyeb bot URL:
```javascript
const botApiUrl = 'https://your-actual-bot-name.koyeb.app/api/guild-info';
```

### 3. Deploy the Updated Bot
1. Commit and push your changes to your bot repository
2. Koyeb will automatically redeploy your bot with the new API endpoint

### 4. Deploy the Updated Web Page
1. Commit and push your changes to your web page repository
2. Vercel will automatically redeploy your web page

## API Endpoint Details

### Endpoint: `/api/guild-info`
- **Method**: GET
- **CORS**: Enabled for all origins
- **Response Format**:
```json
{
  "serverName": "Heavens of Glory",
  "status": "Online",
  "totalMembers": 250,
  "onlineMembers": 45,
  "notes": "Serving 250 members"
}
```

### Error Handling
- If the bot is not ready: Returns 503 with fallback data
- If guild not found: Returns 404 with error message
- If API fails: Web page falls back to static data

## Features

### Real-Time Updates
- **Member Count**: Shows actual Discord server member count
- **Online Members**: Shows members currently online (online, dnd, idle)
- **Server Status**: Shows if the bot is online and connected
- **Auto-Refresh**: Updates every 30 seconds automatically

### Fallback System
- If the API is unavailable, the web page shows static data
- Graceful error handling prevents the page from breaking
- Console logging for debugging

## Testing

### Test the API Endpoint
Visit: `https://your-bot-name.koyeb.app/api/guild-info`

You should see JSON data with your server information.

### Test the Web Page
1. Open your Vercel-deployed web page
2. Check the browser console for any errors
3. Verify that the member count and online count update
4. Wait 30 seconds to see the auto-refresh in action

## Troubleshooting

### Common Issues

1. **CORS Errors**: Make sure your bot has the CORS headers set (already included in the code)

2. **404 Errors**: 
   - Check that your `GUILD_ID` is correct
   - Ensure your bot is in the Discord server

3. **503 Errors**:
   - Bot might be starting up
   - Check Koyeb logs for bot status

4. **Static Data Showing**:
   - Check browser console for fetch errors
   - Verify the bot API URL is correct
   - Test the API endpoint directly

### Debug Steps
1. Check Koyeb bot logs for any errors
2. Test the API endpoint directly in your browser
3. Check browser console for JavaScript errors
4. Verify environment variables are set correctly

## Security Notes
- The API endpoint is read-only and only returns public server information
- CORS is enabled for all origins (suitable for public web pages)
- No sensitive data is exposed through the API
