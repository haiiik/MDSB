//go:build cdpdebug

package main

// 桌面实测专用：`go build -tags cdpdebug` 出的二进制开 WebView2 的远程调试端口，
// Playwright 用 `chromium.connectOverCDP('http://127.0.0.1:9222')` 连进去，
// 在**真的桌面壳里**点工具栏、右键表格菜单、按 Ctrl+S，再回读磁盘上的字节。
//
// 这个文件不参与正式构建（默认构建走 cdp_off.go），所以发布包里不会有调试端口。
func cdpExtraArgs() []string { return []string{"--remote-debugging-port=9222"} }

// instanceID 是调试包自己的**单实例 ID**。
//
// 为什么要换（134 追加，她实测出来的）：单实例按 UniqueID 认，
// 开发包 / cdp 包和已安装的正式包共用一个 ID 时，「再双击一个 .md」的转交
// 会被**先起来的那个进程**接走 —— 表现成「窗口没到前面」「标签没切到新打开的那篇」。
// 她手动只开一个实例时两条都正常，正好对上这个根因。
//
// 写成**一整个字面量**而不是 `"io.mdsb.app" + 后缀`：拼接结果不保证以连续字节留在二进制里，
// 而验收脚本要在 exe 里直接搜到这个串（搜得到 = 这份构建真的带上了它）。
const instanceID = "io.mdsb.app.cdp"
