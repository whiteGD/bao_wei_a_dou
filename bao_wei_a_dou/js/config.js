/**
 * 全局配置集中在这里，后续调数值时尽量只改本文件。
 * 当前数值来自产品PRD.md，部分未完全确认的内容按 PRD 建议值落地。
 */

const APP_ID = 'wxad2cd200f883d60e';

// 云开发环境 ID 还未提供。填入真实环境 ID 后，CloudService 会自动优先调用云函数。
const CLOUD_ENV_ID = '';

const SIDES = {
  SELF: 'self',
  RIVAL: 'rival'
};

const TILE = {
  GRASS: 'grass',
  BUILD: 'build',
  PATH: 'path',
  BASE: 'base'
};

const ITEM_KIND = {
  BASIC: 'basic',
  SPECIAL_CHAR: 'specialChar',
  HERO: 'hero',
  SHOVEL: 'shovel'
};

const GAME_STATUS = {
  HOME: 'home',
  ROOM: 'room',
  PLAYING: 'playing',
  PAUSE_PENDING: 'pausePending',
  PAUSED: 'paused',
  FINISHED: 'finished'
};

// 参考图约为 9x10 棋盘。为了方便实现镜像与触摸映射，逻辑坐标固定从左上角开始。
const BOARD = {
  cols: 9,
  rows: 10,
  initialBuildCells: [
    { x: 3, y: 1 },
    { x: 4, y: 1 },
    { x: 5, y: 1 },
    { x: 3, y: 2 },
    { x: 4, y: 2 },
    { x: 5, y: 2 }
  ],
  // 路径参考图中棕色道路，从左下入口绕到右下“斗”。
  path: [
    { x: 0, y: 6 },
    { x: 1, y: 6 },
    { x: 2, y: 6 },
    { x: 3, y: 6 },
    { x: 4, y: 6 },
    { x: 5, y: 6 },
    { x: 5, y: 5 },
    { x: 5, y: 4 },
    { x: 5, y: 3 },
    { x: 6, y: 3 },
    { x: 7, y: 3 },
    { x: 8, y: 3 },
    { x: 8, y: 4 },
    { x: 8, y: 5 },
    { x: 8, y: 6 },
    { x: 8, y: 7 },
    { x: 8, y: 8 },
    { x: 8, y: 9 }
  ],
  baseCell: { x: 8, y: 9 }
};

const PLAYER_DEFAULTS = {
  hp: 3,
  gold: 20,
  recruitBaseCost: 10,
  recruitCostStep: 2,
  benchSize: 5
};

const RECRUIT_WEIGHTS = {
  basic: 80,
  specialChar: 15,
  shovel: 5
};

const BASIC_UNIT_IDS = ['spear', 'blade', 'bow', 'cavalry'];
const SPECIAL_CHARS = ['张', '飞', '赵', '云', '刘', '备', '关', '羽', '马', '超', '黄', '忠'];

const BASIC_UNITS = {
  blade: {
    id: 'blade',
    text: '刀',
    kind: ITEM_KIND.BASIC,
    role: '近战单体',
    attackType: 'single',
    range: 1,
    levels: [
      { attack: 3, attackSpeed: 1.25 },
      { attack: 4.5, attackSpeed: 1.88 },
      { attack: 6.3, attackSpeed: 2.62 },
      { attack: 8.9, attackSpeed: 3.41 },
      { attack: 12.4, attackSpeed: 4.26 }
    ]
  },
  cavalry: {
    id: 'cavalry',
    text: '骑',
    kind: ITEM_KIND.BASIC,
    role: '范围伤害',
    attackType: 'area',
    range: 2,
    levels: [
      { attack: 2, attackSpeed: 1.25 },
      { attack: 3, attackSpeed: 1.88 },
      { attack: 4.2, attackSpeed: 2.62 },
      { attack: 5.9, attackSpeed: 3.41 },
      { attack: 8.2, attackSpeed: 4.26 }
    ]
  },
  spear: {
    id: 'spear',
    text: '枪',
    kind: ITEM_KIND.BASIC,
    role: '直线贯穿',
    attackType: 'pierce',
    range: 3,
    levels: [
      { attack: 2, attackSpeed: 1.25 },
      { attack: 3, attackSpeed: 1.88 },
      { attack: 4.2, attackSpeed: 2.62 },
      { attack: 5.9, attackSpeed: 3.41 },
      { attack: 8.2, attackSpeed: 4.26 }
    ]
  },
  bow: {
    id: 'bow',
    text: '弓',
    kind: ITEM_KIND.BASIC,
    role: '远程单体',
    attackType: 'single',
    range: 4,
    levels: [
      { attack: 2, attackSpeed: 1.25 },
      { attack: 3, attackSpeed: 1.88 },
      { attack: 4.2, attackSpeed: 2.62 },
      { attack: 5.9, attackSpeed: 3.41 },
      { attack: 8.2, attackSpeed: 4.26 }
    ]
  }
};

