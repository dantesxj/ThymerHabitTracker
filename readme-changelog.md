# Changelog (legacy + current)

## Global plugin (current)

**1.1.0** — This repository now ships the **global** AppPlugin only. Habits and logs live in **Plugin Backend** (`record_kind` `config` / `log`, plugin slug `habit-tracker`). One-time import from a legacy **`HabitTracker`** collection when present. See **[README.md](./README.md)** for install and migration from the old collection model.

---

## Collection plugin (historical; pre–1.1.0 in this repo)

Earlier tags/commits documented here used a **`HabitTracker`** collection and full collection `plugin.json`.

**1.0.5** — Category labels in native dropdowns: show category name only (not Tabler icon text prefixed). Icons unchanged where HTML is used.

**1.0.4** — Tabler Icons; category icon dropdown; per-day **notes** via collection `notes` + `page_field_ids`; sidebar performance (single `getAllRecords` pass for log map / streaks).

**1.0.3** — Settings save: `refreshAllPanels()` fixes when stats view open; save flow awaits sidebar refresh.

**1.0.2** — Category dropdowns stay in sync when categories change.

**1.0.1** — Stats range defaults/persistence; habit calendar month aligned with journal date.

**1.0.0** — Initial collection release.
