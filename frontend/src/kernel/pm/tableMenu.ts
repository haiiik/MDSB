import { Plugin, TextSelection } from "prosemirror-state";
import { t } from "../../i18n";
import { addRowAfter, deleteRow, isInTable } from "prosemirror-tables";
import type { Command } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import {
  commandApplies,
  insertColumn,
  insertRowBefore,
  moveColumn,
  moveRow,
  removeColumn,
  toggleFirstRowHeader,
} from "./tableCommands";

/**
 * 112：表格的行列菜单（US-33 后半）。
 *
 * 右键落在单元格上时先**把光标移到那一格**再跑命令 ——
 * 否则命令作用在用户上一次点击的位置，表现为「菜单对另一行生效了」。
 *
 * 菜单 DOM 挂在 `document.body` 而不是编辑器里：挂进 contenteditable 会让 PM
 * 试图把菜单同步回文档模型。
 *
 * 置灰判定跑 `commandApplies`（带空 dispatch 试一遍），与执行共用同一套边界条件，
 * 不会出现「菜单说可以、命令却什么都不做」。
 */

export type Entry = { kind: "sep" } | { kind: "item"; label: string; command: Command };

/**
 * 菜单项。**是函数不是常量**：133 那轮把界面文案收进字典之后，
 * 常量等于「模块第一次 import 时就把语言烘死了」，设置里切成 English 也来不及（她要的是当场生效）。
 * 菜单每次右键都重建，所以调一次取一次最新语言的标签。
 */
export function tableMenuEntries(): Entry[] {
  return [
    { kind: "item", label: t("table.addRowAbove"), command: insertRowBefore() },
    { kind: "item", label: t("table.addRowBelow"), command: addRowAfter },
    { kind: "item", label: t("table.moveRowUp"), command: moveRow(-1) },
    { kind: "item", label: t("table.moveRowDown"), command: moveRow(1) },
    { kind: "sep" },
    { kind: "item", label: t("table.addColumnLeft"), command: insertColumn(-1) },
    { kind: "item", label: t("table.addColumnRight"), command: insertColumn(1) },
    { kind: "item", label: t("table.moveColumnLeft"), command: moveColumn(-1) },
    { kind: "item", label: t("table.moveColumnRight"), command: moveColumn(1) },
    { kind: "sep" },
    { kind: "item", label: t("table.toggleHeader"), command: toggleFirstRowHeader() },
    { kind: "item", label: t("table.deleteRow"), command: deleteRow },
    { kind: "item", label: t("table.deleteColumn"), command: removeColumn() },
  ];
}

let openMenu: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

function closeMenu() {
  cleanup?.();
  cleanup = null;
  openMenu?.remove();
  openMenu = null;
}

export function tableMenuPlugin(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        contextmenu: (view: EditorView, event: MouseEvent) => {
          const found = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (!found) return false;

          // 光标先落到被右键的那一格，否则命令会作用在用户上一次点击的位置，
          // 表现为「菜单对另一行生效了」。
          const $pos = view.state.doc.resolve(found.pos);
          view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)));

          if (!isInTable(view.state)) return false;
          event.preventDefault();
          showMenu(view, event.clientX, event.clientY);
          return true;
        },
      },
    },
  });
}

function showMenu(view: EditorView, x: number, y: number) {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "hp-tablemenu";
  menu.dataset.testid = "table-menu";

  for (const entry of tableMenuEntries()) {
    if (entry.kind === "sep") {
      const sep = document.createElement("div");
      sep.className = "hp-tablemenu__sep";
      menu.appendChild(sep);
      continue;
    }
    const li = document.createElement("button");
    li.type = "button";
    li.className = "hp-tablemenu__item";
    li.dataset.testid = "table-menu-item";
    li.textContent = entry.label;
    // 判定与执行共用命令本身：拿空 dispatch 试跑一遍就是「能不能做」，
    // 不会出现「菜单说可以、命令却什么都不做」
    const enabled = commandApplies(entry.command, view.state, view);
    if (!enabled) li.classList.add("is-disabled");
    li.addEventListener("click", () => {
      closeMenu();
      if (!enabled) return;
      entry.command(view.state, (tr) => view.dispatch(tr), view);
      view.focus();
    });
    menu.appendChild(li);
  }

  menu.style.left = x + "px";
  menu.style.top = y + "px";
  document.body.appendChild(menu);
  openMenu = menu;

  // 贴边纠正：表格常位于正文右侧，右键最右那一列时菜单会溢出视口（先挂上才量得到尺寸）
  const box = menu.getBoundingClientRect();
  const pad = 8;
  menu.style.left = Math.max(pad, Math.min(x, window.innerWidth - box.width - pad)) + "px";
  menu.style.top = Math.max(pad, Math.min(y, window.innerHeight - box.height - pad)) + "px";

  const dismiss = (e: Event) => {
    if (!menu.contains(e.target as Node)) closeMenu();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeMenu();
  };
  document.addEventListener("mousedown", dismiss, true);
  window.addEventListener("keydown", onKey);
  // 关掉时必须摘掉监听：否则每开一次菜单就多挂一对全局监听，
  // 且旧菜单节点已被移除，`dismiss` 里的 `menu.contains` 永远为真 → 点哪都算「点外面」
  cleanup = () => {
    document.removeEventListener("mousedown", dismiss, true);
    window.removeEventListener("keydown", onKey);
  };
}
