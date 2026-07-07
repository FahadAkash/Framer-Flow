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

    // From a property's raw keyframe list, pick the ONE segment (adjacent pair)
    // that the playhead sits inside. This is how we scope an Apply to just the
    // two keyframes you're working on instead of the whole property. Returns
    // sorted { raw, n } entries plus the chosen a/b endpoints.
    function pickSegment(keys, seq) {
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
        var P = playheadSeconds(seq);

        var idx = -1;
        if (P !== null) {
            for (var s = 0; s < arr.length - 1; s++) {
                var a = toSec(arr[s].n), b = toSec(arr[s + 1].n);
                if (P >= a - 1e-4 && P <= b + 1e-4) { idx = s; break; }
            }
            if (idx < 0) { // playhead outside all segments -> nearest end segment
                idx = (P < toSec(arr[0].n)) ? 0 : arr.length - 2;
            }
        } else {
            idx = 0; // no playhead info: fall back to the first segment
        }

        return { list: arr, a: arr[idx], b: arr[idx + 1], multi: arr.length > 2 };
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

    // Bake the curve onto ONE segment (the keyframe pair at the playhead) of a
    // ComponentParam. Reads the segment's endpoint values, clears just that
    // segment, and rebuilds it from the curve — other segments are untouched.
    function bakeParam(param, curve, seq) {
        var report = { applied: false, reason: "" };

        var timeVarying = false;
        try { timeVarying = param.isTimeVarying(); } catch (e) {}
        if (!timeVarying) { report.reason = "no keyframes"; return report; }

        var keys;
        try { keys = param.getKeys(); } catch (e) { keys = null; }
        if (!keys || keys.length < 2) { report.reason = "needs 2+ keyframes"; return report; }

        var seg = pickSegment(keys, seq);
        if (!seg) { report.reason = "no segment"; return report; }

        var aRaw = seg.a.raw, bRaw = seg.b.raw;   // pass RAW back to Premiere
        var aNum = seg.a.n, bNum = seg.b.n;       // domain-native numbers for new keys
        if (bNum <= aNum) { report.reason = "zero-length segment"; return report; }

        // read endpoint values BEFORE we clear the segment (use RAW keys)
        var vStart, vEnd;
        try { vStart = param.getValueAtKey(aRaw); } catch (e) { report.reason = "read start failed"; return report; }
        try { vEnd = param.getValueAtKey(bRaw); } catch (e) { report.reason = "read end failed"; return report; }

        // clear only this segment, then rebuild from the curve (no UI redraw yet)
        try { param.removeKeyRange(aNum, bNum, NO_UI); } catch (e) {}

        var span = bNum - aNum;
        var count = 0;
        var lastIdx = curve.length - 1;
        for (var c = 0; c < curve.length; c++) {
            var pt = curve[c];
            var time = aNum + pt.t * span;         // stay in the key's own domain
            var value = lerp(vStart, vEnd, pt.v);
            var refresh = (c === lastIdx) ? DO_UI : NO_UI; // one redraw at the end
            try { param.addKey(time); } catch (eAdd) {}
            try {
                param.setValueAtKey(time, value, refresh);
                setKeyLinear(param, time);
                count++;
            } catch (eSet) {}
        }

        report.applied = count > 0;
        report.reason = report.applied
            ? (count + " keys" + (seg.multi ? " (segment @ playhead)" : ""))
            : "write failed";
        report.keys = count;
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
    function easeParamNative(param, opts, seq) {
        var report = { applied: false, reason: "" };
        var easeStart = opts && opts.easeStart;
        var easeEnd = opts && opts.easeEnd;

        var timeVarying = false;
        try { timeVarying = param.isTimeVarying(); } catch (e) {}
        if (!timeVarying) { report.reason = "no keyframes"; return report; }

        var keys;
        try { keys = param.getKeys(); } catch (e) { keys = null; }
        if (!keys || keys.length < 2) { report.reason = "needs 2+ keyframes"; return report; }

        var seg = pickSegment(keys, seq);
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

            for (var i = 0; i < items.length; i++) {
                var props = collectProps(items[i], wanted, anyKeyed);
                for (var p = 0; p < props.length; p++) {
                    var rep = (method === "bake")
                        ? bakeParam(props[p].param, curve, seq)
                        : easeParamNative(props[p].param, easeOpts, seq);
                    result.details.push(props[p].comp + " › " + props[p].name + ": " + rep.reason);
                    if (rep.applied) applied++; else skipped++;
                }
            }

            result.applied = applied;
            if (applied > 0) {
                result.ok = true;
                result.message = "Eased " + applied + " propert" + (applied > 1 ? "ies" : "y") +
                    (skipped ? " (" + skipped + " skipped — need 2+ keyframes)" : "");
            } else {
                result.message = "No easable properties. Set a start and end keyframe first.";
            }
        } catch (err) {
            result.message = "Error: " + err.toString();
        }
        return JSON.stringify(result);
    }

    return {
        ping: ping,
        getSelectionInfo: getSelectionInfo,
        scanSelection: scanSelection,
        apply: apply
    };
})();

// Expose bare functions too, in case evalScript targets the global scope.
function ME_ping() { return MotionEase.ping(); }
function ME_getSelectionInfo() { return MotionEase.getSelectionInfo(); }
function ME_scanSelection() { return MotionEase.scanSelection(); }
function ME_apply(p) { return MotionEase.apply(p); }
