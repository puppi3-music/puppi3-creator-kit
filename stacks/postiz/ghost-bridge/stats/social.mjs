// stats/social.mjs: the collectors for Bluesky, Threads, TikTok and Mixcloud (stats/stats.mjs runs them), each
// network's account and posts into data/<name>.json.

import { num, text, fetchJson, withHistory, last30, posts30, perDay, postRef, siteLinks, withOlder, DAY, day,
  archiveRead, askLearned, insightValue, insightBreakdown, mergeDaily, toCheck, surgingRefs, postsPerPoll,
  META_CALLS_PER_HOUR, gainsByDay } from './history.mjs';

// ---------- Bluesky ----------
// The Bluesky account and its posts (bluesky.json).
export function bluesky({ env, dataDir, postiz, collector, channel, keepPosts, minutes, enabled, archiveTo }) {
  // ---------- Bluesky ----------
  // The account BLUESKY_HANDLE, else the Bluesky channel's in Postiz, and all its posts. Bluesky's public API needs no
  // sign-in.
  const BSKY_PAGES = 50; // of 100 posts
  const bsky = async (method, params) => {
    const { res, data } = await fetchJson(`https://public.api.bsky.app/xrpc/${method}?${new URLSearchParams(params)}`, {}, 'Bluesky');
    if (!res.ok) throw new Error(`Bluesky ${method}: ${data.message || data.error || res.status}`);
    return data;
  };
  collector('bluesky', 'Bluesky', enabled(env.BSKY_STATS), minutes(env.BSKY_STATS_MINUTES), 35, async (out, prev) => {
    Object.assign(out, { account: null, totals: {}, daily: [], posts: [], postsPerDay: [] });
    try {
      if (!env.BLUESKY_HANDLE && !postiz) throw new Error('needs BLUESKY_HANDLE (or POSTIZ_API_KEY, to use the Bluesky channel in Postiz)');
      const handle = (env.BLUESKY_HANDLE || (await channel(['bluesky'], 'Bluesky')).profile || '').trim().replace(/^@/, '');
      if (!handle) throw new Error('needs BLUESKY_HANDLE (the Bluesky channel in Postiz has no handle)');
      const p = await bsky('app.bsky.actor.getProfile', { actor: handle });
      out.account = { handle: p.handle, name: p.displayName || p.handle, picture: p.avatar || '', url: `https://bsky.app/profile/${p.handle}` };
      out.totals = { followers: num(p.followersCount), following: num(p.followsCount), posts: num(p.postsCount),
        lists: num(p.associated?.lists), feeds: num(p.associated?.feedgens), starterPacks: num(p.associated?.starterPacks) };
      const raw = [];
      try {
        let cursor = '';
        for (let page = 0; page < BSKY_PAGES; page++) {
          const f = await bsky('app.bsky.feed.getAuthorFeed', { actor: p.did, limit: 100, filter: 'posts_no_replies', ...(cursor && { cursor }) });
          for (const { post, reason } of f.feed || []) {
            if (reason || post?.author?.did !== p.did) continue; // reposts of other people's posts
            const time = Date.parse(post.record?.createdAt || post.indexedAt) || null;
            const embed = String(post.record?.embed?.$type || '');
            const { author, viewer, ...whole } = post;
            raw.push({ ref: postRef(post.uri), data: whole });
            out.posts.push({
              id: post.uri, ref: postRef(post.uri), date: time && new Date(time).toISOString(), time, network: 'Bluesky', account: out.account.name,
              links: siteLinks([post.record?.text, post.record?.embed?.external?.uri,
                ...(post.record?.facets || []).flatMap((f) => (f.features || []).map((x) => x.uri))]),
              text: text(post.record?.text), likes: num(post.likeCount), reposts: num(post.repostCount),
              replies: num(post.replyCount), quotes: num(post.quoteCount), bookmarks: num(post.bookmarkCount),
              type: /images/.test(embed) ? 'Images' : /video/.test(embed) ? 'Video' : /external/.test(embed) ? 'Link' : /record/.test(embed) ? 'Quote' : 'Text',
              langs: (post.record?.langs || []).join(','),
              permalink: `https://bsky.app/profile/${p.handle}/post/${String(post.uri).split('/').pop()}`,
            });
          }
          cursor = f.cursor;
          if (!cursor) break;
        }
        await keepPosts(out, 'bluesky', out.posts);
        out.posts = withOlder(prev.posts, out.posts, !cursor);
        // all the posts' likes etc. now, for the hour-by-hour gains between checks (trackAccount)
        for (const k of ['likes', 'reposts', 'replies', 'quotes']) out.totals[k] = out.posts.reduce((a, x) => a + (x[k] || 0), 0);
        posts30(out.posts, ['likes', 'reposts', 'replies', 'quotes', 'bookmarks'], out.totals);
        out.postsPerDay = perDay(out.posts);
      } catch (e) { out.errors.push(`posts: ${e.message}`); Object.assign(out, { posts: prev.posts || [], postsPerDay: prev.postsPerDay || [] }); }
      await archiveTo('bluesky', { account: p, posts: raw });
    } catch (e) { out.errors.push(e.message); }
    const h = withHistory(prev.history, out.totals, ['followers'], 400);
    out.history = h.history;
    // Bluesky has no numbers per day: what the posts gained each day, from their numbers kept per day
    let gains = [];
    try { gains = gainsByDay(dataDir, 'bluesky', ['likes', 'reposts', 'replies', 'quotes']); } catch (e) { out.errors.push(`per day: ${e.message}`); }
    out.daily = mergeDaily(gains.filter((g) => g.date >= (h.daily[0]?.date || '')), h.daily);
    last30(h.daily, ['newFollowers'], out.totals);
  });
}

