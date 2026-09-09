// ==Plugin==
// @id: dawn-habits
// @name: Habits
// @description: JHS Habits lego — collapsed cold; idle Habit Logs index; no nav scans
// @icon: ti-flame
// ==/Plugin==

/**
 * Dawn Habits — standalone JHS tab plugin.
 *
 * Deploy:
 *   cat plugin.js habits-engine.js habit-manage.mixin.js habit-quick-access.mixin.js
 *
 * CONTRACT:
 * - registerTab('habits') on Journal Header Shell.
 * - onDay collapsed = cache paint. Expanded day-flip + expand hydrates the visible day. Index idle until `full`.
 * - Cross-plugin: globalThis.__dawnHabitsHost.markDone(name, dayKey).
 * - Not the lab Behavioral blob (no meals / workout / flows).
 */

class Plugin extends AppPlugin {
  onLoad() {
    this._unreg = null;
    this._unregTab = null;
    this._habits = null;

    try {
      this._habits = new DawnHabitsEngine(this);
      this._habits.attach();
    } catch (e) {
      console.error('[Dawn/Habits] engine missing — deploy concatenated bundle', e);
      return;
    }

    this._waitForBoot((boot) => {
      this._unreg = boot.register({
        id: 'dawn-habits',
        tier: 'idle',
        runIdle: ({ isMobile }) => this._habits?._runIdleIndex?.(boot, isMobile),
        idleDelayMs: (isMobile) => (isMobile ? 8000 : 450),
      });
      boot.enqueue?.(() => this._habits?._loadVaultConfig?.(), {
        id: 'habits:vault-config',
        tier: 'onDemand',
      });
    });

    this._waitFor(
      (g) => !!(g.__dawnJhsShell && (g.__dawnJhsShell.registerTab || g.__dawnJhsShell.registerAddon)),
      () => {
        const shell = globalThis.__dawnJhsShell;
        const reg = shell.registerTab || shell.registerAddon;
        const habits = this._habits;
        if (!habits) return;
        this._unregTab = reg.call(shell, {
          id: 'habits',
          label: 'Habits',
          icon: 'ti-flame',
          mode: 'inline',
          order: 20,
          mount: (el, ctx) => habits._mount(el, ctx),
          onDay: (dayLabel, meta) => habits._onDay(dayLabel, meta),
          onExpand: (expanded) => habits._onExpand(expanded),
          onSettings: () => habits._toggleManage?.(),
        });
      }
    );
  }

  onUnload() {
    try {
      this._unregTab?.();
    } catch (_) {}
    try {
      this._habits?.detach?.();
    } catch (_) {}
    try {
      this._unreg?.();
    } catch (_) {}
  }

  _waitFor(pred, cb) {
    let n = 0;
    const tick = () => {
      try {
        if (pred(globalThis)) {
          cb();
          return;
        }
      } catch (_) {}
      n += 1;
      if (n > 240) return;
      setTimeout(tick, 40);
    };
    tick();
  }

  _waitForBoot(cb) {
    let n = 0;
    const tick = () => {
      const boot = globalThis.BootKernel || globalThis.__dawnBoot;
      if (boot?.register) {
        cb(boot);
        return;
      }
      n += 1;
      if (n > 240) return;
      setTimeout(tick, 25);
    };
    tick();
  }
}
/**
 * Dawn Habits engine — instantiated by Dawn Habits (`new DawnHabitsEngine(app).attach()`).
 * Concatenated into the Habits deploy bundle. Lab Behavioral still vendor-copies this file.
 */

const HABITS_LS_INDEX = 'dawn_habits_index_v8';
const HABITS_LS_UI = 'dawn_habits_ui_v1';
const HABITS_LS_NOTES = 'dawn_habits_notes_v1';
/** { categories: [{id,name}], habits: [{name,categoryId}] } — LS cache of Habit Logs config. */
const HABITS_LS_CONFIG = 'dawn:habit_config_v1';
/** { [dayKey]: { [habitName]: 'fail'|'na' } } — overlay marks; done lives on log completions. */
const HABITS_LS_MARKS = 'dawn:habit_marks_v1';
/** { [dayKey]: { [habitName]: number } } — numeric habit counts (LS; Path B prefs). */
const HABITS_LS_VALUES = 'dawn:habit_values_v1';
const HABITS_LS_DONE = 'dawn:habit_done_v1';
const HABITS_COLL_NAME = 'Habit Logs';
/** Lab New Dawn Habit Logs. */
const HABITS_COLL_GUID = '15HZT1DSST873P3B7PF1YZYAPZ';
/** darienx production Habit Logs. */
const HABITS_COLL_GUID_PROD = '1ASFE5F1R9VEJW3NZKN5CSC568';
/** darienx `habit-tracker:config` record — load this first, do not wait for 917-log idle scan. */
const HABITS_CONFIG_GUID_PROD = '1J7N3755NTBQ0320KQK5GCYFY2';
const HABITS_NOTES_PROP = 'Notes';
/** Prod JHS sentinels in log `settings_json.completions`. */
const HABITS_COMP_NA = '__na__';
const HABITS_COMP_FAIL = '__x__';
const HABITS_INDEX_TTL_MS = 5 * 60 * 1000;
const HABITS_DEFAULT_CAT = { id: 'default', name: 'Habits' };
const HABITS_LONG_PRESS_MS = 500;
const HABITS_RECOVERY_DECAY_MS = 90 * 24 * 60 * 60 * 1000;
const HABITS_RECOVERY_MILESTONES = [7, 30, 90, 365];
const HABITS_DEEP_FOCUS_MIN = 3;

class DawnHabitsEngine {
  constructor(app) {
    this._app = app;
    this.data = app.data;
    this.ui = app.ui;
    this.events = app.events;
  }

  attach() {
    this._unregBoot = null;
    this._unregAddon = null;
    this._root = null;
    this._statusEl = null;
    this._listEl = null;
    this._index = { byDay: {}, count: 0, builtAt: 0, ms: 0, full: false };
    this._building = false;
    this._hydrating = new Set();
    this._logMiss = Object.create(null);
    this._gen = 0;
    this._dayKey = null;
    this._viewMode = 'list';
    this._statsRange = 7;
    this._statsSelected = 'overall'; // 'overall' | 'habit:<name>'
    this._statsCalMonth = null; // { y, m } for 30d grid
    this._singleCol = false;
    this._notesByDay = Object.create(null);
    this._notesTimer = null;
    this._config = {
      categories: [{ ...HABITS_DEFAULT_CAT }],
      habits: [],
      guidedFlows: [],
      recoveryInventory: [],
      recoveryEarned: { milestones: {}, awards: {} },
      categoryRecovered: {},
    };
    /** @type {Record<string, Record<string, 'fail'|'na'>>} */
    this._marksByDay = Object.create(null);
    /** @type {Record<string, Record<string, number>>} */
    this._valuesByDay = Object.create(null);
    this._activeCatId = HABITS_DEFAULT_CAT.id;
    this._catCollapsed = {};
    this._ribbonEl = null;
    this._catNameEl = null;

    this._configGuid = '';
    this._vaultConfigRaw = null;
    this._vaultConfigLoaded = false;
    this._applyingVaultConfig = false;
    this._configFlushTimer = null;
    this._loadUiPrefs();
    this._loadNotes();
    this._loadConfig();
    this._loadMarks();
    this._loadValues();
    this._loadDone();
    this._manageMode = false;
    this._loadIndexFromStorage();
    this._injectCss();
    this._initPathBPrefs();
    void this._loadVaultConfig();

    this._publishHabitsHost();

    try {
      this._refreshQuickAccess?.();
    } catch (_) {}

    try {
      this._cmdRebuild = this.ui.addCommandPaletteCommand({
        label: 'Dawn: Rebuild Habits Index',
        icon: 'ti-checkbox',
        onSelected: () => {
          const boot = globalThis.BootKernel || globalThis.__dawnBoot;
          boot?.enqueue?.(() => this._runIdleIndex(boot, boot?.isMobile?.()), {
            id: 'habits:rebuild',
            tier: 'onDemand',
          });
        },
      });
    } catch (_) {}
    try {
      this._cmdCats = this.ui.addCommandPaletteCommand({
        label: 'Dawn: Edit habits…',
        icon: 'ti-settings',
        onSelected: () => this._toggleManage(),
      });
    } catch (_) {}
  }

  detach() {
    try {
      this._clearQuickAccessAnchors?.();
    } catch (_) {}
    try {
      this._unregBoot?.();
    } catch (_) {}
    try {
      this._cmdRebuild?.remove?.();
    } catch (_) {}
    try {
      this._cmdCats?.remove?.();
    } catch (_) {}
    try {
      this._styleEl?.remove?.();
    } catch (_) {}
    this._root = null;
    this._statusEl = null;
    this._listEl = null;
    try {
      if (globalThis.__dawnHabitsHost?.plugin === this) {
        globalThis.__dawnHabitsHost = undefined;
      }
      if (globalThis.__dawnHabitsAddon?.plugin === this) {
        globalThis.__dawnHabitsAddon = undefined;
      }
      if (globalThis.__dawnHabits?.plugin === this) {
        globalThis.__dawnHabits = undefined;
      }
    } catch (_) {}
  }

  _publishHabitsHost() {
    try {
      const api = {
        plugin: this,
        getDayKey: () => this._dayKey,
        listHabits: () =>
          (this._config.habits || []).map((h) => ({
            id: h.id || h.name,
            name: h.name,
            categoryId: h.categoryId,
          })),
        listCategories: () =>
          (this._config.categories || []).map((c) => ({
            id: c.id,
            name: c.name,
            icon: c.icon || null,
          })),
        listCategoryRibbon: (dayKey) => {
          const key = dayKey || this._dayKey;
          const habitsAll = this._config.habits || [];
          return (this._config.categories || []).map((c) => {
            const habits = habitsAll.filter((h) => this._habitCategoryId?.(h.name) === c.id);
            const status = this._categoryDayAggStatus?.(habits, key) || '';
            const marked = this._categoryAllMarked?.(habits, key);
            const streak = this._categoryEffectiveStreak?.(c.id, key) || 0;
            return {
              id: c.id,
              name: c.name,
              icon: c.icon || null,
              status,
              streak,
              glyphHtml: this._categoryGlyphHtml?.(c) || '',
              leadHtml: this._ribbonLeadCellHtml?.(status, marked) || '',
              streakHtml: streak > 0 ? this._ribbonStreakHtml?.(streak) || '' : '',
            };
          });
        },
        dayMarks: (dayKey) => {
          const key = dayKey || this._dayKey;
          const out = {};
          const names = new Set((this._config.habits || []).map((h) => h.name));
          for (const e of this._dayEntries?.(key) || []) {
            for (const h of e.habits || []) {
              if (!h?.name) continue;
              names.add(h.name);
              const mark = this._habitMark(key, h.name);
              out[h.name] = {
                done: !!(h.done && !mark),
                mark: mark || null,
                categoryId: this._habitCategoryId?.(h.name) || h.categoryId || null,
              };
            }
          }
          for (const name of names) {
            if (out[name]) continue;
            const mark = this._habitMark(key, name);
            const lsDone = !!this._lsDone?.(key, name);
            out[name] = {
              done: !mark && lsDone,
              mark: mark || null,
              categoryId: this._habitCategoryId?.(name) || null,
            };
          }
          return out;
        },
        markDone: (nameOrId, dayKey) => this._markHabitDoneByName(nameOrId, dayKey),
        toggle: async (nameOrId, dayKey) => {
          const key = dayKey || this._dayKey;
          const want = String(nameOrId || '').trim().toLowerCase();
          if (!key || !want) return false;
          await this._ensureDayLog?.(key);
          let hit = null;
          for (const e of this._dayEntries?.(key) || []) {
            for (const h of e.habits || []) {
              const n = String(h.name || '').trim().toLowerCase();
              const id = String(h.id || '').trim().toLowerCase();
              if (n === want || id === want) {
                hit = { ...h, logGuid: e.guid };
                break;
              }
            }
            if (hit) break;
          }
          if (!hit) {
            const cfg = (this._config.habits || []).find((h) => {
              const n = String(h.name || '').trim().toLowerCase();
              const id = String(h.id || '').trim().toLowerCase();
              return n === want || id === want;
            });
            if (cfg) hit = { ...cfg, logGuid: this._primaryLogGuid(key), done: false };
          }
          if (!hit) return false;
          await this._toggleHabit(hit, key);
          return true;
        },
        mount: (el, ctx) => this._mount(el, ctx),
        onDay: (dayLabel, meta) => this._onDay(dayLabel, meta),
        onExpand: (expanded) => this._onExpand(expanded),
      };
      globalThis.__dawnHabitsHost = api;
      globalThis.__dawnHabitsAddon = api;
      globalThis.__dawnHabits = api;
    } catch (_) {}
  }

  async _markHabitDoneByName(nameOrId, dayKey) {
    const key = dayKey || this._dayKey;
    const want = String(nameOrId || '').trim().toLowerCase();
    if (!key || !want) return false;
    await this._ensureDayLog(key);
    const entries = this._dayEntries?.(key) || [];
    let hit = null;
    for (const e of entries) {
      for (const h of e.habits || []) {
        const n = String(h.name || '').trim().toLowerCase();
        const id = String(h.id || '').trim().toLowerCase();
        if (n === want || id === want) {
          hit = { ...h, logGuid: e.guid };
          break;
        }
      }
      if (hit) break;
    }
    if (!hit) {
      const cfg = (this._config.habits || []).find((h) => {
        const n = String(h.name || '').trim().toLowerCase();
        const id = String(h.id || '').trim().toLowerCase();
        return n === want || id === want;
      });
      if (cfg) hit = { ...cfg, logGuid: this._primaryLogGuid(key), done: false };
    }
    if (!hit) return false;
    if (hit.done && !this._habitMark(key, hit.name)) return true;
    this._setHabitMark(key, hit.name, null);
    this._writeHabitDone(hit, true, key);
    this._paint();
    await this._setTaskDoneSdk(hit, true);
    this._afterDaySave(key);
    return true;
  }

