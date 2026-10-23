// Stash UI extension module for imageTagger: an "Image Tagger" button in the toolbar of the
// images list. The same floating panel as in classic Stash opens over the page (imageTagger.js,
// window.itImageTaggerHost) and lists the images of the list's current filter, 40 per page.
// Images per page: the "Images per page" setting of imageTagger (read at each fetch), 40 until it is loaded
const perPage = () => (window.itImageTaggerHost && window.itImageTaggerHost.perPage && window.itImageTaggerHost.perPage()) || 40;

export default function setup(stashui) {
  if (!stashui.has("slot:list.toolbar")) return;

  // Marks the page as Stash UI: the "html.it-sui" block at the end of imageTagger.css re-skins the
  // panel with Stash UI's color variables (and its liquid glass). Classic Stash never loads this file.
  document.documentElement.classList.add("it-sui");

  // Plug the panel's buttons into Stash UI's effects layer (fx.js / fx.css): giving them the .kb-btn class
  // is all it takes for the edge shimmer on hover and the ripple on press. The panel is re-rendered often,
  // so new buttons are picked up as they appear.
  let fxTick = 0;
  const plugButtons = () => {
    fxTick = 0;
    const panel = document.getElementById("it-panel");
    if (!panel) return;
    panel.querySelectorAll(".it-btn:not(.kb-btn), .it-combo-btn:not(.kb-btn), .it-multi-studio-toggle:not(.kb-btn), .it-filter-item:not(.kb-btn)").forEach((b) => b.classList.add("kb-btn"));
  };
  new MutationObserver(() => { if (!fxTick) fxTick = requestAnimationFrame(plugButtons); })
    .observe(document.body, { childList: true, subtree: true });

  let loading = null;
  const loadPanel = () => {
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "/plugin/imageTagger/css";
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = "/plugin/imageTagger/javascript";
      js.onload = () => resolve();
      js.onerror = () => { loading = null; reject(new Error("imageTagger.js did not load")); };
      document.head.appendChild(js);
    });
    return loading;
  };

  stashui.addSlot("list.toolbar", {
    id: "image-tagger",
    title: "Image Tagger",
    match: (ctx) => ctx.kind === "image" && (ctx.page === "images" || ctx.page === "studio"), // also the Images tab of a studio page
    mount(el, ctx) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "kb-btn";
      const label = () => {
        const open = window.itImageTaggerHost && window.itImageTaggerHost.isOpen();
        btn.textContent = open ? "Image Tagger [ON]" : "Image Tagger";
      };
      label();
      // the panel can also be closed with its own cross: keep the [ON] label in step
      window.addEventListener("it-visibility-changed", label);

      // ctx is live: the filter, sort and search are read at the moment of each fetch
      const host = {
        async fetchIds(page) {
          const d = await stashui.gql(
            `query($f: FindFilterType, $x: ImageFilterType) { findImages(filter: $f, image_filter: $x) { count images { id } } }`,
            { f: { q: ctx.q || undefined, page, per_page: perPage(), sort: ctx.sort, direction: ctx.dir || "DESC" }, x: ctx.filter || {} }
          );
          const r = d.findImages;
          return { ids: r.images.map((i) => i.id), page, total: Math.max(1, Math.ceil(r.count / perPage())) };
        },
      };

      btn.addEventListener("click", async () => {
        try {
          await loadPanel();
          await window.itImageTaggerHost.toggle(host);
        } catch (e) {
          stashui.ui.errorToast(e);
        }
        label();
      });

      const off = ctx.onChange(() => window.itImageTaggerHost && window.itImageTaggerHost.refresh());
      el.appendChild(btn);
      return () => { off(); window.removeEventListener("it-visibility-changed", label); btn.remove(); };
    },
  });

  // Image viewer (#/image/<id>): a square "IT" badge at the end of the action row of the side panel (rating,
  // favorite, O counter), opening the solo panel for that image - the same as the classic image page's "IT"
  // badge, and as the "ST" badge on scenes. The panel is Stash UI's own markup, redrawn on every change, so the
  // badge is put back whenever it is missing. The solo panel starts the scrape on its first opening, as in classic.
  const badgeCss = document.createElement("style");
  badgeCss.textContent =
    ".rc-it-solo { display: inline-grid; place-items: center; aspect-ratio: 1; padding: 0 !important;" +
    " background: transparent !important; border: 0 !important; box-shadow: none !important; }" +
    ".rc-it-badge { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; border-radius: 8px;" +
    " background: #1a2028; border: 1px solid #2c3542; color: #88c0d0; font-size: 12px; font-weight: 700; letter-spacing: -.02em; }" +
    ".rc-it-solo:hover .rc-it-badge, .rc-it-solo.is-on .rc-it-badge { border-color: #88c0d0; background: #1a3040; }";
  document.head.appendChild(badgeCss);

  const addSoloBadge = () => {
    if (!/^#\/image\/\d+/.test(location.hash)) return;
    const row = document.querySelector(".kb-viewer .kb-plc .kb-plc-acts");
    if (!row || row.querySelector(".rc-it-solo")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kb-plc-btn rc-it-solo";
    btn.title = "Image Tagger";
    btn.setAttribute("aria-label", "Image Tagger");
    btn.innerHTML = '<span class="rc-it-badge">IT</span>';
    btn.addEventListener("click", async () => {
      try {
        await loadPanel();
        const id = (location.hash.match(/^#\/image\/(\d+)/) || [])[1];
        if (id) window.itImageTaggerHost.openSolo(id);
        btn.classList.toggle("is-on", !!document.getElementById("it-panel") && document.getElementById("it-panel").style.display !== "none");
      } catch (e) {
        stashui.ui.errorToast(e);
      }
    });
    row.appendChild(btn);
  };
  new MutationObserver(addSoloBadge).observe(document.body, { childList: true, subtree: true });
  addSoloBadge();
}
