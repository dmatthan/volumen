/**
 * The motion system. Position is measured in columns (the index of the first column in
 * the focus window); time in seconds.
 *
 * Every move is continuous in position, velocity and acceleration. A move toward a
 * target is a quintic from the current state (p, v, a) to (target, 0, 0): the
 * minimum-jerk path, which is how an unhurried hand moves. New input bends the path from
 * wherever the sheet is, instead of restarting it.
 *
 *   tap     a set (Space) or one column (arrows) on a minimum-jerk curve
 *   cruise  a held key or press: speed eases up to a calm cruise, then on release the
 *           sheet decelerates onto the next boundary ahead
 *   direct  a trackpad or a drag moves the sheet 1:1; on release it settles on the column
 *           nearest where the hand let go (a flick: the next one that way)
 */

/** Seconds for a one-column tap; each extra column in a set adds a little. */
export const TAP_S = 0.55;
const TAP_EXTRA_S = 0.1;
/** A tap from rest starts already moving (this fraction of the mean speed), so it answers
 *  at once instead of easing out of standstill; it still lands with no velocity. */
const TAP_KICK = 1.15;
/** Braking when a held key is released, columns per second squared. */
const BRAKE = 24;
/** How far ahead of the sheet wheel notches may build up, in columns: a long spin travels
 *  that far, a wild one no further. */
const WHEEL_LEAD = 16;
/** A push shorter than a column that moved at least this far lands on the next column in
 *  its direction instead of falling back. */
const INTENT = 0.12;
/** Cruise: starting and top speed in columns per second, ramp time, and how quickly the
 *  speed follows its target (a first-order lag, so the hand never feels a jolt). */
const CRUISE_V0 = 1.6, CRUISE_VMAX = 3.2, CRUISE_RAMP_S = 3, CRUISE_LAG_S = 0.2;
/** After the first ramp, a long hold keeps gathering speed toward this, for long trips. */
const CRUISE_VFAR = 9, CRUISE_FAR_S = 6;

/** The current frame's time. Input arrives mid-frame; trajectories are anchored to the
 *  frame, so the next frame (stamped later) already shows movement and none goes back. */
const frameNow = () => (document.timeline?.currentTime as number | null) ?? performance.now();

class Quintic {
  private c: number[];
  constructor(p0: number, v0: number, a0: number, public p1: number, public T: number) {
    const h = p1 - p0, T2 = T * T, T3 = T2 * T;
    this.c = [
      p0, v0, a0 / 2,
      (20 * h - 12 * v0 * T - 3 * a0 * T2) / (2 * T3),
      (-30 * h + 16 * v0 * T + 3 * a0 * T2) / (2 * T3 * T),
      (12 * h - 6 * v0 * T - a0 * T2) / (2 * T3 * T2),
    ];
  }
  at(t: number): [number, number, number] {
    if (t >= this.T) return [this.p1, 0, 0];
    const c = this.c;
    const p = c[0] + t * (c[1] + t * (c[2] + t * (c[3] + t * (c[4] + t * c[5]))));
    const v = c[1] + t * (2 * c[2] + t * (3 * c[3] + t * (4 * c[4] + t * 5 * c[5])));
    const a = 2 * c[2] + t * (6 * c[3] + t * (12 * c[4] + t * 20 * c[5]));
    return [p, v, a];
  }
}

type Mode = 'rest' | 'traj' | 'cruise' | 'direct';

export interface MotionHost {
  /** Bounds of the position. */
  min(): number;
  max(): number;
  /** Columns a tap moves. */
  spread(): number;
  reduced(): boolean;
  /** Called every frame the position changes. */
  frame(p: number, v: number): void;
  /** Called once when the sheet comes to rest on a boundary. */
  rest(k: number): void;
}

export class Motion {
  p = 0; v = 0; a = 0;
  mode: Mode = 'rest';
  private traj: Quintic | null = null;
  private t0 = 0;
  private raf = 0;
  private last = 0;
  private cruiseDir = 0; private cruiseT0 = 0;
  private samples: [number, number][] = [];   // direct: (time, position)

  constructor(private host: MotionHost) {}

  get moving() { return this.mode !== 'rest'; }
  /** Where the sheet will come to rest if nothing else happens. */
  get target() { return this.mode === 'traj' && this.traj ? this.traj.p1 : this.mode === 'rest' ? this.p : NaN; }

  private clamp(x: number) { return Math.max(this.host.min(), Math.min(this.host.max(), x)); }

