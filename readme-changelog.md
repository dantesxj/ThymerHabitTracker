# Thymer Habit Tracker

**Version 1.0.4** · Habit Tracker collection plugin for [Thymer](https://thymer.com) (collection plugin, not a global plugin).

Track habits from the journal sidebar: categories, streaks, numeric targets, stats, and daily logs stored in a **`HabitTracker`** collection.

---

### Features

- Habits panel on journal pages with checkable items and streak display
- Settings UI for categories and habits (archive, reorder, drag-and-drop, numeric targets)
- Category streaks aggregated from habits in each category
- Long-press on numeric habits for direct entry; tap to increment
- Stats view with 7d / 30d range (persisted), completion calendar, bar chart, and category rates
- Habit date follows the open journal day; stats calendar defaults to that month

### Data

- Config and daily completions live in collection records named **`__config__`** and **`log-YYYY-MM-DD`** (JSON in the **Data** field). See the file header in `collectionplugin.js` for the exact JSON shapes.

### Known limitations

- Short delay when switching journal pages while the panel refreshes
- Possible lag updating the viewed day when changing dates quickly

### Changelog

**1.0.4** — **Tabler Icons** across the sidebar, settings, stats, and importer (webfont `ti ti-*`). **Category icon** is chosen from a **dropdown** of curated Tabler icons with a live preview (stored in the existing `emoji` field as a slug; legacy emoji still supported). **Per-day notes**: collection **`notes`** field + `page_field_ids`, with a scrollable notes area under the habit list, persisted per journal date. **Performance:** sidebar uses **one** `getAllRecords` pass to build the log map and compute all category/habit streaks (instead of one full scan per streak badge).

**1.0.3** — **Panel refresh after saving settings:** `refreshAllPanels()` no longer skips the panel when the stats view is open; it re-renders stats or the habits sidebar as appropriate. The settings *Save* flow **awaits** that refresh so the async sidebar render completes—so the empty “Set up habits” message clears right after you create categories and habits, without reloading the app.

**1.0.2** — Settings: the “add habit” category dropdown and all habit-row category labels/dropdowns stay in sync when you add, rename, or reorder categories—no need to close the modal or reload.

**1.0.1** — Stats range defaults and persistence; habit calendar month aligned with the open journal date.

**1.0.0** — Initial release.

---

‼️ _Work in progress — suggestions and support very welcome._ ‼️
