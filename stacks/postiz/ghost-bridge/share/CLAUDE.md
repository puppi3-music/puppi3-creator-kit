# stacks/postiz/ghost-bridge/share/

Sharing a Ghost post to the networks, and the bridge's other messages to the phone. Module paths (`share/…`,
`stats/…`) are from `ghost-bridge/`, as in `docs/bridge-map.md`. The bridge as a whole (modules, routes, Ghost's
webhook, `pages/`): `stacks/postiz/ghost-bridge/CLAUDE.md`; the numbers: `stacks/postiz/ghost-bridge/stats/CLAUDE.md`.
Keep the Posting guide (`kit/docs/posting-guide.html`) current when tags, captions, media rules or notifications
change.

## Sharing posts
- Draft social previews: the theme
  (`post.hbs`) adds a "Social preview" button on Ghost's `/p/<uuid>/` preview pages, linking to
  `https://<SITE_HOST>/ghost/social-preview/<uuid>/` (`DRAFT_BASE`; old `/social-preview/<uuid>/` 301s there),
  which Traefik routes to the bridge (label on the bridge, priority 100). Staff only: under /ghost/ so the browser
  sends Ghost's `ghost-admin-api-session` cookie (path /ghost), which `staffSignedIn` passes to Ghost's
  `/users/me/` with Origin = the site (from `/site/`), cached 1 min; page, media and saves all need it, and saves
  also need Origin = the site. The bridge reads the draft via the Admin API (`GHOST_API_URL` = Ghost on
  `http://website-puppi3:2368` over the `proxy` network, `GHOST_ADMIN_API_KEY` in the postiz `.env`, e.g. the "Postiz" integration's
  key; a key Ghost turns down (401) gets a page and a start-up log WARNING (`checkGhostKey`) naming
  `GHOST_ADMIN_API_KEY` and how to fix it, plus "staging has its own keys" on a DRY_RUN bridge), runs the publish logic fully dry (never posts or notifies), caches per a hash of the post Ghost sends (not `updated_at`: a tag-only save can leave it as it was). Each card has
  a "Modify text for <channel>" checkbox + textarea: saved via `POST /ghost/social-preview/<uuid>/custom` to
  `data/custom.json` (post id -> channel -> text), used instead of the post text on publish. A featured-link menu above the cards (`FEATURED_LABEL`
  after `FEATURED_LINE`'s first emoji: the kit's "🔗 Featured link", puppi3's "🎧 Listen link"; `POST .../listen`, `listen` in
  `custom.json`: '' auto, 'none' or any address) overrides the automatic one: `postLinks` (a hrefs + YouTube embeds)
  -> `findListenLink`, preferring the earliest service in `FEATURED_DOMAINS` (puppi3's YouTube, SoundCloud, Mixcloud; the
  kit's default adds Vimeo, Spotify, Apple Podcasts/Music, Bandcamp, Twitch). Its caption lines are `FEATURED_LINE`
  (Bluesky/Threads) and `FEATURED_BIO_LINE` (Instagram/TikTok), `[name]`/`[url]` filled in (`featuredLine`); puppi3's
  wording ("🎧 Listen: …", "🎧 Full set on …") is in her own instance profile, the neutral defaults in the compose files
  (`[…]`, not `{…}`: compose's defaults and settings_reference's parser end at `}`). Every Instagram Story posted by hand (#bigdrop's own Story, a #story by
  hand) has a "Sticker" checkbox, a "Sticker link" menu (Automatic / No link / Another address…) and a "Sticker text"
  box (`POST .../sticker` {on, link, text}; `storyLink` true/false, `stickerLink` 'none'/address and `sticker` in
  `custom.json`, `STICKER_TEXT_MAX` [60]; user asked: change the sticker's link and text, choose whether there's a
  sticker, and a sticker with no link). Unset = on only for #bigdrop. The link: Automatic = `stickerLink()` (the
  featured link, else the post), an address is `tagLink`ed for Instagram when it's on the site; No link = text only
  (added with Aa in the app, since a link sticker needs a link). On with neither link nor text = nothing to add, as if
  off (`stickerOn`). Off: a plain Story (`notifyBigDrop` without the sticker steps; `notifyManual` without the line).
  Text: shown on the card, and since the API can't set it, the reminders give it with "Copy sticker text" (in place of
  `notifyBigDrop`'s Open link button; first with no link). Stories the bridge posts itself can't have one.