  /** Puts the sheet at k at once. */
  jump(k: number) {
    this.stopLoop();
    this.p = this.clamp(k); this.v = 0; this.a = 0; this.mode = 'rest'; this.traj = null;
    this.host.frame(this.p, 0);
  }

  /** Moves to `target` from the current state over `T` seconds. */
  toward(target: number, T?: number, kick = false) {
    target = this.clamp(Math.round(target));
    const h = target - this.p;
    if (this.host.reduced()) {
      // with less motion, a tap or a key moves at once; but a sheet a hand has moved part
      // of the way (a drag let go) is carried the rest briefly, not snapped: the motion
      // is the hand's own, and a jump there reads as a jolt
      const midway = Math.abs(this.p - Math.round(this.p)) > 0.02 || this.mode === 'direct';
      if (!midway || Math.abs(h) > 1.5) { this.jump(target); this.host.rest(target); return; }
      T = Math.min(0.16, 0.07 + 0.09 * Math.abs(h));
      kick = false;
    }
    if (T == null) T = TAP_S + TAP_EXTRA_S * Math.max(0, Math.abs(h) - 1);
    if (Math.abs(h) < 1e-4 && Math.abs(this.v) < 1e-3) { this.jump(target); this.host.rest(target); return; }
    // from standstill, start with some velocity: the sheet answers on the first frame
    const v0 = this.mode === 'rest' && kick ? Math.sign(h) * TAP_KICK * Math.abs(h) / T : this.v;
    this.traj = new Quintic(this.p, v0, this.mode === 'rest' ? 0 : this.a, target, T);
    this.t0 = frameNow();
    this.mode = 'traj';
    this.loop();
  }

  /** A tap: `n` columns on (a whole set by default) from where the sheet is going; at
   *  most one more tap's worth is queued. */
  tap(d: number, n = this.host.spread()) {
    const base = this.mode === 'traj' && this.traj ? this.traj.p1 : Math.round(this.p);
    // a tap while a tap is still far from landing does not stack further
    if (this.mode === 'traj' && Math.abs(base - this.p) > n * 1.25 && Math.sign(base - this.p) === d) return;
    this.toward(base + d * n, undefined, true);
  }

  /** A wheel notch: one column on from where the sheet is going. Unlike a tap, every
   *  notch counts (the hand chose the distance), up to WHEEL_LEAD columns ahead; one
   *  trajectory is retargeted, so a spin glides rather than stepping. */
  notch(d: number) {
    const base = this.mode === 'traj' && this.traj ? this.traj.p1 : Math.round(this.p);
    const target = this.clamp(base + d);
    if (target === base || Math.abs(target - this.p) > WHEEL_LEAD) return;
    // a spin's notches arrive faster than single notches land: keep the time to land per
    // column short when the lead grows, so the sheet keeps pace with the hand
    const h = Math.abs(target - this.p);
    this.toward(target, h <= 1.05 ? TAP_S : Math.min(1.1, 0.38 + 0.11 * h), true);
  }

  /** A held key or press: ease into a cruise. */
  cruise(d: number) {
    if (this.host.reduced()) return;
    this.cruiseDir = d;
    this.cruiseT0 = frameNow();
    this.mode = 'cruise';
    this.traj = null;
    this.loop();
  }

  /** End of a cruise: decelerate onto the next boundary ahead. */
  release() {
    if (this.mode !== 'cruise') return;
    // brake firmly onto the very next column the sheet can stop at
    const d = this.cruiseDir, v = Math.abs(this.v);
    const stop = (v * v) / (2 * BRAKE);
    const ahead = this.p + d * Math.max(0.04, stop);
    const target = this.clamp(d > 0 ? Math.ceil(ahead) : Math.floor(ahead));
    const h = Math.abs(target - this.p);
    this.toward(target, v > 0.05 ? Math.max(0.16, Math.min(0.45, (1.7 * h) / v)) : 0.3);
  }

  /** Smoothly lands on `target` from the current velocity (no overshoot, no jolt). */
  private landOn(target: number) {
    target = this.clamp(target);
    const h = Math.abs(target - this.p), v = Math.abs(this.v);
    const T = v > 0.05 && Math.sign(target - this.p) === Math.sign(this.v)
      ? Math.max(0.3, Math.min(1.0, (1.7 * h) / v))
      : Math.max(0.35, Math.min(0.8, 0.45 + 0.25 * h));
    this.toward(target, T);
  }

