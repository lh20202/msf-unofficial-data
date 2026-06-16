#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const COUNTRIES_FILE = path.join(DATA_DIR, "countries.json");
const SOURCES_FILE = path.join(DATA_DIR, "sources.json");

const BUILD_VERSION = "1.0.0";
const REQUEST_TIMEOUT_MS = 30000;
const GDELT_DELAY_MS = 7000;
const generatedAt = new Date().toISOString();
const today = startOfUtcDay(new Date());
const windows = dateWindows(today);

const countries = [
  { id: "sudan", name: "Sudan", iso3: "SDN", hdxGroup: "sdn", accent: "#d96b5f", compareWith: "haiti" },
  { id: "haiti", name: "Haiti", iso3: "HTI", hdxGroup: "hti", accent: "#56b6a5", compareWith: "sudan" }
];

const attemptedConnectors = [
  "ocha-fts-hdx",
  "gdelt-doc",
  "reliefweb",
  "hdx-humanitarian-datasets",
  "hdx-food-prices"
];

const connectorResults = [];

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const results = {};
  for (const country of countries) {
    console.log(`Building Country Pulse calculations for ${country.name}...`);
    const funding = await fetchFunding(country);
    const media = await fetchMedia(country);
    await delay(GDELT_DELAY_MS);
    const reporting = await fetchReliefWeb(country);
    const humanitarian = await fetchHumanitarianCoverage(country);
    const food = await fetchFoodMarketCoverage(country);
    const signals = { funding, media, reporting, humanitarian, food };
    results[country.id] = { country, signals };
    recordConnectors(country, signals);
  }

  assertMinimumSuccess(results);

  const countryData = countries.map((country) => buildCountry(country, results));
  const payload = {
    schemaVersion: BUILD_VERSION,
    productName: "Country Pulse",
    usp: "Country Pulse turns public humanitarian data into simple, evidence-led comparisons: what changed, where, compared with what, and why that matters.",
    generatedAt,
    lastUpdated: isoDate(today),
    dateRanges: {
      last30: `${windows.last30.isoStart} to ${windows.today}`,
      previous30: `${windows.previous30.isoStart} to ${windows.last30.isoStart}`,
      last90: `${windows.last90.isoStart} to ${windows.today}`
    },
    controls: {
      countries: countries.map(({ id, name }) => ({ id, name })),
      compareWith: [
        { id: "previous30", label: "Previous 30 days" },
        { id: "previous90", label: "Previous 90 days" },
        { id: "country", label: "Other country" }
      ],
      themes: [
        { id: "combined", label: "Combined" },
        { id: "media", label: "Media" },
        { id: "reporting", label: "Reporting" },
        { id: "funding", label: "Funding" },
        { id: "food-prices", label: "Food prices" }
      ],
      questions: [
        { id: "what-changed", label: "What changed?" },
        { id: "largest-gap", label: "What has the largest gap?" },
        { id: "under-reported", label: "What is under-reported?" },
        { id: "available-to-compare", label: "What is available enough to compare?" }
      ]
    },
    countries: countryData
  };

  const sourcePayload = {
    schemaVersion: BUILD_VERSION,
    generatedAt,
    methodLine: "Measured from public datasets and reporting APIs. Some values are unavailable where public sources do not provide comparable data.",
    sourceGroups: buildSourceGroups(countryData)
  };

  await fs.writeFile(COUNTRIES_FILE, `${JSON.stringify(payload, null, 2)}\n`);
  await fs.writeFile(SOURCES_FILE, `${JSON.stringify(sourcePayload, null, 2)}\n`);

  printConnectorSummary();
  console.log(`Wrote ${path.relative(ROOT, COUNTRIES_FILE)}`);
  console.log(`Wrote ${path.relative(ROOT, SOURCES_FILE)}`);
}

function buildCountry(country, allResults) {
  const signals = allResults[country.id].signals;
  const comparison = allResults[country.compareWith];
  const compareSignals = comparison.signals;
  const metrics = buildMetrics(signals, compareSignals);
  const insights = buildInsights(country, metrics, comparison.country);
  return {
    id: country.id,
    name: country.name,
    iso3: country.iso3,
    accent: country.accent,
    compareWith: country.compareWith,
    lastUpdated: isoDate(today),
    metrics,
    insights,
    sourceGroups: buildCountrySourceGroups(metrics),
    dataQuality: qualitySummary(metrics)
  };
}

