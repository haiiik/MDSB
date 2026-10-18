package service

import "strings"

// 安装期语言：NSIS 向导里的「界面语言」那一页把选择写进
// `HKCU\Software\MDStar\Language`（值只有 "zh" / "en" 两种）。
// 这里是应用侧的读取入口 —— 装的时候选过，首启就按那个来；
// 一旦用户在设置里改过（settings.v1 里存了 lang），就以存值为准。
const (
	installRegKey   = `Software\MDStar`
	installRegValue = "Language"
)

// normalizeInstallLang 把注册表里的值收敛成前端认识的两种语言码。
// 认不出来一律返回空串（= 没有安装期意见），让前端回落默认值，
// **不要**在这里替用户猜一个 —— 猜错的表现是"装了英文包结果界面是中文"，最难查。
func normalizeInstallLang(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "zh", "zh-cn", "zh-hans", "chinese":
		return "zh"
	case "en", "en-us", "en-gb", "english":
		return "en"
	default:
		return ""
	}
}
