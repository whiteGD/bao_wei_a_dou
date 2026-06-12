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
  SeededRandom,
  hashString,
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
    this.roomInputModal = null;
    this.buttons = {};
    this.layout = {};
    this.systemInfo = null;

    this.room = null;
    this.selfSide = 'A';
    this.launchRoomId = '';
    this.savedRoomId = '';
    this.roomWatcher = null;
    this.logWatcher = null;
    this.processedLogIds = {};
    this.settlingAt = 0;
    this.settlingFailedSide = null;
    this.settlingReason = '';
    this.nextResultPollAt = 0;
    this.resultPolling = false;
    this.recruiting = false;
    this.battleClockSynced = false;
    this.nextStateSyncAt = 0;
    this.stateSyncing = false;
    this.lastRemoteStateAt = 0;

    this.players = {};
    this.boards = {};
    this.effects = [];

    this.handleTouchStart = this.handleTouchStart.bind(this);
    this.handleTouchMove = this.handleTouchMove.bind(this);
    this.handleTouchEnd = this.handleTouchEnd.bind(this);
    this.handleKeyboardInput = this.handleKeyboardInput.bind(this);
    this.handleKeyboardConfirm = this.handleKeyboardConfirm.bind(this);
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
    if (typeof wx === 'undefined') return;
    if (wx.getLaunchOptionsSync) {
      const options = wx.getLaunchOptionsSync();
      this.launchRoomId = options && options.query && options.query.roomId ? options.query.roomId : '';
    }

    // 阶段三：记录本机最近一次云房间号，用户断线或重启小游戏后可从首页继续上局。
    if (wx.getStorageSync) {
      try {
        this.savedRoomId = normalizeRoomId(wx.getStorageSync('lastRoomId'));
      } catch (err) {
        this.savedRoomId = '';
      }
    }
  }

  // 统一绑定微信触摸事件，后续所有点击、拖拽都从这三个入口分发。
  bindEvents() {
    wx.onTouchStart(this.handleTouchStart);
    wx.onTouchMove(this.handleTouchMove);
    wx.onTouchEnd(this.handleTouchEnd);
    if (wx.onKeyboardConfirm) {
      wx.onKeyboardConfirm(this.handleKeyboardConfirm);
    }
    if (wx.onKeyboardInput) {
      wx.onKeyboardInput(this.handleKeyboardInput);
    }
  }

  // 切回首页状态，同时清空首页之外的弹窗和按钮缓存。
  showHome() {
    this.status = GAME_STATUS.HOME;
    this.buttons = {};
    this.modal = null;
    this.roomInputModal = null;
    if (typeof wx !== 'undefined' && wx.hideKeyboard) wx.hideKeyboard();
    this.closeRealtimeWatchers();
  }

  // 保存当前云房间号。只保存 roomId，不保存棋盘本体，恢复时仍以云端最新快照为准。
  rememberActiveRoom(roomId) {
    const normalized = normalizeRoomId(roomId);
    if (!normalized || !this.cloud.enabled) return;
    this.savedRoomId = normalized;
    if (typeof wx !== 'undefined' && wx.setStorageSync) {
      try {
        wx.setStorageSync('lastRoomId', normalized);
      } catch (err) {
        console.warn('save room id failed', err);
      }
    }
  }

  // 对局已经结算后清理继续入口，避免用户下次误回到一个已结束房间。
  clearActiveRoomMemory() {
    this.savedRoomId = '';
    if (typeof wx !== 'undefined' && wx.removeStorageSync) {
      try {
        wx.removeStorageSync('lastRoomId');
      } catch (err) {
        console.warn('clear room id failed', err);
      }
    }
  }

  // 创建房间。云模式下先进入等待页，等第二名玩家加入后再开始；本地模拟则直接开始。
  async createRoomAndStart() {
    try {
      const room = await this.cloud.createRoom();
      this.room = room;
      this.selfSide = room.side || 'A';
      this.rememberActiveRoom(room.roomId);
      this.resetLocalGame(room.seed || String(Date.now()));

      if (this.cloud.enabled && room.status === 'waiting') {
        this.status = GAME_STATUS.ROOM;
        this.toastMessage('房间已创建，可复制房间号或分享邀请');
        this.startRoomWatcher();
        return true;
      }

      this.enterPlayingRoom();
      this.toastMessage('已创建房间，本地先进入对局');
      return true;
    } catch (err) {
      this.toastMessage(err.message || '创建房间失败');
      this.audio.play('error');
      return false;
    }
  }

  // 加入房间。roomId 可以来自分享参数，也可以来自用户手动输入的房间号。
  async joinRoomAndStart(roomId, isResume) {
    const targetRoomId = normalizeRoomId(roomId || this.launchRoomId);
    if (this.cloud.enabled && !targetRoomId) {
      this.toastMessage('请输入房间号或通过分享加入');
      this.audio.play('error');
      return;
    }

    try {
      const room = await this.cloud.joinRoom(targetRoomId);
      this.room = room;
      this.selfSide = room.side || 'B';
      this.rememberActiveRoom(room.roomId);
      this.resetLocalGame(room.seed || String(Date.now()));

      if (room.status === 'waiting') {
        this.status = GAME_STATUS.ROOM;
        this.startRoomWatcher();
        this.toastMessage(isResume ? '已回到等待房间' : '已加入等待房间');
        return;
      }

      if (room.status === 'finished') {
        this.applyRemoteFinish(room.result || {});
        return;
      }

      this.restoreRoomSnapshots(room);
      this.enterPlayingRoom();
      this.toastMessage(isResume ? '已恢复上局' : '已加入房间');
    } catch (err) {
      this.toastMessage(err.message || '加入房间失败');
      this.audio.play('error');
    }
  }

  // 从本机保存的 lastRoomId 重连。真正的身份校验仍在 joinRoom 云函数里按 openid 完成。
  resumeLastRoom() {
    const roomId = normalizeRoomId(this.savedRoomId);
    if (!roomId) {
      this.toastMessage('暂无可继续的房间');
      return;
    }
    this.joinRoomAndStart(roomId, true);
  }

  // 打开自绘房间号弹窗，同时调起系统键盘只负责输入，不依赖系统输入框展示。
  showRoomIdKeyboard() {
    if (!this.cloud.enabled) {
      this.toastMessage('当前是本地模式，无法通过房间号加入');
      return;
    }

    if (!wx.showKeyboard) {
      this.toastMessage('当前基础库不支持键盘输入');
      return;
    }

    this.roomInputModal = { value: '' };
    this.buttons.roomInputCancel = null;
    this.buttons.roomInputConfirm = null;
    wx.showKeyboard({
      defaultValue: '',
      maxLength: 24,
      multiple: false,
      confirmHold: false,
      confirmType: 'done'
    });
  }

  // 系统键盘只负责采集输入，房间号展示由 Canvas 弹窗绘制，避免原生输入框样式突兀。
  handleKeyboardInput(event) {
    if (!this.roomInputModal) return;
    this.roomInputModal.value = normalizeRoomId(event && event.value).slice(0, 24);
  }

  // 键盘确认事件是全局事件，因此只在房间号弹窗打开时把输入当作房间号处理。
  handleKeyboardConfirm(event) {
    if (!this.roomInputModal) return;
    const roomId = normalizeRoomId((event && event.value) || this.roomInputModal.value);
    this.confirmRoomIdInput(roomId);
  }

  confirmRoomIdInput(roomId) {
    const normalized = normalizeRoomId(roomId);
    if (!this.roomInputModal) return;
    if (!normalized) {
      this.toastMessage('房间号不能为空');
      this.audio.play('error');
      return;
    }
    this.closeRoomIdInput();
    this.joinRoomAndStart(normalized);
  }

  closeRoomIdInput() {
    this.roomInputModal = null;
    if (typeof wx !== 'undefined' && wx.hideKeyboard) wx.hideKeyboard();
  }

  // 进入正式对局，并开启操作日志监听。两个客户端都只监听对方操作。
  enterPlayingRoom() {
    this.status = GAME_STATUS.PLAYING;
    this.processedLogIds = {};
    this.syncBattleStartClock();
    this.startRoomWatcher();
    this.startLogWatcher();
  }

  // 主动触发微信分享面板，把当前 roomId 带给好友。
  shareRoom() {
    if (!this.room || !this.room.roomId || typeof wx === 'undefined' || !wx.shareAppMessage) return;
    wx.shareAppMessage({
      title: '来和我一起保卫阿斗',
      query: `roomId=${this.room.roomId}`
    });
  }

  // 复制房间号给用户，方便通过聊天工具手动发给好友。
  copyRoomId() {
    if (!this.room || !this.room.roomId) {
      this.toastMessage('暂无房间号');
      return;
    }

    if (!wx.setClipboardData) {
      this.toastMessage('当前基础库不支持复制');
      return;
    }

    wx.setClipboardData({
      data: this.room.roomId,
      success: () => {
        this.toastMessage('房间号已复制');
        this.audio.play('place');
      },
      fail: () => {
        this.toastMessage('复制失败，请手动记录房间号');
        this.audio.play('error');
      }
    });
  }

  // 监听房间状态：创建者等到 status=playing 后自动开局；任意端收到 finished 后结束。
  startRoomWatcher() {
    if (!this.room || !this.room.roomId || !this.cloud.enabled) return;
    this.cloud.closeWatcher(this.roomWatcher);
    this.roomWatcher = this.cloud.watchRoom(this.room.roomId, (room) => {
      this.room = Object.assign({}, this.room, room);
      this.applyRemoteStateFromRoom(room);
      if (this.status === GAME_STATUS.ROOM && room.status === 'playing') {
        this.enterPlayingRoom();
        this.toastMessage('好友已加入，开始对局');
      }
      if (room.status === 'finished' && this.status !== GAME_STATUS.FINISHED) {
        this.applyRemoteFinish(room.result || {});
      }
    }, () => {
      this.toastMessage('房间监听失败，请检查数据库权限');
    });
  }

  // 监听操作日志，并把对方操作回放到本地 RIVAL 区域。
  startLogWatcher() {
    if (!this.room || !this.room.roomId || !this.cloud.enabled) return;
    this.cloud.closeWatcher(this.logWatcher);
    this.logWatcher = this.cloud.watchRoomLogs(this.room.roomId, (logs) => {
      logs
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .forEach((log) => this.applyRemoteLog(log));
    }, () => {
      this.toastMessage('操作同步失败，请检查 roomLogs 权限');
    });
  }

  closeRealtimeWatchers() {
    this.cloud.closeWatcher(this.roomWatcher);
    this.cloud.closeWatcher(this.logWatcher);
    this.roomWatcher = null;
    this.logWatcher = null;
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
    this.settlingAt = 0;
    this.settlingFailedSide = null;
    this.settlingReason = '';
    this.nextResultPollAt = 0;
    this.resultPolling = false;
    this.recruiting = false;
    this.battleClockSynced = false;
    this.nextStateSyncAt = 0;
    this.stateSyncing = false;
    this.lastRemoteStateAt = 0;
  }

  // 结算弹窗的再开入口。联机对局必须重新创建云房间，不能退化成单机练习。
  async restartFinishedGame() {
    const restartOnline = this.isOnlineRoom();
    this.closeRealtimeWatchers();
    this.modal = null;

    if (restartOnline) {
      this.room = null;
      const started = await this.createRoomAndStart();
      if (!started) {
        this.status = GAME_STATUS.FINISHED;
        this.modal = {
          title: '创建失败',
          message: '联机房间创建失败，请检查网络后重试'
        };
      }
      return;
    }

    this.room = null;
    this.resetLocalGame();
    this.status = GAME_STATUS.PLAYING;
  }

  // 记录玩家低频操作。联网时写入 roomLogs，单机练习时直接忽略。
  emitAction(type, payload) {
    if (!this.room || !this.room.roomId || !this.cloud.enabled) return;
    this.cloud.logAction({
      roomId: this.room.roomId,
      playerSide: this.selfSide,
      type,
      payload: payload || {}
    }).catch((err) => {
      console.warn('log action failed', err);
      this.toastMessage('同步失败，请检查网络');
    });
  }

  // 回放对手操作。注意：本机永远操作 SELF 区域，对手操作永远映射到 RIVAL 区域。
  applyRemoteLog(log) {
    const logId = log._id || `${log.type}_${log.createdAt}_${log.playerSide}`;
    if (this.processedLogIds[logId]) return;
    this.processedLogIds[logId] = true;
    if (log.playerSide === this.selfSide) return;

    const payload = log.payload || {};
    if (log.type === 'RECRUIT') this.applyRemoteRecruit(payload);
    if (log.type === 'PLACE') this.applyRemotePlace(payload);
    if (log.type === 'MOVE_TO_BENCH') this.applyRemoteMoveToBench(payload);
    if (log.type === 'MERGE') this.applyRemoteMerge(payload);
    if (log.type === 'SWAP') this.applyRemoteSwap(payload);
    if (log.type === 'SHOVEL') this.applyRemoteShovel(payload);
    if (log.type === 'PAUSE_REQUEST') this.applyRemotePauseRequest();
    if (log.type === 'PAUSE_ACCEPT') this.status = GAME_STATUS.PAUSED;
    if (log.type === 'PAUSE_RESUME') this.status = GAME_STATUS.PLAYING;
    if (log.type === 'FINISH') this.applyRemoteFinish(payload);
  }

  applyRemoteRecruit(payload) {
    const player = this.players[SIDES.RIVAL];
    const cost = getRecruitCost(player);
    player.gold = Math.max(0, player.gold - cost);
    player.recruitCount += 1;
    player.bench = (payload.items || []).map((item) => createBenchItem(item));
    this.audio.play('recruit');
  }

  applyRemotePlace(payload) {
    const side = SIDES.RIVAL;
    const unit = this.takeRemoteSourceUnit(payload.source, payload.benchIndex, payload.fromCell, side);
    if (!unit) return;
    unit.side = side;
    unit.cell = cloneCell(payload.cell);
    this.boards[side].units.push(unit);
  }

  applyRemoteMoveToBench(payload) {
    const side = SIDES.RIVAL;
    const player = this.players[side];
    const unit = this.findUnitAt(side, payload.fromCell);
    if (!unit || player.bench[payload.benchIndex]) return;
    this.boards[side].units = this.boards[side].units.filter((item) => item !== unit);
    unit.cell = null;
    player.bench[payload.benchIndex] = unit;
  }

  applyRemoteShovel(payload) {
    const side = SIDES.RIVAL;
    const tile = this.getTile(side, payload.cell);
    if (tile) tile.type = TILE.BUILD;
    if (payload.source === 'bench') this.players[side].bench[payload.benchIndex] = null;
  }

  applyRemoteMerge(payload) {
    const side = SIDES.RIVAL;
    if (typeof payload.targetBenchIndex === 'number') {
      this.applyRemoteBenchMerge(payload, side);
      return;
    }

    const targetUnit = this.findUnitAt(side, payload.targetCell);
    const sourceUnit = this.takeRemoteSourceUnit(payload.source, payload.benchIndex, payload.fromCell, side, true);
    if (!targetUnit || !sourceUnit) return;

    if (canMergeBasic(sourceUnit, targetUnit)) {
      targetUnit.level += 1;
      this.removeRemoteSourceUnit(sourceUnit, payload.source, payload.benchIndex, side);
      this.effects.push({ type: 'levelUp', side, cell: cloneCell(targetUnit.cell), life: 0.8 });
      return;
    }

    const heroName = getHeroNameFromChars(sourceUnit, targetUnit);
    if (heroName) {
      this.removeRemoteSourceUnit(sourceUnit, payload.source, payload.benchIndex, side);
      this.boards[side].units = this.boards[side].units.filter((unit) => unit !== targetUnit);
      this.boards[side].units.push(createHeroUnit(heroName, side, targetUnit.cell));
      this.effects.push({ type: 'heroSkill', side, text: heroName, life: 0.8 });
    }
  }

  applyRemoteBenchMerge(payload, side) {
    const player = this.players[side];
    const targetItem = player.bench[payload.targetBenchIndex];
    const sourceItem = this.takeRemoteSourceUnit(payload.source, payload.benchIndex, payload.fromCell, side, true);
    if (!targetItem || !sourceItem || targetItem === sourceItem) return;

    if (canMergeBasic(sourceItem, targetItem)) {
      targetItem.level += 1;
      this.removeRemoteSourceUnit(sourceItem, payload.source, payload.benchIndex, side);
      this.audio.play('merge');
      return;
    }

    const heroName = getHeroNameFromChars(sourceItem, targetItem);
    if (heroName) {
      this.removeRemoteSourceUnit(sourceItem, payload.source, payload.benchIndex, side);
      player.bench[payload.targetBenchIndex] = createHeroUnit(heroName, side, null);
      this.effects.push({ type: 'heroSkill', side, text: heroName, life: 0.8 });
      this.audio.play('merge');
    }
  }

  applyRemoteSwap(payload) {
    const side = SIDES.RIVAL;
    if (typeof payload.targetBenchIndex === 'number') {
      const player = this.players[side];
      const sourceItem = player.bench[payload.benchIndex];
      if (!sourceItem) return;
      player.bench[payload.benchIndex] = player.bench[payload.targetBenchIndex] || null;
      player.bench[payload.targetBenchIndex] = sourceItem;
      return;
    }

    const targetUnit = this.findUnitAt(side, payload.targetCell);
    if (!targetUnit) return;

    if (payload.source === 'board') {
      const sourceUnit = this.findUnitAt(side, payload.fromCell);
      if (!sourceUnit) return;
      sourceUnit.cell = cloneCell(payload.targetCell);
      targetUnit.cell = cloneCell(payload.fromCell);
      return;
    }

    if (payload.source === 'bench') {
      const item = this.players[side].bench[payload.benchIndex];
      if (!item) return;
      const placedUnit = createUnitFromItem(item, side);
      placedUnit.cell = cloneCell(payload.targetCell);
      this.players[side].bench[payload.benchIndex] = targetUnit;
      targetUnit.cell = null;
      this.boards[side].units = this.boards[side].units.filter((unit) => unit !== targetUnit);
      this.boards[side].units.push(placedUnit);
    }
  }

  takeRemoteSourceUnit(source, benchIndex, fromCell, side, keepOriginal) {
    if (source === 'bench') {
      const item = this.players[side].bench[benchIndex];
      if (!item) return null;
      if (!keepOriginal) this.players[side].bench[benchIndex] = null;
      return item.kind === ITEM_KIND.BASIC || item.kind === ITEM_KIND.SPECIAL_CHAR
        ? createUnitFromItem(item, side)
        : item;
    }

    const unit = this.findUnitAt(side, fromCell);
    if (!unit) return null;
    if (!keepOriginal) {
      this.boards[side].units = this.boards[side].units.filter((item) => item !== unit);
    }
    return unit;
  }

  removeRemoteSourceUnit(sourceUnit, source, benchIndex, side) {
    if (source === 'bench') {
      this.players[side].bench[benchIndex] = null;
      return;
    }
    this.boards[side].units = this.boards[side].units.filter((unit) => unit !== sourceUnit);
  }

  applyRemotePauseRequest() {
    if (this.status !== GAME_STATUS.PLAYING) return;
    this.status = GAME_STATUS.PAUSED;
    this.toastMessage('对方请求暂停，已自动同意');
    this.emitAction('PAUSE_ACCEPT', {});
  }

  applyRemoteFinish(payload) {
    if (this.status === GAME_STATUS.FINISHED) return;
    this.status = GAME_STATUS.FINISHED;
    this.settlingAt = 0;
    this.settlingFailedSide = null;
    this.settlingReason = '';
    this.nextResultPollAt = 0;
    this.resultPolling = false;
    if (this.isOnlineRoom()) this.clearActiveRoomMemory();
    this.audio.play('finish');
    const failedSide = payload.failedSide;
    if (!failedSide) {
      this.modal = {
        title: '对局已结束',
        message: '该房间已结算或不可继续'
      };
      return;
    }
    const selfFailed = failedSide === this.selfSide;
    this.modal = {
      title: selfFailed ? '战败' : '获胜',
      message: selfFailed ? '你的大本营已失守' : '对方大本营已失守'
    };
  }

  // 使用云端写入的 battleStartAt 统一双方第一波开始时间。
  // 这样房主和加入者不会因为进入 PLAYING 的本地时间不同而提前/延后开怪。
  syncBattleStartClock() {
    if (this.battleClockSynced) return;
    const startAt = this.room && this.room.battleStartAt ? Number(this.room.battleStartAt) : 0;
    if (!startAt) return;

    const seconds = Math.max(0, (startAt - now()) / 1000);
    [SIDES.SELF, SIDES.RIVAL].forEach((side) => {
      const board = this.boards[side];
      if (board.wave === 0 && !board.waveActive) {
        board.waveClock = seconds;
      }
    });
    this.battleClockSynced = true;
  }

  // 根据房间种子、阵营和事件名生成稳定随机数，替代战斗中的 Math.random()。
  deterministicRandom(side, eventKey) {
    const roomSide = this.toRoomSide(side);
    const seed = `${this.seed}_${roomSide}_${eventKey}`;
    return new SeededRandom(seed).next();
  }

  deterministicPick(side, eventKey, list) {
    if (!list.length) return null;
    const index = Math.floor(this.deterministicRandom(side, eventKey) * list.length);
    return list[Math.min(index, list.length - 1)];
  }

  // 每 5 秒上传一次自己的轻量状态快照。快照只保存最新状态，不做历史流水，控制免费版流量。
  maybeSyncOwnState() {
    if (!this.isOnlineRoom()) return;
    if (this.status !== GAME_STATUS.PLAYING && this.status !== GAME_STATUS.SETTLING) return;
    if (this.stateSyncing || now() < this.nextStateSyncAt) return;

    this.stateSyncing = true;
    this.nextStateSyncAt = now() + 5000;
    this.cloud.updateState({
      roomId: this.room.roomId,
      snapshot: this.createStateSnapshot(SIDES.SELF)
    }).catch((err) => {
      console.warn('update state failed', err);
    }).finally(() => {
      this.stateSyncing = false;
    });
  }

  createStateSnapshot(side) {
    const player = this.players[side];
    const board = this.boards[side];
    const tiles = [];
    board.tiles.forEach((tile) => {
      if (tile.type !== TILE.PATH && tile.type !== TILE.BASE) {
        tiles.push({ x: tile.x, y: tile.y, type: tile.type });
      }
    });

    const snapshot = {
      wave: board.wave,
      hp: player.hp,
      gold: player.gold,
      recruitCount: player.recruitCount,
      waveActive: board.waveActive,
      waveClock: Number(board.waveClock.toFixed(2)),
      spawnedInWave: board.spawnedInWave,
      spawnClock: Number((board.spawnClock || 0).toFixed(2)),
      generalSpawned: !!board.generalSpawned,
      units: board.units.map((unit) => serializeUnit(unit)),
      bench: player.bench.map((item) => (item ? serializeBenchItem(item) : null)),
      tiles,
      enemies: board.enemies.slice(0, 40).map((enemy) => ({
        id: enemy.id,
        isGeneral: !!enemy.isGeneral,
        name: enemy.name || '',
        hp: Number(enemy.hp.toFixed(1)),
        maxHp: Number(enemy.maxHp.toFixed(1)),
        armor: enemy.armor,
        speed: enemy.speed,
        pathProgress: Number(enemy.pathProgress.toFixed(2)),
        slowTime: Number((enemy.slowTime || 0).toFixed(2))
      }))
    };
    snapshot.stateHash = hashString(JSON.stringify(snapshot)).toString(16);
    return snapshot;
  }

  applyRemoteStateFromRoom(room) {
    if (!room || !room.states) return;
    const rivalRoomSide = this.getOppositeRoomSide(this.selfSide);
    const snapshot = room.states[rivalRoomSide];
    if (!snapshot || !snapshot.updatedAt || snapshot.updatedAt <= this.lastRemoteStateAt) return;
    this.lastRemoteStateAt = snapshot.updatedAt;
    this.applyStateSnapshot(SIDES.RIVAL, snapshot);
  }

  // 阶段三：重连进入 playing 房间时，用云端最新快照恢复双方棋盘。
  // 本方快照恢复主棋盘，对方快照恢复上方小棋盘；缺失快照时仍按 battleStartAt 从开局时间追赶。
  restoreRoomSnapshots(room) {
    if (!room || !room.states) return false;
    const selfSnapshot = room.states[this.selfSide];
    const rivalSnapshot = room.states[this.getOppositeRoomSide(this.selfSide)];
    let restored = false;

    if (selfSnapshot) {
      this.applyStateSnapshot(SIDES.SELF, selfSnapshot);
      restored = true;
    }

    if (rivalSnapshot) {
      this.applyStateSnapshot(SIDES.RIVAL, rivalSnapshot);
      this.lastRemoteStateAt = rivalSnapshot.updatedAt || 0;
      restored = true;
    }

    return restored;
  }

  applyStateSnapshot(side, snapshot) {
    const player = this.players[side];
    const board = this.boards[side];
    player.hp = Number(snapshot.hp || 0);
    player.gold = Number(snapshot.gold || 0);
    player.recruitCount = Number(snapshot.recruitCount || 0);
    player.bench = (snapshot.bench || []).map((item) => (item ? clonePlainItem(item) : null));

    board.wave = Number(snapshot.wave || 0);
    board.waveActive = !!snapshot.waveActive;
    board.waveClock = Number(snapshot.waveClock || 0);
    board.waveConfig = createWaveConfig(Math.max(1, board.wave || 1));
    board.spawnedInWave = Number(snapshot.spawnedInWave || 0);
    board.spawnClock = Number(snapshot.spawnClock || 0);
    board.generalSpawned = !!snapshot.generalSpawned;

    const freshTiles = createBoardState(side).tiles;
    board.tiles = freshTiles;
    (snapshot.tiles || []).forEach((tile) => {
      const target = board.tiles.get(cellKey(tile));
      if (target && target.type !== TILE.PATH && target.type !== TILE.BASE) {
        target.type = tile.type === TILE.BUILD ? TILE.BUILD : TILE.GRASS;
      }
    });

    board.units = (snapshot.units || []).map((unit) => hydrateUnit(unit, side));
    board.enemies = (snapshot.enemies || []).map((enemy) => ({
      id: enemy.id || makeId('enemy'),
      side,
      isGeneral: !!enemy.isGeneral,
      name: enemy.name || '贼',
      hp: Number(enemy.hp || 1),
      maxHp: Number(enemy.maxHp || enemy.hp || 1),
      armor: Number(enemy.armor || 0),
      speed: Number(enemy.speed || 1),
      pathProgress: Number(enemy.pathProgress || 0),
      slowTime: Number(enemy.slowTime || 0)
    }));
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
      this.maybeSyncOwnState();
    }

    if (this.status === GAME_STATUS.SETTLING) {
      this.updateSettlement();
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
        const target = this.deterministicPick(side, `wave${board.wave}_general_${general.type}`, candidates);
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
      this.finishGame(side, 'baseDestroyed');
    }
  }

  // 结束对局，展示结果弹窗，并通知云服务记录结算。
  async finishGame(failedSide, reason) {
    if (this.status === GAME_STATUS.FINISHED || this.status === GAME_STATUS.SETTLING) return;
    if (this.isOnlineRoom()) {
      if (failedSide === SIDES.SELF) {
        this.reportSelfFailure(reason || 'baseDestroyed');
      } else {
        this.toastMessage('等待对方确认结算');
      }
      return;
    }
    this.status = GAME_STATUS.FINISHED;
    this.audio.play('finish');
    const winner = failedSide === SIDES.SELF ? SIDES.RIVAL : SIDES.SELF;
    this.modal = {
      title: failedSide === SIDES.SELF ? '战败' : '获胜',
      message: winner === SIDES.SELF ? '你坚持到了最后' : '对方坚持到了最后'
    };
  }

  toRoomSide(localSide) {
    if (localSide === SIDES.SELF) return this.selfSide;
    return this.selfSide === 'A' ? 'B' : 'A';
  }

  // 推进所有己方单位攻击冷却，冷却结束后寻找目标并攻击。
  getOppositeRoomSide(roomSide) {
    return roomSide === 'A' ? 'B' : 'A';
  }

  enterSettling(failedSide, reason) {
    if (this.status === GAME_STATUS.FINISHED) return;
    this.status = GAME_STATUS.SETTLING;
    this.settlingAt = now();
    this.settlingFailedSide = failedSide;
    this.settlingReason = reason || '';
    this.nextResultPollAt = 0;
    this.resultPolling = false;
    this.drag = null;
    this.selectedUnit = null;
    this.toastMessage('正在确认结算...');
  }

  async reportSelfFailure(reason) {
    this.enterSettling(SIDES.SELF, reason || 'baseDestroyed');
    try {
      const result = await this.cloud.finishGame({
        roomId: this.room && this.room.roomId,
        reason: reason || 'baseDestroyed'
      });
      if (result && result.result) {
        this.applyRemoteFinish(result.result);
      }
    } catch (err) {
      console.warn('report failure failed', err);
      this.toastMessage('结算上报失败，等待同步');
    }
  }

  updateSettlement() {
    if (this.room && this.room.status === 'finished' && this.room.result) {
      this.applyRemoteFinish(this.room.result);
      return;
    }

    const elapsed = now() - this.settlingAt;
    if (this.settlingFailedSide === SIDES.SELF && elapsed >= 3000) {
      this.applyRemoteFinish({
        failedSide: this.selfSide,
        winner: this.getOppositeRoomSide(this.selfSide),
        reason: this.settlingReason || 'baseDestroyed',
        fallback: true
      });
      return;
    }

    if (this.nextResultPollAt && now() < this.nextResultPollAt) return;
    if (this.resultPolling || !this.room || !this.room.roomId || !this.cloud.enabled) return;

    this.resultPolling = true;
    this.nextResultPollAt = now() + 1000;
    this.cloud.getRoom(this.room.roomId)
      .then((room) => {
        if (!room) return;
        this.room = Object.assign({}, this.room, room);
        if (room.status === 'finished' && room.result) {
          this.applyRemoteFinish(room.result);
        }
      })
      .catch((err) => {
        console.warn('poll room result failed', err);
      })
      .finally(() => {
        this.resultPolling = false;
      });
  }

  isOnlineRoom() {
    return !!(this.room && this.cloud.enabled);
  }

  confirmSurrender() {
    if (this.status !== GAME_STATUS.PLAYING && this.status !== GAME_STATUS.PAUSED) return;
    if (typeof wx !== 'undefined' && wx.showModal) {
      wx.showModal({
        title: '来和我一起保卫阿斗',
        content: '投降后本局将直接判负，是否继续？',
        confirmText: '投降',
        confirmColor: '#ba2f2f',
        cancelText: '取消',
        success: (res) => {
          if (res.confirm) this.finishGame(SIDES.SELF, 'surrender');
        }
      });
      return;
    }
    this.finishGame(SIDES.SELF, 'surrender');
  }

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
    const heroConfig = unit.kind === ITEM_KIND.HERO ? HERO_CONFIGS[unit.heroName] : null;
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
        attackType: unit.attackType || 'single',
        unitKind: unit.kind,
        unitId: unit.unitId || '',
        baseType: heroConfig ? heroConfig.baseType : '',
        heroName: unit.heroName || '',
        text: `-${damage.toFixed(0)}`,
        life: 0.45,
        maxLife: 0.45
      });
    });

    unit.attackSerial = (unit.attackSerial || 0) + 1;
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

    const serial = unit.attackSerial || 0;
    const roll = (key) => this.deterministicRandom(side, `wave${board.wave}_${unit.heroName}_${unit.cell.x}_${unit.cell.y}_lv${unit.level}_${serial}_${key}`);

    if (unit.heroName === '黄忠' && roll('arrowRain') < 0.18) {
      board.enemies.forEach((enemy) => {
        enemy.hp -= Math.max(1, stats.attack * 0.8 - enemy.armor);
      });
      unit.skillCooldown = 8;
      this.effects.push({ type: 'heroSkill', side, text: '箭雨', life: 0.8 });
      this.removeDeadEnemies(side, unit);
    }

    if (unit.heroName === '马超' && roll('slow') < 0.25) {
      target.slowTime = 2;
      unit.skillCooldown = 3;
    }

    if (unit.heroName === '赵云' && roll('combo') < 0.22) {
      target.hp -= Math.max(1, stats.attack - target.armor);
      unit.skillCooldown = 2;
    }

    if (unit.heroName === '张飞' && roll('roar') < 0.2) {
      board.enemies.forEach((enemy) => {
        if (manhattan(this.enemyCell(enemy), unit.cell) <= 2) enemy.armor = Math.max(0, enemy.armor - 1);
      });
      unit.skillCooldown = 5;
    }

    if (unit.heroName === '关羽' && roll('slash') < 0.2) {
      board.enemies.forEach((enemy) => {
        const cell = this.enemyCell(enemy);
        if (cell.x === unit.cell.x || cell.y === unit.cell.y) {
          enemy.hp -= Math.max(1, stats.attack * 1.4 - enemy.armor);
        }
      });
      unit.skillCooldown = 5;
      this.removeDeadEnemies(side, unit);
    }

    if (unit.heroName === '刘备' && roll('boost') < 0.2) {
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
    if (side === SIDES.SELF && this.recruiting) {
      this.toastMessage('征兵中');
      return;
    }

    const player = this.players[side];
    const cost = getRecruitCost(player);
    if (player.gold < cost) {
      this.toastMessage('金币不足');
      this.audio.play('error');
      return;
    }

    if (side === SIDES.SELF) this.recruiting = true;
    player.gold -= cost;

    try {
      const occupiedSpecialChars = this.collectOccupiedSpecialChars(side);
      const result = await this.cloud.recruit({
        roomId: this.room && this.room.roomId,
        seed: this.seed,
        side: this.selfSide,
        recruitCount: player.recruitCount,
        occupiedSpecialChars
      });

      player.recruitCount += 1;
      player.bench = result.items.map((item) => createBenchItem(item));
      this.audio.play('recruit');
    } catch (err) {
      player.gold += cost;
      this.toastMessage('征兵失败');
      this.audio.play('error');
      console.warn('recruit failed', err);
    } finally {
      if (side === SIDES.SELF) this.recruiting = false;
    }
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
    } else if (this.status === GAME_STATUS.ROOM) {
      this.drawRoom(ctx);
    } else {
      this.drawGame(ctx);
    }

    if (this.toast) this.drawToast(ctx);
    if (this.status === GAME_STATUS.SETTLING) this.drawSettlementOverlay(ctx);
    if (this.roomInputModal) this.drawRoomInputModal(ctx);
    if (this.modal) this.drawModal(ctx);
    if (this.drag) this.drawDraggedItem(ctx);
  }

  // 根据当前屏幕尺寸计算棋盘、按钮、候选栏等区域，避免绘制和触摸判定各算一套。
  computeLayout() {
    if (!this.systemInfo && typeof wx !== 'undefined' && wx.getSystemInfoSync) {
      this.systemInfo = wx.getSystemInfoSync();
    }
    const systemInfo = this.systemInfo;
    const safeArea = systemInfo && systemInfo.safeArea ? systemInfo.safeArea : null;
    const safeTop = safeArea ? Math.max(0, safeArea.top || 0)
      : Math.max(0, (systemInfo && systemInfo.statusBarHeight) || 0);
    const safeBottom = safeArea ? Math.min(this.height, safeArea.bottom || this.height) : this.height;
    const margin = 18;
    const topBarY = safeTop + 8;
    const topBarHeight = 48;
    const recruitW = 132;
    const recruitH = 58;
    const gapTopToRival = 14;
    const gapRivalToSelf = 18;
    const gapBoardToBench = 14;
    const gapBenchToRecruit = 14;
    const bottomPadding = 14;
    const rivalScale = 0.65;
    const maxBoardW = Math.min(this.width - margin * 2, 360);
    let cell = Math.floor(maxBoardW / BOARD.cols);

    const makeMetrics = (cellSize) => {
      const realBoardW = cellSize * BOARD.cols;
      const boardH = cellSize * BOARD.rows;
      const rivalCell = Math.max(10, Math.floor(cellSize * rivalScale));
      const rivalH = rivalCell * BOARD.rows;
      const benchCell = Math.floor((realBoardW - 16) / 5);
      const rivalY = topBarY + topBarHeight + gapTopToRival;
      const recruitY = safeBottom - bottomPadding - recruitH;
      const benchY = recruitY - gapBenchToRecruit - benchCell;
      const selfY = benchY - gapBoardToBench - boardH;
      const minSelfY = rivalY + rivalH + gapRivalToSelf;

      return {
        realBoardW,
        boardH,
        rivalCell,
        rivalH,
        benchCell,
        rivalY,
        recruitY,
        benchY,
        selfY,
        minSelfY
      };
    };

    let metrics = makeMetrics(cell);
    while (cell > 18 && metrics.selfY < metrics.minSelfY) {
      cell -= 1;
      metrics = makeMetrics(cell);
    }

    const realBoardW = metrics.realBoardW;
    const boardH = metrics.boardH;
    const x = Math.floor((this.width - realBoardW) / 2);
    const selfY = metrics.selfY;
    const rivalCell = metrics.rivalCell;
    const rivalW = rivalCell * BOARD.cols;

    this.layout = {
      margin,
      safeTop,
      safeBottom,
      topBarY,
      topBarHeight,
      cell,
      boardX: x,
      selfBoardY: selfY,
      boardW: realBoardW,
      boardH,
      rivalCell,
      rivalBoardX: Math.floor((this.width - rivalW) / 2),
      rivalBoardY: metrics.rivalY,
      rivalBoardW: rivalW,
      rivalBoardH: rivalCell * BOARD.rows,
      benchY: metrics.benchY,
      benchCell: metrics.benchCell,
      recruitButton: { x: x + realBoardW / 2 - recruitW / 2, y: metrics.recruitY, w: recruitW, h: recruitH },
      pauseButton: { x: 14, y: topBarY, w: 44, h: 34 },
      muteButton: { x: this.width - 58, y: topBarY, w: 44, h: 34 },
      resetButton: { x: this.width - 112, y: topBarY, w: 44, h: 34 }
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
    wrapText(ctx, '双人独立防守，征兵合字，守住自己的“斗”', this.width / 2, 178, this.width - 56, 22);

    const buttonX = 58;
    const buttonW = this.width - 116;
    const buttonH = 52;
    const hasResume = this.cloud.enabled && this.savedRoomId && this.savedRoomId !== this.launchRoomId;
    const buttonCount = 3 + (this.launchRoomId ? 1 : 0) + (hasResume ? 1 : 0);
    const buttonGap = buttonCount >= 5 ? 60 : 68;
    const startY = buttonCount >= 5 ? 226 : 250;
    const createBtn = { x: buttonX, y: startY, w: buttonW, h: buttonH };
    let nextY = startY + buttonGap;
    const joinBtn = this.launchRoomId ? { x: buttonX, y: nextY, w: buttonW, h: buttonH } : null;
    if (joinBtn) nextY += buttonGap;
    const resumeBtn = hasResume ? { x: buttonX, y: nextY, w: buttonW, h: buttonH } : null;
    if (resumeBtn) nextY += buttonGap;
    const roomIdBtn = { x: buttonX, y: nextY, w: buttonW, h: buttonH };
    nextY += buttonGap;
    const localBtn = { x: buttonX, y: nextY, w: buttonW, h: buttonH };
    this.buttons = { createBtn, joinBtn, resumeBtn, roomIdBtn, localBtn };
    this.drawButton(ctx, createBtn, '创建房间');
    if (joinBtn) this.drawButton(ctx, joinBtn, '加入好友房间');
    if (resumeBtn) this.drawButton(ctx, resumeBtn, '继续上局');
    this.drawButton(ctx, roomIdBtn, '输入房间号');
    this.drawButton(ctx, localBtn, '本地练习');

    ctx.fillStyle = COLORS.mutedInk;
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    // 提示文字放在最后一个按钮下方，避免按钮数量变化时和“本地练习”重叠。
    const hintY = Math.min(this.height - 24, localBtn.y + localBtn.h + 32);
    ctx.fillText(this.cloud.enabled ? '联机模式已启用，可创建房间或输入房间号加入' : '云环境未配置时会自动使用本地模拟', this.width / 2, hintY);
  }

  // 房间等待页。创建者停留在这里，直到好友通过分享链接加入。
  drawRoom(ctx) {
    drawCenteredText(ctx, '等待好友加入', this.width / 2, 142, {
      font: 'bold 34px serif',
      color: COLORS.ink,
      stroke: '#fff7eb',
      strokeWidth: 5
    });

    ctx.fillStyle = COLORS.mutedInk;
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`房间号：${this.room ? this.room.roomId : '-'}`, this.width / 2, 194);
    ctx.fillText('请点击分享，把房间发给好友', this.width / 2, 224);

    const copyBtn = { x: 58, y: 264, w: this.width - 116, h: 52 };
    const shareBtn = { x: 58, y: 338, w: this.width - 116, h: 52 };
    const backBtn = { x: 58, y: 412, w: this.width - 116, h: 52 };
    this.buttons = { copyRoomId: copyBtn, shareRoom: shareBtn, backHome: backBtn };
    this.drawButton(ctx, copyBtn, '复制房间号');
    this.drawButton(ctx, shareBtn, '分享邀请');
    this.drawButton(ctx, backBtn, '返回首页');
  }

  // 绘制对局主界面：顶部状态栏、双方棋盘、候选栏、按钮和临时效果。
  drawGame(ctx) {
    this.buttons = {
      pause: this.layout.pauseButton,
      mute: this.layout.muteButton,
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
    const y = this.layout.topBarY;
    this.drawIconButton(ctx, this.layout.pauseButton, this.status === GAME_STATUS.PAUSED ? '▶' : 'Ⅱ');
    this.drawIconButton(ctx, this.layout.resetButton, this.isOnlineRoom() ? '降' : '↻');
    this.drawIconButton(ctx, this.layout.muteButton, this.audio.muted ? '静' : '音');

    const player = this.players[SIDES.SELF];
    ctx.fillStyle = COLORS.ink;
    ctx.font = '18px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`金币 ${player.gold}`, 72, y + 25);

    const board = this.boards[SIDES.SELF];
    ctx.textAlign = 'center';
    ctx.font = 'bold 18px serif';
    ctx.fillText(`第${Math.max(1, board.wave || 1)}波`, this.width / 2, y + 20);
    if (!board.waveActive) {
      ctx.font = '13px sans-serif';
      ctx.fillText(`准备 ${Math.ceil(board.waveClock)}s`, this.width / 2, y + 40);
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
    const player = this.players[side];
    const hpText = '♥'.repeat(Math.max(0, player.hp));
    drawCenteredText(ctx, hpText, base.x + cell / 2, base.y - (small ? 3 : 7), {
      font: `bold ${Math.floor(cell * (small ? 0.46 : 0.42))}px sans-serif`,
      color: COLORS.danger
    });
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

    const enemyName = getEnemyDisplayName(enemy);
    drawCenteredText(ctx, enemyName.length > 1 ? enemyName.slice(0, 1) : enemyName, cx, cy, {
      font: `bold ${Math.floor(cell * (small ? 0.28 : 0.32))}px serif`,
      color: '#f8eee0'
    });

    if (!small) {
      ctx.font = `bold ${Math.floor(cell * 0.22)}px sans-serif`;
      ctx.fillStyle = COLORS.ink;
      ctx.textAlign = 'center';
      if (enemy.isGeneral) {
        ctx.fillText(enemyName, cx, cy + cell * 0.48);
      }

      const barW = cell * 0.92;
      const barX = cx - barW / 2;
      ctx.fillStyle = '#4f1e1e';
      ctx.fillRect(barX, pos.y + 3, barW, 4);
      ctx.fillStyle = '#e1533d';
      ctx.fillRect(barX, pos.y + 3, barW * clamp(enemy.hp / enemy.maxHp, 0, 1), 4);
    } else {
      ctx.font = `bold ${Math.floor(cell * 0.18)}px sans-serif`;
      ctx.fillStyle = COLORS.ink;
      ctx.textAlign = 'center';
      if (enemy.isGeneral) {
        ctx.fillText(enemyName.length > 2 ? enemyName.slice(0, 2) : enemyName, cx, cy + cell * 0.46);
      }

      const barW = cell * 0.9;
      const barX = cx - barW / 2;
      ctx.fillStyle = '#4f1e1e';
      ctx.fillRect(barX, pos.y + 1, barW, 3);
      ctx.fillStyle = '#e1533d';
      ctx.fillRect(barX, pos.y + 1, barW * clamp(enemy.hp / enemy.maxHp, 0, 1), 3);
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
        drawItemLevelBadge(ctx, item, rect.x + rect.w - 6, rect.y + 12);
      }
    }
  }

  // 绘制征兵按钮，并根据金币是否足够显示可用/不可用状态。
  drawRecruitButton(ctx) {
    const player = this.players[SIDES.SELF];
    const cost = getRecruitCost(player);
    const rect = this.layout.recruitButton;
    const disabled = player.gold < cost || this.recruiting;
    this.drawButton(ctx, rect, this.recruiting ? '征兵中' : '征兵', disabled);
    this.drawCoinAmount(ctx, cost, rect.x + rect.w / 2, rect.y + rect.h - 14, disabled, 'center');
  }

  drawCoinAmount(ctx, amount, x, y, disabled, align) {
    const text = String(amount);
    const iconRadius = 6;
    const iconGap = 5;
    ctx.save();
    ctx.font = '14px sans-serif';
    const textW = ctx.measureText(text).width;
    const groupW = iconRadius * 2 + iconGap + textW;
    const startX = align === 'center' ? x - groupW / 2 : x;
    const iconX = startX + iconRadius;
    const textX = startX + iconRadius * 2 + iconGap;
    this.drawCoinIcon(ctx, iconX, y - 1, disabled);
    ctx.fillStyle = disabled ? '#846d5c' : '#fff8e6';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, textX, y);
    ctx.restore();
  }

  drawCoinIcon(ctx, x, y, disabled) {
    ctx.save();
    ctx.fillStyle = disabled ? '#b69b64' : '#f3c24f';
    ctx.strokeStyle = disabled ? '#846d5c' : '#8a5a19';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = disabled ? '#8d734a' : '#fff0a8';
    ctx.beginPath();
    ctx.arc(x - 2, y - 2, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
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
  drawDamageEffect(ctx, effect, side, small) {
    const from = this.cellToPixel(effect.from, side, small);
    const to = this.cellToPixel(effect.to, side, small);
    const cell = small ? this.layout.rivalCell : this.layout.cell;
    const scale = small ? 0.72 : 1;
    const maxLife = effect.maxLife || 0.45;
    const progress = clamp(1 - effect.life / maxLife, 0, 1);
    const fromCenter = { x: from.x + cell / 2, y: from.y + cell / 2 };
    const toCenter = { x: to.x + cell / 2, y: to.y + cell / 2 };

    ctx.save();
    ctx.globalAlpha = clamp(effect.life / maxLife, 0, 1);
    this.drawTypedDamageEffect(ctx, effect, fromCenter, toCenter, progress, scale);
    this.drawFloatingDamageText(ctx, effect, toCenter, progress, scale);
    ctx.restore();
  }

  drawTypedDamageEffect(ctx, effect, from, to, progress, scale) {
    if (effect.attackType === 'area' || effect.unitId === 'cavalry') {
      this.drawImpactRing(ctx, to, progress, scale);
      return;
    }
    if (effect.attackType === 'pierce' || effect.unitId === 'spear') {
      this.drawPierceEffect(ctx, from, to, progress, scale);
      return;
    }
    if (effect.unitId === 'bow' || effect.baseType === 'bow') {
      this.drawArrowEffect(ctx, from, to, progress, scale);
      return;
    }
    this.drawSlashEffect(ctx, to, progress, scale);
  }

  drawImpactRing(ctx, to, progress, scale) {
    const hit = clamp(progress, 0, 1);
    ctx.strokeStyle = `rgba(214, 111, 38, ${1 - hit * 0.8})`;
    ctx.lineWidth = 3 * scale;
    ctx.beginPath();
    ctx.arc(to.x, to.y, (5 + hit * 20) * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = `rgba(225, 83, 61, ${0.26 * (1 - hit)})`;
    ctx.beginPath();
    ctx.arc(to.x, to.y, (4 + hit * 10) * scale, 0, Math.PI * 2);
    ctx.fill();
  }

  drawPierceEffect(ctx, from, to, progress, scale) {
    const travel = clamp(progress / 0.7, 0, 1);
    const x = lerp(from.x, to.x, travel);
    const y = lerp(from.y, to.y, travel);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    const length = 22 * scale;
    const width = 4 * scale;

    ctx.fillStyle = 'rgba(255, 232, 154, 0.88)';
    ctx.beginPath();
    ctx.moveTo(x + ux * length, y + uy * length);
    ctx.lineTo(x - ux * length * 0.45 + nx * width, y - uy * length * 0.45 + ny * width);
    ctx.lineTo(x - ux * length * 0.45 - nx * width, y - uy * length * 0.45 - ny * width);
    ctx.closePath();
    ctx.fill();
  }

  drawArrowEffect(ctx, from, to, progress, scale) {
    const travel = clamp(progress / 0.78, 0, 1);
    const x = lerp(from.x, to.x, travel);
    const y = lerp(from.y, to.y, travel);
    const angle = Math.atan2(to.y - from.y, to.x - from.x);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.strokeStyle = '#5b3519';
    ctx.lineWidth = 2 * scale;
    ctx.beginPath();
    ctx.moveTo(-10 * scale, 0);
    ctx.lineTo(8 * scale, 0);
    ctx.stroke();
    ctx.fillStyle = '#e7c56b';
    ctx.beginPath();
    ctx.moveTo(10 * scale, 0);
    ctx.lineTo(3 * scale, -4 * scale);
    ctx.lineTo(3 * scale, 4 * scale);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawSlashEffect(ctx, to, progress, scale) {
    const swing = clamp(progress, 0, 1);
    const r = 14 * scale;
    ctx.strokeStyle = `rgba(255, 238, 190, ${1 - swing * 0.35})`;
    ctx.lineWidth = 4 * scale;
    ctx.beginPath();
    ctx.arc(to.x, to.y, r, -0.95 + swing * 0.5, 0.75 + swing * 0.5);
    ctx.stroke();
    ctx.strokeStyle = `rgba(225, 83, 61, ${0.65 * (1 - swing)})`;
    ctx.lineWidth = 2 * scale;
    ctx.beginPath();
    ctx.arc(to.x, to.y, r * 0.58, 0.15, Math.PI * 1.15);
    ctx.stroke();
  }

  drawFloatingDamageText(ctx, effect, to, progress, scale) {
    drawCenteredText(ctx, effect.text, to.x, to.y - (8 + progress * 18) * scale, {
      font: `${Math.floor(13 * scale)}px sans-serif`,
      color: COLORS.danger
    });
  }

  drawEffects(ctx) {
    this.effects.forEach((effect) => {
      ctx.save();
      ctx.globalAlpha = clamp(effect.life / 0.8, 0, 1);
      const side = effect.side || SIDES.SELF;
      const small = side === SIDES.RIVAL;

      if (effect.type === 'damage') {
        this.drawDamageEffect(ctx, effect, side, small);
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
  drawSettlementOverlay(ctx) {
    ctx.save();
    ctx.fillStyle = 'rgba(36,25,21,0.38)';
    ctx.fillRect(0, 0, this.width, this.height);
    const rect = { x: 46, y: this.height / 2 - 58, w: this.width - 92, h: 116 };
    ctx.fillStyle = COLORS.panel;
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 3;
    roundedRect(ctx, rect.x, rect.y, rect.w, rect.h, 8);
    ctx.fill();
    ctx.stroke();
    drawCenteredText(ctx, '正在确认结算', this.width / 2, rect.y + 42, {
      font: 'bold 24px serif',
      color: COLORS.ink
    });
    drawCenteredText(ctx, '请稍候...', this.width / 2, rect.y + 76, {
      font: '15px sans-serif',
      color: COLORS.mutedInk
    });
    ctx.restore();
  }

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
    this.drawButton(ctx, btn, this.isOnlineRoom() ? '再开联机房间' : '再来一局');
    ctx.restore();
  }

  // 自绘房间号输入弹窗。系统键盘只采集字符，弹窗负责展示、确认和关闭。
  drawRoomInputModal(ctx) {
    const value = this.roomInputModal && this.roomInputModal.value ? this.roomInputModal.value : '';
    ctx.save();
    ctx.fillStyle = 'rgba(40,30,20,0.46)';
    ctx.fillRect(0, 0, this.width, this.height);

    const rect = { x: 38, y: this.height / 2 - 142, w: this.width - 76, h: 250 };
    ctx.fillStyle = COLORS.panel;
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 3;
    roundedRect(ctx, rect.x, rect.y, rect.w, rect.h, 8);
    ctx.fill();
    ctx.stroke();

    drawCenteredText(ctx, '输入房间号', this.width / 2, rect.y + 44, {
      font: 'bold 28px serif',
      color: COLORS.ink
    });
    drawCenteredText(ctx, '请输入好友分享给你的房间号', this.width / 2, rect.y + 76, {
      font: '14px sans-serif',
      color: COLORS.mutedInk
    });

    const inputRect = { x: rect.x + 28, y: rect.y + 100, w: rect.w - 56, h: 52 };
    ctx.fillStyle = '#fffaf0';
    ctx.strokeStyle = COLORS.wood;
    ctx.lineWidth = 2;
    roundedRect(ctx, inputRect.x, inputRect.y, inputRect.w, inputRect.h, 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = value ? COLORS.ink : COLORS.mutedInk;
    ctx.font = value ? 'bold 20px sans-serif' : '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(value || '例如 RABC123', inputRect.x + inputRect.w / 2, inputRect.y + inputRect.h / 2);

    const gap = 14;
    const btnW = (rect.w - 56 - gap) / 2;
    const cancelBtn = { x: rect.x + 28, y: rect.y + 178, w: btnW, h: 48 };
    const confirmBtn = { x: cancelBtn.x + btnW + gap, y: cancelBtn.y, w: btnW, h: 48 };
    this.buttons.roomInputCancel = cancelBtn;
    this.buttons.roomInputConfirm = confirmBtn;
    this.drawButton(ctx, cancelBtn, '取消');
    this.drawButton(ctx, confirmBtn, '加入');
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

    if (this.roomInputModal) {
      if (this.buttons.roomInputCancel && pointInRect(p, this.buttons.roomInputCancel)) {
        this.closeRoomIdInput();
      } else if (this.buttons.roomInputConfirm && pointInRect(p, this.buttons.roomInputConfirm)) {
        this.confirmRoomIdInput(this.roomInputModal.value);
      }
      return;
    }

    if (this.status === GAME_STATUS.HOME) {
      if (pointInRect(p, this.buttons.createBtn)) this.createRoomAndStart();
      else if (this.buttons.joinBtn && pointInRect(p, this.buttons.joinBtn)) this.joinRoomAndStart();
      else if (this.buttons.resumeBtn && pointInRect(p, this.buttons.resumeBtn)) this.resumeLastRoom();
      else if (pointInRect(p, this.buttons.roomIdBtn)) this.showRoomIdKeyboard();
      else if (pointInRect(p, this.buttons.localBtn)) {
        this.room = null;
        this.closeRealtimeWatchers();
        this.resetLocalGame();
        this.status = GAME_STATUS.PLAYING;
      }
      return;
    }

    if (this.status === GAME_STATUS.ROOM) {
      if (pointInRect(p, this.buttons.copyRoomId)) this.copyRoomId();
      if (pointInRect(p, this.buttons.shareRoom)) this.shareRoom();
      if (pointInRect(p, this.buttons.backHome)) this.showHome();
      return;
    }

    if (this.modal && pointInRect(p, this.buttons.modalRestart)) {
      this.restartFinishedGame();
      return;
    }

    if (this.status === GAME_STATUS.SETTLING) return;

    if (pointInRect(p, this.layout.pauseButton)) {
      this.requestPause();
      return;
    }
    if (pointInRect(p, this.layout.muteButton)) {
      this.audio.toggleMuted();
      return;
    }
    if (pointInRect(p, this.layout.resetButton)) {
      if (this.isOnlineRoom()) {
        this.confirmSurrender();
        return;
      }
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
    if (benchIndex !== -1) {
      this.dropToBench(drag, benchIndex);
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

  // 候选栏落点：支持棋盘回收、候选内移动/交换，以及在候选栏直接合成。
  dropToBench(drag, benchIndex) {
    if (drag.source === 'bench' && drag.benchIndex === benchIndex) return;

    const player = this.players[SIDES.SELF];
    const targetItem = player.bench[benchIndex];
    if (targetItem) {
      if (this.tryMergeToBench(drag, benchIndex)) return;
      if (this.trySwapBenchItems(drag, benchIndex)) return;
      this.toastMessage('候选格已满');
      this.audio.play('error');
      return;
    }

    if (drag.source === 'board') {
      this.moveUnitToBench(drag.item, benchIndex);
      return;
    }

    player.bench[benchIndex] = drag.item;
    player.bench[drag.benchIndex] = null;
    this.audio.play('place');
    this.emitAction('SWAP', {
      source: 'bench',
      benchIndex: drag.benchIndex,
      targetBenchIndex: benchIndex
    });
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
    const fromCell = unit.cell ? cloneCell(unit.cell) : null;
    unit.cell = null;
    this.audio.play('place');
    this.emitAction('MOVE_TO_BENCH', { fromCell, benchIndex });
  }

  tryMergeToBench(drag, targetBenchIndex) {
    const player = this.players[SIDES.SELF];
    const targetItem = player.bench[targetBenchIndex];
    const sourceItem = drag.source === 'board' ? drag.item : drag.item;
    if (!targetItem || !sourceItem || targetItem === sourceItem) return false;

    if (canMergeBasic(sourceItem, targetItem)) {
      targetItem.level += 1;
      this.removeDraggedOriginal(drag);
      this.audio.play('merge');
      this.emitAction('MERGE', {
        source: drag.source,
        benchIndex: drag.benchIndex,
        fromCell: drag.fromCell ? cloneCell(drag.fromCell) : null,
        targetBenchIndex
      });
      return true;
    }

    const heroName = getHeroNameFromChars(sourceItem, targetItem);
    if (heroName) {
      this.removeDraggedOriginal(drag);
      player.bench[targetBenchIndex] = createHeroUnit(heroName, SIDES.SELF, null);
      this.effects.push({ type: 'heroSkill', side: SIDES.SELF, text: heroName, life: 0.8 });
      this.audio.play('merge');
      this.emitAction('MERGE', {
        source: drag.source,
        benchIndex: drag.benchIndex,
        fromCell: drag.fromCell ? cloneCell(drag.fromCell) : null,
        targetBenchIndex
      });
      return true;
    }

    return false;
  }

  trySwapBenchItems(drag, targetBenchIndex) {
    if (drag.item.kind === ITEM_KIND.SHOVEL || drag.source !== 'bench') return false;
    const player = this.players[SIDES.SELF];
    const targetItem = player.bench[targetBenchIndex];
    player.bench[targetBenchIndex] = drag.item;
    player.bench[drag.benchIndex] = targetItem;
    this.audio.play('place');
    this.emitAction('SWAP', {
      source: 'bench',
      benchIndex: drag.benchIndex,
      targetBenchIndex
    });
    return true;
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
    this.audio.play('place');
    this.emitAction('SHOVEL', {
      source: drag.source,
      benchIndex: drag.benchIndex,
      cell: cloneCell(cell)
    });
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
    this.emitAction('PLACE', {
      source: drag.source,
      benchIndex: drag.benchIndex,
      fromCell: drag.fromCell ? cloneCell(drag.fromCell) : null,
      cell: cloneCell(cell)
    });
  }

  // 尝试合成：同兵种同等级基础单位升星；特殊字组合生成武将。
  tryMergeUnits(drag, targetUnit) {
    const sourceItem = drag.source === 'board' ? drag.item : createUnitFromItem(drag.item, SIDES.SELF);

    if (canMergeBasic(sourceItem, targetUnit)) {
      const targetCell = cloneCell(targetUnit.cell);
      targetUnit.level += 1;
      this.removeDraggedOriginal(drag);
      this.effects.push({ type: 'levelUp', side: SIDES.SELF, cell: targetUnit.cell, life: 0.8 });
      this.audio.play('merge');
      this.emitAction('MERGE', {
        source: drag.source,
        benchIndex: drag.benchIndex,
        fromCell: drag.fromCell ? cloneCell(drag.fromCell) : null,
        targetCell
      });
      return true;
    }

    const heroName = getHeroNameFromChars(sourceItem, targetUnit);
    if (heroName) {
      const targetCell = cloneCell(targetUnit.cell);
      const hero = createHeroUnit(heroName, SIDES.SELF, targetUnit.cell);
      this.removeDraggedOriginal(drag);
      this.boards[SIDES.SELF].units = this.boards[SIDES.SELF].units.filter((unit) => unit !== targetUnit);
      this.boards[SIDES.SELF].units.push(hero);
      this.effects.push({ type: 'heroSkill', side: SIDES.SELF, text: heroName, life: 0.8 });
      this.audio.play('merge');
      this.emitAction('MERGE', {
        source: drag.source,
        benchIndex: drag.benchIndex,
        fromCell: drag.fromCell ? cloneCell(drag.fromCell) : null,
        targetCell
      });
      return true;
    }

    return false;
  }

  // 不能合成时执行换位：棋盘拖棋盘交换格子；候选栏拖棋盘则和原候选栏位置互换。
  trySwapUnits(drag, targetUnit) {
    if (drag.item.kind === ITEM_KIND.SHOVEL) return false;

    if (drag.source === 'board') {
      const fromCell = drag.fromCell || drag.item.cell;
      const targetCell = cloneCell(targetUnit.cell);
      drag.item.cell = { x: targetUnit.cell.x, y: targetUnit.cell.y };
      targetUnit.cell = { x: fromCell.x, y: fromCell.y };
      this.audio.play('place');
      this.emitAction('SWAP', {
        source: 'board',
        fromCell: cloneCell(fromCell),
        targetCell
      });
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
      this.emitAction('SWAP', {
        source: 'bench',
        benchIndex: drag.benchIndex,
        targetCell: cloneCell(placedUnit.cell)
      });
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
      this.emitAction('PAUSE_REQUEST', {});
      this.toastMessage(this.room && this.cloud.enabled ? '已请求暂停，等待对方同意' : '已请求暂停，本地模拟自动同意');
      if (!this.room || !this.cloud.enabled) {
        setTimeout(() => {
          if (this.status === GAME_STATUS.PAUSE_PENDING) this.status = GAME_STATUS.PAUSED;
        }, 600);
      }
      return;
    }

    if (this.status === GAME_STATUS.PAUSED) {
      this.status = GAME_STATUS.PLAYING;
      this.emitAction('PAUSE_RESUME', {});
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
  const benchItem = Object.assign({ id: makeId('bench') }, item);
  if (benchItem.kind !== ITEM_KIND.SHOVEL) benchItem.level = benchItem.level || 1;
  return benchItem;
}

function serializeBenchItem(item) {
  if (!item) return null;
  if (item.kind === ITEM_KIND.BASIC) {
    return { id: item.id, kind: item.kind, unitId: item.unitId, level: item.level || 1 };
  }
  if (item.kind === ITEM_KIND.SPECIAL_CHAR) {
    return { id: item.id, kind: item.kind, char: item.char, level: item.level || 1 };
  }
  if (item.kind === ITEM_KIND.HERO) {
    return serializeUnit(item);
  }
  if (item.kind === ITEM_KIND.SHOVEL) {
    return { id: item.id, kind: item.kind };
  }
  return clonePlainItem(item);
}

function serializeUnit(unit) {
  const base = {
    id: unit.id,
    kind: unit.kind,
    level: unit.level || 1,
    cell: cloneCell(unit.cell),
    attackCooldown: Number((unit.attackCooldown || 0).toFixed(2)),
    skillCooldown: Number((unit.skillCooldown || 0).toFixed(2)),
    attackSerial: unit.attackSerial || 0
  };
  if (unit.kind === ITEM_KIND.BASIC) {
    base.unitId = unit.unitId;
    base.attackType = unit.attackType;
  }
  if (unit.kind === ITEM_KIND.SPECIAL_CHAR) {
    base.char = unit.char;
  }
  if (unit.kind === ITEM_KIND.HERO) {
    base.heroName = unit.heroName;
    base.exp = unit.exp || 0;
    base.attackType = unit.attackType;
  }
  return base;
}

function hydrateUnit(data, side) {
  let unit;
  if (data.kind === ITEM_KIND.BASIC) {
    unit = createUnitFromItem(data, side);
  } else if (data.kind === ITEM_KIND.SPECIAL_CHAR) {
    unit = createUnitFromItem(data, side);
  } else if (data.kind === ITEM_KIND.HERO) {
    unit = createHeroUnit(data.heroName, side, data.cell || { x: 0, y: 0 }, data.id);
    unit.exp = data.exp || 0;
  } else {
    unit = clonePlainItem(data);
  }

  unit.id = data.id || unit.id;
  unit.level = data.level || unit.level || 1;
  unit.cell = data.cell ? cloneCell(data.cell) : null;
  unit.attackCooldown = Number(data.attackCooldown || 0);
  unit.skillCooldown = Number(data.skillCooldown || 0);
  unit.attackSerial = Number(data.attackSerial || 0);
  return unit;
}

function clonePlainItem(item) {
  return JSON.parse(JSON.stringify(item));
}

// 复制格子坐标，避免同步 payload 持有游戏对象引用。
function cloneCell(cell) {
  if (!cell) return null;
  return { x: Math.floor(cell.x), y: Math.floor(cell.y) };
}

// 房间号统一清洗：去掉首尾空格并转大写，兼容用户手动输入小写房间号。
function normalizeRoomId(roomId) {
  return String(roomId || '').trim().toUpperCase();
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
      attackSerial: item.attackSerial || 0,
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
      level: item.level || 1,
      attackCooldown: 0,
      skillCooldown: 0,
      attackSerial: item.attackSerial || 0,
      cell: null
    };
  }

  return item;
}

// 创建武将单位。武将属性来自 HERO_CONFIGS，等级和经验从 1 级 0 经验开始。
function createHeroUnit(heroName, side, cell, id) {
  const cfg = HERO_CONFIGS[heroName];
  return {
    id: id || makeId('hero'),
    side,
    kind: ITEM_KIND.HERO,
    heroName,
    text: cfg.text,
    level: 1,
    exp: 0,
    attackType: cfg.baseType === 'cavalry' ? 'area' : cfg.baseType === 'spear' ? 'pierce' : 'single',
    attackCooldown: 0,
    skillCooldown: 0,
    attackSerial: 0,
    cell: cell ? { x: cell.x, y: cell.y } : null
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

function drawItemLevelBadge(ctx, item, x, y) {
  if (!item || item.kind === ITEM_KIND.SHOVEL) return;
  ctx.save();
  ctx.fillStyle = COLORS.danger;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(String(item.level || 1), x, y);
  ctx.restore();
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

// 敌人显示名称。普通敌人用配置里的 name，大将用完整大将名。
function getEnemyDisplayName(enemy) {
  return enemy.name || (enemy.isGeneral ? '大将' : '贼');
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
