/**
 * Walkthrough interaction overlay (spec 20, PAY-78; owner ruling R3: the video
 * must show the interaction — a cursor, a highlight on the target, a click).
 *
 * Headless recordings draw no mouse, so the walkthrough draws its own: before a
 * UI action the cursor glides to the target, a pink ring holds on it, and a
 * caption names the action ("Click · Save"); a click ripples where it lands,
 * and a field being typed into keeps a dashed ring.
 *
 * The TEST HARNESS injects it, never the app, and only in walkthrough mode
 * (tests/support/walkthrough.ts). It lives in a shadow root on <html>, outside
 * the app's root and every dialog: fixed, pointer-events:none, no layout, top
 * z-index. It covers nothing for hit-testing, and the screen-change hold never
 * sees it (a shadow root is invisible to document.querySelectorAll).
 *
 * Ported from ta-verify (soult-io/teacher-assistant PR 72), where 0/58 gating
 * stills contained overlay pixels.
 */

import type { Locator } from "@playwright/test";

/** How long the cursor takes to glide to the next target (ms). */
const OVERLAY_GLIDE_MS = 450;
/** How long the target stays ringed before the action starts (ms). */
export const OVERLAY_HIGHLIGHT_MS = 500;
/** Bound on drawing it — the target is already attached (ms). */
const OVERLAY_DRAW_TIMEOUT_MS = 2000;

/** A point on the screen, in CSS pixels from the viewport's top-left. */
export interface Point {
  x: number;
  y: number;
}

/** How the overlay shows one action. */
interface ActionOverlay {
  /** "click": ring until the click lands. "focus": ring while the field has focus. */
  kind: "click" | "focus" | "other";
  verb: string | ((args: readonly unknown[]) => string);
}

/** The Locator actions the walkthrough paces, and how each is shown. */
const ACTION_OVERLAY: Record<string, ActionOverlay> = {
  check: { kind: "click", verb: "Check" },
  clear: { kind: "focus", verb: "Type" },
  click: { kind: "click", verb: "Click" },
  dblclick: { kind: "click", verb: "Double-click" },
  fill: { kind: "focus", verb: "Type" },
  press: {
    kind: "focus",
    verb: (args) => (typeof args[0] === "string" ? `Press ${args[0]}` : "Press"),
  },
  pressSequentially: { kind: "focus", verb: "Type" },
  selectOption: { kind: "other", verb: "Select" },
  setChecked: {
    kind: "click",
    verb: (args) => (args[0] === false ? "Uncheck" : "Check"),
  },
  tap: { kind: "click", verb: "Click" },
  uncheck: { kind: "click", verb: "Uncheck" },
};
const FALLBACK_OVERLAY: ActionOverlay = { kind: "other", verb: "Hover" };

/** What the overlay draws for one action. */
interface PointRequest {
  kind: ActionOverlay["kind"];
  verb: string;
  /** The cursor's last position, for a document that has not drawn it yet. */
  from: Point | null;
  glideMs: number;
  highlightMs: number;
}

interface PointResult extends Point {
  waitMs: number;
}

/**
 * In the page. Called with no arguments (the per-document init script) it only
 * installs; with a target it installs if needed and points at the target.
 * Self-contained on purpose: Playwright serialises it into the page.
 */
