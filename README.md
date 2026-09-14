# NavMe 3D Wayfinding

Standalone Matterport wayfinding app, split out of the NavMe dashboard.

## What it is

A single-page app that loads a Matterport space and draws a walking route
between two POIs, following the space's own scan points.

- **No login.** Pick a project from the dropdown in the top bar; that sets the
  `poi_type` every Supabase read is scoped by, so POIs, floors, media, navmesh
  and stair chains all follow the selection.
- **Route modes:** hybrid (navmesh shape, scan-point vertices), camera points
  only, or navigation mesh only.
- **Stairs.** Cross-floor routes are guaranteed to walk every declared step of
  a staircase, in order. Flights are declared per project in
  `navme_stair_chains` and edited in-app by a super admin.
- **Floors** always mean NavMe floors (`navme_floors`), never Matterport's own
  floor grouping.

## Running

```bash
npm install
cp .env.example .env   # fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev            # http://localhost:3002
```

`npm run build` emits a static bundle to `dist/`.

## Environment

| Variable | Purpose |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key |

`.env` is gitignored — never commit it.

## Editing staircases

Sign in as a super admin and the **Edit stairs** panel appears. Walk to each
scan point of a flight, lowest step first, press *Add current point*, name it,
pick the From/To floors, and save. The router picks the change up immediately.

Scan numbers are Matterport `Sweep.data` indices. If a space is re-scanned and
re-published those indices can shift, and saved flights need re-picking.
