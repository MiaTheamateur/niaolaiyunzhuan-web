(function () {
  "use strict";

  const APP_VERSION = "1.3.0";
  const STORAGE_KEY = "yys-niaoniao-checklist-state";
  const STORAGE_BACKUP_KEY = "yys-niaoniao-checklist-state-backup";
  const STATE_SCHEMA_VERSION = 5;
  const MIRROR_DB_NAME = "yys-niaoniao-checklist";
  const MIRROR_STORE_NAME = "state";
  const MIRROR_STATE_KEY = "primary";
  const MIRROR_BACKUP_STATE_KEY = "backup";
  const COUNTDOWN_RETENTION_MS = 24 * 60 * 60 * 1000;
  const LEGACY_ATOM_IDS = {
    "src-027-05": "src-027-04",
  };
  const dataset = window.NIAONIAO_DATA || { items: [], meta: {} };
  const root = document.getElementById("app");

  function markContainerEnvironment() {
    const userAgent = navigator.userAgent || "";
    const hasMiniToolApi = Boolean(window.xhs && window.xhs.miniTool);
    const looksLikeXhs = /XiaoHongShu|XHS|RED/i.test(userAgent);
    if (hasMiniToolApi || looksLikeXhs) document.documentElement.classList.add("xhs-mini-tool");
  }

  function enableFlexGapEnhancement() {
    const flex = document.createElement("div");
    flex.style.position = "absolute";
    flex.style.visibility = "hidden";
    flex.style.display = "flex";
    flex.style.flexDirection = "column";
    flex.style.rowGap = "1px";
    flex.appendChild(document.createElement("div"));
    flex.appendChild(document.createElement("div"));
    document.body.appendChild(flex);
    const supported = flex.scrollHeight === 1;
    flex.parentNode.removeChild(flex);
    if (supported) document.documentElement.classList.add("supports-flex-gap");
  }

  markContainerEnvironment();
  enableFlexGapEnhancement();

  const modules = {
    region: {
      title: "区域探索可得",
      glyph: "图",
      description: "按清河、开封、河西等区域逐项查漏",
    },
    gameplay: {
      title: "玩法获得",
      glyph: "常",
      description: "常驻玩法、试炼与固定来源",
    },
    chance: {
      title: "概率获得",
      glyph: "运",
      description: "惊喜礼盒、玩法掉落等概率来源",
    },
    limited: {
      title: "限时获得",
      glyph: "限",
      description: "赛季商店、限时邮件与活动来源",
    },
  };
  const moduleOrder = ["region", "gameplay", "limited", "chance"];

  let localStorageAvailable = true;
  let mirrorStorageAvailable = Boolean(window.indexedDB);
  let storageAvailable = true;
  let hadLocalPersistedState = false;
  let stateReady = false;
  let databasePromise = null;
  let mirrorWriteQueue = Promise.resolve();
  let state = loadState();
  let view = { name: "home", moduleId: null, query: "", filter: "all" };
  let countdownVisibilitySignature = null;

  function createEmptyState() {
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      savedAt: 0,
      completed: {},
      seenNewIds: {},
      refreshCycles: {},
      backup: { lastAt: 0, lastFingerprint: "" },
    };
  }

  function resolveAtomId(atomId) {
    return LEGACY_ATOM_IDS[atomId] || atomId;
  }

  function migrateCompleted(completed, sourceSchemaVersion) {
    const migrated = {};
    Object.keys(completed || {}).forEach((key) => {
      if (completed[key] !== true) return;
      const separator = key.indexOf("::");
      const atomId = separator >= 0 ? key.slice(0, separator) : key;
      const suffix = separator >= 0 ? key.slice(separator) : "";
      migrated[`${resolveAtomId(atomId)}${suffix}`] = true;
    });
    if (sourceSchemaVersion < 4) {
      Object.keys(migrated).forEach((key) => {
        if (key.indexOf("src-088::") !== 0) return;
        migrated[`src-088-02${key.slice("src-088".length)}`] = true;
      });
    }
    return migrated;
  }

  function migrateSeenNewIds(seenNewIds) {
    const migrated = {};
    Object.keys(seenNewIds || {}).forEach((noticeKey) => {
      if (seenNewIds[noticeKey] !== true) return;
      const separator = noticeKey.indexOf("::refresh:");
      const atomId = separator >= 0 ? noticeKey.slice(0, separator) : noticeKey;
      const suffix = separator >= 0 ? noticeKey.slice(separator) : "";
      migrated[`${resolveAtomId(atomId)}${suffix}`] = true;
    });
    return migrated;
  }

  function migrateAtomIdList(atomIds) {
    return [...new Set((atomIds || []).map((noticeKey) => {
      const separator = noticeKey.indexOf("::refresh:");
      const atomId = separator >= 0 ? noticeKey.slice(0, separator) : noticeKey;
      const suffix = separator >= 0 ? noticeKey.slice(separator) : "";
      return `${resolveAtomId(atomId)}${suffix}`;
    }))];
  }

  function normalizeState(value) {
    const empty = createEmptyState();
    const source = value && typeof value === "object" ? value : {};
    const sourceSchemaVersion = Number.isFinite(source.schemaVersion) ? source.schemaVersion : 1;
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      savedAt: Number.isFinite(source.savedAt) ? source.savedAt : 0,
      completed: migrateCompleted(source.completed && typeof source.completed === "object" ? source.completed : {}, sourceSchemaVersion),
      seenNewIds: migrateSeenNewIds(source.seenNewIds && typeof source.seenNewIds === "object" ? source.seenNewIds : {}),
      refreshCycles: source.refreshCycles && typeof source.refreshCycles === "object" ? source.refreshCycles : {},
      backup: source.backup && typeof source.backup === "object"
        ? {
          lastAt: Number.isFinite(source.backup.lastAt) ? source.backup.lastAt : 0,
          lastFingerprint: typeof source.backup.lastFingerprint === "string" ? source.backup.lastFingerprint : "",
        }
        : empty.backup,
    };
  }

  function updateStorageAvailability() {
    storageAvailable = localStorageAvailable || mirrorStorageAvailable;
  }

  function newestState(candidates) {
    return candidates.filter(Boolean).reduce((newest, candidate) => {
      if (!newest || candidate.savedAt > newest.savedAt) return candidate;
      return newest;
    }, null);
  }

  function readLocalState(key) {
    try {
      const raw = localStorage.getItem(key);
      localStorageAvailable = true;
      if (!raw) return null;
      return normalizeState(JSON.parse(raw));
    } catch (error) {
      localStorageAvailable = false;
      return null;
    }
  }

  function writeLocalState(snapshot) {
    const serialized = JSON.stringify(snapshot);
    let wroteAtLeastOneCopy = false;
    [STORAGE_KEY, STORAGE_BACKUP_KEY].forEach((key) => {
      try {
        localStorage.setItem(key, serialized);
        wroteAtLeastOneCopy = true;
      } catch (error) {
        // Continue so a device that rejects one slot can still use the other.
      }
    });
    localStorageAvailable = wroteAtLeastOneCopy;
    updateStorageAvailability();
    return wroteAtLeastOneCopy;
  }

  function loadState() {
    const loaded = newestState([
      readLocalState(STORAGE_KEY),
      readLocalState(STORAGE_BACKUP_KEY),
    ]);
    hadLocalPersistedState = Boolean(loaded);
    updateStorageAvailability();
    return loaded || createEmptyState();
  }

  function openMirrorDatabase() {
    if (!window.indexedDB) {
      mirrorStorageAvailable = false;
      updateStorageAvailability();
      return Promise.reject(new Error("IndexedDB unavailable"));
    }
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(MIRROR_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(MIRROR_STORE_NAME)) database.createObjectStore(MIRROR_STORE_NAME);
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          databasePromise = null;
        };
        mirrorStorageAvailable = true;
        updateStorageAvailability();
        resolve(database);
      };
      request.onerror = () => {
        databasePromise = null;
        mirrorStorageAvailable = false;
        updateStorageAvailability();
        reject(request.error || new Error("IndexedDB open failed"));
      };
    });
    return databasePromise;
  }

  function writeMirrorState(snapshot) {
    return openMirrorDatabase().then((database) => new Promise((resolve, reject) => {
      try {
        const transaction = database.transaction(MIRROR_STORE_NAME, "readwrite");
        const store = transaction.objectStore(MIRROR_STORE_NAME);
        store.put(snapshot, MIRROR_STATE_KEY);
        store.put(snapshot, MIRROR_BACKUP_STATE_KEY);
        transaction.oncomplete = () => {
          mirrorStorageAvailable = true;
          updateStorageAvailability();
          resolve();
        };
        transaction.onerror = () => {
          mirrorStorageAvailable = false;
          updateStorageAvailability();
          reject(transaction.error || new Error("IndexedDB write failed"));
        };
        transaction.onabort = () => {
          mirrorStorageAvailable = false;
          updateStorageAvailability();
          reject(transaction.error || new Error("IndexedDB write aborted"));
        };
      } catch (error) {
        mirrorStorageAvailable = false;
        updateStorageAvailability();
        reject(error);
      }
    }));
  }

  function readMirrorState() {
    return openMirrorDatabase().then((database) => new Promise((resolve, reject) => {
      try {
        const transaction = database.transaction(MIRROR_STORE_NAME, "readonly");
        const store = transaction.objectStore(MIRROR_STORE_NAME);
        const primaryRequest = store.get(MIRROR_STATE_KEY);
        const backupRequest = store.get(MIRROR_BACKUP_STATE_KEY);
        let primaryValue = null;
        let backupValue = null;
        primaryRequest.onsuccess = () => { primaryValue = primaryRequest.result || null; };
        backupRequest.onsuccess = () => { backupValue = backupRequest.result || null; };
        transaction.oncomplete = () => {
          mirrorStorageAvailable = true;
          updateStorageAvailability();
          resolve(newestState([primaryValue, backupValue]));
        };
        transaction.onerror = () => {
          mirrorStorageAvailable = false;
          updateStorageAvailability();
          reject(transaction.error || new Error("IndexedDB read failed"));
        };
        transaction.onabort = () => {
          mirrorStorageAvailable = false;
          updateStorageAvailability();
          reject(transaction.error || new Error("IndexedDB read aborted"));
        };
      } catch (error) {
        mirrorStorageAvailable = false;
        updateStorageAvailability();
        reject(error);
      }
    }));
  }

  function queueMirrorState(snapshot) {
    mirrorWriteQueue = mirrorWriteQueue.catch(() => {}).then(() => writeMirrorState(snapshot));
    return mirrorWriteQueue;
  }

  function persistCurrentStateCopies() {
    const snapshot = JSON.parse(JSON.stringify(state));
    writeLocalState(snapshot);
    queueMirrorState(snapshot).catch(() => {});
  }

  function saveState() {
    state.schemaVersion = STATE_SCHEMA_VERSION;
    state.savedAt = Math.max(Date.now(), state.savedAt + 1);
    const snapshot = JSON.parse(JSON.stringify(state));
    writeLocalState(snapshot);
    queueMirrorState(snapshot).catch(() => {});
  }

  function hydrateFromMirror() {
    return readMirrorState().then((mirrorValue) => {
      const hadPersistedState = hadLocalPersistedState || Boolean(mirrorValue);
      let restored = false;
      if (mirrorValue) {
        const mirrorState = normalizeState(mirrorValue);
        if (mirrorState.savedAt > state.savedAt) {
          state = mirrorState;
          restored = true;
        }
      }
      persistCurrentStateCopies();
      if (restored) {
        if (view.name === "detail") renderDetail();
        else renderHome();
        showToast("已从本机备用存储恢复记录");
      }
      return hadPersistedState;
    }).catch(() => {
      persistCurrentStateCopies();
      return hadLocalPersistedState;
    });
  }

  function getAtomEntries() {
    const entries = [];
    dataset.items.forEach((item) => {
      getAtoms(item).forEach((atom) => entries.push({ item, atom }));
    });
    return entries;
  }

  function getCurrentCompletedAtomIds() {
    return getAtomEntries()
      .filter((entry) => isChecked(entry.item, entry.atom.id))
      .map((entry) => entry.atom.id);
  }

  function getCurrentSeenNewIds() {
    return Object.keys(state.seenNewIds).filter((noticeKey) => state.seenNewIds[noticeKey] === true);
  }

  function progressFingerprint(completedIds, seenNewIds) {
    const backupApi = window.NIAONIAO_BACKUP;
    if (!backupApi) return "";
    return backupApi.encode({
      createdAt: 0,
      completedIds: completedIds || getCurrentCompletedAtomIds(),
      seenNewIds: seenNewIds || getCurrentSeenNewIds(),
    });
  }

  function formatBackupTime(timestamp) {
    if (!timestamp) return "尚未备份";
    const date = new Date(timestamp);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    return `${month}-${day} ${hour}:${minute}`;
  }

  function getRecordSafetyStatus() {
    const completedIds = getCurrentCompletedAtomIds();
    const currentFingerprint = progressFingerprint(completedIds, getCurrentSeenNewIds());
    const lastBackup = state.backup || { lastAt: 0, lastFingerprint: "" };
    const isCurrent = Boolean(lastBackup.lastAt && lastBackup.lastFingerprint === currentFingerprint);
    const status = !completedIds.length
      ? "暂无需要备份的记录"
      : isCurrent ? `最近备份 ${formatBackupTime(lastBackup.lastAt)}` : lastBackup.lastAt ? "记录有变化，建议重新备份" : "尚未备份，建议保存一份";
    const statusClass = isCurrent ? " is-safe" : completedIds.length ? " needs-backup" : "";

    return { completedIds, status, statusClass };
  }

  function renderRecordSafety() {
    const safety = getRecordSafetyStatus();

    return `
      <button class="record-safety-entry" type="button" data-action="open-record-protection" aria-haspopup="dialog">
        <span class="record-safety-entry-copy">
          <strong id="record-safety-title">记录保护</strong>
          <span class="record-safety-status${safety.statusClass}">${safety.status}</span>
        </span>
        <span class="record-safety-entry-tail" aria-hidden="true">›</span>
      </button>
    `;
  }

  function closeDialog() {
    const dialog = document.getElementById("backup-dialog");
    if (dialog) dialog.parentNode.removeChild(dialog);
    document.body.classList.remove("dialog-open");
  }

  function showDialog(title, message, imageUrl) {
    closeDialog();
    const layer = document.createElement("div");
    layer.id = "backup-dialog";
    layer.className = "dialog-layer";
    layer.setAttribute("role", "dialog");
    layer.setAttribute("aria-modal", "true");
    layer.setAttribute("aria-label", title);
    layer.innerHTML = `
      <div class="dialog-panel">
        <div class="dialog-copy"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p></div>
        ${imageUrl ? `<img class="backup-preview-image" src="${imageUrl}" alt="袅来运转进度备份图预览" />` : ""}
        <button class="dialog-close-button" type="button">完成</button>
      </div>
    `;
    layer.addEventListener("click", (event) => {
      if (event.target === layer || event.target.closest(".dialog-close-button")) closeDialog();
    });
    document.body.appendChild(layer);
    document.body.classList.add("dialog-open");
    const closeButton = layer.querySelector(".dialog-close-button");
    if (closeButton) closeButton.focus();
  }

  function showRecordProtectionDialog() {
    closeDialog();
    const safety = getRecordSafetyStatus();
    const layer = document.createElement("div");
    layer.id = "backup-dialog";
    layer.className = "dialog-layer record-protection-layer";
    layer.setAttribute("role", "dialog");
    layer.setAttribute("aria-modal", "true");
    layer.setAttribute("aria-labelledby", "record-protection-dialog-title");
    layer.innerHTML = `
      <div class="dialog-panel record-protection-dialog">
        <div class="record-protection-dialog-header">
          <div class="dialog-copy">
            <h2 id="record-protection-dialog-title">记录保护</h2>
            <p>浏览器清理网站数据或更换设备会影响本机记录，建议定期下载备份图。</p>
          </div>
          <button class="dialog-dismiss-button" type="button" data-dialog-action="close">关闭</button>
        </div>
        <div class="record-protection-status">
          <span>当前状态</span>
          <strong class="record-safety-status${safety.statusClass}">${safety.status}</strong>
        </div>
        <div class="record-safety-actions">
          <button class="safety-button primary" type="button" data-action="backup-records" data-dialog-action="backup-records"${safety.completedIds.length ? "" : " disabled"}>备份记录</button>
          <button class="safety-button secondary" type="button" data-action="restore-records" data-dialog-action="restore-records">恢复记录</button>
        </div>
        <p class="record-protection-note">备份图只包含勾选状态，不包含账号或隐私信息。恢复时会与当前记录合并。</p>
        <input id="backup-file-input" class="backup-file-input" type="file" accept="image/*" tabindex="-1" aria-hidden="true" />
      </div>
    `;
    layer.addEventListener("click", (event) => {
      if (event.target === layer || event.target.closest('[data-dialog-action="close"]')) {
        closeDialog();
        return;
      }
      const actionButton = event.target.closest("button[data-dialog-action]");
      if (!actionButton) return;
      if (actionButton.dataset.dialogAction === "backup-records") {
        closeDialog();
        backupProgress();
        return;
      }
      if (actionButton.dataset.dialogAction === "restore-records") {
        const input = layer.querySelector("#backup-file-input");
        if (input) input.click();
      }
    });
    layer.addEventListener("change", (event) => {
      if (event.target.id !== "backup-file-input") return;
      const file = event.target.files && event.target.files[0];
      event.target.value = "";
      if (!file) return;
      closeDialog();
      restoreProgressFromFile(file);
    });
    document.body.appendChild(layer);
    document.body.classList.add("dialog-open");
    const closeButton = layer.querySelector(".dialog-dismiss-button");
    if (closeButton) closeButton.focus();
  }

  function showToast(message) {
    const previous = document.getElementById("app-toast");
    if (previous) previous.parentNode.removeChild(previous);
    const toast = document.createElement("div");
    toast.id = "app-toast";
    toast.className = "app-toast";
    toast.setAttribute("role", "status");
    toast.textContent = message;
    document.body.appendChild(toast);
    window.setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 2400);
  }

  function markBackupSaved(createdAt) {
    state.backup = {
      lastAt: createdAt,
      lastFingerprint: progressFingerprint(),
    };
    saveState();
  }

  function backupProgress() {
    const backupApi = window.NIAONIAO_BACKUP;
    const completedIds = getCurrentCompletedAtomIds();
    if (!backupApi || !completedIds.length) return;
    const createdAt = Date.now();
    let imageUrl;
    try {
      const payload = backupApi.encode({
        createdAt,
        completedIds,
        seenNewIds: getCurrentSeenNewIds(),
      });
      imageUrl = backupApi.drawBackupImage(payload, {
        completedCount: completedIds.length,
        createdAtLabel: formatBackupTime(createdAt),
      });
    } catch (error) {
      showDialog("备份生成失败", error.message || "请稍后再试");
      return;
    }

    const miniTool = window.xhs && window.xhs.miniTool;
    if (!miniTool || typeof miniTool.saveImageToPhotosAlbum !== "function") {
      const link = document.createElement("a");
      link.href = imageUrl;
      link.download = `袅来运转-进度备份-${formatBackupTime(createdAt).replace(/[:\s]/g, "-")}.png`;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.parentNode.removeChild(link);
      markBackupSaved(createdAt);
      renderHome();
      showDialog("备份图已下载", "备份图已下载到浏览器默认下载位置。请妥善保存；恢复时请选择这张原图。", imageUrl);
      return;
    }

    showToast("正在保存备份图");
    let saveResult;
    try {
      if (typeof miniTool.writeTempFile === "function") {
        saveResult = Promise.resolve(miniTool.writeTempFile({ data: imageUrl })).then((result) => {
          if (!result || !result.filePath) throw new Error("临时图片写入失败");
          return miniTool.saveImageToPhotosAlbum({ filePath: result.filePath });
        });
      } else {
        saveResult = miniTool.saveImageToPhotosAlbum({ filePath: imageUrl });
      }
    } catch (error) {
      showDialog("保存失败", "请检查小红书的相册权限后再试。");
      return;
    }
    Promise.resolve(saveResult).then(() => {
      markBackupSaved(createdAt);
      renderHome();
      showDialog("备份已保存", "备份图已保存到系统相册。恢复时请选择这张原图。", imageUrl);
    }).catch(() => {
      showDialog("保存失败", "请检查小红书的相册权限后再试。");
    });
  }

  function findAtomEntry(atomId) {
    return getAtomEntries().find((entry) => entry.atom.id === atomId) || null;
  }

  function restoreProgressFromData(restored) {
    const migratedCompletedIds = migrateAtomIdList(restored.completedIds);
    if ((restored.schemaVersion || 1) < 2 && migratedCompletedIds.includes("src-088") && !migratedCompletedIds.includes("src-088-02")) {
      migratedCompletedIds.push("src-088-02");
    }
    const knownCompletedIds = migratedCompletedIds.filter((id) => Boolean(findAtomEntry(id)));
    const knownSeenIds = migrateAtomIdList(restored.seenNewIds).filter((noticeKey) => {
      const atomId = noticeKey.split("::refresh:")[0];
      return Boolean(findAtomEntry(atomId));
    });
    let addedCount = 0;
    knownCompletedIds.forEach((id) => {
      const entry = findAtomEntry(id);
      const key = completionKey(entry.item, id);
      if (state.completed[key] !== true) addedCount += 1;
      state.completed[key] = true;
    });
    knownSeenIds.forEach((id) => { state.seenNewIds[id] = true; });

    const restoredFingerprint = progressFingerprint(knownCompletedIds, knownSeenIds);
    const mergedFingerprint = progressFingerprint();
    state.backup = {
      lastAt: restored.createdAt,
      lastFingerprint: restoredFingerprint === mergedFingerprint ? mergedFingerprint : "",
    };
    saveState();
    renderHome();
    showToast(`已恢复 ${knownCompletedIds.length} 项记录${addedCount ? `，新增 ${addedCount} 项` : ""}`);
  }

  function restoreProgressFromFile(file) {
    const backupApi = window.NIAONIAO_BACKUP;
    if (!backupApi) {
      showDialog("恢复失败", "备份组件未加载，请重新打开小工具后再试。");
      return;
    }
    showToast("正在识别备份图");
    backupApi.decodeImageFile(file).then((restored) => {
      const message = `识别到 ${restored.completedIds.length} 项记录，将与当前记录合并，不会删除现有勾选。是否继续？`;
      if (confirm(message)) restoreProgressFromData(restored);
    }).catch((error) => {
      showDialog("恢复失败", error.message || "请确认选择的是清晰的袅来运转备份原图。");
    });
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function getWeekKey(date) {
    const copy = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = copy.getUTCDay() || 7;
    copy.setUTCDate(copy.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((copy - yearStart) / 86400000) + 1) / 7);
    return `${copy.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }

  function getPeriodScope(period) {
    const now = new Date();
    if (period === "weekly") return `week:${getWeekKey(now)}`;
    if (period === "monthly") return `month:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    if (period === "season") return "season:current";
    if (period === "event") return "event:current";
    return "once";
  }

  function periodLabel(period) {
    return {
      once: "一次性",
      weekly: "本周",
      monthly: "本月",
      season: "本赛季",
      event: "当前活动",
    }[period] || "一次性";
  }

  function getAtoms(item) {
    if (item.children && item.children.length) {
      return item.children.map((child) => ({
        id: child.id,
        label: child.label,
        quantity: Number.isFinite(child.quantity) ? child.quantity : 1,
        isNew: child.isNew === true,
      }));
    }
    return [{
      id: item.id,
      label: item.condition,
      quantity: Number.isFinite(item.quantity) ? item.quantity : 0,
      isNew: item.isNew === true,
    }];
  }

  function getChinaMonthKey(now) {
    const chinaTime = new Date(now + (8 * 60 * 60 * 1000));
    return `${chinaTime.getUTCFullYear()}-${String(chinaTime.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  function getRefreshOccurrence(item, now = Date.now()) {
    if (item.refreshRule === "monthly") return `month:${getChinaMonthKey(now)}`;
    if (item.refreshRule === "scheduled") {
      const refreshTime = Date.parse(item.refreshAt);
      if (Number.isFinite(refreshTime) && now >= refreshTime) return `at:${item.refreshAt}`;
    }
    return null;
  }

  function getNewNoticeKeys(item, atom, now = Date.now()) {
    const keys = [];
    if (atom.isNew === true) keys.push(atom.id);
    const refreshOccurrence = getRefreshOccurrence(item, now);
    if (refreshOccurrence) keys.push(`${atom.id}::refresh:${refreshOccurrence}`);
    return keys;
  }

  function isUnseenNew(item, atom, now = Date.now()) {
    if (!stateReady) return false;
    return getNewNoticeKeys(item, atom, now).some((noticeKey) => state.seenNewIds[noticeKey] !== true);
  }

  function establishInitialNewBaseline(now = Date.now()) {
    dataset.items.forEach((item) => {
      getAtoms(item).forEach((atom) => {
        getNewNoticeKeys(item, atom, now).forEach((noticeKey) => {
          state.seenNewIds[noticeKey] = true;
        });
      });
    });
    saveState();
  }

  function itemHasUnseenNew(item) {
    return getAtoms(item).some((atom) => isUnseenNew(item, atom));
  }

  function getNewCount(items) {
    return items.reduce((total, item) => total + getAtoms(item).filter((atom) => isUnseenNew(item, atom)).length, 0);
  }

  function markModuleNewAsSeen(moduleId) {
    let changed = false;
    getModuleItems(moduleId).forEach((item) => {
      getAtoms(item).forEach((atom) => {
        getNewNoticeKeys(item, atom).forEach((noticeKey) => {
          if (state.seenNewIds[noticeKey] === true) return;
          state.seenNewIds[noticeKey] = true;
          changed = true;
        });
      });
    });
    if (changed) saveState();
  }

  function clearItemProgressInState(item) {
    const atomPrefixes = getAtoms(item).map((atom) => `${atom.id}::`);
    let changed = false;
    Object.keys(state.completed).forEach((key) => {
      if (!atomPrefixes.some((prefix) => key.startsWith(prefix))) return;
      delete state.completed[key];
      changed = true;
    });
    return changed;
  }

  function applyScheduledRefreshes(now = Date.now()) {
    let changed = false;
    dataset.items.forEach((item) => {
      const occurrence = getRefreshOccurrence(item, now);
      if (!occurrence || state.refreshCycles[item.id] === occurrence) return;

      const previousOccurrence = state.refreshCycles[item.id] || null;
      const occurrenceAtLastSave = state.savedAt > 0 ? getRefreshOccurrence(item, state.savedAt) : null;
      if (previousOccurrence || (state.savedAt > 0 && occurrenceAtLastSave !== occurrence)) {
        changed = clearItemProgressInState(item) || changed;
      }
      state.refreshCycles[item.id] = occurrence;
      changed = true;
    });
    if (changed) saveState();
    return changed;
  }

  function renderNewBadge() {
    return '<span class="new-badge">NEW</span>';
  }

  function completionKey(item, atomId) {
    return `${atomId}::${getPeriodScope(item.period)}`;
  }

  function isChecked(item, atomId) {
    return state.completed[completionKey(item, atomId)] === true;
  }

  function setChecked(item, atomId, checked) {
    const key = completionKey(item, atomId);
    if (checked) state.completed[key] = true;
    else delete state.completed[key];
    saveState();
  }

  function isItemVisible(item, now = Date.now()) {
    if (item.expiresAt) {
      const expiresAt = Date.parse(item.expiresAt);
      if (Number.isFinite(expiresAt) && now >= expiresAt) return false;
    }
    if (!item.countdownEnd) return true;
    return getCountdownStatus(item.countdownEnd, now).phase !== "retired";
  }

  function getVisibleItems(now = Date.now()) {
    return dataset.items.filter((item) => isItemVisible(item, now));
  }

  function getModuleItems(moduleId, now = Date.now()) {
    return getVisibleItems(now).filter((item) => item.module === moduleId);
  }

  function getAllModuleItems(moduleId) {
    return dataset.items.filter((item) => item.module === moduleId);
  }

  function getStats(items) {
    let totalTasks = 0;
    let doneTasks = 0;
    let totalSounds = 0;
    let doneSounds = 0;

    items.forEach((item) => {
      getAtoms(item).forEach((atom) => {
        totalTasks += 1;
        totalSounds += atom.quantity;
        if (isChecked(item, atom.id)) {
          doneTasks += 1;
          doneSounds += atom.quantity;
        }
      });
    });

    return { totalTasks, doneTasks, totalSounds, doneSounds };
  }

  function percent(done, total) {
    if (!total) return 0;
    return Math.min(100, Math.round((done / total) * 100));
  }

  function renderHome() {
    const definiteItems = getVisibleItems().filter((item) => item.module !== "chance");
    const overall = getStats(definiteItems);
    const overallPercent = percent(overall.doneSounds, overall.totalSounds);

    root.innerHTML = `
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">袅</div>
          <div class="brand-copy">
            <strong>袅来运转</strong>
            <span>网页版 v${escapeHtml(dataset.meta.releaseVersion || APP_VERSION)}</span>
          </div>
        </div>
        <button class="text-button danger" type="button" data-action="reset-all">重置记录</button>
      </header>

      ${storageAvailable ? "" : '<div class="warning-note">当前环境无法写入本地存储，勾选进度可能不会保留。</div>'}

      <section class="hero">
        <p class="hero-kicker">袅袅之音查缺补漏</p>
        <h1>拾遗补缺，<span class="hero-title-second">窍运亨通</span></h1>
        <p class="hero-copy">小鹿会长期维护此工具。你的记录将自动存储，后续新增袅袅会标注 NEW提示，祝使用愉快～</p>
        <div class="hero-stat">
          <div><span class="hero-number">${overall.doneSounds}</span><span class="hero-unit"> / ${overall.totalSounds} 枚</span></div>
          <span class="hero-substat">已完成 ${overall.doneTasks}/${overall.totalTasks} 项</span>
        </div>
        <div class="progress-track" aria-label="确定来源完成进度 ${overallPercent}%">
          <div class="progress-fill" style="--progress: ${overallPercent}%"></div>
        </div>
      </section>

      <div class="section-heading">
        <h2>专项查找</h2>
        <span>数据更新至 ${escapeHtml(dataset.meta.updatedAt || "正式版")}</span>
      </div>

      <section class="module-list">
        ${moduleOrder.map(renderModuleCard).join("")}
      </section>

      ${renderRecordSafety()}
      <div class="storage-note">记录会自动保存到当前浏览器。跨设备、清理浏览器数据或更换浏览器前，请先下载备份图。</div>
      <footer class="creator-credit"><span>制作者</span><strong>薄荷小鹿（燕云十六声）</strong></footer>
    `;
  }

  function renderModuleCard(moduleId) {
    const config = modules[moduleId];
    const items = getModuleItems(moduleId);
    const stats = getStats(items);
    const newCount = getNewCount(items);
    const status = items.length
      ? `${stats.doneTasks}/${stats.totalTasks} 项${stats.totalSounds ? ` · ${stats.doneSounds}/${stats.totalSounds} 枚` : ""}`
      : "等待添加数据";

    return `
      <button class="module-card" type="button" data-action="open-module" data-module="${moduleId}">
        <span class="module-glyph" aria-hidden="true">${config.glyph}</span>
        <span class="module-copy"><strong>${config.title}</strong><span>${config.description}<br />${status}</span></span>
        <span class="module-tail">${newCount ? `<span class="module-new-count">NEW ${newCount}</span>` : ""}<span class="module-arrow" aria-hidden="true">›</span></span>
      </button>
    `;
  }

  function renderDetail() {
    const moduleId = view.moduleId;
    const config = modules[moduleId];
    const moduleItems = getModuleItems(moduleId);
    const stats = getStats(moduleItems);
    const newCount = getNewCount(moduleItems);
    const progress = percent(stats.doneTasks, stats.totalTasks);

    root.innerHTML = `
      <header class="detail-header">
        <div class="detail-title-row">
          <button class="header-action-button primary" type="button" data-action="back">首页</button>
          <div class="detail-title"><h1>${config.title}</h1><p>${stats.doneTasks}/${stats.totalTasks} 项已记录${newCount ? ` · ${newCount} 项新增` : ""}</p></div>
          <button class="header-action-button quiet" type="button" data-action="reset-module">清空</button>
        </div>
      </header>

      ${storageAvailable ? "" : '<div class="warning-note">当前环境无法写入本地存储，勾选进度可能不会保留。</div>'}

      <section class="module-summary">
        <div class="module-summary-line"><span>当前完成度</span><strong id="module-progress-text">${progress}%</strong></div>
        <div class="progress-track"><div id="module-progress-fill" class="progress-fill" style="--progress: ${progress}%"></div></div>
      </section>

      <div class="search-wrap">
        <input id="search-input" class="search-input" type="search" value="${escapeHtml(view.query)}" placeholder="搜索任务、区域、人物或商店" autocomplete="off" />
        <button class="search-clear" type="button" data-action="clear-search" aria-label="清空搜索">×</button>
      </div>
      <div class="filters" aria-label="完成状态筛选">
        ${renderFilterButton("all", "全部")}
        ${renderFilterButton("undone", "未获得")}
        ${renderFilterButton("done", "已获得")}
      </div>

      <div id="list-area">${renderGroups()}</div>

      <footer class="detail-footer"><span class="hero-substat">进度保存在当前设备</span></footer>
    `;
  }

  function renderFilterButton(value, label) {
    return `<button class="filter-button${view.filter === value ? " active" : ""}" type="button" data-action="set-filter" data-filter="${value}">${label}</button>`;
  }

  function itemMatches(item) {
    const query = view.query.trim().toLowerCase();
    const atoms = getAtoms(item);
    const done = atoms.every((atom) => isChecked(item, atom.id));
    if (view.filter === "done" && !done) return false;
    if (view.filter === "undone" && done) return false;
    if (!query) return true;
    const haystack = [item.region, item.type, item.condition, item.displayTitle, item.note, ...atoms.map((atom) => atom.label)].join(" ").toLowerCase();
    return haystack.includes(query);
  }

  function groupKey(item) {
    return item.module === "region" ? item.region : item.type;
  }

  function renderGroups() {
    const allItems = getModuleItems(view.moduleId);
    const filtered = allItems.filter(itemMatches);

    if (!allItems.length) {
      return '<div class="empty-state"><strong>这个模块还没有数据</strong>后续在在线表格中添加来源并生成新版后，会自动显示在这里。</div>';
    }

    if (!filtered.length) {
      return '<div class="empty-state"><strong>没有找到符合条件的项目</strong>可以换个关键词，或切换完成状态筛选。</div>';
    }

    const groups = new Map();
    filtered.forEach((item) => {
      const key = groupKey(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });

    if (view.moduleId === "region") {
      groups.forEach((items) => {
        items.sort((left, right) => {
          const leftRank = Number.isFinite(left.regionTypeRank) ? left.regionTypeRank : Number.MAX_SAFE_INTEGER;
          const rightRank = Number.isFinite(right.regionTypeRank) ? right.regionTypeRank : Number.MAX_SAFE_INTEGER;
          const rankDifference = leftRank - rightRank;
          return rankDifference || left.sourceSerial - right.sourceSerial;
        });
      });
    }

    const entries = Array.from(groups.entries());
    if (view.moduleId === "limited") {
      const limitedOrder = new Map([["限时活动", 0], ["限时获取", 1], ["固定刷新", 1]]);
      entries.sort(([left], [right]) => {
        const leftOrder = limitedOrder.has(left) ? limitedOrder.get(left) : 99;
        const rightOrder = limitedOrder.has(right) ? limitedOrder.get(right) : 99;
        return leftOrder - rightOrder;
      });
    }

    return `<section class="group-list">${entries.map(([key, items], index) => renderGroup(key, items, index === 0)).join("")}</section>`;
  }

  function renderGroup(key, items, open) {
    const stats = getStats(items);
    const newCount = getNewCount(items);
    const displayKey = view.moduleId === "limited" && key === "限时获取" ? "固定刷新" : key;
    return `
      <details class="group" data-group="${escapeHtml(key)}" ${open ? "open" : ""}>
        <summary>
          <span class="group-summary-copy"><span>${escapeHtml(displayKey)}</span><span class="group-progress" data-group-progress="${escapeHtml(key)}">${stats.doneTasks}/${stats.totalTasks}</span>${newCount ? `<span class="new-badge">NEW ${newCount}</span>` : ""}</span>
        </summary>
        <div class="group-content">${items.map(renderItem).join("")}</div>
      </details>
    `;
  }

  function renderItem(item) {
    const atoms = getAtoms(item);
    const period = `<span class="meta-chip period">${periodLabel(item.period)}</span>`;
    const quantity = Number.isFinite(item.quantity) ? `<span class="meta-chip">${item.quantity} 枚</span>` : '<span class="meta-chip">数量不定</span>';
    const note = renderNote(item.note);
    const countdown = renderCountdown(item.countdownEnd);

    if (item.children && item.children.length) {
      const doneCount = atoms.filter((atom) => isChecked(item, atom.id)).length;
      return `
        <details class="item-block expandable-item" data-item-block="${item.id}">
          <summary class="parent-title">
            <div><span class="item-main">${escapeHtml(item.displayTitle || item.condition)}${itemHasUnseenNew(item) ? renderNewBadge() : ""}</span><div class="item-meta"><span class="meta-chip">${escapeHtml(item.type)}</span>${quantity}${period}</div></div>
            <span class="parent-count" data-parent-progress="${item.id}">${doneCount}/${atoms.length}</span>
          </summary>
          <div class="expandable-content">
            <div class="child-list">${atoms.map((atom) => renderAtom(item, atom, true)).join("")}</div>
            ${countdown}
            ${note}
          </div>
        </details>
      `;
    }

    return `<article class="item-block" data-item-block="${item.id}">${renderAtom(item, atoms[0], false, `<div class="item-meta"><span class="meta-chip">${escapeHtml(item.type)}</span>${quantity}${period}</div>`)}${countdown}${note}</article>`;
  }

  function renderNote(note) {
    if (!note) return "";
    return `<p class="task-note">${escapeHtml(note)}</p>`;
  }

  function formatCountdownDuration(milliseconds) {
    const remainingSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
    const days = Math.floor(remainingSeconds / 86400);
    const hours = Math.floor((remainingSeconds % 86400) / 3600);
    const minutes = Math.floor((remainingSeconds % 3600) / 60);
    if (days > 0) return `${days}天 ${hours}小时`;
    if (hours > 0) return `${hours}小时 ${minutes}分钟`;
    return `${Math.max(1, minutes)}分钟`;
  }

  function formatCountdownDeadline(endTime) {
    const chinaTime = new Date(endTime + (8 * 60 * 60 * 1000));
    const month = chinaTime.getUTCMonth() + 1;
    const day = chinaTime.getUTCDate();
    const hour = String(chinaTime.getUTCHours()).padStart(2, "0");
    const minute = String(chinaTime.getUTCMinutes()).padStart(2, "0");
    return `${month}月${day}日 ${hour}:${minute}`;
  }

  function getCountdownStatus(endAt, now = Date.now()) {
    const endTime = Date.parse(endAt);
    if (!Number.isFinite(endTime)) {
      return { phase: "invalid", label: "活动时间", text: "截止时间待确认", deadline: "" };
    }

    if (now < endTime) {
      return {
        phase: "active",
        label: "距离结束",
        text: formatCountdownDuration(endTime - now),
        deadline: `${formatCountdownDeadline(endTime)}结束`,
      };
    }

    const hideTime = endTime + COUNTDOWN_RETENTION_MS;
    if (now < hideTime) {
      return {
        phase: "grace",
        label: "活动已结束",
        text: `${formatCountdownDuration(hideTime - now)}后隐藏`,
        deadline: `${formatCountdownDeadline(endTime)}结束`,
      };
    }

    return { phase: "retired", label: "活动已结束", text: "", deadline: "" };
  }

  function renderCountdown(endAt) {
    if (!endAt) return "";
    const status = getCountdownStatus(endAt);
    if (status.phase === "retired") return "";
    return `<div class="event-timing ${status.phase}" data-countdown-end="${escapeHtml(endAt)}"><span class="event-timing-copy"><span class="event-timing-label" data-countdown-label>${escapeHtml(status.label)}</span><strong data-countdown-value>${escapeHtml(status.text)}</strong></span>${status.deadline ? `<time data-countdown-deadline datetime="${escapeHtml(endAt)}">${escapeHtml(status.deadline)}</time>` : ""}</div>`;
  }

  function getCountdownVisibilitySignature(now = Date.now()) {
    return dataset.items
      .filter((item) => (item.countdownEnd || item.expiresAt) && isItemVisible(item, now))
      .map((item) => item.id)
      .join("|");
  }

  function updateCountdowns() {
    const now = Date.now();
    if (applyScheduledRefreshes(now)) {
      if (view.name === "detail") renderDetail();
      else renderHome();
      countdownVisibilitySignature = getCountdownVisibilitySignature(now);
      return;
    }
    const nextSignature = getCountdownVisibilitySignature(now);
    if (countdownVisibilitySignature !== null && nextSignature !== countdownVisibilitySignature) {
      countdownVisibilitySignature = nextSignature;
      if (view.name === "detail") renderDetail();
      else renderHome();
      return;
    }
    countdownVisibilitySignature = nextSignature;

    root.querySelectorAll("[data-countdown-end]").forEach((node) => {
      const status = getCountdownStatus(node.dataset.countdownEnd, now);
      const label = node.querySelector("[data-countdown-label]");
      const value = node.querySelector("[data-countdown-value]");
      const deadline = node.querySelector("[data-countdown-deadline]");
      if (label) label.textContent = status.label;
      if (value) value.textContent = status.text;
      if (deadline) deadline.textContent = status.deadline;
      node.classList.remove("active", "grace", "invalid");
      node.classList.add(status.phase);
    });
  }

  function renderAtom(item, atom, child, meta = "") {
    const checked = isChecked(item, atom.id) ? " checked" : "";
    const rowClass = child ? "child-check-row" : "check-row";
    const labelClass = child ? "child-label" : "item-main";
    return `
      <label class="${rowClass}">
        <input type="checkbox" data-item="${item.id}" data-atom="${atom.id}"${checked} />
        <span class="fake-check" aria-hidden="true"></span>
        <span><span class="${labelClass}">${escapeHtml(atom.label)}${isUnseenNew(item, atom) ? renderNewBadge() : ""}</span>${meta}</span>
      </label>
    `;
  }

  function refreshProgressDisplay(changedItem) {
    const allStats = getStats(getModuleItems(view.moduleId));
    const value = percent(allStats.doneTasks, allStats.totalTasks);
    const text = document.getElementById("module-progress-text");
    const fill = document.getElementById("module-progress-fill");
    if (text) text.textContent = `${value}%`;
    if (fill) fill.style.setProperty("--progress", `${value}%`);

    if (changedItem && changedItem.children && changedItem.children.length) {
      const atoms = getAtoms(changedItem);
      const done = atoms.filter((atom) => isChecked(changedItem, atom.id)).length;
      const parent = root.querySelector(`[data-parent-progress="${changedItem.id}"]`);
      if (parent) parent.textContent = `${done}/${atoms.length}`;
    }

    const group = changedItem ? groupKey(changedItem) : null;
    if (group) {
      const groupItems = getModuleItems(view.moduleId).filter((item) => groupKey(item) === group && itemMatches(item));
      const groupStats = getStats(groupItems);
      const groupNode = Array.from(root.querySelectorAll("[data-group-progress]")).find((node) => node.dataset.groupProgress === group);
      if (groupNode) groupNode.textContent = `${groupStats.doneTasks}/${groupStats.totalTasks}`;
    }
  }

  function clearModuleProgress(moduleId) {
    getAllModuleItems(moduleId).forEach(clearItemProgressInState);
    saveState();
  }

  root.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;

    if (action === "open-module") {
      view = { name: "detail", moduleId: button.dataset.module, query: "", filter: "all" };
      renderDetail();
      markModuleNewAsSeen(view.moduleId);
      return;
    }

    if (action === "back") {
      markModuleNewAsSeen(view.moduleId);
      view = { name: "home", moduleId: null, query: "", filter: "all" };
      renderHome();
      return;
    }

    if (action === "set-filter") {
      view.filter = button.dataset.filter;
      renderDetail();
      return;
    }

    if (action === "clear-search") {
      view.query = "";
      const input = document.getElementById("search-input");
      if (input) input.value = "";
      const area = document.getElementById("list-area");
      if (area) area.innerHTML = renderGroups();
      return;
    }

    if (action === "open-record-protection") {
      showRecordProtectionDialog();
      return;
    }

    if (action === "backup-records") {
      backupProgress();
      return;
    }

    if (action === "restore-records") {
      const input = document.getElementById("backup-file-input");
      if (input) input.click();
      return;
    }

    if (action === "reset-module") {
      if (confirm(`确定清空“${modules[view.moduleId].title}”中的所有记录吗？`)) {
        clearModuleProgress(view.moduleId);
        renderDetail();
      }
      return;
    }

    if (action === "reset-all" && confirm("确定清空当前设备上的全部袅袅记录吗？")) {
      const clearedState = createEmptyState();
      clearedState.seenNewIds = { ...state.seenNewIds };
      clearedState.refreshCycles = { ...state.refreshCycles };
      state = clearedState;
      saveState();
      renderHome();
    }
  });

  root.addEventListener("input", (event) => {
    if (event.target.id !== "search-input") return;
    view.query = event.target.value;
    const area = document.getElementById("list-area");
    if (area) area.innerHTML = renderGroups();
  });

  root.addEventListener("change", (event) => {
    if (event.target.id === "backup-file-input") {
      const file = event.target.files && event.target.files[0];
      event.target.value = "";
      if (file) restoreProgressFromFile(file);
      return;
    }

    const checkbox = event.target.closest('input[type="checkbox"][data-item]');
    if (!checkbox) return;
    const item = dataset.items.find((entry) => entry.id === checkbox.dataset.item);
    if (!item) return;
    setChecked(item, checkbox.dataset.atom, checkbox.checked);
    refreshProgressDisplay(item);
  });

  renderHome();
  hydrateFromMirror().then((hadPersistedState) => {
    applyScheduledRefreshes();
    if (!hadPersistedState) establishInitialNewBaseline();
  }).finally(() => {
    stateReady = true;
    if (view.name === "detail") renderDetail();
    else renderHome();
    updateCountdowns();
    window.setInterval(updateCountdowns, 30000);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) persistCurrentStateCopies();
      else updateCountdowns();
    });
    window.addEventListener("pagehide", persistCurrentStateCopies);
  });
})();