  _injectCss() {
    if (this._styleEl?.isConnected) return;
    const el = document.createElement('style');
    el.setAttribute('data-dawn-habits', '1');
    // Curated production ht-* look — no Path B / load logic.
    el.textContent = `
      .dawn-habits-root {
        color: inherit;
        font: inherit;
      }
      .dawn-habits-status { display: none; }
      .dawn-habits-header.ht-sidebar-header {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 8px;
        padding: 2px 14px 4px;
        min-height: 22px;
        flex-wrap: wrap;
      }
      .jhs-panel-date-nav {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        min-width: 0;
      }
      .jhs-panel-date-nav .ht-date-label {
        min-width: 4.5em;
        text-align: center;
        font-size: 12px;
        font-weight: 600;
        color: rgba(232, 224, 208, 0.92);
        letter-spacing: 0.01em;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .jhs-panel-date-nav .ht-nav-btn {
        appearance: none;
        border: none;
        background: transparent;
        color: var(--text-muted, rgba(200,190,170,0.75));
        width: 26px;
        height: 24px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        cursor: pointer;
      }
      .jhs-panel-date-nav .ht-nav-btn:hover {
        color: inherit;
        background: rgba(255,255,255,0.06);
      }
      .jhs-panel-date-nav .ht-nav-btn .ti { font-size: 15px; }
      .ht-ch-cluster {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .ht-ch-glyph {
        font-size: 14px;
        line-height: 1;
        opacity: 0.9;
      }
      .dawn-habits-date-label {
        font-size: 12px;
        font-weight: 600;
        color: rgba(232, 224, 208, 0.92);
        letter-spacing: 0.01em;
        font-variant-numeric: tabular-nums;
      }
      .dawn-habits-done-meta {
        font-size: 11px;
        color: var(--text-muted, #8a7e6a);
        font-variant-numeric: tabular-nums;
        opacity: 0.85;
      }
      .ht-layout-btn,
      .ht-stats-btn,
      .ht-nav-btn {
        appearance: none;
        background: none;
        border: none;
        cursor: pointer;
        color: #8a7e6a;
        font-size: 14px;
        padding: 2px 6px;
        border-radius: 6px;
        flex-shrink: 0;
        transition: all 0.15s;
        line-height: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 24px;
        min-height: 22px;
      }
      .ht-layout-btn:hover,
      .ht-stats-btn:hover,
      .ht-nav-btn:hover { color: #e8e0d0; background: rgba(255,255,255,0.07); }
      .ht-layout-btn.active,
      .ht-stats-btn.active {
        color: #e8e0d0;
        background: rgba(255,255,255,0.07);
      }
      .ht-layout-btn .ti,
      .ht-stats-btn .ti,
      .ht-nav-btn .ti { font-size: 15px; line-height: 1; }
      .ht-nav-btn.ht-cat-expand-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 22px;
        min-height: 22px;
        padding: 0 2px;
        box-sizing: border-box;
      }
      .ht-nav-btn.ht-cat-expand-toggle .ti {
        font-size: 18px;
        opacity: 1;
      }
      .ht-progress {
        margin: 2px 14px 8px;
        height: 5px;
        background: rgba(255,255,255,0.08);
        border-radius: 3px;
        overflow: hidden;
      }
      .ht-progress.jhs-segment-bar {
        position: relative;
        display: block;
        height: 5px;
        border-radius: 999px;
      }
      .ht-progress.jhs-segment-bar.is-sherbet {
        box-shadow: 0 0 10px rgba(255, 185, 100, 0.28);
        animation: ht-cat-all-done-sparkle 2.8s ease-in-out infinite;
      }
      .jhs-segment-bar .jhs-fill {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 0;
        transition: width 0.35s ease, left 0.35s ease;
      }
      .jhs-fill.is-segment-gradient {
        left: 0 !important;
        width: 100% !important;
        transition: background 0.45s ease;
      }
      .jhs-fill.is-sherbet-full {
        left: 0 !important;
        width: 100% !important;
        background: repeating-linear-gradient(
          90deg,
          #fff8ea 0px,
          #ffe8c8 40px,
          #ffc888 80px,
          #ff9848 120px,
          #f04838 160px,
          #ff9848 200px,
          #ffc888 240px,
          #ffe8c8 280px,
          #fff8ea 320px
        );
        background-size: 320px 100%;
        animation: ht-streak-sherbet-flow 11s linear infinite;
      }
      @keyframes ht-cat-all-done-sparkle {
        0%, 100% { filter: drop-shadow(0 0 1px rgba(255, 210, 140, 0.35)); }
        50% { filter: drop-shadow(0 0 7px rgba(255, 185, 100, 0.65)); }
      }
      @keyframes ht-streak-sherbet-flow {
        0% { background-position: 0 0; }
        100% { background-position: 320px 0; }
      }
      .ht-header-stack {
        display: flex;
        flex-direction: column;
        width: 100%;
        min-width: 0;
        max-width: 100%;
        align-items: stretch;
        gap: 14px;
      }
      .ht-habit-section-ribbon {
        display: grid;
        width: 100%;
        grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
        gap: 8px 10px;
        align-items: center;
        justify-items: stretch;
        padding: 12px 8px 8px;
        margin: 0;
        border-top: none;
        min-height: 22px;
        box-sizing: border-box;
      }
      .ht-habit-section-ribbon[hidden],
      .ht-habit-section-ribbon.ht-hidden { display: none !important; }
      .ht-ribbon-sec {
        display: block;
        width: 100%;
        max-width: 100%;
        min-width: 0;
        padding: 4px 2px;
        border-radius: 0;
        border: none;
        border-bottom: 1px solid transparent;
        background: transparent;
        color: #c4b8a8;
        font-size: 10px;
        cursor: pointer;
        line-height: 1.15;
        transition: background 0.12s, color 0.12s, border-color 0.12s;
        box-sizing: border-box;
      }
      .ht-ribbon-sec-inner {
        display: grid;
        grid-template-columns: 14px 30px max-content;
        align-items: center;
        justify-content: start;
        justify-items: stretch;
        column-gap: 2px;
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
      }
      .ht-ribbon-sec-lead {
        grid-column: 1;
        width: 14px;
        min-width: 14px;
        max-width: 14px;
        display: inline-flex;
        align-items: center;
        justify-content: flex-end;
        justify-self: stretch;
        position: relative;
      }
      .ht-ribbon-marked-dot {
        position: absolute;
        right: -1px;
        bottom: 1px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
      }
      .ht-ribbon-marked-dot .ht-cat-marked-dot {
        width: 3px;
        height: 3px;
        opacity: 0.82;
        box-shadow: 0 0 4px rgba(196, 184, 255, 0.16);
      }
      .ht-ribbon-sec-inner .ht-ribbon-sec-glyph {
        grid-column: 2;
        width: 30px;
        min-width: 30px;
        max-width: 30px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        justify-self: center;
        text-align: center;
      }
      .ht-ribbon-sec-lead .ht-cat-inline-check .ti { font-size: 11px; }
      .ht-ribbon-sec-lead .ht-cat-inline-check--all-done .ti { font-size: 11px; }
      .ht-ribbon-sec-lead .ht-cat-na-bar { height: 10px; width: 2px; }
      .ht-ribbon-sec-lead .ht-cat-inline-fail.ht-habit-mark-fail {
        font-size: 13px;
        font-weight: 700;
      }
      .ht-ribbon-sec-tail {
        grid-column: 3;
        display: inline-flex;
        align-items: baseline;
        justify-content: flex-start;
        gap: 1px;
        min-width: 0;
        justify-self: start;
      }
      .ht-ribbon-sec:hover {
        background: transparent;
        color: #e8e0d0;
        border-bottom-color: rgba(255, 183, 77, 0.35);
      }
      .ht-ribbon-sec-glyph { font-size: 13px; line-height: 1; flex-shrink: 0; }
      .ht-ribbon-slot.ht-ribbon-slot--expanded {
        box-sizing: border-box;
        width: 100%;
        max-width: 100%;
        min-width: 0;
        min-height: 30px;
        padding: 4px;
        opacity: 0;
        visibility: visible;
        pointer-events: auto;
        cursor: pointer;
      }
      .ht-ribbon-slot.ht-ribbon-slot--expanded:focus-visible {
        outline: 1px solid rgba(124, 106, 247, 0.55);
        outline-offset: 2px;
        opacity: 0.08;
      }
      .ht-ribbon-sec-streak {
        display: inline-flex;
        align-items: baseline;
        gap: 1px;
        font-size: 9px;
        font-weight: 600;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.02em;
      }
      .ht-ribbon-sec-streak .ti {
        font-size: 10px;
        vertical-align: -0.05em;
        opacity: 0.95;
        color: currentColor;
      }
      .ht-ribbon-sec-streak .ht-streak-day-count { font-size: 9px; font-weight: 700; }
      .ht-cat-inline-na,
      .ht-cat-inline-fail {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
      }
      .ht-cat-na-bar {
        display: inline-block;
        width: 2px;
        height: 12px;
        border-radius: 1px;
        background: linear-gradient(180deg, rgba(218, 185, 110, 0.95), rgba(168, 132, 58, 0.82));
        box-shadow: 0 0 5px rgba(200, 165, 72, 0.2);
        vertical-align: middle;
      }
      .ht-cat-marked-dot {
        display: inline-block;
        width: 4px;
        height: 4px;
        border-radius: 999px;
        background: rgba(196, 184, 255, 0.70);
        box-shadow: 0 0 6px rgba(196, 184, 255, 0.22);
        opacity: 0.95;
      }
      .ht-habit-mark-fail { color: rgba(142, 72, 72, 0.82); }
      .ht-category {
        margin: 0 0 16px 0;
      }
      .ht-category--ribbon-collapsed { display: none; }
      .dawn-habits-list .ht-habit.ht-fail .ht-habit-check-minimal,
      .dawn-habits-list .ht-habit.ht-fail .ht-habit-check-minimal .ti {
        color: rgba(232, 120, 100, 0.95);
      }
      .dawn-habits-list .ht-habit.ht-fail .ht-habit-name,
      .dawn-habits-list .ht-habit.ht-fail .ht-habit-line-name {
        color: #a87868;
        text-decoration: line-through;
        text-decoration-color: rgba(168,120,104,0.55);
      }
      .dawn-habits-list .ht-habit.ht-na {
        opacity: 0.55;
      }
      .dawn-habits-list .ht-habit.ht-na .ht-habit-check-minimal,
      .dawn-habits-list .ht-habit.ht-na .ht-habit-check-minimal .ti {
        color: #8a7e6a;
      }
      .dawn-habits-list .ht-habit.ht-na .ht-habit-name,
      .dawn-habits-list .ht-habit.ht-na .ht-habit-line-name {
        color: #8a7e6a;
        font-style: italic;
      }
      .ht-category-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 14px 4px;
        cursor: pointer;
        user-select: none;
        border-radius: 8px;
        margin: 0 6px;
      }
      .ht-category-header:hover { background: rgba(255,255,255,0.06); }
      .ht-category-caret {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 12px;
        opacity: 0;
        color: #8a7e6a;
        transition: opacity 0.12s, transform 0.12s;
      }
      .ht-category-caret .ti { font-size: 9px; }
      .ht-category-header:hover .ht-category-caret,
      .ht-category-header:focus-within .ht-category-caret { opacity: 1; }
      @media (hover: none), (pointer: coarse) {
        .ht-category-caret { opacity: 0.65; }
      }
      .ht-category-caret.open { transform: rotate(90deg); }
      .ht-category-name {
        flex: 1 1 auto;
        min-width: 0;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: #8a7e6a;
      }
      .ht-category-streak {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        font-size: 11px;
        color: #8a7e6a;
        opacity: 0.88;
        font-variant-numeric: tabular-nums;
      }
      .ht-category-streak .ti { font-size: 11px; }
      .ht-cat-inline-check {
        display: inline-flex;
        align-items: center;
        line-height: 1;
        color: #5ad389;
        margin-right: 2px;
      }
      .ht-cat-inline-check .ti { font-size: 12px; opacity: 0.92; }
      .ht-cat-inline-check--recovered .ti { color: rgba(255, 140, 160, 0.92) !important; }
      .ht-cat-inline-check--all-done {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
        color: #ffe8c8;
      }
      .ht-cat-inline-check--all-done .ti {
        font-size: 13px;
        opacity: 1;
        background: repeating-linear-gradient(
          90deg,
          #fff8ea 0px,
          #ffe8c8 40px,
          #ffc888 80px,
          #ff9848 120px,
          #f04838 160px,
          #ff9848 200px,
          #ffc888 240px,
          #ffe8c8 280px,
          #fff8ea 320px
        );
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      .dawn-habits-list.ht-category-habits {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px 10px;
        padding: 6px 10px 12px 14px;
        align-items: start;
      }
      .dawn-habits-root.ht-habit-layout-single-col .dawn-habits-list.ht-category-habits {
        grid-template-columns: minmax(0, 1fr);
      }
      .dawn-habits-list.ht-category-habits.ht-hidden { display: none; }
      @media (max-width: 520px) {
        .dawn-habits-list.ht-category-habits {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .dawn-habits-list .ht-habit {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 6px;
        padding: 8px 8px 9px;
        margin: 0;
        border-radius: 10px;
        border: 1px solid transparent;
        background: transparent;
        cursor: pointer;
        transition: background 0.12s, border-color 0.12s;
        text-align: left;
        width: 100%;
        box-sizing: border-box;
        color: inherit;
        font: inherit;
        user-select: none;
      }
      .dawn-habits-list .ht-habit:hover {
        background: rgba(255,255,255,0.06);
        border-color: rgba(255,255,255,0.06);
      }
      .dawn-habits-list .ht-habit-top {
        display: flex;
        flex-direction: row;
        align-items: flex-start;
        gap: 8px;
        min-width: 0;
      }
      .dawn-habits-list .ht-habit-orbit {
        flex-shrink: 0;
        width: 34px;
        height: 34px;
        border-radius: 50%;
        border: 1px solid rgba(255,255,255,0.07);
        background: transparent;
        display: flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        pointer-events: none;
      }
      .dawn-habits-list .ht-habit.ht-done .ht-habit-orbit {
        border-color: rgba(255,255,255,0.12);
      }
      .dawn-habits-list .ht-habit-check-minimal {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 22px;
        min-height: 22px;
        border: none;
        background: transparent;
        color: var(--text-muted, #8a7e6a);
      }
      .dawn-habits-list .ht-habit-check-minimal .ti {
        font-size: 17px;
        line-height: 1;
      }
      .dawn-habits-list .ht-check-faint {
        opacity: 0 !important;
        transition: opacity 0.12s ease;
      }
      @media (hover: hover) and (pointer: fine) {
        .dawn-habits-list .ht-habit:not(.ht-done):hover .ht-check-faint {
          opacity: 0.38 !important;
        }
      }
      @media (hover: none) {
        .dawn-habits-list .ht-habit:not(.ht-done) .ht-check-faint {
          opacity: 0.22 !important;
        }
      }
      .dawn-habits-list .ht-habit.ht-done .ht-habit-check-minimal,
      .dawn-habits-list .ht-habit.ht-done .ht-habit-check-minimal .ti {
        color: rgba(130, 188, 156, 0.92);
      }
      .dawn-habits-list .ht-habit-num {
        font-size: 11px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        line-height: 1;
        color: #e8e0d0;
      }
      .dawn-habits-list .ht-habit-num .ht-num-tgt {
        opacity: 0.55;
        font-weight: 500;
        font-size: 9px;
      }
      .dawn-habits-list .ht-habit {
        touch-action: manipulation;
        -webkit-touch-callout: none;
      }
      .dawn-habits-list .ht-habit-name:has(.ht-num-input) {
        overflow: visible;
        text-overflow: unset;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        white-space: normal;
      }
      .ht-num-btn {
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 4px;
        color: #e8e0d0;
        font-size: 13px;
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        flex-shrink: 0;
        padding: 0;
        line-height: 1;
      }
      .ht-num-btn:hover { background: rgba(255,255,255,0.15); }
      .ht-num-fail-btn {
        font-size: 15px;
        font-weight: 700;
        color: rgba(255, 120, 120, 0.95);
        border-color: rgba(255, 120, 120, 0.35);
        width: 22px;
        height: 22px;
      }
      .ht-num-na-btn .ht-cat-na-bar {
        height: 11px;
        width: 3px;
      }
      .ht-num-input {
        width: 44px;
        padding: 2px 4px;
        background: rgba(255,255,255,0.1);
        border: 1px solid rgba(124,106,247,0.6);
        border-radius: 4px;
        color: #e8e0d0;
        font-size: 12px;
        text-align: center;
        outline: none;
      }
      .dawn-habits-list .ht-habit-name-col {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .dawn-habits-list .ht-habit-line-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-height: 18px;
        width: 100%;
        box-sizing: border-box;
      }
      .dawn-habits-list .ht-habit-streak-cluster {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .dawn-habits-list .ht-habit-streak-core {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        font-size: 11px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        line-height: 1;
      }
      .dawn-habits-list .ht-habit-streak-core .ti {
        font-size: 12px;
        line-height: 1;
      }
      .dawn-habits-list .ht-streak-day-count { font-variant-numeric: tabular-nums; }
      .ht-category-streak .ht-streak-day-count { font-variant-numeric: tabular-nums; }
      .dawn-habits-list .ht-habit-stat-counts {
        display: inline-flex;
        align-items: baseline;
        gap: 2px;
        font-size: 11px;
        color: #8a7e6a;
        font-variant-numeric: tabular-nums;
        opacity: 0.9;
      }
      .dawn-habits-list .ht-roll-num { color: inherit; font-weight: 600; }
      .dawn-habits-list .ht-roll-suffix { opacity: 0.75; font-size: 10px; }
      .dawn-habits-list .ht-roll-sep { opacity: 0.45; margin: 0 2px; }
      .dawn-habits-list .ht-habit-name,
      .dawn-habits-list .ht-habit-line-name {
        min-width: 0;
        color: inherit;
        font-size: 13px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .dawn-habits-list .ht-habit.ht-done .ht-habit-name,
      .dawn-habits-list .ht-habit.ht-done .ht-habit-line-name {
        color: #8a7e6a;
        text-decoration: line-through;
        text-decoration-color: rgba(138,126,106,0.5);
      }
      .dawn-habits-list .ht-habit-stats-link {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        margin: 0;
        padding: 0;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: #8a7e6a;
        cursor: pointer;
        opacity: 0.32;
        pointer-events: auto;
        transition: opacity 0.12s, color 0.12s, background 0.12s;
      }
      .dawn-habits-list .ht-habit-stats-link .ti { font-size: 14px; }
      @media (hover: hover) and (pointer: fine) {
        .dawn-habits-list .ht-habit-stats-link {
          opacity: 0;
          pointer-events: none;
        }
        .dawn-habits-list .ht-habit:hover .ht-habit-stats-link {
          opacity: 0.55;
          pointer-events: auto;
        }
      }
      .dawn-habits-list .ht-habit .ht-habit-stats-link:hover {
        opacity: 1;
        color: #e8e0d0;
        background: rgba(255,255,255,0.08);
      }
      .dawn-habits-empty {
        opacity: 0.7;
        font-size: 12px;
        font-style: italic;
        color: var(--text-muted, rgba(180, 172, 158, 0.85));
        text-align: center;
        padding: 12px 8px;
      }
      .ht-notes-wrap {
        margin: 10px 14px 4px;
        padding-top: 8px;
        border-top: 1px solid rgba(255, 255, 255, 0.07);
      }
      .ht-notes-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #8a7e6a;
        margin-bottom: 6px;
      }
      .ht-notes-input {
        display: block;
        width: 100%;
        box-sizing: border-box;
        min-height: 2.8em;
        max-height: 120px;
        overflow-y: auto;
        resize: vertical;
        font-family: inherit;
        font-size: 12px;
        line-height: 1.35;
        color: #e8e0d0;
        background: rgba(0, 0, 0, 0.25);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 6px;
        padding: 6px 8px;
        margin: 0;
      }
      .ht-notes-input::placeholder { color: rgba(138, 126, 106, 0.75); }
      .ht-notes-input:focus {
        outline: none;
        border-color: rgba(255, 255, 255, 0.22);
        background: rgba(0, 0, 0, 0.32);
      }
      .ht-stats-view { padding: 8px 14px 16px; }
      .ht-stats-range {
        display: flex;
        gap: 4px;
        margin-bottom: 12px;
      }
      .ht-range-btn {
        appearance: none;
        padding: 3px 10px;
        border-radius: 20px;
        border: 1px solid rgba(255,255,255,0.12);
        background: none;
        color: #8a7e6a;
        font-size: 11px;
        cursor: pointer;
        transition: all 0.15s;
        font: inherit;
      }
      .ht-range-btn.active,
      .ht-range-btn:hover {
        background: rgba(255,255,255,0.08);
        border-color: rgba(255,255,255,0.22);
        color: #e8e0d0;
      }
      .ht-stat-cards {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 8px;
        margin-bottom: 12px;
      }
      .ht-stat-card {
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.07);
        border-radius: 10px;
        padding: 10px 12px;
      }
      .ht-stat-label {
        font-size: 10px;
        color: #8a7e6a;
        margin-bottom: 4px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .ht-stat-value {
        font-size: 22px;
        font-weight: 700;
        color: #e8e0d0;
        line-height: 1;
      }
      .ht-stat-unit { font-size: 11px; color: #8a7e6a; margin-top: 2px; }
      .ht-stats-hint {
        font-size: 11px;
        color: #8a7e6a;
        opacity: 0.85;
        line-height: 1.4;
      }
      .ht-stats-select {
        width: 100%; padding: 6px 10px; margin-bottom: 14px;
        background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
        border-radius: 8px; color: #e8e0d0; font-size: 12px; outline: none; cursor: pointer;
      }
      .ht-stats-select option { background: #1c1a22; }
      .ht-stat-card.accent .ht-stat-value { color: #4caf50; }
      .ht-stat-card.fire .ht-stat-value { color: #ff9800; }
      .ht-stats-section { margin-bottom: 16px; }
      .ht-stats-section-title {
        font-size: 11px; font-weight: 600; color: #8a7e6a;
        text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px;
      }
      .ht-cal-strip { display: flex; gap: 4px; justify-content: space-between; }
      .ht-cal-strip-col {
        flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px;
      }
      .ht-cal-strip-col.today .ht-cal-strip-dow { color: #c4b8ff; font-weight: 700; }
      .ht-cal-strip-dow { font-size: 10px; color: #8a7e6a; }
      .ht-cal-strip-circle {
        width: 32px; height: 32px; border-radius: 50%;
        background: rgba(255,255,255,0.07);
        border: 1.5px solid rgba(255,255,255,0.1);
        display: flex; align-items: center; justify-content: center;
        font-size: 10px; font-weight: 600; color: #8a7e6a;
      }
      .ht-cal-strip-circle.done {
        background: rgba(76,175,80,0.25); border-color: #4caf50; color: #4caf50;
      }
      .ht-cal-strip-circle.partial {
        background: rgba(124,106,247,0.15); border-color: rgba(124,106,247,0.4); color: #c4b8ff;
      }
      .ht-cal-strip-date { font-size: 10px; color: #8a7e6a; }
      .ht-cal-strip-col.today .ht-cal-strip-date { color: #c4b8ff; }
      .ht-cal-month-nav {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 10px;
      }
      .ht-cal-nav-btn {
        appearance: none; background: none; border: none; cursor: pointer; color: #8a7e6a;
        font-size: 16px; padding: 0 6px; border-radius: 4px; line-height: 1;
      }
      .ht-cal-nav-btn:hover { color: #e8e0d0; }
      .ht-cal-month-title { font-size: 13px; font-weight: 600; color: #e8e0d0; }
      .ht-cal-dow-row {
        display: grid; grid-template-columns: repeat(7, 1fr);
        margin-bottom: 4px;
      }
      .ht-cal-dow-header {
        font-size: 10px; color: #8a7e6a; text-align: center; padding: 2px 0;
      }
      .ht-cal-grid {
        display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px;
      }
      .ht-cal-day {
        aspect-ratio: 1; display: flex; flex-direction: column;
        align-items: center; justify-content: center; border-radius: 50%;
        background: rgba(255,255,255,0.05);
        position: relative;
        max-width: 42px; max-height: 42px; margin: 0 auto; width: 100%;
      }
      .ht-cal-day.out-of-range { background: rgba(255,255,255,0.02); opacity: 0.4; }
      .ht-cal-day.empty { background: none; }
      .ht-cal-day.done {
        background: rgba(76,175,80,0.2); border: 1.5px solid rgba(76,175,80,0.5);
      }
      .ht-cal-day.partial {
        background: rgba(124,106,247,0.12); border: 1.5px solid rgba(124,106,247,0.3);
      }
      .ht-cal-day.today {
        border: 1.5px solid rgba(196,184,255,0.6) !important;
      }
      .ht-cal-day-num {
        font-size: 11px; color: #e8e0d0; font-weight: 500; line-height: 1;
      }
      .ht-cal-day.out-of-range .ht-cal-day-num { color: #8a7e6a; }
      .ht-cal-day.today .ht-cal-day-num { color: #c4b8ff; }
      .ht-cal-day-dot {
        width: 4px; height: 4px; border-radius: 50%;
        margin-top: 2px; background: transparent;
      }
      .ht-cal-day.done .ht-cal-day-dot { background: #4caf50; }
      .ht-cal-strip-circle { cursor: pointer; }
      .ht-cal-day:not(.empty):not(.out-of-range) { cursor: pointer; }
      .ht-cal-strip-circle:hover { transform: scale(1.08); background: rgba(255,255,255,0.12); }
      .ht-cal-strip-circle.done:hover { background: rgba(76,175,80,0.4) !important; }
      .ht-cal-day:hover:not(.empty):not(.out-of-range) {
        transform: scale(1.06);
        background: rgba(255,255,255,0.1);
      }
      .ht-barchart-wrap { position: relative; overflow: visible; }
      .ht-barchart {
        position: relative; height: 72px; display: flex; align-items: flex-end;
        gap: 2px; overflow: visible; margin-right: 30px;
      }
      .ht-bar-wrap {
        flex: 1; display: flex; align-items: flex-end; height: 100%;
        position: relative;
      }
      .ht-bar {
        width: 100%; border-radius: 2px 2px 0 0;
        background: rgba(124,106,247,0.22); min-height: 2px;
        transition: height 0.3s ease;
      }
      .ht-bar.done { background: rgba(76,175,80,0.38); }
      .ht-bar-wrap:hover .ht-bar-tooltip {
        opacity: 1; transform: translateX(-50%) translateY(0);
      }
      .ht-bar-tooltip {
        position: absolute; bottom: calc(100% + 4px); left: 50%;
        transform: translateX(-50%) translateY(4px);
        background: rgba(28,26,34,0.95);
        border: 1px solid rgba(255,255,255,0.15);
        color: #e8e0d0; font-size: 10px; font-weight: 600;
        padding: 2px 6px; border-radius: 4px;
        white-space: nowrap; pointer-events: none;
        opacity: 0; transition: opacity 0.15s, transform 0.15s;
        z-index: 10;
      }
      .ht-barchart-labels { display: flex; gap: 2px; margin-top: 3px; }
      .ht-bar-label-wrap { flex: 1; display: flex; justify-content: center; }
      .ht-bar-label { font-size: 8px; color: #8a7e6a; line-height: 1; }
      .ht-target-line {
        position: absolute; left: 0; right: 0; height: 1px;
        background: rgba(255,200,0,0.22); pointer-events: none;
      }
      .ht-target-label {
        position: absolute; right: -28px; font-size: 8px; color: rgba(255,200,0,0.55);
        line-height: 1; text-align: left; transform: translateY(-1px);
      }
      .dawn-habits-root.is-stats-mode .ht-date-nav { opacity: 0.45; pointer-events: none; }
      .dawn-habits-root.is-manage-mode .ht-category,
      .dawn-habits-root.is-manage-mode .ht-habit-section-ribbon,
      .dawn-habits-root.is-manage-mode .ht-cat-ribbon,
      .dawn-habits-root.is-manage-mode .dawn-habits-progress-wrap { display: none; }
      .dawn-habits-root.is-manage-mode .dawn-habits-manage-host { display: block !important; }
      .dawn-habits-list-wrap.is-hidden,
      .dawn-habits-progress-wrap.is-hidden,
      .ht-notes-wrap.is-hidden,
      .ht-stats-view.is-hidden { display: none !important; }
    `;
    document.documentElement.appendChild(el);
    this._styleEl = el;
  }

  _waitFor(pred, cb) {
    let n = 0;
    const tick = () => {
      try {
        if (pred(globalThis)) {
          cb(globalThis.BootKernel || globalThis.__dawnBoot);
          return;
        }
      } catch (_) {}
      n += 1;
      if (n > 240) {
        console.warn('[Dawn/Habits] wait timeout');
        return;
      }
      setTimeout(tick, 40);
    };
    tick();
  }

