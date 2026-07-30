# catchWhat

A flock of prey, one hunter, five forces. Drag anywhere to steer the hunter and watch the
flock split around it.

Zero dependencies — plain canvas 2D and a Node stdlib dev server. No build step, no framework,
no bundler.

## Run locally

```bash
npm run dev          # http://localhost:3000
```

The dev server watches `public/` and live-reloads every connected client over SSE — including
a phone on the same Wi-Fi, using the LAN URL it prints on startup.

## Deploy

The site is static; `public/` is the whole thing.

```bash
vercel            # preview
vercel --prod     # production
```

`vercel.json` points `outputDirectory` at `public/`. There is no build command because there is
nothing to build. Live reload is a local-only affordance — the client only opens the `/events`
stream on `localhost`, so on a static host it's simply absent rather than retrying forever.

## Controls

- **drag** — grab the predator nearest your finger and steer it. A white ring marks the one
  you're driving. Release and it goes back to hunting the nearest prey on its own.
- **☰** — prey count, **predator count (1–6)**, force weights, pixel size, motion trails,
  force-vector overlay. Every value can be **dragged or typed** — the number box and the
  slider are two views of the same value and clamp to the same bounds.

Works with a mouse or a finger. It starts deliberately small — **12 prey, 1 predator** — and
the prey slider runs from 1 to 500 if you want a proper swarm. The layout adapts, and
prey/predator marks are sized off a visual scale separate from the physics, with a higher
floor, so on a ~440dp phone they stay legible instead of shrinking to 4px specks.

With more than one predator, prey fear **sums** across all of them, so a prey pinched between
two hunters is pushed hardest out of the gap.

## Look

The palette is sampled from pixel-art references: a high-key blue-grey fog for the field,
desaturated slate for the prey, and the sea-green of lit windows for the predator. The scene
renders into a small offscreen buffer and is blown up with image smoothing off, which is what
produces the chunky pixel edges — `pixel size` in the panel is the block size in CSS px, and
setting it to 1 turns pixelation off entirely and renders crisp.

Catching a prey leaves a brief ring at the point of capture — constant radius, alpha only, no
size change — and the replacement prey eases in over 0.28s rather than popping into place.

## How it works

Each prey sums five accelerations per frame, then its speed is clamped to a band:

| force | direction | falloff |
|---|---|---|
| cohesion | toward the flock centroid — one shared point for all prey | constant |
| separation | away from neighbours within ~22px | linear, strongest when closest |
| alignment | toward the mean heading of neighbours within ~46px | constant |
| fear | away from the hunter | `(1-d/R)(2-d/R)`, zero beyond the fear radius |
| walls | inward | linear inside a 70px margin, zero outside |

Every speed and radius is multiplied by `clamp(min(w,h)/700, 0.5, 1.8)`, so a phone screen
behaves like a scaled-down desktop rather than a cramped one.

Separation and alignment are what keep it a flock: with a centroid attractor alone the prey
collapse into a single dot. Set both sliders to 0 to watch that happen.

Neighbour lookups go through a uniform grid rebuilt each frame, not an O(n²) sweep — that's
what holds 60fps at 500 prey.

## Structure

```
server.js        dev server: static + SSE live reload (not used in production)
vercel.json      static config
public/
  index.html
  style.css
  sim.js         simulation, rendering, input
```

## Debug hook

`window.__flock = { cfg, prey, hunter, world, resetAll, step, draw }`

`requestAnimationFrame` is paused in a hidden or occluded tab, so the sim freezes there and a
frozen canvas looks exactly like a crash. Step it by hand instead:

```js
for (let i = 0; i < 900; i++) { __flock.step(1/60); __flock.draw(); }   // 15s of sim time
```
