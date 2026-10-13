/** 全部为本评测原创。先固定问题、事实与标签，再运行向量；不按测得分数改写语料。 */
export interface WebEvalCase {
  id: string
  lang: 'zh' | 'en'
  kind: 'A' | 'B' | 'C'
  title: string
  question: string
  notes: { title: string; text: string }[]
  pages: { title: string; paragraphs: { text: string; relevant: boolean; gold: boolean }[] }[]
}

const unrelated = {
  zh: [
    '周末烘焙记录：面团揉好后先盖住，发酵到原来的两倍大小。烤盘不要紧贴炉壁，取出后放在架子上散热。',
    '社区花圃值班表每月轮换。浇水前检查表层土壤，雨天暂停浇灌，把落叶放进单独的堆肥箱。',
    '旅行行李单列出衣物、牙刷和充电器。易碎纪念品用软布包好，返程前核对车票上的出发站。',
    '摄影练习把主体放在画面右侧，留出前进方向的空间。阴天的柔和光线适合观察物体表面的纹理。',
    '合唱排练先做呼吸练习，再分声部练习长音。团员在乐谱上标注换气位置，结束后收起谱架。',
    '桌游活动记录参加人数和借出的棋子。下一次活动安排在阅读室，主持人先讲解回合顺序。'
  ],
  en: [
    'The weekend baking log says to cover the dough until it doubles in size. Leave space around the tray and cool the loaf on a rack.',
    'Garden volunteers rotate every month. Check the top layer of soil before watering, skip rainy days, and collect leaves for compost.',
    'The travel checklist contains clothes, a toothbrush, and a charger. Wrap fragile souvenirs in cloth and check the departure station.',
    'A photography exercise places the subject on the right and leaves space ahead. Soft cloudy light reveals the texture of the surface.',
    'Choir rehearsal begins with breathing exercises followed by long notes in separate voice groups. Singers mark breaths on their scores.',
    'The board game group records attendance and borrowed pieces. Its next meeting is in the reading room, with a short explanation of turns.'
  ]
}

type Input = Omit<WebEvalCase, 'notes' | 'pages'> & {
  rows: [string, string]
  gold: string
  support: string
  near: [string, string]
}

function sample(input: Input, index: number): WebEvalCase {
  const pool = unrelated[input.lang]
  const noise = (offset: number): string => pool[(index + offset) % pool.length]
  const paragraph = (text: string, relevant = false, gold = false) => ({ text, relevant, gold })
  return {
    id: input.id,
    lang: input.lang,
    kind: input.kind,
    title: input.title,
    question: input.question,
    notes:
      input.kind === 'B'
        ? [0, 1, 2].map((offset) => ({ title: input.lang === 'zh' ? '日常活动记录' : 'Everyday activity log', text: noise(offset) }))
        : [
            ...input.rows.map((text) => ({ title: input.title, text })),
            { title: input.lang === 'zh' ? '日常活动记录' : 'Everyday activity log', text: noise(2) }
          ],
    pages: [
      {
        title: input.title,
        paragraphs: [paragraph(input.near[0]), paragraph(input.gold, true, true), paragraph(noise(0)), paragraph(input.support, true)]
      },
      {
        title: input.lang === 'zh' ? '相关活动简报' : 'Related activity bulletin',
        paragraphs: [paragraph(noise(1)), paragraph(input.near[1]), paragraph(noise(3)), paragraph(noise(4))]
      }
    ]
  }
}

