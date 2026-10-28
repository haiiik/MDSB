<p align="center">
  <img src="docs/screenshots/logo.svg" width="88" alt="MDStar logo">
  <h1 align="center">MDStar Browser</h1>
  <p align="center"><b>Markdown Star Browser</b> — a desktop Markdown reader / editor for Windows</p>
</p>

<p align="center">中文文档：<a href="README.md">README.md</a></p>

Built from scratch, runs fully offline in a single executable.

## Screenshots

> The screenshots are taken in the Chinese UI; switch **Settings → Language → English** for the English interface.

| Reading | Editing |
| --- | --- |
| <img src="docs/screenshots/01-read.png" alt="reading" width="470"> | <img src="docs/screenshots/02-edit.png" alt="editing" width="470"> |
| **Mermaid** | **Code block** |
| <img src="docs/screenshots/03-mermaid.png" alt="mermaid" width="470"> | <img src="docs/screenshots/04-code-block.png" alt="code block" width="470"> |

**Light and dark themes** (the sun / moon toggle right of the gear in the tab bar):

<img src="docs/screenshots/theme-toggle.gif" alt="theme switch" width="760">

## Features

**Reading**

- Multiple tabs, three modes: Reading / Editing / Source
- Sidebar with recent files and an outline; navigation jumps by heading index, so duplicate headings still land in the right place
- Document zoom (`Ctrl` + wheel) and four content widths
- Light and dark themes
- Local image path resolution; broken images show their path with a copy button
- Double-click a large image to open a lightbox: wheel to zoom, drag to pan, one click to fit the screen
- Code blocks: collapse, line numbers, copy button, language label
- Math (KaTeX): inline `$…$` and block `$$…$$`; a broken formula degrades to "source + error mark" instead of disappearing
- Footnotes: `[^1]` references and definitions, click to jump down, click ↩ to jump back
- Word count
- Chinese / English UI (switch in Settings, also chosen at install time)

**Editing**

- Edit in place — paragraphs, headings, lists, task lists, quotes, table cells, code blocks
- Markdown input rules convert blocks as you type (`## ` → heading, `- [ ]` → task item); a formatting toolbar is there too
- Table structure operations: insert/delete and move rows and columns, promote a row to header
- Undo has a sensible granularity: typing merges automatically, structural edits count as one step each, "replace all" reverts in one undo
- Switching modes keeps state: each mode remembers its own scroll position, selection and undo stack
- Find and replace behave identically across the three modes (match count and highlights always agree); the search box composes Chinese input normally
- Math edits in place: a block shows rendered output above and its source below; editing touches only that block and keeps the `$$` skeleton as written
- Footnote definitions are editable in place; "insert document link" picks a file under the current document's folder and writes a relative path

**Mermaid**

- All common diagram types render; long CJK labels wrap before rendering, so nothing overflows and text stays sharp
- Each diagram zooms on its own: `− 100% +` at the right end of the diagram's toolbar (click the percentage to go back to 100%). Reading and edit modes share the same control and the same level — and the level is purely how you look at it, never written into the file
- Double-click text in a diagram to edit it — node labels, edge labels, ER attributes and relations, state transition descriptions. Enter or blur commits, Esc cancels, one undo reverts
- Double-clicking an entity or state **name** offers two actions: **change the label only** (writes an alias, leaving the name and its references untouched) or **rename in all N places** (the declaration plus every reference; the button states how many places move). When no name can be resolved only one action is offered — never a button that is guaranteed to be refused
- When the same text appears several times in a diagram, editing still works: the k-th thing on screen changes the k-th place in the source and leaves the others byte-for-byte alone. If the two lists can't be matched (different counts, or the texts don't line up pair by pair) the whole group is refused with a reason — the position is never guessed

**Paste**

- Rich text from a browser or Word → clean Markdown
- A range copied from Excel / WPS → a table; pasting into an existing table pads and merges by column count
- `Ctrl+V` a screenshot → the image is written next to the document under `assets/`, referenced by relative path, de-duplicated by content hash, never overwriting an existing file

**Output**

- Print (`Ctrl+P`, or the "Print" button on the bar above the reading view): light paper, A4, table headers repeat across pages, no UI chrome on paper; a long inner-scrolled document prints in full rather than just the visible screen
- Single-file HTML export: images are embedded and styles carried along, so the file never loses them; images that can't be fetched keep their original URL and are counted in the notice
- PDF: save as PDF through the system print dialog — the same paper stylesheet as printing, so there is never a second layout to keep in sync
- Callouts: `> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]` render as tinted blocks with an icon in the reading view; **anything unrecognized is left exactly as written**, no guessing

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
- No macOS / Linux build; no plugin system, no multiple windows, and no Word / image export (PDF only via the system print dialog, never generated silently)
- Formula fonts in exported HTML still point at the app's own asset URLs, so on another machine formulas stay readable but lose some typesetting

## License

[MIT](LICENSE). Third-party components (Wails, ProseMirror, CodeMirror, Mermaid, the remark ecosystem)
keep their own MIT notices as shipped with their packages.