function buildMetrics(signals, compareSignals) {
  const media = signals.media.values;
  const compareMedia = compareSignals.media.values;
  const reporting = signals.reporting.values;
  const funding = signals.funding.values;
  const food = signals.food.values;
  const humanitarian = signals.humanitarian.values;

  const mediaShare = media && compareMedia
    ? pct(media.last30Mentions, media.last30Mentions + compareMedia.last30Mentions)
    : null;

  return {
    media: {
      available: Boolean(media),
      last30Mentions: media?.last30Mentions ?? null,
      previous30Mentions: media?.previous30Mentions ?? null,
      last90Mentions: media?.last90Mentions ?? null,
      mediaChangePct: media?.mediaChangePct ?? null,
      mediaShareAcrossSelectedCountries: mediaShare,
      mediaTrendLabel: trendLabel(media?.mediaChangePct),
      dateRange: windows.last90.label,
      confidenceLabel: media ? "Contextual signal" : "No comparable public value available for this filter."
    },
    reporting: {
      available: Boolean(reporting),
      last30Reports: reporting?.last30Reports ?? null,
      previous30Reports: reporting?.previous30Reports ?? null,
      last90Reports: reporting?.last90Reports ?? null,
      reportChangePct: reporting?.reportChangePct ?? null,
      topReportingThemes: reporting?.topReportingThemes ?? [],
      reportingTrendLabel: trendLabel(reporting?.reportChangePct),
      dateRange: windows.last90.label,
      confidenceLabel: reporting ? "Medium confidence: reporting API count" : "No comparable public value available for this filter."
    },
    funding: {
      available: Boolean(funding && (funding.fundingReceived !== null || funding.fundingRequired !== null)),
      fundingRequired: funding?.fundingRequired ?? null,
      fundingReceived: funding?.fundingReceived ?? null,
      fundingCoveragePct: funding?.fundingCoveragePct ?? null,
      fundingGapPct: funding?.fundingGapPct ?? null,
      topDonors: funding?.topDonors ?? [],
      fundingStatusLabel: fundingStatus(funding),
      dateRange: signals.funding.dateRange,
      confidenceLabel: funding ? "Structured funding data" : "No comparable public value available for this filter."
    },
    foodPrices: {
      available: Boolean(food),
      availableMarketCount: food?.availableMarketCount ?? null,
      availableCommodityCount: food?.availableCommodityCount ?? null,
      latestMarketDataDate: food?.latestMarketDataDate ?? null,
      priceChangePct: food?.priceChangePct ?? null,
      dateRange: food?.latestMarketDataDate || signals.food.dateRange,
      confidenceLabel: food ? "Availability only: market data coverage" : "No comparable public value available for this filter."
    },
    humanitarianCoverage: {
      available: Boolean(humanitarian),
      datasetCount: humanitarian?.datasetCount ?? null,
      resourceCount: humanitarian?.resourceCount ?? null,
      dateRange: signals.humanitarian.dateRange,
      confidenceLabel: humanitarian ? "Availability only: structured dataset coverage" : "No comparable public value available for this filter."
    }
  };
}

