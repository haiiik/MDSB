package service

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 116：剪贴板图片落盘的 Go 侧判据。
// 这里只管「原子地写一份二进制，绝不覆盖已有文件」，
// 命名与哈希去重在逻辑层（frontend/src/kernel/paste/images.ts），两侧分开测。

func TestWriteFileBytes_WritesAndCreatesParentDir(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "assets", "20261015-093000-1.png")

	written, err := NewFileService().writeFileBytes(target, []byte{0x89, 'P', 'N', 'G', 0x00, 0x01})
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if !written {
		t.Fatal("新文件应当真的写入")
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != string([]byte{0x89, 'P', 'N', 'G', 0x00, 0x01}) {
		t.Fatalf("内容不符：%v", got)
	}
	// 原子写：不能留下 .tmp 半截文件
	entries, _ := os.ReadDir(filepath.Dir(target))
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp") {
			t.Fatalf("留下半截文件：%s", e.Name())
		}
	}
}

// 已存在就**不覆盖**：去重命中时前端不该重写，序号撞名时更不该把用户的文件顶掉。
func TestWriteFileBytes_NeverOverwritesExisting(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "已有一张 图.png")
	if err := os.WriteFile(target, []byte("原文"), 0o644); err != nil {
		t.Fatal(err)
	}

	written, err := NewFileService().writeFileBytes(target, []byte("新内容"))
	if err != nil {
		t.Fatalf("已存在不该报错，只该返回未写入：err = %v", err)
	}
	if written {
		t.Fatal("已存在的文件被覆盖了")
	}
	got, _ := os.ReadFile(target)
	if string(got) != "原文" {
		t.Fatalf("原内容被改： %q", got)
	}
}

// 父路径是个文件 → 建目录就失败：必须报错，且不能在别处留下半截文件。
func TestWriteFileBytes_UnwritableTarget(t *testing.T) {
	dir := t.TempDir()
	blocker := filepath.Join(dir, "assets")
	if err := os.WriteFile(blocker, []byte("我占着 assets 这个名字"), 0o644); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(blocker, "x.png")

	if _, err := NewFileService().writeFileBytes(target, []byte("data")); err == nil {
		t.Fatal("目录不可写时应当报错")
	}
	// 报错后原来那个文件内容不许被动过（不留半截、不损坏）
	got, _ := os.ReadFile(blocker)
	if string(got) != "我占着 assets 这个名字" {
		t.Fatalf("占位文件被改动：%q", got)
	}
}

// 空字节不是「一张图片」，写出去就是一条指向 0 字节文件的坏引用。
func TestWriteFileBytes_RejectsEmpty(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "a", "empty.png")
	_, err := NewFileService().writeFileBytes(target, nil)
	if err == nil {
		t.Fatal("空内容应拒绝")
	}
	if _, statErr := os.Stat(filepath.Dir(target)); statErr == nil {
		t.Fatal("拒绝之后不该已经把目录建出来又什么都不写")
	}
}

// 桌面壳到前端的传输口径：base64 那份必须与 []byte 那份等价
// （JSON 传二进制在 wails 的绑定里形状不确定，所以 host 侧走 base64）。
func TestWriteFileBase64_MatchesBytes(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "b.png")
	if _, err := NewFileService().WriteFileBase64(target, "iVBORw0KGgo="); err != nil {
		t.Fatalf("err = %v", err)
	}
	got, _ := os.ReadFile(target)
	if string(got) != "\x89PNG\r\n\x1a\n" {
		t.Fatalf("解码不符：%v", got)
	}
	// 非法 base64 要报错，不能写出一份坏文件
	if _, err := NewFileService().WriteFileBase64(filepath.Join(dir, "c.png"), "!!!"); err == nil {
		t.Fatal("非法 base64 应当报错")
	}
	if _, statErr := os.Stat(filepath.Join(dir, "c.png")); statErr == nil {
		t.Fatal("非法 base64 却留下了文件")
	}
}