- An Instagram Story's own time (user asked: post the Story at a different time): every Story card on the Social
  preview has "Post the Story at" (datetime-local in `SITE_TIMEZONE`; `POST .../story-at` {at}, `zonedTime` turns it
  into a time, refused when gone by or more than a year away; `storyAt` ISO in `custom.json`; "With the post" clears
  it). Unset, the box shows the post's own time in Ghost (`postAt`: a scheduled or published post's `published_at`;
  user asked: default to the Ghost post's time), and nothing is saved until it's changed, so a rescheduled post moves
  the Story with it; a draft's box is empty (it goes when you publish). The box saves (and reloads the page) only once you're done with it: 3 s after the last
  change while it isn't focused, on leaving it, or on Enter (user asked: saving on the first change closed the date
  picker). On publish: a Story Postiz posts (#story #autopost, `BIG_DROP_AUTO_STORY`) goes as `type: 'schedule'` at that
  `date` (the hand-posted #story's Postiz draft is dated then too); the reminder for one by hand (#bigdrop's,
  #story's Instagram one) comes then, starting "⏰ The time you set for it: …" (`notifyAt`). Gone by when the post
  is shared (a draft preview of a scheduled post compares with its time) = with the post, and the card says so
  (`storyLate`). The bridge keeps those reminders itself in `data/later.json` (`startLaterNotices`, every 30 s,
  a restart sends what came due; ntfy down = tried again, dropped a day late), not ntfy's delay: ntfy keeps a
  delayed message only in its cache and for at most 3 days, and a server with no cache file loses it on a restart. On the Instagram
  card you drag photos within the frame (`POST .../frame`, saved as `frames` in `custom.json`); on publish
  the bridge crops Instagram's feed photos (ffmpeg) to the first photo's shape (4:5-1.91:1) at that framing
  (centred otherwise). It also fits every channel's photos to what Postiz and the platform accept (`IMAGE_RULES`:
  Postiz posts only png/jpg/gif/webp; Instagram JPEG <=1440 wide; Threads JPEG/PNG; TikTok JPEG/WebP, shorter
  side <=1080): ffmpeg converts only the ones that don't fit and uploads them; the rest go as they are.
- Shared posts (user asked: share a post again from a page, not by editing posted.json; reached from Ghost Admin
  without opening a post): `GET /ghost/social-preview/` (same sign-in as the Social preview, same Traefik route) lists,
  on its first page, the scheduled posts (soonest first) and drafts (last edited first; 20 of each; user asked to see
  what's coming), each opening its Social preview; then the site's published posts (Admin API, 30 a page, `?page=`) with posted.json's results per network (`earlier`: the
  shares before) or "Being shared now" (ghost-bridge.mjs's `sharing`). A Story at its own later time (user asked: the
  post out, its Story not yet) is "not yet, posts itself <time>" (Postiz scheduled it) or "not yet, your reminder comes
  <time>" (by hand) until then: posted.json's `storyAt`, written when a Story was shared at a later time (kept when
  shared again without the Story). A #story by hand is noted as `<identifier>:story`, like the others. A post shared before the bridge noted either (`withStoryAt` in preview-routes.mjs) takes the time set on the Social preview (custom.json's `storyAt`) when it's after the share and the post has #story or #bigdrop (user saw no note on one): #bigdrop's Story by hand added, #story's Instagram entry read as its Story. Each opens its Social preview, which for a
  published post has "Share again now" (or "Share now" if never shared) with a box per card it would post,
  all ticked (user asked: share again on just one or two, and Instagram's Story apart from its feed post): a
  channel's identifier for its feed post, `<identifier>:story` for its Story (#story's, #bigdrop's auto one, and
  #bigdrop's by-hand reminder, which is also noted in posted.json's results as `<identifier>:story: manual`; with
  only the Story ticked, the reminder is all that's sent). A confirm naming the ticked ones, then `POST .../share`
  {networks: [those labels]} (Origin = the site, like the saves;
  published only, 409 while it's being shared, 400 for none or a bad name; no list = all) runs the post as Ghost has
  it through the webhook's own path with `handlePost(post, { again: true, only })`: past posted.json's check, only
  those cards (and only their notifications), same tags, saved texts and framing; the new entry replaces the old
  one, keeps it in `earlier`, and keeps the networks left out at their old results. Answers 202 at once. It can't take down what was posted before (posted.json has no Postiz post ids) and
  Ghost's newsletter isn't sent again; the page says both. A DRY_RUN bridge (staging) writes a dry-run preview instead.
  The kit's theme adds a "Shared posts" button inside Ghost Admin's View site (`kit/theme/CLAUDE.md`; a site's own theme can too).
- Captions (`bodyText`): bullets "• ", numbered lists "1. ", quotes in “ ”; links in the text become "text (address)" on
  Bluesky/Threads only when the whole caption still fits (`buildLines` -> `fitLines`), else link text only (always on
  IG/TikTok); the preview's "Modify text" box starts from each channel's version (`autoText` per channel key).
- `TAG_LINKS` (default true): `tagLink()` turns site links in captions (`buildLines`, `withLinks`) and the Instagram
  link-sticker link (`stickerLink()`) into short tagged links `https://<site>/<b|t|i|k>/<path>` (`SHORT_LINK_PREFIX`:
  bluesky, threads, instagram, tiktok; must match the theme's redirects.yaml (which also has `/d/` Discord and `/y/` YouTube, shared by hand), which 302s them to
  `/<path>/?utm_source=<network>&utm_medium=social`; Ghost's redirects can't copy the slug into the query, so no
  utm_campaign: the landing page tells the post). Other networks, or links with a #fragment, get the long query form
  (featured links untouched; a link already carrying utm_source is kept). Growth's "Tagged links" table reads it back.
  The redirects themselves: `kit/redirects.yaml`.
- Internal tag `#campaign-<name>` (`CAMPAIGN_TAG`, `campaignOf`): that post's site links and IG sticker get the long
  form plus `&utm_campaign=<name>` (even with TAG_LINKS off), for Growth's Campaigns table.
- Instagram/TikTok notifications with several photos get an "All N photos" button (instead of "Open Postiz") to
  `https://<site>/social-preview/photos/<id>/` (already routed to the bridge; no sign-in, random 24-char id, saved in
  `data/photos.json`, `PHOTO_PAGE_DAYS` [14]; not made for draft previews): each photo as that app gets it, served
  through the bridge (site images via `GHOST_API_URL`), "Share all" (`navigator.share` files: https + phone browser)
  and "Save" (one photo per tap: browsers allow one download per tap). If it can't be saved, the old one-notification-per-photo fallback is used. `#story` sends IG one
  photo, so no page. Story notifications come in first (the #bigdrop one, then an IG #story one, then the rest; queue failures last), each followed by a `NTFY_STORY_GAP` [2 s] pause when more follow, so the phone gets them in that order. #bigdrop gets its own link-Story notification when an IG channel exists (`notifyBigDrop`: first photo uncropped via
  `igStory[0]`, or the video; Copy sticker link / Open Instagram / Open the featured link or post, or Copy sticker text when set; with the sticker off, Open Instagram / Open the link or post), except #story + #bigdrop by
  hand, where the IG Story notification carries the sticker link (as it does for any #story by hand with the sticker on).
- `GET /upnext.json` (`upNextDoc`: Admin API `status:scheduled`, then handlePost's rules without uploading: `musicRouting` shared with handlePost, media kind, channels
  -> Posts itself to / You post in the app / Left out, link to the Social preview; 1-min cache; not routed by Traefik):
  Ghost's scheduled posts, for Social's "Up next".

## Seasonal profile pictures
- `share/pfp.mjs` (`startSeasonalPfp`, `PFP_SEASONS` [true]; user asked: the site's seasonal outfits on the social
  profile pictures too, as a phone reminder for every network, Bluesky included: nothing changed by API). The theme is
  the source: `npm run dev:pfp` there writes `assets/images/pfp/<season>.png` (1000×1000) + `seasons.json` (puppies.js's
  SEASONS), shipped in the zip; the bridge reads seasons.json from Ghost (`GHOST_API_URL` + `/assets/images/pfp/`,
  `X-Forwarded-Proto: https`), so no mount and staging gets staging's theme. 20 s after start, then hourly: today in
  `SITE_TIMEZONE` (`PFP_TODAY` YYYY-MM-DD/MM-DD pretends, staging only), matched like puppies.js (month*100+day, last match
  wins; newyear's two entries = one season by name). A seasons.json it can't read changes nothing; none at all (404:
  a theme without the pictures, like the kit's) is logged once and means no reminders.
- On a change (state `data/pfp.json`: season, since, from, notified; saved after each step, so restarts repeat nothing; an
  unsent reminder is retried hourly; no NTFY_URL or DRY_RUN without DRY_RUN_NTFY counts as sent): "🐶 <Season> puppy pfp"
  with the PNG (site's public URL from `ghostSiteOrigin`) attached + Save picture, or "🐶 Back to the usual pfp" when it
  ends. Both list `PFP_NETWORKS` (comma list, default bluesky, instagram, threads, tiktok, youtube, soundcloud, mixcloud, discord; the
  user's per-network on/off: remove one to stop it), its first two known ones get "Open <network>" buttons (`NETWORKS`
  in pfp.mjs has the names and addresses; an unknown name is listed as written). Empty = off.

## Weekly summary
- `share/weekly.mjs` (`startWeeklySummary`, `WEEKLY_SUMMARY` [true]; user asked: how the week went, on the phone, without
  opening Grafana). Every 15 min (first ~3 min after start, after the collectors' first polls, since the Ghost one fills in
  Tinybird's site_uuid): `lastDue` = the latest `WEEKLY_SUMMARY_AT` [`Mon 09:00`, "<weekday> HH:MM", bad = default] in
  `SITE_TIMEZONE`; state `data/weekly.json` `{ sent: <local date> }`, saved after a send (first run: set without sending;
  a missed one is sent at the next check, only the latest; no NTFY_URL or DRY_RUN without DRY_RUN_NTFY counts as sent).
- `weekDoc(due)` = the 7 local days before `due`, read only: site visitors (+ % on the week before) and new members from
  ghost.json's `daily` (UTC days); followers gained per network (`ACCOUNT_KEYS[n][0]`, stats.db account checks: the last
  before the week, else its first, to the last in it; ghost left out); posts made that week and the best 3 judged
  (`performanceDoc`); top 3 pages (`tbPipe` `api_top_pages`, titles from ghost.json's posts); live shows (live.json).
  `weekMessage` writes it as short lines with emoji; title "📊 Your week on <SITE_NAME> (<from> – <to>)", "Open Grafana"
  to Overview (`<ID_PREFIX>-overview`) at `GRAFANA_URL` (`-staging` uid under DRY_RUN). A part that fails is left out and logged.
  `WEEKLY_SUMMARY_NOW=true` sends last week's once ~3 min after start (staging, to try it).
