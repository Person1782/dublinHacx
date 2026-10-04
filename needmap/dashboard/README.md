# NeedMap Dashboard

The map view for organizations — where anonymous community signals become visible patterns. Consumes the `incomingSignals` Firestore collection written by the [community-site form](../community-site/) and renders reports as markers on a shared map.

**Status: in progress.** Scaffolded on React 19 + TypeScript + Vite.

## Features (planned)

- Live map of anonymous service-access signals
- Category and urgency filtering
- Hotspot clustering / density view per category
- Read-only views for local service organizations

## Development

```bash
npm install
npm run dev      # Vite dev server
npm run build    # type-check + production build
npm run lint     # Oxlint
```

## Stack

- [React 19](https://react.dev) + [TypeScript](https://www.typescriptlang.org)
- [Vite 8](https://vite.dev) (with Oxc-powered plugin)
- [Oxlint](https://oxc.rs) for linting
