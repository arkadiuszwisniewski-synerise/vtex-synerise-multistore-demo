# VTEX × Synerise — one catalog, every store, every language

A live demo deck for a multi-store, multi-language retailer on VTEX: how
brand-country, language and per-store availability land in one Synerise item
feed, and then search and recommendations running on it **from the browser,
with the tracker key and the Synerise JS SDK embedded in the deck**. No backend,
no API key: the deck behaves the way a storefront would.

The data is **Havenmart**, a fictional EU hypermarket chain in a Synerise demo
workspace: 1,000 SKUs, 20 stores, names and descriptions in EN / ES / FR.

## Run it

```bash
python3 build.py
python3 -m http.server 4300 --bind 127.0.0.1 --directory dist
```

Then open <http://127.0.0.1:4300/deck.html>. `dist/deck.html` is committed, so
building is only needed after an edit. Serve it over http rather than opening
the file: the SDK keeps the visitor's UUID in a cookie, and `file://` has none
(the API calls themselves work from `file://` too; CORS answers `Origin: null`).

`build.py` takes the presentation-builder template (`template.html`, never
edited), drops `parts/slides.html` into it, injects `parts/live.css`,
`parts/deck.js` and `parts/live.js`, inlines `demo.config.json`, adds the
Synerise tracking code to `<head>`, and strips the template's PDF export (half
of this deck is a live application).

## The deck

| # | slide | live? |
|---|---|---|
| 01 | One catalog. Every store, every language. | |
| 02 | Every request carries three answers: brand-country → workspace, language → suffixed attributes, store → availability | |
| 03 | Availability options A / B / C, working direction B → C | |
| 04 | One item, three kinds of attribute (a real catalog row) | |
| 05 | Search: language picks the index, store becomes a filter | |
| 06 | Recommendations: one campaign per model, `displayAttribute` + `additionalFilters` | |
| 07 | The storefront calls Synerise directly | SDK status, UUID, event count |
| 08 | Demo data: 1,000 SKUs, 20 stores, 3 languages | |
| 09 | **Search**: storefront + wire | **live** |
| 10 | **One query, twenty shelves**: result count per store | **live** |
| 11 | **Recommendations**: visited product + 3 rails | **live** |

**Shared context bar** on every live slide: store (one flat list of the 20),
language (EN / ES / FR → one search index each), shopper (this browser's SDK
profile, or one of five demo personas) and a store-filter toggle. Change it on
one slide and the others follow; the choice is remembered in `localStorage`.

**Live calls** (all `GET`, tracker key as `token=`):

- **search**: `/search/v2/indices/{index_lang}/query` with
  `filters=availability == "{store}"`, the brand facet and `includeMeta=true`.
  A second call without the store clause gives the chain-wide count. Price is a
  two-handle slider: its ends are the price facet's `{min, max}` from a
  `limit=1` call with every filter except price (a range facet returns only
  those bounds), and letting go adds `price >= lo AND price <= hi`. Typing
  calls `/autocomplete`.
- **stores**: the same query for each of the 20 stores plus chain-wide,
  `limit=1`, read from `meta.totalCount`.
- **recommendations**: `/recommendations/v2/recommend/campaigns/{id}` with
  `clientUUID`, `itemId`, `displayAttribute=name_{lang}`,
  `displayAttribute=imageUrl` and
  `additionalFilters=availability == "{store}"&filtersJoiner=AND`.
- With the store filter on, every card shows whether it is stocked in the
  selected store and each rail scores "n / 8 in store", so the audience sees
  whether the filter holds. With it off, the request is chain-wide and neither
  is shown.

**Images**: every card shows the SKU's packshot from the feed's `imageUrl`
(rendered in code for the fictional brands), with a coloured tile behind it as
the fallback.

**SDK events**: a product click on search sends `item.search.click`; each rail
sends `recommendation.view`; a card click sends `recommendation.click`. They
are sent only when the shopper is "this browser": with a persona selected they
would land on the wrong profile, and the wire says "skipped".

**Network loss**: every successful response is remembered per URL; if the
network drops, the last real answer is replayed and the badge turns yellow.

## Configuration

Everything workspace-specific is in `demo.config.json`: the tracker key (the
public key from the tracking code, meant to sit in a web page), the three
index ids, the three recommendation campaign ids, the stores and the persona
UUIDs. To point the deck at another workspace, change those and rebuild.

`SR.init` gets `disableDynamicContent: true`, so the workspace's own Dynamic
Content layers don't pop up over the slides.

## Known limits (2026-10-06)

1. Recommendation filters apply only to attributes marked filterable in the AI
   engine configuration; until `availability` is one, the store clause on the
   recommendation calls is ignored (the search side filters correctly).
2. The similar-items model on this demo data returns weakly related products.
