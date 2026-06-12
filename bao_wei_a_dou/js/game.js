const {
  SIDES,
  TILE,
  ITEM_KIND,
  GAME_STATUS,
  BOARD,
  PLAYER_DEFAULTS,
  BASIC_UNITS,
  HERO_PAIRS,
  HERO_CONFIGS,
  HERO_GROWTH,
  HERO_EXP_NEEDS,
  GENERALS,
  COLORS
} = require('./config');
const {
  clamp,
  lerp,
  distance,
  manhattan,
  sameCell,
  cellKey,
  now,
  makeId,
  pointInRect,
  roundedRect,
  drawCenteredText,
  wrapText
} = require('./utils');
const { AudioManager } = require('./audio');
const { CloudService } = require('./cloud');

/**
 * 主游戏类。
 * 当前项目是原生微信小游戏，没有引入第三方引擎，所以这里自己维护：
 * 1. Canvas 渲染循环。
 * 2. 触摸输入。
 * 3. 棋盘和单位状态。
 * 4. 波次、敌人、攻击、合成。
 */
class Game {
  constructor() {
    this.canvas = wx.createCanvas();
    this.ctx = this.canvas.getContext('2d');
    this.width = this.canvas.width;
    this.height = this.canvas.height;

    this.audio = new AudioManager();
    this.cloud = new CloudService();

    this.status = GAME_STATUS.HOME;
    this.lastFrameAt = now();
    this.drag = null;
    this.selectedUnit = null;
    this.toast = null;
    this.modal = null;
    this.buttons = {};
    this.layout = {};

    this.room = null;
    this.selfSide = 'A';
    this.launchRoomId = '';

    this.players = {};
    this.boards = {};
    this.effects = [];

    this.handleTouchStart = this.handleTouchStart.bind(this);
    this.handleTouchMove = this.handleTouchMove.bind(this);
    this.handleTouchEnd = this.handleTouchEnd.bind(this);
    this.loop = this.loop.bind(this);
  }

  // 游戏启动入口：初始化云服务、读取分享参数、绑定触摸事件，并进入首页循环。
  start() {
    this.cloud.init();
    this.readLaunchOptions();
    this.bindEvents();
    this.resetLocalGame();
    this.showHome();

    if (typeof wx !== 'undefined' && wx.showShareMenu) {
      wx.showShareMenu({ withShareTicket: true });
      wx.onShareAppMessage(() => ({
        title: '来和我一起保卫阿斗',
        query: this.room ? `roomId=${this.room.roomId}` : ''
      }));
    }

    this.loop();
  }

  // 读取微信启动参数。通过分享链接进入房间时，roomId 会放在 query 里。
  readLaunchOptions() {
    if (typeof wx === 'undefined' || !wx.getLaunchOptionsSync) return;
    const options = wx.getLaunchOptionsSync();
    this.launchRoomId = options && options.query && options.query.roomId ? options.query.roomId : '';
  }

  // 统一绑定微信触摸事件，后续所有点击、拖拽都从这三个入口分发。
  bindEvents() {
    wx.onTouchStart(this.handleTouchStart);
    wx.onTouchMove(this.handleTouchMove);
    wx.onTouchEnd(this.handleTouchEnd);
  }

  // 切回首页状态，同时清空首页之外的弹窗和按钮缓存。
  showHome() {
    this.status = GAME_STATUS.HOME;
    this.buttons = {};
    this.modal = null;
  }

  // 创建房间并开始对局。云环境未配置时会走 CloudService 的本地模拟逻辑。
  async createRoomAndStart() {
    const room = await this.cloud.createRoom();
    this.room = room;
    this.selfSide = room.side || 'A';
    this.resetLocalGame(room.seed || String(Date.now()));
    this.status = GAME_STATUS.PLAYING;
    this.toastMessage('已创建房间，本地先进入对局');
  }

  // 加入分享房间并开始对局。当前版本本地模拟对手，后续可替换为真实同步。
  async joinRoomAndStart() {
    const room = await this.cloud.joinRoom(this.launchRoomId);
    this.room = room;
    this.selfSide = room.side || 'B';
    this.resetLocalGame(room.seed || String(Date.now()));
    this.status = GAME_STATUS.PLAYING;
    this.toastMessage('已加入房间，本地先进入对局');
  }

  // 重置一局本地游戏：双方玩家、双方棋盘、拖拽状态和临时提示都会回到初始值。
  resetLocalGame(seed) {
    this.seed = seed || String(Date.now());
    this.players = {
      [SIDES.SELF]: createPlayerState(SIDES.SELF),
      [SIDES.RIVAL]: createPlayerState(SIDES.RIVAL)
    };
    this.boards = {
      [SIDES.SELF]: createBoardState(SIDES.SELF),
      [SIDES.RIVAL]: createBoardState(SIDES.RIVAL)
    };
    this.effects = [];
    this.drag = null;
    this.selectedUnit = null;
    this.toast = null;
  }

  // 主循环：计算本帧时间差，更新游戏逻辑，再重绘 Canvas。
  loop() {
    const frameAt = now();
    const dt = clamp((frameAt - this.lastFrameAt) / 1000, 0, 0.05);
    this.lastFrameAt = frameAt;

    this.update(dt);
    this.render();

    const raf = this.canvas.requestAnimationFrame
      || (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : null);
    if (!raf) {
      setTimeout(this.loop, 1000 / 60);
      return;
    }
    raf(this.loop);
  }

  // 每帧更新入口。只有 PLAYING 状态会推进双方战斗，其余状态只更新提示和特效。
  update(dt) {
    if (this.status === GAME_STATUS.PLAYING) {
      this.updateSide(SIDES.SELF, dt);
      this.updateSide(SIDES.RIVAL, dt);
    }

    // 所有效果都用剩余时间控制生命周期，渲染时按进度显示淡出。
    for (let i = this.effects.length - 1; i >= 0; i -= 1) {
      const effect = this.effects[i];
      effect.life -= dt;
      if (effect.life <= 0) this.effects.splice(i, 1);
    }

    if (this.toast && now() > this.toast.until) {
      this.toast = null;
    }
  }

  // 更新某一方的完整战斗状态：开波、出怪、单位攻击、检查波次结束。
  updateSide(side, dt) {
    const board = this.boards[side];
    const player = this.players[side];
    if (player.hp <= 0) return;

    board.waveClock -= dt;
    if (!board.waveActive && board.waveClock <= 0) {
      this.startWave(side);
    }

    this.updateEnemies(side, dt);
    this.updateUnits(side, dt);
    this.checkWaveEnd(side);
  }

  // 开始新一波敌人，并在大将波触发前置提示和全局干扰效果。
  startWave(side) {
    const board = this.boards[side];
    board.wave += 1;
    board.waveActive = true;
    board.spawnedInWave = 0;
    board.spawnClock = 0;
    board.waveConfig = createWaveConfig(board.wave);

    if (board.waveConfig.general) {
      this.showGeneralWarning(side, board.waveConfig.general);
      this.applyGeneralSkill(side, board.waveConfig.general);
    } else {
      this.toastMessage(`${side === SIDES.SELF ? '我方' : '对方'} 第${board.wave}波`);
    }
  }

  // 显示敌方大将提示。side 决定提示文案里显示“我方”还是“对方”。
  showGeneralWarning(side, general) {
    const label = side === SIDES.SELF ? '我方遭遇' : '对方遭遇';
    this.toastMessage(`${label}${general.name}：${general.skillText}`);
    this.audio.play('warning');
  }

