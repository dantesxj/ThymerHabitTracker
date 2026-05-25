// @generated BEGIN thymer-plugin-settings (source: plugins/public repo/plugin-settings/ThymerPluginSettingsRuntime.js — run: npm run embed-plugin-settings)
/**
 * ThymerPluginSettings — workspace **Plugin Backend** collection + optional localStorage mirror
 * for global plugins that do not own a collection. (Legacy name **Plugin Settings** is still found until renamed.)
 *
 * Edit this file, then from repo root: npm run embed-plugin-settings
 *
 * Debug: console filter `[ThymerExt/PluginBackend]`. Off by default; to enable:
 *   localStorage.setItem('thymerext_debug_collections', '1'); location.reload();
 *
 * Create dedupe: Web Locks + **per-workspace** localStorage lease/recent-create keys (workspaceGuid from
 * `data.getActiveUsers()[0]`), plus abort if an exact-named Plugin Backend collection already exists.
 *
 * Rows:
 * - **Vault** (`record_kind` = `vault`): one per `plugin_id` — holds synced localStorage payload JSON.
 * - **Other rows** (`record_kind` = `log`, `config`, …): same **Plugin** field (`plugin`) for filtering;
 *   use a **distinct** `plugin_id` per row (e.g. `habit-tracker:log:2026-04-24`) so vault lookup stays unambiguous.
 *
 * API: ThymerPluginSettings.init({ plugin, pluginId, modeKey, mirrorKeys, label, data, ui })
 *      ThymerPluginSettings.scheduleFlush(plugin, mirrorKeys)
 *      ThymerPluginSettings.flushNow(data, pluginId, mirrorKeys)
 *      ThymerPluginSettings.openStorageDialog({ plugin, pluginId, modeKey, mirrorKeys, label, data, ui })
 *      ThymerPluginSettings.listRows(data, { pluginSlug, recordKind? })
 *      ThymerPluginSettings.createDataRow(data, { pluginSlug, recordKind, rowPluginId, recordTitle?, settingsDoc? })
 *      ThymerPluginSettings.upgradeCollectionSchema(data) — merge missing `plugin` / `record_kind` fields into existing collection
 *      ThymerPluginSettings.registerPluginSlug(data, { slug, label? }) — ensure `plugin` choice includes this slug (call once per plugin)
 */
(function pluginSettingsRuntime(g) {
  if (g.ThymerPluginSettings) return;

  const COL_NAME = 'Plugin Backend';
  const COL_NAME_LEGACY = 'Plugin Settings';
  const KIND_VAULT = 'vault';
  const FIELD_PLUGIN = 'plugin';
  const FIELD_KIND = 'record_kind';
  const q = [];
  let busy = false;

  /**
   * Collection ensure diagnostics (read browser console for `[ThymerExt/PluginBackend]`.
   * Opt-in: `localStorage.setItem('thymerext_debug_collections','1')` then reload.
   * Opt-out: remove the key or set to `0` / `off` / `false`.
   */
  const DEBUG_COLLECTIONS = (() => {
    try {
      const o = localStorage.getItem('thymerext_debug_collections');
      if (o === '0' || o === 'off' || o === 'false') return false;
      return o === '1' || o === 'true' || o === 'on';
    } catch (_) {}
    return false;
  })();
  const DEBUG_PATHB_ID =
    'pb-' + (Date.now() & 0xffffffff).toString(16) + '-' + Math.random().toString(36).slice(2, 7);

  /** If true, Thymer ignores programmatic field updates — force off on every schema save. */
  const MANAGED_UNLOCK = { fields: false, views: false, sidebar: false };

  /**
   * Ensure Plugin Backend collection without duplicate `createCollection` calls.
   * Sibling **plugin iframes** are often not `window` siblings — walking `parent` can stop at
   * each plugin’s *own* frame, so a promise on “hierarchy best” is **not** one shared object.
   * **`window.top` is the same** for all same-tab iframes and, when not cross-origin, is the
   * one place to attach a cross-iframe lock. Fallback: walk the parent chain for opaque frames.
   */
  function getSharedDeduplicationWindow() {
    try {
      if (typeof window === 'undefined') return g;
      const t = window.top;
      if (t) {
        void t.document;
        return t;
      }
    } catch (_) {
      /* cross-origin top */
    }
    try {
      let w = typeof window !== 'undefined' ? window : null;
      let best = w || g;
      while (w) {
        try {
          void w.document;
          best = w;
        } catch (_) {
          break;
        }
        if (w === w.top) break;
        w = w.parent;
      }
      return best;
    } catch (_) {
      return typeof window !== 'undefined' ? window : g;
    }
  }

  const PB_ENSURE_GLOBAL_P = '__thymerPluginBackendEnsureGlobalP';
  const SERIAL_DATA_CREATE_P = '__thymerExtSerializedDataCreateP_v1';
  /** `getAllCollections` can briefly return [] (host UI / race) after a valid non-empty read — refuse create in that window. */
  const GETALL_COLLECTIONS_SANITY = '__thymerExtGetAllCollectionsSanityV1';
  function touchGetAllSanityFromCount(len) {
    const n = Number(len) || 0;
    const h = getSharedDeduplicationWindow();
    if (!h[GETALL_COLLECTIONS_SANITY]) h[GETALL_COLLECTIONS_SANITY] = { nLast: 0, tLast: 0 };
    const s = h[GETALL_COLLECTIONS_SANITY];
    if (n > 0) {
      s.nLast = n;
      s.tLast = Date.now();
    }
  }
  function isSuspiciousEmptyAfterRecentNonEmptyList(currentLen) {
    const c = Number(currentLen) || 0;
    if (c > 0) {
      touchGetAllSanityFromCount(c);
      return false;
    }
    const h = getSharedDeduplicationWindow();
    const s = h[GETALL_COLLECTIONS_SANITY];
    if (!s || s.nLast <= 0 || !s.tLast) return false;
    return Date.now() - s.tLast < 60_000;
  }

  function chainPluginBackendEnsure(data, work) {
    const root = getSharedDeduplicationWindow();
    try {
      if (!root[PB_ENSURE_GLOBAL_P]) root[PB_ENSURE_GLOBAL_P] = Promise.resolve();
    } catch (_) {
      return Promise.resolve().then(work);
    }
    root[PB_ENSURE_GLOBAL_P] = root[PB_ENSURE_GLOBAL_P].catch(() => {}).then(work);
    return root[PB_ENSURE_GLOBAL_P];
  }

  function withUnlockedManaged(base) {
    return { ...(base && typeof base === 'object' ? base : {}), managed: MANAGED_UNLOCK };
  }

  /** Index of the “Plugin” column (`id` **plugin**, or legacy label match). */
  function findPluginColumnFieldIndex(fields) {
    const arr = Array.isArray(fields) ? fields : [];
    let i = arr.findIndex((f) => f && f.id === FIELD_PLUGIN);
    if (i >= 0) return i;
    i = arr.findIndex(
      (f) =>
        f &&
        String(f.label || '')
          .trim()
          .toLowerCase() === 'plugin' &&
        (f.type === 'text' || f.type === 'plaintext' || f.type === 'string')
    );
    return i;
  }

  /** Keep internal column identity when replacing field shape (text → choice). */
  function copyStableFieldKeys(prev, next) {
    if (!prev || !next || typeof prev !== 'object' || typeof next !== 'object') return;
    for (const k of ['guid', 'colguid', 'colGuid', 'field_guid']) {
      if (prev[k] != null && next[k] == null) next[k] = prev[k];
    }
  }

  function getPluginFieldDef(coll) {
    if (!coll || typeof coll.getConfiguration !== 'function') return null;
    try {
      const fields = coll.getConfiguration()?.fields || [];
      const i = findPluginColumnFieldIndex(fields);
      return i >= 0 ? fields[i] : null;
    } catch (_) {
      return null;
    }
  }

  function pluginColumnPropId(coll, requestedId) {
    if (requestedId !== FIELD_PLUGIN || !coll) return requestedId;
    const f = getPluginFieldDef(coll);
    return (f && f.id) || FIELD_PLUGIN;
  }

  function cloneFieldDef(f) {
    if (!f || typeof f !== 'object') return f;
    try {
      return structuredClone(f);
    } catch (_) {
      try {
        return JSON.parse(JSON.stringify(f));
      } catch (__) {
        return { ...f };
      }
    }
  }

  const PLUGIN_SETTINGS_SHAPE = {
    ver: 1,
    name: COL_NAME,
    icon: 'ti-adjustments',
    color: null,
    home: false,
    page_field_ids: [FIELD_PLUGIN, FIELD_KIND, 'plugin_id', 'created_at', 'updated_at', 'settings_json'],
    item_name: 'Setting, Config, or Log',
    description: 'Workspace storage for plugins: Use the Plugin column to filter by plugin.',
    show_sidebar_items: true,
    show_cmdpal_items: false,
    fields: [
      {
        icon: 'ti-apps',
        id: FIELD_PLUGIN,
        label: 'Plugin',
        type: 'choice',
        read_only: false,
        active: true,
        many: false,
        choices: [
          { id: 'quick-notes', label: 'quick-notes', color: '0', active: true },
          { id: 'habit-tracker', label: 'Habit Tracker', color: '0', active: true },
          { id: 'ynab', label: 'ynab', color: '0', active: true },
        ],
      },
      {
        icon: 'ti-category',
        id: FIELD_KIND,
        label: 'Record kind',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
      {
        icon: 'ti-id',
        id: 'plugin_id',
        label: 'Plugin ID',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
      {
        icon: 'ti-clock-plus',
        id: 'created_at',
        label: 'Created',
        many: false,
        read_only: true,
        active: true,
        type: 'datetime',
      },
      {
        icon: 'ti-clock-edit',
        id: 'updated_at',
        label: 'Modified',
        many: false,
        read_only: true,
        active: true,
        type: 'datetime',
      },
      {
        icon: 'ti-code',
        id: 'settings_json',
        label: 'Settings JSON',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
      {
        icon: 'ti-abc',
        id: 'title',
        label: 'Title',
        many: false,
        read_only: false,
        active: true,
        type: 'text',
      },
      {
        icon: 'ti-photo',
        id: 'banner',
        label: 'Banner',
        many: false,
        read_only: false,
        active: true,
        type: 'banner',
      },
      {
        icon: 'ti-align-left',
        id: 'icon',
        label: 'Icon',
        many: false,
        read_only: false,
        active: true,
        type: 'text',
      },
    ],
    sidebar_record_sort_dir: 'desc',
    sidebar_record_sort_field_id: 'updated_at',
    managed: { fields: false, views: false, sidebar: false },
    custom: {},
    views: [
      {
        id: 'V0YBPGDDZ0MHRSQ',
        shown: true,
        icon: 'ti-table',
        label: 'All',
        description: '',
        field_ids: ['title', FIELD_PLUGIN, FIELD_KIND, 'plugin_id', 'created_at', 'updated_at'],
        type: 'table',
        read_only: false,
        group_by_field_id: null,
        sort_dir: 'desc',
        sort_field_id: 'updated_at',
        opts: {},
      },
      {
        id: 'VPGAWVGVKZD57C9',
        shown: true,
        icon: 'ti-layout-kanban',
        label: 'By Plugin...',
        description: '',
        field_ids: ['title', FIELD_KIND, 'created_at', 'updated_at'],
        type: 'board',
        read_only: false,
        group_by_field_id: FIELD_PLUGIN,
        sort_dir: 'desc',
        sort_field_id: 'updated_at',
        opts: {},
      },
    ],
  };

  function cloneShape() {
    try {
      return structuredClone(PLUGIN_SETTINGS_SHAPE);
    } catch (_) {
      return JSON.parse(JSON.stringify(PLUGIN_SETTINGS_SHAPE));
    }
  }

  /** Append default views from the canonical shape when the workspace collection is missing them (by view `id`). */
  function mergeViewsArray(baseViews, desiredViews) {
    const desired = Array.isArray(desiredViews) ? desiredViews.map((v) => cloneFieldDef(v)) : [];
    const cur = Array.isArray(baseViews) ? baseViews.map((v) => cloneFieldDef(v)) : [];
    if (cur.length === 0) {
      return { views: desired, changed: desired.length > 0 };
    }
    const ids = new Set(cur.map((v) => v && v.id).filter(Boolean));
    let changed = false;
    for (const v of desired) {
      if (v && v.id && !ids.has(v.id)) {
        cur.push(cloneFieldDef(v));
        ids.add(v.id);
        changed = true;
      }
    }
    return { views: cur, changed };
  }

  /** Slug before first colon, else whole id (e.g. `habit-tracker:log:2026-04-24` → `habit-tracker`). */
  function inferPluginSlugFromPid(pid) {
    if (!pid) return '';
    const s = String(pid).trim();
    const i = s.indexOf(':');
    if (i <= 0) return s;
    return s.slice(0, i);
  }

  function inferRecordKindFromPid(pid, slug) {
    if (!pid || !slug) return '';
    const p = String(pid);
    if (p === slug) return KIND_VAULT;
    if (p === `${slug}:config`) return 'config';
    if (p.startsWith(`${slug}:log:`)) return 'log';
    return '';
  }

  function colorForSlug(slug) {
    const colors = ['0', '1', '2', '3', '4', '5', '6', '7'];
    let h = 0;
    const s = String(slug || '');
    for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i) * (i + 1)) % colors.length;
    return colors[h];
  }

  /** Normalize Thymer choice option (object or legacy string). */
  function normalizeChoiceOption(c) {
    if (c == null) return null;
    if (typeof c === 'string') {
      const s = c.trim();
      if (!s) return null;
      return { id: s, label: s, color: colorForSlug(s), active: true };
    }
    const id = String(c.id ?? c.label ?? '')
      .trim();
    if (!id) return null;
    return {
      id,
      label: String(c.label ?? id).trim() || id,
      color: String(c.color != null ? c.color : colorForSlug(id)),
      active: c.active !== false,
    };
  }

  /**
   * Fresh choice field object (no legacy keys). Thymer often ignores `type` changes when merging
   * onto an existing text field’s full config — same pattern as markdown importer choice fields.
   */
  function cleanPluginChoiceField(prev, desiredPlugin, choicesList) {
    const fieldId = (prev && prev.id) || FIELD_PLUGIN;
    const next = {
      id: fieldId,
      label: (prev && prev.label) || desiredPlugin.label || 'Plugin',
      icon: (prev && prev.icon) || desiredPlugin.icon || 'ti-apps',
      type: 'choice',
      many: false,
      read_only: false,
      active: prev ? prev.active !== false : true,
      choices: Array.isArray(choicesList) ? choicesList : [],
    };
    copyStableFieldKeys(prev, next);
    return next;
  }

  /**
   * Ensure the `plugin` field is a choice field and its options cover every slug
   * already present on rows (migrates legacy `type: 'text'` definitions).
   */
  async function reconcilePluginFieldAsChoice(coll, curFields, desired) {
    const desiredPlugin = desired.fields.find((f) => f && f.id === FIELD_PLUGIN);
    if (!desiredPlugin) return { fields: curFields, changed: false };

    const idx = findPluginColumnFieldIndex(curFields);
    const prev = idx >= 0 ? curFields[idx] : null;

    const choices = [];
    const seen = new Set();
    const pushOpt = (opt) => {
      const n = normalizeChoiceOption(opt);
      if (!n || seen.has(n.id)) return;
      seen.add(n.id);
      choices.push(n);
    };

    if (prev && prev.type === 'choice' && Array.isArray(prev.choices)) {
      for (const c of prev.choices) pushOpt(c);
    }

    let records = [];
    try {
      records = await coll.getAllRecords();
    } catch (_) {}

    const plugCol = pluginColumnPropId(coll, FIELD_PLUGIN);
    const slugSet = new Set();
    for (const r of records) {
      const a = rowField(r, plugCol);
      if (a) slugSet.add(a.trim());
      const inf = inferPluginSlugFromPid(rowField(r, 'plugin_id'));
      if (inf) slugSet.add(inf);
    }
    for (const slug of [...slugSet].sort()) {
      if (!slug) continue;
      pushOpt({ id: slug, label: slug, color: colorForSlug(slug), active: true });
    }

    const useClean = !prev || prev.type !== 'choice';
    const nextPluginField = useClean
      ? cleanPluginChoiceField(prev, desiredPlugin, choices)
      : (() => {
          const merged = {
            ...desiredPlugin,
            type: 'choice',
            choices,
            icon: (prev && prev.icon) || desiredPlugin.icon,
            label: (prev && prev.label) || desiredPlugin.label,
            id: (prev && prev.id) || desiredPlugin.id || FIELD_PLUGIN,
          };
          copyStableFieldKeys(prev, merged);
          return merged;
        })();

    let changed = false;
    if (idx < 0) {
      curFields.push(nextPluginField);
      changed = true;
    } else if (JSON.stringify(prev) !== JSON.stringify(nextPluginField)) {
      curFields[idx] = nextPluginField;
      changed = true;
    }

    return { fields: curFields, changed };
  }

  async function registerPluginSlug(data, { slug, label } = {}) {
    const id = (slug || '').trim();
    if (!id || !data) return;
    await ensurePluginSettingsCollection(data);
    const coll = await findColl(data);
    if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') return;
    await upgradePluginSettingsSchema(data, coll);
    let slugRegisterSavedOk = false;
    try {
      const base = coll.getConfiguration() || {};
      const fields = Array.isArray(base.fields) ? [...base.fields] : [];
      const idx = findPluginColumnFieldIndex(fields);
      if (idx < 0) {
        await rewritePluginChoiceCells(coll);
        return;
      }
      const prev = fields[idx];
      if (prev.type !== 'choice') {
        await rewritePluginChoiceCells(coll);
        return;
      }
      const prevChoices = Array.isArray(prev.choices) ? prev.choices : [];
      const normalized = prevChoices.map((c) => normalizeChoiceOption(c)).filter(Boolean);
      const byId = new Map(normalized.map((c) => [c.id, c]));
      const existing = byId.get(id);
      if (existing) {
        if (label && String(existing.label) !== String(label)) {
          byId.set(id, { ...existing, label: String(label) });
        } else {
          await rewritePluginChoiceCells(coll);
          return;
        }
      } else {
        byId.set(id, { id, label: label || id, color: colorForSlug(id), active: true });
      }
      const prevOrder = normalized.map((c) => c.id);
      const out = [];
      const used = new Set();
      for (const pid of prevOrder) {
        if (byId.has(pid) && !used.has(pid)) {
          out.push(byId.get(pid));
          used.add(pid);
        }
      }
      for (const [pid, opt] of byId) {
        if (!used.has(pid)) {
          out.push(opt);
          used.add(pid);
        }
      }
      const next = { ...prev, type: 'choice', choices: out };
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        fields[idx] = next;
        const ok = await coll.saveConfiguration(withUnlockedManaged({ ...base, fields }));
        if (ok === false) console.warn('[ThymerPluginSettings] registerPluginSlug: saveConfiguration returned false');
        else slugRegisterSavedOk = true;
      }
    } catch (e) {
      console.error('[ThymerPluginSettings] registerPluginSlug', e);
    }
    if (slugRegisterSavedOk) await rewritePluginChoiceCells(coll);
  }

  /**
   * Merge missing field definitions into the Plugin Backend collection
   * (e.g. after Thymer auto-created a minimal schema, or older two-field configs).
   */
  async function upgradePluginSettingsSchema(data, collOpt) {
    await ensurePluginSettingsCollection(data);
    const coll = collOpt || (await findColl(data));
    if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') return;
    try {
      let base = coll.getConfiguration() || {};
      try {
        if (typeof coll.getExistingCodeAndConfig === 'function') {
          const pack = coll.getExistingCodeAndConfig();
          if (pack && pack.json && typeof pack.json === 'object') {
            base = { ...base, ...pack.json };
          }
        }
      } catch (_) {}
      const desired = cloneShape();
      const curFields = Array.isArray(base.fields) ? base.fields.map((f) => cloneFieldDef(f)) : [];
      const curIds = new Set(curFields.map((f) => (f && f.id ? f.id : null)).filter(Boolean));
      let changed = false;
      for (const f of desired.fields) {
        if (!f || !f.id || curIds.has(f.id)) continue;
        if (f.id === FIELD_PLUGIN && findPluginColumnFieldIndex(curFields) >= 0) continue;
        curFields.push(cloneFieldDef(f));
        curIds.add(f.id);
        changed = true;
      }
      const rec = await reconcilePluginFieldAsChoice(coll, curFields, desired);
      if (rec.changed) changed = true;
      const finalFields = rec.fields;

      const vMerge = mergeViewsArray(base.views, desired.views);
      if (vMerge.changed) changed = true;
      const finalViews = vMerge.views;

      const curPages = [...(base.page_field_ids || [])];
      const wantPages = [...(desired.page_field_ids || [])];
      const mergedPages = [...new Set([...wantPages, ...curPages])];
      if (JSON.stringify(curPages) !== JSON.stringify(mergedPages)) changed = true;
      if ((base.description || '') !== desired.description) changed = true;
      if ((base.item_name || '') !== (desired.item_name || '')) changed = true;
      if (String(base.name || '').trim() !== COL_NAME) changed = true;
      if (changed) {
        const merged = withUnlockedManaged({
          ...base,
          name: COL_NAME,
          description: desired.description,
          fields: finalFields,
          page_field_ids: mergedPages.length ? mergedPages : wantPages,
          item_name: desired.item_name || base.item_name,
          icon: desired.icon || base.icon,
          color: desired.color !== undefined ? desired.color : base.color,
          home: desired.home !== undefined ? desired.home : base.home,
          views: finalViews,
          sidebar_record_sort_field_id: desired.sidebar_record_sort_field_id || base.sidebar_record_sort_field_id,
          sidebar_record_sort_dir: desired.sidebar_record_sort_dir || base.sidebar_record_sort_dir,
        });
        const ok = await coll.saveConfiguration(merged);
        if (ok === false) console.warn('[ThymerPluginSettings] saveConfiguration returned false (schema not applied?)');
        else {
          try {
            const pf = getPluginFieldDef(coll);
            if (pf && pf.type !== 'choice') {
              console.error(
                '[ThymerPluginSettings] saveConfiguration succeeded but "plugin" field is still type',
                pf.type,
                '— check collection General tab or re-import plugins/public repo/plugin-settings/Plugin Backend.json.'
              );
            }
          } catch (_) {}
        }
      }
      if (changed) await rewritePluginChoiceCells(coll);
    } catch (e) {
      console.error('[ThymerPluginSettings] upgrade schema', e);
    }
  }

  /** Re-apply `plugin` via setChoice so rows are not stuck as “(Other)” after text→choice migration. */
  async function rewritePluginChoiceCells(coll) {
    if (!coll || typeof coll.getAllRecords !== 'function') return;
    try {
      const pluginField = getPluginFieldDef(coll);
      if (!pluginField || pluginField.type !== 'choice') return;
    } catch (_) {
      return;
    }
    let records = [];
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return;
    }
    for (const r of records) {
      let slug = inferPluginSlugFromPid(rowField(r, 'plugin_id'));
      if (!slug) slug = rowField(r, pluginColumnPropId(coll, FIELD_PLUGIN));
      if (!slug) continue;
      setRowField(r, FIELD_PLUGIN, slug, coll);
      // Rows written while setRowField wrongly skipped p.set() for plugin_id (setChoice branch).
      const pidNow = rowField(r, 'plugin_id').trim();
      if (!pidNow) {
        const kind = (rowField(r, FIELD_KIND) || '').trim();
        let legacyVault = false;
        if (!kind) {
          try {
            const raw = rowField(r, 'settings_json');
            if (raw && String(raw).includes('"storageMode"')) legacyVault = true;
          } catch (_) {}
        }
        if (kind === KIND_VAULT || legacyVault) {
          setRowField(r, 'plugin_id', slug, coll);
        } else if (kind === 'config') {
          setRowField(r, 'plugin_id', `${slug}:config`, coll);
        } else if (kind === 'log') {
          let ds = '';
          try {
            const raw = rowField(r, 'settings_json');
            if (raw) {
              const j = JSON.parse(raw);
              if (j && j.date) ds = String(j.date).trim();
            }
          } catch (_) {}
          if (!/^\d{4}-\d{2}-\d{2}$/.test(ds) && typeof r.getName === 'function') {
            ds = String(r.getName() || '').trim();
          }
          if (/^\d{4}-\d{2}-\d{2}$/.test(ds)) {
            setRowField(r, 'plugin_id', `${slug}:log:${ds}`, coll);
          }
        }
      }
    }
  }

  function rowField(r, id) {
    if (!r) return '';
    try {
      const p = r.prop?.(id);
      if (p && typeof p.choice === 'function') {
        const c = p.choice();
        if (c != null && String(c).trim() !== '') return String(c).trim();
      }
    } catch (_) {}
    let v = '';
    try {
      v = r.text?.(id);
    } catch (_) {}
    if (v != null && String(v).trim() !== '') return String(v).trim();
    try {
      const p = r.prop?.(id);
      if (p && typeof p.get === 'function') {
        const g = p.get();
        return g == null ? '' : String(g).trim();
      }
      if (p && typeof p.text === 'function') {
        const t = p.text();
        return t == null ? '' : String(t).trim();
      }
    } catch (_) {}
    return '';
  }

  /** Thymer `setChoice` matches option **label** (see YNAB plugins); return label for slug `id`, else slug. */
  function pluginChoiceSetName(coll, slug) {
    const s = String(slug || '').trim();
    if (!s || !coll || typeof coll.getConfiguration !== 'function') return s;
    try {
      const f = getPluginFieldDef(coll);
      if (!f || f.type !== 'choice' || !Array.isArray(f.choices)) return s;
      const opt = f.choices.find((c) => c && String(c.id || '').trim() === s);
      if (opt && opt.label != null && String(opt.label).trim() !== '') return String(opt.label).trim();
    } catch (_) {}
    return s;
  }

  /**
   * @param coll Optional collection — pass when writing `plugin` so setChoice uses the correct option **label**.
   */
  function setRowField(r, id, value, coll = null) {
    if (!r) return;
    const raw = value == null ? '' : String(value);
    const s = raw.trim();
    const propId = pluginColumnPropId(coll, id);
    try {
      const p = r.prop?.(propId);
      if (!p) return;
      // Thymer exposes setChoice on many property types; it returns false for non-choice fields.
      // Only use setChoice for the Plugin **slug** column — otherwise we return early and never p.set().
      const isPluginChoiceCol = id === FIELD_PLUGIN;
      if (isPluginChoiceCol && typeof p.setChoice === 'function') {
        if (!s) {
          if (typeof p.set === 'function') p.set('');
          return;
        }
        const nameTry = coll != null ? pluginChoiceSetName(coll, s) : s;
        if (p.setChoice(nameTry)) return;
        if (nameTry !== s && p.setChoice(s)) return;
        if (typeof p.set === 'function') {
          try {
            p.set(s);
            return;
          } catch (_) {
            /* continue to warn */
          }
        }
        console.warn('[ThymerPluginSettings] setChoice: no option matched field', id, 'slug', s, 'tried', nameTry);
        return;
      }
      if (typeof p.set === 'function') p.set(raw);
    } catch (e) {
      console.warn('[ThymerPluginSettings] setRowField', id, e);
    }
  }

  /** True for the single mirror row per logical plugin (plugin_id === pluginId and kind vault or legacy). */
  function isVaultRow(r, pluginId) {
    const pid = rowField(r, 'plugin_id');
    if (pid !== pluginId) return false;
    const kind = rowField(r, FIELD_KIND);
    if (kind === KIND_VAULT) return true;
    if (!kind) return true;
    return false;
  }

  /** Parse ISO-ish timestamps for vault row scoring (duplicates: pick freshest, not first in list). */
  function parseVaultIsoMs(s) {
    const n = Date.parse(String(s || ''));
    return Number.isFinite(n) ? n : 0;
  }

  function vaultRowFreshnessScore(r) {
    let score = 0;
    let raw = '';
    try {
      raw = rowField(r, 'settings_json');
    } catch (_) {}
    if (raw && String(raw).trim()) {
      try {
        const j = JSON.parse(raw);
        if (j && typeof j.updatedAt === 'string') {
          const ms = parseVaultIsoMs(j.updatedAt);
          if (ms > score) score = ms;
        }
      } catch (_) {}
    }
    try {
      const ua = rowField(r, 'updated_at');
      if (ua) {
        const ms = parseVaultIsoMs(ua);
        if (ms > score) score = ms;
      }
    } catch (_) {}
    return score;
  }

  function settingsJsonPayloadLen(r) {
    try {
      return String(rowField(r, 'settings_json') || '').length;
    } catch (_) {
      return 0;
    }
  }

  /**
   * Prefer the **newest** vault row when duplicates exist (same `plugin_id`, multiple vault-shaped rows).
   * Previously the first list match could be stale while a newer row held the real payload.
   */
  function findVaultRecord(records, pluginId) {
    if (!records) return null;
    let best = null;
    let bestScore = -1;
    for (const x of records) {
      if (!isVaultRow(x, pluginId)) continue;
      const sc = vaultRowFreshnessScore(x);
      if (sc > bestScore) {
        bestScore = sc;
        best = x;
      } else if (sc === bestScore && best) {
        const lenX = settingsJsonPayloadLen(x);
        const lenB = settingsJsonPayloadLen(best);
        if (lenX > lenB) best = x;
      }
    }
    return best;
  }

  function applyVaultRowMeta(r, pluginId, coll) {
    setRowField(r, 'plugin_id', pluginId);
    setRowField(r, FIELD_PLUGIN, pluginId, coll);
    setRowField(r, FIELD_KIND, KIND_VAULT);
  }

  function drain() {
    if (busy || !q.length) return;
    busy = true;
    const job = q.shift();
    Promise.resolve(typeof job === 'function' ? job() : job)
      .catch((e) => console.error('[ThymerPluginSettings]', e))
      .finally(() => {
        busy = false;
        if (q.length) setTimeout(drain, 450);
      });
  }

  function enqueue(job) {
    q.push(job);
    drain();
  }

  /** Sidebar / command palette title may be `getName()` or only `getConfiguration().name`. */
  function collectionDisplayName(c) {
    if (!c) return '';
    let s = '';
    try {
      s = String(c.getName?.() || '').trim();
    } catch (_) {}
    if (s) return s;
    try {
      s = String(c.getConfiguration?.()?.name || '').trim();
    } catch (_) {}
    return s;
  }

  /** Configured collection name only (avoids duplicating `collectionDisplayName` fallbacks). */
  function collectionBackendConfiguredTitle(c) {
    if (!c) return '';
    try {
      return String(c.getConfiguration?.()?.name || '').trim();
    } catch (_) {
      return '';
    }
  }

  /**
   * When plugin iframes are opaque (blob/sandbox), `navigator.locks` and `window.top` globals do not
   * dedupe across realms. First `localStorage` we can reach on the Thymer app origin is shared.
   */
  function getSharedThymerLocalStorage() {
    const seen = new Set();
    const tryWin = (w) => {
      if (!w || seen.has(w)) return null;
      seen.add(w);
      try {
        const ls = w.localStorage;
        void ls.length;
        return ls;
      } catch (_) {
        return null;
      }
    };
    try {
      const t = tryWin(window.top);
      if (t) return t;
    } catch (_) {}
    try {
      const t = tryWin(window);
      if (t) return t;
    } catch (_) {}
    try {
      let w = window;
      for (let i = 0; i < 10 && w; i++) {
        const t = tryWin(w);
        if (t) return t;
        if (w === w.parent) break;
        w = w.parent;
      }
    } catch (_) {}
    return null;
  }

  /** Unscoped keys (legacy); runtime uses {@link scopedPbLsKey} per workspace. */
  const LS_CREATE_LEASE_BASE = 'thymerext_plugin_backend_create_lease_v1';
  const LS_RECENT_CREATE_BASE = 'thymerext_plugin_backend_recent_create_v1';
  const LS_RECENT_CREATE_ATTEMPT_BASE = 'thymerext_plugin_backend_recent_create_attempt_v1';

  function workspaceSlugFromData(data) {
    try {
      const u = data && typeof data.getActiveUsers === 'function' ? data.getActiveUsers() : null;
      const g = u && u[0] && u[0].workspaceGuid;
      const s = g != null ? String(g).trim() : '';
      if (s) return s.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 120);
    } catch (_) {}
    return '_unknown_ws';
  }

  function scopedPbLsKey(base, data) {
    return `${base}__${workspaceSlugFromData(data)}`;
  }

  /** Count collections whose sidebar/title name is exactly Plugin Backend (or legacy). */
  async function countExactPluginBackendNamedCollections(data) {
    let all;
    try {
      all = await data.getAllCollections();
    } catch (_) {
      return 0;
    }
    if (!Array.isArray(all)) return 0;
    let n = 0;
    for (const c of all) {
      try {
        const nm = collectionDisplayName(c);
        if (nm === COL_NAME || nm === COL_NAME_LEGACY) n += 1;
      } catch (_) {}
    }
    return n;
  }

  /**
   * Cross-realm mutex for `createCollection` + first `saveConfiguration` only.
   * Lease keys are **per workspace** so switching workspaces does not inherit another vault’s lease / cooldown.
   * @returns {{ denied: boolean, release: () => void }}
   */
  async function acquirePluginBackendCreationLease(maxWaitMs, data) {
    const locksOk =
      typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function';
    const noop = { denied: false, release() {} };
    const ls = getSharedThymerLocalStorage();
    if (!ls) {
      if (locksOk) return noop;
      if (DEBUG_COLLECTIONS) {
        dlogPathB('lease_denied_no_localstorage_no_locks', { ws: workspaceSlugFromData(data) });
      }
      return { denied: true, release() {} };
    }
    const leaseKey = scopedPbLsKey(LS_CREATE_LEASE_BASE, data);
    const holder =
      (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    const deadline = Date.now() + (Number(maxWaitMs) > 0 ? maxWaitMs : 12000);
    let acquired = false;
    let sawContention = false;
    while (Date.now() < deadline) {
      try {
        const raw = ls.getItem(leaseKey);
        let busy = false;
        if (raw) {
          let j = null;
          try {
            j = JSON.parse(raw);
          } catch (_) {
            j = null;
          }
          if (j && typeof j.exp === 'number' && j.h !== holder && j.exp > Date.now()) busy = true;
        }
        if (busy) {
          sawContention = true;
          await new Promise((r) => setTimeout(r, 40 + Math.floor(Math.random() * 70)));
          continue;
        }
        const exp = Date.now() + 45000;
        const payload = JSON.stringify({ h: holder, exp });
        ls.setItem(leaseKey, payload);
        await new Promise((r) => setTimeout(r, 0));
        if (ls.getItem(leaseKey) === payload) {
          acquired = true;
          if (DEBUG_COLLECTIONS) dlogPathB('lease_acquired', { via: 'localStorage', sawContention, leaseKey });
          break;
        }
      } catch (_) {
        return locksOk ? noop : { denied: true, release() {} };
      }
      await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 50)));
    }
    if (!acquired) {
      if (DEBUG_COLLECTIONS) dlogPathB('lease_timeout_abort_create', { sawContention, leaseKey });
      return { denied: true, release() {} };
    }
    return {
      denied: false,
      release() {
        if (!acquired) return;
        acquired = false;
        try {
          const cur = ls.getItem(leaseKey);
          if (!cur) return;
          let j = null;
          try {
            j = JSON.parse(cur);
          } catch (_) {
            return;
          }
          if (j && j.h === holder) ls.removeItem(leaseKey);
        } catch (_) {}
      },
    };
  }

  function noteRecentPluginBackendCreate(data) {
    const ls = getSharedThymerLocalStorage();
    if (!ls || !data) return;
    try {
      ls.setItem(scopedPbLsKey(LS_RECENT_CREATE_BASE, data), String(Date.now()));
    } catch (_) {}
  }

  function getRecentPluginBackendCreateAgeMs(data) {
    const ls = getSharedThymerLocalStorage();
    if (!ls || !data) return null;
    try {
      const raw = ls.getItem(scopedPbLsKey(LS_RECENT_CREATE_BASE, data));
      const ts = Number(raw);
      if (!Number.isFinite(ts) || ts <= 0) return null;
      return Date.now() - ts;
    } catch (_) {
      return null;
    }
  }

  function noteRecentPluginBackendCreateAttempt(data) {
    const ls = getSharedThymerLocalStorage();
    if (!ls || !data) return;
    try {
      ls.setItem(scopedPbLsKey(LS_RECENT_CREATE_ATTEMPT_BASE, data), String(Date.now()));
    } catch (_) {}
  }

  function getRecentPluginBackendCreateAttemptAgeMs(data) {
    const ls = getSharedThymerLocalStorage();
    if (!ls || !data) return null;
    try {
      const raw = ls.getItem(scopedPbLsKey(LS_RECENT_CREATE_ATTEMPT_BASE, data));
      const ts = Number(raw);
      if (!Number.isFinite(ts) || ts <= 0) return null;
      return Date.now() - ts;
    } catch (_) {
      return null;
    }
  }

  /** When Thymer omits names on `getAllCollections()` entries, match our Path B schema. */
  function pathBCollectionScore(c) {
    if (!c) return 0;
    try {
      const conf = c.getConfiguration?.() || {};
      const fields = Array.isArray(conf.fields) ? conf.fields : [];
      const ids = new Set(fields.map((f) => f && f.id).filter(Boolean));
      if (!ids.has('plugin_id') || !ids.has('settings_json')) return 0;
      let s = 2;
      if (ids.has(FIELD_PLUGIN)) s += 2;
      if (ids.has(FIELD_KIND)) s += 1;
      const nm = collectionDisplayName(c).toLowerCase();
      if (nm && (nm.includes('plugin') && (nm.includes('backend') || nm.includes('setting')))) s += 1;
      return s;
    } catch (_) {
      return 0;
    }
  }

  function pickPathBCollectionHeuristic(all) {
    const list = Array.isArray(all) ? all : [];
    const cands = [];
    let bestS = 0;
    for (const c of list) {
      const sc = pathBCollectionScore(c);
      if (sc > bestS) {
        bestS = sc;
        cands.length = 0;
        cands.push(c);
      } else if (sc === bestS && sc >= 2) {
        cands.push(c);
      }
    }
    if (!cands.length) return null;
    const named = cands.find((c) => {
      const n = collectionDisplayName(c);
      const cfg = collectionBackendConfiguredTitle(c);
      return n === COL_NAME || n === COL_NAME_LEGACY || cfg === COL_NAME || cfg === COL_NAME_LEGACY;
    });
    return named || cands[0];
  }

  function pickCollFromAll(all) {
    try {
      const pick = (allIn) => {
        const list = Array.isArray(allIn) ? allIn : [];
        return (
          list.find((c) => collectionDisplayName(c) === COL_NAME) ||
          list.find((c) => collectionDisplayName(c) === COL_NAME_LEGACY) ||
          list.find((c) => collectionBackendConfiguredTitle(c) === COL_NAME) ||
          list.find((c) => collectionBackendConfiguredTitle(c) === COL_NAME_LEGACY) ||
          null
        );
      };
      return pick(all) || pickPathBCollectionHeuristic(all) || null;
    } catch (_) {
      return null;
    }
  }

  function hasPluginBackendInAll(all) {
    if (!Array.isArray(all) || all.length === 0) return false;
    for (const c of all) {
      const nm = collectionDisplayName(c);
      if (nm === COL_NAME || nm === COL_NAME_LEGACY) return true;
      const cfg = collectionBackendConfiguredTitle(c);
      if (cfg === COL_NAME || cfg === COL_NAME_LEGACY) return true;
    }
    return !!pickPathBCollectionHeuristic(all);
  }

  async function findColl(data) {
    try {
      const all = await data.getAllCollections();
      return pickCollFromAll(all);
    } catch (_) {
      return null;
    }
  }

  /** Brute list scan — catches a Backend another iframe just created if `findColl` lags. */
  async function hasPluginBackendOnWorkspace(data) {
    let all;
    try {
      all = await data.getAllCollections();
    } catch (_) {
      return false;
    }
    return hasPluginBackendInAll(all);
  }

  const PB_LOCK_NAME = 'thymer-ext-plugin-backend-ensure-v1';
  const DATA_ENSURE_P = '__thymerExtDataPluginBackendEnsureP';
  /** Per-workspace: Plugin Backend already ensured — skip repeat bodies (avoids getAllCollections / lock storms). */
  const WS_ENSURE_OK_MAP = '__thymerExtPbWorkspaceEnsureOkMap_v1';

  function markWorkspacePluginBackendEnsureDone(data) {
    try {
      const slug = workspaceSlugFromData(data);
      const h = getSharedDeduplicationWindow();
      if (!h[WS_ENSURE_OK_MAP] || typeof h[WS_ENSURE_OK_MAP] !== 'object') h[WS_ENSURE_OK_MAP] = Object.create(null);
      h[WS_ENSURE_OK_MAP][slug] = true;
    } catch (_) {}
  }

  function isWorkspacePluginBackendEnsureDone(data) {
    try {
      const slug = workspaceSlugFromData(data);
      const h = getSharedDeduplicationWindow();
      const m = h[WS_ENSURE_OK_MAP];
      return !!(m && m[slug]);
    } catch (_) {
      return false;
    }
  }

  function dlogPathB(phase, extra) {
    if (!DEBUG_COLLECTIONS) return;
    try {
      const row = { runId: DEBUG_PATHB_ID, phase, t: (typeof performance !== 'undefined' && performance.now) ? +performance.now().toFixed(1) : 0, ...extra };
      console.info('[ThymerExt/PluginBackend]', row);
    } catch (_) {
      void 0;
    }
  }

  function pathBWindowSnapshot() {
    const snap = { runId: DEBUG_PATHB_ID, topReadable: null, hasLocks: null };
    try {
      if (typeof window !== 'undefined' && window.top) {
        void window.top.document;
        snap.topReadable = true;
      }
    } catch (e) {
      snap.topReadable = false;
      try {
        snap.topErr = String((e && e.name) || e) || 'top-doc-threw';
      } catch (_) {
        snap.topErr = 'top-doc-threw';
      }
    }
    const host = getSharedDeduplicationWindow();
    try {
      snap.hasLocks = !!(typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request);
    } catch (_) {
      snap.hasLocks = 'err';
    }
    try {
      snap.locationHref = typeof location !== 'undefined' ? String(location.href) : '';
    } catch (_) {
      snap.locationHref = '';
    }
    try {
      snap.hasSelf = typeof self !== 'undefined' && self === window;
      snap.selfIsTop = typeof window !== 'undefined' && window === window.top;
      snap.hostIsTop = host === (typeof window !== 'undefined' ? window.top : null);
      snap.hostIsSelf = host === (typeof window !== 'undefined' ? window : null);
      snap.hostType = (host && host.constructor && host.constructor.name) || '';
    } catch (_) {
      void 0;
    }
    try {
      snap.gHasPbP = host && host[PB_ENSURE_GLOBAL_P] != null;
      snap.gHasCreateQ = host && host[SERIAL_DATA_CREATE_P] != null;
    } catch (_) {
      void 0;
    }
    return snap;
  }

  function queueDataCreateOnSharedWindow(factory) {
    const host = getSharedDeduplicationWindow();
    if (DEBUG_COLLECTIONS) {
      dlogPathB('queueDataCreate_enter', { ...pathBWindowSnapshot() });
    }
    try {
      if (!host[SERIAL_DATA_CREATE_P] || typeof host[SERIAL_DATA_CREATE_P].then !== 'function') {
        host[SERIAL_DATA_CREATE_P] = Promise.resolve();
      }
      const out = (host[SERIAL_DATA_CREATE_P] = host[SERIAL_DATA_CREATE_P].catch(() => {}).then(factory));
      if (DEBUG_COLLECTIONS) dlogPathB('queueDataCreate_chained', { gHasCreateQ: !!host[SERIAL_DATA_CREATE_P] });
      return out;
    } catch (e) {
      if (DEBUG_COLLECTIONS) dlogPathB('queueDataCreate_fallback', { err: String((e && e.message) || e) });
      return factory();
    }
  }

  async function runPluginBackendEnsureBody(data) {
    if (data && isWorkspacePluginBackendEnsureDone(data)) return;
    if (DEBUG_COLLECTIONS) {
      dlogPathB('ensureBody_start', { pathB: pathBWindowSnapshot() });
      try {
        if (data && data.getAllCollections) {
          const a = await data.getAllCollections();
          const list = Array.isArray(a) ? a : [];
          const collNames = list.map((c) => {
            try { return String(collectionDisplayName(c) || '').trim() || '(no-name)'; } catch (__) { return '(err)'; }
          });
          dlogPathB('ensureBody_collections', { count: (collNames && collNames.length) || 0, names: (collNames || []).slice(0, 40) });
          if (data && data.getAllCollections) touchGetAllSanityFromCount((collNames && collNames.length) || 0);
          const dupExact = list.filter((c) => {
            try {
              const nm = collectionDisplayName(c);
              return nm === COL_NAME || nm === COL_NAME_LEGACY;
            } catch (__) {
              return false;
            }
          });
          if (dupExact.length > 1) {
            dlogPathB('duplicate_plugin_backend_named_collections', {
              count: dupExact.length,
              guids: dupExact.map((c) => {
                try {
                  return c.getGuid?.() || null;
                } catch (__) {
                  return null;
                }
              }),
              doc: 'docs/PLUGIN_BACKEND_DUPLICATE_HYGIENE.md',
            });
          }
        }
      } catch (e) {
        dlogPathB('ensureBody_getAll_failed', { err: String((e && e.message) || e) });
      }
    }
    try {
      const markPbOk = () => markWorkspacePluginBackendEnsureDone(data);
      let existing = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        let allAttempt;
        try {
          allAttempt = await data.getAllCollections();
        } catch (_) {
          allAttempt = null;
        }
        if (allAttempt != null) {
          existing = pickCollFromAll(allAttempt);
          if (existing) {
            markPbOk();
            return;
          }
          if (hasPluginBackendInAll(allAttempt)) {
            markPbOk();
            return;
          }
        } else {
          existing = await findColl(data);
          if (existing) {
            markPbOk();
            return;
          }
          if (await hasPluginBackendOnWorkspace(data)) {
            markPbOk();
            return;
          }
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 50 + attempt * 50));
      }
      let allPost;
      try {
        allPost = await data.getAllCollections();
      } catch (_) {
        allPost = null;
      }
      if (allPost != null) {
        existing = pickCollFromAll(allPost);
        if (existing) {
          markPbOk();
          return;
        }
        if (hasPluginBackendInAll(allPost)) {
          markPbOk();
          return;
        }
      } else {
        existing = await findColl(data);
        if (existing) {
          markPbOk();
          return;
        }
        if (await hasPluginBackendOnWorkspace(data)) {
          markPbOk();
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 120));
      let allAfterWait;
      try {
        allAfterWait = await data.getAllCollections();
      } catch (_) {
        allAfterWait = null;
      }
      if (allAfterWait != null) {
        if (pickCollFromAll(allAfterWait)) {
          markPbOk();
          return;
        }
        if (hasPluginBackendInAll(allAfterWait)) {
          markPbOk();
          return;
        }
      } else {
        if (await findColl(data)) {
          markPbOk();
          return;
        }
        if (await hasPluginBackendOnWorkspace(data)) {
          markPbOk();
          return;
        }
      }
      let preCreateLen = 0;
      try {
        if (data && data.getAllCollections) {
          const all0 = await data.getAllCollections();
          preCreateLen = Array.isArray(all0) ? all0.length : 0;
          if (preCreateLen > 0) touchGetAllSanityFromCount(preCreateLen);
        }
        if (preCreateLen === 0) {
          await new Promise((r) => setTimeout(r, 150));
          if (data && data.getAllCollections) {
            const all1 = await data.getAllCollections();
            preCreateLen = Array.isArray(all1) ? all1.length : 0;
            if (preCreateLen > 0) touchGetAllSanityFromCount(preCreateLen);
          }
        }
        if (preCreateLen > 0) {
          let allPre;
          try {
            allPre = await data.getAllCollections();
          } catch (_) {
            allPre = null;
          }
          if (allPre != null) {
            if (pickCollFromAll(allPre)) {
              markPbOk();
              return;
            }
            if (hasPluginBackendInAll(allPre)) {
              markPbOk();
              return;
            }
          } else {
            if (await findColl(data)) {
              markPbOk();
              return;
            }
            if (await hasPluginBackendOnWorkspace(data)) {
              markPbOk();
              return;
            }
          }
        }
        if (isSuspiciousEmptyAfterRecentNonEmptyList(preCreateLen) && preCreateLen === 0) {
          if (DEBUG_COLLECTIONS) {
            try {
              const h = getSharedDeduplicationWindow();
              dlogPathB('refuse_create_flaky_getall_empty', { pathB: pathBWindowSnapshot(), s: h[GETALL_COLLECTIONS_SANITY] || null });
            } catch (_) {
              dlogPathB('refuse_create_flaky_getall_empty', { pathB: pathBWindowSnapshot() });
            }
          }
          return;
        }
      } catch (_) {
        void 0;
      }
      if (DEBUG_COLLECTIONS) dlogPathB('ensureBody_about_to_create', { pathB: pathBWindowSnapshot() });
      const lease = await acquirePluginBackendCreationLease(14000, data);
      if (lease.denied) return;
      try {
        let allLease;
        try {
          allLease = await data.getAllCollections();
        } catch (_) {
          allLease = null;
        }
        if (allLease != null) {
          if (pickCollFromAll(allLease)) {
            markPbOk();
            return;
          }
          if (hasPluginBackendInAll(allLease)) {
            markPbOk();
            return;
          }
        } else {
          if (await findColl(data)) {
            markPbOk();
            return;
          }
          if (await hasPluginBackendOnWorkspace(data)) {
            markPbOk();
            return;
          }
        }
        const recentAttemptAge = getRecentPluginBackendCreateAttemptAgeMs(data);
        if (recentAttemptAge != null && recentAttemptAge >= 0 && recentAttemptAge < 120000) {
          // Another plugin iframe attempted creation very recently. Avoid burst duplicate creates.
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 130 + i * 70));
            let allCont;
            try {
              allCont = await data.getAllCollections();
            } catch (_) {
              allCont = null;
            }
            if (allCont != null) {
              if (pickCollFromAll(allCont)) {
                markPbOk();
                return;
              }
              if (hasPluginBackendInAll(allCont)) {
                markPbOk();
                return;
              }
            } else {
              if (await findColl(data)) {
                markPbOk();
                return;
              }
              if (await hasPluginBackendOnWorkspace(data)) {
                markPbOk();
                return;
              }
            }
          }
          return;
        }
        const recentAge = getRecentPluginBackendCreateAgeMs(data);
        if (recentAge != null && recentAge >= 0 && recentAge < 90000) {
          // Another plugin/runtime likely just created it; let collection list/indexing settle first.
          for (let i = 0; i < 8; i++) {
            await new Promise((r) => setTimeout(r, 120 + i * 60));
            let allSettle;
            try {
              allSettle = await data.getAllCollections();
            } catch (_) {
              allSettle = null;
            }
            if (allSettle != null) {
              if (pickCollFromAll(allSettle)) {
                markPbOk();
                return;
              }
              if (hasPluginBackendInAll(allSettle)) {
                markPbOk();
                return;
              }
            } else {
              if (await findColl(data)) {
                markPbOk();
                return;
              }
              if (await hasPluginBackendOnWorkspace(data)) {
                markPbOk();
                return;
              }
            }
          }
        }
        noteRecentPluginBackendCreateAttempt(data);
        const exactN = await countExactPluginBackendNamedCollections(data);
        if (exactN >= 1) {
          if (DEBUG_COLLECTIONS) {
            dlogPathB('abort_create_exact_backend_name_exists', { exactN, ws: workspaceSlugFromData(data) });
          }
          markPbOk();
          return;
        }
        const coll = await queueDataCreateOnSharedWindow(() => data.createCollection());
        if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') {
          return;
        }
        const conf = cloneShape();
        const base = coll.getConfiguration();
        if (base && typeof base.ver === 'number') conf.ver = base.ver;
        let ok = await coll.saveConfiguration(conf);
        if (ok === false) {
          // Transient host races can reject the first save; retry before giving up.
          await new Promise((r) => setTimeout(r, 180));
          ok = await coll.saveConfiguration(conf);
        }
        if (ok === false) return;
        noteRecentPluginBackendCreate(data);
        markPbOk();
        await new Promise((r) => setTimeout(r, 250));
      } finally {
        try {
          lease.release();
        } catch (_) {}
      }
    } catch (e) {
      console.error('[ThymerPluginSettings] ensure collection', e);
    }
  }

  function runPluginBackendEnsureWithLocksOrChain(data) {
    try {
      if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
        if (DEBUG_COLLECTIONS) dlogPathB('ensure_route', { via: 'locks', lockName: PB_LOCK_NAME, pathB: pathBWindowSnapshot() });
        return navigator.locks.request(PB_LOCK_NAME, () => runPluginBackendEnsureBody(data));
      }
    } catch (e) {
      if (DEBUG_COLLECTIONS) dlogPathB('ensure_locks_threw', { err: String((e && e.message) || e) });
    }
    if (DEBUG_COLLECTIONS) dlogPathB('ensure_route', { via: 'hierarchyChain', pathB: pathBWindowSnapshot() });
    return chainPluginBackendEnsure(data, () => runPluginBackendEnsureBody(data));
  }

  function ensurePluginSettingsCollection(data) {
    if (!data || typeof data.getAllCollections !== 'function' || typeof data.createCollection !== 'function') {
      return Promise.resolve();
    }
    if (isWorkspacePluginBackendEnsureDone(data)) {
      return Promise.resolve();
    }
    if (DEBUG_COLLECTIONS) {
      let dHint = 'no-data';
      try {
        dHint = data
          ? `ctor=${(data && data.constructor && data.constructor.name) || '?'},eqPrev=${(data && data === g.__th_lastDataPb) || false},keys=${
            Object.keys(data).filter((k) => k && (k.includes('thymer') || k.includes('__'))).length
          }`
          : 'null';
        g.__th_lastDataPb = data;
      } catch (_) {
        dHint = 'err';
      }
      dlogPathB('ensurePluginSettingsCollection', { dataHint: dHint, dataExpand: (() => { try { if (!data) return { ok: false }; return { hasDataEnsure: !!data[DATA_ENSURE_P] }; } catch (_) { return { ok: 'throw' }; } })(), pathB: pathBWindowSnapshot() });
    }
    try {
      if (!data[DATA_ENSURE_P] || typeof data[DATA_ENSURE_P].then !== 'function') {
        data[DATA_ENSURE_P] = Promise.resolve();
      }
      if (DEBUG_COLLECTIONS) dlogPathB('data_ensure_p_chained', { hasPriorTail: true });
      const next = data[DATA_ENSURE_P]
        .catch(() => {})
        .then(() => runPluginBackendEnsureWithLocksOrChain(data));
      data[DATA_ENSURE_P] = next;
      return next;
    } catch (e) {
      if (DEBUG_COLLECTIONS) dlogPathB('data_ensure_p_throw', { err: String((e && e.message) || e) });
      return runPluginBackendEnsureWithLocksOrChain(data);
    }
  }

  async function readDoc(data, pluginId) {
    const coll = await findColl(data);
    if (!coll) return null;
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return null;
    }
    const r = findVaultRecord(records, pluginId);
    if (!r) return null;
    let raw = '';
    try {
      raw = r.text?.('settings_json') || '';
    } catch (_) {}
    if (!raw || !String(raw).trim()) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  async function writeDoc(data, pluginId, doc) {
    const coll = await findColl(data);
    if (!coll) return;
    await upgradePluginSettingsSchema(data, coll);
    const json = JSON.stringify(doc);
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return;
    }
    let r = findVaultRecord(records, pluginId);
    if (!r) {
      let guid = null;
      try {
        guid = coll.createRecord?.(pluginId);
      } catch (_) {}
      if (guid) {
        for (let i = 0; i < 30; i++) {
          await new Promise((res) => setTimeout(res, i < 8 ? 100 : 200));
          try {
            const again = await coll.getAllRecords();
            r = again.find((x) => x.guid === guid) || findVaultRecord(again, pluginId);
            if (r) break;
          } catch (_) {}
        }
      }
    }
    if (!r) return;
    applyVaultRowMeta(r, pluginId, coll);
    try {
      const pj = r.prop?.('settings_json');
      if (pj && typeof pj.set === 'function') pj.set(json);
    } catch (_) {}
  }

  const LOCAL_MIRROR_META_PREFIX = 'thymerext_ps_local_meta_v1:';

  function localMirrorMetaKey(pluginId) {
    return LOCAL_MIRROR_META_PREFIX + encodeURIComponent(String(pluginId || 'unknown'));
  }

  function parseIsoMs(s) {
    const n = Date.parse(String(s || ''));
    return Number.isFinite(n) ? n : 0;
  }

  function readLocalMirrorMeta(pluginId) {
    try {
      const raw = localStorage.getItem(localMirrorMetaKey(pluginId));
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) {}
    return {};
  }

  function writeLocalMirrorMeta(pluginId, meta) {
    try {
      localStorage.setItem(localMirrorMetaKey(pluginId), JSON.stringify(meta || {}));
    } catch (_) {}
  }

  function markLocalMirrorKeys(pluginId, keys, updatedAt) {
    if (!pluginId || !Array.isArray(keys)) return;
    const meta = readLocalMirrorMeta(pluginId);
    const ts = updatedAt || new Date().toISOString();
    let changed = false;
    for (const k of keys) {
      if (!k) continue;
      let exists = false;
      try {
        exists = localStorage.getItem(k) !== null;
      } catch (_) {}
      if (!exists) continue;
      meta[k] = { updatedAt: ts };
      changed = true;
    }
    if (changed) writeLocalMirrorMeta(pluginId, meta);
  }

  function collectLocalMirrorPayload(keys) {
    const payload = {};
    if (!Array.isArray(keys)) return payload;
    for (const k of keys) {
      if (!k) continue;
      try {
        const v = localStorage.getItem(k);
        if (v !== null) payload[k] = v;
      } catch (_) {}
    }
    return payload;
  }

  function localPayloadMatchesRemote(keys, remote) {
    if (!remote || !remote.payload || typeof remote.payload !== 'object') return false;
    if (!Array.isArray(keys)) return true;
    for (const k of keys) {
      if (!k) continue;
      let localValue = null;
      try {
        localValue = localStorage.getItem(k);
      } catch (_) {}
      const remoteValue = remote.payload[k];
      if (localValue === null && typeof remoteValue !== 'string') continue;
      if (localValue !== remoteValue) return false;
    }
    return true;
  }

  function applyRemoteMirrorPayload(pluginId, keys, remote) {
    const result = { needsFlush: false };
    if (!remote || !remote.payload || typeof remote.payload !== 'object') return result;
    const meta = readLocalMirrorMeta(pluginId);
    const remoteUpdatedAt = String(remote.updatedAt || '');
    const remoteMs = parseIsoMs(remoteUpdatedAt);
    let metaChanged = false;
    for (const k of keys) {
      if (!k) continue;
      const remoteValue = remote.payload[k];
      if (typeof remoteValue !== 'string') continue;

      let localValue = null;
      try {
        localValue = localStorage.getItem(k);
      } catch (_) {}

      if (localValue === remoteValue) {
        if (remoteUpdatedAt && (!meta[k] || !meta[k].updatedAt)) {
          meta[k] = { updatedAt: remoteUpdatedAt };
          metaChanged = true;
        }
        continue;
      }

      if (localValue === null) {
        try {
          localStorage.setItem(k, remoteValue);
          if (remoteUpdatedAt) {
            meta[k] = { updatedAt: remoteUpdatedAt };
            metaChanged = true;
          }
        } catch (_) {}
        continue;
      }

      const localMs = parseIsoMs(meta[k]?.updatedAt);
      if (localMs && remoteMs && remoteMs > localMs + 1000) {
        try {
          localStorage.setItem(k, remoteValue);
          meta[k] = { updatedAt: remoteUpdatedAt };
          metaChanged = true;
        } catch (_) {}
        continue;
      }

      // When freshness is ambiguous, preserve the browser's current settings and let flushNow repair the vault row.
      result.needsFlush = true;
      if (!localMs) {
        meta[k] = { updatedAt: new Date().toISOString() };
        metaChanged = true;
      }
      console.warn('[ThymerPluginSettings] Kept local settings instead of overwriting with older/ambiguous synced payload', {
        pluginId,
        key: k,
        localUpdatedAt: meta[k]?.updatedAt || null,
        remoteUpdatedAt: remoteUpdatedAt || null,
      });
    }
    if (metaChanged) writeLocalMirrorMeta(pluginId, meta);
    return result;
  }

  function shouldFlushMirrorOnInit(keys, remote, applyResult) {
    if (applyResult?.needsFlush) return true;
    if (remote && remote.payload && typeof remote.payload === 'object') {
      return !localPayloadMatchesRemote(keys, remote);
    }
    return Object.keys(collectLocalMirrorPayload(keys)).length > 0;
  }

  async function listRows(data, { pluginSlug, recordKind } = {}) {
    const slug = (pluginSlug || '').trim();
    if (!slug) return [];
    const coll = await findColl(data);
    if (!coll) return [];
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return [];
    }
    const plugCol = pluginColumnPropId(coll, FIELD_PLUGIN);
    return records.filter((r) => {
      const pid = rowField(r, 'plugin_id');
      let rowSlug = rowField(r, plugCol);
      if (!rowSlug) rowSlug = inferPluginSlugFromPid(pid);
      if (rowSlug !== slug) return false;
      if (recordKind != null && String(recordKind) !== '') {
        const rk = rowField(r, FIELD_KIND) || inferRecordKindFromPid(pid, slug);
        return rk === String(recordKind);
      }
      return true;
    });
  }

  async function createDataRow(data, { pluginSlug, recordKind, rowPluginId, recordTitle, settingsDoc } = {}) {
    const ps = (pluginSlug || '').trim();
    const rid = (rowPluginId || '').trim();
    const kind = (recordKind || '').trim();
    if (!ps || !rid || !kind) {
      console.warn('[ThymerPluginSettings] createDataRow: pluginSlug, recordKind, and rowPluginId are required');
      return null;
    }
    if (rid === ps && kind !== KIND_VAULT) {
      console.warn('[ThymerPluginSettings] createDataRow: rowPluginId must differ from plugin slug unless record_kind is vault');
    }
    await ensurePluginSettingsCollection(data);
    const coll = await findColl(data);
    if (!coll) return null;
    await upgradePluginSettingsSchema(data, coll);
    const title = (recordTitle || rid).trim() || rid;
    let guid = null;
    try {
      guid = coll.createRecord?.(title);
    } catch (e) {
      console.error('[ThymerPluginSettings] createDataRow createRecord', e);
      return null;
    }
    if (!guid) return null;
    let r = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, i < 8 ? 100 : 200));
      try {
        const again = await coll.getAllRecords();
        r = again.find((x) => x.guid === guid) || again.find((x) => rowField(x, 'plugin_id') === rid);
        if (r) break;
      } catch (_) {}
    }
    if (!r) return null;
    setRowField(r, 'plugin_id', rid);
    setRowField(r, FIELD_PLUGIN, ps, coll);
    setRowField(r, FIELD_KIND, kind);
    const json =
      settingsDoc !== undefined && settingsDoc !== null
        ? typeof settingsDoc === 'string'
          ? settingsDoc
          : JSON.stringify(settingsDoc)
        : '{}';
    try {
      const pj = r.prop?.('settings_json');
      if (pj && typeof pj.set === 'function') pj.set(json);
    } catch (_) {}
    return r;
  }

  function showFirstRunDialog(ui, label, preferred, onPick) {
    const id = 'thymerext-ps-first-' + Math.random().toString(36).slice(2);
    const box = document.createElement('div');
    box.id = id;
    box.style.cssText =
      'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;padding:16px;';
    const card = document.createElement('div');
    card.style.cssText =
      'max-width:420px;width:100%;background:var(--panel-bg-color,#1d1915);border:1px solid var(--border-default,#3f3f46);border-radius:12px;padding:20px;box-shadow:0 8px 32px rgba(0,0,0,0.5);';
    const title = document.createElement('div');
    title.textContent = label + ' — where to store settings?';
    title.style.cssText = 'font-weight:700;font-size:15px;margin-bottom:10px;';
    const hint = document.createElement('div');
    hint.textContent = 'Change later via Command Palette → “Storage location…”';
    hint.style.cssText = 'font-size:12px;color:var(--text-muted,#888);margin-bottom:16px;line-height:1.45;';
    const mk = (t, sub, prim) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.cssText =
        'display:block;width:100%;text-align:left;padding:12px 14px;margin-bottom:10px;border-radius:8px;cursor:pointer;font-size:14px;border:1px solid var(--border-default,#3f3f46);background:' +
        (prim ? 'rgba(167,139,250,0.25)' : 'transparent') +
        ';color:inherit;';
      const x = document.createElement('div');
      x.textContent = t;
      x.style.fontWeight = '600';
      b.appendChild(x);
      if (sub) {
        const s = document.createElement('div');
        s.textContent = sub;
        s.style.cssText = 'font-size:11px;opacity:0.75;margin-top:4px;line-height:1.35;';
        b.appendChild(s);
      }
      return b;
    };
    const bLoc = mk('This device only', 'Browser localStorage only.', preferred === 'local');
    const bSyn = mk(
      'Sync across devices',
      'Store in the workspace “' + COL_NAME + '” collection (same account on any browser).',
      preferred === 'synced'
    );
    const fin = (m) => {
      try {
        box.remove();
      } catch (_) {}
      onPick(m);
    };
    bLoc.addEventListener('click', () => fin('local'));
    bSyn.addEventListener('click', () => fin('synced'));
    card.appendChild(title);
    card.appendChild(hint);
    card.appendChild(bLoc);
    card.appendChild(bSyn);
    box.appendChild(card);
    document.body.appendChild(box);
  }

  g.ThymerPluginSettings = {
    COL_NAME,
    COL_NAME_LEGACY,
    FIELD_PLUGIN,
    FIELD_RECORD_KIND: FIELD_KIND,
    RECORD_KIND_VAULT: KIND_VAULT,
    enqueue,
    rowField,
    findVaultRecord,
    listRows,
    createDataRow,
    upgradeCollectionSchema: (data) => upgradePluginSettingsSchema(data),
    registerPluginSlug,

    async init(opts) {
      const { plugin, pluginId, modeKey, mirrorKeys, label, data, ui } = opts;

      let mode = null;
      try {
        mode = localStorage.getItem(modeKey);
      } catch (_) {}

      const remote = await readDoc(data, pluginId);
      if (!mode && remote && (remote.storageMode === 'synced' || remote.storageMode === 'local')) {
        mode = remote.storageMode;
        try {
          localStorage.setItem(modeKey, mode);
        } catch (_) {}
      }

      if (!mode) {
        const coll = await findColl(data);
        const preferred = coll ? 'synced' : 'local';
        await new Promise((r) => {
          requestAnimationFrame(() => requestAnimationFrame(() => r()));
        });
        await new Promise((outerResolve) => {
          enqueue(async () => {
            const picked = await new Promise((r) => {
              showFirstRunDialog(ui, label, preferred, r);
            });
            try {
              localStorage.setItem(modeKey, picked);
            } catch (_) {}
            outerResolve(picked);
          });
        });
        try {
          mode = localStorage.getItem(modeKey);
        } catch (_) {}
      }

      plugin._pluginSettingsSyncMode = mode === 'synced' ? 'synced' : 'local';
      plugin._pluginSettingsPluginId = pluginId;
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      let initFlushNeeded = false;

      if (plugin._pluginSettingsSyncMode === 'synced' && remote && remote.payload && typeof remote.payload === 'object') {
        const applyResult = applyRemoteMirrorPayload(pluginId, keys, remote);
        initFlushNeeded = shouldFlushMirrorOnInit(keys, remote, applyResult);
      } else if (plugin._pluginSettingsSyncMode === 'synced') {
        initFlushNeeded = shouldFlushMirrorOnInit(keys, remote, null);
      }

      if (plugin._pluginSettingsSyncMode === 'synced' && initFlushNeeded) {
        try {
          markLocalMirrorKeys(pluginId, keys);
          await g.ThymerPluginSettings.flushNow(data, pluginId, keys);
        } catch (_) {}
      }
    },

    scheduleFlush(plugin, mirrorKeys) {
      if (plugin._pluginSettingsSyncMode !== 'synced') return;
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      markLocalMirrorKeys(plugin._pluginSettingsPluginId, keys);
      if (plugin._pluginSettingsFlushTimer) clearTimeout(plugin._pluginSettingsFlushTimer);
      plugin._pluginSettingsFlushTimer = setTimeout(() => {
        plugin._pluginSettingsFlushTimer = null;
        const pdata = plugin.data;
        const pid = plugin._pluginSettingsPluginId;
        if (!pid || !pdata) return;
        g.ThymerPluginSettings.flushNow(pdata, pid, keys).catch((e) => console.error('[ThymerPluginSettings] flush', e));
      }, 500);
    },

    async flushNow(data, pluginId, mirrorKeys) {
      await ensurePluginSettingsCollection(data);
      await upgradePluginSettingsSchema(data);
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      const payload = {};
      for (const k of keys) {
        try {
          const v = localStorage.getItem(k);
          if (v !== null) payload[k] = v;
        } catch (_) {}
      }
      const doc = {
        v: 1,
        storageMode: 'synced',
        updatedAt: new Date().toISOString(),
        payload,
      };
      await writeDoc(data, pluginId, doc);
    },

    async openStorageDialog(opts) {
      const { plugin, pluginId, modeKey, mirrorKeys, label, data, ui } = opts;
      const cur = plugin._pluginSettingsSyncMode === 'synced' ? 'synced' : 'local';
      const pick = await new Promise((resolve) => {
        const close = (v) => {
          try {
            box.remove();
          } catch (_) {}
          resolve(v);
        };
        const box = document.createElement('div');
        box.style.cssText =
          'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;padding:16px;';
        box.addEventListener('click', (e) => {
          if (e.target === box) close(null);
        });
        const card = document.createElement('div');
        card.style.cssText =
          'max-width:400px;width:100%;background:var(--panel-bg-color,#1d1915);border:1px solid var(--border-default,#3f3f46);border-radius:12px;padding:18px;';
        card.addEventListener('click', (e) => e.stopPropagation());
        const t = document.createElement('div');
        t.textContent = label + ' — storage';
        t.style.cssText = 'font-weight:700;margin-bottom:12px;';
        const b1 = document.createElement('button');
        b1.type = 'button';
        b1.textContent = 'This device only';
        const b2 = document.createElement('button');
        b2.type = 'button';
        b2.textContent = 'Sync across devices';
        [b1, b2].forEach((b) => {
          b.style.cssText =
            'display:block;width:100%;padding:10px 12px;margin-bottom:8px;border-radius:8px;cursor:pointer;border:1px solid var(--border-default,#3f3f46);background:transparent;color:inherit;text-align:left;';
        });
        b1.addEventListener('click', () => close('local'));
        b2.addEventListener('click', () => close('synced'));
        const bx = document.createElement('button');
        bx.type = 'button';
        bx.textContent = 'Cancel';
        bx.style.cssText =
          'margin-top:8px;padding:8px 14px;border-radius:8px;cursor:pointer;border:1px solid var(--border-default,#3f3f46);background:transparent;color:inherit;';
        bx.addEventListener('click', () => close(null));
        card.appendChild(t);
        card.appendChild(b1);
        card.appendChild(b2);
        card.appendChild(bx);
        box.appendChild(card);
        document.body.appendChild(box);
      });
      if (!pick || pick === cur) return;
      try {
        localStorage.setItem(modeKey, pick);
      } catch (_) {}
      plugin._pluginSettingsSyncMode = pick === 'synced' ? 'synced' : 'local';
      const keyList = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      if (pick === 'synced') {
        markLocalMirrorKeys(pluginId, keyList);
        await g.ThymerPluginSettings.flushNow(data, pluginId, keyList);
      }
      ui.addToaster?.({
        title: label,
        message: pick === 'synced' ? 'Settings will sync across devices.' : 'Settings stay on this device only.',
        dismissible: true,
        autoDestroyTime: 3500,
      });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
// @generated END thymer-plugin-settings


/**
 * HabitTracker — Global plugin (journal sidebar)
 * @version 1.1.0
 *
 * UI icons: Tabler Icons (https://tabler.io/icons) via webfont classes `ti ti-{name}`.
 *
 * Data model — dedicated **"Habit Logs"** collection (config + log rows) plus **Plugin Backend** vault mirror (`ThymerPluginSettings`):
 *   - **Vault** row (`plugin_id` = `habit-tracker`, `record_kind` = `vault`): synced localStorage mirror for panel UI keys only.
 *   - **Config** row in **Habit Logs** (`record_kind` = `config`, `plugin_id` = `habit-tracker:config`): categories/habits JSON in `settings_json`.
 *   - **Log** rows (`record_kind` = `log`, `plugin_id` = `habit-tracker:log:YYYY-MM-DD`): per-day completions JSON in `settings_json`.
 *
 * One-time migration: legacy **HabitTracker** collection and old Plugin Backend habit rows are copied into **Habit Logs** when present (see `HT_PS_MIGRATE_KEY` in localStorage).
 *
 * Config / log JSON shapes unchanged from the old collection plugin.
 *
 * Streaks are calculated on-the-fly by scanning log rows.
 */

// ═══ Habit Tracker (ThymerHabitTracker port — plugin_id habit-tracker; config+log live in dedicated "Habit Logs" collection) ═══
// Dedicated habits collection: the ONLY persistence target for habit config + log rows.
// (Vault rows for plugin UI prefs continue to live in Plugin Backend, written by ThymerPluginSettings.)
// As of 2026-05-08, the legacy "Plugin Backend habit storage" mode is gone — see notes in
// _htEnsureHabitsStorageReady below. Old localStorage flag retained for one-shot cleanup only.
const HT_DEDICATED_COLL_NAME = 'Habit Logs';
const HT_LEGACY_STORAGE_MODE_KEY = 'jhs_ht_habits_storage_v1';
const HT_DEDICATED_COLL_GUID_KEY = 'jhs_ht_habits_coll_guid_v1';
const HT_DEDICATED_ENSURE_LOCK = 'thymerext-jhs-habits-coll-ensure';
/** Must match serialized create queue in embedded ThymerPluginSettings (`queueDataCreateOnSharedWindow`). */
const HT_SERIAL_DATA_CREATE_P = '__thymerExtSerializedDataCreateP_v1';

const HT_DEDICATED_COLL_BASE = JSON.parse(
  '{"ver":1,"name":"Habit Logs","icon":"ti-checkbox","color":null,"home":false,"page_field_ids":["plugin","record_kind","plugin_id","created_at","updated_at","settings_json"],"item_name":"Setting, Config, or Log","description":"Habit Tracker: habit definitions and daily completion logs (separate from Plugin Backend for performance).","show_sidebar_items":true,"show_cmdpal_items":false,"fields":[{"icon":"ti-apps","id":"plugin","label":"Plugin","type":"choice","read_only":false,"active":true,"many":false,"choices":[{"id":"habit-tracker","label":"Habit Tracker","color":"0","active":true}]},{"icon":"ti-category","id":"record_kind","label":"Record kind","type":"text","read_only":false,"active":true,"many":false},{"icon":"ti-id","id":"plugin_id","label":"Plugin ID","type":"text","read_only":false,"active":true,"many":false},{"icon":"ti-clock-plus","id":"created_at","label":"Created","many":false,"read_only":true,"active":true,"type":"datetime"},{"icon":"ti-clock-edit","id":"updated_at","label":"Modified","many":false,"read_only":true,"active":true,"type":"datetime"},{"icon":"ti-code","id":"settings_json","label":"Settings JSON","type":"text","read_only":false,"active":true,"many":false},{"icon":"ti-abc","id":"title","label":"Title","many":false,"read_only":false,"active":true,"type":"text"},{"icon":"ti-photo","id":"banner","label":"Banner","many":false,"read_only":false,"active":true,"type":"banner"},{"icon":"ti-align-left","id":"icon","label":"Icon","many":false,"read_only":false,"active":true,"type":"text"}],"sidebar_record_sort_dir":"desc","sidebar_record_sort_field_id":"updated_at","managed":{"fields":false,"views":false,"sidebar":false},"custom":{},"views":[{"id":"V0YBPGDDZ0MHRSQ","shown":true,"icon":"ti-table","label":"All","description":"","field_ids":["title","plugin","record_kind","plugin_id","created_at","updated_at"],"type":"table","read_only":false,"group_by_field_id":null,"sort_dir":"desc","sort_field_id":"updated_at","opts":{}},{"id":"VPGAWVGVKZD57C9","shown":true,"icon":"ti-layout-kanban","label":"By Plugin...","description":"","field_ids":["title","record_kind","created_at","updated_at"],"type":"board","read_only":false,"group_by_field_id":"plugin","sort_dir":"desc","sort_field_id":"updated_at","opts":{}}]}'
);

function htDedicatedHabitsCollectionShape() {
  try {
    return typeof structuredClone === 'function'
      ? structuredClone(HT_DEDICATED_COLL_BASE)
      : JSON.parse(JSON.stringify(HT_DEDICATED_COLL_BASE));
  } catch (_) {
    return JSON.parse(JSON.stringify(HT_DEDICATED_COLL_BASE));
  }
}

/**
 * Same host as embedded `ThymerPluginSettings` `getSharedDeduplicationWindow` / `queueDataCreateOnSharedWindow`.
 * Plugin iframes must attach `__thymerExtSerializedDataCreateP_v1` here or `createCollection()` can resolve null.
 */
function htGetSharedDeduplicationWindow() {
  const gRef = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : globalThis;
  try {
    if (typeof window === 'undefined') return gRef;
    const t = window.top;
    if (t) {
      void t.document;
      return t;
    }
  } catch (_) {
    /* cross-origin top */
  }
  try {
    let w = typeof window !== 'undefined' ? window : null;
    let best = w || gRef;
    while (w) {
      try {
        void w.document;
        best = w;
      } catch (_) {
        break;
      }
      if (w === w.top) break;
      w = w.parent;
    }
    return best;
  } catch (_) {
    return typeof window !== 'undefined' ? window : gRef;
  }
}

// ── YNAB journal widget (shared localStorage / SK with YNAB collection plugin) ─
// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const YNAB_COLLECTION_NAME = 'YNAB';
const CACHE_TTL_MS  = 15 * 60 * 1000;
const CHART_JS_URL  = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';

// Colors
// Widget bg matches Backreferences / Today's Notes card exactly (rgba(30,30,36,0.60))
// Green is now a deeper forest: #1e5c35
const C = {
  green:     '#1e5c35',
  greenRgb:  '30, 92, 53',
  prevLine:  'rgba(140, 130, 110, 0.40)',
  avgLine:   'rgba(110, 100, 88, 0.90)',
  axisText:  '#6e6458',
  statLabel: '#8a7e6a',
  text:      '#e8e0d0',
  textMuted: '#8a7e6a',
  // Exact match to Backreferences card bg (Today's Notes plugin confirmed values)
  cardBg:    'rgba(30, 30, 36, 0.60)',
  cardBorder:'rgba(255, 255, 255, 0.10)',
  hoverBg:   '#2a241f',
};

const SK = {
  TOKEN:           'ynab_pat',
  BUDGET_ID:       'ynab_budget_id',
  BUDGET_NAME:     'ynab_budget_name',
  CACHE_TXN:       'ynab_txn_cache_v4',
  CACHE_CATS:      'ynab_cats_v4',
  CACHE_CATS_TS:   'ynab_cats_ts_v4',
  CACHE_TS:        'ynab_txn_cache_ts',
  EXCLUDED_GROUPS: 'ynab_excluded_groups',
  WIDGET_PERIOD:   'ynab_widget_period',
  WIDGET_CHART:    'ynab_widget_chart',
  WIDGET_COMPARE:  'ynab_widget_compare',
  WIDGET_AVG:      'ynab_widget_avg',
  WIDGET_COLLAPSE: 'ynab_widget_collapse',
  DASH_FROM:       'ynab_dash_from',
  DASH_TO:         'ynab_dash_to',
  EXCL_PAYEES:     'ynab_excl_payees',
  INCL_PAYEES:     'ynab_incl_payees_v4',   // null = not yet configured (use defaults)
};

// Default excluded expense category groups
// Default excluded payee keywords for income filter
const DEFAULT_EXCLUDED = [
  'Inflow: Ready to Assign',
  'Internal Master Category',
  'Credit Card Payments',
];

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────

const ls      = k    => { try { return localStorage.getItem(k); } catch { return null; } };
function ynabShouldFlushKey(key) {
  // High-churn cache keys should never trigger Plugin Backend sync flushes.
  return !(
    key === SK.CACHE_TXN ||
    key === SK.CACHE_TS ||
    key === SK.CACHE_CATS ||
    key === SK.CACHE_CATS_TS
  );
}
function ynabPluginSettingsFlush() {
  try {
    const p = globalThis.__ynabPluginSettingsPlugin;
    if (p) globalThis.ThymerPluginSettings?.scheduleFlush?.(p, () => Object.values(SK));
  } catch (_) {}
}
const lsSet   = (k,v)=> {
  try { localStorage.setItem(k, String(v)); } catch {}
  if (ynabShouldFlushKey(k)) ynabPluginSettingsFlush();
};
const lsJson  = (k,d)=> { try { const v = ls(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const lsJsonSet=(k,v)=> {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  if (ynabShouldFlushKey(k)) ynabPluginSettingsFlush();
};
const sleep   = ms   => new Promise(r => setTimeout(r, ms));

function fmt(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function journalDateFromGuid(guid) {
  if (!guid || guid.length < 8) return null;
  const s = guid.slice(-8);
  if (!/^\d{8}$/.test(s)) return null;
  const year  = parseInt(s.slice(0, 4), 10);
  const month = parseInt(s.slice(4, 6), 10);
  const day   = parseInt(s.slice(6, 8), 10);
  if (year < 2000 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day, yyyymmdd: s };
}

/** Same shape as journalDateFromGuid; falls back to journal details when GUID suffix is not YYYYMMDD. */
function journalDateFromRecord(record) {
  if (!record) return null;
  const fromGuid = journalDateFromGuid(record.guid);
  if (fromGuid) return fromGuid;
  try {
    const jd = record.getJournalDetails?.();
    const d = jd?.date;
    if (d instanceof Date && !isNaN(d.getTime())) {
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const day = d.getDate();
      const yyyymmdd = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
      return { year, month, day, yyyymmdd };
    }
  } catch {}
  return null;
}

// Returns YYYY-MM-DD string
function dateStr(d) { return d.toISOString().slice(0, 10); }

// Date range presets — all return { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
function presets() {
  const now   = new Date();
  const y     = now.getFullYear();
  const m     = now.getMonth();

  const firstOfMonth = new Date(y, m, 1);
  const lastOfMonth  = new Date(y, m + 1, 0);
  const firstOfLastMonth = new Date(y, m - 1, 1);
  const lastOfLastMonth  = new Date(y, m, 0);
  const firstOfYear  = new Date(y, 0, 1);
  const firstOfLastYear  = new Date(y - 1, 0, 1);
  const lastOfLastYear   = new Date(y - 1, 11, 31);

  return [
    { label: 'This Month',  from: dateStr(firstOfMonth),    to: dateStr(lastOfMonth) },
    { label: 'Last Month',  from: dateStr(firstOfLastMonth), to: dateStr(lastOfLastMonth) },
    { label: 'YTD',         from: dateStr(firstOfYear),     to: dateStr(now) },
    { label: 'Last Year',   from: dateStr(firstOfLastYear), to: dateStr(lastOfLastYear) },
    { label: 'Last 90d',    from: dateStr(new Date(now - 90*864e5)), to: dateStr(now) },
    { label: 'All Time',    from: '2000-01-01',             to: dateStr(now) },
  ];
}

// Income filter — returns true if transaction should be counted as income.
// Uses the explicit payee include list if configured, else falls back to
// excluding payees that contain "transfer" or "starting".
function isIncomeTransaction(t, allTxns) {
  if (t.type !== 'income') return false;
  const raw = ls(SK.INCL_PAYEES);
  if (raw) {
    const incl = new Set(JSON.parse(raw));
    return incl.has(t.payee);
  }
  // Default: exclude transfer-like payees
  return !['transfer','starting'].some(kw => t.payee.toLowerCase().includes(kw));
}

// ─────────────────────────────────────────────────────────────────────────────
// CHART.JS LOADER
// ─────────────────────────────────────────────────────────────────────────────

let _chartLoad = null;
function loadChartJs() {
  if (window.Chart) return Promise.resolve();
  if (_chartLoad) return _chartLoad;
  _chartLoad = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = CHART_JS_URL; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
  return _chartLoad;
}

// ─────────────────────────────────────────────────────────────────────────────
// YNAB API
// ─────────────────────────────────────────────────────────────────────────────

async function ynabGet(path, token) {
  const r = await fetch(`https://api.ynab.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e?.error?.detail || `YNAB ${r.status}`);
  }
  return r.json();
}

async function apiFetchBudgets(token) {
  return (await ynabGet('/budgets', token)).data.budgets;
}

async function apiFetchTransactions(token, budgetId) {
  return (await ynabGet(`/budgets/${budgetId}/transactions`, token)).data.transactions;
}

async function apiFetchCategories(token, budgetId) {
  const d = await ynabGet(`/budgets/${budgetId}/categories`, token);
  return d.data.category_groups;
}

// Build a map of category_id → group_name from the categories endpoint
async function buildCategoryGroupMap(token, budgetId) {
  const ts = ls(SK.CACHE_CATS_TS);
  if (ts && Date.now() - parseInt(ts, 10) < CACHE_TTL_MS) {
    const cached = lsJson(SK.CACHE_CATS, null);
    if (cached) return cached;
  }
  const groups = await apiFetchCategories(token, budgetId);
  const map = {};
  for (const group of groups) {
    for (const cat of (group.categories || [])) {
      map[cat.id] = group.name;
    }
  }
  lsJsonSet(SK.CACHE_CATS, map);
  lsSet(SK.CACHE_CATS_TS, Date.now());
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSACTION PROCESSING  — transfers are DROPPED here, never synced
// ─────────────────────────────────────────────────────────────────────────────

function processTxns(raw, groupMap = {}) {
  const results = [];

  for (const t of raw) {
    if (t.deleted) continue;
    if (t.transfer_account_id) continue; // skip top-level transfers

    const isSplit = Array.isArray(t.subtransactions) && t.subtransactions.length > 0;

    if (isSplit) {
      // Expand each subtransaction into its own record.
      // The parent has the payee, date, account, cleared — subs have amount + category.
      for (const sub of t.subtransactions) {
        if (sub.deleted) continue;
        if (sub.transfer_account_id) continue; // skip transfer legs within splits

        results.push({
          id:             `${t.id}_${sub.id}`, // unique ID per sub-line
          date:           t.date,
          payee:          t.payee_name || '',
          amount:         sub.amount / 1000,
          category:       sub.category_name || 'Uncategorized',
          category_group: (sub.category_id && groupMap[sub.category_id]) || 'Uncategorized',
          memo:           sub.memo || t.memo || '',
          account:        t.account_name || '',
          cleared:        t.cleared,
          type:           sub.amount > 0 ? 'income' : 'expense',
          is_split:       true,
        });
      }
    } else {
      // Normal (non-split) transaction
      results.push({
        id:             t.id,
        date:           t.date,
        payee:          t.payee_name || '',
        amount:         t.amount / 1000,
        category:       t.category_name || 'Uncategorized',
        category_group: (t.category_id && groupMap[t.category_id]) || 'Uncategorized',
        memo:           t.memo || '',
        account:        t.account_name || '',
        cleared:        t.cleared,
        type:           t.amount > 0 ? 'income' : 'expense',
        is_split:       false,
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────────────────────────────────────────

function getCached() {
  const ts = ls(SK.CACHE_TS);
  if (!ts || Date.now() - parseInt(ts, 10) > CACHE_TTL_MS) return null;
  return lsJson(SK.CACHE_TXN, null);
}
function setCache(txns) { lsJsonSet(SK.CACHE_TXN, txns); lsSet(SK.CACHE_TS, Date.now()); }
function bustCache()    { lsSet(SK.CACHE_TS, '0'); }

async function getTransactions(force = false) {
  if (!force) { const c = getCached(); if (c) return c; }
  const token = ls(SK.TOKEN), budgetId = ls(SK.BUDGET_ID);
  if (!token || !budgetId) throw new Error('YNAB not configured');
  // Fetch both in parallel — categories for the group lookup map
  const [rawTxns, groupMap] = await Promise.all([
    apiFetchTransactions(token, budgetId),
    buildCategoryGroupMap(token, budgetId),
  ]);
  const txns = processTxns(rawTxns, groupMap);
  setCache(txns);
  return txns;
}

// ─────────────────────────────────────────────────────────────────────────────
// BUCKETING  (widget chart only)
// ─────────────────────────────────────────────────────────────────────────────

function bucketData(txns, refDate, period, compare, showAvg) {
  // txns is expected to already be filtered to income-only transactions
  const income = txns;
  let tipDates = null;
  let labels = [], cur = [], prev = null, curTotal = 0, prevTotal = null, avg = null;

  if (period === 'daily') {
    const N = 30;
    tipDates = [];
    for (let i = N - 1; i >= 0; i--) {
      const d = new Date(refDate); d.setDate(d.getDate() - i);
      const k = dateStr(d);
      labels.push(k.slice(5).replace('-', '.'));
      tipDates.push(k);
      cur.push(income.filter(t => t.date === k).reduce((a, t) => a + t.amount, 0));
    }
    curTotal = income.filter(t => t.date === dateStr(refDate)).reduce((a, t) => a + t.amount, 0);
    if (compare) {
      prev = [];
      for (let i = N - 1; i >= 0; i--) {
        const d = new Date(refDate); d.setDate(d.getDate() - i - N);
        prev.push(income.filter(t => t.date === dateStr(d)).reduce((a, t) => a + t.amount, 0));
      }
      const yd = new Date(refDate); yd.setDate(yd.getDate() - 1);
      prevTotal = income.filter(t => t.date === dateStr(yd)).reduce((a, t) => a + t.amount, 0);
    }
    if (showAvg) avg = cur.reduce((a, b) => a + b, 0) / cur.length;

  } else if (period === 'weekly') {
    const N = 12;
    const wkStart = d => { const dt = new Date(d); dt.setDate(dt.getDate() - dt.getDay()); dt.setHours(0,0,0,0); return dt; }; // Sunday start, matches Coda
    const ws = wkStart(refDate);
    tipDates = [];
    for (let i = N - 1; i >= 0; i--) {
      const s = new Date(ws); s.setDate(s.getDate() - i*7);
      const e = new Date(s);  e.setDate(e.getDate() + 6);
      const wkNum = (() => {
        const tmp = new Date(s); tmp.setHours(0,0,0,0);
        const jan1 = new Date(tmp.getFullYear(), 0, 1);
        return Math.ceil(((tmp - jan1) / 86400000 + jan1.getDay() + 1) / 7);
      })();
      const wkMMDD = dateStr(s).slice(5).replace('-', '.');
      labels.push(`w${String(wkNum).padStart(2,'0')} · ${wkMMDD}`);
      tipDates.push(dateStr(s));
      cur.push(income.filter(t => t.date >= dateStr(s) && t.date <= dateStr(e)).reduce((a,t)=>a+t.amount,0));
    }
    const wse = new Date(ws); wse.setDate(wse.getDate()+6);
    curTotal = income.filter(t => t.date >= dateStr(ws) && t.date <= dateStr(wse)).reduce((a,t)=>a+t.amount,0);
    if (compare) {
      // Overlay: each bar's comparison is the equivalent week 1 year ago
      // prevTotal: simply the week immediately before the current one
      const lastWS = new Date(ws); lastWS.setDate(lastWS.getDate() - 7);
      const lastWE = new Date(lastWS); lastWE.setDate(lastWE.getDate() + 6);
      prevTotal = income.filter(t => t.date >= dateStr(lastWS) && t.date <= dateStr(lastWE)).reduce((a,t)=>a+t.amount,0);
      // Overlay line: shift each displayed week back by exactly 1 week
      prev = [];
      for (let i = N - 1; i >= 0; i--) {
        const s = new Date(ws); s.setDate(s.getDate() - i*7 - 7);
        const e = new Date(s);  e.setDate(e.getDate()+6);
        prev.push(income.filter(t => t.date >= dateStr(s) && t.date <= dateStr(e)).reduce((a,t)=>a+t.amount,0));
      }
    }
    if (showAvg) { const nz = cur.filter(v=>v>0); avg = nz.length ? nz.reduce((a,b)=>a+b,0)/nz.length : 0; }

  } else { // monthly
    const N = 12;
    for (let i = N - 1; i >= 0; i--) {
      const d  = new Date(refDate.getFullYear(), refDate.getMonth()-i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      labels.push(d.toLocaleString('default',{month:'short',year:'2-digit'}));
      cur.push(income.filter(t=>t.date.startsWith(key)).reduce((a,t)=>a+t.amount,0));
    }
    const ck = `${refDate.getFullYear()}-${String(refDate.getMonth()+1).padStart(2,'0')}`;
    curTotal = income.filter(t=>t.date.startsWith(ck)).reduce((a,t)=>a+t.amount,0);
    if (compare) {
      const pd = new Date(refDate.getFullYear(), refDate.getMonth()-N, 1);
      prev = [];
      for (let i = 0; i < N; i++) {
        const d = new Date(pd.getFullYear(), pd.getMonth()+i, 1);
        const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
        prev.push(income.filter(t=>t.date.startsWith(k)).reduce((a,t)=>a+t.amount,0));
      }
      prevTotal = prev[prev.length-1] ?? 0;
    }
    if (showAvg) { const nz = cur.filter(v=>v>0); avg = nz.length ? nz.reduce((a,b)=>a+b,0)/nz.length : 0; }
  }

  return { labels, cur, prev, curTotal, prevTotal, avg, tipDates };
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS (YNAB journal widget for Header Suite)
// ─────────────────────────────────────────────────────────────────────────────

const JHS_YNAB_WIDGET_CSS = `
  /* YNAB journal income widget — scoped to Journal Header Suite (no outer card chrome) */
  .jhs-shell .jhs-body .ynab-widget {
    background: transparent !important;
    border: none !important;
    margin: 0 !important;
    padding: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
  }
  /* (inner widget chrome) */
  .ynab-widget {
    background-color: ${C.cardBg};
    border: 1px solid ${C.cardBorder};
    border-radius: 10px;
    padding: 10px 16px 10px;
    margin: 0;
    width: 100%;
    font-size: 13px;
    color: ${C.text};
  }
  .ynab-widget-header {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
  }
  .ynab-w-toggle {
    font-size: 13px;
    color: ${C.statLabel};
    cursor: pointer;
    padding: 0 3px;
    flex-shrink: 0;
    background: none;
    border: none;
    line-height: 1;
  }
  .ynab-w-title {
    font-weight: 600;
    font-size: 13px;
    flex-shrink: 0;
  }
  .ynab-w-controls {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
    margin-left: auto;
  }
  .ynab-tgroup {
    display: flex;
    gap: 2px;
    background: rgba(255,255,255,0.05);
    border-radius: 6px;
    padding: 2px;
  }
  .ynab-tbtn {
    background: transparent;
    border: none;
    color: ${C.statLabel};
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.12s;
    line-height: 1.4;
  }
  .ynab-tbtn:hover { color: ${C.text}; background: rgba(255,255,255,0.07); }
  .ynab-tbtn.active {
    background: rgba(${C.greenRgb}, 0.25);
    color: #3d8f58;
    font-weight: 600;
  }

  .ynab-widget-body { margin-top: 10px; }

  /* Filter chips in widget */
  .ynab-w-filter-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 14px;
    align-items: center;
  }
  .ynab-w-filter-label {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: ${C.statLabel};
    flex-shrink: 0;
    margin-right: 2px;
  }
  .ynab-w-chip {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 10px;
    border: 1px solid rgba(${C.greenRgb}, 0.35);
    background: rgba(${C.greenRgb}, 0.14);
    color: #3d8f58;
    cursor: pointer;
    transition: all 0.12s;
    line-height: 1.5;
  }
  .ynab-w-chip:hover { background: rgba(${C.greenRgb}, 0.22); }
  .ynab-w-chip.off {
    background: rgba(255,255,255,0.04);
    border-color: rgba(255,255,255,0.09);
    color: ${C.statLabel};
    text-decoration: line-through;
  }

  .ynab-stat-row {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 10px;
    align-items: baseline;
  }
  .ynab-stat-chip {
    background: transparent;
    border-radius: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .ynab-stat-chip.pos .ynab-sv { color: #3d8f58; }
  .ynab-stat-chip.neg .ynab-sv { color: #b84040; }
  .ynab-sl {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: ${C.statLabel};
    opacity: 0.92;
  }
  .ynab-sv {
    font-size: 13px;
    font-weight: 500;
    color: ${C.text};
    opacity: 0.88;
    font-variant-numeric: tabular-nums;
  }

  .ynab-canvas-wrap { position: relative; height: 140px; margin-bottom: 5px; }
  .ynab-status { font-size: 10px; color: ${C.statLabel}; text-align: right; font-style: italic; }
  .ynab-notice { font-size: 12px; color: ${C.statLabel}; padding: 6px 0; font-style: italic; }
  .ynab-cfg-link { color: #3d8f58; text-decoration: none; }
  .ynab-cfg-link:hover { text-decoration: underline; }

  .ynab-gear-btn {
    background: rgba(255,255,255,0.035); border: 1px solid rgba(255,255,255,0.07);
    border-radius: 5px; color: #8a7e6a; font-size: 11px; padding: 2px 8px;
    cursor: pointer; transition: all 0.12s; white-space: nowrap; line-height: 1.5;
  }
  .ynab-gear-btn:hover { background: rgba(255,255,255,0.07); color: #d7cfbf; }
  .ynab-filter-summary { font-size: 10px; color: rgba(110, 100, 88, 0.82); font-style: italic; padding: 2px 0; }

  /* Header control row: minimalist, text-led active state */
  .jhs-ynab-controls .ynab-tgroup {
    background: transparent;
    border-radius: 0;
    padding: 0;
    gap: 10px;
  }
  .jhs-ynab-controls .ynab-tgroup + .ynab-tgroup {
    margin-left: 4px;
    padding-left: 14px;
    border-left: 1px solid rgba(255,255,255,0.075);
  }
  .jhs-ynab-controls .ynab-tbtn {
    padding: 1px 0;
    border-radius: 0;
    background: transparent;
    color: rgba(232, 224, 208, 0.5);
    font-size: 11px;
    letter-spacing: 0.015em;
  }
  .jhs-ynab-controls .ynab-tbtn:hover {
    background: transparent;
    color: rgba(232, 224, 208, 0.86);
  }
  .jhs-ynab-controls .ynab-tbtn.active {
    background: transparent;
    color: #3d8f58;
    font-weight: 600;
  }
`;


const JHS_KEY = 'jhs_config_v1';
/** Full habit config (categories + habits) mirrored in localStorage on each save — survives plugin reload; export for off-site backup. */
const HT_HABIT_CONFIG_BACKUP_KEY = 'jhs_habit_config_backup_v1';
/** Same order of magnitude as Journal Footer Suite `TN_PANEL_DEBOUNCE_MS` — coalesces navigated+focused bursts. */
const JHS_PANEL_DEBOUNCE_MS = 350;
/** First paint after load: run after footer suite’s initial `100ms + debounce` wave so the journal shell is not competing with Today’s Notes / Highlights mount. */
const JHS_INITIAL_MOUNT_DELAY_MS = 480;
/** Per-collection / default visibility for the suite shell (Backreferences-style; default = visible everywhere). */
const JHS_VISIBILITY_KEY = 'journal_header_suite_visibility_v1';
const JHS_DEFAULTS = {
  activeTab: 'ynab',
  enabled: { ynab: true, habit: true, gallery: true },
  collapsed: false,
  /** When true, image grid mounts in a detached host below the suite shell (works on YNAB / Habits tabs). */
  galleryDockExpanded: false,
};

const JHS_TABS = [
  { id: 'ynab', label: 'YNAB', icon: 'ti-coin' },
  { id: 'habit', label: 'Habits', icon: 'ti-flame' },
  { id: 'gallery', label: 'Gallery', icon: 'ti-photo' },
];

/** Journal habit list + Manage Habits category cards: single-column when `'1'` (always stored in localStorage). */
const HT_HABIT_LAYOUT_SINGLE_COLUMN_KEY = 'ht_settings_habit_board_single_column';

/** Opt-in habits pipeline logs. In devtools: `localStorage.setItem('thymerext_debug_ht_habits','1'); location.reload()` — filter `[JHS/Habits]`. */
function htHabitsDbg(payload) {
  try {
    const o = localStorage.getItem('thymerext_debug_ht_habits');
    if (o !== '1' && o !== 'true' && o !== 'on') return;
  } catch (_) {
    return;
  }
  try {
    const row = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload : { msg: payload };
    console.info('[JHS/Habits]', row);
  } catch (_) {}
}

/** Opt-in gallery dock pipeline logs. Devtools: `localStorage.setItem('thymerext_debug_jhs_gallery_dock','1'); location.reload()` — filter `[JHS/GalleryDock]`. */
function jhsGalleryDockDbg(payload) {
  try {
    const o = localStorage.getItem('thymerext_debug_jhs_gallery_dock');
    if (o !== '1' && o !== 'true' && o !== 'on') return;
  } catch (_) {
    return;
  }
  try {
    const row = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload : { msg: payload };
    console.info('[JHS/GalleryDock]', row);
  } catch (_) {}
}

// ═══ Habit Tracker (ThymerHabitTracker port — plugin_id habit-tracker; config+log live in dedicated "Habit Logs" collection) ═══
const HT_PS_SLUG = 'habit-tracker';
const HT_PS_ROW_CONFIG = 'habit-tracker:config';
const HT_PS_MIGRATE_KEY = 'ht_global_ps_migration_v1';
const HT_LOG_ROWS_CACHE_TTL_MS = 4000;
/** When auto-rebuilding habits from log `completions`, only ids last seen within this window, and cap count (stale ids / old plugins would otherwise create dozens of ghosts). */
const HT_RECOVER_LOG_LOOKBACK_DAYS = 210;
const HT_RECOVER_MAX_HABITS = 24;
const HT_RECOVER_HABIT_ID_KEY_RE = /^[a-z0-9]{6,14}$/i;
function htPsRowLog(dateStr) {
  return `${HT_PS_SLUG}:log:${dateStr}`;
}

// ─── CSS ─────────────────────────────────────────────────────────────────────
const HT_CSS = `
  @import url('https://cdn.jsdelivr.net/npm/tabler-icons@latest/tabler-icons.css');

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
  /* Date nav + header controls: readable on dark backgrounds (avoid near-invisible “next” on Today). */
  .ht-sidebar-header > .ht-nav-btn {
    color: rgba(232, 224, 208, 0.82);
  }
  .ht-sidebar-header > .ht-nav-btn:hover {
    color: #e8e0d0;
  }
  .ht-sidebar-header .ht-nav-btn.ht-nav-btn-muted {
    pointer-events: none;
    opacity: 1;
    color: rgba(232, 224, 208, 0.52);
  }
  .ht-nav-btn.active {
    color: #c4b8ff;
    background: rgba(124, 106, 247, 0.14);
  }
  .ht-ribbon-toggle.active {
    color: #c4b8ff;
    background: rgba(124, 106, 247, 0.14);
  }
  .ht-sidebar-title {
    font-weight: 700;
    font-size: 13px;
    color: #e8e0d0;
    white-space: nowrap;
    flex: 1;
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .ht-sidebar .ti,
  .ht-stats-view .ti,
  .ht-modal .ti,
  .ht-importer-overlay .ti {
    font-size: 1.1em;
    vertical-align: -0.12em;
    line-height: 1;
    flex-shrink: 0;
  }
  .ht-empty-icon .ti { font-size: 28px; opacity: 0.85; vertical-align: middle; }
  .ht-stats-btn .ti,
  .ht-nav-btn .ti { font-size: 17px; }
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
  .ht-toggle-btn .ti { font-size: 15px; }
  .ht-category-caret .ti { font-size: 9px; color: #8a7e6a; }
  .ht-category-status .ti { font-size: 13px; }
  .ht-category-streak .ti { font-size: 11px; opacity: 0.88; }
  .ht-habit-check .ti { font-size: 14px; color: rgba(130, 188, 156, 0.88); }
  .ht-habit-ring-label .ti { font-size: 13px; display: block; margin-top: 1px; }
  .ht-modal-close .ti { font-size: 16px; }
  .ht-modal-title .ti { font-size: 17px; vertical-align: -0.18em; margin-right: 2px; }
  .ht-btn .ti { font-size: 14px; margin-right: 0.25em; vertical-align: -0.18em; }
  .ht-item-sub .ti { font-size: 10px; vertical-align: -0.12em; opacity: 0.95; }
  .ht-modal-body .ti { vertical-align: middle; }
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
    border-radius: 2px;
    transition: width 0.35s ease, background 0.35s ease;
    /* Inline style sets gradient from htCategoryProgressFillStyle */
    background: rgba(72, 150, 112, 0.55);
  }

  /* ── Day notes (under habit list) ── */
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
  .ht-notes-input::placeholder {
    color: rgba(138, 126, 106, 0.75);
  }
  .ht-notes-input:focus {
    outline: none;
    border-color: rgba(124, 106, 247, 0.45);
    background: rgba(0, 0, 0, 0.32);
  }

  /* ── Category block ── */
  .ht-category {
    margin: 0 0 16px 0;
  }
  .ht-category-header {
    display: block;
    padding: 5px 10px;
    cursor: pointer;
    border-radius: 5px;
    margin: 0 4px;
    user-select: none;
    transition: background 0.1s;
  }
  .ht-category-header:hover { background: rgba(255,255,255,0.06); }
  .ht-category-header-inner {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: flex-start;
    flex-wrap: wrap;
    width: 100%;
    gap: 6px;
    min-height: 20px;
  }
  .ht-ch-lead-spacer {
    display: none;
  }
  .ht-ch-cat-done-wrap {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    margin-right: 0;
    padding-right: 1px;
    min-width: 14px;
    min-height: 16px;
  }
  .ht-ch-cat-marked {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: 3px;
    width: 6px;
    height: 16px;
    flex-shrink: 0;
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
  .ht-cat-inline-na,
  .ht-cat-inline-fail {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }
  /* Category N/A: short vertical bar (collapsed + expanded headers). */
  .ht-cat-na-bar {
    display: inline-block;
    width: 2px;
    height: 12px;
    border-radius: 1px;
    background: linear-gradient(
      180deg,
      rgba(218, 185, 110, 0.95),
      rgba(168, 132, 58, 0.82)
    );
    box-shadow: 0 0 5px rgba(200, 165, 72, 0.2);
    vertical-align: middle;
  }
  .ht-ch-cat-done-wrap .ht-cat-na-bar {
    height: 12px;
  }
  .ht-cat-inline-check {
    display: inline-flex;
    align-items: center;
    line-height: 1;
    color: #5ad389;
  }
  .ht-cat-inline-check .ti {
    font-size: 12px;
    opacity: 0.92;
  }
  /* Category: every habit done today — double-check + sherbet shimmer (matches year-tier streak styling) */
  .ht-cat-inline-check--all-done {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    animation: ht-cat-all-done-sparkle 2.8s ease-in-out infinite;
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
    background-size: 320px 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    -webkit-text-fill-color: transparent;
    animation: ht-streak-sherbet-flow 11s linear infinite;
  }
  @keyframes ht-cat-all-done-sparkle {
    0%, 100% { filter: drop-shadow(0 0 1px rgba(255, 210, 140, 0.35)); }
    50% { filter: drop-shadow(0 0 7px rgba(255, 185, 100, 0.65)); }
  }
  .ht-ch-cluster .ht-category-streak {
    margin-left: 3px;
    flex-shrink: 0;
  }
  .ht-ch-cluster {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    justify-content: flex-start;
    flex: 0 1 auto;
    max-width: 100%;
    min-width: 0;
  }
  .ht-ch-trailing {
    display: none;
  }
  .ht-category-caret {
    font-size: 8px;
    color: #8a7e6a;
    width: 10px;
    flex-shrink: 0;
    transition: transform 0.15s, opacity 0.15s;
  }
  @media (hover: hover) {
    .ht-category-header .ht-category-caret {
      opacity: 0;
    }
    .ht-category-header:hover .ht-category-caret,
    .ht-category-header:focus-within .ht-category-caret {
      opacity: 1;
    }
  }
  @media (hover: none) {
    .ht-category-caret {
      opacity: 0.42;
    }
  }
  .ht-category-caret.open { transform: rotate(90deg); }
  .ht-category-emoji { font-size: 13px; line-height: 1; flex-shrink: 0; }
  .ht-category-name {
    font-weight: 600;
    font-size: 12px;
    color: #e8e0d0;
    min-width: 0;
    letter-spacing: 0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ht-category-header-tag .ht-category-name {
    padding-left: 0;
  }
  .ht-tag-sec-glyph {
    display: inline-flex;
    align-items: center;
    opacity: 0.78;
    color: rgba(200, 190, 175, 0.95);
  }
  .ht-tag-sec-glyph .ti {
    font-size: 13px;
  }
  .ht-cat-done { color: #4caf50; font-size: 11px; }
  .ht-cat-pending { color: rgba(255,255,255,0.2); font-size: 11px; }
  .ht-category-streak {
    font-size: 10px;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    letter-spacing: 0.02em;
    font-weight: 600;
  }
  .ht-category-streak .ti {
    color: currentColor;
    opacity: 0.95;
  }
  .ht-category-streak .ht-streak-day-count {
    font-weight: 700;
  }
  .ht-category-habits {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px 10px;
    padding: 6px 10px 12px 14px;
    align-items: start;
  }
  .ht-sidebar-body.ht-habit-layout-single-col .ht-category-habits {
    grid-template-columns: minmax(0, 1fr);
  }
  .ht-category-habits.ht-hidden { display: none; }

  /* Gallery-style expanded section header (ribbon mode) — title cluster left-aligned */
  .ht-category-header--gallery {
    padding: 7px 10px;
  }
  .ht-category-header--gallery .ht-category-name--gallery {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: rgba(138, 126, 106, 0.95);
  }
  .ht-category-header--gallery .ht-category-header-inner {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: flex-start;
    flex-wrap: wrap;
    width: 100%;
    gap: 6px;
    min-height: 20px;
  }
  .ht-category-header--gallery .ht-ch-cluster {
    justify-content: flex-start;
    max-width: 100%;
    min-width: 0;
    flex-wrap: wrap;
    row-gap: 6px;
    column-gap: 6px;
  }
  .ht-category-streak--noflame {
    gap: 0;
  }

  /* Header row + optional section ribbon (gallery-like collapsed sources) */
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
    padding: 12px 2px 8px;
    margin: 6px 0 0 0;
    border-top: none;
    min-height: 22px;
    box-sizing: border-box;
  }
  .ht-habit-section-ribbon[hidden] { display: none !important; }
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
  /* Fixed col1+col2 keeps icons in a straight column; max-content col3 hugs streak to icon (no 1fr gap). */
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
  .ht-ribbon-sec-lead .ht-cat-inline-check .ti {
    font-size: 11px;
  }
  .ht-ribbon-sec-lead .ht-cat-inline-check--all-done .ti {
    font-size: 11px;
  }
  .ht-ribbon-sec-lead .ht-cat-na-bar {
    height: 10px;
    width: 2px;
  }
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
    padding-left: 0;
    margin-left: 0;
  }
  .ht-ribbon-sec:hover {
    background: transparent;
    color: #e8e0d0;
    border-bottom-color: rgba(255, 183, 77, 0.35);
  }
  .ht-ribbon-sec-glyph {
    font-size: 13px;
    line-height: 1;
    flex-shrink: 0;
  }
  .ht-ribbon-sec-done {
    flex-shrink: 0;
  }
  .ht-ribbon-sec-done.ht-cat-inline-check {
    background: none;
    border: none;
    padding: 0;
    box-shadow: none;
  }
  .ht-ribbon-sec .ht-ribbon-sec-done .ti {
    font-size: 11px;
  }
  /* Keeps grid cell when section is expanded (icon/check/streak hidden but slot reserved). */
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
  .ht-ribbon-sec-streak .ht-streak-day-count {
    font-size: 9px;
    font-weight: 700;
  }
  .ht-ribbon-toggle .ti { font-size: 16px; }
  .ht-nav-btn.ht-manage-toggle.active {
    background: rgba(124, 106, 247, 0.22);
    border-color: rgba(124, 106, 247, 0.45);
  }
  .ht-sidebar-body.ht-manage-mode .ht-progress { display: none !important; }
  .ht-sidebar-body.ht-manage-mode .ht-habit {
    cursor: default;
  }
  .ht-sidebar-body.ht-manage-mode .ht-habit:hover {
    background: rgba(255,255,255,0.03);
    border-color: rgba(255,255,255,0.04);
  }
  .ht-habit-manage-strip {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    padding: 6px 8px;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.07);
  }
  .ht-habit-manage-strip .ht-input {
    height: 24px;
    font-size: 11px;
    padding: 2px 6px;
  }
  .ht-habit-manage-name { flex: 2 1 140px; min-width: 0; }
  .ht-habit-manage-cat { flex: 1 1 100px; min-width: 0; }
  .ht-habit-manage-advanced {
    flex: 1 0 100%;
    margin-top: 4px;
    font-size: 11px;
    color: #a09888;
  }
  .ht-habit-manage-advanced summary {
    cursor: pointer;
    color: #8a7e6a;
    user-select: none;
  }
  .ht-habit-manage-advanced-inner {
    margin-top: 6px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .ht-manage-cats-bar {
    width: 100%;
    padding: 8px 10px;
    margin-bottom: 8px;
    border-radius: 10px;
    background: rgba(124, 106, 247, 0.08);
    border: 1px solid rgba(124, 106, 247, 0.2);
  }
  .ht-manage-cats-title {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: rgba(180, 168, 220, 0.95);
    margin-bottom: 6px;
  }
  .ht-manage-cat-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
    flex-wrap: wrap;
  }
  .ht-manage-cat-row .ht-input {
    height: 24px;
    font-size: 11px;
    flex: 1 1 160px;
    min-width: 0;
  }
  .ht-manage-tags-bar {
    margin-top: 10px;
  }
  .ht-habit-manage-row-top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    width: 100%;
    flex: 1 0 100%;
  }
  .ht-manage-tags-multiselect {
    width: 100%;
    min-height: 72px;
    font-size: 11px;
    padding: 4px 6px;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(0, 0, 0, 0.25);
    color: #e8e0d0;
  }
  .ht-manage-tags-add {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    margin-top: 2px;
  }
  .ht-manage-tags-add .ht-input {
    flex: 1 1 140px;
    min-width: 0;
  }
  .ht-habit-manage-tags-details {
    width: 100%;
    flex: 1 0 100%;
    margin-top: 4px;
  }
  .ht-habit-manage-tags-details > summary {
    cursor: pointer;
    color: #8a7e6a;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    user-select: none;
  }
  .ht-habit-manage-tags-inner {
    padding-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ht-ribbon-sec-streak .ht-streak-legend-inner {
    font-size: 9px;
  }
  .ht-category-streak.ht-streak-legend .ht-streak-legend-inner {
    font-size: 10px;
  }

  /* ── Habit card (TickTick-inspired grid); faint orbit aligns with name row ── */
  .ht-habit {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
    padding: 8px 8px 9px;
    margin: 0;
    border-radius: 10px;
    border: 1px solid transparent;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }
  .ht-habit:hover {
    background: rgba(255,255,255,0.06);
    border-color: rgba(255,255,255,0.06);
  }
  .ht-habit-top {
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    gap: 8px;
    min-width: 0;
  }
  .ht-habit-orbit {
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
  }
  .ht-habit.ht-done .ht-habit-orbit {
    background: transparent;
    border-color: rgba(255,255,255,0.12);
  }
  .ht-habit-name-col {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding-top: 0;
  }
  .ht-habit-cat-above {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: rgba(180, 172, 158, 0.52);
    font-weight: 500;
    letter-spacing: 0.02em;
    max-width: 100%;
  }
  .ht-habit-cat-above-glyph {
    opacity: 0.68;
    font-size: 12px;
    line-height: 1;
    flex-shrink: 0;
  }
  .ht-habit-cat-above-txt {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .ht-habit-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 0;
  }
  .ht-habit-line-name {
    min-width: 0;
    display: block;
  }
  .ht-habit-line-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 18px;
    /* Skip leading emoji so streak/stats line up with the text after it */
    padding-left: 1.2em;
    margin-top: 0;
    box-sizing: border-box;
    width: 100%;
  }
  .ht-habit-streak-cluster {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    justify-content: center;
  }
  .ht-habit-streak-cluster-empty {
    min-height: 0;
  }
  .ht-habit-streak-meter-wrap {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 5px;
    max-width: 124px;
    flex-shrink: 0;
  }
  .ht-habit-streak-meter-wrap .ht-habit-streak-meter {
    flex: 1;
    min-width: 0;
    max-width: none;
  }
  .ht-year-tier {
    font-size: 9px;
    font-weight: 700;
    flex-shrink: 0;
    line-height: 1;
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
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    -webkit-text-fill-color: transparent;
    animation: ht-streak-sherbet-flow 11s linear infinite;
  }
  .ht-year-boundary {
    font-size: 10px;
    color: rgba(255, 165, 112, 0.9);
    flex-shrink: 0;
    line-height: 1;
  }
  .ht-habit-streak-meter {
    height: 2px;
    max-width: 104px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.04);
    overflow: hidden;
  }
  .ht-habit-streak-meter-fill {
    display: block;
    height: 100%;
    border-radius: 2px;
    width: 0%;
    background: rgba(150, 158, 178, 0.4);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12);
    transition: width 0.45s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .ht-habit-streak-meter-fill--legend {
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14);
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
  .ht-habit.ht-done .ht-habit-streak-meter-fill:not(.ht-habit-streak-meter-fill--legend) {
    filter: brightness(0.88) saturate(0.92);
    opacity: 0.82;
  }
  .ht-habit.ht-done .ht-habit-streak-meter-fill--legend {
    opacity: 0.92;
  }
  .ht-streak-day-count {
    color: inherit;
    font-weight: 700;
    letter-spacing: 0.03em;
  }
  /* One full tile = 320px; shift by exactly one period so the loop has no seam/jump. */
  @keyframes ht-streak-sherbet-flow {
    0% { background-position: 0 0; }
    100% { background-position: 320px 0; }
  }
  .ht-streak-legend-inner {
    display: inline-flex;
    align-items: baseline;
    gap: 1px;
    font-weight: 700;
    letter-spacing: 0.03em;
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
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    -webkit-text-fill-color: transparent;
    animation: ht-streak-sherbet-flow 11s linear infinite;
  }
  .ht-streak-legend-flame {
    color: #ffb86c !important;
    -webkit-text-fill-color: #ffb86c !important;
    opacity: 0.92;
    vertical-align: -0.12em;
  }
  .ht-category-streak .ht-streak-legend-flame,
  .ht-ribbon-sec-streak .ht-streak-legend-flame {
    font-size: 1em;
  }
  .ht-habit-streak-core {
    display: inline-flex;
    align-items: baseline;
    gap: 1px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .ht-habit-streak-core.ht-streak-legend {
    gap: 3px;
  }
  .ht-habit-streak-core .ti {
    color: currentColor;
    vertical-align: -0.12em;
    opacity: 0.96;
  }
  .ht-habit-stat-counts {
    font-weight: 500;
    color: rgba(180, 170, 155, 0.78);
  }
  .ht-streak-dotsep {
    opacity: 0.35;
    font-weight: 400;
  }
  .ht-roll-num {
    font-size: 10px;
    font-weight: 600;
    color: rgba(200, 190, 175, 0.58);
    letter-spacing: 0.02em;
  }
  .ht-roll-suffix {
    font-size: 8px;
    font-weight: 500;
    opacity: 0.4;
    margin-left: 1px;
    letter-spacing: 0.05em;
  }
  .ht-roll-sep {
    opacity: 0.26;
    margin: 0 5px;
    font-weight: 400;
    font-size: 10px;
  }
  .ht-habit-mark {
    font-size: 15px;
    font-weight: 600;
    line-height: 1;
    font-family: ui-sans-serif, system-ui, sans-serif;
    user-select: none;
  }
  .ht-habit-mark-na {
    color: rgba(200, 165, 72, 0.72);
    transform: rotate(-12deg);
    display: inline-block;
  }
  .ht-habit-mark-fail {
    color: rgba(142, 72, 72, 0.82);
  }
  .ht-habit-check-minimal {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    min-height: 22px;
    border: none;
    background: transparent;
    border-radius: 4px;
    transition: color 0.12s, opacity 0.12s;
  }
  .ht-habit-check-minimal .ht-check-glyph {
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }
  .ht-habit-check-minimal .ht-check-glyph .ti {
    font-size: 17px;
  }
  .ht-check-faint {
    opacity: 0 !important;
    transition: opacity 0.12s ease;
  }
  @media (hover: hover) and (pointer: fine) {
    .ht-habit:not(.ht-done):not(.ht-na):not(.ht-fail):hover .ht-check-faint {
      opacity: 0.38 !important;
    }
  }
  @media (hover: none) {
    .ht-habit:not(.ht-done):not(.ht-na):not(.ht-fail) .ht-check-faint {
      opacity: 0.22 !important;
    }
  }
  .ht-habit.ht-done .ht-habit-check-minimal {
    color: rgba(130, 188, 156, 0.92);
  }
  .ht-habit.ht-done .ht-habit-check-minimal .ti {
    color: rgba(130, 188, 156, 0.92);
  }
  .ht-habit-check {
    width: 18px;
    height: 18px;
    border: 1.5px solid rgba(255,255,255,0.22);
    border-radius: 6px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
    font-size: 10px;
    color: transparent;
  }
  .ht-habit.ht-done .ht-habit-check {
    background: linear-gradient(160deg, #41d6a8, #2bbd8e);
    border-color: rgba(46, 189, 142, 0.95);
    color: #0d1f18;
    box-shadow: 0 1px 4px rgba(0,0,0,0.25);
  }
  .ht-habit-name {
    flex: 1;
    color: #e8e0d0;
    font-size: 13px;
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
    font-size: 11px;
    color: rgba(180, 170, 155, 0.78);
    white-space: normal;
    line-height: 1.3;
  }
  .ht-habit-streak .ht-habit-streak-core {
    font-size: 12px;
  }
  .ht-habit-streak .ht-habit-streak-core .ht-streak-day-count {
    font-size: 12px;
  }
  .ht-habit-streak.hot { color: rgba(255, 183, 77, 0.95); }

  .ht-habit-offday { opacity: 0.72; }
  .ht-habit-offday .ht-habit-name { color: #a09888; }
  .ht-habit-na-mark {
    font-size: 10px;
    color: #6d665c;
    font-weight: 600;
    letter-spacing: 0.04em;
  }
  .ht-habit.ht-fail .ht-habit-check {
    border-color: rgba(244, 67, 54, 0.45);
    color: #e57373;
    background: rgba(244, 67, 54, 0.08);
  }
  .ht-habit.ht-na .ht-habit-check {
    border-color: rgba(255, 255, 255, 0.12);
    background: transparent;
  }

  .ht-habit-stats-link {
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
  @media (hover: hover) and (pointer: fine) {
    .ht-habit-stats-link {
      opacity: 0;
      pointer-events: none;
    }
    .ht-habit:hover .ht-habit-stats-link {
      opacity: 0.55;
      pointer-events: auto;
    }
  }
  .ht-habit .ht-habit-stats-link:hover {
    opacity: 1;
    color: #e8e0d0;
    background: rgba(255,255,255,0.08);
  }

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
  .ht-item-emoji {
    font-size: 15px;
    width: 24px;
    min-width: 24px;
    text-align: center;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .ht-item-emoji .ti { font-size: 16px; }
  .ht-item-left { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .ht-item-name { font-size: 13px; color: #e8e0d0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ht-item-sub { font-size: 11px; color: #8a7e6a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ht-item-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .ht-add-row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; align-items: center; }
  .ht-icon-select {
    flex: 0 0 auto;
    min-width: 148px;
    max-width: 200px;
    padding: 5px 8px;
    font-size: 12px;
  }
  .ht-cat-glyph-inline { display: inline-flex; align-items: center; vertical-align: middle; margin-right: 4px; }
  .ht-cat-glyph-inline .ti { font-size: 1em; }
  .ht-category-emoji .ti { font-size: 14px; }
  .ht-emoji-inline { font-size: 1.1em; line-height: 1; }
  .ht-icon-preview {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 26px;
    flex-shrink: 0;
    color: #c4a882;
  }
  .ht-icon-preview .ti { font-size: 18px; }
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
    width: 26px;
    height: 26px;
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
    font-size: 8px;
    font-weight: 700;
    color: #e8e0d0;
    line-height: 1;
  }
  .ht-habit.ht-done .ht-habit-ring-fill { stroke: rgba(124, 168, 142, 0.88); }
  .ht-habit.ht-done .ht-habit-ring-label { color: rgba(124, 168, 142, 0.92); }

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
  .ht-num-fail-btn {
    font-size: 15px;
    font-weight: 700;
    color: rgba(255, 120, 120, 0.95);
    border-color: rgba(255, 120, 120, 0.35);
    width: 22px;
    height: 22px;
  }
  .ht-num-fail-btn:hover { background: rgba(255, 120, 120, 0.12); }
  .ht-num-na-btn .ht-cat-na-bar {
    height: 11px;
    width: 3px;
  }
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
  .ht-cal-strip-circle.ht-cal-na {
    background: rgba(255,255,255,0.04); border-style: dashed; color: #6d665c; font-size: 9px;
  }
  .ht-cal-strip-circle.ht-cal-fail {
    background: rgba(244,67,54,0.12); border-color: rgba(244,67,54,0.45); color: #e57373;
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
  .ht-cal-day.ht-cal-na {
    background: rgba(255,255,255,0.03); border: 1px dashed rgba(255,255,255,0.12);
  }
  .ht-cal-day.ht-cal-na .ht-cal-day-dot { background: transparent; border: 1px dashed rgba(255,255,255,0.15); }
  .ht-cal-day.ht-cal-fail {
    background: rgba(244,67,54,0.12); border: 1.5px solid rgba(244,67,54,0.35);
  }
  .ht-cal-day.ht-cal-fail .ht-cal-day-dot { background: #e57373; }
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
    background: rgba(124,106,247,0.22); min-height: 2px;
    transition: height 0.3s ease;
  }
  .ht-bar.done { background: rgba(76,175,80,0.38); }
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
    background: rgba(255,200,0,0.22); pointer-events: none;
  }
  .ht-target-label {
    position: absolute; right: -28px; font-size: 8px; color: rgba(255,200,0,0.55);
    line-height: 1; text-align: left;
    transform: translateY(-1px);
  }

  /* Category rate */
  .ht-cat-rate-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .ht-cat-rate-name { font-size: 12px; color: #e8e0d0; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ht-cat-rate-bar-wrap { width: 80px; height: 5px; background: rgba(255,255,255,0.04); border-radius: 3px; flex-shrink: 0; overflow: hidden; }
  .ht-cat-rate-bar { height: 100%; border-radius: 3px; background: rgba(76,175,80,0.45); transition: width 0.3s; }
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

  /* HabitTracker settings modal — drag reorder drop line */
  .ht-settings-habit-list {
    position: relative;
    transition: background 0.12s, border-color 0.12s, box-shadow 0.12s;
  }
  .ht-settings-habit-list.ht-settings-list-hover {
    background: rgba(124, 106, 247, 0.06);
    border-color: rgba(124, 106, 247, 0.28) !important;
  }
  .ht-settings-habit-list.ht-settings-list-drop-empty {
    box-shadow: inset 0 0 0 2px rgba(124, 106, 247, 0.55);
    background: rgba(124, 106, 247, 0.1);
  }
  .ht-settings-habit-row.ht-settings-drop-before {
    box-shadow: inset 0 3px 0 0 rgba(124, 106, 247, 0.92);
  }
  .ht-settings-habit-row.ht-settings-drop-after {
    box-shadow: inset 0 -3px 0 0 rgba(124, 106, 247, 0.92);
  }

  /* Inline manage — habit strip drag */
  .ht-habit-manage-drag-grip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0.7;
    cursor: grab;
    touch-action: none;
    flex-shrink: 0;
    margin-right: 2px;
    user-select: none;
  }
  .ht-habit-manage-drag-grip:active { cursor: grabbing; }
  .ht-habit.ht-manage-habit-dragging {
    opacity: 0.42;
    outline: 1px dashed rgba(124, 106, 247, 0.45);
    border-radius: 8px;
  }
  .ht-category-roll {
    margin-left: 4px;
    flex-shrink: 0;
    font-size: 10px;
  }
  .ht-category-habits.ht-manage-dnd-target {
    position: relative;
    transition: background 0.12s, border-color 0.12s, box-shadow 0.12s;
  }
  .ht-category-habits.ht-manage-dnd-target.ht-manage-dnd-hover {
    background: rgba(124, 106, 247, 0.06);
  }
  .ht-category-habits.ht-manage-dnd-target.ht-manage-dnd-empty {
    box-shadow: inset 0 0 0 2px rgba(124, 106, 247, 0.45);
    background: rgba(124, 106, 247, 0.08);
    min-height: 36px;
    border-radius: 8px;
  }
  .ht-habit.ht-manage-drop-before {
    box-shadow: inset 0 3px 0 0 rgba(124, 106, 247, 0.92);
  }
  .ht-habit.ht-manage-drop-after {
    box-shadow: inset 0 -3px 0 0 rgba(124, 106, 247, 0.92);
  }

  .ht-btn.ht-settings-mode-on {
    border-color: rgba(124, 106, 247, 0.55);
    background: rgba(124, 106, 247, 0.16);
    color: #e8e4ff;
  }

  /* Habit Tracker: habit header lives in .jhs-habit-controls; body stays in .jhs-body */
  .jhs-shell .jhs-body > .ht-sidebar {
    margin: 0 0 8px 0;
    border: none;
    background: transparent;
    box-shadow: none;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
    border-radius: 0;
    overflow: visible;
  }
  .jhs-shell .jhs-habit-controls {
    display: none;
    flex-direction: column;
    align-items: stretch;
    flex: 1 1 auto;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    margin-left: 0;
    padding-top: 4px;
    align-self: stretch;
    overflow-x: visible;
    overflow-y: visible;
    -webkit-overflow-scrolling: touch;
  }
  .jhs-shell .jhs-habit-controls .ht-habit-section-ribbon {
    border-top: 1px solid rgba(255,255,255,0.07);
    padding-top: 12px;
    padding-bottom: 2px;
    margin-top: 6px;
    pointer-events: none;
    width: 100%;
    box-sizing: border-box;
  }
  .jhs-shell .jhs-habit-controls .ht-habit-section-ribbon .ht-ribbon-sec {
    pointer-events: auto;
  }
  .jhs-shell .jhs-habit-controls.jhs-habit-controls-visible {
    display: flex;
  }
  .jhs-shell .jhs-habit-controls .ht-header-stack {
    flex: 1 1 auto;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    align-items: stretch;
    gap: 10px;
  }
  .jhs-shell .jhs-habit-controls .ht-sidebar-header.ht-jhs-header-host {
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
    min-height: 22px;
    border-bottom: none;
    padding: 4px 0 6px 0;
    background: transparent;
    width: 100%;
    box-sizing: border-box;
    flex-shrink: 0;
  }
  .jhs-shell .jhs-habit-controls .ht-sidebar-header.ht-jhs-header-host .ht-date-label {
    display: inline-flex;
    align-items: center;
    line-height: 22px;
    height: 22px;
  }
  .jhs-shell .jhs-habit-controls .ht-sidebar-header.ht-jhs-header-host .ht-nav-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    box-sizing: border-box;
    color: rgba(232, 224, 208, 0.92);
  }
  .jhs-shell .jhs-habit-controls .ht-sidebar-header.ht-jhs-header-host .ht-nav-btn .ti {
    opacity: 1;
    color: inherit;
  }
  .jhs-shell .jhs-habit-controls .ht-sidebar-header.ht-jhs-header-host .ht-nav-btn.ht-nav-btn-muted {
    opacity: 1;
    color: rgba(232, 224, 208, 0.48);
  }
  .jhs-shell .jhs-habit-controls .ht-sidebar-header.ht-jhs-header-host .ht-nav-btn.ht-cat-expand-toggle .ti {
    font-size: 18px;
    opacity: 1;
  }
  .jhs-shell .jhs-habit-controls .ht-sidebar-header.ht-jhs-header-host .ht-stats-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    box-sizing: border-box;
    color: rgba(232, 224, 208, 0.92);
  }
  .jhs-shell .jhs-habit-controls .ht-sidebar-header.ht-jhs-header-host .ht-stats-btn .ti {
    opacity: 1;
    color: inherit;
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

/** Serialized completion markers (JSON-safe strings). */
const HT_COMP_NA = '__na__';
const HT_COMP_FAIL = '__x__';
/** Long-press (× / numeric entry) and sidebar drag-paint timing. */
const HT_LONG_PRESS_MS = 500;
const HT_SIDEBAR_DRAG_CLICK_GAP_MS = 450;
const HT_DRAG_MOVE_PX = 8;

function htWeekdayFromDateStr(dateStr) {
  return new Date(dateStr + 'T12:00:00').getDay();
}

/** Empty `weekdays` = all days; else Sun=0 … Sat=6. */
function htHabitAppliesOnDate(habit, dateStr) {
  const days = habit?.weekdays;
  if (!Array.isArray(days) || days.length === 0) return true;
  return days.includes(htWeekdayFromDateStr(dateStr));
}

function htCompletionNorm(raw, habit) {
  const target = habit?.target || 0;
  const hasTarget = target > 0;
  if (raw === HT_COMP_NA) {
    return { kind: 'na', done: false, fail: false, neutral: true, num: 0 };
  }
  if (raw === HT_COMP_FAIL) {
    return { kind: 'fail', done: false, fail: true, neutral: false, num: 0 };
  }
  if (raw === undefined || raw === null) {
    return { kind: 'empty', done: false, fail: false, neutral: false, num: 0 };
  }
  if (hasTarget) {
    const n = typeof raw === 'number' ? raw : 0;
    const done = n >= target;
    return {
      kind: done ? 'done' : (n > 0 ? 'partial' : 'empty'),
      done,
      fail: false,
      neutral: false,
      num: n,
    };
  }
  if (raw === true) {
    return { kind: 'done', done: true, fail: false, neutral: false, num: 1 };
  }
  return { kind: 'empty', done: false, fail: false, neutral: false, num: 0 };
}

/** Sidebar / summary: off-days show as neutral N/A when nothing logged. */
function htHabitDaySurface(log, habit, dateStr) {
  const raw = log?.completions?.[habit.id];
  const norm = htCompletionNorm(raw, habit);
  if (!htHabitAppliesOnDate(habit, dateStr)) {
    if (norm.kind === 'empty') {
      return { ...norm, kind: 'na', neutral: true, offDay: true, displayNa: true };
    }
    return { ...norm, offDay: true };
  }
  return { ...norm, offDay: false, displayNa: norm.kind === 'na' };
}

function htHabitRowShowsNa(surf, norm) {
  return norm.kind === 'na' || (surf.displayNa && norm.kind === 'empty');
}

/**
 * Category header / ribbon lead for one day:
 * - `all_done` — every applying habit completed for the day (double-check + sherbet)
 * - `partial` — at least one done but not all
 * - `na` / `fail` / `none` as before
 */
function htCategoryDayAggregateStatus(log, applyingHabits, dateStr) {
  if (!applyingHabits.length) return 'na';
  const rows = applyingHabits.map((h) => {
    const surf = htHabitDaySurface(log, h, dateStr);
    const norm = htCompletionNorm(log.completions[h.id], h);
    return {
      done: norm.done,
      na: htHabitRowShowsNa(surf, norm),
      fail: norm.kind === 'fail',
    };
  });
  if (rows.every((r) => r.na)) return 'na';
  if (rows.length && rows.every((r) => r.done)) return 'all_done';
  if (rows.some((r) => r.done)) return 'partial';
  const nonNa = rows.filter((r) => !r.na);
  if (nonNa.length && nonNa.every((r) => r.fail)) return 'fail';
  return 'none';
}

/** True when every applying habit is “tended to” (done, N/A, or fail) — no empties. */
function htCategoryAllMarkedForDay(log, applyingHabits, dateStr) {
  if (!applyingHabits.length) return true;
  for (const h of applyingHabits) {
    const surf = htHabitDaySurface(log, h, dateStr);
    const norm = htCompletionNorm(log?.completions?.[h.id], h);
    const marked = !!(norm.done || htHabitRowShowsNa(surf, norm) || norm.kind === 'fail');
    if (!marked) return false;
  }
  return true;
}

function htCategoryDayLeadInnerHtml(status) {
  if (status === 'all_done') {
    return `<span class="ht-cat-inline-check ht-cat-inline-check--all-done" title="All habits in this category done today" aria-hidden="true">${htIcon('checks')}</span>`;
  }
  if (status === 'partial') {
    return `<span class="ht-cat-inline-check" aria-hidden="true">${htIcon('check')}</span>`;
  }
  if (status === 'na') {
    return `<span class="ht-cat-inline-na ht-cat-na-bar" aria-hidden="true"></span>`;
  }
  if (status === 'fail') {
    return `<span class="ht-cat-inline-fail ht-habit-mark ht-habit-mark-fail" aria-hidden="true">×</span>`;
  }
  return '';
}

/** Category ribbon: fixed-width lead cell (keeps icons aligned). */
function htRibbonLeadCellHtml(status, marked = false) {
  const inner = htCategoryDayLeadInnerHtml(status);
  const dot = marked
    ? `<span class="ht-ribbon-marked-dot" aria-hidden="true"><span class="ht-cat-marked-dot"></span></span>`
    : '';
  return `<span class="ht-ribbon-sec-lead">${inner}${dot}</span>`;
}

/** Category progress fill: color walks mint → sherbet as completion % increases (not a static rainbow on a short bar). */
function htCategoryProgressFillStyle(pct) {
  const t = Math.max(0, Math.min(1, (Number(pct) || 0) / 100));
  const r = Math.round(68 + t * (255 - 68));
  const g = Math.round(150 + t * (188 - 150));
  const b = Math.round(112 + t * (132 - 112));
  const r2 = Math.round(95 + t * (255 - 95));
  const g2 = Math.round(188 + t * (210 - 188));
  const b2 = Math.round(138 + t * (155 - 138));
  const a = 0.62 + t * 0.33;
  const a2 = 0.72 + t * 0.23;
  return `linear-gradient(90deg, rgba(${r},${g},${b},${a.toFixed(2)}), rgba(${r2},${g2},${b2},${a2.toFixed(2)}))`;
}

function htRecoverKeyLooksLikeHabitId(k) {
  return typeof k === 'string' && HT_RECOVER_HABIT_ID_KEY_RE.test(k.trim());
}

function htLogDateStrForRecover(d) {
  const logDate = String(d?.date || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(logDate) ? logDate : '';
}

function htNormalizeHabitConfig(cfg) {
  const o = cfg && typeof cfg === 'object' ? cfg : {};
  const out = o;
  out.categories = Array.isArray(out.categories) ? out.categories : [];
  out.habits = Array.isArray(out.habits) ? out.habits : [];
  out.habitGroupMode = 'category';
  out.hideOffDayHabits = !!out.hideOffDayHabits;
  out.showDayNotes = out.showDayNotes !== false;
  for (const h of out.habits) {
    if (!Array.isArray(h.tags)) h.tags = [];
    else h.tags = h.tags.map((t) => String(t || '').trim()).filter(Boolean);
    if (h.weekdays != null && !Array.isArray(h.weekdays)) h.weekdays = [];
    if (Array.isArray(h.weekdays)) {
      h.weekdays = [...new Set(h.weekdays.map((x) => Number(x)).filter((n) => n >= 0 && n <= 6))];
    }
  }
  if (!Array.isArray(out.tagOrder)) out.tagOrder = [];
  else out.tagOrder = out.tagOrder.map((t) => String(t || '').trim()).filter(Boolean);
  const tagSeen = new Set(out.tagOrder);
  for (const h of out.habits) {
    for (const t of h.tags) {
      if (!tagSeen.has(t)) {
        out.tagOrder.push(t);
        tagSeen.add(t);
      }
    }
  }
  return out;
}

/**
 * Solid streak color: smooth ramp from soft cool-gray (low days) toward warm red (364d).
 * 365+ uses animated sherbet legend HTML. `hot` nudges along the curve slightly for 7d+.
 */
function htStreakTierSolid(dayCount) {
  const d = Math.max(0, Math.floor(Number(dayCount) || 0));
  if (d <= 0) return 'rgba(150, 158, 178, 0.55)';
  const t = Math.min(1, d / 364);
  const u = Math.pow(t, 0.5);
  const h = 168 - u * 158;
  const s = 10 + u * 48;
  const l = 59 - u * 11;
  const a = 0.66 + u * 0.26;
  const hi = Math.round(h);
  const si = Math.round(s);
  const li = Math.round(l);
  const af = a.toFixed(2);
  return `hsla(${hi}, ${si}%, ${li}%, ${af})`;
}

function htHabitStreakCoreHtml(streakDays, hot = false) {
  const d = Math.max(0, Math.floor(Number(streakDays) || 0));
  if (d >= 365) {
    return `<span class="ht-habit-streak-core ht-streak-legend">${htIcon('flame', 'ht-streak-legend-flame')}<span class="ht-streak-legend-inner"><span class="ht-streak-day-count">${d}d</span></span></span>`;
  }
  const tierDays = d + (hot ? 1 : 0);
  const c = htStreakTierSolid(Math.min(tierDays, 364));
  return `<span class="ht-habit-streak-core" style="color:${c}">${htIcon('flame')}<span class="ht-streak-day-count">${d}d</span></span>`;
}

function htCategoryStreakBadgeHtml(streakDays, opts = {}) {
  const omitFlame = !!opts.omitFlame;
  const d = Math.max(0, Math.floor(Number(streakDays) || 0));
  if (d >= 365) {
    if (omitFlame) {
      return `<span class="ht-category-streak ht-streak-legend ht-category-streak--noflame"><span class="ht-streak-legend-inner"><span class="ht-streak-day-count">${d}d</span></span></span>`;
    }
    return `<span class="ht-category-streak ht-streak-legend">${htIcon('flame', 'ht-streak-legend-flame')}<span class="ht-streak-legend-inner"><span class="ht-streak-day-count">${d}d</span></span></span>`;
  }
  const c = htStreakTierSolid(d);
  if (omitFlame) {
    return `<span class="ht-category-streak ht-category-streak--noflame" style="color:${c}"><span class="ht-streak-day-count">${d}d</span></span>`;
  }
  return `<span class="ht-category-streak" style="color:${c}">${htIcon('flame')}<span class="ht-streak-day-count">${d}d</span></span>`;
}

function htRibbonStreakHtml(streakDays) {
  const d = Math.max(0, Math.floor(Number(streakDays) || 0));
  if (d >= 365) {
    return `<span class="ht-ribbon-sec-streak ht-streak-legend">${htIcon('flame', 'ht-streak-legend-flame')}<span class="ht-streak-legend-inner"><span class="ht-streak-day-count">${d}d</span></span></span>`;
  }
  const c = htStreakTierSolid(d);
  return `<span class="ht-ribbon-sec-streak" style="color:${c}">${htIcon('flame')}<span class="ht-streak-day-count">${d}d</span></span>`;
}

/** Year-lap streak meter fill: same tier solids as flame; 365d+ uses animated orange-sherbet gradient. */
function htYearMeterFillHtml(pct, streakDays) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const d = Math.max(0, Math.floor(Number(streakDays) || 0));
  if (d >= 365) {
    return `<span class="ht-habit-streak-meter-fill ht-habit-streak-meter-fill--legend" style="width:${p}%"></span>`;
  }
  const tierDays = Math.min(d + (d >= 7 ? 1 : 0), 364);
  const c = htStreakTierSolid(tierDays);
  return `<span class="ht-habit-streak-meter-fill" style="width:${p}%;background:${c};"></span>`;
}

function htEsc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/** Tabler Icons (tabler.io) — webfont uses `ti ti-{name}` per https://docs.tabler.io/icons/webfont */
function htIcon(name, extraClass = '') {
  const n = String(name || '').trim();
  if (!n || !/^[a-z][a-z0-9-]*$/.test(n)) return '';
  const ex = extraClass ? ' ' + extraClass : '';
  return `<i class="ti ti-${n}${ex}" aria-hidden="true"></i>`;
}

/** Curated icons for category picker (slug → menu label). */
const HT_CATEGORY_ICONS = [
  { slug: 'folder', label: 'Folder' },
  { slug: 'category', label: 'Category' },
  { slug: 'target', label: 'Target' },
  { slug: 'checklist', label: 'Checklist' },
  { slug: 'list-check', label: 'List Check' },
  { slug: 'clock', label: 'Clock' },
  { slug: 'calendar', label: 'Calendar' },
  { slug: 'calendar-event', label: 'Calendar Event' },
  { slug: 'flame', label: 'Flame' },
  { slug: 'heart', label: 'Heart' },
  { slug: 'star', label: 'Star' },
  { slug: 'sparkles', label: 'Sparkles' },
  { slug: 'bolt', label: 'Bolt' },
  { slug: 'moon', label: 'Moon' },
  { slug: 'sun', label: 'Sun' },
  { slug: 'sunrise', label: 'Sunrise' },
  { slug: 'sunset', label: 'Sunset' },
  { slug: 'cloud', label: 'Cloud' },
  { slug: 'cloud-rain', label: 'Rain Cloud' },
  { slug: 'cloud-snow', label: 'Snow Cloud' },
  { slug: 'umbrella', label: 'Umbrella' },
  { slug: 'droplet', label: 'Droplet' },
  { slug: 'coffee', label: 'Coffee' },
  { slug: 'cup', label: 'Cup' },
  { slug: 'mug', label: 'Mug' },
  { slug: 'glass', label: 'Glass' },
  { slug: 'book', label: 'Book' },
  { slug: 'books', label: 'Books' },
  { slug: 'notebook', label: 'Notebook' },
  { slug: 'pencil', label: 'Pencil' },
  { slug: 'pen', label: 'Pen' },
  { slug: 'barbell', label: 'Barbell' },
  { slug: 'run', label: 'Run' },
  { slug: 'walk', label: 'Walk' },
  { slug: 'swimming', label: 'Swim' },
  { slug: 'music', label: 'Music' },
  { slug: 'headphones', label: 'Headphones' },
  { slug: 'microphone', label: 'Microphone' },
  { slug: 'bike', label: 'Bike' },
  { slug: 'pill', label: 'Pill' },
  { slug: 'stethoscope', label: 'Stethoscope' },
  { slug: 'heartbeat', label: 'Heartbeat' },
  { slug: 'first-aid-kit', label: 'First Aid' },
  { slug: 'brush', label: 'Brush' },
  { slug: 'palette', label: 'Palette' },
  { slug: 'camera', label: 'Camera' },
  { slug: 'photo', label: 'Photo' },
  { slug: 'movie', label: 'Movie' },
  { slug: 'home', label: 'Home' },
  { slug: 'building', label: 'Building' },
  { slug: 'sofa', label: 'Sofa' },
  { slug: 'tools', label: 'Tools' },
  { slug: 'tool', label: 'Tool' },
  { slug: 'hammer', label: 'Hammer' },
  { slug: 'wrench', label: 'Wrench' },
  { slug: 'briefcase', label: 'Briefcase' },
  { slug: 'school', label: 'School' },
  { slug: 'certificate', label: 'Certificate' },
  { slug: 'bulb', label: 'Bulb' },
  { slug: 'plane', label: 'Plane' },
  { slug: 'car', label: 'Car' },
  { slug: 'bus', label: 'Bus' },
  { slug: 'train', label: 'Train' },
  { slug: 'map', label: 'Map' },
  { slug: 'map-pin', label: 'Map Pin' },
  { slug: 'world', label: 'World' },
  { slug: 'tree', label: 'Tree' },
  { slug: 'leaf', label: 'Leaf' },
  { slug: 'plant', label: 'Plant' },
  { slug: 'flower', label: 'Flower' },
  { slug: 'mountain', label: 'Mountain' },
  { slug: 'beach', label: 'Beach' },
  { slug: 'snowflake', label: 'Snowflake' },
  { slug: 'apple', label: 'Apple' },
  { slug: 'carrot', label: 'Carrot' },
  { slug: 'lemon', label: 'Lemon' },
  { slug: 'cherry', label: 'Cherry' },
  { slug: 'chef-hat', label: 'Chef Hat' },
  { slug: 'trophy', label: 'Trophy' },
  { slug: 'medal', label: 'Medal' },
  { slug: 'award', label: 'Award' },
  { slug: 'puzzle', label: 'Puzzle' },
  { slug: 'gift', label: 'Gift' },
  { slug: 'flag', label: 'Flag' },
  { slug: 'bookmark', label: 'Bookmark' },
  { slug: 'compass', label: 'Compass' },
  { slug: 'brain', label: 'Brain' },
  { slug: 'atom', label: 'Atom' },
  { slug: 'math', label: 'Math' },
  { slug: 'language', label: 'Language' },
  { slug: 'dog', label: 'Dog' },
  { slug: 'cat', label: 'Cat' },
  { slug: 'paw', label: 'Paw' },
  { slug: 'fish', label: 'Fish' },
  { slug: 'users', label: 'People' },
  { slug: 'user', label: 'Person' },
  { slug: 'user-heart', label: 'Care' },
  { slug: 'messages', label: 'Messages' },
  { slug: 'message-circle', label: 'Message' },
  { slug: 'phone', label: 'Phone' },
  { slug: 'chart-line', label: 'Chart' },
  { slug: 'chart-bar', label: 'Bar Chart' },
  { slug: 'chart-pie', label: 'Pie Chart' },
  { slug: 'coins', label: 'Coins' },
  { slug: 'currency-dollar', label: 'Dollar' },
  { slug: 'wallet', label: 'Wallet' },
  { slug: 'device-mobile', label: 'Phone' },
  { slug: 'device-laptop', label: 'Laptop' },
  { slug: 'device-tablet', label: 'Tablet' },
  { slug: 'keyboard', label: 'Keyboard' },
  { slug: 'mouse', label: 'Mouse' },
  { slug: 'wifi', label: 'WiFi' },
  { slug: 'battery', label: 'Battery' },
  { slug: 'plug', label: 'Plug' },
  { slug: 'lock', label: 'Lock' },
  { slug: 'shield', label: 'Shield' },
  { slug: 'key', label: 'Key' },
  { slug: 'zzz', label: 'Sleep' },
  { slug: 'infinity', label: 'Infinity' },
  { slug: 'pray', label: 'Pray' },
  { slug: 'mood-smile', label: 'Smile' },
  { slug: 'mood-happy', label: 'Happy' },
  { slug: 'mood-sad', label: 'Sad' },
  { slug: 'peace', label: 'Peace' },
];

function htCategoryGlyphHtml(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return htIcon('folder');
  if (/^[a-z][a-z0-9-]*$/.test(s) && s.length < 48) return htIcon(s);
  return `<span class="ht-emoji-inline">${htEsc(s)}</span>`;
}

function htGenId() {
  return Math.random().toString(36).slice(2, 10);
}

class Plugin extends AppPlugin {

  async onLoad() {
    this._panelStates = new Map();
    this._eventIds = [];
    this._htNavTimers = new Map();
    this._htLogRowsCache = { ts: 0, rows: null };
    this._htLogRowsFetchGen = 0;
    this._htDedicatedCollEnsurePromise = null;
    this._persistState = (this.getConfiguration?.()?.custom ?? this.config?.custom)?.persist_habit_panel_state !== false;
    try {
      await globalThis.ThymerPluginSettings?.registerPluginSlug?.(this.data, { slug: HT_PS_SLUG, label: 'Habit Tracker' });
    } catch (_) {}
    if (this._persistState) {
      await (globalThis.ThymerPluginSettings?.init?.({
        plugin: this,
        pluginId: 'habit-tracker',
        modeKey: 'thymerext_ps_mode_habit_tracker',
        mirrorKeys: () => this._htPluginSettingsMirrorKeys(),
        label: 'Habit Tracker',
        data: this.data,
        ui: this.ui,
      }) ?? (console.warn('[HabitTracker] ThymerPluginSettings runtime missing (redeploy full plugin .js from repo).'), Promise.resolve()));
    }
    this._collapsed = this._persistState ? (localStorage.getItem('ht_sidebar_collapsed') === 'true') : false;
    this._catCollapsed = this._persistState ? JSON.parse(localStorage.getItem('ht_cat_collapsed') || '{}') : {};
    this._config = { categories: [], habits: [] };

    this.ui.injectCSS(HT_CSS);

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
    this._cmdExport = this.ui.addCommandPaletteCommand({
      label: 'HabitTracker: Export config JSON (readable backup)',
      icon: 'ti-download',
      onSelected: () => { void this._htExportHabitConfigJson(); },
    });
    this._cmdImport = this.ui.addCommandPaletteCommand({
      label: 'HabitTracker: Import config JSON from backup…',
      icon: 'ti-upload',
      onSelected: () => this._htImportHabitConfigJson(),
    });
    this._cmdStorage = this.ui.addCommandPaletteCommand({
      label: 'Habit Tracker: Storage location…',
      icon: 'ti-database',
      onSelected: () => {
        if (!this._persistState) {
          this.ui.addToaster?.({
            title: 'Habit Tracker',
            message: 'Panel state persistence is off (plugin.json custom.persist_habit_panel_state).',
            dismissible: true,
            autoDestroyTime: 5000,
          });
          return;
        }
        globalThis.ThymerPluginSettings?.openStorageDialog?.({
          plugin: this,
          pluginId: 'habit-tracker',
          modeKey: 'thymerext_ps_mode_habit_tracker',
          mirrorKeys: () => this._htPluginSettingsMirrorKeys(),
          label: 'Habit Tracker',
          data: this.data,
          ui: this.ui,
        });
      },
    });

    try {
      await this._htEnsureHabitsStorageReady();
    } catch (e) {
      console.error('[Habit Tracker] habit storage ensure', e);
    }
    try {
      await this._migrateLegacyHabitTrackerToPluginSettings();
    } catch (e) {
      console.error('[Habit Tracker] habit migration', e);
    }
    await this._loadConfig();

    this._eventIds.push(this.events.on('panel.navigated', (ev) => this._deferPanelChanged(ev.panel)));
    this._eventIds.push(this.events.on('panel.focused', (ev) => this._onPanelChanged(ev.panel)));
    this._eventIds.push(this.events.on('panel.closed', (ev) => this._onPanelClosed(ev.panel)));

    const panel = this.ui.getActivePanel();
    if (panel) this._onPanelChanged(panel);
    setTimeout(() => {
      const p = this.ui.getActivePanel();
      if (p) this._onPanelChanged(p);
    }, 300);
  }

  onUnload() {
    for (const id of this._eventIds || []) {
      try { this.events.off(id); } catch (e) {}
    }
    this._eventIds = [];
    for (const t of (this._htNavTimers || new Map()).values()) {
      try { clearTimeout(t); } catch (e) {}
    }
    this._htNavTimers?.clear();
    this._cmdSettings?.remove?.();
    this._cmdRefresh?.remove?.();
    this._cmdExport?.remove?.();
    this._cmdImport?.remove?.();
    this._cmdStorage?.remove?.();
    for (const [, state] of (this._panelStates || new Map())) {
      this._disposeState(state);
    }
    this._panelStates?.clear?.();
  }

  _htInvalidateLogRowsCache() {
    this._htLogRowsCache = { ts: 0, rows: null };
    this._htLogRowsFetchGen = (this._htLogRowsFetchGen || 0) + 1;
    // Do not clear _htLogRowsInFlight: an in-flight list may still complete; the
    // generation check in _getAllLogRows retries if a save invalidated mid-fetch.
  }

  _htPluginSettingsMirrorKeys() {
    return [
      'ht_sidebar_collapsed',
      'ht_cat_collapsed',
      'ht_tag_collapsed',
      'ht_stats_range',
      'ht_habit_group_mode',
      'ht_habit_tag_filter',
      HT_HABIT_LAYOUT_SINGLE_COLUMN_KEY,
    ];
  }

  _htPluginSettingsFlush() {
    if (!this._persistState) return;
    globalThis.ThymerPluginSettings?.scheduleFlush?.(this, () => this._htPluginSettingsMirrorKeys());
  }

  /** Single-column habit grid (journal + settings cards); not gated on `_persistState`. */
  _htReadHabitLayoutSingleColumn() {
    try {
      return localStorage.getItem(HT_HABIT_LAYOUT_SINGLE_COLUMN_KEY) === '1';
    } catch (_) {
      return false;
    }
  }

  _htWriteHabitLayoutSingleColumn(enabled) {
    try {
      if (enabled) localStorage.setItem(HT_HABIT_LAYOUT_SINGLE_COLUMN_KEY, '1');
      else localStorage.removeItem(HT_HABIT_LAYOUT_SINGLE_COLUMN_KEY);
    } catch (_) {}
    if (this._persistState) this._htPluginSettingsFlush();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────


  // ── Habit storage (dedicated "Habit Logs" collection only) ──────────────

  _tps() {
    return globalThis.ThymerPluginSettings;
  }

  _readJsonStore(r) {
    if (!r) return '';
    const asText = (x) => {
      if (x == null) return '';
      if (typeof x === 'string') return x;
      if (typeof x === 'object') {
        try {
          return JSON.stringify(x);
        } catch (_) {
          return '';
        }
      }
      return String(x);
    };
    const tps = this._tps();
    if (tps?.rowField) {
      const j = tps.rowField(r, 'settings_json');
      const s = asText(j).trim();
      if (s) return s;
    }
    return asText(
      r.text?.('settings_json') ||
        r.prop?.('settings_json')?.text?.() ||
        r.prop?.('settings_json')?.get?.() ||
        r.text?.('data') ||
        r.prop?.('data')?.text?.() ||
        r.prop?.('data')?.get?.() ||
        ''
    );
  }

  _writeJsonStore(rec, obj) {
    if (!rec) return;
    const json = typeof obj === 'string' ? obj : JSON.stringify(obj);
    try {
      rec.prop('settings_json')?.set?.(json);
    } catch (e) {
      try {
        rec.prop('data')?.set?.(json);
      } catch (e2) {}
    }
  }

  async _psListByKind(recordKind) {
    return this._htDedicatedListByKind(recordKind);
  }

  _htWsSlug() {
    try {
      const u = this.data?.getActiveUsers?.();
      return (u && u[0] && u[0].workspaceGuid) || 'unknown_ws';
    } catch (_) {
      return 'unknown_ws';
    }
  }

  _jhsHabitsLegacyStorageModeLsKey() {
    return `${HT_LEGACY_STORAGE_MODE_KEY}_${this._htWsSlug()}`;
  }

  _jhsHabitsDedicatedCollGuidLsKey() {
    return `${HT_DEDICATED_COLL_GUID_KEY}_${this._htWsSlug()}`;
  }

  // The dedicated "Habit Logs" collection is the ONLY persistence target. Kept as a
  // method (rather than a constant) so older call sites read consistently, and so the
  // single source of truth is right here if the policy ever needs to change.
  _htUsesDedicatedHabitsStore() {
    return true;
  }

  _htGetDedicatedCollGuidFromLs() {
    try {
      const g = localStorage.getItem(this._htHabitsDedicatedCollGuidLsKey());
      return g && String(g).trim() ? String(g).trim() : '';
    } catch (_) {
      return '';
    }
  }

  _htSetDedicatedCollGuidToLs(guid) {
    try {
      if (guid) localStorage.setItem(this._htHabitsDedicatedCollGuidLsKey(), String(guid));
    } catch (_) {}
  }

  _jhsLocksBestWindow() {
    try {
      const t = window.top;
      if (t) {
        void t.document;
        return t;
      }
    } catch (_) {}
    return typeof window !== 'undefined' ? window : globalThis;
  }

  /** Same host object / promise chain as Plugin Backend `queueDataCreateOnSharedWindow` (Thymer plugin iframes). */
  _jhsQueueDataCreate(factory) {
    const host = htGetSharedDeduplicationWindow();
    try {
      if (!host[HT_SERIAL_DATA_CREATE_P] || typeof host[HT_SERIAL_DATA_CREATE_P].then !== 'function') {
        host[HT_SERIAL_DATA_CREATE_P] = Promise.resolve();
      }
      return (host[HT_SERIAL_DATA_CREATE_P] = host[HT_SERIAL_DATA_CREATE_P].catch(() => {}).then(factory));
    } catch (e) {
      console.warn('[Habit Tracker] queueDataCreate fallback', e);
      return factory();
    }
  }

  /** Normalize sync vs Promise return from `data.createCollection()`. */
  async _jhsInvokeCreateCollectionOnce() {
    const data = this.data;
    if (!data || typeof data.createCollection !== 'function') return null;
    try {
      const raw = data.createCollection();
      const coll = raw != null && typeof raw.then === 'function' ? await raw : raw;
      if (coll && typeof coll.getConfiguration === 'function' && typeof coll.saveConfiguration === 'function') {
        return coll;
      }
      console.warn('[Habit Tracker] createCollection returned non-collection', {
        type: typeof coll,
        hasGetCfg: !!(coll && typeof coll.getConfiguration === 'function'),
        hasSaveCfg: !!(coll && typeof coll.saveConfiguration === 'function'),
      });
    } catch (e) {
      console.warn('[Habit Tracker] createCollection threw', e);
    }
    return null;
  }

  /**
   * Single-mode bootstrap (2026-05-08): habit config + log rows live ONLY in the
   * dedicated "Habit Logs" collection. There is no Plugin Backend fallback.
   *
   * Why: the previous dual-mode design had three separate ways to silently revert
   * to Plugin Backend (transient `getAllCollections()` failure on slow boot, an
   * empty `localStorage` flag triggering auto-detect against orphan PB rows, and
   * `_jhsWsSlug()` returning 'unknown_ws' before active users were populated, which
   * namespaced the flag under a different key than later reads). Any one of those
   * caused the habit panel to start writing duplicate rows back into PB, which
   * then ballooned into a record-mutation storm.
   *
   * If the dedicated collection cannot be ensured here, callers will see empty
   * lists and `_htHabitsCanPersistDataRows()`-style writes will be no-ops on a
   * missing collection — never a silent regression onto PB.
   */
  async _htEnsureHabitsStorageReady() {
    try {
      const legacy = localStorage.getItem(this._htHabitsLegacyStorageModeLsKey());
      if (legacy === 'pb' || legacy === 'dedicated') {
        try {
          localStorage.removeItem(this._htHabitsLegacyStorageModeLsKey());
        } catch (_) {}
      }
    } catch (_) {}
    const coll = await this._htEnsureDedicatedHabitsCollection();
    if (!coll) {
      console.warn(
        '[Habit Tracker] Dedicated habits collection "' +
          HT_DEDICATED_COLL_NAME +
          '" could not be opened or created. Habit reads/writes will be inert until it is available — the plugin will NOT fall back to Plugin Backend.'
      );
    }
  }

  /**
   * Legacy migration kept as a deliberate no-op: this used to copy rows from a
   * pre-2024 "HabitTracker" collection into Plugin Backend. Both the source
   * collection and the destination mode are gone now. Left in place so we can
   * one-shot-reset the migrate flag without disturbing other call sites.
   */
  async _migrateLegacyHabitTrackerToPluginSettings() {
    try {
      if (localStorage.getItem(HT_PS_MIGRATE_KEY) !== '1') {
        localStorage.setItem(HT_PS_MIGRATE_KEY, '1');
      }
    } catch (_) {}
  }

  async _htDedicatedMergeSchema(coll) {
    if (!coll?.getConfiguration || !coll.saveConfiguration) return;
    const desired = htDedicatedHabitsCollectionShape();
    let base = {};
    try {
      base = coll.getConfiguration() || {};
    } catch (_) {
      base = {};
    }
    const curFields = Array.isArray(base.fields) ? [...base.fields] : [];
    const curIds = new Set(curFields.map((f) => (f && f.id ? String(f.id) : '')).filter(Boolean));
    let changed = false;
    for (const f of desired.fields || []) {
      if (f && f.id && !curIds.has(String(f.id))) {
        try {
          curFields.push(JSON.parse(JSON.stringify(f)));
        } catch (_) {
          curFields.push({ ...f });
        }
        curIds.add(String(f.id));
        changed = true;
      }
    }
    if (!changed) return;
    const merged = {
      ...base,
      fields: curFields,
      managed: { fields: false, views: false, sidebar: false },
    };
    try {
      await coll.saveConfiguration(merged);
    } catch (e) {
      console.warn('[Habit Tracker] dedicated schema merge', e);
    }
  }

  _jhsDedicatedCollectionSidebarName(coll) {
    try {
      return String(coll?.getName?.() || '').trim();
    } catch (_) {
      return '';
    }
  }

  _jhsDedicatedCollectionConfigName(coll) {
    try {
      const cfg = coll?.getConfiguration?.();
      return String(cfg?.name || '').trim();
    } catch (_) {
      return '';
    }
  }

  /**
   * Locate the dedicated habits store: `getName()` may stay "New Collection" while `configuration.name` is "Habit Logs".
   */
  _jhsFindDedicatedHabitsCollectionInList(all) {
    if (!Array.isArray(all)) return null;
    for (const c of all) {
      if (this._htDedicatedCollectionSidebarName(c) === HT_DEDICATED_COLL_NAME) return c;
    }
    for (const c of all) {
      if (this._htDedicatedCollectionConfigName(c) === HT_DEDICATED_COLL_NAME) return c;
    }
    return null;
  }

  /** Serialize ensure + create so concurrent callers cannot race-create multiple collections. */
  async _htEnsureDedicatedHabitsCollection() {
    if (!this.data || typeof this.data.getAllCollections !== 'function') return null;
    if (this._htDedicatedCollEnsurePromise) {
      return await this._htDedicatedCollEnsurePromise;
    }
    const p = (async () => {
      try {
        return await this._htEnsureDedicatedHabitsCollectionCore();
      } finally {
        this._htDedicatedCollEnsurePromise = null;
      }
    })();
    this._htDedicatedCollEnsurePromise = p;
    return await p;
  }

  async _htEnsureDedicatedHabitsCollectionCore() {
    const guidStored = this._htGetDedicatedCollGuidFromLs();
    if (guidStored) {
      try {
        if (typeof this.data.getCollection === 'function') {
          const c = await this.data.getCollection(guidStored);
          if (c) {
            await this._htDedicatedMergeSchema(c);
            return c;
          }
        }
      } catch (_) {}
      try {
        localStorage.removeItem(this._htHabitsDedicatedCollGuidLsKey());
      } catch (_) {}
    }
    const run = async () => {
      let all = [];
      try {
        all = await this.data.getAllCollections();
      } catch (_) {
        return null;
      }
      const existing = this._htFindDedicatedHabitsCollectionInList(all);
      if (existing) {
        const g = this._htGetCollectionGuid(existing);
        if (g) this._htSetDedicatedCollGuidToLs(g);
        await this._htDedicatedMergeSchema(existing);
        return existing;
      }
      if (typeof this.data.createCollection !== 'function') {
        console.error('[Habit Tracker] data.createCollection is not a function');
        return null;
      }
      let coll = await this._htQueueDataCreate(() => this._htInvokeCreateCollectionOnce());
      if (!coll || typeof coll.saveConfiguration !== 'function') {
        console.warn(
          '[Habit Tracker] queued createCollection unusable; retrying once without serial queue.',
          { sameAsThisWindow: htGetSharedDeduplicationWindow() === (typeof window !== 'undefined' ? window : null) }
        );
        await htSleep(400);
        coll = await this._htInvokeCreateCollectionOnce();
      }
      if (!coll || typeof coll.saveConfiguration !== 'function') {
        console.error('[Habit Tracker] createCollection returned unusable collection after retry', coll);
        return null;
      }
      const shape = htDedicatedHabitsCollectionShape();
      let base = {};
      try {
        base = coll.getConfiguration() || {};
      } catch (_) {
        base = {};
      }
      if (base && typeof base.ver === 'number') shape.ver = base.ver;
      const payload = { ...shape, managed: { fields: false, views: false, sidebar: false } };
      let ok = await coll.saveConfiguration(payload);
      if (ok === false) {
        await htSleep(180);
        ok = await coll.saveConfiguration(payload);
      }
      if (ok === false) {
        console.error('[Habit Tracker] saveConfiguration returned false for dedicated habits collection', {
          name: HT_DEDICATED_COLL_NAME,
        });
        return null;
      }
      let out = coll;
      try {
        await htSleep(80);
        const all2 = await this.data.getAllCollections();
        const rediscovered = this._htFindDedicatedHabitsCollectionInList(all2);
        if (rediscovered) out = rediscovered;
        const g = this._htGetCollectionGuid(out);
        if (g) this._htSetDedicatedCollGuidToLs(g);
      } catch (e) {
        console.warn('[Habit Tracker] post-create rediscover / guid', e);
      }
      await this._htDedicatedMergeSchema(out);
      return out;
    };
    try {
      const w = htGetSharedDeduplicationWindow();
      if (w.navigator?.locks?.request) {
        return await w.navigator.locks.request(HT_DEDICATED_ENSURE_LOCK, () => run());
      }
    } catch (_) {}
    return await run();
  }

  async _htResolveDedicatedHabitsCollection() {
    return this._htEnsureDedicatedHabitsCollection();
  }

  async _htDedicatedListByKind(recordKind) {
    const coll = await this._htResolveDedicatedHabitsCollection();
    if (!coll) return [];
    const tps = this._tps();
    if (!tps?.rowField) return [];
    let records = [];
    try {
      records = await coll.getAllRecords();
    } catch (e) {
      console.error('[HabitTracker] dedicated getAllRecords', e);
      return [];
    }
    return (records || []).filter((r) => {
      let rowSlug = tps.rowField(r, 'plugin');
      if (!rowSlug) {
        const pid = tps.rowField(r, 'plugin_id');
        const s = String(pid || '');
        const i = s.indexOf(':');
        rowSlug = i > 0 ? s.slice(0, i) : s;
      }
      if (rowSlug !== HT_PS_SLUG) return false;
      if (recordKind != null && String(recordKind) !== '') {
        const rk = (tps.rowField(r, 'record_kind') || '').trim();
        return rk === String(recordKind);
      }
      return true;
    });
  }

  _htPluginChoiceLabelForSlug(coll, slug) {
    const s = String(slug || '').trim();
    try {
      const fields = coll.getConfiguration?.()?.fields || [];
      const f = fields.find((x) => x && x.id === 'plugin');
      if (!f || f.type !== 'choice' || !Array.isArray(f.choices)) return s;
      const opt = f.choices.find((c) => c && String(c.id || '').trim() === s);
      if (opt && opt.label != null && String(opt.label).trim()) return String(opt.label).trim();
    } catch (_) {}
    return s;
  }

  _htApplyHabitRowMeta(coll, record, { pluginSlug, recordKind, rowPluginId }) {
    if (!record) return;
    try {
      record.prop('plugin_id')?.set?.(rowPluginId);
    } catch (_) {}
    try {
      record.prop('record_kind')?.set?.(recordKind);
    } catch (_) {}
    const p = record.prop?.('plugin');
    const labelTry = this._htPluginChoiceLabelForSlug(coll, pluginSlug);
    if (p && typeof p.setChoice === 'function') {
      if (p.setChoice(labelTry)) return;
      if (labelTry !== pluginSlug && p.setChoice(pluginSlug)) return;
      try {
        p.set?.(pluginSlug);
      } catch (_) {}
      return;
    }
    try {
      p?.set?.(pluginSlug);
    } catch (_) {}
  }

  _htHabitsCanPersistDataRows() {
    return !!this.data;
  }

  async _htDedicatedCreateDataRow({ recordKind, rowPluginId, recordTitle, settingsDoc } = {}) {
    const coll = await this._htResolveDedicatedHabitsCollection();
    if (!coll) return null;
    const rid = (rowPluginId || '').trim();
    const kind = (recordKind || '').trim();
    if (!rid || !kind) return null;
    await this._htDedicatedMergeSchema(coll);
    const title = (recordTitle || rid).trim() || rid;
    let guid = null;
    try {
      guid = coll.createRecord?.(title);
    } catch (e) {
      console.error('[HabitTracker] dedicated createRecord', e);
      return null;
    }
    if (!guid) return null;
    let r = null;
    for (let i = 0; i < 30; i++) {
      await htSleep(i < 8 ? 100 : 200);
      try {
        const again = await coll.getAllRecords();
        r = again.find((x) => x.guid === guid) || again.find((x) => this._tps()?.rowField(x, 'plugin_id') === rid);
        if (r) break;
      } catch (_) {}
    }
    if (!r) return null;
    this._htApplyHabitRowMeta(coll, r, { pluginSlug: HT_PS_SLUG, recordKind: kind, rowPluginId: rid });
    const json =
      settingsDoc !== undefined && settingsDoc !== null
        ? typeof settingsDoc === 'string'
          ? settingsDoc
          : JSON.stringify(settingsDoc)
        : '{}';
    try {
      r.prop('settings_json')?.set?.(json);
    } catch (e) {
      console.warn('[HabitTracker] dedicated settings_json', e);
    }
    return r;
  }

  async _htCreateHabitDataRow(partial) {
    return this._htDedicatedCreateDataRow(partial);
  }

  /**
   * When multiple `config` rows exist (duplicates / partial saves), pick the record whose JSON
   * has the most real habit data — `rows[0]` order from Thymer is not stable.
   */
  _htPickBestConfigRow(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    let best = null;
    let bestScore = -1;
    for (const r of rows) {
      const raw = this._readJsonStore(r);
      if (!raw || !String(raw).trim()) continue;
      let score = 0;
      try {
        const doc = JSON.parse(raw);
        const cats = Array.isArray(doc.categories) ? doc.categories.length : 0;
        const habits = Array.isArray(doc.habits) ? doc.habits.length : 0;
        score = cats * 2000 + habits * 10 + String(raw).length;
      } catch (_) {
        score = String(raw).length;
      }
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
    return best || rows[0] || null;
  }

  /**
   * Habits UI reads **config** (categories + habit definitions). Log rows only store daily completions.
   * If config is empty but logs still have `completions` keys (e.g. after plugin reinstall / row order
   * glitches), rebuild a minimal config and persist so the panel works again.
   */
  async _htRecoverHabitConfigFromLogsIfNeeded() {
    let cfg = this._config;
    if (!cfg) return;
    cfg = htNormalizeHabitConfig(cfg);

    const restoredName = (h) => /^Restored habit\s*\(/i.test(String(h?.name || ''));
    const bloatedAutoRecover =
      cfg.categories.length === 1 &&
      /^recovered$/i.test(String(cfg.categories[0]?.name || '').trim()) &&
      cfg.habits.length > HT_RECOVER_MAX_HABITS &&
      cfg.habits.every(restoredName);
    if (bloatedAutoRecover) {
      htHabitsDbg({
        step: '_htRecoverHabitConfigFromLogsIfNeeded',
        outcome: 'reset_bloated_recovered',
        priorHabits: cfg.habits.length,
      });
      this._config = { categories: [], habits: [] };
      cfg = this._config;
    }

    if (cfg.categories.length > 0) return;

    if (cfg.habits.length > 0) {
      const catId = htGenId();
      cfg.categories = [{ id: catId, name: 'General', emoji: 'folder', order: 0 }];
      const catIds = new Set(cfg.categories.map((c) => c.id));
      for (let i = 0; i < cfg.habits.length; i++) {
        const h = cfg.habits[i];
        if (!h || catIds.has(h.categoryId)) continue;
        h.categoryId = catId;
      }
      this._config = htNormalizeHabitConfig(cfg);
      try {
        await this._saveConfig();
      } catch (_) {}
      htHabitsDbg({
        step: '_htRecoverHabitConfigFromLogsIfNeeded',
        outcome: 'repaired_orphan_habits',
        categoryCount: this._config.categories.length,
        habitCount: this._config.habits.length,
      });
      console.warn(
        '[Journal Header Suite / Habits] Config had habits but no categories; added a "General" category. Open settings to rename.'
      );
      return;
    }

    let logRows;
    try {
      logRows = await this._getAllLogRows(true);
    } catch (_) {
      return;
    }
    const lastSeen = new Map();
    for (const r of logRows || []) {
      const raw = this._readJsonStore(r);
      if (!raw || !String(raw).trim()) continue;
      try {
        const d = JSON.parse(raw);
        const logDate = htLogDateStrForRecover(d);
        if (!logDate) continue;
        const comp = d.completions || {};
        for (const k of Object.keys(comp)) {
          if (!htRecoverKeyLooksLikeHabitId(k)) continue;
          const v = comp[k];
          if (v === undefined || v === null) continue;
          const prev = lastSeen.get(k);
          if (!prev || logDate > prev) lastSeen.set(k, logDate);
        }
      } catch (_) {}
    }
    if (lastSeen.size === 0) return;

    const cutoff = htDaysBefore(htToday(), HT_RECOVER_LOG_LOOKBACK_DAYS);
    let ids = [...lastSeen.entries()]
      .filter(([, dateStr]) => dateStr >= cutoff)
      .sort((a, b) => b[1].localeCompare(a[1]))
      .map(([id]) => id);
    if (ids.length === 0) {
      ids = [...lastSeen.entries()]
        .sort((a, b) => b[1].localeCompare(a[1]))
        .map(([id]) => id)
        .slice(0, HT_RECOVER_MAX_HABITS);
    }
    const totalFound = ids.length;
    if (ids.length > HT_RECOVER_MAX_HABITS) ids = ids.slice(0, HT_RECOVER_MAX_HABITS);

    const catId = htGenId();
    const habits = [];
    let order = 0;
    for (const id of ids) {
      habits.push({
        id,
        name: `Restored habit (${id})`,
        categoryId: catId,
        order: order++,
        tags: [],
        weekdays: [],
      });
    }
    this._config = htNormalizeHabitConfig({
      ...cfg,
      categories: [{ id: catId, name: 'Recovered', emoji: 'sparkles', order: 0 }],
      habits,
    });
    try {
      await this._saveConfig();
    } catch (e) {
      console.error('[HabitTracker] recover config from logs save failed', e);
      return;
    }
    htHabitsDbg({
      step: '_htRecoverHabitConfigFromLogsIfNeeded',
      outcome: 'rebuilt_from_logs',
      habitIds: habits.length,
      distinctInLogs: lastSeen.size,
      lookbackDays: HT_RECOVER_LOG_LOOKBACK_DAYS,
      maxCap: HT_RECOVER_MAX_HABITS,
    });
    let wmsg = `[Journal Header Suite / Habits] Recovered ${habits.length} placeholder habit(s) from logs (${lastSeen.size} id(s) seen in completions).`;
    if (totalFound > HT_RECOVER_MAX_HABITS) {
      wmsg += ` Kept the ${HT_RECOVER_MAX_HABITS} most recently active by log date.`;
    }
    if (bloatedAutoRecover) wmsg += ' Replaced an oversized auto-recover list.';
    wmsg +=
      ' Keys must look like habit ids (short alphanumeric); stale ids outside ~' +
      HT_RECOVER_LOG_LOOKBACK_DAYS +
      'd are skipped. Open **Habits → settings** to rename.';
    console.warn(wmsg);
  }

  async _loadConfig() {
    this._config = { categories: [], habits: [] };
    try {
      const rows = await this._psListByKind('config');
      const row = this._htPickBestConfigRow(rows);
      if (!row) {
        htHabitsDbg({ step: '_loadConfig', outcome: 'no_config_row', configRowCount: rows.length });
      } else {
        const raw = this._readJsonStore(row);
        if (raw && String(raw).trim()) this._config = JSON.parse(raw);
        htHabitsDbg({
          step: '_loadConfig',
          outcome: 'loaded',
          configRowCount: rows.length,
          rawLen: raw ? String(raw).length : 0,
          categoryCount: this._config?.categories?.length ?? 0,
          habitCount: this._config?.habits?.length ?? 0,
        });
      }
    } catch (e) {
      console.error('[HabitTracker] Error loading config:', e);
      this._config = { categories: [], habits: [] };
      htHabitsDbg({ step: '_loadConfig', outcome: 'error', err: String((e && e.message) || e) });
    }
    this._config = htNormalizeHabitConfig(this._config);
    if (this._persistState) {
      try {
        localStorage.setItem('ht_habit_group_mode', this._config.habitGroupMode || 'category');
      } catch (_) {}
    }
    let restoredFromLocal = false;
    try {
      restoredFromLocal = this._htTryRestoreHabitConfigFromLocalBackup();
    } catch (e) {
      console.error('[HabitTracker] local backup restore', e);
    }
    if (restoredFromLocal) {
      try {
        await this._saveConfig();
      } catch (e) {
        console.error('[HabitTracker] save after local backup restore', e);
      }
    }
    try {
      await this._htRecoverHabitConfigFromLogsIfNeeded();
    } catch (e) {
      console.error('[HabitTracker] recover habit config from logs', e);
    }
    if (this._htHabitConfigHasRealLabels(this._config)) {
      try {
        this._htPersistHabitConfigLocalBackup();
      } catch (_) {}
    }
  }

  /** True if habit names look like auto-recovered placeholders only (no human labels to preserve). */
  _htHabitNamesLookPlaceholderOnly(cfg) {
    const h = cfg?.habits;
    if (!Array.isArray(h) || h.length === 0) return false;
    return h.every((x) => /^Restored habit\s*\(/i.test(String(x?.name || '').trim()));
  }

  /** True when we have at least one category and one habit with a non-placeholder name. */
  _htHabitConfigHasRealLabels(cfg) {
    const c = htNormalizeHabitConfig(cfg || {});
    if (!c.categories?.length || !c.habits?.length) return false;
    return c.habits.some((h) => h && !/^Restored habit\s*\(/i.test(String(h.name || '').trim()));
  }

  /** Mirror full habit config to localStorage whenever Plugin Backend save succeeds (readable JSON). */
  _htPersistHabitConfigLocalBackup() {
    if (!this._persistState) return;
    try {
      const cfg = htNormalizeHabitConfig(this._config);
      if (!cfg.categories?.length && !cfg.habits?.length) return;
      if (!this._htHabitConfigHasRealLabels(cfg)) return;
      const payload = { ver: 1, savedAt: new Date().toISOString(), config: cfg };
      localStorage.setItem(HT_HABIT_CONFIG_BACKUP_KEY, JSON.stringify(payload));
    } catch (e) {
      if (e && e.name === 'QuotaExceededError') {
        console.warn('[Journal Header Suite / Habits] local backup skipped (quota)', e.message);
      }
    }
  }

  /**
   * If Plugin Backend config is empty or only "Restored habit (id)" placeholders, restore from
   * {@link HT_HABIT_CONFIG_BACKUP_KEY} when that snapshot still has real labels.
   */
  _htTryRestoreHabitConfigFromLocalBackup() {
    if (!this._persistState) return false;
    const cur = htNormalizeHabitConfig(this._config);
    const looksBad =
      cur.categories.length === 0 ||
      (cur.habits.length > 0 && this._htHabitNamesLookPlaceholderOnly(cur));
    if (!looksBad) return false;
    try {
      const raw = localStorage.getItem(HT_HABIT_CONFIG_BACKUP_KEY);
      if (!raw || !String(raw).trim()) return false;
      const wrap = JSON.parse(raw);
      const doc = wrap.config != null ? wrap.config : wrap;
      const bn = htNormalizeHabitConfig(doc);
      if (!bn.categories?.length || !bn.habits?.length) return false;
      if (this._htHabitNamesLookPlaceholderOnly(bn)) return false;
      this._config = bn;
      htHabitsDbg({
        step: '_htTryRestoreHabitConfigFromLocalBackup',
        outcome: 'restored',
        savedAt: wrap.savedAt || null,
        categories: bn.categories.length,
        habits: bn.habits.length,
      });
      console.info(
        '[Journal Header Suite / Habits] Restored habit names/categories from local browser backup',
        wrap.savedAt ? `(saved ${wrap.savedAt})` : '',
        '— saving to habits storage.'
      );
      return true;
    } catch (e) {
      htHabitsDbg({ step: '_htTryRestoreHabitConfigFromLocalBackup', outcome: 'fail', err: String(e) });
      return false;
    }
  }

  async _htExportHabitConfigJson() {
    try {
      if (this._habitBootstrapEnabled) {
        this._ensureHabitBootstrapStarted();
        if (this._habitBootstrapPromise) await this._habitBootstrapPromise;
      } else {
        try {
          await this._loadConfig();
        } catch (_) {}
      }
      const cfg = htNormalizeHabitConfig(this._config || { categories: [], habits: [] });
      if (!cfg.categories?.length && !cfg.habits?.length) {
        this.ui.addToaster?.({
          title: 'Habits export',
          message:
            'No config loaded yet. Enable the Habits tab in Journal Header Suite settings, open a journal day, then try again — or copy JSON from the habits “config” row in the "Habit Logs" collection.',
          dismissible: true,
          autoDestroyTime: 8000,
        });
        return;
      }
      const payload = {
        ver: 1,
        exportedAt: new Date().toISOString(),
        note: 'Journal Header Suite habit config — keep this file safe; import via command palette if synced habits config is lost.',
        config: cfg,
      };
      const text = JSON.stringify(payload, null, 2);
      try {
        const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `jhs-habits-backup-${htToday()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (_) {
        try {
          navigator.clipboard.writeText(text);
        } catch (e2) {
          console.info('[JHS/Habits] export JSON:\n', text);
        }
      }
      try {
        this._htPersistHabitConfigLocalBackup();
      } catch (_) {}
      this.ui.addToaster?.({
        title: 'Habits backup',
        message: `Exported ${cfg.categories.length} categories, ${cfg.habits.length} habits. File downloaded (or clipboard / console if blocked).`,
        dismissible: true,
        autoDestroyTime: 6000,
      });
    } catch (e) {
      console.error('[HabitTracker] export', e);
      this.ui.addToaster?.({
        title: 'Habits export failed',
        message: String((e && e.message) || e),
        dismissible: true,
        autoDestroyTime: 6000,
      });
    }
  }

  async _htImportHabitConfigJson() {
    let pasted = '';
    try {
      if (typeof window.showOpenFilePicker === 'function') {
        const [handle] = await window.showOpenFilePicker({
          multiple: false,
          types: [
            {
              description: 'JSON',
              accept: { 'application/json': ['.json'], 'text/plain': ['.txt'] },
            },
          ],
        });
        const file = await handle.getFile();
        pasted = await file.text();
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.warn('[HabitTracker] import file picker', e);
    }
    if (!String(pasted || '').trim()) {
      try {
        pasted = await navigator.clipboard.readText();
      } catch (_) {}
    }
    if (!String(pasted || '').trim()) {
      this.ui.addToaster?.({
        title: 'Habits import',
        message:
          'Pick a JSON file from an export, or copy the JSON to the clipboard and run this command again. (Browser-style prompt dialogs are not available here.)',
        dismissible: true,
        autoDestroyTime: 9000,
      });
      return;
    }
    try {
      const wrap = JSON.parse(pasted.trim());
      const doc = wrap.config != null ? wrap.config : wrap;
      const next = htNormalizeHabitConfig(doc);
      if (!next.categories?.length || !next.habits?.length) {
        this.ui.addToaster?.({
          title: 'Habits import',
          message: 'JSON must include non-empty categories and habits.',
          dismissible: true,
          autoDestroyTime: 6000,
        });
        return;
      }
      this._config = next;
      await this._saveConfig();
      await this.refreshAllPanels?.();
      this.ui.addToaster?.({
        title: 'Habits import',
        message: 'Saved to habits storage and refreshed panels.',
        dismissible: true,
        autoDestroyTime: 5000,
      });
    } catch (e) {
      console.error('[HabitTracker] import', e);
      this.ui.addToaster?.({
        title: 'Habits import failed',
        message: String((e && e.message) || e),
        dismissible: true,
        autoDestroyTime: 6000,
      });
    }
  }

  async _saveConfig() {
    try {
      const rows = await this._psListByKind('config');
      if (rows.length) {
        const target = this._htPickBestConfigRow(rows) || rows[0];
        this._writeJsonStore(target, this._config);
      } else {
        if (!this._htHabitsCanPersistDataRows()) return;
        await this._htCreateHabitDataRow({
          recordKind: 'config',
          rowPluginId: HT_PS_ROW_CONFIG,
          recordTitle: 'config',
          settingsDoc: this._config,
        });
      }
      this._htPersistHabitConfigLocalBackup();
    } catch (e) {
      console.error('[HabitTracker] Error saving config:', e);
    }
  }

  /** Recompute `order` for habits within each category (mutates `cfg`). */
  _htNormalizeHabitOrders(cfg = this._config) {
    if (!cfg?.habits || !cfg?.categories) return;
    const draft = cfg;
    const byCat = new Map();
    for (const c of draft.categories) byCat.set(c.id, []);
    for (const h of draft.habits.filter((x) => !x.archived)) {
      if (!byCat.has(h.categoryId)) byCat.set(h.categoryId, []);
      byCat.get(h.categoryId).push(h);
    }
    for (const [, arr] of byCat) {
      arr.sort((a, b) => (a.order || 0) - (b.order || 0));
      arr.forEach((hab, i) => {
        hab.order = i;
      });
    }
  }

  _htSchedulePersistHabitConfig() {
    try {
      if (this._htPersistTimer) clearTimeout(this._htPersistTimer);
    } catch (_) {}
    this._htPersistTimer = setTimeout(() => {
      this._htPersistTimer = null;
      void this._htFlushPersistHabitConfig();
    }, 420);
  }

  async _htFlushPersistHabitConfig() {
    try {
      this._config = htNormalizeHabitConfig(this._config);
      await this._saveConfig();
      // Full re-render destroys manage-strip inputs and resets scroll — skip habit
      // sidebars that are in quick-edit until user toggles manage off or a structural
      // change calls _htRefreshManageModeHabitSidebars().
      await this.refreshAllPanels({ skipManageModeHabitSidebar: true });
    } catch (e) {
      console.error('[HabitTracker] persist habit config', e);
    }
  }

  /** Re-render habit sidebars that are in inline manage (quick-edit) mode only. */
  async _htRefreshManageModeHabitSidebars() {
    for (const [, st] of this._panelStates || new Map()) {
      if (!st?.bodyEl?.isConnected) continue;
      if (st.bodyEl.dataset?.mode === 'stats') continue;
      if (!st.htManageMode) continue;
      await this._renderSidebar(st);
    }
  }

  _htMoveCategoryOrderInline(catId, delta) {
    const cfg = this._config;
    if (!cfg?.categories) return;
    const sorted = [...cfg.categories].sort((a, b) => (a.order || 0) - (b.order || 0));
    const i = sorted.findIndex((c) => c.id === catId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= sorted.length) return;
    const t = sorted[i];
    sorted[i] = sorted[j];
    sorted[j] = t;
    sorted.forEach((c, k) => {
      c.order = k;
    });
    this._htSchedulePersistHabitConfig();
    void this._htRefreshManageModeHabitSidebars();
  }

  _htReorderHabitInCategory(habitId, delta) {
    const cfg = this._config;
    const moving = cfg?.habits?.find((h) => h.id === habitId && !h.archived);
    if (!moving) return;
    const list = cfg.habits
      .filter((h) => !h.archived && h.categoryId === moving.categoryId)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    const i = list.findIndex((h) => h.id === habitId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    const t = list[i];
    list[i] = list[j];
    list[j] = t;
    list.forEach((h, k) => {
      h.order = k;
    });
    this._htSchedulePersistHabitConfig();
    void this._htRefreshManageModeHabitSidebars();
  }

  /**
   * Move a habit to `toCatId` and insert before index `beforeIdx` (0 = top). Matches settings-modal DnD semantics.
   */
  _htMoveHabitToCategoryAtIndex(habitId, toCatId, beforeIdx) {
    const cfg = this._config;
    const draft = cfg;
    if (!draft?.habits || !toCatId) return;
    const moving = draft.habits.find((h) => h.id === habitId && !h.archived);
    if (!moving) return;
    const normalizeOrders = () => {
      const byCat = new Map();
      for (const c of draft.categories || []) byCat.set(c.id, []);
      for (const h of draft.habits.filter((x) => !x.archived)) {
        if (!byCat.has(h.categoryId)) byCat.set(h.categoryId, []);
        byCat.get(h.categoryId).push(h);
      }
      for (const [, arr] of byCat) {
        arr.sort((a, b) => (a.order || 0) - (b.order || 0));
        arr.forEach((h, i) => {
          h.order = i;
        });
      }
    };
    moving.categoryId = toCatId;
    normalizeOrders();
    const list = draft.habits
      .filter((h) => !h.archived && h.categoryId === toCatId)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    const from = list.findIndex((h) => h.id === moving.id);
    if (from >= 0) list.splice(from, 1);
    const idx = Math.max(0, Math.min(beforeIdx, list.length));
    list.splice(idx, 0, moving);
    list.forEach((h, i) => {
      h.order = i;
    });
  }

  /** Toggle per-panel inline habit editing (tags, weekdays, reorder) when habits live in the suite shell. */
  _jhsSuiteToggleHabitQuickEdit(jhsShellState) {
    const pid = jhsShellState?.panelId;
    if (!pid) return;
    const st = this._panelStates.get(pid);
    if (!st?.bodyEl) return;
    st.htManageMode = !st.htManageMode;
    const btn = st._htHabitShell?.manageBtn;
    if (btn) {
      btn.classList.toggle('active', !!st.htManageMode);
      btn.title = st.htManageMode ? 'Done editing habits' : 'Edit habits here';
    }
    void this._renderSidebar(st);
  }

  /**
   * Category glyph picker (shared by inline manage, modal settings, and per-card editors).
   * @returns {{ el: HTMLElement, setValue: (v: string) => void, getSlug: () => string, normalizeIconSlug: (raw: string) => string }}
   */
  _htBuildCategoryIconPicker(initialSlug, onChange) {
    const iconBySlug = new Set(HT_CATEGORY_ICONS.map((x) => x.slug));
    const iconChoices = Array.from(
      new Map(HT_CATEGORY_ICONS.map((opt) => [opt.slug, opt])).values()
    );
    const normalizeIconSlug = (raw) => {
      const s = String(raw || '').trim();
      return s && iconBySlug.has(s) ? s : 'folder';
    };
    let current = normalizeIconSlug(initialSlug);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;display:inline-flex;';
    const trigger = document.createElement('button');
    trigger.className = 'ht-btn ht-btn-secondary ht-btn-sm';
    trigger.type = 'button';
    trigger.title = 'Pick category icon';
    trigger.style.cssText =
      'display:inline-flex;align-items:center;gap:4px;min-width:44px;justify-content:center;';

    const menu = document.createElement('div');
    menu.style.cssText =
      'position:absolute;z-index:30;top:calc(100% + 6px);left:0;width:260px;max-height:260px;overflow:auto;display:none;padding:6px;border:1px solid rgba(255,255,255,0.2);border-radius:8px;background:rgba(24,22,30,0.96);box-shadow:0 8px 24px rgba(0,0,0,0.35);';
    const search = document.createElement('input');
    search.className = 'ht-input';
    search.placeholder = 'Search icons...';
    search.style.cssText = 'width:100%;height:28px;padding:4px 8px;margin-bottom:6px;font-size:12px;';
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(6,1fr);gap:4px;';
    const syncTrigger = () => {
      trigger.innerHTML = `${htCategoryGlyphHtml(current)} <span style="margin-left:4px;opacity:.75;">${htIcon('chevron-down')}</span>`;
    };
    const renderOptions = () => {
      const q = String(search.value || '').trim().toLowerCase();
      grid.innerHTML = '';
      const filtered = !q
        ? iconChoices
        : iconChoices.filter(
            (opt) =>
              opt.label.toLowerCase().includes(q) || opt.slug.toLowerCase().includes(q)
          );
      for (const opt of filtered) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ht-btn ht-btn-secondary ht-btn-sm';
        button.title = `${opt.label} (${opt.slug})`;
        button.style.cssText = 'padding:5px 0;min-width:0;';
        button.innerHTML = htCategoryGlyphHtml(opt.slug);
        button.addEventListener('click', (e) => {
          e.stopPropagation();
          current = opt.slug;
          syncTrigger();
          menu.style.display = 'none';
          try {
            onChange?.(current);
          } catch (_) {}
        });
        grid.appendChild(button);
      }
      if (!filtered.length) {
        const none = document.createElement('div');
        none.style.cssText = 'grid-column:1 / -1;font-size:11px;color:#8a7e6a;padding:6px;';
        none.textContent = 'No icon matches.';
        grid.appendChild(none);
      }
    };
    search.addEventListener('click', (e) => e.stopPropagation());
    search.addEventListener('input', renderOptions);
    menu.appendChild(search);
    menu.appendChild(grid);
    renderOptions();
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = menu.style.display === 'none';
      menu.style.display = willOpen ? 'block' : 'none';
      if (willOpen) {
        search.value = '';
        renderOptions();
        setTimeout(() => search.focus(), 0);
      }
    });
    document.addEventListener('click', () => {
      menu.style.display = 'none';
    });
    wrap.appendChild(trigger);
    wrap.appendChild(menu);
    syncTrigger();
    return {
      el: wrap,
      setValue: (v) => {
        current = normalizeIconSlug(v);
        syncTrigger();
      },
      normalizeIconSlug,
      getSlug: () => current,
    };
  }

  _buildManageCategoriesBar(state) {
    const cfg = this._config;
    const wrap = document.createElement('div');
    wrap.className = 'ht-manage-cats-bar';
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px;';
    const title = document.createElement('div');
    title.className = 'ht-manage-cats-title';
    title.style.marginBottom = '0';
    title.textContent = 'Categories';
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:10px;color:#8a7e6a;flex:1;min-width:160px;';
    hint.textContent =
      '↑↓ changes order everywhere (journal sections and the collapsed icon strip).';
    top.appendChild(title);
    top.appendChild(hint);
    wrap.appendChild(top);

    const cats = [...(cfg.categories || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
    cats.forEach((cat, ci) => {
      const row = document.createElement('div');
      row.className = 'ht-manage-cat-row';
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'ht-nav-btn';
      up.style.fontSize = '11px';
      up.innerHTML = htIcon('chevron-up');
      up.disabled = ci <= 0;
      up.title = 'Move category up';
      up.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._htMoveCategoryOrderInline(cat.id, -1);
      });
      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'ht-nav-btn';
      down.style.fontSize = '11px';
      down.innerHTML = htIcon('chevron-down');
      down.disabled = ci >= cats.length - 1;
      down.title = 'Move category down';
      down.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._htMoveCategoryOrderInline(cat.id, 1);
      });
      const nameIn = document.createElement('input');
      nameIn.className = 'ht-input';
      nameIn.value = cat.name || '';
      nameIn.placeholder = 'Category name';
      nameIn.addEventListener('click', (e) => e.stopPropagation());
      nameIn.addEventListener('change', () => {
        const nm = String(nameIn.value || '').trim();
        if (nm) cat.name = nm;
        this._htSchedulePersistHabitConfig();
      });
      row.appendChild(up);
      row.appendChild(down);
      row.appendChild(nameIn);
      wrap.appendChild(row);
    });
    wrap.addEventListener('click', (e) => e.stopPropagation());
    return wrap;
  }

  _htRenameTagGlobally(fromRaw, toRaw) {
    const from = String(fromRaw || '').trim();
    const to = String(toRaw || '').trim();
    if (!from || !to) return;
    if (from === to) return;
    const cfg = this._config;
    if (!Array.isArray(cfg.tagOrder)) cfg.tagOrder = [];
    const ord = [...cfg.tagOrder];
    const fromIdx = ord.indexOf(from);
    if (fromIdx < 0) return;
    if (ord.includes(to)) {
      cfg.tagOrder = ord.filter((t) => t !== from);
      for (const h of cfg.habits || []) {
        if (!Array.isArray(h.tags)) h.tags = [];
        h.tags = [...new Set(h.tags.map((t) => (t === from ? to : t)))];
      }
    } else {
      ord[fromIdx] = to;
      cfg.tagOrder = ord;
      for (const h of cfg.habits || []) {
        if (!Array.isArray(h.tags)) h.tags = [];
        h.tags = h.tags.map((t) => (t === from ? to : t));
      }
    }
    htNormalizeHabitConfig(cfg);
    this._htSchedulePersistHabitConfig();
    void this._htRefreshManageModeHabitSidebars();
  }

  _htMoveTagOrderInline(tag, delta) {
    const cfg = this._config;
    const arr = [...(cfg.tagOrder || [])];
    const i = arr.indexOf(String(tag || ''));
    const j = i + delta;
    if (i < 0 || j < 0 || j >= arr.length) return;
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
    cfg.tagOrder = arr;
    this._htSchedulePersistHabitConfig();
    void this._htRefreshManageModeHabitSidebars();
  }

  _htRemoveTagGlobally(tag) {
    const key = String(tag || '').trim();
    if (!key || key === '__untagged__') return;
    const cfg = this._config;
    for (const h of cfg.habits || []) {
      if (!Array.isArray(h.tags)) h.tags = [];
      h.tags = h.tags.filter((x) => x !== key);
    }
    cfg.tagOrder = (cfg.tagOrder || []).filter((t) => t !== key);
    this._htSchedulePersistHabitConfig();
    void this._htRefreshManageModeHabitSidebars();
  }

  _buildManageTagsBar(_state) {
    const cfg = htNormalizeHabitConfig(this._config);
    const wrap = document.createElement('div');
    wrap.className = 'ht-manage-cats-bar ht-manage-tags-bar';
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px;';
    const title = document.createElement('div');
    title.className = 'ht-manage-cats-title';
    title.style.marginBottom = '0';
    title.textContent = 'Tags';
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:10px;color:#8a7e6a;flex:1;min-width:140px;';
    hint.textContent = 'Reorder affects tag filter / picker order. × removes tag from every habit.';
    top.appendChild(title);
    top.appendChild(hint);
    wrap.appendChild(top);

    const tags = [...(cfg.tagOrder || [])];
    tags.forEach((tag, ti) => {
      const row = document.createElement('div');
      row.className = 'ht-manage-cat-row';
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'ht-nav-btn';
      up.style.fontSize = '11px';
      up.innerHTML = htIcon('chevron-up');
      up.disabled = ti <= 0;
      up.title = 'Move tag up';
      up.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._htMoveTagOrderInline(tag, -1);
      });
      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'ht-nav-btn';
      down.style.fontSize = '11px';
      down.innerHTML = htIcon('chevron-down');
      down.disabled = ti >= tags.length - 1;
      down.title = 'Move tag down';
      down.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._htMoveTagOrderInline(tag, 1);
      });
      const label = document.createElement('input');
      label.className = 'ht-input';
      label.style.cssText = 'flex:1;min-width:0;height:24px;font-size:11px;';
      label.value = tag;
      label.dataset.tagOrig = tag;
      label.placeholder = 'Tag name';
      label.addEventListener('click', (e) => e.stopPropagation());
      label.addEventListener('blur', () => {
        const from = String(label.dataset.tagOrig || '').trim();
        if (!String(label.value || '').trim()) label.value = from;
      });
      label.addEventListener('change', () => {
        const to = String(label.value || '').trim();
        const from = String(label.dataset.tagOrig || '').trim();
        if (!to) {
          label.value = from;
          return;
        }
        if (to === from) return;
        this._htRenameTagGlobally(from, to);
        label.dataset.tagOrig = to;
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ht-nav-btn';
      del.style.fontSize = '11px';
      del.innerHTML = htIcon('x');
      del.title = 'Remove tag from all habits';
      del.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._htRemoveTagGlobally(tag);
      });
      row.appendChild(up);
      row.appendChild(down);
      row.appendChild(label);
      row.appendChild(del);
      wrap.appendChild(row);
    });
    wrap.addEventListener('click', (e) => e.stopPropagation());
    return wrap;
  }

  _buildHabitManageStrip(state, habit) {
    const cfg = this._config;
    const strip = document.createElement('div');
    strip.className = 'ht-habit-manage-strip';
    const stop = (e) => e.stopPropagation();
    strip.addEventListener('click', (e) => {
      if (e.target.closest?.('.ht-habit-manage-drag-grip')) return;
      stop(e);
    });
    strip.addEventListener('mousedown', (e) => {
      if (e.target.closest?.('.ht-habit-manage-drag-grip')) return;
      stop(e);
    });

    const list = (cfg.habits || [])
      .filter((h) => !h.archived && h.categoryId === habit.categoryId)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    const idx = list.findIndex((h) => h.id === habit.id);

    const grip = document.createElement('span');
    grip.className = 'ht-habit-manage-drag-grip';
    grip.innerHTML = htIcon('grip-vertical');
    grip.title = 'Drag to reorder or move to another category';

    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'ht-nav-btn';
    up.style.fontSize = '11px';
    up.innerHTML = htIcon('chevron-up');
    up.title = 'Move habit up in this category';
    up.disabled = idx <= 0;
    up.addEventListener('click', (e) => {
      e.preventDefault();
      stop(e);
      this._htReorderHabitInCategory(habit.id, -1);
    });
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'ht-nav-btn';
    down.style.fontSize = '11px';
    down.innerHTML = htIcon('chevron-down');
    down.title = 'Move habit down in this category';
    down.disabled = idx < 0 || idx >= list.length - 1;
    down.addEventListener('click', (e) => {
      e.preventDefault();
      stop(e);
      this._htReorderHabitInCategory(habit.id, 1);
    });

    const nameIn = document.createElement('input');
    nameIn.className = 'ht-input ht-habit-manage-name';
    nameIn.value = habit.name || '';
    nameIn.placeholder = 'Habit name';
    nameIn.addEventListener('input', () => {
      habit.name = String(nameIn.value || '');
      this._htSchedulePersistHabitConfig();
    });

    const catSel = document.createElement('select');
    catSel.className = 'ht-select ht-habit-manage-cat';
    for (const c of [...(cfg.categories || [])].sort((a, b) => (a.order || 0) - (b.order || 0))) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name || c.id;
      if (c.id === habit.categoryId) o.selected = true;
      catSel.appendChild(o);
    }
    catSel.addEventListener('change', () => {
      habit.categoryId = catSel.value || habit.categoryId;
      this._htNormalizeHabitOrders();
      this._htSchedulePersistHabitConfig();
      void this._htRefreshManageModeHabitSidebars();
    });

    const repopulateTagSelect = (sel) => {
      const ord = [...(cfg.tagOrder || [])];
      const selVals = new Set((habit.tags || []).map(String));
      sel.replaceChildren();
      for (const t of ord) {
        const o = document.createElement('option');
        o.value = t;
        o.textContent = t;
        if (selVals.has(t)) o.selected = true;
        sel.appendChild(o);
      }
    };

    const rowTop = document.createElement('div');
    rowTop.className = 'ht-habit-manage-row-top';
    rowTop.appendChild(grip);
    rowTop.appendChild(up);
    rowTop.appendChild(down);
    rowTop.appendChild(nameIn);
    rowTop.appendChild(catSel);

    const tagsDetails = document.createElement('details');
    tagsDetails.className = 'ht-habit-manage-tags-details';
    tagsDetails.open = true;
    const tagsSum = document.createElement('summary');
    tagsSum.textContent = 'Tags';
    const tagsInner = document.createElement('div');
    tagsInner.className = 'ht-habit-manage-tags-inner';
    const tagsLab = document.createElement('label');
    tagsLab.textContent = 'Ctrl/Cmd-click for multiple';
    tagsLab.style.cssText = 'font-size:10px;color:#8a7e6a;';
    const tagsSel = document.createElement('select');
    tagsSel.multiple = true;
    tagsSel.className = 'ht-manage-tags-multiselect';
    tagsSel.size = 4;
    repopulateTagSelect(tagsSel);
    tagsSel.addEventListener('change', () => {
      habit.tags = Array.from(tagsSel.selectedOptions).map((o) => o.value);
      htNormalizeHabitConfig(cfg);
      this._htSchedulePersistHabitConfig();
      void this._htRefreshManageModeHabitSidebars();
    });
    tagsInner.appendChild(tagsLab);
    tagsInner.appendChild(tagsSel);
    const addWrap = document.createElement('div');
    addWrap.className = 'ht-manage-tags-add';
    const newTagIn = document.createElement('input');
    newTagIn.className = 'ht-input';
    newTagIn.placeholder = 'New tag…';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'ht-btn ht-btn-secondary ht-btn-sm';
    addBtn.textContent = 'Add';
    addBtn.addEventListener('click', (e) => {
      e.preventDefault();
      stop(e);
      const raw = String(newTagIn.value || '').trim();
      if (!raw) return;
      if (!habit.tags.includes(raw)) habit.tags.push(raw);
      if (!(cfg.tagOrder || []).includes(raw)) cfg.tagOrder.push(raw);
      newTagIn.value = '';
      htNormalizeHabitConfig(cfg);
      repopulateTagSelect(tagsSel);
      for (const o of tagsSel.options) {
        if (o.value === raw) o.selected = true;
      }
      this._htSchedulePersistHabitConfig();
      void this._htRefreshManageModeHabitSidebars();
    });
    addWrap.appendChild(newTagIn);
    addWrap.appendChild(addBtn);
    tagsInner.appendChild(addWrap);
    tagsDetails.appendChild(tagsSum);
    tagsDetails.appendChild(tagsInner);

    strip.appendChild(rowTop);
    strip.appendChild(tagsDetails);

    const adv = document.createElement('details');
    adv.className = 'ht-habit-manage-advanced';
    adv.open = true;
    const sum = document.createElement('summary');
    sum.textContent = 'Schedule, target & streak seed';
    adv.appendChild(sum);
    const inner = document.createElement('div');
    inner.className = 'ht-habit-manage-advanced-inner';

    const targetLab = document.createElement('label');
    targetLab.style.cssText = 'display:flex;flex-direction:column;gap:2px;font-size:10px;color:#8a7e6a;';
    targetLab.textContent = 'Daily target (0 = checkbox)';
    const targetIn = document.createElement('input');
    targetIn.className = 'ht-input';
    targetIn.type = 'number';
    targetIn.min = '0';
    targetIn.style.width = '72px';
    targetIn.value = habit.target > 0 ? String(habit.target) : '';
    targetIn.addEventListener('change', () => {
      const tRaw = String(targetIn.value || '').trim();
      const tVal = tRaw === '' ? 0 : parseInt(tRaw, 10);
      habit.target = Number.isInteger(tVal) && tVal > 0 ? tVal : 0;
      this._htSchedulePersistHabitConfig();
    });
    targetLab.appendChild(targetIn);

    const unitLab = document.createElement('label');
    unitLab.style.cssText = 'display:flex;flex-direction:column;gap:2px;font-size:10px;color:#8a7e6a;';
    unitLab.textContent = 'Unit';
    const unitIn = document.createElement('input');
    unitIn.className = 'ht-input';
    unitIn.style.minWidth = '80px';
    unitIn.placeholder = 'mins, reps…';
    unitIn.value = habit.unit || '';
    unitIn.addEventListener('change', () => {
      const u = String(unitIn.value || '').trim();
      habit.unit = u || null;
      this._htSchedulePersistHabitConfig();
    });
    unitLab.appendChild(unitIn);

    const wdWrap = document.createElement('div');
    wdWrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    const wdLbl = document.createElement('div');
    wdLbl.style.cssText = 'font-size:10px;color:#8a7e6a;';
    wdLbl.textContent = 'Weekdays (none = every day)';
    wdWrap.appendChild(wdLbl);
    const wdRow = document.createElement('div');
    wdRow.style.cssText = 'display:flex;gap:3px;flex-wrap:wrap;';
    const wdLabels = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    const wdSel = new Set(Array.isArray(habit.weekdays) ? habit.weekdays : []);
    for (let i = 0; i < 7; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ht-nav-btn';
      b.style.fontSize = '10px';
      b.style.padding = '2px 5px';
      b.dataset.wd = String(i);
      b.textContent = wdLabels[i];
      const paint = (on) => {
        b.classList.toggle('active', on);
      };
      paint(wdSel.has(i));
      b.addEventListener('click', (e) => {
        e.preventDefault();
        stop(e);
        const on = !b.classList.contains('active');
        paint(on);
        if (on) wdSel.add(i);
        else wdSel.delete(i);
        habit.weekdays = [...wdSel].sort((a, b) => a - b);
        this._htSchedulePersistHabitConfig();
      });
      wdRow.appendChild(b);
    }
    wdWrap.appendChild(wdRow);

    const seedLab = document.createElement('label');
    seedLab.style.cssText = 'display:flex;flex-direction:column;gap:2px;font-size:10px;color:#8a7e6a;';
    seedLab.textContent = 'Streak seed date';
    const seedIn = document.createElement('input');
    seedIn.className = 'ht-input';
    seedIn.type = 'date';
    seedIn.value = habit.seedDate || '';
    seedIn.addEventListener('change', () => {
      const prev = habit.seedDate || null;
      habit.seedDate = String(seedIn.value || '').trim() || null;
      this._htSchedulePersistHabitConfig();
      this._htOnHabitSeedDateMaybeBackfill(habit, prev);
    });
    seedLab.appendChild(seedIn);

    inner.appendChild(targetLab);
    inner.appendChild(unitLab);
    inner.appendChild(wdWrap);
    inner.appendChild(seedLab);
    adv.appendChild(inner);
    strip.appendChild(adv);

    return strip;
  }

  /**
   * Reorder / move habits between categories in manage mode (pointer-driven — HTML5 DnD is unreliable in embedded/WebView hosts).
   */
  _htWireManageModeHabitDnD(state) {
    if (!state?.bodyEl || !state.htManageMode) return;
    const body = state.bodyEl;
    const THRESH = 8;

    const clearDropVisuals = () => {
      body.querySelectorAll('.ht-habit.ht-manage-drop-before, .ht-habit.ht-manage-drop-after').forEach((el) => {
        el.classList.remove('ht-manage-drop-before', 'ht-manage-drop-after');
      });
      body.querySelectorAll('.ht-category-habits.ht-manage-dnd-target').forEach((el) => {
        el.classList.remove('ht-manage-dnd-hover', 'ht-manage-dnd-empty');
      });
    };

    const insertBeforeFromClientY = (listEl, clientY, excludeEl = null) => {
      const rows = [...listEl.querySelectorAll(':scope > .ht-habit')].filter((el) => el !== excludeEl);
      for (let i = 0; i < rows.length; i++) {
        const box = rows[i].getBoundingClientRect();
        const mid = box.top + box.height / 2;
        if (clientY < mid) return i;
      }
      return rows.length;
    };

    const paintDropIndicator = (listEl, clientY, excludeEl) => {
      clearDropVisuals();
      const beforeIdx = insertBeforeFromClientY(listEl, clientY, excludeEl);
      const rows = [...listEl.querySelectorAll(':scope > .ht-habit')].filter((el) => el !== excludeEl);
      listEl.classList.add('ht-manage-dnd-target', 'ht-manage-dnd-hover');
      if (rows.length === 0) {
        listEl.classList.add('ht-manage-dnd-empty');
        return beforeIdx;
      }
      if (beforeIdx < rows.length) rows[beforeIdx].classList.add('ht-manage-drop-before');
      else rows[rows.length - 1].classList.add('ht-manage-drop-after');
      return beforeIdx;
    };

    for (const listEl of body.querySelectorAll('.ht-category-habits[data-cat-id]')) {
      listEl.classList.add('ht-manage-dnd-target');
    }

    for (const grip of body.querySelectorAll('.ht-habit-manage-drag-grip')) {
      grip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const habitEl = grip.closest('.ht-habit');
        const hid = habitEl?.dataset?.habitId;
        if (!hid || !habitEl) return;
        e.preventDefault();
        e.stopPropagation();

        const startX = e.clientX;
        const startY = e.clientY;
        let active = false;
        const pointerId = e.pointerId;
        let lastList = null;

        const finish = () => {
          try {
            grip.releasePointerCapture(pointerId);
          } catch (_) {}
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onUp, true);
          window.removeEventListener('pointercancel', onUp, true);
          habitEl.classList.remove('ht-manage-habit-dragging');
          habitEl.style.pointerEvents = '';
        };

        const onMove = (ev) => {
          if (ev.pointerId !== pointerId) return;
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (!active) {
            if (dx * dx + dy * dy < THRESH * THRESH) return;
            active = true;
            habitEl.classList.add('ht-manage-habit-dragging');
            habitEl.style.pointerEvents = 'none';
            try {
              grip.setPointerCapture(pointerId);
            } catch (_) {}
          }
          ev.preventDefault();
          const under = document.elementFromPoint(ev.clientX, ev.clientY);
          const listEl = under?.closest?.('.ht-category-habits[data-cat-id]');
          if (!listEl || !body.contains(listEl)) {
            clearDropVisuals();
            lastList = null;
            return;
          }
          lastList = listEl;
          const rows = [...listEl.querySelectorAll(':scope > .ht-habit')].filter((el) => el !== habitEl);
          const rect = listEl.getBoundingClientRect();
          const y =
            rows.length === 0 ? ev.clientY : Math.min(Math.max(ev.clientY, rect.top + 2), rect.bottom - 2);
          listEl._htPendingDropIdx = paintDropIndicator(listEl, y, habitEl);
        };

        const onUp = (ev) => {
          if (ev.pointerId !== pointerId) return;
          finish();
          if (!active) return;

          const under = document.elementFromPoint(ev.clientX, ev.clientY);
          const listEl =
            (lastList && body.contains(lastList) ? lastList : null) ||
            under?.closest?.('.ht-category-habits[data-cat-id]');
          clearDropVisuals();

          if (listEl && body.contains(listEl)) {
            const catId = String(listEl.dataset.catId || '').trim();
            const rows = [...listEl.querySelectorAll(':scope > .ht-habit')].filter((el) => el !== habitEl);
            const rect = listEl.getBoundingClientRect();
            const y =
              rows.length === 0 ? ev.clientY : Math.min(Math.max(ev.clientY, rect.top + 2), rect.bottom - 2);
            const beforeIdx =
              typeof listEl._htPendingDropIdx === 'number'
                ? listEl._htPendingDropIdx
                : insertBeforeFromClientY(listEl, y, habitEl);
            listEl._htPendingDropIdx = undefined;
            if (hid && catId) {
              this._htMoveHabitToCategoryAtIndex(hid, catId, beforeIdx);
              this._htSchedulePersistHabitConfig();
              void this._htRefreshManageModeHabitSidebars();
            }
          } else if (lastList && body.contains(lastList)) {
            lastList._htPendingDropIdx = undefined;
          }
        };

        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
        window.addEventListener('pointercancel', onUp, true);
      });
    }
  }

  async _loadLog(dateStr) {
    const empty = () => ({ date: dateStr, completions: {}, categoryDone: {}, notes: '' });
    try {
      const rows = await this._getAllLogRows();
      const rid = htPsRowLog(dateStr);
      const tps = this._tps();
      const logRows = rows.filter((r) => (tps?.rowField?.(r, 'plugin_id') || '') === rid);
      if (logRows.length === 0) return empty();
      const merged = empty();
      for (const r of logRows) {
        const raw = this._readJsonStore(r);
        if (raw) {
          try {
            const d = JSON.parse(raw);
            Object.assign(merged.completions, d.completions || {});
            Object.assign(merged.categoryDone, d.categoryDone || {});
            if (d.notes != null && String(d.notes) !== '') merged.notes = String(d.notes);
          } catch (e) {}
        }
      }
      return merged;
    } catch (e) {}
    return empty();
  }

  /**
   * Merge log rows from Plugin Backend (`record_kind` log) keyed by `date` inside JSON.
   */
  _buildLogsByDateMapFromRows(rows) {
    const logsByDate = new Map();
    for (const r of rows) {
      const raw = this._readJsonStore(r);
      if (!raw) continue;
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        continue;
      }
      if (!data.date) continue;
      const key = data.date;
      if (!logsByDate.has(key)) {
        logsByDate.set(key, { completions: {}, categoryDone: {}, notes: '' });
      }
      const ex = logsByDate.get(key);
      Object.assign(ex.completions, data.completions || {});
      Object.assign(ex.categoryDone, data.categoryDone || {});
      if (data.notes != null && String(data.notes) !== '') ex.notes = String(data.notes);
    }
    return logsByDate;
  }

  async _getAllLogRows(force = false) {
    const now = Date.now();
    const hit = this._htLogRowsCache;
    if (!force && Array.isArray(hit?.rows) && now - (hit.ts || 0) < HT_LOG_ROWS_CACHE_TTL_MS) {
      return hit.rows;
    }
    if (this._htLogRowsInFlight) {
      try {
        return await this._htLogRowsInFlight;
      } catch (_) {}
    }
    const req = (async () => {
      const MAX_COALESCE = 14;
      let safeRows;
      for (let attempt = 0; attempt < MAX_COALESCE; attempt++) {
        const genAtStart = this._htLogRowsFetchGen || 0;
        const rows = await this._psListByKind('log');
        if (genAtStart !== (this._htLogRowsFetchGen || 0)) {
          await new Promise((r) => setTimeout(r, 0));
          continue;
        }
        safeRows = Array.isArray(rows) ? rows : [];
        this._htLogRowsCache = { ts: Date.now(), rows: safeRows };
        return safeRows;
      }
      console.warn(
        '[HabitTracker] _getAllLogRows: coalesce retry cap hit; committing last list to avoid unbounded waits'
      );
      const rows = await this._psListByKind('log');
      safeRows = Array.isArray(rows) ? rows : [];
      this._htLogRowsCache = { ts: Date.now(), rows: safeRows };
      return safeRows;
    })();
    this._htLogRowsInFlight = req;
    try {
      return await req;
    } finally {
      if (this._htLogRowsInFlight === req) this._htLogRowsInFlight = null;
    }
  }

  /** Full log map for streak rollups; bypasses TTL so patches after saves stay consistent. */
  async _loadAllLogsByDate() {
    const rows = await this._getAllLogRows(true);
    return this._buildLogsByDateMapFromRows(rows);
  }

  _getLogForDateFromMap(logsByDate, dateStr) {
    const empty = () => ({ date: dateStr, completions: {}, categoryDone: {}, notes: '' });
    const e = logsByDate.get(dateStr);
    if (!e) return empty();
    return {
      date: dateStr,
      completions: { ...e.completions },
      categoryDone: { ...e.categoryDone },
      notes: e.notes || '',
    };
  }

  _categoryStreakFromMap(catId, refDate, logsByDate, cat) {
    let streak = 0;
    let d = htDaysBefore(refDate || htToday(), 1);
    for (let i = 0; i < 3650; i++) {
      const log = logsByDate.get(d);
      if (log && log.categoryDone && log.categoryDone[catId]) {
        streak++;
        d = htDaysBefore(d, 1);
      } else if (cat?.seedDate && d >= cat.seedDate && !log) {
        streak++;
        d = htDaysBefore(d, 1);
      } else {
        break;
      }
    }
    return streak;
  }

  _habitStreakFromMap(habitId, refDate, logsByDate, habit) {
    let streak = 0;
    let d = htDaysBefore(refDate || htToday(), 1);
    for (let i = 0; i < 3650; i++) {
      if (!htHabitAppliesOnDate(habit, d)) {
        d = htDaysBefore(d, 1);
        continue;
      }
      const log = logsByDate.get(d);
      const raw = log?.completions?.[habitId];
      const norm = htCompletionNorm(raw, habit);
      if (norm.done) {
        streak++;
        d = htDaysBefore(d, 1);
      } else if (norm.kind === 'na') {
        d = htDaysBefore(d, 1);
      } else if (habit?.seedDate && d >= habit.seedDate && !log) {
        streak++;
        d = htDaysBefore(d, 1);
      } else {
        break;
      }
    }
    return streak;
  }

  /**
   * @param {{ suppressLogCacheInvalidate?: boolean, logRowsSnapshot?: unknown[] }} [opts]
   *        logRowsSnapshot: reuse one Plugin Backend list (batch backfill) to avoid N× getAllLogRows.
   */
  async _saveLog(dateStr, logData, opts = {}) {
    if (!this._htHabitsCanPersistDataRows()) return;
    const tps = this._tps();
    const suppressInv = !!opts.suppressLogCacheInvalidate;
    try {
      if (logData.notes == null) logData.notes = '';
      const rid = htPsRowLog(dateStr);
      const rows =
        Array.isArray(opts.logRowsSnapshot) ? opts.logRowsSnapshot : await this._getAllLogRows();
      const existing = rows.filter((r) => (tps.rowField?.(r, 'plugin_id') || '') === rid);
      for (const r of existing) {
        const raw = this._readJsonStore(r);
        if (raw && String(raw).trim()) {
          const toStore = { ...logData, date: dateStr };
          this._writeJsonStore(r, toStore);
          if (!suppressInv) this._htInvalidateLogRowsCache();
          return;
        }
      }
      await this._htCreateHabitDataRow({
        recordKind: 'log',
        rowPluginId: rid,
        recordTitle: dateStr,
        settingsDoc: { ...logData, date: dateStr },
      });
      if (!suppressInv) this._htInvalidateLogRowsCache();
    } catch (e) {
      console.error('[HabitTracker] Error saving log:', e);
    }
  }

  /**
   * After setting `habit.seedDate`, write real completions for each applicable day from seed → today
   * where the slot is still empty. Checkbox habits → `true`; count habits → `target` (minimum “done”).
   * Uses one log-row list + in-memory map (not per-day _loadLog) so Plugin Backend is not scanned per day.
   */
  async _htBackfillHabitSeedCompletions(habit) {
    if (!habit?.seedDate) return 0;
    const seed = habit.seedDate;
    const today = htToday();
    if (seed > today) return 0;
    if (!this._htHabitsCanPersistDataRows()) return 0;
    const cfg = this._config;
    let written = 0;
    const chunk = 8;
    const logRowsSnapshot = await this._getAllLogRows(true);
    const logsByDate = this._buildLogsByDateMapFromRows(logRowsSnapshot);
    try {
      for (let d = seed; d <= today; d = htDaysAfter(d, 1)) {
        if (!htHabitAppliesOnDate(habit, d)) continue;
        let log = logsByDate.get(d);
        if (!log) {
          log = { completions: {}, categoryDone: {}, notes: '' };
          logsByDate.set(d, log);
        }
        const norm = htCompletionNorm(log.completions[habit.id], habit);
        if (norm.kind !== 'empty') continue;
        const target = habit.target || 0;
        if (target > 0) log.completions[habit.id] = target;
        else log.completions[habit.id] = true;
        this._htRecomputeCategoryDone(log, cfg, d);
        const payload = {
          date: d,
          completions: log.completions,
          categoryDone: log.categoryDone,
          notes: log.notes || '',
        };
        await this._saveLog(d, payload, {
          suppressLogCacheInvalidate: true,
          logRowsSnapshot,
        });
        written++;
        if (written % chunk === 0) await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      this._htInvalidateLogRowsCache();
    }
    return written;
  }

  _htOnHabitSeedDateMaybeBackfill(habit, prevSeed) {
    const next = habit?.seedDate || null;
    if (!next || next === prevSeed) return;
    void (async () => {
      try {
        await this._htBackfillHabitSeedCompletions(habit);
      } catch (e) {
        console.error('[HabitTracker] seed backfill:', e);
      }
      await this.refreshAllPanels({ skipManageModeHabitSidebar: true });
    })();
  }

  // Calculate streak for a category: consecutive days (back from refDate) where categoryDone[catId] is true
  // Respects seedDate: if logs run out but seedDate is set, adds those days to the streak
  async _getCategoryStreak(catId, refDate) {
    const cat = this._config?.categories?.find((c) => c.id === catId);
    try {
      const logRows = await this._getAllLogRows();
      const logsByDate = this._buildLogsByDateMapFromRows(logRows);
      return this._categoryStreakFromMap(catId, refDate, logsByDate, cat);
    } catch (e) {
      return 0;
    }
  }

  // Calculate streak for a habit: consecutive days where completions[habitId] is true
  // Respects seedDate on the habit for bringing over existing streaks
  async _getHabitStreak(habitId, refDate) {
    const habit = this._config?.habits?.find((h) => h.id === habitId);
    try {
      const logRows = await this._getAllLogRows();
      const logsByDate = this._buildLogsByDateMapFromRows(logRows);
      return this._habitStreakFromMap(habitId, refDate, logsByDate, habit);
    } catch (e) {
      return 0;
    }
  }


  _deferPanelChanged(panel) {
    const panelId = panel?.getId?.();
    if (!panelId) return;
    const prev = this._htNavTimers.get(panelId);
    if (prev) clearTimeout(prev);
    this._htNavTimers.set(panelId, setTimeout(() => {
      this._htNavTimers.delete(panelId);
      this._onPanelChanged(panel);
    }, 150));
  }

  /** Remove sidebar when this panel is not a journal day page (avoids stale UI on other records). */
  _cleanupHabitPanel(panelId) {
    if (!panelId) return;
    htHabitsDbg({ step: '_cleanupHabitPanel', panelId });
    const nt = this._htNavTimers?.get(panelId);
    if (nt) {
      try { clearTimeout(nt); } catch (e) {}
      this._htNavTimers.delete(panelId);
    }
    const state = this._panelStates.get(panelId);
    if (state) {
      this._disposeState(state);
      this._panelStates.delete(panelId);
    }
  }

  _onPanelChanged(panel) {
    const panelId = panel?.getId?.();
    if (!panelId) {
      htHabitsDbg({ step: '_onPanelChanged', outcome: 'abort', reason: 'no_panelId' });
      return;
    }

    const panelEl = panel?.getElement?.();
    if (!panelEl) {
      htHabitsDbg({ step: '_onPanelChanged', outcome: 'cleanup', panelId, reason: 'no_panelEl' });
      this._cleanupHabitPanel(panelId);
      return;
    }

    // Only mount on journal/daily note pages
    const nav = panel?.getNavigation?.();
    const navType = nav?.type || '';
    if (navType === 'custom' || navType === 'custom_panel') {
      htHabitsDbg({ step: '_onPanelChanged', outcome: 'cleanup', panelId, reason: 'nav_is_custom', navType });
      this._cleanupHabitPanel(panelId);
      return;
    }

    const record = panel?.getActiveRecord?.();
    if (!record) {
      const hasJhsShell = !!this._states.get(panelId);
      htHabitsDbg({
        step: '_onPanelChanged',
        outcome: hasJhsShell ? 'defer' : 'cleanup',
        panelId,
        reason: 'no_active_record',
        hasJhsShell,
      });
      if (hasJhsShell) this._deferPanelChanged(panel);
      else this._cleanupHabitPanel(panelId);
      return;
    }

    // Only show on journal records (daily notes) — must have journal details
    const journalDetails = record.getJournalDetails?.();
    if (!journalDetails) {
      const journalLike = this._isJournalRecord(record, panelEl);
      htHabitsDbg({
        step: '_onPanelChanged',
        outcome: journalLike ? 'defer' : 'cleanup',
        panelId,
        reason: 'no_journal_details',
        journalLike,
        recordGuid: String(record.guid || '').slice(0, 36),
        recordName: String(record.getName?.() || '').slice(0, 80),
      });
      if (journalLike) this._deferPanelChanged(panel);
      else this._cleanupHabitPanel(panelId);
      return;
    }

    // Prefer journalDetails.date for robust date sync across all journal record GUID formats.
    let journalDateStr = htToday();
    const journalDateObj = journalDetails?.date;
    if (journalDateObj instanceof Date && !Number.isNaN(journalDateObj.getTime())) {
      const y = journalDateObj.getFullYear();
      const m = String(journalDateObj.getMonth() + 1).padStart(2, '0');
      const d = String(journalDateObj.getDate()).padStart(2, '0');
      journalDateStr = `${y}-${m}-${d}`;
    }
    const recordGuid = record.guid || '';
    const dateMatch = recordGuid.match(/(\d{4})(\d{2})(\d{2})$/);
    if (journalDateStr === htToday() && dateMatch && dateMatch[1] && dateMatch[2] && dateMatch[3]) {
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
        renderTimer: null,
        htManageMode: false,
      };
      this._panelStates.set(panelId, state);
    } else {
      // Update existing state to sync with journal date
      state.dateStr = journalDateStr;
      state.isJournalPanel = true;
    }

    const jhsShell = this._states.get(panelId);
    if (jhsShell?.bodyEl) state.jhsHabitContainer = jhsShell.bodyEl;

    htHabitsDbg({
      step: '_onPanelChanged.mount',
      panelId,
      journalDateStr,
      recordGuid: String(recordGuid).slice(0, 40),
      hasJhsShell: !!jhsShell,
      jhsBodyConnected: !!jhsShell?.bodyEl?.isConnected,
      habitContainerIsJhsBody: state.jhsHabitContainer === jhsShell?.bodyEl,
      statsMode: state.bodyEl?.dataset?.mode || null,
    });
    this._mountSidebar(panel, state);
    if (state.bodyEl?.dataset?.mode !== 'stats') {
      // Debounce render on journal page navigation to avoid lag
      if (state.renderTimer) clearTimeout(state.renderTimer);
      state.renderTimer = setTimeout(() => {
        state.renderTimer = null;
        htHabitsDbg({ step: '_onPanelChanged.schedule_renderSidebar', panelId, delayMs: 50 });
        this._renderSidebar(state);
      }, 50);
    } else {
      htHabitsDbg({ step: '_onPanelChanged.skip_renderSidebar', panelId, reason: 'stats_mode' });
    }
  }

  _onPanelClosed(panel) {
    const panelId = panel?.getId?.();
    if (!panelId) return;
    this._cleanupHabitPanel(panelId);
  }

  _disposeState(state) {
    try {
      state._htInlineDragCleanup?.();
    } catch (_) {}
    state._htInlineDragCleanup = null;
    if (state.renderTimer) clearTimeout(state.renderTimer);
    state.renderTimer = null;
    state.observer?.disconnect?.();
    state.observer = null;
    try {
      if (state.jhsExternalHeaderHost) state.jhsExternalHeaderHost.replaceChildren();
    } catch (_) {}
    state.jhsExternalHeaderHost = null;
    try { state.sidebarEl?.remove?.(); } catch(e) {}
    state.sidebarEl = null;
    state.bodyEl = null;
  }

  _mountSidebar(panel, state) {
    const panelEl = panel?.getElement?.();
    const container = this._findContainer(panelEl);
    if (!container) {
      htHabitsDbg({
        step: '_mountSidebar',
        outcome: 'skip',
        panelId: state?.panelId,
        reason: 'no_container',
        hadJhsHabitContainer: !!state.jhsHabitContainer,
        hadPanelEl: !!panelEl,
      });
      return;
    }

    // Remove any stray duplicate .ht-sidebar elements we don't own
    container.querySelectorAll('.ht-sidebar').forEach(el => {
      if (el !== state.sidebarEl) el.remove();
    });

    // Build shell if missing or disconnected
    if (!state.sidebarEl || !state.sidebarEl.isConnected) {
      state.sidebarEl?.remove?.();
      const shellSt = this._states.get(state.panelId);
      const headerHost =
        state.jhsHabitContainer && shellSt?.jhsHabitControlsEl ? shellSt.jhsHabitControlsEl : null;
      state.sidebarEl = this._buildSidebarShell(state, headerHost);
    }
    // Always refresh — async `_renderSidebar` may still hold a `body` reference to a node that
    // was detached when `.jhs-body` was cleared during a concurrent `_renderState` habit pass.
    if (state.sidebarEl) {
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

    htHabitsDbg({
      step: '_mountSidebar.done',
      panelId: state.panelId,
      containerClass: (container.className && String(container.className).slice(0, 120)) || container.nodeName,
      containerIsJhsBody: !!container?.classList?.contains?.('jhs-body'),
      sidebarConnected: !!state.sidebarEl?.isConnected,
      habitBodyConnected: !!state.bodyEl?.isConnected,
      hasHtSidebarClass: !!state.sidebarEl?.classList?.contains?.('ht-sidebar'),
    });
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

  /** Open inline stats view; optional `habitId` pre-selects that habit in the stats dropdown. */
  _habitEnterStatsView(state, opts = {}) {
    const body = state.bodyEl;
    const refs = state._htHabitShell;
    if (!body || !body.isConnected || !refs?.statsBtn) return;
    if (state.htManageMode) {
      state.htManageMode = false;
      refs.manageBtn?.classList.remove('active');
    }
    delete state._htStatsCal;
    const hid = opts && opts.habitId;
    if (hid) {
      const ok = (this._config?.habits || []).some((h) => h.id === hid && !h.archived);
      if (ok) state.statsSelected = 'habit:' + hid;
    }
    body.dataset.mode = 'stats';
    refs.statsBtn.innerHTML = htIcon('arrow-left');
    refs.statsBtn.title = 'Back to habits';
    refs.statsBtn.classList.add('active');
    refs.prevBtn.style.display = 'none';
    refs.dateEl.style.display = 'none';
    refs.nextBtn.style.display = 'none';
    if (refs.manageBtn) refs.manageBtn.style.display = 'none';
    void this._renderStats(state, body);
  }

  _habitExitStatsView(state) {
    const body = state.bodyEl;
    const refs = state._htHabitShell;
    if (!body || !body.isConnected || !refs?.statsBtn) return;
    body.dataset.mode = 'habits';
    refs.statsBtn.innerHTML = htIcon('chart-bar');
    refs.statsBtn.title = 'View stats';
    refs.statsBtn.classList.remove('active');
    if (state.isJournalPanel) {
      refs.prevBtn.style.display = 'none';
      refs.nextBtn.style.display = 'none';
    } else {
      refs.prevBtn.style.display = '';
      refs.nextBtn.style.display = '';
    }
    refs.dateEl.style.display = '';
    if (refs.manageBtn) refs.manageBtn.style.display = '';
    void this._renderSidebar(state);
  }

  /**
   * Top bar: among categories that contain ≥1 active habit, how many have ≥1 habit
   * completed today (at-least-one-per-category), not “all habits done”.
   */
  _htCategoryProgressFromLog(config, log, dateStr) {
    const d = dateStr || htToday();
    const cats = [...(config?.categories || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
    let eligible = 0;
    let done = 0;
    for (const cat of cats) {
      const habitsInCat = (config?.habits || []).filter((h) => h.categoryId === cat.id && !h.archived);
      const applying = habitsInCat.filter((h) => htHabitAppliesOnDate(h, d));
      if (applying.length === 0) continue;
      eligible++;
      const anyDone = applying.some((h) => htCompletionNorm(log.completions?.[h.id], h).done);
      if (anyDone) done++;
    }
    const pct = eligible > 0 ? Math.round((done / eligible) * 100) : 0;
    return { done, eligible, pct };
  }

  _htRecomputeCategoryDone(log, config, dateStr) {
    const d = dateStr || htToday();
    if (!log.categoryDone) log.categoryDone = {};
    for (const cat of config.categories || []) {
      const habitsInCat = (config.habits || []).filter((x) => x.categoryId === cat.id && !x.archived);
      const applying = habitsInCat.filter((h) => htHabitAppliesOnDate(h, d));
      if (applying.length === 0) {
        delete log.categoryDone[cat.id];
        continue;
      }
      const anyDone = applying.some((h) => htCompletionNorm(log.completions?.[h.id], h).done);
      if (anyDone) log.categoryDone[cat.id] = true;
      else delete log.categoryDone[cat.id];
    }
  }

  /** Advance completion: done (check) → fail (×) → N/A → clear; numeric with target snaps partial to target. */
  _htCycleHabitCompletion(log, habit, hId) {
    const h = habit;
    const raw = log.completions?.[hId];
    const norm = htCompletionNorm(raw, h);
    const target = h.target || 0;
    const hasTarget = target > 0;
    if (hasTarget) {
      if (norm.kind === 'empty') log.completions[hId] = target;
      else if (norm.done) log.completions[hId] = HT_COMP_FAIL;
      else if (norm.kind === 'fail') log.completions[hId] = HT_COMP_NA;
      else if (norm.kind === 'na') delete log.completions[hId];
      else if (norm.kind === 'partial') log.completions[hId] = target;
    } else {
      if (norm.kind === 'empty') log.completions[hId] = true;
      else if (norm.done) log.completions[hId] = HT_COMP_FAIL;
      else if (norm.kind === 'fail') log.completions[hId] = HT_COMP_NA;
      else if (norm.kind === 'na') delete log.completions[hId];
    }
  }

  _htSidebarDragClickBump(state) {
    const now = Date.now();
    if (now - (state._htSidebarDragLastUp || 0) < HT_SIDEBAR_DRAG_CLICK_GAP_MS) {
      state._htSidebarDragClickSeq = Math.min(3, (state._htSidebarDragClickSeq || 0) + 1);
    } else {
      state._htSidebarDragClickSeq = 1;
    }
    return state._htSidebarDragClickSeq;
  }

  _htSidebarDragModeFromClickCount(count) {
    if (count >= 3) return 'na';
    if (count === 2) return 'fail';
    return 'done';
  }

  _htSyncDayLogState(state, dateStr, log) {
    state._htDayLogDate = dateStr;
    state._htDayLog = JSON.parse(
      JSON.stringify(log || { date: dateStr, completions: {}, categoryDone: {}, notes: '' })
    );
    state._htDayLog.date = dateStr;
  }

  async _htEnsureSidebarDragLog(state, dateStr) {
    if (state._htSidebarDragLog && state._htSidebarDragLog.date === dateStr) {
      return state._htSidebarDragLog;
    }
    let base =
      state._htDayLogDate === dateStr && state._htDayLog
        ? state._htDayLog
        : await this._loadLog(dateStr);
    state._htSidebarDragLog = JSON.parse(JSON.stringify(base));
    state._htSidebarDragLog.date = dateStr;
    return state._htSidebarDragLog;
  }

  _htArmSidebarDragPaintFlush(state, dateStr) {
    if (state._htSidebarDragFlushArmed) return;
    state._htSidebarDragFlushArmed = true;
    const finish = async () => {
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', finish, true);
      state._htSidebarDragFlushArmed = false;
      state._htSidebarDragArmed = false;
      state._htSidebarDragMode = null;
      const seen = state._htSidebarDragSeen;
      state._htSidebarDragSeen = null;
      const batch = state._htSidebarDragLog;
      state._htSidebarDragLog = null;
      if (!batch || !seen?.size) return;
      try {
        const latest = await this._loadLog(dateStr);
        for (const hid of seen) {
          if (Object.prototype.hasOwnProperty.call(batch.completions, hid)) {
            latest.completions[hid] = batch.completions[hid];
          }
        }
        this._htRecomputeCategoryDone(latest, this._config, dateStr);
        await this._saveLog(dateStr, latest);
        this._htSyncDayLogState(state, dateStr, latest);
      } catch (_) {}
    };
    window.addEventListener('pointerup', finish, { once: true, capture: true });
    window.addEventListener('pointercancel', finish, { once: true, capture: true });
  }

  _htPaintSidebarHabitDrag(state, habitEl, dateStr, config) {
    if (!state._htSidebarDragArmed || !state._htSidebarDragMode) return false;
    const hid = habitEl?.dataset?.habitId;
    if (!hid) return false;
    if (!state._htSidebarDragSeen) state._htSidebarDragSeen = new Set();
    if (state._htSidebarDragSeen.has(hid)) return false;
    const habit = (config.habits || []).find((h) => h.id === hid && !h.archived);
    if (!habit || (habit.target || 0) > 0) return false;
    state._htSidebarDragSeen.add(hid);
    state._htSidebarDragDidPaint = true;
    const batch = state._htSidebarDragLog;
    if (!batch) return false;
    const mode = state._htSidebarDragMode;
    if (mode === 'done') batch.completions[hid] = true;
    else if (mode === 'fail') batch.completions[hid] = HT_COMP_FAIL;
    else if (mode === 'na') batch.completions[hid] = HT_COMP_NA;
    this._htRecomputeCategoryDone(batch, config, dateStr);
    this._htSyncDayLogState(state, dateStr, batch);
    void this._patchHabitEl(habitEl, habit, batch, dateStr, habit.categoryId, state);
    return true;
  }

  /** Habits always list by category; tags are a filter only (see tag filter button). */
  _htGetGroupMode() {
    return 'category';
  }

  _htAllTagsSorted(config) {
    const cfg = config || this._config || {};
    const seen = new Set();
    const fromOrder = [...(cfg.tagOrder || [])].filter(Boolean);
    for (const h of cfg.habits || []) {
      if (h.archived) continue;
      for (const t of Array.isArray(h.tags) ? h.tags.filter(Boolean) : []) seen.add(t);
    }
    const extra = [...seen].filter((t) => !fromOrder.includes(t));
    extra.sort((a, b) => String(a).localeCompare(String(b)));
    return [...fromOrder.filter((t) => seen.has(t)), ...extra];
  }

  _htGetTagFilter() {
    return String(this._htActiveTagFilter || '').trim();
  }

  _htCloseTagFilterMenu() {
    if (this._htTagFilterCloserHandler) {
      try {
        document.removeEventListener('click', this._htTagFilterCloserHandler, true);
      } catch (_) {}
      this._htTagFilterCloserHandler = null;
    }
    try {
      this._htTagFilterMenuEl?.remove?.();
    } catch (_) {}
    this._htTagFilterMenuEl = null;
  }

  _htSetTagFilter(tag) {
    const v = String(tag || '').trim();
    this._htActiveTagFilter = v;
    if (this._persistState) {
      try {
        if (v) localStorage.setItem('ht_habit_tag_filter', v);
        else localStorage.removeItem('ht_habit_tag_filter');
      } catch (_) {}
      this._htPluginSettingsFlush();
    }
    this._htCloseTagFilterMenu();
    this._htSyncTagFilterButtons();
    void this.refreshAllPanels();
  }

  _htSyncTagFilterButtons() {
    const cur = this._htGetTagFilter();
    try {
      document.querySelectorAll('.ht-tag-filter-btn').forEach((b) => {
        b.classList.toggle('active', !!cur);
        b.title = cur
          ? `Filtering by tag “${cur}”. Click to change or clear.`
          : 'Filter habits by tag';
      });
    } catch (_) {}
  }

  _htToggleTagFilterMenu(anchorBtn, state) {
    void state;
    const cfg = this._config;
    if (!cfg || !anchorBtn) return;
    if (this._htTagFilterMenuEl) {
      this._htCloseTagFilterMenu();
      return;
    }
    const tags = this._htAllTagsSorted(cfg);
    const menu = document.createElement('div');
    menu.className = 'ht-tag-filter-menu';
    menu.style.cssText =
      'position:fixed;z-index:10050;min-width:188px;max-width:min(280px,92vw);max-height:min(340px,52vh);overflow:auto;padding:8px;border:1px solid rgba(255,255,255,0.14);border-radius:10px;background:rgba(26,24,32,0.98);box-shadow:0 12px 40px rgba(0,0,0,0.45);';
    const rect = anchorBtn.getBoundingClientRect();
    menu.style.top = `${Math.round(rect.bottom + 6)}px`;
    menu.style.left = `${Math.round(Math.min(rect.left, Math.max(8, window.innerWidth - 296)))}px`;

    const mkBtn = (label, value) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ht-btn ht-btn-secondary ht-btn-sm';
      b.style.cssText =
        'display:block;width:100%;text-align:left;margin:3px 0;font-size:12px;' +
        (value === this._htGetTagFilter() ? 'border-color:rgba(124,106,247,0.55);background:rgba(124,106,247,0.12);' : '');
      b.textContent = label;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._htSetTagFilter(value);
      });
      return b;
    };
    menu.appendChild(mkBtn('All habits', ''));
    if (!tags.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:11px;color:#8a7e6a;padding:8px 4px;line-height:1.4;';
      empty.textContent = 'No tags yet — add tags in Quick-edit or Manage Habits.';
      menu.appendChild(empty);
    } else {
      for (const t of tags) menu.appendChild(mkBtn(t, t));
    }
    document.body.appendChild(menu);
    this._htTagFilterMenuEl = menu;
    this._htTagFilterCloserHandler = (ev) => {
      if (!this._htTagFilterMenuEl) return;
      if (this._htTagFilterMenuEl.contains(ev.target)) return;
      if (anchorBtn.contains(ev.target)) return;
      this._htCloseTagFilterMenu();
    };
    setTimeout(() => document.addEventListener('click', this._htTagFilterCloserHandler, true), 0);
  }

  /**
   * Month/week tallies: skip off-days and explicit `__na__` (those don't count toward totals).
   * Returns whether this calendar day contributes a completed check.
   */
  _habitRollupDaySlotForCheckCount(habit, logsByDate, dateStr) {
    if (!habit || !logsByDate || !dateStr) return null;
    if (!htHabitAppliesOnDate(habit, dateStr)) return null;
    const L = logsByDate.get(dateStr) || { completions: {}, categoryDone: {} };
    const raw = L.completions?.[habit.id];
    const norm = htCompletionNorm(raw, habit);
    if (norm.kind === 'na') return null;
    return { done: !!norm.done };
  }

  /** Completed checks in the calendar month containing `refDateStr`. */
  _habitCheckCountInMonth(habit, logsByDate, refDateStr) {
    const dt = new Date(refDateStr + 'T12:00:00');
    const y = dt.getFullYear();
    const m = dt.getMonth();
    const last = new Date(y, m + 1, 0).getDate();
    let n = 0;
    for (let day = 1; day <= last; day++) {
      const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const slot = this._habitRollupDaySlotForCheckCount(habit, logsByDate, ds);
      if (slot?.done) n++;
    }
    return n;
  }

  /** Completed checks Sun–Sat week containing `refDateStr` (Sunday start). */
  _habitCheckCountWeekSun(habit, logsByDate, refDateStr) {
    const dow = new Date(refDateStr + 'T12:00:00').getDay();
    const sun = htDaysBefore(refDateStr, dow);
    let n = 0;
    for (let i = 0; i < 7; i++) {
      const ds = htDaysAfter(sun, i);
      const slot = this._habitRollupDaySlotForCheckCount(habit, logsByDate, ds);
      if (slot?.done) n++;
    }
    return n;
  }

  /** Calendar days in the month of `refDateStr` where ≥1 habit in `habits` was completed (same rules as per-habit rollups). */
  _categoryDistinctDoneDaysInMonth(habits, logsByDate, refDateStr) {
    if (!Array.isArray(habits) || !habits.length || !logsByDate || !refDateStr) return 0;
    const dt = new Date(refDateStr + 'T12:00:00');
    const y = dt.getFullYear();
    const m = dt.getMonth();
    const last = new Date(y, m + 1, 0).getDate();
    let n = 0;
    for (let day = 1; day <= last; day++) {
      const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      let any = false;
      for (const h of habits) {
        const slot = this._habitRollupDaySlotForCheckCount(h, logsByDate, ds);
        if (slot?.done) {
          any = true;
          break;
        }
      }
      if (any) n++;
    }
    return n;
  }

  /** Sun–Sat week containing `refDateStr`: days where ≥1 habit in `habits` was completed. */
  _categoryDistinctDoneDaysInWeekSun(habits, logsByDate, refDateStr) {
    if (!Array.isArray(habits) || !habits.length || !logsByDate || !refDateStr) return 0;
    const dow = new Date(refDateStr + 'T12:00:00').getDay();
    const sun = htDaysBefore(refDateStr, dow);
    let n = 0;
    for (let i = 0; i < 7; i++) {
      const ds = htDaysAfter(sun, i);
      let any = false;
      for (const h of habits) {
        const slot = this._habitRollupDaySlotForCheckCount(h, logsByDate, ds);
        if (slot?.done) {
          any = true;
          break;
        }
      }
      if (any) n++;
    }
    return n;
  }

  /**
   * Streak meter within each 365-day lap: **linear** fill (day N of 365 → N/365) so e.g. day 65
   * in year two reads as ~18% full, not log-inflated. `yearsCompleted` is ⌊streak/365⌋; ★ tier badge
   * marks completed 365-day milestones.
   */
  _htHabitYearMeter(streakDays) {
    if (!streakDays || streakDays <= 0) {
      return { pct: 0, yearsCompleted: 0, inYearDay: 0, atYearBoundary: false };
    }
    const yearsCompleted = Math.floor(streakDays / 365);
    const inYearDay = ((streakDays - 1) % 365) + 1;
    const pct = Math.min(100, Math.round((inYearDay / 365) * 100));
    const atYearBoundary = streakDays % 365 === 0;
    return { pct, yearsCompleted, inYearDay, atYearBoundary };
  }

  _buildSidebarShell(state, headerHost = null) {
    // Each panel tracks its own viewed date, defaulting to today
    if (!state.dateStr) state.dateStr = htToday();
    const isEmbeddedInSuite = !!headerHost;
    const startCollapsed = !isEmbeddedInSuite && !!this._collapsed;

    const sidebar = document.createElement('div');
    sidebar.className =
      'ht-sidebar' + (isEmbeddedInSuite ? ' ht-embedded' : '') + (startCollapsed ? ' ht-collapsed' : '');

    const header = document.createElement('div');
    header.className = 'ht-sidebar-header';

    let toggleBtn = null;
    if (!isEmbeddedInSuite) {
      toggleBtn = document.createElement('button');
      toggleBtn.className = 'ht-toggle-btn';
      toggleBtn.title = this._collapsed ? 'Expand habits' : 'Collapse habits';
      toggleBtn.innerHTML = this._collapsed ? htIcon('chevron-down') : htIcon('chevron-up');
      toggleBtn.addEventListener('click', () => this._toggleCollapse());
    }

    // Date nav: prev arrow — date label — next arrow
    const prevBtn = document.createElement('button');
    prevBtn.className = 'ht-nav-btn';
    prevBtn.innerHTML = htIcon('chevron-left');
    prevBtn.title = 'Previous day';

    const dateEl = document.createElement('span');
    dateEl.className = 'ht-date-label';

    const nextBtn = document.createElement('button');
    nextBtn.className = 'ht-nav-btn';
    nextBtn.innerHTML = htIcon('chevron-right');
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
      nextBtn.classList.toggle('ht-nav-btn-muted', isToday);
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
    statsBtn.innerHTML = htIcon('chart-bar');
    statsBtn.title = 'View stats';

    const enterStats = () => {
      this._habitEnterStatsView(state);
    };
    const exitStats = () => {
      this._habitExitStatsView(state);
    };

    statsBtn.addEventListener('click', () => {
      const b = state.bodyEl;
      if (b?.dataset?.mode === 'stats') exitStats();
      else enterStats();
    });

    const tagFilterBtn = document.createElement('button');
    tagFilterBtn.type = 'button';
    tagFilterBtn.className = 'ht-nav-btn ht-tag-filter-btn';
    tagFilterBtn.innerHTML = htIcon('sunrise');
    tagFilterBtn.title = this._htGetTagFilter()
      ? `Filtering by tag “${this._htGetTagFilter()}”. Click to change or clear.`
      : 'Filter habits by tag';
    tagFilterBtn.style.fontSize = '12px';
    tagFilterBtn.classList.toggle('active', !!this._htGetTagFilter());
    tagFilterBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._htToggleTagFilterMenu(tagFilterBtn, state);
    });

    const catExpandToggleBtn = document.createElement('button');
    catExpandToggleBtn.type = 'button';
    catExpandToggleBtn.className = 'ht-nav-btn ht-cat-expand-toggle';
    catExpandToggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cats = this._config?.categories || [];
      if (!cats.length) return;
      const anyExpanded = cats.some((c) => !this._catCollapsed[c.id]);
      this._htSetAllCategoriesCollapsed(state, anyExpanded);
    });
    state._htCatExpandToggleBtn = catExpandToggleBtn;

    /**
     * Inline manage toggle — standalone sidebar only. When habits are embedded in Journal Header Suite,
     * the suite header gear (left) opens the same mode so we hide this duplicate control.
     */
    let manageBtn = null;
    if (!isEmbeddedInSuite) {
      manageBtn = document.createElement('button');
      manageBtn.type = 'button';
      manageBtn.className = 'ht-nav-btn ht-manage-toggle';
      manageBtn.innerHTML = htIcon('list-details');
      manageBtn.title = state.htManageMode ? 'Done editing habits' : 'Edit habits & layout (inline)';
      manageBtn.classList.toggle('active', !!state.htManageMode);
      manageBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.htManageMode = !state.htManageMode;
        manageBtn.classList.toggle('active', state.htManageMode);
        manageBtn.title = state.htManageMode ? 'Done editing habits' : 'Edit habits & layout (inline)';
        void this._renderSidebar(state);
      });
    }
    state._htManageToggleBtn = manageBtn;

    // Search button + input
    const searchBtn = document.createElement('button');
    searchBtn.className = 'ht-nav-btn';
    searchBtn.innerHTML = htIcon('search');
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
    searchClose.innerHTML = htIcon('x');
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
      const collapsed = !isEmbeddedInSuite && sidebar.classList.contains('ht-collapsed');
      prevBtn.style.display = collapsed ? 'none' : '';
      dateEl.style.display = collapsed ? 'none' : '';
      nextBtn.style.display = collapsed ? 'none' : '';
      statsBtn.style.display = collapsed ? 'none' : '';
      tagFilterBtn.style.display = collapsed ? 'none' : '';
      catExpandToggleBtn.style.display = collapsed ? 'none' : '';
      if (manageBtn) manageBtn.style.display = collapsed ? 'none' : '';
      searchBtn.style.display = collapsed || searchOpen ? 'none' : '';
      searchWrap.style.display = collapsed ? 'none' : (searchOpen ? 'flex' : 'none');
      if (state._htRibbonEl) {
        const rib = state._htRibbonEl;
        rib.hidden = collapsed || rib.childElementCount === 0;
      }
      this._htSyncCategoryExpandToggleBtn(state);
    };
    this._htSyncTagFilterButtons();

    // Patch _toggleCollapse to also update visibility (standalone sidebar only)
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => setTimeout(updateNavVisibility, 0));
      header.appendChild(toggleBtn);
    }
    header.appendChild(prevBtn);
    header.appendChild(dateEl);
    header.appendChild(nextBtn);
    header.appendChild(catExpandToggleBtn);
    header.appendChild(tagFilterBtn);
    if (manageBtn) header.appendChild(manageBtn);
    header.appendChild(statsBtn);
    header.appendChild(searchBtn);
    header.appendChild(searchWrap);

    const ribbonEl = document.createElement('div');
    ribbonEl.className = 'ht-habit-section-ribbon';
    ribbonEl.hidden = true;

    const headerStack = document.createElement('div');
    headerStack.className = 'ht-header-stack';
    headerStack.appendChild(header);
    headerStack.appendChild(ribbonEl);
    state._htRibbonEl = ribbonEl;
    updateNavVisibility();

    const body = document.createElement('div');
    body.className = 'ht-sidebar-body';

    if (headerHost) {
      try { headerHost.replaceChildren(); } catch (_) {}
      header.classList.add('ht-jhs-header-host');
      headerHost.appendChild(headerStack);
      state.jhsExternalHeaderHost = headerHost;
    } else {
      state.jhsExternalHeaderHost = null;
      sidebar.appendChild(headerStack);
    }
    sidebar.appendChild(body);

    state._htHabitShell = { statsBtn, prevBtn, dateEl, nextBtn, manageBtn };

    return sidebar;
  }

  _toggleCollapse() {
    this._collapsed = !this._collapsed;
    if (this._persistState) {
      localStorage.setItem('ht_sidebar_collapsed', String(this._collapsed));
      this._htPluginSettingsFlush();
    }
    for (const [, state] of (this._panelStates || new Map())) {
      if (!state.sidebarEl) continue;
      // Embedded-in-suite habit panels have no collapse affordance; keep them expanded.
      const isEmbeddedInSuite = !!state.jhsExternalHeaderHost;
      state.sidebarEl.classList.toggle('ht-collapsed', isEmbeddedInSuite ? false : this._collapsed);
      const btn =
        state.sidebarEl.querySelector('.ht-toggle-btn') ||
        state.jhsExternalHeaderHost?.querySelector?.('.ht-toggle-btn');
      if (btn) {
        btn.innerHTML = this._collapsed ? htIcon('chevron-down') : htIcon('chevron-up');
        btn.title = this._collapsed ? 'Expand habits' : 'Collapse habits';
      }
      const collapsedEff = isEmbeddedInSuite ? false : this._collapsed;
      if (state._htRibbonEl) {
        const rib = state._htRibbonEl;
        rib.hidden = collapsedEff || rib.childElementCount === 0;
      }
    }
  }

  // ── Render sidebar ───────────────────────────────────────────────────────

  // Guard helper — check if we should abort mid-render
  _inStatsMode(state) {
    return state.bodyEl?.dataset?.mode === 'stats';
  }

  /** 7d/30d stats window — persisted across journal navigation (same as sidebar collapse) */
  _getStatsRangeDays(state) {
    const stored = this._persistState ? parseInt(localStorage.getItem('ht_stats_range'), 10) : NaN;
    if (stored === 7 || stored === 30) return stored;
    const mem = state.statsRange === 90 ? 30 : state.statsRange;
    if (mem === 7 || mem === 30) return mem;
    return this._collapsed ? 30 : 7;
  }

  _persistStatsRangeDays(state, days) {
    state.statsRange = days;
    if (this._persistState) {
      localStorage.setItem('ht_stats_range', String(days));
      this._htPluginSettingsFlush();
    }
  }

  /** Day notes textarea under the habit list; persists to log record `notes` field + JSON. */
  _renderNotesSection(body, log, dateStr, state, token) {
    const stale = () => state._renderToken !== token || this._inStatsMode(state);
    body.querySelector('.ht-notes-wrap')?.remove();
    if (this._config && this._config.showDayNotes === false) {
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'ht-notes-wrap';
    const label = document.createElement('div');
    label.className = 'ht-notes-label';
    label.textContent = 'Notes';
    const ta = document.createElement('textarea');
    ta.className = 'ht-notes-input';
    ta.rows = 2;
    ta.placeholder = 'Notes for this day…';
    ta.value = log.notes || '';
    ta.setAttribute('spellcheck', 'true');

    const flush = async () => {
      if (stale()) return;
      clearTimeout(state._notesSaveTimer);
      const text = ta.value;
      const fresh = await this._loadLog(dateStr);
      if (stale()) return;
      fresh.notes = text;
      await this._saveLog(dateStr, fresh);
    };

    ta.addEventListener('input', () => {
      clearTimeout(state._notesSaveTimer);
      state._notesSaveTimer = setTimeout(() => { void flush(); }, 450);
    });
    ta.addEventListener('blur', () => { void flush(); });

    wrap.appendChild(label);
    wrap.appendChild(ta);
    body.appendChild(wrap);
  }

  _htSidebarSections(config, state, dateStr) {
    const query = (state._searchQuery || '').trim().toLowerCase();
    const hideOff = !!config.hideOffDayHabits;
    const tagFilter = this._htGetTagFilter();
    const manage = !!state?.htManageMode;
    const passes = (h) => {
      if (h.archived) return false;
      if (manage) return true;
      if (hideOff && !htHabitAppliesOnDate(h, dateStr)) return false;
      if (!query) return true;
      return String(h.name || '').toLowerCase().includes(query);
    };
    const passesTag = (h) => {
      if (manage) return true;
      if (!tagFilter) return true;
      const tags = Array.isArray(h.tags) ? h.tags.filter(Boolean) : [];
      return tags.includes(tagFilter);
    };

    const out = [];
    const sortedCats = [...config.categories].sort((a, b) => (a.order || 0) - (b.order || 0));
    for (const cat of sortedCats) {
      const habits = config.habits
        .filter((h) => h.categoryId === cat.id && passes(h) && passesTag(h))
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      if (!manage && habits.length === 0) continue;
      out.push({ kind: 'category', cat, habits });
    }
    return out;
  }

  /**
   * Gallery-style ribbon: when ribbon mode is on, collapsed sections appear as chips under the header.
   */
  _htFillHabitRibbon(state, config, dateStr, logsByDate) {
    const ribbon = state._htRibbonEl || state.sidebarEl?.querySelector?.('.ht-habit-section-ribbon');
    if (!ribbon) return;
    const standaloneCollapsed =
      !state.jhsExternalHeaderHost && state.sidebarEl?.classList?.contains('ht-collapsed');
    if (standaloneCollapsed) {
      ribbon.hidden = true;
      return;
    }
    const sections = this._htSidebarSections(config, state, dateStr);
    const ribbonSecs = sections.filter((s) => s.kind === 'category');
    /* Ribbon only meaningful when at least one section is collapsed (chip visible). */
    const anyCollapsedChip = ribbonSecs.some((s) => !!this._catCollapsed[s.cat.id]);
    if (!ribbonSecs.length || !anyCollapsedChip) {
      ribbon.replaceChildren();
      ribbon.hidden = true;
      return;
    }

    const log = this._getLogForDateFromMap(logsByDate, dateStr);
    ribbon.replaceChildren();

    for (const sec of ribbonSecs) {
      const isExpanded = !this._catCollapsed[sec.cat.id];
      if (isExpanded) {
        const ph = document.createElement('div');
        ph.className = 'ht-ribbon-slot ht-ribbon-slot--expanded';
        ph.dataset.catId = sec.cat.id;
        ph.setAttribute('role', 'button');
        ph.tabIndex = 0;
        ph.setAttribute('aria-label', `Collapse ${sec.cat.name || 'category'}`);
        ph.title = `Collapse “${sec.cat.name || 'category'}”`;
        const collapseThis = (e) => {
          e.preventDefault();
          e.stopPropagation();
          this._catCollapsed[sec.cat.id] = true;
          if (this._persistState) {
            localStorage.setItem('ht_cat_collapsed', JSON.stringify(this._catCollapsed));
            this._htPluginSettingsFlush();
          }
          void this._renderSidebar(state);
        };
        ph.addEventListener('click', collapseThis);
        ph.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            collapseThis(e);
          }
        });
        ribbon.appendChild(ph);
        continue;
      }

      const chipStreak = this._categoryStreakFromMap(sec.cat.id, undefined, logsByDate, sec.cat);
      const applying = sec.habits.filter((h) => htHabitAppliesOnDate(h, dateStr));
      const chipDaySt = htCategoryDayAggregateStatus(log, applying, dateStr);
      const marked = htCategoryAllMarkedForDay(log, applying, dateStr);
      const leadHtml = htRibbonLeadCellHtml(chipDaySt, marked);
      const streakPart = chipStreak > 0 ? htRibbonStreakHtml(chipStreak) : '';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ht-ribbon-sec';
      btn.dataset.catId = sec.cat.id;
      btn.innerHTML =
        `<span class="ht-ribbon-sec-inner">${leadHtml}` +
        `<span class="ht-ribbon-sec-glyph">${htCategoryGlyphHtml(sec.cat.emoji)}</span>` +
        `<span class="ht-ribbon-sec-tail">${streakPart}</span></span>`;
      const dayHint =
        chipDaySt === 'all_done'
          ? ' · all done today'
          : chipDaySt === 'partial'
            ? ' · in progress'
            : chipDaySt === 'na'
              ? ' · N/A today'
              : chipDaySt === 'fail'
                ? ' · missed today'
                : '';
      btn.title = `${sec.cat.name}${dayHint}${chipStreak > 0 ? ` · ${chipStreak}d streak` : ''} — tap to expand`;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._catCollapsed[sec.cat.id] = false;
        if (this._persistState) {
          localStorage.setItem('ht_cat_collapsed', JSON.stringify(this._catCollapsed));
          this._htPluginSettingsFlush();
        }
        void this._renderSidebar(state);
      });
      ribbon.appendChild(btn);
    }
    ribbon.hidden = false;
  }

  async _renderSidebar(state) {
    let body = state.bodyEl;
    if (!body || !body.isConnected || this._inStatsMode(state)) {
      htHabitsDbg({
        step: '_renderSidebar.abort_entry',
        panelId: state?.panelId,
        hasBody: !!body,
        bodyConnected: !!body?.isConnected,
        inStatsMode: this._inStatsMode(state),
        statsDataset: state.bodyEl?.dataset?.mode ?? null,
      });
      return;
    }

    // Mark this render with a token — if a newer render starts, this one aborts
    const token = (state._renderToken || 0) + 1;
    state._renderToken = token;
    const stale = () => state._renderToken !== token || this._inStatsMode(state);
    const bodyDetached = () => {
      body = state.bodyEl;
      return !body || !body.isConnected;
    };

    const config = this._config;

    if (!state.htManageMode && state._htInlineDragCleanup) {
      try {
        state._htInlineDragCleanup();
      } catch (_) {}
      state._htInlineDragCleanup = null;
    }

    htHabitsDbg({
      step: '_renderSidebar.start',
      panelId: state.panelId,
      token,
      dateStr: state.dateStr || null,
      configPresent: !!config,
      categoryCount: config?.categories?.length ?? 0,
      habitCount: config?.habits?.filter?.((h) => !h.archived)?.length ?? 0,
      searchQuery: state._searchQuery || '',
    });

    if (!config || config.categories.length === 0) {
      if (stale() || bodyDetached()) {
        htHabitsDbg({ step: '_renderSidebar.abort_empty_config', panelId: state.panelId, token, reason: 'stale_or_detached_before_logs' });
        return;
      }
      const dateStrEmpty = state.dateStr || htToday();
      const logRowsEmpty = await this._getAllLogRows();
      if (stale() || bodyDetached()) {
        htHabitsDbg({ step: '_renderSidebar.abort_empty_config', panelId: state.panelId, token, reason: 'stale_or_detached_after_getAllLogRows' });
        return;
      }
      const logEmpty = this._getLogForDateFromMap(this._buildLogsByDateMapFromRows(logRowsEmpty), dateStrEmpty);
      body.innerHTML = '';
      if (state.htManageMode) {
        const editorShell = document.createElement('div');
        editorShell.className = 'ht-inline-manage-editor-shell';
        editorShell.style.cssText =
          'margin-bottom:12px;padding:12px;border:1px solid rgba(255,255,255,0.1);border-radius:10px;background:rgba(255,255,255,0.03);';
        this._renderSettings(editorShell, this._config, {
          panelState: state,
          layoutAsIcons: true,
        });
        body.appendChild(editorShell);
        body.classList.toggle('ht-habit-layout-single-col', this._htReadHabitLayoutSingleColumn());
        body.classList.toggle('ht-manage-mode', true);
        try {
          state._htInlineDragCleanup?.();
        } catch (_) {}
        const dragCleanups = [
          this._htAttachSettingsDragBridge(state.sidebarEl),
          this._htAttachSettingsDragBridge(state.bodyEl),
        ];
        state._htInlineDragCleanup = () => {
          for (const fn of dragCleanups) {
            try {
              fn();
            } catch (_) {}
          }
        };
        this._renderNotesSection(body, logEmpty, dateStrEmpty, state, token);
        htHabitsDbg({
          step: '_renderSidebar.empty_config_manage_editor',
          panelId: state.panelId,
          token,
          dateStr: dateStrEmpty,
        });
        return;
      }
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'ht-empty';
      emptyDiv.innerHTML = `
        <div class="ht-empty-icon">${htIcon('plant')}</div>
        <div>No habits yet.</div>
        <div style="margin-top:4px;font-size:11px;">Turn on inline editing (suite gear or toolbar) to add categories and habits.</div>
        <button class="ht-setup-btn" data-action="open-settings">Set up habits</button>
      `;
      emptyDiv.querySelector('[data-action="open-settings"]')?.addEventListener('click', () => this.openSettings());
      body.appendChild(emptyDiv);
      body.classList.toggle('ht-habit-layout-single-col', this._htReadHabitLayoutSingleColumn());
      this._renderNotesSection(body, logEmpty, dateStrEmpty, state, token);
      htHabitsDbg({ step: '_renderSidebar.empty_config_rendered', panelId: state.panelId, token, dateStr: dateStrEmpty });
      return;
    }

    // One Plugin Backend load: log rows + merged map for streak badges
    const dateStr = state.dateStr || htToday();
    const logRows = await this._getAllLogRows();
    if (stale() || bodyDetached()) {
      htHabitsDbg({
        step: '_renderSidebar.abort_main',
        panelId: state.panelId,
        token,
        reason: stale() ? 'stale_token_or_stats' : 'body_detached',
        dateStr,
      });
      return;
    }
    const logsByDate = this._buildLogsByDateMapFromRows(logRows);
    const log = this._getLogForDateFromMap(logsByDate, dateStr);
    this._htSyncDayLogState(state, dateStr, log);

    // Progress bar — categories with ≥1 habit done today (unfiltered full setup).
    const activeTagF = this._htGetTagFilter();
    const { done: catDoneCount, eligible: catEligible, pct } = this._htCategoryProgressFromLog(config, log, dateStr);
    const progressTitle =
      catEligible > 0
        ? `${catDoneCount} of ${catEligible} categories with at least one habit done today${
            activeTagF ? ` (filtered: ${activeTagF})` : ''
          }`
        : '';

    // If stats view is in body, clear it first
    if (body.querySelector('.ht-stats-view')) body.innerHTML = '';

    let progressWrap = body.querySelector('.ht-progress');
    if (!progressWrap) {
      progressWrap = document.createElement('div');
      progressWrap.className = 'ht-progress';
      progressWrap.title = progressTitle;
      progressWrap.innerHTML = `<div class="ht-progress-fill" style="width:${pct}%;background:${htCategoryProgressFillStyle(pct)}"></div>`;
      body.insertBefore(progressWrap, body.firstChild);
    } else {
      progressWrap.title = progressTitle;
      const fill = progressWrap.querySelector('.ht-progress-fill');
      if (fill) {
        fill.style.width = pct + '%';
        fill.style.background = htCategoryProgressFillStyle(pct);
      }
    }
    if (progressWrap) progressWrap.style.display = '';

    body.classList.toggle('ht-habit-layout-single-col', this._htReadHabitLayoutSingleColumn());

    // Build into a fragment first — swap in one shot to avoid collapse during awaits
    const fragment = document.createDocumentFragment();
    if (state.htManageMode) {
      const editorShell = document.createElement('div');
      editorShell.className = 'ht-inline-manage-editor-shell';
      editorShell.style.cssText =
        'margin-bottom:12px;padding:12px;border:1px solid rgba(255,255,255,0.1);border-radius:10px;background:rgba(255,255,255,0.03);';
      this._renderSettings(editorShell, this._config, {
        panelState: state,
        layoutAsIcons: true,
      });
      fragment.appendChild(editorShell);
      fragment.appendChild(this._buildManageCategoriesBar(state));
    }
    if (state.htManageMode) {
      fragment.appendChild(this._buildManageTagsBar(state));
    }

    const sections = this._htSidebarSections(config, state, dateStr);
    let secWalk = 0;
    for (const sec of sections) {
      secWalk++;
      if (secWalk % 8 === 0) {
        await new Promise((r) => setTimeout(r, 0));
        if (stale() || bodyDetached()) return;
      }

      const query = state._searchQuery || '';
      const visibleHabits = sec.habits;
      const cat = sec.cat;

      const applying = visibleHabits.filter((h) => htHabitAppliesOnDate(h, dateStr));
      const catDayStatus = htCategoryDayAggregateStatus(log, applying, dateStr);
      const doneSlotHtml = htCategoryDayLeadInnerHtml(catDayStatus);
      const markedDotHtml = htCategoryAllMarkedForDay(log, applying, dateStr)
        ? `<span class="ht-cat-marked-dot" title="All habits tended to" aria-hidden="true"></span>`
        : '';
      const streak = this._categoryStreakFromMap(cat.id, undefined, logsByDate, cat);
      const streakBadgeHtml = streak > 0 ? htCategoryStreakBadgeHtml(streak) : '';
      const isOpen = !this._catCollapsed[cat.id];
      const headerEmojiHtml = htCategoryGlyphHtml(cat.emoji);
      const headerNameHtml = htEsc(cat.name);

      const ribbonMode = this._htHabitRibbonMode;
      const showInlineHeader = !ribbonMode || isOpen;
      const galleryHdr = ribbonMode && isOpen;

      let catRollHtml = '';
      if (isOpen && visibleHabits.length) {
        const catMo = this._categoryDistinctDoneDaysInMonth(visibleHabits, logsByDate, dateStr);
        const catWk = this._categoryDistinctDoneDaysInWeekSun(visibleHabits, logsByDate, dateStr);
        catRollHtml =
          `<span class="ht-category-roll ht-habit-stat-counts" title="Days this calendar month / this week (Sun–Sat) with at least one habit done">` +
          `<span class="ht-roll-num">${catMo}</span><span class="ht-roll-suffix">30d</span>` +
          `<span class="ht-roll-sep">·</span>` +
          `<span class="ht-roll-num">${catWk}</span><span class="ht-roll-suffix">7d</span>` +
          `</span>`;
      }

      const catEl = document.createElement('div');
      catEl.className = 'ht-category';

      let catHeader = null;
      if (showInlineHeader) {
        catHeader = document.createElement('div');
        catHeader.className =
          'ht-category-header' + (galleryHdr ? ' ht-category-header--gallery' : '');
        if (galleryHdr) {
          catHeader.innerHTML = `
        <div class="ht-category-header-inner">
          <span class="ht-ch-lead-spacer" aria-hidden="true"></span>
          <span class="ht-ch-cluster">
            <span class="ht-category-caret ${isOpen ? 'open' : ''}">${htIcon('chevron-right')}</span>
            <span class="ht-ch-cat-done-wrap">${doneSlotHtml}</span>
              <span class="ht-ch-cat-marked">${markedDotHtml}</span>
            <span class="ht-category-emoji">${headerEmojiHtml}</span>
            <span class="ht-category-name ht-category-name--gallery">${headerNameHtml}</span>
            ${streakBadgeHtml}${catRollHtml}
          </span>
          <span class="ht-ch-trailing" aria-hidden="true"></span>
        </div>`;
        } else {
          catHeader.innerHTML = `
        <div class="ht-category-header-inner">
          <span class="ht-ch-lead-spacer" aria-hidden="true"></span>
          <span class="ht-ch-cluster">
            <span class="ht-category-caret ${isOpen ? 'open' : ''}">${htIcon('chevron-right')}</span>
            <span class="ht-ch-cat-done-wrap">${doneSlotHtml}</span>
            <span class="ht-ch-cat-marked">${markedDotHtml}</span>
            <span class="ht-category-emoji">${headerEmojiHtml}</span>
            <span class="ht-category-name">${headerNameHtml}</span>
            ${streakBadgeHtml}${catRollHtml}
          </span>
          <span class="ht-ch-trailing" aria-hidden="true"></span>
        </div>`;
        }
        catHeader.addEventListener('click', () => {
          this._toggleCategory(cat.id, state);
        });
      }

      const habitsEl = document.createElement('div');
      habitsEl.className = 'ht-category-habits' + ((isOpen || query) ? '' : ' ht-hidden');
      habitsEl.dataset.catId = cat.id;
      delete habitsEl.dataset.tagKey;

      for (const habit of visibleHabits) {
        const rawVal = log.completions[habit.id];
        const surf = htHabitDaySurface(log, habit, dateStr);
        const norm = htCompletionNorm(rawVal, habit);
        const hasTarget = (habit.target || 0) > 0;
        const isNumeric = hasTarget;
        const currentVal = typeof rawVal === 'number' ? rawVal : rawVal === true ? 1 : 0;
        const isDone = norm.done;
        const hStreak = this._habitStreakFromMap(habit.id, undefined, logsByDate, habit);

        const rowCls = ['ht-habit'];
        if (isDone) rowCls.push('ht-done');
        if (surf.offDay) rowCls.push('ht-habit-offday');
        if (norm.kind === 'fail') rowCls.push('ht-fail');
        if (norm.kind === 'na' || (surf.displayNa && norm.kind === 'empty')) rowCls.push('ht-na');

        const habitEl = document.createElement('div');
        habitEl.className = rowCls.join(' ');
        habitEl.dataset.habitId = habit.id;

        let indicatorHTML = '';
        if (norm.kind === 'fail') {
          indicatorHTML = `<div class="ht-habit-mark ht-habit-mark-fail" aria-hidden="true">×</div>`;
        } else if (norm.kind === 'na' || (surf.displayNa && norm.kind === 'empty')) {
          indicatorHTML = `<div class="ht-habit-mark ht-habit-mark-na" aria-hidden="true">/</div>`;
        } else if (isNumeric) {
          const r = 10;
          const circ = 2 * Math.PI * r;
          const pRing = Math.min(1, currentVal / habit.target);
          const dash = circ * pRing;
          const label = currentVal >= habit.target ? htIcon('check') : `${currentVal}`;
          indicatorHTML = `
            <div class="ht-habit-ring">
              <svg width="26" height="26" viewBox="0 0 26 26">
                <circle class="ht-habit-ring-bg" cx="13" cy="13" r="${r}"/>
                <circle class="ht-habit-ring-fill" cx="13" cy="13" r="${r}"
                  stroke-dasharray="${circ}"
                  stroke-dashoffset="${circ - dash}"/>
              </svg>
              <div class="ht-habit-ring-label">${label}</div>
            </div>`;
        } else {
          indicatorHTML = `<div class="ht-habit-check-minimal"><span class="ht-check-glyph">${
            isDone ? htIcon('check') : htIcon('check', 'ht-check-faint')
          }</span></div>`;
        }

        const unitLabel = habit.unit ? htEsc(habit.unit) : '';
        const targetLabel = hasTarget
          ? `<span style="font-size:10px;color:#8a7e6a;margin-left:2px;">${currentVal}/${habit.target}${
              unitLabel ? ' ' + unitLabel : ''
            }</span>`
          : '';
        const moChecks = this._habitCheckCountInMonth(habit, logsByDate, dateStr);
        const wkChecks = this._habitCheckCountWeekSun(habit, logsByDate, dateStr);
        const streakCore = hStreak > 0 ? htHabitStreakCoreHtml(hStreak, hStreak >= 7) : '';
        const cntSeg =
          `<span class="ht-habit-stat-counts">` +
          `<span class="ht-roll-num">${moChecks}</span><span class="ht-roll-suffix">30d</span>` +
          `<span class="ht-roll-sep">·</span>` +
          `<span class="ht-roll-num">${wkChecks}</span><span class="ht-roll-suffix">7d</span>` +
          `</span>`;
        const streakLabel = streakCore
          ? `${streakCore}<span class="ht-streak-dotsep"> · </span>${cntSeg}`
          : cntSeg;
        const yearM = this._htHabitYearMeter(hStreak);
        const tierBadge =
          yearM.yearsCompleted > 0
            ? `<span class="ht-year-tier" title="${yearM.yearsCompleted}×365d streak milestone">★${yearM.yearsCompleted}</span>`
            : '';
        const boundaryMark = yearM.atYearBoundary
          ? `<span class="ht-year-boundary" title="365-day milestone">✓</span>`
          : '';
        const meterHtml =
          hStreak > 0
            ? `<div class="ht-habit-streak-meter-wrap">${tierBadge}${boundaryMark}<div class="ht-habit-streak-meter" aria-hidden="true">${htYearMeterFillHtml(
                yearM.pct,
                hStreak
              )}</div></div>`
            : '';
        const streakClusterHTML = `<div class="ht-habit-streak-cluster">
            <span class="ht-habit-streak ${hStreak >= 7 ? 'hot' : ''}">${streakLabel}</span>
            ${meterHtml}
          </div>`;

        const catAbove = '';

        habitEl.innerHTML = `
          <div class="ht-habit-main">
            <div class="ht-habit-top">
              <div class="ht-habit-orbit">${indicatorHTML}</div>
              <div class="ht-habit-name-col">
                ${catAbove}
                <div class="ht-habit-line-name"><span class="ht-habit-name">${htEsc(habit.name)}${targetLabel}</span></div>
                <div class="ht-habit-line-meta">
                  ${streakClusterHTML}
                  <button type="button" class="ht-habit-stats-link" title="Stats for this habit">${htIcon('chevron-right')}</button>
                </div>
              </div>
            </div>
          </div>
        `;

        const statsLink = habitEl.querySelector('.ht-habit-stats-link');
        if (statsLink) {
          const stopPe = (e) => {
            e.stopPropagation();
          };
          statsLink.addEventListener('mousedown', stopPe);
          statsLink.addEventListener('touchstart', stopPe, { passive: true });
          statsLink.addEventListener('click', (e) => {
            stopPe(e);
            this._habitEnterStatsView(state, { habitId: habit.id });
          });
        }

        let longPressTimer = null;
        let didLongPress = false;
        let pressStartX = 0;
        let pressStartY = 0;
        let pressDownTime = 0;
        let localDragArmed = false;
        let pressClickCount = 1;

        const cancelPress = () => {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        };

        const armDragPaint = () => {
          if (localDragArmed || state._htSidebarDragArmed || isNumeric) return;
          localDragArmed = true;
          state._htSidebarDragMode = this._htSidebarDragModeFromClickCount(pressClickCount);
          this._htArmSidebarDragPaintFlush(state, dateStr);
          void (async () => {
            try {
              await this._htEnsureSidebarDragLog(state, dateStr);
              state._htSidebarDragArmed = true;
              this._htPaintSidebarHabitDrag(state, habitEl, dateStr, config);
            } catch (_) {}
          })();
        };

        habitEl.addEventListener('pointerdown', (e) => {
          if (state.htManageMode || e.button !== 0) return;
          if (e.target.closest?.('.ht-habit-stats-link')) return;
          didLongPress = false;
          localDragArmed = false;
          pressClickCount = this._htSidebarDragClickBump(state);
          pressDownTime = Date.now();
          pressStartX = e.clientX;
          pressStartY = e.clientY;
          if (isNumeric) {
            longPressTimer = setTimeout(() => {
              didLongPress = true;
              cancelPress();
              this._showNumericInput(habitEl, habit, habit.categoryId, log, dateStr, state);
            }, HT_LONG_PRESS_MS);
          } else {
            longPressTimer = setTimeout(async () => {
              if (localDragArmed || state._htSidebarDragArmed) return;
              if (pressClickCount !== 1) return;
              didLongPress = true;
              cancelPress();
              try {
                const fresh = await this._loadLog(dateStr);
                fresh.completions[habit.id] = HT_COMP_FAIL;
                this._htRecomputeCategoryDone(fresh, this._config, dateStr);
                await this._saveLog(dateStr, fresh);
                this._htSyncDayLogState(state, dateStr, fresh);
                await this._patchHabitEl(habitEl, habit, fresh, dateStr, habit.categoryId, state);
              } catch (_) {}
            }, HT_LONG_PRESS_MS);
          }
        });

        habitEl.addEventListener('pointermove', (e) => {
          if (!(e.buttons & 1)) return;
          const threshold = e.pointerType === 'touch' ? 12 : HT_DRAG_MOVE_PX;
          if (
            Math.abs(e.clientX - pressStartX) > threshold ||
            Math.abs(e.clientY - pressStartY) > threshold
          ) {
            cancelPress();
            if (!isNumeric) armDragPaint();
          }
        });

        habitEl.addEventListener('pointerenter', (e) => {
          if (!(e.buttons & 1)) return;
          if (!state._htSidebarDragArmed) return;
          this._htPaintSidebarHabitDrag(state, habitEl, dateStr, config);
        });

        habitEl.addEventListener('pointerup', () => {
          state._htSidebarDragLastUp = Date.now();
          cancelPress();
        });

        habitEl.addEventListener('pointercancel', cancelPress);

        habitEl.addEventListener('click', (e) => {
          if (state.htManageMode) return;
          if (didLongPress || state._htSidebarDragDidPaint) {
            didLongPress = false;
            state._htSidebarDragDidPaint = false;
            return;
          }
          if (habitEl.querySelector('.ht-num-input')) return;
          this._tapHabit(habit, habit.categoryId, log, dateStr, state, habitEl, isDone);
        });

        if (state.htManageMode) {
          habitEl.appendChild(this._buildHabitManageStrip(state, habit));
        }

        habitsEl.appendChild(habitEl);
      }

      if (state.htManageMode) {
        const addRow = document.createElement('div');
        addRow.className = 'ht-manage-add-habit-row';
        addRow.style.cssText =
          'display:flex;gap:6px;margin-top:8px;padding-top:10px;border-top:1px dashed rgba(255,255,255,0.1);';
        const addInput = document.createElement('input');
        addInput.className = 'ht-input';
        addInput.placeholder = `Add habit to ${cat.name || 'category'}`;
        addInput.style.cssText = 'flex:1;min-width:0;';
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'ht-btn ht-btn-primary ht-btn-sm';
        addBtn.textContent = 'Add';
        const doAdd = () => {
          const nm = String(addInput.value || '').trim();
          if (!nm) return;
          const cfg = this._config;
          const order = cfg.habits.filter((h) => !h.archived && h.categoryId === cat.id).length;
          cfg.habits.push({
            id: htGenId(),
            name: nm,
            categoryId: cat.id,
            order,
            tags: [],
            weekdays: [],
          });
          addInput.value = '';
          htNormalizeHabitConfig(cfg);
          this._htSchedulePersistHabitConfig();
          void this._htRefreshManageModeHabitSidebars();
        };
        addBtn.addEventListener('click', (e) => {
          e.preventDefault();
          doAdd();
        });
        addInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') doAdd();
        });
        addRow.appendChild(addInput);
        addRow.appendChild(addBtn);
        habitsEl.appendChild(addRow);
      }

      if (catHeader) catEl.appendChild(catHeader);
      catEl.appendChild(habitsEl);
      fragment.appendChild(catEl);
    }

    if (fragment.childElementCount === 0 && this._htGetTagFilter()) {
      const anyLive = (config.habits || []).some((h) => !h.archived);
      const empty = document.createElement('div');
      empty.className = 'ht-empty';
      empty.style.padding = '14px 12px';
      empty.innerHTML = anyLive
        ? `<div style="font-size:12px;color:#8a7e6a;line-height:1.45;">No habits with tag <strong style="color:#d4cfc6;">${htEsc(
            this._htGetTagFilter()
          )}</strong>. Use the tag button in the header and choose <strong style="color:#d4cfc6;">All habits</strong>, or another tag.</div>`
        : `<div style="font-size:12px;color:#8a7e6a;">No habits yet.</div>`;
      fragment.appendChild(empty);
    }

    const fragmentCatBlocks = fragment.childElementCount;
    if (fragmentCatBlocks === 0) {
      htHabitsDbg({
        step: '_renderSidebar.warn_no_categories_in_fragment',
        panelId: state.panelId,
        token,
        dateStr,
        categoryCount: config.categories?.length ?? 0,
        searchQuery: state._searchQuery || '',
        hint: 'No habit sections rendered (search / hide off-days / empty setup).',
      });
    }

    // All async work done — now do the atomic swap in one paint frame
    if (stale() || bodyDetached()) {
      htHabitsDbg({
        step: '_renderSidebar.abort_before_swap',
        panelId: state.panelId,
        token,
        reason: stale() ? 'stale' : 'detached',
        fragmentCatBlocks,
      });
      return;
    }
    let catsWrap = body.querySelector('.ht-sidebar-cats');
    if (!catsWrap) {
      catsWrap = document.createElement('div');
      catsWrap.className = 'ht-sidebar-cats';
      body.appendChild(catsWrap);
    }
    // Single DOM swap — no intermediate empty state, no collapse
    catsWrap.replaceChildren(fragment);
    body.classList.toggle('ht-manage-mode', !!state.htManageMode);
    if (state.htManageMode) {
      try {
        state._htInlineDragCleanup?.();
      } catch (_) {}
      const dragCleanups = [
        this._htAttachSettingsDragBridge(state.sidebarEl),
        this._htAttachSettingsDragBridge(state.bodyEl),
      ];
      state._htInlineDragCleanup = () => {
        for (const fn of dragCleanups) {
          try {
            fn();
          } catch (_) {}
        }
      };
      this._htWireManageModeHabitDnD(state);
    }
    this._htFillHabitRibbon(state, config, dateStr, logsByDate);
    htHabitsDbg({
      step: '_renderSidebar.done',
      panelId: state.panelId,
      token,
      dateStr,
      fragmentCatBlocks,
      catsWrapChildCount: catsWrap.childElementCount,
    });
    this._renderNotesSection(body, log, dateStr, state, token);
    this._htSyncTagFilterButtons();
    this._htSyncCategoryExpandToggleBtn(state);
  }

  /** Icon + visibility for the single “expand / collapse all categories” header control. */
  _htSyncCategoryExpandToggleBtn(state) {
    const btn = state?._htCatExpandToggleBtn;
    if (!btn) return;
    const cats = this._config?.categories || [];
    const embedded = !!state.jhsExternalHeaderHost;
    const sidebarCollapsed = !embedded && state.sidebarEl?.classList.contains('ht-collapsed');
    if (sidebarCollapsed || !cats.length) {
      btn.style.display = 'none';
      return;
    }
    btn.style.display = '';
    const anyExpanded = cats.some((c) => !this._catCollapsed[c.id]);
    btn.innerHTML = anyExpanded ? htIcon('chevron-up') : htIcon('chevron-down');
    btn.title = anyExpanded ? 'Collapse all categories' : 'Expand all categories';
  }

  /** `collapsed === true` hides habit lists (same flag as per-category chevron). */
  _htSetAllCategoriesCollapsed(state, collapsed) {
    const cfg = this._config;
    if (!cfg?.categories?.length) return;
    for (const c of cfg.categories) {
      this._catCollapsed[c.id] = collapsed;
    }
    if (this._persistState) {
      localStorage.setItem('ht_cat_collapsed', JSON.stringify(this._catCollapsed));
      this._htPluginSettingsFlush();
    }
    void this._renderSidebar(state);
  }

  _toggleCategory(catId, state) {
    this._catCollapsed[catId] = !this._catCollapsed[catId];
    if (this._persistState) {
      localStorage.setItem('ht_cat_collapsed', JSON.stringify(this._catCollapsed));
      this._htPluginSettingsFlush();
    }
    if (this._htHabitRibbonMode) {
      void this._renderSidebar(state);
      return;
    }

    const body = state.bodyEl;
    if (!body) return;
    const habitsEl = body.querySelector(`[data-cat-id="${catId}"]`);
    const catHeader = habitsEl?.previousElementSibling;
    const caret = catHeader?.querySelector('.ht-category-caret');

    const isOpen = !this._catCollapsed[catId];
    habitsEl?.classList.toggle('ht-hidden', !isOpen);
    caret?.classList.toggle('open', isOpen);
    this._htSyncCategoryExpandToggleBtn(state);
  }

  // Tap a habit: boolean = toggle, numeric = +1 up to target (then tap again resets to 0)
  async _tapHabit(habit, catId, log, dateStr, state, habitEl, wasDone) {
    const freshLog = await this._loadLog(dateStr);
    log = freshLog;
    const cfg = this._config;
    const hasTarget = (habit.target || 0) > 0;

    if (!hasTarget) {
      const prevNorm = htCompletionNorm(log.completions[habit.id], habit);
      this._htCycleHabitCompletion(log, habit, habit.id);
      const nextNorm = htCompletionNorm(log.completions[habit.id], habit);
      if (nextNorm.done && !prevNorm.done) this._celebrate(habitEl);
    } else {
      const raw = log.completions[habit.id];
      const norm = htCompletionNorm(raw, habit);
      if (norm.kind === 'na' || norm.kind === 'fail') {
        log.completions[habit.id] = 1;
      } else {
        const currentVal = typeof raw === 'number' ? raw : 0;
        if (currentVal >= habit.target) {
          delete log.completions[habit.id];
        } else {
          log.completions[habit.id] = currentVal + 1;
          if (currentVal + 1 >= habit.target) this._celebrate(habitEl);
        }
      }
    }

    this._htRecomputeCategoryDone(log, cfg, dateStr);
    await this._saveLog(dateStr, log);
    this._htSyncDayLogState(state, dateStr, log);
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
    const surf = htHabitDaySurface(log, habit, dateStr);
    const norm = htCompletionNorm(rawVal, habit);
    const currentVal = typeof rawVal === 'number' ? rawVal : rawVal === true ? 1 : 0;
    const isDone = norm.done;

    habitEl.classList.toggle('ht-done', isDone);
    habitEl.classList.toggle('ht-habit-offday', !!surf.offDay);
    habitEl.classList.toggle('ht-fail', norm.kind === 'fail');
    habitEl.classList.toggle(
      'ht-na',
      norm.kind === 'na' || (surf.displayNa && norm.kind === 'empty')
    );

    const indSlot = habitEl.querySelector('.ht-habit-orbit');
    if (indSlot) {
      if (norm.kind === 'fail') {
        indSlot.innerHTML = `<div class="ht-habit-mark ht-habit-mark-fail" aria-hidden="true">×</div>`;
      } else if (norm.kind === 'na' || (surf.displayNa && norm.kind === 'empty')) {
        indSlot.innerHTML = `<div class="ht-habit-mark ht-habit-mark-na" aria-hidden="true">/</div>`;
      } else if (hasTarget) {
        const r = 10;
        const circ = 2 * Math.PI * r;
        const pRing = Math.min(1, currentVal / habit.target);
        const dash = circ * pRing;
        const label = currentVal >= habit.target ? htIcon('check') : `${currentVal}`;
        indSlot.innerHTML = `
            <div class="ht-habit-ring">
              <svg width="26" height="26" viewBox="0 0 26 26">
                <circle class="ht-habit-ring-bg" cx="13" cy="13" r="${r}"/>
                <circle class="ht-habit-ring-fill" cx="13" cy="13" r="${r}"
                  stroke-dasharray="${circ}"
                  stroke-dashoffset="${circ - dash}"/>
              </svg>
              <div class="ht-habit-ring-label">${label}</div>
            </div>`;
        const nameEl = habitEl.querySelector('.ht-habit-name');
        if (nameEl) {
          const existing = nameEl.querySelector('span');
          if (existing) {
            existing.textContent = `${currentVal}/${habit.target}${habit.unit ? ' ' + habit.unit : ''}`;
          }
        }
      } else {
        indSlot.innerHTML = `<div class="ht-habit-check-minimal"><span class="ht-check-glyph">${
          isDone ? htIcon('check') : htIcon('check', 'ht-check-faint')
        }</span></div>`;
      }
    }

    const habitsEl = habitEl.closest('.ht-category-habits');
    const catHeader = habitsEl?.previousElementSibling;
    if (catHeader) {
      const doneSlot = catHeader.querySelector('.ht-ch-cat-done-wrap');
      const applying = [];
      if (habitsEl) {
        for (const row of habitsEl.querySelectorAll('.ht-habit[data-habit-id]')) {
          const hid = row.dataset.habitId;
          const h = this._config?.habits?.find((x) => x.id === hid);
          if (!h) continue;
          if (!htHabitAppliesOnDate(h, dateStr)) continue;
          applying.push(h);
        }
      }
      if (doneSlot) {
        const st = htCategoryDayAggregateStatus(log, applying, dateStr);
        doneSlot.innerHTML = htCategoryDayLeadInnerHtml(st);
      }
      const markedSlot = catHeader.querySelector('.ht-ch-cat-marked');
      if (markedSlot) {
        markedSlot.innerHTML = htCategoryAllMarkedForDay(log, applying, dateStr)
          ? `<span class="ht-cat-marked-dot" title="All habits tended to" aria-hidden="true"></span>`
          : '';
      }
    }

    // Recompute streaks immediately so click updates are visible without refresh.
    try {
      const logsByDate = await this._loadAllLogsByDate();
      const habitStreak = this._habitStreakFromMap(habit.id, undefined, logsByDate, habit);
      const moChecks = this._habitCheckCountInMonth(habit, logsByDate, dateStr);
      const wkChecks = this._habitCheckCountWeekSun(habit, logsByDate, dateStr);
      const streakCore = habitStreak > 0 ? htHabitStreakCoreHtml(habitStreak, habitStreak >= 7) : '';
      const cntSeg =
        `<span class="ht-habit-stat-counts">` +
        `<span class="ht-roll-num">${moChecks}</span><span class="ht-roll-suffix">30d</span>` +
        `<span class="ht-roll-sep">·</span>` +
        `<span class="ht-roll-num">${wkChecks}</span><span class="ht-roll-suffix">7d</span>` +
        `</span>`;
      const streakLabel = streakCore
        ? `${streakCore}<span class="ht-streak-dotsep"> · </span>${cntSeg}`
        : cntSeg;
      const yearM = this._htHabitYearMeter(habitStreak);
      const tierBadge =
        yearM.yearsCompleted > 0
          ? `<span class="ht-year-tier" title="${yearM.yearsCompleted}×365d streak milestone">★${yearM.yearsCompleted}</span>`
          : '';
      const boundaryMark = yearM.atYearBoundary
        ? `<span class="ht-year-boundary" title="365-day milestone">✓</span>`
        : '';
      const meterHtml =
        habitStreak > 0
          ? `<div class="ht-habit-streak-meter-wrap">${tierBadge}${boundaryMark}<div class="ht-habit-streak-meter" aria-hidden="true">${htYearMeterFillHtml(
              yearM.pct,
              habitStreak
            )}</div></div>`
          : '';
      const hotCls = habitStreak >= 7 ? ' hot' : '';
      const inner = `<span class="ht-habit-streak${hotCls}">${streakLabel}</span>${meterHtml}`;
      const metaRow = habitEl.querySelector('.ht-habit-line-meta');
      let cluster = habitEl.querySelector('.ht-habit-streak-cluster');
      if (!cluster && metaRow) {
        cluster = document.createElement('div');
        cluster.className = 'ht-habit-streak-cluster';
        const statsA = metaRow.querySelector('.ht-habit-stats-link');
        if (statsA) metaRow.insertBefore(cluster, statsA);
        else metaRow.appendChild(cluster);
      }
      if (cluster) {
        cluster.classList.remove('ht-habit-streak-cluster-empty');
        cluster.innerHTML = inner;
      }

      if (catHeader && habitsEl?.dataset?.catId) {
        const secCatId = habitsEl.dataset.catId;
        const cat = (this._config?.categories || []).find((c) => c.id === secCatId) || null;
        const catStreak = this._categoryStreakFromMap(secCatId, undefined, logsByDate, cat);
        const catStreakEl = catHeader.querySelector('.ht-category-streak');
        const catStreakHtml = htCategoryStreakBadgeHtml(catStreak);
        if (catStreak > 0) {
          if (!catStreakEl) {
            const cluster = catHeader.querySelector('.ht-ch-cluster');
            if (cluster) cluster.insertAdjacentHTML('beforeend', catStreakHtml);
            else catHeader.insertAdjacentHTML('beforeend', catStreakHtml);
          } else {
            catStreakEl.outerHTML = catStreakHtml;
          }
        } else if (catStreakEl) {
          catStreakEl.remove();
        }
      }
    } catch (_) {}

    // Update progress bar (category at-least-one completion)
    const body = state.bodyEl;
    if (body) {
      const cfg = this._config;
      const tagFil = this._htGetTagFilter();
      const { done: cDone, eligible: cElig, pct: cPct } = this._htCategoryProgressFromLog(cfg, log, dateStr);
      const pw = body.querySelector('.ht-progress');
      if (pw) {
        pw.style.display = '';
        pw.title =
          cElig > 0
            ? tagFil
              ? `${cDone} of ${cElig} categories with at least one habit done today (filtered by tag “${tagFil}”)`
              : `${cDone} of ${cElig} categories with at least one habit done today`
            : '';
      }
      const fill = body.querySelector('.ht-progress-fill');
      if (fill) {
        fill.style.width = cPct + '%';
        fill.style.background = htCategoryProgressFillStyle(cPct);
      }
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
    okBtn.innerHTML = htIcon('check');
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

      this._htRecomputeCategoryDone(log, this._config, dateStr);

      await this._saveLog(dateStr, log);
      await this._patchHabitEl(habitEl, habit, log, dateStr, catId, state);
    };

    const commitSpecial = async (sym) => {
      wrap.remove();
      const fresh = await this._loadLog(dateStr);
      fresh.completions[habit.id] = sym;
      this._htRecomputeCategoryDone(fresh, this._config, dateStr);
      await this._saveLog(dateStr, fresh);
      await this._patchHabitEl(habitEl, habit, fresh, dateStr, catId, state);
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

    okBtn.addEventListener('click', (e) => { e.stopPropagation(); commit(); });
    failBtn.addEventListener('click', (e) => { e.stopPropagation(); commitSpecial(HT_COMP_FAIL); });
    naBtn.addEventListener('click', (e) => { e.stopPropagation(); commitSpecial(HT_COMP_NA); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') wrap.remove();
      e.stopPropagation();
    });
    input.addEventListener('click', (e) => e.stopPropagation());

    wrap.appendChild(input);
    wrap.appendChild(okBtn);
    wrap.appendChild(failBtn);
    wrap.appendChild(naBtn);
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

    state._htStatsDragBatch = null;
    state._htStatsDragSeen = null;
    state._htStatsDragArmed = false;

    const config = this._config || { categories: [], habits: [] };
    let rangeDays = this._getStatsRangeDays(state);
    const storedRangeOk = (() => {
      const s = this._persistState ? parseInt(localStorage.getItem('ht_stats_range'), 10) : NaN;
      return s === 7 || s === 30;
    })();
    if (!storedRangeOk) this._persistStatsRangeDays(state, rangeDays);
    let selectedId = state.statsSelected || '__overall__';
    if (selectedId.startsWith('habit:')) {
      const hid = selectedId.slice(6);
      const hOk = config.habits.some((x) => x.id === hid && !x.archived);
      if (!hOk) {
        selectedId = '__overall__';
        state.statsSelected = '__overall__';
      }
    }

    const buildSelect = () => {
      const sel = document.createElement('select');
      sel.className = 'ht-stats-select';
      const opt0 = document.createElement('option');
      opt0.value = '__overall__'; opt0.textContent = 'Overall';
      sel.appendChild(opt0);
      for (const cat of config.categories) {
        const o = document.createElement('option');
        o.value = 'cat:' + cat.id;
        o.textContent = `${cat.name} (category)`;
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
        renderContent.call(this);
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
        this._persistStatsRangeDays(state, days);
        rangeRow.querySelectorAll('.ht-range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderContent.call(this);
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
    const patchCell = (el, isDone, isPartial, label, isNaDay = false, isFail = false) => {
      el.classList.toggle('done', isDone);
      el.classList.toggle('partial', isPartial && !isDone);
      el.classList.toggle('ht-cal-na', !!isNaDay);
      el.classList.toggle('ht-cal-fail', !!isFail);

      const stripCirc = el.classList.contains('ht-cal-strip-circle');
      if (stripCirc) {
        if (isFail) el.textContent = '×';
        else if (isNaDay) el.textContent = '–';
        else if (label != null && label > 0) el.textContent = String(label);
        else if (isDone) el.textContent = '';
        else el.textContent = '';
      }

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
      if (hId && h) {
        this._htRecomputeCategoryDone(log, config, dateStr);
      } else {
        const affectedCatIds = cId ? [cId] : config.categories.map((c) => c.id);
        for (const catId of affectedCatIds) {
          const habitsInCat = config.habits.filter((x) => x.categoryId === catId && !x.archived);
          const anyDone = habitsInCat.some((x) => {
            const v2 = log.completions[x.id];
            if (!v2) return false;
            if ((x.target || 0) > 0) return typeof v2 === 'number' ? v2 >= x.target : false;
            return true;
          });
          if (anyDone) log.categoryDone[catId] = true;
          else delete log.categoryDone[catId];
        }
      }
      await this._saveLog(dateStr, log);

      const isHabitSel = !!hId && !!h;
      const isCatSel = !!cId;

      let isDone = false;
      let isPartial = false;
      let valLabel = null;
      let na = false;
      let fail = false;
      if (isHabitSel) {
        const surf = htHabitDaySurface(log, h, dateStr);
        const nm = htCompletionNorm(log.completions[hId], h);
        const num = typeof log.completions[hId] === 'number' ? log.completions[hId] : log.completions[hId] === true ? 1 : 0;
        isDone = nm.done;
        isPartial = nm.kind === 'partial';
        valLabel = (h.target || 0) > 0 && num > 0 ? num : null;
        na = nm.kind === 'na' || (surf.displayNa && nm.kind === 'empty');
        fail = nm.kind === 'fail';
      } else if (isCatSel) {
        isDone = !!log.categoryDone[cId];
      } else {
        const allActive = config.habits.filter((x) => !x.archived);
        const doneCount = allActive.filter((x) => {
          const v = log.completions[x.id];
          if (!v) return false;
          return (x.target || 0) > 0 ? typeof v === 'number' && v >= x.target : true;
        }).length;
        isDone = doneCount === allActive.length;
        isPartial = !isDone && doneCount > 0;
      }
      patchCell(el, isDone, isPartial, valLabel, na, fail);
      if (isDone) this._celebrate(el);
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
      okBtn.className = 'ht-num-btn'; okBtn.innerHTML = htIcon('check');
      okBtn.style.cssText = 'background:rgba(76,175,80,0.2);border-color:#4caf50;color:#4caf50;';

      const commit = async () => {
        wrap.remove();
        const newVal = Math.max(0, parseInt(input.value) || 0);
        const log = await this._loadLog(dateStr);
        if (newVal === 0) delete log.completions[hId];
        else log.completions[hId] = newVal;
        await applyLogChange(dateStr, log, el, hId, null);
      };

      const commitSpecial = async (sym) => {
        wrap.remove();
        const log = await this._loadLog(dateStr);
        log.completions[hId] = sym;
        await applyLogChange(dateStr, log, el, hId, null);
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

      okBtn.addEventListener('click', (e) => { e.stopPropagation(); commit(); });
      failBtn.addEventListener('click', (e) => { e.stopPropagation(); commitSpecial(HT_COMP_FAIL); });
      naBtn.addEventListener('click', (e) => { e.stopPropagation(); commitSpecial(HT_COMP_NA); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') wrap.remove();
        e.stopPropagation();
      });
      input.addEventListener('click', (e) => e.stopPropagation());
      wrap.appendChild(input); wrap.appendChild(okBtn);
      wrap.appendChild(failBtn); wrap.appendChild(naBtn);
      el.style.position = 'relative';
      el.style.overflow = 'visible';
      el.appendChild(wrap);
      setTimeout(() => { input.focus(); input.select(); }, 10);

      // Close on outside click
      const outside = (e) => { if (!wrap.contains(e.target)) { wrap.remove(); document.removeEventListener('click', outside); } };
      setTimeout(() => document.addEventListener('click', outside), 50);
    };

    const armStatsHabitDragFlush = () => {
      if (state._htStatsDragArmed) return;
      state._htStatsDragArmed = true;
      const finish = async () => {
        window.removeEventListener('pointerup', finish, true);
        window.removeEventListener('pointercancel', finish, true);
        state._htStatsDragArmed = false;
        const batch = state._htStatsDragBatch;
        state._htStatsDragBatch = null;
        state._htStatsDragSeen = null;
        if (!batch || batch.size === 0) return;
        for (const [ds, lg] of batch.entries()) {
          await this._saveLog(ds, lg);
        }
        await this._getAllLogRows(true);
        await renderContent.call(this);
      };
      window.addEventListener('pointerup', finish, { once: true, capture: true });
      window.addEventListener('pointercancel', finish, { once: true, capture: true });
    };

    const mergeStatsDragLog = (dateStr, logsByDate) => {
      if (!state._htStatsDragBatch) state._htStatsDragBatch = new Map();
      if (!state._htStatsDragBatch.has(dateStr)) {
        const base = logsByDate.get(dateStr);
        const copy = JSON.parse(JSON.stringify(base || { completions: {}, categoryDone: {}, notes: '' }));
        copy.date = dateStr;
        state._htStatsDragBatch.set(dateStr, copy);
      }
      return state._htStatsDragBatch.get(dateStr);
    };

    const paintStatsHabitDragCell = (dateStr, el, logsByDate, hId, habit) => {
      if (!state._htStatsDragSeen) state._htStatsDragSeen = new Set();
      const key = `${dateStr}:${hId}`;
      if (state._htStatsDragSeen.has(key)) return;
      state._htStatsDragSeen.add(key);
      const log = mergeStatsDragLog(dateStr, logsByDate);
      this._htCycleHabitCompletion(log, habit, hId);
      this._htRecomputeCategoryDone(log, config, dateStr);
      const surf = htHabitDaySurface(log, habit, dateStr);
      const nm = htCompletionNorm(log.completions[hId], habit);
      const num = typeof log.completions[hId] === 'number' ? log.completions[hId] : 0;
      const valLabel = (habit.target || 0) > 0 && num > 0 ? num : null;
      const na = nm.kind === 'na' || (surf.displayNa && nm.kind === 'empty');
      const fail = nm.kind === 'fail';
      patchCell(el, nm.done, nm.kind === 'partial', valLabel, na, fail);
    };

    // Wire up tap + long-press on a calendar circle element
    const wireCircle = (el, dateStr, currentV, logsByDate) => {
      const isCatSel = selectedId.startsWith('cat:');
      const isHabitSel = selectedId.startsWith('habit:');
      const hId = isHabitSel ? selectedId.slice(6) : null;
      const cId = isCatSel ? selectedId.slice(4) : null;
      const h = hId ? config.habits.find(x => x.id === hId) : null;
      const isNumeric = h && (h.target||0) > 0;

      let longTimer = null, didLong = false, startX = 0, startY = 0;

      let pressDownTime = 0;
      el.addEventListener('mousedown', (e) => {
        if (!isHabitSel || !h || !isNumeric) return;
        didLong = false; startX = e.clientX; startY = e.clientY;
        pressDownTime = Date.now();
        longTimer = setTimeout(() => {
          didLong = true;
          showStatsNumericInput(el, dateStr, h);
        }, HT_LONG_PRESS_MS);
      });
      el.addEventListener('mouseup', () => {
        if (isNumeric && Date.now() - pressDownTime < 600) clearTimeout(longTimer);
      });
      el.addEventListener('mousemove', (e) => {
        if (!isNumeric) return;
        if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) clearTimeout(longTimer);
      });
      el.addEventListener('mouseleave', () => { if (isNumeric) clearTimeout(longTimer); });

      if (isHabitSel && h && !isNumeric) {
        el.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          armStatsHabitDragFlush();
          paintStatsHabitDragCell(dateStr, el, logsByDate, hId, h);
        });
        el.addEventListener('pointerenter', (e) => {
          if (!(e.buttons & 1)) return;
          if (!state._htStatsDragBatch) return;
          paintStatsHabitDragCell(dateStr, el, logsByDate, hId, h);
        });
      }

      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (isHabitSel && h && !isNumeric) return;
        if (didLong) { didLong = false; return; }
        if (el.querySelector('.ht-num-input')) return;

        const log = await this._loadLog(dateStr);

        if (isHabitSel && h) {
          this._htCycleHabitCompletion(log, h, hId);
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

    async function renderContent() {
      if (!contentEl.isConnected) return;

      const logRowsStats = await this._getAllLogRows();
      const logsByDate = this._buildLogsByDateMapFromRows(logRowsStats);

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

      const habitDaySnapshot = (dateStr, log) => {
        if (!habit) return null;
        const L = log || { completions: {}, categoryDone: {} };
        const raw = L.completions?.[habit.id];
        const nm = htCompletionNorm(raw, habit);
        const surf = htHabitDaySurface(L, habit, dateStr);
        const displayNa = nm.kind === 'na' || (surf.displayNa && nm.kind === 'empty');
        const fail = nm.kind === 'fail';
        const num =
          typeof raw === 'number'
            ? raw
            : raw === true
              ? 1
              : nm.num || 0;
        const target = habit.target || 0;
        return {
          val: num,
          max: target || 1,
          done: nm.done,
          partial: nm.kind === 'partial',
          na: displayNa,
          fail,
        };
      };

      // Compute per-day values for rolling window
      const getVal = (dateStr) => {
        const log = logsByDate.get(dateStr);
        if (isOverall) {
          if (!log) return null;
          const done = activeHabits.filter(h => {
            if (!htHabitAppliesOnDate(h, dateStr)) return false;
            const cv = log.completions?.[h.id];
            if (!cv) return false;
            return (h.target||0) > 0 ? (typeof cv === 'number' ? cv >= h.target : false) : true;
          }).length;
          const denom = activeHabits.filter(h => htHabitAppliesOnDate(h, dateStr)).length;
          return { val: done, max: Math.max(1, denom), done: denom > 0 && done === denom };
        }
        if (isCat) {
          if (!log) return null;
          return { val: log.categoryDone?.[catId] ? 1 : 0, max: 1, done: !!log.categoryDone?.[catId] };
        }
        if (isHabit && habit) {
          return habitDaySnapshot(dateStr, log);
        }
        return null;
      };

      const dayVals = dates.map(d => getVal(d));

      // All log dates sorted
      const allDates = [...allLogDates].sort();

      let completionRate = 0;
      let rateLabel = '';
      if (isHabit && habit) {
        let denom = 0;
        let doneCt = 0;
        for (const d of dates) {
          if (!htHabitAppliesOnDate(habit, d)) continue;
          const snap = habitDaySnapshot(d, logsByDate.get(d));
          if (!snap || snap.na) continue;
          denom++;
          if (snap.done) doneCt++;
        }
        completionRate = denom > 0 ? Math.round((doneCt / denom) * 100) : 0;
        rateLabel = `${doneCt}/${denom} days`;
      } else {
        const allDoneDays = allDates.filter(d => getVal(d)?.done).length;
        completionRate = allDates.length > 0 ? Math.round((allDoneDays / allDates.length) * 100) : 0;
        rateLabel = `${allDoneDays}/${allDates.length} days`;
      }

      // Total value (numeric habits) across all history
      let totalVal = 0;
      allDates.forEach(d => {
        const log = logsByDate.get(d);
        if (log && isHabit && habit) {
          const hv = log.completions?.[habit.id];
          totalVal += typeof hv === 'number' ? hv : (hv === true ? 1 : 0);
        }
      });

      let bestStreak = 0;
      let cur = 0;
      if (isHabit && habit) {
        const startStr =
          habit.seedDate && habit.seedDate <= today
            ? habit.seedDate
            : (allDates[0] || today);
        for (let d = startStr; d <= today; d = htDaysAfter(d, 1)) {
          if (!htHabitAppliesOnDate(habit, d)) continue;
          const log = logsByDate.get(d);
          const raw = log?.completions?.[habit.id];
          const nm = htCompletionNorm(raw, habit);
          if (nm.kind === 'na') continue;
          if (nm.done) {
            cur++;
            bestStreak = Math.max(bestStreak, cur);
          } else if (habit.seedDate && d >= habit.seedDate && !log) {
            cur++;
            bestStreak = Math.max(bestStreak, cur);
          } else {
            cur = 0;
          }
        }
      } else {
        for (let i = 0; i < allDates.length; i++) {
          const v = getVal(allDates[i]);
          if (v?.done) {
            if (i > 0) {
              const prev = new Date(allDates[i - 1] + 'T12:00:00');
              const curr = new Date(allDates[i] + 'T12:00:00');
              const diff = Math.round((curr - prev) / 86400000);
              if (diff === 1) cur++;
              else cur = 1;
            } else {
              cur = 1;
            }
            if (cur > bestStreak) bestStreak = cur;
          } else {
            cur = 0;
          }
        }
      }

      let streak = 0;
      if (isHabit && habit) {
        streak = this._habitStreakFromMap(habit.id, htDaysAfter(today, 1), logsByDate, habit);
      } else {
        let checkDate = htDaysBefore(today, 1);
        const todayVal = getVal(today);
        if (todayVal?.done) {
          streak = 1;
          checkDate = htDaysBefore(today, 1);
        }
        for (let i = 0; i < 3650; i++) {
          const v = getVal(checkDate);
          if (v?.done) {
            streak++;
            checkDate = htDaysBefore(checkDate, 1);
          } else break;
        }
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

      // ── Category completion rates (overall) — high-signal; above calendar & daily bars ──
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
            <span class="ht-cat-rate-name"><span class="ht-cat-glyph-inline">${htCategoryGlyphHtml(c.emoji)}</span>${htEsc(c.name)}</span>
            <div class="ht-cat-rate-bar-wrap"><div class="ht-cat-rate-bar" style="width:${rate}%"></div></div>
            <span class="ht-cat-rate-pct">${rate}%</span>
          `;
          rateSection.appendChild(row);
        }
        contentEl.appendChild(rateSection);
      }

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
          circle.className =
            'ht-cal-strip-circle' +
            (v?.fail ? ' ht-cal-fail' : '') +
            (v?.na ? ' ht-cal-na' : '') +
            (v?.done ? ' done' : v && !v?.na && !v?.fail && v.val > 0 ? ' partial' : '');
          const dateNum = document.createElement('div');
          dateNum.className = 'ht-cal-strip-date';
          dateNum.textContent = dt.getDate();
          // Show value inside circle for numeric habits
          if (isHabit && habit?.target > 0 && v?.val > 0 && !v?.na && !v?.fail) {
            circle.textContent = v.val;
            circle.classList.add('has-val');
          }
          if (v?.fail) circle.textContent = '×';
          else if (v?.na) circle.textContent = '–';
          circle.title = d + (v?.val != null ? ': ' + v.val : '');
          wireCircle(circle, d, v, logsByDate);
          col.appendChild(dayName);
          col.appendChild(circle);
          col.appendChild(dateNum);
          strip.appendChild(col);
        });
        calSection.appendChild(strip);

      } else {
        // ── 30-day monthly calendar grid ──
        // Persist viewed month on panel state so habit-calendar drag refresh doesn't jump back to journal month.
        const refAnchor = new Date((state.dateStr || htToday()) + 'T12:00:00');
        if (!state._htStatsCal) {
          state._htStatsCal = { y: refAnchor.getFullYear(), m: refAnchor.getMonth() };
        }
        let calYear = state._htStatsCal.y;
        let calMonth = state._htStatsCal.m;

        const renderMonth = (year, month) => {
          state._htStatsCal = { y: year, m: month };
          calYear = year;
          calMonth = month;
          calSection.querySelector('.ht-cal-month-view')?.remove();
          const mv = document.createElement('div');
          mv.className = 'ht-cal-month-view';

          // Month nav header
          const nav = document.createElement('div');
          nav.className = 'ht-cal-month-nav';
          const prevMo = document.createElement('button');
          prevMo.className = 'ht-cal-nav-btn'; prevMo.innerHTML = htIcon('chevron-left');
          const monthTitle = document.createElement('span');
          monthTitle.className = 'ht-cal-month-title';
          monthTitle.textContent = new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
          const nextMo = document.createElement('button');
          nextMo.className = 'ht-cal-nav-btn'; nextMo.innerHTML = htIcon('chevron-right');
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
            // Allow selecting any past date in the visible month.
            // Keep future dates dim/non-interactive.
            const inRange = dateStr <= today;

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
                  cellV = habitDaySnapshot(dateStr, log);
                }
              }
            }

            const cell = document.createElement('div');
            cell.className = 'ht-cal-day' +
              (isToday ? ' today' : '') +
              (!inRange ? ' out-of-range' : '') +
              (cellV?.fail ? ' ht-cal-fail' : '') +
              (cellV?.na ? ' ht-cal-na' : '') +
              (cellV?.done ? ' done' : (cellV && !cellV.na && !cellV.fail && cellV.val > 0 ? ' partial' : ''));

            const num = document.createElement('div');
            num.className = 'ht-cal-day-num'; num.textContent = day;
            const dot = document.createElement('div');
            dot.className = 'ht-cal-day-dot';
            cell.appendChild(num);
            cell.appendChild(dot);
            // For numeric habits, show value as small text
            if (isHabit && habit?.target > 0 && cellV?.val > 0 && !cellV?.na && !cellV?.fail) {
              const valEl = document.createElement('div');
              valEl.className = 'ht-cal-day-val';
              valEl.textContent = cellV.val;
              cell.appendChild(valEl);
            }
            cell.title = dateStr + (cellV?.val != null ? ': ' + cellV.val : '');
            if (inRange) wireCircle(cell, dateStr, cellV, logsByDate);
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

    }

    await renderContent.call(this);
  }

  /**
   * Re-render every mounted panel (habits or stats) after config/logs change.
   * @param {{ skipManageModeHabitSidebar?: boolean }} [opts] When true, habit list panels
   *   in inline quick-edit (`htManageMode`) are skipped so debounced saves do not tear down
   *   inputs and reset scroll; use `_htRefreshManageModeHabitSidebars` after structural edits.
   */
  async refreshAllPanels(opts = {}) {
    const skipManage = !!opts.skipManageModeHabitSidebar;
    for (const [, state] of (this._panelStates || new Map())) {
      if (!state.bodyEl) continue;
      if (skipManage && state.htManageMode && state.bodyEl.dataset?.mode !== 'stats') continue;
      try {
        if (state.bodyEl.dataset?.mode === 'stats') {
          await this._renderStats(state, state.bodyEl);
        } else {
          await this._renderSidebar(state);
        }
      } catch (e) {
        console.error('[HabitTracker] refreshAllPanels:', e);
      }
    }
  }

  // ── Settings UI ──────────────────────────────────────────────────────────

  /**
   * HTML5 drag needs `preventDefault` on dragover for ancestors; Thymer’s panel/modal shell can
   * intercept first — bridge from capture phase while a habit row drag is active.
   */
  _htAttachSettingsDragBridge(hostEl) {
    if (!hostEl || typeof hostEl.addEventListener !== 'function') return () => {};
    const attr = 'data-ht-settings-drag-habit';
    const onChain = (e) => {
      try {
        if (document.body.getAttribute(attr)) {
          e.preventDefault();
          try {
            e.dataTransfer.dropEffect = 'move';
          } catch (_) {}
        }
      } catch (_) {}
    };
    hostEl.addEventListener('dragenter', onChain, true);
    hostEl.addEventListener('dragover', onChain, true);
    return () => {
      try {
        hostEl.removeEventListener('dragenter', onChain, true);
        hostEl.removeEventListener('dragover', onChain, true);
      } catch (_) {}
    };
  }

  /** Command palette / legacy entry: toggle inline manage on a journal habits panel (no modal). */
  openSettings() {
    void this._openJournalHabitInlineManage(null);
  }

  /**
   * Toggle inline habit manage mode for a journal panel (suite shell or standalone sidebar).
   * Second invocation closes the inline settings chrome (same as “Done editing”).
   * @param {string | null} preferredPanelId suite `_states` key when invoked from suite gear
   */
  _openJournalHabitInlineManage(preferredPanelId) {
    document.querySelector('.ht-modal-overlay')?.remove();
    let chosen = preferredPanelId ? this._panelStates.get(preferredPanelId) : null;
    if (!chosen?.bodyEl?.isConnected) {
      chosen = null;
      for (const [, st] of this._panelStates || new Map()) {
        if (!st.bodyEl?.isConnected || st.bodyEl.dataset?.mode === 'stats') continue;
        if (st.isJournalPanel) {
          chosen = st;
          break;
        }
      }
    }
    if (!chosen) {
      this.ui.addToaster?.({
        title: 'Journal Header Suite',
        message: 'Open a journal page with habits visible, then try again.',
        dismissible: true,
        autoDestroyTime: 4200,
      });
      return;
    }

    if (chosen.htManageMode) {
      chosen.htManageMode = false;
      const btnOff = chosen._htHabitShell?.manageBtn;
      if (btnOff) {
        btnOff.classList.remove('active');
        btnOff.title = 'Edit habits & layout (inline)';
      }
      void this._renderSidebar(chosen);
      return;
    }

    chosen.htManageMode = true;
    const btn = chosen._htHabitShell?.manageBtn;
    if (btn) {
      btn.classList.add('active');
      btn.title = 'Done editing habits';
    }
    void this._renderSidebar(chosen);
  }

  _renderSettings(container, draft, options = {}) {
    const panelState = options.panelState || null;
    const layoutAsIcons = !!options.layoutAsIcons;
    const showSuiteTabs = options.showSuiteTabs !== false;

    if (panelState) {
      container.innerHTML = '';
      

      if (!(draft.categories || []).length) {
        const hintEmpty = document.createElement('div');
        hintEmpty.style.cssText =
          'font-size:12px;color:#8a7e6a;margin:0 0 10px;line-height:1.45;';
        hintEmpty.textContent =
          'Add a category to get started, or open a journal day and use Edit habits & layout in the habit panel.';
        container.appendChild(hintEmpty);
      }

      const topRow = document.createElement('div');
      topRow.className = 'ht-add-row';
      topRow.style.marginBottom = '10px';
      const newCatIconPicker = this._htBuildCategoryIconPicker('folder', () => {});
      const newCatName = document.createElement('input');
      newCatName.className = 'ht-input';
      newCatName.placeholder = 'New category name';
      const addCatBtn = document.createElement('button');
      addCatBtn.className = 'ht-btn ht-btn-primary ht-btn-sm';
      addCatBtn.textContent = 'Add category';
      topRow.appendChild(newCatIconPicker.el);
      topRow.appendChild(newCatName);
      topRow.appendChild(addCatBtn);
      container.appendChild(topRow);
      const onAddCat = () => {
        const name = newCatName.value.trim();
        if (!name) return;
        const icon = newCatIconPicker.normalizeIconSlug(newCatIconPicker.getSlug());
        draft.categories.push({
          id: htGenId(),
          name,
          emoji: icon,
          order: draft.categories.length,
        });
        newCatName.value = '';
        newCatIconPicker.setValue('folder');
        htNormalizeHabitConfig(draft);
        this._htSchedulePersistHabitConfig();
        void this._htRefreshManageModeHabitSidebars();
      };
      addCatBtn.addEventListener('click', onAddCat);
      newCatName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') onAddCat();
      });

      const offDayRow = document.createElement('label');
      offDayRow.style.cssText =
        'display:flex;align-items:center;gap:8px;font-size:12px;color:#d4cfc6;margin-bottom:10px;cursor:pointer;';
      const offDayCb = document.createElement('input');
      offDayCb.type = 'checkbox';
      offDayCb.checked = !!draft.hideOffDayHabits;
      offDayCb.addEventListener('change', () => {
        draft.hideOffDayHabits = offDayCb.checked;
        htNormalizeHabitConfig(draft);
        this._htSchedulePersistHabitConfig();
        void this._htRefreshManageModeHabitSidebars();
      });
      offDayRow.appendChild(offDayCb);
      const offDayTxt = document.createElement('span');
      offDayTxt.textContent = 'Hide habits on off-days (weekdays not scheduled)';
      offDayRow.appendChild(offDayTxt);
      container.appendChild(offDayRow);

      const notesRow = document.createElement('label');
      notesRow.style.cssText =
        'display:flex;align-items:center;gap:8px;font-size:12px;color:#d4cfc6;margin-bottom:10px;cursor:pointer;';
      const notesCb = document.createElement('input');
      notesCb.type = 'checkbox';
      notesCb.checked = draft.showDayNotes !== false;
      notesCb.addEventListener('change', () => {
        draft.showDayNotes = notesCb.checked;
        htNormalizeHabitConfig(draft);
        this._htSchedulePersistHabitConfig();
        void this._htRefreshManageModeHabitSidebars();
        void this.refreshAllPanels({ skipManageModeHabitSidebar: true });
      });
      notesRow.appendChild(notesCb);
      const notesTxt = document.createElement('span');
      notesTxt.textContent = 'Show day notes field under habits';
      notesRow.appendChild(notesTxt);
      container.appendChild(notesRow);

      const finishInlineLayout = () => {
        htNormalizeHabitConfig(draft);
        this._htSchedulePersistHabitConfig();
        void this._htRefreshManageModeHabitSidebars();
        void this.refreshAllPanels({ skipManageModeHabitSidebar: true });
      };

      if (layoutAsIcons) {
        const layoutWrap = document.createElement('div');
        layoutWrap.style.cssText =
          'display:flex;flex-direction:column;gap:6px;margin-bottom:10px;';
        const lab = document.createElement('div');
        lab.style.cssText =
          'font-size:11px;color:var(--text-muted,#8a7e6a);text-transform:uppercase;letter-spacing:0.06em;';
        lab.textContent = 'Habit layout';
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;';
        const b1 = document.createElement('button');
        b1.type = 'button';
        b1.className = 'ht-btn ht-btn-sm';
        b1.title = 'Single column — journal list and editor cards';
        b1.innerHTML = htIcon('layout-list');
        const b2 = document.createElement('button');
        b2.type = 'button';
        b2.className = 'ht-btn ht-btn-sm';
        b2.title = 'Multi column — editor cards';
        b2.innerHTML = htIcon('layout-columns');
        const paintLayout = () => {
          const single = this._htReadHabitLayoutSingleColumn();
          b1.classList.toggle('ht-btn-primary', single);
          b1.classList.toggle('ht-btn-secondary', !single);
          b2.classList.toggle('ht-btn-primary', !single);
          b2.classList.toggle('ht-btn-secondary', single);
        };
        const applyLayout = (single) => {
          this._htWriteHabitLayoutSingleColumn(single);
          paintLayout();
          finishInlineLayout();
        };
        b1.addEventListener('click', (e) => {
          e.preventDefault();
          applyLayout(true);
        });
        b2.addEventListener('click', (e) => {
          e.preventDefault();
          applyLayout(false);
        });
        paintLayout();
        btnRow.append(b1, b2);
        layoutWrap.append(lab, btnRow);
        container.appendChild(layoutWrap);
      } else {
        const boardColRow = document.createElement('label');
        boardColRow.style.cssText =
          'display:flex;align-items:center;gap:8px;font-size:12px;color:#d4cfc6;margin-bottom:10px;cursor:pointer;';
        const boardColCb = document.createElement('input');
        boardColCb.type = 'checkbox';
        boardColCb.checked = this._htReadHabitLayoutSingleColumn();
        boardColCb.addEventListener('change', () => {
          this._htWriteHabitLayoutSingleColumn(boardColCb.checked);
          finishInlineLayout();
        });
        boardColRow.appendChild(boardColCb);
        const boardColLbl = document.createElement('span');
        boardColLbl.textContent =
          'Single column for habits in the journal and for the cards below';
        boardColRow.appendChild(boardColLbl);
        container.appendChild(boardColRow);
      }

      return;
    }

    container.innerHTML = '';
    
    const heading = document.createElement('div');
    heading.className = 'ht-section-title';
    heading.textContent = 'Habits & categories';
    container.appendChild(heading);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;color:#8a7e6a;margin:0 0 10px;line-height:1.45;';
    hint.textContent =
      'Turn suite tabs on or off above. Habits list below by category in the journal; filter by tag with the sunrise icon. Reorder categories with ↑↓; drag ⋮ to move habits between categories.';
    container.appendChild(hint);

    const offDayRow = document.createElement('label');
    offDayRow.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;color:#d4cfc6;margin-bottom:10px;cursor:pointer;';
    const offDayCb = document.createElement('input');
    offDayCb.type = 'checkbox';
    offDayCb.checked = !!draft.hideOffDayHabits;
    offDayCb.addEventListener('change', () => { draft.hideOffDayHabits = offDayCb.checked; });
    offDayRow.appendChild(offDayCb);
    const offDayTxt = document.createElement('span');
    offDayTxt.textContent = 'Hide habits on off-days (weekdays not scheduled)';
    offDayRow.appendChild(offDayTxt);
    container.appendChild(offDayRow);

    const notesRowModal = document.createElement('label');
    notesRowModal.style.cssText =
      'display:flex;align-items:center;gap:8px;font-size:12px;color:#d4cfc6;margin-bottom:10px;cursor:pointer;';
    const notesCbModal = document.createElement('input');
    notesCbModal.type = 'checkbox';
    notesCbModal.checked = draft.showDayNotes !== false;
    notesCbModal.addEventListener('change', () => {
      draft.showDayNotes = notesCbModal.checked;
    });
    notesRowModal.appendChild(notesCbModal);
    const notesTxtModal = document.createElement('span');
    notesTxtModal.textContent = 'Show day notes field under habits';
    notesRowModal.appendChild(notesTxtModal);
    container.appendChild(notesRowModal);

    const catIconPicker = this._htBuildCategoryIconPicker('folder', () => {});

    const topRow = document.createElement('div');
    topRow.className = 'ht-add-row';
    topRow.style.marginBottom = '10px';
    const newCatName = document.createElement('input');
    newCatName.className = 'ht-input';
    newCatName.placeholder = 'New category name';
    const addCatBtn = document.createElement('button');
    addCatBtn.className = 'ht-btn ht-btn-primary ht-btn-sm';
    addCatBtn.textContent = 'Add category';
    topRow.appendChild(catIconPicker.el);
    topRow.appendChild(newCatName);
    topRow.appendChild(addCatBtn);
    container.appendChild(topRow);

    const board = document.createElement('div');
    container.appendChild(board);

    const syncBoardGridCss = () => {
      const single = this._htReadHabitLayoutSingleColumn();
      board.style.cssText = [
        'display:grid',
        `grid-template-columns:${single ? 'minmax(0,1fr)' : 'repeat(auto-fit,minmax(240px,1fr))'}`,
        'gap:10px',
        'align-items:start',
      ].join(';');
    };

    let renderUnified = () => {};
    const finishMutation = () => {
      if (panelState) {
        htNormalizeHabitConfig(draft);
        draft.habitGroupMode = 'category';
        this._htSchedulePersistHabitConfig();
        void this._htRefreshManageModeHabitSidebars();
      } else {
        renderUnified();
      }
    };

    if (layoutAsIcons) {
      const layoutWrap = document.createElement('div');
      layoutWrap.style.cssText =
        'display:flex;flex-direction:column;gap:6px;margin-bottom:10px;';
      const lab = document.createElement('div');
      lab.style.cssText =
        'font-size:11px;color:var(--text-muted,#8a7e6a);text-transform:uppercase;letter-spacing:0.06em;';
      lab.textContent = 'Habit layout';
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;';
      const b1 = document.createElement('button');
      b1.type = 'button';
      b1.className = 'ht-btn ht-btn-sm';
      b1.title = 'Single column — journal list and editor cards';
      b1.innerHTML = htIcon('layout-list');
      const b2 = document.createElement('button');
      b2.type = 'button';
      b2.className = 'ht-btn ht-btn-sm';
      b2.title = 'Multi column — editor cards';
      b2.innerHTML = htIcon('layout-columns');
      const paintLayout = () => {
        const single = this._htReadHabitLayoutSingleColumn();
        b1.classList.toggle('ht-btn-primary', single);
        b1.classList.toggle('ht-btn-secondary', !single);
        b2.classList.toggle('ht-btn-primary', !single);
        b2.classList.toggle('ht-btn-secondary', single);
      };
      const applyLayout = (single) => {
        this._htWriteHabitLayoutSingleColumn(single);
        paintLayout();
        syncBoardGridCss();
        finishMutation();
        void this.refreshAllPanels({ skipManageModeHabitSidebar: !!panelState });
      };
      b1.addEventListener('click', (e) => {
        e.preventDefault();
        applyLayout(true);
      });
      b2.addEventListener('click', (e) => {
        e.preventDefault();
        applyLayout(false);
      });
      paintLayout();
      btnRow.append(b1, b2);
      layoutWrap.append(lab, btnRow);
      container.insertBefore(layoutWrap, board);
    } else {
      const boardColRow = document.createElement('label');
      boardColRow.style.cssText =
        'display:flex;align-items:center;gap:8px;font-size:12px;color:#d4cfc6;margin-bottom:10px;cursor:pointer;';
      const boardColCb = document.createElement('input');
      boardColCb.type = 'checkbox';
      boardColCb.checked = this._htReadHabitLayoutSingleColumn();
      boardColCb.addEventListener('change', () => {
        this._htWriteHabitLayoutSingleColumn(boardColCb.checked);
        finishMutation();
        void this.refreshAllPanels({ skipManageModeHabitSidebar: !!panelState });
      });
      boardColRow.appendChild(boardColCb);
      const boardColLbl = document.createElement('span');
      boardColLbl.textContent = 'Single column for habits in the journal and for the cards below';
      boardColRow.appendChild(boardColLbl);
      container.insertBefore(boardColRow, board);
    }

    let dragHabitId = null;
    const HT_SETTINGS_DRAG_ATTR = 'data-ht-settings-drag-habit';
    const normalizeOrders = () => {
      const byCat = new Map();
      for (const c of draft.categories) byCat.set(c.id, []);
      for (const h of draft.habits.filter((x) => !x.archived)) {
        if (!byCat.has(h.categoryId)) byCat.set(h.categoryId, []);
        byCat.get(h.categoryId).push(h);
      }
      for (const [, arr] of byCat) {
        arr.sort((a, b) => (a.order || 0) - (b.order || 0));
        arr.forEach((h, i) => { h.order = i; });
      }
    };
    const moveCategoryOrder = (catId, delta) => {
      const sorted = [...draft.categories].sort((a, b) => (a.order || 0) - (b.order || 0));
      const i = sorted.findIndex((c) => c.id === catId);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= sorted.length) return;
      const t = sorted[i];
      sorted[i] = sorted[j];
      sorted[j] = t;
      sorted.forEach((c, k) => {
        c.order = k;
      });
    };
    const moveHabit = (habitId, toCatId, toIndex) => {
      const moving = draft.habits.find((h) => h.id === habitId && !h.archived);
      if (!moving || !toCatId) return;
      moving.categoryId = toCatId;
      normalizeOrders();
      const list = draft.habits
        .filter((h) => !h.archived && h.categoryId === toCatId)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      const from = list.findIndex((h) => h.id === moving.id);
      if (from >= 0) list.splice(from, 1);
      const idx = Math.max(0, Math.min(toIndex, list.length));
      list.splice(idx, 0, moving);
      list.forEach((h, i) => { h.order = i; });
    };

    const clearDropVisuals = () => {
      for (const el of board.querySelectorAll('.ht-settings-habit-row')) {
        el.classList.remove('ht-settings-drop-before', 'ht-settings-drop-after');
      }
      for (const el of board.querySelectorAll('.ht-settings-habit-list')) {
        el.classList.remove('ht-settings-list-hover', 'ht-settings-list-drop-empty');
      }
    };
    const insertBeforeFromClientY = (listEl, clientY) => {
      const rows = [...listEl.querySelectorAll('.ht-settings-habit-row')];
      for (let i = 0; i < rows.length; i++) {
        const box = rows[i].getBoundingClientRect();
        const mid = box.top + box.height / 2;
        if (clientY < mid) return i;
      }
      return rows.length;
    };
    const paintDropIndicator = (listEl, clientY) => {
      clearDropVisuals();
      const beforeIdx = insertBeforeFromClientY(listEl, clientY);
      const rows = [...listEl.querySelectorAll('.ht-settings-habit-row')];
      listEl.classList.add('ht-settings-list-hover');
      if (rows.length === 0) {
        listEl.classList.add('ht-settings-list-drop-empty');
        return beforeIdx;
      }
      if (beforeIdx < rows.length) rows[beforeIdx].classList.add('ht-settings-drop-before');
      else rows[rows.length - 1].classList.add('ht-settings-drop-after');
      return beforeIdx;
    };

    const openHabitEditor = (habit) => {
      if (!habit) return;
      document.querySelector('.ht-edit-overlay')?.remove();
      const overlay = document.createElement('div');
      overlay.className = 'ht-edit-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:10020;';
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
      });
      const modal = document.createElement('div');
      modal.style.cssText = 'width:min(520px,92vw);background:rgba(24,22,30,0.98);border:1px solid rgba(255,255,255,0.16);border-radius:12px;padding:12px;';
      modal.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
          <div style="flex:1;font-weight:600;">Edit Habit</div>
          <button class="ht-btn ht-btn-secondary ht-btn-sm" data-action="close-edit">${htIcon('x')}</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:#8a7e6a;">
            Name
            <input class="ht-input" data-edit="name" />
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:#8a7e6a;">
            Category
            <select class="ht-select" data-edit="category"></select>
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:#8a7e6a;">
            Daily target count
            <input class="ht-input" type="number" min="0" data-edit="target" placeholder="0 = checkbox mode" />
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:#8a7e6a;">
            Unit
            <input class="ht-input" data-edit="unit" placeholder="mins, reps, pages..." />
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:#8a7e6a;grid-column:1 / -1;">
            Tags (comma-separated — free grouping alongside category)
            <input class="ht-input" data-edit="tags" placeholder="morning, health…" />
          </label>
          <div style="grid-column:1 / -1;">
            <div style="font-size:11px;color:#8a7e6a;margin-bottom:4px;">Active weekdays (Sun–Sat; none selected = every day)</div>
            <div style="display:flex;gap:4px;flex-wrap:wrap;" data-edit="weekdays-row"></div>
          </div>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:#8a7e6a;grid-column:1 / -1;">
            Streak seed date (optional)
            <input class="ht-input" type="date" data-edit="seed" />
          </label>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">
          <button class="ht-btn ht-btn-secondary ht-btn-sm" data-action="cancel-edit">Cancel</button>
          <button class="ht-btn ht-btn-primary ht-btn-sm" data-action="save-edit">Save</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      const nameInput = modal.querySelector('[data-edit="name"]');
      const categorySel = modal.querySelector('[data-edit="category"]');
      const targetInput = modal.querySelector('[data-edit="target"]');
      const unitInput = modal.querySelector('[data-edit="unit"]');
      const tagsInput = modal.querySelector('[data-edit="tags"]');
      const seedInput = modal.querySelector('[data-edit="seed"]');
      const wdRowEl = modal.querySelector('[data-edit="weekdays-row"]');
      nameInput.value = habit.name || '';
      targetInput.value = habit.target > 0 ? String(habit.target) : '';
      unitInput.value = habit.unit || '';
      tagsInput.value = (Array.isArray(habit.tags) ? habit.tags : []).join(', ');
      seedInput.value = habit.seedDate || '';
      const wdLabels = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
      const wdSel = new Set(Array.isArray(habit.weekdays) ? habit.weekdays : []);
      wdRowEl.innerHTML = '';
      const wdBtns = [];
      for (let i = 0; i < 7; i++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ht-btn ht-btn-secondary ht-btn-sm';
        b.dataset.wd = String(i);
        b.textContent = wdLabels[i];
        b.style.minWidth = '34px';
        const paintWd = (on) => {
          b.classList.toggle('ht-wd-on', on);
          if (on) {
            b.style.borderColor = 'rgba(102,153,255,0.85)';
            b.style.background = 'rgba(102,153,255,0.18)';
            b.style.color = '#dbe7ff';
          } else {
            b.style.borderColor = '';
            b.style.background = '';
            b.style.color = '';
          }
        };
        paintWd(wdSel.has(i));
        b.addEventListener('click', () => paintWd(!b.classList.contains('ht-wd-on')));
        wdRowEl.appendChild(b);
        wdBtns.push(b);
      }
      for (const c of draft.categories) {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.name || '';
        if (c.id === habit.categoryId) o.selected = true;
        categorySel.appendChild(o);
      }
      const close = () => overlay.remove();
      modal.querySelector('[data-action="close-edit"]')?.addEventListener('click', close);
      modal.querySelector('[data-action="cancel-edit"]')?.addEventListener('click', close);
      modal.querySelector('[data-action="save-edit"]')?.addEventListener('click', () => {
        const nm = String(nameInput.value || '').trim();
        if (!nm) return;
        const prevSeed = habit.seedDate || null;
        habit.name = nm;
        habit.categoryId = categorySel.value || habit.categoryId;
        const tRaw = String(targetInput.value || '').trim();
        const tVal = tRaw === '' ? 0 : parseInt(tRaw, 10);
        habit.target = Number.isInteger(tVal) && tVal > 0 ? tVal : 0;
        habit.unit = String(unitInput.value || '').trim() || null;
        habit.tags = String(tagsInput.value || '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
        habit.weekdays = wdBtns
          .filter((b) => b.classList.contains('ht-wd-on'))
          .map((b) => parseInt(b.dataset.wd, 10))
          .sort((a, b) => a - b);
        habit.seedDate = String(seedInput.value || '').trim() || null;
        normalizeOrders();
        close();
        finishMutation();
        this._htOnHabitSeedDateMaybeBackfill(habit, prevSeed);
      });
      nameInput.focus();
      nameInput.select();
    };

    renderUnified = () => {
      const scrollHost =
        container.closest('.ht-modal-body') ||
        container.closest('[data-jhs-settings-scroll]') ||
        container.closest('.ht-sidebar-body') ||
        container;
      const prevScroll = scrollHost.scrollTop;
      try {
        board.innerHTML = '';
        syncBoardGridCss();
        clearDropVisuals();

        const appendHabitRow = (listEl, habit) => {
        const row = document.createElement('div');
        row.draggable = false;
        row.dataset.unifiedHabitId = habit.id;
        row.className = 'ht-settings-habit-row';
        row.style.cssText =
          'display:flex;align-items:center;gap:6px;padding:6px;border-radius:7px;border:1px solid rgba(255,255,255,0.12);background:rgba(20,20,24,0.4);user-select:none;';
        const targetHint = habit.target > 0 ? ` · ${habit.target}${habit.unit ? ' ' + habit.unit : ''}` : '';
        row.innerHTML = `
            <span class="ht-settings-habit-drag-grip" draggable="true" title="Drag to reorder or move between lists" style="opacity:.7;cursor:grab;touch-action:none;">${htIcon('grip-vertical')}</span>
            <span draggable="false" style="flex:1;font-size:12px;line-height:1.25;">${htEsc(habit.name)}<span style="opacity:.65;">${targetHint}</span></span>
            <button type="button" draggable="false" class="ht-btn ht-btn-secondary ht-btn-sm" data-action="edit-habit" title="Edit">${htIcon('pencil')}</button>
            <button type="button" draggable="false" class="ht-btn ht-btn-secondary ht-btn-sm" data-action="archive-habit" title="Archive">${htIcon('package')}</button>
            <button type="button" draggable="false" class="ht-btn ht-btn-danger ht-btn-sm" data-action="del-habit" title="Delete">${htIcon('trash')}</button>
          `;
        const grip = row.querySelector('.ht-settings-habit-drag-grip');
        const onGripDragStart = (ev) => {
          try {
            ev.stopPropagation();
            ev.dataTransfer.effectAllowed = 'move';
            const hid = String(habit.id);
            ev.dataTransfer.setData('text/plain', hid);
            try {
              ev.dataTransfer.setData('application/x-thymer-habit-id', hid);
            } catch (_) {}
            try {
              const ox = Math.min(48, Math.max(8, ev.offsetX + 6));
              const oy = Math.min(22, Math.max(6, ev.offsetY + 8));
              ev.dataTransfer.setDragImage(row, ox, oy);
            } catch (_) {}
          } catch (_) {}
          dragHabitId = habit.id;
          try {
            document.body.setAttribute(HT_SETTINGS_DRAG_ATTR, String(habit.id));
          } catch (_) {}
          row.style.opacity = '0.45';
        };
        const onGripDragEnd = () => {
          row.style.opacity = '';
          clearDropVisuals();
          try {
            document.body.removeAttribute(HT_SETTINGS_DRAG_ATTR);
          } catch (_) {}
          requestAnimationFrame(() => {
            dragHabitId = null;
          });
        };
        grip?.addEventListener('dragstart', onGripDragStart);
        grip?.addEventListener('dragend', onGripDragEnd);
        row.querySelector('[data-action="archive-habit"]')?.addEventListener('click', () => {
          habit.archived = true;
          finishMutation();
        });
        row.querySelector('[data-action="edit-habit"]')?.addEventListener('click', () => {
          openHabitEditor(habit);
        });
        row.querySelector('[data-action="del-habit"]')?.addEventListener('click', () => {
          const idx = draft.habits.findIndex((h) => h.id === habit.id);
          if (idx >= 0) draft.habits.splice(idx, 1);
          finishMutation();
        });
        listEl.appendChild(row);
      };

      /**
       * Drop zone = whole card (header + dashed list + add row) so dragover still fires over
       * padding/inputs; listEl is used for insert index math.
       */
      const wireHabitListDnD = (listEl, onDrop, zoneEl = null) => {
        const zone = zoneEl || listEl;
        listEl.classList.add('ht-settings-habit-list');
        let paintRaf = null;
        let pendingY = null;

        const dragActive = (e) => {
          const dtTypes = e.dataTransfer?.types ? Array.from(e.dataTransfer.types) : [];
          let bodyId = '';
          try {
            bodyId = String(document.body.getAttribute(HT_SETTINGS_DRAG_ATTR) || '').trim();
          } catch (_) {}
          return !!(
            dragHabitId ||
            dtTypes.includes('text/plain') ||
            dtTypes.includes('application/x-thymer-habit-id') ||
            bodyId
          );
        };

        const flushPaint = () => {
          paintRaf = null;
          if (pendingY == null) return;
          const y0 = pendingY;
          pendingY = null;
          const rows = [...listEl.querySelectorAll('.ht-settings-habit-row')];
          const rect = listEl.getBoundingClientRect();
          const y =
            rows.length === 0
              ? y0
              : Math.min(Math.max(y0, rect.top + 2), rect.bottom - 2);
          listEl._htPendingDropIdx = paintDropIndicator(listEl, y);
        };

        const onDragOver = (e) => {
          e.preventDefault();
          try {
            e.dataTransfer.dropEffect = 'move';
          } catch (_) {}
          if (!dragActive(e)) return;
          pendingY = e.clientY;
          if (paintRaf == null) {
            paintRaf = requestAnimationFrame(flushPaint);
          }
        };

        zone.addEventListener(
          'dragenter',
          (e) => {
            if (!dragActive(e)) return;
            e.preventDefault();
          },
          false
        );
        zone.addEventListener('dragover', onDragOver, false);
        zone.addEventListener('dragleave', (e) => {
          if (zone.contains(e.relatedTarget)) return;
          if (paintRaf != null) {
            cancelAnimationFrame(paintRaf);
            paintRaf = null;
          }
          pendingY = null;
          clearDropVisuals();
        });
        zone.addEventListener('drop', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (paintRaf != null) {
            cancelAnimationFrame(paintRaf);
            paintRaf = null;
          }
          pendingY = null;
          const rect = listEl.getBoundingClientRect();
          const rows = [...listEl.querySelectorAll('.ht-settings-habit-row')];
          const y =
            rows.length === 0
              ? e.clientY
              : Math.min(Math.max(e.clientY, rect.top + 2), rect.bottom - 2);
          const beforeIdx =
            typeof listEl._htPendingDropIdx === 'number'
              ? listEl._htPendingDropIdx
              : insertBeforeFromClientY(listEl, y);
          listEl._htPendingDropIdx = undefined;
          clearDropVisuals();
          let habitId = String(e.dataTransfer?.getData?.('text/plain') || '').trim();
          if (!habitId) {
            try {
              habitId = String(e.dataTransfer?.getData?.('application/x-thymer-habit-id') || '').trim();
            } catch (_) {}
          }
          if (!habitId) habitId = String(dragHabitId || '').trim();
          if (!habitId) {
            try {
              habitId = String(document.body.getAttribute(HT_SETTINGS_DRAG_ATTR) || '').trim();
            } catch (_) {}
          }
          try {
            document.body.removeAttribute(HT_SETTINGS_DRAG_ATTR);
          } catch (_) {}
          if (!habitId) return;
          onDrop(habitId, beforeIdx);
          dragHabitId = null;
          finishMutation();
        });
      };

      const cats = [...draft.categories].sort((a, b) => (a.order || 0) - (b.order || 0));
      if (cats.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'font-size:12px;color:#8a7e6a;padding:8px 2px;';
        empty.textContent = 'Add your first category to begin.';
        board.appendChild(empty);
        return;
      }
      for (let ci = 0; ci < cats.length; ci++) {
        const cat = cats[ci];
        const card = document.createElement('div');
        card.style.cssText = 'border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.04);border-radius:10px;padding:10px;min-height:150px;';

        const head = document.createElement('div');
        head.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:8px;';
        const upCat = document.createElement('button');
        upCat.type = 'button';
        upCat.className = 'ht-btn ht-btn-secondary ht-btn-sm';
        upCat.title = 'Move category up';
        upCat.style.cssText = 'padding:2px 5px;min-width:0;';
        upCat.innerHTML = htIcon('chevron-up');
        upCat.disabled = ci <= 0;
        upCat.addEventListener('click', () => {
          moveCategoryOrder(cat.id, -1);
          finishMutation();
        });
        const downCat = document.createElement('button');
        downCat.type = 'button';
        downCat.className = 'ht-btn ht-btn-secondary ht-btn-sm';
        downCat.title = 'Move category down';
        downCat.style.cssText = 'padding:2px 5px;min-width:0;';
        downCat.innerHTML = htIcon('chevron-down');
        downCat.disabled = ci >= cats.length - 1;
        downCat.addEventListener('click', () => {
          moveCategoryOrder(cat.id, 1);
          finishMutation();
        });
        const iconPicker = this._htBuildCategoryIconPicker(cat.emoji || 'folder', (slug) => {
          cat.emoji = slug;
          finishMutation();
        });
        const nameInput = document.createElement('input');
        nameInput.className = 'ht-input';
        nameInput.value = cat.name || '';
        nameInput.style.cssText = 'flex:1;min-width:0;height:28px;padding:4px 8px;';
        nameInput.addEventListener('change', () => {
          const nm = nameInput.value.trim();
          if (nm) cat.name = nm;
          else nameInput.value = cat.name || '';
          if (panelState) this._htSchedulePersistHabitConfig();
        });
        const delCatBtn = document.createElement('button');
        delCatBtn.className = 'ht-btn ht-btn-danger ht-btn-sm';
        delCatBtn.title = 'Delete category';
        delCatBtn.innerHTML = htIcon('trash');
        delCatBtn.addEventListener('click', () => {
          if (!confirm(`Delete category "${cat.name}" and all habits in it?`)) return;
          draft.categories = draft.categories.filter((c) => c.id !== cat.id);
          draft.habits = draft.habits.filter((h) => h.categoryId !== cat.id);
          finishMutation();
        });
        head.appendChild(upCat);
        head.appendChild(downCat);
        head.appendChild(iconPicker.el);
        head.appendChild(nameInput);
        head.appendChild(delCatBtn);
        card.appendChild(head);

        const list = document.createElement('div');
        list.style.cssText = 'display:flex;flex-direction:column;gap:6px;min-height:70px;padding:6px;border-radius:8px;border:1px dashed rgba(255,255,255,0.08);';
        const habits = draft.habits
          .filter((h) => !h.archived && h.categoryId === cat.id)
          .sort((a, b) => (a.order || 0) - (b.order || 0));
        if (habits.length === 0) {
          const empty = document.createElement('div');
          empty.style.cssText = 'font-size:11px;color:#8a7e6a;padding:8px 3px;';
          empty.textContent = 'Drop habits here';
          list.appendChild(empty);
        }
        for (const habit of habits) appendHabitRow(list, habit);

        const addRow = document.createElement('div');
        addRow.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
        const addInput = document.createElement('input');
        addInput.className = 'ht-input';
        addInput.placeholder = `Add habit to ${cat.name}`;
        addInput.style.cssText = 'flex:1;min-width:0;';
        const addBtn = document.createElement('button');
        addBtn.className = 'ht-btn ht-btn-primary ht-btn-sm';
        addBtn.textContent = 'Add';
        const addHabit = () => {
          const nm = addInput.value.trim();
          if (!nm) return;
          const order = draft.habits.filter((h) => !h.archived && h.categoryId === cat.id).length;
          draft.habits.push({
            id: htGenId(),
            name: nm,
            categoryId: cat.id,
            order,
            tags: [],
            weekdays: [],
          });
          addInput.value = '';
          finishMutation();
        };
        addBtn.addEventListener('click', addHabit);
        addInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') addHabit();
        });
        addRow.appendChild(addInput);
        addRow.appendChild(addBtn);
        card.appendChild(list);
        card.appendChild(addRow);
        wireHabitListDnD(
          list,
          (habitId, beforeIdx) => {
            moveHabit(habitId, cat.id, beforeIdx);
          },
          card
        );

        board.appendChild(card);
      }
      } finally {
        requestAnimationFrame(() => {
          scrollHost.scrollTop = prevScroll;
        });
      }
    };

    addCatBtn.addEventListener('click', () => {
      const name = newCatName.value.trim();
      if (!name) return;
      const icon = catIconPicker.normalizeIconSlug(catIconPicker.getSlug());
      draft.categories.push({ id: htGenId(), name, emoji: icon, order: draft.categories.length });
      newCatName.value = '';
      catIconPicker.setValue('folder');
      finishMutation();
    });
    newCatName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addCatBtn.click();
    });

    renderUnified();

  }
}
