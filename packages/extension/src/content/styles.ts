// Scoped to the agent's shadow root, so it neither leaks into nor inherits from Salesforce styles.
export const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }

.fab {
  position: fixed; right: 24px; bottom: 72px; z-index: 2147483646;
  width: 56px; height: 56px; padding: 0; border-radius: 50%; border: none; cursor: pointer; overflow: hidden;
  background: #1b96ff; box-shadow: 0 6px 18px rgba(64, 44, 180, .35);
  transition: transform .15s ease, box-shadow .15s ease;
}
.fab:hover { transform: translateY(-2px) scale(1.04); box-shadow: 0 10px 24px rgba(64, 44, 180, .45); }
.fab-logo, .fab-logo svg { display: block; width: 100%; height: 100%; }
.header-logo { display: block; width: 24px; height: 24px; flex: none; }
.header-logo svg { display: block; width: 100%; height: 100%; }

.panel {
  position: fixed; right: 24px; bottom: 136px; z-index: 2147483647;
  width: 400px; max-width: calc(100vw - 48px); max-height: calc(100vh - 160px);
  display: flex; flex-direction: column; overflow: hidden;
  background: #fff; color: #181818; border-radius: 10px; border: 1px solid #d8dde6;
  box-shadow: 0 8px 30px rgba(0,0,0,.22); font-size: 13px;
}
.panel[hidden] { display: none; }

