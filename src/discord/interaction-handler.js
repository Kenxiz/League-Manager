import { EmbedBuilder, MessageFlags } from 'discord.js';
import { RateLimiter } from '../utils/helpers.js';
import { AppError, PermissionError, ValidationError, toUserMessage } from '../utils/errors.js';
import { Permission } from '../utils/constants.js';
import { buildContext } from './context.js';
import { ensureSuspendedRole, runGuildSetup } from './setup-helper.js';
import { buildSuspendModal } from './commands/suspend.js';

function resolveUserIdFromInput(input, guild) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  const mentionMatch = trimmed.match(/^<@!?(\d{17,20})>$/);
  if (mentionMatch) return mentionMatch[1];
  if (/^\d{17,20}$/.test(trimmed)) return trimmed;
  if (guild) {
    const lower = trimmed.toLowerCase();
    const found = guild.members.cache.find(
      (m) =>
        m.user.username.toLowerCase() === lower ||
        m.displayName.toLowerCase() === lower ||
        m.user.tag?.toLowerCase() === lower,
    );
    if (found) return found.user.id;
  }
  return null;
}

/**
 * Central interaction pipeline: lookup -> guild-only check -> rate limit -> execute -> error handling.
 */
export function createInteractionHandler({ app, commands }) {
  const { logger } = app;
  const globalLimiter = new RateLimiter({ limit: 20, windowMs: 10_000 });
  const commandLimiters = new Map();

  const limiterFor = (command) => {
    let l = commandLimiters.get(command.data.name);
    if (!l) {
      const { limit = 5, windowMs = 10_000 } = command.rateLimit ?? {};
      l = new RateLimiter({ limit, windowMs });
      commandLimiters.set(command.data.name, l);
    }
    return l;
  };

  async function reportError(interaction, err, command) {
    if (!(err instanceof AppError) || !err.expose || err.code === 'INTERNAL') {
      logger.error(
        { err, command: command?.data?.name, guild: interaction.guildId, user: interaction.user?.id },
        'interaction failed',
      );
    } else {
      logger.debug({ code: err.code, command: command?.data?.name }, 'interaction rejected');
    }
    const payload = { content: `❌ ${toUserMessage(err)}`, flags: MessageFlags.Ephemeral };
    try {
      if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: payload.content });
      else if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch (replyErr) {
      logger.warn({ err: replyErr }, 'could not deliver error message');
    }
  }

  async function handleModalSubmit(interaction) {
    if (interaction.customId.startsWith('suspend_modal:')) {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '❌ Suspensions only work in a server.', flags: MessageFlags.Ephemeral });
        return;
      }

      const ctx = buildContext(interaction, app);
      app.services.permissions.assertCanSuspend(ctx.actor, ctx.settings);

      const targetIdFromCustom = interaction.customId.slice('suspend_modal:'.length);
      const userInput = interaction.fields.getTextInputValue('user_input');
      const targetUserId =
        targetIdFromCustom && targetIdFromCustom !== 'new' && /^\d{17,20}$/.test(targetIdFromCustom)
          ? targetIdFromCustom
          : resolveUserIdFromInput(userInput, interaction.guild);

      if (!targetUserId) {
        throw new ValidationError('Could not identify user. Please provide a valid User ID, @mention, or Username.');
      }

      const reason = interaction.fields.getTextInputValue('reason_input')?.trim();
      if (!reason) {
        throw new ValidationError('A reason for the suspension is required.');
      }

      const robuxRaw = interaction.fields.getTextInputValue('bail_robux_input')?.trim();
      let bailRobux = 0;
      if (robuxRaw && robuxRaw !== '0') {
        const cleaned = robuxRaw.replace(/[^0-9]/g, '');
        bailRobux = Number(cleaned);
        if (isNaN(bailRobux) || bailRobux < 0) {
          throw new ValidationError('Bail in Robux must be a valid positive whole number.');
        }
      }

      const dollarsRaw = interaction.fields.getTextInputValue('bail_dollars_input')?.trim();
      let bailDollars = 0;
      if (dollarsRaw && dollarsRaw !== '0') {
        const cleaned = dollarsRaw.replace(/[^0-9.]/g, '');
        bailDollars = Number(cleaned);
        if (isNaN(bailDollars) || bailDollars < 0) {
          throw new ValidationError('Bail in Dollars must be a valid positive number.');
        }
      }

      // Automatically ensure @Suspended role exists during setup / suspension
      const suspendedRole = await ensureSuspendedRole(interaction.guild, app.services);

      // Record suspension in database
      const suspension = app.services.suspensions.suspend({
        guildDiscordId: interaction.guildId,
        userDiscordId: targetUserId,
        reason,
        bailRobux,
        bailDollars,
        actorDiscordId: interaction.user.id,
      });

      // Assign @Suspended role to the member if present in server
      let roleAssigned = false;
      try {
        const member = await interaction.guild.members.fetch(targetUserId).catch(() => null);
        if (member && suspendedRole) {
          await member.roles.add(suspendedRole.id, `Suspension: ${reason}`);
          roleAssigned = true;
        }
      } catch (err) {
        logger.warn({ err, userId: targetUserId }, 'could not assign @Suspended role to member');
      }

      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('⚖️ Player Suspended')
        .setDescription(`<@${targetUserId}> has been suspended from the league.`)
        .addFields(
          { name: 'Target User', value: `<@${targetUserId}> (\`${targetUserId}\`)`, inline: true },
          { name: 'Suspended By', value: `<@${interaction.user.id}>`, inline: true },
          {
            name: 'Role Status',
            value: roleAssigned && suspendedRole
              ? `✅ <@&${suspendedRole.id}> added`
              : (suspendedRole ? `ℹ️ Role created (<@&${suspendedRole.id}>), member offline` : '⚠️ Role error'),
            inline: true,
          },
          {
            name: 'Bail in Robux',
            value: bailRobux > 0 ? `**${bailRobux.toLocaleString()} R$**` : 'None',
            inline: true,
          },
          {
            name: 'Bail in Dollars',
            value: bailDollars > 0 ? `**$${bailDollars.toFixed(2)} USD**` : 'None',
            inline: true,
          },
          { name: 'Reason', value: reason },
        )
        .setFooter({ text: 'To unsuspend, authorized staff can run /unsuspend once bail is resolved.' })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    }
  }

  async function handleButton(interaction) {
    if (!interaction.inGuild()) return;

    if (interaction.customId === 'admin:open_suspend_modal') {
      const ctx = buildContext(interaction, app);
      app.services.permissions.assertCanSuspend(ctx.actor, ctx.settings);
      const modal = buildSuspendModal('');
      await interaction.showModal(modal);
      return;
    }

    if (interaction.customId === 'admin:view_suspensions') {
      const ctx = buildContext(interaction, app);
      app.services.permissions.assertCanSuspend(ctx.actor, ctx.settings);
      const active = app.services.suspensions.listSuspensions(interaction.guildId, { activeOnly: true });

      if (active.length === 0) {
        await interaction.reply({
          content: 'ℹ️ There are currently no active player suspensions in this server.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const lines = active.slice(0, 15).map((s) => {
        const bailStr = [
          s.bailRobux > 0 ? `${s.bailRobux} R$` : null,
          s.bailDollars > 0 ? `$${s.bailDollars.toFixed(2)}` : null,
        ].filter(Boolean).join(' / ') || 'No bail';
        return `• <@${s.userDiscordId}> — **${bailStr}** — *${s.reason}* (<t:${s.suspendedAt}:R>)`;
      });

      const embed = new EmbedBuilder()
        .setColor(0x80848e)
        .setTitle(`Active Suspensions (${active.length})`)
        .setDescription(lines.join('\n'))
        .setTimestamp();

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.customId === 'admin:run_setup') {
      const ctx = buildContext(interaction, app);
      app.services.permissions.assert(ctx.actor, ctx.settings, Permission.MANAGE_SETTINGS);
      const setupResult = await runGuildSetup(interaction.guild, app.services);

      await interaction.reply({
        content: `✅ Automatic setup verified! \`@Suspended\` role: <@&${setupResult.suspendedRole?.id}>`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.customId.startsWith('match_confirm:')) {
      const [, matchIdStr, side] = interaction.customId.split(':');
      const matchId = Number(matchIdStr);
      const confirmed = app.services.schedule.confirmProposal({
        guildDiscordId: interaction.guildId,
        matchId,
        userDiscordId: interaction.user.id,
        side,
      });

      await interaction.reply({
        content: `✅ ${side.toUpperCase()} team time confirmation recorded by <@${interaction.user.id}>!`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  return async function handle(interaction) {
    try {
      if (interaction.isAutocomplete()) {
        const command = commands.get(interaction.commandName);
        if (!command?.autocomplete || (command.guildOnly !== false && !interaction.inGuild())) return;
        try {
          await command.autocomplete(interaction, app);
        } catch (err) {
          logger.warn({ err, command: interaction.commandName }, 'autocomplete failed');
          if (!interaction.responded) await interaction.respond([]).catch(() => {});
        }
        return;
      }

      if (interaction.isModalSubmit()) {
        await handleModalSubmit(interaction);
        return;
      }

      if (interaction.isButton()) {
        await handleButton(interaction);
        return;
      }

      if (!interaction.isChatInputCommand()) return;
      const command = commands.get(interaction.commandName);
      if (!command) return;

      if (command.guildOnly !== false && !interaction.inGuild()) {
        await interaction.reply({ content: '❌ This command only works in a server.', flags: MessageFlags.Ephemeral });
        return;
      }
      globalLimiter.consume(interaction.user.id);
      limiterFor(command).consume(interaction.user.id);
      await command.execute(interaction, app);
    } catch (err) {
      await reportError(interaction, err, null);
    }
  };
}
