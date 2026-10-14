/**
 * The drifting star field behind the page.
 *
 * Why a library for this
 * ----------------------
 * The effect is a few dozen points drifting, with a line drawn between any two
 * that pass close to one another. That geometry is the whole of it, but it is
 * geometry that has to be right every frame: particles are removed and respawned
 * as they leave the frame, lines are redrawn with a distance-faded alpha, and
 * the backing store is scaled for retina. particles.js has done all of that
 * since 2015 and is 23KB. Writing it again would be about 60 lines that someone
 * else then has to keep correct.
 *
 * It is loaded by inserting a script tag rather than by importing it, because
 * particles.js is a classic script that publishes `window.particlesJS`. Deferring
 * it keeps 23KB off the critical path of a page whose first job is to be
 * searchable — the field arrives a moment after the results do.
 *
 * Tuning
 * ------
 * The brief was sparse: mostly isolated points, a handful of faint links, the
 * whole field drifting. particles.js links anything within
 * `line_linked.distance`, so that number is what turns a dense web into a
 * night sky — at 30px almost nothing joins, which is the look wanted.
 *
 * Speed is the other half of that. It was originally 0.18, on the theory that a
 * slow point keeps links from strobing — but that measured out at about a pixel
 * a second, which reads as a still image rather than a sky. Raising it showed
 * the worry was unfounded: with only a few dozen points and a 30-50px link
 * radius, the link count sits between two and six at every speed tried, so
 * there was never churn to protect against. 2 puts a point at roughly 25px a
 * second — plainly drifting, and still unhurried.
 */

const SKY_ID = "sky";
const SKY_SRC = "./particles.min.js";

/** The colour the stars should take: the active theme's ordinary text. */
const skyInk = () =>
  getComputedStyle(document.documentElement).getPropertyValue("--fg").trim() || "#ffffff";

/**
 * The link distance as a fraction of the viewport's smaller side.
 *
 * Fixed in pixels would make a phone nearly empty and an ultrawide nearly a
 * solid web, since particle count is fixed but the area is not. Scaling with
 * the frame keeps the same sparse ratio at every size.
 */
const linkDistance = () => Math.round(Math.min(innerWidth, innerHeight) * 0.035);

const options = () => {
  const ink = skyInk();
  return {
    particles: {
      number: { value: 34, density: { enable: true, area: 1300 } },
      color: { value: ink },
      shape: { type: "circle" },
      // Varying the alpha and the size is most of what makes the field read as
      // depth rather than as a uniform scatter of identical dots. particles.js
      // rolls both across the full 0..value range, so these are set high enough
      // that the middle of that range is a legible point rather than a speck.
      opacity: { value: 0.8, random: true, animation: { enable: false } },
      size: { value: 2.6, random: true, animation: { enable: false } },
      line_linked: {
        enable: true,
        distance: linkDistance(),
        color: ink,
        opacity: 0.1,
        width: 1,
      },
      line_joined: false,
      move: {
        enable: true,
        speed: 2,
        direction: "random",
        random: true,
        straight: false,
        out_mode: "out",
        attract: { enable: false },
      },
    },
    // No hover grab and no click push. Both draw extra links under the cursor,
    // which is exactly the dense web this is meant not to be.
    interactivity: {
      detect_on: "canvas",
      events: {
        onhover: { enable: false, mode: "grab" },
        onclick: { enable: false, mode: "push" },
        resize: true,
      },
    },
    retina_detect: true,
  };
};

function teardown() {
  // `particlesJS()` returns nothing — it publishes the instance by pushing it
  // onto `window.pJSDom`, so that array is the only handle on it. Holding the
  // return value of the constructor gives `undefined`, and every later rebuild
  // then quietly does nothing.
  const list = window.pJSDom;
  if (!list || !list.length) return;
  const entry = list[list.length - 1];
  try {
    // The library's own method, typo and all.
    entry?.pJS?.fn?.vendors?.destropJS();
  } catch {
    /* already gone */
  }
  list.length = 0;
}

/** Whether a field is currently running. */
const isRunning = () => !!window.pJSDom?.length;

function build() {
  if (!window.particlesJS) return;
  teardown();
  const host = document.getElementById(SKY_ID);
  if (!host) return;
  host.textContent = "";
  window.particlesJS(SKY_ID, options());
}

let loading = false;

export function startSky() {
  const host = document.getElementById(SKY_ID);
  if (!host) return;

  // Reduced motion means no drifting field at all. The page is unchanged; it
  // simply arrives without a sky.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (isRunning() || loading) return;

  loading = true;
  const el = document.createElement("script");
  el.src = SKY_SRC;
  el.async = true;
  el.onload = () => {
    loading = false;
    build();
  };
  el.onerror = () => {
    loading = false;
  };
  document.head.appendChild(el);
}

/**
 * Repaint the running field in a new colour, without rebuilding it.
 *
 * The obvious implementation — tear the field down and make a new one — is
 * wrong, and visibly so: it discards every particle's position and velocity, so
 * the whole sky jumps and restarts on each click of a control the reader is
 * likely to press more than once. Instead the library reads `color.rgb` off
 * each particle inside its per-frame draw, so writing the new colour straight
 * onto the live particles takes effect on the next frame and the drift carries
 * on undisturbed.
 */
export function retintSky() {
  const list = window.pJSDom;
  const p = list && list.length ? list[list.length - 1].pJS : null;
  if (!p) return;
  const ink = skyInk();
  const rgb = toRgb(ink);
  p.particles.color.value = ink;
  p.particles.array.forEach((q) => {
    q.color.value = ink;
    q.color.rgb = rgb;
  });
  // Links are painted from a single value computed once at startup, so it has
  // to be rewritten as well or the lines would keep the old theme's colour.
  p.particles.line_linked.color = ink;
  p.particles.line_linked.color_rgb_line = rgb;
}

/** `#abc` / `#aabbcc` to the {r,g,b} the canvas wants. */
function toRgb(hex) {
  let h = String(hex).trim().replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = Number.parseInt(h, 16);
  if (!Number.isFinite(n)) return { r: 255, g: 255, b: 255 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
