// Scoped to the agent's shadow root, so it neither leaks into nor inherits from Salesforce styles.
export const STYLES = `
:host {
  all: initial;
  --brand: #0b5cab; --brand-dark: #014486; --brand-soft: #eef4ff;
  --text: #1f2937; --muted: #6b7280; --border: #e5e7eb; --border-strong: #d1d5db;
  --surface: #ffffff; --canvas: #f7f8fa;
  --ok: #2e844a; --warn: #a96404; --err: #ba0517;
  --radius: 8px;
}
* { box-sizing: border-box; font-family: "Segoe UI", -apple-system, Roboto, Arial, sans-serif; }

.fab {
  position: fixed; right: 24px; bottom: 72px; z-index: 2147483646;
  width: 52px; height: 52px; padding: 0; border-radius: 50%; border: none; cursor: pointer; overflow: hidden;
  background: var(--brand); box-shadow: 0 4px 14px rgba(11, 92, 171, .35);
  transition: transform .15s ease, box-shadow .15s ease;
}
.fab:hover { transform: translateY(-1px); box-shadow: 0 8px 20px rgba(11, 92, 171, .4); }
.fab-logo, .fab-logo svg { display: block; width: 100%; height: 100%; }
.header-logo { display: block; width: 30px; height: 30px; flex: none; border-radius: 6px; overflow: hidden; }
.header-logo svg { display: block; width: 100%; height: 100%; }

.panel {
  position: fixed; right: 24px; bottom: 136px; z-index: 2147483647;
  width: 440px; max-width: calc(100vw - 48px); max-height: calc(100vh - 160px);
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--canvas); color: var(--text); border-radius: 12px; border: 1px solid var(--border);
  box-shadow: 0 12px 40px rgba(15, 23, 42, .18); font-size: 13px; line-height: 1.45;
}
.panel[hidden] { display: none; }
.panel.wide { width: 680px; }

.header { display: flex; align-items: center; gap: 12px; padding: 14px 16px; background: var(--brand); color: #fff; }
.header .title { flex: 1; min-width: 0; }
.header h1 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: .1px; }
.header .subtitle { font-size: 11.5px; opacity: .8; }
.icon-btn { background: transparent; border: none; color: inherit; cursor: pointer; font-size: 15px; width: 30px; height: 30px; border-radius: 6px; }
.icon-btn:hover { background: rgba(255,255,255,.16); }

.body { padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }

/* Sections */
.card { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.card-title { font-size: 11px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; color: var(--muted); }

/* Agent connection */
.conn { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); padding: 8px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.conn .dot { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; flex: none; }
.conn.ok .dot { background: var(--ok); box-shadow: 0 0 0 3px rgba(46, 132, 74, .15); }
.conn.err { color: var(--err); align-items: flex-start; border-color: #f3c7c7; background: #fdf4f4; }
.conn.err .dot { background: var(--err); margin-top: 4px; }
.conn .btn { margin-left: auto; }

/* Form controls */
label { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; font-weight: 600; color: var(--text); }
select, input, textarea {
  font: inherit; font-weight: 400; font-size: 13px; color: var(--text); background: var(--surface);
  border: 1px solid var(--border-strong); border-radius: 6px; padding: 8px 10px; width: 100%; min-height: 36px;
  transition: border-color .12s ease, box-shadow .12s ease;
}
select { cursor: pointer; }
textarea { min-height: 140px; resize: vertical; font-family: Consolas, "Courier New", monospace; font-size: 12px; line-height: 1.5; }
select:focus, input:focus, textarea:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(11, 92, 171, .15); }
select:disabled { background: var(--canvas); color: var(--muted); cursor: default; }
::placeholder { color: #9ca3af; }
.row { display: flex; gap: 8px; align-items: center; }
.row > select { flex: 1; min-width: 0; }
.row.end { justify-content: flex-end; }
.hint { font-size: 12px; font-weight: 400; color: var(--muted); }
.hint.warn { color: var(--warn); }
.hint.ok { color: var(--ok); }
.hint:empty { display: none; }
.login-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 10px 12px; background: var(--canvas); border-radius: 6px; }
.login-row:empty { display: none; }

/* Add persona */
.subform { display: flex; flex-direction: column; gap: 10px; padding: 14px; background: var(--canvas); border: 1px solid var(--border); border-radius: var(--radius); }
.subform[hidden] { display: none; }
.subform-title { font-weight: 600; font-size: 13px; }
.step-head { display: flex; gap: 10px; align-items: flex-start; margin-top: 2px; }
.step-num { flex: none; width: 22px; height: 22px; border-radius: 50%; background: var(--brand); color: #fff; font-size: 11.5px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.step-name { font-weight: 600; font-size: 12.5px; }
.user-results { display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; padding: 2px; }
.user-row {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; cursor: pointer;
  font: inherit; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text);
}
.user-row:hover { border-color: #b6cdf0; background: var(--brand-soft); }
.user-row.picked { border-color: var(--brand); background: var(--brand-soft); box-shadow: inset 3px 0 0 var(--brand); }
.user-name { font-weight: 600; font-size: 13px; }
.user-meta { font-size: 11.5px; color: var(--muted); }
button[hidden] { display: none; }

/* Single test | Upload file */
.tabs { display: flex; gap: 4px; padding: 3px; background: var(--canvas); border: 1px solid var(--border); border-radius: 8px; }
.tab { flex: 1; font: inherit; font-size: 12.5px; font-weight: 600; padding: 7px 10px; border: none; border-radius: 6px; background: none; color: var(--muted); cursor: pointer; }
.tab:hover { color: var(--text); }
.tab.active { background: var(--surface); color: var(--brand); box-shadow: 0 1px 2px rgba(15, 23, 42, .1); }
.mode-box { display: flex; flex-direction: column; gap: 14px; }
.mode-box[hidden] { display: none; }

/* Batch upload */
.suite { display: flex; flex-direction: column; gap: 10px; }
.drop { border: 1.5px dashed var(--border-strong); border-radius: var(--radius); padding: 18px; text-align: center; cursor: pointer; display: flex; flex-direction: column; gap: 6px; background: var(--canvas); }
.drop:hover, .drop.over { border-color: var(--brand); background: var(--brand-soft); }
.drop-title { font-weight: 600; color: var(--brand); }
.suite-msg { font-size: 12px; white-space: pre-wrap; }
.suite-msg.ok { color: var(--ok); font-weight: 600; }
.suite-msg.warn { color: var(--warn); }
.suite-msg.err { color: var(--err); }
.suite-table { display: flex; flex-direction: column; max-height: 300px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius); }
.suite-table:empty { display: none; }
.srow { display: grid; grid-template-columns: 18px 82px 78px 1fr 110px 72px; gap: 8px; align-items: center; padding: 7px 10px; border-bottom: 1px solid #f1f2f4; font-size: 12px; }
.srow:last-child { border-bottom: none; }
.srow.head { position: sticky; top: 0; background: var(--canvas); font-weight: 600; color: var(--muted); z-index: 1; }
.srow.invalid { background: #fdf4f4; color: var(--muted); }
.srow > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.srow input { min-height: 0; width: auto; }
.srow .tc { font-family: Consolas, monospace; font-weight: 600; }
.srow a.tc { color: var(--brand); }
.srow .per.warn { color: var(--warn); }
.srow .st { justify-self: start; }
.srow .row-note { grid-column: 2 / -1; font-size: 11px; color: var(--warn); white-space: normal; }
.srow .row-note.err { color: var(--err); }
.badge.QUEUED { background: #6b7280; }
.badge.RUNNING { background: var(--brand); }
.badge.INVALID, .badge.ERROR { background: var(--err); }
.badge.CANCELLED { background: #d1d5db; color: #374151; }
.suite-summary { display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--border); padding-top: 10px; }
.suite-summary[hidden] { display: none; }
.stats { display: flex; gap: 8px; flex-wrap: wrap; }
.stat { flex: 1 1 70px; border: 1px solid var(--border); border-radius: var(--radius); padding: 8px; text-align: center; background: var(--surface); }
.stat .v { font-size: 20px; font-weight: 700; }
.stat .l { font-size: 11px; color: var(--muted); }
.stat.PASS .v { color: var(--ok); }
.stat.FAIL .v { color: var(--err); }
.stat.BLOCKED .v { color: var(--warn); }

/* Check test cases against a BRD */
.review { display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; background: var(--canvas); }
.review[hidden] { display: none; }
.review-head { display: flex; align-items: baseline; gap: 8px; font-weight: 600; }
.drop.small { padding: 12px; }
.drop[hidden], .doc-chip[hidden], .review-progress[hidden] { display: none; }
.doc-chip { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; }
.doc-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.review-progress { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border); padding-top: 10px; }
.bar { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; }
.bar .fill { height: 100%; background: var(--brand); border-radius: 3px; transition: width .4s ease; }

/* Buttons: primary (solid), small (solid, compact), secondary (outline), link (text) */
.btn { font: inherit; border: 1px solid transparent; border-radius: 6px; padding: 7px 14px; font-size: 12.5px; font-weight: 600; cursor: pointer; background: var(--brand); color: #fff; white-space: nowrap; transition: background .12s ease; }
.btn:hover:not(:disabled) { background: var(--brand-dark); }
.btn:disabled { background: #e5e7eb; color: #9ca3af; cursor: default; }
.btn.primary { padding: 10px 16px; font-size: 13.5px; }
.btn.block { width: 100%; }
.btn.small { padding: 6px 12px; }
.btn.secondary { background: var(--surface); color: var(--text); border-color: var(--border-strong); padding: 6px 12px; }
.btn.secondary:hover:not(:disabled) { background: var(--canvas); border-color: #9ca3af; }
.btn.secondary:disabled { color: #9ca3af; background: var(--surface); }
.btn.link { background: none; border: none; padding: 2px 0; color: var(--brand); }
.btn.link:hover:not(:disabled) { background: none; text-decoration: underline; }
.btn.link:disabled { background: none; color: #9ca3af; }
.btn.link.danger { color: var(--err); margin-left: auto; }

/* Run result */
.result { border-top: 1px solid var(--border); padding-top: 14px; display: flex; flex-direction: column; gap: 10px; }
.result[hidden] { display: none; }
.status-line { display: flex; align-items: center; gap: 8px; }
.badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; color: #fff; background: #6b7280; }
.badge.PASS { background: var(--ok); }
.badge.FAIL { background: var(--err); }
.badge.BLOCKED { background: var(--warn); }
.badge.NA { background: #9ca3af; }
.badge.sev-Critical, .badge.sev-High { background: var(--err); }
.badge.sev-Medium { background: var(--warn); }
.badge.sev-Low { background: #6b7280; }
.run-id { margin-left: auto; font-size: 11px; color: var(--muted); font-family: Consolas, monospace; }
.steps { display: flex; flex-direction: column; gap: 8px; }
.bugs { display: flex; flex-direction: column; gap: 6px; }
.bugs-title { font-weight: 600; font-size: 12.5px; margin-top: 4px; }
.bug-line { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; }
.step { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; background: var(--surface); }
.step-title { display: flex; gap: 8px; align-items: center; font-weight: 600; }
.step .actual { color: #374151; white-space: pre-wrap; word-break: break-word; }
.step img { width: 100%; border: 1px solid var(--border); border-radius: 6px; cursor: zoom-in; }
.step img.zoomed { position: fixed; inset: 20px; width: auto; max-width: calc(100vw - 40px); max-height: calc(100vh - 40px); margin: auto; z-index: 2147483647; cursor: zoom-out; box-shadow: 0 0 0 100vmax rgba(0,0,0,.6); }
.api-evidence { border: 1px solid var(--border); border-radius: 6px; font-size: 12px; }
.api-evidence summary { cursor: pointer; padding: 6px 10px; font-family: Consolas, monospace; font-weight: 600; }
.api-evidence summary.ok { color: var(--ok); }
.api-evidence summary.bad { color: var(--err); }
.api-body { margin: 0; padding: 8px 10px; max-height: 220px; overflow: auto; background: var(--canvas); font-size: 11px; white-space: pre-wrap; word-break: break-word; }

/* Single test: other personas */
.field { display: flex; flex-direction: column; gap: 8px; }
.field[hidden] { display: none; }
.field-label { font-size: 12.5px; font-weight: 600; }
.extra-personas { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { flex-direction: row; align-items: center; gap: 6px; font-weight: 500; font-size: 12px; color: var(--text); border: 1px solid var(--border-strong); border-radius: 999px; padding: 4px 12px 4px 8px; cursor: pointer; background: var(--surface); }
.chip input { width: auto; min-height: 0; margin: 0; box-shadow: none; }
.chip:has(input:checked) { border-color: var(--brand); background: var(--brand-soft); color: var(--brand); }

.log { font-family: Consolas, monospace; font-size: 11px; color: #4b5563; background: var(--canvas); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; max-height: 140px; overflow-y: auto; }
.log div.error { color: var(--err); }
.log div.warn { color: var(--warn); }
.error-box { color: var(--err); white-space: pre-wrap; }
`;