  /* ---------- direct manipulation (trackpad, drag) ---------- */
  private directFrom = 0;
  directStart() {
    this.stopLoop();
    this.traj = null;
    this.directFrom = this.p;
    this.mode = 'direct';
    this.a = 0;
    this.samples = [[performance.now(), this.p]];
  }

  /** Moves by `dc` columns, with resistance past the ends. */
  directBy(dc: number) {
    if (this.mode !== 'direct') this.directStart();
    const lo = this.host.min(), hi = this.host.max();
    let p = this.p + dc;
    // rubber band: past an end, travel is damped and saturates
    if (p < lo) p = lo - this.band(lo - p);
    else if (p > hi) p = hi + this.band(p - hi);
    if (this.p < lo || this.p > hi) p = this.p + dc * 0.3;
    this.p = p;
    const now = performance.now();
    this.samples.push([now, p]);
    while (this.samples.length > 2 && now - this.samples[0][0] > 90) this.samples.shift();
    const [t0, p0] = this.samples[0];
    this.v = now > t0 ? ((p - p0) / (now - t0)) * 1000 : 0;
    this.host.frame(this.p, this.v);
  }
  private band(x: number) { return 0.6 * (1 - 1 / (x * 0.9 + 1)); }

  /** Fingers lifted: glide to a boundary in the direction of travel. `flicked` means the
   *  system's momentum began, which says the hand threw the sheet: it goes on to the next
   *  boundary that way. */
  directEnd(flicked = false, wheel = false) {
    if (this.mode !== 'direct') return;
    // a hand that paused before letting go has no velocity left
    const lastT = this.samples.length ? this.samples[this.samples.length - 1][0] : 0;
    const v = performance.now() - lastT > 60 ? 0 : this.v;
    this.v = v;
    // the hand chose the distance: settle on one of the two columns either side of where
    // it let go. A throw goes on that way. A deliberate push of less than a column (a
    // trackpad's, or a drag still moving that way when let go) goes on to the next column
    // rather than falling back; a drag the hand held still lands on the nearer one.
    const proj = this.p + v * 0.12;
    const moved = this.p - this.directFrom;
    let target: number;
    if ((flicked && Math.abs(v) > 0.1) || Math.abs(v) > 0.6) target = v > 0 ? Math.ceil(this.p + 0.02) : Math.floor(this.p - 0.02);
    else if (Math.abs(moved) >= INTENT && Math.abs(moved) < 1 && (wheel ? Math.sign(v || moved) === Math.sign(moved) : Math.abs(v) > 0.05 && Math.sign(v) === Math.sign(moved))) target = moved > 0 ? Math.ceil(this.p) : Math.floor(this.p);
    else target = Math.round(proj);
    target = Math.max(Math.floor(this.p), Math.min(Math.ceil(this.p), target));
    this.landOn(target);
  }

  /* ---------- the loop ---------- */
  private loop() {
    if (this.raf) return;
    this.last = frameNow();
    const tick = (now: number) => {
      this.raf = 0;
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      if (this.mode === 'traj' && this.traj) {
        const t = Math.max(0, (now - this.t0) / 1000);
        [this.p, this.v, this.a] = this.traj.at(t);
        this.host.frame(this.p, this.v);
        if (t >= this.traj.T) {
          const k = this.traj.p1;
          this.mode = 'rest'; this.traj = null; this.v = 0; this.a = 0; this.p = k;
          this.host.rest(k);
          return;
        }
      } else if (this.mode === 'cruise') {
        const held = (now - this.cruiseT0) / 1000;
        const ramp = Math.min(1, held / CRUISE_RAMP_S);
        const far = Math.min(1, Math.max(0, held - CRUISE_RAMP_S) / CRUISE_FAR_S);
        // speeds scale with the set in view: three columns glide faster than one
        const scale = Math.sqrt(this.host.spread());
        const vt = this.cruiseDir * scale * (CRUISE_V0 + (CRUISE_VMAX - CRUISE_V0) * ramp * ramp * (3 - 2 * ramp) + (CRUISE_VFAR - CRUISE_VMAX) * far * far);
        const a = (vt - this.v) / CRUISE_LAG_S;
        this.v += a * dt;
        this.a = a;
        this.p += this.v * dt;
        if (this.p <= this.host.min() || this.p >= this.host.max()) {
          this.p = this.clamp(this.p);
          this.mode = 'rest'; this.v = 0; this.a = 0;
          this.host.frame(this.p, 0);
          this.toward(Math.round(this.p), 0.3);
          return;
        }
        this.host.frame(this.p, this.v);
      } else return;
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopLoop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}
