// Builds the homepage probe-station figure: an isometric wafer probe station
// whose needle reads one recorded Calculator investigation pad by pad.
//
//   node website/figures/probe-station/build.mjs            update index.html and the live script
//   node website/figures/probe-station/build.mjs --preview  also write preview.html (light and dark)
//
// Drawn with the MIT-licensed isometric kit in ../kit. The SVG is written
// between the probe-station markers in public/index.html so it renders without
// JavaScript; public/assets/probe-station.js moves the stage and the needle.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "../kit/iso-kit.mjs";
import * as G from "../kit/lathe.mjs";
import {
  STEPS,
  DIE,
  PITCH,
  PAD_INSET,
  PADS_PER_SIDE,
  padAlong,
  stageFor,
} from "./model.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "../../public");

const WIDTH = 640;
const HEIGHT = 440;

// World units are about one screen pixel of the real bench; z is up.
const PLATE = { x: -160, y: -100, w: 320, d: 200, r: 8 };
const PLATE_H = 12;
const FOOT_H = 5;

const BASE = { x: -52, y: -40, w: 104, d: 120, r: 3 };
const BASE_H = 6;
const YSLIDE = { x: -46, y: -24, w: 92, d: 88, r: 3 };
const YSLIDE_Z = [BASE_H, 11];
const XSLIDE = { x: -40, y: -16, w: 80, d: 72, r: 3 };
const XSLIDE_Z = [11, 16];
const CENTRE = [0, 20];
const CHUCK_R = 32;
const CHUCK_Z = [16, 21];
const PKG = 40;
const PKG_Z = [21, 23.4];
const DIE_Z = [23.4, 24.6];
const DIE_TOP = DIE_Z[1];
const PAD_H = 0.25;
const PAD = 2.4;

const TIP = [
  CENTRE[0] + STEPS[0].pad[0],
  CENTRE[1] + STEPS[0].pad[1],
  DIE_TOP + PAD_H,
];
const LIFT = 4;

const INSTRUMENT = { x: 56, y: -98, w: 98, d: 52, r: 3 };
const INSTRUMENT_H = 78;
const FRONT = INSTRUMENT.y + INSTRUMENT.d;
const SIDE = INSTRUMENT.x + INSTRUMENT.w;
const IX = INSTRUMENT.x;
const SCREEN = { x0: IX + 8, x1: IX + 68, z0: 38, z1: 68, r: 2.5, depth: 1.6 };
const BEZEL = { x0: IX + 5, x1: IX + 71, z0: 35, z1: 71, r: 3.5, depth: 1.2 };

const MICROSCOPE = [0, -74];
const SCOPE = [CENTRE[0], CENTRE[1]];

const P = k.fitProjection(
  [
    ...k.boxCorners(PLATE, -PLATE_H - FOOT_H, 0),
    ...k.boxCorners(INSTRUMENT, 0, INSTRUMENT_H + 8),
    [MICROSCOPE[0], MICROSCOPE[1], 150],
    [SCOPE[0], SCOPE[1], 156],
  ],
  WIDTH,
  HEIGHT,
  { pad: 26, azimuth: 52 },
);

const at = (point) => k.iso(point, P);
const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const byDepth = (points) =>
  [...points].sort(
    (a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P),
  );
const planeOf = (y) => k.sideMatrix([0, y], 0, P, "left");
const flat = (x0, z0, x1, z1, r, steps = 6) =>
  k.pathOf(
    k
      .roundedPlan({ x: x0, y: z0, w: x1 - x0, d: z1 - z0, r }, steps)
      .map(([u, z]) => [u, -z]),
    true,
  );
const sideSlot = (x, y, z0, z1, half = 0.8) =>
  k.pathOf(
    k
      .roundedPlan({ x: y - half, y: z0, w: half * 2, d: z1 - z0, r: half }, 4)
      .map(([u, z]) => at([x, u, z])),
    true,
  );

// A knurled thimble on any axis: barrel, knurled thimble, end cap.
function micrometer(
  origin,
  axis,
  { barrel = 3, thimble = 4.2, length = 14 } = {},
) {
  const F = G.frameAlong(origin, axis);
  const out = [];
  out.push(S(G.disc(0, length * 0.45, barrel, F, P), { tone: "mid" }));
  out.push(L(G.arcOf(F, length * 0.2, barrel, P), { tone: "faint" }));
  out.push(
    S(G.disc(length * 0.45, length * 0.92, thimble, F, P), { tone: "mid" }),
  );
  out.push(
    k.fadedSvg(
      G.ribsOf(F, length * 0.45, length * 0.92, thimble, 28, P, {
        fade: [0.1, 0.55],
      }),
      { tone: "lo" },
    ),
  );
  out.push(
    S(G.disc(length * 0.92, length, thimble * 0.62, F, P), { tone: "mid" }),
  );
  return out.join("");
}

// A connector on a face: a hex-ish body, a barrel and a bayonet pin.
function bnc(origin, axis) {
  const F = G.frameAlong(origin, axis);
  return [
    S(G.disc(0, 1.2, 3.2, F, P), { tone: "lo" }),
    S(G.disc(1.2, 4.6, 2.2, F, P), { tone: "mid" }),
    L(G.arcOf(F, 3.2, 2.2, P), { tone: "faint" }),
  ].join("");
}

