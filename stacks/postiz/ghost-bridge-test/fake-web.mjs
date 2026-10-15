// A fake of every web service the bridge asks (Postiz, Ghost, the networks' APIs): fetch is replaced, and each test
// says what an address answers. Nothing leaves the machine; an address no test answered gets a 599 and is noted in
// web.unanswered, so a test can check the collector asked nothing it didn't expect.
//   web.on('https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile', { handle: ... })   JSON, 200
//   web.on(/graph\.threads\.net\/v1\.0\/me\/threads\?/, (url, req) => ({ status: 400, body: {...} }))
// The first rule whose address starts with the string (or matches the RegExp) answers; a later on() for the same
// address goes first, so a test can change one answer. web.asked: every request, { method, url, body, headers }.

export const web = {
  rules: [],
  asked: [],
  unanswered: [],
  on(match, reply) { this.rules.unshift({ match, reply }); return this; },
  reset() { this.rules = []; this.asked = []; this.unanswered = []; },
  // the requests whose address starts with (or matches) match
  calls(match) { return this.asked.filter((a) => matches(match, a.url)); },
};

const matches = (match, url) => (match instanceof RegExp ? match.test(url) : url.startsWith(match));

globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const body = init.body == null ? null : String(init.body);
  const headers = Object.fromEntries(new Headers(init.headers || {}));
  const req = { method: (init.method || 'GET').toUpperCase(), url, body, headers };
  web.asked.push(req);
  const rule = web.rules.find((r) => matches(r.match, url));
  if (!rule) {
    web.unanswered.push(`${req.method} ${url}`);
    return new Response(JSON.stringify({ error: `the fake web has no answer for ${url}` }), { status: 599 });
  }
  let out = typeof rule.reply === 'function' ? await rule.reply(new URL(url), req) : rule.reply;
  // a plain object or list is a 200 with it as JSON; { status, body } says more
  if (!(out && typeof out === 'object' && 'status' in out && 'body' in out)) out = { status: 200, body: out };
  if (out.throw) throw new TypeError('fetch failed', { cause: { code: out.throw } });
  const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
  return new Response(text, { status: out.status, headers: { 'Content-Type': 'application/json' } });
};
