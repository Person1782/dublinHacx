const EARTH_RADIUS_KM = 6371;
const REQUEST_GAP_MS = 1100;
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_PREFIX = "needmap-region-v1:";
const REGION_ENDPOINT = (
  import.meta.env?.VITE_REGION_LOOKUP_ENDPOINT ||
  "https://nominatim.openstreetmap.org"
).replace(/\/$/, "");

let requestQueue = Promise.resolve();
let lastRequestStartedAt = 0;
const knownRegions = [];

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function coordinateCacheKey(latitude, longitude, zoom) {
  return `${CACHE_PREFIX}${latitude.toFixed(4)}:${longitude.toFixed(4)}:${zoom}`;
}

function readCache(key) {
  try {
    const cached = JSON.parse(localStorage.getItem(key));
    if (!cached || Date.now() - cached.savedAt > CACHE_MAX_AGE_MS) return null;
    return cached.value;
  } catch {
    return null;
  }
}

function writeCache(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), value }));
  } catch {
    // Region lookups still work if private browsing or storage limits block caching.
  }
}

async function policyLimitedFetch(url) {
  const request = requestQueue.then(async () => {
    const waitFor = REQUEST_GAP_MS - (Date.now() - lastRequestStartedAt);
    if (waitFor > 0) await delay(waitFor);
    lastRequestStartedAt = Date.now();

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      referrerPolicy: "strict-origin-when-cross-origin",
    });

    if (!response.ok) {
      throw new Error(`Region lookup failed with status ${response.status}.`);
    }

    return response.json();
  });

  requestQueue = request.catch(() => undefined);
  return request;
}

function pointOnSegment(point, first, second) {
  const [x, y] = point;
  const [x1, y1] = first;
  const [x2, y2] = second;
  const squaredLength = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  if (squaredLength < 1e-20) {
    return (x - x1) ** 2 + (y - y1) ** 2 < 1e-20;
  }
  const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
  if (Math.abs(cross) > 1e-10) return false;
  const dot = (x - x1) * (x2 - x1) + (y - y1) * (y2 - y1);
  if (dot < 0) return false;
  return dot <= squaredLength;
}

function pointInRing(point, ring) {
  let inside = false;

  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const currentPoint = ring[index];
    const previousPoint = ring[previous];
    if (pointOnSegment(point, previousPoint, currentPoint)) return true;

    const intersects = (currentPoint[1] > point[1]) !== (previousPoint[1] > point[1]) &&
      point[0] < (previousPoint[0] - currentPoint[0]) *
        (point[1] - currentPoint[1]) /
        (previousPoint[1] - currentPoint[1]) + currentPoint[0];
    if (intersects) inside = !inside;
  }

  return inside;
}

function pointInPolygonCoordinates(point, coordinates) {
  if (!coordinates.length || !pointInRing(point, coordinates[0])) return false;
  return !coordinates.slice(1).some((hole) => pointInRing(point, hole));
}

export function pointInGeometry(longitude, latitude, geometry) {
  if (!geometry) return false;
  const point = [longitude, latitude];

  if (geometry.type === "Polygon") {
    return pointInPolygonCoordinates(point, geometry.coordinates);
  }

  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.some((polygon) =>
      pointInPolygonCoordinates(point, polygon));
  }

  return false;
}

function geometryComponents(geometry) {
  if (geometry?.type === "Polygon") return [geometry];
  if (geometry?.type === "MultiPolygon") {
    return geometry.coordinates.map((coordinates) => ({
      type: "Polygon",
      coordinates,
    }));
  }
  return [];
}

function containingComponent(geometry, longitude, latitude) {
  const components = geometryComponents(geometry);
  const componentIndex = components.findIndex((component) =>
    pointInGeometry(longitude, latitude, component));

  if (componentIndex === -1) return null;
  return { geometry: components[componentIndex], componentIndex };
}

function ringAreaKm2(ring) {
  if (ring.length < 3) return 0;
  const meanLatitude = ring.reduce((sum, coordinate) => sum + coordinate[1], 0) /
    ring.length * Math.PI / 180;
  const points = ring.map(([longitude, latitude]) => ({
    x: longitude * Math.PI / 180 * EARTH_RADIUS_KM * Math.cos(meanLatitude),
    y: latitude * Math.PI / 180 * EARTH_RADIUS_KM,
  }));
  let doubledArea = 0;

  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    doubledArea += points[index].x * next.y - next.x * points[index].y;
  }

  return Math.abs(doubledArea) / 2;
}

function polygonAreaKm2(geometry) {
  if (geometry?.type !== "Polygon" || !geometry.coordinates.length) return null;
  const outerArea = ringAreaKm2(geometry.coordinates[0]);
  const holesArea = geometry.coordinates.slice(1)
    .reduce((sum, ring) => sum + ringAreaKm2(ring), 0);
  return Math.max(0, outerArea - holesArea);
}

function geometryBounds(geometry) {
  const coordinates = [];
  const collectCoordinates = (value) => {
    if (Array.isArray(value) && value.length >= 2 &&
        Number.isFinite(value[0]) && Number.isFinite(value[1])) {
      coordinates.push(value);
      return;
    }
    if (Array.isArray(value)) value.forEach(collectCoordinates);
  };
  collectCoordinates(geometry?.coordinates);
  if (!coordinates.length) return null;
  const longitudes = coordinates.map((coordinate) => coordinate[0]);
  const latitudes = coordinates.map((coordinate) => coordinate[1]);
  return [
    [Math.min(...latitudes), Math.min(...longitudes)],
    [Math.max(...latitudes), Math.max(...longitudes)],
  ];
}

