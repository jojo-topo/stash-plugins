/**
 * performerFinder.js - performer suggestions for Scene Tagger.
 *
 * Loaded before sceneTagger.js (see ui.javascript in sceneTagger.yml; Stash
 * serves every file of the list as one script, in order, also to Stash UI).
 * Exposes window.stPerformerFinder; sceneTagger.js uses it if present and
 * behaves as before if not.
 *
 * Text only for now: the scene's title, file name, details and tags are
 * compared with every performer's name and aliases. Each candidate gets
 * points per signal (and keeps the reason of each), so the panel can show
 * why it is suggested and how sure it is.
 */
(function () {
  "use strict";

  // ======================================================================================
  // NOT FOR THE PUBLIC RELEASE (GitHub / forum): the face-recognition source below needs the
  // private AnimeVisage server (AnimeVisage-project/, port 7861), which is not published.
  // Before publishing set VISUAL_SOURCE to false: the scan code is never reached and
  // sceneTagger.js hides its 3 settings (stPerformerFinder.visualAvailable) and the
  // "Scan faces" button. Also remove the `csp:` block (port 7861) from sceneTagger.yml.
  // Keep it true on 8888 / the test copy.
  // ======================================================================================
  var VISUAL_SOURCE = false;

  var STASH_GQL = "/graphql";
  var CACHE_MS = 10 * 60 * 1000;
  // A performer carrying one of these tags is never suggested
  var EXCLUDE_TAGS = ["tpm:exclude", "animevisage-exclude"];

  // Points per signal. The best name signal counts, the others only add a bonus.
  var PTS = {
    fullPhrase: 60,    // full name ("kiriko overwatch") as a phrase in title/file
    fullWords: 55,     // all words of the full name present, not next to each other
    basePhrase: 50,    // several-word name without its "(series)", as a phrase
    baseSingle: 38,    // single-word name no other performer shares, its series also in the text/tags
    baseSingleNoSeries: 22, // same, but the performer has a "(series)" that appears nowhere: only under "weaker matches"
    baseAmbiguous: 22, // single-word name shared with other performers
    alias: 40,         // several-word alias
    tagAlias: 55,      // a scene tag equal to a several-word alias ("ada wong (resident evil)"): 89 % right on 8888
    tagFull: 45,       // a scene tag equal to the full name (with its series): 61 % right on 8888
    details: 25,       // name or alias only in the details
    series: 10,        // "(series)" of the name also in the text
    faceBase: 20,      // face seen on 2 frames of the video (+5 per extra frame, 40 max)
    faceStep: 5,
    faceMax: 40,
    twoSources: 10     // found both in title/file and in details
  };
  var TIER_HIGH = 55;
  var TIER_MID = 35;
  // A face alone is never sure enough to pre-check: capped just under TIER_HIGH.
  var FACE_ONLY_MAX = 54;
  // A frame counts as a sighting for a performer who is in the 2 best of a face, with a visual
  // score >= SEEN_MIN and at most SEEN_GAP points under the best (same rule as the Stash UI panel).
  var SEEN_MIN = 60;
  var SEEN_GAP = 15;

  // Same idea as the alias blacklist of titlePerformerMatch
  var ALIAS_BLACKLIST = { "unknown": 1, "n/a": 1, "na": 1, "none": 1, "unnamed": 1, "anonymous": 1, "unidentified": 1 };
  // Common words are never a name by themselves (list from FastTag)
  var STOP_WORDS = {};
  ("a an and the in on at to for of with by from as is it or be are was were not no he she his her my me you your we our " +
   "they them their this that these those all any some new top hot big get set out up down man men full clip part scene " +
   "video best good raw free one two").split(" ").forEach(function (w) { STOP_WORDS[w] = true; });

  var Q_PERFORMERS = "query PF{findPerformers(filter:{per_page:-1,sort:\"name\"}){performers{id name alias_list image_path scene_count tags{name}}}}";

  var state = { promise: null, loadedAt: 0, entries: [], byId: {} };

  // ── Text helpers ───────────────────────────────────────────────────────────

  // lowercase, no accents, camelCase and letter/digit boundaries split, punctuation -> space
  function norm(str) {
    if (!str) return "";
    var s = String(str);
    try { s = s.normalize("NFD").replace(/[̀-ͯ]/g, ""); } catch (e) {}
    s = s.replace(/([a-z])([A-Z])/g, "$1 $2")
         .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
         .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
         .replace(/([0-9])([a-zA-Z])/g, "$1 $2");
    return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  // Words of a name sorted, without its "(series)": "uzumaki hinata" and "hinata uzumaki (naruto)"
  // give the same key (Japanese / Western word order). "" for a one-word name.
  function wordKey(str) {
    var w = norm(String(str || "").replace(/\(.*?\)/g, " ")).split(" ").filter(Boolean);
    return w.length > 1 ? w.sort().join(" ") : "";
  }

  function source(text) {
    var n = norm(text);
    var tokens = n ? n.split(" ") : [];
    var set = {};
    tokens.forEach(function (t) { set[t] = true; });
    return { spaced: n ? " " + n + " " : "", tokens: tokens, set: set };
  }

  function hasPhrase(src, phrase) { return !!phrase && src.spaced.indexOf(" " + phrase + " ") !== -1; }

  // the name written as one word ("janedoe") or split over 2-3 neighbouring words
  function hasCompact(src, words) {
    var compact = words.join("");
    if (compact.length < 5) return false;
    if (words.length > 1 && src.set[compact]) return true;
    for (var i = 0; i < src.tokens.length - 1; i++) {
      if (src.tokens[i] + src.tokens[i + 1] === compact) return true;
      if (i < src.tokens.length - 2 && src.tokens[i] + src.tokens[i + 1] + src.tokens[i + 2] === compact) return true;
    }
    return false;
  }

  function stripExtension(name) { return String(name || "").replace(/\.[^/.]+$/, ""); }

  // release words of a file name that say nothing about the performers
  function cleanFilename(name) {
    return stripExtension(name).replace(/(^|[._\-\s])(1080p|720p|2160p|4k|uhd|fhd|hd|sd|x264|x265|h264|h265|hevc|aac|mp4|mkv|avi|wmv|60fps|120fps|fps|xxx|rip|webrip|bluray|dvdrip)(?=$|[._\-\s])/gi, "$1");
  }

  // "Artists: a | b" lines hold studios, not performers
  function detailsWithoutArtists(details) {
    return String(details || "").split(/\r?\n/).filter(function (l) { return !/^\s*Artists:/i.test(l); }).join("\n");
  }

  // ── Index ──────────────────────────────────────────────────────────────────

  function buildEntries(performers) {
    var baseCount = {};
    var entries = [];
    performers.forEach(function (p) {
      var tagNames = (p.tags || []).map(function (t) { return t.name; });
      if (EXCLUDE_TAGS.some(function (t) { return tagNames.indexOf(t) !== -1; })) return;
      var raw = String(p.name || "").trim();
      var paren = raw.match(/\(([^)]*)\)/);
      var series = paren ? norm(paren[1]) : "";
      var baseRaw = raw.replace(/\(.*?\)/g, "");
      var full = norm(raw);
      var base = norm(baseRaw);
      if (!full) return;
      var aliases = [];
      (p.alias_list || []).forEach(function (a) {
        var c = norm(a);
        var words = c ? c.split(" ") : [];
        // one-word aliases are too ambiguous to suggest (same rule as FastTag / titlePerformerMatch)
        if (!c || c.length <= 3 || words.length < 2 || STOP_WORDS[c] || ALIAS_BLACKLIST[String(a).trim().toLowerCase()]) return;
        aliases.push(c);
      });
      entries.push({
        id: String(p.id), name: raw, image_path: p.image_path || "", scene_count: p.scene_count || 0,
        full: full, fullWords: full.split(" "), base: base, baseWords: base ? base.split(" ") : [],
        series: series, aliases: aliases,
        baseKey: wordKey(raw), aliasKeys: (p.alias_list || []).map(wordKey).filter(Boolean)
      });
      if (base) baseCount[base] = (baseCount[base] || 0) + 1;
    });
    entries.forEach(function (e) { e.baseShared = e.base && baseCount[e.base] > 1; });
    state.byId = {};
    entries.forEach(function (e) { state.byId[e.id] = e; });
    return entries;
  }

  function load() {
    if (state.promise && Date.now() - state.loadedAt < CACHE_MS) return state.promise;
    state.loadedAt = Date.now();
    state.promise = fetch(STASH_GQL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationName: "PF", query: Q_PERFORMERS, variables: {} })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.errors && d.errors.length) throw new Error(d.errors[0].message);
        state.entries = buildEntries((d.data.findPerformers || {}).performers || []);
      })
      .catch(function (e) {
        state.promise = null;   // retry at the next call
        console.warn("[stPerformerFinder] could not load performers:", e);
        throw e;
      });
    return state.promise;
  }

  // ── Scoring ────────────────────────────────────────────────────────────────

  // Best name signal of one performer in a text; null if none
  function nameSignal(e, src, allowSingle, seriesOK) {
    // a one-word name is a "first name" below, never a sure full-name match
    if (e.fullWords.length > 1 && (hasPhrase(src, e.full) || hasCompact(src, e.fullWords))) return { k: "name", pts: PTS.fullPhrase, label: "full name" };
    if (e.fullWords.length > 1 && e.fullWords.every(function (w) { return src.set[w]; })) {
      return { k: "name", pts: PTS.fullWords, label: "all words of the name" };
    }
    if (e.base && e.baseWords.length > 1 && (hasPhrase(src, e.base) || hasCompact(src, e.baseWords))) {
      return { k: "name", pts: PTS.basePhrase, label: "name" };
    }
    if (allowSingle && e.baseWords.length === 1 && e.base.length >= 3 && !STOP_WORDS[e.base] && src.set[e.base]) {
      // a one-word name of a performer with a "(series)" needs that series somewhere (text, details or tags)
      var pts = e.baseShared ? PTS.baseAmbiguous : (e.series && !seriesOK ? PTS.baseSingleNoSeries : PTS.baseSingle);
      return { k: "name", single: true, pts: pts, label: e.baseShared ? "first name (shared)" : "first name" };
    }
    for (var i = 0; i < e.aliases.length; i++) {
      if (hasPhrase(src, e.aliases[i])) return { k: "alias", pts: PTS.alias, label: "alias " + e.aliases[i] };
    }
    return null;
  }

  function scoreEntry(e, primary, details, tagSet, tagList, tagKeys) {
    var reasons = [];
    // the "(series)" of the name written in the text, the details or a scene tag
    var seriesOK = !!e.series && (hasPhrase(primary, e.series) || hasPhrase(details, e.series) ||
      tagList.some(function (t) { return (" " + t + " ").indexOf(" " + e.series + " ") !== -1; }));
    var inPrimary = nameSignal(e, primary, true, seriesOK);
    // in the details only full names and several-word aliases count (no single first name)
    var inDetails = nameSignal(e, details, false, seriesOK);
    var best = 0;
    if (inPrimary) {
      reasons.push({ k: inPrimary.k === "alias" ? "alias" : "title", label: inPrimary.label, pts: inPrimary.pts });
      best = inPrimary.pts;
    }
    if (inDetails) {
      var dp = inPrimary ? PTS.twoSources : PTS.details;
      reasons.push({ k: "details", label: inPrimary ? "also in details" : "in details (" + inDetails.label + ")", pts: dp });
      best += dp;
    }
    // a scene tag written like the full name or a several-word alias (rule34-style character tags).
    // One-word tags and names without their series were tried: 0 right out of 86 on 8888 ("human").
    if (!inPrimary) {
      var tagPts = 0;
      if (e.aliases.some(function (a) { return tagSet[a]; })) tagPts = PTS.tagAlias;
      else if (tagSet[e.full]) tagPts = PTS.tagFull;
      // same words in another order ("hinata hyuuga (naruto)" for "uzumaki hinata"): an alias (89 % right on 8888),
      // or the name when the tag carries a "(series)" (57 %; without one only 12 %, so not used)
      else if (e.aliasKeys.some(function (k) { return tagKeys[k]; })) tagPts = PTS.tagAlias;
      else if (e.baseKey && tagKeys[e.baseKey] === 2) tagPts = PTS.tagFull;
      if (tagPts) {
        reasons.push({ k: "tag", label: "scene tag", pts: tagPts });
        best = Math.max(best, tagPts);
      }
    }
    if (!best) return null;
    // the "(series)" of the name only reinforces a name that already matched
    if (seriesOK && !hasPhrase(primary, e.full)) {
      reasons.push({ k: "series", label: "series " + e.series, pts: PTS.series });
      best += PTS.series;
    }
    return {
      score: Math.min(100, best), reasons: reasons, seriesOK: seriesOK,
      single: !!(inPrimary && inPrimary.single), strong: !!(inPrimary && !inPrimary.single && inPrimary.pts >= PTS.basePhrase)
    };
  }

  // scene: { title, details, files:[{path|basename}], tags:[{name}] }
  // opts:  { excludeIds:[...], excludeNames:[...], minScore, limit }
  function rank(scene, opts) {
    opts = opts || {};
    var minScore = typeof opts.minScore === "number" ? opts.minScore : 20;
    var limit = opts.limit || 12;
    var skipIds = {}, skipNames = {};
    (opts.excludeIds || []).forEach(function (id) { if (id) skipIds[String(id)] = true; });
    (opts.excludeNames || []).forEach(function (n) { var c = norm(n); if (c) skipNames[c] = true; });

    var file = scene && scene.files && scene.files[0];
    var fileName = file ? cleanFilename(file.basename || String(file.path || "").split(/[\\/]/).pop()) : "";
    var primary = source(((scene && scene.title) || "") + " " + fileName);
    var details = source(detailsWithoutArtists(scene && scene.details));
    // tagKeys: word-order-free key of each tag -> 2 if the tag carries a "(series)", else 1
    var tagSet = {}, tagList = [], tagKeys = {};
    ((scene && scene.tags) || []).forEach(function (t) {
      var c = norm(t.name);
      if (!c) return;
      tagSet[c] = true; tagList.push(c);
      var k = wordKey(t.name);
      if (k) tagKeys[k] = /\(.*\)/.test(t.name) ? 2 : 1;
    });

    var scored = [];
    var coveredWords = {};   // words of the several-word names found in full
    state.entries.forEach(function (e) {
      if (skipIds[e.id] || skipNames[e.full] || skipNames[e.base]) return;
      var r = scoreEntry(e, primary, details, tagSet, tagList, tagKeys);
      if (!r) return;
      if (r.strong) e.baseWords.forEach(function (w) { coveredWords[w] = true; });
      scored.push({ e: e, r: r });
    });
    // faces seen in the video (visualScan): added to the text score, or a candidate on their own
    if (VISUAL_SOURCE && opts.visual && opts.visual.length) {
      var byScored = {};
      scored.forEach(function (x) { byScored[x.e.id] = x; });
      opts.visual.forEach(function (h) {
        var id = String(h.id), e = state.byId[id];
        if (!e || skipIds[id] || h.sightings < 2) return;
        var pts = Math.min(PTS.faceMax, PTS.faceBase + PTS.faceStep * (h.sightings - 2));
        var reason = { k: "face", label: "seen on " + h.sightings + " of " + h.total + " frames", pts: pts };
        var x = byScored[id];
        if (x) {
          x.r.reasons.push(reason);
          x.r.score = Math.min(100, x.r.score + pts);
          x.r.vis = true;
        } else {
          scored.push({ e: e, r: { score: Math.min(FACE_ONLY_MAX, pts), reasons: [reason], seriesOK: false, single: false, strong: false, vis: true, faceOnly: true } });
        }
      });
    }
    var out = [];
    scored.forEach(function (x) {
      var e = x.e, r = x.r;
      if (r.score < minScore) return;
      // "briar" next to a full "yor briar": a lone word of a name already found is not another performer
      if (r.single && !r.seriesOK && !r.vis && coveredWords[e.base]) return;
      out.push({
        id: e.id, name: e.name, image_path: e.image_path, score: r.score, reasons: r.reasons, faceOnly: !!r.faceOnly,
        tier: r.score >= TIER_HIGH ? "high" : r.score >= TIER_MID ? "mid" : "low",
        _sc: e.scene_count, _len: e.full.length
      });
    });
    // best score first; then the longer (more specific) name, then the most used performer
    out.sort(function (a, b) { return b.score - a.score || b._len - a._len || b._sc - a._sc; });
    return out.slice(0, limit).map(function (c) { delete c._sc; delete c._len; return c; });
  }

  // ── Face recognition source (AnimeVisage server, optional) ─────────────────

  // Scans a scene's video through the AnimeVisage server and returns, per performer, on how many
  // frames they were seen. Hints from Stash (name, series, tags) are switched off server side:
  // the text engine above already counts them, so they must not be counted twice.
  // opts: { baseUrl, frames, onProgress(done, total), isCancelled() }
  function visualScan(sceneId, opts) {
    if (!VISUAL_SOURCE) return Promise.reject(new Error("Face recognition is not available in this build"));
    opts = opts || {};
    var base = String(opts.baseUrl || "http://localhost:7861").replace(/\/+$/, "");
    var post = function (path) {
      return fetch(base + path, { method: "POST", credentials: "omit" }).then(function (r) { return r.json(); }).then(function (j) {
        if (j.error) throw new Error(j.error);
        return j;
      });
    };
    var hits = {}, done = 0, errors = 0, lastError = "";
    return post("/scene_plan?scene=" + encodeURIComponent(sceneId) + (opts.frames ? "&frames=" + opts.frames : "")).then(function (plan) {
      var times = plan.times || [];
      var i = 0;
      function next() {
        if (i >= times.length || (opts.isCancelled && opts.isCancelled())) return Promise.resolve();
        var sec = times[i++];
        return post("/scene_frame?scene=" + encodeURIComponent(sceneId) + "&t=" + sec + "&results=6&off=nom,serie,tag,lie")
          .then(function (j) {
            (j.faces || []).forEach(function (f) {
              var ps = (f.performers || []).slice().sort(function (a, b) { return b.visual - a.visual; });
              if (!ps.length) return;
              ps.slice(0, 2).forEach(function (p) {
                if (p.visual < SEEN_MIN || ps[0].visual - p.visual > SEEN_GAP) return;
                var h = hits[p.id] || (hits[p.id] = { id: String(p.id), name: p.name, sightings: 0, best: 0, _last: -1 });
                if (h._last !== sec) { h.sightings++; h._last = sec; }
                h.best = Math.max(h.best, p.visual);
              });
            });
          })
          .catch(function (e) { errors++; lastError = String((e && e.message) || e); })
          .then(function () { done++; if (opts.onProgress) opts.onProgress(done, times.length); return next(); });
      }
      return next().then(function () {
        if (errors && errors === done) throw new Error(lastError);
        return { total: times.length, errors: errors, hits: Object.keys(hits).map(function (k) { delete hits[k]._last; hits[k].total = times.length; return hits[k]; }) };
      });
    });
  }

  window.stPerformerFinder = {
    visualAvailable: VISUAL_SOURCE,
    visualScan: visualScan,
    load: load,
    rank: rank,
    isReady: function () { return state.entries.length > 0; },
    invalidate: function () { state.promise = null; state.entries = []; },
    tiers: { high: TIER_HIGH, mid: TIER_MID }
  };
})();
