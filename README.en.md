<p align="center">
  <img src="docs/screenshots/logo.svg" width="88" alt="MDStar logo">
  <h1 align="center">MDStar</h1>
  <p align="center"><b>Markdown Star Browser</b> — a desktop Markdown reader / editor for Windows</p>
</p>

<p align="center">中文文档：<a href="README.md">README.md</a></p>

Built from scratch, runs fully offline in a single executable.

## Screenshots

> UI screenshots are in Chinese; an English interface is on the roadmap.

| Reading | Editing | Mermaid | Tables & code |
| --- | --- | --- | --- |
| <img src="https://github.com/user-attachments/assets/3e854711-076c-4f9d-a7b8-051fe2c876f3" alt="reading" width="260"> | <img src="https://github.com/user-attachments/assets/29b2b492-b974-4be7-9681-970449243ae9" alt="editing" width="260"> | <img src="https://github.com/user-attachments/assets/fca441ac-ce8c-4bf7-a29c-bff2b9ffbe89" alt="mermaid" width="260"> | <img src="https://github.com/user-attachments/assets/512501a6-1f88-4c4e-8ee9-af73e12c589b" alt="tables and code" width="260"> |

**Light and dark themes** (the sun / moon toggle right of the gear in the tab bar):

<img src="https://github.com/user-attachments/assets/a1284159-952d-4876-8ebc-9b285a8b14fe" alt="theme switch" width="760">

## Features

**Reading**

- Multiple tabs, three modes: Reading / Editing / Source
- Sidebar with recent files and an outline; navigation jumps by heading index, so duplicate headings still land in the right place
- Document zoom (`Ctrl` + wheel) and four content widths
- Light and dark themes
- Local image path resolution; broken images show their path with a copy button
- Double-click a large image to open a lightbox: wheel to zoom, drag to pan, one click to fit the screen
- Code blocks: collapse, line numbers, copy button, language label
- Word count

**Editing**

- Edit in place — paragraphs, headings, lists, task lists, quotes, table cells, code blocks
- Markdown input rules convert blocks as you type (`## ` → heading, `- [ ]` → task item); a formatting toolbar is there too
- Table structure operations: insert/delete and move rows and columns, promote a row to header
- Undo has a sensible granularity: typing merges automatically, structural edits count as one step each, "replace all" reverts in one undo
- Switching modes keeps state: each mode remembers its own scroll position, selection and undo stack
- Find and replace behave identically across the three modes (match count and highlights always agree)

**Mermaid**

- All common diagram types render; long CJK labels wrap before rendering, so nothing overflows and text stays sharp
- Double-click text in a diagram to edit it — node labels, edge labels, ER attributes and relations, state transition descriptions. Enter or blur commits, Esc cancels, one undo reverts
- When the text can't be traced back to a unique place in the source, the edit is refused with a reason instead of guessing a position

**Paste**

- Rich text from a browser or Word → clean Markdown
- A range copied from Excel / WPS → a table; pasting into an existing table pads and merges by column count
- `Ctrl+V` a screenshot → the image is written next to the document under `assets/`, referenced by relative path, de-duplicated by content hash, never overwriting an existing file

**Files and window**

- Frameless window with custom minimize / maximize / close buttons, collapsible sidebar
- New untitled documents; "Save as" de-duplicates suggested names (`untitled-2.md`)
- Crash snapshots and recovery, session restore, unsaved-changes prompt on close
- Double-click a `.md` file to open it; if an instance is already running, a second file is handed to that window instead of starting a new process

## Platform and installation

- **Windows 10 / 11 (x64)** only
- The installer is a **per-user install, no UAC prompt**, into `%LOCALAPPDATA%\Programs\MDStar`
- Optionally make MDStar the default app for `.md` / `.markdown` (if you don't tick it, MDStar only appears in "Open with"; the previous default is restored on uninstall)
- Requires the Microsoft Edge WebView2 runtime (usually present on Windows 10/11; the installer warns if it is missing)
- No installer needed either: `MDStar.exe` is self-contained (frontend assets and icons are embedded)
- User data lives in `%APPDATA%\mdsb` and is kept on uninstall by default

## Tech stack

Wails v3 (Go) + WebView2 · ProseMirror (own schema and mapping layer) · CodeMirror 6 · Mermaid · remark/mdast · NSIS 3

## Not supported (yet)

- The source mode does not follow document zoom
- Reading mode is read-only (edit in Editing or Source mode); code blocks have no syntax highlighting yet
- `alt` text and paths of existing images must be changed in source mode
- Untitled (never saved) documents have no crash snapshot or cross-restart restore
- Long documents (above ~90 KB) take 1–2 seconds to enter editing mode
- No macOS / Linux build; no plugin system, Word/PDF export, multiple windows or LaTeX

## License

[MIT](LICENSE). Third-party components (Wails, ProseMirror, CodeMirror, Mermaid, the remark ecosystem)
keep their own MIT notices as shipped with their packages.
