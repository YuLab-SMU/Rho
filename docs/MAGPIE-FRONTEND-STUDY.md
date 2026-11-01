# magpie's frontend, studied

A deep reading of [yetone/magpie](https://github.com/yetone/magpie) for the parts Rho
can learn from. This is a study of **another project**, not a specification for Rho: it
describes what magpie does and why, then lists candidate actions on screens Rho already
has. It sets no layout, colour or visual value for anything not yet built.

Baseline: commit `eb6d1d8` (2026-10-28), shallow clone, read-only. Paths below are
relative to that clone; the Go and JS files are cited as `file:line`. Reproduce with
`git clone --depth 1 https://github.com/yetone/magpie` and read the same lines.

## What it is, in numbers

| Part | Size | Note |
| --- | --- | --- |
| `internal/gui/assets/app.js` | 24,504 lines / 1.31 MB | the whole app shell, 732 functions, no framework |
| `internal/gui/assets/app.css` | 4,389 lines / 361 KB | 71 custom properties, one token layer, 19 grep-able section banners |
| `internal/gui/assets/i18n.js` | 16,401 lines / 1.82 MB | en is the default, key is the English sentence |
| `internal/gui/assets/index.html` | 526 lines | the page skeleton, every view pre-declared |
| `internal/gui/assets/kernel.js` | 274 lines | the plugin kernel |
| `internal/gui/tests/*.test.cjs` | 947 files / 141,899 lines | 943 drive a browser against real assets with a faked `/api`; 4 read source only |
| `docs/subsystems/gui-shell.md` | 702 lines | the shell's design reference |
| `docs/code-standards.md` | 229 lines | of which four bullets are the GUI rules |
| `LESSONS.md` | 861 lines | merged-work review, promoted after 3 sightings |

Two facts frame everything else. First, `app.js:1` states the architecture in one line:
`// magpie — one state object per view, rendered into a list. No framework.` Second, the
test suite is **larger than the code it tests**: 141,899 lines of browser test against
81,670 lines of JS, CSS and HTML. The solidity is not in the framework choice; it is in
that ratio.

Not everything here is exemplary, and the stylesheet is the clearest example. `app.css`
is navigable by 19 banner comments of one greppable shape (`/* ---- name --- */`), with no
BEM and a flat vocabulary (`.row .who .name .sub .val .pill .seg`) plus feature
initialisms (`.rt-` routing, `.sess-` sessions, `.led-` ledger). But its section order is
**accretion, not taxonomy**: the panel's styles land mid-file between sessions and
profiles, the providers page runs for a third of the sheet before the panel reappears, and
`--ease` is defined at line 3600 though used at 253. Correct at runtime, opaque to
reading. A 361 KB hand-maintained sheet wants a planned order; magpie got away without
one because one author and 947 test files held it.

## 1. How a 24.5k-line single file stays workable

- **One contiguous state block.** `app.js:62-94` declares one `let` per view concept
  with its shape in a trailing comment (`let pick = null; // { agent, field, options,
  items, cursor, anchor }`). The comment is the type.
- **Section banners follow the navigation order**, not the alphabet: primitives
  (`14-320`) → agents (`378`) → CLIs and installs (`2308`) → pickers (`4690`) →
  providers (`5878`) → usage (`15276`) → settings and masking (`22024`). 22 banners for
  24.5k lines, so they orient rather than partition.
- **The framework layer sits at the end.** `// ---------- where the reader is ----------`
  (`22779-23207`) is last because it installs global listeners over every `.view` once
  the page exists. Anything the app must not have to remember per view lives there.
- **One element constructor.** `el(tag, cls, text)` (`app.js:221`) is the only way an
  element is made, and it accepts a `Node` for the text so a child element can never be
  stringified into a text node. One place to fix, rather than 732.
- **Handlers sit next to what they serve**: 414 `.onclick =` / `.onpointerdown =`
  assignments, and only ~113 `addEventListener` calls, almost all of them global
  framework listeners. No inline `onclick=` in `index.html`.
- **Full rebuild by default, keyed identity only where churn is unbounded.** Most
  renderers do `list.replaceChildren()` then rebuild. Two exceptions: `replaceKeeping`
  (`app.js:266`), a replace that leaves an already-present node where it is — added
  because a filter redrawn from its own input event took the input out of the page while
  an IME was committing, and the text arrived twice (`1, 2` → `1122`, `#1055`) — and the
  routing request list, which keeps a `Map` of id → element
  (`plugins/routing/client.js:1362`) so a row whose data did not change keeps its DOM
  node — and therefore its hover, focus and `aria-pressed`.
- **Comments carry the ticket and the symptom.** Every non-obvious guard names the real
  failure, e.g. `// a field the guard brings back into view ... else a middle press's
  button, left behind by the autoscroll, pulled the page back to it (#2767)`. In a
  codebase with no type system over the DOM, this is what substitutes for types and for
  tests nobody wrote.

## 2. The boot sequence is a contract

`index.html` loads eleven layers in a fixed order, and each position is defended in a
comment:

1. `<script src="boot.js">` — the server writes `window.bootPrefs` (language, theme,
   colour-blind mode, text size, `web`, gateway mode, which built-in features are off,
   their config). Written into the page, not fetched, so it is there before anything
   runs.
2. `theme.js` — **before the stylesheets**, applies `data-theme`, `--zoom`, and the
   motion/colour-blind markers. Its comment: *"Waiting for app.js at the foot of the
   page let the header paint in the system theme and default size first, then change as
   the page loaded."*
3. `layout.js` — at the top of `<body>`, adds the `mode` / `web` / platform classes.
   *"app.js may still be downloading when the header appears, so its layout must already
   match the browser, desktop window or tray panel."*
4. `compat.js` — polyfills gated on the system WebKit (`Array.at`, `findLast`,
   `structuredClone`, and a hand-written `overscroll-behavior` fallback driven by a
   wheel listener).
5. `i18n.js` → `kernel.js` → each built-in plugin's `i18n.js` and `client.js` →
   `app.js` → `plugins.js` → `pluginpages.js` → `context.js` → plugin `page.js` files →
   `start.js`, which calls `magpie.start()`.

The plugin scripts register **before** `app.js` looks for their pages but run nothing:
`mount` is deferred to `magpie.start()`. One deterministic mount point, after the shell
is set up.

`start.js` also decides the first page: `?view=` wins, else `localStorage["magpie.lastView"]`,
else the first page — "as a Mac app comes back as it was".

## 3. Theme: 71 variables, three selector disciplines

Light is `:root`. Dark is **the same token names, written twice** — once for "follow the
system" (a live media query) and once for an explicit choice:

```css
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#1a1a1e; … } }
:root[data-theme="dark"] { … }
```

So System responds to an OS switch with no JS, and Light/Dark override it. Two further
dimensions override **tokens only**, never layout: `body.panel` (the tray panel is
translucent over `NSVisualEffectView`, so its surfaces need their own alpha) and
`[data-colorblind="1"]` (an Okabe–Ito palette for chart series). Contrast is recorded in
the token itself: `--ctl-fg` is annotated *"darker than --muted, so it reads at 4.5:1 or
better on every surface it sits on"*.

One mechanism worth stealing outright: an in-app "Reduce motion" setting cannot use
`prefers-reduced-motion`, so `holdStill()` walks `document.styleSheets` and rewrites the
`mediaText` of every `reduced-motion: reduce` rule to `all`, keeping the original text to
restore (`theme.js:18-27`).

## 4. Layout: the panel is the default, the window is the enlargement

The inversion is the interesting part. Base rules describe the **440 px tray panel**;
`body.window` adds room (`.row` 40 → 48 px, icons 18 → 22 px, wider view padding), and
only fields tighten the other way under `body.panel`. So the panel needs almost no CSS of
its own — 57 `body.panel` rules against many more `body.window` ones — and "small" is the
case that cannot rot by neglect.

**Density is structural, not tokenised.** Row heights, paddings and grid columns are
literal per mode; the `body.panel` token block carries colour and transparency only. This
is the one place a token layer would have paid off and was not used — worth knowing
before copying the approach wholesale.

**Thresholds live in exactly one place each.** `SIDE_AT = 1024` exists only in JS
(`app.js:23578`) and drives `body.classList.toggle("side-nav")`; the stylesheet never
tests a width for it, only `body.side-nav`. The 440 px panel and the 560 px minimum window
are **native window points** (`internal/gui/textsize.go:14,17`), not breakpoints: the panel
page is always given 440 CSS px, which is why the tray needs no media query at all. Sync by
elimination rather than by duplicated numbers.

**Container queries where the column is what matters**, since every page is capped at
1200 px and centred (`padding: max(16px, calc(50% - 600px))`): ten `@container` blocks key
on the page column, with an explicit `@supports not (container-type: inline-size)` fallback
for Safari 15.

**`--zoom` appears six times in the whole stylesheet, and every use is a division.** Zoom
is the webview's real zoom, so nothing in CSS needs it — except the box-model values for
chrome macOS draws itself in *points* (a 96 pt gutter for the traffic lights, a 50 pt title
bar). At 150 % a hardcoded `96px` would sit ~48 px too far in; `calc(96px / var(--zoom))`
restores the point value. Native code completes the loop by growing the window so the page
keeps ≥560 CSS px at any zoom.


## 5. "Where the reader is" — a 430-line engine against browser quirks

This is the most valuable single thing in the repository. Two rules, stated at
`app.js:22780`:

> A view moves only for the reader: the wheel or trackpad, a touch, the keys that scroll,
> Tab, a drag. Anything else that scrolls it is put back before it is painted.
>
> What the reader clicks stays where it is on the screen while what the click does
> redraws around it.

### 5.1 A permission token, not a convention

```js
function scrollOnPurpose(e, ms = 1000) {
  if (!e?.isTrusted || performance.now() - e.timeStamp > 1000) {
    console.warn("magpie: a scroll not asked for by the reader was refused");
    return false;
  }
  readerScrolls(ms);
  return true;
}
```

`Event.isTrusted` cannot be forged by script; the one-second window stops a stale event
being replayed to justify a scroll. Callers guard the return value. A test button named
`sneak` calls it with no event and must fail to move the page.

### 5.2 Every way a scroll can happen that is *not* the reader's

The engine has to enumerate them, because it puts back everything else. Each entry is a
real platform behaviour, and most name the person who reported it:

| Source | Why the page hears nothing useful | How it is admitted as the reader's |
| --- | --- | --- |
| Wheel/touch scrolled off the main thread | the browser scrolls before the page is told | `puttingBack`/`givesBack`: what was put back is kept ~1s, and an input whose `timeStamp` predates it is given back |
| macOS 13 WebKit under wheel or coast | scrolls it never dispatches — *"every scroll was put back, the page shook and only the bar's drag moved it"* | three put-backs the same way within a second with no redraw under a click's hold are a run; each same-way one after that counts too |
| Trackpad coast after the fingers lift | WebKit plays it with no wheel events | `flings`/`flingUntil`: each scroll extends the reader's window until it rests |
| Scrollbar drag | Chromium and WebView2 give no `pointermove`; the press lands on the view past its content | `barDrag`: press in the scrollbar band opens the window until the lift |
| Middle-button autoscroll (Windows) | a button-1 press, then no event | `panning`: follows it until Chromium ends it (next press, a key, blur, or lift after >15px) |
| Keyboard | Tab and scroll keys | `SCROLL_KEYS` + Tab open a 400ms window |
| Content drag | a drag, not the tremble of a click | `pointermove` with buttons held and >6px travel |

### 5.3 The click hold

A capture-phase click listener (`app.js:23162`) freezes the clicked element's on-screen
position for four seconds. The pieces are individually small and collectively the reason
the app feels native:

- **The chain.** It records not just the clicked node but its siblings and every
  ancestor up to the view, each with its on-screen Y and its child-index path.
- **`MOVES`/`atRest`** (`app.js:23016`): an element is "moving" only if a running
  animation translates/resizes it. A colour fade does not count — otherwise *"the page
  would be held by something further up while the button slid away, and snap back ... so
  the page swung between the two."*
- **`standIn`**: if the whole view was redrawn and the clicked node is gone, the chain
  is re-found by child-index path plus `tagName` and first class (`#458`).
- **Room at the foot** (`.view-room`): when the click leaves the page shorter, an empty
  block at the view's foot lets `scrollTop` legally exceed the content.
- **`contentEnd`**, not `scrollHeight`: `scrollHeight` is never less than the view is
  tall, so under a short list the empty foot counted as content and the hold and the fit
  took turns adding and removing the room, swinging the list (`#355`).
- **"A view at its top stays at its top"**: three separate guards, each with a ticket —
  a 2px slide when the Version row grew (`#2134`), a 138px stage arriving above the bar
  (`#961`), and a chip saved above a held button in the panel.
- **`heldSizes`** re-holds in a `ResizeObserver`, i.e. **before paint**, because a frame
  loop sees a part only as the frame before left it, and the clicked control would
  tremble by as much as it grew in a frame.

### 5.4 Anchoring a named part, and whole pixels

For a page whose content above the reader shrinks and grows on its own (Routing's
groups under a live list), a `scrollTop` number is not enough, so `keepInView` pins a
*named* part: "where the reader is" becomes where that part is on screen. It sets
`overflow-anchor: none` first, so the browser's own anchoring cannot fight it. And
`backToReader` rounds to whole pixels, because WebKit drops the fraction: each 1px
growth slid the pinned part by up to a pixel, *"and two of those by nearly two"*
(`#1804`).

### 5.5 Focus and IME are part of the same rule

- `scrolledFrom` remembers what had focus when the reader scrolled it away, so a field
  focused out of sight is brought back *only* if they did not scroll away from it.
- `keyboardFocus` waits two `requestAnimationFrame`s ("the click guard first puts back
  any native focus scroll; inspect its result") and then reveals the field with
  `block: "nearest"` only if it is actually out of sight.
- Typing never moves the page either: an autosizing textarea is measured at `height:
  auto` with its container's height held, because a page gone short is clamped by the
  browser at every input — including each IME composing step (`#2636`).

### 5.6 Resizes are not clicks

A window made wider or narrower drops the hold (`heldWidth`): *"nothing the click did"*.
What is kept instead is the reader's place, because crossing `SIDE_AT` relayouts the page
and the browser clamps the scroll to each layout it passes through, leaving the page 6px
short of its foot (`#911`).

## 6. No native `<select>`: a placement algorithm instead

`placeMenu` (`app.js:14652`) is 15 lines and handles all four cases: open below; open
above when below is short and above fits; open above with `maxHeight` capped to the room
above when neither fits; otherwise stay below with `maxHeight` capped. `popTop` reserves
the macOS header, where the traffic lights are drawn over the page, so no popover can
land under the window buttons. `placePop` adds horizontal clamping and a
`--ox` origin so the popover grows out of the button's middle.

Inside a menu, a wheel scrolls the menu and does not close it (`#1437`); a menu that
fits neither way takes the larger room and scrolls internally. Escape is a single global
chain rather than a stack: each overlay registers a capture-phase handler that calls
`stopPropagation`, so unwinding runs menu → picker → modal editor → add sheet → panel
without any of them knowing the others exist.

Tooltips are *mostly* still the browser's own. `data-tt` does not paint anything — it
marks an element whose `title` should be translated and have the platform's shortcut
appended. Exactly one custom tooltip exists, on the model picker's rail, and its reason is
the case where the native one fails: the browser drew it under the pointer over the icon
below, so Devin's name appeared on ZCode's icon. That one is `role="tooltip"`, flipped at
the window edge, delayed 450 ms unless the pointer is already "warm", and the rail items
have their `title` emptied so the native tip cannot shadow it.

The placement code is not uniform and the study should say so: `placeMenu` overwrites
`max-height` with the available room even when the stylesheet asks for a 360 px cap, so a
tall window can make a menu taller than its own design intends, while `placePop` only ever
tightens the cap it finds. Two other loose ends worth knowing before copying: most menu
anchors never get `aria-expanded` (the code only updates it if the attribute already
exists), and closing the picker does not restore focus to whatever opened it.

## 7. Motion: a hand-written spring, and where CSS is the right tool

```js
var NAV_SPRING = { response: 0.42, damping: 0.84 }; // seconds, fraction: SwiftUI's terms
const k = (2 * Math.PI / NAV_SPRING.response) ** 2, c = 4 * Math.PI * NAV_SPRING.damping / NAV_SPRING.response;
for (let i = 0, d = dt / 4; i < 4; i++) { navTop.vy += (k * (ty - navTop.y) - c * navTop.vy) * d; navTop.y += navTop.vy * d; … }
```

SwiftUI's `response`/`damping` converted to stiffness and damping coefficients
(`k = ω²`, `c = 2ζω`), two independent springs on vertical position and height, stepped
with semi-implicit Euler substepped 4× per frame, `dt` clamped to 1/30 s so a backgrounded
tab cannot inject an impulse. Settling requires position < 0.25 px **and** velocity
< 4 px/s on both, and it waits while a list above is still folding. A direction change mid
flight needs no special case: the target is re-read from `row.offsetTop` every frame and
integrated against the retained velocity, so a press that changes its mind decelerates
through and comes back — the same mechanism that makes the highlight follow its row while
the list above folds, landing where the row ends up.

The rest of the motion is CSS (26 keyframes) or the Web Animations API, not frame loops:
row unrolling is pure CSS `grid-template-rows` with `visibility` deferred to the end of
the transition, and the sidebar sub-list uses `animate()` with a per-child stagger. The
layout morph is a View Transition, and it deliberately does **not** use the spring
(`--morph-t: .32s` on an ease-in-out) because on a spring "the list is a twelfth of the
way gone in the first frame", which on a dropped frame reads as a jerk then a creep.

Two guards around that morph are worth naming: the page's old snapshot is hidden
(`::view-transition-old(page) { display: none }`) so it slides as one image instead of two
layouts cross-fading "and printing every line twice"; and the whole thing opts out on
**all Linux**, because WebKitGTK with compositing off crashes in a view transition — with a
1.5 s watchdog calling `skipTransition()` so a webview that never finishes cannot strand
the window on the old layout's snapshot.

Cost control matches the restraint: `content-visibility: auto` appears **nowhere** in
`app.css` (only in two plugin sheets, with a JS-measured row height, and never on a row
that can overflow its own box), `will-change` appears four times, and `contain` three.
Nothing in the shell is virtualised; the long lists economise with DOM gaps instead.


## 8. The data face

- One `GET /api/state` per view read; writes answer with the new state. A write's
  response cannot clobber a concurrent setting change: `app.js:4141-4147` keeps the
  newer local `settings` when the read that was in flight started before the change.
- **A delta in both directions.** The client sends `X-Magpie-Had: <tag>`; the server may
  answer `X-Magpie-Same`, in which case the client returns the cached body and reads
  nothing. This is how an 8 MB sessions list is re-read cheaply.
- **Live updates are a long poll, not SSE**: `/api/gateway/trace?after=<seq>&wait=1`,
  gated on `!document.hidden`, and on return from hidden it asks once for everything and
  animates only what is still in flight — the "no flock of magpies" rule that a test
  pins to `2 × in-flight`.
- **Non-JSON bodies are errors, read as errors**: `notJSON()` turns a proxy's HTML page
  into a sentence instead of WebKit's *"did not match the expected pattern"*.
- **Error codes become product sentences in one place**: `no_models`, `all_hidden`,
  `signed_in`, `share`, `needs_admin` and others each map to a translated sentence with
  the next step in it, not to a status code.
- **Assets are versioned by content hash**, so *"a cache never serves an old app.js under
  a new page"*; a file asked for under its current hash is cached forever, anything else
  revalidates by ETag; browser mode gzips with a `-gzip` ETag that still answers 304.

## 9. The plugin kernel, and the rules it enforces at load time

`kernel.js` gives a plugin four things and no more: a page slot, hooks the shell calls,
an error boundary, and a drawing kit.

```js
magpie.plugin(id, (ctx) => {
  ctx.slots.add("page", { key, html, mount, open, relang, title });
  ctx.onConfig(fn); ctx.onDispose(fn);
});
```

- **The error boundary is per page.** A hook that throws is logged as
  `[magpie] <plugin>: <key>.<hook>` and the page becomes a card — "This page stopped
  working", the error's message, Try again — while every other page carries on. Retry
  restores the original markup, translates it, mounts it, and re-runs the hook that
  broke. Further hooks of a broken page do nothing, so nothing half-drawn returns.
- **The kit is the app's own controls**: `el`, `button`, `toggle` (`role="switch"` with
  `aria-checked`), `menu` (explicitly "the app menu, never a native `<select>`"), `row`,
  and `form(schema, values, onChange)` which renders a plugin's settings from the JSON
  Schema the Go side derives from a struct (`pluginrt.SchemaOf`, `x-order`, boolean →
  switch, enum → menu, number kept to `min`/`max` with `aria-invalid`).
- **What is enforced at load, not documented**: the manifest's `API` is a caret range of
  the host API (`"^1"`); a mismatch leaves the plugin `failed` **and undoes what it
  registered**. A page key must match `^[a-z][a-z0-9-]*$` and must not collide with an
  existing view. A settings field the form cannot draw panics at `Register` — in the
  test run, not in front of a user.
- **The dogfooding is the point.** Sessions, Library, Routing, Usage and the Gateway page
  were moved out of core into `plugins/`, so the contract third parties get is the one
  the app itself uses daily. `TestPluginsImportOnlyCore` holds the boundary: nothing
  outside `plugins/` may import a plugin, a plugin may not import another, and they meet
  only through declared services. A failed plugin never stops the others; disposal runs
  newest-first and in reverse.

## 10. i18n where the English sentence is the key

`I18N = { zh: { "Browser access": "浏览器访问", … } }`. A missing key falls back to
English, so a half-translated language still works and the code always reads. Static
text is marked in the HTML: `data-t` for the text, `data-tt` for a tooltip (with
`data-keys` appended, the Mac's shortcut before the `|` and the others' after), `data-tp`
for a placeholder. `translateStatic()` stores the original English in `dataset.en` before
replacing it, so switching languages repeatedly works.

Four guard tests keep it honest, and the second and third are the interesting ones:

1. no key appears twice in one language, in one file (the later would silently win);
2. a plugin's words are said in every language — identical key sets across zh, zh-TW, ja, de;
3. **a plugin's words are its own** — the whole repo is scanned to prove a word a plugin
   owns is not also said by core or another plugin, *because in a plugin's file it would
   be English wherever that plugin is off* (`#3897`);
4. zh-TW may not contain an accidentally Simplified character.

Dates and numbers are formatted in the GUI's language, never the system's alone
(`intlLang()`), and a Go test fails on any formatting call in the assets given no locale.

## 11. The verification machinery

**The harness.** 943 of the 947 test files drive a browser that serves the **real** `internal/gui/assets/` and fake
the backend: one `page.route("**/*", serve)` over a fake origin, with `/boot.js`
synthesised, `/wails/runtime.js` stubbed, each `/api/*` answered by an inline fixture per
test, and everything else read off disk. So the shipped HTML, CSS and JS are the real
thing and only the backend is fiction — there is no backend process, so no user config,
gateway or agent is reachable, and the network is closed by construction rather than by
discipline.

Three details make the harness more than a driver:

- **It drives the app the way a person would.** `tests/reader.cjs` is not a file reader —
  "the reader" is the human. It brings a control into sight with *real wheel input*
  (`reach`, `wheelTo`) precisely because the app undoes unsolicited `scrollIntoView`. A
  test that scrolled programmatically would be fighting the thing under test.
- **Proving a test fails without the fix is part of the test.** 21 distinct
  `MAGPIE_*_ASSETS` variables (`MAGPIE_QUOTA_ASSETS`, `MAGPIE_ROUTING_ASSETS`, …) each
  point one test at an **older** asset directory, and `MAGPIE_APP_JS` swaps a single
  source file. That is the mechanical form of the code standard "a fix comes with a test
  that fails without it".
- **Screenshots are opt-in and named by their parameter tuple**
  (`${engine}-${lang}-${width}-<name>.png`), so a retained `ARTIFACT_DIR` can be read like
  a matrix.

**Static analysis as a test.** The most transferable idea in the repo: rules over the
source itself, no browser needed. Note the split — the browser suite does not run in CI
("CI doesn't run this suite, so it is run locally"), so the **Go tests that read the
assets are the half that actually gates a merge**. That is a deliberate division of labour,
stated in one of them: the browser test checks what Routing shows, while this one "keeps
every other call from slipping back, since CI doesn't run the browser tests".

| Guard | Rule it holds | What it prevents |
| --- | --- | --- |
| `old-webkit.test.cjs` | every script parses at Safari 15.0, judged by Babel AST (lookbehind, `v` flag, static blocks, decorators, `using`, even `new RegExp("(?<=a)b")`); no `:has()`, nesting, `dvh`, or `container`/`subgrid`/`color-mix` without an `@supports` fallback; `index.html` loads `compat.js` first and every script on disk | one unsupported regex made the **whole** `app.js` a syntax error, and macOS 12's WKWebView showed tabs and headings and nothing else (`#220`) |
| `i18n-keys.test.cjs` | duplicate keys; plugin words in all four languages; **a plugin's word is not said anywhere else in the repo**, matched on word boundaries | (see §10, `#3897`) |
| `TestDatesFollowGUILanguage` | one regex forbids `toLocale*String()` and `new Intl.*` with no locale in any asset | a Chinese Mac set to English showing "10月11日 周日" (`#1843`) |
| `TestPurposeAssetMatchesUsage` | a generated asset equals its Go source | a stale `purposes.js` after the enum changed |
| `TestCoreScriptBudget` | the core scripts stay under a byte budget | `app.js` growing without anyone deciding it should |
| `TestBuiltinClientsLoaded` | every registered plugin's client is in `index.html`, in the right load position, under `?v=<hash>` | a plugin shipped but never loaded, or loaded before the kernel |
| `TestBuiltinsTranslated` | every plugin's name, subtitle and schema titles exist in all four language blocks | a plugin whose settings row reads English in German |
| `redact_kinds_test.go`, `settings_keep_test.go` | `app.js`'s `REDACT_KINDS` equals the Go masking categories; the fields `prefsKeep` sends are the ones a save must preserve | the page and the masker disagreeing; one settings save wiping another |
| `dockflap_test.go` | `@keyframes` stops, `transform-origin`, duration and easing in `app.css` equal the Go constants the Dock animates | two implementations of one animation drifting |
| `mainwindow_test.go` | shells out to `node -e` with a stubbed `window._wails` and the real JS constant, in four orders | a resize hook that depends on load order |
| `inner-scroll-contain.test.cjs` | **every** rule in **every** stylesheet that yields a vertically scrolling box must hold the wheel at its ends | a list scrolling inside a page passing the wheel on ("in many places") |
| the three `node:vm` tests | real top-level functions are lifted out of `app.js` and run with faked timers, `api()` and DOM | a retry/ordering bug that only appears under interleaving |

Two of those are worth naming for what they teach beyond their rule. `TestCoreScriptBudget`
turns "don't let the frontend bloat" into a number with a documented raise procedure —
*"put the page's code in its plugin, or raise the budget and say why"* — and its constant
carries the date, author and reason of every raise. And `inner-scroll-contain` is the
answer to "how do you keep a 361 KB stylesheet honest": the test walks the CSSOM, finds
each rule whose own selector produces a vertical scroller, **builds a box from that
selector**, fills it, points at it, checks the rule actually took, and fails naming
`file: selector` if `overscroll-behavior-y` is not `contain`. It also asserts a floor
(**≥30 scrollers found**) so the enumerator cannot quietly find nothing.

**Rules as computed-style assertions.** Design decisions are pinned the same way the code
is: `assert.equal(await page.locator("select").count(), 0, "no native select")`, and a
helper that collects every element whose `getComputedStyle().borderLeftWidth > 1` and
expects an empty list.

**What it openly does not do.** The suite is unusually honest about its own edges, and that
honesty is part of what makes it credible: it "cannot run an old engine, so syntax is
judged by the parse, not by running it"; screenshot comparison against `origin/main`
tolerates a channel difference of 48 and 300 pixels, so it detects *change*, never quality;
and nothing in it claims a page reads well to a person — the strongest proxies are
geometric ("inside its row", `scrollWidth <= clientWidth`, no sideways scroll). The code
standards say the same thing in one line: *"If a real check isn't possible, say so."*

## 12. The process that produces this

`LESSONS.md` is written nightly: the day's commits are reviewed for what had to be fixed
again, and each lesson is *a rule, then why, then the evidence* (commit, issue, reporter).
**A lesson seen on three separate days moves into `docs/code-standards.md`.** That is why
the GUI section of the standards is four testable bullets rather than a style guide — they
are the ones that earned promotion. The document is blunt about the cost of not having
them: on 2026-10-05, 220 commits and about 170 releases, *"about 40 of them fixed
something released earlier the same day or the day before"*.

`docs/subsystems/gui-shell.md` is the other half: every claim in it carries the
implementation identifier *and* the test that holds it (`SIDE_AT`, `navTopGo`,
`scrollOnPurpose`, `sidebar-glide.test.cjs`), plus the issue and often the person. A
design reference that names its own enforcement cannot rot quietly.

## 13. What not to copy

- **The no-framework, 1.3 MB single file.** Its constraints are a system WebKit, no
  bundler, embedding in a Go binary, and macOS 12. Rho builds with Vite and React 19;
  going back would trade real tooling for a discipline Rho would have to re-earn.
- **English-as-i18n-key.** Excellent under five languages; pure cost for a product whose
  text is English only. Take the *shape* — one source of truth for text, plus a test that
  nothing is orphaned or duplicated — not the translation files.
- **The Safari 15 compat layer and the desktop-shell code** (`--wails-draggable`, AppKit
  title-bar insets, GTK clipboard, the WebKitGTK compositor crash). That is the tax of
  the Wails desktop shell and an old system WebKit, not a frontend idea.
- **`app.js`'s size.** 24.5k lines in one file works here because one person's discipline
  and 947 test files hold it. Rho's equivalent discipline is types and components.
- **Its accessibility gaps.** `aria-expanded` is only updated on anchors that already have
  it, the model picker exposes no `aria-selected` or `activedescendant` (its selection is
  a CSS class on an `li`), and closing the picker does not return focus. A study that
  quoted only the wins would hand Rho a worse starting point than it has.
- **Its stylesheet order.** Accretion is tolerable at 4389 lines with one author and a
  floor-asserting guard; it is not a model to copy into a fresh sheet.

## 14. Candidate actions for Rho

Ordered by value per unit of risk; each is on a screen Rho already has, and each states
how it could be observed. None of these is a design decision about a new screen.

1. **A per-pane error boundary.** Rho has no `ErrorBoundary` anywhere in
   [web/](../web) and `src/`; a plugin view that throws during render takes the whole
   workspace with it. magpie's rule is one boundary per page, with the error's message
   and one Try again, and every other page unaffected. *Observe:* a view that throws
   leaves its tab showing the failure while the other tabs and the shell keep working.
2. **Keep the reader's place under live updates.** The Agent panel streams and
   [web/overview.tsx](../web/overview.tsx) re-reads external projections every 1.5s; both
   can move the page under the pointer today. magpie's mechanism is a trusted-event
   permission token plus a short hold on what was clicked. *Observe:* with the view
   scrolled, a reply arriving, a fold opening and a background read landing all leave the
   clicked row within a pixel of where it was — the failure modes magpie enumerated
   (§5.2) are exactly the ones to test.
3. **Pin the UI rules Rho already believes in.** `docs/code-standards.md`'s GUI section
   is four mechanical assertions. Rho's equivalents are already implicit in its
   acceptance runs; making them one-line assertions (`select` count, left-border widths,
   no sideways scroll, the narrow widths) costs little and stops drift.
4. **Decide which checks must run where a merge can be blocked.** magpie splits its own
   verification: the browser suite (943 files) runs locally only, and the cheap source-reading
   guards are the ones CI holds. Rho's episode-shaped acceptance is expensive for the same
   reason. The transferable move is to make the *rule-level* checks source-reading and
   cheap enough to gate a merge, and keep the real-episode runs as the evidence that a
   path works.
5. **One rule per subsystem doc, with its enforcement named.** Rho's episodes record what
   a run showed; they do not name the test that would catch a regression. Adding a
   "held by" line next to each behavioural claim is the cheapest part of magpie's
   documentation discipline.
6. **A lessons ledger with a promotion threshold.** Rho already records episodes; nothing
   promotes a repeated observation into a standard. magpie's "three sightings, then the
   code standards" is the smallest version of that loop.
7. **Boot-time preferences before first paint.** When Rho adds a theme mode or a text
   size, [web/index.html](../web/index.html) needs the equivalent of `theme.js` before
   the stylesheet, or the first frame will paint the default and then change.
8. **A budget per frontend file, with a documented raise.** `TestCoreScriptBudget` makes
   growth a decision rather than a drift. The cheap form for Rho is a byte ceiling per
   entry module with the same "say why when you raise it" rule.

## Appendix: where to read what

| Question | Start at |
| --- | --- |
| The shell's behaviour, per rule, with its test | `docs/subsystems/gui-shell.md`, esp. "Shared UI rules" |
| Scroll, focus and click stability | `internal/gui/assets/app.js:22779-23207` |
| Boot order and why | `internal/gui/assets/index.html`, `theme.js`, `layout.js`, `start.js` |
| Plugin contract and its guarantees | `internal/gui/assets/kernel.js`, `docs/subsystems/plugin-runtime.md` |
| Theme and tokens | `internal/gui/assets/app.css:1-160` |
| How a test is written | any `internal/gui/tests/*.test.cjs`, plus its `README.md` |
| The rules that survived review | `docs/code-standards.md` (GUI section) |
| How the rules were learned | `LESSONS.md` |
