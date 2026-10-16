// pages/preview-render.mjs: the Social preview pages: a rough mock-up of each channel's post (the caption as
// the bridge builds it, every image and video it would send, and the platform's basic layout), plus the
// page's styles and script. Rendering only: the bridge collects what a publish would do (a "pv") and
// passes its settings in; this file reads and writes nothing. Not a copy of each app.

// The bridge is part of Puppi3's Creator Kit (AGPL-3.0): its pages link the kit's source, so a site running it
// unchanged offers its visitors the source as the licence asks
const SOURCE_URL = 'https://github.com/puppi3-music/puppi3-creator-kit';
const sourceLink = `<p class="source"><a href="${SOURCE_URL}">Source</a></p>`;

export const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// logo: each app's mark (24x24, filled in its colour; Threads/TikTok use the text colour), shown before its name
const PLATFORMS = {
  bluesky: { name: 'Bluesky', hard: 300, links: true, shortLinks: true, color: '#1185fe',
    logo: '<path d="M5.2 2.8C7.95 4.75 10.9 8.7 12 10.8c1.1-2.1 4.05-6.05 6.8-8 1.98-1.4 5.2-2.48 5.2 1 0 .7-.4 5.8-.63 6.64-.8 2.9-3.75 3.64-6.37 3.2 4.58.78 5.75 3.37 3.23 5.96-4.78 4.9-6.87-1.23-7.4-2.8-.1-.29-.15-.43-.15-.3 0-.13-.05.01-.15.3-.53 1.57-2.62 7.7-7.4 2.8-2.52-2.59-1.35-5.18 3.23-5.96-2.62.44-5.57-.3-6.37-3.2C.4 9.57 0 4.5 0 3.8c0-3.48 3.22-2.4 5.2-1z"/>' },
  threads: { name: 'Threads', hard: 500, links: true, color: 'currentColor',
    logo: '<g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12.3" r="3.4"/>'
      + '<path d="M15.4 11c0-3.3 4.6-2.6 3.6 1.9-.6 2.9-3.4 3.4-5 2.6M18.3 6.3A8.6 8.6 0 1 0 17.6 18.6"/></g>' },
  instagram: { name: 'Instagram', hard: 2200, fold: 125, color: '#e4405f',
    logo: '<g fill="none" stroke="currentColor" stroke-width="2.2"><rect x="2.5" y="2.5" width="19" height="19" rx="5.5"/>'
      + '<circle cx="12" cy="12" r="4.3"/></g><circle cx="17.4" cy="6.6" r="1.3"/>' },
  tiktok: { name: 'TikTok', hard: 2200, fold: 80, color: 'currentColor',
    logo: '<path d="M16.6 1.5c.3 2.6 1.9 4.4 4.9 4.8v3.4c-1.8.1-3.4-.5-4.9-1.5v6.6c0 7.8-8.5 10.2-11.9 4.6-2.2-3.6-.9-9.9 6.2-10.2v3.6c-.5.1-1 .2-1.5.4-1.6.5-2.5 1.5-2.2 3.3.5 3.4 6.4 4.4 5.9-2.3V1.5z"/>' },
};
const logo = (p) => (p.logo ? `<svg class="logo" viewBox="0 0 24 24" aria-hidden="true" style="color:${p.color}" fill="currentColor">${p.logo}</svg>` : '');
PLATFORMS['instagram-standalone'] = PLATFORMS.instagram;
PLATFORMS['tiktok-business'] = PLATFORMS.tiktok;
// The featured link's name without its emoji ("🔗 Featured link" -> "Featured link")
const words = (label) => label.replace(/^\P{L}+/u, '');
export const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

const shortUrl = (u) => {
  const s = u.replace(/^https?:\/\/(www\.)?/, '');
  return s.length > 30 ? s.slice(0, 28) + '…' : s;
};

