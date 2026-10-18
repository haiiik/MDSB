//go:build windows

package service

import "golang.org/x/sys/windows/registry"

// installLanguage 读安装器写下的界面语言。
//
// 只读 HKCU：131 的包是「当前用户安装」，键也写在当前用户下，
// 不需要提权、也不会碰到别的账号。任何一步失败都返回空串 = 「没有安装期意见」，
// 让前端回落默认值，而不是把启动弄出错。
func installLanguage() string {
	k, err := registry.OpenKey(registry.CURRENT_USER, installRegKey, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	v, _, err := k.GetStringValue(installRegValue)
	if err != nil {
		return ""
	}
	return normalizeInstallLang(v)
}