  _loadIndexFromStorage() {
    try {
      const raw = localStorage.getItem(HABITS_LS_INDEX);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.byDay && typeof parsed.byDay === 'object') {
        // Normalize: habits present ⇒ treated as hydrated.
        const byDay = parsed.byDay;
        for (const list of Object.values(byDay)) {
          for (const e of list || []) {
            if (!Array.isArray(e.habits)) continue;
            // Old caches without itemGuid can't toggle — force rehydrate.
            // Line-item caches need itemGuid to toggle. JSON completions use id only — keep those.
            const hasJsonIds = e.habits.some((h) => h?.id);
            const missingLineIds = !hasJsonIds && e.habits.some((h) => !h?.itemGuid);
            if (missingLineIds) {
              delete e.habits;
              delete e.hydrated;
            } else if (e.hydrated !== true) {
              e.hydrated = true;
            }
          }
        }
        this._index = {
          byDay,
          count: parsed.count || 0,
          builtAt: parsed.builtAt || 0,
          ms: parsed.ms || 0,
          full: parsed.full === true,
        };
      }
    } catch (_) {}
  }

  _saveIndexToStorage() {
    try {
      localStorage.setItem(
        HABITS_LS_INDEX,
        JSON.stringify({
          byDay: this._index.byDay,
          count: this._index.count,
          builtAt: this._index.builtAt,
          ms: this._index.ms,
          full: this._index.full === true,
        })
      );
    } catch (_) {}
  }

  _loadUiPrefs() {
    try {
      const raw = localStorage.getItem(HABITS_LS_UI);
      if (!raw) return;
      const p = JSON.parse(raw) || {};
      if (p.viewMode === 'stats' || p.viewMode === 'list') this._viewMode = p.viewMode;
      if (p.statsRange === 7 || p.statsRange === 30) this._statsRange = p.statsRange;
      if (typeof p.statsSelected === 'string' && p.statsSelected) {
        this._statsSelected = p.statsSelected;
      }
      this._singleCol = p.singleCol === true;
      if (p.catCollapsed && typeof p.catCollapsed === 'object') {
        this._catCollapsed = { ...p.catCollapsed };
      } else if (p.catCollapsed === true) {
        this._catCollapsed = { [HABITS_DEFAULT_CAT.id]: true };
      } else {
        this._catCollapsed = this._catCollapsed || {};
      }
      if (typeof p.activeCatId === 'string' && p.activeCatId) {
        this._activeCatId = p.activeCatId;
      }
    } catch (_) {}
  }

  _prefsMirrorKeys() {
    return [HABITS_LS_CONFIG, HABITS_LS_MARKS, HABITS_LS_VALUES, HABITS_LS_UI, HABITS_LS_DONE];
  }

  _initPathBPrefs() {
    let n = 0;
    const tick = () => {
      const api = globalThis.ThymerPluginSettings;
      if (api?.init && (api.__dawnPathBHost || !api.__pathBStub)) {
        try {
          api.init({
            plugin: this,
            pluginId: 'dawn-habits-addon',
            label: 'Habits',
            data: this.data,
            mirrorKeys: () => this._prefsMirrorKeys(),
            onHydrated: () => {
              try {
                const prevDone = this._doneByDay && typeof this._doneByDay === 'object' ? this._doneByDay : {};
                this._loadMarks();
                this._loadValues();
                this._loadUiPrefs();
                this._loadDone();
                this._doneByDay = Object.assign({}, this._doneByDay || {}, prevDone);
                this._saveDone();
                if (this._vaultConfigLoaded) {
                  try {
                    localStorage.setItem(HABITS_LS_CONFIG, JSON.stringify(this._config || {}));
                  } catch (_) {}
                  this._schedulePrefsFlush();
                } else {
                  this._loadConfig();
                  void this._loadVaultConfig();
                }
                this._paint?.();
              } catch (_) {}
            },
          });
        } catch (e) {
          console.warn('[Dawn/Habits] PathB init', e);
        }
        return;
      }
      n += 1;
      if (n > 240) return;
      setTimeout(tick, 40);
    };
    tick();
  }

  _schedulePrefsFlush() {
    try {
      const api = globalThis.ThymerPluginSettings;
      if (!api?.scheduleFlush) return;
      if (!this._pluginSettingsPluginId) {
        this._pluginSettingsPluginId = 'dawn-habits-addon';
        this._pluginSettingsSyncMode = 'synced';
      }
      api.scheduleFlush(this, () => this._prefsMirrorKeys());
    } catch (_) {}
  }

  _saveUiPrefs() {
    try {
      localStorage.setItem(
        HABITS_LS_UI,
        JSON.stringify({
          viewMode: this._viewMode,
          statsRange: this._statsRange,
          statsSelected: this._statsSelected || 'overall',
          singleCol: !!this._singleCol,
          catCollapsed: this._catCollapsed && typeof this._catCollapsed === 'object' ? this._catCollapsed : {},
          activeCatId: this._activeCatId || HABITS_DEFAULT_CAT.id,
        })
      );
    } catch (_) {}
    this._schedulePrefsFlush();
  }

  _loadNotes() {
    try {
      const raw = localStorage.getItem(HABITS_LS_NOTES);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') this._notesByDay = p;
    } catch (_) {}
  }

  _saveNotes() {
    try {
      localStorage.setItem(HABITS_LS_NOTES, JSON.stringify(this._notesByDay || {}));
    } catch (_) {}
  }

  _loadConfig() {
    try {
      let raw = localStorage.getItem(HABITS_LS_CONFIG);
      if (!raw) {
        try {
          const backup = localStorage.getItem('jhs_habit_config_backup_v1');
          if (backup) {
            const wrap = JSON.parse(backup);
            const cfg = wrap && wrap.config && typeof wrap.config === 'object' ? wrap.config : wrap;
            if (cfg && (Array.isArray(cfg.habits) ? cfg.habits.length : 0)) {
              raw = JSON.stringify(cfg);
              localStorage.setItem(HABITS_LS_CONFIG, raw);
            }
          }
        } catch (_) {}
      }
      if (!raw) return;
      const p = JSON.parse(raw);
      this._applyConfigObject(p);
    } catch (_) {}
  }

  _applyConfigObject(p) {
    if (!p || typeof p !== 'object') return false;
    const cats = Array.isArray(p.categories)
      ? p.categories.filter((c) => c && c.id && c.name)
      : [];
    const habits = Array.isArray(p.habits)
      ? p.habits.filter((h) => h && h.name).map((h) => this._normalizeHabitRow(h))
      : [];
    if (!habits.length && !cats.length) return false;
    const catsNorm = (cats.length ? cats : [{ ...HABITS_DEFAULT_CAT }]).map((c, i) => ({
      id: String(c.id),
      name: String(c.name),
      icon: String(c.icon || c.emoji || '').trim(),
      emoji: String(c.emoji || c.icon || '').trim(),
      order: Number.isFinite(Number(c.order)) ? Number(c.order) : i,
    }));
    this._vaultConfigRaw = p;
    this._config = {
      categories: catsNorm,
      habits,
      hideOffDayHabits: !!p.hideOffDayHabits,
      showDayNotes: p.showDayNotes !== false,
      habitGroupMode: String(p.habitGroupMode || 'category'),
      tagOrder: Array.isArray(p.tagOrder) ? p.tagOrder.map((t) => String(t || '').trim()).filter(Boolean) : [],
      guidedFlows: Array.isArray(p.guidedFlows) ? p.guidedFlows : [],
      recoveryInventory: Array.isArray(p.recoveryInventory) ? p.recoveryInventory : [],
      recoveryEarned:
        p.recoveryEarned && typeof p.recoveryEarned === 'object'
          ? p.recoveryEarned
          : { milestones: {}, awards: {} },
      categoryRecovered:
        p.categoryRecovered && typeof p.categoryRecovered === 'object' ? p.categoryRecovered : {},
    };
    this._normalizeRecoveryCfg(this._config);
    if (!catsNorm.some((c) => c.id === this._activeCatId)) {
      this._activeCatId = catsNorm[0].id;
    }
    return true;
  }

  _saveConfig() {
    try {
      localStorage.setItem(HABITS_LS_CONFIG, JSON.stringify(this._config || {}));
    } catch (_) {}
    this._schedulePrefsFlush();
    try {
      this._refreshQuickAccess?.();
    } catch (_) {}
    if (!this._applyingVaultConfig) this._scheduleVaultConfigFlush();
  }

  _scheduleVaultConfigFlush() {
    clearTimeout(this._configFlushTimer);
    this._configFlushTimer = setTimeout(() => {
      const boot = globalThis.BootKernel || globalThis.__dawnBoot;
      const run = () => this._persistVaultConfig();
      if (boot?.enqueue) {
        boot.enqueue(run, { id: 'habits:config-flush', tier: 'onDemand' });
      } else {
        void run();
      }
    }, 500);
  }

  _propText(record, names) {
    const keys = Array.isArray(names) ? names : [names];
    for (const k of keys) {
      try {
        const t = record.text?.(k);
        if (typeof t === 'string' && t) return t;
      } catch (_) {}
      try {
        const prop = record.prop?.(k);
        const t = (typeof prop?.text === 'function' ? prop.text() : null) || prop?.get?.();
        if (typeof t === 'string' && t) return t;
      } catch (_) {}
    }
    try {
      const props = record.getProperties?.() || {};
      if (!Array.isArray(props)) {
        for (const k of keys) {
          const raw = props[k];
          if (raw == null) continue;
          const inner = Array.isArray(raw) && raw.length >= 2 ? raw[1] : raw;
          if (typeof inner === 'string' && inner) return inner;
        }
      }
    } catch (_) {}
    return '';
  }

  _parseSettingsJson(record) {
    const named = this._propText(record, ['settings_json', 'Settings JSON', 'data']);
    const tryParse = (raw) => {
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
      if (!raw || typeof raw !== 'string') return null;
      try {
        const p = JSON.parse(raw);
        return p && typeof p === 'object' ? p : null;
      } catch (_) {
        return null;
      }
    };
    const hit = tryParse(named);
    if (hit) return hit;
    try {
      const list =
        (typeof record.getAllProperties === 'function' ? record.getAllProperties() : null) ||
        record.getProperties?.() ||
        [];
      const arr = Array.isArray(list) ? list : Object.values(list);
      for (const raw of arr) {
        let s = '';
        if (raw && typeof raw.text === 'function') {
          try {
            s = String(raw.text() || '');
          } catch (_) {}
        } else {
          const inner = Array.isArray(raw) && raw.length >= 2 ? raw[1] : raw;
          s = typeof inner === 'string' ? inner : inner && typeof inner === 'object' ? JSON.stringify(inner) : '';
        }
        const parsed = tryParse(s);
        if (parsed && (parsed.completions || parsed.habits || parsed.categories)) return parsed;
      }
    } catch (_) {}
    return null;
  }

  async _writeSettingsJson(record, obj) {
    if (!record || !obj) return false;
    const json = typeof obj === 'string' ? obj : JSON.stringify(obj);
    for (const k of ['settings_json', 'Settings JSON', 'data']) {
      try {
        const prop = record.prop?.(k);
        if (!prop) continue;
        if (typeof prop.set === 'function') {
          await prop.set(json);
          return true;
        }
        if (typeof prop.setText === 'function') {
          await prop.setText(json);
          return true;
        }
      } catch (_) {}
    }
    return false;
  }

  _isConfigRecord(record, title) {
    try {
      const g = record?.guid || record?.getGuid?.() || '';
      if (g && g === HABITS_CONFIG_GUID_PROD) return true;
    } catch (_) {}
    const kind = this._propText(record, ['record_kind', 'Record kind']);
    const pluginId = this._propText(record, ['plugin_id', 'Plugin ID']);
    const name = String(title || '').trim().toLowerCase();
    return (
      kind === 'config' ||
      pluginId === 'habit-tracker:config' ||
      name === 'config'
    );
  }

  async _loadVaultConfig() {
    if (this._vaultConfigLoaded) return true;
    const tryRec = async (g) => {
      if (!g) return false;
      try {
        const rec = await this.data.getRecord?.(g);
        if (!rec) return false;
        const title = rec.getName?.() || rec.name || '';
        return this._applyVaultConfigRecord(rec, title);
      } catch (_) {
        return false;
      }
    };
    const guids = [this._configGuid, HABITS_CONFIG_GUID_PROD];
    for (const g of guids) {
      if (await tryRec(g)) {
        this._vaultConfigLoaded = true;
        this._paint();
        return true;
      }
    }
    try {
      if (typeof this.data.searchByQuery === 'function') {
        const hits = (await this.data.searchByQuery('habit-tracker:config')) || [];
        for (const rec of hits) {
          const title = rec.getName?.() || rec.name || '';
          if (this._applyVaultConfigRecord(rec, title)) {
            this._vaultConfigLoaded = true;
            this._paint();
            return true;
          }
        }
      }
    } catch (_) {}
    return false;
  }

  async _getLogsCollection(boot) {
    const data = this.data;
    for (const g of [HABITS_COLL_GUID_PROD, HABITS_COLL_GUID]) {
      try {
        const c = await data.getCollection?.(g);
        if (c?.getAllRecords) return c;
      } catch (_) {}
    }
    try {
      const cols = boot?.getAllCollections
        ? await boot.getAllCollections(data)
        : await data.getAllCollections?.();
      for (const c of cols || []) {
        const name = c?.name || c?.getName?.() || '';
        const guid = c?.guid || c?.id || '';
        if (name === HABITS_COLL_NAME || guid === HABITS_COLL_GUID || guid === HABITS_COLL_GUID_PROD) {
          return c;
        }
      }
    } catch (_) {}
    return null;
  }

  _applyVaultConfigRecord(record, title) {
    if (!record || !this._isConfigRecord(record, title)) return false;
    try {
      const guid = record.guid || record.getGuid?.() || '';
      if (guid) this._configGuid = guid;
    } catch (_) {}
    const p = this._parseSettingsJson(record);
    if (!p) return false;
    this._applyingVaultConfig = true;
    try {
      if (!this._applyConfigObject(p)) return false;
      try {
        localStorage.setItem(HABITS_LS_CONFIG, JSON.stringify(this._config || {}));
      } catch (_) {}
      try {
        this._refreshQuickAccess?.();
      } catch (_) {}
      this._vaultConfigLoaded = true;
      this._schedulePrefsFlush();
      return true;
    } finally {
      this._applyingVaultConfig = false;
    }
  }

  async _persistVaultConfig() {
    let rec = null;
    if (this._configGuid) {
      try {
        rec = await this.data.getRecord?.(this._configGuid);
      } catch (_) {}
    }
    if (!rec) {
      try {
        const coll = await this._getLogsCollection();
        const arr = (await coll?.getAllRecords?.()) || [];
        rec = arr.find((r) => this._isConfigRecord(r, r.getName?.() || r.name)) || null;
        const g = rec?.guid || rec?.getGuid?.();
        if (g) this._configGuid = g;
      } catch (_) {}
    }
    if (!rec) return false;
    const payload = {
      ...(this._vaultConfigRaw && typeof this._vaultConfigRaw === 'object' ? this._vaultConfigRaw : {}),
      categories: (this._config.categories || []).map((c) => ({
        id: c.id,
        name: c.name,
        emoji: c.emoji || c.icon || '',
        order: c.order || 0,
      })),
      habits: (this._config.habits || []).map((h) => ({
        id: h.id,
        name: h.name,
        categoryId: h.categoryId,
        order: h.order || 0,
        target: h.target || 0,
        unit: h.unit || null,
        seedDate: h.seedDate || h.streakSeed || null,
        tags: h.tags || [],
        weekdays: h.weekdays || [],
        quickAccess: !!h.quickAccess,
        startDate: h.startDate || null,
        archived: !!h.archived,
      })),
      habitGroupMode: this._config.habitGroupMode || 'category',
      hideOffDayHabits: !!this._config.hideOffDayHabits,
      tagOrder: this._config.tagOrder || [],
      showDayNotes: this._config.showDayNotes !== false,
      guidedFlows: this._config.guidedFlows || [],
      recoveryInventory: this._config.recoveryInventory || [],
      recoveryEarned: this._config.recoveryEarned || { milestones: {}, awards: {} },
    };
    this._vaultConfigRaw = payload;
    return this._writeSettingsJson(rec, payload);
  }

  _habitIdOf(h) {
    if (h?.id) return String(h.id);
    const cfg = this._habitCfg(h?.name);
    return cfg?.id ? String(cfg.id) : '';
  }

  async _persistLogHabit(h, dayKey) {
    const key = dayKey || this._dayKey;
    const guid = h?.logGuid || this._primaryLogGuid(key);
    const id = this._habitIdOf(h);
    if (!guid || !id) return false;
    try {
      const rec = await this.data.getRecord?.(guid);
      if (!rec) return false;
      const obj = this._parseSettingsJson(rec) || { completions: {}, date: key };
      if (!obj.completions || typeof obj.completions !== 'object') obj.completions = {};
      const mark = this._habitMark(key, h.name);
      const val = this._habitValue(key, h.name);
      const cfg = this._habitCfg(h.name);
      const numeric = cfg.type === 'number' || (Number(cfg.target) || 0) > 0;
      if (mark === 'fail') obj.completions[id] = HABITS_COMP_FAIL;
      else if (mark === 'na') obj.completions[id] = HABITS_COMP_NA;
      else if (numeric) {
        const n = val > 0 ? val : h.done ? Number(cfg.target) || 0 : 0;
        if (n > 0) obj.completions[id] = n;
        else delete obj.completions[id];
      } else if (h.done) obj.completions[id] = true;
      else delete obj.completions[id];
      obj.date = key;
      return await this._writeSettingsJson(rec, obj);
    } catch (e) {
      console.warn('[Dawn/Habits] log JSON write', e);
      return false;
    }
  }

  _recoveryId() {
    return Math.random().toString(36).slice(2, 10);
  }

  _milestoneLabel(n) {
    if (n === 7) return '1 week';
    if (n === 30) return '30 days';
    if (n === 90) return '90 days';
    if (n === 365) return '1 year';
    if (n > 365 && n % 365 === 0) return `${n / 365} years`;
    return `${n} days`;
  }

  _toastRecovery(title, message) {
    try {
      this.ui.addToaster?.({ title, message, dismissible: true, autoDestroyTime: 4800 });
    } catch (_) {
      try {
        this._app?._toast?.(title, message);
      } catch (_) {}
    }
  }

  _normalizeRecoveryCfg(cfg) {
    const o = cfg && typeof cfg === 'object' ? cfg : this._config;
    if (!Array.isArray(o.recoveryInventory)) o.recoveryInventory = [];
    if (!o.recoveryEarned || typeof o.recoveryEarned !== 'object') {
      o.recoveryEarned = { milestones: {}, awards: {} };
    }
    if (!o.recoveryEarned.milestones) o.recoveryEarned.milestones = {};
    if (!o.recoveryEarned.awards) o.recoveryEarned.awards = {};
    if (!o.categoryRecovered || typeof o.categoryRecovered !== 'object') o.categoryRecovered = {};
    const now = Date.now();
    o.recoveryInventory = (o.recoveryInventory || []).filter((r) => (Number(r?.expiresAt) || 0) > now);
    return o;
  }

  _activeRecoveries(cfg) {
    const o = this._normalizeRecoveryCfg(cfg || this._config);
    return [...(o.recoveryInventory || [])].sort(
      (a, b) => (Number(a.expiresAt) || 0) - (Number(b.expiresAt) || 0)
    );
  }

  _grantRecovery(cfg, source, label) {
    const o = this._normalizeRecoveryCfg(cfg || this._config);
    const item = {
      id: this._recoveryId(),
      earnedAt: Date.now(),
      expiresAt: Date.now() + HABITS_RECOVERY_DECAY_MS,
      source: String(source || 'award'),
      label: String(label || 'Streak Recovery'),
    };
    o.recoveryInventory.push(item);
    return item;
  }

  _categoryHabitsOnDay(catId, dayKey) {
    const want = String(catId || HABITS_DEFAULT_CAT.id);
    const out = [];
    for (const e of this._dayEntries(dayKey)) {
      for (const h of e?.habits || []) {
        if (this._habitCategoryId(h.name) === want) out.push(h);
      }
    }
    return out;
  }

  _categoryRecoveredOnDay(catId, dayKey) {
    return !!(this._config.categoryRecovered?.[dayKey] || {})[catId];
  }

  _categoryTouchedOnDay(catId, dayKey) {
    if (this._categoryRecoveredOnDay(catId, dayKey)) return true;
    const habits = this._categoryHabitsOnDay(catId, dayKey);
    return habits.some((h) => h.done && !this._habitMark(dayKey, h.name));
  }

  _categoryAllDoneOnDay(catId, dayKey) {
    if (this._categoryRecoveredOnDay(catId, dayKey)) return true;
    const habits = this._categoryHabitsOnDay(catId, dayKey);
    if (!habits.length) return false;
    return habits.every((h) => h.done && !this._habitMark(dayKey, h.name));
  }

  /** Consecutive touched days *before* dayKey (prod `_categoryStreakFromMap`). Hydrated index only. */
  _categoryPriorStreak(catId, dayKey) {
    if (!catId || !dayKey) return 0;
    let n = 0;
    for (let i = 1; i < 400; i++) {
      const k = this._shiftDay(dayKey, -i);
      if (!k) break;
      if (!this._categoryHabitsOnDay(catId, k).length && !this._categoryRecoveredOnDay(catId, k)) break;
      if (!this._categoryTouchedOnDay(catId, k)) break;
      n += 1;
    }
    return n;
  }

  _categoryEffectiveStreak(catId, dayKey) {
    const prior = this._categoryPriorStreak(catId, dayKey);
    return this._categoryTouchedOnDay(catId, dayKey) ? prior + 1 : prior;
  }

  _applyCategoryRecovery(dateStr, catId) {
    if (!dateStr || !catId) return;
    this._normalizeRecoveryCfg(this._config);
    if (!this._config.categoryRecovered[dateStr] || typeof this._config.categoryRecovered[dateStr] !== 'object') {
      this._config.categoryRecovered[dateStr] = {};
    }
    this._config.categoryRecovered[dateStr][catId] = true;
    this._saveConfig();
    this._paint();
  }

  _missedRecoverableCategories(todayKey) {
    const checkDate = this._shiftDay(todayKey, -1);
    if (!checkDate) return [];
    const missed = [];
    for (const cat of this._config.categories || []) {
      if (!this._categoryHabitsOnDay(cat.id, checkDate).length) continue;
      if (this._categoryPriorStreak(cat.id, checkDate) <= 0) continue;
      if (this._categoryRecoveredOnDay(cat.id, checkDate)) continue;
      if (this._categoryTouchedOnDay(cat.id, checkDate)) continue;
      missed.push({ cat, dateStr: checkDate });
    }
    return missed;
  }

  /** Grant Deep Focus / milestone / Full Sweep from the painted index. No vault I/O. */
  _afterDaySave(dayKey) {
    const dateStr = dayKey || this._dayKey;
    if (!dateStr) return;
    const cfg = this._normalizeRecoveryCfg(this._config);
    const earned = cfg.recoveryEarned;
    let changed = false;

    for (const cat of cfg.categories || []) {
      const applying = this._categoryHabitsOnDay(cat.id, dateStr);
      if (!applying.length) continue;

      if (this._categoryAllDoneOnDay(cat.id, dateStr) && applying.length >= HABITS_DEEP_FOCUS_MIN) {
        const key = `deep_focus:${dateStr}:${cat.id}`;
        if (!earned.awards[key]) {
          this._grantRecovery(cfg, 'deep_focus', `Deep Focus — ${cat.name}`);
          earned.awards[key] = true;
          changed = true;
          this._toastRecovery(
            'Streak Recovery earned',
            `${cat.name}: Deep Focus (${applying.length} habits done).`
          );
        }
      }

      const effective = this._categoryEffectiveStreak(cat.id, dateStr);
      for (const m of HABITS_RECOVERY_MILESTONES) {
        if (effective !== m) continue;
        const mk = `${cat.id}:${m}`;
        if (earned.milestones[mk]) continue;
        earned.milestones[mk] = true;
        this._grantRecovery(cfg, `milestone_${m}`, `${cat.name} — ${this._milestoneLabel(m)}`);
        changed = true;
        this._toastRecovery('Streak Recovery earned', `${cat.name} reached ${this._milestoneLabel(m)}.`);
      }
      if (effective > 365 && effective % 365 === 0) {
        const mk = `${cat.id}:${effective}`;
        if (!earned.milestones[mk]) {
          earned.milestones[mk] = true;
          this._grantRecovery(cfg, `milestone_${effective}`, `${cat.name} — ${this._milestoneLabel(effective)}`);
          changed = true;
          this._toastRecovery(
            'Streak Recovery earned',
            `${cat.name} reached ${this._milestoneLabel(effective)}.`
          );
        }
      }
    }

    const eligible = (cfg.categories || []).filter(
      (cat) => this._categoryHabitsOnDay(cat.id, dateStr).length > 0
    );
    if (eligible.length > 0 && eligible.every((cat) => this._categoryTouchedOnDay(cat.id, dateStr))) {
      const key = `full_sweep:${dateStr}`;
      if (!earned.awards[key]) {
        this._grantRecovery(cfg, 'full_sweep', 'Full Sweep — every category');
        earned.awards[key] = true;
        changed = true;
        this._toastRecovery(
          'Streak Recovery earned',
          'Full Sweep — at least one habit in every category today.'
        );
      }
    }

    if (changed) this._saveConfig();
  }

  _loadMarks() {
    try {
      const raw = localStorage.getItem(HABITS_LS_MARKS);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') this._marksByDay = p;
    } catch (_) {}
  }

  _saveMarks() {
    try {
      localStorage.setItem(HABITS_LS_MARKS, JSON.stringify(this._marksByDay || {}));
    } catch (_) {}
    this._schedulePrefsFlush();
  }

  _loadDone() {
    try {
      const raw = localStorage.getItem(HABITS_LS_DONE);
      this._doneByDay = raw ? JSON.parse(raw) || {} : {};
    } catch (_) {
      this._doneByDay = {};
    }
  }

  _saveDone() {
    try {
      localStorage.setItem(HABITS_LS_DONE, JSON.stringify(this._doneByDay || {}));
    } catch (_) {}
    this._schedulePrefsFlush();
  }

  _loadValues() {
    try {
      const raw = localStorage.getItem(HABITS_LS_VALUES);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') this._valuesByDay = p;
    } catch (_) {}
  }

  _saveValues() {
    try {
      localStorage.setItem(HABITS_LS_VALUES, JSON.stringify(this._valuesByDay || {}));
    } catch (_) {}
    this._schedulePrefsFlush();
  }

  _normalizeHabitRow(h) {
    const target = Number(h?.target);
    const wd = Array.isArray(h?.weekdays)
      ? [...new Set(h.weekdays.map((x) => Number(x)).filter((n) => n >= 0 && n <= 6))]
      : [];
    const sd = String(h?.startDate || '').trim();
    const seed = String(h?.streakSeed || h?.streakSeedDate || h?.seedDate || '').trim();
    return {
      id: String(h?.id || '').trim() || String(h?.name || '').trim().toLowerCase().replace(/\s+/g, '-'),
      name: String(h?.name || '').trim(),
      categoryId: String(h?.categoryId || HABITS_DEFAULT_CAT.id),
      type: h?.type === 'number' || (Number.isFinite(target) && target > 0) ? 'number' : 'bool',
      target: Number.isFinite(target) && target > 0 ? Math.round(target) : 0,
      unit: String(h?.unit || '').trim(),
      icon: String(h?.icon || '').trim(),
      tags: Array.isArray(h?.tags) ? h.tags.map((t) => String(t || '').trim()).filter(Boolean) : [],
      weekdays: wd,
      startDate: /^\d{4}-\d{2}-\d{2}$/.test(sd) ? sd : '',
      seedDate: /^\d{4}-\d{2}-\d{2}$/.test(seed) ? seed : '',
      streakSeed: /^\d{4}-\d{2}-\d{2}$/.test(seed) ? seed : '',
      quickAccess: !!h?.quickAccess,
      archived: !!h?.archived,
      order: Number.isFinite(Number(h?.order)) ? Number(h.order) : 0,
    };
  }

  _habitAppliesOnDate(h, dayKey) {
    const key = String(dayKey || '').slice(0, 10);
    if (!key) return true;
    if (h?.startDate && key < h.startDate) return false;
    const wd = Array.isArray(h?.weekdays) ? h.weekdays : [];
    if (!wd.length) return true;
    const d = new Date(key + 'T12:00:00');
    if (Number.isNaN(d.getTime())) return true;
    return wd.includes(d.getDay());
  }

  _lsDone(dayKey, name) {
    const k = dayKey || this._dayKey;
    const n = String(name || '').trim();
    return !!(k && n && this._doneByDay?.[k]?.[n]);
  }

  _setLsDone(dayKey, name, done) {
    const k = dayKey || this._dayKey;
    const n = String(name || '').trim();
    if (!k || !n) return;
    if (!this._doneByDay || typeof this._doneByDay !== 'object') this._doneByDay = Object.create(null);
    if (!this._doneByDay[k]) this._doneByDay[k] = Object.create(null);
    if (done) this._doneByDay[k][n] = true;
    else delete this._doneByDay[k][n];
    this._saveDone();
  }

  _habitCfg(habitName) {
    const n = String(habitName || '').trim().toLowerCase();
    const hit = (this._config.habits || []).find(
      (h) => String(h.name || '').trim().toLowerCase() === n
    );
    return hit || { name: habitName, categoryId: HABITS_DEFAULT_CAT.id, type: 'bool', target: 0 };
  }

  _habitValue(dayKey, habitName) {
    const k = dayKey || this._dayKey;
    const n = String(habitName || '').trim();
    if (!k || !n) return 0;
    const v = Number(this._valuesByDay?.[k]?.[n]);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  _setHabitValue(dayKey, habitName, value) {
    const k = dayKey || this._dayKey;
    const n = String(habitName || '').trim();
    if (!k || !n) return;
    if (!this._valuesByDay[k] || typeof this._valuesByDay[k] !== 'object') {
      this._valuesByDay[k] = Object.create(null);
    }
    const v = Math.max(0, Math.round(Number(value) || 0));
    if (v <= 0) delete this._valuesByDay[k][n];
    else this._valuesByDay[k][n] = v;
    this._saveValues();
  }

  _habitMark(dayKey, habitName) {
    const k = dayKey || this._dayKey;
    const n = String(habitName || '').trim();
    if (!k || !n) return null;
    const m = this._marksByDay?.[k]?.[n];
    return m === 'fail' || m === 'na' ? m : null;
  }

  _setHabitMark(dayKey, habitName, mark) {
    const k = dayKey || this._dayKey;
    const n = String(habitName || '').trim();
    if (!k || !n) return;
    if (!this._marksByDay[k] || typeof this._marksByDay[k] !== 'object') {
      this._marksByDay[k] = Object.create(null);
    }
    if (mark === 'fail' || mark === 'na') this._marksByDay[k][n] = mark;
    else delete this._marksByDay[k][n];
    this._saveMarks();
  }

  _habitCategoryId(habitName) {
    const n = String(habitName || '').trim().toLowerCase();
    const hit = (this._config.habits || []).find(
      (h) => String(h.name || '').trim().toLowerCase() === n
    );
    return hit?.categoryId || HABITS_DEFAULT_CAT.id;
  }

  /** Seed config habit rows from known names (idle index / hydrate). Keeps existing category assignments. */
  _syncConfigFromHabitNames(names) {
    const list = Array.isArray(names) ? names : [];
    let changed = false;
    const byLower = new Map(
      (this._config.habits || []).map((h) => [String(h.name || '').trim().toLowerCase(), h])
    );
    for (const name of list) {
      const n = String(name || '').trim();
      if (!n) continue;
      const key = n.toLowerCase();
      if (byLower.has(key)) continue;
      const row = { name: n, categoryId: HABITS_DEFAULT_CAT.id, type: 'bool', target: 0 };
      this._config.habits.push(row);
      byLower.set(key, row);
      changed = true;
    }
    if (!(this._config.categories || []).length) {
      this._config.categories = [{ ...HABITS_DEFAULT_CAT }];
      changed = true;
    } else if (!this._config.categories.some((c) => c.id === HABITS_DEFAULT_CAT.id)) {
      // ensure default exists for uncategorized
      this._config.categories.unshift({ ...HABITS_DEFAULT_CAT });
      changed = true;
    }
    if (changed) this._saveConfig();
  }

  _openCategoryEditor() {
    try {
      document.querySelector('.dawn-habits-cat-overlay')?.remove?.();
    } catch (_) {}
    const names = new Set();
    for (const list of Object.values(this._index.byDay || {})) {
      for (const e of list || []) {
        for (const h of e.habits || []) {
          if (h?.name) names.add(String(h.name).trim());
        }
      }
    }
    for (const h of this._config.habits || []) {
      if (h?.name) names.add(String(h.name).trim());
    }
    this._syncConfigFromHabitNames([...names]);

    const draftCats = (this._config.categories || [{ ...HABITS_DEFAULT_CAT }]).map((c) => ({
      id: c.id,
      name: c.name,
    }));
    const draftAssign = Object.create(null);
    const draftType = Object.create(null);
    const draftTarget = Object.create(null);
    for (const n of names) {
      const cfg = this._habitCfg(n);
      draftAssign[n] = cfg.categoryId || HABITS_DEFAULT_CAT.id;
      draftType[n] = cfg.type === 'number' ? 'number' : 'bool';
      draftTarget[n] = cfg.target > 0 ? cfg.target : 8;
    }

    const overlay = document.createElement('div');
    overlay.className = 'dawn-habits-cat-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:16px;';
    const panel = document.createElement('div');
    panel.style.cssText =
      'width:min(420px,100%);max-height:80vh;overflow:auto;background:var(--panel-bg-color,#1c1a22);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:16px 18px;color:inherit;font:inherit;';
    panel.innerHTML =
      '<h3 style="margin:0 0 6px;font-size:16px">Habit categories</h3><p style="margin:0 0 12px;font-size:12px;color:#8a7e6a;line-height:1.4">Lab LS config (<code>dawn:habit_config_v1</code>). Ribbon appears when 2+ categories exist.</p>';

    const catList = document.createElement('div');
    panel.appendChild(catList);
    const renderCats = () => {
      catList.innerHTML = '';
      for (const c of draftCats) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:center;margin:0 0 6px';
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = c.name;
        inp.style.cssText =
          'flex:1;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(0,0,0,0.25);color:inherit;font:inherit';
        inp.addEventListener('input', () => {
          c.name = inp.value.trim() || c.name;
        });
        row.appendChild(inp);
        if (c.id !== HABITS_DEFAULT_CAT.id) {
          const rm = document.createElement('button');
          rm.type = 'button';
          rm.textContent = '×';
          rm.title = 'Remove category';
          rm.addEventListener('click', () => {
            const i = draftCats.findIndex((x) => x.id === c.id);
            if (i >= 0) draftCats.splice(i, 1);
            for (const n of Object.keys(draftAssign)) {
              if (draftAssign[n] === c.id) draftAssign[n] = HABITS_DEFAULT_CAT.id;
            }
            renderCats();
            renderHabits();
          });
          row.appendChild(rm);
        }
        catList.appendChild(row);
      }
    };

    const addRow = document.createElement('div');
    addRow.style.cssText = 'display:flex;gap:8px;margin:8px 0 14px';
    const addIn = document.createElement('input');
    addIn.type = 'text';
    addIn.placeholder = 'New category name';
    addIn.style.cssText =
      'flex:1;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(0,0,0,0.25);color:inherit;font:inherit';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = 'Add';
    addBtn.addEventListener('click', () => {
      const name = addIn.value.trim();
      if (!name) return;
      const id = 'cat_' + Date.now().toString(36);
      draftCats.push({ id, name });
      addIn.value = '';
      renderCats();
      renderHabits();
    });
    addRow.append(addIn, addBtn);
    panel.appendChild(addRow);

    const habLab = document.createElement('div');
    habLab.style.cssText =
      'font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#8a7e6a;margin:0 0 8px';
    habLab.textContent = 'Assign habits';
    panel.appendChild(habLab);
    const habHost = document.createElement('div');
    panel.appendChild(habHost);
    const renderHabits = () => {
      habHost.innerHTML = '';
      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      if (!sorted.length) {
        habHost.textContent = 'No hydrated habit names yet — expand Habits on a day first.';
        return;
      }
      for (const n of sorted) {
        const row = document.createElement('label');
        row.style.cssText =
          'display:flex;gap:8px;align-items:center;margin:0 0 6px;font-size:13px';
        const lab = document.createElement('span');
        lab.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis';
        lab.textContent = n;
        const sel = document.createElement('select');
        sel.style.cssText =
          'padding:4px 6px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(0,0,0,0.25);color:inherit;font:inherit';
        for (const c of draftCats) {
          const o = document.createElement('option');
          o.value = c.id;
          o.textContent = c.name;
          if (c.id === draftAssign[n]) o.selected = true;
          sel.appendChild(o);
        }
        sel.addEventListener('change', () => {
          draftAssign[n] = sel.value;
        });
        const typeSel = document.createElement('select');
        typeSel.style.cssText = sel.style.cssText;
        for (const [tv, tl] of [
          ['bool', 'Check'],
          ['number', 'Count'],
        ]) {
          const o = document.createElement('option');
          o.value = tv;
          o.textContent = tl;
          if (tv === draftType[n]) o.selected = true;
          typeSel.appendChild(o);
        }
        const tgt = document.createElement('input');
        tgt.type = 'number';
        tgt.min = '1';
        tgt.max = '99';
        tgt.value = String(draftTarget[n] || 8);
        tgt.title = 'Target count';
        tgt.style.cssText =
          'width:52px;padding:4px 6px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(0,0,0,0.25);color:inherit;font:inherit';
        tgt.style.display = draftType[n] === 'number' ? '' : 'none';
        typeSel.addEventListener('change', () => {
          draftType[n] = typeSel.value === 'number' ? 'number' : 'bool';
          tgt.style.display = draftType[n] === 'number' ? '' : 'none';
        });
        tgt.addEventListener('input', () => {
          const v = parseInt(tgt.value, 10);
          draftTarget[n] = Number.isFinite(v) && v > 0 ? v : 8;
        });
        row.append(lab, sel, typeSel, tgt);
        habHost.appendChild(row);
      }
    };
    renderCats();
    renderHabits();

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:16px';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => overlay.remove());
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Save';
    save.addEventListener('click', () => {
      if (!draftCats.some((c) => c.id === HABITS_DEFAULT_CAT.id)) {
        draftCats.unshift({ ...HABITS_DEFAULT_CAT });
      }
      this._config.categories = draftCats.map((c) => ({
        id: c.id,
        name: String(c.name || 'Category').trim() || 'Category',
      }));
      this._config.habits = Object.keys(draftAssign).map((name) => ({
        name,
        categoryId: draftAssign[name] || HABITS_DEFAULT_CAT.id,
        type: draftType[name] === 'number' ? 'number' : 'bool',
        target:
          draftType[name] === 'number'
            ? Math.max(1, Number(draftTarget[name]) || 8)
            : 0,
      }));
      if (!this._config.categories.some((c) => c.id === this._activeCatId)) {
        this._activeCatId = this._config.categories[0].id;
      }
      this._saveConfig();
      this._saveUiPrefs();
      overlay.remove();
      this._paint();
    });
    actions.append(cancel, save);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.documentElement.appendChild(overlay);
  }

  _readNotesProp(record) {
    if (!record) return '';
    try {
      const prop = record.prop?.(HABITS_NOTES_PROP);
      if (prop) {
        if (typeof prop.text === 'function') {
          const t = String(prop.text() || '');
          if (t) return t;
        }
        const v = prop.get?.();
        if (v != null && String(v)) return String(v);
      }
    } catch (_) {}
    try {
      const obj = this._parseSettingsJson(record);
      if (obj && typeof obj.notes === 'string') return obj.notes;
    } catch (_) {}
    return '';
  }

  async _writeNotesProp(logGuid, text) {
    if (!logGuid) return false;
    try {
      const rec = await this.data.getRecord?.(logGuid);
      if (!rec) return false;
      const prop = rec.prop?.(HABITS_NOTES_PROP);
      if (prop && typeof prop.set === 'function') {
        await prop.set(String(text || ''));
        return true;
      }
      if (prop && typeof prop.setText === 'function') {
        await prop.setText(String(text || ''));
        return true;
      }
      const obj = this._parseSettingsJson(rec) || { completions: {} };
      obj.notes = String(text || '');
      return await this._writeSettingsJson(rec, obj);
    } catch (e) {
      console.warn('[Dawn/Habits] notes write', e);
    }
    return false;
  }

  _primaryLogGuid(dayKey) {
    const entries = this._dayEntries(dayKey);
    return entries?.[0]?.guid || '';
  }

  _isHabitsTabExpanded() {
    try {
      const shell = globalThis.__dawnJhsShell;
      return !!(shell?.isExpanded?.() && shell?.getActiveTab?.() === 'habits');
    } catch (_) {
      return false;
    }
  }

  _dayHasLocalMarks(dayKey) {
    const k = dayKey || this._dayKey;
    if (!k) return false;
    const done = this._doneByDay?.[k];
    const marks = this._marksByDay?.[k];
    const vals = this._valuesByDay?.[k];
    if (done && Object.keys(done).length) return true;
    if (marks && Object.keys(marks).length) return true;
    if (vals && Object.keys(vals).length) return true;
    return false;
  }

  _completionsFromLocal(dayKey) {
    const key = dayKey || this._dayKey;
    const completions = {};
    for (const h of this._config.habits || []) {
      const id = String(h.id || '').trim();
      if (!id) continue;
      const mark = this._habitMark(key, h.name);
      const numeric = h.type === 'number' || (Number(h.target) || 0) > 0;
      if (mark === 'fail') completions[id] = HABITS_COMP_FAIL;
      else if (mark === 'na') completions[id] = HABITS_COMP_NA;
      else if (numeric) {
        const n = this._habitValue(key, h.name);
        if (n > 0) completions[id] = n;
      } else if (this._lsDone(key, h.name)) {
        completions[id] = true;
      }
    }
    return completions;
  }

  _attachLogToIndex(dayKey, guid, title, habits) {
    if (!dayKey || !guid) return;
    if (!this._index) this._index = { byDay: {}, count: 0, builtAt: 0, ms: 0, full: false };
    if (!this._index.byDay) this._index.byDay = {};
    if (this._logMiss) delete this._logMiss[dayKey];
    const list = this._index.byDay[dayKey] || [];
    let entry = list.find((e) => e && e.guid === guid);
    if (!entry) {
      entry = { guid, title: String(title || dayKey).slice(0, 80) };
      list.push(entry);
      this._index.byDay[dayKey] = list;
      if (!this._index.full) this._index.count = Object.keys(this._index.byDay).length;
    }
    if (Array.isArray(habits)) {
      entry.habits = habits;
      entry.hydrated = true;
    }
    this._saveIndexToStorage();
  }

  async _setRecordText(record, keys, value) {
    if (!record || value == null) return false;
    const names = Array.isArray(keys) ? keys : [keys];
    for (const k of names) {
      try {
        const prop = record.prop?.(k);
        if (!prop) continue;
        if (typeof prop.set === 'function') {
          await prop.set(value);
          return true;
        }
        if (typeof prop.setText === 'function') {
          await prop.setText(value);
          return true;
        }
      } catch (_) {}
    }
    return false;
  }

  async _applyLogRowMeta(record, { pluginId, kind }) {
    await this._setRecordText(record, ['plugin_id', 'Plugin ID'], pluginId);
    await this._setRecordText(record, ['record_kind', 'Record kind'], kind);
    try {
      const p = record.prop?.('plugin') || record.prop?.('Plugin');
      if (p && typeof p.setChoice === 'function') {
        if (p.setChoice('Habit Tracker')) return;
        if (p.setChoice('habit-tracker')) return;
      }
      if (p?.set) p.set('habit-tracker');
    } catch (_) {}
  }

  async _ensureDayLog(dayKey) {
    const key = dayKey || this._dayKey;
    if (!key) return '';
    const have = this._primaryLogGuid(key);
    if (have) return have;
    if (!this._ensuringLog) this._ensuringLog = Object.create(null);
    if (this._ensuringLog[key]) return this._ensuringLog[key];
    this._ensuringLog[key] = this._createDayLog(key);
    try {
      return await this._ensuringLog[key];
    } finally {
      delete this._ensuringLog[key];
    }
  }

  async _createDayLog(dayKey) {
    const key = dayKey;
    const pluginId = 'habit-tracker:log:' + key;
    const boot = globalThis.BootKernel || globalThis.__dawnBoot;
    const coll = await this._getLogsCollection(boot);
    if (!coll?.createRecord) {
      console.warn('[Dawn/Habits] cannot create day log — no Habit Logs collection');
      return '';
    }
    let guid = '';
    try {
      guid = coll.createRecord(key);
    } catch (e) {
      console.warn('[Dawn/Habits] create day log', e);
      return '';
    }
    if (!guid) return '';
    let rec = null;
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, i < 6 ? 40 : 90));
      try {
        rec = await this.data.getRecord?.(guid);
      } catch (_) {
        rec = null;
      }
      if (rec) break;
    }
    const completions = this._completionsFromLocal(key);
    const doc = {
      date: key,
      completions,
      notes: this._notesByDay?.[key] || '',
      categoryDone: {},
    };
    if (rec) {
      await this._applyLogRowMeta(rec, { pluginId, kind: 'log' });
      await this._writeSettingsJson(rec, doc);
    }
    const habits = [];
    for (const [id, raw] of Object.entries(completions)) {
      const row = this._habitFromCompletion(id, raw, key);
      if (row) habits.push(row);
    }
    this._attachLogToIndex(key, guid, key, habits);
    return guid;
  }

  async _hydrateNotesForDay(dayKey) {
    const guid = this._primaryLogGuid(dayKey);
    if (!guid) return;
    try {
      const rec = await this.data.getRecord?.(guid);
      const fromVault = this._readNotesProp(rec);
      // Prefer vault when present; keep LS as offline fallback.
      if (fromVault || !(dayKey in this._notesByDay)) {
        this._notesByDay[dayKey] = fromVault;
        this._saveNotes();
      }
      if (this._notesInputEl && this._dayKey === dayKey) {
        const note = this._notesByDay[dayKey] || '';
        if (this._notesInputEl.value !== note) this._notesInputEl.value = note;
      }
    } catch (_) {}
  }

  _schedulePersistNotes(dayKey, text) {
    if (!dayKey) return;
    this._notesByDay[dayKey] = text;
    this._saveNotes();
    clearTimeout(this._notesTimer);
    this._notesTimer = setTimeout(() => {
      const boot = globalThis.BootKernel || globalThis.__dawnBoot;
      const run = () => this._persistNotesToLog(dayKey, text);
      if (boot?.enqueue) {
        boot.enqueue(run, { id: 'habits:notes-' + dayKey, tier: 'onDemand' });
      } else {
        void run();
      }
    }, 450);
  }

  async _persistNotesToLog(dayKey, text) {
    if (!dayKey) return;
    // Ensure day hydrated so we know the log guid.
    await this._hydrateDay(dayKey);
    const guid = this._primaryLogGuid(dayKey);
    if (!guid) return;
    const ok = await this._writeNotesProp(guid, text);
    if (!ok) {
      console.warn('[Dawn/Habits] Notes property write skipped — LS fallback kept');
    }
  }

  _mount(el) {
    this._root = el;
    el.innerHTML = '';
    el.className = 'dawn-habits-root';
    el.style.cssText = '';
    if (!this._catCollapsed || typeof this._catCollapsed !== 'object') this._catCollapsed = {};

    const status = document.createElement('div');
    status.className = 'dawn-habits-status';
    this._statusEl = status;

    const header = document.createElement('div');
    header.className = 'dawn-habits-header ht-sidebar-header';

    const dateNav = document.createElement('div');
    dateNav.className = 'jhs-panel-date-nav';
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'ht-nav-btn';
    prevBtn.title = 'Previous day';
    prevBtn.setAttribute('aria-label', 'Previous day');
    prevBtn.innerHTML = '<i class="ti ti-chevron-left" aria-hidden="true"></i>';
    prevBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._nudgeHabitDay(-1);
    });
    const dateLabel = document.createElement('div');
    dateLabel.className = 'ht-date-label dawn-habits-date-label';
    this._dateLabelEl = dateLabel;
    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'ht-nav-btn';
    nextBtn.title = 'Next day';
    nextBtn.setAttribute('aria-label', 'Next day');
    nextBtn.innerHTML = '<i class="ti ti-chevron-right" aria-hidden="true"></i>';
    nextBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._nudgeHabitDay(1);
    });
    dateNav.append(prevBtn, dateLabel, nextBtn);

    const catExpandBtn = document.createElement('button');
    catExpandBtn.type = 'button';
    catExpandBtn.className = 'ht-nav-btn ht-cat-expand-toggle';
    catExpandBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const cats = this._config?.categories || [];
      if (!cats.length) return;
      const anyExpanded = cats.some((c) => !this._isCatCollapsed(c.id));
      this._setAllCatsCollapsed(anyExpanded);
    });
    this._catExpandBtn = catExpandBtn;

    const doneMeta = document.createElement('div');
    doneMeta.className = 'dawn-habits-done-meta';
    this._doneMetaEl = doneMeta;

    const layoutBtn = document.createElement('button');
    layoutBtn.type = 'button';
    layoutBtn.className = 'ht-layout-btn';
    layoutBtn.title = 'Use single-column layout';
    layoutBtn.setAttribute('aria-label', 'Toggle habit layout');
    layoutBtn.innerHTML = '<i class="ti ti-layout-list" aria-hidden="true"></i>';
    layoutBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._singleCol = !this._singleCol;
      this._saveUiPrefs();
      this._syncLayout();
    });
    this._singleColBtn = layoutBtn;

    const statsBtn = document.createElement('button');
    statsBtn.type = 'button';
    statsBtn.className = 'ht-stats-btn';
    statsBtn.title = 'View stats';
    statsBtn.innerHTML = '<i class="ti ti-chart-bar" aria-hidden="true"></i>';
    statsBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._viewMode = this._viewMode === 'stats' ? 'list' : 'stats';
      this._saveUiPrefs();
      this._paint();
    });
    this._statsBtn = statsBtn;

    header.appendChild(dateNav);
    header.appendChild(catExpandBtn);
    header.appendChild(doneMeta);
    header.appendChild(layoutBtn);
    header.appendChild(statsBtn);

    const progressWrap = document.createElement('div');
    progressWrap.className = 'dawn-habits-progress-wrap';
    const progress = document.createElement('div');
    progress.className = 'ht-progress jhs-segment-bar';
    progress.setAttribute('aria-hidden', 'true');
    this._progressEl = progress;
    progressWrap.appendChild(progress);
    this._progressWrapEl = progressWrap;

    const ribbon = document.createElement('div');
    ribbon.className = 'ht-habit-section-ribbon';
    ribbon.hidden = true;
    this._ribbonEl = ribbon;

    const headerStack = document.createElement('div');
    headerStack.className = 'ht-header-stack';
    headerStack.append(header, ribbon);

    const listWrap = document.createElement('div');
    listWrap.className = 'dawn-habits-list-wrap';
    this._listWrapEl = listWrap;
    // Manage mode paints into this host; board sections rebuild into listWrap.
    const manageHost = document.createElement('div');
    manageHost.className = 'dawn-habits-list ht-category-habits dawn-habits-manage-host';
    manageHost.style.display = 'none';
    this._listEl = manageHost;
    listWrap.appendChild(manageHost);
    this._iconStripEl = null;
    this._catCaretEl = null;
    this._catLeadEl = null;
    this._catNameEl = null;
    this._catStreakEl = null;

    const notes = document.createElement('div');
    notes.className = 'ht-notes-wrap';
    const notesLabel = document.createElement('div');
    notesLabel.className = 'ht-notes-label';
    notesLabel.textContent = 'Notes';
    const notesInput = document.createElement('textarea');
    notesInput.className = 'ht-notes-input';
    notesInput.rows = 2;
    notesInput.placeholder = 'Notes for this day…';
    notesInput.setAttribute('spellcheck', 'true');
    notesInput.addEventListener('input', () => {
      const k = this._dayKey;
      if (!k) return;
      this._schedulePersistNotes(k, notesInput.value);
    });
    notesInput.addEventListener('blur', () => {
      const k = this._dayKey;
      if (!k) return;
      this._schedulePersistNotes(k, notesInput.value);
    });
    notes.appendChild(notesLabel);
    notes.appendChild(notesInput);
    this._notesWrapEl = notes;
    this._notesInputEl = notesInput;

    const statsView = document.createElement('div');
    statsView.className = 'ht-stats-view is-hidden';
    this._statsViewEl = statsView;

    el.appendChild(status);
    el.appendChild(headerStack);
    el.appendChild(progressWrap);
    el.appendChild(listWrap);
    el.appendChild(notes);
    el.appendChild(statsView);

    this._syncLayout();
    const shell = globalThis.__dawnJhsShell;
    this._onDay(shell?.getDay?.() || null, { dayKey: shell?.getDayKey?.() || null, gen: 0 });
    this._paint();
  }

  _syncLayout() {
    if (this._root) {
      this._root.classList.toggle('ht-habit-layout-single-col', !!this._singleCol);
    }
    if (this._singleColBtn) {
      this._singleColBtn.classList.toggle('active', !!this._singleCol);
      this._singleColBtn.title = this._singleCol
        ? 'Use two-column layout'
        : 'Use single-column layout';
      this._singleColBtn.setAttribute('aria-label', this._singleColBtn.title);
      const icon = this._singleColBtn.querySelector('.ti');
      if (icon) {
        icon.className = 'ti ' + (this._singleCol ? 'ti-columns' : 'ti-layout-list');
        icon.setAttribute('aria-hidden', 'true');
      }
    }
  }

  _syncCatCollapse() {
    /* Per-section collapse is applied in _paintBoardSections. */
  }

  _isCatCollapsed(catId) {
    if (!this._catCollapsed || typeof this._catCollapsed !== 'object') return false;
    return !!this._catCollapsed[catId];
  }

  _setCatCollapsed(catId, on) {
    if (!catId) return;
    if (!this._catCollapsed || typeof this._catCollapsed !== 'object') this._catCollapsed = {};
    if (on) this._catCollapsed[catId] = true;
    else delete this._catCollapsed[catId];
    this._saveUiPrefs();
  }

  _setAllCatsCollapsed(collapsed) {
    const cats = this._config?.categories || [];
    if (!cats.length) return;
    if (!this._catCollapsed || typeof this._catCollapsed !== 'object') this._catCollapsed = {};
    for (const cat of cats) {
      if (!cat?.id) continue;
      if (collapsed) this._catCollapsed[cat.id] = true;
      else delete this._catCollapsed[cat.id];
    }
    this._saveUiPrefs();
    this._paint();
  }

  _syncCatExpandToggle() {
    const btn = this._catExpandBtn;
    if (!btn) return;
    const cats = this._config?.categories || [];
    if (!cats.length) {
      btn.style.display = 'none';
      return;
    }
    btn.style.display = '';
    const anyExpanded = cats.some((c) => !this._isCatCollapsed(c.id));
    btn.innerHTML = anyExpanded
      ? '<i class="ti ti-chevron-up" aria-hidden="true"></i>'
      : '<i class="ti ti-chevron-down" aria-hidden="true"></i>';
    btn.title = anyExpanded ? 'Collapse all categories' : 'Expand all categories';
    btn.setAttribute('aria-label', btn.title);
  }

  _shiftDay(iso, delta) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + delta);
    return (
      dt.getFullYear() +
      '-' +
      String(dt.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(dt.getDate()).padStart(2, '0')
    );
  }

  _nudgeHabitDay(delta) {
    const t = new Date();
    const today =
      t.getFullYear() +
      '-' +
      String(t.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(t.getDate()).padStart(2, '0');
    const cur = this._dayKey || today;
    const next = this._shiftDay(cur, delta);
    if (!next) return;
    this._dayKey = next;
    this._paint();
    void this._hydrateDay(next);
    if (!this._index.full) {
      const boot = globalThis.BootKernel || globalThis.__dawnBoot;
      void this._runIdleIndex(boot, !!boot?.isMobile?.());
    }
  }

  _habitRollCounts(habitName, dayKey) {
    const name = String(habitName || '').trim().toLowerCase();
    if (!name || !dayKey) return { d7: 0, d30: 0 };
    let d7 = 0;
    let d30 = 0;
    for (let i = 0; i < 30; i++) {
      const k = this._shiftDay(dayKey, -i);
      if (!k) break;
      const entries = this._dayEntries(k);
      let done = false;
      for (const e of entries) {
        for (const h of e?.habits || []) {
          if (String(h.name || '').trim().toLowerCase() === name && h.done) {
            done = true;
            break;
          }
        }
        if (done) break;
      }
      if (done) {
        d30 += 1;
        if (i < 7) d7 += 1;
      }
    }
    return { d7, d30 };
  }

  _overallStats(dayKey, rangeDays) {
    let checks = 0;
    let slots = 0;
    let daysWithLog = 0;
    for (let i = 0; i < rangeDays; i++) {
      const k = this._shiftDay(dayKey, -i);
      if (!k) break;
      const entries = this._dayEntries(k);
      let daySlots = 0;
      let dayDone = 0;
      for (const e of entries) {
        for (const h of e?.habits || []) {
          daySlots += 1;
          if (h.done) dayDone += 1;
        }
      }
      if (daySlots) {
        daysWithLog += 1;
        slots += daySlots;
        checks += dayDone;
      }
    }
    const rate = slots ? Math.round((checks / slots) * 100) : 0;
    return { checks, slots, daysWithLog, rate };
  }

  _collectHabitNames(dayKey, rangeDays) {
    const names = new Map(); // lower -> display
    const push = (raw) => {
      const t = String(raw || '').trim();
      if (!t) return;
      const k = t.toLowerCase();
      if (!names.has(k)) names.set(k, t);
    };
    for (let i = 0; i < Math.max(1, rangeDays || 1); i++) {
      const k = this._shiftDay(dayKey, -i);
      if (!k) break;
      for (const e of this._dayEntries(k)) {
        for (const h of e?.habits || []) push(h.name);
      }
    }
    return Array.from(names.values()).sort((a, b) => a.localeCompare(b));
  }

  _habitDayState(habitName, dayKey) {
    const name = String(habitName || '').trim().toLowerCase();
    if (!name || !dayKey) return { seen: false, done: false };
    let seen = false;
    let done = false;
    for (const e of this._dayEntries(dayKey)) {
      for (const h of e?.habits || []) {
        if (String(h.name || '').trim().toLowerCase() !== name) continue;
        seen = true;
        if (h.done) done = true;
      }
    }
    return { seen, done };
  }

  _habitBestStreak(habitName, dayKey, lookback) {
    const name = String(habitName || '').trim().toLowerCase();
    if (!name || !dayKey) return 0;
    let best = 0;
    let cur = 0;
    for (let i = lookback - 1; i >= 0; i--) {
      const k = this._shiftDay(dayKey, -i);
      if (!k) continue;
      const st = this._habitDayState(name, k);
      if (st.seen && st.done) {
        cur += 1;
        if (cur > best) best = cur;
      } else if (st.seen) {
        cur = 0;
      }
      // Unhydrated / no entry: break continuity without resetting best.
      else {
        cur = 0;
      }
    }
    return best;
  }

  _habitRangeStats(habitName, dayKey, rangeDays) {
    let daysWith = 0;
    let daysDone = 0;
    for (let i = 0; i < rangeDays; i++) {
      const k = this._shiftDay(dayKey, -i);
      if (!k) break;
      const st = this._habitDayState(habitName, k);
      if (!st.seen) continue;
      daysWith += 1;
      if (st.done) daysDone += 1;
    }
    const rate = daysWith ? Math.round((daysDone / daysWith) * 100) : 0;
    return {
      daysWith,
      daysDone,
      rate,
      streak: this._habitConsecutiveStreak(habitName, dayKey),
      best: this._habitBestStreak(habitName, dayKey, Math.max(rangeDays, 60)),
    };
  }

  _scheduleHydrateRange(dayKey, rangeDays) {
    if (!dayKey) return;
    const keys = [];
    for (let i = 0; i < rangeDays; i++) {
      const k = this._shiftDay(dayKey, -i);
      if (!k) break;
      const entries = this._dayEntries(k);
      if (this._needsHydrate(k)) keys.push(k);
    }
    if (!keys.length) return;
    const boot = globalThis.BootKernel || globalThis.__dawnBoot;
    const run = async () => {
      for (const k of keys) {
        if (this._dayKey !== dayKey && this._viewMode === 'stats') {
          // Still hydrate if user stayed in stats on same anchor; abort if day flipped away from request.
        }
        await this._hydrateDay(k);
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    if (boot?.enqueue) {
      boot.enqueue(() => run(), {
        id: 'habits:hydrate-range-' + dayKey + '-' + rangeDays,
        tier: 'onDemand',
      });
    } else {
      void run();
    }
  }

  _enterHabitStats(habitName) {
    const name = String(habitName || '').trim();
    if (!name) return;
    this._viewMode = 'stats';
    this._statsSelected = 'habit:' + name;
    this._saveUiPrefs();
    this._paint();
  }

  _overallDayDone(dayKey) {
    let slots = 0;
    let done = 0;
    for (const e of this._dayEntries(dayKey)) {
      for (const h of e?.habits || []) {
        slots += 1;
        if (h.done) done += 1;
      }
    }
    return { seen: slots > 0, done: slots > 0 && done >= slots, partial: slots > 0 && done > 0 && done < slots };
  }

  _formatDayLabel(key) {
    if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return key || '—';
    try {
      const today = new Date();
      const tkey =
        today.getFullYear() +
        '-' +
        String(today.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(today.getDate()).padStart(2, '0');
      if (key === tkey) return 'Today';
      const d = new Date(key + 'T12:00:00');
      if (Number.isNaN(d.getTime())) return key;
      const opts = { month: 'short', day: 'numeric' };
      if (key.slice(0, 4) !== tkey.slice(0, 4)) opts.year = 'numeric';
      return d.toLocaleDateString(undefined, opts);
    } catch (_) {
      return key;
    }
  }

  _streakTierSolid(dayCount) {
    const d = Math.max(0, Math.floor(Number(dayCount) || 0));
    if (d <= 0) return 'rgba(150, 158, 178, 0.55)';
    const t = Math.min(1, d / 364);
    const u = Math.pow(t, 0.5);
    const h = 168 - u * 158;
    const s = 10 + u * 48;
    const l = 59 - u * 11;
    const a = 0.66 + u * 0.26;
    return (
      'hsla(' +
      Math.round(h) +
      ', ' +
      Math.round(s) +
      '%, ' +
      Math.round(l) +
      '%, ' +
      a.toFixed(2) +
      ')'
    );
  }

  _habitDoneOnDay(habitName, dayKey) {
    const name = String(habitName || '').trim().toLowerCase();
    if (!name || !dayKey) return false;
    for (const e of this._dayEntries(dayKey)) {
      for (const h of e?.habits || []) {
        if (String(h.name || '').trim().toLowerCase() === name && h.done) return true;
      }
    }
    return false;
  }

  _habitConsecutiveStreak(habitName, dayKey) {
    if (!habitName || !dayKey) return 0;
    let n = 0;
    const name = String(habitName).trim().toLowerCase();
    for (let i = 0; i < 120; i++) {
      const k = this._shiftDay(dayKey, -i);
      if (!k) break;
      const mark = this._habitMark(k, habitName);
      if (mark) break;
      let seen = false;
      let done = this._lsDone(k, habitName);
      const entries = this._dayEntries(k);
      for (const e of entries) {
        for (const h of e?.habits || []) {
          if (String(h.name || '').trim().toLowerCase() !== name) continue;
          seen = true;
          if (h.done) done = true;
        }
      }
      const cfg = this._habitCfg(habitName);
      if (!seen && !done && !(this._config.habits || []).some((h) => String(h.name || '').trim().toLowerCase() === name && !h.archived)) {
        break;
      }
      if (cfg.type === 'number') {
        const target = Math.max(1, Number(cfg.target) || 8);
        if (this._habitValue(k, habitName) >= target) done = true;
      }
      if (!done) break;
      n += 1;
    }
    return n;
  }

  _categoryAllDoneStreak(dayKey) {
    if (!dayKey) return 0;
    let n = 0;
    for (let i = 0; i < 400; i++) {
      const k = this._shiftDay(dayKey, -i);
      if (!k) break;
      const habits = [];
      for (const e of this._dayEntries(k)) {
        for (const h of e?.habits || []) habits.push(h);
      }
      if (!habits.length) break;
      if (!habits.every((h) => h.done)) break;
      n += 1;
    }
    return n;
  }

  _streakCoreHtml(days) {
    const d = Math.max(0, Math.floor(Number(days) || 0));
    if (!d) return '';
    const c = this._streakTierSolid(Math.min(d, 364));
    return (
      '<span class="ht-habit-streak-core" style="color:' +
      c +
      '"><i class="ti ti-flame" aria-hidden="true"></i><span class="ht-streak-day-count">' +
      d +
      'd</span></span>'
    );
  }

  _progressFillColor(kind) {
    switch (kind) {
      case 'done':
        return 'rgba(30, 92, 53, 0.95)';
      case 'partial':
        return 'rgba(72, 150, 112, 0.62)';
      case 'fail':
        return 'rgba(229, 115, 115, 0.92)';
      case 'na':
        return 'rgba(200, 165, 72, 0.82)';
      default:
        return 'rgba(255,255,255,0.08)';
    }
  }

  _groupedProgressGradient(segments, blendPct = 3.5) {
    const list = Array.isArray(segments) ? segments : [];
    const total = list.length;
    if (!total) return null;
    const groupOrder = ['done', 'partial', 'na', 'fail'];
    const chunks = [];
    let leftPct = 0;
    for (const kind of groupOrder) {
      const count = list.filter((s) => s === kind).length;
      if (!count) continue;
      const widthPct = (count / total) * 100;
      chunks.push({ kind, left: leftPct, width: widthPct });
      leftPct += widthPct;
    }
    const emptyCount = list.filter((s) => s === 'empty').length;
    if (emptyCount) chunks.push({ kind: 'empty', left: leftPct, width: (emptyCount / total) * 100 });
    if (!chunks.length) return null;
    if (chunks.length === 1) return this._progressFillColor(chunks[0].kind);

    const stops = [];
    const clampPct = (pct) => Math.max(0, Math.min(100, pct));
    const pushStop = (color, pct) => {
      stops.push({ p: clampPct(pct), color });
    };
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const start = c.left;
      const end = c.left + c.width;
      const color = this._progressFillColor(c.kind);
      if (i === 0) pushStop(color, start);
      if (i > 0) {
        const prev = chunks[i - 1];
        const prevColor = this._progressFillColor(prev.kind);
        const half = Math.min(blendPct, c.width * 0.42, prev.width * 0.42);
        pushStop(prevColor, start - half);
        pushStop(color, start + half);
      }
      if (i === chunks.length - 1) {
        pushStop(color, end);
      } else {
        const next = chunks[i + 1];
        const half = Math.min(blendPct, c.width * 0.42, next.width * 0.42);
        pushStop(color, end - half);
      }
    }
    stops.sort((a, b) => a.p - b.p);
    const merged = [];
    for (const s of stops) {
      const prev = merged[merged.length - 1];
      if (prev && Math.abs(prev.p - s.p) < 0.001) merged[merged.length - 1] = s;
      else merged.push(s);
    }
    return 'linear-gradient(90deg, ' + merged.map((s) => `${s.color} ${s.p.toFixed(2)}%`).join(', ') + ')';
  }

  _categoryProgressSegments(cats, habitsAll, dayKey) {
    const segments = [];
    let allCategoriesAllDone = true;
    let hasEligible = false;
    for (const cat of cats || []) {
      const inCat = (habitsAll || []).filter((h) => this._habitCategoryId(h.name) === cat.id);
      const applying = inCat.filter((h) => this._habitAppliesOnDate(h, dayKey));
      if (!applying.length) continue;
      hasEligible = true;
      const status = this._categoryDayAggStatus(applying, dayKey);
      if (status === 'all_done') segments.push('done');
      else if (status === 'fail') segments.push('fail');
      else if (status === 'na') segments.push('na');
      else if (status === 'partial') segments.push('partial');
      else segments.push('empty');
      if (status !== 'all_done') allCategoriesAllDone = false;
    }
    if (!hasEligible) allCategoriesAllDone = false;
    return { segments, sherbet: !!(allCategoriesAllDone && hasEligible) };
  }

  _paintProgress(cats, habitsAll, dayKey) {
    const bar = this._progressEl;
    if (!bar) return;
    const { segments, sherbet } = this._categoryProgressSegments(cats, habitsAll, dayKey);
    bar.innerHTML = '';
    bar.classList.toggle('is-sherbet', !!sherbet);
    if (!segments.length) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'block';
    if (sherbet) {
      const fill = document.createElement('span');
      fill.className = 'jhs-fill is-sherbet-full';
      fill.style.left = '0';
      fill.style.width = '100%';
      bar.appendChild(fill);
      return;
    }
    const gradient = this._groupedProgressGradient(segments);
    if (!gradient) return;
    const fill = document.createElement('span');
    fill.className = 'jhs-fill is-segment-gradient';
    fill.style.background = gradient;
    bar.appendChild(fill);
  }

  _onExpand(expanded) {
    if (!expanded) return;
    this._paint();
    if (this._dayKey) void this._hydrateDay(this._dayKey);
    const boot = globalThis.BootKernel || globalThis.__dawnBoot;
    const prep = async () => {
      await this._loadVaultConfig();
      if (!this._primaryLogGuid(this._dayKey) && this._dayHasLocalMarks(this._dayKey)) {
        await this._ensureDayLog(this._dayKey);
      }
      this._scheduleHydrateDay(this._dayKey);
      await this._hydrateNotesForDay(this._dayKey);
    };
    if (boot?.enqueue) {
      boot.enqueue(prep, { id: 'habits:expand-config', tier: 'onDemand' });
    } else {
      void prep();
    }
    const age = Date.now() - (this._index.builtAt || 0);
    if (!this._index.full || age > HABITS_INDEX_TTL_MS) {
      void this._runIdleIndex(boot, !!boot?.isMobile?.());
    }
    const promptRecoveries = async () => {
      const y = this._shiftDay(this._dayKey, -1);
      if (y) await this._hydrateDay(y);
      this._app?._maybePromptRecoveries?.(this._dayKey);
    };
    if (boot?.enqueue) {
      boot.enqueue(promptRecoveries, {
        id: 'habits:recovery-prompt-' + (this._dayKey || ''),
        tier: 'onDemand',
      });
    } else {
      void promptRecoveries();
    }
  }

  _onDay(dayLabel, meta) {
    this._gen += 1;
    this._dayKey = this._normalizeDayKey((meta && meta.dayKey) || dayLabel);
    // Cancel in-flight hydrate for a previous day — rapid flips must stay paint-only.
    this._hydrating.clear();
    this._paint();
    if (this._isHabitsTabExpanded() && this._dayKey) {
      void this._hydrateDay(this._dayKey);
    }
  }

  _normalizeDayKey(raw) {
    const s = String(raw || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (compact) return compact[1] + '-' + compact[2] + '-' + compact[3];
    return this._dayKeyFromLabel(s);
  }

  _dayKeyFromLabel(label) {
    if (!label) return null;
    const s = String(label).trim();
    const iso = s.match(/(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
    const compact = s.match(/(\d{4})(\d{2})(\d{2})/);
    if (compact) return compact[1] + '-' + compact[2] + '-' + compact[3];
    const cleaned = s.replace(/^[A-Za-z]{3}\s+/, '');
    let d = Date.parse(cleaned + (/\d{4}/.test(cleaned) ? '' : ' 2026'));
    if (Number.isNaN(d)) d = Date.parse(s + (/\d{4}/.test(s) ? '' : ' 2026'));
    if (Number.isNaN(d)) return null;
    try {
      const dt = new Date(d);
      return (
        dt.getFullYear() +
        '-' +
        String(dt.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(dt.getDate()).padStart(2, '0')
      );
    } catch (_) {
      return null;
    }
  }

  _dayEntries(key) {
    const k = this._normalizeDayKey(key) || key;
    return (k && this._index.byDay[k]) || [];
  }

  async _searchRecords(query) {
    if (!query || typeof this.data.searchByQuery !== 'function') return [];
    try {
      const result = await this.data.searchByQuery(query, 24);
      if (result?.error) console.warn('[Dawn/Habits] search', result.error);
      if (Array.isArray(result)) return result;
      if (Array.isArray(result?.records)) return result.records;
      if (Array.isArray(result?.matching_records)) return result.matching_records;
    } catch (_) {}
    return [];
  }

  async _findDayLogRecord(dayKey) {
    const key = this._normalizeDayKey(dayKey);
    if (!key) return null;
    const rid = 'habit-tracker:log:' + key;
    const guidFromHit = (hit) => {
      try {
        return String(hit?.guid || hit?.id || hit?.getGuid?.() || '').trim();
      } catch (_) {
        return '';
      }
    };
    const matchRec = (rec) => {
      if (!rec) return false;
      const pid = this._propText(rec, ['plugin_id', 'Plugin ID']);
      const title = String(rec.getName?.() || rec.name || '').trim();
      const kind = this._propText(rec, ['record_kind', 'Record kind']);
      return pid === rid || title === key || (kind === 'log' && String(pid || '').endsWith(key));
    };
    const queries = [rid, key];
    for (const q of queries) {
      const hits = await this._searchRecords(q);
      for (const hit of hits || []) {
        if (!hit) continue;
        if (matchRec(hit)) return hit;
        const guid = guidFromHit(hit);
        if (!guid) continue;
        try {
          const rec = await this.data.getRecord?.(guid);
          if (matchRec(rec) || rec) {
            if (matchRec(rec)) return rec;
            const title = String(rec.getName?.() || rec.name || '').trim();
            if (title === key) return rec;
          }
        } catch (_) {}
      }
      if ((hits || []).length === 1) {
        const guid = guidFromHit(hits[0]);
        if (guid) {
          try {
            const rec = await this.data.getRecord?.(guid);
            if (rec) return rec;
          } catch (_) {}
        }
      }
    }
    return null;
  }

  _needsHydrate(dayKey) {
    const key = this._normalizeDayKey(dayKey);
    if (!key) return false;
    const entries = this._dayEntries(key);
    if (this._logMiss?.[key] && !entries.length && this._index?.full) return false;
    if (!(this._config.habits || []).length) return true;
    if (!entries.length) return true;
    return entries.some((e) => e?.guid && e.hydrated !== true);
  }

  _scheduleHydrateDay(dayKey) {
    const key = this._normalizeDayKey(dayKey);
    if (!key) return;
    if (!this._needsHydrate(key)) return;
    if (this._hydrating.has(key)) return;
    void this._hydrateDay(key);
  }

  async _hydrateDay(dayKey) {
    const key = this._normalizeDayKey(dayKey);
    if (!key || this._hydrating.has(key)) return;
    this._hydrating.add(key);
    this._paint();
    try {
      await this._loadVaultConfig();
      let entries = this._dayEntries(key);
      if (!entries.length) {
        const rec = await this._findDayLogRecord(key);
        const guid = rec?.guid || rec?.getGuid?.() || '';
        if (guid) this._attachLogToIndex(key, guid, key);
        else if (!this._index?.full && !this._building) {
          const boot = globalThis.BootKernel || globalThis.__dawnBoot;
          await this._runIdleIndex(boot, !!boot?.isMobile?.());
        } else if (this._index?.full) {
          if (!this._logMiss) this._logMiss = Object.create(null);
          this._logMiss[key] = true;
        }
        entries = this._dayEntries(key);
      }
      if (!entries.length) return;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (!e?.guid || e.hydrated === true) continue;
        try {
          const rec = await this.data.getRecord?.(e.guid);
          e.habits = await this._habitsFromRecord(rec, key);
          e.hydrated = Array.isArray(e.habits);
          if (!(this._config.habits || []).length) delete e.hydrated;
        } catch (err) {
          console.warn('[Dawn/Habits] hydrate log', e.guid, err);
          e.hydrateError = String(err?.message || err);
        }
        await new Promise((r) => setTimeout(r, 0));
      }
      this._saveIndexToStorage();
      if (this._dayKey === key) await this._hydrateNotesForDay(key);
      this._paint();
    } finally {
      this._hydrating.delete(key);
      this._paint();
    }
  }

  _linePlain(li) {
    if (!li) return '';
    try {
      if (typeof li.getPlainText === 'function') {
        const t = li.getPlainText();
        if (t) return String(t).trim();
      }
    } catch (_) {}
    try {
      const segs = li.segments;
      if (Array.isArray(segs) && segs.length) {
        return segs
          .map((s) => (s && (s.text || s.content || '')) || '')
          .join('')
          .trim();
      }
    } catch (_) {}
    try {
      if (typeof li.text === 'string') return li.text.trim();
      if (typeof li.getText === 'function') return String(li.getText() || '').trim();
    } catch (_) {}
    return '';
  }

  _habitFromCompletion(id, raw, dayKey, opts) {
    const persistLs = opts?.persistLs !== false;
    const cfg = (this._config.habits || []).find((h) => String(h.id) === String(id));
    const name = cfg?.name;
    if (!name) return null;
    const target = Number(cfg?.target) || 0;
    if (raw === HABITS_COMP_FAIL) {
      if (persistLs && dayKey) this._setHabitMark(dayKey, name, 'fail');
      return { id, name, done: false, mark: 'fail' };
    }
    if (raw === HABITS_COMP_NA) {
      if (persistLs && dayKey) this._setHabitMark(dayKey, name, 'na');
      return { id, name, done: false, mark: 'na' };
    }
    if (typeof raw === 'number') {
      if (persistLs && dayKey) this._setHabitValue(dayKey, name, raw);
      if (persistLs) this._setLsDone(dayKey, name, target > 0 ? raw >= target : raw > 0);
      return { id, name, done: target > 0 ? raw >= target : raw > 0, value: raw };
    }
    if (raw === true) {
      if (persistLs) this._setLsDone(dayKey, name, true);
      return { id, name, done: true };
    }
    return null;
  }

  async _habitsFromRecord(record, dayKey, opts) {
    if (!record) return [];
    const parsed = this._parseSettingsJson(record);
    if (parsed && parsed.completions && typeof parsed.completions === 'object') {
      const habits = [];
      for (const [id, raw] of Object.entries(parsed.completions)) {
        const row = this._habitFromCompletion(id, raw, dayKey, opts);
        if (row) habits.push(row);
      }
      if (typeof parsed.notes === 'string' && dayKey && opts?.persistLs !== false) {
        this._notesByDay[dayKey] = parsed.notes;
      }
      return habits;
    }
    if (opts?.jsonOnly) return [];
    const habits = [];
    let items = [];
    try {
      if (typeof record.getLineItems === 'function') {
        items = (await record.getLineItems(true)) || (await record.getLineItems()) || [];
      }
    } catch (e) {
      console.warn('[Dawn/Habits] getLineItems', e);
    }
    if (!items.length) {
      try {
        if (typeof record.getChildren === 'function') {
          items = (await record.getChildren()) || [];
        }
      } catch (e) {
        console.warn('[Dawn/Habits] getChildren', e);
      }
    }
    for (const li of items) {
      const name = this._linePlain(li);
      if (!name) continue;
      let done = false;
      try {
        if (typeof li.isTaskCompleted === 'function') {
          const v = li.isTaskCompleted();
          done = v === true;
        } else if (typeof li.getTaskStatus === 'function') {
          const st = li.getTaskStatus();
          done = st === 'done' || st === 8 || String(st).toLowerCase() === 'done';
        } else if (li.done === true || li.taskstatus === 'done') {
          done = true;
        }
      } catch (_) {}
      let type = '';
      try {
        type = String(li.getType?.() || li.type || '').toLowerCase();
      } catch (_) {}
      // Keep tasks; skip obvious non-habits (hr, etc.)
      if (type && type !== 'task' && type !== 'text' && type !== 'ulist' && type !== 'checkbox') {
        if (typeof li.isTaskCompleted !== 'function' && typeof li.getTaskStatus !== 'function') {
          continue;
        }
      }
      let itemGuid = '';
      try {
        itemGuid = li.guid || li.getGuid?.() || '';
      } catch (_) {}
      habits.push({
        name: name.slice(0, 48),
        done: !!done,
        itemGuid,
      });
    }
    return habits;
  }

  _paint() {
    if (!this._statusEl || !this._listEl) return;
    const key = this._dayKey;
    const entries = this._dayEntries(key);
    const hasIndex = !!(this._index.full || this._index.count);
    const hydrating = key && this._hydrating.has(key);
    // Never hydrate from paint/onDay — that storms mobile day-flips.
    // Hydrate only via onExpand (explicit user open of Habits tab).

    const fromLog = [];
    for (const e of entries) {
      if (Array.isArray(e.habits)) {
        for (const h of e.habits) fromLog.push({ ...h, logGuid: e.guid });
      }
    }
    if (fromLog.length && !(this._config.habits || []).length) {
      this._syncConfigFromHabitNames(fromLog.map((h) => h.name));
    }
    const logByName = new Map(
      fromLog.map((h) => [String(h.name || '').trim().toLowerCase(), h])
    );
    const logById = new Map(fromLog.filter((h) => h.id).map((h) => [String(h.id), h]));
    const cfgHabits = (this._config.habits || []).filter((h) => !h.archived);
    let habitsAll;
    if (cfgHabits.length) {
      habitsAll = cfgHabits
        .filter((h) => {
          if (this._manageMode) return true;
          if (this._config.hideOffDayHabits && !this._habitAppliesOnDate(h, key)) return false;
          return true;
        })
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map((h) => {
          const hit = (h.id && logById.get(String(h.id))) || logByName.get(String(h.name).trim().toLowerCase());
          return {
            ...h,
            done: !!(hit?.done || this._lsDone(key, h.name)),
            logGuid: hit?.logGuid || this._primaryLogGuid(key) || '',
            itemGuid: hit?.itemGuid || '',
          };
        });
    } else {
      habitsAll = fromLog;
    }
    const cats = [...(this._config.categories || [{ ...HABITS_DEFAULT_CAT }])].sort(
      (a, b) => (a.order || 0) - (b.order || 0)
    );
    if (!cats.some((c) => c.id === this._activeCatId)) {
      this._activeCatId = cats[0]?.id || HABITS_DEFAULT_CAT.id;
    }
    const doneN = habitsAll.filter((h) => h.done && !this._habitMark(key, h.name)).length;
    const pendingHydrate = this._needsHydrate(key);

    this._statusEl.textContent = hasIndex
      ? (habitsAll.length
          ? doneN + '/' + habitsAll.length + ' done'
          : hydrating || pendingHydrate
            ? 'Loading…'
            : 'No habits') + (key ? ' · ' + key : '')
      : 'Index pending…';
    this._statusEl.title = hasIndex
      ? 'index ' + this._index.count + (key ? ' · ' + key : '')
      : 'Waiting for idle Habit Logs index';

    if (this._dateLabelEl) this._dateLabelEl.textContent = this._formatDayLabel(key);
    if (this._doneMetaEl) {
      this._doneMetaEl.textContent = habitsAll.length
        ? doneN + '/' + habitsAll.length
        : hydrating || pendingHydrate
          ? '…'
          : '';
    }
    this._paintProgress(cats, habitsAll, key);
    this._syncCatExpandToggle();
    this._syncLayout();
    if (this._statsBtn) {
      this._statsBtn.classList.toggle('active', this._viewMode === 'stats');
      this._statsBtn.title = this._viewMode === 'stats' ? 'Back to habits' : 'View stats';
    }

    const statsMode = this._viewMode === 'stats' && !this._manageMode;
    if (this._root) this._root.classList.toggle('is-stats-mode', statsMode);
    if (this._root) this._root.classList.toggle('is-manage-mode', !!this._manageMode);
    if (this._listWrapEl) this._listWrapEl.classList.toggle('is-hidden', statsMode);
    if (this._progressWrapEl) this._progressWrapEl.classList.toggle('is-hidden', statsMode || !!this._manageMode);
    if (this._ribbonEl) {
      const hideRibbon = statsMode || !!this._manageMode;
      this._ribbonEl.classList.toggle('ht-hidden', hideRibbon);
      if (hideRibbon) this._ribbonEl.hidden = true;
    }
    if (this._notesWrapEl) {
      this._notesWrapEl.classList.toggle('is-hidden', statsMode);
      this._notesWrapEl.style.display =
        this._config.showDayNotes === false || this._manageMode ? 'none' : '';
    }
    if (this._statsViewEl) this._statsViewEl.classList.toggle('is-hidden', !statsMode);
    if (this._listEl) this._listEl.style.display = this._manageMode ? '' : 'none';

    if (this._notesInputEl && key) {
      const note = this._notesByDay[key] || '';
      if (this._notesInputEl.value !== note) this._notesInputEl.value = note;
    }

    if (statsMode) {
      this._paintStatsView(key);
      return;
    }

    if (this._manageMode) {
      this._clearBoardSections();
      this._paintManage(this._listEl);
      return;
    }

    if (!key) {
      this._clearBoardSections();
      this._tip('Pick a journal day.');
      return;
    }
    if (!habitsAll.length) {
      this._clearBoardSections();
      this._tip(
        cfgHabits.length
          ? 'No habits scheduled for this day.'
          : 'No habits yet — gear / Edit habits to add some.'
      );
      return;
    }

    this._paintBoardSections(cats, habitsAll, key);
    this._paintCollapsedRibbon(cats, habitsAll, key);
  }

  _clearBoardSections() {
    if (!this._listWrapEl) return;
    for (const el of [...this._listWrapEl.children]) {
      if (el === this._listEl) continue;
      try {
        el.remove();
      } catch (_) {}
    }
  }

  _paintBoardSections(cats, habitsAll, dayKey) {
    if (!this._listWrapEl) return;
    this._clearBoardSections();
    if (this._listEl) {
      this._listEl.innerHTML = '';
      this._listEl.style.display = 'none';
    }
    const key = dayKey || this._dayKey;
    for (const cat of cats) {
      const habits = habitsAll
        .filter((h) => this._habitCategoryId(h.name) === cat.id)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      if (!habits.length && !this._manageMode) continue;
      if (this._isCatCollapsed(cat.id)) continue;

      const sec = document.createElement('div');
      sec.className = 'ht-category';
      sec.dataset.catId = cat.id;

      const header = document.createElement('div');
      header.className = 'ht-category-header';
      header.setAttribute('role', 'button');
      header.tabIndex = 0;
      const caret = document.createElement('span');
      caret.className = 'ht-category-caret open';
      caret.innerHTML = '<i class="ti ti-chevron-right" aria-hidden="true"></i>';
      const cluster = document.createElement('span');
      cluster.className = 'ht-ch-cluster';
      const glyph = document.createElement('span');
      glyph.className = 'ht-ch-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      const icon = String(cat.icon || '').trim();
      if (icon && /^[a-z0-9-]+$/i.test(icon)) {
        glyph.innerHTML = `<i class="ti ti-${icon}" aria-hidden="true"></i>`;
      } else {
        glyph.textContent = '🔥';
      }
      const lead = document.createElement('span');
      lead.className = 'ht-cat-lead';
      const doneN = habits.filter((h) => h.done && !this._habitMark(key, h.name)).length;
      if (habits.length && doneN >= habits.length) {
        lead.innerHTML =
          '<span class="ht-cat-inline-check ht-cat-inline-check--all-done" title="All habits done today" aria-hidden="true"><i class="ti ti-checks"></i></span>';
      } else if (doneN > 0) {
        lead.innerHTML =
          '<span class="ht-cat-inline-check" aria-hidden="true"><i class="ti ti-check"></i></span>';
      }
      const name = document.createElement('span');
      name.className = 'ht-category-name';
      name.textContent = String(cat.name || 'Habits').toUpperCase();
      const streakEl = document.createElement('span');
      streakEl.className = 'ht-category-streak';
      const catStreak = this._categoryEffectiveStreak(cat.id, key);
      if (catStreak > 0) {
        const c = this._streakTierSolid(Math.min(catStreak, 364));
        streakEl.innerHTML =
          '<span style="color:' +
          c +
          '"><i class="ti ti-flame" aria-hidden="true"></i><span class="ht-streak-day-count">' +
          catStreak +
          'd</span></span>';
      } else if (habits.length) {
        streakEl.textContent = doneN + '/' + habits.length;
      }
      cluster.append(glyph, lead, name, streakEl);
      header.append(caret, cluster);
      const toggle = () => {
        this._setCatCollapsed(cat.id, !this._isCatCollapsed(cat.id));
        this._paint();
      };
      header.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        toggle();
      });
      header.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          toggle();
        }
      });

      const list = document.createElement('div');
      list.className = 'dawn-habits-list ht-category-habits';
      for (const h of habits) list.appendChild(this._makeHabitRow(h));

      sec.append(header, list);
      this._listWrapEl.insertBefore(sec, this._listEl);
    }
  }

  _paintCollapsedRibbon(cats, habitsAll, dayKey) {
    if (!this._ribbonEl) return;
    this._ribbonEl.replaceChildren();
    const ribbonCats = (cats || []).filter((c) => {
      if (this._manageMode) return true;
      return habitsAll.some((h) => this._habitCategoryId(h.name) === c.id);
    });
    const anyCollapsed = ribbonCats.some((c) => this._isCatCollapsed(c.id));
    if (!ribbonCats.length || !anyCollapsed) {
      this._ribbonEl.hidden = true;
      this._ribbonEl.classList.add('ht-hidden');
      return;
    }
    this._ribbonEl.hidden = false;
    this._ribbonEl.classList.remove('ht-hidden');

    for (const cat of ribbonCats) {
      const isOpen = !this._isCatCollapsed(cat.id);
      if (isOpen) {
        const ph = document.createElement('div');
        ph.className = 'ht-ribbon-slot ht-ribbon-slot--expanded';
        ph.dataset.catId = cat.id;
        ph.setAttribute('role', 'button');
        ph.tabIndex = 0;
        ph.setAttribute('aria-label', 'Collapse ' + (cat.name || 'category'));
        ph.title = 'Collapse “' + (cat.name || 'category') + '”';
        const collapseThis = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this._setCatCollapsed(cat.id, true);
          this._paint();
        };
        ph.addEventListener('click', collapseThis);
        ph.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') collapseThis(ev);
        });
        this._ribbonEl.appendChild(ph);
        continue;
      }

      const habits = habitsAll.filter((h) => this._habitCategoryId(h.name) === cat.id);
      const status = this._categoryDayAggStatus(habits, dayKey);
      const marked = this._categoryAllMarked(habits, dayKey);
      const chipStreak = this._categoryEffectiveStreak(cat.id, dayKey);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ht-ribbon-sec';
      btn.dataset.catId = cat.id;
      btn.innerHTML =
        '<span class="ht-ribbon-sec-inner">' +
        this._ribbonLeadCellHtml(status, marked) +
        '<span class="ht-ribbon-sec-glyph">' +
        this._categoryGlyphHtml(cat) +
        '</span>' +
        '<span class="ht-ribbon-sec-tail">' +
        (chipStreak > 0 ? this._ribbonStreakHtml(chipStreak) : '') +
        '</span></span>';
      const dayHint =
        status === 'all_done'
          ? ' · all done today'
          : status === 'partial'
            ? ' · in progress'
            : status === 'na'
              ? ' · N/A today'
              : status === 'fail'
                ? ' · missed today'
                : '';
      btn.title =
        (cat.name || 'category') +
        dayHint +
        (chipStreak > 0 ? ' · ' + chipStreak + 'd streak' : '') +
        ' — tap to expand';
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this._setCatCollapsed(cat.id, false);
        this._paint();
      });
      this._ribbonEl.appendChild(btn);
    }
  }

  _categoryDayAggStatus(habits, dayKey) {
    const list = habits || [];
    if (!list.length) return 'na';
    const rows = list.map((h) => {
      const mark = this._habitMark(dayKey, h.name);
      return {
        done: !!(h.done && !mark),
        na: mark === 'na',
        fail: mark === 'fail',
      };
    });
    if (rows.every((r) => r.na)) return 'na';
    if (rows.every((r) => r.done)) return 'all_done';
    if (rows.some((r) => r.done)) return 'partial';
    const nonNa = rows.filter((r) => !r.na);
    if (nonNa.length && nonNa.every((r) => r.fail)) return 'fail';
    return 'none';
  }

  _categoryAllMarked(habits, dayKey) {
    const list = habits || [];
    if (!list.length) return true;
    return list.every((h) => !!(h.done || this._habitMark(dayKey, h.name)));
  }

  _ribbonLeadCellHtml(status, marked) {
    let inner = '';
    if (status === 'all_done') {
      inner =
        '<span class="ht-cat-inline-check ht-cat-inline-check--all-done" title="All habits in this category done today" aria-hidden="true"><i class="ti ti-checks"></i></span>';
    } else if (status === 'partial') {
      inner =
        '<span class="ht-cat-inline-check" aria-hidden="true"><i class="ti ti-check"></i></span>';
    } else if (status === 'na') {
      inner = '<span class="ht-cat-inline-na ht-cat-na-bar" aria-hidden="true"></span>';
    } else if (status === 'fail') {
      inner =
        '<span class="ht-cat-inline-fail ht-habit-mark ht-habit-mark-fail" aria-hidden="true">×</span>';
    }
    const dot = marked
      ? '<span class="ht-ribbon-marked-dot" aria-hidden="true"><span class="ht-cat-marked-dot"></span></span>'
      : '';
    return '<span class="ht-ribbon-sec-lead">' + inner + dot + '</span>';
  }

  _ribbonStreakHtml(streakDays) {
    const d = Math.max(0, Math.floor(Number(streakDays) || 0));
    if (d <= 0) return '';
    const c = this._streakTierSolid(Math.min(d, 364));
    return (
      '<span class="ht-ribbon-sec-streak" style="color:' +
      c +
      '"><i class="ti ti-flame" aria-hidden="true"></i><span class="ht-streak-day-count">' +
      d +
      'd</span></span>'
    );
  }

  _categoryGlyphHtml(cat) {
    const raw = String(cat?.icon || cat?.emoji || '').trim();
    if (raw && /^[a-z][a-z0-9-]*$/i.test(raw) && raw.length < 48) {
      return '<i class="ti ti-' + raw + '" aria-hidden="true"></i>';
    }
    if (raw) {
      const esc = raw
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return '<span class="ht-emoji-inline">' + esc + '</span>';
    }
    return '<i class="ti ti-folder" aria-hidden="true"></i>';
  }

  _paintStatsView(dayKey) {
    if (!this._statsViewEl) return;
    const range = this._statsRange === 30 ? 30 : 7;
    this._scheduleHydrateRange(dayKey, range);
    this._statsViewEl.innerHTML = '';

    const rangeRow = document.createElement('div');
    rangeRow.className = 'ht-stats-range';
    for (const [label, days] of [
      ['7d', 7],
      ['30d', 30],
    ]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ht-range-btn' + (range === days ? ' active' : '');
      btn.textContent = label;
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this._statsRange = days;
        this._saveUiPrefs();
        this._paintStatsView(this._dayKey);
      });
      rangeRow.appendChild(btn);
    }
    this._statsViewEl.appendChild(rangeRow);

    const habitNames = this._collectHabitNames(dayKey, Math.max(range, 30));
    let selected = this._statsSelected || 'overall';
    if (selected.startsWith('habit:')) {
      const want = selected.slice(6).toLowerCase();
      const hit = habitNames.find((n) => n.toLowerCase() === want);
      if (!hit) selected = 'overall';
      else selected = 'habit:' + hit;
    }
    this._statsSelected = selected;

    const sel = document.createElement('select');
    sel.className = 'ht-stats-select';
    const optOverall = document.createElement('option');
    optOverall.value = 'overall';
    optOverall.textContent = 'Overall';
    sel.appendChild(optOverall);
    for (const n of habitNames) {
      const o = document.createElement('option');
      o.value = 'habit:' + n;
      o.textContent = n;
      sel.appendChild(o);
    }
    sel.value = selected;
    sel.addEventListener('change', () => {
      this._statsSelected = sel.value || 'overall';
      this._saveUiPrefs();
      this._paintStatsView(this._dayKey);
    });
    this._statsViewEl.appendChild(sel);

    const cards = document.createElement('div');
    cards.className = 'ht-stat-cards';
    const mk = (label, value, unit, klass) => {
      const card = document.createElement('div');
      card.className = 'ht-stat-card' + (klass ? ' ' + klass : '');
      card.innerHTML =
        '<div class="ht-stat-label"></div><div class="ht-stat-value"></div><div class="ht-stat-unit"></div>';
      card.querySelector('.ht-stat-label').textContent = label;
      card.querySelector('.ht-stat-value').textContent = String(value);
      card.querySelector('.ht-stat-unit').textContent = unit || '';
      return card;
    };

    const isHabit = selected.startsWith('habit:');
    const habitName = isHabit ? selected.slice(6) : '';
    if (isHabit) {
      const hs = this._habitRangeStats(habitName, dayKey, range);
      cards.appendChild(mk('Streak', hs.streak, 'days', hs.streak ? 'fire' : ''));
      cards.appendChild(mk('Best', hs.best, 'days'));
      cards.appendChild(mk('Rate', hs.rate + '%', hs.daysDone + '/' + hs.daysWith, 'accent'));
    } else {
      const stats = this._overallStats(dayKey, range);
      cards.appendChild(mk('Done', stats.checks, 'checks'));
      cards.appendChild(mk('Rate', stats.rate + '%', 'of logged', 'accent'));
      cards.appendChild(mk('Days', stats.daysWithLog, 'with logs'));
    }
    this._statsViewEl.appendChild(cards);

    const calSection = document.createElement('div');
    calSection.className = 'ht-stats-section';
    calSection.innerHTML = '<div class="ht-stats-section-title">Completion Calendar</div>';
    if (range === 7) {
      calSection.appendChild(this._buildCalStrip(dayKey, habitName || null));
    } else {
      calSection.appendChild(this._buildCalMonth(dayKey, habitName || null));
    }
    this._statsViewEl.appendChild(calSection);

    const chartSection = this._buildDailyProgressChart(dayKey, range, habitName || null);
    if (chartSection) this._statsViewEl.appendChild(chartSection);

    const hint = document.createElement('div');
    hint.className = 'ht-stats-hint';
    hint.textContent =
      'From idle Habit Logs index + expand hydrate (' +
      range +
      'd). Click calendar cells to toggle. Fail/NA + multi-cat need habit-tracker config.';
    this._statsViewEl.appendChild(hint);
  }

  _buildDailyProgressChart(dayKey, rangeDays, habitName) {
    const section = document.createElement('div');
    section.className = 'ht-stats-section';
    section.innerHTML = '<div class="ht-stats-section-title">Daily Progress</div>';

    const dates = [];
    for (let i = rangeDays - 1; i >= 0; i--) {
      const d = this._shiftDay(dayKey, -i);
      if (d) dates.push(d);
    }
    if (!dates.length) return null;

    const vals = dates.map((d) => {
      if (habitName) {
        const st = this._habitDayState(habitName, d);
        return { val: st.done ? 1 : 0, done: st.done, seen: st.seen };
      }
      let slots = 0;
      let done = 0;
      for (const e of this._dayEntries(d)) {
        for (const h of e?.habits || []) {
          slots += 1;
          if (h.done) done += 1;
        }
      }
      return {
        val: done,
        done: slots > 0 && done >= slots,
        seen: slots > 0,
      };
    });

    const maxVal = Math.max(1, ...vals.map((v) => v.val || 0));
    let target = 1;
    if (!habitName) {
      // Target = max habit slots seen in window (or current day).
      let maxSlots = 0;
      for (const d of dates) {
        let slots = 0;
        for (const e of this._dayEntries(d)) slots += (e?.habits || []).length;
        if (slots > maxSlots) maxSlots = slots;
      }
      target = Math.max(1, maxSlots);
    }

    const chartEl = document.createElement('div');
    chartEl.className = 'ht-barchart';
    if (target > 0 && maxVal > 0) {
      const targetPct = Math.min(100, (target / Math.max(maxVal, target)) * 100);
      const line = document.createElement('div');
      line.className = 'ht-target-line';
      line.style.bottom = targetPct + '%';
      const tLabel = document.createElement('div');
      tLabel.className = 'ht-target-label';
      tLabel.style.bottom = targetPct + '%';
      tLabel.textContent = String(target);
      chartEl.append(line, tLabel);
    }

    const labelsEl = document.createElement('div');
    labelsEl.className = 'ht-barchart-labels';
    const labelInterval = Math.max(1, Math.ceil(dates.length / 6));
    dates.forEach((d, i) => {
      const v = vals[i];
      const wrap = document.createElement('div');
      wrap.className = 'ht-bar-wrap';
      const bar = document.createElement('div');
      bar.className = 'ht-bar' + (v?.done ? ' done' : '');
      const heightPct = v?.val
        ? Math.max(2, Math.round((v.val / Math.max(maxVal, target)) * 100))
        : 0;
      bar.style.height = heightPct + '%';
      wrap.appendChild(bar);
      if (v?.val > 0) {
        const tip = document.createElement('div');
        tip.className = 'ht-bar-tooltip';
        tip.textContent = String(v.val);
        wrap.appendChild(tip);
      }
      chartEl.appendChild(wrap);
      const lblWrap = document.createElement('div');
      lblWrap.className = 'ht-bar-label-wrap';
      if (i % labelInterval === 0) {
        const lbl = document.createElement('div');
        lbl.className = 'ht-bar-label';
        lbl.textContent = String(new Date(d + 'T12:00:00').getDate());
        lblWrap.appendChild(lbl);
      }
      labelsEl.appendChild(lblWrap);
    });

    const wrap = document.createElement('div');
    wrap.className = 'ht-barchart-wrap';
    wrap.append(chartEl, labelsEl);
    section.appendChild(wrap);
    return section;
  }

  _findHabitOnDay(habitName, dayKey) {
    const name = String(habitName || '').trim().toLowerCase();
    if (!name || !dayKey) return null;
    for (const e of this._dayEntries(dayKey)) {
      for (const h of e?.habits || []) {
        if (String(h.name || '').trim().toLowerCase() !== name) continue;
        return {
          name: h.name,
          done: !!h.done,
          itemGuid: h.itemGuid || '',
          logGuid: e.guid || h.logGuid || '',
        };
      }
    }
    return null;
  }

  async _toggleStatsDay(dateStr, habitName) {
    if (!dateStr || dateStr > this._todayKey()) return;
    await this._hydrateDay(dateStr);
    if (habitName) {
      const h = this._findHabitOnDay(habitName, dateStr);
      if (!h?.logGuid) return;
      await this._toggleHabit(h, dateStr);
      return;
    }
    // Overall: if any incomplete → mark all done; else mark all undone.
    const habits = [];
    for (const e of this._dayEntries(dateStr)) {
      for (const h of e?.habits || []) {
        habits.push({
          name: h.name,
          done: !!h.done,
          itemGuid: h.itemGuid || '',
          logGuid: e.guid || h.logGuid || '',
        });
      }
    }
    if (!habits.length) return;
    const allDone = habits.every((h) => h.done);
    for (const h of habits) {
      if (allDone ? h.done : !h.done) {
        await this._toggleHabit(h, dateStr);
      }
    }
  }

  _todayKey() {
    const t = new Date();
    return (
      t.getFullYear() +
      '-' +
      String(t.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(t.getDate()).padStart(2, '0')
    );
  }

  _buildCalStrip(dayKey, habitName) {
    const strip = document.createElement('div');
    strip.className = 'ht-cal-strip';
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const today = this._todayKey();
    for (let i = 6; i >= 0; i--) {
      const d = this._shiftDay(dayKey, -i);
      if (!d) continue;
      const dt = new Date(d + 'T12:00:00');
      const isToday = d === today;
      const col = document.createElement('div');
      col.className = 'ht-cal-strip-col' + (isToday ? ' today' : '');
      const dayName = document.createElement('div');
      dayName.className = 'ht-cal-strip-dow';
      dayName.textContent = DOW[dt.getDay()];
      const circle = document.createElement('div');
      let cls = 'ht-cal-strip-circle';
      if (habitName) {
        const st = this._habitDayState(habitName, d);
        if (st.done) cls += ' done';
        else if (st.seen) cls += ' partial';
      } else {
        const ov = this._overallDayDone(d);
        if (ov.done) cls += ' done';
        else if (ov.partial) cls += ' partial';
      }
      circle.className = cls;
      circle.title = d + ' — click to toggle';
      circle.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        void this._toggleStatsDay(d, habitName || null);
      });
      const dateNum = document.createElement('div');
      dateNum.className = 'ht-cal-strip-date';
      dateNum.textContent = String(dt.getDate());
      col.append(dayName, circle, dateNum);
      strip.appendChild(col);
    }
    return strip;
  }

  _buildCalMonth(dayKey, habitName) {
    const wrap = document.createElement('div');
    wrap.className = 'ht-cal-month-view';
    const anchor = new Date((dayKey || this._todayKey()) + 'T12:00:00');
    if (!this._statsCalMonth) {
      this._statsCalMonth = { y: anchor.getFullYear(), m: anchor.getMonth() };
    }
    let { y: year, m: month } = this._statsCalMonth;
    const today = this._todayKey();

    const nav = document.createElement('div');
    nav.className = 'ht-cal-month-nav';
    const prevMo = document.createElement('button');
    prevMo.type = 'button';
    prevMo.className = 'ht-cal-nav-btn';
    prevMo.innerHTML = '<i class="ti ti-chevron-left" aria-hidden="true"></i>';
    const monthTitle = document.createElement('span');
    monthTitle.className = 'ht-cal-month-title';
    monthTitle.textContent = new Date(year, month, 1).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
    });
    const nextMo = document.createElement('button');
    nextMo.type = 'button';
    nextMo.className = 'ht-cal-nav-btn';
    nextMo.innerHTML = '<i class="ti ti-chevron-right" aria-hidden="true"></i>';
    prevMo.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      month -= 1;
      if (month < 0) {
        month = 11;
        year -= 1;
      }
      this._statsCalMonth = { y: year, m: month };
      this._paintStatsView(this._dayKey);
    });
    nextMo.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
      this._statsCalMonth = { y: year, m: month };
      this._paintStatsView(this._dayKey);
    });
    nav.append(prevMo, monthTitle, nextMo);
    wrap.appendChild(nav);

    const dowRow = document.createElement('div');
    dowRow.className = 'ht-cal-dow-row';
    for (const d of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
      const h = document.createElement('div');
      h.className = 'ht-cal-dow-header';
      h.textContent = d;
      dowRow.appendChild(h);
    }
    wrap.appendChild(dowRow);

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDow = firstDay.getDay();
    const grid = document.createElement('div');
    grid.className = 'ht-cal-grid';
    for (let p = 0; p < startDow; p++) {
      const empty = document.createElement('div');
      empty.className = 'ht-cal-day empty';
      grid.appendChild(empty);
    }
    for (let day = 1; day <= lastDay.getDate(); day++) {
      const dateStr =
        year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
      const cell = document.createElement('div');
      let cls = 'ht-cal-day';
      if (dateStr === today) cls += ' today';
      if (dateStr > today) cls += ' out-of-range';
      if (habitName) {
        const st = this._habitDayState(habitName, dateStr);
        if (st.done) cls += ' done';
        else if (st.seen) cls += ' partial';
      } else {
        const ov = this._overallDayDone(dateStr);
        if (ov.done) cls += ' done';
        else if (ov.partial) cls += ' partial';
      }
      cell.className = cls;
      cell.title = dateStr + (dateStr <= today ? ' — click to toggle' : '');
      if (dateStr <= today) {
        cell.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          void this._toggleStatsDay(dateStr, habitName || null);
        });
      }
      const num = document.createElement('div');
      num.className = 'ht-cal-day-num';
      num.textContent = String(day);
      const dot = document.createElement('div');
      dot.className = 'ht-cal-day-dot';
      cell.append(num, dot);
      grid.appendChild(cell);
    }
    wrap.appendChild(grid);
    // Hydrate visible month days that have index entries (onDemand, not nav).
    const monthKeys = [];
    for (let day = 1; day <= lastDay.getDate(); day++) {
      const dateStr =
        year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
      if (this._needsHydrate(dateStr)) monthKeys.push(dateStr);
    }
    if (monthKeys.length) {
      const boot = globalThis.BootKernel || globalThis.__dawnBoot;
      const run = async () => {
        for (const k of monthKeys.slice(0, 40)) {
          await this._hydrateDay(k);
          await new Promise((r) => setTimeout(r, 0));
        }
      };
      if (boot?.enqueue) {
        boot.enqueue(() => run(), {
          id: 'habits:hydrate-month-' + year + '-' + month,
          tier: 'onDemand',
        });
      } else void run();
    }
    return wrap;
  }

  _tip(text) {
    this._clearBoardSections();
    if (!this._listEl) return;
    this._listEl.style.display = '';
    this._listEl.innerHTML = '';
    const tip = document.createElement('div');
    tip.className = 'dawn-habits-empty';
    tip.textContent = text;
    this._listEl.appendChild(tip);
  }

  _makeOpenLogRow(logGuid) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ht-habit';
    row.innerHTML =
      '<div class="ht-habit-top"><span class="ht-habit-name">Open habit log</span></div>';
    row.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    row.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._openLog(logGuid);
    });
    return row;
  }

  _makeHabitRow(h) {
    // Prod-like orbit + minimal ti-check; meta 30d·7d from idle index; chevron → per-habit stats.
    // Boolean: empty → done → fail → N/A → clear. Numeric: tap +1 to target, then reset; long-press edits count.
    const cfg = this._habitCfg(h.name);
    const numeric = cfg.type === 'number';
    const target = numeric ? Math.max(1, Number(cfg.target) || 8) : 0;
    const val = numeric ? this._habitValue(this._dayKey, h.name) : 0;
    const mark = this._habitMark(this._dayKey, h.name);
    const numDone = numeric && !mark && val >= target;
    const row = document.createElement('div');
    row.className =
      'ht-habit' +
      (mark === 'fail' ? ' ht-fail' : mark === 'na' ? ' ht-na' : h.done || numDone ? ' ht-done' : '');
    row.title = numeric
      ? mark
        ? 'Click to clear mark'
        : 'Tap to count · long-press to enter a number'
      : mark === 'fail'
        ? 'Failed — click for N/A'
        : mark === 'na'
          ? 'N/A — click to clear'
          : h.done
            ? 'Done — click to mark fail'
            : 'Click to mark done';
    row.setAttribute('role', 'button');
    row.tabIndex = 0;

    const top = document.createElement('div');
    top.className = 'ht-habit-top';

    const orbit = document.createElement('div');
    orbit.className = 'ht-habit-orbit';
    const check = document.createElement('span');
    check.className = 'ht-habit-check-minimal';
    const glyph = document.createElement('span');
    if (numeric && !mark) {
      glyph.className = 'ht-habit-num';
      glyph.innerHTML =
        String(val) + '<span class="ht-num-tgt">/' + target + '</span>';
    } else {
      const showSolid = !!mark || !!h.done;
      glyph.className = 'ht-check-glyph' + (showSolid ? '' : ' ht-check-faint');
      const icon =
        mark === 'fail' ? 'ti-x' : mark === 'na' ? 'ti-minus' : 'ti-check';
      glyph.innerHTML = '<i class="ti ' + icon + '" aria-hidden="true"></i>';
    }
    check.appendChild(glyph);
    orbit.appendChild(check);

    const nameCol = document.createElement('div');
    nameCol.className = 'ht-habit-name-col';
    const name = document.createElement('div');
    name.className = 'ht-habit-line-name ht-habit-name';
    name.textContent = h.name;
    nameCol.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'ht-habit-line-meta';
    const cluster = document.createElement('div');
    cluster.className = 'ht-habit-streak-cluster';
    const streakDays = this._habitConsecutiveStreak(h.name, this._dayKey);
    if (streakDays > 0) {
      const core = document.createElement('span');
      core.innerHTML = this._streakCoreHtml(streakDays);
      if (core.firstChild) cluster.appendChild(core.firstChild);
    }
    const rolls = this._habitRollCounts(h.name, this._dayKey);
    const counts = document.createElement('span');
    counts.className = 'ht-habit-stat-counts';
    counts.innerHTML =
      '<span class="ht-roll-num">' +
      rolls.d30 +
      '</span><span class="ht-roll-suffix">30d</span>' +
      '<span class="ht-roll-sep">·</span>' +
      '<span class="ht-roll-num">' +
      rolls.d7 +
      '</span><span class="ht-roll-suffix">7d</span>';
    cluster.appendChild(counts);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'ht-habit-stats-link';
    open.title = 'View habit stats (Shift-click: open log)';
    open.setAttribute('aria-label', 'View habit stats');
    open.innerHTML = '<i class="ti ti-chevron-right" aria-hidden="true"></i>';
    open.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.shiftKey) {
        void this._openLog(h.logGuid, h.itemGuid);
        return;
      }
      this._enterHabitStats(h.name);
    });
    meta.appendChild(cluster);
    meta.appendChild(open);
    nameCol.appendChild(meta);

    top.appendChild(orbit);
    top.appendChild(nameCol);
    row.appendChild(top);

    const onToggle = (ev) => {
      if (ev.target?.closest?.('.ht-habit-stats-link')) return;
      if (row.querySelector?.('.ht-num-input')) return;
      if (row._dawnLongPress) {
        row._dawnLongPress = false;
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      if (numeric) void this._tapNumericHabit(h, target);
      else void this._toggleHabit(h);
    };
    let pressTimer = null;
    let pressX = 0;
    let pressY = 0;
    const clearPress = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };
    row.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      if (ev.target?.closest?.('.ht-habit-stats-link, .ht-num-input, .ht-num-btn')) return;
      row._dawnLongPress = false;
      pressX = ev.clientX;
      pressY = ev.clientY;
      clearPress();
      if (!numeric) return;
      pressTimer = setTimeout(() => {
        pressTimer = null;
        row._dawnLongPress = true;
        this._showNumericInput(row, h, target);
      }, HABITS_LONG_PRESS_MS);
    });
    row.addEventListener('pointermove', (ev) => {
      if (!pressTimer) return;
      const thresh = ev.pointerType === 'touch' ? 12 : 8;
      if (Math.abs(ev.clientX - pressX) > thresh || Math.abs(ev.clientY - pressY) > thresh) {
        clearPress();
      }
    });
    row.addEventListener('pointerup', clearPress);
    row.addEventListener('pointercancel', clearPress);
    row.addEventListener('click', onToggle);
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        if (numeric) void this._tapNumericHabit(h, target);
        else void this._toggleHabit(h);
      }
    });
    return row;
  }

  _workspaceGuid() {
    try {
      if (typeof this.getWorkspaceGuid === 'function') return this.getWorkspaceGuid();
    } catch (_) {}
    try {
      return this.workspace?.guid || this.workspace?.getGuid?.() || null;
    } catch (_) {}
    return null;
  }

  async _openLog(logGuid, itemGuid) {
    if (!logGuid) {
      console.warn('[Dawn/Habits] openLog: no guid');
      return;
    }
    const ws = this._workspaceGuid();
    try {
      // Do NOT createPanel() — that opens an empty "Custom Panel" in Thymer.
      const panel = this.ui.getActivePanel?.();
      if (!panel?.navigateTo) {
        console.warn('[Dawn/Habits] openLog: panel.navigateTo missing');
        return;
      }

      // Open the habit log document in this panel (back arrow returns to journal).
      panel.navigateTo({
        type: 'edit_panel',
        rootId: logGuid,
        subId: itemGuid || logGuid,
        workspaceGuid: ws,
      });
    } catch (e) {
      console.warn('[Dawn/Habits] openLog', e);
    }
  }

  _writeHabitDone(h, done, dayKey) {
    h.done = !!done;
    const key = dayKey || this._dayKey;
    // Persist into index entry (paint uses shallow copies).
    const entries = this._dayEntries(key);
    let found = false;
    for (const e of entries) {
      if (!Array.isArray(e.habits)) continue;
      for (const x of e.habits) {
        const same =
          (h.id && x.id && String(h.id) === String(x.id)) ||
          (h.itemGuid && x.itemGuid === h.itemGuid) ||
          (!h.itemGuid && x.name === h.name);
        if (same) {
          x.done = !!done;
          found = true;
        }
      }
    }
    if (!found && entries[0]) {
      if (!Array.isArray(entries[0].habits)) entries[0].habits = [];
      entries[0].habits.push({
        id: h.id || this._habitIdOf(h),
        name: h.name,
        done: !!done,
        itemGuid: h.itemGuid || '',
      });
    }
    this._saveIndexToStorage();
  }

  async _setTaskDoneSdk(h, nextDone) {
    if (h) h.done = !!nextDone;
    const jsonOk = await this._persistLogHabit(h, this._dayKey);
    if (jsonOk) return true;
    if (!h?.logGuid) return false;
    try {
      const rec = await this.data.getRecord?.(h.logGuid);
      if (!rec) {
        console.warn('[Dawn/Habits] toggle: record missing', h.logGuid);
        return false;
      }
      let items = [];
      try {
        items = (await rec.getLineItems?.(true)) || (await rec.getLineItems?.()) || [];
      } catch (e) {
        console.warn('[Dawn/Habits] toggle getLineItems', e);
      }
      let li = null;
      for (const it of items) {
        const g = it.guid || it.getGuid?.();
        if (h.itemGuid && g === h.itemGuid) {
          li = it;
          break;
        }
      }
      if (!li && h.name) {
        for (const it of items) {
          if (this._linePlain(it) === h.name) {
            li = it;
            break;
          }
        }
      }
      if (!li?.setTaskStatus) {
        console.warn('[Dawn/Habits] toggle: line item not found', h);
        return false;
      }
      await li.setTaskStatus(nextDone ? 'done' : 'none');
      if (!h.itemGuid) {
        try {
          h.itemGuid = li.guid || li.getGuid?.() || h.itemGuid;
        } catch (_) {}
      }
      return true;
    } catch (e) {
      console.warn('[Dawn/Habits] toggle fail', e);
      return false;
    }
  }

  async _applyNumericDone(h, nextDone, dayKey) {
    const key = dayKey || this._dayKey;
    this._setHabitMark(key, h.name, null);
    this._writeHabitDone(h, nextDone, key);
    this._paint();
    await this._setTaskDoneSdk(h, nextDone);
    if (nextDone) this._afterDaySave(key);
  }

  async _tapNumericHabit(h, target) {
    const key = this._dayKey;
    const mark = this._habitMark(key, h.name);
    if (mark) {
      this._setHabitMark(key, h.name, null);
      this._paint();
      await this._persistLogHabit(h, key);
      return;
    }
    const tgt = Math.max(1, Number(target) || 8);
    let v = this._habitValue(key, h.name);
    if (v >= tgt) v = 0;
    else v += 1;
    this._setHabitValue(key, h.name, v);
    await this._applyNumericDone(h, v >= tgt, key);
  }

  _htResolveNumericInput(raw, baseVal, max = 9999) {
    const s = String(raw ?? '').trim().replace(/\s+/g, '');
    const clamp = (n) => {
      if (!Number.isFinite(n)) return 0;
      return Math.max(0, Math.min(max, Math.round(n)));
    };
    const base = clamp(Number(baseVal));
    if (!s) return 0;
    const rel = s.match(/^([+\-*\/])(\d+(?:\.\d+)?)$/);
    if (rel) {
      const n = parseFloat(rel[2]);
      if (!Number.isFinite(n)) return base;
      let out = base;
      if (rel[1] === '+') out = base + n;
      else if (rel[1] === '-') out = base - n;
      else if (rel[1] === '*') out = base * n;
      else out = n === 0 ? base : base / n;
      return clamp(out);
    }
    return clamp(parseFloat(s));
  }

  _showNumericInput(habitEl, h, target) {
    if (!habitEl || habitEl.querySelector?.('.ht-num-input')) return;
    const nameEl = habitEl.querySelector('.ht-habit-name, .htq-habit-name');
    if (!nameEl) return;
    const key = this._dayKey;
    const tgt = Math.max(1, Number(target) || 8);
    const cur = this._habitValue(key, h.name);
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:3px;margin-left:6px;';
    let outside = null;
    const close = () => {
      try { wrap.remove(); } catch (_) {}
      if (outside) {
        try { document.removeEventListener('pointerdown', outside, true); } catch (_) {}
        outside = null;
      }
    };

    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.className = 'ht-num-input';
    input.value = String(cur);
    input.title = 'Enter a number, or +6 / *2 from the current count';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'ht-num-btn';
    okBtn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i>';
    okBtn.style.cssText = 'background:rgba(76,175,80,0.2);border-color:#4caf50;color:#4caf50;';

    const commit = () => {
      close();
      const v = this._htResolveNumericInput(input.value, cur);
      this._setHabitMark(key, h.name, null);
      this._setHabitValue(key, h.name, v);
      void this._applyNumericDone(h, v >= tgt, key);
    };
    const commitSpecial = (mark) => {
      close();
      this._setHabitValue(key, h.name, 0);
      this._writeHabitDone?.(h, false, key);
      h.done = false;
      this._setHabitMark(key, h.name, mark);
      this._paint();
      void this._persistLogHabit(h, key);
    };

    const failBtn = document.createElement('button');
    failBtn.type = 'button';
    failBtn.className = 'ht-num-btn ht-num-fail-btn';
    failBtn.setAttribute('aria-label', 'Missed (×)');
    failBtn.textContent = '×';

    const naBtn = document.createElement('button');
    naBtn.type = 'button';
    naBtn.className = 'ht-num-btn ht-num-na-btn';
    naBtn.setAttribute('aria-label', 'Not applicable');
    naBtn.innerHTML = '<span class="ht-cat-na-bar"></span>';

    okBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); commit(); });
    failBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); commitSpecial('fail'); });
    naBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); commitSpecial('na'); });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    wrap.addEventListener('pointerdown', (e) => e.stopPropagation());
    wrap.addEventListener('click', (e) => e.stopPropagation());

    wrap.appendChild(input);
    wrap.appendChild(okBtn);
    wrap.appendChild(failBtn);
    wrap.appendChild(naBtn);
    nameEl.appendChild(wrap);
    setTimeout(() => { try { input.focus(); input.select(); } catch (_) {} }, 10);
    outside = (e) => {
      if (!wrap.contains(e.target)) close();
    };
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 50);
  }

  async _toggleHabit(h, dayKey) {
    const key = dayKey || this._dayKey;
    const mark = this._habitMark(key, h.name);
    if (!h?.logGuid) {
      const guid = await this._ensureDayLog(key);
      if (guid) h.logGuid = guid;
    }
    const done = !!(h.done || this._lsDone(key, h.name));
    if (!h?.logGuid) {
      if (!mark && !done) {
        this._setLsDone(key, h.name, true);
        h.done = true;
      } else if (!mark && done) {
        this._setLsDone(key, h.name, false);
        h.done = false;
        this._setHabitMark(key, h.name, 'fail');
      } else if (mark === 'fail') {
        this._setHabitMark(key, h.name, 'na');
      } else {
        this._setHabitMark(key, h.name, null);
        this._setLsDone(key, h.name, false);
        h.done = false;
      }
      this._paint();
      this._afterDaySave?.(key);
      return;
    }
    // Cycle: empty → done → fail → na → empty
    if (!mark && !h.done) {
      this._setHabitMark(key, h.name, null);
      this._writeHabitDone(h, true, key);
      this._paint();
      const ok = await this._setTaskDoneSdk(h, true);
      if (!ok) {
        this._writeHabitDone(h, false, key);
        this._paint();
      } else {
        this._afterDaySave(key);
      }
      return;
    }
    if (!mark && h.done) {
      this._writeHabitDone(h, false, key);
      this._setHabitMark(key, h.name, 'fail');
      this._paint();
      await this._setTaskDoneSdk(h, false);
      return;
    }
    if (mark === 'fail') {
      this._setHabitMark(key, h.name, 'na');
      this._writeHabitDone(h, false, key);
      this._paint();
      await this._persistLogHabit(h, key);
      return;
    }
    if (mark === 'na') {
      this._setHabitMark(key, h.name, null);
      this._writeHabitDone(h, false, key);
      this._paint();
      await this._persistLogHabit(h, key);
    }
  }

  async _runIdleIndex(boot, isMobile) {
    if (this._building) return;
    this._building = true;
    const t0 = performance.now();
    const byDay = Object.create(null);
    let count = 0;
    try {
      const coll = await this._getLogsCollection(boot);
      if (!coll?.getAllRecords) {
        console.warn('[Dawn/Habits] Habit Logs missing');
        return;
      }
      await this._loadVaultConfig();
      const prevHabits = Object.create(null);
      for (const list of Object.values(this._index.byDay || {})) {
        for (const e of list || []) {
          if (e?.guid && e.hydrated === true && Array.isArray(e.habits)) {
            prevHabits[e.guid] = { habits: e.habits, hydrated: true };
          }
        }
      }

      const arr = (await coll.getAllRecords()) || [];
      this._index.byDay = byDay;
      this._index.full = false;
      for (let i = 0; i < arr.length; i++) {
        count += 1;
        let title = '';
        let guid = '';
        try {
          title = arr[i]?.getName?.() || arr[i]?.name || '';
          guid = arr[i]?.guid || arr[i]?.id || '';
        } catch (_) {}
        const key = this._dayKeyFromLabel(title);
        if (!key) {
          if (this._applyVaultConfigRecord(arr[i], title)) this._paint();
        } else if (guid) {
          if (!byDay[key]) byDay[key] = [];
          const entry = { guid, title: String(title).slice(0, 80) };
          if (prevHabits[guid]?.habits?.length) {
            entry.habits = prevHabits[guid].habits;
            entry.hydrated = true;
          } else {
            const parsedHabits = await this._habitsFromRecord(arr[i], key, {
              persistLs: false,
              jsonOnly: true,
            });
            if (parsedHabits.length) {
              entry.habits = parsedHabits;
              entry.hydrated = true;
            }
          }
          byDay[key].push(entry);
          if (key === this._dayKey && entry.hydrated) this._paint();
        }
        if (i % (isMobile ? 8 : 20) === 0) {
          await new Promise((r) => setTimeout(r, 0));
          if (boot?.shouldYield?.()) await boot.yieldToMain?.();
        }
      }
      this._index = {
        byDay,
        count,
        builtAt: Date.now(),
        ms: Math.round(performance.now() - t0),
        full: true,
      };
      if (this._logMiss) {
        for (const k of Object.keys(byDay)) delete this._logMiss[k];
      }
      this._saveIndexToStorage();
      console.info('[Dawn/Habits] index', count, 'days', Object.keys(byDay).length, 'ms', this._index.ms);
      this._paint();
      if (this._isHabitsTabExpanded() && this._dayKey) {
        void this._hydrateDay(this._dayKey);
      }
    } catch (e) {
      console.warn('[Dawn/Habits] index fail', e);
    } finally {
      this._building = false;
    }
  }
}
/**
 * Inline habit manage — prod Behavioral `_renderSettings` chrome, LS-backed.
 * Mixed onto DawnHabitsEngine after habits-engine.js.
 */

