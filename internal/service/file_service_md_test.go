package service

import (
	"os"
	"path/filepath"
	"testing"
)

// 137：ListMarkdown 是「插入文档链接」唯一的新宿主原语，
// 它跑在真实文件系统上，所以必须在真盘上测（临时目录），mock 掉就没意义了。
func TestListMarkdown(t *testing.T) {
	root := t.TempDir()
	mk := func(rel string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("# x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mk("README.md")
	mk("docs/审批时效.md")
	mk("docs/sub/周报.markdown")
	mk("docs/skipme.txt")     // 非 Markdown
	mk(".hidden/藏起来的.md") // 隐藏目录
	mk("_data/下划线目录.md")
	mk("node_modules/pkg/别人的.md")

	svc := NewFileService()
	got, err := svc.ListMarkdown(root, 0)
	if err != nil {
		t.Fatalf("ListMarkdown 报错: %v", err)
	}
	names := map[string]bool{}
	for _, e := range got {
		names[filepath.ToSlash(e.Rel)] = true
	}
	for _, want := range []string{"README.md", "docs/审批时效.md", "docs/sub/周报.markdown"} {
		if !names[want] {
			t.Errorf("漏了 %v，实到 %v", want, keys(names))
		}
	}
	for _, bad := range []string{"docs/skipme.txt", ".hidden/藏起来的.md", "_data/下划线目录.md", "node_modules/pkg/别人的.md"} {
		if names[bad] {
			t.Errorf("不该出现 %v", bad)
		}
	}
	// 绝对路径必须是正斜杠且以根开头（前端拿它去 ReadFile）
	for _, e := range got {
		if filepath.Base(e.Path) != e.Name {
			t.Errorf("Path 与 Name 不匹配: %v / %v", e.Path, e.Name)
		}
		if len(e.Path) < len(e.Rel) || e.Path[len(e.Path)-len(e.Rel):] != e.Rel {
			t.Errorf("Rel 不是 Path 的尾部: %v / %v", e.Path, e.Rel)
		}
	}
}

// 上限与深度闸：弹层打开不能卡界面，也不能顺着归档树一路潜到无穷深。
func TestListMarkdownLimits(t *testing.T) {
	root := t.TempDir()
	svc := NewFileService()

	// 1) 平铺 50 个文件，limit=10 必须正好收住
	for i := 0; i < 50; i++ {
		p := filepath.Join(root, "docs", "文档-"+string(rune('A'+i/26))+string(rune('A'+i%26))+".md")
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("# x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := svc.ListMarkdown(root, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 10 {
		t.Errorf("limit 没收住：要 10 条，实到 %d", len(got))
	}
	// 入参超上限要夹回默认值，不能当成"不限制"
	all, _ := svc.ListMarkdown(root, 999999)
	if len(all) > mdScanLimit {
		t.Errorf("limit 越界没夹住：%d > %d", len(all), mdScanLimit)
	}

	// 2) 深度超过 mdScanMaxDepth 的文件不该出现
	deep := filepath.Join(root, "l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(deep, "太深了.md"), []byte("# x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	list, _ := svc.ListMarkdown(root, 0)
	for _, e := range list {
		found[e.Name] = true
	}
	if found["太深了.md"] {
		t.Errorf("超过 %d 层的目录不该再往下扫", mdScanMaxDepth)
	}
}

// 根目录不存在 / 是文件 → 报错（弹层要能给出人话提示，而不是空列表装没事）
func TestListMarkdownErrors(t *testing.T) {
	svc := NewFileService()
	if _, err := svc.ListMarkdown(filepath.Join(t.TempDir(), "根本没有这个目录"), 0); err == nil {
		t.Error("不存在的目录应当报错")
	}
	f := filepath.Join(t.TempDir(), "我是文件.md")
	_ = os.WriteFile(f, []byte("x"), 0o644)
	if _, err := svc.ListMarkdown(f, 0); err == nil {
		t.Error("传文件应当报错")
	}
	if _, err := svc.ListMarkdown("   ", 0); err == nil {
		t.Error("空目录应当报错")
	}
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
