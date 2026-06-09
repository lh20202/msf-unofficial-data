#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const PUBLICATIONS_FILE = path.join(DATA_DIR, "msf-publications.json");
const MANIFEST_FILE = path.join(DATA_DIR, "msf-publications-manifest.json");

const now = new Date();
const fetchedAt = now.toISOString();
const yearTo = now.getFullYear();
const yearFrom = yearTo - 10;

const OPENALEX_QUERIES = [
  "Médecins Sans Frontières",
  "Doctors Without Borders",
  "MSF",
  "Epicentre"
];

const CROSSREF_QUERIES = [
  "Médecins Sans Frontières",
  "Doctors Without Borders",
  "Epicentre"
];

const MAX_OPENALEX_RECORDS = 2000;
const MAX_CROSSREF_RECORDS = 1000;
const OPENALEX_PAGE_SIZE = 100;
const CROSSREF_ROWS = 100;
const REQUEST_DELAY_MS = 250;

const manifest = {
  generatedAt: fetchedAt,
  yearFrom,
  yearTo,
  totalRecords: 0,
  recordsBySource: {},
  queriesUsed: {
    OpenAlex: OPENALEX_QUERIES,
    Crossref: CROSSREF_QUERIES,
    ReliefWeb: process.env.RELIEFWEB_APPNAME ? OPENALEX_QUERIES : []
  },
  sourcesAttempted: [
    "OpenAlex",
    "Crossref",
    "MSF Science Portal",
    "MSF.org Resource Centre / reports and finances",
    "ReliefWeb"
  ],
  sourcesSucceeded: [],
  sourcesSkipped: [],
  limitations: [
    "Prepared metadata index built from public open sources.",
    "Not a complete official MSF publication database.",
    "Metadata can include records that mention MSF-related terms without proving official authorship, affiliation or endorsement.",
    "No full PDFs are downloaded or republished."
  ],
  buildWarnings: []
};

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const collected = [];
  collected.push(...await collectOpenAlex());
  collected.push(...await collectCrossref());
  await checkSciencePortal();
  await checkMsfResourceCentre();
  collected.push(...await collectReliefWebIfConfigured());

  const records = dedupeRecords(collected).sort(sortRecords);
  manifest.totalRecords = records.length;
  manifest.recordsBySource = recordsBySource(records);

  await fs.writeFile(PUBLICATIONS_FILE, `${JSON.stringify(records, null, 2)}\n`);
  await fs.writeFile(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Wrote ${records.length} records to ${path.relative(ROOT, PUBLICATIONS_FILE)}`);
  console.log(`Wrote manifest to ${path.relative(ROOT, MANIFEST_FILE)}`);
}

async function collectOpenAlex() {
  const sourceName = "OpenAlex";
  const records = [];
  let fetched = 0;

  for (const query of OPENALEX_QUERIES) {
    let page = 1;
    while (fetched < MAX_OPENALEX_RECORDS) {
      const url = new URL("https://api.openalex.org/works");
      url.searchParams.set("search", query);
      url.searchParams.set("filter", `from_publication_date:${yearFrom}-01-01,to_publication_date:${yearTo}-12-31`);
      url.searchParams.set("sort", "publication_date:desc");
      url.searchParams.set("per-page", String(OPENALEX_PAGE_SIZE));
      url.searchParams.set("page", String(page));

      const data = await getJson(url, sourceName);
      const results = Array.isArray(data.results) ? data.results : [];
      if (!results.length) {
        break;
      }

      for (const item of results) {
        const record = normaliseOpenAlex(item, query);
        if (isRelevantPublication(record, query)) {
          records.push(record);
        }
        fetched += 1;
        if (fetched >= MAX_OPENALEX_RECORDS) {
          break;
        }
      }

      if (results.length < OPENALEX_PAGE_SIZE || page >= 5) {
        break;
      }

      page += 1;
      await delay(REQUEST_DELAY_MS);
    }
  }

  markSucceeded(sourceName, records);
  return records;
}

async function collectCrossref() {
  const sourceName = "Crossref";
  const records = [];
  let fetched = 0;

  for (const query of CROSSREF_QUERIES) {
    if (fetched >= MAX_CROSSREF_RECORDS) {
      break;
    }

    const url = new URL("https://api.crossref.org/works");
    url.searchParams.set("query", query);
    url.searchParams.set("filter", `from-pub-date:${yearFrom}-01-01,until-pub-date:${yearTo}-12-31`);
    url.searchParams.set("rows", String(Math.min(CROSSREF_ROWS, MAX_CROSSREF_RECORDS - fetched)));
    url.searchParams.set("sort", "published");
    url.searchParams.set("order", "desc");

    const data = await getJson(url, sourceName);
    const items = data.message && Array.isArray(data.message.items) ? data.message.items : [];
    for (const item of items) {
      const record = normaliseCrossref(item, query);
      if (isRelevantPublication(record, query)) {
        records.push(record);
      }
      fetched += 1;
    }

    await delay(REQUEST_DELAY_MS);
  }

  markSucceeded(sourceName, records);
  return records;
}

async function collectReliefWebIfConfigured() {
  const sourceName = "ReliefWeb";
  const appname = process.env.RELIEFWEB_APPNAME;
  if (!appname) {
    skip(sourceName, "ReliefWeb harvesting skipped because RELIEFWEB_APPNAME is not set. Existing optional live query UI remains available.");
    return [];
  }

  const records = [];
  for (const query of OPENALEX_QUERIES) {
    const url = new URL("https://api.reliefweb.int/v2/reports");
    url.searchParams.set("appname", appname);
    url.searchParams.set("query[value]", query);
    url.searchParams.set("limit", "50");
    url.searchParams.append("sort[]", "date:desc");

    const data = await getJson(url, sourceName);
    const items = Array.isArray(data.data) ? data.data : [];
    for (const item of items) {
      const record = normaliseReliefWeb(item, query);
      if (isRelevantPublication(record, query)) {
        records.push(record);
      }
    }
    await delay(REQUEST_DELAY_MS);
  }

  markSucceeded(sourceName, records);
  return records;
}

async function checkSciencePortal() {
  const sourceName = "MSF Science Portal";
  try {
    const response = await fetch("https://scienceportal.msf.org/");
    if (!response.ok) {
      skip(sourceName, "MSF Science Portal was not harvested because the public homepage could not be fetched during this prototype.");
      return;
    }
    const html = await response.text();
    const hasObviousApi = /api\/|graphql|search/i.test(html) && /scienceportal\.msf\.org/i.test(html);
    if (hasObviousApi) {
      manifest.buildWarnings.push("MSF Science Portal page scripts mention possible API/search terms, but no stable public listing endpoint was confirmed automatically.");
    }
    skip(sourceName, "MSF Science Portal was not harvested because no stable public search API was confirmed in this prototype.");
  } catch (error) {
    skip(sourceName, `MSF Science Portal was not harvested because no stable public search API was confirmed in this prototype. Fetch check failed: ${error.message}`);
  }
}

async function checkMsfResourceCentre() {
  const sourceName = "MSF.org Resource Centre / reports and finances";
  const sitemapUrls = [
    "https://www.msf.org/sitemap.xml",
    "https://www.msf.org/sitemap_index.xml"
  ];

  for (const sitemapUrl of sitemapUrls) {
    try {
      const response = await fetch(sitemapUrl);
      if (!response.ok) {
        continue;
      }
      const xml = await response.text();
      const resourceLinks = [...xml.matchAll(/<loc>([^<]*(?:resource-centre|reports-and-finances)[^<]*)<\/loc>/gi)].map((match) => match[1]);
      if (resourceLinks.length) {
        manifest.buildWarnings.push(`MSF.org sitemap check found ${resourceLinks.length} candidate resource URLs, but this prototype did not harvest them because reliable publication dates and report/resource scope were not confirmed from the sitemap alone.`);
        skip(sourceName, "MSF Resource Centre was kept as a reference source because no reliable structured listing with publication dates was confirmed in this prototype.");
        return;
      }
    } catch (error) {
      manifest.buildWarnings.push(`MSF.org sitemap check failed for ${sitemapUrl}: ${error.message}`);
    }
  }

  skip(sourceName, "MSF Resource Centre was kept as a reference source because no reliable structured listing with publication dates was confirmed in this prototype.");
}

async function getJson(url, sourceName, attempt = 1) {
  try {
    const response = await fetch(url);
    if (response.status === 429 && attempt <= 3) {
      const waitMs = REQUEST_DELAY_MS * attempt * 4;
      manifest.buildWarnings.push(`${sourceName} rate limit encountered. Retrying after ${waitMs}ms.`);
      await delay(waitMs);
      return getJson(url, sourceName, attempt + 1);
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  } catch (error) {
    manifest.buildWarnings.push(`${sourceName} request failed for ${redactUrl(url)}: ${error.message}`);
    return {};
  }
}

function normaliseOpenAlex(item, matchedTerm) {
  const authorships = Array.isArray(item.authorships) ? item.authorships : [];
  const institutions = unique(authorships.flatMap((authorship) =>
    Array.isArray(authorship.institutions) ? authorship.institutions.map((institution) => institution.display_name) : []
  ));
  const source = item.primary_location && item.primary_location.source ? item.primary_location.source : {};
  const topics = unique([
    ...arrayNames(item.topics),
    ...arrayNames(item.concepts)
  ]);

  return cleanRecord({
    id: `openalex:${item.id || stableTitleId(item.display_name, item.publication_year)}`,
    title: item.display_name || "",
    year: item.publication_year || "",
    date: item.publication_date || "",
    authors: unique(authorships.map((authorship) => authorship.author && authorship.author.display_name)),
    sourceName: source.display_name || "",
    publisher: source.host_organization_name || "",
    type: item.type || "",
    doi: normaliseDoi(item.doi),
    url: cleanUrl(item.primary_location && item.primary_location.landing_page_url) || cleanUrl(item.id),
    openAccessUrl: cleanUrl(item.open_access && item.open_access.oa_url),
    abstract: abstractFromInvertedIndex(item.abstract_inverted_index),
    topics,
    countries: [],
    organisations: institutions,
    matchedTerms: [matchedTerm],
    provenance: [{
      source: "OpenAlex",
      sourceId: item.id || "",
      sourceUrl: cleanUrl(item.id),
      fetchedAt
    }]
  });
}

function normaliseCrossref(item, matchedTerm) {
  const title = firstValue(item.title) || "";
  const year = issuedYear(item.issued || item.published || item["published-print"] || item["published-online"]);
  const date = issuedDate(item.issued || item.published || item["published-print"] || item["published-online"]);

  return cleanRecord({
    id: `crossref:${normaliseDoi(item.DOI) || stableTitleId(title, year)}`,
    title,
    year,
    date,
    authors: unique((item.author || []).map((author) => [author.given, author.family].filter(Boolean).join(" "))),
    sourceName: firstValue(item["container-title"]) || "",
    publisher: item.publisher || "",
    type: item.type || "",
    doi: normaliseDoi(item.DOI),
    url: cleanUrl(item.URL) || doiUrl(item.DOI),
    openAccessUrl: "",
    abstract: stripTags(item.abstract || ""),
    topics: [],
    countries: [],
    organisations: [],
    matchedTerms: [matchedTerm],
    provenance: [{
      source: "Crossref",
      sourceId: normaliseDoi(item.DOI) || cleanUrl(item.URL),
      sourceUrl: cleanUrl(item.URL) || doiUrl(item.DOI),
      fetchedAt
    }]
  });
}

function normaliseReliefWeb(item, matchedTerm) {
  const fields = item.fields || {};
  const date = fields.date && (fields.date.original || fields.date.created || fields.date.changed);

  return cleanRecord({
    id: `reliefweb:${item.id || stableTitleId(fields.title, yearFromDate(date))}`,
    title: fields.title || "",
    year: yearFromDate(date),
    date: date || "",
    authors: arrayNames(fields.source),
    sourceName: "ReliefWeb",
    publisher: arrayNames(fields.source).join(", "),
    type: fields.format && fields.format.name ? fields.format.name : "report",
    doi: "",
    url: cleanUrl(fields.url) || cleanUrl(item.href),
    openAccessUrl: "",
    abstract: stripTags(fields.body || ""),
    topics: arrayNames(fields.theme),
    countries: arrayNames(fields.country),
    organisations: arrayNames(fields.source),
    matchedTerms: [matchedTerm],
    provenance: [{
      source: "ReliefWeb",
      sourceId: String(item.id || ""),
      sourceUrl: cleanUrl(fields.url) || cleanUrl(item.href),
      fetchedAt
    }]
  });
}

function dedupeRecords(records) {
  const byKey = new Map();

  for (const record of records.filter((item) => item.title)) {
    const key = record.doi ? `doi:${record.doi}` : `title:${normaliseTitle(record.title)}:${record.year}`;
    if (!byKey.has(key)) {
      byKey.set(key, record);
      continue;
    }
    byKey.set(key, mergeRecords(byKey.get(key), record));
  }

  return [...byKey.values()].map((record) => {
    record.id = record.doi ? `doi:${record.doi}` : stableTitleId(record.title, record.year);
    return cleanRecord(record);
  });
}

function isRelevantPublication(record, query) {
  const text = searchableText(record);
  const normalised = foldText(text);
  const queryNormalised = foldText(query);

  if (queryNormalised === "msf") {
    const organisations = foldText((record.organisations || []).join(" "));
    return normalised.includes("medecins sans frontieres")
      || normalised.includes("doctors without borders")
      || organisations.includes("medecins sans frontieres")
      || organisations.includes("doctors without borders")
      || /\bmsf\b/i.test((record.organisations || []).join(" "));
  }

  if (queryNormalised === "medecins sans frontieres") {
    return normalised.includes("medecins sans frontieres");
  }

  if (queryNormalised === "doctors without borders") {
    return normalised.includes("doctors without borders");
  }

  if (queryNormalised === "epicentre") {
    const organisations = foldText((record.organisations || []).join(" "));
    return organisations.includes("epicentre")
      || normalised.includes("medecins sans frontieres")
      || normalised.includes("doctors without borders");
  }

  return normalised.includes(queryNormalised);
}

function searchableText(record) {
  return [
    record.title,
    record.sourceName,
    record.publisher,
    record.type,
    record.abstract,
    ...(record.authors || []),
    ...(record.topics || []),
    ...(record.countries || []),
    ...(record.organisations || [])
  ].join(" ");
}

function mergeRecords(a, b) {
  return cleanRecord({
    id: a.id || b.id,
    title: longer(a.title, b.title),
    year: a.year || b.year,
    date: bestDate(a.date, b.date),
    authors: unique([...a.authors, ...b.authors]),
    sourceName: a.sourceName || b.sourceName,
    publisher: a.publisher || b.publisher,
    type: a.type || b.type,
    doi: a.doi || b.doi,
    url: a.url || b.url,
    openAccessUrl: a.openAccessUrl || b.openAccessUrl,
    abstract: a.abstract || b.abstract,
    topics: unique([...a.topics, ...b.topics]),
    countries: unique([...a.countries, ...b.countries]),
    organisations: unique([...a.organisations, ...b.organisations]),
    matchedTerms: unique([...a.matchedTerms, ...b.matchedTerms]),
    provenance: uniqueProvenance([...a.provenance, ...b.provenance])
  });
}

function cleanRecord(record) {
  return {
    id: trim(record.id),
    title: trim(record.title),
    year: record.year ? String(record.year) : "",
    date: trim(record.date),
    authors: unique(record.authors || []),
    sourceName: trim(record.sourceName),
    publisher: trim(record.publisher),
    type: trim(record.type),
    doi: normaliseDoi(record.doi),
    url: cleanUrl(record.url),
    openAccessUrl: cleanUrl(record.openAccessUrl),
    abstract: trim(record.abstract),
    topics: unique(record.topics || []),
    countries: unique(record.countries || []),
    organisations: unique(record.organisations || []),
    matchedTerms: unique(record.matchedTerms || []),
    provenance: uniqueProvenance(record.provenance || [])
  };
}

function recordsBySource(records) {
  const counts = {};
  for (const record of records) {
    for (const provenance of record.provenance) {
      counts[provenance.source] = (counts[provenance.source] || 0) + 1;
    }
  }
  return counts;
}

function markSucceeded(sourceName, records) {
  if (records.length) {
    manifest.sourcesSucceeded.push(sourceName);
  } else {
    manifest.buildWarnings.push(`${sourceName} returned no records for the configured queries.`);
  }
}

function skip(sourceName, reason) {
  manifest.sourcesSkipped.push({ source: sourceName, reason });
  manifest.limitations.push(reason);
}

function sortRecords(a, b) {
  const yearDiff = Number(b.year || 0) - Number(a.year || 0);
  if (yearDiff) {
    return yearDiff;
  }
  return (b.date || "").localeCompare(a.date || "");
}

function arrayNames(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.map((item) => {
    if (typeof item === "string") {
      return item;
    }
    return item.display_name || item.name || item.shortname || "";
  }).filter(Boolean);
}

function abstractFromInvertedIndex(index) {
  if (!index || typeof index !== "object") {
    return "";
  }
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) {
      continue;
    }
    for (const position of positions) {
      words[position] = word;
    }
  }
  return words.filter(Boolean).join(" ");
}

function issuedYear(issued) {
  return issued && issued["date-parts"] && issued["date-parts"][0] ? issued["date-parts"][0][0] : "";
}

function issuedDate(issued) {
  if (!issued || !issued["date-parts"] || !issued["date-parts"][0]) {
    return "";
  }
  const [year, month = 1, day = 1] = issued["date-parts"][0];
  return [year, String(month).padStart(2, "0"), String(day).padStart(2, "0")].join("-");
}

function yearFromDate(value) {
  const match = String(value || "").match(/\d{4}/);
  return match ? match[0] : "";
}

function normaliseDoi(value) {
  return trim(value)
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase();
}

function doiUrl(doi) {
  const clean = normaliseDoi(doi);
  return clean ? `https://doi.org/${clean}` : "";
}

