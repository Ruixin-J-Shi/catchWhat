// Flock & Hunter — 2D boids with a predator.
//
// Every prey sums four steering forces each frame:
//   1. cohesion  : toward the flock centroid (the shared "center point" of all prey)
//   2. separation: away from very close neighbours (keeps the flock from collapsing to a dot)
//   3. alignment : toward the average heading of nearby neighbours
//   4. fear      : away from the hunter, falling off with distance
//   5. walls     : inward push when close to an edge
// Forces are accelerations in px/s^2; velocity is clamped to a max speed.

(() => {
  'use strict';

  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d', { alpha: false });

  const DEFAULTS = {
    preyCount: 12,
    hunterCount: 1,
    cohesion: 95,
    separation: 130,
    alignment: 115,
    fear: 220,
    fearRadius: 170,
    wall: 340,
    hunterSpeed: 185,
    pixel: 3,
    showVectors: false,
    trails: true,
  };
  const cfg = { ...DEFAULTS };

  // ---------------------------------------------------------------- world

  const world = { w: 0, h: 0, scale: 1 };

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    world.w = window.innerWidth;
    world.h = window.innerHeight;
    world.scale = clamp(Math.min(world.w, world.h) / 700, 0.5, 1.8);
    // Marks are sized separately from the physics: a 440dp phone would otherwise draw
    // 4px darts. The higher floor keeps prey and hunters readable on a small screen
    // without altering any speed, radius or margin.
    world.vscale = clamp(Math.min(world.w, world.h) / 700, 0.78, 1.6);
    canvas.width = Math.round(world.w * dpr);
    canvas.height = Math.round(world.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#e0e5ed';
    ctx.fillRect(0, 0, world.w, world.h);
  }

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const rand = (a, b) => a + Math.random() * (b - a);

  // Palette lifted from the pixel-art reference: a high-key, foggy blue-grey field with
  // desaturated slate figures and coral as the single warm accent.
  const PALETTE = {
    skyTop: '#e6eaf1',
    skyBottom: '#ccd4e0',
    prey: '#5f6b80',
    preySoft: '#8b95a8',
    hunter: '#e0838f',
    hunterSoft: 'rgba(224, 131, 143,',
    ink: '#3d4553',
  };

  // Offscreen buffer used only when pixel size > 1: the scene renders small and is blown
  // up with smoothing off, which is what gives the chunky pixel-art edges.
  const buf = document.createElement('canvas');
  const bufCtx = buf.getContext('2d', { alpha: false });

  /** Capture puffs: constant radius, alpha only — no size change. */
  const flashes = [];
  const FLASH_T = 0.38;
  const FADE_T = 0.28;

  // ---------------------------------------------------------------- agents

  /** Flat-ish object per prey; kept in a plain array for cache friendliness. */
  const prey = [];
  let caught = 0;

  function makePrey() {
    const a = rand(0, Math.PI * 2);
    const speed = rand(0.4, 1) * 170 * world.scale;
    return {
      x: rand(0, world.w),
      y: rand(0, world.h),
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      fade: 0,   // 0->1 ease-in after spawn, so prey appear rather than pop
      // last-frame force components, only used by the debug vector overlay
      fcx: 0, fcy: 0, ffx: 0, ffy: 0, fwx: 0, fwy: 0,
    };
  }

  function setPreyCount(n) {
    while (prey.length < n) prey.push(makePrey());
    if (prey.length > n) prey.length = n;
  }

  /** One or more predators. With a single hunter this behaves exactly as before. */
  const hunters = [];

  function makeHunter(i, n) {
    // Spread them around a ring so they don't start stacked on one another.
    const a = (i / Math.max(1, n)) * Math.PI * 2;
    const r = n > 1 ? Math.min(world.w, world.h) * 0.22 : 0;
    return {
      x: world.w * 0.5 + Math.cos(a) * r,
      y: world.h * 0.5 + Math.sin(a) * r,
      vx: 0, vy: 0,
    };
  }

  function setHunterCount(n) {
    while (hunters.length < n) hunters.push(makeHunter(hunters.length, n));
    if (hunters.length > n) hunters.length = n;
    if (steered && !hunters.includes(steered)) steered = null;
  }

  function resetAll() {
    prey.length = 0;
    setPreyCount(cfg.preyCount);
    hunters.length = 0;
    setHunterCount(cfg.hunterCount);
    steered = null;
    caught = 0;
  }

  // ---------------------------------------------------------------- pointer

  const pointer = { active: false, x: 0, y: 0 };
  // Which predator the finger is driving. The rest keep hunting on their own, so with one
  // hunter this is identical to the original behaviour.
  let steered = null;

  function pointerPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  canvas.addEventListener('pointerdown', (e) => {
    const p = pointerPos(e);
    pointer.active = true;
    pointer.x = p.x;
    pointer.y = p.y;
    // Grab whichever predator is nearest the touch.
    let best = Infinity;
    steered = null;
    for (const h of hunters) {
      const d = (h.x - p.x) ** 2 + (h.y - p.y) ** 2;
      if (d < best) { best = d; steered = h; }
    }
    // Capture keeps moves flowing if the finger leaves the canvas; not worth failing over.
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointer.active) return;
    const p = pointerPos(e);
    pointer.x = p.x;
    pointer.y = p.y;
  });
  const releasePointer = () => { pointer.active = false; steered = null; };
  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);

  // ---------------------------------------------------------------- spatial hash
  // Rebuilt every frame: neighbour queries for separation/alignment would be
  // O(n^2) otherwise, which stalls on a phone at a few hundred prey.

  const grid = { cell: 1, cols: 0, rows: 0, heads: null, next: null };

  function buildGrid(radius) {
    grid.cell = Math.max(8, radius);
    grid.cols = Math.max(1, Math.ceil(world.w / grid.cell));
    grid.rows = Math.max(1, Math.ceil(world.h / grid.cell));
    const cells = grid.cols * grid.rows;
    if (!grid.heads || grid.heads.length < cells) grid.heads = new Int32Array(cells);
    if (!grid.next || grid.next.length < prey.length) grid.next = new Int32Array(prey.length + 64);
    grid.heads.fill(-1, 0, cells);
    for (let i = 0; i < prey.length; i++) {
      const p = prey[i];
      const cx = clamp((p.x / grid.cell) | 0, 0, grid.cols - 1);
      const cy = clamp((p.y / grid.cell) | 0, 0, grid.rows - 1);
      const c = cy * grid.cols + cx;
      grid.next[i] = grid.heads[c];
      grid.heads[c] = i;
    }
  }

  // ---------------------------------------------------------------- step

  function step(dt) {
    const S = world.scale;

    // Capture puffs and spawn fades are pure presentation, but they live here so they
    // advance with simulation time and stay correct when the sim is stepped by hand.
    for (let i = flashes.length - 1; i >= 0; i--) {
      flashes[i].t -= dt;
      if (flashes[i].t <= 0) flashes.splice(i, 1);
    }
    for (const p of prey) if (p.fade < 1) p.fade = Math.min(1, p.fade + dt / FADE_T);

    const maxSpeed = 170 * S;
    const minSpeed = 45 * S;
    const neighborR = 46 * S;
    const sepR = 22 * S;
    const fearR = cfg.fearRadius * S;
    const margin = 70 * S;
    const catchR = 9 * S;

    buildGrid(neighborR);

    // Flock centroid — the single shared attractor for every prey.
    let cx = 0, cy = 0;
    for (const p of prey) { cx += p.x; cy += p.y; }
    if (prey.length) { cx /= prey.length; cy /= prey.length; }

    // --- hunters ------------------------------------------------------
    const hSpeed = cfg.hunterSpeed * S;
    for (const hunter of hunters) {
      const driven = pointer.active && hunter === steered;
      let tx, ty;
      if (driven) {
        tx = pointer.x;
        ty = pointer.y;
      } else {
        // Chase the closest prey; fall back to the flock centre.
        let best = Infinity;
        tx = cx; ty = cy;
        for (const p of prey) {
          const d = (p.x - hunter.x) ** 2 + (p.y - hunter.y) ** 2;
          if (d < best) { best = d; tx = p.x; ty = p.y; }
        }
      }
      const dx = tx - hunter.x, dy = ty - hunter.y;
      const d = Math.hypot(dx, dy) || 1;
      // Steer toward the target instead of snapping, so turns look like momentum.
      const desiredX = (dx / d) * hSpeed;
      const desiredY = (dy / d) * hSpeed;
      const steer = driven ? 6 : 3;
      hunter.vx += (desiredX - hunter.vx) * Math.min(1, steer * dt);
      hunter.vy += (desiredY - hunter.vy) * Math.min(1, steer * dt);
      hunter.x = clamp(hunter.x + hunter.vx * dt, 0, world.w);
      hunter.y = clamp(hunter.y + hunter.vy * dt, 0, world.h);
    }

    // --- prey ---------------------------------------------------------
    const neighborR2 = neighborR * neighborR;
    const sepR2 = sepR * sepR;
    const fearR2 = fearR * fearR;

    for (let i = 0; i < prey.length; i++) {
      const p = prey[i];
      let ax = 0, ay = 0;

      // 1. cohesion toward the shared centroid
      let dcx = cx - p.x, dcy = cy - p.y;
      let dc = Math.hypot(dcx, dcy) || 1;
      const fcx = (dcx / dc) * cfg.cohesion * S;
      const fcy = (dcy / dc) * cfg.cohesion * S;
      ax += fcx; ay += fcy;

      // 2 + 3. separation / alignment over the 3x3 cell neighbourhood
      let sx = 0, sy = 0, avx = 0, avy = 0, n = 0;
      const gx = clamp((p.x / grid.cell) | 0, 0, grid.cols - 1);
      const gy = clamp((p.y / grid.cell) | 0, 0, grid.rows - 1);
      for (let oy = -1; oy <= 1; oy++) {
        const yy = gy + oy;
        if (yy < 0 || yy >= grid.rows) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const xx = gx + ox;
          if (xx < 0 || xx >= grid.cols) continue;
          for (let j = grid.heads[yy * grid.cols + xx]; j !== -1; j = grid.next[j]) {
            if (j === i) continue;
            const q = prey[j];
            const dx = p.x - q.x, dy = p.y - q.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > neighborR2 || d2 === 0) continue;
            avx += q.vx; avy += q.vy; n++;
            if (d2 < sepR2) {
              const d = Math.sqrt(d2);
              sx += (dx / d) * (1 - d / sepR);
              sy += (dy / d) * (1 - d / sepR);
            }
          }
        }
      }
      if (sx || sy) {
        const m = Math.hypot(sx, sy) || 1;
        ax += (sx / m) * cfg.separation * S;
        ay += (sy / m) * cfg.separation * S;
      }
      if (n) {
        avx /= n; avy /= n;
        const m = Math.hypot(avx, avy) || 1;
        ax += ((avx / m) * maxSpeed - p.vx) / maxSpeed * cfg.alignment * S;
        ay += ((avy / m) * maxSpeed - p.vy) / maxSpeed * cfg.alignment * S;
      }

      // 4. fear: negative vector from EVERY hunter, strongest up close. Contributions sum,
      // so a prey pinched between two predators is pushed hardest out of the gap.
      let ffx = 0, ffy = 0, eaten = false;
      for (const hunter of hunters) {
        const hx = p.x - hunter.x, hy = p.y - hunter.y;
        const hd2 = hx * hx + hy * hy;
        if (hd2 >= fearR2) continue;
        if (hd2 < catchR * catchR) { eaten = true; break; }
        const hd = Math.sqrt(hd2) || 1;
        const falloff = 1 - hd / fearR;
        ffx += (hx / hd) * cfg.fear * S * falloff * (1 + falloff);
        ffy += (hy / hd) * cfg.fear * S * falloff * (1 + falloff);
      }
      if (eaten) {
        caught++;
        flashes.push({ x: p.x, y: p.y, t: FLASH_T });
        respawnAtEdge(p);
        p.fade = 0;
        continue;
      }
      ax += ffx; ay += ffy;

      // 5. walls: inward push that ramps up inside the margin
      let fwx = 0, fwy = 0;
      if (p.x < margin) fwx += (1 - p.x / margin) * cfg.wall * S;
      else if (p.x > world.w - margin) fwx -= (1 - (world.w - p.x) / margin) * cfg.wall * S;
      if (p.y < margin) fwy += (1 - p.y / margin) * cfg.wall * S;
      else if (p.y > world.h - margin) fwy -= (1 - (world.h - p.y) / margin) * cfg.wall * S;
      ax += fwx; ay += fwy;

      if (cfg.showVectors) {
        p.fcx = fcx; p.fcy = fcy;
        p.ffx = ffx; p.ffy = ffy;
        p.fwx = fwx; p.fwy = fwy;
      }

      p.vx += ax * dt;
      p.vy += ay * dt;

      // Clamp speed into [minSpeed, maxSpeed] so nothing stalls or teleports.
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > maxSpeed) { p.vx = (p.vx / sp) * maxSpeed; p.vy = (p.vy / sp) * maxSpeed; }
      else if (sp < minSpeed && sp > 0) { p.vx = (p.vx / sp) * minSpeed; p.vy = (p.vy / sp) * minSpeed; }

      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // Hard clamp: the wall force is a suggestion, the edge is not.
      if (p.x < 0) { p.x = 0; p.vx = Math.abs(p.vx); }
      else if (p.x > world.w) { p.x = world.w; p.vx = -Math.abs(p.vx); }
      if (p.y < 0) { p.y = 0; p.vy = Math.abs(p.vy); }
      else if (p.y > world.h) { p.y = world.h; p.vy = -Math.abs(p.vy); }
    }
  }

  function respawnAtEdge(p) {
    const side = (Math.random() * 4) | 0;
    const speed = 120 * world.scale;
    if (side === 0) { p.x = rand(0, world.w); p.y = 2; p.vx = rand(-1, 1) * speed; p.vy = speed; }
    else if (side === 1) { p.x = rand(0, world.w); p.y = world.h - 2; p.vx = rand(-1, 1) * speed; p.vy = -speed; }
    else if (side === 2) { p.x = 2; p.y = rand(0, world.h); p.vx = speed; p.vy = rand(-1, 1) * speed; }
    else { p.x = world.w - 2; p.y = rand(0, world.h); p.vx = -speed; p.vy = rand(-1, 1) * speed; }
  }

  // ---------------------------------------------------------------- draw

  function draw() {
    const V = world.vscale;
    const px = Math.max(1, cfg.pixel | 0);
    let g;

    if (px > 1) {
      // Render small, blow it up with smoothing off -> chunky pixel-art edges.
      const bw = Math.max(1, Math.round(world.w / px));
      const bh = Math.max(1, Math.round(world.h / px));
      if (buf.width !== bw || buf.height !== bh) { buf.width = bw; buf.height = bh; }
      g = bufCtx;
      g.setTransform(1 / px, 0, 0, 1 / px, 0, 0);
    } else {
      g = ctx;
    }

    paint(g, V);

    if (px > 1) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(buf, 0, 0, world.w, world.h);
      ctx.imageSmoothingEnabled = true;
    }
  }

  // Everything below draws in world (CSS px) coordinates, so it is identical whether it
  // lands on the screen directly or in the low-res buffer.
  function paint(g, V) {
    // Sky: a soft vertical wash, the high-key foggy field of the reference art.
    if (cfg.trails) {
      g.fillStyle = 'rgba(224, 229, 237, 0.34)';
      g.fillRect(0, 0, world.w, world.h);
    } else {
      const sky = g.createLinearGradient(0, 0, 0, world.h);
      sky.addColorStop(0, PALETTE.skyTop);
      sky.addColorStop(1, PALETTE.skyBottom);
      g.fillStyle = sky;
      g.fillRect(0, 0, world.w, world.h);
    }

    // Each predator sits in a warm coral haze.
    const fearR = cfg.fearRadius * world.scale;
    for (const hunter of hunters) {
      const grad = g.createRadialGradient(hunter.x, hunter.y, 0, hunter.x, hunter.y, fearR);
      grad.addColorStop(0, PALETTE.hunterSoft + ' 0.20)');
      grad.addColorStop(1, PALETTE.hunterSoft + ' 0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(hunter.x, hunter.y, fearR, 0, Math.PI * 2);
      g.fill();
    }

    // Prey. Fully faded-in ones batch into a single path; the few mid-fade draw
    // separately so alpha can differ without splitting the batch every frame.
    const len = 9 * V, wid = 3.4 * V;
    const dart = (p) => {
      const sp = Math.hypot(p.vx, p.vy) || 1;
      const ux = p.vx / sp, uy = p.vy / sp;
      const nx = -uy, ny = ux;
      g.moveTo(p.x + ux * len, p.y + uy * len);
      g.lineTo(p.x - ux * len * 0.6 + nx * wid, p.y - uy * len * 0.6 + ny * wid);
      g.lineTo(p.x - ux * len * 0.6 - nx * wid, p.y - uy * len * 0.6 - ny * wid);
      g.closePath();
    };

    g.fillStyle = PALETTE.prey;
    g.beginPath();
    for (const p of prey) if (p.fade >= 1) dart(p);
    g.fill();

    for (const p of prey) {
      if (p.fade >= 1) continue;
      g.globalAlpha = p.fade * p.fade;      // ease-in, no scaling
      g.beginPath();
      dart(p);
      g.fill();
    }
    g.globalAlpha = 1;

    // Capture puffs: constant radius, alpha only.
    for (const f of flashes) {
      const a = f.t / FLASH_T;
      g.strokeStyle = PALETTE.hunterSoft + ' ' + Math.min(1, a * 0.9).toFixed(3) + ')';
      g.lineWidth = 2.6 * V;
      g.beginPath();
      g.arc(f.x, f.y, 9 * V, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = PALETTE.hunterSoft + ' ' + Math.min(1, a * 0.65).toFixed(3) + ')';
      g.beginPath();
      g.arc(f.x, f.y, 3 * V, 0, Math.PI * 2);
      g.fill();
    }

    if (cfg.showVectors) drawVectors(g, V);

    // Predators.
    for (const hunter of hunters) {
      const hsp = Math.hypot(hunter.vx, hunter.vy) || 1;
      const hux = hunter.vx / hsp, huy = hunter.vy / hsp;
      g.save();
      g.translate(hunter.x, hunter.y);
      g.rotate(Math.atan2(huy, hux));
      g.fillStyle = PALETTE.hunter;
      g.beginPath();
      g.moveTo(27 * V, 0);
      g.lineTo(-16 * V, 13.5 * V);
      g.lineTo(-8.5 * V, 0);
      g.lineTo(-16 * V, -13.5 * V);
      g.closePath();
      g.fill();
      if (hunter === steered) {
        g.strokeStyle = 'rgba(61, 69, 83, 0.45)';
        g.lineWidth = 1.2 * V;
        g.beginPath();
        g.arc(0, 0, 22 * V, 0, Math.PI * 2);
        g.stroke();
      }
      g.restore();
    }

    if (pointer.active) {
      g.strokeStyle = PALETTE.hunterSoft + ' 0.5)';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(pointer.x, pointer.y, 18 * V, 0, Math.PI * 2);
      g.stroke();
    }
  }

  // Sampled every 6th prey — drawing all of them is unreadable.
  function drawVectors(g, V) {
    const k = 0.6 / world.scale;
    g.lineWidth = 1.2 * V;
    for (let i = 0; i < prey.length; i += 6) {
      const p = prey[i];
      line(p, p.fcx * k, p.fcy * k, 'rgba(95, 107, 128, 0.85)');
      line(p, p.ffx * k, p.ffy * k, 'rgba(224, 131, 143, 0.9)');
      line(p, p.fwx * k, p.fwy * k, 'rgba(150, 130, 90, 0.85)');
    }
    function line(p, dx, dy, color) {
      if (!dx && !dy) return;
      g.strokeStyle = color;
      g.beginPath();
      g.moveTo(p.x, p.y);
      g.lineTo(p.x + dx, p.y + dy);
      g.stroke();
    }
  }

  // ---------------------------------------------------------------- loop

  const fpsEl = document.getElementById('fps');
  const countEl = document.getElementById('count');
  const caughtEl = document.getElementById('caught');

  let last = performance.now();
  let fps = 60;
  let hudAt = 0;

  function frame(now) {
    // Clamp dt so a backgrounded tab doesn't fling everything across the world.
    const dt = Math.min((now - last) / 1000, 1 / 20);
    last = now;
    fps += (1 / Math.max(dt, 1e-4) - fps) * 0.08;

    step(dt);
    draw();

    if (now - hudAt > 250) {
      hudAt = now;
      fpsEl.textContent = fps.toFixed(0);
      countEl.textContent = String(prey.length);
      caughtEl.textContent = String(caught);
    }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- ui

  const panel = document.getElementById('panel');
  const toggle = document.getElementById('toggle');
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
  });

  // The hint has done its job after the first interaction, or after a few seconds.
  const hint = document.getElementById('hint');
  const dismissHint = () => hint.classList.add('gone');
  setTimeout(dismissHint, 5000);
  canvas.addEventListener('pointerdown', dismissHint, { once: true });

  function bindControl(id) {
    const el = document.getElementById(id);
    const num = panel.querySelector(`[data-num="${id}"]`);   // typed entry, same bounds

    // Single funnel for both widgets: whichever one the user touches, the value is
    // clamped once and mirrored to the other, so they can never disagree.
    const sync = (raw) => {
      if (el.type === 'checkbox') { cfg[id] = el.checked; return; }
      const v = clamp(Number(raw), Number(el.min), Number(el.max));
      if (!Number.isFinite(v)) return;
      el.value = String(v);
      if (num) num.value = String(v);
      cfg[id] = v;
      if (id === 'preyCount') setPreyCount(v);
      if (id === 'hunterCount') setHunterCount(v);
    };

    el.addEventListener('input', () => sync(el.value));
    if (num) {
      // Mid-typing the box can be empty or a partial number; ignore until it parses,
      // and restore the live value on blur so it never sits blank.
      num.addEventListener('input', () => { if (num.value.trim() !== '') sync(num.value); });
      num.addEventListener('blur', () => sync(el.value));
      num.addEventListener('keydown', (e) => { if (e.key === 'Enter') num.blur(); });
    }
    el._apply = () => sync(el.value);
    return el;
  }

  const controls = ['preyCount', 'hunterCount', 'cohesion', 'separation', 'alignment', 'fear',
    'fearRadius', 'wall', 'hunterSpeed', 'pixel', 'showVectors', 'trails'].map(bindControl);

  document.getElementById('reset').addEventListener('click', resetAll);
  document.getElementById('defaults').addEventListener('click', () => {
    for (const el of controls) {
      const v = DEFAULTS[el.id];
      if (el.type === 'checkbox') el.checked = v;
      else el.value = String(v);
      el._apply();
    }
  });

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 120));
  document.addEventListener('visibilitychange', () => { last = performance.now(); });

  // Debug hook: inspect or drive the sim from the console / an automation tool.
  window.__flock = { cfg, prey, hunters, flashes, world, resetAll, step, draw, get caught() { return caught; } };

  // Seed every control from DEFAULTS rather than trusting the markup, so the HTML and the
  // config can't drift — and so the device-derived prey count actually reaches the slider.
  for (const el of controls) {
    const v = DEFAULTS[el.id];
    if (el.type === 'checkbox') el.checked = v; else el.value = String(v);
  }

  resize();
  resetAll();
  for (const el of controls) el._apply();
  requestAnimationFrame(frame);
})();
