// Package assetserver 提供本地图片资源的 HTTP 出口。
package assetserver

import (
	"net/http"
	"path/filepath"
	"strings"
)

// LocalFileRoute 是前端拼图片 URL 用的路径前缀。
const LocalFileRoute = "/hp-file"

// 允许通过该路由读出的扩展名。只放图片类型：文档里的 <img> 是唯一的真实需求，
// 收窄到图片可以避免这个端点变成通用文件下载口。
var imageExts = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true,
	".webp": true, ".bmp": true, ".ico": true, ".svg": true, ".avif": true,
}

// LocalFileMiddleware 拦截 `/hp-file?path=<绝对路径>`，把本地图片交给 WebView。
//
// 为什么需要它：桌面壳里页面 origin 不是文件系统，Markdown 中相对路径写法的
// `![](./diagrams/arch.png)` 无法直接解析到磁盘上的图片。
//
// 安全边界说明：本应用的前端本来就能通过 FileService.ReadFile 读任意文件
// （这是「本地文档阅读器」的既定能力），因此该路由没有新增可读范围；
// 真正的约束是「只允许图片扩展名」，避免它被当成通用下载接口。
func LocalFileMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != LocalFileRoute {
			next.ServeHTTP(w, r)
			return
		}
		path := strings.TrimSpace(r.URL.Query().Get("path"))
		ext := strings.ToLower(filepath.Ext(path))
		if path == "" || !filepath.IsAbs(path) || !imageExts[ext] {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		// ServeFile 自带 404 / 条件请求处理，并会按扩展名给 Content-Type
		http.ServeFile(w, r, filepath.FromSlash(path))
	})
}
