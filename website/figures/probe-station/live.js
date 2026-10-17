// Probe station: lift the needle, carry the next pad under it, lower it, read.
// DATA is prepended by build.mjs: screen basis vectors, stage offsets per step,
// and the recorded lines each pad reads.
(() => {
  const stage = document.querySelector("[data-ps-stage]");
  const svg = stage && stage.querySelector("svg");
  if (!svg) return;
  const part = (name) => svg.querySelector(`[data-part="${name}"]`);
  const yslide = part("yslide");
  const xslide = part("xslide");
  const arm = part("arm");
  const lines = part("lines");
  const count = part("count");
  const pads = [...svg.querySelectorAll(".ps-pad")];
  const readout = document.querySelector("[data-ps-readout]");
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const [ex, ey, ez] = DATA.basis;
  const total = DATA.steps.length;
  const pad2 = (n) => String(n).padStart(2, "0");

  const move = (el, dx, dy, dz) =>
    el.setAttribute(
      "transform",
      `translate(${(ex[0] * dx + ey[0] * dy + ez[0] * dz).toFixed(2)} ${(ex[1] * dx + ey[1] * dy + ez[1] * dz).toFixed(2)})`,
    );
  const follow = (value, target, dt, seconds) =>
    target + (value - target) * Math.exp(-dt / seconds);

  let step = 0;
  let pos = [...DATA.stages[0]];
  let lift = 0;
  let phase = "rest";
  let frame = 0;
  let last = 0;
  let visible = false;
  let tourTimer = 0;
  let swapTimer = 0;

  function draw() {
    move(yslide, 0, pos[1], 0);
    move(xslide, pos[0], pos[1], 0);
    move(arm, 0, 0, lift);
  }

  function contact(index) {
    pads.forEach((pad) =>
      pad.toggleAttribute("data-on", Number(pad.dataset.pad) === index),
    );
    const { lines: text, readout: value } = DATA.steps[index];
    clearTimeout(swapTimer);
    const swap = () => {
      lines
        .querySelectorAll("text")
        .forEach((node, i) => (node.textContent = text[i] || ""));
      count.textContent = `${pad2(index + 1)} / ${pad2(total)}`;
      lines.removeAttribute("data-fading");
    };
    if (still.matches) swap();
    else {
      lines.setAttribute("data-fading", "");
      swapTimer = setTimeout(swap, 160);
    }
    if (readout) readout.textContent = value;
    stage.setAttribute("aria-valuenow", String(index + 1));
    stage.setAttribute(
      "aria-valuetext",
      `${pad2(index + 1)} / ${pad2(total)}: ${text.join(", ")}`,
    );
  }

  function tick(now) {
    const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
    last = now;
    const target = DATA.stages[step];
    if (phase === "lift") {
      lift = follow(lift, DATA.lift, dt, 0.09);
      if (DATA.lift - lift < 0.04) {
        lift = DATA.lift;
        phase = "move";
        pads.forEach((pad) => pad.removeAttribute("data-on"));
      }
    } else if (phase === "move") {
      pos = [
        follow(pos[0], target[0], dt, 0.22),
        follow(pos[1], target[1], dt, 0.22),
      ];
      if (Math.hypot(pos[0] - target[0], pos[1] - target[1]) < 0.05) {
        pos = [...target];
        phase = "lower";
      }
    } else if (phase === "lower") {
      lift = follow(lift, 0, dt, 0.08);
      if (lift < 0.03) {
        lift = 0;
        phase = "rest";
        contact(step);
      }
    }
    draw();
    frame = phase !== "rest" && visible ? requestAnimationFrame(tick) : 0;
  }

  function go(index) {
    step = ((index % total) + total) % total;
    if (still.matches) {
      pos = [...DATA.stages[step]];
      lift = 0;
      phase = "rest";
      draw();
      contact(step);
      return;
    }
    if (phase === "rest") phase = "lift";
    if (!frame && visible) {
      last = 0;
      frame = requestAnimationFrame(tick);
    }
  }

  // The tour reads one pad every few seconds while the figure is on screen,
  // and waits after someone steps it by hand.
  function schedule(delay = 3200) {
    clearTimeout(tourTimer);
    if (still.matches) return;
    tourTimer = setTimeout(() => {
      if (visible && !document.hidden) go(step + 1);
      schedule();
    }, delay);
  }

  stage.addEventListener("click", () => {
    go(step + 1);
    schedule(9000);
  });
  stage.addEventListener("keydown", (event) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      go(event.key === "Home" ? 0 : total - 1);
    } else if (event.key in keys) {
      event.preventDefault();
      go(step + keys[event.key]);
    } else return;
    schedule(9000);
  });
  new IntersectionObserver(
    (entries) => {
      visible = entries[entries.length - 1].isIntersecting;
      if (visible && phase !== "rest" && !frame)
        frame = requestAnimationFrame(tick);
    },
    { rootMargin: "80px 0px" },
  ).observe(stage);

  stage.tabIndex = 0;
  stage.setAttribute("role", "slider");
  stage.setAttribute("aria-valuemin", "1");
  stage.setAttribute("aria-valuemax", String(total));
  stage.setAttribute("aria-valuenow", "1");
  stage.dataset.live = "";
  draw();
  schedule();
})();
