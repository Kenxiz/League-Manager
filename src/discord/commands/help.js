import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';

export const HELP_CATEGORIES = {
  overview: {
    label: 'Overview & Quick Start',
    emoji: '🏈',
    description: 'Welcome to LeagueBot and quick start guide',
  },
  players: {
    label: 'Players & Rosters',
    emoji: '📋',
    description: 'Signings, releases, transfers, rosters & free agency',
  },
  scheduling: {
    label: 'Scheduling & Games',
    emoji: '📅',
    description: 'Match creation, time coordination, scores & standings',
  },
  captains: {
    label: 'Captains & Team Staff',
    emoji: '⭐',
    description: 'Team captains, athletic directors & coordinators',
  },
  admin: {
    label: 'Administration & Suspensions',
    emoji: '⚖️',
    description: 'Setup, suspensions with bail, permissions & moderation',
  },
};

export function buildHelpEmbed(category = 'overview') {
  switch (category) {
    case 'players':
      return new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('📋 Player & Roster Management')
        .setDescription('Commands for signing, releasing, transferring, and managing player rosters.')
        .addFields(
          {
            name: '✍️ `/sign <team> [user] [position] [jersey]`',
            value:
              'Sign yourself or another player to a college football team.\n' +
              '• Strips `@Free Agent` and automatically assigns the team role.\n' +
              '• Supports positions (QB, RB, WR, OT, DT, LB, CB, S, K) and jersey numbers.\n' +
              '• Staff with `SIGN_OTHERS` or team Athletic Directors can sign other players.',
          },
          {
            name: '📋 `/release [user] [team]`',
            value:
              'Release yourself or another player from their team.\n' +
              '• Removes team role and automatically restores `@Free Agent` status.\n' +
              '• Logs transaction to `#transactions`.',
          },
          {
            name: '🔄 `/transfer <user> <to_team> [from_team] [position] [jersey]`',
            value:
              'Direct transfer portal: moves player between teams in a single transaction.\n' +
              '• Automatically swaps team Discord roles without returning to free agency.',
          },
          {
            name: '👥 `/roster <team>`',
            value: 'View a team roster including active players, designated captains, positions, stadium, and open roster spots.',
          },
          {
            name: '🏫 `/teams`',
            value: 'List all active teams in the league, showing conferences, roster counts, and vacancies.',
          },
          {
            name: '🆓 `/freeagents`',
            value: 'List available players looking for a team in the league.',
          },
          {
            name: '👤 `/profile [user]`',
            value: 'View a player card with Roblox account verification, primary positions, and contract status.',
          },
          {
            name: '🔗 `/verify <roblox_username>`',
            value: 'Link your Roblox account to your Discord user profile for league eligibility.',
          },
        )
        .setFooter({ text: 'League Manager • Player Management' })
        .setTimestamp();

    case 'scheduling':
      return new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('📅 Scheduling, Matches & Standings')
        .setDescription('End-to-end game management from scheduling to score verification.')
        .addFields(
          {
            name: '🏟️ `/schedule create <home_team> <away_team> [week] [create_thread]`',
            value:
              'Schedule a match between two teams.\n' +
              '• Automatically creates an Athletic Director coordination thread in `#league-schedule`.\n' +
              '• Pings both team owners/ADs to coordinate kickoff.',
          },
          {
            name: '⏰ `/schedule end <time> [match_id]`',
            value:
              'Propose an official game time inside the match thread.\n' +
              '• Supports relative times (e.g. `today 8pm`, `in 2h`, `tomorrow 6pm`, Unix timestamp).\n' +
              '• Spawns mutual confirmation tick buttons for both Athletic Directors.\n' +
              '• Once both confirm, the kickoff time is locked in and announced.',
          },
          {
            name: '📜 `/schedule list [week] [team]`',
            value: 'View the upcoming and completed matches in the league schedule.',
          },
          {
            name: '📊 `/report <match_id> <home_score> <away_score> [proof_url] [notes]`',
            value:
              'Submit official game results.\n' +
              '• Auto-approved if submitted by staff, or posted to `#league-logs` with Approve/Reject buttons for commissioner review.',
          },
          {
            name: '🏆 `/standings [season]`',
            value: 'View the live league standings table sorted by Win %, Differential, and Points For.',
          },
        )
        .setFooter({ text: 'League Manager • Scheduling & Competition' })
        .setTimestamp();

    case 'captains':
      return new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle('⭐ Captains & Team Staff')
        .setDescription('Appoint leadership and manage team authority.')
        .addFields(
          {
            name: '⭐ `/captain assign <team> <user> <type>`',
            value:
              'Designate a team captain or unit leader.\n' +
              '• Types: Team Captain, Offensive Captain, Defensive Captain, Special Teams Captain.\n' +
              '• Displays proudly on `/roster`.',
          },
          {
            name: '❌ `/captain remove <team> <user>`',
            value: 'Remove a player captain designation.',
          },
        )
        .setFooter({ text: 'League Manager • Team Leadership' })
        .setTimestamp();

    case 'admin':
      return new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('⚖️ Administration, Suspensions & Setup')
        .setDescription('Server setup, player suspensions with bail, and developer controls.')
        .addFields(
          {
            name: '⚖️ `/suspend [user] [reason]`',
            value:
              'Brings up the official Suspension modal with fields for:\n' +
              '• **Target User** (ID or @mention)\n' +
              '• **Reason** (mandatory)\n' +
              '• **Bail in Robux** (optional R$)\n' +
              '• **Bail in Dollars** (optional $ USD)\n' +
              'Automatically assigns the `@Suspended` role and restricts signing.',
          },
          {
            name: '🔓 `/unsuspend <user> [reason]`',
            value: 'Lifts a suspension once bail is satisfied, removes `@Suspended` role, and logs the action.',
          },
          {
            name: '⚙️ `/admin`',
            value: 'Staff control panel with direct buttons for Open Suspension Modal, View Active Suspensions, and Verify Setup.',
          },
          {
            name: '🚀 `/setup`',
            value:
              'Automated server setup. Automatically provisions:\n' +
              '• Channels: `#league-schedule`, `#transactions`, `#league-logs` under `🏈 LEAGUE MANAGER` category.\n' +
              '• Core roles: `@Suspended`, `@Commissioner`, `@Athletic Director`, `@Coach`, `@Free Agent`.\n' +
              '• Assigns `@Free Agent` to all existing members.\n' +
              '• Automatically saves and configures all roles and channels for the league.',
          },
          {
            name: '🔨 `/ban` & `/unban` *(Bot Developers Only)*',
            value: 'Strict developer moderation commands reserved for bot development team.',
          },
        )
        .setFooter({ text: 'League Manager • Staff Administration' })
        .setTimestamp();

    case 'overview':
    default:
      return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🏈 College Football League Manager — Command Guide')
        .setDescription(
          'Welcome to **League Manager**, the all-in-one Discord bot built for College Football leagues on Roblox!\n\n' +
          '**Key Features:**\n' +
          '• **Automated Server Setup**: Run `/setup` to instantly create categories, channels, and core roles.\n' +
          '• **Roster & Signings**: Self-signing, AD sign authority, direct `/transfer`, and `@Free Agent` automation.\n' +
          '• **Match Scheduling**: Automatic coordination threads, `/schedule end {time}` proposals with dual tick confirmation.\n' +
          '• **Score Reporting & Standings**: In-chat reporting, staff verification buttons, and automatic standings.\n' +
          '• **Suspension System**: Ban alternative with `@Suspended` role and Robux / USD bail settings.\n\n' +
          '👉 **Use the dropdown menu below** to explore commands by category.',
        )
        .addFields(
          { name: '📋 Players & Rosters', value: '`/sign`, `/release`, `/transfer`, `/roster`, `/teams`, `/freeagents`, `/profile`, `/verify`', inline: false },
          { name: '📅 Scheduling & Games', value: '`/schedule create`, `/schedule end`, `/schedule list`, `/report`, `/standings`', inline: false },
          { name: '⭐ Captains & Staff', value: '`/captain assign`, `/captain remove`', inline: false },
          { name: '⚖️ Administration', value: '`/suspend`, `/unsuspend`, `/admin`, `/setup`', inline: false },
        )
        .setFooter({ text: 'Select a category below for detailed command syntax and options.' })
        .setTimestamp();
  }
}

