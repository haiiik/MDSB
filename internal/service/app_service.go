package service

import (
	"os/exec"
	"path/filepath"
	"runtime"
	"sync/atomic"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// AppService 承载「与应用生命周期/系统集成相关、但不属于文件也不属于状态」的能力。
type AppService struct {
	// allowQuit 是关闭拦截的闸门：只有前端确认过（或已放弃未保存内容）才置真，
	// 之后窗口关闭事件才真正放行。避免「原生 X 直接杀进程丢内容」。
	allowQuit atomic.Bool
}

func NewAppService() *AppService { return &AppService{} }

// AllowQuit 由前端在用户确认退出后调用。
func (s *AppService) AllowQuit() { s.allowQuit.Store(true) }

// QuitAllowed 供窗口关闭回调判断是否放行。
func (s *AppService) QuitAllowed() bool { return s.allowQuit.Load() }

// Quit 立即退出应用（已确认过的路径）。
func (s *AppService) Quit() {
	s.allowQuit.Store(true)
	if app := application.Get(); app != nil {
		go app.Quit()
	}
}

// RevealInFolder 在系统文件管理器里选中该文件。
//
// 只在桌面端有意义，浏览器 mock 下前端会把菜单项置灰（capabilities.revealInFolder）。
func (s *AppService) RevealInFolder(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	switch runtime.GOOS {
	case "windows":
		// explorer 的 /select 要求反斜杠且逗号前无空格
		return exec.Command("explorer", "/select,"+abs).Start()
	case "darwin":
		return exec.Command("open", "-R", abs).Start()
	default:
		return exec.Command("xdg-open", filepath.Dir(abs)).Start()
	}
}
