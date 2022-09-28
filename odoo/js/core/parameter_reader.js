// Copyright  Alexandre Díaz <dev@redneboa.es>
// License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).

odoo.define("terminal.core.ParameterReader", function (require) {
    "use strict";

    const ParameterGenerator = require("terminal.core.ParameterGenerator");
    const Utils = require("terminal.core.Utils");
    const Class = require("web.Class");

    const TYPES = {
        LEXER: {
            Delimiter: 1,
            BinAdd: 2,
            Name: 3,
            ArgumentShort: 4,
            ArgumentLong: 5,
            Value: 6,
            Assignment: 7,
            DataAttribute: 8,
            Runner: 9,
            Array: 10,
            String: 11,
            Number: 12,
            Dictionary: 14,
            DictionarySimple: 15,
        },
        PARSER: {
            LOAD_NAME: 1,
            LOAD_ARG: 2,
            LOAD_CONST: 3,
            LOAD_RUNNER: 4,
            STORE_NAME: 5,
            CONCAT: 6,
            CALL_FUNCTION: 7,
            RETURN_VALUE: 8,
            LOAD_DATA_ATTR: 9,
        },
    };

    const SYMBOLS = {
        OPER: {
            ADD: "+",
            SUBTRACT: "-",
            MULTIPLY: "*",
            DIVIDE: "/",
            ASSIGNMENT: "=",
        },
        MAIN: {
            ARGUMENT: "-",
        },
        DATA: {
            ARRAY_START: "[",
            ARRAY_END: "]",
            DICTIONARY_START: "{",
            DICTIONARY_END: "}",
            RUNNER_START: "(",
            RUNNER_END: ")",
            STRING: '"',
            STRING_SIMPLE: "'",
            VARIABLE: "$",
        },
    };

    /**
     * This class is used to parse terminal command parameters.
     * Parsing do the following steps:
     *  - Resolve Generators
     *  - Resolve Runners
     *  - Tokenize
     *  - Lexer
     *  - Parser
     */
    const ParameterReader = Class.extend({
        DELIMITERS: [";", "\n"],

        init: function (registeredCmds, storageLocal) {
            this._registeredCmds = registeredCmds;
            this._storageLocal = storageLocal;
            this._validators = {
                s: this._validateString.bind(this),
                i: this._validateInt.bind(this),
                j: this._validateJson.bind(this),
                f: this._validateInt.bind(this),
                a: this._valideAlphanumeric.bind(this),
            };
            this._formatters = {
                s: this._formatString.bind(this),
                i: this._formatInt.bind(this),
                j: this._formatJson.bind(this),
                f: this._formatFlag.bind(this),
                a: this._formatAlphanumeric.bind(this),
            };
            this._regexSanitize = new RegExp(/(?<!\\)'/g);
            this._regexTokens = new RegExp(
                /(?:(\\?[\"'])(?:(?=(\\?))\2.)*?\1|[\+;\n=]|\$(?:\(.+\)|\w+)|\[[^\]]+\]+|\{[^\}]+\}+|[\w\-\.]+)\s*/g
            );
            this._regexSimpleJSON = new RegExp(
                /([^=\s]*)\s?=\s?(\\?["'`])(?:(?=(\\?))\3.)*?\2|([^=\s]*)\s?=\s?([^\s]+)/g
            );
            this._regexComments = new RegExp(/\/\/.*/gm);
            this._parameterGenerator = new ParameterGenerator();
        },

        /**
         * Split and trim values
         * @param {String} text
         * @param {String} separator
         * @returns {Array}
         */
        splitAndTrim: function (text, separator = ",") {
            return _.map(text.split(separator), (item) => item.trim());
        },

        /**
         * Resolve argument information
         *
         * @param {String} arg
         * @returns {Object}
         */
        getArgumentInfo: function (arg) {
            const [
                type,
                names,
                is_required,
                descr,
                default_value,
                strict_values,
            ] = arg.split("::");
            const [short_name, long_name] = names.split(":");
            const list_mode = type[0] === "l";
            let ttype = type.at(-1);
            if (ttype === "-") {
                ttype = "s";
            }
            const s_strict_values = strict_values?.replaceAll(":", ",");
            return {
                type: type,
                names: {
                    short: short_name,
                    long: long_name,
                },
                description: descr,
                default_value:
                    (!_.isEmpty(default_value) &&
                        this._formatters[ttype](default_value, list_mode)) ||
                    undefined,
                strict_values:
                    (!_.isEmpty(s_strict_values) &&
                        this._formatters[ttype](s_strict_values, true)) ||
                    undefined,
                is_required: Boolean(Number(is_required)),
                list_mode: list_mode,
                raw: arg,
            };
        },

        /**
         * @param {Array} args
         * @param {String} arg_name
         * @returns {Object}
         */
        getArgumentInfoByName: function (args, arg_name) {
            for (const arg of args) {
                const arg_info = this.getArgumentInfo(arg);
                if (
                    arg_info.names.short === arg_name ||
                    arg_info.names.long === arg_name
                ) {
                    return arg_info;
                }
            }

            return null;
        },

        /**
         * @param {String} type
         * @returns {String}
         */
        getHumanType: function (type) {
            const singular_types = ["-", "j"];
            const name_types = {
                i: "NUMBER",
                s: "STRING",
                j: "JSON",
                f: "FLAG",
                a: "ALPHANUMERIC",
                "-": "ANY",
            };
            let res = "";
            let carg = type[0];
            const is_list = carg === "l";
            if (is_list) {
                res += "LIST OF ";
                carg = type[1];
            }
            if (Object.hasOwn(name_types, carg)) {
                res += name_types[carg];
            } else {
                res += "UNKNOWN";
            }
            if (is_list && singular_types.indexOf(carg) === -1) {
                res += "S";
            }
            return res;
        },

        parseAliases: function (cmd_name, args) {
            let alias_cmd = this._getAliasCommand(cmd_name);
            if (alias_cmd) {
                const params_len = args.length;
                let index = 0;
                while (index < params_len) {
                    const re = new RegExp(
                        `\\$${Number(index) + 1}(?:\\[[^\\]]+\\])?`,
                        "g"
                    );
                    alias_cmd = alias_cmd.replaceAll(re, args[index][1]);
                    ++index;
                }
                alias_cmd = alias_cmd.replaceAll(
                    /\$\d+(?:\[([^\]]+)\])?/g,
                    (_, group) => {
                        return group || "";
                    }
                );
                return alias_cmd;
            }
            return null;
        },

        getCanonicalCommandName: function (cmd_name, registered_cmds) {
            if (Object.hasOwn(registered_cmds, cmd_name)) {
                return cmd_name;
            }

            const entries = Object.entries(registered_cmds);
            for (const [cname, cmd_def] of entries) {
                if (cmd_def.aliases.indexOf(cmd_name) !== -1) {
                    return cname;
                }
            }

            return null;
        },

        /**
         * Split the input data into usable tokens
         * @param {String} data
         * @returns {Array}
         */
        tokenize: function (data) {
            // Remove comments
            const clean_data = data.replaceAll(this._regexComments, "");
            const match = this._regexTokens[Symbol.matchAll](clean_data);
            return Array.from(match, (item) => item[0]);
        },

        /**
         * Classify tokens
         * @param {Array} tokens
         */
        lex: function (data, options) {
            const tokens_info = [];
            const local_names = [];
            let offset = 0;
            const tokens = this.tokenize(data);
            let prev_token_info = null;
            tokens.forEach((token, index) => {
                let token_san = token.trim();
                let ttype = TYPES.LEXER.String;
                if (token_san[0] === SYMBOLS.MAIN.Argument) {
                    if (token_san[1] === SYMBOLS.MAIN.Argument) {
                        ttype = TYPES.LEXER.ArgumentLong;
                        token_san = token_san.substr(2);
                    } else {
                        ttype = TYPES.LEXER.ArgumentShort;
                        token_san = token_san.substr(1);
                    }
                } else if (this.DELIMITERS.indexOf(token_san) !== -1) {
                    ttype = TYPES.LEXER.Delimiter;
                } else if (token_san === SYMBOLS.OPER.BINARY_ADD) {
                    ttype = TYPES.LEXER.BinAdd;
                } else if (token_san === SYMBOLS.OPER.ASSIGNMENT) {
                    local_names.push(prev_token_info.value);
                    ttype = TYPES.LEXER.Assignment;
                } else if (
                    token_san[0] === SYMBOLS.DATA.ARRAY_START &&
                    token_san.at(-1) === SYMBOLS.DATA.ARRAY_END
                ) {
                    if (prev_token_info && prev_token_info.raw.at(-1) !== " ") {
                        ttype = TYPES.LEXER.DataAttribute;
                        token_san = token_san.substr(1, token_san.length - 2);
                        token_san = token_san.trim();
                    } else {
                        ttype = TYPES.LEXER.Array;
                    }
                } else if (
                    token_san[0] === SYMBOLS.DATA.DICTIONARY_START &&
                    token_san.at(-1) === SYMBOLS.DATA.DICTIONARY_END
                ) {
                    ttype = TYPES.LEXER.Dictionary;
                } else if (
                    token_san[0] === SYMBOLS.DATA.VARIABLE &&
                    token_san[1] === SYMBOLS.DATA.DICTIONARY_START &&
                    token_san.at(-1) === SYMBOLS.DATA.DICTIONARY_END
                ) {
                    ttype = TYPES.LEXER.Runner;
                    token_san = token_san
                        .substr(2, token_san.length - 3)
                        .trim();
                } else if (token_san[0] === SYMBOLS.DATA.VARIABLE) {
                    ttype = TYPES.LEXER.Name;
                    token_san = token_san.substr(1);
                } else if (
                    (token_san[0] === SYMBOLS.DATA.STRING &&
                        token_san.at(-1) === SYMBOLS.DATA.STRING) ||
                    (token_san[0] === SYMBOLS.DATA.STRING_SIMPLE &&
                        token_san.at(-1) === SYMBOLS.DATA.STRING_SIMPLE)
                ) {
                    ttype = TYPES.LEXER.String;
                } else if (!_.isNaN(Number(token_san))) {
                    ttype = TYPES.LEXER.Number;
                } else if (
                    index === 0 ||
                    token_san in options.registeredNames ||
                    this.getCanonicalCommandName(
                        token_san,
                        options.registeredCmds
                    )
                ) {
                    ttype = TYPES.LEXER.Name;
                }

                if (ttype === TYPES.LEXER.String) {
                    token_san = this._trimQuotes(token_san);
                    if (this._regexSimpleJSON.test(token_san)) {
                        ttype = TYPES.LEXER.DictionarySimple;
                    }
                }
                prev_token_info = {
                    value: token_san,
                    raw: token,
                    type: ttype,
                    start: offset,
                    end: offset + token.length,
                    index: index,
                };
                tokens_info.push(prev_token_info);
                offset += token.length;
            });
            return tokens_info;
        },

        /**
         * Create the execution stack
         * @param {String} data
         * @param {Boolean} need_reset_stores
         * @returns {Object}
         */
        parse: function (data, options) {
            if (options.needResetStores) {
                this._parameterGenerator.resetStores();
            }
            const parse_info = {
                inputRawString: data,
                inputTokens: this.lex(data, options),
                stack: {
                    instructions: [],
                    names: [],
                    arguments: [],
                    values: [],
                    attrs: [],
                },
            };

            // Create Stack Entries
            const tokens_len = parse_info.inputTokens.length;
            let in_oper = false;
            let in_command = false;
            let command_token_index = -1;
            for (let index = 0; index < tokens_len; ++index) {
                const token = parse_info.inputTokens[index];
                switch (token.type) {
                    case TYPES.LEXER.Name:
                        {
                            const can_name = this.getCanonicalCommandName(
                                token.value,
                                options.registeredCmds
                            );
                            if (!in_command) {
                                in_command = can_name !== null;
                                if (in_command) {
                                    command_token_index = index;
                                }
                            }
                            if (in_oper) {
                                const offset_instr =
                                    parse_info.stack.instructions.length - 1;
                                parse_info.stack.instructions.splice(
                                    offset_instr,
                                    0,
                                    [TYPES.PARSER.LOAD_NAME, index]
                                );
                            } else {
                                parse_info.stack.names.push(
                                    can_name || token.value
                                );
                                parse_info.stack.instructions.push([
                                    TYPES.PARSER.LOAD_NAME,
                                    index,
                                ]);
                            }
                        }
                        break;
                    case TYPES.LEXER.ArgumentLong:
                    case TYPES.LEXER.ArgumentShort:
                        {
                            parse_info.stack.arguments.push(token.value);
                            parse_info.stack.instructions.push([
                                TYPES.PARSER.LOAD_ARG,
                                index,
                            ]);
                        }
                        break;
                    case TYPES.LEXER.BinAdd:
                        {
                            parse_info.stack.instructions.push([
                                TYPES.PARSER.BINARY_ADD,
                                null,
                                index,
                            ]);
                            in_oper = true;
                        }
                        break;
                    case TYPES.LEXER.Number:
                    case TYPES.LEXER.String:
                        {
                            parse_info.stack.values.push(token.value);
                            if (in_oper) {
                                const offset =
                                    parse_info.stack.instructions.length - 1;
                                parse_info.stack.instructions.splice(
                                    offset,
                                    0,
                                    [TYPES.PARSER.LOAD_CONST, index]
                                );
                            } else {
                                parse_info.stack.instructions.push([
                                    TYPES.PARSER.LOAD_CONST,
                                    index,
                                ]);
                            }
                        }
                        break;
                    case TYPES.LEXER.Delimiter:
                        {
                            if (in_command) {
                                parse_info.stack.instructions.push([
                                    TYPES.PARSER.CALL_FUNCTION,
                                    command_token_index,
                                ]);
                                parse_info.stack.instructions.push([
                                    TYPES.PARSER.RETURN_VALUE,
                                    null,
                                ]);
                            }
                            in_oper = false;
                            in_command = false;
                        }
                        break;
                    case TYPES.LEXER.Assignment:
                        {
                            const last_instr =
                                parse_info.stack.instructions.at(-1);
                            if (last_instr) {
                                last_instr[0] = TYPES.PARSER.STORE_NAME;
                            } else {
                                parse_info.stack.instructions.push([
                                    TYPES.PARSER.STORE_NAME,
                                    index - 1,
                                ]);
                            }
                            in_oper = true;
                        }
                        break;
                    case TYPES.LEXER.DataAttribute:
                        {
                            if (
                                token.value.startsWith("'") ||
                                token.value.startsWith('"') ||
                                !_.isNaN(Number(token.value))
                            ) {
                                parse_info.stack.values.push(
                                    this._trimQuotes(token.value)
                                );
                                parse_info.stack.instructions.push([
                                    TYPES.PARSER.LOAD_CONST,
                                    index,
                                ]);
                            } else {
                                parse_info.stack.names.push(token.value);
                                parse_info.stack.instructions.push([
                                    TYPES.PARSER.LOAD_NAME,
                                    index,
                                ]);
                            }
                            parse_info.stack.instructions.push([
                                TYPES.PARSER.LOAD_DATA_ATTR,
                                index,
                            ]);
                        }
                        break;
                }

                if (
                    in_command &&
                    index === tokens_len - 1 &&
                    token.type !== TYPES.LEXER.Delimiter
                ) {
                    parse_info.stack.instructions.push([
                        TYPES.PARSER.CALL_FUNCTION,
                        command_token_index,
                    ]);
                    parse_info.stack.instructions.push([
                        TYPES.PARSER.RETURN_VALUE,
                        null,
                    ]);
                }
            }

            console.log(parse_info);
            debugger;
            return parse_info;
        },

        isRunner: function (str) {
            return this._regexRunner[Symbol.match](str) !== null;
        },

        getRunnerDef: function (str) {
            const match = this._regexRunner[Symbol.matchAll](str);
            const runners = Array.from(match, (x) => x[1]);
            return runners[0];
        },

        getNameParts: function (name) {
            const base_parts = name.split(".");
            const match = this._regexDataAccess[Symbol.matchAll](base_parts[0]);
            const name_parts = Array.from(match, (x) => [x[1], x[2]])[0];
            return [name_parts[0], name_parts[1], base_parts.slice(1)];
        },

        /**
         * Resolve generators
         * @param {Array} values
         * @returns {Array}
         */
        evalGenerators: function (values) {
            return this._parameterGenerator.eval(values);
        },

        /**
         * Check if the parameter type correspond with the expected type.
         * @param {Array} args
         * @param {Array} params
         * @returns {Boolean}
         */
        validateAndFormatArguments: function (cmd_def, kwargs) {
            if (_.isEmpty(kwargs)) {
                return kwargs;
            }

            // Map full info arguments
            let args_infos = _.chain(cmd_def.args)
                .map((x) => this.getArgumentInfo(x))
                .map((x) => [x.names.long, x])
                .value();
            args_infos = Object.fromEntries(args_infos);

            // Normalize Names
            const in_arg_names = Object.keys(kwargs);
            let full_kwargs = {};
            for (const arg_name of in_arg_names) {
                const arg_info = this.getArgumentInfoByName(
                    cmd_def.args,
                    arg_name
                );
                if (_.isEmpty(arg_info)) {
                    throw new Error(
                        `The argument '${arg_name}' does not exist`
                    );
                }
                full_kwargs[arg_info.names.long] = kwargs[arg_name];
            }

            // Apply default values
            let default_values = _.chain(args_infos)
                .filter((x) => typeof x.default_value !== "undefined")
                .map((x) => [x.names.long, x.raw.split("::")[4]])
                .value();
            default_values = _.isEmpty(default_values)
                ? {}
                : Object.fromEntries(default_values);
            full_kwargs = _.defaults(full_kwargs, default_values);

            // Check required
            const required_args = _.chain(args_infos)
                .filter("is_required")
                .map((x) => x.names.long)
                .value();
            const required_not_set = _.difference(
                required_args,
                Object.keys(full_kwargs)
            );
            if (!_.isEmpty(required_not_set)) {
                throw new Error(
                    `Required arguments not set! (${required_not_set.join(
                        ","
                    )})`
                );
            }

            // Check all
            const arg_names = Object.keys(full_kwargs);
            const new_kwargs = {};
            for (const arg_name of arg_names) {
                const arg_info = args_infos[arg_name];
                const arg_long_name = arg_info.names.long;
                const s_arg_long_name = arg_long_name.replaceAll("-", "_");
                let carg = arg_info.type[0];
                // Determine argument type (modifiers)
                if (carg === "l") {
                    carg = arg_info.type[1];
                }

                if (carg === "-") {
                    const formatted_param = this._tryAllFormatters(
                        full_kwargs[arg_name],
                        arg_info.list_mode
                    );
                    if (!_.isNull(formatted_param)) {
                        new_kwargs[s_arg_long_name] = formatted_param;
                        continue;
                    }

                    // Not found any compatible formatter
                    // fallback to generic string
                    carg = "s";
                } else if (
                    !this._validators[carg](
                        full_kwargs[arg_name],
                        arg_info.list_mode
                    )
                ) {
                    throw new Error(
                        `Invalid parameter for '${arg_long_name}' argument: '${full_kwargs[arg_name]}'`
                    );
                }
                new_kwargs[s_arg_long_name] = this._formatters[carg](
                    full_kwargs[arg_name],
                    arg_info.list_mode
                );
            }

            return new_kwargs;
        },

        _getAliasCommand: function (cmd_name) {
            const aliases =
                this._storageLocal.getItem("terminal_aliases") || {};
            return aliases[cmd_name];
        },

        _tryAllFormatters: function (param, list_mode) {
            // Try all possible validators/formatters
            let formatted_param = null;
            for (const key in this._validators) {
                if (key === "s") {
                    continue;
                }
                if (this._validators[key](param, list_mode)) {
                    formatted_param = this._formatters[key](param, list_mode);
                    break;
                }
            }

            return formatted_param;
        },

        /**
         * Replace all quotes to double-quotes.
         * @param {String} str
         * @returns {String}
         */
        _sanitizeString: function (str) {
            return str.replaceAll(this._regexSanitize, '"');
        },

        /**
         * @param {String} str
         * @returns {String}
         */
        _trimQuotes: function (str) {
            const str_trim = str.trim();
            const first_char = str_trim[0];
            const last_char = str_trim.at(-1);
            if (
                (first_char === '"' && last_char === '"') ||
                (first_char === "'" && last_char === "'") ||
                (first_char === "`" && last_char === "`")
            ) {
                return str_trim.substring(1, str_trim.length - 1).trim();
            }
            return str_trim;
        },

        /**
         * Try to convert input to json.
         * This is used to parse "simple json"
         * Input:
         *      "name=Test street='The Street'"
         * Output:
         *      {'name': 'Test', 'street': 'The Street'}
         *
         * @param {String} str
         * @returns {String}
         */
        _simple2JSON: function (str) {
            let params = {};
            // Check if is a valid simple format string
            try {
                const sa_str = this._sanitizeString(str);
                return JSON.parse(sa_str);
            } catch (err) {
                params = str.match(this._regexSimpleJSON);
                if (str[0] === "[" || str[0] === "{" || _.isEmpty(params)) {
                    throw err;
                }
            }
            const obj = {};
            for (const param of params) {
                let [param_name, ...param_value] = param.trim().split("=");
                param_value = Utils.unescapeQuotes(
                    this._trimQuotes(param_value.join("="))
                );
                const formatted_param = this._tryAllFormatters(param_value);
                obj[param_name] = formatted_param || param_value;
            }
            return obj;
        },

        /**
         * Test if is an string.
         * @param {String} param
         * @param {Boolean} list_mode
         * @returns {Boolean}
         */
        _validateString: function (param, list_mode = false) {
            if (list_mode) {
                const param_split = param.split(",");
                let is_valid = true;
                const param_split_len = param_split.length;
                let index = 0;
                while (index < param_split_len) {
                    const ps = param_split[index];
                    const param_sa = ps.trim();
                    if (Number(param_sa) === parseInt(param_sa, 10)) {
                        is_valid = false;
                        break;
                    }
                    ++index;
                }
                return is_valid;
            }
            return Number(param) !== parseInt(param, 10);
        },

        /**
         * Test if is an integer.
         * @param {String} param
         * @param {Boolean} list_mode
         * @returns {Boolean}
         */
        _validateInt: function (param, list_mode = false) {
            if (list_mode) {
                const param_split = param.split(",");
                let is_valid = true;
                const param_split_len = param_split.length;
                let index = 0;
                while (index < param_split_len) {
                    const ps = param_split[index];
                    const param_sa = ps.trim();
                    if (Number(param_sa) !== parseInt(param_sa, 10)) {
                        is_valid = false;
                        break;
                    }
                    ++index;
                }
                return is_valid;
            }
            return Number(param) === parseInt(param, 10);
        },

        /**
         * Test if is an alphanumeric.
         * @param {String} param
         * @param {Boolean} list_mode
         * @returns {Boolean}
         */
        _valideAlphanumeric: function (param, list_mode = false) {
            return (
                this._validateInt(param, list_mode) ||
                this._validateString(param, list_mode)
            );
        },

        /**
         * Test if is a valid json.
         * @param {String} param
         * @param {Boolean} list_mode
         * @returns {Boolean}
         */
        _validateJson: function (param, list_mode = false) {
            if (list_mode) {
                return false;
            }

            try {
                this._simple2JSON(param.trim());
            } catch (err) {
                return false;
            }
            return true;
        },

        /**
         * Format value to string
         * @param {String} param
         * @param {Boolean} list_mode
         * @returns {String}
         */
        _formatString: function (param, list_mode = false) {
            if (list_mode) {
                return this.splitAndTrim(param);
            }
            return param;
        },

        /**
         * Format value to integer
         * @param {String} param
         * @param {Boolean} list_mode
         * @returns {Number}
         */
        _formatInt: function (param, list_mode = false) {
            if (list_mode) {
                return _.map(this.splitAndTrim(param), (item) => Number(item));
            }
            return Number(param);
        },

        /**
         * Format value to string
         * @param {String} param
         * @param {Boolean} list_mode
         * @returns {Number}
         */
        _formatAlphanumeric: function (param, list_mode = false) {
            return this._formatString(param, list_mode);
        },

        /**
         * Format value to js object
         * @param {String} param
         * @param {Boolean} list_mode
         * @returns {Number}
         */
        _formatJson: function (param, list_mode = false) {
            if (list_mode) {
                return _.map(this.splitAndTrim(param), (item) =>
                    this._simple2JSON(item)
                );
            }
            return this._simple2JSON(param.trim());
        },

        /**
         * Format value to boolean
         * @param {String} param
         * @param {Boolean} list_mode
         * @returns {Number}
         */
        _formatFlag: function (param, list_mode = false) {
            if (list_mode) {
                return _.map(this.splitAndTrim(param), (item) =>
                    Boolean(Number(item))
                );
            }
            return Boolean(Number(param.trim()));
        },
    });

    return {
        ParameterReader: ParameterReader,
        TYPES: TYPES,
    };
});
