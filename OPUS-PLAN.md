# Verify & optimize btcticker

## Context

btcticker is a no-build-step kiosk web app (plain `index.html` + `style.css` + `app.js`, plus a
standalone `db.html` dashboard), wrapped as an Android app via Capacitor and deployed to a Linux
kiosk by `install.sh`. It works today. Nothing here is a rewrite — it is a pass to fix real defects,
cut real waste, and stop three sources of drift that will keep costing time.

An audit found issues in four areas, all of which the user asked to cover, with structural refactors
in scope and EMA golden-vector tests requested.

**Two corrections to what I reported before planning** — both change the rationale, not the fix:

1. The WebSocket "old socket hijacks the new connection" race is **not reachable**. Per WHATWG,
   `close()` while `readyState === CONNECTING` fails the connection and `open` never fires. The
   genuinely reachable bug is in the same handler: `ws.onopen` is `async` and `await`s
   `exchange.init()`, so switching exchanges mid-await resumes with a stale closure and writes the
   **old** exchange's 24h change onto the new one. `refreshRestChange` has the same shape with no
   guard at all. Same fix (generation guards), sharper reason.
2. The commit-spam fix is worth **~5/day → ~3.3/day**, not "73% eliminated". 275 of 377 commits
   (73%) are `chore: update` — that part is measured and true — but ~46% of F&G runs carry a real
   value change and should still commit. What goes to zero is commits carrying *no information*.

## Verified facts this plan rests on

- `install.sh:10` → `FILE_URL="file://$DIR/index.html"`. The kiosk runs from `file://`.
  **ES modules are CORS-blocked from `file://` — this rules out `type="module"` entirely.**
- `style.css:120` `.badge{display:inline-flex}` is an author rule; there is no `[hidden]` rule in
  the file. Author `display` outranks the UA's `[hidden]{display:none}`.
- `fetch_cdc.py:70` / `fetch_fng.py:59` stamp wall-clock `generated` into the payload, so the
  workflows' `git diff --cached --quiet ||` guard can never skip.
- `package.json:3` = 1.11.0, `android/app/build.gradle:19` = "1.11.1", tag = v1.11.1,
  `README.md:26` links v1.10.0.
- EMA exists 3× : `fetch_cdc.py:24`, `app.js:485`,
  `android/app/src/main/java/com/btcticker/app/KrakenCdc.java`. `CTD.MD` plans a 4th (ESP32).

---

## Phase 1 — Correctness (highest user-visible value)

**1.1 `[hidden]` is ignored — empty pills on screen.** `style.css`, in the reset block near line 26:
```css
[hidden] { display: none !important; }
```
Universal, not `.badge[hidden]` — matches normalize.css and immunizes future elements. Verified no
conflict: `#loading`, `#fees`, `#cdc-strip` hide via classes, not the attribute. Fix the now-false
comment at `style.css:110-112`. *This is the one a user notices*: toggling off "F&G Index" currently
leaves a large empty pill showing just its `::before` label.

**1.2 Generation guards on async continuations.** `app.js:328-337` and `365-371`. Add
`if (STATE.ws !== ws) return;` after the `await` in `onopen` (mirroring the guard `onclose` already
has at :342), wrap `exchange.init()` in try/catch, and move `initCDC()` **outside** that try so an
`init()` failure no longer skips it. Same key-capture guard in `refreshRestChange`, plus
`.catch(()=>{})` at the `setInterval` call site. Also null `onopen`/`onerror` in the teardown at
`:320` — defensive, makes the invariant obvious.

**1.3 `parse()` can throw out of `onmessage`.** `app.js:348` — every `parse` does a bare
`JSON.parse`. Wrap in try/catch and `return` on failure. A non-JSON frame (OKX `pong`, proxy HTML
error body) currently throws once per frame.

**1.4 Corrupt history strands the boot.** `loadHistory` (~`app.js:164`) validates only `e.ts`.
Add `Number.isFinite(e.price)`, and wrap the top-level boot render (`app.js:308-316`) in try/catch.
Today a single bad entry throws at module top level *before* `connect()` runs — a permanently dead
kiosk needing a manual localStorage wipe. No in-repo producer exists; this is hardening.

**1.5 Small ones.** `fngColor` lower clamp (`app.js:274`, returns `undefined` below 0); replace the
never-matching `style.color` hex-vs-`rgb()` readback guard (`app.js:233`) with a cached last-written
value.

