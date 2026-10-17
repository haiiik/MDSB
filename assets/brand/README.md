# 品牌资产索引

**2026-10-16 起用 star-doc 方案**（星星中间挖空一张竖版纸页，页内三条文字线）。
当前配色 **石板蓝 × 纸白**（她看完琥珀版效果后换的），深浅两套各自设计、独立配色。
来源是外部资产目录 `C:\Users\<你>\.minimax\sessions\mvs_948685d2900347a08f05a4dd154f41e2\workspace\markdown-star-browser\icons\`；
本目录只放**接进构建的那几份** + 两套配色的原件。

软件名 **mdStar**（全称 Markdown Star Browser，只出现在 exe 属性页的 `FileDescription`）。
M1 的「马嗅纸」方案（原 HorseParty 的马）同日退役，旧 `mdsb.ico` 与 `png/mdsb-*.png` 已删。

| 文件 | 用途 | 说明 |
| --- | --- | --- |
| `mdstar.ico` | Windows 可执行文件 / 任务栏 / 开始菜单 | = `palettes/slate-paper/app.ico`，十档 16~256。**exe 图标只有一份，不随深浅档切换**，定的是 light 纸白磁贴 |
| `mdstar-file.ico` | `.md` / `.markdown` 文件关联 | = `…/file-badge-page.ico`，纸页 + 实心星（与应用图标区分得开；磁贴底那版 `file-badge` 未采用） |
| `svg/mdstar-mark-light.svg` | 顶栏标记（浅色档）= `frontend/public/logo.svg` | **1024 矢量母版**（129 起不再用位图，见「三档细节」） |
| `svg/mdstar-mark-dark.svg` | 顶栏标记（深色档）= `frontend/public/logo-dark.svg` | 同上 |

接入位置：

- `mdstar.ico` → `wails3 generate syso -icon assets/brand/mdstar.ico` 打进 exe（文件 / 任务栏 / 资源管理器图标）；
- `frontend/public/logo.svg` + `logo-dark.svg` → 顶栏品牌位，**跟着主题换两张**（`TopBar.vue` 的 `brandLogo`）；
- `mdstar-file.ico` → 安装器写注册表时用（本期没有安装包，先备着；注册表里的 `.md` 关联目前仍指旧路径）。

## 两套配色与怎么切换

母版脚本本来就备了两套：`build_star_doc.py` 里 `PALETTES = ("ink-amber", "slate-paper")`，
产物按配色分目录（`star-doc/<palette>/<mode>/{ico,png,svg}`）。**当前生效的是 slate-paper**。

```
assets/brand/palettes/
├── ink-amber/     墨黑 × 琥珀（128 第一次接进来的配色）
└── slate-paper/   石板蓝 × 纸白（当前）
    每套四件：app.ico、file-badge-page.ico、mark-light.svg、mark-dark.svg
```

**换配色 = 拷六个文件 + 重出包，别的都不动**：

```powershell
cd C:\Users\<你>\Documents\Qoder\2026-10-12\9d30ffa8\HorseParty\assets\brand
$P = 'ink-amber'   # 或 'slate-paper'
Copy-Item "palettes\$P\app.ico" mdstar.ico -Force
Copy-Item "palettes\$P\file-badge-page.ico" mdstar-file.ico -Force
Copy-Item "palettes\$P\mark-light.svg" svg\mdstar-mark-light.svg -Force
Copy-Item "palettes\$P\mark-dark.svg"  svg\mdstar-mark-dark.svg  -Force
Copy-Item "palettes\$P\mark-light.svg" ..\..\frontend\public\logo.svg -Force
Copy-Item "palettes\$P\mark-dark.svg"  ..\..\frontend\public\logo-dark.svg -Force
pwsh -File %USERPROFILE%\devtools\hp-build.ps1     # 重出 syso 与 exe（图标要进 exe）
```

色值差异（**不是同一张反过来**）：浅色磁贴 `#F2EFE8/#CBC3B2`（暖纸）→ `#EFF3F9/#BAC5D4`（冷纸）；
深色标记 `#FFBE5A`（琥珀）→ `#7EC8FF`（浅蓝）。
**文件关联那颗在两套里都仍是琥珀色** —— 那是母版脚本钉给「文档类型」的强调色（`md_concepts.py` 的 `accent`），
不随皮肤走；要连它一起换得改母版脚本，不在本项目里改。