function dawnMixInHabitManage(Cls) {
  if (!Cls || Cls.prototype._toggleManage) return;

  Cls.prototype._toggleManage = function _toggleManage() {
    this._manageMode = !this._manageMode;
    if (this._manageMode) this._viewMode = 'list';
    this._paint();
  };

  Cls.prototype._newHabitId = function _newHabitId() {
    return 'h-' + Math.random().toString(36).slice(2, 10);
  };

  Cls.prototype._paintManage = function _paintManage(container) {
    if (!container) return;
    container.innerHTML = '';
    container.classList.add('dawn-ht-manage');
    const cfg = this._config;
    if (!Array.isArray(cfg.categories)) cfg.categories = [{ id: 'default', name: 'Habits', order: 0 }];
    if (!Array.isArray(cfg.habits)) cfg.habits = [];
    if (!Array.isArray(cfg.tagOrder)) cfg.tagOrder = [];
    if (cfg.showDayNotes == null) cfg.showDayNotes = true;

    const persist = () => {
      this._saveConfig();
      this._paint();
    };

    const shell = globalThis.__dawnJhsShell;
    if (shell?.tabTogglesBlock) {
      try {
        container.appendChild(shell.tabTogglesBlock());
      } catch (_) {}
    }

    const addRow = document.createElement('div');
    addRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin:0 0 10px;flex-wrap:wrap;';
    const catName = document.createElement('input');
    catName.type = 'text';
    catName.placeholder = 'New category name';
    catName.style.cssText =
      'flex:1;min-width:140px;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(0,0,0,0.25);color:inherit;';
    const addCat = document.createElement('button');
    addCat.type = 'button';
    addCat.textContent = 'Add category';
    addCat.style.cssText =
      'padding:6px 10px;border-radius:6px;border:1px solid rgba(160,120,220,0.45);background:rgba(140,90,210,0.35);color:inherit;cursor:pointer;';
    addCat.addEventListener('click', () => {
      const name = catName.value.trim();
      if (!name) return;
      cfg.categories.push({
        id: 'c-' + Math.random().toString(36).slice(2, 8),
        name,
        icon: '',
        order: cfg.categories.length,
      });
      catName.value = '';
      persist();
    });
    addRow.append(catName, addCat);
    container.appendChild(addRow);

    const mkCheck = (label, checked, onChange) => {
      const lab = document.createElement('label');
      lab.style.cssText =
        'display:flex;align-items:center;gap:8px;font-size:12px;margin:0 0 8px;cursor:pointer;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!checked;
      cb.addEventListener('change', () => onChange(cb.checked));
      lab.append(cb, document.createTextNode(label));
      return lab;
    };
    container.appendChild(
      mkCheck('Hide habits on off-days (weekdays not scheduled)', cfg.hideOffDayHabits, (v) => {
        cfg.hideOffDayHabits = v;
        persist();
      })
    );
    container.appendChild(
      mkCheck('Show day notes field under habits', cfg.showDayNotes !== false, (v) => {
        cfg.showDayNotes = v;
        persist();
      })
    );

    const layoutWrap = document.createElement('div');
    layoutWrap.style.cssText = 'margin:0 0 12px;';
    const layoutLab = document.createElement('div');
    layoutLab.style.cssText =
      'font-size:11px;color:#8a7e6a;text-transform:uppercase;letter-spacing:0.06em;margin:0 0 6px;';
    layoutLab.textContent = 'Habit layout';
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;';
    const b1 = document.createElement('button');
    b1.type = 'button';
    b1.title = 'Single column';
    b1.innerHTML = '<i class="ti ti-layout-list"></i>';
    const b2 = document.createElement('button');
    b2.type = 'button';
    b2.title = 'Two columns';
    b2.innerHTML = '<i class="ti ti-columns"></i>';
    const paintLay = () => {
      b1.style.cssText = this._singleCol
        ? 'padding:4px 8px;border-radius:6px;border:1px solid rgba(160,120,220,0.5);background:rgba(140,90,210,0.35);color:inherit;'
        : 'padding:4px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:transparent;color:inherit;';
      b2.style.cssText = !this._singleCol
        ? 'padding:4px 8px;border-radius:6px;border:1px solid rgba(160,120,220,0.5);background:rgba(140,90,210,0.35);color:inherit;'
        : 'padding:4px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:transparent;color:inherit;';
    };
    b1.addEventListener('click', () => {
      this._singleCol = true;
      this._saveUiPrefs();
      persist();
    });
    b2.addEventListener('click', () => {
      this._singleCol = false;
      this._saveUiPrefs();
      persist();
    });
    paintLay();
    btnRow.append(b1, b2);
    layoutWrap.append(layoutLab, btnRow);
    container.appendChild(layoutWrap);

    const archived = cfg.habits.filter((h) => h.archived);
    const archDet = document.createElement('details');
    const archSum = document.createElement('summary');
    archSum.textContent = `Archived habits (${archived.length})`;
    archSum.style.cssText = 'cursor:pointer;font-size:13px;margin:0 0 8px;';
    archDet.appendChild(archSum);
    for (const h of archived) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;margin:0 0 4px;font-size:13px;';
      row.appendChild(document.createTextNode(h.name || '(untitled)'));
      const un = document.createElement('button');
      un.type = 'button';
      un.textContent = 'Restore';
      un.addEventListener('click', () => {
        h.archived = false;
        persist();
      });
      row.appendChild(un);
      archDet.appendChild(row);
    }
    container.appendChild(archDet);

    const catHead = document.createElement('div');
    catHead.style.cssText =
      'font-size:13px;font-weight:600;margin:16px 0 6px;';
    catHead.textContent = 'Categories';
    const catHint = document.createElement('div');
    catHint.style.cssText = 'font-size:11px;color:#8a7e6a;margin:0 0 8px;';
    catHint.textContent = 'Categories ↑ ↓ changes order everywhere (journal sections and the collapsed ribbon).';
    container.append(catHead, catHint);

    const cats = [...cfg.categories].sort((a, b) => (a.order || 0) - (b.order || 0));
    cats.forEach((c, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;align-items:center;margin:0 0 6px;';
      const up = document.createElement('button');
      up.type = 'button';
      up.textContent = '↑';
      up.disabled = i === 0;
      up.addEventListener('click', () => {
        const o = cats[i - 1];
        const t = c.order;
        c.order = o.order;
        o.order = t;
        persist();
      });
      const down = document.createElement('button');
      down.type = 'button';
      down.textContent = '↓';
      down.disabled = i === cats.length - 1;
      down.addEventListener('click', () => {
        const o = cats[i + 1];
        const t = c.order;
        c.order = o.order;
        o.order = t;
        persist();
      });
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = c.name;
      inp.style.cssText =
        'flex:1;padding:5px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(0,0,0,0.25);color:inherit;';
      inp.addEventListener('change', () => {
        c.name = inp.value.trim() || c.name;
        persist();
      });
      row.append(up, down, inp);
      if (c.id !== 'default') {
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.textContent = '×';
        rm.addEventListener('click', () => {
          cfg.categories = cfg.categories.filter((x) => x.id !== c.id);
          for (const h of cfg.habits) {
            if (h.categoryId === c.id) h.categoryId = 'default';
          }
          persist();
        });
        row.appendChild(rm);
      }
      container.appendChild(row);
    });

    const tagHead = document.createElement('div');
    tagHead.style.cssText = 'font-size:13px;font-weight:600;margin:16px 0 4px;';
    tagHead.textContent = 'Tags';
    const tagHint = document.createElement('div');
    tagHint.style.cssText = 'font-size:11px;color:#8a7e6a;margin:0 0 8px;';
    tagHint.textContent = 'Reorder affects tag filter / picker order. × removes tag from every habit.';
    container.append(tagHead, tagHint);
    cfg.tagOrder.forEach((t, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;align-items:center;margin:0 0 4px;';
      const up = document.createElement('button');
      up.type = 'button';
      up.textContent = '↑';
      up.disabled = i === 0;
      up.addEventListener('click', () => {
        const arr = cfg.tagOrder;
        [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
        persist();
      });
      const down = document.createElement('button');
      down.type = 'button';
      down.textContent = '↓';
      down.disabled = i === cfg.tagOrder.length - 1;
      down.addEventListener('click', () => {
        const arr = cfg.tagOrder;
        [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
        persist();
      });
      const lab = document.createElement('span');
      lab.textContent = t;
      lab.style.flex = '1';
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = '×';
      rm.addEventListener('click', () => {
        cfg.tagOrder = cfg.tagOrder.filter((x) => x !== t);
        for (const h of cfg.habits) h.tags = (h.tags || []).filter((x) => x !== t);
        persist();
      });
      row.append(up, down, lab, rm);
      container.appendChild(row);
    });

    const addHabit = document.createElement('button');
    addHabit.type = 'button';
    addHabit.textContent = '+ Add habit';
    addHabit.style.cssText =
      'margin:14px 0 10px;padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.04);color:inherit;cursor:pointer;';
    addHabit.addEventListener('click', () => {
      cfg.habits.push(
        this._normalizeHabitRow({
          id: this._newHabitId(),
          name: 'New habit',
          categoryId: cats[0]?.id || 'default',
          order: cfg.habits.length,
        })
      );
      persist();
    });
    container.appendChild(addHabit);

    const live = cfg.habits.filter((h) => !h.archived).sort((a, b) => (a.order || 0) - (b.order || 0));
    for (const h of live) {
      container.appendChild(this._manageHabitCard(h, cfg, persist));
    }

    const done = document.createElement('button');
    done.type = 'button';
    done.textContent = 'Done editing';
    done.style.cssText =
      'margin:16px 0 8px;padding:7px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.16);background:rgba(255,255,255,0.06);color:inherit;cursor:pointer;';
    done.addEventListener('click', () => this._toggleManage());
    container.appendChild(done);
  };

  Cls.prototype._manageHabitCard = function _manageHabitCard(h, cfg, persist) {
    const card = document.createElement('div');
    card.style.cssText =
      'border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:10px;margin:0 0 10px;background:rgba(0,0,0,0.18);';
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0 0 8px;';
    const nameIn = document.createElement('input');
    nameIn.type = 'text';
    nameIn.value = h.name;
    nameIn.style.cssText =
      'flex:1;min-width:120px;padding:5px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(0,0,0,0.25);color:inherit;';
    nameIn.addEventListener('change', () => {
      h.name = nameIn.value.trim() || h.name;
      persist();
    });
    const catSel = document.createElement('select');
    catSel.style.cssText =
      'padding:5px 6px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(0,0,0,0.25);color:inherit;';
    for (const c of cfg.categories) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      if (c.id === h.categoryId) o.selected = true;
      catSel.appendChild(o);
    }
    catSel.addEventListener('change', () => {
      h.categoryId = catSel.value;
      persist();
    });
    const arch = document.createElement('button');
    arch.type = 'button';
    arch.textContent = 'Archive';
    arch.addEventListener('click', () => {
      h.archived = true;
      persist();
    });
    top.append(nameIn, catSel, arch);
    card.appendChild(top);

    const tagsDet = document.createElement('details');
    tagsDet.open = true;
    const tagsSum = document.createElement('summary');
    tagsSum.textContent = 'Tags';
    tagsSum.style.cursor = 'pointer';
    tagsDet.appendChild(tagsSum);
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:10px;color:#8a7e6a;margin:4px 0;';
    hint.textContent = 'Ctrl/Cmd-click for multiple.';
    const sel = document.createElement('select');
    sel.multiple = true;
    sel.size = Math.min(4, Math.max(2, cfg.tagOrder.length || 2));
    sel.style.cssText = 'width:100%;background:rgba(0,0,0,0.25);color:inherit;border:1px solid rgba(255,255,255,0.12);';
    const paintTags = () => {
      sel.innerHTML = '';
      for (const t of cfg.tagOrder) {
        const o = document.createElement('option');
        o.value = t;
        o.textContent = t;
        if ((h.tags || []).includes(t)) o.selected = true;
        sel.appendChild(o);
      }
    };
    paintTags();
    sel.addEventListener('change', () => {
      h.tags = Array.from(sel.selectedOptions).map((o) => o.value);
      persist();
    });
    const addWrap = document.createElement('div');
    addWrap.style.cssText = 'display:flex;gap:6px;margin:6px 0 0;';
    const newTag = document.createElement('input');
    newTag.placeholder = 'New tag…';
    newTag.style.cssText =
      'flex:1;padding:4px 6px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(0,0,0,0.25);color:inherit;';
    const addT = document.createElement('button');
    addT.type = 'button';
    addT.textContent = 'Add';
    addT.addEventListener('click', () => {
      const raw = newTag.value.trim();
      if (!raw) return;
      if (!cfg.tagOrder.includes(raw)) cfg.tagOrder.push(raw);
      if (!(h.tags || []).includes(raw)) (h.tags || (h.tags = [])).push(raw);
      newTag.value = '';
      persist();
    });
    addWrap.append(newTag, addT);
    tagsDet.append(hint, sel, addWrap);
    card.appendChild(tagsDet);

    const adv = document.createElement('details');
    adv.open = true;
    const advSum = document.createElement('summary');
    advSum.textContent = 'Schedule, target & streak seed';
    advSum.style.cursor = 'pointer';
    adv.appendChild(advSum);
    const grid = document.createElement('div');
    grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;margin-top:8px;';

    const mkField = (label, el) => {
      const lab = document.createElement('label');
      lab.style.cssText = 'display:flex;flex-direction:column;gap:2px;font-size:10px;color:#8a7e6a;';
      lab.appendChild(document.createTextNode(label));
      lab.appendChild(el);
      return lab;
    };
    const targetIn = document.createElement('input');
    targetIn.type = 'number';
    targetIn.min = '0';
    targetIn.value = h.target > 0 ? String(h.target) : '';
    targetIn.style.width = '72px';
    targetIn.addEventListener('change', () => {
      const n = parseInt(targetIn.value, 10);
      h.target = Number.isInteger(n) && n > 0 ? n : 0;
      h.type = h.target > 0 ? 'number' : 'bool';
      persist();
    });
    const unitIn = document.createElement('input');
    unitIn.placeholder = 'mins, reps…';
    unitIn.value = h.unit || '';
    unitIn.addEventListener('change', () => {
      h.unit = unitIn.value.trim();
      persist();
    });
    const startIn = document.createElement('input');
    startIn.type = 'date';
    startIn.value = h.startDate || '';
    startIn.addEventListener('change', () => {
      h.startDate = startIn.value || '';
      persist();
    });
    const seedIn = document.createElement('input');
    seedIn.type = 'date';
    seedIn.value = h.streakSeed || '';
    seedIn.addEventListener('change', () => {
      h.streakSeed = seedIn.value || '';
      persist();
    });
    grid.append(
      mkField('Daily target (0 = checkbox)', targetIn),
      mkField('Unit', unitIn),
      mkField('Start date', startIn),
      mkField('Streak seed date', seedIn)
    );

    const wdWrap = document.createElement('div');
    wdWrap.style.cssText = 'flex:1 1 100%;';
    const wdLbl = document.createElement('div');
    wdLbl.style.cssText = 'font-size:10px;color:#8a7e6a;margin:0 0 4px;';
    wdLbl.textContent = 'Weekdays (none = every day)';
    const wdRow = document.createElement('div');
    wdRow.style.cssText = 'display:flex;gap:3px;flex-wrap:wrap;';
    const labels = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    const wdSel = new Set(h.weekdays || []);
    for (let i = 0; i < 7; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = labels[i];
      const on = wdSel.has(i);
      b.style.cssText = on
        ? 'padding:2px 6px;border-radius:4px;border:1px solid rgba(61,143,88,0.5);background:rgba(61,143,88,0.2);color:inherit;'
        : 'padding:2px 6px;border-radius:4px;border:1px solid rgba(255,255,255,0.12);background:transparent;color:inherit;';
      b.addEventListener('click', () => {
        if (wdSel.has(i)) wdSel.delete(i);
        else wdSel.add(i);
        h.weekdays = [...wdSel].sort((a, b) => a - b);
        persist();
      });
      wdRow.appendChild(b);
    }
    wdWrap.append(wdLbl, wdRow);
    grid.appendChild(wdWrap);

    const pin = document.createElement('label');
    pin.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;flex:1 1 100%;';
    const pinCb = document.createElement('input');
    pinCb.type = 'checkbox';
    pinCb.checked = !!h.quickAccess;
    pinCb.addEventListener('change', () => {
      h.quickAccess = pinCb.checked;
      persist();
    });
    pin.append(pinCb, document.createTextNode('Pin to quick access (status bar)'));
    grid.appendChild(pin);
    adv.appendChild(grid);
    card.appendChild(adv);
    return card;
  };
}

