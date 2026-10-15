// services.mjs pgQuery: the bridge's own small Postgres client, which reads a channel's sign-in from Postiz's database
// (Instagram, Threads, TikTok, YouTube), against a fake Postgres with each sign-in Postgres may ask for.
import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { fakePostgres } from './fake-postgres.mjs';

const { pgQuery } = await import('../ghost-bridge/services.mjs');

for (const auth of ['password', 'md5', 'scram']) {
  test(`signs in (${auth}) and reads rows, NULLs as null`, async () => {
    const pg = await fakePostgres({ auth, answer: () => [{ token: 'abc___xyz', picture: null, name: 'Café ☕' }, { token: '', picture: 'p', name: 'b' }] });
    try {
      const rows = await pgQuery(pg.PG, 'SELECT token, picture, name FROM "Integration"');
      assert.deepEqual(rows, [{ token: 'abc___xyz', picture: null, name: 'Café ☕' }, { token: '', picture: 'p', name: 'b' }]);
      assert.deepEqual(pg.queries, ['SELECT token, picture, name FROM "Integration"']);
    } finally { await pg.close(); }
  });

  test(`a wrong password (${auth}) is an error, not an empty answer`, async () => {
    const pg = await fakePostgres({ auth });
    try {
      await assert.rejects(pgQuery({ ...pg.PG, password: 'wrong' }, 'SELECT 1'), /Postgres: password authentication failed/);
      assert.deepEqual(pg.queries, []);
    } finally { await pg.close(); }
  });
}

test('a server that can\'t prove it knows the password (SCRAM) is refused before the query', async () => {
  const pg = await fakePostgres({ auth: 'scram', forge: true });
  try {
    await assert.rejects(pgQuery(pg.PG, 'SELECT token FROM "Integration"'), /Postgres: server signature mismatch/);
    assert.deepEqual(pg.queries, []);
  } finally { await pg.close(); }
});

test('no rows', async () => {
  const pg = await fakePostgres({ auth: 'scram', answer: () => [] });
  try { assert.deepEqual(await pgQuery(pg.PG, 'SELECT token FROM "Integration" WHERE false'), []); } finally { await pg.close(); }
});

test('a query Postgres refuses: its message', async () => {
  const pg = await fakePostgres({ answer: () => { throw new Error('relation "Integration" does not exist'); } });
  try {
    await assert.rejects(pgQuery(pg.PG, 'SELECT token FROM "Integration"'), /Postgres: relation "Integration" does not exist/);
  } finally { await pg.close(); }
});

test('nothing listening, or a server that never answers', async () => {
  const closed = await fakePostgres();
  const { port } = closed.PG;
  await closed.close();
  await assert.rejects(pgQuery({ ...closed.PG, port }, 'SELECT 1'), /Postgres: ECONNREFUSED/);
  const silent = net.createServer(() => {});
  await new Promise((ok) => silent.listen(0, '127.0.0.1', ok));
  try {
    await assert.rejects(pgQuery({ ...closed.PG, port: silent.address().port }, 'SELECT 1', 200), /Postgres: timed out/);
  } finally { silent.close(); }
});
