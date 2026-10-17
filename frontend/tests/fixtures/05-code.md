带语言标注：

```go
package main

import "fmt"

func main() {
	fmt.Println("hello, MDStar")
}
```

无语言标注：

```
不定长文本
第二行
```

代码里含反引号与伪围栏：

```md
行内代码写作 `code`，围栏示例：

```text
这行在代码块内部，不应被当作新块
```
```

PowerShell（含 `$` 与转义）：

```powershell
$env:GOPROXY = "https://goproxy.cn,direct"
Write-Output "路径：$PWD"
```

JSON：

```json
{
  "name": "mdsb",
  "sizes": [16, 32, 48, 64, 128, 256],
  "solid": true
}
```
