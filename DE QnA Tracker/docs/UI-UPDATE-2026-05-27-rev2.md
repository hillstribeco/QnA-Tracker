# UI Update — 2026-05-27 (revision 2)

Four page-intro removals plus an Admin tab-header sticky enhancement.
This is a second additive patch block in `public/index.html`, sitting
directly below the 2026-05-27 bug-fix patch and marked with
`<!-- UI UPDATE PATCH — 2026-05-27 (revision 2) -->`. Removing this
block fully restores the previous look.

## Implementation strategy — why CSS, not markup deletion

The admin Customization tab still writes text into these heros at
runtime via `applyAdminCustomization()` (line 5197 of `index.html`),
which calls `setText('#page-allq .allq-hero h1', text.allq_title)` and
similar selectors for the Review header, the FAQ hero, and the
Submit form. The function null-checks before writing, so a missing
selector is silently skipped — but I prefer to keep the markup intact
so the customization UI's "All Questions title", "Review subtitle",
etc. inputs continue to do something coherent if a future admin
decides to bring the heros back.

The chosen approach is therefore a single `display: none !important`
rule per hero, scoped tightly to its page ID.

## What changed

### Removals (visually)

| Page         | Selector hidden                                        | Note |
|--------------|--------------------------------------------------------|------|
| All Questions | `#page-allq .allq-hero`                               | The "All Questions / View all questions submitted by the team — read only." dark hero strip. |
| Review        | `#page-review > .content-wide > .page-header`         | The "Reviewer Dashboard / Review incoming questions…" intro inside the page. |
| Team Chat     | `#page-collab .collab-hero`                           | The dark hero with "Team Chat / Slack-style channels, @mentions…" inside the collab page. |
| Admin         | `#page-admin > .hero-premium`                         | The dark "Operational Control Center / Monitor SLA health…" hero on the admin page. |

In each case the remaining content shifts upward because
`display: none` removes the element from layout entirely. I also
adjusted the top padding of the next visible container by a small
amount (14–22px) so the first row of real content does not sit
pinned right against the nav edge:

- `#page-allq .content-wide { padding-top: 22px; }`
- `#page-review .content-wide { padding-top: 22px; }`
- `#page-admin .admin-dashboard { padding-top: 14px; }`
- Team Chat: no body-level adjustment needed — the flex layout from
  the earlier patch already makes `.collab-shell` fill the viewport,
  so hiding `.collab-hero` just hands that space to `.collab-shell`.

### Admin tab header — strong sticky

The base CSS already had `position: sticky; top: 60px` on
`#admin-tabbar`, but the visual treatment was weak (a translucent
`var(--surface2)` background plus a `backdrop-filter: blur(10px)`),
so on light pages content scrolling underneath blended into the
strip and it was unclear whether the strip was actually sticking.

The new rule:

```css
#page-admin #admin-tabbar.admin-tabbar {
  position: sticky !important;
  top: var(--nav-height, 60px) !important;
  z-index: 4800 !important;
  background: var(--surface) !important;       /* opaque surface     */
  margin: 0 0 18px 0 !important;
  padding: 14px 0 0 !important;
  border-bottom: 1px solid var(--border) !important;
  box-shadow: 0 6px 14px -10px rgba(0,0,0,0.22) !important;
}
```

with a dark-mode override that swaps to a near-opaque deep surface and
a heavier shadow. The active tab keeps the existing accent underline.

### Mobile (≤900 px) — horizontal scroll instead of wrap

With eight tabs (User Info, Overview, Settings, Data & Exports,
Analytics, Submitter Detail, Customization, System Status), the
previous `flex-wrap: wrap` layout consumed two or three rows of
vertical space on phone widths.

The fix switches to a horizontal-scroll strip:

```css
@media (max-width: 900px) {
  #page-admin #admin-tabbar.admin-tabbar {
    flex-wrap: nowrap !important;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-x: contain;
    -webkit-overflow-scrolling: touch;
    scroll-snap-type: x proximity;
  }
  #page-admin #admin-tabbar .admin-tab {
    flex: 0 0 auto;
    white-space: nowrap;
    scroll-snap-align: start;
  }
}
```

Plus a small JS helper that calls `scrollIntoView({inline: 'center'})`
on the active tab after every `switchAdminTab()` so a tab that's been
scrolled out of view comes back into view when the user taps it from
a search result, a deep link, or a localStorage-restored route. This
helper is wrapped around `switchAdminTab` defensively so other
patches that also wrap `switchAdminTab` (customization, user-info)
don't lose the behavior.

### Z-index notes

The admin tabbar sits at `z-index: 4800`, comfortably below:

| Layer              | z-index |
|--------------------|--------:|
| Nav                | 5000    |
| Modal overlays     | 5200    |
| Notifications      | 5300    |
| Search overlay     | 5400    |
| Emoji picker       | 5600    |

So modals and search still open on top of the sticky tabbar; the
sticky tabbar sits above all page content as intended.

## Validation

| Check                                       | Result |
|---------------------------------------------|--------|
| All 8 inline `<script>` blocks parse (node) | ✅      |
| All 6 inline `<style>` blocks brace-balanced| ✅      |
| `applyAdminCustomization` selectors intact  | ✅ (markup not deleted) |
| Customization inputs for All Questions / Review titles still bind to live elements | ✅ |
| Admin tabbar sticky across light + dark     | ✅      |
| Mobile horizontal-scroll on the tab strip   | ✅      |
| Other pages' `.page-header` (Submit page) unaffected | ✅ — selector scoped to `#page-review > .content-wide > .page-header` only |

## Rollback

Open `public/index.html`, search for
`UI UPDATE PATCH — 2026-05-27 (revision 2)`, and delete the comment
block plus the `<style>` and `<script>` blocks that immediately follow
it (everything up to but not including the next `<footer ...>` tag).
The heros return and the admin tabbar reverts to its previous (weakly
sticky) styling.

If you want to keep the heros hidden but revert *only* the admin
tabbar styling, delete just the `/* 5: Admin tab header */` block
inside the `<style>` element. The four `display: none` rules at the
top of the same block stand alone.

## Known follow-ups (deferred)

- **The customization editor still exposes inputs for the four hidden
  hero texts** (All Questions title, All Questions subtitle, Review
  title, Review subtitle). Editing them has no visible effect while
  the heros are hidden. If you want, the cleanest follow-up is to add
  a `disabled` state on those inputs *or* hide them from the
  customizer too — but doing so risks confusion if an admin later
  reverts this patch and finds their previously-edited copy
  unreachable. I left them visible on purpose. One ticket's worth of
  work either way.
- **IntersectionObserver-based "scrolled" shadow**: the current
  implementation shows the sticky-style box-shadow always, regardless
  of scroll position. A premium polish would be to render the shadow
  only after the user scrolls past a sentinel placed above the tabbar.
  Worth ~30 lines of JS if you want it.
