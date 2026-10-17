package service

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

// StateService 提供「按键取值的字符串状态袋」，落盘为单个 JSON。
//
// 本期（M1）它承载三类持久化：最近文件列表、会话（打开的标签 + 光标）、
// 崩溃快照。三者都用「前端自己序列化 JSON 字符串、后端只按 key 存取」的
// 方式，避免每加一种状态就改一次 Go 接口签名。
type StateService struct {
	mu     sync.Mutex
	path   string
	data   map[string]string
	loaded bool
}

func NewStateService() *StateService {
	return &StateService{data: map[string]string{}}
}

// stateFilePath 用户配置目录下的 mdsb/state.json，首次访问时惰性解析。
//
// 2026-10-16 项目由 HorseParty 更名 MDSB，配置目录跟着从 `%APPDATA%\horseparty` 换成 `%APPDATA%\mdsb`。
// 目录名一改，用户原有的「最近文件 / 上次会话 / 主题」就全找不到了 —— 所以这里做**一次性迁移**：
// 新目录里没有 state.json、而旧目录里有，就把旧的那份**复制**过来。
// 三条刻意的选择：① 只复制不搬走（旧文件原样留着，退回上一版程序还能看见自己的现场）；
// ② 复制失败不致命（大不了从空状态开始，绝不能因为迁移把启动弄崩）；
// ③ 只在「新位置没有」时触发，之后每次启动都不再碰旧目录。
func stateFilePath() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		home, herr := os.UserHomeDir()
		if herr != nil {
			return "", err
		}
		base = home
	}
	dir := filepath.Join(base, "mdsb")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "state.json")
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		if legacy, readErr := os.ReadFile(filepath.Join(base, "horseparty", "state.json")); readErr == nil && len(legacy) > 0 {
			_ = os.WriteFile(path, legacy, 0o644)
		}
	}
	return path, nil
}

func (s *StateService) ensureLoaded() {
	if s.loaded {
		return
	}
	s.loaded = true
	if s.path == "" {
		p, err := stateFilePath()
		if err != nil {
			return
		}
		s.path = p
	}
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return
	}
	var m map[string]string
	if json.Unmarshal(raw, &m) == nil {
		s.data = m
	}
}

func (s *StateService) flush() error {
	if s.path == "" {
		return nil
	}
	raw, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Get 读取键值；不存在返回空串。
func (s *StateService) Get(key string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureLoaded()
	return s.data[key]
}

// Set 写入键值并立即落盘。value 传空串等价于删除该键。
func (s *StateService) Set(key string, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureLoaded()
	if value == "" {
		delete(s.data, key)
	} else {
		s.data[key] = value
	}
	return s.flush()
}

// Platform 返回宿主操作系统标识（windows / darwin / linux），
// 前端据此区分窗口按钮行为与快捷键修饰键。
func (s *StateService) Platform() string { return runtime.GOOS }

// AppVersion 返回构建版本号，关于对话框与诊断日志使用。
func (s *StateService) AppVersion() string { return version }

// version 由构建脚本注入
// （-ldflags "-X mdsb/internal/service.version=..."）；源码树默认为 dev。
var version = "0.1.0-dev"