// Links clickable where the platform makes them clickable; hashtags and @mentions highlighted
function richText(text, { links = false, shortLinks = false } = {}) {
  return esc(text).replace(/(https?:\/\/[^\s<"]+)|([#@][\p{L}\p{N}_.]*[\p{L}\p{N}_])/gu, (m, u) => {
    if (!u) return `<span class="tag">${m}</span>`;
    if (!links) return `<span class="deadlink" title="Links aren't clickable here">${m}</span>`;
    return `<a href="${u}" target="_blank" rel="noopener">${shortLinks ? esc(shortUrl(u)) : m}</a>`;
  });
}

// Instagram/TikTok only show the start of a caption until you tap "more"
function foldedText(text, fold, opts) {
  const chars = Array.from(text);
  const nl = text.indexOf('\n');
  const cut = Math.min(fold, nl >= 0 ? Array.from(text.slice(0, nl)).length : Infinity);
  if (cut >= chars.length) return richText(text, opts);
  return `<details class="fold"><summary>${richText(chars.slice(0, cut).join(''), opts)}<span class="more"> … more</span></summary>`
    + `${richText(chars.slice(cut).join(''), opts)}</details>`;
}

function avatar(e) {
  const letter = esc(Array.from(e.name || e.handle || '?')[0].toUpperCase());
  const img = e.picture ? `<img src="${escAttr(e.picture)}" alt="" onerror="this.remove()">` : '';
  return `<span class="avatar">${letter}${img}</span>`;
}

// Each app's icons, drawn only so the mock-up looks like the app (nothing to click)
const ICONS = {
  heart: '<path d="M12 20.5s-7.6-4.6-9.2-9.6C1.8 7.7 3.9 4.8 7 4.8c2 0 3.6 1.1 5 2.9 1.4-1.8 3-2.9 5-2.9 3.1 0 5.2 2.9 4.2 6.1-1.6 5-9.2 9.6-9.2 9.6z"/>',
  comment: '<path d="M20.5 11.5a8.5 8.5 0 0 1-12.7 7.4L3.5 20l1.2-4.1a8.5 8.5 0 1 1 15.8-4.4z"/>',
  repost: '<path d="M17 3l3.5 3.5L17 10M20.5 6.5H8a4 4 0 0 0-4 4V12M7 21l-3.5-3.5L7 14M3.5 17.5H16a4 4 0 0 0 4-4V12"/>',
  send: '<path d="M21.5 3L10 14.5M21.5 3l-7 18.5-4.5-7-7-4.5z"/>',
  bookmark: '<path d="M6 3.5h12v17l-6-4.5-6 4.5z"/>',
  share: '<path d="M14 4.5l7.5 7-7.5 7v-4c-5 0-8.8 1.6-11 5.5.8-5.4 4-10.3 11-11.2z"/>',
  dots: '<circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/>',
};
const icons = (...names) => names.map((n) => (n === '|' ? '<span class="grow"></span>'
  : `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`)).join('');

// One image (opens full size) or video (with the browser's controls)
// With frames (Instagram), a photo sits where it was placed; pan = it can be dragged there (no link then)
function mediaTag(m, cls = '', { frames = null, pan = false } = {}) {
  if (!m?.url) return '';
  if (m.kind === 'video') return `<video class="${cls}" src="${escAttr(m.url)}#t=0.1" controls playsinline preload="metadata"></video>`;
  const at = frames?.[m.src || m.url];
  const img = `<img class="${cls}" src="${escAttr(m.url)}" alt="" loading="lazy" draggable="false"`
    + `${frames ? ` data-src="${escAttr(m.src || m.url)}"` : ''}${at ? ` style="object-position:${at[0]}% ${at[1]}%"` : ''}>`;
  return pan ? img : `<a href="${escAttr(m.url)}" target="_blank" rel="noopener">${img}</a>`;
}

// Several images: Bluesky's grid, or a carousel (swipe, scroll or the arrows; a counter shows where you are)
function mediaSet(list, { grid = false, cls = '', ...opts } = {}) {
  if (list.length <= 1) return mediaTag(list[0], cls, opts);
  if (grid) return `<div class="mgrid n${list.length}">${list.map((m) => mediaTag(m)).join('')}</div>`;
  return `<div class="swipe"><div class="strip ${cls}">${list.map((m) => mediaTag(m, '', opts)).join('')}</div>`
    + '<button type="button" class="nav prev" data-dir="-1" aria-label="Previous photo" hidden>‹</button>'
    + '<button type="button" class="nav next" data-dir="1" aria-label="Next photo">›</button>'
    + `<span class="counter"><span class="i">1</span> / ${list.length}</span></div>`;
}

function previewCard(e, pv, s) {
  const { LIMITS, IMAGE_LIMITS, INSTAGRAM_IDS, TIKTOK_IDS, NO_LINK_IDS, CUSTOM_CHANNELS, CUSTOM_MAX, STICKER_TEXT_MAX, MANUAL_DRAFTS,
    channelKey } = s;
  const p = PLATFORMS[e.idf] || { name: e.idf, hard: 500 };
  const story = e.label.endsWith(':story');
  const isIG = INSTAGRAM_IDS.includes(e.idf);
  const isTT = TIKTOK_IDS.includes(e.idf);
  const who = esc(e.handle || e.name);
  const len = Array.from(e.caption || '').length;
  const budget = LIMITS[e.idf];
  const list = e.media || [];
  const n = list.length;
  const format = story ? 'Story' : isIG && pv.media?.kind === 'video' ? 'Reel'
    : isTT && pv.media?.kind === 'image' ? `Photo post${n > 1 ? ` (${n})` : ''}`
    : pv.media ? (pv.media.audiogram ? 'Audio clip' : pv.media.kind === 'video' ? 'Video'
      : n > 1 ? (e.idf === 'bluesky' ? `${n} images` : `Carousel (${n})`) : 'Image') : 'Text';
  const status = e.note ? [e.status, e.note] : e.status === 'auto' ? ['auto', 'Posts automatically']
    : e.status === 'manual' ? ['manual', MANUAL_DRAFTS ? `Postiz draft + ntfy: you post it in the app (${e.why})` : `ntfy only: you post it in the app (${e.why})`]
    : ['skip', `Not posted: ${e.why}`];

  const video = list[0]?.kind === 'video' ? ' has-video' : '';
  // Instagram feed photos: placed as saved; on a draft preview they can be dragged
  const frames = isIG && !story && list[0]?.kind === 'image' ? pv.custom?.frames || {} : null;
  const pan = !!(frames && pv.draft);

  let body;
  if (e.status === 'skip') {
    body = '<div class="skipped">Nothing goes to this channel.</div>';
  } else if (story) {
    body = `<div class="phone${video}">${mediaSet(list, { cls: 'fill' }) || '<div class="nomedia">No media</div>'}
      ${e.stickerOn ? `<div class="sticker${e.stickerUrl ? '' : ' plain'}">${e.stickerUrl ? '🔗 ' : ''}${esc(e.stickerText || shortUrl(e.stickerUrl))}</div>` : ''}<div class="bars"></div><div class="over top">${avatar(e)}<b>${who}</b><span class="soft">now</span></div>
      <div class="over reply"><span class="field">Send message</span><span class="icons">${icons('heart', 'send')}</span></div></div>
      <div class="dim small">${e.stickerOn && e.stickerUrl ? `No caption. The sticker links to ${esc(e.stickerUrl)}${e.stickerText ? ` and says "${esc(e.stickerText)}"` : ''}.`
        : e.stickerOn ? `No caption. Its text, with no link: "${esc(e.stickerText)}".`
        : e.stickerPicked ? 'No caption. The sticker has no link and no text, so there\'s nothing to add.'
        : 'stickerAuto' in e ? 'No caption and no sticker.'
        : 'No caption. Add a link sticker in the app.'}</div>`;
  } else if (isTT) {
    body = `<div class="phone${video}">${mediaSet(list, { cls: 'fill' }) || '<div class="nomedia">No media</div>'}
      <div class="rail">${avatar(e)}<span class="icons col">${icons('heart', 'comment', 'bookmark', 'share')}</span></div>
      <div class="over bottom"><b>@${who}</b><div class="cap">${foldedText(e.caption, p.fold, p)}</div>
      <div class="soft">♫ ${pv.media?.audiogram ? 'original sound - your audio clip' : pv.media?.kind === 'video' ? 'original sound' : 'Add a sound in the app'}</div></div></div>`;
  } else if (isIG) {
    body = `<header class="who">${avatar(e)}<b>${who}</b><span class="grow"></span><span class="icons">${icons('dots')}</span></header>
      <div class="square${pv.media?.kind === 'video' ? ' reel' : `" data-fit="1${pan ? '" data-pan="1' : ''}`}">${mediaSet(list, { cls: 'fill', frames, pan })}</div>
      ${pan ? '<div class="pan-note">Drag a photo to line it up in the frame (double-click centres it). It\'s cropped like this when it posts.</div>' : ''}
      <div class="icons bar">${icons('heart', 'comment', 'send', '|', 'bookmark')}</div>
      <div class="cap"><b>${who}</b> ${foldedText(e.caption, p.fold, p)}</div><div class="dim small">Just now</div>`;
  } else {
    const bsky = e.idf === 'bluesky';
    body = `<header class="who">${avatar(e)}<div class="grow"><b>${esc(bsky ? e.name : who)}</b>
      ${bsky && e.handle ? `<span class="dim">@${esc(e.handle)}</span>` : ''} <span class="dim">· now</span></div><span class="icons">${icons('dots')}</span></header>
      <div class="cap">${richText(e.caption, p)}</div>${mediaSet(list, { grid: bsky, cls: 'media' })}
      <div class="icons bar ${bsky ? 'spread' : ''}">${bsky ? icons('comment', 'repost', 'heart', 'dots') : icons('heart', 'comment', 'repost', 'send')}</div>`;
  }
  const total = pv.media?.kind === 'image' ? pv.media.count : 0;
  const fewer = e.status !== 'skip' && total > n ? `<div class="count">${n} of the post's ${total} images`
    + `${story ? ' (a Story takes one)' : n === IMAGE_LIMITS[e.idf] ? ` (${p.name}'s limit)` : ' (the rest couldn\'t be made to fit; see the log)'}</div>` : '';
  const count = fewer + (e.status === 'skip' || story ? '' : `<div class="count ${len > p.hard ? 'over' : ''}">${len} characters`
    + ` · bridge budget ${budget ?? '?'} · ${p.name} limit ${p.hard}</div>`);
  const key = channelKey(e.idf);
  const own = pv.custom?.[key] || '';
  const auto = (typeof pv.autoText === 'string' ? pv.autoText : pv.autoText?.[key]) || ''; // a string in older saved previews
  // Draft previews, a Story posted by hand (e.stickerAuto set): its sticker, on or off (e.stickerPicked), its link
  // (e.stickerChosen: '' automatic, 'none' or an address) and its text
  const chosen = e.stickerChosen || '';
  const otherLink = !!chosen && chosen !== 'none';
  const linkOpt = (value, label, on) => `<option value="${escAttr(value)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
  const stickerEditor = !pv.draft || !story || !('stickerAuto' in e) ? ''
    : `<div class="editor"><label class="toggle"><input type="checkbox" data-sticker-on${e.stickerPicked ? ' checked' : ''}> Sticker</label>`
      + `<span class="lsaved ssaved" aria-live="polite"></span><div class="box"${e.stickerPicked ? '' : ' hidden'}>`
      + `<label for="sticker-link">Sticker link</label><select id="sticker-link" data-sticker-link>`
      + linkOpt('', `Automatic: ${e.stickerAuto}`, !chosen) + linkOpt('none', 'No link: text only', chosen === 'none')
      + linkOpt('other', 'Another address…', otherLink) + `</select>`
      + `<input type="url" data-sticker-other placeholder="https://…" value="${escAttr(otherLink ? chosen : '')}"${otherLink ? '' : ' hidden'}>`
      + `<div class="hint">Automatic is the ${esc(words(s.FEATURED_LABEL))} above, else the post. An address on the site is`
      + ` tagged for Instagram like the post's.</div>`
      + `<label for="sticker-text">Sticker text</label>`
      + `<input id="sticker-text" data-sticker maxlength="${STICKER_TEXT_MAX}" value="${escAttr(e.stickerText || '')}"`
      + ` placeholder="${escAttr(e.stickerUrl ? shortUrl(e.stickerUrl) : 'what it says')}">`
      + `<div class="hint">${e.stickerUrl ? 'Empty = Instagram shows the address. ' : 'With no link, add it with Aa in the app. '}`
      + `Instagram's API can't add stickers, so your reminder gives the link and text to copy${e.stickerUrl
        ? ': in the app, tap "Customize sticker text" after adding the link' : ''}.</div></div></div>`;
  // Draft previews, any Instagram Story: a time of its own (e.storyAt, ISO; shown and typed in SITE_TIMEZONE)
  const tz = s.SITE_TIMEZONE || 'Etc/UTC';
  // unset: it shows the post's own time in Ghost (none for a draft: it goes when you publish)
  const local = (iso) => (iso ? new Date(iso).toLocaleString('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(' ', 'T').slice(0, 16) : '');
  const localAt = local(e.storyAt) || local(e.postAt);
  const timeEditor = !pv.draft || !story ? ''
    : `<div class="editor"><label class="toggle" for="story-at">Post the Story at</label>`
      + `<input id="story-at" type="datetime-local" data-story-at value="${escAttr(localAt)}">`
      + `${e.storyAt ? ' <button type="button" class="linkish" data-story-now>With the post</button>' : ''}`
      + `<span class="lsaved tsaved" aria-live="polite"></span>`
      + `<div class="hint">${esc(tz)} time. ${e.storyAt ? '' : e.postAt ? 'The same time as the post in Ghost, until you change it. '
        : 'The same time as the post: when you publish it, until you set a time. '}${e.status === 'auto' ? 'Postiz posts it then.'
        : 'Your reminder for it comes then.'}${e.storyLate ? ' <b>That time comes before the post goes out, so the Story goes with the post.</b>' : ''}</div></div>`;
  // Draft previews: the channel's own text, behind a checkbox (saved as you type)
  const editor = !pv.draft ? '' : story ? timeEditor + stickerEditor : e.status === 'skip' || !CUSTOM_CHANNELS.includes(key) ? ''
    : `<div class="editor"><label class="toggle"><input type="checkbox" data-custom="${key}"${own ? ' checked' : ''}>`
      + ` Modify text for ${esc(p.name)}</label><div class="box"${own ? '' : ' hidden'}>`
      + `<textarea data-channel="${key}" data-auto="${escAttr(auto)}" rows="5" maxlength="${CUSTOM_MAX}" spellcheck="true">${esc(own || auto)}</textarea>`
      + `<div class="emeta"><span class="len"></span><span class="saved" aria-live="polite">${own ? 'Saved' : ''}</span></div>`
      + `<div class="hint">${NO_LINK_IDS.includes(e.idf) ? 'Used instead of the post text here. The "link in bio" line is still added.'
        : `Used instead of the post text here. The post link (and ${esc(words(s.FEATURED_LABEL))}) are added after it, unless your text has them.`}`
      + ` Hashtags at the end are dropped first if it's too long.</div></div></div>`;
  return `<section class="card" data-url="${escAttr(pv.post.url || '')}" data-label="${escAttr(e.label)}" data-channel="${key}">
    <h2>${logo(p)}${esc(p.name)} <span class="dim">${esc(e.name || '')} · ${esc(format)}${own ? ' · modified text' : ''}</span></h2>
    <div class="status ${status[0]}">${esc(status[1])}</div>${editor}<div class="mock">${body}</div><div class="counts">${count}</div></section>`;
}

const PREVIEW_CSS = `
:root{--bg:#f4f4f6;--card:#fff;--text:#16161a;--dim:#6b6b76;--line:#e2e2e8;--link:#1d6ff2;--tag:#1d6ff2;
--auto:#1f7a3f;--auto-bg:#e3f4e8;--manual:#8a5a00;--manual-bg:#fdf1d8;--skip:#9b1c1c;--skip-bg:#fbe4e4}
@media (prefers-color-scheme:dark){:root{--bg:#111114;--card:#1c1c21;--text:#ececf1;--dim:#9a9aa6;--line:#2e2e36;
--link:#6ea8ff;--tag:#6ea8ff;--auto:#7bd69a;--auto-bg:#15301f;--manual:#f2c46b;--manual-bg:#352a12;--skip:#f19a9a;--skip-bg:#3a1a1a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);
font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:1300px;margin:0 auto;padding:24px 16px 48px}
.source{margin:0 auto;padding:0 16px 24px;text-align:center;font-size:12px}.source a{color:var(--dim)}
h1{font-size:22px;margin:0 0 4px}a{color:var(--link)}.dim{color:var(--dim);font-weight:400}.small{font-size:12px;margin-top:6px}
.meta{color:var(--dim);margin-bottom:20px}.meta span{margin-right:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px;align-items:start}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;min-width:0}
.card h2{font-size:16px;margin:0 0 8px}
.card h2 .logo{width:18px;height:18px;vertical-align:-3px;margin-right:7px}
.status{font-size:13px;padding:6px 10px;border-radius:8px;margin-bottom:12px}
.status.auto{color:var(--auto);background:var(--auto-bg)}.status.manual{color:var(--manual);background:var(--manual-bg)}
.status.skip{color:var(--skip);background:var(--skip-bg)}
.who{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.avatar{position:relative;flex:none;width:36px;height:36px;border-radius:50%;background:var(--line);
display:grid;place-items:center;font-weight:600;overflow:hidden}
.avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.cap{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}.tag{color:var(--tag)}
.deadlink{text-decoration:underline dotted;color:inherit}
.fold summary{list-style:none;cursor:pointer;display:inline}.fold summary::-webkit-details-marker{display:none}
.fold[open] .more{display:none}.more{color:var(--dim)}
img,video{display:block;max-width:100%}.media{width:100%;border-radius:10px;border:1px solid var(--line)}
.fill{width:100%;height:100%;object-fit:cover}
.strip img,.strip video{flex:0 0 100%;width:100%;height:100%;object-fit:cover;scroll-snap-align:start}
.phone img,.phone video{object-fit:contain}
[data-pan] img{cursor:grab;touch-action:none;user-select:none}[data-pan] img:active{cursor:grabbing}
.pan-note{font-size:12px;color:var(--dim);margin:6px 0 0}
.square{aspect-ratio:4/5;background:#000;margin:0 -14px}.square.reel{aspect-ratio:9/16}
.square>a,.phone>a,.strip>a{display:contents}
.swipe{position:relative;height:100%}.strip{display:flex;height:100%;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none}
.strip::-webkit-scrollbar{display:none}
.nav{position:absolute;top:50%;transform:translateY(-50%);z-index:3;width:32px;height:32px;border-radius:50%;border:0;
background:rgba(255,255,255,.9);color:#111;font-size:22px;line-height:1;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.3)}
.nav[hidden]{display:none}.nav.prev{left:8px}.nav.next{right:8px}.phone .nav.next{right:58px}
.counter{position:absolute;top:10px;right:10px;z-index:3;background:rgba(0,0,0,.6);color:#fff;font-size:12px;
padding:3px 8px;border-radius:999px}.phone .counter{top:auto;bottom:auto;top:44px}
.strip.media{height:auto;aspect-ratio:4/5;border:0}.strip.media img{height:100%;width:100%;object-fit:cover;border-radius:10px}
.mgrid{display:grid;grid-template-columns:1fr 1fr;gap:4px;border-radius:10px;overflow:hidden}
.mgrid img{width:100%;height:100%;aspect-ratio:1;object-fit:cover}.mgrid.n3 a:first-child{grid-row:span 2}
.mgrid.n3 a:first-child img{aspect-ratio:auto}
.nomedia{display:grid;place-items:center;height:100%;color:#aaa}
.grow{flex:1}.icons{display:inline-flex;gap:14px;align-items:center;color:var(--text)}
.icons svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.icons.bar{display:flex;margin:10px 0 4px}.icons.bar.spread{justify-content:space-between;color:var(--dim);padding-right:30%}
.phone{position:relative;aspect-ratio:9/16;background:#000;border-radius:12px;overflow:hidden;color:#fff}
.sticker{position:absolute;left:50%;top:62%;transform:translateX(-50%);z-index:2;background:#fff;color:#1d6ff2;font-weight:600;
font-size:14px;padding:8px 14px;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,.35);white-space:nowrap;max-width:85%;
overflow:hidden;text-overflow:ellipsis}.sticker.plain{color:#16161a}
.phone .over{position:absolute;left:0;right:0;padding:12px;z-index:2;pointer-events:none;text-shadow:0 1px 3px rgba(0,0,0,.7)}
.phone .over .fold,.phone .over a{pointer-events:auto}.phone .cap{margin:4px 0}.phone .tag{color:#fff;font-weight:600}
.phone .soft,.phone .more{color:rgba(255,255,255,.8);font-size:13px}.phone .deadlink{color:#fff}
.over.top{top:10px;display:flex;gap:8px;align-items:center;background:linear-gradient(rgba(0,0,0,.35),transparent)}
.over.bottom{bottom:0;right:56px;background:linear-gradient(transparent,rgba(0,0,0,.6));padding-top:40px}
.has-video .over.bottom,.has-video .rail{bottom:44px}.has-video .over.reply{display:none}
.over.reply{bottom:0;display:flex;gap:10px;align-items:center}.over.reply .icons{color:#fff}
.field{flex:1;border:1px solid rgba(255,255,255,.7);border-radius:999px;padding:8px 14px;font-size:14px}
.bars{position:absolute;top:8px;left:8px;right:8px;height:3px;border-radius:2px;background:rgba(255,255,255,.4);z-index:2}
.rail{position:absolute;right:8px;bottom:16px;z-index:2;display:flex;flex-direction:column;align-items:center;gap:14px;pointer-events:none}
.rail .avatar{border:2px solid #fff}.icons.col{flex-direction:column;gap:18px;color:#fff}
.icons.col svg{width:30px;height:30px;fill:#fff;stroke:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}
.skipped{color:var(--dim);padding:24px 0;text-align:center}
.count{font-size:12px;color:var(--dim);margin-top:10px}.count.over{color:var(--skip);font-weight:600}
.editor{margin:0 0 12px}.toggle{display:flex;gap:8px;align-items:center;font-size:14px;cursor:pointer}
.box{margin-top:8px}.box textarea{width:100%;min-height:110px;resize:vertical;border:1px solid var(--line);border-radius:8px;
background:var(--bg);color:var(--text);font:inherit;font-size:14px;padding:8px 10px}
.box textarea:focus{outline:2px solid var(--link);outline-offset:-1px}
.emeta{display:flex;justify-content:space-between;font-size:12px;color:var(--dim);margin-top:4px}.saved.err{color:var(--skip)}
.hint{font-size:12px;color:var(--dim);margin-top:4px}.card.busy .mock{opacity:.6;transition:opacity .2s}
.editor .box label[for]{display:block;margin-top:8px;font-weight:600}
.linkish{font:inherit;background:none;border:0;color:var(--link);cursor:pointer;padding:0 4px;text-decoration:underline}
#story-at,#sticker-link,#sticker-text,[data-sticker-other]{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:5px 8px;width:100%;margin-top:6px}
.listen{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin:0 0 20px}
.listen label{font-weight:600;margin-right:8px}.listen select,.listen input{font:inherit;color:inherit;background:var(--bg);
border:1px solid var(--line);border-radius:8px;padding:5px 8px;max-width:100%}.listen input{width:32em;margin-top:6px}
.lsaved{font-size:12px;color:var(--dim);margin-left:8px}.lsaved.err{color:var(--skip)}
.banner{background:var(--manual-bg);color:var(--text);border-radius:10px;padding:10px 14px;margin:-6px 0 20px}
.notes,.log{margin-top:28px}.notes h2,.log summary{font-size:16px}
.note{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:8px 0;white-space:pre-wrap}
.note .buttons{display:block;margin-top:8px;font-size:13px;color:var(--dim);white-space:normal}
pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;overflow-x:auto;font-size:12px}
ul.list{list-style:none;padding:0}ul.list li{background:var(--card);border:1px solid var(--line);border-radius:10px;
padding:10px 14px;margin:8px 0}`;

// Carousels (arrows, counter, pausing videos you scroll away from) and, on draft previews, "Modify text"
const PREVIEW_JS = `(function () {
function fit(img) {
  var box = img.closest('[data-fit]'); if (!box || box.querySelector('img') !== img || !img.naturalWidth) return;
  box.style.aspectRatio = String(Math.min(1.91, Math.max(0.8, img.naturalWidth / img.naturalHeight)));
}
function fitAll() {
  document.querySelectorAll('[data-fit] img').forEach(function (i) {
    if (i.complete) fit(i); else i.addEventListener('load', function () { fit(i); });
  });
}
fitAll();
// Instagram framing (draft previews): drag a photo within the frame, saved when you let go
var base = location.pathname.replace(/[/]?$/, '/'), drag = null;
document.addEventListener('pointerdown', function (e) {
  var img = e.target.closest('[data-pan] img'); if (!img || !img.naturalWidth) return;
  e.preventDefault();
  var b = img.getBoundingClientRect(), r = img.naturalWidth / img.naturalHeight, br = b.width / b.height;
  var pos = (img.style.objectPosition || '50% 50%').split(' ').map(parseFloat);
  // how far the photo reaches past the frame: only that direction moves
  drag = { img: img, x: e.clientX, y: e.clientY, px: pos[0], py: pos[1], moved: false,
    ox: r > br ? b.height * r - b.width : 0, oy: r < br ? b.width / r - b.height : 0 };
  try { img.setPointerCapture(e.pointerId); } catch (x) { /* drag still works without it */ }
});
document.addEventListener('pointermove', function (e) {
  if (!drag) return;
  var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
  var px = drag.ox ? Math.min(100, Math.max(0, drag.px - dx / drag.ox * 100)) : 50;
  var py = drag.oy ? Math.min(100, Math.max(0, drag.py - dy / drag.oy * 100)) : 50;
  drag.img.style.objectPosition = px.toFixed(1) + '% ' + py.toFixed(1) + '%';
});
document.addEventListener('pointerup', function () {
  var d = drag; drag = null;
  if (d && d.moved) saveFrame(d.img, false);
});
document.addEventListener('dblclick', function (e) {
  var img = e.target.closest('[data-pan] img'); if (!img) return;
  img.style.objectPosition = ''; saveFrame(img, true);
});
function saveFrame(img, centre) {
  var p = (img.style.objectPosition || '50% 50%').split(' ').map(parseFloat);
  var note = img.closest('.card').querySelector('.pan-note');
  fetch(base + 'frame', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ src: img.dataset.src, x: centre ? null : p[0], y: centre ? null : p[1] }) })
    .then(function (r) { if (!r.ok) throw new Error(r.status); if (note) note.textContent = centre ? 'Centred again. Saved.' : 'Framing saved. It is cropped like this when it posts.'; })
    .catch(function () { if (note) note.textContent = "Couldn't save the framing."; });
}
document.addEventListener('click', function (e) {
  var b = e.target.closest('.swipe .nav'); if (!b) return;
  var s = b.parentElement.querySelector('.strip');
  s.scrollBy({ left: Number(b.dataset.dir) * s.clientWidth, behavior: 'smooth' });
});
document.addEventListener('scroll', function (e) {
  var s = e.target; if (!s.classList || !s.classList.contains('strip')) return;
  var w = s.parentElement, n = s.querySelectorAll('img,video').length, i = Math.round(s.scrollLeft / s.clientWidth);
  w.querySelector('.i').textContent = i + 1;
  w.querySelector('.prev').hidden = i === 0; w.querySelector('.next').hidden = i >= n - 1;
  s.querySelectorAll('video').forEach(function (v, k) { if (k !== i) v.pause(); });
}, true);
var timers = {}, chain = Promise.resolve();
function lenOf(ta) {
  var n = Array.from(ta.value.trim()).length, l = ta.closest('.editor').querySelector('.len');
  if (l) l.textContent = n + ' characters';
}
function status(ch, text, err) {
  document.querySelectorAll('.card[data-channel="' + ch + '"] .saved').forEach(function (s) { s.textContent = text; s.classList.toggle('err', !!err); });
}
// Text that's the same as the post text isn't saved: a copy of it would stop later edits in Ghost reaching this channel
function save(ch, text, ta) {
  var same = ta && text.trim() === (ta.dataset.auto || '').trim();
  if (same) text = '';
  var url = location.pathname.replace(/[/]?$/, '/') + 'custom';
  document.querySelectorAll('.card[data-channel="' + ch + '"]').forEach(function (c) { c.classList.add('busy'); });
  chain = chain.then(function () {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: ch, text: text }) })
      .then(function (r) {
        return r.text().then(function (t) {
          if (r.ok) return t;
          var msg = r.status; try { msg = JSON.parse(t).error || msg; } catch (e) {} throw new Error(msg);
        });
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('.card[data-channel="' + ch + '"]').forEach(function (nc) {
          var oc = document.querySelector('.card[data-label="' + nc.dataset.label + '"]'); if (!oc) return;
          ['.mock', '.counts', 'h2'].forEach(function (sel) { var a = oc.querySelector(sel), b = nc.querySelector(sel); if (a && b) a.replaceWith(b); });
          fitAll();
        });
        var n = document.querySelector('.notes'), nn = doc.querySelector('.notes');
        if (n && nn) n.replaceWith(nn); else if (n) n.remove();
        status(ch, text ? 'Saved' : same ? 'Same as the post text, so it follows the post' : 'Using the post text');
      })
      .catch(function (e) { status(ch, "Couldn't save: " + e.message, true); })
      .then(function () { document.querySelectorAll('.card[data-channel="' + ch + '"]').forEach(function (c) { c.classList.remove('busy'); }); });
  });
}
document.addEventListener('change', function (e) {
  var cb = e.target.closest('[data-custom]'); if (!cb) return;
  var box = cb.closest('.editor').querySelector('.box'), ta = box.querySelector('textarea');
  box.hidden = !cb.checked; clearTimeout(timers[cb.dataset.custom]);
  if (cb.checked) { ta.focus(); lenOf(ta); }
  save(cb.dataset.custom, cb.checked ? ta.value : '', cb.checked ? ta : null);
});
document.addEventListener('input', function (e) {
  var ta = e.target.closest('textarea[data-channel]'); if (!ta) return;
  var ch = ta.dataset.channel; lenOf(ta); status(ch, 'Saving…');
  clearTimeout(timers[ch]); timers[ch] = setTimeout(function () { save(ch, ta.value, ta); }, 700);
});
document.querySelectorAll('textarea[data-channel]').forEach(lenOf);
// The Listen link (draft previews): saved, then the page reloads, since every card and notification uses it
function saveListen(url) {
  saveMore('listen', { url: url }, document.querySelector('.listen .lsaved'));
}
document.addEventListener('click', function (e) {
  if (e.target.matches('[data-story-now]')) saveMore('story-at', { at: '' }, document.querySelector('.tsaved'));
});
// The Story's time: saved (and the page reloaded) only once you're done with it, so a change part-way through
// doesn't close the date picker: 3 s after the last change while the box isn't in use, when you leave it, or on Enter
var storyAt = document.querySelector('[data-story-at]'), storyWait = null;
function saveStoryAt() {
  clearTimeout(storyWait);
  if (!storyAt || storyAt.value === storyAt.defaultValue) return;
  saveMore('story-at', { at: storyAt.value }, document.querySelector('.tsaved'));
}
function storyAtLater() {
  clearTimeout(storyWait);
  storyWait = setTimeout(function () { if (document.activeElement === storyAt) storyAtLater(); else saveStoryAt(); }, 3000);
}
if (storyAt) {
  var said = document.querySelector('.tsaved');
  ['input', 'change'].forEach(function (ev) {
    storyAt.addEventListener(ev, function () {
      if (said && storyAt.value !== storyAt.defaultValue) { said.textContent = 'Saves when you click away (or press Enter)'; said.classList.remove('err'); }
      storyAtLater();
    });
  });
  storyAt.addEventListener('blur', saveStoryAt);
  storyAt.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveStoryAt(); } });
}
// Saves that change the cards and notifications: then the page reloads
function saveMore(what, body, said) {
  function say(t, err) { if (said) { said.textContent = t; said.classList.toggle('err', !!err); } }
  say('Saving…');
  fetch(location.pathname.replace(/[/]?$/, '/') + what, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) })
    .then(function (r) { if (r.ok) return location.reload(); return r.json().then(function (j) { throw new Error(j.error || r.status); }, function () { throw new Error(r.status); }); })
    .catch(function (e) { say("Couldn't save: " + e.message, true); });
}
document.addEventListener('change', function (e) {
  var other = document.querySelector('[data-listen-other]');
  if (e.target.matches('[data-listen]')) {
    if (e.target.value === 'other') { other.hidden = false; other.focus(); if (other.value.trim()) saveListen(other.value.trim()); return; }
    other.hidden = true; saveListen(e.target.value);
  } else if (e.target === other && other.value.trim()) saveListen(other.value.trim());
  else if (e.target.matches('[data-sticker-on]')) {
    e.target.closest('.editor').querySelector('.box').hidden = !e.target.checked;
    saveMore('sticker', { on: e.target.checked }, document.querySelector('.ssaved'));
  } else if (e.target.matches('[data-sticker-link]')) {
    var addr = document.querySelector('[data-sticker-other]');
    if (e.target.value === 'other') { addr.hidden = false; addr.focus(); if (addr.value.trim()) saveMore('sticker', { link: addr.value.trim() }, document.querySelector('.ssaved')); return; }
    addr.hidden = true; saveMore('sticker', { link: e.target.value }, document.querySelector('.ssaved'));
  } else if (e.target.matches('[data-sticker-other]') && e.target.value.trim()) saveMore('sticker', { link: e.target.value.trim() }, document.querySelector('.ssaved'));
  else if (e.target.matches('[data-sticker]')) saveMore('sticker', { text: e.target.value.trim() }, document.querySelector('.ssaved'));
});
})();`;

export const previewPage = (title, inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>${PREVIEW_CSS}</style></head><body><main>${inner}</main>${sourceLink}<script>${PREVIEW_JS}</script></body></html>`;

// A notification's buttons: links for "view" ones (a draft's photo page isn't made yet, so it's just named)
const noteButtons = (n) => (n.actions?.length ? `<span class="buttons">Buttons: ${n.actions.map((a) =>
  (a.action === 'view' && !a.url.includes('<') ? `<a href="${escAttr(a.url)}" target="_blank" rel="noopener">${esc(a.label)}</a>` : esc(a.label))).join(' · ')}</span>` : '');

// The photo page a notification links for several photos: all of them in order, "Share all" (the phone's share
// sheet, which can hand them straight to Instagram or TikTok) and "Save" (one photo per tap). The photos are fetched first, so
// the tap shares at once (a share must follow a tap within seconds). Sharing files needs https and a phone
// browser (Chrome on Android, Safari on iPhone); elsewhere only saving is offered.
export function photosPage({ platform, title, photos, base }) {
  const ext = (u) => (/\.(jpe?g|png|gif|webp|avif|heic)$/i.exec(String(u).split('?')[0])?.[0] || '.jpg').toLowerCase();
  const shots = photos.map((u, i) => `<a href="${base}${i + 1}" download="photo-${i + 1}${ext(u)}">`
    + `<img src="${base}${i + 1}" alt="Photo ${i + 1}"><span class="n">${i + 1}</span></a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(`${platform} photos`)}</title>
<style>${PREVIEW_CSS}
main{max-width:640px}.acts{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}
.acts button{font:inherit;font-weight:600;padding:12px 18px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
.acts button.main{background:#1d6ff2;border-color:#1d6ff2;color:#fff;flex:1}.acts button:disabled{opacity:.6;cursor:default}
.shots{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.shots a{position:relative;display:block}
.shots img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;display:block;background:var(--line)}
.shots .n{position:absolute;top:6px;left:6px;background:rgba(0,0,0,.6);color:#fff;font-size:12px;padding:1px 7px;border-radius:999px}
.shots a.done::after{content:"✓";position:absolute;top:6px;right:6px;background:#1f7a3f;color:#fff;font-size:12px;padding:1px 7px;border-radius:999px}
#msg:empty{display:none}#msg{margin:0 0 12px}</style></head><body><main>
<h1>${esc(platform)}: ${esc(title || '(no title)')}</h1>
<div class="meta">${photos.length} photos, in order${/instagram/i.test(platform) ? ', cropped for Instagram' : ''}. Copy the caption from the notification first.</div>
<div class="acts"><button type="button" class="main" id="share" disabled>Loading photos…</button><button type="button" id="save">Save</button></div>
<p id="msg" class="dim"></p>
<div class="shots">${shots}</div>
<p class="dim small">The Save button takes one photo per tap, in order. Or tap a photo to save just that one.</p></main>${sourceLink}
<script>(function () {
var share = document.getElementById('share'), save = document.getElementById('save'), msg = document.getElementById('msg');
var links = [].slice.call(document.querySelectorAll('.shots a')), files = null;
function say(t) { msg.textContent = t; }
Promise.all(links.map(function (a, i) {
  return fetch(a.href).then(function (r) {
    if (!r.ok) throw new Error('photo ' + (i + 1) + ': ' + r.status);
    return r.blob();
  }).then(function (b) { return new File([b], a.getAttribute('download'), { type: b.type }); });
})).then(function (list) {
  files = list;
  if (navigator.canShare && navigator.canShare({ files: list })) {
    share.disabled = false; share.textContent = 'Share all ' + list.length + ' photos';
  } else {
    share.hidden = true;
    say('This browser can’t share photos from here (it needs https, on a phone), so save them instead.');
  }
}).catch(function (e) { share.hidden = true; say('Couldn’t load the photos (' + e.message + '). Tap each one to open it.'); });
share.addEventListener('click', function () {
  navigator.share({ files: files }).catch(function (e) { if (e.name !== 'AbortError') say('Couldn’t share: ' + e.message); });
});
// One photo per tap, in order: browsers let a tap start one download (Firefox on Android drops the rest,
// Chrome asks first), so the button saves the next one each time and says which
var nextSave = 0;
function saveLabel() {
  save.textContent = nextSave < links.length ? 'Save photo ' + (nextSave + 1) + ' of ' + links.length : 'All ' + links.length + ' saved ✓';
}
save.addEventListener('click', function () {
  if (nextSave >= links.length) nextSave = 0; // tapped again after the last: start over
  links[nextSave].click();
  links[nextSave].classList.add('done');
  nextSave++;
  saveLabel();
});
saveLabel();
})();</script></body></html>`;
}

// Draft previews: which link becomes the featured link's line (found automatically, another link in the post,
// any address, or none), saved for the post by POST .../listen
function listenPicker(pv, s) {
  const { auto = null, links = [], chosen = '' } = pv.listen || {};
  const opt = (value, label, on) => `<option value="${escAttr(value)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
  const listed = links.some((l) => l.url === chosen);
  const other = !!chosen && chosen !== 'none' && !listed;
  const label = words(s.FEATURED_LABEL);
  const options = [
    opt('', auto ? `Automatic: ${auto.name} (${auto.url})` : 'Automatic: none found in the post', !chosen),
    ...links.map((l) => opt(l.url, `${l.name}: ${l.url}`, l.url === chosen)),
    opt('none', `None: no ${label}`, chosen === 'none'),
    opt('other', 'Another address…', other),
  ];
  // the settings' lines as the posts show them, and the services in the order Automatic prefers them
  const shown = (line) => line.replace(/\s*\[url\]\s*/g, ' ').replace(/\[name\]/g, '…').trim();
  const names = [...new Set(s.FEATURED_DOMAINS.map((d) => s.SERVICE_NAMES[d] || d))];
  const order = names.length > 1 ? `${names[0]} first, then ${names.slice(1).join(', ')}` : names[0] || 'nothing';
  return `<div class="listen"><label for="listen-pick">${esc(s.FEATURED_LABEL)}</label>
    <select id="listen-pick" data-listen>${options.join('')}</select>
    <input type="url" data-listen-other placeholder="https://…" value="${escAttr(other ? chosen : '')}"${other ? '' : ' hidden'}>
    <span class="lsaved" aria-live="polite"></span>
    <div class="hint">Bluesky and Threads get a "${esc(shown(s.FEATURED_LINE))}" line with it, Instagram and TikTok
    "${esc(shown(s.FEATURED_BIO_LINE))}", and a #bigdrop's link sticker points to it (unless its Story card says otherwise). Automatic picks ${esc(order)}
    (the order of FEATURED_DOMAINS).</div></div>`;
}

// s: the bridge's settings the cards show (limits, channel ids, tags...), see PREVIEW_SETTINGS there
export function renderPreview(pv, s) {
  const { BIG_DROP_TAG, STORY_TAG } = s;
  const post = pv.post;
  const m = pv.media;
  const flags = [
    m ? `Media: ${m.audiogram ? 'audio clip (rendered from the audio card)' : m.kind === 'image' && m.count > 1 ? `${m.count} images` : m.kind}` : 'Media: none',
    pv.bigDrop && `${BIG_DROP_TAG}`, pv.asStory && `${STORY_TAG}`,
    pv.listen && !pv.draft && `${words(s.FEATURED_LABEL)}: ${(pv.listen.chosen ? 'picked: ' : '') + (pv.listen.chosen === 'none' ? 'none'
      : pv.listen.chosen ? pv.listen.chosen : pv.listen.auto ? `${pv.listen.auto.name}` : 'none')}`,
  ].filter(Boolean);
  const cards = pv.entries.map((e) => previewCard(e, pv, s)).join('')
    || '<p>Nothing would be posted. The log below says why.</p>';
  const notes = pv.notes.length ? `<div class="notes"><h2>ntfy notifications you'd get</h2>${pv.notes.map((n) =>
    `<div class="note"><b>${esc(n.title || '')}</b>\n${richText(n.message || '', { links: true })}${noteButtons(n)}</div>`).join('')}</div>` : '';
  const status = { draft: 'a draft', scheduled: 'scheduled', published: 'published' }[post.status] || post.status;
  const banner = !pv.draft ? ''
    : `<div class="banner">Nothing has been posted. This is what the bridge would do if this post (${esc(status)},
      as last saved) were published now.${pv.shared ? ` It was already shared on ${esc(new Date(pv.shared).toLocaleString('en-GB'))},
      so publishing it again wouldn't post it again.` : ''} <a href="">Refresh</a> after saving changes in Ghost.</div>`;
  const openLink = pv.draft ? pv.ghostPreview : post.url;
  return previewPage(`${pv.draft ? 'Social preview' : 'Preview'}: ${post.title || 'post'}`, `
    <h1>${esc(post.title || '(no title)')}</h1>
    <div class="meta"><span>${esc(pv.at.toLocaleString('en-GB'))}</span>
    ${openLink ? `<span><a href="${escAttr(openLink)}" target="_blank" rel="noopener">Open the post</a></span>` : ''}
    ${flags.map((f) => `<span>${esc(f)}</span>`).join('')}${pv.draft ? '' : '<span><a href="./">All previews</a></span>'}</div>
    ${banner}${pv.draft && pv.listen ? listenPicker(pv, s) : ''}<div class="grid">${cards}</div>${notes}
    <details class="log"><summary>Bridge log</summary><pre>${esc(pv.log.join('\n'))}</pre></details>`);
}