// ---------- Threads ----------
// The Threads channel in Postiz, and its posts straight from Threads (threads.json).
export function threads({ env, dataDir, PG, collector, channel, postizAnalytics, channelToken, keepPosts, minutes, enabled, archiveTo }) {
  // ---------- Threads ----------
  // All the account's posts are listed; each poll asks for the numbers of the newest THREADS_STATS_POSTS (fewer when
  // META_CALLS_PER_HOUR wouldn't cover them at THREADS_STATS_MINUTES: postsPerPoll) and as many
  // older ones (toCheck: a call per post); the rest keep their last numbers
  const TH_POSTS = Math.min(50, Math.max(1, Number(env.THREADS_STATS_POSTS) || 25));
  const TH_MINUTES = minutes(env.THREADS_STATS_MINUTES);
  let thCalls = 0; // this poll's calls to Threads, for postsPerPoll
  const TH_PAGES = 50; // of 100 posts
  const TH_KEYS = ['views', 'likes', 'replies', 'reposts', 'quotes', 'shares'];
  const thGraph = async (pathAndQuery, token) => {
    thCalls++;
    const url = `https://graph.threads.net/v1.0${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
    const { res, data } = await fetchJson(url, {}, 'Threads');
    if (!res.ok || data.error) {
      const hint = data.error?.code === 190 ? ' (reconnect the Threads channel in Postiz)' : '';
      throw new Error(`Threads ${pathAndQuery.split('?')[0].replace(/\/\d+/, '/<id>')}: ${data.error?.message || res.status}${hint}`);
    }
    return data;
  };
  const metricValues = (data) => Object.fromEntries((data || []).map((m) => [m.name, m.total_value?.value ?? m.values?.[0]?.value ?? null]));
  // The account's numbers per day, straight from Threads (Postiz has only views per day): each a total over the
  // window asked for, so a call per UTC day: today and yesterday every poll, and up to TH_BACKFILL earlier days of the
  // last TH_DAYS not kept yet. Into the archive (days[date].insights, clicks also by link). Threads has none before
  // 13 April 2024.
  const TH_USER_METRICS = ['views', 'likes', 'replies', 'reposts', 'quotes', 'clicks', 'shares'];
  const TH_DAYS = 30;
  const TH_BACKFILL = 10;
  const TH_FIRST = Date.UTC(2024, 3, 13);
  async function thDays(token, learned, known) {
    const today = Date.parse(day(Date.now()));
    const days = {};
    const due = [];
    for (let i = 0; i < TH_DAYS; i++) {
      const start = today - i * DAY;
      if (start >= TH_FIRST && (i < 2 || !known[day(start)]?.insights)) due.push(start);
    }
    let failed = '';
    for (const start of due.slice(0, 2 + TH_BACKFILL)) {
      try {
        const data = await askLearned(learned, 'user', TH_USER_METRICS,
          async (list) => (await thGraph(`/me/threads_insights?metric=${list.join(',')}&since=${start / 1000}&until=${start / 1000 + 86_400}`, token)).data || []);
        const insights = Object.fromEntries(data.map((m) => [m.name, insightValue(m)]));
        const byLink = data.find((m) => m.name === 'clicks')?.link_total_values;
        days[day(start)] = { insights, ...(byLink?.length && { clicksByLink: Object.fromEntries(byLink.map((l) => [l.link_url, l.value])) }) };
      } catch (e) { failed = e.message; }
    }
    return { days, failed: Object.keys(days).length ? '' : failed };
  }
  // Who follows, once a UTC day (Threads gives it from 100 followers): days[date].audience = { <breakdown>: {...} }
  async function thAudience(token) {
    const audience = {};
    for (const by of ['country', 'city', 'age', 'gender']) {
      try {
        const { data = [] } = await thGraph(`/me/threads_insights?metric=follower_demographics&breakdown=${by}`, token);
        audience[by] = insightBreakdown(data[0]);
      } catch { if (by === 'country') break; } // none for this account (under 100 followers): no use asking the rest
    }
    return audience;
  }
  const TH_FIELDS = 'id,text,timestamp,permalink,media_type,link_attachment_url';
  const TH_FIELDS_MORE = `${TH_FIELDS},media_product_type,shortcode,is_quote_post,topic_tag,alt_text,has_replies,reply_audience`;
  collector('threads', 'Threads', enabled(env.THREADS_STATS), TH_MINUTES, 40, async (out, prev) => {
    thCalls = 0;
    Object.assign(out, { account: null, totals: {}, daily: [], posts: [], postsPerDay: [] });
    // per day: views, likes, replies, reposts, quotes from Postiz (its last 30 days), the same and link clicks from
    // Threads (insights, every day kept), over the last file's days (so days past both windows stay)
    const TH_DAILY = { linkClicks: 'clicks', likes: 'likes', replies: 'replies', reposts: 'reposts', quotes: 'quotes' };
    const kept = (prev.daily || []).slice(-400).map(({ followers, newFollowers, ...d }) => d);
    let postizDaily = [];
    let insDaily = [];
    try {
      const ch = await channel(['threads'], 'Threads');
      out.account = { name: ch.name, username: ch.profile || '', picture: ch.picture || '', url: ch.profile ? `https://www.threads.com/@${ch.profile}` : '' };
      if (ch.refreshNeeded) out.errors.push('Postiz says the Threads channel needs reconnecting');
      out.metricsOk = prev.metricsOk || {};
      try {
        const a = await postizAnalytics(ch, 30, [[/view/i, 'views'], [/like/i, 'likes'], [/repl/i, 'replies'], [/repost/i, 'reposts'], [/quote/i, 'quotes']],
          ['views', 'likes', 'replies', 'reposts', 'quotes']);
        if (a.empty) out.errors.push('Postiz analytics: no numbers (is the Threads channel still connected in Postiz?)');
        for (const k of ['views', 'likes', 'replies', 'reposts', 'quotes']) if (`${k}30` in a.totals) out.totals[`${k}30`] = a.totals[`${k}30`];
        postizDaily = a.daily;
      } catch (e) { out.errors.push(`Postiz analytics: ${e.message}`); }
      if (!PG.password) out.errors.push('followers and posts need POSTIZ_DB_PASSWORD set'); // the status tile says so (staging has none)
      if (PG.password) {
        try {
          const token = await channelToken(ch, 'Threads');
          const f = await thGraph('/me/threads_insights?metric=followers_count', token);
          out.totals.followers = num(metricValues(f.data).followers_count);
          try {
            const known = (await archiveRead(dataDir, 'threads')).days || {};
            const { days, failed } = await thDays(token, out.metricsOk, known);
            if (failed) out.errors.push(`insights per day: ${failed}`);
            if (!known[day(Date.now())]?.audience) {
              const audience = await thAudience(token);
              if (Object.keys(audience).length) (days[day(Date.now())] ||= {}).audience = audience;
            }
            await archiveTo('threads', { days });
            // taps on links in the posts, likes, replies, reposts, quotes per day (the per-link split stays in the
            // archive); a number Threads left out keeps Postiz's
            insDaily = Object.entries({ ...known, ...days }).filter(([, d]) => d.insights)
              .map(([date, d]) => ({ date, ...Object.fromEntries(Object.entries(TH_DAILY).filter(([, m]) => d.insights[m] != null).map(([k, m]) => [k, d.insights[m]])) }));
          } catch (e) { out.errors.push(`insights per day: ${e.message}`); }
          const listed = [];
          let after = '';
          let fields = TH_FIELDS_MORE;
          for (let page = 0; page < TH_PAGES; page++) {
            const ask = () => thGraph(`/me/threads?fields=${fields}&limit=100${after && `&after=${encodeURIComponent(after)}`}`, token);
            // the extra fields are newer ones: if Threads refuses one, the list goes on without them
            const r = await ask().catch((e) => { if (fields === TH_FIELDS) throw e; fields = TH_FIELDS; return ask(); });
            listed.push(...(r.data || []).filter((m) => m.media_type !== 'REPOST_FACADE'));
            after = r.paging?.next ? r.paging.cursors?.after || '' : '';
            if (!after) break;
          }
          const was = Object.fromEntries((prev.posts || []).map((p) => [p.ref, p]));
          const posts = listed.map((m) => {
            const ref = postRef(m.id);
            const keep = Object.fromEntries(TH_KEYS.map((k) => [k, was[ref]?.[k] ?? null]));
            return { id: m.id, ref, links: siteLinks([m.text, m.link_attachment_url]), date: m.timestamp, time: Date.parse(m.timestamp) || null,
              network: 'Threads', account: out.account.name, type: String(m.media_type || '').toLowerCase().replace(/_/g, ' '),
              text: text(m.text), ...keep, permalink: m.permalink || '', checked: was[ref]?.checked || null };
          });
          const surging = await surgingRefs(dataDir, 'threads');
          const newest = postsPerPoll({ minutes: TH_MINUTES, used: thCalls, also: surging.size, cap: TH_POSTS });
          const check = toCheck(posts, was, newest, surging);
          out.checking = { posts: check.size, newest, minutes: TH_MINUTES, callsPerHour: META_CALLS_PER_HOUR };
          const fresh = [];
          const raw = Object.fromEntries(listed.map((m) => [postRef(m.id), m]));
          for (const p of posts) {
            if (!check.has(p.ref)) continue;
            p.checked = Date.now(); // asked, so it waits its turn again even when Threads has nothing for it
            try {
              const ins = metricValues((await thGraph(`/${p.id}/insights?metric=${TH_KEYS.join(',')}`, token)).data);
              for (const k of TH_KEYS) p[k] = num(ins[k]);
              raw[p.ref] = { ...raw[p.ref], insights: ins };
              fresh.push(p);
            } catch { /* none for this one: keeps its last numbers */ }
          }
          await keepPosts(out, 'threads', fresh);
          await archiveTo('threads', { posts: Object.entries(raw).map(([ref, data]) => ({ ref, data })) });
          out.posts = withOlder(prev.posts, posts, !after);
          out.postsPerDay = perDay(out.posts);
          // all the posts' likes etc. now, for the hour-by-hour gains between checks (trackAccount): today's account
          // insights so far miss what Threads adds after the UTC day ends. A post's numbers move when it's asked (its turn)
          for (const k of ['likes', 'replies', 'reposts', 'quotes']) out.totals[`post${k[0].toUpperCase()}${k.slice(1)}`] = out.posts.reduce((a, x) => a + (x[k] || 0), 0);
        } catch (e) { out.errors.push(`followers and posts: ${e.message}`); Object.assign(out, { posts: prev.posts || [], postsPerDay: prev.postsPerDay || [] }); }
      }
    } catch (e) { out.errors.push(e.message); }
    const h = withHistory(prev.history, out.totals, ['followers'], 400);
    out.history = h.history;
    out.daily = mergeDaily(kept, postizDaily, insDaily, h.daily);
    last30(h.daily, ['newFollowers'], out.totals);
    last30(out.daily, ['linkClicks'], out.totals);
  });
}

