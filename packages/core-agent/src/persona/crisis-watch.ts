/**
 * 危机处理的两件事：多轮升级判定，和一条不含原文的审计记录。
 *
 * 单条消息的判定在 `inferRelationalSignals` 里（`CRISIS_PATTERN`）：一句话说清楚就抓得住。
 * 抓不住的是**渐进**——"今天很累" → "撑不住了" → "没什么意思了" → "我把东西送人了"，
 * 每一句单看都不构成那一句的分量。Jailbreak 类研究（arXiv 2507.02990 等）指出的也正是
 * 多步、多轮比单句更容易绕过内容过滤，所以这一层按"一个时段内的走向"判，而不是按单句。
 *
 * 隐私是硬约束：审计**只记类别、时刻、当时的档位、有没有给出资源**，绝不落原文。
 * `classify` 只返回类别，原文在读完之后就离开这个模块。
 */
import type { SafetyLevel } from './relational-policy'

/** 触发类别。类别名是审计能落下的全部信息。 */
export type CrisisCategory = 'farewell' | 'hopelessness' | 'method' | 'numbness' | 'self-harm'

/**
 * 类别模式。只用于**归类**，不用于决定"是不是危机"——那个判在 safety level 上。
 * `method` 命中的是"提到了手段"，不是手段本身：它触发的是更严的措辞约束。
 */
const CATEGORY_PATTERNS: { category: CrisisCategory, re: RegExp }[] = [
  { category: 'hopelessness', re: /想死|自杀|活不下去|不想活|结束生命|没意思|没什么意思|没什么盼头|绝望|撑不住|活着没|suicid|kill myself|end my life|hopeless/iu },
  { category: 'method', re: /绳子|刀|药片|跳楼|跳下去|烧炭|上吊|怎么死|死法|多高|剂量|means|pills|how to die/iu },
  { category: 'self-harm', re: /自残|割腕|伤害自己|疼一下|self-harm|hurt myself|cutting/iu },
  { category: 'farewell', re: /遗书|最后一句|告别|把东西送人|送人了|不要找我|谢谢你陪|谢谢你这段时间|永别|goodbye forever|final note/iu },
  { category: 'numbness', re: /麻木|没感觉|无所谓了|空心|空的|什么都不想|numb|empty inside/iu },
]

export interface CrisisAuditRecord {
  /** 判定时刻。 */
  at: number
  /** 这一轮的档位（含升级后的结果）。 */
  level: SafetyLevel
  /** 命中的类别，去重、按固定顺序。 */
  categories: CrisisCategory[]
  /** 这一轮有没有给出资源指引。运营上用来查"危机轮是不是都给了资源"。 */
  resourcesOffered: boolean
  /** 是不是由多轮走向升级出来的（单句不足以判危机）。 */
  escalated: boolean
}

/** 归类一条文本。返回类别，不返回原文。 */
export function classifyCrisisText(text: string): CrisisCategory[] {
  const value = String(text ?? '')
  if (value.length === 0)
    return []
  const order: CrisisCategory[] = ['hopelessness', 'self-harm', 'method', 'farewell', 'numbness']
  const found = new Set(Category_of(value))
  return order.filter(category => found.has(category))
}

function Category_of(value: string): CrisisCategory[] {
  return CATEGORY_PATTERNS.filter(entry => entry.re.test(value)).map(entry => entry.category)
}

/**
 * 一出现就该按安全档处理的类别，**不需要**累计，也不看其它信号。
 *
 * `method` 是最高风险信号：一个人把手段讲出来了，等三个轮次再看走向就已经晚了。
 * `self-harm` 与 `farewell`（遗书/送东西/永别）同理——这三类合起来是危机评估里
 * 特异性最高的那批词，代价是偶尔误报一次（多给一句温和的安全提醒），
 * 而漏报的代价不对称。
 */
export const IMMEDIATE_CRISIS_CATEGORIES: CrisisCategory[] = ['method', 'self-harm', 'farewell']

export interface CrisisWatchOptions {
  /** 走向判定看的时段。 */
  windowMs: number
  /** 时段内累计这么多"不好受"的轮次就把当前轮提到 crisis。 */
  roughTurnsForCrisis: number
  /** 审计最多保留多少条（内存实现，够诊断用）。 */
  maxRecords: number
  /** 立即升级的类别；传空数组表示只看走向。 */
  immediateCategories: CrisisCategory[]
}

export const CRISIS_WATCH_DEFAULTS: CrisisWatchOptions = {
  windowMs: 6 * 60 * 60 * 1000,
  roughTurnsForCrisis: 3,
  maxRecords: 200,
  immediateCategories: IMMEDIATE_CRISIS_CATEGORIES,
}

export interface CrisisWatch {
  /**
   * 看一轮。
   *
   * `level` 是单句判定的结果（来自 `inferRelationalSignals`）。一个时段内持续不好受时，
   * 这里把当轮升级成 `crisis`，并且**只升不降**——已经判成危机的轮次永远不会被降回。
   */
  observe: (input: { text: string, level: SafetyLevel, at: number, resourcesOffered?: boolean }) => CrisisAuditRecord
  records: () => readonly CrisisAuditRecord[]
  reset: () => void
}

/**
 * 建一个时段看护器。
 *
 * 升级规则保守：只有"不好受"的轮次（elevated 或 crisis）在窗口内累计到阈值才升级，
 * 而且**每轮最多升一档**。率真的难过（今天有点累）连 elevated 都不算，因此永远不升级。
 */
export function createCrisisWatch(options: CrisisWatchOptions = CRISIS_WATCH_DEFAULTS): CrisisWatch {
  const settings = Number.isFinite(options.windowMs) && options.windowMs > 0 ? options : CRISIS_WATCH_DEFAULTS
  let roughAt: number[] = []
  let records: CrisisAuditRecord[] = []

  function observe(input: { text: string, level: SafetyLevel, at: number, resourcesOffered?: boolean }): CrisisAuditRecord {
    const at = Number.isFinite(input.at) ? input.at : 0
    const categories = classifyCrisisText(input.text)
    const base: SafetyLevel = input.level
    const immediate = (settings.immediateCategories ?? IMMEDIATE_CRISIS_CATEGORIES)
      .some(category => categories.includes(category))

    roughAt = roughAt.filter(stamp => stamp >= at - settings.windowMs)
    // 一次"不好受"的轮次：单句判定为 elevated/crisis，或者命中任一危机类别
    // （麻木、无望这类词单看够不上安全档，但连着来几轮就是走向）。
    if (base === 'crisis' || base === 'elevated' || categories.length > 0)
      roughAt.push(at)

    const escalated = base !== 'crisis' && (immediate || roughAt.length >= settings.roughTurnsForCrisis)
    const level: SafetyLevel = escalated ? 'crisis' : base

    const record: CrisisAuditRecord = {
      at,
      level,
      categories,
      // 资源要在 crisis 轮给出；elevated 轮不强制，记 false 但不报警。
      resourcesOffered: input.resourcesOffered ?? level === 'crisis',
      escalated,
    }
    records = [...records, record].slice(-Math.max(1, settings.maxRecords))
    return record
  }

  return {
    observe,
    records: () => records,
    reset: () => {
      roughAt = []
      records = []
    },
  }
}
