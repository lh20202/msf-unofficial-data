#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const COUNTRIES_FILE = path.join(ROOT, "data", "countries.json");
const SOURCES_FILE = path.join(ROOT, "data", "sources.json");

const REQUIRED_COUNTRIES = ["sudan", "haiti"];
const REQUIRED_SOURCE_GROUPS = ["funding", "media", "reporting", "food", "humanitarian"];
const BANNED = [
  "MSF should",
  "recommended partner",
  "confirmed operational priority",
  "staff gap",
  "operational recommendation",
  "partner recommendation",
  "TODO",
  "placeholder",
  "Signals first. Editorial last.",
  "Stop reading briefs.",
  "Control surface",
  "Rolling public-signal delta",
  "Source unavailable in this build",
  "Awaiting data",
  "Low confidence: source unavailable in this build",
  "The dashboard can already",
  "Static public-source build",
  "Public signal coverage",
  "Use the controls",
  "Where it is weak",
  "Structured feeds should power the next version"
];

const errors = [];

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    errors.push(`Could not read ${path.relative(ROOT, filePath)}: ${error.message}`);
    return null;
  }
}

function validate() {
  const countriesData = readJson(COUNTRIES_FILE);
  const sourcesData = readJson(SOURCES_FILE);
  if (!countriesData || !sourcesData) return;

  string(countriesData.productName, "productName");
  string(countriesData.usp, "usp");
  string(countriesData.generatedAt, "generatedAt");
  string(countriesData.lastUpdated, "lastUpdated");

  if (!countriesData.controls || typeof countriesData.controls !== "object") {
    errors.push("controls object is required.");
  }

  if (!Array.isArray(countriesData.countries)) {
    errors.push("countries array is required.");
    return;
  }

  const ids = new Set(countriesData.countries.map((country) => country.id));
  for (const id of REQUIRED_COUNTRIES) {
    if (!ids.has(id)) errors.push(`Missing country ${id}.`);
  }

  for (const country of countriesData.countries) validateCountry(country);
  validateSources(sourcesData);
  validateNoBannedStrings(countriesData, "data/countries.json");
  validateNoBannedStrings(sourcesData, "data/sources.json");
}

function validateCountry(country) {
  string(country.id, "country.id");
  string(country.name, `country ${country.id} name`);
  string(country.iso3, `country ${country.id} iso3`);
  string(country.accent, `country ${country.id} accent`);
  string(country.lastUpdated, `country ${country.id} lastUpdated`);
  string(country.dataQuality, `country ${country.id} dataQuality`);

  if (!country.metrics || typeof country.metrics !== "object") {
    errors.push(`country ${country.id} metrics object is required.`);
  } else {
    const visibleCategories = Object.values(country.metrics).filter((metric) => metric && metric.available === true);
    if (visibleCategories.length < 2) {
      errors.push(`country ${country.id} must have at least 2 metric categories with real visible values.`);
    }
  }

  if (!Array.isArray(country.insights) || country.insights.length < 3) {
    errors.push(`country ${country.id} must have at least 3 insights.`);
  } else {
    for (const insight of country.insights) validateInsight(country, insight);
  }

  if (!Array.isArray(country.sourceGroups)) {
    errors.push(`country ${country.id} sourceGroups array is required.`);
  } else {
    const groupIds = new Set(country.sourceGroups.map((group) => group.id));
    for (const groupId of REQUIRED_SOURCE_GROUPS) {
      if (!groupIds.has(groupId)) errors.push(`country ${country.id} missing source group ${groupId}.`);
    }
  }
}

function validateInsight(country, insight) {
  string(insight.id, `country ${country.id} insight.id`);
  string(insight.theme, `country ${country.id} insight ${insight.id} theme`);
  string(insight.question, `country ${country.id} insight ${insight.id} question`);
  string(insight.headline, `country ${country.id} insight ${insight.id} headline`);
  string(insight.shortAnswer, `country ${country.id} insight ${insight.id} shortAnswer`);
  string(insight.comparisonBasis, `country ${country.id} insight ${insight.id} comparisonBasis`);
  string(insight.dateRange, `country ${country.id} insight ${insight.id} dateRange`);
  string(insight.confidenceLabel, `country ${country.id} insight ${insight.id} confidenceLabel`);
  string(insight.caveat, `country ${country.id} insight ${insight.id} caveat`);
  string(insight.methodCategory, `country ${country.id} insight ${insight.id} methodCategory`);
  if (!Array.isArray(insight.evidenceBullets) || insight.evidenceBullets.length < 2) {
    errors.push(`country ${country.id} insight ${insight.id} must have at least 2 evidence bullets.`);
  } else {
    for (const bullet of insight.evidenceBullets) string(bullet, `country ${country.id} insight ${insight.id} evidence`);
  }
  if (!Array.isArray(insight.sourceCategories)) {
    errors.push(`country ${country.id} insight ${insight.id} sourceCategories must be an array.`);
  }
}

function validateSources(sourcesData) {
  string(sourcesData.generatedAt, "sources.generatedAt");
  string(sourcesData.methodLine, "sources.methodLine");
  if (!Array.isArray(sourcesData.sourceGroups)) {
    errors.push("data/sources.json must contain sourceGroups array.");
    return;
  }
  const groupIds = new Set(sourcesData.sourceGroups.map((group) => group.id));
  for (const groupId of REQUIRED_SOURCE_GROUPS) {
    if (!groupIds.has(groupId)) errors.push(`sources missing group ${groupId}.`);
  }
  for (const group of sourcesData.sourceGroups) {
    string(group.id, "sourceGroup.id");
    string(group.label, `sourceGroup ${group.id} label`);
    string(group.publicBasis, `sourceGroup ${group.id} publicBasis`);
    string(group.contribution, `sourceGroup ${group.id} contribution`);
    string(group.dateRange, `sourceGroup ${group.id} dateRange`);
    string(group.limitations, `sourceGroup ${group.id} limitations`);
    if (typeof group.usedInVisibleInsights !== "boolean") {
      errors.push(`sourceGroup ${group.id} usedInVisibleInsights must be boolean.`);
    }
  }
}

function string(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${label} must be a non-empty string.`);
    return;
  }
  for (const phrase of BANNED) {
    if (value.toLowerCase().includes(phrase.toLowerCase())) {
      errors.push(`${label} contains banned phrase "${phrase}".`);
    }
  }
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0|\/var\/folders|\/users\/snoof/i.test(value)) {
    errors.push(`${label} contains a local/private reference.`);
  }
}

function validateNoBannedStrings(value, label) {
  const text = JSON.stringify(value);
  for (const phrase of BANNED) {
    if (text.toLowerCase().includes(phrase.toLowerCase())) {
      errors.push(`${label} contains banned phrase "${phrase}".`);
    }
  }
}

validate();

if (errors.length) {
  console.error("Content validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Content validation passed.");
