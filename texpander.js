// ==UserScript==
// @name         Texpander 2
// @version      3
// @description  PVP helper
// @match        *://*/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      docs.google.com
// @connect      googleusercontent.com
// @connect      *.googleusercontent.com
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      *.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    "use strict";

    var win = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    var hotkey = "r";

    var sheetUrl = "https://script.google.com/macros/s/AKfycbx09Y7F9ZqoUVQDfkFPGqsmnBfJht4EuFDa_8qiO6CUvB96ydnixTdo0PXeJaMgyj5i/exec";

    var NODE_ELEMENT = 1;
    var NODE_TEXT = 3;

    var tokenCharRegex = /[\p{L}\p{N}_]/u;

    var style = document.createElement("style");
    style.textContent =
        ".texpander-busy{position:relative}" +
        ".texpander-busy:after{" +
          "content:'';" +
          "position:absolute;" +
          "right:6px;" +
          "top:6px;" +
          "width:9px;" +
          "height:9px;" +
          "background:red;" +
          "border-radius:50%;" +
          "z-index:999999;" +
        "}";

    function requestText(url) {
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                onload: function (response) {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response.responseText);
                    } else {
                        reject(new Error("HTTP " + response.status));
                    }
                },
                onerror: function () {
                    reject(new Error("Request failed"));
                }
            });
        });
    }

    function parseTSV(text) {
        var rows = [];
        var row = [];
        var field = "";
        var inQuotes = false;
        var i;
        var c;

        for (i = 0; i < text.length; i++) {
            c = text.charAt(i);

            if (inQuotes) {
                if (c === "\"") {
                    if (text.charAt(i + 1) === "\"") {
                        field += "\"";
                        i++;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    field += c;
                }
            } else {
                if (c === "\"") {
                    inQuotes = true;
                } else if (c === "\t") {
                    row.push(field);
                    field = "";
                } else if (c === "\n") {
                    row.push(field);
                    rows.push(row);
                    row = [];
                    field = "";
                } else if (c !== "\r") {
                    field += c;
                }
            }
        }

        if (field !== "" || row.length > 0) {
            row.push(field);
            rows.push(row);
        }

        return rows;
    }

    function escapeRegExp(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function sortByLengthDesc(a, b) {
        return b.length - a.length;
    }

    function isTokenChar(c) {
        return tokenCharRegex.test(c);
    }

    function isPlainTokenKey(key) {
        var i;

        if (key === "") {
            return false;
        }

        for (i = 0; i < key.length; i++) {
            if (!isTokenChar(key.charAt(i))) {
                return false;
            }
        }

        return true;
    }

    function buildComplexRegex(keys) {
        var escapedKeys;

        if (keys.length === 0) {
            return null;
        }

        escapedKeys = keys.sort(sortByLengthDesc).map(escapeRegExp);

        return new RegExp(
            "(^|[^\\p{L}\\p{N}_])(" + escapedKeys.join("|") + ")(?=$|[^\\p{L}\\p{N}_])",
            "gu"
        );
    }

    function compileReplacements(rows) {
        var replacements = Object.create(null);
        var complexKeys = [];
        var plainCount = 0;
        var complexCount = 0;
        var i;
        var key;
        var value;
        var alreadyKnown;

        for (i = 0; i < rows.length; i++) {
            if (rows[i].length < 2) {
                continue;
            }

            key = rows[i][0].replace(/\u00a0/g, " ").trim();
            value = rows[i][1];

            if (key === "") {
                continue;
            }

            alreadyKnown = Object.prototype.hasOwnProperty.call(replacements, key);
            replacements[key] = value;

            if (alreadyKnown) {
                continue;
            }

            if (isPlainTokenKey(key)) {
                plainCount++;
            } else {
                complexKeys.push(key);
                complexCount++;
            }
        }

        return {
            replacements: replacements,
            complexRegex: buildComplexRegex(complexKeys),
            plainCount: plainCount,
            complexCount: complexCount
        };
    }

    function loadReplacements() {
        return requestText(sheetUrl).then(function (tsv) {
            var rows = parseTSV(tsv);
            var compiled = compileReplacements(rows);

            console.log(
                "TinyMCE expander loaded " +
                compiled.plainCount +
                " plain keys and " +
                compiled.complexCount +
                " complex keys"
            );

            return compiled;
        });
    }

    function appendExpandedTokenText(state, text, replacements) {
        var i = 0;
        var last = 0;
        var start;
        var token;
        var replacement;

        while (i < text.length) {
            if (!isTokenChar(text.charAt(i))) {
                i++;
                continue;
            }

            start = i;

            while (i < text.length && isTokenChar(text.charAt(i))) {
                i++;
            }

            token = text.slice(start, i);

            if (Object.prototype.hasOwnProperty.call(replacements, token)) {
                replacement = replacements[token];

                if (last < start) {
                    state.parts.push(text.slice(last, start));
                }

                state.parts.push(replacement);
                last = i;
                state.changed = true;
            }
        }

        if (last < text.length) {
            state.parts.push(text.slice(last));
        }
    }

    function expandText(text, compiled) {
        var replacements = compiled.replacements;
        var complexRegex = compiled.complexRegex;
        var state = {
            parts: [],
            changed: false
        };
        var match;
        var prefix;
        var key;
        var keyStart;
        var keyEnd;
        var last = 0;

        if (!complexRegex) {
            appendExpandedTokenText(state, text, replacements);

            if (!state.changed) {
                return null;
            }

            return state.parts.join("");
        }

        complexRegex.lastIndex = 0;

        while ((match = complexRegex.exec(text)) !== null) {
            prefix = match[1];
            key = match[2];

            keyStart = match.index + prefix.length;
            keyEnd = keyStart + key.length;

            if (last < keyStart) {
                appendExpandedTokenText(state, text.slice(last, keyStart), replacements);
            }

            state.parts.push(replacements[key]);
            state.changed = true;
            last = keyEnd;
        }

        if (last < text.length) {
            appendExpandedTokenText(state, text.slice(last), replacements);
        }

        if (!state.changed) {
            return null;
        }

        return state.parts.join("");
    }

    function shouldSkipElement(element) {
        var name;

        if (!element || element.nodeType !== NODE_ELEMENT) {
            return false;
        }

        name = element.nodeName.toLowerCase();

        if (name === "script" || name === "style" || name === "code" || name === "pre") {
            return true;
        }

        if (element.getAttribute && element.getAttribute("contenteditable") === "false") {
            return true;
        }

        return false;
    }

    function expandEditor(editor, compiled) {
        var body = editor.getBody();
        var stack = [];
        var node;
        var child;
        var oldText;
        var newText;
        var changed = 0;

        if (!body || !compiled) {
            return 0;
        }

        function doReplace() {
            stack.push(body);

            while (stack.length > 0) {
                node = stack.pop();

                if (node.nodeType === NODE_TEXT) {
                    oldText = node.nodeValue;
                    newText = expandText(oldText, compiled);

                    if (newText !== null) {
                        node.nodeValue = newText;
                        changed++;
                    }

                    continue;
                }

                if (node.nodeType !== NODE_ELEMENT) {
                    continue;
                }

                if (shouldSkipElement(node)) {
                    continue;
                }

                child = node.lastChild;

                while (child) {
                    stack.push(child);
                    child = child.previousSibling;
                }
            }
        }

        if (editor.undoManager && editor.undoManager.transact) {
            editor.undoManager.transact(doReplace);
        } else {
            doReplace();
        }

        if (changed > 0) {
            if (editor.nodeChanged) {
                editor.nodeChanged();
            }

            if (editor.setDirty) {
                editor.setDirty(true);
            }

            if (editor.save) {
                editor.save();
            }
        }

        return changed;
    }

    function setBusy(editor, on) {
        var container;

        if (!editor || !editor.getContainer) {
            return;
        }

        container = editor.getContainer();

        if (container && container.classList) {
            container.classList.toggle("texpander-busy", on);
        }
    }

    function expandWithSheet(editor) {
        if (!editor) {
            console.log("TinyMCE expander: no editor");
            return;
        }

        if (editor._texpanderBusy) {
            console.log("TinyMCE expander: already running");
            return;
        }

        editor._texpanderBusy = true;
        setBusy(editor, true);

        loadReplacements().then(function (compiled) {
            var changed = expandEditor(editor, compiled);

            if (changed === 0) {
                console.log("TinyMCE expander: nothing changed");
            } else {
                console.log("TinyMCE expander: changed " + changed + " text nodes");
            }
        }).catch(function (err) {
            console.log("TinyMCE expander: " + err.message);
        }).then(function () {
            editor._texpanderBusy = false;
            setBusy(editor, false);
        });
    }

    function isHotkey(event) {
        return event.ctrlKey &&
               event.altKey &&
               !event.shiftKey &&
               event.key &&
               event.key.toLowerCase() === hotkey;
    }

    function handleHotkey(event, editor) {
        var tiny;

        if (!isHotkey(event)) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        if (!editor) {
            tiny = win.tinymce || window.tinymce;

            if (tiny) {
                editor = tiny.activeEditor;
            }
        }

        expandWithSheet(editor);
    }

    function makeEditorKeydownHandler(editor) {
        return function (event) {
            handleHotkey(event, editor);
        };
    }

    function installEditorHotkeys() {
        var tiny = win.tinymce || window.tinymce;
        var editors;
        var i;

        if (!tiny || !tiny.editors) {
            return;
        }

        editors = tiny.editors;

        for (i = 0; i < editors.length; i++) {
            if (!editors[i] || editors[i]._texpanderHotkeyInstalled) {
                continue;
            }

            editors[i]._texpanderHotkeyInstalled = true;
            editors[i].on("keydown", makeEditorKeydownHandler(editors[i]));
        }
    }

    document.addEventListener("keydown", function (event) {
        handleHotkey(event, null);
    }, true);

    window.setInterval(installEditorHotkeys, 1000);

    if (document.head) {
        document.head.appendChild(style);
    } else {
        document.documentElement.appendChild(style);
    }
})();