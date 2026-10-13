/* Puppi3's Creator Kit theme: the LIVE NOW bar (partials/kit/live-bar.hbs). Only when the live_stream_url setting
   is set. Needs kit.js (window.site) first. */
(function () {
    'use strict';

    var site = window.site;
    var sendClick = site.sendClick;

    /* Live now bar (partials/kit/live-bar.hbs): shown while the site is streaming. Every 15 s it reads the streaming server's
       status and looks for the mount the DJ software sends to; the mp3 mount listeners play is always listed, so it
       can't tell. That mount is any source other than the one the bar plays and TinyIce's own (named /_...), so
       renaming the mounts in TinyIce needs nothing here (data-mount names one, if a theme wants to).
       The track playing, when the stream sends it, comes from the same status. A listener whose stream drops
       (buffering, a network blip) is reconnected while the set is still on.

       Cushion: a listener starts burst_size behind live (128 KB, 3 s at 320 kbps), and every moment of loading,
       buffering or holding puts them further behind; playing never catches up. How far behind live they play is their
       cushion: on a connection that keeps up, the stream keeps arriving at live speed, so that much is downloaded and
       not played yet. Before playing (at every start, and after a stall) the player holds, paused and muted, until it's
       CUSHION behind live: one wait of a few seconds, then dips shorter than that aren't heard. It counts time rather
       than reading player.buffered, because Chrome doesn't report what it downloads while paused. Not in a background
       tab or on a locked phone: there a browser may not let the page play again after pausing itself.

       Slow connections: TinyIce keeps only the last 512 KB of the stream (13 s at 320 kbps). When the player stalls it
       has played everything it downloaded, so it's as far behind live as TinyIce is in sending to it. Past 512 KB
       TinyIce jumps them forward mid-frame, which sounds like a record scratch. So once a connection is BEHIND_LIMIT
       behind (burst aside) during a stall, it reconnects, while it's silent anyway, which starts it again near live
       before TinyIce would jump it. A hold doesn't reconnect: the stream keeps arriving meanwhile. On a slow connection
       Chrome takes ~8 s to start (that counts), so burst + first load stays under 13 s only with a small burst. A lower
       bitrate or burst only makes this more cautious. */
    var liveBar = document.getElementById('live-now');
    if (liveBar && window.fetch) {
        var liveStatus = liveBar.getAttribute('data-status');
        var liveMount = liveBar.getAttribute('data-mount') || '';
        var liveStream = liveBar.getAttribute('data-stream');
        var streamMount = '';
        try { streamMount = new URL(liveStream, location.href).pathname; } catch (e) {}
        var player = liveBar.querySelector('audio');
        var trackEl = liveBar.querySelector('.live-bar__track');
        var CHECK_EVERY = 15000;     // ms between status checks
        var STALL_LIMIT = 10000;     // ms of buffering before reconnecting
        var FIRST_LOAD_LIMIT = 20000; // ms the first load may take (Chrome on a slow line: ~11 s)
        var BEHIND_LIMIT = 8000;     // ms of loading + buffering + holding on one connection before a
                                     // stall reconnects (+ the 3 s burst stays under TinyIce's 13 s)
        var BURST = 3;               // s TinyIce sends at once on connecting (burst_size 128 KB at 320 kbps)
        var CUSHION = 8;             // s behind live before it plays, at every start and after a stall
        var REBUFFER = 2;            // s buffered ahead before playing on after a stall (Chrome shows ~3 s at most)
        var HOLD_NO_GROWTH = 2000;   // ms a hold after a stall waits for that to grow before playing on anyway
        var SAYS_ALL = 750;          // ms without growth before taking what the player says it has as all it
                                     // will say (Chrome stops at ~2 s; Firefox shows everything it downloads)
        var JUMP_AT = 15;            // s behind live past which a hold jumps forward to CUSHION (a stall
                                     // reconnects at ~11 s, so mostly after a slow first load)
        var JUMP_FOR = 2000;         // ms a hold may jump for (a slow line only trickles) before playing on
        var checkTimer = null, checking = false;
        var wantPlaying = false;     // the visitor pressed play and hasn't paused
        var retries = 0, retryTimer = null, stallTimer = null;
        var stallStart = 0;          // when the current stall or hold began, 0 = neither
        var holding = false;         // paused by the player itself, building up its cushion
        var refilling = false;       // the hold is after a stall (not a start)
        var hushed = false;          // muted by the player for a hold (the visitor's own mute is left alone)
        var holdBegan = 0, holdStart = 0, holdAhead = 0, stallTicker = null;
        var started = false;         // this connection has played
        var connectedAt = 0;         // when this connection started loading, 0 = none yet
        var loads = 0;               // counts new sources given to the player (playNow)
        var watchTimer = null, lastT = 0, lastWall = 0, slowSince = 0;   // watchProgress
        var pausedByVisitor = false; // play again starts a fresh connection
        var statusEl = liveBar.querySelector('.live-bar__buffering');
        var playBtn = liveBar.querySelector('.live-bar__play');
        var volumeEl = liveBar.querySelector('.live-bar__volume');
        player.src = liveStream;

        // a mascot that says what the player is doing, if a theme adds one (window.site.livePup); else nothing
        var noop = function () {};
        var pup = site.livePup || { start: noop, reconnecting: noop, trouble: noop, buffering: noop, playing: noop,
                                    paused: noop, idle: noop, track: noop };

        var mountOf = function (s) { return s.mount || (String(s.listenurl || '').match(/\/[^\/]+$/) || [''])[0]; };
        // "Artist – Title" from a source, or '' when it sends none (TinyIce says "N/A")
        var trackOf = function (s) {
            return [s.artist, s.title].filter(function (part) {
                part = String(part == null ? '' : part).trim();
                return part && part !== 'N/A' && part !== '-';
            }).join(' – ');
        };
        // What the status says: false when not live, else { track } (the live mount's track, or the one the mp3 mount
        // reports, which TinyIce may copy over when it transcodes)
        var liveInfo = function (status) {
            var sources = (status && status.icestats && status.icestats.source) || [];
            if (!Array.isArray(sources)) sources = [sources];   // Icecast sends one source as an object
            sources = sources.filter(Boolean);
            var isLive = liveMount ? function (m) { return m === liveMount; }
                : function (m) { return m && m !== streamMount && m.indexOf('/_') !== 0; };
            var live = sources.filter(function (s) { return isLive(mountOf(s)); })[0];
            if (!live) return false;
            var track = trackOf(live);
            sources.forEach(function (s) { if (!track) track = trackOf(s); });
            return { track: track };
        };

        // { track } = live, false = not live, null = couldn't tell (the status didn't load)
        var readStatus = function () {
            var ctrl = new AbortController();
            var giveUp = setTimeout(function () { ctrl.abort(); }, 5000);
            return fetch(liveStatus, { signal: ctrl.signal, cache: 'no-store' })
                .then(function (r) { if (!r.ok) throw r; return r.json(); })
                .then(liveInfo, function () { return null; })
                .then(function (live) { clearTimeout(giveUp); return live; });
        };

        // The set ended: stop the player
        var stopPlayer = function () {
            stopWanting();
            if (!player.paused) player.pause();
            disconnect();
            pup.idle();
        };

        // Drop the connection (pressing play starts a new one, near live) and forget its stalls
        var disconnect = function () {
            resetStalls(); pausedByVisitor = false;
            reload();
        };
        // The stream as the player's source again, not loading yet (preload none: nothing is fetched until play)
        var reload = function () { loads++; player.src = liveStream; player.load(); };

        var showLive = function (live) {
            if (live === null) {                 // couldn't tell: keep a listener's bar, hide it for everyone else
                if (!wantPlaying) liveBar.hidden = true;
                return;
            }
            if (!live && wantPlaying) stopPlayer();
            // A paused player still holds its connection (for the lock screen): drop it once the set is over, or
            // TinyIce counts it as a listener for as long as the tab stays open
            if (!live && pausedByVisitor) disconnect();
            liveBar.hidden = !live;
            showTrack(live ? live.track : '');
        };

        // The track, in the bar and on the phone's lock screen / media controls
        var shownTrack = null;
        var showTrack = function (track) {
            if (track === shownTrack) return;
            if (track && shownTrack && wantPlaying) pup.track();
            shownTrack = track;
            trackEl.textContent = track;
            trackEl.title = track;          // the whole name, when the bar cuts it short
            trackEl.hidden = !track;
            if ('mediaSession' in navigator && window.MediaMetadata) {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: track || 'Live now',
                    artist: liveBar.getAttribute('data-artist') || ''
                });
            }
        };

        var checkLive = function () {
            // A hidden tab doesn't check (unless it's playing, or paused and still connected, so it can let go when the
            // set ends); it checks again the moment it's shown
            if (checking || (document.hidden && !wantPlaying && !pausedByVisitor)) return;
            checking = true;
            readStatus().then(function (live) {
                checking = false;
                showLive(live);
                clearTimeout(checkTimer);
                checkTimer = setTimeout(checkLive, CHECK_EVERY);
            });
        };

        // The stream dropped while they were listening: if the set is still on, reconnect and carry on playing, waiting
        // longer after each failed try (1, 2, 4… up to 30 s). `now`: at once, for a stall that has fallen too far
        // behind (every second waited puts it further back).
        var dropped = function (e, now) {
            if (!wantPlaying || retryTimer) return;
            clearTimeout(stallTimer);
            if (!retries) hiccup('reconnect', now ? 'behind' : e ? 'dropped' : started ? 'stuck' : 'slowstart');   // a run of retries counts once
            // Once is a hiccup; failing again before anything played means it can't reach the stream (e.g. a 404 from
            // TinyIce): say so, and keep saying it until it plays or stops
            if (retries) {
                pup.trouble();
                showStatus('Can\'t reach the stream, retrying…');
            } else pup.reconnecting();
            var wait = now ? 0 : Math.min(30000, 1000 * Math.pow(2, retries++));
            retryTimer = setTimeout(function () {
                retryTimer = null;
                readStatus().then(function (live) {
                    showLive(live);
                    if (live === false || !wantPlaying) return;   // couldn't tell: try anyway, a failure retries
                    if (interrupted()) { outsidePause(); return; }
                    reconnect();
                });
            }, wait);
            // A failed player ignores play until it's given a source again, so the play button did nothing while it
            // waited: load the stream again now (preload none: nothing is fetched) so pressing play works, and tries at
            // once (the 'play' listener)
            if (player.error) reload();
        };

        // A fresh connection, played at once: TinyIce starts it near live
        var reconnect = function () {
            resetStalls();
            connectedAt = Date.now();
            loads++; player.src = liveStream + (liveStream.indexOf('?') < 0 ? '?' : '&') + 'r=' + Date.now();
            playNow();
        };

        // Phone calls: like a native player, nothing here starts playing while the phone has the audio. Safari (iOS
        // 16.4+) says so outright; elsewhere the phone refuses play() (NotAllowedError).
        var interrupted = function () {
            return !!(navigator.audioSession && navigator.audioSession.state === 'interrupted');
        };
        // Stopped from outside (the visitor, a call, unplugged headphones): no retries or reconnects; play, in the bar
        // or on the lock screen, starts a fresh connection
        var outsidePause = function () {
            stopWanting(); endStall();
            pausedByVisitor = true;
            pup.paused();
        };
        // No more playing, retrying or waiting on a stall, and no status
        var stopWanting = function () {
            wantPlaying = false; showPlaying();
            clearTimeout(stallTimer); clearTimeout(retryTimer); retryTimer = null; retries = 0;
            showStatus('');
        };
        var playFailed = function (err) {
            if (err && err.name === 'NotAllowedError') outsidePause();
            else dropped(err);
        };
        // Play, and take a refusal as a failure, unless a newer source has been given since (reconnect, disconnect):
        // that cut it short and is in charge. Taken as a drop, its retry timer made the reconnect's own 'play' look
        // like the visitor's, which reconnected again, in a loop (Chrome, while a connection sends nothing: its play
        // stays pending until data comes). Safari can abort the play right after a new source too: that one counts.
        var playNow = function () {
            var at = loads;
            player.play().catch(function (err) {
                if (!(err && err.name === 'AbortError' && at !== loads)) playFailed(err);
            });
        };
        // End a hold and play on (once: a refusal is the phone's pause)
        var playOn = function () {
            endStall();
            if (interrupted()) { outsidePause(); return; }
            playNow();
        };

        // How far behind live it plays, burst aside: the time since connecting minus what it has played (loading,
        // stalls, holds and playing in bits all count; a jump forward counts back), and its cushion: seconds behind
        // live
        var behind = function () { return connectedAt ? Date.now() - connectedAt - player.currentTime * 1000 : 0; };
        var cushion = function () { return BURST + behind() / 1000; };
        var bufferedAhead = function () {   // seconds the player has ready (not all it has downloaded)
            var b = player.buffered;
            return b.length ? b.end(b.length - 1) - player.currentTime : 0;
        };
        // Mute for a hold: the browser has started playing when it says so, and the hold's pause would let a blip
        // through
        var hush = function () {
            if (!player.muted && !document.hidden) { player.muted = true; hushed = true; }
        };
        var unhush = function () {
            if (hushed) { player.muted = false; hushed = false; }
        };
        // The status screen readers get (the puppy is decoration): '' hides it
        var showStatus = function (text) {
            if (!statusEl) return;
            statusEl.hidden = !text;
            if (text) statusEl.textContent = text;
        };
        var BUFFERING = 'Buffering…';
        var showBuffering = function (on) {   // off leaves a "can't reach" status alone
            if (on) showStatus(BUFFERING);
            else if (statusEl && statusEl.textContent === BUFFERING) showStatus('');
        };
        // Hiccups, counted by the bridge like plays (Grafana's Health dashboard): a stall (`why` buffering: the browser
        // ran dry; trickle: Firefox playing in bits) or a reconnect (dropped: the connection ended or failed; stuck: no
        // data for STALL_LIMIT; slowstart: the first load took FIRST_LOAD_LIMIT; behind: BEHIND_LIMIT), whether the tab
        // was showing, and a phone/tablet or computer and which browser; nothing about the visitor. All listeners at
        // once is the stream; one is their connection or device.
        var ua = navigator.userAgent;
        var DEVICE = /Mobi|Android|iPhone|iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'mobile' : 'computer';
        var BROWSER = /Edg\//.test(ua) ? 'edge' : /Firefox\/|FxiOS/.test(ua) ? 'firefox' : /Chrome\/|CriOS/.test(ua) ? 'chrome' :
            /Safari\//.test(ua) ? 'safari' : 'other';
        var hiccup = function (kind, why) {
            sendClick('kind=' + kind + '&why=' + why + '&hidden=' + (document.hidden ? 1 : 0) + '&device=' + DEVICE + '&browser=' + BROWSER);
        };
        var resetStalls = function () { endStall(); started = false; connectedAt = 0; };   // and forget the connection
        var endStall = function () {
            stallStart = 0; holding = false;
            clearInterval(stallTicker); stallTicker = null;
            showBuffering(false); unhush();
        };
        // While holding: more than JUMP_AT behind live (mostly after a slow first load), jump forward to CUSHION, a
        // step at a time within what the player says it has ready: further than that, the browser would ask TinyIce for
        // that part, and a live stream can't seek (Chrome has more downloaded than it says: the next step is ready at
        // once). Then play on once the cushion is built up (and, after a stall, a few seconds are ready, or that
        // stopped growing: some phones don't download while paused). While stalled, or holding after a stall that isn't
        // filling: reconnect once it's too far behind (it's silent anyway, so no jump is heard). A start's hold
        // doesn't: the stream keeps arriving.
        var stallTick = function () {
            if (!wantPlaying) { endStall(); return; }
            if (interrupted()) { outsidePause(); return; }   // a call during a stall or hold
            if (holding) {
                var ahead = bufferedAhead();
                if (ahead > holdAhead + 0.25) { holdAhead = ahead; holdStart = Date.now(); }
                var held = Date.now() - holdBegan;
                // Too far behind after a stall (a moment for its data to come back first): reconnect
                if (refilling && held >= 500 && behind() > BEHIND_LIMIT) { endStall(); dropped(null, true); return; }
                var c = cushion();
                if (c > JUMP_AT && ahead > 1 && held < JUMP_FOR) {
                    var by = Math.min(c - CUSHION, ahead - 0.5);
                    player.currentTime += by;   // that much closer to live
                    holdAhead = bufferedAhead(); holdStart = Date.now();
                    return;
                }
                // Where the player says what it has (Firefox), CUSHION of it really there: on a line slower than the
                // stream the time alone overstates it. A start's hold on a line too slow to fill it plays what's there
                // before TinyIce would have to skip it.
                var still = Date.now() - holdStart;   // since what it has last grew
                var filled = (ahead >= CUSHION - 0.5 || still > SAYS_ALL) &&
                    (!refilling || ahead >= REBUFFER || still > HOLD_NO_GROWTH);
                var late = !refilling && behind() > BEHIND_LIMIT - 1000;
                var ready = (filled || late) && (c <= JUMP_AT || held >= JUMP_FOR);
                if (ready && c >= CUSHION) playOn();
                return;
            }
            if (behind() > BEHIND_LIMIT) { endStall(); dropped(null, true); }
        };
        var startStall = function () {
            if (!stallStart) stallStart = Date.now();
            showBuffering(true);   // a hold pauses the player, so say why
            pup.buffering();
            tickStall();
        };
        var tickStall = function () { if (!stallTicker) stallTicker = setInterval(stallTick, 250); };
        // Pause (muted) until stallTick plays on; `refill`: after a stall
        var beginHold = function (refill) {
            refilling = refill;
            if (!stallStart) stallStart = Date.now();
            holding = true; holdBegan = holdStart = Date.now(); holdAhead = bufferedAhead();
            player.pause();
            showBuffering(true);
            tickStall();
        };
        // Firefox doesn't say 'waiting' when the stream runs dry: it plays what trickles in, in bits. A second of
        // playing at under half speed, or with almost nothing ready (in a shown tab, once it has played; Chrome always
        // shows ~2 s ready while playing), counts as a stall: hold to refill.
        var watchProgress = function () {
            var now = Date.now(), t = player.currentTime;
            if (!wantPlaying) { clearInterval(watchTimer); watchTimer = null; return; }
            var slow = t - lastT < (now - lastWall) / 2000 || bufferedAhead() < 0.25;
            lastT = t; lastWall = now;
            if (!slow || !started || holding || stallStart || player.paused || document.hidden) { slowSince = 0; return; }
            if (!slowSince) slowSince = now;
            if (now - slowSince < 1000) return;
            slowSince = 0;
            hiccup('stall', 'trickle');
            startStall(); hush();
            beginHold(true);
        };

        // The button shows what the visitor asked for: pause while it loads, buffers or reconnects too
        var showPlaying = function () {
            liveBar.toggleAttribute('data-playing', wantPlaying);
            playBtn.setAttribute('aria-label', wantPlaying ? 'Pause the live stream' : 'Play the live stream');
        };
        // Pausing during a hold or a wait to reconnect: the player is already paused, so no 'pause' event says so. Play
        // goes through the 'play' listener like the lock screen's.
        playBtn.addEventListener('click', function () {
            if (wantPlaying) { outsidePause(); player.pause(); }
            else playNow();   // (play after a pause reconnects, cutting this one short)
        });
        // Volume where there's a slider (not phones), remembered on this device
        try { var savedVolume = localStorage.getItem('live-volume'); } catch (e) {}
        if (savedVolume !== null && savedVolume !== undefined && savedVolume !== '' && !isNaN(savedVolume)) {
            volumeEl.value = savedVolume; player.volume = +savedVolume;
        }
        volumeEl.addEventListener('input', function () {
            player.volume = +volumeEl.value;
            try { localStorage.setItem('live-volume', volumeEl.value); } catch (e) {}
        });

        player.addEventListener('play', function () {
            if (!wantPlaying) {   // the visitor pressed play (a reconnect doesn't count)
                sendClick('kind=play');
                pup.start();
            }
            wantPlaying = true; showPlaying();
            if (retryTimer) {
                // Play pressed while it waits to retry (only the visitor plays then): try now
                clearTimeout(retryTimer); retryTimer = null;
                reconnect();
                return;
            }
            if (pausedByVisitor) {
                // Play after a pause: the paused connection has fallen behind live (TinyIce may have dropped what it
                // holds), so start a fresh one. Kept until now so the phone's lock screen and headphone controls still
                // work after a call or unplugging.
                pausedByVisitor = false;
                reconnect();
                return;
            }
            if (!started && !connectedAt) connectedAt = Date.now();
            if (!watchTimer) { lastT = player.currentTime; lastWall = Date.now(); slowSince = 0; watchTimer = setInterval(watchProgress, 250); }
            if (holding) endStall();   // the visitor pressed play during a hold: their call
            else if (!started) hush();  // a first start holds (reconnect() plays through here too)
        });
        player.addEventListener('playing', function () {
            retries = 0; clearTimeout(stallTimer); showStatus('');
            clearTimeout(retryTimer); retryTimer = null;   // it's playing: a reconnect still pending isn't needed
            var first = !started;   // (the first load counts: live kept going while it loaded)
            started = true; slowSince = 0;
            if (holding) return;
            // Starting, or data came back after a stall (not the play at the end of a hold): hold (counted like a
            // stall) until it's CUSHION behind live (jumping forward to that when it's more than JUMP_AT behind), and,
            // after a stall, has a few seconds ready, rather than playing a scrap and stalling again at the first dip.
            // Not in a background tab or on a locked phone: there a browser may not let the page play again after
            // pausing itself, so it carries on by itself.
            if (wantPlaying && !document.hidden && (first || stallStart) &&
                    (cushion() < CUSHION || cushion() > JUMP_AT || bufferedAhead() < CUSHION - 0.5)) {
                beginHold(!!stallStart);
                return;
            }
            endStall();
            pup.playing();
        });
        player.addEventListener('pause', function () {
            if (holding) return;   // the player's own hold
            // Browsers also pause just before an 'ended' or 'error' when the stream drops, so wait a moment: only a
            // pause that isn't followed by one of those is the visitor's.
            setTimeout(function () {
                if (player.paused && !player.ended && !player.error && !retryTimer && !holding && wantPlaying) {
                    outsidePause();   // (or the phone: a call, unplugged headphones)
                }
            }, 500);
        });
        player.addEventListener('ended', dropped);
        player.addEventListener('error', dropped);
        player.addEventListener('waiting', function () {
            if (!wantPlaying || holding) return;   // (a hold's jump forward can wait for data)
            if (started) {   // its 'playing' when data comes back may hold
                if (!stallStart) hiccup('stall', 'buffering');   // (it can say 'waiting' more than once a stall)
                startStall(); hush();
            }
            clearTimeout(stallTimer);
            stallTimer = setTimeout(dropped, started ? STALL_LIMIT : FIRST_LOAD_LIMIT);
        });
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) { checkLive(); return; }
            // Hidden during a hold (phone locked, tab switched): play on now. A locked phone stops the page's timers,
            // and the player is paused, so the hold would never end by itself. A call also hides the page: then the
            // phone refuses, and it's left paused like any call.
            if (holding) playOn();
        });
        checkLive();
    }
})();
