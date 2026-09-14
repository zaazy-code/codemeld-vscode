# CodeMeld

CodeMeld is a visual diff and merge editor for Visual Studio Code.

## Current capabilities

- Multiple comparisons inside one CodeMeld manager.
- File and directory comparison tabs.
- Line and intra-line diff highlighting.
- Visual bridges and interactive merge controls.
- Directory tree comparison with content/time/metadata filters and persistent glob-style exclusion rules.
- Field-level metadata comparison and transfer.
- Configurable appearance.

## Supported runtime platforms

CodeMeld 0.4.0 selects a platform adapter from the OS where the VS Code **Extension Host** runs. This is intentional: when VS Code on macOS connects to Linux using Remote SSH, CodeMeld uses Linux behavior for the remote files.

| Capability | macOS | Linux | Windows |
|---|---|---|---|
| File diff/merge | Yes | Yes | Yes |
| Directory diff/merge | Yes | Yes | Yes |
| Modification time | Read/write | Read/write | Read/write |
| Creation time | Read/write when `SetFile` is available | Read only | Read/write |
| Owner | UID/name, transfer subject to OS permissions | UID/name via NSS/getent, transfer subject to OS permissions | Account name, transfer subject to ACL privileges |
| Group | GID/name, transfer subject to OS permissions | GID/name via NSS/getent, transfer subject to OS permissions | Not exposed separately |
| Permissions | POSIX r/w/x + special bits | POSIX r/w/x + special bits | Windows ACL |

Linux name resolution uses NSS (`getent`) when available, so local accounts, LDAP and SSSD-backed identities can be displayed. Windows metadata uses the native security descriptor/ACL model rather than emulating POSIX mode bits.

Remote/workspace execution is enabled for Remote SSH, WSL and Dev Containers. The actual behavior follows the remote Extension Host platform.

Runtime information is written to **Output → CodeMeld** when the extension activates.

## Run from source

```bash
npm install
npm run compile
```

Open the project in VS Code and press `F5`.

In the Extension Development Host:

1. Right-click the first file or directory → **CodeMeld: Select for Compare**.
2. Right-click another item of the same type → **CodeMeld: Compare with Selected**.

## Platform notes

Changing owner/group/ACL values is always subject to the privileges of the user running the Extension Host. CodeMeld exposes a platform capability when the OS supports an operation, but the OS may still reject a particular operation with `EPERM` / access denied.

Linux creation time is intentionally read-only. There is no portable Linux API for setting filesystem birth time. macOS creation-time transfer uses `SetFile` from Xcode Command Line Tools when available.


## 0.4.3

Case-aware directory pairing and case-conflict synchronization for case-insensitive filesystems.


## 0.4.4 behavior note

For case-only name conflicts on case-insensitive filesystems, directory-view arrows synchronize only filename casing. Double-click opens content comparison; merge actions inside that file comparison never rename either file.



## 0.4.8

- VS Code theme colors are now the default for primary accent, add/delete colors, editor background, and gutter.
- Each appearance color can independently switch between VS Code theme and Custom.
- Alternate zebra-row background is derived automatically from the active editor background.
- Theme changes are reflected by CodeMeld without recreating comparison sessions.
- Existing custom appearance settings are preserved during migration.

## 0.4.5

- Added adaptive zebra row backgrounds to directory comparison, metadata comparison, and content merge editors.
- Alternate row color is derived automatically from the configured editor background.


## Settings

Appearance settings are exposed through the standard VS Code Settings UI under **CodeMeld** and can participate in Settings Sync. Empty color values inherit the active VS Code theme.

## Repository

Source code: https://github.com/zaazy-code/codemeld-vscode

Issues: https://github.com/zaazy-code/codemeld-vscode/issues

## Build an installable VSIX

```bash
npm install
npm run package:vsix
```

The packaging step compiles CodeMeld, copies the Monaco runtime required by the webview into `dist/monaco/vs`, excludes development-only files from the VSIX, and produces `codemeld-<version>.vsix` in the project root.

Install version 0.5.2 with:

```bash
code --install-extension codemeld-0.5.2.vsix
```

Or in VS Code use **Extensions → … → Install from VSIX…**.

## License

CodeMeld is licensed under the [MIT License](LICENSE). Third-party components and their notices are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).


## Directory exclusion filters

Directory comparisons can exclude files and folders before analysis. Open **Filters** in the directory comparison toolbar and add named masks such as `.git/`, `node_modules/`, `*.log`, or `build/**`. Rules are stored in `codemeld.directory.excludeFilters` and persist in VS Code settings.