## 重新生成母版（改构图 / 加配色时）

**别往她的工作区里写**：把 `icons/build` 整份拷到临时目录再跑 —— 脚本按自身路径算输出根，
产物就落在临时目录里，原目录一个字节不动。

```powershell
Copy-Item "$src\icons\build" "$env:TEMP\star-doc-build\build" -Recurse
cd "$env:TEMP\star-doc-build\build"; python build_star_doc.py   # 本机 Python 3.14.7 + Pillow 12.3.0
# 产物：$env:TEMP\star-doc-build\star-doc\<palette>\<mode>\{ico,png,svg}，并自检全部 .ico 结构（24/24）
```

然后把 `<palette>` 那四件拷进 `assets/brand/palettes/<palette>/`，按上一节的命令接入。

## 三档细节（改尺寸前必读）

图标**不是自由缩放**的，来源 README 定的是三档 —— **那是给位图定的**：

| 档 | 生效尺寸 | 处理 |
| --- | --- | --- |
| `lg` | ≥ 65px | 纸页 + 三条文字线 |
| `md` | 33~64px | 只留纸页（48px 时三条线会糊成一团） |
| `sm` | ≤ 32px | 退回实心星，不挖空 |

星形在三档里完全一致，被砍掉的只有文档 —— 这是这套方案能成立的前提。

**顶栏那颗现在走的是矢量母版（lg 设计）而不是 md 档位图**：128 先按三档规则取了 `mark-color/48.png`，
但 20 CSS px 在 175% 屏上是 35 设备像素，**48→35 的非整数倍缩小把磁贴那圈点状描边碎成了噪点**（她反馈「有锯齿」）。
换成 `mark-color.svg`（1024 矢量）后由浏览器按设备像素比栅格化，边缘干净；代价是纸页里那三条线在 20px 上只剩一条缝。
嫌挤就换 `bare-mark.svg`（透明底、无磁贴无描边），只换 `frontend/public/` 两张文件。
**结论：位图按档取，矢量不受这条约束 —— 界面里可缩放的标记一律用矢量。**

## 2026-10-17（131）她两条：星里的矩形放大 + 关联图标要带文档

> 关联文件的图标应该用图标里有文档的，现在浅色模式的图标就好；
> 然后应用图标我觉得有点小，整个矩形需要再大一些

改的仍是**母版参数**（照旧把 `icons/build` 拷到临时目录跑，她的工作区一个字节没动）：

- **纸页放大**：`doc_designs.PAGE` `(0.42, 0.56)` → **`(0.50, 0.66)`**（相对星半径），
  `PAGE_MD` `(0.38, 0.50)` → `(0.46, 0.60)`。这张纸就是她说的「矩形」，原来只占星半径四成出头。
- **关联文件图标换成浅色磁贴那一版，且每一档都带纸页**：原来用 `file-badge-page`（琥珀纸页 + 实心星），
  而 sm 档（≤32px）按母版规则**不带文档** → 她在资源管理器里看到的是一颗没有文档的星。
  现在文件图标与应用图标同款浅色，但 **sm 档喂 md 档的图**（level 映射 `{'lg':lg,'md':md,'sm':md}`），
  16/24/32 上纸页的洞还在。**代价**：浅色下两个图形相同，只靠「小尺寸带不带文档」区分；
  想再分开就把文件图标换成 `bare_mark`（无磁贴底、纯星 + 纸页洞）。
- 重出的是全套：`mdstar.ico`、`mdstar-file.ico`、`svg/mdstar-mark-{light,dark}.svg`、
  `frontend/public/logo*.svg`、`palettes/slate-paper/` 两张 —— **顶栏那颗跟着变了**（同一份母版）。
  前后对比：`.scratch/m2/evidence/图标-131-纸页放大前后对比.png`。
- **装完看不到变化先想缓存**：Explorer 的文件图标缓存很顽固，重装后跑一次 `ie4uinit.exe -show`
  或注销一次；exe 自己的图标每次重打包都会换（syso 每轮重出）。
