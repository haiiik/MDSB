/**
 * 164：**外部工具改了这份文件，我们怎么知道、知道了怎么办**（只算判断、不碰宿主）。
 *
 * 要求（原话）：「新增文件自动刷新功能，应对其他工具改了文件」，三条已定口径：
 * - **只盯当前活动标签**（开 20 篇时后台一起 stat 是白烧磁盘，且脏提示会同时在好几颗上冒）；
 * - 磁盘变了**且这一篇没有未保存编辑** → 静默重载；
 * - 磁盘变了**而有未保存编辑** → 弹提示条让人选「重载磁盘版本 / 保留我的编辑」，
 *   **不许拿磁盘版本盖掉没保存的东西**（静默丢输入是这颗功能唯一不能被原谅的失败）。
 *
 * 判据分两步走，是因为"指纹变了"和"内容真的变了"是两件事：
 * 1. `指纹变了吗()` —— 拿 `stat` 的 size + mtime 与上一次记下的基准比。这一步只做便宜的问一句；
 * 2. `变了之后怎么办()` —— 指纹变了之后**再读一份盘上的**与「我们以为落盘的那份」逐字节比。
 *    为什么必须有这一步：
 *    - 别的工具（格式化器、git checkout、云盘同步）常把**一模一样的字节**重写一遍，
 *      mtime 变了而内容没变 —— 这时候弹提示就是纯噪音；
 *    - 我们自己 `Ctrl+S` 之后 mtime 必然变。有了这一步，"自己写盘"会落到"identical"这一支，
 *      不需要在保存链路上再挂一个"别忘了更新基准"的钩子 —— **少一处接线就少一处会忘**。
 */

export interface 指纹 {
  size: number;
  mtime: number;
}

/** 第一步的结论 */
export type 盘上判定 = "no-baseline" | "unreadable" | "unchanged" | "changed";

/** 第二步的结论 */
export type 处置 = "identical" | "reload" | "ask";

/**
 * @param 基准 上一次认过的盘上指纹；`null` = 这一篇还没记过（刚打开 / 刚切过来 / 刚新建）
 * @param 现在  这一次 `stat` 的结果；`null` = `stat` 抛错（被删、被改名、盘没挂载…）
 */
export function 指纹变了吗(基准: 指纹 | null, 现在: 指纹 | null): 盘上判定 {
  if (!基准) return "no-baseline";
  if (!现在) return "unreadable";
  if (基准.size === 现在.size && 基准.mtime === 现在.mtime) return "unchanged";
  return "changed";
}

/**
 * @param 磁盘内容   刚刚从盘上读到的文本；`null` = 读失败（同样按"没了"处理，交给调用方提示）
 * @param 落盘基准   这个标签的 `saved`（最后一次我们认为盘上是什么）
 * @param 有未保存编辑 这个标签的 `isDirty`
 */
export function 变了之后怎么办(
  磁盘内容: string | null,
  落盘基准: string,
  有未保存编辑: boolean
): 处置 | "unreadable" {
  if (磁盘内容 === null) return "unreadable";
  if (磁盘内容 === 落盘基准) return "identical";
  return 有未保存编辑 ? "ask" : "reload";
}