.header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: linear-gradient(135deg, #1b96ff, #6b3fe6); color: #fff; }
.header h1 { flex: 1; margin: 0; font-size: 14px; font-weight: 600; }
.icon-btn { background: transparent; border: none; color: inherit; cursor: pointer; font-size: 16px; padding: 2px 6px; border-radius: 4px; }
.icon-btn:hover { background: rgba(255,255,255,.2); }

.body { padding: 12px 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }

.conn { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #444; }
.conn .dot { width: 8px; height: 8px; border-radius: 50%; background: #aaa; flex: none; }
.conn.ok .dot { background: #2e844a; }
.conn.err { color: #ba0517; align-items: flex-start; }
.conn.err .dot { background: #ba0517; margin-top: 4px; }

label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; color: #3e3e3c; }
select, input, textarea {
  font: inherit; font-weight: 400; font-size: 13px; color: #181818; background: #fff;
  border: 1px solid #c9c9c9; border-radius: 4px; padding: 6px 8px; width: 100%;
}
textarea { min-height: 120px; resize: vertical; font-family: Consolas, "Courier New", monospace; font-size: 12px; }
select:focus, input:focus, textarea:focus { outline: 2px solid #0176d3; outline-offset: -1px; border-color: #0176d3; }
.row { display: flex; gap: 8px; align-items: center; }
.row > select { flex: 1; min-width: 0; }
.row.end { justify-content: flex-end; }
.hint { font-size: 11px; font-weight: 400; color: #706e6b; }
.hint.warn { color: #a96404; }
.hint.ok { color: #2e844a; }
.login-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.subform { display: flex; flex-direction: column; gap: 6px; padding: 10px; background: #f4f6fe; border: 1px solid #d8dde6; border-radius: 6px; }
.subform[hidden] { display: none; }
.user-results { display: flex; flex-direction: column; gap: 2px; max-height: 180px; overflow-y: auto; }
.user-row {
  display: flex; flex-direction: column; align-items: flex-start; gap: 1px; text-align: left; cursor: pointer;
  font: inherit; padding: 6px 8px; border: 1px solid transparent; border-radius: 4px; background: #fff; color: #181818;
}
.user-row:hover { background: #eef4ff; }
.user-row.picked { border-color: #1b96ff; background: #e6f0ff; }
.user-name { font-weight: 600; font-size: 13px; }
.user-meta { font-size: 11px; color: #706e6b; }
button[hidden] { display: none; }

/* Single test | Upload file */
.panel.wide { width: 640px; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid #d8dde6; }
.tab { font: inherit; font-size: 12px; font-weight: 600; padding: 6px 10px; border: none; border-bottom: 2px solid transparent; background: none; color: #706e6b; cursor: pointer; }
.tab.active { color: #0176d3; border-bottom-color: #0176d3; }
.mode-box { display: flex; flex-direction: column; gap: 10px; }
.mode-box[hidden] { display: none; }

/* Batch upload */
.suite { display: flex; flex-direction: column; gap: 8px; }
.drop { border: 2px dashed #c9c9c9; border-radius: 8px; padding: 14px; text-align: center; cursor: pointer; display: flex; flex-direction: column; gap: 4px; background: #fafbff; }
.drop:hover, .drop.over { border-color: #1b96ff; background: #eef4ff; }
.drop-title { font-weight: 600; color: #0176d3; }
.suite-msg { font-size: 12px; white-space: pre-wrap; }
.suite-msg.ok { color: #2e844a; font-weight: 600; }
.suite-msg.warn { color: #a96404; }
.suite-msg.err { color: #ba0517; }
.suite-table { display: flex; flex-direction: column; max-height: 280px; overflow-y: auto; border: 1px solid #e5e5e5; border-radius: 6px; }
.suite-table:empty { display: none; }
.srow { display: grid; grid-template-columns: 18px 82px 78px 1fr 110px 72px; gap: 6px; align-items: center; padding: 5px 8px; border-bottom: 1px solid #f0f0f0; font-size: 12px; }
.srow:last-child { border-bottom: none; }
.srow.head { position: sticky; top: 0; background: #f3f3f3; font-weight: 600; color: #3e3e3c; z-index: 1; }
.srow.invalid { background: #fdf3f3; color: #706e6b; }
.srow > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.srow .tc { font-family: Consolas, monospace; font-weight: 600; }
.srow a.tc { color: #0176d3; }
.srow .per.warn { color: #a96404; }
.srow .st { justify-self: start; }
.srow .row-note { grid-column: 2 / -1; font-size: 11px; color: #a96404; white-space: normal; }
.srow .row-note.err { color: #ba0517; }
.badge.QUEUED { background: #706e6b; }
.badge.RUNNING { background: #0176d3; }
.badge.INVALID, .badge.ERROR { background: #ba0517; }
.badge.CANCELLED { background: #c9c9c9; color: #3e3e3c; }
.suite-summary { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid #e5e5e5; padding-top: 8px; }
.suite-summary[hidden] { display: none; }
.stats { display: flex; gap: 6px; flex-wrap: wrap; }
.stat { flex: 1 1 70px; border: 1px solid #e5e5e5; border-radius: 6px; padding: 6px 8px; text-align: center; }
.stat .v { font-size: 18px; font-weight: 700; }
.stat .l { font-size: 11px; color: #706e6b; }
.stat.PASS .v { color: #2e844a; }
.stat.FAIL .v { color: #ba0517; }
.stat.BLOCKED .v { color: #a96404; }

.btn { border: none; border-radius: 4px; padding: 8px 14px; font-size: 13px; font-weight: 600; cursor: pointer; background: #0176d3; color: #fff; }
.btn:hover:not(:disabled) { background: #014486; }
.btn:not(.secondary):not(.small) { background: linear-gradient(135deg, #1b96ff, #6b3fe6); }
.btn:not(.secondary):not(.small):hover:not(:disabled) { filter: brightness(.92); }
.btn:not(.secondary):not(.small):disabled { background: #c9c9c9; }
.btn:disabled { background: #c9c9c9; cursor: default; }
.btn.secondary { background: #fff; color: #0176d3; border: 1px solid #c9c9c9; padding: 5px 10px; font-size: 12px; white-space: nowrap; }
.btn.secondary:hover:not(:disabled) { background: #f3f3f3; }
.btn.secondary:disabled { color: #c9c9c9; background: #fff; }
.btn.small { padding: 5px 12px; font-size: 12px; white-space: nowrap; }

.result { border-top: 1px solid #e5e5e5; padding-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.result[hidden] { display: none; }
.status-line { display: flex; align-items: center; gap: 8px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; color: #fff; background: #706e6b; }
.badge.PASS { background: #2e844a; }
.badge.FAIL { background: #ba0517; }
.badge.BLOCKED { background: #a96404; }
.badge.NA { background: #8a8886; }
.badge.sev-Critical, .badge.sev-High { background: #ba0517; }
.badge.sev-Medium { background: #a96404; }
.badge.sev-Low { background: #706e6b; }
.run-id { margin-left: auto; font-size: 11px; color: #706e6b; font-family: Consolas, monospace; }
.steps { display: flex; flex-direction: column; gap: 6px; }
.bugs { display: flex; flex-direction: column; gap: 4px; }
.bugs-title { font-weight: 600; font-size: 12px; color: #3e3e3c; margin-top: 4px; }
.bug-line { display: flex; gap: 6px; align-items: flex-start; font-size: 12px; }
.step { border: 1px solid #e5e5e5; border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
.step-title { display: flex; gap: 6px; align-items: center; font-weight: 600; }
.step .actual { color: #3e3e3c; white-space: pre-wrap; word-break: break-word; }
.step img { width: 100%; border: 1px solid #e5e5e5; border-radius: 4px; cursor: zoom-in; }
.step img.zoomed { position: fixed; inset: 20px; width: auto; max-width: calc(100vw - 40px); max-height: calc(100vh - 40px); margin: auto; z-index: 2147483647; cursor: zoom-out; box-shadow: 0 0 0 100vmax rgba(0,0,0,.6); }
.log { font-family: Consolas, monospace; font-size: 11px; color: #555; background: #f6f6f6; border-radius: 4px; padding: 6px 8px; max-height: 120px; overflow-y: auto; }
.log div.error { color: #ba0517; }
.log div.warn { color: #a96404; }
.error-box { color: #ba0517; white-space: pre-wrap; }
`;
