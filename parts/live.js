/* ============================================================
   Live module — the storefront half of the deck.

   Everything here runs the way a VTEX storefront would: in the browser,
   with the tracker key from the tracking code, and the profile UUID the
   Synerise JS SDK gives this visitor. No backend, no API key.

   Shared context (store · language · shopper) lives in `state` and is the
   same on every live slide; changing it on one slide changes it on all.
   ============================================================ */
(function () {
  'use strict';

  var CFG = window.__DEMO_CONFIG__;
  var API = CFG.apiBase;
  var TK = CFG.trackerKey;
  var LS_KEY = 'vtex-deck';

  // ---------------------------------------------------------------- state --
  function byKey(list, key) { var o = {}; list.forEach(function (x) { o[x[key]] = x; }); return o; }
  var LANG = byKey(CFG.languages, 'code');
  var STORE = byKey(CFG.stores, 'id');
  var CAT = byKey(CFG.categories, 'value');
  var CAMPAIGN = byKey(CFG.campaigns, 'key');
  // One flat list of stores, by name: the demo chain's countries are not a
  // dimension here (slide 02 maps a country to a workspace of its own).
  var STORES = CFG.stores.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });

  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { saved = {}; }
  var state = {
    store: STORE[saved.store] ? saved.store : CFG.defaults.store,
    lang: LANG[saved.lang] ? saved.lang : CFG.defaults.lang,
    shopper: saved.shopper || 'sdk',
    storeFilter: true,
    query: {},               // search: per language, so switching back restores it
    facet: { brand: null, price: null },
    item: CFG.defaults.item, // recommendations: the visited product
    cat: CFG.defaults.category, // category page
    sub: null,
    sort: 'rel',
  };
  CFG.languages.forEach(function (l) { state.query[l.code] = l.query; });
  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ store: state.store, lang: state.lang, shopper: state.shopper })); } catch (e) { /* private mode */ }
  }

  var views = [];            // every live view on the page (filled at boot)
  var items = {};            // itemId → last seen attributes (search or reco)
  function remember(list) { (list || []).forEach(function (it) { if (it && it.itemId) items[it.itemId] = Object.assign({}, items[it.itemId], it); }); }

  // ------------------------------------------------------------- strings --
  var UI = {
    en: { ph: 'Search Havenmart', res: 'results in', chain: 'across the chain', none: 'Nothing on this shelf.', dym: 'Did you mean', showing: 'Showing results for', inS: 'in store', outS: 'not here', brand: 'Brand', price: 'Price', toReco: 'Recommendations for', all: 'All stores', visited: 'Visited product', picked: 'Picked for you', more: 'Show more', inCat: 'in', sortRel: 'Recommended', sortPa: 'Price: low to high', sortPd: 'Price: high to low', sortNew: 'Newest', allSubs: 'All', locale: 'en-IE' },
    es: { ph: 'Buscar en Havenmart', res: 'resultados en', chain: 'en toda la cadena', none: 'Nada en este estante.', dym: '¿Quisiste decir', showing: 'Resultados de', inS: 'en tienda', outS: 'no está', brand: 'Marca', price: 'Precio', toReco: 'Recomendaciones para', all: 'Todas las tiendas', visited: 'Producto visitado', picked: 'Elegidos para ti', more: 'Ver más', inCat: 'en', sortRel: 'Recomendados', sortPa: 'Precio: de menor a mayor', sortPd: 'Precio: de mayor a menor', sortNew: 'Novedades', allSubs: 'Todo', locale: 'es-ES' },
    fr: { ph: 'Rechercher sur Havenmart', res: 'résultats à', chain: "dans toute l'enseigne", none: 'Rien dans ce rayon.', dym: 'Vouliez-vous dire', showing: 'Résultats pour', inS: 'en magasin', outS: 'absent', brand: 'Marque', price: 'Prix', toReco: 'Recommandations pour', all: 'Tous les magasins', visited: 'Produit visité', picked: 'Choisis pour vous', more: 'Voir plus', inCat: 'à', sortRel: 'Recommandés', sortPa: 'Prix croissant', sortPd: 'Prix décroissant', sortNew: 'Nouveautés', allSubs: 'Tout', locale: 'fr-FR' },
  };
  function t(k) { return (UI[state.lang] || UI.en)[k]; }

  // ------------------------------------------------------------ helpers --
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function h(html) { var tpl = document.createElement('template'); tpl.innerHTML = html.trim(); return tpl.content.firstChild; }
  function short(k) { return k.slice(0, 4) + '…' + k.slice(-4); }
  // Euros in the shopper's locale; `whole` drops ".00" (slider labels).
  function eur(n, whole) {
    n = parseFloat(n);
    if (isNaN(n)) return '';
    var digits = whole && n % 1 === 0 ? 0 : 2;
    try { return new Intl.NumberFormat(t('locale'), { style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n); } catch (e) { return '€' + n.toFixed(digits); }
  }
  function nameOf(it) { return it['name_' + state.lang] || it.name_en || it.name || it.itemId; }
  function catLabel(v) { var c = CAT[v]; return c ? (c[state.lang] || c.en) : v; }
  function storeLabel(id) { var s = STORE[id]; return s ? s.name : id; }

  // IQL. Strings are double-quoted; == on an array attribute matches one
  // whole element (availability == "ST-ES-MAD-01" never hits "…-011").
  function iqlStr(v) { return '"' + String(v).replace(/"/g, '\\"') + '"'; }
  function availClause(store) { return 'availability == ' + iqlStr(store || state.store); }
  function and(parts) { return parts.filter(Boolean).join(' AND '); }

  function catClass(c) {
    c = (c || '').toLowerCase();
    if (c.indexOf('grocery') === 0) return 'cat-grocery';
    if (c.indexOf('beverage') === 0) return 'cat-beverages';
    if (c.indexOf('health') === 0) return 'cat-health';
    if (c.indexOf('home') === 0) return 'cat-home';
    if (c.indexOf('baby') === 0) return 'cat-baby';
    return 'cat-other';
  }
  // The packshot from the feed (imageUrl) over a coloured tile; the tile
  // shows through while the image loads, or if it fails.
  function tile(it) {
    return '<div class="tile ' + catClass(it.category) + '">' + esc(it.unit || '') +
      (it.subcategory ? '<small>' + esc(it.subcategory) + '</small>' : '') +
      (it.imageUrl ? '<img src="' + esc(it.imageUrl) + '" alt="" loading="lazy" onload="this.classList.add(\'is-loaded\')" onerror="this.remove()">' : '') +
      '</div>';
  }
  function inStore(it) { return Array.isArray(it.availability) ? it.availability.indexOf(state.store) >= 0 : null; }
  // Store badges only make sense when the request was scoped to a store.
  function stockBadge(it) {
    if (!state.storeFilter) return '';
    var s = inStore(it);
    if (s === null) return '';
    return s ? '<span class="stock in">' + esc(t('inS')) + '</span>' : '<span class="stock out">' + esc(t('outS')) + '</span>';
  }
  // One product card, the same on every live slide.
  function card(it, i) {
    return '<button type="button" class="pcard is-new" style="animation-delay:' + (i * 30) + 'ms" data-id="' + esc(it.itemId) + '" data-pos="' + (i + 1) + '">' +
      tile(it) + stockBadge(it) + '<span class="pname">' + esc(nameOf(it)) + '</span>' +
      '<span class="pmeta"><span class="pbrand">' + esc(it.brand || '') + '</span><span class="pprice">' + eur(it.price) + '</span></span></button>';
  }
  function cards(list) { return list.map(card).join('') || '<div class="empty">' + esc(t('none')) + '</div>'; }
  function onCards(box, fn) {
    box.querySelectorAll('.pcard').forEach(function (n) {
      n.addEventListener('click', function () { fn(n.getAttribute('data-id'), +n.getAttribute('data-pos')); });
    });
  }
  function errBox(r) {
    var b = r.body || {};
    return '<div class="err-box">' + esc((b.errorCode || r.status) + ' · ' + (b.message || b.error || JSON.stringify(b).slice(0, 300))) + '</div>';
  }

  // ---------------------------------------------------------------- SDK --
  // The tracking code in <head> loads the SDK and calls SR.init with the
  // tracker key; onSyneriseLoad then fires 'synerise:ready'. The SDK assigns
  // this browser an anonymous profile UUID (cookie _snrs_uuid), which is what
  // search and recommendations get as clientUUID when the shopper is "this
  // browser".
  var sdk = { state: 'loading', uuid: null, events: 0 };
  var fallbackUuid = (function () {
    var make = function () { return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()); };
    try {
      var u = localStorage.getItem(LS_KEY + ':uuid');
      if (!u) { u = make(); localStorage.setItem(LS_KEY + ':uuid', u); }
      return u;
    } catch (e) { return make(); }
  })();
  function readSdkUuid() {
    var m = document.cookie.match(/(?:^|;\s*)_snrs_uuid=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
    try { var l = localStorage.getItem('_snrs_uuid'); if (l) return l.replace(/"/g, ''); } catch (e) { /* ignore */ }
    return null;
  }
  function onSdk() {
    var tries = 0;
    (function poll() {
      var u = readSdkUuid();
      if (u) { sdk.uuid = u; sdk.state = 'ready'; refreshSdkViews(); return; }
      if (++tries < 40) setTimeout(poll, 150);
      else { sdk.state = 'no-uuid'; refreshSdkViews(); }
    })();
  }
  window.addEventListener('synerise:ready', onSdk);
  if (window.SR && window.SR.init && typeof window.SR.event === 'object') onSdk();
  setTimeout(function () { if (sdk.state === 'loading') { sdk.state = 'blocked'; refreshSdkViews(); } }, 8000);

  function shopperIsBrowser() { return state.shopper === 'sdk'; }
  function shopperUuid() { return shopperIsBrowser() ? (sdk.uuid || fallbackUuid) : state.shopper; }

  // Events go through the SDK, so they land on this browser's profile. With a
  // borrowed persona selected they would land on the wrong profile, so they
  // are skipped (and the wire says so).
  function track(kind, params, wire) {
    if (!shopperIsBrowser()) { if (wire) wire.event(kind, 'skipped · persona selected'); return; }
    if (!(window.SR && SR.event && typeof SR.event[kind] === 'function')) { if (wire) wire.event(kind, 'SDK not loaded'); return; }
    try {
      var p = SR.event[kind](params);
      sdk.events++;
      if (wire) wire.event(kind, JSON.stringify(params));
      if (p && p.catch) p.catch(function () { /* event failures never break the page */ });
    } catch (e) { if (wire) wire.event(kind, 'error ' + e.message); }
    refreshSdkViews();
  }

  // ------------------------------------------------------------ API call --
  // GET only, tracker key as ?token= (the documented TrackerKey scheme). Each
  // successful answer is remembered per URL so a dropped network can replay
  // the last real response; the badge says when that happens.
  var memo = {};
  function call(path, params, wire, opts) {
    opts = opts || {};
    var qs = params.concat([['token', TK]]).map(function (p) {
      return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]);
    }).join('&');
    var url = API + path + '?' + qs;
    var t0 = performance.now();
    var entry = wire && !opts.quiet ? wire.request(path, params) : null;
    return fetch(url, { credentials: 'omit' }).then(function (r) {
      return r.text().then(function (txt) {
        var body; try { body = JSON.parse(txt); } catch (e) { body = { raw: txt }; }
        var ms = Math.round(performance.now() - t0);
        if (entry) entry.done(r.status, ms, opts.summary ? opts.summary(body, r.status) : '');
        if (r.ok) { memo[url] = body; setBadge('live'); }
        return { status: r.status, body: body, ms: ms, replay: false };
      });
    }, function (err) {
      var ms = Math.round(performance.now() - t0);
      if (memo[url]) {
        if (entry) entry.done('replay', ms, 'network down · last answer');
        setBadge('replay');
        return { status: 200, body: memo[url], ms: ms, replay: true };
      }
      if (entry) entry.done('ERR', ms, err.message);
      setBadge('off');
      return { status: 0, body: { error: err.message }, ms: ms, replay: false };
    });
  }
  function totalOf(b) { return b && b.meta ? b.meta.totalCount : null; }
  function hits(b) { var n = totalOf(b); return n == null ? '?' : n; }
  function search(kind, params, wire, summary) {
    return call('/search/v2/indices/' + LANG[state.lang].index + '/' + kind, params, wire, {
      quiet: summary === false,
      summary: function (b, s) { return s === 200 ? summary(b) : (b.message || b.error || ''); },
    });
  }
  // Recommendations: one campaign per model, the language as displayAttribute,
  // filters (store, category) as additionalFilters joined with AND. A filter
  // that matches nothing comes back as 404 REC-016 (search says 200 with
  // totalCount 0): that is an empty rail, not an error.
  function recommend(campaign, opts, wire) {
    var params = [['clientUUID', shopperUuid()]];
    if (campaign.needsItem) params.push(['itemId', state.item]);
    params.push(['displayAttribute', 'name_' + state.lang], ['displayAttribute', 'imageUrl']);
    if (opts.filter) params.push(['additionalFilters', opts.filter], ['filtersJoiner', 'AND']);
    if (opts.contextItems) params.push(['includeContextItems', 'true']);
    return call('/recommendations/v2/recommend/campaigns/' + campaign.id, params, wire, {
      summary: function (b, s) { return s === 200 ? (b.data || []).length + ' items' : (b.errorCode || '') + ' ' + (b.message || ''); },
    }).then(function (r) {
      return r.status === 404 && r.body && r.body.errorCode === 'REC-016' ? { status: 200, body: { data: [], extras: {} }, ms: r.ms } : r;
    });
  }

  var badgeState = 'live';
  function setBadge(s) {
    badgeState = s;
    document.querySelectorAll('[data-badge]').forEach(function (b) {
      b.className = 'live-badge ' + (s === 'live' ? 'is-live' : s === 'replay' ? 'is-replay' : 'is-off');
      b.innerHTML = s === 'live' ? '<span class="pulse"></span>live' : s === 'replay' ? 'replay' : 'offline';
    });
  }
  function badge() { return '<span data-badge class="live-badge is-live"><span class="pulse"></span>live</span>'; }

  // --------------------------------------------------------------- wire --
  // The console beside the storefront: every request with its parameters,
  // the status, the time, a one-line summary; SDK events in another colour.
  var HL = { filters: 1, additionalFilters: 1, displayAttribute: 1, clientUUID: 1, itemId: 1, query: 1 };
  var WIRE_HTML = '<div class="wire" data-wire><div class="wire-h"><span>Wire · browser → api.synerise.com</span><span>tracker key</span></div></div>';
  function Wire(el, compact) { this.el = el; this.compact = compact; }
  Wire.prototype.push = function (node) {
    if (!this.el) return;
    var head = this.el.querySelector('.wire-h');
    if (head && head.nextSibling) this.el.insertBefore(node, head.nextSibling); else this.el.appendChild(node);
    var all = this.el.querySelectorAll('.wire-entry');
    for (var i = 14; i < all.length; i++) all[i].remove();
  };
  Wire.prototype.request = function (path, params) {
    var shownPath = path.replace(/indices\/([0-9a-f]{8})[0-9a-f]+/, function (_, a) {
      var l = CFG.languages.filter(function (x) { return x.index.indexOf(a) === 0; })[0];
      return 'indices/<mark>' + (l ? 'havenmart-' + l.code : a + '…') + '</mark>';
    }).replace(/campaigns\/(\w+)$/, function (_, id) {
      var c = CFG.campaigns.filter(function (x) { return x.id === id; })[0];
      return 'campaigns/<mark>' + id + '</mark>' + (c ? ' <span class="wire-note">(' + esc(c.label) + ')</span>' : '');
    });
    var node;
    if (this.compact) {
      node = h('<div class="wire-entry"><span class="wire-m">GET</span> ' + shownPath + '?' +
        params.map(function (p) { return (HL[p[0]] ? '<mark>' : '') + esc(p[0]) + '=' + esc(p[1]) + (HL[p[0]] ? '</mark>' : ''); }).join('&amp;') +
        '&amp;token=' + short(TK) + ' <span class="wire-r-i"></span></div>');
    } else {
      node = h('<div class="wire-entry"><div class="wire-line"><span class="wire-m">GET</span> ' + shownPath + '</div>' +
        params.map(function (p) {
          var v = esc(p[1]);
          return '<div class="wire-p">' + esc(p[0]) + '=' + (HL[p[0]] ? '<mark>' + v + '</mark>' : '<b>' + v + '</b>') + '</div>';
        }).join('') + '<div class="wire-p">token=<b>' + short(TK) + '</b> <span class="wire-note">tracker key</span></div>' +
        '<div class="wire-r">… </div></div>');
    }
    this.push(node);
    return {
      done: function (status, ms, summary) {
        var ok = status === 200 || status === 'replay';
        var html = '<span class="' + (ok ? 'ok' : 'err') + '">' + status + '</span> · ' + ms + ' ms' + (summary ? ' · ' + esc(summary) : '');
        var r = node.querySelector('.wire-r') || node.querySelector('.wire-r-i');
        if (r) r.innerHTML = '→ ' + html;
      },
    };
  };
  Wire.prototype.event = function (kind, detail) {
    var name = { itemSearchClick: 'item.search.click', recommendationView: 'recommendation.view', recommendationClick: 'recommendation.click' }[kind] || kind;
    this.push(h('<div class="wire-entry"><span class="wire-ev">SDK</span> ' + name +
      '<div class="wire-p">' + esc(detail) + '</div></div>'));
  };

  // -------------------------------------------------------- context bar --
  function ctxBar(opts) {
    opts = opts || {};
    var storeOpts = STORES.map(function (s) {
      return '<option value="' + s.id + '"' + (s.id === state.store ? ' selected' : '') + '>' + esc(s.name) + ' · ' + s.skus + ' SKUs</option>';
    }).join('');
    var langs = CFG.languages.map(function (l) {
      return '<button type="button" data-lang="' + l.code + '"' + (l.code === state.lang ? ' class="is-on"' : '') + '>' + l.code.toUpperCase() + '</button>';
    }).join('');
    var shoppers = '<option value="sdk"' + (state.shopper === 'sdk' ? ' selected' : '') + '>This browser · SDK profile</option>' +
      CFG.personas.map(function (p) {
        return '<option value="' + p.uuid + '"' + (state.shopper === p.uuid ? ' selected' : '') + '>' + esc(p.name) + ' · ' + esc(p.note) + '</option>';
      }).join('');
    return '<div class="ctx" data-ctx>' +
      '<label>Store <select data-k="store">' + storeOpts + '</select></label>' +
      '<label>Language <span class="seg">' + langs + '</span></label>' +
      (opts.noShopper ? '' : '<label>Shopper <select data-k="shopper">' + shoppers + '</select></label>') +
      (opts.noFilter ? '' : '<label class="toggle"><input type="checkbox" data-k="storeFilter"' + (state.storeFilter ? ' checked' : '') + '> Store filter</label>') +
      '<span class="ctx-sp"></span>' + badge() + '</div>';
  }
  function wireCtx(root) {
    root.querySelectorAll('[data-ctx] select').forEach(function (sel) {
      sel.addEventListener('change', function () { setCtx(sel.getAttribute('data-k'), sel.value); });
    });
    root.querySelectorAll('[data-ctx] [data-lang]').forEach(function (b) {
      b.addEventListener('click', function () { setCtx('lang', b.getAttribute('data-lang')); });
    });
    root.querySelectorAll('[data-ctx] input[data-k="storeFilter"]').forEach(function (cb) {
      cb.addEventListener('change', function () { setCtx('storeFilter', cb.checked); });
    });
  }
  function setCtx(k, v) {
    if (state[k] === v) return;
    state[k] = v;
    if (k === 'lang') state.facet = { brand: null, price: null };
    save();
    // Every live slide re-renders its bar; the active one re-runs its calls.
    var active = document.querySelector('.slide.active');
    views.forEach(function (v2) { v2.stale = true; if (active && active.contains(v2.el)) v2.show(); });
    refreshSdkViews();
  }
  // Views of one kind (other than `except`) re-run when they next come on.
  function markStale(Kind, except) { views.forEach(function (v) { if (v instanceof Kind && v !== except) v.stale = true; }); }

  // The storefront frame shared by the search and category slides: brand,
  // a middle part (search box or category tabs), the store, then the page.
  function shop(middle, body) {
    return ctxBar() +
      '<div class="shop-wire">' +
        '<div class="shop">' +
          '<div class="shop-top">' +
            '<div class="shop-brand">haven<span>mart</span></div>' + middle +
            '<div class="shop-store"><b>' + esc(state.storeFilter ? storeLabel(state.store) : t('all')) + '</b>' + esc(LANG[state.lang].label) + '</div>' +
          '</div>' + body +
        '</div>' + WIRE_HTML +
      '</div>';
  }

  // Clicking a product: the product becomes the context of the
  // recommendations slide, and the summary row offers the jump.
  function offerReco(el, id) {
    state.item = id;
    markStale(RecoView);
    var sum = el.querySelector('[data-sum]');
    var it = items[id] || { itemId: id };
    var old = sum.querySelector('[data-go]'); if (old) old.remove();
    var go = h('<button type="button" class="btn btn-accent" data-go>' + esc(t('toReco')) + ' ' + esc(nameOf(it)).slice(0, 40) + ' →</button>');
    go.addEventListener('click', function () {
      var reco = document.querySelector('[data-live="reco"]');
      if (reco) window.deckJumpTo(window.deckSlideOf(reco));
    });
    sum.appendChild(go);
  }

  // ===================================================== search slide ====
  // Price facet: a range facet returns only {min, max} for the result set, so
  // the slider's ends come from that and the picked range becomes the filter
  // price >= lo AND price <= hi. Ends are rounded out to whole euros.
  function priceIql(p) { return 'price >= ' + p.lo + ' AND price <= ' + p.hi; }

  function SearchView(el) {
    this.el = el; this.stale = true; this.acTimer = null;
    this.lastFacets = { brand: {} };
  }
  SearchView.prototype.show = function () {
    var el = this.el, self = this;
    el.innerHTML = shop(
      '<div class="shop-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' +
        '<input type="search" data-q autocomplete="off" spellcheck="false" placeholder="' + esc(t('ph')) + '" value="' + esc(state.query[state.lang]) + '">' +
        '<div class="ac" data-ac></div></div>',
      '<div class="shop-sum" data-sum></div>' +
      '<div class="facets" data-facets></div>' +
      '<div class="grid-p" data-grid></div>');
    this.wire = new Wire(el.querySelector('[data-wire]'));
    wireCtx(el);
    var q = el.querySelector('[data-q]');
    q.addEventListener('input', function () {
      state.query[state.lang] = q.value;
      clearTimeout(self.acTimer);
      self.acTimer = setTimeout(function () { self.autocomplete(q.value); }, 200);
    });
    q.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(self.acTimer); self.closeAc(); state.facet = { brand: null, price: null }; self.run(); }
      if (e.key === 'Escape') self.closeAc();
    });
    q.addEventListener('blur', function () { setTimeout(function () { self.closeAc(); }, 200); });
    this.stale = false;
    this.run();
  };
  SearchView.prototype.closeAc = function () { var a = this.el.querySelector('[data-ac]'); if (a) a.classList.remove('is-open'); };
  // The filter for the current picks; `opts.noStore` / `opts.noPrice` leave
  // a clause out (the chain-wide count, the price slider's bounds).
  SearchView.prototype.filters = function (opts) {
    opts = opts || {};
    return and([
      state.storeFilter && !opts.noStore ? availClause() : '',
      state.facet.brand ? 'brand == ' + iqlStr(state.facet.brand) : '',
      state.facet.price && !opts.noPrice ? priceIql(state.facet.price) : '',
    ]);
  };
  SearchView.prototype.autocomplete = function (text) {
    var self = this, ac = this.el.querySelector('[data-ac]');
    if (!text || text.length < 2) { this.closeAc(); return; }
    var params = [['query', text], ['limit', '5'], ['clientUUID', shopperUuid()]];
    if (state.storeFilter) params.push(['filters', availClause()]);
    search('autocomplete', params, this.wire, function (b) { return (b.data || []).length + ' items'; }).then(function (r) {
      if (self.el.querySelector('[data-q]').value !== text) return;
      var data = (r.body && r.body.data) || [];
      remember(data);
      if (!data.length) { self.closeAc(); return; }
      ac.innerHTML = data.map(function (it) {
        return '<div class="ac-item" data-id="' + esc(it.itemId) + '">' + tile(it) + '<span>' + esc(nameOf(it)) + '</span><em>' + eur(it.price) + '</em></div>';
      }).join('');
      ac.classList.add('is-open');
      ac.querySelectorAll('.ac-item').forEach(function (n, i) {
        n.addEventListener('mousedown', function (e) {
          e.preventDefault();
          self.open(n.getAttribute('data-id'), i + 1, r.body.extras && r.body.extras.correlationId, 'autocomplete');
        });
      });
    });
  };
  SearchView.prototype.run = function () {
    var self = this, el = this.el;
    var query = state.query[state.lang] || '';
    function params(extra, filter) {
      var p = [['query', query]].concat(extra, [['clientUUID', shopperUuid()]]);
      if (filter) p.push(['filters', filter]);
      return p;
    }
    var main = search('query', params([['limit', '8'], ['includeMeta', 'true'], ['facets', 'brand'], ['includeFacets', 'filtered'],
      ['caseSensitiveFacetValues', 'true'], ['maxValuesPerFacet', '6']], this.filters()), this.wire,
      function (b) { return hits(b) + ' hits'; });
    // The same query without the store clause: how much of the chain's
    // answer this store actually has.
    var chain = search('query', params([['limit', '1'], ['includeMeta', 'true']], this.filters({ noStore: true })), this.wire,
      function (b) { return hits(b) + ' hits chain-wide'; });
    // The slider's ends: the price facet's {min, max} under every filter
    // except the price one, so moving the slider never shrinks its own scale.
    var priceFacet = function (b) { return b && b.extras && b.extras.filteredFacets && b.extras.filteredFacets.price; };
    var bounds = search('query', params([['limit', '1'], ['facets', 'price'], ['includeFacets', 'filtered']], this.filters({ noPrice: true })), this.wire,
      function (b) { var pf = priceFacet(b); return pf ? 'price facet ' + JSON.stringify(pf) : 'no price facet'; }
    ).then(function (res) {
      var pf = priceFacet(res.body);
      return pf && pf.min != null ? { min: Math.floor(pf.min), max: Math.ceil(pf.max) } : null;
    });
    Promise.all([main, chain, bounds]).then(function (rs) {
      var r = rs[0], ctotal = totalOf(rs[1].body), pb = rs[2];
      var grid = el.querySelector('[data-grid]'), sum = el.querySelector('[data-sum]'), fac = el.querySelector('[data-facets]');
      if (!grid) return;
      if (r.status !== 200) { grid.innerHTML = errBox(r); sum.innerHTML = ''; fac.innerHTML = ''; return; }
      var b = r.body, data = b.data || [], ex = b.extras || {};
      remember(data);
      self.correlationId = ex.correlationId;
      var total = totalOf(b);
      var html = '<span class="n">' + (total == null ? data.length : total) + '</span>' + (state.storeFilter
        ? '<span class="of">' + esc(t('res')) + ' <b>' + esc(storeLabel(state.store)) + '</b>' + (ctotal != null ? ' · ' + ctotal + ' ' + esc(t('chain')) : '') + '</span>'
        : '<span class="of">' + esc(t('chain')) + '</span>');
      // usedSuggestion is {text, highlighted, score}, like the entries of suggestions[]
      var used = ex.usedSuggestion && (typeof ex.usedSuggestion === 'object' ? ex.usedSuggestion.text : ex.usedSuggestion);
      if (used) html += '<span class="sugg">· ' + esc(t('showing')) + ' <b>' + esc(used) + '</b></span>';
      else if (!data.length && ex.suggestions && ex.suggestions.length) {
        html += '<span class="sugg">· ' + esc(t('dym')) + ' <b class="sugg-go" data-sugg="' + esc(ex.suggestions[0].text) + '">' + esc(ex.suggestions[0].text) + '</b>?</span>';
      }
      sum.innerHTML = html;
      var sg = sum.querySelector('[data-sugg]');
      if (sg) sg.addEventListener('click', function () { state.query[state.lang] = sg.getAttribute('data-sugg'); self.show(); });

      // Brand: with a value picked, the response only lists that value, so
      // the chips come from the previous, unpicked answer. Price: a slider.
      var ff = ex.filteredFacets || {};
      if (!state.facet.brand) self.lastFacets.brand = ff.brand || {};
      var bvals = state.facet.brand ? self.lastFacets.brand : (ff.brand || {});
      var bkeys = Object.keys(bvals).sort(function (a, b2) { return bvals[b2] - bvals[a]; }).slice(0, 6);
      if (state.facet.brand && bkeys.indexOf(state.facet.brand) < 0) bkeys.unshift(state.facet.brand);
      // One row per facet: label, then its values on a single line.
      fac.innerHTML =
        (bkeys.length ? '<div class="facet-row"><span class="facet-k">' + esc(t('brand')) + '</span><div class="facet-v">' + bkeys.map(function (v) {
          return '<button type="button" class="chip' + (state.facet.brand === v ? ' is-on' : '') + '" data-fv="' + esc(v) + '">' + esc(v) + (bvals[v] != null ? '<i>' + bvals[v] + '</i>' : '') + '</button>';
        }).join('') + '</div></div>' : '') +
        (pb && pb.max > pb.min ? '<div class="facet-row"><span class="facet-k">' + esc(t('price')) + '</span><div class="facet-v"><span class="pslider" data-pslider></span></div></div>' : '');
      fac.querySelectorAll('.chip').forEach(function (ch) {
        ch.addEventListener('click', function () {
          var v = ch.getAttribute('data-fv');
          state.facet.brand = state.facet.brand === v ? null : v;
          self.run();
        });
      });
      var ps = fac.querySelector('[data-pslider]');
      if (ps) self.priceSlider(ps, pb);

      grid.innerHTML = cards(data);
      onCards(grid, function (id, pos) { self.open(id, pos, self.correlationId, 'full-text-search'); });
    });
  };
  // Price slider: two range inputs on one track, snapping to 0.50 €. The label
  // follows the drag; letting go runs the search. The full span means "no
  // price filter", so the filter clause only appears once a handle moves.
  SearchView.prototype.priceSlider = function (box, pb) {
    var self = this, cur = state.facet.price;
    var lo = cur ? Math.max(pb.min, Math.min(cur.lo, pb.max)) : pb.min;
    var hi = cur ? Math.min(pb.max, Math.max(cur.hi, pb.min)) : pb.max;
    var range = function (end, v) {
      return '<input type="range" data-end="' + end + '" min="' + pb.min + '" max="' + pb.max + '" step="0.5" value="' + v + '" aria-label="' + (end === 'lo' ? 'min' : 'max') + ' price">';
    };
    box.innerHTML = '<span class="ps-track"><span class="ps-fill"></span>' + range('lo', lo) + range('hi', hi) + '</span>' +
      '<span class="ps-val"></span>' + (cur ? '<button type="button" class="ps-x" aria-label="Reset price">×</button>' : '');
    var a = box.querySelector('[data-end="lo"]'), b = box.querySelector('[data-end="hi"]');
    var fill = box.querySelector('.ps-fill'), val = box.querySelector('.ps-val');
    function paint(e) {
      // handles may not cross: the one being moved stops at the other
      if (+a.value > +b.value) { if (e && e.target === a) a.value = b.value; else b.value = a.value; }
      var x = +a.value, y = +b.value, span = pb.max - pb.min;
      fill.style.left = (100 * (x - pb.min) / span) + '%';
      fill.style.right = (100 * (pb.max - y) / span) + '%';
      val.textContent = eur(x, true) + ' – ' + eur(y, true);
    }
    function commit() {
      var x = +a.value, y = +b.value;
      state.facet.price = (x <= pb.min && y >= pb.max) ? null : { lo: x, hi: y };
      self.run();
    }
    [a, b].forEach(function (inp) { inp.addEventListener('input', paint); inp.addEventListener('change', commit); });
    var reset = box.querySelector('.ps-x');
    if (reset) reset.addEventListener('click', function () { state.facet.price = null; self.run(); });
    paint();
  };
  // A search click goes to Synerise through the SDK.
  SearchView.prototype.open = function (id, pos, correlationId, searchType) {
    this.closeAc();
    track('itemSearchClick', { correlationId: correlationId, item: id, position: pos, searchType: searchType }, this.wire);
    offerReco(this.el, id);
  };

  // ================================================= category page ====
  // A category page is a listing: /list on the same per-language index, no
  // query, the category as a filter (plus the store, as everywhere).
  // Mode 'special' puts a recommendation row on top (the personalized
  // campaign, narrowed to the category) and takes those items out of the
  // listing below with NOT sku IN [...], so nothing shows twice. That needs
  // sku to be a filterable attribute of the index.
  var ROW = 4;               // one row of the grid; a page is three rows
  var SORTS = {
    rel: { k: 'sortRel' },
    pa:  { k: 'sortPa',  p: [['sortBy', 'price'], ['ordering', 'asc']] },
    pd:  { k: 'sortPd',  p: [['sortBy', 'price'], ['ordering', 'desc']] },
    nw:  { k: 'sortNew', p: [['sortBy', 'createdAt'], ['ordering', 'desc']] },
  };

  function PlpView(el, special) { this.el = el; this.special = special; this.stale = true; this.subs = {}; this.excluded = []; }
  PlpView.prototype.show = function () {
    var el = this.el, self = this;
    var tabs = CFG.categories.map(function (c) {
      return '<button type="button" class="cat-tab' + (c.value === state.cat ? ' is-on' : '') + '" data-cat="' + esc(c.value) + '">' + esc(catLabel(c.value)) + '</button>';
    }).join('');
    var sorts = Object.keys(SORTS).map(function (k) {
      return '<option value="' + k + '"' + (state.sort === k ? ' selected' : '') + '>' + esc(t(SORTS[k].k)) + '</option>';
    }).join('');
    el.innerHTML = shop('<nav class="cat-nav">' + tabs + '</nav>',
      '<div class="shop-body">' +
        '<div class="shop-sum" data-sum></div>' +
        '<div class="facets"><div class="facet-row"><span class="facet-k" data-subk></span><div class="facet-v" data-subs></div></div></div>' +
        (this.special ? '<div class="picked"><div class="picked-h"><b>' + esc(t('picked')) + '</b><span data-pmeta></span></div><div class="grid-p" data-row></div></div>' : '') +
        '<div class="plp-bar"><span data-plpmeta></span><select data-sort>' + sorts + '</select></div>' +
        '<div class="grid-p" data-grid></div>' +
        '<div class="plp-more"><button type="button" class="btn" data-more hidden>' + esc(t('more')) + '</button></div>' +
      '</div>');
    this.wire = new Wire(el.querySelector('[data-wire]'));
    wireCtx(el);
    el.querySelectorAll('[data-cat]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.cat = b.getAttribute('data-cat'); state.sub = null;
        markStale(PlpView, self);
        self.show();
      });
    });
    el.querySelector('[data-sort]').addEventListener('change', function (e) {
      state.sort = e.target.value;
      markStale(PlpView, self);
      self.run();
    });
    el.querySelector('[data-more]').addEventListener('click', function () { self.page(self.pageNo + 1); });
    this.stale = false;
    this.run();
  };
  PlpView.prototype.run = function () {
    var self = this;
    this.excluded = [];
    (this.special ? this.picked() : Promise.resolve([])).then(function (ids) { self.excluded = ids; self.page(1); });
  };
  // Row 1: the personalized campaign, narrowed to the category and the store.
  // The store clause holds only where availability is filterable in the AI
  // engine configuration, so the row also keeps only items the store stocks.
  PlpView.prototype.picked = function () {
    var self = this, c = CAMPAIGN.personalized;
    var box = this.el.querySelector('[data-row]'), meta = this.el.querySelector('[data-pmeta]');
    box.style.opacity = '.4';
    return recommend(c, { filter: and(['category == ' + iqlStr(state.cat), state.storeFilter ? availClause() : '']) }, this.wire).then(function (r) {
      box.style.opacity = '';
      if (r.status !== 200) { box.innerHTML = errBox(r); meta.textContent = ''; return []; }
      var data = r.body.data || [], ex = r.body.extras || {};
      remember(data);
      var pick = (state.storeFilter ? data.filter(function (it) { return inStore(it) !== false; }) : data).slice(0, ROW);
      var ids = pick.map(function (x) { return x.itemId; });
      meta.textContent = c.label + ' · ' + catLabel(state.cat) + ' · ' + pick.length + ' of ' + data.length;
      box.innerHTML = cards(pick);
      if (ids.length) track('recommendationView', { campaignId: c.id, correlationId: ex.correlationId, items: ids }, self.wire);
      onCards(box, function (id) {
        track('recommendationClick', { campaignId: c.id, correlationId: ex.correlationId, item: id }, self.wire);
        offerReco(self.el, id);
      });
      return ids;
    });
  };
  // The listing. Page 1 also brings the subcategory facet; "show more"
  // fetches the next page with the same filters and correlationId.
  PlpView.prototype.page = function (n) {
    var self = this, el = this.el, grid = el.querySelector('[data-grid]');
    var f = and(['category == ' + iqlStr(state.cat), state.sub ? 'subcategory == ' + iqlStr(state.sub) : '', state.storeFilter ? availClause() : '',
      this.excluded.length ? 'NOT sku IN [' + this.excluded.map(iqlStr).join(', ') + ']' : '']);
    var params = [['limit', String(ROW * 3)], ['page', String(n)], ['includeMeta', 'true'], ['clientUUID', shopperUuid()], ['context', 'plp'], ['filters', f]];
    if (n === 1) params.push(['facets', 'subcategory'], ['caseSensitiveFacetValues', 'true']);
    else if (this.correlationId) params.push(['correlationId', this.correlationId]);
    params = params.concat(SORTS[state.sort].p || []);
    if (n === 1) grid.style.opacity = '.4';
    search('list', params, this.wire, function (b) { return hits(b) + ' items · page ' + n; }).then(function (r) {
      grid.style.opacity = '';
      if (r.status !== 200) { grid.innerHTML = errBox(r); return; }
      var b = r.body, ex = b.extras || {}, total = totalOf(b) || 0;
      // safety net: a filter IQL cannot parse is dropped silently, never an error
      var data = (b.data || []).filter(function (it) { return self.excluded.indexOf(it.itemId) < 0; });
      remember(data);
      self.pageNo = n;
      if (n === 1) {
        self.correlationId = ex.correlationId;
        self.total = total;
        self.paintHead(ex);
        grid.innerHTML = '';
      }
      var start = grid.querySelectorAll('.pcard').length;
      grid.insertAdjacentHTML('beforeend', data.map(function (it, i) { return card(it, start + i); }).join(''));
      if (!start && !data.length) grid.innerHTML = cards([]);
      if (n === 1) onCards(grid, click); else Array.prototype.slice.call(grid.querySelectorAll('.pcard'), start).forEach(function (c2) {
        c2.addEventListener('click', function () { click(c2.getAttribute('data-id'), +c2.getAttribute('data-pos')); });
      });
      var shown = grid.querySelectorAll('.pcard').length;
      el.querySelector('[data-more]').hidden = shown >= total;
      el.querySelector('[data-plpmeta]').innerHTML = '<b>' + Math.min(shown, total) + '</b> / ' + total +
        (self.excluded.length ? ' · <span class="excl">' + self.excluded.length + ' above, not repeated</span>' : '');
    });
    function click(id, pos) {
      track('itemSearchClick', { correlationId: self.correlationId, item: id, position: pos, searchType: 'listing' }, self.wire);
      offerReco(el, id);
    }
  };
  // Title row and subcategory chips. With a subcategory picked the facet only
  // lists that value, so the chips come from the last unpicked answer.
  PlpView.prototype.paintHead = function (ex) {
    var self = this, el = this.el;
    var ff = (ex.filteredFacets || {}).subcategory || {};
    if (!state.sub || !this.subs[state.cat]) this.subs[state.cat] = ff;
    var vals = this.subs[state.cat];
    // the page's count includes the row above when its items are in scope
    var shown = this.total + this.excluded.filter(function (id) { return !state.sub || (items[id] || {}).subcategory === state.sub; }).length;
    el.querySelector('[data-sum]').innerHTML = '<span class="n">' + esc(catLabel(state.cat)) + (state.sub ? ' › ' + esc(state.sub) : '') + '</span>' +
      '<span class="of">' + shown + ' ' + (state.storeFilter ? esc(t('inCat')) + ' <b>' + esc(storeLabel(state.store)) + '</b>' : esc(t('chain'))) + '</span>';
    el.querySelector('[data-subk]').textContent = catLabel(state.cat);
    var subs = el.querySelector('[data-subs]');
    subs.innerHTML = '<button type="button" class="chip' + (state.sub ? '' : ' is-on') + '" data-sub="">' + esc(t('allSubs')) + '</button>' +
      Object.keys(vals).sort(function (a, b) { return vals[b] - vals[a]; }).map(function (v) {
        return '<button type="button" class="chip' + (state.sub === v ? ' is-on' : '') + '" data-sub="' + esc(v) + '">' + esc(v) + '<i>' + vals[v] + '</i></button>';
      }).join('');
    subs.querySelectorAll('[data-sub]').forEach(function (ch) {
      ch.addEventListener('click', function () {
        var v = ch.getAttribute('data-sub') || null;
        if (state.sub === v) return;
        state.sub = v;
        markStale(PlpView, self);
        self.run();
      });
    });
  };

  // ===================================================== stores slide ====
  function StoresView(el) { this.el = el; this.stale = true; this.key = null; }
  StoresView.prototype.show = function () {
    var el = this.el, self = this;
    el.innerHTML = ctxBar({ noShopper: true, noFilter: true }) +
      '<div class="st-head"><h2 class="slide-h">One query, twenty shelves.</h2>' +
      '<span class="st-q"><input type="search" data-q value="' + esc(state.query[state.lang]) + '" spellcheck="false"><button type="button" class="btn" data-run>Run on every store</button></span></div>' +
      '<div class="bars" data-bars>' + STORES.map(function (s) {
        return '<button type="button" class="bar' + (s.id === state.store ? ' is-cur' : '') + '" data-store="' + s.id + '">' +
          '<span class="bar-l"><span>' + esc(s.name) + '</span><b data-n>·</b></span><span class="bar-t"><span class="bar-f" data-f></span></span></button>';
      }).join('') + '</div>' +
      '<div class="st-total" data-total></div>' +
      '<div class="reco-wire" data-wire><div class="wire-h"></div></div>';
    this.wire = new Wire(el.querySelector('[data-wire]'), true);
    wireCtx(el);
    var q = el.querySelector('[data-q]');
    q.addEventListener('input', function () { state.query[state.lang] = q.value; });
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); self.run(); } });
    el.querySelector('[data-run]').addEventListener('click', function () { self.run(); });
    el.querySelectorAll('.bar').forEach(function (b) {
      b.addEventListener('click', function () { setCtx('store', b.getAttribute('data-store')); });
    });
    this.stale = false;
    var key = state.lang + '|' + state.query[state.lang];
    if (this.key === key && this.last) this.paint(this.last); else this.run();
  };
  StoresView.prototype.run = function () {
    var self = this, el = this.el, query = state.query[state.lang] || '', uuid = shopperUuid();
    var btn = el.querySelector('[data-run]'); if (btn) btn.disabled = true;
    // The wire shows the first store's call in full and the chain-wide one;
    // the other nineteen differ only in the store id.
    function count(filter, quiet) {
      var params = [['query', query], ['limit', '1'], ['includeMeta', 'true'], ['clientUUID', uuid]];
      if (filter) params.push(['filters', filter]);
      return search('query', params, self.wire, quiet ? false : function (b) { return hits(b) + ' hits'; })
        .then(function (r) { return totalOf(r.body); });
    }
    var jobs = CFG.stores.map(function (s, i) { return count(availClause(s.id), i > 0); });
    jobs.push(count('', false));
    Promise.all(jobs).then(function (ns) {
      var res = { chain: ns.pop(), per: {} };
      CFG.stores.forEach(function (s, i) { res.per[s.id] = ns[i]; });
      self.wire.push(h('<div class="wire-entry"><span class="wire-m">×19</span> the same call for every other store · in parallel</div>'));
      self.key = state.lang + '|' + query; self.last = res;
      if (btn) btn.disabled = false;
      self.paint(res);
    });
  };
  StoresView.prototype.paint = function (res) {
    var el = this.el, max = Math.max(1, res.chain || 0), vals = [];
    // Largest shelf first, so the chart reads as a ranking.
    var box = el.querySelector('[data-bars]');
    Array.prototype.slice.call(box.children).sort(function (a, b) {
      return (res.per[b.getAttribute('data-store')] || 0) - (res.per[a.getAttribute('data-store')] || 0);
    }).forEach(function (n) { box.appendChild(n); });
    el.querySelectorAll('.bar').forEach(function (b) {
      var n = res.per[b.getAttribute('data-store')];
      vals.push(n || 0);
      b.querySelector('[data-n]').textContent = n == null ? '–' : n;
      b.classList.toggle('bar-zero', n === 0);
      var f = b.querySelector('[data-f]');
      requestAnimationFrame(function () { f.style.width = (n ? Math.max(2, 100 * n / max) : 0) + '%'; });
    });
    var dash = function (n) { return n == null ? '–' : n; };
    el.querySelector('[data-total]').innerHTML =
      '<span>Chain-wide <b>' + dash(res.chain) + '</b></span>' +
      '<span>Smallest shelf <b>' + Math.min.apply(null, vals) + '</b></span><span>Largest shelf <b>' + Math.max.apply(null, vals) + '</b></span>' +
      '<span>In ' + esc(storeLabel(state.store)) + ' <b>' + dash(res.per[state.store]) + '</b></span>';
  };

  // ======================================================= reco slide ====
  function RecoView(el) { this.el = el; this.stale = true; }
  RecoView.prototype.show = function () {
    var el = this.el;
    el.innerHTML = ctxBar() +
      '<div class="reco"><div class="reco-l"><div class="visited" data-pdp></div>' +
      '<div class="reco-wire" data-wire><div class="wire-h"><span>Wire</span><span>tracker key</span></div></div></div>' +
      '<div class="rails">' +
      CFG.campaigns.map(function (c) {
        return '<div class="rail" data-rail="' + c.key + '"><div class="rail-h"><b>' + esc(c.label) + '</b><span class="rail-ctx" data-ctxname></span><span class="rail-meta" data-meta></span><span class="rail-score" data-score></span></div><div class="rail-items" data-items></div></div>';
      }).join('') + '</div></div>';
    this.wire = new Wire(el.querySelector('[data-wire]'), true);
    wireCtx(el);
    this.stale = false;
    this.paintPdp();
    this.run();
  };
  // The product the shopper is on: a small box, so the wire below gets the
  // column's height. Its name also labels the rails that depend on it.
  RecoView.prototype.paintPdp = function () {
    var el = this.el, it = items[state.item] || { itemId: state.item };
    el.querySelector('[data-pdp]').innerHTML = '<span class="visited-k">' + esc(t('visited')) + '</span>' +
      '<div class="visited-row">' + tile(it) + '<div class="visited-t"><b>' + esc(nameOf(it)) + '</b>' +
      '<span>' + esc(it.brand || '') + (it.price ? ' · ' + eur(it.price) : '') + '</span>' +
      '<code>' + esc(state.item) + '</code></div></div>';
    CFG.campaigns.forEach(function (c) {
      var n = el.querySelector('[data-rail="' + c.key + '"] [data-ctxname]');
      if (n) n.textContent = c.needsItem ? (c.key === 'similar' ? 'to ' : 'with ') + nameOf(it) : '';
    });
  };
  RecoView.prototype.setItem = function (id) {
    state.item = id;
    this.paintPdp();
    this.run();
  };
  RecoView.prototype.run = function () {
    var self = this, el = this.el;
    CFG.campaigns.forEach(function (c, ci) {
      var rail = el.querySelector('[data-rail="' + c.key + '"]'), box = rail.querySelector('[data-items]');
      var meta = rail.querySelector('[data-meta]'), sc = rail.querySelector('[data-score]');
      box.style.opacity = '.4';
      recommend(c, { filter: state.storeFilter ? availClause() : '', contextItems: ci === 0 }, self.wire).then(function (r) {
        box.style.opacity = '';
        if (r.status !== 200) { box.innerHTML = errBox(r); meta.textContent = ''; sc.textContent = ''; return; }
        var data = r.body.data || [], ex = r.body.extras || {};
        remember(data);
        if (ex.contextItems) { remember(ex.contextItems); self.paintPdp(); }
        meta.textContent = r.ms + ' ms';
        // n / N in store only for a store-scoped request; unfiltered, the
        // rail is chain-wide and a store score would mean nothing.
        var inN = data.filter(inStore).length;
        sc.textContent = state.storeFilter ? inN + ' / ' + data.length + ' ' + t('inS') + ' · ' + storeLabel(state.store) : '';
        sc.className = 'rail-score ' + (inN === data.length ? 'all' : 'some');
        box.innerHTML = cards(data);
        if (data.length) track('recommendationView', { campaignId: c.id, correlationId: ex.correlationId, items: data.map(function (x) { return x.itemId; }) }, self.wire);
        onCards(box, function (id) {
          track('recommendationClick', { campaignId: c.id, correlationId: ex.correlationId, item: id }, self.wire);
          self.setItem(id);
        });
      });
    });
  };

  // ======================================================== SDK panel ====
  function SdkView(el) { this.el = el; this.stale = true; }
  SdkView.prototype.show = function () {
    var st = { loading: ['loading…', ''], ready: ['loaded · SR.init done', 'ok'], 'no-uuid': ['loaded · no UUID yet', 'bad'], blocked: ['not loaded (blocked or offline)', 'bad'] }[sdk.state];
    this.el.innerHTML = '<div class="sdk">' +
      '<div class="sdk-row"><span>Synerise SDK</span><b class="' + st[1] + '">' + esc(st[0]) + '</b></div>' +
      '<div class="sdk-row"><span>Tracker key</span><code>' + esc(TK) + '</code></div>' +
      '<div class="sdk-row"><span>Profile UUID</span><code>' + esc(sdk.uuid || ('— (fallback ' + fallbackUuid.slice(0, 8) + '…)')) + '</code></div>' +
      '<div class="sdk-row"><span>Events sent</span><b>' + sdk.events + '</b></div>' +
      '<pre>&lt;script&gt;\n  function onSyneriseLoad() {\n    SR.init({ trackerKey: "<mark>' + short(TK) + '</mark>" });\n  }\n  …web.snrbox.com/synerise-javascript-sdk.min.js\n&lt;/script&gt;</pre>' +
      '</div>';
    this.stale = false;
  };
  function refreshSdkViews() { views.forEach(function (v) { if (v instanceof SdkView) v.show(); }); }

  // ------------------------------------------------------------- boot --
  var MAKE = {
    search: function (el) { return new SearchView(el); },
    plp: function (el) { return new PlpView(el, false); },
    'plp-special': function (el) { return new PlpView(el, true); },
    stores: function (el) { return new StoresView(el); },
    reco: function (el) { return new RecoView(el); },
    sdk: function (el) { return new SdkView(el); },
  };
  document.querySelectorAll('[data-live]').forEach(function (el) {
    var make = MAKE[el.getAttribute('data-live')];
    if (make) views.push(make(el));
  });
  // A live slide renders when it comes on, and only re-runs its calls when
  // the shared context changed since it last ran.
  window.addEventListener('deck:slide', function (e) {
    views.forEach(function (v) { if (e.detail.el.contains(v.el) && v.stale) v.show(); });
  });
  refreshSdkViews();
  var active = document.querySelector('.slide.active');
  if (active) views.forEach(function (v) { if (active.contains(v.el)) v.show(); });
  setBadge(badgeState);
})();
