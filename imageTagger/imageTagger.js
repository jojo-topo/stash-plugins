/**
 * imageTagger.js v6.1 — Image Tagger Plugin for Stash
 * Affichage inline des résultats de scrape avec checkboxes par champ.
 * Apply All applique directement les champs cochés sans popup.
 */

(function () {
  "use strict";

  var STASH_GQL = "/graphql";
  var PANEL_ID  = "it-panel";
  var BTN_ID    = "it-toggle-btn";

  // Stash UI (l'app separee de /plugin/stashui/assets/) n'a pas de PluginApi :
  // les evenements deviennent un no-op et le panneau est pilote via _host
  // (voir window.itImageTaggerHost en fin de fichier).
  var PluginEvent = (window.PluginApi && window.PluginApi.Event) || { addEventListener: function () {} };
  var _host = null;      // { fetchIds(page) -> Promise<{ids, page, total}> } quand ouvert depuis Stash UI
  var _hostInfo = null;  // derniere info de page renvoyee par _host.fetchIds()
  var _hostSolo = false; // le panneau solo a ete ouvert depuis la visionneuse d'images de Stash UI
  var _soloHostID = null; // id de l'image pour laquelle ce panneau solo a ete construit

  var IT_ICON_COPY  = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
  var IT_ICON_CHECK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

  function itCopyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return Promise.resolve();
    } catch (err) { return Promise.reject(err); }
  }

  // rule34-python.py glisse la thumbnail scrapee dans "urls" (seul champ que
  // ScrapedImage supporte cote GraphQL Stash - "image" n'existe pas sur ce type,
  // contrairement a ScrapedScene) pour permettre la vue comparaison du mode solo.
  // Cette entree est un artefact interne : jamais a afficher dans la liste URLs,
  // jamais a sauvegarder comme vraie URL source sur Apply.
  var THUMB_URL_SUFFIX = "#it-scraped-thumb";
  function isInjectedThumbUrl(u) { return typeof u === "string" && u.slice(-THUMB_URL_SUFFIX.length) === THUMB_URL_SUFFIX; }
  function extractScrapedThumb(scraped) {
    if (!scraped || !scraped.urls) return null;
    for (var i = 0; i < scraped.urls.length; i++) {
      if (isInjectedThumbUrl(scraped.urls[i])) return scraped.urls[i].slice(0, -THUMB_URL_SUFFIX.length);
    }
    return null;
  }
  function visibleScrapedUrls(scraped) {
    if (!scraped || !scraped.urls) return scraped ? scraped.urls : null;
    return scraped.urls.filter(function (u) { return !isInjectedThumbUrl(u); });
  }

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

  function getImageScrapers() {
    return gql("ListScrapers", "query ListScrapers{listScrapers(types:[IMAGE]){id name}}")
      .then(function (d) { return d.listScrapers || []; });
  }

  // ── ScrapeSingleImage ──────────────────────────────────────────────────────

  var Q_SCRAPE = "query ScrapeSingleImage($source:ScraperSourceInput!,$input:ScrapeSingleImageInput!){scrapeSingleImage(source:$source,input:$input){title code date details photographer urls studio{stored_id name image url details}tags{stored_id name}performers{stored_id name disambiguation gender urls birthdate ethnicity country eye_color height measurements fake_tits penis_length circumcised career_start career_end tattoos piercings aliases images details death_date hair_color weight}}}";

  function scrapeSingleImage(scraperID, imageID) {
    return gql("ScrapeSingleImage", Q_SCRAPE, {
      source: { scraper_id: scraperID },
      input:  { image_id: String(imageID) }
    }).then(function (d) {
      var r = d.scrapeSingleImage;
      return Array.isArray(r) ? (r[0] || null) : r;
    });
  }

  // Scrape via l'URL deja enregistree sur l'image, agnostique du scraper.
  var Q_SCRAPE_URL = "query ScrapeImageURL($url:String!){scrapeImageURL(url:$url){title code date details photographer urls studio{stored_id name image url details}tags{stored_id name}performers{stored_id name disambiguation gender urls birthdate ethnicity country eye_color height measurements fake_tits penis_length circumcised career_start career_end tattoos piercings aliases images details death_date hair_color weight}}}";

  function scrapeImageURL(url) {
    return gql("ScrapeImageURL", Q_SCRAPE_URL, { url: url })
      .then(function (d) { return d.scrapeImageURL; });
  }

  // Un scraper mal ecrit peut renvoyer {} (objet vide, truthy en JS) au lieu
  // de null quand il ne trouve rien - sans ce filtre, le repli s'arrete la
  // au lieu de tester les scrapers suivants de la chaine.
  function isUsableScrapedResult(r) {
    if (!r) return false;
    return !!(r.title || r.details || (r.studio && r.studio.name) ||
      (r.tags && r.tags.length) || (r.performers && r.performers.length));
  }

  // -- Scrape progress veil ------------------------------------------------
  // Stash returns ONE response per scrape (no progress), so the veil is a
  // simulated curve: fast start, then slower, capped below 100% until the
  // answer arrives. Only REAL events change anything: a new scraper tried in
  // the fallback chain, the title update, the URL lookup - each gives a small
  // surge and a matching status line. No fake step numbers or percentages.
  var PROG_EXPECTED = 2.5;   // seconds a typical scrape takes (measured)
  var PROG_CAP = 0.985;      // asymptote: the veil keeps creeping towards it, never reaches 100%
  var PROG_KNEE = 0.90;      // above this the position is compressed smoothly towards PROG_CAP
  var progRaf = null;

  // Veil position (0..1) after t seconds of waiting. Phase 1 (up to the expected
  // duration): fast ease-out to 82%. Phase 2: logarithmic crawl whose speed matches
  // the end of phase 1 and then keeps falling like 1/t - no sudden stop, still
  // visibly moving after tens of seconds, never reaching 100%.
  function progTarget(t) {
    if (t <= PROG_EXPECTED) return 0.82 * (1 - Math.exp(-3.2 * t / PROG_EXPECTED)) / (1 - Math.exp(-3.2));
    return 0.82 + 0.03 * Math.log(1 + (t - PROG_EXPECTED) / 0.67);
  }

  function progEvent(id, label, bump) {
    var r = state.rows[id];
    if (!r || r.status !== "scraping") return;
    if (label) r.progLabel = label;
    if (bump) { (r.progBumps = r.progBumps || []).push(performance.now()); }
    var lab = document.querySelector("#it-row-" + id + " .it-prog-label");
    if (lab && label) lab.textContent = label;
  }

  function progStart(id) {
    var r = state.rows[id];
    if (!r) return;
    r.progT0 = performance.now(); r.progLast = r.progT0; r.progP = 0; r.progFinishing = false;
    r.progBumps = []; r.progLabel = "Scraping..."; r.progBumpAcc = 0;
    if (!progRaf) progRaf = requestAnimationFrame(progFrame);
  }

  function progFrame(now) {
    progRaf = null;
    var any = false;
    Object.keys(state.rows).forEach(function (id) {
      var r = state.rows[id];
      if (!r || r.status !== "scraping" || r.progT0 === undefined) return;
      any = true;
      if (r.progFinishing) return;   // progFinish() animates the last stretch by CSS transition
      var veil = document.querySelector("#it-row-" + id + " .it-prog-veil");
      var dt = Math.min(0.1, (now - r.progLast) / 1000); r.progLast = now;
      var target = progTarget((now - r.progT0) / 1000);
      // each new scraper tried in the chain gives a small push towards the cap
      (r.progBumps || []).forEach(function (b) {
        r.progBumpAcc += Math.max(0, PROG_CAP - 0.003 - target - r.progBumpAcc) * Math.exp(-((now - b) / 1000) / 0.35) * dt;
      });
      // Soft ceiling (not a hard clamp): the time curve plus the scraper "pushes" can go past the
      // cap on a slow scrape, and a hard min() froze the veil dead (a speed of 0.7%/s dropping to
      // 0 within one frame). Above the knee the value is squeezed exponentially towards the cap,
      // so the veil keeps slowing down smoothly and never stops abruptly.
      var rawP = target + r.progBumpAcc;
      if (rawP > PROG_KNEE) rawP = PROG_KNEE + (PROG_CAP - PROG_KNEE) * (1 - Math.exp(-(rawP - PROG_KNEE) / (PROG_CAP - PROG_KNEE)));
      r.progP = Math.max(r.progP, rawP);
      if (veil) veil.style.width = (r.progP * 100).toFixed(2) + "%";
    });
    if (any) progRaf = requestAnimationFrame(progFrame);
  }

  // Short run to 100% before the row re-renders as scraped; resolves at once
  // when the veil is off or not on screen.
  function progFinish(id) {
    var r = state.rows[id];
    var el = document.getElementById("it-row-" + id);
    var veil = el ? el.querySelector(".it-prog-veil") : null;
    // Kept for progReveal(): the old veil element and the row height before it re-renders.
    if (r) r.progCtx = { veil: veil, h0: el ? el.offsetHeight : 0 };
    if (!pluginConfig.progressVeil || !veil) return Promise.resolve();
    if (r) r.progFinishing = true;
    // Glide into 100%: the nearer the veil already is, the shorter the run, with a long
    // ease-out tail (no sudden jump). Waits for the whole run: progReveal() resets the veil's
    // inline style, which would cut the transition short.
    var left = Math.max(0, 1 - (r && r.progP ? r.progP : 0));
    var dur = Math.max(0.3, Math.min(0.75, 0.3 + left * 0.8));
    veil.style.transition = "width " + dur.toFixed(2) + "s cubic-bezier(.2,.75,.25,1)";
    veil.style.width = "100%";
    return new Promise(function (res) { setTimeout(res, Math.round(dur * 1000) + 30); });
  }

  // Called right after the row re-rendered with the scrape result: the old veil
  // fades out on top (0.5s), the result block fades in and slides down (0.35s),
  // the row grows from its old height (0.2s) and the outline flares then settles
  // (0.3s). All inline + cleaned up afterwards; skipped for reduced motion.
  function progReveal(id) {
    var r = state.rows[id];
    var ctx = r && r.progCtx;
    if (!ctx) return;
    r.progCtx = null;
    if (!pluginConfig.progressTransition) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var el = document.getElementById("it-row-" + id);
    if (!el || (r.status !== "scraped" && r.status !== "error")) return;

    var h1 = el.offsetHeight;
    var prevPos = el.style.position;
    el.style.position = "relative";

    // D: outline flare (scraped = azure, failed = red); not when the outline is off
    var panelEl = document.getElementById(PANEL_ID);
    var noOutline = panelEl && panelEl.classList.contains("it-no-outline");
    if (!noOutline) {
      el.style.animation = ((r.manualFallback || r.status === "error") ? "it-flare-fail" : "it-flare") + " .3s ease-out";
    }

    // B: everything except the header line fades in and slides down
    Array.prototype.forEach.call(el.children, function (ch) {
      if (ch.classList.contains("it-row-top") || ch.classList.contains("it-prog-veil")) return;
      ch.style.animation = "it-reveal .35s ease-out both";
    });

    // A: old veil on top, fading out
    if (ctx.veil) {
      ctx.veil.style.cssText = "position:absolute;left:0;top:0;bottom:0;width:100%;z-index:5;opacity:1;transition:opacity .5s ease;pointer-events:none";
      el.appendChild(ctx.veil);
      requestAnimationFrame(function () { requestAnimationFrame(function () { ctx.veil.style.opacity = "0"; }); });
    }

    // C: height from the old size to the new one
    var grow = ctx.h0 > 0 && h1 > ctx.h0 + 4;
    if (grow) {
      el.style.height = ctx.h0 + "px";
      el.style.overflow = "hidden";
      void el.offsetHeight;
      el.style.transition = "height .2s cubic-bezier(.2,.7,.2,1)";
      el.style.height = h1 + "px";
    }

    setTimeout(function () {
      if (ctx.veil && ctx.veil.parentNode) ctx.veil.parentNode.removeChild(ctx.veil);
      el.style.animation = ""; el.style.height = ""; el.style.overflow = ""; el.style.transition = "";
      el.style.position = prevPos;
      Array.prototype.forEach.call(el.children, function (ch) { ch.style.animation = ""; });
    }, 560);
  }

  // Essaie les scrapers actives de pluginConfig.scraperChain dans l'ordre,
  // s'arrete au premier resultat exploitable.
  function scrapeWithFallback(imageID) {
    var chain = (pluginConfig.scraperChain || []).filter(function (c) { return c.enabled; });
    function tryNext(i) {
      if (i >= chain.length) return Promise.resolve({ scraped: null });
      var entry = chain[i];
      if (i > 0) {
        var sc0 = state.scrapers.filter(function (sc) { return sc.id === entry.id; })[0];
        progEvent(imageID, "Scraper " + (i + 1) + "/" + chain.length + " · " + (sc0 ? sc0.name : entry.id), true);
      }
      return scrapeSingleImage(entry.id, imageID)
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

  // Point d'entree unique du scrape : essaie d'abord l'URL existante sur
  // l'image si l'option est activee, puis respecte le mode choisi (auto =
  // chaine de repli, manual = un seul scraper choisi via le select du header).
  function scrapeOneEffective(imageID) {
    var r = state.rows[imageID];
    var img = r ? r.image : null;
    // URL saisie manuellement sur la ligne : priorite absolue.
    if (r && r.manualUrl) {
      progEvent(imageID, "Reading URL...", false);
      return scrapeImageURL(r.manualUrl).then(function (result) {
        if (isUsableScrapedResult(result)) {
          return { scraped: result, scraperID: "url", scraperName: "Entered URL" };
        }
        return scrapeOneByMode(imageID);
      }).catch(function () { return scrapeOneByMode(imageID); });
    }
    if (pluginConfig.useUrlIfPresent && img && img.urls && img.urls.length) {
      progEvent(imageID, "Reading URL...", false);
      return scrapeImageURL(img.urls[0]).then(function (result) {
        if (isUsableScrapedResult(result)) {
          return { scraped: result, scraperID: "url", scraperName: "Existing URL" };
        }
        return scrapeOneByMode(imageID);
      }).catch(function () { return scrapeOneByMode(imageID); });
    }
    return scrapeOneByMode(imageID);
  }

  function scrapeOneByMode(imageID) {
    if (pluginConfig.scraperMode === "manual") {
      if (!state.manualScraperID) return Promise.resolve({ scraped: null });
      return scrapeSingleImage(state.manualScraperID, imageID).then(function (result) {
        if (!result) return { scraped: null };
        var s = state.scrapers.filter(function (sc) { return sc.id === state.manualScraperID; })[0];
        return { scraped: result, scraperID: state.manualScraperID, scraperName: s ? s.name : state.manualScraperID };
      });
    }
    return scrapeWithFallback(imageID);
  }

  // ── Images de la page active : lues depuis le DOM natif (grille deja
  // rendue par Stash) plutot que reconstruites en devinant le filtre/page
  // actifs. Fiable a 100% par construction (on lit ce qui EST affiche, on
  // ne devine rien) - meme approche que sceneTagger (voir CLAUDE.md), qui
  // remplace l'ancienne interception de window.fetch (fragile, sujette a
  // des courses de timing).
  // ────────────────────────────────────────────────────────────────────────

  var Q_FIND_BY_IDS = "query FindImagesByIds($ids:[ID!]){findImages(ids:$ids){count images{id title urls date details organized paths{thumbnail}files{path basename}studio{id name image_path details}performers{id name image_path}tags{id name}}}}";

  // IDs des images visibles dans la grille native, dans l'ordre d'affichage.
  // Selecteur generique a[href*='/images/'] : robuste meme sans connaitre le
  // nom exact de la classe de card utilisee par Stash pour les images.
  function getVisibleImageIdsInOrder() {
    var ids = [];
    document.querySelectorAll("a[href*='/images/']").forEach(function (a) {
      var m = (a.getAttribute("href") || "").match(/\/images\/(\d+)/);
      if (m && ids.indexOf(m[1]) === -1) ids.push(m[1]);
    });
    return ids;
  }

  // Attend que la grille native ait au moins une card (elle peut ne pas
  // encore etre rendue juste apres une navigation).
  function waitForImageCards(maxWaitMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function check() {
        var ids = getVisibleImageIdsInOrder();
        if (ids.length) { resolve(ids); return; }
        if (Date.now() - start >= maxWaitMs) { resolve(ids); return; }
        setTimeout(check, 150);
      })();
    });
  }

  // Numero de page / total de pages : lus depuis le texte du widget de
  // pagination natif ("2 of 524"), pas recalcules.
  function getPageInfoFromDOM() {
    var els = document.querySelectorAll("button, span");
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || "").trim();
      var m = t.match(/^(\d+)\s+of\s+(\d+)$/i);
      if (m) return { page: parseInt(m[1], 10), total: parseInt(m[2], 10) };
    }
    return null;
  }

  // ── Resolve/create entités ─────────────────────────────────────────────────

  var Q_STUDIO_IMAGE = "query StudioImg($id:ID!){findStudio(id:$id){id image_path details}}";

  var Q_FS        = "query FS($n:String!){findStudios(studio_filter:{name:{value:$n,modifier:EQUALS}},filter:{per_page:1}){studios{id name}}}";
  var Q_FS_ALIAS  = "query FSA($n:String!){findStudios(studio_filter:{aliases:{value:$n,modifier:EQUALS}},filter:{per_page:5}){studios{id name aliases}}}";
  var Q_FS_SEARCH = "query FSS($n:String!){findStudios(studio_filter:{name:{value:$n,modifier:INCLUDES}},filter:{per_page:8}){studios{id name}}}";
  var M_CS        = "mutation CS($n:String!,$image:String,$url:String){studioCreate(input:{name:$n,image:$image,url:$url}){id}}";
  var Q_FP        = "query FP($n:String!){findPerformers(performer_filter:{name:{value:$n,modifier:EQUALS}},filter:{per_page:1}){performers{id}}}";
  var Q_FP_SEARCH       = "query FPS($n:String!){findPerformers(performer_filter:{name:{value:$n,modifier:INCLUDES}},filter:{per_page:10}){performers{id name image_path}}}";
  var Q_FP_SEARCH_ALIAS = "query FPSA($n:String!){findPerformers(performer_filter:{aliases:{value:$n,modifier:INCLUDES}},filter:{per_page:10}){performers{id name image_path}}}";
  var Q_FP_IMAGE        = "query FPImg($id:ID!){findPerformer(id:$id){id image_path}}";
  var M_CP = "mutation CP($n:String!,$disambiguation:String,$urls:[String!],$gender:GenderEnum,$birthdate:String,$ethnicity:String,$country:String,$eye_color:String,$height_cm:Int,$measurements:String,$fake_tits:String,$penis_length:Float,$circumcised:CircumcisedEnum,$career_start:String,$career_end:String,$tattoos:String,$piercings:String,$alias_list:[String!],$image:String,$details:String,$death_date:String,$hair_color:String,$weight:Int){performerCreate(input:{name:$n,disambiguation:$disambiguation,urls:$urls,gender:$gender,birthdate:$birthdate,ethnicity:$ethnicity,country:$country,eye_color:$eye_color,height_cm:$height_cm,measurements:$measurements,fake_tits:$fake_tits,penis_length:$penis_length,circumcised:$circumcised,career_start:$career_start,career_end:$career_end,tattoos:$tattoos,piercings:$piercings,alias_list:$alias_list,image:$image,details:$details,death_date:$death_date,hair_color:$hair_color,weight:$weight}){id}}";
  var Q_FT = "query FT($n:String!){findTags(tag_filter:{name:{value:$n,modifier:EQUALS}},filter:{per_page:1}){tags{id}}}";
  var M_CT = "mutation CT($n:String!){tagCreate(input:{name:$n}){id}}";
  var M_IU = "mutation ImageUpdate($input:ImageUpdateInput!){imageUpdate(input:$input){id title}}";

  // ── Other studios (compatible avec le plugin skExtra-Multiple-Studios-Custom) ──
  // Meme convention de custom_fields, ecrite directement en GraphQL ici : pas de
  // dependance JS entre les plugins, seulement un accord sur les noms de champs.
  var CF_OTHER       = "skExtra_MS_Other";
  var CF_BACK_IMAGE  = "skExtra_MS_Other_Images";
  var Q_IMAGE_CF  = "query ImageCF($id:ID!){findImage(id:$id){custom_fields}}";
  var Q_STUDIO_CF = "query StudioCF($id:ID!){findStudio(id:$id){custom_fields}}";
  var M_IMAGE_CF_UPDATE  = "mutation ImageCFUpdate($input:ImageUpdateInput!){imageUpdate(input:$input){id}}";
  var M_STUDIO_CF_UPDATE = "mutation StudioCFUpdate($input:StudioUpdateInput!){studioUpdate(input:$input){id}}";

  function mergePipeList(current, idsToAdd) {
    var ids = (current || "").split("|").filter(Boolean);
    idsToAdd.forEach(function (id) {
      id = String(id);
      if (ids.indexOf(id) === -1) ids.push(id);
    });
    return ids.length ? ids.join("|") + "|" : "";
  }

  // Lie une image a une liste de studios "secondaires" (autres que le studio
  // principal) via les memes custom_fields que skExtra-Multiple-Studios-Custom.
  function linkOtherStudios(imageID, studioIds) {
    if (!studioIds || !studioIds.length) return Promise.resolve();
    imageID = String(imageID);

    return gql("ImageCF", Q_IMAGE_CF, { id: imageID }).then(function (d) {
      var current = d.findImage && d.findImage.custom_fields ? d.findImage.custom_fields[CF_OTHER] : "";
      var newImageField = mergePipeList(current, studioIds);

      var imagePromise = gql("ImageCFUpdate", M_IMAGE_CF_UPDATE, {
        input: { id: imageID, custom_fields: { partial: (function () { var o = {}; o[CF_OTHER] = newImageField; return o; })() } }
      });

      var studioPromises = studioIds.map(function (studioId) {
        studioId = String(studioId);
        return gql("StudioCF", Q_STUDIO_CF, { id: studioId }).then(function (d2) {
          var currentBack = d2.findStudio && d2.findStudio.custom_fields ? d2.findStudio.custom_fields[CF_BACK_IMAGE] : "";
          var ids = (currentBack || "").split("|").filter(Boolean);
          if (ids.indexOf(imageID) === -1) {
            ids.push(imageID);
            var newBack = ids.length ? ids.join("|") + "|" : "";
            return gql("StudioCFUpdate", M_STUDIO_CF_UPDATE, {
              input: { id: studioId, custom_fields: { partial: (function () { var o = {}; o[CF_BACK_IMAGE] = newBack; return o; })() } }
            });
          }
        });
      });

      return Promise.all([imagePromise].concat(studioPromises));
    });
  }

  function resolveOrCreate(fq, fo, fk, sk, cm, co, ck, name) {
    return gql(fo, fq, { n: name }).then(function (d) {
      var lst = (d[fk] || {})[sk] || [];
      if (lst.length) return lst[0].id;
      return gql(co, cm, { n: name }).then(function (d2) { return d2[ck].id; });
    });
  }

  // Cache global (partage entre toutes les lignes/images) nom→id utilise
  // uniquement pour le badge "new" affiche a l'ecran. Reste separe de la
  // resolution faite au clic Apply (resolveStudio) - celle-ci reste la
  // source de verite pour la creation/liaison reelle, ce cache ne corrige
  // que l'affichage. Deux cas distincts de faux-"new" corriges :
  // 1. Un candidat detecte comme new a cause d'un [id] manquant dans
  //    Details, ou parce qu'il n'existe que sous un alias, pas le nom
  //    principal.
  // 2. Un candidat dont le SCRAPER n'a tout simplement jamais renseigne
  //    stored_id - beaucoup de scrapers communautaires ne font pas leur
  //    propre lookup d'id studio, donc meme une correspondance exacte de
  //    nom revient marquee "new" depuis la reponse de scrape de Stash.
  //    C'est pourquoi une verification par nom exact doit aussi tourner
  //    ici, pas seulement une verification d'alias.
  // undefined = jamais verifie, null = verifie et non trouve, sinon = id.
  var studioAliasBadgeCache = {};
  // Nom canonique (studio parent) de chaque candidat resolu - sert a
  // afficher le nom du studio existant plutot que l'alias scrappe.
  var studioNameCache = {};

  function getCachedStudioAliasId(name) {
    if (!name) return null;
    return studioAliasBadgeCache[name.toLowerCase()];
  }

  // Verifie en arriere-plan, pour une liste de noms candidats "new" pas
  // encore en cache, s'ils correspondent en fait a un studio existant -
  // nom exact d'abord, puis alias - et met a jour le cache. Ne fait aucun
  // appel pour un nom deja verifie (cache hit, trouve ou non), pour
  // limiter le cout reseau sur un scrape en masse.
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
    // Cle insensible a la casse et a espace/underscore : un alias stocke
    // "unknown_showhey" doit matcher un "unknown showhey" scrappe.
    function normName(s) { return String(s).toLowerCase().replace(/_/g, " ").trim(); }
    return Promise.all(toCheck.map(function (n) {
      return gql("FS", Q_FS, { n: n }).then(function (d) {
        var exact = (d.findStudios || {}).studios || [];
        if (exact.length) {
          studioAliasBadgeCache[n.toLowerCase()] = exact[0].id;
          studioNameCache[n.toLowerCase()] = exact[0].name;
          return true;
        }
        var variants = [n, n.replace(/ /g, "_"), n.replace(/_/g, " ")].filter(function (v, i, a) { return a.indexOf(v) === i; });
        return Promise.all(variants.map(function (v) {
          return gql("FSA", Q_FS_ALIAS, { n: v }).then(function (d2) { return (d2.findStudios || {}).studios || []; });
        })).then(function (lists) {
          var studios = [].concat.apply([], lists);
          var match = null;
          for (var i = 0; i < studios.length && !match; i++) {
            var aliases = studios[i].aliases || [];
            for (var j = 0; j < aliases.length; j++) {
              if (normName(aliases[j]) === normName(n)) {
                match = studios[i].id;
                studioNameCache[n.toLowerCase()] = studios[i].name;
                break;
              }
            }
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

  // resolveStudio cherche d'abord par nom exact, puis par alias, puis crée.
  // Accepte soit un nom (string), soit l'objet studio scrappé complet
  // ({name, image, url}) pour que le logo/URL soient repris a la creation.
  function resolveStudio(studioOrName) {
    var studio = typeof studioOrName === "string" ? { name: studioOrName } : (studioOrName || {});
    var name = studio.name;
    return gql("FS", Q_FS, { n: name }).then(function (d) {
      var lst = (d.findStudios || {}).studios || [];
      if (lst.length) return lst[0].id;
      return gql("FSA", Q_FS_ALIAS, { n: name }).then(function (d2) {
        var studios = (d2.findStudios || {}).studios || [];
        for (var i = 0; i < studios.length; i++) {
          var s = studios[i];
          var aliases = s.aliases || [];
          for (var j = 0; j < aliases.length; j++) {
            if (aliases[j].toLowerCase() === name.toLowerCase()) return s.id;
          }
        }
        return gql("CS", M_CS, { n: name, image: studio.image || null, url: studio.url || null })
          .then(function (d3) { return d3.studioCreate.id; });
      });
    });
  }

  // resolvePerformer cherche par nom exact, puis crée en reprenant tous les
  // champs scrappés (image, urls, birthdate, mensurations...) si disponibles -
  // accepte soit un nom (string), soit l'objet performer scrappé complet.
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

  var M_STUDIO_UPD = "mutation SU($input:StudioUpdateInput!){studioUpdate(input:$input){id}}";

  // Fill in the logo / banner (details "bg:<url>") of an EXISTING studio from the
  // scrape, only where it has none - never overwrites what is already there.
  function enrichStudio(id, studio) {
    if (!id || !studio || (!studio.image && !studio.details)) return Promise.resolve(id);
    return gql("StudioImg", Q_STUDIO_IMAGE, { id: id }).then(function (d) {
      var cur = (d && d.findStudio) || {};
      var input = { id: String(id) };
      if (studio.image && (!cur.image_path || /default=true/.test(cur.image_path))) input.image = studio.image;
      if (studio.details && !/(?:^|\s)bg:\S+/.test(cur.details || "")) {
        input.details = cur.details ? cur.details + "\n" + studio.details : studio.details;
      }
      if (Object.keys(input).length === 1) return id;
      return gql("SU", M_STUDIO_UPD, { input: input }).then(function () { return id; });
    }).catch(function () { return id; });
  }

  function applyScrapedData(imageID, scraped) {
    // scraped.studio peut avoir été remplacé par un artiste choisi via radio
    var p_studio = scraped.studio && scraped.studio.name
      ? (scraped.studio.stored_id ? Promise.resolve(scraped.studio.stored_id) : resolveStudio(scraped.studio))
        .then(function (sid) { return enrichStudio(sid, scraped.studio); })
      : Promise.resolve(null);

    var p_perfs = Promise.all((scraped.performers || []).map(function (p) {
      if (!p || !p.name) return Promise.resolve(null);
      return p.stored_id ? Promise.resolve(p.stored_id) : resolvePerformer(p);
    }));

    var p_tags = Promise.all((scraped.tags || []).map(function (t) {
      if (!t || !t.name) return Promise.resolve(null);
      return t.stored_id ? Promise.resolve(t.stored_id) : resolveTag(t.name);
    }));

    // Studios "candidats" (ligne Artists:) non retenus comme studio principal.
    var p_otherStudios = (pluginConfig.autoAddOtherStudios || multiStudioActive()) && scraped.otherStudioNames && scraped.otherStudioNames.length
      ? Promise.all(scraped.otherStudioNames.map(function (name) { return resolveStudio(name); }))
      : Promise.resolve([]);

    return Promise.all([p_studio, p_perfs, p_tags, p_otherStudios]).then(function (res) {
      var inp = { id: String(imageID) };
      if (scraped.title)       inp.title       = scraped.title;
      if (scraped.date)        inp.date        = scraped.date;
      if (scraped.code)        inp.code        = scraped.code;
      if (scraped.photographer)inp.photographer= scraped.photographer;
      if (scraped.details) inp.details = scraped.details.replace(/\[(\w+)\]/g, "");
      var applyUrls = visibleScrapedUrls(scraped);
      if (applyUrls && applyUrls.length) inp.urls = applyUrls;
      if (res[0])          inp.studio_id     = res[0];
      var pids = res[1].filter(Boolean);
      var tids = res[2].filter(Boolean);
      if (pids.length) inp.performer_ids = pids;
      if (tids.length) inp.tag_ids       = tids;
      if (state.rows[imageID] && state.rows[imageID].markOrganized) inp.organized = true;
      var otherStudioIds = res[3].filter(Boolean);

      return gql("ImageUpdate", M_IU, { input: inp }).then(function (updateResult) {
        if (!otherStudioIds.length) return updateResult;
        return linkOtherStudios(imageID, otherStudioIds)
          .catch(function (e) { console.error("[imageTagger] linkOtherStudios:", e); })
          .then(function () { return updateResult; });
      });
    });
  }


  // ── Configuration plugin (Settings → Plugins → imageTagger) ───────────────

  var Q_GET_CONFIG = "query GetPluginConfig { configuration { plugins } }";
  var M_SET_CONFIG = "mutation SetPluginConfig($input: Map!) { configurePlugin(plugin_id: \"imageTagger\", input: $input) }";

  var pluginConfig = {
    autoCheckStudio:          false,
    autoCheckPerformer:       false,
    autoCheckNewTags:         false,
    autoCheckDetails:         false,
    prioritizeExistingStudio: true,
    studioBlacklist:          [],  // noms en lowercase
    // Ajoute automatiquement les candidats "Artists:" non retenus comme studio
    // principal en "Other studios" (compatible skExtra-Multiple-Studios-Custom)
    autoAddOtherStudios:      false,
    // Chaine de repli scrapers : [{id, enabled}, ...] dans l'ordre de priorite.
    // Reconciliee avec la liste reelle des scrapers a chaque chargement (voir
    // reconcileScraperChain) - jamais vide une fois les scrapers charges.
    scraperChain:             [],
    // "auto" = chaine de repli (scraperChain), "manual" = un seul scraper
    // choisi via le select du header (ancien comportement).
    scraperMode:              "auto",
    // Si active, essaie scrapeImageURL() sur la 1ere URL deja enregistree sur
    // l'image avant la chaine/le mode manuel (agnostique du scraper).
    useUrlIfPresent:          false,
    // Si active, un scrape en echec affiche le panel habituel (empty) pour
    // remplir studio/performers/tags/details a la main au lieu d'un simple
    // message d'erreur.
    manualFallbackOnFail:      false,
    // Sous-option (effet seulement si manualFallbackOnFail est active) :
    // ajoute un champ texte pour saisir le titre a la main.
    manualFallbackAllowTitle:  false,
    // Solo mode (/images/<id>) : si active et si le scraper renvoie une image,
    // affiche la comparaison cote a cote entre l'image existante et l'image
    // scrapee (utile pour detecter les reassignations d'ID sur rule34.xxx etc.)
    compareImageOnScrape:      false,
    // Mode solo : cache la mini vignette + nom de fichier de la ligne de
    // resultat (redondante avec le bloc image en haut du panel).
    hideSoloRowThumb:          false,
    // Mode solo : cache le bouton Auto/Manuel + son combobox (et toute la
    // barre d'en-tete si elle finit vide) - pour les gens qui n'y touchent
    // jamais et preferent recuperer l'espace vertical.
    hideScraperModeToggle:     false,
    // Si active, marque les images comme organized lors du Apply (sauf si le
    // bouton "Organized" de la ligne est desactive manuellement).
    autoMarkOrganized:         false,
    // Cache le logo / la banniere studio dans les cartes studio.
    hideStudioBanner:          false,
    hideStudioLogo:            false,
    // Mode masse : scinde la section Performers et Tags en "Deja sur cette image"
    // et "New from scrape" (comme en mode solo).
    splitExistingNew:          false,
    // Mode masse : affiche un textarea editable pour Details au lieu de la
    // puce courte.
    detailsEditorInList:       false,
    // Sous-option de splitExistingNew : cote a cote au lieu de empile.
    splitSideBySide:           false,
    // Layout (same model as sceneTagger): the panel is wide by default,
    // compactMode = small floating panel (the old default of imageTagger,
    // migrated from the former wideMode setting - see loadPluginConfig).
    compactMode:               false,
    // Panel covers the whole window on desktop too (already the case on
    // touch screens / narrow windows).
    fullscreenOnDesktop:       false,
    // Same, for the single image panel (/images/<id>): independent from the mass list.
    fullscreenSolo:            false,
    // "SFW" header button: blurs every image preview in the panel.
    nsfwBlur:                  false,
    // Blue outline around a scraped row (state "scraped, ready to apply").
    scrapedOutline:            true,
    // Copy icon on the existing Details text: always visible (otherwise on hover).
    copyIconAlways:            false,
    // Progress veil over a row being scraped (simulated curve) + status line.
    progressVeil:              true,
    progressText:              true,
    // Smooth hand-over from the veil to the scraped result (fade, grow, flare).
    progressTransition:        true,
    // Pre-fill the manual title with the file name (extension stripped).
    manualFallbackPrefillFilename: true,
    // Hides the "IT" badge button on the image page.
    hideToolbarButton:         false,
    // "Modern layout" (mass list, scraped rows): details go to the right of the
    // image, the studio becomes a banner header (class .it-banner-layout on #it-panel).
    studioBannerLayout:        false,
    // "Details in one card" (needs Modern layout): Title/Date/Performers/Tags/URLs/
    // Details share ONE card (class .it-one-card); oneCardCols = two columns inside it.
    oneCard:                   false,
    oneCardCols:               true,
    // Stash UI liquid glass only: frosted glass panel (body class it-opaque), solid fill % / blur px.
    opaquePanel:               true,
    glassSolid:                82,
    glassBlur:                 40,
    // Stash UI list only (infinite scroll there): images loaded per page in the panel.
    stashuiPerPage:            40,
    // Azure halo flash on a row when it is applied (same flare as the scrape hand-over).
    applyFlare:                true,
    // Skip removes the row from the list instead of keeping it as "skipped" (mass list only).
    ejectSkipped:              false,
    // Header badge shows the image's own title (when it has one) instead of the file name.
    showImageTitleInHeader:    false,
    // Several studios per image: a "+" next to each candidate adds it as an "Other studio".
    // Only active when the skExtra-Multiple-Studios-Custom plugin is installed and enabled.
    multiStudioSelect:         false
  };

  function loadPluginConfig() {
    return gql("GetPluginConfig", Q_GET_CONFIG)
      .then(function(d) {
        var plugins = d.configuration && d.configuration.plugins;
        if (plugins && plugins.imageTagger) {
          var cfg = plugins.imageTagger;
          if (cfg.autoCheckStudio          !== undefined) pluginConfig.autoCheckStudio          = !!cfg.autoCheckStudio;
          if (cfg.autoCheckPerformer       !== undefined) pluginConfig.autoCheckPerformer       = !!cfg.autoCheckPerformer;
          if (cfg.autoCheckNewTags         !== undefined) pluginConfig.autoCheckNewTags         = !!cfg.autoCheckNewTags;
          if (cfg.autoCheckDetails         !== undefined) pluginConfig.autoCheckDetails         = !!cfg.autoCheckDetails;
          if (cfg.prioritizeExistingStudio !== undefined) pluginConfig.prioritizeExistingStudio = !!cfg.prioritizeExistingStudio;
          if (cfg.compactMode              !== undefined) pluginConfig.compactMode              = !!cfg.compactMode;
          else if (cfg.wideMode            !== undefined) pluginConfig.compactMode              = !cfg.wideMode;  // migration from the former wideMode setting
          if (cfg.fullscreenOnDesktop      !== undefined) pluginConfig.fullscreenOnDesktop      = !!cfg.fullscreenOnDesktop;
          if (cfg.fullscreenSolo           !== undefined) pluginConfig.fullscreenSolo           = !!cfg.fullscreenSolo;
          if (cfg.nsfwBlur                 !== undefined) pluginConfig.nsfwBlur                 = !!cfg.nsfwBlur;
          if (cfg.scrapedOutline           !== undefined) pluginConfig.scrapedOutline           = !!cfg.scrapedOutline;
          if (cfg.copyIconAlways           !== undefined) pluginConfig.copyIconAlways           = !!cfg.copyIconAlways;
          if (cfg.progressVeil             !== undefined) pluginConfig.progressVeil             = !!cfg.progressVeil;
          if (cfg.progressText             !== undefined) pluginConfig.progressText             = !!cfg.progressText;
          if (cfg.progressTransition       !== undefined) pluginConfig.progressTransition       = !!cfg.progressTransition;
          if (cfg.manualFallbackPrefillFilename !== undefined) pluginConfig.manualFallbackPrefillFilename = !!cfg.manualFallbackPrefillFilename;
          if (cfg.hideToolbarButton        !== undefined) pluginConfig.hideToolbarButton        = !!cfg.hideToolbarButton;
          if (cfg.studioBannerLayout       !== undefined) pluginConfig.studioBannerLayout       = !!cfg.studioBannerLayout;
          if (cfg.oneCard                  !== undefined) pluginConfig.oneCard                  = !!cfg.oneCard;
          if (cfg.oneCardCols              !== undefined) pluginConfig.oneCardCols              = !!cfg.oneCardCols;
          if (cfg.opaquePanel              !== undefined) pluginConfig.opaquePanel              = !!cfg.opaquePanel;
          if (typeof cfg.glassSolid === "number") pluginConfig.glassSolid = cfg.glassSolid;
          if (typeof cfg.glassBlur === "number") pluginConfig.glassBlur = cfg.glassBlur;
          if (typeof cfg.stashuiPerPage === "number") pluginConfig.stashuiPerPage = cfg.stashuiPerPage;
          if (cfg.applyFlare               !== undefined) pluginConfig.applyFlare               = !!cfg.applyFlare;
          if (cfg.ejectSkipped             !== undefined) pluginConfig.ejectSkipped             = !!cfg.ejectSkipped;
          if (cfg.showImageTitleInHeader   !== undefined) pluginConfig.showImageTitleInHeader   = !!cfg.showImageTitleInHeader;
          if (cfg.multiStudioSelect        !== undefined) pluginConfig.multiStudioSelect        = !!cfg.multiStudioSelect;
          if (cfg.autoAddOtherStudios      !== undefined) pluginConfig.autoAddOtherStudios      = !!cfg.autoAddOtherStudios;
          if (cfg.scraperMode === "auto" || cfg.scraperMode === "manual") pluginConfig.scraperMode = cfg.scraperMode;
          if (cfg.useUrlIfPresent !== undefined) pluginConfig.useUrlIfPresent = !!cfg.useUrlIfPresent;
          if (cfg.manualFallbackOnFail     !== undefined) pluginConfig.manualFallbackOnFail     = !!cfg.manualFallbackOnFail;
          if (cfg.manualFallbackAllowTitle !== undefined) pluginConfig.manualFallbackAllowTitle = !!cfg.manualFallbackAllowTitle;
          if (cfg.compareImageOnScrape     !== undefined) pluginConfig.compareImageOnScrape     = !!cfg.compareImageOnScrape;
          if (cfg.hideSoloRowThumb         !== undefined) pluginConfig.hideSoloRowThumb         = !!cfg.hideSoloRowThumb;
          if (cfg.hideScraperModeToggle    !== undefined) pluginConfig.hideScraperModeToggle    = !!cfg.hideScraperModeToggle;
          if (cfg.autoMarkOrganized        !== undefined) pluginConfig.autoMarkOrganized        = !!cfg.autoMarkOrganized;
          if (cfg.hideStudioBanner         !== undefined) pluginConfig.hideStudioBanner         = !!cfg.hideStudioBanner;
          if (cfg.hideStudioLogo           !== undefined) pluginConfig.hideStudioLogo           = !!cfg.hideStudioLogo;
          if (cfg.splitExistingNew         !== undefined) pluginConfig.splitExistingNew         = !!cfg.splitExistingNew;
          if (cfg.splitSideBySide          !== undefined) pluginConfig.splitSideBySide          = !!cfg.splitSideBySide;
          if (cfg.detailsEditorInList      !== undefined) pluginConfig.detailsEditorInList      = !!cfg.detailsEditorInList;
          if (cfg.scraperChain !== undefined) {
            try {
              var parsed = typeof cfg.scraperChain === "string" ? JSON.parse(cfg.scraperChain) : cfg.scraperChain;
              if (Array.isArray(parsed)) pluginConfig.scraperChain = parsed;
            } catch (e) {}
          }
          if (cfg.studioBlacklist !== undefined) {
            var raw = typeof cfg.studioBlacklist === "string" ? cfg.studioBlacklist : (Array.isArray(cfg.studioBlacklist) ? cfg.studioBlacklist.join(",") : "");
            pluginConfig.studioBlacklist = raw ? raw.split(",").map(function(s){ return s.trim().toLowerCase(); }).filter(Boolean) : [];
          }
        }
        applyLayoutClasses();
      })
      .catch(function() {})
      .then(detectMultiStudioPlugin);
  }

  // Is the skExtra-Multiple-Studios-Custom plugin installed AND enabled? The "several studios"
  // option stays inactive (greyed out) without it: only one studio can be picked then.
  var msPluginInstalled = false;
  function detectMultiStudioPlugin() {
    return gql("PluginsList", "query PluginsList { plugins { id name enabled } }")
      .then(function (d) {
        msPluginInstalled = (d.plugins || []).some(function (p) {
          return p.enabled !== false && /multiple-?studios/i.test((p.id || "") + " " + (p.name || ""));
        });
      })
      .catch(function () { msPluginInstalled = false; });
  }
  function multiStudioActive() { return !!pluginConfig.multiStudioSelect && msPluginInstalled; }

  function savePluginConfig() {
    var toSave = Object.assign({}, pluginConfig, {
      studioBlacklist: pluginConfig.studioBlacklist.join(", "),
      scraperChain:    JSON.stringify(pluginConfig.scraperChain)
    });
    applyLayoutClasses();
    return gql("SetPluginConfig", M_SET_CONFIG, { input: toSave })
      .catch(function() {});
  }

  function applyLayoutClasses() {
    document.body.classList.toggle("it-split-existing-new", !!pluginConfig.splitExistingNew);
    document.body.classList.toggle("it-split-side",         !!pluginConfig.splitSideBySide);
    document.body.classList.toggle("it-opaque",             !!pluginConfig.opaquePanel);
    document.body.style.setProperty("--it-gsolid", Math.min(100, Math.max(40, pluginConfig.glassSolid)) + "%");
    document.body.style.setProperty("--it-gblur", Math.min(80, Math.max(0, pluginConfig.glassBlur)) + "px");
  }

  function stashuiPerPage(v) {
    v = parseInt(v === undefined ? pluginConfig.stashuiPerPage : v, 10);
    return isFinite(v) ? Math.min(200, Math.max(5, v)) : 40;
  }

  // Filet independant de config.yml : ecrit la blacklist studios dans un
  // fichier JSON local (studioBlacklist_backup.json, voir blacklistBackup.py)
  // via une tache plugin. Non bloquant, appele uniquement apres un
  // changement de studioBlacklist (pas a chaque savePluginConfig()).
  var M_RUN_BLACKLIST_BACKUP = 'mutation RunBlacklistBackup { runPluginTask(plugin_id: "imageTagger", task_name: "Backup studio blacklist") }';
  function backupBlacklist() {
    // Public build: the "Backup studio blacklist" task (blacklistBackup.py) is not shipped, nothing to run.
    return;
  }

  // Fusionne pluginConfig.scraperChain avec la liste reelle des scrapers
  // disponibles : garde l'ordre/etat coche existant pour ceux connus, ajoute
  // les nouveaux a la fin (actives par defaut), retire ceux qui n'existent plus.
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

  function isBlacklisted(name) {
    if (!name) return false;
    return pluginConfig.studioBlacklist.indexOf(name.toLowerCase()) !== -1;
  }

  // ── État ───────────────────────────────────────────────────────────────────

  var state = {
    images:    [],
    rows:      {},   // id -> { image, status, scraped, checks }
    running:   false,
    visible:   false,
    scrapers:  [],
    manualScraperID: "",  // scraper choisi en mode manuel
    studioFilter: "all",  // "all" | "new" | "existing"
    multiStudioOnly: false, // cumulatif AND avec studioFilter : lignes avec >=2 candidats studio
    scraperFilter: "all",   // "all" | un scraperID (seuls les scrapers avec >=1 resultat sont listes)
    currentPage: 1,
    totalPages:  1
  };

  // ── Navigation page (change ?p= dans l'URL, fait naviguer toute la SPA
  // Stash comme un vrai clic sur la pagination native, garde tout synchro).
  // Le parametre s'appelle "p" (pas "page") - verifie empiriquement.
  function goToPage(newPage) {
    newPage = Math.min(Math.max(newPage, 1), state.totalPages || 1);
    if (newPage === state.currentPage) return;
    if (_host) {
      state.currentPage = newPage;
      state.images = [];
      loadImages();
      return;
    }
    var p = new URLSearchParams(window.location.search);
    p.set("p", String(newPage));
    var href = window.location.pathname + "?" + p.toString();
    window.history.pushState(null, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s || "")
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  // ── Studio cards ───────────────────────────────────────────────────────────

  var IT_STUDIO_LOGO_PLACEHOLDER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 21V10a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v11"/></svg>';

  // Round logo when image is roughly square, wide corners when elongated.
  // "load" doesn't bubble, so capture it.
  document.addEventListener("load", function (e) {
    var img = e.target;
    if (!img || img.tagName !== "IMG" || !img.naturalHeight) return;
    var box = img.closest && img.closest(".it-slogo");
    if (!box) return;
    var ratio = img.naturalWidth / img.naturalHeight;
    var round = ratio >= 0.8 && ratio <= 1.25;
    box.classList.toggle("it-slogo-round", round);
    box.classList.toggle("it-slogo-wide", !round);
    box.classList.toggle("it-slogo-transparent", logoHasTransparentEdges(img));
  }, true);

  // True when the image's outer edge is mostly transparent (a logo with no
  // background): the card then drops its dark frame and shadows the logo
  // shape instead. Cross-origin images taint the canvas -> treated as opaque.
  function logoHasTransparentEdges(img) {
    try {
      var n = 32, c = document.createElement("canvas");
      c.width = n; c.height = n;
      var ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, n, n);
      var d = ctx.getImageData(0, 0, n, n).data, clear = 0, total = 0;
      for (var i = 0; i < n; i++) {
        [[i, 0], [i, n - 1], [0, i], [n - 1, i]].forEach(function (p) {
          total++;
          if (d[(p[1] * n + p[0]) * 4 + 3] < 40) clear++;
        });
      }
      return clear / total > 0.8;
    } catch (e) { return false; }
  }

  function studioBannerUrlIT(studioObj) {
    if (pluginConfig.hideStudioBanner) return null;
    var m = studioObj && studioObj.details ? String(studioObj.details).match(/(?:^|\s)bg:(\S+)/) : null;
    return m ? m[1] : null;
  }

  function studioLogoInnerIT(imgUrl, studioId) {
    var img = '<img src="' + esc(imgUrl) + '">';
    return studioId
      ? '<a href="/studios/' + esc(String(studioId)) + '" target="_blank" rel="noopener" title="Open studio">' + img + '</a>'
      : img;
  }

  function studioCardHTMLIT(logoUrl, bannerUrl, infoHTML, cardClass, lookupId, studioId, captionHTML) {
    var logo = pluginConfig.hideStudioLogo
      ? ''
      : (logoUrl
          ? '<div class="it-slogo it-slogo-round">' + studioLogoInnerIT(logoUrl, studioId) + '</div>'
          : '<div class="it-slogo it-slogo-round it-slogo-empty">' + IT_STUDIO_LOGO_PLACEHOLDER_SVG + '</div>');
    return '<div class="it-studio-card' + (cardClass ? ' ' + cardClass : '') + '"' +
      (lookupId ? ' data-studio-lookup="' + esc(String(lookupId)) + '"' : '') + '>' +
      (captionHTML ? '<div class="it-studio-caption">' + captionHTML + '</div>' : '') +
      (bannerUrl
        ? '<a class="it-studio-cover" href="' + esc(bannerUrl) + '" target="_blank" rel="noopener" title="Open banner"><img src="' + esc(bannerUrl) + '"></a>'
        : '') +
      '<div class="it-studio-idrow' + (bannerUrl ? ' it-has-cover' : '') + '">' +
        logo +
        '<div class="it-studio-info">' + infoHTML + '</div>' +
      '</div>' +
    '</div>';
  }

  function fillStudioCardIT(card, imgUrl, bannerUrl, onlyMissing, studioId) {
    var idrow = card.querySelector(".it-studio-idrow");
    var logo = card.querySelector(".it-slogo");
    if (!idrow) return;
    if (logo && imgUrl && !pluginConfig.hideStudioLogo) {
      var hasLogo = !logo.classList.contains("it-slogo-empty");
      if (!onlyMissing || !hasLogo) {
        logo.classList.remove("it-slogo-empty", "it-slogo-wide");
        logo.classList.add("it-slogo-round");
        logo.innerHTML = studioLogoInnerIT(imgUrl, studioId);
      }
    }
    if (bannerUrl && !card.querySelector(".it-studio-cover")) {
      var cover = document.createElement("a");
      cover.className = "it-studio-cover";
      cover.href = bannerUrl;
      cover.target = "_blank";
      cover.rel = "noopener";
      cover.title = "Open banner";
      cover.innerHTML = '<img src="' + esc(bannerUrl) + '">';
      card.insertBefore(cover, idrow);
      idrow.classList.add("it-has-cover");
    }
  }

  function setManualStudioCardIT(el, imgUrl, bannerUrl, studioId) {
    var card = el.querySelector(".it-studio-manual-card");
    if (!card) {
      setListPickedStudioIT(el, imgUrl, bannerUrl, studioId);
      return;
    }
    var idrow = card.querySelector(".it-studio-idrow");
    var logo = card.querySelector(".it-slogo");
    var oldCover = card.querySelector(".it-studio-cover");
    if (oldCover) oldCover.remove();
    if (idrow) idrow.classList.remove("it-has-cover");
    if (logo) {
      logo.classList.remove("it-slogo-wide", "it-slogo-round");
      logo.classList.add("it-slogo-round", "it-slogo-empty");
      logo.innerHTML = IT_STUDIO_LOGO_PLACEHOLDER_SVG;
    }
    fillStudioCardIT(card, imgUrl, bannerUrl, false, studioId);
  }

  function setListPickedStudioIT(el, imgUrl, bannerUrl, studioId) {
    var wrap = el.querySelector(".it-studio-search-wrap");
    if (!wrap) return;
    var old = wrap.querySelector(".it-studio-picked");
    if (old) old.remove();
    var logo = imgUrl && imgUrl.indexOf("default=true") === -1 ? imgUrl : null;
    if (pluginConfig.hideStudioLogo) logo = null;
    if (!logo && !bannerUrl) return;
    var holder = document.createElement("div");
    holder.className = "it-studio-picked";
    holder.innerHTML = studioCardHTMLIT(logo, bannerUrl, "", "it-card-stacked", null, studioId);
    wrap.insertBefore(holder, wrap.querySelector(".it-studio-selected"));
  }

  function hydrateStudioLookupsIT(el) {
    // Round logo in each row of the multi-studio radio list (existing studios only).
    el.querySelectorAll(".it-radio-logo[data-logo-id]").forEach(function (node) {
      if (node.getAttribute("data-lookup-done")) return;
      node.setAttribute("data-lookup-done", "1");
      fetchStudioHoverDataIT(node.getAttribute("data-logo-id")).then(function (data) {
        if (!data || !data.img) return;
        node.classList.remove("it-radio-logo-empty");
        node.style.display = "inline-flex";
        node.innerHTML = studioLogoInnerIT(data.img, node.getAttribute("data-logo-id"));
      });
    });
    el.querySelectorAll("[data-studio-lookup]").forEach(function (node) {
      if (node.getAttribute("data-lookup-done")) return;
      node.setAttribute("data-lookup-done", "1");
      gql("StudioImg", Q_STUDIO_IMAGE, { id: node.getAttribute("data-studio-lookup") }).then(function (d) {
        var st = d.findStudio || {};
        var img = st.image_path && st.image_path.indexOf("default=true") === -1 ? st.image_path : null;
        var banner = studioBannerUrlIT(st);
        if (pluginConfig.hideStudioLogo) img = null;
        if (!img && !banner) return;
        var lookupId = node.getAttribute("data-studio-lookup");
        if (node.classList.contains("it-studio-card")) {
          fillStudioCardIT(node, img, banner, true, lookupId);
          return;
        }
        var tmp = document.createElement("div");
        tmp.innerHTML = studioCardHTMLIT(img, banner, "", "it-card-stacked", null, lookupId);
        var card = tmp.firstChild;
        var info = card.querySelector(".it-studio-info");
        while (node.firstChild) info.appendChild(node.firstChild);
        node.appendChild(card);
      }).catch(function () {});
    });
  }

  // Hover card for multi-studio radio items
  var itStudioHoverCache = {};
  var itStudioHoverEl = null;
  var itStudioHoverToken = 0;
  var itStudioHoverCurrent = null;

  function fetchStudioHoverDataIT(id) {
    if (!id) return Promise.resolve(null);
    if (!itStudioHoverCache[id]) {
      itStudioHoverCache[id] = gql("StudioImg", Q_STUDIO_IMAGE, { id: id }).then(function (d) {
        var st = d.findStudio || {};
        var img = st.image_path && st.image_path.indexOf("default=true") === -1 ? st.image_path : null;
        var banner = null;
        var m = st.details ? String(st.details).match(/(?:^|\s)bg:(\S+)/) : null;
        if (m) banner = m[1];
        return { img: img, banner: banner };
      }).catch(function () { return null; });
    }
    return itStudioHoverCache[id];
  }

  function hideStudioHoverIT() {
    itStudioHoverToken++;
    itStudioHoverCurrent = null;
    if (itStudioHoverEl) { itStudioHoverEl.remove(); itStudioHoverEl = null; }
  }

  function showStudioHoverIT(label) {
    var name = label.getAttribute("data-studio-name") || "";
    var id = label.getAttribute("data-studio-id") || "";
    var token = ++itStudioHoverToken;
    itStudioHoverCurrent = label;
    fetchStudioHoverDataIT(id).then(function (data) {
      if (token !== itStudioHoverToken) return;
      var imgUrl = data && data.img && !pluginConfig.hideStudioLogo ? data.img : null;
      var banner = data && data.banner && !pluginConfig.hideStudioBanner ? data.banner : null;
      if (!imgUrl && !banner) return;
      var logoHTML = imgUrl
        ? '<div class="it-slogo it-slogo-round"><img src="' + esc(imgUrl) + '"></div>'
        : "";
      if (itStudioHoverEl) itStudioHoverEl.remove();
      var hoverEl = document.createElement("div");
      hoverEl.className = "it-studio-hover";
      hoverEl.innerHTML =
        (banner ? '<div class="it-sh-cover"><img src="' + esc(banner) + '"></div>' : '') +
        '<div class="it-sh-row' + (banner && logoHTML ? ' it-sh-overlap' : '') + '">' +
          logoHTML +
          '<div class="it-sh-text"><div class="it-sh-name">' + esc(name) + '</div></div>' +
        '</div>';
      document.body.appendChild(hoverEl);
      itStudioHoverEl = hoverEl;
      var rect = label.getBoundingClientRect();
      var w = hoverEl.offsetWidth, h = hoverEl.offsetHeight;
      var left = rect.right + 12;
      if (left + w > window.innerWidth - 8) left = Math.max(8, rect.left - w - 12);
      var top = Math.min(Math.max(8, rect.top - 6), window.innerHeight - h - 8);
      hoverEl.style.left = left + "px";
      hoverEl.style.top = top + "px";
    });
  }

  document.addEventListener("mouseover", function (e) {
    var label = e.target && e.target.closest ? e.target.closest(".it-radio-item[data-studio-name]") : null;
    if (label === itStudioHoverCurrent) return;
    if (itStudioHoverEl || itStudioHoverCurrent) hideStudioHoverIT();
    if (label) showStudioHoverIT(label);
  });

  function getFilename(img) {
    if (img.files && img.files.length) return img.files[0].basename || img.files[0].path || img.id;
    return img.title || String(img.id);
  }

  function getThumb(img) {
    return img.paths && img.paths.thumbnail ? img.paths.thumbnail : "";
  }

  function getR34ID(img) {
    if (img.urls) {
      for (var i = 0; i < img.urls.length; i++) {
        var m = img.urls[i].match(/[?&]id=(\d+)/);
        if (m) return m[1];
        var mv = img.urls[i].match(/rule34video\.com.*?\/(\d+)/);
        if (mv) return mv[1];
      }
    }
    var f = img.files && img.files.length ? (img.files[0].basename || img.files[0].path || "") : "";
    var m2 = f.match(/rule34[_\-]?(?:video[_\-])?(\d+)/i);
    return m2 ? m2[1] : null;
  }

  function getR34URL(img) {
    if (img.urls) {
      for (var i = 0; i < img.urls.length; i++) {
        if (img.urls[i].indexOf("rule34video") !== -1) return img.urls[i];
        if (img.urls[i].indexOf("rule34.xxx") !== -1)  return img.urls[i];
      }
    }
    var rid = getR34ID(img);
    if (!rid) return null;
    var f = img.files && img.files.length ? (img.files[0].basename || "") : "";
    if (/rule34video/i.test(f)) return "https://rule34video.com/videos/" + rid + "/";
    return "https://rule34.xxx/index.php?page=post&s=view&id=" + rid;
  }

  // ── Parser "Artists: a[id] | b[id2]" depuis details ──────────────────────
  // rule34-python écrit dans details :
  //   "Artists: artiste1[id1] | artiste2[id2]"
  // Retourne : { artists: [{name, stored_id},...], rest: "autres lignes ou null" }

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

  // ── Lire les checkboxes d'une ligne pour construire le scraped filtré ──────

  function getCheckedScraped(id) {
    var r = state.rows[id];
    if (!r || !r.scraped) return null;
    var scraped = r.scraped;
    var filtered = {};

    var row = document.getElementById("it-row-" + id);
    if (!row) return scraped;

    var cb = function(sel) { var el = row.querySelector(sel); return el ? el.checked : false; };

    if (cb('[data-cb="title"]')       && scraped.title)       filtered.title       = r.titleEdit || scraped.title;
    // Titre saisi manuellement (mode manualFallbackOnFail + manualFallbackAllowTitle)
    if (r.manualFallback && pluginConfig.manualFallbackAllowTitle) {
      var manualTitleEl = row.querySelector(".it-manual-title-input");
      var manualTitleVal = manualTitleEl ? manualTitleEl.value.trim() : (r.manualTitle || "");
      if (manualTitleVal) filtered.title = manualTitleVal;
    }
    // Date: solo mode has the custom calendar widget (value lives in row state);
    // the mass list keeps the plain checkbox over the raw scraped value.
    if (row.querySelector(".it-date-field")) {
      if (r.dateEditValue) filtered.date = r.dateEditValue;
    } else if (cb('[data-cb="date"]') && scraped.date) {
      filtered.date = scraped.date;
    }
    if (cb('[data-cb="code"]')        && scraped.code)        filtered.code        = scraped.code;
    if (cb('[data-cb="photographer"]')&& scraped.photographer)filtered.photographer= scraped.photographer;

    // Performers individuels
    var perfCbs = row.querySelectorAll('[data-cb="performer"]');
    var selectedPerfs = [];
    if (perfCbs.length && scraped.performers) {
      perfCbs.forEach(function(el) {
        if (el.checked) {
          var idx = parseInt(el.getAttribute("data-idx"), 10);
          if (scraped.performers[idx]) selectedPerfs.push(scraped.performers[idx]);
        }
      });
    }
    // Performers ajoutés manuellement : toujours collectés, même sans scrape
    var addedPerfs = row.querySelectorAll('[data-cb="performer-added"]');
    addedPerfs.forEach(function(el) {
      selectedPerfs.push({ stored_id: el.getAttribute("data-perf-id") || null, name: el.getAttribute("data-perf-name") });
    });
    if (selectedPerfs.length) filtered.performers = selectedPerfs;

    // Tags individuels
    var tagCbs = row.querySelectorAll('[data-cb="tag"]');
    var selectedTags = [];
    if (tagCbs.length && scraped.tags) {
      tagCbs.forEach(function(el) {
        if (el.checked) {
          var idx = parseInt(el.getAttribute("data-idx"), 10);
          if (scraped.tags[idx]) selectedTags.push(scraped.tags[idx]);
        }
      });
    }
    // Tags ajoutés manuellement via le widget de recherche
    var addedTagChips = row.querySelectorAll('[data-cb="tag-added"]');
    addedTagChips.forEach(function(chip) {
      selectedTags.push({ stored_id: chip.getAttribute("data-tag-id") || null, name: chip.getAttribute("data-tag-name") });
    });
    if (selectedTags.length) filtered.tags = selectedTags;

    // Details : mode solo, textarea toujours editable (voir renderRow) - lue
    // directement pour capter une edition en cours meme sans blur. Mode
    // masse : checkbox classique sur la valeur scrapee brute.
    var detailsEditEl = row.querySelector(".it-details-edit");
    if (detailsEditEl) {
      filtered.details = detailsEditEl.value;
    } else {
      var detailsCb = row.querySelector('[data-cb="details"]');
      if (detailsCb && detailsCb.checked && scraped.details) {
        filtered.details = scraped.details.replace(/\[(\w+)\]/g, "");
      }
    }

    // URLs: solo mode has the combined editable stack (existing + new + added, minus removed).
    if (r.urlEditList && r.urlEditList.length) {
      filtered.urls = r.urlEditList.map(function (u) { return u.value; });
    } else if (cb('[data-cb="urls"]') && scraped.urls) {
      filtered.urls = visibleScrapedUrls(scraped);
    }

    // Studio : priorité override manuel, puis radio, puis checkbox simple
    var overrideEl = row.querySelector('[data-cb="studio-override"]');
    if (overrideEl && overrideEl.value) {
      filtered.studio = { stored_id: overrideEl.getAttribute("data-studio-id"), name: overrideEl.value };
    } else {
      var studioRadios = row.querySelectorAll('[data-cb="studio-radio"]');
      if (studioRadios.length) {
        var chosenArtist = null;
        studioRadios.forEach(function(radio) {
          if (radio.checked) chosenArtist = radio.getAttribute("data-artist");
        });
        if (chosenArtist) filtered.studio = { name: chosenArtist };
      } else {
        var studioCb = row.querySelector('[data-cb="studio"]');
        if (studioCb && studioCb.checked && scraped.studio) {
          filtered.studio = scraped.studio;
        }
      }
    }

    // Candidats "Artists:" non retenus comme studio principal → "Other studios"
    // (uniquement calcule si l'option est active, cf. applyScrapedData)
    // With "several studios" on, the "+" boxes ticked by hand decide instead.
    var chosenName = filtered.studio ? filtered.studio.name : null;
    if (multiStudioActive()) {
      var picked = [];
      row.querySelectorAll('[data-cb="studio-also"].it-on:not(:disabled)').forEach(function (cb) {
        var n = cb.getAttribute("data-artist");
        if (n && n !== chosenName && picked.indexOf(n) === -1) picked.push(n);
      });
      if (picked.length) filtered.otherStudioNames = picked;
    } else if (pluginConfig.autoAddOtherStudios) {
      var allArtists = parseDetailsArtists(scraped.details).artists;
      var others = allArtists.filter(function (a) { return a.name !== chosenName; }).map(function (a) { return a.name; });
      if (others.length) filtered.otherStudioNames = others;
    }

    // Conserve toujours les performers/tags deja presents sur l'image -
    // performer_ids/tag_ids sur imageUpdate REMPLACENT la liste au lieu de
    // l'etendre, donc sans ca, appliquer un scrape qui ne mentionne
    // simplement pas un performer/tag deja present le supprimerait
    // silencieusement. Les pastilles "Deja sur cette image" (mode solo) ne
    // sont pas des checkboxes (voir renderRow) - toujours conservees, fusionnees
    // ici par ID. `name` inclus a cote de `stored_id` car applyScrapedData()
    // ignore toute entree sans `name` meme si stored_id est renseigne.
    var existingPerfIds = (filtered.performers || []).map(function(p) { return p.stored_id; }).filter(Boolean);
    (r.image.performers || []).forEach(function(p) {
      if (existingPerfIds.indexOf(p.id) === -1) {
        filtered.performers = (filtered.performers || []).concat([{ stored_id: p.id, name: p.name }]);
        existingPerfIds.push(p.id);
      }
    });
    var existingTagIds = (filtered.tags || []).map(function(t) { return t.stored_id; }).filter(Boolean);
    (r.image.tags || []).forEach(function(t) {
      if (existingTagIds.indexOf(t.id) === -1) {
        filtered.tags = (filtered.tags || []).concat([{ stored_id: t.id, name: t.name }]);
        existingTagIds.push(t.id);
      }
    });

    return filtered;
  }

  // ── Rendu d'une ligne ──────────────────────────────────────────────────────

  // Width share of the two existing / new columns (Performers, Tags): each gets a share
  // proportional to its number of items (bounded 30%-70%), so a long "Already on this
  // scene" list isn't squeezed into a narrow column while the other one is nearly empty.
  // Read by the CSS through --it-split-l / --it-split-r (falls back to the old widths).
  function splitShareStyle(nExisting, nNew) {
    var total = nExisting + nNew;
    var share = total ? nExisting / total : 0.5;
    share = Math.max(0.3, Math.min(0.7, share));
    return ' style="--it-split-l:' + share.toFixed(2) + 'fr;--it-split-r:' + (1 - share).toFixed(2) + 'fr"';
  }

  // Banner layout, multi-studio mass list: the card under the radios follows
  // whichever candidate is checked (name, logo, banner), "None" collapses it
  // to just the search box (class it-bl-empty).
  function setBLCard(card, name, logoUrl, bannerUrl, studioId) {
    var idrow = card.querySelector(".it-studio-idrow");
    var logo = card.querySelector(".it-slogo");
    var nameEl = card.querySelector(".it-bl-name");
    card.classList.toggle("it-bl-empty", !name);
    if (nameEl) nameEl.textContent = name || "";
    var oldCover = card.querySelector(".it-studio-cover");
    if (oldCover) oldCover.remove();
    idrow.classList.remove("it-has-cover");
    if (logo) {
      logo.classList.remove("it-slogo-wide", "it-slogo-round");
      logo.classList.add("it-slogo-round");
      if (logoUrl && !pluginConfig.hideStudioLogo) {
        logo.classList.remove("it-slogo-empty");
        logo.innerHTML = studioLogoInnerIT(logoUrl, studioId);
      } else {
        logo.classList.add("it-slogo-empty");
        logo.innerHTML = name ? '<span class="it-bl-initial">' + esc(name.charAt(0).toUpperCase()) + '</span>' : IT_STUDIO_LOGO_PLACEHOLDER_SVG;
      }
    }
    if (bannerUrl) {
      var cover = document.createElement("a");
      cover.className = "it-studio-cover";
      cover.href = bannerUrl;
      cover.target = "_blank";
      cover.rel = "noopener";
      cover.title = "Open banner";
      cover.innerHTML = '<img src="' + esc(bannerUrl) + '">';
      card.insertBefore(cover, idrow);
      idrow.classList.add("it-has-cover");
    }
  }

  function setupBannerLayoutCard(el, scrapedStudio) {
    var card = el.querySelector(".it-bl-card");
    if (!card) return;
    function apply() {
      var radio = el.querySelector('[data-cb="studio-radio"]:checked');
      var name = radio ? (radio.getAttribute("data-artist") || "") : "";
      var label = radio && radio.closest ? radio.closest(".it-radio-item") : null;
      var sid = label ? (label.getAttribute("data-studio-id") || "") : "";
      // Immediate: name + placeholder logo, no banner; then the real images.
      var scrapedMatch = !!(name && scrapedStudio && scrapedStudio.name &&
        String(scrapedStudio.name).toLowerCase() === name.toLowerCase());
      setBLCard(card, name, scrapedMatch ? scrapedStudio.image : null, scrapedMatch ? studioBannerUrlIT(scrapedStudio) : null, sid);
      if (name && sid) {
        fetchStudioHoverDataIT(sid).then(function (d) {
          var still = el.querySelector('[data-cb="studio-radio"]:checked');
          if (!d || !still || still.getAttribute("data-artist") !== name) return;
          setBLCard(card, name, d.img, d.banner, sid);
        });
      }
    }
    el.querySelectorAll('[data-cb="studio-radio"]').forEach(function (rd) {
      rd.addEventListener("change", apply);
    });
    apply();
  }

  var IT_STUDIO_LOGO_PLACEHOLDER_SVG ='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 21V10a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v11"/></svg>';

  var IT_SECTION_ICONS = {
    studio: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 21V9"/>',
    date: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 3v3M16 3v3"/>',
    performers: '<circle cx="9" cy="7" r="3.2"/><path d="M2.5 20c0-4 3-6.5 6.5-6.5S15.5 16 15.5 20"/><circle cx="17" cy="8" r="2.6"/><path d="M14.8 13.3c2.6.4 4.7 2.7 4.7 6.2"/>',
    tags: '<path d="M20.6 12.3L12.7 4.4a2 2 0 0 0-1.4-.6H5a2 2 0 0 0-2 2v6.3c0 .5.2 1 .6 1.4l7.9 7.9c.8.8 2 .8 2.8 0l6.3-6.3c.8-.8.8-2.1 0-2.8z"/><circle cx="7.5" cy="7.5" r="1"/>',
    details: '<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h5"/>',
    urls: '<path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.5-1.5"/>',
    cover: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>'
  };
  function sectionIcon(name) {
    return '<span class="it-section-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + IT_SECTION_ICONS[name] + '</svg></span>';
  }

  // Batch mode (one card): adds the single-scene panel's small section icon to
  // a field's label, after its checkbox. Title has no icon (none in solo either).
  function withSectionIcon(fieldHTML) {
    // Studio: icon whenever there is no banner (the label floats over a banner
    // otherwise); CSS hides it again if a banner shows up later (async lookup).
    var name = fieldHTML.indexOf("it-inline-artists") !== -1 ? (fieldHTML.indexOf("it-studio-cover") === -1 ? "studio" : null)
      : fieldHTML.indexOf("it-inline-performers") !== -1 ? "performers"
      : fieldHTML.indexOf("it-inline-tags") !== -1 ? "tags"
      : fieldHTML.indexOf("it-inline-details") !== -1 ? "details"
      : fieldHTML.indexOf("it-inline-urls") !== -1 ? "urls"
      : fieldHTML.indexOf('data-cb="date"') !== -1 ? "date" : null;
    if (!name || fieldHTML.indexOf("it-section-icon") !== -1) return fieldHTML;
    return fieldHTML.replace(/(<(?:label|div|span) class="it-inline-label[^"]*">)(<label>)?(<input[^>]*>)?/, function (m, a, b, c) {
      return a + (b || "") + (c || "") + sectionIcon(name);
    });
  }

  // ── Custom date picker (solo mode only) ────────────────────────────────────
  //
  // A native <input type="date"> was tried first (session 2026-09-16) but
  // its calendar popup is rendered by the browser/OS and can't be styled
  // to match the plugin - this builds the whole thing (display button +
  // popover month grid) from scratch instead, driven by row state
  // (r.dateEditValue, r.dateCalendarMonth, r.dateCalendarOpen).

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  var IT_MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

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
      cells += '<span class="it-date-cell it-date-muted">' + (daysInPrevMonth - i) + '</span>';
    }
    for (var d = 1; d <= daysInMonth; d++) {
      var iso = year + "-" + pad2(month) + "-" + pad2(d);
      var cls = "it-date-cell";
      if (iso === selectedISO) cls += " it-date-selected";
      if (iso === todayISO) cls += " it-date-today";
      cells += '<span class="' + cls + '" data-iso="' + iso + '">' + d + '</span>';
    }
    var trailing = (7 - ((startDow + daysInMonth) % 7)) % 7;
    for (var d2 = 1; d2 <= trailing; d2++) {
      cells += '<span class="it-date-cell it-date-muted">' + d2 + '</span>';
    }

    return (
      '<div class="it-date-pop-head">' +
        '<button type="button" class="it-date-pop-nav" data-dir="-1">&#8249;</button>' +
        '<span class="it-date-pop-month">' + IT_MONTH_NAMES[month - 1] + ' ' + year + '</span>' +
        '<button type="button" class="it-date-pop-nav" data-dir="1">&#8250;</button>' +
      '</div>' +
      '<div class="it-date-grid">' +
        '<span class="it-date-dow">Mo</span><span class="it-date-dow">Tu</span><span class="it-date-dow">We</span>' +
        '<span class="it-date-dow">Th</span><span class="it-date-dow">Fr</span><span class="it-date-dow">Sa</span><span class="it-date-dow">Su</span>' +
        cells +
      '</div>' +
      '<div class="it-date-pop-foot">' +
        '<button type="button" class="it-date-pop-link" data-action="clear">Clear</button>' +
        '<button type="button" class="it-date-pop-link" data-action="today">Today</button>' +
      '</div>'
    );
  }

  function buildDateFieldHTML(id, r) {
    var displayText = r.dateEditValue ? esc(r.dateEditValue) : "Select a date";
    var monthISO = r.dateCalendarMonth || (r.dateEditValue ? r.dateEditValue.slice(0, 7) : new Date().toISOString().slice(0, 7));
    r.dateCalendarMonth = monthISO; // persisted so nav has a stable base
    return (
      '<div class="it-date-field">' +
        '<button type="button" class="it-date-display" onclick="itDateToggle(\'' + esc(id) + '\')">' +
          '<span>' + displayText + '</span>' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 3v3M16 3v3"/></svg>' +
        '</button>' +
        (r.dateCalendarOpen ? '<div class="it-date-popover">' + buildDateCalendarHTML(monthISO, r.dateEditValue) + '</div>' : '') +
      '</div>'
    );
  }

  var _dateOutsideClickWired = false;
  function wireDateOutsideClickOnce() {
    if (_dateOutsideClickWired) return;
    _dateOutsideClickWired = true;
    document.addEventListener("click", function (e) {
      if (e.target.closest(".it-date-field")) return;
      var touched = false;
      Object.keys(state.rows).forEach(function (rid) {
        if (state.rows[rid].dateCalendarOpen) { state.rows[rid].dateCalendarOpen = false; touched = true; }
      });
      if (touched) Object.keys(state.rows).forEach(function (rid) { renderRow(rid); });
    });
  }

  function renderRow(id) {
    var r = state.rows[id];
    if (!r) return;
    var img    = r.image;
    var status = r.status;
    var scraped = r.scraped;

    var el = document.getElementById("it-row-" + id);
    if (!el) return;
    var blScrapedStudio = null; // multi-studio banner card (see setupBannerLayoutCard)

    // A failed scrape kept as "manual fill-in" is status "scraped" but gets the
    // red failure outline (class it-state-failed) instead of the blue one.
    el.className = "it-row it-state-" + status + ((r && r.manualFallback && status === "scraped") ? " it-state-failed" : "");

    // Solo mode's floating "reload" button - only once this row is "done".
    var refreshBtn = document.getElementById("it-solo-refresh-btn");
    if (refreshBtn) {
      var panelElForRefresh = document.getElementById(PANEL_ID);
      var isSoloForRefresh = !!(panelElForRefresh && panelElForRefresh.classList.contains("it-panel-solo"));
      refreshBtn.style.display = (isSoloForRefresh && status === "done") ? "flex" : "none";
      refreshBtn.onclick = function () { window.location.reload(); };
    }

    var thumb = getThumb(img);
    var fname = getFilename(img);
    // Header badge text: the image's own title when the setting is on and the
    // image has one, the file name otherwise (file name kept in the tooltip).
    var imgOwnTitle = (img.title || "").trim();
    var headerShowsTitle = !!(pluginConfig.showImageTitleInHeader && imgOwnTitle);
    var headerLabel = headerShowsTitle ? imgOwnTitle : fname;
    var r34id  = getR34ID(img);
    var r34url = getR34URL(img);
    var hintHTML = "";
    if (status === "idle" || status === "scraped" || status === "done") {
      // N'affiche quelque chose que pour les images vraiment issues de rule34
      // (id trouve dans une URL ou dans le filename via getR34ID) - les
      // scrapers non-rule34 (scrapers communautaires, saisie manuelle, etc.)
      // n'ont simplement aucun hint.
      hintHTML = r34url
        ? '<div class="it-hint"><a class="it-r34-link" href="' + esc(r34url) + '" target="_blank" rel="noopener">rule34 ID fichier #' + esc(r34id) + ' &#8599;</a></div>'
        : "";
    } else if (status === "error") {
      hintHTML = '<div class="it-hint it-hint-error">' + esc(r.msg || "Error") + '</div>';
    }

    var inlineHTML = "";
    if (status === "scraped" && scraped) {
      var fields = [];

      // Mode solo (voir buildSoloPanel()) : Studio/Performers/Tags/Details
      // separent "deja sur cette image" (r.image, lecture seule) de "nouveau
      // via le scrape" (scraped, la selection habituelle) - aligne sur la
      // presentation solo de sceneTagger. Mode masse : rendu inchange.
      var panelElForMode = document.getElementById(PANEL_ID);
      var isSolo = !!(panelElForMode && panelElForMode.classList.contains("it-panel-solo"));
      // "Details in one card": the Performers / Tags search boxes live in the
      // "Already on this image" column (left) instead of "New from scrape".
      var searchInExisting = !isSolo && !!panelElForMode && panelElForMode.classList.contains("it-one-card") &&
        panelElForMode.classList.contains("it-banner-layout") && !panelElForMode.classList.contains("it-compact");

      // ── Bandeau "Scrape échoué, remplissage manuel" (mode manualFallbackOnFail)
      if (r.manualFallback) {
        fields.push(
          '<div class="it-inline-field it-manual-fallback-hint">' +
            '<span class="it-label-static"></span>' +
            '<span>Scrape failed (' + esc(r.msg || "error") + ') — manual fill-in</span>' +
          '</div>'
        );
      }

      // ── Titre manuel (mode manualFallbackOnFail + manualFallbackAllowTitle)
      if (r.manualFallback && pluginConfig.manualFallbackAllowTitle) {
        fields.push(
          '<div class="it-inline-field">' +
            '<label class="it-inline-label it-label-static">Title</label>' +
            '<input type="text" class="it-manual-title-input" placeholder="Title (optional)" value="' + esc(r.manualTitle || "") + '">' +
          '</div>'
        );
      }

      // ── Badge scraper utilisé (repli) : visible seulement si ce n'est pas
      // le 1er scraper actif de la chaine, pour ne pas polluer le cas normal
      var enabledChain = pluginConfig.scraperChain.filter(function (c) { return c.enabled; });
      var firstEnabled = enabledChain.length ? enabledChain[0].id : null;
      if (pluginConfig.scraperMode === "auto" && r.matchedScraperName && enabledChain.length > 1 && r.matchedScraperID !== firstEnabled) {
        fields.push(
          '<div class="it-inline-field it-scraper-match-hint">' +
            '<span class="it-label-static"></span>' +
            '<span>found via <strong>' + esc(r.matchedScraperName) + '</strong> (fallback)</span>' +
          '</div>'
        );
      }

      // ── Titre
      if (scraped.title) {
        fields.push(
          '<div class="it-inline-field">' +
            '<label class="it-inline-label"><input type="checkbox" data-cb="title" checked> Title</label>' +
            '<span class="it-chip it-chip-title' + (r.titleEdit ? ' it-chip-edited' : '') + '" title="Double-click to rename">' + esc(r.titleEdit || scraped.title) + '</span>' +
          '</div>'
        );
      }

      // ── Studio / artistes multiples (même logique que sceneTagger)
      var detailsParsed = parseDetailsArtists(scraped.details);
      var allArtists    = detailsParsed.artists;
      var artists       = allArtists.filter(function(a) { return !isBlacklisted(a.name); });

      if (artists.length === 0 && allArtists.length > 0) artists = allArtists;

      var studioFromScraper = scraped.studio && scraped.studio.name ? scraped.studio.name : null;
      if (artists.length === 0 && studioFromScraper) {
        artists = [{ name: studioFromScraper, stored_id: (scraped.studio && scraped.studio.stored_id) || null }];
      }

      // Corrige le badge "new" pour les candidats sans stored_id detecte
      // (ni [id] dans Details, ni matching natif de Stash) qui existent en
      // fait sous un alias, deja verifie en arriere-plan par
      // refreshStudioAliasBadges() (voir studioAliasBadgeCache).
      artists = artists.map(function (a) {
        if (a.stored_id) return a;
        var cachedId = getCachedStudioAliasId(a.name);
        return cachedId ? { name: studioNameCache[a.name.toLowerCase()] || a.name, stored_id: cachedId } : a;
      });
      // Fusionne les candidats qui resolvent vers le meme studio existant
      // (un alias d'un studio deja dans la liste) : garde le premier, dont
      // le nom est desormais celui du studio qui porte les alias.
      var seenStudioIds = {};
      artists = artists.filter(function (a) {
        if (!a.stored_id) return true;
        var k = String(a.stored_id);
        if (seenStudioIds[k]) return false;
        seenStudioIds[k] = true;
        return true;
      });

      var studioSearchWidget =
        '<div class="it-studio-search-wrap">' +
          '<input type="hidden" data-cb="studio-override" data-studio-id="" value="">' +
          '<input type="text" class="it-studio-search-input" placeholder="Search for an existing studio..." autocomplete="off">' +
          '<div class="it-studio-search-results" style="display:none"></div>' +
          '<span class="it-studio-selected" style="display:none"></span>' +
        '</div>';

      // Mode solo : ligne "Deja sur cette image" (lecture seule, texte brut -
      // pas de logo, la requete FindImageSolo ne recupere pas image_path) et
      // "Ajoute manuellement" en zones separees, plutot que mele avec le
      // widget de recherche comme en mode masse.
      var exLogo = img.studio && img.studio.image_path && img.studio.image_path.indexOf("default=true") === -1 ? img.studio.image_path : null;
      var existingStudioRowHTML = studioCardHTMLIT(
        exLogo,
        img.studio ? studioBannerUrlIT(img.studio) : null,
        '<span class="it-studio-name-plain">' + (img.studio && img.studio.name ? esc(img.studio.name) : '(none)') + '</span>',
        '',
        null,
        img.studio && img.studio.id,
        '<span class="it-existing-caption">Already on this image</span>'
      );
      // Its own card (solo only): a manually searched studio is not the same
      // candidate as the scraped one. Logo/banner are fetched on click only.
      var manualStudioRowHTML = studioCardHTMLIT(
        null,
        null,
        studioSearchWidget +
        '<span class="it-split-empty it-studio-manual-empty">No studio added manually</span>',
        "it-studio-manual-card",
        null,
        null,
        '<span class="it-existing-caption">Manually added</span>'
      );

      if (artists.length > 1) {
        var radioName = "it-studio-radio-" + id;
        var allNew = artists.every(function(a) { return !a.stored_id; });
        var existingIdx = -1;
        if (pluginConfig.prioritizeExistingStudio) {
          for (var ei = 0; ei < artists.length; ei++) {
            if (artists[ei].stored_id) { existingIdx = ei; break; }
          }
        }
        var defaultNone = allNew && !pluginConfig.autoCheckStudio;
        var radioNoneChecked = (defaultNone && existingIdx === -1) ? ' checked' : '';
        var defaultCheckedIdx = existingIdx !== -1 ? existingIdx : (defaultNone ? -1 : 0);
        var radioItems = artists.map(function(artist, i) {
          var checkedAttr = (i === defaultCheckedIdx) ? ' checked' : '';
          var isbl = isBlacklisted(artist.name);
          var artistIsNew = !artist.stored_id;
          return '<label class="it-radio-item' + (isbl ? ' it-radio-blacklisted' : '') + '"' +
            ' data-studio-name="' + esc(artist.name) + '" data-studio-id="' + esc(artist.stored_id || '') + '">' +
            '<input type="radio" name="' + esc(radioName) + '" data-cb="studio-radio" data-artist="' + esc(artist.name) + '" data-artist-stored="' + (artist.stored_id ? "1" : "") + '"' + checkedAttr + '> ' +
            (pluginConfig.hideStudioLogo || !artist.stored_id ? '' : '<span class="it-radio-logo it-radio-logo-empty" data-logo-id="' + esc(String(artist.stored_id)) + '"></span>') +
            '<span class="it-selectable">' + esc(artist.name) + '</span>' +
            (artistIsNew ? ' <span class="it-new-badge">new</span>' : '') +
            (!isbl ? '<button class="it-blacklist-btn" data-artist="' + esc(artist.name) + '" title="Blacklist this studio">&#128683;</button>' : '') +
            // "+" at the right of the badge (several studios): also add it as an "Other studio". Not
            // for the studio chosen as main one: disabled, kept in step by the listeners on #it-rows.
            (multiStudioActive()
              ? '<button type="button" class="it-also-btn" data-cb="studio-also" data-artist="' + esc(artist.name) + '" title="Also add as an Other studio"' + (i === defaultCheckedIdx ? ' disabled' : '') + '>+</button>'
              : '') +
          '</label>';
        }).join("");
        var radioNone = '<label class="it-radio-item it-radio-none">' +
          '<input type="radio" name="' + esc(radioName) + '" data-cb="studio-radio" data-artist=""' + radioNoneChecked + '> ' +
          '<span class="it-selectable">None</span>' +
        '</label>';
        var studioMultiRadioHTML = '<div class="it-radio-group">' + radioNone + radioItems + '</div>';
        var studioMultiContentHTML = studioMultiRadioHTML + studioSearchWidget;
        blScrapedStudio = scraped.studio || null;
        if (pluginConfig.studioBannerLayout && !isSolo) {
          // Banner header for the selected candidate (filled by
          // setupBannerLayoutCard after render); the search box lives in it.
          studioMultiContentHTML =
            '<div class="it-studio-card it-card-stacked it-bl-card">' +
              '<div class="it-studio-idrow"><div class="it-slogo it-slogo-round it-slogo-empty">' + IT_STUDIO_LOGO_PLACEHOLDER_SVG + '</div>' +
                '<div class="it-studio-info"><span class="it-chip it-chip-studio it-bl-name"></span>' + studioSearchWidget + '</div>' +
              '</div>' +
            '</div>' + studioMultiRadioHTML;
        }
        if (isSolo) {
          fields.push(
            '<div class="it-inline-field it-inline-artists">' +
              '<span class="it-inline-label it-label-static">' + sectionIcon("studio") + 'Studio</span>' +
              '<div class="it-studio-stack">' +
                existingStudioRowHTML +
                studioCardHTMLIT(
                  scraped.studio && scraped.studio.image && scraped.studio.image.indexOf("default=true") === -1 ? scraped.studio.image : null,
                  studioBannerUrlIT(scraped.studio),
                  studioMultiRadioHTML,
                  '',
                  null,
                  null,
                  '<span class="it-existing-caption it-new">New from scrape</span>'
                ) +
                manualStudioRowHTML +
              '</div>' +
            '</div>'
          );
        } else {
          fields.push(
            '<div class="it-inline-field it-inline-artists">' +
              '<span class="it-inline-label it-label-static">Studio</span>' +
              '<div>' + studioMultiContentHTML + '</div>' +
            '</div>'
          );
        }
      } else if (artists.length === 1) {
        var soloArtistObj = artists[0];
        var soloArtist   = soloArtistObj.name;
        var soloIsNew    = !soloArtistObj.stored_id;
        var soloChecked  = soloIsNew ? pluginConfig.autoCheckStudio : true;
        var soloIsBl     = isBlacklisted(soloArtist);
        var soloScrapedLogo = scraped.studio && scraped.studio.image && scraped.studio.image.indexOf("default=true") === -1 ? scraped.studio.image : null;
        var soloScrapedBanner = studioBannerUrlIT(scraped.studio);
        var soloStudioId = soloArtistObj.stored_id || null;
        var studioSoloCardForMass = (soloScrapedLogo || soloScrapedBanner)
          ? studioCardHTMLIT(soloScrapedLogo, soloScrapedBanner,
              '<span class="it-selectable">' + esc(soloArtist) + '</span>' +
              (soloIsNew ? ' <span class="it-new-badge">new</span>' : '') +
              (soloIsBl  ? ' <span class="it-bl-badge" title="Blacklisted but the only one available">&#9888;</span>' : ''),
              'it-card-stacked', soloStudioId, soloStudioId)
          : (soloStudioId
              ? studioCardHTMLIT(null, null,
                  '<span class="it-selectable">' + esc(soloArtist) + '</span>' +
                  (soloIsNew ? ' <span class="it-new-badge">new</span>' : '') +
                  (soloIsBl  ? ' <span class="it-bl-badge" title="Blacklisted but the only one available">&#9888;</span>' : ''),
                  'it-card-stacked', soloStudioId, soloStudioId)
              : '<span class="it-chip it-chip-studio' + (soloIsBl ? ' it-chip-blacklisted' : '') + '">' +
                  '<span class="it-selectable">' + esc(soloArtist) + '</span>' +
                  (soloIsNew ? ' <span class="it-new-badge">new</span>' : '') +
                  (soloIsBl  ? ' <span class="it-bl-badge" title="Blacklisted but the only one available">&#9888;</span>' : '') +
                '</span>');
        var studioSoloChipOnlyHTML =
          '<span class="it-chip it-chip-studio' + (soloIsBl ? ' it-chip-blacklisted' : '') + '">' +
            '<span class="it-selectable">' + esc(soloArtist) + '</span>' +
            (soloIsNew ? ' <span class="it-new-badge">new</span>' : '') +
            (soloIsBl  ? ' <span class="it-bl-badge" title="Blacklisted but the only one available">&#9888;</span>' : '') +
          '</span>';
        if (isSolo) {
          fields.push(
            '<div class="it-inline-field it-inline-artists">' +
              '<span class="it-inline-label it-label-static">' + sectionIcon("studio") + 'Studio</span>' +
              '<div class="it-studio-stack">' +
                existingStudioRowHTML +
                studioCardHTMLIT(
                  soloScrapedLogo,
                  soloScrapedBanner,
                  studioSoloChipOnlyHTML,
                  '',
                  soloArtistObj.stored_id,
                  soloArtistObj.stored_id,
                  '<label class="it-existing-caption it-new" style="cursor:pointer;"><input type="checkbox" data-cb="studio" data-artist-stored="' + (soloArtistObj.stored_id || '') + '"' + (soloChecked ? ' checked' : '') + '> New from scrape</label>'
                ) +
                manualStudioRowHTML +
              '</div>' +
            '</div>'
          );
        } else {
          fields.push(
            '<div class="it-inline-field it-inline-artists">' +
              '<label class="it-inline-label"><input type="checkbox" data-cb="studio" data-artist-stored="' + (soloArtistObj.stored_id || '') + '"' + (soloChecked ? ' checked' : '') + '> Studio</label>' +
              '<div>' + studioSoloCardForMass + studioSearchWidget + '</div>' +
            '</div>'
          );
        }
      } else if (isSolo) {
        fields.push(
          '<div class="it-inline-field it-inline-artists">' +
            '<span class="it-inline-label it-label-static">' + sectionIcon("studio") + 'Studio</span>' +
            '<div class="it-studio-stack">' +
              existingStudioRowHTML +
              manualStudioRowHTML +
            '</div>' +
          '</div>'
        );
      } else {
        fields.push(
          '<div class="it-inline-field it-inline-artists">' +
            '<span class="it-inline-label it-label-static">Studio</span>' +
            studioSearchWidget +
          '</div>'
        );
      }

      // ── Date - solo mode gets its own card, editable via the custom
      // calendar widget (buildDateFieldHTML); the mass list keeps the plain checkbox+chip.
      // ── Date - solo mode gets its own card, editable via the custom
      // calendar widget (buildDateFieldHTML), with the existing-vs-new
      // split when the two differ. The mass list keeps the original plain
      // checkbox+chip - see isSolo.
      if (!isSolo) {
        if (scraped.date) {
          fields.push(
            '<div class="it-inline-field">' +
              '<label class="it-inline-label"><input type="checkbox" data-cb="date" checked> Date</label>' +
              '<span class="it-chip it-chip-date">' + esc(scraped.date) + '</span>' +
            '</div>'
          );
        }
      } else {
        var existingDateText = (img.date || "").trim();
        var scrapedDateText = (scraped.date || "").trim();
        var hasNewDate = !!scrapedDateText && scrapedDateText !== existingDateText;
        if (r.dateEditValue === undefined) {
          r.dateEditValue = hasNewDate ? scrapedDateText : existingDateText;
        }
        var dateExistingColHTML = hasNewDate
          ? '<div class="it-details-col">' +
              '<span class="it-existing-caption">Already on this image</span>' +
              '<div class="it-details-readonly">' + (existingDateText ? esc(existingDateText) : '<span class="it-details-empty">(empty)</span>') + '</div>' +
            '</div>'
          : "";
        fields.push(
          '<div class="it-inline-field it-inline-date">' +
            '<span class="it-inline-label it-label-static">' + sectionIcon("date") + 'Date</span>' +
            '<div class="it-details-wrap' + (hasNewDate ? ' it-details-split' : '') + '">' +
              dateExistingColHTML +
              '<div class="it-details-col">' +
                (hasNewDate ? '<span class="it-existing-caption it-new">New from scrape (editable)</span>' : '') +
                buildDateFieldHTML(id, r) +
              '</div>' +
            '</div>' +
          '</div>'
        );
      }

      // ── Code
      if (scraped.code) {
        fields.push(
          '<div class="it-inline-field">' +
            '<label class="it-inline-label"><input type="checkbox" data-cb="code" checked> Code</label>' +
            '<span class="it-chip it-chip-code">' + esc(scraped.code) + '</span>' +
          '</div>'
        );
      }

      // ── Photographer
      if (scraped.photographer) {
        fields.push(
          '<div class="it-inline-field">' +
            '<label class="it-inline-label"><input type="checkbox" data-cb="photographer" checked> Photographer</label>' +
            '<span class="it-chip it-chip-director">' + esc(scraped.photographer) + '</span>' +
          '</div>'
        );
      }

      var perfSearchWidget =
        '<div class="it-perf-search-wrap">' +
          '<input type="text" class="it-perf-search-input" placeholder="Search for or add a performer..." autocomplete="off">' +
          '<div class="it-perf-search-results" style="display:none"></div>' +
        '</div>' +
        '<div class="it-perfs-added"></div>';

      // Existing/new split: always in solo, opt-in in the mass list
      // (setting splitExistingNew) - see the note on the else branches below.
      // In the mass list, a field with nothing to compare (no performer /
      // no tag, neither on the scene nor scraped) keeps its original
      // compact layout instead of an empty two-part split.
      var useSplitPerf = isSolo || (!!pluginConfig.splitExistingNew &&
        ((img.performers || []).length > 0 || (scraped.performers || []).length > 0));
      var useSplitTags = isSolo || (!!pluginConfig.splitExistingNew &&
        ((img.tags || []).length > 0 || (scraped.tags || []).length > 0));
      if (useSplitPerf) {
        // ── Already on this image (kept as-is, not checkboxes - see the
        // merge step in getCheckedScraped()) vs new from the scrape.
        var existingPerfsHTML = (img.performers && img.performers.length)
          ? '<div class="it-existing-pills it-existing-pills-perf">' + img.performers.map(function (p) {
              return '<span class="it-existing-pill it-existing-pill-perf">' +
                (p.image_path ? '<img class="it-perf-chip-avatar" src="' + esc(p.image_path) + '">' : '') +
                '<span class="it-perf-name">' + esc(p.name) + '</span>' +
              '</span>';
            }).join("") + '</div>'
          : "";
        var existingPerfIdSet = {};
        (img.performers || []).forEach(function (p) { existingPerfIdSet[String(p.id)] = true; });

        var perfItemsHTML = "";
        if (scraped.performers && scraped.performers.length) {
          perfItemsHTML = scraped.performers.map(function (p, i) {
            // Already shown (and already kept) in existingPerfsHTML above -
            // no need for a second, redundant checkbox for the same performer.
            if (p.stored_id && existingPerfIdSet[String(p.stored_id)]) return "";
            var isNew = !p.stored_id;
            var perfChecked = isNew ? pluginConfig.autoCheckPerformer : true;
            return '<label class="it-perf-item' + (isNew ? ' it-perf-new' : '') + '">' +
              '<input type="checkbox" data-cb="performer" data-idx="' + i + '" ' + (perfChecked ? 'checked' : '') + '>' +
              (p.storedImage ? '<img class="it-perf-chip-avatar" src="' + esc(p.storedImage) + '">' : '') +
              '<span class="it-perf-name">' + esc(p.name) + '</span>' +
              (isNew ? '<span class="it-new-badge">new</span>' : '') +
            '</label>';
          }).join("");
        }

        var newPerfCount = (scraped.performers || []).filter(function (p) {
          return !(p.stored_id && existingPerfIdSet[String(p.stored_id)]);
        }).length;
        var existingPerfCount = (img.performers || []).length;
        var perfsCountText = existingPerfCount || newPerfCount
          ? existingPerfCount + ' existing' +
            (newPerfCount ? ' &middot; ' + newPerfCount + ' new' : '')
          : '';
        var perfsLabel = newPerfCount
          ? '<label><input type="checkbox" data-cb="perfs-all" checked> Performers' + (perfsCountText ? ' <span class="it-count-hint">(' + perfsCountText + ')</span>' : '') + '</label>'
          : '<span>Performers' + (perfsCountText ? ' <span class="it-count-hint">(' + perfsCountText + ')</span>' : '') + '</span>';

        // The search box sits under the existing items (left) in "Details in one card", and in the
        // other mass-list layouts whenever the scrape brings nothing new: no "New from scrape"
        // column to hold it, so it must not float alone on the far right.
        var perfSearchLeft = searchInExisting || (!isSolo && !perfItemsHTML);
        fields.push(
          '<div class="it-inline-field it-inline-performers' + (isSolo ? '' : ' it-split-list') + '">' +
            '<div class="it-inline-label">' + (isSolo ? sectionIcon("performers") : '') + perfsLabel + '</div>' +
            '<div class="it-split-cols' + (isSolo ? '' : ' it-split-stack') + '"' + splitShareStyle(existingPerfCount, newPerfCount) + '>' +
              '<div class="it-split-col">' +
                '<span class="it-existing-caption">Already on this image</span>' +
                (existingPerfsHTML || '<span class="it-split-empty">None</span>') +
                (perfSearchLeft ? perfSearchWidget : '') +
              '</div>' +
              '<div class="it-split-col">' +
                ((isSolo || perfItemsHTML) ? '<span class="it-existing-caption it-new">New from scrape</span>' : '') +
                (perfItemsHTML ? '<div class="it-perfs-grid">' + perfItemsHTML + '</div>' : (isSolo ? '<span class="it-split-empty">None found</span>' : '')) +
                (perfSearchLeft ? '' : perfSearchWidget) +
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
            return '<label class="it-perf-item' + (isNew ? ' it-perf-new' : '') + '">' +
              '<input type="checkbox" data-cb="performer" data-idx="' + i + '" ' + (perfChecked ? 'checked' : '') + '>' +
              (p.storedImage ? '<img class="it-perf-chip-avatar" src="' + esc(p.storedImage) + '">' : '') +
              '<span class="it-perf-name">' + esc(p.name) + '</span>' +
              (isNew ? '<span class="it-new-badge">new</span>' : '') +
            '</label>';
          }).join("");
        }
        var perfsLabelOld = scraped.performers && scraped.performers.length
          ? '<label><input type="checkbox" data-cb="perfs-all" checked> Performers (' + scraped.performers.length + ')</label>'
          : '<span>Performers</span>';
        fields.push(
          '<div class="it-inline-field it-inline-performers">' +
            '<div class="it-inline-label">' + perfsLabelOld + '</div>' +
            '<div class="it-perfs-right">' +
              (perfItemsHTMLOld ? '<div class="it-perfs-grid">' + perfItemsHTMLOld + '</div>' : '') +
              perfSearchWidget +
            '</div>' +
          '</div>'
        );
      }

      // ── Tags (scraped + manually added via search/create)
      {
        var tagSearchWidget =
          '<div class="it-tag-search-wrap">' +
            '<input type="text" class="it-tag-search-input" placeholder="Search for or add a tag..." autocomplete="off">' +
            '<div class="it-tag-search-results" style="display:none"></div>' +
          '</div>' +
          '<div class="it-tags-added"></div>';

        if (useSplitTags) {
          var existingTagsHTML = (img.tags && img.tags.length)
            ? '<div class="it-existing-pills">' + img.tags.map(function (t) {
                return '<span class="it-existing-pill">' + esc(t.name) + '</span>';
              }).join("") + '</div>'
            : "";
          var existingTagIdSet = {};
          (img.tags || []).forEach(function (t) { existingTagIdSet[String(t.id)] = true; });

          var tagItems = (scraped.tags || []).map(function (t, i) {
            // Already shown (and already kept) in existingTagsHTML above.
            if (t.stored_id && existingTagIdSet[String(t.stored_id)]) return "";
            var isNew = !t.stored_id;
            var tagChecked = isNew ? pluginConfig.autoCheckNewTags : true;
            return '<label class="it-tag-item' + (isNew ? ' it-tag-new' : '') + '">' +
              '<input type="checkbox" data-cb="tag" data-idx="' + i + '" ' + (tagChecked ? 'checked' : '') + '>' +
              '<span class="it-selectable">' + esc(t.name) + '</span>' +
              (isNew ? '<span class="it-new-badge">new</span>' : '') +
            '</label>';
          }).join("");

          var newTagCount = (scraped.tags || []).filter(function (t) {
            return !(t.stored_id && existingTagIdSet[String(t.stored_id)]);
          }).length;
          var existingTagCount = (img.tags || []).length;
          var tagsCountText = existingTagCount || newTagCount
            ? existingTagCount + ' existing' +
              (newTagCount ? ' &middot; ' + newTagCount + ' new' : '')
            : '';
          var tagsLabel = newTagCount
            ? '<label><input type="checkbox" data-cb="tags-all" checked> Tags' + (tagsCountText ? ' <span class="it-count-hint">(' + tagsCountText + ')</span>' : '') + '</label>'
            : '<span>Tags' + (tagsCountText ? ' <span class="it-count-hint">(' + tagsCountText + ')</span>' : '') + '</span>';

          var tagSearchLeft = searchInExisting || (!isSolo && !tagItems);
          fields.push(
            '<div class="it-inline-field it-inline-tags' + (isSolo ? '' : ' it-split-list') + '">' +
              '<div class="it-inline-label">' + (isSolo ? sectionIcon("tags") : '') + tagsLabel + '</div>' +
              '<div class="it-split-cols' + (isSolo ? '' : ' it-split-stack') + '"' + splitShareStyle(existingTagCount, newTagCount) + '>' +
                '<div class="it-split-col">' +
                  '<span class="it-existing-caption">Already on this image</span>' +
                  (existingTagsHTML || '<span class="it-split-empty">None</span>') +
                  (tagSearchLeft ? tagSearchWidget : '') +
                '</div>' +
                '<div class="it-split-col">' +
                  ((isSolo || tagItems) ? '<span class="it-existing-caption it-new">New from scrape</span>' : '') +
                  (tagItems ? '<div class="it-tags-grid">' + tagItems + '</div>' : (isSolo ? '<span class="it-split-empty">None found</span>' : '')) +
                  (tagSearchLeft ? '' : tagSearchWidget) +
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
            return '<label class="it-tag-item' + (isNew ? ' it-tag-new' : '') + '">' +
              '<input type="checkbox" data-cb="tag" data-idx="' + i + '" ' + (tagChecked ? 'checked' : '') + '>' +
              '<span class="it-selectable">' + esc(t.name) + '</span>' +
              (isNew ? '<span class="it-new-badge">new</span>' : '') +
            '</label>';
          }).join("");
          var tagsLabelOld = scraped.tags && scraped.tags.length
            ? '<label><input type="checkbox" data-cb="tags-all" checked> Tags (' + scraped.tags.length + ')</label>'
            : '<span>Tags</span>';
          fields.push(
            '<div class="it-inline-field it-inline-tags">' +
              '<div class="it-inline-label">' + tagsLabelOld + '</div>' +
              (tagItemsOld ? '<div class="it-tags-grid">' + tagItemsOld + '</div>' : '') +
              tagSearchWidget +
            '</div>'
          );
        }
      }

      // ── Details - solo mode: always editable, pre-filled with whatever's
      // best available, split into "Already on this image" (read-only) /
      // "New from scrape (editable)" only when the two genuinely differ.
      // Mass list keeps the original checkbox+chip preview - see isSolo.
      // "Details in one card": the Details editor is always there (even when
      // the scrape found nothing) so text can be typed in; typing ticks the box.
      var detailsAlwaysEditor = !isSolo && !!panelElForMode && panelElForMode.classList.contains("it-one-card") &&
        panelElForMode.classList.contains("it-banner-layout") && !panelElForMode.classList.contains("it-compact");
      if (!isSolo && !pluginConfig.detailsEditorInList && !detailsAlwaysEditor) {
        if (scraped.details) {
          var detailsParsedForDisplay = parseDetailsArtists(scraped.details);
          var hasRealContent = !!detailsParsedForDisplay.rest;
          var detailsChecked = pluginConfig.autoCheckDetails ? true : hasRealContent;
          var detailsShort = scraped.details.length > 80 ? scraped.details.substring(0, 80) + "…" : scraped.details;
          fields.push(
            '<div class="it-inline-field it-inline-details-chip">' +
              '<label class="it-inline-label"><input type="checkbox" data-cb="details"' + (detailsChecked ? ' checked' : '') + '> Details</label>' +
              '<span class="it-chip it-chip-details" title="' + esc(scraped.details) + '">' + esc(detailsShort) + '</span>' +
            '</div>'
          );
        }
      } else if (isSolo || scraped.details || detailsAlwaysEditor) {
        var scrapedDetailsClean = scraped.details ? scraped.details.replace(/\[(\w+)\]/g, "").trim() : "";
        var existingDetailsText = (img.details || "").trim();
        var hasNewDetails = !!scrapedDetailsClean && scrapedDetailsClean !== existingDetailsText;
        if (r.detailsEditValue === undefined) {
          r.detailsEditValue = hasNewDetails ? scrapedDetailsClean : existingDetailsText;
        }
        var detailsExistingColHTML = hasNewDetails
          ? '<div class="it-details-col">' +
              '<span class="it-existing-caption">Already on this image</span>' +
              (existingDetailsText
                ? '<div class="it-copy-wrap"><div class="it-details-readonly">' + esc(existingDetailsText) + '</div>' +
                    '<button type="button" class="it-copy-text" title="Copy this text">' + IT_ICON_COPY + '</button></div>'
                : '<div class="it-details-readonly"><span class="it-details-empty">(empty)</span></div>') +
            '</div>'
          : "";
        // Solo: static label (always applied). Mass list editor: keeps the
        // per-row checkbox, checked by the same rule as the short preview.
        var detailsLabelHTML;
        if (isSolo) {
          detailsLabelHTML = '<span class="it-inline-label it-label-static">' + sectionIcon("details") + 'Details</span>';
        } else {
          var detailsListChecked = pluginConfig.autoCheckDetails ? true : !!parseDetailsArtists(scraped.details).rest;
          detailsLabelHTML = '<label class="it-inline-label"><input type="checkbox" data-cb="details"' + (detailsListChecked ? ' checked' : '') + '> Details</label>';
        }
        fields.push(
          '<div class="it-inline-field it-inline-details">' +
            detailsLabelHTML +
            '<div class="it-details-wrap' + (hasNewDetails ? ' it-details-split' : '') + '">' +
              detailsExistingColHTML +
              '<div class="it-details-col">' +
                (hasNewDetails ? '<span class="it-existing-caption it-new">New from scrape (editable)</span>' : '') +
                '<textarea class="it-details-edit" placeholder="Details...">' + esc(r.detailsEditValue) + '</textarea>' +
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
        var visUrls = visibleScrapedUrls(scraped);
        if (visUrls && visUrls.length) {
          var urlChips = visUrls.map(function (u) {
            return '<span class="it-url-item">' +
              '<a class="it-chip it-chip-url" href="' + esc(u) + '" target="_blank" rel="noopener" title="' + esc(u) + '">' + esc(u) + '</a>' +
              '<button type="button" class="it-url-copy" data-url="' + esc(u) + '" title="Copy the full URL">' + IT_ICON_COPY + '</button>' +
            '</span>';
          }).join("");
          fields.push(
            '<div class="it-inline-field it-inline-urls">' +
              '<label class="it-inline-label"><input type="checkbox" data-cb="urls" checked> URLs</label>' +
              '<div class="it-inline-chips">' + urlChips + '</div>' +
            '</div>'
          );
        }
      } else {
        if (r.urlEditList === undefined) {
          var seenUrls = {};
          r.urlEditList = [];
          (img.urls || []).forEach(function (u) {
            if (u && !seenUrls[u]) { seenUrls[u] = true; r.urlEditList.push({ value: u, isNew: false }); }
          });
          (visibleScrapedUrls(scraped) || []).forEach(function (u) {
            if (u && !seenUrls[u]) { seenUrls[u] = true; r.urlEditList.push({ value: u, isNew: true }); }
          });
        }
        var urlRowsHTML = r.urlEditList.map(function (u, i) {
          return '<div class="it-url-row' + (u.isNew ? ' it-url-row-new' : '') + '">' +
            '<span class="it-url-link" title="' + esc(u.value) + '">' + esc(u.value) + '</span>' +
            (u.isNew ? '<span class="it-url-badge-new">new</span>' : '') +
            '<button class="it-url-remove" onclick="itRemoveUrl(\'' + esc(id) + '\',' + i + ')" title="Remove">&#10005;</button>' +
          '</div>';
        }).join("");
        fields.push(
          '<div class="it-inline-field it-inline-urls">' +
            '<span class="it-inline-label it-label-static">' + sectionIcon("urls") + 'URLs</span>' +
            '<div class="it-url-list-wrap">' +
              (urlRowsHTML ? '<div class="it-url-list">' + urlRowsHTML + '</div>' : '') +
              '<input type="text" class="it-url-add-input" placeholder="Add a URL...">' +
            '</div>' +
          '</div>'
        );
      }

      var fieldsHTML = fields.join("");
      if (!isSolo && panelElForMode && panelElForMode.classList.contains("it-one-card") &&
          panelElForMode.classList.contains("it-banner-layout") && !panelElForMode.classList.contains("it-compact")) {
        // Everything, studio banner header included, in ONE card (the studio
        // field comes first through CSS order).
        fieldsHTML = '<div class="it-onecard">' + fields.map(withSectionIcon).join("") + '</div>';
      }

      inlineHTML =
        '<div class="it-inline-results">' +
          fieldsHTML +
          '<div class="it-inline-actions">' +
            '<button class="it-btn it-btn-success" onclick="itApplyOne(\'' + esc(id) + '\')">Apply</button>' +
            (r.manualFallback ? '<button class="it-btn it-btn-ghost" onclick="itScrapeOne(\'' + esc(id) + '\')">Retry</button>' : '') +
            '<button class="it-btn it-btn-danger"  onclick="itSkipOne(\'' + esc(id) + '\')">Skip</button>' +
            '<button class="it-btn ' + (r.markOrganized ? "it-btn-organized-on" : "it-btn-organized-off") + '" onclick="itToggleOrganized(\'' + esc(id) + '\')">' +
              (r.markOrganized
                ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="vertical-align:-2px;margin-right:4px"><path d="M20 6L9 17l-5-5"/></svg>'
                : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><circle cx="12" cy="12" r="9"/></svg>') +
              'Organized' +
            '</button>' +
          '</div>' +
        '</div>';
    }

    var rightHTML = "";
    if (status === "idle" || status === "skipped") {
      rightHTML = '<div class="it-row-btn"><button class="it-btn it-btn-primary" onclick="itScrapeOne(\'' + esc(id) + '\')">Scrape</button></div>';
    } else if (status === "scraping" || status === "applying") {
      rightHTML = '<div class="it-row-btn"><span class="it-spinner"></span></div>';
    } else if (status === "done") {
      rightHTML = '<div class="it-row-btn"><span class="it-done-icon">&#10003;</span></div>';
    } else if (status === "error") {
      rightHTML = '<div class="it-row-btn"><button class="it-btn it-btn-ghost" onclick="itScrapeOne(\'' + esc(id) + '\')">Retry</button></div>';
    }

    // Champ URL manuel : saisie ponctuelle (non persistee) utilisee en
    // priorite absolue au scrape de cette ligne, via scrapeImageURL().
    var manualUrlHTML = "";
    if (status === "idle" || status === "error" || status === "skipped") {
      manualUrlHTML = '<div class="it-manual-url-wrap">' +
        '<input type="text" class="it-manual-url-input" placeholder="URL (optional)" value="' + esc(r.manualUrl || "") + '">' +
      '</div>';
    }

    // Mode solo : #it-solo-image-header affiche deja la vignette (simple ou
    // comparaison) juste au-dessus de cette ligne - la reglage
    // hideSoloRowThumb permet de ne pas la dupliquer ici.
    var isSoloMode = !!(document.getElementById(PANEL_ID) && document.getElementById(PANEL_ID).classList.contains("it-panel-solo"));
    // Solo: the row's thumbnail is the centered image (like sceneTagger); only the
    // existing-vs-scraped comparison header replaces it (no duplicate).
    var soloHdrEl = document.getElementById("it-solo-image-header");
    var soloCompare = isSoloMode && ((soloHdrEl && soloHdrEl.classList.contains("it-solo-compare")) ||
      (pluginConfig.compareImageOnScrape && status === "scraped" && r.scraped && !!extractScrapedThumb(r.scraped)));
    var showRowThumb = !soloCompare;
    var soloFile = isSoloMode && img.files && img.files.length ? img.files[0] : null;
    var soloMeta = soloFile ? [soloFile.width && soloFile.height ? soloFile.width + "×" + soloFile.height : "", soloFile.size ? formatFileSize(soloFile.size) : ""].filter(Boolean).join(" · ") : "";

    var progVeilHTML = (status === "scraping" && pluginConfig.progressVeil)
      ? '<div class="it-prog-veil" style="width:' + (((r.progP || 0) * 100).toFixed(2)) + '%"></div>' : "";
    var progLabelHTML = (status === "scraping" && pluginConfig.progressText)
      ? '<span class="it-prog-label">' + esc(r.progLabel || "Scraping...") + '</span>' : "";

    el.innerHTML =
      progVeilHTML +
      '<div class="it-row-top' + (showRowThumb ? '' : ' it-row-top-no-thumb') + '">' +
        // .image-thumbnail on the link, not the img: Stash's native SFW
        // blur (blur-nsfw-images.css / sfw.css) targets that class with
        // filter:blur(), and a filter always bleeds beyond its own box even
        // under overflow:hidden on the SAME element - so the class-bearing
        // element is the link, and the actual clipping (fixed size +
        // overflow:hidden) lives on the outer .it-thumb-clip wrapper, which
        // carries neither the class nor the filter (same pattern as
        // sceneTagger's .scene-card-preview, see CLAUDE.md).
        (showRowThumb ?
          '<span class="it-thumb-clip">' +
          (thumb
            ? '<a href="' + esc(window.location.origin + "/images/" + id) + '" target="_blank" class="it-thumb-link image-thumbnail"><img class="it-thumb" src="' + esc(thumb) + '" loading="lazy"></a>'
            : '<a href="' + esc(window.location.origin + "/images/" + id) + '" target="_blank" class="it-thumb-link image-thumbnail"><div class="it-thumb"></div></a>') +
          '</span>'
        : "") +
        '<div class="it-row-info">' +
          '<div class="it-filename" title="' + esc(headerShowsTitle ? headerLabel + '\n' + fname : fname) + '">' + esc(headerLabel) + '</div>' +
          (soloMeta ? '<div class="it-solo-img-meta">' + esc(soloMeta) + '</div>' : '') +
          progLabelHTML +
          hintHTML +
          manualUrlHTML +
        '</div>' +
        rightHTML +
      '</div>' +
      inlineHTML;

    // Aligne la largeur des champs Details/URLs avec la barre Apply/Organized.
    var syncColWidth = function () {
      var panelForW = document.getElementById(PANEL_ID);
      if (!panelForW || panelForW.classList.contains("it-panel-solo")) return;
      var actionBtns = el.querySelectorAll(".it-inline-actions button");
      if (!actionBtns.length) return;
      var w = actionBtns[actionBtns.length - 1].getBoundingClientRect().right -
              actionBtns[0].getBoundingClientRect().left;
      if (w > 0) el.style.setProperty("--it-col-w", Math.round(w) + "px");
    };
    syncColWidth();
    requestAnimationFrame(syncColWidth);

    // Split view: the performer / tag search boxes end right after the "..."
    // of their placeholder (measured with the input's own font).
    var fitSearchToPlaceholder = function () {
      var inputs = el.querySelectorAll(".it-split-list .it-perf-search-input, .it-split-list .it-tag-search-input");
      if (!inputs.length) return;
      var ctx = document.createElement("canvas").getContext("2d");
      // All the boxes of the row get the width of the longest one (the
      // performer box), so the tag box lines up with it on the right too.
      var widest = 0;
      inputs.forEach(function (input) {
        var cs = window.getComputedStyle(input);
        ctx.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
        var textW = ctx.measureText(input.placeholder || "").width;
        var w = Math.ceil(textW + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) +
                          parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth) + 6);
        if (w > widest) widest = w;
      });
      if (widest > 0) {
        inputs.forEach(function (input) {
          if (input.parentElement) input.parentElement.style.width = widest + "px";
        });
      }
    };
    fitSearchToPlaceholder();
    requestAnimationFrame(fitSearchToPlaceholder);

    // Copy button on the existing Details text (top right, shown on hover).
    el.querySelectorAll(".it-copy-text").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var box = btn.parentNode.querySelector(".it-details-readonly");
        itCopyText(box ? box.textContent : "").then(function () {
          btn.innerHTML = IT_ICON_CHECK;
          btn.classList.add("it-copy-text-ok");
          setTimeout(function () {
            btn.innerHTML = IT_ICON_COPY;
            btn.classList.remove("it-copy-text-ok");
          }, 1400);
        }).catch(function () {});
      });
    });

    el.querySelectorAll(".it-url-copy").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation();
        itCopyText(btn.getAttribute("data-url") || "").then(function () {
          btn.innerHTML = IT_ICON_CHECK;
          btn.classList.add("it-url-copy-ok");
          setTimeout(function () {
            btn.innerHTML = IT_ICON_COPY;
            btn.classList.remove("it-url-copy-ok");
          }, 1500);
        }).catch(function () {});
      });
    });

    var manualUrlInput = el.querySelector(".it-manual-url-input");
    if (manualUrlInput) {
      manualUrlInput.addEventListener("input", function () {
        r.manualUrl = manualUrlInput.value.trim();
      });
    }

    // Double-click the Title chip to rename it before applying: the chip becomes
    // editable in place; Enter or leaving it keeps the new title (r.titleEdit,
    // read by getCheckedScraped), Escape cancels, an empty title restores the
    // scraped one.
    (function () {
      var titleCb = el.querySelector('[data-cb="title"]');
      var titleChip = titleCb && titleCb.closest(".it-inline-field")
        ? titleCb.closest(".it-inline-field").querySelector(".it-chip-title") : null;
      if (!titleChip) return;
      titleChip.addEventListener("dblclick", function (e) {
        e.preventDefault();
        if (titleChip.isContentEditable) return;
        var before = titleChip.textContent;
        titleChip.contentEditable = "true";
        titleChip.classList.add("it-chip-editing");
        titleChip.focus();
        var range = document.createRange();
        range.selectNodeContents(titleChip);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        var done = false;
        function finish(commit) {
          if (done) return;
          done = true;
          titleChip.contentEditable = "false";
          titleChip.classList.remove("it-chip-editing");
          titleChip.removeEventListener("blur", onBlur);
          titleChip.removeEventListener("keydown", onKey);
          var text = (titleChip.textContent || "").replace(/\s+/g, " ").trim();
          if (!commit) { titleChip.textContent = before; return; }
          if (!text || text === scraped.title) {
            delete r.titleEdit;
            titleChip.textContent = scraped.title;
            titleChip.classList.remove("it-chip-edited");
          } else {
            r.titleEdit = text;
            titleChip.textContent = text;
            titleChip.classList.add("it-chip-edited");
            if (titleCb) titleCb.checked = true;
          }
        }
        function onBlur() { finish(true); }
        function onKey(ev) {
          if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
          else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
        }
        titleChip.addEventListener("blur", onBlur);
        titleChip.addEventListener("keydown", onKey);
      });
    })();

    var manualTitleInput = el.querySelector(".it-manual-title-input");
    if (manualTitleInput) {
      manualTitleInput.addEventListener("input", function () {
        r.manualTitle = manualTitleInput.value.trim();
      });
    }

    var detailsEdit = el.querySelector(".it-details-edit");
    if (detailsEdit) {
      // Grows with its text (no resize grip anymore). Measured again on the
      // next frame: the row may not be laid out yet when first built.
      var autoGrowDetails = function () {
        detailsEdit.style.height = "auto";
        detailsEdit.style.height = (detailsEdit.scrollHeight + 2) + "px";
      };
      detailsEdit.addEventListener("input", function () {
        r.detailsEditValue = detailsEdit.value;
        autoGrowDetails();
        // Mass list editor has a per-row checkbox: typing means "apply this".
        var detailsTypedCb = el.querySelector('[data-cb="details"]');
        if (detailsTypedCb && detailsEdit.value.trim()) detailsTypedCb.checked = true;
      });
      autoGrowDetails();
      requestAnimationFrame(autoGrowDetails);
    }

    var dateField = el.querySelector(".it-date-field");
    if (dateField) {
      wireDateOutsideClickOnce();
      dateField.querySelectorAll(".it-date-pop-nav").forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          window.itDateNav(id, parseInt(btn.getAttribute("data-dir"), 10));
        });
      });
      dateField.querySelectorAll(".it-date-cell[data-iso]").forEach(function (cell) {
        cell.addEventListener("click", function (e) {
          e.stopPropagation();
          window.itDatePick(id, cell.getAttribute("data-iso"));
        });
      });
      var dateClearBtn = dateField.querySelector('[data-action="clear"]');
      if (dateClearBtn) dateClearBtn.addEventListener("click", function (e) { e.stopPropagation(); window.itDateClear(id); });
      var dateTodayBtn = dateField.querySelector('[data-action="today"]');
      if (dateTodayBtn) dateTodayBtn.addEventListener("click", function (e) { e.stopPropagation(); window.itDateToday(id); });
    }

    var urlAddInput = el.querySelector(".it-url-add-input");
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
    // ── Boutons blacklist sur les radio artistes
    if (status === "scraped") {
      el.querySelectorAll('.it-blacklist-btn').forEach(function(btn) {
        btn.addEventListener("click", function(e) {
          e.preventDefault(); e.stopPropagation();
          var artist = btn.getAttribute("data-artist");
          if (!artist) return;
          var n = artist.toLowerCase();
          if (pluginConfig.studioBlacklist.indexOf(n) === -1) {
            pluginConfig.studioBlacklist.push(n);
            savePluginConfig();
            backupBlacklist();
          }
          renderRow(id);
          var settingsPanel = document.getElementById("it-settings-panel");
          if (settingsPanel && settingsPanel.style.display !== "none") {
            document.dispatchEvent(new CustomEvent("it-blacklist-updated"));
          }
        });
      });
    }

    // ── Recherche performers live
    if (status === "scraped") {
      var perfSearchInput   = el.querySelector('.it-perf-search-input');
      var perfSearchResults = el.querySelector('.it-perf-search-results');
      var perfsAdded        = el.querySelector('.it-perfs-added');

      if (perfSearchInput && perfSearchResults && perfsAdded) {
        var perfSearchTimer = null;

        perfSearchInput.addEventListener("input", function() {
          clearTimeout(perfSearchTimer);
          var q = perfSearchInput.value.trim();
          if (q.length < 2) { perfSearchResults.style.display = "none"; perfSearchResults.innerHTML = ""; return; }
          perfSearchTimer = setTimeout(function() {
            Promise.all([
              gql("FPS",  Q_FP_SEARCH,       { n: q }).then(function(d) { return (d.findPerformers || {}).performers || []; }).catch(function(){return[];}),
              gql("FPSA", Q_FP_SEARCH_ALIAS, { n: q }).then(function(d) { return (d.findPerformers || {}).performers || []; }).catch(function(){return[];})
            ]).then(function(results) {
              var seen = {}; var perfs = [];
              results[0].concat(results[1]).forEach(function(p) {
                if (!seen[p.id]) { seen[p.id] = true; perfs.push(p); }
              });
              perfs = perfs.slice(0, 10);
              var createItem = '<div class="it-perf-result-item it-perf-create-item" data-id="" data-name="' + esc(q) + '">+ Create "' + esc(q) + '"</div>';
              perfSearchResults.innerHTML = perfs.map(function(p) {
                return '<div class="it-perf-result-item" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '" data-image="' + esc(p.image_path || "") + '">' + esc(p.name) + '</div>';
              }).join("") + createItem;
              perfSearchResults.style.display = "block";
            });
          }, 300);
        });

        perfSearchInput.addEventListener("keydown", function(e) {
          if (e.key !== "Enter") return;
          var first = perfSearchResults.querySelector('.it-perf-result-item');
          if (first) first.click();
        });

        // Miniature au survol : un seul element reutilisable plutot qu'une
        // image par resultat.
        var perfHoverPreview = null;
        perfSearchResults.addEventListener("mouseover", function (e) {
          var item = e.target.closest('.it-perf-result-item');
          if (!item) return;
          var img = item.getAttribute("data-image");
          if (!img) { if (perfHoverPreview) perfHoverPreview.style.display = "none"; return; }
          if (!perfHoverPreview) {
            perfHoverPreview = document.createElement("img");
            perfHoverPreview.className = "it-perf-hover-preview";
            perfSearchResults.parentNode.appendChild(perfHoverPreview);
          }
          perfHoverPreview.src = img;
          var wrapRect = perfSearchResults.parentNode.getBoundingClientRect();
          var itemRect = item.getBoundingClientRect();
          perfHoverPreview.style.left = "100%";
          perfHoverPreview.style.top = (itemRect.top - wrapRect.top) + "px";
          perfHoverPreview.style.display = "block";
        });
        perfSearchResults.addEventListener("mouseleave", function () {
          if (perfHoverPreview) perfHoverPreview.style.display = "none";
        });

        perfSearchResults.addEventListener("click", function(e) {
          var item = e.target.closest('.it-perf-result-item');
          if (!item) return;
          var pid    = item.getAttribute("data-id");
          var pname  = item.getAttribute("data-name");
          var pimage = item.getAttribute("data-image");
          var already = Array.from(perfsAdded.querySelectorAll('[data-cb="performer-added"]'))
            .some(function(el) { return el.getAttribute("data-perf-name").toLowerCase() === pname.toLowerCase(); });
          if (already) { perfSearchResults.style.display = "none"; perfSearchInput.value = ""; return; }
          var chip = document.createElement("span");
          chip.className = "it-perf-added-chip";
          chip.innerHTML =
            (pimage ? '<img class="it-perf-chip-avatar" src="' + esc(pimage) + '">' : '') +
            esc(pname) + ' <button class="it-perf-chip-remove" title="Remove">&#10005;</button>';
          chip.setAttribute("data-cb", "performer-added");
          chip.setAttribute("data-perf-id", pid);
          chip.setAttribute("data-perf-name", pname);
          chip.querySelector('.it-perf-chip-remove').addEventListener("click", function() { chip.remove(); });
          perfsAdded.appendChild(chip);
          perfSearchResults.style.display = "none";
          perfSearchResults.innerHTML = "";
          perfSearchInput.value = "";
        });

        document.addEventListener("click", function onPerfDocClick(e) {
          if (!el.contains(e.target)) {
            perfSearchResults.style.display = "none";
            document.removeEventListener("click", onPerfDocClick);
          }
        });

        wireAvatarHoverPreview(perfsAdded, ".it-perf-added-chip");
      }

      var perfsGrid = el.querySelector(".it-perfs-grid");
      if (perfsGrid) wireAvatarHoverPreview(perfsGrid, ".it-perf-item");
    }

    // ── Recherche tags live
    if (status === "scraped") {
      var tagSearchInput   = el.querySelector('.it-tag-search-input');
      var tagSearchResults = el.querySelector('.it-tag-search-results');
      var tagsAdded        = el.querySelector('.it-tags-added');

      if (tagSearchInput && tagSearchResults && tagsAdded) {
        var tagSearchTimer = null;

        tagSearchInput.addEventListener("input", function() {
          clearTimeout(tagSearchTimer);
          var q = tagSearchInput.value.trim();
          if (q.length < 2) { tagSearchResults.style.display = "none"; tagSearchResults.innerHTML = ""; return; }
          tagSearchTimer = setTimeout(function() {
            gql("FT_SEARCH", "query FTSearch($n:String!){findTags(tag_filter:{name:{value:$n,modifier:INCLUDES}},filter:{per_page:10}){tags{id name}}}", { n: q })
              .then(function(d) {
                var tags = ((d.findTags || {}).tags || []).slice(0, 10);
                var createItem = '<div class="it-tag-result-item it-tag-create-item" data-id="" data-name="' + esc(q) + '">+ Create "' + esc(q) + '"</div>';
                tagSearchResults.innerHTML = tags.map(function(t) {
                  return '<div class="it-tag-result-item" data-id="' + esc(t.id) + '" data-name="' + esc(t.name) + '">' + esc(t.name) + '</div>';
                }).join("") + createItem;
                tagSearchResults.style.display = "block";
              }).catch(function() {});
          }, 300);
        });

        tagSearchInput.addEventListener("keydown", function(e) {
          if (e.key !== "Enter") return;
          var first = tagSearchResults.querySelector('.it-tag-result-item');
          if (first) first.click();
        });

        tagSearchResults.addEventListener("click", function(e) {
          var item = e.target.closest('.it-tag-result-item');
          if (!item) return;
          var tid   = item.getAttribute("data-id");
          var tname = item.getAttribute("data-name");
          var already = Array.from(tagsAdded.querySelectorAll('[data-cb="tag-added"]'))
            .some(function(chip) { return chip.getAttribute("data-tag-name").toLowerCase() === tname.toLowerCase(); });
          if (already) { tagSearchResults.style.display = "none"; tagSearchInput.value = ""; return; }
          var chip = document.createElement("span");
          chip.className = "it-tag-added-chip";
          chip.innerHTML = esc(tname) + ' <button class="it-tag-chip-remove" title="Remove">&#10005;</button>';
          chip.setAttribute("data-cb", "tag-added");
          chip.setAttribute("data-tag-id", tid);
          chip.setAttribute("data-tag-name", tname);
          chip.querySelector('.it-tag-chip-remove').addEventListener("click", function() { chip.remove(); });
          tagsAdded.appendChild(chip);
          tagSearchResults.style.display = "none";
          tagSearchResults.innerHTML = "";
          tagSearchInput.value = "";
        });

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
      var searchInput   = el.querySelector('.it-studio-search-input');
      var searchResults = el.querySelector('.it-studio-search-results');
      var overrideInput = el.querySelector('[data-cb="studio-override"]');
      var selectedSpan  = el.querySelector('.it-studio-selected');
      var manualEmptyHint = el.querySelector('.it-studio-manual-empty');

      if (searchInput && searchResults && overrideInput) {
        var searchTimer = null;

        searchInput.addEventListener("input", function () {
          clearTimeout(searchTimer);
          var q = searchInput.value.trim();
          if (q.length < 2) { searchResults.style.display = "none"; searchResults.innerHTML = ""; return; }
          searchTimer = setTimeout(function () {
            gql("FSS", Q_FS_SEARCH, { n: q }).then(function (d) {
              var studios = ((d.findStudios || {}).studios || []).slice(0, 8);
              var createItem = '<div class="it-studio-result-item it-studio-create-item" data-id="" data-name="' + esc(q) + '">+ Create "' + esc(q) + '"</div>';
              if (!studios.length) {
                searchResults.innerHTML = createItem;
              } else {
                searchResults.innerHTML = studios.map(function (s) {
                  return '<div class="it-studio-result-item" data-id="' + esc(s.id) + '" data-name="' + esc(s.name) + '">' + esc(s.name) + '</div>';
                }).join("") + createItem;
              }
              searchResults.style.display = "block";
            }).catch(function () {});
          }, 300);
        });

        searchResults.addEventListener("click", function (e) {
          var item = e.target.closest('.it-studio-result-item');
          if (!item) return;
          var sid  = item.getAttribute("data-id");
          var sname = item.getAttribute("data-name");
          // Store the override
          pinRowToFilter(el.id.replace("it-row-", ""));
          overrideInput.value = sname;
          overrideInput.setAttribute("data-studio-id", sid);
          // Show the selected studio as a bordered chip + remove (✕),
          // matching the "Already on this scene"/"New from scrape" rows
          // instead of the old plain "→ name" link.
          selectedSpan.innerHTML = esc(sname) + ' <span class="it-studio-selected-x">&#10005;</span>';
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
          if (sid) {
            gql("StudioImg", Q_STUDIO_IMAGE, { id: sid }).then(function (d) {
              var st = d.findStudio || {};
                            setManualStudioCardIT(el, st.image_path, studioBannerUrlIT(st), sid);
            }).catch(function () {});
          } else {
            // "+ Create ..." path - brand new studio, no image yet.
            setManualStudioCardIT(el, null, null);
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
            pinRowToFilter(el.id.replace("it-row-", ""));
            overrideInput.value = "";
            overrideInput.setAttribute("data-studio-id", "");
            selectedSpan.style.display = "none";
            if (manualEmptyHint) manualEmptyHint.style.display = "";
            setManualStudioCardIT(el, null, null);
          });
        }
      }
    }

    // Toggle perfs-all et tags-all
    if (status === "scraped") {
      var tagsAllCb = el.querySelector('[data-cb="tags-all"]');
      if (tagsAllCb) {
        tagsAllCb.addEventListener("change", function() {
          el.querySelectorAll('[data-cb="tag"]').forEach(function(cb) { cb.checked = tagsAllCb.checked; });
        });
      }
      var perfsAllCb = el.querySelector('[data-cb="perfs-all"]');
      if (perfsAllCb) {
        perfsAllCb.addEventListener("change", function() {
          el.querySelectorAll('[data-cb="performer"]').forEach(function(cb) { cb.checked = perfsAllCb.checked; });
        });
      }
    }

    if (status === "scraped") hydrateStudioLookupsIT(el);
    setupBannerLayoutCard(el, blScrapedStudio);
    applyStudioFilter();
  }

  // ── Filtre studio live ─────────────────────────────────────────────────────

  function getRowStudioStatus(id) {
    var r = state.rows[id];
    if (!r || r.status !== "scraped" || !r.scraped) return "none";

    var row = document.getElementById("it-row-" + id);
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
    var list = document.getElementById("it-scraper-filter-list");
    var btn  = document.getElementById("it-scraper-filter-btn");
    if (!list || !btn) return;
    var seen = {};
    var options = [];
    state.images.forEach(function (img) {
      var r = state.rows[img.id];
      // Applied images still count, so the selected scraper stays in the list
      // (and the filter is not reset to "All scrapers") once they are applied.
      if (r && (r.status === "scraped" || r.status === "done") && r.matchedScraperID && !seen[r.matchedScraperID]) {
        seen[r.matchedScraperID] = true;
        options.push({ id: r.matchedScraperID, name: r.matchedScraperName || r.matchedScraperID });
      }
    });
    options.sort(function (a, b) { return a.name.localeCompare(b.name); });

    var current = state.scraperFilter;
    var stillValid = current === "all" || seen[current];
    if (!stillValid) { state.scraperFilter = "all"; current = "all"; }

    list.innerHTML =
      '<div class="it-combo-option' + (current === "all" ? " it-combo-option-selected" : "") + '" role="option" data-id="all" data-name="All scrapers">All scrapers</div>' +
      options.map(function (o) {
        return '<div class="it-combo-option' + (o.id === current ? " it-combo-option-selected" : "") + '" role="option" data-id="' + esc(o.id) + '" data-name="' + esc(o.name) + '">' + esc(o.name) + '</div>';
      }).join("");
    var currentOpt = options.filter(function (o) { return o.id === current; })[0];
    btn.textContent = current === "all" ? "All scrapers" : (currentOpt ? currentOpt.name : current);
  }

  // A row has "multiple studio candidates" when the scrape surfaced more
  // than one candidate studio radio (data-artist set) for that row -
  // regardless of which one is currently selected for apply.
  function rowHasMultipleStudioCandidates(id) {
    var row = document.getElementById("it-row-" + id);
    if (!row) return false;
    var candidateRadios = row.querySelectorAll('[data-cb="studio-radio"][data-artist]:not([data-artist=""])');
    return candidateRadios.length > 1;
  }

  // A row the user is editing (a studio picked / removed in its search box changes its
  // new/existing status) must not leave the filter it is shown under: remember the filter
  // combo it was visible under. The pins are dropped as soon as the user changes a filter.
  function pinRowToFilter(id) {
    var r = state.rows[id], el = document.getElementById("it-row-" + id);
    if (!r || !el) return;
    r.filterPin = el.style.display !== "none"
      ? { f: state.studioFilter, sf: state.scraperFilter, multi: state.multiStudioOnly } : null;
  }
  function clearFilterPins() {
    Object.keys(state.rows).forEach(function (k) { if (state.rows[k]) state.rows[k].filterPin = null; });
  }

  function applyStudioFilter() {
    var f = state.studioFilter;
    var sf = state.scraperFilter;
    // Multi-studio button, 3 states: false = off, true = only rows with several studio candidates,
    // "exclude" = hide those rows. The raw value is what the filter pins compare against.
    var multiMode = state.multiStudioOnly;
    var multiOnly = multiMode === true;
    var multiExcl = multiMode === "exclude";
    state.images.forEach(function(img) {
      var el = document.getElementById("it-row-" + img.id);
      if (!el) return;
      var r = state.rows[img.id];
      // "Failed" filter: only the rows whose scrape failed (error, or kept as
      // manual fill-in after a failed scrape); none when a scraper / multi-studio
      // filter is also active (a failed row has neither).
      if (f === "failed") {
        var isFail = !!r && (r.status === "error" || (r.status === "scraped" && !!r.manualFallback));
        el.style.display = (isFail && sf === "all" && !multiOnly) ? "" : "none";
        return;
      }
      // Errors: no new/existing status since there's no scraped result to
      // classify - hidden under New/Existing, stay visible under All so
      // failures needing a retry aren't lost from view.
      if (r && r.status === "error" && (f !== "all" || sf !== "all" || multiOnly)) {
        el.style.display = "none";
        return;
      }
      // Skipped by the user: visible under "All" with no other filter, and under the filter combo
      // it was skipped from (so it can still be un-skipped there), hidden under any other one.
      if (r && r.status === "skipped") {
        var sp = r.skipPin;
        var plain = f === "all" && sf === "all" && !multiOnly;
        el.style.display = (plain || !sp || (sp.f === f && sp.sf === sf && sp.multi === multiMode)) ? "" : "none";
        return;
      }
      // Applied (validated) images stay in the list, but only under the filters
      // they belong to: their scraper, and the studio status (new / existing /
      // several candidates) the row had when it was applied (r.filterSnap, taken
      // just before the apply - the applied row no longer shows that data).
      if (r && (r.status === "done" || r.status === "applying")) {
        var snap = r.filterSnap || {};
        // Still visible under the exact filter combo it was applied from.
        if (snap.pin && snap.pin.f === f && snap.pin.sf === sf && snap.pin.multi === multiMode) { el.style.display = ""; return; }
        if (sf !== "all" && r.matchedScraperID !== sf) { el.style.display = "none"; return; }
        if (multiOnly && !snap.multi) { el.style.display = "none"; return; }
        if (multiExcl && snap.multi) { el.style.display = "none"; return; }
        if (f === "all") { el.style.display = ""; return; }
        el.style.display = (snap.studio === f) ? "" : "none";
        return;
      }
      if (r && r.status === "scraped" && r.filterPin && r.filterPin.f === f && r.filterPin.sf === sf && r.filterPin.multi === multiMode) {
        el.style.display = ""; return;   // being edited: stays where the user sees it
      }
      if (!r || r.status !== "scraped") {
        // Not scraped yet: no new/existing status either, so hide under
        // New/Existing too (only visible under All with no other filter).
        el.style.display = (f === "all" && sf === "all" && !multiOnly) ? "" : "none";
        return;
      }
      if (sf !== "all" && r.matchedScraperID !== sf) { el.style.display = "none"; return; }
      if (multiOnly && !rowHasMultipleStudioCandidates(img.id)) { el.style.display = "none"; return; }
      if (multiExcl && rowHasMultipleStudioCandidates(img.id)) { el.style.display = "none"; return; }
      if (f === "all") { el.style.display = ""; return; }
      var status = getRowStudioStatus(img.id);
      if (f === "new")      el.style.display = (status === "new")      ? "" : "none";
      if (f === "existing") el.style.display = (status === "existing") ? "" : "none";
    });
  }

  function buildAllRows() {
    var c = document.getElementById("it-rows");
    if (!c) return;
    c.innerHTML = "";
    renderScraperFilterOptions();
    state.images.forEach(function(img) {
      var el = document.createElement("div");
      el.id = "it-row-" + img.id;
      el.className = "it-row it-state-idle";
      c.appendChild(el);
      renderRow(img.id);
    });
    updatePageInfo();
  }

  // ── Actions globales ───────────────────────────────────────────────────────

  // Apres un scrape reussi : verifie en arriere-plan si des candidats
  // studio marques "new" (pas de stored_id) correspondent en fait a un
  // alias/nom exact existant, et re-rend la ligne si le badge doit changer.
  // Non bloquant : la ligne s'affiche normalement pendant la verification.
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

  // Pour les performers deja lies a une entree existante (stored_id), va
  // chercher l'avatar local (image_path) de ce performer afin que la
  // grille de checkboxes affiche le meme avatar rond que les performers
  // ajoutes manuellement via la recherche. Volontairement PAS p.images
  // (image du site source, potentiellement obsolete pour un performer deja
  // curé localement) - seuls ceux deja en base qualifient. Non bloquant,
  // meme pattern que refreshStudioAliasBadges.
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

  // Wiring de preview au survol partage pour tout conteneur contenant des
  // .it-perf-chip-avatar (chips ajoutees ET grille checkbox performers) -
  // un seul <img> flottant reutilise, repositionne au-dessus de l'element
  // survole.
  function wireAvatarHoverPreview(container, chipSelector) {
    var preview = null;
    container.addEventListener("mouseover", function (e) {
      var avatar = e.target.closest(".it-perf-chip-avatar");
      if (!avatar) return;
      if (!preview) {
        preview = document.createElement("img");
        preview.className = "it-perf-hover-preview";
        container.appendChild(preview);
      }
      preview.src = avatar.src;
      var wrapRect = container.getBoundingClientRect();
      var chipRect = avatar.closest(chipSelector).getBoundingClientRect();
      preview.style.top  = (chipRect.top - wrapRect.top - 106 - 6) + "px";
      preview.style.left = (chipRect.left - wrapRect.left) + "px";
      preview.style.display = "block";
    });
    container.addEventListener("mouseleave", function () {
      if (preview) preview.style.display = "none";
    });
  }

  // Marque un échec de scrape sur la ligne r. Si le mode "remplissage
  // manuel" est activé, traite la ligne comme "scraped" avec des données
  // vides (affiche le panel habituel : studio/performers/tags/details tous
  // vides, prêt à remplir à la main) au lieu d'une simple erreur - le
  // message d'erreur original reste visible dans un bandeau pour contexte.
  function applyOrganizedAutoDefault(r) {
    var hasStudio = !!(r.scraped && r.scraped.studio && r.scraped.studio.name);
    r.markOrganized = pluginConfig.autoMarkOrganized && hasStudio;
  }

  function handleScrapeFailure(r, msg) {
    if (pluginConfig.manualFallbackOnFail) {
      r.status = "scraped";
      r.scraped = {};
      r.manualFallback = true;
      r.msg = msg;
      // Pre-fill the manual title with the file name (extension stripped)
      if (pluginConfig.manualFallbackAllowTitle && pluginConfig.manualFallbackPrefillFilename && !r.manualTitle && r.image) {
        r.manualTitle = getFilename(r.image).replace(/^.*[\\/]/, "").replace(/\.[A-Za-z0-9]{1,5}$/, "");
      }
      applyOrganizedAutoDefault(r);
    } else {
      r.status = "error";
      r.msg = msg;
    }
  }

  // ── Custom date picker handlers ─────────────────────────────────────────

  window.itDateToggle = function (id) {
    var r = state.rows[id];
    if (!r) return;
    r.dateCalendarOpen = !r.dateCalendarOpen;
    renderRow(id);
  };

  window.itDateNav = function (id, dir) {
    var r = state.rows[id];
    if (!r) return;
    r.dateCalendarMonth = shiftMonthISO(r.dateCalendarMonth || new Date().toISOString().slice(0, 7), dir);
    renderRow(id);
  };

  window.itDatePick = function (id, iso) {
    var r = state.rows[id];
    if (!r) return;
    r.dateEditValue = iso;
    r.dateCalendarMonth = iso.slice(0, 7);
    r.dateCalendarOpen = false;
    renderRow(id);
  };

  window.itDateClear = function (id) {
    var r = state.rows[id];
    if (!r) return;
    r.dateEditValue = "";
    r.dateCalendarOpen = false;
    renderRow(id);
  };

  window.itDateToday = function (id) {
    var r = state.rows[id];
    if (!r) return;
    var iso = new Date().toISOString().slice(0, 10);
    r.dateEditValue = iso;
    r.dateCalendarMonth = iso.slice(0, 7);
    r.dateCalendarOpen = false;
    renderRow(id);
  };

  window.itRemoveUrl = function (id, idx) {
    var r = state.rows[id];
    if (!r || !r.urlEditList) return;
    r.urlEditList.splice(idx, 1);
    renderRow(id);
  };

  window.itScrapeOne = function(id) {
    var r = state.rows[id];
    if (!r) return;
    r.status = "scraping"; r.scraped = null; r.msg = ""; r.matchedScraperName = null; r.matchedScraperID = null; r.manualFallback = false;
    progStart(id);
    renderRow(id);
    updateStatus("Scraping " + getFilename(r.image) + "...");

    scrapeOneEffective(id)
      .then(function(res) { return progFinish(id).then(function () { return res; }); })
      .then(function(res) {
        if (!res.scraped) { handleScrapeFailure(r, "No result"); }
        else               { r.status = "scraped"; r.scraped = res.scraped; r.matchedScraperName = res.scraperName; r.matchedScraperID = res.scraperID; applyOrganizedAutoDefault(r); }
        renderRow(id); updatePageInfo(); renderScraperFilterOptions(); applyStudioFilter();
        progReveal(id);
        if (r.status === "scraped") {
          refreshStudioAliasBadges(id);
          fetchStoredPerformerImages(id);
          updateSoloImageHeader(id, extractScrapedThumb(r.scraped));
        }
      })
      .catch(function(err) {
        // A thrown scrape error skips the .then() above: give the veil its run to 100% here, then fail.
        (r.progCtx ? Promise.resolve() : progFinish(id)).then(function () {
          handleScrapeFailure(r, err.message || String(err));
          renderRow(id); updatePageInfo();
          progReveal(id);
        });
      });
  };

  // Azure halo on a row that has just been applied (same flare as the scrape hand-over).
  function flashAppliedRow(id) {
    if (!pluginConfig.applyFlare) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var panelEl = document.getElementById(PANEL_ID);
    if (panelEl && panelEl.classList.contains("it-no-outline")) return;
    var el = document.getElementById("it-row-" + id);
    if (!el) return;
    el.style.animation = "none";
    void el.offsetWidth;   // restart the animation if it ran before
    el.style.animation = "it-flare .8s ease-out";
    setTimeout(function () { el.style.animation = ""; }, 900);
  }

  window.itApplyOne = function(id) {
    var r = state.rows[id];
    if (!r) return;
    var filtered = getCheckedScraped(id);
    if (!filtered) return;
    // Snapshot for the filters (see applyStudioFilter): taken while the row still
    // shows its scraped data, before it is re-rendered as "applying" / "done".
    var rowElPin = document.getElementById("it-row-" + id);
    var shownNow = !!rowElPin && rowElPin.style.display !== "none";
    r.filterSnap = {
      studio: getRowStudioStatus(id), multi: rowHasMultipleStudioCandidates(id),
      pin: shownNow ? { f: state.studioFilter, sf: state.scraperFilter, multi: state.multiStudioOnly } : null
    };
    r.status = "applying"; renderRow(id);

    return applyScrapedData(id, filtered)
      .then(function() {
        r.status = "done"; renderRow(id); updatePageInfo(); renderScraperFilterOptions(); applyStudioFilter();
        flashAppliedRow(id);
        updateStatus("Applied: " + getFilename(r.image));
      })
      .catch(function(err) {
        r.status = "error"; r.msg = "Apply : " + (err.message || String(err));
        renderRow(id); updatePageInfo();
      });
  };

  window.itSkipOne = function(id) {
    var r = state.rows[id];
    if (!r) return;
    // Remember the filter combo the row was visible under (see applyStudioFilter): a skipped row
    // stays there, but does not follow the user into the other filters.
    var rowEl = document.getElementById("it-row-" + id);
    r.skipPin = (rowEl && rowEl.style.display !== "none")
      ? { f: state.studioFilter, sf: state.scraperFilter, multi: state.multiStudioOnly } : null;
    var panelEl = document.getElementById(PANEL_ID);
    if (pluginConfig.ejectSkipped && !isSoloPanel(panelEl)) {
      // Eject: the row leaves the list for good (comes back only on Reload).
      if (rowEl && rowEl.parentNode) rowEl.parentNode.removeChild(rowEl);
      state.images = state.images.filter(function (im) { return String(im.id) !== String(id); });
      delete state.rows[id];
      updatePageInfo();
      refillAfterEject();
      return;
    }
    r.status = "skipped"; renderRow(id); updatePageInfo();
  };

  // After a Skip ejected a row (setting "ejectSkipped"), top the list back up to
  // "Images per page" with the images that follow it in the Stash UI list. Pages after the
  // loaded one are read in order; leftovers of a page wait in state.fillQueue. Stash UI only
  // (the classic grid cannot give images beyond the visible page).
  var _refilling = false;
  function refillAfterEject() {
    if (!_host || _refilling) return;
    var target = stashuiPerPage();
    if (state.images.length >= target) return;
    var token = _loadImagesToken;
    _refilling = true;
    function nextIds() {
      if (state.fillQueue && state.fillQueue.length) return Promise.resolve();
      var page = (state.fillPage || state.currentPage || 1) + 1;
      if (page > state.totalPages) return Promise.resolve();
      return _host.fetchIds(page).then(function (r) {
        if (token !== _loadImagesToken) return;
        state.fillPage = page;
        state.totalPages = r.total;
        state.fillQueue = (state.fillQueue || []).concat(r.ids);
      });
    }
    function step() {
      if (token !== _loadImagesToken) return Promise.resolve();
      var need = target - state.images.length;
      if (need <= 0) return Promise.resolve();
      return nextIds().then(function () {
        if (token !== _loadImagesToken || !state.fillQueue || !state.fillQueue.length) return;
        var have = {};
        state.images.forEach(function (im) { have[String(im.id)] = true; });
        var take = [];
        while (state.fillQueue.length && take.length < need) {
          var id = String(state.fillQueue.shift());
          if (!have[id]) take.push(id);
        }
        if (!take.length) return step();
        return gql("FindImagesByIds", Q_FIND_BY_IDS, { ids: take }).then(function (d) {
          if (token !== _loadImagesToken) return;
          var byId = {};
          ((d.findImages || {}).images || []).forEach(function (im) { byId[im.id] = im; });
          var container = document.getElementById("it-rows");
          take.map(function (id) { return byId[id]; }).filter(Boolean).forEach(function (img) {
            state.images.push(img);
            state.rows[img.id] = { image: img, status: "idle", scraped: null, msg: "" };
            if (!container) return;
            var el = document.createElement("div");
            el.id = "it-row-" + img.id;
            el.className = "it-row it-state-idle";
            container.appendChild(el);
            renderRow(img.id);
          });
          updatePageInfo();
          return step();
        });
      });
    }
    step().catch(function () {}).then(function () {
      _refilling = false;
      // Rows skipped while the fetch was running: top up again if there is still something to read.
      if (token === _loadImagesToken && state.images.length < target &&
          ((state.fillQueue && state.fillQueue.length) || (state.fillPage || state.currentPage || 1) < state.totalPages))
        refillAfterEject();
    });
  }

  window.itToggleOrganized = function(id) {
    var r = state.rows[id];
    if (!r) return;
    r.markOrganized = !r.markOrganized;
    renderRow(id);
  };

  // ── Scrape All séquentiel ──────────────────────────────────────────────────

  function scrapeAll() {
    if (state.running) return;
    var todo = state.images.filter(function(img) {
      var s = (state.rows[img.id] || {}).status;
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
        updateStatus("Done — " + todo.length + " images processed");
        updatePageInfo();
        return;
      }
      var img = todo[i];
      var r   = state.rows[img.id];
      if (!r) { next(i+1); return; }

      updateProgress(i, todo.length);
      updateStatus("Scraping " + (i+1) + "/" + todo.length + " : " + getFilename(img));
      r.status = "scraping"; r.scraped = null; r.msg = ""; r.matchedScraperName = null; r.matchedScraperID = null; r.manualFallback = false;
      progStart(img.id);
      renderRow(img.id);

      scrapeOneEffective(img.id)
        .then(function(res) { return progFinish(img.id).then(function () { return res; }); })
        .then(function(res) {
          if (!res.scraped) { handleScrapeFailure(r, "No result"); }
          else               { r.status = "scraped"; r.scraped = res.scraped; r.matchedScraperName = res.scraperName; r.matchedScraperID = res.scraperID; applyOrganizedAutoDefault(r); }
          renderRow(img.id); updatePageInfo(); renderScraperFilterOptions(); applyStudioFilter();
          progReveal(img.id);
          if (r.status === "scraped") { refreshStudioAliasBadges(img.id); fetchStoredPerformerImages(img.id); }
          setTimeout(function() { next(i+1); }, 700);
        })
        .catch(function(err) {
          (r.progCtx ? Promise.resolve() : progFinish(img.id)).then(function () {
            handleScrapeFailure(r, err.message || String(err));
            renderRow(img.id); updatePageInfo();
            progReveal(img.id);
            setTimeout(function() { next(i+1); }, 700);
          });
        });
    })(0);
  }

  // ── Apply All — utilise les checkboxes cochées de chaque ligne ─────────────

  function applyAll() {
    var todo = state.images.filter(function(img) {
      if ((state.rows[img.id] || {}).status !== "scraped") return false;
      var el = document.getElementById("it-row-" + img.id);
      return el && el.style.display !== "none";
    });
    if (!todo.length) return;
    setApplyAllBtn(true);
    updateStatus("Bulk apply: " + todo.length + " images...");

    var pending = [];
    var seq = Promise.resolve();
    todo.forEach(function(img) {
      seq = seq.then(function() {
        pending.push(window.itApplyOne(img.id));
        return new Promise(function(resolve) { setTimeout(resolve, 300); });
      });
    });
    seq.then(function() { return Promise.all(pending); })
      .catch(function() {})
      .then(function() { updateStatus("All images applied"); });
  }

  // ── Skip All ───────────────────────────────────────────────────────────────
  // Meme perimetre que applyAll() : seules les lignes scrapees actuellement
  // visibles sous le filtre actif (studio + multi-studio + scraper) sont
  // skippees.
  function skipAll() {
    var todo = state.images.filter(function(img) {
      if ((state.rows[img.id] || {}).status !== "scraped") return false;
      var el = document.getElementById("it-row-" + img.id);
      return el && el.style.display !== "none";
    });
    if (!todo.length) return;
    todo.forEach(function(img) { window.itSkipOne(img.id); });
    updateStatus(todo.length + " images skipped");
  }

  // ── Status / progress ──────────────────────────────────────────────────────

  function updateStatus(t) { var el = document.getElementById("it-status-text"); if (el) el.textContent = t; }

  function updateProgress(done, total) {
    var b = document.getElementById("it-progress-bar");
    if (b) b.style.width = (total > 0 ? Math.round(done/total*100) : 0) + "%";
  }

  function updatePageInfo() {
    var el = document.getElementById("it-page-info");
    if (!el) return;
    var scraped = 0, done = 0, errors = 0;
    Object.keys(state.rows).forEach(function(id) {
      var s = state.rows[id].status;
      if (s === "scraped") scraped++;
      if (s === "done")    done++;
      if (s === "error")   errors++;
    });
    // While the per-page box is open (Stash UI list), the text is left alone
    if (!el.querySelector("input"))
      el.textContent = state.images.length + " images" +
        (done    ? " — " + done    + " applied" : "") +
        (scraped ? " — " + scraped + " pending" : "") +
        (errors  ? " — " + errors  + " errors"    : "");
    setApplyAllBtn(scraped === 0);
    setSkipAllBtn(scraped === 0);
  }

  function setScrapeAllBtn(d) {
    var b = document.getElementById("it-btn-scrape-all"); if (b) b.disabled = d;
    var drag = document.getElementById("it-titlebar-drag");
    if (drag) drag.classList.toggle("it-titlebar-active", d);
  }
  function setApplyAllBtn(d)  { var b = document.getElementById("it-btn-apply-all");  if (b) b.disabled = d; }
  function setSkipAllBtn(d)   { var b = document.getElementById("it-btn-skip-all");   if (b) b.disabled = d; }

  function updatePageNav() {
    var prevBtn = document.getElementById("it-btn-page-prev");
    var nextBtn = document.getElementById("it-btn-page-next");
    var label   = document.getElementById("it-page-nav-label");
    if (prevBtn) prevBtn.disabled = state.currentPage <= 1;
    if (nextBtn) nextBtn.disabled = state.currentPage >= state.totalPages;
    if (label)   label.textContent = state.currentPage + " / " + state.totalPages;
  }

  // ── Chaine de repli scrapers (Settings) : checkbox + reorder par drag ─────

  function renderScraperChain() {
    var container = document.getElementById("it-scraper-chain");
    if (!container) return;

    container.innerHTML = pluginConfig.scraperChain.map(function (c, i) {
      var scraper = state.scrapers.filter(function (s) { return s.id === c.id; })[0];
      var name = scraper ? scraper.name : c.id;
      return '<div class="it-chain-item" draggable="true" data-idx="' + i + '">' +
        '<span class="it-chain-handle" title="Drag to reorder">&#8942;&#8942;</span>' +
        '<label class="it-chain-label"><input type="checkbox" data-idx="' + i + '"' + (c.enabled ? ' checked' : '') + '> ' + esc(name) + '</label>' +
      '</div>';
    }).join("");

    container.querySelectorAll('.it-chain-item input[type="checkbox"]').forEach(function (cb) {
      cb.addEventListener("change", function () {
        var idx = parseInt(cb.getAttribute("data-idx"), 10);
        pluginConfig.scraperChain[idx].enabled = cb.checked;
        savePluginConfig();
      });
    });

    var dragSrcIdx = null;
    container.querySelectorAll(".it-chain-item").forEach(function (item) {
      item.addEventListener("dragstart", function (e) {
        dragSrcIdx = parseInt(item.getAttribute("data-idx"), 10);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(dragSrcIdx)); // requis par Firefox
        item.classList.add("it-chain-dragging");
      });
      item.addEventListener("dragend", function () {
        item.classList.remove("it-chain-dragging");
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

  // ── Charger les images ─────────────────────────────────────────────────────

  // Jeton anti-course : si loadImages() est rappelee (nouvelle navigation)
  // avant qu'un appel precedent n'ait fini d'attendre/charger, l'appel
  // precedent ne doit plus toucher a l'etat une fois resolu.
  var _loadImagesToken = 0;

  function loadImages() {
    var token = ++_loadImagesToken;
    updateStatus("Loading images...");
    var idsPromise = _host
      ? _host.fetchIds(state.currentPage || 1).then(function (r) { _hostInfo = r; return r.ids; })
      : waitForImageCards(3000);
    idsPromise.then(function (ids) {
      if (token !== _loadImagesToken) return;
      if (!ids.length) { updateStatus("No image visible in the grid."); return; }
      return gql("FindImagesByIds", Q_FIND_BY_IDS, { ids: ids }).then(function (d) {
        if (token !== _loadImagesToken) return;
        var byId = {};
        ((d.findImages || {}).images || []).forEach(function (img) { byId[img.id] = img; });
        // Reordonner selon l'ordre d'affichage reel de la grille
        var imgs = ids.map(function (id) { return byId[id]; }).filter(Boolean);
        state.images = imgs;
        state.fillPage = null; state.fillQueue = [];
        imgs.forEach(function (img) {
          if (!state.rows[img.id])
            state.rows[img.id] = { image: img, status: "idle", scraped: null, msg: "" };
          else
            state.rows[img.id].image = img;
        });
        buildAllRows();
        var pageInfo = _host ? { page: _hostInfo.page, total: _hostInfo.total } : getPageInfoFromDOM();
        state.currentPage = pageInfo ? pageInfo.page  : 1;
        state.totalPages  = pageInfo ? pageInfo.total : 1;
        updatePageNav();
        updateStatus("Ready — " + imgs.length + " images (page " + state.currentPage + "/" + state.totalPages + ")");
      });
    }).catch(function (err) {
      if (token !== _loadImagesToken) return;
      updateStatus("Loading error: " + err.message);
    });
  }


  function isSoloPanel(el) { return !!(el && el.classList.contains("it-panel-solo")); }

  function notifyVisibility() {
    try { window.dispatchEvent(new CustomEvent("it-visibility-changed")); } catch (e) {}
  }

  // ── Build the panel ────────────────────────────────────────────────────────

  // Collapsible sub-group of the Display settings. Open/closed state is kept in
  // localStorage (first group open by default); toggled by a delegated click
  // handler on #it-settings-panel (see attachPanelEvents).
  var SG_STORE = "itSettingsOpenGroups";
  function settingsGroupOpen(key) {
    try {
      var saved = JSON.parse(localStorage.getItem(SG_STORE) || "null");
      if (saved && typeof saved[key] === "boolean") return saved[key];
    } catch (e) {}
    return key === "layout";
  }
  function settingsSubGroup(key, title, count, innerHTML) {
    var open = settingsGroupOpen(key);
    return '<div class="it-setting-subgroup-toggle' + (open ? ' it-open' : '') + '" data-sg="' + key + '">' +
        '<span class="it-sg-chev">&#9656;</span>' + title + ' <span class="it-sg-count">(' + count + ')</span>' +
      '</div>' +
      '<div class="it-setting-subgroup-body">' + innerHTML + '</div>';
  }

  // Mode classes carried by #it-panel (compact / fullscreen / outline / copy icon).
  function panelBaseClassName(solo) {
    return [
      // The single image panel has its own fullscreen setting and ignores compact mode.
      (!solo && pluginConfig.compactMode) ? "it-compact" : "",
      // Compact wins over fullscreen: both classes together left the panel
      // stretched over the whole window.
      solo ? (pluginConfig.fullscreenSolo ? "it-fullscreen" : "")
           : ((pluginConfig.fullscreenOnDesktop && !pluginConfig.compactMode) ? "it-fullscreen" : ""),
      pluginConfig.studioBannerLayout ? "it-banner-layout" : "",
      pluginConfig.oneCard ? "it-one-card" : "",
      (pluginConfig.oneCard && pluginConfig.oneCardCols) ? "it-one-card-cols" : "",
      pluginConfig.scrapedOutline ? "" : "it-no-outline",
      pluginConfig.copyIconAlways ? "it-copy-always" : ""
    ].filter(Boolean).join(" ");
  }

  function settingRow(id, label, sub) {
    return '<div class="it-setting-row' + (sub ? ' it-setting-row-sub' : '') + '">' +
      '<label class="it-setting-label"><input type="checkbox" id="' + id + '"> ' + label + '</label>' +
    '</div>';
  }

  // soloImageID: when set, builds the single-image panel (image header block + one row).
  function buildPanel(scrapers, soloImageID) {
    var panel = document.createElement("div");
    panel.id = PANEL_ID;
    // An inline "display" style always wins over the CSS display (flex in wide
    // mode, block in compact mode) - only set it to hide (none), never for the
    // visible state, so the CSS stays in control.
    if (!state.visible) panel.style.display = "none";

    panel.className = panelBaseClassName(!!soloImageID);
    applyLayoutClasses();

    panel.innerHTML =
      '<div id="it-titlebar">' +
        '<span id="it-titlebar-drag">&#9776; Image Tagger</span>' +
        '<div id="it-titlebar-actions">' +
          '<button id="it-titlebar-fullscreen" title="Fullscreen"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>' +
          '<button id="it-titlebar-compact" title="Compact mode">&#8644;&#xFE0E;</button>' +
          '<button id="it-titlebar-settings" title="Settings">&#9881;&#xFE0E;</button>' +
          '<button id="it-titlebar-close" title="Close">&#10005;</button>' +
        '</div>' +
      '</div>' +
      '<div id="it-settings-panel" style="display:none">' +
        '<div class="it-setting-group">' +
          '<div class="it-setting-section-title">Scraping</div>' +
          '<div class="it-setting-row it-scraper-chain-row">' +
            '<div class="it-setting-disclosure it-disclosure-flush" id="it-chain-toggle">' +
              '<span class="it-setting-disclosure-chevron">&#9656;</span>' +
              '<span class="it-setting-disclosure-label">Scrapers (order = fallback priority)</span>' +
            '</div>' +
            '<div id="it-chain-box" style="display:none"><div id="it-scraper-chain"></div></div>' +
          '</div>' +
          '<div class="it-setting-subtitle">Fallback behavior</div>' +
          settingRow("it-cfg-use-url", "Try image's saved URL first") +
          settingRow("it-cfg-manual-fallback", "Manual fill-in when scraping fails (studio/performers/tags/details)") +
          settingRow("it-cfg-manual-fallback-title", "Allow manual title", true) +
          settingRow("it-cfg-manual-fallback-prefill", "Pre-fill title with file name", true) +
        '</div>' +
        '<div class="it-setting-group">' +
          '<div class="it-setting-section-title">Checked by default</div>' +
          settingRow("it-cfg-studio", "Auto-check new studios") +
          settingRow("it-cfg-prioritize-existing", "Prefer existing studio (multi-studio)") +
          // Hidden in the public build: both settings need the skExtra-Multiple-Studios-Custom
          // companion plugin, which isn't published. Uncomment if it ever is.
          // settingRow("it-cfg-auto-other-studios", 'Add the other artists (Artists:) as "Other studios" (skExtra-Multiple-Studios-Custom)') +
          // settingRow("it-cfg-multi-studio-select", 'Allow several studios per image (a "+" next to each candidate adds it as an Other studio)') +
          // '<div id="it-cfg-multi-studio-hint" class="it-hint" style="display:none">Inactive: the skExtra - Multiple-Studios plugin is not installed or not enabled, so only one studio can be picked.</div>' +
          settingRow("it-cfg-performer", "Auto-check new performers") +
          settingRow("it-cfg-tags", "Auto-check new tags") +
          settingRow("it-cfg-details", "Auto-check details") +
        '</div>' +
        '<div class="it-setting-group">' +
          '<div class="it-setting-section-title">On apply</div>' +
          settingRow("it-cfg-organized", "Auto-organize on Apply") +
        '</div>' +
        '<div class="it-setting-group">' +
          '<div class="it-setting-section-title">Display</div>' +
          settingsSubGroup("layout", "Panel layout", 7,
            settingRow("it-cfg-fullscreen-desktop", "Fullscreen panel on desktop (mass list)") +
            settingRow("it-cfg-fullscreen-solo", "Fullscreen panel on the single image page") +
            settingRow("it-cfg-banner-layout", "Modern layout (details beside the image, studio header)") +
            settingRow("it-cfg-one-card", "Details in one card (needs Modern layout)", true) +
            settingRow("it-cfg-one-card-cols", "Two columns inside the card (otherwise stacked)", true) +
            settingRow("it-cfg-split-existing", "Split existing / new data") +
            settingRow("it-cfg-split-side", "Side by side instead of stacked", true)) +
          settingsSubGroup("content", "Row content", 8,
            settingRow("it-cfg-hide-studio-banner", "Hide studio banner") +
            settingRow("it-cfg-hide-studio-logo", "Hide studio logo") +
            settingRow("it-cfg-details-editor", "Full Details editor in the mass list (instead of the short preview)") +
            settingRow("it-cfg-image-title-header", "Show the image title instead of the file name (when it has one)") +
            settingRow("it-cfg-copy-always", "Copy icon on existing Details always visible (otherwise on hover)") +
            settingRow("it-cfg-opaque-panel", "Frosted glass panel (Stash UI liquid glass only)") +
            '<div class="it-setting-row it-setting-row-sub">' +
              '<label class="it-setting-label it-setting-label-inline">Solid fill <input type="range" id="it-cfg-glass-solid" min="40" max="100" step="1" style="vertical-align:middle;width:140px"> <span id="it-cfg-glass-solid-out"></span></label>' +
            '</div>' +
            '<div class="it-setting-row it-setting-row-sub">' +
              '<label class="it-setting-label it-setting-label-inline">Blur <input type="range" id="it-cfg-glass-blur" min="0" max="80" step="1" style="vertical-align:middle;width:140px"> <span id="it-cfg-glass-blur-out"></span></label>' +
            '</div>') +
          settingsSubGroup("states", "Row states & progress", 6,
            settingRow("it-cfg-apply-flare", "Blue halo flash when an image is applied") +
            settingRow("it-cfg-eject-skipped", "Eject skipped images from the list (Skip removes the row)") +
            settingRow("it-cfg-scraped-outline", "Blue outline around scraped rows") +
            settingRow("it-cfg-prog-veil", "Progress veil on rows being scraped") +
            settingRow("it-cfg-prog-text", "Status line under the file name while scraping", true) +
            settingRow("it-cfg-prog-transition", "Smooth transition from the veil to the scraped result", true)) +
          settingsSubGroup("preview", "Single image panel", 1,
            settingRow("it-cfg-compare-image", "Show the existing and scraped images side by side (when an image is scraped)")) +
          settingsSubGroup("stash", "Stash integration", 3,
            '<div class="it-setting-row">' +
              '<label class="it-setting-label">Images per page (Stash UI list, 5-200) <input type="number" id="it-cfg-stashui-per-page" min="5" max="200" step="5" style="width:56px"></label>' +
            '</div>' +
            settingRow("it-cfg-hide-scraper-mode", "Hide Auto/Manual toggle on image page") +
            settingRow("it-cfg-hide-toolbar-btn", 'Hide "IT" button on the image page')) +
        '</div>' +
        '<div class="it-setting-row it-blacklist-row">' +
          '<div class="it-blacklist-label">Studio blacklist (VA)</div>' +
          '<div id="it-blacklist-chips"></div>' +
          '<div class="it-blacklist-input-wrap">' +
            '<input type="text" id="it-blacklist-input" placeholder="Add a name...">' +
            '<button class="it-btn it-btn-ghost" id="it-blacklist-add">+</button>' +
          '</div>' +
        '</div>' +
        '<div id="it-settings-resize" title="Drag to resize - double-click to reset"></div>' +
      '</div>' +
      '<div id="it-panel-header">' +
        '<button class="it-btn it-btn-primary"  id="it-btn-scrape-all">Scrape All</button>' +
        '<button class="it-btn it-btn-success"  id="it-btn-apply-all" disabled>Apply All</button>' +
        '<button class="it-btn it-btn-danger"   id="it-btn-skip-all" disabled>Skip All</button>' +
        '<button class="it-btn it-btn-ghost"    id="it-btn-clear">Clear</button>' +
        '<button class="it-btn it-btn-ghost" id="it-btn-scraper-mode" title="Toggle between automatic fallback and manual choice">' +
          (pluginConfig.scraperMode === "manual" ? "Manual" : "Auto") +
        '</button>' +
        '<button class="it-btn it-btn-ghost' + (pluginConfig.nsfwBlur ? ' it-btn-nsfw-on' : '') + '" id="it-btn-nsfw" title="SFW mode: blur thumbnails">SFW</button>' +
        // Phones only (hidden by CSS elsewhere): shows / hides the filter rows of this header
        '<button type="button" class="it-btn-collapse" id="it-btn-collapse" aria-expanded="true" title="Show / hide filters">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>' +
        '</button>' +
        // Custom combobox instead of a native <select>: Chrome ignores the CSS
        // of a native select's popup, Firefox applies it - inconsistent
        // otherwise. #it-scraper-select-manual is the wrapper's id.
        '<div class="it-combo" id="it-scraper-select-manual" style="display:' + (pluginConfig.scraperMode === "manual" ? "inline-flex" : "none") + '">' +
          '<button type="button" class="it-combo-btn" id="it-scraper-combo-btn" aria-haspopup="listbox" aria-expanded="false">' +
            esc((scrapers.filter(function (s) { return s.id === state.manualScraperID; })[0] || scrapers[0] || {}).name || "") +
          '</button>' +
          '<div class="it-combo-list" id="it-scraper-combo-list" role="listbox" style="display:none">' +
            scrapers.map(function (s) {
              return '<div class="it-combo-option' + (s.id === state.manualScraperID ? ' it-combo-option-selected' : '') + '" role="option" data-id="' + esc(s.id) + '" data-name="' + esc(s.name) + '">' + esc(s.name) + '</div>';
            }).join("") +
          '</div>' +
        '</div>' +
        '<div class="it-filter-radios">' +
          // Same custom combobox for the scraper filter; its options are rebuilt
          // live by renderScraperFilterOptions() as scraped results come in.
          '<div class="it-combo" id="it-scraper-filter">' +
            '<button type="button" class="it-combo-btn it-scraper-filter-btn" id="it-scraper-filter-btn" aria-haspopup="listbox" aria-expanded="false" title="Filter by scraper">All scrapers</button>' +
            '<div class="it-combo-list" id="it-scraper-filter-list" role="listbox" style="display:none">' +
              '<div class="it-combo-option it-combo-option-selected" role="option" data-id="all">All scrapers</div>' +
            '</div>' +
          '</div>' +
          '<div class="it-filter-group">' +
            '<span class="it-filter-indicator"></span>' +
            '<label class="it-filter-item"><input type="radio" name="it-studio-filter" value="all" checked> All</label>' +
            '<label class="it-filter-item"><input type="radio" name="it-studio-filter" value="new"> New</label>' +
            '<label class="it-filter-item"><input type="radio" name="it-studio-filter" value="existing"> Existing</label>' +
            '<label class="it-filter-item"><input type="radio" name="it-studio-filter" value="failed" title="Scrapes that failed"> Failed</label>' +
          '</div>' +
          '<label class="it-multi-studio-toggle" id="it-multi-studio-label" title="Click: only images with several studio candidates. Click again: hide them (red). Third click: off.">' +
            '<input type="checkbox" id="it-multi-studio-filter">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 16l8 4 8-4"/></svg>' +
            '<span id="it-multi-studio-text">Multi-studio</span>' +
          '</label>' +
        '</div>' +
      '</div>' +
      '<div id="it-status-bar">' +
        '<span id="it-status-text">Waiting...</span>' +
        '<div id="it-progress-wrap"><div id="it-progress-bar"></div></div>' +
      '</div>' +
      (soloImageID ? '<div id="it-solo-image-header"></div>' : '') +
      '<div id="it-rows">' +
        (soloImageID ? '<div id="it-row-' + esc(soloImageID) + '" class="it-row it-state-idle"></div>' : '') +
      '</div>' +
      // Solo mode only (see CSS): once the single row is "done" (Applied),
      // #it-rows shrinks to its compact done-state content - this floating
      // button reloads the page without having to close the panel.
      '<button type="button" id="it-solo-refresh-btn" class="it-btn it-btn-ghost" title="Reload" style="display:none">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15">' +
        '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>' +
      '</button>' +
      '<div id="it-panel-footer">' +
        '<div id="it-resize-handle" title="Resize" style="display:' + (pluginConfig.compactMode ? 'none' : 'flex') + '">' +
          '<svg viewBox="0 0 9 9"><path d="M1 8 L8 1M1 5 L5 1M4 8 L8 4"/></svg>' +
        '</div>' +
        '<span id="it-page-info"></span>' +
        '<div class="it-page-nav">' +
          '<button class="it-btn it-btn-ghost" id="it-btn-page-prev" title="Previous page">&#8592;</button>' +
          '<span id="it-page-nav-label">1 / 1</span>' +
          '<button class="it-btn it-btn-ghost" id="it-btn-page-next" title="Next page">&#8594;</button>' +
        '</div>' +
        '<button class="it-btn it-btn-ghost" id="it-btn-reload">Reload</button>' +
      '</div>';

    return panel;
  }

  function attachPanelEvents() {
    renderScraperChain();

    // ── NSFW mode (blur) ────────────────────────────────────────────────────
    // body class so the floating hover previews (appended to <body>, outside
    // #it-panel) are blurred too.
    function applyNsfwBlur() {
      document.body.classList.toggle("it-nsfw-on", !!pluginConfig.nsfwBlur);
      var nb = document.getElementById("it-btn-nsfw");
      if (nb) nb.classList.toggle("it-btn-nsfw-on", !!pluginConfig.nsfwBlur);
    }
    applyNsfwBlur();
    // Phone header: the chevron button folds the filter rows (state kept between openings)
    (function () {
      var cb = document.getElementById("it-btn-collapse");
      var pn = document.getElementById(PANEL_ID);
      if (!cb || !pn) return;
      var KEY = "itHeaderCollapsed";
      function apply(collapsed) {
        pn.classList.toggle("it-hdr-collapsed", collapsed);
        cb.setAttribute("aria-expanded", collapsed ? "false" : "true");
      }
      var saved = false;
      try { saved = localStorage.getItem(KEY) === "1"; } catch (e) {}
      apply(saved);
      cb.addEventListener("click", function () {
        var c = !pn.classList.contains("it-hdr-collapsed");
        apply(c);
        try { localStorage.setItem(KEY, c ? "1" : "0"); } catch (e) {}
      });
    })();

    var nsfwBtn = document.getElementById("it-btn-nsfw");
    if (nsfwBtn) {
      nsfwBtn.addEventListener("click", function () {
        pluginConfig.nsfwBlur = !pluginConfig.nsfwBlur;
        savePluginConfig();
        applyNsfwBlur();
      });
    }

    // ── Mode manuel / auto ──────────────────────────────────────────────────
    var modeBtn = document.getElementById("it-btn-scraper-mode");
    var manualSelect = document.getElementById("it-scraper-select-manual"); // wrapper div, voir buildPanel()
    var comboBtn  = document.getElementById("it-scraper-combo-btn");
    var comboList = document.getElementById("it-scraper-combo-list");
    var comboOptions = comboList ? Array.from(comboList.querySelectorAll(".it-combo-option")) : [];
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
    // Combobox custom : listbox minimale (clic, Enter/Space/fleches/Echap,
    // click-dehors-ferme) - meme comportement que le picker de sceneTagger.
    if (comboBtn && comboList && comboOptions.length) {
      var comboHighlight = -1;
      function comboSetHighlight(idx) {
        comboOptions.forEach(function (o) { o.classList.remove("it-combo-option-active"); });
        comboHighlight = Math.max(0, Math.min(comboOptions.length - 1, idx));
        var opt = comboOptions[comboHighlight];
        opt.classList.add("it-combo-option-active");
        opt.scrollIntoView({ block: "nearest" });
      }
      function comboOpen() {
        comboList.style.display = "block";
        comboBtn.setAttribute("aria-expanded", "true");
        var selIdx = comboOptions.findIndex(function (o) { return o.getAttribute("data-id") === state.manualScraperID; });
        comboSetHighlight(selIdx >= 0 ? selIdx : 0);
      }
      function comboClose() { comboList.style.display = "none"; comboBtn.setAttribute("aria-expanded", "false"); }
      function comboSelect(opt) {
        state.manualScraperID = opt.getAttribute("data-id");
        comboBtn.textContent = opt.getAttribute("data-name");
        comboOptions.forEach(function (o) { o.classList.toggle("it-combo-option-selected", o === opt); });
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
        var opt = e.target.closest(".it-combo-option");
        if (opt) comboSelect(opt);
      });
      comboList.addEventListener("mousemove", function (e) {
        var opt = e.target.closest(".it-combo-option");
        if (!opt) return;
        var idx = comboOptions.indexOf(opt);
        if (idx !== -1 && idx !== comboHighlight) comboSetHighlight(idx);
      });
      document.addEventListener("click", function (e) {
        if (comboList.style.display === "block" && !manualSelect.contains(e.target)) comboClose();
      });
    }

    var prevBtn = document.getElementById("it-btn-page-prev");
    var nextBtn = document.getElementById("it-btn-page-next");
    if (prevBtn) prevBtn.addEventListener("click", function () { goToPage(state.currentPage - 1); });
    if (nextBtn) nextBtn.addEventListener("click", function () { goToPage(state.currentPage + 1); });
    updatePageNav();

    // Boutons mass-only (absents de buildSoloPanel()) : gardes null nécessaires,
    // attachPanelEvents() est aussi appelée en mode solo (voir buildSoloPanel()).
    var scrapeAllBtn = document.getElementById("it-btn-scrape-all");
    if (scrapeAllBtn) scrapeAllBtn.addEventListener("click", function() { if (!state.running) scrapeAll(); });
    var applyAllBtn = document.getElementById("it-btn-apply-all");
    if (applyAllBtn) applyAllBtn.addEventListener("click", applyAll);
    var skipAllBtn = document.getElementById("it-btn-skip-all");
    if (skipAllBtn) skipAllBtn.addEventListener("click", skipAll);
    var clearBtn = document.getElementById("it-btn-clear");
    if (clearBtn) clearBtn.addEventListener("click", function() {
      state.images.forEach(function(img) {
        var r = state.rows[img.id];
        if (r && r.status !== "done") { r.status = "idle"; r.scraped = null; r.msg = ""; }
      });
      buildAllRows(); renderScraperFilterOptions(); updateStatus("Results cleared");
    });
    var reloadBtn = document.getElementById("it-btn-reload");
    if (reloadBtn) reloadBtn.addEventListener("click", function() {
      state.images = []; state.rows = {}; loadImages();
    });

    // ── Filtre studio live (segmented control anime) ────────────────────────
    // Pastille glissante repositionnee sur la largeur/offset reels de
    // l'item coche (les labels n'ont pas tous la meme largeur).
    function updateFilterIndicator() {
      var group = document.querySelector(".it-filter-group");
      var indicator = document.querySelector(".it-filter-indicator");
      var checked = document.querySelector('input[name="it-studio-filter"]:checked');
      if (!group || !indicator || !checked) return;
      var label = checked.closest(".it-filter-item");
      if (!label) return;
      var groupRect = group.getBoundingClientRect();
      var labelRect = label.getBoundingClientRect();
      indicator.style.width = labelRect.width + "px";
      indicator.style.left = (labelRect.left - groupRect.left) + "px";
    }

    document.querySelectorAll('input[name="it-studio-filter"]').forEach(function(radio) {
      if (radio.value === state.studioFilter) radio.checked = true;
      radio.addEventListener("change", function() {
        if (radio.checked) {
          state.studioFilter = radio.value;
          clearFilterPins();
          applyStudioFilter();
          updateFilterIndicator();
        }
      });
    });
    setTimeout(updateFilterIndicator, 0);
    setTimeout(updateFilterIndicator, 300);

    // Toggle cumulatif "Multi-studio" : ANDe avec All/New/Existing plutot
    // que de rejoindre son groupe radio.
    var multiStudioCb = document.getElementById("it-multi-studio-filter");
    // 3 states, one click each: off -> only multi-studio (blue) -> exclude multi-studio (red) -> off
    var multiStudioLabel = document.getElementById("it-multi-studio-label");
    var multiStudioText  = document.getElementById("it-multi-studio-text");
    function paintMultiStudio() {
      var m = state.multiStudioOnly;
      if (multiStudioCb) multiStudioCb.checked = m === true;
      if (multiStudioLabel) multiStudioLabel.classList.toggle("it-multi-exclude", m === "exclude");
      if (multiStudioText) multiStudioText.textContent = m === "exclude" ? "No multi-studio" : "Multi-studio";
    }
    if (multiStudioCb && multiStudioLabel) {
      paintMultiStudio();
      multiStudioLabel.addEventListener("click", function (e) {
        e.preventDefault();   // the hidden checkbox only mirrors the state, it does not drive it
        var m = state.multiStudioOnly;
        state.multiStudioOnly = !m ? true : (m === true ? "exclude" : false);
        paintMultiStudio();
        clearFilterPins();
        applyStudioFilter();
      });
    }

    // Drag-to-switch : appuyer n'importe ou dans le controle segmente et
    // glisser vers une autre option sans relacher.
    var filterGroup = document.querySelector(".it-filter-group");
    if (filterGroup) {
      var filterDragging = false;
      function selectFilterAt(clientX, clientY) {
        var el2 = document.elementFromPoint(clientX, clientY);
        var item = el2 && el2.closest && el2.closest(".it-filter-item");
        if (!item || !filterGroup.contains(item)) return;
        var radio = item.querySelector('input[name="it-studio-filter"]');
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

    // ── Filtre par scraper (meme combobox minimal que le picker manuel) ─────
    var scraperFilterWrap = document.getElementById("it-scraper-filter");
    var filterBtn  = document.getElementById("it-scraper-filter-btn");
    var filterList = document.getElementById("it-scraper-filter-list");
    if (scraperFilterWrap && filterBtn && filterList) {
      renderScraperFilterOptions();
      var filterHighlight = -1;
      function filterOptions() { return Array.from(filterList.querySelectorAll(".it-combo-option")); }
      function filterSetHighlight(idx) {
        var opts = filterOptions();
        if (!opts.length) return;
        opts.forEach(function (o) { o.classList.remove("it-combo-option-active"); });
        filterHighlight = Math.max(0, Math.min(opts.length - 1, idx));
        var opt = opts[filterHighlight];
        opt.classList.add("it-combo-option-active");
        opt.scrollIntoView({ block: "nearest" });
      }
      function filterOpen() {
        filterList.style.display = "block";
        filterBtn.setAttribute("aria-expanded", "true");
        var opts = filterOptions();
        var selIdx = opts.findIndex(function (o) { return o.getAttribute("data-id") === state.scraperFilter; });
        filterSetHighlight(selIdx >= 0 ? selIdx : 0);
      }
      function filterCloseList() { filterList.style.display = "none"; filterBtn.setAttribute("aria-expanded", "false"); }
      function filterSelect(opt) {
        state.scraperFilter = opt.getAttribute("data-id");
        filterBtn.textContent = opt.getAttribute("data-name");
        filterOptions().forEach(function (o) { o.classList.toggle("it-combo-option-selected", o === opt); });
        filterCloseList();
        filterBtn.focus();
        clearFilterPins();
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
        var opt = e.target.closest(".it-combo-option");
        if (opt) filterSelect(opt);
      });
      filterList.addEventListener("mousemove", function (e) {
        var opt = e.target.closest(".it-combo-option");
        if (!opt) return;
        var idx = filterOptions().indexOf(opt);
        if (idx !== -1 && idx !== filterHighlight) filterSetHighlight(idx);
      });
      document.addEventListener("click", function (e) {
        if (filterList.style.display === "block" && !scraperFilterWrap.contains(e.target)) filterCloseList();
      });
    }

    var closeBtn = document.getElementById("it-titlebar-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        state.visible = false;
        var panel = document.getElementById(PANEL_ID);
        if (panel) panel.style.display = "none";
        var btn = document.getElementById(BTN_ID);
        if (btn) { btn.textContent = "Image Tagger"; btn.style.color = ""; btn.style.border = ""; }
        notifyVisibility();
      });
    }


    function leaveCompactForFullscreen(panelEl) {
      if (!pluginConfig.compactMode || !panelEl || panelEl.classList.contains("it-panel-solo")) return;
      pluginConfig.compactMode = false;
      panelEl.classList.remove("it-compact");
      var cBtn = document.getElementById("it-titlebar-compact");
      if (cBtn) cBtn.style.color = "";
      var rHandle = document.getElementById("it-resize-handle");
      if (rHandle) rHandle.style.display = "flex";
      setTimeout(updateFilterIndicator, 0);
      syncFullscreenBtn();
    }
    // The fullscreen button only shows "on" when fullscreen is really in effect
    // (compact mode wins over the saved fullscreen setting).
    function syncFullscreenBtn() {
      var fsBtn = document.getElementById("it-titlebar-fullscreen");
      if (!fsBtn) return;
      var soloP = isSoloPanel(document.getElementById(PANEL_ID));
      var on = soloP ? !!pluginConfig.fullscreenSolo : (!!pluginConfig.fullscreenOnDesktop && !pluginConfig.compactMode);
      fsBtn.classList.toggle("it-titlebar-on", on);
      fsBtn.title = on ? "Exit fullscreen" : "Fullscreen";
    }
    var fullscreenBtn = document.getElementById("it-titlebar-fullscreen");
    if (fullscreenBtn) {
      syncFullscreenBtn();
      fullscreenBtn.addEventListener("click", function () {
        var panelEl = document.getElementById(PANEL_ID);
        // From the compact panel the button means "go fullscreen" (the saved
        // setting may already be on, since compact only hides it).
        var soloP = isSoloPanel(panelEl);
        var key = soloP ? "fullscreenSolo" : "fullscreenOnDesktop";
        var fromCompact = pluginConfig.compactMode && panelEl && !soloP;
        pluginConfig[key] = fromCompact ? true : !pluginConfig[key];
        if (pluginConfig[key]) leaveCompactForFullscreen(panelEl);
        savePluginConfig();
        if (panelEl) {
          panelEl.classList.toggle("it-fullscreen", pluginConfig[key]);
          ["top", "left", "right", "bottom", "width", "height", "transform"].forEach(function (k) { panelEl.style[k] = ""; });
        }
        var fsCb = document.getElementById(soloP ? "it-cfg-fullscreen-solo" : "it-cfg-fullscreen-desktop");
        if (fsCb) fsCb.checked = pluginConfig[key];
        syncFullscreenBtn();
      });
      // The settings checkbox can change it too: keep the button's state in sync.
      document.addEventListener("change", function (e) {
        if (e.target && (e.target.id === "it-cfg-fullscreen-desktop" || e.target.id === "it-cfg-fullscreen-solo")) syncFullscreenBtn();
      });
    }

    var compactBtn = document.getElementById("it-titlebar-compact");
    if (compactBtn) {
      // Solo mode isn't applied yet at this point (attachPanelEvents() runs
      // right after building the panel, before openPanelForScene() adds the
      // "it-panel-solo" class) - hiding this button for solo is done there
      // instead, right after that class is added.
      if (pluginConfig.compactMode) compactBtn.style.color = "rgba(var(--accent-rgb,94,129,172),1)";
      compactBtn.addEventListener("click", function () {
        if (document.getElementById(PANEL_ID).classList.contains("it-panel-solo")) return;
        pluginConfig.compactMode = !pluginConfig.compactMode;
        savePluginConfig();
        var panelEl = document.getElementById(PANEL_ID);
        if (panelEl) {
          var wasNarrow = panelEl.classList.contains("it-narrow");
          panelEl.className = panelBaseClassName() + (wasNarrow ? " it-narrow" : "");
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
        syncFullscreenBtn();
        var handle = document.getElementById("it-resize-handle");
        if (handle) handle.style.display = pluginConfig.compactMode ? "none" : "flex";
        // Compact mode shrinks the filter labels' font-size, so the sliding
        // indicator needs to be recomputed once the new layout has settled.
        setTimeout(updateFilterIndicator, 0);
      });
    }

    // Bouton settings (engrenage)
    var settingsBtn = document.getElementById("it-titlebar-settings");
    var settingsPanel = document.getElementById("it-settings-panel");
    if (settingsBtn && settingsPanel) {
      settingsBtn.addEventListener("click", function() {
        var visible = settingsPanel.style.display !== "none";
        settingsPanel.style.display = visible ? "none" : "block";
        settingsBtn.style.color = visible ? "" : "rgba(var(--accent-rgb,94,129,172),1)";
      });
    }

    // Settings panel height: barre draggable en bas, double-clic pour reset.
    (function () {
      var handle = document.getElementById("it-settings-resize");
      var sp = document.getElementById("it-settings-panel");
      if (!handle || !sp) return;
      var applyHeight = function (h) {
        sp.style.maxHeight = "none";
        sp.style.flexShrink = "0";
        sp.style.height = h + "px";
      };
      try {
        var savedH = parseInt(localStorage.getItem("itSettingsHeight"), 10);
        if (savedH >= 60) applyHeight(savedH);
      } catch (e) {}
      handle.addEventListener("mousedown", function (e) {
        e.preventDefault();
        var startY = e.clientY;
        var startH = sp.getBoundingClientRect().height;
        var move = function (ev) {
          var h = Math.max(60, Math.min(window.innerHeight * 0.9, startH + ev.clientY - startY));
          applyHeight(Math.round(h));
        };
        var up = function () {
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
          try { localStorage.setItem("itSettingsHeight", String(parseInt(sp.style.height, 10))); } catch (err) {}
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      });
      handle.addEventListener("dblclick", function () {
        sp.style.height = "";
        sp.style.maxHeight = "";
        sp.style.flexShrink = "";
        try { localStorage.removeItem("itSettingsHeight"); } catch (e) {}
      });
    })();

    // "+" boxes (several studios): the studio chosen as main one cannot also be an Other studio
    var rowsForAlso = document.getElementById("it-rows");
    if (rowsForAlso) {
      rowsForAlso.addEventListener("change", function (e) {
        var t = e.target;
        if (!t || !t.getAttribute || t.getAttribute("data-cb") !== "studio-radio") return;
        var group = t.closest(".it-radio-group");
        if (!group) return;
        var main = t.getAttribute("data-artist");
        group.querySelectorAll('[data-cb="studio-also"]').forEach(function (btn) {
          var isMain = btn.getAttribute("data-artist") === main;
          btn.disabled = isMain;
          if (isMain) btn.classList.remove("it-on");
        });
      });
      rowsForAlso.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-cb="studio-also"]') : null;
        if (!btn) return;
        e.preventDefault();    // inside the studio's <label>: must not select that studio as main
        e.stopPropagation();
        if (btn.disabled) return;
        btn.classList.toggle("it-on");
      });
    }

    // Several studios per image: needs the skExtra-Multiple-Studios-Custom plugin
    (function () {
      var el = document.getElementById("it-cfg-multi-studio-select");
      if (!el) return;
      var hint = document.getElementById("it-cfg-multi-studio-hint");
      el.checked = multiStudioActive();
      el.disabled = !msPluginInstalled;
      if (hint) hint.style.display = msPluginInstalled ? "none" : "";
      el.addEventListener("change", function () {
        pluginConfig.multiStudioSelect = el.checked;
        savePluginConfig();
        buildAllRows();   // rows are drawn with / without the "+" boxes
      });
    })();

    // Checkboxes — sync bidirectionnel avec pluginConfig (lu depuis Settings Stash)
    function bindSettingCb(elId, key) {
      var el = document.getElementById(elId);
      if (!el) return;
      el.checked = !!pluginConfig[key];
      el.addEventListener("change", function() {
        pluginConfig[key] = el.checked;
        savePluginConfig();
      });
    }
    bindSettingCb("it-cfg-studio",              "autoCheckStudio");
    bindSettingCb("it-cfg-prioritize-existing", "prioritizeExistingStudio");
    bindSettingCb("it-cfg-use-url",             "useUrlIfPresent");
    bindSettingCb("it-cfg-auto-other-studios",  "autoAddOtherStudios");
    bindSettingCb("it-cfg-performer",           "autoCheckPerformer");
    bindSettingCb("it-cfg-tags",                "autoCheckNewTags");
    bindSettingCb("it-cfg-details",             "autoCheckDetails");
    bindSettingCb("it-cfg-manual-fallback",       "manualFallbackOnFail");
    bindSettingCb("it-cfg-manual-fallback-title", "manualFallbackAllowTitle");
    bindSettingCb("it-cfg-compare-image",         "compareImageOnScrape");
    bindSettingCb("it-cfg-hide-solo-thumb",       "hideSoloRowThumb");
    bindSettingCb("it-cfg-organized",             "autoMarkOrganized");
    bindSettingCb("it-cfg-hide-studio-banner",    "hideStudioBanner");
    bindSettingCb("it-cfg-hide-studio-logo",      "hideStudioLogo");
    bindSettingCb("it-cfg-opaque-panel",          "opaquePanel");
    bindSettingCb("it-cfg-image-title-header",    "showImageTitleInHeader");
    function bindSettingRange(elId, key, unit) {
      var el = document.getElementById(elId), out = document.getElementById(elId + "-out");
      if (!el) return;
      el.value = pluginConfig[key];
      if (out) out.textContent = el.value + unit;
      el.addEventListener("input", function () {   // live preview while dragging
        pluginConfig[key] = parseFloat(el.value);
        if (out) out.textContent = el.value + unit;
        applyLayoutClasses();
      });
      el.addEventListener("change", function () { savePluginConfig(); });
    }
    bindSettingRange("it-cfg-glass-solid", "glassSolid", " %");
    bindSettingRange("it-cfg-glass-blur",  "glassBlur",  " px");
    (function () {   // images per page on the Stash UI list: saved, then the panel starts over from page 1
      var el = document.getElementById("it-cfg-stashui-per-page");
      if (!el) return;
      el.value = stashuiPerPage();
      el.addEventListener("change", function () {
        pluginConfig.stashuiPerPage = stashuiPerPage(parseInt(el.value, 10));
        el.value = pluginConfig.stashuiPerPage;
        savePluginConfig();
        if (_host && state.visible) { state.currentPage = 1; state.images = []; loadImages(); }
      });
    })();
    // Click on the "N images" count (Stash UI list only): same "Images per page" value as the
    // setting above, edited in place. Looks like plain text until clicked.
    (function () {
      var info = document.getElementById("it-page-info");
      if (!info) return;
      info.addEventListener("click", function () {
        if (!_host || info.querySelector("input")) return;
        var input = document.createElement("input");
        input.type = "number"; input.className = "it-pp-input";
        input.min = "5"; input.max = "200"; input.step = "5";
        input.value = stashuiPerPage();
        info.textContent = "";
        info.appendChild(input);
        info.appendChild(document.createTextNode(" images per page"));
        var finished = false;
        function finish(commit) {
          if (finished) return;
          finished = true;
          var changed = false;
          if (commit) {
            var v = stashuiPerPage(parseInt(input.value, 10));
            changed = v !== stashuiPerPage();
            if (changed) {
              pluginConfig.stashuiPerPage = v;
              savePluginConfig();
              var cfg = document.getElementById("it-cfg-stashui-per-page");
              if (cfg) cfg.value = v;
            }
          }
          info.textContent = "";
          updatePageInfo();
          if (changed && _host && state.visible) { state.currentPage = 1; state.images = []; loadImages(); }
        }
        input.addEventListener("keydown", function (e) {
          e.stopPropagation();
          if (e.key === "Enter") finish(true);
          else if (e.key === "Escape") finish(false);
        });
        input.addEventListener("blur", function () { finish(true); });
        input.focus(); input.select();
      });
    })();
    bindSettingCb("it-cfg-split-existing",        "splitExistingNew");
    bindSettingCb("it-cfg-split-side",            "splitSideBySide");
    bindSettingCb("it-cfg-details-editor",        "detailsEditorInList");
    bindSettingCb("it-cfg-manual-fallback-prefill", "manualFallbackPrefillFilename");
    // Effet visuel immediat (mode solo uniquement) sans attendre un rescrape.
    var hideSoloThumbCb = document.getElementById("it-cfg-hide-solo-thumb");
    if (hideSoloThumbCb) {
      hideSoloThumbCb.addEventListener("change", function() {
        if (!document.getElementById("it-solo-image-header")) return;
        Object.keys(state.rows).forEach(renderRow);
      });
    }

    // Cacher Auto/Manuel (mode solo) - effet immediat via une classe sur le
    // panel plutot qu'un rebuild, le bouton/combobox restent montes (juste
    // masques en CSS). Voir it-panel.css : #it-panel-header entier masque
    // aussi si les deux elements qu'il contient le sont (sinon barre vide).
    bindSettingCb("it-cfg-hide-scraper-mode", "hideScraperModeToggle");
    var hideScraperModeCb = document.getElementById("it-cfg-hide-scraper-mode");
    if (hideScraperModeCb) {
      hideScraperModeCb.addEventListener("change", function() {
        var panelForHideMode = document.getElementById(PANEL_ID);
        if (panelForHideMode) panelForHideMode.classList.toggle("it-hide-scraper-mode", pluginConfig.hideScraperModeToggle);
      });
    }

    // Fullscreen panel on desktop - takes effect immediately via a class on
    // #it-panel; the inline drag/resize styles are cleared so the CSS wins
    // (the CSS also uses !important, this just avoids stale values when it
    // is switched back off).
    [["it-cfg-fullscreen-desktop", "fullscreenOnDesktop", false], ["it-cfg-fullscreen-solo", "fullscreenSolo", true]].forEach(function (pair) {
      var fsEl = document.getElementById(pair[0]);
      if (!fsEl) return;
      fsEl.checked = !!pluginConfig[pair[1]];
      fsEl.addEventListener("change", function () {
        pluginConfig[pair[1]] = fsEl.checked;
        var panelEl = document.getElementById(PANEL_ID);
        var applies = panelEl && isSoloPanel(panelEl) === pair[2];  // the setting for the other kind of panel changes nothing on screen
        if (applies && pluginConfig[pair[1]]) leaveCompactForFullscreen(panelEl);
        savePluginConfig();
        if (!applies) return;
        panelEl.classList.toggle("it-fullscreen", pluginConfig[pair[1]]);
        ["top", "left", "right", "bottom", "width", "height", "transform"].forEach(function (k) { panelEl.style[k] = ""; });
      });
    });
    // Banner layout - class on #it-panel, takes effect immediately (the
    // layout is pure CSS; the multi-studio banner card is built at render
    // time, so rows rendered before the change pick it up on the next
    // render / Reload).
    (function () {
      var blEl = document.getElementById("it-cfg-banner-layout");
      if (!blEl) return;
      blEl.checked = !!pluginConfig.studioBannerLayout;
      blEl.addEventListener("change", function () {
        pluginConfig.studioBannerLayout = blEl.checked;
        savePluginConfig();
        var panelEl = document.getElementById(PANEL_ID);
        if (panelEl) panelEl.classList.toggle("it-banner-layout", pluginConfig.studioBannerLayout);
        Object.keys(state.rows).forEach(function (rid) { renderRow(rid); });
      });
    })();

    // Details in one card (+ its two-column variant): classes on #it-panel and
    // a re-render (the detail fields get wrapped in .it-onecard at render time).
    (function () {
      var ocEl = document.getElementById("it-cfg-one-card");
      var ocColsEl = document.getElementById("it-cfg-one-card-cols");
      if (!ocEl || !ocColsEl) return;
      ocEl.checked = !!pluginConfig.oneCard;
      ocColsEl.checked = !!pluginConfig.oneCardCols;
      function apply() {
        savePluginConfig();
        var panelEl = document.getElementById(PANEL_ID);
        if (panelEl) {
          panelEl.classList.toggle("it-one-card", pluginConfig.oneCard);
          panelEl.classList.toggle("it-one-card-cols", pluginConfig.oneCard && pluginConfig.oneCardCols);
        }
        Object.keys(state.rows).forEach(function (rid) { renderRow(rid); });
      }
      ocEl.addEventListener("change", function () { pluginConfig.oneCard = ocEl.checked; apply(); });
      ocColsEl.addEventListener("change", function () { pluginConfig.oneCardCols = ocColsEl.checked; apply(); });
    })();

    // Blue outline around scraped rows - a class on #it-panel, immediate.
    (function () {
      var soEl = document.getElementById("it-cfg-scraped-outline");
      if (!soEl) return;
      soEl.checked = !!pluginConfig.scrapedOutline;
      soEl.addEventListener("change", function () {
        pluginConfig.scrapedOutline = soEl.checked;
        savePluginConfig();
        var panelEl = document.getElementById(PANEL_ID);
        if (panelEl) panelEl.classList.toggle("it-no-outline", !pluginConfig.scrapedOutline);
      });
    })();

    // Copy icon always visible - class on #it-panel, immediate.
    (function () {
      var caEl = document.getElementById("it-cfg-copy-always");
      if (!caEl) return;
      caEl.checked = !!pluginConfig.copyIconAlways;
      caEl.addEventListener("change", function () {
        pluginConfig.copyIconAlways = caEl.checked;
        savePluginConfig();
        var panelEl = document.getElementById(PANEL_ID);
        if (panelEl) panelEl.classList.toggle("it-copy-always", pluginConfig.copyIconAlways);
      });
    })();

    // Collapsible Display sub-groups
    (function () {
      var sp = document.getElementById("it-settings-panel");
      if (!sp) return;
      sp.addEventListener("click", function (e) {
        var t = e.target.closest ? e.target.closest(".it-setting-subgroup-toggle") : null;
        if (!t || !sp.contains(t)) return;
        var open = t.classList.toggle("it-open");
        try {
          var saved = JSON.parse(localStorage.getItem(SG_STORE) || "null") || {};
          saved[t.getAttribute("data-sg")] = open;
          localStorage.setItem(SG_STORE, JSON.stringify(saved));
        } catch (err) {}
      });
    })();

    // Progress veil / status line - apply on the next scrape.
    [["it-cfg-prog-veil", "progressVeil"], ["it-cfg-prog-text", "progressText"], ["it-cfg-prog-transition", "progressTransition"], ["it-cfg-apply-flare", "applyFlare"], ["it-cfg-eject-skipped", "ejectSkipped"]].forEach(function (pair) {
      var el2 = document.getElementById(pair[0]);
      if (!el2) return;
      el2.checked = !!pluginConfig[pair[1]];
      el2.addEventListener("change", function () {
        pluginConfig[pair[1]] = el2.checked;
        savePluginConfig();
      });
    });
    // "Scrapers (order = fallback priority)": collapsed by default, last
    // state remembered (per browser) since it's opened often while setting up
    // the chain and rarely afterwards.
    (function () {
      var toggle = document.getElementById("it-chain-toggle");
      var box = document.getElementById("it-chain-box");
      if (!toggle || !box) return;
      var setOpen = function (open) {
        box.style.display = open ? "block" : "none";
        toggle.classList.toggle("it-setting-disclosure-open", open);
      };
      var saved = false;
      try { saved = localStorage.getItem("itScraperChainOpen") === "1"; } catch (e) {}
      setOpen(saved);
      toggle.addEventListener("click", function () {
        var open = box.style.display === "none";
        setOpen(open);
        try { localStorage.setItem("itScraperChainOpen", open ? "1" : "0"); } catch (e) {}
      });
    })();
    // Narrow panel (phone, or a desktop panel dragged small): class it-narrow
    // makes Banner layout / one card / cover card fall back to one column.
    (function () {
      var narrowPanel = document.getElementById(PANEL_ID);
      if (!narrowPanel || typeof ResizeObserver === "undefined") return;
      var applyNarrow = function () {
        narrowPanel.classList.toggle("it-narrow", narrowPanel.getBoundingClientRect().width < 760);
      };
      new ResizeObserver(applyNarrow).observe(narrowPanel);
      applyNarrow();
    })();

    // Hide the "IT" button on the image page - immediate remove / re-inject.
    (function () {
      var hideToolbarBtnEl = document.getElementById("it-cfg-hide-toolbar-btn");
      if (!hideToolbarBtnEl) return;
      hideToolbarBtnEl.checked = !!pluginConfig.hideToolbarButton;
      hideToolbarBtnEl.addEventListener("change", function () {
        pluginConfig.hideToolbarButton = hideToolbarBtnEl.checked;
        savePluginConfig();
        var existing = document.getElementById(SOLO_BTN_ID);
        if (pluginConfig.hideToolbarButton) { if (existing) existing.remove(); }
        else {
          var m = window.location.pathname.match(/^\/images\/(\d+)$/);
          if (m) injectSoloBtn(m[1]);
        }
      });
    })();

    // ── Blacklist studios ─────────────────────────────────────────────────────
    function renderBlacklistChips() {
      var container = document.getElementById("it-blacklist-chips");
      if (!container) return;
      container.innerHTML = pluginConfig.studioBlacklist.map(function(name) {
        return '<span class="it-blacklist-chip">' +
          esc(name) +
          '<button class="it-blacklist-remove" data-name="' + esc(name) + '" title="Remove">&#10005;</button>' +
        '</span>';
      }).join("");
      container.querySelectorAll('.it-blacklist-remove').forEach(function(btn) {
        btn.addEventListener("click", function() {
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

    var blInput = document.getElementById("it-blacklist-input");
    var blAdd   = document.getElementById("it-blacklist-add");
    if (blInput && blAdd) {
      blAdd.addEventListener("click", function() { addToBlacklist(blInput.value); blInput.value = ""; });
      blInput.addEventListener("keydown", function(e) {
        if (e.key === "Enter") { addToBlacklist(blInput.value); blInput.value = ""; }
      });
    }
    renderBlacklistChips();
    document.addEventListener("it-blacklist-updated", renderBlacklistChips);

    var titlebar = document.getElementById("it-titlebar-drag");
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

    // ── Custom resize (bottom-left corner), active only outside compact mode ──
    var resizeHandle = document.getElementById("it-resize-handle");
    if (resizeHandle && panel) {
      var resizing = false, resStartX, resStartW, resStartLeft;
      resizeHandle.addEventListener("mousedown", function(e) {
        if (pluginConfig.compactMode) return;
        resizing = true;
        resStartX    = e.clientX;
        var rect     = panel.getBoundingClientRect();
        resStartW    = rect.width;
        resStartLeft = rect.left;
        panel.style.left  = resStartLeft + "px";
        panel.style.right = "auto";
        e.preventDefault();
        e.stopPropagation();
      });
      document.addEventListener("mousemove", function(e) {
        if (!resizing) return;
        var dx = resStartX - e.clientX;
        var nw = Math.min(Math.max(resStartW + dx, 400), window.innerWidth * 0.95);
        var nl = resStartLeft + resStartW - nw;
        panel.style.width = nw + "px";
        panel.style.left  = Math.max(0, nl) + "px";
      });
      document.addEventListener("mouseup", function() { resizing = false; });
    }
  }

  // ── Mode solo (/images/<id>) ───────────────────────────────────────────────

  var SOLO_BTN_ID = "it-solo-btn";

  var Q_FIND_IMAGE_SOLO = "query FindImageSolo($id:ID!){findImage(id:$id){id title urls date details organized paths{thumbnail}files{path basename width height size}studio{id name image_path details}performers{id name image_path}tags{id name}}}";

  function formatFileSize(bytes) {
    if (!bytes) return "";
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + " Go";
    if (bytes >= 1048576)    return (bytes / 1048576).toFixed(1)    + " Mo";
    return Math.round(bytes / 1024) + " Ko";
  }

  // Met a jour le bloc image en en-tete du panel solo.
  // scrapedImage : URL de l'image scrapee (peut etre null).
  // Etat A (compareImageOnScrape ON + image scrapee) : deux vignettes cote a cote.
  // Etat B (OFF ou pas d'image scrapee) : vignette + infos fichier.
  function updateSoloImageHeader(imageID, scrapedImage) {
    var header = document.getElementById("it-solo-image-header");
    if (!header) return;
    var r = state.rows[imageID];
    var img = r && r.image;
    if (!img) return;
    var thumb = getThumb(img);
    var fname = getFilename(img);
    var f     = img.files && img.files.length ? img.files[0] : null;
    var dims  = f && f.width && f.height ? f.width + "\xD7" + f.height : "";
    var fsize = f && f.size ? formatFileSize(f.size) : "";
    var meta  = [dims, fsize].filter(Boolean).join(" \xB7 ");

    if (pluginConfig.compareImageOnScrape && scrapedImage) {
      header.style.display = "";
      header.className = "it-solo-image-block it-solo-compare";
      header.innerHTML =
        '<div class="it-solo-img-side">' +
          (thumb
            ? '<a href="/images/' + esc(imageID) + '" target="_blank" class="image-thumbnail"><img class="it-solo-thumb" src="' + esc(thumb) + '"></a>'
            : '<div class="it-solo-thumb-placeholder"></div>') +
          '<div class="it-solo-img-caption">' +
            '<span class="it-solo-img-label">Existing</span>' +
            (meta ? '<span class="it-solo-img-meta">' + esc(meta) + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="it-solo-img-side">' +
          '<img class="it-solo-thumb it-solo-thumb-scraped" src="' + esc(scrapedImage) + '" onerror="this.style.opacity=0.25">' +
          '<div class="it-solo-img-caption">' +
            '<span class="it-solo-img-label">Scraped <span class="it-new-badge">new</span></span>' +
          '</div>' +
        '</div>';
    } else {
      // Not comparing: the centered thumbnail lives in the row itself (see renderRow).
      header.className = "";
      header.innerHTML = "";
      header.style.display = "none";
      return;
    }
  }

  // Builds the single-image panel AND starts the scrape. Called once, on the
  // first click of the "Image Tagger" button (never automatically when the
  // page opens) - see injectSoloBtn().
  function loadSoloPanel(imageID) {
    var sp = state.scrapers.length > 0
      ? Promise.resolve(state.scrapers)
      : getImageScrapers().then(function(s) { state.scrapers = s; return s; });

    Promise.all([
      sp,
      loadPluginConfig(),
      gql("FindImageSolo", Q_FIND_IMAGE_SOLO, { id: String(imageID) })
    ]).then(function(results) {
      var scrapers  = results[0];
      var imageData = results[2] && results[2].findImage;
      if (!imageData) { updateStatus("Image not found"); return; }
      if (!scrapers.length) scrapers = [{ id: "", name: "No image scraper" }];
      reconcileScraperChain();

      state.images = [imageData];
      state.rows[imageID] = { image: imageData, status: "idle", scraped: null, msg: "" };

      if (!document.getElementById(PANEL_ID)) {
        state.visible = true;
        var panel = buildPanel(scrapers, imageID);
        panel.classList.add("it-panel-solo");  // before attachPanelEvents(): the title bar buttons read it
        document.body.appendChild(panel);
        attachPanelEvents();
        panel.classList.toggle("it-hide-scraper-mode", !!pluginConfig.hideScraperModeToggle);
        var titleEl = document.getElementById("it-titlebar-drag");
        if (titleEl) titleEl.textContent = "Scrape image";
        // A single image is already "compact": the toggle has nothing to switch.
        var compactBtn = document.getElementById("it-titlebar-compact");
        if (compactBtn) compactBtn.style.display = "none";
        // Close button: updates SOLO_BTN_ID (not BTN_ID)
        var closeBtn = document.getElementById("it-titlebar-close");
        if (closeBtn) {
          var fresh = closeBtn.cloneNode(true);
          closeBtn.parentNode.replaceChild(fresh, closeBtn);
          fresh.addEventListener("click", function() {
            var p = document.getElementById(PANEL_ID);
            if (p) p.style.display = "none";
            var b = document.getElementById(SOLO_BTN_ID);
            if (b) b.classList.remove("it-active");
            state.visible = false;
            notifyVisibility();
          });
        }
      }
      renderRow(imageID);
      updateSoloImageHeader(imageID, null);
      updateStatus("Ready - scraping...");
      window.itScrapeOne(imageID);
    }).catch(function(err) {
      updateStatus("Error: " + (err.message || String(err)));
    });
  }

  function injectSoloBtn(imageID) {
    if (document.getElementById(SOLO_BTN_ID)) return;
    var attempts = 0;
    (function tryInject() {
      if (++attempts > 40) return;
      var toolbar =
        document.querySelector(".image-header .btn-toolbar") ||
        document.querySelector(".image-toolbar") ||
        document.querySelector(".detail-header-group") ||
        document.querySelector(".btn-toolbar");
      if (!toolbar) { setTimeout(tryInject, 250); return; }
      var btn = document.createElement("button");
      btn.id = SOLO_BTN_ID;
      btn.className = "minimal btn btn-secondary it-toolbar-badge-btn";
      btn.title = "Image Tagger";
      btn.innerHTML = '<span class="it-toolbar-badge">IT</span>';
      btn.addEventListener("click", function() {
        var panel = document.getElementById(PANEL_ID);
        // Premier clic : le panel n'existe pas encore -> le construire et
        // lancer le scrape maintenant (pas avant).
        if (!panel) {
          btn.classList.add("it-active");
          loadSoloPanel(imageID);
          return;
        }
        var isVisible = panel.style.display !== "none";
        panel.style.display = isVisible ? "none" : "";
        btn.classList.toggle("it-active", !isVisible);
      });
      toolbar.appendChild(btn);
    })();
  }

  function setupSolo(imageID) {
    [PANEL_ID, BTN_ID].forEach(function(id) {
      var el = document.getElementById(id); if (el) el.remove();
    });
    state.images = []; state.rows = {}; state.running = false;

    injectSoloBtn(imageID);
  }

  // ── Bouton toggle ──────────────────────────────────────────────────────────

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
    btn.textContent = state.visible ? "Image Tagger [ON]" : "Image Tagger";
    if (state.visible) { btn.style.color = "#88c0d0"; btn.style.border = "1px solid #88c0d0"; }

    btn.addEventListener("click", function() {
      state.visible = !state.visible;
      var panel = document.getElementById(PANEL_ID);
      if (panel) {
        panel.style.display = state.visible ? "" : "none";
        if (state.visible && state.images.length === 0) loadImages();
      }
      btn.textContent  = state.visible ? "Image Tagger [ON]" : "Image Tagger";
      btn.style.color  = state.visible ? "#88c0d0" : "";
      btn.style.border = state.visible ? "1px solid #88c0d0" : "";
    });
    toolbar.appendChild(btn);
  }

  // ── Injection ──────────────────────────────────────────────────────────────

  var _injectedPath = "";

  function setup() {
    if (_host || _hostSolo) return;  // ouvert depuis Stash UI : le panneau n'est pas lie a une page classique
    var pathname = window.location.pathname;
    var path = pathname + window.location.search;

    // Page detail d'une image (/images/<id>) → mode solo
    var soloMatch = pathname.match(/^\/images\/(\d+)$/);
    if (soloMatch) {
      // Le panel n'existe pas tant que l'utilisateur n'a pas clique sur le
      // bouton (voir injectSoloBtn/loadSoloPanel) : ne pas exiger PANEL_ID ici.
      if (_injectedPath === path && document.getElementById(SOLO_BTN_ID)) return;
      _injectedPath = path;
      // Nettoie le bouton masse s'il restait d'une navigation precedente
      var oldMassBtn = document.getElementById(BTN_ID);
      if (oldMassBtn) oldMassBtn.remove();
      setTimeout(function() { setupSolo(soloMatch[1]); }, 400);
      return;
    }

    // Hors de /images : nettoyage complet (inclut le bouton solo si present)
    if (!pathname.startsWith("/images")) {
      [PANEL_ID, BTN_ID, SOLO_BTN_ID].forEach(function(id) {
        var el = document.getElementById(id); if (el) el.remove();
      });
      _injectedPath = ""; return;
    }
    if (_injectedPath === path && document.getElementById(PANEL_ID)) return;

    // Le panel et le bouton existent déjà (juste un changement de
    // filtre/tri/page sur /images, pas une vraie navigation hors de la
    // page) : rafraîchit la liste EN PLACE plutôt que de fermer/rouvrir
    // tout le panel. Avant ce fix, chaque changement de filtre/page
    // détruisait et reconstruisait entièrement it-panel/it-toggle-btn
    // (visible comme un clignotement du panel) - même bug corrigé sur
    // sceneTagger.js (voir le CLAUDE.md du projet).
    // loadImages() gère déjà la récupération de la nouvelle liste ET sa
    // fusion avec state.rows existant (une image déjà scrapée garde son
    // résultat si elle est toujours présente dans la nouvelle page/filtre),
    // donc pas besoin de vider state.rows ici - seulement state.images,
    // pour forcer loadImages() à repartir d'une liste fraîche.
    if (_injectedPath !== "" && document.getElementById(PANEL_ID) && document.getElementById(BTN_ID)) {
      _injectedPath = path;
      state.images = [];
      if (state.visible) loadImages();
      return;
    }
    _injectedPath = path;

    [PANEL_ID, BTN_ID, SOLO_BTN_ID].forEach(function(id) {
      var el = document.getElementById(id); if (el) el.remove();
    });
    state.images = []; state.running = false;

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
        : getImageScrapers().then(function(s) {
            state.scrapers = s;
            return s;
          });

      sp.then(function(scrapers) {
        if (!scrapers.length) scrapers = [{ id: "", name: "No image scraper" }];
        // Charger la config plugin avant de construire le panneau
        loadPluginConfig().then(function() {
        reconcileScraperChain();
        if (!document.getElementById(PANEL_ID)) {
          var panel = buildPanel(scrapers);
          // Appender à document.body (pas dans l'arbre React de la grille) :
          // un ancêtre React avec transform/contain casserait le containing-block
          // de position:fixed, décalant le panel (surtout visible en mode large).
          document.body.appendChild(panel);
          attachPanelEvents();
        }
        injectToggleBtn();
        if (state.visible && state.images.length === 0) loadImages();
        }); // fin loadPluginConfig
      });
    }
    setTimeout(tryInject, 400);
  }

  // Ne réinitialise PAS _injectedPath ici (contrairement à l'ancienne
  // version) : setup() lui-même compare l'ancien/nouveau path (pathname +
  // query string) pour décider entre un refresh in-place (filtre/tri/page)
  // et une reconstruction complète (navigation réelle hors de /images).
  // Le forcer à "" ici court-circuitait cette logique et détruisait le
  // panel à chaque navigation, y compris un simple changement de page.
  PluginEvent.addEventListener("stash:location", function() { setTimeout(setup, 150); });
  setTimeout(setup, 800);

  // ── Point d'entree Stash UI ────────────────────────────────────────────────
  // Appele par assets/stashui.js (le module d'extension Stash UI). Le meme
  // panneau flottant s'affiche par-dessus la liste de Stash UI ;
  // `host.fetchIds(page)` donne les ids des images de cette page pour le
  // filtre courant de la liste.

  function ensureHostPanel() {
    var sp = state.scrapers.length > 0
      ? Promise.resolve(state.scrapers)
      : getImageScrapers().then(function (s) { state.scrapers = s; return s; });
    return sp.then(function (scrapers) {
      if (!scrapers.length) scrapers = [{ id: "", name: "No image scraper" }];
      return loadPluginConfig().then(function () {
        reconcileScraperChain();
        if (!document.getElementById(PANEL_ID)) {
          document.body.appendChild(buildPanel(scrapers));
          attachPanelEvents();
        }
      });
    });
  }

  function setHostVisible(visible) {
    state.visible = visible;
    var panel = document.getElementById(PANEL_ID);
    if (panel) panel.style.display = visible ? "" : "none";
    notifyVisibility();
  }

  window.itImageTaggerHost = {
    perPage: function () { return stashuiPerPage(); },
    isOpen: function () { return state.visible; },
    // Panneau solo pour UNE image (la visionneuse d'images de Stash UI) : le meme que le bouton solo de la vue
    // classique. Meme image -> afficher/masquer ; autre image -> repartir de zero pour elle.
    openSolo: function (imageID) {
      imageID = String(imageID);
      var panel = document.getElementById(PANEL_ID);
      if (panel && _soloHostID === imageID && panel.classList.contains("it-panel-solo")) {
        panel.style.display = panel.style.display === "none" ? "" : "none";
        return;
      }
      if (panel) panel.remove();          // panneau liste ou solo d'une autre image
      state.images = []; state.rows = {}; state.running = false; state.visible = false;
      _host = null;
      _hostSolo = true;
      _soloHostID = imageID;
      loadSoloPanel(imageID);
    },
    toggle: function (host) {
      if (state.visible) { setHostVisible(false); return Promise.resolve(); }
      // le panneau solo n'a pas la meme structure que celui de la liste : on le retire avant de construire l'autre
      var solo = document.getElementById(PANEL_ID);
      if (solo && solo.classList.contains("it-panel-solo")) { solo.remove(); state.rows = {}; _soloHostID = null; }
      _hostSolo = false;
      _host = host;
      return ensureHostPanel().then(function () {
        setHostVisible(true);
        state.currentPage = 1;
        state.images = [];
        loadImages();
      });
    },
    // Le filtre/tri de la liste a change dans Stash UI : repartir de la page 1
    refresh: function () {
      if (!_host || !state.visible) return;
      state.currentPage = 1;
      state.images = [];
      loadImages();
    }
  };

})();
