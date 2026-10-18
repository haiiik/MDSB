//go:build !windows

package service

// installLanguage 非 Windows 平台没有那个注册表键，恒返回空串。
// （Linux 打包是后面的事；这里先保证跨平台能编译，语义是"没有安装期意见"。）
func installLanguage() string { return "" }