function plate() {
  const out = [
    `<path class="iso-halo" d="${k.haloOf(PLATE, -PLATE_H - FOOT_H, PLATE_H, P)}"/>`,
  ];
  for (const [x, y] of byDepth(k.corners(PLATE, 24))) {
    out.push(
      S(k.cylinder(x, y, 8, -PLATE_H - FOOT_H, 1.6, P, 28), { tone: "lo" }),
    );
    out.push(
      S(k.cylinder(x, y, 6, -PLATE_H - FOOT_H + 1.6, FOOT_H - 1.6, P, 28), {
        tone: "mid",
      }),
    );
  }
  out.push(
    S(k.slabOf(PLATE, -PLATE_H, PLATE_H, P, 8, 1.6), {
      tone: "mid",
      inner: L(k.sideSeam(PLATE, -4, P, 8), { tone: "faint" }),
    }),
  );
  out.push(L(k.planOutline(k.insetPlan(PLATE, 5), 0, P), { tone: "lo" }));
  const screws = k.corners(PLATE, 11);
  out.push(
    L(screws.map(([x, y]) => k.ring(x, y, 2.4, 0, P, 16)).join(""), {
      tone: "lo",
    }),
  );
  out.push(
    D(
      screws.map(([x, y]) => at([x, y, 0])),
      { size: 0.5 },
    ),
  );
  // Tapped holes on a 20-unit grid, as on a real breadboard plate, kept off the parts.
  const holes = [];
  for (let x = -130; x <= 130; x += 20)
    for (let y = -70; y <= 80; y += 20) {
      const busy =
        (x > BASE.x - 6 &&
          x < BASE.x + BASE.w + 6 &&
          y > BASE.y - 6 &&
          y < BASE.y + BASE.d + 6) ||
        (x > INSTRUMENT.x - 6 &&
          x < INSTRUMENT.x + INSTRUMENT.w + 6 &&
          y < INSTRUMENT.y + INSTRUMENT.d + 6) ||
        (y > BASE.y - 8 && y < BASE.y + 2) ||
        (x > 112 && x < 132 && y < 60) ||
        (Math.abs(x - MICROSCOPE[0]) < 22 &&
          Math.abs(y - MICROSCOPE[1]) < 22) ||
        (x > 62 && x < 118 && y > -14 && y < 52) ||
        (x > -122 && x < -66 && y > -14 && y < 52) ||
        y > 74;
      if (!busy) holes.push([x, y]);
    }
  out.push(
    L(holes.map(([x, y]) => k.ring(x, y, 1.1, 0, P, 12)).join(""), {
      tone: "faint",
    }),
  );
  // Ruler strip along the front edge, ticks rooted on its edge.
  const strip = { x: -138, y: PLATE.y + PLATE.d - 14, w: 140, d: 7, r: 1 };
  out.push(S(k.slabOf(strip, 0, 0.6, P, 3), { tone: "lo", crease: "none" }));
  const ticks = k.topTicks(
    strip.x + 4,
    strip.x + strip.w - 4,
    4,
    5,
    strip.y + 0.8,
    0.6,
    [2, 3.6],
    P,
  );
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  out.push(
    D(
      [
        at([strip.x + 2, strip.y + 3.5, 0.6]),
        at([strip.x + strip.w - 2, strip.y + 3.5, 0.6]),
      ],
      { size: 0.45 },
    ),
  );
  // Label plate with rule lines standing for printed text.
  const label = { x: 72, y: PLATE.y + PLATE.d - 18, w: 52, d: 10, r: 1.2 };
  out.push(S(k.slabOf(label, 0, 0.8, P, 3), { tone: "lo", crease: "none" }));
  out.push(
    L(k.planOutline(k.insetPlan(label, 1.4), 0.8, P, 3), { tone: "faint" }),
  );
  out.push(
    L(
      [34, 26, 18]
        .map((w, i) =>
          k.lineOnTop(
            [label.x + 4, label.y + 2.8 + i * 2.2],
            [label.x + 4 + w, label.y + 2.8 + i * 2.2],
            0.8,
            P,
          ),
        )
        .join(""),
      { tone: "lo", free: true },
    ),
  );
  out.push(
    D(
      [
        at([label.x + label.w - 3.5, label.y + 3, 0.8]),
        at([label.x + label.w - 3.5, label.y + label.d - 3, 0.8]),
      ],
      { size: 0.42 },
    ),
  );
  return out.join("");
}

// Coax cables lie on the plate in two lanes and climb to their connectors.
const CABLES = [
  {
    from: [IX + 86, FRONT + 4.6, 14],
    via: [
      [IX + 86, FRONT + 10, 0.7],
      [122, FRONT + 16, 0.7],
      [122, 54, 0.7],
      [90, 54, 0.7],
    ],
    to: [90, 44.6, 7],
  },
  {
    from: [IX + 76, FRONT + 4.6, 14],
    via: [
      [IX + 76, BASE.y - 3, 0.7],
      [-60, BASE.y - 3, 0.7],
      [-65, BASE.y + 2, 0.7],
      [-65, 54, 0.7],
      [-94, 54, 0.7],
    ],
    to: [-94, 44.6, 7],
  },
];
function cables() {
  return CABLES.map(({ from, via, to }) =>
    k
      .wireSvg(at(from), at(to), {
        via: via.map(at),
        tone: "mid",
        ends: "none",
      })
      .replace('class="iso-wire"', 'class="iso-wire ps-cable"'),
  ).join("");
}

