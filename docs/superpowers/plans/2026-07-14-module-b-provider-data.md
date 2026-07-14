# 模块 B：Provider 数据修复实现计划

> **目标**: 通过模型生成脚本自动获得上游新增/修正的模型元数据
> **涉及文件**: 35 个 `providers/*.models.ts` + `models.generated.ts`
> **前置依赖**: 模块 A

---

## 文件变动

| 文件 | 操作 | 说明 |
|------|------|------|
| `providers/anthropic.models.ts` | 自动生成 | Claude Sonnet 5、Fable 5 xhigh/max thinking |
| `providers/openai.models.ts` | 自动生成 | GPT-5.5/5.6、input tiers |
| `providers/openai-codex.models.ts` | 自动生成 | GPT-5.6、272K/372K tier、zstd |
| `providers/fireworks.models.ts` | 自动生成 | GLM-5.2 OpenAI-compat |
| `providers/mistral.models.ts` | 自动生成 | prompt-cache 字段 |
| `providers/openrouter.models.ts` | 自动生成 | GLM-5.2 xhigh、Fusion、context windows |
| `providers/zai.models.ts` | 自动生成 | GLM-5.2 thinking level map |
| `models.generated.ts` | 自动生成 | 聚合所有 provider 模型 |
| 其余 28 个 `.models.ts` | 自动生成 | 模型数据刷新 |

---

## Task 1: 运行模型生成脚本

已在模块 A Task 3 中执行。如果模型生成脚本运行时有报错，在此修复。

- [ ] **Step 1: 确认 generate-models.ts 可执行**

```bash
cd /data/mine/pi/packages/ai
npx tsx scripts/generate-models.ts 2>&1 | tail -20
```

预期：成功生成 35 个 `.models.ts` + `models.generated.ts`

- [ ] **Step 2: 检查关键新模型**

```bash
cd /data/mine/pi
python3 -c "
models = ['claude-sonnet-5', 'claude-fable-5', 'gpt-5.6', 'gpt-5.5', 'glm-5.2']
with open('packages/ai/src/models.generated.ts') as f:
    content = f.read()
    for m in models:
        print(f'  {m}: {\"✅\" if m in content else \"❌\"}')"
```

- [ ] **Step 3: 检查关键元数据字段**

```bash
cd /data/mine/pi && python3 -c "
import re
with open('packages/ai/src/models.generated.ts') as f:
    content = f.read()
# Check for thinking level maps (xhigh/max)
for level in ['xhigh', 'max']:
    count = len(re.findall(f'\"{level}\"', content))
    print(f'  thinkingLevelMap \"{level}\" references: {count}')
# Check for tiers
tier_count = content.count('inputTokensAbove')
print(f'  input pricing tiers: {tier_count}')
# Check for contextWindow 272000 (Codex limit)
c272 = content.count('272000')
print(f'  contextWindow 272000: {c272}')"
```

- [ ] **Step 4: 验证编译**

```bash
cd /data/mine/pi && npx tsgo --noEmit 2>&1 | grep -v 'packages/ai/test/' | grep error | head -10
```

- [ ] **Step 5: CSV 标记**

```bash
cd /data/mine/pi && python3 /tmp/mark-csv.py \
  "0.79.8,Provider,Mistral prompt caching" \
  "0.79.9,Provider,chat-template thinking" \
  "0.79.9,Provider,Fireworks GLM-5.2" \
  "0.79.9,Provider,OpenRouter GLM-5.2" \
  "0.79.10,Provider,OpenAI-compat streaming" \
  "0.80.3,Provider,Anthropic Claude Sonnet 5" \
  "0.80.3,Provider,Claude Sonnet 5 adaptive" \
  "0.80.4,Provider,GPT-5.6 元数据" \
  "0.80.6,Provider,输入 token 分级定价" \
  "0.80.6,Provider,GPT-5.4/5.5 long-context" \
  "0.80.6,Provider,GPT-5.6 metadata" \
  "Unreleased,Provider,OpenRouter 继承"
```

- [ ] **Step 6: Commit**

```bash
cd /data/mine/pi
git add packages/ai/src/providers/*.models.ts packages/ai/src/models.generated.ts
git commit -m "feat: 上游 Provider 模型数据更新 (Claude Sonnet 5, GPT-5.6, Fable 5 xhigh/max, 输入分级定价等)"
```
