//go:build cdpdebug

package main

// 桌面实测专用：`go build -tags cdpdebug` 出的二进制开 WebView2 的远程调试端口，
// Playwright 用 `chromium.connectOverCDP('http://127.0.0.1:9222')` 连进去，
// 在**真的桌面壳里**点工具栏、右键表格菜单、按 Ctrl+S，再回读磁盘上的字节。
//
// 这个文件不参与正式构建（默认构建走 cdp_off.go），所以发布包里不会有调试端口。
func cdpExtraArgs() []string { return []string{"--remote-debugging-port=9222"} }
