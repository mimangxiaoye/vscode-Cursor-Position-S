"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = exports.CursorPositionManager = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
class CursorPositionManager {
    constructor(context) {
        this.positions = {};
        this.storageDir = '';
        this.storageFile = '';
        this.context = context;
        this.logger = new Logger();
        this.initializeStorage();
        this.loadPositions();
        this.initializeStatusBar();
        this.startTimers();
        this.setupEventListeners();
        this.showStartupMessage();
        this.logger.info('CursorPositionManager initialized successfully');
    }
    initializeStorage() {
        try {
            const config = vscode.workspace.getConfiguration('cursorPositionSaver');
            const saveLocation = config.get('saveLocation', 'c_drive');
            if (saveLocation === 'd_drive') {
                this.storageDir = path.join('D:', 'mycode');
            }
            else {
                this.storageDir = path.join(os.homedir(), 'mycode');
            }
            this.storageFile = path.join(this.storageDir, 'cursor-positions.json');
            // 创建目录
            if (!fs.existsSync(this.storageDir)) {
                fs.mkdirSync(this.storageDir, { recursive: true });
                this.logger.info(`Created storage directory: ${this.storageDir}`);
            }
            this.logger.info(`Storage initialized at: ${this.storageFile}`);
        }
        catch (error) {
            this.logger.error('Failed to initialize storage', error);
            throw error;
        }
    }
    initializeStatusBar() {
        const config = vscode.workspace.getConfiguration('cursorPositionSaver');
        if (config.get('enableStatusBar', true)) {
            this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
            this.statusBarItem.text = "$(save) 光标保存";
            this.statusBarItem.tooltip = "光标位置保存插件已启动\n点击查看状态";
            this.statusBarItem.command = 'cursorPositionSaver.showStatus';
            this.statusBarItem.show();
            this.context.subscriptions.push(this.statusBarItem);
        }
    }
    showStartupMessage() {
        const config = vscode.workspace.getConfiguration('cursorPositionSaver');
        if (config.get('showStartupMessage', true)) {
            // 方式1: 带图标的信息消息
            vscode.window.showInformationMessage('$(check) 光标位置保存插件已启动');
            // 方式2: 状态栏临时消息
            vscode.window.setStatusBarMessage('$(sync~spin) 光标保存插件启动中...', 3000);
            // 显示启动完成的通知栏消息
            setTimeout(() => {
                vscode.window.setStatusBarMessage('$(check-all) 光标保存插件启动完成', 2000);
            }, 1000);
        }
    }
    loadPositions() {
        try {
            if (fs.existsSync(this.storageFile)) {
                const data = fs.readFileSync(this.storageFile, 'utf8');
                this.positions = JSON.parse(data);
                this.logger.info(`Loaded ${Object.keys(this.positions).length} file positions`);
            }
        }
        catch (error) {
            this.logger.error('Failed to load positions', error);
            this.positions = {};
        }
    }
    savePositions() {
        try {
            // 获取当前打开的所有文件路径
            const openFilePaths = new Set();
            vscode.window.tabGroups.all.forEach(group => {
                group.tabs.forEach(tab => {
                    if (tab.input && tab.input.uri) {
                        const uri = tab.input.uri;
                        if (uri.scheme === 'file') {
                            openFilePaths.add(uri.fsPath);
                        }
                    }
                });
            });
            // 只保留当前打开文件的光标位置
            const filteredPositions = {};
            for (const filePath in this.positions) {
                if (openFilePaths.has(filePath)) {
                    filteredPositions[filePath] = this.positions[filePath];
                }
            }
            this.positions = filteredPositions;
            const dataStr = JSON.stringify(this.positions, null, 2);
            const dataSize = Buffer.byteLength(dataStr, 'utf8');
            fs.writeFileSync(this.storageFile, dataStr);
            this.logger.debug(`Saved positions to ${this.storageFile} (${dataSize} bytes) for ${Object.keys(this.positions).length} open files`);
            // 更新状态栏显示最后保存时间
            if (this.statusBarItem) {
                this.statusBarItem.text = `$(save) 已保存 ${new Date().toLocaleTimeString()}`;
            }
        }
        catch (error) {
            this.logger.error('Failed to save positions', error);
            vscode.window.showErrorMessage('$(error) 光标位置保存失败');
        }
    }
    setupEventListeners() {
        // 监听光标位置变化
        vscode.window.onDidChangeTextEditorSelection((event) => {
            if (this.isEnabled()) {
                this.updateCursorPosition(event.textEditor);
            }
        });
        // 监听文件打开
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && this.isEnabled()) {
                this.restoreCursorPosition(editor);
            }
        });
        // 监听配置变化
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('cursorPositionSaver')) {
                this.handleConfigurationChange();
            }
        });
        this.logger.info('Event listeners set up successfully');
    }
    handleConfigurationChange() {
        try {
            this.initializeStorage();
            this.loadPositions();
            this.restartTimers();
            vscode.window.showInformationMessage('$(gear) 光标保存插件配置已更新');
            this.logger.info('Configuration updated');
        }
        catch (error) {
            this.logger.error('Failed to handle configuration change', error);
        }
    }
    updateCursorPosition(editor) {
        if (!editor.document.uri.fsPath) {
            return;
        }
        const filePath = editor.document.uri.fsPath;
        const position = editor.selection.active;
        // 直接保存最新位置，覆盖之前的位置
        this.positions[filePath] = {
            line: position.line,
            character: position.character,
            timestamp: Date.now()
        };
        this.logger.debug(`Updated cursor position for ${filePath}: line ${position.line}, char ${position.character}`);
    }
    restoreCursorPosition(editor) {
        if (!editor.document.uri.fsPath) {
            return;
        }
        const filePath = editor.document.uri.fsPath;
        const savedPosition = this.positions[filePath];
        if (savedPosition) {
            const position = new vscode.Position(savedPosition.line, savedPosition.character);
            // 确保位置在文档范围内
            if (position.line < editor.document.lineCount) {
                const selection = new vscode.Selection(position, position);
                editor.selection = selection;
                editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
                this.logger.info(`Restored cursor position for ${filePath}: line ${savedPosition.line}, char ${savedPosition.character}`);
            }
        }
    }
    restoreActiveEditorCursorPosition() {
        const editor = vscode.window.activeTextEditor;
        if (editor && this.isEnabled()) {
            this.restoreCursorPosition(editor);
            vscode.window.showInformationMessage('$(location) 光标位置已恢复');
        }
    }
    startTimers() {
        const config = vscode.workspace.getConfiguration('cursorPositionSaver');
        const saveInterval = config.get('saveInterval', 10) * 1000;
        const tipMode = config.get('tipMode', 'none');
        // 保存定时器
        this.saveTimer = setInterval(() => {
            if (this.isEnabled()) {
                this.savePositions();
            }
        }, saveInterval);
        // 提示定时器
        if (tipMode !== 'none') {
            const tipIntervals = {
                'statusbar': 10000,
                '5s': 5000,
                '10s': 10000,
                '1min': 60000
            };
            const tipInterval = tipIntervals[tipMode];
            if (tipInterval) {
                this.tipTimer = setInterval(() => this.showTip(), tipInterval);
                this.logger.info(`Tip timer started with ${tipInterval}ms interval, mode: ${tipMode}`);
            }
        }
        this.logger.info(`Save timer started with ${saveInterval}ms interval`);
    }
    restartTimers() {
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
        }
        if (this.tipTimer) {
            clearInterval(this.tipTimer);
        }
        this.startTimers();
    }
    showTip() {
        const config = vscode.workspace.getConfiguration('cursorPositionSaver');
        const tipMode = config.get('tipMode', 'none');
        if (tipMode === 'statusbar' && this.statusBarItem) {
            // 仅状态栏显示模式
            const messages = [
                '$(sync) 自动保存中',
                '$(shield) 位置已保护',
                '$(bookmark) 正在工作',
                '$(pulse) 持续保护'
            ];
            const randomMessage = messages[Math.floor(Math.random() * messages.length)];
            this.statusBarItem.text = randomMessage;
            // 2秒后恢复原来的文本
            setTimeout(() => {
                if (this.statusBarItem) {
                    this.statusBarItem.text = "$(save) 光标保存";
                }
            }, 2000);
        }
        else if (['5s', '10s', '1min'].includes(tipMode)) {
            // 改进的提示消息，使用不同的图标和样式
            const messages = [
                '$(sync) 光标位置自动保存中...',
                '$(shield) 您的光标位置已安全保存',
                '$(bookmark) 光标保存插件正在工作',
                '$(pulse) 持续保护您的编辑位置'
            ];
            const randomMessage = messages[Math.floor(Math.random() * messages.length)];
            // 使用状态栏消息而不是弹出框，减少干扰
            vscode.window.setStatusBarMessage(randomMessage, 2000);
        }
    }
    isEnabled() {
        const config = vscode.workspace.getConfiguration('cursorPositionSaver');
        return config.get('enabled', true);
    }
    toggle() {
        const config = vscode.workspace.getConfiguration('cursorPositionSaver');
        const currentState = config.get('enabled', true);
        config.update('enabled', !currentState, vscode.ConfigurationTarget.Global);
        const newState = !currentState ? '启用' : '禁用';
        vscode.window.showInformationMessage(`光标位置保存功能已${newState}`);
        this.logger.info(`Plugin ${newState}`);
    }
    saveNow() {
        this.savePositions();
        vscode.window.showInformationMessage('$(save) 光标位置已手动保存');
    }
    toggleTips() {
        const config = vscode.workspace.getConfiguration('cursorPositionSaver');
        const currentMode = config.get('tipMode', 'none');
        const modes = ['none', 'statusbar', '5s', '10s', '1min'];
        const currentIndex = modes.indexOf(currentMode);
        const nextMode = modes[(currentIndex + 1) % modes.length];
        config.update('tipMode', nextMode, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`$(gear) 提示模式已切换到: ${nextMode}`);
        this.restartTimers();
    }
    clearAll() {
        try {
            this.positions = {};
            this.savePositions();
            vscode.window.showInformationMessage('所有光标位置已清除');
            this.logger.info('All cursor positions cleared');
        }
        catch (error) {
            this.logger.error('Failed to clear positions', error);
            vscode.window.showErrorMessage('清除失败');
        }
    }
    showStatus() {
        const config = vscode.workspace.getConfiguration('cursorPositionSaver');
        const enabled = config.get('enabled', true);
        const saveInterval = config.get('saveInterval', 10);
        const tipMode = config.get('tipMode', 'none');
        const saveLocation = config.get('saveLocation', 'c_drive');
        const fileCount = Object.keys(this.positions).length;
        // 转换保存位置显示文本
        const locationText = saveLocation === 'c_drive' ? 'C盘用户目录/mycode' : 'D盘/mycode';
        const message = `状态: ${enabled ? '启用' : '禁用'} | 保存间隔: ${saveInterval}秒 | 已保存文件数: ${fileCount} | 提示模式: ${tipMode} | 保存位置: ${locationText}`;
        vscode.window.showInformationMessage(`插件状态: ${message}`);
        this.logger.info(`Status: ${message}`);
    }
    dispose() {
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
        }
        if (this.tipTimer) {
            clearInterval(this.tipTimer);
        }
        if (this.statusBarItem) {
            this.statusBarItem.dispose();
        }
        this.savePositions();
        this.logger.info('CursorPositionManager disposed');
    }
}
exports.CursorPositionManager = CursorPositionManager;
class Logger {
    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Cursor Position Saver');
    }
    log(level, message, error) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${level}: ${message}`;
        if (error) {
            this.outputChannel.appendLine(`${logMessage} - Error: ${error.message || error}`);
            if (error.stack) {
                this.outputChannel.appendLine(`Stack: ${error.stack}`);
            }
        }
        else {
            this.outputChannel.appendLine(logMessage);
        }
    }
    info(message) {
        this.log('INFO', message);
    }
    warn(message) {
        this.log('WARN', message);
    }
    error(message, error) {
        this.log('ERROR', message, error);
    }
    debug(message) {
        this.log('DEBUG', message);
    }
}
let cursorPositionManager;
function activate(context) {
    try {
        // 创建光标位置管理器
        cursorPositionManager = new CursorPositionManager(context);
        // 注册命令
        context.subscriptions.push(vscode.commands.registerCommand('cursorPositionSaver.toggle', () => {
            cursorPositionManager.toggle();
        }), vscode.commands.registerCommand('cursorPositionSaver.saveNow', () => {
            cursorPositionManager.saveNow();
        }), vscode.commands.registerCommand('cursorPositionSaver.restore', () => {
            cursorPositionManager.restoreActiveEditorCursorPosition();
        }), vscode.commands.registerCommand('cursorPositionSaver.toggleTips', () => {
            cursorPositionManager.toggleTips();
        }), vscode.commands.registerCommand('cursorPositionSaver.clearAll', () => {
            cursorPositionManager.clearAll();
        }), vscode.commands.registerCommand('cursorPositionSaver.showStatus', () => {
            cursorPositionManager.showStatus();
        }));
        console.log('Cursor Position Saver extension is now active');
    }
    catch (error) {
        vscode.window.showErrorMessage('Failed to activate Cursor Position Saver: ' + error.message);
        console.error('Activation error:', error);
    }
}
exports.activate = activate;
function deactivate() {
    if (cursorPositionManager) {
        cursorPositionManager.dispose();
    }
}
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map