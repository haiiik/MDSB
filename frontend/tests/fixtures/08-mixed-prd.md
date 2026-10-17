# 审批时效监控 PRD（夹具：混合内容）

| 属性 | 内容 |
| --- | --- |
| 文档编号 | PRD-GJ-2026-041 |
| 版本 | v1.46 |
| 作者 | xuange |

## 1. 背景

工技融合服务平台上线后，审批环节的**实际时长**与承诺时长偏差较大。现状见 [附录 A](#附录-a-数据来源)。

## 2. 方案流程

```mermaid
flowchart LR
    A[单据受理] --> B[形式审查]
    B --> C[技术复核]
    C --> D[主管审批]
    D --> E[归档]
```

## 3. 关键指标

| 指标 | 口径 | 目标值 | 说明 |
| --- | --- | --- | --- |
| 平均时长 | 受理至归档的自然时长 | ≤ 4h | 剔除挂起 |
| 慢单线 | 90 分位时长 | ≤ 8h | 见规则 R3 |
| 超时率 | 超过承诺时长的单量占比 | ≤ 5% | 阈值按事项类型 |

规则：

1. 挂起时段不计入时长
   - 挂起需填写原因
   - 单次挂起不超过 24h
2. 退回重办按新单计时
3. 慢单线以 `P90` 计算，样本量 < 30 时降级为 `P80`

## 4. 落库脚本

```sql
SELECT matter_type,
       AVG(TIMESTAMPDIFF(SECOND, accept_at, done_at)) / 3600 AS avg_hours,
       PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY dur_hours)  AS p90
FROM approval_duration
WHERE done_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
GROUP BY matter_type;
```

> 注意：`PERCENTILE_CONT` 仅 MySQL 8.4+ 支持，低版本走应用层计算。

## 5. 待确认

- [x] 指标口径已对齐
- [ ] 慢单是否需要单独看板
- [ ] 超时提醒的触达渠道

[^1]: 数据来源以工单库为准，报表库仅做展示。
