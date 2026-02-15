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
                    background: rgba(28, 28, 28, 0.98);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 16px;
                    padding: 24px;
                    z-index: 10000;
                    color: #fff;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                    min-width: 420px;
                    max-width: 90vw;
                    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(255, 255, 255, 0.05);
                    backdrop-filter: blur(20px);
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
                    background: rgba(42, 42, 42, 0.8);
                    border-radius: 8px;
                    font-family: monospace;
                    font-size: 11px;
                    color: #666;
                    text-align: center;
                }

                /* カスタムスクロールバー */
                .yse-settings-panel ::-webkit-scrollbar {
                    width: 8px;
                }

                .yse-settings-panel ::-webkit-scrollbar-track {
                    background: rgba(255, 255, 255, 0.05);
                    border-radius: 4px;
                }

                .yse-settings-panel ::-webkit-scrollbar-thumb {
                    background: rgba(255, 255, 255, 0.2);
                    border-radius: 4px;
                }

                .yse-settings-panel ::-webkit-scrollbar-thumb:hover {
                    background: rgba(255, 255, 255, 0.3);
                }

                /* デバッグインジケーター */
                .yse-debug-indicator {
                    position: fixed;
                    bottom: 10px;
                    right: 10px;
                    background: rgba(0, 0, 0, 0.8);
                    color: #3ea6ff;
                    padding: 8px 12px;
                    border-radius: 4px;
                    font-size: 12px;
                    font-family: monospace;
                    z-index: 9999;
                    border: 1px solid #3ea6ff;
                    cursor: pointer;
                    opacity: 0.7;
                    transition: opacity 0.2s;
                }

                .yse-debug-indicator:hover {
                    opacity: 1;
                }

                .yse-debug-indicator.hidden {
                    display: none;
                }

                /* YouTube設定メニュー統合スタイル */
                .yse-settings-menu-item {
                    transition: background-color 0.2s;
                }

                .yse-settings-menu-item:hover {
                    background-color: rgba(255, 255, 255, 0.1);
                }

                .yse-settings-status {
                    color: #aaa;
                    font-size: 11px;
                }

                .yse-settings-submenu {
                    display: none;
                    position: absolute;
                    background: rgba(28, 28, 28, 0.9);
                    border-radius: 4px;
                    padding: 8px 0;
                    min-width: 200px;
                    z-index: 10001;
                }

                .yse-settings-submenu.visible {
                    display: block;
                }

                .yse-submenu-item {
                    padding: 8px 16px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    color: #eee;
                    font-size: 13px;
                }

                .yse-submenu-item:hover {
                    background-color: rgba(255, 255, 255, 0.1);
                }

                .yse-submenu-item input[type="checkbox"] {
                    width: 16px;
                    height: 16px;
                }

                .yse-submenu-item input[type="range"] {
                    flex: 1;
                    margin-left: 8px;
                }

                .yse-submenu-value {
                    color: #aaa;
                    font-size: 12px;
                    margin-left: auto;
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
    // YouTube設定メニュー統合モジュール
    // ============================================
    const YouTubeSettingsIntegration = {
        settingsMenuObserver: null,
        isSettingsMenuOpen: false,
        menuCheckInterval: null,

        init() {
            this.observeSettingsMenu();
            this.startMenuCheckInterval();
            Logger.info('YouTube設定メニュー統合を初期化しました');
        },

        startMenuCheckInterval() {
            // 1秒ごとに設定メニューをチェック（バックアップ手段）
            this.menuCheckInterval = setInterval(() => {
                const settingsMenu = document.querySelector('.ytp-settings-menu');
                if (settingsMenu && !settingsMenu.querySelector('.yse-settings-menu-item')) {
                    Logger.debug('設定メニューを検出しました（インターバル）');
                    this.onSettingsMenuOpened(settingsMenu);
                }
            }, 1000);
        },

        observeSettingsMenu() {
            // YouTubeの設定メニューを監視
            this.settingsMenuObserver = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === 1) {
                            // 直接ytp-settings-menuが追加された場合
                            if (node.classList?.contains('ytp-settings-menu')) {
                                Logger.debug('設定メニューが追加されました（MutationObserver）');
                                this.onSettingsMenuOpened(node);
                            }
                            // 子要素にytp-settings-menuがある場合
                            const settingsMenu = node.querySelector?.('.ytp-settings-menu');
                            if (settingsMenu) {
                                Logger.debug('設定メニューが子要素として追加されました');
                                this.onSettingsMenuOpened(settingsMenu);
                            }
                        }
                    });
                });
            });

            this.settingsMenuObserver.observe(document.body, {
                childList: true,
                subtree: true
            });
            
            Logger.debug('MutationObserverを設定しました');
        },

        onSettingsMenuOpened(menuElement) {
            // 既に追加済みかチェック
            if (menuElement.querySelector('.yse-settings-menu-item')) {
                return;
            }

            Logger.debug('YouTube設定メニューが開かれました');

            // 設定メニューの内容を取得（複数のセレクタを試行）
            let menuContent = menuElement.querySelector('.ytp-panel-menu');
            
            // フォールバック: 他のセレクタも試す
            if (!menuContent) {
                menuContent = menuElement.querySelector('[class*="panel-menu"]');
            }
            
            if (!menuContent) {
                // 直接menuitemを探す
                const menuItems = menuElement.querySelectorAll('.ytp-menuitem');
                if (menuItems.length > 0) {
                    Logger.debug(`既存のメニュー項目が ${menuItems.length} 個見つかりました`);
                    // 最後のメニュー項目の親をメニューコンテンツとして使用
                    menuContent = menuItems[menuItems.length - 1].parentElement;
                }
            }
            
            if (!menuContent) {
                Logger.warn('メニューコンテンツが見つかりませんでした');
                return;
            }

            Logger.debug('メニューコンテンツを見つけました:', menuContent.className);

            // 字幕設定項目を追加
            this.addSubtitleSettingsMenu(menuContent);
        },

        addSubtitleSettingsMenu(menuContent) {
            // 既に追加済みかチェック
            if (menuContent.querySelector('.yse-settings-menu-item')) {
                Logger.debug('既に字幕設定メニューが追加されています');
                return;
            }

            // 「字幕設定（拡張）」メニュー項目を作成
            const menuItem = document.createElement('div');
            menuItem.className = 'ytp-menuitem yse-settings-menu-item';
            menuItem.setAttribute('role', 'menuitem');
            menuItem.setAttribute('tabindex', '0');
            menuItem.innerHTML = `
                <div class="ytp-menuitem-icon" style="display: flex; align-items: center; justify-content: center;">
                    <svg height="24" width="24" viewBox="0 0 24 24" fill="currentColor" style="opacity: 0.7;">
                        <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z"/>
                    </svg>
                </div>
                <div class="ytp-menuitem-label" style="display: flex; align-items: center;">字幕設定（拡張）</div>
                <div class="ytp-menuitem-content" style="display: flex; align-items: center; justify-content: flex-end;">
                    <span class="yse-settings-status" style="opacity: 0.5; font-size: 11px;">開く</span>
                </div>
            `;

            // クリックイベント
            menuItem.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                Logger.debug('字幕設定メニューがクリックされました');
                this.openSubtitleSettingsPanel();
            });

            // キーボードイベント（Enterキー）
            menuItem.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.openSubtitleSettingsPanel();
                }
            });

            // メニューに追加（「字幕」項目の後を探す）
            const menuItems = Array.from(menuContent.querySelectorAll('.ytp-menuitem'));
            const subtitleItem = menuItems.find(item => {
                const label = item.querySelector('.ytp-menuitem-label');
                return label && (label.textContent.includes('字幕') || label.textContent.includes('Subtitles') || label.textContent.includes('CC'));
            });
            
            if (subtitleItem && subtitleItem.nextSibling) {
                menuContent.insertBefore(menuItem, subtitleItem.nextSibling);
                Logger.debug('字幕設定メニューを「字幕」項目の後に追加しました');
            } else if (menuItems.length > 0) {
                // 最後に追加
                menuContent.appendChild(menuItem);
                Logger.debug('字幕設定メニューを末尾に追加しました');
            } else {
                // コンテンツが空の場合
                menuContent.appendChild(menuItem);
                Logger.debug('字幕設定メニューを新規に追加しました');
            }

            Logger.debug('字幕設定メニューの追加が完了しました');
        },

        openSubtitleSettingsPanel() {
            Logger.debug('字幕設定パネルを開きます');
            
            // 既存の設定パネルを閉じる
            const settingsButton = document.querySelector('.ytp-settings-button');
            if (settingsButton) {
                settingsButton.click();
                Logger.debug('YouTube設定メニューを閉じました');
            }

            // カスタム設定パネルを開く
            setTimeout(() => {
                UIController.openSettings();
            }, 150);
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
            YouTubeSettingsIntegration.init();
            Logger.info('UIコントローラーを初期化しました');
        },

        setupMenuCommands() {
            GM_registerMenuCommand('設定を開く', () => this.openSettings());
            GM_registerMenuCommand('字幕を自動選択', () => {
                PlayerController.autoSelectSubtitle();
            });
            GM_registerMenuCommand('設定をエクスポート', () => {
                const settings = Settings.export();
                navigator.clipboard.writeText(settings);
                alert('設定をクリップボードにコピーしました');
            });
            GM_registerMenuCommand('設定をインポート', () => {
                const json = prompt('設定JSONを貼り付けてください:');
                if (json && Settings.import(json)) {
                    SubtitleEnhancer.updateStyles();
                    alert('設定をインポートしました');
                }
            });
            GM_registerMenuCommand('設定をリセット', () => {
                if (confirm('すべての設定をデフォルトに戻しますか？')) {
                    Settings.reset();
                    SubtitleEnhancer.updateStyles();
                    alert('設定をリセットしました');
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

            // YouTubeプレーヤーの上に表示するためのコンテナを作成
            const player = document.querySelector('#movie_player');
            const container = player || document.body;

            this.panel = document.createElement('div');
            this.panel.className = 'yse-settings-panel';
            this.panel.innerHTML = this.generateSettingsHTML();
            
            // アニメーション効果
            this.panel.style.opacity = '0';
            this.panel.style.transform = 'translate(-50%, -45%)';
            
            container.appendChild(this.panel);
            this.isOpen = true;

            // フェードインアニメーション
            requestAnimationFrame(() => {
                this.panel.style.transition = 'opacity 0.2s, transform 0.2s';
                this.panel.style.opacity = '1';
                this.panel.style.transform = 'translate(-50%, -50%)';
            });

            this.attachEventListeners();
            Logger.debug('設定パネルを開きました');
        },

        closeSettings() {
            if (this.panel) {
                // フェードアウトアニメーション
                this.panel.style.opacity = '0';
                this.panel.style.transform = 'translate(-50%, -45%)';
                
                setTimeout(() => {
                    if (this.panel) {
                        this.panel.remove();
                        this.panel = null;
                        this.isOpen = false;
                    }
                }, 200);
                
                Logger.debug('設定パネルを閉じました');
            }
        },

        generateSettingsHTML() {
            const pos = Settings.get('position');
            return `
                <div class="yse-settings-header">
                    <h2 class="yse-settings-title">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" style="vertical-align: middle; margin-right: 8px;">
                            <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z"/>
                        </svg>
                        字幕設定（拡張）
                    </h2>
                    <button class="yse-settings-close" title="閉じる">&times;</button>
                </div>

                <div style="max-height: 60vh; overflow-y: auto; padding-right: 8px;">
                    <div class="yse-setting-group">
                        <label class="yse-setting-label">優先言語 (ISO 639-1)</label>
                        <input type="text" class="yse-setting-input" data-key="preferredLanguage" 
                               value="${Settings.get('preferredLanguage')}" placeholder="例: ja, en, ko">
                        <small style="color: #888; font-size: 12px;">日本語の場合は「ja」を入力</small>
                    </div>

                    <div class="yse-setting-group">
                        <label class="yse-setting-label">フォールバック言語</label>
                        <input type="text" class="yse-setting-input" data-key="fallbackLanguage" 
                               value="${Settings.get('fallbackLanguage')}" placeholder="例: en">
                        <small style="color: #888; font-size: 12px;">優先言語がない場合に使用</small>
                    </div>

                    <div class="yse-setting-group">
                        <label class="yse-setting-checkbox">
                            <input type="checkbox" data-key="autoTranslateIfNotAvailable" 
                                   ${Settings.get('autoTranslateIfNotAvailable') ? 'checked' : ''}>
                            <span>字幕がない場合は自動翻訳を使用</span>
                        </label>
                    </div>

                    <div style="border-top: 1px solid #444; margin: 16px 0;"></div>

                    <div class="yse-setting-group">
                        <label class="yse-setting-checkbox">
                            <input type="checkbox" data-key="sentenceMode" 
                                   ${Settings.get('sentenceMode') ? 'checked' : ''}>
                            <span>文単位で表示（自動生成字幕を改善）</span>
                        </label>
                        <small style="color: #888; font-size: 12px; display: block; margin-top: 4px; padding-left: 26px;">
                            1文字ずつの表示を文単位にまとめます
                        </small>
                    </div>

                    <div class="yse-setting-group">
                        <label class="yse-setting-label">フォントサイズ: <span id="fontSize-value">${Settings.get('fontSize')}</span>px</label>
                        <input type="range" class="yse-setting-input" data-key="fontSize" 
                               value="${Settings.get('fontSize')}" min="12" max="48" style="width: 100%;">
                    </div>

                    <div class="yse-setting-group">
                        <label class="yse-setting-label">フォントファミリー</label>
                        <input type="text" class="yse-setting-input" data-key="fontFamily" 
                               value="${Settings.get('fontFamily')}">
                    </div>

                    <div class="yse-setting-group">
                        <label class="yse-setting-label">フォントカラー</label>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <input type="color" class="yse-setting-input" data-key="fontColor" 
                                   value="${Settings.get('fontColor')}" style="width: 60px; height: 36px; padding: 2px;">
                            <input type="text" class="yse-setting-input" data-key="fontColor" 
                                   value="${Settings.get('fontColor')}" style="flex: 1;">
                        </div>
                    </div>

                    <div class="yse-setting-group">
                        <label class="yse-setting-label">背景色</label>
                        <input type="text" class="yse-setting-input" data-key="backgroundColor" 
                               value="${Settings.get('backgroundColor')}" placeholder="rgba(0, 0, 0, 0.75)">
                        <small style="color: #888; font-size: 12px;">例: rgba(0, 0, 0, 0.75) または #000000cc</small>
                    </div>

                    <div class="yse-setting-group">
                        <label class="yse-setting-label">字幕位置</label>
                        <select class="yse-setting-input" data-key="position">
                            <option value="bottom" ${pos === 'bottom' ? 'selected' : ''}>下部（デフォルト）</option>
                            <option value="top" ${pos === 'top' ? 'selected' : ''}>上部</option>
                            <option value="custom" ${pos === 'custom' ? 'selected' : ''}>カスタム位置</option>
                        </select>
                    </div>

                    <div class="yse-setting-group" id="customPositionGroup" style="display: ${pos === 'custom' ? 'block' : 'none'};">
                        <label class="yse-setting-label">下端からの距離: <span id="customPositionY-value">${Settings.get('customPositionY')}</span>%</label>
                        <input type="range" class="yse-setting-input" data-key="customPositionY" 
                               value="${Settings.get('customPositionY')}" min="0" max="50" style="width: 100%;">
                    </div>

                    <div class="yse-setting-group">
                        <label class="yse-setting-label">最大行数</label>
                        <input type="number" class="yse-setting-input" data-key="maxLines" 
                               value="${Settings.get('maxLines')}" min="1" max="5">
                    </div>

                    <div class="yse-setting-group">
                        <label class="yse-setting-label">行の高さ</label>
                        <input type="number" class="yse-setting-input" data-key="lineHeight" 
                               value="${Settings.get('lineHeight')}" min="1" max="3" step="0.1">
                    </div>

                    <div class="yse-setting-group">
                        <label class="yse-setting-label">文字間隔 (px)</label>
                        <input type="number" class="yse-setting-input" data-key="letterSpacing" 
                               value="${Settings.get('letterSpacing')}" min="0" max="5" step="0.5">
                    </div>
                </div>

                <div class="yse-settings-buttons">
                    <button class="yse-btn yse-btn-primary" id="yse-save">保存して閉じる</button>
                    <button class="yse-btn yse-btn-secondary" id="yse-cancel">キャンセル</button>
                </div>

                <div class="yse-debug-info">
                    Version: ${CONFIG.VERSION} | Alt+S でショートカット
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
                // レンジスライダーのリアルタイム更新
                if (input.type === 'range') {
                    input.addEventListener('input', (e) => {
                        const key = e.target.dataset.key;
                        const value = parseInt(e.target.value, 10);
                        
                        // 値表示の更新
                        const valueDisplay = this.panel.querySelector(`#${key}-value`);
                        if (valueDisplay) {
                            valueDisplay.textContent = value;
                        }
                        
                        Settings.set(key, value);
                        SubtitleEnhancer.updateStyles();
                    });
                }

                // 変更イベント
                input.addEventListener('change', (e) => {
                    const key = e.target.dataset.key;
                    let value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
                    
                    // 数値型の変換
                    if (e.target.type === 'number') {
                        value = parseFloat(e.target.value);
                    }
                    
                    Settings.set(key, value);
                    SubtitleEnhancer.updateStyles();
                    
                    // 字幕位置が変更された場合、カスタム位置設定の表示/非表示を切り替え
                    if (key === 'position') {
                        const customGroup = this.panel.querySelector('#customPositionGroup');
                        if (customGroup) {
                            customGroup.style.display = value === 'custom' ? 'block' : 'none';
                        }
                    }
                });
            });

            // パネル外クリックで閉じる
            this.panel.addEventListener('click', (e) => {
                if (e.target === this.panel) {
                    this.closeSettings();
                }
            });

            // ESCキーで閉じる
            const escHandler = (e) => {
                if (e.key === 'Escape') {
                    this.closeSettings();
                    document.removeEventListener('keydown', escHandler);
                }
            };
            document.addEventListener('keydown', escHandler);
        },

        saveSettings() {
            // 設定は既にリアルタイムで保存されている
            Logger.info('設定を保存しました');
        }
    };

    // ============================================
    // デバッグインジケーター
    // ============================================
    const DebugIndicator = {
        element: null,

        init() {
            this.createIndicator();
        },

        createIndicator() {
            this.element = document.createElement('div');
            this.element.className = 'yse-debug-indicator';
            this.element.innerHTML = `
                <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="color: #4ade80;">●</span>
                    <span>YSE v${CONFIG.VERSION}</span>
                </div>
                <div style="font-size: 10px; color: #888; margin-top: 2px;">
                    クリックで設定を開く
                </div>
            `;
            
            this.element.addEventListener('click', () => {
                UIController.openSettings();
            });

            // 5秒後に薄くする
            setTimeout(() => {
                if (this.element) {
                    this.element.style.opacity = '0.3';
                }
            }, 5000);

            document.body.appendChild(this.element);
            Logger.debug('デバッグインジケーターを作成しました');
        },

        show() {
            if (this.element) {
                this.element.classList.remove('hidden');
            }
        },

        hide() {
            if (this.element) {
                this.element.classList.add('hidden');
            }
        },

        updateStatus(message, isError = false) {
            if (this.element) {
                const dot = this.element.querySelector('span:first-child');
                if (dot) {
                    dot.style.color = isError ? '#ef4444' : '#4ade80';
                }
            }
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

        // デバッグインジケーターを表示
        DebugIndicator.init();
        
        // 設定の状態をログ出力
        Logger.info('現在の設定:', {
            preferredLanguage: Settings.get('preferredLanguage'),
            sentenceMode: Settings.get('sentenceMode'),
            fontSize: Settings.get('fontSize')
        });
    }

    // スクリプト起動
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
