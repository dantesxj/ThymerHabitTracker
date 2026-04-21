# ThymerHabitTracker

Habit Tracker collection plugin for Thymer.

‼️ _In progress. Created by AI, vibes, and someone who knows nothing about coding! Suggestions and support very welcome!_ ‼️

Current collection schema version in this repo: **v1.0.6** (see `Habit Tracker.json`).

## Overview

Habit Tracker mounts a sidebar-style panel on journal pages for daily habit check-ins and streak tracking.

## Core features

- Journal-page habit panel with per-day completion state
- Category and habit settings management
- Category streak aggregation from child habits
- Numeric habits: tap to increment, long-press to enter value
- Stats range toggle (7-day / 30-day)
- Manual date navigation while keeping journal-date alignment

## Recent sync updates

- Added embedded Path B storage runtime support.
- Added command palette action: `Habit Tracker: Storage location…`.
- Added optional persistence toggle via `custom.persist_habit_panel_state` (when false, UI state does not persist).
- Improved panel lifecycle handling on navigation:
  - deferred `panel.navigated` refresh
  - cleanup when the panel is not on a journal record
- Synced sidebar/category/stats state through Path B mirror keys:
  - `ht_sidebar_collapsed`
  - `ht_cat_collapsed`
  - `ht_stats_range`
- Updated collection JSON shape/icons:
  - removed `notes` field from schema
  - `page_field_ids` now empty

## Files

- `Habit Tracker.js` - plugin code
- `Habit Tracker.json` - collection configuration/schema

