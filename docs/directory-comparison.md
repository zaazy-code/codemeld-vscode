# Directory comparison

Directory comparison is a session type inside the CodeMeld comparison manager.

- Same context-menu commands are used for files and directories.
- File/directory mixed comparisons are rejected.
- Default active filter: content differences.
- Filters are additive: only-left, only-right, content, metadata.
- Rows are paired by relative path and rendered as synchronized trees.
- Status dots: green = present/same, transparent = missing, orange = content, pink = metadata.
- Selected rows can be copied/deleted in either direction.
- Double-click content differences to open a file diff tab.
- Double-click metadata-only differences (or the pink metadata marker) to open a metadata tab.
- Metadata transfer supports modified time, macOS creation time (via `xcrun SetFile`), permissions, and owner.