export function buildHelpComponents(selectedCategory = 'overview') {
  const options = Object.entries(HELP_CATEGORIES).map(([key, cat]) =>
    new StringSelectMenuOptionBuilder()
      .setValue(key)
      .setLabel(cat.label)
      .setDescription(cat.description)
      .setEmoji(cat.emoji)
      .setDefault(key === selectedCategory),
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId('help_category_select')
    .setPlaceholder('Choose a category...')
    .addOptions(options);

  return [new ActionRowBuilder().addComponents(select)];
}

export default {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Comprehensive guide and documentation for all League Manager commands')
    .addStringOption((opt) =>
      opt
        .setName('category')
        .setDescription('Specific category to view')
        .setRequired(false)
        .addChoices(
          { name: '🏈 Overview & Quick Start', value: 'overview' },
          { name: '📋 Players & Rosters', value: 'players' },
          { name: '📅 Scheduling & Games', value: 'scheduling' },
          { name: '⭐ Captains & Team Staff', value: 'captains' },
          { name: '⚖️ Administration & Suspensions', value: 'admin' },
        ),
    ),

  async execute(interaction) {
    const category = interaction.options.getString('category') || 'overview';
    const embed = buildHelpEmbed(category);
    const components = buildHelpComponents(category);

    await interaction.reply({
      embeds: [embed],
      components,
    });
  },
};
