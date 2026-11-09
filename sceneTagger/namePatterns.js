/**
 * namePatterns.js - file-name cleaning patterns for Scene Tagger.
 *
 * Loaded before sceneTagger.js (see ui.javascript in sceneTagger.yml). Exposes
 * window.stNamePatterns; sceneTagger.js uses it if present and behaves as before
 * if not. Also loadable in Node (module.exports) for the tests in
 * Taggers-project/tests/.
 *
 * Pure functions only: no DOM, no Stash calls, no access to sceneTagger.js
 * variables. Nothing here renames a file or writes anything in Stash.
 *
 * A pattern is a plain object:
 *   { id, name, type: "words" | "text" | "regex", on: true,
 *     words              (words)  "1080p, x264, rarbg"
 *     mode, a, b         (text)   mode = exact | between | before | after
 *     find, repl, cs     (regex)  cs = match case; repl "" = remove
 *     apply: { search: true, manual: false, title: false },   title = the scraped title, cleaned before Apply saves it
 *     only:  { logic: "all" | "any", items: [{ mode, not, text }] }   (optional)
 *     stop:  true  -> the patterns below are skipped for a file this one changed }
 * A condition mode is contains | starts | ends | regex. Conditions are checked
 * against the ORIGINAL file name, so an earlier pattern cannot change who a later
 * one applies to.
 *
 * Engine: JavaScript RegExp (the code runs in the browser), case-insensitive
 * unless "Match case". JavaScript has no protection against catastrophic
 * backtracking, so patterns and names are length-limited.
 */
