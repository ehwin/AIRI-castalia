/**
 * 危机时的资源指引。
 *
 * 只放**能核实**的号码，并且写明来源。给错热线比不给更糟：一个打不通的号码会把
 * 求助的人推回原地，还会让整条安全链失去可信度。
 *
 * 12356：国家卫生健康委会同工业和信息化部设置的全国统一心理援助热线，2024-12 发文、
 * 2025-05-01 前全国统一启用，多数省份 24 小时、免费。来源：国家卫健委部署通报与
 * 各省卫健委通告（如福建省卫健委 2025-03-25、光明网 2025-03-28 转中央广播电视总台）。
 * 120/110/119 为急救与报警，多地卫健委明确要求心理援助热线与三者建立联动。
 */
export interface CrisisResource {
  /** 地区；`intl` 表示非中国大陆的兜底指引。 */
  region: 'CN' | 'intl'
  label: string
  contact: string
  /** 服务时间，如实写；不确定就不写。 */
  hours: string
  /** 来源，供日后核对。 */
  source: string
}

export const CRISIS_RESOURCES: CrisisResource[] = [
  {
    region: 'CN',
    label: '全国统一心理援助热线',
    contact: '12356',
    hours: '多数省份 24 小时、免费',
    source: '国家卫健委 / 工业和信息化部，2025 年 5 月 1 日前全国统一启用',
  },
  {
    region: 'CN',
    label: '急救 / 报警',
    contact: '120 / 110',
    hours: '24 小时',
    source: '急救与报警；多地卫健委要求心理援助热线与 110/119/120 联动',
  },
  {
    region: 'intl',
    label: '当地紧急电话',
    contact: '当地急救号码（欧盟通用 112）',
    hours: '24 小时',
    source: '按所在地填写；本表只保证中国大陆号码经过核对',
  },
]

/**
 * 渲染成给模型看的两三行指令。
 *
 * 刻意不把号码塞进每一轮：资源要在危机轮给出，而不是平时刷屏。
 * 同时明确禁止给出任何方法细节——这是 PLAN §3.3 的验收项之一。
 */
export function crisisResourceLines(): string[] {
  const china = CRISIS_RESOURCES.filter(resource => resource.region === 'CN')
  return [
    `Give one concrete way to reach a person: ${china.map(resource => `${resource.contact}（${resource.label}）`).join(' / ')}，或让用户联系此刻能到场的人。`,
    'Name no method, no means, and no amount, in any form, even to warn against it.',
  ]
}