if (typeof DawnHabitsEngine === 'function') dawnMixInHabitManage(DawnHabitsEngine);
/**
 * Quick-access habits — status-bar flame + frosted popover (prod htq-* chrome).
 * Config-only / LS paint; toggles reuse DawnHabitsEngine mark/done paths. No nav I/O.
 */

function dawnMixInHabitQuickAccess(Cls) {
  if (!Cls || Cls.prototype._refreshQuickAccess) return;

  const CSS = `
  .htq-anchor { display:inline-flex;width:18px;height:18px;align-items:center;justify-content:center;line-height:0;vertical-align:middle;cursor:pointer;opacity:.88; }
  .htq-anchor .ti { font-size:14px;line-height:1; }
  .htq-shell { position:fixed;z-index:200000;display:flex;max-width:min(320px,calc(100vw - 16px));pointer-events:auto; }
  .htq-shell--bottom { flex-direction:column;align-items:flex-start; }
  .htq-card { min-width:200px;max-width:min(320px,calc(100vw - 16px));max-height:min(340px,52vh);overflow-y:auto;padding:8px 10px;border-radius:12px;border:1px solid color-mix(in srgb,CanvasText 14%,transparent);background:color-mix(in srgb,Canvas 42%,transparent);color:CanvasText;-webkit-backdrop-filter:blur(18px) saturate(1.25);backdrop-filter:blur(18px) saturate(1.25);box-shadow:0 0 0 1px color-mix(in srgb,CanvasText 8%,transparent),0 -6px 28px color-mix(in srgb,CanvasText 18%,transparent),0 0 22px color-mix(in srgb,Highlight 24%,transparent); }
  .htq-head { display:flex;align-items:center;gap:6px;margin-bottom:8px;min-height:22px; }
  .htq-back { display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:6px;background:transparent;color:inherit;cursor:pointer;opacity:.75; }
  .htq-back:hover { opacity:1; }
  .htq-title { flex:1;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:color-mix(in srgb,CanvasText 62%,transparent); }
  .htq-date { display:inline-flex;align-items:center;gap:0;margin-left:auto;flex-shrink:0; }
  .htq-date .ht-nav-btn { width:14px;height:14px;padding:0;margin:0 -2px;opacity:.55;font-size:11px;line-height:1; appearance:none;border:none;background:transparent;color:inherit;cursor:pointer; }
  .htq-date .ht-nav-btn .ti { font-size:12px;line-height:1; }
  .htq-date .ht-nav-btn:hover { opacity:1; }
  .htq-date .ht-date-label { font-size:11px;min-width:0;padding:0 2px;text-align:center;color:color-mix(in srgb,CanvasText 72%,transparent);cursor:pointer; }
  .htq-cats { display:flex;flex-wrap:wrap;gap:6px;justify-content:center; }
  .htq-cat-btn { display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:none;border-radius:8px;background:transparent;color:inherit;cursor:pointer;opacity:.86; }
  .htq-cat-btn:hover { opacity:1;background:color-mix(in srgb,CanvasText 8%,transparent); }
  .htq-cat-btn .ti { font-size:16px;line-height:1; }
  .htq-habits { display:flex;flex-direction:column;gap:4px; }
  .htq-habit { display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border:none;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer; }
  .htq-habit:hover { background:color-mix(in srgb,CanvasText 8%,transparent); }
  .htq-habit-mark { flex-shrink:0;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;border:1px solid color-mix(in srgb,CanvasText 22%,transparent);font-size:10px;font-weight:600;font-variant-numeric:tabular-nums; }
  .htq-habit-mark.is-done { border-color:rgba(76,175,80,0.55);background:rgba(76,175,80,0.18);color:#8fd49a; }
  .htq-habit-mark.is-partial { border-color:rgba(72,150,112,0.45);color:#9fd4b0; }
  .htq-habit-mark.is-fail { color:#e57373;border-color:rgba(229,115,115,0.45); }
  .htq-habit-mark.is-na { color:#c8a548;border-color:rgba(200,165,72,0.45); }
  .htq-habit-name { flex:1;min-width:0;line-height:1.25; }
  `;

  Cls.prototype._pinnedHabits = function _pinnedHabits() {
    return (this._config?.habits || []).filter((h) => h && !h.archived && h.quickAccess);
  };

  Cls.prototype._quickAccessGroups = function _quickAccessGroups() {
    const pinned = this._pinnedHabits();
    if (!pinned.length) return [];
    const cats = [...(this._config?.categories || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
    const groups = [];
    for (const cat of cats) {
      const habits = pinned
        .filter((h) => this._habitCategoryId(h.name) === cat.id || h.categoryId === cat.id)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      if (habits.length) groups.push({ cat, habits });
    }
    const known = new Set(cats.map((c) => c.id));
    const orphan = pinned.filter((h) => {
      const id = h.categoryId || this._habitCategoryId(h.name);
      return !known.has(id);
    });
    if (orphan.length) {
      groups.push({
        cat: { id: '__orphan__', name: 'Other', icon: 'folder', order: 9999 },
        habits: orphan.sort((a, b) => (a.order || 0) - (b.order || 0)),
      });
    }
    return groups;
  };

  Cls.prototype._injectQuickAccessCss = function _injectQuickAccessCss() {
    if (document.querySelector('style[data-dawn-htq]')) return;
    const el = document.createElement('style');
    el.setAttribute('data-dawn-htq', '1');
    el.textContent = CSS;
    document.head.appendChild(el);
  };

  Cls.prototype._closeQuickPopover = function _closeQuickPopover() {
    try {
      this._htqDocClose && document.removeEventListener('mousedown', this._htqDocClose, true);
    } catch (_) {}
    this._htqDocClose = null;
    try {
      this._htqKeyClose && document.removeEventListener('keydown', this._htqKeyClose, true);
    } catch (_) {}
    this._htqKeyClose = null;
    try {
      this._htQuickPopoverEl?.remove();
    } catch (_) {}
    this._htQuickPopoverEl = null;
    this._htQuickPopoverViewCatId = null;
  };

  Cls.prototype._clearQuickAccessAnchors = function _clearQuickAccessAnchors() {
    this._closeQuickPopover();
    try {
      this._htQuickStatusItem?.destroy?.();
    } catch (_) {}
    try {
      this._htQuickStatusItem?.remove?.();
    } catch (_) {}
    this._htQuickStatusItem = null;
    try {
      this._htQuickSidebarItem?.destroy?.();
    } catch (_) {}
    try {
      this._htQuickSidebarItem?.remove?.();
    } catch (_) {}
    this._htQuickSidebarItem = null;
  };

  Cls.prototype._quickAnchorHtml = function _quickAnchorHtml() {
    return '<span class="htq-anchor" title="Quick habits"><i class="ti ti-flame" aria-hidden="true"></i></span>';
  };

  Cls.prototype._refreshQuickAccess = function _refreshQuickAccess() {
    // Parked: no Quick habits status-bar flame / popover for now.
    this._clearQuickAccessAnchors();
  };

  Cls.prototype._toggleQuickPopover = function _toggleQuickPopover(anchorEl) {
    if (this._htQuickPopoverEl) {
      this._closeQuickPopover();
      return;
    }
    this._openQuickPopover(anchorEl);
  };

  Cls.prototype._quickDayKey = function _quickDayKey() {
    if (this._htQuickPopoverDateStr) return this._htQuickPopoverDateStr;
    if (this._dayKey) return this._dayKey;
    const t = new Date();
    return (
      t.getFullYear() +
      '-' +
      String(t.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(t.getDate()).padStart(2, '0')
    );
  };

  Cls.prototype._habitDoneForQuick = function _habitDoneForQuick(h, dayKey) {
    const mark = this._habitMark?.(dayKey, h.name);
    if (mark === 'fail' || mark === 'na') return mark;
    const cfg = this._habitCfg?.(h.name) || h;
    const numeric = cfg.type === 'number';
    const target = numeric ? Math.max(1, Number(cfg.target) || 8) : 0;
    const val = numeric ? this._habitValue?.(dayKey, h.name) || 0 : 0;
    if (numeric && !mark && val > 0 && val < target) return { partial: val };
    const entries = this._dayEntries?.(dayKey) || [];
    let done = !!(this._lsDone?.(dayKey, h.name));
    for (const e of entries) {
      for (const row of e.habits || []) {
        if (String(row.name || '').trim().toLowerCase() === String(h.name || '').trim().toLowerCase() && row.done) {
          done = true;
        }
      }
    }
    if (numeric && !mark && val >= target) done = true;
    return done;
  };

  Cls.prototype._quickMarkHtml = function _quickMarkHtml(h, dayKey) {
    const state = this._habitDoneForQuick(h, dayKey);
    if (state === 'fail') return '<span class="htq-habit-mark is-fail" aria-hidden="true">×</span>';
    if (state === 'na') return '<span class="htq-habit-mark is-na" aria-hidden="true">/</span>';
    if (state && typeof state === 'object' && state.partial != null) {
      return `<span class="htq-habit-mark is-partial" aria-hidden="true">${state.partial}</span>`;
    }
    if (state) {
      return '<span class="htq-habit-mark is-done" aria-hidden="true"><i class="ti ti-check" aria-hidden="true"></i></span>';
    }
    return '<span class="htq-habit-mark" aria-hidden="true"></span>';
  };

  Cls.prototype._openQuickPopover = function _openQuickPopover(anchorEl) {
    const groups = this._quickAccessGroups();
    if (!groups.length) return;
    this._htQuickPopoverDateStr = this._quickDayKey();
    if (groups.length === 1) this._htQuickPopoverViewCatId = groups[0].cat.id;
    else this._htQuickPopoverViewCatId = this._htQuickPopoverViewCatId || null;

    const shell = document.createElement('div');
    shell.className = 'htq-shell htq-shell--bottom';
    const card = document.createElement('div');
    card.className = 'htq-card';
    shell.appendChild(card);
    document.body.appendChild(shell);
    this._htQuickPopoverEl = shell;
    this._fillQuickCard(card, groups);
    this._positionQuickPopover(anchorEl || this._htQuickStatusItem?.getElement?.());

    this._htqDocClose = (ev) => {
      if (!shell.contains(ev.target) && !ev.target?.closest?.('.htq-anchor')) {
        this._closeQuickPopover();
      }
    };
    this._htqKeyClose = (ev) => {
      if (ev.key === 'Escape') this._closeQuickPopover();
    };
    setTimeout(() => {
      document.addEventListener('mousedown', this._htqDocClose, true);
      document.addEventListener('keydown', this._htqKeyClose, true);
    }, 0);
  };

  Cls.prototype._fillQuickCard = function _fillQuickCard(card, groups) {
    card.innerHTML = '';
    const dayKey = this._quickDayKey();
    const viewId = this._htQuickPopoverViewCatId;
    const group = viewId ? groups.find((g) => g.cat.id === viewId) : null;

    if (!group) {
      const head = document.createElement('div');
      head.className = 'htq-head';
      const title = document.createElement('div');
      title.className = 'htq-title';
      title.textContent = 'Quick habits';
      head.appendChild(title);
      this._appendQuickDateNav(head);
      card.appendChild(head);
      const cats = document.createElement('div');
      cats.className = 'htq-cats';
      for (const g of groups) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'htq-cat-btn';
        btn.title = `${g.cat.name || 'Category'} (${g.habits.length})`;
        const icon = String(g.cat.icon || '').trim();
        if (icon && /^[a-z0-9-]+$/i.test(icon)) {
          btn.innerHTML = `<i class="ti ti-${icon}" aria-hidden="true"></i>`;
        } else {
          btn.textContent = '🔥';
        }
        btn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this._htQuickPopoverViewCatId = g.cat.id;
          this._fillQuickCard(card, groups);
          this._positionQuickPopover(this._htQuickStatusItem?.getElement?.());
        });
        cats.appendChild(btn);
      }
      card.appendChild(cats);
      return;
    }

    const head = document.createElement('div');
    head.className = 'htq-head';
    if (groups.length > 1) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'htq-back';
      back.title = 'Back to categories';
      back.innerHTML = '<i class="ti ti-chevron-left" aria-hidden="true"></i>';
      back.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this._htQuickPopoverViewCatId = null;
        this._fillQuickCard(card, groups);
        this._positionQuickPopover(this._htQuickStatusItem?.getElement?.());
      });
      head.appendChild(back);
    }
    const title = document.createElement('div');
    title.className = 'htq-title';
    title.textContent = group.cat.name || 'Habits';
    head.appendChild(title);
    this._appendQuickDateNav(head);
    card.appendChild(head);

    const list = document.createElement('div');
    list.className = 'htq-habits';
    for (const h of group.habits) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'htq-habit';
      btn.title = numeric ? `${h.name} — tap to count · long-press to enter a number` : `${h.name} — tap to toggle`;
      const paint = () => {
        btn.innerHTML =
          this._quickMarkHtml(h, this._quickDayKey()) +
          `<span class="htq-habit-name">${String(h.name || '').replace(/</g, '&lt;')}</span>`;
      };
      paint();
      let pressTimer = null;
      let didLong = false;
      let pressX = 0;
      let pressY = 0;
      const cfg = this._habitCfg?.(h.name) || h;
      const numeric = cfg.type === 'number';
      const target = Math.max(1, Number(cfg.target) || 8);
      const clearPress = () => {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      };
      btn.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0 || !numeric) return;
        if (ev.target?.closest?.('.ht-num-input, .ht-num-btn')) return;
        didLong = false;
        pressX = ev.clientX;
        pressY = ev.clientY;
        clearPress();
        pressTimer = setTimeout(() => {
          pressTimer = null;
          didLong = true;
          this._showNumericInput?.(btn, h, target);
        }, 500);
      });
      btn.addEventListener('pointermove', (ev) => {
        if (!pressTimer) return;
        const thresh = ev.pointerType === 'touch' ? 12 : 8;
        if (Math.abs(ev.clientX - pressX) > thresh || Math.abs(ev.clientY - pressY) > thresh) clearPress();
      });
      btn.addEventListener('pointerup', clearPress);
      btn.addEventListener('pointercancel', clearPress);
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (didLong || btn.querySelector?.('.ht-num-input')) {
          didLong = false;
          return;
        }
        const key = this._quickDayKey();
        const prev = this._dayKey;
        this._dayKey = key;
        try {
          if (numeric) await this._tapNumericHabit?.(h, target);
          else await this._toggleHabit?.(h);
        } finally {
          this._dayKey = prev || key;
        }
        paint();
        try { this._paint?.(); } catch (_) {}
      });
      list.appendChild(btn);
    }
    card.appendChild(list);
  };

  Cls.prototype._appendQuickDateNav = function _appendQuickDateNav(head) {
    const nav = document.createElement('div');
    nav.className = 'htq-date';
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'ht-nav-btn';
    prev.innerHTML = '<i class="ti ti-chevron-left" aria-hidden="true"></i>';
    const label = document.createElement('span');
    label.className = 'ht-date-label';
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'ht-nav-btn';
    next.innerHTML = '<i class="ti ti-chevron-right" aria-hidden="true"></i>';
    const sync = () => {
      label.textContent = this._formatDayLabel?.(this._quickDayKey()) || this._quickDayKey();
    };
    sync();
    prev.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._htQuickPopoverDateStr = this._shiftDay(this._quickDayKey(), -1);
      const card = this._htQuickPopoverEl?.querySelector('.htq-card');
      if (card) this._fillQuickCard(card, this._quickAccessGroups());
    });
    next.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._htQuickPopoverDateStr = this._shiftDay(this._quickDayKey(), 1);
      const card = this._htQuickPopoverEl?.querySelector('.htq-card');
      if (card) this._fillQuickCard(card, this._quickAccessGroups());
    });
    label.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const t = new Date();
      this._htQuickPopoverDateStr =
        t.getFullYear() +
        '-' +
        String(t.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(t.getDate()).padStart(2, '0');
      const card = this._htQuickPopoverEl?.querySelector('.htq-card');
      if (card) this._fillQuickCard(card, this._quickAccessGroups());
    });
    nav.append(prev, label, next);
    head.appendChild(nav);
  };

  Cls.prototype._positionQuickPopover = function _positionQuickPopover(anchorEl) {
    const shell = this._htQuickPopoverEl;
    if (!shell) return;
    const gap = 4;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    shell.style.visibility = 'hidden';
    shell.style.left = '0';
    shell.style.top = '0';
    const sw = shell.offsetWidth;
    const sh = shell.offsetHeight;
    shell.style.visibility = '';
    let left = margin;
    let top = margin;
    if (anchorEl?.getBoundingClientRect) {
      const r = anchorEl.getBoundingClientRect();
      left = Math.max(margin, Math.min(r.left + r.width / 2 - sw / 2, vw - sw - margin));
      top = r.top - sh - gap;
      if (top < margin) top = r.bottom + gap;
      top = Math.max(margin, Math.min(top, vh - sh - margin));
    } else {
      left = Math.max(margin, (vw - sw) / 2);
      top = Math.max(margin, vh - sh - 48);
    }
    shell.style.left = `${left}px`;
    shell.style.top = `${top}px`;
  };
}

if (typeof DawnHabitsEngine === 'function') dawnMixInHabitQuickAccess(DawnHabitsEngine);
