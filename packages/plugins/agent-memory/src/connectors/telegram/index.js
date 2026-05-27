"use strict";
/**
 * Telegram Connector
 *
 * Bridges Telegram webhooks to the harness-daemon via @nova/client.
 * Handles message routing, session management, and user prompts.
 */
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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegramConnector = void 0;
exports.createTelegramConnector = createTelegramConnector;
var harness_client_1 = require("@nova/client");
__exportStar(require("./types.js"), exports);
// ============================================================================
// TelegramConnector
// ============================================================================
var TelegramConnector = /** @class */ (function () {
    function TelegramConnector(config) {
        var _this = this;
        var _a, _b, _c, _d, _e, _f;
        this.connected = false;
        /** chatId → session state */
        this.sessions = new Map();
        /** requestId → pending request info */
        this.pendingRequests = new Map();
        /** requestId → accumulated response text */
        this.responseBuffers = new Map();
        // ===========================================================================
        // Long Polling (alternative to webhooks)
        // ===========================================================================
        this.pollingActive = false;
        this.lastUpdateId = 0;
        this.pollingConflictCount = 0;
        this.botToken = config.botToken;
        this.workingDir = config.workingDir;
        this.apiBaseUrl = (_a = config.apiBaseUrl) !== null && _a !== void 0 ? _a : 'https://api.telegram.org';
        this.maxMessageLength = (_b = config.maxMessageLength) !== null && _b !== void 0 ? _b : 4096;
        this.allowedUserIds = ((_c = config.allowedUserIds) === null || _c === void 0 ? void 0 : _c.length)
            ? new Set(config.allowedUserIds)
            : null;
        this.dangerousMode = (_d = config.dangerousMode) !== null && _d !== void 0 ? _d : true;
        this.client = new harness_client_1.HarnessClient({
            host: (_e = config.harnessHost) !== null && _e !== void 0 ? _e : '127.0.0.1',
            port: (_f = config.harnessPort) !== null && _f !== void 0 ? _f : 9555,
        });
        this.client.on('event', function (event, channel) {
            _this.handleEvent(event, channel);
        });
        this.client.on('close', function () {
            console.log('[TelegramConnector] Disconnected from harness');
            _this.connected = false;
        });
        this.client.on('error', function (err) {
            console.error('[TelegramConnector] Client error:', err);
        });
        if (!this.allowedUserIds) {
            console.warn('[TelegramConnector] No allowedUserIds - bot is open to ALL users');
        }
    }
    // ===========================================================================
    // Lifecycle
    // ===========================================================================
    TelegramConnector.prototype.connect = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (this.connected)
                            return [2 /*return*/];
                        return [4 /*yield*/, this.client.connect()];
                    case 1:
                        _a.sent();
                        this.connected = true;
                        console.log('[TelegramConnector] Connected to harness');
                        return [2 /*return*/];
                }
            });
        });
    };
    TelegramConnector.prototype.disconnect = function () {
        this.client.close();
        this.connected = false;
        this.sessions.clear();
        this.pendingRequests.clear();
        this.responseBuffers.clear();
    };
    TelegramConnector.prototype.isConnected = function () {
        return this.connected;
    };
    // ===========================================================================
    // Webhook Handler
    // ===========================================================================
    /**
     * Handle an incoming Telegram webhook update.
     * Returns true if the update was processed, false if ignored.
     */
    TelegramConnector.prototype.handleUpdate = function (update) {
        return __awaiter(this, void 0, void 0, function () {
            var message, userId, text, hasMedia, session, photoFileId, documentFileId;
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
            return __generator(this, function (_l) {
                switch (_l.label) {
                    case 0:
                        message = (_c = (_b = (_a = update.message) !== null && _a !== void 0 ? _a : update.edited_message) !== null && _b !== void 0 ? _b : update.channel_post) !== null && _c !== void 0 ? _c : update.edited_channel_post;
                        if (!message)
                            return [2 /*return*/, false];
                        userId = (_d = message.from) === null || _d === void 0 ? void 0 : _d.id;
                        if (!(this.allowedUserIds && userId && !this.allowedUserIds.has(userId))) return [3 /*break*/, 2];
                        console.log("[TelegramConnector] Rejected unauthorized user: ".concat(userId));
                        return [4 /*yield*/, this.sendMessage(message.chat.id, 'Unauthorized.')];
                    case 1:
                        _l.sent();
                        return [2 /*return*/, false];
                    case 2:
                        text = (_f = (_e = message.text) !== null && _e !== void 0 ? _e : message.caption) !== null && _f !== void 0 ? _f : '';
                        hasMedia = ((_g = message.photo) === null || _g === void 0 ? void 0 : _g.length) || message.document;
                        // Reject if no text and no media
                        if (!text.trim() && !hasMedia) {
                            return [2 /*return*/, false];
                        }
                        // Handle commands (only if there's text)
                        if (text.startsWith('/')) {
                            return [2 /*return*/, this.handleCommand(message, text)];
                        }
                        session = this.sessions.get(message.chat.id);
                        if (session === null || session === void 0 ? void 0 : session.pendingUserPrompt) {
                            return [2 /*return*/, this.handleUserPromptResponse(message, text, session.pendingUserPrompt)];
                        }
                        photoFileId = (_j = (_h = message.photo) === null || _h === void 0 ? void 0 : _h[message.photo.length - 1]) === null || _j === void 0 ? void 0 : _j.file_id;
                        documentFileId = (_k = message.document) === null || _k === void 0 ? void 0 : _k.file_id;
                        return [2 /*return*/, this.processMessage(update, message, text, {
                                photo: photoFileId ? { file_id: photoFileId } : undefined,
                                document: documentFileId ? { file_id: documentFileId } : undefined,
                            })];
                }
            });
        });
    };
    // ===========================================================================
    // Message Processing
    // ===========================================================================
    TelegramConnector.prototype.handleCommand = function (message, command) {
        return __awaiter(this, void 0, void 0, function () {
            var chatId, cmd, _a;
            var _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        chatId = message.chat.id;
                        cmd = command.split(' ')[0].toLowerCase();
                        _a = cmd;
                        switch (_a) {
                            case '/start': return [3 /*break*/, 1];
                            case '/help': return [3 /*break*/, 1];
                            case '/new': return [3 /*break*/, 3];
                        }
                        return [3 /*break*/, 5];
                    case 1: return [4 /*yield*/, this.sendMessage(chatId, "Hello".concat(((_b = message.from) === null || _b === void 0 ? void 0 : _b.first_name) ? " ".concat(message.from.first_name) : '', "!\n\n") +
                            "I'm an AI assistant. Send me a message and I'll help you.\n\n" +
                            "Session: `telegram:".concat(chatId, "`\n\n") +
                            "Commands:\n" +
                            "/new - Start fresh conversation\n" +
                            "/help - Show this message", 'Markdown')];
                    case 2:
                        _c.sent();
                        return [2 /*return*/, true];
                    case 3:
                        this.sessions.delete(chatId);
                        return [4 /*yield*/, this.sendMessage(chatId, "Started new session: `telegram:".concat(chatId, "`\n\nPrevious context cleared."), 'Markdown')];
                    case 4:
                        _c.sent();
                        return [2 /*return*/, true];
                    case 5: 
                    // Unknown command - treat as regular message
                    return [2 /*return*/, this.processMessage({ update_id: 0, message: message }, message, command)];
                }
            });
        });
    };
    TelegramConnector.prototype.processMessage = function (update, message, text, attachments) {
        return __awaiter(this, void 0, void 0, function () {
            var err_1, chatId, sessionKey, requestId, session, attachmentList, file, file, commandType;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!!this.connected) return [3 /*break*/, 5];
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 5]);
                        return [4 /*yield*/, this.connect()];
                    case 2:
                        _a.sent();
                        return [3 /*break*/, 5];
                    case 3:
                        err_1 = _a.sent();
                        console.error('[TelegramConnector] Failed to connect:', err_1);
                        return [4 /*yield*/, this.sendMessage(message.chat.id, 'Service unavailable. Try again later.')];
                    case 4:
                        _a.sent();
                        return [2 /*return*/, false];
                    case 5:
                        chatId = message.chat.id;
                        sessionKey = "telegram:".concat(chatId);
                        requestId = this.generateRequestId(update.update_id, message.message_id);
                        session = this.sessions.get(chatId);
                        if (!!(session === null || session === void 0 ? void 0 : session.initialized)) return [3 /*break*/, 7];
                        return [4 /*yield*/, this.initSession(chatId, sessionKey)];
                    case 6:
                        _a.sent();
                        session = this.sessions.get(chatId);
                        _a.label = 7;
                    case 7:
                        // Clean up any stale requests before adding new ones
                        this.reapStaleRequests();
                        attachmentList = [];
                        if (!(attachments === null || attachments === void 0 ? void 0 : attachments.photo)) return [3 /*break*/, 10];
                        return [4 /*yield*/, this.getFile(attachments.photo.file_id)];
                    case 8:
                        file = _a.sent();
                        if (!(file === null || file === void 0 ? void 0 : file.file_path)) return [3 /*break*/, 10];
                        attachmentList.push({
                            type: 'image',
                            url: this.getFileUrl(file),
                            file_id: file.file_id,
                            mimeType: 'image/jpeg',
                            size: file.file_size,
                        });
                        return [4 /*yield*/, this.sendChatAction(chatId, 'upload_photo')];
                    case 9:
                        _a.sent();
                        _a.label = 10;
                    case 10:
                        if (!(attachments === null || attachments === void 0 ? void 0 : attachments.document)) return [3 /*break*/, 13];
                        return [4 /*yield*/, this.getFile(attachments.document.file_id)];
                    case 11:
                        file = _a.sent();
                        if (!(file === null || file === void 0 ? void 0 : file.file_path)) return [3 /*break*/, 13];
                        attachmentList.push({
                            type: 'document',
                            url: this.getFileUrl(file),
                            file_id: file.file_id,
                        });
                        return [4 /*yield*/, this.sendChatAction(chatId, 'upload_document')];
                    case 12:
                        _a.sent();
                        _a.label = 13;
                    case 13:
                        // Track this request
                        this.pendingRequests.set(requestId, {
                            chatId: chatId,
                            messageId: message.message_id,
                            text: text,
                            startedAt: Date.now(),
                            settled: false,
                            attachments: attachmentList.length > 0 ? attachmentList : undefined,
                        });
                        this.responseBuffers.set(requestId, '');
                        // Subscribe to run events and send message
                        this.client.subscribeRun(requestId);
                        commandType = attachmentList.length > 0 ? 'send_media' : 'send_text';
                        this.client.send({
                            type: commandType,
                            data: {
                                text: text,
                                client_request_id: requestId,
                                attachments: attachmentList.length > 0 ? attachmentList : undefined,
                            },
                        });
                        // Send typing indicator
                        return [4 /*yield*/, this.sendChatAction(chatId, 'typing')];
                    case 14:
                        // Send typing indicator
                        _a.sent();
                        return [2 /*return*/, true];
                }
            });
        });
    };
    TelegramConnector.prototype.handleUserPromptResponse = function (message, text, requestId) {
        return __awaiter(this, void 0, void 0, function () {
            var chatId, session, response, optionIndex;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        chatId = message.chat.id;
                        session = this.sessions.get(chatId);
                        if (!session)
                            return [2 /*return*/, false
                                // Clear pending prompt
                            ];
                        // Clear pending prompt
                        session.pendingUserPrompt = undefined;
                        response = text.trim();
                        optionIndex = parseInt(response, 10);
                        if (!isNaN(optionIndex) && optionIndex > 0) {
                            // Convert 1-indexed to 0-indexed
                            response = String(optionIndex - 1);
                        }
                        // Send response to harness
                        this.client.send({
                            type: 'user_prompt_response',
                            data: {
                                request_id: requestId,
                                response: response,
                            },
                        });
                        return [4 /*yield*/, this.sendChatAction(chatId, 'typing')];
                    case 1:
                        _a.sent();
                        return [2 /*return*/, true];
                }
            });
        });
    };
    TelegramConnector.prototype.initSession = function (chatId, sessionKey) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        this.client.subscribeSession(sessionKey);
                        this.client.send({
                            type: 'init',
                            data: {
                                session_key: sessionKey,
                                working_dir: this.workingDir,
                            },
                        });
                        if (!this.dangerousMode) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.client.request('dangerous_mode.set', { enabled: true })];
                    case 1:
                        _a.sent();
                        _a.label = 2;
                    case 2:
                        this.sessions.set(chatId, { initialized: true });
                        return [2 /*return*/];
                }
            });
        });
    };
    // ===========================================================================
    // Event Handling
    // ===========================================================================
    TelegramConnector.prototype.handleEvent = function (event, channel) {
        // Handle direct channel events (errors, provider_key_required, etc.)
        if (channel === 'direct') {
            this.handleDirectEvent(event);
            return;
        }
        // Extract requestId from channel (run:requestId)
        var requestId = channel.startsWith('run:') ? channel.slice(4) : null;
        if (!requestId)
            return;
        var pending = this.pendingRequests.get(requestId);
        if (!pending)
            return;
        switch (event.type) {
            case 'stream':
                this.handleStreamEvent(requestId, event, pending);
                break;
            case 'response':
                void this.handleResponseEvent(requestId, pending);
                break;
            case 'error':
                void this.handleErrorEvent(requestId, event, pending);
                break;
            case 'user_prompt':
                this.handleUserPromptEvent(requestId, event, pending);
                break;
            case 'status':
                void this.sendChatAction(pending.chatId, 'typing');
                break;
            case 'progress': {
                var progData = event.data;
                void this.sendChatAction(pending.chatId, 'typing');
                // Send progress text for tool/work events, throttled to 1 per 10s
                if ((progData === null || progData === void 0 ? void 0 : progData.message) && (progData.kind === 'tool' || progData.kind === 'work')) {
                    var now = Date.now();
                    if (!pending.lastProgressAt || now - pending.lastProgressAt > 10000) {
                        pending.lastProgressAt = now;
                        void this.sendMessage(pending.chatId, progData.message);
                    }
                }
                break;
            }
        }
    };
    TelegramConnector.prototype.handleDirectEvent = function (event) {
        var data = event.data;
        switch (event.type) {
            case 'error': {
                var message = typeof (data === null || data === void 0 ? void 0 : data.message) === 'string' ? data.message : 'Unknown error';
                console.error('[TelegramConnector] Direct error:', message);
                // Send to all active sessions - we don't know which chat triggered this
                for (var _i = 0, _a = this.sessions; _i < _a.length; _i++) {
                    var chatId = _a[_i][0];
                    void this.sendMessage(chatId, "\u26A0\uFE0F ".concat(message));
                }
                break;
            }
            case 'provider_key_required': {
                var provider = typeof (data === null || data === void 0 ? void 0 : data.provider) === 'string' ? data.provider : 'unknown';
                var model = typeof (data === null || data === void 0 ? void 0 : data.model) === 'string' ? data.model : 'unknown';
                console.warn("[TelegramConnector] Provider key required: ".concat(provider, " for ").concat(model));
                for (var _b = 0, _c = this.sessions; _b < _c.length; _b++) {
                    var chatId = _c[_b][0];
                    void this.sendMessage(chatId, "\u26A0\uFE0F API key required for ".concat(provider, " (").concat(model, ")"));
                }
                break;
            }
            case 'model_changed': {
                var model = typeof (data === null || data === void 0 ? void 0 : data.model) === 'string' ? data.model : null;
                var provider = typeof (data === null || data === void 0 ? void 0 : data.provider) === 'string' ? data.provider : null;
                if (model && provider) {
                    console.log("[TelegramConnector] Model changed: ".concat(provider, "/").concat(model));
                }
                break;
            }
            default:
                // Log but don't crash on unknown direct events
                console.log("[TelegramConnector] Direct event: ".concat(event.type));
        }
    };
    TelegramConnector.prototype.handleStreamEvent = function (requestId, event, pending) {
        var _a;
        var data = event.data;
        if ((data === null || data === void 0 ? void 0 : data.chunk) && !data.is_reasoning) {
            var buffer = (_a = this.responseBuffers.get(requestId)) !== null && _a !== void 0 ? _a : '';
            this.responseBuffers.set(requestId, buffer + data.chunk);
        }
        void this.sendChatAction(pending.chatId, 'typing');
    };
    TelegramConnector.prototype.handleResponseEvent = function (requestId, pending) {
        return __awaiter(this, void 0, void 0, function () {
            var text;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (!!pending.settled) return [3 /*break*/, 4];
                        pending.settled = true;
                        text = (_a = this.responseBuffers.get(requestId)) !== null && _a !== void 0 ? _a : '';
                        if (!text.trim()) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.sendLongMessage(pending.chatId, text, pending.messageId)];
                    case 1:
                        _b.sent();
                        return [3 /*break*/, 4];
                    case 2: return [4 /*yield*/, this.sendMessage(pending.chatId, '(No response)', undefined, pending.messageId)];
                    case 3:
                        _b.sent();
                        _b.label = 4;
                    case 4:
                        // Always clean up
                        this.pendingRequests.delete(requestId);
                        this.responseBuffers.delete(requestId);
                        return [2 /*return*/];
                }
            });
        });
    };
    TelegramConnector.prototype.handleErrorEvent = function (requestId, event, pending) {
        return __awaiter(this, void 0, void 0, function () {
            var buffer, data, errorMsg;
            var _a, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        if (pending.settled)
                            return [2 /*return*/]; // Already handled by another path
                        pending.settled = true;
                        buffer = (_a = this.responseBuffers.get(requestId)) !== null && _a !== void 0 ? _a : '';
                        if (!buffer.trim()) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.sendLongMessage(pending.chatId, buffer, pending.messageId)];
                    case 1:
                        _c.sent();
                        _c.label = 2;
                    case 2:
                        data = event.data;
                        errorMsg = (_b = data === null || data === void 0 ? void 0 : data.message) !== null && _b !== void 0 ? _b : 'Unknown error';
                        return [4 /*yield*/, this.sendMessage(pending.chatId, "Error: ".concat(errorMsg), undefined, pending.messageId)
                            // Don't delete yet — response event may arrive and do final cleanup.
                            // Timeout reaper will catch any leaked state.
                        ];
                    case 3:
                        _c.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    TelegramConnector.prototype.handleUserPromptEvent = function (requestId, event, pending) {
        var _a;
        var data = event.data;
        var question = (_a = data === null || data === void 0 ? void 0 : data.question) !== null && _a !== void 0 ? _a : 'The assistant has a question:';
        var options = data === null || data === void 0 ? void 0 : data.options;
        // Mark session as waiting for user prompt response
        var session = this.sessions.get(pending.chatId);
        if (session) {
            session.pendingUserPrompt = requestId;
        }
        // Format question with options
        var formattedQuestion = "*Question:*\n\n".concat(question);
        if (options === null || options === void 0 ? void 0 : options.length) {
            formattedQuestion += '\n\n*Options:*\n';
            options.forEach(function (opt, i) {
                var label = typeof opt === 'string' ? opt : opt.label;
                formattedQuestion += "".concat(i + 1, ". ").concat(label, "\n");
            });
            formattedQuestion += '\n_Reply with a number or type your answer._';
        }
        void this.sendMessage(pending.chatId, formattedQuestion, 'Markdown');
    };
    // ===========================================================================
    // Telegram API
    // ===========================================================================
    TelegramConnector.prototype.sendMessage = function (chatId, text, parseMode, replyToMessageId) {
        return __awaiter(this, void 0, void 0, function () {
            var result;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this._sendMessageRaw(chatId, text, parseMode, replyToMessageId)];
                    case 1:
                        result = _a.sent();
                        if (!result && parseMode) {
                            // Markdown rejected — retry as plain text
                            return [2 /*return*/, this._sendMessageRaw(chatId, text, undefined, replyToMessageId)];
                        }
                        return [2 /*return*/, result];
                }
            });
        });
    };
    TelegramConnector.prototype._sendMessageRaw = function (chatId, text, parseMode, replyToMessageId) {
        return __awaiter(this, void 0, void 0, function () {
            var body, response, err, err_2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 4, , 5]);
                        body = { chat_id: chatId, text: text };
                        if (parseMode)
                            body.parse_mode = parseMode;
                        if (replyToMessageId)
                            body.reply_to_message_id = replyToMessageId;
                        return [4 /*yield*/, fetch("".concat(this.apiBaseUrl, "/bot").concat(this.botToken, "/sendMessage"), {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(body),
                            })];
                    case 1:
                        response = _a.sent();
                        if (!!response.ok) return [3 /*break*/, 3];
                        return [4 /*yield*/, response.text()];
                    case 2:
                        err = _a.sent();
                        console.error('[TelegramConnector] sendMessage failed:', err);
                        return [2 /*return*/, false];
                    case 3: return [2 /*return*/, true];
                    case 4:
                        err_2 = _a.sent();
                        console.error('[TelegramConnector] sendMessage error:', err_2);
                        return [2 /*return*/, false];
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    TelegramConnector.prototype.sendLongMessage = function (chatId, text, replyToMessageId) {
        return __awaiter(this, void 0, void 0, function () {
            var chunks, i;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        chunks = this.splitMessage(text);
                        i = 0;
                        _a.label = 1;
                    case 1:
                        if (!(i < chunks.length)) return [3 /*break*/, 5];
                        return [4 /*yield*/, this.sendMessage(chatId, chunks[i], undefined, i === 0 ? replyToMessageId : undefined)
                            // Small delay between chunks to avoid rate limits
                        ];
                    case 2:
                        _a.sent();
                        if (!(i < chunks.length - 1)) return [3 /*break*/, 4];
                        return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 100); })];
                    case 3:
                        _a.sent();
                        _a.label = 4;
                    case 4:
                        i++;
                        return [3 /*break*/, 1];
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    // ===========================================================================
    // Telegram API - File Operations
    // ===========================================================================
    /**
     * Get file info from Telegram servers.
     * Returns file_path which can be used to construct a download URL.
     */
    TelegramConnector.prototype.getFile = function (fileId) {
        return __awaiter(this, void 0, void 0, function () {
            var response, err, data, err_3;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 5, , 6]);
                        return [4 /*yield*/, fetch("".concat(this.apiBaseUrl, "/bot").concat(this.botToken, "/getFile"), {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ file_id: fileId }),
                            })];
                    case 1:
                        response = _a.sent();
                        if (!!response.ok) return [3 /*break*/, 3];
                        return [4 /*yield*/, response.text()];
                    case 2:
                        err = _a.sent();
                        console.error('[TelegramConnector] getFile failed:', err);
                        return [2 /*return*/, null];
                    case 3: return [4 /*yield*/, response.json()];
                    case 4:
                        data = _a.sent();
                        return [2 /*return*/, data.result];
                    case 5:
                        err_3 = _a.sent();
                        console.error('[TelegramConnector] getFile error:', err_3);
                        return [2 /*return*/, null];
                    case 6: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Get the download URL for a file from Telegram.
     */
    TelegramConnector.prototype.getFileUrl = function (file) {
        if (!file.file_path)
            return '';
        return "".concat(this.apiBaseUrl, "/file/bot").concat(this.botToken, "/").concat(file.file_path);
    };
    // ===========================================================================
    // Telegram API - Sending
    // ===========================================================================
    TelegramConnector.prototype.sendChatAction = function (chatId, action) {
        return __awaiter(this, void 0, void 0, function () {
            var response, _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _b.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, fetch("".concat(this.apiBaseUrl, "/bot").concat(this.botToken, "/sendChatAction"), {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ chat_id: chatId, action: action }),
                            })];
                    case 1:
                        response = _b.sent();
                        return [2 /*return*/, response.ok];
                    case 2:
                        _a = _b.sent();
                        return [2 /*return*/, false];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    // ===========================================================================
    // Utilities
    // ===========================================================================
    TelegramConnector.prototype.reapStaleRequests = function () {
        var _a;
        var now = Date.now();
        var TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
        for (var _i = 0, _b = this.pendingRequests; _i < _b.length; _i++) {
            var _c = _b[_i], requestId = _c[0], pending = _c[1];
            if (now - pending.startedAt <= TIMEOUT_MS)
                continue;
            if (!pending.settled) {
                // Unsettled + stale: flush buffer, notify user, clean up
                pending.settled = true;
                var buffer = (_a = this.responseBuffers.get(requestId)) !== null && _a !== void 0 ? _a : '';
                if (buffer.trim()) {
                    void this.sendLongMessage(pending.chatId, buffer, pending.messageId);
                }
                void this.sendMessage(pending.chatId, 'Request timed out.', undefined, pending.messageId);
            }
            // Settled or not, stale entries get cleaned up
            this.pendingRequests.delete(requestId);
            this.responseBuffers.delete(requestId);
        }
    };
    TelegramConnector.prototype.generateRequestId = function (updateId, messageId) {
        return "tg_".concat(updateId, "_").concat(messageId, "_").concat(Date.now());
    };
    TelegramConnector.prototype.splitMessage = function (text) {
        if (text.length <= this.maxMessageLength) {
            return [text];
        }
        var chunks = [];
        var remaining = text;
        while (remaining.length > 0) {
            if (remaining.length <= this.maxMessageLength) {
                chunks.push(remaining);
                break;
            }
            // Try to break at newline
            var breakPoint = remaining.lastIndexOf('\n', this.maxMessageLength);
            if (breakPoint < this.maxMessageLength * 0.5) {
                // Try space
                breakPoint = remaining.lastIndexOf(' ', this.maxMessageLength);
            }
            if (breakPoint < this.maxMessageLength * 0.5) {
                // Hard break
                breakPoint = this.maxMessageLength;
            }
            chunks.push(remaining.slice(0, breakPoint));
            remaining = remaining.slice(breakPoint).trimStart();
        }
        return chunks;
    };
    TelegramConnector.prototype.getBotId = function () {
        return this.botToken.split(':')[0];
    };
    /**
     * Start long polling for updates.
     * Use this instead of webhooks when you don't want to expose a public endpoint.
     */
    TelegramConnector.prototype.startPolling = function () {
        return __awaiter(this, arguments, void 0, function (intervalMs) {
            var deleteResponse, deleteResult, err_4, infoResponse, info, err_5, flushResponse, flushData, err_6, _loop_1, this_1;
            var _a;
            if (intervalMs === void 0) { intervalMs = 1000; }
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (this.pollingActive)
                            return [2 /*return*/];
                        this.pollingActive = true;
                        // Delete any existing webhook first (required before using getUpdates)
                        console.log('[TelegramConnector] Deleting webhook before starting polling...');
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 4, , 5]);
                        return [4 /*yield*/, fetch("".concat(this.apiBaseUrl, "/bot").concat(this.botToken, "/deleteWebhook?drop_pending_updates=true"))];
                    case 2:
                        deleteResponse = _b.sent();
                        return [4 /*yield*/, deleteResponse.json()];
                    case 3:
                        deleteResult = _b.sent();
                        if (deleteResult.ok) {
                            console.log('[TelegramConnector] Webhook deleted successfully');
                        }
                        else {
                            console.error('[TelegramConnector] Failed to delete webhook:', deleteResult.description);
                            this.pollingActive = false;
                            throw new Error("Failed to delete webhook: ".concat(deleteResult.description));
                        }
                        return [3 /*break*/, 5];
                    case 4:
                        err_4 = _b.sent();
                        if (err_4 instanceof Error && err_4.message.startsWith('Failed to delete webhook')) {
                            throw err_4;
                        }
                        console.error('[TelegramConnector] Error deleting webhook:', err_4);
                        this.pollingActive = false;
                        throw err_4;
                    case 5: 
                    // Wait a moment for Telegram to process the webhook deletion
                    return [4 /*yield*/, new Promise(function (r) { return setTimeout(r, 1000); })
                        // Verify webhook is deleted by checking getWebhookInfo
                    ];
                    case 6:
                        // Wait a moment for Telegram to process the webhook deletion
                        _b.sent();
                        _b.label = 7;
                    case 7:
                        _b.trys.push([7, 10, , 11]);
                        return [4 /*yield*/, fetch("".concat(this.apiBaseUrl, "/bot").concat(this.botToken, "/getWebhookInfo"))];
                    case 8:
                        infoResponse = _b.sent();
                        return [4 /*yield*/, infoResponse.json()];
                    case 9:
                        info = _b.sent();
                        if (info.ok && info.result.url) {
                            console.error('[TelegramConnector] Webhook still set to:', info.result.url);
                            this.pollingActive = false;
                            throw new Error('Webhook deletion did not take effect');
                        }
                        console.log('[TelegramConnector] Verified: no webhook set');
                        return [3 /*break*/, 11];
                    case 10:
                        err_5 = _b.sent();
                        if (err_5 instanceof Error && err_5.message === 'Webhook deletion did not take effect') {
                            throw err_5;
                        }
                        console.warn('[TelegramConnector] Could not verify webhook status:', err_5);
                        return [3 /*break*/, 11];
                    case 11:
                        console.log('[TelegramConnector] Starting long polling...');
                        _b.label = 12;
                    case 12:
                        _b.trys.push([12, 16, , 17]);
                        return [4 /*yield*/, fetch("".concat(this.apiBaseUrl, "/bot").concat(this.botToken, "/getUpdates?offset=-1&timeout=0"))];
                    case 13:
                        flushResponse = _b.sent();
                        if (!flushResponse.ok) return [3 /*break*/, 15];
                        return [4 /*yield*/, flushResponse.json()];
                    case 14:
                        flushData = _b.sent();
                        if ((_a = flushData.result) === null || _a === void 0 ? void 0 : _a.length) {
                            this.lastUpdateId = Math.max.apply(Math, flushData.result.map(function (u) { return u.update_id; }));
                        }
                        console.log('[TelegramConnector] Flushed stale requests, ready for polling');
                        _b.label = 15;
                    case 15: return [3 /*break*/, 17];
                    case 16:
                        err_6 = _b.sent();
                        console.warn('[TelegramConnector] Flush failed (will retry):', err_6);
                        return [3 /*break*/, 17];
                    case 17:
                        _loop_1 = function () {
                            var response, errorText, backoffMs_1, data, _i, _c, update, err_7;
                            return __generator(this, function (_d) {
                                switch (_d.label) {
                                    case 0:
                                        _d.trys.push([0, 8, , 11]);
                                        return [4 /*yield*/, fetch("".concat(this_1.apiBaseUrl, "/bot").concat(this_1.botToken, "/getUpdates?offset=").concat(this_1.lastUpdateId + 1, "&timeout=30"), { signal: AbortSignal.timeout(35000) })];
                                    case 1:
                                        response = _d.sent();
                                        if (!!response.ok) return [3 /*break*/, 6];
                                        return [4 /*yield*/, response.text()];
                                    case 2:
                                        errorText = _d.sent();
                                        if (!(response.status === 409)) return [3 /*break*/, 4];
                                        this_1.pollingConflictCount += 1;
                                        if (this_1.pollingConflictCount === 1) {
                                            console.warn('[TelegramConnector] getUpdates conflict:', errorText);
                                            console.warn('[TelegramConnector] Ensure only one bot instance is polling and no webhook is set.');
                                        }
                                        backoffMs_1 = Math.min(30000, Math.max(intervalMs, 1000) * this_1.pollingConflictCount);
                                        return [4 /*yield*/, new Promise(function (r) { return setTimeout(r, backoffMs_1); })];
                                    case 3:
                                        _d.sent();
                                        return [2 /*return*/, "continue"];
                                    case 4:
                                        console.error('[TelegramConnector] getUpdates failed:', errorText);
                                        return [4 /*yield*/, new Promise(function (r) { return setTimeout(r, intervalMs); })];
                                    case 5:
                                        _d.sent();
                                        return [2 /*return*/, "continue"];
                                    case 6: return [4 /*yield*/, response.json()];
                                    case 7:
                                        data = _d.sent();
                                        this_1.pollingConflictCount = 0;
                                        for (_i = 0, _c = data.result || []; _i < _c.length; _i++) {
                                            update = _c[_i];
                                            this_1.lastUpdateId = Math.max(this_1.lastUpdateId, update.update_id);
                                            this_1.handleUpdate(update).catch(function (err) {
                                                console.error('[TelegramConnector] Error processing update:', err);
                                            });
                                        }
                                        return [3 /*break*/, 11];
                                    case 8:
                                        err_7 = _d.sent();
                                        if (!this_1.pollingActive) return [3 /*break*/, 10];
                                        console.error('[TelegramConnector] Polling error:', err_7);
                                        return [4 /*yield*/, new Promise(function (r) { return setTimeout(r, intervalMs); })];
                                    case 9:
                                        _d.sent();
                                        _d.label = 10;
                                    case 10: return [3 /*break*/, 11];
                                    case 11: return [2 /*return*/];
                                }
                            });
                        };
                        this_1 = this;
                        _b.label = 18;
                    case 18:
                        if (!this.pollingActive) return [3 /*break*/, 20];
                        return [5 /*yield**/, _loop_1()];
                    case 19:
                        _b.sent();
                        return [3 /*break*/, 18];
                    case 20:
                        console.log('[TelegramConnector] Polling stopped');
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Stop the polling loop.
     */
    TelegramConnector.prototype.stopPolling = function () {
        this.pollingActive = false;
    };
    /**
     * Check if polling is active.
     */
    TelegramConnector.prototype.isPolling = function () {
        return this.pollingActive;
    };
    return TelegramConnector;
}());
exports.TelegramConnector = TelegramConnector;
// ============================================================================
// Factory
// ============================================================================
function createTelegramConnector(config) {
    return new TelegramConnector(config);
}
