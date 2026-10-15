// A fake Postgres, enough for the bridge's own client (services.mjs pgQuery): a sign-in by password, md5 or
// SCRAM-SHA-256 (checked properly, so a wrong password fails as it would), then each query answered by a function.
//   const pg = await fakePostgres({ auth: 'scram', password: 'secret', answer: (sql) => [{ token: 'abc' }] });
//   pg.PG          the settings pgQuery takes (host, port, user, database, password)
//   pg.queries     every query asked
//   pg.answer      the answer function (a test may set another)
//   pg.close()
// answer(sql) gives the rows (objects of strings, null for NULL; the first row's keys are the columns), or throws
// to send the query's error. forge: a SCRAM server that doesn't know the password (its proof is wrong).
import net from 'node:net';
import crypto from 'node:crypto';

export async function fakePostgres({ auth = 'password', user = 'postiz', password = 'secret', answer = () => [], forge = false } = {}) {
  const queries = [];
  const api = { queries, answer };
  const msg = (type, body) => {
    const len = Buffer.alloc(4); len.writeInt32BE(body.length + 4);
    return Buffer.concat([Buffer.from(type), len, body]);
  };
  const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
  const int16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
  const cstr = (s) => Buffer.from(`${s}\0`);
  const authMsg = (code, rest = Buffer.alloc(0)) => msg('R', Buffer.concat([int32(code), rest]));
  const error = (code, text) => msg('E', Buffer.concat([cstr('SFATAL'), cstr(`C${code}`), cstr(`M${text}`), Buffer.from([0])]));
  const ready = () => msg('Z', Buffer.from('I'));
  const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();
  const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let started = false;
    let state = {};
    const signedIn = () => sock.write(Buffer.concat([authMsg(0), ready()]));
    const refuse = () => { sock.write(error('28P01', `password authentication failed for user "${user}"`)); sock.end(); };
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (!started) { // the startup message has no type byte
          if (buf.length < 4 || buf.length < buf.readInt32BE(0)) return;
          buf = buf.subarray(buf.readInt32BE(0));
          started = true;
          if (auth === 'password') sock.write(authMsg(3));
          else if (auth === 'md5') { state.salt = crypto.randomBytes(4); sock.write(authMsg(5, state.salt)); }
          else sock.write(authMsg(10, Buffer.concat([cstr('SCRAM-SHA-256'), Buffer.from([0])])));
          continue;
        }
        if (buf.length < 5 || buf.length < buf.readInt32BE(1) + 1) return;
        const type = String.fromCharCode(buf[0]);
        const body = buf.subarray(5, buf.readInt32BE(1) + 1);
        buf = buf.subarray(buf.readInt32BE(1) + 1);
        if (type === 'X') { sock.end(); return; }
        if (type === 'p' && auth === 'password') {
          body.subarray(0, -1).toString() === password ? signedIn() : refuse();
        } else if (type === 'p' && auth === 'md5') {
          const want = `md5${md5(Buffer.concat([Buffer.from(md5(password + user)), state.salt]))}`;
          body.subarray(0, -1).toString() === want ? signedIn() : refuse();
        } else if (type === 'p' && !state.first) { // SCRAM's client-first: "n,,n=,r=<nonce>"
          const mech = body.subarray(0, body.indexOf(0)).toString();
          const first = body.subarray(body.indexOf(0) + 5).toString();
          if (mech !== 'SCRAM-SHA-256' || !first.startsWith('n,,')) return refuse();
          state.first = first.slice(3);
          const nonce = /r=([^,]+)/.exec(state.first)[1] + crypto.randomBytes(12).toString('base64');
          state.salt = crypto.randomBytes(16);
          state.serverFirst = `r=${nonce},s=${state.salt.toString('base64')},i=4096`;
          state.nonce = nonce;
          sock.write(authMsg(11, Buffer.from(state.serverFirst)));
        } else if (type === 'p') { // client-final: "c=biws,r=<nonce>,p=<proof>"
          const final = body.toString();
          const without = final.replace(/,p=[^,]*$/, '');
          const proof = Buffer.from(/,p=([^,]+)$/.exec(final)?.[1] || '', 'base64');
          const salted = crypto.pbkdf2Sync(password, state.salt, 4096, 32, 'sha256');
          const stored = sha256(hmac(salted, 'Client Key'));
          const authMessage = `${state.first},${state.serverFirst},${without}`;
          const sig = hmac(stored, authMessage);
          const key = Buffer.from(proof.map((b, i) => b ^ sig[i]));
          if (!without.includes(`r=${state.nonce}`) || proof.length !== 32 || !sha256(key).equals(stored)) return refuse();
          const serverKey = hmac(forge ? crypto.randomBytes(32) : salted, 'Server Key');
          sock.write(authMsg(12, Buffer.from(`v=${hmac(serverKey, authMessage).toString('base64')}`)));
          signedIn();
        } else if (type === 'Q') {
          const sql = body.subarray(0, -1).toString();
          queries.push(sql);
          let rows;
          try { rows = api.answer(sql); } catch (e) {
            sock.write(Buffer.concat([error('42P01', e.message), ready()]));
            continue;
          }
          const cols = Object.keys(rows[0] || { none: null });
          const parts = [msg('T', Buffer.concat([int16(cols.length),
            ...cols.map((c) => Buffer.concat([cstr(c), Buffer.alloc(18)]))]))];
          for (const r of rows) {
            parts.push(msg('D', Buffer.concat([int16(cols.length), ...cols.map((c) => {
              if (r[c] == null) return int32(-1);
              const v = Buffer.from(String(r[c]));
              return Buffer.concat([int32(v.length), v]);
            })])));
          }
          parts.push(msg('C', cstr(`SELECT ${rows.length}`)), ready());
          sock.write(Buffer.concat(parts));
        }
      }
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return Object.assign(api, {
    PG: { host: '127.0.0.1', port: server.address().port, user, database: 'postiz', password },
    close: () => new Promise((ok) => server.close(ok)),
  });
}
