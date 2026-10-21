import { HttpClient } from './http-client.js';
import { RobloxThumbnails } from './roblox-thumbnails.js';
import { RobloxApi } from './roblox-api.js';

/** Builds all external-API clients. Add new integrations here. */
export function createIntegrations({ config, logger }) {
  const http = new HttpClient({
    allowedHosts: [
      'thumbnails.roblox.com',
      'users.roblox.com',
      'groups.roblox.com',
    ],
    timeoutMs: config.http.timeoutMs,
    maxRetries: config.http.maxRetries,
    logger,
  });

  const robloxApi = new RobloxApi({ http, logger });
  const robloxThumbnails = new RobloxThumbnails({ http, baseUrl: config.http.robloxThumbnailsBase, logger });

  return {
    http,
    roblox: robloxThumbnails,
    robloxApi,
  };
}