function cleanUrl(value) {
  const clean = trim(value);
  if (!clean) {
    return "";
  }
  try {
    const url = new URL(clean);
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach((param) => url.searchParams.delete(param));
    return url.toString();
  } catch {
    return clean;
  }
}

function redactUrl(value) {
  const url = new URL(value);
  if (url.searchParams.has("appname")) {
    url.searchParams.set("appname", "[redacted]");
  }
  return url.toString();
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function stripTags(value) {
  return trim(String(value || "").replace(/<[^>]*>/g, " "));
}

function trim(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unique(values) {
  const seen = new Set();
  const output = [];
  for (const value of values.map(trim).filter(Boolean)) {
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      output.push(value);
    }
  }
  return output;
}

function uniqueProvenance(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const clean = {
      source: trim(item.source),
      sourceId: trim(item.sourceId),
      sourceUrl: cleanUrl(item.sourceUrl),
      fetchedAt: trim(item.fetchedAt)
    };
    const key = `${clean.source}:${clean.sourceId || clean.sourceUrl}`;
    if (clean.source && !seen.has(key)) {
      seen.add(key);
      output.push(clean);
    }
  }
  return output;
}

function normaliseTitle(value) {
  return foldText(value).replace(/[^\p{L}\p{N}]+/gu, " ");
}

function foldText(value) {
  return trim(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function stableTitleId(title, year) {
  const slug = normaliseTitle(title).replace(/\s+/g, "-").slice(0, 90) || "untitled";
  return `title:${slug}:${year || "unknown"}`;
}

function longer(a, b) {
  return trim(b).length > trim(a).length ? trim(b) : trim(a);
}

function bestDate(a, b) {
  if (!a) {
    return b || "";
  }
  if (!b) {
    return a;
  }
  return String(a).length >= String(b).length ? a : b;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
