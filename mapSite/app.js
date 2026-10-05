import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  collection,
  getFirestore,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const status = document.querySelector("#status");
const liveDot = document.querySelector("#live-dot");
const signalCount = document.querySelector("#signal-count");
const worldBounds = L.latLngBounds([[-85, -180], [85, 180]]);

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
let hasSetInitialView = false;
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

onSnapshot(
  collection(db, "incomingSignals"),
  (snapshot) => {
    markerLayer.clearLayers();
    const bounds = [];

    snapshot.forEach((documentSnapshot) => {
      const signal = documentSnapshot.data();
      const latitude = Number(signal.latitude);
      const longitude = Number(signal.longitude);

      if (!isValidCoordinate(latitude, longitude)) return;

      const color = severityColors[signal.severity] || "#426f91";
      const marker = L.circleMarker([latitude, longitude], {
        radius: signal.severity === "high" ? 10 : 8,
        color,
        fillColor: color,
        fillOpacity: 0.8,
        weight: 2,
        className: "signal-marker",
      });

      marker.bindTooltip(() => createReportDetails(signal, latitude, longitude), {
        className: "signal-hover-card",
        direction: "top",
        interactive: false,
        offset: [0, -8],
        opacity: 1,
        sticky: true,
      });
      marker.bindPopup(() => createReportDetails(signal, latitude, longitude));
      marker.on("click", () => marker.closeTooltip());
      marker.addTo(markerLayer);
      bounds.push([latitude, longitude]);
    });

    signalCount.textContent = String(bounds.length);
    status.textContent = "Live from Firebase";
    liveDot.className = "live-dot connected";

    if (!hasSetInitialView && bounds.length) {
      const center = [
        median(bounds.map(([latitude]) => latitude)),
        median(bounds.map(([, longitude]) => longitude)),
      ];

      map.setView(center, bounds.length === 1 ? 13 : 10, { animate: false });
      hasSetInitialView = true;
    }
  },
  (error) => {
    console.error("NeedMap Firebase read error:", error);
    status.textContent = "Unable to read Firebase";
    liveDot.className = "live-dot error";
  },
);
