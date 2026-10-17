//go:build !cdpdebug

package main

// cdpExtraArgs 在正常构建里什么都不加。
//
// 只有 `go build -tags cdpdebug` 出的**测试专用二进制**才会开远程调试端口
// （见 cdp_on.go）。正式包里没有这个开关，也就不存在「线上留了个 9222 端口」。
func cdpExtraArgs() []string { return nil }