function buildInsights(country, metrics, compareCountry) {
  const insights = [];
  const media = metrics.media;
  const reporting = metrics.reporting;
  const funding = metrics.funding;
  const food = metrics.foodPrices;
  const humanitarian = metrics.humanitarianCoverage;

  if (media.available) {
    insights.push({
      id: "media-what-changed",
      theme: "media",
      question: "what-changed",
      headline: `Public media attention is ${media.mediaTrendLabel}.`,
      shortAnswer: `Public reporting on ${country.name} ${movementVerb(media.mediaChangePct)} by ${formatPctAbs(media.mediaChangePct)} compared with the previous 30 days.`,
      evidenceBullets: [
        `${formatNumber(media.last30Mentions)} article-count mentions in the last 30 days.`,
        `${formatNumber(media.previous30Mentions)} article-count mentions in the previous 30 days.`,
        `${formatNumber(media.last90Mentions)} article-count mentions across the last 90 days.`
      ],
      comparisonBasis: "Compared with the previous 30 days",
      dateRange: media.dateRange,
      confidenceLabel: media.confidenceLabel,
      caveat: "Article volume is an attention measure. It does not verify a change in need or severity.",
      methodCategory: "Media/article counts",
      sourceCategories: ["Media/article counts"]
    });
  }

  if (media.available) {
    insights.push({
      id: "combined-under-reported",
      theme: "combined",
      question: "under-reported",
      headline: `The clearest comparable movement is public attention, not funding coverage.`,
      shortAnswer: `${country.name} accounts for ${formatPct(media.mediaShareAcrossSelectedCountries)} of selected-country media mentions in the latest 30-day window, compared with ${compareCountry.name}.`,
      evidenceBullets: [
        `${country.name}: ${formatNumber(media.last30Mentions)} latest 30-day mentions.`,
        `Media trend: ${media.mediaTrendLabel}.`,
        funding.available ? `Funding coverage: ${formatPct(funding.fundingCoveragePct)}.` : "Funding coverage is not comparable from the connected public data."
      ],
      comparisonBasis: `Compared with ${compareCountry.name}`,
      dateRange: media.dateRange,
      confidenceLabel: "Contextual signal",
      caveat: "A larger media share can reflect attention, language, or publication patterns. It should not be read as a ranking of humanitarian need.",
      methodCategory: "Combined comparison",
      sourceCategories: ["Media/article counts", "Funding data"]
    });
  }

  if (reporting.available) {
    insights.push({
      id: "reporting-what-changed",
      theme: "reporting",
      question: "what-changed",
      headline: `Humanitarian report volume is ${reporting.reportingTrendLabel}.`,
      shortAnswer: `ReliefWeb report volume for ${country.name} ${movementVerb(reporting.reportChangePct)} by ${formatPctAbs(reporting.reportChangePct)} compared with the previous 30 days.`,
      evidenceBullets: [
        `${formatNumber(reporting.last30Reports)} reports in the last 30 days.`,
        `${formatNumber(reporting.previous30Reports)} reports in the previous 30 days.`,
        reporting.topReportingThemes.length ? `Frequent themes: ${reporting.topReportingThemes.join(", ")}.` : "Theme concentration was not available from the public response."
      ],
      comparisonBasis: "Compared with the previous 30 days",
      dateRange: reporting.dateRange,
      confidenceLabel: reporting.confidenceLabel,
      caveat: "Report counts show publishing pressure, not verified field severity.",
      methodCategory: "Humanitarian reporting",
      sourceCategories: ["Humanitarian reporting"]
    });
  }

  if (funding.available && funding.fundingCoveragePct !== null) {
    insights.push({
      id: "funding-largest-gap",
      theme: "funding",
      question: "largest-gap",
      headline: `Reported funding coverage is ${formatPct(funding.fundingCoveragePct)}.`,
      shortAnswer: `${country.name} has a reported funding gap of ${formatPct(funding.fundingGapPct)} in the connected funding data.`,
      evidenceBullets: [
        `Reported requirement: ${formatUsd(funding.fundingRequired)}.`,
        `Reported funding: ${formatUsd(funding.fundingReceived)}.`,
        funding.topDonors.length ? `Largest reported donors: ${funding.topDonors.map((donor) => donor.name).join(", ")}.` : "Top donor data was not available."
      ],
      comparisonBasis: "Funding requirement compared with reported funding",
      dateRange: funding.dateRange,
      confidenceLabel: funding.confidenceLabel,
      caveat: "Funding data depends on public reporting to FTS/HPC and may lag changes in allocations.",
      methodCategory: "Funding data",
      sourceCategories: ["Funding data"]
    });
  }

  if (food.available) {
    insights.push({
      id: "food-available-to-compare",
      theme: "food-prices",
      question: "available-to-compare",
      headline: `Market data coverage is visible, but price movement is not inferred.`,
      shortAnswer: `${country.name} has public food-market coverage across ${formatNumber(food.availableMarketCount)} market references and ${formatNumber(food.availableCommodityCount)} commodity references in the connected data search.`,
      evidenceBullets: [
        `${formatNumber(food.availableMarketCount)} market references found.`,
        `${formatNumber(food.availableCommodityCount)} commodity references found.`,
        food.latestMarketDataDate ? `Latest dated market resource: ${food.latestMarketDataDate}.` : "No clean latest reporting date was extractable."
      ],
      comparisonBasis: "Market-data coverage, not price severity",
      dateRange: food.dateRange,
      confidenceLabel: food.confidenceLabel,
      caveat: "Do not treat dataset coverage as evidence of price movement until commodity-level values are parsed.",
      methodCategory: "Food/market data",
      sourceCategories: ["Food/market data"]
    });
    insights.push({
      id: "food-largest-gap",
      theme: "food-prices",
      question: "largest-gap",
      headline: "The food-price gap is commodity-level movement.",
      shortAnswer: `${country.name} has market-data coverage, but the generated public values do not yet support a safe month-to-month or year-to-year price-change conclusion.`,
      evidenceBullets: [
        `${formatNumber(food.availableMarketCount)} market references are available.`,
        `${formatNumber(food.availableCommodityCount)} commodity references are available.`,
        "Price movement is not shown unless commodity-level values can be parsed without guessing."
      ],
      comparisonBasis: "Coverage compared with extractable price movement",
      dateRange: food.dateRange,
      confidenceLabel: food.confidenceLabel,
      caveat: "Market coverage supports further comparison; it is not evidence that prices rose or fell.",
      methodCategory: "Food/market data",
      sourceCategories: ["Food/market data"]
    });
  }

  if (humanitarian.available) {
    insights.push({
      id: "combined-available-to-compare",
      theme: "combined",
      question: "available-to-compare",
      headline: `The strongest comparable base is coverage of public datasets.`,
      shortAnswer: `${country.name} has ${formatNumber(humanitarian.datasetCount)} structured humanitarian dataset matches and ${formatNumber(food.availableMarketCount || 0)} food-market references in the current build.`,
      evidenceBullets: [
        `${formatNumber(humanitarian.datasetCount)} humanitarian dataset matches.`,
        `${formatNumber(humanitarian.resourceCount)} related resources.`,
        media.available ? `Media movement is also available for comparison.` : "Media movement is not available for this build output."
      ],
      comparisonBasis: "Comparable public-data coverage",
      dateRange: windows.last90.label,
      confidenceLabel: "Availability only: public data coverage",
      caveat: "Coverage indicates what can be compared. It is not a severity score.",
      methodCategory: "Structured humanitarian indicators",
      sourceCategories: ["Structured humanitarian indicators", "Food/market data", "Media/article counts"]
    });
  }

  insights.push({
    id: "combined-largest-gap",
    theme: "combined",
    question: "largest-gap",
    headline: "The largest analytical gap is funding and reporting comparability.",
    shortAnswer: `${country.name} has comparable public data coverage for market and humanitarian dataset availability, but funding coverage and humanitarian report movement are not comparable in the generated data.`,
    evidenceBullets: [
      funding.available ? `Funding coverage is ${formatPct(funding.fundingCoveragePct)}.` : "Funding coverage is not shown because requirement and received values could not be compared.",
      reporting.available ? `Report movement is ${reporting.reportingTrendLabel}.` : "Report movement is not shown because comparable report counts were not returned.",
      media.available ? `Media movement is ${media.mediaTrendLabel}.` : "Media movement is not shown for this output because article counts were not returned."
    ],
    comparisonBasis: "Available values compared with missing comparable values",
    dateRange: windows.last90.label,
    confidenceLabel: "Evidence-led limitation",
    caveat: "A missing comparable value is not evidence of absence. It only marks the limit of this public-data view.",
    methodCategory: "Combined comparison",
    sourceCategories: ["Funding data", "Humanitarian reporting", "Media/article counts"]
  });

  if (!insights.length) {
    insights.push(noValueInsight(country));
  }

  return insights;
}

