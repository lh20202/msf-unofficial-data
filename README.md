# Country Pulse

A static, public-only humanitarian analysis interface comparing Sudan and Haiti.

Country Pulse turns public humanitarian data into simple, evidence-led comparisons: what changed, where, compared with what, and why that matters.

The public page is an insight interface, not a source catalogue. It gives the user one central question panel and a concise answer supported by a few calculated insight cards.

The browser loads only:

- `data/countries.json`
- `data/sources.json`

There is no backend, no browser-side public API call, no model call, and no exposed local service.

## Architecture

The workflow is:

1. Fetch public source data at build time.
2. Calculate counts, changes, coverage, gaps, and confidence labels.
3. Generate deterministic editorial insights from those values.
4. Render the browser experience from local JSON files only.

The current build shows only values that can be calculated from public data. Where a category does not produce a comparable value, the main interface hides it or describes the limitation in plain language.

Current build-time connector set:

- GDELT DOC API for article-count movement
- ReliefWeb API for report-volume movement where an approved app name permits access
- OCHA FTS / HPC and FTS datasets for funding coverage where comparable values are available
- HDX data search for humanitarian dataset coverage
- WFP/HDX food-price and market data for market and commodity coverage

Priority structured feeds for future expansion:

- HDX HAPI
- OCHA FTS requirement and plan coverage endpoints
- IPC food insecurity
- IOM DTM and UNHCR displacement data
- WHO GHO, cholera, and outbreak data
- GDACS disaster alerts
- World Bank Climate Change Knowledge Portal
- WFP VAM and FEWS NET market data

## Files

- `index.html` renders the static dashboard.
- `data/countries.json` contains country metrics, comparisons, insights, and method groups.
- `data/sources.json` contains grouped method notes for the collapsed Data & method section.
- `scripts/build-country-pulse.js` fetches public feeds at build time and writes the static data model.
- `scripts/validate-content.js` validates the public static data.

## Validation

```sh
node scripts/build-country-pulse.js
node scripts/validate-content.js
```

## Preview

Because `index.html` loads JSON with `fetch()`, preview through a local static file server:

```sh
python3 -m http.server 8000
```

## Safety Rules

- Use public source URLs only.
- Keep private notes, local paths, usernames, API keys, prompts, raw responses, and debug logs out of public data.
- Do not make browser code call live APIs.
- Do not make browser code call model services.
- Do not add a backend.
- Do not present public mentions as partner recommendations or operational priorities.
