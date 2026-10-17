package assetserver

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestLocalFileServesImage(t *testing.T) {
	dir := t.TempDir()
	img := filepath.Join(dir, "架构图.png")
	if err := os.WriteFile(img, []byte("fake-png-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 前端传的是正斜杠形式（ToSlash 后的绝对路径）
	urlPath := filepath.ToSlash(img)

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "fell through to next", http.StatusNotFound)
	})
	handler := LocalFileMiddleware(next)

	req := httptest.NewRequest(http.MethodGet, "/hp-file?path="+urlPath, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %q", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != "fake-png-bytes" {
		t.Fatalf("body = %q", rec.Body.String())
	}
	t.Logf("served %s -> %s", urlPath, rec.Header().Get("Content-Type"))
}

func TestLocalFileRejectsNonImageAndRelative(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	handler := LocalFileMiddleware(next)

	for _, q := range []string{
		"/hp-file?path=C:/Windows/system32/cmd.exe", // 非图片
		"/hp-file?path=relative/a.png",              // 非绝对路径
		"/hp-file?path=",                            // 空
		"/hp-file",                                  // 无参数
	} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, q, nil))
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s 应 403，实际 %d", q, rec.Code)
		}
	}

	// 其它路径必须原样透传给内置资源服务器
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/assets/index.js", nil))
	if rec.Code != http.StatusTeapot {
		t.Errorf("非 /hp-file 请求未透传，实际 %d", rec.Code)
	}
}