function noValueInsight(country) {
  return {
    id: "no-comparable-value",
    theme: "combined",
    question: "available-to-compare",
    headline: "No comparable public value available for this filter.",
    shortAnswer: `${country.name} did not have enough comparable public values for this question in the generated static data.`,
    evidenceBullets: ["No fake number has been added.", "Unavailable values are excluded from the main analysis."],
    comparisonBasis: "Current public build",
    dateRange: windows.last90.label,
    confidenceLabel: "No comparable public value available for this filter.",
    caveat: "The method drawer records which connector categories were attempted.",
    methodCategory: "Data availability",
    sourceCategories: []
  };
}

function buildCountrySourceGroups(metrics) {
  return [
    group("funding", "Funding data", metrics.funding.available, metrics.funding.dateRange, metrics.funding.available ? "Used to calculate funding coverage and funding gap." : "Funding coverage was not shown because comparable requirement and received values were not available."),
    group("media", "Media/article counts", metrics.media.available, metrics.media.dateRange, metrics.media.available ? "Used to calculate article-count movement and country share." : "Media movement was not shown for filters that need it."),
    group("reporting", "Humanitarian reporting", metrics.reporting.available, metrics.reporting.dateRange, metrics.reporting.available ? "Used to calculate report-volume movement." : "Reporting pressure was not shown because the API did not provide a comparable value."),
    group("food", "Food/market data", metrics.foodPrices.available, metrics.foodPrices.dateRange, metrics.foodPrices.available ? "Used to show market-data coverage." : "Food-price movement was not inferred."),
    group("humanitarian", "Structured humanitarian indicators", metrics.humanitarianCoverage.available, metrics.humanitarianCoverage.dateRange, metrics.humanitarianCoverage.available ? "Used to show comparable dataset coverage." : "Structured indicator values were not shown.")
  ];
}

