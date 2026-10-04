import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  addDoc,
  collection,
  getFirestore,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

const form = document.querySelector("#signal-form");
const statusMessage = document.querySelector("#form-status");
const submitButton = form.querySelector('button[type="submit"]');
const locationButton = document.querySelector("#location-button");
const locationStatus = document.querySelector("#location-status");
const latitudeInput = document.querySelector("#latitude");
const longitudeInput = document.querySelector("#longitude");

let selectedLocation = {
  latitude: null,
  longitude: null,
  gridId: "",
  precision: "",
};

const possiblePersonalInfoPatterns = [
  {
    label: "a phone number",
    pattern: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/,
  },
  {
    label: "an email address",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  },
  {
    label: "a street address",
    pattern:
      /\b\d{1,5}\s+[A-Za-z0-9.\s]+\s(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|court|ct|boulevard|blvd)\b/i,
  },
];

function findPossiblePersonalInfo(text) {
  return possiblePersonalInfoPatterns.find((item) => item.pattern.test(text));
}

function setStatus(message, type = "") {
  statusMessage.textContent = message;
  statusMessage.className = `form-status ${type}`;
}

function setLocationStatus(message, type = "") {
  locationStatus.textContent = message;
  locationStatus.className = `location-status ${type}`;
}

function createGridLocation(latitude, longitude) {
  const gridSizeDegrees = 0.0045;

  const roundedLatitude =
    Math.round(latitude / gridSizeDegrees) * gridSizeDegrees;

  const roundedLongitude =
    Math.round(longitude / gridSizeDegrees) * gridSizeDegrees;

  return {
    latitude: Number(roundedLatitude.toFixed(4)),
    longitude: Number(roundedLongitude.toFixed(4)),
    gridId: `grid-${roundedLatitude.toFixed(4)}-${roundedLongitude.toFixed(4)}`,
  };
}

function isValidLocation(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function requestApproximateLocation() {
  if (!navigator.geolocation) {
    setLocationStatus(
      "This device does not support location. Enter demo coordinates manually.",
      "error",
    );
    return;
  }

  locationButton.disabled = true;
  locationButton.textContent = "Finding location...";
  setLocationStatus("Waiting for location permission…");

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const gridLocation = createGridLocation(
        position.coords.latitude,
        position.coords.longitude,
      );

      selectedLocation = {
        ...gridLocation,
        precision: "approximate_grid_500m",
      };

      latitudeInput.value = String(gridLocation.latitude);
      longitudeInput.value = String(gridLocation.longitude);

      locationButton.disabled = false;
      locationButton.textContent = "Approximate map area added";

      setLocationStatus(
        "Approximate map area added for this demo. The marker uses a rounded 500 m grid center.",
        "success",
      );
    },
    () => {
      locationButton.disabled = false;
      locationButton.textContent = "Use my approximate map area";

      setLocationStatus(
        "Location was not shared. Enter demo latitude and longitude manually.",
        "error",
      );
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
    },
  );
}

async function getAnonymousUser() {
  if (auth.currentUser) {
    return auth.currentUser;
  }

  const credential = await signInAnonymously(auth);
  return credential.user;
}

locationButton.addEventListener("click", requestApproximateLocation);

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(form);

  const category = String(formData.get("category") || "");
  const severity = String(formData.get("severity") || "");
  const summary = String(formData.get("summary") || "").trim();

  const manualLatitude = Number(latitudeInput.value);
  const manualLongitude = Number(longitudeInput.value);

  if (!category || !severity) {
    setStatus("Choose a category and urgency level before submitting.", "error");
    return;
  }

  const hasManualCoordinates =
    latitudeInput.value.trim() !== "" || longitudeInput.value.trim() !== "";

  let location;

  if (hasManualCoordinates) {
    if (!isValidLocation(manualLatitude, manualLongitude)) {
      setStatus(
        "Enter a valid latitude (-90 to 90) and longitude (-180 to 180).",
        "error",
      );
      return;
    }

    location = {
      latitude: manualLatitude,
      longitude: manualLongitude,
      gridId: `manual-${manualLatitude.toFixed(4)}-${manualLongitude.toFixed(4)}`,
      precision: "manual_demo_coordinate",
    };
  } else if (
    selectedLocation.latitude !== null &&
    selectedLocation.longitude !== null
  ) {
    location = selectedLocation;
  } else {
    setStatus(
      "Enter demo latitude and longitude, or use your approximate map area.",
      "error",
    );
    return;
  }

  const possiblePersonalInfo = findPossiblePersonalInfo(summary);

  if (possiblePersonalInfo) {
    setStatus(
      `Please remove ${possiblePersonalInfo.label}. NeedMap cannot accept identifying information.`,
      "error",
    );
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Submitting...";
  setStatus("Connecting securely…");

  try {
    const user = await getAnonymousUser();

    await addDoc(collection(db, "incomingSignals"), {
      category,
      severity,
      summary,
      latitude: location.latitude,
      longitude: location.longitude,
      locationGridId: location.gridId,
      locationPrecision: location.precision,
      sourceType: "community_survey",
      isSynthetic: true,
      submittedAt: serverTimestamp(),
      submittedBy: user.uid,
    });

    form.reset();

    selectedLocation = {
      latitude: null,
      longitude: null,
      gridId: "",
      precision: "",
    };

    locationButton.disabled = false;
    locationButton.textContent = "Use my approximate map area";

    setLocationStatus(
      "For this demo, enter map coordinates manually or share an approximate map area.",
    );

    setStatus(
      "Demo complaint submitted. It can now appear as a marker on the NeedMap.",
      "success",
    );
  } catch (error) {
    console.error("NeedMap submission error:", error);

    setStatus(
      "We could not submit the demo signal. Check your connection and try again.",
      "error",
    );
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Submit anonymous signal";
  }
});