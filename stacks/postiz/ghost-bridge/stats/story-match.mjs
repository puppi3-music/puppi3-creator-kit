// Which share an Instagram Story came from. Instagram gives a Story no caption and nothing that ties it to the bridge's
// share, so it's matched by time: posted.json says which shares had a Story and when it was due, custom.json has the
// caption of a share from before posted.json kept it. A match is a guess, and pageFor says so.
const BEFORE = 15 * 60_000; // the share is noted after its uploads and reminders, so a Story can be a little older
const AFTER = { ok: 60 * 60_000, manual: 6 * 60 * 60_000 }; // Postiz posts it at once; by hand is when you get to it

function storyDue(posted) {
  const due = [];
  for (const [postId, entry] of Object.entries(posted || {})) {
    const rounds = [...(entry.earlier || []), { at: entry.at, results: entry.results, last: true }];
    for (const round of rounds) {
      const result = Object.entries(round.results || {})
        .find(([label, r]) => label.endsWith(':story') && AFTER[r])?.[1];
      const when = Date.parse((round.last && entry.storyAt) || round.at);
      if (result && when) due.push({ key: `${postId}@${when}`, postId, entry, result, when });
    }
  }
  return due;
}

// Sets `share` on each Story it can match (kept once set) and, while Instagram has no caption for it, its caption:
// the one written on the Social preview, else the post's title. A share goes with one Story at most.
export function matchStories(stories, posted, custom = {}) {
  const due = storyDue(posted);
  const taken = new Set(stories.map((s) => s.share?.key).filter(Boolean));
  for (const s of [...stories].sort((a, b) => (a.time || 0) - (b.time || 0))) {
    if (s.share || !s.time) continue;
    const fits = due.filter((d) => !taken.has(d.key) && s.time >= d.when - BEFORE && s.time <= d.when + AFTER[d.result]);
    // the latest one due by then, so a window ends at the next share; else the one coming up
    const d = fits.filter((x) => x.when <= s.time).sort((a, b) => b.when - a.when)[0]
      || fits.sort((a, b) => a.when - b.when)[0];
    if (!d) continue;
    taken.add(d.key);
    s.share = { key: d.key, postId: d.postId, title: d.entry.title || '', url: d.entry.url || '',
      caption: 'storyCaption' in d.entry ? d.entry.storyCaption : custom[d.postId]?.storyCaption || '',
      by: d.result === 'ok' ? 'postiz' : 'hand' };
  }
  for (const s of stories) {
    if (s.share && !s.caption) s.caption = String(s.share.caption || s.share.title).replace(/\s+/g, ' ').slice(0, 140);
  }
}
