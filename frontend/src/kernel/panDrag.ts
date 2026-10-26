/**
 * 151（10-22：「mermaid 图上右键按住滑动」，我第一版做成了大图灯箱里的平移，
 * 这轮把口径说死：「直接在正文里那张图上按住右键，把图拖着看
 * （图比正文宽的时候，横向滑那段溢出，左键仍然留给选字 / 改字）」）。
 *
 * 所以这条手势作用在**正文里那个横向溢出的容器**上（`.hp-mermaidbox__svg`，
 * 阅读档与编辑档同一个类名），拖的是它自己的 `scrollLeft`，不是页面、也不是图。
 *
 * 为什么只认右键：左键在那张图上有别的含义 —— 阅读档要能选中字、编辑档要能双击改字
 * （125/126/127 那套），再让左键按住拖=平移就成了同一个手势两种意思，两边都做不好。
 * 右键在图上本来什么都不做（只弹系统菜单），拿它当"抓手"是白捡的一条路。
 *
 * 阅读档与编辑档**共用这一份**：两处各写一遍早晚改岔（本项目吃过「预览与插入各拼一次」的亏）。
 */

/**
 * 给一个可横向滚动的元素挂上「右键按住拖 = 滑那段溢出」。
 * 返回解除函数（NodeView 销毁时要调，别把监听留在被复用的 DOM 上）。
 */
export function attachRightButtonPan(el: HTMLElement): () => void {
  let 拖着 = false;
  let 起点 = 0;
  let 起始滚动 = 0;

  const onDown = (e: PointerEvent) => {
    // 只认右键（button 2 = 次键）。中键留给"新开"之类，左键按上面的口径不动。
    if (e.button !== 2) return;
    /*
     * 不挡默认动作就会白忙：右键按在文字上会**起一段选区**，
     * 拖出去满屏蓝糊糊的笔画，图反而不动（抱怨的正是这个观感）。
     */
    e.preventDefault();
    拖着 = true;
    起点 = e.clientX;
    起始滚动 = el.scrollLeft;
    el.dataset.hpPanning = "1";
    /*
     * 捕获到容器自己身上：手指/鼠标移出图的边界也继续跟，
     * 不然拖到边缘就断，得重新按一次。
     */
    el.setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: PointerEvent) => {
    if (!拖着) return;
    el.scrollLeft = 起始滚动 - (e.clientX - 起点);
  };

  const onUp = () => {
    if (!拖着) return;
    拖着 = false;
    delete el.dataset.hpPanning;
  };

  // 松手那一刻不弹系统菜单（弹了就得再点一下才能继续，拖着看的手感就断了）
  const onMenu = (e: MouseEvent) => {
    if (拖着 || e.button === 2) e.preventDefault();
  };

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  el.addEventListener("contextmenu", onMenu);

  return () => {
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onUp);
    el.removeEventListener("contextmenu", onMenu);
    delete el.dataset.hpPanning;
  };
}