function buildSourceGroups(countryData) {
  const groups = [
    ["funding", "Funding data", "OCHA FTS / HPC and FTS datasets", "Funding requirements, received funding, coverage, gaps, and donors where public values are available."],
    ["media", "Media/article counts", "GDELT DOC API", "Article-count movement for the last 30 days, previous 30 days, and last 90 days."],
    ["reporting", "Humanitarian reporting", "ReliefWeb API", "Report-volume movement and public reporting concentration where the API provides comparable values."],
    ["food", "Food/market data", "WFP/HDX food-price and market datasets", "Market and commodity coverage; price movement only when safely extractable."],
    ["humanitarian", "Structured humanitarian indicators", "HDX/HAPI or HDX data search", "Structured humanitarian dataset coverage for comparable public analysis."]
  ];
  return groups.map(([id, label, publicBasis, contribution]) => {
    const countryGroups = countryData.map((country) => country.sourceGroups.find((item) => item.id === id));
    const used = countryGroups.some((item) => item && item.usedInVisibleInsights);
    return {
      id,
      label,
      publicBasis,
      contribution,
      dateRange: windows.last90.label,
      usedInVisibleInsights: used,
      limitations: limitationForGroup(id)
    };
  });
}

function group(id, label, usedInVisibleInsights, dateRange, contribution) {
  return {
    id,
    label,
    usedInVisibleInsights,
    dateRange,
    contribution,
    limitation: limitationForGroup(id)
  };
}

function limitationForGroup(id) {
  return {
    funding: "Funding data is shown only when requirement and received values can be compared without guessing.",
    media: "Article counts are contextual attention signals, not confirmation of humanitarian conditions.",
    reporting: "Report volume reflects publication behaviour and access to public reporting, not severity by itself.",
    food: "Dataset coverage is not food-price severity unless commodity-level prices are parsed.",
    humanitarian: "Dataset availability indicates comparability; it is not an indicator value."
  }[id] || "Method limits are recorded by category.";
}

function qualitySummary(metrics) {
  const visible = Object.values(metrics).filter((metric) => metric.available).length;
  return visible >= 3
    ? "Multiple public categories produced comparable values."
    : "Comparable values are available for a limited set of categories.";
}