  // 应用大将带来的干扰效果，比如封格、降攻速、加敌人护甲。
  applyGeneralSkill(side, general) {
    const board = this.boards[side];

    if (general.type === 'sealCell') {
      const candidates = [];
      board.tiles.forEach((tile) => {
        if (tile.type === TILE.BUILD && !this.findUnitAt(side, tile)) {
          candidates.push(tile);
        }
      });
      if (candidates.length > 0) {
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        target.type = TILE.GRASS;
        this.effects.push({ type: 'seal', side, cell: { x: target.x, y: target.y }, life: 0.7 });
      }
    }

    if (general.type === 'attackDown') board.debuff.attackDown = 0.85;
    if (general.type === 'speedDown') board.debuff.speedDown = 0.85;
    if (general.type === 'armorUp') board.debuff.armorUp = 2;
  }

  // 推进敌人生成和移动。敌人走到路径终点后会扣对应玩家血量。
  updateEnemies(side, dt) {
    const board = this.boards[side];
    if (board.waveActive && board.spawnedInWave < board.waveConfig.enemyCount) {
      board.spawnClock -= dt;
      if (board.spawnClock <= 0) {
        this.spawnEnemy(side, false);
        board.spawnedInWave += 1;
        board.spawnClock = board.waveConfig.spawnInterval;
      }
    }

    if (board.waveActive
      && board.waveConfig.general
      && !board.generalSpawned
      && board.spawnedInWave >= Math.ceil(board.waveConfig.enemyCount / 2)) {
      this.spawnEnemy(side, true);
      board.generalSpawned = true;
    }

    for (let i = board.enemies.length - 1; i >= 0; i -= 1) {
      const enemy = board.enemies[i];
      enemy.slowTime = Math.max(0, enemy.slowTime - dt);
      const speed = enemy.speed * (enemy.slowTime > 0 ? 0.55 : 1);
      enemy.pathProgress += speed * dt;

      if (enemy.pathProgress >= BOARD.path.length - 1) {
        board.enemies.splice(i, 1);
        this.damageBase(side);
      }
    }
  }

  // 生成普通敌人或大将敌人。大将拥有更高血量和护甲。
  spawnEnemy(side, isGeneral) {
    const board = this.boards[side];
    const cfg = board.waveConfig;
    const general = isGeneral ? cfg.general : null;
    const hp = isGeneral ? cfg.enemyHp * 4 : cfg.enemyHp;
    const armor = isGeneral ? cfg.enemyArmor + 3 : cfg.enemyArmor + (board.debuff.armorUp || 0);

    board.enemies.push({
      id: makeId(isGeneral ? 'general' : 'enemy'),
      side,
      isGeneral,
      name: general ? general.name : '贼',
      hp,
      maxHp: hp,
      armor,
      speed: cfg.enemySpeed,
      pathProgress: 0,
      slowTime: 0
    });
  }

  // 基地受伤处理。血量归零时结束游戏。
  damageBase(side) {
    const player = this.players[side];
    player.hp -= 1;
    this.audio.play('hit');
    this.effects.push({ type: 'baseHit', side, life: 0.5 });

    if (player.hp <= 0) {
      this.finishGame(side);
    }
  }

  // 结束对局，展示结果弹窗，并通知云服务记录结算。
  async finishGame(failedSide) {
    if (this.status === GAME_STATUS.FINISHED) return;
    this.status = GAME_STATUS.FINISHED;
    this.audio.play('finish');
    const winner = failedSide === SIDES.SELF ? SIDES.RIVAL : SIDES.SELF;
    this.modal = {
      title: failedSide === SIDES.SELF ? '战败' : '获胜',
      message: winner === SIDES.SELF ? '你坚持到了最后' : '对方坚持到了最后'
    };
    await this.cloud.finishGame({ failedSide, winner, roomId: this.room && this.room.roomId });
  }

  // 推进所有己方单位攻击冷却，冷却结束后寻找目标并攻击。
  updateUnits(side, dt) {
    const board = this.boards[side];
    board.units.forEach((unit) => {
      unit.attackCooldown -= dt;
      unit.skillCooldown -= dt;
      if (unit.attackCooldown > 0) return;

      const targets = this.findTargetsForUnit(side, unit);
      if (targets.length === 0) return;

      this.attackTargets(side, unit, targets);
      unit.attackCooldown = 1 / getUnitStats(unit).attackSpeed;
    });
  }

  // 根据单位射程和攻击类型筛选目标。普通单体只取第一个，范围和穿透会返回多个。
  findTargetsForUnit(side, unit) {
    const board = this.boards[side];
    const stats = getUnitStats(unit);
    const enemiesInRange = board.enemies.filter((enemy) => (
      distance(unit.cell, this.enemyCell(enemy)) <= stats.range
    ));

    if (enemiesInRange.length === 0) return [];

    if (unit.attackType === 'area') {
      return enemiesInRange;
    }

    if (unit.attackType === 'pierce') {
      const first = enemiesInRange[0];
      const firstCell = this.enemyCell(first);
      const dx = Math.sign(firstCell.x - unit.cell.x);
      const dy = Math.sign(firstCell.y - unit.cell.y);

      // 枪只攻击一个方向上的所有敌人。这里按首个目标决定方向，
      // 再筛选同一行/列或同一斜向的敌人，避免全范围无脑群伤。
      return enemiesInRange.filter((enemy) => {
        const cell = this.enemyCell(enemy);
        const ex = Math.sign(cell.x - unit.cell.x);
        const ey = Math.sign(cell.y - unit.cell.y);
        return ex === dx && ey === dy;
      });
    }

    return [enemiesInRange[0]];
  }

  // 对目标造成伤害，播放攻击反馈，并处理武将技能和敌人死亡。
  attackTargets(side, unit, targets) {
    const stats = getUnitStats(unit);
    const board = this.boards[side];
    let attack = stats.attack;

    if (unit.kind === ITEM_KIND.BASIC) {
      attack *= board.debuff.attackDown || 1;
    }

    targets.forEach((target) => {
      const damage = Math.max(1, attack - target.armor);
      target.hp -= damage;
      this.effects.push({
        type: 'damage',
        side,
        from: { x: unit.cell.x, y: unit.cell.y },
        to: this.enemyCell(target),
        text: `-${damage.toFixed(0)}`,
        life: 0.35
      });
    });

    this.tryHeroSkill(side, unit, targets[0]);
    this.removeDeadEnemies(side, unit);
    this.audio.play('attack');
  }

  // 武将技能触发逻辑。每个武将根据名字走不同技能分支。
  tryHeroSkill(side, unit, target) {
    if (unit.kind !== ITEM_KIND.HERO || !target) return;
    if (unit.skillCooldown > 0) return;

    const board = this.boards[side];
    const stats = getUnitStats(unit);

    if (unit.heroName === '黄忠' && Math.random() < 0.18) {
      board.enemies.forEach((enemy) => {
        enemy.hp -= Math.max(1, stats.attack * 0.8 - enemy.armor);
      });
      unit.skillCooldown = 8;
      this.effects.push({ type: 'heroSkill', side, text: '箭雨', life: 0.8 });
      this.removeDeadEnemies(side, unit);
    }

    if (unit.heroName === '马超' && Math.random() < 0.25) {
      target.slowTime = 2;
      unit.skillCooldown = 3;
    }

    if (unit.heroName === '赵云' && Math.random() < 0.22) {
      target.hp -= Math.max(1, stats.attack - target.armor);
      unit.skillCooldown = 2;
    }

    if (unit.heroName === '张飞' && Math.random() < 0.2) {
      board.enemies.forEach((enemy) => {
        if (manhattan(this.enemyCell(enemy), unit.cell) <= 2) enemy.armor = Math.max(0, enemy.armor - 1);
      });
      unit.skillCooldown = 5;
    }

    if (unit.heroName === '关羽' && Math.random() < 0.2) {
      board.enemies.forEach((enemy) => {
        const cell = this.enemyCell(enemy);
        if (cell.x === unit.cell.x || cell.y === unit.cell.y) {
          enemy.hp -= Math.max(1, stats.attack * 1.4 - enemy.armor);
        }
      });
      unit.skillCooldown = 5;
      this.removeDeadEnemies(side, unit);
    }

    if (unit.heroName === '刘备' && Math.random() < 0.2) {
      board.units.forEach((other) => {
        if (other !== unit && manhattan(other.cell, unit.cell) <= 2) {
          other.attackCooldown = Math.min(other.attackCooldown, 0.1);
        }
      });
      unit.skillCooldown = 4;
    }
  }

