/**
 * host 适配层新增原语的宿主实现分两处（wails / mock），这里只放编码这种两边都用得上的小事。
 */

/**
 * 字节 → base64。
 *
 * 分块 `String.fromCharCode`：一次展开几 MB 的截图字节会撞上线程调用栈上限
 * （`RangeError: Maximum call stack size exceeded`），4.2 MB 的截图就足以触发。
 */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