(function (root) {
  "use strict";

  var MAX_PATTERN = 300;   // characters in a regex / condition regex
  var MAX_TEXT = 1000;     // a longer name is left untouched
  var TYPES = ["words", "text", "regex"];
  var COND_MODES = ["contains", "starts", "ends", "regex"];
  var TEXT_MODES = ["exact", "between", "before", "after"];

  // Sentence pieces: [positive, negative]
  var COND_S = {
    contains: ["contains", "does not contain"],
    starts: ["starts with", "does not start with"],
    ends: ["ends with", "does not end with"],
    regex: ["matches regex", "does not match regex"]
  };

  function esc(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // JavaScript's own messages are cryptic: say what to do.
  function friendlyRegexError(msg) {
    msg = String(msg || "");
    if (/Unterminated group/i.test(msg)) return "A ( is never closed: add the matching ).";
    if (/Unmatched '\)'/i.test(msg)) return "A ) has no matching ( before it.";
    if (/Nothing to repeat/i.test(msg)) return "A * + or ? needs something in front of it (a letter, a class like \\d, or a group).";
    if (/Unterminated character class/i.test(msg)) return "A [ is never closed: add the matching ].";
    if (/Invalid group/i.test(msg)) return "This group syntax is not supported by JavaScript (for example (?P<name>...)). Use (?<name>...) or a plain ( ).";
    if (/\\ at end of pattern/i.test(msg)) return "The pattern ends with a lone backslash \\ : write \\\\ for a literal backslash.";
    return msg.replace(/^Invalid regular expression: /, "");
  }

  function stripExt(s) {
    return String(s || "").replace(/\.[A-Za-z0-9]{2,4}$/, "");
  }

  function tidy(s) {
    return s.replace(/\s{2,}/g, " ").trim();
  }

  function applyOf(p) {
    return (p && p.apply) || { search: true, manual: false, title: false };
  }

  // target: "search" | "manual" | "title" (the title returned by the scraper, cleaned before Apply saves it)
  function normTarget(t) { return t === "manual" || t === "title" ? t : "search"; }
  function applies(p, target) {
    return !!applyOf(p)[normTarget(target)];
  }

  // ---- conditions -------------------------------------------------------------

  function condItems(p) {
    var o = p && p.only;
    return o && Array.isArray(o.items) ? o.items : [];
  }

  function usedItems(p) {
    return condItems(p).filter(function (i) { return String((i && i.text) || "").trim(); });
  }

  function condError1(it) {
    if (it.mode === "regex" && String(it.text || "").trim()) {
      if (it.text.length > MAX_PATTERN) return "this regex is too long (" + MAX_PATTERN + " characters max).";
      try { new RegExp(it.text, "i"); } catch (e) { return friendlyRegexError(e.message); }
    }
    return "";
  }

  function condError(p) {
    var its = condItems(p);
    for (var k = 0; k < its.length; k++) {
      var e = condError1(its[k]);
      if (e) return "Condition: " + e;
    }
    return "";
  }

  function condTest(it, name) {
    var t = String(it.text || "").trim();
    if (!t) return true;
    var r;
    if (it.mode === "regex") {
      try { r = new RegExp(t, "i").test(name); } catch (e) { r = false; }
    } else {
      var a = name.toLowerCase(), b = t.toLowerCase();
      r = it.mode === "starts" ? a.indexOf(b) === 0
        : it.mode === "ends" ? a.length >= b.length && a.lastIndexOf(b) === a.length - b.length
        : a.indexOf(b) > -1;
    }
    return it.not ? !r : r;
  }

  // True if the pattern applies to this ORIGINAL file name.
  function matchesOnly(p, original) {
    var its = usedItems(p);
    if (!its.length) return true;
    var name = String(original);
    var any = p.only.logic === "any";
    for (var k = 0; k < its.length; k++) {
      var ok = condTest(its[k], name);
      if (any && ok) return true;
      if (!any && !ok) return false;
    }
    return !any;
  }

  function onlySentence(p) {
    var its = usedItems(p);
    if (!its.length) return "";
    var parts = its.map(function (i) {
      return COND_S[i.mode][i.not ? 1 : 0] + ' "' + String(i.text).trim() + '"';
    });
    return "only if the name " + parts.join(p.only.logic === "any" ? " or " : " and ");
  }

  // ---- building and running ---------------------------------------------------

  // -> { re, repl } or { err }
  function build(p) {
    var ce = condError(p);
    if (ce) return { err: ce };
    try {
      if (p.type === "words") {
        var w = String(p.words || "").split(/[,\n]/).map(function (x) { return x.trim(); }).filter(Boolean);
        if (!w.length) return { err: "Type at least one word, separated by commas." };
        // A word alone inside [..] or (..) goes with its brackets ("[4K]" leaves no empty "[]").
        var alt = w.map(esc).join("|");
        return { re: new RegExp("\\[\\s*(?:" + alt + ")\\s*\\]|\\(\\s*(?:" + alt + ")\\s*\\)|(?<![A-Za-z0-9])(?:" + alt + ")(?![A-Za-z0-9])", "gi"), repl: " " };
      }
      if (p.type === "text") {
        var mode = p.mode || "exact";
        if (!p.a) return { err: mode === "between" ? "Type where the text starts." : "Type the text to look for." };
        if (mode === "between" && !p.b) return { err: "Type where the text ends." };
        var a = esc(p.a), b = esc(p.b || "");
        var src = { exact: a, before: "^[\\s\\S]*?(?=" + a + ")", after: a + "[\\s\\S]*$", between: a + "[\\s\\S]*?" + b }[mode];
        if (!src) return { err: "Unknown text mode." };
        return { re: new RegExp(src, "gi"), repl: " " };
      }
      if (p.type === "regex") {
        var f = String(p.find || "");
        if (!f) return { err: "Type the pattern to look for." };
        if (f.length > MAX_PATTERN) return { err: "This pattern is too long (" + MAX_PATTERN + " characters max)." };
        var flags = "g" + (p.cs ? "" : "i");
        if (/^\(\?i\)/.test(f)) { f = f.slice(4); flags = "gi"; } // (?i) is tolerated: it just means "ignore case"
        return { re: new RegExp(f, flags), repl: p.repl != null && p.repl !== "" ? p.repl : " " };
      }
      return { err: "Unknown pattern type." };
    } catch (e) {
      return { err: friendlyRegexError(e.message) };
    }
  }

  // One-line description of what the pattern does (without its conditions).
  function summary(p) {
    if (p.type === "words") return p.words || "";
    if (p.type === "text") {
      var m = p.mode || "exact";
      return {
        exact: 'remove "' + p.a + '"',
        before: 'everything before "' + p.a + '"',
        after: '"' + p.a + '" and everything after',
        between: 'from "' + p.a + '" to "' + p.b + '"'
      }[m] || "";
    }
    return "/" + (p.find || "") + "/" + (p.repl ? " → " + p.repl : "") + (p.cs ? " (match case)" : "");
  }

  // The whole check for the form: "" if the pattern can be saved.
  function validate(p) {
    var b = build(p);
    if (b.err) return b.err;
    var a = applyOf(p);
    if (!a.search && !a.manual && !a.title) return "Choose where this pattern applies: Search title, Manual title or Scraped title.";
    return "";
  }

  // Runs the patterns, in order, on a file name (extension removed first).
  // target: "search" | "manual". Patterns that do not apply to the target are not
  // in the trace. Returns { out, trace, tooLong } where each trace entry is
  // { p, st: "hit" | "none" | "skip" | "error" | "stopped", to?, msg? }.
  // Never returns an empty text: a pattern that would empty the name is ignored.
  function run(file, patterns, target, opts) {
    target = normTarget(target);
    var original = String(file || "");
    // opts.noExt: the text is a title, not a file name (nothing to strip at its end)
    var cur = opts && opts.noExt ? original : stripExt(original);
    var trace = [];
    if (cur.length > MAX_TEXT) return { out: cur, trace: trace, tooLong: true };
    var stopped = false;
    (patterns || []).forEach(function (p) {
      if (!p || p.on === false || !applies(p, target)) return;
      if (stopped) { trace.push({ p: p, st: "stopped" }); return; }
      var b = build(p);
      if (b.err) { trace.push({ p: p, st: "error", msg: b.err }); return; }
      if (!matchesOnly(p, original)) { trace.push({ p: p, st: "skip" }); return; }
      var next = tidy(cur.replace(b.re, b.repl));
      if (next && next !== cur) {
        trace.push({ p: p, st: "hit", to: next });
        cur = next;
        if (p.stop) stopped = true;
      } else {
        trace.push({ p: p, st: "none" });
      }
    });
    return { out: cur, trace: trace };
  }

  // Just the text (what sceneTagger.js needs).
  function apply(file, patterns, target, opts) {
    return run(file, patterns, target, opts).out;
  }

  // ---- storage / sharing ------------------------------------------------------

  function clone(p) { return JSON.parse(JSON.stringify(p)); }

  // Fills the defaults and converts the old single-filter shape (onlyMode / onlyText).
  function normalize(p) {
    var q = clone(p || {});
    if (q.onlyText !== undefined) {
      if (String(q.onlyText || "").trim()) {
        q.only = { logic: "all", items: [{ mode: q.onlyMode || "contains", not: false, text: q.onlyText }] };
      }
      delete q.onlyMode; delete q.onlyText;
    }
    if (q.only) {
      if (!Array.isArray(q.only.items)) q.only.items = [];
      q.only.logic = q.only.logic === "any" ? "any" : "all";
      q.only.items = q.only.items.filter(function (i) { return i && COND_MODES.indexOf(i.mode) > -1; })
        .map(function (i) { return { mode: i.mode, not: !!i.not, text: String(i.text == null ? "" : i.text) }; });
    }
    var a = q.apply && typeof q.apply === "object" ? q.apply : { search: true, manual: false };
    q.apply = { search: !!a.search, manual: !!a.manual, title: !!a.title };
    q.on = q.on !== false;
    q.stop = !!q.stop;
    if (q.type === "text" && TEXT_MODES.indexOf(q.mode) < 0) q.mode = "exact";
    return q;
  }

  // Drops the blank conditions; removes `only` when none is left.
  function compact(p) {
    var q = clone(p);
    if (q.only) {
      q.only.items = condItems(q).filter(function (i) { return String(i.text || "").trim(); });
      if (!q.only.items.length) delete q.only;
    }
    return q;
  }

  // Text to copy: one pattern, or a list. No internal id; a single copy also drops `on`.
  function exportOne(p) {
    var q = compact(p); delete q.id; delete q.on;
    return JSON.stringify(q, null, 1);
  }
  function exportList(list) {
    return JSON.stringify((list || []).map(function (p) { var q = compact(p); delete q.id; return q; }), null, 1);
  }

  // Reads pasted text (one pattern or a list) -> { patterns, ignored, error }
  function parseImport(text) {
    var a;
    try { a = JSON.parse(text); }
    catch (e) { return { patterns: [], ignored: 0, error: "Could not read this text: " + e.message }; }
    if (a && typeof a === "object" && !Array.isArray(a)) a = [a];
    if (!Array.isArray(a)) return { patterns: [], ignored: 0, error: "The text must be one pattern or a list of patterns." };
    var ok = [], ignored = 0;
    a.forEach(function (p) {
      if (p && typeof p === "object" && TYPES.indexOf(p.type) > -1) { var q = normalize(p); delete q.id; ok.push(q); }
      else ignored++;
    });
    return { patterns: ok, ignored: ignored, error: "" };
  }

  // Ready-made patterns ("Start from" in the panel).
  var PRESETS = [
    { label: "Resolutions & codecs", make: function () { return { type: "words", name: "Resolutions & codecs", words: "1080p, 720p, 2160p, 4k, x264, x265, hevc, webrip" }; } },
    { label: "[Brackets]", make: function () { return { type: "text", name: "Remove [brackets]", mode: "between", a: "[", b: "]" }; } },
    { label: "(Parentheses)", make: function () { return { type: "text", name: "Remove (parentheses)", mode: "between", a: "(", b: ")" }; } },
    { label: "Dots & underscores", make: function () { return { type: "regex", name: "Dots and underscores to spaces", find: "[._]+", repl: " ", cs: false }; } },
    { label: 'Cut after " - "', make: function () { return { type: "text", name: 'Cut after " - "', mode: "after", a: " - " }; } },
    { label: "Trailing id", make: function () { return { type: "regex", name: "Trailing id", find: "_\\d{5,}$", repl: "", cs: false }; } }
  ];

  var api = {
    MAX_PATTERN: MAX_PATTERN, MAX_TEXT: MAX_TEXT, COND_S: COND_S, COND_MODES: COND_MODES, PRESETS: PRESETS,
    friendlyRegexError: friendlyRegexError, stripExt: stripExt, applies: applies, applyOf: applyOf,
    build: build, validate: validate, summary: summary,
    matchesOnly: matchesOnly, onlySentence: onlySentence, condError: condError,
    run: run, apply: apply,
    normalize: normalize, compact: compact, exportOne: exportOne, exportList: exportList, parseImport: parseImport
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.stNamePatterns = api;
})(typeof window !== "undefined" ? window : this);