async function fetchFunding(country) {
  const sourceId = "ocha-fts-hdx";
  try {
    const queries = [`FTS funding ${country.name} 2026`, `FTS incoming funding ${country.name}`, `${country.name} humanitarian funding FTS`];
    for (const query of queries) {
      const search = await fetchJson(hdxPackageSearchUrl(query, 10), sourceId);
      const resource = findFtsResource(search.result?.results || [], country);
      if (!resource) continue;
      const csv = await fetchText(resource.url, sourceId);
      const rows = parseCsv(csv);
      const received = rows.reduce((sum, row) => sum + numberValue(row.amountUSD), 0);
      if (received > 0) {
        return connected(sourceId, resource.url, "Current FTS CSV snapshot", {
          fundingRequired: null,
          fundingReceived: Math.round(received),
          fundingCoveragePct: null,
          fundingGapPct: null,
          topDonors: topBy(rows, "srcOrganization", "amountUSD", 5)
        });
      }
    }
    return unavailable(sourceId, "Funding requirement and received values were not comparable.");
  } catch (error) {
    return failed(sourceId, error);
  }
}

async function fetchMedia(country) {
  const sourceId = "gdelt-doc";
  try {
    const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
    url.searchParams.set("query", `${country.name} humanitarian`);
    url.searchParams.set("mode", "timelinevolraw");
    url.searchParams.set("format", "json");
    url.searchParams.set("timespan", "90d");
    const data = await fetchJson(url, sourceId, { retries: 2, retryDelayMs: GDELT_DELAY_MS });
    const timeline = Array.isArray(data.timeline) ? data.timeline : [];
    const last30 = sumTimeline(timeline, windows.last30.start, windows.todayDate);
    const previous30 = sumTimeline(timeline, windows.previous30.start, windows.last30.start);
    const last90 = sumTimeline(timeline, windows.last90.start, windows.todayDate);
    if (last90 > 0) {
      return connected(sourceId, url.toString(), windows.last90.label, {
        last30Mentions: last30,
        previous30Mentions: previous30,
        last90Mentions: last90,
        mediaChangePct: previous30 > 0 ? round(((last30 - previous30) / previous30) * 100, 1) : null
      });
    }
    return unavailable(sourceId, "No comparable media count returned.");
  } catch (error) {
    return failed(sourceId, error);
  }
}

async function fetchReliefWeb(country) {
  const sourceId = "reliefweb";
  try {
    const last30 = await reliefWebCount(country, windows.last30.isoStart);
    const last90 = await reliefWebCount(country, windows.last90.isoStart);
    const previous60 = await reliefWebCount(country, windows.previous30.isoStart);
    const previous30 = Math.max(0, previous60 - last30);
    if (last90 > 0) {
      return connected(sourceId, "https://api.reliefweb.int/v2/reports", windows.last90.label, {
        last30Reports: last30,
        previous30Reports: previous30,
        last90Reports: last90,
        reportChangePct: previous30 > 0 ? round(((last30 - previous30) / previous30) * 100, 1) : null,
        topReportingThemes: []
      });
    }
    return unavailable(sourceId, "No comparable report count returned.");
  } catch (error) {
    return failed(sourceId, error);
  }
}

async function reliefWebCount(country, fromDate) {
  const url = new URL("https://api.reliefweb.int/v2/reports");
  url.searchParams.set("appname", "country-pulse");
  url.searchParams.set("limit", "0");
  url.searchParams.set("query[value]", `${country.name} humanitarian`);
  url.searchParams.set("filter[field]", "date.created");
  url.searchParams.set("filter[value][from]", `${fromDate}T00:00:00+00:00`);
  const data = await fetchJson(url, "reliefweb");
  return Number(data.totalCount || data.count || 0);
}

async function fetchHumanitarianCoverage(country) {
  const sourceId = "hdx-humanitarian-datasets";
  try {
    const url = hdxPackageSearchUrl(`${country.name} humanitarian indicators affected people displacement needs`, 10);
    const data = await fetchJson(url, sourceId);
    const packages = (data.result?.results || []).filter((pkg) => packageMentionsCountry(pkg, country));
    const resources = packages.flatMap((pkg) => pkg.resources || []);
    if (packages.length) {
      return connected(sourceId, url.toString(), "Current HDX package index", {
        datasetCount: packages.length,
        resourceCount: resources.length
      });
    }
    return unavailable(sourceId, "No comparable structured dataset coverage returned.");
  } catch (error) {
    return failed(sourceId, error);
  }
}

