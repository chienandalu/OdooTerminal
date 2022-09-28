// Copyright  Alexandre Díaz <dev@redneboa.es>
// License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).

odoo.define("terminal.core.CommandAssistant", function (require) {
    "use strict";

    const Class = require("web.Class");
    const mixins = require("web.mixins");
    const ParameterReaderTypes = require("terminal.core.ParameterReader").TYPES;

    const CommandAssistant = Class.extend(mixins.ParentedMixin, {
        init: function (parent) {
            this.setParent(parent);
            this._parameterReader = parent._parameterReader;
            this._registeredCmds = parent._registeredCmds;
            this.lazyGetAvailableOptions = _.debounce(
                this._getAvailableOptions,
                175
            );
        },

        _getAvailableCommandNames: function (name) {
            const cmd_names = Object.keys(this._registeredCmds);
            return _.filter(cmd_names, (cmd_name) => cmd_name.startsWith(name));
        },

        _getAvailableArguments: function (command_info, arg_name) {
            const s_arg_name =
                arg_name && arg_name.substr(arg_name[1] === "-" ? 2 : 1);
            const arg_infos = [];
            for (const arg of command_info.args) {
                const arg_info = this._parameterReader.getArgumentInfo(arg);
                if (!s_arg_name || arg_info.names.long.startsWith(s_arg_name)) {
                    arg_infos.push(arg_info);
                }
            }
            return arg_infos;
        },

        _getAvailableParameters: function (command_info, arg_name, arg_value) {
            const arg_info = this._parameterReader.getArgumentInfoByName(
                command_info.args,
                arg_name
            );

            const res_param_infos = [];
            if (!_.isEmpty(arg_info)) {
                if (!_.isEmpty(arg_info.strict_values)) {
                    const def_value = arg_info.default_value;
                    for (const strict_value of arg_info.strict_values) {
                        if (
                            !arg_value ||
                            String(strict_value).startsWith(arg_value)
                        ) {
                            res_param_infos.push({
                                value: strict_value,
                                is_required: arg_info.is_required,
                                is_default: strict_value === def_value,
                            });
                        }
                    }
                } else if (
                    arg_info.default_value &&
                    String(arg_info.default_value).startsWith(arg_value)
                ) {
                    res_param_infos.push({
                        value: arg_info.default_value,
                        is_default: true,
                        is_required: arg_info.is_required,
                    });
                }
            }

            return res_param_infos;
        },

        getSelectedParameterIndex: function (parse_info, caret_pos) {
            if (_.isEmpty(parse_info.inputTokens)) {
                return [null, null];
            }
            let sel_token_index = null;
            let sel_cmd_index = null;
            const token_entries = parse_info.inputTokens.entries();
            for (const [index, token] of token_entries) {
                if (caret_pos > token.start && caret_pos <= token.end) {
                    sel_token_index = index;
                    break;
                }
            }
            if (sel_token_index !== -1) {
                let found = false;
                for (const [type, tindex] of parse_info.stack.instructions) {
                    if (tindex === sel_token_index) {
                        found = true;
                    }
                    if (
                        found &&
                        type === ParameterReaderTypes.PARSER.CALL_FUNCTION
                    ) {
                        sel_cmd_index = tindex;
                        break;
                    }
                }
            }
            return [sel_cmd_index, sel_token_index];
        },

        _getAvailableOptions: function (data, caret_pos, callback, options) {
            if (_.isEmpty(data)) {
                callback([]);
                return;
            }
            const parse_info = this._parameterReader.parse(data, options);
            const ret = [];
            const [sel_cmd_index, sel_token_index] =
                this.getSelectedParameterIndex(parse_info, caret_pos);
            const cmd_token = parse_info.inputTokens[sel_cmd_index];
            const cur_token = parse_info.inputTokens[sel_token_index];
            if (!cur_token || !cmd_token) {
                // Command name
                const cmd_names = this._getAvailableCommandNames(
                    cmd_token?.value || data
                );
                for (const cmd_name of cmd_names) {
                    ret.push({
                        name: cmd_name,
                        string: cmd_name,
                        is_command: true,
                    });
                }
                callback(ret);
                return;
            }

            const command_info = this._registeredCmds[cmd_token.value];
            if (!command_info) {
                callback([]);
                return;
            }
            if (
                cur_token.type === ParameterReaderTypes.LEXER.ArgumentShort ||
                cur_token.type === ParameterReaderTypes.LEXER.ArgumentLong
            ) {
                // Argument
                const arg_infos = this._getAvailableArguments(
                    command_info,
                    cur_token.value
                );
                for (const arg_info of arg_infos) {
                    ret.push({
                        name: `-${arg_info.names.short}, --${arg_info.names.long}`,
                        string: `--${arg_info.names.long}`,
                        is_argument: true,
                        is_required: arg_info.is_required,
                    });
                }
            } else if (cur_token.type === ParameterReaderTypes.LEXER.Value) {
                const prev_token = parse_info.inputTokens[sel_token_index - 1];
                if (
                    prev_token &&
                    prev_token.type === ParameterReaderTypes.LEXER.Argument
                ) {
                    // Parameter
                    const param_infos = this._getAvailableParameters(
                        command_info,
                        prev_token.value,
                        cur_token.value
                    );
                    for (const param_info of param_infos) {
                        ret.push({
                            name: param_info.value,
                            string: param_info.value,
                            is_paramater: true,
                            is_default: param_info.is_default,
                            is_required: param_info.is_required,
                        });
                    }
                }
            }

            callback(ret);
        },
    });

    return CommandAssistant;
});
