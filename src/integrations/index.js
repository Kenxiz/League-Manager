import { HttpClient } from './http-client.js';
import { RobloxThumbnails } from './roblox-thumbnails.js';

/** Builds all external-API clients. Add new integrations here. */
export function createIntegrations({ config, logger }) {
  const http = new HttpClient({
    allowedHosts: ['thumbnails.roblox.com'],
    timeoutMs: config.http.timeoutMs,
    maxRetries: config.http.maxRetries,
    logger,
  });
  return {
    http,
    roblox: new RobloxThumbnails({ http, baseUrl: config.http.robloxThumbnailsBase, logger }),
  };
}
