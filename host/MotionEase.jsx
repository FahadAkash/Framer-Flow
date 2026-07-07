/**********************************************************************
 * MotionEase.jsx — ExtendScript host for the MotionEase panel.
 *
 * Exposes three entry points the panel calls via CSInterface.evalScript:
 *   MotionEase.ping()               -> "MotionEase <version>"
 *   MotionEase.getSelectionInfo()   -> JSON { clips, sequence }
 *   MotionEase.apply(payloadJson)   -> JSON { ok, applied, message, details }
 *
 * apply() reads the first & last keyframe of each selected property, then
 * bakes a dense set of keyframes between them following the shaped curve.
 * Dense baking reproduces the exact motion regardless of Premiere's limited
 * bezier-handle API — the value graph you drew is the value graph you get.
 **********************************************************************/

//@include "./lib/json2.jsx"

var MotionEase = (function () {
    "use strict";

    var VERSION = "1.0.0";

    // Undo history: each Apply pushes a set of per-property snapshots taken
    // BEFORE it modified anything. restoreLast() pops and rewrites them. The
    // ExtendScript engine is persistent across evalScript calls, so live param
    // references and this stack survive between panel calls.
    var undoStack = [];
    var UNDO_LIMIT = 25;

    // Premiere keyframe interpolation constants (best-effort; baking is dense
    // so the exact type barely affects the result).
    var KF = { LINEAR: 0, BEZIER: 2, HOLD: 1, TIME: 3 };

    // The interpolation type used for the "Ease my keyframes" (native) mode.
    // Premiere's enum has varied across versions; if native easing ever FREEZES
    // a value (Hold) instead of smoothing it, change this to 1.
    var BEZIER_INTERP = KF.BEZIER;

    // CRITICAL for performance: passing updateUI=true on every keyframe write
    // forces Premiere to redraw the Effect Controls + Program monitor after each
    // call. Across 4 properties x ~12 keys that's 100+ full redraws in a loop and
    // Premiere hangs. So we suppress UI updates during the loop (false) and force
    // a single refresh only on the very last write of each property.
    var NO_UI = false;
    var DO_UI = true;

    // Panel prop id -> Premiere property displayName(s)
    var TARGETS = {
        position: ["Position"],
        scale: ["Scale"],
        rotation: ["Rotation"],
        opacity: ["Opacity"]
    };

    // ---- helpers ---------------------------------------------------------

    function activeSeq() {
        return app.project ? app.project.activeSequence : null;
    }

    function getSelectedItems(seq) {
        if (!seq) return [];
        // Newer API: sequence.getSelection() -> Array of TrackItem
        try {
            if (typeof seq.getSelection === "function") {
                var sel = seq.getSelection();
                if (sel && sel.length !== undefined) {
                    var arr = [];
                    for (var i = 0; i < sel.length; i++) arr.push(sel[i]);
                    return arr;
                }
            }
        } catch (e) {}
        // Fallback: walk tracks and test isSelected()
        var items = [];
        var groups = [seq.videoTracks, seq.audioTracks];
        for (var g = 0; g < groups.length; g++) {
            var tracks = groups[g];
            if (!tracks) continue;
            for (var t = 0; t < tracks.numTracks; t++) {
                var clips = tracks[t].clips;
                for (var c = 0; c < clips.numItems; c++) {
                    var clip = clips[c];
                    try { if (clip.isSelected()) items.push(clip); } catch (e2) {}
                }
            }
        }
        return items;
    }

    function keyTimeSeconds(k) {
        if (k === null || k === undefined) return null;
        if (typeof k === "number") return k;
        if (k.seconds !== undefined && k.seconds !== null) return k.seconds;
        var n = Number(k);
        return isNaN(n) ? null : n;
    }

    function isVector(v) {
        return v !== null && typeof v === "object" && v.length !== undefined;
    }

    function lerp(a, b, f) {
        if (isVector(a) && isVector(b)) {
            var out = [];
            for (var i = 0; i < a.length; i++) out.push(a[i] + (b[i] - a[i]) * f);
            return out;
        }
        return a + (b - a) * f;
    }

    var TICKS_PER_SECOND = 254016000000;

    // A numeric value in the key's OWN domain (may be seconds or ticks). Used
    // only for ordering/interpolation — never converted before feeding it back
    // to Premiere, so we stay in whatever domain getKeys() handed us.
    function rawNum(k) {
        if (k === null || k === undefined) return null;
        if (typeof k === "number") return k;
        if (typeof k === "string") { var s = parseFloat(k); return isNaN(s) ? null : s; }
        if (k.ticks !== undefined && k.ticks !== null) {
            var t = parseFloat(k.ticks);
            if (!isNaN(t)) return t;
        }
        if (k.seconds !== undefined && k.seconds !== null) return k.seconds;
        var n = Number(k);
        return isNaN(n) ? null : n;
    }

    // Given the numeric magnitudes, decide whether they are ticks or seconds and
    // return a converter to seconds (for comparing against the playhead).
    function toSecondsFn(nums) {
        var mx = 0;
        for (var i = 0; i < nums.length; i++) {
            if (nums[i] !== null) { var a = Math.abs(nums[i]); if (a > mx) mx = a; }
        }
        var looksLikeTicks = mx > 1e7; // 1e7 seconds = ~115 days; no real timeline hits that
        return looksLikeTicks
            ? function (n) { return n / TICKS_PER_SECOND; }
            : function (n) { return n; };
    }

    function playheadSeconds(seq) {
        try {
            var t = seq.getPlayerPosition();
            if (t === null || t === undefined) return null;
            if (t.seconds !== undefined && t.seconds !== null) return t.seconds;
            if (t.ticks !== undefined && t.ticks !== null) {
                var tk = parseFloat(t.ticks);
                if (!isNaN(tk)) return tk / TICKS_PER_SECOND;
            }
            return rawNum(t);
        } catch (e) { return null; }
    }

    // Convert a Time-ish value (Time object or number) to seconds, or null.
    function timeToSeconds(t) {
        if (t === null || t === undefined) return null;
        if (typeof t === "number") return t;
        if (t.seconds !== undefined && t.seconds !== null) return t.seconds;
        if (t.ticks !== undefined && t.ticks !== null) {
            var v = parseFloat(t.ticks);
            if (!isNaN(v)) return v / TICKS_PER_SECOND;
        }
        return null;
    }

    // From a property's raw keyframe list, pick the ONE segment (adjacent pair)
    // the playhead sits inside — this scopes an Apply to just the two keyframes
    // you're working on. The playhead comes from the sequence (sequence time) but
    // keyframe times may be clip-relative, so we try several reference frames
    // (sequence, clip-start-relative, clip-start+in-point) and use whichever puts
    // the playhead inside the keyframe range.
    function pickSegment(keys, seq, item) {
        var arr = [];
        for (var i = 0; i < keys.length; i++) {
            var n = rawNum(keys[i]);
            if (n !== null) arr.push({ raw: keys[i], n: n });
        }
        arr.sort(function (x, y) { return x.n - y.n; });
        if (arr.length < 2) return null;

        var nums = [];
        for (var j = 0; j < arr.length; j++) nums.push(arr[j].n);
        var toSec = toSecondsFn(nums);
        var loSec = toSec(arr[0].n), hiSec = toSec(arr[arr.length - 1].n);

        var P = playheadSeconds(seq);
        var Peff = null;
        if (P !== null) {
            // candidate playhead positions in the keyframes' own reference frame
            var startSec = item ? timeToSeconds(item.start) : null;
            var inSec = item ? timeToSeconds(item.inPoint) : null;
            var candidates = [P];
            if (startSec !== null) candidates.push(P - startSec);
            if (startSec !== null && inSec !== null) candidates.push(P - startSec + inSec);
            for (var ci = 0; ci < candidates.length; ci++) {
                var cand = candidates[ci];
                if (cand >= loSec - 1e-3 && cand <= hiSec + 1e-3) { Peff = cand; break; }
            }
            if (Peff === null) Peff = P; // nothing landed in range; use raw (falls back below)
        }

        var idx = -1;
        if (Peff !== null) {
            for (var s = 0; s < arr.length - 1; s++) {
                var a = toSec(arr[s].n), b = toSec(arr[s + 1].n);
                if (Peff >= a - 1e-3 && Peff <= b + 1e-3) { idx = s; break; }
            }
            if (idx < 0) idx = (Peff < loSec) ? 0 : arr.length - 2; // outside -> nearest end
        } else {
            idx = 0; // no playhead info at all
        }

        return { list: arr, a: arr[idx], b: arr[idx + 1], multi: arr.length > 2, idx: idx };
    }

    // Find matching ComponentParams on a TrackItem for the requested props.
    // How many keyframes a param currently has (0 if not animated/keyframeable).
    function paramKeyCount(param) {
        try {
            var tv = (typeof param.isTimeVarying === "function") ? param.isTimeVarying() : false;
            if (!tv) return 0;
            var k = param.getKeys();
            return (k && k.length) ? k.length : 0;
        } catch (e) { return 0; }
    }

    // Map a property display name to one of our target ids, or null.
    function targetIdForName(name) {
        if (!name) return null;
        var lower = name.toLowerCase();
        for (var id in TARGETS) {
            if (!TARGETS.hasOwnProperty(id)) continue;
            var aliases = TARGETS[id];
            for (var a = 0; a < aliases.length; a++) {
                if (lower === aliases[a].toLowerCase()) return id;
            }
        }
        return null;
    }

    // Collect target params on an item.
    //   wanted   = target ids to include by name (position/scale/rotation/opacity),
    //              matched across EVERY component — so the Transform effect's
    //              "Position"/"Scale"/etc. are found just like the Motion ones.
    //   anyKeyed = also include ANY param that currently has 2+ keyframes, which
    //              covers third-party effect parameters with arbitrary names.
    // Deduped by component:param identity so nothing is processed twice.
    function collectProps(item, wanted, anyKeyed) {
        var found = []; // { id, param, name, comp }
        var comps = item.components;
        if (!comps) return found;

        var wantSet = {};
        for (var w = 0; w < wanted.length; w++) wantSet[wanted[w]] = true;

        for (var ci = 0; ci < comps.numItems; ci++) {
            var comp = comps[ci];
            var compName; try { compName = comp.displayName; } catch (e) { compName = "Effect"; }
            var params = comp.properties;
            if (!params) continue;
            for (var pi = 0; pi < params.numItems; pi++) {
                var param = params[pi];
                var name; try { name = param.displayName; } catch (e2) { name = ""; }
                var id = targetIdForName(name);
                var include = false;
                if (id && wantSet[id]) include = true;
                if (!include && anyKeyed && paramKeyCount(param) >= 2) include = true;
                if (include) {
                    var key = ci + ":" + pi;
                    var dup = false;
                    for (var f = 0; f < found.length; f++) { if (found[f].key === key) { dup = true; break; } }
                    if (!dup) found.push({ id: id || "custom", param: param, name: name, comp: compName, key: key });
                }
            }
        }
        return found;
    }

    function setKeyLinear(param, time) {
        try { param.setInterpolationTypeAtKey(time, KF.LINEAR, false); } catch (e) {}
    }

    // Build an in-between keyframe TIME at fraction `frac` of the way from rawA to
    // rawB, matching whatever format getKeys() returned so addKey()/setValueAtKey()
    // land correctly. Handles plain numbers, Time objects (.ticks or .seconds).
    function interpTime(rawA, rawB, frac) {
        if (typeof rawA === "number" && typeof rawB === "number") {
            return rawA + frac * (rawB - rawA);
        }
        var aT = (rawA && rawA.ticks !== undefined && rawA.ticks !== null) ? parseFloat(rawA.ticks) : null;
        var bT = (rawB && rawB.ticks !== undefined && rawB.ticks !== null) ? parseFloat(rawB.ticks) : null;
        if (aT !== null && bT !== null && !isNaN(aT) && !isNaN(bT)) {
            var ticks = Math.round(aT + frac * (bT - aT));
            try { var T = new Time(); T.ticks = String(ticks); return T; } catch (e) {}
            return ticks / TICKS_PER_SECOND;
        }
        var aS = (rawA && rawA.seconds !== undefined && rawA.seconds !== null) ? rawA.seconds : null;
        var bS = (rawB && rawB.seconds !== undefined && rawB.seconds !== null) ? rawB.seconds : null;
        if (aS !== null && bS !== null) {
            var sec = aS + frac * (bS - aS);
            try { var T2 = new Time(); T2.seconds = sec; return T2; } catch (e2) {}
            return sec;
        }
        return null;
    }

    function keyFormat(rawA) {
        if (typeof rawA === "number") return "num";
        if (rawA && rawA.ticks !== undefined && rawA.ticks !== null) return "ticks";
        if (rawA && rawA.seconds !== undefined && rawA.seconds !== null) return "secs";
        return typeof rawA;
    }

    // ---- undo snapshot / restore ----------------------------------------

    // Capture a param's full keyframe state (times, values, interpolation) so it
    // can be rewritten verbatim later. Keeps a live reference to the param.
    function snapshotParam(param, label) {
        var snap = { param: param, label: label || "", timeVarying: false, keys: [] };
        try { snap.timeVarying = param.isTimeVarying(); } catch (e) {}
        if (snap.timeVarying) {
            try {
                var keys = param.getKeys();
                for (var i = 0; i < keys.length; i++) {
                    var raw = keys[i];
                    var val = null, interp = null;
                    try { val = param.getValueAtKey(raw); } catch (e2) {}
                    try {
                        if (typeof param.getInterpolationTypeAtKey === "function") {
                            interp = param.getInterpolationTypeAtKey(raw);
                        }
                    } catch (e3) { interp = null; }
                    snap.keys.push({ raw: raw, value: val, interp: interp });
                }
            } catch (e4) {}
        }
        return snap;
    }

    // Rewrite a param to exactly the snapshot state: remove every current key,
    // then re-create the snapshot's keys/values/interpolation.
    function restoreParam(snap) {
        var param = snap.param;
        // remove all current keys (back to front)
        try {
            var cur = param.getKeys();
            for (var i = cur.length - 1; i >= 0; i--) {
                try { param.removeKey(cur[i]); } catch (e) {}
            }
        } catch (e5) {}

        if (!snap.timeVarying) {
            try { param.setTimeVarying(false); } catch (e6) {}
            return true;
        }

        var last = snap.keys.length - 1;
        for (var j = 0; j < snap.keys.length; j++) {
            var k = snap.keys[j];
            var ui = (j === last) ? DO_UI : NO_UI;
            try { param.addKey(k.raw); } catch (eAdd) {}
            try { param.setValueAtKey(k.raw, k.value, ui); } catch (eSet) {}
            if (k.interp !== null && k.interp !== undefined) {
                try { param.setInterpolationTypeAtKey(k.raw, k.interp, NO_UI); } catch (eInt) {}
            }
        }
        return true;
    }

    // Bake the curve onto ONE segment (the keyframe pair at the playhead).
    // SAFE: never removes the two endpoint keyframes — it only removes previously
    // baked interior keys and adds new interior keys between your endpoints. Worst
    // case (a write fails) your original keyframes are still intact.
    function bakeParam(param, curve, seq, item) {
        var report = { applied: false, reason: "" };

        var timeVarying = false;
        try { timeVarying = param.isTimeVarying(); } catch (e) {}
        if (!timeVarying) { report.reason = "no keyframes"; return report; }

        var keys;
        try { keys = param.getKeys(); } catch (e) { keys = null; }
        if (!keys || keys.length < 2) { report.reason = "needs 2+ keyframes"; return report; }

        var seg = pickSegment(keys, seq, item);
        if (!seg) { report.reason = "no segment"; return report; }

        var aRaw = seg.a.raw, bRaw = seg.b.raw;
        var aNum = seg.a.n, bNum = seg.b.n;
        var fmt = keyFormat(aRaw);
        if (aNum === null || bNum === null || isNaN(aNum) || isNaN(bNum) || bNum <= aNum) {
            report.reason = "unreadable key times [" + fmt + "]"; return report;
        }

        // endpoint values (use RAW keys so reads always hit the right keyframe)
        var vStart, vEnd;
        try { vStart = param.getValueAtKey(aRaw); } catch (e) { report.reason = "read start failed"; return report; }
        try { vEnd = param.getValueAtKey(bRaw); } catch (e) { report.reason = "read end failed"; return report; }

        // Remove ONLY previously-baked interior keys (strictly between endpoints).
        // Endpoints are never touched, so keyframes can't be lost.
        for (var k = 0; k < seg.list.length; k++) {
            var kn = seg.list[k].n;
            if (kn > aNum + 1e-6 && kn < bNum - 1e-6) {
                try { param.removeKey(seg.list[k].raw); } catch (e3) {}
            }
        }

        // Add interior curve points between the endpoints (skip t=0 and t=1).
        var count = 0;
        for (var c = 0; c < curve.length; c++) {
            var pt = curve[c];
            if (pt.t <= 1e-4 || pt.t >= 1 - 1e-4) continue;
            var time = interpTime(aRaw, bRaw, pt.t);
            if (time === null) continue;
            var value = lerp(vStart, vEnd, pt.v);
            try { param.addKey(time); } catch (eAdd) {}
            try { param.setValueAtKey(time, value, NO_UI); setKeyLinear(param, time); count++; } catch (eSet) {}
        }

        // Endpoints: keep their positions, set them linear, and do the single UI
        // refresh here (also re-asserts their values in case anything shifted).
        try { param.setValueAtKey(aRaw, vStart, NO_UI); param.setInterpolationTypeAtKey(aRaw, KF.LINEAR, NO_UI); } catch (e4) {}
        try { param.setValueAtKey(bRaw, vEnd, DO_UI); param.setInterpolationTypeAtKey(bRaw, KF.LINEAR, NO_UI); } catch (e5) {}

        report.applied = true; // endpoints preserved regardless
        report.reason = count + " interp keys [" + fmt + "]" +
            (seg.multi ? " (seg " + (seg.idx + 1) + "/" + (seg.list.length - 1) + " @ playhead)" : "");
        report.keys = count;
        report.fmt = fmt;
        return report;
    }

    // Native mode: keep the user's existing keyframes, just switch them to a
    // smooth bezier ease. No keyframes are added. This is Premiere's own ease
    // system — clean and hand-editable — but the exact drawn curve shape/influence
    // can't be scripted, so it's a smart ease rather than your literal bezier.
    //
    // The panel derives the curve's shape and passes easeStart / easeEnd flags:
    //   both  -> Ease In-Out  (first & last keyframe bezier)
    //   start -> Ease In      (only the first keyframe bezier; end stays snappy)
    //   end   -> Ease Out     (only the last keyframe bezier; start stays snappy)
    //   none  -> Linear
    function easeParamNative(param, opts, seq, item) {
        var report = { applied: false, reason: "" };
        var easeStart = opts && opts.easeStart;
        var easeEnd = opts && opts.easeEnd;

        var timeVarying = false;
        try { timeVarying = param.isTimeVarying(); } catch (e) {}
        if (!timeVarying) { report.reason = "no keyframes"; return report; }

        var keys;
        try { keys = param.getKeys(); } catch (e) { keys = null; }
        if (!keys || keys.length < 2) { report.reason = "needs 2+ keyframes"; return report; }

        var seg = pickSegment(keys, seq, item);
        if (!seg) { report.reason = "no segment"; return report; }

        // Set interpolation on just this segment's two keyframes. Pass the RAW
        // key value straight back to Premiere (no seconds conversion) so it lands
        // on the right keyframe regardless of the time domain getKeys() uses.
        var typeStart = easeStart ? BEZIER_INTERP : KF.LINEAR;
        var typeEnd = easeEnd ? BEZIER_INTERP : KF.LINEAR;
        var n = 0;
        try { param.setInterpolationTypeAtKey(seg.a.raw, typeStart, NO_UI); n++; } catch (e) {}
        try { param.setInterpolationTypeAtKey(seg.b.raw, typeEnd, DO_UI); n++; } catch (e) {}

        report.applied = n > 0;
        report.reason = report.applied
            ? ("eased " + n + " keyframes" + (seg.multi ? " (segment @ playhead)" : ""))
            : "set interpolation failed";
        report.keys = n;
        return report;
    }

    // ---- public API ------------------------------------------------------

    function ping() {
        return "MotionEase " + VERSION;
    }

    function getSelectionInfo() {
        var seq = activeSeq();
        var info = { clips: 0, sequence: seq ? seq.name : "" };
        if (!seq) return JSON.stringify(info);
        info.clips = getSelectedItems(seq).length;
        return JSON.stringify(info);
    }

    // Scan the selected clip and report, per target property, whether it exists
    // and whether it currently has keyframes — plus every effect component that
    // holds keyed params (Transform, third-party plugins). Drives the panel's
    // per-property keyframe indicators.
    function scanSelection() {
        var seq = activeSeq();
        var out = {
            clips: 0,
            sequence: seq ? seq.name : "",
            props: {
                position: { present: false, keyed: false, keys: 0 },
                scale:    { present: false, keyed: false, keys: 0 },
                rotation: { present: false, keyed: false, keys: 0 },
                opacity:  { present: false, keyed: false, keys: 0 }
            },
            effects: [],   // [{ name, params:[{name, keys}] }] components with keyed params
            anyKeyed: 0
        };
        if (!seq) return JSON.stringify(out);

        var items = getSelectedItems(seq);
        out.clips = items.length;
        if (!items.length) return JSON.stringify(out);

        var comps = items[0].components;
        if (comps) {
            for (var ci = 0; ci < comps.numItems; ci++) {
                var comp = comps[ci];
                var compName; try { compName = comp.displayName; } catch (e) { compName = "Effect"; }
                var params = comp.properties;
                if (!params) continue;
                var effEntry = null;
                for (var pi = 0; pi < params.numItems; pi++) {
                    var param = params[pi];
                    var name; try { name = param.displayName; } catch (e2) { name = ""; }
                    var keys = paramKeyCount(param);
                    if (keys >= 2) out.anyKeyed++;

                    var id = targetIdForName(name);
                    if (id && out.props[id]) {
                        out.props[id].present = true;
                        if (keys > out.props[id].keys) out.props[id].keys = keys;
                        if (keys >= 2) out.props[id].keyed = true;
                    }
                    if (keys >= 2) {
                        if (!effEntry) effEntry = { name: compName, params: [] };
                        effEntry.params.push({ name: name, keys: keys });
                    }
                }
                if (effEntry && effEntry.params.length) out.effects.push(effEntry);
            }
        }
        return JSON.stringify(out);
    }

    function apply(payloadJson) {
        var result = { ok: false, applied: 0, message: "", details: [] };
        try {
            var payload = JSON.parse(payloadJson);
            var seq = activeSeq();
            if (!seq) { result.message = "No active sequence."; return JSON.stringify(result); }

            var items = getSelectedItems(seq);
            if (!items.length) { result.message = "No clips selected."; return JSON.stringify(result); }

            var curve = payload.curve;
            var method = payload.method || (payload.dense ? "bake" : "native");
            if (method === "bake" && (!curve || !curve.length)) {
                result.message = "No curve data."; return JSON.stringify(result);
            }

            var wanted = payload.props || [];
            var anyKeyed = !!payload.anyKeyed;   // also ease any keyframed effect param
            var applied = 0, skipped = 0;

            // native ease shape; default to Ease In-Out if the panel sent nothing
            var easeOpts = {
                easeStart: payload.easeStart === undefined ? true : !!payload.easeStart,
                easeEnd: payload.easeEnd === undefined ? true : !!payload.easeEnd
            };

            var diag = "";
            var snapshotSet = [];   // undo entry for this Apply
            for (var i = 0; i < items.length; i++) {
                var props = collectProps(items[i], wanted, anyKeyed);
                for (var p = 0; p < props.length; p++) {
                    // snapshot BEFORE modifying so Restore can put it back
                    snapshotSet.push(snapshotParam(props[p].param, props[p].comp + " › " + props[p].name));
                    var rep = (method === "bake")
                        ? bakeParam(props[p].param, curve, seq, items[i])
                        : easeParamNative(props[p].param, easeOpts, seq, items[i]);
                    if (!diag && rep.fmt) diag = rep.fmt;
                    result.details.push(props[p].comp + " › " + props[p].name + ": " + rep.reason);
                    if (rep.applied) applied++; else skipped++;
                }
            }

            if (applied > 0 && snapshotSet.length) {
                undoStack.push(snapshotSet);
                if (undoStack.length > UNDO_LIMIT) undoStack.shift();
            }

            result.applied = applied;
            result.diag = diag;
            result.canUndo = undoStack.length;
            if (applied > 0) {
                result.ok = true;
                result.message = "Eased " + applied + " propert" + (applied > 1 ? "ies" : "y") +
                    (skipped ? " (" + skipped + " skipped)" : "") +
                    (diag ? " · keys:" + diag : "");
            } else {
                result.message = "No easable properties. Set a start and end keyframe first.";
            }
        } catch (err) {
            result.message = "Error: " + err.toString();
        }
        return JSON.stringify(result);
    }

    // Undo the most recent Apply: pop the last snapshot set and rewrite each
    // property to its pre-Apply keyframe state.
    function restoreLast() {
        var result = { ok: false, message: "", remaining: undoStack.length };
        if (!undoStack.length) {
            result.message = "Nothing to undo.";
            return JSON.stringify(result);
        }
        var set = undoStack.pop();
        var restored = 0;
        for (var i = 0; i < set.length; i++) {
            try { if (restoreParam(set[i])) restored++; } catch (e) {}
        }
        result.ok = restored > 0;
        result.remaining = undoStack.length;
        result.message = restored > 0
            ? ("Restored " + restored + " propert" + (restored > 1 ? "ies" : "y"))
            : "Restore failed.";
        return JSON.stringify(result);
    }

    function undoCount() { return String(undoStack.length); }

    return {
        ping: ping,
        getSelectionInfo: getSelectionInfo,
        scanSelection: scanSelection,
        apply: apply,
        restoreLast: restoreLast,
        undoCount: undoCount
    };
})();

// Expose bare functions too, in case evalScript targets the global scope.
function ME_ping() { return MotionEase.ping(); }
function ME_getSelectionInfo() { return MotionEase.getSelectionInfo(); }
function ME_scanSelection() { return MotionEase.scanSelection(); }
function ME_apply(p) { return MotionEase.apply(p); }
function ME_restoreLast() { return MotionEase.restoreLast(); }
