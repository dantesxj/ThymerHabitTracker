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

  function findVaultRecord(records, pluginId) {
    if (!records) return null;
    for (const x of records) {
      if (isVaultRow(x, pluginId)) return x;
    }
    return null;
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
 * Data model — workspace **Plugin Backend** collection (`ThymerPluginSettings`):
 *   - **Vault** row (`plugin_id` = `habit-tracker`, `record_kind` = `vault`): synced localStorage mirror for panel UI keys.
 *   - **Config** row (`record_kind` = `config`, `plugin_id` = `habit-tracker:config`, record title `config`): categories/habits JSON in `settings_json`.
 *   - **Log** rows (`record_kind` = `log`, `plugin_id` = `habit-tracker:log:YYYY-MM-DD`, title = date): per-day completions JSON in `settings_json`.
 *   Use the **Plugin** column (`habit-tracker`) in Thymer to filter Kanban/list views across row kinds.
 *
 * One-time migration: if a legacy **HabitTracker** collection exists, its `__config__` and `log-*` records are copied into Plugin Backend (see `HT_PS_MIGRATE_KEY` in localStorage).
 *
 * Config / log JSON shapes unchanged from the old collection plugin.
 *
 * Streaks are calculated on-the-fly by scanning log rows.
 */

const HT_PS_SLUG = 'habit-tracker';
const HT_PS_ROW_CONFIG = 'habit-tracker:config';
const HT_PS_MIGRATE_KEY = 'ht_global_ps_migration_v1';
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
  .ht-toggle-btn .ti { font-size: 15px; }
  .ht-category-caret .ti { font-size: 9px; color: #8a7e6a; }
  .ht-category-status .ti { font-size: 13px; }
  .ht-streak-badge .ti { font-size: 11px; opacity: 0.9; }
  .ht-habit-check .ti { font-size: 14px; color: #4caf50; }
  .ht-habit-ring-label .ti { font-size: 11px; display: block; margin-top: 1px; }
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
    background: #4caf50;
    border-radius: 2px;
    transition: width 0.35s ease;
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

  /* ── Habit row (TickTick-inspired: airy rows, rounded square checks, teal done state) ── */
  .ht-habit {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    margin: 0 4px 3px;
    border-radius: 8px;
    border: 1px solid transparent;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }
  .ht-habit:hover {
    background: rgba(255,255,255,0.06);
    border-color: rgba(255,255,255,0.06);
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
  { slug: 'flame', label: 'Flame' },
  { slug: 'heart', label: 'Heart' },
  { slug: 'star', label: 'Star' },
  { slug: 'bolt', label: 'Bolt' },
  { slug: 'moon', label: 'Moon' },
  { slug: 'sun', label: 'Sun' },
  { slug: 'droplet', label: 'Droplet' },
  { slug: 'coffee', label: 'Coffee' },
  { slug: 'book', label: 'Book' },
  { slug: 'barbell', label: 'Barbell' },
  { slug: 'music', label: 'Music' },
  { slug: 'bike', label: 'Bike' },
  { slug: 'run', label: 'Run' },
  { slug: 'pill', label: 'Pill' },
  { slug: 'brush', label: 'Brush' },
  { slug: 'home', label: 'Home' },
  { slug: 'briefcase', label: 'Briefcase' },
  { slug: 'plane', label: 'Plane' },
  { slug: 'tree', label: 'Tree' },
  { slug: 'leaf', label: 'Leaf' },
  { slug: 'apple', label: 'Apple' },
  { slug: 'carrot', label: 'Carrot' },
  { slug: 'trophy', label: 'Trophy' },
  { slug: 'puzzle', label: 'Puzzle' },
  { slug: 'gift', label: 'Gift' },
  { slug: 'flag', label: 'Flag' },
  { slug: 'bookmark', label: 'Bookmark' },
  { slug: 'compass', label: 'Compass' },
  { slug: 'brain', label: 'Brain' },
  { slug: 'plant', label: 'Plant' },
  { slug: 'dog', label: 'Dog' },
  { slug: 'cat', label: 'Cat' },
  { slug: 'tools', label: 'Tools' },
  { slug: 'palette', label: 'Palette' },
  { slug: 'users', label: 'People' },
  { slug: 'chart-line', label: 'Chart' },
  { slug: 'device-mobile', label: 'Phone' },
  { slug: 'zzz', label: 'Sleep' },
  { slug: 'sparkles', label: 'Sparkles' },
  { slug: 'infinity', label: 'Infinity' },
  { slug: 'pray', label: 'Pray' },
  { slug: 'mountain', label: 'Mountain' },
  { slug: 'beach', label: 'Beach' },
  { slug: 'snowflake', label: 'Snowflake' },
];

function htCategoryGlyphHtml(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return htIcon('folder');
  if (/^[a-z][a-z0-9-]*$/.test(s) && s.length < 48) return htIcon(s);
  return `<span class="ht-emoji-inline">${htEsc(s)}</span>`;
}

function htFillIconSelect(selectEl, currentValue) {
  const cur = String(currentValue ?? '').trim();
  const slugSet = new Set(HT_CATEGORY_ICONS.map(x => x.slug));
  selectEl.innerHTML = '';
  for (const { slug, label } of HT_CATEGORY_ICONS) {
    const o = document.createElement('option');
    o.value = slug;
    o.textContent = label;
    selectEl.appendChild(o);
  }
  if (cur && !slugSet.has(cur)) {
    const o = document.createElement('option');
    o.value = cur;
    o.textContent = `Other: ${cur}`;
    selectEl.insertBefore(o, selectEl.firstChild);
  }
  if (cur) {
    selectEl.value = cur;
  } else {
    selectEl.value = 'folder';
  }
}

function htBindIconPreview(selectEl, previewEl) {
  const sync = () => { previewEl.innerHTML = htCategoryGlyphHtml(selectEl.value); };
  selectEl.addEventListener('change', sync);
  sync();
}

function htGenId() {
  return Math.random().toString(36).slice(2, 10);
}

// ─── Plugin ───────────────────────────────────────────────────────────────────
class Plugin extends AppPlugin {

  _htPluginSettingsMirrorKeys() {
    return ['ht_sidebar_collapsed', 'ht_cat_collapsed', 'ht_stats_range'];
  }

  _htPluginSettingsFlush() {
    if (!this._persistState) return;
    globalThis.ThymerPluginSettings?.scheduleFlush?.(this, () => this._htPluginSettingsMirrorKeys());
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async onLoad() {
    this._panelStates = new Map();
    this._eventIds = [];
    this._htNavTimers = new Map();
    this._persistState = (this.getConfiguration?.()?.custom ?? this.config?.custom)?.persist_habit_panel_state !== false;
    try {
      await globalThis.ThymerPluginSettings?.upgradeCollectionSchema?.(this.data);
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
    this._config = null; // { categories: [], habits: [] }

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

    await this._migrateLegacyHabitTrackerToPluginSettings();
    await this._loadConfig();

    // Listen to panel events (defer navigated so journal record/date match the UI)
    this._eventIds.push(this.events.on('panel.navigated', (ev) => this._deferPanelChanged(ev.panel)));
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
    for (const t of (this._htNavTimers || new Map()).values()) {
      try { clearTimeout(t); } catch (e) {}
    }
    this._htNavTimers?.clear();
    this._cmdSettings?.remove?.();
    this._cmdRefresh?.remove?.();
    this._cmdCleanup?.remove?.();
    this._cmdDiag?.remove?.();
    this._cmdStorage?.remove?.();

    for (const [, state] of (this._panelStates || [])) {
      this._disposeState(state);
    }
    this._panelStates?.clear?.();
  }

  // ── Plugin Backend storage ───────────────────────────────────────────────

  _tps() {
    return globalThis.ThymerPluginSettings;
  }

  _readJsonStore(r) {
    if (!r) return '';
    const tps = this._tps();
    if (tps?.rowField) {
      const j = tps.rowField(r, 'settings_json');
      if (j) return j;
    }
    return (
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
    const tps = this._tps();
    if (!tps?.listRows || !this.data) return [];
    try {
      return await tps.listRows(this.data, { pluginSlug: HT_PS_SLUG, recordKind });
    } catch (e) {
      console.error('[HabitTracker] listRows', e);
      return [];
    }
  }

  async _migrateLegacyHabitTrackerToPluginSettings() {
    let done = false;
    try {
      done = localStorage.getItem(HT_PS_MIGRATE_KEY) === '1';
    } catch (_) {}
    if (done) return;
    const tps = this._tps();
    if (!tps?.createDataRow || !this.data) return;
    let legacy = null;
    try {
      const all = await this.data.getAllCollections();
      legacy = all.find((c) => (c.getName?.() || '') === 'HabitTracker') || null;
    } catch (_) {}
    if (!legacy) {
      try {
        localStorage.setItem(HT_PS_MIGRATE_KEY, '1');
      } catch (_) {}
      return;
    }
    let records = [];
    try {
      records = await legacy.getAllRecords();
    } catch (_) {
      return;
    }
    const readLegacyData = (rec) =>
      rec.text?.('data') || rec.prop?.('data')?.text?.() || rec.prop?.('data')?.get?.() || '';
    const readLegacyNotes = (rec) => {
      const t =
        rec.text?.('notes') || rec.prop?.('notes')?.text?.() || rec.prop?.('notes')?.get?.();
      return t == null ? '' : String(t);
    };
    const cfgRows = await this._psListByKind('config');
    if (cfgRows.length === 0) {
      const cfgRec = records.find((r) => (r.getName?.() || '') === '__config__');
      const raw = cfgRec ? readLegacyData(cfgRec) : '';
      if (raw && String(raw).trim()) {
        try {
          const doc = JSON.parse(raw);
          await tps.createDataRow(this.data, {
            pluginSlug: HT_PS_SLUG,
            recordKind: 'config',
            rowPluginId: HT_PS_ROW_CONFIG,
            recordTitle: 'config',
            settingsDoc: doc,
          });
        } catch (e) {
          console.warn('[HabitTracker] migrate config', e);
        }
      }
    }
    const existingLogs = await this._psListByKind('log');
    const existingIds = new Set(existingLogs.map((r) => tps.rowField(r, 'plugin_id')));
    for (const r of records) {
      const name = r.getName?.() || '';
      if (!name.startsWith('log-')) continue;
      const dateStr = name.slice(4);
      const rowId = htPsRowLog(dateStr);
      if (existingIds.has(rowId)) continue;
      const raw = readLegacyData(r);
      if (!raw || !String(raw).trim()) continue;
      try {
        const d = JSON.parse(raw);
        const notes = readLegacyNotes(r);
        if (notes) d.notes = notes;
        if (!d.date) d.date = dateStr;
        await tps.createDataRow(this.data, {
          pluginSlug: HT_PS_SLUG,
          recordKind: 'log',
          rowPluginId: rowId,
          recordTitle: dateStr,
          settingsDoc: d,
        });
        existingIds.add(rowId);
      } catch (e) {
        console.warn('[HabitTracker] migrate log', dateStr, e);
      }
    }
    try {
      localStorage.setItem(HT_PS_MIGRATE_KEY, '1');
    } catch (_) {}
  }

  async _loadConfig() {
    this._config = { categories: [], habits: [] };
    try {
      const rows = await this._psListByKind('config');
      const row = rows[0];
      if (!row) return;
      const raw = this._readJsonStore(row);
      if (raw && String(raw).trim()) this._config = JSON.parse(raw);
    } catch (e) {
      console.error('[HabitTracker] Error loading config:', e);
      this._config = { categories: [], habits: [] };
    }
  }

  async _saveConfig() {
    try {
      const rows = await this._psListByKind('config');
      if (rows.length) {
        this._writeJsonStore(rows[0], this._config);
        return;
      }
      const tps = this._tps();
      if (!tps?.createDataRow || !this.data) return;
      await tps.createDataRow(this.data, {
        pluginSlug: HT_PS_SLUG,
        recordKind: 'config',
        rowPluginId: HT_PS_ROW_CONFIG,
        recordTitle: 'config',
        settingsDoc: this._config,
      });
    } catch (e) {
      console.error('[HabitTracker] Error saving config:', e);
    }
  }

  async _loadLog(dateStr) {
    const empty = () => ({ date: dateStr, completions: {}, categoryDone: {}, notes: '' });
    try {
      const rows = await this._psListByKind('log');
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

  async _getAllLogRows() {
    return this._psListByKind('log');
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
      const log = logsByDate.get(d);
      if (log && log.completions && log.completions[habitId]) {
        streak++;
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

  async _saveLog(dateStr, logData) {
    const tps = this._tps();
    if (!tps?.createDataRow || !this.data) return;
    try {
      if (logData.notes == null) logData.notes = '';
      const rid = htPsRowLog(dateStr);
      const rows = await this._psListByKind('log');
      const existing = rows.filter((r) => (tps.rowField?.(r, 'plugin_id') || '') === rid);
      for (const r of existing) {
        const raw = this._readJsonStore(r);
        if (raw && String(raw).trim()) {
          this._writeJsonStore(r, logData);
          return;
        }
      }
      await tps.createDataRow(this.data, {
        pluginSlug: HT_PS_SLUG,
        recordKind: 'log',
        rowPluginId: rid,
        recordTitle: dateStr,
        settingsDoc: logData,
      });
    } catch (e) {
      console.error('[HabitTracker] Error saving log:', e);
    }
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

  // ── Panel mounting ───────────────────────────────────────────────────────

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
    if (!panelId) return;

    const panelEl = panel?.getElement?.();
    if (!panelEl) {
      this._cleanupHabitPanel(panelId);
      return;
    }

    // Only mount on journal/daily note pages
    const nav = panel?.getNavigation?.();
    const navType = nav?.type || '';
    if (navType === 'custom' || navType === 'custom_panel') {
      this._cleanupHabitPanel(panelId);
      return;
    }

    const record = panel?.getActiveRecord?.();
    if (!record) {
      this._cleanupHabitPanel(panelId);
      return;
    }

    // Only show on journal records (daily notes) — must have journal details
    const journalDetails = record.getJournalDetails?.();
    if (!journalDetails) {
      this._cleanupHabitPanel(panelId);
      return;
    }

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
    this._cleanupHabitPanel(panelId);
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
    toggleBtn.innerHTML = this._collapsed ? htIcon('chevron-down') : htIcon('chevron-up');
    toggleBtn.addEventListener('click', () => this._toggleCollapse());

    const titleEl = document.createElement('span');
    titleEl.className = 'ht-sidebar-title';
    titleEl.innerHTML = `${htIcon('flame')} Habits`;

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
    statsBtn.innerHTML = htIcon('chart-bar');
    statsBtn.title = 'View stats';

    const enterStats = () => {
      body.dataset.mode = 'stats';
      statsBtn.innerHTML = htIcon('arrow-left');
      statsBtn.title = 'Back to habits';
      statsBtn.classList.add('active');
      prevBtn.style.display = 'none';
      dateEl.style.display = 'none';
      nextBtn.style.display = 'none';
      this._renderStats(state, body);
    };
    const exitStats = () => {
      body.dataset.mode = 'habits';
      statsBtn.innerHTML = htIcon('chart-bar');
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
    if (this._persistState) {
      localStorage.setItem('ht_sidebar_collapsed', String(this._collapsed));
      this._htPluginSettingsFlush();
    }
    for (const [, state] of (this._panelStates || [])) {
      if (!state.sidebarEl) continue;
      state.sidebarEl.classList.toggle('ht-collapsed', this._collapsed);
      const btn = state.sidebarEl.querySelector('.ht-toggle-btn');
      if (btn) {
        btn.innerHTML = this._collapsed ? htIcon('chevron-down') : htIcon('chevron-up');
        btn.title = this._collapsed ? 'Expand habits' : 'Collapse habits';
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
      const dateStrEmpty = state.dateStr || htToday();
      const logRowsEmpty = await this._getAllLogRows();
      if (stale()) return;
      const logEmpty = this._getLogForDateFromMap(this._buildLogsByDateMapFromRows(logRowsEmpty), dateStrEmpty);
      body.innerHTML = '';
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'ht-empty';
      emptyDiv.innerHTML = `
        <div class="ht-empty-icon">${htIcon('plant')}</div>
        <div>No habits yet.</div>
        <div style="margin-top:4px;font-size:11px;">Open settings to add categories and habits.</div>
        <button class="ht-setup-btn" data-action="open-settings">Set up habits</button>
      `;
      emptyDiv.querySelector('[data-action="open-settings"]')?.addEventListener('click', () => this.openSettings());
      body.appendChild(emptyDiv);
      this._renderNotesSection(body, logEmpty, dateStrEmpty, state, token);
      return;
    }

    // One Plugin Backend load: log rows + merged map for streak badges
    const dateStr = state.dateStr || htToday();
    const logRows = await this._getAllLogRows();
    if (stale()) return;
    const logsByDate = this._buildLogsByDateMapFromRows(logRows);
    const log = this._getLogForDateFromMap(logsByDate, dateStr);

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

      const streak = this._categoryStreakFromMap(cat.id, undefined, logsByDate, cat);
      const isOpen = !this._catCollapsed[cat.id];

      const catEl = document.createElement('div');
      catEl.className = 'ht-category';

      const catHeader = document.createElement('div');
      catHeader.className = 'ht-category-header';
      catHeader.innerHTML = `
        <span class="ht-category-caret ${isOpen ? 'open' : ''}">${htIcon('chevron-right')}</span>
        <span class="ht-category-emoji">${htCategoryGlyphHtml(cat.emoji)}</span>
        <span class="ht-category-name">${htEsc(cat.name)}</span>
        <span class="ht-category-status ${catIsDone ? 'ht-cat-done' : 'ht-cat-pending'}">
          ${catIsDone ? htIcon('circle-check') : htIcon('circle')}
        </span>
        ${streak > 0 ? `<span class="ht-streak-badge">${htIcon('flame')}${streak}d</span>` : ''}
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
        const hStreak = this._habitStreakFromMap(habit.id, undefined, logsByDate, habit);

        const habitEl = document.createElement('div');
        habitEl.className = 'ht-habit' + (isDone ? ' ht-done' : '');
        habitEl.dataset.habitId = habit.id;

        // Build the left indicator — ring for numeric, circle checkbox for boolean
        let indicatorHTML = '';
        if (isNumeric) {
          const r = 8; const circ = 2 * Math.PI * r;
          const pct = Math.min(1, currentVal / habit.target);
          const dash = circ * pct;
          const label = currentVal >= habit.target ? htIcon('check') : `${currentVal}`;
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
          indicatorHTML = `<div class="ht-habit-check">${isDone ? htIcon('check') : ''}</div>`;
        }

        const unitLabel = habit.unit ? htEsc(habit.unit) : '';
        const targetLabel = hasTarget ? `<span style="font-size:10px;color:#8a7e6a;margin-left:2px;">${currentVal}/${habit.target}${unitLabel ? ' ' + unitLabel : ''}</span>` : '';
        const streakHTML = hStreak > 0 ? `<span class="ht-habit-streak ${hStreak >= 7 ? 'hot' : ''}">${htIcon('flame')}${hStreak}d</span>` : '';

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
    this._renderNotesSection(body, log, dateStr, state, token);
  }

  _toggleCategory(catId, state) {
    this._catCollapsed[catId] = !this._catCollapsed[catId];
    if (this._persistState) {
      localStorage.setItem('ht_cat_collapsed', JSON.stringify(this._catCollapsed));
      this._htPluginSettingsFlush();
    }

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
      if (label) label.innerHTML = isDone ? htIcon('check') : String(currentVal);
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
      if (check) check.innerHTML = isDone ? htIcon('check') : '';
    }

    // Update category header status badge and streak badge
    const habitsEl = habitEl.closest('.ht-category-habits');
    const catHeader = habitsEl?.previousElementSibling;
    if (catHeader) {
      const statusEl = catHeader.querySelector('.ht-category-status');
      const catDone = !!(log.categoryDone[catId]);
      if (statusEl) {
        statusEl.className = `ht-category-status ${catDone ? 'ht-cat-done' : 'ht-cat-pending'}`;
        statusEl.innerHTML = catDone ? htIcon('circle-check') : htIcon('circle');
      }
    }

    // Recompute streaks immediately so click updates are visible without refresh.
    try {
      const logsByDate = await this._loadAllLogsByDate();
      const habitStreak = this._habitStreakFromMap(habit.id, undefined, logsByDate, habit);
      const habitNameEl = habitEl.querySelector('.ht-habit-name');
      let habitStreakEl = habitEl.querySelector('.ht-habit-streak');
      if (habitStreak > 0) {
        if (!habitStreakEl && habitNameEl) {
          habitStreakEl = document.createElement('span');
          habitEl.appendChild(habitStreakEl);
        }
        if (habitStreakEl) {
          habitStreakEl.className = `ht-habit-streak ${habitStreak >= 7 ? 'hot' : ''}`.trim();
          habitStreakEl.innerHTML = `${htIcon('flame')}${habitStreak}d`;
        }
      } else if (habitStreakEl) {
        habitStreakEl.remove();
      }

      if (catHeader) {
        const cat = (this._config?.categories || []).find((c) => c.id === catId) || null;
        const catStreak = this._categoryStreakFromMap(catId, undefined, logsByDate, cat);
        let catStreakEl = catHeader.querySelector('.ht-streak-badge');
        if (catStreak > 0) {
          if (!catStreakEl) {
            catStreakEl = document.createElement('span');
            catStreakEl.className = 'ht-streak-badge';
            catHeader.appendChild(catStreakEl);
          }
          catStreakEl.innerHTML = `${htIcon('flame')}${catStreak}d`;
        } else if (catStreakEl) {
          catStreakEl.remove();
        }
      }
    } catch (_) {}

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
    let rangeDays = this._getStatsRangeDays(state);
    const storedRangeOk = (() => {
      const s = this._persistState ? parseInt(localStorage.getItem('ht_stats_range'), 10) : NaN;
      return s === 7 || s === 30;
    })();
    if (!storedRangeOk) this._persistStatsRangeDays(state, rangeDays);
    let selectedId = state.statsSelected || '__overall__';

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
        this._persistStatsRangeDays(state, days);
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
        // Default to the month of the open journal / viewed day (same as sidebar date)
        const refAnchor = new Date((state.dateStr || htToday()) + 'T12:00:00');
        let calYear = refAnchor.getFullYear();
        let calMonth = refAnchor.getMonth();

        const renderMonth = (year, month) => {
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
            <span class="ht-cat-rate-name"><span class="ht-cat-glyph-inline">${htCategoryGlyphHtml(c.emoji)}</span>${htEsc(c.name)}</span>
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

  /** Re-render every mounted panel (habits or stats) after config/logs change. */
  async refreshAllPanels() {
    for (const [, state] of (this._panelStates || [])) {
      if (!state.bodyEl) continue;
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
        <span class="ht-modal-title">${htIcon('flame')} HabitTracker — Manage Habits</span>
        <button class="ht-modal-close" title="Close">${htIcon('x')}</button>
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
      await this.refreshAllPanels();
      this.ui.addToaster({ title: 'HabitTracker', message: 'Habits saved!', dismissible: true, autoDestroyTime: 2000 });
    });

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    this._renderSettings(modal.querySelector('#ht-settings-body'), draft);
  }

  _renderSettings(container, draft) {
    container.innerHTML = '';

    // Filled in when the “add habit” row builds `catSelect`; end of renderCats() calls this
    let refreshCatSelect = () => {};

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
          <span class="ht-drag-handle" title="Drag to reorder">${htIcon('grip-vertical')}</span>
          <span class="ht-item-emoji">${htCategoryGlyphHtml(cat.emoji)}</span>
          <span class="ht-item-left"><span class="ht-item-name">${htEsc(cat.name)}</span></span>
          <div class="ht-item-actions">
            <button class="ht-btn ht-btn-secondary ht-btn-sm" data-action="edit-cat" data-id="${cat.id}" title="Edit">${htIcon('pencil')}</button>
            <button class="ht-btn ht-btn-danger ht-btn-sm" data-action="del-cat" data-id="${cat.id}" title="Delete">${htIcon('trash')}</button>
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

          const iconSelect = document.createElement('select');
          iconSelect.className = 'ht-input ht-icon-select';
          iconSelect.style.cssText = 'flex-shrink:0;';
          htFillIconSelect(iconSelect, cat.emoji);
          const iconPreview = document.createElement('span');
          iconPreview.className = 'ht-icon-preview';
          htBindIconPreview(iconSelect, iconPreview);

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
            cat.emoji = iconSelect.value || 'folder';
            cat.name = newName;
            finish();
            renderCats();
            renderHabits(); // habit rows + per-habit category dropdowns use category labels
          });
          cancelBtn.addEventListener('click', finish);
          nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveBtn.click();
            if (e.key === 'Escape') cancelBtn.click();
          });

          editForm.appendChild(iconSelect);
          editForm.appendChild(iconPreview);
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
      refreshCatSelect();
    };
    renderCats();

    // Add category row
    const addCatRow = document.createElement('div');
    addCatRow.className = 'ht-add-row';
    const newCatIconSel = document.createElement('select');
    newCatIconSel.className = 'ht-input ht-icon-select';
    newCatIconSel.id = 'ht-new-cat-icon';
    htFillIconSelect(newCatIconSel, 'folder');
    const newCatIconPrev = document.createElement('span');
    newCatIconPrev.className = 'ht-icon-preview';
    htBindIconPreview(newCatIconSel, newCatIconPrev);
    const newCatName = document.createElement('input');
    newCatName.className = 'ht-input';
    newCatName.id = 'ht-new-cat-name';
    newCatName.placeholder = 'Category name (e.g. expansion)';
    const newCatBtn = document.createElement('button');
    newCatBtn.className = 'ht-btn ht-btn-primary ht-btn-sm';
    newCatBtn.id = 'ht-add-cat-btn';
    newCatBtn.textContent = 'Add';
    addCatRow.appendChild(newCatIconSel);
    addCatRow.appendChild(newCatIconPrev);
    addCatRow.appendChild(newCatName);
    addCatRow.appendChild(newCatBtn);
    newCatBtn.addEventListener('click', () => {
      const emoji = newCatIconSel.value || 'folder';
      const name = newCatName.value.trim();
      if (!name) return;
      draft.categories.push({ id: htGenId(), name, emoji, order: draft.categories.length });
      htFillIconSelect(newCatIconSel, 'folder');
      newCatIconSel.dispatchEvent(new Event('change'));
      newCatName.value = '';
      renderCats();
      renderHabits(); // refresh category select
    });
    newCatName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') newCatBtn.click();
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
      <button class="ht-btn ht-btn-danger ht-btn-sm" id="ht-bulk-delete">${htIcon('trash')} Delete selected</button>
      <button class="ht-btn ht-btn-secondary ht-btn-sm" id="ht-bulk-archive">${htIcon('package')} Archive selected</button>
      <button class="ht-btn ht-btn-secondary ht-btn-sm" id="ht-bulk-clear">${htIcon('x')} Deselect all</button>
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
      archiveTitle.innerHTML = `<span style="flex:1;display:inline-flex;align-items:center;gap:6px;">${htIcon('package')} Archived (${archived.length})</span><span style="font-size:10px;opacity:0.6">${archiveOpen ? `${htIcon('chevron-up')} hide` : `${htIcon('chevron-down')} show`}</span>`;
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
            <span class="ht-item-sub"><span class="ht-cat-glyph-inline">${htCategoryGlyphHtml(cat?.emoji)}</span> ${htEsc(cat?.name || 'Unknown')}</span>
          </div>
          <div class="ht-item-actions">
            <button class="ht-btn ht-btn-secondary ht-btn-sm" data-action="unarchive-habit" data-id="${habit.id}" title="Restore">${htIcon('arrow-back-up')} Restore</button>
            <button class="ht-btn ht-btn-danger ht-btn-sm" data-action="del-habit" data-id="${habit.id}" title="Delete permanently">${htIcon('trash')}</button>
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
        const seedHint = habit.seedDate ? `<span style="font-size:10px;color:#c4a882;margin-left:4px;" title="Streak seeded from ${habit.seedDate}">${htIcon('flame')} since ${habit.seedDate}</span>` : '';
        const targetHint = habit.target > 0 ? ` · ${htIcon('target')} ${habit.target}${habit.unit ? ' ' + habit.unit : ''}` : '';
        if (selected.has(habit.id)) item.classList.add('ht-selected');
        item.innerHTML = `
          <input type="checkbox" class="ht-habit-cb" ${selected.has(habit.id) ? 'checked' : ''} title="Select">
          <span class="ht-drag-handle" title="Drag to reorder">${htIcon('grip-vertical')}</span>
          <div class="ht-item-left">
            <span class="ht-item-name">${htEsc(habit.name)}${seedHint}</span>
            <span class="ht-item-sub"><span class="ht-cat-glyph-inline">${htCategoryGlyphHtml(cat?.emoji)}</span> ${htEsc(cat?.name || 'Unknown')}${targetHint}</span>
          </div>
          <div class="ht-item-actions">
            <button class="ht-btn ht-btn-secondary ht-btn-sm" data-action="edit-habit" data-id="${habit.id}" title="Edit">${htIcon('pencil')}</button>
            <button class="ht-btn ht-btn-secondary ht-btn-sm" data-action="archive-habit" data-id="${habit.id}" title="Archive">${htIcon('package')}</button>
            <button class="ht-btn ht-btn-danger ht-btn-sm" data-action="del-habit" data-id="${habit.id}" title="Delete">${htIcon('trash')}</button>
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
            o.textContent = c.name || '';
            if (c.id === habit.categoryId) o.selected = true;
            catSel.appendChild(o);
          }

          // Streak seed date row
          const seedRow = document.createElement('div');
          seedRow.style.cssText = 'display:flex;align-items:center;gap:6px;width:100%;margin-top:4px;flex-wrap:wrap;';
          const seedLabel = document.createElement('span');
          seedLabel.style.cssText = 'font-size:11px;color:#8a7e6a;white-space:nowrap;';
          seedLabel.innerHTML = `${htIcon('flame')} Streak since:`;
          const seedInput = document.createElement('input');
          seedInput.type = 'date';
          seedInput.className = 'ht-input';
          seedInput.style.cssText = 'flex:1;min-width:120px;';
          seedInput.value = habit.seedDate || '';
          seedInput.title = 'Set this to bring over an existing streak from another app';
          const clearSeedBtn = document.createElement('button');
          clearSeedBtn.className = 'ht-btn ht-btn-secondary ht-btn-sm';
          clearSeedBtn.innerHTML = `${htIcon('x')} Clear`;
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
          targetLabel.innerHTML = `${htIcon('target')} Daily target:`;
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
          clearTargetBtn.innerHTML = htIcon('x');
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
          if (!confirm(`Permanently delete "${habit.name}"? This cannot be undone.\n\nTip: use Archive instead to keep your history.`)) return;
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

    refreshCatSelect = () => {
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
          opt.textContent = cat.name || '';
          catSelect.appendChild(opt);
        }
      }
    };
    refreshCatSelect();

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

  async _diagnose() {
    const tps = this._tps();
    if (!tps?.listRows) {
      alert('ThymerPluginSettings runtime missing from plugin.js');
      return;
    }
    const configRows = await this._psListByKind('config');
    const logRows = await this._getAllLogRows();
    const vaultRows = await tps.listRows(this.data, { pluginSlug: HT_PS_SLUG, recordKind: tps.RECORD_KIND_VAULT });

    let emptyLogCount = 0;
    let noDateCount = 0;
    const dateCounts = new Map();
    const sampleDate = '2026-02-01';
    const sampleRecords = [];
    for (const r of logRows) {
      const raw = this._readJsonStore(r);
      if (!raw || !String(raw).trim()) {
        emptyLogCount++;
        continue;
      }
      try {
        const d = JSON.parse(raw);
        if (!d.date) {
          noDateCount++;
          continue;
        }
        dateCounts.set(d.date, (dateCounts.get(d.date) || 0) + 1);
        if (d.date === sampleDate) {
          sampleRecords.push({
            plugin_id: tps.rowField(r, 'plugin_id'),
            completionKeys: Object.keys(d.completions || {}),
            catDoneKeys: Object.keys(d.categoryDone || {}),
          });
        }
      } catch (e) {
        noDateCount++;
      }
    }
    const duplicateDates = [...dateCounts.entries()].filter(([, c]) => c > 1);

    let writeTest = 'not tested';
    try {
      const testDate = '1970-01-01-test';
      const prior = await this._loadLog(testDate);
      const priorPersisted = prior.completions?.test === true;
      await this._saveLog(testDate, { date: testDate, completions: { test: true, ts: Date.now() }, categoryDone: {} });
      await htSleep(400);
      const verify = await this._loadLog(testDate);
      const writeOk = verify.completions?.test === true;
      writeTest =
        (priorPersisted ? 'OK persisted · ' : 'NOT persisted across reload · ') +
        (writeOk ? 'OK write works' : 'write failed');
    } catch (e) {
      writeTest = 'ERROR: ' + e.message;
    }

    const cfg = this._config || { habits: [], categories: [] };
    const configHabitIds = new Set(cfg.habits.map((h) => h.id));
    let idMatchTest = '';
    try {
      const rid = htPsRowLog(sampleDate);
      const sampleLogRec = logRows.find((r) => (tps.rowField(r, 'plugin_id') || '') === rid);
      if (sampleLogRec) {
        const raw = this._readJsonStore(sampleLogRec);
        if (raw) {
          const d = JSON.parse(raw);
          const logIds = Object.keys(d.completions || {});
          const matched = logIds.filter((id) => configHabitIds.has(id));
          const unmatched = logIds.filter((id) => !configHabitIds.has(id));
          idMatchTest = `${sampleDate} log has ${logIds.length} completions: ${matched.length} match config, ${unmatched.length} stale.`;
          if (unmatched.length > 0) idMatchTest += `\nStale IDs: ${unmatched.slice(0, 3).join(',')}`;
        }
      } else {
        idMatchTest = `No log row for ${sampleDate}`;
      }
    } catch (e) {
      idMatchTest = 'error: ' + e.message;
    }

    const msg = [
      `Storage: Plugin Backend (slug "${HT_PS_SLUG}")`,
      `Vault rows (sync mirror): ${vaultRows.length}`,
      `Config rows: ${configRows.length}`,
      `Log rows: ${logRows.length}`,
      `  Empty JSON: ${emptyLogCount}`,
      `  Missing date in JSON: ${noDateCount}`,
      `  Unique dates: ${dateCounts.size}`,
      `  Dates with duplicate rows: ${duplicateDates.length}`,
      ``,
      `Write test: ${writeTest}`,
      `ID check: ${idMatchTest}`,
      ``,
      `Sample ${sampleDate}: ${sampleRecords.length} row(s)`,
      ...sampleRecords.map((row, i) => `  [${i}] ${row.plugin_id} habits:${row.completionKeys.slice(0, 3).join(',')}`),
    ].join('\n');

    console.log('[HT Diagnose]', { configRows: configRows.length, logRows: logRows.length, vaultRows, sampleRecords });
    alert(msg);
  }

  // Delete Plugin Backend log rows with no completions AND no categoryDone
  async _cleanEmptyLogs() {
    const logRows = await this._getAllLogRows();
    const toDelete = [];
    for (const r of logRows) {
      try {
        const raw = this._readJsonStore(r);
        if (!raw || !String(raw).trim()) {
          toDelete.push(r);
          continue;
        }
        const d = JSON.parse(raw);
        const hasCompletions = d.completions && Object.keys(d.completions).length > 0;
        const hasCatDone = d.categoryDone && Object.keys(d.categoryDone).length > 0;
        if (!hasCompletions && !hasCatDone) toDelete.push(r);
      } catch (e) {
        toDelete.push(r);
      }
    }
    if (toDelete.length === 0) {
      this.ui.addToaster({ title: 'No empty log records found', autoDestroyTime: 3000 });
      return;
    }
    if (!confirm(`Delete ${toDelete.length} empty log rows in Plugin Backend?`)) return;
    this.ui.addToaster({ title: `Deleting ${toDelete.length} empty rows…`, autoDestroyTime: 3000 });
    for (const r of toDelete) {
      try {
        if (typeof r.delete === 'function') await r.delete();
      } catch (e) {
        try {
          this._writeJsonStore(r, { date: '', completions: {}, categoryDone: {} });
        } catch (e2) {}
      }
      await htSleep(30);
    }
    this.ui.addToaster({ title: `Deleted ${toDelete.length} empty log rows`, autoDestroyTime: 4000 });
    this.refreshAllPanels();
  }

}