  // 移除死亡敌人，给玩家加金币；如果击杀者是武将，还会增加武将经验。
  removeDeadEnemies(side, killer) {
    const board = this.boards[side];
    const player = this.players[side];
    for (let i = board.enemies.length - 1; i >= 0; i -= 1) {
      const enemy = board.enemies[i];
      if (enemy.hp > 0) continue;

      board.enemies.splice(i, 1);
      player.gold += 1;
      this.effects.push({ type: 'coin', side, cell: this.enemyCell(enemy), life: 0.6 });

      if (killer && killer.kind === ITEM_KIND.HERO) {
        this.addHeroExp(killer, 1);
      }
    }
  }

  // 给武将加经验并处理连续升级。满级后不再获得等级提升。
  addHeroExp(unit, exp) {
    if (unit.level >= 5) return;
    unit.exp += exp;
    while (unit.level < 5 && unit.exp >= HERO_EXP_NEEDS[unit.level - 1]) {
      unit.exp -= HERO_EXP_NEEDS[unit.level - 1];
      unit.level += 1;
      this.effects.push({ type: 'levelUp', side: unit.side, cell: unit.cell, life: 0.8 });
      this.audio.play('merge');
    }
  }

  // 判断当前波次是否已经完全结束，并为下一波设置倒计时。
  checkWaveEnd(side) {
    const board = this.boards[side];
    if (!board.waveActive) return;
    if (board.spawnedInWave < board.waveConfig.enemyCount) return;
    if (board.enemies.length > 0) return;

    board.waveActive = false;
    board.waveClock = 3;
    board.generalSpawned = false;
    board.debuff = {};
  }

  // 根据敌人在路径上的进度，换算成棋盘上的连续坐标，方便移动和攻击判定。
  enemyCell(enemy) {
    const index = clamp(Math.floor(enemy.pathProgress), 0, BOARD.path.length - 1);
    const nextIndex = clamp(index + 1, 0, BOARD.path.length - 1);
    const t = enemy.pathProgress - index;
    const from = BOARD.path[index];
    const to = BOARD.path[nextIndex];
    return {
      x: lerp(from.x, to.x, t),
      y: lerp(from.y, to.y, t)
    };
  }

  async recruit(side) {
    const player = this.players[side];
    const cost = getRecruitCost(player);
    if (player.gold < cost) {
      this.toastMessage('金币不足');
      this.audio.play('error');
      return;
    }

    player.gold -= cost;
    const occupiedSpecialChars = this.collectOccupiedSpecialChars(side);
    const result = await this.cloud.recruit({
      roomId: this.room && this.room.roomId,
      seed: this.seed,
      side,
      recruitCount: player.recruitCount,
      occupiedSpecialChars
    });

    player.recruitCount += 1;
    player.bench = result.items.map((item) => createBenchItem(item));
    this.audio.play('recruit');
  }

  collectOccupiedSpecialChars(side) {
    const chars = {};
    this.boards[side].units.forEach((unit) => {
      if (unit.kind === ITEM_KIND.SPECIAL_CHAR) chars[unit.char] = true;
      if (unit.kind === ITEM_KIND.HERO) {
        HERO_PAIRS[unit.heroName].forEach((char) => { chars[char] = true; });
      }
    });
    this.players[side].bench.forEach((item) => {
      if (item && item.kind === ITEM_KIND.SPECIAL_CHAR) chars[item.char] = true;
    });
    return Object.keys(chars);
  }

  // 总渲染入口。每一帧先计算布局，再按当前状态绘制首页或对局画面。
  render() {
    this.computeLayout();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    this.drawBackground(ctx);

    if (this.status === GAME_STATUS.HOME) {
      this.drawHome(ctx);
    } else {
      this.drawGame(ctx);
    }

    if (this.toast) this.drawToast(ctx);
    if (this.modal) this.drawModal(ctx);
    if (this.drag) this.drawDraggedItem(ctx);
  }

  // 根据当前屏幕尺寸计算棋盘、按钮、候选栏等区域，避免绘制和触摸判定各算一套。
  computeLayout() {
    const margin = 18;
    const boardW = Math.min(this.width - margin * 2, 360);
    const cell = Math.floor(boardW / BOARD.cols);
    const realBoardW = cell * BOARD.cols;
    const boardH = cell * BOARD.rows;
    const x = Math.floor((this.width - realBoardW) / 2);
    const selfY = Math.max(160, this.height - boardH - 128);
    const rivalScale = 0.42;
    const rivalCell = Math.max(12, Math.floor(cell * rivalScale));
    const rivalW = rivalCell * BOARD.cols;

    this.layout = {
      margin,
      cell,
      boardX: x,
      selfBoardY: selfY,
      boardW: realBoardW,
      boardH,
      rivalCell,
      rivalBoardX: Math.floor((this.width - rivalW) / 2),
      rivalBoardY: 78,
      rivalBoardW: rivalW,
      rivalBoardH: rivalCell * BOARD.rows,
      benchY: selfY + boardH + 16,
      benchCell: Math.floor((realBoardW - 16) / 5),
      recruitButton: { x: x + realBoardW / 2 - 66, y: selfY + boardH + 78, w: 132, h: 58 },
      pauseButton: { x: 14, y: 16, w: 44, h: 34 },
      muteButton: { x: this.width - 58, y: 16, w: 44, h: 34 },
      settingButton: { x: this.width - 112, y: 16, w: 44, h: 34 },
      resetButton: { x: this.width - 166, y: 16, w: 44, h: 34 }
    };
  }

  // 绘制整体背景，包括底色、山线和水纹。这里不再使用 image.png 参考图。
  drawBackground(ctx) {
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.width, this.height);

    // 简单山水线条，作为无正式资源阶段的水墨风占位背景。
    ctx.save();
    const mountainBands = [
      { y: 58, height: 28, count: 4, alpha: 0.13 },
      { y: 178, height: 24, count: 3, alpha: 0.08 },
      { y: 356, height: 30, count: 4, alpha: 0.07 },
      { y: 538, height: 24, count: 3, alpha: 0.08 }
    ];
    mountainBands.forEach((band) => {
      ctx.strokeStyle = `rgba(80, 65, 54, ${band.alpha})`;
      ctx.lineWidth = 2;
      for (let i = 0; i < band.count; i += 1) {
        const y = band.y + i * 11;
        const height = band.height + (i % 2) * 8;
        const startX = 16 + (i % 2) * 18;
        const endX = this.width - 16 - ((i + 1) % 2) * 18;
        ctx.beginPath();
        ctx.moveTo(startX, y);
        ctx.lineTo(this.width * 0.2, y - height);
        ctx.lineTo(this.width * 0.38, y - height * 0.35);
        ctx.lineTo(this.width * 0.58, y - height * 1.15);
        ctx.lineTo(this.width * 0.78, y - height * 0.2);
        ctx.lineTo(endX, y - height * 0.65);
        ctx.stroke();
      }
    });

    ctx.strokeStyle = 'rgba(80, 65, 54, 0.095)';
    ctx.lineWidth = 1;
    const waterBands = [
      { y: 122, rows: 2 },
      { y: 268, rows: 3 },
      { y: 430, rows: 3 },
      { y: 610, rows: 2 }
    ];
    waterBands.forEach((band, bandIndex) => {
      for (let row = 0; row < band.rows; row += 1) {
        const y = band.y + row * 9;
        const offset = ((bandIndex + row) % 2) * 28;
        for (let x = 28 + offset; x < this.width - 36; x += 74) {
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.quadraticCurveTo(x + 16, y - 5, x + 32, y);
          ctx.quadraticCurveTo(x + 46, y + 4, x + 62, y - 1);
          ctx.stroke();
        }
      }
    });