**1.6 Menu toggles that silently lie.** At short heights the container queries hide `#cdc-strip`
(≤200px) and `#fees` (≤120px); `#fees.hidden` (1,1,0) beats the CQ rule (1,0,0) so unchecking works
but re-checking does nothing. **Keep the CQ authoritative** — it is a deliberate fold and letting a
checkbox crush the price is worse — and make the menu tell the truth: in `openMenu()`, read
`getComputedStyle(el).display === 'none'` and set `input.disabled` + a tooltip. Reading computed
style keeps `style.css` the single source of the thresholds so they can't drift.

## Phase 2 — CDC strip rendering (`app.js:535-576`, one coherent change)

Replace the debounced `window.resize` listener with a **`ResizeObserver` on `#cdc-strip`**, caching
the height in a module variable that `renderCDC` reads instead of `clientHeight`. This fixes three
things at once: the sliver bug (height changes that aren't window resizes left `clientHeight` at 0 →
`MAX_H=2` → 30 one-pixel bars), the forced synchronous layout in `applyVisibility`, and the
un-hide repaint hack at `app.js:428-430`, which gets deleted. Add a signature check
(`MAX_H` + per-block bull/today/diff) so identical rebuilds return early — that makes the hourly
`initCDC` interval nearly free rather than a 60-element `innerHTML` rebuild producing identical
output. **Keep** the interval; it is the only path by which a data-file refresh could ever land.

## Phase 3 — Idle cost

**3.1 Clock: 1 Hz → minute-aligned.** `app.js:659-683` does **two** `Intl.formatToParts` calls per
second (`tickClock` + `updateNightMode` each call `bangkokTimeParts`) ≈ 172,800/day for a value that
changes 1,440×/day. Pass the parts into `updateNightMode` (default arg keeps `applyVisibility`'s
parameterless call working), diff the text, and self-reschedule on
`60_000 - (Date.now() % 60_000) + 50`. Re-derived each tick, so it self-corrects after suspend.

**3.2 Don't fetch fees into a hidden tab.** `app.js:648` — gate on `!document.hidden`.

**3.3 Make `visibilitychange` catch up, not just add work.** `app.js:481` — re-tick the clock and
only refetch fees if the cache aged out. **Do not** pause the WebSocket or `snapshotHistory`; being
live is the kiosk's entire job.

