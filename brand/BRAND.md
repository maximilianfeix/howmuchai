# howmuchai

**A measure of disclosed AI involvement in public code.** A static site, CLI, GitHub Action, README badge, and leaderboard for the top 1,000 repositories. The identity should feel equally at home next to a terminal prompt and in a journalist’s chart.

## The mark

A percent sign with a gauge inside its lower circle. Percent is the product’s unit; the partially filled circle makes measurement the distinguishing detail. The diagonal gives it momentum without suggesting approval or alarm. All geometry is hand-written SVG: circles, a rounded stroke, and a semicircle. No borrowed company symbols, robots, or sparkles.

Of the proposed directions, the percent/gauge most directly expresses the output. A split commit dot could imply a knowable human/AI binary; a caliper adds detail that disappears at 16px; a commit-line question mark communicates uncertainty but loses the unit. Keep the gauge’s half-fill fixed: it is a symbol, never the reported score. At small sizes, the percent silhouette carries recognition and the fill becomes a secondary cue.

The standalone mark is transparent and uses light-theme ink. Use its dark-theme colors on dark surfaces. The favicon has a rounded dark tile for consistent contrast with browser chrome. Keep clear space of at least one upper-ring radius around the visible mark; the supplied lockups include their own spacing. Minimum display size: 16px square. Do not add ticks, gradients, shadows, or agent icons. Do not rotate or stretch it.

## Wordmark and typography

Write the name **howmuchai**, lowercase, without spaces. The wordmark uses a bold system sans face with tight spacing; `ai` takes the accent color. Both parts have equal weight: the accent identifies the subject without assigning value to it. Preserve the single-color reading when color is unavailable.

System sans stack, used for wordmarks, headings, prose, badge labels, and legends:

```css
-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif
```

Monospace stack, used for repository identifiers, percentages, and measurement metadata:

```css
ui-monospace, 'SF Mono', Menlo, Consolas, monospace
```

No web fonts. Every SVG text element declares one of these stacks. SVG text stays editable; letter shapes and widths can vary slightly with the host’s installed fonts. Use tabular numerals for live numeric interfaces. Exported PNGs provide fixed reference renders.

## Theme palette

| Role | Dark | Light | Use |
| --- | --- | --- | --- |
| Background | `#101B2C` | `#FFFFFF` | Canvas |
| Surface | `#19273B` | `#F1F4F9` | Inset results, controls |
| Border | `#35465E` | `#C7D1DF` | Quiet separators, decorative card outlines |
| Text | `#F2F5FA` | `#18263A` | Primary copy and measurements |
| Muted | `#A8B7CC` | `#52627A` | Supporting copy, metadata |
| Accent | `#A4B5FF` | `#4056BC` | Brand, links, focus treatment |
| No signal | `#66768B` | `#66768B` | No disclosed signature found |

WCAG contrast calculations use relative sRGB luminance. Text / muted / accent respectively measure **15.81 / 8.48 / 8.75:1** on the dark background and **13.78 / 7.39 / 7.62:1** on its surface. On light they measure **15.25 / 6.20 / 6.41:1** on the background and **13.83 / 5.62 / 5.82:1** on its surface. These pairings exceed WCAG AA’s 4.5:1 threshold for normal text. This is a palette check, not a claim of full interface conformance.

The border colors are decorative: do not rely on them alone to identify an interactive control. Use accent for meaningful focus outlines. No-signal gray is a chart fill, not a text color: it measures 3.73:1 on dark and 4.64:1 on white, but only 4.21:1 on the light surface. Always label it with the theme’s text or muted color. Small preview text is intended for its native export size, not a heavily reduced thumbnail.

## Agent colors

A harmonious categorical set, unrelated to the vendors’ official palettes. Keep assignments stable across themes, charts, and exports. These colors identify agents, not better or worse results.

| Agent | Color |
| --- | --- |
| Claude Code | `#8D9DFF` |
| GitHub Copilot | `#4DB8A4` |
| OpenAI Codex | `#E6B75A` |
| Cursor | `#D891C8` |
| Devin | `#62B9DB` |
| Google Jules | `#B0BF65` |
| Aider | `#ED9983` |
| Amp | `#B39BDC` |
| OpenHands | `#88AFBE` |
| Other | `#A8ABB5` |

