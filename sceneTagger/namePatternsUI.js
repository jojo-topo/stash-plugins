/**
 * namePatternsUI.js - the "File-name patterns" panel (big overlay) of Scene Tagger.
 *
 * Loaded after namePatterns.js (the engine) and before sceneTagger.js (see ui.javascript in
 * sceneTagger.yml). Exposes window.stNamePatternsUI.open(host) / close() / isOpen().
 * Needs window.stNamePatterns; without it open() does nothing.
 *
 * The panel knows nothing about sceneTagger.js: it talks to it through a `host` object
 *   host.getPatterns() -> array          host.setPatterns(array)   (saves)
 *   host.isOn() -> bool                  host.setOn(bool)          (saves)
 *   host.getModels() -> array            host.setModels(array)     (the user's own "Start from" models, saves)
 *   host.sampleNames() -> [file names]   the scenes currently in the panel
 *   host.finalSearch(text) -> text       the usual cleaning of "Search title", if enabled
 *   host.onChange()                      called after every change
 * Nothing here renames a file or writes anything in Stash.
 */
(function () {
  "use strict";

  var OV_ID = "st-np-ov";
  var NP = null, host = null, ov = null, keyFn = null, S = null, msgTimer = 0;

  var ICP = {
    filter: '<path d="M4 5h16l-6 7.5V19l-4 2v-8.5z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
    pencil: '<path d="M4 20l1-4L16 5l3 3L8 19z"/>',
    title: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    up: '<path d="M6 15l6-6 6 6"/>'
  };
  function ico(n) { return '<svg class="st-np-ico" viewBox="0 0 24 24" aria-hidden="true">' + ICP[n] + "</svg>"; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  var COND_OPTS = [["contains", "contains"], ["!contains", "does not contain"], ["starts", "starts with"], ["!starts", "does not start with"],
    ["ends", "ends with"], ["!ends", "does not end with"], ["regex", "matches regex"], ["!regex", "does not match regex"]];
  var TEXT_MODES = [["exact", "this exact text"], ["between", "everything between two markers"], ["before", "everything before a marker"], ["after", "a marker and everything after it"]];

  function names() { return S.base.concat(S.extra); }
  // The file names of the scenes currently in the panel (the first 8, or all of them with "Show all").
  // Names you pasted yourself (S.extra) are kept when the list is read again.
  function readBase() {
    var all = (host.sampleNames() || []).filter(Boolean);
    S.total = all.length;
    S.base = S.showAll ? all : all.slice(0, 8);
    S.cur = 0;
  }
  function applyOf(f) { return f.apply || { search: true, manual: false, title: false }; }
  function nextId() { var m = 0; S.pats.forEach(function (p) { if (p.id > m) m = p.id; }); return m + 1; }
  function condItems(p) { return ((p.only && p.only.items) || []).filter(function (i) { return String(i.text || "").trim(); }); }
  function commit() { host.setPatterns(S.pats.map(clone)); if (host.onChange) host.onChange(); }

  function usedIds() {
    if (!host.isOn()) return null;
    var u = {};
    names().forEach(function (f) {
      ["search", "manual", "title"].forEach(function (t) {
        var r = t === "title" ? NP.run(f.replace(/\.[A-Za-z0-9]{1,5}$/, ""), S.pats, t, { noExt: true }) : NP.run(f, S.pats, t);
        r.trace.forEach(function (x) { if (x.st === "hit") u[x.p.id] = true; });
      });
    });
    return u;
  }

  function hasHit(r) { return r.trace.some(function (x) { return x.st === "hit"; }); }
  function resultsFor(f) {
    var on = host.isOn();
    var rs = on ? NP.run(f, S.pats, "search") : { out: f, trace: [] };
    var rm = on ? NP.run(f, S.pats, "manual") : { out: f, trace: [] };
    var mBase = f.replace(/\.[A-Za-z0-9]{1,5}$/, "");
    var rt = on ? NP.run(mBase, S.pats, "title", { noExt: true }) : { out: mBase, trace: [] };   // the file name stands in for a scraped title
    return {
      tBefore: mBase, tAfter: hasHit(rt) ? rt.out : mBase, tTrace: rt.trace,
      sBefore: host.finalSearch(f), sAfter: host.finalSearch(hasHit(rs) ? rs.out : f), sTrace: rs.trace,
      mBefore: mBase, mAfter: hasHit(rm) ? rm.out : mBase, mTrace: rm.trace
    };
  }
  function cmp(a, b) {
    return a === b ? '<span class="st-np-same">' + esc(b) + "</span>"
      : '<span class="st-np-old">' + esc(a) + '</span> &rarr; <span class="st-np-new">' + esc(b) + "</span>";
  }

  // ---- markup ---------------------------------------------------------------------
  function skeleton() {
    return '<div class="st-np-modal" role="dialog" aria-label="File-name patterns">' +
      '<div class="st-np-mh"><h2>File-name patterns</h2>' +
        '<span class="st-np-hp">Clean the file name before it fills <b>Search title</b> (and the pre-filled manual title). Also used on the scene title when there is one. Nothing is renamed; only a pattern with <b>Scraped title</b> ticked changes what Apply saves in Stash.</span>' +
        '<span class="st-np-sw" data-a="master" title="Turn all patterns on / off"></span>' +
        '<button class="st-np-cl" data-a="close" title="Close">&#10005;</button></div>' +
      '<div class="st-np-mb">' +
        '<div class="st-np-col"><div class="st-np-lbl">My patterns <span class="st-np-r" id="st-np-count"></span></div>' +
          '<div class="st-np-list" id="st-np-list"></div>' +
          '<div class="st-np-acts"><button class="st-np-btn" data-a="new">+ New pattern</button><span id="st-np-msg" class="st-np-msg"></span></div>' +
          '<div class="st-np-lbl" style="margin-top:14px">Start from</div><div class="st-np-chips" id="st-np-presets"></div>' +
          '<details class="st-np-det"><summary>Save / share my patterns</summary>' +
            '<div class="st-np-note">Export copies your whole list. To share just one pattern, use the <b>copy</b> link on it. Paste one pattern or a list below and press Import: they are added to your list.</div>' +
            '<textarea id="st-np-io" rows="5" spellcheck="false"></textarea>' +
            '<div class="st-np-acts"><button class="st-np-ghost" data-a="exp">Export</button><button class="st-np-ghost" data-a="imp">Import</button><span id="st-np-iomsg" class="st-np-msg"></span></div>' +
          "</details></div>" +
        '<div class="st-np-col"><div class="st-np-lbl"><span id="st-np-ft">New pattern</span></div>' +
          '<div class="st-np-seg" id="st-np-seg"><button data-a="seg" data-t="words">Words</button><button data-a="seg" data-t="text">Text</button><button data-a="seg" data-t="regex">Regex</button></div>' +
          '<div class="st-np-f" id="st-np-form"></div>' +
          '<div class="st-np-pv" id="st-np-pv"></div>' +
          '<div class="st-np-acts"><button class="st-np-btn" id="st-np-save" data-a="save">Add pattern</button>' +
            '<button class="st-np-ghost" id="st-np-dup" data-a="dup" style="display:none">Duplicate</button>' +
            '<button class="st-np-ghost" id="st-np-copyf" data-a="copyform" style="display:none">Copy this pattern</button>' +
            '<button class="st-np-ghost" id="st-np-asmodel" data-a="asmodel" title="Keep this pattern as a ready-made model in &quot;Start from&quot;" disabled>Save as model</button>' +
            '<button class="st-np-ghost" id="st-np-cancel" data-a="cancel" style="display:none">Cancel</button></div>' +
          '<details class="st-np-det"><summary>Regex quick reference (only needed for the Regex type)</summary><table class="st-np-reftab">' +
            "<tr><td><code>.</code></td><td>any character</td><td><code>a.c</code> &rarr; abc, a-c</td></tr>" +
            "<tr><td><code>\\d</code> <code>\\w</code> <code>\\s</code></td><td>a digit / a letter or digit / a space</td><td><code>\\d{3,4}p</code> &rarr; 720p, 1080p</td></tr>" +
            "<tr><td><code>[abc]</code> <code>[^abc]</code></td><td>one of these / none of these</td><td><code>\\[[^\\]]*\\]</code> &rarr; [GroupX]</td></tr>" +
            "<tr><td><code>?</code> <code>*</code> <code>+</code></td><td>0 or 1 / 0 or more / 1 or more</td><td><code>x26[45]</code></td></tr>" +
            "<tr><td><code>a|b</code></td><td>a or b</td><td><code>x264|x265</code></td></tr>" +
            "<tr><td><code>^</code> <code>$</code></td><td>start / end of the name</td><td><code>_\\d+$</code></td></tr>" +
            "<tr><td><code>( )</code> and <code>$1</code></td><td>group, reused in \"Replace with\"</td><td><code>(\\d+)p</code> &rarr; <code>$1</code></td></tr>" +
          '</table><div class="st-np-note">Engine: JavaScript. Matching ignores case unless "Match case" is ticked. Lookahead / lookbehind work here but not in Stash\'s own filters. A special character (. [ ( + ?) must be written with a \\ in front to be searched as itself.</div></details></div>' +
      "</div>" +
      '<div class="st-np-test"><div class="st-np-lbl">Test on file names <span class="st-np-r" id="st-np-tcount"></span></div>' +
        '<div class="st-np-trow"><input class="st-np-inp st-np-mono" id="st-np-addname" spellcheck="false" placeholder="Paste a file name here, then press Enter or Add name"><button class="st-np-ghost" data-a="addname">Add name</button><button class="st-np-ghost" data-a="reloadnames" title="Read the scenes of the panel again (brings back the names you removed)">Reload names</button><button class="st-np-ghost" id="st-np-all" data-a="allnames" style="display:none">Show all</button></div>' +
        '<table class="st-np-res"><thead><tr><th style="width:30%">File name</th><th style="width:28%">Search title</th><th style="width:20%" id="st-np-thm">Manual title</th><th style="width:20%" id="st-np-tht" title="The file name stands in for a scraped title. Only the patterns are shown here: the &quot;Remove [names] / (numbers)&quot; settings are not applied in this test.">Scraped title</th><th>Patterns</th></tr></thead><tbody id="st-np-tbody"></tbody></table>' +
        '<div class="st-np-steps" id="st-np-steps"></div></div>' +
      '<div class="st-np-mf"><span id="st-np-foot"></span><span style="flex:1"></span><button class="st-np-btn" data-a="close">Done</button></div>' +
    "</div>";
  }

  function condPhrase(i) { return NP.COND_S[i.mode][i.not ? 1 : 0] + " <em>" + esc(String(i.text).trim()) + "</em>"; }
  function condHTML(p, used) {
    var h = "", its = condItems(p);
    if (its.length >= 3) {
      var op = !!S.openC[p.id];
      h += '<div class="st-np-cond"><button class="st-np-cbtn" data-a="tgc" type="button">' + ico("filter") + its.length + " conditions " + ico(op ? "up" : "down") + "</button></div>" +
        '<div class="st-np-cbox' + (op ? " open" : "") + '"><div>The name must match <b>' + (p.only.logic === "any" ? "any" : "all") + "</b> of:</div>" +
        its.map(function (i) { return "<div>" + condPhrase(i) + "</div>"; }).join("") + "</div>";
    } else if (its.length) {
      h += '<div class="st-np-cond">' + ico("filter") + "<span>only if the name " + its.map(condPhrase).join(p.only.logic === "any" ? " or " : " and ") + "</span></div>";
    }
    if (used && names().length && p.on !== false && !used[p.id]) h += '<div class="st-np-cond st-np-dim">never used on your test names</div>';
    return h;
  }

  function renderList() {
    var act = S.pats.filter(function (p) { return p.on !== false; }).length, used = usedIds();
    ov.querySelector("#st-np-count").textContent = "(" + act + " of " + S.pats.length + " active)";
    ov.querySelector("#st-np-list").innerHTML = S.pats.length ? S.pats.map(function (p, i) {
      var a = applyOf(p), off = p.on === false;
      return '<div class="st-np-p' + (off ? " off" : "") + (p.id === S.editId ? " sel" : "") + '" data-id="' + p.id + '">' +
        '<span class="st-np-chk" data-a="tog"><span class="st-np-cb' + (off ? "" : " on") + '">&#10003;</span></span>' +
        '<div class="st-np-info" data-a="edit"><div class="st-np-top"><span class="st-np-tp ' + p.type + '">' + p.type + '</span><span class="st-np-nm">' + esc(p.name) + "</span>" +
          '<span class="st-np-ric">' + (p.stop ? '<span class="w" title="Stops the chain when it changes a name">' + ico("stop") + "</span>" : "") +
          (a.search ? '<span title="Applies to Search title">' + ico("search") + "</span>" : "") + (a.manual ? '<span title="Applies to Manual title">' + ico("pencil") + "</span>" : "") +
          (a.title ? '<span class="t" title="Applies to the scraped title: changes what Apply saves">' + ico("title") + "</span>" : "") + "</span></div>" +
          '<div class="st-np-sm">' + esc(NP.summary(p)) + "</div>" + condHTML(p, used) + "</div>" +
        '<div class="st-np-mv"><button data-a="up" title="Move up"' + (i === 0 ? ' disabled style="opacity:.3"' : "") + '>&#9650;</button><button data-a="down" title="Move down"' + (i === S.pats.length - 1 ? ' disabled style="opacity:.3"' : "") + ">&#9660;</button></div>" +
        '<span class="st-np-x st-np-small" data-a="copy" title="Copy this pattern">copy</span><span class="st-np-x" data-a="del" title="Delete">&#10005;</span></div>';
    }).join("") : '<div class="st-np-empty">No pattern yet. Add one on the right or pick a ready-made one below.</div>';
  }

  function chk(on, label, attrs) {
    return '<span class="st-np-chk" ' + attrs + '><span class="st-np-cb' + (on ? " on" : "") + '">&#10003;</span>' + label + "</span>";
  }
  function onlyHTML(v) {
    var its = (v.only && v.only.items) || [];
    var h = '<div class="st-np-onlybox"><div class="st-np-ot">Only for some files (optional)</div>';
    if (!its.length) {
      h += '<div class="st-np-orow"><button class="st-np-ghost" data-a="addc" type="button">+ Add a condition</button><span class="st-np-hint0">Without a condition, this pattern applies to every file.</span></div>';
    } else {
      var lg = v.only.logic === "any" ? "any" : "all";
      h += '<div class="st-np-orow st-np-ohead">Apply this pattern only if the name matches ' +
        (its.length > 1 ? '<select class="st-np-sel" data-c="-1" data-k="logic" style="width:150px"><option value="all"' + (lg === "all" ? " selected" : "") + '>all of these</option><option value="any"' + (lg === "any" ? " selected" : "") + ">any of these</option></select>" : "this condition") +
        '<span class="st-np-dim">(checked on the original file name)</span></div>';
      its.forEach(function (it, i) {
        var sv = (it.not ? "!" : "") + it.mode;
        h += '<div class="st-np-orow"><select class="st-np-sel" data-c="' + i + '" data-k="sel" style="width:190px;flex:none">' +
          COND_OPTS.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === sv ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") + "</select>" +
          '<input class="st-np-inp' + (it.mode === "regex" ? " st-np-mono" : "") + '" data-c="' + i + '" data-k="text" spellcheck="false" placeholder="' + (it.mode === "regex" ? "^\\d" : "text") + '" value="' + esc(it.text) + '">' +
          '<button class="st-np-x" data-a="rmc" data-i="' + i + '" type="button" title="Remove this condition">&#10005;</button></div>';
      });
      h += '<div class="st-np-orow"><button class="st-np-ghost" data-a="addc" type="button">+ Add a condition</button></div><div class="st-np-hint st-np-wide" id="st-np-onlysum"></div>';
    }
    return h + "</div>";
  }

  function renderForm() {
    var v = S.form, h = "";
    Array.prototype.forEach.call(ov.querySelectorAll("#st-np-seg button"), function (b) { b.classList.toggle("on", b.getAttribute("data-t") === S.type); });
    if (S.type === "words") {
      h += "<label>Words</label>" + '<input class="st-np-inp" data-f="words" placeholder="1080p, x264, rarbg" value="' + esc(v.words) + '"><div class="st-np-hint">Separated by commas. Whole words only, upper / lower case ignored. No regex needed.</div>';
    } else if (S.type === "text") {
      var m = v.mode || "exact";
      h += "<label>Remove</label>" + '<select class="st-np-sel" data-f="mode">' + TEXT_MODES.map(function (o) { return '<option value="' + o[0] + '"' + (m === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") + "</select>" +
        "<label>" + (m === "between" ? "From" : "Text") + "</label>" + '<input class="st-np-inp" data-f="a" placeholder="' + (m === "between" ? "[" : " - ") + '" value="' + esc(v.a) + '">' +
        (m === "between" ? '<label>To</label><input class="st-np-inp" data-f="b" placeholder="]" value="' + esc(v.b) + '">' : "");
    } else {
      h += "<label>Find</label>" + '<input class="st-np-inp st-np-mono" data-f="find" spellcheck="false" placeholder="\\[[^\\]]*\\]" value="' + esc(v.find) + '">' +
        "<label>Replace with</label>" + '<input class="st-np-inp st-np-mono" data-f="repl" spellcheck="false" placeholder="(empty = remove)" value="' + esc(v.repl) + '">' +
        "<label></label>" + chk(!!v.cs, "Match case (upper / lower case count)", 'data-a="cs"');
    }
    var a = applyOf(v);
    h += "<label>Apply to</label>" + '<div class="st-np-orow" style="gap:18px;flex-wrap:wrap">' + chk(a.search, "Search title", 'data-a="ap" data-t="search"') + chk(a.manual, "Manual title", 'data-a="ap" data-t="manual"') + chk(a.title, "Scraped title", 'data-a="ap" data-t="title"') + "</div>" +
      '<div class="st-np-hint">Search title: the name used to search. Manual title: the title prefilled when a scrape fails (it can end up saved in Stash). <b>Scraped title</b>: the title returned by the scraper, cleaned just before Apply saves it in Stash (a title you edited by hand is left as it is). It runs after the "Remove [names] / (numbers) from the saved title" settings.</div>';
    h += onlyHTML(v);
    h += "<label></label>" + chk(!!v.stop, "Stop here if this pattern changed the name", 'data-a="stop"') + '<div class="st-np-hint">The patterns below it in the list will not be applied to that file.</div>';
    h += "<label>Name</label>" + '<input class="st-np-inp" data-f="name" placeholder="optional, e.g. Release tags" value="' + esc(v.name) + '">';
    h += '<div id="st-np-err" class="st-np-wide"></div>';
    ov.querySelector("#st-np-form").innerHTML = h;
    ov.querySelector("#st-np-ft").textContent = S.editId ? "Edit pattern" : "New pattern";
    ov.querySelector("#st-np-save").textContent = S.editId ? "Save changes" : "Add pattern";
    ov.querySelector("#st-np-dup").style.display = S.editId ? "" : "none";
    ov.querySelector("#st-np-copyf").style.display = S.editId ? "" : "none";
    ov.querySelector("#st-np-cancel").style.display = S.editId ? "" : "none";
    renderDyn();
  }

  function draft() { var p = clone(S.form); p.type = S.type; return p; }

  // What changes with every keystroke, without rebuilding the fields (keeps the cursor)
  function renderDyn() {
    var p = draft(), b = NP.build(p);
    var started = S.type === "words" ? !!p.words : S.type === "text" ? !!p.a : !!p.find;
    var a = applyOf(p), noT = !(a.search || a.manual || a.title);
    var eb = ov.querySelector("#st-np-err");
    if (eb) eb.innerHTML = b.err && (started || (b.err.indexOf("Condition") === 0)) ? '<div class="st-np-err">' + esc(b.err) + "</div>" : (noT ? '<div class="st-np-err">Choose where this pattern applies: Search title, Manual title or Scraped title.</div>' : "");
    ov.querySelector("#st-np-save").disabled = !!b.err || noT;
    ov.querySelector("#st-np-asmodel").disabled = !!b.err || noT;
    var os = ov.querySelector("#st-np-onlysum");
    if (os) os.textContent = NP.onlySentence(p) ? "In words: " + NP.onlySentence(p) + "." : "";
    var f = names()[S.cur] || "", pv = '<div class="st-np-k">This pattern alone, on the highlighted name below</div><div class="st-np-r2"><b>Name</b><span class="st-np-fnm">' + esc(f) + "</span></div>";
    if (!f) pv += '<div class="st-np-r2"><b>Result</b><span class="st-np-dim">Add a file name in the test area to see it.</span></div>';
    else if (b.err) pv += '<div class="st-np-r2"><b>Result</b><span class="st-np-dim">Fill the fields above to see what this pattern does.</span></div>';
    else if (!NP.matchesOnly(p, f)) pv += '<div class="st-np-r2"><b>Result</b><span class="st-np-fc skip">skipped: this name does not match the filter</span></div>';
    else {
      var base = NP.stripExt(f), nx = base.replace(b.re, b.repl).replace(/\s{2,}/g, " ").trim();
      pv += '<div class="st-np-r2"><b>Result</b><span>' + (nx && nx !== base ? '<span class="st-np-old">' + esc(base) + '</span> &rarr; <span class="st-np-new">' + esc(nx) + "</span>" : '<span class="st-np-same">no change on this name</span>') + "</span></div>";
    }
    ov.querySelector("#st-np-pv").innerHTML = pv;
  }

  function chips(trace) {
    return trace.map(function (t) {
      var n = esc(t.p.name || NP.summary(t.p));
      return t.st === "stopped" ? '<span class="st-np-fc" title="an earlier pattern stopped the chain for this file">' + n + ": not reached</span>"
        : t.st === "hit" ? '<span class="st-np-fc hit">' + n + "</span>"
        : t.st === "skip" ? '<span class="st-np-fc skip" title="the file name does not match the filter">' + n + ": skipped</span>"
        : t.st === "error" ? '<span class="st-np-fc error" title="' + esc(t.msg) + '">' + n + ": error</span>"
        : '<span class="st-np-fc">' + n + ": no effect</span>";
    }).join("");
  }

  function renderTable() {
    var list = names(), anyMan = S.pats.some(function (p) { return p.on !== false && NP.applies(p, "manual"); });
    ov.querySelector("#st-np-tcount").textContent = "(" + list.length + " names, click one to highlight it)";
    var allBtn = ov.querySelector("#st-np-all");
    if (allBtn) { allBtn.style.display = S.total > 8 ? "" : "none"; allBtn.textContent = S.showAll ? "Show first 8" : "Show all " + S.total; }
    var anyTitle = S.pats.some(function (p) { return p.on !== false && NP.applies(p, "title"); });
    ov.querySelector("#st-np-thm").style.display = anyMan ? "" : "none";
    ov.querySelector("#st-np-tht").style.display = anyTitle ? "" : "none";
    ov.querySelector("#st-np-tbody").innerHTML = list.map(function (f, i) {
      var r = resultsFor(f), hits = r.sTrace.filter(function (t) { return t.st === "hit"; }).length;
      var remove = '<span class="st-np-x st-np-small" data-a="rmname" data-i="' + i + '" title="Remove this name from the test (the scene is not touched)">remove</span>';
      return '<tr class="' + (i === S.cur ? "cur" : "") + '" data-i="' + i + '"><td><div class="st-np-fnm" data-a="pick">' + esc(f) + "</div>" + remove + "</td><td>" + cmp(r.sBefore, r.sAfter) + "</td>" +
        (anyMan ? "<td>" + cmp(r.mBefore, r.mAfter) + '<div class="st-np-fire">' + r.mTrace.filter(function (t) { return t.st === "hit"; }).map(function (t) { return '<span class="st-np-fc hit">' + esc(t.p.name) + "</span>"; }).join("") + "</div></td>" : "") +
        (anyTitle ? "<td>" + cmp(r.tBefore, r.tAfter) + '<div class="st-np-fire">' + r.tTrace.filter(function (t) { return t.st === "hit"; }).map(function (t) { return '<span class="st-np-fc hit">' + esc(t.p.name) + "</span>"; }).join("") + "</div></td>" : "") +
        '<td><div class="st-np-fire">' + (host.isOn() ? (hits > 1 ? '<span class="st-np-fc warn" title="Open Step by step below to see the order">' + hits + " patterns changed this name</span>" : "") + chips(r.sTrace) || '<span class="st-np-fc">no pattern</span>' : '<span class="st-np-fc skip">patterns are switched off</span>') + "</div></td></tr>";
    }).join("") || '<tr><td colspan="4" class="st-np-empty">Add a file name above to test your patterns.</td></tr>';
    var f = list[S.cur], st = ov.querySelector("#st-np-steps");
    if (f) {
      var r2 = NP.run(f, S.pats, "search");
      st.innerHTML = "<i>Step by step for the highlighted name:</i><div>" + esc(NP.stripExt(f)) + " <i>(start)</i></div>" +
        r2.trace.filter(function (t) { return t.st === "hit"; }).map(function (t) { return "<div>" + esc(t.p.name) + " <i>&rarr;</i> " + esc(t.to) + "</div>"; }).join("") +
        "<div><i>then the usual cleaning &rarr;</i> " + esc(host.finalSearch(r2.out)) + "</div>";
    } else st.innerHTML = "";
    var bad = S.pats.filter(function (p) { return p.on !== false && NP.build(p).err; });
    ov.querySelector("#st-np-foot").textContent = (host.isOn() ? "Patterns are on" : "Patterns are off") + " - " + S.pats.filter(function (p) { return p.on !== false; }).length + " active" + (bad.length ? " - " + bad.length + " skipped because of an error" : "");
  }

  function renderAll() {
    ov.querySelector(".st-np-sw").classList.toggle("on", host.isOn());
    renderList(); renderTable(); renderDyn();
  }

  // ---- actions --------------------------------------------------------------------
  function resetForm() { S.editId = null; S.form = {}; renderForm(); renderAll(); }
  function flash(id, text, ok) {
    var m = ov.querySelector(id); if (!m) return;
    m.textContent = text; m.style.color = ok ? "#8fd19e" : "#ffd48a";
    clearTimeout(msgTimer); msgTimer = setTimeout(function () { if (m) m.textContent = ""; }, 3500);
  }
  function copyPat(p) {
    var t = NP.exportOne(p), nm = p.name || NP.summary(p);
    function fallback() { ov.querySelector("#st-np-io").value = t; ov.querySelector(".st-np-det").open = true; flash("#st-np-msg", "Could not copy automatically: the text is in the box below, copy it from there.", false); }
    try { navigator.clipboard.writeText(t).then(function () { flash("#st-np-msg", 'Pattern "' + nm + '" copied.', true); }, fallback); } catch (e) { fallback(); }
  }
  function autoName(p) {
    return p.type === "words" ? String(p.words || "").split(",")[0].trim() + (String(p.words || "").split(",").length > 1 ? ", ..." : "")
      : p.type === "text" ? NP.summary(p) : "/" + p.find + "/";
  }
  // "Start from": the built-in ones, then the user's own models (each with a small x to remove it)
  function renderPresets() {
    var h = NP.PRESETS.map(function (p, i) { return '<span class="st-np-chip" data-a="preset" data-i="' + i + '">' + esc(p.label) + "</span>"; }).join("");
    h += S.models.map(function (m, i) {
      return '<span class="st-np-chip st-np-mine" data-a="model" data-i="' + i + '" title="Your own model">' + esc(m.name || NP.summary(m)) +
        '<span class="st-np-chx" data-a="rmmodel" data-i="' + i + '" title="Remove this model">&#10005;</span></span>';
    }).join("");
    ov.querySelector("#st-np-presets").innerHTML = h;
  }
  function commitModels() { if (host.setModels) host.setModels(S.models.map(clone)); }
  function saveAsModel() {
    var p = draft();
    if (S.type === "text" && !p.mode) p.mode = "exact";
    p = NP.normalize(NP.compact(p));
    if (NP.validate(p)) return;
    if (!p.name) p.name = autoName(p);
    delete p.id; delete p.on;
    var i = S.models.findIndex(function (m) { return m.name === p.name; });   // same name = replaces that model
    if (i >= 0) S.models[i] = p; else S.models.push(p);
    commitModels(); renderPresets();
    flash("#st-np-msg", 'Model "' + p.name + '" saved in "Start from".', true);
  }
  function saveForm() {
    var p = draft();
    if (S.type === "text" && !p.mode) p.mode = "exact";
    p = NP.normalize(NP.compact(p));
    if (NP.validate(p)) return;
    if (!p.name) p.name = autoName(p);
    if (S.editId) {
      var i = S.pats.findIndex(function (x) { return x.id === S.editId; });
      p.id = S.editId; p.on = S.pats[i].on; S.pats[i] = p;
    } else { p.id = nextId(); p.on = true; S.pats.push(p); }
    commit(); resetForm();
  }
  function swap(i, j) { var t = S.pats[i]; S.pats[i] = S.pats[j]; S.pats[j] = t; }
  function ensureOnly() { if (!S.form.only) S.form.only = { logic: "all", items: [] }; }
  function addName() {
    var inp = ov.querySelector("#st-np-addname"), v = inp.value.trim();
    if (!v) return;
    S.extra.push(v); S.cur = names().length - 1; inp.value = ""; renderAll();
  }

  function onClick(e) {
    if (e.target === ov) { close(); return; }
    var el = e.target.closest ? e.target.closest("[data-a]") : null;
    if (!el) return;
    var a = el.getAttribute("data-a"), row = el.closest("[data-id]"), id = row ? +row.getAttribute("data-id") : null;
    var i = S.pats.findIndex(function (x) { return x.id === id; }), p = S.pats[i];
    if (a === "close") close();
    else if (a === "master") { host.setOn(!host.isOn()); renderAll(); }
    else if (a === "tog" && p) { p.on = p.on === false; commit(); renderAll(); }
    else if (a === "edit" && p) { S.editId = id; S.type = p.type; S.form = clone(p); renderForm(); renderAll(); }
    else if (a === "up" && p && i > 0) { swap(i, i - 1); commit(); renderAll(); }
    else if (a === "down" && p && i < S.pats.length - 1) { swap(i, i + 1); commit(); renderAll(); }
    else if (a === "del" && p) { S.pats.splice(i, 1); if (S.editId === id) { S.editId = null; S.form = {}; renderForm(); } commit(); renderAll(); }
    else if (a === "copy" && p) copyPat(p);
    else if (a === "tgc" && p) { S.openC[id] = !S.openC[id]; renderList(); }
    else if (a === "new") { S.type = "words"; resetForm(); }
    else if (a === "preset") { var m = NP.PRESETS[+el.getAttribute("data-i")].make(); S.editId = null; S.type = m.type; S.form = m; renderForm(); renderAll(); }
    else if (a === "seg") { S.type = el.getAttribute("data-t"); S.form = { only: S.form.only, stop: S.form.stop, apply: S.form.apply, name: S.form.name }; renderForm(); }
    else if (a === "model") {
      var mo = S.models[+el.getAttribute("data-i")];
      if (mo) { var m2 = clone(mo); delete m2.id; delete m2.on; S.editId = null; S.type = m2.type; S.form = m2; renderForm(); renderAll(); }
    }
    else if (a === "rmmodel") { S.models.splice(+el.getAttribute("data-i"), 1); commitModels(); renderPresets(); }
    else if (a === "asmodel") saveAsModel();
    else if (a === "save") saveForm();
    else if (a === "dup") { var d = draft(); d.id = nextId(); d.on = true; d.name = (d.name || "Pattern") + " (copy)"; d = NP.normalize(NP.compact(d)); S.pats.push(d); S.editId = d.id; S.form = clone(d); commit(); renderForm(); renderAll(); }
    else if (a === "copyform") { var cp = NP.normalize(NP.compact(draft())); if (NP.build(cp).err) flash("#st-np-msg", "Fix the errors first.", false); else copyPat(cp); }
    else if (a === "cancel") resetForm();
    else if (a === "cs") { S.form.cs = !S.form.cs; renderForm(); }
    else if (a === "stop") { S.form.stop = !S.form.stop; renderForm(); }
    else if (a === "ap") { var ap = clone(applyOf(S.form)); ap[el.getAttribute("data-t")] = !ap[el.getAttribute("data-t")]; S.form.apply = ap; renderForm(); }
    else if (a === "addc") { ensureOnly(); S.form.only.items.push({ mode: "contains", not: false, text: "" }); renderForm(); var ins = ov.querySelectorAll('#st-np-form input[data-k="text"]'); if (ins.length) ins[ins.length - 1].focus(); }
    else if (a === "rmc") { ensureOnly(); S.form.only.items.splice(+el.getAttribute("data-i"), 1); renderForm(); }
    else if (a === "addname") addName();
    else if (a === "rmname") {
      var gi = +el.getAttribute("data-i");
      if (gi < S.base.length) S.base.splice(gi, 1); else S.extra.splice(gi - S.base.length, 1);
      if (S.cur >= names().length) S.cur = Math.max(0, names().length - 1);
      renderAll();
    }
    else if (a === "reloadnames") { readBase(); renderAll(); }
    else if (a === "allnames") { S.showAll = !S.showAll; readBase(); renderAll(); }
    else if (a === "pick") { var tr = el.closest("tr"); S.cur = +tr.getAttribute("data-i"); renderTable(); renderDyn(); }
    else if (a === "exp") { ov.querySelector("#st-np-io").value = NP.exportList(S.pats); flash("#st-np-iomsg", "Copy this text to back up your list.", true); }
    else if (a === "imp") {
      var r = NP.parseImport(ov.querySelector("#st-np-io").value);
      if (r.error) { flash("#st-np-iomsg", r.error, false); return; }
      r.patterns.forEach(function (q) { q.id = nextId(); S.pats.push(q); });
      commit(); renderAll();
      flash("#st-np-iomsg", r.patterns.length + " pattern(s) imported" + (r.ignored ? ", " + r.ignored + " ignored" : "") + ".", true);
    }
  }

  function onInput(e) {
    var t = e.target;
    if (t.getAttribute("data-c") !== null) {
      ensureOnly();
      var k = t.getAttribute("data-k");
      if (k === "logic") { S.form.only.logic = t.value; renderDyn(); return; }
      var it = S.form.only.items[+t.getAttribute("data-c")]; if (!it) return;
      if (k === "sel") { it.not = t.value.charAt(0) === "!"; it.mode = t.value.replace("!", ""); renderForm(); return; }
      it.text = t.value; renderDyn(); return;
    }
    var f = t.getAttribute("data-f"); if (!f) return;
    S.form[f] = t.value;
    if (f === "mode") { renderForm(); return; }
    renderDyn();
  }

  // ---- open / close -----------------------------------------------------------------
  function isOpen() { return !!ov; }
  function close() {
    if (!ov) return;
    document.removeEventListener("keydown", keyFn, true);
    if (ov.parentNode) ov.parentNode.removeChild(ov);
    ov = null; S = null; keyFn = null;
    if (host && host.onClose) host.onClose();
  }
  function open(h) {
    NP = window.stNamePatterns;
    if (!NP || !h) return;
    if (ov) { close(); }
    host = h;
    S = { pats: clone(host.getPatterns() || []), editId: null, form: {}, type: "words", cur: 0, extra: [], openC: {},
          base: [], showAll: false, total: 0, models: clone(host.getModels ? host.getModels() : []) };
    readBase();
    var n = 0; S.pats.forEach(function (p) { if (p.id == null) p.id = ++n + 100000; });
    ov = document.createElement("div");
    ov.id = OV_ID;
    ov.innerHTML = skeleton();
    document.body.appendChild(ov);
    renderPresets();
    ov.addEventListener("click", onClick);
    ov.addEventListener("input", onInput);
    ov.addEventListener("keydown", function (e) { if (e.key === "Enter" && e.target.id === "st-np-addname") { e.preventDefault(); addName(); } });
    keyFn = function (e) { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    document.addEventListener("keydown", keyFn, true);
    renderForm(); renderAll();
  }

  window.stNamePatternsUI = { open: open, close: close, isOpen: isOpen };
})();
