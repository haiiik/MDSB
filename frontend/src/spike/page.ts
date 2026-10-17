import { mountZoomSpike, type HitResult } from "./zoom";

/**
 * 025 验证页（`?page=zoom-spike`）：左边是缩放后的 ProseMirror 编辑器，
 * 右边是自动命中测试的结果表。人可以手动点，也可以让 Playwright 跑断言。
 */
export function mountSpikePage(root: HTMLElement): void {
  root.innerHTML = `
    <div class="spike-layout">
      <section class="spike-main">
        <header class="spike-bar">
          <strong>025 CSS zoom 命中验证</strong>
          <label>缩放
            <select id="spike-zoom">
              ${[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
                .map((z) => `<option value="${z}"${z === 1 ? " selected" : ""}>${Math.round(z * 100)}%</option>`)
                .join("")}
            </select>
          </label>
          <button id="spike-run">跑自动命中</button>
          <span id="spike-summary" class="spike-summary"></span>
        </header>
        <div id="spike-host" data-spike-scroll class="spike-host"></div>
      </section>
      <aside class="spike-side">
        <h2>命中结果</h2>
        <table class="spike-results">
          <thead><tr><th>目标词</th><th>光标落在</th><th>判定</th></tr></thead>
          <tbody id="spike-rows"></tbody>
        </table>
        <h2>输入法</h2>
        <p class="spike-note">
          中文候选框定位只能人工验：把缩放切到 150% / 200%，在正文里打一遍
          「审批时效监控」，看候选框是否贴着光标。
        </p>
      </aside>
    </div>
    <style>
      .spike-layout { display: flex; height: 100%; font-family: var(--hp-font-ui); }
      .spike-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .spike-bar { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid #ddd; }
      .spike-bar select, .spike-bar button { padding: 3px 10px; }
      .spike-summary { color: #666; font-size: 12px; }
      .spike-host { flex: 1; overflow: auto; padding: 16px; background: #fafafa; }
      .spike-editor { max-width: 760px; margin: 0 auto; padding: 24px; background: #fff; border: 1px solid #e3e3e3; }
      .spike-editor table { border-collapse: collapse; }
      .spike-editor td, .spike-editor th { border: 1px solid #999; padding: 4px 8px; }
      .spike-editor [data-w] { background: rgba(39,74,122,.08); border-radius: 2px; }
      .spike-side { width: 320px; border-left: 1px solid #ddd; padding: 12px; overflow: auto; }
      .spike-side h2 { font-size: 13px; margin: 12px 0 6px; }
      .spike-results { width: 100%; border-collapse: collapse; font-size: 12px; }
      .spike-results td, .spike-results th { border-bottom: 1px solid #eee; padding: 4px; text-align: left; }
      .spike-ok { color: #1c7a41; font-weight: 600; }
      .spike-bad { color: #b3261e; font-weight: 600; }
      .spike-note { font-size: 12px; color: #666; line-height: 1.7; }
    </style>
  `;

  const host = root.querySelector<HTMLElement>("#spike-host")!;
  const rows = root.querySelector<HTMLElement>("#spike-rows")!;
  const summary = root.querySelector<HTMLElement>("#spike-summary")!;
  const zoomSelect = root.querySelector<HTMLSelectElement>("#spike-zoom")!;

  const spike = mountZoomSpike(host);
  spike.setZoom(Number(zoomSelect.value));

  zoomSelect.addEventListener("change", () => {
    spike.setZoom(Number(zoomSelect.value));
    summary.textContent = `已切到 ${zoomSelect.value}`;
  });

  function runAuto() {
    const results = spike.allHits();
    rows.innerHTML = results
      .map(
        (r) =>
          `<tr><td>${r.want}</td><td>${r.got}</td><td class="${r.ok ? "spike-ok" : "spike-bad"}">${
            r.ok ? "命中" : "偏移"
          }</td></tr>`
      )
      .join("");
    const bad = results.filter((r) => !r.ok).length;
    summary.textContent = `${results.length - bad}/${results.length} 命中（zoom=${zoomSelect.value}）`;
    (window as unknown as { __spikeResults?: HitResult[] }).__spikeResults = results;
  }

  root.querySelector("#spike-run")!.addEventListener("click", runAuto);

  function runAutoAndReturn(): HitResult[] {
    runAuto();
    return (window as unknown as { __spikeResults?: HitResult[] }).__spikeResults ?? [];
  }

  (window as unknown as { __spikeRun?: () => HitResult[] }).__spikeRun = runAutoAndReturn;

  (window as unknown as { __spikeDrag?: (a: string, b: string) => { text: string; ok: boolean } }).__spikeDrag = (
    a,
    b
  ) => spike.dragSelect(a, b);
}
