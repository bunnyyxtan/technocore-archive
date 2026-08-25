# Record — design system

The design language for the technocore archive product surface (checker page, future stats page, share cards). One idea: **evidence over decoration**. The interface looks like a well-set document because the product's value is trust.

## Principles

1. Typography carries hierarchy, color never does
2. One accent, earned: green appears only where a verdict or proof lives
3. 4px spatial grid, no freehand values
4. Motion only when something changes state, 250ms max
5. Every surface auditable: one HTML file, self-hosted assets, view-source readable

## Type

Faces: Switzer (sans, 400/500/700), JetBrains Mono (code, 400).
Scale, 1.25 ratio on 16px base:

| token | px | use |
|---|---|---|
| 2xs | 11 | eyebrows, stat labels, meta (mono, tracked, uppercase) |
| xs | 12 | record metadata (mono) |
| sm | 13 | footer, field input (mono) |
| base | 16 | body |
| lg | 20 | lede (muted) |
| xl | 25 | stat numerals (mono) |
| 2xl | 31 | card verdict |
| display | clamp(39 to 61) | page headline, 700, -3% tracking, 1.02 line |

## Color

Primitives: gray-0 #FFFFFF, gray-25 #FCFBF8, gray-100 #E9E7E0, gray-400 #9A9DA3, gray-500 #6E7178, gray-900 #131417, green-600 #0B6B4A, amber-600 #A16207.

Semantic roles:

| role | token |
|---|---|
| page background | gray-25 |
| surface (cards, fields) | gray-0 |
| primary text | gray-900 |
| secondary text | gray-500 |
| tertiary text, labels | gray-400 |
| hairline borders | gray-100 |
| accent (verdicts, proof marks) | green-600 |
| warning text | amber-600 |

Never: gradients, shadows heavier than 4% alpha, accent on decoration, pure black backgrounds.

## Space, shape, motion

Spacing steps: 4 8 12 16 24 32 40 48 64 80. Radii: 10 controls, 14 cards. Borders always 1px. Easing cubic-bezier(.2,.6,.3,1), 150ms hovers, 250ms reveals. Focus: 2px ink outline, 2px offset, focus-visible only.

## Components

- **Button** primary (ink fill, paper text) and secondary (hairline, ink text), 500 weight, radius 10
- **Field** mono 13, surface bg, hairline border, ink border on focus
- **Card** surface, hairline, radius 14, twin 4% shadows
- **Stat** mono xl numeral over 2xs tracked label, hairline dividers
- **Record row** 2px left rule, hairline default, accent on hover
- **Verdict** 2xs tracked label over 2xl weight-700 line, accent when positive, gray-500 when negative

## Voice

Short declaratives, no exclamation marks, lowercase mono for machine facts, sentence case for human sentences. Honest states only: the empty state says what the archive knows and when it looks again.

## Archive surfaces

Added when the page stopped being a checker and became a record. Same rules: type carries hierarchy, green means a fact was found.

- **Coverage track** one 8px rail per room, drawn to scale across the room's full sequence range: green fill for held, 45-degree hairline hatch on paper for lost. Gaps are never rounded up to visible width and never omitted — a sliver of held data in a long hatched rail is the honest picture.
- **Metric grid** four cells, hairline dividers, mono xl numeral over a 2xs tracked label. The lead metric takes the accent, the rest stay ink, so a glance lands on one number.
- **Minute chart** flat bars on the 4px grid, no axis furniture. Green is the shared-template share of that minute, gray-100 the remainder; ends are labelled instead of ticked.
- **Template row** posts and identities in mono at 2xs, sample text in body. No ranking marks, no color scale — the count is the argument.
- **Method note** every measured section carries the rule that produced it in plain sentences, because a number whose definition is hidden is decoration.