// ---------- TikTok ----------
// The TikTok channel in Postiz, and its videos straight from TikTok (tiktok.json).
export function tiktok({ env, dataDir, PG, collector, channel, postizAnalytics, channelToken, keepPosts, minutes, enabled, archiveTo }) {
  // ---------- TikTok ----------
  // Account numbers through Postiz (which renews the channel's sign-in, good for 23 hours, when it's run out), then
  // the videos straight from TikTok with that token (Postiz's TikTok app asks for video.list and user.info.stats).
  const TT_PAGES = 50; // of 20 videos
  const TT_API = 'https://open.tiktokapis.com/v2';
  const ttApi = async (pathAndQuery, token, body) => {
    const { res, data } = await fetchJson(`${TT_API}${pathAndQuery}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined,
    }, 'TikTok');
    const code = data.error?.code;
    if (!res.ok || (code && code !== 'ok')) {
      const hint = code === 'access_token_invalid' ? ' (Postiz renews it; reconnect TikTok in Postiz if this stays)'
        : code === 'scope_not_authorized' ? ' (reconnect TikTok in Postiz so it asks for every permission again)' : '';
      throw new Error(`TikTok ${pathAndQuery.split('?')[0]}: ${data.error?.message || code || res.status}${hint}`);
    }
    return data.data || {};
  };
  collector('tiktok', 'TikTok', enabled(env.TIKTOK_STATS), minutes(env.TIKTOK_STATS_MINUTES), 45, async (out, prev) => {
    Object.assign(out, { account: null, totals: {}, daily: [], posts: [], postsPerDay: [] });
    try {
      const ch = await channel(['tiktok', 'tiktok-business'], 'TikTok');
      out.account = { name: ch.name, username: ch.profile || '', picture: ch.picture || '' };
      if (ch.refreshNeeded) out.errors.push('Postiz says the TikTok channel needs reconnecting');
      try {
        const a = await postizAnalytics(ch, 7, [[/^followers/i, 'followers'], [/^following/i, 'following'], [/^total likes/i, 'likes'], [/^videos/i, 'videos']], []);
        for (const k of ['followers', 'following', 'likes', 'videos']) if (a.totals[`${k}Latest`] != null) out.totals[k] = a.totals[`${k}Latest`];
        if (a.empty) out.errors.push('Postiz analytics: no numbers (is the TikTok channel still connected in Postiz?)');
      } catch (e) { out.errors.push(`Postiz analytics: ${e.message}`); }
      if (!PG.password) out.errors.push('videos need POSTIZ_DB_PASSWORD set'); // the status tile says so (staging has none)
      if (PG.password) {
        try {
          const token = await channelToken(ch, 'TikTok');
          const u = (await ttApi('/user/info/?fields=open_id,display_name,avatar_url,profile_deep_link,username,bio_description,is_verified,follower_count,following_count,likes_count,video_count', token)).user || {};
          if (u.display_name) out.account = { name: u.display_name, username: u.username || out.account.username, picture: u.avatar_url || out.account.picture, url: u.profile_deep_link || '' };
          for (const [k, f] of [['followers', 'follower_count'], ['following', 'following_count'], ['likes', 'likes_count'], ['videos', 'video_count']]) if (u[f] != null) out.totals[k] = Number(u[f]);
          const fields = 'id,title,video_description,create_time,cover_image_url,share_url,embed_link,view_count,like_count,comment_count,share_count,duration,height,width';
          const raw = [];
          let cursor;
          let more = true;
          for (let page = 0; more && page < TT_PAGES; page++) {
            const r = await ttApi(`/video/list/?fields=${fields}`, token, { max_count: 20, ...(cursor && { cursor }) });
            for (const v of r.videos || []) {
              const time = v.create_time ? v.create_time * 1000 : null;
              raw.push({ ref: postRef(v.id), data: v });
              out.posts.push({
                id: v.id, ref: postRef(v.id), links: siteLinks([v.title, v.video_description]), date: time && new Date(time).toISOString(), time, network: 'TikTok', account: out.account.name,
                text: text(v.title || v.video_description), duration: num(v.duration), views: num(v.view_count), likes: num(v.like_count),
                comments: num(v.comment_count), shares: num(v.share_count), permalink: v.share_url || '',
              });
            }
            more = !!r.has_more;
            cursor = r.cursor;
          }
          await keepPosts(out, 'tiktok', out.posts);
          await archiveTo('tiktok', { account: u, posts: raw });
          out.posts = withOlder(prev.posts, out.posts, !more);
          // all the videos' views etc. now, for the hour-by-hour gains between checks (trackAccount)
          for (const k of ['views', 'comments', 'shares']) out.totals[k] = out.posts.reduce((a, x) => a + (x[k] || 0), 0);
          posts30(out.posts, ['views', 'likes', 'comments', 'shares'], out.totals);
          out.postsPerDay = perDay(out.posts);
        } catch (e) { out.errors.push(`videos: ${e.message}`); Object.assign(out, { posts: prev.posts || [], postsPerDay: prev.postsPerDay || [] }); }
      }
    } catch (e) { out.errors.push(e.message); }
    Object.assign(out, withHistory(prev.history, out.totals, ['followers', 'likes'], 400));
    // views, comments and shares per day: what the videos gained each UTC day (likes per day are the account's newLikes)
    let gains = [];
    try { gains = gainsByDay(dataDir, 'tiktok', ['views', 'comments', 'shares']); } catch (e) { out.errors.push(`per day: ${e.message}`); }
    out.daily = mergeDaily(gains.filter((g) => g.date >= (out.daily[0]?.date || '')), out.daily);
    last30(out.daily, ['newFollowers', 'newLikes'], out.totals);
  });
}

// ---------- Mixcloud ----------
// The Mixcloud profile and its uploads (mixcloud.json).
export function mixcloud({ env, collector, keepPosts, minutes, enabled, archiveTo }) {
  // ---------- Mixcloud ----------
  // The profile MIXCLOUD_USER (address or name); Mixcloud's API is public and has no numbers per day
  const MC_PAGES = 50; // of 100 uploads
  const MC_LINK_LOOKUPS = 10;
  collector('mixcloud', 'Mixcloud', enabled(env.MC_STATS), minutes(env.MC_STATS_MINUTES), 50, async (out, prev) => {
    Object.assign(out, { account: null, totals: {}, daily: [], uploads: [], uploadsPerDay: [] });
    try {
      const user = String(env.MIXCLOUD_USER || '').trim().replace(/^https?:\/\/(www\.)?mixcloud\.com\//, '').replace(/^@|\/+$/g, '');
      if (!user) throw new Error('needs MIXCLOUD_USER (the profile address, e.g. https://www.mixcloud.com/<name>/)');
      const get = async (url) => {
        const { res, data } = await fetchJson(url, {}, 'Mixcloud');
        if (!res.ok || data.error) throw new Error(`Mixcloud: ${data.error?.message || res.status}${res.status === 404 ? ' (is MIXCLOUD_USER the profile address?)' : ''}`);
        return data;
      };
      const u = await get(`https://api.mixcloud.com/${encodeURIComponent(user)}/`);
      out.account = { name: u.name || u.username, username: u.username, picture: u.pictures?.medium || '', url: u.url || `https://www.mixcloud.com/${user}/` };
      out.totals = { followers: num(u.follower_count), following: num(u.following_count), uploads: num(u.cloudcast_count) };
      try {
        const all = [];
        let next = `https://api.mixcloud.com/${encodeURIComponent(user)}/cloudcasts/?limit=100`;
        for (let page = 0; next && page < MC_PAGES; page++) {
          const r = await get(next);
          all.push(...(r.data || []));
          next = r.paging?.next || '';
        }
        const uploads = all.map((c) => ({
          id: c.key, ref: postRef(c.key), links: [], date: c.created_time, time: Date.parse(c.created_time) || null, network: 'Mixcloud', account: out.account.name,
          title: text(c.name), duration: num(c.audio_length), thumbnail: c.pictures?.medium || '', permalink: c.url || '',
          plays: num(c.play_count), favorites: num(c.favorite_count), reposts: num(c.repost_count), comments: num(c.comment_count),
          listeners: num(c.listener_count), tags: (c.tags || []).map((t) => t.name).filter(Boolean).join(', '),
        })).sort((a, b) => (b.time || 0) - (a.time || 0));
        for (const k of ['plays', 'favorites', 'reposts', 'comments']) out.totals[k] = uploads.reduce((a, c) => a + (c[k] || 0), 0);
        out.totals.listeners = uploads.some((c) => c.listeners != null) ? uploads.reduce((a, c) => a + (c.listeners || 0), 0) : null;
        const raw = all.map((c) => ({ ref: postRef(c.key), data: c }));
        out.uploads = withOlder(prev.uploads, uploads, !next);
        // the site links in each upload's description (only in its own details, not the list): looked up once per
        // upload and kept in linksByRef, the newest MC_LINK_LOOKUPS a poll; the rest wait for the next one
        out.linksByRef = {};
        let lookups = 0;
        for (const c of out.uploads) {
          let links = prev.linksByRef?.[c.ref] || (c.links?.length ? c.links : null);
          if (!links && lookups < MC_LINK_LOOKUPS) {
            lookups++;
            try {
              const detail = await get(`https://api.mixcloud.com${c.id}`);
              links = siteLinks([detail.description]);
              raw.push({ ref: c.ref, data: detail }); // the description, sections (tracklist) and more, only in its own details
            } catch { /* next poll */ }
          }
          if (links) out.linksByRef[c.ref] = c.links = links;
        }
        out.uploadsPerDay = perDay(out.uploads);
        await keepPosts(out, 'mixcloud', uploads);
        await archiveTo('mixcloud', { account: u, posts: raw });
      } catch (e) { out.errors.push(`uploads: ${e.message}`); out.uploads = prev.uploads || []; out.linksByRef = prev.linksByRef || {}; }
    } catch (e) { out.errors.push(e.message); }
    Object.assign(out, withHistory(prev.history, out.totals, ['followers', 'plays', 'favorites', 'reposts', 'comments'], 400));
    last30(out.daily, ['newFollowers', 'newPlays', 'newFavorites'], out.totals);
  });
}