function parsePopulation(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const population = Number(value.replaceAll(/[^0-9.]/g, ""));
  return Number.isFinite(population) && population > 0 ? population : null;
}

function regionName(result) {
  return result.name || result.address?.neighbourhood || result.address?.suburb ||
    result.address?.city_district || result.address?.city || result.address?.town ||
    result.address?.village || result.address?.municipality || result.address?.county ||
    result.address?.state || result.display_name || "Named region";
}

function regionHierarchy(result, name) {
  const address = result.address || {};
  const values = [
    address.neighbourhood,
    address.suburb,
    address.city_district,
    address.city,
    address.town,
    address.village,
    address.municipality,
    address.county,
    address.state,
    address.country,
  ].filter(Boolean);
  return [...new Set(values)].filter((value) => value !== name).join(", ");
}

function normalizeResult(result, latitude, longitude, zoom) {
  const component = containingComponent(result?.geojson, longitude, latitude);
  if (!component) return null;

  const name = regionName(result);
  const areaKm2 = polygonAreaKm2(component.geometry);
  const population = parsePopulation(result.extratags?.population);
  const densityPerKm2 = population && areaKm2
    ? population / areaKm2
    : null;
  const osmType = result.osm_type || "place";
  const osmId = result.osm_id || result.place_id;

  return {
    id: `${osmType}-${osmId}-${component.componentIndex}`,
    osmId: `${osmType}-${osmId}`,
    name,
    hierarchy: regionHierarchy(result, name),
    type: result.addresstype || result.type || "administrative region",
    population,
    populationDate: result.extratags?.["population:date"] || null,
    areaKm2,
    densityPerKm2,
    geometry: component.geometry,
    bounds: geometryBounds(component.geometry),
    lookupZoom: zoom,
    source: "OpenStreetMap Nominatim",
  };
}

function classifyRurality(region) {
  const density = region.densityPerKm2;
  if (Number.isFinite(density)) {
    if (density >= 1500) return "dense urban";
    if (density >= 500) return "urban";
    if (density >= 150) return "suburban";
    return "rural";
  }

  const type = String(region.type).toLowerCase();
  if (/hamlet|village|isolated|locality|county|district/.test(type)) return "rural";
  if (/city|borough|suburb|neighbou?rhood/.test(type)) return "urban";
  return "mixed";
}

function adaptiveZoom(region) {
  const density = region.densityPerKm2;
  const type = String(region.type).toLowerCase();

  if (/hamlet|village|isolated|locality/.test(type) ||
      (Number.isFinite(density) && density < 100)) {
    return 8;
  }
  if (Number.isFinite(density) && density >= 1000) return 14;
  if (Number.isFinite(density) && density >= 350) return 12;
  return 10;
}

async function lookup(latitude, longitude, zoom) {
  const cacheKey = coordinateCacheKey(latitude, longitude, zoom);
  const cached = readCache(cacheKey);
  if (cached) return cached;

  const url = new URL(`${REGION_ENDPOINT}/reverse`);
  url.search = new URLSearchParams({
    format: "jsonv2",
    lat: String(latitude),
    lon: String(longitude),
    zoom: String(zoom),
    addressdetails: "1",
    extratags: "1",
    polygon_geojson: "1",
    polygon_threshold: "0.002",
    "accept-language": "en",
  });

  const result = await policyLimitedFetch(url);
  writeCache(cacheKey, result);
  return result;
}

function knownRegionFor(latitude, longitude) {
  return knownRegions.find((region) =>
    pointInGeometry(longitude, latitude, region.geometry));
}

async function resolveRegion(signal) {
  const known = knownRegionFor(signal.latitude, signal.longitude);
  if (known) return known;

  const baseResult = await lookup(signal.latitude, signal.longitude, 10);
  const baseRegion = normalizeResult(
    baseResult,
    signal.latitude,
    signal.longitude,
    10,
  );
  if (!baseRegion) return null;

  const targetZoom = adaptiveZoom(baseRegion);
  let selectedRegion = baseRegion;

  if (targetZoom !== 10) {
    const adaptiveResult = await lookup(
      signal.latitude,
      signal.longitude,
      targetZoom,
    );
    const adaptiveRegion = normalizeResult(
      adaptiveResult,
      signal.latitude,
      signal.longitude,
      targetZoom,
    );
    if (adaptiveRegion) selectedRegion = adaptiveRegion;
  }

  const contextualDensity = selectedRegion.densityPerKm2 ?? baseRegion.densityPerKm2;
  const finalRegion = {
    ...selectedRegion,
    densityPerKm2: contextualDensity,
    densityIsContextual: !selectedRegion.densityPerKm2 && Boolean(contextualDensity),
    rurality: classifyRurality({
      ...selectedRegion,
      densityPerKm2: contextualDensity,
    }),
  };
  knownRegions.push(finalRegion);
  return finalRegion;
}

export async function enrichSignalsWithRegions(signals, { onProgress } = {}) {
  const enrichedSignals = [];

  for (let index = 0; index < signals.length; index += 1) {
    const signal = signals[index];
    onProgress?.(index, signals.length);

    try {
      const region = await resolveRegion(signal);
      enrichedSignals.push({ ...signal, region });
    } catch (error) {
      console.warn("NeedMap region lookup failed:", error);
      enrichedSignals.push({ ...signal, region: null });
    }
  }

  onProgress?.(signals.length, signals.length);
  return enrichedSignals;
}
