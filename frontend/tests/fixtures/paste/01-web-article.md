## 审批时效看板

本周对齐了口径：**慢单**以 *P90* 计， 字段写 `avg_hours`，删除线 ~~旧口径~~ 作废，详见 [需求文档](https://gongji.test/prd "PRD")。

- 数据侧：补齐 `matter_type`

  - 二级：按部门拆
  - 二级：按月份拆

- 前端侧：看板改版

3. 第三步
4. 第四步

> 评审结论：先上线再优化。
>
> - 遗留：导出

```sql
SELECT matter_type, AVG(diff) AS avg_hours
FROM approval_duration;
```

---

示意图 ![架构图](https://img.test/arch.png) 收尾。
