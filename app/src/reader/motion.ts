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
 *           sheet decelerates onto the next boundary ahead (worked out ahead: `Cruise`)
 *   direct  a trackpad or a drag moves the sheet 1:1; on release it settles on the column
 *           nearest where the hand let go (a flick: the next one that way)
 *
 * A move toward a target, and a cruise, are known when they start, so they are handed to
 * the compositor (`glide`), which draws them at the screen's own rate however often the
 * page gets a frame: Safari gives a page half of them in Low Power Mode, and when hot. The
 * loop still runs, for what follows the sheet (columns built ahead, the running head),
 * and reads the move rather than making it. Only the hand (`direct`) is followed frame
 * by frame: nothing knows ahead where it will go.
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
/** A cruise is worked out at this many steps a second: between two, the eye cannot tell a
 *  straight line from the curve, at any frame rate. */
const CRUISE_HZ = 240;
/** Seconds into a cruise after which its speed no longer changes (the ramps done, the lag
 *  caught up to within a hair): from then it is a straight line, to an end of the book. */
const CRUISE_SETTLED_S = CRUISE_RAMP_S + CRUISE_FAR_S + 1.5;
/** Keyframes a second, where a move curves: straight lines between them are its curve to
 *  well under a pixel. */
const KEYS_HZ = 60;
/** Times from 0 to `T` seconds, `KEYS_HZ` a second. */
function keyTimes(T: number): number[] {
  const n = Math.max(2, Math.ceil(T * KEYS_HZ));
  return Array.from({ length: n + 1 }, (_, i) => (T * i) / n);
}

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

/** A held key's or press's glide, worked out ahead from the state it began in: the speed
 *  eases up to a calm cruise (faster for a wider set in view) and, held long, gathers
 *  further for long trips; the sheet follows the speed with a short lag, so the hand never
 *  feels a jolt. Once the speed has settled it is a straight line; it stops at an end of
 *  the book. */
class Cruise {
  private ps: number[]; private vs: number[]; private as: number[];
  /** When the sheet reaches an end of the book, seconds in. */
  end = Infinity;

  constructor(p0: number, v0: number, private dir: number, private scale: number, private lo: number, private hi: number) {
    this.ps = [p0]; this.vs = [v0]; this.as = [this.accel(0, v0)];
  }

  private accel(t: number, v: number) {
    const ramp = Math.min(1, t / CRUISE_RAMP_S), far = Math.min(1, Math.max(0, t - CRUISE_RAMP_S) / CRUISE_FAR_S);
    const vt = this.dir * this.scale * (CRUISE_V0 + (CRUISE_VMAX - CRUISE_V0) * ramp * ramp * (3 - 2 * ramp) + (CRUISE_VFAR - CRUISE_VMAX) * far * far);
    return (vt - v) / CRUISE_LAG_S;
  }

  /** The curved part, worked out once: to the end of the book, or until the speed has
   *  settled, when the straight line from there finds the end. */
  private work() {
    const h = 1 / CRUISE_HZ, n = Math.ceil(CRUISE_SETTLED_S * CRUISE_HZ);
    for (let i = 0; i < n; i++) {
      const v = this.vs[i] + this.as[i] * h, p = this.ps[i] + v * h;
      if (p <= this.lo || p >= this.hi) {
        this.ps.push(Math.max(this.lo, Math.min(this.hi, p))); this.vs.push(0); this.as.push(0);
        this.end = (i + 1) * h;
        return;
      }
      this.ps.push(p); this.vs.push(v); this.as.push(this.accel((i + 1) * h, v));
    }
    const p = this.ps[n], v = this.vs[n];
    this.end = this.settled + Math.max(0, ((v > 0 ? this.hi : this.lo) - p) / v);
  }

  /** When the curved part ends, seconds in. */
  private get settled() { return (this.ps.length - 1) / CRUISE_HZ; }

  /** Position, speed and acceleration `t` seconds in. */
  at(t: number): [number, number, number] {
    if (this.end === Infinity) this.work();
    t = Math.min(Math.max(0, t), this.end);
    const last = this.ps.length - 1, v = this.vs[last];
    if (t >= this.settled) {
      // the straight line (an end reached in the curve is where it stands)
      if (!v) return [this.ps[last], 0, 0];
      return t >= this.end ? [v > 0 ? this.hi : this.lo, 0, 0] : [this.ps[last] + v * (t - this.settled), v, 0];
    }
    const x = t * CRUISE_HZ, i = Math.min(Math.floor(x), last - 1), f = x - i;
    const mix = (a: number[]) => a[i] + (a[i + 1] - a[i]) * f;
    return [mix(this.ps), mix(this.vs), mix(this.as)];
  }

