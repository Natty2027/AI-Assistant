# Ambient Cyber Companion — browser-native layer

Chrome MV3 side panel + Safari Web Extension. Shares the safety core and Vision pipeline
from the Personal Cyber Companion build; this adds presence, quiet-mode arbitration, and
task preparation.

```
ext/manifest.json            MV3 + Safari notes
ext/ui/sidepanel.html        Deliverable 1 — the panel, self-contained and renderable
tailwind.config.js           Same tokens as utilities, for the real build
src/ambient/quietMode.ts     Deliverable 2 — OS + calendar muting engine
src/prep/requirementAudit.ts Deliverable 3 — prerequisites and advisory guidance
src/safety/ambientPrompt.ts  Deliverable 4 — system prompt, ambient edition
native-host/quiet-probe.py   Optional native messaging host for real OS DND
```

## Design plan

**Subject.** A 360px column that lives beside a student or knowledge worker who is doing
something else. It is read in two-second glances. Its primary job is to answer "what's next
and am I ready for it" without pulling focus. Success looks like being ignorable.

**Palette.** Cool slate ground under warm graphite surfaces — the brief asks for both, so the
two are layered rather than blended, which keeps the panel from going muddy.

```
--ground   #14171C   panel base, cool slate
--surface  #1D2026   raised cards
--edge     #2A2E36   hairlines, glass borders
--bone     #E4E1DB   primary text (warm, not #FFF — avoids halation on dark)
--muted    #A0A5AE   secondary text
--faint    #6E747E   non-essential only
--sand     #C8A98A   the single accent
--sage     #7FA8A0   listening state
```

Contrast: bone/ground 13.8:1, muted/ground 6.4:1, sand/ground 7.9:1. `--faint` sits at 3.6:1
and is used only for decorative gutter ticks, never for text carrying meaning.

Deliberately not used: terracotta (#D97757), acid green, pure black, pure white. The accent is
sand rather than any signal colour, so nothing in the resting panel reads as an alert.

**Type.** One family — Hanken Grotesk, weights 400/500/600 — with tabular figures on all
clock times so the timeline doesn't jitter as minutes tick. Sentence case throughout; no
tracked-out capital labels, since the whole point is a surface that doesn't shout.

**Layout.** The signature element is a time gutter: a hairline running the left edge with a
sand marker at the current moment and the next four hours blocked out beside it. Everything
else is quiet — flat cards, one radius, no shadows competing with the glass.

```
┌────────────────────────────┐
│ ● Idle          Quiet: on  │  presence + quiet reason
├────────────────────────────┤
│ │▁ 2:00  Design review     │  time gutter, next 4h
│ ●─ now                     │
│ │   4:30  Lab report due   │
├────────────────────────────┤
│ Before design review       │  prep card, advisory voice
│ · Q3 deck (in event notes) │
│ · Zoom link                │
├────────────────────────────┤
│ Held while you're in class │  queued alerts, no badge count
├────────────────────────────┤
│ Adaptive automation  [ ○]  │
│ What's being observed →    │
├────────────────────────────┤
│ AI can misread schedules…  │  permanent footer
└────────────────────────────┘
```

**Motion.** Exactly one moving thing: the presence dot, breathing on a 4.5s cycle with a
0.94–1.0 scale range. Under `prefers-reduced-motion` it becomes a static ring and the state
is carried by the adjacent word instead. Nothing else animates on its own — queued items
appear without a slide, because a thing sliding into your peripheral vision during a lecture
is exactly the failure this product exists to avoid.

## Three constraints that shape the build

**1. Browsers cannot read OS Do Not Disturb.** There is no extension API for macOS Focus,
iOS Focus, or Windows Quiet Hours. Chrome gives you `chrome.idle` and window state; that's
it. So `quietMode.ts` is a resolver over four evidence sources of decreasing fidelity:

| Source | Fidelity | Availability |
|---|---|---|
| Native messaging host | Reads actual Focus/Quiet Hours | macOS, Windows desktop only |
| Calendar busy state | Exact, if the calendar is accurate | Everywhere |
| Page heuristics | Fullscreen, screen share, mic live | Everywhere |
| Idle state | Weak | Chrome desktop |

On iOS Safari there is no native messaging at all, so the calendar and heuristics carry the
whole load. **The resolver fails quiet**: unknown state means no audio and no overlay. Being
silent when you should have spoken costs the user a glance at the panel. Speaking during
someone's exam costs you the install.

**2. MV3 forbids remote scripts,** so no Tailwind CDN. `sidepanel.html` ships self-contained
with the token system inline, using class names identical to the Tailwind utilities in
`tailwind.config.js` — swapping to a real build changes the build step, not the markup.

**3. Quiet mode never suppresses the crisis response.** Every alert path checks quiet state;
the crisis path does not. It renders in-panel, silently, immediately, regardless of Focus,
exam blocks, or a manual mute. A DND setting is a preference about notifications, not a
reason to withhold a crisis line from someone who just disclosed something.
