package main

import (
	"embed"
	"log"

	"mdsb/internal/assetserver"
	"mdsb/internal/service"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// 前端产物：frontend/dist 下的全部文件被嵌入二进制，由 Asset 处理器对内提供。
//
//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/appicon.png
var appIconPNG []byte

// StartupFileEvent 是「有新路径待打开」的信号事件名。
// 只发信号不带路径：事件可能早于前端监听注册，路径必须留在 Go 侧队列里等取。
const StartupFileEvent = "startup-file:ready"

func main() {
	fileService := service.NewFileService()
	stateService := service.NewStateService()
	appService := service.NewAppService()

	// 命令行带来的文件先入队，等前端挂载完再取（事件早于监听注册会丢）
	fileService.QueueCommandLineFiles()

	var mainWindow *application.WebviewWindow
	var app *application.App

	app = application.New(application.Options{
		Name:        "MDStar",
		Description: "A local-first Markdown reader & editor.",
		// 文件关联：仅声明扩展名，Wails 才会把「MDStar.exe <路径>」
		// 解析成 ApplicationOpenedWithFile 事件。写注册表由安装器负责。
		FileAssociations: []string{".md", ".markdown", ".mdown", ".mkd", ".mkdn"},
		// 单实例（013）：已运行时再双击文件，不起第二个进程，
		// 而是把路径转交给已有实例的队列并唤起主窗口。
		// ID 按构建档分开（134 追加）：cdp 调试包不再和已装正式包抢转交，见 cdp_on/cdp_off。
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: instanceID,
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				for _, arg := range data.Args {
					fileService.QueueStartupFile(arg)
				}
				if mainWindow != nil {
					mainWindow.Show()
					mainWindow.UnMinimise()
					mainWindow.Focus()
				}
				app.Event.Emit(StartupFileEvent)
			},
		},
		Services: []application.Service{
			application.NewService(fileService),
			application.NewService(stateService),
			application.NewService(appService),
		},
		Assets: application.AssetOptions{
			Handler:    application.AssetFileServerFS(assets),
			Middleware: assetserver.LocalFileMiddleware,
		},
		Windows: application.WindowsOptions{
			// 桌面实测的远程调试端口，只在 `-tags cdpdebug` 的测试二进制里非空。
			// 正式构建里 cdpExtraArgs() 返回 nil，等价于不设这一项。
			AdditionalBrowserArgs: cdpExtraArgs(),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	// 关闭拦截：去掉 Windows.WindowClosing -> Common.WindowClosing 的默认翻译，
	// 否则框架内部监听器会无条件销毁窗口，前端就来不及弹「未保存确认」。
	mapping := make(map[events.WindowEventType]events.WindowEventType, len(events.DefaultWindowEventMapping()))
	for source, target := range events.DefaultWindowEventMapping() {
		mapping[source] = target
	}
	delete(mapping, events.Windows.WindowClosing)

	win := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "MDStar",
		Width:            1280,
		Height:           860,
		MinWidth:         720,
		MinHeight:        480,
		BackgroundColour: application.NewRGB(246, 243, 237),
		URL:              "/",
		// 无边框（015）：原生标题栏去掉，三键与拖动由前端 TopBar 实现。
		// 不启用 WebView2CompositionHosting / NonClientRegionSupport ——
		// beta.24 上组合托管会让 WebView2 初始化等 controller 60s 超时后退出，
		// 而 CSS 非客户区跟踪恰好绑在组合托管上，只开跟踪开关时按钮全无响应。
		Frameless: true,
		Windows:   application.WindowsWindow{EventMapping: mapping},
	})
	mainWindow = win

	// 「打开方式 → MDStar」：Wails 解析命令行后经此事件交出路径。
	// 与 QueueCommandLineFiles 双保险，两条路都只做入队，不直接通知前端。
	app.Event.OnApplicationEvent(events.Common.ApplicationOpenedWithFile, func(event *application.ApplicationEvent) {
		fileService.QueueStartupFile(event.Context().Filename())
	})

	// 从资源管理器拖 .md 进窗口（012）：同样只入队，再发信号让前端来取
	win.OnWindowEvent(events.Common.WindowFilesDropped, func(event *application.WindowEvent) {
		for _, f := range event.Context().DroppedFiles() {
			fileService.QueueStartupFile(f)
		}
		app.Event.Emit(StartupFileEvent)
	})

	// 原生 X / Alt+F4：先问前端（有未保存内容时它会弹确认），
	// 前端确认后调 AppService.Quit() 再放行。
	win.OnWindowEvent(events.Windows.WindowClosing, func(*application.WindowEvent) {
		if appService.QuitAllowed() {
			win.Close()
			return
		}
		app.Event.Emit("window:close-request")
	})

	// 任务栏 / 窗口图标
	app.SetIcon(appIconPNG)

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
