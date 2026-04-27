// ==UserScript==
// @name         Texpander 2
// @version      2
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
    var hotkey = "k";

    var sheetUrl = "https://script.google.com/macros/s/AKfycbx09Y7F9ZqoUVQDfkFPGqsmnBfJht4EuFDa_8qiO6CUvB96ydnixTdo0PXeJaMgyj5i/exec";

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

        row.push(field);
        rows.push(row);

        return rows;
    }

    function loadReplacements() {
        return requestText(sheetUrl).then(function (tsv) {
            var rows = parseTSV(tsv);
            var replacements = {};
            var i;
            var key;
            var value;

            console.log("TinyMCE expander parsed rows:", rows);

            for (i = 0; i < rows.length; i++) {
                if (rows[i].length < 2) {
                    continue;
                }

                key = rows[i][0].replace(/\u00a0/g, " ").trim();
                value = rows[i][1];

                if (key !== "") {
                    replacements[key] = value;
                }
            }

            return replacements;
        });
    }

    function escapeRegExp(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function sortByLengthDesc(a, b) {
        return b.length - a.length;
    }

    function buildRegex(replacements) {
        var keys = Object.keys(replacements).sort(sortByLengthDesc).map(escapeRegExp);

        if (keys.length === 0) {
            return null;
        }

        return new RegExp(
            "(^|[^\\p{L}\\p{N}_])(" + keys.join("|") + ")(?=$|[^\\p{L}\\p{N}_])",
            "gu"
        );
    }

    function shouldSkipNode(node) {
        var element = node.parentNode;
        var name;

        while (element && element.nodeType === 1) {
            name = element.nodeName.toLowerCase();

            if (name === "script" || name === "style" || name === "code" || name === "pre") {
                return true;
            }

            if (element.getAttribute && element.getAttribute("contenteditable") === "false") {
                return true;
            }

            element = element.parentNode;
        }

        return false;
    }

    function expandEditor(editor, replacements) {
        var body = editor.getBody();
        var doc = editor.getDoc();
        var regex = buildRegex(replacements);
        var walker;
        var node;
        var oldText;
        var newText;
        var changed = 0;

        if (!body || !doc || !regex) {
            return 0;
        }

        function doReplace() {
            walker = doc.createTreeWalker(
                body,
                4,
                {
                    acceptNode: function (textNode) {
                        return shouldSkipNode(textNode) ? 2 : 1;
                    }
                }
            );

            while ((node = walker.nextNode())) {
                oldText = node.nodeValue;
                regex.lastIndex = 0;

                newText = oldText.replace(regex, function (match, prefix, key) {
                    return prefix + replacements[key];
                });

                if (newText !== oldText) {
                    node.nodeValue = newText;
                    changed++;
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

    function expandWithSheet(editor) {
        if (!editor) {
            console.log("TinyMCE expander: no editor");
            return;
        }

        loadReplacements().then(function (replacements) {
            var changed = expandEditor(editor, replacements);

            if (changed === 0) {
                console.log("TinyMCE expander: nothing changed");
            } else {
                console.log("TinyMCE expander: changed " + changed + " text nodes");
            }
        }).catch(function (err) {
            console.log("TinyMCE expander: " + err.message);
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

            (function (editor) {
                editor.on("keydown", function (event) {
                    handleHotkey(event, editor);
                });
            })(editors[i]);
        }
    }

    document.addEventListener("keydown", function (event) {
        handleHotkey(event, null);
    }, true);

    window.setInterval(installEditorHotkeys, 1000);
})();
