# Comparison Manager

CodeMeld 0.2 introduces a single manager webview that owns zero or more comparison sessions.

Each comparison session keeps:

- left/right file URI;
- current and last-saved text for both sides;
- current diff revision;
- two Monaco editor instances;
- independent undo/redo history;
- independent scroll position and decorations;
- dirty state.

Opening another pair adds a new internal tab rather than a second VS Code webview panel. Tabs are horizontally scrollable.

Closing a dirty comparison asks whether to save before removal. Closing the whole CodeMeld panel also checks all dirty comparisons. VS Code does not provide a cancellable close event for WebviewPanel, so choosing Cancel at the manager-level prompt recreates the manager with the in-memory sessions intact.
