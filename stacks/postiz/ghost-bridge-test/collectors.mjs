// The numbers collectors' tests: each file sets the settings it needs, then calls collectors(). That gives:
//  - a data folder of its own (STATE_FILE's, from env.mjs), removed when the tests end
//  - a clock stopped at NOW (timers too: a collector polls only when a test asks, never by itself)
//  - the fake web (fake-web.mjs: Postiz at POSTIZ, Ghost at GHOST, every network) and a fake Postgres for Postiz's
//    database (fake-postgres.mjs; its answer gives each channel's token from tokens)
//  - stats/stats.mjs's startStats with all that, as ghost-bridge.mjs starts it: poll(name, prev) runs one collector
//    (prev: the file it last wrote, if any) and gives the file it wrote; the log in logged
// Import env.mjs first, and the bridge's modules only after collectors() (config.mjs reads the settings once).
import { mock, after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { web } from './fake-web.mjs';
import { fakePostgres } from './fake-postgres.mjs';

export { web };
export const NOW = Date.parse('2026-10-15T12:00:00Z');
export const DAY = 86_400_000;
export const date = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10);
export const POSTIZ = 'https://postiz.test/api/public/v1';
export const GHOST = 'https://ghost.test';

export async function collectors(settings = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  Object.assign(process.env, {
    POSTIZ_API_URL: POSTIZ, GHOST_API_URL: GHOST, GHOST_ADMIN_API_KEY: `${'a'.repeat(24)}:${'b'.repeat(64)}`, ...settings,
  });
  const dataDir = path.dirname(process.env.STATE_FILE);
  fs.mkdirSync(dataDir, { recursive: true });
  process.on('exit', () => fs.rmSync(dataDir, { recursive: true, force: true }));

  const tokens = {};
  const pg = await fakePostgres({ auth: 'scram', password: process.env.POSTIZ_DB_PASSWORD || 'secret', answer: (sql) => {
    const id = /WHERE id = '((?:[^']|'')*)'/.exec(sql)?.[1]?.replace(/''/g, "'");
    return id in tokens ? [{ token: tokens[id] }] : [];
  } });
  after(() => pg.close());
  Object.assign(process.env, { POSTIZ_DB_HOST: pg.PG.host, POSTIZ_DB_PORT: String(pg.PG.port) });

  const { postiz, pgQuery, PG, ghostAdmin, ghostMembers } = await import('../ghost-bridge/services.mjs');
  const { startStats } = await import('../ghost-bridge/stats/stats.mjs');
  const logged = [];
  const stats = startStats({ env: process.env, dataDir, log: (m) => logged.push(m), postiz, pgQuery, PG, ghostPosts: null,
    ghostAdmin, ghostMembers });
  const file = (name) => path.join(dataDir, `${name}.json`);
  const read = (name) => JSON.parse(fs.readFileSync(file(name), 'utf8'));
  return {
    stats, pg, tokens, dataDir, logged, read,
    archive: (name) => JSON.parse(fs.readFileSync(path.join(dataDir, 'archive', `${name}.json`), 'utf8')),
    async poll(name, prev) {
      if (prev) fs.writeFileSync(file(name), JSON.stringify(prev));
      else fs.rmSync(file(name), { force: true });
      await stats.run(name);
      return read(name);
    },
  };
}
