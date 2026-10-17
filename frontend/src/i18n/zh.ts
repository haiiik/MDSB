/**
 * 中文文案表 —— **key 的权威来源**（`MsgKey` 由这张表反推，英文表受它约束）。
 *
 * 只放「界面要显示给人看的字」：提示、按钮、状态栏。
 * 不放：内部标识、日志文案、给机器看的字符串。
 */
const zh = {
  "status.words": "{words} 字",
  "status.lines": "{lines} 行",
  "status.headings": "{headings} 标题",
  "status.notOpened": "未打开文档",
  "mode.read": "阅读",
  "mode.edit": "编辑",
  "mode.source": "源码",
  "search.replace": "替换",
  "search.placeholder": "查找",
  "search.replaceAll": "替换全部",
  "dialog.save": "保存",
  "dialog.cancel": "取消",
} as const;

export default zh;
