; ------------------------- MDStar 安装包（NSIS 3.11） -------------------------
; 当前用户安装（免 UAC）：文件进 %LOCALAPPDATA%\Programs\MDStar，注册表全写 HKCU。
;
; 编译入口是 `%USERPROFILE%\devtools\hp-installer.ps1`（先出 exe 再带 -D 参数调 makensis）。
; 手工编译要自己给四个 -D：
;   makensis -DVERSION=0.1.0 -DBINDDIR=<repo>\build\bin -DBRANDDIR=<repo>\assets\brand `
;            -DOUTDIR=<repo>\build\dist <repo>\build\windows\mdstar.nsi
;
; 三条设计口径（改动前先读）：
; 1. **版本号只有一个来源**：hp-installer.ps1 把同一个 $Version 既喂给
;    `go build -X mdsb/internal/service.version=`（设置对话框那行「MDStar v…」读它），
;    又喂给这里的 VERSION / VIProductVersion。分开写会出现「包是 0.1.0、界面是 0.1.0-dev」。
; 2. **.md 关联**：主程序段给五个扩展名各登记一份 ProgId（`MDStar.md` / `MDStar.markdown` / …）
;    + 进「打开方式」+ 写 `Capabilities`/`RegisteredApplications`（让她能在系统「默认应用」里选到我们）。
;    **接管默认值是第三个可选段，默认勾上**（131 她定的「默认关联格式要默认选中」），
;    接管时**先备份原默认值与 UserChoice、卸载按备份还原**。
;    为什么必须动 `UserChoice`：Win10/11 里它的优先级**高于**扩展名默认值，且带系统算的哈希、
;    脚本伪造不了 —— 她实测到的「勾了接管、双击 .md 却弹『你要用哪个应用打开』」就是
;    一条指向早已卸载应用的旧 UserChoice 压住了我们写的值。合规做法只有清掉它（并留备份），
;    或让她自己在系统「默认应用」里点一次（那会生成一条合法的新 UserChoice）。
; 3. **卸载默认不动她的数据**：%APPDATA%\mdsb（设置、最近列表、置顶）只有在卸载向导里
;    明确勾那一格才删；旧目录 %APPDATA%\horseparty 任何情况都不碰（她的迁移前备份）。

Unicode true

!ifndef VERSION
  !error "必须带 -DVERSION=x.y.z（要和 go build 注入的 internal/service.version 同一个值）"
!endif
!ifndef BINDDIR
  !error "必须带 -DBINDDIR=<仓库>\build\bin 的绝对路径"
!endif
!ifndef BRANDDIR
  !error "必须带 -DBRANDDIR=<仓库>\assets\brand 的绝对路径"
!endif
!ifndef OUTDIR
  !error "必须带 -DOUTDIR=<仓库>\build\dist 的绝对路径"
!endif

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "nsDialogs.nsh"
; BM_SETCHECK / BM_GETCHECK / BST_CHECKED 都在这一份里。
; 少了它，`${BM_SETCHECK}` 这类符号在 NSIS 里**不会报错**，会被当成字面量/0，
; 于是"预选"和"读回勾选状态"全都静默失效 —— 语言页的拦截逻辑会永远判成"没选"。
!include "WinMessages.nsh"

!define APP      "MDStar"
!define EXE      "MDStar.exe"
!define FILEICON "mdstar-file.ico"
!define PROGID   "MDStar.md"
!define REGKEY   "Software\${APP}"
!define UNINSTK  "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}"
!define APPPATHS "Software\Microsoft\Windows\CurrentVersion\App Paths\${EXE}"
; 应用「能力声明」的位置：`RegisteredApplications` 指到这里，Windows 才会把 MDStar
; 列进「设置 > 应用 > 默认应用 > 按文件选择默认值」，也让外壳认这套关联是正经应用登记的
; （131 她实测：只写扩展名默认值时 `.markdown` 双击仍弹「你要用哪个应用打开」）。
!define CAPKEY   "Software\Clients\${APP}"

; ---------------- 每个扩展名一份 ProgId（`MDStar.md` / `MDStar.markdown` / …） ----------------
; 一台机器上别人也这么干（Qoder 就是 `Qoder.md` + `Qoder.markdown` 两份）。
; 共享一份 ProgId 在「打开方式」里看不出区别，但**接管默认值时 Windows 对
; 「扩展名 → ProgId → 命令」这条链的校验是按扩展名来的**，一份对多扩展名不是必需动作，
; 没必要为了少几行去赌它的兼容性。
!macro RegisterExt EXT DESC
  WriteRegStr HKCU "Software\Classes\${APP}${EXT}" "" "${DESC}"
  WriteRegStr HKCU "Software\Classes\${APP}${EXT}\DefaultIcon" "" "$INSTDIR\${FILEICON}"
  WriteRegStr HKCU "Software\Classes\${APP}${EXT}\Shell" "open" ""
  WriteRegStr HKCU "Software\Classes\${APP}${EXT}\shell\open" "" "用 MDStar 打开"
  WriteRegStr HKCU "Software\Classes\${APP}${EXT}\shell\open\command" "" '"$INSTDIR\${EXE}" "%1"'
  ; 只加自己那一格值：这个列表里还挂着 Qoder / XinText / WorkBuddy / WPS 的登记
  WriteRegStr HKCU "Software\Classes\${EXT}\OpenWithProgids" "${APP}${EXT}" ""
  WriteRegStr HKCU "${CAPKEY}\Capabilities\FileAssociations" "${EXT}" "${APP}${EXT}"
!macroend

!macro UnregisterExt EXT
  DeleteRegValue HKCU "Software\Classes\${EXT}\OpenWithProgids" "${APP}${EXT}"
  DeleteRegValue HKCU "${CAPKEY}\Capabilities\FileAssociations" "${EXT}"
  DeleteRegKey HKCU "Software\Classes\${APP}${EXT}"
!macroend

; 接管某个扩展名的默认打开方式：
; 1) **先备份原默认值**（空值记 `__none__`，卸载时按它还原）；
; 2) 写我们的 ProgId；
; 3) **清掉 `FileExts\<ext>\UserChoice`**（也先备份 ProgId + Hash）。
;    第 3 步是 131 她实测出来的必需动作：UserChoice 的优先级**高于**这里写的扩展名默认值，
;    而且带 Windows 算的哈希、脚本伪造不了 —— 表现就是「勾了接管、双击却弹选择应用」，
;    因为那条 UserChoice 指向的应用早就没了。合规做法只有**清掉它**让外壳回落到默认值，
;    卸载时再按备份写回去。
!macro TakeOverExt EXT
  ReadRegStr $0 HKCU "Software\Classes\${EXT}" ""
  ${If} $0 == ""
    WriteRegStr HKCU "${REGKEY}\AssocBackup" "${EXT}" "__none__"
  ${Else}
    WriteRegStr HKCU "${REGKEY}\AssocBackup" "${EXT}" $0
  ${EndIf}
  WriteRegStr HKCU "Software\Classes\${EXT}" "" "${APP}${EXT}"

  ; 路径里的 ${EXT} 必须在宏展开时就落地，所以整条写全、不再套一层 !define
  ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\UserChoice" "ProgId"
  ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\UserChoice" "Hash"
  ${If} $1 != ""
    ${If} $1 == "${APP}${EXT}"
      ; **已经指向我们就不动它**：这条哈希是系统算的、有效的，删了等于把一条能用的关联
      ; 退回给外壳重新解析（Win11 对「只写扩展名默认值」并不总是认，实测 `.markdown` 就还弹选择应用）。
    ${Else}
      ; 指向别的应用（或指向一个早就被卸掉的应用 = 她实测到的那个弹窗）→ 备份后清掉，
      ; 让外壳回落到我们写的默认值。卸载时按备份原样还回去。
      WriteRegStr HKCU "${REGKEY}\UserChoiceBackup\${EXT}" "ProgId" $1
      WriteRegStr HKCU "${REGKEY}\UserChoiceBackup\${EXT}" "Hash" $2
      DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\UserChoice"
    ${EndIf}
  ${EndIf}
!macroend

; 卸载时还原：扩展名默认值按 AssocBackup 写回；UserChoice 只有**在它指向的 ProgId 现在
; 还能解析出 open\command** 时才写回（她原来那条很可能指向早已卸载的应用 ——
; 那正是当初要弹选择应用的原因，原样还回去等于把坏状态再种一次）。
!macro RestoreExt EXT
  ReadRegStr $0 HKCU "${REGKEY}\AssocBackup" "${EXT}"
  ${If} $0 == "__none__"
    DeleteRegValue HKCU "Software\Classes\${EXT}" ""
  ${ElseIf} $0 != ""
    WriteRegStr HKCU "Software\Classes\${EXT}" "" $0
  ${EndIf}

  ReadRegStr $1 HKCU "${REGKEY}\UserChoiceBackup\${EXT}" "ProgId"
  ReadRegStr $2 HKCU "${REGKEY}\UserChoiceBackup\${EXT}" "Hash"
  ${If} $1 != ""
    ReadRegStr $3 HKCU "Software\Classes\$1\shell\open\command" ""
    ${If} $3 == ""
      ReadRegStr $3 HKLM "SOFTWARE\Classes\$1\shell\open\command" ""
    ${EndIf}
    ${If} $3 != ""
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\UserChoice" "ProgId" $1
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\UserChoice" "Hash" $2
    ${EndIf}
  ${EndIf}
!macroend


; 与 main.go 的 FileAssociations 保持一致（Wails 侧只声明扩展名，写注册表是这里的事）：
;   .md .markdown .mdown .mkd .mkdn  ——  下面 SecMain 里逐个登记，加扩展名两边都要改。

!macro SHCNE_ASSOCCHANGED
  ; 改完关联要让外壳重读，否则「打开方式」列表要等注销才更新
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

Name "${APP} ${VERSION}"
Caption "${APP} ${VERSION} 安装"
OutFile "${OUTDIR}\MDStar-setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
InstallDirRegKey HKCU "${REGKEY}" "InstallDir"
DirText "将装到当前用户的目录里，不需要管理员权限；同一台电脑的其他账号看不到这份安装。"
SetCompressor /SOLID lzma
RequestExecutionLevel user

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "${APP}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "FileDescription" "${APP} 安装包"
VIAddVersionKey /LANG=2052 "OriginalFilename" "MDStar-setup-${VERSION}.exe"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "xuange"
VIAddVersionKey /LANG=2052 "Comments" "当前用户安装；.md 关联只写 HKCU"

; 安装包与卸载器的图标用**带文档的那版**（`mdstar-file.ico`：每一档都留着纸页）。
; 不用 `mdstar.ico` —— 那份的 sm 档（≤32px）按母版规则退回不带文档的实心星，
; 而资源管理器里 setup.exe 正是按 32/48px 画的，于是「安装包上没有文档」。
; 她 131 追加：「安装包图标也要带文档的星星」。
!define MUI_ICON   "${BRANDDIR}\mdstar-file.ico"
!define MUI_UNICON "${BRANDDIR}\mdstar-file.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEFINISHPAGE_BITMAP_NOSTRETCH
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "现在就打开 MDStar"
!define MUI_COMPONENTSPAGE_SMALLDESC

!insertmacro MUI_PAGE_WELCOME
; ---------------- 安装期选界面语言（131 追加，她定的口径） ----------------
; 读系统 UI 语言做预选；**读不到 / 不认识 → 不给默认值，必须选一项才能继续**。
; 装完写 HKCU\Software\MDStar\Language = zh|en，应用首启拿它当 settings.lang 的初值。
!define LANGREGKEY "Software\${APP}"
Var LangZh
Var LangEn
Var LangChosen

Function LangPageCreate
  ; 走 MUI 的页头（粗体标题 + 副标题），不然这一页上面空一块、和别的页不像一家人。
  ; 官方 nsDialogs 例子里替换 MUI 页的写法就是先 MUI_HEADER_TEXT 再建对话框。
  !insertmacro MUI_HEADER_TEXT "界面语言" "选择 MDStar 的界面语言（装完也能在设置里改）。"
  nsDialogs::Create 1018
  Pop $0
  ; 建不出来就明确放弃这一页（NSIS 的默认行为是"静默跳过"，出问题时什么都看不见）
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateRadioButton} 0 6u 100% 12u "中文"
  Pop $LangZh
  ${NSD_CreateRadioButton} 0 26u 100% 12u "English"
  Pop $LangEn

  ; HP_NO_PRESELECT：只给**自检构建**用的开关（编译时 -DHP_NO_PRESELECT=1），
  ; 让两颗单选都不预选，用来验「没选就不能下一步」这条拦截在真界面上成立。
  ; 正式包不带这个定义。
  !ifndef HP_NO_PRESELECT
  ; ---- 预选：读系统 UI 语言 ----------------------------------------------
  ; **坑（实测）**：`System::Call 'user32::GetUserDefaultUILanguage()i.r1'` 在这套
  ; NSIS 3.11 的 System 插件里取不到函数，$1 拿到的是字符串 "error"，
  ; 于是原来的 `${If} $1 == 0x0804` 全部落空 → 两颗单选都不选 → LEAVE 拦住不让下一步，
  ; 表现就是"语言页有但选不了/没预选"。同一个函数在 **kernel32** 的导出里能拿到（2052）。
  ; 再兜一层：读 `HKCU\Control Panel\International\LocaleName`（本机实测 zh-CN）。
  ; 两条都拿不到 → 什么都不预选，交给 LEAVE 拦住（她定的口径：读不到必须自己选）。
  StrCpy $LangChosen ""
  System::Call 'kernel32::GetUserDefaultUILanguage()i.r1'
  ${If} $1 != error
    IntOp $1 $1 & 0x03FF     ; 取主语言号：4=中文 9=英语 7=德语 12=法语 …
    ${If} $1 == 4
      StrCpy $LangChosen "zh"
    ${Else}
      StrCpy $LangChosen "en"
    ${EndIf}
  ${Else}
    ReadRegStr $2 HKCU "Control Panel\International" "LocaleName"
    ${If} $2 != ""
      StrCpy $3 $2 2         ; 前两个字母：zh / en / de / fr …
      ${If} $3 == "zh"
        StrCpy $LangChosen "zh"
      ${Else}
        StrCpy $LangChosen "en"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $LangChosen == "zh"
    SendMessage $LangZh ${BM_SETCHECK} ${BST_CHECKED} 0
  ${ElseIf} $LangChosen == "en"
    SendMessage $LangEn ${BM_SETCHECK} ${BST_CHECKED} 0
  ${EndIf}
  !endif
  ; **这一行是这一页能不能出现的开关。**
  ; nsDialogs 的 create 函数必须以 `nsDialogs::Show` 结尾（官方每个例子都这么写）。
  ; 少了它：函数照常执行、控件照常创建（在控件树里能查到，只是全被隐藏），
  ; 但 NSIS 认为这一页没内容 → **静默跳过**，欢迎页的下一步直接到目录页，
  ; LEAVE 也不会被调用。编译期零警告零报错，所以 131 第一轮"编译通过"完全没挡住它。
  ; 她实测反馈「第二页没有语言选项」→ 控件树走查 → 最小复现 → 补上这一行才修好。
  nsDialogs::Show
FunctionEnd

Function LangPageLeave
  SendMessage $LangZh ${BM_GETCHECK} 0 0 $1
  SendMessage $LangEn ${BM_GETCHECK} 0 0 $2
  ${If} $1 == ${BST_CHECKED}
    StrCpy $LangChosen "zh"
  ${ElseIf} $2 == ${BST_CHECKED}
    StrCpy $LangChosen "en"
  ${Else}
    MessageBox MB_OK|MB_ICONEXCLAMATION "请选一个界面语言后才能继续。"
    Abort
  ${EndIf}
FunctionEnd

; 第 4 个参数是**窗口标题**后缀，NSIS 直接拼在 Caption 后面（不会自动加分隔符），
; 所以要自己带 ": "，否则标题会变成「MDStar 0.1.0 安装界面语言 / Language」这种连读的字。
Page custom LangPageCreate LangPageLeave ": 界面语言 / Language"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_COMPONENTS
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

LangString DESC_SecMain ${LANG_SIMPCHINESE} "MDStar 主程序、开始菜单快捷方式，以及 .md 的「打开方式」登记。必需项。"
LangString DESC_SecDesktop ${LANG_SIMPCHINESE} "在桌面放一个 MDStar 快捷方式。"
LangString DESC_SecDefault ${LANG_SIMPCHINESE} "把 .md / .markdown 的默认打开程序设成 MDStar（默认勾上，不想接管就取消勾选）。安装前会把你原来的默认值记下来，卸载时还原。"
LangString DESC_SecUnMain ${LANG_SIMPCHINESE} "删除程序文件、快捷方式与注册表项（含 .md 关联）。"
LangString DESC_SecUnState ${LANG_SIMPCHINESE} "同时删除设置、最近列表与置顶记录（%APPDATA%\mdsb）。不勾就原样留着，重装还能用。"

; 组件说明（MUI_DESCRIPTION_TEXT 要押 section 的 id 常量，那些常量在 Section 编译后才存在，
; 所以两块说明写在**文件末尾**，不是随手放的 —— 写在前面会报 warning 6000 unknown variable，
; 结果是组件页只有名字没有描述，她看不出第二、三格是干什么的）。

Function .onInit
  ; 当前用户作用域：Shell Folder（桌面 / 开始菜单 / APPDATA）一律取 current，
  ; 免得哪天改成 all-users 安装时把这些写进别人/profile 的目录。
  SetShellVarContext current

  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  ${If} $0 == ""
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "没检测到 Microsoft Edge WebView2 运行时。$\n\
       MDStar 的窗口内容靠它渲染，缺了会白屏或起不来。$\n\
       装好的 Edge（版本 120+）通常自带；没有就装一次 Evergreen Runtime 再运行 MDStar。$\n\
       安装本身会继续，不会因此中止。"
  ${EndIf}
FunctionEnd

; ------------------------------- 安装 -------------------------------

Section "${APP} 主程序" SecMain
  SectionIn RO

  ; 程序还开着时 exe 被占用：先改名（Windows 允许改名被占用的 exe，但不允许覆盖），
  ; 改不动就让她退出后重试 —— 比默默 /REBOOTOK 排到重启后再删干净。
  ;
  ; **改名目标必须一个一个试**：上一次留下的 `MDStar.exe.old` 常常删不掉
  ; （那份旧实例还没死透时 Windows 锁着它的镜像文件），而 `Rename` 在目标已存在时**必定失败** ——
  ; 老代码把这次失败当成"MDStar 正在运行"，于是她看到"进程列表里根本没有 MDStar，
  ; 安装却说它在运行"（1.0.1 装不上就是这个）。所以：先删一次残留，删不掉就换 `.old-2`…`.old-6`，
  ; 六个名字都改不动，才真的是那份 exe 被占着。
  ${If} ${FileExists} "$INSTDIR\${EXE}"
    Delete "$INSTDIR\${EXE}.old"
    StrCpy $R4 "0"
    rename_try:
    IntOp $R4 $R4 + 1
    ${If} $R4 == 1
      StrCpy $R5 "$INSTDIR\${EXE}.old"
    ${Else}
      StrCpy $R5 "$INSTDIR\${EXE}.old-$R4"
    ${EndIf}
    ClearErrors
    Rename "$INSTDIR\${EXE}" "$R5"
    IfErrors 0 old_renamed
      ${If} $R4 < 6
        Goto rename_try
      ${EndIf}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
        "MDStar.exe 改不动 —— 通常是还有 MDStar 窗口（或它的测试版 MDStar-cdp.exe）没退干净。$\n\
         请先退出所有 MDStar，再点「重试」。$\n\
         找不到在跑的窗口就点「取消」，然后删掉安装目录里的 MDStar.exe.old*。" IDRETRY rename_reset
      Abort "MDStar 仍在运行，安装已取消。"
    rename_reset:
    StrCpy $R4 "0"
    Goto rename_try
    old_renamed:
    ; 顺手把更早几次的残留一起清掉（删得掉就删，删不掉不拦安装）
    Delete "$INSTDIR\${EXE}.old-2"
    Delete "$INSTDIR\${EXE}.old-3"
    Delete "$INSTDIR\${EXE}.old-4"
    Delete "$INSTDIR\${EXE}.old-5"
    Delete "$INSTDIR\${EXE}.old-6"
  ${EndIf}

  SetOutPath "$INSTDIR"
  File "${BINDDIR}\${EXE}"
  ; 文件图标单独一份：ProgId 的 DefaultIcon 指它（exe 里那份是应用图标，两个图形不一样）
  File "${BRANDDIR}\${FILEICON}"
  ; 卸载器写进安装目录（漏了这行 = 有卸载代码却没有卸载器，NSIS 只给 warning 6020）
  WriteUninstaller "$INSTDIR\uninstall.exe"
  FileOpen $9 "$INSTDIR\VERSION.txt" w
  FileWrite $9 "${VERSION}$\r$\n"
  FileClose $9

  ; ---- 五个扩展名：各一份 ProgId + 进「打开方式」+ 能力声明，**不动任何人的默认值** ----
  !insertmacro RegisterExt ".md"       "${APP} Markdown 文档"
  !insertmacro RegisterExt ".markdown" "${APP} Markdown 文档"
  !insertmacro RegisterExt ".mdown"    "${APP} Markdown 文档"
  !insertmacro RegisterExt ".mkd"      "${APP} Markdown 文档"
  !insertmacro RegisterExt ".mkdn"     "${APP} Markdown 文档"

  ; 能力声明 + 注册为「已注册应用」：让 MDStar 出现在「设置 > 应用 > 默认应用」的列表里，
  ; 也让她能在系统界面里手工把 .md 指过来（UserChoice 只能由系统/用户写，脚本伪造不了）
  WriteRegStr HKCU "${CAPKEY}"            ""                "${APP}"
  WriteRegStr HKCU "${CAPKEY}\Capabilities" "ApplicationName" "${APP}"
  WriteRegStr HKCU "${CAPKEY}\Capabilities" "ApplicationDescription" "${APP} - Markdown Star Browser"
  WriteRegStr HKCU "${CAPKEY}\Capabilities" "ApplicationIcon"   "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "Software\RegisteredApplications" "${APP}" "${CAPKEY}\Capabilities"

  ; ---- 开始菜单 / App Paths / ARP ----
  CreateDirectory "$SMPROGRAMS\${APP}"
  CreateShortCut "$SMPROGRAMS\${APP}\${APP}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  CreateShortCut "$SMPROGRAMS\${APP}\${APP} 卸载.lnk" "$INSTDIR\uninstall.exe"

  WriteRegStr HKCU "${APPPATHS}" "" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${APPPATHS}" "Path" "$INSTDIR"

  WriteRegStr HKCU "${UNINSTK}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNINSTK}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTK}" "Publisher" "${APP}"
  WriteRegStr HKCU "${UNINSTK}" "DisplayIcon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "${UNINSTK}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTK}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINSTK}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTK}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTK}" "NoRepair" 1
  WriteRegStr HKCU "${REGKEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "Version" "${VERSION}"
  ; 安装期选的语言：应用首启拿它当 settings.lang 的初值（之后以设置为准）
  WriteRegStr HKCU "${LANGREGKEY}" "Language" "$LangChosen"

  ; EstimatedSize 单位是 KB；${GetSize} 把 $0 给成字节/1024 的整数
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINSTK}" "EstimatedSize" $0

  Delete "$INSTDIR\${EXE}.old"
  !insertmacro SHCNE_ASSOCCHANGED
SectionEnd

Section "创建桌面快捷方式" SecDesktop
  CreateShortCut "$DESKTOP\${APP}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
SectionEnd

Section "把 .md / .markdown 的默认打开方式设为 MDStar" SecDefault
  ; **默认勾上**（131 她定的：「默认关联格式要默认选中」）。不想接管就在组件页取消勾选。
  ; 只接管这两个常用的；.mdown / .mkd / .mkdn 只在「打开方式」里可选。
  !insertmacro TakeOverExt ".md"
  !insertmacro TakeOverExt ".markdown"

  WriteRegStr HKCU "${REGKEY}" "TookOverAssoc" "1"
  !insertmacro SHCNE_ASSOCCHANGED
SectionEnd

; ------------------------------- 卸载 -------------------------------

Function un.onInit
  SetShellVarContext current
FunctionEnd

Section "un.${APP} 本体" UnsecMain
  SectionIn RO

  ; 还原接管过的默认关联与 UserChoice（备份过才还原；没接管过这两段都是空转）
  !insertmacro RestoreExt ".md"
  !insertmacro RestoreExt ".markdown"
  DeleteRegKey HKCU "${REGKEY}\AssocBackup"
  DeleteRegKey HKCU "${REGKEY}\UserChoiceBackup"

  ; 撤登记：只删我们自己那一格值 + 我们那份 ProgId（别人在 OpenWithProgids 里的登记必须留着）
  !insertmacro UnregisterExt ".md"
  !insertmacro UnregisterExt ".markdown"
  !insertmacro UnregisterExt ".mdown"
  !insertmacro UnregisterExt ".mkd"
  !insertmacro UnregisterExt ".mkdn"
  ; 下面这五行是**清今天那版安装包的旧登记**（第一版用一份共享 ProgId `MDStar.md` 挂五个扩展名，
  ; 现在改成每个扩展名一份）。已经装过旧包又没先卸载的机器上，不清就会留下悬空值。
  DeleteRegValue HKCU "Software\Classes\.md\OpenWithProgids" "${PROGID}"
  DeleteRegValue HKCU "Software\Classes\.markdown\OpenWithProgids" "${PROGID}"
  DeleteRegValue HKCU "Software\Classes\.mdown\OpenWithProgids" "${PROGID}"
  DeleteRegValue HKCU "Software\Classes\.mkd\OpenWithProgids" "${PROGID}"
  DeleteRegValue HKCU "Software\Classes\.mkdn\OpenWithProgids" "${PROGID}"
  DeleteRegValue HKCU "Software\RegisteredApplications" "${APP}"
  DeleteRegKey HKCU "${CAPKEY}"
  DeleteRegKey HKCU "${APPPATHS}"

  Delete "$SMPROGRAMS\${APP}\${APP}.lnk"
  Delete "$SMPROGRAMS\${APP}\${APP} 卸载.lnk"
  RMDir  "$SMPROGRAMS\${APP}"
  Delete "$DESKTOP\${APP}.lnk"

  Delete "$INSTDIR\${EXE}.old"
  Delete "$INSTDIR\VERSION.txt"
  rename_un:
  ClearErrors
  Rename "$INSTDIR\${EXE}" "$INSTDIR\${EXE}.del"
  IfErrors 0 un_renamed
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
      "MDStar 正在运行，删不掉主程序。请先退出它再点「重试」。" IDRETRY rename_un
    Abort "MDStar 仍在运行，卸载已取消。"
  un_renamed:
  ClearErrors
  Delete "$INSTDIR\${EXE}.del"
  Delete "$INSTDIR\${FILEICON}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${UNINSTK}"
  DeleteRegValue HKCU "${REGKEY}" "TookOverAssoc"
  DeleteRegValue HKCU "${REGKEY}" "InstallDir"
  DeleteRegValue HKCU "${REGKEY}" "Language"
  DeleteRegValue HKCU "${REGKEY}" "Version"
  !insertmacro SHCNE_ASSOCCHANGED
SectionEnd

Section /o "un.同时删除设置与最近列表（%APPDATA%\mdsb）" UnsecState
  ; 内部标识仍是 mdsb（130 定的口径：只改可见层）。旧目录 horseparty 任何情况都不碰。
  RMDir /r "$APPDATA\mdsb"
SectionEnd

; ------------------------------ 组件说明 ------------------------------
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain}    $(DESC_SecMain)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} $(DESC_SecDesktop)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDefault} $(DESC_SecDefault)
!insertmacro MUI_FUNCTION_DESCRIPTION_END

!insertmacro MUI_UNFUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${UnsecMain}  $(DESC_SecUnMain)
  !insertmacro MUI_DESCRIPTION_TEXT ${UnsecState} $(DESC_SecUnState)
!insertmacro MUI_UNFUNCTION_DESCRIPTION_END