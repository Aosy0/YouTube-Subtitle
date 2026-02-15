// ==UserScript==
// @name         YouTube Subtitle Enhancer
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  YouTube字幕を改善：文単位表示、カスタマイズ可能なスタイル、日本語字幕優先、自動翻訳対応
// @author       You
// @match        https://www.youtube.com/*
// @match        https://youtube.com/*
// @match        https://youtu.be/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ============================================
    // YouTube Subtitle Enhancer - メインエントリーポイント
    // ============================================

    const CONFIG = {
        DEBUG: false,
        VERSION: '1.0.0',
        DEFAULT_SETTINGS: {
            // 字幕優先順位
            preferredLanguage: 'ja',
            fallbackLanguage: 'en',
            autoTranslateIfNotAvailable: true,
            
            // 表示設定
            sentenceMode: true,           // 文単位表示
            fontFamily: '"Noto Sans JP", "Yu Gothic", "Meiryo", sans-serif',
            fontSize: 24,
            fontColor: '#ffffff',
            backgroundColor: 'rgba(0, 0, 0, 0.75)',
            backgroundBlur: true,
            textShadow: '2px 2px 4px rgba(0, 0, 0, 0.8)',
            
            // レイアウト設定
            position: 'bottom',           // bottom, top, custom
            customPositionY: 10,          // 下端からの距離(%)
            maxLines: 2,
            lineHeight: 1.4,
            letterSpacing: 0.5,
            
            // 動作設定
            enableOnLoad: true,
            hideOriginal: false,          // 元の字幕を非表示にする
        }
    };

    // ============================================
    // ロガーモジュール
    // ============================================
    const Logger = {
        levels: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
        currentLevel: 1,

        setLevel(level) {
            this.currentLevel = level;
        },

        log(level, message, ...args) {
            if (level >= this.currentLevel) {
                const prefix = `[YSE-${CONFIG.VERSION}]`;
                const levelName = Object.keys(this.levels).find(k => this.levels[k] === level);
                console.log(`${prefix} [${levelName}] ${message}`, ...args);
            }
        },

        debug(message, ...args) { this.log(this.levels.DEBUG, message, ...args); },
        info(message, ...args) { this.log(this.levels.INFO, message, ...args); },
        warn(message, ...args) { this.log(this.levels.WARN, message, ...args); },
        error(message, ...args) { this.log(this.levels.ERROR, message, ...args); }
    };

    // ============================================
    // 設定管理モジュール
    // ============================================
    const Settings = {
        data: {},

        init() {
            this.load();
            Logger.info('設定を初期化しました');
        },

        load() {
            try {
                const stored = GM_getValue('yse_settings', null);
                this.data = stored ? JSON.parse(stored) : { ...CONFIG.DEFAULT_SETTINGS };
                // 新しい設定項目が追加された場合のマージ
                this.data = { ...CONFIG.DEFAULT_SETTINGS, ...this.data };
            } catch (e) {
                Logger.error('設定の読み込みに失敗しました:', e);
                this.data = { ...CONFIG.DEFAULT_SETTINGS };
            }
        },

        save() {
            try {
                GM_setValue('yse_settings', JSON.stringify(this.data));
                Logger.debug('設定を保存しました');
            } catch (e) {
                Logger.error('設定の保存に失敗しました:', e);
            }
        },

        get(key) {
            return this.data[key];
        },

        set(key, value) {
            this.data[key] = value;
            this.save();
            Logger.debug(`設定を更新: ${key} = ${value}`);
        },

        reset() {
            this.data = { ...CONFIG.DEFAULT_SETTINGS };
            this.save();
            Logger.info('設定をデフォルトにリセットしました');
        },

        export() {
            return JSON.stringify(this.data, null, 2);
        },

        import(jsonString) {
            try {
                const imported = JSON.parse(jsonString);
                this.data = { ...CONFIG.DEFAULT_SETTINGS, ...imported };
                this.save();
                Logger.info('設定をインポートしました');
                return true;
            } catch (e) {
                Logger.error('設定のインポートに失敗しました:', e);
                return false;
            }
        }
    };

    // ============================================
    // YouTubeプレーヤー制御モジュール
    // ============================================
    const PlayerController = {
        player: null,
        observers: [],

        init() {
            this.waitForPlayer();
            Logger.info('プレーヤーコントローラーを初期化しました');
        },

        waitForPlayer() {
            const checkInterval = setInterval(() => {
                const video = document.querySelector('video');
                const player = document.querySelector('#movie_player');
                
                if (video && player) {
                    clearInterval(checkInterval);
                    this.player = player;
                    this.video = video;
                    this.onPlayerReady();
                }
            }, 500);
        },

        onPlayerReady() {
            Logger.info('プレーヤーが準備完了しました');
            SubtitleEnhancer.init();
            this.setupVideoChangeListener();
        },

        setupVideoChangeListener() {
            // URL変更検知（YouTubeはSPAなので）
            let lastUrl = location.href;
            new MutationObserver(() => {
                const url = location.href;
                if (url !== lastUrl) {
                    lastUrl = url;
                    Logger.debug('ページ遷移を検知しました');
                    setTimeout(() => this.waitForPlayer(), 1000);
                }
            }).observe(document, { subtree: true, childList: true });
        },

        // YouTubeプレーヤー内部の設定にアクセス
        getPlayerConfig() {
            try {
                return yt.player.Application.create(null, {});
            } catch (e) {
                return null;
            }
        },

        // 字幕トラック情報を取得
        getSubtitleTracks() {
            try {
                const player = this.player;
                if (!player) return [];
                
                // YouTubeプレーヤーの内部APIにアクセス
                const playerResponse = player.getPlayerResponse?.() || 
                                       ytInitialPlayerResponse || 
                                       ytplayer?.config?.args?.player_response;
                
                if (playerResponse && playerResponse.captions) {
                    return playerResponse.captions.captionTracks || [];
                }
                return [];
            } catch (e) {
                Logger.error('字幕トラック取得エラー:', e);
                return [];
            }
        },

        // 字幕を有効化/無効化
        setSubtitlesEnabled(enabled) {
            try {
                const player = this.player;
                if (player && player.setOption) {
                    player.setOption('captions', 'track', enabled ? {} : {'languageCode': ''});
                }
            } catch (e) {
                Logger.error('字幕設定エラー:', e);
            }
        },

        // 字幕言語を設定
        setSubtitleLanguage(langCode) {
            try {
                const player = this.player;
                if (player && player.setOption) {
                    player.setOption('captions', 'track', {
                        'languageCode': langCode
                    });
                    Logger.info(`字幕言語を設定: ${langCode}`);
                }
            } catch (e) {
                Logger.error('字幕言語設定エラー:', e);
            }
        },

        // 自動翻訳を設定
        setAutoTranslation(targetLang) {
            try {
                const player = this.player;
                if (player && player.setOption) {
                    // 自動翻訳を有効化
                    player.setOption('captions', 'track', {
                        'languageCode': targetLang,
                        'translationLanguage': { 'languageCode': targetLang }
                    });
                    Logger.info(`自動翻訳を設定: ${targetLang}`);
                }
            } catch (e) {
                Logger.error('自動翻訳設定エラー:', e);
            }
        },

        // 最適な字幕を自動選択
        autoSelectSubtitle() {
            const tracks = this.getSubtitleTracks();
            const preferredLang = Settings.get('preferredLanguage');
            const fallbackLang = Settings.get('fallbackLanguage');
            const autoTranslate = Settings.get('autoTranslateIfNotAvailable');

            Logger.debug('利用可能な字幕トラック:', tracks.map(t => t.languageCode));

            // 1. 優先言語の字幕を探す
            const preferredTrack = tracks.find(t => 
                t.languageCode === preferredLang || 
                t.languageCode.startsWith(preferredLang)
            );

            if (preferredTrack) {
                this.setSubtitleLanguage(preferredTrack.languageCode);
                Logger.info(`優先言語の字幕を選択: ${preferredTrack.languageCode}`);
                return;
            }

            // 2. フォールバック言語の字幕を探す
            const fallbackTrack = tracks.find(t => 
                t.languageCode === fallbackLang || 
                t.languageCode.startsWith(fallbackLang)
            );

            if (fallbackTrack) {
                // 自動翻訳が有効な場合
                if (autoTranslate) {
                    this.setAutoTranslation(preferredLang);
                    Logger.info(`フォールバック字幕から自動翻訳: ${fallbackTrack.languageCode} → ${preferredLang}`);
                } else {
                    this.setSubtitleLanguage(fallbackTrack.languageCode);
                    Logger.info(`フォールバック言語の字幕を選択: ${fallbackTrack.languageCode}`);
                }
                return;
            }

            // 3. 任意の字幕から自動翻訳
            if (autoTranslate && tracks.length > 0) {
                const firstTrack = tracks[0];
                this.setAutoTranslation(preferredLang);
                Logger.info(`字幕を自動翻訳: ${firstTrack.languageCode} → ${preferredLang}`);
                return;
            }

            Logger.warn('利用可能な字幕が見つかりませんでした');
        }
    };

    // ============================================
    // 字幕表示改善モジュール
    // ============================================
    const SubtitleEnhancer = {
        captionContainer: null,
        styleElement: null,
        observer: null,
        sentenceBuffer: [],
        currentSentence: '',
        lastEndTime: 0,

        init() {
            this.injectStyles();
            this.waitForCaptions();
            Logger.info('字幕エンハンサーを初期化しました');
        },

        injectStyles() {
            const styles = `
                /* カスタム字幕スタイル */
                .yse-caption-window {
                    position: absolute !important;
                    left: 50% !important;
                    transform: translateX(-50%) !important;
                    text-align: center !important;
                    pointer-events: none !important;
                    z-index: 1000 !important;
                }
                
                .yse-caption-text {
                    display: inline-block !important;
                    padding: 8px 16px !important;
                    border-radius: 8px !important;
                    white-space: pre-wrap !important;
                    word-wrap: break-word !important;
                    line-height: ${Settings.get('lineHeight')} !important;
                    letter-spacing: ${Settings.get('letterSpacing')}px !important;
                }

                /* 元の字幕を非表示（設定による） */
                .yse-hide-original .caption-window {
                    display: none !important;
                }

                /* 文単位表示用のスタイル */
                .yse-sentence-mode .yse-caption-text {
                    animation: yse-fade-in 0.3s ease-in-out;
                }

                @keyframes yse-fade-in {
                    from { opacity: 0; transform: translateY(5px); }
                    to { opacity: 1; transform: translateY(0); }
                }

                /* 設定パネル用スタイル */
                .yse-settings-panel {
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    background: #1f1f1f;
                    border: 1px solid #444;
                    border-radius: 12px;
                    padding: 24px;
                    z-index: 10000;
                    color: #fff;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                    min-width: 400px;
                    max-height: 80vh;
                    overflow-y: auto;
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
                }

                .yse-settings-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 20px;
                    padding-bottom: 16px;
                    border-bottom: 1px solid #444;
                }

                .yse-settings-title {
                    font-size: 18px;
                    font-weight: 600;
                    margin: 0;
                }

                .yse-settings-close {
                    background: none;
                    border: none;
                    color: #aaa;
                    font-size: 24px;
                    cursor: pointer;
                    padding: 0;
                    width: 32px;
                    height: 32px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 50%;
                    transition: all 0.2s;
                }

                .yse-settings-close:hover {
                    background: rgba(255, 255, 255, 0.1);
                    color: #fff;
                }

                .yse-setting-group {
                    margin-bottom: 20px;
                }

                .yse-setting-label {
                    display: block;
                    font-size: 14px;
                    color: #aaa;
                    margin-bottom: 8px;
                }

                .yse-setting-input {
                    width: 100%;
                    padding: 8px 12px;
                    background: #2a2a2a;
                    border: 1px solid #444;
                    border-radius: 6px;
                    color: #fff;
                    font-size: 14px;
                    box-sizing: border-box;
                }

                .yse-setting-input:focus {
                    outline: none;
                    border-color: #3ea6ff;
                }

                .yse-setting-checkbox {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    cursor: pointer;
                }

                .yse-setting-checkbox input {
                    width: 18px;
                    height: 18px;
                    accent-color: #3ea6ff;
                }

                .yse-settings-buttons {
                    display: flex;
                    gap: 12px;
                    margin-top: 24px;
                    padding-top: 20px;
                    border-top: 1px solid #444;
                }

                .yse-btn {
                    flex: 1;
                    padding: 10px 16px;
                    border: none;
                    border-radius: 6px;
                    font-size: 14px;
                    font-weight: 500;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .yse-btn-primary {
                    background: #3ea6ff;
                    color: #000;
                }

                .yse-btn-primary:hover {
                    background: #65b8ff;
                }

                .yse-btn-secondary {
                    background: #2a2a2a;
                    color: #fff;
                    border: 1px solid #444;
                }

                .yse-btn-secondary:hover {
                    background: #3a3a3a;
                }

                .yse-debug-info {
                    margin-top: 20px;
                    padding: 12px;
                    background: #2a2a2a;
                    border-radius: 6px;
                    font-family: monospace;
                    font-size: 12px;
                    color: #888;
                }
            `;

            GM_addStyle(styles);
            Logger.debug('スタイルを注入しました');
        },

        waitForCaptions() {
            // 字幕コンテナの監視
            const checkInterval = setInterval(() => {
                const captionWindow = document.querySelector('.caption-window');
                if (captionWindow) {
                    clearInterval(checkInterval);
                    this.setupCaptionObserver(captionWindow);
                }
            }, 500);
        },

        setupCaptionObserver(captionWindow) {
            // 字幕テキストの変更を監視
            this.observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.type === 'childList' || mutation.type === 'characterData') {
                        this.processCaptionText(captionWindow);
                    }
                });
            });

            this.observer.observe(captionWindow, {
                childList: true,
                subtree: true,
                characterData: true
            });

            Logger.info('字幕監視を開始しました');
            
            // 初期処理
            this.processCaptionText(captionWindow);
            
            // 自動字幕選択を実行
            if (Settings.get('enableOnLoad')) {
                setTimeout(() => {
                    PlayerController.autoSelectSubtitle();
                }, 1500);
            }
        },

        processCaptionText(captionWindow) {
            if (!Settings.get('sentenceMode')) return;

            const captionText = captionWindow.querySelector('.captions-text');
            if (!captionText) return;

            // 文字単位のspanを文単位に再構築
            const textNodes = captionText.querySelectorAll('span');
            if (textNodes.length === 0) return;

            let fullText = '';
            textNodes.forEach(node => {
                fullText += node.textContent;
            });

            // 文の区切りを判定（。、！、？、.、!、?）
            const sentenceEndRegex = /[。！？.!?]+/;
            
            if (sentenceEndRegex.test(fullText)) {
                // 文が完了している場合
                this.currentSentence += fullText;
                this.displaySentence(this.currentSentence.trim());
                this.currentSentence = '';
            } else {
                // 文が続いている場合
                this.currentSentence += fullText;
            }
        },

        displaySentence(text) {
            const captionWindow = document.querySelector('.caption-window');
            if (!captionWindow) return;

            const captionText = captionWindow.querySelector('.captions-text');
            if (!captionText) return;

            // スタイルを適用
            this.applyCustomStyles(captionWindow, captionText);

            // デバッグ情報
            Logger.debug('表示文:', text);
        },

        applyCustomStyles(windowEl, textEl) {
            if (!windowEl || !textEl) return;

            const fontSize = Settings.get('fontSize');
            const fontColor = Settings.get('fontColor');
            const bgColor = Settings.get('backgroundColor');
            const fontFamily = Settings.get('fontFamily');
            const textShadow = Settings.get('textShadow');
            const position = Settings.get('position');
            const customY = Settings.get('customPositionY');
            const maxLines = Settings.get('maxLines');

            // ウィンドウスタイル
            windowEl.classList.add('yse-caption-window');
            
            if (position === 'top') {
                windowEl.style.top = '5%';
                windowEl.style.bottom = 'auto';
            } else if (position === 'custom') {
                windowEl.style.bottom = `${customY}%`;
            } else {
                windowEl.style.bottom = '5%';
                windowEl.style.top = 'auto';
            }

            // テキストスタイル
            textEl.classList.add('yse-caption-text');
            textEl.style.cssText = `
                font-family: ${fontFamily} !important;
                font-size: ${fontSize}px !important;
                color: ${fontColor} !important;
                background: ${bgColor} !important;
                text-shadow: ${textShadow} !important;
                -webkit-line-clamp: ${maxLines} !important;
                display: -webkit-box !important;
                -webkit-box-orient: vertical !important;
                overflow: hidden !important;
            `;
        },

        updateStyles() {
            const captionWindow = document.querySelector('.caption-window');
            const captionText = document.querySelector('.captions-text');
            this.applyCustomStyles(captionWindow, captionText);
        }
    };

    // ============================================
    // UI制御モジュール（設定パネル）
    // ============================================
    const UIController = {
        panel: null,
        isOpen: false,

        init() {
            this.setupMenuCommands();
            this.setupKeyboardShortcuts();
            Logger.info('UIコントローラーを初期化しました');
        },

        setupMenuCommands() {
            GM_registerMenuCommand('⚙️ 設定を開く', () => this.openSettings());
            GM_registerMenuCommand('🔄 字幕を自動選択', () => {
                PlayerController.autoSelectSubtitle();
            });
            GM_registerMenuCommand('📝 設定をエクスポート', () => {
                const settings = Settings.export();
                navigator.clipboard.writeText(settings);
                alert('設定をクリップボードにコピーしました！');
            });
            GM_registerMenuCommand('📥 設定をインポート', () => {
                const json = prompt('設定JSONを貼り付けてください:');
                if (json && Settings.import(json)) {
                    SubtitleEnhancer.updateStyles();
                    alert('設定をインポートしました！');
                }
            });
            GM_registerMenuCommand('♻️ 設定をリセット', () => {
                if (confirm('すべての設定をデフォルトに戻しますか？')) {
                    Settings.reset();
                    SubtitleEnhancer.updateStyles();
                    alert('設定をリセットしました！');
                }
            });
        },

        setupKeyboardShortcuts() {
            document.addEventListener('keydown', (e) => {
                // Alt + S で設定パネルを開く
                if (e.altKey && e.key === 's') {
                    e.preventDefault();
                    this.toggleSettings();
                }
            });
        },

        toggleSettings() {
            if (this.isOpen) {
                this.closeSettings();
            } else {
                this.openSettings();
            }
        },

        openSettings() {
            if (this.panel) return;

            this.panel = document.createElement('div');
            this.panel.className = 'yse-settings-panel';
            this.panel.innerHTML = this.generateSettingsHTML();
            
            document.body.appendChild(this.panel);
            this.isOpen = true;

            this.attachEventListeners();
            Logger.debug('設定パネルを開きました');
        },

        closeSettings() {
            if (this.panel) {
                this.panel.remove();
                this.panel = null;
                this.isOpen = false;
                Logger.debug('設定パネルを閉じました');
            }
        },

        generateSettingsHTML() {
            return `
                <div class="yse-settings-header">
                    <h2 class="yse-settings-title">YouTube Subtitle Enhancer 設定</h2>
                    <button class="yse-settings-close">&times;</button>
                </div>

                <div class="yse-setting-group">
                    <label class="yse-setting-label">優先言語 (ISO 639-1)</label>
                    <input type="text" class="yse-setting-input" data-key="preferredLanguage" 
                           value="${Settings.get('preferredLanguage')}">
                </div>

                <div class="yse-setting-group">
                    <label class="yse-setting-label">フォールバック言語</label>
                    <input type="text" class="yse-setting-input" data-key="fallbackLanguage" 
                           value="${Settings.get('fallbackLanguage')}">
                </div>

                <div class="yse-setting-group">
                    <label class="yse-setting-checkbox">
                        <input type="checkbox" data-key="autoTranslateIfNotAvailable" 
                               ${Settings.get('autoTranslateIfNotAvailable') ? 'checked' : ''}>
                        <span>字幕がない場合は自動翻訳を使用</span>
                    </label>
                </div>

                <div class="yse-setting-group">
                    <label class="yse-setting-checkbox">
                        <input type="checkbox" data-key="sentenceMode" 
                               ${Settings.get('sentenceMode') ? 'checked' : ''}>
                        <span>文単位で表示（自動生成字幕を改善）</span>
                    </label>
                </div>

                <div class="yse-setting-group">
                    <label class="yse-setting-label">フォントサイズ (px)</label>
                    <input type="number" class="yse-setting-input" data-key="fontSize" 
                           value="${Settings.get('fontSize')}" min="10" max="72">
                </div>

                <div class="yse-setting-group">
                    <label class="yse-setting-label">フォントファミリー</label>
                    <input type="text" class="yse-setting-input" data-key="fontFamily" 
                           value="${Settings.get('fontFamily')}">
                </div>

                <div class="yse-setting-group">
                    <label class="yse-setting-label">フォントカラー</label>
                    <input type="color" class="yse-setting-input" data-key="fontColor" 
                           value="${Settings.get('fontColor')}">
                </div>

                <div class="yse-setting-group">
                    <label class="yse-setting-label">背景色 (RGBA)</label>
                    <input type="text" class="yse-setting-input" data-key="backgroundColor" 
                           value="${Settings.get('backgroundColor')}">
                </div>

                <div class="yse-setting-group">
                    <label class="yse-setting-label">字幕位置</label>
                    <select class="yse-setting-input" data-key="position">
                        <option value="bottom" ${Settings.get('position') === 'bottom' ? 'selected' : ''}>下部</option>
                        <option value="top" ${Settings.get('position') === 'top' ? 'selected' : ''}>上部</option>
                        <option value="custom" ${Settings.get('position') === 'custom' ? 'selected' : ''}>カスタム</option>
                    </select>
                </div>

                <div class="yse-setting-group">
                    <label class="yse-setting-label">最大行数</label>
                    <input type="number" class="yse-setting-input" data-key="maxLines" 
                           value="${Settings.get('maxLines')}" min="1" max="5">
                </div>

                <div class="yse-settings-buttons">
                    <button class="yse-btn yse-btn-primary" id="yse-save">保存して閉じる</button>
                    <button class="yse-btn yse-btn-secondary" id="yse-cancel">キャンセル</button>
                </div>

                <div class="yse-debug-info">
                    Version: ${CONFIG.VERSION}<br>
                    Debug Mode: ${CONFIG.DEBUG}<br>
                    Shortcut: Alt + S
                </div>
            `;
        },

        attachEventListeners() {
            // 閉じるボタン
            this.panel.querySelector('.yse-settings-close').addEventListener('click', () => {
                this.closeSettings();
            });

            // 保存ボタン
            this.panel.querySelector('#yse-save').addEventListener('click', () => {
                this.saveSettings();
                this.closeSettings();
            });

            // キャンセルボタン
            this.panel.querySelector('#yse-cancel').addEventListener('click', () => {
                this.closeSettings();
            });

            // 入力フィールドのリアルタイム更新
            this.panel.querySelectorAll('.yse-setting-input, .yse-setting-checkbox input').forEach(input => {
                input.addEventListener('change', (e) => {
                    const key = e.target.dataset.key;
                    let value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
                    
                    // 数値型の変換
                    if (e.target.type === 'number') {
                        value = parseInt(value, 10);
                    }
                    
                    Settings.set(key, value);
                    SubtitleEnhancer.updateStyles();
                });
            });
        },

        saveSettings() {
            // 設定は既にリアルタイムで保存されている
            Logger.info('設定を保存しました');
        }
    };

    // ============================================
    // 初期化
    // ============================================
    function init() {
        Logger.info('YouTube Subtitle Enhancer を起動しています...');
        
        Settings.init();
        UIController.init();
        PlayerController.init();

        // デバッグモードが有効な場合
        if (CONFIG.DEBUG) {
            Logger.setLevel(Logger.levels.DEBUG);
            Logger.debug('デバッグモードが有効です');
        }
    }

    // スクリプト起動
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
