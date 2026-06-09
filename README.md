# Unofficial MSF Public Data Explorer

Static browser interface for exploring public MSF-related records from open sources. This is not an MSF website and does not represent an official MSF publication database.

## Build publication index

Run the build script locally:

```sh
node scripts/build-publications.js
```

The script fetches public metadata from open sources, normalises and deduplicates records, and updates:

- `data/msf-publications.json`
- `data/msf-publications-manifest.json`

Commit the updated JSON files with the site. Static hosts such as Render then serve the prepared publication index as static data, and the browser loads it with `fetch()`.

ReliefWeb harvesting is skipped unless `RELIEFWEB_APPNAME` is set in the local environment. Do not commit private app names or credentials.
