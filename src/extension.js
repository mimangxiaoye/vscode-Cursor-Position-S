const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

class CursorPositionManager {
    constructor(context) {
        this.saveTimer = undefined;
        this.tipTimer = undefined;
        this.positions = {};
        this.storageDir = '';
        this.storageFile = '';
        this.lastNotificationTime = 0;
        this.statusBarItem = undefined;

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
            } else {
                this.storageDir = path.join(os.homedir(), 'mycode');
            }

            this.storageFile = path.join(this.storageDir, 'cursor-positions.json');

            // 创建目录
            if (!fs.existsSync(this.storageDir)) {
                fs.mkdirSync(this.storageDir, { recursive: true });
                this.logger.info(`Created storage directory: ${this.storageDir}`);
            }

            this.logger.info(`Storage initialized at: ${this.storageFile}`);
        } catch (error) {
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
        } catch (error) {
            this.logger.error('Failed to load positions', error);
            this.positions = {};
        }
    }

    savePositions() {
        try {
            // 确保文件大小不超过1MB
            const dataStr = JSON.stringify(this.positions, null, 2);
            const dataSize = Buffer.byteLength(dataStr, 'utf8');

            if (dataSize > 1024 * 1024) { // 1MB
                this.trimPositions();
                this.logger.warn('Positions file exceeded 1MB, trimmed old entries');
            }

            fs.writeFileSync(this.storageFile, JSON.stringify(this.positions, null, 2));
            this.logger.debug(`Saved positions to ${this.storageFile} (${dataSize} bytes)`);

            // 更新状态栏显示最后保存时间
            if (this.statusBarItem) {
                this.statusBarItem.text = `$(save) 已保存 ${new Date().toLocaleTimeString()}`;
            }
        } catch (error) {
            this.logger.error('Failed to save positions', error);
            vscode.window.showErrorMessage('$(error) 光标位置保存失败');
        }
    }

    trimPositions() {
        const config = vscode.workspace.getConfiguration('cursorPositionSaver');
        const maxFiles = config.get('maxFilesPerDocument', 10);

        // 按时间戳排序，保留最新的记录
        for (const filePath in this.positions) {
            if (this.positions[filePath].length > maxFiles) {
                this.positions[filePath] = this.positions[filePath]
                    .sort((a, b) => b.timestamp - a.timestamp)
                    .slice(0, maxFiles);
            }
        }

        // 如果仍然太大，删除最老的文件记录
        const entries = Object.entries(this.positions);
        if (entries.length > 100) {
            const sortedEntries = entries.sort((a, b) => {
                const latestA = Math.max(...a[1].map(p => p.timestamp));
                const latestB = Math.max(...b[1].map(p => p.timestamp));
                return latestB - latestA;
            });

            this.positions = {};
            sortedEntries.slice(0, 50).forEach(([filePath, positions]) => {
                this.positions[filePath] = positions;
            });
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
        } catch (error) {
            this.logger.error('Failed to handle configuration change', error);
        }
    }

    updateCursorPosition(editor) {
        if (!editor.document.uri.fsPath) {
            return;
        }

        const filePath = editor.document.uri.fsPath;
        const position = editor.selection.active;

        if (!this.positions[filePath]) {
            this.positions[filePath] = [];
        }

        const newPosition = {
            line: position.line,
            character: position.character,
            timestamp: Date.now()
        };

        // 添加新位置
        this.positions[filePath].unshift(newPosition);

        // 限制保存数量
        const config = vscode.workspace.getConfiguration('cursorPositionSaver');
        const maxFiles = config.get('maxFilesPerDocument', 10);

        if (this.positions[filePath].length > maxFiles) {
            this.positions[filePath] = this.positions[filePath].slice(0, maxFiles);
        }

        this.logger.debug(`Updated cursor position for ${filePath}: line ${position.line}, char ${position.character}`);
    }

    restoreCursorPosition(editor) {
        if (!editor.document.uri.fsPath) {
            return;
        }

        const filePath = editor.document.uri.fsPath;
        const savedPositions = this.positions[filePath];

        if (savedPositions && savedPositions.length > 0) {
            const lastPosition = savedPositions[0];
            const position = new vscode.Position(lastPosition.line, lastPosition.character);

            // 确保位置在文档范围内
            if (position.line < editor.document.lineCount) {
                const selection = new vscode.Selection(position, position);
                editor.selection = selection;
                editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);

                this.logger.info(`Restored cursor position for ${filePath}: line ${lastPosition.line}, char ${lastPosition.character}`);
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
                'statusbar': 10000, // statusbar 模式每10秒更新一次
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
        } else if (['5s', '10s', '1min'].includes(tipMode)) {
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
        } catch (error) {
            this.logger.error('Failed to clear positions', error);
            vscode.window.showErrorMessage('清除失败');
        }
    }

    showStatus() {
        const config = vscode.workspace.getConfiguration('cursorPositionSaver');
        const enabled = config.get('enabled', true);
        const saveInterval = config.get('saveInterval', 10);
        const maxFiles = config.get('maxFilesPerDocument', 10);
        const tipMode = config.get('tipMode', 'none');
        const saveLocation = config.get('saveLocation', 'c_drive');
        const fileCount = Object.keys(this.positions).length;

        // 转换保存位置显示文本
        const locationText = saveLocation === 'c_drive' ? 'C盘用户目录/mycode' : 'D盘/mycode';

        const message = `状态: ${enabled ? '启用' : '禁用'} | 保存间隔: ${saveInterval}秒 | 文件数: ${fileCount} | 最大保存数: ${maxFiles} | 提示模式: ${tipMode} | 保存位置: ${locationText}`;
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
        } else {
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
        context.subscriptions.push(
            vscode.commands.registerCommand('cursorPositionSaver.toggle', () => {
                cursorPositionManager.toggle();
            }),
            vscode.commands.registerCommand('cursorPositionSaver.saveNow', () => {
                cursorPositionManager.saveNow();
            }),
            vscode.commands.registerCommand('cursorPositionSaver.restore', () => {
                cursorPositionManager.restoreActiveEditorCursorPosition();
            }),
            vscode.commands.registerCommand('cursorPositionSaver.toggleTips', () => {
                cursorPositionManager.toggleTips();
            }),
            vscode.commands.registerCommand('cursorPositionSaver.clearAll', () => {
                cursorPositionManager.clearAll();
            }),
            vscode.commands.registerCommand('cursorPositionSaver.showStatus', () => {
                cursorPositionManager.showStatus();
            })
        );

        console.log('Cursor Position Saver extension is now active');
    } catch (error) {
        vscode.window.showErrorMessage('Failed to activate Cursor Position Saver: ' + error.message);
        console.error('Activation error:', error);
    }
}

function deactivate() {
    if (cursorPositionManager) {
        cursorPositionManager.dispose();
    }
}

module.exports = {
    activate,
    deactivate
};