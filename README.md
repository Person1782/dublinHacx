# NeedMap — Dublin HacX 2026

NeedMap helps community members anonymously report local service-access needs, and gives organizers a dashboard to view, prioritize, and respond to them — all in one place.


## The problem

Community needs — food support, supplies, transportation, emergency assistance — are hard to report and coordinate quickly. People experience access gaps every day, but those experiences are scattered, unrecorded, and invisible to the organizations that could act. The barrier was never willingness to report; it was friction and fear of being identified.

## Our solution

- A community-facing site for anonymously submitting needs
- A dashboard for organizers to track and prioritize reported needs
- Firebase-backed data handling
- A live web deployment

## How it works

1. **Report** — a community member picks a category (healthcare, water, transportation, emergency response, food, broadband, other) and an urgency level (low / medium / high), plus an optional 280-character note.
2. **Locate** — device location is snapped to an approximate ~500 m grid cell before anything is stored. Manual demo coordinates are also accepted for testing.
3. **Scrub** — a validation layer rejects phone numbers, email addresses, and street addresses before the report is ever stored.
4. **Map it** — the signal writes to Firestore in real time as a mappable record, ready to surface on the organizer dashboard.

## Privacy by design

- **Zero-identity auth** — Firebase Anonymous Authentication issues a throwaway UID. No email, no name, no profile.
- **PII rejected at the door** — the form screens for phone numbers, emails, and street addresses at submit time and refuses identifying text.
- **Grid-rounded location** — device coordinates snap to a 0.0045° (~500 m) grid cell: enough to see the neighborhood pattern, never the household.
- The form is **not for emergencies** and says so up front.

## Repository structure

```
community-site/        # Anonymous reporting form (vanilla HTML/CSS/JS + Firebase)
  index.html           # Form UI
  app.js               # Validation, PII filter, grid geolocation, Firestore writes
  firebase-config.js   # Firebase web config (client-side by design)
  styles.css
needmap/dashboard/     # Organizer dashboard (React 19 + TypeScript + Vite) — in progress
```

## Quick start

### community-site (the form)

Static site — no build step:

```bash
cd community-site
npx serve .          # or just open index.html in a browser
```

### needmap/dashboard (the map view)

```bash
cd needmap/dashboard
npm install
npm run dev
```

## Data model

Reports are written to the `incomingSignals` Firestore collection:

| Field | Description |
| --- | --- |
| `category` | Service category (healthcare, water, transportation, …) |
| `severity` | Urgency: low / medium / high |
| `summary` | Optional free-text note (max 280 chars, PII-screened) |
| `latitude`, `longitude` | Approximate location |
| `locationGridId` | Grid cell identifier |
| `locationPrecision` | `approximate_grid_500m` or `manual_demo_coordinate` |
| `sourceType` | `community_survey` |
| `isSynthetic` | Demo flag |
| `submittedAt` | Server timestamp |
| `submittedBy` | Anonymous auth UID |

## Tech stack

- **community-site** — HTML, CSS, JavaScript, Firebase (Auth + Firestore)
- **needmap/dashboard** — React, TypeScript, Vite
- **Hosting** — Vercel

## Roadmap

- [ ] Live map dashboard consuming `incomingSignals`
- [ ] Signal clustering and hotspot/heat layers per category
- [ ] Read-only organization accounts
- [ ] Trend alerts when a grid cell heats up fast

## Team

- Rishab Manas — community-site form, Firebase pipeline
- [Teammate name] — [what they built]

## Screenshots

Add 2–3 screenshots or a short demo video/GIF here.