async function fetchFoodMarketCoverage(country) {
  const sourceId = "hdx-food-prices";
  try {
    const url = hdxPackageSearchUrl(`${country.name} food prices market WFP`, 10);
    const data = await fetchJson(url, sourceId);
    const packages = (data.result?.results || []).filter((pkg) => packageMentionsCountry(pkg, country));
    const resources = packages.flatMap((pkg) => pkg.resources || []);
    const text = resources.map((resource) => `${resource.name || ""} ${resource.description || ""}`).join(" ");
    const marketMatches = text.match(/\bmarket[s]?\b/gi) || [];
    const commodityMatches = text.match(/\b(rice|maize|wheat|beans|sorghum|millet|oil|flour|fuel|bread)\b/gi) || [];
    const latest = latestDate(resources.map((resource) => resource.last_modified || resource.created || resource.revision_timestamp));
    if (packages.length) {
      return connected(sourceId, url.toString(), "Current HDX package index", {
        availableMarketCount: Math.max(packages.length, marketMatches.length),
        availableCommodityCount: uniqueLower(commodityMatches).length || resources.length,
        latestMarketDataDate: latest,
        priceChangePct: null
      });
    }
    return unavailable(sourceId, "No comparable food-market coverage returned.");
  } catch (error) {
    return failed(sourceId, error);
  }
}

function recordConnectors(country, signals) {
  for (const [key, signal] of Object.entries(signals)) {
    connectorResults.push({
      country: country.name,
      connector: key,
      sourceId: signal.sourceId,
      status: signal.status,
      values: signal.values ? Object.keys(signal.values) : [],
      message: signal.error || signal.message || ""
    });
  }
}

function assertMinimumSuccess(results) {
  const failures = [];
  for (const { country, signals } of Object.values(results)) {
    const visible = Object.values(signals).filter((signal) => signal.status === "connected" && signal.values).length;
    if (visible < 2) failures.push(`${country.name}: ${visible} connector(s) with real values`);
  }
  if (attemptedConnectors.length < 3) failures.push("Fewer than 3 connectors were attempted.");
  if (failures.length) {
    printConnectorSummary();
    throw new Error(`Build failed minimum data threshold. ${failures.join("; ")}`);
  }
}

function connected(sourceId, sourceUrl, dateRange, values) {
  return { status: "connected", sourceId, sourceUrl, dateRange, values };
}

function unavailable(sourceId, message) {
  return { status: "unavailable", sourceId, dateRange: "No comparable public value available for this filter.", values: null, message };
}

function failed(sourceId, error) {
  return { status: "error", sourceId, dateRange: "No comparable public value available for this filter.", values: null, error: error.message || String(error) };
}

function hdxPackageSearchUrl(query, rows) {
  const url = new URL("https://data.humdata.org/api/3/action/package_search");
  url.searchParams.set("q", query);
  url.searchParams.set("rows", String(rows));
  return url;
}

function findFtsResource(packages, country) {
  for (const pkg of packages) {
    if (!packageMentionsCountry(pkg, country)) continue;
    for (const resource of pkg.resources || []) {
      const text = `${resource.name || ""} ${resource.description || ""} ${resource.url || ""} ${resource.format || ""}`.toLowerCase();
      if (resource.url && text.includes("csv") && /incoming|funding/.test(text)) return resource;
    }
  }
  return null;
}

function packageMentionsCountry(pkg, country) {
  const text = [pkg.name, pkg.title, pkg.notes, ...(pkg.groups || []).map((group) => `${group.name} ${group.title}`)].join(" ").toLowerCase();
  return text.includes(country.name.toLowerCase()) || text.includes(country.iso3.toLowerCase()) || text.includes(country.hdxGroup);
}

async function fetchJson(url, sourceId, options = {}) {
  const retries = options.retries || 0;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetchWithTimeout(url);
    const text = await response.text();
    if (response.status === 429 && attempt < retries) {
      await delay(options.retryDelayMs || 5000);
      continue;
    }
    if (!response.ok) throw new Error(`${sourceId} request failed ${response.status}: ${text.slice(0, 160)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${sourceId} returned non-JSON response.`);
    }
  }
  throw new Error(`${sourceId} request failed after retries.`);
}

