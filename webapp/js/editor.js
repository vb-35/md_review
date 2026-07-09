import {EditorSelection, EditorState, Compartment} from "https://esm.sh/@codemirror/state";
import {history, historyKeymap, defaultKeymap, indentWithTab} from "https://esm.sh/@codemirror/commands";
import {markdown} from "https://esm.sh/@codemirror/lang-markdown";
import {indentOnInput, syntaxHighlighting, defaultHighlightStyle, indentUnit} from "https://esm.sh/@codemirror/language";
import {EditorView, drawSelection, highlightActiveLine, keymap} from "https://esm.sh/@codemirror/view";
import {
  SearchCursor,
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  setSearchQuery
} from "https://esm.sh/@codemirror/search";
import {oneDark} from "https://esm.sh/@codemirror/theme-one-dark";

const root = window;
const App = root.App || (root.App = {});

const editableCompartment = new Compartment();
const readOnlyCompartment = new Compartment();
const themeCompartment = new Compartment();

let view = null;
let editable = true;
const updateCallbacks = new Set();
const scrollCallbacks = new Set();

class HiddenSearchPanel {
  constructor() {
    this.dom = document.createElement("div");
    this.dom.className = "cm-hidden-search-panel";
    this.dom.setAttribute("aria-hidden", "true");
    this.dom.innerHTML = '<input type="text" main-field="true" tabindex="-1"><input type="text" tabindex="-1">';
  }

  update() {}

  destroy() {}
}

const lightTheme = [
  EditorView.theme({
    "&": {
      height: "100%",
      color: "var(--fg)",
      backgroundColor: "var(--editor-bg)"
    },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: '"IBM Plex Mono", "Fira Code", monospace',
      fontSize: "var(--workspace-font-size)",
      lineHeight: "1.6"
    },
    ".cm-content, .cm-gutters": {
      minHeight: "100%"
    },
    ".cm-content": {
      padding: "18px",
      caretColor: "var(--fg)",
      tabSize: "4"
    },
    ".cm-line": {
      padding: "0"
    },
    ".cm-selectionBackground, ::selection": {
      backgroundColor: "rgba(201, 160, 74, 0.28) !important"
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(201, 160, 74, 0.08)"
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--fg)"
    },
    ".cm-searchMatch": {
      backgroundColor: "rgba(242, 184, 75, 0.22)",
      boxShadow: "inset 0 0 0 1px rgba(180, 107, 24, 0.28)"
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "rgba(180, 107, 24, 0.28)",
      boxShadow: "inset 0 0 0 1px rgba(180, 107, 24, 0.6)"
    },
    "&.cm-editor.cm-focused": {
      outline: "none"
    },
    "&.cm-editor.cm-editor-readonly .cm-content": {
      color: "var(--fg-dim)"
    },
    ".cm-hidden-search-panel": {
      display: "none"
    }
  }),
  syntaxHighlighting(defaultHighlightStyle)
];

const darkTheme = [
  oneDark,
  EditorView.theme({
    "&": {
      height: "100%",
      backgroundColor: "var(--editor-bg)"
    },
    ".cm-scroller": {
      overflow: "auto",
      backgroundColor: "var(--editor-bg)",
      fontFamily: '"IBM Plex Mono", "Fira Code", monospace',
      fontSize: "var(--workspace-font-size)",
      lineHeight: "1.6"
    },
    ".cm-content, .cm-gutters": {
      minHeight: "100%",
      backgroundColor: "var(--editor-bg)"
    },
    ".cm-content": {
      padding: "18px",
      tabSize: "4"
    },
    ".cm-gutters": {
      borderRight: "1px solid rgba(255, 255, 255, 0.04)"
    },
    ".cm-line": {
      padding: "0"
    },
    ".cm-activeLine, .cm-activeLineGutter": {
      backgroundColor: "rgba(255, 255, 255, 0.02)"
    },
    ".cm-searchMatch": {
      backgroundColor: "rgba(242, 184, 75, 0.26)",
      boxShadow: "inset 0 0 0 1px rgba(242, 184, 75, 0.45)"
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "rgba(180, 107, 24, 0.42)",
      boxShadow: "inset 0 0 0 1px rgba(180, 107, 24, 0.7)"
    },
    "&.cm-editor.cm-focused": {
      outline: "none"
    },
    "&.cm-editor.cm-editor-readonly .cm-content": {
      color: "var(--fg-dim)"
    },
    ".cm-hidden-search-panel": {
      display: "none"
    }
  })
];