    ctx.strokeStyle = 'rgba(80, 65, 54, 0.06)';
    for (let i = 0; i < 5; i += 1) {
      const y = 86 + i * 104;
      for (let x = 42; x < this.width - 54; x += 96) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + 22, y + 7, x + 48, y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // 绘制首页：标题、说明和创建/加入/本地练习按钮。
  drawHome(ctx) {
    drawCenteredText(ctx, '保卫阿斗', this.width / 2, 132, {
      font: 'bold 42px serif',
      color: COLORS.ink,
      stroke: '#fff7eb',
      strokeWidth: 5
    });

    ctx.fillStyle = COLORS.mutedInk;
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    wrapText(ctx, '双人独立防守，征兵合字，守住自己的“斗”。', this.width / 2, 178, this.width - 56, 22);

    const createBtn = { x: 58, y: 250, w: this.width - 116, h: 56 };
    const joinBtn = { x: 58, y: 324, w: this.width - 116, h: 56 };
    const localBtn = { x: 58, y: 398, w: this.width - 116, h: 56 };
    this.buttons = { createBtn, joinBtn, localBtn };
    this.drawButton(ctx, createBtn, '创建房间');
    this.drawButton(ctx, joinBtn, '加入房间');
    this.drawButton(ctx, localBtn, '本地练习');

    ctx.fillStyle = COLORS.mutedInk;
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('云环境 ID 未配置时会自动使用本地模拟', this.width / 2, 482);
  }

  // 绘制对局主界面：顶部状态栏、双方棋盘、候选栏、按钮和临时效果。
  drawGame(ctx) {
    this.buttons = {
      pause: this.layout.pauseButton,
      mute: this.layout.muteButton,
      setting: this.layout.settingButton,
      reset: this.layout.resetButton,
      recruit: this.layout.recruitButton
    };

    this.drawTopBar(ctx);
    this.drawBoard(ctx, SIDES.RIVAL, true);
    this.drawBoard(ctx, SIDES.SELF, false);
    this.drawSelectedUnitInfo(ctx);
    this.drawBench(ctx);
    this.drawRecruitButton(ctx);
    this.drawEffects(ctx);
  }

  // 绘制顶部资源和状态信息，包括血量、金币、波次、静音等按钮。
  drawTopBar(ctx) {
    this.drawIconButton(ctx, this.layout.pauseButton, this.status === GAME_STATUS.PAUSED ? '▶' : 'Ⅱ');
    this.drawIconButton(ctx, this.layout.resetButton, '↻');
    this.drawIconButton(ctx, this.layout.settingButton, '设');
    this.drawIconButton(ctx, this.layout.muteButton, this.audio.muted ? '静' : '音');

    const player = this.players[SIDES.SELF];
    ctx.fillStyle = COLORS.ink;
    ctx.font = '18px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`金币 ${player.gold}`, 72, 28);
    ctx.fillText(`生命 ${'♥'.repeat(Math.max(0, player.hp))}`, 72, 52);

    const board = this.boards[SIDES.SELF];
    ctx.textAlign = 'center';
    ctx.font = 'bold 18px serif';
    ctx.fillText(`第${Math.max(1, board.wave || 1)}波`, this.width / 2, 36);
    if (!board.waveActive) {
      ctx.font = '13px sans-serif';
      ctx.fillText(`准备 ${Math.ceil(board.waveClock)}s`, this.width / 2, 56);
    }
  }

  // 绘制单方棋盘。small=true 时用于对手小棋盘，false 时用于本方主棋盘。
  drawBoard(ctx, side, small) {
    const l = this.layout;
    const cell = small ? l.rivalCell : l.cell;
    const x0 = small ? l.rivalBoardX : l.boardX;
    const y0 = small ? l.rivalBoardY : l.selfBoardY;
    const board = this.boards[side];

    ctx.save();
    if (small) ctx.globalAlpha = 0.74;

    ctx.fillStyle = COLORS.shadow;
    roundedRect(ctx, x0 + 3, y0 + 4, cell * BOARD.cols, cell * BOARD.rows, 5);
    ctx.fill();

    board.tiles.forEach((tile) => {
      const pos = this.cellToPixel(tile, side, small);
      ctx.fillStyle = tile.type === TILE.PATH ? COLORS.path
        : tile.type === TILE.BUILD ? COLORS.build
          : tile.type === TILE.BASE ? COLORS.base
            : COLORS.grass;
      ctx.fillRect(pos.x, pos.y, cell, cell);
      ctx.strokeStyle = tile.type === TILE.PATH ? COLORS.pathLine : COLORS.grassLine;
      ctx.lineWidth = 1;
      ctx.strokeRect(pos.x, pos.y, cell, cell);

      if (tile.type === TILE.GRASS) {
        ctx.fillStyle = 'rgba(40,70,50,0.13)';
        ctx.fillRect(pos.x + cell * 0.25, pos.y + cell * 0.45, cell * 0.5, 1);
      }
    });

    this.drawSelectedRange(ctx, side, small);
    board.units.forEach((unit) => this.drawUnit(ctx, unit, side, small));
    board.enemies.forEach((enemy) => this.drawEnemy(ctx, enemy, side, small));

    const base = this.cellToPixel(BOARD.baseCell, side, small);
    drawCenteredText(ctx, '斗', base.x + cell / 2, base.y + cell / 2, {
      font: `bold ${Math.floor(cell * 0.72)}px serif`,
      color: COLORS.ink
    });

    ctx.restore();
  }

  // 绘制一个单位或武将，并根据等级、经验展示边框和进度信息。
  drawUnit(ctx, unit, side, small) {
    const cell = small ? this.layout.rivalCell : this.layout.cell;
    const pos = this.cellToPixel(unit.cell, side, small);
    const center = { x: pos.x + cell / 2, y: pos.y + cell / 2 };

    ctx.save();
    ctx.fillStyle = unit.kind === ITEM_KIND.HERO ? '#fff0c2' : '#fffaf0';
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = small ? 1 : 2;
    roundedRect(ctx, pos.x + 3, pos.y + 3, cell - 6, cell - 6, 4);
    ctx.fill();
    ctx.stroke();

    drawItemContent(ctx, unit, center.x, center.y - (small ? 0 : 2), cell);

    if (!small) {
      ctx.fillStyle = COLORS.danger;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(String(unit.level || 1), pos.x + cell - 6, pos.y + 12);
    }
    ctx.restore();
  }

  // 绘制当前选中单位的攻击范围。范围内部用半透明白色，最外圈用黑色边界线。
  drawSelectedRange(ctx, side, small) {
    if (small || side !== SIDES.SELF || !this.selectedUnit || !this.selectedUnit.cell) return;
    const board = this.boards[SIDES.SELF];
    if (board.units.indexOf(this.selectedUnit) === -1) return;

    const stats = getUnitStats(this.selectedUnit);
    const range = stats.range || 0;
    if (range <= 0) return;

    const cellSize = this.layout.cell;
    const pos = this.cellToPixel(this.selectedUnit.cell, SIDES.SELF, false);
    const cx = pos.x + cellSize / 2;
    const cy = pos.y + cellSize / 2;
    const radius = range * cellSize;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.24)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(20, 16, 14, 0.82)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  // 绘制选中单位的名字、等级、攻击、攻速、射程和攻击类型。
  drawSelectedUnitInfo(ctx) {
    const unit = this.selectedUnit;
    if (!unit || !unit.cell || this.boards[SIDES.SELF].units.indexOf(unit) === -1) return;

    const stats = getUnitStats(unit);
    const rect = {
      x: this.layout.boardX,
      y: Math.max(68, this.layout.selfBoardY - 56),
      w: this.layout.boardW,
      h: 46
    };

    ctx.save();
    ctx.fillStyle = 'rgba(246, 244, 236, 0.92)';
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 2;
    roundedRect(ctx, rect.x, rect.y, rect.w, rect.h, 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = COLORS.ink;
    ctx.textAlign = 'left';
    ctx.font = 'bold 14px serif';
    ctx.fillText(`${getUnitDisplayName(unit)}  Lv.${unit.level || 1}`, rect.x + 10, rect.y + 18);

    ctx.font = '12px sans-serif';
    ctx.fillStyle = COLORS.mutedInk;
    ctx.fillText(
      `攻 ${formatStat(stats.attack)}  速 ${formatStat(stats.attackSpeed)}  射程 ${stats.range || 0}  ${getUnitRoleLabel(unit)}`,
      rect.x + 10,
      rect.y + 36
    );
    ctx.restore();
  }

  // 绘制敌人或大将，包括血条和在路径上的当前位置。
  drawEnemy(ctx, enemy, side, small) {
    const cell = small ? this.layout.rivalCell : this.layout.cell;
    const logical = this.enemyCell(enemy);
    const pos = this.cellToPixel(logical, side, small);
    const cx = pos.x + cell / 2;
    const cy = pos.y + cell / 2;

    ctx.save();
    ctx.fillStyle = enemy.isGeneral ? '#3b2b2b' : '#4c4a42';
    ctx.strokeStyle = enemy.isGeneral ? '#c94c3a' : '#1f1c18';
    ctx.lineWidth = small ? 1 : 2;
    ctx.beginPath();
    ctx.arc(cx, cy, cell * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    if (!small) {
      drawCenteredText(ctx, enemy.isGeneral ? enemy.name.slice(0, 1) : '贼', cx, cy, {
        font: `bold ${Math.floor(cell * 0.32)}px serif`,
        color: '#f8eee0'
      });
      ctx.fillStyle = '#4f1e1e';
      ctx.fillRect(pos.x + 4, pos.y + 3, cell - 8, 4);
      ctx.fillStyle = '#e1533d';
      ctx.fillRect(pos.x + 4, pos.y + 3, (cell - 8) * clamp(enemy.hp / enemy.maxHp, 0, 1), 4);
    }
    ctx.restore();
  }

  // 绘制候选栏。征兵获得的单位、特殊字、铲子都会先放在这里。
  drawBench(ctx) {
    const player = this.players[SIDES.SELF];
    const y = this.layout.benchY;
    const cell = this.layout.benchCell;
    const startX = this.layout.boardX + 8;

    for (let i = 0; i < PLAYER_DEFAULTS.benchSize; i += 1) {
      const x = startX + i * cell;
      const rect = { x, y, w: cell - 5, h: cell - 5 };
      ctx.fillStyle = COLORS.build;
      ctx.strokeStyle = COLORS.mutedInk;
      ctx.lineWidth = 1.5;
      roundedRect(ctx, rect.x, rect.y, rect.w, rect.h, 4);
      ctx.fill();
      ctx.stroke();

      const item = player.bench[i];
      if (item) {
        drawItemContent(ctx, item, rect.x + rect.w / 2, rect.y + rect.h / 2, cell);
      }
    }
  }

  // 绘制征兵按钮，并根据金币是否足够显示可用/不可用状态。
  drawRecruitButton(ctx) {
    const player = this.players[SIDES.SELF];
    const cost = getRecruitCost(player);
    const rect = this.layout.recruitButton;
    const disabled = player.gold < cost;
    this.drawButton(ctx, rect, '征兵', disabled);
    drawCenteredText(ctx, `🪙 ${cost}`, rect.x + rect.w / 2, rect.y + rect.h - 14, {
      font: '14px sans-serif',
      color: disabled ? '#846d5c' : '#fff8e6'
    });
  }

  // 通用文字按钮绘制方法。
  drawButton(ctx, rect, text, disabled) {
    ctx.save();
    ctx.fillStyle = disabled ? '#9d8d7e' : COLORS.button;
    ctx.strokeStyle = COLORS.buttonDark;
    ctx.lineWidth = 3;
    roundedRect(ctx, rect.x, rect.y, rect.w, rect.h, 6);
    ctx.fill();
    ctx.stroke();
    drawCenteredText(ctx, text, rect.x + rect.w / 2, rect.y + rect.h / 2 - 2, {
      font: 'bold 22px sans-serif',
      color: '#fff8e6',
      stroke: COLORS.buttonDark,
      strokeWidth: 2
    });
    ctx.restore();
  }

  // 顶部小图标按钮绘制方法。
  drawIconButton(ctx, rect, text) {
    ctx.save();
    ctx.fillStyle = COLORS.panel;
    ctx.strokeStyle = COLORS.mutedInk;
    ctx.lineWidth = 2;
    roundedRect(ctx, rect.x, rect.y, rect.w, rect.h, 5);
    ctx.fill();
    ctx.stroke();
    drawCenteredText(ctx, text, rect.x + rect.w / 2, rect.y + rect.h / 2, {
      font: 'bold 16px sans-serif',
      color: COLORS.ink
    });
    ctx.restore();
  }

  // 绘制伤害、金币、升级、封格等短生命周期特效。
  drawEffects(ctx) {
    this.effects.forEach((effect) => {
      ctx.save();
      ctx.globalAlpha = clamp(effect.life / 0.8, 0, 1);
      const side = effect.side || SIDES.SELF;
      const small = side === SIDES.RIVAL;

      if (effect.type === 'damage') {
        const from = this.cellToPixel(effect.from, side, small);
        const to = this.cellToPixel(effect.to, side, small);
        const cell = small ? this.layout.rivalCell : this.layout.cell;
        ctx.strokeStyle = '#3e2723';
        ctx.lineWidth = small ? 1 : 2;
        ctx.beginPath();
        ctx.moveTo(from.x + cell / 2, from.y + cell / 2);
        ctx.lineTo(to.x + cell / 2, to.y + cell / 2);
        ctx.stroke();
        drawCenteredText(ctx, effect.text, to.x + cell / 2, to.y - 4, {
          font: '13px sans-serif',
          color: COLORS.danger
        });
      }

      if (effect.type === 'levelUp' || effect.type === 'coin' || effect.type === 'seal') {
        const pos = this.cellToPixel(effect.cell, side, small);
        const cell = small ? this.layout.rivalCell : this.layout.cell;
        const label = effect.type === 'levelUp' ? '升级' : effect.type === 'coin' ? '+1' : '封';
        drawCenteredText(ctx, label, pos.x + cell / 2, pos.y + 8, {
          font: 'bold 16px sans-serif',
          color: effect.type === 'seal' ? COLORS.danger : '#d78b2d'
        });
      }

      if (effect.type === 'heroSkill') {
        drawCenteredText(ctx, effect.text, this.width / 2, this.height / 2, {
          font: 'bold 42px serif',
          color: COLORS.danger,
          stroke: '#fff4df',
          strokeWidth: 4
        });
      }

      ctx.restore();
    });
  }

  // 绘制顶部临时提示条。
  drawToast(ctx) {
    const text = this.toast.text;
    const w = Math.min(this.width - 56, 260);
    const h = 38;
    const x = (this.width - w) / 2;
    const y = 86;
    ctx.save();
    ctx.fillStyle = 'rgba(36,25,21,0.82)';
    roundedRect(ctx, x, y, w, h, 6);
    ctx.fill();
    drawCenteredText(ctx, text, x + w / 2, y + h / 2, {
      font: '14px sans-serif',
      color: '#fff8e6'
    });
    ctx.restore();
  }

  // 绘制结算弹窗和弹窗按钮。
  drawModal(ctx) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, this.width, this.height);
    const rect = { x: 42, y: this.height / 2 - 120, w: this.width - 84, h: 220 };
    ctx.fillStyle = COLORS.panel;
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 3;
    roundedRect(ctx, rect.x, rect.y, rect.w, rect.h, 8);
    ctx.fill();
    ctx.stroke();
    drawCenteredText(ctx, this.modal.title, this.width / 2, rect.y + 54, {
      font: 'bold 32px serif',
      color: COLORS.ink
    });
    drawCenteredText(ctx, this.modal.message, this.width / 2, rect.y + 96, {
      font: '16px sans-serif',
      color: COLORS.mutedInk
    });
    const btn = { x: rect.x + 44, y: rect.y + 142, w: rect.w - 88, h: 48 };
    this.buttons.modalRestart = btn;
    this.drawButton(ctx, btn, '再来一局');
    ctx.restore();
  }

  // 拖拽过程中绘制跟随手指移动的单位/道具预览。
  drawDraggedItem(ctx) {
    const item = this.drag.item;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#fff8e8';
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 2;
    const size = this.layout.cell * 0.9;
    roundedRect(ctx, this.drag.x - size / 2, this.drag.y - size / 2, size, size, 5);
    ctx.fill();
    ctx.stroke();
    drawItemContent(ctx, item, this.drag.x, this.drag.y, size);
    ctx.restore();
  }

  // 触摸开始：负责首页按钮、顶部按钮、征兵按钮，以及从候选栏/棋盘开始拖拽。
  handleTouchStart(event) {
    const p = getTouchPoint(event);
    if (!p) return;

    if (this.status === GAME_STATUS.HOME) {
      if (pointInRect(p, this.buttons.createBtn)) this.createRoomAndStart();
      else if (pointInRect(p, this.buttons.joinBtn)) this.joinRoomAndStart();
      else if (pointInRect(p, this.buttons.localBtn)) {
        this.resetLocalGame();
        this.status = GAME_STATUS.PLAYING;
      }
      return;
    }

    if (this.modal && pointInRect(p, this.buttons.modalRestart)) {
      this.resetLocalGame();
      this.status = GAME_STATUS.PLAYING;
      this.modal = null;
      return;
    }

    if (pointInRect(p, this.layout.pauseButton)) {
      this.requestPause();
      return;
    }
    if (pointInRect(p, this.layout.muteButton)) {
      this.audio.toggleMuted();
      return;
    }
    if (pointInRect(p, this.layout.settingButton)) {
      this.toastMessage('设置：音=静音，↻=重开，Ⅱ=暂停');
      return;
    }
    if (pointInRect(p, this.layout.resetButton)) {
      this.resetLocalGame();
      this.status = GAME_STATUS.PLAYING;
      return;
    }
    if (pointInRect(p, this.layout.recruitButton)) {
      this.recruit(SIDES.SELF);
      return;
    }

    if (this.status !== GAME_STATUS.PLAYING) return;

    const benchIndex = this.getBenchIndexAt(p);
    if (benchIndex !== -1) {
      this.selectedUnit = null;
      const item = this.players[SIDES.SELF].bench[benchIndex];
      if (item) {
        this.drag = { item, source: 'bench', benchIndex, x: p.x, y: p.y, startX: p.x, startY: p.y, moved: false };
        this.audio.play('drag');
      }
      return;
    }

    const cell = this.pixelToCell(p, SIDES.SELF, false);
    if (cell) {
      const unit = this.findUnitAt(SIDES.SELF, cell);
      if (unit) {
        this.drag = { item: unit, source: 'board', fromCell: { x: unit.cell.x, y: unit.cell.y }, x: p.x, y: p.y, startX: p.x, startY: p.y, moved: false };
        this.audio.play('drag');
      } else {
        this.selectedUnit = null;
      }
    } else {
      this.selectedUnit = null;
    }
  }

  // 触摸移动：如果正在拖拽，就更新拖拽物体的屏幕坐标。
  handleTouchMove(event) {
    if (!this.drag) return;
    const p = getTouchPoint(event);
    if (!p) return;
    const dx = p.x - this.drag.startX;
    const dy = p.y - this.drag.startY;
    if (Math.sqrt(dx * dx + dy * dy) > 8) this.drag.moved = true;
    this.drag.x = p.x;
    this.drag.y = p.y;
  }

  // 触摸结束：停止拖拽，并把拖拽物交给 dropDraggedItem 判断落点行为。
  handleTouchEnd(event) {
    if (!this.drag) return;
    const p = getTouchPoint(event) || { x: this.drag.x, y: this.drag.y };
    const drag = this.drag;
    this.drag = null;
    const dx = p.x - drag.startX;
    const dy = p.y - drag.startY;
    if (Math.sqrt(dx * dx + dy * dy) > 8) drag.moved = true;
    if (drag.source === 'board' && !drag.moved) {
      this.selectedUnit = drag.item;
      return;
    }
    this.selectedUnit = null;
    this.dropDraggedItem(drag, p);
  }

  // 根据拖拽物落点决定行为：放回候选栏、使用铲子、合成或放置单位。
  dropDraggedItem(drag, point) {
    const benchIndex = this.getBenchIndexAt(point);
    if (benchIndex !== -1 && drag.source === 'board') {
      this.moveUnitToBench(drag.item, benchIndex);
      return;
    }

    const cell = this.pixelToCell(point, SIDES.SELF, false);
    if (!cell) return;

    if (drag.item.kind === ITEM_KIND.SHOVEL) {
      this.useShovel(drag, cell);
      return;
    }

    const targetUnit = this.findUnitAt(SIDES.SELF, cell);
    if (targetUnit && targetUnit !== drag.item) {
      if (this.tryMergeUnits(drag, targetUnit)) return;
      if (this.trySwapUnits(drag, targetUnit)) return;
      this.toastMessage('不能合成');
      this.audio.play('error');
      return;
    }

    this.placeUnit(drag, cell);
  }

  // 把棋盘上的单位移动回候选栏指定格子。
  moveUnitToBench(unit, benchIndex) {
    const player = this.players[SIDES.SELF];
    if (player.bench[benchIndex]) {
      this.toastMessage('候选格已满');
      this.audio.play('error');
      return;
    }
    const board = this.boards[SIDES.SELF];
    board.units = board.units.filter((item) => item !== unit);
    player.bench[benchIndex] = unit;
    unit.cell = null;
    this.audio.play('place');
  }

  // 使用铲子把草地改成可放置的白色建造格。
  useShovel(drag, cell) {
    const tile = this.getTile(SIDES.SELF, cell);
    if (!tile || tile.type !== TILE.GRASS) {
      this.toastMessage('只能铲绿色格');
      this.audio.play('error');
      return;
    }
    tile.type = TILE.BUILD;
    this.consumeDragSource(drag);
    this.effects.push({ type: 'levelUp', side: SIDES.SELF, cell, life: 0.5 });
    this.audio.play('place');
  }

  // 把候选栏物品或棋盘单位放到指定建造格。
  placeUnit(drag, cell) {
    const tile = this.getTile(SIDES.SELF, cell);
    if (!tile || tile.type !== TILE.BUILD) {
      this.toastMessage('只能放在白色格');
      this.audio.play('error');
      return;
    }
    if (this.findUnitAt(SIDES.SELF, cell)) {
      this.toastMessage('格子已占用');
      this.audio.play('error');
      return;
    }

    const unit = drag.source === 'board' ? drag.item : createUnitFromItem(drag.item, SIDES.SELF);
    unit.cell = { x: cell.x, y: cell.y };
    unit.side = SIDES.SELF;

    if (drag.source === 'bench') {
      this.players[SIDES.SELF].bench[drag.benchIndex] = null;
      this.boards[SIDES.SELF].units.push(unit);
    }

    this.audio.play('place');
  }

  // 尝试合成：同兵种同等级基础单位升星；特殊字组合生成武将。
  tryMergeUnits(drag, targetUnit) {
    const sourceItem = drag.source === 'board' ? drag.item : createUnitFromItem(drag.item, SIDES.SELF);

    if (canMergeBasic(sourceItem, targetUnit)) {
      targetUnit.level += 1;
      this.removeDraggedOriginal(drag);
      this.effects.push({ type: 'levelUp', side: SIDES.SELF, cell: targetUnit.cell, life: 0.8 });
      this.audio.play('merge');
      return true;
    }

    const heroName = getHeroNameFromChars(sourceItem, targetUnit);
    if (heroName) {
      const hero = createHeroUnit(heroName, SIDES.SELF, targetUnit.cell);
      this.removeDraggedOriginal(drag);
      this.boards[SIDES.SELF].units = this.boards[SIDES.SELF].units.filter((unit) => unit !== targetUnit);
      this.boards[SIDES.SELF].units.push(hero);
      this.effects.push({ type: 'heroSkill', side: SIDES.SELF, text: heroName, life: 0.8 });
      this.audio.play('merge');
      return true;
    }

    return false;
  }

  // 不能合成时执行换位：棋盘拖棋盘交换格子；候选栏拖棋盘则和原候选栏位置互换。
  trySwapUnits(drag, targetUnit) {
    if (drag.item.kind === ITEM_KIND.SHOVEL) return false;

    if (drag.source === 'board') {
      const fromCell = drag.fromCell || drag.item.cell;
      drag.item.cell = { x: targetUnit.cell.x, y: targetUnit.cell.y };
      targetUnit.cell = { x: fromCell.x, y: fromCell.y };
      this.audio.play('place');
      return true;
    }

    if (drag.source === 'bench') {
      const board = this.boards[SIDES.SELF];
      const player = this.players[SIDES.SELF];
      const placedUnit = createUnitFromItem(drag.item, SIDES.SELF);

      placedUnit.cell = { x: targetUnit.cell.x, y: targetUnit.cell.y };
      placedUnit.side = SIDES.SELF;
      targetUnit.cell = null;

      board.units = board.units.filter((unit) => unit !== targetUnit);
      board.units.push(placedUnit);
      player.bench[drag.benchIndex] = targetUnit;
      this.audio.play('place');
      return true;
    }

    return false;
  }

  // 合成成功后清理被拖拽的原物体，避免棋盘或候选栏残留重复对象。
  removeDraggedOriginal(drag) {
    if (drag.source === 'bench') {
      this.players[SIDES.SELF].bench[drag.benchIndex] = null;
      return;
    }

    this.boards[SIDES.SELF].units = this.boards[SIDES.SELF].units.filter((unit) => unit !== drag.item);
  }

  // 消耗候选栏来源的拖拽物，主要给铲子这类一次性道具使用。
  consumeDragSource(drag) {
    if (drag.source === 'bench') this.players[SIDES.SELF].bench[drag.benchIndex] = null;
  }

  // 暂停/继续逻辑。当前版本本地模拟双方同意暂停。
  requestPause() {
    if (this.status === GAME_STATUS.PLAYING) {
      this.status = GAME_STATUS.PAUSE_PENDING;
      this.toastMessage('已请求暂停，本地模拟自动同意');
      setTimeout(() => {
        if (this.status === GAME_STATUS.PAUSE_PENDING) this.status = GAME_STATUS.PAUSED;
      }, 600);
      return;
    }

    if (this.status === GAME_STATUS.PAUSED) {
      this.status = GAME_STATUS.PLAYING;
      this.toastMessage('继续游戏');
    }
  }

  // 显示短文本提示，超过时间后 update 会自动清理。
  toastMessage(text) {
    this.toast = { text, until: now() + 1800 };
  }

  // 根据触摸点判断点中了候选栏第几个格子，没点中返回 -1。
  getBenchIndexAt(point) {
    const y = this.layout.benchY;
    const cell = this.layout.benchCell;
    const startX = this.layout.boardX + 8;
    for (let i = 0; i < PLAYER_DEFAULTS.benchSize; i += 1) {
      const rect = { x: startX + i * cell, y, w: cell - 5, h: cell - 5 };
      if (pointInRect(point, rect)) return i;
    }
    return -1;
  }

  // 读取某一方棋盘上的格子数据。
  getTile(side, cell) {
    return this.boards[side].tiles.get(cellKey({ x: Math.floor(cell.x), y: Math.floor(cell.y) }));
  }

  // 查找某一方指定格子上的单位。
  findUnitAt(side, cell) {
    return this.boards[side].units.find((unit) => unit.cell && sameCell(unit.cell, {
      x: Math.floor(cell.x),
      y: Math.floor(cell.y)
    }));
  }

  // 棋盘坐标转屏幕像素坐标。side/small 决定使用哪一块棋盘布局。
  cellToPixel(cell, side, small) {
    const l = this.layout;
    const size = small ? l.rivalCell : l.cell;
    const x0 = small ? l.rivalBoardX : l.boardX;
    const y0 = small ? l.rivalBoardY : l.selfBoardY;
    const mirrored = side === SIDES.RIVAL;
    const x = mirrored ? BOARD.cols - 1 - cell.x : cell.x;
    const y = mirrored ? BOARD.rows - 1 - cell.y : cell.y;
    return { x: x0 + x * size, y: y0 + y * size };
  }

  // 屏幕像素坐标转棋盘格子坐标，用于触摸落点判断。
  pixelToCell(point, side, small) {
    const l = this.layout;
    const size = small ? l.rivalCell : l.cell;
    const x0 = small ? l.rivalBoardX : l.boardX;
    const y0 = small ? l.rivalBoardY : l.selfBoardY;
    const col = Math.floor((point.x - x0) / size);
    const row = Math.floor((point.y - y0) / size);
    if (col < 0 || col >= BOARD.cols || row < 0 || row >= BOARD.rows) return null;

    if (side === SIDES.RIVAL) {
      return { x: BOARD.cols - 1 - col, y: BOARD.rows - 1 - row };
    }
    return { x: col, y: row };
  }
}

// 创建玩家状态。这里保存血量、金币、征兵次数和候选栏内容。
function createPlayerState(side) {
  return {
    side,
    hp: PLAYER_DEFAULTS.hp,
    gold: PLAYER_DEFAULTS.gold,
    recruitCount: 0,
    bench: new Array(PLAYER_DEFAULTS.benchSize).fill(null)
  };
}

// 创建某一方的棋盘状态，包含格子、单位、敌人、波次计时和大将干扰状态。
function createBoardState(side) {
  const tiles = new Map();
  for (let y = 0; y < BOARD.rows; y += 1) {
    for (let x = 0; x < BOARD.cols; x += 1) {
      tiles.set(cellKey({ x, y }), { x, y, type: TILE.GRASS });
    }
  }

  BOARD.path.forEach((cell) => {
    tiles.get(cellKey(cell)).type = TILE.PATH;
  });
  BOARD.initialBuildCells.forEach((cell) => {
    tiles.get(cellKey(cell)).type = TILE.BUILD;
  });
  tiles.get(cellKey(BOARD.baseCell)).type = TILE.BASE;

  return {
    side,
    tiles,
    units: [],
    enemies: [],
    wave: 0,
    waveActive: false,
    waveClock: 3,
    waveConfig: createWaveConfig(1),
    spawnedInWave: 0,
    spawnClock: 0,
    generalSpawned: false,
    debuff: {}
  };
}

// 根据波次数生成敌人数量、血量、速度、护甲和是否出现大将。
function createWaveConfig(wave) {
  const general = wave > 0 && wave % 6 === 0 ? GENERALS[(wave / 6 - 1) % GENERALS.length] : null;
  return {
    wave,
    enemyCount: 8 + Math.floor(wave * 1.5),
    enemyHp: 4 + wave * 4,
    enemyArmor: Math.floor(wave / 3),
    enemySpeed: 1,
    spawnInterval: Math.max(0.35, 0.9 - wave * 0.015),
    prepareSeconds: 3,
    general
  };
}

// 复制候选栏物品，避免直接复用云函数或随机池返回的原对象。
function createBenchItem(item) {
  return Object.assign({ id: makeId('bench') }, item);
}

// 把候选栏里的基础单位或特殊字转成棋盘上的单位对象。
function createUnitFromItem(item, side) {
  if (item.kind === ITEM_KIND.BASIC) {
    const cfg = BASIC_UNITS[item.unitId];
    return {
      id: item.id || makeId('unit'),
      side,
      kind: ITEM_KIND.BASIC,
      unitId: item.unitId,
      text: cfg.text,
      level: item.level || 1,
      attackType: cfg.attackType,
      attackCooldown: 0,
      skillCooldown: 0,
      cell: null
    };
  }

  if (item.kind === ITEM_KIND.SPECIAL_CHAR) {
    return {
      id: item.id || makeId('char'),
      side,
      kind: ITEM_KIND.SPECIAL_CHAR,
      char: item.char,
      text: item.char,
      level: 1,
      attackCooldown: 0,
      skillCooldown: 0,
      cell: null
    };
  }

  return item;
}

// 创建武将单位。武将属性来自 HERO_CONFIGS，等级和经验从 1 级 0 经验开始。
function createHeroUnit(heroName, side, cell) {
  const cfg = HERO_CONFIGS[heroName];
  return {
    id: makeId('hero'),
    side,
    kind: ITEM_KIND.HERO,
    heroName,
    text: cfg.text,
    level: 1,
    exp: 0,
    attackType: cfg.baseType === 'cavalry' ? 'area' : cfg.baseType === 'spear' ? 'pierce' : 'single',
    attackCooldown: 0,
    skillCooldown: 0,
    cell: { x: cell.x, y: cell.y }
  };
}

// 计算单位当前真实属性。基础单位读 levels，武将读基础配置和成长倍率。
function getUnitStats(unit) {
  if (unit.kind === ITEM_KIND.HERO) {
    const cfg = HERO_CONFIGS[unit.heroName];
    const growth = HERO_GROWTH[unit.level - 1];
    return {
      attack: cfg.attack * growth.attackRate,
      attackSpeed: cfg.attackSpeed * growth.speedRate,
      range: cfg.range
    };
  }

  if (unit.kind === ITEM_KIND.BASIC) {
    const cfg = BASIC_UNITS[unit.unitId];
    const level = clamp(unit.level || 1, 1, 5);
    const stats = cfg.levels[level - 1];
    return {
      attack: stats.attack,
      attackSpeed: stats.attackSpeed,
      range: cfg.range
    };
  }

  return { attack: 0, attackSpeed: 1, range: 0 };
}

// 根据玩家已征兵次数计算本次征兵价格。
function getRecruitCost(player) {
  return PLAYER_DEFAULTS.recruitBaseCost + player.recruitCount * PLAYER_DEFAULTS.recruitCostStep;
}

// 绘制候选栏、棋盘和拖拽预览里的物品内容。
// 铲子用图标，特殊字用金色文字，普通单位和武将继续使用原文字。
function drawItemContent(ctx, item, x, y, size) {
  if (item.kind === ITEM_KIND.SHOVEL) {
    drawShovelIcon(ctx, x, y, size);
    return;
  }

  const text = getItemText(item);
  const isSpecialChar = item.kind === ITEM_KIND.SPECIAL_CHAR;
  drawCenteredText(ctx, text, x, y, {
    font: `bold ${Math.floor(size * (text.length > 1 ? 0.38 : 0.56))}px serif`,
    color: isSpecialChar ? '#d8a73a' : COLORS.ink,
    stroke: '',
    strokeWidth: 0
  });
}

// 纯 Canvas 铲子图标，避免用“铲”字和特殊合成字混淆。
function drawShovelIcon(ctx, x, y, size) {
  const scale = size / 68;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.translate(x, y);
  ctx.rotate(Math.PI / 5);

  ctx.strokeStyle = '#6b4226';
  ctx.lineWidth = 6 * scale;
  ctx.beginPath();
  ctx.moveTo(-2 * scale, -17 * scale);
  ctx.lineTo(5 * scale, 12 * scale);
  ctx.stroke();

  ctx.strokeStyle = '#3f2618';
  ctx.lineWidth = 5 * scale;
  ctx.beginPath();
  ctx.moveTo(-11 * scale, -21 * scale);
  ctx.quadraticCurveTo(-2 * scale, -28 * scale, 8 * scale, -21 * scale);
  ctx.moveTo(-11 * scale, -21 * scale);
  ctx.lineTo(8 * scale, -21 * scale);
  ctx.stroke();

  ctx.fillStyle = '#cfd6d1';
  ctx.strokeStyle = '#5d6764';
  ctx.lineWidth = 2 * scale;
  ctx.beginPath();
  ctx.moveTo(-7 * scale, 10 * scale);
  ctx.quadraticCurveTo(6 * scale, 8 * scale, 15 * scale, 16 * scale);
  ctx.quadraticCurveTo(12 * scale, 28 * scale, 2 * scale, 29 * scale);
  ctx.quadraticCurveTo(-8 * scale, 22 * scale, -7 * scale, 10 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 1.5 * scale;
  ctx.beginPath();
  ctx.moveTo(0, 13 * scale);
  ctx.quadraticCurveTo(7 * scale, 16 * scale, 8 * scale, 23 * scale);
  ctx.stroke();
  ctx.restore();
}

// 获取候选栏或棋盘单位展示用的文字。
function getItemText(item) {
  if (!item) return '';
  if (item.kind === ITEM_KIND.SHOVEL) return '铲';
  if (item.kind === ITEM_KIND.SPECIAL_CHAR) return item.char;
  if (item.kind === ITEM_KIND.HERO) return item.heroName;
  if (item.kind === ITEM_KIND.BASIC) return BASIC_UNITS[item.unitId].text;
  return item.text || '';
}

// 获取信息面板展示用的完整名称。
function getUnitDisplayName(unit) {
  if (unit.kind === ITEM_KIND.HERO) return unit.heroName;
  if (unit.kind === ITEM_KIND.SPECIAL_CHAR) return `${unit.char}`;
  if (unit.kind === ITEM_KIND.BASIC) return BASIC_UNITS[unit.unitId].text;
  return getItemText(unit);
}

// 获取信息面板第二行末尾的定位说明。
function getUnitRoleLabel(unit) {
  if (unit.kind === ITEM_KIND.BASIC) return BASIC_UNITS[unit.unitId].role || getAttackTypeLabel(unit.attackType);
  if (unit.kind === ITEM_KIND.HERO) return getAttackTypeLabel(unit.attackType);
  return '合成字';
}

// 把攻击类型转成玩家能看懂的中文。
function getAttackTypeLabel(type) {
  if (type === 'single') return '单体';
  if (type === 'area') return '范围';
  if (type === 'pierce') return '穿透';
  return '无攻击';
}

// 属性数值保留一位小数，整数不显示小数点。
function formatStat(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

// 判断两个基础单位是否可以合成：同类型、同等级、未满 5 级。
function canMergeBasic(source, target) {
  return source.kind === ITEM_KIND.BASIC
    && target.kind === ITEM_KIND.BASIC
    && source.unitId === target.unitId
    && source.level === target.level
    && target.level < 5;
}

// 根据两个特殊字查找是否能组成一个武将。
function getHeroNameFromChars(source, target) {
  if (source.kind !== ITEM_KIND.SPECIAL_CHAR || target.kind !== ITEM_KIND.SPECIAL_CHAR) return '';
  const chars = [source.char, target.char].sort().join('');
  const names = Object.keys(HERO_PAIRS);
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    if (HERO_PAIRS[name].slice().sort().join('') === chars) return name;
  }
  return '';
}

// 从微信触摸事件里取第一个触点，并统一成 { x, y }。
function getTouchPoint(event) {
  const touch = event.changedTouches && event.changedTouches[0]
    ? event.changedTouches[0]
    : event.touches && event.touches[0];
  if (!touch) return null;
  return { x: touch.clientX, y: touch.clientY };
}

module.exports = { Game };
