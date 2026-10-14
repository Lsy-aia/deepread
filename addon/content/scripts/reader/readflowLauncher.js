/*
 * Optional ReadFlow engine: enable switch and "start ReadFlow when needed".
 * License: AGPL-3.0-or-later
 */
/* global DeepRead, Zotero, Services, IOUtils, Components */

DeepRead.ReadFlowLauncher = {
  get enabled() {
    return DeepRead.prefs.get("readflow.enabled") === true;
  },

  async appPath() {
    const configured = String(DeepRead.prefs.get("readflow.appPath") || "").trim();
    const candidates = configured ? [configured] : (Zotero.isWin
      ? [`${Services.dirsvc.get("LocalAppData", Components.interfaces.nsIFile).path}\\Programs\\ReadFlow\\ReadFlow.exe`, "C:\\Program Files\\ReadFlow\\ReadFlow.exe"]
      : Zotero.isMac ? ["/Applications/ReadFlow.app/Contents/MacOS/ReadFlow"] : ["/opt/ReadFlow/readflow", "/usr/bin/readflow"]);
    for (const path of candidates) {
      try {
        if (await IOUtils.exists(path)) return path;
      }
      catch (e) {}
    }
    return null;
  },

  async isRunning() {
    const result = await DeepRead.ReadFlow.testConnection().catch(() => ({ ok: false }));
    return !!result.ok;
  },

  /** Make sure the ReadFlow service is reachable; start the app when allowed. */
  async ensureRunning(onStatus = () => {}) {
    if (!this.enabled) {
      throw Object.assign(new Error(DeepRead.bilingual("ReadFlow 引擎未启用（设置 → DeepRead → ReadFlow 引擎）", "The ReadFlow engine is disabled (Settings → DeepRead)")), { configError: true });
    }
    if (await this.isRunning()) return true;
    if (DeepRead.prefs.get("readflow.autoStart") !== true) {
      throw new Error(DeepRead.bilingual("ReadFlow 没有运行：请先打开 ReadFlow，或在设置中开启「需要时自动启动 ReadFlow」", "ReadFlow is not running: open it, or enable auto-start in settings"));
    }
    const path = await this.appPath();
    if (!path) throw new Error(DeepRead.bilingual("找不到 ReadFlow 程序，请在设置中填写程序路径", "ReadFlow app not found; set its path in settings"));
    onStatus(DeepRead.bilingual("正在启动 ReadFlow…", "Starting ReadFlow…"));
    const process = Components.classes["@mozilla.org/process/util;1"].createInstance(Components.interfaces.nsIProcess);
    process.init(Zotero.File.pathToFile(path));
    process.runAsync([], 0);
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await this.isRunning()) return true;
    }
    throw new Error(DeepRead.bilingual("ReadFlow 启动超时，请手动打开后重试", "ReadFlow did not start in time; open it manually and retry"));
  },
};
