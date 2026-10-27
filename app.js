/* Timestamp Convert — Date + Intl only; timezone math uses Intl's tz database, nothing remote. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$;
  var LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  var DEFAULT_ZONES = ["UTC", "America/Los_Angeles", "America/New_York", "Europe/London", "Asia/Dubai", "Asia/Tokyo"];
  var MAX_MS = 8.64e15;

  // ---------- core ----------
  // → {ms, unit} or throws. Auto-detects the unit from magnitude; BigInt keeps µs/ns exact before dividing.
  function parseTs(input, unit) {
    var s = String(input).trim().replace(/[\s,_']/g, "");
    if (!/^[-+]?\d+(\.\d+)?$/.test(s)) throw new Error("Use digits only, e.g. 1700000000");
    var neg = s.charAt(0) === "-", intPart = s.replace(/^[-+]/, "").split(".")[0], frac = s.split(".")[1] || "";
    var mag = intPart.replace(/^0+/, "").length;
    if (!unit || unit === "auto") unit = mag <= 11 ? "s" : mag <= 14 ? "ms" : mag <= 17 ? "us" : "ns";
    var div = { s: 1e-3, ms: 1, us: 1e3, ns: 1e6 }[unit], ms;
    if (unit === "us" || unit === "ns") {
      var big = BigInt(intPart), q = big / BigInt(div), r = Number(big % BigInt(div)) / div;
      ms = Number(q) + r + (frac ? Number("0." + frac) / div : 0);
    } else ms = Number(s.replace(/^[-+]/, "")) / div;
    if (neg) ms = -ms;
    if (!isFinite(ms) || Math.abs(ms) > MAX_MS) throw new Error("That is outside the range a date can show (±275,000 years)");
    return { ms: ms, unit: unit };
  }

  var dtfCache = {};
  function parts(ms, tz) {
    var f = dtfCache[tz] || (dtfCache[tz] = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", era: "short" }));
    var o = {};
    f.formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
    var y = +o.year; if (/^B/.test(o.era)) y = 1 - y;
    return { y: y, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
  }
  function utcOf(y, mo, d, h, mi, s) { var t = new Date(0); t.setUTCFullYear(y, mo - 1, d); t.setUTCHours(h, mi, s, 0); return t.getTime(); }
  // Offset of tz from UTC at instant ms, in ms (e.g. +3h → 10800000).
  function tzOffset(ms, tz) {
    var p = parts(ms, tz), base = Math.floor(ms / 1000) * 1000;
    return utcOf(p.y, p.mo, p.d, p.h, p.mi, p.s) - base;
  }
  // Wall-clock time in tz → epoch ms. Two passes settle DST edges.
  function wallToEpoch(y, mo, d, h, mi, s, tz) {
    var guess = utcOf(y, mo, d, h, mi, s), t = guess - tzOffset(guess, tz), off2 = tzOffset(t, tz);
    return guess - off2;
  }
  function fmtOffset(off) {
    var m = Math.round(off / 60000), sign = m < 0 ? "−" : "+"; m = Math.abs(m);
    return "UTC" + sign + String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  }
  function rel(ms, now) {
    var s = (ms - now) / 1000, U = [["year", 31557600], ["month", 2629800], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1]];
    for (var i = 0; i < U.length; i++) if (Math.abs(s) >= U[i][1] || i === U.length - 1) return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(Math.round(s / U[i][1]), U[i][0]);
  }
  function isoWeek(ms, tz) {
    var p = parts(ms, tz), t = new Date(Date.UTC(p.y, p.mo - 1, p.d)), day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    var y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    var doy = Math.floor((Date.UTC(p.y, p.mo - 1, p.d) - Date.UTC(p.y, 0, 1)) / 864e5) + 1;
    return { week: Math.ceil(((t - y0) / 864e5 + 1) / 7), doy: doy };
  }
  function fmtIn(ms, tz) {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(ms));
  }

  // ---------- UI helpers ----------
  function copyBtn(text, what) {
    return S3.h("button", { "class": "btn ghost small icon", title: "Copy " + what, "aria-label": "Copy " + what, html: '<svg class="i"><use href="#i-copy"/></svg>', onclick: function () { S3.copy(text, what + " copied"); S3.done(); } });
  }
  function fillRows(tbody, rows) {
    tbody.textContent = "";
    rows.forEach(function (r) {
      tbody.appendChild(S3.h("tr", null, [S3.h("th", { text: r[0] }), S3.h("td", { "class": r[2] === false ? "" : "mono", text: r[1] }), S3.h("td", { "class": "ts-c" }, [r[2] === false ? null : copyBtn(r[1], r[0])])]));
    });
  }
  function msg(tbody, text, bad) { tbody.textContent = ""; tbody.appendChild(S3.h("tr", null, [S3.h("td", { "class": bad ? "ts-bad" : "faint", text: text })])); }

  // ---------- live clock ----------
  var paused = false;
  function tick() {
    if (paused) return;
    var n = Date.now();
    $("#nowS b").textContent = Math.floor(n / 1000);
    $("#nowMs b").textContent = n;
    $("#nowIso b").textContent = new Date(n).toISOString().replace(/\.\d+Z$/, "Z");
  }
  setInterval(tick, 100); tick();
  $("#pause").addEventListener("click", function () {
    paused = !paused; this.setAttribute("aria-pressed", String(paused));
    this.querySelector("span").textContent = paused ? "Resume" : "Pause";
    this.querySelector("use").setAttribute("href", paused ? "#i-play" : "#i-pause");
    tick();
  });
  ["#nowS", "#nowMs", "#nowIso"].forEach(function (id) { $(id).addEventListener("click", function () { S3.copy(this.querySelector("b").textContent); }); });

  // ---------- timestamp -> date ----------
  var st = { unit: "auto", ms: null, zones: S3.store("ts.zones") || DEFAULT_ZONES.slice() };
  var UNIT_NAMES = { s: "seconds", ms: "milliseconds", us: "microseconds", ns: "nanoseconds" };
  function convert() {
    var v = $("#ts").value, tb = $("#outRows"), chip = $("#unitChip");
    S3.store("ts.last", v);
    if (!v.trim()) { st.ms = null; chip.className = "chip"; chip.textContent = "—"; msg(tb, "Type or paste a Unix timestamp."); drawZones(); return; }
    var r;
    try { r = parseTs(v, st.unit); } catch (e) { st.ms = null; chip.className = "chip bad"; chip.textContent = "Invalid"; msg(tb, e.message, true); drawZones(); return; }
    st.ms = r.ms;
    chip.className = "chip accent"; chip.textContent = (st.unit === "auto" ? "Detected: " : "") + UNIT_NAMES[r.unit];
    var d = new Date(r.ms), w = isoWeek(r.ms, LOCAL_TZ);
    fillRows(tb, [
      ["ISO 8601 (UTC)", d.toISOString()],
      ["UTC", d.toUTCString()],
      ["Local (" + LOCAL_TZ + ")", fmtIn(r.ms, LOCAL_TZ) + " · " + fmtOffset(tzOffset(r.ms, LOCAL_TZ))],
      ["Relative", rel(r.ms, Date.now()), false],
      ["Calendar", "Day " + w.doy + " of the year · ISO week " + w.week, false],
      ["Unix seconds", String(Math.floor(r.ms / 1000))],
      ["Unix milliseconds", String(Math.floor(r.ms))]
    ]);
    drawZones();
  }
  $$("#unit button").forEach(function (b) {
    b.addEventListener("click", function () {
      $$("#unit button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      st.unit = b.dataset.v; convert();
    });
  });
  $("#ts").addEventListener("input", S3.debounce(convert, 100));
  $("#useNow").addEventListener("click", function () { $("#ts").value = Math.floor(Date.now() / 1000); convert(); });

  // ---------- world clocks ----------
  var allZones = (Intl.supportedValuesOf ? Intl.supportedValuesOf("timeZone") : DEFAULT_ZONES).filter(function (z) { return z !== "UTC"; });
  function drawZones() {
    var tb = $("#zones"); tb.textContent = "";
    var ms = st.ms == null ? Date.now() : st.ms;
    [LOCAL_TZ].concat(st.zones.filter(function (z) { return z !== LOCAL_TZ; })).forEach(function (z) {
      var local = z === LOCAL_TZ, txt;
      try { txt = fmtIn(ms, z); } catch (e) { return; }
      tb.appendChild(S3.h("tr", null, [
        S3.h("td", null, [S3.h("b", { text: z.replace(/_/g, " ") }), local ? S3.h("span", { "class": "chip accent ts-you", text: "you" }) : null]),
        S3.h("td", { "class": "mono", text: txt }),
        S3.h("td", { "class": "mono faint", text: fmtOffset(tzOffset(ms, z)) }),
        S3.h("td", { "class": "ts-c" }, [local ? null : S3.h("button", { "class": "btn ghost small icon", title: "Remove " + z, "aria-label": "Remove " + z, html: '<svg class="i"><use href="#i-x"/></svg>', onclick: function () {
          st.zones = st.zones.filter(function (x) { return x !== z; }); S3.store("ts.zones", st.zones); drawZones();
        } })])
      ]));
    });
  }
  ["UTC"].concat(allZones).forEach(function (z) { $("#addZone").appendChild(S3.h("option", { value: z, text: z.replace(/_/g, " ") })); });
  $("#addZone").addEventListener("change", function () {
    var z = this.value; this.value = "";
    if (z && st.zones.indexOf(z) < 0) { st.zones.push(z); S3.store("ts.zones", st.zones); }
    drawZones();
  });

  // ---------- date -> timestamp ----------
  var dz = $("#dtZone");
  dz.appendChild(S3.h("option", { value: LOCAL_TZ, text: "Your timezone (" + LOCAL_TZ + ")" }));
  ["UTC"].concat(allZones).forEach(function (z) { if (z !== LOCAL_TZ) dz.appendChild(S3.h("option", { value: z, text: z.replace(/_/g, " ") })); });
  function back(ms, how) {
    var tb = $("#backRows");
    if (ms == null || isNaN(ms)) { msg(tb, how || "Pick a date and time, or type one.", !!how); return; }
    fillRows(tb, [["Unix seconds", String(Math.floor(ms / 1000))], ["Unix milliseconds", String(ms)], ["ISO 8601 (UTC)", new Date(ms).toISOString()]]);
  }
  function fromPicker() {
    var m = /^(\d{4,})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?/.exec($("#dt").value);
    if (!m) { back(null); return; }
    $("#dtText").value = "";
    back(wallToEpoch(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0), dz.value));
  }
  $("#dt").addEventListener("input", fromPicker);
  dz.addEventListener("change", fromPicker);
  $("#dtText").addEventListener("input", S3.debounce(function () {
    var v = $("#dtText").value.trim();
    if (!v) { fromPicker(); return; }
    var ms = Date.parse(v);
    back(isNaN(ms) ? null : ms, isNaN(ms) ? "Couldn't read that date. ISO 8601 like 2026-10-26T14:30:00Z works best." : null);
  }, 150));

  function pickerNow() {
    var p = parts(Date.now(), LOCAL_TZ), z = function (n) { return String(n).padStart(2, "0"); };
    $("#dt").value = p.y + "-" + z(p.mo) + "-" + z(p.d) + "T" + z(p.h) + ":" + z(p.mi) + ":" + z(p.s);
  }

  $("#ts").value = S3.store("ts.last") || Math.floor(Date.now() / 1000);
  convert(); pickerNow(); fromPicker();

  window.S3_DEMO = function () { $("#ts").value = "1767225600"; convert(); }; // 2026-01-01T00:00:00Z

  window.S3_SELFTEST = function () {
    var r = parseTs("1700000000");
    if (r.unit !== "s" || new Date(r.ms).toISOString() !== "2023-11-14T22:13:20.000Z") return "seconds";
    if (parseTs("1700000000123").unit !== "ms" || parseTs("1700000000123").ms !== 1700000000123) return "ms";
    r = parseTs("1700000000123456"); if (r.unit !== "us" || Math.abs(r.ms - 1700000000123.456) > 1e-3) return "us " + r.ms;
    r = parseTs("1700000000123456789"); if (r.unit !== "ns" || Math.floor(r.ms) !== 1700000000123) return "ns";
    if (parseTs("-86400").ms !== -86400000 || parseTs("1,700,000,000").ms !== 1.7e12 || parseTs("0").ms !== 0) return "neg/sep/zero";
    if (parseTs("1700000000", "ms").ms !== 1700000000) return "forced unit";
    try { parseTs("12abc"); return "garbage accepted"; } catch (e) { /* expected */ }
    if (tzOffset(Date.UTC(2026, 0, 15, 12), "America/New_York") !== -5 * 3600e3 || tzOffset(Date.UTC(2026, 6, 15, 12), "America/New_York") !== -4 * 3600e3) return "ny offset (DST)";
    if (tzOffset(Date.UTC(2026, 6, 1), "Asia/Kolkata") !== 5.5 * 3600e3) return "half-hour offset";
    if (wallToEpoch(2026, 7, 1, 9, 0, 0, "Asia/Tokyo") !== Date.UTC(2026, 6, 1, 0, 0)) return "tokyo wall";
    if (wallToEpoch(2026, 1, 15, 12, 0, 0, "America/New_York") !== Date.UTC(2026, 0, 15, 17)) return "ny wall winter";
    if (wallToEpoch(2026, 7, 15, 12, 0, 0, "America/New_York") !== Date.UTC(2026, 6, 15, 16)) return "ny wall summer";
    if (fmtOffset(-3.5 * 3600e3) !== "UTC−03:30") return "fmtOffset";
    var w = isoWeek(Date.UTC(2021, 0, 3, 12), "UTC"); if (w.week !== 53 || w.doy !== 3) return "iso week 2021-01-03";
    if (isoWeek(Date.UTC(2026, 9, 26, 12), "UTC").week !== 44) return "iso week 2026-10-26";
    return true;
  };
})();