function instrument() {
  const out = [`<path class="iso-halo" d="${k.haloOf(INSTRUMENT, 0, 8, P)}"/>`];
  for (const [x, y] of byDepth(k.corners(INSTRUMENT, 9)))
    out.push(S(k.cylinder(x, y, 4, 0, 3, P, 20), { tone: "lo" }));
  out.push(
    S(k.slabOf(INSTRUMENT, 3, INSTRUMENT_H - 3, P, 6, 1.2), {
      tone: "mid",
      inner: L(k.sideSeam(INSTRUMENT, 12, P, 6), { tone: "faint" }),
    }),
  );
  // Lid: vents as closed slots, two screws, a carry handle on posts.
  const top = 3 + INSTRUMENT_H - 3;
  out.push(
    L(
      Array.from({ length: 9 }, (_, i) =>
        k.planOutline(
          {
            x: INSTRUMENT.x + 30 + i * 5,
            y: INSTRUMENT.y + 10,
            w: 1.6,
            d: 22,
            r: 0.8,
          },
          top,
          P,
          4,
        ),
      ).join(""),
      { tone: "faint" },
    ),
  );
  out.push(
    D(
      [
        at([INSTRUMENT.x + 6, INSTRUMENT.y + 6, top]),
        at([INSTRUMENT.x + INSTRUMENT.w - 6, INSTRUMENT.y + 6, top]),
      ],
      { size: 0.45 },
    ),
  );
  for (const x of [INSTRUMENT.x + 14, INSTRUMENT.x + INSTRUMENT.w - 14])
    out.push(
      S(
        k.slabOf(
          { x: x - 2.5, y: INSTRUMENT.y + 40, w: 5, d: 6, r: 1.2 },
          top,
          5,
          P,
          3,
          0.4,
        ),
        { tone: "mid" },
      ),
    );
  out.push(
    S(
      k.slabOf(
        {
          x: INSTRUMENT.x + 11,
          y: INSTRUMENT.y + 41,
          w: INSTRUMENT.w - 22,
          d: 4,
          r: 2,
        },
        top + 5,
        2.6,
        P,
        4,
        0.5,
      ),
      { tone: "mid" },
    ),
  );
  // Side vents on the face that turns toward the light.
  const rowOf = (from, to, step) =>
    Array.from(
      { length: Math.floor((to - from) / step + 1e-9) + 1 },
      (_, i) => from + i * step,
    );
  out.push(
    L(
      rowOf(INSTRUMENT.y + 10, INSTRUMENT.y + 40, 3.2)
        .map((y) => sideSlot(SIDE, y, top - 26, top - 10))
        .join(""),
      { tone: "faint" },
    ),
  );
  // Front panel: an inset line, the bezel and screen, knobs, a switch and the connectors.
  out.push(
    `<g transform="${planeOf(FRONT)}"><path class="iso-line" data-tone="faint" d="${flat(INSTRUMENT.x + 4, 7, SIDE - 4, top - 4, 3)}"/></g>`,
  );
  out.push(screen());
  for (const [x, z] of [
    [IX + 78, 60],
    [IX + 88, 60],
    [IX + 78, 49],
    [IX + 88, 49],
  ])
    out.push(
      micrometer([x, FRONT, z], [0, 1, 0], {
        barrel: 1.4,
        thimble: 3.4,
        length: 5,
      }),
    );
  out.push(
    S(
      k.slabOf(
        { x: IX + 74, y: FRONT - 0.2, w: 18, d: 2, r: 0.6 },
        36,
        3,
        P,
        2,
      ),
      { tone: "lo" },
    ),
  );
  out.push(
    `<g transform="${planeOf(FRONT + 1.8)}"><path class="iso-line" data-tone="faint" d="M${IX + 76} -37.5H${IX + 90}"/></g>`,
  );
  out.push(
    S(
      k.slabOf(
        { x: IX + 86, y: FRONT, w: 4, d: 1.6, r: 0.6 },
        24,
        6,
        P,
        2,
        0.3,
      ),
      { tone: "mid" },
    ),
  );
  out.push(
    `<circle class="ps-led" cx="${at([IX + 80, FRONT + 0.2, 27])[0].toFixed(1)}" cy="${at([IX + 80, FRONT + 0.2, 27])[1].toFixed(1)}" r="0.9"/>`,
  );
  out.push(
    bnc([IX + 76, FRONT, 14], [0, 1, 0]),
    bnc([IX + 86, FRONT, 14], [0, 1, 0]),
  );
  out.push(
    D(
      [
        at([INSTRUMENT.x + 7, FRONT, top - 7]),
        at([SIDE - 7, FRONT, top - 7]),
        at([INSTRUMENT.x + 7, FRONT, 11]),
        at([SIDE - 7, FRONT, 11]),
      ],
      { size: 0.45 },
    ),
  );
  return out.join("");
}

