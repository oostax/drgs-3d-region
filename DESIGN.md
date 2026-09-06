---
ontology: true
type: decision
domain: sber-atlas
status: active
summary: Reference-led architectural map visual system and implementation contract.
tags: [design, map, responsive]
relatedTo: [PRODUCT, .planning/ROADMAP]
---
# Визуальная система

The user-approved plan pins the light architectural world. Generated composition artifacts/design/atlas-desktop-mobile.png is an implementation reference, not a geospatial or factual source. Its invented city placement and illustrative news must not enter application data. The reference overrides the random style seed. The first generated comp is superseded: the user rejected its excessive scene detail. It remains exploration only. Show actual runtime screenshots at region, city and object scales before claiming visual fidelity.

## Surface mode
Operate, with a map-led presentation mode. The spatial artifact leads; controls recede. Main flow: territory → signal → organisation → dossier.

## Tokens
Paper #f8f7ef, ink #203c2f, emerald #174f3c, stone #ded5bd, water #b2d0c5, muted #617265, line #d6dccf. System typography with local Manrope fallback throughout. Restrained type scale, no display serif. Tabular figures.

## Composition
Full-window map. Small brand/search group at the upper left; local clock and mode at the upper right. Place name is a quiet breadcrumb. The left vertical camera controls stay visible. The contextual panel is closed by default and opens only after choosing a signal, object or list; its close action preserves map selection. A compact bottom dock exposes Explore, Signals, Meetings and Dossier. Explore opens the remaining five sections. No region/city/object switch: zoom alone controls map detail.

## Mobile
Full-height map with the same left camera controls. Compact bottom navigation and an optional object sheet; no permanently open summary. Explicit close action removes the sheet entirely. Safe-area padding and accessible button alternatives remain required.

## Motion and quality
Camera movement follows explicit selection with short, interruptible easing. No automatic tour on initial load. Reduced-motion means immediate camera changes and paused city simulation. The user explicitly requested SimCity-like life: moving traffic, softly pulsing signals, trees, detailed facades and contextual construction machinery. Decorative motion is labelled simulation; signals, statistics and actual construction states remain evidence-backed. Pause stops decorative updates; hidden tabs and distant zooms avoid unnecessary rendering. Public/private switch clears client state before fetching the next mode.

## Light over a full day

The clock uses Europe/Moscow for the Татарстан pilot. Automatic mode follows the current local time; a manual slider explores 00:00–23:45. Solar elevation and azimuth vary continuously by date and coordinates, producing dawn, morning, day, sunset, twilight and night. Sky, surfaces, directional light and illuminated windows follow the same state. This is scene lighting, not live weather.

## Achievable rendering
Actual Overture footprints and verified OSM boundaries. Height from source or explicitly estimated as floors × 3 m / 8 m fallback. Eight authored landmarks provide facade detail; the surrounding city is an architectural massing model. Region: clusters labelled as territory aggregates. City: topic markers, precise verified bank objects. Building: 3D models and object card, with precision shown. No invented exact signal locations. Apple-inspired clarity: system typography, single restrained green accent, consistent Lucide icons, quiet surfaces, minimum 44 px mobile actions, explicit sheet expansion and reduced motion.
