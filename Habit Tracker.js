/**
 * HabitTracker — Standalone CollectionPlugin
 *
 * Data model (all stored as records in own collection):
 *   - One "config" record (title: "__config__") — stores categories/habits as JSON in `data`
 *   - One "log" record per date (title: "log-YYYY-MM-DD") — stores completions as JSON in `data`
 *
 * Config JSON shape:
 *   { categories: [ { id, name, emoji, order }, ... ], habits: [ { id, name, categoryId, order }, ... ] }
 *
 * Log JSON shape:
 *   { date: "YYYY-MM-DD", completions: { habitId: true, ... }, categoryDone: { categoryId: true, ... } }
 *
 * Streaks are calculated on-the-fly by scanning log records.
 */


// ─── CSS ─────────────────────────────────────────────────────────────────────
const HT_CSS = `
  /* ── Sidebar panel wrapper ──
     Frosted glass look matching Backreferences / Today's Notes.
     Sits as an overlay on the right edge of the page content area.
  ── */
  .ht-sidebar {
    /* inline card — sits in the page content flow like Backreferences */
    display: block;
    width: 100%;
    margin: 0 0 16px 0;
    background: rgba(30, 28, 36, 0.65);
    backdrop-filter: blur(18px) saturate(1.4);
    -webkit-backdrop-filter: blur(18px) saturate(1.4);
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 12px;
    overflow: hidden;
    font-family: var(--font-family, sans-serif);
    font-size: 13px;
    color: #e8e0d0;
  }
  .ht-sidebar.ht-collapsed .ht-sidebar-body {
    display: none;
  }

  /* ── Header ── */
  .ht-sidebar-header {
    display: flex;
    align-items: center;
    padding: 10px 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    gap: 8px;
    min-height: 40px;
  }
  .ht-toggle-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: #8a7e6a;
    padding: 0 2px;
    font-size: 15px;
    font-weight: 600;
    line-height: 1;
    flex-shrink: 0;
    transition: color 0.1s;
    min-width: 16px;
    text-align: center;
  }
  .ht-toggle-btn:hover { color: #e8e0d0; }
  .ht-nav-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: #8a7e6a;
    font-size: 16px;
    line-height: 1;
    padding: 0 3px;
    border-radius: 4px;
    flex-shrink: 0;
    transition: color 0.1s;
  }
  .ht-nav-btn:hover { color: #e8e0d0; background: rgba(255,255,255,0.07); }
  .ht-sidebar-title {
    font-weight: 700;
    font-size: 13px;
    color: #e8e0d0;
    white-space: nowrap;
    flex: 1;
  }
  .ht-date-label {
    font-size: 12px;
    color: #8a7e6a;
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* collapsed state — just hide the body, header stays visible */
  .ht-sidebar.ht-collapsed .ht-sidebar-header {
    border-bottom: none;
  }

  /* ── Body ── */
  .ht-sidebar-body {
    padding: 8px 0 12px;
  }
  .ht-sidebar-cats {
    transition: opacity 0.1s ease;
  }
  .ht-sidebar-cats.ht-fading { opacity: 0; }
  .ht-stats-content {
    transition: opacity 0.12s ease;
  }
  .ht-stats-content.ht-fading { opacity: 0; }

  /* ── Progress bar ── */
  .ht-progress {
    margin: 4px 14px 8px;
    height: 2px;
    background: rgba(255,255,255,0.08);
    border-radius: 2px;
    overflow: hidden;
  }
  .ht-progress-fill {
    height: 100%;
    background: #4caf50;
    border-radius: 2px;
    transition: width 0.35s ease;
  }

  /* ── Category block ── */
  .ht-category {
    margin: 0 0 1px 0;
  }
  .ht-category-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    cursor: pointer;
    border-radius: 5px;
    margin: 0 4px;
    user-select: none;
    transition: background 0.1s;
  }
  .ht-category-header:hover { background: rgba(255,255,255,0.06); }
  .ht-category-caret {
    font-size: 8px;
    color: #8a7e6a;
    width: 10px;
    flex-shrink: 0;
    transition: transform 0.15s;
  }
  .ht-category-caret.open { transform: rotate(90deg); }
  .ht-category-emoji { font-size: 13px; }
  .ht-category-name {
    font-weight: 600;
    font-size: 12px;
    color: #e8e0d0;
    flex: 1;
    letter-spacing: 0.01em;
  }
  .ht-cat-done { color: #4caf50; font-size: 11px; }
  .ht-cat-pending { color: rgba(255,255,255,0.2); font-size: 11px; }
  .ht-streak-badge {
    font-size: 10px;
    color: #8a7e6a;
    background: rgba(255,255,255,0.06);
    border-radius: 10px;
    padding: 1px 5px;
    white-space: nowrap;
    border: 1px solid rgba(255,255,255,0.07);
  }
  .ht-category-habits {
    padding: 1px 4px 5px 22px;
  }
  .ht-category-habits.ht-hidden { display: none; }

  /* ── Habit row ── */
  .ht-habit {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.1s;
  }
  .ht-habit:hover { background: rgba(255,255,255,0.05); }
  .ht-habit-check {
    width: 16px;
    height: 16px;
    border: 1.5px solid rgba(255,255,255,0.2);
    border-radius: 50%;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
    font-size: 9px;
    color: transparent;
  }
  .ht-habit.ht-done .ht-habit-check {
    background: rgba(76,175,80,0.18);
    border-color: #4caf50;
    color: #4caf50;
  }
  .ht-habit-name {
    flex: 1;
    color: #e8e0d0;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ht-habit.ht-done .ht-habit-name {
    color: #8a7e6a;
    text-decoration: line-through;
    text-decoration-color: rgba(138,126,106,0.5);
  }
  .ht-habit-streak {
    font-size: 10px;
    color: #8a7e6a;
    white-space: nowrap;
  }
  .ht-habit-streak.hot { color: #ff9800; }

  /* ── Empty state ── */
  .ht-empty {
    padding: 24px 14px;
    text-align: center;
    color: #8a7e6a;
    font-size: 12px;
    line-height: 1.7;
  }
  .ht-empty-icon { font-size: 22px; margin-bottom: 8px; opacity: 0.7; }
  .ht-setup-btn {
    margin-top: 10px;
    padding: 5px 14px;
    background: rgba(124,106,247,0.25);
    color: #c4b8ff;
    border: 1px solid rgba(124,106,247,0.4);
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    transition: background 0.15s;
  }
  .ht-setup-btn:hover { background: rgba(124,106,247,0.38); }

  /* ── Settings modal — also frosted ── */
  .ht-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.55);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .ht-modal {
    background: rgba(28, 26, 34, 0.92);
    backdrop-filter: blur(24px) saturate(1.5);
    -webkit-backdrop-filter: blur(24px) saturate(1.5);
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 12px;
    width: 520px;
    max-width: 96vw;
    max-height: 82vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 24px 64px rgba(0,0,0,0.6);
    color: #e8e0d0;
  }
  .ht-modal-header {
    display: flex;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid rgba(255,255,255,0.07);
    flex-shrink: 0;
  }
  .ht-modal-title { font-weight: 700; font-size: 14px; flex: 1; color: #e8e0d0; }
  .ht-modal-close {
    background: none; border: none; cursor: pointer;
    color: #8a7e6a; font-size: 16px; padding: 2px 6px; border-radius: 4px;
  }
  .ht-modal-close:hover { background: rgba(255,255,255,0.07); color: #e8e0d0; }
  .ht-modal-body { overflow-y: auto; padding: 16px 20px; flex: 1; }
  .ht-modal-footer {
    padding: 12px 20px;
    border-top: 1px solid rgba(255,255,255,0.07);
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-shrink: 0;
  }
  .ht-btn {
    padding: 6px 14px;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: opacity 0.15s, background 0.15s;
  }
  .ht-btn-primary { background: rgba(124,106,247,0.85); color: #fff; }
  .ht-btn-primary:hover { background: rgba(124,106,247,1); }
  .ht-btn-secondary {
    background: rgba(255,255,255,0.07);
    color: #e8e0d0;
    border: 1px solid rgba(255,255,255,0.10);
  }
  .ht-btn-secondary:hover { background: rgba(255,255,255,0.12); }
  .ht-btn-danger { background: rgba(218,54,51,0.12); color: #f07070; border: 1px solid rgba(218,54,51,0.25); }
  .ht-btn-danger:hover { background: rgba(218,54,51,0.22); }
  .ht-btn-sm { padding: 3px 8px; font-size: 11px; }

  /* Settings form elements */
  .ht-section-title {
    font-weight: 600;
    font-size: 11px;
    color: #8a7e6a;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    margin: 16px 0 8px;
  }
  .ht-section-title:first-child { margin-top: 0; }
  .ht-cat-item, .ht-habit-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 6px;
    margin-bottom: 4px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.06);
  }
  .ht-item-emoji { font-size: 15px; width: 22px; text-align: center; flex-shrink: 0; }
  .ht-item-left { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .ht-item-name { font-size: 13px; color: #e8e0d0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ht-item-sub { font-size: 11px; color: #8a7e6a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ht-item-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .ht-add-row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  .ht-input {
    flex: 1;
    min-width: 0;
    padding: 5px 10px;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 6px;
    color: #e8e0d0;
    font-size: 13px;
    outline: none;
    transition: border-color 0.15s;
  }
  .ht-input:focus { border-color: rgba(124,106,247,0.7); }
  .ht-input::placeholder { color: #8a7e6a; }
  .ht-select {
    padding: 5px 8px;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 6px;
    color: #e8e0d0;
    font-size: 13px;
    outline: none;
    cursor: pointer;
  }
  .ht-select option { background: #1c1a22; }
  .ht-divider {
    height: 1px;
    background: rgba(255,255,255,0.07);
    margin: 14px 0;
  }

  /* ── Numeric habit ring & controls ── */
  .ht-habit-ring {
    position: relative;
    width: 22px;
    height: 22px;
    flex-shrink: 0;
  }
  .ht-habit-ring svg {
    position: absolute;
    top: 0; left: 0;
    transform: rotate(-90deg);
  }
  .ht-habit-ring-bg { fill: none; stroke: rgba(255,255,255,0.12); stroke-width: 2.5; }
  .ht-habit-ring-fill {
    fill: none;
    stroke: #4caf50;
    stroke-width: 2.5;
    stroke-linecap: round;
    transition: stroke-dashoffset 0.3s ease;
  }
  .ht-habit-ring-label {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 7px;
    font-weight: 700;
    color: #e8e0d0;
    line-height: 1;
  }
  .ht-habit.ht-done .ht-habit-ring-fill { stroke: #4caf50; }
  .ht-habit.ht-done .ht-habit-ring-label { color: #4caf50; }

  .ht-habit-num-row {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
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
    transition: background 0.1s;
    padding: 0;
    line-height: 1;
  }
  .ht-num-btn:hover { background: rgba(255,255,255,0.15); }
  .ht-num-val {
    font-size: 11px;
    color: #e8e0d0;
    min-width: 28px;
    text-align: center;
    cursor: pointer;
  }
  .ht-num-val.at-target { color: #4caf50; font-weight: 700; }
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

  /* ── Celebrate burst ── */
  @keyframes ht-burst {
    0%   { transform: scale(1);   opacity: 1; }
    40%  { transform: scale(1.35); opacity: 0.9; }
    100% { transform: scale(1);   opacity: 1; }
  }
  @keyframes ht-particle {
    0%   { transform: translate(0,0) scale(1); opacity: 1; }
    100% { transform: translate(var(--tx), var(--ty)) scale(0); opacity: 0; }
  }
  .ht-celebrating { animation: ht-burst 0.35s ease-out; }
  .ht-particle {
    position: absolute;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    pointer-events: none;
    animation: ht-particle 0.5s ease-out forwards;
  }

  /* ── Stats view ── */
  .ht-stats-view { padding: 12px 14px 20px; }
  .ht-stats-range {
    display: flex; gap: 4px; margin-bottom: 14px;
  }
  .ht-range-btn {
    padding: 3px 10px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.12);
    background: none; color: #8a7e6a; font-size: 11px; cursor: pointer; transition: all 0.15s;
  }
  .ht-range-btn.active, .ht-range-btn:hover {
    background: rgba(124,106,247,0.2); border-color: rgba(124,106,247,0.5); color: #c4b8ff;
  }
  .ht-stats-select {
    width: 100%; padding: 6px 10px; margin-bottom: 14px;
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
    border-radius: 8px; color: #e8e0d0; font-size: 12px; outline: none; cursor: pointer;
  }
  .ht-stats-select option { background: #1c1a22; }
  .ht-stat-cards {
    display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 14px;
  }
  .ht-stat-card {
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.07);
    border-radius: 10px; padding: 10px 12px;
  }
  .ht-stat-label { font-size: 10px; color: #8a7e6a; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
  .ht-stat-value { font-size: 22px; font-weight: 700; color: #e8e0d0; line-height: 1; }
  .ht-stat-unit { font-size: 11px; color: #8a7e6a; margin-top: 2px; }
  .ht-stat-card.accent .ht-stat-value { color: #4caf50; }
  .ht-stat-card.fire .ht-stat-value { color: #ff9800; }

  .ht-stats-section { margin-bottom: 16px; }
  .ht-stats-section-title {
    font-size: 11px; font-weight: 600; color: #8a7e6a;
    text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px;
  }

  /* ── 7-day strip ── */
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
    transition: all 0.15s; cursor: pointer;
  }
  .ht-cal-strip-circle:hover { transform: scale(1.1); background: rgba(255,255,255,0.12); }
  .ht-cal-strip-circle.done:hover { background: rgba(76,175,80,0.4) !important; }
  .ht-cal-strip-circle.done {
    background: rgba(76,175,80,0.25); border-color: #4caf50; color: #4caf50;
  }
  .ht-cal-strip-circle.partial {
    background: rgba(124,106,247,0.15); border-color: rgba(124,106,247,0.4); color: #c4b8ff;
  }
  .ht-cal-strip-date { font-size: 10px; color: #8a7e6a; }
  .ht-cal-strip-col.today .ht-cal-strip-date { color: #c4b8ff; }

  /* ── Monthly calendar grid ── */
  .ht-cal-month-view { }
  .ht-cal-month-nav {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 10px;
  }
  .ht-cal-nav-btn {
    background: none; border: none; cursor: pointer; color: #8a7e6a;
    font-size: 18px; padding: 0 6px; border-radius: 4px; line-height: 1;
    transition: color 0.1s;
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
    background: rgba(255,255,255,0.05); cursor: pointer;
    position: relative; transition: background 0.15s, transform 0.1s;
    max-width: 42px; max-height: 42px; margin: 0 auto; width: 100%;
  }
  .ht-cal-day:hover:not(.empty):not(.out-of-range) {
    transform: scale(1.08);
    background: rgba(255,255,255,0.1);
  }
  .ht-cal-day.clickable-done:hover { background: rgba(76,175,80,0.35) !important; }
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
    margin-top: 3px; flex-shrink: 0;
  }
  .ht-cal-day.done .ht-cal-day-dot { background: #4caf50; }
  .ht-cal-day.partial .ht-cal-day-dot { background: rgba(124,106,247,0.6); }
  .ht-cal-day-dot:empty { display: none; }
  /* Numeric value shown as small text below date */
  .ht-cal-day-val {
    font-size: 8px; color: #8a7e6a; line-height: 1; margin-top: 1px;
  }
  .ht-cal-day.done .ht-cal-day-val { color: #4caf50; }
  .ht-cal-day.partial .ht-cal-day-val { color: rgba(124,106,247,0.8); }

  /* Bar chart */
  .ht-barchart-wrap { position: relative; overflow: visible; }
  .ht-barchart { position: relative; height: 72px; display: flex; align-items: flex-end; gap: 2px; overflow: visible; margin-right: 30px; }
  .ht-bar-wrap { flex: 1; display: flex; align-items: flex-end; height: 100%; }
  .ht-bar {
    width: 100%; border-radius: 2px 2px 0 0;
    background: rgba(124,106,247,0.6); min-height: 2px;
    transition: height 0.3s ease;
  }
  .ht-bar.done { background: rgba(76,175,80,0.7); }
  .ht-bar-wrap { position: relative; }
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
    background: rgba(255,200,0,0.5); pointer-events: none;
  }
  .ht-target-label {
    position: absolute; right: -28px; font-size: 8px; color: rgba(255,200,0,0.85);
    line-height: 1; text-align: left;
    transform: translateY(-1px);
  }

  /* Category rate */
  .ht-cat-rate-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .ht-cat-rate-name { font-size: 12px; color: #e8e0d0; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ht-cat-rate-bar-wrap { width: 80px; height: 6px; background: rgba(255,255,255,0.08); border-radius: 3px; flex-shrink: 0; overflow: hidden; }
  .ht-cat-rate-bar { height: 100%; border-radius: 3px; background: #4caf50; transition: width 0.3s; }
  .ht-cat-rate-pct { font-size: 11px; color: #8a7e6a; width: 32px; text-align: right; flex-shrink: 0; }

  /* Stats / back button in header */
  .ht-search-wrap { flex:1; display:none; align-items:center; gap:4px; }
  .ht-stats-btn {
    background: none; border: none; cursor: pointer; color: #8a7e6a;
    font-size: 14px; padding: 2px 6px; border-radius: 6px; flex-shrink: 0;
    transition: all 0.15s; line-height: 1;
  }
  .ht-stats-btn:hover { color: #e8e0d0; background: rgba(255,255,255,0.07); }
  .ht-stats-btn.active {
    color: #e8e0d0; font-size: 16px; font-weight: 700;
    background: rgba(255,255,255,0.07);
  }

  /* ── Drag handles ── */
  .ht-drag-handle {
    color: #8a7e6a;
    font-size: 13px;
    cursor: grab;
    padding: 0 4px 0 2px;
    flex-shrink: 0;
    opacity: 0.5;
    transition: opacity 0.1s;
    user-select: none;
    line-height: 1;
  }
  .ht-habit-cb { width:14px;height:14px;flex-shrink:0;cursor:pointer;accent-color:#7c6af7; }
  .ht-habit-item.ht-selected { background:rgba(124,106,247,0.12) !important; border-color:rgba(124,106,247,0.3) !important; }
  .ht-bulk-bar {
    display:flex;align-items:center;gap:8px;padding:8px 12px;
    background:rgba(124,106,247,0.15);border:1px solid rgba(124,106,247,0.3);
    border-radius:8px;margin:4px 0;font-size:12px;color:#c4b8ff;
    position:sticky;top:0;z-index:2;flex-wrap:wrap;
  }
  .ht-habit-item:hover .ht-drag-handle,
  .ht-cat-item:hover .ht-drag-handle { opacity: 1; }
  .ht-drag-handle:active { cursor: grabbing; }
  .ht-habit-item.ht-dragging,
  .ht-cat-item.ht-dragging {
    opacity: 0.35;
    background: rgba(255,255,255,0.08);
  }
  .ht-habit-item.ht-drag-over,
  .ht-cat-item.ht-drag-over {
    border-color: rgba(124,106,247,0.6);
    background: rgba(124,106,247,0.08);
  }
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function htSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function htToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function htDaysBefore(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() - n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function htDaysAfter(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function htEsc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function htGenId() {
  return Math.random().toString(36).slice(2, 10);
}

// ─── Plugin ───────────────────────────────────────────────────────────────────
class Plugin extends CollectionPlugin {

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async onLoad() {
    this._panelStates = new Map();
    this._eventIds = [];
    this._collapsed = localStorage.getItem('ht_sidebar_collapsed') === 'true';
    this._catCollapsed = JSON.parse(localStorage.getItem('ht_cat_collapsed') || '{}');
    this._config = null;      // { categories: [], habits: [] }
    this._collection = null;

    this.ui.injectCSS(HT_CSS);

    // Command palette commands
    this._cmdSettings = this.ui.addCommandPaletteCommand({
      label: 'HabitTracker: Manage Habits & Categories',
      icon: 'ti-settings',
      onSelected: () => this.openSettings(),
    });

    this._cmdRefresh = this.ui.addCommandPaletteCommand({
      label: 'HabitTracker: Refresh Panel',
      icon: 'ti-refresh',
      onSelected: () => this.refreshAllPanels(),
    });

    this._cmdImport = this.ui.addCommandPaletteCommand({
      label: 'HabitTracker: Import from TickTick (xlsx)',
      icon: 'ti-upload',
      onSelected: () => this._openImporter(),
    });

    this._cmdCleanup = this.ui.addCommandPaletteCommand({
      label: 'HabitTracker: Delete empty log records',
      icon: 'ti-trash',
      onSelected: () => this._cleanEmptyLogs(),
    });

    this._cmdDiag = this.ui.addCommandPaletteCommand({
      label: 'HabitTracker: Diagnose collection (check console)',
      icon: 'ti-bug',
      onSelected: () => this._diagnose(),
    });


    // Load collection + config, then mount
    await this._loadCollection();
    await this._loadConfig();

    // Listen to panel events
    this._eventIds.push(this.events.on('panel.navigated', (ev) => this._onPanelChanged(ev.panel)));
    this._eventIds.push(this.events.on('panel.focused',   (ev) => this._onPanelChanged(ev.panel)));
    this._eventIds.push(this.events.on('panel.closed',    (ev) => this._onPanelClosed(ev.panel)));

    // Mount on initial load
    const panel = this.ui.getActivePanel();
    if (panel) this._onPanelChanged(panel);
    setTimeout(() => {
      const p = this.ui.getActivePanel();
      if (p) this._onPanelChanged(p);
    }, 300);
  }

  onUnload() {
    for (const id of this._eventIds || []) {
      try { this.events.off(id); } catch(e) {}
    }
    this._eventIds = [];
    this._cmdSettings?.remove?.();
    this._cmdRefresh?.remove?.();

    for (const [, state] of (this._panelStates || [])) {
      this._disposeState(state);
    }
    this._panelStates?.clear?.();
  }

  // ── Collection & Config ──────────────────────────────────────────────────

  async _loadCollection() {
    try {
      const collections = await this.data.getAllCollections();
      this._collection = collections.find(c => c.getName() === 'HabitTracker');
      if (!this._collection) {
        console.warn('[HabitTracker] Collection not found — check plugin name matches collection name');
      }
    } catch(e) {
      console.error('[HabitTracker] Error loading collection:', e);
    }
  }

  async _loadConfig() {
    if (!this._collection) return;
    try {
      const records = await this._collection.getAllRecords();
      const configRecord = records.find(r => r.getName() === '__config__');
      if (configRecord) {
        const raw = configRecord.prop('data')?.get?.() || configRecord.text?.('data') || '';
        if (raw) {
          this._config = JSON.parse(raw);
        }
      }
      if (!this._config) {
        this._config = { categories: [], habits: [] };
      }
    } catch(e) {
      console.error('[HabitTracker] Error loading config:', e);
      this._config = { categories: [], habits: [] };
    }
  }

  async _saveConfig() {
    if (!this._collection) return;
    try {
      const records = await this._collection.getAllRecords();
      let configRecord = records.find(r => r.getName() === '__config__');
      if (!configRecord) {
        const guid = this._collection.createRecord('__config__');
        await htSleep(200);
        const updated = await this._collection.getAllRecords();
        configRecord = updated.find(r => r.guid === guid);
      }
      if (configRecord) {
        const typeProp = configRecord.prop('record_type');
        if (typeProp) typeProp.set('config');
        const dataProp = configRecord.prop('data');
        if (dataProp) dataProp.set(JSON.stringify(this._config));
      }
    } catch(e) {
      console.error('[HabitTracker] Error saving config:', e);
    }
  }

  // Read the data field — text() works, get() does not for records created by createRecord()
  _readDataProp(r) {
    return r.text?.('data') ||
           r.prop('data')?.text?.() ||
           r.prop('data')?.get?.() ||
           '';
  }

  async _loadLog(dateStr) {
    if (!this._collection) return { date: dateStr, completions: {}, categoryDone: {} };
    try {
      const records = await this._collection.getAllRecords();
      const logRecords = records.filter(r => r.getName() === `log-${dateStr}`);
      if (logRecords.length === 0) return { date: dateStr, completions: {}, categoryDone: {} };
      const merged = { date: dateStr, completions: {}, categoryDone: {} };
      for (const r of logRecords) {
        const raw = this._readDataProp(r);
        if (raw) {
          try {
            const d = JSON.parse(raw);
            Object.assign(merged.completions, d.completions || {});
            Object.assign(merged.categoryDone, d.categoryDone || {});
          } catch(e) {}
        }
      }
      return merged;
    } catch(e) {}
    return { date: dateStr, completions: {}, categoryDone: {} };
  }

  async _saveLog(dateStr, logData) {
    if (!this._collection) return;
    try {
      const records = await this._collection.getAllRecords();
      const json = JSON.stringify(logData);

      // Find an existing record for this date that ALREADY HAS DATA (skip empty shells)
      const allForDate = records.filter(r => r.getName() === `log-${dateStr}`);
      for (const r of allForDate) {
        const raw = this._readDataProp(r);
        if (raw) {
          r.prop('data')?.set(json);
          return;
        }
      }

      // No record with real data — create a fresh record (never write to empty shells)
      const guid = this._collection.createRecord(`log-${dateStr}`);
      await htSleep(200);
      const updated = await this._collection.getAllRecords();
      const newRec = updated.find(r => r.guid === guid);
      if (!newRec) { console.warn('[HT] saveLog: record not found', dateStr); return; }
      try { newRec.prop('record_type')?.setChoice('Log'); } catch(e) {}
      newRec.prop('data')?.set(json);
    } catch(e) {
      console.error('[HabitTracker] Error saving log:', e);
    }
  }

  // Calculate streak for a category: consecutive days (back from refDate) where categoryDone[catId] is true
  // Respects seedDate: if logs run out but seedDate is set, adds those days to the streak
  async _getCategoryStreak(catId, refDate) {
    if (!this._collection) return 0;
    const cat = this._config?.categories?.find(c => c.id === catId);
    try {
      const records = await this._collection.getAllRecords();
      const logsByDate = new Map();
      for (const r of records) {
        const name = r.getName() || '';
        if (name.startsWith('log-')) {
          const raw = this._readDataProp(r);
          if (raw) {
            try {
              const data = JSON.parse(raw);
              if (!data.date) continue;
              if (logsByDate.has(data.date)) {
                const ex = logsByDate.get(data.date);
                Object.assign(ex.completions, data.completions || {});
                Object.assign(ex.categoryDone, data.categoryDone || {});
              } else {
                logsByDate.set(data.date, { completions: data.completions || {}, categoryDone: data.categoryDone || {} });
              }
            } catch(e) {}
          }
        }
      }
      let streak = 0;
      // Start from yesterday relative to refDate (don't count refDate itself unless it's complete)
      let d = htDaysBefore(refDate || htToday(), 1);
      for (let i = 0; i < 3650; i++) {
        const log = logsByDate.get(d);
        if (log && log.categoryDone && log.categoryDone[catId]) {
          streak++;
          d = htDaysBefore(d, 1);
        } else if (cat?.seedDate && d >= cat.seedDate && !log) {
          // No log for this day but it's within the seeded range — count it
          streak++;
          d = htDaysBefore(d, 1);
        } else {
          break;
        }
      }
      return streak;
    } catch(e) { return 0; }
  }

  // Calculate streak for a habit: consecutive days where completions[habitId] is true
  // Respects seedDate on the habit for bringing over existing streaks
  async _getHabitStreak(habitId, refDate) {
    if (!this._collection) return 0;
    const habit = this._config?.habits?.find(h => h.id === habitId);
    try {
      const records = await this._collection.getAllRecords();
      const logsByDate = new Map();
      for (const r of records) {
        const name = r.getName() || '';
        if (name.startsWith('log-')) {
          const raw = this._readDataProp(r);
          if (raw) {
            try {
              const data = JSON.parse(raw);
              if (!data.date) continue;
              if (logsByDate.has(data.date)) {
                const ex = logsByDate.get(data.date);
                Object.assign(ex.completions, data.completions || {});
                Object.assign(ex.categoryDone, data.categoryDone || {});
              } else {
                logsByDate.set(data.date, { completions: data.completions || {}, categoryDone: data.categoryDone || {} });
              }
            } catch(e) {}
          }
        }
      }
      let streak = 0;
      let d = htDaysBefore(refDate || htToday(), 1);
      for (let i = 0; i < 3650; i++) {
        const log = logsByDate.get(d);
        if (log && log.completions && log.completions[habitId]) {
          streak++;
          d = htDaysBefore(d, 1);
        } else if (habit?.seedDate && d >= habit.seedDate && !log) {
          // No log exists for this day but it's within the seeded range — count it
          streak++;
          d = htDaysBefore(d, 1);
        } else {
          break;
        }
      }
      return streak;
    } catch(e) { return 0; }
  }

  // ── Panel mounting ───────────────────────────────────────────────────────

  _onPanelChanged(panel) {
    const panelId = panel?.getId?.();
    if (!panelId) return;

    const panelEl = panel?.getElement?.();
    if (!panelEl) return;

    // Only mount on journal/daily note pages
    const nav = panel?.getNavigation?.();
    const navType = nav?.type || '';
    if (navType === 'custom' || navType === 'custom_panel') return;

    const record = panel?.getActiveRecord?.();
    if (!record) return;

    // Only show on journal records (daily notes) — must have journal details
    const journalDetails = record.getJournalDetails?.();
    if (!journalDetails) return;

    // Extract journal date from the record — journal GUIDs typically end with YYYYMMDD
    let journalDateStr = htToday();
    const recordGuid = record.guid || '';
    const dateMatch = recordGuid.match(/(\d{4})(\d{2})(\d{2})$/);
    if (dateMatch && dateMatch[1] && dateMatch[2] && dateMatch[3]) {
      // Convert YYYYMMDD to YYYY-MM-DD format
      journalDateStr = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    }

    let state = this._panelStates.get(panelId);
    if (!state) {
      state = {
        panelId,
        panel,
        sidebarEl: null,
        bodyEl: null,
        observer: null,
        dateStr: journalDateStr,
        isJournalPanel: true,  // Flag to track this is a journal-synced panel
        renderTimer: null
      };
      this._panelStates.set(panelId, state);
    } else {
      // Update existing state to sync with journal date
      state.dateStr = journalDateStr;
      state.isJournalPanel = true;
    }

    this._mountSidebar(panel, state);
    if (state.bodyEl?.dataset?.mode !== 'stats') {
      // Debounce render on journal page navigation to avoid lag
      if (state.renderTimer) clearTimeout(state.renderTimer);
      state.renderTimer = setTimeout(() => {
        state.renderTimer = null;
        this._renderSidebar(state);
      }, 50);
    }
  }

  _onPanelClosed(panel) {
    const panelId = panel?.getId?.();
    if (!panelId) return;
    const state = this._panelStates.get(panelId);
    if (state) this._disposeState(state);
    this._panelStates.delete(panelId);
  }

  _disposeState(state) {
    if (state.renderTimer) clearTimeout(state.renderTimer);
    state.renderTimer = null;
    state.observer?.disconnect?.();
    state.observer = null;
    try { state.sidebarEl?.remove?.(); } catch(e) {}
    state.sidebarEl = null;
    state.bodyEl = null;
  }

  _mountSidebar(panel, state) {
    const panelEl = panel?.getElement?.();
    if (!panelEl) return;

    const container = this._findContainer(panelEl);
    if (!container) return;

    // Remove any stray duplicate .ht-sidebar elements we don't own
    container.querySelectorAll('.ht-sidebar').forEach(el => {
      if (el !== state.sidebarEl) el.remove();
    });

    // Build shell if missing or disconnected
    if (!state.sidebarEl || !state.sidebarEl.isConnected) {
      state.sidebarEl?.remove?.();
      state.sidebarEl = this._buildSidebarShell(state);
      state.bodyEl = state.sidebarEl.querySelector('.ht-sidebar-body');
    }

    // Only insert if not already the first child of this exact container
    const firstChild = container.firstChild;
    if (firstChild !== state.sidebarEl) {
      container.insertBefore(state.sidebarEl, firstChild);
    }

    // Set up observer only once — only watches for our element being removed
    if (!state.observer) {
      state.observer = new MutationObserver(() => {
        if (!state.sidebarEl || state.sidebarEl.isConnected) return;
        // Sidebar was removed by Thymer — schedule a single remount
        if (state._remountScheduled) return;
        state._remountScheduled = true;
        setTimeout(() => {
          state._remountScheduled = false;
          if (state.sidebarEl?.isConnected) return;
          this._mountSidebar(panel, state);
          if (state.bodyEl?.dataset?.mode !== 'stats') {
            this._renderSidebar(state);
          }
        }, 80);
      });
      // Only watch direct children of the container — not subtree — so our own renders don't trigger it
      state.observer.observe(container, { childList: true });
    }
  }

  _findContainer(panelEl) {
    if (!panelEl) return null;
    for (const sel of ['.page-content', '.editor-wrapper', '.editor-panel', '#editor']) {
      if (panelEl.matches?.(sel)) return panelEl;
      const child = panelEl.querySelector?.(sel);
      if (child) return child;
    }
    return null;
  }

  _buildSidebarShell(state) {
    // Each panel tracks its own viewed date, defaulting to today
    if (!state.dateStr) state.dateStr = htToday();

    const sidebar = document.createElement('div');
    sidebar.className = 'ht-sidebar' + (this._collapsed ? ' ht-collapsed' : '');

    const header = document.createElement('div');
    header.className = 'ht-sidebar-header';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'ht-toggle-btn';
    toggleBtn.title = this._collapsed ? 'Expand habits' : 'Collapse habits';
    toggleBtn.textContent = this._collapsed ? '+' : '−';
    toggleBtn.addEventListener('click', () => this._toggleCollapse());

    const titleEl = document.createElement('span');
    titleEl.className = 'ht-sidebar-title';
    titleEl.textContent = '🔥 Habits';

    // Date nav: prev arrow — date label — next arrow
    const prevBtn = document.createElement('button');
    prevBtn.className = 'ht-nav-btn';
    prevBtn.innerHTML = '‹';
    prevBtn.title = 'Previous day';

    const dateEl = document.createElement('span');
    dateEl.className = 'ht-date-label';

    const nextBtn = document.createElement('button');
    nextBtn.className = 'ht-nav-btn';
    nextBtn.innerHTML = '›';
    nextBtn.title = 'Next day';

    const updateDateDisplay = () => {
      const isToday = state.dateStr === htToday();
      const d = new Date(state.dateStr + 'T12:00:00');
      if (isToday) {
        dateEl.textContent = 'Today';
        dateEl.style.color = '#e8e0d0';
      } else {
        dateEl.textContent = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        dateEl.style.color = '#c4a882';
      }
      nextBtn.style.opacity = isToday ? '0.25' : '1';
      nextBtn.style.pointerEvents = isToday ? 'none' : '';
    };

    prevBtn.addEventListener('click', () => {
      state.dateStr = htDaysBefore(state.dateStr, 1);
      updateDateDisplay();
      this._renderSidebar(state);
    });

    nextBtn.addEventListener('click', () => {
      if (state.dateStr >= htToday()) return;
      state.dateStr = htDaysAfter(state.dateStr, 1);
      updateDateDisplay();
      this._renderSidebar(state);
    });

    // Hide date nav buttons if synced to journal (date is controlled by the journal page)
    if (state.isJournalPanel) {
      prevBtn.style.display = 'none';
      nextBtn.style.display = 'none';
    }

    updateDateDisplay();

    const statsBtn = document.createElement('button');
    statsBtn.className = 'ht-stats-btn';
    statsBtn.textContent = '📊';
    statsBtn.title = 'View stats';

    const enterStats = () => {
      body.dataset.mode = 'stats';
      statsBtn.textContent = '←';
      statsBtn.title = 'Back to habits';
      statsBtn.classList.add('active');
      prevBtn.style.display = 'none';
      dateEl.style.display = 'none';
      nextBtn.style.display = 'none';
      this._renderStats(state, body);
    };
    const exitStats = () => {
      body.dataset.mode = 'habits';
      statsBtn.textContent = '📊';
      statsBtn.title = 'View stats';
      statsBtn.classList.remove('active');
      prevBtn.style.display = '';
      dateEl.style.display = '';
      nextBtn.style.display = '';
      this._renderSidebar(state);
    };

    statsBtn.addEventListener('click', () => {
      if (body.dataset.mode === 'stats') exitStats();
      else enterStats();
    });

    // Search button + input
    const searchBtn = document.createElement('button');
    searchBtn.className = 'ht-nav-btn';
    searchBtn.textContent = '🔍';
    searchBtn.title = 'Search habits';
    searchBtn.style.fontSize = '12px';

    const searchWrap = document.createElement('div');
    searchWrap.style.cssText = 'display:none;flex:1;align-items:center;gap:4px;';
    const searchInput = document.createElement('input');
    searchInput.className = 'ht-input';
    searchInput.placeholder = 'Search habits…';
    searchInput.style.cssText = 'flex:1;height:22px;font-size:11px;padding:2px 6px;';
    const searchClose = document.createElement('button');
    searchClose.className = 'ht-nav-btn';
    searchClose.textContent = '✕';
    searchClose.style.fontSize = '10px';
    searchWrap.appendChild(searchInput);
    searchWrap.appendChild(searchClose);

    let searchOpen = false;
    const openSearch = () => {
      searchOpen = true;
      searchWrap.style.display = 'flex';
      searchBtn.style.display = 'none';
      searchInput.value = '';
      searchInput.focus();
      state._searchQuery = '';
      this._renderSidebar(state);
    };
    const closeSearch = () => {
      searchOpen = false;
      searchWrap.style.display = 'none';
      searchBtn.style.display = '';
      state._searchQuery = '';
      this._renderSidebar(state);
    };
    searchBtn.addEventListener('click', openSearch);
    searchClose.addEventListener('click', closeSearch);
    let searchDebounce = null;
    searchInput.addEventListener('input', () => {
      state._searchQuery = searchInput.value.trim().toLowerCase();
      clearTimeout(searchDebounce);
      if (!state._searchQuery) {
        // Instant clear on empty
        this._renderSidebar(state);
      } else {
        searchDebounce = setTimeout(() => this._renderSidebar(state), 120);
      }
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeSearch();
    });

    // Show/hide nav controls based on collapsed state
    const updateNavVisibility = () => {
      const collapsed = sidebar.classList.contains('ht-collapsed');
      prevBtn.style.display = collapsed ? 'none' : '';
      dateEl.style.display = collapsed ? 'none' : '';
      nextBtn.style.display = collapsed ? 'none' : '';
      statsBtn.style.display = collapsed ? 'none' : '';
      searchBtn.style.display = collapsed || searchOpen ? 'none' : '';
      searchWrap.style.display = collapsed ? 'none' : (searchOpen ? 'flex' : 'none');
    };
    updateNavVisibility();

    // Patch _toggleCollapse to also update visibility
    const origToggle = toggleBtn.onclick;
    toggleBtn.addEventListener('click', () => setTimeout(updateNavVisibility, 0));

    header.appendChild(toggleBtn);
    header.appendChild(titleEl);
    header.appendChild(prevBtn);
    header.appendChild(dateEl);
    header.appendChild(nextBtn);
    header.appendChild(statsBtn);
    header.appendChild(searchBtn);
    header.appendChild(searchWrap);

    const body = document.createElement('div');
    body.className = 'ht-sidebar-body';

    sidebar.appendChild(header);
    sidebar.appendChild(body);

    return sidebar;
  }

  _toggleCollapse() {
    this._collapsed = !this._collapsed;
    localStorage.setItem('ht_sidebar_collapsed', String(this._collapsed));
    for (const [, state] of (this._panelStates || [])) {
      if (!state.sidebarEl) continue;
      state.sidebarEl.classList.toggle('ht-collapsed', this._collapsed);
      const btn = state.sidebarEl.querySelector('.ht-toggle-btn');
      if (btn) {
        // ◀ = collapse (panel is open), ▶ = expand (panel is collapsed)
        btn.textContent = this._collapsed ? '+' : '−';
        btn.title = this._collapsed ? 'Expand habits' : 'Collapse habits';
      }
    }
  }

  // ── Render sidebar ───────────────────────────────────────────────────────

  // Guard helper — check if we should abort mid-render
  _inStatsMode(state) {
    return state.bodyEl?.dataset?.mode === 'stats';
  }

  async _renderSidebar(state) {
    const body = state.bodyEl;
    if (!body || this._inStatsMode(state)) return;

    // Mark this render with a token — if a newer render starts, this one aborts
    const token = (state._renderToken || 0) + 1;
    state._renderToken = token;
    const stale = () => state._renderToken !== token || this._inStatsMode(state);

    const config = this._config;

    if (!config || config.categories.length === 0) {
      if (stale()) return;
      body.innerHTML = '';
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'ht-empty';
      emptyDiv.innerHTML = `
        <div class="ht-empty-icon">🌱</div>
        <div>No habits yet.</div>
        <div style="margin-top:4px;font-size:11px;">Open settings to add categories and habits.</div>
        <button class="ht-setup-btn" data-action="open-settings">Set up habits</button>
      `;
      emptyDiv.querySelector('[data-action="open-settings"]')?.addEventListener('click', () => this.openSettings());
      body.appendChild(emptyDiv);
      return;
    }

    // Load log for the currently viewed date
    const dateStr = state.dateStr || htToday();
    const log = await this._loadLog(dateStr);
    if (stale()) return; // abort if stats opened while we were loading

    // Progress bar — keep stable (update in-place if it exists)
    const allHabits = config.habits.filter(h => !h.archived);
    const doneCount = allHabits.filter(h => {
      const v = log.completions[h.id];
      if (!v) return false;
      if ((h.target||0) > 0) return typeof v === 'number' ? v >= h.target : false;
      return true;
    }).length;
    const pct = allHabits.length > 0 ? Math.round((doneCount / allHabits.length) * 100) : 0;

    // If stats view is in body, clear it first
    if (body.querySelector('.ht-stats-view')) body.innerHTML = '';

    let progressWrap = body.querySelector('.ht-progress');
    if (!progressWrap) {
      progressWrap = document.createElement('div');
      progressWrap.className = 'ht-progress';
      progressWrap.innerHTML = `<div class="ht-progress-fill" style="width:${pct}%"></div>`;
      body.insertBefore(progressWrap, body.firstChild);
    } else {
      const fill = progressWrap.querySelector('.ht-progress-fill');
      if (fill) fill.style.width = pct + '%';
    }

    // Build into a fragment first — swap in one shot to avoid collapse during awaits
    const fragment = document.createDocumentFragment();

    // Categories — only show active (non-archived) habits
    const sortedCats = [...config.categories].sort((a,b) => (a.order||0)-(b.order||0));
    for (const cat of sortedCats) {
      const habitsInCat = config.habits
        .filter(h => h.categoryId === cat.id && !h.archived)
        .sort((a,b) => (a.order||0)-(b.order||0));

      // Filter by search query
      const query = state._searchQuery || '';
      const visibleHabits = query
        ? habitsInCat.filter(h => h.name.toLowerCase().includes(query))
        : habitsInCat;
      if (visibleHabits.length === 0) continue;

      const anyDone = habitsInCat.some(h => {
        const v = log.completions[h.id];
        if (!v) return false;
        if ((h.target||0) > 0) return typeof v === 'number' ? v >= h.target : false;
        return true;
      });
      const catIsDone = anyDone;

      const streak = await this._getCategoryStreak(cat.id);
      if (stale()) return;
      const isOpen = !this._catCollapsed[cat.id];

      const catEl = document.createElement('div');
      catEl.className = 'ht-category';

      const catHeader = document.createElement('div');
      catHeader.className = 'ht-category-header';
      catHeader.innerHTML = `
        <span class="ht-category-caret ${isOpen ? 'open' : ''}">▶</span>
        <span class="ht-category-emoji">${htEsc(cat.emoji || '📋')}</span>
        <span class="ht-category-name">${htEsc(cat.name)}</span>
        <span class="ht-category-status ${catIsDone ? 'ht-cat-done' : 'ht-cat-pending'}">
          ${catIsDone ? '✅' : '○'}
        </span>
        ${streak > 0 ? `<span class="ht-streak-badge">🔥${streak}d</span>` : ''}
      `;
      catHeader.addEventListener('click', () => this._toggleCategory(cat.id, state));

      const habitsEl = document.createElement('div');
      habitsEl.className = 'ht-category-habits' + ((isOpen || query) ? '' : ' ht-hidden');
      habitsEl.dataset.catId = cat.id;

      for (const habit of visibleHabits) {
        const rawVal = log.completions[habit.id];
        const hasTarget = (habit.target || 0) > 0;
        const isNumeric = hasTarget;
        const currentVal = typeof rawVal === 'number' ? rawVal : (rawVal ? 1 : 0);
        const isDone = hasTarget ? currentVal >= habit.target : !!rawVal;
        const hStreak = await this._getHabitStreak(habit.id);
        if (stale()) return;

        const habitEl = document.createElement('div');
        habitEl.className = 'ht-habit' + (isDone ? ' ht-done' : '');
        habitEl.dataset.habitId = habit.id;

        // Build the left indicator — ring for numeric, circle checkbox for boolean
        let indicatorHTML = '';
        if (isNumeric) {
          const r = 8; const circ = 2 * Math.PI * r;
          const pct = Math.min(1, currentVal / habit.target);
          const dash = circ * pct;
          const label = currentVal >= habit.target ? '✓' : `${currentVal}`;
          indicatorHTML = `
            <div class="ht-habit-ring">
              <svg width="22" height="22" viewBox="0 0 22 22">
                <circle class="ht-habit-ring-bg" cx="11" cy="11" r="${r}"/>
                <circle class="ht-habit-ring-fill" cx="11" cy="11" r="${r}"
                  stroke-dasharray="${circ}"
                  stroke-dashoffset="${circ - dash}"/>
              </svg>
              <div class="ht-habit-ring-label">${label}</div>
            </div>`;
        } else {
          indicatorHTML = `<div class="ht-habit-check">${isDone ? '✓' : ''}</div>`;
        }

        const unitLabel = habit.unit ? htEsc(habit.unit) : '';
        const targetLabel = hasTarget ? `<span style="font-size:10px;color:#8a7e6a;margin-left:2px;">${currentVal}/${habit.target}${unitLabel ? ' ' + unitLabel : ''}</span>` : '';
        const streakHTML = hStreak > 0 ? `<span class="ht-habit-streak ${hStreak >= 7 ? 'hot' : ''}">🔥${hStreak}d</span>` : '';

        habitEl.innerHTML = `
          ${indicatorHTML}
          <span class="ht-habit-name">${htEsc(habit.name)}${targetLabel}</span>
          ${streakHTML}
        `;

        // ── Interaction: tap = +1 (or toggle), long press = type number ──
        let longPressTimer = null;
        let didLongPress = false;
        let pressStartX = 0, pressStartY = 0;

        let pressDownTime = 0;

        const startPress = (e) => {
          didLongPress = false;
          pressDownTime = Date.now();
          pressStartX = e.clientX || e.touches?.[0]?.clientX || 0;
          pressStartY = e.clientY || e.touches?.[0]?.clientY || 0;
          if (isNumeric) {
            longPressTimer = setTimeout(() => {
              didLongPress = true;
              clearTimeout(longPressTimer);
              this._showNumericInput(habitEl, habit, cat.id, log, dateStr, state);
            }, 800);
          }
        };

        const cancelPress = () => {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        };

        const checkMove = (e) => {
          const x = e.clientX || e.touches?.[0]?.clientX || 0;
          const y = e.clientY || e.touches?.[0]?.clientY || 0;
          // Use larger threshold for touch events (allow more movement)
          const threshold = e.touches ? 12 : 8;
          if (Math.abs(x - pressStartX) > threshold || Math.abs(y - pressStartY) > threshold) {
            cancelPress();
          }
        };

        habitEl.addEventListener('mousedown', startPress);
        habitEl.addEventListener('touchstart', startPress, { passive: true });
        habitEl.addEventListener('mousemove', checkMove);
        habitEl.addEventListener('touchmove', checkMove, { passive: true });
        // Cancel on mouseup if it was a quick tap (not a hold)
        habitEl.addEventListener('mouseup', () => {
          if (Date.now() - pressDownTime < 600) cancelPress();
        });
        habitEl.addEventListener('mouseleave', cancelPress);
        habitEl.addEventListener('touchend', (e) => {
          if (didLongPress) e.preventDefault();
          // On quick tap, cancel the timer; long press is handled by timeout
          if (Date.now() - pressDownTime < 600) cancelPress();
        }, { passive: false });

        habitEl.addEventListener('click', (e) => {
          if (didLongPress) { didLongPress = false; return; }
          // If numeric input is open, don't also toggle
          if (habitEl.querySelector('.ht-num-input')) return;
          this._tapHabit(habit, cat.id, log, dateStr, state, habitEl, isDone);
        });

        habitsEl.appendChild(habitEl);
      }

      catEl.appendChild(catHeader);
      catEl.appendChild(habitsEl);
      fragment.appendChild(catEl);
    }

    // All async work done — now do the atomic swap in one paint frame
    if (stale()) return;
    let catsWrap = body.querySelector('.ht-sidebar-cats');
    if (!catsWrap) {
      catsWrap = document.createElement('div');
      catsWrap.className = 'ht-sidebar-cats';
      body.appendChild(catsWrap);
    }
    // Single DOM swap — no intermediate empty state, no collapse
    catsWrap.replaceChildren(fragment);
  }

  _toggleCategory(catId, state) {
    this._catCollapsed[catId] = !this._catCollapsed[catId];
    localStorage.setItem('ht_cat_collapsed', JSON.stringify(this._catCollapsed));

    const body = state.bodyEl;
    if (!body) return;
    const habitsEl = body.querySelector(`[data-cat-id="${catId}"]`);
    const catHeader = habitsEl?.previousElementSibling;
    const caret = catHeader?.querySelector('.ht-category-caret');

    const isOpen = !this._catCollapsed[catId];
    habitsEl?.classList.toggle('ht-hidden', !isOpen);
    caret?.classList.toggle('open', isOpen);
  }

  // Tap a habit: boolean = toggle, numeric = +1 up to target (then tap again resets to 0)
  async _tapHabit(habit, catId, log, dateStr, state, habitEl, wasDone) {
    // Always reload fresh from storage — stale log reference causes double-increment
    const freshLog = await this._loadLog(dateStr);
    log = freshLog;
    const hasTarget = (habit.target || 0) > 0;
    const currentVal = typeof log.completions[habit.id] === 'number'
      ? log.completions[habit.id]
      : (log.completions[habit.id] ? 1 : 0);

    let newVal;
    let nowDone = false;

    if (hasTarget) {
      if (currentVal >= habit.target) {
        // Already done — tap resets to 0
        newVal = 0;
        nowDone = false;
      } else {
        newVal = currentVal + 1;
        nowDone = newVal >= habit.target;
        if (nowDone) this._celebrate(habitEl);
      }
      log.completions[habit.id] = newVal > 0 ? newVal : undefined;
      if (newVal === 0) delete log.completions[habit.id];
    } else {
      // Boolean toggle
      if (log.completions[habit.id]) {
        delete log.completions[habit.id];
        nowDone = false;
      } else {
        log.completions[habit.id] = true;
        nowDone = true;
        this._celebrate(habitEl);
      }
    }

    // Recompute category done
    const habitsInCat = (this._config?.habits || []).filter(h => h.categoryId === catId && !h.archived);
    const anyDone = habitsInCat.some(h => {
      const v = log.completions[h.id];
      if (!v) return false;
      if (h.target > 0) return typeof v === 'number' ? v >= h.target : false;
      return true;
    });
    if (anyDone) log.categoryDone[catId] = true;
    else delete log.categoryDone[catId];

    await this._saveLog(dateStr, log);
    // Patch just this habit element in-place to avoid full flash re-render
    await this._patchHabitEl(habitEl, habit, log, dateStr, catId, state);
  }

  // Patch a single habit element in-place after a tap (no full re-render)
  async _patchHabitEl(habitEl, habit, log, dateStr, catId, state) {
    if (!habitEl || !habitEl.isConnected) {
      await this._renderSidebar(state);
      return;
    }

    const hasTarget = (habit.target || 0) > 0;
    const rawVal = log.completions[habit.id];
    const currentVal = typeof rawVal === 'number' ? rawVal : (rawVal ? 1 : 0);
    const isDone = hasTarget ? currentVal >= habit.target : !!rawVal;

    // Update done class
    habitEl.classList.toggle('ht-done', isDone);

    // Update indicator (ring or checkbox)
    if (hasTarget) {
      const r = 8; const circ = 2 * Math.PI * r;
      const pct = Math.min(1, currentVal / habit.target);
      const fill = habitEl.querySelector('.ht-habit-ring-fill');
      const label = habitEl.querySelector('.ht-habit-ring-label');
      if (fill) fill.style.strokeDashoffset = circ - circ * pct;
      if (label) label.textContent = isDone ? '✓' : String(currentVal);
      // Update inline count label
      const nameEl = habitEl.querySelector('.ht-habit-name');
      if (nameEl) {
        const existing = nameEl.querySelector('span');
        if (existing) {
          existing.textContent = `${currentVal}/${habit.target}${habit.unit ? ' ' + habit.unit : ''}`;
        }
      }
    } else {
      const check = habitEl.querySelector('.ht-habit-check');
      if (check) check.textContent = isDone ? '✓' : '';
    }

    // Update category header status badge and streak badge
    const habitsEl = habitEl.closest('.ht-category-habits');
    const catHeader = habitsEl?.previousElementSibling;
    if (catHeader) {
      const statusEl = catHeader.querySelector('.ht-category-status');
      const catDone = !!(log.categoryDone[catId]);
      if (statusEl) {
        statusEl.className = `ht-category-status ${catDone ? 'ht-cat-done' : 'ht-cat-pending'}`;
        statusEl.textContent = catDone ? '✅' : '○';
      }
    }

    // Update progress bar
    const body = state.bodyEl;
    if (body) {
      const allHabits = (this._config?.habits || []).filter(h => !h.archived);
      const doneCount = allHabits.filter(h => {
        const v = log.completions[h.id];
        if (!v) return false;
        if ((h.target || 0) > 0) return typeof v === 'number' ? v >= h.target : false;
        return true;
      }).length;
      const pct = allHabits.length > 0 ? Math.round((doneCount / allHabits.length) * 100) : 0;
      const fill = body.querySelector('.ht-progress-fill');
      if (fill) fill.style.width = pct + '%';
    }
  }

  // Long-press: show inline number input
  async _showNumericInput(habitEl, habit, catId, log, dateStr, state) {
    // Don't stack inputs
    if (habitEl.querySelector('.ht-num-input')) return;
    const nameEl = habitEl.querySelector('.ht-habit-name');
    if (!nameEl) return;

    // Reload fresh log
    const freshLog = await this._loadLog(dateStr);
    log = freshLog;

    const currentVal = typeof log.completions[habit.id] === 'number'
      ? log.completions[habit.id] : 0;

    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:3px;margin-left:6px;';

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'ht-num-input';
    input.value = currentVal;
    input.min = 0;
    input.max = 9999;

    const okBtn = document.createElement('button');
    okBtn.className = 'ht-num-btn';
    okBtn.textContent = '✓';
    okBtn.style.background = 'rgba(76,175,80,0.2)';
    okBtn.style.borderColor = '#4caf50';
    okBtn.style.color = '#4caf50';

    const commit = async () => {
      wrap.remove();
      const newVal = Math.max(0, parseInt(input.value) || 0);
      if (newVal === 0) delete log.completions[habit.id];
      else log.completions[habit.id] = newVal;

      const wasDone = newVal >= habit.target;
      if (wasDone) this._celebrate(habitEl);

      const habitsInCat = (this._config?.habits || []).filter(h => h.categoryId === catId && !h.archived);
      const anyDone = habitsInCat.some(h => {
        const v = log.completions[h.id];
        if (!v) return false;
        if (h.target > 0) return typeof v === 'number' ? v >= h.target : false;
        return true;
      });
      if (anyDone) log.categoryDone[catId] = true;
      else delete log.categoryDone[catId];

      await this._saveLog(dateStr, log);
      await this._patchHabitEl(habitEl, habit, log, dateStr, catId, state);
    };

    okBtn.addEventListener('click', (e) => { e.stopPropagation(); commit(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') wrap.remove();
      e.stopPropagation();
    });
    input.addEventListener('click', (e) => e.stopPropagation());

    wrap.appendChild(input);
    wrap.appendChild(okBtn);
    nameEl.appendChild(wrap);
    input.focus();
    input.select();
  }

  // Celebration burst animation on the habit element
  _celebrate(el) {
    if (!el) return;
    el.classList.remove('ht-celebrating');
    void el.offsetWidth; // reflow to restart animation
    el.classList.add('ht-celebrating');

    // Spawn particle dots
    const colors = ['#4caf50','#8bc34a','#c6ff00','#ffeb3b','#ff9800'];
    const rect = el.getBoundingClientRect();
    const parentRect = el.offsetParent?.getBoundingClientRect() || rect;

    for (let i = 0; i < 7; i++) {
      const p = document.createElement('div');
      p.className = 'ht-particle';
      const angle = (i / 7) * 2 * Math.PI;
      const dist = 18 + Math.random() * 12;
      p.style.setProperty('--tx', `${Math.cos(angle) * dist}px`);
      p.style.setProperty('--ty', `${Math.sin(angle) * dist}px`);
      p.style.background = colors[i % colors.length];
      p.style.left = `${rect.left - parentRect.left + rect.width / 2 - 2.5}px`;
      p.style.top = `${rect.top - parentRect.top + rect.height / 2 - 2.5}px`;
      el.offsetParent?.appendChild(p);
      setTimeout(() => p.remove(), 520);
    }

    setTimeout(() => el.classList.remove('ht-celebrating'), 400);
  }

  // ── Stats View ─────────────────────────────────────────────────────────

  async _renderStats(state, body) {
    body.dataset.mode = 'stats'; // set mode FIRST before any async
    body.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'ht-stats-view';
    body.appendChild(wrap);

    const config = this._config || { categories: [], habits: [] };
    let rangeDays = (state.statsRange === 90 ? 30 : state.statsRange) || 30;
    let selectedId = state.statsSelected || '__overall__';

    const buildSelect = () => {
      const sel = document.createElement('select');
      sel.className = 'ht-stats-select';
      const opt0 = document.createElement('option');
      opt0.value = '__overall__'; opt0.textContent = '🌐 Overall';
      sel.appendChild(opt0);
      for (const cat of config.categories) {
        const o = document.createElement('option');
        o.value = 'cat:' + cat.id;
        o.textContent = `${cat.emoji || '📋'} ${cat.name} (category)`;
        sel.appendChild(o);
        for (const h of config.habits.filter(h2 => h2.categoryId === cat.id && !h2.archived)) {
          const oh = document.createElement('option');
          oh.value = 'habit:' + h.id;
          oh.textContent = `  · ${h.name}`;
          sel.appendChild(oh);
        }
      }
      sel.value = selectedId;
      sel.addEventListener('change', () => {
        selectedId = sel.value;
        state.statsSelected = selectedId;
        renderContent();
      });
      return sel;
    };

    // Range buttons
    const rangeRow = document.createElement('div');
    rangeRow.className = 'ht-stats-range';
    for (const [label, days] of [['7d', 7], ['30d', 30]]) {
      const btn = document.createElement('button');
      btn.className = 'ht-range-btn' + (rangeDays === days ? ' active' : '');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        rangeDays = days;
        state.statsRange = days;
        rangeRow.querySelectorAll('.ht-range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderContent();
      });
      rangeRow.appendChild(btn);
    }
    wrap.appendChild(rangeRow);
    wrap.appendChild(buildSelect());

    const contentEl = document.createElement('div');
    contentEl.className = 'ht-stats-content';
    wrap.appendChild(contentEl);

    // ── Stats cell interaction helpers ─────────────────────────────────────

    // Patch a calendar cell's visual state in-place (no full re-render)
    const patchCell = (el, isDone, isPartial, label) => {
      el.classList.toggle('done', isDone);
      el.classList.toggle('partial', isPartial && !isDone);

      // Monthly grid cell — update value label
      const valEl = el.querySelector('.ht-cal-day-val');
      if (valEl) {
        // Update existing val element
        if (label != null && label > 0) {
          valEl.textContent = label;
          valEl.style.display = '';
        } else {
          valEl.textContent = '';
          valEl.style.display = 'none';
        }
      } else if (label != null && label > 0 && el.querySelector('.ht-cal-day-num')) {
        // Monthly cell with no val element yet — create one
        const newVal = document.createElement('div');
        newVal.className = 'ht-cal-day-val';
        newVal.textContent = label;
        el.appendChild(newVal);
      }

      // 7d strip circle — update text directly (no sub-elements)
      if (!el.querySelector('.ht-cal-day-num') && !el.querySelector('.ht-cal-strip-date')) {
        // pure circle element — label is shown as text in center
        // don't overwrite; strip uses separate date label below
      }
    };

    // Recompute and persist log changes, patch cell in-place
    const applyLogChange = async (dateStr, log, el, hId, cId) => {
      const h = hId ? config.habits.find(x => x.id === hId) : null;
      // Recompute category done for affected categories
      const affectedCatIds = hId && h ? [h.categoryId]
        : cId ? [cId]
        : config.categories.map(c => c.id);
      for (const catId of affectedCatIds) {
        const habitsInCat = config.habits.filter(x => x.categoryId === catId && !x.archived);
        const anyDone = habitsInCat.some(x => {
          const v2 = log.completions[x.id];
          if (!v2) return false;
          if ((x.target||0) > 0) return typeof v2 === 'number' ? v2 >= x.target : false;
          return true;
        });
        if (anyDone) log.categoryDone[catId] = true;
        else delete log.categoryDone[catId];
      }
      await this._saveLog(dateStr, log);

      // Patch the cell visually
      const isHabitSel = !!hId && !!h;
      const isCatSel = !!cId;
      const isOverallSel = !isHabitSel && !isCatSel;

      let isDone = false, isPartial = false, valLabel = null;
      if (isHabitSel) {
        const v = log.completions[hId];
        const num = typeof v === 'number' ? v : (v ? 1 : 0);
        isDone = (h.target||0) > 0 ? num >= h.target : !!v;
        isPartial = !isDone && num > 0;
        valLabel = (h.target||0) > 0 && num > 0 ? num : null;
      } else if (isCatSel) {
        isDone = !!log.categoryDone[cId];
      } else {
        const allActive = config.habits.filter(x => !x.archived);
        const doneCount = allActive.filter(x => {
          const v = log.completions[x.id];
          if (!v) return false;
          return (x.target||0) > 0 ? (typeof v === 'number' ? v >= x.target : false) : true;
        }).length;
        isDone = doneCount === allActive.length;
        isPartial = !isDone && doneCount > 0;
      }
      patchCell(el, isDone, isPartial, valLabel);
      if (isDone) this._celebrate(el);

      // Stat cards will update on next full renderContent (triggered by range/selection change)
      // Don't re-render here to avoid flicker
    };

    // Show inline numeric input on long-press (for stats circles)
    const showStatsNumericInput = (el, dateStr, h) => {
      if (el.querySelector('.ht-num-input')) return;
      const hId = h.id;

      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);' +
        'display:flex;gap:4px;align-items:center;background:rgba(28,26,34,0.95);' +
        'border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:4px 6px;z-index:100;white-space:nowrap;';

      const input = document.createElement('input');
      input.type = 'number'; input.className = 'ht-num-input';
      input.style.cssText = 'width:44px;';
      input.min = 0; input.max = 9999;

      const okBtn = document.createElement('button');
      okBtn.className = 'ht-num-btn'; okBtn.textContent = '✓';
      okBtn.style.cssText = 'background:rgba(76,175,80,0.2);border-color:#4caf50;color:#4caf50;';

      const commit = async () => {
        wrap.remove();
        const newVal = Math.max(0, parseInt(input.value) || 0);
        const log = await this._loadLog(dateStr);
        if (newVal === 0) delete log.completions[hId];
        else log.completions[hId] = newVal;
        await applyLogChange(dateStr, log, el, hId, null);
      };

      okBtn.addEventListener('click', (e) => { e.stopPropagation(); commit(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') wrap.remove();
        e.stopPropagation();
      });
      input.addEventListener('click', (e) => e.stopPropagation());
      wrap.appendChild(input); wrap.appendChild(okBtn);
      el.style.position = 'relative';
      el.style.overflow = 'visible';
      el.appendChild(wrap);
      setTimeout(() => { input.focus(); input.select(); }, 10);

      // Close on outside click
      const outside = (e) => { if (!wrap.contains(e.target)) { wrap.remove(); document.removeEventListener('click', outside); } };
      setTimeout(() => document.addEventListener('click', outside), 50);
    };

    // Wire up tap + long-press on a calendar circle element
    const wireCircle = (el, dateStr, currentV) => {
      const isCatSel = selectedId.startsWith('cat:');
      const isHabitSel = selectedId.startsWith('habit:');
      const hId = isHabitSel ? selectedId.slice(6) : null;
      const cId = isCatSel ? selectedId.slice(4) : null;
      const h = hId ? config.habits.find(x => x.id === hId) : null;
      const isNumeric = h && (h.target||0) > 0;

      let longTimer = null, didLong = false, startX = 0, startY = 0;

      let pressDownTime = 0;
      el.addEventListener('mousedown', (e) => {
        didLong = false; startX = e.clientX; startY = e.clientY;
        pressDownTime = Date.now();
        if (isNumeric) {
          longTimer = setTimeout(() => {
            didLong = true;
            showStatsNumericInput(el, dateStr, h);
          }, 800);
        }
      });
      el.addEventListener('mouseup', () => {
        if (Date.now() - pressDownTime < 600) clearTimeout(longTimer);
      });
      el.addEventListener('mousemove', (e) => {
        if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) clearTimeout(longTimer);
      });
      el.addEventListener('mouseleave', () => clearTimeout(longTimer));

      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (didLong) { didLong = false; return; }
        if (el.querySelector('.ht-num-input')) return;

        const log = await this._loadLog(dateStr);

        if (isHabitSel && h) {
          if (isNumeric) {
            const cur = typeof log.completions[hId] === 'number' ? log.completions[hId] : 0;
            if (cur >= h.target) delete log.completions[hId];
            else log.completions[hId] = cur + 1; // +1 per tap, same as main screen
          } else {
            if (log.completions[hId]) delete log.completions[hId];
            else log.completions[hId] = true;
          }
          await applyLogChange(dateStr, log, el, hId, null);
        } else if (isCatSel && cId) {
          if (log.categoryDone[cId]) delete log.categoryDone[cId];
          else log.categoryDone[cId] = true;
          await this._saveLog(dateStr, log);
          patchCell(el, !!log.categoryDone[cId], false, null);
          if (log.categoryDone[cId]) this._celebrate(el);
        } else {
          // Overall — toggle all
          const allActive = config.habits.filter(x => !x.archived);
          const allDone = allActive.every(x => log.completions[x.id]);
          if (allDone) {
            allActive.forEach(x => delete log.completions[x.id]);
            config.categories.forEach(c => delete log.categoryDone[c.id]);
          } else {
            allActive.forEach(x => { log.completions[x.id] = (x.target||0) > 0 ? x.target : true; });
            config.categories.forEach(c => { log.categoryDone[c.id] = true; });
          }
          await this._saveLog(dateStr, log);
          patchCell(el, !allDone, false, null);
          if (!allDone) this._celebrate(el);
        }
      });
    };

    const renderContent = async () => {
      if (!contentEl.isConnected) return;
      contentEl.innerHTML = '';

      // Load all log records, merging any duplicates per date
      const records = await this._collection?.getAllRecords() || [];
      const logsByDate = new Map();
      for (const r of records) {
        const name = r.getName() || '';
        if (name.startsWith('log-')) {
          const raw = this._readDataProp(r);
          if (raw) {
            try {
              const d = JSON.parse(raw);
              if (!d.date) continue;
              if (logsByDate.has(d.date)) {
                const ex = logsByDate.get(d.date);
                Object.assign(ex.completions, d.completions || {});
                Object.assign(ex.categoryDone, d.categoryDone || {});
              } else {
                logsByDate.set(d.date, { date: d.date, completions: d.completions || {}, categoryDone: d.categoryDone || {} });
              }
            } catch(e) {}
          }
        }
      }

      // Build date range for stats cards (rolling window)
      const today = htToday();
      const dates = [];
      for (let i = rangeDays - 1; i >= 0; i--) dates.push(htDaysBefore(today, i));

      // All dates with log data (for calendar rendering beyond the rolling window)
      const allLogDates = new Set(logsByDate.keys());

      // Parse selection
      const isCat = selectedId.startsWith('cat:');
      const isHabit = selectedId.startsWith('habit:');
      const isOverall = selectedId === '__overall__';
      const catId = isCat ? selectedId.slice(4) : null;
      const habitId = isHabit ? selectedId.slice(6) : null;
      const habit = habitId ? config.habits.find(h => h.id === habitId) : null;
      const cat = catId ? config.categories.find(c => c.id === catId) : null;
      const activeHabits = config.habits.filter(h => !h.archived);

      // Compute per-day values for rolling window
      const getVal = (dateStr) => {
        const log = logsByDate.get(dateStr);
        if (!log) return null;
        if (isOverall) {
          const done = activeHabits.filter(h => {
            const cv = log.completions?.[h.id];
            if (!cv) return false;
            return (h.target||0) > 0 ? (typeof cv === 'number' ? cv >= h.target : false) : true;
          }).length;
          return { val: done, max: activeHabits.length, done: done === activeHabits.length };
        }
        if (isCat) return { val: log.categoryDone?.[catId] ? 1 : 0, max: 1, done: !!log.categoryDone?.[catId] };
        if (isHabit && habit) {
          const hv = log.completions?.[habit.id];
          const num = typeof hv === 'number' ? hv : (hv ? 1 : 0);
          const target = habit.target || 0;
          return { val: num, max: target || 1, done: target > 0 ? num >= target : !!hv };
        }
        return null;
      };

      const dayVals = dates.map(d => getVal(d));

      // All log dates sorted
      const allDates = [...allLogDates].sort();

      // Rate across all history
      const allDoneDays = allDates.filter(d => getVal(d)?.done).length;
      const completionRate = allDates.length > 0 ? Math.round((allDoneDays / allDates.length) * 100) : 0;
      const rateLabel = `${allDoneDays}/${allDates.length} days`;

      // Total value (numeric habits) across all history
      let totalVal = 0;
      allDates.forEach(d => {
        const log = logsByDate.get(d);
        if (log && isHabit && habit) {
          const hv = log.completions?.[habit.id];
          totalVal += typeof hv === 'number' ? hv : (hv ? 1 : 0);
        }
      });

      // Streak calc using ALL log data
      let bestStreak = 0, cur = 0;
      for (let i = 0; i < allDates.length; i++) {
        const v = getVal(allDates[i]);
        if (v?.done) {
          // Check if consecutive with previous date
          if (i > 0) {
            const prev = new Date(allDates[i-1] + 'T12:00:00');
            const curr = new Date(allDates[i] + 'T12:00:00');
            const diff = Math.round((curr - prev) / 86400000);
            if (diff === 1) { cur++; } else { cur = 1; }
          } else { cur = 1; }
          if (cur > bestStreak) bestStreak = cur;
        } else { cur = 0; }
      }

      // Current streak: walk back from today
      let streak = 0;
      let checkDate = htDaysBefore(today, 1); // start from yesterday
      // Also check today
      const todayVal = getVal(today);
      if (todayVal?.done) { streak = 1; checkDate = htDaysBefore(today, 1); }
      for (let i = 0; i < 3650; i++) {
        const v = getVal(checkDate);
        if (v?.done) { streak++; checkDate = htDaysBefore(checkDate, 1); }
        else break;
      }

      contentEl.innerHTML = '';

      // ── Stat cards ──
      const cards = document.createElement('div');
      cards.className = 'ht-stat-cards';

      const makeCard = (label, value, unit, cls) => {
        const c = document.createElement('div');
        c.className = 'ht-stat-card' + (cls ? ' ' + cls : '');
        c.innerHTML = `<div class="ht-stat-label">${label}</div><div class="ht-stat-value">${value}</div><div class="ht-stat-unit">${unit}</div>`;
        return c;
      };

      cards.appendChild(makeCard('Streak', streak, 'days', streak > 0 ? 'fire' : ''));
      cards.appendChild(makeCard('Best', bestStreak, 'days', bestStreak > 0 ? 'accent' : ''));
      cards.appendChild(makeCard('Rate', completionRate + '%', rateLabel, ''));

      if (isHabit && habit?.target > 0) {
        cards.appendChild(makeCard('Total', totalVal, habit.unit || 'total', 'accent'));
      }
      contentEl.appendChild(cards);

      // ── Calendar view (7d = weekly strip, 30d = monthly grid) ──
      const calSection = document.createElement('div');
      calSection.className = 'ht-stats-section';
      calSection.innerHTML = '<div class="ht-stats-section-title">Completion Calendar</div>';

      if (rangeDays === 7) {
        // ── 7-day strip: day columns with date number + circle ──
        const strip = document.createElement('div');
        strip.className = 'ht-cal-strip';
        const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        dates.forEach((d, i) => {
          const v = dayVals[i];
          const dt = new Date(d + 'T12:00:00');
          const isToday = d === today;
          const col = document.createElement('div');
          col.className = 'ht-cal-strip-col' + (isToday ? ' today' : '');
          const dayName = document.createElement('div');
          dayName.className = 'ht-cal-strip-dow';
          dayName.textContent = DOW[dt.getDay()];
          const circle = document.createElement('div');
          circle.className = 'ht-cal-strip-circle' + (v?.done ? ' done' : (v && v.val > 0 ? ' partial' : ''));
          const dateNum = document.createElement('div');
          dateNum.className = 'ht-cal-strip-date';
          dateNum.textContent = dt.getDate();
          // Show value inside circle for numeric habits
          if (isHabit && habit?.target > 0 && v?.val > 0) {
            circle.textContent = v.val;
            circle.classList.add('has-val');
          }
          circle.title = d + (v?.val != null ? ': ' + v.val : '');
          wireCircle(circle, d, v);
          col.appendChild(dayName);
          col.appendChild(circle);
          col.appendChild(dateNum);
          strip.appendChild(col);
        });
        calSection.appendChild(strip);

      } else {
        // ── 30-day monthly calendar grid ──
        // Show the month that contains the most days in our range
        const midDate = new Date(dates[Math.floor(dates.length / 2)] + 'T12:00:00');
        let calYear = midDate.getFullYear();
        let calMonth = midDate.getMonth();

        const renderMonth = (year, month) => {
          calSection.querySelector('.ht-cal-month-view')?.remove();
          const mv = document.createElement('div');
          mv.className = 'ht-cal-month-view';

          // Month nav header
          const nav = document.createElement('div');
          nav.className = 'ht-cal-month-nav';
          const prevMo = document.createElement('button');
          prevMo.className = 'ht-cal-nav-btn'; prevMo.textContent = '‹';
          const monthTitle = document.createElement('span');
          monthTitle.className = 'ht-cal-month-title';
          monthTitle.textContent = new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
          const nextMo = document.createElement('button');
          nextMo.className = 'ht-cal-nav-btn'; nextMo.textContent = '›';
          prevMo.addEventListener('click', () => {
            calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; }
            renderMonth(calYear, calMonth);
          });
          nextMo.addEventListener('click', () => {
            calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; }
            renderMonth(calYear, calMonth);
          });
          nav.appendChild(prevMo); nav.appendChild(monthTitle); nav.appendChild(nextMo);
          mv.appendChild(nav);

          // Day-of-week headers
          const dowRow = document.createElement('div');
          dowRow.className = 'ht-cal-dow-row';
          for (const d of ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']) {
            const h = document.createElement('div');
            h.className = 'ht-cal-dow-header'; h.textContent = d;
            dowRow.appendChild(h);
          }
          mv.appendChild(dowRow);

          // Build day grid
          const firstDay = new Date(year, month, 1);
          const lastDay = new Date(year, month + 1, 0);
          const startDow = firstDay.getDay();
          const grid = document.createElement('div');
          grid.className = 'ht-cal-grid';

          // Pad start
          for (let p = 0; p < startDow; p++) {
            const empty = document.createElement('div');
            empty.className = 'ht-cal-day empty';
            grid.appendChild(empty);
          }

          for (let day = 1; day <= lastDay.getDate(); day++) {
            const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
            const idx = dates.indexOf(dateStr);
            const v = idx >= 0 ? dayVals[idx] : null;
            const isToday = dateStr === today;
            // In range if within rolling window OR if there's log data for this date
            const inRange = idx >= 0 || allLogDates.has(dateStr);

            // Compute value from log directly for dates outside the rolling window
            let cellV = v;
            if (!cellV && allLogDates.has(dateStr)) {
              const log = logsByDate.get(dateStr);
              if (log) {
                if (isOverall) {
                  const done = activeHabits.filter(h => {
                    const cv = log.completions?.[h.id];
                    if (!cv) return false;
                    if ((h.target||0) > 0) return typeof cv === 'number' ? cv >= h.target : false;
                    return true;
                  }).length;
                  cellV = { val: done, max: activeHabits.length, done: done === activeHabits.length };
                } else if (isCat) {
                  cellV = { val: log.categoryDone?.[catId] ? 1 : 0, max: 1, done: !!log.categoryDone?.[catId] };
                } else if (isHabit && habit) {
                  const hv = log.completions?.[habit.id];
                  const num = typeof hv === 'number' ? hv : (hv ? 1 : 0);
                  const target = habit.target || 0;
                  cellV = { val: num, max: target || 1, done: target > 0 ? num >= target : !!hv };
                }
              }
            }

            const cell = document.createElement('div');
            cell.className = 'ht-cal-day' +
              (isToday ? ' today' : '') +
              (!inRange ? ' out-of-range' : '') +
              (cellV?.done ? ' done' : (cellV && cellV.val > 0 ? ' partial' : ''));

            const num = document.createElement('div');
            num.className = 'ht-cal-day-num'; num.textContent = day;
            const dot = document.createElement('div');
            dot.className = 'ht-cal-day-dot';
            cell.appendChild(num);
            cell.appendChild(dot);
            // For numeric habits, show value as small text
            if (isHabit && habit?.target > 0 && cellV?.val > 0) {
              const valEl = document.createElement('div');
              valEl.className = 'ht-cal-day-val';
              valEl.textContent = cellV.val;
              cell.appendChild(valEl);
            }
            cell.title = dateStr + (cellV?.val != null ? ': ' + cellV.val : '');
            if (inRange) wireCircle(cell, dateStr, cellV);
            grid.appendChild(cell);
          }
          mv.appendChild(grid);
          calSection.appendChild(mv);
        };

        renderMonth(calYear, calMonth);
      }

      contentEl.appendChild(calSection);

      // ── Bar chart ──
      const chartSection = document.createElement('div');
      chartSection.className = 'ht-stats-section';
      chartSection.innerHTML = '<div class="ht-stats-section-title">Daily Progress</div>';

      const chartEl = document.createElement('div');
      chartEl.className = 'ht-barchart';

      // Only show last 30 days max in bar chart (too cramped otherwise)
      const chartDates = dates.slice(-Math.min(30, dates.length));
      const chartVals = dayVals.slice(-chartDates.length);
      const maxVal = Math.max(1, ...chartVals.map(v => v?.val || 0));
      const target = (isHabit && habit?.target > 0) ? habit.target : (isOverall ? activeHabits.length : 1);

      if (target > 0 && maxVal > 0) {
        const targetPct = Math.min(100, (target / Math.max(maxVal, target)) * 100);
        const line = document.createElement('div');
        line.className = 'ht-target-line';
        line.style.bottom = targetPct + '%';
        const tLabel = document.createElement('div');
        tLabel.className = 'ht-target-label';
        tLabel.style.bottom = targetPct + '%';
        tLabel.textContent = target;
        chartEl.appendChild(line);
        chartEl.appendChild(tLabel);
      }

      const labelsEl = document.createElement('div');
      labelsEl.className = 'ht-barchart-labels';
      const labelInterval = Math.ceil(chartDates.length / 6);

      chartDates.forEach((d, i) => {
        const v = chartVals[i];
        // Bar
        const wrap = document.createElement('div');
        wrap.className = 'ht-bar-wrap';
        const bar = document.createElement('div');
        bar.className = 'ht-bar' + (v?.done ? ' done' : '');
        const heightPct = v ? Math.max(2, Math.round((v.val / Math.max(maxVal, target)) * 100)) : 0;
        bar.style.height = heightPct + '%';
        wrap.appendChild(bar);
        // Hover tooltip showing value
        if (v?.val > 0) {
          const tooltip = document.createElement('div');
          tooltip.className = 'ht-bar-tooltip';
          tooltip.textContent = v.val + (habit?.unit ? ' ' + habit.unit : '');
          wrap.appendChild(tooltip);
        }
        chartEl.appendChild(wrap);

        // Label in separate row — always add a slot, only fill text on interval
        const lblWrap = document.createElement('div');
        lblWrap.className = 'ht-bar-label-wrap';
        if (i % labelInterval === 0) {
          const lbl = document.createElement('div');
          lbl.className = 'ht-bar-label';
          lbl.textContent = new Date(d + 'T12:00:00').getDate();
          lblWrap.appendChild(lbl);
        }
        labelsEl.appendChild(lblWrap);
      });

      const barchartWrap = document.createElement('div');
      barchartWrap.className = 'ht-barchart-wrap';
      // Target line/label stay in chartEl — positioned relative to bar area height
      barchartWrap.appendChild(chartEl);
      barchartWrap.appendChild(labelsEl);
      chartSection.appendChild(barchartWrap);
      contentEl.appendChild(chartSection);

      // ── Category completion rates (overall view only) ──
      if (isOverall) {
        const rateSection = document.createElement('div');
        rateSection.className = 'ht-stats-section';
        rateSection.innerHTML = '<div class="ht-stats-section-title">Category Completion Rate</div>';

        for (const c of config.categories) {
          const habitsInCat = activeHabits.filter(h => h.categoryId === c.id);
          if (habitsInCat.length === 0) continue;
          const catDoneDays = dates.filter(d => {
            const log = logsByDate.get(d);
            return log?.categoryDone?.[c.id];
          }).length;
          const rate = dates.length > 0 ? Math.round((catDoneDays / dates.length) * 100) : 0;
          const row = document.createElement('div');
          row.className = 'ht-cat-rate-row';
          row.innerHTML = `
            <span class="ht-cat-rate-name">${htEsc(c.emoji||'')} ${htEsc(c.name)}</span>
            <div class="ht-cat-rate-bar-wrap"><div class="ht-cat-rate-bar" style="width:${rate}%"></div></div>
            <span class="ht-cat-rate-pct">${rate}%</span>
          `;
          rateSection.appendChild(row);
        }
        contentEl.appendChild(rateSection);
      }

    };

    await renderContent();
  }

  refreshAllPanels() {
    for (const [, state] of (this._panelStates || [])) {
      if (state.bodyEl?.dataset?.mode === 'stats') continue;
      this._renderSidebar(state);
    }
  }

  // ── Settings UI ──────────────────────────────────────────────────────────

  openSettings() {
    // Remove any existing modal
    document.querySelector('.ht-modal-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'ht-modal-overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    const modal = document.createElement('div');
    modal.className = 'ht-modal';

    // Work on a deep copy so we can cancel
    const draft = JSON.parse(JSON.stringify(this._config));

    modal.innerHTML = `
      <div class="ht-modal-header">
        <span class="ht-modal-title">🔥 HabitTracker — Manage Habits</span>
        <button class="ht-modal-close" title="Close">✕</button>
      </div>
      <div class="ht-modal-body" id="ht-settings-body"></div>
      <div class="ht-modal-footer">
        <button class="ht-btn ht-btn-secondary" data-action="cancel">Cancel</button>
        <button class="ht-btn ht-btn-primary" data-action="save">Save</button>
      </div>
    `;

    modal.querySelector('.ht-modal-close').addEventListener('click', () => overlay.remove());
    modal.querySelector('[data-action="cancel"]').addEventListener('click', () => overlay.remove());
    modal.querySelector('[data-action="save"]').addEventListener('click', async () => {
      this._config = draft;
      await this._saveConfig();
      overlay.remove();
      this.refreshAllPanels();
      this.ui.addToaster({ title: 'HabitTracker', message: 'Habits saved!', dismissible: true, autoDestroyTime: 2000 });
    });

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    this._renderSettings(modal.querySelector('#ht-settings-body'), draft);
  }

  _renderSettings(container, draft) {
    container.innerHTML = '';

    // ── Categories section ───────────────────────────────────────────────
    const catTitle = document.createElement('div');
    catTitle.className = 'ht-section-title';
    catTitle.textContent = 'Categories';
    container.appendChild(catTitle);

    const catList = document.createElement('div');
    catList.id = 'ht-cat-list';
    container.appendChild(catList);

    // drag state for categories
    let catDragSrcId = null;

    const renderCats = () => {
      catList.innerHTML = '';
      const sorted = [...draft.categories].sort((a,b) => (a.order||0)-(b.order||0));
      for (const cat of sorted) {
        const item = document.createElement('div');
        item.className = 'ht-cat-item';
        item.draggable = false;  // enabled only via handle mousedown
        item.dataset.catId = cat.id;
        item.innerHTML = `
          <span class="ht-drag-handle" title="Drag to reorder">⠿</span>
          <span class="ht-item-emoji">${htEsc(cat.emoji || '📋')}</span>
          <span class="ht-item-left"><span class="ht-item-name">${htEsc(cat.name)}</span></span>
          <div class="ht-item-actions">
            <button class="ht-btn ht-btn-secondary ht-btn-sm" data-action="edit-cat" data-id="${cat.id}" title="Edit">✏️</button>
            <button class="ht-btn ht-btn-danger ht-btn-sm" data-action="del-cat" data-id="${cat.id}" title="Delete">🗑</button>
          </div>
        `;

        // ── Drag events ──
        // Only start drag when initiated from the handle
        const catHandle = item.querySelector('.ht-drag-handle');
        if (catHandle) {
          catHandle.addEventListener('mousedown', () => { item.draggable = true; });
          catHandle.addEventListener('mouseup',   () => { item.draggable = false; });
        }
        item.addEventListener('dragstart', (e) => {
          if (!item.draggable) { e.preventDefault(); return; }
          catDragSrcId = cat.id;
          item.classList.add('ht-dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', cat.id);
        });
        item.addEventListener('dragend', () => {
          item.draggable = false;
          item.classList.remove('ht-dragging');
          catList.querySelectorAll('.ht-drag-over').forEach(el => el.classList.remove('ht-drag-over'));
        });
        item.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (catDragSrcId !== cat.id) item.classList.add('ht-drag-over');
        });
        item.addEventListener('dragleave', () => {
          item.classList.remove('ht-drag-over');
        });
        item.addEventListener('drop', (e) => {
          e.preventDefault();
          e.stopPropagation();
          item.classList.remove('ht-drag-over');
          if (!catDragSrcId || catDragSrcId === cat.id) return;

          const srcCat = draft.categories.find(c => c.id === catDragSrcId);
          if (!srcCat) return;

          const sortedCats = [...draft.categories].sort((a,b) => (a.order||0)-(b.order||0));
          const srcIdx = sortedCats.findIndex(c => c.id === catDragSrcId);
          const dstIdx = sortedCats.findIndex(c => c.id === cat.id);
          if (srcIdx < 0 || dstIdx < 0) return;

          sortedCats.splice(srcIdx, 1);
          sortedCats.splice(dstIdx, 0, srcCat);
          sortedCats.forEach((c, i) => { c.order = i; });

          catDragSrcId = null;
          renderCats();
          renderHabits(); // habits re-sort by cat order
        });
        item.querySelector('[data-action="edit-cat"]').addEventListener('click', (e) => {
          e.stopPropagation();
          const leftEl = item.querySelector('.ht-item-left');
          const actionsEl = item.querySelector('.ht-item-actions');
          const emojiEl = item.querySelector('.ht-item-emoji');
          leftEl.style.display = 'none';
          actionsEl.style.display = 'none';
          emojiEl.style.display = 'none';

          const editForm = document.createElement('div');
          editForm.style.cssText = 'display:flex;flex:1;gap:6px;align-items:center;flex-wrap:wrap;';

          const emojiInput = document.createElement('input');
          emojiInput.className = 'ht-input';
          emojiInput.value = cat.emoji || '📋';
          emojiInput.style.cssText = 'width:52px;flex-shrink:0;text-align:center;';
          emojiInput.placeholder = '📋';

          const nameInput = document.createElement('input');
          nameInput.className = 'ht-input';
          nameInput.value = cat.name;
          nameInput.style.cssText = 'flex:1;min-width:80px;';

          const saveBtn = document.createElement('button');
          saveBtn.className = 'ht-btn ht-btn-primary ht-btn-sm';
          saveBtn.textContent = 'Save';

          const cancelBtn = document.createElement('button');
          cancelBtn.className = 'ht-btn ht-btn-secondary ht-btn-sm';
          cancelBtn.textContent = 'Cancel';

          const finish = () => {
            editForm.remove();
            leftEl.style.display = '';
            actionsEl.style.display = '';
            emojiEl.style.display = '';
          };

          saveBtn.addEventListener('click', () => {
            const newName = nameInput.value.trim();
            if (!newName) return;
            cat.emoji = emojiInput.value.trim() || '📋';
            cat.name = newName;
            finish();
            renderCats();
          });
          cancelBtn.addEventListener('click', finish);
          nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveBtn.click();
            if (e.key === 'Escape') cancelBtn.click();
          });

          editForm.appendChild(emojiInput);
          editForm.appendChild(nameInput);
          editForm.appendChild(saveBtn);
          editForm.appendChild(cancelBtn);
          item.insertBefore(editForm, actionsEl);
          nameInput.focus();
          nameInput.select();
        });
        item.querySelector('[data-action="del-cat"]').addEventListener('click', () => {
          if (!confirm(`Delete category "${cat.name}"? Habits in this category will also be removed.`)) return;
          const idx = draft.categories.findIndex(c => c.id === cat.id);
          if (idx >= 0) draft.categories.splice(idx, 1);
          draft.habits = draft.habits.filter(h => h.categoryId !== cat.id);
          renderCats();
          renderHabits();
        });
        catList.appendChild(item);
      }
    };
    renderCats();

    // Add category row
    const addCatRow = document.createElement('div');
    addCatRow.className = 'ht-add-row';
    addCatRow.innerHTML = `
      <input class="ht-input" id="ht-new-cat-emoji" placeholder="Emoji" style="max-width:60px;">
      <input class="ht-input" id="ht-new-cat-name" placeholder="Category name (e.g. expansion)">
      <button class="ht-btn ht-btn-primary ht-btn-sm" id="ht-add-cat-btn">Add</button>
    `;
    addCatRow.querySelector('#ht-add-cat-btn').addEventListener('click', () => {
      const emoji = addCatRow.querySelector('#ht-new-cat-emoji').value.trim() || '📋';
      const name = addCatRow.querySelector('#ht-new-cat-name').value.trim();
      if (!name) return;
      draft.categories.push({ id: htGenId(), name, emoji, order: draft.categories.length });
      addCatRow.querySelector('#ht-new-cat-emoji').value = '';
      addCatRow.querySelector('#ht-new-cat-name').value = '';
      renderCats();
      renderHabits(); // refresh category select
    });
    // Allow Enter key in name field
    addCatRow.querySelector('#ht-new-cat-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addCatRow.querySelector('#ht-add-cat-btn').click();
    });
    container.appendChild(addCatRow);

    // ── Divider ─────────────────────────────────────────────────────────
    const div = document.createElement('div');
    div.className = 'ht-divider';
    container.appendChild(div);

    // ── Habits section ───────────────────────────────────────────────────
    const habitTitle = document.createElement('div');
    habitTitle.className = 'ht-section-title';
    habitTitle.textContent = 'Active Habits';
    container.appendChild(habitTitle);

    // Shared selection state (spans active + archived lists)
    const selected = new Set();

    // Sticky bulk-action bar — appears when anything is checked
    const bulkBar = document.createElement('div');
    bulkBar.className = 'ht-bulk-bar';
    bulkBar.style.display = 'none';
    bulkBar.innerHTML = `
      <span id="ht-bulk-count" style="flex:1;font-weight:600;"></span>
      <button class="ht-btn ht-btn-danger ht-btn-sm" id="ht-bulk-delete">🗑 Delete selected</button>
      <button class="ht-btn ht-btn-secondary ht-btn-sm" id="ht-bulk-archive">📦 Archive selected</button>
      <button class="ht-btn ht-btn-secondary ht-btn-sm" id="ht-bulk-clear">✕ Deselect all</button>
    `;
    container.appendChild(bulkBar);

    const updateBulkBar = () => {
      bulkBar.style.display = selected.size > 0 ? 'flex' : 'none';
      const el = bulkBar.querySelector('#ht-bulk-count');
      if (el) el.textContent = `${selected.size} habit${selected.size === 1 ? '' : 's'} selected`;
    };

    bulkBar.querySelector('#ht-bulk-clear').addEventListener('click', () => {
      selected.clear(); updateBulkBar(); renderHabits(); renderArchive();
    });
    bulkBar.querySelector('#ht-bulk-delete').addEventListener('click', () => {
      if (!confirm(`Permanently delete ${selected.size} habit(s)?