let clips = 0;
function recess(
  { x0, x1, z0, z1, r, depth },
  y,
  back = "",
  backClass = "ps-well",
  inside = "",
) {
  const id = `ps-clip-${clips++}`;
  const ring = k.roundedPlan({ x: x0, y: z0, w: x1 - x0, d: z1 - z0, r }, 6);
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const { sinA } = k.cameraOf(P);
  const tops = [];
  const sides = [[], [], [], []];
  ring.forEach(([ax, az], index) => {
    const [bx, bz] = ring[(index + 1) % ring.length];
    const length = Math.hypot(bx - ax, bz - az) || 1;
    let [nx, nz] = [(bz - az) / length, -(bx - ax) / length];
    if (nx * (cx - (ax + bx) / 2) + nz * (cz - (az + bz) / 2) < 0)
      [nx, nz] = [-nx, -nz];
    if (nx <= 0 && nz <= 0) return;
    const quad = k.pathOf(
      [
        at([ax, y, az]),
        at([bx, y, bz]),
        at([bx, y - depth, bz]),
        at([ax, y - depth, az]),
      ],
      true,
    );
    if (nz >= nx) tops.push(quad);
    else
      sides[
        Math.min(3, Math.max(0, Math.floor(((nx * -sinA + 1) / 2) * 4)))
      ].push(quad);
  });
  const shape = flat(x0, z0, x1, z1, r);
  return [
    `<clipPath id="${id}"><path transform="${planeOf(y)}" d="${shape}"/></clipPath>`,
    `<g clip-path="url(#${id})">`,
    `<path class="iso-top" d="${tops.join("")}"/>`,
    ...sides.map((d, shade) =>
      d.length
        ? `<path class="iso-shade" data-shade="${shade}" d="${d.join("")}"/>`
        : "",
    ),
    `<g transform="${planeOf(y - depth)}"><path class="${backClass}" d="${shape}"/>${back}<path class="iso-line" data-tone="faint" d="${shape}"/></g>`,
    inside,
    `</g>`,
    `<g transform="${planeOf(y)}"><path class="iso-line" data-tone="lo" d="${shape}"/></g>`,
  ].join("");
}

// The instrument's display, drawn in the plane of its front face. Text is
// fitted to the window at its longest line.
const LINE_Z = [54.5, 47.5, 41];
function screen() {
  const { x0, x1, z0, z1 } = SCREEN;
  const step = STEPS[0];
  const rows = [];
  for (let z = z0 + 1.4; z < z1; z += 1.8)
    rows.push(`M${x0} ${(-z).toFixed(1)}H${x1}`);
  const status = [
    `<path class="ps-rule" d="M${x0 + 3} ${-(z1 - 6)}H${x1 - 3}"/>`,
    `<text class="ps-status" x="${x0 + 3}" y="${-(z1 - 4.2)}" font-size="2.5">REA</text>`,
    `<text class="ps-status" data-part="count" x="${x0 + 12}" y="${-(z1 - 4.2)}" font-size="2.5">01 / ${String(STEPS.length).padStart(2, "0")}</text>`,
  ].join("");
  const text = step.lines
    .map(
      (line, index) =>
        `<text class="ps-text" data-line="${index}" data-tone="${index === 0 ? "hi" : "lo"}" x="${x0 + 3}" y="${-LINE_Z[index]}" font-size="${index === 0 ? 4.1 : 3.4}">${escapeText(line)}</text>`,
    )
    .join("");
  const back = `<path class="ps-scan" d="${rows.join("")}"/>${status}<g data-part="lines">${text}</g>`;
  return recess(
    BEZEL,
    FRONT,
    "",
    "ps-bezel",
    recess(SCREEN, FRONT - BEZEL.depth, back, "ps-glass"),
  );
}
const escapeText = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function microscopeBack() {
  const [x, y] = MICROSCOPE;
  const out = [];
  out.push(
    S(k.slabOf({ x: x - 18, y: y - 14, w: 36, d: 28, r: 4 }, 0, 6, P, 6, 0.8), {
      tone: "mid",
    }),
  );
  out.push(
    D(
      k
        .corners({ x: x - 18, y: y - 14, w: 36, d: 28 }, 5)
        .map(([px, py]) => at([px, py, 6])),
      { size: 0.45 },
    ),
  );
  out.push(S(k.cylinder(x, y, 8, 6, 4, P, 28), { tone: "mid" }));
  out.push(
    S(k.cylinder(x, y, 4.6, 10, 104, P, 28), {
      tone: "mid",
      crease: "none",
      inner: L(
        [40, 70, 100].map((z) => k.sideArc(x, y, 4.6, z, P, 16)).join(""),
        { tone: "faint" },
      ),
    }),
  );
  // Clamp block, thumb screw and the arm reaching over the stage.
  out.push(
    S(
      k.slabOf(
        { x: x - 8, y: y - 8, w: 16, d: 16, r: 2.5 },
        112,
        16,
        P,
        4,
        0.6,
      ),
      {
        tone: "mid",
        inner: L(
          k.sideSeam({ x: x - 8, y: y - 8, w: 16, d: 16, r: 2.5 }, 120, P, 4),
          { tone: "faint" },
        ),
      },
    ),
  );
  out.push(S(k.cylinder(x, y, 4.6, 128, 6, P, 28), { tone: "mid" }));
  out.push(S(k.cylinder(x, y, 5.2, 134, 1.6, P, 28), { tone: "mid" }));
  out.push(
    micrometer([x + 8, y, 120], [1, 0, 0], {
      barrel: 1.6,
      thimble: 3,
      length: 7,
    }),
  );
  return out.join("");
}

