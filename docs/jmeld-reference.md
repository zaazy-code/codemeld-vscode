# Original JMeld reference map for CodeMeld

CodeMeld treats the original JMeld source tree as a behavioural/UI reference, not as code to mechanically translate.

| Original JMeld | VS Code project | Notes |
|---|---|---|
| `org.codemeld.diff.JMChunk` | `src/core/model.ts::Chunk` | Zero-based anchor + size |
| `org.codemeld.diff.JMDelta` | `src/core/model.ts::Delta` | ADD / DELETE / CHANGE |
| `org.codemeld.diff.JMRevision` | `src/core/model.ts::Revision` | Collection of deltas |
| `org.codemeld.diff.JMDiff` | `src/core/DiffEngine.ts` | Line diff entry point |
| `org.jmeld.ui.diffbar.DiffScrollComponent` | `src/webview/DiffPanel.ts` (prototype gutter) | SVG Bezier connectors |
| `org.jmeld.ui.text.FilePanel` | future `MonacoPane` | Do not port Swing text model |
| `ScrollSynchronizer` | future `ScrollSync` | Milestone 3: anchor-aware mapping |
| `JMHighlighter` | future Monaco decorations | Intra-line and block highlighting |

## Deliberately not ported

Swing document/editor code, VCS integrations, directory UI, and bundled third-party Eclipse/JRCS diff implementations are not copied. The current `DiffEngine` is a clean TypeScript implementation of the standard Myers shortest-edit-script algorithm.

## Next milestones

1. Replace prototype `<pre>` panes with Monaco editors.
2. Make connector positions use actual editor line coordinates.
3. Implement anchor-aware synchronized scrolling.
4. Add left/right merge actions and write changes through VS Code workspace edits.
5. Add intra-line diff and decorations.