function requireView() {
  if (!view) throw new Error("Editor not initialized");
  return view;
}

function getSelectionInfo() {
  const currentView = requireView();
  const main = currentView.state.selection.main;
  return {
    anchor: main.anchor,
    head: main.head,
    from: main.from,
    to: main.to,
    text: currentView.state.sliceDoc(main.from, main.to)
  };
}

function setTheme(themeName) {
  const currentView = requireView();
  currentView.dispatch({
    effects: themeCompartment.reconfigure(themeName === "light" ? lightTheme : darkTheme)
  });
}

function setSearchPanelOpen(isOpen) {
  const currentView = requireView();
  if (isOpen) {
    openSearchPanel(currentView);
  } else {
    closeSearchPanel(currentView);
  }
}

function buildSearchQuery(query, replacement = "") {
  return new SearchQuery({
    search: query || "",
    replace: replacement || "",
    caseSensitive: true,
    literal: true,
    regexp: false,
    wholeWord: false
  });
}

function collectSearchMatches(querySpec = getSearchQuery(requireView().state)) {
  if (!querySpec.valid || !querySpec.search) return [];
  const currentView = requireView();
  const cursor = new SearchCursor(currentView.state.doc, querySpec.search);
  const matches = [];
  while (!cursor.next().done) {
    matches.push({
      from: cursor.value.from,
      to: cursor.value.to
    });
  }
  return matches;
}

function getSearchStatus() {
  const currentView = requireView();
  const query = getSearchQuery(currentView.state);
  const matches = collectSearchMatches(query);
  const selection = currentView.state.selection.main;
  let activeIndex = -1;
  if (matches.length) {
    activeIndex = matches.findIndex((match) => match.from === selection.from && match.to === selection.to);
    if (activeIndex === -1) {
      activeIndex = matches.findIndex((match) => match.from >= selection.from);
      if (activeIndex === -1) activeIndex = 0;
    }
  }
  return {
    query: query.search || "",
    replacement: query.replace || "",
    count: matches.length,
    activeIndex,
    matches
  };
}

function notifyUpdate(update) {
  const payload = {
    docChanged: update.docChanged,
    selectionSet: update.selectionSet,
    focusChanged: update.focusChanged,
    viewportChanged: update.viewportChanged,
    value: update.state.doc.toString(),
    selection: getSelectionInfo()
  };
  updateCallbacks.forEach((callback) => callback(payload));
}

function init(container, initialValue = "") {
  if (view) return view;
  container.textContent = "";
  view = new EditorView({
    state: EditorState.create({
      doc: initialValue,
      extensions: [
        EditorState.tabSize.of(4),
        indentUnit.of("    "),
        history(),
        drawSelection(),
        highlightActiveLine(),
        indentOnInput(),
        EditorView.lineWrapping,
        editableCompartment.of(EditorView.editable.of(true)),
        readOnlyCompartment.of(EditorState.readOnly.of(false)),
        themeCompartment.of(darkTheme),
        markdown(),
        search({
          top: false,
          createPanel: () => new HiddenSearchPanel()
        }),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              const saveButton = document.querySelector("#btn-save");
              if (saveButton) saveButton.click();
              return true;
            }
          },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged && !update.selectionSet && !update.focusChanged && !update.viewportChanged) return;
          notifyUpdate(update);
        })
      ]
    }),
    parent: container
  });
  editable = true;
  view.dom.classList.add("cm-editor-owned");
  view.scrollDOM.addEventListener("scroll", () => {
    scrollCallbacks.forEach((callback) => callback(getScrollInfo()));
  });
  return view;
}

function getValue() {
  return requireView().state.doc.toString();
}