const HERO_PAIRS = {
  张飞: ['张', '飞'],
  赵云: ['赵', '云'],
  刘备: ['刘', '备'],
  关羽: ['关', '羽'],
  马超: ['马', '超'],
  黄忠: ['黄', '忠']
};

const HERO_CONFIGS = {
  张飞: { text: '张飞', baseType: 'blade', attack: 8, attackSpeed: 1.1, range: 1, skill: 'roar' },
  赵云: { text: '赵云', baseType: 'spear', attack: 6, attackSpeed: 1.25, range: 3, skill: 'combo' },
  刘备: { text: '刘备', baseType: 'support', attack: 4, attackSpeed: 1, range: 3, skill: 'boost' },
  关羽: { text: '关羽', baseType: 'blade', attack: 7, attackSpeed: 1.2, range: 2, skill: 'slash' },
  马超: { text: '马超', baseType: 'cavalry', attack: 6, attackSpeed: 1.25, range: 2, skill: 'slow' },
  黄忠: { text: '黄忠', baseType: 'bow', attack: 6, attackSpeed: 1.25, range: 4, skill: 'arrowRain' }
};

const HERO_GROWTH = [
  { attackRate: 1, speedRate: 1 },
  { attackRate: 1.5, speedRate: 1.3 },
  { attackRate: 2.1, speedRate: 1.7 },
  { attackRate: 2.85, speedRate: 2.15 },
  { attackRate: 3.75, speedRate: 2.7 }
];

const HERO_EXP_NEEDS = [10, 35, 75, 130];

const GENERALS = [
  { name: '吕布', skillText: '基础单位攻击降低', type: 'attackDown' },
  { name: '司马懿', skillText: '基础单位攻速降低', type: 'speedDown' },
  { name: '董卓', skillText: '随机白格变绿', type: 'sealCell' },
  { name: '曹操', skillText: '敌人护甲提升', type: 'armorUp' }
];

const COLORS = {
  bg: '#eee1cf',
  ink: '#241915',
  mutedInk: '#69564b',
  grass: '#92b9a3',
  grassLine: '#739682',
  build: '#f6f4ec',
  path: '#c7ad99',
  pathLine: '#9f8674',
  base: '#f2d9bf',
  panel: '#e7d5bd',
  button: '#c96e45',
  buttonDark: '#6a2f20',
  gold: '#f5d37a',
  danger: '#ba2f2f',
  shadow: 'rgba(36, 25, 21, 0.22)'
};

module.exports = {
  APP_ID,
  CLOUD_ENV_ID,
  SIDES,
  TILE,
  ITEM_KIND,
  GAME_STATUS,
  BOARD,
  PLAYER_DEFAULTS,
  RECRUIT_WEIGHTS,
  BASIC_UNIT_IDS,
  SPECIAL_CHARS,
  BASIC_UNITS,
  HERO_PAIRS,
  HERO_CONFIGS,
  HERO_GROWTH,
  HERO_EXP_NEEDS,
  GENERALS,
  COLORS
};