const inputs: Input[] = [
  {
    id: 'A01',
    lang: 'zh',
    kind: 'A',
    title: '缺氧池中的硝酸盐去向',
    question: '污水处理里把硝酸盐变成气体排走的环节，为什么要避免有太多氧气？',
    rows: [
      '反硝化菌以硝酸盐作为电子受体，把它逐步还原成氮气。缺氧池减少游离氧，给这种代谢创造条件。',
      '反硝化需要有机物提供电子。游离氧过多时微生物优先消耗氧，硝酸盐还原受到抑制。'
    ],
    gold: '脱氮流程中，缺氧区让反硝化微生物使用硝酸盐而非氧作电子受体，最终形成逸出的氮气。氧进入过多会与这一过程竞争，因此要控制曝气和回流带入的氧。',
    support: '可利用的碳源不足会限制硝酸盐还原。操作人员同时检查碳源与缺氧条件，不能只看氮气是否冒出。',
    near: [
      '曝气池的鼓风机维护需要检查滤网和传动带。检修前切断电源，维护记录注明更换的零件。',
      '监测站用颜色标签区分进水和出水取样瓶，采样后将瓶盖旋紧，放在低温箱中运输。'
    ]
  },
  {
    id: 'A02',
    lang: 'zh',
    kind: 'A',
    title: '分配隐藏与随机序列',
    question: '试验招募人员提前知道下一位会进哪组，会给随机研究带来什么问题？',
    rows: [
      '分配隐藏使招募者无法预知下一位受试者的组别，防止挑选特定患者进入某组。它保护随机序列的实施。',
      '随机序列负责产生不可预测的组别；隐藏负责在正式入组前不让招募者看到组别，二者不是同一件事。'
    ],
    gold: '如果招募者预知下一次分组，就可能调整受试者的入组顺序或选择，造成选择偏倚。即使序列本身随机，也要在纳入确定之前隐藏下一组的分配。',
    support: '集中分配或合适的封装流程可以降低预知分组的机会。分析阶段的盲法不能替代招募阶段的分配隐藏。',
    near: [
      '试验招募海报使用较大字号写出联系电话，志愿者可以在接待室领取纸质介绍。',
      '研究办公室每周核对文件数量，缺失的签字页放入待补充清单，由管理员联系负责人。'
    ]
  },
  {
    id: 'A03',
    lang: 'zh',
    kind: 'A',
    title: '写前日志的崩溃恢复',
    question: '数据库为什么先记日志，再把修改过的数据页写回磁盘？',
    rows: [
      '写前日志要求对应日志先持久化，再写入脏数据页。崩溃之后可以根据日志恢复已经提交的修改。',
      '提交成功必须有持久的提交记录。数据页可以晚一些刷新，恢复时重放记录，不把尚未提交的更新当作已完成。'
    ],
    gold: '先落盘日志建立了恢复依据：即使修改后的数据页没有完全写好，崩溃恢复仍能重做已提交操作。反过来先写数据而没有持久日志，会失去判断和恢复这些修改的依据。',
    support: '日志持久化与数据页刷新是两个步骤，不能把内存中已有日志误认为日志已经到达持久存储。',
    near: [
      '数据库培训课报名后会收到教室位置，学员自带笔记本电脑，签到表按姓名排序。',
      '日志查看器可以改变显示字体和背景色，界面偏好保存在用户自己的配置文件中。'
    ]
  },
  {
    id: 'A04',
    lang: 'zh',
    kind: 'A',
    title: '河流弯道的侵蚀沉积',
    question: '弯曲河道为什么外侧容易被冲掉，而内侧常堆起沙子？',
    rows: [
      '弯道外侧流速较快，水流冲刷河岸；内侧流速较慢，泥沙更容易沉积形成边滩。',
      '弯道的横向环流把近床泥沙向内侧输送，配合外侧侵蚀和内侧堆积，使河弯逐渐迁移。'
    ],
    gold: '河弯外岸承受较快水流和较强剪切，更容易被侵蚀；内岸流速降低，运输泥沙的能力变小，形成沉积。弯道环流也把近床物质带向内侧。',
    support: '河岸材料和植被会影响迁移速度，但典型河弯的外冲内积来自水流速度与泥沙输送的差异。',
    near: [
      '河岸步道在雨后关闭检修，管理处在入口摆放提示牌，游客改走上方的山路。',
      '水文展览的沙盘安装在透明柜里，讲解员按预约时间介绍展览路线。'
    ]
  },
  {
    id: 'A05',
    lang: 'zh',
    kind: 'A',
    title: '间隔提取与记忆',
    question: '同一内容隔几天再尝试回忆，比一次连续看很多遍有什么作用？',
    rows: [
      '间隔练习把学习安排在不同时间，提取练习要求主动从记忆中找答案。适度遗忘后成功提取有助于长期保持。',
      '反复阅读带来熟悉感，未必能独立回忆。安排间隔并核对提取错误，可以发现掌握的薄弱处。'
    ],
    gold: '跨时间主动回忆让学习者练习提取，而非只辨认熟悉文字。间隔使提取略有难度，成功回忆并修正错误有利于较长期的记忆，连续重读容易高估掌握程度。',
    support: '复习间隔应随掌握情况调整。完全无法回忆时先提供适当反馈，再安排下一次提取。',
    near: [
      '学习日历可以用不同颜色标记课程，周末的位置用浅色背景，用户选择自己喜欢的字体。',
      '图书馆的阅读灯由管理员统一检查，桌面上的书籍要在闭馆前收回书架。'
    ]
  },
  {
    id: 'A06',
    lang: 'zh',
    kind: 'A',
    title: '负压房间的气流方向',
    question: '隔离房把气压维持得比走廊低，为什么能减少空气跑出去？',
    rows: [
      '空气通常从较高压力区域流向较低压力区域。房间保持负压时，门缝气流倾向从走廊进入房间。',
      '负压隔离通过定向气流减少污染空气逸出，同时需要排风和合适的过滤；不能只靠一个压力数字。'
    ],
    gold: '房内压力低于走廊时，缝隙处的空气趋向向内流，降低房内污染空气向走廊泄漏的机会。持续排风建立这种压差，还需要验证实际气流方向。',
    support: '频繁开门会扰动压差。压力监测和气流检查帮助确认隔离条件仍然有效。',
    near: [
      '病区墙面使用易清洁涂料，维修人员记录每面墙的颜色编号，以便以后补漆。',
      '走廊指示牌把门牌号码按区域排列，访客在服务台领取楼层导览。'
    ]
  },
  {
    id: 'A07',
    lang: 'zh',
    kind: 'A',
    title: '电池串联的电压与容量',
    question: '两节相同电池串起来，电压和能供出的安时数分别怎么变？',
    rows: [
      '相同电池串联时电压相加，安时容量不相加，仍由单节的容量及最弱单元约束。',
      '串联各节经过同一电流，总能量随总电压提高。不能把串联后的安时容量误认为两节相加。'
    ],
    gold: '两节一致电池串联，端电压约为单节的两倍，安时容量仍约为单节的值，因为每节都流过同一电流。瓦时能量随电压增加，安时和瓦时需要区分。',
    support: '串联组需要监测各单元状态，容量不一致时较弱电池可能先达到充放电边界。',
    near: [
      '电池回收箱设在大厅入口，投放前按当地要求处理裸露端子，工作人员定期清点箱子。',
      '实验室电线以长度分类挂在墙架上，借用登记注明归还日期。'
    ]
  },
  {
    id: 'A08',
    lang: 'en',
    kind: 'A',
    title: 'Confounding in an observational comparison',
    question: 'Why might an apparent treatment benefit disappear after accounting for patients being younger in the treated group?',
    rows: [
      'Age can affect both treatment selection and recovery. When treated patients are younger, age can confound an observational comparison.',
      'Adjustment tries to compare patients with similar measured risk factors. A crude difference may mix a treatment effect with differences in baseline prognosis.'
    ],
    gold: 'Younger patients may recover better even without the treatment and may also be more likely to receive it. Age then explains part of the crude association; adjusting for age can reduce an apparent benefit that came from the baseline imbalance.',
    support:
      'Adjustment only addresses measured factors under its assumptions. A remaining association alone does not establish that the treatment caused recovery.',
    near: [
      'The clinic prints appointment cards on recycled paper and asks patients to check their contact number.',
      'The research team stores meeting agendas by month and books the smaller room for weekly discussions.'
    ]
  },
  {
    id: 'A09',
    lang: 'en',
    kind: 'A',
    title: 'Bloom filter membership checks',
    question: 'A compact membership filter says an item is present. Why may a database lookup still be needed?',
    rows: [
      'A Bloom filter may return false positives: several inserted items can set the same bits required by an absent item.',
      'For a standard Bloom filter without deletions, a negative check rules out membership, while a positive check only suggests possible membership.'
    ],
    gold: 'A positive Bloom filter result means the required bits are set, but collisions can set those bits even when the item was never inserted. The database lookup confirms membership; the filter mainly avoids lookups for definite negatives.',
    support:
      'The false positive rate depends on the number of bits, hash functions, and inserted items. It is not a certificate that the exact item exists.',
    near: [
      'The database training session uses a projector and offers a short break after the first exercise.',
      'The software club arranges laptops around a shared table and keeps spare power cables in a drawer.'
    ]
  },
  {
    id: 'A10',
    lang: 'en',
    kind: 'A',
    title: 'A heavier flywheel and rotational motion',
    question: 'Why does a wheel with more mass far from its axle resist changes in spinning speed?',
    rows: [
      'Rotational inertia grows when mass is placed farther from the axis. More torque is required for the same angular acceleration.',
      'A flywheel stores rotational energy and smooths speed variations. The radial distribution of mass matters in addition to total mass.'
    ],
    gold: 'Mass farther from the axle contributes more to the moment of inertia. With greater rotational inertia, the same applied torque produces less angular acceleration, so spinning speed changes more slowly.',
    support:
      'Moving equal mass inward lowers the moment of inertia. Two wheels of equal mass can therefore respond differently to the same torque.',
    near: [
      'The workshop paints wheel rims before fitting decorative covers and labels each finished part.',
      'The sports club checks bicycle lights before an evening ride and meets near the park entrance.'
    ]
  },
  {
    id: 'B01',
    lang: 'zh',
    kind: 'B',
    title: '湿地甲烷的产生条件',
    question: '长期积水的土壤为什么可能释放甲烷？',
    rows: ['无关记录一', '无关记录二'],
    gold: '积水使氧难以进入土壤，厌氧微生物在分解有机物时可能产生甲烷。温度、底物与土壤条件影响产量，释放量还受到甲烷氧化和运输过程影响。',
    support: '并非所有湿地都有相同的甲烷通量，观测需要同时记录水位和环境变化。',
    near: ['湿地公园预约系统按人数安排讲解员，入口处提供借用的雨伞。', '土壤标本在展柜中按颜色排列，参观者不能触摸未经封装的样品。']
  },
  {
    id: 'B02',
    lang: 'zh',
    kind: 'B',
    title: '天体凌日曲线',
    question: '恒星亮度周期性变暗，怎样用来推测有行星经过前面？',
    rows: ['无关记录一', '无关记录二'],
    gold: '行星从恒星盘面前方经过会遮挡部分光，产生凌日亮度下降。重复的下降间隔可估计轨道周期，深度与大小比例有关，但需排除恒星活动和食双星等假象。',
    support: '单次变暗不能直接证明行星存在，重复观测和独立证据能帮助识别其他原因。',
    near: ['观星活动需要提前登记，天文馆在大厅展示望远镜的外观模型。', '星图印刷品卷成筒装入纸盒，邮寄前检查收件地址。']
  },
  {
    id: 'B03',
    lang: 'zh',
    kind: 'B',
    title: '生物膜的抗菌药物耐受',
    question: '附在表面的一层细菌，为什么比游离细菌更难被药物清除？',
    rows: ['无关记录一', '无关记录二'],
    gold: '生物膜内的基质、营养和氧梯度、缓慢生长状态及持留细胞共同影响药物作用。游离细菌的敏感性结果不能完整代表附着群体的清除难度。',
    support: '处理附着群体常需考虑基质和所在表面，不能把暂时耐受与遗传耐药完全等同。',
    near: ['实验楼走廊新增洗手提示，值班人员每天核对清洁用品数量。', '显微镜预约按课程分配，学生用完后归还防尘罩。']
  },
  {
    id: 'B04',
    lang: 'zh',
    kind: 'B',
    title: '纠删码的片段恢复',
    question: '存储系统丢了一部分片段，为什么仍可能拼回原文件？',
    rows: ['无关记录一', '无关记录二'],
    gold: '纠删码将原始数据编码成带冗余关系的片段，只要剩余片段数量达到方案要求，就能通过解码恢复文件。它处理的是可识别的片段缺失，冗余程度决定容忍范围。',
    support: '恢复前要确认可用片段和校验信息完整，不能把任意损坏都当作可纠正的丢失。',
    near: ['存储机柜的编号贴在门上，工作人员按通道顺序记录温度。', '文件整理活动为旧照片建立日期目录，重复照片交由主人确认。']
  },
  {
    id: 'B05',
    lang: 'zh',
    kind: 'B',
    title: '叶片气孔与失水',
    question: '植物关小叶片上的气孔，在保水时为什么也影响光合作用？',
    rows: ['无关记录一', '无关记录二'],
    gold: '气孔让二氧化碳进入叶片，也允许水汽向外扩散。关闭气孔可降低蒸腾失水，却同时限制二氧化碳供应，因此保水和碳固定之间存在权衡。',
    support: '植物的调节还受光照、湿度和水分状态影响，不能仅由叶片大小判断气孔是否开放。',
    near: ['植物园叶片拓印课准备白纸和蜡笔，参加者在入口领取材料。', '温室的花盆标签注明植物名称，管理员用软布清理标签上的灰尘。']
  },
  {
    id: 'B06',
    lang: 'zh',
    kind: 'B',
    title: '遥感影像的混合像元',
    question: '一格卫星图像同时含草地和道路时，分类为什么容易出错？',
    rows: ['无关记录一', '无关记录二'],
    gold: '像元记录其覆盖范围内多种地物的综合信号。分辨率不足时，道路和草地形成混合像元，单一类别标签无法完整描述它，光谱也可能不同于纯地物。',
    support: '更细的空间分辨率或混合比例估计能提供帮助，但需要匹配任务尺度和观测条件。',
    near: ['遥感课程的助教提前打开投影设备，地图册按座位分发。', '道路维修公告写明绕行方向，社区志愿者在路口提供指引。']
  },
  {
    id: 'B07',
    lang: 'zh',
    kind: 'B',
    title: '逆变器的最大功率点',
    question: '太阳能板受光改变后，为什么控制器要重新寻找工作电压？',
    rows: ['无关记录一', '无关记录二'],
    gold: '光伏组件的电流电压关系随辐照和温度变化，能输出最大功率的工作点也会移动。控制器调整电压或电流，追踪当前的最大功率点，提高能量获取。',
    support: '局部遮阴可能形成多个功率峰值，简单的局部搜索不一定找到全局最佳工作点。',
    near: ['屋顶参观要求佩戴安全帽，工作人员在楼梯口检查签到名单。', '能源展览把旧式仪表放入玻璃柜，铭牌记录制造年份。']
  },
  {
    id: 'B08',
    lang: 'en',
    kind: 'B',
    title: 'Acoustic impedance at a boundary',
    question: 'Why does a sound wave partly bounce back when it reaches a different material?',
    rows: ['Unrelated row one', 'Unrelated row two'],
    gold: 'A change in acoustic impedance at a boundary changes the relation between pressure and particle motion. Boundary conditions then produce reflected and transmitted waves; a larger mismatch often yields stronger reflection.',
    support:
      'The amount reflected also depends on incidence and the materials. A boundary does not automatically transmit all incoming acoustic energy.',
    near: [
      'The music hall asks visitors to leave coats at the desk before entering the performance room.',
      'The materials exhibition labels each polished sample and provides gloves for the guided workshop.'
    ]
  },
  {
    id: 'B09',
    lang: 'en',
    kind: 'B',
    title: 'CRISPR guide and nearby motif',
    question: 'Why is a matching guide sequence alone insufficient for some genome editing enzymes?',
    rows: ['Unrelated row one', 'Unrelated row two'],
    gold: 'Some CRISPR-associated enzymes require an appropriate nearby motif as well as guide complementarity. That motif helps target recognition, so a sequence match without the required motif may not be a usable cleavage site.',
    support:
      'Different enzymes recognize different motif requirements. Choosing a guide therefore requires checking the enzyme and local sequence context together.',
    near: [
      'The genetics workshop gives participants notebooks and a schedule of short demonstrations.',
      'The laboratory orders labeled tubes in several sizes and checks the delivery against its inventory.'
    ]
  },
  {
    id: 'B10',
    lang: 'en',
    kind: 'B',
    title: 'Debouncing a mechanical switch',
    question: 'Why can one button press produce several electrical transitions, and how is that handled?',
    rows: ['Unrelated row one', 'Unrelated row two'],
    gold: 'Mechanical contacts can bounce briefly when a switch closes, creating multiple transitions during a single press. Debouncing waits for a stable signal or filters short changes so that the application recognizes one intentional action.',
    support:
      'A debounce interval must balance contact settling against responsiveness. Counting every edge directly can create duplicate actions.',
    near: [
      'The electronics club stores colored buttons in separate bins and labels them by diameter.',
      'The repair desk records the owner of each device and attaches a paper collection slip.'
    ]
  },
  {
    id: 'C01',
    lang: 'zh',
    kind: 'C',
    title: '虚构的林舟包管理器升级',
    question: '林舟包管理器现在安装扩展还应该用 add 命令吗？',
    rows: [
      '林舟工具第2版用 add 命令安装扩展，安装完成后扩展列表会显示名称。',
      '第2版操作说明要求先初始化项目，再运行 add 和扩展名，默认写入项目配置。'
    ],
    gold: '林舟第3版的原创公告将扩展安装命令从 add 改为 install。add 仅保留兼容提示，新的项目教程应使用 install；这条说明针对第3版，旧笔记描述的是第2版。',
    support: '升级指南建议先核对工具版本，再修改安装脚本。历史项目不应仅依据旧教程判断当前命令。',
    near: [
      '林舟社区线下活动在图书馆举行，报名者可领取贴纸，午间安排自由交流。',
      '项目展示海报使用浅绿色背景，标题旁附有活动日期和会场楼层。'
    ]
  },
  {
    id: 'C02',
    lang: 'zh',
    kind: 'C',
    title: '虚构的云汀图书馆借期',
    question: '云汀图书馆当前普通读者一次能借书多少天，旧的两周期限还有效吗？',
    rows: [
      '云汀图书馆旧规则规定普通图书借期14天，超期需要到服务台办理手续。',
      '旧的读者手册以两周为一个借阅周期，在到期日前可以申请续借。'
    ],
    gold: '云汀图书馆新公布的原创规则把普通读者借期延长为28天，替代此前14天的标准。特藏资料仍按单独规则处理，不能把普通借期推广到所有资料。',
    support: '新规要求读者以当前借阅记录中的日期为准，历史手册上的两周期限用于说明过去的流程。',
    near: ['云汀图书馆书签设计比赛接受纸质作品，获选图案会在大厅展示。', '书架编号调整后，工作人员在每层入口放置新的导览图。']
  },
  {
    id: 'C03',
    lang: 'zh',
    kind: 'C',
    title: '虚构的青桥数据接口鉴权',
    question: '青桥接口新版还能把访问凭证直接放在网址参数里吗？',
    rows: [
      '青桥v1接口通过查询参数 access_token 接受访问凭证，请求时必须带上该参数。',
      '旧接入示例把凭证拼接到URL末尾，然后发送读取数据的请求。'
    ],
    gold: '青桥v2的原创迁移说明停止接受URL中的access_token，改用Authorization请求头。旧示例不能直接用于新版，日志中也不应保存完整访问凭证。',
    support: '迁移时应核对服务版本和请求头格式，并移除脚本中拼接凭证到URL的旧代码。',
    near: ['青桥开发者交流会安排接口演示，参会者在入口领取印有议程的卡片。', '办公室打印机更换纸盒后，管理员更新了耗材登记表。']
  },
  {
    id: 'C04',
    lang: 'zh',
    kind: 'C',
    title: '虚构的南峦步道预约规则',
    question: '周末去南峦步道现在还可以直接到入口登记吗？',
    rows: ['南峦步道过去在入口现场登记，不需要提前预约，工作人员记录同行人数。', '旧出行笔记建议周末上午到入口后领取纸质通行卡。'],
    gold: '南峦管理处的新原创公告规定周末进入步道需要提前预约，现场登记仅适用于公告列明的工作日时段。以前的周末现场领卡建议已不能作为当前流程。',
    support: '出行前要检查预约日期和开放时段，预约成功也不保证恶劣天气时照常开放。',
    near: ['南峦自然摄影展收录四季的植物照片，展览门票与步道通行分开。', '步道附近的纪念品店周二休息，招牌使用当地艺术家的手写字体。']
  },
  {
    id: 'C05',
    lang: 'zh',
    kind: 'C',
    title: '虚构的镜禾导出格式',
    question: '镜禾软件现在导出记录仍然只给 CSV 吗？',
    rows: ['镜禾第一版只能导出CSV，嵌套记录需先转成文本列再保存。', '旧操作笔记从文件菜单选择CSV导出，要求用户另外保存嵌套字段说明。'],
    gold: '镜禾第二版的原创发布说明新增JSON导出，并继续保留CSV。需要保留嵌套结构时可选JSON，旧笔记中“仅有CSV”的说法只适用于第一版。',
    support: '导出前应确认目标系统支持的格式；新增JSON选项没有取消表格场景中的CSV。',
    near: ['镜禾用户分享会展示桌面主题配色，参与者投票选择下次活动的地点。', '软件包装设计采用折叠纸盒，印刷厂提供了三种纸张样本。']
  },
  {
    id: 'C06',
    lang: 'zh',
    kind: 'C',
    title: '虚构的沐溪公交线路',
    question: '沐溪公交七号线如今终点还是南站吗？',
    rows: ['沐溪七号线以前从北园开往南站，乘车笔记把南站写为最后一站。', '旧线路图显示七号线到南站后折返，换乘需要在南站下车。'],
    gold: '沐溪公交新原创线路通知将七号线延伸到滨河中心，南站成为中间站。当前终点是滨河中心，旧线路图只记录延伸前的运营情况。',
    support: '延伸段班次应参考当前时刻表，线路终点变化不代表所有旧站都取消。',
    near: ['沐溪车站墙面绘画邀请学生参与，周五下午举行作品展示。', '公交纪念卡展示不同年代的车辆图片，收藏活动在市民中心举行。']
  },
  {
    id: 'C07',
    lang: 'en',
    kind: 'C',
    title: 'Fictional CedarDB checkpoint command',
    question: 'Does the current CedarDB version still require the flush-all command before a manual checkpoint?',
    rows: [
      'CedarDB version 1 instructions require flush-all before a manual checkpoint to prepare the stored pages.',
      'The old operations notebook runs flush-all and then checkpoint, recording both commands in its maintenance checklist.'
    ],
    gold: 'The original fictional CedarDB version 2 release note says checkpoint now performs the required preparation itself. The separate flush-all step is no longer required for this operation; the older two-command checklist describes version 1.',
    support:
      'Operators should check the installed version before changing maintenance scripts. A revised checkpoint flow does not imply every maintenance command is obsolete.',
    near: [
      'The CedarDB community workshop offers coffee and a printed schedule at the reception desk.',
      'The office assigns storage cabinets by team and asks staff to return keys before the weekend.'
    ]
  },
  {
    id: 'C08',
    lang: 'en',
    kind: 'C',
    title: 'Fictional Harbor ferry baggage allowance',
    question: 'Is one large bag still the standard allowance on the Harbor ferry under its current passenger rules?',
    rows: [
      'The former Harbor ferry passenger guide allowed one large bag per adult, with additional baggage handled separately.',
      'An old travel note tells passengers to pack everything into one large bag to match the standard ferry allowance.'
    ],
    gold: 'The original fictional Harbor ferry update changes the standard adult allowance to two large bags. The former one-bag guide is outdated; size restrictions still apply separately and are not removed by the increased count.',
    support:
      'Passengers should distinguish the number of bags from their permitted dimensions and consult the current boarding information.',
    near: [
      'The Harbor ferry terminal hosts an exhibition of painted boats near the ticket hall.',
      'The souvenir desk wraps postcards in paper sleeves and closes shortly before the final departure.'
    ]
  },
  {
    id: 'C09',
    lang: 'en',
    kind: 'C',
    title: 'Fictional Kite API pagination fields',
    question: 'Should a new client of the latest Kite API keep sending a numeric page field?',
    rows: [
      'Kite API version 1 paginates with a numeric page field. The client increases that number after each response.',
      'The old integration notes begin with page=1 and continue until an empty result is returned.'
    ],
    gold: 'The original fictional Kite API version 2 migration note replaces numeric page pagination with an opaque cursor returned by the previous response. New clients should send that cursor; the numeric page examples apply to version 1.',
    support:
      'A cursor should be treated as an opaque value rather than incremented or interpreted as a page number. Clients also need the current end-of-list indicator.',
    near: [
      'The Kite developer gathering uses colored badges to identify workshop groups.',
      'The help desk replaces worn keyboard labels and records the date on a maintenance sheet.'
    ]
  },
  {
    id: 'C10',
    lang: 'en',
    kind: 'C',
    title: 'Fictional Pine sensor sampling setting',
    question: 'Is the present Pine sensor default still one reading every sixty seconds?',
    rows: [
      'The first Pine sensor manual specifies a default sampling interval of sixty seconds, producing one reading per minute.',
      'The old installation checklist leaves the sixty-second interval unchanged unless the operator needs faster sampling.'
    ],
    gold: 'The original fictional Pine sensor revision changes the default sampling interval to ten seconds. The sixty-second default in the first manual is historical; manually configured intervals remain subject to the device settings.',
    support:
      'After a firmware update, operators should inspect the actual configured interval rather than assuming every existing device adopts a new default.',
    near: [
      'The Pine product display uses a wooden stand and a printed information card beside each device.',
      'The workshop packs sensors in reusable cases and asks participants to return the empty cases.'
    ]
  }
]

export const WEB_EVAL = inputs.map(sample)
