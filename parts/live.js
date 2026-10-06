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
  var LANG = {};
  CFG.languages.forEach(function (l) { LANG[l.code] = l; });
  var STORE = {};
  CFG.stores.forEach(function (s) { STORE[s.id] = s; });
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
    query: {},               // per language, so switching back restores it
    facet: { brand: null, price: null },
    item: CFG.defaults.item,
  };
  CFG.languages.forEach(function (l) { state.query[l.code] = l.query; });
  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ store: state.store, lang: state.lang, shopper: state.shopper })); } catch (e) { /* private mode */ }
  }

  var items = {};            // itemId → last seen attributes (search or reco)
  function remember(list) { (list || []).forEach(function (it) { if (it && it.itemId) items[it.itemId] = Object.assign({}, items[it.itemId], it); }); }

  // ------------------------------------------------------------ helpers --
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function h(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
  var UI = {
    en: { ph: 'Search Havenmart', res: 'results in', chain: 'across the chain', none: 'Nothing on this shelf.', dym: 'Did you mean', showing: 'Showing results for', inS: 'in store', outS: 'not here', brand: 'Brand', price: 'Price', toReco: 'Recommendations for', all: 'All stores', visited: 'Visited product', locale: 'en-IE' },
    es: { ph: 'Buscar en Havenmart', res: 'resultados en', chain: 'en toda la cadena', none: 'Nada en este estante.', dym: '¿Quisiste decir', showing: 'Resultados de', inS: 'en tienda', outS: 'no está', brand: 'Marca', price: 'Precio', toReco: 'Recomendaciones para', all: 'Todas las tiendas', visited: 'Producto visitado', locale: 'es-ES' },
    fr: { ph: 'Rechercher sur Havenmart', res: 'résultats à', chain: "dans toute l'enseigne", none: 'Rien dans ce rayon.', dym: 'Vouliez-vous dire', showing: 'Résultats pour', inS: 'en magasin', outS: 'absent', brand: 'Marque', price: 'Prix', toReco: 'Recommandations pour', all: 'Tous les magasins', visited: 'Produit visité', locale: 'fr-FR' },
  };
  function t(k) { return (UI[state.lang] || UI.en)[k]; }
  function price(p) {
    var n = parseFloat(p);
    if (isNaN(n)) return '';
    try { return new Intl.NumberFormat(t('locale'), { style: 'currency', currency: 'EUR' }).format(n); } catch (e) { return '€' + n.toFixed(2); }
  }
  // Price facet: a range facet returns only {min, max} for the result set, so
  // the slider's ends come from that and the picked range becomes the filter
  // price >= lo AND price <= hi. Ends are rounded out to whole euros.
  function priceIql(p) { return 'price >= ' + p.lo + ' AND price <= ' + p.hi; }
  function money(n) {
    try { return new Intl.NumberFormat(t('locale'), { style: 'currency', currency: 'EUR', maximumFractionDigits: n % 1 ? 2 : 0 }).format(n); } catch (e) { return '€' + n; }
  }
  function nameOf(it) { return it['name_' + state.lang] || it.name_en || it.name || it.itemId; }
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
  function storeLabel(id) { var s = STORE[id]; return s ? s.name : id; }
  function availClause() { return 'availability == "' + state.store + '"'; }
  function short(k) { return k.slice(0, 4) + '…' + k.slice(-4); }

  // ---------------------------------------------------------------- SDK --
  // The tracking code in <head> loads the SDK and calls SR.init with the
  // tracker key; onSyneriseLoad then fires 'synerise:ready'. The SDK assigns
  // this browser an anonymous profile UUID, which is what search and
  // recommendations get as clientUUID when the shopper is "this browser".
  var sdk = { state: 'loading', uuid: null, events: 0 };
  var fallbackUuid = (function () {
    try {
      var u = localStorage.getItem(LS_KEY + ':uuid');
      if (!u) { u = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())); localStorage.setItem(LS_KEY + ':uuid', u); }
      return u;
    } catch (e) { return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()); }
  })();
  function readSdkUuid() {
    try { if (window.SR && SR.client && typeof SR.client.getUuid === 'function') { var u = SR.client.getUuid(); if (u) return u; } } catch (e) { /* not ready */ }
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

  function shopperUuid() {
    if (state.shopper === 'sdk') return sdk.uuid || fallbackUuid;
    return state.shopper;
  }
  function shopperIsBrowser() { return state.shopper === 'sdk'; }

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
  // The right-hand console: every request with its parameters, the status,
  // the time, a one-line summary; SDK events in another colour.
  var HL = { filters: 1, additionalFilters: 1, displayAttribute: 1, clientUUID: 1, itemId: 1, query: 1 };
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
      return 'campaigns/<mark>' + id + '</mark>' + (c ? ' <span style="color:var(--grey-500)">(' + esc(c.label) + ')</span>' : '');
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
        }).join('') + '<div class="wire-p">token=<b>' + short(TK) + '</b> <span style="opacity:.6">tracker key</span></div>' +
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
  function wireCtx(root, onChange) {
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
    views.forEach(function (v2) { v2.stale = true; });
    var active = document.querySelector('.slide.active');
    views.forEach(function (v2) { if (active && active.contains(v2.el)) v2.show(); });
    refreshSdkViews();
  }

  // ===================================================== search slide ====
  function SearchView(el) {
    this.el = el; this.stale = true; this.acTimer = null;
    this.lastFacets = { brand: {} };
  }
  SearchView.prototype.show = function () {
    var el = this.el, self = this;
    el.innerHTML = ctxBar() +
      '<div class="shop-wire">' +
        '<div class="shop">' +
          '<div class="shop-top">' +
            '<div class="shop-brand">haven<span>mart</span></div>' +
            '<div class="shop-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' +
              '<input type="search" data-q autocomplete="off" spellcheck="false" placeholder="' + esc(t('ph')) + '" value="' + esc(state.query[state.lang]) + '">' +
              '<div class="ac" data-ac></div></div>' +
            '<div class="shop-store"><b>' + esc(state.storeFilter ? storeLabel(state.store) : t('all')) + '</b>' + esc(LANG[state.lang].label) + '</div>' +
          '</div>' +
          '<div class="shop-sum" data-sum></div>' +
          '<div class="facets" data-facets></div>' +
          '<div class="grid-p" data-grid></div>' +
        '</div>' +
        '<div class="wire" data-wire><div class="wire-h"><span>Wire · browser → api.synerise.com</span><span>tracker key</span></div></div>' +
      '</div>';
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
  SearchView.prototype.filters = function (skip) {
    var parts = [];
    if (state.storeFilter) parts.push(availClause());
    if (state.facet.brand && skip !== 'brand') parts.push('brand == "' + state.facet.brand.replace(/"/g, '\\"') + '"');
    if (state.facet.price && skip !== 'price') parts.push(priceIql(state.facet.price));
    return parts.join(' AND ');
  };
  SearchView.prototype.autocomplete = function (text) {
    var self = this, ac = this.el.querySelector('[data-ac]');
    if (!text || text.length < 2) { this.closeAc(); return; }
    var params = [['query', text], ['limit', '5'], ['clientUUID', shopperUuid()]];
    var f = state.storeFilter ? availClause() : '';
    if (f) params.push(['filters', f]);
    call('/search/v2/indices/' + LANG[state.lang].index + '/autocomplete', params, this.wire, {
      summary: function (b) { return (b.data || []).length + ' items'; },
    }).then(function (r) {
      if (self.el.querySelector('[data-q]').value !== text) return;
      var data = (r.body && r.body.data) || [];
      remember(data);
      if (!data.length) { self.closeAc(); return; }
      ac.innerHTML = data.map(function (it) {
        return '<div class="ac-item" data-id="' + esc(it.itemId) + '">' + tile(it) + '<span>' + esc(nameOf(it)) + '</span><em>' + price(it.price) + '</em></div>';
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
    var idx = LANG[state.lang].index;
    var params = [['query', query], ['limit', '8'], ['includeMeta', 'true'], ['clientUUID', shopperUuid()],
      ['facets', 'brand'], ['includeFacets', 'filtered'], ['caseSensitiveFacetValues', 'true'], ['maxValuesPerFacet', '6']];
    var f = this.filters();
    if (f) params.push(['filters', f]);
    var main = call('/search/v2/indices/' + idx + '/query', params, this.wire, {
      summary: function (b, s) { return s === 200 ? (b.meta ? b.meta.totalCount : '?') + ' hits' : (b.message || b.error || ''); },
    });
    // The same query without the store clause: how much of the chain's
    // answer this store actually has.
    var cparams = [['query', query], ['limit', '1'], ['includeMeta', 'true'], ['clientUUID', shopperUuid()]];
    var cf = this.filters();
    cf = cf.replace(availClause() + ' AND ', '').replace(availClause(), '');
    if (cf) cparams.push(['filters', cf]);
    var chain = call('/search/v2/indices/' + idx + '/query', cparams, this.wire, {
      summary: function (b) { return (b.meta ? b.meta.totalCount : '?') + ' hits chain-wide'; },
    });
    // The slider's ends: the price facet's {min, max} under every filter
    // except the price one, so moving the slider never shrinks its own scale.
    var bparams = [['query', query], ['limit', '1'], ['clientUUID', shopperUuid()], ['facets', 'price'], ['includeFacets', 'filtered']];
    var bbase = this.filters('price');
    if (bbase) bparams.push(['filters', bbase]);
    var bounds = call('/search/v2/indices/' + idx + '/query', bparams, this.wire, {
      summary: function (b) {
        var pf = b.extras && b.extras.filteredFacets && b.extras.filteredFacets.price;
        return pf ? 'price facet ' + JSON.stringify(pf) : 'no price facet';
      },
    }).then(function (res) {
      var pf = res.body && res.body.extras && res.body.extras.filteredFacets && res.body.extras.filteredFacets.price;
      return pf && pf.min != null ? { min: Math.floor(pf.min), max: Math.ceil(pf.max) } : null;
    });
    Promise.all([main, chain, bounds]).then(function (rs) {
      var r = rs[0], c = rs[1], pb = rs[2];
      var grid = el.querySelector('[data-grid]'), sum = el.querySelector('[data-sum]'), fac = el.querySelector('[data-facets]');
      if (!grid) return;
      if (r.status !== 200) {
        grid.innerHTML = '<div class="err-box">' + esc(r.status + ' ' + JSON.stringify(r.body).slice(0, 300)) + '</div>';
        sum.innerHTML = ''; fac.innerHTML = '';
        return;
      }
      var b = r.body, data = b.data || [], ex = b.extras || {};
      remember(data);
      self.correlationId = ex.correlationId;
      var total = b.meta ? b.meta.totalCount : data.length;
      var ctotal = c.body && c.body.meta ? c.body.meta.totalCount : null;
      var html = state.storeFilter
        ? '<span class="n">' + total + '</span><span class="of">' + esc(t('res')) + ' <b>' + esc(storeLabel(state.store)) + '</b>' +
          (ctotal != null ? ' · ' + ctotal + ' ' + esc(t('chain')) : '') + '</span>'
        : '<span class="n">' + total + '</span><span class="of">' + esc(t('chain')) + '</span>';
      // usedSuggestion is {text, highlighted, score}, like the entries of suggestions[]
      var used = ex.usedSuggestion && (typeof ex.usedSuggestion === 'object' ? ex.usedSuggestion.text : ex.usedSuggestion);
      if (used) html += '<span class="sugg">· ' + esc(t('showing')) + ' <b>' + esc(used) + '</b></span>';
      else if (!data.length && ex.suggestions && ex.suggestions.length) {
        html += '<span class="sugg">· ' + esc(t('dym')) + ' <b data-sugg="' + esc(ex.suggestions[0].text) + '" style="cursor:pointer;text-decoration:underline">' + esc(ex.suggestions[0].text) + '</b>?</span>';
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
          return '<button type="button" class="chip' + (state.facet.brand === v ? ' is-on' : '') + '" data-fk="brand" data-fv="' + esc(v) + '">' + esc(v) + (bvals[v] != null ? '<i>' + bvals[v] + '</i>' : '') + '</button>';
        }).join('') + '</div></div>' : '') +
        (pb && pb.max > pb.min ? '<div class="facet-row"><span class="facet-k">' + esc(t('price')) + '</span><div class="facet-v"><span class="pslider" data-pslider></span></div></div>' : '');
      fac.querySelectorAll('.chip').forEach(function (ch) {
        ch.addEventListener('click', function () {
          var k = ch.getAttribute('data-fk'), v = ch.getAttribute('data-fv');
          state.facet[k] = state.facet[k] === v ? null : v;
          self.run();
        });
      });
      var ps = fac.querySelector('[data-pslider]');
      if (ps) self.priceSlider(ps, pb);

      grid.innerHTML = data.length ? data.map(function (it, i) {
        return '<button type="button" class="pcard is-new" style="animation-delay:' + (i * 35) + 'ms" data-id="' + esc(it.itemId) + '" data-pos="' + (i + 1) + '">' +
          tile(it) + stockBadge(it) + '<span class="pname">' + esc(nameOf(it)) + '</span>' +
          '<span class="pmeta"><span class="pbrand">' + esc(it.brand || '') + '</span><span class="pprice">' + price(it.price) + '</span></span></button>';
      }).join('') : '<div class="empty">' + esc(t('none')) + '</div>';
      grid.querySelectorAll('.pcard').forEach(function (n) {
        n.addEventListener('click', function () {
          self.open(n.getAttribute('data-id'), +n.getAttribute('data-pos'), self.correlationId, 'full-text-search');
        });
      });
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
      val.textContent = money(x) + ' – ' + money(y);
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

  // Clicking a product: the search click goes to Synerise through the SDK,
  // the product becomes the context of the recommendations slide, and the
  // summary row offers the jump.
  SearchView.prototype.open = function (id, pos, correlationId, searchType) {
    this.closeAc();
    track('itemSearchClick', { correlationId: correlationId, item: id, position: pos, searchType: searchType }, this.wire);
    state.item = id;
    views.forEach(function (v) { if (v instanceof RecoView) v.stale = true; });
    var sum = this.el.querySelector('[data-sum]');
    var it = items[id] || { itemId: id };
    var old = sum.querySelector('[data-go]'); if (old) old.remove();
    var go = h('<button type="button" class="btn btn-accent" data-go style="margin-left:auto">' + esc(t('toReco')) + ' ' + esc(nameOf(it)).slice(0, 40) + ' →</button>');
    go.addEventListener('click', function () {
      var reco = document.querySelector('[data-live="reco"]');
      if (reco) window.deckJumpTo(window.deckSlideOf(reco));
    });
    sum.appendChild(go);
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
    var self = this, el = this.el, query = state.query[state.lang] || '';
    var idx = LANG[state.lang].index, uuid = shopperUuid();
    var btn = el.querySelector('[data-run]'); if (btn) btn.disabled = true;
    function count(filter, quiet) {
      var params = [['query', query], ['limit', '1'], ['includeMeta', 'true'], ['clientUUID', uuid]];
      if (filter) params.push(['filters', filter]);
      return call('/search/v2/indices/' + idx + '/query', params, self.wire, {
        quiet: quiet, summary: function (b) { return (b.meta ? b.meta.totalCount : '?') + ' hits'; },
      }).then(function (r) { return r.body && r.body.meta ? r.body.meta.totalCount : null; });
    }
    // The wire shows the first store's call in full and the chain-wide one;
    // the other nineteen differ only in the store id.
    var jobs = CFG.stores.map(function (s, i) { return count('availability == "' + s.id + '"', i > 0); });
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
    var el = this.el, max = Math.max(1, res.chain || 0);
    var vals = [];
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
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    el.querySelector('[data-total]').innerHTML =
      '<span>Chain-wide <b>' + (res.chain == null ? '–' : res.chain) + '</b></span>' +
      '<span>Smallest shelf <b>' + lo + '</b></span><span>Largest shelf <b>' + hi + '</b></span>' +
      '<span>In ' + esc(storeLabel(state.store)) + ' <b>' + (res.per[state.store] == null ? '–' : res.per[state.store]) + '</b></span>';
  };

  // ======================================================= reco slide ====
  function RecoView(el) { this.el = el; this.stale = true; }
  RecoView.prototype.show = function () {
    var el = this.el, self = this;
    el.innerHTML = ctxBar() +
      '<div class="reco"><div class="reco-l"><div class="visited" data-pdp></div>' +
      '<div class="reco-wire" data-wire><div class="wire-h"><span>Wire</span><span>tracker key</span></div></div></div>' +
      '<div class="rails" data-rails>' +
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
    var box = this.el.querySelector('[data-pdp]'), el = this.el;
    var it = items[state.item] || { itemId: state.item };
    box.innerHTML = '<span class="visited-k">' + esc(t('visited')) + '</span>' +
      '<div class="visited-row">' + tile(it) + '<div class="visited-t"><b>' + esc(nameOf(it)) + '</b>' +
      '<span>' + esc(it.brand || '') + (it.price ? ' · ' + price(it.price) : '') + '</span>' +
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
      var rail = el.querySelector('[data-rail="' + c.key + '"]');
      var params = [['clientUUID', shopperUuid()]];
      if (c.needsItem) params.push(['itemId', state.item]);
      params.push(['displayAttribute', 'name_' + state.lang]);
      params.push(['displayAttribute', 'imageUrl']);
      if (state.storeFilter) { params.push(['additionalFilters', availClause()]); params.push(['filtersJoiner', 'AND']); }
      if (ci === 0) params.push(['includeContextItems', 'true']);
      rail.querySelector('[data-items]').style.opacity = '.4';
      call('/recommendations/v2/recommend/campaigns/' + c.id, params, self.wire, {
        summary: function (b, s) { return s === 200 ? (b.data || []).length + ' items' : (b.errorCode || '') + ' ' + (b.message || ''); },
      }).then(function (r) {
        var box = rail.querySelector('[data-items]');
        box.style.opacity = '';
        if (r.status !== 200) {
          box.innerHTML = '<div class="err-box" style="grid-column:1/-1">' + esc((r.body.errorCode || r.status) + ' · ' + (r.body.message || r.body.error || '')) + '</div>';
          rail.querySelector('[data-meta]').textContent = '';
          rail.querySelector('[data-score]').textContent = '';
          return;
        }
        var data = r.body.data || [], ex = r.body.extras || {};
        remember(data);
        if (ex.contextItems) { remember(ex.contextItems); self.paintPdp(); }
        var inN = data.filter(function (it) { return inStore(it); }).length;
        rail.querySelector('[data-meta]').textContent = r.ms + ' ms';
        // n / N in store only for a store-scoped request; unfiltered, the
        // rail is chain-wide and a store score would mean nothing.
        var sc = rail.querySelector('[data-score]');
        sc.textContent = state.storeFilter ? inN + ' / ' + data.length + ' ' + t('inS') + ' · ' + storeLabel(state.store) : '';
        sc.className = 'rail-score ' + (inN === data.length ? 'all' : 'some');
        box.innerHTML = data.map(function (it, i) {
          return '<button type="button" class="pcard is-new" style="animation-delay:' + (i * 30) + 'ms" data-id="' + esc(it.itemId) + '">' + tile(it) + stockBadge(it) +
            '<span class="pname">' + esc(nameOf(it)) + '</span><span class="pmeta"><span class="pbrand">' + esc(it.brand || '') + '</span><span class="pprice">' + price(it.price) + '</span></span></button>';
        }).join('') || '<div class="empty">' + esc(t('none')) + '</div>';
        if (data.length) track('recommendationView', { campaignId: c.id, correlationId: ex.correlationId, items: data.map(function (x) { return x.itemId; }) }, self.wire);
        box.querySelectorAll('.pcard').forEach(function (n) {
          n.addEventListener('click', function () {
            track('recommendationClick', { campaignId: c.id, correlationId: ex.correlationId, item: n.getAttribute('data-id') }, self.wire);
            self.setItem(n.getAttribute('data-id'));
          });
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
  var views = [];
  var KINDS = { search: SearchView, stores: StoresView, reco: RecoView, sdk: SdkView };
  document.querySelectorAll('[data-live]').forEach(function (el) {
    var K = KINDS[el.getAttribute('data-live')];
    if (K) views.push(new K(el));
  });
  // A live slide renders when it comes on, and only re-runs its calls when
  // the shared context changed since it last ran.
  window.addEventListener('deck:slide', function (e) {
    views.forEach(function (v) { if (e.detail.el.contains(v.el) && v.stale) v.show(); });
  });
  views.forEach(function (v) { if (v instanceof SdkView) v.show(); });
  var active = document.querySelector('.slide.active');
  if (active) views.forEach(function (v) { if (active.contains(v.el)) v.show(); });
  setBadge(badgeState);
})();
