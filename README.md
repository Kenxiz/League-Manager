```bash
npm install
cp .env.example .env      # fill in DISCORD_TOKEN + DISCORD_CLIENT_ID
npm run deploy            # register slash commands (DEV_GUILD_ID = instant, guild-only)
npm start
npm test
