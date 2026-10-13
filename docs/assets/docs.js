/* Shared by the docs pages, and copied into each one by docs/build-docs.py, so every guide is a
   single file that works on its own (send just that file and search still works):
   a top bar (a link to the front page, the guide's name, search, theme switch), search through this page, a contents list
   that follows along, heading links, copy buttons and "back to top". Edit this file, not the
   copies in the pages; the pre-commit hook rebuilds them. */
(function () {
  'use strict';

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  var el = function (tag, attrs, html) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) n.setAttribute(k, attrs[k]);
    if (html != null) n.innerHTML = html;
    return n;
  };

  /* ---------- theme: auto / light / dark ---------- */
  var THEMES = ['auto', 'light', 'dark'];
  var THEME_LABEL = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' };
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  var theme = store.get('docs-theme') || 'auto';
  applyTheme(theme);

  /* ---------- top bar ---------- */
  var bar = el('div', { class: 'docbar' });
  var inner = el('div', { class: 'docbar-in' });
  var h1 = document.querySelector('h1');
  var name = (h1 ? h1.textContent : document.title).replace(/\.\s*$/, '').trim();
  // back to the front page, only when served (the docs site): a guide sent as a file has no index next to it
  if (/^https?:$/.test(location.protocol)) {
    inner.appendChild(el('a', { class: 'home', href: './', title: 'All the guides', 'aria-label': 'All guides' },
      '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.5"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1.5"/>' +
      '<rect x="1.5" y="9" width="5.5" height="5.5" rx="1.5"/><rect x="9" y="9" width="5.5" height="5.5" rx="1.5"/></svg><span>All guides</span>'));
  }
  inner.appendChild(el('a', { class: 'brand', href: '#', title: 'Back to the top' }, esc(name) + '<span>.</span>'));
  inner.appendChild(el('div', { class: 'grow' }));
  var search = el('div', { class: 'search' });
  search.innerHTML =
    '<svg class="glass" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>' +
    '<input type="search" placeholder="Search this guide" autocomplete="off" spellcheck="false" role="combobox" ' +
    'aria-autocomplete="list" aria-expanded="false" aria-controls="doc-results" aria-label="Search this guide">' +
    '<kbd>/</kbd><div class="results" id="doc-results" role="listbox" aria-label="Search results"></div>';
  inner.appendChild(search);
  var themeBtn = el('button', { class: 'iconbtn', type: 'button', title: 'Colour theme' }, THEME_LABEL[theme]);
  themeBtn.addEventListener('click', function () {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    applyTheme(theme);
    store.set('docs-theme', theme === 'auto' ? null : theme);
    themeBtn.textContent = THEME_LABEL[theme];
  });
  inner.appendChild(themeBtn);
  bar.appendChild(inner);
  document.body.insertBefore(bar, document.body.firstChild);

  /* ---------- this page in parts: each section's intro, then each h3's part ---------- */
  // readable text: spaces between table cells, list items and blocks (textContent runs them together)
  var BLOCK = /^(P|DIV|LI|TD|TH|TR|DT|DD|H\d|BLOCKQUOTE|PRE|BR|UL|OL|TABLE|FIGCAPTION|SECTION)$/;
  function textOf(nodes) {
    var parts = [];
    var walk = function (n) {
      if (n.nodeType === 3) { parts.push(n.nodeValue); return; }
      if (n.nodeType !== 1 || /^(SCRIPT|STYLE|BUTTON|NAV)$/.test(n.nodeName) || (n.classList && n.classList.contains('anchor'))) return;
      var block = BLOCK.test(n.nodeName);
      if (block) parts.push(' ');
      for (var c = n.firstChild; c; c = c.nextSibling) walk(c);
      if (block) parts.push(' ');
    };
    nodes.forEach(walk);
    return parts.join('').replace(/\s+/g, ' ').trim();
  }
  function headingText(h) { var c = h.cloneNode(true); c.querySelectorAll('.anchor').forEach(function (x) { x.remove(); }); return c.textContent.replace(/\s+/g, ' ').trim(); }
  function pageEntries() {
    var out = [];
    document.querySelectorAll('main section[id]').forEach(function (sec) {
      var h2 = sec.querySelector('h2'), title = h2 ? headingText(h2) : sec.id;
      var chunk = { id: sec.id, h: title, nodes: [] };
      out.push(chunk);
      Array.prototype.forEach.call(sec.childNodes, function (n) {
        if (n === h2) return;
        if (n.nodeType === 1 && n.nodeName === 'H3' && n.id) {
          chunk = { id: n.id, h: title + ' › ' + headingText(n), nodes: [] };
          out.push(chunk);
          return;
        }
        chunk.nodes.push(n);
      });
    });
    return out.map(function (c) { var x = textOf(c.nodes); return { id: c.id, h: c.h, x: x, hl: c.h.toLowerCase(), xl: x.toLowerCase() }; });
  }
  var entries = null;
  function allEntries() { return entries || (entries = pageEntries()); }

  /* ---------- search ---------- */
  var input = search.querySelector('input'), box = search.querySelector('.results');
  var hits = [], active = -1;
  function terms(q) { return q.toLowerCase().split(/\s+/).filter(function (t) { return t.length > 0; }); }
  function count(hay, t) { var n = 0, i = hay.indexOf(t); while (i !== -1 && n < 6) { n++; i = hay.indexOf(t, i + t.length); } return n; }
  var reEsc = function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  // highlight the words in plain text, escaping each piece (so words never match inside &amp; and the like)
  function markup(text, ts) {
    var re = new RegExp(ts.map(reEsc).join('|'), 'gi'), out = '', last = 0, m;
    while ((m = re.exec(text))) {
      out += esc(text.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }
  function snippet(e, ts) {
    var at = -1;
    ts.forEach(function (t) { var i = e.xl.indexOf(t); if (i !== -1 && (at === -1 || i < at)) at = i; });
    if (at === -1) return e.x.slice(0, 150) + (e.x.length > 150 ? '…' : '');
    var start = Math.max(0, at - 60), end = Math.min(e.x.length, at + 120);
    return (start > 0 ? '…' : '') + e.x.slice(start, end) + (end < e.x.length ? '…' : '');
  }
  function run(q) {
    var ts = terms(q);
    if (!ts.length) { close(); return; }
    var list = allEntries(), scored = [];
    list.forEach(function (e) {
      var score = 0;
      for (var i = 0; i < ts.length; i++) {
        var t = ts[i], inH = e.hl.indexOf(t) !== -1, n = count(e.xl, t);
        if (!inH && !n) return;                      // every word must appear
        if (inH) score += 12 + (new RegExp('(^|[^a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(e.hl) ? 6 : 0);
        score += Math.min(n, 5);
      }
      scored.push({ e: e, s: score });
    });
    scored.sort(function (a, b) { return b.s - a.s; });
    hits = scored.slice(0, 20).map(function (r) { return r.e; });
    active = hits.length ? 0 : -1;
    render(ts);
  }
  function hrefFor(e, ts) { return '?q=' + encodeURIComponent(ts.join(' ')) + '#' + encodeURIComponent(e.id); }
  function render(ts) {
    if (!hits.length) {
      box.innerHTML = '<div class="hint">No matches for <b>' + esc(ts.join(' ')) + '</b>. Try fewer or different words.</div>';
    } else {
      box.innerHTML = hits.map(function (e, i) {
        return '<a class="result" role="option" id="doc-hit-' + i + '" aria-selected="' + (i === active) + '" href="' + esc(hrefFor(e, ts)) + '" data-i="' + i + '">' +
          '<span class="where">' + markup(e.h, ts) + '</span><span class="snip">' + markup(snippet(e, ts), ts) + '</span></a>';
      }).join('') + '<div class="hint">↑ ↓ to choose · Enter to open · Esc to close</div>';
    }
    box.classList.add('open');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', active >= 0 ? 'doc-hit-' + active : '');
  }
  function close() { box.classList.remove('open'); input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
  function move(d) {
    if (!hits.length) return;
    active = (active + d + hits.length) % hits.length;
    box.querySelectorAll('.result').forEach(function (a, i) { a.setAttribute('aria-selected', String(i === active)); });
    var cur = box.querySelector('#doc-hit-' + active);
    if (cur) { cur.scrollIntoView({ block: 'nearest' }); input.setAttribute('aria-activedescendant', cur.id); }
  }
  function open(e, ts) {
    close();
    // keep the address in step where allowed (pages opened from disk may refuse), then land
    try { history.replaceState(null, '', hrefFor(e, ts)); } catch (err) {}
    land(e.id, ts); input.blur();
  }
  var timer;
  input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { run(input.value); }, 60); });
  input.addEventListener('focus', function () { if (input.value.trim()) run(input.value); });
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); move(1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); }
    else if (ev.key === 'Enter') { ev.preventDefault(); if (active >= 0) open(hits[active], terms(input.value)); }
    else if (ev.key === 'Escape') { if (box.classList.contains('open')) close(); else input.blur(); }
  });
  box.addEventListener('click', function (ev) {
    var a = ev.target.closest('.result'); if (!a) return;
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button === 1) return;   // new tab: let the link work
    ev.preventDefault(); open(hits[+a.getAttribute('data-i')], terms(input.value));
  });
  document.addEventListener('click', function (ev) { if (!search.contains(ev.target)) close(); });
  document.addEventListener('keydown', function (ev) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.nodeName);
    if ((ev.key === '/' && !typing) || ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k')) {
      ev.preventDefault(); input.focus(); input.select();
    }
  });

  /* ---------- landing on a result: flash the heading and mark the words in its part ---------- */
  function clearMarks() {
    document.querySelectorAll('mark.hit').forEach(function (m) { m.replaceWith(document.createTextNode(m.textContent)); });
    document.querySelectorAll('main section').forEach(function (s) { s.normalize(); });
  }
  function partOf(target) {
    // the heading's part: an h3 up to the next h3; a section's intro up to its first h3
    var nodes = [], sec = target.closest('section') || target;
    var start = target.nodeName === 'SECTION' ? sec.firstChild : target.nextSibling;
    for (var n = start; n; n = n.nextSibling) { if (n.nodeName === 'H3' && n !== target) break; nodes.push(n); }
    return nodes;
  }
  function markIn(nodes, ts) {
    if (!ts.length) return null;
    var re = new RegExp(ts.map(function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|'), 'gi'), first = null;
    nodes.forEach(function (root) {
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) { return n.parentNode.closest('button,script,style,mark,.anchor') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
      }), texts = [];
      if (root.nodeType === 3) texts.push(root); else while (walker.nextNode()) texts.push(walker.currentNode);
      texts.forEach(function (tn) {
        var s = tn.nodeValue; re.lastIndex = 0; if (!re.test(s)) return; re.lastIndex = 0;
        var frag = document.createDocumentFragment(), last = 0, m;
        while ((m = re.exec(s))) {
          frag.appendChild(document.createTextNode(s.slice(last, m.index)));
          var mk = el('mark', { class: 'hit' }); mk.textContent = m[0]; frag.appendChild(mk); if (!first) first = mk;
          last = m.index + m[0].length;
        }
        frag.appendChild(document.createTextNode(s.slice(last)));
        tn.parentNode.replaceChild(frag, tn);
      });
    });
    return first;
  }
  function land(id, ts) {
    var target = document.getElementById(id); if (!target) return;
    clearMarks();
    markIn(partOf(target), ts || []);
    var h = target.nodeName === 'SECTION' ? target.querySelector('h2') || target : target;
    h.scrollIntoView({ block: 'start' });
    h.classList.remove('flash'); void h.offsetWidth; h.classList.add('flash');
  }
  var q0 = new URLSearchParams(location.search).get('q');
  if (q0) input.value = q0;
  if (location.hash.length > 1) {
    var id0 = decodeURIComponent(location.hash.slice(1));
    requestAnimationFrame(function () { land(id0, q0 ? terms(q0) : []); });
  }

  /* ---------- heading links (#) ---------- */
  document.querySelectorAll('main section[id] > h2, main h3[id]').forEach(function (h) {
    var id = h.nodeName === 'H2' ? h.parentNode.id : h.id;
    var a = el('a', { class: 'anchor', href: '#' + id, 'aria-label': 'Link to this part' }, '#');
    h.appendChild(a);
  });

  /* ---------- contents list that follows along, with the current section's sub-headings ---------- */
  var toc = document.querySelector('nav.toc');
  var tocLinks = {};
  if (toc) {
    toc.querySelectorAll('a[href^="#"]').forEach(function (a) {
      var id = a.getAttribute('href').slice(1), sec = document.getElementById(id);
      if (!sec) return;
      tocLinks[id] = a;
      var subs = sec.querySelectorAll('h3[id]');
      if (!subs.length) return;
      var ul = el('ul', { class: 'sub' });
      subs.forEach(function (h) { var li = el('li'); li.appendChild(el('a', { href: '#' + h.id }, esc(headingText(h)))); ul.appendChild(li); });
      a.parentNode.appendChild(ul);
    });
    var headings = Array.prototype.slice.call(document.querySelectorAll('main section[id], main h3[id]'));
    var ticking = false;
    var spy = function () {
      ticking = false;
      var line = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bar-h')) + 40 || 100, cur = null;
      for (var i = 0; i < headings.length; i++) { if (headings[i].getBoundingClientRect().top <= line) cur = headings[i]; else break; }
      var sec = cur ? (cur.nodeName === 'SECTION' ? cur : cur.closest('section')) : null;
      toc.querySelectorAll('a[aria-current]').forEach(function (a) { a.removeAttribute('aria-current'); });
      toc.querySelectorAll('li.open').forEach(function (li) { li.classList.remove('open'); });
      if (!sec || !tocLinks[sec.id]) return;
      tocLinks[sec.id].setAttribute('aria-current', 'true');
      tocLinks[sec.id].parentNode.classList.add('open');
      if (cur.nodeName === 'H3') { var s = toc.querySelector('ul.sub a[href="#' + cur.id + '"]'); if (s) s.setAttribute('aria-current', 'true'); }
    };
    addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(spy); } }, { passive: true });
    addEventListener('resize', spy);
    spy();
  }

  /* ---------- copy buttons on code blocks ---------- */
  document.querySelectorAll('.code').forEach(function (codeBox) {
    var pre = codeBox.querySelector('pre');
    if (!pre || codeBox.querySelector('button')) return;
    var b = el('button', { type: 'button', 'aria-label': 'Copy code' }, 'Copy');
    b.addEventListener('click', function () {
      var reset = function () { setTimeout(function () { b.textContent = 'Copy'; }, 1500); };
      var select = function () {
        var r = document.createRange(); r.selectNodeContents(pre);
        var s = getSelection(); s.removeAllRanges(); s.addRange(r); b.textContent = 'Selected'; reset();
      };
      try { navigator.clipboard.writeText(pre.innerText).then(function () { b.textContent = 'Copied'; reset(); }, select); } catch (e) { select(); }
    });
    codeBox.appendChild(b);
  });

  /* ---------- column names on each cell, for the phone layout (docs.css) ---------- */
  document.querySelectorAll('.tablewrap table').forEach(function (t) {
    // long paths in the first column may wrap after a "/" (docs.css keeps them from breaking mid-name)
    t.querySelectorAll('td:first-child code').forEach(function (c) {
      if (c.children.length || c.textContent.length < 30 || c.textContent.indexOf('/') === -1) return;
      c.innerHTML = esc(c.textContent).replace(/\//g, '/<wbr>');
    });
    var names = Array.prototype.map.call(t.querySelectorAll('thead th'), function (th) { return th.textContent.trim(); });
    t.querySelectorAll('tbody tr').forEach(function (tr) {
      var col = 0;
      Array.prototype.forEach.call(tr.children, function (td) {
        // a cell spanning columns is labelled with all of them ("Production & Staging")
        var label = names.slice(col, col + td.colSpan).filter(Boolean).join(' & ');
        if (label) td.setAttribute('data-label', label);
        col += td.colSpan;
      });
    });
  });

  /* ---------- back to top ---------- */
  var up = el('button', { class: 'totop', type: 'button', 'aria-label': 'Back to top' }, '↑ Top');
  up.addEventListener('click', function () { scrollTo({ top: 0 }); });
  bar.querySelector('.brand').addEventListener('click', function (ev) { ev.preventDefault(); scrollTo({ top: 0 }); });
  document.body.appendChild(up);
  addEventListener('scroll', function () { up.classList.toggle('show', scrollY > 700); }, { passive: true });
})();