async function fetchText(url, sourceId) {
  const response = await fetchWithTimeout(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`${sourceId} request failed ${response.status}: ${text.slice(0, 160)}`);
  return text;
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { "user-agent": "country-pulse-static-build/1.0" },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function parseCsv(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsv(lines[0]);
  return lines.slice(1).map((line) => {
    const values = splitCsv(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  });
}

function splitCsv(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === "\"" && quoted && next === "\"") {
      cell += "\"";
      index += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function sumTimeline(timeline, start, end) {
  return Math.round(flattenTimeline(timeline).reduce((sum, point) => {
    const stamp = parseTimelineDate(point.datetime || point.date || point.timestamp);
    if (Number.isNaN(stamp.getTime())) return sum;
    if (stamp >= start && stamp < end) return sum + numberValue(point.value);
    return sum;
  }, 0));
}

function flattenTimeline(timeline) {
  return timeline.flatMap((entry) => Array.isArray(entry.data) ? entry.data : entry);
}

function parseTimelineDate(value) {
  const text = String(value || "");
  const gdelt = text.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?Z?$/);
  if (gdelt) {
    const [, year, month, day, hour = "00", minute = "00", second = "00"] = gdelt;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  }
  return new Date(text);
}

function topBy(rows, labelField, valueField, limit) {
  const totals = new Map();
  for (const row of rows) {
    const label = row[labelField] || "Unknown";
    totals.set(label, (totals.get(label) || 0) + numberValue(row[valueField]));
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, amountUsd]) => ({ name, amountUsd: Math.round(amountUsd) }));
}

function fundingStatus(funding) {
  if (!funding) return "No comparable public value available for this filter.";
  if (funding.fundingCoveragePct !== null) return "Coverage comparable";
  if (funding.fundingReceived !== null) return "Received funding only";
  return "No comparable public value available for this filter.";
}

function trendLabel(value) {
  if (value === null || value === undefined) return "insufficient baseline";
  if (value >= 10) return "rising";
  if (value <= -10) return "falling";
  return "broadly stable";
}

function movementVerb(value) {
  if (value === null || value === undefined) return "could not be compared";
  if (value > 0) return "increased";
  if (value < 0) return "decreased";
  return "was unchanged";
}

function formatPctAbs(value) {
  if (value === null || value === undefined) return "without a comparable baseline";
  return `${Math.abs(round(value, 1))}%`;
}

function formatPct(value) {
  if (value === null || value === undefined) return "No comparable public value available";
  return `${round(value, 1)}%`;
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return "No comparable public value available";
  if (value >= 1_000_000_000) return `$${round(value / 1_000_000_000, 1)}B`;
  if (value >= 1_000_000) return `$${round(value / 1_000_000, 1)}M`;
  if (value >= 1_000) return `$${round(value / 1_000, 1)}K`;
  return `$${Math.round(value)}`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function pct(value, total) {
  return total > 0 ? round((value / total) * 100, 1) : null;
}

function numberValue(value) {
  const number = Number(String(value || "").replace(/,/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function latestDate(values) {
  const dates = values.map((value) => new Date(value)).filter((date) => !Number.isNaN(date.getTime())).sort((a, b) => b - a);
  return dates[0] ? isoDate(dates[0]) : null;
}

function uniqueLower(values) {
  return [...new Set(values.map((value) => String(value).toLowerCase()))];
}

function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dateWindows(now) {
  const last30 = addDays(now, -30);
  const previous30 = addDays(now, -60);
  const last90 = addDays(now, -90);
  return {
    todayDate: now,
    today: isoDate(now),
    last30: { start: last30, isoStart: isoDate(last30) },
    previous30: { start: previous30, isoStart: isoDate(previous30) },
    last90: { start: last90, isoStart: isoDate(last90), label: `${isoDate(last90)} to ${isoDate(now)}` }
  };
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printConnectorSummary() {
  console.log("Connector summary:");
  for (const result of connectorResults) {
    const detail = result.values.length ? `values=${result.values.join(",")}` : result.message;
    console.log(`- ${result.country} / ${result.sourceId}: ${result.status} ${detail}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