function microscopeFront() {
  const [x, y] = SCOPE;
  const out = [];
  const arm = {
    x: x - 5,
    y: MICROSCOPE[1] + 8,
    w: 10,
    d: y - MICROSCOPE[1] - 8,
    r: 2,
  };
  out.push(
    S(k.slabOf(arm, 116, 8, P, 4, 0.6), {
      tone: "mid",
      inner: L(k.sideSeam(arm, 120, P, 4), { tone: "faint" }),
    }),
  );
  out.push(
    D([at([x, MICROSCOPE[1] + 14, 124]), at([x, y - 16, 124])], { size: 0.45 }),
  );
  // Body: nosepiece, objective with its ring light, focus drive, head, eyepieces.
  out.push(
    S(k.cylinder(x, y, 7, 90, 26, P, 40), {
      tone: "mid",
      inner: L([98, 108].map((z) => k.sideArc(x, y, 7, z, P, 24)).join(""), {
        tone: "faint",
      }),
    }),
  );
  out.push(S(k.cylinder(x, y, 9.5, 84, 6, P, 48, 0.5), { tone: "mid" }));
  out.push(L(k.knurl(x, y, 9.5, 84, 90, 40, P), { tone: "lo" }));
  out.push(S(k.cylinder(x, y, 11, 80, 4, P, 48), { tone: "lo" }));
  out.push(
    S(k.cylinder(x, y, 4, 70, 10, P, 28), {
      tone: "hi",
      inner: L(k.sideArc(x, y, 4, 76, P, 16), { tone: "lo" }),
    }),
  );
  out.push(S(k.cylinder(x, y, 2.6, 66, 4, P, 20), { tone: "hi" }));
  out.push(
    micrometer([x + 7, y, 104], [1, 0, 0], {
      barrel: 2,
      thimble: 5.2,
      length: 7,
    }),
  );
  const head = { x: x - 12, y: y - 12, w: 24, d: 22, r: 4 };
  out.push(
    S(k.slabOf(head, 124, 12, P, 6, 0.8), {
      tone: "mid",
      inner: L(k.sideSeam(head, 130, P, 6), { tone: "faint" }),
    }),
  );
  for (const [ex, ey] of byDepth([
    [x - 5, y - 4],
    [x + 5, y - 4],
  ])) {
    out.push(S(k.cylinder(ex, ey, 3.4, 136, 10, P, 24), { tone: "mid" }));
    out.push(S(k.cylinder(ex, ey, 4, 146, 3.4, P, 24, 0.4), { tone: "lo" }));
  }
  return out.join("");
}

function stageBase() {
  const out = [`<path class="iso-halo" d="${k.haloOf(BASE, 0, BASE_H, P)}"/>`];
  out.push(S(k.slabOf(BASE, 0, BASE_H, P, 4, 0.8), { tone: "mid" }));
  for (const x of [BASE.x + 8, BASE.x + BASE.w - 13]) {
    out.push(
      S(
        k.slabOf(
          { x, y: BASE.y + 4, w: 5, d: BASE.d - 8, r: 1 },
          BASE_H,
          1.4,
          P,
          3,
          0.3,
        ),
        { tone: "lo" },
      ),
    );
    out.push(
      D(
        [
          at([x + 2.5, BASE.y + 7, BASE_H + 1.4]),
          at([x + 2.5, BASE.y + BASE.d - 7, BASE_H + 1.4]),
        ],
        { size: 0.4 },
      ),
    );
  }
  out.push(
    micrometer([20, BASE.y + BASE.d, 3], [0, 1, 0], {
      barrel: 2.4,
      thimble: 3.4,
      length: 14,
    }),
  );
  return out.join("");
}

function ySlide() {
  const out = [];
  out.push(
    S(k.slabOf(YSLIDE, YSLIDE_Z[0], YSLIDE_Z[1] - YSLIDE_Z[0], P, 4, 0.6), {
      tone: "mid",
    }),
  );
  for (const y of [YSLIDE.y + 6, YSLIDE.y + YSLIDE.d - 11]) {
    out.push(
      S(
        k.slabOf(
          { x: YSLIDE.x + 4, y, w: YSLIDE.w - 8, d: 5, r: 1 },
          YSLIDE_Z[1],
          1.4,
          P,
          3,
          0.3,
        ),
        { tone: "lo" },
      ),
    );
    out.push(
      D(
        [
          at([YSLIDE.x + 7, y + 2.5, YSLIDE_Z[1] + 1.4]),
          at([YSLIDE.x + YSLIDE.w - 7, y + 2.5, YSLIDE_Z[1] + 1.4]),
        ],
        { size: 0.4 },
      ),
    );
  }
  out.push(
    D(
      [-30, -15, 0, 15, 30].map((x) =>
        at([x, YSLIDE.y + YSLIDE.d, YSLIDE_Z[0] + 2.5]),
      ),
      { size: 0.4, tone: "lo" },
    ),
  );
  return out.join("");
}

function pads() {
  const out = [];
  const [cx, cy] = CENTRE;
  const edge = DIE / 2 - PAD_INSET;
  const list = [];
  for (let i = 0; i < PADS_PER_SIDE; i++) {
    const a = padAlong(i);
    list.push([a, -edge], [a, edge], [-edge, a], [edge, a]);
  }
  const step = (p) =>
    STEPS.findIndex(
      (s) =>
        Math.abs(s.pad[0] - p[0]) < 0.01 && Math.abs(s.pad[1] - p[1]) < 0.01,
    );
  for (const p of byDepth(list.map(([px, py]) => [cx + px, cy + py]))) {
    const local = [p[0] - cx, p[1] - cy];
    const index = step(local);
    const plan = {
      x: p[0] - PAD / 2,
      y: p[1] - PAD / 2,
      w: PAD,
      d: PAD,
      r: 0.3,
    };
    const paths = k.slabOf(plan, DIE_TOP, PAD_H, P, 2);
    out.push(
      index >= 0
        ? `<g class="ps-pad" data-pad="${index}"${index === 0 ? " data-on" : ""}>${S(paths, { tone: "hi", crease: "none" })}</g>`
        : S(paths, { tone: "mid", crease: "none" }),
    );
  }
  return out.join("");
}

