# Thymer Habit Tracker

Global **AppPlugin** for [Thymer](https://thymer.com): journal sidebar habit tracking with categories, streaks, and stats. Habits and daily logs live in the workspace **Plugin Backend** collection (no separate `HabitTracker` collection). Workspaces that still use the legacy name **Plugin Settings** are detected automatically.

Repo version: **1.1.0** (see `plugin.json`).

## Collection plugin → global plugin (this repository)

Earlier releases in this repo shipped a **collection** plugin: you added a `HabitTracker` collection, pasted code into that collection’s custom plugin slot, and used the full **`plugin.json`** as the collection schema.

**From v1.1.0 onward**, this repo ships the **global** build only:

- Install **`plugin.js`** in Thymer **global** custom code (not tied to a collection).
- Use the minimal **`plugin.json`** as the **global** plugin manifest (name, icon, description, optional `custom.persist_habit_panel_state`), not as a collection definition.
- Data moves to **Plugin Backend** rows keyed by `plugin` / `record_kind` / `plugin_id` / `settings_json`. If you still have a legacy **`HabitTracker`** collection, the plugin can **one-time import** it into Plugin Backend (see Migration below).

If you need the old collection-only workflow, pin or check out a **pre–1.1.0** git tag or commit; new work on this branch assumes the global + Plugin Backend model.

## Install

1. Ensure the workspace has a **Plugin Backend** collection with the expanded schema: fields **`plugin`**, **`record_kind`**, **`plugin_id`**, **`settings_json`**. If you develop from the ThymerExtensions workspace, the reference collection JSON is `plugins/public repo/plugin-settings/Plugin Backend.json` there; otherwise merge those fields into your existing collection in Thymer (legacy display name **Plugin Settings** is still resolved).
2. In Thymer **global** custom code, paste **`plugin.js`**.
3. For the global plugin slot, paste **`plugin.json`** (minimal manifest: `name`, `icon`, `description`, optional `custom.persist_habit_panel_state`).

## Data layout (Plugin Backend)

| `record_kind` | `plugin_id` example | Record title | `settings_json` |
|---------------|---------------------|--------------|-----------------|
| `vault` | `habit-tracker` | (Thymer) | Synced localStorage mirror for panel UI keys (managed by `ThymerPluginSettings`) |
| `config` | `habit-tracker:config` | `config` | Categories + habits JSON |
| `log` | `habit-tracker:log:YYYY-MM-DD` | date string | Per-day completions + notes JSON |

Filter the collection by **Plugin** = `habit-tracker` to see all rows for this plugin.

## Migration

If a legacy collection named **`HabitTracker`** still exists, the plugin **once** copies `__config__` and `log-*` records into Plugin Backend, then sets localStorage key **`ht_global_ps_migration_v1`** to `1`. You can remove the old collection afterward if you no longer need it.

## Features

Same UX as the former collection variant: journal panel, categories, streaks, stats range, numeric habits, Command Palette actions (manage, refresh, empty-log cleanup, diagnose, storage location).

## Files

- **`plugin.js`** — global plugin + embedded `ThymerPluginSettings` runtime
- **`plugin.json`** — small global manifest (not a full collection schema)

Historical release notes for the pre–1.1.0 collection builds are summarized in **`readme-changelog.md`** (legacy).
