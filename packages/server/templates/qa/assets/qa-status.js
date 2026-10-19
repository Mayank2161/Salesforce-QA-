// Shared status-editing support for the QA report pages.
// Status changes are kept in this browser (localStorage) until saved back into the data file.
window.QAStatus = (function () {
  function store(key, val) {
    try {
      if (val === undefined) return JSON.parse(localStorage.getItem(key) || "null");
      if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { return null; }
  }

  function create(opts) {
    // opts: { storageKey, records, idField, globalName, fileName, header }
    var overrides = store(opts.storageKey) || {};

    function apply() {
      opts.records.forEach(function (r) {
        var o = overrides[r[opts.idField]];
        if (!o) return;
        if (!r.__originalStatus) r.__originalStatus = r.status;
        r.status = o.status;
        r.statusHistory = (r.statusHistory || []).concat(o.history.filter(function (h) {
          return !(r.statusHistory || []).some(function (x) { return x.on === h.on && x.to === h.to; });
        }));
      });
    }

    function change(id, newStatus, note, by) {
      var r = opts.records.filter(function (x) { return x[opts.idField] === id; })[0];
      if (!r || r.status === newStatus) return false;
      var entry = { from: r.status, to: newStatus, note: note || "", by: by || "Reviewer", on: new Date().toLocaleString() };
      var o = overrides[id] || { history: [] };
      o.status = newStatus;
      o.history.push(entry);
      overrides[id] = o;
      if (!r.__originalStatus) r.__originalStatus = r.status;
      r.status = newStatus;
      r.statusHistory = (r.statusHistory || []).concat([entry]);
      store(opts.storageKey, overrides);
      return true;
    }

    function pendingCount() { return Object.keys(overrides).length; }

    function discard() { overrides = {}; store(opts.storageKey, null); }

    function fileText() {
      var clean = opts.records.map(function (r) {
        var c = {}; Object.keys(r).forEach(function (k) { if (k.indexOf("__") !== 0) c[k] = r[k]; }); return c;
      });
      return opts.header + "\nwindow." + opts.globalName + " = " + JSON.stringify(clean, null, 2) + ";\n";
    }

    function saveToFile() {
      var text = fileText();
      var done = function (how) { discard(); return how; };
      if (window.showSaveFilePicker) {
        return window.showSaveFilePicker({ suggestedName: opts.fileName, types: [{ description: "JavaScript data file", accept: { "text/javascript": [".js"] } }] })
          .then(function (h) { return h.createWritable(); })
          .then(function (w) { return w.write(text).then(function () { return w.close(); }); })
          .then(function () { return done("saved"); });
      }
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
      a.download = opts.fileName; a.click();
      return Promise.resolve(done("downloaded"));
    }

    apply();
    return { change: change, pendingCount: pendingCount, discard: discard, saveToFile: saveToFile };
  }

  function reviewer(name) {
    if (name === undefined) return store("qa.reviewer") || "";
    store("qa.reviewer", name);
  }

  function historyHtml(list, esc, badge) {
    if (!list || !list.length) return "";
    return '<details class="more"><summary>Status history (' + list.length + ')</summary><div class="inner table-scroll"><table><thead><tr><th>When</th><th>By</th><th>Change</th><th>Note</th></tr></thead><tbody>' +
      list.slice().reverse().map(function (h) {
        return "<tr><td style=\"white-space:nowrap\">" + esc(h.on) + "</td><td>" + esc(h.by) + "</td><td style=\"white-space:nowrap\">" + badge(h.from) + " → " + badge(h.to) + "</td><td>" + esc(h.note) + "</td></tr>";
      }).join("") + "</tbody></table></div></details>";
  }

  function editorHtml(id, current, statuses, esc) {
    return '<details class="more edit"><summary>Change status</summary><div class="inner"><div class="status-editor" data-id="' + esc(id) + '">' +
      '<label>Change status<select class="se-status">' + statuses.map(function (s) {
        return '<option' + (s === current ? " selected" : "") + ">" + esc(s) + "</option>";
      }).join("") + "</select></label>" +
      '<label class="se-grow">Reason / note<input class="se-note" type="text" placeholder="e.g. Works as designed — confirmed with BA"></label>' +
      '<label>Your name<input class="se-by" type="text" value="' + esc(reviewer()) + '" placeholder="Name"></label>' +
      '<button class="btn primary se-apply" type="button">Update status</button></div></div></details>';
  }

  function bannerHtml(n) {
    if (!n) return "";
    return '<div class="pending-banner"><span><strong>' + n + "</strong> status change" + (n > 1 ? "s" : "") +
      " not yet saved to the data file (kept in this browser only).</span>" +
      '<span class="pb-actions"><button class="btn primary" id="pbSave" type="button">Save changes to data file</button>' +
      '<button class="btn" id="pbDiscard" type="button">Discard</button></span></div>';
  }

  return { create: create, reviewer: reviewer, historyHtml: historyHtml, editorHtml: editorHtml, bannerHtml: bannerHtml };
})();

// Small rendering helpers shared by the report pages.
window.QAUI = (function () {
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function badge(s) { var k = String(s).toLowerCase().replace(/[^a-z]+/g, "-").replace(/^n-a-?$/, "na"); return '<span class="badge b-' + k + '">' + esc(s) + "</span>"; }
  function pct(n, d) { return d ? Math.round(n / d * 100) : 0; }
  // segments: [{ label, count, color }] -> stacked bar with a counted legend.
  function stack(segments) {
    var total = segments.reduce(function (a, s) { return a + s.count; }, 0);
    if (!total) return '<div class="empty">Nothing to show yet.</div>';
    var bar = segments.filter(function (s) { return s.count; }).map(function (s) {
      return '<span style="flex:' + s.count + ";background:" + s.color + '" title="' + esc(s.label) + ": " + s.count + " (" + pct(s.count, total) + '%)"></span>';
    }).join("");
    var legend = segments.map(function (s) {
      return '<div><span class="dot" style="background:' + s.color + '"></span>' + esc(s.label) + " <b>" + s.count + '</b><span class="pct">' + pct(s.count, total) + "%</span></div>";
    }).join("");
    return '<div class="stack" role="img" aria-label="' + esc(segments.map(function (s) { return s.label + " " + s.count; }).join(", ")) + '">' + bar + '</div><div class="legend">' + legend + "</div>";
  }
  function mini(p) { return '<div class="mini"><div class="track"><div class="fill" style="width:' + p + '%"></div></div><span class="v">' + p + "%</span></div>"; }
  function num(n) { return n ? String(n) : '<span class="zero">0</span>'; }
  // "2026-10-01 21:29 IST" -> Date (local day).
  function day(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function fmtDay(d) { return d ? d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "–"; }
  function period(dates) {
    var ds = dates.map(day).filter(Boolean).sort(function (a, b) { return a - b; });
    if (!ds.length) return "";
    var a = fmtDay(ds[0]), b = fmtDay(ds[ds.length - 1]);
    return a === b ? a : a + " – " + b;
  }
  function uniq(list, key) { var m = {}; list.forEach(function (r) { if (r[key]) m[r[key]] = 1; }); return Object.keys(m).sort(); }
  function fill(select, values) { values.forEach(function (v) { var o = document.createElement("option"); o.textContent = v; select.appendChild(o); }); }
  // ?env=<org name> (links from the agent panel) opens the report filtered to that org only, even
  // when it has no records yet, so another org's runs never show by default.
  function pickEnv(select) {
    var want = new URLSearchParams(location.search).get("env");
    if (!want) return;
    if (!Array.prototype.some.call(select.options, function (o) { return o.value === want; })) fill(select, [want]);
    select.value = want;
  }
  function flash(msg) { var d = document.createElement("div"); d.className = "flash"; d.textContent = msg; document.body.appendChild(d); setTimeout(function () { d.remove(); }, 2600); }
  function csv(rows, name) {
    var text = rows.map(function (r) { return r.map(function (c) { return '"' + String(c == null ? "" : c).replace(/"/g, '""') + '"'; }).join(","); }).join("\r\n");
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    a.download = name; a.click();
  }
  function shots(list) {
    return (list || []).map(function (s) {
      if (!/\.(png|jpe?g|gif|webp)$/i.test(s.file))
        return '<a class="shot file" href="' + esc(s.file) + '" target="_blank"><div class="cap">📄 ' + esc(s.caption) + "<br>" + esc(s.file.split("/").pop()) + "</div></a>";
      return '<div class="shot" data-src="' + esc(s.file) + '" data-cap="' + esc(s.caption) + '"><img loading="lazy" src="' + esc(s.file) + '" alt="' + esc(s.caption) + '"><div class="cap">' + esc(s.caption) + "</div></div>";
    }).join("");
  }
  function lightbox() {
    var lb = document.getElementById("lightbox");
    document.addEventListener("click", function (e) {
      var shot = e.target.closest && e.target.closest(".shot:not(.file)");
      if (shot) { lb.querySelector("img").src = shot.dataset.src; lb.querySelector(".cap").textContent = shot.dataset.cap; lb.classList.add("show"); }
    });
    lb.addEventListener("click", function () { lb.classList.remove("show"); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") lb.classList.remove("show"); });
  }
  return { esc: esc, badge: badge, pct: pct, stack: stack, mini: mini, num: num, day: day, fmtDay: fmtDay, period: period, uniq: uniq, fill: fill, pickEnv: pickEnv, flash: flash, csv: csv, shots: shots, lightbox: lightbox };
})();
