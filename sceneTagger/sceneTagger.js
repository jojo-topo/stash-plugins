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
    return gql("ListScrapers", "query ListScrapers{listScrapers(types:[SCENE]){id name}}")
      .then(function (d) { return d.listScrapers || []; });
  }

  // Prefix used to distinguish a stash-box "scraper" (id = prefixed
  // endpoint) from a regular YAML scraper (id = raw scraper_id).
  var STASHBOX_PREFIX = "stashbox:";

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

  var Q_FIND_BY_IDS = "query FindScenesByIds($ids:[ID!]){findScenes(ids:$ids){count scenes{id title urls date code details director organized paths{screenshot preview stream}files{path basename duration}studio{id name}performers{id name}tags{id name}}}}";

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
    nativeHoverPreview:        false
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
    if (cb('[data-cb="date"]')       && scraped.date)        filtered.date      = scraped.date;
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
    if (cb('[data-cb="urls"]')       && scraped.urls)        filtered.urls      = scraped.urls;
    if (cb('[data-cb="cover"]')      && scraped.image)       filtered.image     = scraped.image;

    // Details: apply the full original details if checked
    var detailsCb = row.querySelector('[data-cb="details"]');
    if (detailsCb && detailsCb.checked && scraped.details) {
      filtered.details = scraped.details.replace(/\[(\w+)\]/g, "");
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

    return filtered;
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

      // ── Scraper-used badge (fallback): visible only if it isn't the 1st
      // enabled scraper in the chain, so as not to clutter the normal case
      var enabledChain = pluginConfig.scraperChain.filter(function (c) { return c.enabled; });
      var firstEnabled = enabledChain.length ? enabledChain[0].id : null;
      if (pluginConfig.scraperMode === "auto" && r.matchedScraperName && enabledChain.length > 1 && r.matchedScraperID !== firstEnabled) {
        fields.push(
          '<div class="st-inline-field st-scraper-match-hint">' +
            '<span class="st-label-static"></span>' +
            '<span>found via <strong>' + esc(r.matchedScraperName) + '</strong> (fallback)</span>' +
          '</div>'
        );
      }

      // ── Title
      if (scraped.title) {
        fields.push(
          '<div class="st-inline-field">' +
            '<label class="st-inline-label"><input type="checkbox" data-cb="title" checked> Title</label>' +
            '<span class="st-chip st-chip-title">' + esc(scraped.title) + '</span>' +
          '</div>'
        );
      }

      // ── Cover
      if (scraped.image) {
        fields.push(
          '<div class="st-inline-field">' +
            '<label class="st-inline-label"><input type="checkbox" data-cb="cover" checked> Cover</label>' +
            '<img class="st-cover-preview" src="' + esc(scraped.image) + '" alt="cover">' +
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
        fields.push(
          '<div class="st-inline-field st-inline-artists">' +
            '<span class="st-inline-label st-label-static">Studio</span>' +
            '<div>' +
              '<div class="st-radio-group">' + radioNone + radioItems + '</div>' +
              studioSearchWidget +
            '</div>' +
          '</div>'
        );
      } else if (artists.length === 1) {
        // A single artist (non-blacklisted or fallback) → checkbox
        var soloArtistObj = artists[0];
        var soloArtist   = soloArtistObj.name;
        var soloIsNew    = !soloArtistObj.stored_id;
        var soloChecked  = soloIsNew ? pluginConfig.autoCheckStudio : true;
        var soloIsBl     = isBlacklisted(soloArtist);
        fields.push(
          '<div class="st-inline-field st-inline-artists">' +
            '<label class="st-inline-label"><input type="checkbox" data-cb="studio" data-artist-stored="' + (soloArtistObj.stored_id || '') + '"' + (soloChecked ? ' checked' : '') + '> Studio</label>' +
            '<div>' +
              '<span class="st-chip st-chip-studio' + (soloIsBl ? ' st-chip-blacklisted' : '') + '">' +
                '<span class="st-selectable">' + esc(soloArtist) + '</span>' +
                (soloIsNew ? ' <span class="st-new-badge">new</span>' : '') +
                (soloIsBl  ? ' <span class="st-bl-badge" title="Blacklisted but the only one available">⚠</span>' : '') +
              '</span>' +
              (!soloIsBl ? '' : '') +
              studioSearchWidget +
            '</div>' +
          '</div>'
        );
      } else {
        // No scraped studio → just the search
        fields.push(
          '<div class="st-inline-field st-inline-artists">' +
            '<span class="st-inline-label st-label-static">Studio</span>' +
            studioSearchWidget +
          '</div>'
        );
      }

      // ── Date
      if (scraped.date) {
        fields.push(
          '<div class="st-inline-field">' +
            '<label class="st-inline-label"><input type="checkbox" data-cb="date" checked> Date</label>' +
            '<span class="st-chip st-chip-date">' + esc(scraped.date) + '</span>' +
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

      // ── Individual performers + search bar (always shown)
      var perfItemsHTML = "";
      if (scraped.performers && scraped.performers.length) {
        perfItemsHTML = scraped.performers.map(function (p, i) {
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

      var perfSearchWidget =
        '<div class="st-perf-search-wrap">' +
          '<input type="text" class="st-perf-search-input" placeholder="Search for or add a performer..." autocomplete="off">' +
          '<div class="st-perf-search-results" style="display:none"></div>' +
        '</div>' +
        '<div class="st-perfs-added"></div>';

      var perfsLabel = scraped.performers && scraped.performers.length
        ? '<label><input type="checkbox" data-cb="perfs-all" checked> Performers (' + scraped.performers.length + ')</label>'
        : '<span>Performers</span>';

      fields.push(
        '<div class="st-inline-field st-inline-performers">' +
          '<div class="st-inline-label">' + perfsLabel + '</div>' +
          '<div class="st-perfs-right">' +
            (perfItemsHTML ? '<div class="st-perfs-grid">' + perfItemsHTML + '</div>' : '') +
            perfSearchWidget +
          '</div>' +
        '</div>'
      );

      // ── Tags (scraped + manually added via search/create)
      {
        var tagItems = (scraped.tags || []).map(function (t, i) {
          var isNew = !t.stored_id;
          var tagChecked = isNew ? pluginConfig.autoCheckNewTags : true;
          return '<label class="st-tag-item' + (isNew ? ' st-tag-new' : '') + '">' +
            '<input type="checkbox" data-cb="tag" data-idx="' + i + '" ' + (tagChecked ? 'checked' : '') + '>' +
            '<span class="st-selectable">' + esc(t.name) + '</span>' +
            (isNew ? '<span class="st-new-badge">new</span>' : '') +
          '</label>';
        }).join("");

        var tagsLabel = scraped.tags && scraped.tags.length
          ? '<label><input type="checkbox" data-cb="tags-all" checked> Tags (' + scraped.tags.length + ')</label>'
          : '<span>Tags</span>';

        var tagSearchWidget =
          '<div class="st-tag-search-wrap">' +
            '<input type="text" class="st-tag-search-input" placeholder="Search for or add a tag..." autocomplete="off">' +
            '<div class="st-tag-search-results" style="display:none"></div>' +
          '</div>' +
          '<div class="st-tags-added"></div>';

        fields.push(
          '<div class="st-inline-field st-inline-tags">' +
            '<div class="st-inline-label">' + tagsLabel + '</div>' +
            (tagItems ? '<div class="st-tags-grid">' + tagItems + '</div>' : '') +
            tagSearchWidget +
          '</div>'
        );
      }

      // ── Details
      if (scraped.details) {
        var detailsParsedForDisplay = parseDetailsArtists(scraped.details);
        var hasRealContent = !!detailsParsedForDisplay.rest;
        // Checked if: real content AND (autoCheckDetails OR hasRealContent)
        var detailsChecked = pluginConfig.autoCheckDetails ? true : hasRealContent;
        var detailsShort = scraped.details.length > 80 ? scraped.details.substring(0, 80) + "…" : scraped.details;
        fields.push(
          '<div class="st-inline-field">' +
            '<label class="st-inline-label"><input type="checkbox" data-cb="details"' + (detailsChecked ? ' checked' : '') + '> Details</label>' +
            '<span class="st-chip st-chip-details" title="' + esc(scraped.details) + '">' + esc(detailsShort) + '</span>' +
          '</div>'
        );
      }

      // ── URLs
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

      inlineHTML =
        '<div class="st-inline-results">' +
          fields.join("") +
          '<div class="st-inline-actions">' +
            '<button class="st-btn st-btn-success" onclick="stApplyOne(\'' + esc(id) + '\')">Apply</button>' +
            (r.manualFallback ? '<button class="st-btn st-btn-ghost" onclick="stScrapeOne(\'' + esc(id) + '\')">Retry</button>' : '') +
            '<button class="st-btn st-btn-danger"  onclick="stSkipOne(\''  + esc(id) + '\')">Skip</button>' +
          '</div>' +
        '</div>';
    }

    var rightHTML = "";
    if (status === "idle" || status === "skipped") {
      rightHTML = '<div class="st-row-btn"><button class="st-btn st-btn-primary" onclick="stScrapeOne(\'' + esc(id) + '\')">Scrape</button></div>';
    } else if (status === "scraping" || status === "applying") {
      rightHTML = '<div class="st-row-btn"><span class="st-spinner"></span></div>';
    } else if (status === "done") {
      rightHTML = '<div class="st-row-btn"><span class="st-done-icon">&#10003;</span></div>';
    } else if (status === "error") {
      rightHTML = '<div class="st-row-btn"><button class="st-btn st-btn-ghost" onclick="stScrapeOne(\'' + esc(id) + '\')">Retry</button></div>';
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
        '<span class="st-thumb-clip"' +
          (pluginConfig.nativeHoverPreview && scene.paths && scene.paths.preview
            // Already-generated preview clip: short and pre-trimmed, so no
            // 10%-in seek needed - just loop it from 0 like a normal preview.
            ? ' data-preview-url="' + esc(scene.paths.preview) + '"'
            : pluginConfig.nativeHoverPreview && scene.paths && scene.paths.stream
            // No generated preview for this scene - stream the source
            // directly instead of forcing a generation pass just for hover.
            ? ' data-preview-url="' + esc(scene.paths.stream) + '"' +
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
      inlineHTML;

    var manualUrlInput = el.querySelector(".st-manual-url-input");
    if (manualUrlInput) {
      manualUrlInput.addEventListener("input", function () {
        r.manualUrl = manualUrlInput.value.trim();
      });
    }

    var manualTitleInput = el.querySelector(".st-manual-title-input");
    if (manualTitleInput) {
      manualTitleInput.addEventListener("input", function () {
        r.manualTitle = manualTitleInput.value.trim();
      });
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
            perfSearchResults.parentNode.appendChild(perfHoverPreview);
          }
          perfHoverPreview.src = img;
          // Positioned against the wrap (.st-perf-search-wrap, position:relative),
          // not against perfSearchResults itself, since the preview is a sibling
          // of the dropdown rather than a child of it.
          var wrapRect = perfSearchResults.parentNode.getBoundingClientRect();
          var itemRect = item.getBoundingClientRect();
          perfHoverPreview.style.top = (itemRect.top - wrapRect.top) + "px";
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
          // Show the selected studio
          selectedSpan.textContent = "→ " + sname;
          selectedSpan.style.display = "inline";
          // Uncheck the radios and the original studio checkbox
          el.querySelectorAll('[data-cb="studio-radio"]').forEach(function (r) { r.checked = false; });
          var studioOrigCb = el.querySelector('[data-cb="studio"]');
          if (studioOrigCb) studioOrigCb.checked = true;
          // Close the results and clear the input
          searchResults.style.display = "none";
          searchResults.innerHTML = "";
          searchInput.value = "";
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
    var sel = document.getElementById("st-scraper-filter");
    if (!sel) return;
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
    sel.innerHTML = '<option value="all">All scrapers</option>' +
      options.map(function (o) {
        return '<option value="' + esc(o.id) + '"' + (o.id === current ? " selected" : "") + '>' + esc(o.name) + '</option>';
      }).join("");
    if (!stillValid) {
      state.scraperFilter = "all";
      sel.value = "all";
    }
  }

  function applyStudioFilter() {
    var f = state.studioFilter;
    var sf = state.scraperFilter;
    state.scenes.forEach(function(scene) {
      var el = document.getElementById("st-row-" + scene.id);
      if (!el) return;
      var r = state.rows[scene.id];
      // Errors: no new/existing status since there's no scraped result to
      // classify - hidden under New/Existing, stay visible under All so
      // failures needing a retry aren't lost from view.
      if (r && r.status === "error" && (f !== "all" || sf !== "all")) {
        el.style.display = "none";
        return;
      }
      if (!r || r.status !== "scraped") {
        el.style.display = (sf === "all") ? "" : "none";
        return;
      }
      if (sf !== "all" && r.matchedScraperID !== sf) { el.style.display = "none"; return; }
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
        container.appendChild(preview);
      }
      preview.src = avatar.src;
      var wrapRect = container.getBoundingClientRect();
      var chipRect = avatar.closest(chipSelector).getBoundingClientRect();
      // Popped above the chip/item (like a tooltip), not on top of it - the
      // preview's own fixed 120px height (see .st-perf-hover-preview) is the
      // offset, plus a small gap.
      preview.style.top  = (chipRect.top - wrapRect.top - 120 - 8) + "px";
      preview.style.left = (chipRect.left - wrapRect.left) + "px";
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
    } else {
      r.status = "error";
      r.msg = msg;
    }
  }

  window.stScrapeOne = function (id) {
    var r = state.rows[id];
    if (!r) return;
    r.status = "scraping"; r.scraped = null; r.msg = ""; r.matchedScraperName = null; r.matchedScraperID = null; r.manualFallback = false;
    renderRow(id);
    updateStatus("Scraping " + getFilename(r.scene) + "...");

    scrapeOneEffective(id)
      .then(function (res) {
        if (!res.scraped) { handleScrapeFailure(r, "No result"); }
        else               { r.status = "scraped"; r.scraped = res.scraped; r.matchedScraperName = res.scraperName; r.matchedScraperID = res.scraperID; }
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
      r.status = "scraping"; r.scraped = null; r.msg = ""; r.matchedScraperName = null; r.matchedScraperID = null; r.manualFallback = false;
      renderRow(scene.id);

      scrapeOneEffective(scene.id)
        .then(function (res) {
          if (!res.scraped) { handleScrapeFailure(r, "No result"); }
          else               { r.status = "scraped"; r.scraped = res.scraped; r.matchedScraperName = res.scraperName; r.matchedScraperID = res.scraperID; }
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
    seq.then(function () { updateStatus("All scenes applied"); });
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
  }

  function setScrapeAllBtn(d) {
    var b = document.getElementById("st-btn-scrape-all"); if (b) b.disabled = d;
    var drag = document.getElementById("st-titlebar-drag");
    if (drag) drag.classList.toggle("st-titlebar-active", d);
  }
  function setApplyAllBtn(d)  { var b = document.getElementById("st-btn-apply-all");  if (b) b.disabled = d; }

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
            state.rows[scene.id] = { scene: scene, status: "idle", scraped: null, msg: "" };
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
        '<div class="st-setting-row st-scraper-chain-row">' +
          '<div class="st-blacklist-label">Scrapers (order = fallback priority)</div>' +
          '<div id="st-scraper-chain"></div>' +
        '</div>' +
        '<div class="st-setting-row">' +
          '<label class="st-setting-label"><input type="checkbox" id="st-cfg-studio"> New studios checked by default</label>' +
        '</div>' +
        '<div class="st-setting-row">' +
          '<label class="st-setting-label"><input type="checkbox" id="st-cfg-prioritize-existing"> Prioritize the studio already in the database (multi-studio)</label>' +
        '</div>' +
        // "Other studios" (skExtra-Multiple-Studios-Custom) row hidden in this
        // public build: the companion plugin it depends on isn't published
        // yet, so the toggle would just confuse users who don't have it.
        // Uncomment once that plugin is published separately.
        // '<div class="st-setting-row">' +
        //   '<label class="st-setting-label"><input type="checkbox" id="st-cfg-auto-other-studios"> Add the other artists (Artists:) as "Other studios" (skExtra-Multiple-Studios-Custom)</label>' +
        // '</div>' +
        '<div class="st-setting-row">' +
          '<label class="st-setting-label"><input type="checkbox" id="st-cfg-performer"> New performers checked by default</label>' +
        '</div>' +
        '<div class="st-setting-row">' +
          '<label class="st-setting-label"><input type="checkbox" id="st-cfg-tags"> New tags checked by default</label>' +
        '</div>' +
        '<div class="st-setting-row">' +
          '<label class="st-setting-label"><input type="checkbox" id="st-cfg-details"> Details checked by default</label>' +
        '</div>' +
        '<div class="st-setting-row">' +
          '<label class="st-setting-label"><input type="checkbox" id="st-cfg-use-url"> Use the existing URL on the scene if available (before scraper/chain)</label>' +
        '</div>' +
        '<div class="st-setting-row">' +
          '<label class="st-setting-label"><input type="checkbox" id="st-cfg-manual-fallback"> Manual fill-in when scraping fails (studio/performers/tags/details)</label>' +
        '</div>' +
        '<div class="st-setting-row">' +
          '<label class="st-setting-label"><input type="checkbox" id="st-cfg-manual-fallback-title"> Also allow manual title entry</label>' +
        '</div>' +
        '<div class="st-setting-row">' +
          '<label class="st-setting-label"><input type="checkbox" id="st-cfg-native-hover"> Hover preview</label>' +
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
        '<button class="st-btn st-btn-ghost"    id="st-btn-clear">Clear</button>' +
        '<button class="st-btn st-btn-ghost" id="st-btn-scraper-mode" title="Toggle between automatic fallback and manual choice">' +
          (pluginConfig.scraperMode === "manual" ? "Manual" : "Auto") +
        '</button>' +
        '<select id="st-scraper-select-manual" style="display:' + (pluginConfig.scraperMode === "manual" ? "inline-block" : "none") + '">' +
          scrapers.map(function (s) {
            return '<option value="' + esc(s.id) + '"' + (s.id === state.manualScraperID ? " selected" : "") + '>' + esc(s.name) + '</option>';
          }).join("") +
        '</select>' +
        '<div class="st-filter-radios">' +
          '<select id="st-scraper-filter" class="st-scraper-filter-select" title="Filter by scraper">' +
            '<option value="all">All scrapers</option>' +
          '</select>' +
          '<div class="st-filter-group">' +
            '<span class="st-filter-indicator"></span>' +
            '<label class="st-filter-item"><input type="radio" name="st-studio-filter" value="all" checked> All</label>' +
            '<label class="st-filter-item"><input type="radio" name="st-studio-filter" value="new"> New</label>' +
            '<label class="st-filter-item"><input type="radio" name="st-studio-filter" value="existing"> Existing</label>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div id="st-status-bar">' +
        '<span id="st-status-text">Waiting...</span>' +
        '<div id="st-progress-wrap"><div id="st-progress-bar"></div></div>' +
      '</div>' +
      '<div id="st-rows"></div>' +
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
    // data-preview-url is scene.paths.preview when Stash already generated
    // one for that scene (cheap - just loop it from 0, see the else branch
    // below), otherwise scene.paths.stream, the source file itself - no need
    // to force-generate previews for the whole library just to hover-scrub
    // scenes in this panel (unlike videoHoverPreview, whose whole point was
    // avoiding that generation cost too - see its STREAM_BASE + "/stream"
    // use). Only the stream case carries data-preview-duration (set in
    // renderRow), which is what selects the 10%-in seek below.
    var rowsEl = document.getElementById("st-rows");
    if (rowsEl) {
      rowsEl.addEventListener("mouseover", function (e) {
        if (!pluginConfig.nativeHoverPreview) return;
        var clip = e.target.closest(".st-thumb-clip");
        if (!clip || (e.relatedTarget && clip.contains(e.relatedTarget))) return;
        var url = clip.getAttribute("data-preview-url");
        if (!url || clip.querySelector(".st-thumb-preview-video")) return;
        var duration = parseFloat(clip.getAttribute("data-preview-duration")) || 0;
        var startAt = duration > 1 ? duration * 0.10 : 0;
        var video = document.createElement("video");
        video.className = "st-thumb-preview-video";
        video.src = url;
        video.muted = true;
        video.playsInline = true;
        video.preload = "metadata";
        if (startAt > 0) {
          // Loop from the 10%-in point rather than 0s (often a black/title
          // frame on these sources) - native `video.loop` always restarts
          // at 0, so the loop-back is done by hand via timeupdate instead.
          video.addEventListener("loadedmetadata", function () {
            video.currentTime = startAt;
          });
          video.addEventListener("timeupdate", function () {
            if (video.duration && video.currentTime >= video.duration - 0.2) {
              video.currentTime = startAt;
            }
          });
        } else {
          video.loop = true;
        }
        clip.appendChild(video);
        video.play().catch(function () {});
      });
      rowsEl.addEventListener("mouseout", function (e) {
        var clip = e.target.closest(".st-thumb-clip");
        if (!clip || (e.relatedTarget && clip.contains(e.relatedTarget))) return;
        var video = clip.querySelector(".st-thumb-preview-video");
        if (video) video.remove();
      });
    }

    // ── Manual / auto mode ──────────────────────────────────────────────────
    var modeBtn = document.getElementById("st-btn-scraper-mode");
    var manualSelect = document.getElementById("st-scraper-select-manual");
    if (manualSelect && !state.manualScraperID && manualSelect.options.length) {
      state.manualScraperID = manualSelect.options[0].value;
      manualSelect.value = state.manualScraperID;
    }
    if (modeBtn) {
      modeBtn.addEventListener("click", function () {
        pluginConfig.scraperMode = pluginConfig.scraperMode === "manual" ? "auto" : "manual";
        savePluginConfig();
        modeBtn.textContent = pluginConfig.scraperMode === "manual" ? "Manual" : "Auto";
        if (manualSelect) manualSelect.style.display = pluginConfig.scraperMode === "manual" ? "inline-block" : "none";
      });
    }
    if (manualSelect) {
      manualSelect.addEventListener("change", function () { state.manualScraperID = manualSelect.value; });
    }

    document.getElementById("st-btn-scrape-all").addEventListener("click", function () { if (!state.running) scrapeAll(); });
    document.getElementById("st-btn-apply-all").addEventListener("click", applyAll);
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

    // Compact mode button
    var compactBtn = document.getElementById("st-titlebar-compact");
    if (compactBtn) {
      if (pluginConfig.compactMode) compactBtn.style.color = "rgba(var(--accent-rgb,94,129,172),1)";
      compactBtn.addEventListener("click", function () {
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
    bindSettingCb("st-cfg-manual-fallback",       "manualFallbackOnFail");
    bindSettingCb("st-cfg-manual-fallback-title", "manualFallbackAllowTitle");
    bindSettingCb("st-cfg-native-hover",          "nativeHoverPreview");

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

    var scraperFilterSel = document.getElementById("st-scraper-filter");
    if (scraperFilterSel) {
      renderScraperFilterOptions();
      scraperFilterSel.addEventListener("change", function () {
        state.scraperFilter = scraperFilterSel.value;
        applyStudioFilter();
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

})();