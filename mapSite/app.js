import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  CustomProvider,
  initializeAppCheck,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app-check.js";
import {
  collection,
  getFirestore,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { buildRecommendations, MIN_CLUSTER_SIZE } from "./analysis.js";
import { analyzeWithGemini } from "./gemini-analysis.js";
import { enrichSignalsWithRegions } from "./regions.js";

const firebaseApp = initializeApp(firebaseConfig);

if (import.meta.env.DEV && import.meta.env.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN) {
  self.FIREBASE_APPCHECK_DEBUG_TOKEN =
    import.meta.env.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN;
  initializeAppCheck(firebaseApp, {
    provider: new CustomProvider({
      getToken: async () => {
        throw new Error("The local App Check debug provider was not activated.");
      },
    }),
    isTokenAutoRefreshEnabled: true,
  });
}

const db = getFirestore(firebaseApp);
const status = document.querySelector("#status");
const liveDot = document.querySelector("#live-dot");
const signalCount = document.querySelector("#signal-count");
const analyzeButton = document.querySelector("#analyze-button");
const analysisStatus = document.querySelector("#analysis-status");
const recommendationsContainer = document.querySelector("#recommendations");
const analysisProgress = document.querySelector("#analysis-progress");
const analysisProgressBar = document.querySelector("#analysis-progress-bar");
const analysisProgressLabel = document.querySelector("#analysis-progress-label");
const generationPanel = document.querySelector("#generation-panel");
const generationText = document.querySelector("#generation-text");
const mapView = document.querySelector("#map-view");
const dataView = document.querySelector("#data-view");
const viewTabs = [...document.querySelectorAll("[data-view]")];
const returnToMapButton = document.querySelector("#return-to-map");
const dataReportCount = document.querySelector("#data-report-count");
const dataRegionCount = document.querySelector("#data-region-count");
const dataHighCount = document.querySelector("#data-high-count");
const dataCategoryCount = document.querySelector("#data-category-count");
const dataSearch = document.querySelector("#data-search");
const dataCategoryFilter = document.querySelector("#data-category-filter");
const dataSeverityFilter = document.querySelector("#data-severity-filter");
const dataScopeStatus = document.querySelector("#data-scope-status");
const dataAnalysisSection = document.querySelector("#data-analysis");
const dataAnalysisStatus = document.querySelector("#data-analysis-status");
const dataAnalysisProgress = document.querySelector("#data-analysis-progress");
const dataAnalysisProgressBar = document.querySelector("#data-analysis-progress-bar");
const dataAnalysisProgressLabel = document.querySelector("#data-analysis-progress-label");
const dataAnalysisOverview = document.querySelector("#data-analysis-overview");
const dataAnalysisSummary = document.querySelector("#data-analysis-summary");
const dataAnalysisResults = document.querySelector("#data-analysis-results");
const regionList = document.querySelector("#region-list");
const worldBounds = L.latLngBounds([[-85, -180], [85, 180]]);
const REGION_SIZE_DEGREES = 0.05;

const map = L.map("map", {
  maxBounds: worldBounds,
  maxBoundsViscosity: 1,
  minZoom: 4,
  zoomControl: true,
}).setView([37.7749, -122.4194], 11);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  bounds: worldBounds,
  maxZoom: 19,
  noWrap: true,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const markerLayer = L.layerGroup().addTo(map);
const recommendationLayer = L.layerGroup().addTo(map);
const regionBoundaryLayer = L.layerGroup().addTo(map);
let hasSetInitialView = false;
let allSignals = [];
let visibleSignals = [];
let analysisRequestId = 0;
let analysisRunning = false;
let regionResolutionId = 0;
let regionsResolving = false;
const regionalMiniMaps = new Set();
const placementMiniMaps = new Set();
let dataAnalysisRequestId = 0;
let dataAnalysisKey = "";
let dataAnalysisRunning = false;
let dataAnalysisRecommendations = [];
let dataAnalysisSummaries = [];
let dataAnalysisCompletedCount = 0;
let dataAnalysisFailedCount = 0;
const severityColors = {
  low: "#2f8a69",
  medium: "#d28b27",
  high: "#c34e42",
};

function isValidCoordinate(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

function safeText(value, fallback = "Not provided") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function formatSubmittedAt(submittedAt) {
  try {
    const date = typeof submittedAt?.toDate === "function"
      ? submittedAt.toDate()
      : new Date(submittedAt);

    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
  } catch {
    return "";
  }
}

function submittedAtMilliseconds(submittedAt) {
  try {
    const date = typeof submittedAt?.toDate === "function"
      ? submittedAt.toDate()
      : new Date(submittedAt);
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
  } catch {
    return 0;
  }
}

function formatCoordinate(value, positiveDirection, negativeDirection, decimals = 2) {
  const direction = value >= 0 ? positiveDirection : negativeDirection;
  return `${Math.abs(value).toFixed(decimals)}° ${direction}`;
}

function categoryLabel(category) {
  return safeText(category, "other").replaceAll("_", " ");
}

function getRegion(signal) {
  const south = Math.floor((signal.latitude + 90) / REGION_SIZE_DEGREES) *
    REGION_SIZE_DEGREES - 90;
  const west = Math.floor((signal.longitude + 180) / REGION_SIZE_DEGREES) *
    REGION_SIZE_DEGREES - 180;
  const north = south + REGION_SIZE_DEGREES;
  const east = west + REGION_SIZE_DEGREES;
  const centerLatitude = south + REGION_SIZE_DEGREES / 2;
  const centerLongitude = west + REGION_SIZE_DEGREES / 2;

  return {
    key: `${south.toFixed(2)}:${west.toFixed(2)}`,
    title: `${formatCoordinate(centerLatitude, "N", "S")} · ${formatCoordinate(centerLongitude, "E", "W")}`,
    boundsLabel: `${formatCoordinate(south, "N", "S")}–${formatCoordinate(north, "N", "S")} · ${formatCoordinate(west, "E", "W")}–${formatCoordinate(east, "E", "W")}`,
    bounds: [[south, west], [north, east]],
  };
}

function createReportDetails(signal, latitude, longitude) {
  const root = document.createElement("div");
  root.className = "signal-popup";

  const category = document.createElement("strong");
  category.textContent = safeText(signal.category, "Community signal").replaceAll("_", " ");

  const severity = document.createElement("small");
  severity.textContent = `${safeText(signal.severity, "unknown")} urgency`;

  root.append(category, severity);

  if (typeof signal.summary === "string" && signal.summary.trim()) {
    const summary = document.createElement("p");
    summary.textContent = signal.summary.trim();
    root.append(summary);
  }

  const metadata = document.createElement("dl");

  const locationLabel = document.createElement("dt");
  locationLabel.textContent = "Location";
  const locationValue = document.createElement("dd");
  locationValue.textContent = `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
  metadata.append(locationLabel, locationValue);

  const submittedAt = formatSubmittedAt(signal.submittedAt);
  if (submittedAt) {
    const dateLabel = document.createElement("dt");
    dateLabel.textContent = "Submitted";
    const dateValue = document.createElement("dd");
    dateValue.textContent = submittedAt;
    metadata.append(dateLabel, dateValue);
  }

  root.append(metadata);

  return root;
}

function createSignalMarker(signal) {
  const color = severityColors[signal.severity] || "#426f91";
  const marker = L.circleMarker([signal.latitude, signal.longitude], {
    radius: signal.severity === "high" ? 10 : 8,
    color,
    fillColor: color,
    fillOpacity: 0.8,
    weight: 2,
    className: "signal-marker",
  });

  marker.bindTooltip(
    () => createReportDetails(signal, signal.latitude, signal.longitude),
    {
      className: "signal-hover-card",
      direction: "top",
      interactive: false,
      offset: [0, -8],
      opacity: 1,
      sticky: true,
    },
  );
  marker.bindPopup(() =>
    createReportDetails(signal, signal.latitude, signal.longitude));
  marker.on("click", () => marker.closeTooltip());
  return marker;
}

function setActiveView(viewName) {
  const showMap = viewName === "map";
  mapView.hidden = !showMap;
  dataView.hidden = showMap;
  const nextHash = showMap ? "#map" : "#data";
  if (window.location.hash !== nextHash) {
    window.history.replaceState(null, "", nextHash);
  }

  viewTabs.forEach((tab) => {
    const isActive = tab.dataset.view === viewName;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });

  if (showMap) {
    requestAnimationFrame(() => map.invalidateSize());
  } else {
    renderDataView();
    renderDataAnalysis();
  }
}

function filteredDataSignals() {
  const query = dataSearch.value.trim().toLowerCase();
  const category = dataCategoryFilter.value;
  const severity = dataSeverityFilter.value;

  return allSignals.filter((signal) => {
    if (category !== "all" && signal.category !== category) return false;
    if (severity !== "all" && signal.severity !== severity) return false;
    if (query && !safeText(signal.summary, "").toLowerCase().includes(query)) return false;
    return true;
  });
}

function groupSignalsByRegion(signals) {
  const regions = new Map();

  signals.forEach((signal) => {
    const region = signal.region || getRegion(signal);
    const regionKey = region.id || region.key;
    if (!regions.has(regionKey)) {
      regions.set(regionKey, { ...region, signals: [] });
    }
    regions.get(regionKey).signals.push(signal);
  });

  const urgencyValue = { high: 3, medium: 2, low: 1 };
  return [...regions.values()].sort((first, second) => {
    const countDifference = second.signals.length - first.signals.length;
    if (countDifference) return countDifference;
    const firstUrgency = first.signals.reduce(
      (sum, signal) => sum + (urgencyValue[signal.severity] || 0),
      0,
    );
    const secondUrgency = second.signals.reduce(
      (sum, signal) => sum + (urgencyValue[signal.severity] || 0),
      0,
    );
    return secondUrgency - firstUrgency;
  });
}

function removeRegionalMiniMaps() {
  regionalMiniMaps.forEach((miniMap) => miniMap.remove());
  regionalMiniMaps.clear();
}

function removePlacementMiniMaps() {
  placementMiniMaps.forEach((miniMap) => miniMap.remove());
  placementMiniMaps.clear();
}

function setDataAnalysisProgress(value, label) {
  dataAnalysisProgress.hidden = false;
  dataAnalysisProgressBar.style.width = `${Math.max(0, Math.min(100, value))}%`;
  dataAnalysisProgressLabel.textContent = label;
}

function setDataAnalysisStatus(message) {
  dataAnalysisStatus.textContent = message;
}

function recommendationPriority(recommendation) {
  const maximumScore = Math.max(1, recommendation.signals.length * 3);
  const ratio = recommendation.urgencyScore / maximumScore;
  if (ratio >= 0.75) return { label: "High priority", className: "high" };
  if (ratio >= 0.5) return { label: "Medium priority", className: "medium" };
  return { label: "Standard priority", className: "standard" };
}

function regionContextLabel(region) {
  const parts = [];
  if (region?.rurality) parts.push(region.rurality);
  if (Number.isFinite(region?.densityPerKm2)) {
    parts.push(`${Math.round(region.densityPerKm2).toLocaleString()}/km²`);
  } else if (Number.isFinite(region?.areaKm2)) {
    parts.push(`${Math.round(region.areaKm2).toLocaleString()} km²`);
  }
  return parts.join(" · ") || safeText(region?.type, "Named region");
}

function cleanAnalysisItems(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  const items = value
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim());
  return items.length ? items : fallback;
}

function reportIdentity(signal) {
  return String(signal.id || `${signal.latitude}:${signal.longitude}:${signal.summary || ""}`);
}

function recommendationEvidence(recommendation) {
  const signalsById = new Map(
    recommendation.signals.map((signal) => [reportIdentity(signal), signal]),
  );
  const usedSignals = new Set();
  const resolved = [];

  if (Array.isArray(recommendation.analysis?.evidence)) {
    recommendation.analysis.evidence.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const reportId = String(item.reportId || item.signalId || item.id || "");
      const reference = safeText(
        item.citation || item.evidenceId || item.ref,
        `R${index + 1}`,
      ).replaceAll(/[^a-zA-Z0-9_-]/g, "");
      const numericReference = Number(reference.match(/\d+/)?.[0]);
      const signal = signalsById.get(reportId) ||
        (Number.isInteger(numericReference)
          ? recommendation.signals[numericReference - 1]
          : null);
      if (!signal || usedSignals.has(signal)) return;
      usedSignals.add(signal);
      resolved.push({
        reference: reference || `R${resolved.length + 1}`,
        signal,
        relevance: safeText(item.relevance, "This report supports the identified need."),
      });
    });
  }

  if (resolved.length) return resolved;

  return [...recommendation.signals]
    .sort((first, second) =>
      (severityWeightsForDisplay(second.severity) - severityWeightsForDisplay(first.severity)) ||
      submittedAtMilliseconds(second.submittedAt) - submittedAtMilliseconds(first.submittedAt))
    .map((signal, index) => ({
      reference: `R${index + 1}`,
      signal,
      relevance: "This submitted summary is part of the repeated demand pattern.",
    }));
}

function severityWeightsForDisplay(severity) {
  return { low: 1, medium: 2, high: 3 }[severity] || 1;
}

function createAnalysisList(items) {
  const list = document.createElement("ul");
  items.forEach((item) => {
    const row = document.createElement("li");
    row.textContent = item;
    list.append(row);
  });
  return list;
}

function createAnalysisDetailCard(titleText, content, fallback) {
  const section = document.createElement("section");
  section.className = "analysis-detail-card";
  const title = document.createElement("h4");
  title.textContent = titleText;
  section.append(title);

  const items = cleanAnalysisItems(content);
  if (items.length) {
    section.append(createAnalysisList(items));
  } else {
    const paragraph = document.createElement("p");
    paragraph.textContent = safeText(content, fallback);
    section.append(paragraph);
  }
  return section;
}

function initializePlacementMiniMap(container, recommendation, evidence) {
  if (container.dataset.initialized === "true" || !container.isConnected ||
      container.offsetWidth === 0 || container.offsetHeight === 0) return;
  container.dataset.initialized = "true";

  const displayBounds = L.latLngBounds([
    ...recommendation.signals.map((signal) => [signal.latitude, signal.longitude]),
    [recommendation.position.latitude, recommendation.position.longitude],
  ]);
  if (recommendation.region?.geometry) {
    displayBounds.extend(L.geoJSON(recommendation.region.geometry).getBounds());
  }

  const miniMap = L.map(container, {
    attributionControl: true,
    zoomControl: true,
    dragging: true,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: true,
    tap: false,
  });
  placementMiniMaps.add(miniMap);

  if (displayBounds.isValid() &&
      !displayBounds.getNorthEast().equals(displayBounds.getSouthWest())) {
    miniMap.fitBounds(displayBounds, { padding: [20, 20], maxZoom: 13 });
  } else {
    miniMap.setView(
      [recommendation.position.latitude, recommendation.position.longitude],
      13,
    );
  }

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    bounds: worldBounds,
    maxZoom: 19,
    noWrap: true,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(miniMap);

  if (recommendation.region?.geometry) {
    L.geoJSON(recommendation.region.geometry, {
      style: {
        color: "#6336a5",
        fillColor: "#8d67bb",
        fillOpacity: 0.1,
        weight: 2,
      },
    }).addTo(miniMap);
  }

  const evidenceReferences = new Map(
    evidence.map((item) => [item.signal, item.reference]),
  );
  recommendation.signals.forEach((signal) => {
    const color = severityColors[signal.severity] || "#426f91";
    const reference = evidenceReferences.get(signal);
    L.circleMarker([signal.latitude, signal.longitude], {
      radius: signal.severity === "high" ? 7 : 6,
      color: "#fff",
      fillColor: color,
      fillOpacity: 0.95,
      weight: 1.5,
    }).bindTooltip(
      `${reference ? `[${reference}] · ` : ""}${safeText(signal.severity, "unknown")} urgency`,
      { direction: "top" },
    ).addTo(miniMap);
  });

  const icon = L.divIcon({
    className: "",
    html: '<span class="recommendation-marker" aria-hidden="true">✦</span>',
    iconAnchor: [17, 17],
    iconSize: [34, 34],
  });
  L.marker(
    [recommendation.position.latitude, recommendation.position.longitude],
    { icon, title: `Candidate location for ${recommendation.analysis.facilityType}` },
  ).bindTooltip(`Candidate: ${recommendation.analysis.facilityType}`, {
    direction: "top",
  }).addTo(miniMap);
}

function initializeRegionalMiniMap(container, region) {
  if (container.dataset.initialized === "true" || !container.isConnected ||
      container.offsetWidth === 0 || container.offsetHeight === 0) return;
  container.dataset.initialized = "true";

  let displayBounds;
  if (region.geometry) {
    displayBounds = L.geoJSON(region.geometry).getBounds();
  } else {
    displayBounds = L.latLngBounds(
      region.signals.map((signal) => [signal.latitude, signal.longitude]),
    );
  }

  const miniMap = L.map(container, {
    attributionControl: true,
    zoomControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    tap: false,
  });
  regionalMiniMaps.add(miniMap);

  if (displayBounds.isValid()) {
    if (displayBounds.getNorthEast().equals(displayBounds.getSouthWest())) {
      miniMap.setView(displayBounds.getCenter(), 12);
    } else {
      miniMap.fitBounds(displayBounds, { padding: [18, 18], maxZoom: 12 });
    }
  } else {
    miniMap.setView([0, 0], 2);
  }

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    bounds: worldBounds,
    maxZoom: 19,
    noWrap: true,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(miniMap);

  if (region.geometry) {
    L.geoJSON(region.geometry, {
      style: {
        color: "#6336a5",
        fillColor: "#8d67bb",
        fillOpacity: 0.13,
        weight: 2,
      },
    }).addTo(miniMap);
  }

  region.signals.forEach((signal) => {
    const color = severityColors[signal.severity] || "#426f91";
    L.circleMarker([signal.latitude, signal.longitude], {
      radius: signal.severity === "high" ? 6 : 5,
      color: "#fff",
      fillColor: color,
      fillOpacity: 0.95,
      weight: 1.5,
    }).bindTooltip(categoryLabel(signal.category), { direction: "top" })
      .addTo(miniMap);
  });

}

function syncCategoryFilterOptions() {
  const selected = dataCategoryFilter.value;
  const categories = [...new Set(allSignals.map((signal) => signal.category || "other"))]
    .sort((first, second) => categoryLabel(first).localeCompare(categoryLabel(second)));

  dataCategoryFilter.replaceChildren();
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "All categories";
  dataCategoryFilter.append(allOption);

  categories.forEach((category) => {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = categoryLabel(category);
    dataCategoryFilter.append(option);
  });

  dataCategoryFilter.value = categories.includes(selected) ? selected : "all";
}

function createReportDataCard(signal) {
  const card = document.createElement("article");
  card.className = "report-data-card";
  const main = document.createElement("div");
  main.className = "report-data-main";
  const metadata = document.createElement("div");
  metadata.className = "report-data-meta";
  const urgency = document.createElement("span");
  urgency.className = `urgency-pill ${safeText(signal.severity, "unknown")}`;
  urgency.textContent = `${safeText(signal.severity, "unknown")} urgency`;
  const submitted = document.createElement("span");
  submitted.textContent = formatSubmittedAt(signal.submittedAt) || "Submission time unavailable";
  metadata.append(urgency, submitted);

  const summary = document.createElement("p");
  summary.textContent = safeText(signal.summary, "No description provided");
  const location = document.createElement("div");
  location.className = "report-data-location";
  const regionName = signal.region?.name ? ` · ${signal.region.name}` : "";
  location.textContent = `Approximate location ${formatCoordinate(signal.latitude, "N", "S", 4)}, ${formatCoordinate(signal.longitude, "E", "W", 4)}${regionName} · ${signal.locationPrecision === "approximate_grid_500m" ? "500 m privacy grid" : "demo coordinate"}`;
  main.append(metadata, summary, location);

  const mapButton = document.createElement("button");
  mapButton.type = "button";
  mapButton.className = "report-map-button";
  mapButton.textContent = "View on map";
  mapButton.addEventListener("click", () => {
    setActiveView("map");
    requestAnimationFrame(() => {
      map.setView([signal.latitude, signal.longitude], Math.max(map.getZoom(), 14));
    });
  });

  card.append(main, mapButton);
  return card;
}

function createRegionCard(region, index) {
  const regionDisplayName = region.name || `Region ${region.title}`;
  const card = document.createElement("details");
  card.className = "region-card";
  card.open = index === 0;
  const summary = document.createElement("summary");
  const heading = document.createElement("div");
  heading.className = "region-heading";
  const title = document.createElement("strong");
  title.textContent = regionDisplayName;
  const bounds = document.createElement("span");
  bounds.textContent = region.hierarchy || region.boundsLabel;
  heading.append(title, bounds);

  const summaryStats = document.createElement("div");
  summaryStats.className = "region-summary";
  const reportChip = document.createElement("span");
  reportChip.className = "data-chip";
  reportChip.textContent = `${region.signals.length} report${region.signals.length === 1 ? "" : "s"}`;
  summaryStats.append(reportChip);
  const highCount = region.signals.filter((signal) => signal.severity === "high").length;
  if (highCount) {
    const highChip = document.createElement("span");
    highChip.className = "data-chip high";
    highChip.textContent = `${highCount} high`;
    summaryStats.append(highChip);
  }
  if (Number.isFinite(region.densityPerKm2)) {
    const densityChip = document.createElement("span");
    densityChip.className = "data-chip";
    densityChip.textContent = `${Math.round(region.densityPerKm2).toLocaleString()}/km²`;
    summaryStats.append(densityChip);
  } else if (region.rurality) {
    const ruralityChip = document.createElement("span");
    ruralityChip.className = "data-chip";
    ruralityChip.textContent = region.rurality;
    summaryStats.append(ruralityChip);
  }
  summary.append(heading, summaryStats);

  const body = document.createElement("div");
  body.className = "region-body";
  const actions = document.createElement("div");
  actions.className = "region-actions";
  const newestTime = Math.max(...region.signals.map((signal) => submittedAtMilliseconds(signal.submittedAt)));
  const newest = document.createElement("span");
  newest.textContent = newestTime
    ? `Newest report ${new Date(newestTime).toLocaleString()}`
    : "Report dates unavailable";
  const mapButton = document.createElement("button");
  mapButton.type = "button";
  mapButton.className = "region-map-button";
  mapButton.textContent = "Show region on map";
  mapButton.addEventListener("click", () => {
    setActiveView("map");
    requestAnimationFrame(() => map.fitBounds(region.bounds, { padding: [35, 35] }));
  });
  actions.append(newest, mapButton);
  body.append(actions);

  const miniMap = document.createElement("div");
  miniMap.className = "region-mini-map";
  miniMap.setAttribute("role", "img");
  miniMap.setAttribute("aria-label", `Small map of ${regionDisplayName}`);
  body.append(miniMap);

  const showMiniMap = () => {
    if (!card.open) return;
    requestAnimationFrame(() => initializeRegionalMiniMap(miniMap, region));
  };
  card.addEventListener("toggle", showMiniMap);

  const categoryGroups = new Map();
  region.signals.forEach((signal) => {
    const category = signal.category || "other";
    if (!categoryGroups.has(category)) categoryGroups.set(category, []);
    categoryGroups.get(category).push(signal);
  });

  [...categoryGroups.entries()]
    .sort((first, second) => second[1].length - first[1].length ||
      categoryLabel(first[0]).localeCompare(categoryLabel(second[0])))
    .forEach(([category, signals]) => {
      const section = document.createElement("section");
      section.className = "category-data-group";
      const sectionHeading = document.createElement("h3");
      sectionHeading.className = "category-data-heading";
      sectionHeading.textContent = categoryLabel(category);
      const count = document.createElement("span");
      count.textContent = `${signals.length} report${signals.length === 1 ? "" : "s"}`;
      sectionHeading.append(count);
      const list = document.createElement("div");
      list.className = "report-data-list";
      signals
        .sort((first, second) => {
          const urgency = { high: 3, medium: 2, low: 1 };
          return (urgency[second.severity] || 0) - (urgency[first.severity] || 0) ||
            submittedAtMilliseconds(second.submittedAt) - submittedAtMilliseconds(first.submittedAt);
        })
        .forEach((signal) => list.append(createReportDataCard(signal)));
      section.append(sectionHeading, list);
      body.append(section);
    });

  card.append(summary, body);
  card.initializeMiniMap = showMiniMap;
  return card;
}

function createFactor(labelText, valueText) {
  const wrapper = document.createElement("div");
  const label = document.createElement("dt");
  label.textContent = labelText;
  const value = document.createElement("dd");
  value.textContent = valueText;
  wrapper.append(label, value);
  return wrapper;
}

function createScoreRow(labelText, value, displayText) {
  const row = document.createElement("div");
  row.className = "placement-score-row";
  const heading = document.createElement("div");
  const label = document.createElement("span");
  label.textContent = labelText;
  const score = document.createElement("strong");
  score.textContent = displayText;
  heading.append(label, score);
  const track = document.createElement("div");
  track.className = "placement-score-track";
  const fill = document.createElement("span");
  fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
  track.append(fill);
  row.append(heading, track);
  return row;
}

function showAutomaticPlacementOnMap(recommendation) {
  renderRecommendations(dataAnalysisRecommendations);
  generationPanel.hidden = !dataAnalysisSummaries.length;
  generationText.textContent = dataAnalysisSummaries.join("\n\n");
  setAnalysisProgress(100, "Automatic all-report analysis loaded.");
  setAnalysisStatus(
    `Showing ${dataAnalysisRecommendations.length} automatic all-report placement recommendation${dataAnalysisRecommendations.length === 1 ? "" : "s"}.`,
  );
  setActiveView("map");
  requestAnimationFrame(() => {
    map.setView(
      [recommendation.position.latitude, recommendation.position.longitude],
      Math.max(map.getZoom(), 14),
    );
  });
}

function createPlacementBrief(recommendation, index) {
  const analysis = recommendation.analysis || {};
  const evidence = recommendationEvidence(recommendation);
  const priority = analysis.priority
    ? {
        label: `${analysis.priority[0].toUpperCase()}${analysis.priority.slice(1)} priority`,
        className: ["critical", "high"].includes(analysis.priority)
          ? "high"
          : analysis.priority === "medium" ? "medium" : "standard",
      }
    : recommendationPriority(recommendation);
  const confidence = Number.isFinite(analysis.confidence)
    ? Math.round(analysis.confidence * 100)
    : 0;
  const highUrgencyCount = recommendation.signals.filter(
    (signal) => signal.severity === "high",
  ).length;
  const urgencyPercent = Math.round(
    recommendation.urgencyScore / Math.max(1, recommendation.signals.length * 3) * 100,
  );

  const article = document.createElement("article");
  article.className = "placement-brief";

  const header = document.createElement("header");
  header.className = "placement-brief-header";
  const heading = document.createElement("div");
  const kicker = document.createElement("p");
  kicker.className = "placement-kicker";
  kicker.textContent = `Priority ${index + 1} · ${categoryLabel(recommendation.category)} · ${recommendation.region.name}`;
  const title = document.createElement("h3");
  title.textContent = safeText(analysis.facilityType, "Community service center");
  heading.append(kicker, title);

  const badges = document.createElement("div");
  badges.className = "placement-badges";
  const priorityBadge = document.createElement("span");
  priorityBadge.className = `priority-badge ${priority.className}`;
  priorityBadge.textContent = priority.label;
  const confidenceBadge = document.createElement("span");
  confidenceBadge.className = "confidence-badge";
  confidenceBadge.textContent = `${confidence}% confidence`;
  badges.append(priorityBadge, confidenceBadge);
  header.append(heading, badges);

  const grid = document.createElement("div");
  grid.className = "placement-grid";
  const content = document.createElement("div");
  content.className = "placement-content";
  const lead = document.createElement("p");
  lead.className = "placement-lead";
  lead.textContent = safeText(
    analysis.decisionSummary || analysis.rationale,
    `${recommendation.signals.length} reports indicate a repeated service need in ${recommendation.region.name}.`,
  );

  const factors = document.createElement("dl");
  factors.className = "factor-grid";
  factors.append(
    createFactor("Reports", String(recommendation.signals.length)),
    createFactor("High urgency", String(highUrgencyCount)),
    createFactor("Urgency score", String(recommendation.urgencyScore)),
    createFactor("Region context", regionContextLabel(recommendation.region)),
  );

  const details = document.createElement("div");
  details.className = "analysis-detail-grid";
  details.append(
    createAnalysisDetailCard(
      "Observed need",
      analysis.needAnalysis,
      `Repeated ${categoryLabel(recommendation.category)} summaries form a candidate service pattern in this region.`,
    ),
    createAnalysisDetailCard(
      "Why this placement",
      analysis.placementRationale,
      `The point is the urgency-weighted geographic median of the reports and remains inside ${recommendation.region.name}.`,
    ),
    createAnalysisDetailCard(
      "Recommended service design",
      analysis.serviceComponents,
      `Develop a ${safeText(analysis.facilityType, "community service").toLowerCase()} sized to validated local demand.`,
    ),
    createAnalysisDetailCard(
      "Expected impact",
      analysis.expectedImpact,
      "Reduce aggregate distance between the reported needs and the proposed service.",
    ),
  );

  const checks = document.createElement("div");
  checks.className = "placement-checks";
  const implementation = document.createElement("section");
  const implementationTitle = document.createElement("h4");
  implementationTitle.textContent = "Implementation path";
  implementation.append(
    implementationTitle,
    createAnalysisList(cleanAnalysisItems(analysis.implementationSteps, [
      "Validate demand with residents and existing providers.",
      "Review parcels, access, cost, capacity, safety, and zoning near this search point.",
    ])),
  );

  const riskSection = document.createElement("section");
  const riskTitle = document.createElement("h4");
  riskTitle.textContent = "Risks, mitigation, and limits";
  const risks = Array.isArray(analysis.risksAndMitigations)
    ? analysis.risksAndMitigations
      .filter((item) => item?.risk && item?.mitigation)
      .map((item) => `${item.risk} Mitigation: ${item.mitigation}`)
    : [];
  const limitations = cleanAnalysisItems(analysis.limitations);
  riskSection.append(
    riskTitle,
    createAnalysisList([...risks, ...limitations].length
      ? [...risks, ...limitations]
      : ["This is a planning search center; site feasibility still requires human review."]),
  );
  checks.append(implementation, riskSection);

  const evidencePanel = document.createElement("section");
  evidencePanel.className = "evidence-panel";
  const evidenceTitle = document.createElement("h4");
  evidenceTitle.textContent = `Report evidence cited (${evidence.length})`;
  const evidenceList = document.createElement("ol");
  evidenceList.className = "evidence-list";
  evidence.forEach(({ reference, signal, relevance }) => {
    const item = document.createElement("li");
    item.className = "evidence-item";
    const referenceBadge = document.createElement("span");
    referenceBadge.className = "evidence-ref";
    referenceBadge.textContent = reference;
    const copy = document.createElement("div");
    copy.className = "evidence-copy";
    const quote = document.createElement("blockquote");
    quote.textContent = safeText(signal.summary, "No summary provided");
    const citation = document.createElement("cite");
    const submittedAt = formatSubmittedAt(signal.submittedAt);
    citation.textContent = `${safeText(signal.severity, "unknown")} urgency${submittedAt ? ` · ${submittedAt}` : ""}`;
    const relevanceText = document.createElement("p");
    relevanceText.className = "evidence-relevance";
    relevanceText.textContent = relevance;
    const mapButton = document.createElement("button");
    mapButton.type = "button";
    mapButton.className = "evidence-map-button";
    mapButton.textContent = "View cited report on map";
    mapButton.addEventListener("click", () => {
      setActiveView("map");
      requestAnimationFrame(() => map.setView(
        [signal.latitude, signal.longitude],
        Math.max(map.getZoom(), 14),
      ));
    });
    copy.append(quote, citation, relevanceText, mapButton);
    item.append(referenceBadge, copy);
    evidenceList.append(item);
  });
  evidencePanel.append(evidenceTitle, evidenceList);

  content.append(lead, factors, details, checks, evidencePanel);

  const mapColumn = document.createElement("aside");
  mapColumn.className = "placement-map-column";
  const sticky = document.createElement("div");
  sticky.className = "placement-map-sticky";
  const scores = document.createElement("div");
  scores.className = "placement-scores";
  scores.append(
    createScoreRow("Evidence confidence", confidence, `${confidence}%`),
    createScoreRow("Urgency intensity", urgencyPercent, `${urgencyPercent}%`),
  );
  const miniMap = document.createElement("div");
  miniMap.className = "placement-mini-map";
  miniMap.setAttribute("role", "img");
  miniMap.setAttribute(
    "aria-label",
    `Candidate placement and cited reports in ${recommendation.region.name}`,
  );
  const coordinate = document.createElement("p");
  coordinate.className = "placement-coordinate";
  coordinate.textContent = `${recommendation.position.latitude.toFixed(4)}, ${recommendation.position.longitude.toFixed(4)}`;
  const caption = document.createElement("p");
  caption.className = "placement-map-caption";
  caption.textContent = "Purple star: computed candidate · Colored dots: reports · Outline: verified region. The point is approximate, not a selected parcel.";
  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.className = "placement-map-button";
  openButton.textContent = "Open placement on main map";
  openButton.addEventListener("click", () => showAutomaticPlacementOnMap(recommendation));
  sticky.append(scores, miniMap, coordinate, caption, openButton);
  mapColumn.append(sticky);

  grid.append(content, mapColumn);
  article.append(header, grid);
  article.initializeMiniMap = () => requestAnimationFrame(() =>
    initializePlacementMiniMap(miniMap, recommendation, evidence));
  return article;
}

function renderDataAnalysis() {
  removePlacementMiniMaps();
  dataAnalysisResults.replaceChildren();
  dataAnalysisOverview.replaceChildren();
  dataAnalysisSummary.replaceChildren();
  dataAnalysisSection.setAttribute("aria-busy", String(dataAnalysisRunning));

  if (!dataAnalysisRecommendations.length) {
    dataAnalysisOverview.hidden = true;
    dataAnalysisSummary.hidden = true;
    const empty = document.createElement("div");
    empty.className = "data-analysis-empty";
    empty.textContent = regionsResolving
      ? "Named regions are still loading. Analysis will begin automatically."
      : allSignals.length
        ? `No named region and category currently has at least ${MIN_CLUSTER_SIZE} reports for placement analysis.`
        : "No reports are available for placement analysis yet.";
    dataAnalysisResults.append(empty);
    return;
  }

  const uniqueReports = new Set(
    dataAnalysisRecommendations.flatMap((recommendation) =>
      recommendation.signals.map(reportIdentity)),
  );
  const uniqueRegions = new Set(
    dataAnalysisRecommendations.map((recommendation) => recommendation.region.id),
  );
  const highPriorityCount = dataAnalysisRecommendations.filter((recommendation) =>
    ["critical", "high"].includes(recommendation.analysis?.priority) ||
    recommendationPriority(recommendation).className === "high").length;
  const overviewItems = [
    [String(dataAnalysisRecommendations.length), "candidate placements"],
    [String(highPriorityCount), "high-priority needs"],
    [String(uniqueReports.size), "reports used as evidence"],
    [String(uniqueRegions.size), "regions represented"],
  ];
  overviewItems.forEach(([value, label]) => {
    const card = document.createElement("article");
    const strong = document.createElement("strong");
    strong.textContent = value;
    const span = document.createElement("span");
    span.textContent = label;
    card.append(strong, span);
    dataAnalysisOverview.append(card);
  });
  dataAnalysisOverview.hidden = false;

  if (dataAnalysisSummaries.length) {
    const heading = document.createElement("h3");
    heading.textContent = "Portfolio readout";
    dataAnalysisSummary.append(heading);
    if (dataAnalysisSummaries.length === 1) {
      const paragraph = document.createElement("p");
      paragraph.textContent = dataAnalysisSummaries[0];
      dataAnalysisSummary.append(paragraph);
    } else {
      dataAnalysisSummary.append(createAnalysisList(dataAnalysisSummaries));
    }
    dataAnalysisSummary.hidden = false;
  } else {
    dataAnalysisSummary.hidden = true;
  }

  dataAnalysisRecommendations.forEach((recommendation, index) => {
    const card = createPlacementBrief(recommendation, index);
    dataAnalysisResults.append(card);
    card.initializeMiniMap();
  });
}

function automaticDataAnalysisKey(recommendations) {
  return JSON.stringify(
    recommendations.map((recommendation) => ({
      id: recommendation.id,
      reports: recommendation.signals
        .map((signal) => ({
          id: reportIdentity(signal),
          category: signal.category || "other",
          severity: signal.severity || "unknown",
          summary: signal.summary || "",
          latitude: signal.latitude,
          longitude: signal.longitude,
          regionId: signal.region?.id || "",
        }))
        .sort((first, second) => first.id.localeCompare(second.id)),
    })),
  );
}

function mergeAnalyzedRecommendations(currentRecommendations, analyzedRecommendations) {
  const analyzedById = new Map(
    analyzedRecommendations.map((recommendation) => [recommendation.id, recommendation]),
  );
  return currentRecommendations.map((recommendation) =>
    analyzedById.get(recommendation.id) || recommendation);
}

function resetAutomaticDataAnalysis(message) {
  dataAnalysisRequestId += 1;
  dataAnalysisKey = "";
  dataAnalysisRunning = false;
  dataAnalysisRecommendations = [];
  dataAnalysisSummaries = [];
  dataAnalysisCompletedCount = 0;
  dataAnalysisFailedCount = 0;
  dataAnalysisProgress.hidden = true;
  dataAnalysisProgressBar.style.width = "0%";
  setDataAnalysisStatus(message);
  renderDataAnalysis();
}

async function runAutomaticDataAnalysis(signals) {
  const recommendations = buildRecommendations(signals);
  const key = automaticDataAnalysisKey(recommendations);
  const requestId = dataAnalysisRequestId + 1;
  dataAnalysisRequestId = requestId;
  dataAnalysisKey = key;
  dataAnalysisRunning = recommendations.length > 0;
  dataAnalysisRecommendations = recommendations;
  dataAnalysisSummaries = [];
  dataAnalysisCompletedCount = 0;
  dataAnalysisFailedCount = 0;

  if (!recommendations.length) {
    dataAnalysisProgress.hidden = true;
    setDataAnalysisStatus(
      `No named region and category has at least ${MIN_CLUSTER_SIZE} reports yet. Analysis will update when the data changes.`,
    );
    renderDataAnalysis();
    return;
  }

  setDataAnalysisStatus(
    `Found ${recommendations.length} candidate placement${recommendations.length === 1 ? "" : "s"}. Loading detailed evidence analysis automatically…`,
  );
  setDataAnalysisProgress(12, "Calculating urgency-weighted candidate points…");
  renderDataAnalysis();

  const batchSize = 4;
  const batches = [];
  for (let index = 0; index < recommendations.length; index += batchSize) {
    batches.push(recommendations.slice(index, index + batchSize));
  }

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    if (requestId !== dataAnalysisRequestId || key !== dataAnalysisKey) return;
    const batch = batches[batchIndex];
    const batchStart = 18 + batchIndex / batches.length * 72;
    const batchEnd = 18 + (batchIndex + 1) / batches.length * 72;
    let streamedCharacters = 0;
    setDataAnalysisProgress(
      batchStart,
      `Gemini is analyzing placement ${batchIndex * batchSize + 1}–${Math.min((batchIndex + 1) * batchSize, recommendations.length)} of ${recommendations.length}…`,
    );

    try {
      const result = await analyzeWithGemini(firebaseApp, batch, {
        onText: (text, { reset } = {}) => {
          if (requestId !== dataAnalysisRequestId || key !== dataAnalysisKey) return;
          if (reset) streamedCharacters = 0;
          streamedCharacters += text?.length || 0;
          const streamProgress = Math.min(
            batchEnd - 3,
            batchStart + 8 + Math.log10(streamedCharacters + 1) * 8,
          );
          setDataAnalysisProgress(
            streamProgress,
            "Gemini is organizing needs, placement factors, and report citations…",
          );
        },
      });
      if (requestId !== dataAnalysisRequestId || key !== dataAnalysisKey) return;
      dataAnalysisRecommendations = mergeAnalyzedRecommendations(
        dataAnalysisRecommendations,
        result.recommendations,
      );
      if (result.summary) dataAnalysisSummaries.push(result.summary);
      dataAnalysisCompletedCount += batch.length;
    } catch (error) {
      if (requestId !== dataAnalysisRequestId || key !== dataAnalysisKey) return;
      console.error("NeedMap automatic data analysis error:", error);
      dataAnalysisFailedCount += batch.length;
    }

    setDataAnalysisProgress(
      batchEnd,
      `${Math.min((batchIndex + 1) * batchSize, recommendations.length)} of ${recommendations.length} placements analyzed.`,
    );
    renderDataAnalysis();
  }

  if (requestId !== dataAnalysisRequestId || key !== dataAnalysisKey) return;
  dataAnalysisRunning = false;
  setDataAnalysisProgress(100, "Automatic placement analysis complete.");
  setDataAnalysisStatus(
    dataAnalysisFailedCount
      ? `Detailed Gemini analysis completed for ${dataAnalysisCompletedCount} of ${recommendations.length} placements. Evidence-backed local analysis is shown for the rest.`
      : `Detailed evidence analysis is ready for all ${recommendations.length} candidate placement${recommendations.length === 1 ? "" : "s"}.`,
  );
  renderDataAnalysis();
}

function renderDataView() {
  const filteredSignals = filteredDataSignals();
  const regions = groupSignalsByRegion(filteredSignals);
  const uniqueCategories = new Set(filteredSignals.map((signal) => signal.category || "other"));

  dataReportCount.textContent = String(filteredSignals.length);
  dataRegionCount.textContent = String(regions.length);
  dataHighCount.textContent = String(
    filteredSignals.filter((signal) => signal.severity === "high").length,
  );
  dataCategoryCount.textContent = String(uniqueCategories.size);
  dataScopeStatus.textContent = regionsResolving
    ? `Resolving names and boundaries for ${allSignals.length} reports…`
    : `${filteredSignals.length} of ${allSignals.length} reports shown across all regions.`;
  removeRegionalMiniMaps();
  regionList.replaceChildren();

  if (!regions.length) {
    const empty = document.createElement("div");
    empty.className = "empty-data";
    empty.textContent = allSignals.length
      ? "No reports match these filters."
      : "No reports are available yet.";
    regionList.append(empty);
    return;
  }

  regions.forEach((region, index) => {
    const card = createRegionCard(region, index);
    regionList.append(card);
    card.initializeMiniMap();
  });
}

function analysisAvailabilityMessage() {
  if (regionsResolving) {
    return "Resolving named region boundaries before analysis…";
  }
  return visibleSignals.length < MIN_CLUSTER_SIZE
    ? `Move the map to an area with at least ${MIN_CLUSTER_SIZE} reports to run placement analysis.`
    : `${visibleSignals.length} reports in the current view are ready for Gemini analysis.`;
}

function invalidateAnalysis(message = analysisAvailabilityMessage()) {
  analysisRequestId += 1;
  analysisRunning = false;
  recommendationLayer.clearLayers();
  regionBoundaryLayer.clearLayers();
  recommendationsContainer.replaceChildren();
  resetGeneration();
  analysisProgress.hidden = true;
  analysisProgressBar.style.width = "0%";
  analyzeButton.disabled = regionsResolving || visibleSignals.length < MIN_CLUSTER_SIZE;
  setAnalysisStatus(message);
}

function refreshViewportState({ invalidateCurrentAnalysis = false } = {}) {
  const bounds = map.getBounds();
  visibleSignals = allSignals.filter((signal) =>
    bounds.contains([signal.latitude, signal.longitude]));

  markerLayer.clearLayers();
  visibleSignals.forEach((signal) => createSignalMarker(signal).addTo(markerLayer));
  signalCount.textContent = String(visibleSignals.length);
  syncCategoryFilterOptions();
  renderDataView();

  if (invalidateCurrentAnalysis) {
    invalidateAnalysis();
    return;
  }

  analyzeButton.disabled =
    analysisRunning || regionsResolving || visibleSignals.length < MIN_CLUSTER_SIZE;
  if (!analysisRunning && !recommendationsContainer.childElementCount) {
    setAnalysisStatus(analysisAvailabilityMessage());
  }
}

function setAnalysisStatus(message, type = "") {
  analysisStatus.textContent = message;
  analysisStatus.className = `analysis-status ${type}`;
}

function setAnalysisProgress(value, label) {
  analysisProgress.hidden = false;
  analysisProgressBar.style.width = `${value}%`;
  analysisProgressLabel.textContent = label;
}

function resetGeneration() {
  generationPanel.hidden = true;
  generationText.textContent = "";
}

function appendGenerationText(text, { reset = false } = {}) {
  if (reset) generationText.textContent = "";
  if (!text) return;

  generationPanel.hidden = false;
  generationText.textContent += text;
  generationPanel.scrollTop = generationPanel.scrollHeight;
}

function createRecommendationDetails(recommendation) {
  const root = document.createElement("div");
  root.className = "recommendation-popup";
  const title = document.createElement("h3");
  title.textContent = recommendation.analysis.facilityType;
  const rationale = document.createElement("p");
  rationale.textContent = recommendation.analysis.rationale;
  const metrics = document.createElement("small");
  metrics.textContent = `${recommendation.region.name} · ${recommendation.signals.length} reports · urgency score ${recommendation.urgencyScore}${recommendation.analysis.source ? ` · ${recommendation.analysis.source}` : ""}`;
  root.append(title, rationale, metrics);
  return root;
}

function renderRecommendations(recommendations) {
  recommendationLayer.clearLayers();
  regionBoundaryLayer.clearLayers();
  recommendationsContainer.replaceChildren();

  const renderedRegions = new Set();

  recommendations.forEach((recommendation) => {
    if (recommendation.region?.geometry &&
        !renderedRegions.has(recommendation.region.id)) {
      L.geoJSON(recommendation.region.geometry, {
        style: {
          color: "#6336a5",
          fillColor: "#8d67bb",
          fillOpacity: 0.1,
          weight: 2,
        },
      }).addTo(regionBoundaryLayer);
      renderedRegions.add(recommendation.region.id);
    }
    const icon = L.divIcon({
      className: "",
      html: '<span class="recommendation-marker" aria-hidden="true">✦</span>',
      iconAnchor: [17, 17],
      iconSize: [34, 34],
      popupAnchor: [0, -20],
    });
    const marker = L.marker(
      [recommendation.position.latitude, recommendation.position.longitude],
      { icon, title: recommendation.analysis.facilityType },
    );

    marker.bindPopup(() => createRecommendationDetails(recommendation));
    marker.addTo(recommendationLayer);

    const card = document.createElement("button");
    card.type = "button";
    card.className = "recommendation-card";
    const title = document.createElement("strong");
    title.textContent = recommendation.analysis.facilityType;
    const details = document.createElement("span");
    details.textContent = `${recommendation.region.name} · ${recommendation.signals.length} ${recommendation.category.replaceAll("_", " ")} reports · urgency score ${recommendation.urgencyScore}`;
    const rationale = document.createElement("span");
    rationale.textContent = recommendation.analysis.rationale;
    const source = document.createElement("span");
    source.className = "recommendation-source";
    source.textContent = recommendation.analysis.source
      ? `${recommendation.analysis.source} analysis · ${(recommendation.analysis.confidence * 100).toFixed(0)}% confidence`
      : "Local demand analysis";
    card.append(title, details, rationale, source);
    card.addEventListener("click", () => {
      map.setView(
        [recommendation.position.latitude, recommendation.position.longitude],
        14,
      );
      marker.openPopup();
    });
    recommendationsContainer.append(card);
  });
}

analyzeButton.addEventListener("click", async () => {
  if (regionsResolving) {
    setAnalysisStatus("Wait for the named region boundaries to finish loading.");
    return;
  }

  const sourceSignals = [...visibleSignals];
  const recommendations = buildRecommendations(sourceSignals);

  if (!recommendations.length) {
    renderRecommendations([]);
    setAnalysisStatus(
      `No named region has at least ${MIN_CLUSTER_SIZE} reports in the same category.`,
      "error",
    );
    return;
  }

  const requestId = analysisRequestId + 1;
  analysisRequestId = requestId;
  analysisRunning = true;
  analyzeButton.disabled = true;
  resetGeneration();
  setAnalysisProgress(18, "Preparing grouped signals…");
  setAnalysisStatus("Gemini is reviewing grouped report summaries…");

  try {
    const result = await analyzeWithGemini(firebaseApp, recommendations, {
      onText: (text, { reset } = {}) => {
        if (requestId !== analysisRequestId) return;
        appendGenerationText(text, { reset });
        setAnalysisProgress(
          text ? 72 : 42,
          text ? "Gemini is drafting the decision summary…" : "Connecting to Gemini…",
        );
      },
    });
    if (requestId !== analysisRequestId) return;
    renderRecommendations(result.recommendations);
    generationPanel.hidden = !result.summary;
    generationText.textContent = result.summary;
    setAnalysisProgress(100, "Analysis complete.");
    setAnalysisStatus(
      `Gemini identified needs for ${result.recommendations.length} candidate service location${result.recommendations.length === 1 ? "" : "s"}.`,
    );
  } catch (error) {
    if (requestId !== analysisRequestId) return;
    console.error("NeedMap Gemini analysis error:", error);
    renderRecommendations(recommendations);
    setAnalysisStatus(
      "Gemini is unavailable. Showing private local demand analysis. Enable Firebase AI Logic and App Check to use Gemini.",
      "error",
    );
    setAnalysisProgress(100, "Gemini was unavailable; local analysis shown.");
  } finally {
    if (requestId === analysisRequestId) {
      analysisRunning = false;
      analyzeButton.disabled = regionsResolving || visibleSignals.length < MIN_CLUSTER_SIZE;
    }
  }
});

viewTabs.forEach((tab) => {
  tab.addEventListener("click", () => setActiveView(tab.dataset.view));
});
returnToMapButton.addEventListener("click", () => setActiveView("map"));
window.addEventListener("hashchange", () => {
  setActiveView(window.location.hash === "#data" ? "data" : "map");
});
[dataSearch, dataCategoryFilter, dataSeverityFilter].forEach((control) => {
  control.addEventListener("input", renderDataView);
  control.addEventListener("change", renderDataView);
});

map.on("moveend zoomend", () => refreshViewportState());
setActiveView(window.location.hash === "#data" ? "data" : "map");

onSnapshot(
  collection(db, "incomingSignals"),
  (snapshot) => {
    const bounds = [];
    const signals = [];

    snapshot.forEach((documentSnapshot) => {
      const signal = documentSnapshot.data();
      const latitude = Number(signal.latitude);
      const longitude = Number(signal.longitude);

      if (!isValidCoordinate(latitude, longitude)) return;

      bounds.push([latitude, longitude]);
      signals.push({
        id: documentSnapshot.id,
        ...signal,
        latitude,
        longitude,
      });
    });

    allSignals = signals;
    const currentResolutionId = regionResolutionId + 1;
    regionResolutionId = currentResolutionId;
    regionsResolving = signals.length > 0;
    status.textContent = signals.length
      ? `Resolving regions 0/${signals.length}…`
      : "Live from Firebase";
    liveDot.className = "live-dot connected";
    resetAutomaticDataAnalysis(
      signals.length
        ? `Resolving named regions for ${signals.length} reports. Automatic analysis will start next…`
        : "No reports are available for automatic placement analysis yet.",
    );

    if (!hasSetInitialView && bounds.length) {
      const center = [
        median(bounds.map(([latitude]) => latitude)),
        median(bounds.map(([, longitude]) => longitude)),
      ];

      map.setView(center, bounds.length === 1 ? 13 : 10, { animate: false });
      hasSetInitialView = true;
    }

    refreshViewportState({ invalidateCurrentAnalysis: true });

    if (!signals.length) return;

    enrichSignalsWithRegions(signals, {
      onProgress: (completed, total) => {
        if (currentResolutionId !== regionResolutionId) return;
        status.textContent = `Resolving regions ${completed}/${total}…`;
      },
    }).then((enrichedSignals) => {
      if (currentResolutionId !== regionResolutionId) return;
      allSignals = enrichedSignals;
      regionsResolving = false;
      status.textContent = "Live from Firebase";
      refreshViewportState({ invalidateCurrentAnalysis: true });
      runAutomaticDataAnalysis(enrichedSignals);
    }).catch((error) => {
      if (currentResolutionId !== regionResolutionId) return;
      console.error("NeedMap region enrichment error:", error);
      regionsResolving = false;
      status.textContent = "Live from Firebase · some region names unavailable";
      refreshViewportState({ invalidateCurrentAnalysis: true });
      runAutomaticDataAnalysis(allSignals);
    });
  },
  (error) => {
    console.error("NeedMap Firebase read error:", error);
    status.textContent = "Unable to read Firebase";
    liveDot.className = "live-dot error";
    resetAutomaticDataAnalysis("Unable to read Firebase reports for analysis.");
  },
);
