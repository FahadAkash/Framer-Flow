/**********************************************************************
 * FrameFlow.jsx — ExtendScript host for the FrameFlow panel.
 *
 * Exposes three entry points the panel calls via CSInterface.evalScript:
 *   FrameFlow.ping()               -> "FrameFlow <version>"
 *   FrameFlow.getSelectionInfo()   -> JSON { clips, sequence }
 *   FrameFlow.apply(payloadJson)   -> JSON { ok, applied, message, details }
 *
 * apply() picks ONE pair of your hand-placed keyframes (an "anchor pair") and
 * bakes a dense set of keyframes between them following the shaped curve.
 * Dense baking reproduces the exact motion regardless of Premiere's limited
 * bezier-handle API — the value graph you drew is the value graph you get.
 *
 * Because a bake fills the pair with interior keys, later Applies must be able
 * to tell YOUR keyframes from the ones we baked — otherwise every adjacent pair
 * looks like a candidate segment and Apply lands on a 2-frame sliver. bakedReg
 * records what we created; anchorsOf() subtracts it to recover your keyframes.
 **********************************************************************/

//@include "./lib/json2.jsx"

var FrameFlow = (function () {
    "use strict";

    var VERSION = "1.2";

    // Undo history: each Apply pushes a set of per-property snapshots taken
    // BEFORE it modified anything. restoreLast() pops and rewrites them. The
    // ExtendScript engine is persistent across evalScript calls, so live param
    // references and this stack survive between panel calls.
    var undoStack = [];
    var UNDO_LIMIT = 25;

    // Baked-key registry: paramKey -> [numeric raw key times FrameFlow created].
    // Without this, a second Apply can't tell YOUR keyframes apart from the dozen
    // interior keys the first Apply baked between them — every adjacent pair looks
    // like a segment and the pair you actually drew no longer exists. Subtracting
    // this set from getKeys() leaves the ANCHORS: the keyframes you placed by hand.
    // Lives in the persistent ExtendScript engine, so it survives panel calls.
    var bakedReg = {};

    // Premiere keyframe interpolation constants (setInterpolationTypeAtKey).
    // Types shown in the keyframe right-click menu: Linear, Bezier, Auto Bezier,
    // Continuous Bezier, Hold.
    var KF = { LINEAR: 0, HOLD: 1, BEZIER: 2, TIME: 3 };

    // Interpolation applied to every baked keyframe so the motion is smooth and
    // consistent (instead of faceted Linear). If motion ever FREEZES between
    // keys, this landed on Hold on your version — change to KF.LINEAR.
    var BAKE_INTERP = KF.BEZIER;

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

    // ---- baked-key registry ----------------------------------------------

    // Stable identity for a TrackItem, so the registry survives re-selection.
    function itemKey(item) {
        try { if (item.nodeId) return String(item.nodeId); } catch (e) {}
        var n = ""; try { n = item.name; } catch (e2) {}
        var s = ""; try { s = String(timeToSeconds(item.start)); } catch (e3) {}
        return n + "@" + s;
    }

    // Key times come back from getKeys() as the same floats we stored, but ticks
    // are ~2.5e11/second so compare with a relative epsilon rather than ==.
    function sameTime(a, b) {
        return Math.abs(a - b) <= Math.max(1e-9, Math.abs(a) * 1e-9);
    }

    function isBaked(pkey, n) {
        var list = bakedReg[pkey];
        if (!list) return false;
        for (var i = 0; i < list.length; i++) if (sameTime(list[i], n)) return true;
        return false;
    }

    // Record the keys that now sit strictly between two anchors as OUR bake, using
    // the times Premiere actually snapped them to (re-read, not the times we asked
    // for). Replaces any earlier record for the same span so re-baking is clean.
    function registerBaked(param, pkey, aNum, bNum) {
        var kept = [];
        var prev = bakedReg[pkey] || [];
        for (var i = 0; i < prev.length; i++) {
            if (!(prev[i] > aNum && prev[i] < bNum)) kept.push(prev[i]);
        }
        try {
            var keys = param.getKeys();
            for (var k = 0; k < keys.length; k++) {
                var n = rawNum(keys[k]);
                if (n !== null && n > aNum + 1e-6 && n < bNum - 1e-6) kept.push(n);
            }
        } catch (e) {}
        bakedReg[pkey] = kept;
    }

    // ---- segment resolution ----------------------------------------------

    function sortedKeys(param) {
        var arr = [];
        var keys;
        try { keys = param.getKeys(); } catch (e) { return arr; }
        if (!keys) return arr;
        for (var i = 0; i < keys.length; i++) {
            var n = rawNum(keys[i]);
            if (n !== null) arr.push({ raw: keys[i], n: n });
        }
        arr.sort(function (x, y) { return x.n - y.n; });
        return arr;
    }

    // YOUR keyframes: every key minus the ones a previous Apply baked. If the
    // registry is empty (first Apply, or Premiere was restarted) this is just the
    // full list, which is the correct behaviour for un-baked keyframes.
    function anchorsOf(param, pkey) {
        var all = sortedKeys(param);
        if (!pkey || !bakedReg[pkey]) return all;
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (!isBaked(pkey, all[i].n)) out.push(all[i]);
        }
        return (out.length >= 2) ? out : all;
    }

    // Map the sequence playhead into the keyframes' own reference frame. Premiere
    // reports keyframe times clip-relative (inPoint + offset from clip start) on
    // most versions and sequence-relative on others, so try clip-relative FIRST —
    // the raw sequence time can coincidentally land inside a wide key range and
    // silently select the wrong segment.
    function playheadInKeyDomain(anchors, seq, item) {
        var P = playheadSeconds(seq);
        if (P === null) return null;

        var nums = [];
        for (var i = 0; i < anchors.length; i++) nums.push(anchors[i].n);
        var toSec = toSecondsFn(nums);
        var lo = toSec(anchors[0].n), hi = toSec(anchors[anchors.length - 1].n);

        var startSec = item ? timeToSeconds(item.start) : null;
        var inSec = item ? timeToSeconds(item.inPoint) : null;
        var cands = [];
        if (startSec !== null && inSec !== null) cands.push(P - startSec + inSec);
        if (startSec !== null) cands.push(P - startSec);
        cands.push(P);

        var best = null, bestD = Infinity;
        for (var c = 0; c < cands.length; c++) {
            var v = cands[c];
            if (v >= lo - 1e-3 && v <= hi + 1e-3) return { p: v, inRange: true, toSec: toSec };
            var d = (v < lo) ? (lo - v) : (v - hi);
            if (d < bestD) { bestD = d; best = v; }
        }
        return { p: best, inRange: false, toSec: toSec };
    }

    // Which anchor pair the playhead sits in. Half-open [a,b) so a playhead parked
    // exactly on a shared keyframe resolves forward instead of ambiguously; the
    // last segment is closed so a playhead on the final keyframe still matches.
    // When the playhead is outside every segment we pick the NEAREST one — never
    // blindly segment 0, which is what made every Apply hit the first two keys.
    function segmentIndexAtPlayhead(anchors, seq, item) {
        var last = anchors.length - 2;
        var ph = playheadInKeyDomain(anchors, seq, item);
        if (!ph || ph.p === null) return last;   // no playhead info -> newest segment

        var toSec = ph.toSec;
        var s, a, b;
        for (s = 0; s <= last; s++) {
            a = toSec(anchors[s].n); b = toSec(anchors[s + 1].n);
            var hit = (s === last) ? (ph.p <= b + 1e-3) : (ph.p < b - 1e-3);
            if (ph.p >= a - 1e-3 && hit) return s;
        }
        var bestIdx = last, bestD = Infinity;
        for (s = 0; s <= last; s++) {
            a = toSec(anchors[s].n); b = toSec(anchors[s + 1].n);
            var d = (ph.p < a) ? (a - ph.p) : (ph.p > b ? ph.p - b : 0);
            if (d < bestD) { bestD = d; bestIdx = s; }
        }
        return bestIdx;
    }

    // Resolve which anchor pair(s) an Apply should write to.
    //   playhead (default) -> the one segment the playhead is in
    //   last               -> the newest pair (highest times) — the two keys you just added
    //   first              -> the opening pair
    //   all                -> every anchor pair on the property
    function resolveSegments(param, pkey, seq, item, mode) {
        var anchors = anchorsOf(param, pkey);
        if (anchors.length < 2) return null;

        var segs = [];
        var last = anchors.length - 2;
        if (mode === "all") {
            for (var i = 0; i <= last; i++) segs.push(i);
        } else if (mode === "last") {
            segs.push(last);
        } else if (mode === "first") {
            segs.push(0);
        } else {
            segs.push(segmentIndexAtPlayhead(anchors, seq, item));
        }
        return { anchors: anchors, indices: segs, total: last + 1 };
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
    //   seq, item, segMode = segment context so anyKeyed custom params can be
    //              filtered to only those whose keyframes span the playhead.
    // Deduped by component:param identity so nothing is processed twice.
    function collectProps(item, wanted, anyKeyed, seq, segMode) {
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
                // anyKeyed should only pick up UNKNOWN (custom/3rd-party) params,
                // never re-include a known target the user explicitly unchecked.
                // Additionally, when segMode is 'playhead', only include custom
                // params whose keyframes actually span the playhead position.
                if (!include && anyKeyed && !id && paramKeyCount(param) >= 2) {
                    if (segMode === "playhead" && seq) {
                        // Check if the playhead is between this param's keyframes
                        var pkey = ci + ":" + pi;
                        var anch = anchorsOf(param, pkey);
                        if (anch.length >= 2) {
                            var ph = playheadInKeyDomain(anch, seq, item);
                            include = (ph && ph.inRange);
                        }
                    } else {
                        include = true;
                    }
                }
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

    // Set a keyframe's interpolation to the smooth bake type (auto-applied to
    // every baked keyframe so each one eases cleanly).
    function setKeySmooth(param, time) {
        try { param.setInterpolationTypeAtKey(time, BAKE_INTERP, false); } catch (e) {}
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

    // Read back a keyframe's interpolation type (for diagnostics), or "?".
    function readInterp(param, rawKey) {
        try {
            if (typeof param.getInterpolationTypeAtKey === "function") {
                return param.getInterpolationTypeAtKey(rawKey);
            }
        } catch (e) {}
        return "?";
    }

    // Set bezier interpolation on every real keyframe in [aNum,bNum]. Re-reads
    // getKeys() so we target the ACTUAL (frame-snapped) key times. Premiere's
    // kfInterpMode enum is Linear=0, Hold=1, Bezier=2, Time=3 — so BAKE_INTERP=2.
    // If a read-back API exists we confirm it stuck (and fall back to 3 if not).
    function applyBezierToSegment(param, aNum, bNum) {
        if (typeof param.setInterpolationTypeAtKey !== "function") return "noSetFn";
        var keys;
        try { keys = param.getKeys(); } catch (e) { return "noKeys"; }
        if (!keys) return "noKeys";

        var inRange = [];
        for (var i = 0; i < keys.length; i++) {
            var n = rawNum(keys[i]);
            if (n !== null && n >= aNum - 1e-6 && n <= bNum + 1e-6) inRange.push(keys[i]);
        }
        if (!inRange.length) return "0keys";

        var hasGet = (typeof param.getInterpolationTypeAtKey === "function");
        var target = BAKE_INTERP; // 2 = Bezier

        if (hasGet) {
            // confirm 2 sticks; if a version numbers it differently, try 3 then 4
            var order = [2, 3, 4];
            for (var c = 0; c < order.length; c++) {
                try { param.setInterpolationTypeAtKey(inRange[0], order[c], true); } catch (e2) { continue; }
                var got = null; try { got = param.getInterpolationTypeAtKey(inRange[0]); } catch (e3) {}
                if (got === order[c]) { target = order[c]; break; }
            }
        }

        for (var r = 0; r < inRange.length; r++) {
            var ui = (r === inRange.length - 1);
            try { param.setInterpolationTypeAtKey(inRange[r], target, ui); } catch (e4) {}
        }
        return "set" + target + "x" + inRange.length + (hasGet ? "" : "(noverify)");
    }

    // ---- undo snapshot / restore ----------------------------------------

    // Capture a param's full keyframe state (times, values, interpolation) so it
    // can be rewritten verbatim later. Keeps a live reference to the param.
    function snapshotParam(param, label, pkey) {
        var snap = { param: param, label: label || "", pkey: pkey || "", timeVarying: false, keys: [], baked: null };
        // remember which keys were OURS before this Apply, so undo can put the
        // anchor/baked distinction back exactly as it was
        if (pkey && bakedReg[pkey]) {
            snap.baked = [];
            for (var b = 0; b < bakedReg[pkey].length; b++) snap.baked.push(bakedReg[pkey][b]);
        }
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

        // roll the baked-key registry back with the keyframes
        if (snap.pkey) {
            if (snap.baked === null) delete bakedReg[snap.pkey];
            else bakedReg[snap.pkey] = snap.baked;
        }

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
    // Bake the curve between ONE anchor pair. Removes only the keys strictly
    // between the two anchors (whether hand-placed or from an earlier bake), then
    // lays the curve down. The anchors themselves are never removed.
    function bakeSegment(param, curve, aItem, bItem) {
        var aRaw = aItem.raw, bRaw = bItem.raw;
        var aNum = aItem.n, bNum = bItem.n;
        var out = { ok: false, count: 0, fmt: keyFormat(aRaw), aNum: aNum, bNum: bNum };

        if (isNaN(aNum) || isNaN(bNum) || bNum <= aNum) { out.reason = "unreadable key times"; return out; }

        // endpoint values (use RAW keys so reads always hit the right keyframe)
        var vStart, vEnd;
        try { vStart = param.getValueAtKey(aRaw); } catch (e) { out.reason = "read start failed"; return out; }
        try { vEnd = param.getValueAtKey(bRaw); } catch (e) { out.reason = "read end failed"; return out; }

        // Clear the interior. Re-read so we see the CURRENT keys (a prior bake in
        // this same Apply may have changed them). Endpoints are excluded.
        var live = sortedKeys(param);
        for (var k = 0; k < live.length; k++) {
            if (live[k].n > aNum + 1e-6 && live[k].n < bNum - 1e-6) {
                try { param.removeKey(live[k].raw); } catch (e3) {}
            }
        }

        // Add interior curve points between the endpoints (skip t=0 and t=1).
        for (var c = 0; c < curve.length; c++) {
            var pt = curve[c];
            if (pt.t <= 1e-4 || pt.t >= 1 - 1e-4) continue;
            var time = interpTime(aRaw, bRaw, pt.t);
            if (time === null) continue;
            var value = lerp(vStart, vEnd, pt.v);
            try { param.addKey(time); } catch (eAdd) {}
            try { param.setValueAtKey(time, value, NO_UI); out.count++; } catch (eSet) {}
        }

        // re-assert endpoint values (they are never removed)
        try { param.setValueAtKey(aRaw, vStart, NO_UI); } catch (e4) {}
        try { param.setValueAtKey(bRaw, vEnd, DO_UI); } catch (e5) {}

        // Smooth bezier on the REAL key times (frame-snapped), auto-detecting the
        // interpolation constant this Premiere accepts.
        out.probe = applyBezierToSegment(param, aNum, bNum);
        out.ok = true; // endpoints preserved regardless
        return out;
    }

    function bakeParam(param, curve, seq, item, pkey, segMode) {
        var report = { applied: false, reason: "" };

        var timeVarying = false;
        try { timeVarying = param.isTimeVarying(); } catch (e) {}
        if (!timeVarying) { report.reason = "no keyframes"; return report; }

        var res = resolveSegments(param, pkey, seq, item, segMode);
        if (!res) { report.reason = "needs 2+ keyframes"; return report; }

        var total = 0, done = 0, labels = [];
        for (var s = 0; s < res.indices.length; s++) {
            var idx = res.indices[s];
            var out = bakeSegment(param, curve, res.anchors[idx], res.anchors[idx + 1]);
            if (!out.ok) { if (!report.reason) report.reason = out.reason; continue; }
            registerBaked(param, pkey, out.aNum, out.bNum);
            total += out.count;
            done++;
            labels.push(String(idx + 1));
            if (!report.fmt) report.fmt = out.fmt;
            if (!report.probe) report.probe = out.probe;
        }
        if (!done) { if (!report.reason) report.reason = "no segment"; return report; }

        report.applied = true;
        report.keys = total;
        report.reason = total + " interp keys [" + report.fmt + "]" +
            (res.total > 1 ? " (seg " + labels.join(",") + "/" + res.total + ")" : "");
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
    function easeParamNative(param, opts, seq, item, pkey, segMode) {
        var report = { applied: false, reason: "" };
        var easeStart = opts && opts.easeStart;
        var easeEnd = opts && opts.easeEnd;

        var timeVarying = false;
        try { timeVarying = param.isTimeVarying(); } catch (e) {}
        if (!timeVarying) { report.reason = "no keyframes"; return report; }

        var res = resolveSegments(param, pkey, seq, item, segMode);
        if (!res) { report.reason = "needs 2+ keyframes"; return report; }

        // Set interpolation on just this segment's two keyframes. Pass the RAW
        // key value straight back to Premiere (no seconds conversion) so it lands
        // on the right keyframe regardless of the time domain getKeys() uses.
        var typeStart = easeStart ? BEZIER_INTERP : KF.LINEAR;
        var typeEnd = easeEnd ? BEZIER_INTERP : KF.LINEAR;
        var n = 0, labels = [];
        for (var s = 0; s < res.indices.length; s++) {
            var idx = res.indices[s];
            var lastWrite = (s === res.indices.length - 1);
            try { param.setInterpolationTypeAtKey(res.anchors[idx].raw, typeStart, NO_UI); n++; } catch (e) {}
            try { param.setInterpolationTypeAtKey(res.anchors[idx + 1].raw, typeEnd, lastWrite ? DO_UI : NO_UI); n++; } catch (e2) {}
            labels.push(String(idx + 1));
        }

        report.applied = n > 0;
        report.reason = report.applied
            ? ("eased " + n + " keyframes" + (res.total > 1 ? " (seg " + labels.join(",") + "/" + res.total + ")" : ""))
            : "set interpolation failed";
        report.keys = n;
        return report;
    }

    // ---- public API ------------------------------------------------------

    function ping() {
        return "FrameFlow " + VERSION;
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

            // which keyframe pair(s) to write: playhead | last | first | all
            var segMode = payload.segment || "playhead";

            // native ease shape; default to Ease In-Out if the panel sent nothing
            var easeOpts = {
                easeStart: payload.easeStart === undefined ? true : !!payload.easeStart,
                easeEnd: payload.easeEnd === undefined ? true : !!payload.easeEnd
            };

            var diag = "";
            var probe = "";
            var snapshotSet = [];   // undo entry for this Apply
            for (var i = 0; i < items.length; i++) {
                var props = collectProps(items[i], wanted, anyKeyed, seq, segMode);
                var ik = itemKey(items[i]);
                for (var p = 0; p < props.length; p++) {
                    var pkey = ik + "|" + props[p].key;
                    // snapshot BEFORE modifying so Restore can put it back
                    snapshotSet.push(snapshotParam(props[p].param, props[p].comp + " › " + props[p].name, pkey));
                    var rep = (method === "bake")
                        ? bakeParam(props[p].param, curve, seq, items[i], pkey, segMode)
                        : easeParamNative(props[p].param, easeOpts, seq, items[i], pkey, segMode);
                    if (!diag && rep.fmt) diag = rep.fmt;
                    if (!probe && rep.probe) probe = rep.probe;
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
                    (diag ? " · keys:" + diag : "") +
                    (probe ? " · " + probe : "");
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
function FF_ping() { return FrameFlow.ping(); }
function FF_getSelectionInfo() { return FrameFlow.getSelectionInfo(); }
function FF_scanSelection() { return FrameFlow.scanSelection(); }
function FF_apply(p) { return FrameFlow.apply(p); }
function FF_restoreLast() { return FrameFlow.restoreLast(); }