export function overlayRuntime(target?: Element, req?: PointRequest): PointResult | null {
  interface Overlay {
    host: HTMLElement;
    cursor: HTMLElement;
    ring: HTMLElement;
    caption: HTMLElement;
    root: ShadowRoot;
    target: Element | null;
    at: { x: number; y: number } | null;
    releaseTimer: number | undefined;
  }
  const w = window as unknown as { __walkthroughOverlay?: Overlay };
  const RIPPLE_MS = 550;
  /** A ring no click or lost focus lets go of is hidden after this (ms). */
  const OTHER_RING_MS = 1200;

  const hideRing = (o: Overlay): void => {
    o.ring.style.opacity = "0";
    o.caption.style.opacity = "0";
    delete o.host.dataset.ringShownAt;
    delete o.host.dataset.ringKind;
  };

  const install = (): Overlay => {
    const existing = w.__walkthroughOverlay;
    if (existing) {
      if (!existing.host.isConnected) document.documentElement?.append(existing.host);
      return existing;
    }
    const host = document.createElement("walkthrough-overlay");
    host.style.cssText =
      "position:fixed;inset:0;display:block;pointer-events:none;z-index:2147483647;contain:strict;margin:0;padding:0;border:0;background:none";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      * { box-sizing: border-box; pointer-events: none; }
      [part~="cursor"] { position: absolute; left: 0; top: 0; width: 26px; height: 30px;
        opacity: 0; will-change: transform; filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
      [part~="ring"] { position: absolute; border-radius: 10px; opacity: 0;
        border: 3px solid #ec4899; box-shadow: 0 0 0 4px rgba(236,72,153,.3); }
      :host([data-ring-kind="focus"]) [part~="ring"] { border-style: dashed; }
      [part~="caption"] { position: absolute; left: 0; top: 0; max-width: calc(100vw - 16px);
        padding: 4px 10px; border-radius: 999px; background: rgba(17,24,39,.9); color: #fff;
        font: 600 13px/18px system-ui, sans-serif; white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis; opacity: 0; }
      [part~="ripple"] { position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px;
        border-radius: 50%; border: 3px solid #ec4899; background: rgba(236,72,153,.25);
        animation: ripple ${RIPPLE_MS}ms ease-out forwards; }
      @keyframes ripple { from { transform: scale(.2); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }
    </style>
    <div part="ring"></div><div part="caption"></div>
    <svg part="cursor" viewBox="0 0 26 30" aria-hidden="true">
      <path d="M1.5 1.5 L1.5 24 L7.5 18.5 L11.5 27.5 L15.5 25.8 L11.6 17 L19.5 17 Z"
        fill="#111827" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
    </svg>`;
    const part = (name: string): HTMLElement => {
      const el = root.querySelector<HTMLElement>(`[part~="${name}"]`);
      if (!el) throw new Error(`overlay part ${name} missing`);
      return el;
    };
    const o: Overlay = {
      host,
      root,
      cursor: part("cursor"),
      ring: part("ring"),
      caption: part("caption"),
      target: null,
      at: null,
      releaseTimer: undefined,
    };
    w.__walkthroughOverlay = o;
    window.addEventListener(
      "pointerdown",
      (e) => {
        const ripple = document.createElement("div");
        ripple.setAttribute("part", "ripple");
        ripple.style.left = `${e.clientX}px`;
        ripple.style.top = `${e.clientY}px`;
        o.root.append(ripple);
        setTimeout(() => ripple.remove(), RIPPLE_MS + 50);
      },
      { capture: true, passive: true },
    );
    // The ring lets go at the click, before the app handles it, so a screen the
    // click opens is never painted with the old target's ring on it.
    window.addEventListener(
      "click",
      () => {
        if (o.host.dataset.ringKind !== "focus") hideRing(o);
      },
      { capture: true, passive: true },
    );
    document.addEventListener(
      "focusout",
      (e) => {
        if (o.host.dataset.ringKind === "focus" && e.target === o.target) hideRing(o);
      },
      true,
    );
    const mount = (): void => {
      document.documentElement?.append(host);
    };
    if (document.documentElement) mount();
    else document.addEventListener("readystatechange", mount, { once: true });
    return o;
  };

  const o = install();
  if (!target || !req) return null;
  if (!target.checkVisibility()) return null;

  // Point where the action will land: on screen, at the target's centre. A
  // target below the fold is scrolled into view first, as the action would.
  let box = target.getBoundingClientRect();
  const offScreen =
    box.top < 0 || box.bottom > innerHeight || box.left < 0 || box.right > innerWidth;
  if (offScreen) {
    target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    box = target.getBoundingClientRect();
  }
  const clamp = (v: number, max: number): number => Math.min(Math.max(v, 0), max);
  const to = {
    x: clamp(box.left + box.width / 2, innerWidth - 1),
    y: clamp(box.top + box.height / 2, innerHeight - 1),
  };

  // A field already ringed and focused (clear() then typing) is not pointed at twice.
  if (
    req.kind === "focus" &&
    o.target === target &&
    o.host.dataset.ringKind === "focus" &&
    document.activeElement === target
  ) {
    return { ...to, waitMs: 0 };
  }

  clearTimeout(o.releaseTimer);
  hideRing(o);
  o.target = target;

  const from = o.at ?? req.from ?? { x: innerWidth / 2, y: innerHeight * 0.6 };
  const glideMs = Math.hypot(to.x - from.x, to.y - from.y) < 4 ? 0 : req.glideMs;
  o.cursor.style.transition = "none";
  o.cursor.style.transform = `translate(${from.x}px, ${from.y}px)`;
  o.cursor.style.opacity = "1";
  void o.cursor.getBoundingClientRect();
  o.cursor.style.transition = `transform ${glideMs}ms cubic-bezier(.4,0,.2,1)`;
  o.cursor.style.transform = `translate(${to.x}px, ${to.y}px)`;
  o.at = to;

  // The caption names the action by the target's accessible name.
  const clean = (text: string | null | undefined): string =>
    (text ?? "").replace(/\s+/g, " ").trim();
  const el = target as HTMLElement & { labels?: NodeListOf<HTMLLabelElement> | null };
  const labelledBy = (target.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent)
    .join(" ");
  const isField = ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName);
  const name = [
    target.getAttribute("aria-label"),
    labelledBy,
    Array.from(el.labels ?? [], (label) => label.textContent).join(" "),
    target.getAttribute("placeholder"),
    target.getAttribute("title"),
    isField ? "" : el.innerText,
    target.getAttribute("alt"),
  ]
    .map(clean)
    .find((text) => text.length > 0);
  const short = name && name.length > 40 ? `${name.slice(0, 39)}…` : name;

  setTimeout(() => {
    if (o.target !== target) return;
    const pad = 4;
    const now = target.isConnected ? target.getBoundingClientRect() : box;
    Object.assign(o.ring.style, {
      left: `${now.left - pad}px`,
      top: `${now.top - pad}px`,
      width: `${now.width + pad * 2}px`,
      height: `${now.height + pad * 2}px`,
      opacity: "1",
    });
    o.caption.textContent = short ? `${req.verb} · ${short}` : req.verb;
    const cap = o.caption.getBoundingClientRect();
    const below = now.bottom + pad + 8;
    const top = below + cap.height <= innerHeight - 8 ? below : now.top - pad - 8 - cap.height;
    const left = Math.min(Math.max(to.x - cap.width / 2, 8), innerWidth - cap.width - 8);
    o.caption.style.transform = `translate(${left}px, ${Math.max(8, top)}px)`;
    o.caption.style.opacity = "1";
    o.host.dataset.ringKind = req.kind;
    o.host.dataset.ringShownAt = String(performance.now());
    // A backstop: a ring no click lets go of (a select, a swallowed click)
    // hides on its own. A typed-into field keeps its ring while focused.
    if (req.kind !== "focus") {
      o.releaseTimer = window.setTimeout(() => hideRing(o), req.highlightMs + OTHER_RING_MS);
    }
  }, glideMs);

  return { ...to, waitMs: glideMs + req.highlightMs };
}

/** The init-script source that installs the overlay in every new document. */
export const OVERLAY_INIT_SCRIPT = `if (window === window.top) (${overlayRuntime.toString()})()`;

/**
 * Show the viewer what the next action touches: glide, ring, caption, and wait
 * out the glide and the highlight. Best effort: the overlay never fails or
 * replaces the action. Returns where the cursor now is (null: not drawn).
 */
export async function pointAt(
  target: Locator,
  action: string,
  args: readonly unknown[],
  from: Point | null,
): Promise<Point | null> {
  const overlay = ACTION_OVERLAY[action] ?? FALLBACK_OVERLAY;
  const request: PointRequest = {
    kind: overlay.kind,
    verb: typeof overlay.verb === "function" ? overlay.verb(args) : overlay.verb,
    from,
    glideMs: OVERLAY_GLIDE_MS,
    highlightMs: OVERLAY_HIGHLIGHT_MS,
  };
  const result = await target
    .evaluate(overlayRuntime, request, { timeout: OVERLAY_DRAW_TIMEOUT_MS })
    .catch(() => null);
  if (!result) return null;
  if (result.waitMs > 0) {
    await target
      .page()
      .waitForTimeout(result.waitMs)
      .catch(() => undefined);
  }
  return { x: result.x, y: result.y };
}