function chuckAndChip() {
  const [cx, cy] = CENTRE;
  const out = [];
  out.push(
    S(k.slabOf(XSLIDE, XSLIDE_Z[0], XSLIDE_Z[1] - XSLIDE_Z[0], P, 4, 0.6), {
      tone: "mid",
    }),
  );
  out.push(
    D(
      k.corners(XSLIDE, 4).map(([x, y]) => at([x, y, XSLIDE_Z[1]])),
      { size: 0.45 },
    ),
  );
  out.push(
    micrometer([XSLIDE.x + XSLIDE.w, 46, 13.5], [1, 0, 0], {
      barrel: 2,
      thimble: 3,
      length: 12,
    }),
  );
  // Vacuum chuck: knurled rim, concentric grooves, a centre port.
  out.push(
    S(
      k.cylinder(
        cx,
        cy,
        CHUCK_R,
        CHUCK_Z[0],
        CHUCK_Z[1] - CHUCK_Z[0],
        P,
        72,
        0.8,
      ),
      { tone: "hi", crease: "lo" },
    ),
  );
  out.push(
    L(k.knurl(cx, cy, CHUCK_R, CHUCK_Z[0] + 1, CHUCK_Z[1] - 1, 96, P, 0.3), {
      tone: "faint",
    }),
  );
  out.push(
    L([30, 26.5].map((r) => k.ring(cx, cy, r, CHUCK_Z[1], P, 72)).join(""), {
      tone: "faint",
    }),
  );
  out.push(L(k.ring(cx, cy, 29.2, CHUCK_Z[1], P, 72), { tone: "lo" }));
  // Package: ceramic body with leads on all four sides resting on the chuck.
  const pkg = { x: cx - PKG / 2, y: cy - PKG / 2, w: PKG, d: PKG, r: 1.4 };
  const leads = [];
  for (let i = 0; i < 9; i++) {
    const a = -16 + i * 4;
    leads.push(
      { x: cx + a - 0.6, y: cy - PKG / 2 - 2.4, w: 1.2, d: 2.6, r: 0.2 },
      { x: cx + a - 0.6, y: cy + PKG / 2 - 0.2, w: 1.2, d: 2.6, r: 0.2 },
    );
    leads.push(
      { x: cx - PKG / 2 - 2.4, y: cy + a - 0.6, w: 2.6, d: 1.2, r: 0.2 },
      { x: cx + PKG / 2 - 0.2, y: cy + a - 0.6, w: 2.6, d: 1.2, r: 0.2 },
    );
  }
  const leadDepth = (l) => k.depthOf([l.x + l.w / 2, l.y + l.d / 2, 0], P);
  const pkgDepth = k.depthOf([cx, cy, 0], P);
  const leadSvg = (l) =>
    S(k.slabOf(l, CHUCK_Z[1], 0.5, P, 2), { tone: "lo", crease: "none" });
  out.push(
    leads
      .filter((l) => leadDepth(l) < pkgDepth)
      .sort((a, b) => leadDepth(a) - leadDepth(b))
      .map(leadSvg)
      .join(""),
  );
  out.push(
    S(k.slabOf(pkg, PKG_Z[0], PKG_Z[1] - PKG_Z[0], P, 3, 0.5), { tone: "mid" }),
  );
  out.push(
    L(k.ring(pkg.x + 4, pkg.y + 4, 1.1, PKG_Z[1], P, 14), { tone: "lo" }),
  );
  out.push(
    leads
      .filter((l) => leadDepth(l) >= pkgDepth)
      .sort((a, b) => leadDepth(a) - leadDepth(b))
      .map(leadSvg)
      .join(""),
  );
  // Die: the program as shipped. Its floorplan is engraved on the top.
  const die = { x: cx - DIE / 2, y: cy - DIE / 2, w: DIE, d: DIE, r: 0.6 };
  out.push(
    S(k.slabOf(die, DIE_Z[0], DIE_Z[1] - DIE_Z[0], P, 2, 0.3), {
      tone: "hi",
      crease: "lo",
    }),
  );
  const blocks = [
    { x: cx - 10, y: cy - 10, w: 9, d: 11, r: 0.4 },
    { x: cx + 1, y: cy - 10, w: 9, d: 5, r: 0.4 },
    { x: cx + 1, y: cy - 3, w: 9, d: 4, r: 0.4 },
    { x: cx - 10, y: cy + 3, w: 20, d: 7, r: 0.4 },
  ];
  out.push(
    L(blocks.map((b) => k.planOutline(b, DIE_TOP, P, 2)).join(""), {
      tone: "faint",
    }),
  );
  out.push(
    D(k.dotGrid(cx - 8.6, cy + 4.4, 10, 3, 2, DIE_TOP, P), {
      size: 0.32,
      tone: "lo",
    }),
  );
  out.push(
    L(k.planOutline(k.insetPlan(die, 3.6), DIE_TOP, P, 2), { tone: "faint" }),
  );
  out.push(pads());
  return out.join("");
}

