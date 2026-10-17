import { Schema } from "prosemirror-model";
import { schema as basicSchema } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";
import { tableNodes } from "prosemirror-tables";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import "prosemirror-view/style/prosemirror.css";

/**
 * 025 技术验证：ProseMirror 放进 CSS `zoom` 容器后，坐标映射还对不对。
 *
 * 结论决定 D16 的整体缩放方案，所以判定做成**自动**的，不靠人眼看截图：
 *
 * 1. 程序化构造文档，记下每个目标词在文档模型里的位置（不靠 DOM 上的标记 ——
 *    PM 会按自己的模型重建 DOM，解析期塞进去的 span 会被丢掉，
 *    第一版就是这么踩空的：doc.size 0、posAtCoords 全 null）；
 * 2. 正向：`coordsAtPos(词内位置)` 问 PM 要屏幕坐标；
 * 3. 反向：把该坐标喂给 `posAtCoords`，看是否回到同一个文档位置（往返一致）；
 * 4. 交叉：`document.elementFromPoint(该坐标)` 必须落在编辑器内，
 *    证明 PM 给的坐标与浏览器命中的是同一处，而不是两边各自偏移。
 *
 * 输入法候选框定位仍需人工验（脚本无法覆盖），在验证页右侧有人工步骤说明。
 *
 * 访问方式：`?page=zoom-spike`（独立 chunk，主界面不加载 ProseMirror）。
 */

/**
 * 组合 schema：basic 的节点表 + 列表节点 + 表格节点。
 *
 * 必须用 `basicSchema.spec.nodes`（NodeSpec 的有序表）再 append，
 * 不能直接展开 `basicSchema.nodes` —— 那是已实例化的 NodeType，
 * 交给 Schema 构造函数会得到一个「什么都解析不出来」的空文档，
 * 表现为 doc.size = 0、posAtCoords 一律返回 null（本文件第一版就踩了）。
 *
 * 另外注意：prosemirror-schema-basic **不含列表**，
 * bullet_list / list_item 要从 prosemirror-schema-list 显式加进来，
 * 否则 `s.nodes.bullet_list.create(...)` 直接抛 undefined.create。
 */
const spikeSchema = new Schema({
  nodes: addListNodes(
    basicSchema.spec.nodes.append(
      tableNodes({
        tableGroup: "block",
        cellContent: "paragraph+",
        cellAttributes: { background: { default: null } },
      })
    ),
    "paragraph+",
    "block"
  ),
  marks: basicSchema.spec.marks,
});

/** 每个目标词的文本，全局唯一，便于在文档里精确定位 */
export const SPIKE_WORDS: Record<string, string> = {
  w1: "审批时效",
  w2: "全部环节",
  w3: "技术复核",
  w4: "形式审查",
  w5: "主管审批",
  w6: "指标口径",
  w7: "慢单线",
  w8: "阈值按事项类型",
  w9: "超时提醒的触达渠道需要与运维侧确认后再定",
  w10: "站内信还是企业微信",
};

function p(...parts: Array<keyof typeof SPIKE_WORDS | string>) {
  return spikeSchema.nodes.paragraph.create(
    null,
    parts.map((x) => {
      const t = (SPIKE_WORDS as Record<string, string>)[x] ?? (x as string);
      return spikeSchema.text(t);
    })
  );
}

function buildDoc() {
  const s = spikeSchema;
  const cell = (text: string) => s.nodes.table_cell.create(null, s.nodes.paragraph.create(null, s.text(text)));
  const row = (a: string, b: string) => s.nodes.table_row.create(null, [cell(a), cell(b)]);
  return s.nodes.doc.create(null, [
    s.nodes.heading.create({ level: 1 }, s.text("缩放命中验证")),
    p("w1", "监控需要覆盖 ", "w2", "，其中 ", "w3", " 是最容易卡住的一步。"),
    s.nodes.bullet_list.create(null, [
      s.nodes.list_item.create(null, s.nodes.paragraph.create(null, [s.text(SPIKE_WORDS.w4), s.text(" 平均 1.2 小时")])),
      s.nodes.list_item.create(null, s.nodes.paragraph.create(null, [s.text(SPIKE_WORDS.w5), s.text(" 平均 3.8 小时")])),
    ]),
    s.nodes.table.create(null, [row(SPIKE_WORDS.w6, SPIKE_WORDS.w7), row("8.1", "12%")]),
    s.nodes.code_block.create(null, s.text("const threshold = 24; // 代码块只撑排版")),
    p("代码块后面这句也要点得准：", "w8", "。"),
    p("末尾一行长文本用于跨行拖选：", "w9", "，下一句是 ", "w10", "。"),
  ]);
}

/**
 * 找出每个目标词在文档模型里的位置（词首字符的文档位置）。
 *
 * 用 indexOf 而不是整节点相等比较：PM 会把同一段落里标记相同的相邻文本节点
 * 合并成一个，所以「词」往往不是独立节点，而是某个大文本片段中间的一段。
 * descendants 按文档顺序遍历，第一个命中的就是它。
 */
