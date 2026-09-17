/**
 * sceneTagger.js v1.1 — Scene Tagger Plugin for Stash
 * Mass scraping panel for scenes.
 *
 * v1.1 — Fixes:
 *   - Details checked by default (only if content outside the "Artists:" line)
 *   - Multiple studios (an "Artists: a | b | c" line in details) shown as
 *     radio buttons: checking one unchecks the others
 */

(function () {
  "use strict";

  var STASH_GQL = "/graphql";
  var PANEL_ID  = "st-panel";
  var BTN_ID    = "st-toggle-btn";
  var REOPEN_FLAG = "st-reopen-after-reload";

  // ── GraphQL ────────────────────────────────────────────────────────────────

  function gql(opName, query, variables) {
    return fetch(STASH_GQL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationName: opName, query: query, variables: variables || {} })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.errors && d.errors.length) throw new Error(d.errors[0].message);
        return d.data;
      });
  }

  // ── Scrapers ───────────────────────────────────────────────────────────────

  function getSceneScrapers() {
    // scene.supported_scrapes tells us which YAML scrapers implement a
    // name/query-based search (SceneByName / ScrapeSingleSceneInput.query)
    // vs only FRAGMENT/URL - confirmed via introspection (session
    // 2026-09-16) that several community scrapers do (AniDB, JAVDatabase,
    // Pornhub, Rule34Video, Rule34VideoFromID on this instance). Used by
    // isSearchCapable() below to offer "Search title" beyond stash-box only.
    return gql("ListScrapers", "query ListScrapers{listScrapers(types:[SCENE]){id name scene{supported_scrapes}}}")
      .then(function (d) {
        return (d.listScrapers || []).map(function (s) {
          var supports = (s.scene && s.scene.supported_scrapes) || [];
          return { id: s.id, name: s.name, supportsName: supports.indexOf("NAME") !== -1 };
        });
      });
  }

  // Prefix used to distinguish a stash-box "scraper" (id = prefixed
  // endpoint) from a regular YAML scraper (id = raw scraper_id).
  var STASHBOX_PREFIX = "stashbox:";

  // A scraper can be used with "Search title" (query-based search) if it's
  // a stash-box (always query-capable) or a YAML scraper that declared NAME
  // support above - no longer stash-box only (session 2026-09-16).
  function isSearchCapable(s) {
    return s.id.indexOf(STASHBOX_PREFIX) === 0 || !!s.supportsName;
  }

  function getStashBoxes() {
    return gql("GetStashBoxes", "query GetStashBoxes{configuration{general{stashBoxes{name endpoint}}}}")
      .then(function (d) {
        var boxes = (d.configuration && d.configuration.general && d.configuration.general.stashBoxes) || [];
        return boxes.map(function (b) {
          return { id: STASHBOX_PREFIX + b.endpoint, name: (b.name || b.endpoint) + " (stash-box)" };
        });
      })
      .catch(function () { return []; });
  }

  // ── scrapeSingleScene ──────────────────────────────────────────────────────

  var Q_SCRAPE = "query ScrapeSingleScene($source:ScraperSourceInput!,$input:ScrapeSingleSceneInput!){scrapeSingleScene(source:$source,input:$input){title code date details director urls image studio{stored_id name image url}tags{stored_id name}performers{stored_id name disambiguation gender urls birthdate ethnicity country eye_color height measurements fake_tits penis_length circumcised career_start career_end tattoos piercings aliases images details death_date hair_color weight}}}";

  // Tried feeding a synthetic scene_input (title only) instead of scene_id
  // to re-scrape with a manually corrected title without touching the DB -
  // confirmed dead end: Stash rejects it for "script" action scrapers
  // ("scraper operation not supported"), regardless of which fields are
  // set, even with the exact title that scrapes fine natively once it's
  // the scene's real title. See updateSceneTitle() below for the approach
  // that actually works (matches native scrape behavior exactly).
  function scrapeSingleScene(scraperID, sceneID) {
    var source = scraperID.indexOf(STASHBOX_PREFIX) === 0
      ? { stash_box_endpoint: scraperID.slice(STASHBOX_PREFIX.length) }
      : { scraper_id: scraperID };
    return gql("ScrapeSingleScene", Q_SCRAPE, {
      source: source,
      input:  { scene_id: String(sceneID) }
    }).then(function (d) {
      var r = d.scrapeSingleScene;
      return Array.isArray(r) ? (r[0] || null) : r;
    });
  }

  // Search-by-title against a single stash-box: same Q_SCRAPE query as
  // scrapeSingleScene, but with input.query instead of input.scene_id -
  // returns the full candidate list (not just [0]) since the whole point
  // here is to let the user pick among several results. Confirmed via
  // introspection (session 2026-09-16) that this is the same mechanism
  // Stash's own "Scene Scrape Query" dialog (the magnifying-glass icon next
  // to "Scrape with...") uses - no separate query exists for this.
  function scrapeSingleSceneByQuery(scraperID, query) {
    var source = scraperID.indexOf(STASHBOX_PREFIX) === 0
      ? { stash_box_endpoint: scraperID.slice(STASHBOX_PREFIX.length) }
      : { scraper_id: scraperID };
    return gql("ScrapeSingleScene", Q_SCRAPE, {
      source: source,
      input:  { query: query }
    }).then(function (d) {
      var r = d.scrapeSingleScene;
      return Array.isArray(r) ? r : (r ? [r] : []);
    });
  }

  // Updates the scene's real title in Stash - used right before a manual-
  // title retry so the scrape (by scene_id, the only fragment-scrape path
  // that actually works for script scrapers) sees the corrected title,
  // exactly like a native re-scrape after fixing the filename/title by
  // hand. This IS a real DB write, done deliberately: the user is already
  // correcting the title with the intent of scraping/applying it.
  var Q_SCENE_UPDATE_TITLE = "mutation SceneUpdateTitle($id:ID!,$title:String!){sceneUpdate(input:{id:$id,title:$title}){id title}}";
  function updateSceneTitle(sceneID, title) {
    return gql("SceneUpdateTitle", Q_SCENE_UPDATE_TITLE, { id: String(sceneID), title: title })
      .then(function (d) { return d.sceneUpdate; });
  }

  // Scrape via the URL already saved on the scene, scraper-agnostic:
  // Stash automatically tries the one whose sceneByURL matches the domain.
  var Q_SCRAPE_URL = "query ScrapeSceneURL($url:String!){scrapeSceneURL(url:$url){title code date details director urls image studio{stored_id name image url}tags{stored_id name}performers{stored_id name disambiguation gender urls birthdate ethnicity country eye_color height measurements fake_tits penis_length circumcised career_start career_end tattoos piercings aliases images details death_date hair_color weight}}}";

  function scrapeSceneURL(url) {
    return gql("ScrapeSceneURL", Q_SCRAPE_URL, { url: url })
      .then(function (d) { return d.scrapeSceneURL; });
  }

  // A poorly written scraper can return {} (empty object, truthy in JS)
  // instead of null when it finds nothing - without this filter, the
  // fallback chain would stop there instead of trying the next scrapers.
  function isUsableScrapedResult(r) {
    if (!r) return false;
    return !!(r.title || r.details || (r.studio && r.studio.name) ||
      (r.tags && r.tags.length) || (r.performers && r.performers.length));
  }

  // Tries the enabled scrapers from pluginConfig.scraperChain in order,
  // stopping at the first usable result. Returns {scraped, scraperID, scraperName}
  // or {scraped:null} if they all failed.
  function scrapeWithFallback(sceneID) {
    var chain = (pluginConfig.scraperChain || []).filter(function (c) { return c.enabled; });
    function tryNext(i) {
      if (i >= chain.length) return Promise.resolve({ scraped: null });
      var entry = chain[i];
      return scrapeSingleScene(entry.id, sceneID)
        .then(function (result) {
          if (isUsableScrapedResult(result)) {
            var s = state.scrapers.filter(function (sc) { return sc.id === entry.id; })[0];
            return { scraped: result, scraperID: entry.id, scraperName: s ? s.name : entry.id };
          }
          return tryNext(i + 1);
        })
        .catch(function () { return tryNext(i + 1); });
    }
    return tryNext(0);
  }

  // Single entry point for scraping: tries the existing URL on the scene
  // first if the option is enabled, then respects the chosen mode (auto =
  // fallback chain, manual = a single scraper chosen via the header select).
  function scrapeOneEffective(sceneID) {
    var r = state.rows[sceneID];
    var scene = r ? r.scene : null;
    // Manually typed title (manual fill-in row, after a failed scrape):
    // write it as the scene's real title first, THEN re-scrape normally by
    // scene_id - the only way script scrapers actually pick up a corrected
    // title (see updateSceneTitle() above), matches native re-scrape
    // behavior exactly. Explicit user intent, takes priority over URL-based
    // lookups too.
    if (r && r.manualTitle) {
      return updateSceneTitle(sceneID, r.manualTitle).then(function () {
        if (r.scene) r.scene.title = r.manualTitle;
        return scrapeOneByMode(sceneID);
      });
    }
    // URL entered manually on the row: absolute priority, an explicit
    // user action for this specific scene.
    if (r && r.manualUrl) {
      return scrapeSceneURL(r.manualUrl).then(function (result) {
        if (isUsableScrapedResult(result)) {
          return { scraped: result, scraperID: "url", scraperName: "Entered URL" };
        }
        return scrapeOneByMode(sceneID);
      }).catch(function () { return scrapeOneByMode(sceneID); });
    }
    if (pluginConfig.useUrlIfPresent && scene && scene.urls && scene.urls.length) {
      return scrapeSceneURL(scene.urls[0]).then(function (result) {
        if (isUsableScrapedResult(result)) {
          return { scraped: result, scraperID: "url", scraperName: "Existing URL" };
        }
        return scrapeOneByMode(sceneID);
      }).catch(function () { return scrapeOneByMode(sceneID); });
    }
    return scrapeOneByMode(sceneID);
  }

  function scrapeOneByMode(sceneID) {
    if (pluginConfig.scraperMode === "manual") {
      if (!state.manualScraperID) return Promise.resolve({ scraped: null });
      return scrapeSingleScene(state.manualScraperID, sceneID).then(function (result) {
        if (!result) return { scraped: null };
        var s = state.scrapers.filter(function (sc) { return sc.id === state.manualScraperID; })[0];
        return { scraped: result, scraperID: state.manualScraperID, scraperName: s ? s.name : state.manualScraperID };
      });
    }
    return scrapeWithFallback(sceneID);
  }

  // ── Scenes on the active page: read from the native DOM (the grid
  // already rendered by Stash) rather than reconstructed by guessing the
  // active filter/page. Reliable by construction (we read what IS
  // displayed, we don't guess anything) - unlike the old approach, which
  // intercepted Stash's native FindScenes request and suffered from timing
  // races that were impossible to fully eliminate (see history of attempts).
  // ────────────────────────────────────────────────────────────────────────

  var Q_FIND_BY_IDS = "query FindScenesByIds($ids:[ID!]){findScenes(ids:$ids){count scenes{id title urls date code details director organized paths{screenshot preview stream}files{path basename duration}studio{id name image_path}performers{id name image_path}tags{id name}}}}";

  // IDs of the scenes visible in the native grid, in display order.
  function getVisibleSceneIdsInOrder() {
    var ids = [];
    document.querySelectorAll(".scene-card").forEach(function (card) {
      var a = card.querySelector("a.scene-card-link, a[href*='/scenes/']");
      if (!a) return;
      var m = (a.getAttribute("href") || "").match(/\/scenes\/(\d+)/);
      if (m && ids.indexOf(m[1]) === -1) ids.push(m[1]);
    });
    return ids;
  }

  // Waits for the native grid to have at least one card (it may not be
  // rendered yet right after a navigation).
  function waitForSceneCards(maxWaitMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function check() {
        var ids = getVisibleSceneIdsInOrder();
        if (ids.length) { resolve(ids); return; }
        if (Date.now() - start >= maxWaitMs) { resolve(ids); return; }
        setTimeout(check, 150);
      })();
    });
  }

  // Page number / total pages: read from the text of the native pagination
  // widget ("2 of 524"), not recomputed - the source of truth for pagination
  // stays the actual display, same logic as for the IDs.
  function getPageInfoFromDOM() {
    var els = document.querySelectorAll("button, span");
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || "").trim();
      var m = t.match(/^(\d+)\s+of\s+(\d+)$/i);
      if (m) return { page: parseInt(m[1], 10), total: parseInt(m[2], 10) };
    }
    return null;
  }

  // ── Parse "Artists: a | b | c" from details ───────────────────────────────
  //
  // rule34-python writes into details:
  //   "Artists: artist1 | artist2 | artist3"   (if multiple artists)
  // optionally followed by other lines (translation notes, etc.)
  //
  // Returns:
  //   { artists: ["a","b","c"], rest: "other lines or null" }

  function parseDetailsArtists(details) {
    if (!details) return { artists: [], rest: null };
    var lines = details.split("\n");
    var artists = [];
    var otherLines = [];
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^Artists:\s*(.+)$/);
      if (m) {
        var parts = m[1].split("|").map(function(s) { return s.trim(); }).filter(Boolean);
        artists = parts.map(function(part) {
          var mm = part.match(/^(.+?)\[(\w+)\]$/);
          if (mm) return { name: mm[1].trim(), stored_id: mm[2] };
          return { name: part, stored_id: null };
        });
      } else {
        otherLines.push(lines[i]);
      }
    }
    var rest = otherLines.join("\n").trim() || null;
    return { artists: artists, rest: rest };
  }

  // ── Resolve/create entities ────────────────────────────────────────────────

  var Q_FS       = "query FS($n:String!){findStudios(studio_filter:{name:{value:$n,modifier:EQUALS}},filter:{per_page:1}){studios{id}}}";
  var Q_FS_EXACT = "query FSE($n:String!){findStudios(studio_filter:{name:{value:$n,modifier:EQUALS}},filter:{per_page:1}){studios{id name}}}";
  var Q_FS_ALIAS = "query FSA($n:String!){findStudios(studio_filter:{aliases:{value:$n,modifier:EQUALS}},filter:{per_page:5}){studios{id name aliases}}}";
  var Q_FS_SEARCH = "query FSS($n:String!){findStudios(studio_filter:{name:{value:$n,modifier:INCLUDES}},filter:{per_page:8}){studios{id name}}}";
  var M_CS = "mutation CS($n:String!,$image:String,$url:String){studioCreate(input:{name:$n,image:$image,url:$url}){id}}";
  var Q_FP        = "query FP($n:String!){findPerformers(performer_filter:{name:{value:$n,modifier:EQUALS}},filter:{per_page:1}){performers{id}}}";
  var Q_FP_SEARCH       = "query FPS($n:String!){findPerformers(performer_filter:{name:{value:$n,modifier:INCLUDES}},filter:{per_page:10}){performers{id name image_path}}}";
  var Q_FP_SEARCH_ALIAS = "query FPSA($n:String!){findPerformers(performer_filter:{aliases:{value:$n,modifier:INCLUDES}},filter:{per_page:10}){performers{id name image_path}}}";
  var Q_FP_IMAGE        = "query FPImg($id:ID!){findPerformer(id:$id){id image_path}}";
  var Q_STUDIO_IMAGE    = "query StudioImg($id:ID!){findStudio(id:$id){id image_path}}";
  var Q_FTAG_SEARCH     = "query FTagS($n:String!){findTags(tag_filter:{name:{value:$n,modifier:INCLUDES}},filter:{per_page:10}){tags{id name}}}";
  var M_CP = "mutation CP($n:String!,$disambiguation:String,$urls:[String!],$gender:GenderEnum,$birthdate:String,$ethnicity:String,$country:String,$eye_color:String,$height_cm:Int,$measurements:String,$fake_tits:String,$penis_length:Float,$circumcised:CircumcisedEnum,$career_start:String,$career_end:String,$tattoos:String,$piercings:String,$alias_list:[String!],$image:String,$details:String,$death_date:String,$hair_color:String,$weight:Int){performerCreate(input:{name:$n,disambiguation:$disambiguation,urls:$urls,gender:$gender,birthdate:$birthdate,ethnicity:$ethnicity,country:$country,eye_color:$eye_color,height_cm:$height_cm,measurements:$measurements,fake_tits:$fake_tits,penis_length:$penis_length,circumcised:$circumcised,career_start:$career_start,career_end:$career_end,tattoos:$tattoos,piercings:$piercings,alias_list:$alias_list,image:$image,details:$details,death_date:$death_date,hair_color:$hair_color,weight:$weight}){id}}";
  var Q_FT = "query FT($n:String!){findTags(tag_filter:{name:{value:$n,modifier:EQUALS}},filter:{per_page:1}){tags{id}}}";
  var M_CT = "mutation CT($n:String!){tagCreate(input:{name:$n}){id}}";
  var M_SU = "mutation SceneUpdate($input:SceneUpdateInput!){sceneUpdate(input:$input){id title}}";

  // ── Other studios (compatible with the skExtra-Multiple-Studios-Custom plugin) ──
  // Same custom_fields convention, written directly in GraphQL here: no JS
  // dependency between the plugins, only an agreement on field names.
  var CF_OTHER       = "skExtra_MS_Other";
  var CF_BACK_SCENE  = "skExtra_MS_Other_Scenes";
  var Q_SCENE_CF  = "query SceneCF($id:ID!){findScene(id:$id){custom_fields}}";
  var Q_STUDIO_CF = "query StudioCF($id:ID!){findStudio(id:$id){custom_fields}}";
  var M_SCENE_CF_UPDATE  = "mutation SceneCFUpdate($input:SceneUpdateInput!){sceneUpdate(input:$input){id}}";
  var M_STUDIO_CF_UPDATE = "mutation StudioCFUpdate($input:StudioUpdateInput!){studioUpdate(input:$input){id}}";

  function mergePipeList(current, idsToAdd) {
    var ids = (current || "").split("|").filter(Boolean);
    idsToAdd.forEach(function (id) {
      id = String(id);
      if (ids.indexOf(id) === -1) ids.push(id);
    });
    return ids.length ? ids.join("|") + "|" : "";
  }

  // Links a scene to a list of "secondary" studios (other than the main
  // studio) via the same custom_fields as skExtra-Multiple-Studios-Custom.
  // Updates both directions: the field on the scene AND the back-reference
  // field on each studio, so the MS Custom plugin displays/edits these links.
  function linkOtherStudios(sceneID, studioIds) {
    if (!studioIds || !studioIds.length) return Promise.resolve();
    sceneID = String(sceneID);

    return gql("SceneCF", Q_SCENE_CF, { id: sceneID }).then(function (d) {
      var current = d.findScene && d.findScene.custom_fields ? d.findScene.custom_fields[CF_OTHER] : "";
      var newSceneField = mergePipeList(current, studioIds);

      var scenePromise = gql("SceneCFUpdate", M_SCENE_CF_UPDATE, {
        input: { id: sceneID, custom_fields: { partial: (function () { var o = {}; o[CF_OTHER] = newSceneField; return o; })() } }
      });

      var studioPromises = studioIds.map(function (studioId) {
        studioId = String(studioId);
        return gql("StudioCF", Q_STUDIO_CF, { id: studioId }).then(function (d2) {
          var currentBack = d2.findStudio && d2.findStudio.custom_fields ? d2.findStudio.custom_fields[CF_BACK_SCENE] : "";
          var ids = (currentBack || "").split("|").filter(Boolean);
          if (ids.indexOf(sceneID) === -1) {
            ids.push(sceneID);
            var newBack = ids.length ? ids.join("|") + "|" : "";
            return gql("StudioCFUpdate", M_STUDIO_CF_UPDATE, {
              input: { id: studioId, custom_fields: { partial: (function () { var o = {}; o[CF_BACK_SCENE] = newBack; return o; })() } }
            });
          }
        });
      });

      return Promise.all([scenePromise].concat(studioPromises));
    });
  }

  function resolveOrCreate(fq, fo, fk, sk, cm, co, ck, name) {
    return gql(fo, fq, { n: name }).then(function (d) {
      var lst = (d[fk] || {})[sk] || [];
      if (lst.length) return lst[0].id;
      return gql(co, cm, { n: name }).then(function (d2) { return d2[ck].id; });
    });
  }

  // Global cache (shared across all rows/scenes) name→id used only for the
  // "new" badge shown on screen. Kept separate from the resolution done on
  // Apply click (resolveStudio) - that one remains the source of truth for
  // actual creation/linking, this cache only fixes the display. Two distinct
  // false-"new" cases it corrects:
  // 1. A candidate detected as new because of a missing [id] in Details, or
  //    because it exists only under an alias, not the primary name.
  // 2. A candidate whose SCRAPER simply never set stored_id at all - many
  //    community script scrapers (unlike rule34-python) don't do their own
  //    studio-id lookup, so even an exact primary-name match still comes
  //    back flagged "new" from Stash's own scrape response. This is why an
  //    exact-name check has to run here too, not just an alias check.
  // undefined = never checked, null = checked and not found, otherwise = id.
  var studioAliasBadgeCache = {};

  function getCachedStudioAliasId(name) {
    if (!name) return null;
    return studioAliasBadgeCache[name.toLowerCase()];
  }

  // Checks in the background, for a list of "new" candidate names not yet
  // cached, whether they actually match an existing studio - exact name
  // first, then alias - and updates the cache. Makes no call for a name
  // already checked (cache hit, found or not), to limit network cost on a
  // bulk scrape.
  function checkStudioAliasBadges(names) {
    var toCheck = [];
    var seen = {};
    (names || []).forEach(function (n) {
      if (!n) return;
      var key = n.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      if (studioAliasBadgeCache[key] === undefined) toCheck.push(n);
    });
    if (!toCheck.length) return Promise.resolve(false);
    return Promise.all(toCheck.map(function (n) {
      return gql("FS", Q_FS, { n: n }).then(function (d) {
        var exact = (d.findStudios || {}).studios || [];
        if (exact.length) {
          studioAliasBadgeCache[n.toLowerCase()] = exact[0].id;
          return true;
        }
        return gql("FSA", Q_FS_ALIAS, { n: n }).then(function (d2) {
          var studios = (d2.findStudios || {}).studios || [];
          var match = null;
          for (var i = 0; i < studios.length; i++) {
            var aliases = studios[i].aliases || [];
            for (var j = 0; j < aliases.length; j++) {
              if (aliases[j].toLowerCase() === n.toLowerCase()) { match = studios[i].id; break; }
            }
            if (match) break;
          }
          studioAliasBadgeCache[n.toLowerCase()] = match;
          return match !== null;
        });
      }).catch(function () {
        studioAliasBadgeCache[n.toLowerCase()] = null;
        return false;
      });
    })).then(function (results) {
      return results.some(Boolean);
    });
  }

  // resolveStudio first searches by exact name, then by alias, then creates.
  // Accepts either a name (string) or the full scraped studio object
  // ({name, image, url}) so the logo/URL are carried over on creation.
  function resolveStudio(studioOrName) {
    var studio = typeof studioOrName === "string" ? { name: studioOrName } : (studioOrName || {});
    var name = studio.name;
    return gql("FS", Q_FS, { n: name }).then(function (d) {
      var lst = (d.findStudios || {}).studios || [];
      if (lst.length) return lst[0].id;
      // Not found by name → search by alias
      return gql("FSA", Q_FS_ALIAS, { n: name }).then(function (d2) {
        var studios = (d2.findStudios || {}).studios || [];
        // Double-check the alias matches exactly (defensive, EQUALS should
        // already guarantee it server-side)
        for (var i = 0; i < studios.length; i++) {
          var s = studios[i];
          var aliases = s.aliases || [];
          for (var j = 0; j < aliases.length; j++) {
            if (aliases[j].toLowerCase() === name.toLowerCase()) return s.id;
          }
        }
        // Still not found → create it (with logo/URL if scraped)
        return gql("CS", M_CS, { n: name, image: studio.image || null, url: studio.url || null })
          .then(function (d3) { return d3.studioCreate.id; });
      });
    });
  }

  // resolvePerformer searches by exact name, then creates it carrying over
  // all the scraped fields (image, urls, birthdate, measurements...) if
  // available - accepts either a name (string) or the full scraped performer object.
  function resolvePerformer(performerOrName) {
    var p = typeof performerOrName === "string" ? { name: performerOrName } : (performerOrName || {});
    var name = p.name;
    return gql("FP", Q_FP, { n: name }).then(function (d) {
      var lst = (d.findPerformers || {}).performers || [];
      if (lst.length) return lst[0].id;
      var toInt = function (v) { var n = parseInt(v, 10); return isNaN(n) ? null : n; };
      var toFloat = function (v) { var n = parseFloat(v); return isNaN(n) ? null : n; };
      var vars = {
        n: name,
        disambiguation: p.disambiguation || null,
        urls: (p.urls && p.urls.length) ? p.urls : null,
        gender: p.gender || null,
        birthdate: p.birthdate || null,
        ethnicity: p.ethnicity || null,
        country: p.country || null,
        eye_color: p.eye_color || null,
        height_cm: p.height ? toInt(p.height) : null,
        measurements: p.measurements || null,
        fake_tits: p.fake_tits || null,
        penis_length: p.penis_length ? toFloat(p.penis_length) : null,
        circumcised: p.circumcised || null,
        career_start: p.career_start || null,
        career_end: p.career_end || null,
        tattoos: p.tattoos || null,
        piercings: p.piercings || null,
        alias_list: p.aliases ? p.aliases.split(",").map(function (s) { return s.trim(); }).filter(Boolean) : null,
        image: (p.images && p.images.length) ? p.images[0] : null,
        details: p.details || null,
        death_date: p.death_date || null,
        hair_color: p.hair_color || null,
        weight: p.weight ? toInt(p.weight) : null
      };
      return gql("CP", M_CP, vars).then(function (d2) { return d2.performerCreate.id; });
    });
  }
  function resolveTag(name)       { return resolveOrCreate(Q_FT,"FT","findTags","tags",M_CT,"CT","tagCreate",name); }

  function applyScrapedData(sceneID, scraped) {
    // scraped.studio may have been replaced by an artist chosen via radio
    var p_studio = scraped.studio && scraped.studio.name
      ? (scraped.studio.stored_id ? Promise.resolve(scraped.studio.stored_id) : resolveStudio(scraped.studio))
      : Promise.resolve(null);

    var p_perfs = Promise.all((scraped.performers || []).map(function (p) {
      if (!p || !p.name) return Promise.resolve(null);
      return p.stored_id ? Promise.resolve(p.stored_id) : resolvePerformer(p);
    }));

    var p_tags = Promise.all((scraped.tags || []).map(function (t) {
      if (!t || !t.name) return Promise.resolve(null);
      return t.stored_id ? Promise.resolve(t.stored_id) : resolveTag(t.name);
    }));

    // "Candidate" studios (Artists: line) not chosen as the main studio.
    // Only computed/resolved if the option is enabled (avoids extra work and
    // unnecessary studio creation when the feature is disabled).
    var p_otherStudios = pluginConfig.autoAddOtherStudios && scraped.otherStudioNames && scraped.otherStudioNames.length
      ? Promise.all(scraped.otherStudioNames.map(function (name) { return resolveStudio(name); }))
      : Promise.resolve([]);

    return Promise.all([p_studio, p_perfs, p_tags, p_otherStudios]).then(function (res) {
      var inp = { id: String(sceneID) };
      if (scraped.title)    inp.title    = scraped.title;
      if (scraped.date)     inp.date     = scraped.date;
      if (scraped.code)     inp.code     = scraped.code;
      if (scraped.details)  inp.details  = scraped.details;
      if (scraped.director) inp.director = scraped.director;
      if (scraped.urls && scraped.urls.length) inp.urls = scraped.urls;
      if (scraped.image)    inp.cover_image = scraped.image;
      if (res[0])           inp.studio_id      = res[0];
      var pids = res[1].filter(Boolean);
      var tids = res[2].filter(Boolean);
      if (pids.length) inp.performer_ids = pids;
      if (tids.length) inp.tag_ids       = tids;
      if (state.rows[sceneID].markOrganized) inp.organized = true;
      var otherStudioIds = res[3].filter(Boolean);

      return gql("SceneUpdate", M_SU, { input: inp }).then(function (updateResult) {
        if (!otherStudioIds.length) return updateResult;
        // Non-blocking failure: the main scene is already saved, we don't
        // want the whole "apply" to fail over an issue with the secondary
        // link (the chosen studio and other fields remain applied).
        return linkOtherStudios(sceneID, otherStudioIds)
          .catch(function (e) { console.error("[sceneTagger] linkOtherStudios:", e); })
          .then(function () { return updateResult; });
      });
    });
  }

  // ── Plugin configuration ───────────────────────────────────────────────────

  var Q_GET_CONFIG = "query GetPluginConfig { configuration { plugins } }";
  var M_SET_CONFIG = "mutation SetPluginConfig($input: Map!) { configurePlugin(plugin_id: \"sceneTagger\", input: $input) }";

  var pluginConfig = {
    autoCheckStudio:         false,
    autoCheckPerformer:      false,
    autoCheckNewTags:        false,
    autoCheckDetails:        false,
    prioritizeExistingStudio: true,   // pre-select the studio already in the DB
    studioBlacklist:         [],      // lowercase names
    // Automatically adds "Artists:" candidates not chosen as the main studio
    // to "Other studios" (compatible with skExtra-Multiple-Studios-Custom)
    autoAddOtherStudios:     false,
    // Scraper fallback chain: [{id, enabled}, ...] in priority order.
    // Reconciled with the real scraper list on every load (see
    // reconcileScraperChain) - never empty once the scrapers are loaded.
    scraperChain:            [],
    // If enabled, scenes are marked as organized by default when Applied
    // (overridable per scene via the "Organized" row button).
    autoMarkOrganized: false,
    // "auto" = fallback chain (scraperChain), "manual" = a single scraper
    // chosen via the header select (old behavior, kept for cases where
    // auto-fallback isn't wanted).
    scraperMode:             "auto",
    // If enabled, tries scrapeSceneURL() on the 1st URL already saved on
    // the scene before the chain/manual mode (scraper-agnostic).
    useUrlIfPresent:         false,
    // false (default) = current behavior: full-width panel anchored below
    // the toolbar. true = floating compact panel (like imageTagger's default
    // state), via the .st-compact CSS class on #st-panel.
    compactMode:             false,
    // If enabled, a failed scrape shows the usual panel (empty) to fill in
    // studio/performers/tags/details by hand instead of a plain error
    // message.
    manualFallbackOnFail:      false,
    // Sub-option (only has an effect if manualFallbackOnFail is enabled):
    // adds a text field to type the title by hand.
    manualFallbackAllowTitle:  false,
    // If enabled, hovering a thumbnail streams the source video directly
    // (scene.paths.stream, seeked to 10% in) - fully self-contained, no
    // generated preview clip and no companion plugin (videoHoverPreview)
    // required or hooked into.
    nativeHoverPreview:        false,
    // If enabled, scrolling the mouse wheel over a hovered thumbnail seeks
    // through the preview instead of just letting it loop. Split in two so
    // the mass scrape panel and the single-scene "Scrape Scene" popup can
    // be toggled independently (e.g. wanted while mass-tagging but not
    // while quickly re-scraping a single scene, or vice versa).
    enableScrubControlsGrid:   false,
    enableScrubControlsSolo:   false,
    // Scrub step sizes, as a percentage of the video's total duration
    // (not a fixed number of seconds) - keeps the step proportional whether
    // the scene is 15 seconds or 20 minutes long.
    scrubStepSlow:             1,
    scrubStepNormal:           3,
    scrubStepFast:             6,
    // Max multiplier applied to the step when scrolling continuously in the
    // same direction (resets on direction change or after a short pause).
    scrubMaxVelocityMultiplier: 3,
    // Thin clickable/draggable progress bar at the bottom of the thumbnail.
    scrubBarVisible:           false,
    // Left/right arrow keys seek while a thumbnail is hovered.
    enableKeyboardSeek:        false,
    keyboardSeekStep:          5,
    // If enabled, hides the Auto/Manual scraper-mode toggle (and manual
    // scraper picker) on the single-scene panel (st-panel-solo) - some
    // users never touch it there and prefer the extra vertical space.
    hideSceneModeToggle:       false,
    // If enabled, the "ST" badge button in the scene-page toolbar (next to
    // the favourite/heart button, see injectToolbarButton()) is not shown.
    hideToolbarButton:         false,
    // If enabled, the "sceneTagger" button injected next to "Scrape
    // with..." on the scene Edit tab (see injectSceneButton()) is not shown.
    hideEditButton:            false
  };

  function loadPluginConfig() {
    return gql("GetPluginConfig", Q_GET_CONFIG)
      .then(function (d) {
        var plugins = d.configuration && d.configuration.plugins;
        if (plugins && plugins.sceneTagger) {
          var cfg = plugins.sceneTagger;
          if (cfg.autoCheckStudio    !== undefined) pluginConfig.autoCheckStudio    = !!cfg.autoCheckStudio;
          if (cfg.autoCheckPerformer !== undefined) pluginConfig.autoCheckPerformer = !!cfg.autoCheckPerformer;
          if (cfg.autoCheckNewTags   !== undefined) pluginConfig.autoCheckNewTags   = !!cfg.autoCheckNewTags;
          if (cfg.autoCheckDetails   !== undefined) pluginConfig.autoCheckDetails   = !!cfg.autoCheckDetails;
          if (cfg.prioritizeExistingStudio !== undefined) pluginConfig.prioritizeExistingStudio = !!cfg.prioritizeExistingStudio;
          if (cfg.autoAddOtherStudios !== undefined) pluginConfig.autoAddOtherStudios = !!cfg.autoAddOtherStudios;
          if (cfg.scraperMode === "auto" || cfg.scraperMode === "manual") pluginConfig.scraperMode = cfg.scraperMode;
          if (cfg.useUrlIfPresent !== undefined) pluginConfig.useUrlIfPresent = !!cfg.useUrlIfPresent;
          if (cfg.compactMode     !== undefined) pluginConfig.compactMode     = !!cfg.compactMode;
          if (cfg.manualFallbackOnFail     !== undefined) pluginConfig.manualFallbackOnFail     = !!cfg.manualFallbackOnFail;
          if (cfg.manualFallbackAllowTitle !== undefined) pluginConfig.manualFallbackAllowTitle = !!cfg.manualFallbackAllowTitle;
          if (cfg.nativeHoverPreview !== undefined) pluginConfig.nativeHoverPreview = !!cfg.nativeHoverPreview;
          if (cfg.enableScrubControlsGrid !== undefined) pluginConfig.enableScrubControlsGrid = !!cfg.enableScrubControlsGrid;
          if (cfg.enableScrubControlsSolo !== undefined) pluginConfig.enableScrubControlsSolo = !!cfg.enableScrubControlsSolo;
          if (typeof cfg.scrubStepSlow === "number") pluginConfig.scrubStepSlow = cfg.scrubStepSlow;
          if (typeof cfg.scrubStepNormal === "number") pluginConfig.scrubStepNormal = cfg.scrubStepNormal;
          if (typeof cfg.scrubStepFast === "number") pluginConfig.scrubStepFast = cfg.scrubStepFast;
          if (typeof cfg.scrubMaxVelocityMultiplier === "number") pluginConfig.scrubMaxVelocityMultiplier = cfg.scrubMaxVelocityMultiplier;
          if (cfg.scrubBarVisible !== undefined) pluginConfig.scrubBarVisible = !!cfg.scrubBarVisible;
          if (cfg.enableKeyboardSeek !== undefined) pluginConfig.enableKeyboardSeek = !!cfg.enableKeyboardSeek;
          if (typeof cfg.keyboardSeekStep === "number") pluginConfig.keyboardSeekStep = cfg.keyboardSeekStep;
          if (cfg.autoMarkOrganized  !== undefined) pluginConfig.autoMarkOrganized  = !!cfg.autoMarkOrganized;
          if (cfg.hideSceneModeToggle !== undefined) pluginConfig.hideSceneModeToggle = !!cfg.hideSceneModeToggle;
          if (cfg.hideToolbarButton !== undefined) pluginConfig.hideToolbarButton = !!cfg.hideToolbarButton;
          if (cfg.hideEditButton !== undefined) pluginConfig.hideEditButton = !!cfg.hideEditButton;
          if (cfg.scraperChain !== undefined) {
            try {
              var parsed = typeof cfg.scraperChain === "string" ? JSON.parse(cfg.scraperChain) : cfg.scraperChain;
              if (Array.isArray(parsed)) pluginConfig.scraperChain = parsed;
            } catch (e) {}
          }
          if (cfg.studioBlacklist !== undefined) {
            // Stored as a CSV string in Stash, converted to an array in memory
            var raw = typeof cfg.studioBlacklist === "string" ? cfg.studioBlacklist : (Array.isArray(cfg.studioBlacklist) ? cfg.studioBlacklist.join(",") : "");
            pluginConfig.studioBlacklist = raw ? raw.split(",").map(function(s){ return s.trim().toLowerCase(); }).filter(Boolean) : [];
          }
        }
      })
      .catch(function () {});
  }

  function savePluginConfig() {
    // Convert the blacklist array to a CSV string, the scraper chain to JSON
    var toSave = Object.assign({}, pluginConfig, {
      studioBlacklist: pluginConfig.studioBlacklist.join(", "),
      scraperChain:    JSON.stringify(pluginConfig.scraperChain)
    });
    return gql("SetPluginConfig", M_SET_CONFIG, { input: toSave })
      .catch(function () {});
  }

  // Independent safety net from config.yml: writes the studio blacklist to
  // a local JSON file (studioBlacklist_backup.json, see blacklistBackup.py)
  // via a plugin task. Non-blocking, called only after a studioBlacklist
  // change (not on every savePluginConfig()).
  var M_RUN_BLACKLIST_BACKUP = 'mutation RunBlacklistBackup { runPluginTask(plugin_id: "sceneTagger", task_name: "Backup studio blacklist") }';
  function backupBlacklist() {
    gql("RunBlacklistBackup", M_RUN_BLACKLIST_BACKUP)
      .catch(function (e) { console.error("[sceneTagger] blacklist backup failed:", e); });
  }

  function isBlacklisted(name) {
    if (!name) return false;
    return pluginConfig.studioBlacklist.indexOf(name.toLowerCase()) !== -1;
  }

  // Merges pluginConfig.scraperChain with the real list of available
  // scrapers: keeps the existing order/checked state for known ones, adds
  // new ones at the end (enabled by default), removes ones that no longer exist.
  function reconcileScraperChain() {
    var known = {};
    pluginConfig.scraperChain.forEach(function (c) { known[c.id] = c; });
    var reconciled = [];
    pluginConfig.scraperChain.forEach(function (c) {
      if (state.scrapers.some(function (s) { return s.id === c.id; })) reconciled.push(c);
    });
    state.scrapers.forEach(function (s) {
      if (!known[s.id]) reconciled.push({ id: s.id, enabled: true });
    });
    pluginConfig.scraperChain = reconciled;
  }

  // ── State ──────────────────────────────────────────────────────────────────

  var state = {
    scenes:      [],
    rows:        {},
    running:     false,
    visible:     false,
    scrapers:    [],
    manualScraperID: "",   // scraper chosen in manual mode
    studioFilter: "all",  // "all" | "new" | "existing"
    multiStudioOnly: false,  // when true, cumulative AND with studioFilter: only rows with >=2 studio candidates
    scraperFilter: "all", // "all" | a scraperID (only scrapers with >=1 result are listed)
    currentPage: 1,
    totalPages:  1
  };

  // ── Page navigation (changes ?p= in the URL, makes the whole Stash SPA
  // navigate like a real click on the native pagination, keeps everything
  // in sync). The parameter is called "p" (not "page") - verified
  // empirically by clicking the real native button and observing the
  // resulting URL.
  function goToPage(newPage) {
    newPage = Math.min(Math.max(newPage, 1), state.totalPages || 1);
    if (newPage === state.currentPage) return;
    var p = new URLSearchParams(window.location.search);
    p.set("p", String(newPage));
    var href = window.location.pathname + "?" + p.toString();
    window.history.pushState(null, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function getFilename(scene) {
    if (scene.files && scene.files.length) return scene.files[0].basename || scene.files[0].path || scene.id;
    return scene.title || String(scene.id);
  }

  function getThumb(scene) {
    return scene.paths && scene.paths.screenshot ? scene.paths.screenshot : "";
  }

  function getSceneDuration(scene) {
    return scene.files && scene.files.length && scene.files[0].duration ? scene.files[0].duration : 0;
  }

  function getR34ID(scene) {
    if (scene.urls) {
      for (var i = 0; i < scene.urls.length; i++) {
        var m = scene.urls[i].match(/[?&]id=(\d+)/);
        if (m) return m[1];
        var mv = scene.urls[i].match(/rule34video\.com.*?\/(\d+)/);
        if (mv) return mv[1];
      }
    }
    var f = scene.files && scene.files.length ? (scene.files[0].basename || scene.files[0].path || "") : "";
    var m2 = f.match(/rule34[_\-]?(?:video[_\-])?(\d+)/i);
    return m2 ? m2[1] : null;
  }

  function getR34URL(scene) {
    if (scene.urls) {
      for (var i = 0; i < scene.urls.length; i++) {
        if (scene.urls[i].indexOf("rule34video") !== -1) return scene.urls[i];
        if (scene.urls[i].indexOf("rule34.xxx") !== -1)  return scene.urls[i];
      }
    }
    var rid = getR34ID(scene);
    if (!rid) return null;
    var f = scene.files && scene.files.length ? (scene.files[0].basename || "") : "";
    if (/rule34video/i.test(f)) return "https://rule34video.com/videos/" + rid + "/";
    return "https://rule34.xxx/index.php?page=post&s=view&id=" + rid;
  }

  // ── Read the checked checkboxes ────────────────────────────────────────────

  function getCheckedScraped(id) {
    var r = state.rows[id];
    if (!r || !r.scraped) return null;
    var scraped = r.scraped;
    var filtered = {};

    var row = document.getElementById("st-row-" + id);
    if (!row) return scraped;

    var cb = function (sel) { var el = row.querySelector(sel); return el ? el.checked : false; };

    if (cb('[data-cb="title"]')      && scraped.title)      filtered.title     = scraped.title;
    // Manually typed title (manualFallbackOnFail + manualFallbackAllowTitle mode)
    if (r.manualFallback && pluginConfig.manualFallbackAllowTitle) {
      var manualTitleEl = row.querySelector(".st-manual-title-input");
      var manualTitleVal = manualTitleEl ? manualTitleEl.value.trim() : (r.manualTitle || "");
      if (manualTitleVal) filtered.title = manualTitleVal;
    }
    // Date: solo mode has the custom calendar widget (see renderRow() /
    // buildDateFieldHTML()) - its value lives in row state, not a form
    // element. The mass list keeps the plain checkbox over the raw
    // scraped value.
    if (row.querySelector(".st-date-field")) {
      if (r.dateEditValue) filtered.date = r.dateEditValue;
    } else if (cb('[data-cb="date"]') && scraped.date) {
      filtered.date = scraped.date;
    }
    if (cb('[data-cb="code"]')       && scraped.code)        filtered.code      = scraped.code;
    if (cb('[data-cb="director"]')   && scraped.director)    filtered.director  = scraped.director;
    // Performers: checked scraped ones + manual additions
    var selectedPerfs = [];
    var perfCbs = row.querySelectorAll('[data-cb="performer"]');
    perfCbs.forEach(function (el) {
      if (el.checked) {
        var idx = parseInt(el.getAttribute("data-idx"), 10);
        if (scraped.performers && scraped.performers[idx]) selectedPerfs.push(scraped.performers[idx]);
      }
    });
    // Performers added manually via the search bar
    var addedPerfs = row.querySelectorAll('[data-cb="performer-added"]');
    addedPerfs.forEach(function (el) {
      selectedPerfs.push({ stored_id: el.getAttribute("data-perf-id") || null, name: el.getAttribute("data-perf-name") });
    });
    if (selectedPerfs.length) filtered.performers = selectedPerfs;
    // URLs: solo mode has the combined editable stack (see renderRow()) -
    // whatever's left in it (existing + new + manually added, minus
    // anything removed) is what gets applied. Mass list keeps the plain
    // checkbox over the raw scraped array.
    if (r.urlEditList && r.urlEditList.length) {
      filtered.urls = r.urlEditList.map(function (u) { return u.value; });
    } else if (cb('[data-cb="urls"]') && scraped.urls) {
      filtered.urls = scraped.urls;
    }
    // Cover: solo mode picks between existing/scraped by click (see
    // renderRow()) - "existing" means don't touch the current cover.
    if (row.querySelector(".st-cover-options")) {
      if (r.coverChoice === "scraped" && scraped.image) filtered.image = scraped.image;
    } else if (cb('[data-cb="cover"]') && scraped.image) {
      filtered.image = scraped.image;
    }

    // Details: solo mode has an always-editable textarea (see renderRow())
    // read directly so in-progress edits are picked up even without a
    // blur; the mass list keeps the plain checkbox over the raw scraped
    // value.
    var detailsEditEl = row.querySelector(".st-details-edit");
    if (detailsEditEl) {
      filtered.details = detailsEditEl.value;
    } else {
      var detailsCb = row.querySelector('[data-cb="details"]');
      if (detailsCb && detailsCb.checked && scraped.details) {
        filtered.details = scraped.details.replace(/\[(\w+)\]/g, "");
      }
    }

    // Studio: priority to the studio override (manual search)
    var overrideEl = row.querySelector('[data-cb="studio-override"]');
    if (overrideEl && overrideEl.value) {
      filtered.studio = { stored_id: overrideEl.getAttribute("data-studio-id"), name: overrideEl.value };
    } else {
      var studioRadios = row.querySelectorAll('[data-cb="studio-radio"]');
      if (studioRadios.length) {
        var chosenArtist = null;
        studioRadios.forEach(function (radio) {
          if (radio.checked) chosenArtist = radio.getAttribute("data-artist");
        });
        if (chosenArtist) filtered.studio = { name: chosenArtist };
      } else {
        // Simple studio checkbox — get the name from the chip (soloArtist can differ from scraped.studio.name)
        var studioCb = row.querySelector('[data-cb="studio"]');
        if (studioCb && studioCb.checked) {
          var studioChipText = row.querySelector('.st-chip-studio .st-selectable');
          var studioName = studioChipText ? studioChipText.textContent : (scraped.studio ? scraped.studio.name : null);
          if (studioName) {
            // If the displayed name matches the originally scraped studio
            // (normal case, no renaming via an "Artists:" line), reuse the
            // full object to keep image/url on creation.
            filtered.studio = (scraped.studio && scraped.studio.name === studioName)
              ? scraped.studio
              : { name: studioName };
          }
        }
      }
    }

    // "Artists:" candidates not chosen as the main studio → "Other studios"
    // (only computed if the option is enabled, see applyScrapedData)
    if (pluginConfig.autoAddOtherStudios) {
      var allArtists = parseDetailsArtists(scraped.details).artists;
      var chosenName = filtered.studio ? filtered.studio.name : null;
      var others = allArtists.filter(function (a) { return a.name !== chosenName; }).map(function (a) { return a.name; });
      if (others.length) filtered.otherStudioNames = others;
    }

    // Tags: checked scraped ones + manual additions
    var selectedTags = [];
    var tagCbs = row.querySelectorAll('[data-cb="tag"]');
    tagCbs.forEach(function (el) {
      if (el.checked) {
        var idx = parseInt(el.getAttribute("data-idx"), 10);
        if (scraped.tags && scraped.tags[idx]) selectedTags.push(scraped.tags[idx]);
      }
    });
    // Tags added manually via the search bar
    var addedTags = row.querySelectorAll('[data-cb="tag-added"]');
    addedTags.forEach(function (el) {
      selectedTags.push({ stored_id: el.getAttribute("data-tag-id") || null, name: el.getAttribute("data-tag-name") });
    });
    if (selectedTags.length) filtered.tags = selectedTags;

    // Always keep whatever's already on the scene - performer_ids/tag_ids
    // on sceneUpdate REPLACE the list rather than add to it, so without
    // this, applying a scrape that simply doesn't mention an existing
    // performer/tag would silently delete it. The "Already on this scene"
    // pills shown in the UI aren't checkboxes (see renderRow) - they're
    // always kept, merged in here by ID instead. `name` is included
    // alongside `stored_id` because applyScrapedData()'s resolve step
    // treats any entry with no `name` as unusable and drops it (see
    // p_perfs/p_tags there), even when stored_id is set.
    var existingPerfIds = (filtered.performers || []).map(function (p) { return p.stored_id; }).filter(Boolean);
    (r.scene.performers || []).forEach(function (p) {
      if (existingPerfIds.indexOf(p.id) === -1) {
        filtered.performers = (filtered.performers || []).concat([{ stored_id: p.id, name: p.name }]);
        existingPerfIds.push(p.id);
      }
    });
    var existingTagIds = (filtered.tags || []).map(function (t) { return t.stored_id; }).filter(Boolean);
    (r.scene.tags || []).forEach(function (t) {
      if (existingTagIds.indexOf(t.id) === -1) {
        filtered.tags = (filtered.tags || []).concat([{ stored_id: t.id, name: t.name }]);
        existingTagIds.push(t.id);
      }
    });

    return filtered;
  }

  // Section icons (Studio/Performers/Tags/Details/URLs) - only actually
  // visible in solo mode (hidden by default via CSS, see .st-section-icon
  // in sceneTagger.css), where each field group becomes its own card and
  // needs a visual anchor. Rendered unconditionally here rather than only
  // building them in solo, since it's cheap and keeps renderRow() from
  // needing to know which mode it's running in.
  var ST_STUDIO_LOGO_PLACEHOLDER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 21V10a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v11"/></svg>';

  var ST_SECTION_ICONS = {
    studio: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 21V9"/>',
    date: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 3v3M16 3v3"/>',
    performers: '<circle cx="9" cy="7" r="3.2"/><path d="M2.5 20c0-4 3-6.5 6.5-6.5S15.5 16 15.5 20"/><circle cx="17" cy="8" r="2.6"/><path d="M14.8 13.3c2.6.4 4.7 2.7 4.7 6.2"/>',
    tags: '<path d="M20.6 12.3L12.7 4.4a2 2 0 0 0-1.4-.6H5a2 2 0 0 0-2 2v6.3c0 .5.2 1 .6 1.4l7.9 7.9c.8.8 2 .8 2.8 0l6.3-6.3c.8-.8.8-2.1 0-2.8z"/><circle cx="7.5" cy="7.5" r="1"/>',
    details: '<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h5"/>',
    urls: '<path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.5-1.5"/>',
    cover: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>'
  };
  function sectionIcon(name) {
    return '<span class="st-section-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + ST_SECTION_ICONS[name] + '</svg></span>';
  }

  // ── Custom date picker (solo mode only) ────────────────────────────────────
  //
  // A native <input type="date"> was tried first (session 2026-09-16) but
  // its calendar popup is rendered by the browser/OS and can't be styled
  // to match the plugin - this builds the whole thing (display button +
  // popover month grid) from scratch instead, driven by row state
  // (r.dateEditValue, r.dateCalendarMonth, r.dateCalendarOpen).

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  var ST_MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  function shiftMonthISO(monthISO, dir) {
    var parts = monthISO.split("-");
    var y = parseInt(parts[0], 10), m = parseInt(parts[1], 10) + dir;
    if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
    return y + "-" + pad2(m);
  }

  function buildDateCalendarHTML(monthISO, selectedISO) {
    var parts = monthISO.split("-");
    var year = parseInt(parts[0], 10), month = parseInt(parts[1], 10); // 1-12
    var first = new Date(year, month - 1, 1);
    var startDow = (first.getDay() + 6) % 7; // Mon=0..Sun=6 (was Sun=0..Sat=6)
    var daysInMonth = new Date(year, month, 0).getDate();
    var daysInPrevMonth = new Date(year, month - 1, 0).getDate();
    var todayISO = new Date().toISOString().slice(0, 10);

    var cells = "";
    for (var i = startDow - 1; i >= 0; i--) {
      cells += '<span class="st-date-cell st-date-muted">' + (daysInPrevMonth - i) + '</span>';
    }
    for (var d = 1; d <= daysInMonth; d++) {
      var iso = year + "-" + pad2(month) + "-" + pad2(d);
      var cls = "st-date-cell";
      if (iso === selectedISO) cls += " st-date-selected";
      if (iso === todayISO) cls += " st-date-today";
      cells += '<span class="' + cls + '" data-iso="' + iso + '">' + d + '</span>';
    }
    var trailing = (7 - ((startDow + daysInMonth) % 7)) % 7;
    for (var d2 = 1; d2 <= trailing; d2++) {
      cells += '<span class="st-date-cell st-date-muted">' + d2 + '</span>';
    }

    return (
      '<div class="st-date-pop-head">' +
        '<button type="button" class="st-date-pop-nav" data-dir="-1">&#8249;</button>' +
        '<span class="st-date-pop-month">' + ST_MONTH_NAMES[month - 1] + ' ' + year + '</span>' +
        '<button type="button" class="st-date-pop-nav" data-dir="1">&#8250;</button>' +
      '</div>' +
      '<div class="st-date-grid">' +
        '<span class="st-date-dow">Mo</span><span class="st-date-dow">Tu</span><span class="st-date-dow">We</span>' +
        '<span class="st-date-dow">Th</span><span class="st-date-dow">Fr</span><span class="st-date-dow">Sa</span><span class="st-date-dow">Su</span>' +
        cells +
      '</div>' +
      '<div class="st-date-pop-foot">' +
        '<button type="button" class="st-date-pop-link" data-action="clear">Clear</button>' +
        '<button type="button" class="st-date-pop-link" data-action="today">Today</button>' +
      '</div>'
    );
  }

  function buildDateFieldHTML(id, r) {
    var displayText = r.dateEditValue ? esc(r.dateEditValue) : "Select a date";
    var monthISO = r.dateCalendarMonth || (r.dateEditValue ? r.dateEditValue.slice(0, 7) : new Date().toISOString().slice(0, 7));
    r.dateCalendarMonth = monthISO; // persisted so nav has a stable base
    return (
      '<div class="st-date-field">' +
        '<button type="button" class="st-date-display" onclick="stDateToggle(\'' + esc(id) + '\')">' +
          '<span>' + displayText + '</span>' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 3v3M16 3v3"/></svg>' +
        '</button>' +
        (r.dateCalendarOpen ? '<div class="st-date-popover">' + buildDateCalendarHTML(monthISO, r.dateEditValue) + '</div>' : '') +
      '</div>'
    );
  }

  var _dateOutsideClickWired = false;
  function wireDateOutsideClickOnce() {
    if (_dateOutsideClickWired) return;
    _dateOutsideClickWired = true;
    document.addEventListener("click", function (e) {
      if (e.target.closest(".st-date-field")) return;
      var touched = false;
      Object.keys(state.rows).forEach(function (rid) {
        if (state.rows[rid].dateCalendarOpen) { state.rows[rid].dateCalendarOpen = false; touched = true; }
      });
      if (touched) Object.keys(state.rows).forEach(function (rid) { renderRow(rid); });
    });
  }

  // ── Rendering a row ────────────────────────────────────────────────────────

  function renderRow(id) {
    var r = state.rows[id];
    if (!r) return;
    var scene   = r.scene;
    var status  = r.status;
    var scraped = r.scraped;

    var el = document.getElementById("st-row-" + id);
    if (!el) return;

    el.className = "st-row st-state-" + status;

    // Solo mode's floating "re-scrape" button (bottom-right of the panel,
    // see buildPanel()) - only relevant once this row is "done", and only
    // in solo mode (the mass-list has its own Retry/Skip-all controls).
    var refreshBtn = document.getElementById("st-solo-refresh-btn");
    if (refreshBtn) {
      var panelElForRefresh = document.getElementById(PANEL_ID);
      var isSoloForRefresh = !!(panelElForRefresh && panelElForRefresh.classList.contains("st-panel-solo"));
      refreshBtn.style.display = (isSoloForRefresh && status === "done") ? "flex" : "none";
      // Same behavior as the mass-list's own "Reload" button (#st-btn-reload,
      // hidden in solo mode) - a full page reload, not a re-scrape - per
      // Sina's clarification (session 2026-09-16: "je veux dire le refresh
      // de la scène comme sur sceneTagger").
      refreshBtn.onclick = function () {
        try { sessionStorage.setItem(REOPEN_FLAG, "1"); } catch (e) {}
        window.location.reload();
      };
    }

    var thumb  = getThumb(scene);
    var fname  = getFilename(scene);
    var r34url = getR34URL(scene);
    var r34id  = getR34ID(scene);

    var hintHTML = "";
    if (status === "idle" || status === "scraped" || status === "done") {
      // Only show something here for scenes that actually look rule34-sourced
      // (id found in a URL or in the filename via getR34ID) - non-rule34
      // scrapers (community scrapers, manual entry, etc.) simply have no hint.
      hintHTML = r34url
        ? '<div class="st-hint"><a class="st-r34-link" href="' + esc(r34url) + '" target="_blank" rel="noopener">rule34 ID fichier #' + esc(r34id) + ' &#8599;</a></div>'
        : "";
    } else if (status === "error") {
      hintHTML = '<div class="st-hint st-hint-error">' + esc(r.msg || "Error") + '</div>';
    }

    var inlineHTML = "";
    if (status === "scraped" && scraped) {
      var fields = [];

      // ── "Scrape failed, manual fill-in" banner (manualFallbackOnFail mode)
      if (r.manualFallback) {
        fields.push(
          '<div class="st-inline-field st-manual-fallback-hint">' +
            '<span class="st-label-static"></span>' +
            '<span>Scrape failed (' + esc(r.msg || "error") + ') — manual fill-in</span>' +
          '</div>'
        );
      }

      // ── Manual title (manualFallbackOnFail + manualFallbackAllowTitle mode)
      if (r.manualFallback && pluginConfig.manualFallbackAllowTitle) {
        fields.push(
          '<div class="st-inline-field">' +
            '<label class="st-inline-label st-label-static">Title</label>' +
            '<input type="text" class="st-manual-title-input" placeholder="Title (optional)" value="' + esc(r.manualTitle || "") + '">' +
          '</div>'
        );
      }

      // ── Scraper-used badge (fallback, or search-by-title): visible when
      // it isn't the 1st enabled scraper in the chain (normal fallback
      // case), OR whenever the result came from title search - that's
      // never the "obvious" case so it's always worth flagging.
      var enabledChain = pluginConfig.scraperChain.filter(function (c) { return c.enabled; });
      var firstEnabled = enabledChain.length ? enabledChain[0].id : null;
      var showFallbackHint = r.viaTitleSearch ||
        (pluginConfig.scraperMode === "auto" && r.matchedScraperName && enabledChain.length > 1 && r.matchedScraperID !== firstEnabled);
      if (showFallbackHint && r.matchedScraperName) {
        fields.push(
          '<div class="st-inline-field st-scraper-match-hint">' +
            '<span class="st-label-static"></span>' +
            '<span>found via <strong>' + esc(r.matchedScraperName) + '</strong>' + (r.viaTitleSearch ? '' : ' (fallback)') + '</span>' +
          '</div>'
        );
      }

      // Solo mode (opened from a single scene page, see st-panel-solo) gets
      // the richer card/existing-vs-new layout below; the mass-scrape list
      // keeps the original compact rendering - a dense list of many rows
      // needs scanability, not per-field cards (confirmed regression
      // session 2026-09-16: the richer layout, applied everywhere at
      // first, made the list panel unusably tall/cluttered). Declared here,
      // before its first use (Cover) - it used to live down by Studio,
      // after Title/Cover already referenced it, so `var` hoisting silently
      // made it `undefined` there and Cover always fell back to the mass-
      // list markup even in solo (confirmed session 2026-09-16).
      var panelElForMode = document.getElementById(PANEL_ID);
      var isSolo = !!(panelElForMode && panelElForMode.classList.contains("st-panel-solo"));

      // ── Title
      if (scraped.title) {
        fields.push(
          '<div class="st-inline-field">' +
            '<label class="st-inline-label"><input type="checkbox" data-cb="title" checked> Title</label>' +
            '<span class="st-chip st-chip-title">' + esc(scraped.title) + '</span>' +
          '</div>'
        );
      }

      // ── Cover - solo mode: click one of two thumbnails (existing vs
      // scraped) side by side instead of a single checkbox+preview -
      // the selected one gets a highlight ring. Mass list keeps the
      // original checkbox - see isSolo.
      if (!isSolo) {
        if (scraped.image) {
          fields.push(
            '<div class="st-inline-field">' +
              '<label class="st-inline-label"><input type="checkbox" data-cb="cover" checked> Cover</label>' +
              '<img class="st-cover-preview" src="' + esc(scraped.image) + '" alt="cover">' +
            '</div>'
          );
        }
      } else if (scraped.image || thumb) {
        if (r.coverChoice === undefined) {
          r.coverChoice = scraped.image ? "scraped" : "existing";
        }
        var coverExistingHTML = thumb
          ? '<button type="button" class="st-cover-option' + (r.coverChoice === "existing" ? " st-cover-selected" : "") + '" onclick="stPickCover(\'' + esc(id) + '\',\'existing\')">' +
              '<img src="' + esc(thumb) + '" alt="existing cover">' +
              '<span class="st-cover-caption">Already on this scene</span>' +
            '</button>'
          : '<div class="st-cover-option st-cover-empty"><span class="st-split-empty">No existing thumbnail</span></div>';
        var coverScrapedHTML = scraped.image
          ? '<button type="button" class="st-cover-option' + (r.coverChoice === "scraped" ? " st-cover-selected" : "") + '" onclick="stPickCover(\'' + esc(id) + '\',\'scraped\')">' +
              '<img src="' + esc(scraped.image) + '" alt="scraped cover">' +
              '<span class="st-cover-caption st-new">New from scrape</span>' +
            '</button>'
          : '';
        fields.push(
          '<div class="st-inline-field st-inline-cover">' +
            '<span class="st-inline-label st-label-static">' + sectionIcon("cover") + 'Cover</span>' +
            '<div class="st-cover-options">' + coverExistingHTML + coverScrapedHTML + '</div>' +
          '</div>'
        );
      }

      // ── Studio / multiple artists
      var detailsParsed = parseDetailsArtists(scraped.details);
      var allArtists     = detailsParsed.artists; // full list from details
      var artists        = allArtists.filter(function(a) { return !isBlacklisted(a.name); });

      // If no non-blacklisted artist but there are blacklisted ones → fallback: show them anyway
      // (rule: if it's the only one available, show it)
      if (artists.length === 0 && allArtists.length > 0) {
        artists = allArtists; // show all, even blacklisted
      }

      // If there's no Artists: line in details, use scraped.studio directly,
      // checking whether it's blacklisted (unless it's the only one)
      var studioFromScraper = scraped.studio && scraped.studio.name ? scraped.studio.name : null;
      if (artists.length === 0 && studioFromScraper) {
        // No Artists: line — use scraped.studio
        artists = [{ name: studioFromScraper, stored_id: (scraped.studio && scraped.studio.stored_id) || null }];
      }

      // Fix the "new" badge for candidates with no stored_id detected
      // (neither an [id] in Details nor Stash's native matching) that
      // actually exist under an alias, already checked in the background by
      // refreshStudioAliasBadges() (see studioAliasBadgeCache).
      artists = artists.map(function (a) {
        if (a.stored_id) return a;
        var cachedId = getCachedStudioAliasId(a.name);
        return cachedId ? { name: a.name, stored_id: cachedId } : a;
      });

      // Studio search widget — common to both cases (radio and checkbox)
      var studioSearchWidget =
        '<div class="st-studio-search-wrap">' +
          '<input type="hidden" data-cb="studio-override" data-studio-id="" value="">' +
          '<input type="text" class="st-studio-search-input" placeholder="Search for an existing studio..." autocomplete="off">' +
          '<div class="st-studio-search-results" style="display:none"></div>' +
          '<span class="st-studio-selected" style="display:none"></span>' +
        '</div>';

      // ── Stacked existing-vs-new wrapper (logo reserved zone, not forced
      // square - object-fit:contain lets a wide/rectangular studio logo
      // show in full instead of being cropped). Purely visual: the actual
      // selection markup (radio/checkbox/search, all data-cb attributes)
      // is untouched below, just wrapped - getCheckedScraped() keeps
      // working exactly as before.
      function logoZoneHTML(imagePath, extraClass) {
        var cls = "st-studio-logo-zone" + (extraClass ? " " + extraClass : "");
        return imagePath
          ? '<div class="' + cls + '"><img src="' + esc(imagePath) + '"></div>'
          : '<div class="' + cls + ' st-studio-logo-empty">' + ST_STUDIO_LOGO_PLACEHOLDER_SVG + '</div>';
      }
      var existingStudioRowHTML =
        '<div class="st-studio-stack-row">' +
          '<div class="st-studio-left">' +
            '<span class="st-existing-caption">Already on this scene</span>' +
            '<span class="st-studio-name-plain">' + (scene.studio && scene.studio.name ? esc(scene.studio.name) : '(none)') + '</span>' +
          '</div>' +
          logoZoneHTML(scene.studio && scene.studio.image_path) +
        '</div>';
      var newStudioLogoHTML = logoZoneHTML(scraped.studio && scraped.studio.image);
      // Its own row/section (solo mode only) instead of being squeezed
      // under "New from scrape" - a manually searched studio isn't the
      // same candidate as the auto-scraped one and shouldn't read like it
      // is. No logo fetched while typing search results (would mean a
      // GraphQL round-trip per keystroke/result) - only once a studio is
      // actually picked, fetched on click (see the search-results click
      // handler below) and dropped into this zone by its
      // .st-studio-manual-logo class.
      var manualStudioRowHTML =
        '<div class="st-studio-stack-row">' +
          '<div class="st-studio-left st-studio-manual-left">' +
            '<span class="st-existing-caption">Manually added</span>' +
            studioSearchWidget +
            '<span class="st-split-empty st-studio-manual-empty">No studio added manually</span>' +
          '</div>' +
          logoZoneHTML(null, "st-studio-manual-logo") +
        '</div>';

      if (artists.length > 1) {
        // Multiple non-blacklisted artists → radio buttons
        var radioName = "st-studio-radio-" + id;
        // Determine which artist to pre-check:
        // 1. If prioritizeExistingStudio AND at least one has a stored_id → pre-check the first existing one
        // 2. Otherwise if autoCheckStudio is OFF and all are new → "None" by default
        // 3. Otherwise → first artist
        var allNew = artists.every(function(a) { return !a.stored_id; });
        var existingIdx = -1;
        if (pluginConfig.prioritizeExistingStudio) {
          for (var ei = 0; ei < artists.length; ei++) {
            if (artists[ei].stored_id) { existingIdx = ei; break; }
          }
        }
        var defaultNone = allNew && !pluginConfig.autoCheckStudio;
        var radioNoneChecked = (defaultNone && existingIdx === -1) ? ' checked' : '';
        // Index to pre-check: existing one takes priority, otherwise 0 if not defaultNone
        var defaultCheckedIdx = existingIdx !== -1 ? existingIdx : (defaultNone ? -1 : 0);
        var radioItems = artists.map(function (artist, i) {
          var checkedAttr = (i === defaultCheckedIdx) ? ' checked' : '';
          var isbl = isBlacklisted(artist.name);
          var artistIsNew = !artist.stored_id;
          return '<label class="st-radio-item' + (isbl ? ' st-radio-blacklisted' : '') + '">' +
            '<input type="radio" name="' + esc(radioName) + '" data-cb="studio-radio" data-artist="' + esc(artist.name) + '" data-artist-stored="' + (artist.stored_id ? "1" : "") + '"' + checkedAttr + '> ' +
            '<span class="st-selectable">' + esc(artist.name) + '</span>' +
            (artistIsNew ? ' <span class="st-new-badge">new</span>' : '') +
            (!isbl ? '<button class="st-blacklist-btn" data-artist="' + esc(artist.name) + '" title="Blacklist this studio">&#128683;</button>' : '') +
          '</label>';
        }).join("");
        var radioNone = '<label class="st-radio-item st-radio-none">' +
          '<input type="radio" name="' + esc(radioName) + '" data-cb="studio-radio" data-artist=""' + radioNoneChecked + '> ' +
          '<span class="st-selectable">None</span>' +
        '</label>';
        var studioMultiRadioHTML = '<div class="st-radio-group">' + radioNone + radioItems + '</div>';
        var studioMultiContentHTML = studioMultiRadioHTML + studioSearchWidget;
        if (isSolo) {
          fields.push(
            '<div class="st-inline-field st-inline-artists">' +
              '<span class="st-inline-label st-label-static">' + sectionIcon("studio") + 'Studio</span>' +
              '<div class="st-studio-stack">' +
                existingStudioRowHTML +
                '<div class="st-studio-stack-row">' +
                  '<div class="st-studio-left">' +
                    '<span class="st-existing-caption st-new">New from scrape</span>' +
                    studioMultiRadioHTML +
                  '</div>' +
                  newStudioLogoHTML +
                '</div>' +
                manualStudioRowHTML +
              '</div>' +
            '</div>'
          );
        } else {
          fields.push(
            '<div class="st-inline-field st-inline-artists">' +
              '<span class="st-inline-label st-label-static">Studio</span>' +
              '<div>' + studioMultiContentHTML + '</div>' +
            '</div>'
          );
        }
      } else if (artists.length === 1) {
        // A single artist (non-blacklisted or fallback) → checkbox
        var soloArtistObj = artists[0];
        var soloArtist   = soloArtistObj.name;
        var soloIsNew    = !soloArtistObj.stored_id;
        var soloChecked  = soloIsNew ? pluginConfig.autoCheckStudio : true;
        var soloIsBl     = isBlacklisted(soloArtist);
        var studioSoloChipOnlyHTML =
          '<span class="st-chip st-chip-studio' + (soloIsBl ? ' st-chip-blacklisted' : '') + '">' +
            '<span class="st-selectable">' + esc(soloArtist) + '</span>' +
            (soloIsNew ? ' <span class="st-new-badge">new</span>' : '') +
            (soloIsBl  ? ' <span class="st-bl-badge" title="Blacklisted but the only one available">⚠</span>' : '') +
          '</span>';
        var studioSoloChipHTML = studioSoloChipOnlyHTML + studioSearchWidget;
        if (isSolo) {
          fields.push(
            '<div class="st-inline-field st-inline-artists">' +
              '<span class="st-inline-label st-label-static">' + sectionIcon("studio") + 'Studio</span>' +
              '<div class="st-studio-stack">' +
                existingStudioRowHTML +
                '<div class="st-studio-stack-row">' +
                  '<div class="st-studio-left">' +
                    '<label class="st-existing-caption st-new" style="cursor:pointer;"><input type="checkbox" data-cb="studio" data-artist-stored="' + (soloArtistObj.stored_id || '') + '"' + (soloChecked ? ' checked' : '') + '> New from scrape</label>' +
                    studioSoloChipOnlyHTML +
                  '</div>' +
                  newStudioLogoHTML +
                '</div>' +
                manualStudioRowHTML +
              '</div>' +
            '</div>'
          );
        } else {
          fields.push(
            '<div class="st-inline-field st-inline-artists">' +
              '<label class="st-inline-label"><input type="checkbox" data-cb="studio" data-artist-stored="' + (soloArtistObj.stored_id || '') + '"' + (soloChecked ? ' checked' : '') + '> Studio</label>' +
              '<div>' + studioSoloChipHTML + '</div>' +
            '</div>'
          );
        }
      } else if (isSolo) {
        // No scraped studio → existing + manually-added only, no "New
        // from scrape" row since there's no candidate to show there.
        fields.push(
          '<div class="st-inline-field st-inline-artists">' +
            '<span class="st-inline-label st-label-static">' + sectionIcon("studio") + 'Studio</span>' +
            '<div class="st-studio-stack">' +
              existingStudioRowHTML +
              manualStudioRowHTML +
            '</div>' +
          '</div>'
        );
      } else {
        // No scraped studio → just the search (mass-list layout)
        fields.push(
          '<div class="st-inline-field st-inline-artists">' +
            '<span class="st-inline-label st-label-static">Studio</span>' +
            studioSearchWidget +
          '</div>'
        );
      }

      // ── Date - solo mode gets its own card, editable via the custom
      // calendar widget (buildDateFieldHTML), with the existing-vs-new
      // split when the two differ. The mass list keeps the original plain
      // checkbox+chip - see isSolo.
      if (!isSolo) {
        if (scraped.date) {
          fields.push(
            '<div class="st-inline-field">' +
              '<label class="st-inline-label"><input type="checkbox" data-cb="date" checked> Date</label>' +
              '<span class="st-chip st-chip-date">' + esc(scraped.date) + '</span>' +
            '</div>'
          );
        }
      } else {
        var existingDateText = (scene.date || "").trim();
        var scrapedDateText = (scraped.date || "").trim();
        var hasNewDate = !!scrapedDateText && scrapedDateText !== existingDateText;
        if (r.dateEditValue === undefined) {
          r.dateEditValue = hasNewDate ? scrapedDateText : existingDateText;
        }
        var dateExistingColHTML = hasNewDate
          ? '<div class="st-details-col">' +
              '<span class="st-existing-caption">Already on this scene</span>' +
              '<div class="st-details-readonly">' + (existingDateText ? esc(existingDateText) : '<span class="st-details-empty">(empty)</span>') + '</div>' +
            '</div>'
          : "";
        fields.push(
          '<div class="st-inline-field st-inline-date">' +
            '<span class="st-inline-label st-label-static">' + sectionIcon("date") + 'Date</span>' +
            '<div class="st-details-wrap' + (hasNewDate ? ' st-details-split' : '') + '">' +
              dateExistingColHTML +
              '<div class="st-details-col">' +
                (hasNewDate ? '<span class="st-existing-caption st-new">New from scrape (editable)</span>' : '') +
                buildDateFieldHTML(id, r) +
              '</div>' +
            '</div>' +
          '</div>'
        );
      }

      // ── Code
      if (scraped.code) {
        fields.push(
          '<div class="st-inline-field">' +
            '<label class="st-inline-label"><input type="checkbox" data-cb="code" checked> Code</label>' +
            '<span class="st-chip st-chip-code">' + esc(scraped.code) + '</span>' +
          '</div>'
        );
      }

      // ── Director
      if (scraped.director) {
        fields.push(
          '<div class="st-inline-field">' +
            '<label class="st-inline-label"><input type="checkbox" data-cb="director" checked> Director</label>' +
            '<span class="st-chip st-chip-director">' + esc(scraped.director) + '</span>' +
          '</div>'
        );
      }

      var perfSearchWidget =
        '<div class="st-perf-search-wrap">' +
          '<input type="text" class="st-perf-search-input" placeholder="Search for or add a performer..." autocomplete="off">' +
          '<div class="st-perf-search-results" style="display:none"></div>' +
        '</div>' +
        '<div class="st-perfs-added"></div>';

      if (isSolo) {
        // ── Already on this scene (kept as-is, not checkboxes - see the
        // merge step in getCheckedScraped()) vs new from the scrape.
        var existingPerfsHTML = (scene.performers && scene.performers.length)
          ? '<div class="st-existing-pills st-existing-pills-perf">' + scene.performers.map(function (p) {
              return '<span class="st-existing-pill st-existing-pill-perf">' +
                (p.image_path ? '<img class="st-perf-chip-avatar" src="' + esc(p.image_path) + '">' : '') +
                '<span class="st-perf-name">' + esc(p.name) + '</span>' +
              '</span>';
            }).join("") + '</div>'
          : "";
        var existingPerfIdSet = {};
        (scene.performers || []).forEach(function (p) { existingPerfIdSet[String(p.id)] = true; });

        var perfItemsHTML = "";
        if (scraped.performers && scraped.performers.length) {
          perfItemsHTML = scraped.performers.map(function (p, i) {
            // Already shown (and already kept) in existingPerfsHTML above -
            // no need for a second, redundant checkbox for the same performer.
            if (p.stored_id && existingPerfIdSet[String(p.stored_id)]) return "";
            var isNew = !p.stored_id;
            var perfChecked = isNew ? pluginConfig.autoCheckPerformer : true;
            return '<label class="st-perf-item' + (isNew ? ' st-perf-new' : '') + '">' +
              '<input type="checkbox" data-cb="performer" data-idx="' + i + '" ' + (perfChecked ? 'checked' : '') + '>' +
              (p.storedImage ? '<img class="st-perf-chip-avatar" src="' + esc(p.storedImage) + '">' : '') +
              '<span class="st-perf-name">' + esc(p.name) + '</span>' +
              (isNew ? '<span class="st-new-badge">new</span>' : '') +
            '</label>';
          }).join("");
        }

        var newPerfCount = (scraped.performers || []).filter(function (p) {
          return !(p.stored_id && existingPerfIdSet[String(p.stored_id)]);
        }).length;
        var existingPerfCount = (scene.performers || []).length;
        var perfsCountText = existingPerfCount || newPerfCount
          ? existingPerfCount + ' existing' +
            (newPerfCount ? ' &middot; ' + newPerfCount + ' new' : '')
          : '';
        var perfsLabel = newPerfCount
          ? '<label><input type="checkbox" data-cb="perfs-all" checked> Performers' + (perfsCountText ? ' <span class="st-count-hint">(' + perfsCountText + ')</span>' : '') + '</label>'
          : '<span>Performers' + (perfsCountText ? ' <span class="st-count-hint">(' + perfsCountText + ')</span>' : '') + '</span>';

        fields.push(
          '<div class="st-inline-field st-inline-performers">' +
            '<div class="st-inline-label">' + sectionIcon("performers") + perfsLabel + '</div>' +
            '<div class="st-split-cols">' +
              '<div class="st-split-col">' +
                '<span class="st-existing-caption">Already on this scene</span>' +
                (existingPerfsHTML || '<span class="st-split-empty">None</span>') +
              '</div>' +
              '<div class="st-split-col">' +
                '<span class="st-existing-caption st-new">New from scrape</span>' +
                (perfItemsHTML ? '<div class="st-perfs-grid">' + perfItemsHTML + '</div>' : '<span class="st-split-empty">None found</span>') +
                perfSearchWidget +
              '</div>' +
            '</div>' +
          '</div>'
        );
      } else {
        // ── Mass-list layout: original compact grid, no existing/new
        // split - getCheckedScraped() still silently keeps whatever's
        // already on the scene regardless (see its merge step), this is
        // purely about what's SHOWN here.
        var perfItemsHTMLOld = "";
        if (scraped.performers && scraped.performers.length) {
          perfItemsHTMLOld = scraped.performers.map(function (p, i) {
            var isNew = !p.stored_id;
            var perfChecked = isNew ? pluginConfig.autoCheckPerformer : true;
            return '<label class="st-perf-item' + (isNew ? ' st-perf-new' : '') + '">' +
              '<input type="checkbox" data-cb="performer" data-idx="' + i + '" ' + (perfChecked ? 'checked' : '') + '>' +
              (p.storedImage ? '<img class="st-perf-chip-avatar" src="' + esc(p.storedImage) + '">' : '') +
              '<span class="st-perf-name">' + esc(p.name) + '</span>' +
              (isNew ? '<span class="st-new-badge">new</span>' : '') +
            '</label>';
          }).join("");
        }
        var perfsLabelOld = scraped.performers && scraped.performers.length
          ? '<label><input type="checkbox" data-cb="perfs-all" checked> Performers (' + scraped.performers.length + ')</label>'
          : '<span>Performers</span>';
        fields.push(
          '<div class="st-inline-field st-inline-performers">' +
            '<div class="st-inline-label">' + perfsLabelOld + '</div>' +
            '<div class="st-perfs-right">' +
              (perfItemsHTMLOld ? '<div class="st-perfs-grid">' + perfItemsHTMLOld + '</div>' : '') +
              perfSearchWidget +
            '</div>' +
          '</div>'
        );
      }

      // ── Tags (scraped + manually added via search/create)
      {
        var tagSearchWidget =
          '<div class="st-tag-search-wrap">' +
            '<input type="text" class="st-tag-search-input" placeholder="Search for or add a tag..." autocomplete="off">' +
            '<div class="st-tag-search-results" style="display:none"></div>' +
          '</div>' +
          '<div class="st-tags-added"></div>';

        if (isSolo) {
          var existingTagsHTML = (scene.tags && scene.tags.length)
            ? '<div class="st-existing-pills">' + scene.tags.map(function (t) {
                return '<span class="st-existing-pill">' + esc(t.name) + '</span>';
              }).join("") + '</div>'
            : "";
          var existingTagIdSet = {};
          (scene.tags || []).forEach(function (t) { existingTagIdSet[String(t.id)] = true; });

          var tagItems = (scraped.tags || []).map(function (t, i) {
            // Already shown (and already kept) in existingTagsHTML above.
            if (t.stored_id && existingTagIdSet[String(t.stored_id)]) return "";
            var isNew = !t.stored_id;
            var tagChecked = isNew ? pluginConfig.autoCheckNewTags : true;
            return '<label class="st-tag-item' + (isNew ? ' st-tag-new' : '') + '">' +
              '<input type="checkbox" data-cb="tag" data-idx="' + i + '" ' + (tagChecked ? 'checked' : '') + '>' +
              '<span class="st-selectable">' + esc(t.name) + '</span>' +
              (isNew ? '<span class="st-new-badge">new</span>' : '') +
            '</label>';
          }).join("");

          var newTagCount = (scraped.tags || []).filter(function (t) {
            return !(t.stored_id && existingTagIdSet[String(t.stored_id)]);
          }).length;
          var existingTagCount = (scene.tags || []).length;
          var tagsCountText = existingTagCount || newTagCount
            ? existingTagCount + ' existing' +
              (newTagCount ? ' &middot; ' + newTagCount + ' new' : '')
            : '';
          var tagsLabel = newTagCount
            ? '<label><input type="checkbox" data-cb="tags-all" checked> Tags' + (tagsCountText ? ' <span class="st-count-hint">(' + tagsCountText + ')</span>' : '') + '</label>'
            : '<span>Tags' + (tagsCountText ? ' <span class="st-count-hint">(' + tagsCountText + ')</span>' : '') + '</span>';

          fields.push(
            '<div class="st-inline-field st-inline-tags">' +
              '<div class="st-inline-label">' + sectionIcon("tags") + tagsLabel + '</div>' +
              '<div class="st-split-cols">' +
                '<div class="st-split-col">' +
                  '<span class="st-existing-caption">Already on this scene</span>' +
                  (existingTagsHTML || '<span class="st-split-empty">None</span>') +
                '</div>' +
                '<div class="st-split-col">' +
                  '<span class="st-existing-caption st-new">New from scrape</span>' +
                  (tagItems ? '<div class="st-tags-grid">' + tagItems + '</div>' : '<span class="st-split-empty">None found</span>') +
                  tagSearchWidget +
                '</div>' +
              '</div>' +
            '</div>'
          );
        } else {
          // ── Mass-list layout: original compact grid, no existing/new
          // split (see the same note on Performers above).
          var tagItemsOld = (scraped.tags || []).map(function (t, i) {
            var isNew = !t.stored_id;
            var tagChecked = isNew ? pluginConfig.autoCheckNewTags : true;
            return '<label class="st-tag-item' + (isNew ? ' st-tag-new' : '') + '">' +
              '<input type="checkbox" data-cb="tag" data-idx="' + i + '" ' + (tagChecked ? 'checked' : '') + '>' +
              '<span class="st-selectable">' + esc(t.name) + '</span>' +
              (isNew ? '<span class="st-new-badge">new</span>' : '') +
            '</label>';
          }).join("");
          var tagsLabelOld = scraped.tags && scraped.tags.length
            ? '<label><input type="checkbox" data-cb="tags-all" checked> Tags (' + scraped.tags.length + ')</label>'
            : '<span>Tags</span>';
          fields.push(
            '<div class="st-inline-field st-inline-tags">' +
              '<div class="st-inline-label">' + tagsLabelOld + '</div>' +
              (tagItemsOld ? '<div class="st-tags-grid">' + tagItemsOld + '</div>' : '') +
              tagSearchWidget +
            '</div>'
          );
        }
      }

      // ── Details - solo mode: always editable, pre-filled with whatever's
      // best available, split into "Already on this scene" (read-only) /
      // "New from scrape (editable)" only when the two genuinely differ.
      // Mass list keeps the original checkbox+chip preview - see isSolo.
      if (!isSolo) {
        if (scraped.details) {
          var detailsParsedForDisplay = parseDetailsArtists(scraped.details);
          var hasRealContent = !!detailsParsedForDisplay.rest;
          var detailsChecked = pluginConfig.autoCheckDetails ? true : hasRealContent;
          var detailsShort = scraped.details.length > 80 ? scraped.details.substring(0, 80) + "…" : scraped.details;
          fields.push(
            '<div class="st-inline-field">' +
              '<label class="st-inline-label"><input type="checkbox" data-cb="details"' + (detailsChecked ? ' checked' : '') + '> Details</label>' +
              '<span class="st-chip st-chip-details" title="' + esc(scraped.details) + '">' + esc(detailsShort) + '</span>' +
            '</div>'
          );
        }
      } else {
        var scrapedDetailsClean = scraped.details ? scraped.details.replace(/\[(\w+)\]/g, "").trim() : "";
        var existingDetailsText = (scene.details || "").trim();
        var hasNewDetails = !!scrapedDetailsClean && scrapedDetailsClean !== existingDetailsText;
        if (r.detailsEditValue === undefined) {
          r.detailsEditValue = hasNewDetails ? scrapedDetailsClean : existingDetailsText;
        }
        var detailsExistingColHTML = hasNewDetails
          ? '<div class="st-details-col">' +
              '<span class="st-existing-caption">Already on this scene</span>' +
              '<div class="st-details-readonly">' + (existingDetailsText ? esc(existingDetailsText) : '<span class="st-details-empty">(empty)</span>') + '</div>' +
            '</div>'
          : "";
        fields.push(
          '<div class="st-inline-field st-inline-details">' +
            '<span class="st-inline-label st-label-static">' + sectionIcon("details") + 'Details</span>' +
            '<div class="st-details-wrap' + (hasNewDetails ? ' st-details-split' : '') + '">' +
              detailsExistingColHTML +
              '<div class="st-details-col">' +
                (hasNewDetails ? '<span class="st-existing-caption st-new">New from scrape (editable)</span>' : '') +
                '<textarea class="st-details-edit" placeholder="Details...">' + esc(r.detailsEditValue) + '</textarea>' +
              '</div>' +
            '</div>' +
          '</div>'
        );
      }

      // ── URLs - solo mode: a single combined, always-additive editable
      // stack (existing + new from the scrape, deduped), each removable
      // via its own button, plus an input to add one more. Mass list keeps
      // the original checkbox+chips preview - see isSolo.
      if (!isSolo) {
        if (scraped.urls && scraped.urls.length) {
          var urlChips = scraped.urls.map(function (u) {
            return '<a class="st-chip st-chip-url" href="' + esc(u) + '" target="_blank" rel="noopener" title="' + esc(u) + '">' + esc(u) + '</a>';
          }).join("");
          fields.push(
            '<div class="st-inline-field st-inline-urls">' +
              '<label class="st-inline-label"><input type="checkbox" data-cb="urls" checked> URLs</label>' +
              '<div class="st-inline-chips">' + urlChips + '</div>' +
            '</div>'
          );
        }
      } else {
        if (r.urlEditList === undefined) {
          var seenUrls = {};
          r.urlEditList = [];
          (scene.urls || []).forEach(function (u) {
            if (u && !seenUrls[u]) { seenUrls[u] = true; r.urlEditList.push({ value: u, isNew: false }); }
          });
          (scraped.urls || []).forEach(function (u) {
            if (u && !seenUrls[u]) { seenUrls[u] = true; r.urlEditList.push({ value: u, isNew: true }); }
          });
        }
        var urlRowsHTML = r.urlEditList.map(function (u, i) {
          return '<div class="st-url-row' + (u.isNew ? ' st-url-row-new' : '') + '">' +
            '<span class="st-url-link" title="' + esc(u.value) + '">' + esc(u.value) + '</span>' +
            (u.isNew ? '<span class="st-url-badge-new">new</span>' : '') +
            '<button class="st-url-remove" onclick="stRemoveUrl(\'' + esc(id) + '\',' + i + ')" title="Remove">&#10005;</button>' +
          '</div>';
        }).join("");
        fields.push(
          '<div class="st-inline-field st-inline-urls">' +
            '<span class="st-inline-label st-label-static">' + sectionIcon("urls") + 'URLs</span>' +
            '<div class="st-url-list-wrap">' +
              (urlRowsHTML ? '<div class="st-url-list">' + urlRowsHTML + '</div>' : '') +
              '<input type="text" class="st-url-add-input" placeholder="Add a URL...">' +
            '</div>' +
          '</div>'
        );
      }

      inlineHTML =
        '<div class="st-inline-results">' +
          fields.join("") +
          '<div class="st-inline-actions">' +
            '<button class="st-btn st-btn-success" onclick="stApplyOne(\'' + esc(id) + '\')">Apply</button>' +
            (r.manualFallback ? '<button class="st-btn st-btn-ghost" onclick="stScrapeOne(\'' + esc(id) + '\')">Retry</button>' : '') +
            '<button class="st-btn st-btn-danger"  onclick="stSkipOne(\''  + esc(id) + '\')">Skip</button>' +
            '<button class="st-btn ' + (r.markOrganized ? "st-btn-organized-on" : "st-btn-organized-off") + '" onclick="stToggleOrganized(\'' + esc(id) + '\')">' +
              (r.markOrganized
                ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="vertical-align:-2px;margin-right:4px"><path d="M20 6L9 17l-5-5"/></svg>'
                : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><circle cx="12" cy="12" r="9"/></svg>') +
              'Organized' +
            '</button>' +
          '</div>' +
        '</div>';
    }

    // "Search title" is offered when at least one search-capable scraper is
    // configured - any stash-box, plus any YAML scraper that declares NAME
    // support (see isSearchCapable()).
    var hasStashBox = state.scrapers.some(isSearchCapable);
    var searchTitleBtnHTML = hasStashBox
      ? '<button class="st-btn st-btn-ghost" onclick="stToggleTitleSearch(\'' + esc(id) + '\')">' + (r.titleSearchOpen ? "Cancel search" : "Search title") + '</button>'
      : "";

    var rightHTML = "";
    if (status === "idle" || status === "skipped") {
      rightHTML = '<div class="st-row-btn"><button class="st-btn st-btn-primary" onclick="stScrapeOne(\'' + esc(id) + '\')">Scrape</button>' + searchTitleBtnHTML + '</div>';
    } else if (status === "scraping" || status === "applying") {
      rightHTML = '<div class="st-row-btn"><span class="st-spinner"></span></div>';
    } else if (status === "done") {
      rightHTML = '<div class="st-row-btn"><span class="st-done-icon">&#10003;</span></div>';
    } else if (status === "error") {
      rightHTML = '<div class="st-row-btn"><button class="st-btn st-btn-ghost" onclick="stScrapeOne(\'' + esc(id) + '\')">Retry</button>' + searchTitleBtnHTML + '</div>';
    }

    var sceneUrl = window.location.origin + "/scenes/" + id;

    // Manual URL field: one-off entry (not persisted) used with absolute
    // priority for scraping this row, via scrapeSceneURL().
    var manualUrlHTML = "";
    if (status === "idle" || status === "error" || status === "skipped") {
      manualUrlHTML = '<div class="st-manual-url-wrap">' +
        '<input type="text" class="st-manual-url-input" placeholder="URL (optional)" value="' + esc(r.manualUrl || "") + '">' +
      '</div>';
    }

    // ── "Search title" panel (fallback for when fragment/hash scraping
    // finds nothing - query-based search against any search-capable
    // scraper (stash-box or NAME-capable YAML, see isSearchCapable()),
    // returns a candidate list to pick from instead of a single
    // auto-matched result).
    var titleSearchHTML = "";
    if (r.titleSearchOpen) {
      var stashBoxes = state.scrapers.filter(isSearchCapable);
      var tsSelectedBoxID = r.titleSearchScraperID || (stashBoxes[0] && stashBoxes[0].id) || "";
      var tsQuery = r.titleSearchQuery != null ? r.titleSearchQuery : (scene.title || fname);

      var tsBoxOptionsHTML = stashBoxes.map(function (b) {
        return '<option value="' + esc(b.id) + '"' + (b.id === tsSelectedBoxID ? ' selected' : '') + '>' + esc(b.name) + '</option>';
      }).join("");

      var tsResultsHTML = "";
      if (r.titleSearchLoading) {
        tsResultsHTML = '<div class="st-ts-status"><span class="st-spinner"></span></div>';
      } else if (r.titleSearchError) {
        tsResultsHTML = '<div class="st-ts-status st-ts-error">' + esc(r.titleSearchError) + '</div>';
      } else if (r.titleSearchResults) {
        if (!r.titleSearchResults.length) {
          tsResultsHTML = '<div class="st-ts-status">No results</div>';
        } else {
          tsResultsHTML = '<div class="st-ts-results">' + r.titleSearchResults.map(function (cand, idx) {
            var studioName = cand.studio && cand.studio.name ? cand.studio.name : "";
            var studioIsBl = studioName && isBlacklisted(studioName);
            var studioBadgeHTML = studioName
              ? '<span class="' + (studioIsBl ? 'st-ts-studio-bl' : 'st-ts-studio-ok') + '">' + esc(studioName) + (studioIsBl ? ' &#9888; blacklisted' : '') + '</span>'
              : "";
            return '<div class="st-ts-result" onclick="stPickTitleResult(\'' + esc(id) + '\',' + idx + ')">' +
              (cand.image ? '<img class="st-ts-thumb" src="' + esc(cand.image) + '">' : '<div class="st-ts-thumb"></div>') +
              '<div class="st-ts-info">' +
                '<div class="st-ts-title">' + esc(cand.title || "(no title)") + '</div>' +
                '<div class="st-ts-meta">' + (cand.date ? esc(cand.date) + ' &middot; ' : '') + studioBadgeHTML + '</div>' +
              '</div>' +
            '</div>';
          }).join("") + '</div>';
        }
      }

      titleSearchHTML =
        '<div class="st-title-search">' +
          (stashBoxes.length > 1 ? '<select class="st-ts-source">' + tsBoxOptionsHTML + '</select>' : '') +
          '<div class="st-ts-search-row">' +
            '<input type="text" class="st-ts-input" value="' + esc(tsQuery) + '">' +
            '<button class="st-btn st-btn-primary" onclick="stRunTitleSearch(\'' + esc(id) + '\')">Search</button>' +
          '</div>' +
          tsResultsHTML +
        '</div>';
    }

    el.innerHTML =
      '<div class="st-row-top">' +
        // .st-thumb-clip does the clipping (size + overflow:hidden) - see
        // the CSS comment on that class: Stash's native SFW blur targets
        // .scene-card-preview (carried here by .st-thumb-link, unconditionally
        // - it's Stash's own blur hook, unrelated to the hover-preview
        // feature below despite the confusingly similar name), and an
        // element can never clip its OWN filter bleed with its own
        // overflow:hidden - only an ANCESTOR can, hence this dedicated
        // outer wrapper.
        // Stash always returns a constructed paths.preview URL whether or
        // not that clip was actually generated on disk - hitting it 404s
        // for scenes without one, there's no truthiness check that tells
        // you in advance. So both URLs are carried (preview tried first,
        // cheap when it exists; data-stream-url as the fallback the hover
        // handler switches to on the video's 'error' event) instead of
        // picking one up front.
        '<span class="st-thumb-clip"' +
          (pluginConfig.nativeHoverPreview && scene.paths && scene.paths.preview
            ? ' data-preview-url="' + esc(scene.paths.preview) + '"'
            : '') +
          (pluginConfig.nativeHoverPreview && scene.paths && scene.paths.stream
            ? ' data-stream-url="' + esc(scene.paths.stream) + '"' +
              ' data-preview-duration="' + esc(getSceneDuration(scene)) + '"'
            : '') +
        '>' +
        (thumb
          ? '<a href="' + esc(sceneUrl) + '" target="_blank" class="st-thumb-link scene-card-preview"><img class="st-thumb" src="' + esc(thumb) + '" loading="lazy"></a>'
          : '<a href="' + esc(sceneUrl) + '" target="_blank" class="st-thumb-link scene-card-preview"><div class="st-thumb"></div></a>') +
        '</span>' +
        '<div class="st-row-info">' +
          '<a href="' + esc(sceneUrl) + '" target="_blank" class="st-filename st-scene-link">' + esc(fname) + '</a>' +
          hintHTML +
          manualUrlHTML +
        '</div>' +
        rightHTML +
      '</div>' +
      inlineHTML +
      titleSearchHTML;

    var manualUrlInput = el.querySelector(".st-manual-url-input");
    if (manualUrlInput) {
      manualUrlInput.addEventListener("input", function () {
        r.manualUrl = manualUrlInput.value.trim();
      });
    }

    var tsInput = el.querySelector(".st-ts-input");
    if (tsInput) {
      tsInput.addEventListener("input", function () {
        r.titleSearchQuery = tsInput.value;
      });
      // Enter runs the search directly, same as clicking "Search".
      tsInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); window.stRunTitleSearch(id); }
      });
    }
    var tsSource = el.querySelector(".st-ts-source");
    if (tsSource) {
      tsSource.addEventListener("change", function () {
        r.titleSearchScraperID = tsSource.value;
      });
    }

    var manualTitleInput = el.querySelector(".st-manual-title-input");
    if (manualTitleInput) {
      manualTitleInput.addEventListener("input", function () {
        r.manualTitle = manualTitleInput.value.trim();
      });
    }

    var detailsEdit = el.querySelector(".st-details-edit");
    if (detailsEdit) {
      detailsEdit.addEventListener("input", function () {
        r.detailsEditValue = detailsEdit.value;
      });
    }

    var dateField = el.querySelector(".st-date-field");
    if (dateField) {
      wireDateOutsideClickOnce();
      dateField.querySelectorAll(".st-date-pop-nav").forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          window.stDateNav(id, parseInt(btn.getAttribute("data-dir"), 10));
        });
      });
      dateField.querySelectorAll(".st-date-cell[data-iso]").forEach(function (cell) {
        cell.addEventListener("click", function (e) {
          e.stopPropagation();
          window.stDatePick(id, cell.getAttribute("data-iso"));
        });
      });
      var dateClearBtn = dateField.querySelector('[data-action="clear"]');
      if (dateClearBtn) dateClearBtn.addEventListener("click", function (e) { e.stopPropagation(); window.stDateClear(id); });
      var dateTodayBtn = dateField.querySelector('[data-action="today"]');
      if (dateTodayBtn) dateTodayBtn.addEventListener("click", function (e) { e.stopPropagation(); window.stDateToday(id); });
    }

    var urlAddInput = el.querySelector(".st-url-add-input");
    if (urlAddInput) {
      var commitUrlAdd = function () {
        var v = urlAddInput.value.trim();
        if (!v) return;
        r.urlEditList = r.urlEditList || [];
        r.urlEditList.push({ value: v, isNew: false });
        urlAddInput.value = "";
        renderRow(id);
      };
      urlAddInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); commitUrlAdd(); }
      });
      urlAddInput.addEventListener("blur", commitUrlAdd);
    }

    // ── Blacklist buttons on the artist radios ─────────────────────────────
    if (status === "scraped") {
      el.querySelectorAll('.st-blacklist-btn').forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          e.preventDefault(); e.stopPropagation();
          var artist = btn.getAttribute("data-artist");
          if (!artist) return;
          var n = artist.toLowerCase();
          if (pluginConfig.studioBlacklist.indexOf(n) === -1) {
            pluginConfig.studioBlacklist.push(n);
            savePluginConfig();
            backupBlacklist();
          }
          // Re-render the row to remove the blacklisted artist
          renderRow(id);
          // Update the chips in the settings panel
          var container = document.getElementById("st-blacklist-chips");
          if (container) {
            var chips = container.querySelectorAll('.st-blacklist-remove');
            // Force a re-render of the chips if the panel is open
            var settingsPanel = document.getElementById("st-settings-panel");
            if (settingsPanel && settingsPanel.style.display !== "none") {
              // Re-trigger renderBlacklistChips via a simulated click on settings to refresh
              // (can't call renderBlacklistChips directly from here since it's inside attachPanelEvents)
              // Workaround: dispatch a custom event
              document.dispatchEvent(new CustomEvent("st-blacklist-updated"));
            }
          }
        });
      });
    }

    // ── Live performer search ────────────────────────────────────────────────
    if (status === "scraped") {
      var perfSearchInput   = el.querySelector('.st-perf-search-input');
      var perfSearchResults = el.querySelector('.st-perf-search-results');
      var perfsAdded        = el.querySelector('.st-perfs-added');

      if (perfSearchInput && perfSearchResults && perfsAdded) {
        var perfSearchTimer = null;

        perfSearchInput.addEventListener("input", function () {
          clearTimeout(perfSearchTimer);
          var q = perfSearchInput.value.trim();
          if (q.length < 2) { perfSearchResults.style.display = "none"; perfSearchResults.innerHTML = ""; return; }
          perfSearchTimer = setTimeout(function () {
            Promise.all([
              gql("FPS",  Q_FP_SEARCH,       { n: q }).then(function (d) { return (d.findPerformers || {}).performers || []; }).catch(function(){return[];}),
              gql("FPSA", Q_FP_SEARCH_ALIAS, { n: q }).then(function (d) { return (d.findPerformers || {}).performers || []; }).catch(function(){return[];})
            ]).then(function (results) {
              var seen = {}; var perfs = [];
              results[0].concat(results[1]).forEach(function (p) {
                if (!seen[p.id]) { seen[p.id] = true; perfs.push(p); }
              });
              perfs = perfs.slice(0, 10);
              var createItem = '<div class="st-perf-result-item st-perf-create-item" data-id="" data-name="' + esc(q) + '">+ Create "' + esc(q) + '"</div>';
              if (!perfs.length) {
                perfSearchResults.innerHTML = createItem;
              } else {
                perfSearchResults.innerHTML = perfs.map(function (p) {
                  return '<div class="st-perf-result-item" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '" data-image="' + esc(p.image_path || "") + '">' + esc(p.name) + '</div>';
                }).join("") + createItem;
              }
              perfSearchResults.style.display = "block";
            });
          }, 300);
        });

        // Enter key → add the first result or create
        perfSearchInput.addEventListener("keydown", function (e) {
          if (e.key !== "Enter") return;
          var first = perfSearchResults.querySelector('.st-perf-result-item');
          if (first) first.click();
        });

        // Thumbnail on hover: a single reusable preview element rather than
        // one <img> per result (avoids loading all 10 images up front for a
        // dropdown the user is just scanning by name), shown/positioned
        // against whichever item the mouse is currently over.
        var perfHoverPreview = null;
        perfSearchResults.addEventListener("mouseover", function (e) {
          var item = e.target.closest('.st-perf-result-item');
          if (!item) return;
          var img = item.getAttribute("data-image");
          if (!img) { if (perfHoverPreview) perfHoverPreview.style.display = "none"; return; }
          if (!perfHoverPreview) {
            perfHoverPreview = document.createElement("img");
            perfHoverPreview.className = "st-perf-hover-preview";
            // Appended to document.body (not the wrap) and positioned via
            // fixed viewport coordinates - the wrap sits inside #st-rows,
            // which has overflow-x:hidden for its own scroll behavior and
            // was silently clipping this preview whenever it extended past
            // the row's bounds, independent of the panel's dragged
            // position (confirmed session 2026-09-16).
            document.body.appendChild(perfHoverPreview);
          }
          perfHoverPreview.src = img;
          var wrapRect = perfSearchResults.parentNode.getBoundingClientRect();
          var itemRect = item.getBoundingClientRect();
          perfHoverPreview.style.top = itemRect.top + "px";
          // Default spot is to the right of the wrap - but the "New from
          // scrape" search box sits near the panel's right edge, so that
          // default pushes the 120px preview off the viewport entirely.
          // Flip to the left side of the wrap instead whenever the right
          // side doesn't fit on screen.
          var previewW = 120, gap = 8;
          if (wrapRect.right + gap + previewW > window.innerWidth) {
            perfHoverPreview.style.left = (wrapRect.left - previewW - gap) + "px";
          } else {
            perfHoverPreview.style.left = (wrapRect.right + gap) + "px";
          }
          perfHoverPreview.style.display = "block";
        });
        perfSearchResults.addEventListener("mouseleave", function () {
          if (perfHoverPreview) perfHoverPreview.style.display = "none";
        });

        perfSearchResults.addEventListener("click", function (e) {
          var item = e.target.closest('.st-perf-result-item');
          if (!item) return;
          var pid    = item.getAttribute("data-id");
          var pname  = item.getAttribute("data-name");
          var pimage = item.getAttribute("data-image");

          // Avoid duplicates
          var already = Array.from(perfsAdded.querySelectorAll('[data-cb="performer-added"]'))
            .some(function (el) { return el.getAttribute("data-perf-name").toLowerCase() === pname.toLowerCase(); });
          if (already) { perfSearchResults.style.display = "none"; perfSearchInput.value = ""; return; }

          // Create the added chip — small round avatar (like Refract Cards'
          // performer circles) when the search result carried an image_path,
          // silently omitted otherwise (a "+ Create" pseudo-performer has none).
          var chip = document.createElement("span");
          chip.className = "st-perf-added-chip";
          chip.innerHTML =
            (pimage ? '<img class="st-perf-chip-avatar" src="' + esc(pimage) + '">' : '') +
            esc(pname) + ' <button class="st-perf-chip-remove" title="Remove">&#10005;</button>';
          chip.setAttribute("data-cb", "performer-added");
          chip.setAttribute("data-perf-id", pid);
          chip.setAttribute("data-perf-name", pname);
          chip.querySelector('.st-perf-chip-remove').addEventListener("click", function () { chip.remove(); });
          perfsAdded.appendChild(chip);

          // Close
          perfSearchResults.style.display = "none";
          perfSearchResults.innerHTML = "";
          perfSearchInput.value = "";
        });

        // Close on click elsewhere
        document.addEventListener("click", function onPerfDocClick(e) {
          if (!el.contains(e.target)) {
            perfSearchResults.style.display = "none";
            document.removeEventListener("click", onPerfDocClick);
          }
        });

        // Hover preview on the confirmed chip's own avatar (its <img src>
        // already holds the image_path, no need to re-store it anywhere).
        wireAvatarHoverPreview(perfsAdded, ".st-perf-added-chip");
      }

      // Same preview, wired to the scraped-performers checkbox grid (its
      // avatars, if any, come from fetchStoredPerformerImages() instead of
      // a search result - the .st-perf-chip-avatar class and hover
      // mechanics are identical either way).
      var perfsGrid = el.querySelector(".st-perfs-grid");
      if (perfsGrid) wireAvatarHoverPreview(perfsGrid, ".st-perf-item");

      // Same preview again for the "Already on this scene" pills (left
      // column) - now carrying the same round avatar since they also
      // fetch image_path (see existingPerfsHTML above).
      var existingPerfsEl = el.querySelector(".st-existing-pills-perf");
      if (existingPerfsEl) wireAvatarHoverPreview(existingPerfsEl, ".st-existing-pill-perf");
    }

    // ── Live tag search ─────────────────────────────────────────────────────
    if (status === "scraped") {
      var tagSearchInput   = el.querySelector('.st-tag-search-input');
      var tagSearchResults = el.querySelector('.st-tag-search-results');
      var tagsAdded        = el.querySelector('.st-tags-added');

      if (tagSearchInput && tagSearchResults && tagsAdded) {
        var tagSearchTimer = null;

        tagSearchInput.addEventListener("input", function () {
          clearTimeout(tagSearchTimer);
          var q = tagSearchInput.value.trim();
          if (q.length < 2) { tagSearchResults.style.display = "none"; tagSearchResults.innerHTML = ""; return; }
          tagSearchTimer = setTimeout(function () {
            gql("FTagS", Q_FTAG_SEARCH, { n: q }).then(function (d) {
              var tags = ((d.findTags || {}).tags || []).slice(0, 10);
              var createItem = '<div class="st-tag-result-item st-tag-create-item" data-id="" data-name="' + esc(q) + '">+ Create "' + esc(q) + '"</div>';
              if (!tags.length) {
                tagSearchResults.innerHTML = createItem;
              } else {
                tagSearchResults.innerHTML = tags.map(function (t) {
                  return '<div class="st-tag-result-item" data-id="' + esc(t.id) + '" data-name="' + esc(t.name) + '">' + esc(t.name) + '</div>';
                }).join("") + createItem;
              }
              tagSearchResults.style.display = "block";
            }).catch(function () {});
          }, 300);
        });

        // Enter key → add the first result or create
        tagSearchInput.addEventListener("keydown", function (e) {
          if (e.key !== "Enter") return;
          var first = tagSearchResults.querySelector('.st-tag-result-item');
          if (first) first.click();
        });

        tagSearchResults.addEventListener("click", function (e) {
          var item = e.target.closest('.st-tag-result-item');
          if (!item) return;
          var tid   = item.getAttribute("data-id");
          var tname = item.getAttribute("data-name");

          // Avoid duplicates (checked scraped tags + already added)
          var alreadyAdded = Array.from(tagsAdded.querySelectorAll('[data-cb="tag-added"]'))
            .some(function (el) { return el.getAttribute("data-tag-name").toLowerCase() === tname.toLowerCase(); });
          var alreadyScraped = (scraped.tags || []).some(function (t) { return t.name.toLowerCase() === tname.toLowerCase(); });
          if (alreadyAdded || alreadyScraped) { tagSearchResults.style.display = "none"; tagSearchInput.value = ""; return; }

          // Create the added chip
          var chip = document.createElement("span");
          chip.className = "st-tag-added-chip";
          chip.innerHTML = esc(tname) + ' <button class="st-tag-chip-remove" title="Remove">&#10005;</button>';
          chip.setAttribute("data-cb", "tag-added");
          chip.setAttribute("data-tag-id", tid);
          chip.setAttribute("data-tag-name", tname);
          chip.querySelector('.st-tag-chip-remove').addEventListener("click", function () { chip.remove(); });
          tagsAdded.appendChild(chip);

          // Close
          tagSearchResults.style.display = "none";
          tagSearchResults.innerHTML = "";
          tagSearchInput.value = "";
        });

        // Close on click elsewhere
        document.addEventListener("click", function onTagDocClick(e) {
          if (!el.contains(e.target)) {
            tagSearchResults.style.display = "none";
            document.removeEventListener("click", onTagDocClick);
          }
        });
      }
    }

    // ── Live studio search ───────────────────────────────────────────────────
    if (status === "scraped") {
      var searchInput   = el.querySelector('.st-studio-search-input');
      var searchResults = el.querySelector('.st-studio-search-results');
      var overrideInput = el.querySelector('[data-cb="studio-override"]');
      var selectedSpan  = el.querySelector('.st-studio-selected');
      var manualEmptyHint = el.querySelector('.st-studio-manual-empty');

      if (searchInput && searchResults && overrideInput) {
        var searchTimer = null;

        searchInput.addEventListener("input", function () {
          clearTimeout(searchTimer);
          var q = searchInput.value.trim();
          if (q.length < 2) { searchResults.style.display = "none"; searchResults.innerHTML = ""; return; }
          searchTimer = setTimeout(function () {
            gql("FSS", Q_FS_SEARCH, { n: q }).then(function (d) {
              var studios = ((d.findStudios || {}).studios || []).slice(0, 8);
              var createItem = '<div class="st-studio-result-item st-studio-create-item" data-id="" data-name="' + esc(q) + '">+ Create "' + esc(q) + '"</div>';
              if (!studios.length) {
                searchResults.innerHTML = createItem;
              } else {
                searchResults.innerHTML = studios.map(function (s) {
                  return '<div class="st-studio-result-item" data-id="' + esc(s.id) + '" data-name="' + esc(s.name) + '">' + esc(s.name) + '</div>';
                }).join("") + createItem;
              }
              searchResults.style.display = "block";
            }).catch(function () {});
          }, 300);
        });

        searchResults.addEventListener("click", function (e) {
          var item = e.target.closest('.st-studio-result-item');
          if (!item) return;
          var sid  = item.getAttribute("data-id");
          var sname = item.getAttribute("data-name");
          // Store the override
          overrideInput.value = sname;
          overrideInput.setAttribute("data-studio-id", sid);
          // Show the selected studio as a bordered chip + remove (✕),
          // matching the "Already on this scene"/"New from scrape" rows
          // instead of the old plain "→ name" link.
          selectedSpan.innerHTML = esc(sname) + ' <span class="st-studio-selected-x">&#10005;</span>';
          selectedSpan.style.display = "inline-flex";
          if (manualEmptyHint) manualEmptyHint.style.display = "none";
          // Uncheck the radios and the original studio checkbox
          el.querySelectorAll('[data-cb="studio-radio"]').forEach(function (r) { r.checked = false; });
          var studioOrigCb = el.querySelector('[data-cb="studio"]');
          if (studioOrigCb) studioOrigCb.checked = true;
          // Close the results and clear the input
          searchResults.style.display = "none";
          searchResults.innerHTML = "";
          searchInput.value = "";
          // Fetch the picked studio's own logo (only now, on click - not
          // per keystroke/result while typing) and drop it into the
          // reserved zone next to "Manually added".
          var manualLogoZone = el.querySelector(".st-studio-manual-logo");
          if (manualLogoZone) {
            if (sid) {
              gql("StudioImg", Q_STUDIO_IMAGE, { id: sid }).then(function (d) {
                var img = d.findStudio && d.findStudio.image_path;
                if (img) {
                  manualLogoZone.classList.remove("st-studio-logo-empty");
                  manualLogoZone.innerHTML = '<img src="' + esc(img) + '">';
                }
              }).catch(function () {});
            } else {
              // "+ Create ..." path - brand new studio, no image yet.
              manualLogoZone.classList.add("st-studio-logo-empty");
              manualLogoZone.innerHTML = ST_STUDIO_LOGO_PLACEHOLDER_SVG;
            }
          }
        });

        // Close on click elsewhere
        document.addEventListener("click", function onDocClick(e) {
          if (!el.contains(e.target)) {
            searchResults.style.display = "none";
            el.removeEventListener && document.removeEventListener("click", onDocClick);
          }
        });

        // Reset the override on click on selectedSpan
        if (selectedSpan) {
          selectedSpan.addEventListener("click", function () {
            overrideInput.value = "";
            overrideInput.setAttribute("data-studio-id", "");
            selectedSpan.style.display = "none";
            if (manualEmptyHint) manualEmptyHint.style.display = "";
            var manualLogoZone = el.querySelector(".st-studio-manual-logo");
            if (manualLogoZone) {
              manualLogoZone.classList.add("st-studio-logo-empty");
              manualLogoZone.innerHTML = ST_STUDIO_LOGO_PLACEHOLDER_SVG;
            }
          });
        }
      }
    }

    // "Check all/uncheck all" toggle for tags
    if (status === "scraped") {
      var tagsAllCb = el.querySelector('[data-cb="tags-all"]');
      if (tagsAllCb) {
        tagsAllCb.addEventListener("change", function () {
          el.querySelectorAll('[data-cb="tag"]').forEach(function (cb) {
            cb.checked = tagsAllCb.checked;
          });
        });
      }
      var perfsAllCb = el.querySelector('[data-cb="perfs-all"]');
      if (perfsAllCb) {
        perfsAllCb.addEventListener("change", function () {
          el.querySelectorAll('[data-cb="performer"]').forEach(function (cb) {
            cb.checked = perfsAllCb.checked;
          });
        });
      }
    }

    // Apply the studio filter after every render
    applyStudioFilter();
  }

  // ── Live studio filter ─────────────────────────────────────────────────────

  // Returns "new", "existing", or "none" for a given row
  function getRowStudioStatus(id) {
    var r = state.rows[id];
    if (!r || r.status !== "scraped" || !r.scraped) return "none";

    var row = document.getElementById("st-row-" + id);
    if (!row) return "none";

    // Manual override?
    var overrideEl = row.querySelector('[data-cb="studio-override"]');
    if (overrideEl && overrideEl.value) {
      return overrideEl.getAttribute("data-studio-id") ? "existing" : "new";
    }

    // Multi-artist radio? Base this on ALL candidates detected by the
    // scrape, regardless of which one is currently selected for apply -
    // otherwise a "new" candidate gets ignored as soon as another
    // "existing" candidate is pre-selected (e.g. prioritizeExistingStudio option).
    var radios = row.querySelectorAll('[data-cb="studio-radio"]');
    if (radios.length) {
      var candidateRadios = row.querySelectorAll('[data-cb="studio-radio"][data-artist]:not([data-artist=""])');
      var hasNewCandidate = false, hasExistingCandidate = false;
      candidateRadios.forEach(function(rd) {
        if (rd.getAttribute("data-artist-stored")) hasExistingCandidate = true;
        else hasNewCandidate = true;
      });
      if (hasNewCandidate) return "new";
      if (hasExistingCandidate) return "existing";
      return "none";
    }

    // Solo checkbox?
    var studioCb = row.querySelector('[data-cb="studio"]');
    if (!studioCb) return "none";

    // Read the data-artist-stored attribute on the checkbox (set by
    // renderRow), even if the box isn't checked: the filter must reflect
    // what the scrape detected, not just the current selection for apply.
    var storedId = studioCb.getAttribute("data-artist-stored");
    if (storedId !== null) {
      return storedId ? "existing" : "new";
    }

    // Fallback: look in details, then scraped.studio
    var scraped = r.scraped;
    var parsedSolo = parseDetailsArtists(scraped.details);
    if (parsedSolo.artists.length >= 1) {
      // Find the non-blacklisted artist
      var solo = parsedSolo.artists.filter(function(a) { return !isBlacklisted(a.name); });
      if (solo.length === 1) return solo[0].stored_id ? "existing" : "new";
      if (parsedSolo.artists.length === 1) return parsedSolo.artists[0].stored_id ? "existing" : "new";
    }
    if (scraped.studio) return scraped.studio.stored_id ? "existing" : "new";
    return "none";
  }

  // Rebuilds the "Filter by scraper" dropdown from what's actually on
  // screen right now: only scrapers that produced >=1 scraped result are
  // listed (never the full scraper catalog - most won't have matched
  // anything in a given batch). Called after every scrape and on Clear/
  // Reload so the list stays live. Preserves the current selection when
  // it's still a valid option; falls back to "all" otherwise (e.g. Clear).
  function renderScraperFilterOptions() {
    var list = document.getElementById("st-scraper-filter-list");
    var btn  = document.getElementById("st-scraper-filter-btn");
    if (!list || !btn) return;
    var seen = {};
    var options = [];
    state.scenes.forEach(function (scene) {
      var r = state.rows[scene.id];
      if (r && r.status === "scraped" && r.matchedScraperID && !seen[r.matchedScraperID]) {
        seen[r.matchedScraperID] = true;
        options.push({ id: r.matchedScraperID, name: r.matchedScraperName || r.matchedScraperID });
      }
    });
    options.sort(function (a, b) { return a.name.localeCompare(b.name); });

    var current = state.scraperFilter;
    var stillValid = current === "all" || seen[current];
    if (!stillValid) { state.scraperFilter = "all"; current = "all"; }

    list.innerHTML =
      '<div class="st-combo-option' + (current === "all" ? " st-combo-option-selected" : "") + '" role="option" data-id="all" data-name="All scrapers">All scrapers</div>' +
      options.map(function (o) {
        return '<div class="st-combo-option' + (o.id === current ? " st-combo-option-selected" : "") + '" role="option" data-id="' + esc(o.id) + '" data-name="' + esc(o.name) + '">' + esc(o.name) + '</div>';
      }).join("");
    var currentOpt = options.filter(function (o) { return o.id === current; })[0];
    btn.textContent = current === "all" ? "All scrapers" : (currentOpt ? currentOpt.name : current);
  }

  // A row has "multiple studio candidates" when the scrape surfaced more
  // than one candidate studio radio (data-artist set) for that row -
  // regardless of which one is currently selected for apply.
  function rowHasMultipleStudioCandidates(id) {
    var row = document.getElementById("st-row-" + id);
    if (!row) return false;
    var candidateRadios = row.querySelectorAll('[data-cb="studio-radio"][data-artist]:not([data-artist=""])');
    return candidateRadios.length > 1;
  }

  function applyStudioFilter() {
    var f = state.studioFilter;
    var sf = state.scraperFilter;
    var multiOnly = state.multiStudioOnly;
    state.scenes.forEach(function(scene) {
      var el = document.getElementById("st-row-" + scene.id);
      if (!el) return;
      var r = state.rows[scene.id];
      // Errors: no new/existing status since there's no scraped result to
      // classify - hidden under New/Existing, stay visible under All so
      // failures needing a retry aren't lost from view.
      if (r && r.status === "error" && (f !== "all" || sf !== "all" || multiOnly)) {
        el.style.display = "none";
        return;
      }
      if (!r || r.status !== "scraped") {
        el.style.display = (sf === "all" && !multiOnly) ? "" : "none";
        return;
      }
      if (sf !== "all" && r.matchedScraperID !== sf) { el.style.display = "none"; return; }
      if (multiOnly && !rowHasMultipleStudioCandidates(scene.id)) { el.style.display = "none"; return; }
      if (f === "all") { el.style.display = ""; return; }
      var status = getRowStudioStatus(scene.id);
      if (f === "new")      el.style.display = (status === "new")      ? "" : "none";
      if (f === "existing") el.style.display = (status === "existing") ? "" : "none";
    });
  }

  function buildAllRows() {
    var container = document.getElementById("st-rows");
    if (!container) return;
    container.innerHTML = "";
    state.scenes.forEach(function (scene) {
      var el = document.createElement("div");
      el.id = "st-row-" + scene.id;
      el.className = "st-row";
      container.appendChild(el);
      renderRow(scene.id);
    });
    updatePageInfo();
  }

  // ── Global actions (window) ────────────────────────────────────────────────

  // After a successful scrape: checks in the background whether studio
  // candidates flagged "new" (no stored_id) actually match an existing
  // alias, and re-renders the row if the badge needs to change.
  // Non-blocking: the row displays normally while the check runs.
  function refreshStudioAliasBadges(id) {
    var r = state.rows[id];
    if (!r || !r.scraped) return;
    var names = [];
    var detailsArtists = parseDetailsArtists(r.scraped.details).artists;
    if (detailsArtists.length) {
      detailsArtists.forEach(function (a) { if (!a.stored_id) names.push(a.name); });
    } else if (r.scraped.studio && r.scraped.studio.name && !r.scraped.studio.stored_id) {
      names.push(r.scraped.studio.name);
    }
    if (!names.length) return;
    checkStudioAliasBadges(names).then(function (changed) {
      if (changed && state.rows[id] && state.rows[id].scraped === r.scraped) renderRow(id);
    });
  }

  // Shared hover-preview wiring for any container holding .st-perf-chip-avatar
  // images (the confirmed-performer chips AND the scraped-performers
  // checkbox grid both use it) - one reusable floating <img>, repositioned
  // above whichever chip/item is under the mouse, rather than one full-size
  // preview element sitting behind every avatar up front.
  function wireAvatarHoverPreview(container, chipSelector) {
    var preview = null;
    container.addEventListener("mouseover", function (e) {
      var avatar = e.target.closest(".st-perf-chip-avatar");
      if (!avatar) return;
      if (!preview) {
        preview = document.createElement("img");
        preview.className = "st-perf-hover-preview";
        // Appended to document.body, not the container - the container
        // sits inside #st-rows, which has overflow-x:hidden for its own
        // scroll behavior. A position:absolute preview nested in there got
        // silently clipped whenever it extended past the row's bounds,
        // regardless of the panel's dragged position (confirmed session
        // 2026-09-16). position:fixed + body-level placement (viewport
        // coordinates, no ancestor to clip against) avoids that entirely.
        document.body.appendChild(preview);
      }
      preview.src = avatar.src;
      var chipRect = avatar.closest(chipSelector).getBoundingClientRect();
      var previewW = 120, previewH = 160, margin = 8;
      // Popped above the chip/item (like a tooltip), not on top of it.
      var top = chipRect.top - previewH - margin;
      // Clamped to the viewport horizontally - a chip near the panel's
      // right edge would otherwise push the preview off screen.
      var left = chipRect.left;
      if (left + previewW + margin > window.innerWidth) left = window.innerWidth - previewW - margin;
      if (left < margin) left = margin;
      preview.style.top  = top + "px";
      preview.style.left = left + "px";
      preview.style.display = "block";
    });
    container.addEventListener("mouseleave", function () {
      if (preview) preview.style.display = "none";
    });
  }

  // For performers already matched to an existing DB entry (stored_id set),
  // fetches that performer's own local avatar (image_path) so the checkbox
  // list can show the same round Refract-Cards-style avatar + hover preview
  // as manually-searched-and-added performers. Deliberately NOT the
  // scraper-provided `p.images` (that's a source-site image, possibly
  // unrelated/outdated for a performer that already has a curated local
  // photo) - only performers actually in the database qualify.
  // Non-blocking, same pattern as refreshStudioAliasBadges: the row displays
  // normally while this runs, then re-renders once images arrive.
  function fetchStoredPerformerImages(id) {
    var r = state.rows[id];
    if (!r || !r.scraped || !r.scraped.performers) return;
    var toFetch = r.scraped.performers.filter(function (p) { return p.stored_id && p.storedImage === undefined; });
    if (!toFetch.length) return;
    Promise.all(toFetch.map(function (p) {
      return gql("FPImg", Q_FP_IMAGE, { id: p.stored_id }).then(function (d) {
        p.storedImage = (d.findPerformer && d.findPerformer.image_path) || "";
      }).catch(function () { p.storedImage = ""; });
    })).then(function () {
      if (state.rows[id] && state.rows[id].scraped === r.scraped) renderRow(id);
    });
  }

  // Auto-mark-organized (pluginConfig.autoMarkOrganized) only defaults to
  // checked for scenes with an actual scraped studio - scenes with no
  // scraped result at all (manual fallback, empty scraped object) or no
  // studio match are left unchecked, requiring the user to activate
  // "Organized" by hand for those two cases.
  function applyOrganizedAutoDefault(r) {
    var hasStudio = !!(r.scraped && r.scraped.studio && r.scraped.studio.name);
    r.markOrganized = pluginConfig.autoMarkOrganized && hasStudio;
  }

  // Marks a scrape failure on row r. If the "manual fill-in" mode is
  // enabled, treats the row as "scraped" with empty data (shows the usual
  // panel: studio/performers/tags/details all empty, ready to fill in by
  // hand) instead of a plain error - the original error message stays
  // visible in a banner for context.
  function handleScrapeFailure(r, msg) {
    if (pluginConfig.manualFallbackOnFail) {
      r.status = "scraped";
      r.scraped = {};
      r.manualFallback = true;
      r.msg = msg;
      applyOrganizedAutoDefault(r);
    } else {
      r.status = "error";
      r.msg = msg;
    }
  }

  // ── Search title (query-based: stash-box or NAME-capable YAML scraper) ────

  window.stToggleTitleSearch = function (id) {
    var r = state.rows[id];
    if (!r) return;
    r.titleSearchOpen = !r.titleSearchOpen;
    if (r.titleSearchOpen) {
      r.titleSearchResults = null;
      r.titleSearchError = "";
      // The input's displayed default (scene title, falls back to
      // filename) is only a DOM attribute until the user actually types -
      // without writing it into r here too, stRunTitleSearch() sees an
      // empty r.titleSearchQuery and bails out on a totally untouched
      // field (confirmed session 2026-09-16: clicking Search did nothing).
      if (!r.titleSearchQuery) r.titleSearchQuery = r.scene.title || getFilename(r.scene);
    }
    renderRow(id);
  };

  window.stRunTitleSearch = function (id) {
    var r = state.rows[id];
    if (!r || !r.titleSearchOpen) return;
    var stashBoxes = state.scrapers.filter(isSearchCapable);
    var scraperID = r.titleSearchScraperID || (stashBoxes[0] && stashBoxes[0].id) || "";
    var query = (r.titleSearchQuery || "").trim();
    if (!scraperID || !query) return;

    r.titleSearchLoading = true; r.titleSearchError = ""; r.titleSearchResults = null;
    renderRow(id);

    scrapeSingleSceneByQuery(scraperID, query)
      .then(function (results) {
        r.titleSearchLoading = false;
        r.titleSearchResults = results;
        renderRow(id);
      })
      .catch(function (err) {
        r.titleSearchLoading = false;
        r.titleSearchError = err.message || String(err);
        renderRow(id);
      });
  };

  // Picking a candidate from the title-search list behaves exactly like a
  // successful fragment scrape (same r.scraped shape, same renderRow()
  // fields/apply flow) - only the "found via" hint differs.
  window.stPickTitleResult = function (id, idx) {
    var r = state.rows[id];
    if (!r || !r.titleSearchResults || !r.titleSearchResults[idx]) return;
    var candidate = r.titleSearchResults[idx];
    var stashBoxes = state.scrapers.filter(isSearchCapable);
    var box = stashBoxes.filter(function (s) { return s.id === r.titleSearchScraperID; })[0] || stashBoxes[0];

    r.status = "scraped";
    r.scraped = candidate;
    r.matchedScraperID = box ? box.id : r.titleSearchScraperID;
    r.matchedScraperName = (box ? box.name : "Search") + " (search by title)";
    r.viaTitleSearch = true;
    r.manualFallback = false;
    r.titleSearchOpen = false;
    r.titleSearchResults = null;
    applyOrganizedAutoDefault(r);

    renderRow(id); updatePageInfo(); renderScraperFilterOptions(); applyStudioFilter();
    refreshStudioAliasBadges(id); fetchStoredPerformerImages(id);
  };

  window.stScrapeOne = function (id) {
    var r = state.rows[id];
    if (!r) return;
    r.status = "scraping"; r.scraped = null; r.msg = ""; r.matchedScraperName = null; r.matchedScraperID = null; r.manualFallback = false; r.viaTitleSearch = false;
    renderRow(id);
    updateStatus("Scraping " + getFilename(r.scene) + "...");

    scrapeOneEffective(id)
      .then(function (res) {
        if (!res.scraped) { handleScrapeFailure(r, "No result"); }
        else               { r.status = "scraped"; r.scraped = res.scraped; r.matchedScraperName = res.scraperName; r.matchedScraperID = res.scraperID; applyOrganizedAutoDefault(r); }
        renderRow(id); updatePageInfo(); renderScraperFilterOptions(); applyStudioFilter();
        if (r.status === "scraped") { refreshStudioAliasBadges(id); fetchStoredPerformerImages(id); }
      })
      .catch(function (err) {
        handleScrapeFailure(r, err.message || String(err));
        renderRow(id); updatePageInfo();
      });
  };

  window.stApplyOne = function (id) {
    var r = state.rows[id];
    if (!r) return;
    var filtered = getCheckedScraped(id);
    if (!filtered) return;
    r.status = "applying"; renderRow(id);

    applyScrapedData(id, filtered)
      .then(function () {
        r.status = "done"; renderRow(id); updatePageInfo();
        updateStatus("Applied: " + getFilename(r.scene));
      })
      .catch(function (err) {
        r.status = "error"; r.msg = "Apply : " + (err.message || String(err));
        renderRow(id); updatePageInfo();
      });
  };

  window.stSkipOne = function (id) {
    var r = state.rows[id];
    if (!r) return;
    r.status = "skipped"; renderRow(id); updatePageInfo();
  };

  window.stToggleOrganized = function (id) {
    var r = state.rows[id];
    if (!r) return;
    r.markOrganized = !r.markOrganized;
    renderRow(id);
  };

  window.stRemoveUrl = function (id, idx) {
    var r = state.rows[id];
    if (!r || !r.urlEditList) return;
    r.urlEditList.splice(idx, 1);
    renderRow(id);
  };

  window.stPickCover = function (id, choice) {
    var r = state.rows[id];
    if (!r) return;
    r.coverChoice = choice;
    renderRow(id);
  };

  // ── Custom date picker handlers ─────────────────────────────────────────

  window.stDateToggle = function (id) {
    var r = state.rows[id];
    if (!r) return;
    r.dateCalendarOpen = !r.dateCalendarOpen;
    renderRow(id);
  };

  window.stDateNav = function (id, dir) {
    var r = state.rows[id];
    if (!r) return;
    r.dateCalendarMonth = shiftMonthISO(r.dateCalendarMonth || new Date().toISOString().slice(0, 7), dir);
    renderRow(id);
  };

  window.stDatePick = function (id, iso) {
    var r = state.rows[id];
    if (!r) return;
    r.dateEditValue = iso;
    r.dateCalendarMonth = iso.slice(0, 7);
    r.dateCalendarOpen = false;
    renderRow(id);
  };

  window.stDateClear = function (id) {
    var r = state.rows[id];
    if (!r) return;
    r.dateEditValue = "";
    r.dateCalendarOpen = false;
    renderRow(id);
  };

  window.stDateToday = function (id) {
    var r = state.rows[id];
    if (!r) return;
    var iso = new Date().toISOString().slice(0, 10);
    r.dateEditValue = iso;
    r.dateCalendarMonth = iso.slice(0, 7);
    r.dateCalendarOpen = false;
    renderRow(id);
  };

  // ── Sequential Scrape All ──────────────────────────────────────────────────

  function scrapeAll() {
    if (state.running) return;
    var todo = state.scenes.filter(function (scene) {
      var s = (state.rows[scene.id] || {}).status;
      return !s || s === "idle" || s === "error" || s === "skipped";
    });
    if (!todo.length) { updateStatus("Nothing to scrape"); return; }

    state.running = true;
    setScrapeAllBtn(true);

    (function next(i) {
      if (i >= todo.length) {
        state.running = false;
        setScrapeAllBtn(false);
        updateProgress(todo.length, todo.length);
        updateStatus("Done — " + todo.length + " scenes processed");
        updatePageInfo();
        return;
      }
      var scene = todo[i];
      var r     = state.rows[scene.id];
      if (!r) { next(i + 1); return; }

      updateProgress(i, todo.length);
      updateStatus("Scraping " + (i + 1) + "/" + todo.length + " : " + getFilename(scene));
      r.status = "scraping"; r.scraped = null; r.msg = ""; r.matchedScraperName = null; r.matchedScraperID = null; r.manualFallback = false; r.viaTitleSearch = false;
      renderRow(scene.id);

      scrapeOneEffective(scene.id)
        .then(function (res) {
          if (!res.scraped) { handleScrapeFailure(r, "No result"); }
          else               { r.status = "scraped"; r.scraped = res.scraped; r.matchedScraperName = res.scraperName; r.matchedScraperID = res.scraperID; applyOrganizedAutoDefault(r); }
          renderRow(scene.id); updatePageInfo(); renderScraperFilterOptions(); applyStudioFilter();
          if (r.status === "scraped") { refreshStudioAliasBadges(scene.id); fetchStoredPerformerImages(scene.id); }
          setTimeout(function () { next(i + 1); }, 700);
        })
        .catch(function (err) {
          handleScrapeFailure(r, err.message || String(err));
          renderRow(scene.id); updatePageInfo();
          setTimeout(function () { next(i + 1); }, 700);
        });
    })(0);
  }

  // ── Apply All ───────────────────────────────────────────────────────────────

  function applyAll() {
    var todo = state.scenes.filter(function (scene) {
      if ((state.rows[scene.id] || {}).status !== "scraped") return false;
      var el = document.getElementById("st-row-" + scene.id);
      return el && el.style.display !== "none";
    });
    if (!todo.length) return;
    setApplyAllBtn(true);
    updateStatus("Bulk apply: " + todo.length + " scenes...");

    var seq = Promise.resolve();
    todo.forEach(function (scene) {
      seq = seq.then(function () {
        window.stApplyOne(scene.id);
        return new Promise(function (resolve) { setTimeout(resolve, 300); });
      });
    });
    seq.then(function () { updateStatus("All scenes applied"); updatePageInfo(); });
  }

  // ── Skip All ────────────────────────────────────────────────────────────────
  // Same visible-rows scope as applyAll(): only scraped rows currently
  // shown under the active filter combo (studio radio + multi-studio +
  // scraper) get skipped, so e.g. "Multi-studio" + "Skip All" clears out
  // just the ambiguous batch without touching the rest of the queue.
  function skipAll() {
    var todo = state.scenes.filter(function (scene) {
      if ((state.rows[scene.id] || {}).status !== "scraped") return false;
      var el = document.getElementById("st-row-" + scene.id);
      return el && el.style.display !== "none";
    });
    if (!todo.length) return;
    todo.forEach(function (scene) { window.stSkipOne(scene.id); });
    updateStatus(todo.length + " scenes skipped");
  }

  // ── Status / progress ──────────────────────────────────────────────────────

  function updateStatus(t) { var el = document.getElementById("st-status-text"); if (el) el.textContent = t; }

  function updateProgress(done, total) {
    var b = document.getElementById("st-progress-bar");
    if (b) b.style.width = (total > 0 ? Math.round(done / total * 100) : 0) + "%";
  }

  function updatePageInfo() {
    var el = document.getElementById("st-page-info");
    if (!el) return;
    var scraped = 0, done = 0, errors = 0;
    Object.keys(state.rows).forEach(function (id) {
      var s = state.rows[id].status;
      if (s === "scraped") scraped++;
      if (s === "done")    done++;
      if (s === "error")   errors++;
    });
    el.textContent = state.scenes.length + " scenes" +
      (done    ? " — " + done    + " applied" : "") +
      (scraped ? " — " + scraped + " pending" : "") +
      (errors  ? " — " + errors  + " errors"    : "");
    setApplyAllBtn(scraped === 0);
    setSkipAllBtn(scraped === 0);
  }

  function setScrapeAllBtn(d) {
    var b = document.getElementById("st-btn-scrape-all"); if (b) b.disabled = d;
    var drag = document.getElementById("st-titlebar-drag");
    if (drag) drag.classList.toggle("st-titlebar-active", d);
  }
  function setApplyAllBtn(d)  { var b = document.getElementById("st-btn-apply-all");  if (b) b.disabled = d; }
  function setSkipAllBtn(d)   { var b = document.getElementById("st-btn-skip-all");   if (b) b.disabled = d; }

  function updatePageNav() {
    var prevBtn = document.getElementById("st-btn-page-prev");
    var nextBtn = document.getElementById("st-btn-page-next");
    var label   = document.getElementById("st-page-nav-label");
    if (prevBtn) prevBtn.disabled = state.currentPage <= 1;
    if (nextBtn) nextBtn.disabled = state.currentPage >= state.totalPages;
    if (label)   label.textContent = state.currentPage + " / " + state.totalPages;
  }

  // ── Scraper fallback chain (Settings): checkbox + drag reorder ───────────

  function renderScraperChain() {
    var container = document.getElementById("st-scraper-chain");
    if (!container) return;

    container.innerHTML = pluginConfig.scraperChain.map(function (c, i) {
      var scraper = state.scrapers.filter(function (s) { return s.id === c.id; })[0];
      var name = scraper ? scraper.name : c.id;
      return '<div class="st-chain-item" draggable="true" data-idx="' + i + '">' +
        '<span class="st-chain-handle" title="Drag to reorder">&#8942;&#8942;</span>' +
        '<label class="st-chain-label"><input type="checkbox" data-idx="' + i + '"' + (c.enabled ? ' checked' : '') + '> ' + esc(name) + '</label>' +
      '</div>';
    }).join("");

    container.querySelectorAll('.st-chain-item input[type="checkbox"]').forEach(function (cb) {
      cb.addEventListener("change", function () {
        var idx = parseInt(cb.getAttribute("data-idx"), 10);
        pluginConfig.scraperChain[idx].enabled = cb.checked;
        savePluginConfig();
      });
    });

    var dragSrcIdx = null;
    container.querySelectorAll(".st-chain-item").forEach(function (item) {
      item.addEventListener("dragstart", function (e) {
        dragSrcIdx = parseInt(item.getAttribute("data-idx"), 10);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(dragSrcIdx)); // required by Firefox
        item.classList.add("st-chain-dragging");
      });
      item.addEventListener("dragend", function () {
        item.classList.remove("st-chain-dragging");
      });
      item.addEventListener("dragover", function (e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      });
      item.addEventListener("drop", function (e) {
        e.preventDefault();
        var targetIdx = parseInt(item.getAttribute("data-idx"), 10);
        if (dragSrcIdx === null || dragSrcIdx === targetIdx) return;
        var arr = pluginConfig.scraperChain;
        var moved = arr.splice(dragSrcIdx, 1)[0];
        arr.splice(targetIdx, 0, moved);
        dragSrcIdx = null;
        savePluginConfig();
        renderScraperChain();
      });
    });
  }

  // ── Load the scenes ────────────────────────────────────────────────────────

  // Anti-race token: if loadScenes() is called again (new navigation)
  // before a previous call has finished waiting/loading, the previous call
  // must not touch the state anymore once it resolves (otherwise a stale
  // result could overwrite the correct one afterward).
  var _loadScenesToken = 0;

  function loadScenes() {
    var token = ++_loadScenesToken;
    updateStatus("Loading scenes...");
    waitForSceneCards(3000).then(function (ids) {
      if (token !== _loadScenesToken) return;
      if (!ids.length) { updateStatus("No scene visible in the grid."); return; }
      return gql("FindScenesByIds", Q_FIND_BY_IDS, { ids: ids }).then(function (d) {
        if (token !== _loadScenesToken) return;
        var byId = {};
        ((d.findScenes || {}).scenes || []).forEach(function (s) { byId[s.id] = s; });
        // Reorder according to the grid's actual display order
        var scenes = ids.map(function (id) { return byId[id]; }).filter(Boolean);
        state.scenes = scenes;
        scenes.forEach(function (scene) {
          if (!state.rows[scene.id])
            state.rows[scene.id] = { scene: scene, status: "idle", scraped: null, msg: "", markOrganized: 
            pluginConfig.autoMarkOrganized };
          else
            state.rows[scene.id].scene = scene;
        });
        buildAllRows();
        var pageInfo = getPageInfoFromDOM();
        state.currentPage = pageInfo ? pageInfo.page  : 1;
        state.totalPages  = pageInfo ? pageInfo.total : 1;
        updatePageNav();
        updateStatus("Ready — " + scenes.length + " scenes (page " + state.currentPage + "/" + state.totalPages + ")");
      });
    }).catch(function (err) {
      if (token !== _loadScenesToken) return;
      updateStatus("Loading error: " + err.message);
    });
  }

  // Same as loadScenes() but for a single scene fetched by ID instead of
  // reading the native grid - used by the scene-detail-page entry point
  // (see injectSceneButton() below), which has no grid to read from.
  function loadSingleScene(sceneID) {
    updateStatus("Loading scene...");
    return gql("FindScenesByIds", Q_FIND_BY_IDS, { ids: [String(sceneID)] }).then(function (d) {
      var scenes = ((d.findScenes || {}).scenes || []);
      state.scenes = scenes;
      scenes.forEach(function (scene) {
        if (!state.rows[scene.id])
          state.rows[scene.id] = { scene: scene, status: "idle", scraped: null, msg: "", markOrganized:
          pluginConfig.autoMarkOrganized };
        else
          state.rows[scene.id].scene = scene;
      });
      buildAllRows();
      state.currentPage = 1; state.totalPages = 1;
      updatePageNav();
      updateStatus(scenes.length ? "Ready" : "Scene not found");
    }).catch(function (err) {
      updateStatus("Loading error: " + err.message);
    });
  }

  // ── Build the panel ────────────────────────────────────────────────────────

  function buildPanel(scrapers) {
    var panel = document.createElement("div");
    panel.id = PANEL_ID;
    // An inline "display" style always wins over .st-compact { display:block }
    // or the base rule (display:flex) — only set the inline style to hide
    // (none), never for the visible state, so the CSS (flex in wide mode,
    // block in compact mode) stays in control. See imageTagger.js (buildPanel)
    // for the same already-documented pitfall.
    if (!state.visible) panel.style.display = "none";

    panel.className = pluginConfig.compactMode ? "st-compact" : "";

    panel.innerHTML =
      '<div id="st-titlebar">' +
        '<span id="st-titlebar-drag">&#9776; Scene Tagger</span>' +
        '<div id="st-titlebar-actions">' +
          '<button id="st-titlebar-compact" title="Compact mode">&#8644;&#xFE0E;</button>' +
          '<button id="st-titlebar-settings" title="Settings">&#9881;&#xFE0E;</button>' +
          '<button id="st-titlebar-close" title="Close">&#10005;</button>' +
        '</div>' +
      '</div>' +
      '<div id="st-settings-panel" style="display:none">' +
        '<div class="st-setting-group">' +
          '<div class="st-setting-section-title">Scraping</div>' +
          '<div class="st-setting-row st-scraper-chain-row">' +
            '<div class="st-blacklist-label">Scrapers (order = fallback priority)</div>' +
            '<div id="st-scraper-chain"></div>' +
          '</div>' +
          '<div class="st-setting-subtitle">Fallback behavior</div>' +
          '<div class="st-setting-row">' +
            '<label class="st-setting-label"><input type="checkbox" id="st-cfg-use-url"> Try scene\'s saved URL first</label>' +
          '</div>' +
          '<div class="st-setting-row">' +
            '<label class="st-setting-label"><input type="checkbox" id="st-cfg-manual-fallback"> Manual fill-in when scraping fails (studio/performers/tags/details)</label>' +
          '</div>' +
          '<div class="st-setting-row st-setting-row-sub">' +
            '<label class="st-setting-label"><input type="checkbox" id="st-cfg-manual-fallback-title"> Allow manual title</label>' +
          '</div>' +
        '</div>' +
        '<div class="st-setting-group">' +
          '<div class="st-setting-section-title">Checked by default</div>' +
          '<div class="st-setting-row">' +
            '<label class="st-setting-label"><input type="checkbox" id="st-cfg-studio"> Auto-check new studios</label>' +
          '</div>' +
          '<div class="st-setting-row">' +
            '<label class="st-setting-label"><input type="checkbox" id="st-cfg-prioritize-existing"> Prefer existing studio (multi-studio)</label>' +
          '</div>' +
          // Hidden in the public build: depends on the companion plugin
          // skExtra-Multiple-Studios-Custom, which isn't published. Uncomment
          // if that plugin is ever published separately.
          // '<div class="st-setting-row">' +
          //   '<label class="st-setting-label"><input type="checkbox" id="st-cfg-auto-other-studios"> Add the other artists (Artists:) as "Other studios" (skExtra-Multiple-Studios-Custom)</label>' +
          // '</div>' +
          '<div class="st-setting-row">' +
            '<label class="st-setting-label"><input type="checkbox" id="st-cfg-performer"> Auto-check new performers</label>' +
          '</div>' +
          '<div class="st-setting-row">' +
            '<label class="st-setting-label"><input type="checkbox" id="st-cfg-tags"> Auto-check new tags</label>' +
          '</div>' +
          '<div class="st-setting-row">' +
            '<label class="st-setting-label"><input type="checkbox" id="st-cfg-details"> Auto-check details</label>' +
          '</div>' +
        '</div>' +
        '<div class="st-setting-group">' +
          '<div class="st-setting-section-title">On apply</div>' +
          '<div class="st-setting-row">' +
            '<label class="st-setting-label"><input type="checkbox" id="st-cfg-mark-organized"> Auto-organize on Apply</label>' +
          '</div>' +
        '</div>' +
        '<div class="st-setting-group">' +
          '<div class="st-setting-section-title">Display</div>' +
          '<div class="st-setting-row">' +
            '<label class="st-setting-label"><input type="checkbox" id="st-cfg-native-hover"> Thumbnail hover preview</label>' +
          '</div>' +
          '<div class="st-setting-row st-setting-row-sub">' +
            '<label class="st-setting-label"><input type="checkbox" id="st-cfg-scrub-enable-grid"> Enable scrub controls - mass scrape panel</label>' +
          '</div>' +
          '<div class="st-setting-row st-setting-row-sub">' +
            '<label class="st-setting-label"><input type="checkbox" id="st-cfg-scrub-enable-solo"> Enable scrub controls - Scrape Scene popup</label>' +
          '</div>' +
          '<div class="st-setting-row st-setting-row-sub">' +
            '<label class="st-setting-label"><input type="checkbox" id="st-cfg-scrub-bar"> Show scrub progress bar</label>' +
          '</div>' +
          '<div class="st-setting-row st-setting-row-sub">' +
            '<label class="st-setting-label"><input type="checkbox" id="st-cfg-keyboard-seek"> Keyboard seek (arrow keys)</label>' +
          '</div>' +
          '<div class="st-setting-disclosure" id="st-scrub-adv-toggle">' +
            '<span class="st-setting-disclosure-chevron">&#9656;</span>' +
            '<span class="st-setting-disclosure-label">Advanced scrub settings (step %, acceleration...)</span>' +
          '</div>' +
          '<div class="st-setting-adv-box" id="st-scrub-adv-box" style="display:none">' +
            '<div class="st-setting-row-inline">' +
              '<label class="st-setting-label-inline">Scroll step %: ' +
                '<input type="number" id="st-cfg-scrub-slow" min="0" step="0.5" style="width:48px"> slow / ' +
                '<input type="number" id="st-cfg-scrub-normal" min="0" step="0.5" style="width:48px"> normal / ' +
                '<input type="number" id="st-cfg-scrub-fast" min="0" step="0.5" style="width:48px"> fast' +
              '</label>' +
            '</div>' +
            '<div class="st-setting-row-inline">' +
              '<label class="st-setting-label-inline">Max acceleration (x): <input type="number" id="st-cfg-scrub-max-mult" min="1" step="0.5" style="width:48px"></label>' +
            '</div>' +
            '<div class="st-setting-row-inline">' +
              '<label class="st-setting-label-inline">Keyboard seek step (s): <input type="number" id="st-cfg-keyboard-seek-step" min="1" step="1" style="width:48px"></label>' +
            '</div>' +
          '</div>' +
          '<div class="st-setting-row">' +
            '<label class="st-setting-label"><input type="checkbox" id="st-cfg-hide-scene-mode"> Hide Auto/Manual toggle on scene page</label>' +
          '</div>' +
          '<div class="st-setting-row">' +
            '<label class="st-setting-label"><input type="checkbox" id="st-cfg-hide-toolbar-btn"> Hide "ST" button in scene toolbar</label>' +
          '</div>' +
          '<div class="st-setting-row">' +
            '<label class="st-setting-label"><input type="checkbox" id="st-cfg-hide-edit-btn"> Hide "sceneTagger" button on scene Edit tab</label>' +
          '</div>' +
        '</div>' +
        '<div class="st-setting-row st-blacklist-row">' +
          '<div class="st-blacklist-label">Studio blacklist (VA)</div>' +
          '<div id="st-blacklist-chips"></div>' +
          '<div class="st-blacklist-input-wrap">' +
            '<input type="text" id="st-blacklist-input" placeholder="Add a name...">' +
            '<button class="st-btn st-btn-ghost" id="st-blacklist-add">+</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div id="st-panel-header">' +
        '<button class="st-btn st-btn-primary"  id="st-btn-scrape-all">Scrape All</button>' +
        '<button class="st-btn st-btn-success"  id="st-btn-apply-all" disabled>Apply All</button>' +
        '<button class="st-btn st-btn-danger"   id="st-btn-skip-all" disabled>Skip All</button>' +
        '<button class="st-btn st-btn-ghost"    id="st-btn-clear">Clear</button>' +
        '<button class="st-btn st-btn-ghost" id="st-btn-scraper-mode" title="Toggle between automatic fallback and manual choice">' +
          (pluginConfig.scraperMode === "manual" ? "Manual" : "Auto") +
        '</button>' +
        // Custom combobox instead of a native <select> - Firefox styles a
        // native select's popup from the element's own CSS, but Chrome
        // ignores it and shows its generic OS-themed dropdown regardless
        // (confirmed session 2026-09-13), so a plain <select> here looks
        // inconsistent across browsers. #st-scraper-select-manual is kept
        // as the wrapper's id so the Auto/Manual toggle's show/hide code
        // doesn't need to change.
        '<div class="st-combo" id="st-scraper-select-manual" style="display:' + (pluginConfig.scraperMode === "manual" ? "inline-flex" : "none") + '">' +
          '<button type="button" class="st-combo-btn" id="st-scraper-combo-btn" aria-haspopup="listbox" aria-expanded="false">' +
            esc((scrapers.filter(function (s) { return s.id === state.manualScraperID; })[0] || scrapers[0] || {}).name || "") +
          '</button>' +
          '<div class="st-combo-list" id="st-scraper-combo-list" role="listbox" style="display:none">' +
            scrapers.map(function (s) {
              return '<div class="st-combo-option' + (s.id === state.manualScraperID ? ' st-combo-option-selected' : '') + '" role="option" data-id="' + esc(s.id) + '" data-name="' + esc(s.name) + '">' + esc(s.name) + '</div>';
            }).join("") +
          '</div>' +
        '</div>' +
        '<div class="st-filter-radios">' +
          // Same custom combobox as the manual scraper picker above, for the
          // same reason (native <select> popups render inconsistently
          // between Chrome and Firefox) - its option list is rebuilt live
          // by renderScraperFilterOptions() as scraped results come in, so
          // unlike the manual one this one's options aren't fixed at
          // buildPanel() time.
          '<div class="st-combo" id="st-scraper-filter">' +
            '<button type="button" class="st-combo-btn st-scraper-filter-btn" id="st-scraper-filter-btn" aria-haspopup="listbox" aria-expanded="false" title="Filter by scraper">All scrapers</button>' +
            '<div class="st-combo-list" id="st-scraper-filter-list" role="listbox" style="display:none">' +
              '<div class="st-combo-option st-combo-option-selected" role="option" data-id="all">All scrapers</div>' +
            '</div>' +
          '</div>' +
          '<div class="st-filter-group">' +
            '<span class="st-filter-indicator"></span>' +
            '<label class="st-filter-item"><input type="radio" name="st-studio-filter" value="all" checked> All</label>' +
            '<label class="st-filter-item"><input type="radio" name="st-studio-filter" value="new"> New</label>' +
            '<label class="st-filter-item"><input type="radio" name="st-studio-filter" value="existing"> Existing</label>' +
          '</div>' +
          '<label class="st-multi-studio-toggle" title="Only scenes with multiple detected studio candidates">' +
            '<input type="checkbox" id="st-multi-studio-filter">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 16l8 4 8-4"/></svg>' +
            'Multi-studio' +
          '</label>' +
        '</div>' +
      '</div>' +
      '<div id="st-status-bar">' +
        '<span id="st-status-text">Waiting...</span>' +
        '<div id="st-progress-wrap"><div id="st-progress-bar"></div></div>' +
      '</div>' +
      '<div id="st-rows"></div>' +
      // Solo mode only (see CSS): once the single row is "done" (Applied),
      // #st-rows shrinks to its compact done-state content and leaves a
      // big empty area below it (the panel keeps its own height) - this
      // floating button re-scrapes without having to Reload the whole
      // panel. Hidden by default, shown/wired per-row in renderRow().
      '<button type="button" id="st-solo-refresh-btn" class="st-btn st-btn-ghost" title="Reload" style="display:none">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15">' +
        '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>' +
      '</button>' +
      '<div id="st-panel-footer">' +
        '<div id="st-resize-handle" title="Resize" style="display:' + (pluginConfig.compactMode ? 'none' : 'flex') + '">' +
          '<svg viewBox="0 0 9 9"><path d="M1 8 L8 1M1 5 L5 1M4 8 L8 4"/></svg>' +
        '</div>' +
        '<span id="st-page-info"></span>' +
        '<div class="st-page-nav">' +
          '<button class="st-btn st-btn-ghost" id="st-btn-page-prev" title="Previous page">&#8592;</button>' +
          '<span id="st-page-nav-label">1 / 1</span>' +
          '<button class="st-btn st-btn-ghost" id="st-btn-page-next" title="Next page">&#8594;</button>' +
        '</div>' +
        '<button class="st-btn st-btn-ghost" id="st-btn-reload">Reload</button>' +
      '</div>';

    return panel;
  }

  function attachPanelEvents() {
    renderScraperChain();

    // ── Hover preview (no companion plugin) ──────────────────────────────────
    // Delegated on #st-rows (attached once here, not per-row in renderRow)
    // since rows are rebuilt constantly - avoids piling up listeners.
    // Muted from the start so autoplay is never blocked by the browser.
    // data-preview-url (scene.paths.preview) is tried first when present -
    // cheap, just loop it from 0 - but Stash always returns a CONSTRUCTED
    // preview URL whether or not that clip actually exists on disk (a scene
    // with no generated preview still gets a URL, it just 404s/format-errors
    // when played - confirmed in session 2026-09-12, see the video 'error'
    // handler below). So data-stream-url (scene.paths.stream, the source
    // file itself, with data-preview-duration for the 10%-in seek) is the
    // fallback switched to on that error, not a second choice picked up
    // front from a truthiness check that can't actually tell the two cases
    // apart.
    var rowsEl = document.getElementById("st-rows");
    if (rowsEl) {
      // Firefox caps how many <video> decoders can be active at once (Chrome
      // is far more lenient) - just detaching the element with .remove() on
      // mouseout leaves its decoder tied up until GC gets around to it,
      // which isn't immediate. Scan/hover enough thumbnails in a row and the
      // pool fills up: every hover after that silently does nothing, even
      // on thumbnails that worked moments ago (confirmed session
      // 2026-09-13). Explicitly pausing + clearing the source + calling
      // load() releases the decoder immediately instead of waiting on GC.
      function releasePreviewVideo(video) {
        if (video._scrubCleanup) video._scrubCleanup();
        video.pause();
        video.removeAttribute("src");
        video.load();
        video.remove();
      }

      // ── Scrub controls (scroll to seek / arrow keys / progress bar) ────────
      // Step is a PERCENTAGE of the video's own duration rather than a fixed
      // number of seconds - a fixed step (e.g. fasttag's 10s "fast") blows
      // through a 15s clip in two scrolls while barely moving a 20-minute
      // one. A light, capped acceleration is layered on top so holding the
      // same scroll direction can still cross the whole video quickly, but
      // it resets the instant the direction changes or scrolling pauses, so
      // precision comes back immediately when hunting for a performer.
      function createScrubBar(clip) {
        var bar = document.createElement("div");
        bar.className = "st-thumb-scrub-bar";
        var fill = document.createElement("div");
        fill.className = "st-thumb-scrub-bar-fill";
        bar.appendChild(fill);
        clip.appendChild(bar);
        return bar;
      }

      function updateScrubBar(bar, video) {
        if (!bar || !video.duration || !isFinite(video.duration)) return;
        var pct = Math.min(100, Math.max(0, (video.currentTime / video.duration) * 100));
        bar.firstChild.style.width = pct + "%";
      }

      function attachScrubControls(clip, video) {
        var isSoloPanel = !!clip.closest(".st-panel-solo");
        var enabled = isSoloPanel ? pluginConfig.enableScrubControlsSolo : pluginConfig.enableScrubControlsGrid;
        if (!enabled) return;

        var bar = pluginConfig.scrubBarVisible ? createScrubBar(clip) : null;
        var velocity = 1;
        var lastWheelTime = 0;
        var lastDirection = 0;
        var shiftHeld = false;
        var wasPlaying = false;
        var resumeTimer = null;

        function pickBasePct(dtMs) {
          if (dtMs < 80) return pluginConfig.scrubStepFast || 6;
          if (dtMs < 200) return pluginConfig.scrubStepNormal || 3;
          return pluginConfig.scrubStepSlow || 1;
        }

        function seekBy(deltaSeconds) {
          if (!video.duration || !isFinite(video.duration)) return;
          if (!video.paused) { wasPlaying = true; video.pause(); }
          video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + deltaSeconds));
          updateScrubBar(bar, video);
        }

        function onWheel(e) {
          if (!video.duration || !isFinite(video.duration)) return;
          var rawDelta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
          if (!rawDelta) return;
          e.preventDefault();
          e.stopPropagation();

          var direction = rawDelta > 0 ? 1 : -1;
          var now = performance.now();
          var dt = lastWheelTime ? (now - lastWheelTime) : 999;
          var maxMult = pluginConfig.scrubMaxVelocityMultiplier || 3;
          if (dt > 450 || direction !== lastDirection) {
            velocity = 1;
          } else {
            velocity = Math.min(maxMult, velocity + 0.35);
          }
          lastDirection = direction;
          lastWheelTime = now;

          var basePct = pickBasePct(dt) / 100;
          seekBy(video.duration * basePct * velocity * direction);

          clearTimeout(resumeTimer);
          if (!shiftHeld) {
            resumeTimer = setTimeout(function () {
              if (wasPlaying) video.play().catch(function () {});
              wasPlaying = false;
            }, 300);
          }
        }

        function onKeyDown(e) {
          if (e.key === "Shift") { shiftHeld = true; return; }
          if (!pluginConfig.enableKeyboardSeek) return;
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          var step = pluginConfig.keyboardSeekStep || 5;
          seekBy(e.key === "ArrowRight" ? step : -step);
          if (video.paused && wasPlaying) {
            clearTimeout(resumeTimer);
            resumeTimer = setTimeout(function () { video.play().catch(function () {}); wasPlaying = false; }, 300);
          }
        }
        function onKeyUp(e) { if (e.key === "Shift") shiftHeld = false; }

        clip.addEventListener("wheel", onWheel, { passive: false });
        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("keyup", onKeyUp);
        video.addEventListener("timeupdate", function () { updateScrubBar(bar, video); });

        video._scrubCleanup = function () {
          clip.removeEventListener("wheel", onWheel);
          document.removeEventListener("keydown", onKeyDown);
          document.removeEventListener("keyup", onKeyUp);
          clearTimeout(resumeTimer);
          if (bar) bar.remove();
        };
      }
      // Applies either seek-and-loop-from-10% (source stream, duration
      // known) or plain loop-from-0 (generated preview clip, already short)
      // to a <video> depending on whether a usable duration was passed.
      function playPreviewFrom(video, duration) {
        var startAt = duration > 1 ? duration * 0.10 : 0;
        video.currentTime = 0;
        // Clear any stale seek/loop listeners from a previous attempt on
        // this same <video> (the preview→stream fallback reuses the
        // element rather than creating a new one).
        video.loop = false;
        video.onloadedmetadata = null;
        video.ontimeupdate = null;
        if (startAt > 0) {
          // Loop from the 10%-in point rather than 0s (often a black/title
          // frame on these sources) - native `video.loop` always restarts
          // at 0, so the loop-back is done by hand via timeupdate instead.
          video.onloadedmetadata = function () { video.currentTime = startAt; };
          video.ontimeupdate = function () {
            if (video.duration && video.currentTime >= video.duration - 0.2) {
              video.currentTime = startAt;
            }
          };
        } else {
          video.loop = true;
        }
        video.play().catch(function () {});
      }

      rowsEl.addEventListener("mouseover", function (e) {
        if (!pluginConfig.nativeHoverPreview) return;
        var clip = e.target.closest(".st-thumb-clip");
        if (!clip || (e.relatedTarget && clip.contains(e.relatedTarget))) return;
        var previewUrl = clip.getAttribute("data-preview-url");
        var streamUrl  = clip.getAttribute("data-stream-url");
        var duration   = parseFloat(clip.getAttribute("data-preview-duration")) || 0;
        var url = previewUrl || streamUrl;
        if (!url || clip.querySelector(".st-thumb-preview-video")) return;
        var video = document.createElement("video");
        video.className = "st-thumb-preview-video";
        video.muted = true;
        video.playsInline = true;
        video.preload = "metadata";
        // Attached to the DOM BEFORE src/play() - calling play() on a
        // detached element is unreliable across browsers (the media
        // pipeline doesn't fully engage until it's actually in the tree),
        // which is what made this flaky before: it happened to work often
        // enough to look like it "sometimes" worked. Wire the fallback
        // listener before setting src either way, so a same-tick error
        // can't be missed.
        clip.appendChild(video);
        if (previewUrl) {
          // Falls back to the source stream exactly once if the "generated
          // preview" turns out not to actually exist (see comment above).
          video.addEventListener("error", function onPreviewError() {
            video.removeEventListener("error", onPreviewError);
            if (!streamUrl) return;
            video.src = streamUrl;
            playPreviewFrom(video, duration);
          }, { once: true });
          video.src = previewUrl;
          playPreviewFrom(video, 0);
        } else {
          video.src = streamUrl;
          playPreviewFrom(video, duration);
        }
        attachScrubControls(clip, video);
      });
      rowsEl.addEventListener("mouseout", function (e) {
        var clip = e.target.closest(".st-thumb-clip");
        if (!clip || (e.relatedTarget && clip.contains(e.relatedTarget))) return;
        var video = clip.querySelector(".st-thumb-preview-video");
        if (video) releasePreviewVideo(video);
      });
    }

    // ── Manual / auto mode ──────────────────────────────────────────────────
    var modeBtn = document.getElementById("st-btn-scraper-mode");
    var manualSelect = document.getElementById("st-scraper-select-manual"); // wrapper div, see buildPanel()
    var comboBtn  = document.getElementById("st-scraper-combo-btn");
    var comboList = document.getElementById("st-scraper-combo-list");
    var comboOptions = comboList ? Array.from(comboList.querySelectorAll(".st-combo-option")) : [];
    if (comboOptions.length && !state.manualScraperID) {
      state.manualScraperID = comboOptions[0].getAttribute("data-id");
    }
    if (modeBtn) {
      modeBtn.addEventListener("click", function () {
        pluginConfig.scraperMode = pluginConfig.scraperMode === "manual" ? "auto" : "manual";
        savePluginConfig();
        modeBtn.textContent = pluginConfig.scraperMode === "manual" ? "Manual" : "Auto";
        if (manualSelect) manualSelect.style.display = pluginConfig.scraperMode === "manual" ? "inline-flex" : "none";
      });
    }
    // Custom combobox: replaces the native <select> so its dropdown looks
    // the same on every browser (see the comment in buildPanel()) - a
    // minimal but real listbox pattern (click, Enter/Space/arrows/Escape,
    // click-outside-to-close), not just a styled click target.
    if (comboBtn && comboList && comboOptions.length) {
      var comboHighlight = -1;
      function comboSetHighlight(idx) {
        comboOptions.forEach(function (o) { o.classList.remove("st-combo-option-active"); });
        comboHighlight = Math.max(0, Math.min(comboOptions.length - 1, idx));
        var opt = comboOptions[comboHighlight];
        opt.classList.add("st-combo-option-active");
        opt.scrollIntoView({ block: "nearest" });
      }
      function comboOpen() {
        comboList.style.display = "block";
        comboBtn.setAttribute("aria-expanded", "true");
        var selIdx = comboOptions.findIndex(function (o) { return o.getAttribute("data-id") === state.manualScraperID; });
        comboSetHighlight(selIdx >= 0 ? selIdx : 0);
      }
      function comboClose() {
        comboList.style.display = "none";
        comboBtn.setAttribute("aria-expanded", "false");
      }
      function comboSelect(opt) {
        state.manualScraperID = opt.getAttribute("data-id");
        comboBtn.textContent = opt.getAttribute("data-name");
        comboOptions.forEach(function (o) { o.classList.toggle("st-combo-option-selected", o === opt); });
        comboClose();
        comboBtn.focus();
      }
      comboBtn.addEventListener("click", function () {
        comboList.style.display === "block" ? comboClose() : comboOpen();
      });
      comboBtn.addEventListener("keydown", function (e) {
        if (comboList.style.display !== "block") {
          if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            comboOpen();
          }
          return;
        }
        if (e.key === "ArrowDown") { e.preventDefault(); comboSetHighlight(comboHighlight + 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); comboSetHighlight(comboHighlight - 1); }
        else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); comboSelect(comboOptions[comboHighlight]); }
        else if (e.key === "Escape") { e.preventDefault(); comboClose(); comboBtn.focus(); }
      });
      comboList.addEventListener("click", function (e) {
        var opt = e.target.closest(".st-combo-option");
        if (opt) comboSelect(opt);
      });
      // Mouse and keyboard share the single "active" highlight instead of
      // each having their own (hover via :hover, keyboard via a class) -
      // moving the mouse over an option updates the same index arrow keys
      // use, so only one row is ever highlighted at a time.
      comboList.addEventListener("mousemove", function (e) {
        var opt = e.target.closest(".st-combo-option");
        if (!opt) return;
        var idx = comboOptions.indexOf(opt);
        if (idx !== -1 && idx !== comboHighlight) comboSetHighlight(idx);
      });
      document.addEventListener("click", function (e) {
        if (comboList.style.display === "block" && !manualSelect.contains(e.target)) comboClose();
      });
    }

    document.getElementById("st-btn-scrape-all").addEventListener("click", function () { if (!state.running) scrapeAll(); });
    document.getElementById("st-btn-apply-all").addEventListener("click", applyAll);
    document.getElementById("st-btn-skip-all").addEventListener("click", skipAll);
    document.getElementById("st-btn-clear").addEventListener("click", function () {
      state.scenes.forEach(function (scene) {
        var r = state.rows[scene.id];
        if (r && r.status !== "done") { r.status = "idle"; r.scraped = null; r.msg = ""; }
      });
      buildAllRows(); renderScraperFilterOptions(); updateStatus("Results cleared");
    });
    document.getElementById("st-btn-reload").addEventListener("click", function () {
      try { sessionStorage.setItem(REOPEN_FLAG, "1"); } catch (e) {}
      window.location.reload();
    });

    var prevBtn = document.getElementById("st-btn-page-prev");
    var nextBtn = document.getElementById("st-btn-page-next");
    if (prevBtn) prevBtn.addEventListener("click", function () { goToPage(state.currentPage - 1); });
    if (nextBtn) nextBtn.addEventListener("click", function () { goToPage(state.currentPage + 1); });
    updatePageNav();

    var closeBtn = document.getElementById("st-titlebar-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        state.visible = false;
        var panel = document.getElementById(PANEL_ID);
        if (panel) panel.style.display = "none";
        var btn = document.getElementById(BTN_ID);
        if (btn) { btn.textContent = "Scene Tagger"; btn.style.color = ""; btn.style.border = ""; }
      });
    }

    // Compact mode button - meaningless in solo mode (a single scene is
    // already "compact") and actively destructive there: it used to
    // overwrite panelEl.className wholesale, silently stripping the
    // "st-panel-solo" class and reverting the docked single-scene panel
    // back into the full-width mass-scrape layout mid-session (confirmed
    // session 2026-09-16, screenshot showed the "Scrape All/Apply All/..."
    // header reappearing and the content overflowing past the panel once
    // solo's own max-height rules no longer applied). Hidden entirely
    // instead of trying to make toggling behave in solo - there's nothing
    // useful for it to toggle between there.
    var compactBtn = document.getElementById("st-titlebar-compact");
    if (compactBtn) {
      // Solo mode isn't applied yet at this point (attachPanelEvents() runs
      // right after building the panel, before openPanelForScene() adds the
      // "st-panel-solo" class) - hiding this button for solo is done there
      // instead, right after that class is added.
      if (pluginConfig.compactMode) compactBtn.style.color = "rgba(var(--accent-rgb,94,129,172),1)";
      compactBtn.addEventListener("click", function () {
        if (document.getElementById(PANEL_ID).classList.contains("st-panel-solo")) return;
        pluginConfig.compactMode = !pluginConfig.compactMode;
        savePluginConfig();
        var panelEl = document.getElementById(PANEL_ID);
        if (panelEl) {
          panelEl.className = pluginConfig.compactMode ? "st-compact" : "";
          // Clear the inline styles set by manual drag/resize, otherwise
          // they override the position/size defined by the CSS class.
          panelEl.style.top = "";
          panelEl.style.left = "";
          panelEl.style.right = "";
          panelEl.style.bottom = "";
          panelEl.style.width = "";
          panelEl.style.height = "";
          panelEl.style.transform = "";
          panelEl.style.borderRadius = "";
        }
        compactBtn.style.color = pluginConfig.compactMode ? "rgba(var(--accent-rgb,94,129,172),1)" : "";
        var handle = document.getElementById("st-resize-handle");
        if (handle) handle.style.display = pluginConfig.compactMode ? "none" : "flex";
        // Compact mode shrinks the filter labels' font-size, so the sliding
        // indicator needs to be recomputed once the new layout has settled.
        setTimeout(updateFilterIndicator, 0);
      });
    }

    var settingsBtn   = document.getElementById("st-titlebar-settings");
    var settingsPanel = document.getElementById("st-settings-panel");
    if (settingsBtn && settingsPanel) {
      settingsBtn.addEventListener("click", function () {
        var visible = settingsPanel.style.display !== "none";
        settingsPanel.style.display = visible ? "none" : "block";
        settingsBtn.style.color = visible ? "" : "rgba(var(--accent-rgb,94,129,172),1)";
      });
    }

    function bindSettingCb(elId, key) {
      var el = document.getElementById(elId);
      if (!el) return;
      el.checked = !!pluginConfig[key];
      el.addEventListener("change", function () {
        pluginConfig[key] = el.checked;
        savePluginConfig();
      });
    }
    bindSettingCb("st-cfg-studio",              "autoCheckStudio");
    bindSettingCb("st-cfg-prioritize-existing", "prioritizeExistingStudio");
    bindSettingCb("st-cfg-use-url",             "useUrlIfPresent");
    // bindSettingCb("st-cfg-auto-other-studios", "autoAddOtherStudios"); // row hidden, see buildPanel()
    bindSettingCb("st-cfg-performer",           "autoCheckPerformer");
    bindSettingCb("st-cfg-tags",                "autoCheckNewTags");
    bindSettingCb("st-cfg-details",             "autoCheckDetails");
    bindSettingCb("st-cfg-mark-organized",      "autoMarkOrganized");
    bindSettingCb("st-cfg-manual-fallback",       "manualFallbackOnFail");
    bindSettingCb("st-cfg-manual-fallback-title", "manualFallbackAllowTitle");
    bindSettingCb("st-cfg-scrub-bar",             "scrubBarVisible");
    bindSettingCb("st-cfg-keyboard-seek",         "enableKeyboardSeek");

    function bindSettingNum(elId, key, defVal, minVal) {
      var el = document.getElementById(elId);
      if (!el) return;
      el.value = typeof pluginConfig[key] === "number" ? pluginConfig[key] : defVal;
      el.addEventListener("change", function () {
        var v = parseFloat(el.value);
        if (!isFinite(v) || v < minVal) v = defVal;
        pluginConfig[key] = v;
        el.value = v;
        savePluginConfig();
      });
    }
    bindSettingNum("st-cfg-scrub-slow",          "scrubStepSlow", 1, 0);
    bindSettingNum("st-cfg-scrub-normal",        "scrubStepNormal", 3, 0);
    bindSettingNum("st-cfg-scrub-fast",          "scrubStepFast", 6, 0);
    bindSettingNum("st-cfg-scrub-max-mult",      "scrubMaxVelocityMultiplier", 3, 1);
    bindSettingNum("st-cfg-keyboard-seek-step",  "keyboardSeekStep", 5, 1);

    // Advanced scrub settings stay collapsed by default (nothing persisted -
    // it's a rarely-touched sub-block, not worth remembering across
    // sessions) so the Display section doesn't get visually heavy with 5
    // numeric fields on every open.
    (function () {
      var toggle = document.getElementById("st-scrub-adv-toggle");
      var box = document.getElementById("st-scrub-adv-box");
      if (!toggle || !box) return;
      toggle.addEventListener("click", function () {
        var expanded = box.style.display !== "none";
        box.style.display = expanded ? "none" : "block";
        toggle.classList.toggle("st-setting-disclosure-open", !expanded);
      });
    })();
    // Not a plain bindSettingCb: data-preview-url/-duration are baked into
    // .st-thumb-clip's HTML at renderRow() time, based on nativeHoverPreview's
    // value at that moment - toggling the checkbox alone doesn't retroactively
    // add/remove that attribute on thumbnails already on screen, so hovering
    // silently does nothing until the rows are rebuilt.
    (function () {
      var nativeHoverEl = document.getElementById("st-cfg-native-hover");
      if (!nativeHoverEl) return;
      nativeHoverEl.checked = !!pluginConfig.nativeHoverPreview;
      nativeHoverEl.addEventListener("change", function () {
        pluginConfig.nativeHoverPreview = nativeHoverEl.checked;
        savePluginConfig();
        buildAllRows();
      });
    })();
    bindSettingCb("st-cfg-scrub-enable-grid", "enableScrubControlsGrid");
    bindSettingCb("st-cfg-scrub-enable-solo", "enableScrubControlsSolo");

    // Hide Auto/Manual toggle (scene page only) - takes effect immediately
    // via a class on #st-panel rather than needing a rebuild, since the
    // toggle itself lives in the (still-mounted, just CSS-hidden) header.
    (function () {
      var hideModeEl = document.getElementById("st-cfg-hide-scene-mode");
      if (!hideModeEl) return;
      hideModeEl.checked = !!pluginConfig.hideSceneModeToggle;
      hideModeEl.addEventListener("change", function () {
        pluginConfig.hideSceneModeToggle = hideModeEl.checked;
        savePluginConfig();
        var panelEl = document.getElementById(PANEL_ID);
        if (panelEl) panelEl.classList.toggle("st-hide-scene-mode-toggle", pluginConfig.hideSceneModeToggle);
      });
    })();

    // Hide the "ST" scene-toolbar button - takes effect immediately by
    // removing/re-injecting it, no rebuild needed (it lives outside the
    // panel entirely, see injectToolbarButton()).
    (function () {
      var hideToolbarBtnEl = document.getElementById("st-cfg-hide-toolbar-btn");
      if (!hideToolbarBtnEl) return;
      hideToolbarBtnEl.checked = !!pluginConfig.hideToolbarButton;
      hideToolbarBtnEl.addEventListener("change", function () {
        pluginConfig.hideToolbarButton = hideToolbarBtnEl.checked;
        savePluginConfig();
        if (pluginConfig.hideToolbarButton) {
          var existingToolbarGroup = document.getElementById(TOOLBAR_BTN_GROUP_ID);
          if (existingToolbarGroup) existingToolbarGroup.remove();
        } else {
          injectToolbarButton();
        }
      });
    })();

    // Hide the "sceneTagger" button on the scene Edit tab (next to "Scrape
    // with...") - same immediate remove/re-inject pattern, no rebuild.
    (function () {
      var hideEditBtnEl = document.getElementById("st-cfg-hide-edit-btn");
      if (!hideEditBtnEl) return;
      hideEditBtnEl.checked = !!pluginConfig.hideEditButton;
      hideEditBtnEl.addEventListener("change", function () {
        pluginConfig.hideEditButton = hideEditBtnEl.checked;
        savePluginConfig();
        if (pluginConfig.hideEditButton) {
          var existingSceneBtn = document.getElementById(SCENE_BTN_ID);
          if (existingSceneBtn) existingSceneBtn.remove();
        } else {
          injectSceneButton();
        }
      });
    })();

    // ── Live studio filter ───────────────────────────────────────────────────
    // Sliding pill behind the checked All/New/Existing label, repositioned
    // to the checked item's own width/offset (labels aren't equal width) —
    // pure CSS can't animate this since :has(input:checked) only recolors
    // the item in place, it can't slide a shared background between
    // siblings of different sizes.
    function updateFilterIndicator() {
      var group = document.querySelector(".st-filter-group");
      var indicator = document.querySelector(".st-filter-indicator");
      var checked = document.querySelector('input[name="st-studio-filter"]:checked');
      if (!group || !indicator || !checked) return;
      var label = checked.closest(".st-filter-item");
      if (!label) return;
      var groupRect = group.getBoundingClientRect();
      var labelRect = label.getBoundingClientRect();
      indicator.style.width = labelRect.width + "px";
      indicator.style.left = (labelRect.left - groupRect.left) + "px";
    }

    document.querySelectorAll('input[name="st-studio-filter"]').forEach(function(radio) {
      // Sync initial state
      if (radio.value === state.studioFilter) radio.checked = true;
      radio.addEventListener("change", function() {
        if (radio.checked) {
          state.studioFilter = radio.value;
          applyStudioFilter();
          updateFilterIndicator();
        }
      });
    });
    // Position on first render (after layout so widths are known) and once
    // more shortly after (panel/compact-mode transitions can still be
    // animating their own width at this point).
    setTimeout(updateFilterIndicator, 0);
    setTimeout(updateFilterIndicator, 300);

    // Cumulative "Multi-studio" checkbox: ANDs with All/New/Existing rather
    // than joining that radio group, so both filters can apply together.
    var multiStudioCb = document.getElementById("st-multi-studio-filter");
    if (multiStudioCb) {
      multiStudioCb.checked = state.multiStudioOnly;
      multiStudioCb.addEventListener("change", function() {
        state.multiStudioOnly = multiStudioCb.checked;
        applyStudioFilter();
      });
    }

    // Drag-to-switch: press down anywhere in the segmented control and
    // slide across to another option without releasing, like a physical
    // toggle switch, instead of only supporting a plain click per option.
    var filterGroup = document.querySelector(".st-filter-group");
    if (filterGroup) {
      var filterDragging = false;
      function selectFilterAt(clientX, clientY) {
        var el = document.elementFromPoint(clientX, clientY);
        var item = el && el.closest && el.closest(".st-filter-item");
        if (!item || !filterGroup.contains(item)) return;
        var radio = item.querySelector('input[name="st-studio-filter"]');
        if (!radio || radio.checked) return;
        radio.checked = true;
        radio.dispatchEvent(new Event("change", { bubbles: true }));
      }
      filterGroup.addEventListener("mousedown", function (e) {
        filterDragging = true;
        selectFilterAt(e.clientX, e.clientY);
      });
      document.addEventListener("mousemove", function (e) {
        if (!filterDragging) return;
        selectFilterAt(e.clientX, e.clientY);
      });
      document.addEventListener("mouseup", function () { filterDragging = false; });
    }

    // Same click/keyboard/mousemove combobox behavior as the manual scraper
    // picker above, but re-querying .st-combo-option elements live on every
    // call instead of caching them once - this list's content is rebuilt by
    // renderScraperFilterOptions() as new scrapers get matched during
    // scraping, unlike the manual picker's fixed option set.
    var scraperFilterWrap = document.getElementById("st-scraper-filter");
    var filterBtn  = document.getElementById("st-scraper-filter-btn");
    var filterList = document.getElementById("st-scraper-filter-list");
    if (scraperFilterWrap && filterBtn && filterList) {
      renderScraperFilterOptions();
      var filterHighlight = -1;
      function filterOptions() { return Array.from(filterList.querySelectorAll(".st-combo-option")); }
      function filterSetHighlight(idx) {
        var opts = filterOptions();
        if (!opts.length) return;
        opts.forEach(function (o) { o.classList.remove("st-combo-option-active"); });
        filterHighlight = Math.max(0, Math.min(opts.length - 1, idx));
        var opt = opts[filterHighlight];
        opt.classList.add("st-combo-option-active");
        opt.scrollIntoView({ block: "nearest" });
      }
      function filterOpen() {
        filterList.style.display = "block";
        filterBtn.setAttribute("aria-expanded", "true");
        var opts = filterOptions();
        var selIdx = opts.findIndex(function (o) { return o.getAttribute("data-id") === state.scraperFilter; });
        filterSetHighlight(selIdx >= 0 ? selIdx : 0);
      }
      function filterCloseList() {
        filterList.style.display = "none";
        filterBtn.setAttribute("aria-expanded", "false");
      }
      function filterSelect(opt) {
        state.scraperFilter = opt.getAttribute("data-id");
        filterBtn.textContent = opt.getAttribute("data-name");
        filterOptions().forEach(function (o) { o.classList.toggle("st-combo-option-selected", o === opt); });
        filterCloseList();
        filterBtn.focus();
        applyStudioFilter();
      }
      filterBtn.addEventListener("click", function () {
        filterList.style.display === "block" ? filterCloseList() : filterOpen();
      });
      filterBtn.addEventListener("keydown", function (e) {
        if (filterList.style.display !== "block") {
          if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            filterOpen();
          }
          return;
        }
        var opts = filterOptions();
        if (e.key === "ArrowDown") { e.preventDefault(); filterSetHighlight(filterHighlight + 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); filterSetHighlight(filterHighlight - 1); }
        else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (opts[filterHighlight]) filterSelect(opts[filterHighlight]); }
        else if (e.key === "Escape") { e.preventDefault(); filterCloseList(); filterBtn.focus(); }
      });
      filterList.addEventListener("click", function (e) {
        var opt = e.target.closest(".st-combo-option");
        if (opt) filterSelect(opt);
      });
      filterList.addEventListener("mousemove", function (e) {
        var opt = e.target.closest(".st-combo-option");
        if (!opt) return;
        var idx = filterOptions().indexOf(opt);
        if (idx !== -1 && idx !== filterHighlight) filterSetHighlight(idx);
      });
      document.addEventListener("click", function (e) {
        if (filterList.style.display === "block" && !scraperFilterWrap.contains(e.target)) filterCloseList();
      });
    }

    // ── Studio blacklist ─────────────────────────────────────────────────────
    function renderBlacklistChips() {
      var container = document.getElementById("st-blacklist-chips");
      if (!container) return;
      container.innerHTML = pluginConfig.studioBlacklist.map(function (name) {
        return '<span class="st-blacklist-chip">' +
          esc(name) +
          '<button class="st-blacklist-remove" data-name="' + esc(name) + '" title="Remove">&#10005;</button>' +
        '</span>';
      }).join("");
      container.querySelectorAll('.st-blacklist-remove').forEach(function (btn) {
        btn.addEventListener("click", function () {
          var n = btn.getAttribute("data-name");
          pluginConfig.studioBlacklist = pluginConfig.studioBlacklist.filter(function(s){ return s !== n; });
          savePluginConfig();
          backupBlacklist();
          renderBlacklistChips();
        });
      });
    }

    function addToBlacklist(name) {
      var n = name.trim().toLowerCase();
      if (!n) return;
      if (pluginConfig.studioBlacklist.indexOf(n) !== -1) return;
      pluginConfig.studioBlacklist.push(n);
      savePluginConfig();
      backupBlacklist();
      renderBlacklistChips();
    }

    var blInput = document.getElementById("st-blacklist-input");
    var blAdd   = document.getElementById("st-blacklist-add");
    if (blInput && blAdd) {
      blAdd.addEventListener("click", function () { addToBlacklist(blInput.value); blInput.value = ""; });
      blInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { addToBlacklist(blInput.value); blInput.value = ""; }
      });
    }
    renderBlacklistChips();

    renderBlacklistChips();
    document.addEventListener("st-blacklist-updated", renderBlacklistChips);

    var titlebar = document.getElementById("st-titlebar-drag");
    var panel    = document.getElementById(PANEL_ID);
    if (titlebar && panel) {
      var dragging = false, startX, startY, origLeft, origTop;
      titlebar.addEventListener("mousedown", function (e) {
        dragging = true;
        startX = e.clientX; startY = e.clientY;
        var rect = panel.getBoundingClientRect();
        origLeft = rect.left; origTop = rect.top;
        // Convert from the docked top/left/right/bottom layout to a
        // floating position pinned by left/top/width/height alone —
        // `bottom` must be cleared too, otherwise the panel keeps stretching
        // to the viewport's bottom edge (12px above it) while only top/left
        // move, distorting its height as it's dragged.
        panel.style.left      = origLeft + "px";
        panel.style.top       = origTop + "px";
        panel.style.right     = "auto";
        panel.style.bottom    = "auto";
        panel.style.width     = rect.width + "px";
        panel.style.height    = rect.height + "px";
        panel.style.transform = "none";
        panel.style.borderRadius = "14px";
        e.preventDefault();
      });
      document.addEventListener("mousemove", function (e) {
        if (!dragging) return;
        panel.style.left = Math.max(0, origLeft + (e.clientX - startX)) + "px";
        panel.style.top  = Math.max(0, origTop  + (e.clientY - startY)) + "px";
      });
      document.addEventListener("mouseup", function () { dragging = false; });
    }

    // ── Custom resize (bottom-left corner), active only outside compact
    // mode (compact mode uses the native CSS resize:horizontal, like
    // imageTagger in compact mode) ────────────────────────────────────────
    var resizeHandle = document.getElementById("st-resize-handle");
    if (resizeHandle && panel) {
      var resizing = false, resStartX, resStartW, resStartLeft;
      resizeHandle.addEventListener("mousedown", function (e) {
        if (pluginConfig.compactMode) return;
        resizing = true;
        resStartX    = e.clientX;
        var rect     = panel.getBoundingClientRect();
        resStartW    = rect.width;
        resStartLeft = rect.left;
        // Convert to an absolute left so resize works in both directions
        panel.style.left   = resStartLeft + "px";
        panel.style.right  = "auto";
        e.preventDefault();
        e.stopPropagation();
      });
      document.addEventListener("mousemove", function (e) {
        if (!resizing) return;
        // Dragging left = enlarge (left edge moves, right edge fixed)
        var dx  = resStartX - e.clientX;
        var nw  = Math.min(Math.max(resStartW + dx, 400), window.innerWidth * 0.95);
        var nl  = resStartLeft + resStartW - nw;
        panel.style.width = nw + "px";
        panel.style.left  = Math.max(0, nl) + "px";
      });
      document.addEventListener("mouseup", function () { resizing = false; });
    }
  }

  // ── Toggle button ──────────────────────────────────────────────────────────

  function injectToggleBtn() {
    if (document.getElementById(BTN_ID)) return;
    var toolbar =
      document.querySelector(".filtered-list-toolbar.btn-toolbar") ||
      document.querySelector(".filtered-list-toolbar") ||
      document.querySelector(".btn-toolbar");
    if (!toolbar) return;

    var btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.className = "btn btn-secondary";
    btn.style.cssText = "margin-left:8px;font-size:12px;padding:4px 10px;white-space:nowrap;";
    btn.textContent = state.visible ? "Scene Tagger [ON]" : "Scene Tagger";
    if (state.visible) { btn.style.color = "#88c0d0"; btn.style.border = "1px solid #88c0d0"; }

    btn.addEventListener("click", function () {
      state.visible = !state.visible;
      var panel = document.getElementById(PANEL_ID);
      if (panel) {
        // Only set the inline "display" to hide (none) — leave it empty
        // otherwise so the CSS (flex in wide mode, block in compact mode)
        // stays in control (same pitfall as in buildPanel(), see comment).
        panel.style.display = state.visible ? "" : "none";
        if (state.visible && state.scenes.length === 0) loadScenes();
      }
      btn.textContent  = state.visible ? "Scene Tagger [ON]" : "Scene Tagger";
      btn.style.color  = state.visible ? "#88c0d0" : "";
      btn.style.border = state.visible ? "1px solid #88c0d0" : "";
    });
    toolbar.appendChild(btn);
  }

  // ── Injection ──────────────────────────────────────────────────────────────

  // Pages where the panel makes sense: the /scenes list (not a single scene
  // page) AND the "Scenes" tab of a studio page (/studios/<id>) -
  // loadScenes() reads scene cards directly from the DOM
  // (getVisibleSceneIdsInOrder), so it works unchanged on any page showing
  // a scene grid, not just /scenes. Same toolbar selector as on /scenes
  // (.filtered-list-toolbar.btn-toolbar) - same pattern already used and
  // validated in production by studioBulkDelete.js on this page (its "Bulk
  // delete" button sits right next to this one).
  function pageQualifiesForPanel(pathname) {
    if (pathname.startsWith("/scenes") && !pathname.match(/^\/scenes\/\d+/)) return true;
    if (pathname.match(/^\/studios\/\d+/)) return true;
    return false;
  }

  var _injectedPath = "";

  function setup() {
    var pathname = window.location.pathname;
    // Include the query string (filters): pathname alone stays "/scenes"
    // regardless of the active filter, so a filter change without a path
    // change would go unnoticed and keep the old list (state.scenes).
    var path = pathname + window.location.search;
    if (!pageQualifiesForPanel(pathname)) {
      ["st-panel", "st-toggle-btn"].forEach(function (id) {
        var el = document.getElementById(id); if (el) el.remove();
      });
      _injectedPath = ""; return;
    }
    if (_injectedPath === path && document.getElementById(PANEL_ID)) return;

    // The panel and button already exist (just a filter/sort/page change
    // on /scenes, not an actual navigation away from the page): refresh
    // the list IN PLACE rather than closing/reopening the whole panel.
    // Before this fix, every filter/page change destroyed and rebuilt
    // st-panel/st-toggle-btn entirely (visible as the panel disappearing/
    // reappearing) - same bug fixed on studioBulkDelete.js (see the
    // project's CLAUDE.md).
    // loadScenes() already handles fetching the new list AND merging it
    // with the existing state.rows (a scene already scraped keeps its
    // result if it's still present in the new page/filter), so there's no
    // need to clear state.rows here - only state.scenes, to force
    // loadScenes() to start over with a fresh list.
    if (_injectedPath !== "" && document.getElementById(PANEL_ID) && document.getElementById(BTN_ID)) {
      _injectedPath = path;
      state.scenes = [];
      if (state.visible) loadScenes();
      return;
    }
    _injectedPath = path;

    ["st-panel", "st-toggle-btn"].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.remove();
    });
    state.scenes = []; state.running = false;

    var attempts = 0;
    function tryInject() {
      if (++attempts > 50) return;
      var toolbar =
        document.querySelector(".filtered-list-toolbar.btn-toolbar") ||
        document.querySelector(".filtered-list-toolbar") ||
        document.querySelector(".btn-toolbar");
      if (!toolbar) { setTimeout(tryInject, 250); return; }

      var sp = state.scrapers.length > 0
        ? Promise.resolve(state.scrapers)
        : Promise.all([getSceneScrapers(), getStashBoxes()]).then(function (results) {
            var s = results[0].concat(results[1]);
            state.scrapers = s;
            return s;
          });

      sp.then(function (scrapers) {
        if (!scrapers.length) scrapers = [{ id: "", name: "No scene scraper" }];
        loadPluginConfig().then(function () {
          reconcileScraperChain();
          if (!document.getElementById(PANEL_ID)) {
            var panel = buildPanel(scrapers);
            document.body.appendChild(panel);
            attachPanelEvents();
          }
          var reopen = false;
          try {
            if (sessionStorage.getItem(REOPEN_FLAG) === "1") {
              sessionStorage.removeItem(REOPEN_FLAG);
              reopen = true;
            }
          } catch (e) {}
          if (reopen && !state.visible) {
            state.visible = true;
            var panelEl = document.getElementById(PANEL_ID);
            if (panelEl) panelEl.style.display = "";
          }
          injectToggleBtn();
          if (state.visible && state.scenes.length === 0) loadScenes();
        });
      });
    }
    setTimeout(tryInject, 400);
  }

  // Do NOT reset _injectedPath here: setup() needs to know the previous
  // path to distinguish "page/filter change on /scenes" (refresh in place,
  // panel keeps its state) from "leaving /scenes then coming back"
  // (full rebuild, panel/button absent from the DOM). A reset here would
  // systematically force the full-rebuild path, even for a simple page
  // change (1 -> 2) - the panel would close/reopen on every pagination
  // instead of refreshing its list in place.
  window.PluginApi.Event.addEventListener("stash:location", function () { setTimeout(setup, 150); });
  setTimeout(setup, 800);

  // Safety net: on a studio page, switching from the "Scenes" tab to
  // another and back doesn't always fire "stash:location" (no URL change) -
  // same pitfall documented for other async-mounted components. Without
  // this the button would stay missing until a real navigation happens.
  // Near-zero cost once the button already exists (BTN_ID found -> exits
  // immediately), same pattern as studioBulkDelete.js on this same page.
  new MutationObserver(function () {
    if (document.getElementById(BTN_ID)) return;
    if (!pageQualifiesForPanel(window.location.pathname)) return;
    setup();
  }).observe(document.body, { childList: true, subtree: true });

  // ── Injection: single scene page (Edit tab toolbar) ────────────────────────
  //
  // Adds a small "sceneTagger" button between Delete and "Scrape with..." on
  // a scene's Edit tab - opens the SAME panel used on the scene list, just
  // pre-loaded with this one scene as its only row. Reuses the existing
  // scrape / search-title / blacklist / apply logic (renderRow() etc.)
  // as-is instead of a separate UI (decision from session 2026-09-16).
  // Found by button text rather than a class name - Stash's Edit toolbar
  // markup/classes aren't a stable target, and "Scrape with..." is the one
  // anchor guaranteed to exist right where this button should sit.

  var SCENE_BTN_ID = "st-scene-btn";

  function getCurrentSceneID(pathname) {
    var m = pathname.match(/^\/scenes\/(\d+)/);
    return m ? m[1] : null;
  }

  function openPanelForScene(sceneID) {
    var sp = state.scrapers.length > 0
      ? Promise.resolve(state.scrapers)
      : Promise.all([getSceneScrapers(), getStashBoxes()]).then(function (results) {
          var s = results[0].concat(results[1]);
          state.scrapers = s;
          return s;
        });
    sp.then(function (scrapers) {
      if (!scrapers.length) scrapers = [{ id: "", name: "No scene scraper" }];
      loadPluginConfig().then(function () {
        reconcileScraperChain();
        if (!document.getElementById(PANEL_ID)) {
          var panel = buildPanel(scrapers);
          document.body.appendChild(panel);
          attachPanelEvents();
        }
        var panelEl = document.getElementById(PANEL_ID);
        if (panelEl) {
          panelEl.classList.add("st-panel-solo");
          panelEl.classList.toggle("st-hide-scene-mode-toggle", !!pluginConfig.hideSceneModeToggle);
          var titleEl = document.getElementById("st-titlebar-drag");
          if (titleEl) titleEl.textContent = "Scrape scene";
          // Meaningless in solo (a single scene is already "compact") and
          // was actively destructive there - see the comment in
          // attachPanelEvents() on why the toggle itself is now a no-op in
          // solo too (this hides the button; that guards the case where
          // the panel/button already existed from a previous solo open).
          var compactBtn = document.getElementById("st-titlebar-compact");
          if (compactBtn) compactBtn.style.display = "none";
        }
        if (!state.visible) {
          state.visible = true;
          if (panelEl) panelEl.style.display = "";
        }
        loadSingleScene(sceneID);
      });
    });
  }

  function injectSceneButton() {
    if (pluginConfig.hideEditButton) return;
    if (document.getElementById(SCENE_BTN_ID)) return;
    var buttons = document.querySelectorAll("button");
    var scrapeBtn = null;
    for (var i = 0; i < buttons.length; i++) {
      // Native text is "Scrape with…" (real U+2026 ellipsis, not three
      // dots) - matched loosely (startsWith "Scrape with") so a future
      // Stash wording tweak on the trailing character doesn't silently
      // break this again the same way.
      if ((buttons[i].textContent || "").trim().indexOf("Scrape with") === 0) { scrapeBtn = buttons[i]; break; }
    }
    if (!scrapeBtn || !scrapeBtn.parentNode) return;

    var btn = document.createElement("button");
    btn.id = SCENE_BTN_ID;
    btn.type = "button";
    btn.className = "btn btn-secondary st-scene-btn";
    btn.textContent = "sceneTagger";
    btn.addEventListener("click", function () {
      var sceneID = getCurrentSceneID(window.location.pathname);
      if (sceneID) openPanelForScene(sceneID);
    });
    scrapeBtn.parentNode.insertBefore(btn, scrapeBtn);
  }

  // ── Badge "ST" dans la .scene-toolbar (sous la vignette video) - meme
  // pattern d'injection DOM que sceneUrlDisplay (pas de patch React, juste
  // un groupe ajoute en fin de toolbar). Remplace l'icone sparkles
  // initiale (session 2026-09-16) par un badge carre arrondi aux couleurs
  // propres du plugin (memes valeurs que .st-section-icon dans le panneau:
  // fond #1a2028, bordure #2c3542, texte teal #88c0d0) plutot qu'une icone
  // generique - plus reconnaissable comme "Scene Tagger" specifiquement.
  var TOOLBAR_BTN_GROUP_ID = "st-toolbar-btn-group";

  function injectToolbarButton() {
    if (pluginConfig.hideToolbarButton) return;
    var toolbar = document.querySelector(".scene-toolbar");
    if (!toolbar) return;

    var group = document.getElementById(TOOLBAR_BTN_GROUP_ID);
    if (!group) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "minimal btn btn-secondary st-toolbar-badge-btn";
      btn.title = "Scene Tagger";
      btn.innerHTML = '<span class="st-toolbar-badge">ST</span>';
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var sceneID = getCurrentSceneID(window.location.pathname);
        if (sceneID) openPanelForScene(sceneID);
      });
      group = document.createElement("span");
      group.id = TOOLBAR_BTN_GROUP_ID;
      group.className = "scene-toolbar-group";
      group.appendChild(btn);
    }

    // Positionnee juste apres le groupe du bouton favori (coeur, plugin
    // tiers AdvancedRatingHeartFix - classe "adv-favourite-btn", lui-meme
    // ajoute dans le MEME groupe que la pastille rating/tag-count -> on
    // cible donc le groupe du coeur, pas un groupe dedie). Ce bouton
    // apparait de facon asynchrone, souvent APRES le premier passage de
    // sceneButtonTick (meme piege de course que documente dans
    // CLAUDE.md/refract-cards-Custom) - repositionne a chaque tick tant
    // que la position n'est pas encore correcte, au lieu de ne le faire
    // qu'une fois a la creation. Fallback en fin de toolbar si le coeur
    // est absent (plugin desactive).
    var favBtn = toolbar.querySelector(".adv-favourite-btn, #adv-favourite-trigger");
    var favGroup = favBtn ? favBtn.closest(".scene-toolbar-group") : null;
    if (favGroup && favGroup.parentNode === toolbar) {
      if (group.previousElementSibling !== favGroup) {
        favGroup.parentNode.insertBefore(group, favGroup.nextSibling);
      }
    } else if (!group.parentNode) {
      toolbar.appendChild(group);
    }
  }

  function sceneButtonTick() {
    var onScenePage = !!getCurrentSceneID(window.location.pathname);
    if (!onScenePage) {
      var existing = document.getElementById(SCENE_BTN_ID);
      if (existing) existing.remove();
      var existingToolbarGroup = document.getElementById(TOOLBAR_BTN_GROUP_ID);
      if (existingToolbarGroup) existingToolbarGroup.remove();
      return;
    }
    injectSceneButton();
    injectToolbarButton();
  }

  // The toolbar button is injected independently of ever opening the main
  // panel (which is where loadPluginConfig() normally runs) - without an
  // early load here, "Hide ST button" wouldn't take effect until the panel
  // was opened once per page load.
  loadPluginConfig().then(sceneButtonTick);
  window.PluginApi.Event.addEventListener("stash:location", function () { setTimeout(sceneButtonTick, 150); });
  setTimeout(sceneButtonTick, 800);

  // Same pitfall as the listing button above: switching Details <-> Edit on
  // a scene page remounts the toolbar without firing "stash:location" (no
  // URL change) - without this the button would only appear after a real
  // navigation. Near-zero cost once present (bails out immediately above).
  new MutationObserver(function () { sceneButtonTick(); })
    .observe(document.body, { childList: true, subtree: true });

})();