function setValue(value) {
  const currentView = requireView();
  const nextValue = value == null ? "" : String(value);
  if (nextValue === currentView.state.doc.toString()) return;
  currentView.dispatch({
    changes: {
      from: 0,
      to: currentView.state.doc.length,
      insert: nextValue
    },
    selection: {anchor: 0}
  });
}

function setEditable(nextEditable) {
  editable = !!nextEditable;
  const currentView = requireView();
  currentView.dispatch({
    effects: [
      editableCompartment.reconfigure(EditorView.editable.of(editable)),
      readOnlyCompartment.reconfigure(EditorState.readOnly.of(!editable))
    ]
  });
  currentView.dom.classList.toggle("cm-editor-readonly", !editable);
}

function focus() {
  requireView().focus();
}

function getSelection() {
  return getSelectionInfo();
}

function setSelection(anchor, head = anchor) {
  const currentView = requireView();
  currentView.dispatch({
    selection: EditorSelection.single(anchor, head)
  });
}

function replaceSelection(text) {
  const currentView = requireView();
  const selection = currentView.state.selection.main;
  const insert = text == null ? "" : String(text);
  currentView.dispatch({
    changes: {
      from: selection.from,
      to: selection.to,
      insert
    },
    selection: {anchor: selection.from + insert.length}
  });
}

function replaceRange(from, to, text) {
  const currentView = requireView();
  const insert = text == null ? "" : String(text);
  currentView.dispatch({
    changes: {
      from,
      to,
      insert
    },
    selection: {anchor: from + insert.length}
  });
}

function setCursor(offset) {
  const currentView = requireView();
  currentView.dispatch({
    selection: EditorSelection.single(offset),
    effects: EditorView.scrollIntoView(offset, {y: "center"})
  });
}

function revealOffset(offset) {
  const currentView = requireView();
  currentView.dispatch({
    effects: EditorView.scrollIntoView(offset, {y: "center"})
  });
}

function getScrollInfo() {
  const currentView = requireView();
  const {scrollTop, scrollHeight, clientHeight} = currentView.scrollDOM;
  const range = Math.max(0, scrollHeight - clientHeight);
  return {
    top: scrollTop,
    scrollHeight,
    clientHeight,
    ratio: range > 0 ? scrollTop / range : 0
  };
}

function scrollToRatio(ratio) {
  const currentView = requireView();
  const {scrollDOM} = currentView;
  const boundedRatio = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const range = Math.max(0, scrollDOM.scrollHeight - scrollDOM.clientHeight);
  scrollDOM.scrollTop = range * boundedRatio;
}

function onChange(callback) {
  updateCallbacks.add(callback);
  return () => updateCallbacks.delete(callback);
}

function onScroll(callback) {
  scrollCallbacks.add(callback);
  return () => scrollCallbacks.delete(callback);
}

function applyTheme(themeName) {
  setTheme(themeName);
}

function setSearchQueryValue(query, replacement = "") {
  const currentView = requireView();
  currentView.dispatch({
    effects: setSearchQuery.of(buildSearchQuery(query, replacement))
  });
}

function findNextMatch() {
  return findNext(requireView());
}

function findPreviousMatch() {
  return findPrevious(requireView());
}

function replaceNextMatch() {
  return replaceNext(requireView());
}

function replaceAllMatches() {
  return replaceAll(requireView());
}

App.editor = {
  init,
  getValue,
  setValue,
  setEditable,
  focus,
  getSelection,
  setSelection,
  replaceSelection,
  replaceRange,
  setCursor,
  revealOffset,
  getScrollInfo,
  scrollToRatio,
  onChange,
  onScroll,
  applyTheme,
  openSearchPanel: () => setSearchPanelOpen(true),
  closeSearchPanel: () => setSearchPanelOpen(false),
  setSearchQuery: setSearchQueryValue,
  getSearchStatus,
  findNext: findNextMatch,
  findPrevious: findPreviousMatch,
  replaceNext: replaceNextMatch,
  replaceAll: replaceAllMatches
};

if (typeof App._resolveEditorReady === "function") App._resolveEditorReady();