function locateWords(doc: ReturnType<typeof buildDoc>): Record<string, number> {
  const out: Record<string, number> = {};
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (const [id, text] of Object.entries(SPIKE_WORDS)) {
      if (out[id] !== undefined) continue;
      const i = node.text.indexOf(text);
      if (i >= 0) out[id] = pos + i;
    }
  });
  return out;
}

export interface HitResult {
  want: string;
  got: string;
  ok: boolean;
}

export interface SpikeHandle {
  setZoom(z: number): void;
  hit(w: string): HitResult;
  dragSelect(from: string, to: string): { text: string; ok: boolean };
  allHits(): HitResult[];
  destroy(): void;
}

export function mountZoomSpike(host: HTMLElement): SpikeHandle {
  const wrap = document.createElement("div");
  wrap.className = "spike-zoom";
  const editor = document.createElement("div");
  editor.className = "spike-editor";
  wrap.appendChild(editor);
  host.replaceChildren(wrap);

  const doc = buildDoc();
  const positions = locateWords(doc);
  const view = new EditorView(editor, { state: EditorState.create({ doc, schema: spikeSchema }) });
  (window as unknown as { __spikeView?: EditorView }).__spikeView = view;

  /**
   * 先把目标位置滚进可视区再量坐标。
   *
   * 注意要滚**真正的滚动容器**：这里编辑器本身不滚，滚的是外面那层
   * `data-spike-scroll`。滚错元素的话高倍缩放下靠后的词仍在视口外，
   * `elementFromPoint` 找不到编辑器 —— 那是测量条件不成立，不是坐标映射错
   * （175%/200% 第一轮的「偏移」全是这个假阳性：位置往返其实完全正确）。
   */
  function scrollPosIntoView(pos: number) {
    const scroller = (view.dom.closest("[data-spike-scroll]") as HTMLElement) ?? view.dom;
    const c = view.coordsAtPos(pos);
    const rect = scroller.getBoundingClientRect();
    if (c.top < rect.top + 8 || c.bottom > rect.bottom - 8) {
      scroller.scrollTop += c.top - rect.top - 60;
    }
  }

  return {
    setZoom(z: number) {
      wrap.style.zoom = String(z);
    },

    hit(id: string): HitResult {
      const start = positions[id];
      if (start === undefined) return { want: id, got: "<未定位>", ok: false };
      const target = start + 1; // 词内第一个字符之后
      scrollPosIntoView(target);
      const c = view.coordsAtPos(target);
      const back = view.posAtCoords({ left: c.left, top: c.top + 1 });
      const under = document.elementFromPoint(c.left, c.top);
      const insideEditor = !!under && view.dom.contains(under);
      if (!back) {
        return { want: id, got: "posAtCoords 返回空", ok: false };
      }
      const drift = Math.abs(back.pos - target);
      const ok = drift <= 1 && insideEditor;
      return {
        want: id,
        got: ok ? `${id} 内（pos ${back.pos}）` : `偏移 pos ${back.pos}，期望 ${target}；命中编辑器=${insideEditor}`,
        ok,
      };
    },

    dragSelect(from: string, to: string) {
      const a = positions[from];
      const b = positions[to];
      if (a === undefined || b === undefined) return { text: "", ok: false };
      /**
       * 两个端点**分别**滚进视口再量。
       *
       * 一起量必然有一个不准：把终点滚进来后，起点就被滚出顶部，
       * posAtCoords 会把它夹到可视区第一行，选区就少了一大截
       * （这不代表 zoom 有问题，是测量姿势错了）。
       */
      const at = (pos: number) => {
        scrollPosIntoView(pos);
        const c = view.coordsAtPos(pos);
        return view.posAtCoords({ left: c.left, top: c.top + 1 });
      };
      // 终点取词的最后一个字符，否则选区会停在词首，断言「包含该词」必然失败
      const pa = at(a + 1);
      const pb = at(b + SPIKE_WORDS[to].length - 1);
      if (!pa || !pb) return { text: "", ok: false };
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pa.pos, pb.pos)));
      const text = view.state.doc.textBetween(Math.min(pa.pos, pb.pos), Math.max(pa.pos, pb.pos), "\n");
      /**
       * 判定标准：起点落在 from 词内、终点落在 to 词的**区间内**（含最后一个字符前）。
       *
       * 不要求选区文本完整包含 to 词 —— 坐标点取的是字符左边缘，
       * 差一个字符是量法本身，不是映射错；区间判定既严又稳。
       */
      const ok =
        pa.pos >= a && pa.pos <= a + SPIKE_WORDS[from].length && pb.pos >= b && pb.pos <= b + SPIKE_WORDS[to].length;
      return { text, ok };
    },

    allHits(): HitResult[] {
      return Object.keys(SPIKE_WORDS).map((id) => this.hit(id));
    },

    destroy() {
      view.destroy();
      host.replaceChildren();
    },
  };
}
