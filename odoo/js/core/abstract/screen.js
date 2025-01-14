// Copyright  Alexandre Díaz <dev@redneboa.es>
// License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).

odoo.define("terminal.core.abstract.Screen", function (require) {
    "use strict";

    const Class = require("web.Class");
    const core = require("web.core");

    const _t = core._t;

    const AbstractScreen = Class.extend({
        init: function (options) {
            this._options = options;
            this._questions = [];
            this._question_active = undefined;
        },

        start: function ($container) {
            this.$container = $container;
            return Promise.resolve();
        },

        destroy: function () {
            throw Error(_t("Not Implemented!"));
        },

        getContent: function () {
            throw Error(_t("Not Implemented!"));
        },

        getBuffer: function () {
            throw Error(_t("Not Implemented!"));
        },

        scrollDown: function () {
            throw Error(_t("Not Implemented!"));
        },

        clean: function () {
            throw Error(_t("Not Implemented!"));
        },

        cleanInput: function () {
            throw Error(_t("Not Implemented!"));
        },

        cleanShadowInput: function () {
            throw Error(_t("Not Implemented!"));
        },

        // eslint-disable-next-line
        updateInput: function (str) {
            throw Error(_t("Not Implemented!"));
        },

        getInputCaretStartPos: function () {
            throw Error(_t("Not Implemented!"));
        },

        // eslint-disable-next-line
        updateShadowInput: function (str) {
            throw Error(_t("Not Implemented!"));
        },

        // eslint-disable-next-line
        preventLostInputFocus: function (ev) {
            throw Error(_t("Not Implemented!"));
        },

        focus: function () {
            throw Error(_t("Not Implemented!"));
        },

        getUserInput: function () {
            throw Error(_t("Not Implemented!"));
        },

        // eslint-disable-next-line
        isPinned: function () {
            throw Error(_t("Not Implemented!"));
        },

        /* PRINT */
        flush: function () {
            throw Error(_t("Not Implemented!"));
        },

        // eslint-disable-next-line
        printHTML: function (html) {
            throw Error(_t("Not Implemented!"));
        },

        // eslint-disable-next-line
        print: function (msg, enl, cls) {
            throw Error(_t("Not Implemented!"));
        },

        // eslint-disable-next-line
        eprint: function (msg, enl) {
            throw Error(_t("Not Implemented!"));
        },

        // eslint-disable-next-line
        printCommand: function (cmd, secured = false) {
            throw Error(_t("Not Implemented!"));
        },

        // eslint-disable-next-line
        printError: function (error, internal = false) {
            throw Error(_t("Not Implemented!"));
        },

        // eslint-disable-next-line
        printTable: function (columns, tbody) {
            throw Error(_t("Not Implemented!"));
        },

        // eslint-disable-next-line
        showQuestion: function (question, values, def_value) {
            throw Error(_t("Not Implemented!"));
        },

        getQuestionActive: function () {
            return this._question_active;
        },

        // eslint-disable-next-line
        responseQuestion: function (question, response) {
            throw Error(_t("Not Implemented!"));
        },

        // eslint-disable-next-line
        rejectQuestion: function (question) {
            throw Error(_t("Not Implemented!"));
        },
    });

    return AbstractScreen;
});