This cannot be undone.`)) return;
      draft.habits = draft.habits.filter(h => !selected.has(h.id));
      selected.clear(); updateBulkBar(); renderHabits(); renderArchive();
    });
    bulkBar.querySelector('#ht-bulk-archive').addEventListener('click', () => {
      draft.habits.filter(h => selected.has(h.id)).forEach(h => { h.archived = true; });
      selected.clear(); updateBulkBar(); renderHabits(); renderArchive();
    });

    const habitList = document.createElement('div');
    habitList.id = 'ht-habit-list';
    container.appendChild(habitList);

    // ── Archived habits section ──────────────────────────────────────────
    const archiveTitle = document.createElement('div');
    archiveTitle.className = 'ht-section-title ht-archive-title';
    archiveTitle.style.cssText = 'margin-top:20px;cursor:pointer;display:flex;align-items:center;gap:6px;';
    container.appendChild(archiveTitle);

    const archiveList = document.createElement('div');
    archiveList.id = 'ht-archive-list';
    container.appendChild(archiveList);

    let archiveOpen = false;

    const renderArchive = () => {
      const archived = draft.habits.filter(h => h.archived);
      archiveTitle.innerHTML = `<span style="flex:1">📦 Archived (${archived.length})</span><span style="font-size:10px;opacity:0.6">${archiveOpen ? '▲ hide' : '▼ show'}</span>`;
      archiveList.style.display = archiveOpen ? '' : 'none';
      archiveList.innerHTML = '';
      if (archived.length === 0) {
        archiveList.innerHTML = '<div style="font-size:12px;color:#8a7e6a;padding:6px 0 2px;">No archived habits.</div>';
        return;
      }
      for (const habit of archived) {
        const cat = draft.categories.find(c => c.id === habit.categoryId);
        const item = document.createElement('div');
        item.className = 'ht-habit-item';
        item.style.opacity = '0.6';
        if (selected.has(habit.id)) { item.classList.add('ht-selected'); item.style.opacity = '1'; }
        item.innerHTML = `
          <input type="checkbox" class="ht-habit-cb" ${selected.has(habit.id) ? 'checked' : ''} title="Select">
          <div class="ht-item-left">
            <span class="ht-item-name" style="color:#8a7e6a;text-decoration:line-through">${htEsc(habit.name)}</span>
            <span class="ht-item-sub">${htEsc(cat?.emoji || '')} ${htEsc(cat?.name || 'Unknown')}</span>
          </div>
          <div class="ht-item-actions">
            <button class="ht-btn ht-btn-secondary ht-btn-sm" data-action="unarchive-habit" data-id="${habit.id}" title="Restore">↩ Restore</button>
            <button class="ht-btn ht-btn-danger ht-btn-sm" data-action="del-habit" data-id="${habit.id}" title="Delete permanently">🗑</button>
          </div>
        `;
        item.querySelector('.ht-habit-cb').addEventListener('change', (e) => {
          if (e.target.checked) selected.add(habit.id); else selected.delete(habit.id);
          item.classList.toggle('ht-selected', e.target.checked);
          item.style.opacity = e.target.checked ? '1' : '0.6';
          updateBulkBar();
        });
        item.querySelector('[data-action="unarchive-habit"]').addEventListener('click', () => {
          habit.archived = false;
          renderHabits();
          renderArchive();
        });
        item.querySelector('[data-action="del-habit"]').addEventListener('click', () => {
          if (!confirm(`Permanently delete "${habit.name}"? This cannot be undone.`)) return;
          const idx = draft.habits.findIndex(h => h.id === habit.id);
          if (idx >= 0) draft.habits.splice(idx, 1);
          renderArchive();
        });
        archiveList.appendChild(item);
      }
    };

    archiveTitle.addEventListener('click', () => {
      archiveOpen = !archiveOpen;
      renderArchive();
    });

    // drag state for habits
    let habitDragSrcId = null;

    const renderHabits = () => {
      habitList.innerHTML = '';
      const active = draft.habits.filter(h => !h.archived);
      const sorted = [...active].sort((a,b) => {
        const aCat = draft.categories.findIndex(c => c.id === a.categoryId);
        const bCat = draft.categories.findIndex(c => c.id === b.categoryId);
        if (aCat !== bCat) return aCat - bCat;
        return (a.order||0) - (b.order||0);
      });
      for (const habit of sorted) {
        const cat = draft.categories.find(c => c.id === habit.categoryId);
        const item = document.createElement('div');
        item.className = 'ht-habit-item';
        item.draggable = false;  // enabled only via handle mousedown
        item.dataset.habitId = habit.id;
        const seedHint = habit.seedDate ? `<span style="font-size:10px;color:#c4a882;margin-left:4px;" title="Streak seeded from ${habit.seedDate}">🔥 since ${habit.seedDate}</span>` : '';
        const targetHint = habit.target > 0 ? ` · 🎯${habit.target}${habit.unit ? ' ' + habit.unit : ''}` : '';
        if (selected.has(habit.id)) item.classList.add('ht-selected');
        item.innerHTML = `
          <input type="checkbox" class="ht-habit-cb" ${selected.has(habit.id) ? 'checked' : ''} title="Select">
          <span class="ht-drag-handle" title="Drag to reorder">⠿</span>
          <div class="ht-item-left">
            <span class="ht-item-name">${htEsc(habit.name)}${seedHint}</span>
            <span class="ht-item-sub">${htEsc(cat?.emoji || '')} ${htEsc(cat?.name || 'Unknown')}${targetHint}</span>
          </div>
          <div class="ht-item-actions">
            <button class="ht-btn ht-btn-secondary ht-btn-sm" data-action="edit-habit" data-id="${habit.id}" title="Edit">✏️</button>
            <button class="ht-btn ht-btn-secondary ht-btn-sm" data-action="archive-habit" data-id="${habit.id}" title="Archive">📦</button>
            <button class="ht-btn ht-btn-danger ht-btn-sm" data-action="del-habit" data-id="${habit.id}" title="Delete">🗑</button>
          </div>
        `;
        item.querySelector('.ht-habit-cb').addEventListener('change', (e) => {
          if (e.target.checked) selected.add(habit.id); else selected.delete(habit.id);
          item.classList.toggle('ht-selected', e.target.checked);
          updateBulkBar();
        });

        // ── Drag events ──
        // Only start drag when initiated from the handle
        const habitHandle = item.querySelector('.ht-drag-handle');
        if (habitHandle) {
          habitHandle.addEventListener('mousedown', () => { item.draggable = true; });
          habitHandle.addEventListener('mouseup',   () => { item.draggable = false; });
        }
        item.addEventListener('dragstart', (e) => {
          if (!item.draggable) { e.preventDefault(); return; }
          habitDragSrcId = habit.id;
          item.classList.add('ht-dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', habit.id);
        });
        item.addEventListener('dragend', () => {
          item.draggable = false;
          item.classList.remove('ht-dragging');
          habitList.querySelectorAll('.ht-drag-over').forEach(el => el.classList.remove('ht-drag-over'));
        });
        item.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (habitDragSrcId !== habit.id) item.classList.add('ht-drag-over');
        });
        item.addEventListener('dragleave', () => {
          item.classList.remove('ht-drag-over');
        });
        item.addEventListener('drop', (e) => {
          e.preventDefault();
          e.stopPropagation();
          item.classList.remove('ht-drag-over');
          if (!habitDragSrcId || habitDragSrcId === habit.id) return;

          const srcHabit = draft.habits.find(h => h.id === habitDragSrcId);
          const dstHabit = habit;
          if (!srcHabit) return;

          // Move src to dst's category and position
          // Get current sorted active list (same order as rendered)
          const active = draft.habits.filter(h => !h.archived).sort((a,b) => {
            const aCat = draft.categories.findIndex(c => c.id === a.categoryId);
            const bCat = draft.categories.findIndex(c => c.id === b.categoryId);
            if (aCat !== bCat) return aCat - bCat;
            return (a.order||0) - (b.order||0);
          });

          const srcIdx = active.findIndex(h => h.id === habitDragSrcId);
          const dstIdx = active.findIndex(h => h.id === dstHabit.id);
          if (srcIdx < 0 || dstIdx < 0) return;

          // Reorder in the active array
          active.splice(srcIdx, 1);
          active.splice(dstIdx, 0, srcHabit);

          // Move src to dst's category
          srcHabit.categoryId = dstHabit.categoryId;

          // Write back order values grouped by category
          const orderByCat = new Map();
          for (const h of active) {
            if (!orderByCat.has(h.categoryId)) orderByCat.set(h.categoryId, 0);
            h.order = orderByCat.get(h.categoryId);
            orderByCat.set(h.categoryId, h.order + 1);
          }

          habitDragSrcId = null;
          renderHabits();
        });
        item.querySelector('[data-action="edit-habit"]').addEventListener('click', (e) => {
          e.stopPropagation();
          // Swap item content for an inline edit form
          const leftEl = item.querySelector('.ht-item-left');
          const actionsEl = item.querySelector('.ht-item-actions');
          leftEl.style.display = 'none';
          actionsEl.style.display = 'none';

          const editForm = document.createElement('div');
          editForm.style.cssText = 'display:flex;flex:1;gap:6px;align-items:center;flex-wrap:wrap;';

          const nameInput = document.createElement('input');
          nameInput.className = 'ht-input';
          nameInput.value = habit.name;
          nameInput.style.cssText = 'flex:1;min-width:80px;';

          const catSel = document.createElement('select');
          catSel.className = 'ht-select';
          for (const c of draft.categories) {
            const o = document.createElement('option');
            o.value = c.id;
            o.textContent = `${c.emoji || ''} ${c.name}`;
            if (c.id === habit.categoryId) o.selected = true;
            catSel.appendChild(o);
          }

          // Streak seed date row
          const seedRow = document.createElement('div');
          seedRow.style.cssText = 'display:flex;align-items:center;gap:6px;width:100%;margin-top:4px;flex-wrap:wrap;';
          const seedLabel = document.createElement('span');
          seedLabel.style.cssText = 'font-size:11px;color:#8a7e6a;white-space:nowrap;';
          seedLabel.textContent = '🔥 Streak since:';
          const seedInput = document.createElement('input');
          seedInput.type = 'date';
          seedInput.className = 'ht-input';
          seedInput.style.cssText = 'flex:1;min-width:120px;';
          seedInput.value = habit.seedDate || '';
          seedInput.title = 'Set this to bring over an existing streak from another app';
          const clearSeedBtn = document.createElement('button');
          clearSeedBtn.className = 'ht-btn ht-btn-secondary ht-btn-sm';
          clearSeedBtn.textContent = '✕ Clear';
          clearSeedBtn.addEventListener('click', () => { seedInput.value = ''; });
          seedRow.appendChild(seedLabel);
          seedRow.appendChild(seedInput);
          seedRow.appendChild(clearSeedBtn);

          const saveBtn = document.createElement('button');
          saveBtn.className = 'ht-btn ht-btn-primary ht-btn-sm';
          saveBtn.textContent = 'Save';

          const cancelBtn = document.createElement('button');
          cancelBtn.className = 'ht-btn ht-btn-secondary ht-btn-sm';
          cancelBtn.textContent = 'Cancel';

          const finish = () => {
            editForm.remove();
            leftEl.style.display = '';
            actionsEl.style.display = '';
          };

          // Target + unit row
          const targetRow = document.createElement('div');
          targetRow.style.cssText = 'display:flex;align-items:center;gap:6px;width:100%;margin-top:4px;flex-wrap:wrap;';
          const targetLabel = document.createElement('span');
          targetLabel.style.cssText = 'font-size:11px;color:#8a7e6a;white-space:nowrap;';
          targetLabel.textContent = '🎯 Daily target:';
          const targetInput = document.createElement('input');
          targetInput.type = 'number';
          targetInput.className = 'ht-input';
          targetInput.style.cssText = 'width:60px;flex-shrink:0;';
          targetInput.placeholder = '—';
          targetInput.min = 0;
          targetInput.value = habit.target > 0 ? habit.target : '';
          targetInput.title = 'Set a number target (e.g. 10 pushups). Leave blank for a simple checkbox.';
          const unitInput = document.createElement('input');
          unitInput.className = 'ht-input';
          unitInput.style.cssText = 'flex:1;min-width:60px;';
          unitInput.placeholder = 'unit (e.g. mins, reps)';
          unitInput.value = habit.unit || '';
          const clearTargetBtn = document.createElement('button');
          clearTargetBtn.className = 'ht-btn ht-btn-secondary ht-btn-sm';
          clearTargetBtn.textContent = '✕';
          clearTargetBtn.title = 'Clear target (back to checkbox)';
          clearTargetBtn.addEventListener('click', () => { targetInput.value = ''; unitInput.value = ''; });
          targetRow.appendChild(targetLabel);
          targetRow.appendChild(targetInput);
          targetRow.appendChild(unitInput);
          targetRow.appendChild(clearTargetBtn);

          saveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const newName = nameInput.value.trim();
            if (!newName) return;
            habit.name = newName;
            habit.categoryId = catSel.value;
            habit.seedDate = seedInput.value || null;
            const rawTarget = targetInput.value.trim();
            const tVal = rawTarget === '' ? 0 : parseInt(rawTarget, 10);
            habit.target = (Number.isInteger(tVal) && tVal > 0) ? tVal : 0;
            habit.unit = unitInput.value.trim() || null;
            finish();
            renderHabits();
          });
          cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); finish(); });
          // Stop clicks inside the form from bubbling to the item row
          editForm.addEventListener('click', (e) => e.stopPropagation());
          nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveBtn.click();
            if (e.key === 'Escape') cancelBtn.click();
          });
          targetInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveBtn.click();
            if (e.key === 'Escape') cancelBtn.click();
          });
          unitInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveBtn.click();
            if (e.key === 'Escape') cancelBtn.click();
          });

          editForm.appendChild(nameInput);
          editForm.appendChild(catSel);
          editForm.appendChild(saveBtn);
          editForm.appendChild(cancelBtn);
          editForm.appendChild(targetRow);
          editForm.appendChild(seedRow);
          item.insertBefore(editForm, actionsEl);
          nameInput.focus();
          nameInput.select();
        });
        item.querySelector('[data-action="archive-habit"]').addEventListener('click', () => {
          habit.archived = true;
          renderHabits();
          renderArchive();
        });
        item.querySelector('[data-action="del-habit"]').addEventListener('click', () => {
          if (!confirm(`Permanently delete "${habit.name}"? This cannot be undone.\n\nTip: use 📦 Archive instead to keep your history.`)) return;
          const idx = draft.habits.findIndex(h => h.id === habit.id);
          if (idx >= 0) draft.habits.splice(idx, 1);
          renderHabits();
          renderArchive();
        });
        habitList.appendChild(item);
      }
      if (sorted.length === 0) {
        habitList.innerHTML = '<div style="font-size:12px;color:#8a7e6a;padding:8px 0;">No active habits. Add one below.</div>';
      }
      renderArchive();
    };
    renderHabits();

    // Add habit row
    const addHabitRow = document.createElement('div');
    addHabitRow.className = 'ht-add-row';

    const catSelect = document.createElement('select');
    catSelect.className = 'ht-select';
    catSelect.id = 'ht-new-habit-cat';

    const refreshCatSelect = () => {
      catSelect.innerHTML = '';
      if (draft.categories.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '(add a category first)';
        catSelect.appendChild(opt);
      } else {
        for (const cat of draft.categories) {
          const opt = document.createElement('option');
          opt.value = cat.id;
          opt.textContent = `${cat.emoji || ''} ${cat.name}`;
          catSelect.appendChild(opt);
        }
      }
    };
    refreshCatSelect();

    // Observe category changes to refresh select
    const origRenderCats = renderCats;
    const patchedRenderCats = () => { origRenderCats(); refreshCatSelect(); };

    const habitNameInput = document.createElement('input');
    habitNameInput.className = 'ht-input';
    habitNameInput.placeholder = 'Habit name (e.g. Read)';

    const addHabitBtn = document.createElement('button');
    addHabitBtn.className = 'ht-btn ht-btn-primary ht-btn-sm';
    addHabitBtn.textContent = 'Add';
    addHabitBtn.addEventListener('click', () => {
      const name = habitNameInput.value.trim();
      const catId = catSelect.value;
      if (!name || !catId) return;
      draft.habits.push({ id: htGenId(), name, categoryId: catId, order: draft.habits.filter(h=>h.categoryId===catId).length });
      habitNameInput.value = '';
      renderHabits();
    });
    habitNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addHabitBtn.click();
    });

    addHabitRow.appendChild(catSelect);
    addHabitRow.appendChild(habitNameInput);
    addHabitRow.appendChild(addHabitBtn);
    container.appendChild(addHabitRow);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TickTick Importer — file upload → mapping UI → import
  // ══════════════════════════════════════════════════════════════════════════

  async _diagnose() {
    if (!this._collection) { alert('No collection'); return; }
    const records = await this._collection.getAllRecords();

    // Count by type
    let configCount = 0, logCount = 0, emptyLogCount = 0, noDateCount = 0;
    const dateCounts = new Map(); // date → count of records
    const sampleDate = '2026-02-01';
    const sampleRecords = [];

    for (const r of records) {
      const name = r.getName?.() || '';
      if (name === '__config__') { configCount++; continue; }
      if (!name.startsWith('log-')) continue;
      logCount++;

      const raw = this._readDataProp(r);
      if (!raw) { emptyLogCount++; continue; }

      try {
        const d = JSON.parse(raw);
        if (!d.date) { noDateCount++; continue; }
        dateCounts.set(d.date, (dateCounts.get(d.date) || 0) + 1);
        if (d.date === sampleDate) {
          sampleRecords.push({
            name,
            completionKeys: Object.keys(d.completions || {}),
            catDoneKeys: Object.keys(d.categoryDone || {}),
          });
        }
      } catch(e) { noDateCount++; }
    }

    const duplicateDates = [...dateCounts.entries()].filter(([,c]) => c > 1);
    const maxDups = duplicateDates.reduce((m, [,c]) => Math.max(m,c), 0);

    // Test write — also check if prior session's write persisted
    let writeTest = 'not tested';
    try {
      const testDate = '1970-01-01-test';
      const prior = await this._loadLog(testDate);
      const priorPersisted = prior.completions?.test === true;
      await this._saveLog(testDate, { date: testDate, completions: { test: true, ts: Date.now() }, categoryDone: {} });
      await htSleep(400);
      const verify = await this._loadLog(testDate);
      const writeOk = verify.completions?.test === true;
      writeTest = (priorPersisted ? '✅ persisted · ' : '❌ NOT persisted across reload · ') +
                  (writeOk ? '✅ write works' : '❌ write failed');
    } catch(e) { writeTest = '❌ ERROR: ' + e.message; }

    // Test createRecord directly
    let createTest = 'not tested';
    try {
      const testName = 'log-1970-01-02-test';
      const guid = this._collection.createRecord(testName);
      createTest = guid ? `✅ got guid: ${guid.slice(0,8)}…` : '❌ createRecord returned null/undefined';
      if (guid) {
        await htSleep(300);
        const all2 = await this._collection.getAllRecords();
        const found = all2.find(r => r.guid === guid);
        if (found) {
          found.prop('data')?.set(JSON.stringify({ date: testName, completions: { create_test: true }, categoryDone: {} }));
          await htSleep(200);
          const readback = found.prop('data')?.get?.() || found.text?.('data') || '';
          createTest += readback ? ` · ✅ data set+read ok` : ` · ❌ data set but read empty`;
        } else {
          createTest += ' · ❌ record not found after creation';
        }
      }
    } catch(e) { createTest = '❌ ERROR: ' + e.message; }

    // Cross-reference: check if the habit IDs in log records match current config
    const cfg = this._config || { habits: [], categories: [] };
    const activeHabits = cfg.habits.filter(h => !h.archived);
    const configHabitIds = new Set(cfg.habits.map(h => h.id));
    let idMatchTest = '';
    try {
      const sampleLogRec = records.find(r => r.getName() === 'log-2026-02-01');
      if (sampleLogRec) {
        const raw = this._readDataProp(sampleLogRec);
        if (raw) {
          const d = JSON.parse(raw);
          const logIds = Object.keys(d.completions || {});
          const matched = logIds.filter(id => configHabitIds.has(id));
          const unmatched = logIds.filter(id => !configHabitIds.has(id));
          idMatchTest = `log-2026-02-01 has ${logIds.length} completions: ${matched.length} match config, ${unmatched.length} stale. Config has ${cfg.habits.length} habits total.`;
          if (unmatched.length > 0) idMatchTest += `\nStale IDs: ${unmatched.slice(0,3).join(',')}`;
          if (matched.length > 0) idMatchTest += `\nMatched IDs: ${matched.slice(0,3).join(',')}`;
        }
      }
    } catch(e) { idMatchTest = 'error: ' + e.message; }

    // Sample actual record names to verify getName() format
    const namesamples = records.slice(0, 10).map(r => {
      const n = r.getName?.();
      const raw = this._readDataProp(r);
      return `"${n}" hasData:${!!raw}`;
    });

    const msg = [
      `Write test: ${writeTest}`,
      `Create test: ${createTest}`,
      `ID match: ${idMatchTest}`,
      `Deep inspect: (removed)`,
      `Total records: ${records.length}`,
      `Config records: ${configCount}`,
      `Log records: ${logCount}`,
      `  Empty (no data): ${emptyLogCount}`,
      `  No date field: ${noDateCount}`,
      `  Unique dates: ${dateCounts.size}`,
      `  Dates with duplicates: ${duplicateDates.length}`,
      `  Max duplicates per date: ${maxDups}`,
      ``,
      `Sample date ${sampleDate}: ${sampleRecords.length} records`,
      ...sampleRecords.map((r,i) => `  [${i}] keys: ${r.completionKeys.slice(0,3).join(',')}... cats: ${r.catDoneKeys.join(',')}`),
      ``,
      `First 10 record names:`,
      ...namesamples,
    ].join('\n');

    console.log('[HT Diagnose]', msg);
    alert(msg);
  }

  // Delete log records with no completions AND no categoryDone (artifacts from bad imports)
  async _cleanEmptyLogs() {
    if (!this._collection) return;
    const records = await this._collection.getAllRecords();
    const toDelete = [];
    for (const r of records) {
      const name = r.getName?.() || '';
      if (!name.startsWith('log-')) continue;
      try {
        const raw = this._readDataProp(r);
        if (!raw) { toDelete.push(r); continue; }
        const d = JSON.parse(raw);
        const hasCompletions = d.completions && Object.keys(d.completions).length > 0;
        const hasCatDone = d.categoryDone && Object.keys(d.categoryDone).length > 0;
        if (!hasCompletions && !hasCatDone) toDelete.push(r);
      } catch(e) { toDelete.push(r); }
    }
    if (toDelete.length === 0) {
      this.ui.addToaster({ title: '✅ No empty log records found', autoDestroyTime: 3000 });
      return;
    }
    if (!confirm(`Delete ${toDelete.length} empty log records? These are leftover from a failed import.`)) return;
    this.ui.addToaster({ title: `🗑 Deleting ${toDelete.length} empty records…`, autoDestroyTime: 3000 });
    for (const r of toDelete) {
      try { await r.delete?.(); } catch(e) { try { r.prop('data')?.set?.('{"date":"","completions":{},"categoryDone":{}}'); } catch(e2) {} }
      await htSleep(30);
    }
    this.ui.addToaster({ title: `✅ Deleted ${toDelete.length} empty log records`, autoDestroyTime: 4000 });
    this.refreshAllPanels();
  }

  _openImporter() {
    document.querySelector('.ht-importer-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'ht-modal-overlay ht-importer-overlay';

    const modal = document.createElement('div');
    modal.className = 'ht-modal';
    modal.style.cssText = 'max-width:720px;width:94vw;max-height:88vh;display:flex;flex-direction:column;';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Close on backdrop click
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    this._importerShowUpload(modal);
  }

  _importerShowUpload(modal) {
    modal.innerHTML = `
      <div class="ht-modal-header">
        <span class="ht-modal-title">📥 Import from TickTick</span>
        <button class="ht-modal-close">✕</button>
      </div>
      <div class="ht-modal-body" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:40px 24px;text-align:center;">
        <div style="font-size:48px;">📊</div>
        <div style="font-size:15px;font-weight:600;color:#e8e0d0;">Upload your TickTick export</div>
        <div style="font-size:12px;color:#8a7e6a;max-width:380px;">
          Export your habits from TickTick (Settings → Export → Excel), then upload the .xlsx file here.
          You'll get to review and map each habit before anything is imported.
        </div>
        <label class="ht-btn ht-btn-primary" style="cursor:pointer;margin-top:8px;">
          Choose .xlsx file
          <input type="file" accept=".xlsx,.xls" style="display:none;" id="ht-import-file-input">
        </label>
        <div id="ht-import-status" style="font-size:12px;color:#8a7e6a;"></div>
      </div>
    `;

    modal.querySelector('.ht-modal-close').addEventListener('click', () => modal.closest('.ht-importer-overlay').remove());

    const input = modal.querySelector('#ht-import-file-input');
    const status = modal.querySelector('#ht-import-status');

    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      status.textContent = 'Parsing…';
      try {
        const habits = await this._parseTickTickXlsx(file);
        status.textContent = `Found ${habits.length} habits. Loading mapping screen…`;
        await htSleep(300);
        this._importerShowMapping(modal, habits);
      } catch(e) {
        status.textContent = '❌ Error parsing file: ' + e.message;
        console.error('[TTImport]', e);
      }
    });
  }

  async _parseTickTickXlsx(file) {
    // Load SheetJS dynamically if not already loaded
    if (!window.XLSX) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      });
    }

    const buf = await file.arrayBuffer();
    const wb = window.XLSX.read(buf, { type: 'array' });
    const habits = [];

    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
      if (!rows.length) continue;

      // First cell contains metadata block
      const meta = String(rows[0]?.[0] || '');
      const get = (field) => { const m = meta.match(new RegExp(field + ':\\s*(.+?)(?:\\n|$)')); return m ? m[1].trim() : ''; };

      const name = get('Habit Name');
      const status = get('Habit Status');
      const goalStr = get('Goal');
      const section = get('Section');
      if (!name) continue;

      // Parse goal
      const gm = goalStr.match(/^(\d+)\s*(.+?)\/day/);
      let target = gm ? parseInt(gm[1]) : 0;
      let unit = gm ? gm[2].trim().toLowerCase() : '';
      if (target === 1 && !unit) target = 0;
      if (unit === 'count') unit = '';

      // Row structure (0-indexed):
      //   rows[0] = metadata block (col A)
      //   rows[1] = date range string  
      //   rows[2] = column headers: Date, Time, Status, Total check-ins, Mood, Habit Log
      //   rows[3]+ = actual data rows
      const completions = [];
      for (let i = 3; i < rows.length; i++) {
        const row = rows[i];
        if (!row || !row[0]) continue;
        const dateRaw = row[0];
        const statusVal = String(row[2] || '');
        const valueRaw = row[3];

        // Only count Completed and Partially Completed (not Uncompleted)
        const isCompleted = statusVal === 'Completed' || statusVal === 'Partially Completed';
        if (!isCompleted) continue;

        // Date is always a string like "2026-03-15" in this export
        let dateStr;
        if (typeof dateRaw === 'number') {
          // Fallback for Excel serial date format
          const epoch = new Date(Math.round((dateRaw - 25569) * 86400 * 1000));
          dateStr = epoch.toISOString().slice(0, 10);
        } else {
          dateStr = String(dateRaw).slice(0, 10);
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

        // Parse numeric value — handle string "1" as well as number 1
        const numVal = typeof valueRaw === 'number' ? valueRaw : parseFloat(valueRaw);
        const val = (!isNaN(numVal) && numVal > 0) ? numVal : 1;
        completions.push([dateStr, val]);
      }

      habits.push({ name, archived: status === 'ARCHIVED', target, unit, section, completions });
    }

    return habits;
  }

  _importerShowMapping(modal, ttHabits) {
    const config = this._config || { categories: [], habits: [] };
    const allThymerHabits = config.habits;

    // Fuzzy match against habits AND categories (strip emojis + punctuation)
    const normalize = s => s.replace(/[\u{1F300}-\u{1FFFF}]/gu, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    const hMap = new Map(allThymerHabits.map(h => [normalize(h.name), h]));
    const cMap = new Map(config.categories.map(c => [normalize(c.name), c]));

    // Build initial mappings
    // action: 'map' (→ habit), 'cat' (→ category log), 'new', 'skip'
    // importArchived: controls whether 'new' habit is marked archived
    const mappings = ttHabits.map(tt => {
      const nn = normalize(tt.name);
      let bestHabit = hMap.get(nn);
      if (!bestHabit) { for (const [k,h] of hMap) { if (k.includes(nn)||nn.includes(k)) { bestHabit=h; break; } } }
      let bestCat = cMap.get(nn);
      if (!bestCat) { for (const [k,c] of cMap) { if (k.includes(nn)||nn.includes(k)) { bestCat=c; break; } } }
      const looksLikeCat = bestCat && !bestHabit;
      return {
        tt,
        action: bestHabit ? 'map' : (looksLikeCat ? 'cat' : (tt.archived ? 'skip' : 'new')),
        thymerHabitId: bestHabit?.id || null,
        thymerCatId: bestCat?.id || null,
        importArchived: tt.archived,
      };
    });

    const badgeColor = a => a==='map'?'#c4b8ff':a==='cat'?'#ffaa44':a==='new'?'#4caf50':'#555';

    modal.innerHTML = `
      <div class="ht-modal-header">
        <span class="ht-modal-title">📥 Map TickTick Habits (${ttHabits.length})</span>
        <button class="ht-modal-close">✕</button>
      </div>
      <div style="padding:8px 16px;background:rgba(124,106,247,0.1);border-bottom:1px solid rgba(255,255,255,0.07);font-size:11px;color:#8a7e6a;display:flex;gap:12px;flex-wrap:wrap;align-items:center;">
        <span>
          <span style="color:#c4b8ff;">🔗 Map to habit</span> ·
          <span style="color:#ffaa44;">🗂 Map to category</span> ·
          <span style="color:#4caf50;">✨ Add new</span> ·
          <span>⏭ Skip</span>
        </span>
        <span style="margin-left:auto;display:flex;gap:6px;">
          <button id="ht-map-all-new" style="background:none;border:1px solid #4caf50;color:#4caf50;border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer;">Unmapped → New</button>
          <button id="ht-map-all-skip" style="background:none;border:1px solid #8a7e6a;color:#8a7e6a;border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer;">Archived → Skip</button>
        </span>
      </div>
      <div id="ht-map-list" style="overflow-y:auto;flex:1;padding:4px 0;"></div>
      <div class="ht-modal-footer" style="display:flex;gap:8px;justify-content:space-between;align-items:center;">
        <span id="ht-map-summary" style="font-size:11px;color:#8a7e6a;"></span>
        <div style="display:flex;gap:8px;">
          <button class="ht-btn ht-btn-secondary" id="ht-map-back">← Back</button>
          <button class="ht-btn ht-btn-primary" id="ht-map-import">Review →</button>
        </div>
      </div>
    `;

    modal.querySelector('.ht-modal-close').addEventListener('click', () => modal.closest('.ht-importer-overlay').remove());
    modal.querySelector('#ht-map-back').addEventListener('click', () => this._importerShowUpload(modal));

    const listEl = modal.querySelector('#ht-map-list');
    const summaryEl = modal.querySelector('#ht-map-summary');

    const updateSummary = () => {
      const counts = {};
      mappings.forEach(m => counts[m.action] = (counts[m.action]||0)+1);
      summaryEl.textContent = [
        counts.map  ? `${counts.map} mapped`       : '',
        counts.cat  ? `${counts.cat} → category`   : '',
        counts.new  ? `${counts.new} new`           : '',
        counts.skip ? `${counts.skip} skipped`      : '',
      ].filter(Boolean).join(' · ');
    };

    const rerender = () => {
      listEl.innerHTML = '';
      const f = document.createDocumentFragment();
      mappings.forEach(m => f.appendChild(renderRow(m)));
      listEl.appendChild(f);
      updateSummary();
    };

    const renderRow = (mapping) => {
      const { tt } = mapping;
      const row = document.createElement('div');
      row.style.cssText = 'display:grid;grid-template-columns:8px 1fr auto auto auto;align-items:center;gap:6px;padding:5px 14px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:12px;';

      const badge = document.createElement('span');
      badge.style.cssText = 'width:6px;height:6px;border-radius:50%;flex-shrink:0;';
      badge.style.background = badgeColor(mapping.action);

      const nameWrap = document.createElement('div');
      nameWrap.style.cssText = 'min-width:0;';
      const nameEl = document.createElement('div');
      nameEl.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:'+(tt.archived?'#8a7e6a':'#e8e0d0');
      nameEl.textContent = tt.name; nameEl.title = tt.name;
      const metaEl = document.createElement('div');
      metaEl.style.cssText = 'font-size:10px;color:#8a7e6a;';
      metaEl.textContent = `${tt.completions.length} logs`
        +(tt.archived?' · archived in TT':'')
        +(tt.target?` · target ${tt.target}${tt.unit?' '+tt.unit:''}`:'');
      nameWrap.appendChild(nameEl); nameWrap.appendChild(metaEl);

      const actionSel = document.createElement('select');
      actionSel.style.cssText = 'background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);color:#e8e0d0;border-radius:4px;padding:2px 4px;font-size:11px;cursor:pointer;';
      [['map','🔗 Map to habit…'],['cat','🗂 Map to category…'],['new','✨ Add as new habit'],['skip','⏭ Skip']].forEach(([val,label]) => {
        const o = document.createElement('option');
        o.value=val; o.textContent=label; o.selected=(val===mapping.action);
        actionSel.appendChild(o);
      });

      const picker = document.createElement('select');
      picker.style.cssText = 'max-width:160px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);color:#e8e0d0;border-radius:4px;padding:2px 4px;font-size:11px;cursor:pointer;';

      const archToggle = document.createElement('label');
      archToggle.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:10px;color:#8a7e6a;cursor:pointer;white-space:nowrap;flex-shrink:0;';
      const archCb = document.createElement('input');
      archCb.type='checkbox'; archCb.style.cssText='accent-color:#7c6af7;cursor:pointer;';
      archCb.checked = mapping.importArchived;
      archCb.addEventListener('change', () => { mapping.importArchived = archCb.checked; });
      archToggle.appendChild(archCb);
      archToggle.appendChild(document.createTextNode('archived'));

      const buildPicker = () => {
        picker.innerHTML = '';
        if (mapping.action === 'map') {
          const blank = document.createElement('option');
          blank.value=''; blank.textContent='— choose habit —'; picker.appendChild(blank);
          const catOrder = new Map(config.categories.map((c,i) => [c.id,i]));
          const sorted = [...allThymerHabits].sort((a,b)=>(catOrder.get(a.categoryId)||99)-(catOrder.get(b.categoryId)||99));
          let lastCat = null;
          for (const h of sorted) {
            if (h.categoryId !== lastCat) {
              const cat = config.categories.find(c=>c.id===h.categoryId);
              const og = document.createElement('optgroup');
              og.label = cat ? `${cat.emoji||''} ${cat.name}` : 'Uncategorized';
              picker.appendChild(og); lastCat = h.categoryId;
            }
            const o = document.createElement('option');
            o.value=h.id; o.textContent=h.name; o.selected=(h.id===mapping.thymerHabitId);
            picker.lastChild.appendChild(o);
          }
          picker.style.display=''; archToggle.style.display='none';
        } else if (mapping.action === 'cat') {
          const blank = document.createElement('option');
          blank.value=''; blank.textContent='— choose category —'; picker.appendChild(blank);
          for (const c of config.categories) {
            const o = document.createElement('option');
            o.value=c.id; o.textContent=`${c.emoji||''} ${c.name}`; o.selected=(c.id===mapping.thymerCatId);
            picker.appendChild(o);
          }
          picker.style.display=''; archToggle.style.display='none';
        } else if (mapping.action === 'new') {
          picker.style.display='none'; archToggle.style.display='';
        } else {
          picker.style.display='none'; archToggle.style.display='none';
        }
      };
      buildPicker();

      actionSel.addEventListener('change', () => {
        mapping.action = actionSel.value;
        badge.style.background = badgeColor(mapping.action);
        buildPicker(); updateSummary();
      });
      picker.addEventListener('change', () => {
        if (mapping.action==='map') mapping.thymerHabitId = picker.value||null;
        else if (mapping.action==='cat') mapping.thymerCatId = picker.value||null;
      });

      row.appendChild(badge); row.appendChild(nameWrap);
      row.appendChild(actionSel); row.appendChild(picker); row.appendChild(archToggle);
      return row;
    };

    rerender();

    modal.querySelector('#ht-map-all-new').addEventListener('click', () => {
      mappings.forEach(m => { if (m.action==='skip'&&!m.tt.archived) m.action='new'; });
      rerender();
    });
    modal.querySelector('#ht-map-all-skip').addEventListener('click', () => {
      mappings.forEach(m => { if (m.tt.archived) m.action='skip'; });
      rerender();
    });
    modal.querySelector('#ht-map-import').addEventListener('click', () => {
      this._importerShowConfirm(modal, mappings);
    });
  }

  _importerShowConfirm(modal, mappings) {
    const toMap = mappings.filter(m => m.action === 'map');
    const toCat = mappings.filter(m => m.action === 'cat');
    const toNew = mappings.filter(m => m.action === 'new');
    const toSkip = mappings.filter(m => m.action === 'skip');
    const totalLogs = mappings.filter(m => m.action !== 'skip').reduce((s, m) => s + m.tt.completions.length, 0);
    const unmapped = toMap.filter(m => !m.thymerHabitId);

    modal.innerHTML = `
      <div class="ht-modal-header">
        <span class="ht-modal-title">📥 Confirm Import</span>
        <button class="ht-modal-close">✕</button>
      </div>
      <div class="ht-modal-body" style="padding:24px;display:flex;flex-direction:column;gap:12px;">
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">
          <div style="background:rgba(196,184,255,0.1);border-radius:8px;padding:12px;text-align:center;">
            <div style="font-size:24px;font-weight:700;color:#c4b8ff;">${toMap.length}</div>
            <div style="font-size:11px;color:#8a7e6a;margin-top:2px;">habits merged</div>
          </div>
          <div style="background:rgba(255,170,68,0.1);border-radius:8px;padding:12px;text-align:center;">
            <div style="font-size:24px;font-weight:700;color:#ffaa44;">${toCat.length}</div>
            <div style="font-size:11px;color:#8a7e6a;margin-top:2px;">→ category</div>
          </div>
          <div style="background:rgba(76,175,80,0.1);border-radius:8px;padding:12px;text-align:center;">
            <div style="font-size:24px;font-weight:700;color:#4caf50;">${toNew.length}</div>
            <div style="font-size:11px;color:#8a7e6a;margin-top:2px;">habits added</div>
          </div>
          <div style="background:rgba(255,255,255,0.05);border-radius:8px;padding:12px;text-align:center;">
            <div style="font-size:24px;font-weight:700;color:#8a7e6a;">${toSkip.length}</div>
            <div style="font-size:11px;color:#8a7e6a;margin-top:2px;">skipped</div>
          </div>
        </div>
        <div style="font-size:12px;color:#8a7e6a;text-align:center;">
          ~${totalLogs.toLocaleString()} completion logs to write · existing Thymer logs won't be overwritten
        </div>
        ${unmapped.length ? `<div style="font-size:11px;color:#ffaa44;padding:8px 12px;background:rgba(255,170,68,0.1);border-radius:6px;">
          ⚠️ ${unmapped.length} "Map to habit" with no target selected — will be added as new instead.
        </div>` : ''}
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#e8e0d0;cursor:pointer;padding:8px 12px;background:rgba(255,255,255,0.05);border-radius:6px;">
          <input type="checkbox" id="ht-overwrite-cb" style="accent-color:#7c6af7;cursor:pointer;">
          <span><strong>Overwrite existing completions</strong> — use this if you've imported before and data is missing</span>
        </label>
        <div id="ht-import-progress" style="display:none;flex-direction:column;gap:8px;">
          <div style="height:4px;background:rgba(255,255,255,0.1);border-radius:2px;overflow:hidden;">
            <div id="ht-import-progress-bar" style="height:100%;background:#4caf50;width:0%;transition:width 0.3s;"></div>
          </div>
          <div id="ht-import-progress-label" style="font-size:11px;color:#8a7e6a;text-align:center;"></div>
        </div>
      </div>
      <div class="ht-modal-footer" style="justify-content:space-between;">
        <button class="ht-btn ht-btn-secondary" id="ht-confirm-back">← Back</button>
        <button class="ht-btn ht-btn-primary" id="ht-confirm-go">Run Import</button>
      </div>
    `;

    modal.querySelector('.ht-modal-close').addEventListener('click', () => modal.closest('.ht-importer-overlay').remove());
    modal.querySelector('#ht-confirm-back').addEventListener('click', () => this._importerShowMapping(modal, mappings.map(m => m.tt)));

    modal.querySelector('#ht-confirm-go').addEventListener('click', async () => {
      modal.querySelector('#ht-confirm-go').disabled = true;
      modal.querySelector('#ht-confirm-back').disabled = true;
      modal.querySelector('#ht-import-progress').style.display = 'flex';
      const overwrite = modal.querySelector('#ht-overwrite-cb')?.checked || false;
      await this._importerRun(modal, mappings, overwrite);
    });
  }

  async _importerRun(modal, mappings, overwrite = false) {
    const bar = modal.querySelector('#ht-import-progress-bar');
    const label = modal.querySelector('#ht-import-progress-label');
    const setProgress = (pct, msg) => { bar.style.width = pct + '%'; label.textContent = msg; };

    const config = JSON.parse(JSON.stringify(this._config));
    const records = await this._collection.getAllRecords();
    // Merge ALL log records per date (there may be duplicates from failed imports)
    // Keep the first record object (to write into), merge data from all of them
    const logs = new Map(); // date → { record: firstRecord, data: mergedData, extras: [otherRecords] }
    let configRecord = null;

    for (const r of records) {
      const name = r.getName?.() || '';
      if (name === '__config__') { configRecord = r; continue; }
      if (name.startsWith('log-')) {
        try {
          const raw = this._readDataProp(r);
          if (!raw) continue;
          const d = JSON.parse(raw);
          if (!d.date) continue;
          if (logs.has(d.date)) {
            // Merge this duplicate's completions into the existing entry
            const existing = logs.get(d.date);
            Object.assign(existing.data.completions, d.completions || {});
            Object.assign(existing.data.categoryDone, d.categoryDone || {});
            existing.extras = existing.extras || [];
            existing.extras.push(r); // track duplicates to blank out later
          } else {
            logs.set(d.date, { record: r, data: { date: d.date, completions: d.completions || {}, categoryDone: d.categoryDone || {} } });
          }
        } catch(e) {}
      }
    }

    setProgress(5, 'Updating habit config…');

    // Build id maps: tt.name → { type:'habit'|'cat', id }
    const idMap = new Map(); // name → { type, id, target }
    let configChanged = false;
    let catOrder = Math.max(0, ...config.categories.map(c => c.order || 0));
    let habitOrder = Math.max(0, ...config.habits.map(h => h.order || 0));

    for (const m of mappings) {
      if (m.action === 'skip') continue;

      if (m.action === 'map' && m.thymerHabitId) {
        // Map to existing habit — update seedDate if missing
        idMap.set(m.tt.name, { type: 'habit', id: m.thymerHabitId, target: m.tt.target });
        const ex = config.habits.find(h => h.id === m.thymerHabitId);
        if (ex && !ex.seedDate && m.tt.completions.length > 0) {
          ex.seedDate = m.tt.completions.map(c => c[0]).sort()[0];
          configChanged = true;
        }
      } else if (m.action === 'cat' && m.thymerCatId) {
        // Map to category — logs will set categoryDone directly
        idMap.set(m.tt.name, { type: 'cat', id: m.thymerCatId, target: 0 });
      } else if (m.action === 'new' || (m.action === 'map' && !m.thymerHabitId)) {
        // Create new habit
        const catId = this._importerEnsureCategory(config, m.tt.section, catOrder);
        const existing = config.categories.find(c => c.id === catId);
        if (existing) catOrder = Math.max(catOrder, existing.order || 0);
        const newId = 'tt_' + Math.random().toString(36).slice(2, 10);
        const seedDate = m.tt.completions.length > 0 ? m.tt.completions.map(c => c[0]).sort()[0] : null;
        config.habits.push({
          id: newId, name: m.tt.name, categoryId: catId,
          order: ++habitOrder, target: m.tt.target || 0,
          unit: m.tt.unit || '',
          archived: m.importArchived !== undefined ? m.importArchived : m.tt.archived,
          seedDate,
        });
        idMap.set(m.tt.name, { type: 'habit', id: newId, target: m.tt.target });
        configChanged = true;
      }
    }

    if (configChanged) {
      configRecord.prop('data').set(JSON.stringify(config));
      this._config = config;
      await htSleep(250);
    }

    setProgress(15, 'Building log map…');

    // Group all completions by date
    const dateMap = new Map();
    for (const m of mappings) {
      if (m.action === 'skip') continue;
      const entry = idMap.get(m.tt.name);
      if (!entry) continue;
      for (const [date, value] of m.tt.completions) {
        if (!dateMap.has(date)) dateMap.set(date, []);
        dateMap.get(date).push({ ...entry, value });
      }
    }

    const dates = [...dateMap.keys()].sort();
    let written = 0;

    console.log('[HT Import] dateMap size:', dateMap.size, 'dates:', dates.length);
    console.log('[HT Import] idMap size:', idMap.size, 'entries:', [...idMap.entries()].slice(0,3).map(([k,v]) => k.slice(0,20) + '→' + v.id));
    if (dates.length === 0) {
      alert('Import error: no dates found in parsed data. Check console for details.\n\nidMap size: ' + idMap.size + '\nmappings with action≠skip: ' + mappings.filter(m=>m.action!=='skip').length);
      setProgress(100, 'No data to import');
      return;
    }

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];

      // Load the current log using the proven _saveLog/_loadLog pattern
      const ld = await this._loadLog(date);
      let changed = false;

      for (const entry of dateMap.get(date)) {
        if (entry.type === 'cat') {
          if (overwrite || !ld.categoryDone[entry.id]) {
            ld.categoryDone[entry.id] = true;
            changed = true;
          }
        } else {
          const { id: hId, value, target } = entry;
          if (overwrite || ld.completions[hId] === undefined) {
            ld.completions[hId] = (target || 0) > 0 ? value : true;
            changed = true;
          }
        }
      }

      if (changed) {
        // Recompute categoryDone from habits
        for (const cat of config.categories) {
          if (ld.categoryDone[cat.id]) continue;
          const inCat = config.habits.filter(h => h.categoryId === cat.id && !h.archived);
          const any = inCat.some(h => {
            const v = ld.completions[h.id];
            if (!v) return false;
            return (h.target||0) > 0 ? (typeof v==='number' && v >= h.target) : true;
          });
          if (any) ld.categoryDone[cat.id] = true;
        }

        // Use the proven _saveLog method which uses guid-based lookup
        await this._saveLog(date, ld);
        written++;
      }

      if (i % 20 === 0) {
        const pct = 15 + Math.round((i / dates.length) * 82);
        setProgress(pct, `Writing logs… ${i}/${dates.length} dates`);
        await htSleep(30);
      }
    }

    setProgress(100, 'Done!');
    await htSleep(500);

    // Show completion screen
    modal.innerHTML = `
      <div class="ht-modal-header">
        <span class="ht-modal-title">🎉 Import Complete</span>
        <button class="ht-modal-close">✕</button>
      </div>
      <div class="ht-modal-body" style="padding:40px 24px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:16px;">
        <div style="font-size:48px;">✅</div>
        <div style="font-size:15px;font-weight:600;color:#e8e0d0;">${written.toLocaleString()} log records written</div>
        <div style="font-size:12px;color:#8a7e6a;">Your habit history has been imported.<br>Refresh the page if the sidebar doesn't update.</div>
      </div>
      <div class="ht-modal-footer" style="justify-content:center;">
        <button class="ht-btn ht-btn-primary" id="ht-import-done">Done</button>
      </div>
    `;
    modal.querySelector('.ht-modal-close').addEventListener('click', () => modal.closest('.ht-importer-overlay').remove());
    modal.querySelector('#ht-import-done').addEventListener('click', () => {
      modal.closest('.ht-importer-overlay').remove();
      this.refreshAllPanels();
    });
  }

  _importerEnsureCategory(config, section, baseOrder) {
    // Map TickTick section strings to category ids/names
    const SECTION_MAP = {
      '♾️ 📖 expansion':       {id:'cat_expansion',   name:'Expansion',        emoji:'📖'},
      '♾️ 🙏devotion':          {id:'cat_devotion',    name:'Devotion',         emoji:'🙏'},
      '🎭 ✊directaction':     {id:'cat_directaction',name:'Direct Action',    emoji:'✊'},
      '🎭🕺artistry':           {id:'cat_artistry',    name:'Artistry',         emoji:'🕺'},
      '🎭🤝healing':            {id:'cat_healing',     name:'Healing',          emoji:'🤝'},
      '🏡 💸sacred economics': {id:'cat_economics',   name:'Sacred Economics', emoji:'💸'},
      '🏡 🫂community':        {id:'cat_community',   name:'Community',        emoji:'🫂'},
      '🏡🧹hygiene':            {id:'cat_hygiene',     name:'Hygiene',          emoji:'🧹'},
      '🧘‍♂️ 💝recovery':       {id:'cat_recovery',   name:'Recovery',         emoji:'💝'},
      '🧘‍♂️ 💧rejuvenation':   {id:'cat_rejuv',       name:'Rejuvenation',     emoji:'💧'},
      '🧘‍♂️ 🤸 cultivation':   {id:'cat_cultiv',      name:'Cultivation',      emoji:'🤸'},
      '🧘‍♂️ 🥕consumption':    {id:'cat_consump',     name:'Consumption',      emoji:'🥕'},
    };

    const def = SECTION_MAP[section];
    if (!def) {
      // Unknown section → use/create 'Others'
      if (!config.categories.find(c => c.id === 'cat_others')) {
        config.categories.push({ id:'cat_others', name:'Others (TickTick)', emoji:'📦', order: baseOrder + 99 });
      }
      return 'cat_others';
    }

    if (!config.categories.find(c => c.id === def.id)) {
      config.categories.push({ id: def.id, name: def.name, emoji: def.emoji, order: ++baseOrder });
    }
    return def.id;
  }


}
