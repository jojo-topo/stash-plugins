// Stash UI extension module for sceneTagger: a "Scene Tagger" button in the toolbar of the
// scenes list. The same floating panel as in classic Stash opens over the page (sceneTagger.js,
// window.stSceneTaggerHost) and lists the scenes of the list's current filter, 40 per page.
const PER_PAGE = 40;

export default function setup(stashui) {
  if (!stashui.has("slot:list.toolbar")) return;

  // Marks the page as Stash UI: the "html.st-sui" block at the end of sceneTagger.css re-skins the
  // panel with Stash UI's color variables (and its liquid glass). Classic Stash never loads this file.
  document.documentElement.classList.add("st-sui");

  // Plug the panel's buttons into Stash UI's effects layer (fx.js / fx.css): giving them the .kb-btn class
  // is all it takes for the edge shimmer on hover and the ripple on press. The panel is re-rendered often,
  // so new buttons are picked up as they appear. (No .is-primary: its attention pulse on every Scrape
  // button of a long list would be noise.)
  let fxTick = 0;
  const plugButtons = () => {
    fxTick = 0;
    const panel = document.getElementById("st-panel");
    if (!panel) return;
    panel.querySelectorAll(".st-btn:not(.kb-btn), .st-combo-btn:not(.kb-btn), .st-multi-studio-toggle:not(.kb-btn), .st-filter-item:not(.kb-btn)").forEach((b) => b.classList.add("kb-btn"));
  };
  new MutationObserver(() => { if (!fxTick) fxTick = requestAnimationFrame(plugButtons); })
    .observe(document.body, { childList: true, subtree: true });

  let loading = null;
  const loadPanel = () => {
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "/plugin/sceneTagger/css";
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = "/plugin/sceneTagger/javascript";
      js.onload = () => resolve();
      js.onerror = () => { loading = null; reject(new Error("sceneTagger.js did not load")); };
      document.head.appendChild(js);
    });
    return loading;
  };

  stashui.addSlot("list.toolbar", {
    id: "scene-tagger",
    title: "Scene Tagger",
    match: (ctx) => ctx.kind === "scene" && ctx.page === "scenes",
    mount(el, ctx) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "kb-btn";
      const label = () => {
        const open = window.stSceneTaggerHost && window.stSceneTaggerHost.isOpen();
        btn.textContent = open ? "Scene Tagger [ON]" : "Scene Tagger";
      };
      label();
      // the panel can also be closed with its own cross: keep the [ON] label in step
      window.addEventListener("st-visibility-changed", label);

      // ctx is live: the filter, sort and search are read at the moment of each fetch
      const host = {
        async fetchIds(page) {
          const d = await stashui.gql(
            `query($f: FindFilterType, $x: SceneFilterType) { findScenes(filter: $f, scene_filter: $x) { count scenes { id } } }`,
            { f: { q: ctx.q || undefined, page, per_page: PER_PAGE, sort: ctx.sort, direction: ctx.dir || "DESC" }, x: ctx.filter || {} }
          );
          const r = d.findScenes;
          return { ids: r.scenes.map((s) => s.id), page, total: Math.max(1, Math.ceil(r.count / PER_PAGE)) };
        },
      };

      btn.addEventListener("click", async () => {
        try {
          await loadPanel();
          await window.stSceneTaggerHost.toggle(host);
        } catch (e) {
          stashui.ui.errorToast(e);
        }
        label();
      });

      const off = ctx.onChange(() => window.stSceneTaggerHost && window.stSceneTaggerHost.refresh());
      el.appendChild(btn);
      return () => { off(); window.removeEventListener("st-visibility-changed", label); btn.remove(); };
    },
  });

  // Scene page: a "Scene Tagger" button in the action row of the info panel (favorites, detailed
  // rating, O counter), opening the solo panel for that scene. The panel is Stash UI's own markup
  // (views/placard.js), redrawn on every change, so the button is put back whenever it is missing.
  // The square "ST" badge of the classic scene toolbar (same colors as .st-toolbar-badge in sceneTagger.css);
  // sceneTagger.css itself is only loaded on the first click, so these few rules live here
  const badgeCss = document.createElement("style");
  badgeCss.textContent =
    ".rc-st-solo { display: inline-grid; place-items: center; aspect-ratio: 1; padding: 0 !important;" +
    " background: transparent !important; border: 0 !important; box-shadow: none !important; }" +
    ".rc-st-badge { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; border-radius: 8px;" +
    " background: var(--base, #182026); border: 1px solid var(--bg-3, #394b59); color: var(--pink-2, #2b95d6); font-size: 12px; font-weight: 700; letter-spacing: -.02em; }" +
    ".rc-st-solo:hover .rc-st-badge { border-color: var(--pink, #137cbd); background: var(--bg-2, #293742); }";
  document.head.appendChild(badgeCss);

  let sceneTimer = null;
  const addSoloButton = () => {
    const m = location.hash.match(/^#\/scene\/(\d+)/);
    if (!m) return;
    const anchor = document.querySelector(".kb-plc [data-advrate]"); // only scene panels have the detailed rating
    if (!anchor) return;
    const row = anchor.parentElement;
    if (row.querySelector(".rc-st-solo")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kb-plc-btn rc-st-solo";
    btn.title = "Scene Tagger";
    btn.setAttribute("aria-label", "Scene Tagger");
    btn.innerHTML = '<span class="rc-st-badge">ST</span>';
    btn.addEventListener("click", async () => {
      try {
        await loadPanel();
        const id = (location.hash.match(/^#\/scene\/(\d+)/) || [])[1];
        if (id) window.stSceneTaggerHost.openSolo(id);
      } catch (e) {
        stashui.ui.errorToast(e);
      }
    });
    row.appendChild(btn);
  };
  new MutationObserver(() => { clearTimeout(sceneTimer); sceneTimer = setTimeout(addSoloButton, 80); })
    .observe(document.body, { childList: true, subtree: true });
  addSoloButton();
}