  /** Keyframe times for the whole cruise: dense along the curve, then its end. */
  times(): number[] {
    if (this.end === Infinity) this.work();
    const curve = keyTimes(Math.min(this.settled, this.end));
    return this.end > this.settled ? [...curve, this.end] : curve;
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
  /** Called every frame the position changes; `glided` while the compositor draws the
   *  move (else the host puts the sheet there, ending any glide). */
  frame(p: number, v: number, glided?: boolean): void;
  /** A move from `t0` (a frame's time), position `at(t)` seconds in, as keyframes at `times`. */
  glide(at: (t: number) => number, times: number[], t0: number): void;
  /** Called once when the sheet comes to rest on a boundary. */
  rest(k: number): void;
}

export class Motion {
  p = 0; v = 0; a = 0;
  mode: Mode = 'rest';
  private traj: Quintic | null = null;
  private cruising: Cruise | null = null;
  /** When the move began (the document timeline's time). */
  private t0 = 0;
  private raf = 0;
  private cruiseDir = 0;
  private samples: [number, number][] = [];   // direct: (time, position)

  constructor(private host: MotionHost) {}

  get moving() { return this.mode !== 'rest'; }
  /** Where the sheet will come to rest if nothing else happens. */
  get target() { return this.mode === 'traj' && this.traj ? this.traj.p1 : this.mode === 'rest' ? this.p : NaN; }

  /** Mid-move, the state at this frame's time: the compositor draws the move between the
   *  loop's frames, so a new move starts from where it is, not from the last frame seen. */
  private sync() {
    const t = Math.max(0, (frameNow() - this.t0) / 1000);
    if (this.mode === 'traj' && this.traj) [this.p, this.v, this.a] = this.traj.at(t);
    else if (this.mode === 'cruise' && this.cruising) [this.p, this.v, this.a] = this.cruising.at(t);
  }

  private clamp(x: number) { return Math.max(this.host.min(), Math.min(this.host.max(), x)); }

  /** Puts the sheet at k at once. */
  jump(k: number) {
    this.stopLoop();
    this.p = this.clamp(k); this.v = 0; this.a = 0; this.mode = 'rest'; this.traj = null; this.cruising = null;
    this.host.frame(this.p, 0);
  }

  /** Moves to `target` from the current state over `T` seconds. */
  toward(target: number, T?: number, kick = false) {
    this.sync();
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
    const traj = this.traj = new Quintic(this.p, v0, this.mode === 'rest' ? 0 : this.a, target, T);
    this.t0 = frameNow();
    this.mode = 'traj';
    this.cruising = null;
    this.host.glide(t => traj.at(t)[0], keyTimes(T), this.t0);
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

  /** A held key or press: ease into a cruise, from wherever the sheet is going. */
  cruise(d: number) {
    if (this.host.reduced()) return;
    this.sync();
    this.cruiseDir = d;
    this.cruising = new Cruise(this.p, this.v, d, Math.sqrt(this.host.spread()), this.host.min(), this.host.max());
    this.t0 = frameNow();
    this.mode = 'cruise';
    this.traj = null;
    // the whole of it, at once: nothing is handed over while it runs
    const c = this.cruising;
    this.host.glide(t => c.at(t)[0], c.times(), this.t0);
    this.loop();
  }

  /** End of a cruise: decelerate onto the next boundary ahead. */
  release() {
    if (this.mode !== 'cruise') return;
    this.sync();
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
    this.sync();
    this.stopLoop();
    this.traj = null;
    this.cruising = null;
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
    const tick = (now: number) => {
      this.raf = 0;
      if (this.mode === 'traj' && this.traj) {
        const t = Math.max(0, (now - this.t0) / 1000);
        [this.p, this.v, this.a] = this.traj.at(t);
        this.host.frame(this.p, this.v, true);
        if (t >= this.traj.T) {
          const k = this.traj.p1;
          this.mode = 'rest'; this.traj = null; this.v = 0; this.a = 0; this.p = k;
          this.host.rest(k);
          return;
        }
      } else if (this.mode === 'cruise' && this.cruising) {
        const c = this.cruising, t = Math.max(0, (now - this.t0) / 1000);
        [this.p, this.v, this.a] = c.at(t);
        if (t >= c.end) {
          // an end of the book: settle on its column
          this.mode = 'rest'; this.cruising = null; this.v = 0; this.a = 0;
          this.host.frame(this.p, 0);
          this.toward(Math.round(this.p), 0.3);
          return;
        }
        this.host.frame(this.p, this.v, true);
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