// A probe positioner on a magnetic base. `side` is +1 for the one right of the
// stage, -1 for the one left of it.
function positionerBase(side) {
  const x0 = side > 0 ? 72 : -112;
  const base = { x: x0, y: -4, w: 40, d: 44, r: 3 };
  const out = [`<path class="iso-halo" d="${k.haloOf(base, 0, 12, P)}"/>`];
  out.push(S(k.slabOf(base, 0, 5, P, 4, 0.5), { tone: "lo" }));
  out.push(
    S(k.slabOf(k.insetPlan(base, 1), 5, 9, P, 4, 0.8), {
      tone: "mid",
      inner: L(k.sideSeam(k.insetPlan(base, 1), 9.5, P, 4), { tone: "faint" }),
    }),
  );
  out.push(
    D(
      k.corners(base, 4).map(([x, y]) => at([x, y, 14])),
      { size: 0.45 },
    ),
  );
  // Magnet lever on the base top.
  const lever = [x0 + (side > 0 ? 32 : 8), base.y + 8];
  out.push(
    S(k.cylinder(lever[0], lever[1], 3.2, 14, 2, P, 20), { tone: "mid" }),
  );
  out.push(
    S(
      k.slabOf(
        { x: lever[0] - 1, y: lever[1], w: 2, d: 9, r: 0.8 },
        15,
        2,
        P,
        2,
      ),
      { tone: "mid" },
    ),
  );
  out.push(
    S(k.cylinder(lever[0], lever[1] + 9.5, 1.8, 14.5, 4, P, 16), {
      tone: "lo",
    }),
  );
  out.push(bnc([x0 + 18, base.y + base.d, 7], [0, 1, 0]));
  // Cross slides with their micrometers.
  const b1 = { x: x0 + 6, y: 4, w: 28, d: 26, r: 2 };
  out.push(
    S(k.slabOf(b1, 14, 11, P, 3, 0.6), {
      tone: "mid",
      inner: L(k.sideSeam(b1, 19.5, P, 3), { tone: "faint" }),
    }),
  );
  out.push(
    micrometer([x0 + 20, b1.y + b1.d, 19.5], [0, 1, 0], {
      barrel: 1.8,
      thimble: 3.2,
      length: 10,
    }),
  );
  const b2 = { x: x0 + 8, y: 6, w: 24, d: 22, r: 2 };
  out.push(
    S(k.slabOf(b2, 25, 10, P, 3, 0.6), {
      tone: "mid",
      inner: L(k.sideSeam(b2, 30, P, 3), { tone: "faint" }),
    }),
  );
  out.push(
    micrometer([side > 0 ? b2.x + b2.w : b2.x + b2.w, 17, 30], [1, 0, 0], {
      barrel: 1.8,
      thimble: 3.2,
      length: 10,
    }),
  );
  out.push(S(k.cylinder(x0 + 20, 17, 3.6, 35, 5, P, 24), { tone: "mid" }));
  out.push(L(k.knurl(x0 + 20, 17, 3.6, 35, 40, 24, P), { tone: "lo" }));
  out.push(L(k.lineOnTop([x0 + 20, 17], [x0 + 23, 17], 40, P), { tone: "hi" }));
  return out.join("");
}

// Probe holder: a split clamp block, its clamp screw, and a collet at the
// lower corner that the needle leaves from.
function holder(plan, nose, side) {
  const out = [];
  out.push(
    S(k.slabOf(plan, 31.5, 9.5, P, 3, 0.5), {
      tone: "mid",
      inner: L(k.sideSeam(plan, 36, P, 3), { tone: "faint" }),
    }),
  );
  out.push(
    D(
      [
        at([plan.x + 2.2, plan.y + 2.2, 41]),
        at([plan.x + plan.w - 2.2, plan.y + plan.d - 2.2, 41]),
      ],
      { size: 0.4 },
    ),
  );
  const screw = [plan.x + plan.w / 2, plan.y + plan.d];
  out.push(
    micrometer([screw[0], screw[1], 38.5], [0, 1, 0], {
      barrel: 1,
      thimble: 1.6,
      length: 3.4,
    }),
  );
  out.push(
    S(k.cylinder(nose[0], nose[1], 1.5, 29, 2.5, P, 16), { tone: "mid" }),
  );
  out.push(
    S(k.cylinder(nose[0], nose[1], 0.9, 27.6, 1.4, P, 12), { tone: "hi" }),
  );
  return out.join("");
}

// The arm, probe holder and needle: the part that lifts between pads.
function positionerArm(side) {
  const out = [];
  if (side > 0) {
    const arm = { x: 36, y: 13, w: 44, d: 8, r: 2 };
    out.push(S(k.slabOf(arm, 33, 4, P, 3, 0.5), { tone: "mid" }));
    out.push(D([at([74, 17, 37]), at([42, 17, 37])], { size: 0.42 }));
    out.push(holder({ x: 28, y: 11, w: 11, d: 12, r: 1.4 }, [30, 14], 1));
    out.push(S(k.cylinder(35, 17, 2.2, 41, 4, P, 18), { tone: "lo" }));
    out.push(S(k.cylinder(35, 17, 1.4, 45, 2, P, 14), { tone: "mid" }));
    out.push(
      `<path class="iso-line ps-needle" data-tone="lit" d="${k.segment([30, 14, 27.6], TIP, P)}"/>`,
    );
    out.push(
      `<circle class="ps-tip" cx="${at(TIP)[0].toFixed(1)}" cy="${at(TIP)[1].toFixed(1)}" r="0.7"/>`,
    );
  } else {
    const arm = { x: -80, y: 13, w: 44, d: 8, r: 2 };
    out.push(S(k.slabOf(arm, 33, 4, P, 3, 0.5), { tone: "mid" }));
    out.push(D([at([-74, 17, 37]), at([-42, 17, 37])], { size: 0.42 }));
    out.push(holder({ x: -39, y: 11, w: 11, d: 12, r: 1.4 }, [-30, 14], -1));
    out.push(S(k.cylinder(-35, 17, 2.2, 41, 4, P, 18), { tone: "lo" }));
    out.push(S(k.cylinder(-35, 17, 1.4, 45, 2, P, 14), { tone: "mid" }));
    const parked = [
      CENTRE[0] - DIE / 2 + PAD_INSET + 0.4,
      CENTRE[1] - 3,
      DIE_TOP + 6,
    ];
    out.push(L(k.segment([-30, 14, 27.6], parked, P), { tone: "hi" }));
    out.push(D([at(parked)], { size: 0.5, tone: "hi" }));
  }
  return out.join("");
}

