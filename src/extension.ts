import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface CursorPosition {
	line: number;
	character: number;
	timestamp: number;
}

interface FilePositions {
	[filePath: string]: CursorPosition;
}

export class CursorPositionManager {
	private context: vscode.ExtensionContext;
	private saveTimer: NodeJS.Timeout | undefined;
	private tipTimer: NodeJS.Timeout | undefined;
	private positions: FilePositions = {};
	private storageDir: string = '';
	private storageFile: string = '';
	private logger: Logger;
	private statusBarItem: vscode.StatusBarItem | undefined;

	constructor(context: vscode.ExtensionContext) {
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

	private initializeStorage(): void {
		try {
			const config = vscode.workspace.getConfiguration('cursorPositionSaver');
			const saveLocation = config.get<string>('saveLocation', 'c_drive');

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

	private initializeStatusBar(): void {
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

	private showStartupMessage(): void {
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

	private loadPositions(): void {
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

	private savePositions(): void {
		try {
			// 检查文件大小，如果超过1MB则清理最早的内容
			let dataStr = JSON.stringify(this.positions, null, 2);
			let dataSize = Buffer.byteLength(dataStr, 'utf8');

			if (dataSize > 1024 * 1024) { // 1MB
				this.trimOldestPositions();
				this.logger.warn('Positions file exceeded 1MB, trimmed oldest entries');
				dataStr = JSON.stringify(this.positions, null, 2);
				dataSize = Buffer.byteLength(dataStr, 'utf8');
			}

			fs.writeFileSync(this.storageFile, dataStr);
			this.logger.debug(`Saved positions to ${this.storageFile} (${dataSize} bytes) for ${Object.keys(this.positions).length} files`);

			// 更新状态栏显示最后保存时间
			if (this.statusBarItem) {
				this.statusBarItem.text = `$(save) 已保存 ${new Date().toLocaleTimeString()}`;
			}
		} catch (error) {
			this.logger.error('Failed to save positions', error);
			vscode.window.showErrorMessage('$(error) 光标位置保存失败');
		}
	}

	private trimOldestPositions(): void {
		// 按时间戳排序，删除最早的文件记录
		const entries = Object.entries(this.positions);

		if (entries.length <= 50) {
			return; // 如果文件数量不多，不进行清理
		}

		// 按时间戳从新到旧排序
		const sortedEntries = entries.sort((a, b) => {
			return b[1].timestamp - a[1].timestamp;
		});

		// 只保留最新的一半文件记录
		const keepCount = Math.floor(entries.length / 2);
		this.positions = {};

		sortedEntries.slice(0, keepCount).forEach(([filePath, position]) => {
			this.positions[filePath] = position;
		});

		this.logger.info(`Trimmed positions: kept ${keepCount} newest files out of ${entries.length} total files`);
	}

	private setupEventListeners(): void {
		// 监听光标位置变化
		vscode.window.onDidChangeTextEditorSelection((event) => {
			if (this.isEnabled()) {
				this.updateCursorPosition(event.textEditor);
			}
		});

		// 监听文件打开 - 恢复光标位置
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

	private handleConfigurationChange(): void {
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

	private updateCursorPosition(editor: vscode.TextEditor): void {
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

	private restoreCursorPosition(editor: vscode.TextEditor): void {
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

	public restoreActiveEditorCursorPosition(): void {
		const editor = vscode.window.activeTextEditor;
		if (editor && this.isEnabled()) {
			this.restoreCursorPosition(editor);
			vscode.window.showInformationMessage('$(location) 光标位置已恢复');
		}
	}

	private startTimers(): void {
		const config = vscode.workspace.getConfiguration('cursorPositionSaver');
		const saveInterval = config.get<number>('saveInterval', 10) * 1000;
		const tipMode = config.get<string>('tipMode', 'none');

		// 保存定时器
		this.saveTimer = setInterval(() => {
			if (this.isEnabled()) {
				this.savePositions();
			}
		}, saveInterval);

		// 提示定时器
		if (tipMode !== 'none') {
			const tipIntervals: { [key: string]: number } = {
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

	private restartTimers(): void {
		if (this.saveTimer) {
			clearInterval(this.saveTimer);
		}
		if (this.tipTimer) {
			clearInterval(this.tipTimer);
		}
		this.startTimers();
	}

	private showTip(): void {
		const config = vscode.workspace.getConfiguration('cursorPositionSaver');
		const tipMode = config.get('tipMode', 'none') as string;

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

	private isEnabled(): boolean {
		const config = vscode.workspace.getConfiguration('cursorPositionSaver');
		return config.get<boolean>('enabled', true);
	}

	public toggle(): void {
		const config = vscode.workspace.getConfiguration('cursorPositionSaver');
		const currentState = config.get<boolean>('enabled', true);
		config.update('enabled', !currentState, vscode.ConfigurationTarget.Global);

		const newState = !currentState ? '启用' : '禁用';
		vscode.window.showInformationMessage(`光标位置保存功能已${newState}`);
		this.logger.info(`Plugin ${newState}`);
	}

	public saveNow(): void {
		this.savePositions();
		vscode.window.showInformationMessage('$(save) 光标位置已手动保存');
	}

	public toggleTips(): void {
		const config = vscode.workspace.getConfiguration('cursorPositionSaver');
		const currentMode = config.get('tipMode', 'none');
		const modes = ['none', 'statusbar', '5s', '10s', '1min'];
		const currentIndex = modes.indexOf(currentMode);
		const nextMode = modes[(currentIndex + 1) % modes.length];

		config.update('tipMode', nextMode, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`$(gear) 提示模式已切换到: ${nextMode}`);
		this.restartTimers();
	}

	public clearAll(): void {
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

	public showStatus(): void {
		const config = vscode.workspace.getConfiguration('cursorPositionSaver');
		const enabled = config.get<boolean>('enabled', true);
		const saveInterval = config.get<number>('saveInterval', 10);
		const tipMode = config.get<string>('tipMode', 'none');
		const saveLocation = config.get<string>('saveLocation', 'c_drive');
		const totalFiles = Object.keys(this.positions).length;

		// 获取当前打开的文件数量
		const openFilePaths = new Set<string>();
		vscode.window.tabGroups.all.forEach(group => {
			group.tabs.forEach(tab => {
				if (tab.input && (tab.input as any).uri) {
					const uri = (tab.input as any).uri as vscode.Uri;
					if (uri.scheme === 'file') {
						openFilePaths.add(uri.fsPath);
					}
				}
			});
		});

		const openFiles = Array.from(openFilePaths).filter(path => this.positions[path]).length;

		// 计算文件大小
		let fileSize = '0 KB';
		try {
			if (fs.existsSync(this.storageFile)) {
				const stats = fs.statSync(this.storageFile);
				const sizeInKB = Math.round(stats.size / 1024);
				fileSize = sizeInKB >= 1024 ? `${Math.round(sizeInKB / 1024 * 10) / 10} MB` : `${sizeInKB} KB`;
			}
		} catch (error) {
			this.logger.error('Failed to get file size', error);
		}

		// 转换保存位置显示文本
		const locationText = saveLocation === 'c_drive' ? 'C盘用户目录/mycode' : 'D盘/mycode';

		const message = `状态: ${enabled ? '启用' : '禁用'} | 保存间隔: ${saveInterval}秒 | 总文件数: ${totalFiles} | 当前打开: ${openFiles} | 文件大小: ${fileSize} | 提示模式: ${tipMode} | 保存位置: ${locationText}`;
		vscode.window.showInformationMessage(`插件状态: ${message}`);
		this.logger.info(`Status: ${message}`);
	}

	public dispose(): void {
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
	private outputChannel: vscode.OutputChannel;

	constructor() {
		this.outputChannel = vscode.window.createOutputChannel('Cursor Position Saver');
	}

	private log(level: string, message: string, error?: any): void {
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

	public info(message: string): void {
		this.log('INFO', message);
	}

	public warn(message: string): void {
		this.log('WARN', message);
	}

	public error(message: string, error?: any): void {
		this.log('ERROR', message, error);
	}

	public debug(message: string): void {
		this.log('DEBUG', message);
	}
}

let cursorPositionManager: CursorPositionManager;

export function activate(context: vscode.ExtensionContext) {
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
		vscode.window.showErrorMessage('Failed to activate Cursor Position Saver: ' + (error as Error).message);
		console.error('Activation error:', error);
	}
}

export function deactivate() {
	if (cursorPositionManager) {
		cursorPositionManager.dispose();
	}
}