import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";
import "./styles/reading.css";
/* 154：纸面样式（@media print）排在最后 —— 与上面同权重的规则要靠"后者赢"覆盖 */
import "./styles/print.css";
import { installReadyProbe } from "./kernel/perf";

installReadyProbe();

/**
 * `?page=zoom-spike` 走 025 技术验证页。
 *
 * 单独一条入口有两个好处：验证页可以按需动态 import，主包不带 ProseMirror；
 * 并且它不依赖应用状态，跑 Playwright 时不用先打开文档。
 */
if (new URLSearchParams(window.location.search).get("page") === "zoom-spike") {
  void import("./spike/page").then(({ mountSpikePage }) => {
    const el = document.getElementById("app");
    if (el) mountSpikePage(el);
  });
} else {
  createApp(App).mount("#app");
}