const [startDx, startDy] = stageFor(0, TIP, CENTRE);
const body = [
  plate(),
  cables(),
  instrument(),
  microscopeBack(),
  positionerBase(-1),
  stageBase(),
  `<g data-part="yslide" transform="${k.translateAlong(P, [0, startDy, 0])}">${ySlide()}</g>`,
  `<g data-part="xslide" transform="${k.translateAlong(P, [startDx, startDy, 0])}">${chuckAndChip()}</g>`,
  positionerArm(-1),
  positionerBase(1),
  `<g data-part="arm">${positionerArm(1)}</g>`,
  microscopeFront(),
];

const svg = k.figureSvg({
  width: WIDTH,
  height: HEIGHT,
  className: "ps-svg",
  label:
    "A probe station on a breadboard plate. A chip sits on a vacuum chuck carried by two slides. A needle on a positioner touches one bond pad at a time while a microscope looks down from above, and an instrument on the left shows what each pad reads: the file, the function, two instructions and the result of Calculator's percent rule.",
  body,
});

// Screen vectors of one world unit, so the live script can move groups.
const basis = [
  k.axisVector(P, [1, 0, 0]),
  k.axisVector(P, [0, 1, 0]),
  k.axisVector(P, [0, 0, 1]),
];
const live = {
  basis,
  lift: LIFT,
  stages: STEPS.map((_, index) => stageFor(index, TIP, CENTRE)),
  steps: STEPS.map(({ lines, readout }) => ({ lines, readout })),
};

const CSS = `
.ps-cable .iso-line{stroke-width:1.15px}
.ps-well{fill:var(--anatomy-shade-1)}
.ps-bezel{fill:var(--anatomy-top)}
.ps-glass{fill:var(--ps-glass)}
.ps-scan{fill:none;stroke:var(--anatomy-faint);stroke-width:.4px;vector-effect:non-scaling-stroke;opacity:.55}
.ps-rule{fill:none;stroke:var(--anatomy-lo);stroke-width:.5px;vector-effect:non-scaling-stroke}
.ps-status{fill:var(--anatomy-mid);font-family:var(--anatomy-mono);letter-spacing:.06em}
.ps-text{font-family:var(--anatomy-mono);fill:var(--anatomy-mid);transition:opacity .16s ease}
.ps-text[data-tone="hi"]{fill:var(--ps-ink)}
[data-part="lines"][data-fading] .ps-text{opacity:0}
.ps-led{fill:var(--ps-accent)}
.ps-tip{fill:var(--anatomy-lit)}
.ps-needle{stroke-width:1.05px}
.ps-pad .iso-fill,.ps-pad .iso-top{transition:fill .2s ease}
.ps-pad[data-on] .iso-fill,.ps-pad[data-on] .iso-top,.ps-pad[data-on] .iso-shade{fill:var(--ps-accent)}
.ps-pad[data-on] .iso-edge{stroke:var(--ps-accent)}
`;

const marker = ["<!-- probe-station:start -->", "<!-- probe-station:end -->"];
const indexPath = join(PUBLIC, "index.html");
const index = readFileSync(indexPath, "utf8");
const start = index.indexOf(marker[0]);
const end = index.indexOf(marker[1]);
if (start < 0 || end < start)
  throw new Error("index.html has no probe-station markers");
// The stage around the SVG carries the translated label; the drawing itself is decoration for screen readers.
const inline = svg.replace(
  / role="img" aria-label="[^"]*"/,
  ' aria-hidden="true" focusable="false"',
);
writeFileSync(
  indexPath,
  index.slice(0, start + marker[0].length) + inline + index.slice(end),
);
const runtime = readFileSync(join(HERE, "live.js"), "utf8");
writeFileSync(
  join(PUBLIC, "assets/probe-station.js"),
  `// Generated by website/figures/probe-station/build.mjs; edit live.js and model.mjs.\nconst DATA = ${JSON.stringify(live)};\n${runtime}`,
);
writeFileSync(
  join(PUBLIC, "assets/probe-station.css"),
  "/* Generated by website/figures/probe-station/build.mjs from the MIT isometric kit. */\n" +
    k.ISO_CSS +
    CSS,
);
console.log("probe station:", svg.length, "bytes of SVG");

if (process.argv.includes("--preview")) {
  for (const theme of ["light", "dark"]) {
    const page = k.pageHtml({
      title: "Probe station",
      theme,
      width: 760,
      body:
        `<style>${CSS}.iso{--ps-accent:#2f54c8;--ps-ink:var(--anatomy-lit);--ps-glass:var(--anatomy-shade-0)}</style>` +
        k.plateHtml({
          fig: "Fig 1",
          title: "Probe station",
          hint: "Click to step",
          readout: STEPS[0].readout,
          body: `<div class="iso-stage">${svg}</div>`,
        }),
    });
    writeFileSync(join(HERE, `preview-${theme}.html`), page);
  }
  console.log("wrote preview-light.html and preview-dark.html");
}
