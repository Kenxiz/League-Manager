import { createServer } from 'node:http';
import { Router } from './router.js';
import { nowSec } from '../utils/helpers.js';
import { runGuildSetup, selectInitialTeams, addGuildTeam } from '../discord/setup-helper.js';

export function createApiServer({ services, config, logger, discordClient = null }) {
  const router = new Router({ apiKey: config.api?.apiKey, logger });

  // --- Health & Metrics ---
  router.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), time: nowSec() });
  });

  router.get('/api/stats', (req, res) => {
    res.json(services.maintenance.stats());
  });

  // --- Team Catalog ---
  router.get('/api/teams', (req, res) => {
    const { q, conference } = req.query;
    let list = q ? services.teams.search(q, { limit: 150 }) : services.teams.all();
    if (conference) {
      const conf = conference.toLowerCase();
      list = list.filter((t) => (t.conference || '').toLowerCase() === conf);
    }
    res.json(list);
  });

  router.get('/api/teams/conferences', (req, res) => {
    res.json(services.teams.conferences());
  });

  router.get('/api/teams/:key', (req, res) => {
    const team = services.teams.resolve(req.params.key);
    res.json(team);
  });

  // --- Guilds & Settings ---
  router.get('/api/guilds/:guildId/settings', (req, res) => {
    const guildId = services.guilds.ensure(req.params.guildId);
    res.json(services.guilds.getSettings(guildId));
  });

  router.patch('/api/guilds/:guildId/settings', (req, res) => {
    const guildId = services.guilds.ensure(req.params.guildId);
    const updated = services.guilds.updateSettings(guildId, req.body);
    res.json(updated.after);
  });

  // --- Automated Setup Endpoint ---
  router.post('/api/guilds/:guildId/setup', async (req, res) => {
    const guild = discordClient?.guilds?.cache?.get(req.params.guildId) ?? { id: req.params.guildId, name: 'CFB League' };
    const setupResult = await runGuildSetup(guild, services);
    res.json(setupResult);
  });

  // --- Team Management & Dashboard Selection ---
  router.get('/api/guilds/:guildId/teams', (req, res) => {
    const guildId = services.guilds.ensure(req.params.guildId);
    const teams = services.teams.listForGuild(guildId, { conference: req.query.conference });
    const links = services.teamLinks.listLinks(req.params.guildId);
    const roleByTeamId = new Map(links.map((l) => [l.team.id, l.roleId]));
    const enriched = teams.map((t) => ({
      ...t,
      roleId: roleByTeamId.get(t.id) ?? null,
    }));
    res.json(enriched);
  });

  router.post('/api/guilds/:guildId/teams/initial', async (req, res) => {
    const { teamKeysOrIds, teamIds, createRoles = true } = req.body;
    const teamsToSelect = teamKeysOrIds || teamIds;
    const guild = discordClient?.guilds?.cache?.get(req.params.guildId) ?? null;
    const result = await selectInitialTeams({
      guildDiscordId: req.params.guildId,
      teamKeysOrIds: teamsToSelect,
      createRoles,
      guild,
      services,
    });
    res.json(result);
  });

  router.post('/api/guilds/:guildId/teams', async (req, res) => {
    const { teamKeyOrId, teamId, createRole = true } = req.body;
    const targetTeam = teamKeyOrId || teamId;
    const guild = discordClient?.guilds?.cache?.get(req.params.guildId) ?? null;
    const result = await addGuildTeam({
      guildDiscordId: req.params.guildId,
      teamKeyOrId: targetTeam,
      createRole,
      guild,
      services,
    });
    res.json(result, 201);
  });

  router.put('/api/guilds/:guildId/teams/:teamKey/toggle', (req, res) => {
    const guildId = services.guilds.ensure(req.params.guildId);
    const team = services.teams.resolve(req.params.teamKey);
    const enabled = req.body?.enabled !== false;
    services.teams.setEnabled(guildId, team.id, enabled);
    res.json({ teamKey: team.key, enabled });
  });


  // --- Rosters & Signings ---
  router.get('/api/guilds/:guildId/roster', (req, res) => {
    const { team } = req.query;
    if (team) {
      res.json(services.signings.roster(req.params.guildId, team));
    } else {
      res.json(services.signings.allLive(req.params.guildId));
    }
  });

  router.get('/api/guilds/:guildId/open-teams', (req, res) => {
    res.json(services.signings.openTeams(req.params.guildId));
  });

  router.get('/api/guilds/:guildId/users/:userId/history', (req, res) => {
    res.json(services.signings.history(req.params.guildId, req.params.userId));
  });

  router.post('/api/guilds/:guildId/signings', (req, res) => {
    const { userDiscordId, team, actorDiscordId, force } = req.body;
    const signing = services.signings.sign({
      guildDiscordId: req.params.guildId,
      userDiscordId,
      team,
      actorDiscordId,
      force,
    });
    res.json(signing, 201);
  });

  router.post('/api/guilds/:guildId/releases', (req, res) => {
    const { userDiscordId, team, actorDiscordId, reason } = req.body;
    const released = services.signings.release({
      guildDiscordId: req.params.guildId,
      userDiscordId,
      team,
      actorDiscordId,
      reason,
    });
    res.json(released);
  });

  router.post('/api/guilds/:guildId/transfers', (req, res) => {
    const { userDiscordId, from, to, actorDiscordId, force } = req.body;
    const transferred = services.signings.transfer({
      guildDiscordId: req.params.guildId,
      userDiscordId,
      from,
      to,
      actorDiscordId,
      force,
    });
    res.json(transferred);
  });

  // --- Scheduling & Matches ---
  router.get('/api/guilds/:guildId/matches', (req, res) => {
    const { week, team, status, upcomingOnly, limit } = req.query;
    const matches = services.schedule.listMatches({
      guildDiscordId: req.params.guildId,
      week: week ? Number(week) : null,
      team,
      status: status ? Number(status) : null,
      upcomingOnly: upcomingOnly === 'true',
      limit: limit ? Number(limit) : 50,
    });
    res.json(matches);
  });

  router.get('/api/matches/:id', (req, res) => {
    res.json(services.schedule.getMatch(Number(req.params.id)));
  });

  router.post('/api/guilds/:guildId/matches', (req, res) => {
    const created = services.schedule.createMatch({
      guildDiscordId: req.params.guildId,
      ...req.body,
    });
    res.json(created, 201);
  });

  router.patch('/api/guilds/:guildId/matches/:id/reschedule', (req, res) => {
    const updated = services.schedule.rescheduleMatch({
      guildDiscordId: req.params.guildId,
      matchId: Number(req.params.id),
      scheduledAt: req.body.scheduledAt,
      actorDiscordId: req.body.actorDiscordId,
      ignoreConflicts: req.body.ignoreConflicts,
    });
    res.json(updated);
  });

  router.post('/api/guilds/:guildId/matches/:id/cancel', (req, res) => {
    const cancelled = services.schedule.cancelMatch({
      guildDiscordId: req.params.guildId,
      matchId: Number(req.params.id),
      reason: req.body.reason,
      actorDiscordId: req.body.actorDiscordId,
    });
    res.json(cancelled);
  });

  router.post('/api/guilds/:guildId/matches/:id/propose', (req, res) => {
    const proposed = services.schedule.proposeTime({
      guildDiscordId: req.params.guildId,
      matchId: Number(req.params.id),
      proposerDiscordId: req.body.proposerDiscordId,
      scheduledAt: req.body.scheduledAt,
      side: req.body.side,
    });
    res.json(proposed);
  });

  router.post('/api/guilds/:guildId/matches/:id/confirm', (req, res) => {
    const confirmed = services.schedule.confirmProposal({
      guildDiscordId: req.params.guildId,
      matchId: Number(req.params.id),
      confirmerDiscordId: req.body.confirmerDiscordId,
      side: req.body.side,
      ignoreConflicts: req.body.ignoreConflicts,
    });
    res.json(confirmed);
  });

  // --- Match Reports & Standings ---
  router.post('/api/guilds/:guildId/matches/:id/report', (req, res) => {
    const report = services.matchReports.submitReport({
      guildDiscordId: req.params.guildId,
      matchId: Number(req.params.id),
      ...req.body,
    });
    res.json(report, 201);
  });

  router.post('/api/guilds/:guildId/reports/:id/approve', (req, res) => {
    const approved = services.matchReports.approveReport({
      guildDiscordId: req.params.guildId,
      reportId: Number(req.params.id),
      actorDiscordId: req.body.actorDiscordId,
    });
    res.json(approved);
  });

  router.post('/api/guilds/:guildId/reports/:id/reject', (req, res) => {
    const rejected = services.matchReports.rejectReport({
      guildDiscordId: req.params.guildId,
      reportId: Number(req.params.id),
      actorDiscordId: req.body.actorDiscordId,
      reason: req.body.reason,
    });
    res.json(rejected);
  });

  router.get('/api/guilds/:guildId/standings', (req, res) => {
    res.json(services.matchReports.getStandings({ guildDiscordId: req.params.guildId }));
  });

  // --- Captains & Server Links ---
  router.get('/api/guilds/:guildId/captains', (req, res) => {
    res.json(services.teamLinks.listCaptains(req.params.guildId, req.query.team));
  });

  router.post('/api/guilds/:guildId/captains', (req, res) => {
    const assigned = services.teamLinks.assignCaptain({
      guildDiscordId: req.params.guildId,
      ...req.body,
    });
    res.json(assigned, 201);
  });

  router.delete('/api/guilds/:guildId/captains/:teamKey/:userId', (req, res) => {
    const removed = services.teamLinks.removeCaptain({
      guildDiscordId: req.params.guildId,
      team: req.params.teamKey,
      userDiscordId: req.params.userId,
      actorDiscordId: req.query.actorDiscordId,
    });
    res.json(removed);
  });

  router.get('/api/guilds/:guildId/links', (req, res) => {
    res.json(services.teamLinks.listLinks(req.params.guildId));
  });

  router.post('/api/guilds/:guildId/links', (req, res) => {
    const link = services.teamLinks.setLink({
      guildDiscordId: req.params.guildId,
      ...req.body,
    });
    res.json(link);
  });

  // --- Bans ---
  router.get('/api/guilds/:guildId/bans', (req, res) => {
    res.json(services.bans.listBans(req.params.guildId));
  });

  router.post('/api/guilds/:guildId/bans', (req, res) => {
    const ban = services.bans.ban({
      guildDiscordId: req.params.guildId,
      ...req.body,
    });
    res.json(ban, 201);
  });

  router.delete('/api/guilds/:guildId/bans/:userId', (req, res) => {
    const unbanned = services.bans.unban({
      guildDiscordId: req.params.guildId,
      userDiscordId: req.params.userId,
      actorDiscordId: req.query.actorDiscordId,
    });
    res.json(unbanned);
  });

  // --- Suspensions ---
  router.get('/api/guilds/:guildId/suspensions', (req, res) => {
    const activeOnly = req.query.active !== 'false';
    res.json(services.suspensions.listSuspensions(req.params.guildId, { activeOnly }));
  });

  router.get('/api/guilds/:guildId/suspensions/:userId', (req, res) => {
    res.json(services.suspensions.getActiveSuspension(req.params.guildId, req.params.userId));
  });

  router.post('/api/guilds/:guildId/suspensions', (req, res) => {
    const suspension = services.suspensions.suspend({
      guildDiscordId: req.params.guildId,
      ...req.body,
    });
    res.json(suspension, 201);
  });

  router.delete('/api/guilds/:guildId/suspensions/:userId', (req, res) => {
    const unsuspended = services.suspensions.unsuspend({
      guildDiscordId: req.params.guildId,
      userDiscordId: req.params.userId,
      actorDiscordId: req.query.actorDiscordId || req.body?.actorDiscordId,
      reason: req.query.reason || req.body?.reason,
    });
    res.json(unsuspended);
  });


  // --- Roblox Verification ---
  router.get('/api/users/:userId/roblox', (req, res) => {
    res.json(services.verification.getLink(req.params.userId));
  });

  router.post('/api/users/:userId/roblox', (req, res) => {
    const link = services.verification.link({
      userDiscordId: req.params.userId,
      ...req.body,
    });
    res.json(link, 201);
  });

  router.delete('/api/users/:userId/roblox', (req, res) => {
    res.json(services.verification.unlink({ userDiscordId: req.params.userId }));
  });

  // --- Audit Logs ---
  router.get('/api/guilds/:guildId/audit', (req, res) => {
    const guildId = services.guilds.ensure(req.params.guildId);
    const { limit, before } = req.query;
    res.json(services.audit.list(guildId, { limit: limit ? Number(limit) : 25, before: before ? Number(before) : null }));
  });

  const server = createServer((req, res) => router.handle(req, res));

  return {
    server,
    router,
    listen(port = config.api?.port || 3001) {
      return new Promise((resolve) => {
        server.listen(port, () => {
          logger?.info({ port }, 'REST API server running');
          resolve(server);
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        if (server.closeAllConnections) server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },

  };
}
