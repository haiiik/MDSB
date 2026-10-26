// Package service 承载所有暴露给前端的 Go 能力。
//
// 约定：前端永不直接访问文件系统 / 对话框 / 窗口，一律经 host 适配层
// （frontend/src/host）调用本包的服务方法。这样同一份前端代码既能跑在
// Wails 桌面壳里，也能在纯浏览器里跑 mock 宿主，自动化测试不需要起窗口。
package service

import (
	"encoding/base64"
	"io/fs"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// FileService 负责本地读写、原生文件对话框，以及「外部送进来的文件路径」排队。
type FileService struct {
	// mu 保护 queue：argv、拖放、第二实例三条来源都可能并发投递
	mu    sync.Mutex
	queue []string
	// lastDir 记住上次打开/保存的目录，下次对话框默认定位到这里（012）
	lastDir string
}

func NewFileService() *FileService { return &FileService{} }

// 允许通过「双击 / 拖放 / 命令行」送进应用的扩展名。
var openableExts = map[string]bool{
	".md": true, ".markdown": true, ".mdown": true, ".mkd": true, ".mkdn": true,
}

// QueueStartupFile 校验后入队：不存在的、目录、非白名单扩展名一律静默丢弃。
//
// 静默而不是报错，是因为第二实例转发时可能带进来 Wails 自身的启动参数
// （如 --wails-window=1），报错会污染用户界面。
func (s *FileService) QueueStartupFile(path string) bool {
	if path == "" {
		return false
	}
	if !openableExts[strings.ToLower(filepath.Ext(path))] {
		return false
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	s.mu.Lock()
	s.queue = append(s.queue, filepath.ToSlash(path))
	s.mu.Unlock()
	return true
}

// TakeStartupFiles 取走并清空队列。
//
// 前端在「挂载完成」后主动拉一次，之后每次收到 startup-file:ready 信号再拉 ——
// 事件可能早于前端监听注册，直接 Emit 带路径会丢文件。
func (s *FileService) TakeStartupFiles() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.queue
	s.queue = nil
	return out
}

// FileInfo 是前端需要的最小文件元信息。
type FileInfo struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"mtime"` // Unix 秒
	IsDir   bool   `json:"isDir"`
}

// ReadFile 读取文本文件，剥掉 UTF-8 BOM。目录与不存在的文件返回错误。
func (s *FileService) ReadFile(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", errors.New("path is a directory: " + path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimPrefix(string(data), "\ufeff"), nil
}

// WriteFile 原子写入：先写同目录 .tmp 再 rename，避免中途崩溃把原文件写坏。
func (s *FileService) WriteFile(path string, content string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp := path + ".mdsb.tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// writeFileBytes 原子写二进制（116：剪贴板里的图片落盘）。
//
// 工单原文写的是 `WriteFileBytes` 暴露给前端，实现时改成**内部原语**（小写不绑定）：
// wails3 的 TS 生成器把 Go 的 `[]byte` 生成成 `string`（`fileservice.ts:105`），
// 到底按 base64 还是按 UTF-8 解释不确定 —— 形状不确定的东西不给前端用。
// 对外只留下面那个明确写「入参是 base64」的 `WriteFileBase64`，这里当它的底座，Go 单测直接测它。
//
// 三条口径是验收逼出来的，不是随手定的：
//   - **已存在一律不覆盖**，只返回 written=false：去重命中时前端不该重写内容；
//     时间戳序号撞上同名（同一秒、同一台机器外还有人往 assets 里放图）时，
//     覆盖等于**删掉用户原有的文件**。
//   - **空内容直接报错**：0 字节的 png 就是一条指向坏文件的引用。
//   - 失败后不留半截文件：先写同目录临时文件，rename 失败就把临时文件删掉。
func (s *FileService) writeFileBytes(path string, data []byte) (bool, error) {
	if len(data) == 0 {
		return false, errors.New("writeFileBytes: 空内容，不写（会得到一个指向 0 字节的坏引用）")
	}
	if _, err := os.Stat(path); err == nil {
		return false, nil // 已存在：不覆盖
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, err
	}
	tmp := path + ".mdsb.tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return false, err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return false, err
	}
	return true, nil
}

// WriteFileBase64 是 WriteFileBytes 的**传输口径**：
// 桌面壳到前端走 JSON，`[]byte` 在 wails 绑定里的形状不如字符串确定，
// 所以 host 层把字节 base64 后调这里。解码失败直接报错，不留半个文件。
func (s *FileService) WriteFileBase64(path string, dataBase64 string) (bool, error) {
	raw, err := base64.StdEncoding.DecodeString(dataBase64)
	if err != nil {
		// 也不接受 URL 安全字符等变体：口径只有一个，猜不得
		return false, fmt.Errorf("writeFileBase64: 不是合法 base64: %w", err)
	}
	return s.writeFileBytes(path, raw)
}

// Stat 返回文件元信息。
func (s *FileService) Stat(path string) (*FileInfo, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	return &FileInfo{
		Path:    filepath.ToSlash(path),
		Name:    info.Name(),
		Size:    info.Size(),
		ModTime: info.ModTime().Unix(),
		IsDir:   info.IsDir(),
	}, nil
}

// QueueCommandLineFiles 把命令行里能识别的文件参数入队。
//
// 双击关联文件、以及安装后「打开方式 → MDStar」都是 `MDStar.exe <路径>`
// 这种启动方式。含空格的路径必须整体加引号传入，否则会被切成两个参数。
func (s *FileService) QueueCommandLineFiles() int {
	n := 0
	for _, arg := range os.Args[1:] {
		if strings.HasPrefix(arg, "-") {
			continue
		}
		if s.QueueStartupFile(arg) {
			n++
		}
	}
	return n
}

// rememberDir 记下所选文件的所在目录，供下次对话框定位。
func (s *FileService) rememberDir(path string) {
	if path == "" {
		return
	}
	s.mu.Lock()
	s.lastDir = filepath.Dir(path)
	s.mu.Unlock()
}

// PickOpenFile 弹出原生打开对话框，默认定位到上次打开的目录（012 验收）。
func (s *FileService) PickOpenFile() (string, error) {
	s.mu.Lock()
	dir := s.lastDir
	s.mu.Unlock()
	dialog := application.Get().Dialog.OpenFile().
		SetTitle("打开 Markdown").
		AddFilter("Markdown", "*.md;*.markdown;*.mdown;*.mkd;*.mkdn").
		AddFilter("所有文件", "*.*")
	if dir != "" {
		dialog = dialog.SetDirectory(dir)
	}
	path, err := dialog.PromptForSingleSelection()
	if err != nil {
		return "", err
	}
	s.rememberDir(path)
	return path, nil
}

// PickSaveFile 弹出原生另存为对话框，defaultName 作为预填文件名。
func (s *FileService) PickSaveFile(defaultName string) (string, error) {
	s.mu.Lock()
	dir := s.lastDir
	s.mu.Unlock()
	dialog := application.Get().Dialog.SaveFile().
		SetMessage("另存为").
		SetFilename(defaultName).
		AddFilter("Markdown", "*.md;*.markdown;*.mdown;*.mkd").
		AddFilter("所有文件", "*.*")
	if dir != "" {
		dialog = dialog.SetDirectory(dir)
	}
	path, err := dialog.PromptForSingleSelection()
	if err != nil {
		return "", err
	}
	s.rememberDir(path)
	return path, nil
}

// MarkdownEntry 是「插入文档链接」（137）弹层里的一条候选文档。
type MarkdownEntry struct {
	Path string `json:"path"` // 绝对路径，正斜杠（前端一律按正斜杠处理）
	Name string `json:"name"` // 文件名，含扩展名
	Rel  string `json:"rel"`  // 相对**搜索根**的路径（/ 分隔），用于弹层里显示"在哪"
}

const (
	// 一次扫描的硬上限。**宁可少给几条让人继续输关键词，
	// 也不能让弹层一打开就卡住界面** —— 一个 node_modules 里就能有几万个 .md。
	mdScanLimit = 400
	// 最深下潜几层。再深的目录树通常是归档而不是知识库。
	mdScanMaxDepth = 8
)

// skipDirNames 只列**确定不是用户文档**的依赖/版本库目录。
//
// 刻意不把 `dist` / `build` / `out` 放进来：这些名字完全可能是本机就叫这个的文档目录，
// 静默跳过就会变成"我明明有这份文档，弹层里搜不到"，那比多扫几个目录严重得多。
var skipDirNames = map[string]bool{"node_modules": true, ".git": true}

// ListMarkdown 递归列出目录下的 Markdown 文件（137 的宿主原语）。
//
// 三条口径：
//  1. **不跟随符号链接**（用 WalkDir，天然不跟随），避免环路与越界；
//  2. 隐藏目录（以 `.` / `_` 开头）与 node_modules/.git 跳过；
//  3. 单个子目录读不了（权限、被占用）**跳过并继续**，只有根目录本身不可读才报错 ——
//     扫盘是"挑文件"的辅助动作，不该因为一棵树里有一个坏目录就整个失败。
func (s *FileService) ListMarkdown(dir string, limit int) ([]MarkdownEntry, error) {
	root := strings.TrimSpace(filepath.Clean(dir))
	if root == "" {
		return nil, errors.New("目录为空")
	}
	st, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		return nil, fmt.Errorf("不是目录: %s", root)
	}
	if limit <= 0 || limit > mdScanLimit {
		limit = mdScanLimit
	}
	rootDepth := strings.Count(root, string(os.PathSeparator))
	out := make([]MarkdownEntry, 0, 32)

	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			// 子目录读不了：跳过（根目录已在上面 stat 过，不会走到这里）
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		name := d.Name()
		if p != root && (name[0] == '.' || name[0] == '_') {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if skipDirNames[strings.ToLower(name)] {
				return fs.SkipDir
			}
			if strings.Count(p, string(os.PathSeparator))-rootDepth >= mdScanMaxDepth {
				return fs.SkipDir
			}
			return nil
		}
		if !openableExts[strings.ToLower(filepath.Ext(name))] {
			return nil
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil {
			rel = name
		}
		out = append(out, MarkdownEntry{
			Path: filepath.ToSlash(p),
			Name: name,
			Rel:  filepath.ToSlash(rel),
		})
		if len(out) >= limit {
			return filepath.SkipAll
		}
		return nil
	})
	if err != nil && !errors.Is(err, filepath.SkipAll) {
		return out, err
	}
	return out, nil
}
