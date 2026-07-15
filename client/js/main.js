/*
 * main.js — panel controller. Wires the graph editor, presets, live preview
 * and the Apply action that hands a sampled curve to the ExtendScript host.
 */
(function () {
    "use strict";

    var cs = new CSInterface();
    var hostReady = cs.isHostAvailable();

    var els = {
        status: document.getElementById("hostStatus"),
        readout: document.getElementById("readout"),
        propAll: document.getElementById("propAll"),
        propGrid: document.getElementById("propGrid"),
        selectionHint: document.getElementById("selectionHint"),
        presetScroll: document.getElementById("presetScroll"),
        savePresetBtn: document.getElementById("savePresetBtn"),
        applyBtn: document.getElementById("applyBtnMain"),
        undoBtn: document.getElementById("undoBtn"),
        densWrap: document.getElementById("densWrap"),
        densInput: document.getElementById("densInput"),
        segMode: document.getElementById("segMode"),
        densMinus: document.getElementById("densMinus"),
        densPlus: document.getElementById("densPlus"),
        modeCaption: document.getElementById("modeCaption"),
        anyKeyed: document.getElementById("anyKeyed"),
        effectsLine: document.getElementById("effectsLine"),
        replayBtn: document.getElementById("replayBtn"),
        toast: document.getElementById("toast")
    };

    var previews = {
        position: document.getElementById("pvPosition"),
        scale: document.getElementById("pvScale"),
        rotation: document.getElementById("pvRotation"),
        opacity: document.getElementById("pvOpacity")
    };

    // Derive the ease shape from the curve: is the start slow? the end slow?
    // Compares endpoint velocity against the curve's peak velocity.
    function computeEase(cp) {
        var vel = Bezier.sampleVelocity(cp, 60);
        var peak = vel.peak || 1e-9;
        var pts = vel.points;
        var startRatio = pts[0].v / peak;
        var endRatio = pts[pts.length - 1].v / peak;
        var easeStart = startRatio < 0.55;   // starts noticeably slower than peak
        var easeEnd = endRatio < 0.55;       // ends noticeably slower than peak
        var label = easeStart && easeEnd ? "In-Out"
                  : easeStart ? "In"
                  : easeEnd ? "Out"
                  : "Linear";
        return { easeStart: easeStart, easeEnd: easeEnd, label: label };
    }

    // ---- graph --------------------------------------------------------------
    var editor = new GraphEditor(document.getElementById("graph"), {
        cp: [0.42, 0.0, 0.58, 1.0],
        onChange: function (cp) {
            els.readout.textContent =
                "cubic-bezier(" + cp.map(function (n) { return n.toFixed(2); }).join(", ") + ")";
            markActivePreset(cp);
        }
    });
    editor.onChange(editor.cp, editor.mode);

    // ---- mode tabs ----------------------------------------------------------
    document.querySelectorAll(".seg-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
            document.querySelectorAll(".seg-btn").forEach(function (b) { b.classList.remove("active"); });
            btn.classList.add("active");
            editor.setMode(btn.dataset.mode);
        });
    });

    // ---- property checkboxes ------------------------------------------------
    function propBoxes() {
        return Array.prototype.slice.call(els.propGrid.querySelectorAll("input[type=checkbox]"));
    }
    els.propAll.addEventListener("change", function () {
        propBoxes().forEach(function (b) { b.checked = els.propAll.checked; });
    });
    propBoxes().forEach(function (b) {
        b.addEventListener("change", function () {
            els.propAll.checked = propBoxes().every(function (x) { return x.checked; });
        });
    });
    function selectedProps() {
        return propBoxes().filter(function (b) { return b.checked; })
            .map(function (b) { return b.dataset.prop; });
    }

    // ---- presets ------------------------------------------------------------
    function drawThumb(canvas, cp) {
        var ctx = canvas.getContext("2d");
        var dpr = window.devicePixelRatio || 1;
        var w = canvas.clientWidth || 60;
        var h = canvas.clientHeight || w;
        if (w < 10) w = 60;
        if (h < 10) h = w;
        canvas.width = w * dpr; canvas.height = h * dpr;
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, h);
        var pad = 6;
        var ease = Bezier.CubicBezier(cp);

        // helper: map curve coords → canvas pixels
        function toCanvas(cx, cy) {
            return {
                x: pad + cx * (w - pad * 2),
                y: h - pad - ((cy + 0.3) / 1.6) * (h - pad * 2)
            };
        }

        // orange tangent lines (from anchors to control points)
        var a0 = toCanvas(0, 0), a1 = toCanvas(1, 1);
        var h1 = toCanvas(cp[0], cp[1]), h2 = toCanvas(cp[2], cp[3]);
        ctx.strokeStyle = "rgba(232,145,45,0.7)";
        ctx.lineWidth = 1.5;
        ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(a0.x, a0.y); ctx.lineTo(h1.x, h1.y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(a1.x, a1.y); ctx.lineTo(h2.x, h2.y); ctx.stroke();

        // white curve
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = 2;
        ctx.lineJoin = "round";
        ctx.beginPath();
        for (var i = 0; i <= 40; i++) {
            var x = i / 40;
            var pt = toCanvas(x, ease(x));
            if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
        }
        ctx.stroke();
    }

    function renderPresets() {
        els.presetScroll.innerHTML = "";
        var list = Presets.BUILTIN.concat(
            Presets.loadUser().map(function (u, i) { u._userIndex = i; return u; })
        );
        list.forEach(function (preset) {
            var el = document.createElement("div");
            el.className = "preset";
            el.dataset.cp = preset.cp.join(",");
            el.title = preset.name + " — cubic-bezier(" +
                preset.cp.map(function (n) { return (+n).toFixed(2); }).join(", ") + ")" +
                (preset.user ? " (your preset)" : "") + "\nClick to load";
            el.innerHTML =
                '<canvas></canvas><span>' + escapeHtml(preset.name) + "</span>" +
                (preset.user ? '<span class="del" title="Delete this preset">×</span>' : "");
            els.presetScroll.appendChild(el);
            drawThumb(el.querySelector("canvas"), preset.cp);
            el.addEventListener("click", function (e) {
                if (e.target.classList.contains("del")) {
                    Presets.removeUser(preset._userIndex);
                    renderPresets();
                    return;
                }
                editor.setCp(preset.cp);
            });
        });
        markActivePreset(editor.cp);
    }

    function markActivePreset(cp) {
        var key = cp.map(function (n) { return n.toFixed(2); }).join(",");
        els.presetScroll.querySelectorAll(".preset").forEach(function (el) {
            var pk = el.dataset.cp.split(",").map(function (n) { return parseFloat(n).toFixed(2); }).join(",");
            el.classList.toggle("active", pk === key);
        });
    }

    els.savePresetBtn.addEventListener("click", function () {
        var name = window.prompt("Name this preset:", "My Ease");
        if (!name) return;
        Presets.addUser(name.trim().slice(0, 18), editor.cp);
        renderPresets();
        toast("Preset saved", "ok");
    });

    // ---- live preview -------------------------------------------------------
    var DUR = 1150, HOLD = 350;
    var t0 = null, dir = 1;
    function loop(ts) {
        if (t0 === null) t0 = ts;
        var elapsed = ts - t0;
        var cycle = DUR + HOLD;
        var p = Math.min(elapsed / DUR, 1);
        var ease = Bezier.CubicBezier(editor.cp);
        var e = ease(p);
        previews.position.style.transform = "translateX(" + ((e - 0.5) * 70) + "px)";
        previews.scale.style.transform = "scale(" + (0.45 + e * 0.7) + ")";
        previews.rotation.style.transform = "rotate(" + (e * 200) + "deg)";
        previews.opacity.style.opacity = String(0.12 + e * 0.88);
        if (elapsed >= cycle) { t0 = ts; }
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
    els.replayBtn.addEventListener("click", function () { t0 = null; });

    // ---- apply mode (Smooth vs Minimal — both bake, differ in density) ------
    function currentMode() {
        var checked = document.querySelector('input[name="applyMode"]:checked');
        return checked ? checked.value : "smooth";
    }
    function syncMode() {
        els.modeCaption.textContent = currentMode() === "minimal"
            ? "Only a few keyframes — cleaner & lighter, still traces your curve."
            : "A smooth set of keyframes tracing your exact curve. Best fidelity.";
    }
    Array.prototype.forEach.call(document.querySelectorAll('input[name="applyMode"]'), function (r) {
        r.addEventListener("change", function () {
            var d = r.getAttribute("data-density");
            if (r.checked && d) els.densInput.value = d;   // preset the kf count
            syncMode();
        });
    });
    syncMode();

    // custom stepper for the keyframe-count field (native spinner is hidden)
    function clampDens(v) { return Math.max(3, Math.min(120, v)); }
    function nudgeDens(delta) {
        var v = clampDens((parseInt(els.densInput.value, 10) || 12) + delta);
        els.densInput.value = v;
    }
    els.densMinus.addEventListener("click", function () { nudgeDens(-2); });
    els.densPlus.addEventListener("click", function () { nudgeDens(2); });
    els.densInput.addEventListener("change", function () {
        els.densInput.value = clampDens(parseInt(els.densInput.value, 10) || 12);
    });

    function performApply() {
        var props = selectedProps();
        if (!props.length && !els.anyKeyed.checked) { toast("Pick a property, or tick keyframed effect props", "err"); return; }
        if (!hostReady) { toast("Not running inside Premiere Pro", "err"); return; }

        var density = Math.max(3, Math.min(120, parseInt(els.densInput.value, 10) || 12));
        var payload = {
            cp: editor.cp,
            mode: editor.mode,            // graph view: value | speed
            method: "bake",               // always bake — the reliable path in Premiere
            props: props,
            anyKeyed: !!els.anyKeyed.checked,   // also ease keyframed effect params
            // which of YOUR keyframe pairs to bake between (baked keys don't count)
            segment: els.segMode ? els.segMode.value : "playhead",
            samples: density,
            // adaptive: keyframes only where the curve bends, error-bounded,
            // capped at the kf field. Minimal mode just uses a lower cap.
            curve: Bezier.sampleCurveAdaptive(editor.cp, { tol: 0.006, maxPoints: density, minPoints: 3 })
        };
        var payloadStr = JSON.stringify(payload);
        
        els.applyBtn.disabled = true;
        els.applyBtn.textContent = "Applying…";

        cs.evalScript("FrameFlow.apply(" + JSON.stringify(payloadStr) + ")", function (res) {
            els.applyBtn.disabled = false;
            els.applyBtn.textContent = "Apply Ease";
            handleHostResult(res);
        });
    }

    els.applyBtn.addEventListener("click", performApply);

    function handleHostResult(res) {
        var r;
        try { r = JSON.parse(res); } catch (e) { r = null; }
        if (!r) { toast("Host error: " + String(res).slice(0, 80), "err"); return; }
        if (r.ok) {
            toast(r.message || ("Applied to " + r.applied + " properties"), "ok");
        } else {
            toast(r.message || "Nothing to apply", "err");
        }
        if (typeof r.canUndo === "number") setUndoEnabled(r.canUndo > 0);
    }

    // ---- undo / restore -----------------------------------------------------
    function setUndoEnabled(on) { els.undoBtn.disabled = !on; }

    function restoreLast() {
        if (!hostReady || els.undoBtn.disabled) return;
        els.undoBtn.disabled = true;
        cs.evalScript("FrameFlow.restoreLast()", function (res) {
            var r; try { r = JSON.parse(res); } catch (e) { r = null; }
            if (!r) { toast("Restore error", "err"); return; }
            toast(r.message || (r.ok ? "Restored" : "Nothing to undo"), r.ok ? "ok" : "err");
            setUndoEnabled(r.remaining > 0);
        });
    }
    els.undoBtn.addEventListener("click", restoreLast);
    // Ctrl/Cmd+Z inside the panel = restore last Apply
    document.addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
            e.preventDefault();
            restoreLast();
        }
    });

    // ---- selection polling --------------------------------------------------
    function setDot(prop, state) {
        var dot = els.propGrid.querySelector('.kf-dot[data-dot="' + prop + '"]');
        if (dot) dot.className = "kf-dot " + state;
    }
    function clearDots(state) {
        ["position", "scale", "rotation", "opacity"].forEach(function (p) { setDot(p, state); });
    }

    function pollSelection() {
        if (!hostReady) return;
        cs.evalScript("FrameFlow.scanSelection()", function (res) {
            var r; try { r = JSON.parse(res); } catch (e) { r = null; }
            if (!r) return;

            if (!r.clips) {
                els.selectionHint.textContent = "Select a clip with 2+ keyframes, then Apply.";
                els.effectsLine.textContent = "";
                clearDots("");
                return;
            }

            els.selectionHint.textContent =
                r.clips + " clip" + (r.clips > 1 ? "s" : "") + " selected" +
                (r.sequence ? " · " + r.sequence : "");

            // per-property keyframe dots: green=animated, dim=present, hollow=absent
            var p = r.props || {};
            ["position", "scale", "rotation", "opacity"].forEach(function (prop) {
                var s = p[prop] || {};
                setDot(prop, s.keyed ? "keyed" : (s.present ? "none" : "absent"));
            });

            // list effects/components that hold keyframes (Transform, 3rd-party)
            var eff = r.effects || [];
            if (eff.length) {
                var parts = eff.map(function (e) {
                    return e.name + " (" + e.params.map(function (x) { return x.name; }).join(", ") + ")";
                });
                els.effectsLine.textContent = "Keyframed: " + parts.join("  ·  ");
            } else {
                els.effectsLine.textContent = "";
            }
        });
    }

    // ---- host status --------------------------------------------------------
    function initHost() {
        if (!hostReady) {
            els.status.className = "status err";
            els.status.innerHTML = '<span class="dot"></span> Preview mode (no host)';
            els.selectionHint.textContent = "Open this panel inside Premiere Pro to apply curves.";
            return;
        }
        cs.evalScript("FrameFlow.ping()", function (res) {
            var ok = String(res).indexOf("FrameFlow") >= 0;
            els.status.className = ok ? "status ok" : "status err";
            els.status.innerHTML = '<span class="dot"></span> ' + (ok ? "Connected" : "Host not responding");
            if (ok) {
                pollSelection();
                setInterval(pollSelection, 1500);
                // sync undo button with any history the host still holds
                cs.evalScript("FrameFlow.undoCount()", function (c) {
                    setUndoEnabled(parseInt(c, 10) > 0);
                });
            }
        });
    }

    // ---- utils --------------------------------------------------------------
    var toastTimer = null;
    function toast(msg, kind) {
        els.toast.textContent = msg;
        els.toast.className = "toast show " + (kind || "");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { els.toast.className = "toast " + (kind || ""); }, 6000);
    }
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
        });
    }

    // ---- boot ---------------------------------------------------------------
    renderPresets();
    initHost();
})();