**3.4 Load path.** `index.html`: `<link rel="preload" as="font" crossorigin>` for the woff2 *before*
the stylesheet link (the `@font-face` isn't discoverable until `style.css` parses — a serial round
trip); `defer` on all three scripts (execution order is preserved, so `window.LOCAL_*` still lands
before `app.js`); `preconnect` for `mempool.space` and `dns-prefetch` (not preconnect — Chrome
doesn't pool WS with the HTTP pool) for `stream.binance.com`.

**Keep `font-display: block`.** Swapping to the fallback renders the price ~40-50% wider inside
`#price`'s `overflow:hidden` with `nowrap` — a clipped wrong-looking price then a reflow is worse on
a wall display than a brief blank. The preload removes the part that is unambiguously a bug.

> *Later (2026-08-14):* still the rule, and still for this reason, though the margin narrowed when the
> face changed from Bebas Neue to JetBrains Mono — a fallback mono is closer in width than a fallback
> for a condensed face was. Both shipped weights carry `font-display: block`.

## Phase 4 — `shared.js` (the structural refactor)

**Decision: one new classic script, `shared.js`, attaching a `window.BTC` namespace. Not ES modules**
— they would blank both pages on the `file://` kiosk that `install.sh` builds, a failure invisible in
any `python3 -m http.server` dev loop. Its header comment must say so, and must say it may never be
given `defer`/`async` (db.html's inline script is parser-blocking and would run first).

Shared surface: `BTC.fetchJSON`, `BTC.keys` (frozen storage keys), `BTC.history.load/save`,
`BTC.fng.COLORS/colorFor/isStale`, `BTC.fees.URL/TTL_MS/STORAGE_KEY/deriveTiers/fmtFeeRate/readCache/refresh`,
`BTC.cdc.scale`, `BTC.DAY_MS`. `refresh()` returns rather than renders — the two pages have
deliberately different fee-error UX. `BTC.cdc.scale` shares the *maths* only; each page keeps its own
markup. Removes ~60 lines from `app.js` and ~55 from `db.html`.

Highest-value item in this phase: `btcticker_v2_fees` is a real **cross-page contract** — a drift in
the key or stored shape silently breaks instant-paint on the other page with no error anywhere.

**Deliberately NOT shared — CSS stays as it is.** The two pages are two intentional design systems
(Bebas Neue — JetBrains Mono as of 2026-08-14 — vs `system-ui`; the same variable names hold
different values). A shared stylesheet would
need per-page override blocks — more code than the ~6 genuinely identical lines it removes — and
would cost db.html its single-file portability. The CDC gap/radius/opacity differences are per-page
tuning (155px responsive strip vs fixed 200px panel), not drift. Add a `keep in sync` comment above
the F&G gradient at `db.html:348` instead of coupling CSS to JS load order.

Also not shared: `calcEMA` and `fetchCDCBlocks` (ticker-only), db.html's date/format helpers (all
single-consumer — a shared module that collects those becomes a junk drawer). Note `db.html:682`'s
`48` is the **CDC-file** threshold, unrelated to F&G staleness despite the matching number — leave it
and comment it.

**Delete** `calcEMA` (`app.js:486`) and the unreachable Kraken tier in `fetchCDCBlocks` — tier 2
always hits because `data/cdc.js` is committed and loaded, so tier 3 can never run. ~45 dead lines.

## Phase 5 — CI, versions, tests

**5.1 Commit spam — highest value here.** Put the decision in the Python scripts, not the YAML:
add `read_existing()` + `should_write()` gating on semantic fields (`blocks` / `value`+`classification`)
**or** a 20h heartbeat, plus a `--force` flag. Then the existing workflow guard finally works with
**zero YAML change**. Keep `generated` in both files — `db.html:678` anchors its 30 day labels to
`cdc.generated`; dropping it would label stale data "today". The heartbeat is required: without it a
flat market freezes the stamp and trips `app.js`'s 48h stale flag on a healthy pipeline.
Also add retry-with-backoff to both fetches, and fix `fetch_fng.py`'s `urllib.error` import
(line 39 uses it; line 17 imports only `urllib.request`).

**5.2 Workflow race.** Add the **same** `concurrency: {group: data-commit, cancel-in-progress: false}`
to both workflows (same string = serialized against each other; queue, don't cancel — a cancelled run
drops a data point), and a rebase-and-retry push loop with `set -euo pipefail`. Keep the SHA pins and
`contents: write`. No issue-opening notifier — it needs `issues: write` on the workflow that pushes to
`main`, and GitHub already emails scheduled-workflow failures.

**5.3 Tests — EMA golden vectors, stdlib `unittest`, no new dependencies.**
`tests/fixtures/ema_golden.json` is the frozen source of truth (never regenerate from an
implementation — that makes it a tautology). Three hand-computable exact cases plus realistic 60-close
EMA12/EMA26 and a 30-block case with a bull→bear crossover. Cover `fetch_cdc.py:calc_ema` and
(optionally) `KrakenCdc.java` — **not** `app.js:calcEMA`, which Phase 4 deletes. Add
`tests/test_freshness.py` for `should_write` (the only thing pinning 5.1's behaviour change) and
`tests/test_data_files.py` as a smoke test on the committed artefacts.
`"test": "python3 -m unittest discover -s tests -t . -v"`.
The fixture records a real divergence to preserve, not paper over: Python rounds `diff` to 2dp
(`fetch_cdc.py:66`), Java does not.

**5.4 Versions.** Reconcile `package.json` / `package-lock.json` (×2 sites) / `build.gradle`. Note
v1.11.1 was tagged as a patch but contains 21 commits including the fee bar, clock and Night Mode —
release the topbar work as **v1.12.0 / versionCode 23** rather than retro-fixing a published tag.
Add a `versions` CI job that fails any PR where the three disagree, and point `README.md:26` at
`/releases/latest` so that link can never go stale again.

**5.5 Build scripts.** Derive both outputs from one file list so `dist/` (Cloudflare) and `www/`
(Capacitor) can't diverge — and add the missing `rm -rf`, without which deleted assets linger:
```json
"build:www":     "rm -rf www && mkdir -p www && cp index.html db.html style.css shared.js app.js www/ && cp -r assets data www/",
"build":         "npm run build:www && rm -rf dist && cp -r www dist",
"sync:android":  "npm run build:www && npx cap sync android"
```
This is also what stops the next `shared.js`-shaped file from being forgotten on the Android path.

## Phase 6 — README

Redraw the Display diagram (`README.md:74-91`) for the current top-bar layout, document the
**Bangkok clock** and **Night Mode** (both entirely undocumented), correct "four toggles" → six
(`:68`) and the `btcticker_v1_visibility` key list (`:371`), fix the broken Android build block
(`:262-266` — `www/` is gitignored and no step creates it) to use `npm run sync:android`, add a
**Deployment** section (Cloudflare Pages is documented nowhere despite `build` existing solely for
it), and add v1.11.0 / v1.11.1 / v1.12.0 changelog entries. Add a responsive-folding table for the
five container breakpoints. Update `CTD.MD`'s two `app.js` references, which Phase 4 invalidates.

---

## Verification

Per phase, in a browser at `http://localhost:8000` **and** at `file://` (the `file://` run is the one
that matters and the easy one to skip — a blank page there means someone added `defer`/`type=module`
to `shared.js`):

- **1.1** Uncheck "F&G Index" → pill vanishes entirely. `localStorage.clear()` + reload → no label
  stubs during the loading dots.
- **1.2** Stub `EXCHANGES.bitstamp.init` to resolve `{change:999}` after 3s, switch to Binance within
  3s → the 24H badge must **not** flip to +999%.
- **1.3** `STATE.ws.dispatchEvent(new MessageEvent('message',{data:'pong'}))` → silence, price keeps
  updating.
- **1.4** Seed `btcticker_v1_history` with `[{ts:Date.now(),price:null}]`, reload → loading dots then
  live price, not a blank dead page.
- **2** `console.count` on the `innerHTML` write: one call on load; zero on horizontal-only resize;
  one at the new height when crossing the 200px boundary, bars proportional not slivers.
- **3** DevTools Network filtered to `mempool.space`: background the tab 5 min → 0 requests, then
  exactly 1 on return. `console.count` on `bangkokTimeParts` over 60s: ~120 before, ~1 after.
- **4** `node --check shared.js app.js`; then the cross-page contracts: load ticker → open dashboard,
  fee tiers paint instantly; seed only the legacy `btcticker_history` key → dashboard still
  populates; set `fng.value` to 10/30/50/70/90 → ticker badge colour matches the dashboard gauge at
  every band; set `update_time` 49h back → both flag stale, and confirm the CDC notice fires
  *independently* (proves `db.html:682` stayed decoupled).
- **5** `python3 fetch_cdc.py` twice → second prints "Unchanged", `git status --short data/` empty;
  `--force` writes. `npm test` green in <2s; then break `k = 2/(period+1)` → `2/period` and confirm
  all EMA cases fail with named subtests; revert.
- **6** `grep -n "v1.10.0\|four toggles\|stacked above" README.md` returns only changelog hits.

Full-app check after each phase via the local server and the browser tools, at 1200×800 and at a
short/narrow viewport, confirming price, fee bar, badges, CDC strip and clock all still render.

## Out of scope (deliberate)

Accessibility and contrast — the audit found real problems (`--faint2` at **1.49:1**, the clock at
**2.00:1**, and db.html's 11 tooltips whose entire content is invisible to screen readers because
`aria-label` on `role="img"` suppresses it). Not in the four areas selected; worth its own pass.

Also left alone: both cron schedules (the 6-hourly F&G cadence was a considered fix); the Capacitor
scaffolding tests (generated, passing, `cap sync` may recreate them); font subsetting (~11KB saved
once per kiosk lifetime); `db.html`'s inline CSS; the two oversized JPEGs in git history.

> *Later (2026-08-14):* font subsetting did happen, as a side effect of retypesetting the ticker in
> JetBrains Mono — both shipped weights are subset to printable ASCII + `…` + `—`. It did not save
> anything: two subset weights total 35.0 KB against the 13.7 KB unsubset Bebas file. The size note
> above was never the reason to do it.

## Commit strategy

One commit per phase, each independently revertible; Phase 1 splittable per fix. Phases 1-3 touch
only `app.js`/`style.css`/`index.html` and have no interdependencies. Phase 4 must land after
Phase 2 (both touch `renderCDC`). Phase 5.1+5.3 land together. Phase 6 last, since it documents the
result. Preserve the codebase's heavy explanatory-comment style throughout and update every comment
a change makes wrong — three are already known: `style.css:110-112`, `app.js:428-430`, `app.js:569-571`.
