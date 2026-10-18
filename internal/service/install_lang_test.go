package service

import "testing"

// 安装期语言只认两种码；其余一律"没有意见"（空串），不替用户猜。
func TestNormalizeInstallLang(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{"zh", "zh"},
		{"ZH", "zh"},
		{" zh ", "zh"},
		{"zh-CN", "zh"},
		{"zh-Hans", "zh"},
		{"en", "en"},
		{"en-US", "en"},
		{"EN-GB", "en"},
		{"", ""},
		{"fr", ""},          // 认不出来的语言 ≠ 英文
		{"Japanese", ""},
		{"zh-TW", ""},       // 繁中不在双选里，别悄悄映射成简中
	}
	for _, c := range cases {
		if got := normalizeInstallLang(c.raw); got != c.want {
			t.Errorf("normalizeInstallLang(%q) = %q, 期望 %q", c.raw, got, c.want)
		}
	}
}