Hue and luminance variation help distinguish categories, including several common color-vision differences, but ten swatches cannot be reliably distinguished by everyone. Always pair them with names and numerical values. Use direct labels, stable ordering, and patterns or separated rows when many agents appear together. Do not use these fills for small text on light backgrounds. For interactive charts, provide a textual data table and keyboard-accessible details. SVGs include accessible titles and descriptions; when embedding with `<img>`, supply useful alt text as well.

## Measurement language and sample data

“AI-signed” means a commit or pull request carries a recognized, disclosed coding-agent signature. It measures observable evidence, a lower bound on involvement. It does not measure how many lines an AI wrote, code quality, or how much work a person did. **No signature found does not mean human-only.** Zero is an observed result; unavailable data is “Unavailable” or “—”, never 0%.

The sample repository is deliberately generic: `your-org/your-repo`. All supplied result graphics use illustrative data: 500 commits in the last 90 days; 115 signed commits, or 23%. Claude Code contributes 60 (12%), GitHub Copilot 35 (7%), and OpenAI Codex 20 (4%). The remaining 385 (77%) have no signature found. Every agent percentage uses **all 500 commits** as its denominator, not just the signed subset. The bar spans the whole population. The cards label the unsigned remainder explicitly.

Live results must deduplicate signed commits across agents, or define a consistent single-agent attribution rule before drawing additive bars. Report commit and PR percentages separately with their own denominators; never blend them into an unlabeled score. Retain period, sample size, and a link to detection methodology wherever practical. A large percentage always gets an “AI-signed commits” or “AI-signed PRs” label.

## Badge system

Flat, 20px high. Left label: `AI-signed`, white on slate `#34445A`. Right value: white on periwinkle `#4056BC` (6.41:1 contrast). **Recommended scale: constant hue and lightness for every valid value from 0–100%.** The number conveys magnitude; color does not grade it. Both 0% and 23% intentionally use the same fill. For unavailable data use `—` on `#52627A`, retaining an explicit accessible description. Never map low/high values to green/red. Link production badges to a report explaining period, denominator, and detection limits.

## Tagline options

1. How much of this repo was built with AI?
2. Follow the signatures.
3. Measure what agents leave behind.
4. A little less guessing. A little more Git history.
5. Disclosed AI involvement, by the numbers.

The first is the main invitation, not a promise to detect undisclosed work. Pair it with the lower-bound explanation in results. “Open source. Open evidence.” is the short supporting line used on the social preview.

## Voice

Speak like a careful reporter who reads commit messages for fun: direct, specific, curious, and occasionally dry. State the finding, the period, the denominator, and the limit. Prefer “23% of recent commits carry an agent signature” to claims about who built a repository. A raised eyebrow is welcome; moral scores, accusations, purity tests, and victory laps are not. Let a surprising number do the talking, give maintainers room to explain, and distinguish absence of evidence from evidence of absence. Say what was counted and make the method easy to inspect.

## Asset inventory

- `mark.svg` — 512×512, transparent, light-theme ink.
- `favicon.svg` — 32×32, dark tile; also checked at 16px.
- `lockup-dark.svg`, `lockup-light.svg` — 800×200, theme backgrounds.
- `social-preview.svg` — 1280×640, illustrative repository result.
- `badge-sample.svg`, `badge-sample-zero.svg` — 120×20, 23% and 0%.
- `card-sample-dark.svg`, `card-sample-light.svg` — 495×195.
- `card-sample.svg` — identical to the light card, convenient default.
- `mark.png`, `social-preview.png`, `card-sample-dark.png`, `card-sample-light.png` — rendered references at native size.

All SVGs use viewBox, local geometry and system fonts, with no linked assets or raster data. Validate with `xmllint --noout *.svg`; render each reference with `/opt/homebrew/bin/resvg input.svg output.png`. The future canonical domain is `howmuchai.dev`; until it is live, link reports to `https://maximilianfeix.github.io/howmuchai/`. No asset bakes in a temporary domain.
