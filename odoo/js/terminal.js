// Copyright  Alexandre Díaz <dev@redneboa.es>
// License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).

odoo.define("terminal.Terminal", function (require) {
    "use strict";

    const core = require("web.core");
    const session = require("web.session");
    const Widget = require("web.Widget");
    const Screen = require("terminal.core.Screen");
    const Longpolling = require("terminal.core.Longpolling");
    const ParameterReader = require("terminal.core.ParameterReader");
    const TemplateManager = require("terminal.core.TemplateManager");
    const Storage = require("terminal.core.Storage");
    const CommandAssistant = require("terminal.core.CommandAssistant");

    const QWeb = core.qweb;
    const _t = core._t;
    const _lt = core._lt;

    const Terminal = Widget.extend({
        VERSION: "8.6.0",

        MODES: {
            BACKEND_NEW: 1,
            BACKEND_OLD: 2,
            FRONTEND: 3,
        },

        events: {
            "click .o_terminal_cmd": "_onClickTerminalCommand",
            "click .terminal-screen-icon-maximize": "_onClickToggleMaximize",
            "click .terminal-screen-icon-pin": "_onClickToggleScreenPin",
        },

        _registeredCmds: {},
        _registeredNames: {},
        _inputHistory: [],
        _searchCommandIter: 0,
        _searchCommandQuery: "",
        _searchHistoryIter: 0,

        _storage: null,
        _longpolling: null,

        _hasExecInitCmds: false,
        _userContext: {},

        _commandTimeout: 30000,
        _errorCount: 0,

        /**
         * This is necessary to prevent terminal issues in Odoo EE
         */
        _initGuard: function () {
            if (typeof this._observer === "undefined") {
                this._observer = new MutationObserver(
                    this._injectTerminal.bind(this)
                );
                this._observer.observe(document.body, {childList: true});
            }
        },

        _injectTerminal: function () {
            const $terms = $("body").find(".o_terminal");
            if ($terms.length > 1) {
                // Remove extra terminals
                $terms.filter(":not(:first-child)").remove();
            } else if (!$terms.length) {
                $(this._rawTerminalTemplate).prependTo("body");
                this.setElement($("body").find("#terminal"));
            }
        },

        init: function (parent, mode) {
            this._super.apply(this, arguments);
            this._mode = mode;
            this._buffer = {};
            this._storage = new Storage.StorageSession();
            this._storageLocal = new Storage.StorageLocal();
            try {
                this._longpolling = new Longpolling(this);
            } catch (err) {
                // This happens if 'bus' module is not installed
                this._longpolling = false;
            }
            this._templates = new TemplateManager();
            this.screen = new Screen({
                onSaveScreen: function (content) {
                    _.debounce(
                        this._storage.setItem(
                            "terminal_screen",
                            content,
                            (err) => this.screen.printHTML(err)
                        ),
                        350
                    );
                }.bind(this),
                onCleanScreen: () =>
                    this._storage.removeItem("terminal_screen"),
                onInputKeyUp: this._onInputKeyUp.bind(this),
                onInput: this._onInput.bind(this),
            });
            this._jobs = [];
            this._errorCount = 0;

            core.bus.on("keydown", this, this._onCoreKeyDown);
            core.bus.on("click", this, this._onCoreClick);
            window.addEventListener(
                "beforeunload",
                this._onCoreBeforeUnload.bind(this),
                true
            );
            // NOTE: Listen messages from 'content script'
            window.addEventListener(
                "message",
                this._onWindowMessage.bind(this),
                true
            );
            // NOTE-END

            this._wasStart = false;

            // Cached content
            const cachedScreen = this._storage.getItem("terminal_screen");
            if (_.isUndefined(cachedScreen)) {
                this._printWelcomeMessage();
                this.screen.print("");
            } else {
                this.screen.printHTML(cachedScreen);
                // RequestAnimationFrame(() => this.screen.scrollDown());
            }
            const cachedHistory = this._storage.getItem("terminal_history");
            if (!_.isUndefined(cachedHistory)) {
                this._inputHistory = cachedHistory;
                this._searchHistoryIter = this._inputHistory.length;
            }

            this._createTerminal();
        },

        start: function () {
            if (!this._wasLoaded) {
                return Promise.reject();
            }

            return new Promise(async (resolve, reject) => {
                try {
                    this._parameterReader = new ParameterReader.ParameterReader(
                        this._registeredCmds,
                        this._storageLocal
                    );
                    this._commandAssistant = new CommandAssistant(this);
                    await this._super.apply(this, arguments);
                    await this.screen.start(this.$el);
                    this.screen.applyStyle("opacity", this._config.opacity);
                } catch (err) {
                    return reject(err);
                }
                this.$runningCmdCount = this.$("#terminal_running_cmd_count");
                return resolve();
            });
        },

        destroy: function () {
            if (typeof this._observer !== "undefined") {
                this._observer.disconnect();
            }
            window.removeEventListener("message", this._onWindowMessage, true);
            window.removeEventListener(
                "beforeunload",
                this._onCoreBeforeUnload,
                true
            );
            core.bus.off("keydown", this, this._onCoreKeyDown);
            core.bus.off("click", this, this._onCoreClick);
            this.$el[0].removeEventListener("toggle", this.doToggle.bind(this));
            this._super.apply(this, arguments);
        },

        /* BASIC FUNCTIONS */
        cleanInputHistory: function () {
            this._inputHistory = [];
            this._storage.removeItem("terminal_screen");
        },

        registerCommand: function (cmd, cmd_def) {
            this._registeredCmds[cmd] = _.extend(
                {
                    definition: "Undefined command",
                    callback: this._fallbackExecuteCommand,
                    detail: _lt(
                        "This command hasn't a properly detailed information"
                    ),
                    args: null,
                    secured: false,
                    aliases: [],
                    sanitized: true,
                    generators: true,
                    example: "",
                },
                cmd_def
            );
        },

        validateCommand: function (cmd) {
            if (!cmd) {
                return [false, false];
            }
            const cmd_split = cmd.split(" ");
            const cmd_name = cmd_split[0];
            if (!cmd_name) {
                return [cmd, false];
            }
            return [cmd, cmd_name];
        },

        execute: function (cmd_raw, store = true, silent = false) {
            return new Promise(async (resolve, reject) => {
                await this._wakeUp();

                // Check if secured commands involved
                if (!silent) {
                    this.screen.printCommand(cmd_raw);
                }
                this.screen.cleanInput();
                if (store) {
                    this._storeUserInput(cmd_raw);
                }
                const cmd_res = [];
                try {
                    const results = await this.eval(cmd_raw, {silent: silent});
                    for (const result of results) {
                        cmd_res.push(result?.result);
                    }
                } catch (err) {
                    this.screen.print(err);
                    return reject(err);
                }

                if (cmd_res.length === 1) {
                    return resolve(cmd_res[0]);
                }
                return resolve(cmd_res);
            });
        },

        _callFunction: function (frame, parse_info, silent) {
            const cmd_def = this._registeredCmds[frame.cmd];
            const items_len = frame.values.length;
            if (frame.args.length > items_len) {
                return Promise.reject(`Invalid arguments!`);
            }
            let kwargs = {};
            const values = cmd_def.generators
                ? this._parameterReader.evalGenerators(frame.values)
                : frame.values;
            for (let index = items_len - 1; index >= 0; --index) {
                let arg_name = frame.args.pop();
                if (!arg_name) {
                    const arg_def = cmd_def.args[index];
                    if (!arg_def) {
                        return Promise.reject(
                            `Unexpected '${values[index]}' value!`
                        );
                    }
                    arg_name = cmd_def.args[index].split("::")[1].split(":")[1];
                }
                kwargs[arg_name] = values[index];
            }

            kwargs = this._parameterReader.validateAndFormatArguments(
                cmd_def,
                kwargs
            );
            return this._processCommandJob(
                {
                    cmdRaw: parse_info.inputRawString,
                    cmdName: frame.cmd,
                    cmdDef: cmd_def,
                    kwargs: kwargs,
                },
                silent
            );
        },

        _evalRunner: function (data) {
            return new Promise(async (resolve, reject) => {
                if (this._parameterReader.isRunner(data)) {
                    const runner_cmd = this._parameterReader.getRunnerDef(data);
                    try {
                        let runner_ret = await this.eval(runner_cmd, {
                            silent: true,
                        });
                        runner_ret = runner_ret ? runner_ret[0] : null;
                        return resolve(runner_ret);
                    } catch (err) {
                        return reject(err);
                    }
                }
                return resolve(data);
            });
        },

        _getNextStackInstructionIndex: function (stack, type, start = 0) {
            const stack_instr_len = stack.instructions.length;
            for (let index = start; index < stack_instr_len; ++index) {
                const [stype] = stack.instructions[index];
                if (stype === type) {
                    return index;
                }
            }
            return null;
        },

        eval: function (cmd_raw, options) {
            return new Promise(async (resolve, reject) => {
                await this._wakeUp();
                const parse_info = this._parameterReader.parse(cmd_raw, {
                    registeredCmds: this._registeredCmds,
                    registeredNames: this._registeredNames,
                    needResetStores: true,
                });
                const stack = parse_info.stack;
                const stack_instr_len = stack.instructions.length;
                const root_frame = {
                    store: {},
                    values: [],
                };
                const frames = [];
                const return_values = [];
                let last_frame = null;
                for (let index = 0; index < stack_instr_len; ++index) {
                    const [type, tindex] = stack.instructions[index];
                    const token =
                        tindex >= 0 ? parse_info.inputTokens[tindex] : null;
                    switch (type) {
                        case ParameterReader.TYPES.PARSER.LOAD_NAME:
                            {
                                const cmd_name = stack.names.shift();

                                // Check stores
                                const frame = last_frame || root_frame;
                                if (
                                    last_frame &&
                                    Object.hasOwn(last_frame.store, cmd_name)
                                ) {
                                    frame.values.push(
                                        last_frame.store[cmd_name]
                                    );
                                    break;
                                } else if (
                                    Object.hasOwn(root_frame.store, cmd_name)
                                ) {
                                    frame.values.push(
                                        root_frame.store[cmd_name]
                                    );
                                    break;
                                } else if (
                                    Object.hasOwn(
                                        this._registeredNames,
                                        cmd_name
                                    )
                                ) {
                                    frame.values.push(
                                        this._registeredNames[cmd_name]
                                    );
                                    break;
                                } else if (
                                    Object.hasOwn(
                                        this._registeredCmds,
                                        cmd_name
                                    )
                                ) {
                                    last_frame = {
                                        cmd: cmd_name,
                                        store: {},
                                        args: [],
                                        values: [],
                                    };
                                    frames.push(last_frame);
                                } else {
                                    if (!options.silent) {
                                        // Search similar commands
                                        const similar_cmd =
                                            this._searchSimiliarCommand(
                                                cmd_name
                                            );
                                        if (similar_cmd) {
                                            return reject(
                                                this._templates.render(
                                                    "UNKNOWN_COMMAND",
                                                    {
                                                        org_cmd: cmd_name,
                                                        cmd: similar_cmd,
                                                        pos: [
                                                            token.start,
                                                            token.end,
                                                        ],
                                                    }
                                                )
                                            );
                                        }
                                            return reject(
                                                `Unknown name '${cmd_name}' at ${token.start}:${token.end}`
                                            );

                                    }
                                    // Jump to next frame
                                    // const inst_index = this._getNextStackInstructionIndex(this.instructions, ParameterReader.TYPES.PARSER.CALL_FUNCTION, index+1);
                                    // if (inst_index) {
                                    //     index = inst_index + 1;
                                    // }
                                }
                            }
                            break;
                        case ParameterReader.TYPES.PARSER.LOAD_CONST:
                            {
                                const frame = last_frame || root_frame;
                                const value = stack.values.shift();
                                frame.values.push(
                                    await this._evalRunner(value)
                                );
                            }
                            break;
                        case ParameterReader.TYPES.PARSER.LOAD_RUNNER:
                            {
                                const frame = last_frame || root_frame;
                                const value = stack.values.shift();
                                frame.values.push(
                                    await this._evalRunner(value)
                                );
                            }
                            break;
                        case ParameterReader.TYPES.PARSER.LOAD_ARG:
                            {
                                const arg = stack.arguments.shift();
                                if (!last_frame) {
                                    return reject(
                                        `Argument '${arg}' not expected at ${token.start}:${token.end}`
                                    );
                                }
                                const next_instr =
                                    stack.instructions[index + 1];
                                if (
                                    next_instr[0] !==
                                    ParameterReader.TYPES.PARSER.LOAD_CONST
                                ) {
                                    last_frame.values.push(true);
                                }
                                last_frame.args.push(arg);
                            }
                            break;
                        case ParameterReader.TYPES.PARSER.CONCAT:
                            {
                                const allowed_types = [
                                    ParameterReader.TYPES.PARSER.LOAD_CONST,
                                    ParameterReader.TYPES.PARSER.LOAD_NAME,
                                ];
                                const frame = last_frame || root_frame;
                                const prev_instr_a =
                                    stack.instructions[index - 2];
                                const prev_instr_b =
                                    stack.instructions[index - 1];
                                if (
                                    prev_instr_a &&
                                    allowed_types.indexOf(prev_instr_a[0]) ===
                                        -1 &&
                                    prev_instr_b &&
                                    allowed_types.indexOf(prev_instr_b[0]) ===
                                        -1
                                ) {
                                    return reject(
                                        `Token '${token.value}' not expected at ${token.start}:${token.end}`
                                    );
                                }
                                const valB = frame.values.pop();
                                const valA = frame.values.pop();
                                frame.values.push(valA + valB);
                            }
                            break;
                        case ParameterReader.TYPES.PARSER.CALL_FUNCTION:
                            {
                                const frame = frames.pop();
                                try {
                                    const ret = await this._callFunction(
                                        frame,
                                        parse_info,
                                        options.silent
                                    );
                                    last_frame = frames.at(-1);
                                    if (last_frame) {
                                        last_frame.values.push(ret);
                                    } else {
                                        root_frame.values.push(ret);
                                    }
                                } catch (err) {
                                    return reject(err);
                                }
                            }
                            break;
                        case ParameterReader.TYPES.PARSER.RETURN_VALUE:
                            {
                                return_values.push(root_frame.values.pop());
                            }
                            break;
                        case ParameterReader.TYPES.PARSER.STORE_NAME:
                            {
                                const frame = last_frame || root_frame;
                                const vname = stack.names.shift();
                                const vvalue = frame.values.pop();
                                if (!_.isNaN(Number(vname))) {
                                    return reject(
                                        `Invalid name '${vname}' at ${token.start}:${token.end}`
                                    );
                                } else if (typeof vvalue === "undefined") {
                                    const prev_token =
                                        tindex > 0
                                            ? parse_info.inputTokens[tindex - 1]
                                            : null;
                                    const pos = prev_token
                                        ? [prev_token.start, prev_token.end]
                                        : [token.start, token.end];
                                    return reject(
                                        `Invalid token '${token.value}' at ${pos[0]}:${pos[1]}`
                                    );
                                }
                                frame.store[vname] = vvalue;
                            }
                            break;
                        case ParameterReader.TYPES.PARSER.LOAD_DATA_ATTR:
                            {
                                const frame = last_frame || root_frame;
                                const attr_name = frame.values.pop();
                                const index_value = frame.values.length - 1;
                                let value = frame.values[index_value];
                                if (typeof value === "undefined") {
                                    return reject(
                                        `Cannot read properties of undefined (reading '${attr_name}')`
                                    );
                                } else if (
                                    _.isNaN(Number(attr_name)) &&
                                    value instanceof Array
                                ) {
                                    value = _.pluck(value, attr_name).join(",");
                                } else {
                                    value = value[attr_name];
                                }
                                frame.values[index_value] = value;
                            }
                            break;
                    }
                }
                _.extend(this._registeredNames, root_frame.store);
                return resolve(return_values);
            });
        },

        _wakeUp: function () {
            return new Promise((resolve, reject) => {
                if (this._wasLoaded) {
                    if (this._wasStart) {
                        resolve();
                    } else {
                        this._wasStart = true;
                        return this.start()
                            .then(() => {
                                this.screen.flush();
                                resolve();
                            })
                            .catch((err) => reject(err));
                    }
                } else {
                    reject();
                }
            });
        },

        /* VISIBILIY */
        doShow: function () {
            if (!this._wasLoaded) {
                return Promise.resolve();
            }
            // Only start the terminal if needed
            return this._wakeUp().then(() => {
                this.$el.addClass("terminal-transition-topdown");
                this.screen.focus();
            });
        },

        doHide: function () {
            this.$el.removeClass("terminal-transition-topdown");
            return Promise.resolve();
        },

        doToggle: function () {
            if (this._isTerminalVisible()) {
                return this.doHide();
            }

            return this.doShow();
        },

        /* PRIVATE METHODS*/
        _createTerminal: function () {
            QWeb.add_template(
                "<templates>" +
                    "<t t-name='terminal'>" +
                    "<div id='terminal' class='o_terminal'>" +
                    "<div class='terminal-screen-info-zone'>" +
                    "<span class='terminal-screen-running-cmds' id='terminal_running_cmd_count' />" +
                    `<div class='btn btn-sm btn-dark terminal-screen-icon-maximize p-2' role='button' title="${_lt(
                        "Maximize"
                    )}">` +
                    "<i class='fa fa-window-maximize'></i>" +
                    "</div>" +
                    `<div class='btn btn-sm btn-dark terminal-screen-icon-pin p-2' role='button' title="${_lt(
                        "Pin"
                    )}">` +
                    "<i class='fa fa-map-pin'></i>" +
                    "</div>" +
                    "</div>" +
                    "</div>" +
                    "</t>" +
                    "</templates>"
            );
            this._rawTerminalTemplate = QWeb.render("terminal");

            this._injectTerminal();
            this._initGuard();

            // Custom Events
            this.$el[0].addEventListener("toggle", this.doToggle.bind(this));
        },

        _executeAlias: function (command_info, silent = false) {
            let alias_cmd = this.getAliasCommand(command_info.cmdName);
            if (alias_cmd) {
                const params_len = command_info.params.length;
                let index = 0;
                while (index < params_len) {
                    const re = new RegExp(
                        `\\$${Number(index) + 1}(?:\\[[^\\]]+\\])?`,
                        "g"
                    );
                    alias_cmd = alias_cmd.replaceAll(
                        re,
                        command_info.params[index][1]
                    );
                    ++index;
                }
                alias_cmd = alias_cmd.replaceAll(
                    /\$\d+(?:\[([^\]]+)\])?/g,
                    (_, group) => {
                        return group || "";
                    }
                );
                return this.eval(alias_cmd, {silent: silent});
            }
            return Promise.resolve(null);
        },

        _getContext: function (extra_context) {
            return _.extend(
                {},
                session.user_context,
                this._userContext,
                extra_context
            );
        },

        _storeUserInput: function (strInput) {
            this._inputHistory.push(strInput);
            this._storage.setItem(
                "terminal_history",
                this._inputHistory,
                (err) => this.screen.printError(err, true)
            );
            this._searchHistoryIter = this._inputHistory.length;
        },

        _isTerminalVisible: function () {
            return this.$el && parseInt(this.$el.css("top"), 10) >= 0;
        },

        _printWelcomeMessage: function () {
            this.screen.print(
                this._templates.render("WELCOME", {ver: this.VERSION})
            );
        },

        // Key Distance Comparison (Simple mode)
        // Comparison by distance between keys.
        //
        // This mode of analysis limit it to qwerty layouts
        // but can predict words with a better accuracy.
        // Example Case:
        //   - Two commands: horse, house
        //   - User input: hoese
        //
        //   - Output using simple comparison: horse and house (both have the
        //     same weight)
        //   - Output using KDC: horse
        _searchSimiliarCommand: function (in_cmd) {
            if (in_cmd.length < 3) {
                return false;
            }

            // Only consider words with score lower than this limit
            const SCORE_LIMIT = 50;
            // Columns per Key and Rows per Key
            const cpk = 10,
                rpk = 3;
            const max_dist = Math.sqrt(cpk + rpk);
            const _get_key_dist = function (from, to) {
                // FIXME: Inaccurate keymap
                //      '_' and '-' positions are only valid for spanish layout
                const keymap = [
                    "q",
                    "w",
                    "e",
                    "r",
                    "t",
                    "y",
                    "u",
                    "i",
                    "o",
                    "p",
                    "a",
                    "s",
                    "d",
                    "f",
                    "g",
                    "h",
                    "j",
                    "k",
                    "l",
                    null,
                    "z",
                    "x",
                    "c",
                    "v",
                    "b",
                    "n",
                    "m",
                    "_",
                    "-",
                    null,
                ];
                const _get_key_pos2d = function (key) {
                    const i = keymap.indexOf(key);
                    if (i === -1) {
                        return [cpk, rpk];
                    }
                    return [i / cpk, i % rpk];
                };

                const from_pos = _get_key_pos2d(from);
                const to_pos = _get_key_pos2d(to);
                const x = (to_pos[0] - from_pos[0]) * (to_pos[0] - from_pos[0]);
                const y = (to_pos[1] - from_pos[1]) * (to_pos[1] - from_pos[1]);
                return Math.sqrt(x + y);
            };

            const sanitized_in_cmd = in_cmd
                .toLowerCase()
                .replace(/^[^a-z]+|[^a-z]+$/g, "")
                .trim();
            const sorted_cmd_keys = _.keys(this._registeredCmds).sort();
            const min_score = [0, ""];
            const sorted_keys_len = sorted_cmd_keys.length;
            for (let x = 0; x < sorted_keys_len; ++x) {
                const cmd = sorted_cmd_keys[x];
                // Analize typo's
                const search_index = sanitized_in_cmd.search(cmd);
                let cmd_score = 0;
                if (search_index === -1) {
                    // Penalize word length diff
                    cmd_score =
                        Math.abs(sanitized_in_cmd.length - cmd.length) / 2 +
                        max_dist;
                    // Analize letter key distances
                    for (let i = 0; i < sanitized_in_cmd.length; ++i) {
                        if (i < cmd.length) {
                            const score = _get_key_dist(
                                sanitized_in_cmd.charAt(i),
                                cmd.charAt(i)
                            );
                            if (score === 0) {
                                --cmd_score;
                            } else {
                                cmd_score += score;
                            }
                        } else {
                            break;
                        }
                    }
                    // Using all letters?
                    const cmd_vec = _.map(cmd, (k) => k.charCodeAt(0));
                    const in_cmd_vec = _.map(sanitized_in_cmd, (k) =>
                        k.charCodeAt(0)
                    );
                    if (_.difference(in_cmd_vec, cmd_vec).length === 0) {
                        cmd_score -= max_dist;
                    }
                } else {
                    cmd_score =
                        Math.abs(sanitized_in_cmd.length - cmd.length) / 2;
                }

                // Search lower score
                // if zero = perfect match (this never should happens)
                if (min_score[1] === "" || cmd_score < min_score[0]) {
                    min_score[0] = cmd_score;
                    min_score[1] = cmd;
                    if (min_score[0] === 0.0) {
                        break;
                    }
                }
            }

            return min_score[0] < SCORE_LIMIT ? min_score[1] : false;
        },

        _doSearchCommand: function () {
            const match_cmds = _.filter(
                _.keys(this._registeredCmds).sort(),
                (item) => item.indexOf(this._searchCommandQuery) === 0
            );

            if (!match_cmds.length) {
                this._searchCommandIter = 0;
                return false;
            } else if (this._searchCommandIter >= match_cmds.length) {
                this._searchCommandIter = 0;
            }
            return match_cmds[this._searchCommandIter++];
        },

        _doSearchPrevHistory: function () {
            if (this._searchCommandQuery) {
                const orig_iter = this._searchHistoryIter;
                this._searchHistoryIter = _.findLastIndex(
                    this._inputHistory,
                    (item, i) => {
                        return (
                            item.indexOf(this._searchCommandQuery) === 0 &&
                            i <= this._searchHistoryIter - 1
                        );
                    }
                );
                if (this._searchHistoryIter === -1) {
                    this._searchHistoryIter = orig_iter;
                    return false;
                }
                return this._inputHistory[this._searchHistoryIter];
            }
            --this._searchHistoryIter;
            if (this._searchHistoryIter < 0) {
                this._searchHistoryIter = 0;
            } else if (this._searchHistoryIter >= this._inputHistory.length) {
                this._searchHistoryIter = this._inputHistory.length - 1;
            }
            return this._inputHistory[this._searchHistoryIter];
        },

        _doSearchNextHistory: function () {
            if (this._searchCommandQuery) {
                this._searchHistoryIter = _.findIndex(
                    this._inputHistory,
                    (item, i) => {
                        return (
                            item.indexOf(this._searchCommandQuery) === 0 &&
                            i >= this._searchHistoryIter + 1
                        );
                    }
                );
                if (this._searchHistoryIter === -1) {
                    this._searchHistoryIter = this._inputHistory.length;
                    return false;
                }
                return this._inputHistory[this._searchHistoryIter];
            }
            ++this._searchHistoryIter;
            if (this._searchHistoryIter >= this._inputHistory.length) {
                this._searchCommandQuery = undefined;
                return false;
            } else if (this._searchHistoryIter < 0) {
                this._searchHistoryIter = 0;
            }
            return this._inputHistory[this._searchHistoryIter];
        },

        _processCommandJob: function (command_info, silent = false) {
            return new Promise(async (resolve) => {
                const job_index = this.onStartCommand(command_info);
                let result = false;
                let error = false;
                let is_failed = false;
                try {
                    this.__meta = {
                        name: command_info.cmdName,
                        cmdRaw: command_info.cmdRaw,
                        def: command_info.cmdDef,
                        jobIndex: job_index,
                        silent: silent,
                    };

                    let _this = this;
                    if (silent) {
                        _this = _.clone(this);
                        _this.screen = _.clone(this.screen);
                        // Monkey-Patch screen print
                        _this.screen.print = () => {
                            // Do nothing.
                        };
                    }
                    result =
                        (await command_info.cmdDef.callback.call(
                            _this,
                            command_info.kwargs
                        )) || true;
                    delete this.__meta;
                } catch (err) {
                    is_failed = true;
                    error =
                        err ||
                        `[!] ${_t(
                            "Oops! Unknown error! (no detailed error message given :/)"
                        )}`;
                } finally {
                    this.onFinishCommand(job_index, is_failed, error || result);
                }
                return resolve(result);
            });
        },

        _fallbackExecuteCommand: function () {
            return Promise.reject(_t("Invalid command definition!"));
        },

        _updateJobsInfo: function () {
            if (!this._wasStart) {
                return;
            }
            const count = this._jobs.filter(Object).length;
            if (count) {
                const count_unhealthy = this._jobs.filter(
                    (item) => !item.healthy
                ).length;
                let str_info = `${_t("Running")} ${count} ${_t("command(s)")}`;
                if (count_unhealthy) {
                    str_info += ` (${count_unhealthy} ${_t("unhealthy")})`;
                }
                str_info += "...";
                this.$runningCmdCount.html(str_info).show();
            } else {
                this.$runningCmdCount.fadeOut("fast", function () {
                    $(this).html("");
                });
            }
        },

        _applyConfig: function (config) {
            this._config = {
                pinned: this._storage.getItem("terminal_pinned", config.pinned),
                maximized: this._storage.getItem(
                    "screen_maximized",
                    config.maximized
                ),
                opacity: config.opacity * 0.01,
                shortcuts: config.shortcuts,
                term_context: config.term_context || {},
            };

            this._userContext = _.extend(
                {},
                this._config.term_context,
                this._userContext
            );

            if (!this._hasExecInitCmds) {
                if (config.init_cmds) {
                    this.eval(config.init_cmds, {silent: true});
                }
                this._hasExecInitCmds = true;
            }
        },

        /* HANDLE EVENTS */
        onLoaded: function (config) {
            this._applyConfig(config);
            this._wasLoaded = true;
            if (this._config.pinned) {
                this.doShow();
                this.$(".terminal-screen-icon-pin")
                    .removeClass("btn-dark")
                    .addClass("btn-light");
            }
            if (this._config.maximized) {
                this.$el.addClass("term-maximized");
                this.$(".terminal-screen-icon-maximize")
                    .removeClass("btn-dark")
                    .addClass("btn-light");
            }
        },

        onStartCommand: function (command_info) {
            const job_info = {
                cmdInfo: command_info,
                healthy: true,
            };
            // Add new job on a empty space or new one
            let index = _.findIndex(this._jobs, (item) => {
                return typeof item === "undefined";
            });
            if (index === -1) {
                index = this._jobs.push(job_info) - 1;
            } else {
                this._jobs[index] = job_info;
            }
            job_info.timeout = setTimeout(() => {
                this.onTimeoutCommand(index);
            }, this._commandTimeout);
            this._updateJobsInfo();
            return index;
        },
        onFinishCommand: function (job_index, has_errors, result) {
            const job_info = this._jobs[job_index];
            clearTimeout(job_info.timeout);
            if (has_errors) {
                this.screen.printError(
                    `${_t("Error executing")} '${job_info.cmdInfo.cmdName}':`
                );
                if (
                    typeof result === "object" &&
                    !Object.hasOwn(result, "data") &&
                    Object.hasOwn(result, "message")
                ) {
                    this.screen.printError(result.message, true);
                } else {
                    this.screen.printError(result, true);
                }
            }
            delete this._jobs[job_index];
            this._updateJobsInfo();
        },
        onTimeoutCommand: function (job_index) {
            this._jobs[job_index].healthy = false;
            this._updateJobsInfo();
        },

        _onClickTerminalCommand: function (ev) {
            if (Object.hasOwn(ev.target.dataset, "cmd")) {
                this.execute(ev.target.dataset.cmd);
            }
        },

        _onClickToggleMaximize: function (ev) {
            const $target = $(ev.currentTarget);
            this._config.maximized = !this._config.maximized;
            if (this._config.maximized) {
                this.$el.addClass("term-maximized");
                $target.removeClass("btn-dark").addClass("btn-light");
            } else {
                this.$el.removeClass("term-maximized");
                $target.removeClass("btn-light").addClass("btn-dark");
            }
            this._storage.setItem(
                "screen_maximized",
                this._config.maximized,
                (err) => this.screen.printHTML(err)
            );
            this.screen.scrollDown();
            this.screen.preventLostInputFocus();
        },

        _onClickToggleScreenPin: function (ev) {
            const $target = $(ev.currentTarget);
            this._config.pinned = !this._config.pinned;
            this._storage.setItem(
                "terminal_pinned",
                this._config.pinned,
                (err) => this.screen.printHTML(err)
            );
            if (this._config.pinned) {
                $target.removeClass("btn-dark").addClass("btn-light");
            } else {
                $target.removeClass("btn-light").addClass("btn-dark");
            }
            this.screen.preventLostInputFocus();
        },

        _onKeyEnter: function () {
            this.execute(this.screen.getUserInput());
            this._searchCommandQuery = undefined;
            this.screen.preventLostInputFocus();
        },
        _onKeyArrowUp: function () {
            if (_.isUndefined(this._searchCommandQuery)) {
                this._searchCommandQuery = this.screen.getUserInput();
            }
            const found_hist = this._doSearchPrevHistory();
            if (found_hist) {
                this.screen.updateInput(found_hist);
            }
        },
        _onKeyArrowDown: function () {
            if (_.isUndefined(this._searchCommandQuery)) {
                this._searchCommandQuery = this.screen.getUserInput();
            }
            const found_hist = this._doSearchNextHistory();
            if (found_hist) {
                this.screen.updateInput(found_hist);
            } else {
                this._searchCommandQuery = undefined;
                this.screen.cleanInput();
            }
        },
        _onKeyArrowRight: function (ev) {
            const user_input = this.screen.getUserInput();
            this._commandAssistant.lazyGetAvailableOptions(
                user_input,
                this.screen.getInputCaretStartPos(),
                (options) => {
                    this._assistantOptions = options;
                    this._selAssistanOption = -1;
                    this.screen.updateAssistantPanelOptions(
                        this._assistantOptions,
                        this._selAssistanOption
                    );
                    if (
                        user_input &&
                        ev.target.selectionStart === user_input.length
                    ) {
                        this._searchCommandQuery = user_input;
                        this._searchHistoryIter = this._inputHistory.length;
                        this._onKeyArrowUp();
                        this._searchCommandQuery = user_input;
                        this._searchHistoryIter = this._inputHistory.length;
                    }
                },
                {
                    registeredCmds: this._registeredCmds,
                    registeredNames: this._registeredNames,
                    needResetStores: false,
                }
            );
        },
        _onKeyArrowLeft: function () {
            const user_input = this.screen.getUserInput();
            this._commandAssistant.lazyGetAvailableOptions(
                user_input,
                this.screen.getInputCaretStartPos(),
                (options) => {
                    this._assistantOptions = options;
                    this._selAssistanOption = -1;
                    this.screen.updateAssistantPanelOptions(
                        this._assistantOptions,
                        this._selAssistanOption
                    );
                },
                {
                    registeredCmds: this._registeredCmds,
                    registeredNames: this._registeredNames,
                    needResetStores: false,
                }
            );
        },
        _onKeyTab: function () {
            const user_input = this.screen.getUserInput();
            if (_.isEmpty(user_input)) {
                return;
            }
            const parse_info = this._parameterReader.parse(user_input, {
                registeredCmds: this._registeredCmds,
                registeredNames: this._registeredNames,
            });
            const caret_pos = this.screen.getInputCaretStartPos();
            let [sel_cmd_index, sel_param_index] =
                this._commandAssistant.getSelectedParameterIndex(
                    parse_info,
                    caret_pos
                );
            if (sel_cmd_index === null) {
                return;
            }
            const command_info = parse_info.commands[sel_cmd_index];
            ++this._selAssistanOption;
            if (this._selAssistanOption >= this._assistantOptions.length) {
                this._selAssistanOption = 0;
            }
            const option = this._assistantOptions[this._selAssistanOption];
            if (_.isEmpty(option)) {
                return;
            }

            let res_str = "";
            let n_caret_pos = 0;
            const s_params = _.clone(command_info.cmdRaw);
            if (parse_info.inputRawString.charCodeAt(caret_pos - 1) === 32) {
                ++sel_param_index;
                if (sel_param_index >= s_params.length) {
                    s_params.push(`${option.string} `);
                }
            } else {
                s_params[sel_param_index] = `${option.string} `;
            }
            for (const index in s_params) {
                if (index > sel_param_index) {
                    break;
                }
                n_caret_pos += s_params[index].length;
            }
            n_caret_pos -= 1;
            res_str = s_params.join("");
            if (!_.isEmpty(res_str)) {
                this.screen.updateInput(res_str);
            }
            if (n_caret_pos !== -1) {
                this.screen.setInputCaretPos(n_caret_pos);
            }
            this.screen.updateAssistantPanelOptions(
                this._assistantOptions,
                this._selAssistanOption
            );
        },

        _onInput: function () {
            // Fish-like feature
            this.screen.cleanShadowInput();
            const user_input = this.screen.getUserInput();
            this._commandAssistant.lazyGetAvailableOptions(
                user_input,
                this.screen.getInputCaretStartPos(),
                (options) => {
                    this._assistantOptions = options;
                    this._selAssistanOption = -1;
                    this.screen.updateAssistantPanelOptions(
                        this._assistantOptions,
                        this._selAssistanOption
                    );
                    if (user_input) {
                        this._searchCommandQuery = user_input;
                        this._searchHistoryIter = this._inputHistory.length;
                        new Promise((resolve) => {
                            resolve(this._doSearchPrevHistory());
                        }).then((found_hist) => {
                            this.screen.updateShadowInput(found_hist || "");
                        });
                    }
                },
                {
                    registeredCmds: this._registeredCmds,
                    registeredNames: this._registeredNames,
                    needResetStores: false,
                }
            );
        },

        _onInputKeyUp: function (ev) {
            const question_active = this.screen.getQuestionActive();
            if (_.isEmpty(question_active)) {
                if (ev.keyCode === $.ui.keyCode.ENTER) {
                    this._onKeyEnter(ev);
                } else if (ev.keyCode === $.ui.keyCode.UP) {
                    this._onKeyArrowUp(ev);
                } else if (ev.keyCode === $.ui.keyCode.DOWN) {
                    this._onKeyArrowDown(ev);
                } else if (ev.keyCode === $.ui.keyCode.RIGHT) {
                    this._onKeyArrowRight(ev);
                } else if (ev.keyCode === $.ui.keyCode.LEFT) {
                    this._onKeyArrowLeft(ev);
                } else if (ev.keyCode === $.ui.keyCode.TAB) {
                    this._onKeyTab(ev);
                } else {
                    this._searchHistoryIter = this._inputHistory.length;
                    this._searchCommandIter = Object.keys(
                        this._registeredCmds
                    ).length;
                    this._searchCommandQuery = undefined;
                }
            } else if (ev.keyCode === $.ui.keyCode.ENTER) {
                this.screen.responseQuestion(question_active, ev.target.value);
            } else if (ev.keyCode === $.ui.keyCode.ESCAPE) {
                this.screen.rejectQuestion(
                    question_active,
                    "Operation aborted"
                );
                ev.preventDefault();
            }
        },

        _onCoreClick: function (ev) {
            // Auto-Hide
            if (
                this.$el &&
                !this.$el[0].contains(ev.target) &&
                this._isTerminalVisible() &&
                !this._config.maximized &&
                !this._config.pinned
            ) {
                this.doHide();
            }
        },
        _onCoreKeyDown: function (ev) {
            if (
                ev.keyCode === 27 &&
                _.isEmpty(this.screen.getQuestionActive())
            ) {
                // Press Escape
                this.doHide();
            } else {
                const keybind = window.__OdooTerminal.process_keybind(ev);
                const keybind_str = JSON.stringify(keybind);
                const keybind_cmds = this._config.shortcuts[keybind_str];
                if (keybind_cmds) {
                    this.execute(keybind_cmds, false, true);
                    ev.preventDefault();
                }
            }
        },
        _onCoreBeforeUnload: function (ev) {
            const jobs = _.compact(this._jobs);
            if (jobs.length) {
                if (
                    jobs.length === 1 &&
                    (!jobs[0] ||
                        ["reload", "login"].indexOf(jobs[0].cmdInfo.cmdName) !==
                            -1)
                ) {
                    return;
                }
                ev.preventDefault();
                ev.returnValue = "";
                this.screen.print(
                    _t(
                        "The terminal has prevented the current tab from closing due to unfinished tasks:"
                    )
                );
                this.screen.print(
                    _.map(
                        jobs,
                        (item) =>
                            `${item.cmdInfo.cmdName} <small><i>${item.cmdInfo.cmdRaw}</i></small>`
                    )
                );
                this.doShow();
            }
        },

        // NOTE: This method is only used for extension purposes
        _onWindowMessage: function (ev) {
            // We only accept messages from ourselves
            if (ev.source !== window) {
                return;
            }
            if (ev.data.type === "ODOO_TERM_CONFIG") {
                this.onLoaded(ev.data.config);
            }
        },
        // NOTE-END
    });

    return Terminal;
});
